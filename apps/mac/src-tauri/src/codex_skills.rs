use crate::{
    db::{self, Result},
    native,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;

pub fn queue(db: &Connection, project: &Value, changed: bool) -> Result<()> {
    let root = Path::new(project["path"].as_str().ok_or("Connect a folder")?);
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let key = format!(
        "codex-skill-refresh:{project_id}:{}",
        db::digest(root.to_string_lossy().as_bytes())
    );
    if changed || db::get(db, &key)?.is_null() {
        db::set(
            db,
            &key,
            &json!({"projectId":project_id,"path":root,"pending":true}),
        )?;
    }
    Ok(())
}

pub fn refresh(db: &Connection) -> Result<()> {
    let pending = db::rows(db, "SELECT json_object('key',key,'projectId',json_extract(value,'$.projectId'),'path',json_extract(value,'$.path')) FROM meta WHERE key LIKE 'codex-skill-refresh:%' AND json_extract(value,'$.pending')=1", &[])?;
    if pending.is_empty() || native::binary("codex").is_err() || !native::codex_home()?.is_dir() {
        return Ok(());
    }
    let paths: Vec<_> = pending.iter().map(|item| item["path"].clone()).collect();
    // Prefer the running app-server through Rpc::connect, so its catalogue is
    // invalidated too. Older servers rely on their normal filesystem discovery.
    native::Rpc::connect()?
        .call_optional("skills/list", json!({"cwds":paths,"forceReload":true}))?;
    for item in pending {
        db::set(
            db,
            item["key"].as_str().ok_or("Missing refresh key")?,
            &json!({"projectId":item["projectId"],"path":item["path"],"pending":false}),
        )?;
    }
    Ok(())
}

pub fn retry(db: &Connection) -> Result<()> {
    let projects = db::rows(db, "SELECT DISTINCT json_quote(json_extract(value,'$.projectId')) FROM meta WHERE key LIKE 'codex-skill-refresh:%' AND json_extract(value,'$.pending')=1", &[])?;
    let result = refresh(db).map_err(|error| format!("Codex skill refresh pending: {error}"));
    for project in projects {
        let id = project.as_str().ok_or("Missing refresh project")?;
        crate::sync::record_result(db, &format!("{id}:codex-skills"), result.clone())?;
    }
    Ok(())
}
