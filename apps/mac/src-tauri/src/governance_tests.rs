use super::*;
use crate::governance;

fn governed_fixture() -> Fixture {
    let mut f = Fixture::new();
    f.project["governed"] = json!(true);
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    f
}
fn shared(f: &Fixture, kind: &str, path: &str, text: &str) -> Value {
    let id = uuid::Uuid::new_v4().to_string();
    json!({"resourceId":id,"kind":kind,"source":if kind=="memory"{"claude"}else{"shared"},"logicalPath":path,"title":"Shared fixture","files":[{"path":if kind=="skill"{"SKILL.md"}else{"content.md"},"hash":db::blob(text.as_bytes()).unwrap(),"size":text.len(),"executable":false}],"deleted":false,"projectId":f.project["id"],"owner":"teammate","updatedBy":"teammate","revision":1,"access":{"mode":"read"}})
}
fn persist(f: &Fixture, r: &Value) {
    db::upsert(
        &f.db,
        "resources",
        r["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        r,
    )
    .unwrap();
}
fn command(f: &Fixture, action: &str, input: Value) -> Result<Value, String> {
    let mut input = input;
    input["projectId"] = f.project["id"].clone();
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(governance::governance_command(action.into(), input))
}

#[test]
fn governed_personal_memory_stays_private_and_shared_memory_never_writes_native_store() {
    let f = governed_fixture();
    let personal = indexer::claude_memory(&f.root).unwrap();
    fs::create_dir_all(&personal).unwrap();
    fs::write(personal.join("MEMORY.md"), "My personal learning\n").unwrap();
    fs::write(f.root.join("AGENTS.md"), "Local instructions\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    assert!(f.resources().is_empty());
    let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
    assert_eq!(drafts.len(), 2);
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM drafts", &[])
            .unwrap()
            .len(),
        2
    );
    let r = shared(&f, "memory", "claude/MEMORY.md", "Team learning\n");
    persist(&f, &r);
    sync::materialize(&f.db, &f.project, &r).unwrap();
    indexer::memory_index(&f.db, &f.project).unwrap();
    assert_eq!(
        fs::read_to_string(personal.join("MEMORY.md")).unwrap(),
        "My personal learning\n"
    );
    let (context, _) = governance::context(&f.db, &f.project, &f.root).unwrap();
    assert!(context.contains("Team learning"));
    assert!(!context.contains("My personal learning"));
    fs::write(personal.join("MEMORY.md"), "New personal learning\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
}

#[test]
fn governed_skills_install_and_update_automatically_and_bind_conflict_review_to_current_files() {
    let f = governed_fixture();
    let mut r = shared(&f, "skill", "reviewed-skill", "Approved skill\n");
    persist(&f, &r);
    sync::materialize(&f.db, &f.project, &r).unwrap();
    let a = f.root.join(".agents/skills/reviewed-skill/SKILL.md");
    let b = f.root.join(".claude/skills/reviewed-skill/SKILL.md");
    assert_eq!(fs::read_to_string(&a).unwrap(), "Approved skill\n");
    assert_eq!(fs::read(&a).unwrap(), fs::read(&b).unwrap());
    let bytes = b"Approved update\n";
    r["revision"] = json!(2);
    r["files"][0]["hash"] = json!(db::blob(bytes).unwrap());
    r["files"][0]["size"] = json!(bytes.len());
    persist(&f, &r);
    sync::materialize(&f.db, &f.project, &r).unwrap();
    assert_eq!(fs::read_to_string(&a).unwrap(), "Approved update\n");
    let bytes = b"Approved replacement\n";
    r["revision"] = json!(3);
    r["files"][0]["hash"] = json!(db::blob(bytes).unwrap());
    r["files"][0]["size"] = json!(bytes.len());
    persist(&f, &r);
    let old = command(&f, "preview-install", json!({"resourceId":r["resourceId"]})).unwrap();
    fs::write(&a, "Private edits\n").unwrap();
    assert!(sync::materialize(&f.db, &f.project, &r).is_err());
    assert!(command(
        &f,
        "apply-install",
        json!({"resourceId":r["resourceId"],"token":old["token"],"preserveLocal":true})
    )
    .is_err());
    let fresh = command(&f, "preview-install", json!({"resourceId":r["resourceId"]})).unwrap();
    assert_eq!(fresh["dirty"], true);
    command(
        &f,
        "apply-install",
        json!({"resourceId":r["resourceId"],"token":fresh["token"],"preserveLocal":true}),
    )
    .unwrap();
    assert_eq!(fs::read(&a).unwrap(), bytes);
    assert_eq!(fs::read(&b).unwrap(), bytes);
    assert!(!db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .is_empty());
    fs::remove_dir_all(b.parent().unwrap()).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
}

#[test]
fn install_preview_identifies_binary_only_updates_without_confusing_literal_text() {
    let f = governed_fixture();
    let mut r = shared(&f, "skill", "binary-preview", "Unchanged instructions\n");
    let old_hash = db::blob(&[0xff, 0, 1]).unwrap();
    let new_hash = db::blob(&[0xff, 0, 2]).unwrap();
    r["files"].as_array_mut().unwrap().extend([
        json!({"path":"assets/reference.pdf","hash":old_hash,"size":3,"executable":false}),
        json!({"path":"literal.txt","hash":db::blob(b"Binary asset").unwrap(),"size":12,"executable":false}),
    ]);
    persist(&f, &r);
    sync::materialize(&f.db, &f.project, &r).unwrap();
    r["revision"] = json!(2);
    r["files"][1]["hash"] = json!(new_hash);
    persist(&f, &r);

    let preview = command(&f, "preview-install", json!({"resourceId":r["resourceId"]})).unwrap();
    // Text-only consumers previously saw an empty diff for these different bytes.
    assert_eq!(preview["before"], preview["after"]);
    let entry = |manifest: &Value, path: &str| {
        manifest
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["path"] == path)
            .unwrap()
            .clone()
    };
    let before = entry(&preview["beforeManifest"], "assets/reference.pdf");
    let after = entry(&preview["afterManifest"], "assets/reference.pdf");
    assert_eq!(before["hash"], old_hash);
    assert_eq!(after["hash"], new_hash);
    assert_eq!(before["binary"], true);
    assert_eq!(after["binary"], true);
    assert_eq!(after["size"], 3);
    assert_eq!(after["executable"], false);
    assert_eq!(
        entry(&preview["afterManifest"], "literal.txt")["binary"],
        false
    );
    assert_eq!(preview["copies"][0]["manifest"], preview["beforeManifest"]);
    assert_eq!(preview["dirty"], false);

    let id = governance::capture(&f.db, &f.project, &r, &json!([])).unwrap();
    let draft = command(&f, "draft", json!({"id":id})).unwrap();
    assert_eq!(draft["files"]["assets/reference.pdf"], "Binary asset");
    assert_eq!(
        entry(&draft["manifest"], "assets/reference.pdf")["binary"],
        true
    );
    assert_eq!(entry(&draft["manifest"], "literal.txt")["binary"], false);
}

#[test]
fn install_preview_uses_the_first_existing_copy_and_empty_manifest_for_removal() {
    let f = governed_fixture();
    let mut r = shared(&f, "skill", "remaining-copy", "Installed instructions\n");
    persist(&f, &r);
    sync::materialize(&f.db, &f.project, &r).unwrap();
    fs::remove_dir_all(f.root.join(".agents/skills/remaining-copy")).unwrap();

    let preview = command(&f, "preview-install", json!({"resourceId":r["resourceId"]})).unwrap();
    assert_eq!(preview["copies"][0]["files"], json!({}));
    assert_eq!(preview["copies"][0]["manifest"], json!([]));
    assert_eq!(preview["before"]["SKILL.md"], "Installed instructions\n");
    assert_eq!(preview["beforeManifest"], preview["copies"][1]["manifest"]);

    // A tombstone can retain its old files; removal still has no proposed content.
    r["deleted"] = json!(true);
    r["revision"] = json!(2);
    persist(&f, &r);
    let removed = command(&f, "preview-install", json!({"resourceId":r["resourceId"]})).unwrap();
    assert_eq!(removed["beforeManifest"], preview["beforeManifest"]);
    assert_eq!(removed["after"], json!({}));
    assert_eq!(removed["afterManifest"], json!([]));
}

#[test]
fn submit_draft_rejects_unreviewed_local_or_shared_changes_before_side_effects() {
    let f = governed_fixture();
    let mut r = shared(&f, "skill", "guarded-review", "Reviewed content\n");
    persist(&f, &r);
    let id = governance::capture(&f.db, &f.project, &r, &json!([])).unwrap();
    let reviewed_files = r["files"].clone();
    let reviewed_revision = r["revision"].clone();
    let mut draft = command(&f, "draft", json!({"id":id})).unwrap()["draft"].clone();
    draft["resource"]["files"][0]["hash"] = json!(db::blob(b"New local content\n").unwrap());
    db::upsert(
        &f.db,
        "drafts",
        &id,
        f.project["id"].as_str().unwrap(),
        &draft,
    )
    .unwrap();
    let error = "Local or shared files changed; review the update again";
    for publish in [false, true] {
        assert_eq!(
            command(&f, "submit-draft", json!({"id":id,"publishIfAllowed":publish,"reviewedFiles":reviewed_files,"reviewedRevision":reviewed_revision})).unwrap_err(),
            error
        );
        assert_eq!(
            command(&f, "draft", json!({"id":id})).unwrap()["draft"],
            draft
        );
        assert!(f.outbox().is_empty());
    }

    r["revision"] = json!(2);
    persist(&f, &r);
    for publish in [false, true] {
        assert_eq!(
            command(&f, "submit-draft", json!({"id":id,"publishIfAllowed":publish,"reviewedFiles":draft["resource"]["files"],"reviewedRevision":reviewed_revision})).unwrap_err(),
            error
        );
        assert_eq!(
            command(&f, "draft", json!({"id":id})).unwrap()["draft"],
            draft
        );
        assert!(f.outbox().is_empty());
    }
}

#[test]
fn submit_draft_accepts_matching_review_and_preserves_unguarded_callers() {
    for (guarded, shared_revision) in [(true, 0), (true, 1), (false, 1)] {
        let f = governed_fixture();
        let r = shared(&f, "skill", "guarded-publish", "Reviewed content\n");
        if shared_revision > 0 {
            persist(&f, &r);
        }
        let id = governance::capture(&f.db, &f.project, &r, &json!([])).unwrap();
        let mut input = json!({"id":id,"publishIfAllowed":true});
        if guarded {
            input["reviewedFiles"] = r["files"].clone();
            input["reviewedRevision"] = json!(shared_revision);
        }
        assert_eq!(
            command(&f, "submit-draft", input.clone()).unwrap()["status"],
            "queued"
        );
        let queued = f.outbox();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0]["resource"]["files"], r["files"]);
        assert_eq!(queued[0]["baseRevision"], shared_revision);
        assert_eq!(
            command(&f, "submit-draft", input).unwrap()["status"],
            "queued"
        );
        assert_eq!(f.outbox(), queued);
    }
}

#[test]
fn submit_draft_rejects_a_cached_submission_that_differs_from_the_review() {
    let f = governed_fixture();
    let r = shared(&f, "skill", "cached-review", "Reviewed content\n");
    persist(&f, &r);
    let id = governance::capture(&f.db, &f.project, &r, &json!([])).unwrap();
    let mut draft = command(&f, "draft", json!({"id":id})).unwrap()["draft"].clone();
    draft["submission"] = json!({"resource":r,"baseRevision":1});
    draft["submission"]["resource"]["files"][0]["hash"] =
        json!(db::blob(b"Old submitted bytes\n").unwrap());
    for mismatch in ["files", "revision"] {
        if mismatch == "revision" {
            draft["submission"]["resource"]["files"] = r["files"].clone();
            draft["submission"]["baseRevision"] = json!(0);
        }
        db::upsert(
            &f.db,
            "drafts",
            &id,
            f.project["id"].as_str().unwrap(),
            &draft,
        )
        .unwrap();
        for publish in [false, true] {
            assert_eq!(
                command(&f, "submit-draft", json!({"id":id,"publishIfAllowed":publish,"reviewedFiles":r["files"],"reviewedRevision":1})).unwrap_err(),
                "Local or shared files changed; review the update again"
            );
            assert_eq!(
                command(&f, "draft", json!({"id":id})).unwrap()["draft"],
                draft
            );
            assert!(f.outbox().is_empty());
        }
    }
}

#[test]
fn governed_skill_auto_install_respects_sharing_access_and_folder_identity() {
    let mut f = governed_fixture();
    let mut r = shared(&f, "skill", "automatic", "Shared skill\n");
    persist(&f, &r);
    let path = f.root.join(".agents/skills/automatic/SKILL.md");
    f.project["sharing"] = json!({"skill":false});
    sync::materialize(&f.db, &f.project, &r).unwrap();
    assert!(!path.exists());
    f.project["sharing"] = json!({"skill":true});
    r["access"]["mode"] = json!("hidden");
    assert!(sync::materialize(&f.db, &f.project, &r)
        .unwrap_err()
        .contains("access denied"));
    assert!(!path.exists());
    r["access"]["mode"] = json!("read");
    f.project["folderIdentity"] = json!("replaced");
    assert!(sync::materialize(&f.db, &f.project, &r)
        .unwrap_err()
        .contains("folder changed"));
    assert!(!path.exists());
    f.project["folderIdentity"] = json!(indexer::folder_identity(&f.root).unwrap());
    // Upgrade an old pending installation without another user action.
    db::upsert(
        &f.db,
        "bindings",
        r["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &json!({"availableRevision":1,"installationState":"review_pending","paths":[f.root.join(".claude/skills/automatic"),f.root.join(".agents/skills/automatic")]}),
    )
    .unwrap();
    sync::materialize(&f.db, &f.project, &r).unwrap();
    assert_eq!(fs::read_to_string(path).unwrap(), "Shared skill\n");
    assert_eq!(
        indexer::binding(&f.db, r["resourceId"].as_str().unwrap()).unwrap()["installationState"],
        "current"
    );
}

#[test]
fn governed_skill_auto_install_never_overwrites_an_untracked_or_divergent_copy() {
    for second_copy in [false, true] {
        let f = governed_fixture();
        let r = shared(&f, "skill", "automatic", "Shared skill\n");
        persist(&f, &r);
        let a = f.root.join(".agents/skills/automatic");
        let b = f.root.join(".claude/skills/automatic");
        fs::create_dir_all(&a).unwrap();
        fs::write(
            a.join("SKILL.md"),
            if second_copy {
                "Shared skill\n"
            } else {
                "Private local skill\n"
            },
        )
        .unwrap();
        if second_copy {
            fs::create_dir_all(&b).unwrap();
            fs::write(b.join("SKILL.md"), "Private second copy\n").unwrap();
        }
        let before = fs::read(a.join("SKILL.md")).unwrap();
        assert!(sync::materialize(&f.db, &f.project, &r)
            .unwrap_err()
            .contains("Local skill edits preserved"));
        assert_eq!(fs::read(a.join("SKILL.md")).unwrap(), before);
        if second_copy {
            assert_eq!(
                fs::read_to_string(b.join("SKILL.md")).unwrap(),
                "Private second copy\n"
            );
        } else {
            assert!(!b.exists());
        }
        assert_eq!(
            indexer::binding(&f.db, r["resourceId"].as_str().unwrap()).unwrap()
                ["installationState"],
            "locally_modified"
        );
    }
}

#[test]
fn governed_skill_clean_deletions_apply_automatically() {
    let f = governed_fixture();
    let mut r = shared(&f, "skill", "automatic", "Shared skill\n");
    persist(&f, &r);
    sync::materialize(&f.db, &f.project, &r).unwrap();
    r["revision"] = json!(2);
    r["files"] = json!([]);
    r["deleted"] = json!(true);
    persist(&f, &r);
    sync::materialize(&f.db, &f.project, &r).unwrap();
    for folder in [".agents", ".claude"] {
        assert!(!f.root.join(folder).join("skills/automatic").exists());
    }
}

#[test]
fn governed_skill_auto_install_rejects_symlinked_parents_and_preserves_instruction_review() {
    let f = governed_fixture();
    let skill = shared(&f, "skill", "automatic", "Shared skill\n");
    persist(&f, &skill);
    let outside = f._home.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, f.root.join(".agents")).unwrap();
    assert!(sync::materialize(&f.db, &f.project, &skill)
        .unwrap_err()
        .contains("symlink"));
    assert!(!outside.join("skills").exists());
    assert!(!f.root.join(".claude/skills/automatic").exists());
    let mut instructions = shared(
        &f,
        "memory",
        "instructions/AGENTS.md",
        "Shared instructions\n",
    );
    instructions["source"] = json!("shared");
    persist(&f, &instructions);
    sync::materialize(&f.db, &f.project, &instructions).unwrap();
    assert!(!f.root.join("AGENTS.md").exists());
    assert_eq!(
        indexer::binding(&f.db, instructions["resourceId"].as_str().unwrap()).unwrap()
            ["installationState"],
        "review_pending"
    );
}

#[test]
fn governed_revocation_removes_imported_context_and_preserves_dirty_work_privately() {
    let f = governed_fixture();
    let r = shared(&f, "skill", "revoked-skill", "Shared skill\n");
    persist(&f, &r);
    let preview = command(&f, "preview-install", json!({"resourceId":r["resourceId"]})).unwrap();
    command(
        &f,
        "apply-install",
        json!({"resourceId":r["resourceId"],"token":preview["token"],"preserveLocal":true}),
    )
    .unwrap();
    let directory = f.root.join(".agents/skills/revoked-skill");
    fs::write(directory.join("SKILL.md"), "Keep my edits\n").unwrap();
    governance::reset(&f.db, f.project["id"].as_str().unwrap(), &json!([])).unwrap();
    assert!(!directory.exists());
    assert!(f.resources().is_empty());
    let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
    assert_eq!(drafts.len(), 1);
    assert_eq!(
        db::blob_read(drafts[0]["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap(),
        b"Keep my edits\n"
    );
}

#[test]
fn governed_catalog_revocation_preserves_drafts_and_retries_inactive_cleanup() {
    let mut f = governed_fixture();
    let r = shared(&f, "memory", "claude/revoked.md", "Shared knowledge\n");
    persist(&f, &r);
    sync::materialize(&f.db, &f.project, &r).unwrap();
    let id = f.project["id"].as_str().unwrap().to_string();
    let path = f
        .root
        .join(".orka/memory/resources")
        .join(r["resourceId"].as_str().unwrap())
        .join("content.md");
    fs::write(&path, "Keep my private edits\n").unwrap();
    governance::context(&f.db, &f.project, &f.root).unwrap();
    f.db.execute("INSERT INTO cursors VALUES(?,?)", rusqlite::params![id, 42])
        .unwrap();
    for prefix in ["governance", "requests", "policyRevision", "presence"] {
        db::set(&f.db, &format!("{prefix}:{id}"), &json!(42)).unwrap();
    }
    f.project["archivedAt"] = json!("2026-10-18T00:00:00Z");
    db::upsert(&f.db, "projects", &id, &id, &f.project).unwrap();
    f.db.execute_batch("CREATE TRIGGER fail_draft BEFORE INSERT ON drafts BEGIN SELECT RAISE(ABORT,'injected draft persistence failure'); END;").unwrap();

    let error = crate::projects::merge_catalog(&f.db, &json!([])).unwrap_err();
    assert!(
        error.contains("injected draft persistence failure"),
        "{error}"
    );
    assert!(f.db.is_autocommit());
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM projects WHERE id=?", &[&id]).unwrap()[0]["revoked"],
        true
    );
    assert!(governance::project(&f.db, &id).is_err());
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "Keep my private edits\n"
    );
    assert_eq!(f.resources().len(), 1);
    assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .is_empty());

    f.db.execute_batch("DROP TRIGGER fail_draft").unwrap();
    crate::projects::merge_catalog(&f.db, &json!([])).unwrap();
    assert!(!path.exists());
    assert!(f.resources().is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM bindings", &[])
        .unwrap()
        .is_empty());
    let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
    assert_eq!(drafts.len(), 1);
    assert_eq!(
        db::blob_read(drafts[0]["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap(),
        b"Keep my private edits\n"
    );
    assert_eq!(
        f.db.query_row(
            "SELECT count(*) FROM cursors WHERE project=?",
            [&id],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    for prefix in [
        "governance",
        "requests",
        "policyRevision",
        "presence",
        "exposedSources",
        "contextToken",
    ] {
        assert!(db::get(&f.db, &format!("{prefix}:{id}")).unwrap().is_null());
    }
    crate::projects::merge_catalog(&f.db, &json!([])).unwrap();
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM drafts", &[])
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn governed_catalog_revocation_for_detached_project_preserves_unmanaged_handoff_files() {
    let f = governed_fixture();
    let id = f.project["id"].as_str().unwrap();
    let source = uuid::Uuid::new_v4().to_string();
    let path = f.root.join(".orka/handoffs/detached.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "Detached local work\n").unwrap();
    let key = format!("handoff:{id}:test");
    db::set(
        &f.db,
        &key,
        &json!({"path":path,"sources":[source],"hash":db::digest(b"Original content\n")}),
    )
    .unwrap();
    db::set(
        &f.db,
        &format!("pendingHandoffSources:{id}"),
        &json!([source]),
    )
    .unwrap();
    crate::projects::remove_local(&f.db, id).unwrap();

    crate::projects::merge_catalog(&f.db, &json!([])).unwrap();
    assert!(crate::projects::active(&f.db, id).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "Detached local work\n");
    assert!(db::get(&f.db, &key).unwrap().is_null());
    assert_eq!(
        db::get(&f.db, &format!("pendingHandoffSources:{id}")).unwrap(),
        json!([])
    );
    crate::projects::merge_catalog(&f.db, &json!([])).unwrap();
}

#[test]
fn governed_reset_preserves_visible_dirty_knowledge_and_starts_a_fresh_context_epoch() {
    let f = governed_fixture();
    let r = shared(
        &f,
        "memory",
        "claude/topic.md",
        "Accepted scoped knowledge\n",
    );
    persist(&f, &r);
    sync::materialize(&f.db, &f.project, &r).unwrap();
    command(&f, "context", json!({})).unwrap();
    let old=command(&f,"save-candidate",json!({"topic":"Derived learning","content":"Derived from the shared fact","provider":"codex"})).unwrap();
    let saved = command(&f, "draft", json!({"id":old["id"]})).unwrap();
    assert_eq!(
        saved["draft"]["resource"]["contextSources"],
        json!([r["resourceId"]])
    );
    let path = f
        .root
        .join(".orka/memory/resources")
        .join(r["resourceId"].as_str().unwrap())
        .join("content.md");
    fs::write(&path, "Private dirty learning\n").unwrap();
    governance::reset(
        &f.db,
        f.project["id"].as_str().unwrap(),
        &json!([{"resource":r}]),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "Private dirty learning\n"
    );
    indexer::memory_index(&f.db, &f.project).unwrap();
    assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .iter()
        .any(
            |d| db::blob_read(d["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap()
                == b"Private dirty learning\n"
        ));
    governance::reset(&f.db, f.project["id"].as_str().unwrap(), &json!([])).unwrap();
    let fresh = command(
        &f,
        "save-candidate",
        json!({"topic":"Independent learning","content":"New unrelated fact","provider":"codex"}),
    )
    .unwrap();
    let fresh = command(&f, "draft", json!({"id":fresh["id"]})).unwrap();
    assert!(fresh["draft"]["resource"]["contextSources"].is_null());
    let saved = command(&f, "draft", json!({"id":old["id"]})).unwrap();
    assert_eq!(
        saved["draft"]["resource"]["contextSources"],
        json!([r["resourceId"]])
    );
}

#[test]
fn installed_skills_are_known_context_sources_and_failed_installation_preflights_both_mirrors() {
    let f = governed_fixture();
    let r = shared(
        &f,
        "skill",
        "context-skill",
        "Shared executable instructions\n",
    );
    persist(&f, &r);
    let preview = command(&f, "preview-install", json!({"resourceId":r["resourceId"]})).unwrap();
    command(
        &f,
        "apply-install",
        json!({"resourceId":r["resourceId"],"token":preview["token"],"preserveLocal":true}),
    )
    .unwrap();
    let (_, sources) = governance::context(&f.db, &f.project, &f.root).unwrap();
    assert!(sources.contains(&r["resourceId"]));
    let a = f.root.join(".agents/skills/context-skill");
    let b = f.root.join(".claude/skills/context-skill");
    fs::write(b.join(".env"), "LOCAL_SYNTHETIC=value").unwrap();
    assert!(packages::install_mirrors(
        &f.db,
        &f.project,
        r["resourceId"].as_str().unwrap(),
        &[a.clone(), b],
        r["files"].as_array().unwrap()
    )
    .is_err());
    assert_eq!(
        fs::read_to_string(a.join("SKILL.md")).unwrap(),
        "Shared executable instructions\n"
    );
}

#[test]
fn session_end_keeps_sources_for_embedded_and_referenced_plans_before_upload() {
    let f = governed_fixture();
    let r = shared(
        &f,
        "memory",
        "claude/runtime.md",
        "Restricted runtime knowledge\n",
    );
    persist(&f, &r);
    sync::materialize(&f.db, &f.project, &r).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let response = native::hook(
        "claude",
        json!({"cwd":f.root,"hook_event_name":"SessionStart","session_id":id}),
    )
    .unwrap();
    let content = response["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap();
    assert!(content.contains(f.project["id"].as_str().unwrap()));
    assert!(content.contains(&format!(
        "--profile {} --orka-context",
        json!(crate::profiles::current())
    )));
    assert!(content.contains("\"action\":\"request\""));
    assert!(content.contains("\"action\":\"resource\""));
    assert!(content.contains(&id));
    let selected = native::hook(
        "claude",
        json!({"cwd":f.root,"hook_event_name":"UserPromptSubmit","session_id":id,"prompt":"Restricted runtime knowledge"}),
    ).unwrap();
    assert!(selected
        .to_string()
        .contains("Restricted runtime knowledge"));
    native::hook(
        "claude",
        json!({"cwd":f.root,"hook_event_name":"SessionEnd","session_id":id}),
    )
    .unwrap();
    governance::reset(&f.db, f.project["id"].as_str().unwrap(), &json!([])).unwrap();
    let plans = f.root.join(".claude/plans");
    fs::create_dir_all(&plans).unwrap();
    let path = plans.join("derived.md");
    fs::write(
        &path,
        "# Derived plan\nUses restricted runtime knowledge.\n",
    )
    .unwrap();
    let sessions = native::claude_home().unwrap().join("projects/synthetic");
    fs::create_dir_all(&sessions).unwrap();
    let records = vec![
        json!({"type":"user","cwd":f.root,"sessionId":id,"version":"2.1.286","message":{"role":"user","content":"Plan the feature"}}),
        json!({"type":"assistant","cwd":f.root,"sessionId":id,"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":path,"content":"# Derived plan"}},{"type":"tool_use","name":"ExitPlanMode","input":{"plan":"# Embedded derived plan"}}]}}),
    ];
    fs::write(
        sessions.join(format!("{id}.jsonl")),
        native::encode(&records),
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let queued = f.outbox();
    let plan = queued
        .iter()
        .find(|q| q["resource"]["kind"] == "plan")
        .unwrap();
    assert_eq!(plan["resource"]["contextSources"], json!([r["resourceId"]]));
    let candidate=command(&f,"save-candidate",json!({"topic":"Still from that session","content":"Derived fact","provider":"claude","sessionId":id})).unwrap();
    let candidate = command(&f, "draft", json!({"id":candidate["id"]})).unwrap();
    assert_eq!(
        candidate["draft"]["resource"]["contextSources"],
        json!([r["resourceId"]])
    );
}

#[test]
fn reviewed_skill_removal_preserves_local_edits_and_legacy_cache_detaches() {
    let f = governed_fixture();
    let mut r = shared(&f, "skill", "removed-skill", "Accepted skill\n");
    persist(&f, &r);
    let preview = command(&f, "preview-install", json!({"resourceId":r["resourceId"]})).unwrap();
    command(
        &f,
        "apply-install",
        json!({"resourceId":r["resourceId"],"token":preview["token"],"preserveLocal":true}),
    )
    .unwrap();
    let a = f.root.join(".agents/skills/removed-skill/SKILL.md");
    fs::write(&a, "Private edits before removal\n").unwrap();
    r["deleted"] = json!(true);
    r["files"] = json!([]);
    r["revision"] = json!(2);
    persist(&f, &r);
    assert!(sync::materialize(&f.db, &f.project, &r)
        .unwrap_err()
        .contains("Local skill edits preserved"));
    assert!(a.exists());
    let preview = command(&f, "preview-install", json!({"resourceId":r["resourceId"]})).unwrap();
    assert!(preview["before"]["SKILL.md"]
        .as_str()
        .unwrap()
        .contains("Private edits"));
    command(
        &f,
        "apply-install",
        json!({"resourceId":r["resourceId"],"token":preview["token"],"preserveLocal":true}),
    )
    .unwrap();
    assert!(!a.exists());
    assert!(!f.root.join(".claude/skills/removed-skill").exists());
    assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .iter()
        .any(
            |d| db::blob_read(d["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap()
                == b"Private edits before removal\n"
        ));
    let memory = shared(&f, "memory", "claude/old.md", "Accepted memory\n");
    persist(&f, &memory);
    let old = f.root.join(".orka/memory/claude/old.md");
    fs::create_dir_all(old.parent().unwrap()).unwrap();
    fs::write(&old, "Private old cache edits\n").unwrap();
    indexer::memory_index(&f.db, &f.project).unwrap();
    assert!(!old.exists());
    assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .iter()
        .any(
            |d| db::blob_read(d["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap()
                == b"Private old cache edits\n"
        ));
}

#[test]
fn private_candidates_deduplicate_and_scoped_supersession_keeps_other_contexts() {
    let f = governed_fixture();
    let mut old = shared(
        &f,
        "memory",
        "claude/old-runtime.md",
        "API runtime uses Node 22\n",
    );
    old["memory"] =
        json!({"topic":"Runtime","scope":"services/api","provider":"claude","supersedes":[]});
    persist(&f, &old);
    let mut other = shared(
        &f,
        "memory",
        "claude/legacy-runtime.md",
        "Legacy worker uses Node 22\n",
    );
    other["memory"] =
        json!({"topic":"Runtime","scope":"services/worker","provider":"claude","supersedes":[]});
    persist(&f, &other);
    let mut new = shared(
        &f,
        "memory",
        "claude/new-runtime.md",
        "API runtime uses Node 24\n",
    );
    new["memory"] = json!({"topic":"Runtime","scope":"services/api","provider":"manual","supersedes":[old["resourceId"]]});
    persist(&f, &new);
    let (context, _) =
        governance::context(&f.db, &f.project, &f.root.join("services/api")).unwrap();
    assert!(context.contains("API runtime uses Node 24"));
    assert!(!context.contains("API runtime uses Node 22"));
    assert!(!context.contains("Legacy worker"));
    let (context, _) =
        governance::context(&f.db, &f.project, &f.root.join("services/worker")).unwrap();
    assert!(context.contains("Legacy worker"));
    assert!(!context.contains("API runtime"));
    let input = json!({"topic":"Same fact with a different topic","scope":"services/api","provider":"manual","content":"API runtime uses Node 24\n"});
    let a = command(&f, "save-candidate", input.clone()).unwrap();
    let b = command(&f, "save-candidate", input).unwrap();
    assert_eq!(a["id"], b["id"]);
    let detail = command(&f, "draft", json!({"id":a["id"]})).unwrap();
    assert!(detail["related"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["duplicate"] == true && r["resource"]["resourceId"] == new["resourceId"]));
    command(&f, "dismiss", json!({"id":a["id"]})).unwrap();
    assert!(command(&f, "drafts", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn governed_bundles_remain_private_and_handoffs_keep_source_audiences() {
    let f = governed_fixture();
    let r = shared(&f, "skill", "bundle-skill", "Governed skill\n");
    persist(&f, &r);
    let bundle = f.root.join("synthetic.zip");
    bundles::export(&f.db, r["resourceId"].as_str().unwrap(), &bundle).unwrap();
    bundles::import(&f.db, f.project["id"].as_str().unwrap(), &bundle).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM drafts", &[])
            .unwrap()
            .len(),
        1
    );
    let other = uuid::Uuid::new_v4().to_string();
    let mut p = f.project.clone();
    p["id"] = json!(other);
    p["path"] = Value::Null;
    db::upsert(&f.db, "projects", &other, "", &p).unwrap();
    assert!(bundles::import(&f.db, &other, &bundle)
        .unwrap_err()
        .contains("source audience"));
    let handoff = f
        .root
        .join(".orka/handoffs")
        .join(format!("{}.md", r["resourceId"].as_str().unwrap()));
    fs::create_dir_all(handoff.parent().unwrap()).unwrap();
    fs::write(&handoff, "Synthetic exported source\n").unwrap();
    native::record_handoff(&f.db, &f.project, &r, &handoff).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    native::hook(
        "claude",
        json!({"cwd":f.root,"session_id":id,"hook_event_name":"SessionStart"}),
    )
    .unwrap();
    assert!(
        native::session_sources(&f.db, f.project["id"].as_str().unwrap(), &id)
            .unwrap()
            .as_array()
            .unwrap()
            .contains(&r["resourceId"])
    );
    let records =
        vec![json!({"message":{"content":format!("Continue from {}",handoff.display())}})];
    native::bind_handoff(&f.db, f.project["id"].as_str().unwrap(), &id, &records).unwrap();
    assert!(db::get(
        &f.db,
        &format!(
            "pendingHandoffSources:{}",
            f.project["id"].as_str().unwrap()
        )
    )
    .unwrap()
    .as_array()
    .unwrap()
    .is_empty());
    governance::reset(&f.db, f.project["id"].as_str().unwrap(), &json!([])).unwrap();
    assert!(!handoff.exists());
    assert!(
        native::session_sources(&f.db, f.project["id"].as_str().unwrap(), &id)
            .unwrap()
            .as_array()
            .unwrap()
            .contains(&r["resourceId"])
    );
}

#[test]
fn governed_read_operations_remain_available_during_workspace_sync() {
    let f = governed_fixture();
    let _sync_lock = crate::projects::lock().unwrap();
    assert!(command(&f, "drafts", json!({})).unwrap().is_array());
    let error = command(
        &f,
        "save-candidate",
        json!({"topic":"Synthetic", "content":"Local candidate"}),
    )
    .unwrap_err();
    assert!(error.contains("operation is in progress"));
}
