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
    fs::write(&native, "Updated learning\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let second = queued(&f);
    assert_ne!(first["id"], second["id"]);
    assert_eq!(
        first["value"]["resource"]["resourceId"],
        second["value"]["resource"]["resourceId"]
    );
    assert_eq!(second["value"]["baseRevision"], 1);
    assert_eq!(f.resources().len(), 1);
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
