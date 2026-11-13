use crate::{
    db::{self, Result},
    global_skills, indexer, native, packages, projects, selective_sharing, sources, sync,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::PathBuf};

fn metadata(resource: &Value, origin: &str) -> Value {
    json!({"skillId":resource["resourceId"],"resourceId":resource["resourceId"],"origin":origin,"sourceId":resource["sourceId"],"title":resource["title"],"logicalPath":resource["logicalPath"],"revision":resource["revision"],"files":resource["files"],"snapshotHash":indexer::manifest_hash(&resource["files"])})
}

pub(crate) fn skills(db: &Connection, project: &Value, input: &Value) -> Result<Value> {
    let mut items = Vec::new();
    for item in indexer::discover(db, project, "skill")? {
        items.push(metadata(&item["resource"], "local"));
    }
    let id = project["id"].as_str().ok_or("Missing project")?;
    for resource in db::rows(db, "SELECT value FROM resources WHERE project=? AND json_extract(value,'$.kind')='skill' AND json_extract(value,'$.deleted') IS NOT 1", &[&id])? {
        items.push(metadata(&resource, "shared"));
    }
    let selected = sources::views(project).into_iter().find(|source| {
        source["path"].is_string()
            && (input["sourceId"].is_null() || source["sourceId"] == input["sourceId"])
    });
    let mut errors = Vec::new();
    if let Some(source) = selected {
        let scan =
            serde_json::to_value(global_skills::scan(db, &source)?).map_err(|e| e.to_string())?;
        errors = scan["errors"].as_array().cloned().unwrap_or_default();
        for item in scan["skills"].as_array().into_iter().flatten() {
            let files = match packages::directory(&PathBuf::from(
                item["path"].as_str().ok_or("Missing skill path")?,
            )) {
                Ok(files) => files,
                Err(error) => {
                    errors.push(json!(error));
                    continue;
                }
            };
            items.push(json!({"skillId":item["id"],"origin":"global","sourceId":null,"title":item["name"],"logicalPath":item["name"],"providers":item["sources"],"files":files,"snapshotHash":indexer::manifest_hash(&json!(files))}));
        }
    }
    let query = input["query"].as_str().unwrap_or("").to_lowercase();
    items.retain(|item| {
        (item["origin"] == "global"
            || input["sourceId"].is_null()
            || item["sourceId"] == input["sourceId"])
            && format!("{} {}", item["title"], item["logicalPath"])
                .to_lowercase()
                .contains(&query)
    });
    items.sort_by_key(|item| format!("{}:{}", item["origin"], item["skillId"]));
    let offset = input["offset"].as_u64().unwrap_or(0) as usize;
    let next = offset.saturating_add(50);
    Ok(
        json!({"items":items.iter().skip(offset).take(50).collect::<Vec<_>>(),"nextOffset":if next < items.len(){Some(next)}else{None},"errors":errors,"sharedCacheOnly":true,"note":"Shared entries reflect this Mac's last authorized sync. Remote list_skills checks current access. Installation revalidates shared access and revision."}),
    )
}

pub(crate) fn status(db: &Connection, project: &Value, input: &Value) -> Result<Value> {
    let id = project["id"].as_str().ok_or("Missing project")?;
    let offset = input["offset"].as_u64().unwrap_or(0) as usize;
    let queued = db::rows(db, "SELECT json_object('requestId',id,'operation',path,'resourceId',coalesce(json_extract(value,'$.resource.resourceId'),json_extract(value,'$.resourceId')),'error',error) FROM outbox WHERE project=? ORDER BY rowid", &[&id])?;
    let conflicts = db::rows(db, "SELECT json_object('conflictId',id,'resourceId',json_extract(value,'$.resourceId'),'createdAt',json_extract(value,'$.createdAt')) FROM conflicts WHERE project=? ORDER BY rowid", &[&id])?;
    let errors = db::rows(db, "SELECT json_object('source',source,'error',error) FROM errors WHERE source=? OR substr(source,1,length(?)+1)=?||':' OR source IN (SELECT id FROM resources WHERE project=?) ORDER BY source", &[&id,&id,&id,&id])?;
    let mut recoveries = db::rows(db, "SELECT json_object('kind','source_removal','reason','source_removed','status','needs_review','draftId',id,'resourceId',json_extract(value,'$.resource.resourceId'),'requestId',coalesce(json_extract(value,'$.sourceRemoval.queued.id'),json_extract(value,'$.requestId'),json_extract(value,'$.request.id')),'sourceId',json_extract(value,'$.sourceRemoval.sourceId'),'removedAt',json_extract(value,'$.sourceRemoval.removedAt'),'operation',json_extract(value,'$.sourceRemoval.queued.path')) FROM drafts WHERE project=? AND json_type(value,'$.sourceRemoval')='object' AND json_extract(value,'$.status') IN ('local','proposed') ORDER BY rowid", &[&id])?;
    let removed_count = recoveries.len();
    for recovery in &mut recoveries {
        if let Some(request) = recovery["requestId"].as_str() {
            let receipt = db::get(db, &format!("selected-share:{request}"))?;
            if receipt["projectId"] == id && receipt["result"]["reason"] == "source_removed" {
                recovery["selectedStatus"] = receipt["status"].clone();
                recovery["selectedReason"] = json!("source_removed");
            }
        }
    }
    let installations = db::rows(db, "SELECT json_object('kind','installation','reason','installation_recovery','status','needs_review','installationKey',key,'resourceId',json_extract(value,'$.resourceId'),'sourceId',json_extract(value,'$.project.sourceId')) FROM meta WHERE key LIKE 'installation:%' AND value!='null' AND json_extract(value,'$.project.id')=? ORDER BY key", &[&id])?;
    let installation_count = installations.len();
    recoveries.extend(installations);
    let recovery_count = recoveries.len();
    let pending = queued.len();
    let blocked = queued
        .iter()
        .filter(|item| item["error"].as_str().is_some_and(sync::terminal_error))
        .count();
    let last = db::get(db, "sync")?;
    let project_sync = db::get(db, &format!("plugin-sync:{id}"))?;
    let timestamp = |value: &Value| {
        value["updatedAt"]
            .as_str()
            .or(value["lastSync"].as_str())
            .and_then(|stamp| chrono::DateTime::parse_from_rfc3339(stamp).ok())
    };
    let (latest, latest_scope) = if !project_sync.is_null()
        && (last.is_null() || timestamp(&project_sync) > timestamp(&last))
    {
        (&project_sync, "project")
    } else {
        (&last, "account")
    };
    let health = if recovery_count > 0 {
        "needs_review"
    } else if !conflicts.is_empty() {
        "conflict"
    } else if !errors.is_empty() || blocked > 0 {
        "error"
    } else if latest["online"] == false {
        "offline"
    } else if pending > 0 {
        "pending"
    } else {
        "idle"
    };
    let running = db::daemon_running()?;
    let folders: Vec<_> = sources::views(project)
        .iter()
        .map(|source| json!({"sourceId":source["sourceId"],"state":sources::folder_state(source)}))
        .collect();
    Ok(
        json!({"projectId":id,"health":health,"accountSync":last,"projectSync":project_sync,"lastAttemptScope":latest_scope,"progress":sync::current_progress(db,running)?,"progressScope":"account","workerRunning":running,"queuedCount":pending,"blockedCount":blocked,"conflictCount":conflicts.len(),"errorCount":errors.len(),"recoveryCount":recovery_count,"sourceRemovalCount":removed_count,"installationRecoveryCount":installation_count,"recoveries":recoveries.iter().skip(offset).take(50).collect::<Vec<_>>(),"queued":queued.iter().skip(offset).take(50).collect::<Vec<_>>(),"conflicts":conflicts.iter().skip(offset).take(50).collect::<Vec<_>>(),"errors":errors.iter().skip(offset).take(50).collect::<Vec<_>>(),"nextOffset":if offset.saturating_add(50)<pending.max(conflicts.len()).max(errors.len()).max(recovery_count){Some(offset+50)}else{None},"folders":folders}),
    )
}

pub(crate) fn retry(db: &Connection, project: &Value) -> Result<Value> {
    let id = project["id"].as_str().ok_or("Missing project")?;
    let queued = db::rows(
        db,
        "SELECT json_object('id',id,'error',error) FROM outbox WHERE project=?",
        &[&id],
    )?;
    let mut retried = 0;
    let mut blocked = 0;
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    for item in queued {
        if item["error"].as_str().is_some_and(sync::terminal_error) {
            blocked += 1;
        } else {
            tx.execute(
                "UPDATE outbox SET error=NULL WHERE id=? AND project=?",
                params![item["id"].as_str(), id],
            )
            .map_err(|e| e.to_string())?;
            retried += 1;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(
        json!({"eligibleCount":retried,"blockedCount":blocked,"pendingChangesPreserved":true,"note":"Stale conflicts and permission failures require review; their queued payloads and request IDs were preserved."}),
    )
}

fn validate_files(files: &[Value]) -> Result<()> {
    if files.is_empty() || files.len() > 200 || !files.iter().any(|f| f["path"] == "SKILL.md") {
        return Err("A complete skill package with SKILL.md is required".into());
    }
    packages::reject_env_files(files)?;
    let mut names = HashSet::new();
    let mut total = 0u64;
    for file in files {
        let path = file["path"].as_str().ok_or("Missing skill file path")?;
        packages::safe_relative(path)?;
        if !names.insert(path.to_lowercase()) {
            return Err("Skill file paths collide".into());
        }
        let size = file["size"].as_u64().ok_or("Missing skill file size")?;
        total = total.checked_add(size).ok_or("Skill exceeds size limits")?;
        if size > 1_000_000 || total > 4_000_000 {
            return Err("Skill exceeds size limits".into());
        }
        let hash = file["hash"].as_str().ok_or("Missing skill file hash")?;
        let bytes = db::blob_read(hash)?;
        if bytes.len() as u64 != size || db::digest(&bytes) != hash {
            return Err("Skill file verification failed".into());
        }
    }
    Ok(())
}

pub(crate) fn install(
    db: &Connection,
    project: &Value,
    resource: &Value,
    input: &Value,
) -> Result<Value> {
    if resource["kind"] != "skill" || resource["deleted"] == true {
        return Err("Choose an available skill package".into());
    }
    let files = resource["files"].as_array().ok_or("Missing skill files")?;
    validate_files(files)?;
    if input["snapshotHash"] != indexer::manifest_hash(&resource["files"]) {
        return Err("Skill changed; list and review it again before installing".into());
    }
    let name = packages::safe_relative(
        resource["logicalPath"]
            .as_str()
            .ok_or("Missing skill folder")?,
    )?;
    if name.components().count() != 1 || name.to_string_lossy().starts_with('.') {
        return Err("Skill needs a single visible folder name".into());
    }
    let target = input["target"]
        .as_str()
        .ok_or("Choose an installation target")?;
    let source = if target == "project" {
        let source = sources::select(project, input["sourceId"].as_str())?;
        sources::validate(&source)?;
        source
    } else {
        project.clone()
    };
    let (base, paths) = match target {
        "project" => {
            let root = PathBuf::from(source["path"].as_str().ok_or("Connect a folder")?);
            let paths = vec![
                root.join(".agents/skills").join(&name),
                root.join(".claude/skills").join(&name),
            ];
            (root, paths)
        }
        "codex" => {
            let root = native::codex_home()?;
            (root.clone(), vec![root.join("skills").join(&name)])
        }
        "claude" => {
            let root = native::claude_home()?;
            (root.clone(), vec![root.join("skills").join(&name)])
        }
        _ => return Err("Unsupported coding agent".into()),
    };
    if !base.is_dir() {
        return Err(
            "The selected coding agent's home is unavailable; initialize that agent first".into(),
        );
    }
    for path in &paths {
        if fs::symlink_metadata(path).is_ok() {
            let existing = packages::directory(path)?;
            if indexer::manifest_hash(&json!(existing))
                != indexer::manifest_hash(&resource["files"])
            {
                return Err("An existing skill differs at the selected target. Existing files were preserved.".into());
            }
        }
    }
    // Project mirrors use the existing durable journal and rollback path.
    if target == "project" {
        let id = indexer::scoped_resource_id(
            db,
            &source,
            "skill",
            name.to_str().ok_or("Invalid skill folder")?,
        )?;
        packages::install_mirrors(db, &source, &id, &paths, files)?;
    } else {
        for path in &paths {
            packages::install(&base, path, files)?;
        }
    }
    Ok(
        json!({"status":"installed","target":target,"paths":paths,"files":files.len(),"snapshotHash":input["snapshotHash"],"automaticSharingChanged":false,"note":"Installation does not publish the skill. Existing automatic project sharing choices still apply to subsequent sync."}),
    )
}

pub(crate) async fn command(action: &str, input: &Value) -> Result<Value> {
    if action == "get_sync_status" {
        let db = db::open()?;
        let project = selective_sharing::context(&db, input)?;
        return status(&db, &project, input);
    }
    let lock = projects::lock()?;
    let db = db::open()?;
    let project = selective_sharing::context(&db, input)?;
    match action {
        "list_skills" => skills(&db, &project, input),
        "install_skill" => {
            let id = input["skillId"].as_str().ok_or("Choose a skill")?;
            let origin = input["origin"]
                .as_str()
                .ok_or("Choose the skill's origin")?;
            let resource = match origin {
                "local" => indexer::discover(&db, &project, "skill")?
                    .into_iter()
                    .find(|item| item["resource"]["resourceId"] == id)
                    .map(|item| item["resource"].clone())
                    .ok_or("Local skill unavailable; list skills again")?,
                "global" => {
                    let source = sources::select(&project, input["sourceId"].as_str())?;
                    let skill = global_skills::scan(&db, &source)?
                        .skills
                        .into_iter()
                        .find(|skill| skill.id == id)
                        .ok_or("Global skill unavailable; list skills again")?;
                    json!({"kind":"skill","logicalPath":skill.name,"files":packages::directory(&skill.path)?,"deleted":false})
                }
                "shared" => {
                    uuid::Uuid::parse_str(id).map_err(|_| "Invalid shared skill")?;
                    let owner = input["accountId"].as_str().ok_or("Sign in required")?;
                    if input["expectedRevision"]
                        .as_u64()
                        .is_none_or(|revision| revision == 0)
                    {
                        return Err(
                            "Review the shared skill's current revision before installing".into(),
                        );
                    }
                    let config = db::get(&db, "config")?;
                    let origin = config["apiUrl"].as_str().ok_or("Choose a service")?;
                    let authorized=sync::api_at(owner,origin,"POST","/v2/governance/action",Some(&json!({"action":"installation","input":{"projectId":project["id"],"resourceId":id,"expectedRevision":input["expectedRevision"]}}))).await?;
                    let resource = authorized["resource"].clone();
                    if resource["projectId"] != project["id"]
                        || resource["resourceId"] != id
                        || resource["revision"] != input["expectedRevision"]
                        || resource["kind"] != "skill"
                        || resource["deleted"] == true
                    {
                        return Err(
                            "Shared skill changed or is unavailable; list skills again".into()
                        );
                    }
                    sync::download(owner, &resource).await?;
                    let current = db::open()?;
                    selective_sharing::context(&current, input)?;
                    resource
                }
                _ => return Err("Unknown skill origin".into()),
            };
            install(&db, &project, &resource, input)
        }
        "retry_sync" | "repair_sync" => {
            let before = status(&db, &project, &json!({}))?;
            let mut result = json!({"before":before,"accountScope":"Account project permissions and device metadata are refreshed. Revoked access still uses Orka's private-draft preservation and cleanup workflow."});
            if action == "repair_sync" {
                let repaired = (|| {
                    for source in sources::views(&project) {
                        if source["path"].is_null() {
                            continue;
                        }
                        sources::validate(&source)?;
                        crate::repair::project_state(&db, &source)?;
                    }
                    packages::recover_project_installations(&db, &project)
                })();
                db::set(&db, "syncProgress", &Value::Null)?;
                repaired?;
                result["repair"] = json!({"pendingChangesPreserved":true,"note":"Recovered guarded local bindings and interrupted skill installations. Conflicts and pending edits are retained."});
            }
            result["retry"] = retry(&db, &project)?;
            let owner = input["accountId"].as_str().ok_or("Sign in required")?;
            let origin = db::get(&db, "config")?["apiUrl"]
                .as_str()
                .ok_or("Choose a service")?
                .to_string();
            let id = project["id"].as_str().ok_or("Missing project")?;
            drop(db);
            drop(lock);
            let attempted = sync::plugin_once(owner, &origin, id).await;
            let db = db::open()?;
            let project = selective_sharing::context(&db, input)?;
            result["after"] = status(&db, &project, &json!({}))?;
            result["status"] = json!(
                if result["after"]["conflictCount"].as_u64().unwrap_or(0) > 0
                    || result["after"]["blockedCount"].as_u64().unwrap_or(0) > 0
                    || result["after"]["recoveryCount"].as_u64().unwrap_or(0) > 0
                {
                    "needs_review"
                } else if attempted.is_err()
                    || result["after"]["queuedCount"].as_u64().unwrap_or(0) > 0
                    || result["after"]["errorCount"].as_u64().unwrap_or(0) > 0
                {
                    "pending"
                } else {
                    "completed"
                }
            );
            if let Err(error) = attempted {
                result["error"] = json!(error);
            }
            Ok(result)
        }
        _ => Err("Unknown local Orka tool".into()),
    }
}
