use super::*;
use crate::{governance, selective_sharing};

fn input(f: &Fixture) -> Value {
    json!({"accountId":db::get(&f.db,"user").unwrap(),"serviceOrigin":"https://selected.example","projectId":f.project["id"]})
}

fn prepare(f: &mut Fixture) {
    f.project["sharing"] = json!(crate::projects::Sharing::default());
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
        "config",
        &json!({"apiUrl":"https://selected.example"}),
    )
    .unwrap();
    super::sharing_tests::seed(f);
}

#[test]
fn selected_discovery_keeps_all_categories_private_and_excludes_envs() {
    let mut f = Fixture::new();
    prepare(&mut f);
    for kind in ["memory", "skill", "plan", "session"] {
        let items = indexer::discover(&f.db, &f.project, kind).unwrap();
        assert!(!items.is_empty(), "{kind}");
        assert!(items.iter().all(|item| item["resource"]["kind"] == kind));
        assert!(f.outbox().is_empty());
        assert!(f.resources().is_empty());
        assert!(db::rows(&f.db, "SELECT value FROM bindings", &[])
            .unwrap()
            .is_empty());
        assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
            .unwrap()
            .is_empty());
    }
    assert!(indexer::discover(&f.db, &f.project, "env").is_err());
    assert!(!f.root.join(".orka/plans/codex").exists());
    assert_eq!(
        f.project["sharing"],
        json!(crate::projects::Sharing::default())
    );
}

#[test]
fn selected_discovery_does_not_reconcile_divergent_or_removed_skill_mirrors() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let original = indexer::discover(&f.db, &f.project, "skill")
        .unwrap()
        .remove(0);
    let id = original["resource"]["resourceId"].as_str().unwrap();
    let other = f.root.join(".claude/skills/example");
    fs::create_dir_all(&other).unwrap();
    fs::write(other.join("SKILL.md"), "Different private skill").unwrap();
    assert!(indexer::discover(&f.db, &f.project, "skill")
        .unwrap()
        .is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM bindings", &[])
        .unwrap()
        .is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .is_empty());
    fs::remove_dir_all(&other).unwrap();
    let binding = json!({"base":original["resource"],"paths":[original["paths"][0],other],"guards":["old","old"],"mirrorReview":true});
    db::upsert(
        &f.db,
        "bindings",
        id,
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    let found = indexer::discover(&f.db, &f.project, "skill").unwrap();
    assert_eq!(found[0]["resource"]["files"], original["resource"]["files"]);
    assert_eq!(indexer::binding(&f.db, id).unwrap(), binding);
    assert!(f.outbox().is_empty());
    assert!(f.resources().is_empty());
}

#[test]
fn selected_share_freezes_one_snapshot_deduplicates_and_never_enables_future_turns() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let local = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .remove(0);
    let mut request = input(&f);
    request["kind"] = json!("session");
    request["resourceId"] = local["resource"]["resourceId"].clone();
    let preview = selective_sharing::preview(&f.db, &f.project, &request).unwrap();
    let source = PathBuf::from(local["paths"][0].as_str().unwrap());
    let mut bytes = fs::read(&source).unwrap();
    bytes.extend_from_slice(b"{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"text\":\"Future private turn\"}]}}\n");
    fs::write(&source, &bytes).unwrap();
    request["previewToken"] = preview["previewToken"].clone();
    let receipt = selective_sharing::queue(&f.db, &f.project, &request).unwrap();
    assert_eq!(receipt["status"], "queued");
    assert_eq!(
        selective_sharing::queue(&f.db, &f.project, &request).unwrap(),
        receipt
    );
    let queued = db::rows(
        &f.db,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox",
        &[],
    )
    .unwrap()
    .remove(0);
    assert_eq!(
        queued["value"]["resource"]["files"],
        local["resource"]["files"]
    );
    assert!(selective_sharing::authorized(&f.db, &queued).unwrap());
    let mut tampered = queued.clone();
    tampered["value"]["resource"]["title"] = json!("Different snapshot");
    assert!(!selective_sharing::authorized(&f.db, &tampered).unwrap());
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(
        governance::project(&f.db, f.project["id"].as_str().unwrap()).unwrap()["sharing"],
        f.project["sharing"]
    );
    let next = selective_sharing::preview(&f.db, &f.project, &request).unwrap();
    assert_ne!(next["snapshotHash"], preview["snapshotHash"]);
    request["previewToken"] = next["previewToken"].clone();
    assert_ne!(
        selective_sharing::queue(&f.db, &f.project, &request).unwrap()["requestId"],
        receipt["requestId"]
    );
    crate::projects::remove_local(&f.db, f.project["id"].as_str().unwrap()).unwrap();
    assert!(f.outbox().is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM local_resources", &[])
        .unwrap()
        .is_empty());
    assert!(db::rows(
        &f.db,
        "SELECT value FROM meta WHERE key LIKE 'share-preview:%' OR key LIKE 'selected-share:%'",
        &[]
    )
    .unwrap()
    .is_empty());
    assert_eq!(fs::read(source).unwrap(), bytes);
}

#[test]
fn selected_preview_is_bound_to_account_service_project_expiry_and_folder() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let local = indexer::discover(&f.db, &f.project, "skill")
        .unwrap()
        .remove(0);
    let mut request = input(&f);
    request["kind"] = json!("skill");
    request["resourceId"] = local["resource"]["resourceId"].clone();
    let preview = selective_sharing::preview(&f.db, &f.project, &request).unwrap();
    request["previewToken"] = preview["previewToken"].clone();
    for key in ["accountId", "serviceOrigin", "projectId"] {
        let mut wrong = request.clone();
        wrong[key] = json!("another");
        assert!(selective_sharing::queue(&f.db, &f.project, &wrong).is_err());
    }
    let key = format!(
        "share-preview:{}",
        preview["previewToken"].as_str().unwrap()
    );
    let saved = db::get(&f.db, &key).unwrap();
    let mut expired = saved.clone();
    expired["expires"] = json!(0);
    db::set(&f.db, &key, &expired).unwrap();
    assert!(selective_sharing::queue(&f.db, &f.project, &request)
        .unwrap_err()
        .contains("expired"));
    db::set(&f.db, &key, &saved).unwrap();
    let mut moved = f.project.clone();
    moved["folderIdentity"] = json!("different-folder");
    assert!(selective_sharing::queue(&f.db, &moved, &request).is_err());
    assert!(f.outbox().is_empty());
}

#[test]
fn selected_requests_survive_governance_localization_and_respect_account_changes() {
    let mut f = Fixture::new();
    prepare(&mut f);
    f.project["governed"] = json!(true);
    let local = indexer::discover(&f.db, &f.project, "memory")
        .unwrap()
        .remove(0);
    let mut request = input(&f);
    request["kind"] = json!("memory");
    request["resourceId"] = local["resource"]["resourceId"].clone();
    request["previewToken"] =
        selective_sharing::preview(&f.db, &f.project, &request).unwrap()["previewToken"].clone();
    selective_sharing::queue(&f.db, &f.project, &request).unwrap();
    governance::localize_outbox(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    let queued = db::rows(
        &f.db,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox",
        &[],
    )
    .unwrap()
    .remove(0);
    db::set(&f.db, "user", &json!(uuid::Uuid::new_v4().to_string())).unwrap();
    assert!(!selective_sharing::authorized(&f.db, &queued).unwrap());
}

#[tokio::test]
async fn selected_tools_check_local_account_before_discovering_private_items() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let mut request = input(&f);
    request["kind"] = json!("session");
    request["accountId"] = json!(uuid::Uuid::new_v4().to_string());
    assert!(selective_sharing::command("list_local_resources", &request)
        .await
        .unwrap_err()
        .contains("same Orka account"));
    request = input(&f);
    request["kind"] = json!("session");
    request["serviceOrigin"] = json!("https://another.example");
    assert!(selective_sharing::command("list_local_resources", &request)
        .await
        .unwrap_err()
        .contains("same Orka service"));
    assert!(db::rows(&f.db, "SELECT value FROM local_resources", &[])
        .unwrap()
        .is_empty());
}

#[test]
fn selected_conflict_receipt_preserves_current_and_candidate_snapshots() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let local = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .remove(0);
    let mut request = input(&f);
    request["kind"] = json!("session");
    request["resourceId"] = local["resource"]["resourceId"].clone();
    request["previewToken"] =
        selective_sharing::preview(&f.db, &f.project, &request).unwrap()["previewToken"].clone();
    selective_sharing::queue(&f.db, &f.project, &request).unwrap();
    let queued = db::rows(
        &f.db,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox",
        &[],
    )
    .unwrap()
    .remove(0);
    let selected = queued["value"]["resource"].clone();
    let mut current = selected.clone();
    current["projectId"] = f.project["id"].clone();
    current["revision"] = json!(2);
    current["files"] =
        json!([{"path":"session.jsonl","hash":"0".repeat(64),"size":0,"executable":false}]);
    let result = json!({"status":"conflict","receipt":{"conflict":true,"event":{"resource":current,"conflicts":[{"id":queued["id"],"resourceId":selected["resourceId"],"candidate":selected,"revision":2}]}}});
    selective_sharing::complete(&f.db, &queued, &result).unwrap();
    assert_eq!(f.resources()[0]["files"], current["files"]);
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM conflicts", &[]).unwrap()[0]["candidate"]["files"],
        selected["files"]
    );
    assert_eq!(
        db::get(
            &f.db,
            &format!("selected-share:{}", queued["id"].as_str().unwrap())
        )
        .unwrap()["status"],
        "conflict"
    );
}

#[test]
fn selected_publication_continues_from_its_revision_when_automation_is_later_enabled() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let local = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .remove(0);
    let mut request = input(&f);
    request["kind"] = json!("session");
    request["resourceId"] = local["resource"]["resourceId"].clone();
    request["previewToken"] =
        selective_sharing::preview(&f.db, &f.project, &request).unwrap()["previewToken"].clone();
    let receipt = selective_sharing::queue(&f.db, &f.project, &request).unwrap();
    // An explicit retry restores the identical frozen request after outbox cleanup.
    f.db.execute("DELETE FROM outbox", []).unwrap();
    assert_eq!(
        selective_sharing::queue(&f.db, &f.project, &request).unwrap(),
        receipt
    );
    let queued = db::rows(
        &f.db,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox",
        &[],
    )
    .unwrap()
    .remove(0);
    let mut resource = queued["value"]["resource"].clone();
    resource["projectId"] = f.project["id"].clone();
    resource["revision"] = json!(1);
    resource["owner"] = db::get(&f.db, "user").unwrap();
    selective_sharing::complete(
        &f.db,
        &queued,
        &json!({"status":"published","receipt":{"event":{"resource":resource,"conflicts":[]}}}),
    )
    .unwrap();
    f.db.execute("DELETE FROM outbox", []).unwrap();
    let source = PathBuf::from(local["paths"][0].as_str().unwrap());
    let mut bytes = fs::read(&source).unwrap();
    bytes.extend_from_slice(b"{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"text\":\"New turn\"}]}}\n");
    fs::write(&source, &bytes).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    f.project["sharing"]["session"] = json!(true);
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let change = f
        .outbox()
        .into_iter()
        .find(|change| change["resource"]["resourceId"] == resource["resourceId"])
        .unwrap();
    assert_eq!(change["baseRevision"], 1);
    assert_ne!(change["resource"]["files"], resource["files"]);
    assert_eq!(fs::read(source).unwrap(), bytes);
}
