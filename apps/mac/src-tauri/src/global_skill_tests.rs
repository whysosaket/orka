use super::*;
use crate::global_skills;

fn global(f: &Fixture, tool: &str, name: &str) -> PathBuf {
    let path = f._home.path().join(tool).join("skills").join(name);
    fs::create_dir_all(&path).unwrap();
    fs::write(
        path.join("SKILL.md"),
        "---\nname: Example\ndescription: Local skill\n---\n# Example\n",
    )
    .unwrap();
    path
}

fn scan(f: &Fixture) -> Value {
    serde_json::to_value(global_skills::scan(&f.db, &f.project).unwrap()).unwrap()
}

fn mock_skill_refresh(f: &Fixture) {
    use std::os::unix::fs::PermissionsExt;
    let bin = f._home.path().join(".local/bin");
    fs::create_dir_all(&bin).unwrap();
    let path = bin.join("codex");
    fs::write(&path, r##"#!/usr/bin/env python3
import json, os, pathlib, sys
home = pathlib.Path(os.environ['CODEX_HOME'])
home.mkdir(parents=True, exist_ok=True)
if '--version' in sys.argv:
 print('codex-cli 0.159.2'); sys.exit()
for line in sys.stdin:
 request = json.loads(line)
 if 'id' not in request: continue
 result = {'codexHome': str(home)}
 error = None
 if request['method'] == 'skills/list':
  with (home/'skill-refresh.jsonl').open('a') as log: log.write(json.dumps(request)+'\n')
  if (home/'refresh-fails').exists(): error = {'code': -32000, 'message': 'Try again'}
  elif (home/'refresh-unsupported').exists(): error = {'code': -32601, 'message': 'Method not found'}
  else: result = {'data': []}
 print(json.dumps({'id': request['id'], **({'error': error} if error else {'result': result})}), flush=True)
"##).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn global_skills_batch_installs_once_reports_failures_and_refreshes_codex_once() {
    let mut f = Fixture::new();
    mock_skill_refresh(&f);
    f.project["sharing"] = json!({"skill":false});
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    global(&f, ".codex", "first");
    global(&f, ".claude", "second");
    let unsafe_path = global(&f, ".agents", "unsafe");
    fs::write(unsafe_path.join(".env"), "PRIVATE=value").unwrap();
    let skills = scan(&f)["skills"].as_array().unwrap().clone();
    let mut ids: Vec<_> = skills
        .iter()
        .map(|skill| skill["id"].as_str().unwrap().to_string())
        .collect();
    ids.push(ids[0].clone());
    ids.push("no-longer-available".into());
    let result = global_skills::add_many_when_ready(
        f.project["id"].as_str().unwrap(),
        &ids,
        None,
        std::time::Duration::from_secs(1),
    )
    .unwrap();
    let results = result["results"].as_array().unwrap();
    assert_eq!(results.len(), 4);
    assert_eq!(
        results
            .iter()
            .filter(|item| item["result"]["status"] == "local")
            .count(),
        2
    );
    assert_eq!(
        results
            .iter()
            .filter(|item| item["error"].is_string())
            .count(),
        2
    );
    for folder in [".agents/skills", ".claude/skills"] {
        for name in ["first", "second"] {
            assert!(f.root.join(folder).join(name).join("SKILL.md").is_file());
        }
        assert!(!f.root.join(folder).join("unsafe").exists());
    }
    assert!(f.outbox().is_empty());
    let log =
        fs::read_to_string(native::codex_home().unwrap().join("skill-refresh.jsonl")).unwrap();
    let requests: Vec<Value> = log
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0]["params"],
        json!({"cwds":[f.root],"forceReload":true})
    );
}

#[test]
fn global_skills_refresh_survives_restart_and_retries_without_reinstalling() {
    let f = Fixture::new();
    mock_skill_refresh(&f);
    let home = native::codex_home().unwrap();
    crate::codex_skills::queue(&f.db, &f.project, true).unwrap();
    crate::codex_skills::retry(&f.db).unwrap();
    assert!(!home.exists());
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("refresh-fails"), "").unwrap();
    crate::codex_skills::queue(&f.db, &f.project, true).unwrap();
    crate::codex_skills::retry(&f.db).unwrap();
    assert!(db::rows(
        &f.db,
        "SELECT json_object('error',error) FROM errors WHERE source LIKE '%:codex-skills'",
        &[]
    )
    .unwrap()[0]["error"]
        .as_str()
        .unwrap()
        .contains("Try again"));
    let reopened = db::open().unwrap();
    fs::remove_file(home.join("refresh-fails")).unwrap();
    crate::codex_skills::retry(&reopened).unwrap();
    crate::codex_skills::retry(&reopened).unwrap();
    // A current package from an older build needs one refresh, not one per sync.
    crate::codex_skills::queue(&reopened, &f.project, false).unwrap();
    crate::codex_skills::retry(&reopened).unwrap();
    assert!(db::rows(
        &reopened,
        "SELECT json_object('error',error) FROM errors WHERE source LIKE '%:codex-skills'",
        &[]
    )
    .unwrap()
    .is_empty());
    assert_eq!(
        fs::read_to_string(home.join("skill-refresh.jsonl"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    fs::write(home.join("refresh-unsupported"), "").unwrap();
    crate::codex_skills::queue(&reopened, &f.project, true).unwrap();
    crate::codex_skills::refresh(&reopened).unwrap();
    crate::codex_skills::refresh(&reopened).unwrap();
    assert_eq!(
        fs::read_to_string(home.join("skill-refresh.jsonl"))
            .unwrap()
            .lines()
            .count(),
        3
    );
}

#[test]
fn global_skills_scan_nested_roots_deduplicate_links_and_report_unsafe_packages_without_caching() {
    let f = Fixture::new();
    let path = global(&f, ".codex", ".system/example");
    global(&f, ".claude", "synced/library/another");
    global(&f, ".agents", "shared");
    let claude = f._home.path().join(".claude/skills");
    std::os::unix::fs::symlink(&path, claude.join("example")).unwrap();
    let unsafe_path = global(&f, ".codex", "unsafe");
    fs::write(unsafe_path.join(".env.local"), "PRIVATE=value").unwrap();
    let linked = global(&f, ".claude", "linked-asset");
    std::os::unix::fs::symlink(path.join("SKILL.md"), linked.join("outside.md")).unwrap();

    let result = scan(&f);
    let skills = result["skills"].as_array().unwrap();
    assert_eq!(skills.len(), 5);
    assert!(result["errors"].as_array().unwrap().is_empty());
    let example = skills.iter().find(|s| s["name"] == "example").unwrap();
    assert_eq!(example["sources"], json!(["codex", "claude"]));
    assert_eq!(example["fileCount"], 1);
    assert!(example["markdown"]
        .as_str()
        .unwrap()
        .contains("name: Example"));
    assert!(
        skills.iter().find(|s| s["name"] == "unsafe").unwrap()["error"]
            .as_str()
            .unwrap()
            .contains(if crate::env::enabled() {
                "ENV"
            } else {
                "Secret files"
            })
    );
    assert!(
        skills.iter().find(|s| s["name"] == "linked-asset").unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("symlink")
    );
    let hash = db::digest(b"PRIVATE=value");
    assert!(!db::blob_path(&hash).unwrap().exists());
    assert!(f.outbox().is_empty());
    assert!(f.resources().is_empty());
}

#[test]
fn global_skills_add_preserves_assets_modes_and_global_originals_in_both_project_folders() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let path = global(&f, ".codex", "example");
    fs::create_dir(path.join("scripts")).unwrap();
    fs::write(path.join("scripts/run.sh"), "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(
        path.join("scripts/run.sh"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::write(path.join("asset.bin"), [0, 255, 31]).unwrap();
    let before = packages::directory(&path).unwrap();
    let id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
    let result = global_skills::add(&f.db, &f.project, &id).unwrap();
    assert_eq!(result["status"], "queued");
    for folder in [".agents/skills/example", ".claude/skills/example"] {
        assert_eq!(packages::directory(&f.root.join(folder)).unwrap(), before);
    }
    assert_eq!(packages::directory(&path).unwrap(), before);
    assert_eq!(scan(&f)["skills"][0]["exists"], true);
    assert_eq!(f.outbox().len(), 1);
    assert!(global_skills::add(&f.db, &f.project, &id)
        .unwrap_err()
        .contains("already"));
    assert!(global_skills::add(&f.db, &f.project, "../../elsewhere").is_err());
}

#[test]
fn global_skills_import_waits_for_sync_and_uses_current_sharing_choices() {
    let f = Fixture::new();
    global(&f, ".codex", "example");
    let id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
    let lock = crate::projects::lock().unwrap();
    let root = f.root.clone();
    let mut project = f.project.clone();
    let sync = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!root.join(".agents/skills/example").exists());
        assert!(!root.join(".claude/skills/example").exists());
        assert!(crate::projects::foreground_waiting().unwrap());
        let db = db::open().unwrap();
        project["sharing"] = json!({"skill":false});
        db::upsert(
            &db,
            "projects",
            project["id"].as_str().unwrap(),
            "",
            &project,
        )
        .unwrap();
        drop(lock);
    });
    let result = global_skills::add_when_ready(
        f.project["id"].as_str().unwrap(),
        &id,
        std::time::Duration::from_secs(2),
    )
    .unwrap();
    sync.join().unwrap();
    assert!(!crate::projects::foreground_waiting().unwrap());
    assert_eq!(result["status"], "local");
    assert!(f.root.join(".agents/skills/example/SKILL.md").is_file());
    assert!(f.root.join(".claude/skills/example/SKILL.md").is_file());
    assert!(f.outbox().is_empty());
}

#[test]
fn global_skills_import_timeout_writes_nothing_and_remains_retryable() {
    let f = Fixture::new();
    global(&f, ".codex", "example");
    let id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
    let lock = crate::projects::lock().unwrap();
    let result = global_skills::add_when_ready(
        f.project["id"].as_str().unwrap(),
        &id,
        std::time::Duration::from_millis(20),
    );
    assert!(result.unwrap_err().contains("still running"));
    assert!(!crate::projects::foreground_waiting().unwrap());
    assert!(!f.root.join(".agents/skills/example").exists());
    assert!(!f.root.join(".claude/skills/example").exists());
    assert!(f.resources().is_empty());
    assert!(f.outbox().is_empty());
    drop(lock);
    assert_eq!(
        global_skills::add_when_ready(
            f.project["id"].as_str().unwrap(),
            &id,
            std::time::Duration::from_secs(1),
        )
        .unwrap()["status"],
        "queued"
    );
}

#[test]
fn global_skills_import_rejects_account_or_folder_changes_while_waiting() {
    for change_account in [true, false] {
        let f = Fixture::new();
        global(&f, ".codex", "example");
        let id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
        let lock = crate::projects::lock().unwrap();
        let mut project = f.project.clone();
        let new_root = f._home.path().join("new-project-folder");
        fs::create_dir(&new_root).unwrap();
        let destination = new_root.clone();
        let change = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if change_account {
                db::profile(&uuid::Uuid::new_v4().to_string()).unwrap();
            } else {
                let db = db::open().unwrap();
                project["path"] = json!(destination);
                db::upsert(
                    &db,
                    "projects",
                    project["id"].as_str().unwrap(),
                    "",
                    &project,
                )
                .unwrap();
            }
            drop(lock);
        });
        let error = global_skills::add_when_ready(
            f.project["id"].as_str().unwrap(),
            &id,
            std::time::Duration::from_secs(2),
        )
        .unwrap_err();
        change.join().unwrap();
        assert!(error.contains(if change_account {
            "account or service changed"
        } else {
            "project folder changed"
        }));
        for root in [&f.root, &new_root] {
            assert!(!root.join(".agents/skills/example").exists());
            assert!(!root.join(".claude/skills/example").exists());
        }
        assert!(f.outbox().is_empty());
    }
}

#[test]
fn global_skills_add_refuses_existing_copies_cloud_resources_and_unsafe_destinations() {
    let f = Fixture::new();
    global(&f, ".claude", "example");
    let id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
    let target = f.root.join(".claude/skills/example");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("SKILL.md"), "Project edits").unwrap();
    assert!(global_skills::add(&f.db, &f.project, &id).is_err());
    assert_eq!(
        fs::read_to_string(target.join("SKILL.md")).unwrap(),
        "Project edits"
    );
    assert!(!f.root.join(".agents").exists());
    fs::remove_dir_all(&target).unwrap();
    let rid = indexer::resource_id(f.project["id"].as_str().unwrap(), "skill", "example");
    db::upsert(
        &f.db,
        "resources",
        &rid,
        f.project["id"].as_str().unwrap(),
        &json!({"resourceId":rid,"kind":"skill","deleted":false}),
    )
    .unwrap();
    assert!(global_skills::add(&f.db, &f.project, &id).is_err());
    f.db.execute("DELETE FROM resources", []).unwrap();
    let outside = f._home.path().join("outside");
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, f.root.join(".agents")).unwrap();
    assert!(global_skills::add(&f.db, &f.project, &id).is_err());
    assert!(!outside.join("skills").exists());
    assert!(!target.exists());
    assert!(f.outbox().is_empty());
}

#[test]
fn global_skills_governed_import_stays_a_local_draft_and_sharing_off_stays_local() {
    let mut f = Fixture::new();
    global(&f, ".agents", "example");
    let id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
    f.project["governed"] = json!(true);
    let result = global_skills::add(&f.db, &f.project, &id).unwrap();
    assert_eq!(result["status"], "queued");
    assert!(f.resources().is_empty());
    assert_eq!(f.outbox().len(), 1);
    let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0]["status"], "local");
    assert_eq!(drafts[0]["paths"].as_array().unwrap().len(), 2);
    assert!(f.root.join(".agents/skills/example/SKILL.md").is_file());

    global(&f, ".claude", "private");
    let private = scan(&f)["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "private")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    f.project["governed"] = json!(false);
    f.project["sharing"] = json!({"skill":false});
    let result = global_skills::add(&f.db, &f.project, &private).unwrap();
    assert_eq!(result["status"], "local");
    assert!(f.root.join(".claude/skills/private/SKILL.md").is_file());
    assert_eq!(f.outbox().len(), 1);
}

#[test]
fn global_skills_add_checks_connection_identity_and_revalidates_changed_sources() {
    let mut f = Fixture::new();
    let path = global(&f, ".codex", "example");
    let id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
    f.project["folderIdentity"] = json!("stale");
    assert!(global_skills::add(&f.db, &f.project, &id).is_err());
    assert!(!f.root.join(".agents").exists());
    f.project["folderIdentity"] = Value::Null;
    fs::write(path.join(".env"), "must stay local").unwrap();
    assert!(global_skills::add(&f.db, &f.project, &id).is_err());
    assert!(!f.root.join(".agents").exists());
    f.project["path"] = Value::Null;
    assert!(global_skills::add(&f.db, &f.project, &id).is_err());
}

#[test]
fn global_skills_automatic_share_keeps_one_durable_request_and_survives_localization_and_pause() {
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
    global(&f, ".codex", "automatic");
    let id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
    global_skills::add(&f.db, &f.project, &id).unwrap();
    let draft = db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .remove(0);
    let queued = f.outbox().remove(0);
    crate::governance::localize_outbox(&f.db, &f.project).unwrap();
    let reopened = db::open().unwrap();
    global_skills::queue_share(&reopened, &f.project, draft["id"].as_str().unwrap()).unwrap();
    assert_eq!(f.outbox(), vec![queued]);
    assert_eq!(
        global_skills::local_skills(&f.db, &f.project).unwrap()[0]["sharing"],
        "queued"
    );
    f.project["sharing"] = json!({"skill":false});
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    assert!(global_skills::queue_share(&f.db, &f.project, draft["id"].as_str().unwrap()).is_err());
    assert_eq!(
        global_skills::local_skills(&f.db, &f.project).unwrap()[0]["sharing"],
        "paused"
    );
    assert_eq!(f.outbox().len(), 1);
}

#[test]
fn global_skills_publication_only_adopts_the_authors_exact_unchanged_local_package() {
    for variant in [
        "unchanged",
        "edited",
        "removed",
        "other-author",
        "previous-owner",
    ] {
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
        global(&f, ".codex", "automatic");
        let id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
        global_skills::add(&f.db, &f.project, &id).unwrap();
        let value = f.outbox().remove(0);
        let queued = json!({"project":f.project["id"],"id":value["id"],"value":value});
        let mut resource = queued["value"]["resource"].clone();
        resource["projectId"] = f.project["id"].clone();
        resource["owner"] = if variant == "previous-owner" || variant == "other-author" {
            json!("someone-else")
        } else {
            db::get(&f.db, "user").unwrap()
        };
        resource["updatedBy"] = if variant == "other-author" {
            json!("someone-else")
        } else {
            db::get(&f.db, "user").unwrap()
        };
        resource["revision"] = json!(1);
        if variant == "edited" {
            fs::write(
                f.root.join(".agents/skills/automatic/SKILL.md"),
                "My edits\n",
            )
            .unwrap();
        }
        if variant == "removed" {
            fs::remove_dir_all(f.root.join(".agents/skills/automatic")).unwrap();
        }
        global_skills::complete_share(
            &f.db,
            &queued,
            &json!({"event":{"resource":resource,"conflicts":[]}}),
        )
        .unwrap();
        let binding = indexer::binding(&f.db, resource["resourceId"].as_str().unwrap()).unwrap();
        assert_eq!(
            binding["reviewedRevision"] == 1,
            variant == "unchanged" || variant == "previous-owner",
            "{variant}"
        );
        if variant == "edited" {
            assert_eq!(
                fs::read_to_string(f.root.join(".agents/skills/automatic/SKILL.md")).unwrap(),
                "My edits\n"
            );
        }
        if variant == "removed" {
            assert!(!f.root.join(".agents/skills/automatic").exists());
        }
        assert_eq!(f.resources().len(), 1);
    }
}

fn history(f: &Fixture, source: &str, name: &str, records: &[Value]) -> PathBuf {
    let root = f._home.path().join(if source == "codex" {
        ".codex/sessions"
    } else {
        ".claude/projects/project"
    });
    fs::create_dir_all(&root).unwrap();
    let path = root.join(format!("{name}.jsonl"));
    fs::write(
        &path,
        records.iter().map(|r| format!("{r}\n")).collect::<String>(),
    )
    .unwrap();
    path
}

#[test]
fn global_skills_local_catalog_inspects_imports_and_counts_usage_without_publishing() {
    let mut f = Fixture::new();
    global(&f, ".codex", "example");
    f.project["governed"] = json!(true);
    f.project["sharing"] = json!({"skill":false});
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    let id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
    let added = global_skills::add(&f.db, &f.project, &id).unwrap();
    let rid = added["resourceId"].as_str().unwrap();
    let snapshot = crate::commands::snapshot().unwrap();
    let skill = &snapshot["localSkills"][0];
    assert_eq!(skill["resourceId"], rid);
    assert_eq!(skill["projectId"], f.project["id"]);
    assert_eq!(skill["local"], true);
    assert_eq!(skill["global"], true);
    assert_eq!(skill["revision"], 0);
    assert!(skill["updatedAt"].is_string());
    let inspection =
        crate::commands::inspect_resource(rid.into(), "SKILL.md".into(), None).unwrap();
    assert!(inspection["content"]
        .as_str()
        .unwrap()
        .contains("name: Example"));
    assert_eq!(inspection["paths"].as_array().unwrap().len(), 2);
    history(
        &f,
        "codex",
        "local-use",
        &[
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":format!("<skill>\n<path>{}/.agents/skills/example/SKILL.md</path>\n</skill>", f.root.display())}]}}),
        ],
    );
    let usage =
        serde_json::to_value(crate::skill_usage::collect_project(&f.db, &f.project).unwrap())
            .unwrap();
    assert_eq!(usage["counts"][rid], 1);
    assert!(f.resources().is_empty());
    assert!(f.outbox().is_empty());

    f.project["governed"] = json!(false);
    f.project["sharing"] = json!({"skill":false});
    global(&f, ".codex", "private");
    let id = scan(&f)["skills"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "private")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    global_skills::add(&f.db, &f.project, &id).unwrap();
    assert_eq!(
        global_skills::local_skills(&f.db, &f.project)
            .unwrap()
            .len(),
        2
    );
    assert!(f.outbox().is_empty());
}

#[test]
fn global_skills_local_catalog_uses_latest_draft_and_deduplicates_shared_and_removed_resources() {
    let mut f = Fixture::new();
    let path = global(&f, ".codex", "example");
    f.project["governed"] = json!(true);
    let id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
    global_skills::add(&f.db, &f.project, &id).unwrap();
    let mut draft = db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .remove(0);
    let mut resource = draft["resource"].clone();
    fs::write(path.join("SKILL.md"), "# New draft").unwrap();
    resource["files"] = json!(packages::directory(&path).unwrap());
    let newer = crate::governance::capture(&f.db, &f.project, &resource, &draft["paths"]).unwrap();
    let skills = global_skills::local_skills(&f.db, &f.project).unwrap();
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0]["files"], resource["files"]);
    f.db.execute(
        "UPDATE drafts SET value=json_set(value,'$.status','dismissed') WHERE id=?",
        [&newer],
    )
    .unwrap();
    assert!(global_skills::local_skills(&f.db, &f.project)
        .unwrap()
        .is_empty());
    f.db.execute(
        "UPDATE drafts SET value=json_set(value,'$.status','proposed') WHERE id=?",
        [&newer],
    )
    .unwrap();
    assert_eq!(
        global_skills::local_skills(&f.db, &f.project)
            .unwrap()
            .len(),
        1
    );
    draft["resource"]["projectId"] = f.project["id"].clone();
    f.accept(&draft["resource"]);
    assert!(global_skills::local_skills(&f.db, &f.project)
        .unwrap()
        .is_empty());
    let mut removed = draft["resource"].clone();
    removed["deleted"] = json!(true);
    f.accept(&removed);
    assert!(global_skills::local_skills(&f.db, &f.project)
        .unwrap()
        .is_empty());
}

#[test]
fn global_skills_local_catalog_requires_the_original_connected_folder_and_existing_safe_files() {
    let mut f = Fixture::new();
    global(&f, ".codex", "example");
    f.project["governed"] = json!(true);
    let id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
    global_skills::add(&f.db, &f.project, &id).unwrap();
    let mut other = f.project.clone();
    other["path"] = Value::Null;
    assert!(global_skills::local_skills(&f.db, &other)
        .unwrap()
        .is_empty());
    other["path"] = json!(f._home.path());
    assert!(global_skills::local_skills(&f.db, &other)
        .unwrap()
        .is_empty());
    other = f.project.clone();
    other["folderIdentity"] = json!("changed");
    assert!(global_skills::local_skills(&f.db, &other)
        .unwrap()
        .is_empty());
    fs::remove_dir_all(f.root.join(".agents/skills/example")).unwrap();
    assert_eq!(
        global_skills::local_skills(&f.db, &f.project).unwrap()[0]["paths"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    fs::remove_dir_all(f.root.join(".claude/skills/example")).unwrap();
    assert!(global_skills::local_skills(&f.db, &f.project)
        .unwrap()
        .is_empty());
}

#[test]
fn global_skills_fresh_import_of_a_previously_deleted_skill_is_readable_locally() {
    let mut f = Fixture::new();
    global(&f, ".codex", "example");
    f.project["governed"] = json!(true);
    f.project["sharing"] = json!({"skill":false});
    let rid = indexer::resource_id(f.project["id"].as_str().unwrap(), "skill", "example");
    let removed = json!({"resourceId":rid,"projectId":f.project["id"],"kind":"skill","logicalPath":"example","title":"example","source":"shared","revision":10,"deleted":true,"files":[],"updatedAt":"2020-01-01T00:00:00.000Z"});
    f.accept(&removed);
    db::upsert(
        &f.db,
        "bindings",
        &rid,
        f.project["id"].as_str().unwrap(),
        &json!({"base":removed,"paths":[]}),
    )
    .unwrap();
    let id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
    global_skills::add(&f.db, &f.project, &id).unwrap();
    assert_eq!(
        global_skills::local_skills(&f.db, &f.project)
            .unwrap()
            .len(),
        1
    );
    let inspection =
        crate::commands::inspect_resource(rid.clone(), "SKILL.md".into(), None).unwrap();
    assert!(inspection["content"]
        .as_str()
        .unwrap()
        .contains("name: Example"));
    assert_eq!(inspection["paths"].as_array().unwrap().len(), 2);
    assert_eq!(f.resources()[0]["deleted"], true);
    assert!(f.outbox().is_empty());
    let mut newer_removal = removed;
    newer_removal["updatedAt"] = json!("9999-01-01T00:00:00.000Z");
    f.accept(&newer_removal);
    assert!(global_skills::local_skills(&f.db, &f.project)
        .unwrap()
        .is_empty());
}

#[test]
fn global_skills_origin_recovers_older_imports_once_and_preserves_explicit_provenance() {
    let mut f = Fixture::new();
    let path = global(&f, ".codex", "example");
    f.project["governed"] = json!(true);
    f.project["sharing"] = json!({"skill":false});
    let id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
    let added = global_skills::add(&f.db, &f.project, &id).unwrap();
    let key = format!(
        "global-skill-origin:{}",
        added["resourceId"].as_str().unwrap()
    );
    f.db.execute("DELETE FROM meta WHERE key=?", [&key])
        .unwrap();
    let resource = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap()[0]["resource"].clone();
    assert!(global_skills::global_origin(&f.db, &resource).unwrap());
    fs::remove_dir_all(&path).unwrap();
    assert!(global_skills::global_origin(&f.db, &resource).unwrap());
    assert_eq!(db::get(&f.db, &key).unwrap(), true);
    let mut unrelated = resource.clone();
    unrelated["resourceId"] = json!("unrelated");
    unrelated["logicalPath"] = json!("unrelated");
    assert!(!global_skills::global_origin(&f.db, &unrelated).unwrap());
    assert!(f.outbox().is_empty());
}

fn usage(f: &Fixture, name: &str) -> (usize, bool) {
    let skills = global_skills::scan(&f.db, &f.project).unwrap().skills;
    let id = skills.iter().find(|s| s.name == name).unwrap().id.clone();
    let result =
        serde_json::to_value(crate::skill_usage::collect(&f.db, &skills).unwrap()).unwrap();
    (
        result["counts"][&id].as_u64().unwrap() as usize,
        result["partial"].as_bool().unwrap(),
    )
}

#[test]
fn skill_usage_project_counts_both_copies_once_per_chat_and_isolates_other_paths() {
    let f = Fixture::new();
    let global = global(&f, ".codex", "example");
    let global_id = scan(&f)["skills"][0]["id"].as_str().unwrap().to_string();
    global_skills::add(&f.db, &f.project, &global_id).unwrap();
    let resource = f
        .resources()
        .into_iter()
        .find(|r| r["kind"] == "skill")
        .unwrap();
    let id = resource["resourceId"].as_str().unwrap();
    let paths = [
        f.root.join(".agents/skills/example/SKILL.md"),
        f.root.join(".claude/skills/example/SKILL.md"),
        global.join("SKILL.md"),
        f._home
            .path()
            .join("other-project/.agents/skills/example/SKILL.md"),
    ];
    let records: Vec<_> = paths.iter().enumerate().map(|(i, path)| {
        json!({"type":"response_item","payload":{"type":"message","id":format!("attachment-{i}"),"role":"user","content":[{"text":format!("<skill>\n<path>{}</path>\n</skill>",path.display())}]}})
    }).collect();
    history(&f, "codex", "one", &records);
    history(
        &f,
        "claude",
        "two",
        &[
            json!({"type":"assistant","sessionId":"second-chat","message":{"content":[{"type":"tool_use","id":"read-project","name":"Read","input":{"file_path":paths[1]}}]}}),
            json!({"type":"user","sessionId":"second-chat","message":{"content":[{"type":"tool_result","tool_use_id":"read-project","content":"skill loaded"}]}}),
        ],
    );
    history(&f, "codex", "global-only", &records[2..]);
    let other = json!({"resourceId":"other-resource","kind":"skill","logicalPath":"example","deleted":false});
    db::upsert(
        &f.db,
        "resources",
        "other-resource",
        "other-project",
        &other,
    )
    .unwrap();
    let mut deleted = resource.clone();
    deleted["resourceId"] = json!("deleted-skill");
    deleted["deleted"] = json!(true);
    db::upsert(
        &f.db,
        "resources",
        "deleted-skill",
        f.project["id"].as_str().unwrap(),
        &deleted,
    )
    .unwrap();
    let result =
        serde_json::to_value(crate::skill_usage::collect_project(&f.db, &f.project).unwrap())
            .unwrap();
    assert_eq!(result["counts"], json!({id:2}));
    assert_eq!(result["partial"], false);
    assert_eq!(usage(&f, "example"), (1, false));
    let mut disconnected = f.project.clone();
    disconnected["path"] = Value::Null;
    assert!(crate::skill_usage::collect_project(&f.db, &disconnected).is_err());
}

#[test]
fn skill_usage_counts_recorded_codex_loads_once_per_chat_and_ignores_catalogs_failures_and_copies()
{
    let f = Fixture::new();
    let global = global(&f, ".codex", "example");
    let path = global.join("SKILL.md");
    let skill = format!(
        "<skill>\n<name>example</name>\n<path>{}</path>\nInstructions\n</skill>",
        path.display()
    );
    let command = json!({"cmd":format!("cat '{}'", path.display())}).to_string();
    let records = vec![
        json!({"type":"session_meta","payload":{"id":"chat-one","cwd":global}}),
        json!({"type":"response_item","payload":{"type":"message","id":"load-1","role":"user","content":[{"text":skill}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","call_id":"read-1","name":"exec_command","arguments":command}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"read-1","output":"Exit code: 0\nInstructions"}}),
    ];
    history(&f, "codex", "one", &records);
    let mut copy = records.clone();
    copy[0]["payload"]["id"] = json!("imported-copy");
    history(&f, "codex", "two-copy", &copy);
    history(
        &f,
        "codex",
        "three",
        &[
            json!({"type":"session_meta","payload":{"id":"chat-two","cwd":global}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"nested-read","name":"exec","input":"text(await tools.exec_command({cmd: \"cat SKILL.md\"}));"}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"nested-read","output":"Script completed\nExit code: 0"}}),
        ],
    );
    history(
        &f,
        "codex",
        "four",
        &[
            json!({"type":"session_meta","payload":{"id":"chat-failed"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"developer","content":[{"text":format!("Available skills: {}", path.display())}]}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"failed-read","name":"exec_command","arguments":command}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"failed-read","output":"Exit code: 1\nPermission denied"}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call","call_id":"patch","name":"exec","input":format!("text(await tools.apply_patch({}));", json!(format!("cat {}", path.display())))}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"patch","output":"Script completed"}}),
        ],
    );
    assert_eq!(usage(&f, "example"), (2, false));
    assert_eq!(usage(&f, "example"), (2, false));
    assert!(f.outbox().is_empty());
    assert!(f.resources().is_empty());
}

#[test]
fn skill_usage_handles_claude_invocations_reads_and_incremental_history_without_storing_text() {
    let f = Fixture::new();
    let global = global(&f, ".claude", "example");
    let path = history(
        &f,
        "claude",
        "one",
        &[
            json!({"type":"assistant","sessionId":"chat-one","message":{"content":[{"type":"tool_use","id":"use-1","name":"Skill","input":{"skill":"example"}}]}}),
            json!({"type":"user","sessionId":"chat-one","message":{"content":[{"type":"tool_result","tool_use_id":"use-1","content":"Launching skill: example"}]}}),
            json!({"type":"assistant","sessionId":"chat-one","message":{"content":[{"type":"tool_use","id":"read-1","name":"Read","input":{"file_path":global.join("SKILL.md")}}]}}),
            json!({"type":"user","sessionId":"chat-one","message":{"content":[{"type":"tool_result","tool_use_id":"read-1","content":"PRIVATE_TRANSCRIPT_CANARY"}]}}),
            json!({"type":"assistant","sessionId":"failed-chat","message":{"content":[{"type":"tool_use","id":"use-2","name":"Skill","input":{"skill":"example"}}]}}),
            json!({"type":"user","sessionId":"failed-chat","message":{"content":[{"type":"tool_result","tool_use_id":"use-2","is_error":true,"content":"Unavailable"}]}}),
        ],
    );
    assert_eq!(usage(&f, "example"), (1, false));
    let cached = db::rows(
        &f.db,
        "SELECT value FROM meta WHERE key LIKE 'skill-usage:%'",
        &[],
    )
    .unwrap();
    assert!(!json!(cached)
        .to_string()
        .contains("PRIVATE_TRANSCRIPT_CANARY"));
    history(
        &f,
        "claude",
        "two",
        &[
            json!({"type":"assistant","sessionId":"chat-two","message":{"content":[{"type":"tool_use","id":"use-3","name":"Skill","input":{"skill":"example"}}]}}),
            json!({"type":"user","sessionId":"chat-two","message":{"content":[{"type":"tool_result","tool_use_id":"use-3","content":"Launching skill: example"}]}}),
        ],
    );
    assert_eq!(usage(&f, "example"), (2, false));
    fs::remove_file(path).unwrap();
    assert_eq!(usage(&f, "example"), (1, false));
}

#[test]
fn skill_usage_reports_partial_history_and_does_not_follow_linked_transcripts() {
    let f = Fixture::new();
    global(&f, ".codex", "example");
    let path = history(&f, "codex", "bad", &[]);
    fs::write(&path, "{\"SKILL.md\": invalid}\n").unwrap();
    let outside = f._home.path().join("private.jsonl");
    fs::write(&outside, "PRIVATE_CANARY").unwrap();
    std::os::unix::fs::symlink(&outside, path.parent().unwrap().join("linked.jsonl")).unwrap();
    assert_eq!(usage(&f, "example"), (0, true));
    fs::write(path, "{}\n").unwrap();
    assert_eq!(usage(&f, "example"), (0, false));
}

fn append_history(path: &std::path::Path, bytes: &[u8]) {
    use std::io::Write;
    fs::OpenOptions::new()
        .append(true)
        .open(path)
        .unwrap()
        .write_all(bytes)
        .unwrap();
}

fn claude_load(id: &str, chat: &str, failed: bool) -> Vec<Value> {
    vec![
        json!({"type":"assistant","sessionId":chat,"message":{"content":[{"type":"tool_use","id":id,"name":"Skill","input":{"skill":"example"}}]}}),
        json!({"type":"user","sessionId":chat,"message":{"content":[{"type":"tool_result","tool_use_id":id,"is_error":failed,"content":"Skill result"}]}}),
    ]
}

#[test]
fn skill_usage_incremental_preserves_pending_calls_and_retries_incomplete_records() {
    let f = Fixture::new();
    global(&f, ".claude", "example");
    let load = claude_load("pending", "chat-one", false);
    let path = history(&f, "claude", "one", &load[..1]);
    assert_eq!(usage(&f, "example"), (0, false));
    let mut output = load[1].clone();
    output["message"]["content"][0]["content"] = json!("PRIVATE_PARTIAL_TRANSCRIPT_CANARY");
    let output = format!("{output}\n");
    let split = output.len() - 5;
    append_history(&path, &output.as_bytes()[..split]);
    assert_eq!(usage(&f, "example"), (0, true));
    let cached = db::rows(
        &f.db,
        "SELECT value FROM meta WHERE key LIKE 'skill-usage:%'",
        &[],
    )
    .unwrap();
    assert!(!json!(cached)
        .to_string()
        .contains("PRIVATE_PARTIAL_TRANSCRIPT_CANARY"));
    append_history(&path, &output.as_bytes()[split..]);
    assert_eq!(usage(&f, "example"), (1, false));
    for record in claude_load("failed", "chat-two", true) {
        append_history(&path, format!("{record}\n").as_bytes());
    }
    assert_eq!(usage(&f, "example"), (1, false));
    assert_eq!(usage(&f, "example"), (1, false));
}

#[test]
fn skill_usage_incremental_rebuilds_truncated_rewritten_and_replaced_history() {
    let f = Fixture::new();
    global(&f, ".claude", "example");
    let path = history(
        &f,
        "claude",
        "one",
        &claude_load("initial", "chat-one", false),
    );
    assert_eq!(usage(&f, "example"), (1, false));
    fs::write(&path, "{}\n").unwrap();
    assert_eq!(usage(&f, "example"), (0, false));
    for record in claude_load("append", "chat-two", false) {
        append_history(&path, format!("{record}\n").as_bytes());
    }
    assert_eq!(usage(&f, "example"), (1, false));
    let mut rewritten = claude_load("rewrite", "chat-three", true);
    rewritten.push(json!({"type":"user","message":{"content":"Longer rewritten history must invalidate prior counts"}}));
    history(&f, "claude", "one", &rewritten);
    assert_eq!(usage(&f, "example"), (0, false));
    let replacement = history(
        &f,
        "claude",
        "replacement",
        &claude_load("replace", "chat-four", false),
    );
    fs::rename(replacement, &path).unwrap();
    assert_eq!(usage(&f, "example"), (1, false));
    fs::remove_file(path).unwrap();
    assert_eq!(usage(&f, "example"), (0, false));
}

#[test]
fn skill_usage_incremental_skips_oversized_records_across_appends() {
    let f = Fixture::new();
    global(&f, ".claude", "example");
    let path = history(&f, "claude", "one", &[]);
    fs::write(&path, vec![b'x'; 2 * 1024 * 1024 + 128]).unwrap();
    assert_eq!(usage(&f, "example"), (0, true));
    append_history(&path, b"more of the same oversized record");
    assert_eq!(usage(&f, "example"), (0, true));
    append_history(&path, b"\n");
    for record in claude_load("valid-after-large-record", "chat-one", false) {
        append_history(&path, format!("{record}\n").as_bytes());
    }
    assert_eq!(usage(&f, "example"), (1, true));
    let cached = db::rows(
        &f.db,
        "SELECT value FROM meta WHERE key LIKE 'skill-usage:v2:%'",
        &[],
    )
    .unwrap();
    assert_eq!(
        cached[0]["offset"].as_u64().unwrap(),
        fs::metadata(&path).unwrap().len()
    );
    assert_eq!(cached[0]["state"]["skipping_record"], false);
}
