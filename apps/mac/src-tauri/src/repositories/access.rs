use super::*;
use std::collections::HashSet;

static CHECKED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
static LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) async fn status(context: &Context, input: Value) -> Result<Value> {
    let project = input["projectId"].as_str().ok_or("Missing project")?;
    let id = input["sourceId"].as_str().ok_or("Missing source")?;
    let key = format!("repository-access:{project}:{id}");
    let scope = format!(
        "{}:{key}",
        db::profile_path(&context.user, &context.service)?.display()
    );
    let started = chrono::Utc::now();
    let lock = LOCKS
        .lock()
        .map_err(|_| "Repository access lock unavailable")?
        .entry(scope.clone())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone();
    let _guard = lock.lock().await;
    context.check()?;
    let current = source(context, project, id)?;
    if !current["repository"]["id"].is_string() {
        return Err("This source has no GitHub repository".into());
    }
    if input
        .get("repositoryId")
        .is_some_and(|id| *id != current["repository"]["id"])
        || input
            .get("bindingRevision")
            .is_some_and(|revision| *revision != current["repository"]["revision"])
    {
        return Err("Repository link changed; refresh this project".into());
    }
    let db = context.database()?;
    let auth_revision = db::get(&db, "repository-auth-revision")?;
    let saved = db::get(&db, &key)?;
    let marker = format!(
        "{scope}:{}:{}:{}",
        current["repository"]["id"], current["repository"]["revision"], auth_revision
    );
    let checked = saved["checkedAt"]
        .as_str()
        .and_then(|date| chrono::DateTime::parse_from_rfc3339(date).ok());
    let same_binding = saved["repositoryId"] == current["repository"]["id"]
        && saved["bindingRevision"] == current["repository"]["revision"]
        && saved["authRevision"] == auth_revision;
    let today = checked.is_some_and(|date| {
        date.with_timezone(&chrono::Local).date_naive() == chrono::Local::now().date_naive()
    });
    let checked_this_launch = CHECKED
        .lock()
        .map_err(|_| "Repository access lock unavailable")?
        .contains(&marker);
    let just_checked = checked.is_some_and(|date| date >= started);
    if same_binding && today && checked_this_launch && (input["force"] != true || just_checked) {
        return Ok(saved);
    }
    let result = match context
        .api("access", json!({"projectId":project,"sourceId":id}))
        .await
    {
        Ok(value) => value,
        Err(error) => {
            CHECKED
                .lock()
                .map_err(|_| "Repository access lock unavailable")?
                .remove(&marker);
            return Err(error);
        }
    };
    if !["ready", "not_connected", "reconnect", "access_unavailable"]
        .iter()
        .any(|state| result["state"] == *state)
    {
        return Err("The service returned an invalid access status".into());
    }
    let _lock = projects::lock()?;
    context.check()?;
    let latest = source(context, project, id)?;
    if latest["repository"] != current["repository"]
        || db::get(&context.database()?, "repository-auth-revision")? != auth_revision
    {
        return Err("Repository or GitHub account changed; try again".into());
    }
    let result = json!({"state":result["state"],"checkedAt":db::now(),"repositoryId":current["repository"]["id"],"bindingRevision":current["repository"]["revision"],"authRevision":auth_revision});
    db::set(&context.database()?, &key, &result)?;
    CHECKED
        .lock()
        .map_err(|_| "Repository access lock unavailable")?
        .insert(marker);
    Ok(result)
}
