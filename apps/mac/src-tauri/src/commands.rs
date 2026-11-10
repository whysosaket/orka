use crate::{
    auth, bundles,
    db::{self, Result},
    indexer, native, packages, projects, session_presentation, sync,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::{Arc, LazyLock, Mutex},
};
use uuid::Uuid;
#[tauri::command]
pub fn snapshot() -> Result<Value> {
    let db = db::open()?;
    let mut daemon = db::get(&db, "daemon")?;
    daemon["running"] = json!(db::daemon_running()?);
    let visible = format!("SELECT id FROM projects WHERE {}", projects::ACTIVE);
    let scoped = |table: &str| {
        db::rows(&db, &format!("SELECT value FROM {table} WHERE project IN ({visible}) ORDER BY json_extract(value,'$.updatedAt') DESC"), &[])
    };
    let mut projects = db::rows(
        &db,
        &format!(
            "SELECT value FROM projects WHERE {} ORDER BY json_extract(value,'$.name')",
            projects::ACTIVE
        ),
        &[],
    )?;
    for project in &mut projects {
        if let Some(sources) = project["sources"].as_array_mut() {
            for source in sources {
                source["folderState"] = json!(crate::sources::folder_state(source));
            }
        } else {
            project["folderState"] = json!(crate::sources::folder_state(project));
        }
    }
    let mut local_skills = Vec::new();
    for project in &projects {
        for source in crate::sources::views(project) {
            local_skills.extend(crate::global_skills::local_skills(&db, &source)?);
        }
    }
    let mut resources = scoped("resources")?;
    let onboarding = crate::onboarding::snapshot(&db)?;
    let background = db::get(&db, "background")?
        .as_bool()
        .unwrap_or(onboarding["active"] != true && crate::profiles::background_default());
    for resource in &mut resources {
        if resource["kind"] == "skill" && resource["deleted"] != true {
            resource["global"] = json!(crate::global_skills::global_origin(&db, resource)?);
        }
    }
    crate::session_forks::annotate(&db, &mut resources)?;
    Ok(json!({
        "profile":crate::profiles::current(), "onboarding":onboarding, "accountProfile":db::get(&db,"accountProfile")?,
        "user":db::get(&db,"user")?, "config":db::get(&db,"config")?,
        "projects":projects, "localSkills":local_skills,
        "managedProjects":db::rows(&db,"SELECT json_set(value,'$.pendingChanges',(SELECT count(*) FROM outbox WHERE project=projects.id)+(SELECT count(*) FROM meta WHERE ? AND key LIKE 'env:%:pending:%' AND json_extract(value,'$.header.manifest.projectId')=projects.id)) FROM projects ORDER BY json_extract(value,'$.name')",&[&crate::env::enabled()])?,
        "resources":resources, "bindings":scoped("bindings")?, "conflicts":scoped("conflicts")?,
        "drafts":scoped("drafts")?,
        "governance":db::rows(&db,&format!("SELECT json_object('projectId',substr(key,12),'catalog',json(value)) FROM meta WHERE key LIKE 'governance:%' AND substr(key,12) IN ({visible})"),&[])?,
        "reviewRequests":db::rows(&db,&format!("SELECT json_each.value FROM meta,json_each(meta.value) WHERE meta.key LIKE 'requests:%' AND json_each.type='object' AND substr(meta.key,10) IN ({visible})"),&[])?,
        "activity":db::rows(&db,&format!("SELECT value FROM activity WHERE json_extract(value,'$.resourceId') IN (SELECT id FROM resources WHERE project IN ({visible})) ORDER BY rowid DESC LIMIT 30"),&[])?,
        "outbox":db::rows(&db,&format!("SELECT json_object('id',id,'project',project,'error',error) FROM outbox WHERE project IN ({visible})"),&[])?,
        "errors":db::rows(&db,&format!("SELECT json_object('source',source,'error',error) FROM errors WHERE source IN ({visible}) OR source NOT IN (SELECT id FROM projects)"),&[])?,
        "sync":db::get(&db,"sync")?, "syncProgress":sync::current_progress(&db,daemon["running"]==true)?,
        "daemon":daemon, "devices":crate::device_metadata::devices(&db,&db::get(&db,"devices")?)?, "deviceId":db::device(&db)?, "localHardwareFamily":crate::device_metadata::local_family(&db)?, "background":background
    }))
}
#[tauri::command]
pub fn sync_progress() -> Result<Value> {
    let db = db::open()?;
    let running = db::daemon_running()?;
    Ok(json!({"user":db::get(&db, "user")?,"progress":sync::current_progress(&db, running)?}))
}
fn service_config(config: &Value) -> Result<Value> {
    let raw = config["apiUrl"]
        .as_str()
        .ok_or("Enter the service URL")?
        .trim();
    db::validate_url(raw)?;
    let url = raw.trim_end_matches('/');
    let minutes = config["syncMinutes"]
        .as_u64()
        .ok_or("Sync interval must be a whole number")?;
    if !(1..=1440).contains(&minutes) {
        return Err("Choose an interval between 1 and 1440 minutes".into());
    }
    let old = db::get(&db::open()?, "config")?;
    let mode = config["mode"]
        .as_str()
        .or(old["mode"].as_str())
        .unwrap_or("cloud");
    if !["cloud", "self-hosted"].contains(&mode) {
        return Err("Choose Cloud or Self-hosted".into());
    }
    let mut next = json!({"apiUrl":url,"syncMinutes":minutes,"mode":mode});
    for key in ["cloudUrl", "selfHostedUrl"] {
        let saved = config[key].as_str().or(old[key].as_str()).unwrap_or("");
        if !saved.is_empty() {
            db::validate_url(saved)?;
        }
        next[key] = json!(saved.trim_end_matches('/'));
    }
    if old["mode"].is_null() && next["cloudUrl"].as_str().unwrap_or("").is_empty() {
        next["cloudUrl"] = json!(old["apiUrl"].as_str().unwrap_or(""));
    }
    next[if mode == "cloud" {
        "cloudUrl"
    } else {
        "selfHostedUrl"
    }] = json!(url);
    Ok(next)
}
#[tauri::command]
pub fn configure(config: Value) -> Result<()> {
    let next = service_config(&config)?;
    let db = db::open()?;
    let old = db::get(&db, "config")?;
    let _lock = if old["apiUrl"] != next["apiUrl"] {
        Some(projects::lock()?)
    } else {
        None
    };
    if db::get(&db, "user")?.is_string() && old["apiUrl"] != next["apiUrl"] {
        return Err("Use Switch service to change your connection".into());
    }
    if old["apiUrl"] != next["apiUrl"] {
        auth::cancel()?;
    }
    db::set(&db, "config", &next)?;
    sync_now()
}
#[tauri::command]
pub fn switch_service(config: Value) -> Result<()> {
    let next = service_config(&config)?;
    let _lock = projects::lock()?;
    auth::sign_out()?;
    db::set(&db::open()?, "config", &next)?;
    sync_now()
}
#[tauri::command]
pub fn open_legal_link(document: String) -> Result<()> {
    if !matches!(document.as_str(), "terms" | "privacy") {
        return Err("Unknown legal document".into());
    }
    // Keep the approved placeholder destination fixed; callers cannot launch
    // arbitrary URLs or local files through this sign-in action.
    let status = Command::new("/usr/bin/open")
        .arg("https://x.com")
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Cannot open your browser".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn auth_capabilities(api_url: String) -> Result<Value> {
    auth::capabilities(api_url).await
}
#[tauri::command]
pub async fn begin_sign_in(method: String, email: Option<String>) -> Result<Value> {
    auth::begin(method, email).await
}
#[tauri::command]
pub async fn complete_sign_in(callback: Option<String>, code: Option<String>) -> Result<Value> {
    let value = auth::complete(callback, code).await?;
    sync_now()?;
    Ok(value)
}
#[tauri::command]
pub fn cancel_sign_in() -> Result<()> {
    auth::cancel()
}
#[tauri::command]
pub fn retry_sign_in_storage() -> Result<Value> {
    let value = auth::retry_storage()?;
    if value["signedIn"] == true {
        sync_now()?;
    }
    Ok(value)
}
#[tauri::command]
pub async fn sign_in(email: String, password: String) -> Result<Value> {
    let r = auth::sign_in(email, password).await?;
    if r["signedIn"] == true {
        sync_now()?;
    }
    Ok(r)
}
#[tauri::command]
pub fn sign_out() -> Result<()> {
    let _lock = projects::lock()?;
    auth::sign_out()
}
#[tauri::command]
pub fn sync_now() -> Result<()> {
    db::set(
        &db::open()?,
        "syncRequest",
        &json!(Uuid::new_v4().to_string()),
    )
}
#[tauri::command]
pub async fn cloud_action(action: String, input: Value) -> Result<Value> {
    let adding = action == "create" || action == "join";
    let sharing = if adding {
        Some(if input.get("sharing").is_some() {
            serde_json::from_value::<projects::Sharing>(input["sharing"].clone())
                .map_err(|_| "Invalid project sharing choices")?
        } else {
            projects::Sharing::new_project()
        })
    } else {
        None
    };
    // Save consent before the daemon can discover or scan this project.
    let _lock = if adding {
        Some(projects::lock()?)
    } else {
        None
    };
    let mut request = input;
    if adding {
        request
            .as_object_mut()
            .ok_or("Invalid project input")?
            .remove("sharing");
    }
    if action == "join" {
        if let Some(service) = request
            .as_object_mut()
            .and_then(|input| input.remove("serviceUrl"))
        {
            let config = db::get(&db::open()?, "config")?;
            validate_invite_service(&service, &config["apiUrl"])?;
        }
    }
    if action == "create" {
        if let Ok(caps) = sync::api("GET", "/v2/projects/capabilities", None).await {
            if caps["governance"] == 1 {
                request["governance"] = json!(1);
            }
            if caps["rolePolicies"] == 1 {
                request["rolePolicies"] = json!(1);
            }
        }
    }
    let path = match action.as_str() {
        "create" => "/v2/projects",
        "invite" => "/v2/invites",
        "join" => "/v2/join",
        _ => return Err("Unknown project action".into()),
    };
    let mut r = sync::api("POST", path, Some(&request)).await?;
    if let Some(sharing) = sharing {
        let id = r["id"].as_str().ok_or("Missing project")?;
        let db = db::open()?;
        let mut project = db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&id])?
            .into_iter()
            .next()
            .unwrap_or_else(|| json!({"id":id,"name":request["name"].as_str().unwrap_or("Joined project"),"role":if action == "create" {"owner"} else {"member"}}));
        project["sharing"] = json!(sharing);
        if !project["sources"].is_array() {
            project["sources"] = json!([]);
        }
        db::upsert(&db, "projects", id, id, &project)?;
        // Creation has succeeded. A catalog outage must not lose consent or ask
        // the user to create the same project again; sync will refresh it later.
        if let Ok(list) = sync::api("GET", "/v2/projects?includeArchived=true", None).await {
            projects::merge_catalog(&db, &list)?;
        }
        let current = db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&id])?
            .into_iter()
            .next()
            .unwrap_or(Value::Null);
        if (action == "create"
            || current["sources"].as_array().is_some_and(|sources| {
                sources
                    .iter()
                    .any(|source| source["repository"]["id"].is_string())
            }))
            && sync::api("GET", "/v2/instance", None)
                .await
                .is_ok_and(|caps| caps["repositories"]["github"] == 1)
        {
            r["repositorySetup"] = json!(true);
        }
    }
    sync_now()?;
    Ok(r)
}

fn validate_invite_service(expected: &Value, current: &Value) -> Result<()> {
    let expected = db::validate_url(expected.as_str().ok_or("Invalid invite service")?)?;
    let current = db::validate_url(current.as_str().ok_or("Configure the service")?)?;
    if expected.as_str().trim_end_matches('/') != current.as_str().trim_end_matches('/') {
        return Err(
            "Switch to the invite's service and sign in before joining this project".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod invite_tests {
    use super::*;

    #[test]
    fn invites_are_bound_to_the_selected_service() {
        assert!(validate_invite_service(
            &json!("https://ORKA.example:443/"),
            &json!("https://orka.example")
        )
        .is_ok());
        assert!(validate_invite_service(
            &json!("http://127.0.0.1:8080"),
            &json!("http://127.0.0.1:8080/")
        )
        .is_ok());
        for service in [
            json!(null),
            json!("https://other.example"),
            json!("https://orka.example/path"),
            json!("http://orka.example"),
            json!("https://user:secret@orka.example"),
        ] {
            assert!(validate_invite_service(&service, &json!("https://orka.example")).is_err());
        }
    }
}
#[tauri::command]
pub fn connect_project(id: String, path: String) -> Result<()> {
    let _lock = projects::lock()?;
    let db = db::open()?;
    projects::active(&db, &id)?;
    let mut p = db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .ok_or("Project not found; sync first")?;
    if p["sources"].is_array() {
        return Err("Use Add folders or Locate folder to connect a project source".into());
    }
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("Choose a folder".into());
    }
    for other in db::rows(&db, "SELECT value FROM projects WHERE id<>?", &[&id])? {
        if other["path"]
            .as_str()
            .is_some_and(|s| root.starts_with(s) || PathBuf::from(s).starts_with(&root))
        {
            return Err("Another project already covers this folder".into());
        }
    }
    if let Some(old) = p["path"].as_str() {
        if old != root.to_string_lossy() {
            return Err("Disconnect the project before changing its folder".into());
        }
    }
    native::install_hooks(&root)?;
    p["folderIdentity"] = json!(indexer::folder_identity(&root)?);
    p["path"] = json!(root);
    db::upsert(&db, "projects", &id, &id, &p)?;
    sync_now()?;
    Ok(())
}
#[tauri::command]
pub fn disconnect_project(id: String) -> Result<()> {
    let _lock = projects::lock()?;
    let db = db::open()?;
    let mut p = db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .ok_or("Project not found")?;
    if p["sources"].is_array() {
        return Err("Choose the source folder to disconnect in Settings".into());
    }
    p["path"] = Value::Null;
    db::upsert(&db, "projects", &id, &id, &p)?;
    db.execute("DELETE FROM bindings WHERE project=?", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub async fn session_display_title(id: String) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = db::open()?;
        let resource = db::rows(&db, "SELECT value FROM resources WHERE id=?", &[&id])?
            .into_iter()
            .next()
            .ok_or("Session not found")?;
        if resource["kind"] != "session" || resource["deleted"] == true {
            return Err("Session unavailable".into());
        }
        let records = crate::history::resource_records(&resource)?;
        crate::session_presentation::title(&native::encode(&records))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The stored resource, or a conflict's incoming candidate when previewing one.
fn inspected_resource(
    db: &rusqlite::Connection,
    id: &str,
    conflict_id: Option<String>,
) -> Result<Value> {
    let resource = db::rows(db, "SELECT value FROM resources WHERE id=?", &[&id])?
        .into_iter()
        .next();
    let resource = match resource {
        Some(resource) if resource["deleted"] == true => {
            crate::global_skills::local_skill(db, id)?.unwrap_or(resource)
        }
        Some(resource) => resource,
        None => crate::global_skills::local_skill(db, id)?.ok_or("Resource not found")?,
    };
    let Some(conflict_id) = conflict_id else {
        return crate::session_forks::current_resource(db, &resource);
    };
    let conflict = db::rows(
        db,
        "SELECT value FROM conflicts WHERE id=?",
        &[&conflict_id],
    )?
    .into_iter()
    .next()
    .ok_or("Conflict changed; refresh before inspecting")?;
    if conflict["resourceId"] != id {
        return Err("Conflict belongs to another resource".into());
    }
    Ok(conflict["candidate"].clone())
}

/// Parsed conversations for the few sessions a reader pages through at once.
/// Keyed by resource, conflict preview, and file hashes so new revisions miss.
type Conversations = Vec<(String, Arc<Vec<session_presentation::Message>>)>;
static CONVERSATIONS: LazyLock<Mutex<Conversations>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn conversation_turns(
    resource: &Value,
    key: String,
) -> Result<Arc<Vec<session_presentation::Message>>> {
    if let Some((_, turns)) = CONVERSATIONS
        .lock()
        .map_err(|_| "Conversation cache unavailable")?
        .iter()
        .find(|(cached, _)| *cached == key)
    {
        return Ok(turns.clone());
    }
    let turns = Arc::new(session_presentation::conversation_messages(
        &crate::history::resource_records(resource)?,
    ));
    let mut cache = CONVERSATIONS
        .lock()
        .map_err(|_| "Conversation cache unavailable")?;
    if cache.len() >= 6 {
        cache.remove(0);
    }
    cache.push((key, turns.clone()));
    Ok(turns)
}

/// One page of readable conversation turns, oldest first. Reads happen off the
/// UI thread and only the requested window crosses the bridge.
#[tauri::command]
pub async fn session_messages(
    id: String,
    conflict_id: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = db::open()?;
        let resource = inspected_resource(&db, &id, conflict_id.clone())?;
        if resource["deleted"] == true {
            return Ok(json!({"messages":[],"total":0,"offset":0,"removed":true}));
        }
        if resource["kind"] != "session" {
            return Err("Not a session".into());
        }
        let hashes = resource["files"]
            .as_array()
            .map(|files| {
                files
                    .iter()
                    .filter_map(|file| file["hash"].as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        let key = format!("{id}:{}:{hashes}", conflict_id.unwrap_or_default());
        let turns = conversation_turns(&resource, key)?;
        let total = turns.len();
        let offset = offset.unwrap_or(0).min(total);
        let limit = limit.unwrap_or(40).clamp(1, 200);
        let end = (offset + limit).min(total);
        Ok(json!({"messages":&turns[offset..end],"total":total,"offset":offset}))
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub fn inspect_resource(id: String, file: String, conflict_id: Option<String>) -> Result<Value> {
    let db = db::open()?;
    let r = inspected_resource(&db, &id, conflict_id)?;
    if r["deleted"] == true {
        return Ok(
            json!({"content":"This version removes the session from shared history.","previous":null,"paths":null}),
        );
    }
    let f = r["files"]
        .as_array()
        .ok_or("Missing files")?
        .iter()
        .find(|f| f["path"] == file)
        .ok_or("File not found")?;
    let bytes = db::blob_read(f["hash"].as_str().ok_or("Missing hash")?)?;
    let binding = indexer::binding(&db, &id)?;
    let previous = binding["previous"]["files"]
        .as_array()
        .and_then(|a| a.iter().find(|f| f["path"] == file))
        .and_then(|f| f["hash"].as_str())
        .and_then(|h| db::blob_read(h).ok())
        .and_then(|b| String::from_utf8(b).ok());
    let (content, messages, conversation) = if r["kind"] == "session" && file == "session.jsonl" {
        let records = crate::history::resource_records(&r)?;
        (
            Some(native::transcript(&records)),
            Some(native::transcript_messages(&records)),
            Some(crate::session_presentation::conversation(&records)),
        )
    } else {
        (String::from_utf8(bytes).ok(), None, None)
    };
    Ok(
        json!({"content":content,"previous":previous,"paths":if r["local"] == true { &r["paths"] } else { &binding["paths"] },"messages":messages,"conversation":conversation}),
    )
}
#[tauri::command]
pub fn open_editor(id: String, file: String) -> Result<()> {
    let db = db::open()?;
    let b = indexer::binding(&db, &id)?;
    let local = crate::global_skills::local_skill(&db, &id)?;
    let r = local.as_ref().unwrap_or(&b["base"]);
    if r["kind"] == "session" {
        return Err("Use Resume for sessions".into());
    }
    let mut path = PathBuf::from(
        (if r["local"] == true {
            &r["paths"]
        } else {
            &b["paths"]
        })[0]
            .as_str()
            .ok_or("File is not materialized yet")?,
    );
    if r["kind"] == "skill" {
        path = path.join(packages::safe_relative(&file)?);
    }
    if !path.is_file() {
        return Err("File unavailable".into());
    }
    Command::new("/usr/bin/open")
        .arg("-t")
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn session_action(
    id: String,
    action: String,
    conflict_id: Option<String>,
    selected: Option<String>,
) -> Result<()> {
    let db = db::open()?;
    let r = db::rows(&db, "SELECT value FROM resources WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .ok_or("Session not found")?;
    let project = r["projectId"].as_str().ok_or("Missing project")?;
    projects::active(&db, project)?;
    if action == "delete" {
        let project_state = crate::governance::project(&db, project)?;
        if project_state["rolePolicies"].is_object()
            && project_state["role"] != "owner"
            && !(project_state["role"] == "admin" && r["access"]["mode"] == "publish")
        {
            return Err(
                "Only the Owner or an Admin with write access can delete shared content".into(),
            );
        }
    }
    let input = if let Some(c) = conflict_id {
        if !["keep", "override", "copy"].contains(&action.as_str()) {
            return Err("Invalid conflict action".into());
        }
        let selected = selected.ok_or("Choose a version")?;
        if !["current", "candidate"].contains(&selected.as_str()) {
            return Err("Invalid selection".into());
        }
        json!({"version":2,"id":Uuid::new_v4().to_string(),"projectId":project,"deviceId":db::device(&db)?,"resourceId":id,"expectedRevision":r["revision"],"conflictId":c,"action":action,"selected":selected})
    } else if action == "copy" {
        json!({"version":2,"id":Uuid::new_v4().to_string(),"projectId":project,"deviceId":db::device(&db)?,"resourceId":id,"expectedRevision":r["revision"]})
    } else if action == "delete" {
        let mut resource = r.clone();
        for key in [
            "projectId",
            "revision",
            "owner",
            "updatedBy",
            "updatedAt",
            "hash",
            "access",
        ] {
            resource
                .as_object_mut()
                .ok_or("Invalid resource")?
                .remove(key);
        }
        resource["deleted"] = json!(true);
        resource["files"] = json!([]);
        json!({"version":2,"id":Uuid::new_v4().to_string(),"projectId":project,"deviceId":db::device(&db)?,"baseRevision":r["revision"],"resource":resource})
    } else {
        return Err("Invalid session action".into());
    };
    let endpoint = if input["conflictId"].is_string() {
        "/v2/sessions/resolve"
    } else if action == "copy" {
        "/v2/sessions/copy"
    } else {
        "/v2/sync/push"
    };
    indexer::queue(&db, project, endpoint, &input)?;
    sync_now()
}
#[tauri::command]
pub async fn session_launch_options(
    id: String,
) -> Result<Vec<crate::session_launcher::LaunchOption>> {
    tauri::async_runtime::spawn_blocking(move || crate::session_launcher::options(&id))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn session_handoff_prompt(id: String) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || crate::session_launcher::handoff_prompt(&id))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn resume_session(
    id: String,
    tool: String,
    destination: Option<crate::session_launcher::Destination>,
    fork: Option<bool>,
) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let tool = crate::session_launcher::Tool::parse(&tool)?;
        let destination = destination.unwrap_or(crate::session_launcher::Destination::Desktop);
        if fork.unwrap_or(false) {
            crate::session_launcher::launch(&id, tool, destination, true)
        } else {
            crate::session_launcher::resume(&id, tool, destination)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub fn export_bundle(id: String, path: String) -> Result<()> {
    bundles::export(&db::open()?, &id, &PathBuf::from(path))
}
#[tauri::command]
pub fn import_bundle(
    project_id: String,
    path: String,
    source_id: Option<String>,
) -> Result<String> {
    let db = db::open()?;
    if db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&project_id])?.is_empty() {
        return Err("Project not found".into());
    }
    projects::active(&db, &project_id)?;
    bundles::import_into_source(&db, &project_id, &PathBuf::from(path), source_id.as_deref())
}
#[tauri::command]
pub fn retry_uploads() -> Result<()> {
    let db = db::open()?;
    db.execute(
        "DELETE FROM outbox WHERE path='/v2/sessions/resolve' AND error LIKE '409:%'",
        [],
    )
    .map_err(|e| e.to_string())?;
    db.execute("UPDATE outbox SET error=NULL", [])
        .map_err(|e| e.to_string())?;
    sync_now()
}
#[tauri::command]
pub fn background_agent(enabled: bool) -> Result<()> {
    #[cfg(debug_assertions)]
    if std::env::var_os("ORKA_TEST_HOME").is_some() {
        if enabled {
            return Err(
                "Background sync can’t be enabled in this test build. Choose Not now to continue."
                    .into(),
            );
        }
        return db::set(&db::open()?, "background", &json!(false));
    }
    let home = db::home()?;
    let directory = home.join("Library/LaunchAgents");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let label = crate::profiles::label();
    let path = directory.join(format!("{label}.plist"));
    let uid = Command::new("/usr/bin/id")
        .arg("-u")
        .output()
        .map_err(|e| e.to_string())?;
    let domain = format!("gui/{}", String::from_utf8_lossy(&uid.stdout).trim());
    let db = db::open()?;
    // The app-open worker yields its lock at the next safe cycle boundary.
    db::set(&db, "backgroundHandoff", &json!(enabled))?;
    let _ = Command::new("/bin/launchctl")
        .args(["bootout", &domain, &path.to_string_lossy()])
        .output();
    let result = (|| -> Result<()> {
        if enabled {
            let exe = crate::updates::executable()
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            let xml = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>{label}</string><key>ProgramArguments</key><array><string>{exe}</string><string>--orka-agent</string><string>--profile</string><string>{profile}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer></dict></plist>"#,
                profile = crate::profiles::current()
            );
            db::atomic(&path, xml.as_bytes())?;
            let output = Command::new("/bin/launchctl")
                .args(["bootstrap", &domain, &path.to_string_lossy()])
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err("Enable Orka in macOS Login Items to start the sync service".into());
            }
        } else if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        db::set(&db, "background", &json!(enabled))
    })();
    db::set(&db, "backgroundHandoff", &json!(false))?;
    result
}
pub fn ensure_agent() -> Result<()> {
    let db = db::open()?;
    // A process interrupted during registration must not suppress app-open sync.
    db::set(&db, "backgroundHandoff", &json!(false))?;
    if db::get(&db, "background")?.is_null() && crate::onboarding::snapshot(&db)?["active"] == true
    {
        return Ok(());
    }
    if !db::get(&db, "background")?
        .as_bool()
        .unwrap_or(crate::profiles::background_default())
    {
        return Ok(());
    }
    let lock = db::daemon_lock()?;
    use fs2::FileExt;
    if lock.try_lock_exclusive().is_err() {
        if db::get(&db, "daemon")?["executableIdentity"] != db::executable_identity()? {
            return background_agent(true);
        }
        return Ok(());
    }
    FileExt::unlock(&lock).map_err(|e| e.to_string())?;
    background_agent(true)
}
