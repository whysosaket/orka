use crate::db::{self, Result};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Component, Path, PathBuf},
};
use walkdir::WalkDir;
pub fn is_env_path(raw: &str) -> bool {
    raw.split(['/', '\\']).any(|part| {
        let name = part.to_ascii_lowercase();
        name == ".env" || name.starts_with(".env.") || name.ends_with(".env")
    })
}
pub fn reject_env_files(files: &[Value]) -> Result<()> {
    if files
        .iter()
        .any(|f| f["path"].as_str().is_some_and(is_env_path))
    {
        return Err(env_file_error());
    }
    Ok(())
}
pub fn check_skill_directory(path: &Path) -> Result<()> {
    for entry in WalkDir::new(path).follow_links(false) {
        let e = entry.map_err(|_| "Cannot inspect skill folder")?;
        if e.file_type().is_symlink() {
            return Err("Package contains symlink".into());
        }
        let relative = e
            .path()
            .strip_prefix(path)
            .map_err(|_| "Unsafe skill folder")?;
        if is_env_path(&relative.to_string_lossy()) {
            return Err(env_file_error());
        }
    }
    Ok(())
}
pub fn safe_relative(raw: &str) -> Result<PathBuf> {
    let p = Path::new(raw);
    if raw.is_empty()
        || raw.contains('\\')
        || raw.chars().any(char::is_control)
        || p.is_absolute()
        || p.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Unsafe relative path".into());
    }
    Ok(p.into())
}
pub fn safe_directory(base: &Path, target: &Path) -> Result<()> {
    if fs::symlink_metadata(base).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Root is a symlink".into());
    }
    let rel = target.strip_prefix(base).map_err(|_| "Path escapes root")?;
    let mut current = base.to_path_buf();
    for c in rel.components() {
        if !matches!(c, Component::Normal(_)) {
            return Err("Unsafe directory".into());
        }
        current.push(c);
        match fs::symlink_metadata(&current) {
            Ok(m) if m.file_type().is_symlink() || !m.is_dir() => {
                return Err("Directory contains symlink or file".into())
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|e| e.to_string())?
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
pub fn file(path: &Path, name: &str) -> Result<Value> {
    if is_env_path(name) {
        return Err(env_file_error());
    }
    if fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Symlinked files are excluded".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .map_err(|e| e.to_string())?
            .permissions()
            .mode()
            & 0o111
            != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    Ok(json!({"path":name,"hash":db::blob(&bytes)?,"size":bytes.len(),"executable":executable}))
}

fn env_file_error() -> String {
    if crate::env::enabled() {
        "Skill sharing paused: move ENV files into an encrypted ENV set. Local files are preserved."
    } else {
        "Secret files cannot be included in shared content. Local files are preserved."
    }
    .into()
}
pub fn directory(path: &Path) -> Result<Vec<Value>> {
    // Inspect the complete package before any file reaches the general blob cache.
    check_skill_directory(path)?;
    if fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Symlinked packages are excluded".into());
    }
    let mut files = Vec::new();
    let mut total = 0;
    for entry in WalkDir::new(path).follow_links(false) {
        let e = entry.map_err(|e| e.to_string())?;
        if e.file_type().is_symlink() {
            return Err("Package contains symlink".into());
        }
        if !e.file_type().is_file() {
            continue;
        }
        let rel = e
            .path()
            .strip_prefix(path)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        safe_relative(&rel)?;
        let f = file(e.path(), &rel)?;
        total += f["size"].as_u64().unwrap_or(0);
        if files.len() >= 200 || total > 4_000_000 || f["size"].as_u64().unwrap_or(0) > 1_000_000 {
            return Err("Skill exceeds size limits".into());
        }
        files.push(f);
    }
    files.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    if !files.iter().any(|f| f["path"] == "SKILL.md") {
        return Err("Skill is missing SKILL.md".into());
    }
    Ok(files)
}
pub fn write_file(base: &Path, path: &Path, file: &Value) -> Result<()> {
    safe_directory(base, path.parent().ok_or("No parent")?)?;
    let bytes = db::blob_read(file["hash"].as_str().ok_or("Missing hash")?)?;
    if bytes.len() as u64 != file["size"].as_u64().ok_or("Missing size")? {
        return Err("File size mismatch".into());
    }
    db::atomic(path, &bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if file["executable"] == true {
                0o755
            } else {
                0o644
            }),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn install(base: &Path, destination: &Path, files: &[Value]) -> Result<()> {
    reject_env_files(files)?;
    if destination.exists() {
        check_skill_directory(destination)?;
    }
    safe_directory(base, destination.parent().ok_or("No parent")?)?;
    if fs::symlink_metadata(destination).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Destination is a symlink".into());
    }
    let parent = destination.parent().ok_or("No parent")?;
    let staged = tempfile::Builder::new()
        .prefix(".orka-stage-")
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    for f in files {
        let target = staged.path().join(safe_relative(
            f["path"].as_str().ok_or("Missing file path")?,
        )?);
        write_file(staged.path(), &target, f)?;
    }
    if destination.exists() {
        #[cfg(target_os = "macos")]
        {
            use std::{ffi::CString, os::unix::ffi::OsStrExt};
            let from =
                CString::new(staged.path().as_os_str().as_bytes()).map_err(|e| e.to_string())?;
            let to = CString::new(destination.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
            // APFS swaps the directories atomically; a crash cannot leave the skill absent.
            if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_SWAP) } != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            return Err("Native skill installation requires macOS".into());
        }
    } else {
        fs::rename(staged.path(), destination).map_err(|e| e.to_string())?;
    }
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn install_mirrors(
    db: &rusqlite::Connection,
    project: &Value,
    id: &str,
    paths: &[PathBuf],
    files: &[Value],
) -> Result<()> {
    let root = Path::new(project["path"].as_str().ok_or("Connect a folder")?);
    let mut originals = Vec::new();
    // Validate both destinations before the first swap, and retain recovery data durably.
    for path in paths {
        safe_directory(root, path.parent().ok_or("Missing parent")?)?;
        let previous = if path.exists() {
            json!(installed_files(path)?)
        } else {
            Value::Null
        };
        originals.push(json!({"path":path,"files":previous}));
    }
    let key = format!("installation:{id}");
    let journal = json!({"project":project,"resourceId":id,"originals":originals,"desired":files});
    db::set(db, &key, &journal)?;
    for path in paths {
        if let Err(error) = install(root, path, files) {
            recover_installation(db, &key, &journal)?;
            return Err(error);
        }
    }
    db::set(db, &key, &Value::Null)?;
    crate::codex_skills::queue(db, project, true)
}
fn installed_files(path: &Path) -> Result<Vec<Value>> {
    // An empty directory is the atomic staging state for a reviewed removal.
    if fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .next()
        .is_none()
    {
        return Ok(vec![]);
    }
    directory(path)
}

fn recover_installation(db: &rusqlite::Connection, key: &str, journal: &Value) -> Result<()> {
    let project = &journal["project"];
    let root = Path::new(
        project["path"]
            .as_str()
            .ok_or("Missing installation root")?,
    );
    for original in journal["originals"]
        .as_array()
        .ok_or("Invalid installation recovery")?
    {
        let path = Path::new(
            original["path"]
                .as_str()
                .ok_or("Missing installation path")?,
        );
        safe_directory(root, path.parent().ok_or("Missing parent")?)?;
        if path.exists() {
            let current = json!(installed_files(path)?);
            if current != original["files"] && current != journal["desired"] {
                let mut resource = crate::governance::resource(
                    db,
                    journal["resourceId"].as_str().ok_or("Missing resource")?,
                )?;
                resource["files"] = current;
                crate::governance::capture(db, project, &resource, &json!([path]))?;
            }
        }
        if let Some(files) = original["files"].as_array() {
            install(root, path, files)?;
        } else if path.exists() {
            fs::remove_dir_all(path).map_err(|e| e.to_string())?;
        }
    }
    db::set(db, key, &Value::Null)
}

fn recover_current_installation(
    db: &rusqlite::Connection,
    key: &str,
    journal: &Value,
) -> Result<()> {
    let project = crate::governance::project(
        db,
        journal["project"]["id"]
            .as_str()
            .ok_or("Missing installation project")?,
    )?;
    let source = crate::sources::for_resource(&project, &journal["project"])
        .ok_or("409: Installation source is removed or disconnected; original recovery journal and local files preserved for review")?;
    crate::sources::validate(&source)?;
    if source["path"] != journal["project"]["path"]
        || source["folderIdentity"] != journal["project"]["folderIdentity"]
    {
        return Err("409: Installation folder changed; original recovery journal and local files preserved for review".into());
    }
    recover_installation(db, key, journal)
}

pub fn recover_installations(db: &rusqlite::Connection) -> Result<()> {
    for row in db::rows(db,"SELECT json_object('key',key,'journal',json(value)) FROM meta WHERE key LIKE 'installation:%' AND value!='null'",&[])? {
        let key = row["key"].as_str().ok_or("Invalid installation key")?;
        let result = recover_current_installation(db, key, &row["journal"]);
        let project = row["journal"]["project"]["id"].as_str().ok_or("Missing installation project")?;
        crate::sync::record_result(db, &format!("{project}:{key}"), result)?;
    }
    Ok(())
}

pub(crate) fn recover_project_installations(
    db: &rusqlite::Connection,
    project: &Value,
) -> Result<()> {
    let id = project["id"].as_str().ok_or("Missing project")?;
    for row in db::rows(db, "SELECT json_object('key',key,'journal',json(value)) FROM meta WHERE key LIKE 'installation:%' AND value!='null' AND json_extract(value,'$.project.id')=?", &[&id])? {
        let journal = &row["journal"];
        let key = row["key"].as_str().ok_or("Invalid installation key")?;
        let result = recover_current_installation(db, key, journal);
        crate::sync::record_result(db, &format!("{id}:{key}"), result)?;
    }
    Ok(())
}
