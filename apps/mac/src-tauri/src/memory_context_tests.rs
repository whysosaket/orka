use super::*;
use crate::{governance, memory_context};

fn memory(f: &Fixture, path: &str, title: &str, content: &str) -> Value {
    let id = uuid::Uuid::new_v4().to_string();
    let r = json!({"resourceId":id,"projectId":f.project["id"],"kind":"memory","source":"codex","logicalPath":path,"title":title,"files":[{"path":"content.md","hash":db::blob(content.as_bytes()).unwrap(),"size":content.len(),"executable":false}],"deleted":false,"revision":1,"updatedAt":db::now()});
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &r,
    )
    .unwrap();
    r
}

#[test]
fn memory_retrieval_filters_tasks_and_collapses_summary_lineage() {
    let f = Fixture::new();
    let thread = uuid::Uuid::new_v4();
    memory(&f, "codex/summaries/old.md", "Signing older summary", &format!("thread_id: {thread}\nupdated_at: 2026-10-01T00:00:00Z\n\nSigning notarization old evidence"));
    memory(&f, "codex/summaries/renamed.md", "Signing renamed summary", &format!("thread_id: {thread}\nupdated_at: 2026-10-20T00:00:00Z\n\nSigning notarization newer evidence"));
    let fact = memory(&f, "codex/entries/signing.md", "Signing and notarization", "# Task Group: release\n\n### rollout_summary_files\n\n- rollout_summaries/old.md\n\n## Reusable knowledge\n\nSigning notarization requires the Developer ID certificate and a stapled ticket.");
    memory(
        &f,
        "claude/same.md",
        "Same release fact",
        "Signing notarization requires the Developer ID certificate and a stapled ticket.",
    );
    memory(
        &f,
        "codex/entries/outreach.md",
        "Survey outreach",
        "Survey outreach messages on LinkedIn should be short and personal.",
    );
    let entries = memory_context::select(
        &f.db,
        &f.project,
        &f.root,
        Some("Check signing notarization"),
    )
    .unwrap();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].text.contains("Developer ID"));
    assert!(!entries[0].text.contains("rollout_summary_files"));
    let catalog = memory_context::catalog(&f.db, &f.project).unwrap();
    assert!(!catalog.iter().any(|e| e.resource["logicalPath"]
        .as_str()
        .unwrap()
        .starts_with("codex/summaries/")));
    assert!(catalog
        .iter()
        .any(|e| e.resource["resourceId"] == fact["resourceId"]));
    assert!(memory_context::select(
        &f.db,
        &f.project,
        &f.root,
        Some("Fix a Rust compilation error")
    )
    .unwrap()
    .is_empty());
    assert!(memory_context::select(&f.db, &f.project, &f.root, Some(""))
        .unwrap()
        .is_empty());
}

#[test]
fn hooks_deliver_relevant_changes_once_in_both_project_modes() {
    let mut f = Fixture::new();
    let mut fact = memory(
        &f,
        "claude/signing.md",
        "Signing notarization",
        "Signing notarization requires Developer ID.",
    );
    memory(
        &f,
        "claude/outreach.md",
        "Survey outreach",
        "Survey outreach uses short LinkedIn drafts.",
    );
    for governed in [false, true] {
        f.project["governed"] = json!(governed);
        db::upsert(
            &f.db,
            "projects",
            f.project["id"].as_str().unwrap(),
            "",
            &f.project,
        )
        .unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        let hook = |event: &str, prompt: &str| {
            native::hook(
                "codex",
                json!({"cwd":f.root,"session_id":session,"hook_event_name":event,"prompt":prompt}),
            )
            .unwrap()
        };
        let bootstrap = hook("SessionStart", "");
        assert!(!bootstrap.to_string().contains("Developer ID"));
        assert!(!bootstrap.to_string().contains("LinkedIn"));
        let signing = hook("UserPromptSubmit", "Check signing notarization");
        assert!(signing.to_string().contains("Developer ID"));
        assert!(!signing.to_string().contains("LinkedIn"));
        assert_eq!(
            hook("UserPromptSubmit", "Check signing notarization"),
            json!({})
        );
        let outreach = hook("UserPromptSubmit", "Survey outreach LinkedIn drafts");
        assert!(outreach.to_string().contains("LinkedIn"));
        assert!(!outreach.to_string().contains("Developer ID"));
        let content =
            format!("Signing notarization requires Developer ID and verified ticket {governed}.");
        fact["files"][0]["hash"] = json!(db::blob(content.as_bytes()).unwrap());
        db::upsert(
            &f.db,
            "resources",
            fact["resourceId"].as_str().unwrap(),
            f.project["id"].as_str().unwrap(),
            &fact,
        )
        .unwrap();
        assert!(hook("UserPromptSubmit", "Check signing notarization")
            .to_string()
            .contains("verified ticket"));
        assert_eq!(hook("Stop", ""), json!({}));
        assert_eq!(hook("SessionEnd", ""), json!({}));
    }
}

#[test]
fn memory_scanner_ignores_generated_and_gitignored_files_and_retires_drafts() {
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
    assert!(std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(&f.root)
        .status()
        .unwrap()
        .success());
    fs::write(f.root.join(".gitignore"), "ignored/\n").unwrap();
    for directory in [".runtime/fixture", "artifacts/bundle", "ignored", "src"] {
        fs::create_dir_all(f.root.join(directory)).unwrap();
        fs::write(
            f.root.join(directory).join("AGENTS.md"),
            format!("Instructions for {directory}"),
        )
        .unwrap();
    }
    let r = memory(
        &f,
        "instructions/.runtime/fixture/AGENTS.md",
        "Fixture",
        "Preserved fixture content",
    );
    let draft_id = governance::capture(
        &f.db,
        &f.project,
        &r,
        &json!([f.root.join(".runtime/fixture/AGENTS.md")]),
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
    let active: Vec<_> = drafts.iter().filter(|r| r["status"] == "local").collect();
    assert_eq!(active.len(), 1);
    assert_eq!(
        active[0]["resource"]["logicalPath"],
        "instructions/src/AGENTS.md"
    );
    let retired = drafts.iter().find(|r| r["id"] == draft_id).unwrap();
    assert_eq!(retired["status"], "dismissed");
    assert_eq!(
        db::blob_read(retired["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap(),
        b"Preserved fixture content"
    );
}

#[test]
fn memory_scanner_respects_nested_repositories_ignore_rules() {
    for parent_is_repository in [false, true] {
        let f = Fixture::new();
        if parent_is_repository {
            instruction_git(&f.root, &["init", "--quiet"]);
        }
        let nested = f.root.join("apps/repo");
        fs::create_dir_all(&nested).unwrap();
        instruction_git(&nested, &["init", "--quiet"]);
        write_instruction_ignore_fixture(&nested);

        assert_eq!(
            discovered_instruction_paths(&f),
            vec![
                "instructions/apps/repo/.config/AGENTS.override.md",
                "instructions/apps/repo/AGENTS.md",
                "instructions/apps/repo/docs/keep/CLAUDE.md",
            ],
            "parent repository: {parent_is_repository}"
        );
    }
}

#[test]
fn memory_scanner_reports_progress_for_allowed_nested_instructions() {
    let f = Fixture::new();
    let nested = f.root.join("apps/repo");
    fs::create_dir_all(&nested).unwrap();
    instruction_git(&nested, &["init", "--quiet"]);
    write_instruction_ignore_fixture(&nested);
    let mut project = f.project.clone();
    project["sharing"] =
        json!({"memory":true,"skill":false,"plan":false,"session":false,"env":false});

    indexer::scan_with_progress(&f.db, &project).unwrap();

    let progress = db::get(&f.db, "syncProgress").unwrap();
    assert_eq!(progress["label"], "Checking local files");
    assert_eq!(progress["detail"], "test · apps/repo/docs/keep/CLAUDE.md");
    assert_eq!(progress["total"], Value::Null);
}

#[test]
fn memory_scanner_respects_submodule_ignore_rules() {
    let f = Fixture::new();
    let origin = f._home.path().join("submodule-origin");
    fs::create_dir(&origin).unwrap();
    instruction_git(&origin, &["init", "--quiet"]);
    fs::write(origin.join(".gitignore"), "private/\n").unwrap();
    fs::write(origin.join("AGENTS.md"), "Public instructions\n").unwrap();
    instruction_git(&origin, &["add", "."]);
    instruction_git(
        &origin,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "--quiet",
            "-m",
            "Fixture submodule",
        ],
    );
    instruction_git(&f.root, &["init", "--quiet"]);
    instruction_git(
        &f.root,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "--quiet",
            origin.to_str().unwrap(),
            "modules/repo",
        ],
    );
    let submodule = f.root.join("modules/repo");
    assert!(submodule.join(".git").is_file());
    write_instruction_ignore_fixture(&submodule);

    assert_eq!(
        discovered_instruction_paths(&f),
        vec![
            "instructions/modules/repo/.config/AGENTS.override.md",
            "instructions/modules/repo/AGENTS.md",
            "instructions/modules/repo/docs/keep/CLAUDE.md",
        ]
    );
}

#[test]
fn memory_scanner_respects_gitignore_without_a_repository() {
    let f = Fixture::new();
    fs::create_dir_all(f.root.join("docs/private")).unwrap();
    fs::write(f.root.join("AGENTS.md"), "Public instructions\n").unwrap();
    fs::write(f.root.join("docs/.gitignore"), "private/\n").unwrap();
    fs::write(f.root.join("docs/private/CLAUDE.md"), "Ignored\n").unwrap();
    assert_eq!(
        discovered_instruction_paths(&f),
        vec!["instructions/AGENTS.md"]
    );
}

#[test]
fn memory_scanner_preserves_tracked_instructions_and_nested_repository_boundaries() {
    let f = Fixture::new();
    instruction_git(&f.root, &["init", "--quiet"]);
    fs::write(f.root.join("AGENTS.md"), "Tracked instructions\n").unwrap();
    instruction_git(&f.root, &["add", "AGENTS.md"]);
    fs::write(f.root.join(".gitignore"), "AGENTS.md\nprivate/\n").unwrap();
    let nested = f.root.join("repo");
    fs::create_dir_all(nested.join("private")).unwrap();
    instruction_git(&nested, &["init", "--quiet"]);
    fs::write(nested.join("private/CLAUDE.md"), "Nested instructions\n").unwrap();

    assert_eq!(
        discovered_instruction_paths(&f),
        vec![
            "instructions/AGENTS.md",
            "instructions/repo/private/CLAUDE.md",
        ]
    );
}

#[test]
fn memory_scanner_retires_drafts_ignored_by_a_nested_repository() {
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
    let nested = f.root.join("repo");
    fs::create_dir_all(nested.join("private")).unwrap();
    instruction_git(&nested, &["init", "--quiet"]);
    fs::write(
        nested.join("private/AGENTS.md"),
        "Recoverable instructions\n",
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let draft = db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .remove(0);
    assert_eq!(draft["status"], "local");

    fs::write(nested.join(".gitignore"), "private/\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let retired = db::rows(
        &f.db,
        "SELECT value FROM drafts WHERE id=?",
        &[&draft["id"].as_str().unwrap()],
    )
    .unwrap()
    .remove(0);
    assert_eq!(retired["status"], "dismissed");
    assert_eq!(retired["dismissalReason"], "ignored_source");
    assert_eq!(
        db::blob_read(retired["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap(),
        b"Recoverable instructions\n"
    );
    assert!(nested.join("private/AGENTS.md").exists());
}

#[test]
fn memory_scanner_preserves_drafts_when_git_ignore_checks_fail() {
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
    let nested = f.root.join("repo");
    fs::create_dir(&nested).unwrap();
    instruction_git(&nested, &["init", "--quiet"]);
    fs::write(nested.join("AGENTS.md"), "Preserved instructions\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
    fs::remove_dir_all(nested.join(".git")).unwrap();
    fs::write(nested.join(".git"), "gitdir: missing-repository\n").unwrap();

    assert!(indexer::scan(&f.db, &f.project).is_err());
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap(),
        drafts
    );
    assert!(f.outbox().is_empty());
}

#[test]
fn memory_scanner_preserves_missing_drafts_unless_git_ignores_them() {
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
    let nested = f.root.join("repo");
    fs::create_dir_all(nested.join("removed")).unwrap();
    instruction_git(&nested, &["init", "--quiet"]);
    fs::write(nested.join("removed/AGENTS.md"), "Recoverable draft\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
    fs::remove_dir_all(nested.join("removed")).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap(),
        drafts
    );

    fs::write(nested.join(".gitignore"), "removed/\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap()[0]["status"],
        "dismissed"
    );
}

fn instruction_git(root: &Path, args: &[&str]) -> String {
    let mut command = std::process::Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command
        .arg("-C")
        .arg(root)
        .args(["-c", "core.excludesFile=/dev/null"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn write_instruction_ignore_fixture(root: &Path) {
    fs::write(root.join(".gitignore"), "private/\n").unwrap();
    for directory in ["private", "local", "docs/drop", "docs/keep", ".config"] {
        fs::create_dir_all(root.join(directory)).unwrap();
    }
    fs::write(root.join("docs/.gitignore"), "/*\n!/keep/\n").unwrap();
    let exclude = instruction_git(
        root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "info/exclude",
        ],
    );
    fs::write(exclude, "local/\n").unwrap();
    for file in [
        "AGENTS.md",
        "private/AGENTS.md",
        "local/CLAUDE.md",
        "docs/drop/AGENTS.override.md",
        "docs/keep/CLAUDE.md",
        ".config/AGENTS.override.md",
    ] {
        fs::write(root.join(file), "Synthetic instructions\n").unwrap();
    }
}

fn discovered_instruction_paths(f: &Fixture) -> Vec<String> {
    let mut paths: Vec<_> = indexer::discover(&f.db, &f.project, "memory")
        .unwrap()
        .into_iter()
        .map(|entry| {
            entry["resource"]["logicalPath"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    paths.sort();
    paths
}

#[test]
fn codex_discovery_uses_stable_thread_identity_and_durable_evidence() {
    let f = Fixture::new();
    let summaries = f._home.path().join(".codex/memories/rollout_summaries");
    fs::create_dir_all(&summaries).unwrap();
    let thread = uuid::Uuid::new_v4();
    for (name, date) in [("old.md", "2026-10-01"), ("renamed.md", "2026-10-21")] {
        fs::write(
            summaries.join(name),
            format!(
                "thread_id: {thread}\nupdated_at: {date}\ncwd: {}\n\nSigning certificate knowledge",
                f.root.display()
            ),
        )
        .unwrap();
    }
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.resources().len(), 1);
    assert_eq!(
        f.resources()[0]["logicalPath"],
        format!("codex/summaries/{thread}.md")
    );
    fs::write(
        f._home.path().join(".codex/memories/MEMORY.md"),
        "# Signing\n- rollout_summaries/old.md\n\nSigning certificate knowledge",
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let entries = memory_context::catalog(&f.db, &f.project).unwrap();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].resource["logicalPath"]
        .as_str()
        .unwrap()
        .starts_with("codex/entries/"));
}
