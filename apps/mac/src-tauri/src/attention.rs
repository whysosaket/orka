use crate::{
    db::{self, Result},
    governance, indexer, packages, sources, sync,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn blocked(db: &Connection, project: &str, id: &str, binding: &Value) -> Result<bool> {
    let queued: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM outbox WHERE project=?1 AND (json_extract(value,'$.resource.resourceId')=?2 OR json_extract(value,'$.resourceId')=?2)) OR EXISTS(SELECT 1 FROM conflicts WHERE project=?1 AND json_extract(value,'$.resourceId')=?2) OR EXISTS(SELECT 1 FROM drafts WHERE project=?1 AND json_extract(value,'$.status')='proposed' AND (json_extract(value,'$.resource.resourceId')=?2 OR json_extract(value,'$.submission.resource.resourceId')=?2))",
        params![project, id],
        |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    let pending = db::get(db, &format!("requests:{project}"))?
        .as_array()
        .is_some_and(|requests| {
            requests
                .iter()
                .any(|request| request["resourceId"] == id && request["status"] == "pending")
        });
    Ok(queued
        || pending
        || binding["needsCopy"] == true
        || binding["mirrorReview"] == true
        || !db::get(db, &format!("installation:{id}"))?.is_null())
}

fn paths(project: &Value, resource: &Value) -> Result<Vec<PathBuf>> {
    let root = Path::new(project["path"].as_str().ok_or("Connect a folder")?);
    let logical = resource["logicalPath"]
        .as_str()
        .ok_or("Missing resource path")?;
    if resource["kind"] == "skill" {
        let name = packages::safe_relative(logical)?;
        if name.components().count() != 1 {
            return Err("Skill must have a single folder name".into());
        }
        Ok(vec![
            root.join(".agents/skills").join(&name),
            root.join(".claude/skills").join(&name),
        ])
    } else {
        Ok(vec![root.join(packages::safe_relative(
            logical
                .strip_prefix("instructions/")
                .ok_or("Not an instruction resource")?,
        )?)])
    }
}

fn matching_paths(project: &Value, resource: &Value, binding: &Value) -> Result<Option<Value>> {
    sources::validate(project)?;
    let root = Path::new(project["path"].as_str().ok_or("Connect a folder")?);
    let paths = paths(project, resource)?;
    if binding["paths"].as_array().is_some_and(|existing| {
        existing.iter().any(|value| {
            value.as_str().is_none_or(|raw| {
                let path = Path::new(raw);
                !paths.iter().any(|expected| {
                    path == expected
                        || path.canonicalize().is_ok_and(|path| {
                            expected
                                .canonicalize()
                                .is_ok_and(|expected| path == expected)
                        })
                })
            })
        })
    }) {
        return Ok(None);
    }
    for path in &paths {
        let parent = path.parent().ok_or("Missing parent")?;
        if !parent.is_dir() {
            return Ok(None);
        }
        packages::safe_directory(root, parent)?;
        if !path.try_exists().map_err(|error| error.to_string())? {
            return Ok(None);
        }
    }
    let candidate = json!({"paths":paths,"base":resource});
    let guards = sync::live_hash(
        &candidate,
        resource["kind"].as_str().ok_or("Missing kind")?,
        root,
    )?;
    let accepted = indexer::manifest_hash(&resource["files"]);
    Ok(
        (!guards.is_empty() && guards.iter().all(|hash| hash == &accepted))
            .then(|| json!({"paths":paths,"guards":guards})),
    )
}

/// Adopt existing identical instructions without rewriting the user's file.
pub fn matching_instruction(
    db: &Connection,
    project: &Value,
    resource: &Value,
    binding: &Value,
) -> Result<Option<Value>> {
    if project["governed"] != true
        || resource["kind"] != "memory"
        || !governance::protected(resource)
        || resource["deleted"] == true
        || resource["revision"].as_u64().unwrap_or(0) == 0
        || binding["reviewedRevision"] == resource["revision"]
        || !crate::projects::sharing_allowed(project, "memory")
    {
        return Ok(None);
    }
    let id = resource["resourceId"].as_str().ok_or("Missing resource")?;
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    if blocked(db, project_id, id, binding)? {
        return Ok(None);
    }
    let Some(matching) = matching_paths(project, resource, binding)? else {
        return Ok(None);
    };
    let mut next = binding.clone();
    if next["base"].is_object() {
        next["previous"] = next["base"].clone();
    }
    next["base"] = resource.clone();
    next["paths"] = matching["paths"].clone();
    next["guards"] = matching["guards"].clone();
    next["reviewedRevision"] = resource["revision"].clone();
    next["availableRevision"] = resource["revision"].clone();
    next["installationState"] = json!("current");
    next["lastSeenHash"] = json!(indexer::manifest_hash(&resource["files"]));
    next["writeGuard"] = next["lastSeenHash"].clone();
    Ok(Some(next))
}

/// Settle proven local lifecycle state; snapshots and unresolved operations remain intact.
pub fn reconcile_project(db: &Connection, project: &Value, apply: bool) -> Result<Value> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let mut instructions = 0;
    let mut archived = 0;
    let mut preserved = 0;
    let tx = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    for resource in db::rows(
        &tx,
        "SELECT value FROM resources WHERE project=? AND (json_extract(value,'$.kind')='skill' OR (json_extract(value,'$.kind')='memory' AND json_extract(value,'$.logicalPath') LIKE 'instructions/%'))",
        &[&project_id],
    )? {
        let Some(source) = sources::for_resource(project, &resource) else {
            continue;
        };
        let id = resource["resourceId"].as_str().ok_or("Missing resource")?;
        let binding = indexer::binding(&tx, id)?;
        if let Ok(Some(next)) = matching_instruction(&tx, &source, &resource, &binding) {
            instructions += 1;
            if apply {
                db::upsert(&tx, "bindings", id, project_id, &next)?;
            }
        }
        let drafts = db::rows(
            &tx,
            "SELECT value FROM drafts WHERE project=? AND json_extract(value,'$.resource.resourceId')=? AND json_extract(value,'$.status')='local'",
            &[&project_id, &id],
        )?;
        if drafts.is_empty() {
            continue;
        }
        let binding = indexer::binding(&tx, id)?;
        let eligible = resource["kind"] == "skill"
            && crate::projects::sharing_allowed(&source, "skill")
            && resource["deleted"] != true
            && resource["revision"].as_u64().unwrap_or(0) > 0
            && binding["installationState"] == "current"
            && binding["base"]["resourceId"] == resource["resourceId"]
            && binding["base"]["sourceId"] == resource["sourceId"]
            && binding["base"]["revision"] == resource["revision"]
            && binding["base"]["files"] == resource["files"]
            && !blocked(&tx, project_id, id, &binding)?
            && matching_paths(&source, &resource, &binding)
                .ok()
                .flatten()
                .is_some();
        for mut draft in drafts {
            if !eligible
                || !draft["requestId"].is_null()
                || !draft["submission"].is_null()
                || draft["resource"]["sourceId"] != resource["sourceId"]
                || draft["resource"]["files"] == resource["files"]
            {
                preserved += 1;
                continue;
            }
            archived += 1;
            if apply {
                draft["status"] = json!("dismissed");
                draft["dismissalReason"] = json!("superseded");
                draft["supersededByRevision"] = resource["revision"].clone();
                draft["archivedAt"] = json!(db::now());
                db::upsert(
                    &tx,
                    "drafts",
                    draft["id"].as_str().ok_or("Missing draft")?,
                    project_id,
                    &draft,
                )?;
            }
        }
    }
    if apply {
        tx.commit().map_err(|error| error.to_string())?;
    }
    Ok(
        json!({"projectId":project_id,"applied":apply,"instructionsReconciled":instructions,"draftsArchived":archived,"draftsPreserved":preserved}),
    )
}
