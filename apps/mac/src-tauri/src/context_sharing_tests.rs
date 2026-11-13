use super::*;
use crate::{context_sharing, governance};

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

#[test]
fn plugin_retries_keep_frozen_context_queues_eligible_without_unblocking_legacy_uploads() {
    let f = fixture("owner");
    fs::write(f.root.join("AGENTS.md"), "Frozen instructions\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let frozen = queued(&f);
    assert_eq!(frozen["path"], context_sharing::QUEUE_PATH);
    let original = f.outbox();
    let legacy_id = uuid::Uuid::new_v4().to_string();
    let mut legacy = frozen["value"].clone();
    legacy["id"] = json!(legacy_id);
    f.db.execute(
        "INSERT INTO outbox VALUES(?,?,?,?,NULL)",
        rusqlite::params![
            legacy_id,
            f.project["id"].as_str(),
            format!("{}-other", context_sharing::QUEUE_PATH),
            legacy.to_string()
        ],
    )
    .unwrap();
    governance::block_legacy_retry(&f.db, &f.project).unwrap();
    let errors = db::rows(
        &f.db,
        "SELECT json_object('id',id,'error',error) FROM outbox ORDER BY rowid",
        &[],
    )
    .unwrap();
    assert_eq!(errors[0]["id"], frozen["id"]);
    assert_eq!(errors[0]["error"], Value::Null);
    assert!(errors[1]["error"].as_str().unwrap().starts_with("409:"));
    assert_eq!(f.outbox()[0], original[0]);
    context_sharing::check_upload_eligibility(&f.db, &frozen).unwrap();
}

#[test]
fn ignored_frozen_instructions_stop_before_upload_and_preserve_the_exact_queue() {
    let f = fixture("owner");
    db::set(&f.db, "config", &json!({"apiUrl":"invalid-fixture-origin"})).unwrap();
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(&f.root)
        .status()
        .unwrap()
        .success());
    fs::write(f.root.join("AGENTS.md"), "Frozen original source\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let frozen = queued(&f);
    let before = db::rows(
        &f.db,
        "SELECT json_object('id',id,'raw',value) FROM outbox",
        &[],
    )
    .unwrap();
    let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
    fs::write(f.root.join("AGENTS.md"), "Later private source\n").unwrap();
    fs::write(f.root.join(".gitignore"), "AGENTS.md\n").unwrap();
    let owner = db::get(&f.db, "user").unwrap();
    let error = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(context_sharing::upload(
            &f.db,
            owner.as_str().unwrap(),
            &frozen,
        ))
        .unwrap_err();
    assert!(
        error.starts_with("409: Queued instruction is now ignored"),
        "{error}"
    );
    assert_eq!(
        db::rows(
            &f.db,
            "SELECT json_object('id',id,'raw',value) FROM outbox",
            &[]
        )
        .unwrap(),
        before
    );
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap(),
        drafts
    );
    assert_eq!(
        fs::read_to_string(f.root.join("AGENTS.md")).unwrap(),
        "Later private source\n"
    );
    let mut selected = frozen;
    selected["path"] = json!(crate::selective_sharing::QUEUE_PATH);
    context_sharing::check_upload_eligibility(&f.db, &selected).unwrap();
}

#[test]
fn queued_instruction_eligibility_uses_its_frozen_resource_instead_of_the_latest_draft() {
    let f = fixture("owner");
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(&f.root)
        .status()
        .unwrap()
        .success());
    fs::write(f.root.join("CLAUDE.md"), "Frozen allowed source\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let frozen = queued(&f);
    let project = f.project["id"].as_str().unwrap();
    let draft_id = frozen["value"]["contextDraft"].as_str().unwrap();
    let mut newer = db::rows(&f.db, "SELECT value FROM drafts WHERE id=?", &[&draft_id])
        .unwrap()
        .remove(0);
    let newer_id = uuid::Uuid::new_v4().to_string();
    newer["id"] = json!(newer_id);
    newer["resource"]["logicalPath"] = json!("instructions/AGENTS.md");
    newer["updatedAt"] = json!("9999-01-01T00:00:00Z");
    db::upsert(&f.db, "drafts", &newer_id, project, &newer).unwrap();
    fs::write(f.root.join("AGENTS.md"), "Newer ignored source\n").unwrap();
    fs::write(f.root.join(".gitignore"), "AGENTS.md\n").unwrap();
    assert_eq!(
        governance::latest_draft(
            &f.db,
            project,
            frozen["value"]["resource"]["resourceId"].as_str().unwrap()
        )
        .unwrap()
        .unwrap()["id"],
        newer_id
    );
    context_sharing::check_upload_eligibility(&f.db, &frozen).unwrap();
    fs::write(f.root.join(".gitignore"), "CLAUDE.md\n").unwrap();
    assert!(context_sharing::check_upload_eligibility(&f.db, &frozen).is_err());
    assert_eq!(queued(&f), frozen);
}
