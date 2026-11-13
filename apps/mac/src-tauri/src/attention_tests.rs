use super::*;
use crate::{attention, commands, governance};

fn fixture() -> Fixture {
    let mut f = Fixture::new();
    f.project["governed"] = json!(true);
    let id = f.project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", id, id, &f.project).unwrap();
    f
}

fn skill(f: &Fixture) -> (Value, Value) {
    let paths = [
        f.root.join(".agents/skills/example"),
        f.root.join(".claude/skills/example"),
    ];
    for path in &paths {
        fs::create_dir_all(path).unwrap();
        fs::write(path.join("SKILL.md"), "# Current shared skill\n").unwrap();
    }
    let resource = json!({"resourceId":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],"kind":"skill","source":"shared","logicalPath":"example","title":"Example","files":packages::directory(&paths[0]).unwrap(),"revision":3,"deleted":false});
    let binding =
        json!({"base":resource,"paths":paths,"installationState":"current","reviewedRevision":3});
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
        &binding,
    )
    .unwrap();
    (resource, binding)
}

fn old_draft(f: &Fixture, resource: &Value) -> Value {
    let mut previous = resource.clone();
    previous["files"] = json!([{"path":"SKILL.md","hash":db::blob(b"# Earlier retained skill\n").unwrap(),"size":25,"executable":false}]);
    let draft = json!({"id":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],"resource":previous,"paths":[f.root.join(".agents/skills/example"),f.root.join(".claude/skills/example")],"status":"local","createdAt":"2026-11-01T00:00:00Z"});
    db::upsert(
        &f.db,
        "drafts",
        draft["id"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &draft,
    )
    .unwrap();
    draft
}

fn saved_draft(f: &Fixture, id: &Value) -> Value {
    db::rows(
        &f.db,
        "SELECT value FROM drafts WHERE id=?",
        &[&id.as_str().unwrap()],
    )
    .unwrap()
    .remove(0)
}

fn command(f: &Fixture, apply: Value) -> Result<Value, String> {
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(governance::governance_command(
            "reconcile-history".into(),
            json!({"projectId":f.project["id"],"apply":apply}),
        ))
}

#[test]
fn attention_reconciliation_archives_old_snapshots_without_losing_bytes_or_history() {
    let f = fixture();
    let (resource, _) = skill(&f);
    let old = old_draft(&f, &resource);
    let preview = command(&f, json!(false)).unwrap();
    assert_eq!(preview["draftsArchived"], 1);
    assert_eq!(saved_draft(&f, &old["id"]), old);
    let before = fs::metadata(f.root.join(".agents/skills/example/SKILL.md"))
        .unwrap()
        .modified()
        .unwrap();
    let applied = command(&f, json!(true)).unwrap();
    assert_eq!(applied["draftsArchived"], 1);
    let archived = saved_draft(&f, &old["id"]);
    assert_eq!(archived["status"], "dismissed");
    assert_eq!(archived["dismissalReason"], "superseded");
    assert_eq!(archived["supersededByRevision"], 3);
    assert_eq!(archived["resource"], old["resource"]);
    assert_eq!(archived["paths"], old["paths"]);
    assert_eq!(
        db::blob_read(archived["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap(),
        b"# Earlier retained skill\n"
    );
    assert_eq!(commands::snapshot().unwrap()["drafts"][0], archived);
    assert_eq!(
        fs::metadata(f.root.join(".agents/skills/example/SKILL.md"))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
    assert_eq!(command(&f, json!(true)).unwrap()["draftsArchived"], 0);
    assert!(f.outbox().is_empty());
}

#[test]
fn attention_reconciliation_preserves_queued_conflicting_and_unreviewed_work() {
    for blocker in [
        "queued",
        "conflict",
        "recovery",
        "pending",
        "proposed",
        "submission",
        "different",
        "missing",
        "unaccepted",
        "sharing-off",
        "detached",
    ] {
        let mut f = fixture();
        let (mut resource, binding) = skill(&f);
        let old = old_draft(&f, &resource);
        let id = resource["resourceId"].as_str().unwrap().to_string();
        match blocker {
            "queued" => indexer::queue(
                &f.db,
                f.project["id"].as_str().unwrap(),
                "/v2/sync/push",
                &json!({"id":uuid::Uuid::new_v4().to_string(),"resource":resource}),
            )
            .unwrap(),
            "conflict" => db::upsert(
                &f.db,
                "conflicts",
                "conflict",
                f.project["id"].as_str().unwrap(),
                &json!({"resourceId":id,"candidate":resource}),
            )
            .unwrap(),
            "recovery" => db::set(
                &f.db,
                &format!("installation:{id}"),
                &json!({"pending":true}),
            )
            .unwrap(),
            "pending" => db::set(
                &f.db,
                &format!("requests:{}", f.project["id"].as_str().unwrap()),
                &json!([{"resourceId":id,"status":"pending"}]),
            )
            .unwrap(),
            "proposed" => {
                let mut draft = old.clone();
                draft["id"] = json!("proposed");
                draft["status"] = json!("proposed");
                db::upsert(
                    &f.db,
                    "drafts",
                    "proposed",
                    f.project["id"].as_str().unwrap(),
                    &draft,
                )
                .unwrap();
            }
            "submission" => {
                let mut draft = old.clone();
                draft["submission"] = json!({"id":"retained-operation","resource":resource});
                db::upsert(
                    &f.db,
                    "drafts",
                    draft["id"].as_str().unwrap(),
                    f.project["id"].as_str().unwrap(),
                    &draft,
                )
                .unwrap();
            }
            "different" => fs::write(
                f.root.join(".claude/skills/example/SKILL.md"),
                "# Current private edits\n",
            )
            .unwrap(),
            "missing" => fs::remove_file(f.root.join(".claude/skills/example/SKILL.md")).unwrap(),
            "unaccepted" => {
                resource["revision"] = json!(0);
                db::upsert(
                    &f.db,
                    "resources",
                    &id,
                    f.project["id"].as_str().unwrap(),
                    &resource,
                )
                .unwrap();
            }
            "sharing-off" => f.project["sharing"] = json!({"skill":false}),
            "detached" => {
                let mut binding = binding;
                binding["paths"] = json!([f.root.join("another-skill")]);
                db::upsert(
                    &f.db,
                    "bindings",
                    &id,
                    f.project["id"].as_str().unwrap(),
                    &binding,
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        let result = attention::reconcile_project(&f.db, &f.project, true).unwrap();
        assert_eq!(result["draftsArchived"], 0, "{blocker}");
        assert_eq!(saved_draft(&f, &old["id"])["status"], "local", "{blocker}");
    }
}

#[test]
fn attention_restoring_superseded_bytes_revives_review_but_manual_dismissals_stay_dismissed() {
    for superseded in [true, false] {
        let f = fixture();
        let (resource, binding) = skill(&f);
        let mut previous = resource.clone();
        let old_bytes = b"# Restored earlier skill\n";
        previous["files"] = json!([{"path":"SKILL.md","hash":db::blob(old_bytes).unwrap(),"size":old_bytes.len(),"executable":false}]);
        let id = governance::capture(&f.db, &f.project, &previous, &binding["paths"]).unwrap();
        attention::reconcile_project(&f.db, &f.project, true).unwrap();
        if !superseded {
            let mut draft = saved_draft(&f, &json!(id));
            draft["dismissalReason"] = json!("user");
            db::upsert(
                &f.db,
                "drafts",
                &id,
                f.project["id"].as_str().unwrap(),
                &draft,
            )
            .unwrap();
        }
        for path in binding["paths"].as_array().unwrap() {
            fs::write(
                Path::new(path.as_str().unwrap()).join("SKILL.md"),
                old_bytes,
            )
            .unwrap();
        }
        let recaptured =
            governance::capture(&f.db, &f.project, &previous, &binding["paths"]).unwrap();
        assert_eq!(recaptured, id);
        let draft = saved_draft(&f, &json!(id));
        if superseded {
            assert_eq!(draft["status"], "local");
            assert!(draft["dismissalReason"].is_null());
            assert!(draft["archivedAt"].is_null());
            assert!(draft["supersededByRevision"].is_null());
            assert!(draft["submission"].is_null());
        } else {
            assert_eq!(draft["status"], "dismissed");
            assert_eq!(draft["dismissalReason"], "user");
        }
    }
}

#[test]
fn attention_reconciliation_adopts_identical_instructions_without_writing() {
    let f = fixture();
    let path = f.root.join("AGENTS.md");
    fs::write(&path, "# Existing local instructions\n").unwrap();
    let resource = json!({"resourceId":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],"kind":"memory","source":"shared","logicalPath":"instructions/AGENTS.md","title":"AGENTS.md","files":[packages::file(&path,"content.md").unwrap()],"revision":4,"deleted":false});
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
        &json!({"installationState":"review_pending","availableRevision":4}),
    )
    .unwrap();
    let before = fs::metadata(&path).unwrap().modified().unwrap();
    assert_eq!(
        command(&f, json!(false)).unwrap()["instructionsReconciled"],
        1
    );
    assert!(indexer::binding(&f.db, id).unwrap()["base"].is_null());
    sync::materialize(&f.db, &f.project, &resource).unwrap();
    let binding = indexer::binding(&f.db, id).unwrap();
    assert_eq!(binding["base"], resource);
    assert_eq!(binding["reviewedRevision"], 4);
    assert_eq!(binding["installationState"], "current");
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), before);
    assert_eq!(
        command(&f, json!(true)).unwrap()["instructionsReconciled"],
        0
    );
    fs::write(&path, "# New local instructions\n").unwrap();
    let mut updated = resource.clone();
    updated["revision"] = json!(5);
    sync::materialize(&f.db, &f.project, &updated).unwrap();
    assert_eq!(
        indexer::binding(&f.db, id).unwrap()["installationState"],
        "update_available"
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "# New local instructions\n"
    );
}

#[test]
fn attention_snapshot_preserves_partial_binding_and_queued_resource_identity() {
    let f = fixture();
    let resource = json!({"resourceId":"resource","projectId":f.project["id"],"kind":"plan","title":"Retained plan"});
    db::upsert(
        &f.db,
        "resources",
        "resource",
        f.project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    db::upsert(
        &f.db,
        "bindings",
        "resource",
        f.project["id"].as_str().unwrap(),
        &json!({"installationState":"review_pending"}),
    )
    .unwrap();
    indexer::queue(
        &f.db,
        f.project["id"].as_str().unwrap(),
        "/v2/sync/push",
        &json!({"id":"direct","resource":resource}),
    )
    .unwrap();
    indexer::queue(
        &f.db,
        f.project["id"].as_str().unwrap(),
        "/v2/sessions/resolve",
        &json!({"id":"reference","resourceId":"resource"}),
    )
    .unwrap();
    let snapshot = commands::snapshot().unwrap();
    assert_eq!(snapshot["bindings"][0]["resourceId"], "resource");
    assert_eq!(snapshot["bindings"][0]["projectId"], f.project["id"]);
    assert!(snapshot["bindings"][0]["base"].is_null());
    for queued in snapshot["outbox"].as_array().unwrap() {
        assert_eq!(queued["resourceId"], "resource");
        assert_eq!(queued["title"], "Retained plan");
        assert_eq!(queued["kind"], "plan");
    }
    assert!(command(&f, json!("apply")).is_err());
}

#[test]
fn attention_retry_is_scoped_to_the_selected_active_project() {
    let f = fixture();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    db::set(&f.db, "config", &json!({"apiUrl":"invalid-fixture-origin"})).unwrap();
    db::set(&f.db, "syncRequest", &json!("unrelated account request")).unwrap();
    db::set(
        &f.db,
        "syncHandledRequest",
        &json!("previous account request"),
    )
    .unwrap();
    let other = uuid::Uuid::new_v4().to_string();
    let other_root = f._home.path().join("other-project");
    let other_skill = other_root.join(".agents/skills/other");
    fs::create_dir_all(&other_skill).unwrap();
    fs::write(other_skill.join("SKILL.md"), "Unrelated skill").unwrap();
    db::upsert(
        &f.db,
        "projects",
        &other,
        &other,
        &json!({"id":other,"name":"Other project","path":other_root}),
    )
    .unwrap();
    for project in [f.project["id"].as_str().unwrap(), &other] {
        for (suffix, path, error) in [
            ("retry", "/v2/sync/push", "503: unavailable"),
            ("resolve", "/v2/sessions/resolve", "409: changed"),
            ("blocked", "/v2/sync/push", "409: exact version changed"),
        ] {
            f.db.execute(
                "INSERT INTO outbox VALUES(?,?,?,?,?)",
                rusqlite::params![
                    format!("{project}-{suffix}"),
                    project,
                    path,
                    json!({"id":format!("{project}-{suffix}"),"frozen":"Original operation bytes"})
                        .to_string(),
                    error
                ],
            )
            .unwrap();
        }
    }
    let foreign_before = db::rows(&f.db, "SELECT json_object('id',id,'value',value,'error',error) FROM outbox WHERE project=? ORDER BY id", &[&other]).unwrap();
    let terminal_before = db::rows(&f.db, "SELECT json_object('id',id,'value',value,'error',error) FROM outbox WHERE project=? AND error LIKE '409:%' ORDER BY id", &[&f.project["id"].as_str()]).unwrap();
    assert!(runtime
        .block_on(commands::retry_uploads(Some(
            f.project["id"].as_str().unwrap().into()
        )))
        .is_err());
    assert_eq!(
        db::get(
            &f.db,
            &format!("plugin-sync:{}", f.project["id"].as_str().unwrap())
        )
        .unwrap()["online"],
        false
    );
    assert!(db::get(&f.db, &format!("plugin-sync:{other}"))
        .unwrap()
        .is_null());
    assert!(db::get(&f.db, &format!("firstScan:{other}"))
        .unwrap()
        .is_null());
    assert!(f
        .resources()
        .iter()
        .all(|resource| resource["projectId"] != other));
    assert_eq!(
        db::get(&f.db, "syncRequest").unwrap(),
        "unrelated account request"
    );
    assert_eq!(
        db::get(&f.db, "syncHandledRequest").unwrap(),
        "previous account request"
    );
    assert_eq!(db::rows(&f.db,"SELECT json_object('id',id,'value',value,'error',error) FROM outbox WHERE project=? ORDER BY id",&[&other]).unwrap(),foreign_before);
    assert_eq!(db::rows(&f.db,"SELECT json_object('id',id,'value',value,'error',error) FROM outbox WHERE project=? AND error LIKE '409:%' ORDER BY id",&[&f.project["id"].as_str()]).unwrap(),terminal_before);
    let rows = db::rows(
        &f.db,
        "SELECT json_object('id',id,'project',project,'error',error) FROM outbox",
        &[],
    )
    .unwrap();
    assert_eq!(rows.len(), 6);
    assert_eq!(rows.iter().filter(|row| row["project"] == other).count(), 3);
    assert!(rows
        .iter()
        .filter(|row| row["project"] == other)
        .all(|row| row["error"].is_string()));
    assert!(rows
        .iter()
        .find(|row| row["id"] == format!("{}-retry", f.project["id"].as_str().unwrap()))
        .unwrap()["error"]
        .is_null());
    assert_eq!(
        rows.iter()
            .find(|row| row["id"] == format!("{}-blocked", f.project["id"].as_str().unwrap()))
            .unwrap()["error"],
        "409: exact version changed"
    );
    assert_eq!(
        rows.iter()
            .find(|row| row["id"] == format!("{}-resolve", f.project["id"].as_str().unwrap()))
            .unwrap()["error"],
        "409: changed"
    );
    assert!(runtime
        .block_on(commands::retry_uploads(Some("missing".into())))
        .is_err());
    runtime.block_on(commands::retry_uploads(None)).unwrap();
    assert_ne!(
        db::get(&f.db, "syncRequest").unwrap(),
        "unrelated account request"
    );
    assert_eq!(
        db::get(&f.db, "syncHandledRequest").unwrap(),
        "previous account request"
    );
}
