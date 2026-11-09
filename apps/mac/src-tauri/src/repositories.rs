use crate::{
    db::{self, Result},
    projects, sources, sync,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::io::AsyncReadExt;
use uuid::Uuid;
use zeroize::Zeroizing;

static JOBS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
mod access;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Context {
    user: String,
    service: String,
}
impl Context {
    fn check(&self) -> Result<()> {
        let db = db::open()?;
        if db::get(&db, "user")? != self.user || db::get(&db, "config")?["apiUrl"] != self.service {
            return Err("Account or service changed; reopen repository setup".into());
        }
        Ok(())
    }
    fn database(&self) -> Result<rusqlite::Connection> {
        db::open_at(&db::profile_path(&self.user, &self.service)?)
    }
    async fn api(&self, action: &str, input: Value) -> Result<Value> {
        self.check()?;
        let result = sync::api_at(
            &self.user,
            &self.service,
            "POST",
            "/v2/github/action",
            Some(&json!({"action":action,"input":input})),
        )
        .await?;
        self.check()?;
        Ok(result)
    }
}

pub(crate) fn verify_remote(root: &Path, expected: &str) -> Result<()> {
    let normalized =
        crate::onboarding::discovery::normalize_remote(expected).ok_or("Invalid repository URL")?;
    let key = db::digest(format!("orka-remote-v1:{normalized}").as_bytes());
    if crate::onboarding::discovery::remote_key(root.to_str().ok_or("Invalid checkout path")?)?
        .as_deref()
        != Some(key.as_str())
    {
        return Err("This folder's Git remote does not match the linked repository. Choose the correct checkout in Source folders.".into());
    }
    Ok(())
}
fn clone_url(value: &str) -> Result<()> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid clone URL")?;
    let parts: Vec<_> = url.path().trim_start_matches('/').split('/').collect();
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || parts.len() != 2
        || !parts[1].ends_with(".git")
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
    {
        return Err("Choose a GitHub.com HTTPS repository".into());
    }
    Ok(())
}
fn source(context: &Context, project: &str, id: &str) -> Result<Value> {
    let db = context.database()?;
    let project = crate::governance::project(&db, project)?;
    project["sources"]
        .as_array()
        .and_then(|items| items.iter().find(|item| item["id"] == id))
        .cloned()
        .ok_or("Source no longer belongs to this project".into())
}
fn save(context: &Context, job: &Value) -> Result<()> {
    db::set(
        &context.database()?,
        &format!(
            "repository-job:{}",
            job["id"].as_str().ok_or("Missing clone job")?
        ),
        job,
    )
}
fn active(id: &str) -> bool {
    JOBS.lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(id)
}
fn list(context: &Context) -> Result<Value> {
    let db = context.database()?;
    let mut jobs = db::rows(&db, "SELECT value FROM meta WHERE key LIKE 'repository-job:%' ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 100", &[])?;
    for job in &mut jobs {
        if matches!(
            job["state"].as_str(),
            Some("queued" | "cloning" | "connecting")
        ) && !active(job["id"].as_str().unwrap_or(""))
        {
            job["state"] = json!("interrupted");
            job["message"] = json!(
                "Clone interrupted. Retry connecting a completed checkout, or start a new clone."
            );
            save(context, job)?;
        }
    }
    Ok(json!(jobs))
}

fn git_command() -> tokio::process::Command {
    let mut command = tokio::process::Command::new("/usr/bin/git");
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .args([
            "-c",
            "credential.helper=",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            "protocol.file.allow=never",
            "-c",
            "http.followRedirects=false",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

fn checkout_needs_setup(root: &Path) -> bool {
    if root.join(".gitmodules").symlink_metadata().is_ok() {
        return true;
    }
    let entries = walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| entry.file_name() != ".git");
    for (index, entry) in entries.enumerate() {
        if index >= 20_000 {
            return true;
        }
        let Ok(entry) = entry else {
            return true;
        };
        if entry.file_name() != ".gitattributes" {
            continue;
        }
        if !entry.file_type().is_file()
            || entry
                .metadata()
                .map_or(true, |metadata| metadata.len() > 65_536)
        {
            return true;
        }
        match fs::read_to_string(entry.path()) {
            Ok(attributes) if !attributes.contains("filter=lfs") => {}
            _ => return true,
        }
    }
    false
}

#[cfg(unix)]
fn move_checkout(from: &Path, to: &Path) -> Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let from = CString::new(from.as_os_str().as_bytes()).map_err(|_| "Invalid clone path")?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(|_| "Invalid clone path")?;
    #[cfg(target_os = "macos")]
    let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let result = -1;
    if result != 0 {
        return Err(
            "Destination already exists or cannot be created. Choose another location.".into(),
        );
    }
    Ok(())
}
#[cfg(not(unix))]
fn move_checkout(_from: &Path, _to: &Path) -> Result<()> {
    Err("Cloning is not supported on this platform".into())
}

async fn run_git(
    mut command: tokio::process::Command,
    canceled: Arc<AtomicBool>,
    context: Option<&Context>,
    mut progress: impl FnMut(u8),
) -> Result<()> {
    let mut child = command.spawn().map_err(|_| {
        "Git is unavailable. Install Git or Apple's Command Line Tools, then try again."
    })?;
    let mut stderr = child.stderr.take().ok_or("Cannot read Git progress")?;
    let deadline = Instant::now() + Duration::from_secs(1800);
    let mut next_scope_check = Instant::now();
    let mut stop = || {
        let now = Instant::now();
        if canceled.load(Ordering::Relaxed) || now > deadline {
            return true;
        }
        if now >= next_scope_check {
            next_scope_check = now + Duration::from_millis(150);
            return context.is_some_and(|scope| scope.check().is_err());
        }
        false
    };
    let mut buffer = [0u8; 2048];
    loop {
        if stop() {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("Clone canceled, timed out, or the account/service changed".into());
        }
        tokio::select! {
            read = stderr.read(&mut buffer) => {
                let size = read.map_err(|_| "Cannot read Git progress")?;
                if size == 0 { break; }
                let output = String::from_utf8_lossy(&buffer[..size]);
                for part in output.split('%').rev().skip(1) {
                    let number: String = part.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<String>().chars().rev().collect();
                    if let Ok(percent) = number.parse::<u8>() { if percent <= 100 { progress(percent); break; } }
                }
            },
            _ = tokio::time::sleep(Duration::from_millis(150)) => {}
        }
    }
    let status = loop {
        if stop() {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("Clone canceled, timed out, or the account/service changed".into());
        }
        tokio::select! {
            status = child.wait() => break status.map_err(|_| "Cannot finish Git clone")?,
            _ = tokio::time::sleep(Duration::from_millis(150)) => {}
        }
    };
    if canceled.load(Ordering::Relaxed) || context.is_some_and(|scope| scope.check().is_err()) {
        return Err("Clone canceled or the account/service changed".into());
    }
    if !status.success() {
        return Err("Git clone failed. Check repository access, Git installation, disk space and folder permissions, then retry.".into());
    }
    Ok(())
}

async fn attach(context: &Context, job: &Value) -> Result<()> {
    let project = job["projectId"].as_str().ok_or("Missing project")?;
    let source_id = job["sourceId"].as_str().ok_or("Missing source")?;
    let current = context
        .api("access", json!({"projectId":project,"sourceId":source_id}))
        .await?;
    if current["state"] != "ready"
        || current["repository"]["id"] != job["repositoryId"]
        || current["bindingRevision"] != job["bindingRevision"]
    {
        return Err(
            "Repository link or GitHub access changed. Review this source before connecting."
                .into(),
        );
    }
    let catalog =
        sync::api_at(&context.user, &context.service, "GET", "/v2/projects", None).await?;
    {
        let _lock = projects::lock()?;
        context.check()?;
        projects::merge_catalog(&context.database()?, &catalog)?;
    }
    let path = job["destination"]
        .as_str()
        .ok_or("Missing clone destination")?;
    if !crate::indexer::folder_identity_matches(
        Path::new(path),
        job["folderIdentity"]
            .as_str()
            .ok_or("Clone did not finish; start a new clone")?,
    )? {
        return Err("Cloned folder was replaced; locate and verify it again".into());
    }
    sources::connect_sources(
        project.into(),
        vec![path.into()],
        Some(source_id.into()),
        Some((&context.user, &context.service)),
    )
    .await
}

async fn clone_job(context: Context, mut job: Value, canceled: Arc<AtomicBool>) {
    let result: Result<()> = async {
        let project = job["projectId"].as_str().ok_or("Missing project")?.to_owned();
        let source_id = job["sourceId"].as_str().ok_or("Missing source")?.to_owned();
        let mut response = context.api("clone-credentials", json!({"projectId":project,"sourceId":source_id})).await?;
        let token = Zeroizing::new(response["token"].as_str().ok_or("Connect GitHub before cloning")?.to_owned());
        response.as_object_mut().ok_or("Invalid clone response")?.remove("token");
        let url = response["repository"]["cloneUrl"].as_str().ok_or("Missing clone URL")?;
        clone_url(url)?;
        if response["repository"]["id"] != job["repositoryId"] || response["bindingRevision"] != job["bindingRevision"] { return Err("Repository link changed. Refresh before cloning.".into()); }
        let destination = PathBuf::from(job["destination"].as_str().ok_or("Missing destination")?);
        if destination.symlink_metadata().is_ok() { return Err("Destination already exists; locate it or choose another folder".into()); }
        let stage = tempfile::Builder::new().prefix(".orka-clone-").tempdir_in(destination.parent().ok_or("Missing parent folder")?).map_err(|_| "Cannot create the clone directory; check folder permissions")?;
        let checkout = stage.path().join("checkout");
        let askpass = stage.path().join("askpass");
        fs::write(&askpass, "#!/bin/sh\ncase \"$1\" in\n*Username*) printf '%s\\n' x-access-token ;;\n*Password*) printf '%s\\n' \"$ORKA_GITHUB_CLONE_TOKEN\" ;;\n*) exit 1 ;;\nesac\n").map_err(|_| "Cannot prepare Git authentication")?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&askpass, fs::Permissions::from_mode(0o700)).map_err(|_| "Cannot prepare Git authentication")?; }
        let mut command = git_command();
        command.env("GIT_ASKPASS", &askpass).env("ORKA_GITHUB_CLONE_TOKEN", token.as_str()).args(["clone", "--progress", "--", url]).arg(&checkout);
        job["state"] = json!("cloning"); save(&context, &job)?;
        let mut updated = Instant::now();
        run_git(command, canceled.clone(), Some(&context), |percent| {
            if updated.elapsed() > Duration::from_millis(250) { job["message"] = json!(format!("Git transfer: {percent}%")); let _ = save(&context, &job); updated = Instant::now(); }
        }).await?;
        drop(token);
        context.check()?;
        if canceled.load(Ordering::Relaxed) { return Err("Clone canceled".into()); }
        verify_remote(&checkout, url)?;
        let incomplete = checkout_needs_setup(&checkout);
        move_checkout(&checkout, &destination)?;
        job["folderIdentity"] = json!(crate::indexer::folder_identity(&destination)?);
        {
            let _jobs = JOBS.lock().unwrap_or_else(|e| e.into_inner());
            if canceled.load(Ordering::Relaxed) { return Err("Clone canceled; the completed checkout was preserved".into()); }
            job["state"] = json!("connecting");
            job["message"] = json!("Clone complete; connecting this source"); save(&context, &job)?;
        }
        attach(&context, &job).await?;
        job["state"] = json!("connected");
        job["message"] = json!(if incomplete { "Connected. Review submodule or Git LFS setup before using this checkout." } else { "Cloned and connected" });
        Ok(())
    }.await;
    if let Err(error) = result {
        job["state"] = json!(if canceled.load(Ordering::Relaxed) {
            "canceled"
        } else {
            "failed"
        });
        job["message"] = json!(error);
    }
    let _ = save(&context, &job);
    JOBS.lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(job["id"].as_str().unwrap_or(""));
}

#[tauri::command]
pub async fn repository_command(action: String, input: Value, context: Context) -> Result<Value> {
    context.check()?;
    if action == "capabilities" {
        return sync::api_at(&context.user, &context.service, "GET", "/v2/instance", None)
            .await
            .map(|value| json!({"enabled":value["repositories"]["github"]==1}));
    }
    if action == "jobs" {
        return list(&context);
    }
    if action == "access-status" {
        return access::status(&context, input).await;
    }
    if action == "default-directory" {
        return Ok(json!(dirs::home_dir()
            .ok_or("Cannot locate your home folder")?
            .join("Orka")));
    }
    if action == "open-github" {
        let raw = input["url"].as_str().ok_or("Missing GitHub URL")?;
        let url = reqwest::Url::parse(raw).map_err(|_| "Invalid GitHub URL")?;
        if url.scheme() != "https"
            || url.host_str() != Some("github.com")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return Err("Choose a GitHub.com URL".into());
        }
        let status = std::process::Command::new("/usr/bin/open")
            .arg(url.as_str())
            .status()
            .map_err(|_| "Cannot open GitHub in your browser")?;
        return if status.success() {
            Ok(json!({"ok":true}))
        } else {
            Err("Cannot open GitHub in your browser".into())
        };
    }
    if action == "cancel-clone" || action == "retry-connect" {
        let id = Uuid::parse_str(input["id"].as_str().ok_or("Missing clone job")?)
            .map_err(|_| "Invalid clone job")?
            .to_string();
        let mut job = db::get(&context.database()?, &format!("repository-job:{id}"))?;
        if job["id"] != id {
            return Err("Clone job not found for this account and service".into());
        }
        if action == "cancel-clone" {
            let jobs = JOBS.lock().unwrap_or_else(|e| e.into_inner());
            let current = db::get(&context.database()?, &format!("repository-job:{id}"))?;
            if current["state"] == "connecting" {
                return Err(
                    "Clone finished and the source is connecting. Wait for it to finish.".into(),
                );
            }
            if let Some(cancel) = jobs.get(&id) {
                cancel.store(true, Ordering::Relaxed);
            }
            return Ok(json!({"ok":true}));
        }
        if active(&id) {
            return Err("This clone job is still running".into());
        }
        attach(&context, &job).await?;
        job["state"] = json!("connected");
        job["message"] = json!("Checkout connected");
        save(&context, &job)?;
        return Ok(job);
    }
    if action == "clone" {
        let project = Uuid::parse_str(input["projectId"].as_str().ok_or("Missing project")?)
            .map_err(|_| "Invalid project")?
            .to_string();
        let source_id = Uuid::parse_str(input["sourceId"].as_str().ok_or("Missing source")?)
            .map_err(|_| "Invalid source")?
            .to_string();
        let current = source(&context, &project, &source_id)?;
        if current["path"].is_string() {
            return Err(
                "This source is already connected. Disconnect it before cloning another checkout."
                    .into(),
            );
        }
        clone_url(
            current["repository"]["cloneUrl"]
                .as_str()
                .ok_or("Link a GitHub repository first")?,
        )?;
        let directory = input["directory"]
            .as_str()
            .ok_or("Choose a destination folder")?;
        let parent = PathBuf::from(directory);
        if !parent.is_absolute() {
            return Err("Choose an absolute destination folder".into());
        }
        fs::create_dir_all(&parent).map_err(|_| "Cannot create the workspace folder")?;
        let parent = fs::canonicalize(parent).map_err(|_| "Destination folder is unavailable")?;
        let folder = input["folderName"]
            .as_str()
            .ok_or("Enter a checkout folder name")?;
        if folder.is_empty()
            || folder.len() > 160
            || folder.starts_with('.')
            || !folder
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        {
            return Err(
                "Use a folder name containing letters, numbers, dots, underscores or hyphens"
                    .into(),
            );
        }
        let destination = parent.join(folder);
        if destination.symlink_metadata().is_ok() {
            return Err(
                "Destination exists. Locate that checkout or choose another folder name.".into(),
            );
        }
        for job in list(&context)?.as_array().into_iter().flatten() {
            if job["destination"] == json!(destination) && active(job["id"].as_str().unwrap_or(""))
            {
                return Err("A clone is already using this destination".into());
            }
        }
        let id = Uuid::new_v4().to_string();
        let canceled = Arc::new(AtomicBool::new(false));
        let job = json!({"id":id,"projectId":project,"sourceId":source_id,"repositoryId":current["repository"]["id"],"bindingRevision":current["repository"]["revision"],"destination":destination,"state":"queued","message":"Preparing clone","createdAt":chrono::Utc::now().to_rfc3339()});
        {
            let mut jobs = JOBS.lock().unwrap_or_else(|e| e.into_inner());
            if jobs.len() >= 4 {
                return Err("Four repositories are cloning. Wait for one to finish before starting another.".into());
            }
            jobs.insert(id, canceled.clone());
        }
        if let Err(error) = save(&context, &job) {
            JOBS.lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(job["id"].as_str().unwrap_or(""));
            return Err(error);
        }
        tokio::spawn(clone_job(context, job.clone(), canceled));
        return Ok(job);
    }
    if action == "bind" {
        let project = input["projectId"].as_str().ok_or("Missing project")?;
        let source_id = input["sourceId"].as_str().ok_or("Missing source")?;
        if let Some(path) = source(&context, project, source_id)?["path"].as_str() {
            let repository = context
                .api("repository", json!({"repositoryId":input["repositoryId"]}))
                .await?;
            verify_remote(
                Path::new(path),
                repository["cloneUrl"]
                    .as_str()
                    .ok_or("Invalid repository")?,
            )?;
        }
    }
    if ![
        "status",
        "begin",
        "poll",
        "cancel-authorization",
        "disconnect",
        "installations",
        "repositories",
        "add-source",
        "bind",
        "unlink",
        "access",
        "request-access",
        "requests",
        "review",
    ]
    .contains(&action.as_str())
    {
        return Err("Unknown repository operation".into());
    }
    let result = context.api(&action, input).await?;
    if action == "disconnect" || (action == "poll" && result["connected"] == true) {
        let _lock = projects::lock()?;
        context.check()?;
        let db = context.database()?;
        let revision = db::get(&db, "repository-auth-revision")?
            .as_u64()
            .unwrap_or(0);
        db::set(&db, "repository-auth-revision", &json!(revision + 1))?;
    }
    if action == "bind" || action == "unlink" || action == "add-source" {
        let catalog =
            sync::api_at(&context.user, &context.service, "GET", "/v2/projects", None).await?;
        let _lock = projects::lock()?;
        context.check()?;
        projects::merge_catalog(&context.database()?, &catalog)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_works_during_continuous_progress_and_after_stderr_closes() {
        for script in [
            "while :; do printf 'transfer 1%%\\n' >&2; done",
            "exec 2>/dev/null; exec /bin/sleep 30",
        ] {
            let canceled = Arc::new(AtomicBool::new(false));
            let flag = canceled.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                flag.store(true, Ordering::Relaxed);
            });
            let mut command = tokio::process::Command::new("/bin/sh");
            command
                .args(["-c", script])
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                run_git(command, canceled, None, |_| {}),
            )
            .await;
            assert!(result.unwrap().is_err());
        }
    }
    #[test]
    fn checkout_setup_detects_nested_lfs_attributes() {
        let temp = tempfile::tempdir().unwrap();
        assert!(!checkout_needs_setup(temp.path()));
        fs::create_dir(temp.path().join("assets")).unwrap();
        fs::write(
            temp.path().join("assets/.gitattributes"),
            "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        )
        .unwrap();
        assert!(checkout_needs_setup(temp.path()));
        fs::remove_file(temp.path().join("assets/.gitattributes")).unwrap();
        fs::write(temp.path().join(".gitmodules"), "[submodule fixture]\n").unwrap();
        assert!(checkout_needs_setup(temp.path()));
    }
    #[test]
    fn clone_urls_reject_credentials_protocols_and_option_injection() {
        for url in [
            "https://github.com/team/repo.git",
            "https://github.com/team/my-repo.git",
        ] {
            assert!(clone_url(url).is_ok());
        }
        for url in [
            "file:///tmp/repo",
            "https://user:secret@github.com/team/repo.git",
            "https://github.com.evil.test/a/b.git",
            "https://github.com/a/b.git?x=1",
            "ext::sh x",
            "--upload-pack=sh",
            "https://github.com/a/../b.git",
        ] {
            assert!(clone_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn final_move_never_replaces_existing_checkout() {
        let temp = tempfile::tempdir().unwrap();
        let from = temp.path().join("staging");
        let to = temp.path().join("checkout");
        fs::create_dir(&from).unwrap();
        fs::create_dir(&to).unwrap();
        fs::write(to.join("keep"), "user work").unwrap();
        assert!(move_checkout(&from, &to).is_err());
        assert_eq!(fs::read_to_string(to.join("keep")).unwrap(), "user work");
    }
    #[tokio::test]
    async fn real_git_clone_transfers_fixture_files_and_honors_cancellation() {
        let temp = tempfile::tempdir().unwrap();
        let origin = temp.path().join("origin");
        let checkout = temp.path().join("checkout");
        let git = |args: &[&str]| {
            assert!(std::process::Command::new("/usr/bin/git")
                .args(args)
                .current_dir(temp.path())
                .output()
                .unwrap()
                .status
                .success());
        };
        git(&["init", "origin"]);
        fs::write(origin.join("README.md"), "Repository fixture\n").unwrap();
        git(&["-C", "origin", "add", "."]);
        git(&[
            "-C",
            "origin",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "-m",
            "fixture",
        ]);
        let mut command = git_command();
        command
            .args([
                "-c",
                "protocol.file.allow=always",
                "clone",
                "--progress",
                "--",
            ])
            .arg(&origin)
            .arg(&checkout);
        run_git(command, Arc::new(AtomicBool::new(false)), None, |_| {})
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(checkout.join("README.md")).unwrap(),
            "Repository fixture\n"
        );
        let mut command = git_command();
        command
            .args(["-c", "protocol.file.allow=always", "clone", "--"])
            .arg(&origin)
            .arg(temp.path().join("canceled"));
        assert!(
            run_git(command, Arc::new(AtomicBool::new(true)), None, |_| {})
                .await
                .is_err()
        );
    }
}
