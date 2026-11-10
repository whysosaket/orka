//! Bounded discovery reads tool history, never project content.
use crate::{
    db::{self, Result},
    native,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

#[derive(Default)]
struct Candidate {
    tools: BTreeSet<String>,
    last: u64,
    sessions: usize,
}
struct Budget {
    start: Instant,
    files: usize,
    walked: usize,
    denied: bool,
    truncated: bool,
}
impl Budget {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            files: 0,
            walked: 0,
            denied: false,
            truncated: false,
        }
    }
    fn next(&mut self) -> bool {
        if self.files >= 2000 || self.start.elapsed() >= Duration::from_secs(5) {
            self.truncated = true;
            return false;
        }
        self.files += 1;
        true
    }
    fn tick(&mut self) -> bool {
        self.walked += 1;
        if self.walked > 20_000 || self.start.elapsed() >= Duration::from_secs(5) {
            self.truncated = true;
            return false;
        }
        true
    }
    fn entries(&mut self, path: &Path) -> Vec<fs::DirEntry> {
        match fs::read_dir(path) {
            Ok(entries) => entries.flatten().take(2001).collect(),
            Err(e) => {
                self.denied |= e.kind() == std::io::ErrorKind::PermissionDenied;
                vec![]
            }
        }
    }
}
fn modified(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|v| v.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|v| v.as_millis() as u64)
        .unwrap_or(0)
}
fn session_time(record: &Value) -> u64 {
    record["payload"]["timestamp"]
        .as_str()
        .or_else(|| record["timestamp"].as_str())
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .and_then(|value| u64::try_from(value.timestamp_millis()).ok())
        .unwrap_or(0)
}
fn project_root(path: &Path, home: &Path) -> Option<PathBuf> {
    let path = match fs::canonicalize(path) {
        Ok(path) => path,
        // Keep known history entries visible so the native picker can grant access.
        Err(e)
            if e.kind() == std::io::ErrorKind::PermissionDenied
                && path.is_absolute()
                && !path
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir)) =>
        {
            return Some(path.to_path_buf())
        }
        Err(_) => return None,
    };
    if fs::metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied) {
        return Some(path);
    }
    if !path.is_dir()
        || path == Path::new("/")
        || path == home
        || (!path.starts_with(home) && (path.starts_with("/tmp") || path.starts_with("/private")))
    {
        return None;
    }
    for parent in path.ancestors() {
        if parent == home || parent == Path::new("/") {
            break;
        }
        if parent.join(".git").exists() {
            return Some(parent.to_path_buf());
        }
    }
    Some(path)
}
fn add(
    found: &mut BTreeMap<PathBuf, Candidate>,
    path: &Path,
    home: &Path,
    tool: Option<&str>,
    last: u64,
    sessions: usize,
) {
    let Some(path) = project_root(path, home) else {
        return;
    };
    let item = found.entry(path).or_default();
    if let Some(tool) = tool {
        item.tools.insert(tool.into());
    }
    item.last = item.last.max(last);
    item.sessions += sessions;
}
fn cwd_record(path: &Path, codex: bool, budget: &mut Budget) -> Option<Value> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return None;
    }
    let file = match crate::history::reader(path) {
        Ok(f) => f,
        Err(_) => {
            budget.denied |= fs::File::open(path)
                .is_err_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied);
            return None;
        }
    };
    for line in BufReader::new(file.take(65_536))
        .lines()
        .map_while(std::result::Result::ok)
    {
        if let Ok(record) = serde_json::from_str::<Value>(&line) {
            if codex {
                return (record["type"] == "session_meta" && record["payload"]["cwd"].is_string())
                    .then_some(record);
            }
            if record["cwd"].is_string() {
                return Some(record);
            }
        }
    }
    None
}
fn claude(
    home: &Path,
    root: &Path,
    imported: &BTreeSet<String>,
    found: &mut BTreeMap<PathBuf, Candidate>,
    budget: &mut Budget,
) -> Result<()> {
    for folder in budget.entries(&root.join("projects")) {
        if !budget.tick() {
            break;
        }
        if !folder
            .file_type()
            .is_ok_and(|k| k.is_dir() && !k.is_symlink())
        {
            continue;
        }
        let mut files: Vec<_> = budget
            .entries(&folder.path())
            .into_iter()
            .filter(|f| {
                f.path().extension().is_some_and(|e| e == "jsonl")
                    && f.file_type().is_ok_and(|k| k.is_file())
            })
            .collect();
        files.sort_by_key(|f| std::cmp::Reverse(modified(&f.path())));
        for file in files {
            // Sync imports use their own native IDs and carry historical timestamps.
            if file
                .path()
                .file_stem()
                .and_then(|name| name.to_str())
                .is_some_and(|id| imported.contains(id))
            {
                continue;
            }
            if !budget.next() {
                break;
            }
            if let Some(record) = cwd_record(&file.path(), false, budget) {
                add(
                    found,
                    Path::new(record["cwd"].as_str().unwrap()),
                    home,
                    Some("claude"),
                    session_time(&record),
                    1,
                );
            }
        }
    }
    let config = home.join(".claude.json");
    if budget.next() {
        let file = if fs::symlink_metadata(&config).is_ok_and(|m| m.file_type().is_symlink()) {
            return Ok(());
        } else {
            fs::File::open(config)
        };
        if file
            .as_ref()
            .is_err_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied)
        {
            budget.denied = true;
        }
        if let Ok(file) = file {
            if let Ok(value) = serde_json::from_reader::<_, Value>(file.take(4_000_000)) {
                if let Some(projects) = value["projects"].as_object() {
                    for (path, data) in projects {
                        if !budget.next() {
                            break;
                        }
                        add(
                            found,
                            Path::new(path),
                            home,
                            Some("claude"),
                            data["lastSessionDate"].as_u64().unwrap_or(0),
                            0,
                        );
                    }
                }
            }
        }
    }
    Ok(())
}
fn codex_files(root: &Path, depth: usize, budget: &mut Budget, files: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let mut entries = budget.entries(root);
    entries.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
    for entry in entries {
        if files.len() >= 1000 || !budget.tick() {
            break;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            codex_files(&entry.path(), depth - 1, budget, files);
        } else if entry.file_name().to_string_lossy().starts_with("rollout-")
            && crate::history::is_session(&entry.path())
        {
            files.push(entry.path());
        }
    }
}
fn folder(
    root: &Path,
    depth: usize,
    found: &mut BTreeMap<PathBuf, Candidate>,
    home: &Path,
    budget: &mut Budget,
    top: bool,
) {
    if depth == 0 || found.len() >= 200 || !budget.next() {
        return;
    }
    if root.join(".git").exists()
        || (top && (root.join(".claude").is_dir() || root.join(".codex").is_dir()))
    {
        add(found, root, home, None, 0, 0);
    }
    for entry in budget.entries(root) {
        if found.len() >= 200 || !budget.next() {
            break;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.')
            || [
                "node_modules",
                "target",
                "vendor",
                "dist",
                "build",
                "Library",
            ]
            .contains(&name.as_ref())
        {
            continue;
        }
        if entry
            .file_type()
            .is_ok_and(|k| k.is_dir() && !k.is_symlink())
        {
            folder(&entry.path(), depth - 1, found, home, budget, false);
        }
    }
}
fn history(
    home: &Path,
    claude_root: &Path,
    codex_root: &Path,
    imported_claude: &BTreeSet<String>,
    found: &mut BTreeMap<PathBuf, Candidate>,
    budget: &mut Budget,
) -> Result<()> {
    claude(home, claude_root, imported_claude, found, budget)?;
    let mut files = vec![];
    codex_files(&codex_root.join("sessions"), 5, budget, &mut files);
    files.sort_by_key(|p| std::cmp::Reverse(modified(p)));
    for file in files.into_iter().take(1000) {
        if !budget.next() {
            break;
        }
        if let Some(record) = cwd_record(&file, true, budget) {
            add(
                found,
                Path::new(record["payload"]["cwd"].as_str().unwrap()),
                home,
                Some("codex"),
                session_time(&record),
                1,
            );
        }
    }
    Ok(())
}
pub fn discover(path: Option<&str>) -> Result<Value> {
    let home = db::home()?;
    let db = db::open()?;
    let mut found = BTreeMap::new();
    let mut budget = Budget::new();
    if let Some(path) = path {
        let root = fs::canonicalize(path)
            .map_err(|_| "Orka couldn’t read this folder. Choose it again to give Orka access.")?;
        if !root.is_dir() {
            return Err("Choose a project folder".into());
        }
        folder(&root, 4, &mut found, &home, &mut budget, true);
        if found.is_empty() && !budget.denied {
            add(&mut found, &root, &home, None, 0, 0);
        }
    } else {
        let imported = db::rows(
            &db,
            "SELECT value FROM meta WHERE key GLOB 'claudeImport:*'",
            &[],
        )?
        .iter()
        .filter_map(|receipt| receipt["id"].as_str().map(str::to_owned))
        .collect();
        history(
            &home,
            &native::claude_home()?,
            &native::codex_home()?,
            &imported,
            &mut found,
            &mut budget,
        )?;
    }
    if found.is_empty() && budget.denied {
        return Err("Orka couldn’t read your coding history. Check Privacy & Security in System Settings, or choose a folder instead.".into());
    }
    let connected = db::rows(
        &db,
        &format!(
            "SELECT json_set(value,'$.pendingChanges',(SELECT count(*) FROM outbox WHERE project=projects.id)) FROM projects WHERE {}",
            crate::projects::ACTIVE
        ),
        &[],
    )?;
    let connected_folders: BTreeMap<_, _> = connected
        .iter()
        .flat_map(|project| {
            let pending = project["pendingChanges"].as_u64().unwrap_or(0);
            crate::sources::views(project)
                .into_iter()
                .filter_map(move |view| Some((PathBuf::from(view["path"].as_str()?), pending)))
        })
        .collect();
    let projects: Vec<Value> = found.into_iter().map(|(path, c)| {
        let display = path.strip_prefix(&home).map(|p| format!("~/{}", p.display())).unwrap_or_else(|_| path.display().to_string());
        json!({"name":path.file_name().unwrap_or_default().to_string_lossy(),"path":path,"displayPath":display,"sources":c.tools,"lastActiveAt":c.last,"sessions":c.sessions,"readable":fs::read_dir(&path).is_ok(),"alreadyConnected":connected_folders.contains_key(&path),"pendingChanges":connected_folders.get(&path).copied().unwrap_or(0)})
    }).collect();
    if budget.truncated {
        eprintln!("Some history was skipped (onboarding discovery budget)");
    }
    Ok(
        json!({"projects":projects,"tools":{"claude":native::binary("claude").is_ok(),"codex":native::binary("codex").is_ok()},"truncated":budget.truncated}),
    )
}

pub fn normalize_remote(raw: &str) -> Option<String> {
    let raw = raw.trim().trim_end_matches('/').trim_end_matches(".git");
    let url = if raw.contains("://") {
        reqwest::Url::parse(raw).ok()?
    } else {
        let (host, path) = raw.split_once(':')?;
        reqwest::Url::parse(&format!("ssh://{}/{}", host.rsplit('@').next()?, path)).ok()?
    };
    if !["https", "http", "ssh", "git"].contains(&url.scheme()) {
        return None;
    }
    let mut host = url.host_str()?.to_lowercase();
    let path = url.path().trim_matches('/').trim_end_matches(".git");
    let path = if host == "github.com" {
        path.to_lowercase()
    } else {
        path.to_string()
    };
    if let Some(port) = url
        .port()
        .filter(|port| !matches!((url.scheme(), *port), ("ssh", 22) | ("git", 9418)))
    {
        host = format!("{host}:{port}");
    }
    if path.is_empty() {
        return None;
    }
    Some(format!("{host}/{path}"))
}
pub fn remote_key(path: &str) -> Result<Option<String>> {
    let root = fs::canonicalize(path).map_err(|_| "Project folder is unavailable")?;
    let git = root.join(".git");
    let directory = if git.is_file() {
        let value = fs::read_to_string(&git).map_err(|e| e.to_string())?;
        let target = value
            .trim()
            .strip_prefix("gitdir:")
            .ok_or("Invalid Git directory")?
            .trim();
        root.join(target)
    } else {
        git
    };
    let config = if directory.join("config").is_file() {
        directory.join("config")
    } else if let Ok(common) = fs::read_to_string(directory.join("commondir")) {
        directory.join(common.trim()).join("config")
    } else {
        return Ok(None);
    };
    let file = fs::File::open(config).map_err(|e| e.to_string())?;
    let mut remote = None;
    let mut origin = None;
    let mut current = String::new();
    for line in BufReader::new(file.take(1_000_000))
        .lines()
        .map_while(std::result::Result::ok)
    {
        let line = line.trim();
        if line.starts_with('[') {
            current = line.to_string();
        } else if current.starts_with("[remote ") {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "url" {
                    let value = value.trim().trim_matches('"').to_string();
                    if remote.is_none() {
                        remote = Some(value.clone());
                    }
                    if current == "[remote \"origin\"]" {
                        origin = Some(value);
                    }
                }
            }
        }
    }
    Ok(origin
        .or(remote)
        .and_then(|v| normalize_remote(&v))
        .map(|v| db::digest(format!("orka-remote-v1:{v}").as_bytes())))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_identity_is_transport_independent() {
        for value in [
            "https://GitHub.com/Owner/Repo.git/",
            "ssh://git@github.com:22/OWNER/repo.git",
            "git@github.com:owner/repo.git",
            "https://user:password@github.com:443/owner/repo",
        ] {
            assert_eq!(
                normalize_remote(value),
                Some("github.com/owner/repo".into())
            );
        }
        assert_eq!(normalize_remote("/local/repo"), None);
        assert_eq!(normalize_remote("file:///local/repo"), None);
    }
    #[test]
    fn private_remote_identity_preserves_non_default_ports_and_path_case() {
        let first = normalize_remote("ssh://git@git.example.test:2222/team/Repo.git");
        assert_eq!(first.as_deref(), Some("git.example.test:2222/team/Repo"));
        assert_ne!(
            first,
            normalize_remote("ssh://git@git.example.test:2223/team/Repo.git")
        );
        assert_ne!(
            first,
            normalize_remote("ssh://git@git.example.test:2222/team/repo.git")
        );
        for remote in [
            "ssh://git@git.example.test:22/team/Repo.git",
            "git@git.example.test:team/Repo.git",
            "https://git.example.test:443/team/Repo.git",
            "git://git.example.test:9418/team/Repo.git",
        ] {
            assert_eq!(
                normalize_remote(remote).as_deref(),
                Some("git.example.test/team/Repo")
            );
        }
        assert_eq!(
            normalize_remote("https://git.example.test:8443/team/Repo.git").as_deref(),
            Some("git.example.test:8443/team/Repo")
        );
    }
    #[test]
    fn worktree_reads_common_config() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("main/.git/worktrees/feature")).unwrap();
        fs::create_dir_all(root.join("feature")).unwrap();
        fs::write(
            root.join("feature/.git"),
            "gitdir: ../main/.git/worktrees/feature\n",
        )
        .unwrap();
        fs::write(
            root.join("main/.git/worktrees/feature/commondir"),
            "../..\n",
        )
        .unwrap();
        fs::write(
            root.join("main/.git/config"),
            "[remote \"origin\"]\n url = git@github.com:owner/repo.git\n",
        )
        .unwrap();
        assert_eq!(
            remote_key(root.join("feature").to_str().unwrap()).unwrap(),
            Some(db::digest(b"orka-remote-v1:github.com/owner/repo"))
        );
    }
    #[test]
    fn claude_finds_cwd_after_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("a.jsonl");
        fs::write(
            &file,
            "{\"type\":\"summary\"}\n{\"cwd\":\"/Users/test/project\"}\n",
        )
        .unwrap();
        assert_eq!(
            cwd_record(&file, false, &mut Budget::new()).unwrap()["cwd"],
            "/Users/test/project"
        );
    }
    #[test]
    fn imported_claude_history_does_not_count_as_local_activity() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let project = home.join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        let claude_home = home.join(".claude");
        let transcripts = claude_home.join("projects/project");
        fs::create_dir_all(&transcripts).unwrap();
        for (id, date) in [
            ("local", "2026-01-01T00:00:00Z"),
            ("imported", "2026-02-01T00:00:00Z"),
        ] {
            fs::write(
                transcripts.join(format!("{id}.jsonl")),
                format!("{}\n", json!({"cwd":project, "timestamp":date})),
            )
            .unwrap();
        }
        let mut found = BTreeMap::new();
        claude(
            &home,
            &claude_home,
            &BTreeSet::from(["imported".into()]),
            &mut found,
            &mut Budget::new(),
        )
        .unwrap();
        assert_eq!(found[&project].last, 1_767_225_600_000);
        assert_eq!(found[&project].sessions, 1);
    }
    #[test]
    fn compressed_codex_history_is_discovered_without_changing_the_source() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let project = home.join("compressed-project");
        fs::create_dir_all(project.join(".git")).unwrap();
        let codex = home.join(".codex");
        let sessions = codex.join("sessions/2026/10/21");
        fs::create_dir_all(&sessions).unwrap();
        let source = sessions.join("rollout-compressed.jsonl.zst");
        let bytes = zstd::stream::encode_all(
            format!(
                "{}\n",
                json!({"type":"session_meta","payload":{"cwd":project}})
            )
            .as_bytes(),
            1,
        )
        .unwrap();
        fs::write(&source, &bytes).unwrap();
        fs::write(sessions.join("rollout-corrupt.jsonl.zst"), b"invalid zstd").unwrap();
        let mut found = BTreeMap::new();
        history(
            &home,
            &home.join(".claude"),
            &codex,
            &BTreeSet::new(),
            &mut found,
            &mut Budget::new(),
        )
        .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[&project].sessions, 1);
        assert!(found[&project].tools.contains("codex"));
        assert_eq!(fs::read(source).unwrap(), bytes);
    }
    #[test]
    fn five_projects_merge_tools_collapse_subfolders_and_stay_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let claude = home.join(".claude");
        let codex = home.join(".codex");
        fs::create_dir_all(codex.join("sessions/2026/10/21")).unwrap();
        for n in 0..5 {
            let project = home.join(format!("project-{n}"));
            fs::create_dir_all(project.join(".git")).unwrap();
            fs::create_dir_all(project.join("src")).unwrap();
            fs::write(
                project.join("never-read.txt"),
                "not valid JSON; discovery must never open this",
            )
            .unwrap();
            let dir = claude.join(format!("projects/encoded-{n}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("session.jsonl"),
                format!(
                    "{{\"type\":\"summary\"}}\n{}\n",
                    json!({"cwd":project.join("src")})
                ),
            )
            .unwrap();
            fs::write(
                codex.join(format!("sessions/2026/10/21/rollout-{n}.jsonl")),
                format!(
                    "{}\n",
                    json!({"type":"session_meta","payload":{"cwd":project}})
                ),
            )
            .unwrap();
        }
        let mut found = BTreeMap::new();
        let mut budget = Budget::new();
        history(
            &home,
            &claude,
            &codex,
            &BTreeSet::new(),
            &mut found,
            &mut budget,
        )
        .unwrap();
        assert_eq!(found.len(), 5);
        assert!(found
            .values()
            .all(|p| p.tools.len() == 2 && p.sessions == 2));
        assert!(budget.start.elapsed() < Duration::from_secs(5));
        for path in found.keys() {
            assert!(!path.join(".orka").exists());
            assert_eq!(
                fs::read_to_string(path.join("never-read.txt")).unwrap(),
                "not valid JSON; discovery must never open this"
            );
        }
    }
    #[test]
    fn folder_search_stops_at_three_levels_and_ignores_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        fs::create_dir_all(home.join("projects/one/two/three/.git")).unwrap();
        fs::create_dir_all(home.join("projects/one/two/three/four/.git")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(outside.path().join(".git")).unwrap();
        std::os::unix::fs::symlink(outside.path(), home.join("projects/linked")).unwrap();
        let mut found = BTreeMap::new();
        folder(
            &home.join("projects"),
            4,
            &mut found,
            &home,
            &mut Budget::new(),
            true,
        );
        assert_eq!(found.len(), 1);
    }
}
