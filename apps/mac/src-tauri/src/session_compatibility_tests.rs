use super::*;
use std::os::unix::fs::PermissionsExt;

fn mock_codex(f: &Fixture) {
    let bin = f._home.path().join(".local/bin");
    fs::create_dir_all(&bin).unwrap();
    let path = bin.join("codex");
    fs::write(&path, r##"#!/usr/bin/env python3
import json,os,sys,uuid,pathlib
home=pathlib.Path(os.environ['CODEX_HOME'])
if '--version' in sys.argv:
 print('codex-cli 0.90.0');sys.exit()
if 'proxy' in sys.argv: sys.exit(1)
home.mkdir(parents=True,exist_ok=True)
def find(id):
 return next(home.glob('sessions/**/*'+id+'.jsonl'),None)
for line in sys.stdin:
 req=json.loads(line)
 if 'id' not in req: continue
 method=req['method'];p=req.get('params',{});error=None;result={}
 with (home/'requests.jsonl').open('a') as f: f.write(json.dumps(req)+'\n')
 if method=='initialize': result={'userAgent':'codex/0.90.0'}
 elif method in ['thread/turns/list','project/create','thread/metadata/update','thread/unsubscribe']:
  error={'code':-32601,'message':'Method not found'}
 elif method=='thread/name/set' and (home/'fail-name').exists():
  error={'code':-32000,'message':'permission denied'}
 elif method=='thread/fork':
  records=[json.loads(l) for l in pathlib.Path(p['path']).read_text().splitlines()]
  assert records[0]['payload']['history_mode']=='legacy'
  assert all('ordinal' not in r for r in records)
  id=str(uuid.uuid4());source=records[0]['payload']['id']
  records[0]['payload'].update(id=id,forked_from_id=source)
  path=pathlib.Path(p['path']).with_name('rollout-fixture-'+id+'.jsonl')
  path.write_text(''.join(json.dumps(r)+'\n' for r in records))
  result={'thread':{'id':id,'path':str(path),'cwd':p['cwd']}}
 elif method=='thread/archive':
  path=find(p['threadId']);archive=home/'archived_sessions';archive.mkdir(exist_ok=True)
  if path: path.rename(archive/path.name)
 elif method=='thread/read':
  path=find(p['threadId'])
  assert path is not None
  result={'thread':{'id':p['threadId'],'path':str(path)}}
 elif method=='thread/loaded/list': result={'data':[]}
 print(json.dumps({'id':req['id'],**({'error':error} if error else {'result':result})}),flush=True)
"##).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn older_codex_receiver_translates_paginated_lineage_and_retries_without_duplicates() {
    let f = Fixture::new();
    let (resource, paths) = paginated_chain(&f);
    let original = History::resource(&resource).unwrap().records();
    fs::remove_dir_all(native::codex_home().unwrap()).unwrap();
    mock_codex(&f);
    let home = native::codex_home().unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("fail-name"), "").unwrap();
    let err =
        crate::codex_import::materialize(&f.db, &f.project, &resource, &json!({})).unwrap_err();
    assert!(err.contains("permission denied"), "{err}");
    fs::remove_file(home.join("fail-name")).unwrap();
    let (id, path) =
        crate::codex_import::materialize(&f.db, &f.project, &resource, &json!({})).unwrap();
    let copy = History::local(&path, Some(&f.root)).unwrap().records();
    assert!(paths.iter().all(|p| !p.exists()));
    assert_eq!(copy[0]["payload"]["history_mode"], "legacy");
    assert!(copy.iter().all(|r| r["ordinal"].is_null()));
    assert_eq!(native::transcript(&copy), native::transcript(&original));
    assert!(copy.iter().any(|r| r["type"] == "compacted"));
    assert!(copy
        .iter()
        .any(|r| r["metadata"]["retained_source"].is_object()));
    let requests =
        native::complete_records(&fs::read(home.join("requests.jsonl")).unwrap()).unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["method"] == "thread/fork")
            .count(),
        1
    );
    assert!(requests
        .iter()
        .all(|r| !matches!(r["method"].as_str(), Some("turn/start" | "thread/resume"))));
    assert_eq!(
        crate::codex_import::materialize(&f.db, &f.project, &resource, &json!({}))
            .unwrap()
            .0,
        id
    );
    assert_eq!(History::resource(&resource).unwrap().records(), original);
}

#[test]
fn claude_import_reuses_identity_and_preserves_graph_tools_and_local_edits() {
    let f = Fixture::new();
    let source_id = uuid::Uuid::new_v4().to_string();
    let records = vec![
        json!({"type":"user","sessionId":source_id,"cwd":"/old/project","version":"2.1.277","uuid":"first","parentUuid":null,"message":{"role":"user","content":"Fix this"}}),
        json!({"type":"assistant","sessionId":source_id,"cwd":"/old/project","version":"2.1.286","uuid":"second","parentUuid":"first","message":{"role":"assistant","content":[{"type":"tool_use","id":"call","name":"Read","input":{"path":"/old/project/file"}}]}}),
        json!({"type":"user","sessionId":source_id,"uuid":"third","parentUuid":"second","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call","content":"historical output"}]}}),
    ];
    let bytes = native::encode(&records);
    let resource = json!({"resourceId":uuid::Uuid::new_v4(),"revision":1,"files":[{"path":"session.jsonl","size":bytes.len(),"hash":db::blob(&bytes).unwrap()}]});
    let (id, path) =
        crate::claude_import::materialize(&f.db, &f.project, &resource, &json!({}), &records)
            .unwrap();
    let copy = native::complete_records(&fs::read(&path).unwrap()).unwrap();
    assert_ne!(id, source_id);
    for (a, b) in records.iter().zip(&copy) {
        for key in ["message", "uuid", "parentUuid", "version"] {
            assert_eq!(a[key], b[key]);
        }
        assert_eq!(b["sessionId"], id);
    }
    assert_eq!(
        crate::claude_import::materialize(&f.db, &f.project, &resource, &json!({}), &records)
            .unwrap(),
        (id.clone(), path.clone())
    );
    let changed = [
        fs::read(&path).unwrap(),
        b"{\"type\":\"user\",\"message\":{\"content\":\"local edit\"}}\n".to_vec(),
    ]
    .concat();
    fs::write(&path, &changed).unwrap();
    assert!(
        crate::claude_import::materialize(&f.db, &f.project, &resource, &json!({}), &records)
            .unwrap_err()
            .contains("session changed")
    );
    assert_eq!(fs::read(&path).unwrap(), changed);
    assert_eq!(
        db::blob_read(resource["files"][0]["hash"].as_str().unwrap()).unwrap(),
        bytes
    );
}

#[test]
fn local_codex_forks_use_complete_cached_history_and_never_replace_source_files() {
    let f = Fixture::new();
    let (resource, paths) = paginated_chain(&f);
    let original = History::resource(&resource).unwrap().records();
    let original_files: Vec<_> = paths.iter().map(|path| fs::read(path).unwrap()).collect();
    mock_codex(&f);
    let _sync = crate::projects::lock().unwrap();
    let mut ids = Vec::new();
    for _ in 0..2 {
        let binding = native::fork_session(&f.db, &f.project, &resource).unwrap();
        let id = binding["nativeId"].as_str().unwrap();
        assert!(!ids.iter().any(|previous| previous == id));
        let copy = History::local(
            PathBuf::from(binding["paths"][0].as_str().unwrap()).as_path(),
            Some(&f.root),
        )
        .unwrap()
        .records();
        assert_eq!(native::transcript(&copy), native::transcript(&original));
        assert!(copy.iter().any(|record| record["type"] == "compacted"));
        ids.push(id.to_string());
    }
    for (path, bytes) in paths.iter().zip(original_files) {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    assert_eq!(History::resource(&resource).unwrap().records(), original);
}

#[test]
fn local_claude_forks_preserve_native_graphs_and_leave_an_active_original_untouched() {
    let f = Fixture::new();
    let bin = f._home.path().join(".local/bin");
    fs::create_dir_all(&bin).unwrap();
    fs::write(
        bin.join("claude"),
        "#!/bin/sh\nprintf '2.1.286 (Claude Code)\\n'\n",
    )
    .unwrap();
    fs::set_permissions(bin.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
    let original_id = uuid::Uuid::new_v4().to_string();
    let records = vec![
        json!({"type":"user","sessionId":original_id,"cwd":f.root,"uuid":"first","parentUuid":null,"message":{"role":"user","content":"Keep this history"}}),
        json!({"type":"assistant","sessionId":original_id,"cwd":f.root,"uuid":"second","parentUuid":"first","message":{"role":"assistant","content":[{"type":"tool_use","id":"call","name":"Read","input":{"path":"historical"}}]}}),
    ];
    let bytes = native::encode(&records);
    let original_path = f.root.join("original.jsonl");
    fs::write(&original_path, &bytes).unwrap();
    f.db.execute(
        "INSERT INTO active VALUES(?,?)",
        rusqlite::params![original_id, json!({"pid":std::process::id()}).to_string()],
    )
    .unwrap();
    let resource = json!({"resourceId":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],"source":"claude","revision":1,"files":[{"path":"session.jsonl","hash":db::blob(&bytes).unwrap(),"size":bytes.len()}]});
    let _sync = crate::projects::lock().unwrap();
    let mut ids = Vec::new();
    for _ in 0..2 {
        let fork = native::fork_session(&f.db, &f.project, &resource).unwrap();
        let id = fork["nativeId"].as_str().unwrap();
        let listed = crate::session_forks::record(&f.db, &resource, &fork, "desktop").unwrap();
        assert_eq!(
            crate::session_forks::binding(&f.db, &listed).unwrap()["nativeId"],
            id
        );
        let current = crate::session_forks::current_resource(&f.db, &listed).unwrap();
        assert_eq!(
            native::transcript(&crate::history::resource_records(&current).unwrap()),
            native::transcript(&records)
        );
        assert_ne!(id, original_id);
        assert!(!ids.iter().any(|previous| previous == id));
        let copy = native::complete_records(&fs::read(fork["paths"][0].as_str().unwrap()).unwrap())
            .unwrap();
        for (old, new) in records.iter().zip(copy) {
            for key in ["message", "uuid", "parentUuid"] {
                assert_eq!(old[key], new[key]);
            }
            assert_eq!(new["sessionId"], id);
        }
        ids.push(id.to_string());
    }
    assert_eq!(fs::read(original_path).unwrap(), bytes);
    assert!(f.outbox().is_empty());
}

#[test]
#[ignore = "requires installed Codex; isolated cached fork acceptance without model work"]
fn cached_forks_are_independent_and_readable_by_installed_codex_while_sync_is_locked() {
    let f = Fixture::new();
    f.select_codex_binary();
    let (resource, paths) = paginated_chain(&f);
    let history = History::resource(&resource).unwrap().records();
    let originals: Vec<_> = paths.iter().map(|path| fs::read(path).unwrap()).collect();
    let _sync = crate::projects::lock().unwrap();
    let mut ids = Vec::new();
    for _ in 0..2 {
        let fork = native::fork_session(&f.db, &f.project, &resource).unwrap();
        let id = fork["nativeId"].as_str().unwrap();
        let listed = crate::session_forks::record(&f.db, &resource, &fork, "desktop").unwrap();
        assert_eq!(
            crate::session_forks::binding(&f.db, &listed).unwrap()["nativeId"],
            id
        );
        let current = crate::session_forks::current_resource(&f.db, &listed).unwrap();
        assert_eq!(
            native::transcript(&crate::history::resource_records(&current).unwrap()),
            native::transcript(&history)
        );
        assert!(!ids.iter().any(|previous| previous == id));
        let local = History::local(
            std::path::Path::new(fork["paths"][0].as_str().unwrap()),
            Some(&f.root),
        )
        .unwrap()
        .records();
        assert_eq!(native::transcript(&local), native::transcript(&history));
        let read = native::Rpc::connect()
            .unwrap()
            .call("thread/read", json!({"threadId":id,"includeTurns":false}))
            .unwrap();
        assert_eq!(read["thread"]["id"], id);
        assert!(!native::active_for_resume(
            &f.db,
            id,
            "codex",
            &[PathBuf::from(fork["paths"][0].as_str().unwrap())]
        ));
        ids.push(id.to_string());
    }
    for (path, bytes) in paths.iter().zip(originals) {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn legacy_import_relocates_execution_context_without_changing_historical_paths() {
    let f = Fixture::new();
    let (resource, _) = paginated_chain(&f);
    let mut history = History::resource(&resource).unwrap();
    let old_id = history.rollouts.last().unwrap().id.clone();
    let mut copy = history.independent_legacy(&old_id, &f.root).unwrap();
    copy.records.push(json!({"type":"turn_context","payload":{"cwd":f.root,"workspace_roots":[f.root],"runtime_workspace_roots":[f.root]}}));
    copy.records.push(json!({"type":"response_item","payload":{"type":"function_call","call_id":"path-call","arguments":"/old/keep"}}));
    history.rollouts = vec![copy];
    let id = uuid::Uuid::new_v4().to_string();
    let target = f.root.join("new");
    history.remap(std::slice::from_ref(&id), &target).unwrap();
    for r in history.records() {
        if r["type"] == "turn_context" {
            assert_eq!(r["payload"]["cwd"], json!(target));
        }
        if r["payload"]["type"] == "thread_settings_applied" {
            assert_eq!(r["payload"]["thread_settings"]["cwd"], json!(target));
        }
        if r["payload"]["thread_id"].is_string() {
            assert_eq!(r["payload"]["thread_id"], id);
        }
        if r["payload"]["call_id"] == "path-call" {
            assert_eq!(r["payload"]["arguments"], "/old/keep");
        }
    }
}

#[test]
fn observed_version_matrix_indexes_and_exports_without_native_rewrites() {
    let f = Fixture::new();
    let codex = native::codex_home().unwrap().join("sessions");
    let claude = native::claude_home().unwrap().join("projects/test");
    fs::create_dir_all(&codex).unwrap();
    fs::create_dir_all(&claude).unwrap();
    let mut sources = Vec::new();
    for (tool, versions) in [
        (
            "codex",
            vec![
                "0.155.0-alpha.9.2",
                "0.155.0-alpha.16.3",
                "0.159.2",
                "0.159.3",
                "0.160.0",
            ],
        ),
        (
            "claude",
            vec![
                "2.1.277", "2.1.278", "2.1.283", "2.1.284", "2.1.285", "2.1.286",
            ],
        ),
    ] {
        for version in versions {
            let id = uuid::Uuid::new_v4().to_string();
            let records = if tool == "codex" {
                vec![
                    json!({"type":"session_meta","ordinal":0,"payload":{"id":id,"cwd":f.root,"cli_version":version,"history_mode":"paginated"}}),
                    json!({"type":"event_msg","ordinal":1,"payload":{"type":"user_message","message":"Compatibility fixture"}}),
                ]
            } else {
                vec![
                    json!({"type":"user","sessionId":id,"cwd":f.root,"version":version,"message":{"content":"Compatibility fixture"}}),
                ]
            };
            let path = if tool == "codex" {
                codex.join(format!("rollout-{id}.jsonl"))
            } else {
                claude.join(format!("{id}.jsonl"))
            };
            let bytes = native::encode(&records);
            fs::write(&path, &bytes).unwrap();
            sources.push((path, bytes));
        }
    }
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.resources().len(), sources.len());
    assert!(
        db::rows(&f.db, "SELECT json_object('error',error) FROM errors", &[])
            .unwrap()
            .is_empty()
    );
    for (path, bytes) in sources {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    for r in f.resources() {
        let records = crate::history::resource_records(&r).unwrap();
        assert_eq!(
            crate::session_presentation::conversation_messages(&records)[0].text,
            "Compatibility fixture"
        );
        let path = f.root.join(format!(
            "{}.orka-session",
            r["resourceId"].as_str().unwrap()
        ));
        bundles::export(&f.db, r["resourceId"].as_str().unwrap(), &path).unwrap();
        bundles::import(&f.db, f.project["id"].as_str().unwrap(), &path).unwrap();
    }
}

#[test]
#[ignore = "requires installed Codex; isolated cross-version native import"]
fn compatibility_native_import_and_read_preserve_conversation() {
    let f = Fixture::new();
    f.select_codex_binary();
    let (resource, _) = paginated_chain(&f);
    fs::remove_dir_all(native::codex_home().unwrap()).unwrap();
    let (id, path) =
        crate::codex_import::materialize(&f.db, &f.project, &resource, &json!({})).unwrap();
    let records = History::local(&path, Some(&f.root)).unwrap().records();
    let transcript = native::transcript(&records);
    for marker in ["Ancestor α 🌊", "Middle β", "Leaf γ", "Tool result"] {
        assert!(transcript.contains(marker), "Missing {marker}");
    }
    let mut rpc = native::Rpc::connect().unwrap();
    let paginated = rpc.supports_pagination().unwrap();
    let resumed = rpc
        .call(
            "thread/resume",
            json!({"threadId":id,"excludeTurns":paginated,"deferGoalContinuation":true}),
        )
        .unwrap();
    assert_eq!(resumed["thread"]["id"], id);
    let native_history = if paginated {
        rpc.call("thread/items/list", json!({"threadId":id,"limit":100}))
            .unwrap()
    } else {
        resumed
    };
    let text = native_history.to_string();
    for marker in ["Ancestor α 🌊", "Middle β", "Leaf γ"] {
        assert!(text.contains(marker), "Native history is missing {marker}");
    }
    rpc.call_optional("thread/unsubscribe", json!({"threadId":id}))
        .unwrap();
}

#[test]
fn unrecognized_cli_patch_versions_are_accepted_but_failed_commands_are_not() {
    let f = Fixture::new();
    let bin = f._home.path().join(".local/bin");
    fs::create_dir_all(&bin).unwrap();
    let cli = bin.join("claude");
    fs::write(&cli, "#!/bin/sh\necho '2.1.999 (Claude Code)'\n").unwrap();
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(native::version("claude").unwrap(), "2.1.999 (Claude Code)");
    fs::write(&cli, "#!/bin/sh\necho '2.1.999 (Claude Code)'\nexit 1\n").unwrap();
    assert!(native::version("claude").is_err());
}

#[test]
fn stalled_cli_version_probe_returns_a_recoverable_error() {
    let f = Fixture::new();
    let bin = f._home.path().join(".local/bin");
    fs::create_dir_all(&bin).unwrap();
    let cli = bin.join("claude");
    fs::write(&cli, "#!/bin/sh\nexec /bin/sleep 60\n").unwrap();
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    let started = std::time::Instant::now();
    assert!(native::version("claude").unwrap_err().contains("timed out"));
    assert!(started.elapsed() < std::time::Duration::from_secs(20));
}

#[test]
fn completed_import_rebinds_to_archived_history_without_forking_or_unarchiving() {
    let f = Fixture::new();
    let (mut resource, _) = paginated_chain(&f);
    resource["owner"] = json!(uuid::Uuid::new_v4().to_string());
    fs::remove_dir_all(native::codex_home().unwrap()).unwrap();
    mock_codex(&f);
    sync::materialize(&f.db, &f.project, &resource).unwrap();
    let id = resource["resourceId"].as_str().unwrap().to_string();
    let binding = indexer::binding(&f.db, &id).unwrap();
    let home = native::codex_home().unwrap();
    let path = PathBuf::from(binding["paths"][0].as_str().unwrap());
    let archive = home.join("archived_sessions");
    fs::create_dir_all(&archive).unwrap();
    let archived = archive.join(path.file_name().unwrap());
    fs::rename(&path, &archived).unwrap();
    let bytes = fs::read(&archived).unwrap();
    f.db.execute("DELETE FROM bindings WHERE id=?", [&id])
        .unwrap();
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    f.db.execute(
        "INSERT INTO errors VALUES(?,?)",
        [&id, "No such file or directory"],
    )
    .unwrap();
    let requests_before = fs::read(home.join("requests.jsonl")).unwrap();
    crate::repair::workspace(&f.db).unwrap();
    assert_eq!(
        fs::read(home.join("requests.jsonl")).unwrap(),
        requests_before,
        "Offline repair must not need a native RPC or cloud connection"
    );
    assert!(
        db::rows(&f.db, "SELECT json_object('error',error) FROM errors", &[])
            .unwrap()
            .is_empty()
    );
    sync::materialize(&f.db, &f.project, &resource).unwrap();
    let repaired = indexer::binding(&f.db, &id).unwrap();
    assert_eq!(repaired["nativeId"], binding["nativeId"]);
    assert_eq!(repaired["paths"], json!([archived]));
    assert!(!path.exists());
    assert_eq!(fs::read(&archived).unwrap(), bytes);
    let requests =
        native::complete_records(&fs::read(home.join("requests.jsonl")).unwrap()).unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["method"] == "thread/fork")
            .count(),
        1
    );
    fs::create_dir_all(native::claude_home().unwrap().join("projects")).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        f.outbox().is_empty(),
        "Peer archives must not create feedback copies or deletes"
    );
    assert_ne!(indexer::binding(&f.db, &id).unwrap()["needsCopy"], true);
    fs::rename(&archived, &path).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        f.outbox().is_empty(),
        "Unarchiving an unchanged peer copy must not publish a duplicate"
    );
    fs::rename(&path, &archived).unwrap();
    resource["revision"] = json!(resource["revision"].as_u64().unwrap() + 1);
    resource["deleted"] = json!(true);
    resource["files"] = json!([]);
    sync::materialize(&f.db, &f.project, &resource).unwrap();
    assert_eq!(
        indexer::binding(&f.db, &id).unwrap()["base"]["deleted"],
        true
    );
    assert_eq!(fs::read(&archived).unwrap(), bytes);
    let requests =
        native::complete_records(&fs::read(home.join("requests.jsonl")).unwrap()).unwrap();
    assert!(
        !requests
            .iter()
            .any(|r| r["method"] == "thread/archive"
                && r["params"]["threadId"] == binding["nativeId"])
    );
}

#[test]
fn relocated_import_with_changed_bytes_keeps_edits_and_guard() {
    let f = Fixture::new();
    let (resource, _) = paginated_chain(&f);
    fs::remove_dir_all(native::codex_home().unwrap()).unwrap();
    mock_codex(&f);
    sync::materialize(&f.db, &f.project, &resource).unwrap();
    let id = resource["resourceId"].as_str().unwrap();
    let binding = indexer::binding(&f.db, id).unwrap();
    let path = PathBuf::from(binding["paths"][0].as_str().unwrap());
    let archive = native::codex_home().unwrap().join("archived_sessions");
    fs::create_dir_all(&archive).unwrap();
    let archived = archive.join(path.file_name().unwrap());
    fs::rename(&path, &archived).unwrap();
    let mut bytes = fs::read(&archived).unwrap();
    bytes.extend_from_slice(b"{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Preserve local continuation\"}}\n");
    fs::write(&archived, &bytes).unwrap();
    f.db.execute("DELETE FROM bindings WHERE id=?", [&id])
        .unwrap();
    assert!(sync::materialize(&f.db, &f.project, &resource)
        .unwrap_err()
        .contains("changed"));
    assert_eq!(fs::read(&archived).unwrap(), bytes);
    assert!(!path.exists());
}
