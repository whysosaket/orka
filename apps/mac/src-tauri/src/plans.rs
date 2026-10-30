use crate::{
    db::{self, Result},
    native, packages,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub const MAX_SIZE: u64 = 1_000_000;

pub fn project_directory(root: &Path, source: &str) -> Result<PathBuf> {
    if source == "codex" {
        return Ok(root.join(".codex/plans"));
    }
    if source != "claude" {
        return Err("Unknown plan source".into());
    }
    let mut directory = root.join(".claude/plans");
    for settings in [
        native::claude_home()?.join("settings.json"),
        root.join(".claude/settings.json"),
        root.join(".claude/settings.local.json"),
    ] {
        if !settings.try_exists().map_err(|e| e.to_string())? {
            continue;
        }
        let value: Value = serde_json::from_slice(&fs::read(settings).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        if let Some(custom) = value["plansDirectory"].as_str() {
            directory = root.join(packages::safe_relative(custom.trim_start_matches("./"))?);
        }
    }
    Ok(directory)
}

pub fn native_directory(source: &str) -> Result<PathBuf> {
    Ok(match source {
        "claude" => native::claude_home()?,
        "codex" => native::codex_home()?,
        _ => return Err("Unknown plan source".into()),
    }
    .join("plans"))
}

pub fn check_path(base: &Path, path: &Path) -> Result<()> {
    let relative = path
        .strip_prefix(base)
        .map_err(|_| "Plan path escapes its directory")?;
    packages::safe_relative(&relative.to_string_lossy())?;
    let mut current = base.to_path_buf();
    for component in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(component) = component {
            current.push(component);
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Symlinked plans are excluded".into())
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

pub fn file(path: &Path) -> Result<(Value, String)> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_SIZE {
        return Err("Plans must be regular UTF-8 Markdown files of at most 1 MB".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_SIZE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "Plan is not UTF-8")?;
    let title = title(
        text,
        path.file_stem().and_then(|s| s.to_str()).unwrap_or("Plan"),
    );
    Ok((content(&bytes)?, title))
}

pub fn content(bytes: &[u8]) -> Result<Value> {
    if bytes.len() as u64 > MAX_SIZE || std::str::from_utf8(bytes).is_err() || bytes.contains(&0) {
        return Err("Plans must be UTF-8 Markdown of at most 1 MB".into());
    }
    Ok(json!({"path":"content.md","hash":db::blob(bytes)?,"size":bytes.len(),"executable":false}))
}

pub fn title(text: &str, fallback: &str) -> String {
    text.lines()
        .find_map(|line| {
            line.trim()
                .strip_prefix("# ")
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or(fallback)
        .chars()
        .take(256)
        .collect()
}

pub fn validate(resource: &Value) -> Result<()> {
    let source = resource["source"].as_str().ok_or("Missing plan source")?;
    let logical = resource["logicalPath"]
        .as_str()
        .ok_or("Missing plan path")?;
    packages::safe_relative(logical)?;
    if !matches!(source, "codex" | "claude")
        || !logical.starts_with(&format!("{source}/"))
        || !logical.to_ascii_lowercase().ends_with(".md")
    {
        return Err("Invalid plan source or path".into());
    }
    let files = resource["files"].as_array().ok_or("Missing plan files")?;
    if resource["deleted"] == true {
        if !files.is_empty() {
            return Err("Invalid plan deletion".into());
        }
        return Ok(());
    }
    if files.len() != 1
        || files[0]["path"] != "content.md"
        || files[0]["executable"] != false
        || files[0]["size"].as_u64().is_none_or(|size| size > MAX_SIZE)
    {
        return Err("Invalid plan manifest".into());
    }
    let bytes = db::blob_read(files[0]["hash"].as_str().ok_or("Missing plan hash")?)?;
    if bytes.len() as u64 != files[0]["size"].as_u64().ok_or("Missing plan size")?
        || std::str::from_utf8(&bytes).is_err()
        || bytes.contains(&0)
    {
        return Err("Invalid plan content".into());
    }
    Ok(())
}

pub fn destination(root: &Path, resource: &Value) -> Result<PathBuf> {
    let source = resource["source"].as_str().ok_or("Missing plan source")?;
    let logical = resource["logicalPath"]
        .as_str()
        .ok_or("Missing plan path")?;
    if let Some(relative) = logical.strip_prefix(&format!("{source}/files/")) {
        return Ok(project_directory(root, source)?.join(packages::safe_relative(relative)?));
    }
    Ok(root
        .join(".orka/plans")
        .join(packages::safe_relative(logical)?))
}

pub fn path_base(root: &Path, source: &str, path: &Path) -> Result<PathBuf> {
    if path.starts_with(root) {
        check_path(root, path)?;
        return Ok(root.to_path_buf());
    }
    let directory = native_directory(source)?;
    check_path(&directory, path)?;
    Ok(directory)
}

fn expand_path(raw: &str, cwd: &Path) -> Result<PathBuf> {
    let path = if let Some(relative) = raw.strip_prefix("~/") {
        db::home()?.join(packages::safe_relative(relative)?)
    } else if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        cwd.join(packages::safe_relative(raw)?)
    };
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("Unsafe plan reference".into());
    }
    Ok(path)
}

// References are accepted only from provider metadata and tool inputs, never
// arbitrary conversation text that happens to mention another project's file.
pub fn references(source: &str, root: &Path, records: &[Value]) -> Result<Vec<PathBuf>> {
    let project = project_directory(root, source)?;
    let native = native_directory(source)?;
    let cwd = native::session_cwd(source, records)?;
    let mut paths = BTreeSet::new();
    let mut add = |raw: &str| -> Result<()> {
        let Ok(path) = expand_path(raw, &cwd) else {
            return Ok(());
        };
        if path
            .extension()
            .is_none_or(|s| !s.eq_ignore_ascii_case("md"))
        {
            return Ok(());
        }
        if path.starts_with(&project) {
            check_path(root, &path)?;
        } else if path.starts_with(&native) {
            check_path(native.parent().ok_or("Missing native home")?, &path)?;
        } else {
            return Ok(());
        }
        paths.insert(path);
        Ok(())
    };
    for record in records {
        if source == "claude" {
            if let Some(slug) = record["slug"].as_str() {
                if !slug.is_empty() && slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                    for directory in [&project, &native] {
                        add(&directory.join(format!("{slug}.md")).to_string_lossy())?;
                    }
                }
            }
            for value in [
                &record["planFilePath"],
                &record["toolUseResult"]["planFilePath"],
                &record["toolUseResult"]["filePath"],
            ] {
                if let Some(path) = value.as_str() {
                    add(path)?;
                }
            }
            if let Some(blocks) = record["message"]["content"].as_array() {
                for block in blocks {
                    if block["type"] != "tool_use" {
                        continue;
                    }
                    for key in ["planFilePath", "file_path"] {
                        if let Some(path) = block["input"][key].as_str() {
                            add(path)?;
                        }
                    }
                }
            }
        } else if record["type"] == "response_item" && record["payload"]["type"] == "function_call"
        {
            let arguments: Value =
                serde_json::from_str(record["payload"]["arguments"].as_str().unwrap_or("{}"))
                    .unwrap_or(Value::Null);
            for key in ["planFilePath", "file_path", "path"] {
                if let Some(path) = arguments[key].as_str() {
                    add(path)?;
                }
            }
        }
    }
    Ok(paths.into_iter().collect())
}

fn progress(arguments: &Value) -> Option<String> {
    let steps = arguments["plan"].as_array()?;
    if steps.is_empty() {
        return None;
    }
    let mut text = String::from("# Plan progress\n\n");
    if let Some(explanation) = arguments["explanation"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
    {
        text.push_str(explanation);
        text.push_str("\n\n");
    }
    for step in steps {
        let status = step["status"].as_str()?;
        let label = step["step"].as_str()?;
        let prefix = match status {
            "completed" => "- [x] ",
            "pending" => "- [ ] ",
            "in_progress" => "- [ ] **In progress:** ",
            _ => return None,
        };
        text.push_str(prefix);
        text.push_str(&label.replace('\n', " "));
        text.push('\n');
    }
    Some(text)
}

fn proposed(text: &str) -> Option<String> {
    text.split("<proposed_plan>")
        .skip(1)
        .filter_map(|part| {
            part.split_once("</proposed_plan>")
                .map(|(plan, _)| plan.trim())
        })
        .filter(|plan| !plan.is_empty())
        .last()
        .map(str::to_string)
}

pub fn embedded(source: &str, records: &[Value]) -> Vec<(&'static str, String)> {
    let mut proposal = None;
    let mut checklist = None;
    for record in records {
        if source == "claude" {
            if record["type"] != "assistant" {
                continue;
            }
            if let Some(blocks) = record["message"]["content"].as_array() {
                for block in blocks {
                    if block["type"] == "tool_use" && block["name"] == "ExitPlanMode" {
                        if let Some(plan) = block["input"]["plan"]
                            .as_str()
                            .filter(|p| !p.trim().is_empty())
                        {
                            proposal = Some(plan.to_string());
                        }
                    }
                }
            }
            continue;
        }
        let payload = &record["payload"];
        if record["type"] == "response_item"
            && payload["type"] == "message"
            && payload["role"] == "assistant"
        {
            if let Some(content) = payload["content"].as_array() {
                let text = content
                    .iter()
                    .filter_map(|block| block["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                if let Some(plan) = proposed(&text) {
                    proposal = Some(plan);
                }
            }
        } else if record["type"] == "event_msg" && payload["type"] == "agent_message" {
            if let Some(plan) = payload["message"].as_str().and_then(proposed) {
                proposal = Some(plan);
            }
        } else if record["type"] == "event_msg"
            && payload["type"] == "item_completed"
            && payload["item"]["type"] == "Plan"
        {
            if let Some(text) = payload["item"]["text"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
            {
                proposal = Some(proposed(text).unwrap_or_else(|| text.to_string()));
            }
        }
        if record["type"] == "response_item"
            && payload["type"] == "function_call"
            && payload["name"]
                .as_str()
                .is_some_and(|name| name.split('.').next_back() == Some("update_plan"))
        {
            if let Ok(arguments) =
                serde_json::from_str::<Value>(payload["arguments"].as_str().unwrap_or(""))
            {
                if let Some(plan) = progress(&arguments) {
                    checklist = Some(plan);
                }
            }
        } else if record["type"] == "event_msg" && payload["type"] == "plan_update" {
            if let Some(plan) = progress(payload) {
                checklist = Some(plan);
            }
        }
    }
    proposal
        .map(|text| ("plan.md", text))
        .into_iter()
        .chain(checklist.map(|text| ("progress.md", text)))
        .collect()
}
