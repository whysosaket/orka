use super::crypto::MAX_BYTES;
use crate::db::Result;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, ops::Range};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub key: String,
    pub literal: String,
}
pub struct Assignment {
    pub entry: Entry,
    pub value: Range<usize>,
}
pub struct Document {
    pub text: Zeroizing<String>,
    pub assignments: Vec<Assignment>,
}

pub fn parse(text: String) -> Result<Document> {
    let text = Zeroizing::new(text);
    if text.len() > MAX_BYTES || text.contains('\0') {
        return Err("ENV input must be UTF-8 text without NUL bytes, at most 1 MB".into());
    }
    let bytes = text.as_bytes();
    let mut at = if text.starts_with('\u{feff}') { 3 } else { 0 };
    let mut assignments = Vec::new();
    let mut keys = BTreeSet::new();
    while at < bytes.len() {
        while at < bytes.len() && bytes[at].is_ascii_whitespace() {
            at += 1;
        }
        if at == bytes.len() {
            break;
        }
        if bytes[at] == b'#' {
            while at < bytes.len() && bytes[at] != b'\n' {
                at += 1;
            }
            continue;
        }
        let line = 1 + bytes[..at].iter().filter(|b| **b == b'\n').count();
        let error = || format!("Invalid ENV assignment on line {line}");
        if text[at..].starts_with("export")
            && bytes.get(at + 6).is_some_and(|b| matches!(b, b' ' | b'\t'))
        {
            at += 6;
            while at < bytes.len() && matches!(bytes[at], b' ' | b'\t') {
                at += 1;
            }
        }
        let key_start = at;
        if at == bytes.len() || !(bytes[at].is_ascii_alphabetic() || bytes[at] == b'_') {
            return Err(error());
        }
        at += 1;
        while at < bytes.len() && (bytes[at].is_ascii_alphanumeric() || bytes[at] == b'_') {
            at += 1;
        }
        let key = text[key_start..at].to_string();
        if !keys.insert(key.clone()) {
            return Err(format!("Duplicate ENV key on line {line}"));
        }
        while at < bytes.len() && matches!(bytes[at], b' ' | b'\t') {
            at += 1;
        }
        if bytes.get(at) != Some(&b'=') {
            return Err(error());
        }
        at += 1;
        while at < bytes.len() && matches!(bytes[at], b' ' | b'\t') {
            at += 1;
        }
        let start = at;
        let end;
        if bytes.get(at).is_some_and(|b| matches!(b, b'\'' | b'"')) {
            let quote = bytes[at];
            at += 1;
            loop {
                if at >= bytes.len() {
                    return Err(error());
                }
                if bytes[at] == quote {
                    at += 1;
                    break;
                }
                if quote == b'"' && bytes[at] == b'\\' {
                    at += 1;
                    if at >= bytes.len() {
                        return Err(error());
                    }
                }
                at += 1;
            }
            end = at;
            while at < bytes.len() && matches!(bytes[at], b' ' | b'\t' | b'\r') {
                at += 1;
            }
            if at < bytes.len() && !matches!(bytes[at], b'#' | b'\n') {
                return Err(error());
            }
        } else {
            while at < bytes.len() && !matches!(bytes[at], b'\n' | b'\r' | b'#') {
                at += 1;
            }
            end = start + text[start..at].trim_end_matches([' ', '\t']).len();
        }
        let literal = text[start..end].to_string();
        assignments.push(Assignment {
            entry: Entry { key, literal },
            value: start..end,
        });
        if bytes.get(at) == Some(&b'#') {
            while at < bytes.len() && bytes[at] != b'\n' {
                at += 1;
            }
        }
    }
    Ok(Document { text, assignments })
}
pub fn validate_entries(entries: &[Entry]) -> Result<()> {
    let mut names = BTreeSet::new();
    for entry in entries {
        if !names.insert(entry.key.as_str()) {
            return Err("Duplicate encrypted ENV key".into());
        }
        let document = parse(format!("{}={}\n", entry.key, entry.literal))?;
        if document.assignments.len() != 1
            || document.assignments[0].entry.key != entry.key
            || document.assignments[0].entry.literal != entry.literal
        {
            return Err("Invalid encrypted ENV assignment".into());
        }
    }
    if entries.is_empty() {
        return Err("Select at least one ENV key".into());
    }
    Ok(())
}
pub fn select(entries: &[Entry], keys: &[String]) -> Result<Vec<Entry>> {
    if keys.is_empty() || keys.iter().collect::<BTreeSet<_>>().len() != keys.len() {
        return Err("Select unique ENV keys".into());
    }
    keys.iter()
        .map(|key| {
            entries
                .iter()
                .find(|e| &e.key == key)
                .cloned()
                .ok_or("ENV key no longer exists".into())
        })
        .collect()
}
pub fn merge(document: &Document, incoming: &[Entry]) -> Result<Zeroizing<String>> {
    validate_entries(incoming)?;
    let mut text = Zeroizing::new(document.text.to_string());
    for assignment in document.assignments.iter().rev() {
        if let Some(entry) = incoming.iter().find(|e| e.key == assignment.entry.key) {
            text.replace_range(assignment.value.clone(), &entry.literal);
        }
    }
    let newline = if document.text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    for entry in incoming {
        if !document
            .assignments
            .iter()
            .any(|a| a.entry.key == entry.key)
        {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push_str(newline);
            }
            text.push_str(&entry.key);
            text.push('=');
            text.push_str(&entry.literal);
            text.push_str(newline);
        }
    }
    if text.len() > MAX_BYTES {
        return Err("Merged ENV file exceeds 1 MB".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literals_multiline_comments_and_merge() {
        let doc =
            parse("# local\r\nexport TOKEN = 'old' # retain\r\nLOCAL=yes\r\n".into()).unwrap();
        let input = parse(
            "TOKEN=\"first\nsecond # inside\"\nEMPTY=\nREF=${HOME}\nCOMMAND=$(touch /never)\n"
                .into(),
        )
        .unwrap();
        let entries: Vec<_> = input.assignments.iter().map(|a| a.entry.clone()).collect();
        let merged = merge(&doc, &entries).unwrap();
        assert!(merged.contains("export TOKEN = \"first\nsecond # inside\" # retain\r\nLOCAL=yes"));
        assert!(merged.contains("REF=${HOME}"));
        assert!(merged.contains("COMMAND=$(touch /never)"));
        assert_eq!(parse(merged.to_string()).unwrap().assignments.len(), 5);
    }
    #[test]
    fn errors_do_not_include_secrets() {
        for input in [
            "A=CANARY\nA=again",
            "BAD-CANARY=secret",
            "A=\"CANARY",
            "A='CANARY' trailing",
            "CANARY",
        ] {
            let error = parse(input.into()).err().unwrap();
            assert!(!error.contains("CANARY"));
        }
        assert!(validate_entries(&[Entry {
            key: "A".into(),
            literal: "one\nB=two".into()
        }])
        .is_err());
    }
}
