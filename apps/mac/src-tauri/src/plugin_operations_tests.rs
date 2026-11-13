use super::*;
use crate::{plugin_operations as operations, selective_sharing};
use rusqlite::params;

fn input(f: &Fixture) -> Value {
    db::set(&f.db, "config", &json!({"apiUrl":"https://plugin.example"})).unwrap();
    json!({"accountId":db::get(&f.db,"user").unwrap(),"serviceOrigin":"https://plugin.example","projectId":f.project["id"]})
}

fn skill(f: &Fixture) -> Value {
    let root = f._home.path().join("package");
    fs::create_dir_all(root.join("scripts")).unwrap();
    fs::write(
        root.join("SKILL.md"),
        "---\nname: example\ndescription: Fixture\n---\nRead this skill.",
    )
    .unwrap();
    fs::write(root.join("scripts/run.sh"), "#!/bin/sh\nexit 0\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        root.join("scripts/run.sh"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    json!({"resourceId":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],"kind":"skill","logicalPath":"example","title":"Example","revision":3,"files":packages::directory(&root).unwrap(),"deleted":false})
}

#[test]
fn plugin_skill_install_preserves_complete_packages_agent_targets_and_existing_files() {
    let f = Fixture::new();
    let mut request = input(&f);
    let r = skill(&f);
    request["target"] = json!("project");
    request["snapshotHash"] = json!(indexer::manifest_hash(&r["files"]));
    let result = operations::install(&f.db, &f.project, &r, &request).unwrap();
    assert_eq!(result["status"], "installed");
    use std::os::unix::fs::PermissionsExt;
    for folder in [".agents/skills/example", ".claude/skills/example"] {
        let path = f.root.join(folder);
        assert_eq!(
            packages::directory(&path).unwrap(),
            r["files"].as_array().unwrap().clone()
        );
        assert_ne!(
            fs::metadata(path.join("scripts/run.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o111,
            0
        );
    }
    assert!(f.outbox().is_empty());
    fs::write(
        f.root.join(".claude/skills/example/notes.txt"),
        "Private notes",
    )
    .unwrap();
    assert!(operations::install(&f.db, &f.project, &r, &request)
        .unwrap_err()
        .contains("preserved"));
    assert_eq!(
        fs::read_to_string(f.root.join(".claude/skills/example/notes.txt")).unwrap(),
        "Private notes"
    );
    for target in ["codex", "claude"] {
        let root = if target == "codex" {
            native::codex_home().unwrap()
        } else {
            native::claude_home().unwrap()
        };
        fs::create_dir_all(&root).unwrap();
        request["target"] = json!(target);
        operations::install(&f.db, &f.project, &r, &request).unwrap();
        assert_eq!(
            packages::directory(&root.join("skills/example")).unwrap(),
            r["files"].as_array().unwrap().clone()
        );
    }
}

#[test]
fn plugin_skill_install_rejects_stale_secret_symlink_and_escaping_packages() {
    let f = Fixture::new();
    let mut request = input(&f);
    let mut r = skill(&f);
    request["target"] = json!("project");
    request["snapshotHash"] = json!("outdated");
    assert!(operations::install(&f.db, &f.project, &r, &request)
        .unwrap_err()
        .contains("changed"));
    for name in ["../escape", ".env", "scripts/.env.local"] {
        r["files"][1]["path"] = json!(name);
        request["snapshotHash"] = json!(indexer::manifest_hash(&r["files"]));
        assert!(operations::install(&f.db, &f.project, &r, &request).is_err());
    }
    r["files"][1]["path"] = json!("scripts/run.sh");
    request["snapshotHash"] = json!(indexer::manifest_hash(&r["files"]));
    let outside = f._home.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::create_dir_all(f.root.join(".agents")).unwrap();
    std::os::unix::fs::symlink(&outside, f.root.join(".agents/skills")).unwrap();
    assert!(operations::install(&f.db, &f.project, &r, &request).is_err());
    assert!(!outside.join("example").exists());
    assert!(!f.root.join(".claude/skills/example").exists());
}

#[test]
fn plugin_local_catalog_and_status_bind_account_service_project_and_do_not_publish() {
    let f = Fixture::new();
    let mut request = input(&f);
    let r = skill(&f);
    db::upsert(
        &f.db,
        "resources",
        r["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &r,
    )
    .unwrap();
    let root = native::codex_home().unwrap().join("skills/global-example");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("SKILL.md"), "Global fixture").unwrap();
    let local = f.root.join(".agents/skills/local-example");
    fs::create_dir_all(&local).unwrap();
    fs::write(local.join("SKILL.md"), "Local fixture").unwrap();
    let list = operations::skills(&f.db, &f.project, &request).unwrap();
    for origin in ["shared", "global", "local"] {
        assert!(
            list["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["origin"] == origin),
            "{origin}: {list}"
        );
    }
    assert!(f.outbox().is_empty());
    assert_eq!(
        operations::status(&f.db, &f.project, &request).unwrap()["health"],
        "idle"
    );
    selective_sharing::context(&f.db, &request).unwrap();
    request["accountId"] = json!(uuid::Uuid::new_v4().to_string());
    assert!(selective_sharing::context(&f.db, &request).is_err());
    request = input(&f);
    request["serviceOrigin"] = json!("https://other.example");
    assert!(selective_sharing::context(&f.db, &request).is_err());
    request = input(&f);
    request["projectId"] = json!(uuid::Uuid::new_v4().to_string());
    assert!(selective_sharing::context(&f.db, &request).is_err());
}

#[test]
fn plugin_retry_preserves_payloads_receipts_conflicts_and_unrelated_projects() {
    let f = Fixture::new();
    input(&f);
    let project = f.project["id"].as_str().unwrap();
    for (id, owner, error) in [
        ("retry", project, "503: temporary"),
        ("stale", project, "409: stale conflict"),
        ("permission", project, "403: denied"),
        ("other", "other-project", "503: other"),
    ] {
        f.db.execute(
            "INSERT INTO outbox VALUES(?,?,?,?,?)",
            params![
                id,
                owner,
                "/v2/sessions/resolve",
                json!({"id":id,"resourceId":"resource","pending":"original bytes"}).to_string(),
                error
            ],
        )
        .unwrap();
    }
    let payloads = f.outbox();
    let result = operations::retry(&f.db, &f.project).unwrap();
    assert_eq!(result["eligibleCount"], 1);
    assert_eq!(result["blockedCount"], 2);
    assert_eq!(f.outbox(), payloads);
    let errors = db::rows(
        &f.db,
        "SELECT json_object('id',id,'error',error) FROM outbox ORDER BY rowid",
        &[],
    )
    .unwrap();
    assert_eq!(errors[0]["error"], Value::Null);
    assert_eq!(errors[1]["error"], "409: stale conflict");
    assert_eq!(errors[2]["error"], "403: denied");
    assert_eq!(errors[3]["error"], "503: other");
    let status = operations::status(&f.db, &f.project, &json!({})).unwrap();
    assert_eq!(status["queuedCount"], 3);
    assert_eq!(status["blockedCount"], 2);
    assert_eq!(status["health"], "error");
}

#[test]
fn plugin_repair_skips_resources_with_pending_changes_and_keeps_recovery_for_other_projects() {
    let mut f = Fixture::new();
    f.project["sharing"] = json!(crate::projects::Sharing::new_project());
    let mut r = skill(&f);
    r["deleted"] = json!(true);
    let id = r["resourceId"].as_str().unwrap();
    db::upsert(
        &f.db,
        "resources",
        id,
        f.project["id"].as_str().unwrap(),
        &r,
    )
    .unwrap();
    let binding = json!({"base":{"revision":1},"paths":[],"lastSeenHash":"pending guard"});
    db::upsert(
        &f.db,
        "bindings",
        id,
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    f.db.execute(
        "INSERT INTO outbox VALUES(?,?,?,?,NULL)",
        params![
            "pending",
            f.project["id"].as_str(),
            "/v2/sync/push",
            json!({"id":"pending","resourceId":id,"files":"private pending bytes"}).to_string()
        ],
    )
    .unwrap();
    let outbox = f.outbox();
    db::set(
        &f.db,
        "installation:other",
        &json!({"project":{"id":"other"},"desired":"preserved"}),
    )
    .unwrap();
    crate::repair::project_state(&f.db, &f.project).unwrap();
    packages::recover_project_installations(&f.db, &f.project).unwrap();
    assert_eq!(indexer::binding(&f.db, id).unwrap(), binding);
    assert_eq!(f.outbox(), outbox);
    assert_eq!(
        db::get(&f.db, "installation:other").unwrap()["desired"],
        "preserved"
    );
}

#[test]
fn plugin_project_sync_keeps_unrelated_scans_and_account_requests_untouched() {
    let f = Fixture::new();
    db::set(&f.db, "config", &json!({"apiUrl":"invalid-fixture-origin"})).unwrap();
    db::set(
        &f.db,
        "sync",
        &json!({"online":true,"lastSync":"account success"}),
    )
    .unwrap();
    db::set(&f.db, "syncRequest", &json!("account pending request")).unwrap();
    db::set(
        &f.db,
        "syncHandledRequest",
        &json!("previous account request"),
    )
    .unwrap();
    let other_root = f._home.path().join("other-project");
    let other_skill = other_root.join(".agents/skills/other");
    fs::create_dir_all(&other_skill).unwrap();
    fs::write(other_skill.join("SKILL.md"), "Unrelated").unwrap();
    let other = json!({"id":uuid::Uuid::new_v4().to_string(),"name":"Other","path":other_root});
    db::upsert(&f.db, "projects", other["id"].as_str().unwrap(), "", &other).unwrap();
    let local = f.root.join(".agents/skills/selected");
    fs::create_dir_all(&local).unwrap();
    fs::write(local.join("SKILL.md"), "Selected").unwrap();
    let owner = db::get(&f.db, "user").unwrap();
    let result = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(sync::plugin_once(
            owner.as_str().unwrap(),
            "invalid-fixture-origin",
            f.project["id"].as_str().unwrap(),
        ));
    assert!(result.is_err());
    assert!(f.resources().is_empty());
    assert!(db::get(
        &f.db,
        &format!("firstScan:{}", f.project["id"].as_str().unwrap())
    )
    .unwrap()
    .is_null());
    assert!(!f.resources().iter().any(|r| r["projectId"] == other["id"]));
    assert_eq!(
        db::get(&f.db, "sync").unwrap()["lastSync"],
        "account success"
    );
    assert_eq!(
        db::get(&f.db, "syncHandledRequest").unwrap(),
        "previous account request"
    );
    assert_eq!(
        db::get(&f.db, "syncRequest").unwrap(),
        "account pending request"
    );
    assert_eq!(
        db::get(
            &f.db,
            &format!("plugin-sync:{}", f.project["id"].as_str().unwrap())
        )
        .unwrap()["online"],
        false
    );
}

#[test]
fn plugin_dispatch_validates_tool_contracts_and_reaches_bound_operations() {
    let f = Fixture::new();
    let request = input(&f);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    assert_eq!(
        runtime
            .block_on(crate::plugin_mcp::call("get_sync_status", &request))
            .unwrap()["projectId"],
        f.project["id"]
    );
    let definitions = crate::plugin_mcp::tools();
    assert_eq!(definitions.as_array().unwrap().len(), 8);
    assert_eq!(
        definitions
            .as_array()
            .unwrap()
            .iter()
            .filter(|tool| tool["annotations"]["readOnlyHint"] == false)
            .count(),
        4
    );
    for (tool, changes) in [
        ("get_sync_status", json!({"offset":-1})),
        ("get_sync_status", json!({"offset":2147483648u64})),
        ("get_sync_status", json!({"offset":"0"})),
        ("get_sync_status", json!({"unknown":true})),
        ("retry_sync", json!({"projectId":"bad"})),
        ("repair_sync", json!({"accountId":null})),
        (
            "install_skill",
            json!({"skillId":"id","origin":"shared","target":"project","snapshotHash":"hash","expectedRevision":0}),
        ),
    ] {
        let mut invalid = request.clone();
        invalid
            .as_object_mut()
            .unwrap()
            .extend(changes.as_object().unwrap().clone());
        assert!(
            runtime
                .block_on(crate::plugin_mcp::call(tool, &invalid))
                .is_err(),
            "{tool}: {invalid}"
        );
    }
    assert!(runtime
        .block_on(crate::plugin_mcp::call("get_sync_status", &json!({})))
        .is_err());
    assert!(runtime
        .block_on(crate::plugin_mcp::call("unknown", &request))
        .is_err());
}

#[test]
fn plugin_retry_and_repair_keep_legacy_governed_queue_bytes_and_ids_for_review() {
    let mut f = Fixture::new();
    f.project["governed"] = json!(true);
    f.project["sharing"] = json!(crate::projects::Sharing::default());
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    db::set(&f.db, "config", &json!({"apiUrl":"invalid-fixture-origin"})).unwrap();
    let input = json!({"accountId":db::get(&f.db,"user").unwrap(),"serviceOrigin":"invalid-fixture-origin","projectId":f.project["id"]});
    for kind in ["memory", "skill"] {
        let id = uuid::Uuid::new_v4().to_string();
        let pending=json!({"version":2,"id":id,"projectId":f.project["id"],"deviceId":uuid::Uuid::new_v4().to_string(),"baseRevision":0,"resource":{"resourceId":uuid::Uuid::new_v4().to_string(),"kind":kind,"source":"shared","logicalPath":"example","title":"Pending legacy","files":[{"path":"content.md","hash":"original pending bytes","size":22,"executable":false}],"deleted":false}}).to_string();
        f.db.execute(
            "INSERT INTO outbox VALUES(?,?,?,?,?)",
            params![
                id,
                f.project["id"].as_str(),
                "/v2/sync/push",
                pending,
                "503: previous failure"
            ],
        )
        .unwrap();
    }
    let original = db::rows(
        &f.db,
        "SELECT json_object('id',id,'raw',value) FROM outbox ORDER BY rowid",
        &[],
    )
    .unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for tool in ["retry_sync", "repair_sync"] {
        let result = runtime
            .block_on(crate::plugin_mcp::call(tool, &input))
            .unwrap();
        assert_eq!(result["status"], "needs_review");
        assert_eq!(result["after"]["blockedCount"], 2);
        assert_eq!(
            db::rows(
                &f.db,
                "SELECT json_object('id',id,'raw',value) FROM outbox ORDER BY rowid",
                &[]
            )
            .unwrap(),
            original
        );
        assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
            .unwrap()
            .is_empty());
        assert_eq!(db::get(&f.db, "syncProgress").unwrap(), Value::Null);
    }
}

#[test]
fn plugin_sync_health_uses_the_latest_scoped_attempt_after_recovery() {
    let f = Fixture::new();
    let input = input(&f);
    let key = format!("plugin-sync:{}", f.project["id"].as_str().unwrap());
    for (account, project, health, scope) in [
        (
            json!({"online":true,"updatedAt":"2026-11-13T02:00:00Z"}),
            json!({"online":false,"updatedAt":"2026-11-13T01:00:00Z"}),
            "idle",
            "account",
        ),
        (
            json!({"online":false,"updatedAt":"2026-11-13T01:00:00Z"}),
            json!({"online":true,"updatedAt":"2026-11-13T02:00:00Z"}),
            "idle",
            "project",
        ),
        (
            json!({"online":false,"updatedAt":"2026-11-13T03:00:00Z"}),
            json!({"online":true,"updatedAt":"2026-11-13T02:00:00Z"}),
            "offline",
            "account",
        ),
        (
            json!({"online":true,"updatedAt":"2026-11-13T02:00:00Z"}),
            json!({"online":false,"updatedAt":"2026-11-13T03:00:00Z"}),
            "offline",
            "project",
        ),
    ] {
        db::set(&f.db, "sync", &account).unwrap();
        db::set(&f.db, &key, &project).unwrap();
        let result = operations::status(&f.db, &f.project, &input).unwrap();
        assert_eq!(result["health"], health);
        assert_eq!(result["lastAttemptScope"], scope);
        assert_eq!(result["accountSync"], account);
        assert_eq!(result["projectSync"], project);
    }
}

#[test]
fn incoming_unbound_skill_plan_and_memory_preserve_different_local_files() {
    for (kind, governed) in [
        ("skill", false),
        ("plan", true),
        ("memory", false),
        ("memory", true),
    ] {
        let mut f = Fixture::new();
        f.project["governed"] = json!(governed);
        let id = uuid::Uuid::new_v4().to_string();
        let incoming = b"Shared accepted content\n";
        let file = json!({"path":if kind=="skill"{"SKILL.md"}else{"content.md"},"hash":db::blob(incoming).unwrap(),"size":incoming.len(),"executable":false});
        let logical = match kind {
            "plan" => "claude/files/collision.md",
            "skill" => "collision",
            _ => {
                if governed {
                    "knowledge/collision.md"
                } else {
                    "instructions/COLLISION.md"
                }
            }
        };
        let resource = json!({"resourceId":id,"projectId":f.project["id"],"kind":kind,"source":if kind=="plan"{"claude"}else{"shared"},"logicalPath":logical,"title":"Incoming collision","files":[file],"revision":1,"deleted":false});
        let path = match kind {
            "skill" => f.root.join(".agents/skills/collision/SKILL.md"),
            "plan" => f.root.join(".claude/plans/collision.md"),
            _ => {
                if governed {
                    f.root
                        .join(".orka/memory/resources")
                        .join(&id)
                        .join("content.md")
                } else {
                    f.root.join("COLLISION.md")
                }
            }
        };
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "Private local content\n").unwrap();
        db::upsert(
            &f.db,
            "resources",
            &id,
            f.project["id"].as_str().unwrap(),
            &resource,
        )
        .unwrap();
        let original = fs::read(&path).unwrap();
        let error = sync::materialize(&f.db, &f.project, &resource).unwrap_err();
        assert!(
            error.contains("Unindexed local files preserved"),
            "{kind}/{governed}: {error}"
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(f.outbox().is_empty());
        assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
            .unwrap()
            .is_empty());
        assert!(indexer::binding(&f.db, &id).unwrap()["base"].is_null());
        if kind == "skill" {
            assert!(!f.root.join(".claude/skills/collision").exists());
        }
    }
}

#[test]
fn incoming_skill_checks_unbound_mirror_before_updating_either_copy() {
    let f = Fixture::new();
    let original = b"Original accepted skill\n";
    let first = f.root.join(".agents/skills/collision");
    let second = f.root.join(".claude/skills/collision");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    fs::write(first.join("SKILL.md"), original).unwrap();
    fs::write(second.join("SKILL.md"), "Private unindexed mirror\n").unwrap();
    let files = json!(packages::directory(&first).unwrap());
    let id = uuid::Uuid::new_v4().to_string();
    let base = json!({"resourceId":id,"projectId":f.project["id"],"kind":"skill","source":"shared","logicalPath":"collision","title":"Collision","files":files,"revision":1,"deleted":false});
    let binding = json!({"paths":[first],"base":base,"writeGuard":indexer::manifest_hash(&files),"guards":[indexer::manifest_hash(&files)]});
    db::upsert(
        &f.db,
        "bindings",
        &id,
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    let incoming = b"New accepted shared skill\n";
    let mut resource = base;
    resource["revision"] = json!(2);
    resource["files"] = json!([{"path":"SKILL.md","hash":db::blob(incoming).unwrap(),"size":incoming.len(),"executable":false}]);
    assert!(sync::materialize(&f.db, &f.project, &resource)
        .unwrap_err()
        .contains("Unindexed local files preserved"));
    assert_eq!(fs::read(first.join("SKILL.md")).unwrap(), original);
    assert_eq!(
        fs::read_to_string(second.join("SKILL.md")).unwrap(),
        "Private unindexed mirror\n"
    );
    assert_eq!(indexer::binding(&f.db, &id).unwrap(), binding);
}

#[test]
fn incoming_unbound_identical_skill_is_adopted_without_a_false_collision() {
    let f = Fixture::new();
    let path = f.root.join(".agents/skills/identical");
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("SKILL.md"), "Already the accepted package\n").unwrap();
    let resource = json!({"resourceId":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],"kind":"skill","source":"shared","logicalPath":"identical","title":"Identical","files":packages::directory(&path).unwrap(),"revision":1,"deleted":false});
    sync::materialize(&f.db, &f.project, &resource).unwrap();
    assert_eq!(
        fs::read(path.join("SKILL.md")).unwrap(),
        fs::read(f.root.join(".claude/skills/identical/SKILL.md")).unwrap()
    );
    assert_eq!(
        indexer::binding(&f.db, resource["resourceId"].as_str().unwrap()).unwrap()["base"],
        resource
    );
    assert!(f.outbox().is_empty());
}

fn removed_and_active_sources(f: &mut Fixture) -> (Value, Value) {
    let healthy_root = f._home.path().join("active-source");
    fs::create_dir(&healthy_root).unwrap();
    let removed = json!({"id":uuid::Uuid::new_v4().to_string(),"name":"Removed source","path":f.root,"folderIdentity":indexer::folder_identity(&f.root).unwrap(),"removedAt":"2026-11-13T00:00:00Z"});
    let active = json!({"id":uuid::Uuid::new_v4().to_string(),"name":"Active source","path":healthy_root,"folderIdentity":indexer::folder_identity(&healthy_root).unwrap()});
    f.project["sources"] = json!([removed, active]);
    f.project["sourceModel"] = json!(1);
    f.project.as_object_mut().unwrap().remove("path");
    f.project.as_object_mut().unwrap().remove("folderIdentity");
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    (removed, active)
}

#[test]
fn removed_source_recovery_status_exposes_references_without_private_content_or_false_completion() {
    let mut f = Fixture::new();
    db::set(&f.db, "config", &json!({"apiUrl":"invalid-fixture-origin"})).unwrap();
    let (removed, _) = removed_and_active_sources(&mut f);
    let project = f.project["id"].as_str().unwrap();
    let secret = "Private preserved source content must not appear in metadata";
    let mut queued = Vec::new();
    for path in ["/v2/sync/push", selective_sharing::QUEUE_PATH] {
        let id = uuid::Uuid::new_v4().to_string();
        let change = json!({"version":2,"id":id,"projectId":project,"deviceId":uuid::Uuid::new_v4().to_string(),"baseRevision":0,"resource":{"resourceId":uuid::Uuid::new_v4().to_string(),"sourceId":removed["id"],"kind":"memory","source":"shared","logicalPath":"knowledge/preserved.md","title":secret,"files":[{"path":"content.md","hash":db::blob(secret.as_bytes()).unwrap(),"size":secret.len(),"executable":false}],"deleted":false}});
        f.db.execute(
            "INSERT INTO outbox VALUES(?,?,?,?,NULL)",
            params![id, project, path, change.to_string()],
        )
        .unwrap();
        if path == selective_sharing::QUEUE_PATH {
            db::set(&f.db,&format!("selected-share:{id}"),&json!({"requestId":id,"projectId":project,"accountId":db::get(&f.db,"user").unwrap(),"serviceOrigin":"invalid-fixture-origin","status":"queued","paths":[],"payloadHash":db::digest(change.to_string().as_bytes())})).unwrap();
        }
        queued.push(change);
    }
    crate::sources::preserve_removed_queue(&f.db, project, &removed).unwrap();
    assert!(f.outbox().is_empty());
    let request = json!({"accountId":db::get(&f.db,"user").unwrap(),"serviceOrigin":"invalid-fixture-origin","projectId":project});
    let status = operations::status(&f.db, &f.project, &request).unwrap();
    assert_eq!(status["health"], "needs_review");
    assert_eq!(status["recoveryCount"], 2);
    assert_eq!(status["sourceRemovalCount"], 2);
    assert!(!status.to_string().contains(secret));
    for change in &queued {
        let recovery = status["recoveries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["requestId"] == change["id"])
            .unwrap();
        assert_eq!(recovery["sourceId"], removed["id"]);
        assert_eq!(recovery["resourceId"], change["resource"]["resourceId"]);
        let draft = db::rows(
            &f.db,
            "SELECT value FROM drafts WHERE id=?",
            &[&recovery["draftId"].as_str().unwrap()],
        )
        .unwrap()
        .remove(0);
        assert_eq!(draft["sourceRemoval"]["queued"]["value"], *change);
    }
    let selected = status["recoveries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["selectedReason"] == "source_removed")
        .unwrap();
    assert_eq!(selected["selectedStatus"], "conflict");
    let receipt = db::get(
        &f.db,
        &format!("selected-share:{}", selected["requestId"].as_str().unwrap()),
    )
    .unwrap();
    assert_eq!(selected["draftId"], receipt["result"]["draftId"]);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for tool in ["retry_sync", "repair_sync"] {
        let result = runtime
            .block_on(crate::plugin_mcp::call(tool, &request))
            .unwrap();
        assert_eq!(result["status"], "needs_review");
        assert_eq!(result["after"]["recoveryCount"], 2);
        assert_eq!(result["after"]["queuedCount"], 0);
        assert!(!result.to_string().contains(secret));
    }
}

#[test]
fn installation_recovery_keeps_removed_journals_and_files_while_repairing_active_sources() {
    let mut f = Fixture::new();
    db::set(&f.db, "config", &json!({"apiUrl":"invalid-fixture-origin"})).unwrap();
    let (removed, active) = removed_and_active_sources(&mut f);
    let original = b"Original installed skill\n";
    let desired = b"Private interrupted installation\n";
    let original_files = json!([{"path":"SKILL.md","hash":db::blob(original).unwrap(),"size":original.len(),"executable":false}]);
    let desired_files = json!([{"path":"SKILL.md","hash":db::blob(desired).unwrap(),"size":desired.len(),"executable":false}]);
    let mut journals = Vec::new();
    for source in [&removed, &active] {
        let id = uuid::Uuid::new_v4().to_string();
        let path = PathBuf::from(source["path"].as_str().unwrap()).join(".agents/skills/recovery");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("SKILL.md"), desired).unwrap();
        let mut scope = f.project.clone();
        scope["sourceId"] = source["id"].clone();
        scope["path"] = source["path"].clone();
        scope["folderIdentity"] = source["folderIdentity"].clone();
        let journal = json!({"project":scope,"resourceId":id,"originals":[{"path":path,"files":original_files}],"desired":desired_files});
        let key = format!("installation:{id}");
        db::set(&f.db, &key, &journal).unwrap();
        journals.push((key, journal, path));
    }
    packages::recover_project_installations(&f.db, &f.project).unwrap();
    assert_eq!(db::get(&f.db, &journals[0].0).unwrap(), journals[0].1);
    assert_eq!(fs::read(journals[0].2.join("SKILL.md")).unwrap(), desired);
    assert!(db::get(&f.db, &journals[1].0).unwrap().is_null());
    assert_eq!(fs::read(journals[1].2.join("SKILL.md")).unwrap(), original);
    // Ordinary background recovery must apply the same current-source checks.
    fs::write(journals[1].2.join("SKILL.md"), desired).unwrap();
    db::set(&f.db, &journals[1].0, &journals[1].1).unwrap();
    packages::recover_installations(&f.db).unwrap();
    assert_eq!(db::get(&f.db, &journals[0].0).unwrap(), journals[0].1);
    assert_eq!(fs::read(journals[0].2.join("SKILL.md")).unwrap(), desired);
    assert!(db::get(&f.db, &journals[1].0).unwrap().is_null());
    assert_eq!(fs::read(journals[1].2.join("SKILL.md")).unwrap(), original);
    let project = f.project["id"].as_str().unwrap();
    let pending = json!({"id":"active-pending","resource":{"resourceId":uuid::Uuid::new_v4().to_string(),"sourceId":active["id"],"kind":"plan"},"private":"original queued bytes"});
    f.db.execute(
        "INSERT INTO outbox VALUES(?,?,?,?,NULL)",
        params![
            "active-pending",
            project,
            "/v2/sync/push",
            pending.to_string()
        ],
    )
    .unwrap();
    let request = json!({"accountId":db::get(&f.db,"user").unwrap(),"serviceOrigin":"invalid-fixture-origin","projectId":project});
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for tool in ["retry_sync", "repair_sync"] {
        let result = runtime
            .block_on(crate::plugin_mcp::call(tool, &request))
            .unwrap();
        assert_eq!(result["status"], "needs_review");
        assert_eq!(result["after"]["installationRecoveryCount"], 1);
        assert_eq!(
            result["after"]["projectSync"]["online"], false,
            "healthy sources reach a sync attempt instead of aborting on the removed journal"
        );
        assert_eq!(f.outbox(), vec![pending.clone()]);
        assert_eq!(db::get(&f.db, &journals[0].0).unwrap(), journals[0].1);
        assert_eq!(fs::read(journals[0].2.join("SKILL.md")).unwrap(), desired);
    }
}
