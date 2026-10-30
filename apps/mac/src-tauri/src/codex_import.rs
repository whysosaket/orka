use crate::{
    db::{self, Result},
    history::{self, History},
    native::{self, Rpc},
    packages,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;
use walkdir::WalkDir;

fn attempts(db: &Connection) -> Result<Vec<Value>> {
    db::rows(
        db,
        "SELECT value FROM meta WHERE key LIKE 'codexImport:%'",
        &[],
    )
}

pub fn is_pending_or_dependency(db: &Connection, id: &str, records: &[Value]) -> Result<bool> {
    let bound: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM bindings WHERE json_extract(value,'$.nativeId')=?)",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if bound {
        return Ok(false);
    }
    let parent = &records[0]["payload"]["forked_from_id"];
    Ok(attempts(db)?.iter().any(|attempt| {
        attempt["ids"].as_array().is_some_and(|ids| {
            (ids.iter().any(|v| v == id)
                && (attempt["strategy"] == "legacy" || attempt["completed"] != true))
                || (attempt["completed"] != true
                    && (attempt["child"]["id"] == id
                        || (attempt["strategy"] == "legacy" && ids.last() == Some(parent))))
        })
    }))
}

pub fn finish(db: &Connection, native_id: &str) -> Result<()> {
    for entry in db::rows(db, "SELECT json_object('key',key,'attempt',json(value)) FROM meta WHERE key LIKE 'codexImport:%'", &[])? {
        if entry["attempt"]["child"]["id"] == native_id {
            let mut attempt = entry["attempt"].clone();
            attempt["completed"] = json!(true);
            db::set(db, entry["key"].as_str().ok_or("Missing import key")?, &attempt)?;
        }
    }
    Ok(())
}

fn recover_child(home: &Path, source: &str) -> Result<Option<Value>> {
    let mut child = None;
    let directory = home.join("sessions");
    if !directory.exists() {
        return Ok(None);
    }
    for entry in WalkDir::new(directory).follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file() || entry.path().extension().is_none_or(|s| s != "jsonl") {
            continue;
        }
        let mut line = String::new();
        BufReader::new(
            fs::File::open(entry.path())
                .map_err(|e| e.to_string())?
                .take(128 * 1024 * 1024),
        )
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if record["type"] == "session_meta" && record["payload"]["forked_from_id"] == source {
            if child.is_some() {
                return Err(
                    "Multiple native import attempts found; original sessions preserved".into(),
                );
            }
            child = Some(json!({"id":record["payload"]["id"],"path":entry.path()}));
        }
    }
    Ok(child)
}

pub(crate) fn import_key(project: &Value, resource: &Value) -> Result<String> {
    Ok(format!(
        "codexImport:{}:{}:{}:{}",
        project["id"].as_str().ok_or("Missing project")?,
        resource["resourceId"].as_str().ok_or("Missing resource")?,
        resource["revision"],
        db::digest(resource["files"].to_string().as_bytes())
    ))
}

pub fn materialize(
    db: &Connection,
    project: &Value,
    resource: &Value,
    old: &Value,
) -> Result<(String, PathBuf)> {
    let root = Path::new(project["path"].as_str().ok_or("Connect a folder")?);
    let mut history = History::resource(resource)?;
    let source_paginated = history
        .rollouts
        .last()
        .is_some_and(|r| r.records[0]["payload"]["history_mode"] == "paginated");
    let key = import_key(project, resource)?;
    let mut attempt = db::get(db, &key)?;
    let home = native::codex_home()?;
    fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let mut rpc = Rpc::connect()?;
    let receiver_paginated = if source_paginated {
        rpc.supports_pagination()?
    } else {
        false
    };
    if attempt.is_null() {
        let ids = vec![Uuid::new_v4().to_string()];
        attempt = json!({"ids":ids,"strategy":if source_paginated && receiver_paginated {"paginated"} else {"legacy"},"date":chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S").to_string()});
        // Persist identities before touching native history. A restart can find a
        // fork created just before an RPC timeout or process crash.
        db::set(db, &key, &attempt)?;
    }
    if let (Some(id), Some(path)) = (
        attempt["child"]["id"].as_str(),
        attempt["child"]["path"].as_str(),
    ) {
        let resolved = history::current_path(Path::new(path), id)?;
        if resolved != Path::new(path) {
            History::local(&resolved, Some(root))?;
            attempt["child"]["path"] = json!(resolved);
            db::set(db, &key, &attempt)?;
        }
    }
    let ids: Vec<String> =
        serde_json::from_value(attempt["ids"].clone()).map_err(|e| e.to_string())?;
    let paginated = attempt["strategy"] == "paginated";
    if paginated && !receiver_paginated {
        return Err("This import began with paginated Codex support. Restore that capability to retry; staged history is preserved.".into());
    }
    if source_paginated {
        let id = ids.first().ok_or("Missing import identity")?;
        history.rollouts = vec![if paginated {
            history.independent_paginated(id, root)?
        } else {
            history.independent_legacy(id, root)?
        }];
    } else {
        history.remap(&ids, root)?;
    }
    let source = ids.last().ok_or("Empty import history")?;
    if !paginated {
        if attempt["child"].is_null() {
            if let Some(child) = recover_child(&home, source)? {
                attempt["child"] = child;
            }
        }
        if !attempt["child"].is_null() && attempt["guard"].is_null() {
            let id = attempt["child"]["id"]
                .as_str()
                .ok_or("Codex import missing ID")?;
            if native::active(db, id, "codex") {
                return Err("Partially imported session is open; retry after it closes".into());
            }
            let path = Path::new(
                attempt["child"]["path"]
                    .as_str()
                    .ok_or("Missing import path")?,
            );
            History::local(path, Some(root))?;
            // Adopt the recovered fork without rewriting its contents. Persist
            // its guard with the identity so subsequent retries detect edits.
            attempt["guard"] = json!(db::digest(&fs::read(path).map_err(|e| e.to_string())?));
            db::set(db, &key, &attempt)?;
        }
    }
    let retrying_child = !attempt["child"].is_null();
    if attempt["child"].is_null() {
        let date = attempt["date"].as_str().ok_or("Missing import date")?;
        let directory = home
            .join("sessions")
            .join(&date[..4])
            .join(&date[5..7])
            .join(&date[8..10]);
        packages::safe_directory(&home, &directory)?;
        let mut source_path = PathBuf::new();
        for rollout in &history.rollouts {
            let path = directory.join(format!("rollout-{date}-{}.jsonl", rollout.id));
            let bytes = native::encode(&rollout.records);
            if path.exists() {
                if fs::symlink_metadata(&path)
                    .map_err(|e| e.to_string())?
                    .file_type()
                    .is_symlink()
                {
                    return Err("Staged history is a symlink".into());
                }
                if fs::read(&path).map_err(|e| e.to_string())? != bytes {
                    return Err("Staged native history changed; import paused".into());
                }
            } else {
                let mut staged =
                    tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
                staged.write_all(&bytes).map_err(|e| e.to_string())?;
                staged.as_file().sync_all().map_err(|e| e.to_string())?;
                staged.persist_noclobber(&path).map_err(|e| e.to_string())?;
            }
            source_path = path;
        }
        if paginated {
            // Read/register the standalone copy without resuming a saved goal or
            // starting a model turn. Native forks with no own user event are
            // omitted by Codex's thread list, even when inherited items exist.
            rpc.call(
                "thread/read",
                json!({"threadId":source,"includeTurns":false}),
            )?;
            attempt["child"] = json!({"id":source,"path":source_path});
        } else {
            let imported = rpc.call("thread/fork", json!({"threadId":"","path":source_path,"cwd":root,"runtimeWorkspaceRoots":[root],"deferGoalContinuation":true,"excludeTurns":true,"threadSource":"cli"}))?;
            attempt["child"] = imported["thread"].clone();
        }
        attempt["guard"] = json!(db::digest(
            &fs::read(
                attempt["child"]["path"]
                    .as_str()
                    .ok_or("Missing import path")?
            )
            .map_err(|e| e.to_string())?
        ));
        db::set(db, &key, &attempt)?;
    }
    let id = attempt["child"]["id"]
        .as_str()
        .ok_or("Codex import missing ID")?
        .to_owned();
    let path = PathBuf::from(
        attempt["child"]["path"]
            .as_str()
            .ok_or("Codex import missing rollout path")?,
    );
    if retrying_child {
        if native::active(db, &id, "codex") {
            return Err("Partially imported session is open; retry after it closes".into());
        }
        let actual = db::digest(&fs::read(&path).map_err(|e| e.to_string())?);
        if attempt["guard"]
            .as_str()
            .is_none_or(|guard| guard != actual)
        {
            return Err("Partially imported session changed; local history preserved".into());
        }
        if attempt["completed"] == true && path.starts_with(home.join("archived_sessions")) {
            // Reattach a verified completed import in place. An archive is a
            // native user choice, not permission to create another conversation.
            History::local(&path, Some(root))?;
            return Ok((id, path));
        }
    }
    // A legacy fork's staging file must not appear as another conversation.
    for staged in &ids {
        if staged == &id {
            continue;
        }
        let path = history::find_rollout(&home, staged)?;
        if path.starts_with(home.join("sessions")) {
            rpc.call("thread/archive", json!({"threadId":staged}))?;
        }
    }
    if let Some(p) = rpc.call_optional("project/create", json!({"idempotencyKey":format!("orka-{}",project["id"].as_str().ok_or("Missing project")?),"name":project["name"],"roots":[{"path":root}]}))? {
        rpc.call_optional("thread/metadata/update", json!({"threadId":id,"projectId":p["project"]["id"]}))?;
    }
    rpc.call_optional(
        "thread/name/set",
        json!({"threadId":id,"name":resource["title"]}),
    )?;
    History::local(&path, Some(root))?;
    rpc.call("thread/read", json!({"threadId":id,"includeTurns":false}))?;
    if paginated {
        rpc.call("thread/turns/list", json!({"threadId":id,"limit":1}))?;
    } else {
        rpc.call("thread/read", json!({"threadId":id,"includeTurns":true}))?;
    }
    if !paginated {
        rpc.call_optional("thread/unsubscribe", json!({"threadId":id}))?;
    }
    if let Some(old_id) = old["nativeId"].as_str() {
        if old_id != id {
            rpc.call("thread/archive", json!({"threadId":old_id}))?;
        }
    }
    Ok((id, path))
}
