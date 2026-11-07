use super::*;
use crate::session_launcher::{self, Destination, Host, LaunchIntent, Tool};
use std::{
    cell::RefCell, os::unix::fs::PermissionsExt, path::Path, process::Command, time::Duration,
};

#[derive(Default)]
struct FakeHost {
    active: bool,
    native_activity: bool,
    missing: Option<Destination>,
    missing_target: Option<(Destination, Tool)>,
    missing_cli: Option<Tool>,
    fail: bool,
    manual: bool,
    cli_error: Option<&'static str>,
    desktop_cli_error: Option<&'static str>,
    scope_change: Option<(&'static str, Value)>,
    fork_change: Option<&'static str>,
    forks: RefCell<Vec<Value>>,
    calls: RefCell<Vec<Value>>,
}
impl Host for FakeHost {
    fn fork(
        &self,
        db: &rusqlite::Connection,
        project: &Value,
        resource: &Value,
    ) -> db::Result<Value> {
        self.forks.borrow_mut().push(resource.clone());
        if self.fork_change == Some("revision") {
            let mut changed = resource.clone();
            changed["revision"] = json!(2);
            db::upsert(
                db,
                "resources",
                resource["resourceId"].as_str().unwrap(),
                project["id"].as_str().unwrap(),
                &changed,
            )?;
        } else if self.fork_change == Some("account") {
            db::set(db, "user", &json!(uuid::Uuid::new_v4().to_string()))?;
        }
        let native_id = uuid::Uuid::new_v4().to_string();
        let home = if resource["source"] == "codex" {
            native::codex_home()?
        } else {
            native::claude_home()?
        };
        let directory = home.join("sessions");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{native_id}.jsonl"));
        let mut records = crate::history::resource_records(resource)?;
        for record in &mut records {
            if record["type"] == "session_meta" {
                record["payload"]["id"] = json!(native_id);
            }
            if record["sessionId"].is_string() {
                record["sessionId"] = json!(native_id);
            }
        }
        fs::write(&path, native::encode(&records)).unwrap();
        let mut base = resource.clone();
        base["resourceId"] = json!(uuid::Uuid::new_v4().to_string());
        Ok(json!({"nativeId":native_id,"paths":[path],"base":base}))
    }
    fn cli_installed(&self, tool: Tool) -> bool {
        self.missing_cli != Some(tool)
    }
    fn installed(&self, destination: Destination, tool: Tool) -> bool {
        if let Some((key, value)) = &self.scope_change {
            db::set(&db::open().unwrap(), key, value).unwrap();
        }
        self.missing != Some(destination) && self.missing_target != Some((destination, tool))
    }
    fn icon(&self, destination: Destination, tool: Tool) -> Option<String> {
        self.installed(destination, tool)
            .then(|| "data:image/png;base64,test-icon".into())
    }
    fn cli(&self, tool: Tool, desktop: bool) -> db::Result<PathBuf> {
        if self.missing_cli == Some(tool) {
            return Err("Install this CLI".into());
        }
        let error = if desktop {
            self.desktop_cli_error.or(self.cli_error)
        } else {
            self.cli_error
        };
        error.map_or_else(|| Ok("/test/cli".into()), |error| Err(error.into()))
    }
    fn active(&self, db: &rusqlite::Connection, id: &str, tool: Tool, paths: &[PathBuf]) -> bool {
        self.active
            || (self.native_activity
                && native::active_for_resume(
                    db,
                    id,
                    if tool == Tool::Codex {
                        "codex"
                    } else {
                        "claude"
                    },
                    paths,
                ))
    }
    fn open_url(&self, tool: Tool, url: &str) -> db::Result<()> {
        self.calls.borrow_mut().push(json!({"tool":tool,"url":url}));
        if self.fail {
            Err("Launch failed".into())
        } else {
            Ok(())
        }
    }
    fn open_session(
        &self,
        destination: Destination,
        tool: Tool,
        intent: LaunchIntent<'_>,
        root: &Path,
        _: Option<&Path>,
    ) -> db::Result<Option<String>> {
        let call = match intent {
            LaunchIntent::Resume(id) => {
                json!({"destination":destination,"tool":tool,"id":id,"root":root})
            }
            LaunchIntent::Handoff(prompt) => {
                json!({"destination":destination,"tool":tool,"prompt":prompt,"root":root})
            }
        };
        self.calls.borrow_mut().push(call);
        if self.fail {
            Err("Launch failed".into())
        } else {
            Ok(self.manual.then(|| "exact resume command".into()))
        }
    }
}

fn session(f: &Fixture, source: &str, teammate: bool) -> Value {
    let native_id = uuid::Uuid::new_v4().to_string();
    let records = if source == "codex" {
        vec![
            json!({"type":"session_meta","payload":{"id":native_id,"cwd":f.root}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"Continue this task"}}),
        ]
    } else {
        vec![
            json!({"type":"user","sessionId":native_id,"cwd":f.root,"message":{"role":"user","content":"Continue this task"}}),
        ]
    };
    let bytes = native::encode(&records);
    let hash = db::blob(&bytes).unwrap();
    let resource = json!({"resourceId":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],"kind":"session","source":source,"owner":if teammate {json!(uuid::Uuid::new_v4().to_string())} else {db::get(&f.db,"user").unwrap()},"revision":1,"deleted":false,"files":[{"path":"session.jsonl","hash":hash,"size":bytes.len()}]});
    let id = resource["resourceId"].as_str().unwrap();
    db::upsert(
        &f.db,
        "resources",
        id,
        f.project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    db::upsert(&f.db,"bindings",id,f.project["id"].as_str().unwrap(),&json!({"nativeId":native_id,"base":resource,"paths":[f.root.join("original.jsonl")],"copyRequest":"existing-request"})).unwrap();
    resource
}

#[test]
fn explicit_forks_create_fresh_native_identities_and_preserve_the_source() {
    let f = Fixture::new();
    let _sync = crate::projects::lock().unwrap();
    db::set(
        &f.db,
        "sync",
        &json!({"online":false,"error":"Service unavailable"}),
    )
    .unwrap();
    for tool in [Tool::Codex, Tool::Claude] {
        for teammate in [false, true] {
            let source = if tool == Tool::Codex {
                "codex"
            } else {
                "claude"
            };
            let resource = session(&f, source, teammate);
            let id = resource["resourceId"].as_str().unwrap();
            let binding = indexer::binding(&f.db, id).unwrap();
            fs::write(f.root.join("original.jsonl"), "original native bytes").unwrap();
            for destination in [
                Destination::Desktop,
                Destination::Terminal,
                Destination::Warp,
                Destination::Iterm2,
            ] {
                let host = FakeHost::default();
                for _ in 0..2 {
                    assert_eq!(
                        session_launcher::launch_with(id, tool, destination, true, &host).unwrap()
                            ["opened"],
                        true
                    );
                }
                assert_eq!(host.calls.borrow().len(), 2);
                let calls = host.calls.borrow();
                assert_eq!(calls[0]["destination"], json!(destination));
                assert_eq!(calls[0]["tool"], json!(tool));
                assert_eq!(calls[0]["root"], json!(f.root));
                assert_ne!(calls[0]["id"], binding["nativeId"]);
                assert_ne!(calls[0]["id"], calls[1]["id"]);
                assert_eq!(
                    fs::read_to_string(f.root.join("original.jsonl")).unwrap(),
                    "original native bytes"
                );
                let after = indexer::binding(&f.db, id).unwrap();
                assert_eq!(after["copyRequest"], "existing-request");
                assert_eq!(after, binding);
                assert_eq!(governance_resource(&f, id), resource);
                assert!(f.outbox().is_empty());
            }
        }
    }
}

fn governance_resource(f: &Fixture, id: &str) -> Value {
    crate::governance::resource(&f.db, id).unwrap()
}

#[test]
fn default_open_reuses_a_persisted_fork_and_explicit_fork_adds_a_child() {
    for tool in [Tool::Codex, Tool::Claude] {
        for destination in [
            Destination::Desktop,
            Destination::Terminal,
            Destination::Warp,
            Destination::Iterm2,
        ] {
            let f = Fixture::new();
            let source = if tool == Tool::Codex {
                "codex"
            } else {
                "claude"
            };
            let resource = session(&f, source, true);
            let id = resource["resourceId"].as_str().unwrap();
            let _sync = crate::projects::lock().unwrap();
            db::set(
                &f.db,
                "sync",
                &json!({"online":false,"error":"Sync failed"}),
            )
            .unwrap();
            let host = FakeHost::default();
            let first = session_launcher::resume_with(id, tool, destination, &host).unwrap();
            let child = first["resourceId"].as_str().unwrap();
            let native = first["nativeId"].as_str().unwrap();
            assert_eq!(first["forked"], true);
            for selected in [id, child, child, id] {
                let reopened =
                    session_launcher::resume_with(selected, tool, destination, &host).unwrap();
                assert_eq!(reopened["nativeId"], native);
                assert_eq!(reopened["resourceId"], child);
                assert_eq!(reopened["forked"], false);
            }
            assert_eq!(host.forks.borrow().len(), 1);
            let snapshot = crate::commands::snapshot().unwrap();
            let listed = snapshot["resources"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["resourceId"] == child)
                .unwrap();
            assert_eq!(listed["fork"]["parentId"], id);
            assert_eq!(listed["owner"], db::get(&f.db, "user").unwrap());
            let options =
                serde_json::to_value(session_launcher::options_with(child, &host).unwrap())
                    .unwrap();
            assert!(options
                .as_array()
                .unwrap()
                .iter()
                .filter(|o| o["tool"] == source)
                .all(|o| o["mode"] == "resume"));
            let second =
                session_launcher::launch_with(child, tool, destination, true, &host).unwrap();
            assert_ne!(second["nativeId"], native);
            assert_eq!(
                crate::session_forks::info(&f.db, second["resourceId"].as_str().unwrap()).unwrap()
                    ["parentId"],
                child
            );
            assert_eq!(host.forks.borrow().len(), 2);
            assert_eq!(governance_resource(&f, id), resource);
            assert!(f.outbox().is_empty());
        }
    }
}

#[test]
fn a_failed_open_or_missing_native_fork_never_creates_another_fork_implicitly() {
    let f = Fixture::new();
    let resource = session(&f, "claude", true);
    let id = resource["resourceId"].as_str().unwrap();
    let host = FakeHost {
        fail: true,
        ..FakeHost::default()
    };
    assert_eq!(
        session_launcher::resume_with(id, Tool::Claude, Destination::Desktop, &host).unwrap_err(),
        "Launch failed"
    );
    assert_eq!(host.forks.borrow().len(), 1);
    for _ in 0..2 {
        assert_eq!(
            session_launcher::resume_with(id, Tool::Claude, Destination::Desktop, &host)
                .unwrap_err(),
            "Launch failed"
        );
    }
    assert_eq!(host.forks.borrow().len(), 1);
    let child = crate::session_forks::resumable(&f.db, &resource)
        .unwrap()
        .unwrap();
    let child_id = child["resourceId"].as_str().unwrap();
    let binding = indexer::binding(&f.db, child_id).unwrap();
    fs::remove_file(binding["paths"][0].as_str().unwrap()).unwrap();
    let available = FakeHost::default();
    assert!(session_launcher::resume_with(
        child_id,
        Tool::Claude,
        Destination::Desktop,
        &available
    )
    .unwrap_err()
    .contains("Native fork files unavailable"));
    assert!(available.calls.borrow().is_empty());
    assert!(available.forks.borrow().is_empty());
    let options =
        serde_json::to_value(session_launcher::options_with(child_id, &available).unwrap())
            .unwrap();
    assert_eq!(options[0]["available"], false);
    assert_eq!(options[0]["forkAvailable"], true);
    let replacement = session_launcher::launch_with(
        child_id,
        Tool::Claude,
        Destination::Desktop,
        true,
        &available,
    )
    .unwrap();
    assert_eq!(replacement["forked"], true);
    assert_ne!(replacement["nativeId"], binding["nativeId"]);
}

#[test]
fn active_forks_require_an_explicit_new_fork_for_cli_and_claude_desktop() {
    let f = Fixture::new();
    let resource = session(&f, "claude", false);
    let first = session_launcher::resume_with(
        resource["resourceId"].as_str().unwrap(),
        Tool::Claude,
        Destination::Desktop,
        &FakeHost::default(),
    )
    .unwrap();
    let host = FakeHost {
        active: true,
        ..FakeHost::default()
    };
    for destination in [Destination::Desktop, Destination::Terminal] {
        assert!(session_launcher::resume_with(
            first["resourceId"].as_str().unwrap(),
            Tool::Claude,
            destination,
            &host
        )
        .unwrap_err()
        .contains("already be open"));
    }
    assert!(host.forks.borrow().is_empty());
    assert!(host.calls.borrow().is_empty());
}

#[test]
fn fork_lineage_survives_sync_without_local_metadata_and_respects_local_native_ids() {
    let f = Fixture::new();
    let source = session(&f, "claude", false);
    let first = session_launcher::resume_with(
        source["resourceId"].as_str().unwrap(),
        Tool::Claude,
        Destination::Desktop,
        &FakeHost::default(),
    )
    .unwrap();
    let id = first["resourceId"].as_str().unwrap();
    // Simulate receiving the shared resource on another Mac with its own import ID.
    f.db.execute(
        "DELETE FROM meta WHERE key=?",
        [format!("sessionFork:{id}")],
    )
    .unwrap();
    let mut binding = indexer::binding(&f.db, id).unwrap();
    let local_id = uuid::Uuid::new_v4().to_string();
    binding["nativeId"] = json!(local_id);
    db::upsert(
        &f.db,
        "bindings",
        id,
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    let snapshot = crate::commands::snapshot().unwrap();
    let listed = snapshot["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["resourceId"] == id)
        .unwrap();
    assert_eq!(listed["fork"]["parentId"], source["resourceId"]);
    assert_eq!(listed["fork"]["nativeId"], local_id);
    let host = FakeHost::default();
    let opened =
        session_launcher::resume_with(id, Tool::Claude, Destination::Desktop, &host).unwrap();
    assert_eq!(opened["nativeId"], local_id);
    assert_eq!(opened["forked"], false);
    assert!(host.forks.borrow().is_empty());
    let mut teammate = governance_resource(&f, id);
    teammate["owner"] = json!(uuid::Uuid::new_v4().to_string());
    db::upsert(
        &f.db,
        "resources",
        id,
        f.project["id"].as_str().unwrap(),
        &teammate,
    )
    .unwrap();
    let copied =
        session_launcher::resume_with(id, Tool::Claude, Destination::Desktop, &host).unwrap();
    assert_ne!(copied["nativeId"], local_id);
    assert_eq!(copied["forked"], true);
}

#[test]
fn cross_provider_lineage_uses_the_first_prompt_in_the_matching_repository() {
    let f = Fixture::new();
    let source = session(&f, "codex", false);
    let result = session_launcher::resume_with(
        source["resourceId"].as_str().unwrap(),
        Tool::Claude,
        Destination::Desktop,
        &FakeHost::default(),
    )
    .unwrap();
    let path = result["handoff"].as_str().unwrap();
    let cli_handoff = session_launcher::resume_with(
        source["resourceId"].as_str().unwrap(),
        Tool::Claude,
        Destination::Terminal,
        &FakeHost::default(),
    )
    .unwrap();
    assert_ne!(cli_handoff["handoff"], result["handoff"]);
    let native_id = uuid::Uuid::new_v4().to_string();
    let directory = native::claude_home().unwrap().join("projects/repository");
    fs::create_dir_all(&directory).unwrap();
    let records = vec![
        json!({"type":"user","sessionId":native_id,"cwd":f.root,"uuid":uuid::Uuid::new_v4().to_string(),"message":{"role":"user","content":format!("Continue from {path}")}}),
    ];
    fs::write(
        directory.join(format!("{native_id}.jsonl")),
        native::encode(&records),
    )
    .unwrap();
    assert!(
        crate::session_forks::handoff_origin(&f.db, &f.project, "codex", &records)
            .unwrap()
            .is_none()
    );
    indexer::scan(&f.db, &f.project).unwrap();
    let child = f
        .resources()
        .into_iter()
        .find(|resource| resource["source"] == "claude")
        .unwrap();
    let info = crate::session_forks::info(&f.db, child["resourceId"].as_str().unwrap()).unwrap();
    assert_eq!(info["parentId"], source["resourceId"]);
    assert_eq!(info["nativeId"], native_id);
    assert_eq!(info["destination"], "desktop");
    assert!(f
        .outbox()
        .iter()
        .any(
            |change| change["resource"]["resourceId"] == child["resourceId"]
                && change["resource"]["logicalPath"] == child["logicalPath"]
        ));
    let host = FakeHost::default();
    let resumed = session_launcher::resume_with(
        child["resourceId"].as_str().unwrap(),
        Tool::Claude,
        Destination::Desktop,
        &host,
    )
    .unwrap();
    assert_eq!(resumed["nativeId"], native_id);
    assert_eq!(resumed["forked"], false);
    assert!(host.forks.borrow().is_empty());
}

#[test]
fn explicit_fork_uses_the_latest_local_conversation_and_native_home_changes_are_visible() {
    use std::io::Write;
    let f = Fixture::new();
    let source = session(&f, "claude", false);
    let host = FakeHost::default();
    let first = session_launcher::resume_with(
        source["resourceId"].as_str().unwrap(),
        Tool::Claude,
        Destination::Terminal,
        &host,
    )
    .unwrap();
    let child_id = first["resourceId"].as_str().unwrap();
    let binding = indexer::binding(&f.db, child_id).unwrap();
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(binding["paths"][0].as_str().unwrap())
        .unwrap();
    let message = json!({"type":"user","sessionId":first["nativeId"],"cwd":f.root,"uuid":uuid::Uuid::new_v4().to_string(),"message":{"role":"user","content":"Newest local turn before sync"}});
    file.write_all(&native::encode(&[message])).unwrap();
    drop(file);
    session_launcher::launch_with(child_id, Tool::Claude, Destination::Terminal, true, &host)
        .unwrap();
    let copied = host.forks.borrow().last().unwrap().clone();
    assert!(
        native::transcript(&crate::history::resource_records(&copied).unwrap())
            .contains("Newest local turn before sync")
    );
    assert!(session_launcher::handoff_prompt(child_id).unwrap()["text"]
        .as_str()
        .unwrap()
        .contains("Newest local turn before sync"));
    let archive_path = f.root.join("current-fork.zip");
    bundles::export(&f.db, child_id, &archive_path).unwrap();
    let mut archive = zip::ZipArchive::new(fs::File::open(archive_path).unwrap()).unwrap();
    let mut transcript = String::new();
    std::io::Read::read_to_string(
        &mut archive.by_name("transcript.md").unwrap(),
        &mut transcript,
    )
    .unwrap();
    assert!(transcript.contains("Newest local turn before sync"));
    let changed_home = f._home.path().join("other-claude");
    fs::create_dir_all(&changed_home).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &changed_home);
    let failed = FakeHost::default();
    assert!(
        session_launcher::resume_with(child_id, Tool::Claude, Destination::Terminal, &failed)
            .unwrap_err()
            .contains("different native home")
    );
    assert!(failed.forks.borrow().is_empty());
    assert!(failed.calls.borrow().is_empty());
}

#[test]
fn legacy_import_receipts_recover_unique_parents_without_guessing_from_titles() {
    for (tool, provider) in [(Tool::Codex, "codex"), (Tool::Claude, "claude")] {
        for ambiguous in [false, true] {
            let f = Fixture::new();
            let source = session(&f, provider, false);
            let first = session_launcher::resume_with(
                source["resourceId"].as_str().unwrap(),
                tool,
                Destination::Desktop,
                &FakeHost::default(),
            )
            .unwrap();
            let id = first["resourceId"].as_str().unwrap();
            let mut child = governance_resource(&f, id);
            child["logicalPath"] = json!(format!(
                "{provider}/{}",
                first["nativeId"].as_str().unwrap()
            ));
            db::upsert(
                &f.db,
                "resources",
                id,
                f.project["id"].as_str().unwrap(),
                &child,
            )
            .unwrap();
            f.db.execute(
                "DELETE FROM meta WHERE key=?",
                [format!("sessionFork:{id}")],
            )
            .unwrap();
            let receipt_key = format!(
                "{provider}Import:{}:{}:1:{}",
                f.project["id"].as_str().unwrap(),
                uuid::Uuid::new_v4(),
                db::digest(source["files"].to_string().as_bytes())
            );
            let receipt = if tool == Tool::Codex {
                json!({"child":{"id":first["nativeId"]}})
            } else {
                json!({"id":first["nativeId"]})
            };
            db::set(&f.db, &receipt_key, &receipt).unwrap();
            if ambiguous {
                let mut duplicate = source.clone();
                duplicate["resourceId"] = json!(uuid::Uuid::new_v4().to_string());
                db::upsert(
                    &f.db,
                    "resources",
                    duplicate["resourceId"].as_str().unwrap(),
                    f.project["id"].as_str().unwrap(),
                    &duplicate,
                )
                .unwrap();
            }
            let snapshot = crate::commands::snapshot().unwrap();
            let listed = snapshot["resources"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["resourceId"] == id)
                .unwrap();
            if ambiguous {
                assert!(listed["fork"].is_null());
            } else {
                assert_eq!(listed["fork"]["parentId"], source["resourceId"]);
            }
            assert_eq!(
                governance_resource(&f, source["resourceId"].as_str().unwrap()),
                source
            );
            assert!(f.outbox().is_empty());
        }
    }
}

#[test]
fn archived_codex_forks_reopen_without_waiting_for_sync_to_update_the_path() {
    let f = Fixture::new();
    let source = session(&f, "codex", false);
    let first = session_launcher::resume_with(
        source["resourceId"].as_str().unwrap(),
        Tool::Codex,
        Destination::Terminal,
        &FakeHost::default(),
    )
    .unwrap();
    let id = first["resourceId"].as_str().unwrap();
    let binding = indexer::binding(&f.db, id).unwrap();
    let old = PathBuf::from(binding["paths"][0].as_str().unwrap());
    let archive = native::codex_home().unwrap().join("archived_sessions");
    fs::create_dir_all(&archive).unwrap();
    fs::rename(&old, archive.join(old.file_name().unwrap())).unwrap();
    let _sync = crate::projects::lock().unwrap();
    let host = FakeHost::default();
    let resumed =
        session_launcher::resume_with(id, Tool::Codex, Destination::Terminal, &host).unwrap();
    assert_eq!(resumed["nativeId"], first["nativeId"]);
    assert_eq!(resumed["forked"], false);
    assert!(host.forks.borrow().is_empty());
    assert!(session_launcher::handoff_prompt(id).unwrap()["text"]
        .as_str()
        .unwrap()
        .contains("Continue this task"));
}

#[test]
fn launch_forks_without_waiting_for_sync_and_rechecks_before_opening_once() {
    for change in [None, Some("revision"), Some("account")] {
        let f = Fixture::new();
        let resource = session(&f, "codex", false);
        let id = resource["resourceId"].as_str().unwrap();
        let native_id = indexer::binding(&f.db, id).unwrap()["nativeId"].clone();
        let _sync = crate::projects::lock().unwrap();
        let host = FakeHost {
            fork_change: change,
            ..FakeHost::default()
        };
        let result = session_launcher::resume_with(id, Tool::Codex, Destination::Desktop, &host);
        if let Some(change) = change {
            assert!(result.unwrap_err().contains(if change == "revision" {
                "The session changed"
            } else {
                "Account or service changed"
            }));
            assert!(host.calls.borrow().is_empty());
        } else {
            assert_eq!(result.unwrap()["forked"], true);
            assert_eq!(host.calls.borrow().len(), 1);
            assert_ne!(host.calls.borrow()[0]["id"], native_id);
        }
        assert_eq!(host.forks.borrow().len(), 1);
        assert!(!crate::projects::foreground_waiting().unwrap());
    }
}

#[test]
fn another_launch_blocks_duplicates_without_involving_the_sync_lock() {
    let f = Fixture::new();
    let resource = session(&f, "codex", false);
    let host = FakeHost::default();
    let _launch = crate::projects::launch_lock().unwrap();
    assert!(session_launcher::resume_with(
        resource["resourceId"].as_str().unwrap(),
        Tool::Codex,
        Destination::Desktop,
        &host
    )
    .unwrap_err()
    .contains("launch is already in progress"));
    assert!(host.forks.borrow().is_empty());
    assert!(host.calls.borrow().is_empty());
}

#[test]
fn fork_attribution_follows_the_new_native_id_without_changing_source_ownership() {
    let f = Fixture::new();
    let mut project = f.project.clone();
    project["governed"] = json!(true);
    db::upsert(
        &f.db,
        "projects",
        project["id"].as_str().unwrap(),
        "",
        &project,
    )
    .unwrap();
    let mut resource = session(&f, "codex", true);
    resource["contextSources"] = json!(["inherited-source"]);
    let id = resource["resourceId"].as_str().unwrap();
    db::upsert(
        &f.db,
        "resources",
        id,
        project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    let binding = indexer::binding(&f.db, id).unwrap();
    let result =
        session_launcher::resume_with(id, Tool::Codex, Destination::Desktop, &FakeHost::default())
            .unwrap();
    assert_eq!(
        native::session_sources(
            &f.db,
            project["id"].as_str().unwrap(),
            result["nativeId"].as_str().unwrap()
        )
        .unwrap(),
        json!(["inherited-source", id])
    );
    assert_eq!(indexer::binding(&f.db, id).unwrap(), binding);
    assert_eq!(governance_resource(&f, id), resource);
}

#[test]
fn active_missing_and_failed_launches_are_errors_without_source_writes() {
    let f = Fixture::new();
    let resource = session(&f, "claude", true);
    let id = resource["resourceId"].as_str().unwrap();
    let host = FakeHost {
        active: true,
        ..FakeHost::default()
    };
    assert!(
        session_launcher::resume_with(id, Tool::Claude, Destination::Terminal, &host)
            .unwrap_err()
            .contains("already be open")
    );
    assert!(host.calls.borrow().is_empty());
    assert_ne!(indexer::binding(&f.db, id).unwrap()["needsCopy"], true);
    let missing = FakeHost {
        missing: Some(Destination::Warp),
        ..FakeHost::default()
    };
    assert!(
        session_launcher::resume_with(id, Tool::Claude, Destination::Warp, &missing)
            .unwrap_err()
            .contains("Install Warp")
    );
    let failed = FakeHost {
        fail: true,
        ..FakeHost::default()
    };
    assert_eq!(
        session_launcher::resume_with(id, Tool::Claude, Destination::Desktop, &failed).unwrap_err(),
        "Launch failed"
    );
    assert_eq!(governance_resource(&f, id), resource);
}

#[test]
#[cfg(target_os = "macos")]
fn claude_terminal_activity_is_scoped_to_the_selected_transcript_and_hooks() {
    let f = Fixture::new();
    let resource = session(&f, "claude", false);
    let id = resource["resourceId"].as_str().unwrap();
    let project_id = f.project["id"].as_str().unwrap();
    let mut binding = indexer::binding(&f.db, id).unwrap();
    let directory = native::claude_home().unwrap().join("projects/repository");
    fs::create_dir_all(&directory).unwrap();
    let selected = directory.join(format!("{}.jsonl", binding["nativeId"].as_str().unwrap()));
    let unrelated = directory.join("unrelated.jsonl");
    fs::write(&selected, "selected transcript").unwrap();
    fs::write(&unrelated, "unrelated transcript").unwrap();
    let _unrelated = fs::File::open(&unrelated).unwrap();
    binding["paths"] = json!([directory.join("missing-segment.jsonl"), selected]);
    db::upsert(&f.db, "bindings", id, project_id, &binding).unwrap();
    let host = FakeHost {
        native_activity: true,
        ..FakeHost::default()
    };
    let destinations = [
        Destination::Terminal,
        Destination::Warp,
        Destination::Iterm2,
    ];
    for destination in destinations {
        assert_eq!(
            session_launcher::resume_with(id, Tool::Claude, destination, &host).unwrap()["opened"],
            true
        );
    }
    assert_eq!(host.calls.borrow().len(), destinations.len());

    let selected_file = fs::File::open(&selected).unwrap();
    for destination in destinations {
        assert_eq!(
            session_launcher::resume_with(id, Tool::Claude, destination, &host).unwrap()["forked"],
            false
        );
    }
    drop(selected_file);

    binding["paths"] = json!([]);
    db::upsert(&f.db, "bindings", id, project_id, &binding).unwrap();
    for pid in [json!(std::process::id()), Value::Null] {
        f.db.execute(
            "INSERT OR REPLACE INTO active VALUES(?,?)",
            rusqlite::params![
                binding["nativeId"].as_str().unwrap(),
                json!({"pid":pid}).to_string()
            ],
        )
        .unwrap();
        for destination in destinations {
            assert_eq!(
                session_launcher::resume_with(id, Tool::Claude, destination, &host).unwrap()
                    ["forked"],
                false
            );
        }
    }
    assert_eq!(host.calls.borrow().len(), destinations.len() * 4);
    assert_eq!(governance_resource(&f, id), resource);
    assert!(f.outbox().is_empty());
}

#[test]
fn missing_cli_support_disables_only_destinations_that_require_it() {
    let f = Fixture::new();
    for source in ["codex", "claude"] {
        let resource = session(&f, source, false);
        let id = resource["resourceId"].as_str().unwrap();
        let host = FakeHost {
            cli_error: Some("Install the session CLI"),
            ..FakeHost::default()
        };
        let options =
            serde_json::to_value(session_launcher::options_with(id, &host).unwrap()).unwrap();
        for option in options.as_array().unwrap() {
            let needs_cli = option["destination"] != "desktop" || option["tool"] == source;
            assert_eq!(option["available"], !needs_cli, "{source}: {option}");
            if needs_cli {
                assert_eq!(option["reason"], "Install the session CLI");
            }
        }
        assert!(session_launcher::resume_with(
            id,
            Tool::parse(source).unwrap(),
            Destination::Terminal,
            &host
        )
        .is_err());
        assert!(host.calls.borrow().is_empty());
        assert!(f.outbox().is_empty());
    }
    let resource = session(&f, "claude", false);
    let host = FakeHost {
        desktop_cli_error: Some("Update Claude Code for Desktop resume"),
        ..FakeHost::default()
    };
    let options = serde_json::to_value(
        session_launcher::options_with(resource["resourceId"].as_str().unwrap(), &host).unwrap(),
    )
    .unwrap();
    assert_eq!(options[0]["available"], false);
    assert_eq!(
        options[0]["reason"],
        "Update Claude Code for Desktop resume"
    );
    assert!(options
        .as_array()
        .unwrap()
        .iter()
        .skip(1)
        .all(|option| option["available"] == true));
}

#[test]
fn cached_codex_forks_from_another_mac_do_not_replace_the_local_resume_target() {
    let f = Fixture::new();
    let source = session(&f, "codex", false);
    let id = source["resourceId"].as_str().unwrap();
    f.db.execute("DELETE FROM bindings WHERE id=?", [id])
        .unwrap();
    sync::materialize(&f.db, &f.project, &source).unwrap();
    let mut remote_fork = source.clone();
    let remote_id = uuid::Uuid::new_v4().to_string();
    remote_fork["resourceId"] = json!(remote_id);
    remote_fork["logicalPath"] =
        json!(format!("codex/forks/{id}/desktop/{}", uuid::Uuid::new_v4()));
    remote_fork["updatedAt"] = json!("2099-01-01T00:00:00Z");
    db::upsert(
        &f.db,
        "resources",
        &remote_id,
        f.project["id"].as_str().unwrap(),
        &remote_fork,
    )
    .unwrap();
    sync::materialize(&f.db, &f.project, &remote_fork).unwrap();
    assert!(crate::session_forks::resumable(&f.db, &source)
        .unwrap()
        .is_none());
    assert!(crate::session_forks::resumable(&f.db, &remote_fork)
        .unwrap()
        .is_none());
    let host = FakeHost::default();
    let first =
        session_launcher::resume_with(id, Tool::Codex, Destination::Desktop, &host).unwrap();
    let reopened =
        session_launcher::resume_with(id, Tool::Codex, Destination::Desktop, &host).unwrap();
    assert_eq!(first["nativeId"], reopened["nativeId"]);
    assert_eq!(host.forks.borrow().len(), 1);
    assert_eq!(host.forks.borrow()[0], source);
    let remote_open =
        session_launcher::resume_with(&remote_id, Tool::Codex, Destination::Desktop, &host)
            .unwrap();
    assert_ne!(remote_open["nativeId"], first["nativeId"]);
    assert_eq!(host.forks.borrow().len(), 2);
    assert!(indexer::binding(&f.db, id).unwrap()["nativeId"].is_null());
    assert!(indexer::binding(&f.db, &remote_id).unwrap()["nativeId"].is_null());
}

#[test]
fn missing_or_invalid_source_bindings_do_not_require_sync_before_forking() {
    let f = Fixture::new();
    let resource = session(&f, "codex", true);
    let id = resource["resourceId"].as_str().unwrap();
    for binding in [json!({}), json!({"nativeId":"--last; touch injected"})] {
        db::upsert(
            &f.db,
            "bindings",
            id,
            f.project["id"].as_str().unwrap(),
            &binding,
        )
        .unwrap();
        let host = FakeHost::default();
        for destination in [
            Destination::Desktop,
            Destination::Terminal,
            Destination::Warp,
            Destination::Iterm2,
        ] {
            assert_eq!(
                session_launcher::resume_with(id, Tool::Codex, destination, &host).unwrap()
                    ["opened"],
                true
            );
        }
        assert_eq!(indexer::binding(&f.db, id).unwrap(), binding);
        assert_eq!(governance_resource(&f, id), resource);
        assert!(host
            .calls
            .borrow()
            .iter()
            .all(|call| call["id"] != binding["nativeId"]));
        assert!(f.outbox().is_empty());
    }
    f.db.execute("DELETE FROM bindings WHERE id=?", [id])
        .unwrap();
    let options =
        serde_json::to_value(session_launcher::options_with(id, &FakeHost::default()).unwrap())
            .unwrap();
    assert!(options
        .as_array()
        .unwrap()
        .iter()
        .all(|option| option["available"] == true));
}

#[test]
fn switching_account_or_service_during_validation_stops_before_any_launch_or_copy() {
    for change in [
        ("user", json!(uuid::Uuid::new_v4().to_string())),
        ("config", json!({"apiUrl":"https://other-service.example"})),
    ] {
        let f = Fixture::new();
        let resource = session(&f, "codex", true);
        let id = resource["resourceId"].as_str().unwrap();
        let binding = indexer::binding(&f.db, id).unwrap();
        let host = FakeHost {
            scope_change: Some(change),
            ..FakeHost::default()
        };
        assert_eq!(
            session_launcher::resume_with(id, Tool::Codex, Destination::Terminal, &host)
                .unwrap_err(),
            "Account or service changed. Open the session again."
        );
        assert_eq!(indexer::binding(&f.db, id).unwrap(), binding);
        assert_eq!(governance_resource(&f, id), resource);
        assert!(host.calls.borrow().is_empty());
        assert!(f.outbox().is_empty());
    }
}

#[test]
fn cached_session_download_keeps_original_bytes_and_complete_context_without_a_repository() {
    use std::io::Read;
    let f = Fixture::new();
    fs::remove_dir(&f.root).unwrap();
    for source in ["codex", "claude"] {
        let mut resource = session(&f, source, true);
        let records = if source == "codex" {
            vec![
                json!({"type":"session_meta","payload":{"id":uuid::Uuid::new_v4().to_string(),"cwd":f.root,"history_mode":"legacy","cli_version":"0.159.2"}}),
                json!({"type":"event_msg","payload":{"type":"user_message","message":"First request"}}),
                json!({"type":"event_msg","payload":{"type":"agent_message","message":"Last response"}}),
            ]
        } else {
            vec![
                json!({"type":"user","message":{"role":"user","content":"First request"}}),
                json!({"type":"assistant","message":{"role":"assistant","content":"Last response"}}),
            ]
        };
        let bytes = native::encode(&records);
        let blob = db::blob(&bytes).unwrap();
        resource["files"] = json!([{"path":"session.jsonl","hash":blob,"size":bytes.len()}]);
        resource["title"] = json!("Synthetic session download");
        let id = resource["resourceId"].as_str().unwrap();
        db::upsert(
            &f.db,
            "resources",
            id,
            f.project["id"].as_str().unwrap(),
            &resource,
        )
        .unwrap();
        let binding = indexer::binding(&f.db, id).unwrap();
        let path = f._home.path().join(format!("{source}.zip"));
        crate::commands::export_bundle(id.into(), path.to_string_lossy().into()).unwrap();
        let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
        let mut manifest = String::new();
        zip.by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut manifest)
            .unwrap();
        let manifest: Value = serde_json::from_str(&manifest).unwrap();
        assert_eq!(manifest["resource"]["source"], source);
        assert_eq!(manifest["resource"]["files"], resource["files"]);
        let mut original = Vec::new();
        zip.by_name(&format!("blobs/{blob}"))
            .unwrap()
            .read_to_end(&mut original)
            .unwrap();
        assert_eq!(original, bytes);
        let mut transcript = String::new();
        zip.by_name("transcript.md")
            .unwrap()
            .read_to_string(&mut transcript)
            .unwrap();
        assert!(transcript.contains("First request"));
        assert!(transcript.contains("Last response"));
        let prompt = session_launcher::handoff_prompt(id).unwrap();
        assert_eq!(prompt["revision"], resource["revision"]);
        assert!(prompt["text"].as_str().unwrap().contains("First request"));
        assert!(prompt["text"].as_str().unwrap().contains("Last response"));
        assert!(!prompt["text"].as_str().unwrap().contains(".orka/handoffs"));
        assert_eq!(governance_resource(&f, id), resource);
        assert_eq!(indexer::binding(&f.db, id).unwrap(), binding);
        assert!(f.outbox().is_empty());
    }
}

#[test]
fn launch_resolves_only_the_sessions_repository_and_rejects_stale_sources() {
    let f = Fixture::new();
    let mut resource = session(&f, "codex", false);
    let id = resource["resourceId"].as_str().unwrap().to_owned();
    let second = f.root.parent().unwrap().join("another repository");
    fs::create_dir(&second).unwrap();
    let mut project = f.project.clone();
    project["sources"] = json!([{"id":"first","path":f.root},{"id":"second","path":second}]);
    resource["sourceId"] = json!("second");
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &project,
    )
    .unwrap();
    let host = FakeHost::default();
    session_launcher::resume_with(&id, Tool::Codex, Destination::Terminal, &host).unwrap();
    assert_eq!(host.calls.borrow()[0]["root"], json!(second));
    project["sources"][1]["folderIdentity"] = json!("changed");
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &project,
    )
    .unwrap();
    assert!(
        session_launcher::resume_with(&id, Tool::Codex, Destination::Terminal, &host)
            .unwrap_err()
            .contains("folder changed")
    );
    assert_eq!(host.calls.borrow().len(), 1);
    let options =
        serde_json::to_value(session_launcher::options_with(&id, &host).unwrap()).unwrap();
    assert!(options
        .as_array()
        .unwrap()
        .iter()
        .all(|option| option["available"] == false));
}

#[test]
fn capability_reads_do_not_write_or_queue_and_hide_absent_terminals() {
    let f = Fixture::new();
    let resource = session(&f, "codex", true);
    let id = resource["resourceId"].as_str().unwrap();
    let host = FakeHost {
        missing: Some(Destination::Warp),
        ..FakeHost::default()
    };
    let binding = indexer::binding(&f.db, id).unwrap();
    let options = serde_json::to_value(session_launcher::options_with(id, &host).unwrap()).unwrap();
    assert_eq!(options.as_array().unwrap().len(), 6);
    assert_eq!(options[0]["tool"], "codex");
    assert_eq!(options[0]["destination"], "desktop");
    assert_eq!(options[0]["available"], true);
    assert_eq!(options[0]["icon"], "data:image/png;base64,test-icon");
    assert_eq!(indexer::binding(&f.db, id).unwrap(), binding);
    assert!(f.outbox().is_empty());
    assert!(host.calls.borrow().is_empty());
    assert!(Tool::parse("shared").is_err());
    assert!(serde_json::from_value::<Destination>(json!("arbitrary-executable")).is_err());
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "Reads icons from locally installed applications using AppKit"]
fn installed_app_icons_are_small_pngs() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    assert!(session_launcher::app_icon(Destination::Terminal, Tool::Codex).is_some());
    for (destination, tool) in [
        (Destination::Desktop, Tool::Codex),
        (Destination::Desktop, Tool::Claude),
        (Destination::Terminal, Tool::Codex),
        (Destination::Warp, Tool::Codex),
        (Destination::Iterm2, Tool::Codex),
    ] {
        let Some(icon) = session_launcher::app_icon(destination, tool) else {
            continue;
        };
        let png = STANDARD
            .decode(icon.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        for dimension in [&png[16..20], &png[20..24]] {
            let pixels = u32::from_be_bytes(dimension.try_into().unwrap());
            assert!(
                (32..=64).contains(&pixels),
                "{destination:?} {tool:?}: {pixels}px"
            );
        }
    }
}

#[test]
fn handoff_opens_a_composer_without_submitting_or_rewriting_the_source() {
    let f = Fixture::new();
    for (source, destination) in [("claude", Tool::Codex), ("codex", Tool::Claude)] {
        let mut resource = session(&f, source, false);
        let records = if source == "claude" {
            vec![
                json!({"type":"user","sessionId":uuid::Uuid::new_v4().to_string(),"message":{"role":"user","content":"Context preserved"}}),
            ]
        } else {
            vec![
                json!({"type":"session_meta","payload":{"id":uuid::Uuid::new_v4().to_string(),"cwd":f.root,"history_mode":"legacy","cli_version":"0.159.2"}}),
                json!({"type":"event_msg","payload":{"type":"user_message","message":"Context preserved"}}),
            ]
        };
        let bytes = native::encode(&records);
        let blob = db::blob(&bytes).unwrap();
        resource["files"] = json!([{"path":"session.jsonl","hash":blob,"size":bytes.len()}]);
        let id = resource["resourceId"].as_str().unwrap();
        db::upsert(
            &f.db,
            "resources",
            id,
            f.project["id"].as_str().unwrap(),
            &resource,
        )
        .unwrap();
        let host = FakeHost::default();
        let result =
            session_launcher::resume_with(id, destination, Destination::Desktop, &host).unwrap();
        assert_eq!(result["opened"], true);
        assert!(fs::read_to_string(result["handoff"].as_str().unwrap())
            .unwrap()
            .contains("Context preserved"));
        let calls = host.calls.borrow();
        assert_eq!(calls.len(), 1);
        let url = reqwest::Url::parse(calls[0]["url"].as_str().unwrap()).unwrap();
        assert_eq!(
            url.scheme(),
            if destination == Tool::Codex {
                "codex"
            } else {
                "claude"
            }
        );
        assert_eq!(
            url.host_str(),
            Some(if destination == Tool::Codex {
                "threads"
            } else {
                "code"
            })
        );
        assert_eq!(url.path(), "/new");
        let query: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(
            query.len(),
            2,
            "Only folder and unsent prompt belong in the handoff URL"
        );
        assert_eq!(
            query[if destination == Tool::Codex {
                "path"
            } else {
                "folder"
            }],
            f.root.to_string_lossy()
        );
        assert!(url
            .query_pairs()
            .any(|(key, value)| (key == "prompt" || key == "q")
                && value.contains("This is a new session")));
        assert_eq!(governance_resource(&f, id), resource);
        assert_eq!(db::blob_read(&blob).unwrap(), bytes);
        drop(calls);
        for terminal in [
            Destination::Terminal,
            Destination::Warp,
            Destination::Iterm2,
        ] {
            session_launcher::resume_with(id, destination, terminal, &host).unwrap();
            let calls = host.calls.borrow();
            let call = calls.last().unwrap();
            assert!(call["id"].is_null());
            assert!(call["prompt"]
                .as_str()
                .unwrap()
                .contains("This is a new session"));
            assert_eq!(call["destination"], json!(terminal));
        }
    }
}

#[test]
fn terminal_scripts_preserve_arguments_working_directory_and_native_home_literally() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp
        .path()
        .join("path exec ' with $dollar `backtick` 🌊\nexec newline");
    fs::create_dir(&root).unwrap();
    let binary = temp.path().join("fake exec ' cli\nexec binary");
    fs::write(&binary,"#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"${CODEX_HOME:-}\" \"${CLAUDE_CONFIG_DIR:-}\" \"$@\"\n").unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    for tool in [Tool::Codex, Tool::Claude] {
        for (cleanup_config, track_startup) in [(false, false), (false, true), (true, true)] {
            let home = temp.path().join("home exec ' $USER `cmd`\nexec home");
            let path = temp
                .path()
                .join("launcher exec ' $USER\nexec script.command");
            let config = temp.path().join("config exec ' $USER\nexec config.yaml");
            let started = temp.path().join("started exec ' $USER\nexec marker");
            if cleanup_config {
                fs::write(&config, "temporary launcher config").unwrap();
            }
            let script = session_launcher::terminal_script(
                &binary,
                tool,
                LaunchIntent::Resume("exact-session-id"),
                &root,
                &home,
                cleanup_config.then_some(config.as_path()),
                track_startup.then_some(started.as_path()),
            );
            fs::write(&path, &script).unwrap();
            let result = Command::new("/bin/sh")
                .arg(&path)
                .env_remove("CODEX_HOME")
                .env_remove("CLAUDE_CONFIG_DIR")
                .output()
                .unwrap();
            assert!(result.status.success(), "{:?}", result);
            let text = String::from_utf8(result.stdout).unwrap();
            assert!(text.starts_with(&format!("{}\n", root.display())));
            assert!(text.contains(&format!("{}\n", home.display())));
            assert!(text.ends_with(if tool == Tool::Codex {
                "resume\nexact-session-id\n"
            } else {
                "--resume\nexact-session-id\n"
            }));
            assert!(!script.contains("--last"));
            assert!(!script.contains("--continue"));
            assert!(!path.exists());
            assert!(!config.exists());
            assert_eq!(started.exists(), track_startup);
            if track_startup {
                fs::remove_file(started).unwrap();
            }
        }
    }
    let config: Value =
        serde_json::from_str(&session_launcher::warp_config(&binary, &root)).unwrap();
    assert_eq!(
        config["windows"][0]["tabs"][0]["layout"]["commands"][0]["exec"],
        format!(
            "/bin/sh {}",
            session_launcher::shell_quote(&binary.to_string_lossy())
        )
    );
    assert_eq!(
        config["windows"][0]["tabs"][0]["layout"]["cwd"],
        json!(root)
    );
}

#[test]
fn launch_process_output_is_drained_bounded_and_times_out() {
    let result = session_launcher::output(
        Command::new("/usr/bin/yes").arg("large output"),
        Duration::from_millis(100),
    );
    assert!(result.unwrap_err().contains("did not respond"));
    let result = session_launcher::output(
        Command::new("/bin/sh").args([
            "-c",
            "i=0; while [ $i -lt 10000 ]; do printf 'large help output\\n'; printf 'large error output\\n' >&2; i=$((i+1)); done",
        ]),
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(result.status.success());
    assert_eq!(result.stdout.len(), 128_000);
    assert_eq!(result.stderr.len(), 128_000);

    let result = session_launcher::output(
        Command::new("/bin/sh").args(["-c", "printf 'Launch failed' >&2; exit 7"]),
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(result.status.code(), Some(7));
    assert_eq!(result.stderr, b"Launch failed");

    let started = std::time::Instant::now();
    let result = session_launcher::output(
        Command::new("/bin/sh").args(["-c", "sleep 3 & exit 0"]),
        Duration::from_millis(100),
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "An inherited output pipe must not bypass the timeout"
    );
    assert!(result.unwrap_err().contains("did not respond"));
}

#[test]
fn manual_fallback_does_not_claim_a_session_opened_or_replace_its_binding() {
    let f = Fixture::new();
    let resource = session(&f, "codex", false);
    let id = resource["resourceId"].as_str().unwrap();
    let binding = indexer::binding(&f.db, id).unwrap();
    let host = FakeHost {
        manual: true,
        ..FakeHost::default()
    };
    let result = session_launcher::resume_with(id, Tool::Codex, Destination::Warp, &host).unwrap();
    assert_eq!(result["opened"], false);
    assert_eq!(result["manualCommand"], "exact resume command");
    assert_eq!(indexer::binding(&f.db, id).unwrap(), binding);
    assert_eq!(governance_resource(&f, id), resource);
}

#[test]
fn unavailable_resources_and_projects_never_reach_a_launcher() {
    let f = Fixture::new();
    let original = session(&f, "codex", false);
    let id = original["resourceId"].as_str().unwrap();
    let host = FakeHost::default();
    for (field, value) in [
        ("kind", json!("skill")),
        ("source", json!("shared")),
        ("deleted", json!(true)),
    ] {
        let mut resource = original.clone();
        resource[field] = value;
        db::upsert(
            &f.db,
            "resources",
            id,
            f.project["id"].as_str().unwrap(),
            &resource,
        )
        .unwrap();
        assert!(
            session_launcher::resume_with(id, Tool::Codex, Destination::Desktop, &host).is_err()
        );
    }
    db::upsert(
        &f.db,
        "resources",
        id,
        f.project["id"].as_str().unwrap(),
        &original,
    )
    .unwrap();
    let mut project = f.project.clone();
    project["revoked"] = json!(true);
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &project,
    )
    .unwrap();
    assert!(session_launcher::resume_with(id, Tool::Codex, Destination::Desktop, &host).is_err());
    assert!(host.calls.borrow().is_empty());
}

#[test]
fn original_surface_distinguishes_desktop_cli_and_ambiguous_metadata() {
    assert!(!session_launcher::original_desktop(
        Tool::Codex,
        &[
            json!({"type":"session_meta","payload":{"id":"same-thread","source":"cli"}}),
            json!({"type":"session_meta","payload":{"id":"same-thread","originator":"Codex Desktop","source":"vscode"}}),
        ]
    ));
    assert!(!session_launcher::original_desktop(
        Tool::Codex,
        &[
            json!({"type":"session_meta","payload":{"originator":"Codex Desktop","source":"vscode"}}),
            json!({"type":"session_meta","payload":{"source":"cli"}}),
        ]
    ));
    for (meta, desktop) in [
        (
            json!({"originator":"Codex Desktop","source":"vscode"}),
            true,
        ),
        (
            json!({"originator":"codex_work_desktop","source":"cli"}),
            true,
        ),
        (json!({"source":"cli"}), false),
        (json!({"source":"vscode"}), true),
        (json!({"source":"future-client"}), true),
    ] {
        assert_eq!(
            session_launcher::original_desktop(
                Tool::Codex,
                &[json!({"type":"session_meta","payload":meta})]
            ),
            desktop
        );
    }
    for (entrypoint, desktop) in [
        ("cli", false),
        ("local-agent", true),
        ("sdk-cli", true),
        ("future-client", true),
    ] {
        assert_eq!(
            session_launcher::original_desktop(Tool::Claude, &[json!({"entrypoint":entrypoint})]),
            desktop
        );
    }
    assert!(!session_launcher::original_desktop(
        Tool::Claude,
        &[
            json!({"entrypoint":"local-agent","isSidechain":true}),
            json!({"entrypoint":"cli"}),
            json!({"entrypoint":"local-agent"})
        ]
    ));
}

fn replace_records(f: &Fixture, resource: &mut Value, records: &[Value]) {
    let bytes = native::encode(records);
    resource["files"] =
        json!([{"path":"session.jsonl","hash":db::blob(&bytes).unwrap(),"size":bytes.len()}]);
    db::upsert(
        &f.db,
        "resources",
        resource["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        resource,
    )
    .unwrap();
}

#[test]
fn defaults_use_shared_origin_and_fall_back_within_the_provider_first() {
    let f = Fixture::new();
    for source in ["codex", "claude"] {
        let mut resource = session(&f, source, false);
        let id = resource["resourceId"].as_str().unwrap().to_owned();
        let tool = Tool::parse(source).unwrap();
        let records = if source == "codex" {
            vec![
                json!({"type":"session_meta","payload":{"id":uuid::Uuid::new_v4().to_string(),"cwd":f.root,"source":"cli"}}),
                json!({"type":"event_msg","payload":{"type":"user_message","message":"Keep the original origin"}}),
            ]
        } else {
            vec![
                json!({"type":"user","entrypoint":"cli","message":{"role":"user","content":"Keep the original origin"}}),
            ]
        };
        replace_records(&f, &mut resource, &records);
        fs::write(
            f.root.join("original.jsonl"),
            "rewritten receiving desktop metadata",
        )
        .unwrap();
        for (host, expected_tool, destination) in [
            (FakeHost::default(), tool, Destination::Terminal),
            (
                FakeHost {
                    missing_cli: Some(tool),
                    ..FakeHost::default()
                },
                if source == "codex" {
                    Tool::Claude
                } else {
                    Tool::Codex
                },
                Destination::Terminal,
            ),
            (
                FakeHost {
                    missing_cli: Some(tool),
                    missing: Some(Destination::Desktop),
                    ..FakeHost::default()
                },
                if source == "codex" {
                    Tool::Claude
                } else {
                    Tool::Codex
                },
                Destination::Terminal,
            ),
        ] {
            let options =
                serde_json::to_value(session_launcher::options_with(&id, &host).unwrap()).unwrap();
            let defaults: Vec<_> = options
                .as_array()
                .unwrap()
                .iter()
                .filter(|option| option["isDefault"] == true)
                .collect();
            assert_eq!(defaults.len(), 1);
            assert_eq!(defaults[0]["tool"], json!(expected_tool));
            assert_eq!(defaults[0]["destination"], json!(destination));
        }
    }
}

#[test]
fn portable_context_is_complete_readable_and_handoffs_are_immutable() {
    let f = Fixture::new();
    let mut resource = session(&f, "claude", true);
    let id = resource["resourceId"].as_str().unwrap().to_owned();
    let long = "Complete context 🌊\n".repeat(20_000);
    let original_records = [
        json!({"type":"user","message":{"role":"user","content":"<environment_context>private setup</environment_context>\nFirst request"}}),
        json!({"type":"assistant","message":{"role":"assistant","content":long}}),
        json!({"type":"assistant","message":{"role":"assistant","channel":"analysis","content":"hidden reasoning"}}),
        json!({"type":"user","message":{"role":"user","content":"Repeated request"}}),
        json!({"type":"user","message":{"role":"user","content":"Repeated request"}}),
    ];
    replace_records(&f, &mut resource, &original_records);
    let prompt = session_launcher::handoff_prompt(&id).unwrap();
    let text = prompt["text"].as_str().unwrap();
    assert!(text.contains(&long));
    assert_eq!(text.matches("Repeated request").count(), 2);
    assert!(!text.contains("private setup"));
    assert!(!text.contains("hidden reasoning"));
    let host = FakeHost::default();
    let first =
        session_launcher::resume_with(&id, Tool::Codex, Destination::Terminal, &host).unwrap();
    let path = PathBuf::from(first["handoff"].as_str().unwrap());
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), text);
    let retry = session_launcher::resume_with(&id, Tool::Codex, Destination::Warp, &host).unwrap();
    assert_eq!(retry["handoff"], first["handoff"]);
    resource["revision"] = json!(2);
    replace_records(
        &f,
        &mut resource,
        &[json!({"type":"user","message":{"role":"user","content":"A later request"}})],
    );
    let later =
        session_launcher::resume_with(&id, Tool::Codex, Destination::Desktop, &host).unwrap();
    assert_ne!(later["handoff"], first["handoff"]);
    assert_eq!(fs::read_to_string(&path).unwrap(), text);
    fs::write(&path, "local edit").unwrap();
    resource["revision"] = json!(1);
    replace_records(&f, &mut resource, &original_records);
    assert!(
        session_launcher::resume_with(&id, Tool::Codex, Destination::Terminal, &host)
            .unwrap_err()
            .contains("context changed")
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "local edit");
    replace_records(
        &f,
        &mut resource,
        &[
            json!({"type":"user","message":{"role":"user","content":"<environment_context>setup only</environment_context>"}}),
        ],
    );
    assert!(session_launcher::handoff_prompt(&id)
        .unwrap_err()
        .contains("no readable"));
    assert!(session_launcher::resume_with(&id, Tool::Codex, Destination::Terminal, &host).is_err());
}

#[test]
fn cross_provider_cli_receives_one_literal_prompt_without_a_resume_id() {
    let temp = tempfile::tempdir().unwrap();
    let binary = temp.path().join("fake cli");
    fs::write(&binary, "#!/bin/sh\nprintf '%s\\n' \"$#\" \"$1\"\n").unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let prompt = "Continue at '/a path' with $HOME `touch never`\n🌊";
    for tool in [Tool::Codex, Tool::Claude] {
        let path = temp.path().join("start.command");
        let script = session_launcher::terminal_script(
            &binary,
            tool,
            LaunchIntent::Handoff(prompt),
            temp.path(),
            temp.path(),
            None,
            None,
        );
        fs::write(&path, script).unwrap();
        let result = Command::new("/bin/sh").arg(&path).output().unwrap();
        assert!(result.status.success());
        assert_eq!(
            String::from_utf8(result.stdout).unwrap(),
            format!("1\n{prompt}\n")
        );
        assert!(!path.exists());
    }
}

#[test]
fn claude_desktop_requires_confirmation_of_the_exact_session_even_on_zero_exit() {
    let f = Fixture::new();
    let binary = f.root.join("fake claude");
    for (body, success) in [
        ("printf 'Download Claude Desktop to continue\\n'", false),
        ("printf 'Sign in with a Claude subscription\\n'", false),
        (
            "printf 'Opening session another-id in Claude Desktop\\n'",
            false,
        ),
        (
            "printf 'Opening session %s in Claude Desktop\\n' \"$3\"",
            true,
        ),
        (
            "printf 'Opening session %s in Claude Desktop\\n' \"$3\"; exit 1",
            false,
        ),
    ] {
        fs::write(&binary, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            session_launcher::open_claude_desktop(&binary, "exact-native-id", &f.root).is_ok(),
            success
        );
    }
}

#[test]
fn missing_apps_and_clis_are_hidden_and_defaults_prefer_native_continuation() {
    let f = Fixture::new();
    let resource = session(&f, "codex", false);
    let id = resource["resourceId"].as_str().unwrap();
    for (host, tool, destination) in [
        (
            FakeHost {
                missing_target: Some((Destination::Desktop, Tool::Codex)),
                ..FakeHost::default()
            },
            Tool::Codex,
            Destination::Terminal,
        ),
        (
            FakeHost {
                missing_target: Some((Destination::Desktop, Tool::Codex)),
                missing_cli: Some(Tool::Codex),
                ..FakeHost::default()
            },
            Tool::Claude,
            Destination::Desktop,
        ),
    ] {
        let options =
            serde_json::to_value(session_launcher::options_with(id, &host).unwrap()).unwrap();
        let options = options.as_array().unwrap();
        assert!(!options
            .iter()
            .any(|option| option["tool"] == "codex" && option["destination"] == "desktop"));
        let primary = options
            .iter()
            .find(|option| option["isDefault"] == true)
            .unwrap();
        assert_eq!(primary["tool"], json!(tool));
        assert_eq!(primary["destination"], json!(destination));
        if host.missing_cli.is_some() {
            assert!(!options.iter().any(|option| option["tool"] == "codex"));
        }
    }
}

#[test]
fn claude_desktop_capability_rejects_api_auth_and_missing_subscription_without_exposing_output() {
    let f = Fixture::new();
    let binary = f.root.join("fake authenticated claude");
    for (auth, success) in [
        (json!({"loggedIn":true,"authMethod":"claude.ai"}), true),
        (json!({"loggedIn":false,"authMethod":"claude.ai"}), false),
        (
            json!({"loggedIn":true,"authMethod":"api_key","email":"private-address@example.test"}),
            false,
        ),
        (json!({"loggedIn":true,"authMethod":"third_party"}), false),
    ] {
        let script = format!("#!/bin/sh\nif [ \"$1\" = '--help' ]; then printf '%s\\n' '--desktop --resume'; else printf '%s\\n' {}; fi\n", session_launcher::shell_quote(&auth.to_string()));
        fs::write(&binary, script).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let result = session_launcher::claude_desktop_capability(&binary);
        assert_eq!(result.is_ok(), success);
        if let Err(message) = result {
            assert!(!message.contains("private-address"));
        }
    }
}
