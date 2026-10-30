use crate::{
    db::{self, Result},
    native, packages, session_translation,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub fn materialize(
    db: &Connection,
    project: &Value,
    resource: &Value,
    old: &Value,
    records: &[Value],
) -> Result<(String, PathBuf)> {
    let root = Path::new(project["path"].as_str().ok_or("Connect a folder")?);
    let home = native::claude_home()?;
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let name = root
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>();
    let destination = home.join("projects").join(name);
    packages::safe_directory(&home, &destination)?;
    let key = format!(
        "claudeImport:{}:{}:{}:{}",
        project["id"].as_str().ok_or("Missing project")?,
        resource["resourceId"].as_str().ok_or("Missing resource")?,
        resource["revision"],
        db::digest(resource["files"].to_string().as_bytes())
    );
    let mut attempt = db::get(db, &key)?;
    if attempt.is_null() {
        attempt = json!({"id":Uuid::new_v4().to_string()});
        db::set(db, &key, &attempt)?;
    }
    let id = attempt["id"]
        .as_str()
        .ok_or("Missing Claude import identity")?;
    let path = destination.join(format!("{id}.jsonl"));
    let bytes = native::encode(&session_translation::relocate_claude(records, id, root)?);
    if path.try_exists().map_err(|e| e.to_string())? {
        if native::active(db, id, "claude") {
            return Err("Partially imported Claude session is open; retry after it closes".into());
        }
        let info = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !info.is_file() || info.file_type().is_symlink() {
            return Err("Claude import destination must be a regular file".into());
        }
        if fs::read(&path).map_err(|e| e.to_string())? != bytes {
            return Err(
                "Partially imported Claude session changed; local history preserved".into(),
            );
        }
    } else {
        let mut staged =
            tempfile::NamedTempFile::new_in(&destination).map_err(|e| e.to_string())?;
        staged.write_all(&bytes).map_err(|e| e.to_string())?;
        staged.as_file().sync_all().map_err(|e| e.to_string())?;
        staged.persist_noclobber(&path).map_err(|e| e.to_string())?;
    }
    if let Some(p) = old["paths"]
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_str)
    {
        if Path::new(p) != path && Path::new(p).exists() {
            let archive = home.join("orka-archived");
            packages::safe_directory(&home, &archive)?;
            fs::rename(
                p,
                archive.join(format!(
                    "{}.jsonl",
                    old["nativeId"].as_str().ok_or("Missing old native ID")?
                )),
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok((id.to_owned(), path))
}
