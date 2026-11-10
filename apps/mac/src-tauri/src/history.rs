use crate::{
    db::{self, Result},
    native, session_translation,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
};
use uuid::Uuid;
use walkdir::WalkDir;

pub(crate) const MAX_FILE: u64 = 128 * 1024 * 1024;
pub(crate) const SESSION_SIZE_ERROR: &str = "Session exceeds 128 MB; source preserved";
pub(crate) const UNATTRIBUTED_SESSION_PREFIX: &str = "history:unattributed:";
pub(crate) const UNATTRIBUTED_SESSION_ERROR: &str =
    "Session exceeds 128 MB; Orka could not identify its project. Source preserved.";
const MAX_ATTRIBUTION_PREFIX: u64 = 1024 * 1024;
const MAX_TOTAL: usize = 256 * 1024 * 1024;

fn ordinal_reference(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields
            .iter()
            .any(|(key, value)| key.contains("ordinal") || ordinal_reference(value)),
        Value::Array(values) => values.iter().any(ordinal_reference),
        _ => false,
    }
}

pub struct Rollout {
    pub id: String,
    pub records: Vec<Value>,
}

// Oldest ancestor first, followed by the complete leaf. Ancestors contain only
// the prefix inherited by their child, never later messages from another fork.
pub struct History {
    pub rollouts: Vec<Rollout>,
}

fn metadata(records: &[Value]) -> Result<&Value> {
    records
        .first()
        .filter(|r| r["type"] == "session_meta")
        .map(|r| &r["payload"])
        .ok_or("Missing initial Codex session metadata".into())
}

pub fn is_session(path: &Path) -> bool {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")
}

pub(crate) fn reader(path: &Path) -> Result<Box<dyn Read>> {
    let info = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !info.is_file() || info.file_type().is_symlink() {
        return Err("History must be a regular file".into());
    }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if path.to_string_lossy().ends_with(".jsonl.zst") {
        let mut decoder = zstd::stream::read::Decoder::new(file).map_err(|e| e.to_string())?;
        decoder.window_log_max(27).map_err(|e| e.to_string())?;
        Ok(Box::new(decoder))
    } else {
        Ok(Box::new(file))
    }
}

fn read(path: &Path, prefix: Option<u64>) -> Result<Vec<u8>> {
    if prefix.is_some_and(|size| size > MAX_FILE) {
        return Err("History exceeds its file or size boundary".into());
    }
    let mut bytes = Vec::new();
    // Codex's inherited offsets address decoded JSONL bytes, not compressed bytes.
    reader(path)?
        .take(prefix.unwrap_or(MAX_FILE + 1))
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE {
        return Err(SESSION_SIZE_ERROR.into());
    }
    Ok(bytes)
}

pub fn read_session(path: &Path) -> Result<Vec<u8>> {
    if path.extension().is_some_and(|ext| ext == "jsonl")
        && fs::symlink_metadata(path).is_ok_and(|info| info.is_file() && info.len() > MAX_FILE)
    {
        return Err(SESSION_SIZE_ERROR.into());
    }
    read(path, None)
}

pub(crate) fn session_cwd_prefix(path: &Path, tool: &str) -> Option<PathBuf> {
    let mut prefix = Vec::new();
    reader(path)
        .ok()?
        .take(MAX_ATTRIBUTION_PREFIX)
        .read_to_end(&mut prefix)
        .ok()?;
    native::session_cwd(tool, &native::complete_records(&prefix).ok()?).ok()
}

pub fn first_line(path: &Path) -> Result<String> {
    let mut line = String::new();
    BufReader::new(reader(path)?.take(MAX_FILE + 1))
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    if line.len() as u64 > MAX_FILE {
        return Err(SESSION_SIZE_ERROR.into());
    }
    Ok(line)
}

pub fn find_rollout(home: &Path, id: &str) -> Result<PathBuf> {
    Uuid::parse_str(id).map_err(|_| "Invalid history reference")?;
    let mut found = None;
    for directory in [home.join("sessions"), home.join("archived_sessions")] {
        if !directory.exists() {
            continue;
        }
        if fs::symlink_metadata(&directory)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("Native history directory is a symlink".into());
        }
        for entry in WalkDir::new(directory).follow_links(false) {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().is_file()
                && is_session(entry.path())
                && entry
                    .file_name()
                    .to_string_lossy()
                    .trim_end_matches(".zst")
                    .ends_with(&format!("-{id}.jsonl"))
            {
                if found.is_some() {
                    return Err("Duplicate native history identity".into());
                }
                found = Some(entry.into_path());
            }
        }
    }
    found.ok_or(
        "Inherited Codex history is missing. Sync this session again from the original device."
            .into(),
    )
}

fn segments(home: &Path, id: &str) -> Result<Vec<(u64, PathBuf)>> {
    Uuid::parse_str(id).map_err(|_| "Invalid history identity")?;
    let mut candidates = Vec::new();
    for directory in [home.join("sessions"), home.join("archived_sessions")] {
        if !directory.exists() {
            continue;
        }
        if fs::symlink_metadata(&directory)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("Native history directory is a symlink".into());
        }
        for entry in WalkDir::new(directory).follow_links(false) {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy();
            let name = name.strip_suffix(".zst").unwrap_or(&name);
            if !entry.file_type().is_file()
                || !is_session(entry.path())
                || !(name.ends_with(&format!("{id}.jsonl")) || name.contains(&format!("-{id}_")))
            {
                continue;
            }
            let first = first_line(entry.path())?;
            let record: Value =
                serde_json::from_str(&first).map_err(|_| "Invalid native segment metadata")?;
            if record["type"] == "session_meta" && record["payload"]["id"] == id {
                candidates.push((record["ordinal"].as_u64().unwrap_or(0), entry.into_path()));
            }
        }
    }
    candidates.sort_by_key(|(ordinal, _)| *ordinal);
    Ok(candidates)
}

pub fn current_path(path: &Path, id: &str) -> Result<PathBuf> {
    let candidates = segments(&native::codex_home()?, id)?;
    if candidates.len() > 1
        && candidates[candidates.len() - 2].0 == candidates[candidates.len() - 1].0
    {
        return Err("Ambiguous native history segments; source preserved".into());
    }
    Ok(candidates
        .last()
        .map(|(_, path)| path.clone())
        .unwrap_or_else(|| path.into()))
}

fn parent_prefix(home: &Path, id: &str, end: u64, offset: u64) -> Result<Vec<u8>> {
    let mut found = None;
    for (start, path) in segments(home, id)?.into_iter().rev() {
        if start >= end {
            continue;
        }
        let bytes = read(&path, Some(offset))?;
        if bytes.len() as u64 != offset {
            continue;
        }
        let records = native::complete_records(&bytes)?;
        if bytes.last() == Some(&b'\n')
            && records
                .last()
                .and_then(|r| r["ordinal"].as_u64())
                .and_then(|n| n.checked_add(1))
                == Some(end)
        {
            if found.as_ref().is_some_and(|previous| previous != &bytes) {
                return Err("Ambiguous inherited history; original sources preserved".into());
            }
            found = Some(bytes);
        }
    }
    found.ok_or("Inherited Codex history is missing or has an invalid boundary. Sync this session again from the original device.".into())
}

impl History {
    fn load(
        mut bytes: Vec<u8>,
        mut parent: impl FnMut(&str, u64, u64) -> Result<Vec<u8>>,
        scope: Option<&Path>,
    ) -> Result<Self> {
        let mut rollouts = Vec::new();
        let mut seen = BTreeSet::new();
        let mut expected: Option<(String, u64)> = None;
        let mut total = 0;
        loop {
            total += bytes.len();
            if bytes.len() as u64 > MAX_FILE || total > MAX_TOTAL || rollouts.len() >= 200 {
                return Err("Complete session history exceeds the sync limit".into());
            }
            let records = native::complete_records(&bytes)?;
            if records.iter().any(|r| {
                !r["payload"].is_object()
                    || (r["payload"]["type"] == "thread_settings_applied"
                        && !r["payload"]["thread_settings"].is_object())
            }) {
                return Err("Unsupported Codex record shape; original preserved".into());
            }
            let (id, cwd, _) = native::session_info("codex", &records)?;
            if !seen.insert((id.clone(), records[0]["ordinal"].as_u64().unwrap_or(0))) {
                return Err("Cyclic Codex history reference".into());
            }
            if scope.is_some_and(|root| {
                !cwd.starts_with(root)
                    || cwd
                        .components()
                        .any(|c| matches!(c, std::path::Component::ParentDir))
                    || cwd.canonicalize().is_ok_and(|p| !p.starts_with(root))
            }) {
                return Err(
                    "Inherited history belongs to another folder; session sharing paused".into(),
                );
            }
            let meta = metadata(&records)?;
            let paginated = meta["history_mode"] == "paginated";
            if paginated {
                let first = records[0]["ordinal"]
                    .as_u64()
                    .ok_or("Missing history ordinal")?;
                for (index, record) in records.iter().enumerate() {
                    if record["ordinal"].as_u64() != first.checked_add(index as u64) {
                        return Err("Non-contiguous Codex history ordinals".into());
                    }
                }
                let base = &meta["history_base"];
                if first != base["end_ordinal_exclusive"].as_u64().unwrap_or(0) {
                    return Err("History starts outside its inherited ordinal boundary".into());
                }
            }
            if let Some((expected_id, end)) = expected.take() {
                if id != expected_id
                    || !paginated
                    || bytes.last() != Some(&b'\n')
                    || records
                        .last()
                        .and_then(|r| r["ordinal"].as_u64())
                        .and_then(|n| n.checked_add(1))
                        != Some(end)
                {
                    return Err("Inherited history identity or boundary does not match".into());
                }
            }
            let base = meta["history_base"].clone();
            rollouts.push(Rollout { id, records });
            if base.is_null() {
                break;
            }
            if !paginated {
                return Err("Legacy history cannot reference paginated ancestors".into());
            }
            let parent_id = base["thread_id"]
                .as_str()
                .ok_or("Missing history ancestor")?;
            Uuid::parse_str(parent_id).map_err(|_| "Invalid history ancestor")?;
            let end = base["end_ordinal_exclusive"]
                .as_u64()
                .ok_or("Missing history ordinal boundary")?;
            let offset = base["end_byte_offset"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= MAX_FILE)
                .ok_or("Invalid history byte boundary")?;
            bytes = parent(parent_id, end, offset)?;
            if bytes.len() as u64 != offset || bytes.last() != Some(&b'\n') {
                return Err("History byte boundary must end at a complete record".into());
            }
            expected = Some((parent_id.to_owned(), end));
        }
        rollouts.reverse();
        let mut history = Self { rollouts };
        history.rebase_offsets();
        Ok(history)
    }

    pub fn local(path: &Path, scope: Option<&Path>) -> Result<Self> {
        let home = native::codex_home()?;
        Self::load(
            read(path, None)?,
            |id, end, offset| parent_prefix(&home, id, end, offset),
            scope,
        )
    }

    pub fn resource(resource: &Value) -> Result<Self> {
        let files = resource["files"]
            .as_array()
            .ok_or("Missing history files")?;
        if files.len() > 200 {
            return Err("Too many history files".into());
        }
        let mut names = BTreeSet::new();
        for file in files {
            if !names.insert(file["path"].as_str().ok_or("Missing history path")?) {
                return Err("Duplicate history file".into());
            }
        }
        let load = |path: &str| -> Result<Vec<u8>> {
            let file = files.iter().find(|f| f["path"] == path)
                .ok_or("Inherited Codex history is missing. Sync this session again from the original device.")?;
            let bytes = db::blob_read(file["hash"].as_str().ok_or("Missing history hash")?)?;
            if bytes.len() as u64 != file["size"].as_u64().ok_or("Missing history size")? {
                return Err("History size does not match the manifest".into());
            }
            Ok(bytes)
        };
        let history = Self::load(
            load("session.jsonl")?,
            |id, end, offset| {
                let path = format!("lineage/{id}/{end}.jsonl");
                let bytes = if names.contains(path.as_str()) {
                    load(&path)?
                } else {
                    load(&format!("lineage/{id}.jsonl"))?
                };
                if bytes.len() as u64 != offset {
                    return Err("Ancestor contains history beyond its inherited boundary".into());
                }
                Ok(bytes)
            },
            None,
        )?;
        if history.rollouts.len() != files.len() {
            return Err("Session contains unreferenced history files".into());
        }
        Ok(history)
    }

    fn rebase_offsets(&mut self) {
        for i in 1..self.rollouts.len() {
            let offset = native::encode(&self.rollouts[i - 1].records).len();
            self.rollouts[i].records[0]["payload"]["history_base"]["end_byte_offset"] =
                json!(offset);
        }
    }

    pub fn remap(&mut self, ids: &[String], root: &Path) -> Result<()> {
        if ids.len() != self.rollouts.len() {
            return Err("Import identity count changed".into());
        }
        for i in 0..self.rollouts.len() {
            let meta = &mut self.rollouts[i].records[0]["payload"];
            meta["id"] = json!(ids[i]);
            if meta["session_id"].is_string() {
                meta["session_id"] = json!(ids[i]);
            }
            meta["cwd"] = json!(root);
            if i > 0 {
                meta["history_base"]["thread_id"] = json!(ids[i - 1]);
                meta["forked_from_id"] = json!(ids[i - 1]);
            }
            let original_id = self.rollouts[i].id.clone();
            for record in &mut self.rollouts[i].records {
                session_translation::relocate_codex(record, &[&original_id], &ids[i], root);
            }
            self.rollouts[i].id = ids[i].clone();
        }
        self.rebase_offsets();
        Ok(())
    }

    pub fn files(&self) -> Result<Vec<Value>> {
        let last = self.rollouts.len() - 1;
        let mut files = Vec::new();
        for i in std::iter::once(last).chain(0..last) {
            let rollout = &self.rollouts[i];
            let bytes = native::encode(&rollout.records);
            let path = if i == last {
                "session.jsonl".into()
            } else {
                format!(
                    "lineage/{}/{}.jsonl",
                    rollout.id,
                    rollout
                        .records
                        .last()
                        .and_then(|r| r["ordinal"].as_u64())
                        .and_then(|n| n.checked_add(1))
                        .ok_or("Missing ancestor ordinal")?
                )
            };
            files.push(
                json!({"path":path,"hash":db::blob(&bytes)?,"size":bytes.len(),"executable":false}),
            );
        }
        Ok(files)
    }

    pub fn records(&self) -> Vec<Value> {
        self.rollouts
            .iter()
            .flat_map(|r| r.records.iter().cloned())
            .collect()
    }

    pub fn independent_paginated(&self, id: &str, root: &Path) -> Result<Rollout> {
        if self.rollouts.iter().any(|r| {
            r.records[0]["payload"]["source"].is_object()
                || !r.records[0]["payload"]["subagent_history_start_ordinal"].is_null()
        }) {
            return Err("Subagent history cannot be imported as a standalone conversation".into());
        }
        let mut first = self.rollouts.last().ok_or("Empty history")?.records[0].clone();
        let meta = first["payload"]
            .as_object_mut()
            .ok_or("Missing history metadata")?;
        if meta.get("history_mode") != Some(&json!("paginated")) {
            return Err("Expected paginated history".into());
        }
        // A portable copy gets a new native identity and fresh pagination
        // ordinals; retained items, turn IDs, and conversation text stay intact.
        for key in [
            "history_base",
            "forked_from_id",
            "forked_from_ordinal_exclusive",
        ] {
            meta.remove(key);
        }
        meta.insert("id".into(), json!(id));
        meta.insert("session_id".into(), json!(id));
        meta.insert("cwd".into(), json!(root));
        meta.insert("runtime_workspace_roots".into(), json!([root]));
        meta.insert("source".into(), json!("cli"));
        meta.insert("thread_source".into(), json!("cli"));
        let mut records = vec![first];
        records.extend(
            self.rollouts
                .iter()
                .flat_map(|r| r.records.iter())
                .filter(|r| r["type"] != "session_meta")
                .cloned(),
        );
        let ids = self
            .rollouts
            .iter()
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>();
        for (ordinal, record) in records.iter_mut().enumerate() {
            record["ordinal"] = json!(ordinal);
            if ordinal_reference(&record["metadata"]) || ordinal_reference(&record["payload"]) {
                return Err(
                    "Unsupported ordinal reference in paginated history; original preserved".into(),
                );
            }
            session_translation::relocate_codex(record, &ids, id, root);
        }
        if native::encode(&records).len() as u64 > MAX_FILE {
            return Err(
                "Combined paginated history exceeds the native import limit of 128 MB".into(),
            );
        }
        Ok(Rollout {
            id: id.into(),
            records,
        })
    }

    pub fn independent_legacy(&self, id: &str, root: &Path) -> Result<Rollout> {
        let mut rollout = self.independent_paginated(id, root)?;
        rollout.records[0]["payload"]["history_mode"] = json!("legacy");
        for record in &mut rollout.records {
            record
                .as_object_mut()
                .ok_or("Invalid history record")?
                .remove("ordinal");
        }
        Ok(rollout)
    }
}

pub fn session_files(tool: &str, path: &Path, scope: Option<&Path>) -> Result<Vec<Value>> {
    if tool == "codex" {
        let history = History::local(path, scope)?;
        let id = &history.rollouts.last().ok_or("Empty history")?.id;
        let latest = current_path(path, id)?;
        return if latest == path {
            history.files()
        } else {
            History::local(&latest, scope)?.files()
        };
    }
    let bytes = native::encode(&native::complete_records(&read(path, None)?)?);
    Ok(vec![
        json!({"path":"session.jsonl","hash":db::blob(&bytes)?,"size":bytes.len(),"executable":false}),
    ])
}

pub fn resource_records(resource: &Value) -> Result<Vec<Value>> {
    if resource["source"] == "codex" {
        return Ok(History::resource(resource)?.records());
    }
    let file = resource["files"]
        .as_array()
        .and_then(|files| files.iter().find(|f| f["path"] == "session.jsonl"))
        .ok_or("Missing transcript")?;
    native::complete_records(&db::blob_read(
        file["hash"].as_str().ok_or("Missing hash")?,
    )?)
}
