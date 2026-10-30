//! Read-only display titles. Native transcripts and synced resource titles stay unchanged.
use serde_json::Value;
use std::sync::LazyLock;

static CONTEXT_BLOCKS: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?s)<(?:environment_context|INSTRUCTIONS|user_instructions|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout|local-command-stderr|in-app-browser-context|external_codex_apps_open_page)(?:\s[^>]*)?>.*?</(?:environment_context|INSTRUCTIONS|user_instructions|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout|local-command-stderr|in-app-browser-context|external_codex_apps_open_page)>").unwrap()
});

fn clean_request(text: &str) -> Option<String> {
    let text = text
        .split_once("## My request:")
        .map_or(text, |(_, request)| request);
    let clean = CONTEXT_BLOCKS.replace_all(text, "");
    let clean = clean.trim();
    if clean.is_empty()
        || clean.starts_with("# AGENTS.md instructions")
        || clean.starts_with("<environment_context")
        || clean.starts_with("<local-command")
        || clean.starts_with("<command-")
        || clean.starts_with("<INSTRUCTIONS")
        || clean.starts_with("<user_instructions")
        || clean.starts_with("<turn_aborted")
        || clean.starts_with("<task-notification")
        || clean.starts_with("<external_codex_apps")
        || clean.starts_with("This session is being continued from a previous conversation")
        || clean.starts_with("You are continuing a task from a previous context window")
    {
        return None;
    }
    Some(clean.to_owned())
}

pub fn request_text(text: &str) -> Option<String> {
    let clean = clean_request(text)?;
    let first_line = clean.lines().find(|line| !line.trim().is_empty())?.trim();
    let title = first_line
        .trim_start_matches('#')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() || title.starts_with('<') || title.starts_with("```") {
        return None;
    }
    if title.chars().count() <= 120 {
        return Some(title);
    }
    let clipped: String = title.chars().take(120).collect();
    Some(format!(
        "{}…",
        clipped
            .rsplit_once(' ')
            .map_or(clipped.as_str(), |(words, _)| words)
    ))
}

pub fn title(bytes: &[u8]) -> crate::db::Result<Option<String>> {
    for line in bytes
        .split(|b| *b == b'\n')
        .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
    {
        let record: Value =
            serde_json::from_slice(line).map_err(|_| "Cannot read session preview")?;
        if let Some(title) =
            crate::session_translation::user_text(&record).and_then(|text| request_text(&text))
        {
            return Ok(Some(title));
        }
    }
    Ok(None)
}

/// One readable conversation turn. `index` is stable within a transcript revision,
/// so the frontend can page through turns without re-reading the file.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Message {
    pub index: usize,
    pub role: &'static str,
    pub text: String,
}

/// Readable conversation turns with setup context and tool records omitted.
pub fn conversation_messages(records: &[Value]) -> Vec<Message> {
    let mut out = Vec::new();
    for message in crate::session_translation::messages(records) {
        let role = message.role;
        if !matches!(role, "user" | "assistant") || message.hidden {
            continue;
        }
        let text = message.text;
        let text = if role == "user" {
            clean_request(&text)
        } else {
            Some(text)
        };
        if let Some(text) = text.filter(|text| !text.trim().is_empty()) {
            out.push(Message {
                index: out.len(),
                role: if role == "user" { "user" } else { "assistant" },
                text: text.trim().to_owned(),
            });
        }
    }
    out
}

/// A readable conversation view; the original transcript remains available separately.
pub fn conversation(records: &[Value]) -> String {
    let messages = conversation_messages(records);
    if messages.is_empty() {
        return "No readable conversation messages. View the full transcript for setup and tool records."
            .into();
    }
    messages
        .iter()
        .map(|message| {
            format!(
                "## {}\n\n{}\n\n",
                if message.role == "user" {
                    "You"
                } else {
                    "Assistant"
                },
                message.text
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn skips_setup_and_finds_codex_request() {
        let records = vec![
            json!({"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n<INSTRUCTIONS>Team guidance</INSTRUCTIONS>"}]}}),
            json!({"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<environment_context>local cwd</environment_context>"}]}}),
            json!({"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<in-app-browser-context>local page</in-app-browser-context>\n## My request:\nFix the session list"}]}}),
        ];
        assert_eq!(
            title(&crate::native::encode(&records)).unwrap().as_deref(),
            Some("Fix the session list")
        );
    }
    #[test]
    fn ignores_tool_results_and_claude_commands() {
        let records = vec![
            json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Not a title"}]}}),
            json!({"type":"user","message":{"role":"user","content":"<command-name>/model</command-name><command-message>model</command-message>"}}),
            json!({"type":"user","isMeta":true,"message":{"role":"user","content":"Injected instructions"}}),
            json!({"type":"user","message":{"role":"user","content":"Review our pricing\nHere are the details"}}),
        ];
        assert_eq!(
            title(&crate::native::encode(&records)).unwrap().as_deref(),
            Some("Review our pricing")
        );
    }
    #[test]
    fn conversation_preserves_body_and_omits_tools_and_setup() {
        let records = vec![
            json!({"type":"user","message":{"role":"user","content":"<environment_context>cwd</environment_context>"}}),
            json!({"type":"user","message":{"role":"user","content":"Fix search\nKeep both lines"}}),
            json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"hidden tool result"}]}}),
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}),
        ];
        let original = records.clone();
        let preview = conversation(&records);
        assert!(preview.contains("Fix search\nKeep both lines"));
        assert!(preview.contains("Done."));
        assert!(!preview.contains("environment_context"));
        assert!(!preview.contains("hidden tool result"));
        assert_eq!(records, original);
    }
    #[test]
    fn conversation_messages_are_ordered_and_indexed() {
        let records = vec![
            json!({"type":"user","message":{"role":"user","content":"<environment_context>cwd</environment_context>"}}),
            json!({"type":"user","message":{"role":"user","content":"Fix search"}}),
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}),
            json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"hidden"}]}}),
            json!({"type":"user","message":{"role":"user","content":"Thanks"}}),
        ];
        let messages = conversation_messages(&records);
        assert_eq!(messages.len(), 3);
        assert_eq!(
            messages
                .iter()
                .map(|m| (m.index, m.role))
                .collect::<Vec<_>>(),
            vec![(0, "user"), (1, "assistant"), (2, "user")]
        );
        assert_eq!(messages[2].text, "Thanks");
    }
    #[test]
    fn honest_empty_unicode_and_corrupt_fallbacks() {
        assert_eq!(
            request_text("<environment_context>cwd</environment_context>"),
            None
        );
        assert_eq!(request_text("<environment_context>truncated"), None);
        assert_eq!(
            request_text("<environment_context>cwd</environment_context>\nFix search"),
            Some("Fix search".into())
        );
        assert_eq!(
            request_text("मेमोरी सूची ठीक करो"),
            Some("मेमोरी सूची ठीक करो".into())
        );
        assert!(request_text(&"word ".repeat(60)).unwrap().chars().count() <= 121);
        assert_eq!(title(b"{\"type\":\"session_meta\"}\n").unwrap(), None);
        assert!(title(b"invalid json\n").is_err());
    }
}
