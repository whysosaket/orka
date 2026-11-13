use crate::{
    db::{self, Result},
    governance, indexer, native, packages, projects,
};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
use walkdir::WalkDir;

pub const IMPORT_PATH: &str = "local:skill-import";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSkill {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: PathBuf,
    pub(crate) sources: Vec<String>,
    markdown: String,
    file_count: usize,
    exists: bool,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct Scan {
    pub(crate) skills: Vec<GlobalSkill>,
    errors: Vec<String>,
}

fn roots() -> Result<Vec<(String, PathBuf)>> {
    Ok(vec![
        ("codex".into(), native::codex_home()?.join("skills")),
        ("codex".into(), db::home()?.join(".agents/skills")),
        ("claude".into(), native::claude_home()?.join("skills")),
    ])
}

fn inspect(path: &Path) -> Result<(String, usize)> {
    packages::check_skill_directory(path)?;
    let mut count = 0;
    let mut total = 0;
    for entry in WalkDir::new(path).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file() {
            continue;
        }
        packages::safe_relative(
            entry
                .path()
                .strip_prefix(path)
                .map_err(|e| e.to_string())?
                .to_str()
                .ok_or("Unsupported file name")?,
        )?;
        let size = entry.metadata().map_err(|e| e.to_string())?.len();
        count += 1;
        total += size;
        if count > 200 || size > 1_000_000 || total > 4_000_000 {
            return Err("Skill exceeds size limits".into());
        }
    }
    let mut markdown = String::new();
    fs::File::open(path.join("SKILL.md"))
        .map_err(|e| e.to_string())?
        .take(1_000_001)
        .read_to_string(&mut markdown)
        .map_err(|_| "Cannot read SKILL.md as UTF-8")?;
    if markdown.len() > 1_000_000 {
        return Err("Skill exceeds size limits".into());
    }
    Ok((markdown, count))
}

fn available(db: &Connection, project: &Value, name: &str) -> Result<bool> {
    let id = indexer::scoped_resource_id(db, project, "skill", name)?;
    let resource = db::rows(db, "SELECT value FROM resources WHERE id=?", &[&id])?;
    if resource.first().is_some_and(|r| r["deleted"] != true)
        || !db::get(db, &format!("installation:{id}"))?.is_null()
    {
        return Ok(false);
    }
    if let Some(root) = project["path"].as_str() {
        for folder in [".agents/skills", ".claude/skills"] {
            if fs::symlink_metadata(Path::new(root).join(folder).join(name)).is_ok() {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

pub fn scan(db: &Connection, project: &Value) -> Result<Scan> {
    let mut skills: BTreeMap<PathBuf, GlobalSkill> = BTreeMap::new();
    let mut errors = Vec::new();
    for (source, root) in roots()? {
        match fs::metadata(&root) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                errors.push(format!("Cannot scan {}: {e}", root.display()));
                continue;
            }
            Ok(_) => (),
        }
        let mut entries = WalkDir::new(&root).follow_links(true).into_iter();
        while let Some(entry) = entries.next() {
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    errors.push(format!("Cannot scan {}: {e}", root.display()));
                    continue;
                }
            };
            if !entry.file_type().is_dir() || !entry.path().join("SKILL.md").is_file() {
                continue;
            }
            entries.skip_current_dir();
            let path = match entry.path().canonicalize() {
                Ok(path) => path,
                Err(e) => {
                    errors.push(format!("Cannot read {}: {e}", entry.path().display()));
                    continue;
                }
            };
            if let Some(skill) = skills.get_mut(&path) {
                if !skill.sources.contains(&source) {
                    skill.sources.push(source.clone());
                }
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let mut skill = GlobalSkill {
                id: db::digest(path.to_string_lossy().as_bytes()),
                exists: !available(db, project, &name)?,
                name,
                path,
                sources: vec![source.clone()],
                markdown: String::new(),
                file_count: 0,
                error: None,
            };
            let result = packages::safe_relative(&skill.name).and_then(|_| {
                if skill.name.starts_with('.') || skill.name.len() > 128 {
                    return Err("Invalid skill folder name".into());
                }
                inspect(&skill.path)
            });
            match result {
                Ok((markdown, count)) => {
                    skill.markdown = markdown;
                    skill.file_count = count;
                }
                Err(error) => skill.error = Some(error),
            }
            skills.insert(skill.path.clone(), skill);
        }
    }
    Ok(Scan {
        skills: skills.into_values().collect(),
        errors,
    })
}

#[cfg(any(test, debug_assertions))]
pub fn add(db: &Connection, project: &Value, skill_id: &str) -> Result<Value> {
    let user = db::get(db, "user")?;
    user.as_str().ok_or("Sign in required")?;
    let root = Path::new(
        project["path"]
            .as_str()
            .ok_or("Connect a project folder first")?,
    );
    if !root.is_dir() {
        return Err("Connected folder unavailable. Reconnect it in Settings.".into());
    }
    if let Some(identity) = project["folderIdentity"].as_str() {
        if !indexer::folder_identity_matches(root, identity)? {
            return Err("Connected folder changed. Reconnect it in Settings.".into());
        }
    }
    let skill = scan(db, project)?
        .skills
        .into_iter()
        .find(|skill| skill.id == skill_id)
        .ok_or("Global skill unavailable. Scan again.")?;
    if let Some(error) = &skill.error {
        return Err(error.clone());
    }
    install(db, project, &skill)
}

fn install(db: &Connection, project: &Value, skill: &GlobalSkill) -> Result<Value> {
    let root = Path::new(
        project["path"]
            .as_str()
            .ok_or("Connect a project folder first")?,
    );
    crate::sources::validate(project)?;
    if let Some(error) = &skill.error {
        return Err(error.clone());
    }
    if skill.exists || !available(db, project, &skill.name)? {
        return Err("A skill with this folder name is already in the project. Existing files were preserved.".into());
    }
    let files = packages::directory(&skill.path)?;
    let id = indexer::scoped_resource_id(db, project, "skill", &skill.name)?;
    let paths = [
        root.join(".agents/skills").join(&skill.name),
        root.join(".claude/skills").join(&skill.name),
    ];
    packages::install_mirrors(db, project, &id, &paths, &files)?;
    db::set(db, &format!("global-skill-origin:{id}"), &json!(true))?;
    let sharing = projects::sharing_allowed(project, "skill");
    let status = if governance::governed(project) || !sharing {
        let resource = json!({"resourceId":id,"kind":"skill","source":"shared","logicalPath":skill.name,"title":skill.name,"files":files,"deleted":false});
        let draft = governance::capture(db, project, &resource, &json!(paths))?;
        if sharing {
            queue_share(db, project, &draft)?;
            "queued"
        } else {
            "local"
        }
    } else {
        indexer::scan(db, project)?;
        db::set(db, "syncRequest", &json!(uuid::Uuid::new_v4().to_string()))?;
        "queued"
    };
    Ok(json!({"resourceId":id,"status":status}))
}

#[cfg(test)]
pub use crate::context_sharing::complete as complete_share;
pub use crate::context_sharing::queue as queue_share;

/// The importing Mac already chose these exact bytes. Never overwrite edits or
/// skip installation review for a different package or another person's import.
pub fn adopt_import(
    db: &Connection,
    project: &Value,
    resource: &Value,
    binding: Value,
) -> Result<Value> {
    let scoped;
    let project = if project["sources"].is_array() && !project["sourceId"].is_string() {
        let Some(source) = crate::sources::for_resource(project, resource) else {
            return Ok(binding);
        };
        scoped = source;
        &scoped
    } else {
        project
    };
    if !crate::sources::matches(project, resource) {
        return Ok(binding);
    }
    if resource["updatedBy"] != db::get(db, "user")? {
        return Ok(binding);
    }
    let eligible: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM drafts WHERE project=? AND json_extract(value,'$.resource.resourceId')=? AND json_extract(value,'$.automaticSharing')=1 AND json_extract(value,'$.status') IN ('published','approved') AND json_extract(value,'$.submission.resource.files')=?)", rusqlite::params![project["id"].as_str(), resource["resourceId"].as_str(), resource["files"].to_string()], |row| row.get(0)).map_err(|error| error.to_string())?;
    if !eligible {
        return Ok(binding);
    }
    let Some(root) = project["path"].as_str().map(Path::new) else {
        return Ok(binding);
    };
    if project["folderIdentity"]
        .as_str()
        .is_some_and(|identity| !indexer::folder_identity_matches(root, identity).unwrap_or(false))
    {
        return Ok(binding);
    }
    let Ok(canonical_root) = root.canonicalize() else {
        return Ok(binding);
    };
    let logical = packages::safe_relative(
        resource["logicalPath"]
            .as_str()
            .ok_or("Missing skill path")?,
    )?;
    let paths: Vec<_> = [".agents/skills", ".claude/skills"]
        .into_iter()
        .map(|folder| root.join(folder).join(&logical))
        .collect();
    if paths.iter().any(|path| {
        path.canonicalize().ok().as_ref()
            != path
                .strip_prefix(root)
                .ok()
                .map(|relative| canonical_root.join(relative))
                .as_ref()
    }) {
        return Ok(binding);
    }
    let mut candidate = binding.clone();
    candidate["paths"] = json!(paths);
    let guards = crate::sync::live_hash(&candidate, "skill", root).unwrap_or_default();
    let hash = indexer::manifest_hash(&resource["files"]);
    if guards.len() != 2 || guards.iter().any(|guard| guard != &hash) {
        return Ok(binding);
    }
    candidate["base"] = resource.clone();
    candidate["reviewedRevision"] = resource["revision"].clone();
    candidate["installationState"] = json!("current");
    candidate["lastSeenHash"] = json!(hash);
    candidate["writeGuard"] = candidate["lastSeenHash"].clone();
    candidate["guards"] = json!(guards);
    candidate["managed"] = json!(true);
    Ok(candidate)
}

/// A local reading catalog, separate from the resources authorized for sharing.
pub fn local_skills(db: &Connection, project: &Value) -> Result<Vec<Value>> {
    let Some(root) = project["path"].as_str().map(Path::new) else {
        return Ok(vec![]);
    };
    if !root.is_dir()
        || project["folderIdentity"].as_str().is_some_and(|identity| {
            !indexer::folder_identity_matches(root, identity).unwrap_or(false)
        })
    {
        return Ok(vec![]);
    }
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let owner = db::get(db, "user")?;
    let mut seen = HashSet::new();
    let mut skills = Vec::new();
    for draft in db::rows(db,
        "SELECT value FROM drafts WHERE project=? AND json_extract(value,'$.resource.kind')='skill' AND NOT EXISTS (SELECT 1 FROM resources WHERE id=json_extract(drafts.value,'$.resource.resourceId') AND (json_extract(resources.value,'$.deleted') IS NOT 1 OR coalesce(json_extract(resources.value,'$.updatedAt'),'9999') >= json_extract(drafts.value,'$.createdAt'))) ORDER BY rowid DESC",
        &[&project_id])? {
        let mut resource = draft["resource"].clone();
        if !crate::sources::matches(project, &resource) { continue; }
        let Some(id) = resource["resourceId"].as_str() else { continue };
        if !seen.insert(id.to_string()) || resource["deleted"] == true
            || !matches!(draft["status"].as_str(), Some("local" | "proposed")) {
            continue;
        }
        let Some(logical) = resource["logicalPath"].as_str() else { continue };
        let Ok(relative) = packages::safe_relative(logical) else { continue };
        let paths: Vec<_> = [".agents/skills", ".claude/skills"].into_iter()
            .map(|folder| root.join(folder).join(&relative))
            .filter(|path| {
                draft["paths"].as_array().is_some_and(|paths| paths.contains(&json!(path)))
                    && path.canonicalize().ok().as_ref() == path.strip_prefix(root).ok().map(|relative| canonical_root.join(relative)).as_ref()
                    && fs::symlink_metadata(path.join("SKILL.md")).is_ok_and(|meta| meta.is_file())
            }).collect();
        if paths.is_empty() { continue; }
        resource["projectId"] = json!(project_id);
        resource["revision"] = json!(0);
        resource["owner"] = owner.clone();
        resource["updatedBy"] = owner.clone();
        resource["updatedAt"] = draft["createdAt"].clone();
        resource["local"] = json!(true);
        resource["paths"] = json!(paths);
        resource["global"] = json!(global_origin(db, &resource)?);
        let pending = db::rows(db, "SELECT json_object('error',error) FROM outbox WHERE path=? AND json_extract(value,'$.skillImport')=?", &[&IMPORT_PATH, &draft["id"].as_str()])?;
        if let Some(pending) = pending.first() {
            resource["sharing"] = json!(if !projects::sharing_allowed(project, "skill") { "paused" } else if pending["error"].as_str().is_some_and(crate::sync::terminal_error) { "blocked" } else { "queued" });
        } else if draft["status"] == "proposed" && draft["request"]["status"] == "pending" {
            resource["sharing"] = json!("approval");
        }
        skills.push(resource);
    }
    Ok(skills)
}

/// Recover origin for imports from earlier builds once, without reading chat history.
pub fn global_origin(db: &Connection, resource: &Value) -> Result<bool> {
    let id = resource["resourceId"].as_str().ok_or("Missing resource")?;
    let key = format!("global-skill-origin:{id}");
    if let Some(origin) = db::get(db, &key)?.as_bool() {
        return Ok(origin);
    }
    let Some(logical) = resource["logicalPath"].as_str() else {
        return Ok(false);
    };
    let relative = packages::safe_relative(logical)?;
    let files = resource["files"].as_array().ok_or("Missing files")?;
    let origin = !files.is_empty()
        && roots()?.iter().any(|(_, root)| {
            let path = root.join(&relative);
            inspect(&path).is_ok_and(|(_, count)| count == files.len())
                && files.iter().all(|file| {
                    file["path"]
                        .as_str()
                        .and_then(|name| packages::safe_relative(name).ok())
                        .and_then(|name| fs::read(path.join(name)).ok())
                        .is_some_and(|bytes| file["hash"] == db::digest(&bytes))
                })
        });
    db::set(db, &key, &json!(origin))?;
    Ok(origin)
}

pub fn local_skill(db: &Connection, id: &str) -> Result<Option<Value>> {
    let draft = db::rows(db,
        "SELECT value FROM drafts WHERE json_extract(value,'$.resource.resourceId')=? ORDER BY rowid DESC LIMIT 1",
        &[&id])?.into_iter().next();
    let Some(project_id) = draft.as_ref().and_then(|draft| draft["projectId"].as_str()) else {
        return Ok(None);
    };
    let project = governance::project(db, project_id)?;
    for source in crate::sources::views(&project) {
        if let Some(skill) = local_skills(db, &source)?
            .into_iter()
            .find(|skill| skill["resourceId"] == id)
        {
            return Ok(Some(skill));
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn scan_global_skills(project_id: String, source_id: Option<String>) -> Result<Scan> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = db::open()?;
        let project = governance::project(&db, &project_id)?;
        let project = crate::sources::select(&project, source_id.as_deref())?;
        scan(&db, &project)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn add_global_skill(
    project_id: String,
    skill_id: String,
    source_id: Option<String>,
) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        add_source_when_ready(
            &project_id,
            &skill_id,
            source_id.as_deref(),
            Duration::from_secs(300),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn add_global_skills(
    project_id: String,
    skill_ids: Vec<String>,
    source_id: Option<String>,
) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        add_many_when_ready(
            &project_id,
            &skill_ids,
            source_id.as_deref(),
            Duration::from_secs(300),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
pub fn add_when_ready(project_id: &str, skill_id: &str, timeout: Duration) -> Result<Value> {
    add_source_when_ready(project_id, skill_id, None, timeout)
}

fn add_source_when_ready(
    project_id: &str,
    skill_id: &str,
    source_id: Option<&str>,
    timeout: Duration,
) -> Result<Value> {
    let result = add_many_when_ready(project_id, &[skill_id.to_string()], source_id, timeout)?;
    let item = &result["results"][0];
    if let Some(error) = item["error"].as_str() {
        return Err(error.into());
    }
    Ok(item["result"].clone())
}

pub(crate) fn add_many_when_ready(
    project_id: &str,
    skill_ids: &[String],
    source_id: Option<&str>,
    timeout: Duration,
) -> Result<Value> {
    if skill_ids.is_empty() {
        return Err("Choose at least one skill".into());
    }
    let db = db::open()?;
    let account = db.path().map(str::to_owned);
    let owner = db::get(&db, "user")?;
    owner.as_str().ok_or("Sign in required")?;
    let origin = db::get(&db, "config")?["apiUrl"].clone();
    let project = governance::project(&db, project_id)?;
    let project = crate::sources::select(&project, source_id)?;
    drop(db);

    let _lock = projects::wait_for_lock(timeout)?;
    let db = db::open()?;
    if db.path() != account.as_deref()
        || db::get(&db, "user")? != owner
        || db::get(&db, "config")?["apiUrl"] != origin
    {
        return Err(
            "Your account or service changed. Reopen the skill picker and try again.".into(),
        );
    }
    let current = governance::project(&db, project_id)?;
    let current = crate::sources::select(&current, source_id)?;
    if current["path"] != project["path"] || current["folderIdentity"] != project["folderIdentity"]
    {
        return Err("The project folder changed. Reopen the skill picker and try again.".into());
    }
    let skills = scan(&db, &current)?.skills;
    let mut seen = HashSet::new();
    let results: Vec<_> = skill_ids
        .iter()
        .filter(|id| seen.insert(id.as_str()))
        .map(|id| {
            let result = skills
                .iter()
                .find(|skill| &skill.id == id)
                .ok_or_else(|| "Global skill unavailable. Scan again.".to_string())
                .and_then(|skill| install(&db, &current, skill));
            match result {
                Ok(result) => json!({"skillId":id,"result":result}),
                Err(error) => json!({"skillId":id,"error":error}),
            }
        })
        .collect();
    crate::codex_skills::retry(&db)?;
    Ok(json!({"results":results}))
}
