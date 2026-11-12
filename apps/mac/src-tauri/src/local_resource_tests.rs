use super::*;
use crate::{commands, local_resources};

fn prepare(f: &mut Fixture) {
    f.project["sharing"] =
        json!({"memory":false,"skill":false,"plan":false,"session":false,"env":false});
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    sharing_tests::seed(f);
    for entry in fs::read_dir(native::codex_home().unwrap().join("sessions")).unwrap() {
        let path = entry.unwrap().path();
        let mut records = native::complete_records(&fs::read(&path).unwrap()).unwrap();
        for record in &mut records {
            if let Some(content) = record["payload"]["content"].as_array_mut() {
                for part in content {
                    part["type"] = json!("text");
                }
            }
        }
        fs::write(path, native::encode(&records)).unwrap();
    }
}

#[test]
fn local_library_lists_and_reads_private_categories_without_publishing() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let sharing = f.project["sharing"].clone();
    for kind in ["memory", "plan", "session"] {
        let catalog = local_resources::catalog(&f.db, &f.project, kind).unwrap();
        assert_eq!(catalog["errors"], json!([]));
        let resources = catalog["resources"].as_array().unwrap();
        assert!(!resources.is_empty(), "{kind}");
        for resource in resources {
            assert_eq!(resource["local"], true);
            assert_eq!(resource["revision"], 0);
            assert_eq!(resource["owner"], db::get(&f.db, "user").unwrap());
            assert!(resource.get("paths").is_none());
            let read = commands::inspect_resource(
                resource["resourceId"].as_str().unwrap().into(),
                resource["files"][0]["path"].as_str().unwrap().into(),
                None,
            )
            .unwrap();
            assert!(read["content"]
                .as_str()
                .is_some_and(|content| !content.is_empty()));
        }
        let next = local_resources::catalog(&f.db, &f.project, kind).unwrap();
        assert_eq!(
            catalog["resources"], next["resources"],
            "unchanged discovery must not change timestamps"
        );
    }
    assert!(f.resources().is_empty());
    assert!(f.outbox().is_empty());
    for table in ["bindings", "drafts"] {
        assert!(db::rows(&f.db, &format!("SELECT value FROM {table}"), &[])
            .unwrap()
            .is_empty());
    }
    let project = crate::governance::project(&f.db, f.project["id"].as_str().unwrap()).unwrap();
    assert_eq!(project["sharing"], sharing);
    assert!(!f.root.join(".orka/plans").exists());
}

#[tokio::test]
async fn local_library_private_sessions_page_export_and_resume_without_shared_bindings() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let catalog = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    let resource = &catalog["resources"][0];
    let id = resource["resourceId"].as_str().unwrap();
    let page = commands::session_messages(id.into(), None, Some(0), Some(1))
        .await
        .unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 1);
    assert!(page["total"].as_u64().unwrap() >= 2);
    assert!(commands::session_display_title(id.into())
        .await
        .unwrap()
        .is_some());
    let reading = local_resources::resource(&f.db, id).unwrap();
    let binding = crate::session_forks::binding(&f.db, &reading).unwrap();
    assert!(binding["nativeId"].is_string());
    assert_eq!(
        crate::session_forks::resumable(&f.db, &reading)
            .unwrap()
            .unwrap()["resourceId"],
        id
    );
    let path = f._home.path().join("private-session.zip");
    bundles::export(&f.db, id, &path).unwrap();
    assert!(path.is_file());
    assert!(commands::session_action(id.into(), "delete".into(), None, None).is_err());
    assert!(f.outbox().is_empty());
    assert!(f.resources().is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM bindings", &[])
        .unwrap()
        .is_empty());
}

#[test]
fn local_library_keeps_last_complete_scan_on_source_failure() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let before = local_resources::catalog(&f.db, &f.project, "memory").unwrap();
    let moved = f._home.path().join("unmounted");
    fs::rename(&f.root, &moved).unwrap();
    let failed = local_resources::catalog(&f.db, &f.project, "memory").unwrap();
    assert_eq!(failed["resources"], before["resources"]);
    assert!(!failed["errors"].as_array().unwrap().is_empty());
    fs::rename(&moved, &f.root).unwrap();
    fs::remove_file(f.root.join("AGENTS.md")).unwrap();
    let removed = local_resources::catalog(&f.db, &f.project, "memory").unwrap();
    assert_eq!(removed["errors"], json!([]));
    assert!(removed["resources"].as_array().unwrap().is_empty());
    assert!(f.outbox().is_empty());
}

#[test]
fn local_library_missing_history_provider_preserves_sessions_and_embedded_plans() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let sessions = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    let plans = local_resources::catalog(&f.db, &f.project, "plan").unwrap();
    assert_eq!(
        sessions["errors"],
        json!([]),
        "a provider that was never installed is not an error"
    );
    let directory = native::codex_home().unwrap().join("sessions");
    let moved = f._home.path().join("unavailable-history");
    fs::rename(&directory, &moved).unwrap();
    for (kind, before) in [("session", sessions), ("plan", plans)] {
        let after = local_resources::catalog(&f.db, &f.project, kind).unwrap();
        assert_eq!(after["resources"], before["resources"]);
        assert!(!after["errors"].as_array().unwrap().is_empty());
    }
    assert!(f.outbox().is_empty());
}

#[test]
fn local_library_first_discovery_keeps_healthy_sessions_beside_corrupt_unrelated_history() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let path = native::codex_home()
        .unwrap()
        .join("sessions/unrelated-corrupt.jsonl");
    fs::write(path, b"not valid native JSON\n").unwrap();
    let catalog = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert_eq!(catalog["resources"].as_array().unwrap().len(), 1);
    assert!(!catalog["errors"].as_array().unwrap().is_empty());
    assert!(f.outbox().is_empty());
}

#[test]
fn local_library_unattributed_oversized_history_preserves_last_known_sessions() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let before = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    let directory = native::codex_home().unwrap().join("sessions");
    for entry in fs::read_dir(&directory).unwrap() {
        fs::remove_file(entry.unwrap().path()).unwrap();
    }
    let oversized = fs::File::create(directory.join("unattributed.jsonl")).unwrap();
    oversized.set_len(crate::history::MAX_FILE + 1).unwrap();
    let after = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert_eq!(after["resources"], before["resources"]);
    assert!(!after["errors"].as_array().unwrap().is_empty());
    assert!(f.outbox().is_empty());
}

#[test]
fn local_library_removed_unattributed_error_recovers_without_sync_and_does_not_affect_memories() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let memories = local_resources::catalog(&f.db, &f.project, "memory").unwrap();
    assert_eq!(memories["resources"].as_array().unwrap().len(), 1);
    let oversized_path = native::codex_home()
        .unwrap()
        .join("sessions/unattributed.jsonl");
    fs::File::create(&oversized_path)
        .unwrap()
        .set_len(crate::history::MAX_FILE + 1)
        .unwrap();
    let sessions = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert!(!sessions["errors"].as_array().unwrap().is_empty());
    fs::remove_file(f.root.join("AGENTS.md")).unwrap();
    let memories = local_resources::catalog(&f.db, &f.project, "memory").unwrap();
    assert_eq!(
        memories["errors"],
        json!([]),
        "memory discovery must ignore unrelated history errors"
    );
    assert!(memories["resources"].as_array().unwrap().is_empty());
    fs::remove_file(oversized_path).unwrap();
    let recovered = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert_eq!(
        recovered["errors"],
        json!([]),
        "local refresh alone must clear errors for deleted oversized histories"
    );
    assert_eq!(recovered["resources"].as_array().unwrap().len(), 1);
    assert!(f.outbox().is_empty());
}

#[test]
fn local_library_preserves_published_owner_and_private_session_updates() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let first = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    let mut published = first["resources"][0].clone();
    published.as_object_mut().unwrap().remove("local");
    published["revision"] = json!(7);
    let id = published["resourceId"].as_str().unwrap().to_owned();
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &published,
    )
    .unwrap();
    let native = local_resources::resource(&f.db, &id).unwrap();
    // A published snapshot remains frozen as this Mac's native conversation grows.
    let entry = db::rows(
        &f.db,
        "SELECT value FROM local_resources WHERE id=?",
        &[&id],
    )
    .unwrap()
    .remove(0);
    let path = Path::new(entry["paths"][0].as_str().unwrap());
    let mut bytes = fs::read(path).unwrap();
    bytes.extend(native::encode(&[json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"Later private turn"}]}})]));
    fs::write(path, bytes).unwrap();
    let grown = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert_eq!(grown["resources"].as_array().unwrap().len(), 1);
    assert_eq!(grown["resources"][0]["revision"], 7);
    assert_eq!(grown["resources"][0]["localChanges"], true);
    assert_ne!(grown["resources"][0]["files"], native["files"]);
    assert_eq!(
        crate::governance::resource(&f.db, &id).unwrap()["files"],
        published["files"]
    );
    published["owner"] = json!(uuid::Uuid::new_v4().to_string());
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &published,
    )
    .unwrap();
    let teammate = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert_eq!(teammate["resources"][0], published);
    assert_eq!(local_resources::resource(&f.db, &id).unwrap(), published);
    f.db.execute("DELETE FROM resources WHERE id=?", [&id])
        .unwrap();
    f.db.execute("DELETE FROM bindings WHERE id=?", [&id])
        .unwrap();
    fs::write(path,[fs::read(path).unwrap(),native::encode(&[json!({"type":"event_msg","payload":{"type":"user_message","message":"Still a teammate source"}})])].concat()).unwrap();
    let revoked = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert!(
        revoked["resources"].as_array().unwrap().is_empty(),
        "revoked imported content must not become Mine"
    );
    assert!(local_resources::resource(&f.db, &id).is_err());
    assert!(f.outbox().is_empty());
}

#[test]
fn local_library_source_failures_do_not_block_other_repositories() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let other = f._home.path().join("second-repository");
    fs::create_dir(&other).unwrap();
    fs::write(other.join("AGENTS.md"), "Second repository instructions").unwrap();
    f.project["sources"] = json!([
        {"id":uuid::Uuid::new_v4().to_string(),"name":"First","path":f.root},
        {"id":uuid::Uuid::new_v4().to_string(),"name":"Second","path":other}
    ]);
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    let before = local_resources::catalog(&f.db, &f.project, "memory").unwrap();
    assert_eq!(before["resources"].as_array().unwrap().len(), 2);
    fs::remove_dir_all(&other).unwrap();
    fs::write(f.root.join("AGENTS.md"), "Updated first repository").unwrap();
    let after = local_resources::catalog(&f.db, &f.project, "memory").unwrap();
    assert_eq!(after["resources"].as_array().unwrap().len(), 2);
    assert_eq!(after["errors"].as_array().unwrap().len(), 1);
    let first = after["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["sourceId"] == f.project["sources"][0]["id"])
        .unwrap();
    assert_eq!(
        db::blob_read(first["files"][0]["hash"].as_str().unwrap()).unwrap(),
        b"Updated first repository"
    );
    assert!(f.outbox().is_empty());
}

#[test]
fn local_library_keeps_imported_session_provenance_after_binding_removal() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let catalog = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    let original_id = catalog["resources"][0]["resourceId"].as_str().unwrap();
    let entry = db::rows(
        &f.db,
        "SELECT value FROM local_resources WHERE id=?",
        &[&original_id],
    )
    .unwrap()
    .remove(0);
    let mut imported = catalog["resources"][0].clone();
    let imported_id = uuid::Uuid::new_v4().to_string();
    imported["resourceId"] = json!(imported_id);
    imported["owner"] = json!(uuid::Uuid::new_v4().to_string());
    imported["revision"] = json!(3);
    imported.as_object_mut().unwrap().remove("local");
    db::upsert(
        &f.db,
        "resources",
        &imported_id,
        f.project["id"].as_str().unwrap(),
        &imported,
    )
    .unwrap();
    db::upsert(
        &f.db,
        "bindings",
        &imported_id,
        f.project["id"].as_str().unwrap(),
        &json!({"base":imported,"paths":entry["paths"],"nativeId":entry["nativeId"]}),
    )
    .unwrap();
    let found = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert_eq!(found["resources"][0]["resourceId"], imported_id);
    f.db.execute("DELETE FROM resources", []).unwrap();
    f.db.execute("DELETE FROM bindings", []).unwrap();
    // The one-off sharing plugin also refreshes this same private cache.
    let selected = indexer::discover(&f.db, &f.project, "session").unwrap();
    assert_eq!(selected[0]["resource"]["resourceId"], imported_id);
    let found = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert!(found["resources"].as_array().unwrap().is_empty());
    assert!(local_resources::resource(&f.db, &imported_id).is_err());
    assert!(f.outbox().is_empty());
}

#[test]
fn local_library_first_discovery_after_governed_revocation_keeps_native_session_foreign() {
    let mut f = Fixture::new();
    prepare(&mut f);
    f.project["governed"] = json!(true);
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    let path = fs::read_dir(native::codex_home().unwrap().join("sessions"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let bytes = fs::read(&path).unwrap();
    let records = native::complete_records(&bytes).unwrap();
    let (native_id, _, _) = native::session_info("codex", &records).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let resource = json!({"resourceId":id,"projectId":f.project["id"],"owner":uuid::Uuid::new_v4().to_string(),"updatedBy":"teammate","updatedAt":db::now(),"revision":5,"kind":"session","source":"codex","logicalPath":format!("codex/{native_id}"),"title":"Teammate session","files":crate::history::session_files("codex",&path,Some(&f.root)).unwrap(),"deleted":false,"access":{"mode":"read"}});
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
        &json!({"base":resource,"nativeId":native_id,"paths":[path]}),
    )
    .unwrap();
    assert!(db::rows(&f.db, "SELECT value FROM local_resources", &[])
        .unwrap()
        .is_empty());

    crate::governance::reset(&f.db, f.project["id"].as_str().unwrap(), &json!([])).unwrap();
    assert!(f.resources().is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM bindings", &[])
        .unwrap()
        .is_empty());
    assert_eq!(
        fs::read(&path).unwrap(),
        bytes,
        "native history outside the project remains intact"
    );

    let catalog = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert_eq!(catalog["errors"], json!([]));
    assert!(
        catalog["resources"].as_array().unwrap().is_empty(),
        "first-ever discovery must not relabel a revoked teammate session as Mine"
    );
    assert!(local_resources::resource(&f.db, &id).is_err());
    assert!(f.outbox().is_empty());
}

#[test]
fn local_library_archived_revoked_session_keeps_origin_after_cache_pruning_and_plugin_refresh() {
    let mut f = Fixture::new();
    prepare(&mut f);
    f.project["governed"] = json!(true);
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    let path = fs::read_dir(native::codex_home().unwrap().join("sessions"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let records = native::complete_records(&fs::read(&path).unwrap()).unwrap();
    let (native_id, _, _) = native::session_info("codex", &records).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let resource = json!({"resourceId":id,"projectId":f.project["id"],"owner":uuid::Uuid::new_v4().to_string(),"updatedBy":"teammate","updatedAt":db::now(),"revision":5,"kind":"session","source":"codex","logicalPath":format!("codex/{native_id}"),"title":"Teammate session","files":crate::history::session_files("codex",&path,Some(&f.root)).unwrap(),"deleted":false,"access":{"mode":"read"}});
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
        &json!({"base":resource,"nativeId":native_id,"paths":[path]}),
    )
    .unwrap();
    crate::governance::reset(&f.db, f.project["id"].as_str().unwrap(), &json!([])).unwrap();
    let archived = native::codex_home().unwrap().join("archived_sessions");
    fs::create_dir(&archived).unwrap();
    let archived_path = archived.join(path.file_name().unwrap());
    fs::rename(&path, &archived_path).unwrap();
    let absent = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert!(absent["resources"].as_array().unwrap().is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM local_resources", &[])
        .unwrap()
        .is_empty());
    assert!(indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .is_empty());
    fs::rename(&archived_path, &path).unwrap();
    let restored = indexer::discover(&f.db, &f.project, "session").unwrap();
    assert_eq!(
        restored[0]["resource"]["resourceId"], id,
        "native identity must survive pruning of every listing entry"
    );
    let restored = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert!(
        restored["resources"].as_array().unwrap().is_empty(),
        "unarchiving cannot turn a revoked teammate session into Mine"
    );
    assert!(f.outbox().is_empty());
}

#[test]
fn local_library_reads_saved_memory_candidates_and_selected_memory_aliases() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let memory = crate::indexer::claude_memory(&f.root).unwrap();
    fs::create_dir_all(&memory).unwrap();
    fs::write(memory.join("MEMORY.md"), "Personal learning").unwrap();
    let catalog = local_resources::catalog(&f.db, &f.project, "memory").unwrap();
    let local = catalog["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["source"] == "claude")
        .unwrap();
    let alias = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!(
            "selected-memory:{}:{}",
            f.project["id"], local["resourceId"]
        )
        .as_bytes(),
    )
    .to_string();
    let mut shared = local.clone();
    shared["resourceId"] = json!(alias);
    shared["source"] = json!("shared");
    shared["logicalPath"] = json!(format!("knowledge/{alias}.md"));
    shared["revision"] = json!(4);
    shared.as_object_mut().unwrap().remove("local");
    db::upsert(
        &f.db,
        "resources",
        &alias,
        f.project["id"].as_str().unwrap(),
        &shared,
    )
    .unwrap();
    let after = local_resources::catalog(&f.db, &f.project, "memory").unwrap();
    assert!(after["resources"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["resourceId"] != local["resourceId"]));
    assert_eq!(
        local_resources::resource(&f.db, &alias).unwrap()["files"],
        shared["files"]
    );
    let candidate_id = uuid::Uuid::new_v4().to_string();
    let bytes = b"Saved private candidate";
    let candidate = json!({"resourceId":candidate_id,"kind":"memory","source":"shared","logicalPath":format!("knowledge/{candidate_id}.md"),"title":"Private candidate","files":[{"path":"content.md","hash":db::blob(bytes).unwrap(),"size":bytes.len(),"executable":false}],"deleted":false});
    let draft = json!({"id":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],"resource":candidate,"paths":[],"status":"local","createdAt":db::now()});
    db::upsert(
        &f.db,
        "drafts",
        draft["id"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &draft,
    )
    .unwrap();
    let after = local_resources::catalog(&f.db, &f.project, "memory").unwrap();
    assert!(after["resources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["resourceId"] == candidate_id));
    assert_eq!(
        commands::inspect_resource(candidate_id, "content.md".into(), None).unwrap()["content"],
        "Saved private candidate"
    );
}

#[tokio::test]
async fn local_library_rejects_stale_account_and_service_before_discovery() {
    let mut f = Fixture::new();
    prepare(&mut f);
    db::set(
        &f.db,
        "config",
        &json!({"apiUrl":"https://library.example"}),
    )
    .unwrap();
    for (account, origin) in [
        (uuid::Uuid::new_v4().to_string(), "https://library.example"),
        (
            db::get(&f.db, "user").unwrap().as_str().unwrap().to_owned(),
            "https://other.example",
        ),
    ] {
        assert!(local_resources::local_resource_catalog(
            f.project["id"].as_str().unwrap().into(),
            "session".into(),
            account,
            origin.into()
        )
        .await
        .is_err());
    }
    assert!(db::rows(&f.db, "SELECT value FROM local_resources", &[])
        .unwrap()
        .is_empty());
    assert!(f.outbox().is_empty());
}

#[test]
fn plugin_discovery_preserves_incomplete_library_cache_without_previewing_stale_resources() {
    for failure in ["missing-provider", "corrupt-history"] {
        let mut f = Fixture::new();
        prepare(&mut f);
        let sessions = local_resources::catalog(&f.db, &f.project, "session").unwrap();
        let plans = local_resources::catalog(&f.db, &f.project, "plan").unwrap();
        let session_id = sessions["resources"][0]["resourceId"].as_str().unwrap();
        let plan_id = plans["resources"]
            .as_array()
            .unwrap()
            .iter()
            .find(|resource| {
                resource["logicalPath"]
                    .as_str()
                    .is_some_and(|path| path.contains("/sessions/"))
            })
            .unwrap()["resourceId"]
            .as_str()
            .unwrap();
        let directory = native::codex_home().unwrap().join("sessions");
        if failure == "missing-provider" {
            fs::rename(&directory, f._home.path().join("missing-history")).unwrap();
        } else {
            let path = fs::read_dir(&directory)
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            fs::write(path, "Incomplete native history\n").unwrap();
        }
        assert!(
            indexer::discover(&f.db, &f.project, "session")
                .unwrap()
                .is_empty(),
            "{failure}"
        );
        let fresh_plans = indexer::discover(&f.db, &f.project, "plan").unwrap();
        assert_eq!(
            fresh_plans.len(),
            1,
            "the current file plan remains discoverable"
        );
        assert_eq!(
            fresh_plans[0]["resource"]["logicalPath"],
            "codex/files/feature.md"
        );
        for (kind, id) in [("session", session_id), ("plan", plan_id)] {
            assert!(
                crate::selective_sharing::preview(
                    &f.db,
                    &f.project,
                    &json!({"kind":kind,"resourceId":id})
                )
                .is_err(),
                "{failure}: {kind}"
            );
            assert!(
                !db::rows(
                    &f.db,
                    "SELECT value FROM local_resources WHERE id=?",
                    &[&id]
                )
                .unwrap()
                .is_empty(),
                "private reading cache must survive plugin discovery"
            );
        }
        for (kind, before) in [("session", &sessions), ("plan", &plans)] {
            let after = local_resources::catalog(&f.db, &f.project, kind).unwrap();
            assert_eq!(after["resources"], before["resources"], "{failure}: {kind}");
            assert!(!after["errors"].as_array().unwrap().is_empty());
        }
        assert!(f.outbox().is_empty());
        assert!(f.resources().is_empty());
        assert!(db::rows(&f.db, "SELECT value FROM bindings", &[])
            .unwrap()
            .is_empty());
    }
}

#[test]
fn plugin_discovery_returns_only_healthy_current_sessions_beside_incomplete_cached_history() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let previous = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    let old_id = previous["resources"][0]["resourceId"].as_str().unwrap();
    let directory = native::codex_home().unwrap().join("sessions");
    let old_path = fs::read_dir(&directory)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut records = native::complete_records(&fs::read(&old_path).unwrap()).unwrap();
    let native_id = uuid::Uuid::new_v4().to_string();
    records[0]["payload"]["id"] = json!(native_id);
    let fresh_path = directory.join(format!("rollout-{native_id}.jsonl"));
    fs::write(&fresh_path, native::encode(&records)).unwrap();
    fs::write(&old_path, "Incomplete old native history\n").unwrap();
    let discovered = indexer::discover(&f.db, &f.project, "session").unwrap();
    assert_eq!(discovered.len(), 1);
    assert_eq!(discovered[0]["nativeId"], native_id);
    assert_ne!(discovered[0]["resource"]["resourceId"], old_id);
    let cached = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert_eq!(cached["resources"].as_array().unwrap().len(), 2);
    assert!(cached["resources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|resource| resource["resourceId"] == old_id));
    assert!(!cached["errors"].as_array().unwrap().is_empty());
    fs::remove_file(old_path).unwrap();
    let complete = indexer::discover(&f.db, &f.project, "session").unwrap();
    assert_eq!(complete.len(), 1);
    assert!(
        db::rows(
            &f.db,
            "SELECT value FROM local_resources WHERE id=?",
            &[&old_id]
        )
        .unwrap()
        .is_empty(),
        "a complete scan still retires genuinely removed resources"
    );
    assert!(f.outbox().is_empty());
}
