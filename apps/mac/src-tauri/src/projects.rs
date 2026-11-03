use crate::{
    db::{self, Result},
    env, sync,
};
use fs2::FileExt;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    time::{Duration, Instant},
};

pub const ACTIVE: &str = "coalesce(json_extract(value,'$.revoked'),0)=0 AND coalesce(json_extract(value,'$.hidden'),0)=0 AND json_extract(value,'$.archivedAt') IS NULL";

pub fn display_name(project: &Value) -> Option<&str> {
    if project["role"] == "owner" {
        return project["name"].as_str();
    }
    project["localName"].as_str().or(project["name"].as_str())
}

fn set_local_name(db: &Connection, id: &str, name: &Value) -> Result<()> {
    let name = if name.is_null() {
        Value::Null
    } else {
        let name = name.as_str().ok_or("Enter a project name")?.trim();
        if name.is_empty() || name.encode_utf16().count() > 100 {
            return Err("Enter a project name from 1 to 100 characters".into());
        }
        json!(name)
    };
    // One SQLite update keeps this local preference safe during catalog sync.
    let changed = db.execute(
        &format!("UPDATE projects SET value=json_set(value,'$.localName',json(?)) WHERE id=? AND {ACTIVE}"),
        rusqlite::params![name.to_string(), id],
    ).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Project is removed, archived, or unavailable".into());
    }
    Ok(())
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Sharing {
    memory: bool,
    skill: bool,
    session: bool,
    plan: bool,
    env: bool,
}

pub fn sharing_allowed(project: &Value, kind: &str) -> bool {
    if kind == "env" && !env::enabled() {
        return false;
    }
    if !matches!(kind, "memory" | "skill" | "session" | "plan" | "env") {
        return false;
    }
    // Projects saved before opt-in sharing retain their existing behavior.
    project["sharing"].is_null() || project["sharing"][kind] == true
}

pub fn require_sharing(db: &Connection, id: &str, kind: &str) -> Result<()> {
    active(db, id)?;
    let project = db::rows(db, "SELECT value FROM projects WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .ok_or("Project not found")?;
    if !sharing_allowed(&project, kind) {
        return Err(format!(
            "Sharing for {kind} is off on this Mac. Enable it in Settings → Project sharing."
        ));
    }
    Ok(())
}

pub fn queued_kind<'a>(path: &str, input: &'a Value) -> &'a str {
    if matches!(path, "/v2/sessions/copy" | "/v2/sessions/resolve") {
        "session"
    } else {
        input["resource"]["kind"].as_str().unwrap_or("")
    }
}

// Serialize local project changes with the daemon across processes. A removal
// cannot race an already selected upload or a write into the connected folder.
fn lock_file(name: &str) -> Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(db::root()?.join(name))
        .map_err(|e| e.to_string())
}

pub fn lock() -> Result<File> {
    let file = lock_file("workspace.lock")?;
    file.try_lock_exclusive().map_err(|_| {
        "A sync or project operation is in progress. Wait for it to finish and try again."
    })?;
    Ok(file)
}

pub fn launch_lock() -> Result<File> {
    let file = lock_file("session-launch.lock")?;
    file.try_lock_exclusive().map_err(|_| {
        "A session launch is already in progress. Check that attempt before trying again."
    })?;
    Ok(file)
}

pub fn wait_for_lock(timeout: Duration) -> Result<File> {
    let waiting = lock_file("workspace-waiters.lock")?;
    FileExt::lock_shared(&waiting).map_err(|e| e.to_string())?;
    let file = lock_file("workspace.lock")?;
    let start = Instant::now();
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                let remaining = timeout.saturating_sub(start.elapsed());
                if remaining.is_zero() {
                    return Err("Sync or another project operation is still running. Try again after it finishes.".into());
                }
                std::thread::sleep(remaining.min(Duration::from_millis(50)));
            }
            Err(error) => return Err(format!("Cannot access the project lock: {error}")),
        }
    }
}

pub fn foreground_waiting() -> Result<bool> {
    let waiting = lock_file("workspace-waiters.lock")?;
    match waiting.try_lock_exclusive() {
        Ok(()) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(true),
        Err(error) => Err(error.to_string()),
    }
}

pub fn active(db: &Connection, id: &str) -> Result<()> {
    if db
        .query_row(
            &format!("SELECT count(*) FROM projects WHERE id=? AND {ACTIVE}"),
            [id],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?
        == 0
    {
        return Err(
            "Project is removed, archived, or unavailable. Restore it in Manage projects first."
                .into(),
        );
    }
    Ok(())
}

pub fn merge_catalog(db: &Connection, remote: &Value) -> Result<()> {
    let remote = remote.as_array().ok_or("Invalid project list")?;
    let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut governed_removals = Vec::new();
    let mut revoked = false;
    for item in remote {
        let id = item["id"].as_str().ok_or("Missing project")?;
        let old = db::rows(&tx, "SELECT value FROM projects WHERE id=?", &[&id])?
            .into_iter()
            .next()
            .unwrap_or(json!({}));
        if item["lifecycleRevision"].as_u64().unwrap_or(0)
            < old["lifecycleRevision"].as_u64().unwrap_or(0)
        {
            continue;
        }
        let mut project = item.clone();
        if let Some(sources) = project["sources"].as_array_mut() {
            for source in sources {
                if let Some(local) = old["sources"]
                    .as_array()
                    .and_then(|items| items.iter().find(|local| local["id"] == source["id"]))
                {
                    source["path"] = local["path"].clone();
                    source["folderIdentity"] = local["folderIdentity"].clone();
                    crate::sources::upgrade_identity(source);
                }
            }
        }
        for key in ["path", "folderIdentity", "hidden", "sharing", "localName"] {
            project[key] = old[key].clone();
        }
        crate::sources::upgrade_identity(&mut project);
        if old["id"].is_null() {
            project["sharing"] = json!(Sharing::default());
        }
        db::upsert(&tx, "projects", id, id, &project)?;
    }
    for mut project in db::rows(&tx, "SELECT value FROM projects", &[])? {
        if !remote.iter().any(|p| p["id"] == project["id"]) {
            if project["governed"] == true {
                governed_removals
                    .push(project["id"].as_str().ok_or("Missing project")?.to_string());
            }
            revoked |= project["revoked"] != true;
            project["revoked"] = json!(true);
            db::upsert(
                &tx,
                "projects",
                project["id"].as_str().ok_or("Missing project")?,
                "",
                &project,
            )?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    if revoked {
        env::clear();
    }
    // Retrying revoked projects also recovers a crash after the catalog commit.
    for id in governed_removals {
        crate::governance::reset(db, &id, &json!([]))?;
        db.execute("DELETE FROM cursors WHERE project=?", [&id])
            .map_err(|e| e.to_string())?;
        for prefix in ["governance", "requests", "policyRevision", "presence"] {
            db.execute("DELETE FROM meta WHERE key=?", [format!("{prefix}:{id}")])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn remove_local(db: &Connection, id: &str) -> Result<()> {
    let mut project = db::rows(db, "SELECT value FROM projects WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .ok_or("Project not found")?;
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    project["hidden"] = json!(true);
    project["path"] = Value::Null;
    project["folderIdentity"] = Value::Null;
    if let Some(sources) = project["sources"].as_array_mut() {
        for source in sources {
            source["path"] = Value::Null;
            source["folderIdentity"] = Value::Null;
        }
    }
    db::upsert(&tx, "projects", id, id, &project)?;
    tx.execute("DELETE FROM activity WHERE json_extract(value,'$.resourceId') IN (SELECT id FROM resources WHERE project=?)",[id]).map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM errors WHERE source IN (SELECT id FROM resources WHERE project=?)",
        [id],
    )
    .map_err(|e| e.to_string())?;
    for table in ["resources", "bindings", "outbox", "conflicts", "cursors"] {
        tx.execute(&format!("DELETE FROM {table} WHERE project=?"), [id])
            .map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM errors WHERE source=?", [id])
        .map_err(|e| e.to_string())?;
    // Keep signed trust pins, but discard encrypted pending publications for this project.
    tx.execute("DELETE FROM meta WHERE key LIKE 'env:%' AND (json_extract(value,'$.header.manifest.projectId')=? OR json_extract(value,'$.projectId')=?)",[id,id]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    env::clear();
    Ok(())
}

#[tauri::command]
pub async fn project_command(action: String, input: Value) -> Result<Value> {
    let db = db::open()?;
    let owner = db::get(&db, "user")?
        .as_str()
        .ok_or("Sign in first")?
        .to_string();
    if action == "list" {
        let capable =
            sync::api_as(&owner, "GET", "/v2/projects/capabilities", None).await?["lifecycle"] == 1;
        let list = sync::api_as(&owner, "GET", "/v2/projects?includeArchived=true", None).await?;
        let _lock = lock()?;
        merge_catalog(&db, &list)?;
        return Ok(
            json!({"supported":capable,"projects":db::rows(&db,"SELECT value FROM projects ORDER BY json_extract(value,'$.name')",&[])?}),
        );
    }
    let id = input["projectId"].as_str().ok_or("Choose a project")?;
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid project")?;
    if action == "local_name" {
        set_local_name(&db, id, input.get("name").ok_or("Enter a project name")?)?;
        return Ok(json!({"ok":true}));
    }
    let _lock = lock()?;
    match action.as_str() {
        "sharing" => {
            active(&db, id)?;
            let sharing: Sharing = serde_json::from_value(input["sharing"].clone())
                .map_err(|_| "Invalid project sharing choices")?;
            let mut project = db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&id])?
                .into_iter()
                .next()
                .ok_or("Project not found")?;
            project["sharing"] = json!(sharing);
            db::upsert(&db, "projects", id, id, &project)?;
            env::clear();
        }
        "remove" => remove_local(&db, id)?,
        "show" => {
            let mut project = db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&id])?
                .into_iter()
                .next()
                .ok_or("Project not found")?;
            if project["revoked"] == true || !project["archivedAt"].is_null() {
                return Err("Restore cloud access before adding this project to this Mac".into());
            }
            project["hidden"] = json!(false);
            db::upsert(&db, "projects", id, id, &project)?;
        }
        "archive" | "restore" | "delete" | "rename" => {
            if action == "rename" {
                active(&db, id)?;
                if sync::api_as(&owner, "GET", "/v2/projects/capabilities", None).await?["rename"]
                    != 1
                {
                    return Err("This service does not support shared project renaming. Update the server and try again.".into());
                }
            }
            let mut request = input.clone();
            request["action"] = json!(action);
            let receipt =
                sync::api_as(&owner, "POST", "/v2/projects/action", Some(&request)).await?;
            if action != "rename" {
                env::clear();
            }
            if action == "delete" {
                remove_local(&db, id)?;
            }
            if let Some(mut project) =
                db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&id])?
                    .into_iter()
                    .next()
            {
                if action == "rename"
                    && receipt["lifecycleRevision"].as_u64().unwrap_or(0)
                        < project["lifecycleRevision"].as_u64().unwrap_or(0)
                {
                    return Ok(json!({"ok":true}));
                }
                if action == "delete" {
                    project["revoked"] = json!(true);
                } else if action == "rename" {
                    project["name"] = receipt["name"].clone();
                } else {
                    project["archivedAt"] = if action == "archive" {
                        json!(db::now())
                    } else {
                        Value::Null
                    };
                }
                project["lifecycleRevision"] = receipt["lifecycleRevision"].clone();
                db::upsert(&db, "projects", id, id, &project)?;
            }
        }
        _ => return Err("Unknown project action".into()),
    }
    crate::commands::sync_now()?;
    Ok(json!({"ok":true}))
}
