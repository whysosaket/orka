use crate::{
    db::{self, Result},
    governance, indexer, projects, sources, sync,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use uuid::Uuid;

pub const QUEUE_PATH: &str = "/local/selected-share";

pub(crate) fn context(db: &Connection, input: &Value) -> Result<Value> {
    let user = db::get(db, "user")?;
    let config = db::get(db, "config")?;
    if !user.is_string() || input["accountId"] != user {
        return Err("Connect the same Orka account in the plugin and desktop app".into());
    }
    let origin = input["serviceOrigin"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Choose the Orka service")?;
    if Some(origin.trim_end_matches('/'))
        != config["apiUrl"].as_str().map(|s| s.trim_end_matches('/'))
    {
        return Err("The plugin and desktop app must use the same Orka service".into());
    }
    let id = input["projectId"].as_str().ok_or("Choose a project")?;
    Uuid::parse_str(id).map_err(|_| "Invalid project")?;
    governance::project(db, id)
}

pub fn catalog(db: &Connection, project: &Value, input: &Value) -> Result<Value> {
    let kind = input["kind"].as_str().ok_or("Choose a resource category")?;
    let items = indexer::discover(db, project, kind)?;
    let query = input["query"].as_str().unwrap_or("").to_lowercase();
    let offset = input["offset"].as_u64().unwrap_or(0) as usize;
    let items: Vec<_> = items
        .into_iter()
        .filter(|item| {
            (input["sourceId"].is_null() || item["resource"]["sourceId"] == input["sourceId"])
                && (input["nativeId"].is_null() || item["nativeId"] == input["nativeId"])
                && format!(
                    "{} {}",
                    item["resource"]["title"], item["resource"]["logicalPath"]
                )
                .to_lowercase()
                .contains(&query)
        })
        .collect();
    let page: Vec<_> = items.iter().skip(offset).take(50).map(|item| {
        let r = &item["resource"];
        json!({"resourceId":r["resourceId"],"sourceId":r["sourceId"],"kind":r["kind"],"provider":r["source"],"title":r["title"],"logicalPath":r["logicalPath"],"nativeId":item["nativeId"],"snapshotHash":indexer::manifest_hash(&r["files"])})
    }).collect();
    Ok(
        json!({"items":page,"nextOffset":if offset.saturating_add(50)<items.len(){Some(offset+50)}else{None},"automaticSharingChanged":false}),
    )
}

pub fn preview(db: &Connection, project: &Value, input: &Value) -> Result<Value> {
    let kind = input["kind"].as_str().ok_or("Choose a resource category")?;
    let local = indexer::discover(db, project, kind)?
        .into_iter()
        .find(|item| item["resource"]["resourceId"] == input["resourceId"])
        .ok_or("Local resource unavailable; list this category again")?;
    let mut resource = local["resource"].clone();
    let scoped = sources::for_resource(project, &resource)
        .ok_or("Connect this resource's repository on this Mac")?;
    sources::validate(&scoped)?;
    resource = crate::context_sharing::publication_resource(
        db,
        project["id"].as_str().ok_or("Missing project")?,
        &resource,
    )?;
    let base = db::rows(
        db,
        "SELECT value FROM resources WHERE id=? AND project=?",
        &[
            &resource["resourceId"].as_str().ok_or("Missing resource")?,
            &project["id"].as_str().ok_or("Missing project")?,
        ],
    )?
    .first()
    .map(|r| r["revision"].clone())
    .unwrap_or(json!(0));
    let token = Uuid::new_v4().to_string();
    let change_id = Uuid::new_v5(&Uuid::NAMESPACE_URL, json!({"account":input["accountId"],"service":input["serviceOrigin"],"project":project["id"],"resource":resource,"base":base}).to_string().as_bytes()).to_string();
    let change = json!({"version":2,"id":change_id,"projectId":project["id"],"deviceId":db::device(db)?,"baseRevision":base,"resource":resource});
    let expires = chrono::Utc::now().timestamp() + 600;
    db::set(
        db,
        &format!("share-preview:{token}"),
        &json!({"accountId":input["accountId"],"serviceOrigin":input["serviceOrigin"],"projectId":project["id"],"sourceId":resource["sourceId"],"path":scoped["path"],"folderIdentity":scoped["folderIdentity"],"paths":local["paths"],"nativeId":local["nativeId"],"localResourceId":local["resource"]["resourceId"],"expires":expires,"change":change}),
    )?;
    let bytes: u64 = resource["files"]
        .as_array()
        .ok_or("Missing files")?
        .iter()
        .filter_map(|file| file["size"].as_u64())
        .sum();
    Ok(
        json!({"previewToken":token,"expiresAt":expires,"title":resource["title"],"kind":resource["kind"],"sourceId":resource["sourceId"],"files":resource["files"],"totalBytes":bytes,"snapshotHash":indexer::manifest_hash(&resource["files"]),"automaticSharingChanged":false,"note":"This exact snapshot will be shared. Later edits and future turns remain private unless automatic sharing is enabled or you explicitly share again."}),
    )
}

pub fn queue(db: &Connection, project: &Value, input: &Value) -> Result<Value> {
    let token = input["previewToken"]
        .as_str()
        .ok_or("Preview this item before sharing it")?;
    let preview = db::get(db, &format!("share-preview:{token}"))?;
    for key in ["accountId", "serviceOrigin", "projectId"] {
        if preview[key] != input[key] {
            return Err("Share preview belongs to another account, service, or project".into());
        }
    }
    if preview["expires"].as_i64().unwrap_or(0) < chrono::Utc::now().timestamp() {
        return Err("Share preview expired; preview this item again".into());
    }
    let scoped = sources::for_resource(project, &preview["change"]["resource"])
        .ok_or("Connect this resource's repository")?;
    sources::validate(&scoped)?;
    if scoped["path"] != preview["path"] || scoped["folderIdentity"] != preview["folderIdentity"] {
        return Err("Connected repository changed; preview this item again".into());
    }
    let change = &preview["change"];
    let id = change["id"].as_str().ok_or("Missing share request")?;
    let key = format!("selected-share:{id}");
    let prior = db::get(db, &key)?;
    let hash = db::digest(change.to_string().as_bytes());
    if !prior.is_null() && prior["payloadHash"] != hash {
        return Err("Share request no longer matches the preview".into());
    }
    let pending: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM outbox WHERE id=?)",
            [id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !prior.is_null() && (prior["status"] != "queued" || pending) {
        return Ok(prior);
    }
    let receipt = json!({"requestId":id,"projectId":project["id"],"accountId":input["accountId"],"serviceOrigin":input["serviceOrigin"],"payloadHash":hash,"status":"queued","automaticSharingChanged":false,"paths":preview["paths"],"nativeId":preview["nativeId"],"localResourceId":preview["localResourceId"],"path":preview["path"],"folderIdentity":preview["folderIdentity"]});
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    db::set(&tx, &key, &receipt)?;
    tx.execute(
        "INSERT INTO outbox VALUES(?,?,?,?,NULL)",
        params![id, project["id"].as_str(), QUEUE_PATH, change.to_string()],
    )
    .map_err(|e| e.to_string())?;
    db::set(&tx, "syncRequest", &json!(Uuid::new_v4().to_string()))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(receipt)
}

pub fn authorized(db: &Connection, queued: &Value) -> Result<bool> {
    if queued["path"] != QUEUE_PATH {
        return Ok(false);
    }
    let id = queued["id"].as_str().ok_or("Missing request")?;
    let receipt = db::get(db, &format!("selected-share:{id}"))?;
    Ok(receipt["status"] == "queued"
        && receipt["accountId"] == db::get(db, "user")?
        && receipt["serviceOrigin"]
            .as_str()
            .map(|s| s.trim_end_matches('/'))
            == db::get(db, "config")?["apiUrl"]
                .as_str()
                .map(|s| s.trim_end_matches('/'))
        && receipt["projectId"] == queued["project"]
        && queued["value"]["projectId"] == queued["project"]
        && receipt["payloadHash"] == db::digest(queued["value"].to_string().as_bytes()))
}

pub async fn send(db: &Connection, owner: &str, queued: &Value) -> Result<Value> {
    if !authorized(db, queued)? {
        return Err("Selected share authorization no longer matches this snapshot".into());
    }
    if sync::api_as(owner, "GET", "/v2/projects/capabilities", None).await?["selectedSharing"] != 1
    {
        return Err("Update the Orka service to support one-off sharing. The selected snapshot is queued on this Mac.".into());
    }
    sync::api_as(owner,"POST","/v2/devices",Some(&json!({"id":queued["value"]["deviceId"],"name":std::env::var("HOSTNAME").unwrap_or("Mac".into())}))).await?;
    crate::repair::upload(
        owner,
        queued["project"].as_str().ok_or("Missing project")?,
        &queued["value"]["resource"],
    )
    .await?;
    sync::api_as(
        owner,
        "POST",
        "/v2/sharing/selected",
        Some(&queued["value"]),
    )
    .await
}

pub fn complete(db: &Connection, queued: &Value, result: &Value) -> Result<()> {
    let id = queued["id"].as_str().ok_or("Missing share request")?;
    let mut receipt = db::get(db, &format!("selected-share:{id}"))?;
    match result["status"].as_str() {
        Some("published" | "conflict") => {
            let actual = &result["receipt"]["event"]["resource"];
            let selected = &queued["value"]["resource"];
            if actual["resourceId"] != selected["resourceId"]
                || actual["projectId"] != queued["project"]
                || actual["kind"] != selected["kind"]
                || (result["status"] == "published"
                    && selected["kind"] == "session"
                    && actual["files"] != selected["files"])
            {
                return Err("Share receipt differs from the selected resource".into());
            }
            if result["status"] == "conflict"
                && !result["receipt"]["event"]["conflicts"]
                    .as_array()
                    .is_some_and(|items| {
                        items.iter().any(|item| {
                            item["id"] == queued["id"]
                                && item["candidate"]["files"] == selected["files"]
                        })
                    })
            {
                return Err("Conflict receipt did not retain the selected snapshot".into());
            }
            sync::apply_event(db, &result["receipt"]["event"])?;
            if result["status"] == "published"
                && actual["resourceId"] == receipt["localResourceId"]
                && actual["files"] == selected["files"]
                && receipt["paths"]
                    .as_array()
                    .is_some_and(|paths| !paths.is_empty())
            {
                let project =
                    governance::project(db, queued["project"].as_str().ok_or("Missing project")?)?;
                if sources::for_resource(&project, actual).is_some_and(|source| {
                    source["path"] == receipt["path"]
                        && source["folderIdentity"] == receipt["folderIdentity"]
                }) {
                    let resource_id = actual["resourceId"].as_str().ok_or("Missing resource")?;
                    let mut binding = indexer::binding(db, resource_id)?;
                    let hash = indexer::manifest_hash(&selected["files"]);
                    binding["base"] = actual.clone();
                    binding["paths"] = receipt["paths"].clone();
                    binding["nativeId"] = receipt["nativeId"].clone();
                    binding["lastSeenHash"] = json!(hash);
                    binding["writeGuard"] = json!(hash);
                    binding["guards"] = json!(vec![
                        hash;
                        receipt["paths"]
                            .as_array()
                            .ok_or("Missing paths")?
                            .len()
                    ]);
                    binding["reviewedRevision"] = actual["revision"].clone();
                    binding["installationState"] = json!("current");
                    db::upsert(
                        db,
                        "bindings",
                        resource_id,
                        queued["project"].as_str().ok_or("Missing project")?,
                        &binding,
                    )?;
                }
            }
        }
        Some("approval_required") => {
            if result["request"]["id"] != queued["id"]
                || result["request"]["resourceId"] != queued["value"]["resource"]["resourceId"]
                || result["request"]["projectId"] != queued["project"]
            {
                return Err("Approval request differs from the selected resource".into());
            }
        }
        _ => return Err("Invalid selected share receipt".into()),
    }
    receipt["status"] = result["status"].clone();
    receipt["result"] = result.clone();
    db::set(db, &format!("selected-share:{id}"), &receipt)
}

pub async fn command(action: &str, input: &Value) -> Result<Value> {
    let _lock = projects::lock()?;
    let db = db::open()?;
    let project = context(&db, input)?;
    match action {
        "list_local_resources" => catalog(&db, &project, input),
        "preview_share" => preview(&db, &project, input),
        "share_selected" => {
            let receipt = queue(&db, &project, input)?;
            if receipt["status"] != "queued" {
                return Ok(public_receipt(&receipt));
            }
            let id = receipt["requestId"]
                .as_str()
                .ok_or("Missing share request")?;
            let queued = db::rows(&db,"SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox WHERE id=?",&[&id])?.into_iter().next().ok_or("Queued share unavailable")?;
            let owner = input["accountId"].as_str().ok_or("Sign in required")?;
            let attempt = send(&db, owner, &queued).await;
            match attempt {
                Ok(result) => {
                    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
                    complete(&tx, &queued, &result)?;
                    tx.execute("DELETE FROM outbox WHERE id=?", [id])
                        .map_err(|e| e.to_string())?;
                    tx.commit().map_err(|e| e.to_string())?;
                    Ok(public_receipt(&db::get(
                        &db,
                        &format!("selected-share:{id}"),
                    )?))
                }
                Err(error) => {
                    db.execute("UPDATE outbox SET error=? WHERE id=?", params![error, id])
                        .map_err(|e| e.to_string())?;
                    Ok(
                        json!({"requestId":id,"status":"queued","error":error,"automaticSharingChanged":false}),
                    )
                }
            }
        }
        _ => Err("Unknown local sharing operation".into()),
    }
}

fn public_receipt(receipt: &Value) -> Value {
    let mut result = json!({"requestId":receipt["requestId"],"status":receipt["status"],"automaticSharingChanged":false});
    if !receipt["result"].is_null() {
        result["result"] = receipt["result"].clone();
    }
    result
}
