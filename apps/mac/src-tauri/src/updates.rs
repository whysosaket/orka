use crate::db::Result;
use serde_json::{json, Value};
use std::{path::PathBuf, process::Command};

pub fn executable() -> std::io::Result<PathBuf> {
    let executable = std::env::current_exe()?;
    if executable
        .file_name()
        .is_some_and(|name| name == "orka-desktop")
    {
        Ok(executable.with_file_name("portable-workspace-mac"))
    } else {
        Ok(executable)
    }
}

fn bundled_app() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    if executable.file_name()? != "orka-desktop" {
        return None;
    }
    let app = executable.ancestors().nth(3)?;
    (app.extension()? == "app").then(|| app.to_path_buf())
}

fn state_dir() -> Option<PathBuf> {
    let app = bundled_app()?.canonicalize().ok()?;
    Some(
        dirs::data_local_dir()?
            .join("com.orka.updates")
            .join(crate::db::digest(app.to_str()?.as_bytes())),
    )
}

pub fn initialize() {
    // The launcher passes its flock across exec. Keep it out of subprocesses.
    if let Some(fd) = std::env::var("ORKA_UPDATE_LOCK")
        .ok()
        .and_then(|fd| fd.parse::<i32>().ok())
        .filter(|fd| *fd >= 3)
    {
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
}

pub fn installation_pending() -> bool {
    use fs2::FileExt;
    state_dir()
        .and_then(|dir| std::fs::File::open(dir.join("maintenance.lock")).ok())
        .is_some_and(|file| {
            FileExt::try_lock_shared(&file)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::WouldBlock)
        })
}

fn mark(kind: &str) {
    let Some(directory) = state_dir() else { return };
    let Ok(session) = std::env::var("ORKA_UPDATE_SESSION") else {
        return;
    };
    if uuid::Uuid::parse_str(&session).is_ok() && session.len() == 36 {
        let _ = crate::db::atomic(&directory.join(format!("{session}.{kind}")), b"");
    }
}

pub fn clean_exit() {
    mark("clean");
}

#[tauri::command]
pub fn update_ready() {
    mark("ready");
}

#[tauri::command]
pub async fn update_status(app: tauri::AppHandle) -> Result<Value> {
    let installed = app.package_info().version.to_string();
    if bundled_app().is_none() {
        return Ok(
            json!({ "installedVersion": installed, "message": "Updates are unavailable for this build." }),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new(executable().map_err(|error| error.to_string())?)
            .arg("--orka-update-status")
            .output()
            .map_err(|error| error.to_string())?;
        serde_json::from_slice(&output.stdout)
            .map_err(|_| "Couldn’t read Orka’s update status.".into())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn update_install(version: String, sha256: String) -> Result<()> {
    bundled_app().ok_or("Updates are unavailable for this build.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = Command::new(executable().map_err(|error| error.to_string())?)
            .args([
                "--orka-install-update",
                &version,
                &sha256,
                crate::profiles::current(),
            ])
            .output()
            .map_err(|error| error.to_string())?;
        if result.status.success() {
            Ok(())
        } else {
            let message = String::from_utf8_lossy(&result.stderr);
            let message = message.trim();
            Err(if message.is_empty() {
                "Couldn’t install the update. Try again.".into()
            } else {
                message.into()
            })
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn open_update_changelog(version: String) -> Result<()> {
    let valid_part = |part: &str| {
        !part.is_empty()
            && part.len() <= 9
            && part.bytes().all(|byte| byte.is_ascii_digit())
            && (part.len() == 1 || !part.starts_with('0'))
    };
    if version.matches('.').count() != 2 || !version.split('.').all(valid_part) {
        return Err("Invalid desktop release version.".into());
    }
    let status = Command::new("/usr/bin/open")
        .arg(format!(
            "https://github.com/whysosaket/orka/releases/tag/v{version}"
        ))
        .status()
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err("Couldn’t open the changelog in your browser.".into());
    }
    Ok(())
}
