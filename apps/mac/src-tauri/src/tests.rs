use crate::{bundles, db, history::History, indexer, native, packages, sync};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
static SERIAL: Mutex<()> = Mutex::new(());
#[path = "context_sharing_tests.rs"]
mod context_sharing_tests;
#[path = "global_skill_tests.rs"]
mod global_skill_tests;
#[path = "governance_tests.rs"]
mod governance_tests;
#[path = "memory_context_tests.rs"]
mod memory_context_tests;
#[path = "plan_tests.rs"]
mod plan_tests;
#[path = "repository_tests.rs"]
mod repository_tests;
#[path = "selective_sharing_tests.rs"]
mod selective_sharing_tests;
#[path = "session_compatibility_tests.rs"]
mod session_compatibility_tests;
#[path = "session_launcher_tests.rs"]
mod session_launcher_tests;
#[path = "sharing_tests.rs"]
mod sharing_tests;
#[path = "source_tests.rs"]
mod source_tests;

#[test]
fn disabled_env_commands_stop_before_credentials_network_and_file_access() {
    if crate::env::enabled() {
        return;
    }
    let f = Fixture::new();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for action in [
        "capabilities",
        "enable",
        "list",
        "import",
        "pull",
        "publish",
        "reveal",
        "preview",
        "apply",
        "approve",
        "approval_info",
        "request",
        "access",
        "retry",
        "discard",
        "delete",
        "compare",
        "rebase",
        "exclude",
    ] {
        assert_eq!(
            runtime
                .block_on(crate::env::env_command(action.into(), json!({})))
                .unwrap_err(),
            "ENV support is disabled",
            "{action} must stop before reading credentials or validating input"
        );
    }
    assert_eq!(
        runtime
            .block_on(crate::env::env_command("clear".into(), json!({})))
            .unwrap(),
        json!({})
    );
    for action in [
        "request-access",
        "policy",
        "inherit",
        "access",
        "replace-env",
    ] {
        assert_eq!(
            runtime
                .block_on(crate::governance::governance_command(
                    action.into(),
                    json!({"class":"env"})
                ))
                .unwrap_err(),
            "ENV support is disabled"
        );
    }
    assert_eq!(
        runtime
            .block_on(crate::governance::governance_command(
                "request-access".into(),
                json!({"class":"skill"})
            ))
            .unwrap_err(),
        "Choose a project"
    );
    assert!(f.outbox().is_empty());
}

#[test]
fn disabled_env_ignores_saved_opt_in_and_preserves_pending_data() {
    if crate::env::enabled() {
        return;
    }
    let f = Fixture::new();
    let mut project = f.project.clone();
    project["sharing"] = json!({"env":true,"memory":true,"skill":true,"session":true,"plan":true});
    let id = project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", id, "", &project).unwrap();
    assert!(!crate::projects::sharing_allowed(&project, "env"));
    assert!(!crate::projects::sharing_allowed(&f.project, "env"));
    assert!(crate::projects::sharing_allowed(&project, "skill"));
    let pending =
        json!({"header":{"manifest":{"projectId":id}},"ciphertext":"retained encrypted payload"});
    db::set(&f.db, "env:test:pending:publication", &pending).unwrap();
    let snapshot = crate::commands::snapshot().unwrap();
    assert_eq!(snapshot["managedProjects"][0]["pendingChanges"], 0);
    assert_eq!(
        db::get(&f.db, "env:test:pending:publication").unwrap(),
        pending
    );
    assert_eq!(
        crate::governance::project(&f.db, id).unwrap()["sharing"]["env"],
        true
    );
}
#[test]
fn digest_preserves_sha256_hex_vectors() {
    assert_eq!(
        db::digest(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        db::digest(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn sync_yields_to_waiting_imports_without_claiming_a_completed_sync() {
    use fs2::FileExt;
    let f = Fixture::new();
    let previous = json!({"online":true,"lastSync":"2026-10-21T00:00:00Z"});
    db::set(&f.db, "sync", &previous).unwrap();
    fs::write(f.root.join("CLAUDE.md"), "Local instructions\n").unwrap();
    let waiting = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(db::root().unwrap().join("workspace-waiters.lock"))
        .unwrap();
    FileExt::lock_shared(&waiting).unwrap();
    assert!(crate::projects::foreground_waiting().unwrap());
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(sync::once())
        .unwrap();
    assert_eq!(db::get(&f.db, "sync").unwrap(), previous);
    assert!(db::get(&f.db, "syncProgress").unwrap().is_null());
    assert!(f.outbox().is_empty());
    assert!(f.resources().is_empty());
    drop(waiting);
    assert!(!crate::projects::foreground_waiting().unwrap());
    let _lock = crate::projects::wait_for_lock(std::time::Duration::from_millis(20)).unwrap();
}

#[test]
fn snapshot_handles_legacy_sync_without_review_requests() {
    let f = Fixture::new();
    let key = format!("requests:{}", f.project["id"].as_str().unwrap());
    db::set(&f.db, &key, &Value::Null).unwrap();
    assert_eq!(
        crate::commands::snapshot().unwrap()["reviewRequests"],
        json!([])
    );

    let requests = json!([{"id":"request","status":"pending"}]);
    db::set(&f.db, &key, &requests).unwrap();
    assert_eq!(
        crate::commands::snapshot().unwrap()["reviewRequests"],
        requests
    );
}

#[test]
fn removed_projects_stay_removed_and_keep_source_files() {
    let f = Fixture::new();
    let id = f.project["id"].as_str().unwrap();
    let file = f.root.join("CLAUDE.md");
    fs::write(&file, "Keep my local work\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(!f.resources().is_empty());
    assert!(!f.outbox().is_empty());
    let lock = crate::projects::lock().unwrap();
    assert!(crate::projects::lock().is_err());
    drop(lock);
    crate::projects::remove_local(&f.db, id).unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "Keep my local work\n");
    assert!(f.resources().is_empty());
    assert!(f.outbox().is_empty());
    assert!(crate::projects::active(&f.db, id).is_err());
    crate::projects::merge_catalog(
        &f.db,
        &json!([{"id":id,"name":"Cloud name","role":"owner","archivedAt":null}]),
    )
    .unwrap();
    let p = db::rows(&f.db, "SELECT value FROM projects WHERE id=?", &[&id])
        .unwrap()
        .remove(0);
    assert_eq!(p["hidden"], true);
    assert!(p["path"].is_null());
    let snap = crate::commands::snapshot().unwrap();
    assert!(snap["projects"].as_array().unwrap().is_empty());
    assert!(snap["resources"].as_array().unwrap().is_empty());
    assert_eq!(snap["managedProjects"][0]["id"], id);
    // Reconnecting requires restoring the project first.
    assert!(crate::commands::connect_project(id.into(), f.root.to_string_lossy().into()).is_err());
    crate::projects::merge_catalog(&f.db, &json!([])).unwrap();
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM projects WHERE id=?", &[&id]).unwrap()[0]["revoked"],
        true
    );
}

#[test]
fn archived_projects_keep_their_mapping_but_are_excluded_from_active_work() {
    let f = Fixture::new();
    let id = f.project["id"].as_str().unwrap();
    crate::projects::merge_catalog(&f.db,&json!([{"id":id,"name":"test","role":"owner","archivedAt":"2026-10-03T00:00:00Z","lifecycleRevision":1}])).unwrap();
    assert!(crate::projects::active(&f.db, id).is_err());
    assert!(crate::commands::snapshot().unwrap()["projects"]
        .as_array()
        .unwrap()
        .is_empty());
    crate::projects::merge_catalog(
        &f.db,
        &json!([{"id":id,"name":"test","role":"owner","archivedAt":null,"lifecycleRevision":0}]),
    )
    .unwrap();
    assert!(crate::projects::active(&f.db, id).is_err());
    crate::projects::merge_catalog(
        &f.db,
        &json!([{"id":id,"name":"test","role":"owner","archivedAt":null,"lifecycleRevision":2}]),
    )
    .unwrap();
    crate::projects::active(&f.db, id).unwrap();
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM projects WHERE id=?", &[&id]).unwrap()[0]["path"],
        f.project["path"]
    );
}

#[test]
fn project_owner_names_use_the_shared_name_and_members_keep_their_override() {
    let mut project = json!({"role":"owner","name":"Shared name","localName":"Old personal name"});
    assert_eq!(crate::projects::display_name(&project), Some("Shared name"));
    project["name"] = json!("Owner's new name");
    assert_eq!(
        crate::projects::display_name(&project),
        Some("Owner's new name")
    );
    project["role"] = json!("member");
    assert_eq!(
        crate::projects::display_name(&project),
        Some("Old personal name")
    );
    project["localName"] = Value::Null;
    assert_eq!(
        crate::projects::display_name(&project),
        Some("Owner's new name")
    );
}

#[test]
fn project_names_stay_local_across_catalog_updates_and_restart() {
    let f = Fixture::new();
    let id = f.project["id"].as_str().unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let rename = |name: Value| {
        runtime.block_on(crate::projects::project_command(
            "local_name".into(),
            json!({"projectId":id,"name":name}),
        ))
    };
    // Local naming needs neither network access nor the daemon's workspace lock.
    let lock = crate::projects::lock().unwrap();
    rename(json!("  My workspace  ")).unwrap();
    drop(lock);
    // A folder operation may have read the project before the personal rename.
    db::upsert(&f.db, "projects", id, id, &f.project).unwrap();
    assert!(db::get(&f.db, "syncRequest").unwrap().is_null());
    assert!(f.outbox().is_empty());
    let peer = db::open_at(&f._home.path().join("peer-cache")).unwrap();
    for name in ["Owner's first name", "Owner's next name"] {
        let remote = json!([{"id":id,"name":name,"role":"member","localName":"Not trusted"}]);
        crate::projects::merge_catalog(&f.db, &remote).unwrap();
        crate::projects::merge_catalog(&peer, &remote).unwrap();
        let project = &crate::commands::snapshot().unwrap()["projects"][0];
        assert_eq!(project["name"], name);
        assert_eq!(project["localName"], "My workspace");
        assert_eq!(project["path"], f.project["path"]);
        assert_eq!(crate::projects::display_name(project), Some("My workspace"));
        let other = &db::rows(&peer, "SELECT value FROM projects", &[]).unwrap()[0];
        assert!(other["localName"].is_null());
        assert_eq!(crate::projects::display_name(other), Some(name));
    }
    let reopened = db::open().unwrap();
    assert_eq!(
        db::rows(&reopened, "SELECT value FROM projects", &[]).unwrap()[0]["localName"],
        "My workspace"
    );
    // An explicit personal name stays pinned even if it currently equals the shared name.
    rename(json!("Owner's next name")).unwrap();
    crate::projects::merge_catalog(&f.db, &json!([{"id":id,"name":"Latest shared name"}])).unwrap();
    assert_eq!(
        crate::projects::display_name(&crate::commands::snapshot().unwrap()["projects"][0]),
        Some("Owner's next name")
    );
    rename(Value::Null).unwrap();
    assert_eq!(
        crate::projects::display_name(&crate::commands::snapshot().unwrap()["projects"][0]),
        Some("Latest shared name")
    );
    for name in [
        json!(""),
        json!("   "),
        json!("x".repeat(101)),
        json!(false),
        json!({}),
    ] {
        assert!(rename(name).is_err());
    }
    assert!(runtime
        .block_on(crate::projects::project_command(
            "local_name".into(),
            json!({"projectId":id})
        ))
        .is_err());
    assert!(crate::commands::snapshot().unwrap()["projects"][0]["localName"].is_null());
    crate::projects::remove_local(&f.db, id).unwrap();
    assert!(rename(json!("Unavailable")).is_err());
}
struct Fixture {
    _lock: MutexGuard<'static, ()>,
    _home: tempfile::TempDir,
    root: PathBuf,
    db: rusqlite::Connection,
    project: Value,
}
impl Fixture {
    fn new() -> Self {
        let lock = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("ORKA_TEST_HOME", home.path());
        std::env::set_var("CODEX_HOME", home.path().join(".codex"));
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path().join(".claude"));
        let root = home.path().join("project");
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let db = db::open().unwrap();
        db::set(&db, "user", &json!(uuid::Uuid::new_v4().to_string())).unwrap();
        let project = json!({"id":uuid::Uuid::new_v4().to_string(),"name":"test","path":root});
        db::upsert(
            &db,
            "projects",
            project["id"].as_str().unwrap(),
            "",
            &project,
        )
        .unwrap();
        Self {
            _lock: lock,
            _home: home,
            root,
            db,
            project,
        }
    }
    fn select_codex_binary(&self) {
        if let Some(binary) = std::env::var_os("ORKA_TEST_CODEX_BINARY") {
            let directory = self._home.path().join(".local/bin");
            fs::create_dir_all(&directory).unwrap();
            std::os::unix::fs::symlink(binary, directory.join("codex")).unwrap();
        }
    }
    fn resources(&self) -> Vec<Value> {
        db::rows(&self.db, "SELECT value FROM resources", &[]).unwrap()
    }
    fn outbox(&self) -> Vec<Value> {
        db::rows(&self.db, "SELECT value FROM outbox", &[]).unwrap()
    }
    fn accept(&self, resource: &Value) -> Value {
        self.db.execute("DELETE FROM outbox", []).unwrap();
        let mut r = resource.clone();
        r["revision"] = json!(1);
        db::upsert(
            &self.db,
            "resources",
            r["resourceId"].as_str().unwrap(),
            self.project["id"].as_str().unwrap(),
            &r,
        )
        .unwrap();
        sync::materialize(&self.db, &self.project, &r).unwrap();
        r
    }
    fn install_native_session(&self, project: &Value, resource: &Value) -> db::Result<Value> {
        let id = resource["resourceId"].as_str().unwrap();
        let mut binding = native::materialize(
            &self.db,
            project,
            resource,
            &indexer::binding(&self.db, id)?,
        )?;
        let guards = sync::live_hash(
            &binding,
            "session",
            Path::new(project["path"].as_str().unwrap()),
        )?;
        binding["lastSeenHash"] = json!(guards.first());
        binding["writeGuard"] = binding["lastSeenHash"].clone();
        binding["guards"] = json!(guards);
        binding["managed"] = json!(true);
        db::upsert(
            &self.db,
            "bindings",
            id,
            project["id"].as_str().unwrap(),
            &binding,
        )?;
        crate::codex_import::finish(&self.db, binding["nativeId"].as_str().unwrap())?;
        Ok(binding)
    }
}
#[test]
fn sync_progress_local_scan_reports_the_file_without_an_estimated_total() {
    let f = Fixture::new();
    fs::write(f.root.join("AGENTS.md"), "Project instructions\n").unwrap();
    let mut project = f.project.clone();
    project["sharing"] =
        json!({"memory":true,"skill":false,"plan":false,"session":false,"env":false});
    indexer::scan(&f.db, &project).unwrap();
    assert_eq!(db::get(&f.db, "syncProgress").unwrap(), Value::Null);
    indexer::scan_with_progress(&f.db, &project).unwrap();
    let progress = db::get(&f.db, "syncProgress").unwrap();
    assert_eq!(progress["label"], "Checking local files");
    assert_eq!(progress["detail"], "test · AGENTS.md");
    assert_eq!(progress["total"], Value::Null);
}

#[test]
fn sync_progress_tracks_requests_and_hides_stopped_or_signed_out_work() {
    let f = Fixture::new();
    assert_eq!(sync::current_progress(&f.db, true).unwrap(), Value::Null);
    db::set(&f.db, "syncRequest", &json!("first")).unwrap();
    assert_eq!(
        sync::current_progress(&f.db, true).unwrap()["label"],
        "Waiting for sync to start…"
    );
    db::set(&f.db, "syncHandledRequest", &json!("first")).unwrap();
    let uploading = json!({"label":"Uploading changes","completed":2,"total":8});
    db::set(&f.db, "syncProgress", &uploading).unwrap();
    db::set(&f.db, "syncRequest", &json!("second")).unwrap();
    assert_eq!(sync::current_progress(&f.db, true).unwrap(), uploading);
    assert_eq!(sync::current_progress(&f.db, false).unwrap(), Value::Null);
    db::set(&f.db, "syncProgress", &Value::Null).unwrap();
    assert_eq!(
        sync::current_progress(&f.db, true).unwrap()["label"],
        "Waiting for sync to start…"
    );
    db::set(&f.db, "syncHandledRequest", &json!("second")).unwrap();
    assert_eq!(sync::current_progress(&f.db, true).unwrap(), Value::Null);
    db::set(&f.db, "syncProgress", &uploading).unwrap();
    db::set(&f.db, "user", &Value::Null).unwrap();
    assert_eq!(sync::current_progress(&f.db, true).unwrap(), Value::Null);
}

#[test]
fn failed_sync_clears_progress_and_preserves_last_success() {
    let f = Fixture::new();
    db::set(
        &f.db,
        "sync",
        &json!({"online":true,"lastSync":"2026-10-01T00:00:00Z"}),
    )
    .unwrap();
    db::set(&f.db, "syncRequest", &json!("request")).unwrap();
    let error = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(sync::once())
        .unwrap_err();
    let status = db::get(&f.db, "sync").unwrap();
    assert_eq!(status["online"], false);
    assert_eq!(status["lastSync"], "2026-10-01T00:00:00Z");
    assert_eq!(status["error"], error);
    assert_eq!(db::get(&f.db, "syncProgress").unwrap(), Value::Null);
    assert_eq!(sync::current_progress(&f.db, true).unwrap(), Value::Null);
}

#[test]
fn scan_is_project_scoped_and_offline_queue_survives_restart() {
    let f = Fixture::new();
    fs::write(f.root.join("AGENTS.md"), "keep instructions\n").unwrap();
    let memory = f
        ._home
        .path()
        .join(".claude/projects")
        .join(
            f.root
                .to_string_lossy()
                .chars()
                .map(|c| if c.is_alphanumeric() { c } else { '-' })
                .collect::<String>(),
        )
        .join("memory");
    fs::create_dir_all(&memory).unwrap();
    fs::write(memory.join("MEMORY.md"), "Claude learned fact").unwrap();
    let summaries = f._home.path().join(".codex/memories/rollout_summaries");
    fs::create_dir_all(&summaries).unwrap();
    fs::write(
        summaries.join("our.md"),
        format!("cwd: {}\nproject fact", f.root.display()),
    )
    .unwrap();
    fs::write(
        summaries.join("elsewhere.md"),
        "cwd: /unrelated/project\nprivate fact",
    )
    .unwrap();
    fs::write(
        f._home.path().join(".codex/memories/MEMORY.md"),
        "# Our project\n- our.md\nshared fact\n# Mixed\n- our.md\n- elsewhere.md\nexcluded",
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let resources = f.resources();
    assert_eq!(resources.len(), 3);
    assert!(!resources
        .iter()
        .any(|r| r["title"] == "Mixed" || r["title"] == "elsewhere.md"));
    let queued = f.outbox();
    assert_eq!(queued.len(), 3);
    let reopened = db::open().unwrap();
    assert_eq!(
        db::rows(&reopened, "SELECT value FROM outbox", &[]).unwrap(),
        queued
    );
    indexer::scan(&reopened, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 3);
    indexer::memory_index(&f.db, &f.project).unwrap();
    let cached = fs::read_to_string(f.root.join(".orka/memory/index.md")).unwrap();
    assert!(cached.contains("Claude learned fact") && cached.contains("shared fact"));
    assert!(!cached.contains("private fact"));
    let output=native::hook("codex",json!({"cwd":f.root,"hook_event_name":"UserPromptSubmit","prompt":"Claude learned fact","session_id":uuid::Uuid::new_v4().to_string()})).unwrap();
    assert!(output["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap()
        .contains("Claude learned fact"));
}
#[test]
fn incomplete_scan_never_deletes_and_concurrent_file_edits_are_staged() {
    let f = Fixture::new();
    let path = f.root.join("CLAUDE.md");
    fs::write(&path, "base\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let r = f.accept(&f.resources()[0]);
    let mut unavailable = f.project.clone();
    unavailable["path"] = json!(f.root.join("missing-mount"));
    assert!(indexer::scan(&f.db, &unavailable).is_err());
    assert!(f.outbox().is_empty());
    let mut incoming = r.clone();
    let bytes = b"server\n";
    incoming["revision"] = json!(2);
    incoming["files"][0]["hash"] = json!(db::blob(bytes).unwrap());
    incoming["files"][0]["size"] = json!(bytes.len());
    fs::write(&path, "unsynced local\n").unwrap();
    assert!(sync::materialize(&f.db, &f.project, &incoming).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "unsynced local\n");
}
#[test]
fn uninstalled_divergent_skill_copies_wait_for_review_without_feedback_uploads() {
    let f = Fixture::new();
    let a = f.root.join(".agents/skills/test-skill");
    let b = f.root.join(".claude/skills/test-skill");
    for directory in [&a, &b] {
        fs::create_dir_all(directory).unwrap();
    }
    fs::write(a.join("SKILL.md"), "Codex instructions").unwrap();
    fs::write(b.join("SKILL.md"), "Claude instructions").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM drafts", &[])
            .unwrap()
            .len(),
        2
    );
    let id = indexer::resource_id(f.project["id"].as_str().unwrap(), "skill", "test-skill");
    let resource = json!({"resourceId":id,"kind":"skill","logicalPath":"test-skill","revision":1,"deleted":false,"files":packages::directory(&a).unwrap()});
    assert!(sync::materialize(&f.db, &f.project, &resource).is_err());
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(
        fs::read_to_string(b.join("SKILL.md")).unwrap(),
        "Claude instructions"
    );

    fs::write(b.join("SKILL.md"), "Codex instructions").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    f.accept(&f.resources()[0]);
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
}

#[test]
fn divergent_skill_recovery_preserves_queued_bytes_before_removing_uploads() {
    let f = Fixture::new();
    let a = f.root.join(".agents/skills/test-skill");
    let b = f.root.join(".claude/skills/test-skill");
    fs::create_dir_all(&a).unwrap();
    fs::write(a.join("SKILL.md"), "Original queued instructions").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let queued = f.outbox();
    fs::write(a.join("SKILL.md"), "New Codex instructions").unwrap();
    fs::create_dir_all(&b).unwrap();
    fs::write(b.join("SKILL.md"), "Claude instructions").unwrap();
    f.db.execute_batch("CREATE TRIGGER reject_drafts BEFORE INSERT ON drafts BEGIN SELECT RAISE(FAIL,'draft failure'); END;").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        db::rows(&f.db, "SELECT json_object('error',error) FROM errors", &[])
            .unwrap()
            .iter()
            .any(|e| e["error"]
                .as_str()
                .is_some_and(|e| e.contains("draft failure")))
    );
    assert_eq!(f.outbox(), queued);
    f.db.execute_batch("DROP TRIGGER reject_drafts;").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
    assert_eq!(drafts.len(), 3);
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM drafts", &[])
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        fs::read_to_string(a.join("SKILL.md")).unwrap(),
        "New Codex instructions"
    );
    assert_eq!(
        fs::read_to_string(b.join("SKILL.md")).unwrap(),
        "Claude instructions"
    );
    fs::remove_dir_all(&a).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(f.outbox()[0]["resource"]["deleted"], false);
}

#[test]
fn skills_preserve_assets_modes_and_both_locations_without_feedback_uploads() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let directory = f.root.join(".agents/skills/test-skill");
    fs::create_dir_all(directory.join("scripts")).unwrap();
    fs::write(directory.join("SKILL.md"), "skill").unwrap();
    fs::write(directory.join("scripts/run.sh"), "#!/bin/sh\necho ok\n").unwrap();
    fs::set_permissions(
        directory.join("scripts/run.sh"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    f.accept(&f.resources()[0]);
    let mirror = f.root.join(".claude/skills/test-skill");
    assert_eq!(
        fs::read(directory.join("scripts/run.sh")).unwrap(),
        fs::read(mirror.join("scripts/run.sh")).unwrap()
    );
    assert_ne!(
        fs::metadata(mirror.join("scripts/run.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0
    );
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    fs::write(directory.join("SKILL.md"), "codex edit").unwrap();
    fs::write(mirror.join("scripts/run.sh"), "claude edit").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 2);
}
#[test]
fn acknowledged_skill_edits_settle_both_mirrors_without_requeuing() {
    let f = Fixture::new();
    let directory = f.root.join(".agents/skills/test-skill");
    let mirror = f.root.join(".claude/skills/test-skill");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("SKILL.md"), "original").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let mut accepted = f.accept(&f.resources()[0]);
    for (index, edited) in [&directory, &mirror].into_iter().enumerate() {
        let text = format!("edit {index}");
        fs::write(edited.join("SKILL.md"), &text).unwrap();
        indexer::scan(&f.db, &f.project).unwrap();
        assert_eq!(f.outbox().len(), 1);
        accepted["files"] = f.outbox()[0]["resource"]["files"].clone();
        accepted["revision"] = json!(index + 2);
        f.db.execute("DELETE FROM outbox", []).unwrap();
        db::upsert(
            &f.db,
            "resources",
            accepted["resourceId"].as_str().unwrap(),
            f.project["id"].as_str().unwrap(),
            &accepted,
        )
        .unwrap();
        // Sync scans again after the receipt, before applying the cloud version.
        indexer::scan(&f.db, &f.project).unwrap();
        assert!(f.outbox().is_empty());
        sync::materialize(&f.db, &f.project, &accepted).unwrap();
        for path in [&directory, &mirror] {
            assert_eq!(fs::read_to_string(path.join("SKILL.md")).unwrap(), text);
        }
        indexer::scan(&f.db, &f.project).unwrap();
        assert!(f.outbox().is_empty());
    }
}
#[test]
fn deleting_a_skill_mirror_produces_one_tombstone() {
    let f = Fixture::new();
    let directory = f.root.join(".agents/skills/test-skill");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("SKILL.md"), "skill").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    f.accept(&f.resources()[0]);
    fs::remove_dir_all(&directory).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(f.outbox()[0]["resource"]["deleted"], true);
}
#[test]
fn open_sessions_survive_updates_deletions_and_stop_is_not_session_end() {
    let f = Fixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    let path = f._home.path().join("native.jsonl");
    fs::write(&path, "{\"original\":true}\n").unwrap();
    let r = json!({"resourceId":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],"revision":2,"kind":"session","source":"claude","logicalPath":format!("claude/{id}"),"title":"session","files":[],"deleted":true});
    let b = json!({"nativeId":id,"paths":[path],"base":{"resourceId":r["resourceId"],"revision":1,"owner":db::get(&f.db,"user").unwrap()},"writeGuard":"base"});
    db::upsert(
        &f.db,
        "bindings",
        r["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &b,
    )
    .unwrap();
    native::hook(
        "claude",
        json!({"cwd":f.root,"session_id":id,"hook_event_name":"Stop"}),
    )
    .unwrap();
    assert!(native::active(&f.db, &id, "claude"));
    assert!(sync::materialize(&f.db, &f.project, &r).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "{\"original\":true}\n");
    let mut update = r.clone();
    update["deleted"] = json!(false);
    assert!(sync::materialize(&f.db, &f.project, &update).is_err());
    native::hook(
        "claude",
        json!({"cwd":f.root,"session_id":id,"hook_event_name":"SessionEnd"}),
    )
    .unwrap();
    assert!(!native::active(&f.db, &id, "claude"));
}
#[test]
fn teammate_continuation_is_durably_promoted_even_without_network() {
    let f = Fixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    let resource = uuid::Uuid::new_v4().to_string();
    let b = json!({"nativeId":id,"base":{"resourceId":resource,"owner":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"]}});
    db::upsert(
        &f.db,
        "bindings",
        &resource,
        f.project["id"].as_str().unwrap(),
        &b,
    )
    .unwrap();
    native::hook(
        "claude",
        json!({"cwd":f.root,"session_id":id,"hook_event_name":"SessionStart"}),
    )
    .unwrap();
    assert_eq!(
        indexer::binding(&db::open().unwrap(), &resource).unwrap()["needsCopy"],
        true
    );
}
#[test]
fn partial_tails_and_unsafe_zip_paths_are_rejected_without_source_changes() {
    let f = Fixture::new();
    assert_eq!(
        native::complete_records(b"{\"ok\":1}\n{\"unfinished\":").unwrap(),
        vec![json!({"ok":1})]
    );
    assert!(native::complete_records(b"not json\n").is_err());
    let path = f._home.path().join("bad.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
    zip.start_file("../escape", zip::write::SimpleFileOptions::default())
        .unwrap();
    use std::io::Write;
    zip.write_all(b"bad").unwrap();
    zip.finish().unwrap();
    assert!(bundles::import(&f.db, f.project["id"].as_str().unwrap(), &path).is_err());
    assert!(!f._home.path().join("escape").exists());
    let outside = f._home.path().join("outside");
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, f.root.join("symlink")).unwrap();
    assert!(packages::safe_directory(&f.root, &f.root.join("symlink/nested")).is_err());
}
#[test]
fn observed_session_formats_are_indexed_without_rewriting_native_history() {
    let f = Fixture::new();
    let codex = f._home.path().join(".codex/sessions");
    let claude = f._home.path().join(".claude/projects/test");
    fs::create_dir_all(&codex).unwrap();
    fs::create_dir_all(&claude).unwrap();
    for version in ["0.155.0-alpha.16.3", "0.159.2"] {
        let id = uuid::Uuid::new_v4().to_string();
        let records = vec![
            json!({"type":"session_meta","ordinal":0,"payload":{"id":id,"cwd":f.root,"cli_version":version,"history_mode":"paginated","source":"cli"}}),
            json!({"type":"response_item","ordinal":1,"metadata":{"preserved":true},"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Project session"}]}}),
        ];
        let path = codex.join(format!("{id}.jsonl"));
        let bytes = native::encode(&records);
        fs::write(&path, &bytes).unwrap();
        assert!(native::session_info("codex", &records).is_ok());
        assert!(native::validate_session_import("codex", &records).is_ok());
        let mut unknown = records.clone();
        unknown[0]["payload"]["history_mode"] = json!("future-format");
        assert!(native::session_info("codex", &unknown).is_err());
        let source = format!("{}:{}", f.project["id"].as_str().unwrap(), path.display());
        f.db.execute(
            "INSERT INTO errors VALUES(?,?)",
            [&source, "old unsupported-format error"],
        )
        .unwrap();
    }
    let id = uuid::Uuid::new_v4().to_string();
    let records = vec![
        json!({"type":"permission-mode","sessionId":id}),
        json!({"type":"user","sessionId":id,"cwd":f.root,"version":"2.1.283","message":{"role":"user","content":"Claude project session"}}),
    ];
    fs::write(claude.join(format!("{id}.jsonl")), native::encode(&records)).unwrap();
    assert!(native::validate_session_import("claude", &records).is_ok());
    let unrelated = uuid::Uuid::new_v4().to_string();
    fs::write(claude.join(format!("{unrelated}.jsonl")), native::encode(&[
        json!({"type":"user","sessionId":unrelated,"cwd":f._home.path(),"version":"unknown","message":{"content":"Unrelated home session"}}),
        json!({"type":"attachment","sessionId":unrelated,"cwd":f.root}),
    ])).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.resources().len(), 3);
    assert!(
        db::rows(&f.db, "SELECT json_object('error',error) FROM errors", &[])
            .unwrap()
            .is_empty()
    );
    for resource in f.resources().into_iter().filter(|r| r["source"] == "codex") {
        let bytes = db::blob_read(resource["files"][0]["hash"].as_str().unwrap()).unwrap();
        let records = native::complete_records(&bytes).unwrap();
        assert_eq!(records[0]["payload"]["history_mode"], "paginated");
        assert_eq!(records[1]["ordinal"], 1);
        assert_eq!(records[1]["metadata"]["preserved"], true);
    }
    let before = f.outbox();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox(), before);
}
#[test]
fn zip_round_trip_preserves_complete_skill_package() {
    let f = Fixture::new();
    let directory = f.root.join(".agents/skills/test-skill");
    fs::create_dir_all(directory.join("assets")).unwrap();
    fs::write(directory.join("SKILL.md"), "skill").unwrap();
    fs::write(directory.join("assets/binary"), [0, 1, 255]).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let resource = f.resources()[0].clone();
    let zip = f._home.path().join("export.zip");
    bundles::export(&f.db, resource["resourceId"].as_str().unwrap(), &zip).unwrap();
    f.db.execute("DELETE FROM outbox", []).unwrap();
    bundles::import(&f.db, f.project["id"].as_str().unwrap(), &zip).unwrap();
    assert_eq!(f.outbox()[0]["resource"]["files"], resource["files"]);
}
#[test]
fn delayed_receipts_cannot_replay_obsolete_events() {
    let f = Fixture::new();
    let r = json!({"resourceId":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],"revision":10,"deleted":true});
    sync::apply_event(&f.db, &json!({"resource":r,"conflicts":[],"activity":null})).unwrap();
    let mut old = r.clone();
    old["revision"] = json!(1);
    old["deleted"] = json!(false);
    sync::apply_event(
        &f.db,
        &json!({"resource":old,"conflicts":[],"activity":null}),
    )
    .unwrap();
    assert_eq!(f.resources()[0]["deleted"], true);
}
#[test]
fn session_conflict_inspection_shows_both_preserved_versions() {
    let f = Fixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    let conflict = uuid::Uuid::new_v4().to_string();
    let shared = native::encode(&[
        json!({"type":"user","message":{"role":"user","content":"shared version"}}),
    ]);
    let incoming = native::encode(&[
        json!({"type":"user","message":{"role":"user","content":"incoming version"}}),
    ]);
    let r = json!({"resourceId":id,"projectId":f.project["id"],"kind":"session","files":[{"path":"session.jsonl","hash":db::blob(&shared).unwrap()}],"deleted":false});
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &r,
    )
    .unwrap();
    let mut candidate = r.clone();
    candidate["files"][0]["hash"] = json!(db::blob(&incoming).unwrap());
    db::upsert(
        &f.db,
        "conflicts",
        &conflict,
        f.project["id"].as_str().unwrap(),
        &json!({"resourceId":id,"candidate":candidate}),
    )
    .unwrap();
    assert!(
        crate::commands::inspect_resource(id.clone(), "session.jsonl".into(), None).unwrap()
            ["content"]
            .as_str()
            .unwrap()
            .contains("shared version")
    );
    assert!(
        crate::commands::inspect_resource(id, "session.jsonl".into(), Some(conflict.clone()))
            .unwrap()["content"]
            .as_str()
            .unwrap()
            .contains("incoming version")
    );
    assert!(crate::commands::inspect_resource(
        uuid::Uuid::new_v4().to_string(),
        "session.jsonl".into(),
        Some(conflict)
    )
    .is_err());
}

#[test]
fn transcript_messages_preserve_native_author_boundaries() {
    let records = vec![
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"## assistant\nThis is user text.\n```unclosed"}]}}),
        json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The actual assistant response."}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","name":"read_file","arguments":"{}"}}),
    ];
    let messages = native::transcript_messages(&records);
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(
        messages[0]["content"],
        "## assistant\nThis is user text.\n```unclosed"
    );
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["content"], "The actual assistant response.");
    assert_eq!(messages[2]["role"], "Tool record");
    assert!(native::transcript(&records).contains("## assistant\n\nThe actual assistant response."));
}

fn paginated_turn(id: &str, marker: &str, start: u64) -> Vec<Value> {
    let turn = uuid::Uuid::new_v4().to_string();
    let stamp = "2026-10-02T00:00:00.000Z";
    let mut records = vec![
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":turn,"model_context_window":258400,"collaboration_mode_kind":"default"}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":marker,"images":[],"local_images":[],"text_elements":[]}}),
    ];
    for (role, text) in [
        ("user", marker.to_owned()),
        ("assistant", format!("Answer to {marker}")),
    ] {
        let message_id = format!("msg_{}", uuid::Uuid::new_v4());
        records.push(json!({"type":"response_item","metadata":{"retained_source":{"id":{"message_id":message_id,"turn_id":turn,"role":role},"revision":format!("retained_{}",uuid::Uuid::new_v4()),"complete":true},"client_authored":false,"user_input_order":if role=="user" {0} else {1}},"payload":{"type":"message","id":message_id,"role":role,"content":[{"type":if role=="user" {"input_text"} else {"output_text"},"text":text}]}}));
        let item = if role == "user" {
            json!({"type":"UserMessage","id":message_id,"content":[{"type":"text","text":text,"text_elements":[]}]})
        } else {
            json!({"type":"AgentMessage","id":message_id,"content":[{"type":"Text","text":text}],"phase":"final_answer"})
        };
        records.push(json!({"type":"event_msg","payload":{"type":"item_completed","thread_id":id,"turn_id":turn,"item":item}}));
    }
    records.push(json!({"type":"response_item","payload":{"type":"function_call","call_id":format!("call_{turn}"),"name":"fixture_check","arguments":"{}"}}));
    records.push(json!({"type":"response_item","payload":{"type":"function_call_output","call_id":format!("call_{turn}"),"output":format!("Tool result for {marker}")}}));
    records.push(json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":turn,"last_agent_message":format!("Answer to {marker}")}}));
    for (i, r) in records.iter_mut().enumerate() {
        r["ordinal"] = json!(start + i as u64);
        r["timestamp"] = json!(stamp);
    }
    records
}

fn paginated_chain(f: &Fixture) -> (Value, Vec<PathBuf>) {
    let directory = native::codex_home().unwrap().join("sessions/2026/10/02");
    fs::create_dir_all(&directory).unwrap();
    let mut paths = Vec::new();
    let mut parent: Option<(String, u64, usize)> = None;
    for marker in ["Ancestor α 🌊", "Middle β", "Leaf γ"] {
        let id = uuid::Uuid::new_v4().to_string();
        let ordinal = parent.as_ref().map(|p| p.1).unwrap_or(0);
        let mut meta = json!({"type":"session_meta","timestamp":"2026-10-02T00:00:00.000Z","ordinal":ordinal,"payload":{"id":id,"session_id":id,"timestamp":"2026-10-02T00:00:00.000Z","cwd":f.root,"cli_version":"0.159.2","history_mode":"paginated","source":"cli","originator":"codex_cli_rs","model_provider":"openai"}});
        if let Some((parent_id, end, offset)) = parent {
            meta["payload"]["history_base"] =
                json!({"thread_id":parent_id,"end_ordinal_exclusive":end,"end_byte_offset":offset});
            meta["payload"]["forked_from_id"] = json!(parent_id);
            meta["payload"]["forked_from_ordinal_exclusive"] = json!(end);
        }
        let mut records = vec![meta];
        records.extend(paginated_turn(&id, marker, ordinal + 1));
        if marker == "Middle β" {
            records.push(json!({"type":"compacted","timestamp":"2026-10-02T00:00:00.000Z","ordinal":ordinal+records.len() as u64,"payload":{"message":"Compacted fixture","replacement_history":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Compact context retained 🌊"}]}]}}));
        }
        let bytes = native::encode(&records);
        parent = Some((id.clone(), ordinal + records.len() as u64, bytes.len()));
        let path = directory.join(format!("rollout-2026-10-02T00-00-00-{id}.jsonl"));
        fs::write(&path, bytes).unwrap();
        paths.push(path);
    }
    let history = History::local(paths.last().unwrap(), Some(&f.root)).unwrap();
    let resource = json!({"resourceId":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],"kind":"session","source":"codex","logicalPath":"codex/import-test","title":"Paginated import","files":history.files().unwrap(),"revision":1,"owner":db::get(&f.db,"user").unwrap(),"deleted":false});
    (resource, paths)
}

#[test]
fn paginated_snapshots_preserve_exact_ancestry_and_export_without_sources() {
    let f = Fixture::new();
    let (resource, paths) = paginated_chain(&f);
    let original = paths
        .iter()
        .map(|p| fs::read(p).unwrap())
        .collect::<Vec<_>>();
    let mut root_records = native::complete_records(&original[0]).unwrap();
    let id = root_records[0]["payload"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    root_records.extend(paginated_turn(
        &id,
        "PRIVATE LATER BRANCH",
        root_records.len() as u64,
    ));
    fs::write(&paths[0], native::encode(&root_records)).unwrap();
    let snapshot = History::local(paths.last().unwrap(), Some(&f.root)).unwrap();
    assert_eq!(
        snapshot.files().unwrap(),
        resource["files"].as_array().unwrap().clone()
    );
    assert!(!native::transcript(&snapshot.records()).contains("PRIVATE LATER BRANCH"));
    assert_eq!(fs::read(&paths[1]).unwrap(), original[1]);
    assert_eq!(fs::read(&paths[2]).unwrap(), original[2]);
    for path in paths {
        fs::remove_file(path).unwrap();
    }
    let detached = History::resource(&resource).unwrap();
    let transcript = native::transcript(&detached.records());
    for marker in ["Ancestor α 🌊", "Middle β", "Leaf γ", "Tool result"] {
        assert!(transcript.contains(marker));
    }
    db::upsert(
        &f.db,
        "resources",
        resource["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    let inspected = crate::commands::inspect_resource(
        resource["resourceId"].as_str().unwrap().into(),
        "session.jsonl".into(),
        None,
    )
    .unwrap();
    assert!(inspected["content"]
        .as_str()
        .unwrap()
        .contains("Ancestor α 🌊"));
    let bundle = f.root.join("complete.orka-session");
    let handoff =
        crate::session_launcher::handoff_prompt(resource["resourceId"].as_str().unwrap()).unwrap();
    let text = handoff["text"].as_str().unwrap();
    for marker in ["Ancestor α 🌊", "Middle β", "Leaf γ"] {
        assert!(text.contains(marker));
    }
    assert!(!text.contains("PRIVATE LATER BRANCH"));
    assert!(!text.contains("Tool result"));
    bundles::export(&f.db, resource["resourceId"].as_str().unwrap(), &bundle).unwrap();
    bundles::import(&f.db, f.project["id"].as_str().unwrap(), &bundle).unwrap();
    let copy = detached
        .independent_paginated(&uuid::Uuid::new_v4().to_string(), &f.root.join("接続 🌊"))
        .unwrap();
    assert!(copy.records[0]["payload"]["history_base"].is_null());
    assert_eq!(native::transcript(&copy.records), transcript);
    assert_eq!(
        copy.records
            .iter()
            .filter(|r| r["type"] == "session_meta")
            .count(),
        1
    );
    assert!(copy
        .records
        .iter()
        .enumerate()
        .all(|(i, r)| r["ordinal"] == i));
}

#[test]
fn paginated_invalid_or_private_ancestry_is_rejected() {
    let f = Fixture::new();
    let (resource, paths) = paginated_chain(&f);
    let mut missing = resource.clone();
    missing["files"].as_array_mut().unwrap().pop();
    assert!(History::resource(&missing).is_err());
    let mut duplicate = resource.clone();
    duplicate["files"]
        .as_array_mut()
        .unwrap()
        .push(resource["files"][1].clone());
    assert!(History::resource(&duplicate).is_err());
    let bytes = fs::read(paths.last().unwrap()).unwrap();
    let mut records = native::complete_records(&bytes).unwrap();
    records[0]["payload"]["history_base"]["end_byte_offset"] = json!(1);
    fs::write(paths.last().unwrap(), native::encode(&records)).unwrap();
    assert!(History::local(paths.last().unwrap(), Some(&f.root)).is_err());
    fs::write(paths.last().unwrap(), &bytes).unwrap();
    let mut ancestor = native::complete_records(&fs::read(&paths[0]).unwrap()).unwrap();
    ancestor[0]["payload"]["cwd"] = json!(f._home.path().join("private"));
    fs::write(&paths[0], native::encode(&ancestor)).unwrap();
    assert!(History::local(paths.last().unwrap(), Some(&f.root)).is_err());
    let mut snapshot = History::resource(&resource).unwrap();
    snapshot.rollouts[0].records[0]["payload"]["subagent_history_start_ordinal"] = json!(5);
    assert!(snapshot
        .independent_paginated(&uuid::Uuid::new_v4().to_string(), &f.root)
        .is_err());
}

#[test]
#[ignore = "requires installed Codex with pagination; isolated native integration"]
fn paginated_native_import_is_visible_restartable_and_does_not_echo() {
    check_paginated_native_import(false);
}

#[test]
#[ignore = "requires installed Codex; isolated same-thread segment integration"]
fn segmented_paginated_native_import_is_complete_and_restartable() {
    check_paginated_native_import(true);
}

fn check_paginated_native_import(segmented: bool) {
    let f = Fixture::new();
    f.select_codex_binary();
    let (resource, source_paths) = if segmented {
        segmented_chain(&f)
    } else {
        paginated_chain(&f)
    };
    // Remove the entire original native home: import must use bundled history.
    fs::remove_dir_all(native::codex_home().unwrap()).unwrap();
    let target_home = f._home.path().join("receiving-codex");
    std::env::set_var("CODEX_HOME", &target_home);
    let target = f.root.join("接続 🌊");
    fs::create_dir(&target).unwrap();
    let mut project = f.project.clone();
    project["path"] = json!(target);
    db::upsert(
        &f.db,
        "projects",
        project["id"].as_str().unwrap(),
        "",
        &project,
    )
    .unwrap();
    db::upsert(
        &f.db,
        "resources",
        resource["resourceId"].as_str().unwrap(),
        project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    let binding = f.install_native_session(&project, &resource).unwrap();
    let id = binding["nativeId"].as_str().unwrap();
    assert!(source_paths.iter().all(|p| !p.exists()));
    assert_eq!(binding["paths"].as_array().unwrap().len(), 1);
    let imported = History::local(
        std::path::Path::new(binding["paths"][0].as_str().unwrap()),
        Some(&target),
    )
    .unwrap();
    assert_eq!(imported.rollouts.len(), 1);
    let before = imported.records();
    indexer::scan(&f.db, &project).unwrap();
    indexer::scan(&f.db, &project).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(f.resources().len(), 1);
    assert_eq!(
        before
            .iter()
            .filter(|r| r["payload"]["type"] == "task_started")
            .count(),
        3
    );
    assert_eq!(
        before
            .iter()
            .filter(|r| r["payload"]["type"] == "task_complete")
            .count(),
        3
    );
    let mut rpc = native::Rpc::connect().unwrap(); // fresh app-server process
    let listed = rpc
        .call(
            "thread/list",
            json!({"cwd":target,"limit":100,"modelProviders":[]}),
        )
        .unwrap();
    assert!(
        listed["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == id),
        "Imported session absent: {listed}"
    );
    let read = rpc
        .call("thread/read", json!({"threadId":id,"includeTurns":false}))
        .unwrap();
    assert!(read["thread"]["projectId"].is_string());
    assert_eq!(read["thread"]["cwd"], json!(target));
    let resumed = rpc
        .call("thread/resume", json!({"threadId":id,"excludeTurns":true}))
        .unwrap();
    assert_eq!(resumed["thread"]["historyMode"], "paginated");
    assert_eq!(resumed["thread"]["cwd"], json!(target));
    let mut cursor = Value::Null;
    let mut items = Vec::new();
    loop {
        let page = rpc
            .call(
                "thread/items/list",
                json!({"threadId":id,"limit":2,"cursor":cursor}),
            )
            .unwrap();
        items.extend(page["data"].as_array().unwrap().clone());
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(items.len(), 6);
    for (i, marker) in ["Ancestor α 🌊", "Middle β", "Leaf γ"].iter().enumerate() {
        assert_eq!(items[i * 2]["item"]["content"][0]["text"], *marker);
        assert_eq!(
            items[i * 2 + 1]["item"]["text"],
            format!("Answer to {marker}")
        );
    }
    let expected_ids = before
        .iter()
        .filter(|r| r["payload"]["type"] == "item_completed")
        .map(|r| r["payload"]["item"]["id"].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        items
            .iter()
            .map(|i| i["item"]["id"].clone())
            .collect::<Vec<_>>(),
        expected_ids
    );
    assert!(
        before
            .iter()
            .any(|r| r["type"] == "compacted"
                && r.to_string().contains("Compact context retained 🌊"))
    );
    rpc.call("thread/unsubscribe", json!({"threadId":id}))
        .unwrap();
    let fork = rpc.call("thread/fork",json!({"threadId":id,"excludeTurns":true,"deferGoalContinuation":true,"threadSource":"cli"})).unwrap();
    rpc.call(
        "thread/unsubscribe",
        json!({"threadId":fork["thread"]["id"]}),
    )
    .unwrap();
    drop(rpc);
    let after_resume = History::local(
        std::path::Path::new(binding["paths"][0].as_str().unwrap()),
        Some(&target),
    )
    .unwrap();
    assert_eq!(
        native::transcript(&after_resume.records()),
        native::transcript(&before)
    );
    indexer::scan(&f.db, &project).unwrap();
    assert!(
        f.resources().iter().any(
            |r| r["logicalPath"] == format!("codex/{}", fork["thread"]["id"].as_str().unwrap())
        ),
        "A later native fork must be captured"
    );
    sync::materialize(&f.db, &project, &resource).unwrap();
    assert_eq!(
        indexer::binding(&f.db, resource["resourceId"].as_str().unwrap()).unwrap()["nativeId"],
        id
    );
}

#[test]
#[ignore = "requires installed Codex; isolated native retry integration"]
fn paginated_import_retries_reuse_identity_and_preserve_local_edits() {
    let f = Fixture::new();
    f.select_codex_binary();
    let (mut resource, _) = paginated_chain(&f);
    fs::remove_dir_all(native::codex_home().unwrap()).unwrap();
    let mut broken_project = f.project.clone();
    broken_project["name"] = Value::Null;
    assert!(f
        .install_native_session(&broken_project, &resource)
        .is_err());
    let attempts = db::rows(
        &f.db,
        "SELECT value FROM meta WHERE key LIKE 'codexImport:%'",
        &[],
    )
    .unwrap();
    let child = attempts[0]["child"].clone();
    assert!(child["id"].is_string());
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        f.outbox().is_empty(),
        "Partial imports must not be uploaded as new conversations"
    );
    f.install_native_session(&f.project, &resource).unwrap();
    let binding = indexer::binding(&f.db, resource["resourceId"].as_str().unwrap()).unwrap();
    assert_eq!(binding["nativeId"], child["id"]);
    resource["resourceId"] = json!(uuid::Uuid::new_v4().to_string());
    assert!(f
        .install_native_session(&broken_project, &resource)
        .is_err());
    let attempts = db::rows(
        &f.db,
        "SELECT value FROM meta WHERE key LIKE 'codexImport:%'",
        &[],
    )
    .unwrap();
    let child2 = attempts
        .iter()
        .find(|a| a["child"]["id"] != child["id"])
        .unwrap()["child"]
        .clone();
    f.db.execute(
        "INSERT INTO active VALUES(?,?)",
        rusqlite::params![
            child2["id"].as_str().unwrap(),
            json!({"pid":std::process::id()}).to_string()
        ],
    )
    .unwrap();
    assert!(f
        .install_native_session(&f.project, &resource)
        .unwrap_err()
        .contains("open"));
    f.db.execute("DELETE FROM active", []).unwrap();
    let path = child2["path"].as_str().unwrap();
    let mut records = native::complete_records(&fs::read(path).unwrap()).unwrap();
    records.extend(paginated_turn(
        child2["id"].as_str().unwrap(),
        "Local continuation",
        records.len() as u64,
    ));
    let changed = native::encode(&records);
    fs::write(path, &changed).unwrap();
    assert!(f
        .install_native_session(&f.project, &resource)
        .unwrap_err()
        .contains("changed"));
    assert_eq!(fs::read(path).unwrap(), changed);
    assert!(
        indexer::binding(&f.db, resource["resourceId"].as_str().unwrap()).unwrap()["nativeId"]
            .is_null()
    );
}

#[test]
fn malformed_paginated_records_return_errors_without_native_writes() {
    let f = Fixture::new();
    let (resource, _) = paginated_chain(&f);
    for bad in [
        json!({"type":"turn_context","payload":"invalid"}),
        json!({"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":[]}}),
    ] {
        let mut r = resource.clone();
        let mut records = native::complete_records(
            &db::blob_read(r["files"][0]["hash"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        let ordinal = records[1]["ordinal"].clone();
        records[1] = bad;
        records[1]["ordinal"] = ordinal;
        let bytes = native::encode(&records);
        r["files"][0]["hash"] = json!(db::blob(&bytes).unwrap());
        r["files"][0]["size"] = json!(bytes.len());
        assert!(History::resource(&r).err().unwrap().contains("shape"));
    }
}

#[test]
#[ignore = "requires installed Codex; isolated legacy adapter regression"]
fn legacy_native_import_still_registers_and_resumes() {
    let f = Fixture::new();
    f.select_codex_binary();
    let (mut resource, _) = paginated_chain(&f);
    let mut rollout = History::resource(&resource)
        .unwrap()
        .independent_paginated(&uuid::Uuid::new_v4().to_string(), &f.root)
        .unwrap();
    rollout.records[0]["payload"]["history_mode"] = json!("legacy");
    for record in &mut rollout.records {
        record.as_object_mut().unwrap().remove("ordinal");
    }
    let bytes = native::encode(&rollout.records);
    resource["files"] = json!([{"path":"session.jsonl","hash":db::blob(&bytes).unwrap(),"size":bytes.len(),"executable":false}]);
    fs::remove_dir_all(native::codex_home().unwrap()).unwrap();
    let binding = f.install_native_session(&f.project, &resource).unwrap();
    let mut rpc = native::Rpc::connect().unwrap();
    let listed = rpc
        .call(
            "thread/list",
            json!({"cwd":f.root,"modelProviders":[],"limit":100}),
        )
        .unwrap();
    assert_eq!(listed["data"].as_array().unwrap().len(), 1);
    assert_eq!(listed["data"][0]["id"], binding["nativeId"]);
    let resumed = rpc
        .call(
            "thread/resume",
            json!({"threadId":binding["nativeId"],"excludeTurns":true}),
        )
        .unwrap();
    assert_eq!(resumed["thread"]["historyMode"], "legacy");
    assert_eq!(resumed["thread"]["cwd"], f.project["path"]);
    rpc.call(
        "thread/unsubscribe",
        json!({"threadId":binding["nativeId"]}),
    )
    .unwrap();
}

fn segmented_chain(f: &Fixture) -> (Value, Vec<PathBuf>) {
    let (mut resource, paths) = paginated_chain(f);
    let common_id = native::complete_records(&fs::read(&paths[0]).unwrap()).unwrap()[0]["payload"]
        ["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut previous_size = 0;
    let mut mapped = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let mut records = native::complete_records(&fs::read(path).unwrap()).unwrap();
        records[0]["payload"]["id"] = json!(common_id);
        records[0]["payload"]["session_id"] = json!(common_id);
        if i > 0 {
            records[0]["payload"]["history_base"]["thread_id"] = json!(common_id);
            records[0]["payload"]["history_base"]["end_byte_offset"] = json!(previous_size);
            records[0]["payload"]
                .as_object_mut()
                .unwrap()
                .remove("forked_from_id");
            records[0]["payload"]
                .as_object_mut()
                .unwrap()
                .remove("forked_from_ordinal_exclusive");
        }
        let bytes = native::encode(&records);
        previous_size = bytes.len();
        let target = if i == 0 {
            path.clone()
        } else {
            path.with_file_name(format!(
                "rollout-2026-10-02T00-00-00-{common_id}_{}.jsonl",
                uuid::Uuid::new_v4()
            ))
        };
        fs::remove_file(path).unwrap();
        fs::write(&target, bytes).unwrap();
        mapped.push(target);
    }
    resource["files"] = json!(History::local(mapped.last().unwrap(), Some(&f.root))
        .unwrap()
        .files()
        .unwrap());
    (resource, mapped)
}

#[test]
fn segmented_paginated_history_tracks_one_session_and_newest_binding() {
    let f = Fixture::new();
    let (resource, paths) = segmented_chain(&f);
    let leaf_bytes = fs::read(&paths[2]).unwrap();
    let middle_bytes = fs::read(&paths[1]).unwrap();
    fs::remove_file(&paths[2]).unwrap();
    fs::remove_file(&paths[1]).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.resources().len(), 1);
    let id = f.resources()[0]["resourceId"].as_str().unwrap().to_owned();
    assert_eq!(
        indexer::binding(&f.db, &id).unwrap()["paths"][0],
        json!(paths[0])
    );
    f.db.execute("DELETE FROM outbox", []).unwrap();
    fs::write(&paths[1], middle_bytes).unwrap();
    fs::write(&paths[2], leaf_bytes).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.resources().len(), 1);
    assert_eq!(f.outbox().len(), 1);
    let binding = indexer::binding(&f.db, &id).unwrap();
    assert_eq!(binding["paths"][0], json!(paths[2]));
    assert_eq!(f.resources()[0]["files"], resource["files"]);
    let files = History::resource(&resource).unwrap().files().unwrap();
    assert_eq!(files.len(), 3);
    assert_ne!(files[1]["path"], files[2]["path"]);
    let hashes = sync::live_hash(&binding, "session", &f.root).unwrap();
    assert_eq!(hashes[0], indexer::manifest_hash(&resource["files"]));
    let queued = f.outbox();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox(), queued);
}

#[test]
#[ignore = "requires installed Codex for native active-session checks"]
fn segmented_paginated_history_rejects_conflicting_ancestors_and_honors_archived_heads() {
    let f = Fixture::new();
    f.select_codex_binary();
    fs::create_dir_all(native::claude_home().unwrap().join("projects")).unwrap();
    let (_, paths) = segmented_chain(&f);
    let archive = native::codex_home().unwrap().join("archived_sessions");
    fs::create_dir_all(&archive).unwrap();
    let id = native::complete_records(&fs::read(&paths[0]).unwrap()).unwrap()[0]["payload"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let original = fs::read(&paths[0]).unwrap();
    let duplicate = archive.join(format!(
        "rollout-2026-10-02T00-00-00-{id}_{}.jsonl",
        uuid::Uuid::new_v4()
    ));
    fs::write(&duplicate, &original).unwrap();
    assert!(History::local(&paths[2], Some(&f.root)).is_ok()); // identical prefixes are harmless
    let text = String::from_utf8(original)
        .unwrap()
        .replace("Ancestor", "Altered!");
    fs::write(&duplicate, text).unwrap();
    assert!(History::local(&paths[2], Some(&f.root))
        .err()
        .unwrap()
        .contains("Ambiguous"));
    fs::remove_file(&duplicate).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let resource = f.resources()[0].clone();
    let binding = indexer::binding(&f.db, resource["resourceId"].as_str().unwrap()).unwrap();
    let archived = archive.join(paths[2].file_name().unwrap());
    fs::rename(&paths[2], &archived).unwrap();
    assert_eq!(
        crate::history::current_path(&paths[0], &id).unwrap(),
        archived
    );
    assert_eq!(
        sync::live_hash(&binding, "session", &f.root).unwrap()[0],
        indexer::manifest_hash(&json!([]))
    );
    let queued = f.outbox();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox(), queued); // no older-segment upload after archive
    assert_eq!(
        indexer::binding(&f.db, resource["resourceId"].as_str().unwrap()).unwrap()["paths"],
        binding["paths"]
    );
    f.db.execute("DELETE FROM outbox", []).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(f.outbox()[0]["resource"]["deleted"], true);
}

#[test]
fn env_skill_guards_run_before_caching_and_preserve_local_secrets() {
    let f = Fixture::new();
    let directory = f.root.join(".agents/skills/secret-test");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("SKILL.md"), "safe skill").unwrap();
    fs::write(directory.join(".env"), "KEY=ENV_CANARY_DO_NOT_CACHE").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        db::rows(&f.db, "SELECT json_object('error',error) FROM errors", &[])
            .unwrap()
            .iter()
            .any(|e| e["error"]
                .as_str()
                .is_some_and(|e| e.contains(if crate::env::enabled() {
                    "ENV"
                } else {
                    "Secret files"
                })))
    );
    assert!(f.outbox().is_empty());
    assert!(!db::blob_path(&db::digest(b"KEY=ENV_CANARY_DO_NOT_CACHE"))
        .unwrap()
        .exists());
    assert!(packages::install(&f.root, &directory, &[]).is_err());
    assert_eq!(
        fs::read_to_string(directory.join(".env")).unwrap(),
        "KEY=ENV_CANARY_DO_NOT_CACHE"
    );
    let id = uuid::Uuid::new_v4().to_string();
    let secret = json!({"resourceId":id,"projectId":f.project["id"],"kind":"skill","files":[{"path":".env.production","hash":db::digest(b"another canary"),"size":14,"executable":false}],"deleted":false});
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &secret,
    )
    .unwrap();
    assert!(bundles::export(&f.db, &id, &f.root.join("unsafe.zip")).is_err());
    assert!(!f.root.join("unsafe.zip").exists());
}

#[test]
fn env_file_merge_preserves_unrelated_values_and_checks_git_and_concurrent_writes() {
    use crate::env::{dotenv, files};
    use std::{os::unix::fs::PermissionsExt, process::Command};
    let f = Fixture::new();
    assert!(Command::new("git")
        .arg("init")
        .arg(&f.root)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(
        f.root.join(".env.local"),
        "# local comment\nKEEP=yes\nTOKEN=old # retain\n",
    )
    .unwrap();
    let input = dotenv::parse("TOKEN='new value'\nADDED=${LITERAL}\n".into()).unwrap();
    let entries: Vec<_> = input.assignments.into_iter().map(|a| a.entry).collect();
    let before = files::preview(&f.root, ".env.local", &entries).unwrap();
    assert_eq!(before["ignored"], false);
    assert!(files::apply(
        &f.root,
        ".env.local",
        before["fingerprint"].as_str().unwrap(),
        &entries
    )
    .is_err());
    files::exclude(&f.root, ".env.local").unwrap();
    files::apply(
        &f.root,
        ".env.local",
        before["fingerprint"].as_str().unwrap(),
        &entries,
    )
    .unwrap();
    let result = fs::read_to_string(f.root.join(".env.local")).unwrap();
    assert_eq!(
        result,
        "# local comment\nKEEP=yes\nTOKEN='new value' # retain\nADDED=${LITERAL}\n"
    );
    assert_eq!(
        fs::metadata(f.root.join(".env.local"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(files::apply(
        &f.root,
        ".env.local",
        before["fingerprint"].as_str().unwrap(),
        &entries
    )
    .unwrap_err()
    .contains("changed"));
    assert!(files::target(&f.root, "../.env").is_err());
    assert!(files::target(&f.root, ".agents/.env").is_err());
    assert!(files::target(&f.root, ".Git/.env").is_err());
    assert!(files::target(&f.root, "AGENTS.md").is_err());
    std::os::unix::fs::symlink(f.root.join(".env.local"), f.root.join(".env.link")).unwrap();
    assert!(files::target(&f.root, ".env.link").is_err());
    fs::write(f.root.join(".env.tracked"), "TRACKED=yes\n").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&f.root)
        .args(["add", ".env.tracked"])
        .output()
        .unwrap()
        .status
        .success());
    assert!(files::preview(&f.root, ".env.tracked", &entries)
        .unwrap_err()
        .contains("tracked"));
    // Inherited Git settings must not make a tracked file look untracked.
    let previous_index = std::env::var_os("GIT_INDEX_FILE");
    std::env::set_var("GIT_INDEX_FILE", f.root.join("missing-index"));
    let result = files::preview(&f.root, ".env.tracked", &entries);
    if let Some(previous) = previous_index {
        std::env::set_var("GIT_INDEX_FILE", previous);
    } else {
        std::env::remove_var("GIT_INDEX_FILE");
    }
    assert!(result.unwrap_err().contains("tracked"));
}

#[test]
fn session_presentation_preview_preserves_stored_resource() {
    let f = Fixture::new();
    let records = vec![
        json!({"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n<INSTRUCTIONS>Project context</INSTRUCTIONS>"}]}}),
        json!({"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Clean up the session list"}]}}),
    ];
    let bytes = native::encode(&records);
    let id = uuid::Uuid::new_v4().to_string();
    let original = json!({"resourceId":id,"projectId":f.project["id"],"kind":"session","title":"# AGENTS.md instructions","files":[{"path":"session.jsonl","hash":db::blob(&bytes).unwrap()}],"deleted":false});
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &original,
    )
    .unwrap();
    let title =
        tauri::async_runtime::block_on(crate::commands::session_display_title(id.clone())).unwrap();
    assert_eq!(title.as_deref(), Some("Clean up the session list"));
    assert_eq!(f.resources()[0], original);
    assert!(f.outbox().is_empty());
    let mut deleted = original.clone();
    deleted["deleted"] = json!(true);
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &deleted,
    )
    .unwrap();
    assert!(tauri::async_runtime::block_on(crate::commands::session_display_title(id)).is_err());
}

#[test]
fn recovered_legacy_import_can_finish_after_lost_fork_response() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let (mut resource, _) = paginated_chain(&f);
    let mut rollout = History::resource(&resource)
        .unwrap()
        .independent_paginated(&uuid::Uuid::new_v4().to_string(), &f.root)
        .unwrap();
    rollout.records[0]["payload"]["history_mode"] = json!("legacy");
    for record in &mut rollout.records {
        record.as_object_mut().unwrap().remove("ordinal");
    }
    let bytes = native::encode(&rollout.records);
    resource["files"] = json!([{"path":"session.jsonl","hash":db::blob(&bytes).unwrap(),"size":bytes.len(),"executable":false}]);
    fs::remove_dir_all(native::codex_home().unwrap()).unwrap();
    let native_dir = native::codex_home().unwrap().join("sessions/2026/10/02");
    fs::create_dir_all(&native_dir).unwrap();
    let staged_id = uuid::Uuid::new_v4().to_string();
    let child_id = uuid::Uuid::new_v4().to_string();
    rollout.records[0]["payload"]["id"] = json!(staged_id);
    fs::write(
        native_dir.join(format!("rollout-2026-10-02T00-00-00-{staged_id}.jsonl")),
        native::encode(&rollout.records),
    )
    .unwrap();
    // This is the durable state if thread/fork succeeds but its response is lost.
    rollout.records[0]["payload"]["id"] = json!(child_id);
    rollout.records[0]["payload"]["forked_from_id"] = json!(staged_id);
    fs::write(
        native_dir.join(format!("rollout-2026-10-02T00-00-00-{child_id}.jsonl")),
        native::encode(&rollout.records),
    )
    .unwrap();
    let key = format!(
        "codexImport:{}:{}:{}:{}",
        f.project["id"].as_str().unwrap(),
        resource["resourceId"].as_str().unwrap(),
        resource["revision"],
        db::digest(resource["files"].to_string().as_bytes())
    );
    db::set(
        &f.db,
        &key,
        &json!({"ids":[staged_id],"strategy":"legacy","date":"2026-10-02T00-00-00"}),
    )
    .unwrap();
    // Mock only the handshake and idle-session check; production recovery reads real files.
    let bin = f._home.path().join(".local/bin");
    fs::create_dir_all(&bin).unwrap();
    let cli = bin.join("codex");
    fs::write(&cli, r##"#!/usr/bin/env python3
import json,os,sys
if '--version' in sys.argv:
 print('codex-cli 0.159.2')
 sys.exit()
for line in sys.stdin:
 request=json.loads(line)
 if 'id' not in request: continue
 result={'codexHome':os.environ['CODEX_HOME'],'userAgent':'codex/0.159.2 test'} if request['method']=='initialize' else {'data':[],'project':{'id':'test-project'}}
 print(json.dumps({'id':request['id'],'result':result}),flush=True)
"##).unwrap();
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    let result = crate::codex_import::materialize(&f.db, &f.project, &resource, &json!({}));
    let (recovered_id, path) = result.expect("An unedited recovered fork should finish importing");
    assert_eq!(recovered_id, child_id);
    let original = fs::read(&path).unwrap();
    assert_eq!(original, native::encode(&rollout.records));
    let mut saved = db::get(&f.db, &key).unwrap();
    assert_eq!(saved["guard"], db::digest(&original));
    // Repair a child persisted without a guard by the previous recovery path.
    saved.as_object_mut().unwrap().remove("guard");
    db::set(&f.db, &key, &saved).unwrap();
    crate::codex_import::materialize(&f.db, &f.project, &resource, &json!({})).unwrap();
    let edited = [original.as_slice(), b"\n"].concat();
    fs::write(&path, &edited).unwrap();
    assert!(
        crate::codex_import::materialize(&f.db, &f.project, &resource, &json!({}))
            .unwrap_err()
            .contains("session changed")
    );
    assert_eq!(fs::read(&path).unwrap(), edited);
}

#[test]
fn service_profiles_isolate_same_identity_and_preserve_legacy_cache() {
    let _f = Fixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    let cloud = "https://cloud.example.com";
    let private = "https://private.example.com";
    let legacy = db::root().unwrap().join(&id);
    let old = db::open_at(&legacy).unwrap();
    db::set(&old, "sentinel", &json!("legacy pending work")).unwrap();
    db::set(&old, "config", &json!({"apiUrl":cloud,"syncMinutes":15})).unwrap();
    db::profile(&id).unwrap();
    let cloud_db = db::open().unwrap();
    let blob = db::blob(b"cloud-only content").unwrap();
    assert_eq!(
        db::get(&cloud_db, "sentinel").unwrap(),
        "legacy pending work"
    );
    db::set(
        &cloud_db,
        "config",
        &json!({"apiUrl":private,"syncMinutes":15}),
    )
    .unwrap();
    let private_db = db::open().unwrap();
    assert!(db::get(&private_db, "sentinel").unwrap().is_null());
    assert!(db::blob_read(&blob).is_err());
    db::set(&private_db, "sentinel", &json!("private work")).unwrap();
    db::set(
        &private_db,
        "config",
        &json!({"apiUrl":cloud,"syncMinutes":15}),
    )
    .unwrap();
    assert_eq!(
        db::get(&db::open().unwrap(), "sentinel").unwrap(),
        "legacy pending work"
    );
    assert_eq!(db::blob_read(&blob).unwrap(), b"cloud-only content");
    assert_ne!(
        db::profile_path(&id, cloud).unwrap(),
        db::profile_path(&id, private).unwrap()
    );
}

#[test]
fn onboarding_refuses_a_folder_bound_to_a_different_project() {
    let f = Fixture::new();
    let service = "http://127.0.0.1:1";
    db::set(&f.db, "config", &json!({"apiUrl":service})).unwrap();
    let project = f.project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", project, project, &f.project).unwrap();
    let saved = json!({
        "active":true,"owner":db::get(&f.db,"user").unwrap(),"service":service,
        "draft":{"step":"syncing","selected":[f.root]}
    });
    fs::write(
        db::root().unwrap().join("onboarding.json"),
        saved.to_string(),
    )
    .unwrap();

    let runtime = tokio::runtime::Runtime::new().unwrap();
    for destination in [Value::Null, json!(uuid::Uuid::new_v4().to_string())] {
        let failure = runtime
            .block_on(crate::onboarding::onboarding_command(
                "connect".into(),
                json!({
                    "path":f.root,"name":"Project","existingId":destination,
                    "sharing":{"session":true,"plan":false,"memory":false,"skill":false,"env":false}
                }),
                None,
            ))
            .unwrap_err();
        assert!(
            failure.contains("Review the destination before syncing"),
            "{failure}"
        );
    }
    let stored = crate::governance::project(&f.db, project).unwrap();
    assert_eq!(stored["sharing"], f.project["sharing"]);
}

#[test]
fn oversized_transcript_only_marks_its_project_even_with_plan_only_sharing() {
    let f = Fixture::new();
    let other = f._home.path().join("unrelated");
    fs::create_dir(&other).unwrap();
    let other = other.canonicalize().unwrap();
    let dir = native::claude_home().unwrap().join("projects/fixture");
    fs::create_dir_all(&dir).unwrap();
    let transcript = dir.join("oversized.jsonl");
    fs::write(
        &transcript,
        native::encode(&[json!({
            "type":"user","cwd":f.root,"sessionId":uuid::Uuid::new_v4().to_string(),
            "message":"x".repeat(70_000)
        })]),
    )
    .unwrap();
    let size = crate::history::MAX_FILE + 1;
    fs::OpenOptions::new()
        .write(true)
        .open(&transcript)
        .unwrap()
        .set_len(size)
        .unwrap();
    let mut project = f.project.clone();
    project["sharing"] =
        json!({"memory":false,"skill":false,"session":false,"plan":true,"env":false});
    indexer::scan(&f.db, &project).unwrap();
    let owner = project["id"].clone();
    project["id"] = json!(uuid::Uuid::new_v4().to_string());
    project["path"] = json!(other);
    indexer::scan(&f.db, &project).unwrap();
    let issues = db::rows(
        &f.db,
        "SELECT json_object('source',source) FROM errors WHERE error=?",
        &[&crate::history::SESSION_SIZE_ERROR],
    )
    .unwrap();
    assert_eq!(
        issues,
        vec![
            json!({"source":format!("{}:scan:{}", owner.as_str().unwrap(), transcript.display())})
        ]
    );
    assert_eq!(fs::metadata(transcript).unwrap().len(), size);
    assert!(f.outbox().is_empty());
}

#[test]
fn unattributed_oversized_transcript_surfaces_once_and_clears_after_repair() {
    let f = Fixture::new();
    let dir = native::claude_home().unwrap().join("projects/fixture");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("oversized.jsonl");
    fs::File::create(&path)
        .unwrap()
        .set_len(crate::history::MAX_FILE + 1)
        .unwrap();
    for _ in 0..2 {
        indexer::scan(&f.db, &f.project).unwrap();
    }
    let issue = format!(
        "{}{}",
        crate::history::UNATTRIBUTED_SESSION_PREFIX,
        path.display()
    );
    let issues = || {
        db::rows(
            &f.db,
            "SELECT json_quote(source) FROM errors WHERE error=?",
            &[&crate::history::UNATTRIBUTED_SESSION_ERROR],
        )
        .unwrap()
    };
    assert_eq!(issues(), vec![json!(issue)]);
    fs::write(&path, []).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(issues().is_empty());
}

#[test]
fn dismissed_missing_folder_does_not_block_an_existing_projects_first_scan() {
    let f = Fixture::new();
    let service = "http://127.0.0.1:1";
    db::set(&f.db, "config", &json!({"apiUrl":service})).unwrap();
    let absent = f._home.path().join("missing-folder");
    let draft = json!({"owner":db::get(&f.db,"user").unwrap(),"service":service,"active":false,
        "draft":{"completedAt":"done","reviewed":true,"selected":[absent],
                 "projects":[{"path":absent,"name":"missing","status":"error"}]}});
    fs::write(
        db::root().unwrap().join("onboarding.json"),
        draft.to_string(),
    )
    .unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    // The fixture has no session, so the remote phase will fail after the local scan.
    let error = runtime.block_on(sync::once()).unwrap_err();
    assert!(error.starts_with("Sync authentication:"), "{error}");
    assert!(db::get(
        &f.db,
        &format!("firstScan:{}", f.project["id"].as_str().unwrap())
    )
    .unwrap()
    .is_string());
    let saved = runtime
        .block_on(crate::onboarding::onboarding_command(
            "progress".into(),
            json!({}),
            None,
        ))
        .unwrap();
    assert_eq!(
        saved["projects"][0]["error"],
        "Project folder is unavailable"
    );
}

#[test]
fn dismissed_setup_stays_visible_until_the_reconnected_project_syncs() {
    let f = Fixture::new();
    let service = "http://127.0.0.1:1";
    db::set(&f.db, "config", &json!({"apiUrl":service})).unwrap();
    let id = f.project["id"].as_str().unwrap();
    let draft = json!({"owner":db::get(&f.db,"user").unwrap(),"service":service,"active":false,
        "draft":{"step":"retrying","completedAt":"done","reviewed":true,"selected":[f.root],
                 "projects":[{"path":f.root,"name":"test","projectId":id,"status":"scanning"}]}});
    fs::write(
        db::root().unwrap().join("onboarding.json"),
        draft.to_string(),
    )
    .unwrap();

    crate::onboarding::reconcile_workspace_sync(&f.db, None).unwrap();
    let setup =
        |db: &rusqlite::Connection| crate::onboarding::snapshot(db).unwrap()["setup"].clone();
    assert_eq!(setup(&f.db)["step"], "syncing");
    assert_eq!(setup(&f.db)["projects"][0]["status"], "syncing");

    db::set(&f.db, &format!("firstScan:{id}"), &json!(db::now())).unwrap();
    let resource = format!("{id}:scan:skills/broken");
    sync::record_result(&f.db, &resource, Err("Package contains symlink".into())).unwrap();
    crate::onboarding::reconcile_workspace_sync(&f.db, None).unwrap();
    assert_eq!(setup(&f.db)["step"], "sync-error");
    assert_eq!(setup(&f.db)["projects"][0]["issues"][0]["item"], resource);

    sync::record_result(&f.db, &resource, Ok(())).unwrap();
    crate::onboarding::reconcile_workspace_sync(&f.db, None).unwrap();
    assert!(setup(&f.db).is_null());
}

#[test]
fn completed_setup_keeps_a_disconnected_folder_visible_despite_an_old_scan() {
    let f = Fixture::new();
    let service = "http://127.0.0.1:1";
    db::set(&f.db, "config", &json!({"apiUrl":service})).unwrap();
    let id = f.project["id"].as_str().unwrap();
    db::set(&f.db, &format!("firstScan:{id}"), &json!(db::now())).unwrap();
    let mut disconnected = f.project.clone();
    disconnected["path"] = Value::Null;
    db::upsert(&f.db, "projects", id, id, &disconnected).unwrap();
    let draft = json!({"owner":db::get(&f.db,"user").unwrap(),"service":service,"active":false,
        "draft":{"step":"offline","completedAt":"done","reviewed":true,"selected":[f.root],
                 "projects":[{"path":f.root,"name":"test","projectId":id,"status":"syncing"}]}});
    fs::write(
        db::root().unwrap().join("onboarding.json"),
        draft.to_string(),
    )
    .unwrap();

    crate::onboarding::reconcile_workspace_sync(&f.db, None).unwrap();
    let setup = crate::onboarding::snapshot(&f.db).unwrap()["setup"].clone();
    assert_eq!(setup["step"], "sync-error");
    assert!(setup["projects"][0]["projectId"].is_null());
    assert!(setup["projects"][0]["error"]
        .as_str()
        .unwrap()
        .contains("Review the destination"));
}

#[test]
fn deferred_setup_resumes_its_saved_selection_without_starting_sync() {
    let f = Fixture::new();
    let service = "http://127.0.0.1:1";
    let user = db::get(&f.db, "user").unwrap();
    db::set(&f.db, "config", &json!({"apiUrl":service})).unwrap();
    let context = json!({"user":user,"service":service});
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let call = |action: &str, input: Value, scope: Value| {
        runtime.block_on(crate::onboarding::onboarding_command(
            action.into(),
            input,
            Some(scope),
        ))
    };
    let draft = json!({"step":"review","selected":[f.root],
        "projects":[{"path":f.root,"name":"test"}],"reviewed":false});
    call("checkpoint", draft.clone(), context.clone()).unwrap();
    call("complete", json!({"defer":true}), context.clone()).unwrap();
    let snapshot = crate::onboarding::snapshot(&f.db).unwrap();
    assert_eq!(snapshot["active"], false);
    assert_eq!(snapshot["setup"]["selected"], draft["selected"]);
    assert!(db::get(&f.db, "syncRequest").unwrap().is_null());
    assert!(call(
        "resume-setup",
        json!({}),
        json!({"user":"another","service":service})
    )
    .is_err());
    call("resume-setup", json!({}), context).unwrap();
    let resumed = crate::onboarding::snapshot(&f.db).unwrap();
    assert_eq!(resumed["active"], true);
    assert_eq!(resumed["draft"]["selected"], draft["selected"]);
    assert_eq!(resumed["draft"]["step"], "review");
    assert!(db::get(&f.db, "syncRequest").unwrap().is_null());
}

#[test]
fn broken_skill_and_stale_binding_do_not_block_healthy_files_or_queue_deletions() {
    let f = Fixture::new();
    let broken = f.root.join(".agents/skills/broken");
    let healthy = f.root.join(".agents/skills/healthy");
    for path in [&broken, &healthy] {
        fs::create_dir_all(path).unwrap();
        fs::write(path.join("SKILL.md"), "# Instructions").unwrap();
    }
    std::os::unix::fs::symlink(f.root.join("private"), broken.join("link")).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    db::upsert(
        &f.db,
        "bindings",
        &id,
        f.project["id"].as_str().unwrap(),
        &json!({"base":{"resourceId":id,"kind":"skill","deleted":false}}),
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(f.outbox()[0]["resource"]["logicalPath"], "healthy");
    let errors = db::rows(
        &f.db,
        "SELECT json_object('error',error,'source',source) FROM errors",
        &[],
    )
    .unwrap();
    assert!(errors
        .iter()
        .any(|e| e["error"] == "Package contains symlink"
            && e["source"]
                .as_str()
                .is_some_and(|source| source.ends_with(":scan:skills/broken"))));
    assert!(errors.iter().any(|e| e["error"] == "Missing binding paths"));
    assert!(!f.outbox().iter().any(|r| r["resource"]["deleted"] == true));
    fs::remove_file(broken.join("link")).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 2);
    assert!(
        !db::rows(&f.db, "SELECT json_object('error',error) FROM errors", &[])
            .unwrap()
            .iter()
            .any(|e| e["error"] == "Package contains symlink")
    );
}

#[test]
fn memory_index_skips_broken_bytes_and_recovers_after_repair() {
    let f = Fixture::new();
    fs::write(f.root.join("AGENTS.md"), "# Healthy knowledge").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let healthy = f.resources().remove(0);
    let id = uuid::Uuid::new_v4().to_string();
    let mut broken = healthy.clone();
    broken["resourceId"] = json!(id);
    broken["logicalPath"] = json!("instructions/broken.md");
    broken["files"] = json!([{"path":"content.md","hash":db::blob(&[0xff]).unwrap(),"size":1,"executable":false}]);
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &broken,
    )
    .unwrap();
    indexer::memory_index(&f.db, &f.project).unwrap();
    let index = fs::read_to_string(f.root.join(".orka/memory/index.md")).unwrap();
    assert!(index.contains("Healthy knowledge"));
    assert_eq!(
        db::get(
            &f.db,
            &format!("contextSources:{}", f.project["id"].as_str().unwrap())
        )
        .unwrap(),
        json!([healthy["resourceId"]])
    );
    assert!(
        db::rows(&f.db, "SELECT json_object('error',error) FROM errors", &[])
            .unwrap()
            .iter()
            .any(|e| e["error"] == "Memory must be UTF-8")
    );
    broken["files"] = healthy["files"].clone();
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &broken,
    )
    .unwrap();
    indexer::memory_index(&f.db, &f.project).unwrap();
    assert!(
        db::rows(&f.db, "SELECT json_object('error',error) FROM errors", &[])
            .unwrap()
            .is_empty()
    );
}

#[test]
fn failed_installation_recovery_preserves_journal_and_allows_other_skills() {
    let f = Fixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    let key = format!("installation:{id}");
    let blocked = f.root.join("blocked");
    fs::write(&blocked, "Preserve this file").unwrap();
    let journal = json!({"project":f.project,"resourceId":id,"originals":[{"path":blocked,"files":null}],"desired":[]});
    db::set(&f.db, &key, &journal).unwrap();
    packages::recover_installations(&f.db).unwrap();
    assert_eq!(db::get(&f.db, &key).unwrap(), journal);
    assert_eq!(fs::read_to_string(&blocked).unwrap(), "Preserve this file");
    let resource = json!({"resourceId":id,"kind":"skill"});
    assert!(sync::materialize(&f.db, &f.project, &resource)
        .unwrap_err()
        .contains("recovery pending"));
    fs::write(f.root.join("AGENTS.md"), "# Independent memory").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert!(
        !db::rows(&f.db, "SELECT json_object('error',error) FROM errors", &[])
            .unwrap()
            .is_empty()
    );
}

#[test]
fn uninstalled_tombstones_settle_without_missing_binding_errors() {
    let f = Fixture::new();
    for kind in ["skill", "session", "memory"] {
        let id = uuid::Uuid::new_v4().to_string();
        let resource = json!({"resourceId":id,"projectId":f.project["id"],"kind":kind,"source":"codex","logicalPath":"gone","deleted":true,"revision":7,"files":[]});
        sync::materialize(&f.db, &f.project, &resource).unwrap();
        let b = indexer::binding(&f.db, &id).unwrap();
        assert_eq!(b["base"], resource);
        assert_eq!(b["paths"], json!([]));
        sync::materialize(&f.db, &f.project, &resource).unwrap();
        assert!(f.outbox().is_empty());
    }
}

#[test]
fn peer_archive_does_not_promote_a_delete_to_a_new_owned_copy() {
    let f = Fixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    let native_id = uuid::Uuid::new_v4().to_string();
    let path = native::codex_home()
        .unwrap()
        .join("sessions")
        .join(format!("rollout-fixture-{native_id}.jsonl"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::create_dir_all(native::claude_home().unwrap().join("projects")).unwrap();
    let archive = native::codex_home().unwrap().join("archived_sessions");
    fs::create_dir_all(&archive).unwrap();
    let archived = archive.join(path.file_name().unwrap());
    let bytes = native::encode(&[
        json!({"type":"session_meta","payload":{"id":native_id,"cwd":f.root,"cli_version":"0.159.2","history_mode":"legacy"}}),
    ]);
    fs::write(&archived, bytes).unwrap();
    let base = json!({"resourceId":id,"projectId":f.project["id"],"owner":uuid::Uuid::new_v4().to_string(),"kind":"session","source":"codex","logicalPath":format!("codex/{native_id}"),"revision":1,"deleted":false,"title":"Peer session","files":[{"path":"session.jsonl","hash":"old","size":1}]});
    db::upsert(
        &f.db,
        "bindings",
        &id,
        f.project["id"].as_str().unwrap(),
        &json!({"nativeId":native_id,"paths":[path],"base":base,"lastSeenHash":"original"}),
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let b = indexer::binding(&f.db, &id).unwrap();
    assert_ne!(b["needsCopy"], true);
    assert_eq!(b["lastSeenHash"], "original");
    assert!(f.outbox().is_empty());
    let b = crate::repair::binding(&f.db, &base, b).unwrap();
    assert_eq!(b["paths"], json!([archived]));
}
