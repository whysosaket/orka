use crate::{
    auth,
    db::{self, Result},
    indexer, native, packages,
};
use fs2::FileExt;
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
pub async fn api(method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
    let owner = db::get(&db::open()?, "user")?;
    api_as(
        owner.as_str().ok_or("Sign in required")?,
        method,
        path,
        body,
    )
    .await
}
async fn request(owner: &str, method: &str, path: &str) -> Result<reqwest::RequestBuilder> {
    let cfg = db::get(&db::open()?, "config")?;
    let base = cfg["apiUrl"].as_str().ok_or("Configure the service")?;
    request_at(owner, base, method, path).await
}
async fn request_at(
    owner: &str,
    base: &str,
    method: &str,
    path: &str,
) -> Result<reqwest::RequestBuilder> {
    db::validate_url(base)?;
    Ok(reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?
        .request(
            method
                .parse::<reqwest::Method>()
                .map_err(|e| e.to_string())?,
            format!("{}{}", base.trim_end_matches('/'), path),
        )
        .header("X-Orka-Governance", "1")
        .bearer_auth(
            auth::token_for_service(owner, base)
                .await
                .map_err(|e| format!("Sync authentication: {e}"))?,
        ))
}
pub(crate) async fn api_as(
    owner: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    let config = db::get(&db::open()?, "config")?;
    api_at(
        owner,
        config["apiUrl"].as_str().ok_or("Configure the service")?,
        method,
        path,
        body,
    )
    .await
}
pub(crate) async fn api_at(
    owner: &str,
    origin: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    let mut request = request_at(owner, origin, method, path).await?;
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Cloud unavailable; local work stays queued")?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|_| {
        format!(
            "{}: Sync service returned an unreadable response",
            status.as_u16()
        )
    })?;
    if !status.is_success() {
        return Err(format!(
            "{}: {}",
            status.as_u16(),
            value["error"].as_str().unwrap_or("Service unavailable")
        ));
    }
    Ok(value)
}
pub(crate) async fn upload(owner: &str, project: &str, files: &[Value]) -> Result<()> {
    packages::reject_env_files(files).map_err(|e| format!("Local upload: {e}"))?;
    for f in files {
        let hash = f["hash"].as_str().ok_or("Local upload: missing hash")?;
        let bytes = db::blob_read(hash).map_err(|e| format!("Local upload: {e}"))?;
        let response = request(owner, "PUT", &format!("/v2/blobs/{project}/{hash}"))
            .await?
            .body(bytes)
            .send()
            .await
            .map_err(|_| "Blob upload failed; retry retained")?;
        if !response.status().is_success() {
            return Err(format!(
                "{}: Blob upload rejected",
                response.status().as_u16()
            ));
        }
    }
    Ok(())
}
pub(crate) async fn download(owner: &str, resource: &Value) -> Result<()> {
    if resource["kind"] == "skill" {
        packages::reject_env_files(resource["files"].as_array().ok_or("Missing files")?)?;
    }
    let project = resource["projectId"].as_str().ok_or("Missing project")?;
    for f in resource["files"].as_array().ok_or("Missing files")? {
        let hash = f["hash"].as_str().ok_or("Missing hash")?;
        if db::blob_read(hash).is_ok() {
            continue;
        }
        let response = request(owner, "GET", &format!("/v2/blobs/{project}/{hash}"))
            .await?
            .send()
            .await
            .map_err(|_| "Blob download failed")?;
        if !response.status().is_success() {
            return Err(format!(
                "{}: Blob download rejected",
                response.status().as_u16()
            ));
        }
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        if bytes.len() as u64 != f["size"].as_u64().ok_or("Missing size")?
            || db::digest(&bytes) != hash
        {
            return Err("Downloaded blob failed verification".into());
        }
        db::blob(&bytes).map_err(|e| format!("Local download: {e}"))?;
    }
    Ok(())
}
pub fn apply_event(db: &rusqlite::Connection, event: &Value) -> Result<()> {
    let r = &event["resource"];
    let project = r["projectId"].as_str().ok_or("Missing project")?;
    let id = r["resourceId"].as_str().ok_or("Missing resource")?;
    let current = db::rows(db, "SELECT value FROM resources WHERE id=?", &[&id])?
        .into_iter()
        .next();
    if current
        .is_none_or(|c| c["revision"].as_u64().unwrap_or(0) <= r["revision"].as_u64().unwrap_or(0))
    {
        db::upsert(db, "resources", id, project, r)?;
        db.execute(
            "DELETE FROM conflicts WHERE project=? AND json_extract(value,'$.resourceId')=?",
            params![project, id],
        )
        .map_err(|e| e.to_string())?;
        for c in event["conflicts"]
            .as_array()
            .ok_or("Missing conflict list")?
        {
            db::upsert(
                db,
                "conflicts",
                c["id"].as_str().ok_or("Missing conflict")?,
                project,
                c,
            )?;
        }
    }
    if let Some(related) = event["related"].as_array() {
        for e in related {
            let e = json!({"resource":e["resource"],"conflicts":e["conflicts"]});
            apply_event(db, &e)?;
        }
    }
    if !event["activity"].is_null() {
        let a = &event["activity"];
        db.execute(
            "INSERT OR IGNORE INTO activity VALUES(?,?)",
            params![a["id"].as_str(), a.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn live_hash(binding: &Value, kind: &str, root: &Path) -> Result<Vec<String>> {
    let mut hashes = Vec::new();
    for path in binding["paths"].as_array().ok_or("Missing binding paths")? {
        let path = Path::new(path.as_str().ok_or("Invalid native path")?);
        let resolved;
        let path = if kind == "session" && binding["base"]["source"] == "codex" {
            resolved = crate::history::current_path(
                path,
                binding["nativeId"]
                    .as_str()
                    .ok_or("Missing native identity")?,
            )?;
            if resolved.starts_with(native::codex_home()?.join("archived_sessions")) {
                hashes.push(indexer::manifest_hash(&json!([])));
                continue;
            }
            resolved.as_path()
        } else {
            path
        };
        if !path.try_exists().map_err(|e| e.to_string())? {
            hashes.push(indexer::manifest_hash(&json!([])));
            continue;
        }
        let files = if kind == "skill" {
            json!(packages::directory(path)?)
        } else if kind == "session" {
            json!(crate::history::session_files(
                binding["base"]["source"]
                    .as_str()
                    .ok_or("Missing session source")?,
                path,
                Some(root)
            )?)
        } else if kind == "plan" {
            let source = binding["base"]["source"]
                .as_str()
                .ok_or("Missing plan source")?;
            crate::plans::path_base(root, source, path)?;
            json!([crate::plans::file(path)?.0])
        } else {
            json!([packages::file(path, "content.md")?])
        };
        hashes.push(indexer::manifest_hash(&files));
    }
    Ok(hashes)
}
fn project_memory(project: &Value, resource: &Value) -> Result<(PathBuf, PathBuf)> {
    let root = PathBuf::from(project["path"].as_str().ok_or("Connect a folder")?);
    let logical = resource["logicalPath"]
        .as_str()
        .ok_or("Missing logical path")?;
    if project["governed"] == true && !crate::governance::protected(resource) {
        return Ok((
            root.clone(),
            root.join(".orka/memory/resources")
                .join(resource["resourceId"].as_str().ok_or("Missing resource")?)
                .join("content.md"),
        ));
    }
    let path = if resource["source"] == "shared" {
        root.join(packages::safe_relative(
            logical
                .strip_prefix("instructions/")
                .ok_or("Invalid instruction path")?,
        )?)
    } else if resource["source"] == "claude" {
        let memory = indexer::claude_memory(&root)?;
        return Ok((
            memory.clone(),
            memory.join(packages::safe_relative(
                logical
                    .strip_prefix("claude/")
                    .ok_or("Invalid memory path")?,
            )?),
        ));
    } else {
        root.join(".orka/memory")
            .join(packages::safe_relative(logical)?)
    };
    Ok((root, path))
}
fn automatic_skill_binding(
    db: &rusqlite::Connection,
    project: &Value,
    resource: &Value,
    mut binding: Value,
) -> Result<Value> {
    if resource["access"]["mode"] == "hidden" {
        return Err("Skill access denied; local files preserved".into());
    }
    let root = Path::new(project["path"].as_str().ok_or("Connect a folder")?);
    if !root.is_dir()
        || project["folderIdentity"].as_str().is_some_and(|identity| {
            !indexer::folder_identity_matches(root, identity).unwrap_or(false)
        })
    {
        return Err("Connected folder changed or unavailable; reconnect it in Settings".into());
    }
    let name = packages::safe_relative(
        resource["logicalPath"]
            .as_str()
            .ok_or("Missing skill path")?,
    )?;
    if name.components().count() != 1 {
        return Err("Skill must have a single folder name".into());
    }
    let paths = [
        root.join(".agents/skills").join(&name),
        root.join(".claude/skills").join(&name),
    ];
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical_paths = [
        canonical_root.join(".agents/skills").join(&name),
        canonical_root.join(".claude/skills").join(&name),
    ];
    if binding["paths"].as_array().is_some_and(|mapped| {
        mapped.iter().any(|value| {
            let Some(path) = value.as_str().map(PathBuf::from) else {
                return true;
            };
            !paths.contains(&path)
                && !canonical_paths.contains(&path)
                && !path
                    .canonicalize()
                    .is_ok_and(|path| canonical_paths.contains(&path))
        })
    }) {
        return Err("Skill binding no longer matches the connected folder".into());
    }
    for folder in [root.join(".agents"), root.join(".claude")] {
        for path in [&folder, &folder.join("skills")] {
            if fs::symlink_metadata(path)
                .is_ok_and(|meta| meta.file_type().is_symlink() || !meta.is_dir())
            {
                return Err(
                    "Skill destination contains a symlink or file; local files preserved".into(),
                );
            }
        }
    }
    binding["paths"] = json!(paths);
    let guards = live_hash(&binding, "skill", root)?;
    let empty = indexer::manifest_hash(&json!([]));
    let base = indexer::manifest_hash(&binding["base"]["files"]);
    let incoming = indexer::manifest_hash(&resource["files"]);
    if guards
        .iter()
        .any(|hash| hash != &empty && hash != &base && hash != &incoming)
    {
        binding["installationState"] = json!("locally_modified");
        binding["availableRevision"] = resource["revision"].clone();
        db::upsert(
            db,
            "bindings",
            resource["resourceId"].as_str().ok_or("Missing resource")?,
            project["id"].as_str().ok_or("Missing project")?,
            &binding,
        )?;
        return Err(
            "Local skill edits preserved; resolve them before applying the shared update".into(),
        );
    }
    binding["reviewedRevision"] = resource["revision"].clone();
    binding["guards"] = json!(guards);
    binding["installationState"] = json!("current");
    Ok(binding)
}

pub fn materialize(db: &rusqlite::Connection, project: &Value, resource: &Value) -> Result<()> {
    let scoped;
    let project = if project["sources"].is_array() && !project["sourceId"].is_string() {
        let Some(source) = crate::sources::for_resource(project, resource) else {
            return Ok(());
        };
        scoped = source;
        &scoped
    } else {
        project
    };
    if !crate::sources::matches(project, resource) {
        return Err("Resource belongs to another repository".into());
    }
    crate::sources::validate(project)?;
    if !crate::projects::sharing_allowed(project, resource["kind"].as_str().unwrap_or("")) {
        return Ok(());
    }
    let id = resource["resourceId"].as_str().ok_or("Missing resource")?;
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    if resource["kind"] == "skill" && !db::get(db, &format!("installation:{id}"))?.is_null() {
        return Err("Skill installation recovery pending; local copies preserved".into());
    }
    let mut b = crate::repair::binding(db, resource, indexer::binding(db, id)?)?;
    if resource["kind"] == "skill" && b["mirrorReview"] == true {
        return Err(indexer::SKILL_MIRROR_REVIEW.into());
    }
    if project["governed"] == true
        && resource["kind"] == "skill"
        && resource["revision"].as_u64().unwrap_or(0) > 0
        && b["reviewedRevision"] != resource["revision"]
    {
        b = automatic_skill_binding(db, project, resource, b)?;
    }
    if project["governed"] == true
        && crate::governance::protected(resource)
        && b["reviewedRevision"] != resource["revision"]
    {
        b["availableRevision"] = resource["revision"].clone();
        b["installationState"] = json!(if b["base"]["revision"].is_null() {
            "review_pending"
        } else {
            "update_available"
        });
        return db::upsert(
            db,
            "bindings",
            id,
            project["id"].as_str().ok_or("Missing project")?,
            &b,
        );
    }
    if project["governed"] == true
        && resource["kind"] == "memory"
        && !crate::governance::protected(resource)
    {
        // Native learned memory belongs to this user. Shared imports have their own destinations.
        let destination = project_memory(project, resource)?.1;
        if b["paths"][0].as_str() != destination.to_str() {
            b["paths"] = Value::Null;
            b["writeGuard"] = Value::Null;
            b["guards"] = Value::Null;
            b["base"]["revision"] = json!(0);
        }
    }

    let kind = resource["kind"].as_str().ok_or("Missing kind")?;
    if kind == "plan" {
        crate::plans::validate(resource)?;
    }
    if kind == "skill" {
        packages::reject_env_files(resource["files"].as_array().ok_or("Missing files")?)?;
        if let Some(paths) = b["paths"].as_array() {
            for path in paths {
                let path = Path::new(path.as_str().ok_or("Invalid skill path")?);
                if path.exists() {
                    packages::check_skill_directory(path)?;
                }
            }
        }
    }
    if b["base"]["revision"] == resource["revision"] && b["base"]["deleted"] == resource["deleted"]
    {
        if kind == "skill" {
            crate::codex_skills::queue(db, project, false)?;
        }
        return db::upsert(db, "bindings", id, project_id, &b);
    }
    let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE json_extract(value,'$.resource.resourceId')=? OR json_extract(value,'$.resourceId')=?)",params![id,id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if pending || b["needsCopy"] == true {
        return Err("Local changes are queued; incoming version staged".into());
    }
    let has_conflict: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM conflicts WHERE json_extract(value,'$.resourceId')=?)",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if has_conflict {
        return Err("Session conflict: choose Keep, Override, or Create copy".into());
    }
    if crate::repair::deletion_complete(resource, &b)? {
        return crate::repair::settle_deletion(db, project, resource, b);
    }
    if kind == "session" && resource["source"] == "codex" && resource["deleted"] != true {
        // Sync keeps snapshots in Orka. Only an explicit launch creates native history.
        if b["nativeId"].is_string() {
            b["availableRevision"] = resource["revision"].clone();
        } else {
            crate::history::History::resource(resource)?;
            b["previous"] = b["base"].clone();
            b["base"] = resource.clone();
            b["paths"] = json!([]);
            b["guards"] = json!([]);
            b["managed"] = json!(true);
            b["installationState"] = json!("current");
            b["lastSeenHash"] = json!(indexer::manifest_hash(&resource["files"]));
            b["writeGuard"] = b["lastSeenHash"].clone();
        }
        return db::upsert(db, "bindings", id, project_id, &b);
    }
    if kind == "session" {
        if let Some(n) = b["nativeId"].as_str() {
            if native::active(db, n, resource["source"].as_str().ok_or("Missing tool")?) {
                return Err("Open session: incoming version staged".into());
            }
        }
    }
    if b["paths"].is_array() && !(kind == "memory" && resource["source"] == "codex") {
        let expected = b["writeGuard"].as_str().unwrap_or("");
        let base = indexer::manifest_hash(&b["base"]["files"]);
        if live_hash(
            &b,
            kind,
            Path::new(project["path"].as_str().ok_or("Connect a folder")?),
        )?
        .iter()
        .enumerate()
        .any(|(i, h)| h != b["guards"][i].as_str().unwrap_or(expected) && h != &base)
        {
            return Err("Files changed during sync; incoming version staged".into());
        }
    }
    let root = PathBuf::from(project["path"].as_str().ok_or("Connect a folder")?);
    if !root.is_dir() {
        return Err("Connected folder unavailable".into());
    }
    let previous = b["base"].clone();
    if resource["deleted"] == true {
        if kind == "skill" && project["governed"] == true {
            let paths = b["paths"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|p| {
                    p.as_str()
                        .map(PathBuf::from)
                        .ok_or("Invalid path".to_string())
                })
                .collect::<Result<Vec<_>>>()?;
            packages::install_mirrors(db, project, id, &paths, &[])?;
            for path in paths {
                fs::remove_dir(path).map_err(|e| e.to_string())?;
            }
        } else if kind == "session" && resource["source"] == "codex" {
            if let Some(n) = b["nativeId"].as_str() {
                native::Rpc::connect()?.call("thread/archive", json!({"threadId":n}))?;
            }
        } else if let Some(paths) = b["paths"].as_array() {
            for p in paths {
                let p = Path::new(p.as_str().ok_or("Invalid path")?);
                let base = if kind == "plan" {
                    crate::plans::path_base(
                        &root,
                        resource["source"].as_str().ok_or("Missing plan source")?,
                        p,
                    )?
                } else if p.starts_with(&root) {
                    root.clone()
                } else if resource["source"] == "claude" && kind == "memory" {
                    indexer::claude_memory(&root)?
                } else {
                    native::claude_home()?
                };
                packages::safe_directory(&base, p.parent().ok_or("Missing parent")?)?;
                if fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
                    return Err("Deletion target is a symlink".into());
                }
                if p.is_dir() {
                    fs::remove_dir_all(p).map_err(|e| e.to_string())?;
                } else if p.exists() {
                    fs::remove_file(p).map_err(|e| e.to_string())?;
                }
            }
        }
        b["base"] = resource.clone();
        b["lastSeenHash"] = json!(indexer::manifest_hash(&json!([])));
        b["writeGuard"] = b["lastSeenHash"].clone();
    } else if kind == "session" {
        b = native::materialize(db, project, resource, &b)?;
        let live = live_hash(
            &b,
            kind,
            Path::new(project["path"].as_str().ok_or("Connect a folder")?),
        )?;
        b["lastSeenHash"] = if resource["source"] == "codex" && crate::repair::archived(&b)? {
            json!(indexer::manifest_hash(&json!(
                crate::history::session_files(
                    "codex",
                    Path::new(b["paths"][0].as_str().ok_or("Missing import path")?),
                    Some(&root)
                )?
            )))
        } else {
            json!(live.first())
        };
        b["writeGuard"] = b["lastSeenHash"].clone();
    } else {
        let files = resource["files"].as_array().ok_or("Missing files")?;
        let paths = if kind == "skill" {
            let name =
                packages::safe_relative(resource["logicalPath"].as_str().ok_or("Missing path")?)?;
            if name.components().count() != 1 {
                return Err("Skill must have a single folder name".into());
            }
            let paths = vec![
                root.join(".agents/skills").join(&name),
                root.join(".claude/skills").join(&name),
            ];
            packages::install_mirrors(db, project, id, &paths, files)?;
            paths
        } else if kind == "plan" {
            let path = b["paths"][0]
                .as_str()
                .map(PathBuf::from)
                .unwrap_or(crate::plans::destination(&root, resource)?);
            let base = crate::plans::path_base(
                &root,
                resource["source"].as_str().ok_or("Missing plan source")?,
                &path,
            )?;
            fs::create_dir_all(&base).map_err(|e| e.to_string())?;
            packages::write_file(&base, &path, files.first().ok_or("Missing plan file")?)?;
            vec![path]
        } else {
            let (base, path) = if project["governed"] != true
                && b["paths"].is_array()
                && resource["source"] == "claude"
            {
                (
                    indexer::claude_memory(&root)?,
                    PathBuf::from(b["paths"][0].as_str().ok_or("Invalid memory path")?),
                )
            } else {
                project_memory(project, resource)?
            };
            fs::create_dir_all(&base).map_err(|e| e.to_string())?;
            packages::write_file(&base, &path, files.first().ok_or("Missing memory file")?)?;
            vec![path]
        };
        b["paths"] = json!(paths);
        b["base"] = resource.clone();
        b["writeGuard"] = json!(indexer::manifest_hash(&resource["files"]));
        if kind == "plan" || resource["source"] != "codex" || b["lastSeenHash"].is_null() {
            b["lastSeenHash"] = b["writeGuard"].clone();
        }
    }
    b["previous"] = previous;
    b["managed"] = json!(true);
    b["installationState"] = json!("current");
    if kind == "skill" {
        crate::codex_skills::queue(db, project, true)?;
    }
    b["guards"] = json!(live_hash(
        &b,
        kind,
        Path::new(project["path"].as_str().ok_or("Connect a folder")?)
    )?);
    db::upsert(db, "bindings", id, project_id, &b)?;
    if kind == "session" && resource["source"] == "codex" {
        if let Some(native_id) = b["nativeId"].as_str() {
            crate::codex_import::finish(db, native_id)?;
        }
    }
    Ok(())
}
pub(crate) fn progress(
    db: &rusqlite::Connection,
    label: &str,
    detail: Option<&str>,
    completed: usize,
    total: Option<usize>,
) -> Result<()> {
    db::set(
        db,
        "syncProgress",
        &json!({"label":label,"detail":detail,"completed":completed,"total":total}),
    )
}

pub fn current_progress(db: &rusqlite::Connection, running: bool) -> Result<Value> {
    if !running || !db::get(db, "user")?.is_string() {
        return Ok(Value::Null);
    }
    let current = db::get(db, "syncProgress")?;
    if !current.is_null() {
        return Ok(current);
    }
    let request = db::get(db, "syncRequest")?;
    if request.is_string() && request != db::get(db, "syncHandledRequest")? {
        return Ok(json!({"label":"Waiting for sync to start…"}));
    }
    Ok(Value::Null)
}

async fn pull(owner: &str, db: &mut rusqlite::Connection, project: &str, name: &str) -> Result<()> {
    let mut downloaded = 0;
    loop {
        progress(
            db,
            "Downloading updates",
            Some(&format!("{name} · {downloaded} updates received")),
            downloaded,
            None,
        )?;
        let cursor = db
            .query_row(
                "SELECT cursor FROM cursors WHERE project=?",
                [project],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0);
        let response = api_as(
            owner,
            "GET",
            &format!(
                "/v2/sync/pull?projectId={project}&cursor={cursor}&governance=1&policyRevision={}",
                db::get(db, &format!("policyRevision:{project}"))?
                    .as_i64()
                    .unwrap_or(-1)
            ),
            None,
        )
        .await?;
        if response["reset"] == true {
            // Drafts must commit before files are removed. Retain the cursor and
            // epoch until events commit, so interruption retries the refresh.
            crate::governance::reset(db, project, &response["events"])?;
        }
        // Persist the feed before fetching bytes. Each resource remains a durable
        // download retry even after the feed cursor advances past a missing blob.
        downloaded += response["events"]
            .as_array()
            .ok_or("Invalid event feed")?
            .len();
        let tx = db.transaction().map_err(|e| e.to_string())?;
        db::set(
            &tx,
            &format!("policyRevision:{project}"),
            &response["policyRevision"],
        )?;
        let requests = response
            .get("requests")
            .filter(|requests| !requests.is_null())
            .cloned()
            .unwrap_or_else(|| json!([]));
        db::set(&tx, &format!("requests:{project}"), &requests)?;
        crate::governance::reconcile_requests(&tx, project, &requests)?;
        for e in response["events"].as_array().ok_or("Invalid events")? {
            apply_event(&tx, e)?;
        }
        tx.execute("INSERT INTO cursors VALUES(?,?) ON CONFLICT(project) DO UPDATE SET cursor=excluded.cursor",params![project,response["cursor"].as_i64()]).map_err(|e|e.to_string())?;
        db::set(&tx, &format!("presence:{project}"), &response["presence"])?;
        tx.commit().map_err(|e| e.to_string())?;
        if response["hasMore"] != true {
            break;
        }
    }
    Ok(())
}
pub async fn once() -> Result<()> {
    cycle().await.map(|_| ())
}
pub(crate) async fn onboarding_once(scope: Option<(&str, &str)>) -> Result<()> {
    // The current onboarding job already owns its retry lock.
    match workspace_cycle(Ok(()), scope).await? {
        WorkspaceSync::Complete(_) => Ok(()),
        WorkspaceSync::Yielded => Err("A sync or project operation is in progress".into()),
    }
}

enum WorkspaceSync {
    Complete(bool),
    Yielded,
}

// Item failures retain retry backoff without reporting a connectivity failure.
async fn cycle() -> Result<bool> {
    let preparation = crate::onboarding::resume_pending_connections().await;
    // Only a service-wide failure should prevent unrelated projects from syncing.
    workspace_cycle(
        preparation.or_else(|error| {
            if service_error(&error) {
                Err(error)
            } else {
                Ok(())
            }
        }),
        None,
    )
    .await
    .map(|outcome| match outcome {
        WorkspaceSync::Complete(deferred) => deferred,
        WorkspaceSync::Yielded => true,
    })
}
async fn workspace_cycle(
    preparation: Result<()>,
    scope: Option<(&str, &str)>,
) -> Result<WorkspaceSync> {
    let _lock = crate::projects::lock()?;
    let mut db = db::open()?;
    let user = db::get(&db, "user")?;
    let owner = user.as_str().ok_or("Sign in required")?.to_string();
    if let Some((expected, service)) = scope {
        if owner != expected || db::get(&db, "config")?["apiUrl"] != service {
            return Err("Account or service changed. Reopen onboarding.".into());
        }
    }
    db::set(&db, "syncHandledRequest", &db::get(&db, "syncRequest")?)?;
    progress(&db, "Preparing sync", None, 0, None)?;
    let _ = crate::account_profile::flush_pending().await;
    let result = match preparation {
        Ok(()) => sync_workspace(&mut db, &owner).await,
        Err(error) => Err(error),
    };
    let previous = db::get(&db, "sync")?;
    let status = match &result {
        Ok(WorkspaceSync::Complete(_)) => json!({"online":true,"lastSync":db::now()}),
        Ok(WorkspaceSync::Yielded) => previous.clone(),
        Err(error) => json!({"online":false,"lastSync":previous["lastSync"],"error":error}),
    };
    let tx = db.transaction().map_err(|e| e.to_string())?;
    db::set(&tx, "sync", &status)?;
    db::set(&tx, "syncProgress", &Value::Null)?;
    tx.commit().map_err(|e| e.to_string())?;
    if !matches!(&result, Ok(WorkspaceSync::Yielded)) {
        let _ = crate::onboarding::reconcile_workspace_sync(
            &db,
            result.as_ref().err().map(String::as_str),
        );
    }
    result
}

async fn sync_workspace(db: &mut rusqlite::Connection, owner: &str) -> Result<WorkspaceSync> {
    if crate::projects::foreground_waiting()? {
        return Ok(WorkspaceSync::Yielded);
    }
    crate::repair::workspace(db)?;
    packages::recover_installations(db)?;
    let device = db::device(db)?;
    for mut b in db::rows(
        db,
        &format!("SELECT value FROM bindings WHERE json_extract(value,'$.needsCopy')=1 AND project IN (SELECT id FROM projects WHERE {})",crate::projects::ACTIVE),
        &[],
    )? {
        if b["copyRequest"].is_null() {
            let id = uuid::Uuid::new_v4().to_string();
            let r = b["base"].clone();
            let request = json!({"version":2,"id":id,"projectId":r["projectId"],"resourceId":r["resourceId"],"deviceId":device,"expectedRevision":r["revision"]});
            indexer::queue(
                db,
                r["projectId"].as_str().ok_or("Missing project")?,
                "/v2/sessions/copy",
                &request,
            )?;
            b["copyRequest"] = json!(id);
            db::upsert(
                db,
                "bindings",
                r["resourceId"].as_str().ok_or("Missing resource")?,
                r["projectId"].as_str().ok_or("Missing project")?,
                &b,
            )?;
        }
    }
    let local = db::rows(
        db,
        &format!(
            "SELECT value FROM projects WHERE {}",
            crate::projects::ACTIVE
        ),
        &[],
    )?;
    let prefix = crate::history::UNATTRIBUTED_SESSION_PREFIX;
    for source in db::rows(
        db,
        "SELECT json_quote(source) FROM errors WHERE source GLOB ?",
        &[&format!("{prefix}*")],
    )? {
        if let Some(path) = source
            .as_str()
            .and_then(|source| source.strip_prefix(prefix))
        {
            if std::fs::symlink_metadata(path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                db.execute("DELETE FROM errors WHERE source=?", [source.as_str()])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    for p in &local {
        if crate::projects::foreground_waiting()? {
            return Ok(WorkspaceSync::Yielded);
        }
        progress(
            db,
            "Checking local files",
            crate::projects::display_name(p),
            0,
            None,
        )?;
        let mut discovery = p.clone();
        discovery["deferAutomaticSharing"] = json!(true);
        match indexer::scan_with_progress(db, &discovery) {
            Ok(()) => {
                db::set(
                    db,
                    &format!("firstScan:{}", p["id"].as_str().unwrap_or("")),
                    &json!(db::now()),
                )?;
                db.execute("DELETE FROM errors WHERE source=?", [p["id"].as_str()])
                    .map_err(|e| e.to_string())?;
            }
            Err(error) => {
                db.execute("INSERT INTO errors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET error=excluded.error",params![p["id"].as_str(),error]).map_err(|e|e.to_string())?;
            }
        }
    }
    if crate::projects::foreground_waiting()? {
        return Ok(WorkspaceSync::Yielded);
    }
    progress(db, "Connecting to sync service", None, 0, None)?;
    let mut registration =
        json!({"id":device,"name":std::env::var("HOSTNAME").unwrap_or("Mac".into())});
    if api_as(owner, "GET", "/v2/projects/capabilities", None)
        .await
        .is_ok_and(|caps| caps["deviceHardware"] == 1)
    {
        registration["hardwareFamily"] = json!(crate::device_metadata::local_family(db)?);
    }
    api_as(owner, "POST", "/v2/devices", Some(&registration)).await?;
    let projects = api_as(owner, "GET", "/v2/projects?includeArchived=true", None).await?;
    crate::projects::merge_catalog(db, &projects)?;
    let local = db::rows(
        db,
        &format!(
            "SELECT value FROM projects WHERE {}",
            crate::projects::ACTIVE
        ),
        &[],
    )?;
    let mut blocked_projects = HashSet::new();
    for p in &local {
        if crate::projects::foreground_waiting()? {
            return Ok(WorkspaceSync::Yielded);
        }
        if p["governed"] == true {
            let id = p["id"].as_str().ok_or("Missing project")?;
            let result = async {
                let local = crate::governance::project(db, id)?;
                crate::governance::localize_outbox(db, &local)?;
                let catalog = api_as(
                    owner,
                    "POST",
                    "/v2/governance/action",
                    Some(&json!({"action":"catalog","input":{"projectId":id}})),
                )
                .await?;
                db::set(db, &format!("governance:{id}"), &catalog)?;
                crate::context_sharing::approve_own_pending(db, owner, &local, &catalog).await
            }
            .await;
            if result.as_ref().is_err_and(|e| service_error(e)) {
                return result.map(|_| WorkspaceSync::Complete(false));
            }
            if result.is_err() {
                blocked_projects.insert(id.to_string());
            }
            record_result(db, &format!("{id}:permissions"), result)?;
        }
    }
    let queued=db::rows(db,&format!("SELECT json_object('sequence',rowid,'id',id,'project',project,'path',path,'value',json(value),'error',error) FROM outbox WHERE project IN (SELECT id FROM projects WHERE {}) AND (error IS NULL OR error NOT GLOB '4[0-9][0-9]:*' OR substr(error,1,3) IN ('401','408','429')) ORDER BY rowid",crate::projects::ACTIVE),&[])?;
    let queued: Vec<_> = queued
        .into_iter()
        .filter(|q| {
            !blocked_projects.contains(q["project"].as_str().unwrap_or(""))
                && local.iter().any(|p| {
                    p["id"] == q["project"]
                        && (if q["path"] == crate::selective_sharing::QUEUE_PATH {
                            crate::selective_sharing::authorized(db, q).unwrap_or(false)
                        } else {
                            crate::projects::sharing_allowed(
                                p,
                                crate::projects::queued_kind(
                                    q["path"].as_str().unwrap_or(""),
                                    &q["value"],
                                ),
                            )
                        })
                })
        })
        .collect();
    let mut deferred: HashSet<_> = queued
        .iter()
        .filter(|q| {
            let error = q["error"].as_str().unwrap_or("");
            consolidation_pending(q, error) || error.starts_with("Local upload: ")
        })
        .map(|q| q["id"].clone())
        .collect();
    let cursor = db::get(db, "syncUploadCursor")?.as_i64().unwrap_or(0);
    let uploads = select_uploads(&queued, cursor);
    for (index, q) in uploads.iter().enumerate() {
        if crate::projects::foreground_waiting()? {
            return Ok(WorkspaceSync::Yielded);
        }
        let project_name = local
            .iter()
            .find(|p| p["id"] == q["project"])
            .and_then(|p| crate::projects::display_name(p));
        let input = &q["value"];
        let resource_name = input["resource"]["title"]
            .as_str()
            .or(input["resource"]["logicalPath"].as_str());
        let detail = [project_name, resource_name]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ");
        progress(
            db,
            "Uploading changes",
            Some(&detail),
            index,
            Some(uploads.len()),
        )?;
        let result = async {
            if q["path"] == crate::selective_sharing::QUEUE_PATH {
                return crate::selective_sharing::send(db, owner, q).await;
            }
            if input["resource"]["files"].is_array() {
                crate::repair::upload(
                    owner,
                    q["project"].as_str().ok_or("Missing project")?,
                    &input["resource"],
                )
                .await?;
            }
            if q["path"] == crate::global_skills::IMPORT_PATH
                || q["path"] == crate::context_sharing::QUEUE_PATH
            {
                return crate::context_sharing::share(db, owner, q).await;
            }
            api_as(
                owner,
                "POST",
                q["path"].as_str().ok_or("Missing upload path")?,
                Some(input),
            )
            .await
        }
        .await;
        match result {
            Ok(receipt) => {
                let tx = db.transaction().map_err(|e| e.to_string())?;
                if q["path"] == crate::selective_sharing::QUEUE_PATH {
                    crate::selective_sharing::complete(&tx, q, &receipt)?;
                } else if q["path"] == crate::global_skills::IMPORT_PATH
                    || q["path"] == crate::context_sharing::QUEUE_PATH
                {
                    crate::context_sharing::complete(&tx, q, &receipt)?;
                } else {
                    apply_event(&tx, &receipt["event"])?;
                }
                if input["resource"]["kind"] == "session"
                    && input["resource"]["deleted"] != true
                    && receipt["conflict"] == false
                {
                    let id = input["resource"]["resourceId"]
                        .as_str()
                        .ok_or("Missing resource")?;
                    let mut binding = indexer::binding(&tx, id)?;
                    if !binding["nativeId"].is_null() {
                        binding["previous"] = binding["base"].clone();
                        binding["base"] = receipt["event"]["resource"].clone();
                        db::upsert(
                            &tx,
                            "bindings",
                            id,
                            q["project"].as_str().ok_or("Missing project")?,
                            &binding,
                        )?;
                    }
                }
                if q["path"] == "/v2/sessions/copy"
                    || (q["path"] == "/v2/sessions/resolve" && input["action"] == "copy")
                {
                    let old = input["resourceId"]
                        .as_str()
                        .ok_or("Missing copied resource")?;
                    let mut b = indexer::binding(&tx, old)?;
                    if b["needsCopy"] == true || input["action"] == "copy" {
                        let r = &receipt["event"]["resource"];
                        b["base"] = r.clone();
                        b["needsCopy"] = json!(false);
                        b["copyRequest"] = Value::Null;
                        tx.execute("DELETE FROM bindings WHERE id=?", [old])
                            .map_err(|e| e.to_string())?;
                        db::upsert(
                            &tx,
                            "bindings",
                            r["resourceId"].as_str().ok_or("Missing copy")?,
                            q["project"].as_str().ok_or("Missing project")?,
                            &b,
                        )?;
                    }
                }
                tx.execute("DELETE FROM outbox WHERE id=?", [q["id"].as_str()])
                    .map_err(|e| e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
                deferred.remove(&q["id"]);
            }
            Err(error) => {
                db.execute(
                    "UPDATE outbox SET error=? WHERE id=?",
                    params![error, q["id"].as_str()],
                )
                .map_err(|e| e.to_string())?;
                if consolidation_pending(q, &error) || error.starts_with("Local upload: ") {
                    deferred.insert(q["id"].clone());
                } else if terminal_error(&error) {
                    deferred.remove(&q["id"]);
                } else {
                    return Err(error);
                }
            }
        }
        db::set(db, "syncUploadCursor", &q["sequence"])?;
        progress(
            db,
            "Uploading changes",
            Some(&detail),
            index + 1,
            Some(uploads.len()),
        )?;
    }
    for p in &local {
        if crate::projects::foreground_waiting()? {
            return Ok(WorkspaceSync::Yielded);
        }
        if blocked_projects.contains(p["id"].as_str().unwrap_or("")) {
            continue;
        }
        progress(
            db,
            "Checking for new local changes",
            crate::projects::display_name(p),
            0,
            None,
        )?;
        let project = p["id"].as_str().ok_or("Missing project")?;
        let mut discovery = p.clone();
        discovery["deferAutomaticSharing"] = json!(true);
        let scan = indexer::scan_with_progress(db, &discovery);
        let scanned = scan.is_ok();
        record_result(db, project, scan)?;
        // A failed project preflight must not run permission-reset filesystem
        // cleanup against an unavailable or replaced folder.
        if !scanned {
            continue;
        }
        if crate::projects::foreground_waiting()? {
            return Ok(WorkspaceSync::Yielded);
        }
        let result = pull(
            owner,
            db,
            project,
            crate::projects::display_name(p).unwrap_or("Project"),
        )
        .await;
        if result.as_ref().is_err_and(|e| service_error(e)) {
            return result.map(|_| WorkspaceSync::Complete(false));
        }
        let pulled = result.is_ok();
        record_result(db, &format!("{project}:pull"), result)?;
        if !pulled {
            continue;
        }
        // Prepare unsent context only after pending approvals and accepted
        // revisions have arrived; exact-base resources must not freeze early.
        record_result(
            db,
            &format!("{project}:sharing"),
            crate::context_sharing::queue_waiting(db, p),
        )?;
        if db::get(&db::open()?, "user")? != owner {
            return Err("Account changed; sync will restart with its own cache".into());
        }
        let resources = db::rows(
            db,
            "SELECT value FROM resources WHERE project=?",
            &[&project],
        )?;
        for (index, r) in resources.iter().enumerate() {
            if crate::projects::foreground_waiting()? {
                return Ok(WorkspaceSync::Yielded);
            }
            let detail = format!(
                "{} · {}",
                crate::projects::display_name(p).unwrap_or("Project"),
                r["title"]
                    .as_str()
                    .or(r["logicalPath"].as_str())
                    .unwrap_or("Update")
            );
            progress(
                db,
                "Applying updates on this Mac",
                Some(&detail),
                index,
                Some(resources.len()),
            )?;
            let id = r["resourceId"].as_str().ok_or("Missing resource")?;
            let result: Result<()> = async {
                download(owner, r).await?;
                for conflict in db::rows(db, "SELECT value FROM conflicts WHERE project=? AND json_extract(value,'$.resourceId')=?", &[&project, &id])? {
                    download(owner, &conflict["candidate"]).await?;
                }
                if crate::sources::for_resource(p, r).is_some() {
                    materialize(db, p, r)?;
                }
                Ok(())
            }.await;
            if result.as_ref().is_err_and(|e| service_error(e)) {
                return result.map(|_| WorkspaceSync::Complete(false));
            }
            record_result(db, id, result)?;
            progress(
                db,
                "Applying updates on this Mac",
                Some(&detail),
                index + 1,
                Some(resources.len()),
            )?;
        }
        progress(
            db,
            "Updating memory index",
            crate::projects::display_name(p),
            0,
            None,
        )?;
        record_result(
            db,
            &format!("{project}:memory-index"),
            indexer::memory_index(db, p),
        )?;
    }
    progress(db, "Finishing sync", None, 0, None)?;
    crate::codex_skills::retry(db)?;
    let devices = api_as(owner, "GET", "/v2/devices", None).await?;
    crate::device_metadata::update_devices(db, &devices)?;
    let has_errors: bool = db
        .query_row("SELECT EXISTS(SELECT 1 FROM errors)", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(WorkspaceSync::Complete(!deferred.is_empty() || has_errors))
}

pub(crate) fn record_result(
    db: &rusqlite::Connection,
    source: &str,
    result: Result<()>,
) -> Result<()> {
    match result {
        Ok(()) => db.execute("DELETE FROM errors WHERE source=?", [source]),
        Err(error) => db.execute(
            "INSERT INTO errors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET error=excluded.error",
            params![source, error],
        ),
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn service_error(error: &str) -> bool {
    let code = error
        .split_once(':')
        .and_then(|(code, _)| code.parse::<u16>().ok());
    matches!(code, Some(401 | 408 | 429 | 500..=599))
        || error == "Cloud unavailable; local work stays queued"
        || error == "Blob download failed"
        || error == "Blob upload failed; retry retained"
        || error == "Sign in required"
        || error == "Missing sign-in session"
        || error == "Session is invalid"
        || error.starts_with("Sync authentication: ")
        || error.ends_with(": Sync service returned an unreadable response")
        || error.starts_with("Account ")
        || error.starts_with("Service changed")
}

// Match only the packaged backend's resource-local MemoryUnavailable contract.
// General 503s, blob failures, auth failures and transport errors remain fatal.
fn consolidation_pending(queued: &Value, error: &str) -> bool {
    if !matches!(
        queued["path"].as_str(),
        Some(
            "/v2/sync/push"
                | crate::context_sharing::QUEUE_PATH
                | crate::selective_sharing::QUEUE_PATH
        )
    ) || queued["value"]["resource"]["kind"] != "memory"
    {
        return false;
    }
    let Some(reason) = error.strip_prefix("503: Memory consolidation pending: ") else {
        return false;
    };
    matches!(
        reason,
        "invalid_answers"
            | "jev_disabled"
            | "jev_missing_key"
            | "jev_context_limit"
            | "jev_network"
            | "jev_invalid_response"
            | "jev_invalid_answers"
            | "jev_invalid_probabilities"
            | "jev_uncertain"
    ) || reason
        .strip_prefix("jev_http_")
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|code| (100..=599).contains(&code))
}

fn select_uploads(queued: &[Value], cursor: i64) -> Vec<&Value> {
    let mut resources = HashSet::new();
    // A later operation must never overtake its resource's oldest eligible edit,
    // even when rotating the batch. Independent resources can keep progressing.
    let mut uploads: Vec<_> = queued
        .iter()
        .filter(|q| {
            let input = &q["value"];
            let resource = input["resource"]["resourceId"]
                .as_str()
                .or_else(|| input["resourceId"].as_str())
                .or_else(|| q["id"].as_str());
            resources.insert((q["project"].as_str(), resource))
        })
        .collect();
    let start = uploads.partition_point(|q| q["sequence"].as_i64().unwrap_or(0) <= cursor);
    uploads.rotate_left(start);
    uploads.truncate(100);
    uploads
}

pub fn terminal_error(error: &str) -> bool {
    let code = error
        .split_once(':')
        .and_then(|(s, _)| s.parse::<u16>().ok());
    matches!(code, Some(400..=499)) && !matches!(code, Some(401 | 408 | 429))
}
async fn heartbeat() -> Result<()> {
    if crate::projects::foreground_waiting()? {
        return Ok(());
    }
    let _lock = crate::projects::lock()?;
    let db = db::open()?;
    let user = db::get(&db, "user")?;
    let owner = user.as_str().ok_or("Sign in required")?;
    for p in db::rows(
        &db,
        &format!(
            "SELECT value FROM projects WHERE {}",
            crate::projects::ACTIVE
        ),
        &[],
    )? {
        if crate::projects::foreground_waiting()? {
            return Ok(());
        }
        let project = p["id"].as_str().ok_or("Missing project")?;
        let mut ids = Vec::new();
        if crate::projects::sharing_allowed(&p, "session") {
            for b in db::rows(&db,"SELECT value FROM bindings WHERE project=? AND json_extract(value,'$.base.kind')='session'",&[&project])?{if let Some(id)=b["nativeId"].as_str(){if native::active(&db,id,b["base"]["source"].as_str().unwrap_or("")){ids.push(b["base"]["resourceId"].clone());}}}
        }
        api_as(
            owner,
            "POST",
            "/v2/presence",
            Some(&json!({"projectId":project,"deviceId":db::device(&db)?,"sessions":ids})),
        )
        .await?;
    }
    Ok(())
}
pub(crate) fn foreground_enabled(db: &rusqlite::Connection) -> Result<bool> {
    let enabled = db::get(db, "background")?.as_bool().unwrap_or_else(|| {
        // First-run background registration is an explicit choice after sync.
        crate::onboarding::snapshot(db)
            .map(|v| v["active"] != true && crate::profiles::background_default())
            .unwrap_or(false)
    });
    Ok(!enabled && db::get(db, "backgroundHandoff")? != true)
}
pub fn start_foreground() {
    std::thread::spawn(|| {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return;
        };
        runtime.block_on(async {
            loop {
                if db::open()
                    .and_then(|db| foreground_enabled(&db))
                    .unwrap_or(false)
                {
                    run_mode(true).await;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    });
}
pub async fn run() {
    run_mode(false).await;
}
async fn run_mode(foreground: bool) {
    let Ok(lock) = db::daemon_lock() else { return };
    if lock.try_lock_exclusive().is_err() {
        return;
    }
    let executable_identity = db::executable_identity().unwrap_or_default();
    let mut next = Instant::now();
    let mut last_request = String::new();
    let mut last_user = String::new();
    let mut last_sync = Instant::now();
    let mut retry = 30;
    let mut beat = Instant::now();
    let mut network_poll = Instant::now();
    let mut network = String::new();
    loop {
        if !foreground && crate::updates::installation_pending() {
            return;
        }
        let Ok(db) = db::open() else {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };
        if foreground && !foreground_enabled(&db).unwrap_or(false) {
            // Release the shared daemon lock before the registered agent takes over.
            return;
        }
        let cfg = db::get(&db, "config").unwrap_or(json!({}));
        let interval =
            Duration::from_secs(cfg["syncMinutes"].as_u64().unwrap_or(15).clamp(1, 1440) * 60);
        let request = db::get(&db, "syncRequest")
            .unwrap_or(Value::Null)
            .as_str()
            .unwrap_or("")
            .to_string();
        let user = db::get(&db, "user")
            .unwrap_or(Value::Null)
            .as_str()
            .unwrap_or("")
            .to_string();
        let reconnect = if !user.is_empty() && Instant::now() >= network_poll {
            network_poll = Instant::now() + Duration::from_secs(10);
            let state = std::process::Command::new("/usr/sbin/scutil")
                .arg("--nwi")
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| db::digest(&o.stdout))
                .unwrap_or_default();
            let changed = !network.is_empty() && !state.is_empty() && network != state;
            network = state;
            changed
        } else {
            false
        };
        let requested = request != last_request || user != last_user || reconnect;
        let due = Instant::now() >= next || last_sync.elapsed() >= interval;
        db::set(
            &db,
            "daemon",
            &json!({"running":true,"heartbeat":db::now(),"executableIdentity":executable_identity}),
        )
        .ok();
        drop(db);
        let onboarding_active = db::open()
            .and_then(|db| crate::onboarding::snapshot(&db))
            .is_ok_and(|value| value["active"] == true);
        let onboarding_sync = crate::onboarding::sync_running().unwrap_or(false);
        if !onboarding_active && !onboarding_sync && !user.is_empty() && (requested || due) {
            last_request = request;
            last_user = user.clone();
            match cycle().await {
                Ok(false) => {
                    last_sync = Instant::now();
                    next = Instant::now() + interval;
                    retry = 30;
                }
                Ok(true) | Err(_) => {
                    next = Instant::now() + Duration::from_secs(retry);
                    retry = (retry * 2).min(interval.as_secs());
                    last_sync = Instant::now();
                }
            }
        }
        if !onboarding_active && !user.is_empty() && Instant::now() >= beat {
            let _ = heartbeat().await;
            beat = Instant::now() + Duration::from_secs(60);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[cfg(test)]
mod queue_tests {
    use super::*;

    fn queued(sequence: i64, resource: &str) -> Value {
        json!({"sequence":sequence,"id":format!("request-{sequence}"),"project":"project","path":"/v2/sync/push","value":{"resource":{"resourceId":resource,"kind":"memory"}}})
    }

    #[test]
    fn only_known_memory_consolidation_failures_are_deferred() {
        let memory = queued(1, "memory");
        for path in [
            "/v2/sync/push",
            crate::context_sharing::QUEUE_PATH,
            crate::selective_sharing::QUEUE_PATH,
        ] {
            let mut shared = memory.clone();
            shared["path"] = json!(path);
            assert!(
                consolidation_pending(
                    &shared,
                    "503: Memory consolidation pending: jev_missing_key"
                ),
                "{path}"
            );
        }
        for reason in [
            "jev_uncertain",
            "jev_http_503",
            "jev_network",
            "invalid_answers",
        ] {
            assert!(consolidation_pending(
                &memory,
                &format!("503: Memory consolidation pending: {reason}")
            ));
        }
        for error in [
            "503: Service unavailable",
            "503: Blob upload rejected",
            "401: Sign in required",
            "429: Rate limited",
            "Cloud unavailable; local work stays queued",
            "503: Memory consolidation pending: unknown_reason",
            "503: Memory consolidation pending: jev_http_invalid",
        ] {
            assert!(!consolidation_pending(&memory, error), "{error}");
        }
        let mut other = memory.clone();
        other["value"]["resource"]["kind"] = json!("skill");
        assert!(!consolidation_pending(
            &other,
            "503: Memory consolidation pending: jev_uncertain"
        ));
        other = memory;
        other["path"] = json!("/v2/sessions/resolve");
        assert!(!consolidation_pending(
            &other,
            "503: Memory consolidation pending: jev_uncertain"
        ));
    }

    #[test]
    fn capped_batches_rotate_past_pending_rows_and_missing_cursor_rows() {
        let mut queue: Vec<_> = (1..=101)
            .map(|sequence| queued(sequence, &format!("memory-{sequence}")))
            .collect();
        let first = select_uploads(&queue, 0);
        assert_eq!(first.len(), 100);
        let cursor = first.last().unwrap()["sequence"].as_i64().unwrap();
        assert_eq!(cursor, 100);
        assert_eq!(select_uploads(&queue, cursor)[0]["sequence"], 101);
        // The stored cursor still works after its successful row is deleted or
        // after a process restart. New rows and wrapped older rows remain fair.
        queue.retain(|q| q["sequence"] != cursor);
        let next = select_uploads(&queue, cursor);
        assert_eq!(next.len(), 100);
        assert_eq!(next[0]["sequence"], 101);
        assert_eq!(next[1]["sequence"], 1);
        assert_eq!(select_uploads(&queue, 1000)[0]["sequence"], 1);
    }

    #[test]
    fn rotated_batches_do_not_overtake_a_pending_resource() {
        let mut later = queued(3, "blocked");
        later["path"] = json!("/v2/sessions/resolve");
        later["value"] = json!({"resourceId":"blocked"});
        let queue = vec![queued(1, "blocked"), queued(2, "independent"), later];
        let batch = select_uploads(&queue, 1);
        assert_eq!(
            batch
                .iter()
                .map(|q| q["sequence"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![2, 1]
        );
    }
}
