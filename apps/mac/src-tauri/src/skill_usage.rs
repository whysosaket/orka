use crate::{
    db::{self, Result},
    global_skills, governance, native, packages,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::UNIX_EPOCH,
};
use walkdir::WalkDir;

const MAX_RECORD: u64 = 2 * 1024 * 1024;
const GUARD_BYTES: u64 = 4096;
static LOCK: Mutex<()> = Mutex::new(());
static READ_COMMAND: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?:^|[;|&\n])\s*(?:cat|head|tail|sed)\s+([^;|&\n<>]+)").unwrap()
});
static SKILL_PATH: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r#"(?:"([^"\n]*SKILL\.md)"|'([^'\n]*SKILL\.md)'|((?:[^\s"'`<>]*/)?SKILL\.md))"#,
    )
    .unwrap()
});
static NESTED_COMMAND: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"\b(?:cmd|command)\s*:\s*("(?:\\.|[^"\\])*")"#).unwrap());
static FAILED_OUTPUT: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r#"(?i)(?:exit code:|exited with code|"exit_code"\s*:)\s*[1-9]|script error:"#,
    )
    .unwrap()
});

#[derive(Clone, Deserialize, Serialize)]
struct Event {
    id: String,
    chat: String,
    key: String,
}
#[derive(Deserialize, Serialize)]
struct ParserState {
    events: Vec<Event>,
    pending: BTreeMap<String, Vec<String>>,
    chat: String,
    cwd: PathBuf,
    partial: bool,
    skipping_record: bool,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct FileStamp {
    length: u64,
    modified: u128,
    changed: (i64, i64),
    device: u64,
    inode: u64,
}
impl FileStamp {
    fn same_file(&self, other: &Self) -> bool {
        self.device == other.device && self.inode == other.inode
    }
}
#[derive(Deserialize, Eq, PartialEq, Serialize)]
struct Guards {
    head: String,
    tail: String,
}
#[derive(Deserialize, Serialize)]
struct CachedFile {
    stamp: FileStamp,
    offset: u64,
    guards: Guards,
    state: ParserState,
}
#[derive(Serialize)]
pub struct Usage {
    counts: BTreeMap<String, usize>,
    partial: bool,
}

struct Homes {
    home: PathBuf,
    codex: PathBuf,
    claude: PathBuf,
}
impl Homes {
    fn current() -> Result<Self> {
        Ok(Self {
            home: db::home()?,
            codex: native::codex_home()?,
            claude: native::claude_home()?,
        })
    }
    fn skill_key(&self, raw: &str, cwd: &Path) -> Option<String> {
        let path = raw
            .replace("${CODEX_HOME}", &self.codex.to_string_lossy())
            .replace("$CODEX_HOME", &self.codex.to_string_lossy())
            .replace("${CLAUDE_CONFIG_DIR}", &self.claude.to_string_lossy())
            .replace("$CLAUDE_CONFIG_DIR", &self.claude.to_string_lossy())
            .replace("${HOME}", &self.home.to_string_lossy())
            .replace("$HOME", &self.home.to_string_lossy());
        let path = path
            .strip_prefix("~/")
            .map(|p| self.home.join(p))
            .unwrap_or_else(|| PathBuf::from(&path));
        let path = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        if path.file_name()? != "SKILL.md" {
            return None;
        }
        let folder = path.parent()?;
        let folder = folder
            .canonicalize()
            .unwrap_or_else(|_| folder.to_path_buf());
        Some(format!("path:{}", folder.display()))
    }
    fn reads(&self, command: &str, cwd: &Path) -> Vec<String> {
        if command.contains("<<") {
            return vec![];
        }
        READ_COMMAND
            .captures_iter(command)
            .flat_map(|read| {
                SKILL_PATH
                    .captures_iter(&read[1])
                    .filter_map(|path| {
                        self.skill_key(path.iter().skip(1).flatten().next()?.as_str(), cwd)
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    }
}

fn command_keys(payload: &Value, homes: &Homes, cwd: &Path) -> Vec<String> {
    let name = payload["name"]
        .as_str()
        .unwrap_or("")
        .rsplit('.')
        .next()
        .unwrap_or("");
    let raw = payload["arguments"]
        .as_str()
        .or(payload["input"].as_str())
        .unwrap_or("");
    if matches!(name, "exec_command" | "shell_command" | "shell") {
        if let Ok(args) = serde_json::from_str::<Value>(raw) {
            let cwd = args["workdir"]
                .as_str()
                .or(args["cwd"].as_str())
                .map(Path::new)
                .unwrap_or(cwd);
            if let Some(command) = args["cmd"].as_str().or(args["command"].as_str()) {
                return homes.reads(command, cwd);
            }
            if let Some(command) = args["command"].as_array() {
                return homes.reads(command.last().and_then(Value::as_str).unwrap_or(""), cwd);
            }
        }
    }
    if name == "exec" {
        return NESTED_COMMAND
            .captures_iter(raw)
            .filter_map(|capture| serde_json::from_str::<String>(&capture[1]).ok())
            .flat_map(|command| homes.reads(&command, cwd))
            .collect();
    }
    vec![]
}

fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.split_once(&format!("<{name}>"))?
        .1
        .split_once(&format!("</{name}>"))
        .map(|(value, _)| value.trim())
}

fn parse(
    reader: &mut impl BufRead,
    source: &str,
    homes: &Homes,
    state: &mut ParserState,
    mut offset: u64,
) -> Result<u64> {
    let ParserState {
        events,
        pending,
        chat,
        cwd,
        partial,
        skipping_record,
    } = state;
    loop {
        if *skipping_record {
            let bytes = reader.fill_buf().map_err(|e| e.to_string())?;
            if bytes.is_empty() {
                break;
            }
            let length = bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(bytes.len(), |index| index + 1);
            *skipping_record = bytes[length - 1] != b'\n';
            reader.consume(length);
            offset += length as u64;
            continue;
        }
        let mut bytes = Vec::new();
        let length = Read::by_ref(reader)
            .take(MAX_RECORD + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|e| e.to_string())?;
        if length == 0 {
            break;
        }
        let complete = bytes.last() == Some(&b'\n');
        if length as u64 > MAX_RECORD {
            offset += length as u64;
            *skipping_record = !complete;
            *partial = true;
            continue;
        }
        if !complete {
            break;
        }
        offset += length as u64;
        let Ok(line) = std::str::from_utf8(&bytes) else {
            *partial = true;
            continue;
        };
        if !line.contains("SKILL.md")
            && !line.contains("\"Skill\"")
            && !line.contains("session_meta")
            && !line.contains("turn_context")
            && !pending.keys().any(|id| line.contains(id))
        {
            continue;
        }
        let r: Value = match serde_json::from_slice(&bytes) {
            Ok(r) => r,
            Err(_) => {
                *partial = true;
                continue;
            }
        };
        let p = &r["payload"];
        if r["type"] == "session_meta" {
            if let Some(id) = p["id"].as_str() {
                *chat = id.into();
            }
        }
        if let Some(path) = r["cwd"].as_str().or(p["cwd"].as_str()) {
            *cwd = PathBuf::from(path);
        }
        if let Some(id) = r["sessionId"].as_str() {
            *chat = id.into();
        }
        let mut record = |id: &str, keys: Vec<String>| {
            for key in keys {
                events.push(Event {
                    id: format!("{source}:{id}:{key}"),
                    chat: format!("{source}:{chat}"),
                    key,
                });
            }
        };
        if source == "codex" && r["type"] == "response_item" {
            match p["type"].as_str().unwrap_or("") {
                "message" if p["role"] == "user" => {
                    for block in p["content"].as_array().into_iter().flatten() {
                        let text = block["text"].as_str().unwrap_or("").trim_start();
                        if text.starts_with("<skill>") {
                            if let Some(key) =
                                tag(text, "path").and_then(|path| homes.skill_key(path, cwd))
                            {
                                record(
                                    p["id"].as_str().unwrap_or(&db::digest(line.as_bytes())),
                                    vec![key],
                                );
                            }
                        }
                    }
                }
                "function_call" | "custom_tool_call" => {
                    if let Some(id) = p["call_id"].as_str() {
                        let keys = command_keys(p, homes, cwd);
                        if !keys.is_empty() {
                            pending.insert(id.into(), keys);
                        }
                    }
                }
                "function_call_output" | "custom_tool_call_output" => {
                    if let Some((id, keys)) = p["call_id"]
                        .as_str()
                        .and_then(|id| pending.remove(id).map(|keys| (id, keys)))
                    {
                        let output = p["output"].as_str().unwrap_or("");
                        if !FAILED_OUTPUT.is_match(output) {
                            record(id, keys);
                        }
                    }
                }
                _ => (),
            }
        }
        if source == "claude" {
            for block in r["message"]["content"].as_array().into_iter().flatten() {
                if r["type"] == "assistant" && block["type"] == "tool_use" {
                    let keys = match block["name"].as_str().unwrap_or("") {
                        "Skill" => block["input"]["skill"]
                            .as_str()
                            .map(|name| vec![format!("claude:{name}")])
                            .unwrap_or_default(),
                        "Read" => block["input"]["file_path"]
                            .as_str()
                            .and_then(|path| homes.skill_key(path, cwd))
                            .into_iter()
                            .collect(),
                        "Bash" => {
                            homes.reads(block["input"]["command"].as_str().unwrap_or(""), cwd)
                        }
                        _ => vec![],
                    };
                    if let Some(id) = block["id"].as_str().filter(|_| !keys.is_empty()) {
                        pending.insert(id.into(), keys);
                    }
                } else if r["type"] == "user" && block["type"] == "tool_result" {
                    if let Some((id, keys)) = block["tool_use_id"]
                        .as_str()
                        .and_then(|id| pending.remove(id).map(|keys| (id, keys)))
                    {
                        if block["is_error"] != true {
                            record(id, keys);
                        }
                    }
                }
            }
        }
    }
    Ok(offset)
}

fn stamp(metadata: &fs::Metadata) -> Result<FileStamp> {
    use std::os::unix::fs::MetadataExt;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("History is not a regular file".into());
    }
    Ok(FileStamp {
        length: metadata.len(),
        modified: metadata
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos(),
        changed: (metadata.ctime(), metadata.ctime_nsec()),
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

fn guards(reader: &mut (impl Read + Seek), length: u64) -> Result<Guards> {
    let size = length.min(GUARD_BYTES) as usize;
    let mut bytes = vec![0; size];
    reader.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    let head = db::digest(&bytes);
    reader
        .seek(SeekFrom::Start(length - size as u64))
        .map_err(|e| e.to_string())?;
    reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    Ok(Guards {
        head,
        tail: db::digest(&bytes),
    })
}

fn update(
    reader: &mut (impl Read + Seek),
    stamp: FileStamp,
    cached: Option<CachedFile>,
    source: &str,
    homes: &Homes,
    path: &Path,
) -> Result<CachedFile> {
    let cached = match cached {
        Some(cached) if cached.stamp == stamp => return Ok(cached),
        cached => cached,
    };
    let original = guards(reader, stamp.length)?;
    let cached = match cached {
        Some(cached)
            if cached.stamp.same_file(&stamp)
                && stamp.length > cached.stamp.length
                && cached.offset <= cached.stamp.length
                && guards(reader, cached.stamp.length)? == cached.guards =>
        {
            Some(cached)
        }
        _ => None,
    };
    let (offset, mut state) = cached
        .map(|cached| (cached.offset, cached.state))
        .unwrap_or_else(|| {
            (
                0,
                ParserState {
                    events: vec![],
                    pending: BTreeMap::new(),
                    chat: path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    cwd: homes.home.clone(),
                    partial: false,
                    skipping_record: false,
                },
            )
        });
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let offset = parse(
        &mut BufReader::new(Read::by_ref(reader).take(stamp.length - offset)),
        source,
        homes,
        &mut state,
        offset,
    )?;
    if guards(reader, stamp.length)? != original {
        return Err("History changed during usage scan".into());
    }
    Ok(CachedFile {
        stamp,
        offset,
        guards: original,
        state,
    })
}

fn read_cached(db: &Connection, path: &Path, source: &str, homes: &Homes) -> Result<CachedFile> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| e.to_string())?;
    let before = stamp(&file.metadata().map_err(|e| e.to_string())?)?;
    let key = format!(
        "skill-usage:v2:{}",
        db::digest(path.to_string_lossy().as_bytes())
    );
    let cached = serde_json::from_value::<CachedFile>(db::get(db, &key)?).ok();
    let unchanged = cached.as_ref().is_some_and(|cached| cached.stamp == before);
    let result = update(&mut file, before.clone(), cached, source, homes, path)?;
    let after = stamp(&file.metadata().map_err(|e| e.to_string())?)?;
    let current = stamp(&fs::symlink_metadata(path).map_err(|e| e.to_string())?)?;
    if !before.same_file(&current)
        || after.length < before.length
        || (after.length == before.length && after != before)
    {
        return Err("History changed during usage scan".into());
    }
    if !unchanged {
        db::set(
            db,
            &key,
            &serde_json::to_value(&result).map_err(|e| e.to_string())?,
        )?;
    }
    Ok(result)
}

fn history_events(db: &Connection) -> Result<(BTreeMap<String, Event>, bool)> {
    let homes = Homes::current()?;
    let roots = [
        ("codex", homes.codex.join("sessions")),
        ("codex", homes.codex.join("archived_sessions")),
        ("claude", homes.claude.join("projects")),
    ];
    let mut events: BTreeMap<String, Event> = BTreeMap::new();
    let mut partial = false;
    for (source, root) in roots {
        match fs::symlink_metadata(&root) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => (),
            _ => {
                partial = true;
                continue;
            }
        }
        for entry in WalkDir::new(root).follow_links(false).sort_by_file_name() {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    partial = true;
                    continue;
                }
            };
            if !entry.file_type().is_file()
                || entry.path().extension().is_none_or(|ext| ext != "jsonl")
            {
                continue;
            }
            let result = read_cached(db, entry.path(), source, &homes);
            match result {
                Ok(cached) => {
                    partial |= cached.state.partial || cached.offset < cached.stamp.length;
                    for event in cached.state.events {
                        events.entry(event.id.clone()).or_insert(event);
                    }
                }
                Err(_) => partial = true,
            }
        }
    }
    Ok((events, partial))
}

pub fn collect(db: &Connection, skills: &[global_skills::GlobalSkill]) -> Result<Usage> {
    let (events, partial) = history_events(db)?;
    let mut counts = BTreeMap::new();
    for skill in skills {
        let path_key = format!("path:{}", skill.path.display());
        let name_key = format!("claude:{}", skill.name);
        let unambiguous = skill.sources.iter().any(|source| source == "claude")
            && skills
                .iter()
                .filter(|s| {
                    s.name == skill.name && s.sources.iter().any(|source| source == "claude")
                })
                .count()
                == 1;
        let chats = events
            .values()
            .filter(|event| event.key == path_key || (unambiguous && event.key == name_key))
            .map(|event| &event.chat)
            .collect::<BTreeSet<_>>();
        counts.insert(skill.id.clone(), chats.len());
    }
    Ok(Usage { counts, partial })
}

pub fn collect_project(db: &Connection, project: &Value) -> Result<Usage> {
    if project["sources"].is_array() && !project["sourceId"].is_string() {
        let mut counts = BTreeMap::new();
        let mut partial = false;
        for source in crate::sources::views(project)
            .into_iter()
            .filter(|source| source["path"].is_string())
        {
            let usage = collect_project(db, &source)?;
            counts.extend(usage.counts);
            partial |= usage.partial;
        }
        return Ok(Usage { counts, partial });
    }
    let root = Path::new(
        project["path"]
            .as_str()
            .ok_or("Connect a project folder to check skill usage.")?,
    );
    let homes = Homes::current()?;
    let (events, partial) = history_events(db)?;
    let mut counts = BTreeMap::new();
    let mut resources = db::rows(
        db,
        "SELECT value FROM resources WHERE project=?",
        &[&project["id"].as_str().ok_or("Missing project")?],
    )?;
    resources.extend(crate::global_skills::local_skills(db, project)?);
    for resource in resources {
        if !crate::sources::matches(project, &resource) {
            continue;
        }
        if resource["kind"] != "skill" || resource["deleted"] == true {
            continue;
        }
        let (Some(id), Some(logical)) = (
            resource["resourceId"].as_str(),
            resource["logicalPath"].as_str(),
        ) else {
            continue;
        };
        packages::safe_relative(logical)?;
        let keys: BTreeSet<_> = [".agents/skills", ".claude/skills"]
            .into_iter()
            .filter_map(|folder| {
                homes.skill_key(
                    &root
                        .join(folder)
                        .join(logical)
                        .join("SKILL.md")
                        .to_string_lossy(),
                    root,
                )
            })
            .collect();
        let chats: BTreeSet<_> = events
            .values()
            .filter(|event| keys.contains(&event.key))
            .map(|event| &event.chat)
            .collect();
        counts.insert(id.into(), chats.len());
    }
    Ok(Usage { counts, partial })
}

#[tauri::command]
pub async fn project_skill_usage(project_id: String) -> Result<Usage> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = LOCK
            .lock()
            .map_err(|_| "Usage scan unavailable. Try again.")?;
        let db = db::open()?;
        let project = governance::project(&db, &project_id)?;
        collect_project(&db, &project)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn global_skill_usage(project_id: String) -> Result<Usage> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = LOCK
            .lock()
            .map_err(|_| "Usage scan unavailable. Try again.")?;
        let db = db::open()?;
        let project = governance::project(&db, &project_id)?;
        let skills = global_skills::scan(&db, &project)?.skills;
        collect(&db, &skills)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod incremental_tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    struct MeasuredReader {
        cursor: Cursor<Vec<u8>>,
        bytes_read: usize,
    }
    impl Read for MeasuredReader {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            let read = self.cursor.read(bytes)?;
            self.bytes_read += read;
            Ok(read)
        }
    }
    impl Seek for MeasuredReader {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.cursor.seek(position)
        }
    }
    fn metadata(length: usize, revision: u128) -> FileStamp {
        FileStamp {
            length: length as u64,
            modified: revision,
            changed: (revision as i64, 0),
            device: 1,
            inode: 1,
        }
    }
    fn homes() -> Homes {
        Homes {
            home: "/test".into(),
            codex: "/test/.codex".into(),
            claude: "/test/.claude".into(),
        }
    }
    fn lines(records: &[Value]) -> Vec<u8> {
        records
            .iter()
            .map(|record| format!("{record}\n"))
            .collect::<String>()
            .into_bytes()
    }
    #[test]
    fn skill_usage_append_reads_only_the_tail_and_bounded_guards_after_restart() {
        let mut bytes = lines(&[
            json!({"type":"session_meta","payload":{"id":"original-chat","cwd":"/test/.codex/skills/example"}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"pending-load","name":"exec_command","arguments":"{\"cmd\":\"cat SKILL.md\"}"}}),
        ]);
        bytes.extend(
            format!("{{\"text\":\"{}\"}}\n", "x".repeat(1000))
                .repeat(5000)
                .as_bytes(),
        );
        let mut reader = MeasuredReader {
            cursor: Cursor::new(bytes.clone()),
            bytes_read: 0,
        };
        let checkpoint = update(
            &mut reader,
            metadata(bytes.len(), 1),
            None,
            "codex",
            &homes(),
            Path::new("chat.jsonl"),
        )
        .unwrap();
        assert_eq!(checkpoint.offset, bytes.len() as u64);
        assert!(checkpoint.state.events.is_empty());
        assert_eq!(checkpoint.state.pending.len(), 1);
        let checkpoint = serde_json::from_slice(&serde_json::to_vec(&checkpoint).unwrap()).unwrap();
        let appended = lines(&[
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"pending-load","output":"Exit code: 0\nInstructions"}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"second-load","name":"exec_command","arguments":"{\"cmd\":\"cat SKILL.md\"}"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"second-load","output":"Exit code: 0"}}),
        ]);
        bytes.extend(&appended);
        let mut reader = MeasuredReader {
            cursor: Cursor::new(bytes.clone()),
            bytes_read: 0,
        };
        let checkpoint = update(
            &mut reader,
            metadata(bytes.len(), 2),
            Some(checkpoint),
            "codex",
            &homes(),
            Path::new("chat.jsonl"),
        )
        .unwrap();
        assert!(reader.bytes_read <= appended.len() + 6 * GUARD_BYTES as usize);
        assert_eq!(checkpoint.state.events.len(), 2);
        assert!(checkpoint.state.pending.is_empty());
        assert!(checkpoint
            .state
            .events
            .iter()
            .all(|event| event.chat == "codex:original-chat"
                && event.key == "path:/test/.codex/skills/example"));
        assert_eq!(checkpoint.offset, bytes.len() as u64);
        reader.bytes_read = 0;
        update(
            &mut reader,
            metadata(bytes.len(), 2),
            Some(checkpoint),
            "codex",
            &homes(),
            Path::new("chat.jsonl"),
        )
        .unwrap();
        assert_eq!(reader.bytes_read, 0);
    }
    #[test]
    fn skill_usage_snapshot_does_not_read_entries_appended_after_its_boundary() {
        let first = lines(&[json!({"type":"session_meta","payload":{"id":"before"}})]);
        let mut bytes = first.clone();
        bytes.extend(lines(&[
            json!({"type":"session_meta","payload":{"id":"after"}}),
        ]));
        let cached = update(
            &mut Cursor::new(bytes),
            metadata(first.len(), 1),
            None,
            "codex",
            &homes(),
            Path::new("chat.jsonl"),
        )
        .unwrap();
        assert_eq!(cached.offset, first.len() as u64);
        assert_eq!(cached.state.chat, "before");
    }
}
