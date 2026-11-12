use crate::{
    db::{self, Result},
    governance, indexer, projects, sources,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path};
use uuid::Uuid;

fn selected_memory_id(project: &Value, resource: &Value) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!(
            "selected-memory:{}:{}",
            project["id"], resource["resourceId"]
        )
        .as_bytes(),
    )
    .to_string()
}

fn shared(db: &Connection, id: &str) -> Result<Option<Value>> {
    Ok(
        db::rows(db, "SELECT value FROM resources WHERE id=?", &[&id])?
            .into_iter()
            .next(),
    )
}

fn origin_key(
    project: &Value,
    kind: &str,
    provider: &str,
    logical: &str,
    native_id: Option<&str>,
) -> Result<String> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let identity = json!({"sourceId":project["sourceId"],"kind":kind,"provider":provider,"nativeId":native_id,"logicalPath":if native_id.is_some(){None}else{Some(logical)}});
    Ok(format!(
        "localResourceOrigin:{project_id}:{}",
        db::digest(identity.to_string().as_bytes())
    ))
}

pub fn origin(
    db: &Connection,
    project: &Value,
    kind: &str,
    provider: &str,
    logical: &str,
    native_id: Option<&str>,
) -> Result<Value> {
    db::get(
        db,
        &origin_key(project, kind, provider, logical, native_id)?,
    )
}

/// Keep identity and ownership outside the prunable reading catalog so an
/// archived native history retains its origin when it becomes available again.
pub fn remember_origin(
    db: &Connection,
    project: &Value,
    resource: &Value,
    binding: &Value,
) -> Result<()> {
    if !matches!(
        resource["kind"].as_str(),
        Some("memory" | "session" | "plan")
    ) || !resource["owner"].is_string()
    {
        return Ok(());
    }
    let id = resource["resourceId"].as_str().ok_or("Missing resource")?;
    let mut scope = project.clone();
    scope["sourceId"] = resource["sourceId"].clone();
    if let Some(source) = sources::for_resource(project, resource) {
        scope = source;
    }
    let key = origin_key(
        &scope,
        resource["kind"].as_str().ok_or("Missing category")?,
        resource["source"].as_str().ok_or("Missing provider")?,
        resource["logicalPath"]
            .as_str()
            .ok_or("Missing resource path")?,
        binding["nativeId"].as_str(),
    )?;
    db::set(
        db,
        &key,
        &json!({"resourceId":id,"owner":resource["owner"],"projectId":project["id"],"sourceId":resource["sourceId"],"nativeId":binding["nativeId"],"path":scope["path"],"folderIdentity":scope["folderIdentity"]}),
    )?;
    let Some(mut entry) = db::rows(db, "SELECT value FROM local_resources WHERE id=?", &[&id])?
        .into_iter()
        .next()
    else {
        return Ok(());
    };
    entry["owner"] = resource["owner"].clone();
    entry["nativeId"] = binding["nativeId"].clone();
    entry["paths"] = binding["paths"].clone();
    entry["path"] = project["path"].clone();
    entry["folderIdentity"] = project["folderIdentity"].clone();
    db::upsert(
        db,
        "local_resources",
        id,
        project["id"].as_str().ok_or("Missing project")?,
        &entry,
    )
}

fn normalize(db: &Connection, project: &Value, entry: &Value) -> Result<Option<Value>> {
    let input = &entry["resource"];
    let Some(source) = sources::for_resource(project, input) else {
        return Ok(None);
    };
    if entry["path"] != source["path"] || entry["folderIdentity"] != source["folderIdentity"] {
        return Ok(None);
    }
    let id = input["resourceId"].as_str().ok_or("Missing resource")?;
    let published = match shared(db, id)? {
        Some(resource) => Some(resource),
        None if input["kind"] == "memory" && input["source"] != "shared" => {
            shared(db, &selected_memory_id(project, input))?
        }
        None => None,
    };
    let user = db::get(db, "user")?;
    if !user.is_string() {
        return Err("Sign in required".into());
    }
    let mut resource = if let Some(resource) = published.filter(|r| r["deleted"] != true) {
        // A downloaded teammate copy remains the authorized shared version.
        if resource["owner"] != user || resource["files"] == input["files"] {
            return Ok(Some(resource));
        }
        let mut resource = resource;
        resource["localChanges"] = json!(true);
        resource["sharedRevision"] = resource["revision"].clone();
        resource
    } else {
        // Never resurrect a revoked teammate resource as a new personal item.
        if entry["owner"].is_string() && entry["owner"] != user {
            return Ok(None);
        }
        let mut resource = input.clone();
        resource["projectId"] = project["id"].clone();
        resource["revision"] = json!(0);
        resource["owner"] = user.clone();
        resource["local"] = json!(true);
        resource
    };
    resource["files"] = input["files"].clone();
    resource["hash"] = json!(indexer::manifest_hash(&input["files"]));
    resource["updatedBy"] = user;
    resource["updatedAt"] = entry["updatedAt"]
        .as_str()
        .or(entry["discoveredAt"].as_str())
        .map_or(json!(db::now()), |value| json!(value));
    resource["paths"] = entry["paths"].clone();
    resource["nativeId"] = entry["nativeId"].clone();
    Ok(Some(resource))
}

fn entries(db: &Connection, project: &Value, kind: &str) -> Result<Vec<Value>> {
    let id = project["id"].as_str().ok_or("Missing project")?;
    let mut entries = db::rows(db, "SELECT value FROM local_resources WHERE project=? AND json_extract(value,'$.resource.kind')=?", &[&id,&kind])?;
    for draft in db::rows(db,"SELECT value FROM drafts WHERE project=? AND json_extract(value,'$.resource.kind')=? AND json_extract(value,'$.status') IN ('local','proposed') ORDER BY rowid DESC",&[&id,&kind])? {
        if entries.iter().any(|entry| entry["resource"]["resourceId"] == draft["resource"]["resourceId"]) {
            continue;
        }
        let Some(source) = sources::for_resource(project, &draft["resource"]) else { continue };
        let mut entry = draft;
        entry["owner"] = entry["resource"]["owner"].clone();
        entry["path"] = source["path"].clone();
        entry["folderIdentity"] = source["folderIdentity"].clone();
        entry["updatedAt"] = entry["updatedAt"].as_str().or(entry["createdAt"].as_str()).map_or(Value::Null, |value| json!(value));
        entries.push(entry);
    }
    Ok(entries)
}

pub fn catalog(db: &Connection, project: &Value, kind: &str) -> Result<Value> {
    if !matches!(kind, "memory" | "session" | "plan") {
        return Err("Choose memories, sessions, or plans".into());
    }
    let errors = indexer::discover_library(db, project, kind)?;
    let mut resources = BTreeMap::new();
    for mut entry in entries(db, project, kind)? {
        if let Some(mut resource) = normalize(db, project, &entry)? {
            if resource["revision"].as_u64().unwrap_or(0) > 0 {
                entry["owner"] = resource["owner"].clone();
                let mut native = entry["resource"].clone();
                native["owner"] = resource["owner"].clone();
                remember_origin(db, project, &native, &entry)?;
                let local_id = entry["resource"]["resourceId"]
                    .as_str()
                    .ok_or("Missing resource")?;
                // Preserve provenance after access revocation removes shared state.
                if !db::rows(
                    db,
                    "SELECT value FROM local_resources WHERE id=?",
                    &[&local_id],
                )?
                .is_empty()
                {
                    db::upsert(
                        db,
                        "local_resources",
                        local_id,
                        project["id"].as_str().ok_or("Missing project")?,
                        &entry,
                    )?;
                }
            }
            if resource["kind"] == "session" {
                let id = resource["resourceId"].as_str().ok_or("Missing session")?;
                let mut fork = crate::session_forks::info(db, id)?;
                if fork.is_null() {
                    let parts = resource["logicalPath"]
                        .as_str()
                        .unwrap_or("")
                        .split('/')
                        .collect::<Vec<_>>();
                    if parts.len() == 5
                        && parts[1] == "forks"
                        && Uuid::parse_str(parts[2]).is_ok()
                        && Uuid::parse_str(parts[4]).is_ok()
                        && ["desktop", "terminal", "warp", "iterm2"].contains(&parts[3])
                    {
                        fork = json!({"parentId":parts[2],"nativeId":entry["nativeId"],"destination":parts[3],"createdAt":resource["updatedAt"]});
                    }
                }
                if !fork.is_null() {
                    resource["fork"] = fork;
                }
            }
            if let Some(object) = resource.as_object_mut() {
                object.remove("paths");
                object.remove("nativeId");
            }
            resources.insert(
                resource["resourceId"]
                    .as_str()
                    .ok_or("Missing resource")?
                    .to_owned(),
                resource,
            );
        }
    }
    let resources = resources.into_values().collect::<Vec<_>>();
    Ok(json!({"resources":resources,"errors":errors}))
}

#[tauri::command]
pub async fn local_resource_catalog(
    project_id: String,
    kind: String,
    account_id: String,
    service_origin: String,
) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = projects::lock()?;
        let db = db::open()?;
        if db::get(&db, "user")? != account_id
            || db::get(&db, "config")?["apiUrl"]
                .as_str()
                .map(|value| value.trim_end_matches('/'))
                != Some(service_origin.trim_end_matches('/'))
        {
            return Err("Account or service changed. Open the collection again.".into());
        }
        let project = governance::project(&db, &project_id)?;
        catalog(&db, &project, &kind)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn local_entry(db: &Connection, id: &str) -> Result<Option<(Value, Value)>> {
    let published = shared(db, id)?;
    let direct = db::rows(db, "SELECT value FROM local_resources WHERE id=?", &[&id])?
        .into_iter()
        .next();
    let project_id = direct
        .as_ref()
        .and_then(|entry| {
            entry["projectId"]
                .as_str()
                .or(entry["resource"]["projectId"].as_str())
        })
        .or_else(|| {
            published
                .as_ref()
                .and_then(|resource| resource["projectId"].as_str())
        });
    let project_id = match project_id {
        Some(id) => id.to_owned(),
        None => db::rows(db,"SELECT json_object('projectId',project) FROM local_resources WHERE id=? UNION ALL SELECT json_object('projectId',project) FROM drafts WHERE json_extract(value,'$.resource.resourceId')=? LIMIT 1",&[&id,&id])?.first().and_then(|entry| entry["projectId"].as_str()).ok_or("Resource unavailable")?.to_owned(),
    };
    let project = governance::project(db, &project_id)?;
    for kind in ["memory", "session", "plan"] {
        for entry in entries(db, &project, kind)? {
            if entry["resource"]["resourceId"] == id
                || (entry["resource"]["kind"] == "memory"
                    && entry["resource"]["source"] != "shared"
                    && selected_memory_id(&project, &entry["resource"]) == id)
            {
                return Ok(Some((project, entry)));
            }
        }
    }
    Ok(None)
}

/// Local reading content is deliberately separate from governance::resource,
/// which remains the source for every operation that mutates shared resources.
pub fn resource(db: &Connection, id: &str) -> Result<Value> {
    if let Some((project, entry)) = local_entry(db, id)? {
        if let Some(mut resource) = normalize(db, &project, &entry)? {
            if resource["owner"] == db::get(db, "user")? {
                resource["paths"] = entry["paths"].clone();
                resource["nativeId"] = entry["nativeId"].clone();
            }
            return Ok(resource);
        }
    }
    let resource = governance::resource(db, id)?;
    governance::project(db, resource["projectId"].as_str().ok_or("Missing project")?)?;
    Ok(resource)
}

pub fn native_binding(db: &Connection, resource: &Value) -> Result<Option<Value>> {
    if resource["kind"] != "session" || resource["owner"] != db::get(db, "user")? {
        return Ok(None);
    }
    let id = resource["resourceId"].as_str().ok_or("Missing resource")?;
    let Some((project, entry)) = local_entry(db, id)? else {
        return Ok(None);
    };
    let source =
        sources::for_resource(&project, resource).ok_or("Connect this session's repository")?;
    sources::validate(&source)?;
    let Some(native_id) = entry["nativeId"].as_str() else {
        return Ok(None);
    };
    let path = Path::new(
        entry["paths"][0]
            .as_str()
            .ok_or("Native session unavailable")?,
    );
    let home = if resource["source"] == "codex" {
        crate::native::codex_home()?
    } else {
        crate::native::claude_home()?
    };
    if !path
        .canonicalize()
        .map_err(|e| e.to_string())?
        .starts_with(home.canonicalize().map_err(|e| e.to_string())?)
    {
        return Err("This session uses a different native home. Open the collection again.".into());
    }
    let bytes = if resource["source"] == "codex" {
        crate::history::read_session(path)?
    } else {
        std::fs::read(path).map_err(|e| e.to_string())?
    };
    let records = crate::native::complete_records(&bytes)?;
    let (actual, cwd, _) = crate::native::session_info(
        resource["source"].as_str().ok_or("Missing provider")?,
        &records,
    )?;
    if actual != native_id
        || !cwd.starts_with(Path::new(source["path"].as_str().ok_or("Missing source")?))
    {
        return Err("The session's native identity changed. Open the collection again.".into());
    }
    Ok(Some(
        json!({"base":resource,"nativeId":native_id,"paths":entry["paths"]}),
    ))
}
