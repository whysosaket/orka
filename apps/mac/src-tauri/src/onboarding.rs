//! First-run consent, durable receipts, and local setup state.
mod discovery;
mod install;
use crate::{
    commands,
    db::{self, Result},
    native, sync,
};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
fn draft_path() -> Result<PathBuf> {
    Ok(db::root()?.join("onboarding.json"))
}
fn read_json(path: PathBuf) -> Result<Value> {
    match fs::read(path) {
        Ok(v) => {
            let value: Value =
                serde_json::from_slice(&v).map_err(|_| "Could not read onboarding progress")?;
            Ok(value)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}
fn scoped_path(user: &Value, service: &Value) -> Result<PathBuf> {
    Ok(db::root()?.join("onboarding-drafts").join(format!(
        "{}.json",
        db::digest(format!("{}:{}", service, user).as_bytes())
    )))
}
fn read_draft() -> Result<Value> {
    let db = db::open()?;
    let user = db::get(&db, "user")?;
    let service = db::get(&db, "config")?["apiUrl"].clone();
    if user.is_string() {
        let saved = read_json(scoped_path(&user, &service)?)?;
        if !saved.is_null() {
            return Ok(saved);
        }
    }
    let saved = read_json(draft_path()?)?;
    if saved["owner"].is_null()
        || user.is_null()
        || (saved["owner"] == user && saved["service"] == service)
    {
        Ok(saved)
    } else {
        Ok(Value::Null)
    }
}
fn state_lock() -> Result<fs::File> {
    let root = db::root()?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(root.join("onboarding-state.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock_exclusive().map_err(|e| e.to_string())?;
    Ok(lock)
}
fn write_draft(value: &Value) -> Result<()> {
    write_draft_in(&db::open()?, value)
}
fn write_draft_in(db: &rusqlite::Connection, value: &Value) -> Result<()> {
    let path = draft_path()?;
    fs::create_dir_all(path.parent().ok_or("Missing onboarding directory")?)
        .map_err(|e| e.to_string())?;
    db::atomic(&path, value.to_string().as_bytes())?;
    if value["owner"].is_string() {
        let scoped = scoped_path(&value["owner"], &value["service"])?;
        fs::create_dir_all(scoped.parent().ok_or("Missing draft directory")?)
            .map_err(|e| e.to_string())?;
        db::atomic(&scoped, value.to_string().as_bytes())?;
    }
    db::set(db, "onboarding", value)
}
fn tools() -> Value {
    json!({"claude":{"installed":native::binary("claude").is_ok()},"codex":{"installed":native::binary("codex").is_ok()}})
}
pub fn snapshot(db: &rusqlite::Connection) -> Result<Value> {
    let user = db::get(db, "user")?;
    let config = db::get(db, "config")?;
    let saved = read_draft()?;
    let matches = (saved["owner"].is_null() || saved["owner"] == user)
        && (saved["service"].is_null() || saved["service"] == config["apiUrl"]);
    let completed = db::get(db, "onboardingComplete")? == true
        || ((matches || user.is_null()) && !saved["draft"]["completedAt"].is_null());
    let has_projects = !db::rows(db, "SELECT value FROM projects LIMIT 1", &[])?.is_empty();
    // Explicitly seeded debug profiles can replay first run without resetting
    // the normal account. Other development profiles keep their existing flow.
    let eligible = crate::profiles::current() == "default"
        || (cfg!(debug_assertions) && saved["active"] == true);
    let active = eligible && !completed && (matches && saved["active"] == true || !has_projects);
    let first = db::get(db, "firstLaunchAt")?;
    let first = if first.is_null() {
        let now = json!(db::now());
        db::set(db, "firstLaunchAt", &now)?;
        now
    } else {
        first
    };
    Ok(
        json!({"active":active,"draft":if active && matches {saved["draft"].clone()} else {Value::Null},"firstLaunchAt":first,"location":install::location()?,"auth":Value::Null}),
    )
}
fn checkpoint(mut input: Value) -> Result<Value> {
    let _state_lock = state_lock()?;
    let step = input["step"].as_str().ok_or("Missing onboarding step")?;
    if ![
        "location",
        "profile",
        "invite",
        "background",
        "background-off",
        "partial-access",
        "finish-setup",
        "claude",
        "codex",
        "discover",
        "folder",
        "scanning",
        "empty",
        "access-error",
        "select",
        "setup",
        "methods",
        "server-check",
        "server-error",
        "github",
        "email",
        "auth-error",
        "email-code",
        "review",
        "syncing",
        "sync-error",
        "offline",
        "retrying",
        "ready",
    ]
    .contains(&step)
        || input.to_string().len() > 1_000_000
    {
        return Err("Invalid onboarding progress".into());
    }
    let db = db::open()?;
    let user = db::get(&db, "user")?;
    let config = db::get(&db, "config")?;
    let saved = read_draft()?;
    if !saved["owner"].is_null() && saved["owner"] != user {
        return Err("Account changed. Reopen onboarding for this account.".into());
    }
    if input["startedAt"].is_null() {
        input["startedAt"] = json!(db::now());
    }
    let completed = !saved["draft"]["completedAt"].is_null();
    if completed {
        input["completedAt"] = saved["draft"]["completedAt"].clone();
    }
    let same_scope = saved["owner"] == user && saved["service"] == config["apiUrl"];
    let receipts = if same_scope {
        saved["connected"].clone()
    } else {
        json!({})
    };
    let creating = if same_scope {
        saved["creating"].clone()
    } else {
        json!({})
    };
    write_draft(
        &json!({"active":!completed,"owner":user,"service":config["apiUrl"],"draft":input,"connected":receipts,"creating":creating}),
    )?;
    Ok(json!({"ok":true}))
}
fn matching_source(project: &Value, path: &str) -> Option<String> {
    let sources = project["sources"].as_array()?;
    let name = std::path::Path::new(path).file_name()?.to_string_lossy();
    if let Some(source) = sources.iter().find(|source| source["path"] == path) {
        return source["id"].as_str().map(str::to_string);
    }
    let matches: Vec<_> = sources
        .iter()
        .filter(|source| source["name"] == name.as_ref())
        .collect();
    let source = match matches.as_slice() {
        [source] => *source,
        [] if sources.len() == 1 => &sources[0],
        _ => return None,
    };
    source["id"].as_str().map(str::to_string)
}
async fn review(input: Value) -> Result<Value> {
    let paths = input["paths"].as_array().ok_or("Select projects first")?;
    let db = db::open()?;
    let config = db::get(&db, "config")?;
    let supported =
        crate::auth::capabilities(config["apiUrl"].as_str().ok_or("Sign in first")?.into()).await?
            ["onboarding"]
            == 1;
    let catalog = sync::api("GET", "/v2/projects", None).await?;
    crate::projects::merge_catalog(&db, &catalog)?;
    let mut matches = serde_json::Map::new();
    for path in paths.iter().filter_map(Value::as_str) {
        let key = if supported {
            discovery::remote_key(path)?
        } else {
            None
        };
        let mut projects: Vec<_> = catalog
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| key.is_some() && p["remoteKey"].as_str() == key.as_deref())
            .cloned()
            .collect();
        let requires_choice = projects.is_empty();
        if requires_choice {
            projects = catalog.as_array().into_iter().flatten().cloned().collect();
        }
        for project in &mut projects {
            project["sourceId"] = json!(matching_source(project, path));
        }
        projects
            .sort_by_key(|p| std::cmp::Reverse(p["lastSyncAt"].as_str().unwrap_or("").to_string()));
        matches.insert(
            path.into(),
            json!({"remoteKey":key,"projects":projects,"requiresChoice":requires_choice}),
        );
    }
    Ok(json!({"matches":matches,"supported":supported}))
}

async fn connect(input: Value) -> Result<Value> {
    let db = db::open()?;
    let user = db::get(&db, "user")?;
    if !user.is_string() {
        return Err("Sign in before connecting projects".into());
    }
    let path = fs::canonicalize(input["path"].as_str().ok_or("Choose a project folder")?)
        .map_err(|_| "Project folder is unavailable")?;
    let mut saved = read_draft()?;
    if saved["owner"] != user || saved["service"] != db::get(&db, "config")?["apiUrl"] {
        return Err("Onboarding belongs to another account or service".into());
    }
    if !saved["draft"]["selected"]
        .as_array()
        .is_some_and(|s| s.iter().any(|p| p.as_str() == path.to_str()))
        || !["syncing", "retrying"].contains(&saved["draft"]["step"].as_str().unwrap_or(""))
    {
        return Err("Review this project before connecting it".into());
    }
    let name = input["name"].as_str().unwrap_or("").trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err("Enter a project name of up to 100 characters".into());
    }
    let mut sharing = input["sharing"].clone();
    sharing["env"] = json!(false);
    serde_json::from_value::<crate::projects::Sharing>(sharing.clone())
        .map_err(|_| "Review what to share first")?;
    let key = db::digest(path.to_string_lossy().as_bytes());
    let local: Vec<_> = db::rows(&db, "SELECT value FROM projects", &[])?
        .into_iter()
        .filter(|project| {
            crate::sources::views(project)
                .iter()
                .any(|view| view["path"].as_str() == path.to_str())
        })
        .collect();
    let id = if let Some(id) = local.first().and_then(|p| p["id"].as_str()) {
        id.to_string()
    } else if let Some(id) = saved["connected"][&key]
        .as_str()
        .or(input["existingId"].as_str())
    {
        id.to_string()
    } else {
        let mut request = json!({"name":name,"sharing":sharing});
        if let Some(key) = input["remoteKey"].as_str() {
            request["remoteKey"] = json!(key);
        }
        // A lost HTTP response must not create the project twice after relaunch.
        let config = db::get(&db, "config")?;
        let supports_receipts =
            crate::auth::capabilities(config["apiUrl"].as_str().ok_or("Sign in first")?.into())
                .await?["onboarding"]
                == 1;
        if supports_receipts {
            let _state_lock = state_lock()?;
            saved = read_draft()?;
            let request_id = saved["creating"][&key]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            if !saved["creating"].is_object() {
                saved["creating"] = json!({});
            }
            saved["creating"][&key] = json!(request_id);
            write_draft(&saved)?;
            request["requestId"] = json!(request_id);
        }
        let result = commands::cloud_action("create".into(), request).await?;
        let id = result["id"]
            .as_str()
            .ok_or("The service did not return a project")?
            .to_string();
        let _state_lock = state_lock()?;
        saved = read_draft()?;
        if !saved["connected"].is_object() {
            saved["connected"] = json!({});
        }
        saved["connected"][&key] = json!(id);
        write_draft(&saved)?;
        id
    };
    // The catalog supplies membership and role. Save consent before connect can scan.
    if input["existingId"].is_string() {
        let catalog = sync::api("GET", "/v2/projects", None).await?;
        crate::projects::merge_catalog(&db, &catalog)?;
    }
    let project = crate::governance::project(&db, &id)?;
    let source_id = input["sourceId"]
        .as_str()
        .map(str::to_string)
        .or_else(|| matching_source(&project, &path.to_string_lossy()));
    if project["sources"]
        .as_array()
        .is_some_and(|sources| !sources.is_empty())
        && source_id.is_none()
    {
        return Err("Choose which repository this folder should connect to before syncing".into());
    }
    crate::projects::project_command("sharing".into(), json!({"projectId":id,"sharing":sharing}))
        .await?;
    crate::sources::connect_project_sources(
        id.clone(),
        vec![path.to_string_lossy().into()],
        source_id,
    )
    .await?;
    if project["role"] == "owner"
        && project["remoteKey"].is_null()
        && input["remoteKey"].is_string()
    {
        let result = sync::api(
            "POST",
            "/v2/projects/action",
            Some(&json!({"action":"set-remote","projectId":id,"remoteKey":input["remoteKey"]})),
        )
        .await;
        // Another Mac can fill the hint first; its value must never be overwritten.
        if let Err(error) = result {
            if !error.starts_with("409:") {
                return Err(error);
            }
        }
    }
    Ok(json!({"id":id}))
}
fn project_sync_status(
    db: &rusqlite::Connection,
    id: &str,
    sync_error: Option<&str>,
) -> Result<Value> {
    let issues=db::rows(db,"SELECT json_object('error',error) FROM errors WHERE source=? OR substr(source,1,length(?)+1)=?||':' OR source IN (SELECT id FROM resources WHERE project=?)",&[&id,&id,&id,&id])?;
    let pending = db::rows(
        db,
        "SELECT json_object('error',error) FROM outbox WHERE project=?",
        &[&id],
    )?;
    let scanned = db::get(db, &format!("firstScan:{id}"))?.is_string();
    let issue = issues
        .first()
        .and_then(|p| p["error"].as_str())
        .map(String::from)
        .or_else(|| {
            pending
                .first()
                .and_then(|p| p["error"].as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
        });
    let status = if issue.is_some() {
        "error"
    } else if scanned && pending.is_empty() && sync_error.is_none() {
        "synced"
    } else {
        "syncing"
    };
    let conflicts = db::rows(db, "SELECT value FROM conflicts WHERE project=?", &[&id])?.len();
    let review_pending = db::rows(db, "SELECT value FROM drafts WHERE project=? AND json_extract(value,'$.status') IN ('local','proposed')", &[&id])?.len();
    let items = db::rows(db, "SELECT value FROM resources WHERE project=? AND coalesce(json_extract(value,'$.deleted'),0)=0", &[&id])?.len()
        + review_pending;
    Ok(
        json!({"id":id,"status":status,"error":issue,"conflicts":conflicts,"pending":pending.len(),"items":items,"reviewPending":review_pending}),
    )
}
fn offline_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("cloud unavailable")
        || error.contains("cannot reach")
        || error == "blob download failed"
        || error == "blob upload failed; retry retained"
        || ["408:", "502:", "503:", "504:"]
            .iter()
            .any(|prefix| error.starts_with(prefix))
}
fn failed_sync_step(draft: &Value) -> &'static str {
    let offline = draft["projects"].as_array().into_iter().flatten().any(|p| {
        draft["selected"]
            .as_array()
            .is_some_and(|selected| selected.contains(&p["path"]))
            && p["status"] == "error"
            && p["error"].as_str().is_some_and(offline_error)
    });
    if offline {
        "offline"
    } else {
        "sync-error"
    }
}
async fn synchronize(input: Value) -> Result<Value> {
    let ids = input["projectIds"]
        .as_array()
        .ok_or("Select projects to sync")?;
    if ids.is_empty() {
        return Err("No projects are connected yet".into());
    }
    let error = sync::onboarding_once().await.err();
    if error
        .as_deref()
        .is_some_and(|e| e.contains("operation is in progress"))
    {
        return Err(error.unwrap());
    }
    let db = db::open()?;
    let projects = ids
        .iter()
        .filter_map(Value::as_str)
        .map(|id| project_sync_status(&db, id, error.as_deref()))
        .collect::<Result<Vec<_>>>()?;
    Ok(
        json!({"projects":projects,"error":error,"offline":error.as_deref().is_some_and(offline_error)}),
    )
}
fn patch_job(change: &Value) -> Result<Value> {
    let _state_lock = state_lock()?;
    let mut saved = read_draft()?;
    if let Some(fields) = change.as_object() {
        for (key, value) in fields {
            saved["draft"][key] = value.clone();
        }
    }
    write_draft(&saved)?;
    Ok(saved["draft"].clone())
}
fn patch_project(path: &str, change: Value) -> Result<()> {
    let _state_lock = state_lock()?;
    let mut saved = read_draft()?;
    if let Some(projects) = saved["draft"]["projects"].as_array_mut() {
        if let Some(project) = projects.iter_mut().find(|p| p["path"] == path) {
            for (key, value) in change.as_object().ok_or("Invalid progress")? {
                project[key] = value.clone();
            }
        }
    }
    write_draft(&saved)
}
async fn busy_retry<F, Fut>(mut task: F) -> Result<Value>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<Value>>,
{
    for attempt in 0..=5 {
        match task().await {
            Err(e) if attempt < 5 && e.contains("operation is in progress") => {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await
            }
            result => return result,
        }
    }
    Err("A sync or project operation is in progress".into())
}
fn sync_lock() -> Result<fs::File> {
    let lock_path = db::root()?.join("onboarding-sync.lock");
    fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(lock_path)
        .map_err(|e| e.to_string())
}
pub fn sync_running() -> Result<bool> {
    let lock = sync_lock()?;
    match lock.try_lock_exclusive() {
        Ok(()) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(true),
        Err(error) => Err(error.to_string()),
    }
}
async fn batch_sync(retry: bool, connections_only: bool) -> Result<Value> {
    let lock = sync_lock()?;
    lock.try_lock_exclusive()
        .map_err(|_| "A sync or project operation is in progress")?;
    let owner = db::get(&db::open()?, "user")?;
    let service = db::get(&db::open()?, "config")?["apiUrl"].clone();
    let saved = read_draft()?;
    if saved["owner"] != owner || saved["service"] != service {
        return Err("Account or service changed".into());
    }
    if saved["draft"]["reviewed"] != true {
        return Err("Review what will sync before connecting projects".into());
    }
    let selected = saved["draft"]["selected"]
        .as_array()
        .ok_or("Review your selected projects")?;
    let projects = saved["draft"]["projects"]
        .as_array()
        .ok_or("Review your selected projects")?;
    if selected.is_empty()
        || selected
            .iter()
            .any(|path| !path.is_string() || !projects.iter().any(|p| &p["path"] == path))
    {
        return Err("Choose at least one of your discovered projects".into());
    }
    for project in projects.iter().filter(|p| selected.contains(&p["path"])) {
        let path = project["path"].as_str().ok_or("Missing project folder")?;
        let matches = &saved["draft"]["matches"][path];
        if (matches["requiresChoice"] == true
            || matches["projects"]
                .as_array()
                .is_some_and(|matches| matches.len() > 1))
            && matches["projects"]
                .as_array()
                .is_some_and(|matches| !matches.is_empty())
            && !saved["draft"]["choices"][path]
                .as_str()
                .is_some_and(|choice| !choice.is_empty())
        {
            return Err("Choose which existing Orka project this folder should connect to".into());
        }
    }
    if !db::daemon_running()? {
        db::set(&db::open()?, "syncProgress", &Value::Null)?;
    }
    patch_job(&json!({"step":if retry{"retrying"}else{"syncing"}}))?;
    for project in projects.iter().filter(|p| {
        selected.contains(&p["path"])
            && (!connections_only || !p["projectId"].is_string())
            && (!retry || !["synced", "skipped"].contains(&p["status"].as_str().unwrap_or("")))
    }) {
        if db::get(&db::open()?, "user")? != owner
            || db::get(&db::open()?, "config")?["apiUrl"] != service
        {
            return Err("Account or service changed".into());
        }
        let path = project["path"].as_str().ok_or("Missing project folder")?;
        patch_project(
            path,
            json!({"status":if project["projectId"].is_string(){"connecting"}else{"creating"},"error":null,"syncStartedAt":chrono::Utc::now().timestamp_millis()}),
        )?;
        let d = &saved["draft"];
        let sharing = if d["overrides"][path].is_object() {
            d["overrides"][path].clone()
        } else if d["sharing"].is_object() {
            d["sharing"].clone()
        } else {
            json!({"skill":true,"memory":true,"plan":true,"session":false,"env":false})
        };
        let mut input = json!({"path":path,"name":d["names"][path].as_str().or(project["name"].as_str()).unwrap_or(""),"sharing":sharing});
        if let Some(key) = d["matches"][path]["remoteKey"].as_str() {
            input["remoteKey"] = json!(key);
        }
        if let Some(id) = d["choices"][path]
            .as_str()
            .filter(|s| !s.is_empty() && *s != "new")
        {
            input["existingId"] = json!(id);
        }
        if let Some(source) = d["sourceChoices"][path]
            .as_str()
            .filter(|id| !id.is_empty())
        {
            input["sourceId"] = json!(source);
        }
        match busy_retry(|| connect(input.clone())).await {
            Ok(result) => {
                patch_project(path, json!({"projectId":result["id"],"status":"scanning"}))?
            }
            Err(e) => patch_project(path, json!({"status":"error","error":e}))?,
        }
    }
    if connections_only {
        let draft = read_draft()?["draft"].clone();
        if let Some(project) = draft["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|project| {
                selected.contains(&project["path"])
                    && !project["projectId"].is_string()
                    && project["status"] != "skipped"
            })
        {
            patch_job(&json!({"step":failed_sync_step(&draft)}))?;
            return Err(project["error"]
                .as_str()
                .unwrap_or("Could not connect the selected project")
                .into());
        }
        return Ok(draft);
    }
    loop {
        if db::get(&db::open()?, "user")? != owner
            || db::get(&db::open()?, "config")?["apiUrl"] != service
        {
            return Err("Account or service changed".into());
        }
        let d = read_draft()?["draft"].clone();
        let mut ids = vec![];
        for p in d["projects"].as_array().into_iter().flatten().filter(|p| {
            d["selected"]
                .as_array()
                .is_some_and(|s| s.contains(&p["path"]))
                && p["projectId"].is_string()
                && !["error", "skipped"].contains(&p["status"].as_str().unwrap_or(""))
        }) {
            if !ids.contains(&p["projectId"]) {
                ids.push(p["projectId"].clone());
            }
        }
        if ids.is_empty() {
            return patch_job(&json!({"step":failed_sync_step(&d)}));
        }
        let result = busy_retry(|| synchronize(json!({"projectIds":ids}))).await?;
        for row in result["projects"].as_array().into_iter().flatten() {
            for p in d["projects"].as_array().into_iter().flatten().filter(|p| {
                p["projectId"] == row["id"]
                    && d["selected"]
                        .as_array()
                        .is_some_and(|selected| selected.contains(&p["path"]))
                    && !["error", "skipped"].contains(&p["status"].as_str().unwrap_or(""))
            }) {
                let mut row = row.clone();
                row["durationMs"] = json!(
                    chrono::Utc::now().timestamp_millis()
                        - p["syncStartedAt"]
                            .as_i64()
                            .unwrap_or(chrono::Utc::now().timestamp_millis())
                );
                patch_project(p["path"].as_str().unwrap_or(""), row)?;
            }
        }
        if result["offline"] == true {
            return patch_job(&json!({"step":"offline"}));
        }
        if result["error"].is_string() {
            return patch_job(&json!({"step":"sync-error","error":result["error"]}));
        }
        if result["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|p| p["status"] == "syncing")
        {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }
        let d = read_draft()?["draft"].clone();
        let failed = d["projects"].as_array().into_iter().flatten().any(|p| {
            d["selected"]
                .as_array()
                .is_some_and(|s| s.contains(&p["path"]))
                && p["status"] == "error"
        });
        return patch_job(&json!({"step":if failed{failed_sync_step(&d)}else{"ready"}}));
    }
}
fn pending_connections(saved: &Value) -> bool {
    saved["draft"]["completedAt"].is_string()
        && saved["draft"]["reviewed"] == true
        && saved["draft"]["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|project| {
                saved["draft"]["selected"]
                    .as_array()
                    .is_some_and(|selected| selected.contains(&project["path"]))
                    && !project["projectId"].is_string()
                    && project["status"] != "skipped"
            })
}
pub async fn resume_pending_connections() -> Result<()> {
    if !pending_connections(&read_draft()?) {
        return Ok(());
    }
    batch_sync(true, true).await.map(|_| ())
}
pub fn resume_sync() {
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let Ok(saved) = read_draft() else {
        return;
    };
    if saved["draft"]["completedAt"].is_string()
        || !["syncing", "retrying", "offline"]
            .contains(&saved["draft"]["step"].as_str().unwrap_or(""))
        || RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }
    std::thread::spawn(|| {
        if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            let _ = runtime.block_on(batch_sync(true, false));
        }
        RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

fn setup_status() -> Result<Value> {
    let db = db::open()?;
    let mut status = tools();
    for tool in ["claude", "codex"] {
        status[tool]["seenAt"] = db::get(&db, &format!("hookSeen:{tool}"))?;
    }
    Ok(
        json!({"hooks":status,"background":{"enabled":db::get(&db,"background")?==true,"running":db::daemon_running()?},"hidden":db::get(&db,"setupHidden")?,"completedAt":db::get(&db,"setupCompletedAt")?}),
    )
}
#[tauri::command]
pub async fn onboarding_command(
    action: String,
    input: Value,
    context: Option<Value>,
) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let ensure_context = || -> Result<()> {
            if let Some(context) = context.as_ref().filter(|value| !value.is_null()) {
                let db = db::open()?;
                if context["user"] != db::get(&db, "user")?
                    || context["service"] != db::get(&db, "config")?["apiUrl"]
                {
                    return Err("Account or service changed. Reopen onboarding.".into());
                }
            }
            Ok(())
        };
        ensure_context()?;
        match action.as_str() {
            "checkpoint" => {
                let _lock = crate::projects::wait_for_lock(std::time::Duration::from_secs(5))?;
                ensure_context()?;
                checkpoint(input)
            }
            "discover" => discovery::discover(input["path"].as_str()),
            "folder-access" => {
                let path =
                    fs::canonicalize(input["path"].as_str().ok_or("Choose the project folder")?)
                        .map_err(|_| {
                            "Orka couldn’t read this folder. Choose it again to give Orka access."
                        })?;
                let expected = fs::canonicalize(
                    input["expectedPath"]
                        .as_str()
                        .ok_or("Missing project folder")?,
                )
                .map_err(|_| "The original project folder is unavailable")?;
                if path != expected {
                    return Err("Choose the folder shown for this project".into());
                }
                fs::read_dir(path).map_err(|_| {
                    "Orka couldn’t read this folder. Check Files & Folders in System Settings."
                })?;
                Ok(json!({"ok":true}))
            }
            "review" => runtime.block_on(review(input)),
            "connect" => runtime.block_on(connect(input)),
            "sync" => runtime.block_on(synchronize(input)),
            "batch-sync" => runtime.block_on(batch_sync(input["retry"] == true, false)),
            "progress" => Ok(read_draft()?["draft"].clone()),
            "save-profile" => {
                let _lock = crate::projects::lock()?;
                runtime.block_on(crate::account_profile::save(input))
            }
            "profile" => {
                let _lock = crate::projects::lock()?;
                runtime.block_on(crate::account_profile::load())
            }
            "setup-status" => setup_status(),
            "setup-hidden" => {
                db::set(&db::open()?, "setupHidden", &input["hidden"])?;
                setup_status()
            }
            "setup-completed" => {
                db::set(&db::open()?, "setupCompletedAt", &json!(db::now()))?;
                setup_status()
            }
            "open-settings" => install::open_settings(input["kind"].as_str().unwrap_or("privacy")),
            "app-location" => install::location(),
            "complete" => {
                // Completion only changes scoped setup metadata. A running sync
                // keeps its workspace lock and retains the completion receipt.
                let _state_lock = state_lock()?;
                let db = db::open()?;
                let owner = db::get(&db, "user")?;
                let service = db::get(&db, "config")?["apiUrl"].clone();
                if let Some(expected) = context.as_ref().filter(|value| !value.is_null()) {
                    if expected["user"] != owner || expected["service"] != service {
                        return Err("Account or service changed. Reopen onboarding.".into());
                    }
                }
                let scoped = read_json(scoped_path(&owner, &service)?)?;
                let mut saved = if scoped.is_null() {
                    read_json(draft_path()?)?
                } else {
                    scoped
                };
                if !owner.is_string() || saved["owner"] != owner || saved["service"] != service {
                    return Err("Account or service changed. Reopen onboarding.".into());
                }
                saved["draft"]["completedAt"] = json!(db::now());
                saved["active"] = json!(false);
                write_draft_in(&db, &saved)?;
                db::set(&db, "onboardingComplete", &json!(true))?;
                if db::get(&db, "background")?.is_null() {
                    db::set(&db, "background", &json!(false))?;
                }
                db::set(&db, "syncRequest", &json!(uuid::Uuid::new_v4().to_string()))?;
                Ok(json!({"ok":true}))
            }
            _ => Err("Unknown onboarding action".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dismissed_setup_only_retries_reviewed_unconnected_selected_folders() {
        let mut saved = json!({"draft":{"completedAt":"done","reviewed":true,"selected":["/selected"],"projects":[{"path":"/selected","status":"error"},{"path":"/other","status":"error"}]}});
        assert!(pending_connections(&saved));
        saved["draft"]["projects"][0]["projectId"] = json!("connected");
        assert!(!pending_connections(&saved));
        saved["draft"]["projects"][0]["projectId"] = Value::Null;
        saved["draft"]["projects"][0]["status"] = json!("skipped");
        assert!(!pending_connections(&saved));
        saved["draft"]["projects"][0]["status"] = json!("error");
        saved["draft"]["reviewed"] = json!(false);
        assert!(!pending_connections(&saved));
        saved["draft"]["reviewed"] = json!(true);
        saved["draft"]["completedAt"] = Value::Null;
        assert!(!pending_connections(&saved));
    }
    #[test]
    fn existing_source_identity_survives_renamed_clones_and_ambiguous_names_need_a_choice() {
        let project = json!({"sources":[{"id":"original","name":"old-name"}]});
        assert_eq!(
            matching_source(&project, "/work/renamed").as_deref(),
            Some("original")
        );
        let project = json!({"sources":[{"id":"one","name":"repo","path":"/work/renamed"},{"id":"two","name":"other"}]});
        assert_eq!(
            matching_source(&project, "/work/renamed").as_deref(),
            Some("one")
        );
        assert_eq!(
            matching_source(&project, "/work/other").as_deref(),
            Some("two")
        );
        assert_eq!(matching_source(&project, "/work/unknown"), None);
        assert_eq!(
            matching_source(&json!({"sources":[{"id":"one","name":"original","path":"/work/renamed"},{"id":"two","name":"renamed"}]}), "/work/renamed").as_deref(),
            Some("one")
        );
        assert_eq!(
            matching_source(
                &json!({"sources":[{"id":"one","name":"repo"},{"id":"two","name":"repo"}]}),
                "/work/repo"
            ),
            None
        );
    }
    #[test]
    fn failed_creation_resumes_when_the_network_returns_without_retrying_local_errors() {
        for error in [
            "Cloud unavailable; local work stays queued",
            "Sync authentication: Cannot reach the sign-in service",
            "503: Service unavailable",
            "Blob upload failed; retry retained",
        ] {
            let draft = json!({"selected":["/p"],"projects":[
                {"path":"/p","status":"error","error":error}
            ]});
            assert_eq!(failed_sync_step(&draft), "offline");
        }
        let mut draft = json!({"selected":["/p"],"projects":[
            {"path":"/p","status":"error","error":"Connected folder unavailable"},
            {"path":"/unselected","status":"error","error":"Cloud unavailable; local work stays queued"}
        ]});
        assert_eq!(failed_sync_step(&draft), "sync-error");
        draft["projects"][0]["error"] = json!("403: Connect permission required");
        assert_eq!(failed_sync_step(&draft), "sync-error");
    }
    #[test]
    fn first_sync_requires_a_scan_and_no_queue_or_resource_errors_but_allows_conflicts() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE errors(source TEXT,error TEXT);CREATE TABLE outbox(project TEXT,error TEXT);CREATE TABLE resources(id TEXT,project TEXT,value TEXT);CREATE TABLE conflicts(project TEXT,value TEXT);CREATE TABLE drafts(project TEXT,value TEXT);").unwrap();
        assert_eq!(
            project_sync_status(&db, "p", None).unwrap()["status"],
            "syncing"
        );
        db::set(&db, "firstScan:p", &json!(db::now())).unwrap();
        assert_eq!(
            project_sync_status(&db, "p", None).unwrap()["status"],
            "synced"
        );
        db.execute("INSERT INTO outbox VALUES('p',NULL)", [])
            .unwrap();
        assert_eq!(
            project_sync_status(&db, "p", None).unwrap()["status"],
            "syncing"
        );
        db.execute_batch("DELETE FROM outbox;INSERT INTO resources VALUES('r','p','{}');INSERT INTO errors VALUES('r','Cannot apply resource');").unwrap();
        assert_eq!(
            project_sync_status(&db, "p", None).unwrap()["status"],
            "error"
        );
        db.execute_batch("DELETE FROM errors;INSERT INTO conflicts VALUES('p','{}');")
            .unwrap();
        let status = project_sync_status(&db, "p", None).unwrap();
        assert_eq!(status["status"], "synced");
        assert_eq!(status["conflicts"], 1);
        assert_eq!(
            project_sync_status(&db, "p", Some("Cloud unavailable")).unwrap()["status"],
            "syncing"
        );
    }
}
