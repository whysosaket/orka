use crate::db::{self, Result};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{fs, path::PathBuf, process::Command, sync::OnceLock};

static CURRENT: OnceLock<String> = OnceLock::new();

pub fn validate(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 48
        || !name.as_bytes()[0].is_ascii_lowercase()
        || !name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(
            "Use 1–48 lowercase letters, numbers or hyphens, starting with a letter".into(),
        );
    }
    Ok(())
}

pub fn initialize(args: &mut Vec<String>) -> Result<()> {
    let mut selected = None;
    let mut index = 1;
    while index < args.len() {
        if args[index] == "--profile" {
            if selected.is_some() || index + 1 == args.len() {
                return Err("Pass --profile followed by one profile name".into());
            }
            args.remove(index);
            selected = Some(args.remove(index));
        } else {
            index += 1;
        }
    }
    let name = selected
        .or_else(|| std::env::var("ORKA_PROFILE").ok())
        .unwrap_or_else(|| "default".into());
    validate(&name)?;
    CURRENT
        .set(name)
        .map_err(|_| "Profile is already selected".into())
}

pub fn current() -> &'static str {
    CURRENT.get().map(String::as_str).unwrap_or("default")
}

pub fn root(name: &str) -> Result<PathBuf> {
    validate(name)?;
    let base = db::base_root()?;
    Ok(if name == "default" {
        base
    } else {
        base.join("profiles").join(name)
    })
}

fn prepare(name: &str) -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let path = root(name)?;
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Profile directory cannot be a symlink".into());
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn label() -> String {
    if current() == "default" {
        "com.orka.v1".into()
    } else {
        format!("com.orka.v1.profile.{}", current())
    }
}

pub fn credential_service() -> Result<String> {
    #[cfg(debug_assertions)]
    if current() == "default" && std::env::var_os("ORKA_TEST_HOME").is_some() {
        return Ok(format!(
            "com.orka.v1.test.{}",
            db::digest(db::root()?.to_string_lossy().as_bytes())
        ));
    }
    let isolated = current() != "default"
        || cfg!(debug_assertions) && std::env::var_os("ORKA_TEST_HOME").is_some();
    Ok(if isolated {
        format!(
            "com.orka.v1.profile.{}",
            db::digest(db::root()?.to_string_lossy().as_bytes())
        )
    } else {
        "com.orka.v1".into()
    })
}

pub fn background_default() -> bool {
    current() == "default"
}

pub fn instance_lock(name: &str) -> Result<fs::File> {
    let path = prepare(name)?.join("ui.lock");
    fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())
}

pub fn acquire_instance() -> Result<Option<fs::File>> {
    let lock = instance_lock(current())?;
    match lock.try_lock_exclusive() {
        Ok(()) => Ok(Some(lock)),
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            db::atomic(&root(current())?.join("focus"), b"")?;
            Ok(None)
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn profile_list() -> Result<Value> {
    let mut names = vec!["default".to_string()];
    let directory = db::base_root()?.join("profiles");
    if directory.exists() {
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if validate(&name).is_ok() && entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                names.push(name);
            }
        }
    }
    names.push(current().into());
    names.sort();
    names.dedup();
    Ok(json!({"current":current(),"names":names}))
}

#[tauri::command]
pub fn open_profile(name: String) -> Result<()> {
    let lock = instance_lock(&name)?;
    match lock.try_lock_exclusive() {
        Ok(()) => {
            FileExt::unlock(&lock).map_err(|e| e.to_string())?;
            let mut child = Command::new(crate::updates::executable().map_err(|e| e.to_string())?)
                .args(["--profile", &name])
                .spawn()
                .map_err(|e| e.to_string())?;
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            db::atomic(&root(&name)?.join("focus"), b"")
        }
        Err(e) => Err(e.to_string()),
    }
}

// The OS may deliver an OAuth callback to any running copy of the app.
// Queue it for its original profile; only that profile has the PKCE verifier.
#[tauri::command]
pub fn route_auth_callback(callback: String) -> Result<()> {
    let name = queue_callback(&callback)?;
    if name != current() {
        open_profile(name)?;
    }
    Ok(())
}

fn callback_lock(root: &std::path::Path) -> Result<fs::File> {
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("auth-callback.lock"))
        .map_err(|e| e.to_string())?;
    FileExt::lock_exclusive(&file).map_err(|e| e.to_string())?;
    Ok(file)
}

pub fn queue_callback(callback: &str) -> Result<String> {
    let name = crate::auth::callback_profile(callback)?;
    let root = root(&name)?;
    if !root.is_dir() {
        return Err("The window that requested this sign-in is unavailable".into());
    }
    let _lock = callback_lock(&root)?;
    db::atomic(
        &root.join("auth-callback.json"),
        &serde_json::to_vec(
            &json!({"url":callback,"expiresAt":chrono::Utc::now().timestamp()+600}),
        )
        .map_err(|e| e.to_string())?,
    )?;
    Ok(name)
}

pub fn take_callback() -> Result<Option<String>> {
    let _lock = callback_lock(&db::root()?)?;
    let path = db::root()?.join("auth-callback.json");
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    fs::remove_file(path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    Ok(
        if value["expiresAt"].as_i64().unwrap_or(0) >= chrono::Utc::now().timestamp() {
            value["url"].as_str().map(str::to_string)
        } else {
            None
        },
    )
}

#[tauri::command]
pub fn profile_events(app: tauri::AppHandle) -> Result<Option<String>> {
    use tauri::Manager;
    let focus = db::root()?.join("focus");
    let callback = take_callback()?;
    if focus.exists() || callback.is_some() {
        let _ = fs::remove_file(focus);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    Ok(callback)
}

#[cfg(test)]
mod tests {
    #[test]
    fn profile_names_cannot_escape_storage_or_arguments() {
        for name in ["default", "alice", "wt-feature-123"] {
            assert!(super::validate(name).is_ok());
        }
        for name in [
            "",
            "..",
            "../alice",
            "/tmp/alice",
            "ALICE",
            "-flag",
            "a b",
            "a.b",
            &"a".repeat(49),
        ] {
            assert!(super::validate(name).is_err(), "{name}");
        }
    }
}
