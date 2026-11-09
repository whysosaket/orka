use super::*;
use crate::repositories::{repository_command, Context};

#[test]
fn repository_commands_reject_stale_context_and_never_expose_clone_credentials() {
    let f = Fixture::new();
    let user = db::get(&f.db, "user").unwrap();
    db::set(
        &f.db,
        "config",
        &json!({"apiUrl":"https://selected.example"}),
    )
    .unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let wrong: Context =
        serde_json::from_value(json!({"user":user,"service":"https://other.example"})).unwrap();
    assert!(runtime
        .block_on(repository_command("jobs".into(), json!({}), wrong))
        .unwrap_err()
        .contains("Account or service changed"));
    let context: Context =
        serde_json::from_value(json!({"user":user,"service":"https://selected.example"})).unwrap();
    assert_eq!(
        runtime
            .block_on(repository_command(
                "clone-credentials".into(),
                json!({}),
                context.clone()
            ))
            .unwrap_err(),
        "Unknown repository operation"
    );
    assert!(runtime
        .block_on(repository_command(
            "open-github".into(),
            json!({"url":"file:///private/data"}),
            context
        ))
        .is_err());
}

#[test]
fn interrupted_jobs_are_recoverable_and_service_scoped() {
    let f = Fixture::new();
    let user = db::get(&f.db, "user").unwrap();
    db::set(
        &f.db,
        "config",
        &json!({"apiUrl":"https://selected.example"}),
    )
    .unwrap();
    db::profile(user.as_str().unwrap()).unwrap();
    let account = db::open().unwrap();
    db::set(&account, "user", &user).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    db::set(
        &account,
        &format!("repository-job:{id}"),
        &json!({"id":id,"state":"cloning","destination":f.root,"createdAt":db::now()}),
    )
    .unwrap();
    let context: Context =
        serde_json::from_value(json!({"user":user,"service":"https://selected.example"})).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let jobs = runtime
        .block_on(repository_command(
            "jobs".into(),
            json!({}),
            context.clone(),
        ))
        .unwrap();
    assert_eq!(jobs[0]["state"], "interrupted");
    assert!(f.root.exists(), "Recovery must not delete user directories");
    assert!(runtime
        .block_on(repository_command(
            "retry-connect".into(),
            json!({"id":uuid::Uuid::new_v4().to_string()}),
            context
        ))
        .is_err());
}
