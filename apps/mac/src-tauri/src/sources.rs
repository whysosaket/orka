use crate::{
    db::{self, Result},
    indexer, native, projects, sync,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub fn views(project: &Value) -> Vec<Value> {
    if project["sourceId"].is_string() || !project["sources"].is_array() {
        return vec![project.clone()];
    }
    project["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|source| {
            let mut view = project.clone();
            view["sourceId"] = source["id"].clone();
            view["path"] = source["path"].clone();
            view["folderIdentity"] = source["folderIdentity"].clone();
            view
        })
        .collect()
}

pub fn for_resource(project: &Value, resource: &Value) -> Option<Value> {
    views(project)
        .into_iter()
        .find(|view| view["path"].is_string() && view["sourceId"] == resource["sourceId"])
}

pub fn select(project: &Value, source_id: Option<&str>) -> Result<Value> {
    let candidates: Vec<_> = views(project)
        .into_iter()
        .filter(|view| {
            view["path"].is_string() && source_id.is_none_or(|id| view["sourceId"] == id)
        })
        .collect();
    match candidates.as_slice() {
        [source] => Ok(source.clone()),
        [] => Err("Connect this repository's folder on this Mac".into()),
        _ => Err("Choose a repository for this action".into()),
    }
}

pub fn registered(project: &Value, source_id: Option<&str>) -> Result<Value> {
    let candidates: Vec<_> = views(project)
        .into_iter()
        .filter(|view| source_id.is_none_or(|id| view["sourceId"] == id))
        .collect();
    match candidates.as_slice() {
        [source] => Ok(source.clone()),
        [] => Err("Add a source folder to this project first".into()),
        _ => Err("Choose a repository for this action".into()),
    }
}

pub fn matches(project: &Value, resource: &Value) -> bool {
    project["sourceId"] == resource["sourceId"]
}

pub fn meta_key(project: &Value, name: &str) -> Result<String> {
    let id = project["id"].as_str().ok_or("Missing project")?;
    Ok(match project["sourceId"].as_str() {
        Some(source) => format!("{name}:{id}:{source}"),
        None => format!("{name}:{id}"),
    })
}

pub fn scope(project: &Value, resource: &mut Value) {
    if project["sourceId"].is_string() {
        resource["sourceId"] = project["sourceId"].clone();
    }
}

pub fn validate(project: &Value) -> Result<()> {
    let raw = project["path"]
        .as_str()
        .ok_or("Connect this repository's folder")?;
    let root = Path::new(raw);
    if !root.is_dir()
        || project["folderIdentity"].as_str().is_some_and(|identity| {
            !indexer::folder_identity_matches(root, identity).unwrap_or(false)
        })
    {
        return Err(
            "Connected source folder changed or is unavailable; local writes and deletions paused. Reconnect it in Settings → Source folders."
                .into(),
        );
    }
    Ok(())
}

pub fn upgrade_identity(source: &mut Value) {
    let (Some(path), Some(expected)) = (source["path"].as_str(), source["folderIdentity"].as_str())
    else {
        return;
    };
    let root = Path::new(path);
    if !expected.starts_with("volume:")
        && indexer::folder_identity_matches(root, expected) == Ok(true)
    {
        if let Ok(identity) = indexer::folder_identity(root) {
            source["folderIdentity"] = json!(identity);
        }
    }
}

pub fn resource_id(project: &Value, kind: &str, path: &str) -> Result<String> {
    let id = project["id"].as_str().ok_or("Missing project")?;
    let namespace = project["sourceId"]
        .as_str()
        .filter(|source| *source != id)
        .map(|source| format!("{id}:{source}"))
        .unwrap_or(id.into());
    Ok(indexer::resource_id(&namespace, kind, path))
}

fn canonical(raw: &str) -> Result<PathBuf> {
    let root = PathBuf::from(raw)
        .canonicalize()
        .map_err(|e| format!("Cannot open folder: {e}"))?;
    if !root.is_dir() {
        return Err("Choose a folder".into());
    }
    Ok(root)
}

#[tauri::command]
pub fn scan_project_folders(path: String) -> Result<Vec<Value>> {
    let parent = canonical(&path)?;
    let mut folders = Vec::new();
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let root = entry.path();
        // .git can be a directory or a file (worktrees and submodules).
        if !root.join(".git").exists() {
            continue;
        }
        folders.push(json!({"name":entry.file_name().to_string_lossy(),"path":root}));
        if folders.len() > 100 {
            return Err("More than 100 repositories found; select a smaller parent folder".into());
        }
    }
    folders.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(folders)
}

#[tauri::command]
pub async fn connect_project_sources(
    id: String,
    paths: Vec<String>,
    source_id: Option<String>,
) -> Result<()> {
    if paths.is_empty() || paths.len() > 100 || (source_id.is_some() && paths.len() != 1) {
        return Err("Choose between 1 and 100 source folders".into());
    }
    let _lock = projects::lock()?;
    let db = db::open()?;
    let mut project = crate::governance::project(&db, &id)?;
    let pending_key = format!("source-registration:{id}");
    let pending = db::get(&db, &pending_key)?;
    let mut sources = project["sources"]
        .as_array()
        .cloned()
        .ok_or("Refresh this project or run the project-source migration")?;
    let roots = paths
        .iter()
        .map(|path| canonical(path))
        .collect::<Result<Vec<_>>>()?;
    let mut used = BTreeSet::new();
    for root in &roots {
        if !used.insert(root.clone()) {
            return Err("The same folder was selected more than once".into());
        }
        for other in db::rows(&db, "SELECT value FROM projects", &[])? {
            for view in views(&other) {
                if let Some(path) = view["path"].as_str() {
                    if other["id"] == id && Path::new(path) == root {
                        if source_id.as_ref().is_some_and(|id| view["sourceId"] != *id) {
                            return Err("This folder is already connected to another source".into());
                        }
                        continue;
                    }
                    if root.starts_with(path) || Path::new(path).starts_with(root) {
                        return Err("A connected source folder already covers this location".into());
                    }
                }
            }
        }
        if roots
            .iter()
            .any(|other| other != root && (root.starts_with(other) || other.starts_with(root)))
        {
            return Err("Choose independent folders; selected folders overlap".into());
        }
    }
    let mut additions = Vec::new();
    for root in roots {
        let name = root
            .file_name()
            .ok_or("Choose a named folder")?
            .to_string_lossy()
            .to_string();
        let exact = sources.iter().position(|source| {
            source["path"]
                .as_str()
                .is_some_and(|path| Path::new(path) == root)
        });
        let candidates: Vec<_> = if let (None, Some(exact)) = (source_id.as_ref(), exact) {
            vec![exact]
        } else {
            sources
                .iter()
                .enumerate()
                .filter(|(_, source)| {
                    source_id.as_ref().map_or(
                        source["name"] == name
                            && source["path"]
                                .as_str()
                                .is_none_or(|path| Path::new(path) == root),
                        |id| source["id"] == *id,
                    )
                })
                .map(|(index, _)| index)
                .collect()
        };
        let index = match candidates.as_slice() {
            [index] => *index,
            [] if source_id.is_some() => return Err("Repository no longer belongs to this project; refresh and try again".into()),
            [] => {
                let source_id = pending.as_array().and_then(|items|items.iter().find(|item|item["path"]==json!(root))).and_then(|item|item["id"].as_str()).map(str::to_owned).unwrap_or_else(||Uuid::new_v4().to_string());
                let source = json!({"id":source_id,"name":name});
                additions.push(source.clone()); sources.push(source); sources.len()-1
            },
            _ => return Err("Several repositories have this name. Use Locate folder beside the intended repository".into()),
        };
        if sources[index]["path"]
            .as_str()
            .is_some_and(|old| Path::new(old) != root)
        {
            return Err("Disconnect this repository before changing its folder".into());
        }
        sources[index]["path"] = json!(root);
        sources[index]["folderIdentity"] = json!(indexer::folder_identity(&root)?);
    }
    if !additions.is_empty() {
        db::set(
            &db,
            &pending_key,
            &json!(sources
                .iter()
                .filter(|source| additions
                    .iter()
                    .any(|addition| addition["id"] == source["id"]))
                .collect::<Vec<_>>()),
        )?;
        sync::api(
            "POST",
            "/v2/projects/sources",
            Some(&json!({"projectId":id,"sources":additions})),
        )
        .await?;
    }
    for source in &sources {
        if let Some(path) = source["path"]
            .as_str()
            .filter(|path| used.contains(Path::new(path)))
        {
            let mut view = project.clone();
            view["path"] = source["path"].clone();
            view["folderIdentity"] = source["folderIdentity"].clone();
            validate(&view)?;
            native::install_hooks(Path::new(path))?;
        }
    }
    project["sources"] = json!(sources);
    project
        .as_object_mut()
        .ok_or("Invalid project")?
        .remove("path");
    project
        .as_object_mut()
        .ok_or("Invalid project")?
        .remove("folderIdentity");
    db::upsert(&db, "projects", &id, &id, &project)?;
    db::set(&db, &pending_key, &Value::Null)?;
    crate::commands::sync_now()
}

#[tauri::command]
pub fn disconnect_project_source(id: String, source_id: String) -> Result<()> {
    let _lock = projects::lock()?;
    let db = db::open()?;
    let mut project = crate::governance::project(&db, &id)?;
    let source = project["sources"]
        .as_array_mut()
        .and_then(|sources| sources.iter_mut().find(|source| source["id"] == source_id))
        .ok_or("Repository not found")?;
    let pending: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM outbox WHERE project=?)",
            [&id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if pending {
        return Err("Sync queued changes before disconnecting a source folder".into());
    }
    source["path"] = Value::Null;
    source["folderIdentity"] = Value::Null;
    db::upsert(&db, "projects", &id, &id, &project)?;
    db.execute(
        "DELETE FROM bindings WHERE project=? AND json_extract(value,'$.base.sourceId')=?",
        [id, source_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
