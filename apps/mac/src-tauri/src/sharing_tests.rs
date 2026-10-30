use super::*;
use crate::projects::{self, Sharing};

fn set_sharing(f: &mut Fixture, kinds: &[&str]) {
    f.project["sharing"] = json!(Sharing::default());
    for kind in kinds {
        f.project["sharing"][kind] = json!(true);
    }
    let id = f.project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", id, id, &f.project).unwrap();
}

fn seed(f: &Fixture) {
    fs::write(f.root.join("AGENTS.md"), "Private instructions").unwrap();
    fs::create_dir_all(f.root.join(".agents/skills/example")).unwrap();
    fs::write(
        f.root.join(".agents/skills/example/SKILL.md"),
        "# Example skill",
    )
    .unwrap();
    fs::create_dir_all(f.root.join(".codex/plans")).unwrap();
    fs::write(f.root.join(".codex/plans/feature.md"), "# File plan").unwrap();
    fs::write(f.root.join(".env"), "PRIVATE_KEY=never-upload").unwrap();
    let sessions = native::codex_home().unwrap().join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    fs::write(sessions.join(format!("rollout-{id}.jsonl")), native::encode(&[
        json!({"type":"session_meta","payload":{"id":id,"cwd":f.root,"cli_version":"0.159.2","source":"cli"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"Private conversation"}]}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"<proposed_plan># Session plan</proposed_plan>"}]}}),
    ])).unwrap();
}

#[test]
fn sharing_scan_only_collects_selected_categories_and_plans_without_sessions() {
    for kind in ["none", "memory", "skill", "session", "plan", "env"] {
        let mut f = Fixture::new();
        seed(&f);
        set_sharing(
            &mut f,
            if kind == "none" {
                &[]
            } else {
                std::slice::from_ref(&kind)
            },
        );
        indexer::scan(&f.db, &f.project).unwrap();
        let resources = f.resources();
        assert!(resources.iter().all(|r| r["kind"] == kind));
        assert_eq!(
            resources.len(),
            match kind {
                "none" | "env" => 0,
                "plan" => 2,
                _ => 1,
            }
        );
        assert_eq!(f.outbox().len(), resources.len());
        for entry in f.outbox() {
            assert!(!entry.to_string().contains("never-upload"));
            if kind == "plan" {
                assert_eq!(entry["resource"]["files"][0]["path"], "content.md");
                let content =
                    db::blob_read(entry["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap();
                assert!(!String::from_utf8(content)
                    .unwrap()
                    .contains("Private conversation"));
            }
        }
        assert_eq!(
            fs::read_to_string(f.root.join(".env")).unwrap(),
            "PRIVATE_KEY=never-upload"
        );
    }
}

#[test]
fn sharing_catalog_preserves_local_consent_and_defaults_new_macs_to_private() {
    let mut f = Fixture::new();
    set_sharing(&mut f, &["memory", "env"]);
    let new_id = uuid::Uuid::new_v4().to_string();
    projects::merge_catalog(
        &f.db,
        &json!([
            {"id":f.project["id"],"name":"Renamed","sharing":{"session":true}},
            {"id":new_id,"name":"New on this Mac","sharing":{"memory":true}}
        ]),
    )
    .unwrap();
    let projects = db::rows(&f.db, "SELECT value FROM projects", &[]).unwrap();
    let old = projects
        .iter()
        .find(|p| p["id"] == f.project["id"])
        .unwrap();
    assert_eq!(old["sharing"], f.project["sharing"]);
    assert_eq!(old["path"], f.project["path"]);
    let new = projects.iter().find(|p| p["id"] == new_id).unwrap();
    assert_eq!(new["sharing"], json!(Sharing::default()));
    assert!(!projects::sharing_allowed(new, "memory"));
    assert!(projects::sharing_allowed(
        &json!({"id":"legacy"}),
        "session"
    ));
    assert!(!projects::sharing_allowed(
        &json!({"sharing":{"memory":"true"}}),
        "memory"
    ));
    assert!(serde_json::from_value::<Sharing>(json!({"memory":true})).is_err());
}

#[test]
fn sharing_off_preserves_files_and_bindings_without_uploads_or_tombstones() {
    let mut f = Fixture::new();
    set_sharing(&mut f, &["memory"]);
    fs::write(f.root.join("AGENTS.md"), "# Original").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let resource = f.accept(&f.resources()[0]);
    set_sharing(&mut f, &[]);
    fs::write(f.root.join("AGENTS.md"), "# Private local edit").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    let mut incoming = resource.clone();
    incoming["revision"] = json!(2);
    incoming["deleted"] = json!(true);
    incoming["files"] = json!([]);
    sync::materialize(&f.db, &f.project, &incoming).unwrap();
    indexer::memory_index(&f.db, &f.project).unwrap();
    assert_eq!(
        fs::read_to_string(f.root.join("AGENTS.md")).unwrap(),
        "# Private local edit"
    );
    assert!(!f.root.join(".orka/memory/index.md").exists());
    fs::remove_file(f.root.join("AGENTS.md")).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    set_sharing(&mut f, &["memory"]);
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(f.outbox()[0]["resource"]["deleted"], true);
}

#[tokio::test]
async fn sharing_settings_persist_and_native_queue_rejects_unselected_kinds() {
    let mut f = Fixture::new();
    set_sharing(&mut f, &[]);
    let id = f.project["id"].as_str().unwrap();
    for (path, value) in [
        ("/v2/sync/push", json!({"resource":{"kind":"memory"}})),
        ("/v2/sessions/copy", json!({"resourceId":"session"})),
        (
            "/v2/sessions/resolve",
            json!({"resourceId":"session","action":"copy"}),
        ),
    ] {
        assert!(indexer::queue(&f.db, id, path, &value)
            .unwrap_err()
            .contains("Sharing"));
    }
    assert!(projects::require_sharing(&f.db, id, "env").is_err());
    let sharing = json!({"memory":true,"skill":false,"session":false,"plan":false,"env":true});
    projects::project_command("sharing".into(), json!({"projectId":id,"sharing":sharing}))
        .await
        .unwrap();
    let saved = db::rows(&f.db, "SELECT value FROM projects WHERE id=?", &[&id])
        .unwrap()
        .remove(0);
    assert_eq!(saved["sharing"], sharing);
    assert_eq!(
        projects::require_sharing(&f.db, id, "env").is_ok(),
        crate::env::enabled()
    );
    assert!(!projects::sharing_allowed(
        &saved,
        projects::queued_kind("/v2/sessions/copy", &json!({}))
    ));
    let request = json!({"id":uuid::Uuid::new_v4().to_string(),"resource":{"kind":"memory"}});
    indexer::queue(&f.db, id, "/v2/sync/push", &request).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert!(projects::project_command(
        "sharing".into(),
        json!({"projectId":id,"sharing":{"env":true}})
    )
    .await
    .is_err());
}
