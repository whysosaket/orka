use crate::{
    codex_import,
    db::{self, Result},
    history, indexer, native, sync,
};
use serde_json::{json, Value};
use std::{fs, path::Path};

pub fn workspace(db: &rusqlite::Connection) -> Result<()> {
    for project in db::rows(
        db,
        &format!(
            "SELECT value FROM projects WHERE {}",
            crate::projects::ACTIVE
        ),
        &[],
    )?
    .iter()
    .flat_map(crate::sources::views)
    {
        let Some(root) = project["path"].as_str().map(Path::new) else {
            continue;
        };
        if !root.is_dir()
            || project["folderIdentity"].as_str().is_some_and(|expected| {
                indexer::folder_identity(root).map_or(true, |actual| actual != expected)
            })
        {
            continue;
        }
        let project_id = project["id"].as_str().ok_or("Missing project")?;
        let resources = db::rows(
            db,
            "SELECT value FROM resources WHERE project=?",
            &[&project_id],
        )?;
        for (index, resource) in resources.iter().enumerate() {
            if !crate::sources::matches(&project, resource) {
                continue;
            }
            sync::progress(
                db,
                "Repairing local sync state",
                project["name"].as_str(),
                index,
                Some(resources.len()),
            )?;
            let id = resource["resourceId"].as_str().ok_or("Missing resource")?;
            let result = recover(db, &project, resource);
            match result {
                Ok(true) => sync::record_result(db, id, Ok(()))?,
                Ok(false) => (),
                Err(error) => {
                    sync::record_result(db, id, Err(error))?;
                }
            }
        }
    }
    Ok(())
}

fn recover(db: &rusqlite::Connection, project: &Value, resource: &Value) -> Result<bool> {
    let id = resource["resourceId"].as_str().ok_or("Missing resource")?;
    if !crate::projects::sharing_allowed(project, resource["kind"].as_str().unwrap_or("")) {
        return Ok(false);
    }
    let mut b = binding(db, resource, indexer::binding(db, id)?)?;
    let pending: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE json_extract(value,'$.resource.resourceId')=? OR json_extract(value,'$.resourceId')=?) OR EXISTS(SELECT 1 FROM conflicts WHERE json_extract(value,'$.resourceId')=?)", [id,id,id], |r|r.get(0)).map_err(|e|e.to_string())?;
    if pending || b["needsCopy"] == true || !db::get(db, &format!("installation:{id}"))?.is_null() {
        return Ok(false);
    }
    if deletion_complete(resource, &b)? {
        settle_deletion(db, project, resource, b)?;
        return Ok(true);
    }
    if resource["kind"] != "session" || resource["source"] != "codex" || !b["nativeId"].is_null() {
        return Ok(false);
    }
    let key = codex_import::import_key(project, resource)?;
    let mut attempt = db::get(db, &key)?;
    if attempt["completed"] != true {
        return Ok(false);
    }
    let native_id = attempt["child"]["id"]
        .as_str()
        .ok_or("Missing completed import identity")?;
    let path = history::current_path(
        Path::new(
            attempt["child"]["path"]
                .as_str()
                .ok_or("Missing completed import path")?,
        ),
        native_id,
    )?;
    if !path.starts_with(native::codex_home()?.join("archived_sessions")) {
        return Ok(false);
    }
    history::History::local(&path, project["path"].as_str().map(Path::new))?;
    let hash = db::digest(&fs::read(&path).map_err(|e| e.to_string())?);
    if attempt["guard"] != hash {
        return Err("Archived import contains local edits; original history preserved".into());
    }
    let files = history::session_files("codex", &path, project["path"].as_str().map(Path::new))?;
    b = json!({"nativeId":native_id,"paths":[path],"base":resource,"managed":true,"lastSeenHash":indexer::manifest_hash(&json!(files)),"guards":[indexer::manifest_hash(&json!([]))],"writeGuard":indexer::manifest_hash(&json!(files))});
    attempt["child"]["path"] = json!(path);
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    db::set(&tx, &key, &attempt)?;
    db::upsert(
        &tx,
        "bindings",
        id,
        project["id"].as_str().ok_or("Missing project")?,
        &b,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

pub fn settle_deletion(
    db: &rusqlite::Connection,
    project: &Value,
    resource: &Value,
    mut binding: Value,
) -> Result<()> {
    binding["base"] = resource.clone();
    if !binding["paths"].is_array() {
        binding["paths"] = json!([]);
    }
    let empty = indexer::manifest_hash(&json!([]));
    binding["lastSeenHash"] = json!(empty);
    binding["writeGuard"] = json!(empty);
    binding["guards"] = json!(vec![empty; binding["paths"].as_array().map_or(0, Vec::len)]);
    db::upsert(
        db,
        "bindings",
        resource["resourceId"].as_str().ok_or("Missing resource")?,
        project["id"].as_str().ok_or("Missing project")?,
        &binding,
    )
}

pub fn binding(db: &rusqlite::Connection, resource: &Value, mut binding: Value) -> Result<Value> {
    if resource["kind"] == "session" && resource["source"] == "codex" {
        if let (Some(id), Some(path)) = (binding["nativeId"].as_str(), binding["paths"][0].as_str())
        {
            if Path::new(path).try_exists().map_err(|e| e.to_string())? {
                return Ok(binding);
            }
            let resolved = history::current_path(Path::new(path), id)?;
            if resolved != Path::new(path) {
                binding["paths"][0] = json!(resolved);
                db::upsert(
                    db,
                    "bindings",
                    resource["resourceId"].as_str().ok_or("Missing resource")?,
                    resource["projectId"].as_str().ok_or("Missing project")?,
                    &binding,
                )?;
            }
        }
    }
    Ok(binding)
}

pub fn archived(binding: &Value) -> Result<bool> {
    let archive = native::codex_home()?.join("archived_sessions");
    Ok(binding["nativeId"].is_string()
        && binding["paths"][0]
            .as_str()
            .is_some_and(|path| Path::new(path).starts_with(&archive)))
}

pub fn deletion_complete(resource: &Value, binding: &Value) -> Result<bool> {
    if resource["deleted"] != true {
        return Ok(false);
    }
    let Some(paths) = binding["paths"].as_array() else {
        return Ok(binding["nativeId"].is_null());
    };
    if paths.is_empty() && binding["nativeId"].is_string() {
        return Ok(false);
    }
    if resource["source"] == "codex" && resource["kind"] == "session" && archived(binding)? {
        return Ok(true);
    }
    for path in paths {
        match fs::symlink_metadata(path.as_str().ok_or("Invalid binding path")?) {
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(true)
}

pub async fn upload(owner: &str, project: &str, resource: &Value) -> Result<()> {
    let files = resource["files"]
        .as_array()
        .ok_or("Local upload: missing files")?;
    match sync::upload(owner, project, files).await {
        Err(original) if original.starts_with("Local upload: ") => {
            let mut resource = resource.clone();
            resource["projectId"] = json!(project);
            match sync::download(owner, &resource).await {
                Ok(()) => sync::upload(owner, project, files).await,
                Err(error) if sync::service_error(&error) => Err(error),
                Err(error) => Err(format!("{original}; cloud repair unavailable: {error}")),
            }
        }
        result => result,
    }
}
