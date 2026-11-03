use crate::{
    db::{self, Result},
    indexer,
};
use rusqlite::Connection;
use serde_json::{json, Value};

pub fn info(db: &Connection, id: &str) -> Result<Value> {
    let local = db::get(db, &format!("sessionFork:{id}"))?;
    if !local.is_null() {
        return Ok(local);
    }
    let Ok(resource) = crate::governance::resource(db, id) else {
        return Ok(Value::Null);
    };
    let Some(path) = resource["logicalPath"].as_str() else {
        return Ok(Value::Null);
    };
    let parts: Vec<_> = path.split('/').collect();
    if resource["kind"] != "session"
        || parts.len() != 5
        || parts[0] != resource["source"].as_str().unwrap_or("")
        || parts[1] != "forks"
        || uuid::Uuid::parse_str(parts[2]).is_err()
        || uuid::Uuid::parse_str(parts[4]).is_err()
        || !["desktop", "terminal", "warp", "iterm2"].contains(&parts[3])
    {
        return Ok(Value::Null);
    }
    let binding = indexer::binding(db, id)?;
    Ok(
        json!({"parentId":parts[2],"nativeId":binding["nativeId"],"projectId":resource["projectId"],"destination":parts[3],"createdAt":resource["updatedAt"]}),
    )
}

pub fn annotate(db: &Connection, resources: &mut [Value]) -> Result<()> {
    recover_legacy(db, resources)?;
    for resource in resources.iter_mut().filter(|r| r["kind"] == "session") {
        let fork = info(
            db,
            resource["resourceId"].as_str().ok_or("Missing session")?,
        )?;
        if !fork.is_null() {
            resource["fork"] = fork;
        } else if let Some(child) = resumable(db, resource)? {
            resource["localForkId"] = child["resourceId"].clone();
        }
    }
    Ok(())
}

/// Earlier launchers kept import receipts but no parent link. Recover only an
/// exact, unique snapshot match; repeated titles are never evidence of lineage.
fn recover_legacy(db: &Connection, resources: &[Value]) -> Result<()> {
    let receipts = db::rows(db, "SELECT json_object('key',key,'receipt',json(value)) FROM meta WHERE key LIKE 'codexImport:%' OR key LIKE 'claudeImport:%'", &[])?;
    if receipts.is_empty() {
        return Ok(());
    }
    let bindings = db::rows(db, "SELECT value FROM bindings", &[])?;
    let user = db::get(db, "user")?;
    for entry in receipts {
        let parts: Vec<_> = entry["key"].as_str().unwrap_or("").split(':').collect();
        if parts.len() != 5
            || resources.iter().any(|r| r["resourceId"] == parts[2])
            || bindings.iter().any(|b| b["base"]["resourceId"] == parts[2])
        {
            continue;
        }
        let tool = if parts[0] == "codexImport" {
            "codex"
        } else {
            "claude"
        };
        let native_id = if tool == "codex" {
            &entry["receipt"]["child"]["id"]
        } else {
            &entry["receipt"]["id"]
        };
        if !native_id.is_string() {
            continue;
        }
        let Some(binding) = bindings.iter().find(|b| {
            b["nativeId"] == *native_id
                && b["base"]["projectId"] == parts[1]
                && b["base"]["source"] == tool
        }) else {
            continue;
        };
        let Some(child) = resources.iter().find(|r| {
            r["resourceId"] == binding["base"]["resourceId"]
                && r["owner"] == user
                && r["deleted"] != true
        }) else {
            continue;
        };
        let id = child["resourceId"].as_str().ok_or("Missing fork")?;
        if !info(db, id)?.is_null() {
            continue;
        }
        let parents: Vec<_> = resources
            .iter()
            .filter(|r| {
                r["resourceId"] != id
                    && r["kind"] == "session"
                    && r["projectId"] == parts[1]
                    && r["source"] == tool
                    && r["sourceId"] == child["sourceId"]
                    && r["deleted"] != true
                    && r["revision"].as_u64().map(|rev| rev.to_string()).as_deref()
                        == Some(parts[3])
                    && db::digest(r["files"].to_string().as_bytes()) == parts[4]
            })
            .collect();
        if parents.len() != 1 {
            continue;
        }
        let parent = parents[0];
        let desktop = crate::history::resource_records(parent).map_or(true, |records| {
            crate::session_launcher::original_desktop(
                crate::session_launcher::Tool::parse(tool).expect("known provider"),
                &records,
            )
        });
        db::set(
            db,
            &format!("sessionFork:{id}"),
            &json!({"parentId":parent["resourceId"],"projectId":parent["projectId"],"nativeId":native_id,"destination":if desktop { "desktop" } else { "terminal" },"createdAt":child["updatedAt"]}),
        )?;
    }
    Ok(())
}

/// Keep the native copy browsable before sync runs, using the same provisional
/// resource and binding identity that the indexer will later publish.
pub fn record(
    db: &Connection,
    source: &Value,
    binding: &Value,
    destination: &str,
) -> Result<Value> {
    let native_id = binding["nativeId"]
        .as_str()
        .ok_or("Missing native fork ID")?;
    let project = source["projectId"].as_str().ok_or("Missing project")?;
    let mut resource = binding["base"].clone();
    let id = resource["resourceId"]
        .as_str()
        .ok_or("Missing fork identity")?
        .to_owned();
    if resource["resourceId"] == source["resourceId"] {
        return Err("A fork must have its own resource identity".into());
    }
    for key in ["access", "fork"] {
        resource.as_object_mut().ok_or("Invalid fork")?.remove(key);
    }
    resource["logicalPath"] = json!(format!(
        "{}/forks/{}/{destination}/{native_id}",
        source["source"].as_str().ok_or("Missing tool")?,
        source["resourceId"].as_str().ok_or("Missing parent")?
    ));
    resource["revision"] = json!(0);
    resource["owner"] = db::get(db, "user")?;
    resource["updatedBy"] = resource["owner"].clone();
    resource["updatedAt"] = json!(db::now());
    resource["hash"] = json!(indexer::manifest_hash(&resource["files"]));
    let mut saved_binding = binding.clone();
    saved_binding["base"] = resource.clone();
    // The first scan still needs to publish the native copy at base revision 0.
    saved_binding["base"]["files"] = json!([]);
    let fork = json!({"parentId":source["resourceId"],"nativeId":native_id,"projectId":project,"destination":destination,"createdAt":resource["updatedAt"]});
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    db::upsert(&tx, "resources", &id, project, &resource)?;
    db::upsert(&tx, "bindings", &id, project, &saved_binding)?;
    db::set(&tx, &format!("sessionFork:{id}"), &fork)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(resource)
}

pub fn resumable(db: &Connection, resource: &Value) -> Result<Option<Value>> {
    let id = resource["resourceId"].as_str().ok_or("Missing session")?;
    let fork = info(db, id)?;
    if !fork.is_null()
        && resource["owner"] == db::get(db, "user")?
        && (!db::get(db, &format!("sessionFork:{id}"))?.is_null() || binding(db, resource).is_ok())
    {
        // Never silently replace a fork whose local native session disappeared.
        return Ok(Some(resource.clone()));
    }
    let children = db::rows(db,
        "SELECT resources.value FROM resources LEFT JOIN meta ON meta.key='sessionFork:'||resources.id WHERE resources.project=? AND (json_extract(meta.value,'$.parentId')=? OR json_extract(resources.value,'$.logicalPath') LIKE ?) AND json_extract(resources.value,'$.owner')=? AND json_extract(resources.value,'$.source')=? AND coalesce(json_extract(resources.value,'$.sourceId'),'')=? AND json_extract(resources.value,'$.deleted')=0 ORDER BY coalesce(json_extract(meta.value,'$.createdAt'),json_extract(resources.value,'$.updatedAt')) DESC, resources.id DESC LIMIT 1",
        &[&resource["projectId"].as_str().ok_or("Missing project")?, &id, &format!("{}/forks/{id}/%", resource["source"].as_str().ok_or("Missing tool")?), &db::get(db,"user")?.as_str().ok_or("Sign in first")?, &resource["source"].as_str().ok_or("Missing tool")?, &resource["sourceId"].as_str().unwrap_or("")])?;
    Ok(children.into_iter().next())
}

fn has_native_file(binding: &Value) -> bool {
    binding["paths"].as_array().is_some_and(|paths| {
        paths.iter().any(|path| {
            path.as_str()
                .is_some_and(|p| std::path::Path::new(p).is_file())
        })
    })
}

pub fn binding(db: &Connection, resource: &Value) -> Result<Value> {
    let id = resource["resourceId"].as_str().ok_or("Missing session")?;
    let mut binding = indexer::binding(db, id)?;
    let native_id = binding["nativeId"].as_str().ok_or(
        "This fork has no native session on this Mac. Choose Fork and open to create another copy.",
    )?.to_owned();
    uuid::Uuid::parse_str(&native_id).map_err(|_| "Invalid native fork ID")?;
    if info(db, id)?["nativeId"] != native_id {
        return Err("The fork's native identity changed. Open the session again.".into());
    }
    if resource["source"] == "codex" && !has_native_file(&binding) {
        let fallback = crate::native::codex_home()?
            .join("sessions")
            .join(format!("{native_id}.jsonl"));
        let path = crate::history::current_path(&fallback, &native_id)?;
        if path.is_file() {
            binding["paths"] = json!([path]);
        }
    }
    let paths = binding["paths"]
        .as_array()
        .ok_or("Native fork files unavailable. Choose Fork and open to create another copy.")?;
    if !has_native_file(&binding) {
        return Err(
            "Native fork files unavailable. Choose Fork and open to create another copy.".into(),
        );
    }
    let home = if resource["source"] == "codex" {
        crate::native::codex_home()?
    } else {
        crate::native::claude_home()?
    };
    let home = home.canonicalize().map_err(|_| {
        "This fork uses a different native home. Choose Fork and open to create another copy."
    })?;
    if !paths
        .iter()
        .filter_map(Value::as_str)
        .any(|path| std::fs::canonicalize(path).is_ok_and(|path| path.starts_with(&home)))
    {
        return Err(
            "This fork uses a different native home. Choose Fork and open to create another copy."
                .into(),
        );
    }
    Ok(binding)
}

pub fn current_resource(db: &Connection, resource: &Value) -> Result<Value> {
    if info(
        db,
        resource["resourceId"].as_str().ok_or("Missing session")?,
    )?
    .is_null()
    {
        return Ok(resource.clone());
    }
    let mut binding = indexer::binding(
        db,
        resource["resourceId"].as_str().ok_or("Missing session")?,
    )?;
    if resource["source"] == "codex" && !has_native_file(&binding) {
        if let Ok(resolved) = self::binding(db, resource) {
            binding = resolved;
        }
    }
    let path = binding["paths"]
        .as_array()
        .and_then(|paths| paths.last())
        .and_then(Value::as_str);
    let Some(path) = path.filter(|path| std::path::Path::new(path).is_file()) else {
        // Explicit recovery forks can still use cached history.
        return Ok(resource.clone());
    };
    let project =
        crate::governance::project(db, resource["projectId"].as_str().ok_or("Missing project")?)?;
    let source = crate::sources::for_resource(&project, resource);
    let root = source
        .as_ref()
        .and_then(|s| s["path"].as_str())
        .map(std::path::Path::new);
    let mut current = resource.clone();
    current["files"] = json!(crate::history::session_files(
        resource["source"].as_str().ok_or("Missing tool")?,
        std::path::Path::new(path),
        root
    )?);
    Ok(current)
}

pub fn handoff(
    db: &Connection,
    resource: &Value,
    tool: &str,
    destination: &str,
    path: &std::path::Path,
) -> Result<()> {
    db::set(
        db,
        &format!(
            "sessionForkHandoff:{}",
            db::digest(path.to_string_lossy().as_bytes())
        ),
        &json!({"projectId":resource["projectId"],"sourceId":resource["sourceId"],"parentId":resource["resourceId"],"tool":tool,"destination":destination,"path":path}),
    )
}

pub fn handoff_origin(
    db: &Connection,
    project: &Value,
    tool: &str,
    records: &[Value],
) -> Result<Option<Value>> {
    fn mentions(value: &Value, path: &str) -> bool {
        match value {
            Value::String(text) => text.contains(path),
            Value::Array(values) => values.iter().any(|v| mentions(v, path)),
            Value::Object(values) => values.values().any(|v| mentions(v, path)),
            _ => false,
        }
    }
    for handoff in db::rows(
        db,
        "SELECT value FROM meta WHERE key LIKE 'sessionForkHandoff:%'",
        &[],
    )? {
        if handoff["projectId"] == project["id"]
            && handoff["sourceId"].as_str() == project["sourceId"].as_str()
            && handoff["tool"] == tool
            && handoff["path"]
                .as_str()
                .is_some_and(|path| records.iter().any(|record| mentions(record, path)))
        {
            return Ok(Some(handoff));
        }
    }
    Ok(None)
}
