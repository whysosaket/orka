use crate::{
    db::{self, Result},
    packages, session_translation,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};
use uuid::Uuid;
pub fn binary(tool: &str) -> Result<PathBuf> {
    if !["codex", "claude"].contains(&tool) {
        return Err("Unknown tool".into());
    }
    let mut candidates = vec![
        db::home()?.join(".local/bin").join(tool),
        PathBuf::from("/opt/homebrew/bin").join(tool),
        PathBuf::from("/usr/local/bin").join(tool),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|p| p.join(tool)));
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or(format!("Install {tool} to enable native sessions"))
}
pub fn version(tool: &str) -> Result<String> {
    let mut child = Command::new(binary(tool)?)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20))
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => format!("Cannot read {tool} version: {error}"),
                    _ => format!("{tool} --version timed out; check the installed CLI and retry"),
                });
            }
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || v.is_empty() {
        return Err(format!("Cannot determine installed {tool} version"));
    }
    Ok(v)
}
pub fn session_sources(db: &rusqlite::Connection, project: &str, session: &str) -> Result<Value> {
    let mut sources = db::get(db, &format!("sessionSources:{project}:{session}"))?
        .as_array()
        .cloned()
        .unwrap_or_default();
    for active in db::rows(
        db,
        "SELECT value FROM active WHERE native_id=? AND json_extract(value,'$.project')=?",
        &[&session, &project],
    )? {
        for source in active["contextSources"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            if !sources.contains(&source) {
                sources.push(source);
            }
        }
    }
    Ok(json!(sources))
}
pub fn record_handoff(
    db: &rusqlite::Connection,
    project: &Value,
    resource: &Value,
    path: &Path,
) -> Result<()> {
    if project["governed"] != true {
        return Ok(());
    }
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let id = resource["resourceId"].as_str().ok_or("Missing source")?;
    let mut sources = resource["contextSources"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if !sources.contains(&resource["resourceId"]) {
        sources.push(resource["resourceId"].clone());
    }
    db::set(
        db,
        &format!("handoff:{project_id}:{id}"),
        &json!({"path":path,"resource":resource,"sources":sources,"hash":db::digest(&fs::read(path).map_err(|e|e.to_string())?)}),
    )?;
    let mut pending = db::get(db, &format!("pendingHandoffSources:{project_id}"))?
        .as_array()
        .cloned()
        .unwrap_or_default();
    for id in sources {
        if !pending.contains(&id) {
            pending.push(id);
        }
    }
    db::set(
        db,
        &format!("pendingHandoffSources:{project_id}"),
        &json!(pending),
    )
}
pub fn bind_handoff(
    db: &rusqlite::Connection,
    project: &str,
    session: &str,
    records: &[Value],
) -> Result<()> {
    fn mentions(v: &Value, path: &str) -> bool {
        match v {
            Value::String(s) => s.contains(path),
            Value::Array(a) => a.iter().any(|v| mentions(v, path)),
            Value::Object(o) => o.values().any(|v| mentions(v, path)),
            _ => false,
        }
    }
    let mut known = session_sources(db, project, session)?
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut pending = db::get(db, &format!("pendingHandoffSources:{project}"))?
        .as_array()
        .cloned()
        .unwrap_or_default();
    for handoff in db::rows(
        db,
        "SELECT value FROM meta WHERE key GLOB ?",
        &[&format!("handoff:{project}:*")],
    )? {
        let path = handoff["path"].as_str().ok_or("Invalid handoff path")?;
        if !records.iter().any(|v| mentions(v, path)) {
            continue;
        }
        for source in handoff["sources"].as_array().cloned().unwrap_or_default() {
            if !known.contains(&source) {
                known.push(source.clone());
            }
            pending.retain(|id| id != &source);
        }
    }
    db::set(
        db,
        &format!("sessionSources:{project}:{session}"),
        &json!(known),
    )?;
    db::set(
        db,
        &format!("pendingHandoffSources:{project}"),
        &json!(pending),
    )
}
pub fn codex_home() -> Result<PathBuf> {
    Ok(std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or(db::home()?.join(".codex")))
}
pub fn claude_home() -> Result<PathBuf> {
    Ok(std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or(db::home()?.join(".claude")))
}
pub struct Rpc {
    child: std::process::Child,
    input: std::process::ChildStdin,
    rx: mpsc::Receiver<Value>,
    next: u64,
}
impl Rpc {
    fn spawn(proxy: bool) -> Result<Self> {
        let mut command = Command::new(binary("codex")?);
        command.args(if proxy {
            vec!["app-server", "proxy"]
        } else {
            vec!["app-server"]
        });
        command.env("CODEX_HOME", codex_home()?);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let input = child.stdin.take().ok_or("No app-server stdin")?;
        let output = child.stdout.take().ok_or("No app-server stdout")?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if let Ok(v) = serde_json::from_str(&line) {
                    if tx.send(v).is_err() {
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            input,
            rx,
            next: 0,
        })
    }
    pub fn connect() -> Result<Self> {
        version("codex")?;
        let mut failures = Vec::new();
        for proxy in [true, false] {
            let mut rpc = Self::spawn(proxy)?;
            let initialized = match rpc.call("initialize",json!({"clientInfo":{"name":"orka","version":"0.1.0"},"capabilities":{"experimentalApi":true}})) {
                Ok(value) if value.is_object() => value,
                Ok(_) => { failures.push("invalid app-server initialization response".into()); continue; }
                Err(error) => { failures.push(error); continue; }
            };
            let expected = codex_home()?;
            let actual = initialized["codexHome"].as_str().map(PathBuf::from);
            // Older direct servers omit codexHome. Only a child explicitly
            // started in our configured home may omit this identity check.
            if actual.as_ref().map_or(proxy, |home| {
                match (home.canonicalize(), expected.canonicalize()) {
                    (Ok(actual), Ok(expected)) => actual != expected,
                    _ => true,
                }
            }) {
                failures
                    .push("app-server reported a different or unverifiable Codex home".to_owned());
                continue;
            }
            rpc.send(json!({"method":"initialized"}))?;
            return Ok(rpc);
        }
        Err(format!(
            "Codex app server unavailable: {}",
            failures.join("; ")
        ))
    }
    fn send(&mut self, value: Value) -> Result<()> {
        writeln!(self.input, "{value}").map_err(|e| e.to_string())?;
        self.input.flush().map_err(|e| e.to_string())
    }
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.call_optional(method, params)?
            .ok_or_else(|| format!("Installed Codex does not support {method}"))
    }
    /// Only an explicit unknown-method response permits a compatibility fallback.
    /// Timeouts and ordinary RPC failures must remain retryable errors.
    pub fn call_optional(&mut self, method: &str, params: Value) -> Result<Option<Value>> {
        let response = self.request(method, params)?;
        if unsupported_method(&response["error"], method) {
            return Ok(None);
        }
        if !response["error"].is_null() {
            return Err(format!(
                "Codex {method}: {}",
                response["error"]["message"]
                    .as_str()
                    .unwrap_or("request failed")
            ));
        }
        Ok(Some(response["result"].clone()))
    }
    pub fn supports_pagination(&mut self) -> Result<bool> {
        let method = "thread/turns/list";
        let response = self.request(
            method,
            json!({"threadId":Uuid::nil().to_string(),"limit":1}),
        )?;
        if unsupported_method(&response["error"], method) {
            return Ok(false);
        }
        // A recognized method may reject the deliberately absent thread. Other
        // failures do not establish that the receiving server can read it.
        if response["error"].is_null() {
            return Ok(true);
        }
        let message = response["error"]["message"].as_str().unwrap_or_default();
        if message.to_ascii_lowercase().contains("not found")
            || message.contains("no rollout found")
            || message.starts_with("thread not loaded:")
        {
            return Ok(true);
        }
        Err(format!("Cannot detect Codex pagination support: {message}"))
    }
    fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next += 1;
        let id = self.next;
        self.send(json!({"id":id,"method":method,"params":params}))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let v = self
                .rx
                .recv_timeout(remaining)
                .map_err(|_| format!("Codex {method} did not respond"))?;
            if v["id"].as_u64() != Some(id) {
                continue;
            }
            if v.get("result").is_none() && v["error"].is_null() {
                return Err(format!("Codex {method} returned an invalid RPC response"));
            }
            return Ok(v);
        }
    }
}
fn unsupported_method(error: &Value, method: &str) -> bool {
    error["code"] == -32601
        || (error["code"] == -32600
            && error["message"]
                .as_str()
                .is_some_and(|message| message.contains(&format!("unknown variant `{method}`"))))
}
impl Drop for Rpc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
pub fn complete_records(bytes: &[u8]) -> Result<Vec<Value>> {
    let end = bytes
        .iter()
        .rposition(|b| *b == b'\n')
        .map(|p| p + 1)
        .unwrap_or(0);
    let mut records = Vec::new();
    for line in bytes[..end]
        .split(|b| *b == b'\n')
        .filter(|s| !s.is_empty())
    {
        records.push(
            serde_json::from_slice(line)
                .map_err(|_| "Unknown or corrupt native transcript; source preserved")?,
        );
    }
    Ok(records)
}
pub fn encode(records: &[Value]) -> Vec<u8> {
    let mut b = Vec::new();
    for r in records {
        b.extend_from_slice(r.to_string().as_bytes());
        b.push(b'\n');
    }
    b
}
pub fn session_cwd(tool: &str, records: &[Value]) -> Result<PathBuf> {
    let metadata = session_translation::metadata(tool, records)?;
    let cwd = PathBuf::from(metadata["cwd"].as_str().ok_or("Missing session cwd")?);
    if !cwd.is_absolute() {
        return Err("Session cwd must be absolute".into());
    }
    Ok(cwd)
}
pub fn session_info(tool: &str, records: &[Value]) -> Result<(String, PathBuf, String)> {
    let metadata = session_translation::metadata(tool, records)?;
    let cwd = session_cwd(tool, records)?;
    session_translation::format(tool, records)?;
    let id = metadata[if tool == "codex" { "id" } else { "sessionId" }]
        .as_str()
        .ok_or("Missing native ID")?;
    Ok((id.into(), cwd, transcript_title(records)))
}
pub fn validate_session_import(tool: &str, records: &[Value]) -> Result<()> {
    session_info(tool, records)?;
    Ok(())
}
fn transcript_title(records: &[Value]) -> String {
    records
        .iter()
        .filter_map(session_translation::user_text)
        .find_map(|text| crate::session_presentation::request_text(&text))
        .unwrap_or_else(|| "Imported session".into())
}
pub fn transcript_messages(records: &[Value]) -> Vec<Value> {
    session_translation::messages(records)
        .into_iter()
        .map(|message| json!({"role":message.role,"content":message.full_text}))
        .collect()
}
pub fn transcript(records: &[Value]) -> String {
    transcript_messages(records)
        .iter()
        .map(|message| {
            format!(
                "## {}\n\n{}\n\n",
                message["role"].as_str().unwrap_or_default(),
                message["content"].as_str().unwrap_or_default()
            )
        })
        .collect()
}

fn active_record(db: &rusqlite::Connection, id: &str) -> bool {
    if let Ok(rows) = db::rows(db, "SELECT value FROM active WHERE native_id=?", &[&id]) {
        if let Some(v) = rows.first() {
            if let Some(pid) = v["pid"].as_u64() {
                if Command::new("/bin/ps")
                    .args(["-p", &pid.to_string(), "-o", "pid="])
                    .output()
                    .is_ok_and(|o| !o.stdout.is_empty())
                {
                    return true;
                }
            }
            if v["pid"].is_null() {
                return true;
            }
            let _ = db.execute("DELETE FROM active WHERE native_id=?", [id]);
        }
    }
    false
}

pub fn active_for_resume(
    db: &rusqlite::Connection,
    id: &str,
    tool: &str,
    paths: &[PathBuf],
) -> bool {
    if tool == "codex" {
        return active(db, id, tool);
    }
    if active_record(db, id) {
        return true;
    }
    !paths.is_empty()
        && Command::new("/usr/sbin/lsof")
            .args(["-t", "--"])
            .args(paths)
            .output()
            .is_ok_and(|output| !output.stdout.is_empty())
}

pub fn active(db: &rusqlite::Connection, id: &str, tool: &str) -> bool {
    if active_record(db, id) {
        return true;
    }
    if tool == "codex" {
        return match Rpc::connect().and_then(|mut r| r.call("thread/loaded/list", json!({}))) {
            Ok(v) => v["data"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == id)),
            Err(_) => true,
        };
    }
    // A native process holding the transcript also protects sessions without hooks.
    let home = claude_home().ok();
    if let Some(home) = home {
        let root = home.join("projects");
        if let Ok(output) = Command::new("/usr/sbin/lsof")
            .args(["-t", "+D", &root.to_string_lossy()])
            .output()
        {
            if !output.stdout.is_empty() {
                return true;
            }
        }
    }
    false
}
pub fn materialize(
    db: &rusqlite::Connection,
    project: &Value,
    resource: &Value,
    old: &Value,
) -> Result<Value> {
    let tool = resource["source"].as_str().ok_or("Missing session tool")?;
    version(tool)?;
    let files = resource["files"]
        .as_array()
        .ok_or("Missing session files")?;
    let source = files
        .iter()
        .find(|f| f["path"] == "session.jsonl")
        .ok_or("Missing transcript")?;
    let records = complete_records(&db::blob_read(
        source["hash"].as_str().ok_or("Missing hash")?,
    )?)?;
    validate_session_import(tool, &records)?;
    if let Some(id) = old["nativeId"].as_str() {
        if active(db, id, tool) {
            return Err("Open session: incoming version staged until it closes".into());
        }
    }
    let (id, path) = if tool == "codex" {
        crate::codex_import::materialize(db, project, resource, old)?
    } else {
        crate::claude_import::materialize(db, project, resource, old, &records)?
    };
    Ok(
        json!({"nativeId":id,"paths":[path],"base":resource,"writeGuard":db::digest(&json!(files).to_string().into_bytes())}),
    )
}
pub fn install_hooks(project: &Path) -> Result<()> {
    let base = project.canonicalize().map_err(|e| e.to_string())?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    for (tool, file) in [
        ("claude", ".claude/settings.local.json"),
        ("codex", ".codex/hooks.json"),
    ] {
        let path = base.join(file);
        packages::safe_directory(&base, path.parent().ok_or("Missing parent")?)?;
        let mut cfg: Value = if path.exists() {
            serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?
        } else {
            json!({})
        };
        if !cfg.is_object() {
            return Err("Hook config must be an object".into());
        }
        if cfg["hooks"].is_null() {
            cfg["hooks"] = json!({});
        }
        for event in ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] {
            let mut list = cfg["hooks"][event].as_array().cloned().unwrap_or_default();
            list.retain(|v| {
                !v.to_string().contains("--orka-hook")
                    && !v.to_string().contains("--workspace-hook")
            });
            list.push(json!({"hooks":[{"type":"command","command":format!("{} --profile {} --orka-hook {tool}",quote(&executable.to_string_lossy()),quote(crate::profiles::current())),"timeout":3}]}));
            cfg["hooks"][event] = json!(list);
        }
        let backup = path.with_extension("json.orka-backup");
        if path.exists() && !backup.exists() {
            fs::copy(&path, backup).map_err(|e| e.to_string())?;
        }
        db::atomic(
            &path,
            &serde_json::to_vec_pretty(&cfg).map_err(|e| e.to_string())?,
        )?;
    }
    Ok(())
}
pub fn hook(tool: &str, input: Value) -> Result<Value> {
    let db = db::open()?;
    let Some(cwd) = input["cwd"].as_str() else {
        return Ok(json!({}));
    };
    let projects = db::rows(
        &db,
        &format!(
            "SELECT value FROM projects WHERE {}",
            crate::projects::ACTIVE
        ),
        &[],
    )?;
    let projects: Vec<_> = projects.iter().flat_map(crate::sources::views).collect();
    let project = projects
        .iter()
        .filter(|p| {
            p["path"]
                .as_str()
                .is_some_and(|s| Path::new(cwd).starts_with(s))
        })
        .max_by_key(|p| p["path"].as_str().unwrap_or("").len());
    let Some(project) = project else {
        return Ok(json!({}));
    };
    if matches!(tool, "claude" | "codex") {
        db::set(&db, &format!("hookSeen:{tool}"), &json!(db::now()))?;
    }
    let id = input["session_id"].as_str().unwrap_or("unknown");
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let event = input["hook_event_name"].as_str().unwrap_or("SessionStart");
    if event == "SessionEnd" {
        db::set(
            &db,
            &format!("sessionSources:{project_id}:{id}"),
            &session_sources(&db, project_id, id)?,
        )?;
        db.execute("DELETE FROM active WHERE native_id=?", [id])
            .map_err(|e| e.to_string())?;
    } else {
        let mut pid = std::process::id();
        let mut found = false;
        for _ in 0..8 {
            let output = Command::new("/bin/ps")
                .args(["-p", &pid.to_string(), "-o", "ppid="])
                .output()
                .map_err(|e| e.to_string())?;
            let Ok(parent) = String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<u32>()
            else {
                break;
            };
            pid = parent;
            let command = Command::new("/bin/ps")
                .args(["-p", &pid.to_string(), "-o", "comm="])
                .output()
                .map_err(|e| e.to_string())?;
            if String::from_utf8_lossy(&command.stdout).contains(tool) {
                found = true;
                break;
            }
        }
        let known = session_sources(&db, project_id, id)?;
        let value = json!({"contextSources":known,"nativeId":id,"project":project["id"],"source":tool,"pid":if found{json!(pid)}else{Value::Null},"ended":false,"updatedAt":db::now(),"transcriptPath":input["transcript_path"]});
        db.execute("INSERT INTO active VALUES(?,?) ON CONFLICT(native_id) DO UPDATE SET value=excluded.value",params![id,value.to_string()]).map_err(|e|e.to_string())?;
        // Promotion is local and durable; the daemon creates the server copy before uploads.
        for mut binding in db::rows(
            &db,
            "SELECT value FROM bindings WHERE json_extract(value,'$.nativeId')=?",
            &[&id],
        )? {
            if binding["base"]["owner"] != db::get(&db, "user")?
                && !binding["base"]["owner"].is_null()
            {
                binding["needsCopy"] = json!(true);
                db::upsert(
                    &db,
                    "bindings",
                    binding["base"]["resourceId"]
                        .as_str()
                        .ok_or("Missing resource")?,
                    project["id"].as_str().ok_or("Missing project")?,
                    &binding,
                )?;
            }
        }
    }
    if project["governed"] != true && !crate::projects::sharing_allowed(project, "memory") {
        return Ok(json!({}));
    }
    let delivery_key = format!("contextDelivery:{project_id}:{tool}:{id}");
    if matches!(event, "Stop" | "SessionEnd") {
        if event == "SessionEnd" {
            db::set(&db, &delivery_key, &Value::Null)?;
        }
        return Ok(json!({}));
    }
    let delivered = db::get(&db, &delivery_key)?;
    let (text, sources, fingerprints) = crate::governance::context_with_query(
        &db,
        project,
        Path::new(cwd),
        Some(input["prompt"].as_str().unwrap_or("")),
        // Missing session identities must never share a delivery cache.
        if id == "unknown" {
            None
        } else {
            Some(&delivered)
        },
    )?;
    if project["governed"] == true {
        let mut previous = db::rows(&db, "SELECT value FROM active WHERE native_id=?", &[&id])?
            .into_iter()
            .next()
            .unwrap_or(json!({}));
        let mut known = previous["contextSources"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for source in sources {
            if !known.contains(&source) {
                known.push(source);
            }
        }
        previous["contextSources"] = json!(known);
        db::set(
            &db,
            &format!("sessionSources:{project_id}:{id}"),
            &previous["contextSources"],
        )?;
        db.execute(
            "UPDATE active SET value=? WHERE native_id=?",
            params![previous.to_string(), id],
        )
        .map_err(|e| e.to_string())?;
    }
    if id != "unknown" {
        db::set(&db, &delivery_key, &fingerprints)?;
    }
    if text.is_empty() {
        return Ok(json!({}));
    }
    let content = format!("{text}\nNative provider: {tool}; sessionId: {id}.\n");
    Ok(
        json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":format!("Shared Orka project memory. Source labels are preserved; consult linked files for details.\n{content}")}}),
    )
}
