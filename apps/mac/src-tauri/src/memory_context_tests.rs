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
