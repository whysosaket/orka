use crate::db::Result;
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::Emitter;

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

pub struct LaunchGuard {
    _running: Option<File>,
}

pub(crate) fn launch_locks(directory: &Path) -> std::io::Result<Option<(File, File)>> {
    use fs2::FileExt;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)?;
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    let lock = |name| {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(directory.join(name))
    };
    let maintenance = lock("maintenance.lock")?;
    match FileExt::try_lock_shared(&maintenance) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(None),
        Err(error) => return Err(error),
    }
    let running = lock("running.lock")?;
    FileExt::try_lock_shared(&running)?;
    Ok(Some((maintenance, running)))
}

pub fn initialize(args: &mut Vec<String>) -> Result<Option<LaunchGuard>> {
    if bundled_app().is_none() {
        return Ok(Some(LaunchGuard { _running: None }));
    }
    let launcher = executable().map_err(|error| error.to_string())?;
    // Only the running UI may invoke the updater with the desktop as its parent.
    if args
        .get(1)
        .is_some_and(|argument| argument == "--orka-install-update")
    {
        return Err("Approve this update from the Orka sidebar.".into());
    }
    if args.get(1).is_some_and(|argument| {
        ["--orka-update-status", "--orka-builtin-recovery"].contains(&argument.as_str())
    }) {
        let status = Command::new(launcher)
            .args(&args[1..])
            .status()
            .map_err(|error| error.to_string())?;
        std::process::exit(status.code().unwrap_or(1));
    }
    let directory = state_dir().ok_or("Application data unavailable")?;
    let Some((maintenance, running)) =
        launch_locks(&directory).map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let headless = args.get(1).is_some_and(|argument| {
        [
            "--orka-agent",
            "--orka-plugin",
            "--orka-sync",
            "--orka-hook",
            "--orka-context",
            "--orka-env-test",
            "--orka-test",
        ]
        .contains(&argument.as_str())
    });
    let session = if headless {
        "headless".into()
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    let bypass = args.iter().any(|argument| argument == "--orka-try-launch");
    let status = Command::new(launcher)
        .args([
            "--orka-launch-preflight",
            &std::process::id().to_string(),
            &session,
            if bypass { "1" } else { "0" },
        ])
        .stdin(Stdio::null())
        .status()
        .map_err(|error| error.to_string())?;
    match status.code() {
        Some(0) => {}
        Some(2) => return Ok(None),
        _ => return Err("Couldn’t check whether Orka can start.".into()),
    }
    // The native executable retains its identity and runtime lock; no GUI exec handoff.
    drop(maintenance);
    args.retain(|argument| argument != "--orka-try-launch");
    if !headless {
        std::env::set_var("ORKA_UPDATE_SESSION", session);
    }
    Ok(Some(LaunchGuard {
        _running: Some(running),
    }))
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
pub async fn update_status(app: tauri::AppHandle, manual: Option<bool>) -> Result<Value> {
    let installed = app.package_info().version.to_string();
    if bundled_app().is_none() {
        return Ok(
            json!({ "installedVersion": installed, "supported": false, "message": "Updates are unavailable for this build." }),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(executable().map_err(|error| error.to_string())?);
        command.arg("--orka-update-status");
        if manual.unwrap_or(false) {
            command.arg("--fresh");
        }
        let output = command.output().map_err(|error| error.to_string())?;
        serde_json::from_slice(&output.stdout)
            .map_err(|_| "Couldn’t read Orka’s update status.".into())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, version: String, sha256: String) -> Result<()> {
    bundled_app().ok_or("Updates are unavailable for this build.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new(executable().map_err(|error| error.to_string())?)
            .args([
                "--orka-install-update",
                &version,
                &sha256,
                crate::profiles::current(),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?;
        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines() {
                let line = line.map_err(|error| error.to_string())?;
                if let Ok(progress) = serde_json::from_str::<Value>(&line) {
                    let _ = app.emit_to("main", "desktop-update-progress", progress);
                }
            }
        }
        let result = child
            .wait_with_output()
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
