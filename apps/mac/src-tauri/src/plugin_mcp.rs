use crate::{db::Result, selective_sharing};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

pub fn tools() -> Value {
    let mut result = Vec::new();
    for (name, description, extra, required) in [
        ("list_local_resources", "Find local memories, skills, plans, or sessions, including categories with automatic sharing off. Returns metadata only; do not infer the current session from recency.", json!({"kind":{"type":"string","enum":["memory","skill","plan","session"]},"sourceId":{"type":"string","format":"uuid"},"nativeId":{"type":"string"},"query":{"type":"string","maxLength":200},"offset":{"type":"integer","minimum":0}}), vec!["kind"]),
        ("preview_share", "Freeze one selected local snapshot and inspect its title, files, size, and token before an explicitly requested team share. Future turns are excluded. Requires the same account and service as the remote Orka connection.", json!({"kind":{"type":"string","enum":["memory","skill","plan","session"]},"resourceId":{"type":"string","format":"uuid"}}), vec!["kind","resourceId"]),
        ("share_selected", "Publish the exact previewed snapshot only when the user explicitly asks to share or update it. Automatic-sharing settings remain unchanged. May return published, queued, conflict, or approval_required; never describe queued or approval-required content as shared.", json!({"previewToken":{"type":"string","format":"uuid"}}), vec!["previewToken"]),
    ] {
        let mut properties = json!({"accountId":{"type":"string","format":"uuid"},"serviceOrigin":{"type":"string"},"projectId":{"type":"string","format":"uuid"}});
        properties.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let mut required_fields = vec!["accountId","serviceOrigin","projectId"];
        required_fields.extend(required);
        result.push(json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required_fields,"additionalProperties":false},"annotations":{"readOnlyHint":name!="share_selected","destructiveHint":false,"idempotentHint":true,"openWorldHint":name=="share_selected"}}));
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
        if let Some(limit) = rule["maxLength"].as_u64() {
            if value.as_str().unwrap_or("").chars().count() as u64 > limit {
                return Err(format!("{key} is too long"));
            }
        }
    }
    Ok(())
}

pub fn run() -> Result<()> {
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
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
                json!({"result":{"protocolVersion":request["params"]["protocolVersion"].as_str().unwrap_or("2025-03-26"),"capabilities":{"tools":{}},"serverInfo":{"name":"orka-local","version":"0.2.0"},"instructions":"Local one-off sharing requires an explicit user request. Match the remote Orka account and service, list the correct local item, preview its frozen snapshot, then share its token. Never guess the current session or enable automatic sharing. Respect queued, conflict, and approval_required results."}})
            }
            "ping" => json!({"result":{}}),
            "tools/list" => json!({"result":{"tools":tools()}}),
            "tools/call" => {
                let definitions = tools();
                let name = request["params"]["name"].as_str().unwrap_or("");
                let arguments = request["params"]["arguments"].clone();
                let result = definitions
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|tool| tool["name"] == name)
                    .ok_or_else(|| "Unknown local sharing tool".to_string())
                    .and_then(|tool| validate(&tool["inputSchema"], &arguments))
                    .and_then(|_| runtime.block_on(selective_sharing::command(name, &arguments)));
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
