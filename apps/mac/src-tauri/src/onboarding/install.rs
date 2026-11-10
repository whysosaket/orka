use crate::db::{self, Result};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Command,
};

pub fn classify(path: &Path, home: &Path) -> (bool, Option<&'static str>) {
    let s = path.to_string_lossy();
    if s.contains("/AppTranslocation/") {
        return (false, Some("translocated"));
    }
    if path.starts_with("/Volumes") {
        return (false, Some("dmg"));
    }
    let valid = [PathBuf::from("/Applications"), home.join("Applications")]
        .iter()
        .any(|root| {
            path.strip_prefix(root).is_ok_and(|p| {
                p.components()
                    .next()
                    .is_some_and(|c| c.as_os_str().to_string_lossy().ends_with(".app"))
            })
        });
    (valid, if valid { None } else { Some("other") })
}
pub fn location() -> Result<Value> {
    let path = crate::updates::executable().map_err(|e| e.to_string())?;
    let (ok, reason) = classify(&path, &db::home()?);
    let skip = cfg!(debug_assertions)
        || std::env::var_os("ORKA_TEST_HOME").is_some()
        || crate::profiles::current() != "default";
    let name = path
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .and_then(|p| p.file_name())
        .unwrap_or(std::ffi::OsStr::new("Orka.app"));
    let installed = [
        PathBuf::from("/Applications").join(name),
        db::home()?.join("Applications").join(name),
    ]
    .into_iter()
    .find(|p| p.is_dir());
    Ok(json!({"ok":ok || skip,"path":path,"reason":reason,"installedCopy":installed}))
}
pub fn open_settings(kind: &str) -> Result<Value> {
    let url = match kind {
        "login" => "x-apple.systempreferences:com.apple.LoginItems-Settings.extension",
        "privacy" => "x-apple.systempreferences:com.apple.preference.security?Privacy",
        "claude" => "https://code.claude.com/docs/en/overview",
        "codex" => "https://developers.openai.com/codex/cli/",
        _ => return Err("Unknown setup destination".into()),
    };
    if !Command::new("/usr/bin/open")
        .arg(url)
        .status()
        .map_err(|e| e.to_string())?
        .success()
    {
        return Err("Couldn’t open this page. Open System Settings from the Apple menu.".into());
    }
    Ok(json!({"ok":true}))
}
