use crate::{
    db::{self, Result},
    governance, indexer, native, packages, projects,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Destination {
    Desktop,
    Terminal,
    Warp,
    Iterm2,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    Codex,
    Claude,
}

impl Tool {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::Claude),
            _ => Err("Unsupported session tool".into()),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude Desktop",
        }
    }
    fn other(self) -> Self {
        match self {
            Self::Codex => Self::Claude,
            Self::Claude => Self::Codex,
        }
    }
}

impl Destination {
    fn bundle(self, tool: Tool) -> &'static str {
        match self {
            Self::Desktop if tool == Tool::Codex => "com.openai.codex",
            Self::Desktop => "com.anthropic.claudefordesktop",
            Self::Terminal => "com.apple.Terminal",
            Self::Warp => "dev.warp.Warp-Stable",
            Self::Iterm2 => "com.googlecode.iterm2",
        }
    }
    fn label(self, tool: Tool) -> &'static str {
        match self {
            Self::Desktop => tool.label(),
            Self::Terminal => "Terminal",
            Self::Warp => "Warp",
            Self::Iterm2 => "iTerm2",
        }
    }
}

pub(crate) fn output(command: &mut Command, timeout: Duration) -> Result<Output> {
    use std::{
        io::{ErrorKind, Read},
        os::fd::AsRawFd,
    };
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;
    let result = (|| {
        let mut stdout = child.stdout.take().ok_or("Missing command output")?;
        let mut stderr = child.stderr.take().ok_or("Missing command errors")?;
        for fd in [stdout.as_raw_fd(), stderr.as_raw_fd()] {
            // These descriptors belong to live pipes owned by this function.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        let drain = |pipe: &mut dyn Read, bytes: &mut Vec<u8>| -> Result<bool> {
            let mut buffer = [0; 8192];
            // Bound each pass so continuous output cannot starve the other pipe or timeout.
            for _ in 0..16 {
                match pipe.read(&mut buffer) {
                    Ok(0) => return Ok(true),
                    Ok(size) => {
                        let keep = size.min(128_000usize.saturating_sub(bytes.len()));
                        bytes.extend_from_slice(&buffer[..keep]);
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => return Ok(false),
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(error) => return Err(error.to_string()),
                }
            }
            Ok(false)
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        loop {
            let stdout_done = drain(&mut stdout, &mut out)?;
            let stderr_done = drain(&mut stderr, &mut err)?;
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                if stdout_done && stderr_done {
                    return Ok(Output {
                        status,
                        stdout: out,
                        stderr: err,
                    });
                }
            }
            if Instant::now() >= deadline {
                return Err(
                    "The app did not respond in time. Check the destination before trying again."
                        .into(),
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

fn app_installed(destination: Destination, tool: Tool) -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::NSString;
        NSWorkspace::sharedWorkspace()
            .URLForApplicationWithBundleIdentifier(&NSString::from_str(destination.bundle(tool)))
            .is_some()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (destination, tool);
        false
    }
}

pub(crate) fn app_icon(destination: Destination, tool: Tool) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use objc2::AnyThread;
        use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
        use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

        objc2::rc::autoreleasepool(|_| {
            let workspace = NSWorkspace::sharedWorkspace();
            let app = workspace.URLForApplicationWithBundleIdentifier(&NSString::from_str(
                destination.bundle(tool),
            ))?;
            let path = app.path()?;
            let image = workspace.iconForFile(&path);
            // Request a Retina-sized menu icon instead of transferring the full app artwork.
            let mut rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(32.0, 32.0));
            // The rectangle is valid for this call and no untyped drawing hints are supplied.
            let cg_image =
                unsafe { image.CGImageForProposedRect_context_hints(&mut rect, None, None) }?;
            let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg_image);
            // An empty properties dictionary uses the PNG encoder's defaults.
            let png = unsafe {
                bitmap.representationUsingType_properties(
                    NSBitmapImageFileType::PNG,
                    &NSDictionary::new(),
                )
            }?;
            Some(format!(
                "data:image/png;base64,{}",
                STANDARD.encode(png.to_vec())
            ))
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (destination, tool);
        None
    }
}

struct Session {
    resource: Value,
    project: Value,
    tool: Tool,
}

fn session(db: &Connection, id: &str) -> Result<Session> {
    Uuid::parse_str(id).map_err(|_| "Invalid session ID")?;
    let resource = governance::resource(db, id)?;
    if resource["kind"] != "session" || resource["deleted"] == true {
        return Err("Session unavailable".into());
    }
    let tool = Tool::parse(resource["source"].as_str().unwrap_or(""))?;
    let project =
        governance::project(db, resource["projectId"].as_str().ok_or("Missing project")?)?;
    Ok(Session {
        resource,
        project,
        tool,
    })
}

fn root(session: &Session) -> Result<PathBuf> {
    let project = crate::sources::for_resource(&session.project, &session.resource)
        .ok_or("Connect this session's repository on this Mac")?;
    crate::sources::validate(&project)?;
    Ok(PathBuf::from(
        project["path"].as_str().ok_or("Connect a folder first")?,
    ))
}

fn cli(tool: Tool, desktop: bool) -> Result<PathBuf> {
    let binary = native::binary(tool.name())?;
    if fs::metadata(&binary)
        .map_err(|e| e.to_string())?
        .permissions()
        .mode()
        & 0o111
        == 0
    {
        return Err(format!("The {} CLI is not executable", tool.name()));
    }
    if desktop && tool == Tool::Claude {
        let help = output(Command::new(&binary).arg("--help"), Duration::from_secs(10))?;
        if !help.status.success() || !String::from_utf8_lossy(&help.stdout).contains("--desktop") {
            return Err("Update Claude Code to a version with Desktop resume support".into());
        }
    }
    Ok(binary)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOption {
    tool: Tool,
    destination: Destination,
    label: &'static str,
    available: bool,
    reason: Option<String>,
    icon: Option<String>,
}

pub(crate) trait Host {
    fn installed(&self, destination: Destination, tool: Tool) -> bool;
    fn icon(&self, destination: Destination, tool: Tool) -> Option<String>;
    fn cli(&self, tool: Tool, desktop: bool) -> Result<PathBuf>;
    fn active(&self, db: &Connection, id: &str, tool: Tool, paths: &[PathBuf]) -> bool;
    fn open_url(&self, tool: Tool, url: &str) -> Result<()>;
    fn open_session(
        &self,
        destination: Destination,
        tool: Tool,
        id: &str,
        root: &Path,
        binary: Option<&Path>,
    ) -> Result<Option<String>>;
}

struct MacHost;
impl Host for MacHost {
    fn installed(&self, destination: Destination, tool: Tool) -> bool {
        app_installed(destination, tool)
    }
    fn icon(&self, destination: Destination, tool: Tool) -> Option<String> {
        app_icon(destination, tool)
    }
    fn cli(&self, tool: Tool, desktop: bool) -> Result<PathBuf> {
        cli(tool, desktop)
    }
    fn active(&self, db: &Connection, id: &str, tool: Tool, paths: &[PathBuf]) -> bool {
        native::active_for_resume(db, id, tool.name(), paths)
    }
    fn open_url(&self, tool: Tool, url: &str) -> Result<()> {
        checked(
            Command::new("/usr/bin/open").args(["-b", Destination::Desktop.bundle(tool), url]),
            tool.label(),
        )
    }
    fn open_session(
        &self,
        destination: Destination,
        tool: Tool,
        id: &str,
        root: &Path,
        binary: Option<&Path>,
    ) -> Result<Option<String>> {
        if destination != Destination::Desktop {
            return launch_terminal(destination, tool, id, root, binary.ok_or("Missing CLI")?);
        }
        if tool == Tool::Claude {
            checked(
                Command::new(binary.ok_or("Missing Claude CLI")?)
                    .current_dir(root)
                    .env("CLAUDE_CONFIG_DIR", native::claude_home()?)
                    .args(["--desktop", "--resume", id]),
                "Claude Desktop",
            )
        } else {
            self.open_url(tool, &format!("codex://threads/{id}"))
        }
        .map(|_| None)
    }
}

pub fn options(id: &str) -> Result<Vec<LaunchOption>> {
    options_with(id, &MacHost)
}

pub(crate) fn options_with(id: &str, host: &impl Host) -> Result<Vec<LaunchOption>> {
    let db = db::open()?;
    let session = session(&db, id)?;
    let folder = root(&session);
    let binding = indexer::binding(&db, id)?;
    let binary = host.cli(session.tool, false);
    let desktop_cli = if session.tool == Tool::Claude {
        host.cli(session.tool, true).map(|_| ())
    } else {
        Ok(())
    };
    let mut options = Vec::new();
    for (tool, destination) in [
        (session.tool, Destination::Desktop),
        (session.tool, Destination::Terminal),
        (session.tool, Destination::Warp),
        (session.tool, Destination::Iterm2),
        (session.tool.other(), Destination::Desktop),
    ] {
        let installed = host.installed(destination, tool);
        if destination != Destination::Desktop && !installed {
            continue;
        }
        let reason = folder
            .as_ref()
            .err()
            .cloned()
            .or_else(|| {
                (!installed)
                    .then(|| format!("Install {} to open sessions here", destination.label(tool)))
            })
            .or_else(|| {
                (tool == session.tool && binding["nativeId"].as_str().is_none())
                    .then(|| "Sync first to install the native session".into())
            })
            .or_else(|| {
                if destination != Destination::Desktop {
                    binary.as_ref().err().cloned()
                } else if tool == session.tool {
                    desktop_cli.as_ref().err().cloned()
                } else {
                    None
                }
            });
        options.push(LaunchOption {
            tool,
            destination,
            label: destination.label(tool),
            available: reason.is_none(),
            reason,
            icon: host.icon(destination, tool),
        });
    }
    Ok(options)
}

fn checked(command: &mut Command, app: &str) -> Result<()> {
    let result = output(command, Duration::from_secs(15))?;
    if !result.status.success() {
        return Err(format!("Couldn’t open {app}. Check that it is installed, signed in, and allowed to open sessions."));
    }
    Ok(())
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) fn terminal_script(
    binary: &Path,
    tool: Tool,
    native_id: &str,
    root: &Path,
    native_home: &Path,
    cleanup: Option<&Path>,
    started: Option<&Path>,
) -> String {
    let home_key = if tool == Tool::Codex {
        "CODEX_HOME"
    } else {
        "CLAUDE_CONFIG_DIR"
    };
    let arguments = if tool == Tool::Codex {
        "resume"
    } else {
        "--resume"
    };
    let cleanup = cleanup
        .map(|path| format!(" {}", shell_quote(&path.to_string_lossy())))
        .unwrap_or_default();
    let started = started
        .map(|path| format!(": > {}\n", shell_quote(&path.to_string_lossy())))
        .unwrap_or_default();
    format!(
        "#!/bin/sh\nset -eu\n/bin/rm -f -- \"$0\"{cleanup}\ncd -- {}\nexport {home_key}={}\n{started}exec {} {arguments} {}\n",
        shell_quote(&root.to_string_lossy()),
        shell_quote(&native_home.to_string_lossy()),
        shell_quote(&binary.to_string_lossy()),
        shell_quote(native_id)
    )
}

fn private_file(path: &Path, content: &[u8], mode: u32) -> Result<()> {
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(content).map_err(|e| e.to_string())
}

// JSON is valid YAML. This format also works on Warp versions before Tab Configs.
pub(crate) fn warp_config(script: &Path, root: &Path) -> String {
    json!({"name":"Orka session","windows":[{"tabs":[{"title":"Orka session","layout":{"cwd":root,"commands":[{"exec":format!("/bin/sh {}",shell_quote(&script.to_string_lossy()))}]}}]}]}).to_string()
}

fn warp_url(path: &Path) -> Result<String> {
    let mut url = reqwest::Url::parse("warp://launch/").map_err(|e| e.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "Invalid Warp launch URL")?
        .push(&path.to_string_lossy());
    Ok(url.into())
}

fn launch_terminal(
    destination: Destination,
    tool: Tool,
    native_id: &str,
    root: &Path,
    binary: &Path,
) -> Result<Option<String>> {
    let directory = db::root()?.join("session-launchers");
    packages::safe_directory(&db::root()?, &directory)?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let nonce = Uuid::new_v4();
    let script = directory.join(format!("{nonce}.command"));
    let native_home = if tool == Tool::Codex {
        native::codex_home()?
    } else {
        native::claude_home()?
    };
    let mut config = None;
    let started = directory.join(format!("{nonce}.started"));
    let result = (|| -> Result<()> {
        if destination == Destination::Warp {
            // Warp is a separate GUI app and reads the OS user's configuration home.
            let app_home = dirs::home_dir().ok_or("Home directory unavailable")?;
            let warp = app_home.join(".warp");
            packages::safe_directory(&app_home, &warp)?;
            let configs = warp.join("launch_configurations");
            packages::safe_directory(&warp, &configs)?;
            let name = format!("orka_session_{}", nonce.simple());
            let path = configs.join(format!("{name}.yaml"));
            private_file(&path, warp_config(&script, root).as_bytes(), 0o600)?;
            config = Some(path);
        }
        let content = terminal_script(
            binary,
            tool,
            native_id,
            root,
            &native_home,
            config.as_deref(),
            (destination != Destination::Iterm2).then_some(started.as_path()),
        );
        private_file(&script, content.as_bytes(), 0o700)?;
        match destination {
            Destination::Terminal => checked(
                Command::new("/usr/bin/open")
                    .args(["-b", destination.bundle(tool)])
                    .arg(&script),
                "Terminal",
            ),
            Destination::Iterm2 => {
                let mut url = reqwest::Url::parse("iterm2:/command").map_err(|e| e.to_string())?;
                url.query_pairs_mut()
                    .append_pair(
                        "c",
                        &format!("/bin/sh {}", shell_quote(&script.to_string_lossy())),
                    )
                    .append_pair("d", &root.to_string_lossy());
                checked(
                    Command::new("/usr/bin/open").args([
                        "-b",
                        destination.bundle(tool),
                        url.as_str(),
                    ]),
                    "iTerm2",
                )
            }
            Destination::Warp => checked(
                Command::new("/usr/bin/open").args([
                    "-b",
                    destination.bundle(tool),
                    &warp_url(config.as_deref().ok_or("Missing Warp configuration")?)?,
                ]),
                "Warp",
            ),
            Destination::Desktop => Err("Choose a terminal destination".into()),
        }
    })();
    if result.is_ok() && destination == Destination::Iterm2 {
        return Ok(None);
    }
    if result.is_ok() {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if started.is_file() {
                let _ = fs::remove_file(&started);
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let _ = fs::remove_file(&script);
    let _ = fs::remove_file(&started);
    if let Some(path) = config {
        let _ = fs::remove_file(path);
    }
    result?;
    if destination == Destination::Warp {
        let home_key = if tool == Tool::Codex {
            "CODEX_HOME"
        } else {
            "CLAUDE_CONFIG_DIR"
        };
        let argument = if tool == Tool::Codex {
            "resume"
        } else {
            "--resume"
        };
        return Ok(Some(format!(
            "cd -- {} && /usr/bin/env {home_key}={} {} {argument} {}",
            shell_quote(&root.to_string_lossy()),
            shell_quote(&native_home.to_string_lossy()),
            shell_quote(&binary.to_string_lossy()),
            shell_quote(native_id)
        )));
    }
    Err("Terminal opened but did not start the session. Check Terminal, then try again.".into())
}

pub fn resume(id: &str, tool: Tool, destination: Destination) -> Result<Value> {
    resume_with(id, tool, destination, &MacHost)
}

pub(crate) fn resume_with(
    id: &str,
    tool: Tool,
    destination: Destination,
    host: &impl Host,
) -> Result<Value> {
    let db = db::open()?;
    let scope = json!([db::get(&db, "user")?, db::get(&db, "config")?]);
    let session = session(&db, id)?;
    if tool != session.tool && destination != Destination::Desktop {
        return Err("Cross-tool continuation opens a new desktop conversation".into());
    }
    if !host.installed(destination, tool) {
        return Err(format!(
            "Install {} to open sessions here",
            destination.label(tool)
        ));
    }
    let binary =
        if destination != Destination::Desktop || (tool == Tool::Claude && tool == session.tool) {
            Some(host.cli(tool, destination == Destination::Desktop)?)
        } else {
            None
        };
    let _lock = projects::lock()?;
    let db = db::open()?;
    if scope != json!([db::get(&db, "user")?, db::get(&db, "config")?]) {
        return Err("Account or service changed. Open the session again.".into());
    }
    let session = self::session(&db, id)?;
    let root = root(&session)?;
    let source_project = crate::sources::for_resource(&session.project, &session.resource)
        .ok_or("Connect this session's repository on this Mac")?;
    if tool != session.tool {
        let directory = root.join(".orka/handoffs");
        packages::safe_directory(&root, &directory)?;
        let path = directory.join(format!("{id}.md"));
        let records = crate::history::resource_records(&session.resource)?;
        db::atomic(&path, native::transcript(&records).as_bytes())?;
        native::record_handoff(&db, &source_project, &session.resource, &path)?;
        let prompt = format!("Continue from the exported {} session at {}. Read that transcript for context. This is a new session; the original conversation state remains in its source tool.", session.tool.name(), path.display());
        let (url, prompt_key, folder_key) = if tool == Tool::Codex {
            ("codex://threads/new", "prompt", "path")
        } else {
            ("claude://code/new", "q", "folder")
        };
        let mut url = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
        url.query_pairs_mut()
            .append_pair(prompt_key, &prompt)
            .append_pair(folder_key, &root.to_string_lossy());
        host.open_url(tool, url.as_str())?;
        return Ok(
            json!({"opened":true,"handoff":path,"instruction":format!("Opened {}'s new-session composer. Confirm the folder and send the prefilled handoff prompt to continue.",tool.label())}),
        );
    }
    let mut binding = indexer::binding(&db, id)?;
    let native_id = binding["nativeId"]
        .as_str()
        .ok_or("Sync first to install the native session")?
        .to_owned();
    Uuid::parse_str(&native_id).map_err(|_| "Invalid native session ID")?;
    if destination != Destination::Desktop {
        let paths: Vec<_> = binding["paths"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(PathBuf::from)
            .collect();
        if host.active(&db, &native_id, tool, &paths) {
            return Err("This session may already be open. Close it in the other app before resuming in a terminal.".into());
        }
    }
    if session.resource["owner"] != db::get(&db, "user")? {
        binding["needsCopy"] = json!(true);
        db::upsert(
            &db,
            "bindings",
            id,
            session.resource["projectId"]
                .as_str()
                .ok_or("Missing project")?,
            &binding,
        )?;
        crate::commands::sync_now()?;
    }
    if destination != Destination::Desktop {
        let manual_command =
            host.open_session(destination, tool, &native_id, &root, binary.as_deref())?;
        if let Some(command) = manual_command {
            return Ok(json!({"opened":false,"manualCommand":command}));
        }
        if destination == Destination::Iterm2 {
            return Ok(
                json!({"opened":true,"instruction":"Review the resume command in iTerm2, then choose a new tab or window to continue."}),
            );
        }
        return Ok(
            json!({"opened":true,"instruction":if session.resource["owner"] == db::get(&db,"user")? { format!("Resume requested in {}.",destination.label(tool)) } else { format!("Resume requested in {}. Your continuation will be saved as a copy.",destination.label(tool)) }}),
        );
    }
    host.open_session(destination, tool, &native_id, &root, binary.as_deref())?;
    Ok(json!({"opened":true}))
}
