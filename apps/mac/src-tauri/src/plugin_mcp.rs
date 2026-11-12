use crate::{db::Result, plugin_operations, selective_sharing};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::time::Duration;

pub fn tools() -> Value {
    let mut result = Vec::new();
    for (name, description, extra, required) in [
        ("list_local_resources", "Find local memories, skills, plans, or sessions, including categories with automatic sharing off. Returns metadata only; do not infer the current session from recency.", json!({"kind":{"type":"string","enum":["memory","skill","plan","session"]},"sourceId":{"type":"string","format":"uuid"},"nativeId":{"type":"string"},"query":{"type":"string","maxLength":200},"offset":{"type":"integer","minimum":0}}), vec!["kind"]),
        ("preview_share", "Freeze one selected local snapshot and inspect its title, files, size, and token before an explicitly requested team share. Future turns are excluded. Requires the same account and service as the remote Orka connection.", json!({"kind":{"type":"string","enum":["memory","skill","plan","session"]},"resourceId":{"type":"string","format":"uuid"}}), vec!["kind","resourceId"]),
        ("share_selected", "Publish the exact previewed snapshot only when the user explicitly asks to share or update it. Automatic-sharing settings remain unchanged. May return published, queued, conflict, or approval_required; never describe queued or approval-required content as shared.", json!({"previewToken":{"type":"string","format":"uuid"}}), vec!["previewToken"]),
        ("list_skills", "Discover complete local, global agent, and cached shared skill packages on this machine. Shared cache may be stale; remote list_skills checks current access. Returns metadata and hashes, never publishes content.", json!({"sourceId":{"type":"string","format":"uuid"},"query":{"type":"string","maxLength":200},"offset":{"type":"integer","minimum":0,"maximum":2147483647}}), vec![]),
        ("install_skill", "Install a complete selected skill package into the selected project (Codex and Claude mirrors) or this machine's Codex or Claude skill home. Requires an explicit user installation request and the reviewed snapshotHash. Shared skills also require expectedRevision and fresh server authorization. Differing existing skill directories are preserved.", json!({"skillId":{"type":"string","maxLength":128},"origin":{"type":"string","enum":["local","global","shared"]},"sourceId":{"type":"string","format":"uuid"},"target":{"type":"string","enum":["project","codex","claude"]},"snapshotHash":{"type":"string","maxLength":64},"expectedRevision":{"type":"integer","minimum":1}}), vec!["skillId","origin","target","snapshotHash"]),
        ("get_sync_status", "View this project's local sync health, queued operation identities, conflicts, errors, and repository folder state. Account-wide connectivity and progress are labeled separately. Returns at most 50 entries per section; follow nextOffset.", json!({"offset":{"type":"integer","minimum":0,"maximum":2147483647}}), vec![]),
        ("retry_sync", "Retry this project's eligible pending and failed sync operations with their original request IDs and bytes, then run a project sync cycle. Stale conflicts and permission failures remain blocked for review. Reports pending if the service or worker is unavailable.", json!({}), vec![]),
        ("repair_sync", "Recover this project's guarded local sync bindings and interrupted skill installations, then retry eligible synchronization. Pending changes, conflict candidates and queued request identities are preserved. Does not reset caches, discard changes, or resolve conflicts automatically.", json!({}), vec![]),
    ] {
        let mut properties = json!({"accountId":{"type":"string","format":"uuid"},"serviceOrigin":{"type":"string"},"projectId":{"type":"string","format":"uuid"}});
        properties.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let mut required_fields = vec!["accountId","serviceOrigin","projectId"];
        required_fields.extend(required);
        result.push(json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required_fields,"additionalProperties":false},"annotations":{"readOnlyHint":matches!(name,"list_local_resources"|"preview_share"|"list_skills"|"get_sync_status"),"destructiveHint":false,"idempotentHint":true,"openWorldHint":matches!(name,"share_selected"|"install_skill"|"retry_sync"|"repair_sync")}}));
    }
    json!(result)
}

fn validate(schema: &Value, input: &Value) -> Result<()> {
    let fields = input
        .as_object()
        .ok_or("Tool arguments must be an object")?;
    for key in schema["required"].as_array().ok_or("Invalid tool schema")? {
        if !fields.contains_key(key.as_str().ok_or("Invalid tool schema")?) {
            return Err("Missing required tool argument".into());
        }
    }
    for (key, value) in fields {
        let rule = &schema["properties"][key];
        if rule.is_null() {
            return Err(format!("Unknown tool argument: {key}"));
        }
        if rule["type"] == "string" && !value.is_string()
            || rule["type"] == "integer" && value.as_u64().is_none()
        {
            return Err(format!("Invalid tool argument: {key}"));
        }
        if rule["format"] == "uuid" {
            uuid::Uuid::parse_str(value.as_str().unwrap_or(""))
                .map_err(|_| format!("Invalid {key}"))?;
        }
        if let Some(choices) = rule["enum"].as_array() {
            if !choices.contains(value) {
                return Err(format!("Invalid {key}"));
            }
        }
        if let Some(minimum) = rule["minimum"].as_u64() {
            if value.as_u64().is_none_or(|number| number < minimum) {
                return Err(format!("Invalid {key}"));
            }
        }
        if let Some(maximum) = rule["maximum"].as_u64() {
            if value.as_u64().is_none_or(|number| number > maximum) {
                return Err(format!("Invalid {key}"));
            }
        }
        if let Some(limit) = rule["maxLength"].as_u64() {
            if value.as_str().unwrap_or("").chars().count() as u64 > limit {
                return Err(format!("{key} is too long"));
            }
        }
    }
    Ok(())
}

pub(crate) async fn call(name: &str, arguments: &Value) -> Result<Value> {
    let definitions = tools();
    let tool = definitions
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == name)
        .ok_or("Unknown local Orka tool")?;
    validate(&tool["inputSchema"], arguments)?;
    if matches!(
        name,
        "list_local_resources" | "preview_share" | "share_selected"
    ) {
        selective_sharing::command(name, arguments).await
    } else {
        plugin_operations::command(name, arguments).await
    }
}

pub fn run() -> Result<()> {
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let (requests, incoming) = sync_channel(1);
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            if requests.send(line).is_err() {
                break;
            }
        }
    });
    let mut stdout = io::stdout().lock();
    loop {
        // Idle MCP connections must release the launcher's runtime lock for an update.
        // Finish an active request before checking maintenance again.
        if crate::updates::installation_pending() {
            return Ok(());
        }
        let line = match incoming.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => line,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let line = line.map_err(|e| e.to_string())?;
        if line.len() > 2_000_000 {
            return Err("Plugin request exceeds size limit".into());
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                writeln!(stdout,"{}",json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Invalid JSON"}})).map_err(|e|e.to_string())?;
                continue;
            }
        };
        let Some(id) = request.get("id") else {
            continue;
        };
        let response = match request["method"].as_str().unwrap_or("") {
            "initialize" => {
                json!({"result":{"protocolVersion":request["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26"),"capabilities":{"tools":{}},"serverInfo":{"name":"orka-local","version":"0.3.0"},"instructions":"Local one-off sharing requires an explicit user request. Match the remote Orka account and service, list the correct local item, preview its frozen snapshot, then share its token. Never guess the current session or enable automatic sharing. Respect queued, conflict, and approval_required results. Install skills and retry or repair sync only when requested. Review the selected skill snapshot hash and shared revision before installation; preserve differing local directories. Local tool results describe this machine only."}})
            }
            "ping" => json!({"result":{}}),
            "tools/list" => json!({"result":{"tools":tools()}}),
            "tools/call" => {
                let name = request["params"]["name"].as_str().unwrap_or("");
                let arguments = request["params"]["arguments"].clone();
                let result = runtime.block_on(call(name, &arguments));
                match result {
                    Ok(value) => {
                        json!({"result":{"content":[{"type":"text","text":value.to_string()}],"structuredContent":value}})
                    }
                    Err(error) => {
                        json!({"result":{"isError":true,"content":[{"type":"text","text":error}]}})
                    }
                }
            }
            _ => json!({"error":{"code":-32601,"message":"Method not found"}}),
        };
        let mut response = response;
        response["jsonrpc"] = json!("2.0");
        response["id"] = id.clone();
        writeln!(stdout, "{response}").map_err(|e| e.to_string())?;
        stdout.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}
