use super::*;
use crate::{context_sharing, governance, projects};

fn fixture(mode: &str) -> Fixture {
    let mut f = Fixture::new();
    f.project["governed"] = json!(true);
    f.project["sharing"] = json!({"memory":true,"skill":true});
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    db::set(&f.db, &format!("governance:{}", f.project["id"].as_str().unwrap()), &json!({"owner":mode=="owner","access":{"memory":{"create":mode},"instructions":{"create":mode},"skill":{"create":mode}}})).unwrap();
    f
}

fn native_memory(f: &Fixture, text: &str) -> PathBuf {
    let directory = indexer::claude_memory(&f.root).unwrap();
    fs::create_dir_all(&directory).unwrap();
    let file = directory.join("MEMORY.md");
    fs::write(&file, text).unwrap();
    file
}

fn queued(f: &Fixture) -> Value {
    db::rows(&f.db, "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox ORDER BY rowid", &[]).unwrap().remove(0)
}

fn source_project(f: &Fixture) -> (Value, String, String) {
    let removed = uuid::Uuid::new_v4().to_string();
    let active = uuid::Uuid::new_v4().to_string();
    let mut project = f.project.clone();
    project["sources"] = json!([
        {"id":removed,"name":"Removed","path":f.root,"folderIdentity":f.project["folderIdentity"]},
        {"id":active,"name":"Offline","path":null,"folderIdentity":null}
    ]);
    db::upsert(
        &f.db,
        "projects",
        project["id"].as_str().unwrap(),
        "",
        &project,
    )
    .unwrap();
    (project, removed, active)
}

fn source_memory(source: &str) -> Value {
    json!({"resourceId":uuid::Uuid::new_v4().to_string(),"sourceId":source,"kind":"memory","source":"claude","logicalPath":"claude/MEMORY.md","title":"Saved learning","deleted":false,"files":[{"path":"content.md","hash":db::blob(b"Saved learning\n").unwrap(),"size":15,"executable":false}]})
}

#[test]
fn removed_sources_keep_deferred_context_private_without_blocking_other_saved_snapshots() {
    for (mode, sharing) in [
        ("owner", true),
        ("suggest", true),
        ("owner", false),
        ("suggest", false),
    ] {
        let f = fixture(mode);
        let (mut project, removed, active) = source_project(&f);
        let resource = source_memory(&removed);
        let id = governance::capture(&f.db, &project, &resource, &json!([])).unwrap();
        project["deferAutomaticSharing"] = json!(true);
        context_sharing::queue_automatic(&f.db, &project, &id).unwrap();
        assert!(f.outbox().is_empty());
        project
            .as_object_mut()
            .unwrap()
            .remove("deferAutomaticSharing");
        project["sharing"]["memory"] = json!(sharing);
        db::upsert(
            &f.db,
            "projects",
            project["id"].as_str().unwrap(),
            "",
            &project,
        )
        .unwrap();
        project["sources"][0]["removedAt"] = json!("2026-11-13T00:00:00Z");
        projects::merge_catalog(&f.db, &json!([project])).unwrap();
        let mut project = governance::project(&f.db, f.project["id"].as_str().unwrap()).unwrap();
        assert_eq!(project["sharing"]["memory"], sharing);
        for _ in 0..3 {
            context_sharing::queue_waiting(&f.db, &project).unwrap();
        }
        assert!(f.outbox().is_empty());
        let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0]["resource"], resource);
        assert_eq!(drafts[0]["automaticSharing"], false);
        assert_eq!(
            drafts[0]["sourceRemoval"],
            json!({"sourceId":removed,"removedAt":"2026-11-13T00:00:00Z"})
        );
        assert!(context_sharing::queue(&f.db, &project, &id).is_err());
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let input = json!({"projectId":project["id"],"id":id});
        let detail = runtime
            .block_on(governance::governance_command(
                "draft".into(),
                input.clone(),
            ))
            .unwrap();
        assert_eq!(detail["sourceUnavailable"], true);
        assert_eq!(detail["files"]["content.md"], "Saved learning\n");
        assert!(runtime
            .block_on(governance::governance_command("submit-draft".into(), input))
            .is_err());
        assert!(f.outbox().is_empty());
        project["sharing"]["memory"] = json!(true);
        db::upsert(
            &f.db,
            "projects",
            project["id"].as_str().unwrap(),
            "",
            &project,
        )
        .unwrap();
        let healthy = source_memory(&active);
        let healthy_id = governance::capture(&f.db, &project, &healthy, &json!([])).unwrap();
        context_sharing::queue_automatic(&f.db, &project, &healthy_id).unwrap();
        assert_eq!(
            f.outbox().len(),
            1,
            "offline but registered sources retain durable publication"
        );
        assert_eq!(queued(&f)["value"]["resource"]["sourceId"], active);
    }
}

#[test]
fn removed_sources_stop_own_pending_approvals_and_preserve_recovery_metadata() {
    let f = fixture("owner");
    let (mut project, removed, active) = source_project(&f);
    let owner = db::get(&f.db, "user").unwrap();
    let mut requests = Vec::new();
    let mut removed_draft = String::new();
    let mut removed_queue = Value::Null;
    for source in [&removed, &active] {
        let resource = source_memory(source);
        let id = governance::capture(&f.db, &project, &resource, &json!([])).unwrap();
        context_sharing::queue_automatic(&f.db, &project, &id).unwrap();
        let entry = queued(&f);
        let request = json!({"id":entry["id"],"projectId":project["id"],"resourceId":entry["value"]["resource"]["resourceId"],"status":"pending","author":owner,"canReview":true,"previewHash":"exact-version"});
        context_sharing::complete(&f.db, &entry, &json!({"proposal":request})).unwrap();
        f.db.execute(
            "DELETE FROM outbox WHERE id=?",
            [entry["id"].as_str().unwrap()],
        )
        .unwrap();
        requests.push(request);
        if source == &removed {
            removed_draft = id;
            removed_queue = entry;
        }
    }
    project["sources"][0]["removedAt"] = json!("2026-11-13T00:00:00Z");
    projects::merge_catalog(&f.db, &json!([project])).unwrap();
    let project = governance::project(&f.db, f.project["id"].as_str().unwrap()).unwrap();
    let catalog = json!({"requests":requests,"policyRevision":1});
    assert_eq!(
        context_sharing::pending_publications(&f.db, owner.as_str().unwrap(), &project, &catalog)
            .unwrap(),
        json!([requests[1]]).as_array().unwrap().clone()
    );
    let mut draft = db::rows(
        &f.db,
        "SELECT value FROM drafts WHERE id=?",
        &[&removed_draft],
    )
    .unwrap()
    .remove(0);
    assert_eq!(draft["automaticSharing"], false);
    draft["sourceRemoval"]["queued"] = removed_queue;
    db::upsert(
        &f.db,
        "drafts",
        &removed_draft,
        project["id"].as_str().unwrap(),
        &draft,
    )
    .unwrap();
    for _ in 0..3 {
        context_sharing::pending_publications(&f.db, owner.as_str().unwrap(), &project, &catalog)
            .unwrap();
    }
    assert_eq!(
        db::rows(
            &f.db,
            "SELECT value FROM drafts WHERE id=?",
            &[&removed_draft]
        )
        .unwrap()[0],
        draft
    );
    assert!(f.outbox().is_empty());
}

#[test]
fn enabled_context_shares_for_owners_publishers_and_suggesters_without_repeated_sync_requests() {
    for mode in ["owner", "publish", "suggest", "read", "hidden"] {
        let f = fixture(mode);
        native_memory(&f, "Saved learning\n");
        fs::write(f.root.join("AGENTS.md"), "Project instructions\n").unwrap();
        for folder in [".agents/skills/example", ".claude/skills/example"] {
            fs::create_dir_all(f.root.join(folder)).unwrap();
            fs::write(f.root.join(folder).join("SKILL.md"), "# Example\n").unwrap();
        }
        indexer::scan(&f.db, &f.project).unwrap();
        assert_eq!(
            f.outbox().len(),
            if matches!(mode, "read" | "hidden") {
                0
            } else {
                3
            },
            "{mode}"
        );
        let initial = f.outbox();
        let request = db::get(&f.db, "syncRequest").unwrap();
        indexer::scan(&f.db, &f.project).unwrap();
        assert_eq!(
            f.outbox(),
            initial,
            "{mode} must retain exact retry identities"
        );
        assert_eq!(
            db::get(&f.db, "syncRequest").unwrap(),
            request,
            "unchanged scans must not trigger endless sync"
        );
        governance::localize_outbox(&f.db, &f.project).unwrap();
        assert_eq!(f.outbox(), initial);
        assert!(f.resources().is_empty());
    }
}

#[test]
fn memory_edits_reuse_the_shared_identity_and_keep_native_learning_unchanged() {
    let f = fixture("owner");
    let native = native_memory(&f, "Original learning\n");
    indexer::scan(&f.db, &f.project).unwrap();
    let first = queued(&f);
    assert_eq!(first["path"], context_sharing::QUEUE_PATH);
    let mut accepted = first["value"]["resource"].clone();
    accepted["projectId"] = f.project["id"].clone();
    accepted["revision"] = json!(1);
    accepted["owner"] = db::get(&f.db, "user").unwrap();
    accepted["updatedBy"] = accepted["owner"].clone();
    // Consolidation can change the published bytes without changing the local source.
    accepted["files"][0]["hash"] = json!(db::blob(b"Consolidated learning\n").unwrap());
    accepted["files"][0]["size"] = json!(22);
    context_sharing::complete(
        &f.db,
        &first,
        &json!({"event":{"resource":accepted,"conflicts":[]}}),
    )
    .unwrap();
    f.db.execute("DELETE FROM outbox WHERE id=?", [first["id"].as_str()])
        .unwrap();
    sync::materialize(&f.db, &f.project, &accepted).unwrap();
    assert_eq!(fs::read_to_string(&native).unwrap(), "Original learning\n");
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        f.outbox().is_empty(),
        "consolidated shared bytes must not repeatedly republish native learning"
    );
    let other_source = uuid::Uuid::new_v4().to_string();
    db::set(
        &f.db,
        &format!("exposedSources:{}", f.project["id"].as_str().unwrap()),
        &json!([accepted["resourceId"], other_source]),
    )
    .unwrap();
    fs::write(&native, "Updated learning\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let second = queued(&f);
    assert_ne!(first["id"], second["id"]);
    assert_eq!(
        first["value"]["resource"]["resourceId"],
        second["value"]["resource"]["resourceId"]
    );
    assert_eq!(second["value"]["baseRevision"], 1);
    assert_eq!(
        second["value"]["resource"]["contextSources"],
        json!([other_source])
    );
    assert_eq!(f.resources().len(), 1);
}

fn publish(f: &Fixture, queued: &Value, revision: u64) {
    let mut accepted = queued["value"]["resource"].clone();
    accepted["projectId"] = f.project["id"].clone();
    accepted["revision"] = json!(revision);
    accepted["owner"] = db::get(&f.db, "user").unwrap();
    accepted["updatedBy"] = accepted["owner"].clone();
    context_sharing::complete(
        &f.db,
        queued,
        &json!({"event":{"resource":accepted,"conflicts":[]}}),
    )
    .unwrap();
    f.db.execute("DELETE FROM outbox WHERE id=?", [queued["id"].as_str()])
        .unwrap();
}

#[test]
fn reverting_to_a_published_native_version_creates_a_new_publication() {
    for kind in ["memory", "skill"] {
        let f = fixture("owner");
        let path = if kind == "memory" {
            native_memory(&f, "Version A\n")
        } else {
            let path = f.root.join(".agents/skills/example/SKILL.md");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "Version A\n").unwrap();
            path
        };
        indexer::scan(&f.db, &f.project).unwrap();
        let first = queued(&f);
        publish(&f, &first, 1);
        fs::write(&path, "Version B\n").unwrap();
        indexer::scan(&f.db, &f.project).unwrap();
        let second = queued(&f);
        publish(&f, &second, 2);
        fs::write(&path, "Version A\n").unwrap();
        indexer::scan(&f.db, &f.project).unwrap();
        let third = queued(&f);
        assert_eq!(
            third["value"]["resource"]["resourceId"],
            first["value"]["resource"]["resourceId"]
        );
        assert_eq!(
            third["value"]["resource"]["files"],
            first["value"]["resource"]["files"]
        );
        assert_eq!(third["value"]["baseRevision"], 2);
        assert_ne!(third["id"], first["id"]);
        let before = f.outbox();
        indexer::scan(&f.db, &f.project).unwrap();
        assert_eq!(f.outbox(), before);
    }
}

#[test]
fn offline_context_edits_wait_for_the_previous_publication_before_freezing_their_base() {
    for kind in ["instructions", "skill"] {
        let f = fixture("owner");
        let path = if kind == "instructions" {
            f.root.join("AGENTS.md")
        } else {
            f.root.join(".agents/skills/example/SKILL.md")
        };
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "Version A\n").unwrap();
        indexer::scan(&f.db, &f.project).unwrap();
        let first = queued(&f);
        fs::write(&path, "Version B\n").unwrap();
        indexer::scan(&f.db, &f.project).unwrap();
        fs::write(&path, "Version C\n").unwrap();
        indexer::scan(&f.db, &f.project).unwrap();
        assert_eq!(
            f.outbox().len(),
            1,
            "{kind}: only one snapshot may have a frozen base"
        );
        publish(&f, &first, 1);
        context_sharing::queue_waiting(&f.db, &f.project).unwrap();
        let latest = queued(&f);
        assert_eq!(latest["value"]["baseRevision"], 1);
        let bytes = db::blob_read(
            latest["value"]["resource"]["files"][0]["hash"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            bytes, b"Version C\n",
            "{kind}: coalesce unsent intermediate content"
        );
    }
}

#[test]
fn ignoring_an_automatically_queued_instruction_cancels_its_upload() {
    let f = fixture("owner");
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(&f.root)
        .status()
        .unwrap()
        .success());
    fs::write(f.root.join("AGENTS.md"), "Private source\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    fs::write(f.root.join("AGENTS.md"), "Updated private source\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    fs::write(f.root.join(".gitignore"), "AGENTS.md\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap()[0]["dismissalReason"],
        "ignored_source"
    );
}

#[test]
fn pending_approvals_resolve_and_pull_before_the_next_exact_base_snapshot_is_prepared() {
    for kind in ["instructions", "skill"] {
        let f = fixture("owner");
        let path = if kind == "instructions" {
            f.root.join("AGENTS.md")
        } else {
            f.root.join(".agents/skills/example/SKILL.md")
        };
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "Version A\n").unwrap();
        indexer::scan(&f.db, &f.project).unwrap();
        let first = queued(&f);
        let owner = db::get(&f.db, "user").unwrap();
        let request = json!({"id":first["id"],"projectId":f.project["id"],"resourceId":first["value"]["resource"]["resourceId"],"status":"pending","author":owner,"canReview":true});
        context_sharing::complete(&f.db, &first, &json!({"proposal":request})).unwrap();
        f.db.execute("DELETE FROM outbox", []).unwrap();
        fs::write(&path, "Version B\n").unwrap();
        indexer::scan(&f.db, &f.project).unwrap();
        context_sharing::queue_waiting(&f.db, &f.project).unwrap();
        assert!(
            f.outbox().is_empty(),
            "pending proposal must serialize the next snapshot"
        );
        let mut approved = request;
        approved["status"] = json!("approved");
        governance::reconcile_requests(
            &f.db,
            f.project["id"].as_str().unwrap(),
            &json!([approved]),
        )
        .unwrap();
        let mut discovery = f.project.clone();
        discovery["deferAutomaticSharing"] = json!(true);
        indexer::scan(&f.db, &discovery).unwrap();
        assert!(
            f.outbox().is_empty(),
            "pre-pull discovery must not freeze a stale base"
        );
        publish(&f, &first, 1);
        context_sharing::queue_waiting(&f.db, &f.project).unwrap();
        assert_eq!(queued(&f)["value"]["baseRevision"], 1);
    }
}

#[test]
fn concurrent_teammate_changes_require_review_before_local_context_can_replace_them() {
    for kind in ["instructions", "skill"] {
        let f = fixture("owner");
        let path = if kind == "instructions" {
            f.root.join("AGENTS.md")
        } else {
            f.root.join(".agents/skills/example/SKILL.md")
        };
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "Version A\n").unwrap();
        indexer::scan(&f.db, &f.project).unwrap();
        let first = queued(&f);
        publish(&f, &first, 1);
        let mut accepted = f.resources()[0].clone();
        db::upsert(
            &f.db,
            "bindings",
            accepted["resourceId"].as_str().unwrap(),
            f.project["id"].as_str().unwrap(),
            &json!({"base":accepted,"paths":[path]}),
        )
        .unwrap();
        fs::write(&path, "Local version B\n").unwrap();
        let mut discovery = f.project.clone();
        discovery["deferAutomaticSharing"] = json!(true);
        indexer::scan(&f.db, &discovery).unwrap();
        accepted["revision"] = json!(2);
        accepted["updatedBy"] = json!("teammate");
        accepted["files"][0]["hash"] = json!(db::blob(b"Teammate version C\n").unwrap());
        accepted["files"][0]["size"] = json!(19);
        db::upsert(
            &f.db,
            "resources",
            accepted["resourceId"].as_str().unwrap(),
            f.project["id"].as_str().unwrap(),
            &accepted,
        )
        .unwrap();
        context_sharing::queue_waiting(&f.db, &f.project).unwrap();
        assert!(
            f.outbox().is_empty(),
            "{kind}: automatic sharing must preserve the teammate update"
        );
        let draft = db::rows(
            &f.db,
            "SELECT value FROM drafts WHERE json_extract(value,'$.conflictReview')=1",
            &[],
        )
        .unwrap()
        .remove(0);
        assert_eq!(draft["baseRevision"], 1);
        assert_eq!(draft["automaticSharing"], false);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let input = json!({"projectId":f.project["id"],"id":draft["id"]});
        let review = runtime
            .block_on(governance::governance_command("draft".into(), input))
            .unwrap();
        assert_eq!(review["baseRevision"], 2);
        assert!(review["before"].to_string().contains("Teammate version C"));
        let result=runtime.block_on(governance::governance_command("submit-draft".into(),json!({"projectId":f.project["id"],"id":draft["id"],"reviewedFiles":draft["resource"]["files"],"reviewedRevision":2}))).unwrap();
        assert_eq!(result["status"], "queued");
        assert_eq!(queued(&f)["value"]["baseRevision"], 2);
        assert_eq!(fs::read_to_string(&path).unwrap(), "Local version B\n");
    }
}

#[test]
fn restricted_plan_and_session_scans_keep_their_suggestion_flow_without_context_queue_errors() {
    let mut f = fixture("suggest");
    super::sharing_tests::seed(&f);
    f.project["sharing"] = json!({"plan":true,"session":true});
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let resources = f.resources();
    assert!(!resources.is_empty());
    f.db.execute("DELETE FROM outbox", []).unwrap();
    for mut resource in resources {
        resource["access"] = json!({"mode":"suggest"});
        resource["files"] = json!([]);
        db::upsert(
            &f.db,
            "resources",
            resource["resourceId"].as_str().unwrap(),
            f.project["id"].as_str().unwrap(),
            &resource,
        )
        .unwrap();
    }
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[]
    )
    .unwrap()
    .is_empty());
    assert!(!db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .is_empty());
    assert!(f.outbox().is_empty());
}

#[test]
fn disabled_categories_and_resource_restrictions_preserve_local_candidates() {
    let mut f = fixture("publish");
    native_memory(&f, "Saved learning\n");
    f.project["sharing"]["memory"] = json!(false);
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .is_empty());
    f.project["sharing"]["memory"] = json!(true);
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let change = queued(&f);
    let mut restricted = change["value"]["resource"].clone();
    restricted["projectId"] = f.project["id"].clone();
    restricted["revision"] = json!(1);
    restricted["access"] = json!({"mode":"read"});
    db::upsert(
        &f.db,
        "resources",
        restricted["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &restricted,
    )
    .unwrap();
    f.db.execute("DELETE FROM outbox", []).unwrap();
    native_memory(&f, "Restricted local update\n");
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        f.outbox().is_empty(),
        "collection publishing rights must not override a file restriction"
    );
}

#[test]
fn draft_reviews_preserve_executable_and_binary_manifest_metadata() {
    let f = fixture("owner");
    let id = uuid::Uuid::new_v4().to_string();
    let project = f.project["id"].as_str().unwrap();
    let original = json!({"resourceId":id,"projectId":project,"kind":"skill","source":"shared","logicalPath":"example","title":"Example","revision":3,"owner":db::get(&f.db,"user").unwrap(),"deleted":false,"files":[{"path":"run.sh","hash":db::blob(b"echo hello\n").unwrap(),"size":11,"executable":false},{"path":"literal.txt","hash":db::blob(b"Binary asset").unwrap(),"size":12,"executable":false},{"path":"asset.bin","hash":db::blob(&[255,254]).unwrap(),"size":2,"executable":false}]});
    db::upsert(&f.db, "resources", &id, project, &original).unwrap();
    let mut edited = original.clone();
    edited["files"][0]["executable"] = json!(true);
    let draft = governance::capture(&f.db, &f.project, &edited, &json!([])).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let detail = runtime
        .block_on(governance::governance_command(
            "draft".into(),
            json!({"projectId":project,"id":draft}),
        ))
        .unwrap();
    assert_eq!(detail["baseRevision"], 3);
    assert_eq!(detail["beforeManifest"][0]["executable"], false);
    assert_eq!(detail["manifest"][0]["executable"], true);
    assert_eq!(detail["before"], detail["files"]);
    for key in ["manifest", "beforeManifest"] {
        assert_eq!(detail[key][1]["binary"], false);
        assert_eq!(detail[key][2]["binary"], true);
    }
}

#[test]
fn owners_submit_memory_directly_and_legacy_pending_requests_finish_without_self_review() {
    let f = fixture("owner");
    let resource = json!({"resourceId":uuid::Uuid::new_v4().to_string(),"kind":"memory","source":"claude","logicalPath":"claude/MEMORY.md","title":"Learning","deleted":false,"files":[{"path":"content.md","hash":db::blob(b"Saved learning\n").unwrap(),"size":15,"executable":false}]});
    let id = governance::capture(&f.db, &f.project, &resource, &json!([])).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let input = json!({"projectId":f.project["id"],"id":id});
    let detail = runtime
        .block_on(governance::governance_command(
            "draft".into(),
            input.clone(),
        ))
        .unwrap();
    assert_eq!(detail["canPublish"], true);
    assert_eq!(
        runtime
            .block_on(governance::governance_command("submit-draft".into(), input))
            .unwrap()["status"],
        "queued"
    );
    let change = queued(&f);
    let owner = db::get(&f.db, "user").unwrap();
    let request = json!({"id":change["id"],"projectId":f.project["id"],"resourceId":change["value"]["resource"]["resourceId"],"status":"pending","author":owner,"canReview":true,"previewHash":"prepared-version"});
    context_sharing::complete(&f.db, &change, &json!({"proposal":request})).unwrap();
    let catalog = json!({"requests":[request],"policyRevision":1});
    assert_eq!(
        context_sharing::pending_publications(&f.db, owner.as_str().unwrap(), &f.project, &catalog)
            .unwrap()
            .len(),
        1
    );
    for variant in [
        "other-author",
        "cannot-review",
        "already-decided",
        "sharing-paused",
    ] {
        let mut catalog = catalog.clone();
        let mut project = f.project.clone();
        match variant {
            "other-author" => catalog["requests"][0]["author"] = json!("teammate"),
            "cannot-review" => catalog["requests"][0]["canReview"] = json!(false),
            "already-decided" => catalog["requests"][0]["status"] = json!("rejected"),
            _ => project["sharing"]["memory"] = json!(false),
        }
        assert!(
            context_sharing::pending_publications(
                &f.db,
                owner.as_str().unwrap(),
                &project,
                &catalog
            )
            .unwrap()
            .is_empty(),
            "{variant}"
        );
    }
    let mut approved = catalog["requests"][0].clone();
    approved["status"] = json!("approved");
    governance::reconcile_requests(&f.db, f.project["id"].as_str().unwrap(), &json!([approved]))
        .unwrap();
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM drafts WHERE id=?", &[&id]).unwrap()[0]["status"],
        "published"
    );
    let mut edit = resource.clone();
    edit["files"][0]["hash"] = json!(db::blob(b"New learning\n").unwrap());
    assert_eq!(
        context_sharing::publication_resource(&f.db, f.project["id"].as_str().unwrap(), &edit)
            .unwrap()["resourceId"],
        change["value"]["resource"]["resourceId"]
    );
}
