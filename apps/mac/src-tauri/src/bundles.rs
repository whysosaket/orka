use crate::{
    db::{self, Result},
    indexer, native, packages,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::Path,
};
use uuid::Uuid;
pub fn export(db: &rusqlite::Connection, id: &str, path: &Path) -> Result<()> {
    let r = db::rows(db, "SELECT value FROM resources WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .ok_or("Resource not found")?;
    if r["deleted"] == true {
        return Err("Deleted resources cannot be exported".into());
    }
    let project =
        crate::governance::project(db, r["projectId"].as_str().ok_or("Missing project")?)?;
    if r["kind"] == "skill" {
        packages::reject_env_files(r["files"].as_array().ok_or("Missing files")?)?;
    }
    let parent = path.parent().ok_or("Missing output parent")?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    {
        let mut zip = zip::ZipWriter::new(staged.as_file_mut());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);
        let mut manifest = json!({"version":2,"origin":{"projectId":r["projectId"],"resourceId":r["resourceId"],"governed":project["governed"]==true},"resource":{"resourceId":r["resourceId"],"kind":r["kind"],"source":r["source"],"logicalPath":r["logicalPath"],"title":r["title"],"files":r["files"],"contextSources":r["contextSources"].as_array().cloned().unwrap_or_default(),"deleted":false}});
        if r["sourceId"].is_string() {
            manifest["resource"]["sourceId"] = r["sourceId"].clone();
        }
        zip.start_file("manifest.json", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(manifest.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
        let mut seen = BTreeSet::new();
        for f in r["files"].as_array().ok_or("Missing files")? {
            let hash = f["hash"].as_str().ok_or("Missing hash")?;
            if !seen.insert(hash) {
                continue;
            }
            zip.start_file(format!("blobs/{hash}"), options)
                .map_err(|e| e.to_string())?;
            zip.write_all(&db::blob_read(hash)?)
                .map_err(|e| e.to_string())?;
        }
        if r["kind"] == "session" {
            let records = crate::history::resource_records(&r)?;
            zip.start_file("transcript.md", options)
                .map_err(|e| e.to_string())?;
            zip.write_all(native::transcript(&records).as_bytes())
                .map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
    }
    staged.as_file().sync_all().map_err(|e| e.to_string())?;
    staged.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
#[cfg(test)]
pub fn import(db: &rusqlite::Connection, project: &str, path: &Path) -> Result<String> {
    import_into_source(db, project, path, None)
}

pub fn import_into_source(
    db: &rusqlite::Connection,
    project: &str,
    path: &Path,
    source_id: Option<&str>,
) -> Result<String> {
    let mut zip = zip::ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if zip.len() > 202 {
        return Err("Bundle has too many files".into());
    }
    let mut names = BTreeSet::new();
    let mut total = 0;
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = f.name().map_err(|e| e.to_string())?;
        packages::safe_relative(&name)?;
        if f.is_dir()
            || f.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
            || !names.insert(name.into_owned())
        {
            return Err("Bundle contains directories, symlinks, or duplicate paths".into());
        }
        total += f.size();
        if f.size() > 128 * 1024 * 1024 || total > 256 * 1024 * 1024 {
            return Err("Bundle exceeds size limits".into());
        }
    }
    let mut bytes = Vec::new();
    zip.by_name("manifest.json")
        .map_err(|_| "Missing manifest")?
        .take(128_001)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 128_000 {
        return Err("Manifest too large".into());
    }
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if manifest["version"] != 2 {
        return Err("Unsupported bundle version".into());
    }
    let mut r = manifest["resource"].clone();
    if manifest["origin"]["governed"] == true && manifest["origin"]["projectId"] != project {
        return Err("This governed bundle retains its source audience. Import it into the source project and request sharing there; automatic cross-project publication is unavailable.".into());
    }
    let p = crate::governance::project(db, project)?;
    let source_id = source_id.or_else(|| {
        if manifest["origin"]["projectId"] == project {
            r["sourceId"].as_str()
        } else {
            None
        }
    });
    let p = crate::sources::registered(&p, source_id)?;
    let original = if manifest["origin"]["governed"] == true {
        Some(
            crate::governance::resource(
                db,
                manifest["origin"]["resourceId"]
                    .as_str()
                    .ok_or("Missing source resource")?,
            )
            .map_err(|_| "Refresh source resource access before importing this bundle")?,
        )
    } else {
        None
    };
    if original
        .as_ref()
        .is_some_and(|original| original["sourceId"] != p["sourceId"])
    {
        return Err("Import this governed resource into its original repository".into());
    }
    crate::sources::scope(&p, &mut r);
    let kind = r["kind"].as_str().ok_or("Missing kind")?.to_string();
    if !matches!(kind.as_str(), "skill" | "session" | "plan") {
        return Err("Only skill, session, and plan bundles are supported".into());
    }
    if !matches!(r["source"].as_str(), Some("shared" | "claude" | "codex"))
        || r["title"]
            .as_str()
            .is_none_or(|s| s.is_empty() || s.len() > 256)
    {
        return Err("Invalid bundle source or title".into());
    }
    let logical =
        packages::safe_relative(r["logicalPath"].as_str().ok_or("Missing logical path")?)?;
    if kind == "skill"
        && (logical.components().count() != 1
            || logical.to_string_lossy().starts_with('.')
            || logical.to_string_lossy().len() > 128)
    {
        return Err("Invalid skill folder name".into());
    }
    if kind == "session" && r["source"] == "shared" {
        return Err("Session source must be Claude or Codex".into());
    }
    let files = r["files"].as_array().ok_or("Missing files")?;
    if kind == "skill" {
        packages::reject_env_files(files)?;
    }
    if files.len() > 200 || files.is_empty() {
        return Err("Invalid file count".into());
    }
    let mut paths = BTreeSet::new();
    let mut allowed = BTreeSet::from(["manifest.json".to_string(), "transcript.md".to_string()]);
    let mut size = 0;
    for f in files {
        let relative = f["path"].as_str().ok_or("Missing path")?;
        packages::safe_relative(relative)?;
        if !paths.insert(relative) {
            return Err("Duplicate resource path".into());
        }
        let hash = f["hash"].as_str().ok_or("Missing hash")?;
        db::blob_path(hash)?;
        let name = format!("blobs/{hash}");
        allowed.insert(name.clone());
        let mut bytes = Vec::new();
        let limit = f["size"].as_u64().ok_or("Missing size")?;
        if limit > 128 * 1024 * 1024 {
            return Err("File too large".into());
        }
        zip.by_name(&name)
            .map_err(|_| "Missing blob")?
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 != limit
            || db::digest(&bytes) != hash
            || !f["executable"].is_boolean()
        {
            return Err("Invalid blob hash, size, or mode".into());
        }
        size += limit;
        db::blob(&bytes)?;
    }
    if !names.is_subset(&allowed) {
        return Err("Unrecognized bundle file".into());
    }
    if kind == "skill"
        && (!paths.contains("SKILL.md")
            || size > 4_000_000
            || files
                .iter()
                .any(|f| f["size"].as_u64().unwrap_or(0) > 1_000_000))
    {
        return Err("Invalid skill package".into());
    }
    if kind == "session" {
        let records = crate::history::resource_records(&r)?;
        native::session_info(r["source"].as_str().ok_or("Missing tool")?, &records)?;
    }
    if kind == "plan" {
        crate::plans::validate(&r)?;
    }
    let id = if kind == "skill" || kind == "plan" {
        let logical = r["logicalPath"].as_str().ok_or("Missing path")?;
        original
            .as_ref()
            .and_then(|r| r["resourceId"].as_str())
            .map(String::from)
            .map(Ok)
            .unwrap_or_else(|| indexer::scoped_resource_id(db, &p, &kind, logical))?
    } else {
        Uuid::new_v4().to_string()
    };
    r["resourceId"] = json!(id);
    r["deleted"] = json!(false);
    if kind == "session" {
        r["logicalPath"] = json!(format!("imports/{id}"));
    }
    if let Some(original) = original {
        let mut sources = r["contextSources"].as_array().cloned().unwrap_or_default();
        if original["resourceId"] != id && !sources.contains(&original["resourceId"]) {
            sources.push(original["resourceId"].clone());
        }
        r["contextSources"] = json!(sources);
    }
    if p["governed"] == true {
        crate::governance::capture(db, &p, &r, &json!([]))?;
        return Ok(id);
    }
    let b = indexer::binding(db, &id)?;
    let value = json!({"version":2,"id":Uuid::new_v4().to_string(),"projectId":project,"deviceId":db::device(db)?,"baseRevision":b["base"]["revision"].as_u64().unwrap_or(0),"resource":r});
    indexer::queue(db, project, "/v2/sync/push", &value)?;
    db::set(db, "syncRequest", &json!(Uuid::new_v4().to_string()))?;
    Ok(id)
}
