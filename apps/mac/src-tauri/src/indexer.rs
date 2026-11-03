use crate::{
    db::{self, Result},
    memory_context, native, packages, plans,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;
use walkdir::WalkDir;
pub const SKILL_MIRROR_REVIEW: &str = "Skill copies differ between .agents/skills and .claude/skills. Review and align them to resume this skill's sync; both local copies are preserved.";
pub fn folder_identity(path: &Path) -> Result<String> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    if let Some(volume) = volume_identity(path) {
        return Ok(format!("volume:{volume}:{}", meta.ino()));
    }
    Ok(format!("{}:{}", meta.dev(), meta.ino()))
}

#[cfg(target_os = "macos")]
fn volume_identity(path: &Path) -> Option<String> {
    use objc2_foundation::{NSString, NSURLVolumeUUIDStringKey, NSURL};
    objc2::rc::autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
        let mut value = None;
        // This resource key returns an NSString when the volume has a persistent UUID.
        unsafe { url.getResourceValue_forKey_error(&mut value, NSURLVolumeUUIDStringKey) }.ok()?;
        let volume = value?.downcast::<NSString>().ok()?.to_string();
        (!volume.is_empty()).then_some(volume)
    })
}

pub fn folder_identity_matches(path: &Path, expected: &str) -> Result<bool> {
    if expected.starts_with("volume:") {
        return Ok(folder_identity(path)? == expected);
    }
    use std::os::unix::fs::MetadataExt;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    Ok(format!("{}:{}", meta.dev(), meta.ino()) == expected)
}
pub fn claude_memory(root: &Path) -> Result<PathBuf> {
    let encoded = root
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    let mut memory = native::claude_home()?
        .join("projects")
        .join(encoded)
        .join("memory");
    for path in [
        root.join(".claude/settings.json"),
        root.join(".claude/settings.local.json"),
    ] {
        if path.try_exists().map_err(|e| e.to_string())? {
            let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            if let Some(custom) = value["autoMemoryDirectory"].as_str() {
                let p = custom
                    .strip_prefix("~/")
                    .map(|rest| db::home().map(|home| home.join(rest)))
                    .transpose()?
                    .unwrap_or(PathBuf::from(custom));
                if !p.is_absolute() {
                    return Err("Claude auto-memory directory must be absolute".into());
                }
                memory = p;
            }
        }
    }
    Ok(memory)
}
pub fn resource_id(project: &str, kind: &str, path: &str) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("orka:{project}:{kind}:{path}").as_bytes(),
    )
    .to_string()
}

pub fn scoped_resource_id(
    db: &rusqlite::Connection,
    project: &Value,
    kind: &str,
    path: &str,
) -> Result<String> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    if let Some(resource) = db::rows(db,"SELECT value FROM resources WHERE project=? AND json_extract(value,'$.kind')=? AND json_extract(value,'$.logicalPath')=? AND coalesce(json_extract(value,'$.sourceId'),'')=?", &[&project_id,&kind,&path,&project["sourceId"].as_str().unwrap_or("")])?.first() {
        return Ok(resource["resourceId"].as_str().ok_or("Missing resource ID")?.into());
    }
    crate::sources::resource_id(project, kind, path)
}
fn instruction_allowed(root: &Path, relative: &Path) -> bool {
    memory_context::discoverable(relative)
        && !std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["check-ignore", "--quiet", "--"])
            .arg(relative)
            .output()
            .is_ok_and(|output| output.status.success())
}
pub fn manifest_hash(files: &Value) -> String {
    db::digest(files.to_string().as_bytes())
}
pub fn queue(db: &rusqlite::Connection, project: &str, path: &str, value: &Value) -> Result<()> {
    crate::projects::require_sharing(db, project, crate::projects::queued_kind(path, value))?;
    db.execute(
        "INSERT INTO outbox VALUES(?,?,?,?,NULL)",
        params![
            value["id"].as_str().ok_or("Missing request ID")?,
            project,
            path,
            value.to_string()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn binding(db: &rusqlite::Connection, id: &str) -> Result<Value> {
    Ok(
        db::rows(db, "SELECT value FROM bindings WHERE id=?", &[&id])?
            .into_iter()
            .next()
            .unwrap_or(json!({})),
    )
}
fn error(db: &rusqlite::Connection, source: &str, error: &str) -> Result<()> {
    db.execute(
        "INSERT INTO errors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET error=excluded.error",
        params![source, error],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
struct Scanned<'a> {
    kind: &'a str,
    source: &'a str,
    logical: &'a str,
    title: &'a str,
    files: Vec<Value>,
    paths: Vec<PathBuf>,
    native_id: Option<&'a str>,
}
fn collect(
    db: &rusqlite::Connection,
    project: &Value,
    scanned: Scanned<'_>,
    seen: &mut BTreeSet<String>,
) -> Result<()> {
    let Scanned {
        kind,
        source,
        logical,
        title,
        files,
        paths,
        native_id,
    } = scanned;
    if !crate::projects::sharing_allowed(project, kind) {
        return Ok(());
    }
    let project_id = project["id"].as_str().ok_or("Missing project ID")?;
    let mut id = scoped_resource_id(db, project, kind, logical)?;
    if let Some(native_id) = native_id {
        if let Some(b) = db::rows(
            db,
            "SELECT value FROM bindings WHERE project=? AND json_extract(value,'$.nativeId')=? AND coalesce(json_extract(value,'$.base.sourceId'),'')=?",
            &[&project_id, &native_id, &project["sourceId"].as_str().unwrap_or("")],
        )?
        .first()
        {
            if let Some(existing) = b["base"]["resourceId"].as_str() {
                id = existing.into();
            }
        }
    }
    seen.insert(id.clone());
    let mut b = binding(db, &id)?;
    if kind == "session" {
        let fork = crate::session_forks::info(db, &id)?;
        if let (Some(parent), Some(destination), Some(native_id)) = (
            fork["parentId"].as_str(),
            fork["destination"].as_str(),
            native_id,
        ) {
            b["base"]["logicalPath"] =
                json!(format!("{source}/forks/{parent}/{destination}/{native_id}"));
        }
    }
    if project["governed"] == true {
        let existing = db::rows(db, "SELECT value FROM resources WHERE id=?", &[&id])?
            .into_iter()
            .next()
            .unwrap_or(Value::Null);
        let mut local = json!({"resourceId":id,"kind":kind,"source":source,"logicalPath":logical,"title":title,"files":files,"deleted":files.is_empty()});
        crate::sources::scope(project, &mut local);
        if kind == "session" || kind == "plan" {
            local["contextSources"] = scanned_sources(db, project, logical, native_id)?;
        }
        if kind == "memory"
            || kind == "skill"
            || (existing["access"]["mode"]
                .as_str()
                .is_some_and(|m| m != "publish"))
        {
            if !files.is_empty()
                && manifest_hash(&json!(files)) != manifest_hash(&existing["files"])
            {
                crate::governance::capture(db, project, &local, &json!(paths))?;
                if !b.is_null() && b.is_object() {
                    b["installationState"] = json!("locally_modified");
                    db::upsert(db, "bindings", &id, project_id, &b)?;
                }
            }
            return Ok(());
        }
    }
    if kind == "session"
        && !paths.is_empty()
        && b["nativeId"].as_str() == native_id
        && !b["paths"].is_null()
        && b["paths"] != json!(&paths)
    {
        b["paths"] = json!(&paths);
        if b["lastSeenHash"] == manifest_hash(&json!(&files)) {
            b["guards"] = json!(vec![b["lastSeenHash"].clone(); paths.len()]);
        }
        db::upsert(db, "bindings", &id, project_id, &b)?;
    }
    if b["needsCopy"] == true {
        return Ok(());
    }
    // Archiving a teammate's local copy does not edit or delete their shared session.
    if kind == "session"
        && files.is_empty()
        && b["base"]["owner"].is_string()
        && b["base"]["owner"] != db::get(db, "user")?
    {
        return Ok(());
    }
    let files = json!(files);
    let hash = manifest_hash(&files);
    if kind == "session"
        && b["base"]["owner"].is_string()
        && b["base"]["owner"] != db::get(db, "user")?
        && b["lastSeenHash"].as_str().is_some_and(|last| last != hash)
    {
        b["needsCopy"] = json!(true);
        db::upsert(db, "bindings", &id, project_id, &b)?;
        db::set(db, "syncRequest", &json!(Uuid::new_v4().to_string()))?;
        return Ok(());
    }
    let deleted = files.as_array().is_none_or(|a| a.is_empty());
    let base_revision = b["base"]["revision"].as_u64().unwrap_or(0);
    let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE json_extract(value,'$.resource.resourceId')=? OR json_extract(value,'$.resourceId')=?)",params![id,id],|r|r.get(0)).map_err(|e|e.to_string())?;
    let last = b["lastSeenHash"].as_str().unwrap_or("").to_string();
    let changed = hash != last;
    if b["paths"].is_null() {
        b["paths"] = json!(&paths);
        b["base"] = json!({"resourceId":id,"revision":0,"files":[],"kind":kind,"source":source,"logicalPath":logical,"title":title,"owner":db::get(db,"user")?,"projectId":project_id,"deleted":false});
        crate::sources::scope(project, &mut b["base"]);
        if let Some(n) = native_id {
            b["nativeId"] = json!(n);
        }
    }
    if changed && !pending {
        let title = if kind == "plan" {
            title
        } else {
            b["base"]["title"].as_str().unwrap_or(title)
        };
        let mut input = json!({"resourceId":id,"kind":kind,"source":source,"logicalPath":b["base"]["logicalPath"].as_str().unwrap_or(logical),"title":title,"files":files,"deleted":deleted});
        crate::sources::scope(project, &mut input);
        if project["governed"] == true && (kind == "session" || kind == "plan") {
            input["contextSources"] = scanned_sources(db, project, logical, native_id)?;
            if input["contextSources"].is_null() {
                input
                    .as_object_mut()
                    .ok_or("Invalid resource")?
                    .remove("contextSources");
            }
        }
        let change = json!({"version":2,"id":Uuid::new_v4().to_string(),"projectId":project_id,"deviceId":db::device(db)?,"baseRevision":base_revision,"resource":input});
        queue(db, project_id, "/v2/sync/push", &change)?;
        let mut guards = crate::sync::live_hash(
            &b,
            kind,
            Path::new(project["path"].as_str().ok_or("Connect a folder")?),
        )?;
        if let Some(origin) = paths.first() {
            if let Some(index) = b["paths"]
                .as_array()
                .and_then(|mapped| mapped.iter().position(|p| p.as_str() == origin.to_str()))
            {
                guards[index] = hash.clone();
            }
        }
        b["guards"] = json!(guards);
        b["writeGuard"] = json!(hash);
        b["lastSeenHash"] = json!(hash);
        if base_revision == 0 {
            let mut local = input;
            local["hash"] = json!(hash);
            local["projectId"] = json!(project_id);
            local["revision"] = json!(0);
            local["owner"] = db::get(db, "user")?;
            local["updatedBy"] = db::get(db, "user")?;
            local["updatedAt"] = json!(db::now());
            db::upsert(db, "resources", &id, project_id, &local)?;
        }
    }
    db::upsert(db, "bindings", &id, project_id, &b)
}
fn scanned_sources(
    db: &rusqlite::Connection,
    project: &Value,
    logical: &str,
    native_id: Option<&str>,
) -> Result<Value> {
    let embedded_session = logical.split('/').collect::<Vec<_>>();
    let session = native_id.or_else(|| {
        if embedded_session.get(1) == Some(&"sessions") {
            embedded_session.get(2).copied()
        } else {
            None
        }
    });
    if let Some(session) = session {
        return native::session_sources(
            db,
            project["id"].as_str().ok_or("Missing project")?,
            session,
        );
    }
    let mut sources = db::get(
        db,
        &format!(
            "{}:{logical}",
            crate::sources::meta_key(project, "planSources")?
        ),
    )?
    .as_array()
    .cloned()
    .unwrap_or_default();
    for id in db::get(db, &crate::sources::meta_key(project, "exposedSources")?)?
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        if !sources.contains(&id) {
            sources.push(id);
        }
    }
    Ok(json!(sources))
}
fn collect_plan_file(
    db: &rusqlite::Connection,
    project: &Value,
    source: &str,
    logical: &str,
    path: &Path,
    seen: &mut BTreeSet<String>,
) -> Result<()> {
    let (file, title) = plans::file(path)?;
    collect(
        db,
        project,
        Scanned {
            kind: "plan",
            source,
            logical,
            title: &title,
            files: vec![file],
            paths: vec![path.into()],
            native_id: None,
        },
        seen,
    )
}

fn collect_embedded_plan(
    db: &rusqlite::Connection,
    project: &Value,
    source: &str,
    logical: &str,
    text: &str,
    seen: &mut BTreeSet<String>,
) -> Result<()> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let id = scoped_resource_id(db, project, "plan", logical)?;
    seen.insert(id.clone());
    let b = binding(db, &id)?;
    let origin = db::digest(text.as_bytes());
    let root = Path::new(project["path"].as_str().ok_or("Connect a folder")?);
    if b["planOriginHash"] == origin {
        if let Some(path) = b["paths"][0].as_str() {
            let path = Path::new(path);
            plans::check_path(root, path)?;
            if path.try_exists().map_err(|e| e.to_string())? {
                return collect_plan_file(db, project, source, logical, path, seen);
            }
        }
        return Ok(());
    }
    let pending: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE json_extract(value,'$.resource.resourceId')=?)", [&id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if pending {
        return Ok(());
    }
    let file = plans::content(text.as_bytes())?;
    let path = plans::destination(root, &json!({"source":source,"logicalPath":logical}))?;
    plans::check_path(root, &path)?;
    if b["paths"].is_null() && !path.try_exists().map_err(|e| e.to_string())? {
        packages::write_file(root, &path, &file)?;
    }
    collect(
        db,
        project,
        Scanned {
            kind: "plan",
            source,
            logical,
            title: &plans::title(text, "Plan"),
            files: vec![file],
            paths: vec![path],
            native_id: None,
        },
        seen,
    )?;
    let mut b = binding(db, &id)?;
    b["planOriginHash"] = json!(origin);
    db::upsert(db, "bindings", &id, project_id, &b)
}

pub fn scan(db: &rusqlite::Connection, project: &Value) -> Result<()> {
    let mut failures = Vec::new();
    for source in crate::sources::views(project) {
        let result = scan_source(db, &source);
        let key = format!(
            "{}:source:{}",
            project["id"].as_str().unwrap_or(""),
            source["sourceId"].as_str().unwrap_or("default")
        );
        if let Err(error) = &result {
            failures.push(error.clone());
        }
        crate::sync::record_result(db, &key, result)?;
    }
    // Other repositories still scan when one checkout is missing. Filesystem
    // application validates each source independently after the project pull.
    if !project["sources"].is_array() && !failures.is_empty() {
        return Err(failures.join("; "));
    }
    Ok(())
}

fn scan_source(db: &rusqlite::Connection, project: &Value) -> Result<()> {
    let Some(raw) = project["path"].as_str() else {
        return Ok(());
    };
    let root = Path::new(raw);
    if !root.is_dir() {
        return Err("Connected folder unavailable; deletions paused".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    fs::read_dir(&root).map_err(|e| e.to_string())?;
    let project_id = project["id"].as_str().ok_or("Missing project ID")?;
    let scan_id = project["sourceId"]
        .as_str()
        .map(|source| format!("{project_id}:{source}"))
        .unwrap_or(project_id.into());
    if let Some(identity) = project["folderIdentity"].as_str() {
        if !folder_identity_matches(&root, identity)? {
            return Err(
                "Connected folder changed or its mount is missing; deletions paused".into(),
            );
        }
    }
    db.execute(
        "DELETE FROM errors WHERE source GLOB ? OR source GLOB ? OR source GLOB ? OR source GLOB ?",
        [
            format!("{scan_id}:scan:*"),
            format!("{scan_id}:/*"),
            format!("{scan_id}:plans:*"),
            format!("{scan_id}:plan:*"),
        ],
    )
    .map_err(|e| e.to_string())?;
    let mut seen = BTreeSet::new();
    // Keep ignored source drafts recoverable without leaving fixture copies in review.
    for mut draft in db::rows(db, "SELECT value FROM drafts WHERE project=? AND json_extract(value,'$.status')='local' AND json_extract(value,'$.resource.kind')='memory'", &[&project_id])? {
        if !crate::sources::matches(project, &draft["resource"]) { continue; }
        if let Some(relative) = draft["resource"]["logicalPath"].as_str().and_then(|p| p.strip_prefix("instructions/")) {
            if !instruction_allowed(&root, Path::new(relative)) {
                draft["status"] = json!("dismissed");
                draft["dismissalReason"] = json!("ignored_source");
                db::upsert(db, "drafts", draft["id"].as_str().ok_or("Missing draft")?, project_id, &draft)?;
            }
        }
    }
    let claude = native::claude_home()?;
    let codex = native::codex_home()?;
    let mut memory_complete = true;
    if crate::projects::sharing_allowed(project, "memory") {
        let result = (|| {
            for entry in WalkDir::new(&root)
                .follow_links(false)
                .into_iter()
                .filter_entry(|e| {
                    !e.file_type().is_dir()
                        || e.path()
                            .strip_prefix(&root)
                            .is_ok_and(memory_context::discoverable)
                })
            {
                let e = entry.map_err(|e| e.to_string())?;
                if !e.file_type().is_file()
                    || !matches!(
                        e.file_name().to_str(),
                        Some("AGENTS.md" | "AGENTS.override.md" | "CLAUDE.md")
                    )
                {
                    continue;
                }
                let rel = e
                    .path()
                    .strip_prefix(&root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .to_string();
                let logical = format!("instructions/{rel}");
                if !instruction_allowed(&root, Path::new(&rel)) {
                    continue;
                }
                seen.insert(scoped_resource_id(db, project, "memory", &logical)?);
                let result = (|| {
                    collect(
                        db,
                        project,
                        Scanned {
                            kind: "memory",
                            source: "shared",
                            logical: &logical,
                            title: &rel,
                            files: vec![packages::file(e.path(), "content.md")?],
                            paths: vec![e.path().into()],
                            native_id: None,
                        },
                        &mut seen,
                    )?;
                    Ok(())
                })();
                crate::sync::record_result(db, &format!("{scan_id}:scan:{logical}"), result)?;
            }
            let memory = claude_memory(&root)?;
            if memory.exists() {
                for entry in WalkDir::new(&memory).follow_links(false) {
                    let e = entry.map_err(|e| e.to_string())?;
                    if e.file_type().is_file() && e.path().extension().is_some_and(|s| s == "md") {
                        let rel = e
                            .path()
                            .strip_prefix(&memory)
                            .map_err(|e| e.to_string())?
                            .to_string_lossy()
                            .to_string();
                        let logical = format!("claude/{rel}");
                        seen.insert(scoped_resource_id(db, project, "memory", &logical)?);
                        let result = (|| {
                            collect(
                                db,
                                project,
                                Scanned {
                                    kind: "memory",
                                    source: "claude",
                                    logical: &logical,
                                    title: &rel,
                                    files: vec![packages::file(e.path(), "content.md")?],
                                    paths: vec![e.path().into()],
                                    native_id: None,
                                },
                                &mut seen,
                            )?;
                            Ok(())
                        })();
                        crate::sync::record_result(
                            db,
                            &format!("{scan_id}:scan:{logical}"),
                            result,
                        )?;
                    }
                }
            }
            let summaries = codex.join("memories/rollout_summaries");
            let mut summary_projects = BTreeMap::new();
            let mut summary_threads = BTreeMap::new();
            let mut summary_files: BTreeMap<String, (String, PathBuf, String)> = BTreeMap::new();
            if summaries.exists() {
                for entry in fs::read_dir(&summaries).map_err(|e| e.to_string())? {
                    let path = entry.map_err(|e| e.to_string())?.path();
                    if path.extension().is_none_or(|e| e != "md") {
                        continue;
                    }
                    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
                    let cwd = text.lines().find_map(|l| l.strip_prefix("cwd: "));
                    let belongs =
                        cwd.is_some_and(|p| Path::new(p.trim_matches('"')).starts_with(&root));
                    let name = path
                        .file_name()
                        .ok_or("Missing filename")?
                        .to_string_lossy()
                        .to_string();
                    summary_projects.insert(name.clone(), belongs);
                    if let Some(thread) = memory_context::summary_thread(&text) {
                        summary_threads.insert(name.clone(), thread);
                    }
                    if belongs {
                        let key = memory_context::summary_thread(&text)
                            .map(|id| format!("{id}.md"))
                            .unwrap_or(name.clone());
                        let updated = text
                            .lines()
                            .find_map(|line| line.strip_prefix("updated_at: "))
                            .unwrap_or("")
                            .to_owned();
                        if summary_files
                            .get(&key)
                            .is_none_or(|(old, _, _)| updated > *old)
                        {
                            summary_files.insert(key, (updated, path, name));
                        }
                    }
                }
            }
            let durable = codex.join("memories/MEMORY.md");
            let mut covered = BTreeSet::new();
            if durable.exists() {
                let text = fs::read_to_string(&durable).map_err(|e| e.to_string())?;
                let references =
                    regex::Regex::new(r"(?m)^\s*-\s*([^\s]+\.md)").map_err(|e| e.to_string())?;
                for section in text.split("\n# ") {
                    let refs = references
                        .captures_iter(section)
                        .filter_map(|c| {
                            Path::new(&c[1])
                                .file_name()
                                .map(|name| name.to_string_lossy().to_string())
                        })
                        .collect::<Vec<_>>();
                    if refs.is_empty()
                        || !refs.iter().all(|r| summary_projects.get(r) == Some(&true))
                    {
                        continue;
                    }
                    covered.extend(refs);
                    let title = section
                        .lines()
                        .next()
                        .unwrap_or("Learned memory")
                        .trim_start_matches('#')
                        .trim();
                    let name = format!("{}.md", &db::digest(title.as_bytes())[..20]);
                    let bytes = section.as_bytes();
                    collect(
                        db,
                        project,
                        Scanned {
                            kind: "memory",
                            source: "codex",
                            logical: &format!("codex/entries/{name}"),
                            title,
                            files: vec![
                                json!({"path":"content.md","hash":db::blob(bytes)?,"size":bytes.len(),"executable":false}),
                            ],
                            paths: vec![durable.clone()],
                            native_id: None,
                        },
                        &mut seen,
                    )?;
                }
            }
            let covered_threads: BTreeSet<_> = covered
                .iter()
                .filter_map(|name| summary_threads.get(name))
                .collect();
            for (key, (_, path, title)) in summary_files {
                if covered.contains(&title)
                    || summary_threads
                        .get(&title)
                        .is_some_and(|thread| covered_threads.contains(thread))
                {
                    continue;
                }
                collect(
                    db,
                    project,
                    Scanned {
                        kind: "memory",
                        source: "codex",
                        logical: &format!("codex/summaries/{key}"),
                        title: &title,
                        files: vec![packages::file(&path, "content.md")?],
                        paths: vec![path],
                        native_id: None,
                    },
                    &mut seen,
                )?;
            }
            Ok(())
        })();
        memory_complete = result.is_ok();
        crate::sync::record_result(db, &format!("{scan_id}:scan:memory"), result)?;
    }
    if crate::projects::sharing_allowed(project, "skill") {
        let mut skills: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
        for folder in [".agents/skills", ".claude/skills"] {
            let directory = root.join(folder);
            if !directory.exists() {
                continue;
            }
            for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
                let e = entry.map_err(|e| e.to_string())?;
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || !e.path().join("SKILL.md").is_file() {
                    continue;
                }
                skills.entry(name).or_default().push(e.path());
            }
        }
        for (name, paths) in skills {
            let id = scoped_resource_id(db, project, "skill", &name)?;
            seen.insert(id.clone());
            let result = (|| {
                if !db::get(db, &format!("installation:{id}"))?.is_null() {
                    return Err(
                        "Skill installation recovery pending; local copies preserved".into(),
                    );
                }
                let mut b = binding(db, &id)?;
                let empty = manifest_hash(&json!([]));
                let removed = b["paths"].as_array().is_some_and(|mapped| {
                    mapped.iter().enumerate().any(|(i, p)| {
                        b["guards"][i].as_str().is_some_and(|h| h != empty)
                            && p.as_str().is_some_and(|p| !Path::new(p).exists())
                    })
                });
                if removed && b["mirrorReview"] != true {
                    collect(
                        db,
                        project,
                        Scanned {
                            kind: "skill",
                            source: "shared",
                            logical: &name,
                            title: &name,
                            files: vec![],
                            paths: vec![],
                            native_id: None,
                        },
                        &mut seen,
                    )?;
                    return Ok(());
                }
                let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE json_extract(value,'$.resource.resourceId')=?)",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
                let base = b["base"].clone();
                let copies = paths
                    .iter()
                    .map(|p| packages::directory(p).map(|f| (p, json!(f))))
                    .collect::<Result<Vec<_>>>()?;
                if project["governed"] != true
                    && base["revision"].as_u64().unwrap_or(0) == 0
                    && copies.windows(2).any(|pair| pair[0].1 != pair[1].1)
                {
                    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
                    for (path, files) in &copies {
                        let mut resource = json!({"resourceId":id,"kind":"skill","source":"shared","logicalPath":name,"title":name,"files":files,"deleted":false});
                        crate::sources::scope(project, &mut resource);
                        crate::governance::capture(&tx, project, &resource, &json!([path]))?;
                    }
                    for queued in db::rows(&tx,"SELECT value FROM outbox WHERE project=? AND json_extract(value,'$.resource.resourceId')=?",&[&project_id,&id])? {
                    crate::governance::capture(&tx, project, &queued["resource"], &json!(paths))?;
                }
                    tx.execute("DELETE FROM outbox WHERE project=? AND json_extract(value,'$.resource.resourceId')=?",params![project_id,id]).map_err(|e|e.to_string())?;
                    b["mirrorReview"] = json!(true);
                    db::upsert(&tx, "bindings", &id, project_id, &b)?;
                    tx.commit().map_err(|e| e.to_string())?;
                    error(db, &id, SKILL_MIRROR_REVIEW)?;
                    seen.insert(id.clone());
                    return Ok(());
                }
                if b["mirrorReview"] == true {
                    b["mirrorReview"] = json!(false);
                    db::upsert(db, "bindings", &id, project_id, &b)?;
                }
                let changed = copies
                    .iter()
                    .filter(|(path, files)| {
                        let guard = b["paths"]
                            .as_array()
                            .and_then(|mapped| {
                                mapped.iter().position(|p| p.as_str() == path.to_str())
                            })
                            .and_then(|index| b["guards"][index].as_str())
                            .or_else(|| b["lastSeenHash"].as_str());
                        guard.is_some_and(|h| manifest_hash(files) != h)
                    })
                    .collect::<Vec<_>>();
                let selected = changed
                    .first()
                    .copied()
                    .or_else(|| {
                        copies
                            .iter()
                            .find(|(_, files)| b["lastSeenHash"] == manifest_hash(files))
                    })
                    .map(|(path, _)| (*path).clone())
                    .unwrap_or_else(|| paths[0].clone());
                collect(
                    db,
                    project,
                    Scanned {
                        kind: "skill",
                        source: "shared",
                        logical: &name,
                        title: &name,
                        files: packages::directory(&selected)?,
                        paths: vec![
                            selected.clone(),
                            if selected == root.join(".agents/skills").join(&name) {
                                root.join(".claude/skills").join(&name)
                            } else {
                                root.join(".agents/skills").join(&name)
                            },
                        ],
                        native_id: None,
                    },
                    &mut seen,
                )?;
                if project["governed"] != true
                    && !pending
                    && changed.len() > 1
                    && changed[0].1 != changed[1].1
                {
                    let mut input = json!({"version":2,"id":Uuid::new_v4().to_string(),"projectId":project_id,"deviceId":db::device(db)?,"baseRevision":base["revision"].as_u64().unwrap_or(0),"resource":{"resourceId":id,"kind":"skill","source":"shared","logicalPath":name,"title":name,"files":changed[1].1,"deleted":false}});
                    crate::sources::scope(project, &mut input["resource"]);
                    queue(db, project_id, "/v2/sync/push", &input)?;
                    let mut b = binding(db, &id)?;
                    if let Some(i) = b["paths"].as_array().and_then(|mapped| {
                        mapped
                            .iter()
                            .position(|p| p.as_str() == changed[1].0.to_str())
                    }) {
                        b["guards"][i] = json!(manifest_hash(&changed[1].1));
                        db::upsert(db, "bindings", &id, project_id, &b)?;
                    }
                }
                Ok(())
            })();
            crate::sync::record_result(db, &format!("{scan_id}:scan:{id}"), result)?;
        }
    }
    let mut sessions_complete = true;
    if crate::projects::sharing_allowed(project, "plan") {
        for source in ["codex", "claude"] {
            let directory = plans::project_directory(&root, source)?;
            plans::check_path(&root, &directory)?;
            if !directory.try_exists().map_err(|e| e.to_string())? {
                continue;
            }
            for entry in WalkDir::new(&directory).follow_links(false) {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.file_type().is_symlink() {
                    return Err("Symlinked plans are excluded; deletions paused".into());
                }
                if !entry.file_type().is_file()
                    || entry
                        .path()
                        .extension()
                        .is_none_or(|s| !s.eq_ignore_ascii_case("md"))
                {
                    continue;
                }
                let relative = entry
                    .path()
                    .strip_prefix(&directory)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy();
                let logical = format!("{source}/files/{relative}");
                if let Err(err) =
                    collect_plan_file(db, project, source, &logical, entry.path(), &mut seen)
                {
                    error(
                        db,
                        &format!("{scan_id}:scan:{}", entry.path().display()),
                        &err,
                    )?;
                }
            }
        }
    }
    if crate::projects::sharing_allowed(project, "session")
        || crate::projects::sharing_allowed(project, "plan")
    {
        for (tool, directory) in [
            ("codex", codex.join("sessions")),
            ("claude", claude.join("projects")),
        ] {
            if !directory.exists() {
                sessions_complete = false;
                continue;
            }
            for entry in WalkDir::new(&directory).follow_links(false) {
                let e = entry.map_err(|e| e.to_string())?;
                if !e.file_type().is_file()
                    || !(e.path().extension().is_some_and(|s| s == "jsonl")
                        || (tool == "codex" && crate::history::is_session(e.path())))
                {
                    continue;
                }
                let bytes = match if tool == "codex" {
                    crate::history::read_session(e.path())
                } else {
                    fs::read(e.path()).map_err(|e| e.to_string())
                } {
                    Ok(bytes) => bytes,
                    Err(err) => {
                        error(
                            db,
                            &format!("{scan_id}:scan:{}", e.path().display()),
                            &err.to_string(),
                        )?;
                        sessions_complete = false;
                        continue;
                    }
                };
                if bytes.len() > 128 * 1024 * 1024 {
                    error(
                        db,
                        &format!("{scan_id}:scan:{}", e.path().display()),
                        "Session exceeds 128 MB; source preserved",
                    )?;
                    sessions_complete = false;
                    continue;
                }
                let records = match native::complete_records(&bytes) {
                    Ok(r) => r,
                    Err(err) => {
                        error(db, &format!("{scan_id}:scan:{}", e.path().display()), &err)?;
                        sessions_complete = false;
                        continue;
                    }
                };
                let attributable = native::session_cwd(tool, &records).map_or_else(
                    |_| {
                        records.iter().any(|r| {
                            r["cwd"]
                                .as_str()
                                .or(r["payload"]["cwd"].as_str())
                                .is_some_and(|p| Path::new(p).starts_with(&root))
                        })
                    },
                    |cwd| cwd.starts_with(&root),
                );
                if !attributable {
                    continue;
                }
                let (id, cwd, title) = match native::session_info(tool, &records) {
                    Ok(v) => v,
                    Err(err) => {
                        error(db, &format!("{scan_id}:scan:{}", e.path().display()), &err)?;
                        sessions_complete = false;
                        continue;
                    }
                };
                if !cwd.starts_with(&root) {
                    continue;
                }
                if tool == "codex" {
                    match crate::history::current_path(e.path(), &id) {
                        Ok(latest) if latest != e.path() => continue,
                        Err(err) => {
                            error(db, &format!("{scan_id}:scan:{}", e.path().display()), &err)?;
                            sessions_complete = false;
                            continue;
                        }
                        _ => (),
                    }
                }
                if tool == "claude"
                    && e.path()
                        .file_stem()
                        .is_none_or(|name| name.to_string_lossy() != id)
                {
                    continue;
                }
                if tool == "codex"
                    && records
                        .iter()
                        .find(|r| r["type"] == "session_meta")
                        .is_some_and(|r| r["payload"]["source"].is_object())
                {
                    continue;
                }
                if tool == "codex"
                    && crate::codex_import::is_pending_or_dependency(db, &id, &records)?
                {
                    continue;
                }
                let files = match crate::history::session_files(tool, e.path(), Some(&root)) {
                    Ok(files) => files,
                    Err(err) => {
                        error(db, &format!("{scan_id}:scan:{}", e.path().display()), &err)?;
                        sessions_complete = false;
                        continue;
                    }
                };
                if project["governed"] == true {
                    let records =
                        crate::history::resource_records(&json!({"source":tool,"files":files}))?;
                    native::bind_handoff(db, project_id, &id, &records)?;
                }
                if crate::projects::sharing_allowed(project, "plan") {
                    let plan_records =
                        crate::history::resource_records(&json!({"source":tool,"files":files}))?;
                    let mut has_plan_file = false;
                    match plans::references(tool, &root, &plan_records) {
                        Ok(paths) => {
                            for path in paths {
                                if !path.try_exists().map_err(|e| e.to_string())? {
                                    continue;
                                }
                                let local = plans::project_directory(&root, tool)?;
                                let logical = if let Ok(relative) = path.strip_prefix(&local) {
                                    format!("{tool}/files/{}", relative.to_string_lossy())
                                } else {
                                    format!(
                                        "{tool}/native/{}",
                                        path.strip_prefix(plans::native_directory(tool)?)
                                            .map_err(|e| e.to_string())?
                                            .to_string_lossy()
                                    )
                                };
                                if project["governed"] == true {
                                    let mut known = db::get(
                                        db,
                                        &format!(
                                            "{}:{logical}",
                                            crate::sources::meta_key(project, "planSources")?
                                        ),
                                    )?
                                    .as_array()
                                    .cloned()
                                    .unwrap_or_default();
                                    for source in native::session_sources(db, project_id, &id)?
                                        .as_array()
                                        .cloned()
                                        .unwrap_or_default()
                                    {
                                        if !known.contains(&source) {
                                            known.push(source);
                                        }
                                    }
                                    db::set(
                                        db,
                                        &format!(
                                            "{}:{logical}",
                                            crate::sources::meta_key(project, "planSources")?
                                        ),
                                        &json!(known),
                                    )?;
                                }
                                match collect_plan_file(
                                    db, project, tool, &logical, &path, &mut seen,
                                ) {
                                    Ok(()) => has_plan_file = true,
                                    Err(err) => error(
                                        db,
                                        &format!("{scan_id}:scan:{}", path.display()),
                                        &err,
                                    )?,
                                }
                            }
                        }
                        Err(err) => error(
                            db,
                            &format!("{scan_id}:scan:plans:{}", e.path().display()),
                            &err,
                        )?,
                    }
                    for (name, text) in plans::embedded(tool, &plan_records) {
                        if tool == "claude" && has_plan_file {
                            continue;
                        }
                        if let Err(err) = collect_embedded_plan(
                            db,
                            project,
                            tool,
                            &format!("{tool}/sessions/{id}/{name}"),
                            &text,
                            &mut seen,
                        ) {
                            error(db, &format!("{scan_id}:scan:plan:{tool}/{id}/{name}"), &err)?;
                        }
                    }
                }
                let handoff = crate::session_forks::handoff_origin(db, project, tool, &records)?;
                let logical = if let Some(origin) = &handoff {
                    format!(
                        "{tool}/forks/{}/{}/{id}",
                        origin["parentId"].as_str().ok_or("Missing parent")?,
                        origin["destination"]
                            .as_str()
                            .ok_or("Missing destination")?
                    )
                } else {
                    format!("{tool}/{id}")
                };
                let result = collect(
                    db,
                    project,
                    Scanned {
                        kind: "session",
                        source: tool,
                        logical: &logical,
                        title: &title,
                        files,
                        paths: vec![e.path().into()],
                        native_id: Some(&id),
                    },
                    &mut seen,
                );
                if result.is_err() {
                    sessions_complete = false;
                }
                crate::sync::record_result(
                    db,
                    &format!("{scan_id}:scan:{}", e.path().display()),
                    result,
                )?;
            }
        }
    }
    if project["governed"] == true {
        // A plan file can be seen before its transcript references. Reconcile all
        // discovered sources before any queued version is sent to the service.
        for queued in db::rows(db,"SELECT json_object('id',id,'value',json(value)) FROM outbox WHERE project=? AND json_extract(value,'$.resource.kind')='plan'",&[&project_id])? {
            let mut change=queued["value"].clone();
            if !crate::sources::matches(project, &change["resource"]) { continue; }
            let mut known=change["resource"]["contextSources"].as_array().cloned().unwrap_or_default();
            for source in scanned_sources(db,project,change["resource"]["logicalPath"].as_str().ok_or("Missing plan path")?,None)?.as_array().cloned().unwrap_or_default() {if !known.contains(&source){known.push(source);}}
            if change["resource"]["contextSources"]!=json!(known) {
                let new_id=Uuid::new_v4().to_string();change["id"]=json!(new_id);change["resource"]["contextSources"]=json!(known);
                db.execute("UPDATE outbox SET id=?,value=?,error=NULL WHERE id=?",params![new_id,change.to_string(),queued["id"].as_str()]).map_err(|e|e.to_string())?;
            }
        }
    }
    for b in db::rows(
        db,
        "SELECT value FROM bindings WHERE project=?",
        &[&project_id],
    )? {
        let base = &b["base"];
        if !crate::sources::matches(project, base) {
            continue;
        }
        let Some(id) = base["resourceId"].as_str() else {
            continue;
        };
        if seen.contains(id) || base["deleted"] == true || b["needsCopy"] == true {
            continue;
        }
        let result = (|| {
            let kind = base["kind"].as_str().unwrap_or("");
            if !crate::projects::sharing_allowed(project, kind) {
                return Ok(());
            }
            if kind == "plan" {
                if let Some(path) = b["paths"][0].as_str() {
                    let path = Path::new(path);
                    if path.starts_with(root.join(".orka/plans"))
                        && path.try_exists().map_err(|e| e.to_string())?
                    {
                        plans::check_path(&root, path)?;
                        collect_plan_file(
                            db,
                            project,
                            base["source"].as_str().ok_or("Missing plan source")?,
                            base["logicalPath"].as_str().ok_or("Missing plan path")?,
                            path,
                            &mut seen,
                        )?;
                        return Ok(());
                    }
                }
            }
            if project["governed"] == true && matches!(kind, "memory" | "skill") {
                if crate::governance::protected(base)
                    && b["paths"].is_array()
                    && b["base"]["deleted"] != true
                {
                    let mut next = b.clone();
                    if crate::sync::live_hash(&b, kind, &root)?
                        .iter()
                        .any(|h| h != &manifest_hash(&base["files"]))
                    {
                        next["installationState"] = json!("locally_modified");
                        db::upsert(
                            db,
                            "bindings",
                            base["resourceId"].as_str().ok_or("Missing resource")?,
                            project_id,
                            &next,
                        )?;
                    }
                }
                return Ok(());
            }
            if kind == "session" && !sessions_complete {
                return Ok(());
            }
            if kind == "memory" && (!memory_complete || base["source"] == "codex") {
                return Ok(());
            }
            if kind == "plan"
                && base["logicalPath"]
                    .as_str()
                    .is_some_and(|p| p.contains("/sessions/"))
            {
                return Ok(());
            }
            let paths = b["paths"].as_array().ok_or("Missing binding paths")?;
            for p in paths {
                Path::new(p.as_str().ok_or("Invalid path")?)
                    .try_exists()
                    .map_err(|e| e.to_string())?;
            }
            let codex_archived = if kind == "session" && base["source"] == "codex" {
                if let (Some(path), Some(native_id)) = (
                    paths.first().and_then(Value::as_str),
                    b["nativeId"].as_str(),
                ) {
                    crate::history::current_path(Path::new(path), native_id)?
                        .starts_with(native::codex_home()?.join("archived_sessions"))
                } else {
                    false
                }
            } else {
                false
            };
            if !codex_archived
                && (paths.is_empty()
                    || paths
                        .iter()
                        .any(|p| p.as_str().is_some_and(|p| Path::new(p).exists())))
            {
                return Ok(());
            }
            if kind == "session"
                && native::active(
                    db,
                    b["nativeId"].as_str().unwrap_or(""),
                    base["source"].as_str().unwrap_or(""),
                )
            {
                return Ok(());
            }
            collect(
                db,
                project,
                Scanned {
                    kind,
                    source: base["source"].as_str().ok_or("Missing source")?,
                    logical: base["logicalPath"].as_str().ok_or("Missing logical path")?,
                    title: base["title"].as_str().ok_or("Missing title")?,
                    files: vec![],
                    paths: vec![],
                    native_id: b["nativeId"].as_str(),
                },
                &mut seen,
            )?;
            Ok(())
        })();
        crate::sync::record_result(db, &format!("{scan_id}:scan:{id}"), result)?;
    }
    Ok(())
}
pub fn memory_index(db: &rusqlite::Connection, project: &Value) -> Result<()> {
    for source in crate::sources::views(project) {
        let result = source_memory_index(db, &source);
        crate::sync::record_result(
            db,
            &format!(
                "{}:memory-index:{}",
                project["id"].as_str().unwrap_or(""),
                source["sourceId"].as_str().unwrap_or("default")
            ),
            result,
        )?;
    }
    Ok(())
}

fn source_memory_index(db: &rusqlite::Connection, project: &Value) -> Result<()> {
    if !crate::projects::sharing_allowed(project, "memory") {
        return Ok(());
    }
    let Some(raw) = project["path"].as_str() else {
        return Ok(());
    };
    crate::sources::validate(project)?;
    crate::governance::detach_legacy_memory(db, project)?;
    let root = Path::new(raw);
    let directory = root.join(".orka/memory");
    packages::safe_directory(root, &directory)?;
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let memory_id = project["sourceId"]
        .as_str()
        .map(|source| format!("{project_id}:{source}"))
        .unwrap_or(project_id.into());
    let resources=db::rows(db,"SELECT value FROM resources WHERE project=? AND json_extract(value,'$.kind')='memory' AND json_extract(value,'$.deleted')=0 ORDER BY id",&[&project_id])?;
    let canonical: BTreeSet<_> = memory_context::catalog(db, project)?
        .into_iter()
        .filter_map(|entry| entry.resource["resourceId"].as_str().map(str::to_owned))
        .collect();
    db.execute(
        "DELETE FROM errors WHERE source GLOB ?",
        [format!("{memory_id}:memory-index:*")],
    )
    .map_err(|e| e.to_string())?;
    let superseded = resources
        .iter()
        .flat_map(|r| {
            r["memory"]["supersedes"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    let mut text=String::from("# Shared project knowledge\n\nUse these as scoped reference facts. Keep personal learning in your native memory. Submit changes through Orka; local drafts are private.\n\n");
    let mut sources = Vec::new();
    for r in resources {
        if !crate::sources::matches(project, &r) {
            continue;
        }
        if project["governed"] == true
            && (crate::governance::protected(&r) || superseded.contains(&r["resourceId"]))
        {
            continue;
        }
        let id = r["resourceId"].as_str().ok_or("Missing resource")?;
        let result: Result<String> = (|| {
            let target = if project["governed"] == true {
                directory.join("resources").join(id).join("content.md")
            } else {
                directory.join(packages::safe_relative(
                    r["logicalPath"].as_str().ok_or("Missing memory path")?,
                )?)
            };
            let file = r["files"]
                .as_array()
                .and_then(|v| v.first())
                .ok_or("Missing memory file")?;
            if project["governed"] == true && target.is_file() {
                let local = packages::file(&target, "content.md")?;
                if local["hash"] != file["hash"] {
                    let mut draft = r.clone();
                    draft["files"] = json!([local]);
                    crate::governance::capture(db, project, &draft, &json!([target]))?;
                }
            }
            let content =
                String::from_utf8(db::blob_read(file["hash"].as_str().ok_or("Missing hash")?)?)
                    .map_err(|_| "Memory must be UTF-8")?;
            packages::write_file(root, &target, file)?;
            if !canonical.contains(id) {
                return Ok(String::new());
            }
            Ok(format!(
                "## {} [{}]\nScope: {} | Author: {} | Resource: {}\nFile: {}\n{}\n\n",
                r["title"].as_str().unwrap_or("Knowledge"),
                r["memory"]["provider"]
                    .as_str()
                    .or(r["source"].as_str())
                    .unwrap_or("shared"),
                r["memory"]["scope"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("project"),
                r["updatedBy"].as_str().unwrap_or("unknown"),
                id,
                target.display(),
                memory_context::preview(&content)
            ))
        })();
        let source = format!("{memory_id}:memory-index:{id}");
        match result {
            Ok(entry) => {
                if entry.is_empty() {
                    continue;
                }
                text.push_str(&entry);
                sources.push(json!(id));
            }
            Err(err) => error(db, &source, &err)?,
        }
    }
    db::set(db, &format!("contextSources:{project_id}"), &json!(sources))?;
    db::atomic(&directory.join("index.md"), text.as_bytes())
}
