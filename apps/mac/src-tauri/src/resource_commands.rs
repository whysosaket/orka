use crate::{
    db::{self, Result},
    governance, indexer, packages, projects, sources, sync,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use uuid::Uuid;

pub(crate) fn context(db: &Connection, input: &Value) -> Result<Value> {
    let user = db::get(db, "user")?;
    let config = db::get(db, "config")?;
    let origin = input["serviceOrigin"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("Account or service changed. Reopen the item actions.")?;
    if !user.is_string()
        || input["accountId"] != user
        || Some(origin.trim_end_matches('/'))
            != config["apiUrl"].as_str().map(|v| v.trim_end_matches('/'))
    {
        return Err("Account or service changed. Reopen the item actions.".into());
    }
    let id = input["projectId"].as_str().ok_or("Choose a project")?;
    Uuid::parse_str(id).map_err(|_| "Invalid project")?;
    governance::project(db, id)
}

fn reading_resource(db: &Connection, project: &Value, input: &Value) -> Result<Value> {
    let id = input["resourceId"].as_str().ok_or("Choose an item")?;
    let resource = match crate::global_skills::local_skill(db, id)? {
        Some(resource) => resource,
        None => crate::local_resources::resource(db, id)?,
    };
    if resource["projectId"] != project["id"] || resource["deleted"] == true {
        return Err("This item is no longer available in this project.".into());
    }
    if resource["access"]["mode"] == "hidden" {
        return Err("This item is no longer available to you.".into());
    }
    Ok(resource)
}

fn source(project: &Value, resource: &Value) -> Result<Value> {
    let source = sources::registered(project, resource["sourceId"].as_str())?;
    if source["sourceId"] != resource["sourceId"] {
        return Err("The item's repository changed. Reopen the item actions.".into());
    }
    if source["path"].is_string() {
        sources::validate(&source)?;
    }
    Ok(source)
}

fn canonical_path(base: &Path, path: &Path) -> Result<PathBuf> {
    let relative = path
        .strip_prefix(base)
        .map_err(|_| "Item path is outside its source")?;
    if !relative.as_os_str().is_empty() {
        packages::safe_relative(&relative.to_string_lossy())?;
    }
    if fs::symlink_metadata(base)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Symlinked item locations are unavailable".into());
    }
    let root = base.canonicalize().map_err(|e| e.to_string())?;
    let actual = path
        .canonicalize()
        .map_err(|_| "Item is not available on this Mac")?;
    if actual != root.join(relative) {
        return Err("Symlinked item locations are unavailable".into());
    }
    Ok(actual)
}

fn checked_paths(resource: &Value, source: &Value, binding: &Value) -> Result<Vec<PathBuf>> {
    let Some(root) = source["path"].as_str().map(Path::new) else {
        return Ok(vec![]);
    };
    let raw = if resource["paths"].is_array() {
        &resource["paths"]
    } else {
        &binding["paths"]
    };
    let mut paths = Vec::new();
    for raw in raw.as_array().into_iter().flatten() {
        let mut path = PathBuf::from(raw.as_str().ok_or("Invalid item path")?);
        let base = match resource["kind"].as_str() {
            Some("session") => {
                if resource["source"] == "codex" {
                    if let Some(id) = binding["nativeId"]
                        .as_str()
                        .or(resource["nativeId"].as_str())
                    {
                        path = crate::history::current_path(&path, id)?;
                    }
                    crate::native::codex_home()?
                } else {
                    crate::native::claude_home()?
                }
            }
            Some("plan") => crate::plans::path_base(
                root,
                resource["source"].as_str().ok_or("Missing plan provider")?,
                &path,
            )?,
            Some("memory") if !path.starts_with(root) && resource["source"] == "claude" => {
                indexer::claude_memory(root)?
            }
            Some("memory") if !path.starts_with(root) && resource["source"] == "codex" => {
                crate::native::codex_home()?.join("memories")
            }
            Some("memory" | "skill") => root.to_path_buf(),
            _ => return Err("This item has no supported local location".into()),
        };
        paths.push(canonical_path(&base, &path)?);
    }
    Ok(paths)
}

pub(crate) fn paths(db: &Connection, project: &Value, input: &Value) -> Result<Vec<PathBuf>> {
    if !input["resourceId"].is_string() {
        let source = sources::select(project, input["sourceId"].as_str())?;
        sources::validate(&source)?;
        let root = Path::new(
            source["path"]
                .as_str()
                .ok_or("Connect this source folder")?,
        );
        return Ok(vec![canonical_path(root, root)?]);
    }
    let resource = reading_resource(db, project, input)?;
    let source = source(project, &resource)?;
    let binding = indexer::binding(db, input["resourceId"].as_str().ok_or("Choose an item")?)?;
    let paths = checked_paths(&resource, &source, &binding)?;
    if paths.is_empty() {
        return Err("This item has no local file on this Mac.".into());
    }
    Ok(paths)
}

fn scope_identity(source: &Value) -> Value {
    json!({"sourceId":source["sourceId"],"path":source["path"],"folderIdentity":source["folderIdentity"],"repository":source["repository"],"repositoryRevision":source["repositoryRevision"]})
}

pub(crate) fn requires_delete_capability(project: &Value, resource: &Value) -> bool {
    resource["kind"] == "memory" || (resource["kind"] != "session" && project["governed"] != true)
}

pub(crate) fn check_delete_capability(
    project: &Value,
    resource: &Value,
    capabilities: &Value,
) -> Result<()> {
    if requires_delete_capability(project, resource) && capabilities["resourceDeletion"] != 1 {
        return Err("Update your Orka service before deleting this shared item. This service cannot safely check the reviewed version yet.".into());
    }
    Ok(())
}

async fn require_delete_service(db: &Connection, project: &Value, input: &Value) -> Result<()> {
    let resource = governance::resource(db, input["resourceId"].as_str().ok_or("Choose an item")?)?;
    require_delete(db, project, &resource)?;
    if requires_delete_capability(project, &resource) {
        let config = db::get(db, "config")?;
        let capabilities = sync::api_at(
            input["accountId"].as_str().ok_or("Sign in required")?,
            config["apiUrl"].as_str().ok_or("Choose a service")?,
            "GET",
            "/v2/projects/capabilities",
            None,
        )
        .await
        .map_err(|error| {
            if error == "Cloud unavailable; local work stays queued" {
                "Connect to your Orka service to review this deletion. Nothing has been queued."
                    .into()
            } else {
                error
            }
        })?;
        context(db, input)?;
        check_delete_capability(project, &resource, &capabilities)?;
    }
    Ok(())
}

fn require_delete(db: &Connection, project: &Value, resource: &Value) -> Result<()> {
    if resource["projectId"] != project["id"]
        || resource["deleted"] == true
        || resource["local"] == true
        || resource["localChanges"] == true
        || resource["revision"].as_u64().unwrap_or(0) == 0
    {
        return Err(
            "Only an accepted shared item can be deleted here. Review local changes first.".into(),
        );
    }
    if !matches!(
        resource["kind"].as_str(),
        Some("memory" | "skill" | "plan" | "session")
    ) {
        return Err("This item cannot be deleted here.".into());
    }
    if resource["kind"] == "memory"
        && (project["governed"] != true
            || resource["source"] != "shared"
            || governance::protected(resource))
    {
        return Err(
            "Remove project instructions or native memory through their reviewed source workflow."
                .into(),
        );
    }
    if project["rolePolicies"].is_object() {
        if project["role"] != "owner"
            && !(project["role"] == "admin" && resource["access"]["mode"] == "publish")
        {
            return Err(
                "Only the Owner or an Admin with write access can delete shared content.".into(),
            );
        }
    } else if (project["role"] != "owner" && resource["access"]["mode"] != "publish")
        || (resource["kind"] == "session" && resource["owner"] != db::get(db, "user")?)
    {
        return Err("You do not have permission to delete this shared item.".into());
    }
    Ok(())
}

fn deletion_state(db: &Connection, project: &Value, resource: &Value) -> Result<Value> {
    require_delete(db, project, resource)?;
    let reading = reading_resource(db, project, &json!({"resourceId":resource["resourceId"]}))?;
    if reading["local"] == true || reading["localChanges"] == true {
        return Err(
            "This item has local changes. Review them before deleting the shared version.".into(),
        );
    }
    let source = source(project, resource)?;
    let id = resource["resourceId"].as_str().ok_or("Missing item")?;
    let mut binding = indexer::binding(db, id)?;
    if resource["kind"] == "session" && reading["nativeId"].is_string() {
        if let Some(native) = crate::local_resources::native_binding(db, &reading)? {
            binding = native;
        }
    }
    let pending: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE project=?1 AND (json_extract(value,'$.resource.resourceId')=?2 OR json_extract(value,'$.resourceId')=?2)) OR EXISTS(SELECT 1 FROM conflicts WHERE project=?1 AND json_extract(value,'$.resourceId')=?2) OR EXISTS(SELECT 1 FROM drafts WHERE project=?1 AND json_extract(value,'$.status') IN ('local','proposed') AND (json_extract(value,'$.resource.resourceId')=?2 OR json_extract(value,'$.submission.resource.resourceId')=?2))",rusqlite::params![project["id"].as_str(),id],|row|row.get(0)).map_err(|e|e.to_string())?;
    if pending
        || binding["needsCopy"] == true
        || binding["mirrorReview"] == true
        || !db::get(db, &format!("installation:{id}"))?.is_null()
    {
        return Err("Review this item's pending changes or conflicts before deleting it.".into());
    }
    let paths = checked_paths(resource, &source, &binding)?;
    if resource["kind"] == "memory" {
        let root = source["path"].as_str().map(Path::new);
        if paths.iter().any(|path| {
            root.is_none_or(|root| {
                path != &root
                    .join(".orka/memory/resources")
                    .join(id)
                    .join("content.md")
            })
        }) {
            return Err("Refresh this memory's shared installation before deleting it. Personal memory is kept.".into());
        }
    }
    if resource["kind"] == "session" {
        if let Some(native_id) = binding["nativeId"].as_str() {
            if crate::native::active(
                db,
                native_id,
                resource["source"]
                    .as_str()
                    .ok_or("Missing session provider")?,
            ) {
                return Err("Close the native session before deleting it.".into());
            }
        }
    }
    let guards = if let Some(root) = source["path"]
        .as_str()
        .map(Path::new)
        .filter(|_| !paths.is_empty())
    {
        let guards = sync::live_hash(
            &binding,
            resource["kind"].as_str().ok_or("Missing category")?,
            root,
        )?;
        let base = indexer::manifest_hash(&binding["base"]["files"]);
        if guards.iter().enumerate().any(|(i, hash)| {
            hash != &base
                && Some(hash.as_str())
                    != binding["guards"][i]
                        .as_str()
                        .or(binding["writeGuard"].as_str())
        }) {
            return Err(
                "This item has local changes. Review them before deleting the shared version."
                    .into(),
            );
        }
        guards
    } else {
        vec![]
    };
    Ok(json!({"source":scope_identity(&source),"paths":paths,"guards":guards,"binding":binding}))
}

pub(crate) fn preview_delete(db: &Connection, project: &Value, input: &Value) -> Result<Value> {
    let resource = governance::resource(db, input["resourceId"].as_str().ok_or("Choose an item")?)?;
    let state = deletion_state(db, project, &resource)?;
    let note = match resource["kind"].as_str() {
        Some("memory") => "Removes this memory from shared project context and its installed shared copies. Personal learned memory is kept. Previously exported copies are not recalled.",
        Some("skill") => "Removes this skill from shared project context and installed project skill folders on Macs that sync skills. The original global skill is kept. Local edits need review before removal.",
        Some("plan") => "Removes this plan from shared project context and materialized plan files on Macs that sync plans. An extracted plan's original session remains intact.",
        Some("session") => "Removes this session from shared history. Synced native copies may be archived in Codex or removed from Claude history. Active or locally changed sessions are preserved until reviewed.",
        _ => unreachable!(),
    };
    let token = Uuid::new_v4().to_string();
    let mut wire = json!({});
    for key in [
        "resourceId",
        "sourceId",
        "kind",
        "source",
        "logicalPath",
        "title",
        "memory",
        "contextSources",
    ] {
        if !resource[key].is_null() {
            wire[key] = resource[key].clone();
        }
    }
    wire["deleted"] = json!(true);
    wire["files"] = json!([]);
    let request = json!({"version":2,"id":Uuid::new_v4().to_string(),"projectId":project["id"],"deviceId":db::device(db)?,"baseRevision":resource["revision"],"resource":wire});
    let expires = chrono::Utc::now().timestamp() + 600;
    db::set(
        db,
        &format!("resource-delete:{token}"),
        &json!({"accountId":input["accountId"],"serviceOrigin":input["serviceOrigin"],"projectId":project["id"],"resourceId":resource["resourceId"],"resource":resource,"state":state,"request":request,"expires":expires}),
    )?;
    Ok(
        json!({"previewToken":token,"title":resource["title"],"kind":resource["kind"],"revision":resource["revision"],"snapshotHash":indexer::manifest_hash(&resource["files"]),"paths":state["paths"],"note":note,"expiresAt":expires}),
    )
}

pub(crate) fn delete_request(db: &Connection, project: &Value, input: &Value) -> Result<Value> {
    let token = input["previewToken"]
        .as_str()
        .ok_or("Review this deletion first")?;
    let preview = db::get(db, &format!("resource-delete:{token}"))?;
    for key in ["accountId", "serviceOrigin", "projectId", "resourceId"] {
        if preview[key] != input[key] {
            return Err("This deletion preview belongs to another item or account.".into());
        }
    }
    if preview["result"].is_object() {
        return Ok(preview);
    }
    if preview["expires"].as_i64().unwrap_or(0) < chrono::Utc::now().timestamp() {
        return Err("Deletion preview expired. Review the current item again.".into());
    }
    let current = governance::resource(db, input["resourceId"].as_str().ok_or("Choose an item")?)?;
    if current != preview["resource"] || deletion_state(db, project, &current)? != preview["state"]
    {
        return Err("The item or its local files changed. Review the deletion again.".into());
    }
    Ok(preview)
}

pub(crate) fn complete_delete(
    db: &Connection,
    input: &Value,
    preview: &Value,
    receipt: &Value,
) -> Result<Value> {
    let resource = &receipt["event"]["resource"];
    if resource["resourceId"] != input["resourceId"]
        || resource["projectId"] != input["projectId"]
        || resource["kind"] != preview["resource"]["kind"]
        || resource["sourceId"] != preview["resource"]["sourceId"]
        || resource["source"] != preview["resource"]["source"]
        || resource["logicalPath"] != preview["resource"]["logicalPath"]
        || resource["revision"].as_u64().unwrap_or(0)
            <= preview["resource"]["revision"].as_u64().unwrap_or(0)
        || (receipt["conflict"] == true && resource["deleted"] == true)
        || (receipt["conflict"] != true
            && (resource["deleted"] != true
                || !resource["files"].as_array().is_some_and(Vec::is_empty)))
    {
        return Err(
            "The service returned a different deletion result. Refresh the item before retrying."
                .into(),
        );
    }
    let result = json!({"status":if receipt["conflict"] == true {"conflict"} else {"deleted"},"resourceId":resource["resourceId"],"revision":resource["revision"],"requestId":preview["request"]["id"],"localRemoval":"sync_or_review","automaticSharingChanged":false});
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    sync::apply_event(&tx, &receipt["event"])?;
    let mut saved = preview.clone();
    saved["result"] = result.clone();
    db::set(
        &tx,
        &format!(
            "resource-delete:{}",
            input["previewToken"].as_str().ok_or("Missing preview")?
        ),
        &saved,
    )?;
    db::set(&tx, "syncRequest", &json!(Uuid::new_v4().to_string()))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

async fn run(action: &str, input: &Value) -> Result<Value> {
    if action == "share" {
        {
            let _lock = projects::lock()?;
            let db = db::open()?;
            context(&db, input)?;
            let token = input["previewToken"]
                .as_str()
                .ok_or("Review this snapshot first")?;
            let preview = db::get(&db, &format!("share-preview:{token}"))?;
            for key in ["accountId", "serviceOrigin", "projectId"] {
                if preview[key] != input[key] {
                    return Err("This share preview belongs to another item or account.".into());
                }
            }
            if !input["resourceId"].is_string()
                || preview["desktopResourceId"] != input["resourceId"]
            {
                return Err("This share preview belongs to another item.".into());
            }
        }
        return crate::selective_sharing::command("share_selected", input).await;
    }
    let _lock = projects::lock()?;
    let db = db::open()?;
    let project = context(&db, input)?;
    match action {
        "paths" | "reveal" => {
            let paths = paths(&db, &project, input)?;
            if action == "reveal" {
                let status = Command::new("/usr/bin/open")
                    .arg("-R")
                    .args(&paths)
                    .status()
                    .map_err(|_| "Couldn't show the item in Finder")?;
                if !status.success() {
                    return Err("Couldn't show the item in Finder".into());
                }
            }
            Ok(json!({"paths":paths}))
        }
        "preview-share" => {
            let resource = reading_resource(&db, &project, input)?;
            if resource["owner"] != input["accountId"] && resource["kind"] != "skill" {
                return Err("Copy this teammate's item before sharing a continuation.".into());
            }
            let kind = resource["kind"].as_str().ok_or("Missing item category")?;
            let discovered = indexer::discover(&db, &project, kind)?;
            let local = discovered
                .into_iter()
                .find(|entry| {
                    entry["resource"]["resourceId"] == resource["resourceId"]
                        || (kind == "memory"
                            && crate::context_sharing::publication_id(
                                &db,
                                project["id"].as_str().unwrap_or(""),
                                &entry["resource"],
                            )
                            .is_ok_and(|id| resource["resourceId"] == id))
                })
                .ok_or("The local source is unavailable. Refresh the collection and try again.")?;
            let mut selected = input.clone();
            selected["kind"] = json!(kind);
            selected["resourceId"] = local["resource"]["resourceId"].clone();
            let preview = crate::selective_sharing::preview(&db, &project, &selected)?;
            let key = format!(
                "share-preview:{}",
                preview["previewToken"]
                    .as_str()
                    .ok_or("Missing share preview")?
            );
            let mut saved = db::get(&db, &key)?;
            saved["desktopResourceId"] = input["resourceId"].clone();
            db::set(&db, &key, &saved)?;
            Ok(preview)
        }
        "preview-delete" => {
            require_delete_service(&db, &project, input).await?;
            preview_delete(&db, &project, input)
        }
        "delete" => {
            let preview = delete_request(&db, &project, input)?;
            if preview["result"].is_object() {
                return Ok(preview["result"].clone());
            }
            require_delete_service(&db, &project, input).await?;
            let preview = delete_request(&db, &project, input)?;
            let config = db::get(&db, "config")?;
            let receipt = sync::api_at(input["accountId"].as_str().ok_or("Sign in required")?, config["apiUrl"].as_str().ok_or("Choose a service")?, "POST", "/v2/sync/push", Some(&preview["request"])).await.map_err(|error| if error == "Cloud unavailable; local work stays queued" { "The deletion could not be confirmed. Reconnect and retry this reviewed deletion; it has not been queued.".into() } else { error })?;
            context(&db, input)?;
            complete_delete(&db, input, &preview, &receipt)
        }
        _ => Err("Unknown item action".into()),
    }
}

#[tauri::command]
pub async fn resource_command(action: String, input: Value) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(run(&action, &input))
    })
    .await
    .map_err(|error| error.to_string())?
}
