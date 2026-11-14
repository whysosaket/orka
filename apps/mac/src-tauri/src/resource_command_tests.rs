use super::*;
use crate::resource_commands as actions;

fn prepare(f: &mut Fixture) -> Value {
    f.project["role"] = json!("owner");
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
    db::set(&f.db, "config", &json!({"apiUrl":"https://items.example"})).unwrap();
    json!({"accountId":db::get(&f.db,"user").unwrap(),"serviceOrigin":"https://items.example","projectId":f.project["id"]})
}

fn published(f: &Fixture, kind: &str) -> Value {
    let id = uuid::Uuid::new_v4().to_string();
    let (source, logical, paths, files) = match kind {
        "memory" => {
            let path = f
                .root
                .join(".orka/memory/resources")
                .join(&id)
                .join("content.md");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "Accepted shared memory").unwrap();
            (
                "shared",
                format!("knowledge/{id}.md"),
                vec![path.clone()],
                json!([packages::file(&path, "content.md").unwrap()]),
            )
        }
        "skill" => {
            let paths = [".agents/skills", ".claude/skills"]
                .map(|folder| f.root.join(folder).join("example"))
                .to_vec();
            for path in &paths {
                fs::create_dir_all(path).unwrap();
                fs::write(path.join("SKILL.md"), "# Accepted skill").unwrap();
            }
            (
                "shared",
                "example".into(),
                paths.clone(),
                json!(packages::directory(&paths[0]).unwrap()),
            )
        }
        "plan" => {
            let path = f.root.join(".codex/plans/example.md");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "# Accepted plan").unwrap();
            (
                "codex",
                "codex/files/example.md".into(),
                vec![path.clone()],
                json!([crate::plans::file(&path).unwrap().0]),
            )
        }
        _ => unreachable!(),
    };
    let hash = indexer::manifest_hash(&files);
    let resource = json!({"resourceId":id,"projectId":f.project["id"],"kind":kind,"source":source,"logicalPath":logical,"title":format!("Accepted {kind}"),"files":files,"deleted":false,"revision":7,"hash":hash,"owner":db::get(&f.db,"user").unwrap(),"updatedBy":db::get(&f.db,"user").unwrap(),"updatedAt":db::now(),"access":{"mode":"publish"}});
    let binding = json!({"base":resource,"paths":paths,"guards":vec![hash.clone();paths.len()],"writeGuard":hash,"installationState":"current","reviewedRevision":7});
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
        "bindings",
        &id,
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    resource
}

#[test]
fn item_actions_bind_account_service_project_and_source_locations() {
    let mut f = Fixture::new();
    let mut input = prepare(&mut f);
    let context = actions::context(&f.db, &input).unwrap();
    assert_eq!(context["id"], f.project["id"]);
    assert_eq!(context["path"], f.project["path"]);
    let resource = published(&f, "memory");
    input["resourceId"] = resource["resourceId"].clone();
    let paths = actions::paths(&f.db, &f.project, &input).unwrap();
    assert_eq!(paths.len(), 1);
    assert!(paths[0].starts_with(f.root.join(".orka/memory/resources")));
    for (key, value) in [
        ("accountId", json!("someone-else")),
        ("serviceOrigin", json!("https://other.example")),
        ("projectId", json!(uuid::Uuid::new_v4().to_string())),
    ] {
        let mut changed = input.clone();
        changed[key] = value;
        assert!(actions::context(&f.db, &changed).is_err(), "{key}");
    }
    let other = json!({"id":uuid::Uuid::new_v4().to_string(),"path":f.root,"role":"owner"});
    assert!(actions::paths(&f.db, &other, &input).is_err());
    input.as_object_mut().unwrap().remove("resourceId");
    assert_eq!(
        actions::paths(&f.db, &f.project, &input).unwrap(),
        vec![f.root.clone()]
    );
    assert!(f.outbox().is_empty());
}

#[test]
fn item_paths_reject_missing_external_symlinked_and_changed_source_locations() {
    let mut f = Fixture::new();
    let mut input = prepare(&mut f);
    let resource = published(&f, "plan");
    input["resourceId"] = resource["resourceId"].clone();
    let id = resource["resourceId"].as_str().unwrap();
    let mut binding = indexer::binding(&f.db, id).unwrap();
    let path = PathBuf::from(binding["paths"][0].as_str().unwrap());
    let original = fs::read(&path).unwrap();
    fs::remove_file(&path).unwrap();
    assert!(actions::paths(&f.db, &f.project, &input).is_err());
    let outside = f._home.path().join("outside.md");
    fs::write(&outside, &original).unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    assert!(actions::paths(&f.db, &f.project, &input).is_err());
    fs::remove_file(&path).unwrap();
    fs::write(&path, &original).unwrap();
    binding["paths"] = json!([outside]);
    db::upsert(
        &f.db,
        "bindings",
        id,
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    assert!(actions::paths(&f.db, &f.project, &input).is_err());
    let mut changed = f.project.clone();
    changed["folderIdentity"] = json!("wrong-folder");
    assert!(actions::paths(&f.db, &changed, &input).is_err());
    assert!(outside.is_file());
}

#[test]
fn item_paths_resolve_discovered_codex_learning_and_reject_symlink_escapes() {
    let mut f = Fixture::new();
    let mut input = prepare(&mut f);
    let memories = crate::native::codex_home().unwrap().join("memories");
    let summaries = memories.join("rollout_summaries");
    fs::create_dir_all(&summaries).unwrap();
    let path = summaries.join("context-menu.md");
    let text = format!(
        "cwd: {}\n\n# Context menu learning\nKeep actions scoped.\n",
        f.root.display()
    );
    fs::write(&path, &text).unwrap();
    let catalog = crate::local_resources::catalog(&f.db, &f.project, "memory").unwrap();
    let summary = catalog["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|resource| resource["source"] == "codex")
        .unwrap();
    input["resourceId"] = summary["resourceId"].clone();
    assert_eq!(
        actions::paths(&f.db, &f.project, &input).unwrap(),
        vec![path.canonicalize().unwrap()]
    );
    let outside = f._home.path().join("outside-learning.md");
    fs::write(&outside, &text).unwrap();
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&outside, &path).unwrap();
    assert!(actions::paths(&f.db, &f.project, &input).is_err());
    fs::remove_file(&path).unwrap();
    fs::write(&path, &text).unwrap();
    let durable = memories.join("MEMORY.md");
    fs::write(&durable,"# Durable context\n\n- rollout_summaries/context-menu.md\n\nKeep object actions consistent.\n").unwrap();
    let catalog = crate::local_resources::catalog(&f.db, &f.project, "memory").unwrap();
    let entry = catalog["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|resource| {
            resource["logicalPath"]
                .as_str()
                .is_some_and(|path| path.starts_with("codex/entries/"))
        })
        .unwrap();
    input["resourceId"] = entry["resourceId"].clone();
    assert_eq!(
        actions::paths(&f.db, &f.project, &input).unwrap(),
        vec![durable.canonicalize().unwrap()]
    );
    fs::remove_file(&durable).unwrap();
    std::os::unix::fs::symlink(&outside, &durable).unwrap();
    assert!(actions::paths(&f.db, &f.project, &input).is_err());
    assert!(outside.is_file());
    assert!(f.outbox().is_empty());
}

#[test]
fn shared_deletion_freezes_exact_payload_and_preserves_local_sources_and_sharing_choices() {
    for kind in ["memory", "skill", "plan"] {
        let mut f = Fixture::new();
        let mut input = prepare(&mut f);
        let resource = published(&f, kind);
        input["resourceId"] = resource["resourceId"].clone();
        let preview = actions::preview_delete(&f.db, &f.project, &input).unwrap();
        assert_eq!(preview["kind"], kind);
        assert_eq!(preview["revision"], 7);
        assert!(!preview["paths"].as_array().unwrap().is_empty());
        input["previewToken"] = preview["previewToken"].clone();
        let frozen = actions::delete_request(&f.db, &f.project, &input).unwrap();
        let wire = &frozen["request"]["resource"];
        assert_eq!(wire["deleted"], true);
        assert_eq!(wire["files"], json!([]));
        assert_eq!(frozen["request"]["baseRevision"], 7);
        for key in [
            "revision",
            "owner",
            "updatedBy",
            "updatedAt",
            "access",
            "hash",
            "projectId",
            "localChanges",
        ] {
            assert!(wire.get(key).is_none(), "{key}");
        }
        assert_eq!(
            actions::delete_request(&f.db, &f.project, &input).unwrap()["request"],
            frozen["request"]
        );
        let mut deleted = resource.clone();
        deleted["deleted"] = json!(true);
        deleted["files"] = json!([]);
        deleted["revision"] = json!(8);
        let receipt = json!({"conflict":false,"event":{"resource":deleted,"conflicts":[]}});
        let result = actions::complete_delete(&f.db, &input, &frozen, &receipt).unwrap();
        assert_eq!(result["status"], "deleted");
        assert_eq!(result["automaticSharingChanged"], false);
        assert_eq!(
            actions::delete_request(&f.db, &f.project, &input).unwrap()["result"],
            result
        );
        assert_eq!(
            crate::governance::project(&f.db, f.project["id"].as_str().unwrap()).unwrap()
                ["sharing"],
            f.project["sharing"]
        );
        assert!(f.outbox().is_empty());
        for path in preview["paths"].as_array().unwrap() {
            assert!(
                Path::new(path.as_str().unwrap()).exists(),
                "The receipt must not bypass ordinary local-removal guards"
            );
        }
    }
}

#[test]
fn shared_deletion_rejects_changed_versions_paths_dirty_files_and_pending_changes() {
    let mut f = Fixture::new();
    let mut input = prepare(&mut f);
    let resource = published(&f, "skill");
    input["resourceId"] = resource["resourceId"].clone();
    let id = resource["resourceId"].as_str().unwrap();
    let preview = actions::preview_delete(&f.db, &f.project, &input).unwrap();
    input["previewToken"] = preview["previewToken"].clone();
    let path = PathBuf::from(preview["paths"][0].as_str().unwrap()).join("SKILL.md");
    fs::write(&path, "Private edits after preview").unwrap();
    assert!(actions::delete_request(&f.db, &f.project, &input).is_err());
    assert!(actions::preview_delete(&f.db, &f.project, &input).is_err());
    fs::write(&path, "# Accepted skill").unwrap();
    let mut current = resource.clone();
    current["revision"] = json!(8);
    db::upsert(
        &f.db,
        "resources",
        id,
        f.project["id"].as_str().unwrap(),
        &current,
    )
    .unwrap();
    assert!(actions::delete_request(&f.db, &f.project, &input).is_err());
    db::upsert(
        &f.db,
        "resources",
        id,
        f.project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    let mut binding = indexer::binding(&f.db, id).unwrap();
    binding["paths"] = json!([]);
    db::upsert(
        &f.db,
        "bindings",
        id,
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    assert!(actions::delete_request(&f.db, &f.project, &input).is_err());
    indexer::queue(
        &f.db,
        f.project["id"].as_str().unwrap(),
        "/v2/sync/push",
        &json!({"id":uuid::Uuid::new_v4().to_string(),"resource":{"kind":"skill","resourceId":id}}),
    )
    .unwrap_err();
    f.db.execute(
        "INSERT INTO outbox VALUES(?,?,?,?,NULL)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            f.project["id"].as_str(),
            "/v2/sync/push",
            json!({"resource":{"resourceId":id}}).to_string()
        ],
    )
    .unwrap();
    assert!(actions::preview_delete(&f.db, &f.project, &input).is_err());
}

#[test]
fn shared_deletion_rejects_private_instructions_legacy_memory_and_unauthorized_roles() {
    let mut f = Fixture::new();
    let mut input = prepare(&mut f);
    let original = published(&f, "memory");
    input["resourceId"] = original["resourceId"].clone();
    for field in ["local", "localChanges", "deleted"] {
        let mut resource = original.clone();
        resource[field] = json!(true);
        db::upsert(
            &f.db,
            "resources",
            resource["resourceId"].as_str().unwrap(),
            f.project["id"].as_str().unwrap(),
            &resource,
        )
        .unwrap();
        assert!(
            actions::preview_delete(&f.db, &f.project, &input).is_err(),
            "{field}"
        );
    }
    let mut resource = original.clone();
    resource["logicalPath"] = json!("instructions/AGENTS.md");
    db::upsert(
        &f.db,
        "resources",
        resource["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    assert!(actions::preview_delete(&f.db, &f.project, &input).is_err());
    db::upsert(
        &f.db,
        "resources",
        original["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &original,
    )
    .unwrap();
    let mut project = f.project.clone();
    project["governed"] = json!(false);
    assert!(actions::preview_delete(&f.db, &project, &input).is_err());
    project = f.project.clone();
    project["rolePolicies"] = json!({});
    project["role"] = json!("member");
    assert!(actions::preview_delete(&f.db, &project, &input).is_err());
    project["role"] = json!("admin");
    assert!(actions::preview_delete(&f.db, &project, &input).is_ok());
    let mut readonly = original.clone();
    readonly["access"]["mode"] = json!("read");
    db::upsert(
        &f.db,
        "resources",
        readonly["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &readonly,
    )
    .unwrap();
    assert!(actions::preview_delete(&f.db, &project, &input).is_err());
}

#[test]
fn shared_deletion_token_binds_identity_expiry_and_service_receipt() {
    let mut f = Fixture::new();
    let mut input = prepare(&mut f);
    let resource = published(&f, "plan");
    input["resourceId"] = resource["resourceId"].clone();
    let preview = actions::preview_delete(&f.db, &f.project, &input).unwrap();
    input["previewToken"] = preview["previewToken"].clone();
    for key in ["accountId", "serviceOrigin", "projectId", "resourceId"] {
        let mut altered = input.clone();
        altered[key] = json!("different");
        assert!(
            actions::delete_request(&f.db, &f.project, &altered).is_err(),
            "{key}"
        );
    }
    let mut frozen = actions::delete_request(&f.db, &f.project, &input).unwrap();
    let mut deleted = resource.clone();
    deleted["deleted"] = json!(true);
    deleted["files"] = json!([]);
    deleted["revision"] = json!(8);
    deleted["resourceId"] = json!(uuid::Uuid::new_v4().to_string());
    assert!(actions::complete_delete(
        &f.db,
        &input,
        &frozen,
        &json!({"conflict":false,"event":{"resource":deleted,"conflicts":[]}})
    )
    .is_err());
    assert_eq!(
        crate::governance::resource(&f.db, resource["resourceId"].as_str().unwrap()).unwrap(),
        resource
    );
    frozen["expires"] = json!(0);
    db::set(
        &f.db,
        &format!(
            "resource-delete:{}",
            input["previewToken"].as_str().unwrap()
        ),
        &frozen,
    )
    .unwrap();
    assert!(actions::delete_request(&f.db, &f.project, &input).is_err());
}

#[test]
fn reviewed_deletion_requires_atomic_service_support_for_memory_and_legacy_items() {
    let project = json!({"governed":true});
    let upgraded = json!({"resourceDeletion":1});
    for kind in ["memory", "skill", "plan", "session"] {
        let resource = json!({"kind":kind});
        assert_eq!(
            actions::requires_delete_capability(&project, &resource),
            kind == "memory"
        );
        assert!(actions::check_delete_capability(&project, &resource, &upgraded).is_ok());
        assert_eq!(
            actions::check_delete_capability(&project, &resource, &json!({})).is_err(),
            kind == "memory"
        );
        let legacy = json!({"governed":false});
        assert_eq!(
            actions::check_delete_capability(&legacy, &resource, &json!({})).is_err(),
            kind != "session"
        );
    }
    assert!(actions::check_delete_capability(
        &project,
        &json!({"kind":"memory"}),
        &json!({"resourceDeletion":true})
    )
    .is_err());
}

#[test]
fn shared_deletion_keeps_a_conflict_distinct_from_success_and_cleans_project_previews() {
    let mut f = Fixture::new();
    let mut input = prepare(&mut f);
    let resource = published(&f, "plan");
    input["resourceId"] = resource["resourceId"].clone();
    let preview = actions::preview_delete(&f.db, &f.project, &input).unwrap();
    input["previewToken"] = preview["previewToken"].clone();
    let frozen = actions::delete_request(&f.db, &f.project, &input).unwrap();
    let mut current = resource.clone();
    current["revision"] = json!(8);
    let mut deleted_candidate = current.clone();
    deleted_candidate["deleted"] = json!(true);
    deleted_candidate["files"] = json!([]);
    assert!(actions::complete_delete(
        &f.db,
        &input,
        &frozen,
        &json!({"conflict":true,"event":{"resource":deleted_candidate,"conflicts":[]}}),
    )
    .is_err());
    let result = actions::complete_delete(
        &f.db,
        &input,
        &frozen,
        &json!({"conflict":true,"event":{"resource":current,"conflicts":[{"id":frozen["request"]["id"],"resourceId":resource["resourceId"],"candidate":deleted_candidate}]}}),
    )
    .unwrap();
    assert_eq!(result["status"], "conflict");
    assert_eq!(
        crate::governance::resource(&f.db, resource["resourceId"].as_str().unwrap()).unwrap()
            ["deleted"],
        false
    );
    crate::projects::remove_local(&f.db, f.project["id"].as_str().unwrap()).unwrap();
    assert!(db::get(
        &f.db,
        &format!(
            "resource-delete:{}",
            input["previewToken"].as_str().unwrap()
        )
    )
    .unwrap()
    .is_null());
    assert!(Path::new(preview["paths"][0].as_str().unwrap()).is_file());
}

#[test]
fn shared_deletion_checks_native_session_activity_before_creating_a_preview() {
    let mut f = Fixture::new();
    let mut input = prepare(&mut f);
    sharing_tests::seed(&f);
    let local = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .remove(0);
    let mut resource = local["resource"].clone();
    resource["projectId"] = f.project["id"].clone();
    resource["owner"] = input["accountId"].clone();
    resource["revision"] = json!(7);
    resource["access"] = json!({"mode":"publish"});
    input["resourceId"] = resource["resourceId"].clone();
    let id = resource["resourceId"].as_str().unwrap();
    db::upsert(
        &f.db,
        "resources",
        id,
        f.project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    db::upsert(
        &f.db,
        "bindings",
        id,
        f.project["id"].as_str().unwrap(),
        &json!({"base":resource,"nativeId":local["nativeId"],"paths":local["paths"]}),
    )
    .unwrap();
    f.db.execute(
        "INSERT INTO active VALUES(?,?)",
        rusqlite::params![local["nativeId"].as_str(), json!({"pid":null}).to_string()],
    )
    .unwrap();
    assert!(actions::preview_delete(&f.db, &f.project, &input)
        .unwrap_err()
        .contains("Close the native session"));
    assert!(Path::new(local["paths"][0].as_str().unwrap()).is_file());
    assert!(f.outbox().is_empty());
}

#[tokio::test]
async fn desktop_share_previews_use_promoted_memory_identity_without_enabling_sharing() {
    let mut f = Fixture::new();
    let mut input = prepare(&mut f);
    sharing_tests::seed(&f);
    let directory = indexer::claude_memory(&f.root).unwrap();
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("MEMORY.md"), "Personal learned memory").unwrap();
    let local = indexer::discover(&f.db, &f.project, "memory")
        .unwrap()
        .into_iter()
        .find(|entry| entry["resource"]["source"] == "claude")
        .unwrap();
    let mut shared = crate::context_sharing::publication_resource(
        &f.db,
        f.project["id"].as_str().unwrap(),
        &local["resource"],
    )
    .unwrap();
    shared["projectId"] = f.project["id"].clone();
    shared["owner"] = input["accountId"].clone();
    shared["revision"] = json!(4);
    shared["access"] = json!({"mode":"publish"});
    db::upsert(
        &f.db,
        "resources",
        shared["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &shared,
    )
    .unwrap();
    input["resourceId"] = shared["resourceId"].clone();
    let preview = actions::run_command("preview-share".into(), input.clone(), None)
        .await
        .unwrap();
    assert_eq!(
        preview["snapshotHash"],
        indexer::manifest_hash(&local["resource"]["files"])
    );
    assert_eq!(preview["automaticSharingChanged"], false);
    assert!(!preview["previewToken"].as_str().unwrap().is_empty());
    assert!(f.outbox().is_empty());
    assert_eq!(
        crate::governance::project(&f.db, f.project["id"].as_str().unwrap()).unwrap()["sharing"],
        f.project["sharing"]
    );
    let mut wrong = input.clone();
    wrong["serviceOrigin"] = json!("https://wrong.example");
    assert!(actions::run_command("preview-share".into(), wrong, None)
        .await
        .is_err());
}

#[tokio::test]
async fn item_actions_resolve_project_local_skills_in_multi_repository_projects() {
    let mut f = Fixture::new();
    let mut input = prepare(&mut f);
    let source_id = uuid::Uuid::new_v4().to_string();
    f.project["sources"] = json!([
        {"id":source_id,"name":"Connected repository","path":f.root},
        {"id":uuid::Uuid::new_v4().to_string(),"name":"Other repository","path":null}
    ]);
    f.project.as_object_mut().unwrap().remove("path");
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    let source = crate::sources::views(&f.project).remove(0);
    let global = crate::native::codex_home()
        .unwrap()
        .join("skills/context-menu-example");
    fs::create_dir_all(&global).unwrap();
    fs::write(global.join("SKILL.md"), "# Context menu example").unwrap();
    let scan = crate::global_skills::scan(&f.db, &source).unwrap();
    let installed = crate::global_skills::add(&f.db, &source, &scan.skills[0].id).unwrap();
    input["resourceId"] = installed["resourceId"].clone();
    let resource = crate::global_skills::local_skill(&f.db, input["resourceId"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(resource["sourceId"], source_id);
    assert_eq!(resource["local"], true);
    let paths = actions::paths(&f.db, &f.project, &input).unwrap();
    assert_eq!(paths.len(), 2);
    assert!(paths.iter().all(|path| path.starts_with(&f.root)));
    assert!(!paths.contains(&global));
    let preview = actions::run_command("preview-share".into(), input, None)
        .await
        .unwrap();
    assert_eq!(preview["kind"], "skill");
    assert_eq!(preview["sourceId"], source_id);
    assert_eq!(preview["files"].as_array().unwrap().len(), 1);
    assert!(f.outbox().is_empty());
}

#[tokio::test]
async fn snapshot_progress_is_scoped_and_freezes_the_single_discovery() {
    use std::sync::{Arc, Mutex};
    let mut f = Fixture::new();
    let mut input = prepare(&mut f);
    sharing_tests::seed(&f);
    let local = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .remove(0);
    input["resourceId"] = local["resource"]["resourceId"].clone();
    let source = PathBuf::from(local["paths"][0].as_str().unwrap());
    let original = fs::read(&source).unwrap();
    let original_snapshot =
        db::blob_read(local["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap();
    let mut later = original.clone();
    later.extend_from_slice(b"{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"text\":\"Future private turn\"}]}}\n");
    let existing_sync = json!({"label":"Background sync","completed":2,"total":5});
    db::set(&f.db, "syncProgress", &existing_sync).unwrap();
    let messages = Arc::new(Mutex::new(Vec::<Value>::new()));
    let observed = messages.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        let value = body.deserialize::<Value>().unwrap();
        if value["label"] == "Preparing snapshot for review" {
            fs::write(&source, &later).unwrap();
        }
        observed.lock().unwrap().push(value);
        Ok(())
    });
    let preview = actions::run_command("preview-share".into(), input.clone(), Some(channel))
        .await
        .unwrap();
    assert_eq!(preview["files"], local["resource"]["files"]);
    assert_eq!(
        preview["snapshotHash"],
        indexer::manifest_hash(&local["resource"]["files"])
    );
    let events = messages.lock().unwrap().clone();
    assert_eq!(
        events.first().unwrap()["label"],
        "Preparing snapshot review"
    );
    assert!(events
        .iter()
        .any(|event| event["label"] == "Reading local history"));
    let files: Vec<_> = events
        .iter()
        .filter(|event| event["detail"].is_string())
        .collect();
    assert_eq!(
        files.len(),
        1,
        "One catalog discovery pass reports this session once"
    );
    assert!(!files[0]["detail"].as_str().unwrap().contains('/'));
    assert!(events[..events.len() - 1]
        .iter()
        .all(|event| event["total"].is_null() && event["completed"].is_null()));
    assert_eq!(
        events.last().unwrap(),
        &json!({"label":"Snapshot ready for review","completed":1,"total":1})
    );
    assert_eq!(db::get(&f.db, "syncProgress").unwrap(), existing_sync);
    assert!(f.outbox().is_empty());
    let saved = db::get(
        &f.db,
        &format!(
            "share-preview:{}",
            preview["previewToken"].as_str().unwrap()
        ),
    )
    .unwrap();
    assert_eq!(saved["desktopResourceId"], input["resourceId"]);
    assert_eq!(saved["change"]["resource"]["files"], preview["files"]);
    assert_eq!(
        db::blob_read(preview["files"][0]["hash"].as_str().unwrap()).unwrap(),
        original_snapshot
    );

    let disconnected =
        tauri::ipc::Channel::new(|_| Err(tauri::Error::AssetNotFound("Closed review".into())));
    let next = actions::run_command("preview-share".into(), input, Some(disconnected))
        .await
        .unwrap();
    assert_ne!(next["snapshotHash"], preview["snapshotHash"]);
    assert_eq!(*messages.lock().unwrap(), events);
    assert_eq!(db::get(&f.db, "syncProgress").unwrap(), existing_sync);
    assert!(f.outbox().is_empty());
}

#[tokio::test]
async fn snapshot_progress_starts_before_the_project_lock_is_checked() {
    let mut f = Fixture::new();
    let mut input = prepare(&mut f);
    sharing_tests::seed(&f);
    let local = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .remove(0);
    input["resourceId"] = local["resource"]["resourceId"].clone();
    let lock = crate::projects::lock().unwrap();
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let channel = tauri::ipc::Channel::new(move |body| {
        let _ = send.send(body.deserialize::<Value>().unwrap());
        Ok(())
    });
    let command = tokio::spawn(actions::run_command(
        "preview-share".into(),
        input,
        Some(channel),
    ));
    let first = tokio::time::timeout(std::time::Duration::from_secs(2), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first["label"], "Preparing snapshot review");
    assert!(command.await.unwrap().unwrap_err().contains("in progress"));
    drop(lock);
    assert!(f.outbox().is_empty());
}

fn enable_automatic(f: &mut Fixture, kind: &str) {
    f.project["sharing"][kind] = json!(true);
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    db::set(
        &f.db,
        &format!("governance:{}", f.project["id"].as_str().unwrap()),
        &json!({"owner":true}),
    )
    .unwrap();
}

fn acknowledge_deletion(f: &Fixture, mut input: Value, resource: &Value) -> Value {
    input["resourceId"] = resource["resourceId"].clone();
    let preview = actions::preview_delete(&f.db, &f.project, &input).unwrap();
    input["previewToken"] = preview["previewToken"].clone();
    let frozen = actions::delete_request(&f.db, &f.project, &input).unwrap();
    let mut deleted = resource.clone();
    deleted["revision"] = json!(resource["revision"].as_u64().unwrap() + 1);
    deleted["deleted"] = json!(true);
    deleted["files"] = json!([]);
    deleted["updatedAt"] = json!(db::now());
    assert_eq!(
        actions::complete_delete(
            &f.db,
            &input,
            &frozen,
            &json!({"conflict":false,"event":{"resource":deleted,"conflicts":[]}})
        )
        .unwrap()["status"],
        "deleted"
    );
    deleted
}

fn deferred_preflight(f: &Fixture) {
    let mut preflight = f.project.clone();
    preflight["deferAutomaticSharing"] = json!(true);
    indexer::scan(&f.db, &preflight).unwrap();
    crate::context_sharing::queue_waiting(&f.db, &f.project).unwrap();
}

fn draft_history(f: &Fixture) -> Vec<Value> {
    db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .into_iter()
        .map(|mut draft| {
            draft.as_object_mut().unwrap().remove("updatedAt");
            draft
        })
        .collect()
}

#[test]
fn acknowledged_skill_deletion_survives_preflight_without_inventing_local_changes() {
    let mut f = Fixture::new();
    let input = prepare(&mut f);
    enable_automatic(&mut f, "skill");
    let resource = published(&f, "skill");
    let id = resource["resourceId"].as_str().unwrap();
    assert_eq!(
        indexer::scoped_resource_id(&f.db, &f.project, "skill", "example").unwrap(),
        id
    );
    let mut binding = indexer::binding(&f.db, id).unwrap();
    binding["lastSeenHash"] = json!(indexer::manifest_hash(&resource["files"]));
    db::upsert(
        &f.db,
        "bindings",
        id,
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .is_empty());
    deferred_preflight(&f);
    assert!(f.outbox().is_empty(), "pre-delete outbox");
    assert!(
        db::rows(&f.db, "SELECT value FROM drafts", &[])
            .unwrap()
            .is_empty(),
        "pre-delete drafts"
    );
    let deleted = acknowledge_deletion(&f, input, &resource);
    deferred_preflight(&f);
    let materialized = sync::materialize(&f.db, &f.project, &deleted);
    let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
    assert!(materialized.is_ok());
    assert!(!f.root.join(".agents/skills/example").exists());
    assert!(!f.root.join(".claude/skills/example").exists());
    assert!(
        drafts.is_empty(),
        "Unchanged installed bytes are not new private edits: {drafts:?}"
    );
    assert!(f.outbox().is_empty());

    // Recreating the same bytes after deletion has finished is a real restoration.
    let restored = f.root.join(".agents/skills/example");
    fs::create_dir_all(&restored).unwrap();
    fs::write(restored.join("SKILL.md"), "# Accepted skill").unwrap();
    deferred_preflight(&f);
    let restored_drafts = draft_history(&f);
    assert_eq!(restored_drafts.len(), 1);
    assert_eq!(
        restored_drafts[0]["resource"]["resourceId"],
        resource["resourceId"]
    );
    assert_eq!(restored_drafts[0]["baseRevision"], deleted["revision"]);
    assert_ne!(restored_drafts[0]["conflictReview"], true);
    assert_eq!(f.outbox().len(), 1);
}

#[test]
fn acknowledged_skill_deletion_keeps_real_edits_for_review() {
    let mut f = Fixture::new();
    let input = prepare(&mut f);
    enable_automatic(&mut f, "skill");
    let resource = published(&f, "skill");
    deferred_preflight(&f);
    assert!(draft_history(&f).is_empty());
    assert!(f.outbox().is_empty());
    let deleted = acknowledge_deletion(&f, input, &resource);
    let native = f.root.join(".agents/skills/example/SKILL.md");
    fs::write(&native, "# Private edit after deletion receipt\n").unwrap();
    deferred_preflight(&f);
    let drafts = draft_history(&f);
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0]["resource"]["resourceId"], resource["resourceId"]);
    assert_eq!(drafts[0]["status"], "local");
    assert_eq!(drafts[0]["conflictReview"], true);
    assert_eq!(drafts[0]["automaticSharing"], false);
    assert_ne!(drafts[0]["resource"]["files"], resource["files"]);
    assert!(f.outbox().is_empty());
    assert!(sync::materialize(&f.db, &f.project, &deleted).is_err());
    assert_eq!(
        fs::read_to_string(&native).unwrap(),
        "# Private edit after deletion receipt\n"
    );
    assert!(f.root.join(".claude/skills/example/SKILL.md").is_file());
}

#[test]
fn acknowledged_memory_deletion_does_not_republish_its_unchanged_personal_origin() {
    let mut f = Fixture::new();
    let input = prepare(&mut f);
    let native = indexer::claude_memory(&f.root).unwrap().join("MEMORY.md");
    fs::create_dir_all(native.parent().unwrap()).unwrap();
    fs::write(&native, "Personal learned memory remains local\n").unwrap();
    enable_automatic(&mut f, "memory");
    indexer::scan(&f.db, &f.project).unwrap();
    let queued = db::rows(
        &f.db,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox",
        &[],
    )
    .unwrap()
    .remove(0);
    let mut resource = queued["value"]["resource"].clone();
    resource["projectId"] = f.project["id"].clone();
    resource["owner"] = input["accountId"].clone();
    resource["revision"] = json!(7);
    resource["updatedAt"] = json!(db::now());
    resource["access"] = json!({"mode":"publish"});
    resource["updatedBy"] = input["accountId"].clone();
    crate::context_sharing::complete(
        &f.db,
        &queued,
        &json!({"event":{"resource":resource,"conflicts":[]}}),
    )
    .unwrap();
    f.db.execute("DELETE FROM outbox WHERE id=?", [queued["id"].as_str()])
        .unwrap();
    sync::materialize(&f.db, &f.project, &resource).unwrap();
    let accepted_drafts = draft_history(&f);
    assert_eq!(accepted_drafts.len(), 1);
    assert_eq!(accepted_drafts[0]["status"], "published");
    deferred_preflight(&f);
    assert!(f.outbox().is_empty(), "pre-delete outbox");
    assert_eq!(
        draft_history(&f),
        accepted_drafts,
        "pre-delete draft history"
    );
    let deleted = acknowledge_deletion(&f, input, &resource);
    deferred_preflight(&f);
    let materialized = sync::materialize(&f.db, &f.project, &deleted);
    let drafts = draft_history(&f);
    assert_eq!(
        fs::read_to_string(&native).unwrap(),
        "Personal learned memory remains local\n"
    );
    assert!(
        f.outbox().is_empty(),
        "An unchanged preserved native source must not queue a replacement: {:?}",
        f.outbox()
    );
    assert!(materialized.is_ok());
    assert!(!f
        .root
        .join(".orka/memory/resources")
        .join(resource["resourceId"].as_str().unwrap())
        .join("content.md")
        .exists());
    assert!(
        drafts == accepted_drafts,
        "The retained source is not a new local edit: {drafts:?}"
    );
}
