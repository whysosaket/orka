//! Format adapters for native sessions. Versions are provenance, not file formats.
//! Original JSON records remain the lossless storage and native import boundary.
use crate::db::Result;
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    CodexLegacy,
    CodexPaginated,
    Claude,
}

pub fn metadata<'a>(tool: &str, records: &'a [Value]) -> Result<&'a Value> {
    match tool {
        "codex" => records
            .first()
            .filter(|r| r["type"] == "session_meta" && r["payload"].is_object())
            .map(|r| &r["payload"])
            .ok_or("Missing initial Codex session metadata".into()),
        "claude" => records
            .iter()
            .find(|r| {
                matches!(r["type"].as_str(), Some("user" | "assistant"))
                    && r["cwd"].is_string()
                    && r["sessionId"].is_string()
            })
            .or_else(|| {
                records
                    .iter()
                    .find(|r| r["cwd"].is_string() && r["sessionId"].is_string())
            })
            .ok_or("Missing Claude session metadata".into()),
        _ => Err("Unknown session tool".into()),
    }
}

pub fn format(tool: &str, records: &[Value]) -> Result<Format> {
    let meta = metadata(tool, records)?;
    let id_key = if tool == "codex" { "id" } else { "sessionId" };
    Uuid::parse_str(meta[id_key].as_str().ok_or("Missing native ID")?)
        .map_err(|_| "Invalid native session ID")?;
    if records
        .iter()
        .any(|r| !r.is_object() || !r["type"].is_string())
    {
        return Err("Unsupported session record shape; original preserved".into());
    }
    if tool == "claude" {
        if records.iter().any(|r| {
            (r["sessionId"].is_string() && r["sessionId"] != meta["sessionId"])
                || (matches!(r["type"].as_str(), Some("user" | "assistant"))
                    && !r["message"].is_object())
        }) {
            return Err("Inconsistent Claude session records; original preserved".into());
        }
        return Ok(Format::Claude);
    }
    match meta["history_mode"].as_str() {
        Some("paginated") => Ok(Format::CodexPaginated),
        None if meta["history_mode"].is_null() => {
            if !meta["history_base"].is_null() {
                return Err("Codex history ancestry requires paginated mode".into());
            }
            Ok(Format::CodexLegacy)
        }
        Some("legacy") if meta["history_base"].is_null() => Ok(Format::CodexLegacy),
        _ => Err("Unsupported Codex history format; source preserved".into()),
    }
}

#[derive(Clone)]
pub struct Message {
    pub role: &'static str,
    pub text: String,
    pub full_text: String,
    pub hidden: bool,
}

fn text_content(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.into();
    }
    content
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|part| {
                    matches!(
                        part["type"].as_str(),
                        Some("text" | "input_text" | "output_text" | "Text")
                    )
                })
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn full_content(content: &Value) -> String {
    if let Some(parts) = content.as_array() {
        parts
            .iter()
            .map(|part| {
                if matches!(
                    part["type"].as_str(),
                    Some("text" | "input_text" | "output_text" | "Text")
                ) && part["text"].is_string()
                {
                    part["text"].as_str().unwrap_or_default().to_owned()
                } else {
                    format!("```json\n{part}\n```")
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else if let Some(text) = content.as_str() {
        text.to_owned()
    } else if content.is_null() {
        String::new()
    } else {
        format!("```json\n{content}\n```")
    }
}

fn message(record: &Value) -> Option<(Message, usize)> {
    let kind = record["type"].as_str()?;
    let mut tier = 0;
    let value = if kind == "response_item" {
        &record["payload"]
    } else if kind == "event_msg" {
        let event = &record["payload"];
        match event["type"].as_str()? {
            "item_completed" => {
                tier = 1;
                &event["item"]
            }
            "user_message" | "agent_message" => {
                tier = 2;
                event
            }
            _ => return None,
        }
    } else if matches!(kind, "user" | "assistant") {
        &record["message"]
    } else {
        return None;
    };
    let role = match value["role"]
        .as_str()
        .or_else(|| matches!(kind, "user" | "assistant").then_some(kind))
        .or_else(|| value["type"].as_str())
        .unwrap_or(kind)
    {
        "user" | "user_message" | "UserMessage" | "userMessage" => "user",
        "agent_message" if tier == 0 && value["author"].is_string() => "Tool record",
        "assistant" | "agent_message" | "AgentMessage" | "agentMessage" => "assistant",
        "system" => "system",
        "developer" => "developer",
        _ if tier <= 1 && value["type"] != "message" => "Tool record",
        _ => return None,
    };
    let content = if tier == 2 {
        &value["message"]
    } else if value["content"].is_null() && tier == 1 {
        &value["text"]
    } else {
        &value["content"]
    };
    let text = text_content(content);
    let full_text = if role == "Tool record" {
        format!("```json\n{value}\n```")
    } else {
        full_content(content)
    };
    if full_text.is_empty() {
        return None;
    }
    Some((
        Message {
            role,
            text,
            full_text,
            hidden: record["isMeta"] == true || value["channel"] == "analysis",
        },
        tier,
    ))
}

pub fn user_text(record: &Value) -> Option<String> {
    let (message, _) = message(record)?;
    (message.role == "user" && !message.hidden).then_some(message.text)
}

pub fn messages(records: &[Value]) -> Vec<Message> {
    let mut turn = 0;
    let candidates = records
        .iter()
        .filter_map(|record| {
            if record["type"] == "session_meta"
                || (record["type"] == "event_msg"
                    && matches!(
                        record["payload"]["type"].as_str(),
                        Some("task_started" | "user_message")
                    ))
            {
                turn += 1;
            }
            message(record).map(|(message, tier)| (message, tier, turn))
        })
        .collect::<Vec<_>>();
    // Rollouts often contain the same message as a response, completed item,
    // and legacy event. Prefer responses while retaining repeated user turns.
    let mut counts = HashMap::<(usize, &str, &str), [usize; 3]>::new();
    for (message, tier, turn) in &candidates {
        if !message.text.is_empty() {
            counts
                .entry((*turn, message.role, &message.text))
                .or_default()[*tier] += 1;
        }
    }
    let mut seen = HashMap::<(usize, &str, &str), [usize; 3]>::new();
    candidates
        .iter()
        .filter_map(|(message, tier, turn)| {
            if *tier > 0 {
                let key = (*turn, message.role, message.text.as_str());
                let occurrence = &mut seen.entry(key).or_default()[*tier];
                *occurrence += 1;
                if counts
                    .get(&key)
                    .is_some_and(|n| n[..*tier].iter().any(|n| *n >= *occurrence))
                {
                    return None;
                }
            }
            Some(message.clone())
        })
        .collect()
}

/// Rewrite only native execution coordinates, never paths embedded in messages
/// or tool arguments/results. Those are historical evidence.
pub fn relocate_codex(record: &mut Value, ids: &[&str], id: &str, root: &Path) {
    let kind = record["type"].as_str().unwrap_or_default().to_owned();
    let payload = &mut record["payload"];
    for key in ["thread_id", "threadId", "session_id"] {
        if payload[key].as_str().is_some_and(|s| ids.contains(&s)) {
            payload[key] = json!(id);
        }
    }
    if kind == "session_meta" {
        payload["id"] = json!(id);
        payload["cwd"] = json!(root);
        if !payload["runtime_workspace_roots"].is_null() {
            payload["runtime_workspace_roots"] = json!([root]);
        }
    }
    if payload["type"] == "thread_settings_applied" {
        payload["thread_settings"]["cwd"] = json!(root);
        payload["thread_settings"]["runtime_workspace_roots"] = json!([root]);
    }
    if kind == "turn_context" {
        payload["cwd"] = json!(root);
        for key in ["workspace_roots", "runtime_workspace_roots"] {
            if !payload[key].is_null() {
                payload[key] = json!([root]);
            }
        }
    }
    if kind == "world_state"
        && payload["state"]["environments"]["environments"]["local"]["cwd"].is_string()
    {
        payload["state"]["environments"]["environments"]["local"]["cwd"] = json!(root);
    }
}

pub fn relocate_claude(records: &[Value], id: &str, root: &Path) -> Result<Vec<Value>> {
    format("claude", records)?;
    let mut mapped = records.to_vec();
    for record in &mut mapped {
        if record["sessionId"].is_string() {
            record["sessionId"] = json!(id);
        }
        if record["cwd"].is_string() {
            record["cwd"] = json!(root);
        }
    }
    Ok(mapped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_strings_do_not_determine_transcript_compatibility() {
        for version in [
            "0.155.0-alpha.9.2",
            "0.155.0-alpha.16.3",
            "0.159.2",
            "0.159.3",
            "0.160.0",
            "99.0.0",
            "",
        ] {
            for mode in [Value::Null, json!("legacy"), json!("paginated")] {
                let records = vec![
                    json!({"type":"session_meta","payload":{"id":Uuid::new_v4(),"cli_version":version,"history_mode":mode}}),
                ];
                assert!(format("codex", &records).is_ok(), "{version}");
            }
        }
        for version in [
            "1.0.0", "2.1.277", "2.1.278", "2.1.283", "2.1.284", "2.1.285", "2.1.286", "3.0.0", "",
        ] {
            let records = vec![
                json!({"type":"user","sessionId":Uuid::new_v4(),"cwd":"/project","version":version,"message":{"content":"Hello"}}),
            ];
            assert_eq!(format("claude", &records).unwrap(), Format::Claude);
        }
    }

    #[test]
    fn corrupt_and_ambiguous_formats_are_still_rejected() {
        let mut record =
            json!({"type":"session_meta","payload":{"id":Uuid::new_v4(),"history_mode":"future"}});
        assert!(format("codex", &[record.clone()]).is_err());
        record["payload"]["history_mode"] = json!("legacy");
        record["payload"]["history_base"] = json!({"thread_id":Uuid::new_v4()});
        assert!(format("codex", &[record]).is_err());
        let records = vec![
            json!({"type":"user","sessionId":Uuid::new_v4(),"cwd":"/project","message":{}}),
            json!({"type":"assistant","sessionId":Uuid::new_v4(),"message":{}}),
        ];
        assert!(format("claude", &records).is_err());
        assert!(format("other", &records).is_err());
    }

    #[test]
    fn messages_normalize_event_only_histories_and_claude_roles() {
        let records = vec![
            json!({"type":"event_msg","payload":{"type":"user_message","message":"Fix compatibility"}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"Fixed"}}),
            json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[{"type":"Text","text":"Completed item"}]}}}),
            json!({"type":"user","message":{"type":"message","content":"Claude without a nested role"}}),
        ];
        let messages = messages(&records);
        assert_eq!(
            messages
                .iter()
                .map(|m| (m.role, m.text.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("user", "Fix compatibility"),
                ("assistant", "Fixed"),
                ("assistant", "Completed item"),
                ("user", "Claude without a nested role")
            ]
        );
        assert_eq!(
            crate::session_presentation::title(&crate::native::encode(&records))
                .unwrap()
                .as_deref(),
            Some("Fix compatibility")
        );
    }

    #[test]
    fn mirrored_events_are_deduplicated_without_losing_repeated_turns() {
        let mut records = Vec::new();
        for _ in 0..2 {
            records.extend([
                json!({"type":"event_msg","payload":{"type":"task_started"}}),
                json!({"type":"event_msg","payload":{"type":"user_message","message":"Again"}}),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Again"}]}}),
                json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"Again"}]}}}),
                json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}}),
                json!({"type":"event_msg","payload":{"type":"agent_message","message":"Done"}}),
            ]);
        }
        // A later event-only turn must survive even when its text repeats.
        records.extend([
            json!({"type":"event_msg","payload":{"type":"task_started"}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"Again"}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"Done"}}),
        ]);
        let result = messages(&records);
        assert_eq!(result.len(), 6);
        assert_eq!(result.iter().filter(|m| m.role == "user").count(), 3);
    }

    #[test]
    fn tools_and_unknown_content_survive_handoff_but_not_conversation_preview() {
        let records = vec![
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Checking"},{"type":"tool_use","id":"call-1","name":"Read","input":{"path":"/old/file"}},{"type":"future_block","data":"keep"}]}}),
            json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-1","content":"result"}]}}),
            json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-2","output":"native result"}}),
        ];
        let source = records.clone();
        let transcript = crate::native::transcript(&records);
        for expected in ["call-1", "/old/file", "future_block", "result", "call-2"] {
            assert!(transcript.contains(expected));
        }
        let preview = crate::session_presentation::conversation_messages(&records);
        assert_eq!(preview.len(), 1);
        assert_eq!(preview[0].text, "Checking");
        assert_eq!(records, source);
    }

    #[test]
    fn completed_text_and_agent_communication_keep_their_boundaries() {
        let records = vec![
            json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"agentMessage","text":"Visible answer"}}}),
            json!({"type":"response_item","payload":{"type":"agent_message","author":"/root/worker","recipient":"/root","content":[{"type":"input_text","text":"Internal agent report"}]}}),
            json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"commandExecution","command":"pwd","aggregatedOutput":"/project"}}}),
        ];
        let visible = crate::session_presentation::conversation_messages(&records);
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].text, "Visible answer");
        let handoff = crate::native::transcript(&records);
        assert!(handoff.contains("Internal agent report"));
        assert!(handoff.contains("/root/worker"));
        assert!(handoff.contains("/project"));
    }

    #[test]
    fn relocating_claude_preserves_message_graph_and_version_provenance() {
        let records = vec![
            json!({"type":"user","sessionId":Uuid::new_v4(),"cwd":"/old","version":"2.1.277","uuid":"message-1","parentUuid":null,"message":{"content":"/old stays in text"}}),
            json!({"type":"assistant","cwd":"/old","version":"2.1.286","uuid":"message-2","parentUuid":"message-1","message":{"content":[{"type":"tool_use","id":"call-1","input":{"path":"/old"}}]}}),
        ];
        let id = Uuid::new_v4().to_string();
        let mapped = relocate_claude(&records, &id, Path::new("/new/接続")).unwrap();
        assert_eq!(mapped[0]["sessionId"], id);
        assert_eq!(mapped[1]["cwd"], "/new/接続");
        assert_eq!(mapped[1]["parentUuid"], records[1]["parentUuid"]);
        assert_eq!(mapped[1]["message"], records[1]["message"]);
        assert_eq!(mapped[0]["version"], "2.1.277");
    }
}
