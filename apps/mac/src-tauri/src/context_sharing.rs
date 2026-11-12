use crate::{
    db::{self, Result},
    governance, indexer, projects,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use uuid::Uuid;

pub const QUEUE_PATH: &str = "/local/context-share";

pub fn publication_resource(db: &Connection, project: &str, resource: &Value) -> Result<Value> {
    let mut resource = resource.clone();
    if resource["kind"] == "memory" && resource["source"] != "shared" {
        // Reuse earlier promotions, including requests created before automatic sharing.
        let previous = db::rows(db, "SELECT value FROM drafts WHERE project=? AND json_extract(value,'$.resource.resourceId')=? AND json_extract(value,'$.submission.resource.resourceId') IS NOT NULL ORDER BY rowid LIMIT 1", &[&project, &resource["resourceId"].as_str()])?;
        let id = previous
            .first()
            .and_then(|draft| draft["submission"]["resource"]["resourceId"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                Uuid::new_v5(
                    &Uuid::NAMESPACE_URL,
                    format!(
                        "selected-memory:{}:{}",
                        json!(project),
                        resource["resourceId"]
                    )
                    .as_bytes(),
                )
                .to_string()
            });
        resource["memory"] = json!({"topic":resource["title"].as_str().unwrap_or("Shared memory").chars().take(160).collect::<String>(),"scope":"","provider":resource["source"],"supersedes":[]});
        resource["resourceId"] = json!(id);
        resource["source"] = json!("shared");
        resource["logicalPath"] = json!(format!("knowledge/{id}.md"));
    }
    Ok(resource)
}

pub fn publication_mode(db: &Connection, project: &str, resource: &Value) -> Result<String> {
    let catalog = db::get(db, &format!("governance:{project}"))?;
    if catalog["owner"] == true {
        return Ok("publish".into());
    }
    let resource = publication_resource(db, project, resource)?;
    let existing = db::rows(
        db,
        "SELECT value FROM resources WHERE id=? AND project=?",
        &[&resource["resourceId"].as_str(), &project],
    )?;
    if let Some(existing) = existing.first() {
        return Ok(existing["access"]["mode"]
            .as_str()
            .unwrap_or("hidden")
            .into());
    }
    let category = if governance::protected(&resource) && resource["kind"] == "memory" {
        "instructions"
    } else {
        resource["kind"]
            .as_str()
            .ok_or("Missing resource category")?
    };
    Ok(catalog["access"][category]["create"]
        .as_str()
        .unwrap_or("hidden")
        .into())
}

pub fn queue_automatic(db: &Connection, project: &Value, draft_id: &str) -> Result<()> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let draft = db::rows(
        db,
        "SELECT value FROM drafts WHERE id=? AND project=?",
        &[&draft_id, &project_id],
    )?
    .into_iter()
    .next()
    .ok_or("Draft unavailable")?;
    if draft["status"] == "local"
        && matches!(
            publication_mode(db, project_id, &draft["resource"])?.as_str(),
            "publish" | "suggest"
        )
    {
        queue(db, project, draft_id)?;
    }
    Ok(())
}

pub async fn approve_own_pending(
    db: &Connection,
    owner: &str,
    project: &Value,
    catalog: &Value,
) -> Result<()> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    db.execute(
        "DELETE FROM errors WHERE source GLOB ?",
        [format!("{project_id}:publish:*")],
    )
    .map_err(|error| error.to_string())?;
    let mut catalog = catalog.clone();
    for request in pending_publications(db, owner, project, &catalog)? {
        let result = crate::sync::api_as(owner, "POST", "/v2/governance/action", Some(&json!({"action":"decide","input":{"projectId":project_id,"id":request["id"],"decision":"approve","previewHash":request["previewHash"],"expectedPolicyRevision":catalog["policyRevision"]}}))).await;
        if result
            .as_ref()
            .is_err_and(|error| crate::sync::service_error(error))
        {
            return result.map(|_| ());
        }
        let result = result.and_then(|result| {
            governance::reconcile_requests(db, project_id, &json!([result.clone()]))?;
            if let Some(requests) = catalog["requests"].as_array_mut() {
                if let Some(current) = requests
                    .iter_mut()
                    .find(|current| current["id"] == result["id"])
                {
                    *current = result;
                }
            }
            db::set(db, &format!("governance:{project_id}"), &catalog)
        });
        crate::sync::record_result(
            db,
            &format!(
                "{project_id}:publish:{}",
                request["id"].as_str().unwrap_or("")
            ),
            result,
        )?;
    }
    Ok(())
}

pub(crate) fn pending_publications(
    db: &Connection,
    owner: &str,
    project: &Value,
    catalog: &Value,
) -> Result<Vec<Value>> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let mut pending = Vec::new();
    for draft in db::rows(
        db,
        "SELECT value FROM drafts WHERE project=? AND json_extract(value,'$.status')='proposed'",
        &[&project_id],
    )? {
        let kind = draft["resource"]["kind"].as_str().unwrap_or("");
        if !matches!(kind, "memory" | "skill") || !projects::sharing_allowed(project, kind) {
            continue;
        }
        let Some(request) = catalog["requests"].as_array().and_then(|requests| {
            requests
                .iter()
                .find(|request| request["id"] == draft["requestId"])
        }) else {
            continue;
        };
        if request["author"] != owner
            || request["status"] != "pending"
            || request["canReview"] != true
        {
            continue;
        }
        pending.push(request.clone());
    }
    Ok(pending)
}

pub fn queue(db: &Connection, project: &Value, draft_id: &str) -> Result<Value> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let mut draft = db::rows(
        db,
        "SELECT value FROM drafts WHERE id=? AND project=?",
        &[&draft_id, &project_id],
    )?
    .into_iter()
    .next()
    .ok_or("Draft unavailable")?;
    let kind = draft["resource"]["kind"]
        .as_str()
        .ok_or("Missing resource category")?;
    if !matches!(kind, "memory" | "skill") || draft["resource"]["deleted"] == true {
        return Err("Choose a memory or skill".into());
    }
    projects::require_sharing(db, project_id, kind)?;
    let (path, marker) = if kind == "skill" {
        (crate::global_skills::IMPORT_PATH, "skillImport")
    } else {
        (QUEUE_PATH, "contextDraft")
    };
    if matches!(
        draft["status"].as_str(),
        Some("proposed" | "published" | "approved" | "dismissed")
    ) {
        return Ok(json!({"status":draft["status"]}));
    }
    if draft["submission"].is_null() {
        let prepared = publication_resource(db, project_id, &draft["resource"])?;
        let mut resource = json!({});
        for key in [
            "resourceId",
            "sourceId",
            "kind",
            "source",
            "logicalPath",
            "title",
            "files",
            "deleted",
            "contextSources",
            "memory",
        ] {
            if !prepared[key].is_null() {
                resource[key] = prepared[key].clone();
            }
        }
        let base = db::rows(
            db,
            "SELECT value FROM resources WHERE id=? AND project=?",
            &[
                &resource["resourceId"].as_str().ok_or("Missing resource")?,
                &project_id,
            ],
        )?
        .first()
        .map(|resource| resource["revision"].clone())
        .unwrap_or(json!(0));
        draft["requestId"] = json!(uuid::Uuid::new_v4().to_string());
        draft["submission"] = json!({"version":2,"id":draft["requestId"],"projectId":project_id,"deviceId":db::device(db)?,"baseRevision":base,"resource":resource});
    }
    draft["automaticSharing"] = json!(true);
    let mut change = draft["submission"].clone();
    change[marker] = json!(draft_id);
    let tx = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    db::upsert(&tx, "drafts", draft_id, project_id, &draft)?;
    let pending: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM outbox WHERE id=?)",
            [change["id"].as_str()],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !pending {
        indexer::queue(&tx, project_id, path, &change)?;
        db::set(&tx, "syncRequest", &json!(uuid::Uuid::new_v4().to_string()))?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(json!({"status":"queued"}))
}

pub async fn share(db: &Connection, owner: &str, queued: &Value) -> Result<Value> {
    let mut change = queued["value"].clone();
    let fields = change.as_object_mut().ok_or("Missing import change")?;
    fields.remove("skillImport");
    fields.remove("contextDraft");
    fields.remove("reviewRequired");
    if queued["value"]["reviewRequired"] != true {
        match crate::sync::api_as(owner, "POST", "/v2/sync/push", Some(&change)).await {
            Ok(receipt) => return Ok(receipt),
            Err(error) if error.starts_with("403:") => {
                // Persist the route before submitting, so a lost response retries
                // the same approval request even if permissions later change.
                let mut value = queued["value"].clone();
                value["reviewRequired"] = json!(true);
                db.execute(
                    "UPDATE outbox SET value=? WHERE id=?",
                    rusqlite::params![value.to_string(), queued["id"].as_str()],
                )
                .map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error),
        }
    }
    let request = crate::sync::api_as(
        owner,
        "POST",
        "/v2/governance/action",
        Some(&json!({"action":"submit","input":{"projectId":change["projectId"],"change":change}})),
    )
    .await?;
    Ok(json!({"proposal":request}))
}

pub fn complete(db: &Connection, queued: &Value, receipt: &Value) -> Result<()> {
    let project_id = queued["project"].as_str().ok_or("Missing project")?;
    let draft_id = queued["value"]["skillImport"]
        .as_str()
        .or(queued["value"]["contextDraft"].as_str())
        .ok_or("Missing context draft")?;
    let mut draft = db::rows(
        db,
        "SELECT value FROM drafts WHERE id=? AND project=?",
        &[&draft_id, &project_id],
    )?
    .into_iter()
    .next()
    .ok_or("Context draft unavailable")?;
    if receipt["proposal"].is_object() {
        if receipt["proposal"]["projectId"] != project_id
            || receipt["proposal"]["resourceId"] != queued["value"]["resource"]["resourceId"]
            || receipt["proposal"]["id"] != queued["id"]
        {
            return Err("Approval request differs from the queued context".into());
        }
        draft["status"] = json!("proposed");
        draft["request"] = receipt["proposal"].clone();
    } else {
        let resource = &receipt["event"]["resource"];
        if resource["projectId"] != project_id
            || resource["resourceId"] != queued["value"]["resource"]["resourceId"]
            || resource["kind"] != queued["value"]["resource"]["kind"]
            || resource["deleted"] == true
            || (resource["kind"] == "skill"
                && resource["files"] != queued["value"]["resource"]["files"])
        {
            return Err("Published resource differs from the queued context".into());
        }
        crate::sync::apply_event(db, &receipt["event"])?;
        draft["status"] = json!("published");
    }
    db::upsert(db, "drafts", draft_id, project_id, &draft)?;
    if draft["status"] == "published" && draft["resource"]["kind"] == "skill" {
        let resource = &receipt["event"]["resource"];
        let project = governance::project(db, project_id)?;
        let binding = crate::global_skills::adopt_import(
            db,
            &project,
            resource,
            indexer::binding(
                db,
                resource["resourceId"].as_str().ok_or("Missing resource")?,
            )?,
        )?;
        db::upsert(
            db,
            "bindings",
            resource["resourceId"].as_str().ok_or("Missing resource")?,
            project_id,
            &binding,
        )?;
    }
    Ok(())
}
