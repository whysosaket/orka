use super::*;
use crate::sources;

fn multi_source(f: &Fixture) -> Value {
    let backend = f.root.parent().unwrap().join("backend");
    fs::create_dir(&backend).unwrap();
    let mut project = f.project.clone();
    project.as_object_mut().unwrap().remove("path");
    project["sources"] = json!([
        {"id":uuid::Uuid::new_v4().to_string(),"name":"desktop","path":f.root,"folderIdentity":indexer::folder_identity(&f.root).unwrap()},
        {"id":uuid::Uuid::new_v4().to_string(),"name":"backend","path":backend,"folderIdentity":indexer::folder_identity(&backend).unwrap()}
    ]);
    project
}

#[test]
fn global_skill_publication_adopts_the_selected_repository_in_a_multi_source_project() {
    let f = Fixture::new();
    let mut project = multi_source(&f);
    project["governed"] = json!(true);
    let project_id = project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", project_id, "", &project).unwrap();
    let global = f._home.path().join(".codex/skills/example");
    fs::create_dir_all(&global).unwrap();
    fs::write(
        global.join("SKILL.md"),
        "---\nname: example\ndescription: Example\n---\n# Example\n",
    )
    .unwrap();
    for source in sources::views(&project) {
        let scan = crate::global_skills::scan(&f.db, &source).unwrap();
        let id = &scan.skills[0].id;
        crate::global_skills::add(&f.db, &source, id).unwrap();
        let value = f
            .outbox()
            .into_iter()
            .find(|item| item["resource"]["sourceId"] == source["sourceId"])
            .unwrap();
        let queued = json!({"project":project_id,"id":value["id"],"value":value});
        let mut resource = queued["value"]["resource"].clone();
        resource["projectId"] = json!(project_id);
        resource["updatedBy"] = db::get(&f.db, "user").unwrap();
        resource["revision"] = json!(1);
        crate::global_skills::complete_share(
            &f.db,
            &queued,
            &json!({"event":{"resource":resource,"conflicts":[]}}),
        )
        .unwrap();
        let binding = indexer::binding(&f.db, resource["resourceId"].as_str().unwrap()).unwrap();
        assert_eq!(binding["installationState"], "current");
        assert_eq!(binding["reviewedRevision"], 1);
        assert!(binding["paths"]
            .as_array()
            .unwrap()
            .iter()
            .all(|path| PathBuf::from(path.as_str().unwrap())
                .starts_with(source["path"].as_str().unwrap())));
        assert_eq!(binding["base"]["sourceId"], source["sourceId"]);
    }
}

#[test]
fn scans_and_materializes_identical_paths_in_independent_sources() {
    let f = Fixture::new();
    let project = multi_source(&f);
    let views = sources::views(&project);
    for source in &views {
        fs::write(
            PathBuf::from(source["path"].as_str().unwrap()).join("AGENTS.md"),
            source["sourceId"].as_str().unwrap(),
        )
        .unwrap();
    }
    indexer::scan(&f.db, &project).unwrap();
    let resources = f.resources();
    assert_eq!(resources.len(), 2);
    assert_ne!(resources[0]["resourceId"], resources[1]["resourceId"]);
    assert_ne!(resources[0]["sourceId"], resources[1]["sourceId"]);
    assert!(f
        .outbox()
        .iter()
        .all(|queued| queued["resource"]["sourceId"].is_string()));
    f.db.execute("DELETE FROM outbox", []).unwrap();
    for mut resource in resources {
        let source = sources::for_resource(&project, &resource).unwrap();
        let root = PathBuf::from(source["path"].as_str().unwrap());
        let text = format!("Remote {}\n", resource["sourceId"].as_str().unwrap());
        resource["files"] = json!([{"path":"content.md","hash":db::blob(text.as_bytes()).unwrap(),"size":text.len(),"executable":false}]);
        resource["revision"] = json!(1);
        f.db.execute(
            "DELETE FROM bindings WHERE id=?",
            [resource["resourceId"].as_str().unwrap()],
        )
        .unwrap();
        fs::remove_file(root.join("AGENTS.md")).unwrap();
        sync::materialize(&f.db, &project, &resource).unwrap();
        assert_eq!(fs::read_to_string(root.join("AGENTS.md")).unwrap(), text);
    }
}

#[test]
fn an_unavailable_source_does_not_block_another_or_receive_writes() {
    let f = Fixture::new();
    let mut project = multi_source(&f);
    fs::write(f.root.join("AGENTS.md"), "Desktop instructions\n").unwrap();
    project["sources"][1]["folderIdentity"] = json!("unavailable");
    indexer::scan(&f.db, &project).unwrap();
    assert_eq!(f.resources().len(), 1);
    assert_eq!(f.resources()[0]["sourceId"], project["sources"][0]["id"]);
    let mut wrong = f.resources()[0].clone();
    wrong["sourceId"] = project["sources"][1]["id"].clone();
    assert!(sync::materialize(&f.db, &project, &wrong).is_err());
    assert!(sources::select(&project, None).is_err());
}

#[test]
fn parent_scan_finds_git_directories_and_worktree_files_without_recursing_or_following_links() {
    let f = Fixture::new();
    let parent = f.root.parent().unwrap();
    fs::create_dir(f.root.join(".git")).unwrap();
    let backend = parent.join("backend");
    fs::create_dir(&backend).unwrap();
    fs::write(backend.join(".git"), "gitdir: ../worktree-data\n").unwrap();
    let nested = parent.join("unrelated/nested");
    fs::create_dir_all(nested.join(".git")).unwrap();
    std::os::unix::fs::symlink(&backend, parent.join("linked-backend")).unwrap();
    let found = sources::scan_project_folders(parent.to_string_lossy().into()).unwrap();
    assert_eq!(found.len(), 2);
    assert!(found
        .iter()
        .all(|item| item["name"] == "backend" || item["name"] == "project"));
}

#[test]
fn source_catalog_refresh_preserves_each_macs_bindings_by_id() {
    let f = Fixture::new();
    let project = multi_source(&f);
    let id = project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", id, id, &project).unwrap();
    let mut remote = project.clone();
    for source in remote["sources"].as_array_mut().unwrap() {
        source.as_object_mut().unwrap().remove("path");
        source.as_object_mut().unwrap().remove("folderIdentity");
    }
    crate::projects::merge_catalog(&f.db, &json!([remote])).unwrap();
    let saved = db::rows(&f.db, "SELECT value FROM projects WHERE id=?", &[&id])
        .unwrap()
        .remove(0);
    assert_eq!(saved["sources"], project["sources"]);
}

#[test]
fn imported_resource_ids_are_reused_within_their_source() {
    let f = Fixture::new();
    let project = multi_source(&f);
    let id = uuid::Uuid::new_v4().to_string();
    let text = "Approved remote instructions\n";
    let resource = json!({"resourceId":id,"sourceId":project["sources"][0]["id"],"projectId":project["id"],"kind":"memory","source":"shared","logicalPath":"instructions/AGENTS.md","title":"Instructions","files":[{"path":"content.md","hash":db::blob(text.as_bytes()).unwrap(),"size":text.len(),"executable":false}],"revision":1,"owner":db::get(&f.db,"user").unwrap(),"deleted":false});
    db::upsert(
        &f.db,
        "resources",
        &id,
        project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    sync::materialize(&f.db, &project, &resource).unwrap();
    indexer::scan(&f.db, &project).unwrap();
    assert_eq!(f.resources().len(), 1);
    assert_eq!(f.resources()[0]["resourceId"], id);
    assert!(f.outbox().is_empty());
}

#[test]
fn permission_reset_never_reads_or_removes_files_in_a_replaced_checkout() {
    let f = Fixture::new();
    let mut project = multi_source(&f);
    project["governed"] = json!(true);
    project["sources"][0]["folderIdentity"] = json!("replaced");
    let id = uuid::Uuid::new_v4().to_string();
    let path = f.root.join(".agents/skills/keep/SKILL.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "Unrelated checkout content\n").unwrap();
    let resource = json!({"resourceId":id,"sourceId":project["sources"][0]["id"],"projectId":project["id"],"kind":"skill","source":"shared","logicalPath":"keep","files":[],"revision":1,"deleted":false});
    let project_id = project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", project_id, project_id, &project).unwrap();
    db::upsert(&f.db, "resources", &id, project_id, &resource).unwrap();
    db::upsert(
        &f.db,
        "bindings",
        &id,
        project_id,
        &json!({"base":resource,"managed":true,"paths":[path.parent().unwrap()]}),
    )
    .unwrap();
    crate::governance::reset(&f.db, project_id, &json!([])).unwrap();
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "Unrelated checkout content\n"
    );
    assert!(f.resources().is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .is_empty());
}
