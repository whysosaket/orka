use super::*;
use crate::session_launcher::{self, Destination, Host, Tool};
use std::{
    cell::RefCell, os::unix::fs::PermissionsExt, path::Path, process::Command, time::Duration,
};

#[derive(Default)]
struct FakeHost {
    active: bool,
    native_activity: bool,
    missing: Option<Destination>,
    fail: bool,
    manual: bool,
    cli_error: Option<&'static str>,
    desktop_cli_error: Option<&'static str>,
    scope_change: Option<(&'static str, Value)>,
    calls: RefCell<Vec<Value>>,
}
impl Host for FakeHost {
    fn installed(&self, destination: Destination, _: Tool) -> bool {
        if let Some((key, value)) = &self.scope_change {
            db::set(&db::open().unwrap(), key, value).unwrap();
        }
        self.missing != Some(destination)
    }
    fn icon(&self, destination: Destination, tool: Tool) -> Option<String> {
        self.installed(destination, tool)
            .then(|| "data:image/png;base64,test-icon".into())
    }
    fn cli(&self, _: Tool, desktop: bool) -> db::Result<PathBuf> {
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
        id: &str,
        root: &Path,
        _: Option<&Path>,
    ) -> db::Result<Option<String>> {
        self.calls
            .borrow_mut()
            .push(json!({"destination":destination,"tool":tool,"id":id,"root":root}));
        if self.fail {
            Err("Launch failed".into())
        } else {
            Ok(self.manual.then(|| "exact resume command".into()))
        }
    }
}

fn session(f: &Fixture, source: &str, teammate: bool) -> Value {
    let resource = json!({"resourceId":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],"kind":"session","source":source,"owner":if teammate {json!(uuid::Uuid::new_v4().to_string())} else {db::get(&f.db,"user").unwrap()},"revision":1,"deleted":false,"files":[]});
    let id = resource["resourceId"].as_str().unwrap();
    db::upsert(
        &f.db,
        "resources",
        id,
        f.project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    db::upsert(&f.db,"bindings",id,f.project["id"].as_str().unwrap(),&json!({"nativeId":uuid::Uuid::new_v4().to_string(),"base":resource,"paths":[f.root.join("original.jsonl")],"copyRequest":"existing-request"})).unwrap();
    resource
}

#[test]
fn exact_native_identity_and_copy_guard_survive_every_destination_and_retry() {
    let f = Fixture::new();
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
                        session_launcher::resume_with(id, tool, destination, &host).unwrap()
                            ["opened"],
                        true
                    );
                }
                assert_eq!(host.calls.borrow().len(), 2);
                assert_eq!(
                    host.calls.borrow()[0],
                    json!({"destination":destination,"tool":tool,"id":binding["nativeId"],"root":f.root})
                );
                assert_eq!(
                    fs::read_to_string(f.root.join("original.jsonl")).unwrap(),
                    "original native bytes"
                );
                let after = indexer::binding(&f.db, id).unwrap();
                assert_eq!(after["copyRequest"], "existing-request");
                assert_eq!(after["needsCopy"] == true, teammate);
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
        assert!(
            session_launcher::resume_with(id, Tool::Claude, destination, &host)
                .unwrap_err()
                .contains("already be open")
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
            assert!(
                session_launcher::resume_with(id, Tool::Claude, destination, &host)
                    .unwrap_err()
                    .contains("already be open")
            );
        }
    }
    assert_eq!(host.calls.borrow().len(), destinations.len());
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
            let needs_cli = option["destination"] != "desktop"
                || (source == "claude" && option["tool"] == source);
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
fn missing_or_invalid_native_bindings_never_launch_or_mark_a_copy() {
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
            assert!(session_launcher::resume_with(id, Tool::Codex, destination, &host).is_err());
        }
        assert_eq!(indexer::binding(&f.db, id).unwrap(), binding);
        assert_eq!(governance_resource(&f, id), resource);
        assert!(host.calls.borrow().is_empty());
        assert!(f.outbox().is_empty());
    }
    f.db.execute("DELETE FROM bindings WHERE id=?", [id])
        .unwrap();
    let options =
        serde_json::to_value(session_launcher::options_with(id, &FakeHost::default()).unwrap())
            .unwrap();
    for option in options.as_array().unwrap() {
        if option["tool"] == "codex" {
            assert_eq!(option["available"], false);
            assert_eq!(option["reason"], "Sync first to install the native session");
        } else {
            assert_eq!(option["available"], true);
        }
    }
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
    assert_eq!(options.as_array().unwrap().len(), 4);
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
        assert!(
            session_launcher::resume_with(id, destination, Destination::Terminal, &host).is_err()
        );
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
                "exact-session-id",
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
