use crate::{
    db::{self, Result},
    indexer, memory_context, packages, projects, sync,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub fn governed(project: &Value) -> bool {
    project["governed"] == true
}
pub fn context(db: &Connection, project: &Value, cwd: &Path) -> Result<(String, Vec<Value>)> {
    let (text, sources, _) = context_with_query(db, project, cwd, None, None)?;
    Ok((text, sources))
}
pub fn context_with_query(
    db: &Connection,
    project: &Value,
    cwd: &Path,
    query: Option<&str>,
    delivered: Option<&Value>,
) -> Result<(String, Vec<Value>, Value)> {
    crate::sources::validate(project)?;
    let root = Path::new(project["path"].as_str().ok_or("Connect a folder")?);
    let id = project["id"].as_str().ok_or("Missing project")?;
    let mut text = String::new();
    let mut sources = Vec::new();
    let mut fingerprints = delivered
        .cloned()
        .filter(Value::is_object)
        .unwrap_or(json!({}));
    for entry in memory_context::select(db, project, cwd, query)? {
        let r = entry.resource;
        let resource_id = r["resourceId"].as_str().ok_or("Missing resource")?;
        sources.push(json!(resource_id));
        if fingerprints[resource_id].as_str() == Some(&entry.fingerprint) {
            continue;
        }
        fingerprints[resource_id] = json!(entry.fingerprint);
        let path = if governed(project) {
            root.join(".orka/memory/resources")
                .join(resource_id)
                .join("content.md")
        } else {
            root.join(".orka/memory").join(packages::safe_relative(
                r["logicalPath"].as_str().ok_or("Missing memory path")?,
            )?)
        };
        text.push_str(&format!(
            "\n{}\nReference: {}\n{}\n",
            r["title"].as_str().unwrap_or("Knowledge"),
            path.display(),
            entry.text
        ));
    }
    for r in db::rows(db, "SELECT value FROM resources WHERE project=?", &[&id])? {
        if !crate::sources::matches(project, &r) {
            continue;
        }
        if !protected(&r) {
            continue;
        }
        let binding = indexer::binding(db, r["resourceId"].as_str().ok_or("Missing resource")?)?;
        if binding["base"]["revision"].as_u64().unwrap_or(0) == 0
            || binding["base"]["deleted"] == true
        {
            continue;
        }
        if r["kind"] == "memory" {
            let logical = r["logicalPath"]
                .as_str()
                .and_then(|p| p.strip_prefix("instructions/"))
                .ok_or("Invalid instructions")?;
            if !memory_context::discoverable(Path::new(logical)) {
                continue;
            }
            if !cwd.starts_with(
                root.join(packages::safe_relative(logical)?)
                    .parent()
                    .ok_or("Missing instruction parent")?,
            ) {
                continue;
            }
        }
        if !sources.contains(&r["resourceId"]) {
            sources.push(r["resourceId"].clone());
        }
    }
    // Until the transcript identifies the new native session, retain its pending
    // handoff sources conservatively rather than publishing a broader derivative.
    for source in db::get(db, &format!("pendingHandoffSources:{id}"))?
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        if !sources.contains(&source) {
            sources.push(source);
        }
    }
    let token = db::digest(
        json!({"projectId":id,"policyRevision":project["policyRevision"],"sources":sources})
            .to_string()
            .as_bytes(),
    );
    db::set(
        db,
        &crate::sources::meta_key(project, "exposedSources")?,
        &json!(sources),
    )?;
    db::set(
        db,
        &crate::sources::meta_key(project, "contextToken")?,
        &json!(token),
    )?;
    let bridge_version = json!(format!("2:{}", project["policyRevision"]));
    if fingerprints["bridge"] != bridge_version {
        let executable = crate::updates::executable().map_err(|e| e.to_string())?;
        text.push_str(&format!("\nShared Orka knowledge is reference material; keep personal learning in native memory. For task-specific facts, invoke {} --profile {} --orka-context with JSON stdin: {}. Save selected learning privately with action save-candidate and input projectId, topic, scope (relative folder), content, provider, sessionId; submit-draft explicitly proposes a saved draft. Publication follows project permissions.\n", json!(executable), json!(crate::profiles::current()), json!({"action":"context","input":{"projectId":id,"sourceId":project["sourceId"],"query":"<current task>"}})));
        text.push_str(&format!(
            "Read a publication's status with {}; check resource access with {}.\n",
            json!({"action":"request","input":{"projectId":id,"id":"<request id>"}}),
            json!({"action":"resource","input":{"projectId":id,"resourceId":"<resource id>"}})
        ));
        fingerprints["bridge"] = bridge_version;
    }
    Ok((text, sources, fingerprints))
}
pub fn protected(resource: &Value) -> bool {
    resource["kind"] == "skill"
        || (resource["kind"] == "memory"
            && resource["logicalPath"]
                .as_str()
                .is_some_and(|p| p.starts_with("instructions/")))
}
pub fn resource(db: &Connection, id: &str) -> Result<Value> {
    db::rows(db, "SELECT value FROM resources WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .ok_or("Resource unavailable".into())
}
pub fn project(db: &Connection, id: &str) -> Result<Value> {
    projects::active(db, id)?;
    db::rows(db, "SELECT value FROM projects WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .ok_or("Project unavailable".into())
}
pub fn capture(
    db: &Connection,
    project: &Value,
    resource: &Value,
    paths: &Value,
) -> Result<String> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let fingerprint = db::digest(
        format!(
            "{}:{}:{}",
            project_id,
            resource["resourceId"],
            indexer::manifest_hash(&resource["files"])
        )
        .as_bytes(),
    );
    let id = Uuid::new_v5(&Uuid::NAMESPACE_URL, fingerprint.as_bytes()).to_string();
    let mut resource = resource.clone();
    crate::sources::scope(project, &mut resource);
    if project["governed"] == true {
        let mut sources = resource["contextSources"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for source in db::get(db, &crate::sources::meta_key(project, "exposedSources")?)?
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            let personal = resource["kind"] == "memory"
                && resource["source"] != "shared"
                && paths[0].as_str().is_some_and(|path| {
                    !Path::new(path).starts_with(
                        Path::new(project["path"].as_str().unwrap_or(""))
                            .join(".orka/memory/resources"),
                    )
                });
            if (source != resource["resourceId"] || personal) && !sources.contains(&source) {
                sources.push(source);
            }
        }
        if !sources.is_empty() {
            resource["contextSources"] = json!(sources);
        }
    }
    let latest = if matches!(resource["kind"].as_str(), Some("memory" | "skill")) {
        db::rows(db,"SELECT value FROM drafts WHERE project=? AND json_extract(value,'$.resource.resourceId')=? ORDER BY coalesce(json_extract(value,'$.updatedAt'),json_extract(value,'$.createdAt')) DESC,rowid DESC LIMIT 1", &[&project_id,&resource["resourceId"].as_str()])?.into_iter().next()
    } else {
        None
    };
    let draft = json!({"id":id,"projectId":project_id,"resource":resource,"paths":paths,"status":"local","createdAt":db::now()});
    db.execute(
        "INSERT OR IGNORE INTO drafts VALUES(?,?,?)",
        params![id, project_id, draft.to_string()],
    )
    .map_err(|e| e.to_string())?;
    if matches!(resource["kind"].as_str(), Some("memory" | "skill"))
        && latest.as_ref().is_some_and(|latest| latest["id"] != id)
    {
        db.execute("UPDATE drafts SET value=json_remove(json_set(value,'$.status','local','$.resource',json(?)),'$.submission','$.requestId','$.request','$.dismissalReason') WHERE id=? AND project=? AND (json_extract(value,'$.status') IN ('published','approved') OR json_extract(value,'$.dismissalReason')='source_replaced')",params![resource.to_string(),id,project_id]).map_err(|error|error.to_string())?;
    }
    if resource["kind"] == "skill" || resource["kind"] == "memory" {
        db.execute(
            "UPDATE drafts SET value=json_set(value,'$.updatedAt',?) WHERE id=? AND project=?",
            params![db::now(), id, project_id],
        )
        .map_err(|e| e.to_string())?;
    }
    if resource["kind"] == "memory" {
        db.execute("UPDATE drafts SET value=json_set(value,'$.status','dismissed','$.dismissalReason','source_replaced') WHERE project=? AND id<>? AND json_extract(value,'$.status')='local' AND json_extract(value,'$.resource.resourceId')=?", params![project_id,id,resource["resourceId"].as_str()]).map_err(|e| e.to_string())?;
    }
    Ok(id)
}
pub fn localize_outbox(db: &Connection, project: &Value) -> Result<()> {
    if !governed(project) {
        return Ok(());
    }
    let id = project["id"].as_str().ok_or("Missing project")?;
    for q in db::rows(
        db,
        "SELECT json_object('id',id,'path',path,'value',json(value)) FROM outbox WHERE project=?",
        &[&id],
    )? {
        if q["path"] == crate::global_skills::IMPORT_PATH
            || q["path"] == crate::context_sharing::QUEUE_PATH
            || q["path"] == crate::selective_sharing::QUEUE_PATH
        {
            continue;
        }
        let r = &q["value"]["resource"];
        if r["kind"] == "memory" || r["kind"] == "skill" {
            let b = indexer::binding(db, r["resourceId"].as_str().ok_or("Missing resource")?)?;
            capture(db, project, r, &b["paths"])?;
            db.execute("DELETE FROM outbox WHERE id=?", [q["id"].as_str()])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub fn detach_legacy_memory(db: &Connection, project: &Value) -> Result<()> {
    if !governed(project) {
        return Ok(());
    }
    if crate::sources::validate(project).is_err() {
        return Ok(());
    }
    let Some(root) = project["path"].as_str().map(Path::new) else {
        return Ok(());
    };
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    for mut resource in db::rows(
        db,
        "SELECT value FROM resources WHERE project=? AND json_extract(value,'$.kind')='memory'",
        &[&project_id],
    )? {
        if !crate::sources::matches(project, &resource) {
            continue;
        }
        let old = root.join(".orka/memory").join(packages::safe_relative(
            resource["logicalPath"].as_str().ok_or("Missing path")?,
        )?);
        if !old.exists() {
            continue;
        }
        packages::safe_directory(root, old.parent().ok_or("Missing parent")?)?;
        let file = packages::file(&old, "content.md")?;
        if file["hash"] != resource["files"][0]["hash"] {
            resource["files"] = json!([file]);
            resource["deleted"] = json!(false);
            capture(db, project, &resource, &json!([old]))?;
        }
        fs::remove_file(old).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn reset(db: &Connection, project_id: &str, events: &Value) -> Result<()> {
    let project = db::rows(db, "SELECT value FROM projects WHERE id=?", &[&project_id])?
        .into_iter()
        .next()
        .ok_or("Project unavailable")?;
    let mut sources = crate::sources::views(&project);
    if project["sources"].is_array() {
        let mut global = project.clone();
        global["sourceId"] = Value::Null;
        global["path"] = Value::Null;
        sources.push(global);
    }
    for source in sources {
        reset_source(db, project_id, events, &source)?;
    }
    Ok(())
}

fn reset_source(db: &Connection, project_id: &str, events: &Value, p: &Value) -> Result<()> {
    if !db.is_autocommit() {
        return Err(
            "Permission refresh must persist private drafts before changing managed files".into(),
        );
    }
    let available = crate::sources::validate(p).is_ok();
    if let Some(root) = p["path"].as_str().filter(|_| available) {
        let index = Path::new(root).join(".orka/memory/index.md");
        if index.exists() {
            packages::safe_directory(Path::new(root), index.parent().ok_or("Missing parent")?)?;
            fs::remove_file(index).map_err(|e| e.to_string())?;
        }
    }
    detach_legacy_memory(db, p)?;
    let visible = events.as_array().ok_or("Invalid authorized snapshot")?;
    for handoff in db::rows(
        db,
        "SELECT value FROM meta WHERE key GLOB ?",
        &[&format!("handoff:{project_id}:*")],
    )? {
        if !crate::sources::matches(p, &handoff["resource"]) {
            continue;
        }
        if !available {
            continue;
        }
        if handoff["sources"].as_array().is_some_and(|sources| {
            sources
                .iter()
                .any(|id| !visible.iter().any(|e| e["resource"]["resourceId"] == *id))
        }) {
            let Some(root) = p["path"].as_str().map(Path::new) else {
                continue;
            };
            let path = Path::new(handoff["path"].as_str().ok_or("Invalid handoff")?);
            if !path.starts_with(root.join(".orka/handoffs")) {
                return Err("Unsafe handoff path".into());
            }
            if path.exists() {
                packages::safe_directory(root, path.parent().ok_or("Missing parent")?)?;
                let file = packages::file(path, "content.md")?;
                if file["hash"] != handoff["hash"] {
                    let id = Uuid::new_v4().to_string();
                    let draft = json!({"resourceId":id,"kind":"memory","source":"shared","logicalPath":format!("knowledge/{id}.md"),"title":"Private handoff edits","contextSources":handoff["sources"],"files":[file],"deleted":false});
                    capture(db, p, &draft, &json!([path]))?;
                }
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
    }
    if !p["path"].is_string() && !p["sources"].is_array() {
        db.execute(
            "DELETE FROM meta WHERE key GLOB ?",
            [format!("handoff:{project_id}:*")],
        )
        .map_err(|e| e.to_string())?;
    }
    let pending = db::get(db, &format!("pendingHandoffSources:{project_id}"))?
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|id| visible.iter().any(|e| e["resource"]["resourceId"] == *id))
        .collect::<Vec<_>>();
    db::set(
        db,
        &format!("pendingHandoffSources:{project_id}"),
        &json!(pending),
    )?;
    for r in db::rows(
        db,
        "SELECT value FROM resources WHERE project=?",
        &[&project_id],
    )? {
        if !crate::sources::matches(p, &r) {
            continue;
        }
        let id = r["resourceId"].as_str().ok_or("Missing resource")?;
        if visible.iter().any(|e| e["resource"]["resourceId"] == id) {
            continue;
        }
        let b = indexer::binding(db, id)?;
        for queued in db::rows(db,"SELECT json_object('id',id,'value',json(value)) FROM outbox WHERE project=? AND (json_extract(value,'$.resource.resourceId')=? OR json_extract(value,'$.resourceId')=?)",&[&project_id,&id,&id])? {
            if queued["value"]["resource"]["files"].is_array() {
                capture(db,p,&queued["value"]["resource"],&b["paths"])?;
            }
            db.execute("DELETE FROM outbox WHERE id=?",[queued["id"].as_str()]).map_err(|e|e.to_string())?;
        }
        // Capture dirty local files before removing Orka-managed copies from agent discovery.
        if let Some(paths) = b["paths"].as_array().filter(|_| available) {
            for raw in paths {
                let path = Path::new(raw.as_str().ok_or("Invalid binding")?);
                if !path.exists() {
                    continue;
                }
                let files = if r["kind"] == "skill" {
                    packages::directory(path)?
                } else {
                    vec![packages::file(path, "content.md")?]
                };
                if indexer::manifest_hash(&json!(files))
                    != indexer::manifest_hash(&b["base"]["files"])
                {
                    let mut draft = r.clone();
                    draft["files"] = json!(files);
                    capture(db, p, &draft, &json!([path]))?;
                }
                let root = Path::new(p["path"].as_str().unwrap_or(""));
                if (path.starts_with(root.join(".orka"))
                    || (protected(&r)
                        && (b["managed"] == true || b["base"]["owner"] != db::get(db, "user")?)))
                    && path.starts_with(root)
                    && !fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
                {
                    packages::safe_directory(root, path.parent().ok_or("Missing parent")?)?;
                    if path.is_dir() {
                        fs::remove_dir_all(path)
                    } else {
                        fs::remove_file(path)
                    }
                    .map_err(|e| e.to_string())?;
                }
            }
        }
        for table in ["resources", "bindings"] {
            db.execute(&format!("DELETE FROM {table} WHERE id=?"), [id])
                .map_err(|e| e.to_string())?;
        }
        db.execute(
            "DELETE FROM conflicts WHERE json_extract(value,'$.resourceId')=?",
            [id],
        )
        .map_err(|e| e.to_string())?;
        db.execute("DELETE FROM activity WHERE json_extract(value,'$.resourceId')=? OR json_extract(value,'$.copyId')=?",[id,id]).map_err(|e|e.to_string())?;
        db.execute("DELETE FROM errors WHERE source=?", [id])
            .map_err(|e| e.to_string())?;
    }
    db::set(
        db,
        &crate::sources::meta_key(p, "exposedSources")?,
        &Value::Null,
    )?;
    db::set(
        db,
        &crate::sources::meta_key(p, "contextToken")?,
        &Value::Null,
    )?;
    if let Some(root) = p["path"].as_str().filter(|_| available) {
        let index = Path::new(root).join(".orka/memory/index.md");
        if index.exists() {
            packages::safe_directory(Path::new(root), index.parent().ok_or("Missing parent")?)?;
            fs::remove_file(index).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub fn reconcile_requests(db: &Connection, project: &str, requests: &Value) -> Result<()> {
    for mut draft in db::rows(db, "SELECT value FROM drafts WHERE project=?", &[&project])? {
        if let Some(request) = requests
            .as_array()
            .and_then(|rows| rows.iter().find(|r| r["id"] == draft["requestId"]))
        {
            draft["status"] = match request["status"].as_str() {
                Some("pending") => json!("proposed"),
                Some("approved") => json!("published"),
                _ => request["status"].clone(),
            };
            draft["request"] = request.clone();
            db::upsert(
                db,
                "drafts",
                draft["id"].as_str().ok_or("Missing draft")?,
                project,
                &draft,
            )?;
        }
    }
    Ok(())
}
fn texts(files: &Value) -> Result<Value> {
    Ok(preview_files(files)?.0)
}
// Preserve the text-only response for existing consumers while exposing the
// hashes and decode result needed to distinguish binary-only changes.
fn preview_files(files: &Value) -> Result<(Value, Value)> {
    let mut result = serde_json::Map::new();
    let mut manifest = Vec::new();
    for f in files.as_array().ok_or("Missing files")? {
        let bytes = db::blob_read(f["hash"].as_str().ok_or("Missing hash")?)?;
        let content = String::from_utf8(bytes);
        let mut entry = f.clone();
        entry["binary"] = json!(content.is_err());
        result.insert(
            f["path"].as_str().ok_or("Missing file path")?.into(),
            content.map(Value::String).unwrap_or(json!("Binary asset")),
        );
        manifest.push(entry);
    }
    Ok((Value::Object(result), json!(manifest)))
}
fn related_knowledge(db: &Connection, project: &str, draft: &Value) -> Result<Vec<Value>> {
    fn words(text: &str) -> std::collections::BTreeSet<String> {
        text.split(|c: char| !c.is_alphanumeric())
            .filter(|s| s.len() > 3)
            .take(80)
            .map(str::to_lowercase)
            .collect()
    }
    let proposed = &draft["resource"];
    let topic = proposed["memory"]["topic"]
        .as_str()
        .or(proposed["title"].as_str())
        .unwrap_or("");
    let content = texts(&proposed["files"])?;
    let terms = words(&format!(
        "{topic} {}",
        content["content.md"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(8192)
            .collect::<String>()
    ));
    let mut related = Vec::new();
    for r in db::rows(db,"SELECT value FROM resources WHERE project=? AND json_extract(value,'$.kind')='memory' AND json_extract(value,'$.deleted')=0",&[&project])? {
        if r["sourceId"] != proposed["sourceId"] { continue; }
        if protected(&r) || r["resourceId"]==proposed["resourceId"] {continue;}
        let duplicate=r["files"][0]["hash"]==proposed["files"][0]["hash"];
        let accepted=texts(&r["files"])?;
        let title=r["memory"]["topic"].as_str().or(r["title"].as_str()).unwrap_or("");
        let tokens=words(&format!("{title} {}",accepted["content.md"].as_str().unwrap_or("").chars().take(8192).collect::<String>()));
        let overlap=terms.intersection(&tokens).count();
        if !duplicate && overlap==0 {continue;}
        let score=usize::from(duplicate)*100 + usize::from(title.eq_ignore_ascii_case(topic))*10 + usize::from(r["memory"]["scope"]==proposed["memory"]["scope"])*2 + overlap;
        related.push((score,json!({"resource":r,"duplicate":duplicate})));
    }
    related.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
    Ok(related.into_iter().take(5).map(|(_, r)| r).collect())
}
pub fn installation_binding(db: &Connection, r: &Value, p: &Value) -> Result<Value> {
    let p = crate::sources::for_resource(p, r).ok_or("Connect this resource's repository")?;
    crate::sources::validate(&p)?;
    let id = r["resourceId"].as_str().ok_or("Missing resource")?;
    let mut b = indexer::binding(db, id)?;
    if b["paths"].is_null() {
        let root = Path::new(p["path"].as_str().ok_or("Connect a folder")?);
        b["paths"] = if r["kind"] == "skill" {
            let name = packages::safe_relative(r["logicalPath"].as_str().ok_or("Missing path")?)?;
            json!([
                root.join(".agents/skills").join(&name),
                root.join(".claude/skills").join(&name)
            ])
        } else {
            json!([root.join(packages::safe_relative(
                r["logicalPath"]
                    .as_str()
                    .and_then(|s| s.strip_prefix("instructions/"))
                    .ok_or("Invalid instruction path")?
            )?)])
        };
    }
    Ok(b)
}
pub fn install_preview(db: &Connection, id: &str) -> Result<Value> {
    let r = resource(db, id)?;
    let p = project(db, r["projectId"].as_str().ok_or("Missing project")?)?;
    let p = crate::sources::for_resource(&p, &r).ok_or("Connect this resource's repository")?;
    if !governed(&p) || !protected(&r) {
        return Err("This resource does not require installation review".into());
    }
    let b = installation_binding(db, &r, &p)?;
    let guards = sync::live_hash(
        &b,
        r["kind"].as_str().ok_or("Missing kind")?,
        Path::new(p["path"].as_str().ok_or("Connect a folder")?),
    )?;
    let token = db::digest(json!({"resource":r,"guards":guards,"sourceId":p["sourceId"],"path":p["path"],"folderIdentity":p["folderIdentity"]}).to_string().as_bytes());
    let empty = indexer::manifest_hash(&json!([]));
    let dirty = guards.iter().any(|h| {
        h != &empty
            && h != &indexer::manifest_hash(&b["base"]["files"])
            && h != &indexer::manifest_hash(&r["files"])
    });
    let root = Path::new(p["path"].as_str().ok_or("Connect a folder")?);
    let mut copies = Vec::new();
    let mut first_existing = None;
    for raw in b["paths"].as_array().ok_or("Missing installation paths")? {
        let path = Path::new(raw.as_str().ok_or("Invalid installation path")?);
        packages::safe_directory(root, path.parent().ok_or("Missing parent")?)?;
        let exists = path.exists();
        let files = if !exists {
            vec![]
        } else if r["kind"] == "skill" {
            packages::directory(path)?
        } else {
            vec![packages::file(path, "content.md")?]
        };
        let (files, manifest) = preview_files(&json!(files))?;
        if exists && first_existing.is_none() {
            first_existing = Some(copies.len());
        }
        copies.push(json!({"path":path,"files":files,"manifest":manifest}));
    }
    let before = first_existing.and_then(|i| copies.get(i));
    let (after, after_manifest) = preview_files(&if r["deleted"] == true {
        json!([])
    } else {
        r["files"].clone()
    })?;
    Ok(
        json!({"token":token,"revision":r["revision"],"dirty":dirty,"guards":guards,"before":before.map(|c|c["files"].clone()).unwrap_or(json!({})),"beforeManifest":before.map(|c|c["manifest"].clone()).unwrap_or(json!([])),"after":after,"afterManifest":after_manifest,"copies":copies}),
    )
}
async fn remote(action: &str, input: &Value) -> Result<Value> {
    sync::api(
        "POST",
        "/v2/governance/action",
        Some(&json!({"action":action,"input":input})),
    )
    .await
}
#[tauri::command]
pub async fn governance_command(action: String, input: Value) -> Result<Value> {
    if !crate::env::enabled() && (input["class"] == "env" || action == "replace-env") {
        return Err("ENV support is disabled".into());
    }
    let _lock = if matches!(
        action.as_str(),
        "save-candidate"
            | "refresh-draft"
            | "submit-draft"
            | "dismiss"
            | "preview-install"
            | "apply-install"
            | "context"
    ) {
        Some(projects::lock()?)
    } else {
        None
    };
    let db = db::open()?;
    let account = db::get(&db, "user")?;
    let service = db::get(&db, "config")?["apiUrl"].clone();
    let project_id = input["projectId"].as_str().ok_or("Choose a project")?;
    let p = project(&db, project_id)?;
    let p = if matches!(action.as_str(), "context" | "save-candidate") {
        let source_id = input["sourceId"].as_str();
        if source_id.is_none() {
            if let Some(cwd) = input["cwd"].as_str() {
                crate::sources::views(&p)
                    .into_iter()
                    .filter(|source| {
                        source["path"]
                            .as_str()
                            .is_some_and(|path| Path::new(cwd).starts_with(path))
                    })
                    .max_by_key(|source| source["path"].as_str().unwrap_or("").len())
                    .ok_or("Context scope must be inside a connected repository")?
            } else {
                crate::sources::select(&p, None)?
            }
        } else {
            crate::sources::select(&p, source_id)?
        }
    } else {
        p
    };
    match action.as_str() {
        "drafts"=>return Ok(json!(db::rows(&db,"SELECT value FROM drafts WHERE project=? AND json_extract(value,'$.status')!='dismissed' ORDER BY rowid DESC",&[&project_id])?)),
        "dismiss"=>{
            db.execute("UPDATE drafts SET value=json_set(value,'$.status','dismissed') WHERE id=? AND project=?",params![input["id"].as_str(),project_id]).map_err(|e|e.to_string())?;return Ok(json!({"status":"local"}));
        }
        "save-candidate"=>{
            if !governed(&p) {return Err("Activate resource permissions first".into());}
            let text=input["content"].as_str().ok_or("Enter a memory")?;
            if text.len()>1_000_000 || text.contains('\0') {return Err("Memory must be UTF-8 text of at most 1 MB".into());}
            if !input["contextToken"].is_null() && input["contextToken"]!=db::get(&db,&crate::sources::meta_key(&p, "contextToken")?)? {return Err("Context changed; read the current authorized context before saving this candidate".into());}
            let id=Uuid::new_v4().to_string();
            let topic=input["topic"].as_str().filter(|t|!t.trim().is_empty()&&t.len()<=160).ok_or("Enter a topic")?;
            let scope=input["scope"].as_str().unwrap_or("");
            if !scope.is_empty() {packages::safe_relative(scope)?;}
            let mut r=json!({"resourceId":id,"kind":"memory","source":"shared","logicalPath":format!("knowledge/{id}.md"),"title":topic,"memory":{"topic":topic,"scope":scope,"provider":input["provider"].as_str().unwrap_or("manual"),"supersedes":input["supersedes"].as_array().cloned().unwrap_or_default()},"files":[{"path":"content.md","hash":db::blob(text.as_bytes())?,"size":text.len(),"executable":false}],"deleted":false});
            if let Some(session)=input["sessionId"].as_str(){r["contextSources"]=crate::native::session_sources(&db,project_id,session)?;}
            let candidate_key=json!({"project":project_id,"sourceId":p["sourceId"],"files":r["files"],"memory":r["memory"],"sessionSources":r["contextSources"],"exposedSources":db::get(&db,&crate::sources::meta_key(&p, "exposedSources")?)?});
            let stable=Uuid::new_v5(&Uuid::NAMESPACE_URL,candidate_key.to_string().as_bytes()).to_string();
            r["resourceId"]=json!(stable);r["logicalPath"]=json!(format!("knowledge/{stable}.md"));
            return Ok(json!({"id":capture(&db,&p,&r,&json!([]))?,"status":"local"}));
        }
        "refresh-draft"=>{
            let id=input["id"].as_str().ok_or("Choose a draft")?;
            let mut draft=db::rows(&db,"SELECT value FROM drafts WHERE id=? AND project=?",&[&id,&project_id])?.into_iter().next().ok_or("Draft unavailable")?;
            if draft["status"]=="proposed" {return Err("This suggestion is still pending; review its decision before retrying".into());}
            draft["requestId"]=Value::Null;draft["submission"]=Value::Null;draft["request"]=Value::Null;draft["status"]=json!("local");
            db::upsert(&db,"drafts",id,project_id,&draft)?;return Ok(draft);
        }
        "draft"|"submit-draft"=>{
            let id=input["id"].as_str().ok_or("Choose a draft")?;
            let mut draft=db::rows(&db,"SELECT value FROM drafts WHERE id=? AND project=?",&[&id,&project_id])?.into_iter().next().ok_or("Draft unavailable")?;
            if action=="draft" {
                let related=related_knowledge(&db,project_id,&draft)?;
                let (files,manifest)=preview_files(&draft["resource"]["files"])?;
                let can_publish = matches!(draft["resource"]["kind"].as_str(), Some("memory" | "skill")) && crate::context_sharing::publication_mode(&db,project_id,&draft["resource"])? == "publish";
                return Ok(json!({"draft":draft,"files":files,"manifest":manifest,"related":related,"canPublish":can_publish}));
            }
            if let Some(files) = input.get("reviewedFiles") {
                if !files.is_array() || files != &draft["resource"]["files"]
                    || (!draft["submission"].is_null() && files != &draft["submission"]["resource"]["files"]) {
                    return Err("Local or shared files changed; review the update again".into());
                }
                if draft["resource"]["kind"] == "skill" {
                    let latest = db::rows(&db,"SELECT value FROM drafts WHERE project=? AND json_extract(value,'$.resource.resourceId')=? ORDER BY coalesce(json_extract(value,'$.updatedAt'),json_extract(value,'$.createdAt')) DESC, rowid DESC LIMIT 1", &[&project_id, &draft["resource"]["resourceId"].as_str().ok_or("Missing resource")?])?;
                    if latest.first().is_none_or(|current| current["id"] != draft["id"]) {
                        return Err("Local or shared files changed; review the update again".into());
                    }
                }
            }
            if let Some(revision) = input.get("reviewedRevision") {
                let resource_id = draft["resource"]["resourceId"].as_str().ok_or("Missing resource")?;
                let current = db::rows(&db, "SELECT value FROM resources WHERE id=? AND project=?", &[&resource_id, &project_id])?
                    .first().and_then(|resource| resource["revision"].as_u64()).unwrap_or(0);
                if revision.as_u64() != Some(current)
                    || (!draft["submission"].is_null() && revision != &draft["submission"]["baseRevision"]) {
                    return Err("Local or shared files changed; review the update again".into());
                }
            }
            if matches!(draft["resource"]["kind"].as_str(), Some("memory" | "skill")) && (input["publishIfAllowed"] == true || crate::context_sharing::publication_mode(&db, project_id, &draft["resource"])? == "publish") {
                return crate::context_sharing::queue(&db, &p, id);
            }
            projects::require_sharing(&db,project_id,draft["resource"]["kind"].as_str().ok_or("Missing kind")?)?;
            let mut r=draft["resource"].clone();
            let managed=draft["paths"][0].as_str().is_some_and(|path|Path::new(path).starts_with(Path::new(p["path"].as_str().unwrap_or("")).join(".orka/memory/resources")));
            if r["kind"]=="memory" && r["source"]!="shared" && !managed {
                r=crate::context_sharing::publication_resource(&db,project_id,&r)?;
            }
            // Drafts store source metadata locally; only protocol fields cross the service boundary.
            let mut clean=json!({});
            for key in ["resourceId","sourceId","kind","source","logicalPath","title","files","deleted","memory","contextSources"] {if !r[key].is_null(){clean[key]=r[key].clone();}}
            let base=db::rows(&db,"SELECT value FROM resources WHERE id=? AND project=?",&[&clean["resourceId"].as_str().ok_or("Missing resource")?,&project_id])?.first().map(|v|v["revision"].clone()).unwrap_or(json!(0));
            if draft["requestId"].is_null() {draft["requestId"]=json!(Uuid::new_v4().to_string());db::upsert(&db,"drafts",id,project_id,&draft)?;}
            if draft["submission"].is_null() {draft["submission"]=json!({"version":2,"id":draft["requestId"],"projectId":project_id,"deviceId":db::device(&db)?,"baseRevision":base,"resource":clean});db::upsert(&db,"drafts",id,project_id,&draft)?;}
            let request=draft["submission"].clone();
            let owner=db::get(&db,"user")?;
            sync::upload(owner.as_str().ok_or("Sign in required")?,project_id,clean["files"].as_array().ok_or("Missing files")?).await?;
            let accepted=remote("submit",&json!({"projectId":project_id,"change":request})).await?;
            draft["status"]=json!("proposed");draft["request"]=accepted.clone();db::upsert(&db,"drafts",id,project_id,&draft)?;
            return Ok(accepted);
        }
        "preview-install"=>{
            let id=input["resourceId"].as_str().ok_or("Choose a resource")?;
            if resource(&db,id)?["projectId"]!=project_id {return Err("Resource belongs to another project".into());}
            return install_preview(&db,id);
        },
        "apply-install"=>{
            let id=input["resourceId"].as_str().ok_or("Choose a resource")?;
            if resource(&db,id)?["projectId"]!=project_id {return Err("Resource belongs to another project".into());}
            let reviewed=install_preview(&db,id)?;
            if input["token"]!=reviewed["token"] {return Err("Local or shared files changed; review the update again".into());}
            let r=resource(&db,id)?;let mut b=installation_binding(&db,&r,&p)?;
            if reviewed["dirty"]==true {
                if input["preserveLocal"]!=true {return Err("Preserve your local edits before installing".into());}
                for raw in b["paths"].as_array().cloned().unwrap_or_default() {
                    let path=Path::new(raw.as_str().ok_or("Invalid local path")?);
                    if !path.exists(){continue;}
                    let mut saved=r.clone();saved["files"]=if r["kind"]=="skill"{json!(packages::directory(path)?)}else{json!([packages::file(path,"content.md")?])};
                    if indexer::manifest_hash(&saved["files"])!=indexer::manifest_hash(&b["base"]["files"]) && indexer::manifest_hash(&saved["files"])!=indexer::manifest_hash(&r["files"]) {saved["deleted"]=json!(false);capture(&db,&p,&saved,&json!([path]))?;}
                }
            }
            b["reviewedRevision"]=r["revision"].clone();
            b["guards"]=reviewed["guards"].clone();
            db::upsert(&db,"bindings",id,project_id,&b)?;
            sync::materialize(&db,&p,&r)?;
            indexer::memory_index(&db,&p)?;
            return Ok(json!({"status":"current"}));
        }
        "context"=>{
            let root=PathBuf::from(p["path"].as_str().ok_or("Connect a folder")?);
            let cwd=input["cwd"].as_str().map(PathBuf::from).unwrap_or(root.clone());
            if !cwd.starts_with(&root) {return Err("Context scope must be inside the project".into());}
            let text=if let Some(query)=input["query"].as_str(){context_with_query(&db,&p,&cwd,Some(query),None)?.0}else{context(&db,&p,&cwd)?.0};
            return Ok(json!({"status":"local","projectId":project_id,"executable":crate::updates::executable().map_err(|e|e.to_string())?,"profile":crate::profiles::current(),"content":text,"contextToken":db::get(&db,&crate::sources::meta_key(&p, "contextToken")?)?,"access":db::get(&db,&format!("governance:{project_id}"))?["access"]}));
        }
        _=>{}
    }
    let result = remote(&action, &input).await?;
    let current = db::open()?;
    if db::get(&current, "user")? != account || db::get(&current, "config")?["apiUrl"] != service {
        return Err("Account or service changed. Reopen Settings.".into());
    }
    if action == "request" {
        let r = &result["content"]["resource"];
        if r["files"].is_array() {
            if result["base"]["files"].is_array() {
                sync::download(
                    db::get(&db, "user")?.as_str().ok_or("Sign in required")?,
                    &result["base"],
                )
                .await?;
            }
            sync::download(
                db::get(&db, "user")?.as_str().ok_or("Sign in required")?,
                &json!({"projectId":project_id,"files":r["files"]}),
            )
            .await?;
            return Ok(
                json!({"request":result["request"],"content":result["content"],"audience":result["audience"],"files":texts(&r["files"])?,"before":if result["base"]["files"].is_array(){texts(&result["base"]["files"])?}else{json!({})}}),
            );
        }
    }
    if action == "catalog" {
        db::set(&db, &format!("governance:{project_id}"), &result)?;
    }
    if !matches!(
        action.as_str(),
        "catalog"
            | "resource"
            | "requests"
            | "request"
            | "logs"
            | "role-policy"
            | "policy-operation"
            | "migration-preview"
    ) {
        db::set(&db, "syncRequest", &json!(Uuid::new_v4().to_string()))?;
    }
    Ok(result)
}
