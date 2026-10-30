use super::{
    crypto::MAX_BYTES,
    dotenv::{self, Entry},
};
use crate::{
    db::{self, Result},
    packages,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
};
use zeroize::Zeroizing;

pub fn read_text(path: &Path) -> Result<Zeroizing<String>> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "Cannot read ENV file")?;
    if !file
        .metadata()
        .map_err(|_| "Cannot inspect ENV file")?
        .is_file()
    {
        return Err("Choose a regular ENV file".into());
    }
    let mut content = Zeroizing::new(String::new());
    file.take((MAX_BYTES + 1) as u64)
        .read_to_string(&mut content)
        .map_err(|_| "ENV file must be readable UTF-8 text")?;
    if content.len() > MAX_BYTES {
        return Err("ENV file exceeds 1 MB".into());
    }
    Ok(content)
}
fn git(root: &Path, args: &[&str]) -> Result<std::process::Output> {
    let mut command = Command::new("git");
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("GIT_") {
            command.env_remove(name);
        }
    }
    command
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|_| "Git is required to protect the ENV file".into())
}
pub fn target(root: &Path, relative: &str) -> Result<PathBuf> {
    let rel = packages::safe_relative(relative)?;
    let name = rel
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid ENV filename")?;
    if !(name == ".env" || name.starts_with(".env."))
        || rel.components().any(|c| {
            matches!(
                c.as_os_str()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .as_str(),
                ".git" | ".orka" | ".agents" | ".claude" | ".codex"
            )
        })
    {
        return Err("Choose a .env or .env.* file outside tool and skill folders".into());
    }
    if fs::symlink_metadata(root)
        .map_err(|_| "Connected project folder unavailable")?
        .file_type()
        .is_symlink()
    {
        return Err("Project folder is a symlink".into());
    }
    let canonical = root
        .canonicalize()
        .map_err(|_| "Connected project folder unavailable")?;
    let destination = canonical.join(&rel);
    let mut path = canonical;
    for component in rel.components() {
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("ENV paths cannot contain symlinks".into())
            }
            Ok(meta) if path != destination && !meta.is_dir() => {
                return Err("ENV parent is not a directory".into())
            }
            Ok(meta) if path == destination && !meta.is_file() => {
                return Err("ENV destination must be a regular file".into())
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && path == destination => (),
            Err(_) => return Err("Choose an existing destination folder".into()),
        }
    }
    if !git(root, &["rev-parse", "--is-inside-work-tree"])?
        .status
        .success()
    {
        return Err("Connect a Git project before applying ENVs".into());
    }
    let tracked = git(
        root,
        &[
            "--literal-pathspecs",
            "ls-files",
            "--error-unmatch",
            "--",
            relative,
        ],
    )?;
    if tracked.status.success() {
        return Err("This ENV file is tracked by Git. Untrack it before applying secrets".into());
    }
    if tracked.status.code() != Some(1) {
        return Err("Cannot verify Git tracking status".into());
    }
    Ok(path)
}
pub fn ignored(root: &Path, relative: &str) -> Result<bool> {
    let output = git(root, &["check-ignore", "--quiet", "--", relative])?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err("Cannot verify Git ignore rules".into()),
    }
}
pub fn exclude(root: &Path, relative: &str) -> Result<()> {
    target(root, relative)?;
    let output = git(
        root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
        ],
    )?;
    if !output.status.success() {
        return Err("Cannot locate the local Git exclude file".into());
    }
    let path = PathBuf::from(
        String::from_utf8(output.stdout)
            .map_err(|_| "Invalid Git path")?
            .trim_end_matches(['\r', '\n']),
    );
    let prefix = git(root, &["rev-parse", "--show-prefix"])?;
    if !prefix.status.success() {
        return Err("Cannot locate the Git project root".into());
    }
    let pattern = format!(
        "{}{}",
        String::from_utf8(prefix.stdout)
            .map_err(|_| "Invalid Git path")?
            .trim_end_matches(['\r', '\n']),
        relative
    );
    let mut escaped = String::from("/");
    for c in pattern.chars() {
        if matches!(c, '\\' | '*' | '?' | '[' | ']' | '#' | '!' | ' ') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "Cannot update the local Git exclude file")?;
    file.write_all(format!("\n# Orka local ENV file\n{escaped}\n").as_bytes())
        .map_err(|_| "Cannot update the local Git exclude file")?;
    if !ignored(root, relative)? {
        return Err(
            "A Git ignore rule overrides this exclusion. Update it before applying ENVs".into(),
        );
    }
    Ok(())
}
pub fn content(path: &Path) -> Result<Option<Zeroizing<String>>> {
    match fs::symlink_metadata(path) {
        Ok(_) => read_text(path).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot inspect ENV destination".into()),
    }
}
pub fn fingerprint(content: &Option<Zeroizing<String>>) -> String {
    content
        .as_ref()
        .map(|s| db::digest(s.as_bytes()))
        .unwrap_or_else(|| "missing".into())
}
pub fn preview(root: &Path, relative: &str, entries: &[Entry]) -> Result<Value> {
    let path = target(root, relative)?;
    let original = content(&path)?;
    let document = dotenv::parse(original.as_ref().map(|s| s.to_string()).unwrap_or_default())?;
    Ok(
        json!({"path":relative,"fingerprint":fingerprint(&original),"ignored":ignored(root, relative)?,
        "keys":entries.iter().map(|e| {
            let old = document.assignments.iter().find(|a| a.entry.key == e.key);
            json!({"key":e.key,"change":match old { None => "added", Some(a) if a.entry.literal == e.literal => "unchanged", _ => "changed" }})
        }).collect::<Vec<_>>() }),
    )
}
pub fn apply(root: &Path, relative: &str, expected: &str, entries: &[Entry]) -> Result<()> {
    use fs2::FileExt;
    let lock_root = db::root()?;
    fs::create_dir_all(&lock_root).map_err(|_| "Cannot lock ENV destination")?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(lock_root.join("env-apply.lock"))
        .map_err(|_| "Cannot lock ENV destination")?;
    lock.lock_exclusive()
        .map_err(|_| "Cannot lock ENV destination")?;
    let path = target(root, relative)?;
    if !ignored(root, relative)? {
        return Err("Exclude this ENV file from Git before applying".into());
    }
    let original = content(&path)?;
    if fingerprint(&original) != expected {
        return Err("Local ENV file changed. Review a new preview before applying".into());
    }
    let document = dotenv::parse(original.as_ref().map(|s| s.to_string()).unwrap_or_default())?;
    let merged = dotenv::merge(&document, entries)?;
    let parent = path.parent().ok_or("Invalid ENV destination")?;
    // Stage inside Git's administrative directory so a concurrent `git add .`
    // cannot capture plaintext under a temporary, unignored filename.
    let git_dir = git(root, &["rev-parse", "--absolute-git-dir"])?;
    if !git_dir.status.success() {
        return Err("Cannot locate a safe ENV staging directory".into());
    }
    let staging = PathBuf::from(
        String::from_utf8(git_dir.stdout)
            .map_err(|_| "Invalid Git directory")?
            .trim_end_matches(['\r', '\n']),
    );
    let metadata =
        fs::symlink_metadata(&staging).map_err(|_| "Cannot inspect ENV staging directory")?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.dev()
            != fs::metadata(parent)
                .map_err(|_| "Cannot inspect ENV destination")?
                .dev()
    {
        return Err(
            "Git and the ENV destination must be on the same filesystem for a safe atomic write"
                .into(),
        );
    }
    let mut staged = tempfile::Builder::new()
        .prefix("orka-env-")
        .tempfile_in(&staging)
        .map_err(|_| "Cannot prepare ENV file")?;
    staged
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "Cannot protect ENV file")?;
    staged
        .write_all(merged.as_bytes())
        .map_err(|_| "Cannot write ENV file")?;
    staged
        .as_file()
        .sync_all()
        .map_err(|_| "Cannot save ENV file")?;
    target(root, relative)?;
    if fingerprint(&content(&path)?) != expected {
        return Err("Local ENV file changed. Review a new preview before applying".into());
    }
    staged
        .persist(&path)
        .map_err(|_| "Cannot install ENV file")?;
    fs::File::open(staging)
        .and_then(|f| f.sync_all())
        .map_err(|_| "Cannot finish saving ENV file")?;
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|_| "Cannot finish saving ENV file")?;
    Ok(())
}
