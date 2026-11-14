use super::*;

#[test]
fn menu_bar_only_counts_connected_active_projects_without_names_or_contents() {
    let f = Fixture::new();
    let mut project = f.project.clone();
    project["role"] = json!("member");
    project["localName"] = json!("My project");
    project["private"] = json!("Do not include project internals");
    db::upsert(
        &f.db,
        "projects",
        project["id"].as_str().unwrap(),
        "",
        &project,
    )
    .unwrap();
    f.db.execute(
        "UPDATE projects SET value=json_set(value,'$.localName','My project') WHERE id=?",
        [project["id"].as_str().unwrap()],
    )
    .unwrap();
    for (id, fields) in [
        ("remote", json!({"sources":[{"id":"remote-source"}]})),
        (
            "removed-source",
            json!({"sources":[{"id":"s","path":"/private","removedAt":db::now()}]}),
        ),
        ("hidden", json!({"hidden":true})),
        ("revoked", json!({"revoked":true})),
        ("archived", json!({"archivedAt":db::now()})),
        ("removed", json!({"removedAt":db::now()})),
    ] {
        let mut excluded = json!({"id":id,"name":id,"path":"/private"});
        excluded
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        db::upsert(&f.db, "projects", id, "", &excluded).unwrap();
    }
    db::upsert(&f.db, "projects", "connected", "", &json!({"id":"connected","name":"Shared name","localName":"Ignored owner name","role":"owner","sources":[{"id":"s","path":"/synthetic"}]})).unwrap();
    let result = crate::menu_bar::snapshot(&f.db, false).unwrap();
    assert_eq!(result["projectCount"], 2);
    assert!(result.get("projects").is_none());
    assert!(!result.to_string().contains("My project"));
    assert!(!result.to_string().contains("Shared name"));
    assert!(!result.to_string().contains("/private"));
    assert!(!result.to_string().contains("Do not include"));
    assert!(!result.to_string().contains("/synthetic"));
}

#[test]
fn menu_bar_reports_pending_changes_failures_and_account_status() {
    let f = Fixture::new();
    let id = f.project["id"].as_str().unwrap();
    f.db.execute("INSERT INTO outbox(id,project,path,value,error) VALUES('queued',?,'private-path','{}',NULL),('failed',?,'private-path','{}','Upload failed')", [id,id]).unwrap();
    db::upsert(
        &f.db,
        "conflicts",
        "conflict",
        id,
        &json!({"resourceId":"r"}),
    )
    .unwrap();
    f.db.execute(
        "INSERT INTO errors VALUES(?, 'Folder unavailable')",
        [format!("{id}:scan:source")],
    )
    .unwrap();
    db::set(
        &f.db,
        "sync",
        &json!({"online":false,"lastSync":"2026-11-14T10:00:00Z","error":"Offline"}),
    )
    .unwrap();
    let result = crate::menu_bar::snapshot(&f.db, false).unwrap();
    assert_eq!(result["pending"], 2);
    assert_eq!(result["issues"], 3);
    assert_eq!(result["sync"]["lastSync"], "2026-11-14T10:00:00Z");
    assert!(result.get("background").is_none());
    assert!(result.get("projects").is_none());
    assert_eq!(result["projectCount"], 1);
    assert_eq!(result["running"], false);
    assert!(result["progress"].is_null());
    assert!(!result.to_string().contains("private-path"));
    f.db.execute("DELETE FROM outbox", []).unwrap();
    f.db.execute("DELETE FROM conflicts", []).unwrap();
    f.db.execute("DELETE FROM errors", []).unwrap();
    assert_eq!(
        crate::menu_bar::snapshot(&f.db, false).unwrap()["issues"],
        1
    );
}

#[test]
fn menu_bar_cannot_invoke_workspace_or_credential_commands() {
    for command in ["menu_bar_snapshot", "menu_bar_action", "sync_now"] {
        assert!(crate::menu_bar::allows_command(command));
    }
    for command in [
        "background_agent",
        "snapshot",
        "sign_in",
        "switch_service",
        "env_command",
        "resource_command",
        "project_command",
        "resume_session",
    ] {
        assert!(!crate::menu_bar::allows_command(command));
    }
}

#[test]
fn menu_bar_keeps_account_history_issues_visible_after_successful_sync() {
    let f = Fixture::new();
    f.db.execute("INSERT INTO errors VALUES('history:unattributed:codex', 'Session needs project attribution')", []).unwrap();
    db::set(
        &f.db,
        "sync",
        &json!({"online":true,"lastSync":"2026-11-14T10:00:00Z"}),
    )
    .unwrap();
    let result = crate::menu_bar::snapshot(&f.db, false).unwrap();
    assert_eq!(result["issues"], 1);
    assert_eq!(result["projectCount"], 1);
    assert!(result["sync"]["error"].is_null());
    db::set(
        &f.db,
        "sync",
        &json!({"online":false,"error":"Session needs project attribution"}),
    )
    .unwrap();
    assert_eq!(
        crate::menu_bar::snapshot(&f.db, false).unwrap()["issues"],
        1
    );
}
