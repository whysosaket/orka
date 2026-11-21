//! Desktop-owned connector consent. Local session credentials never contain account tokens.
use crate::{
    auth,
    db::{self, Result},
    plugin_process::{AssistantApp, Peer, ProcessIdentity},
    projects,
};
use fs2::FileExt;
use serde_json::{json, Value};
use std::fs;
use uuid::Uuid;

pub const RECONNECT: &str =
    "Reconnect the Orka connector in your assistant, then approve the new session in Orka.";
const STATE_FILE: &str = "plugin-connection.json";
const SCOPES: [&str; 3] = ["orka.read", "orka.write", "orka.manage"];

fn state_lock() -> Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    let root = db::root()?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(root.join("plugin-connection.lock"))
        .map_err(|e| e.to_string())?;
    file.lock_exclusive().map_err(|e| e.to_string())?;
    Ok(file)
}

fn read_state() -> Result<Value> {
    match fs::read(db::root()?.join(STATE_FILE)) {
        Ok(raw) => {
            let mut state: Value = serde_json::from_slice(&raw).map_err(|_| RECONNECT)?;
            Uuid::parse_str(state["generation"].as_str().ok_or(RECONNECT)?)
                .map_err(|_| RECONNECT)?;
            // Old remote-proof approvals are intentionally not migrated into desktop grants.
            if !state["sessions"].is_object() {
                state["sessions"] = json!({});
            }
            if !state["assistantAttention"].is_object() {
                state["assistantAttention"] = json!({});
            }
            state.as_object_mut().ok_or(RECONNECT)?.remove("approval");
            Ok(state)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let state = json!({"generation":Uuid::new_v4().to_string(),"reason":null,"sessions":{},"assistantAttention":{}});
            write_state(&state)?;
            Ok(state)
        }
        Err(e) => Err(e.to_string()),
    }
}
fn write_state(state: &Value) -> Result<()> {
    db::atomic(&db::root()?.join(STATE_FILE), state.to_string().as_bytes())
}

// A saved approval is not proof of a running connection. Keep legacy credentials
// private until authenticated traffic identifies their live helper after upgrade.
fn reconcile(state: &mut Value) -> bool {
    let before = state["sessions"].clone();
    if let Some(sessions) = state["sessions"].as_object_mut() {
        sessions.retain(|_, value| {
            let approved = value["state"] == "approved";
            let remembered = approved && value["assistantApp"].is_string();
            let original_parent = value["assistant"].clone();
            let parent_alive = |parent: &Value| {
                serde_json::from_value::<ProcessIdentity>(parent.clone())
                    .is_ok_and(|identity| identity.alive())
            };
            let Some(members) = value["members"].as_object_mut() else {
                return true;
            };
            members.retain(|_, member| {
                parent_alive(member.get("assistant").unwrap_or(&original_parent))
                    && serde_json::from_value::<ProcessIdentity>(member["process"].clone())
                        .is_ok_and(|identity| identity.alive())
            });
            !members.is_empty() || remembered || approved && parent_alive(&original_parent)
        });
    }
    state["sessions"] != before
}

// Import already-approved assistants before reconciliation removes old sessions.
fn remember_approvals(state: &mut Value) -> bool {
    let apps: Vec<String> = state["sessions"]
        .as_object()
        .into_iter()
        .flat_map(|sessions| sessions.values())
        .filter(|session| !session["connectedAt"].is_null())
        .filter_map(|session| session["assistantApp"].as_str().map(String::from))
        .collect();
    let mut changed = false;
    for app in apps {
        if state["assistantAttention"][&app]["reviewed"] != true {
            state["assistantAttention"][&app]["reviewed"] = json!(true);
            changed = true;
        }
    }
    changed
}

fn connection_completed(state: &mut Value, app: &str) {
    state["assistantAttention"][app] = json!({"reviewed":true,"notified":false});
    if let Some(sessions) = state["sessions"].as_object_mut() {
        for session in sessions.values_mut() {
            if session["assistantApp"] == app
                && matches!(session["state"].as_str(), Some("pending" | "signed_out"))
            {
                session["reconnectResolved"] = json!(true);
            }
        }
    }
}

fn live_state() -> Result<Value> {
    let mut state = read_state()?;
    let remembered = remember_approvals(&mut state);
    if reconcile(&mut state) || remembered {
        write_state(&state)?;
    }
    Ok(state)
}
pub(crate) fn generation() -> Result<String> {
    let _lock = state_lock()?;
    Ok(read_state()?["generation"]
        .as_str()
        .ok_or(RECONNECT)?
        .into())
}
pub(crate) fn invalidate(reason: &str) -> Result<()> {
    let _lock = state_lock()?;
    let mut state = read_state().unwrap_or_else(|_| json!({"sessions":{}}));
    remember_approvals(&mut state);
    state["generation"] = json!(Uuid::new_v4().to_string());
    state["reason"] = json!(reason);
    // Keep tombstones: a live old helper must never acquire a new account's grant.
    for session in state["sessions"]
        .as_object_mut()
        .ok_or(RECONNECT)?
        .values_mut()
    {
        session["state"] = json!("reconnect_required");
    }
    write_state(&state)
}

fn account(db: &rusqlite::Connection) -> Result<Value> {
    let user = db::get(db, "user")?;
    let Some(id) = user.as_str() else {
        return Ok(Value::Null);
    };
    let session = auth::session()?;
    if session["user"]["id"] != id {
        return Err(RECONNECT.into());
    }
    let profile = db::get(db, "accountProfile")?;
    Ok(
        json!({"id":id,"email":session["user"]["email"].as_str(),"displayName":profile["displayName"].as_str()}),
    )
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct Binding {
    pub(crate) account_id: String,
    pub(crate) service_origin: String,
    pub(crate) device_id: String,
    pub(crate) generation: String,
    #[serde(default)]
    pub(crate) session_id: Option<String>,
}

impl Binding {
    pub(crate) fn current() -> Result<Self> {
        let db = db::open()?;
        let account_id = db::get(&db, "user")?.as_str().ok_or(RECONNECT)?.to_string();
        let service_origin = db::get(&db, "config")?["apiUrl"]
            .as_str()
            .ok_or(RECONNECT)?
            .to_string();
        db::validate_url(&service_origin)?;
        Ok(Self {
            account_id,
            service_origin,
            device_id: db::device(&db)?,
            generation: generation()?,
            session_id: None,
        })
    }

    pub(crate) fn check_current(&self) -> Result<()> {
        let current = Self::current()?;
        if self.account_id != current.account_id
            || self.service_origin != current.service_origin
            || self.device_id != current.device_id
            || self.generation != current.generation
        {
            return Err(RECONNECT.into());
        }
        if let Some(id) = &self.session_id {
            let _lock = state_lock()?;
            let state = read_state()?;
            if state["sessions"][id]["state"] != "approved"
                || state["sessions"][id]["binding"]["generation"] != self.generation
            {
                return Err(RECONNECT.into());
            }
        }
        Ok(())
    }
}

fn expires(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|t| t.timestamp() > chrono::Utc::now().timestamp())
}
fn session<'a>(state: &'a Value, id: &str, secret: &str) -> Result<&'a Value> {
    Uuid::parse_str(id).map_err(|_| "Invalid connector session")?;
    if secret.len() != 64 || !secret.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid connector credential".into());
    }
    let hash = db::digest(secret.as_bytes());
    state["sessions"]
        .as_object()
        .ok_or(RECONNECT)?
        .values()
        .find(|value| {
            value["members"][id]["secretHash"] == hash
                || !value["members"].is_object() && value["id"] == id && value["secretHash"] == hash
        })
        .ok_or_else(|| RECONNECT.into())
}
fn public_session(value: &Value, generation: &Value) -> Value {
    let mut result = json!({"id":value["id"],"client":value["client"],"scopes":value["scopes"],"connectedAt":value["connectedAt"],"state":value["state"],"sessionCount":value["members"].as_object().map_or(0, |members| members.len())});
    if value["assistantApp"].is_string() {
        result["remembered"] = json!(true);
    }
    if value["state"] == "approved" && result["sessionCount"] == 0 {
        result["state"] = json!("idle");
    }
    if value["binding"].is_object() && value["binding"]["generation"] != *generation
        || value["state"] == "pending" && !expires(&value["expiresAt"])
    {
        result["state"] = json!("reconnect_required");
    }
    if result["state"] == "pending" {
        result["requestId"] = value["requestId"].clone();
    }
    result
}
fn preview(value: &Value) -> Value {
    json!({"requestId":value["requestId"],"account":value["account"],"serviceOrigin":value["binding"]["service_origin"],
        "client":value["client"],"verified":value["assistantApp"].is_string(),"scopes":value["requestedScopes"],"expiresAt":value["expiresAt"],
        "permissionDescriptions":["Read local and shared project context.","Share selected content, install skills, update memories and plans, and retry or repair synchronization.","Manage project permissions and review requests within your existing authority."]})
}

pub(crate) fn initialize_session(
    id: &str,
    secret: &str,
    name: &str,
    peer: &Peer,
    app: Option<AssistantApp>,
) -> Result<Value> {
    Uuid::parse_str(id).map_err(|_| "Invalid connector session")?;
    if secret.len() != 64 || !secret.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid connector credential".into());
    }
    let Some(_operation) = projects::try_lock()? else {
        return Ok(json!({"state":"busy"}));
    };
    let binding = Binding::current().ok();
    let actual = account(&db::open()?).unwrap_or(Value::Null);
    let _lock = state_lock()?;
    let mut state = live_state()?;
    if state["sessions"]
        .as_object()
        .ok_or(RECONNECT)?
        .values()
        .any(|value| value["id"] == id || !value["members"][id].is_null())
    {
        return Err(
            "This connector session was already initialized. Reconnect in your assistant.".into(),
        );
    }
    let label = name
        .chars()
        .filter(|c| !c.is_control())
        .take(100)
        .collect::<String>();
    let label = match app {
        Some(app) => app.name(),
        None if label.trim().is_empty() => "Assistant",
        None => label.as_str(),
    };
    let valid = binding.is_some() && !actual.is_null();
    let assistant_app = json!(app);
    let first_request = valid
        && assistant_app
            .as_str()
            .is_some_and(|app| state["assistantAttention"][app]["reviewed"] != true);
    let assistant = json!(peer.assistant);
    let workspace = json!(binding);
    let member = json!({"secretHash":db::digest(secret.as_bytes()),"process":peer.helper,"assistant":assistant});
    let existing = state["sessions"]
        .as_object()
        .ok_or(RECONNECT)?
        .iter()
        .find(|(_, value)| {
            let same_assistant = if app.is_some() {
                value["assistantApp"] == assistant_app
            } else {
                value["assistantApp"].is_null()
                    && value["assistant"] == assistant
                    && value["client"]["name"] == label
            };
            valid
                && same_assistant
                && value["binding"] == workspace
                && (value["state"] == "approved"
                    || value["state"] == "pending" && expires(&value["expiresAt"]))
        })
        .map(|(id, _)| id.clone());
    if state["sessions"]
        .as_object()
        .ok_or(RECONNECT)?
        .values()
        .map(|value| {
            value["members"]
                .as_object()
                .map_or(0, |members| members.len())
        })
        .sum::<usize>()
        >= 512
    {
        return Err(
            "Too many active connector sessions. Close unused assistant sessions, then reconnect."
                .into(),
        );
    }
    if let Some(connection) = existing {
        state["sessions"][&connection]["members"][id] = member;
        let value = &state["sessions"][&connection];
        let result = json!({"state":value["state"],"requestId":value["requestId"]});
        if let Some(app) = assistant_app
            .as_str()
            .filter(|_| value["state"] == "approved")
        {
            connection_completed(&mut state, app);
        }
        write_state(&state)?;
        return Ok(result);
    }
    if state["sessions"].as_object().ok_or(RECONNECT)?.len() >= 512 {
        // Only initialize may create a grant. A live helper initializes once; an
        // evicted credential can only fail subsequent calls, never adopt a grant.
        let oldest = state["sessions"]
            .as_object()
            .ok_or(RECONNECT)?
            .iter()
            .min_by_key(|(_, v)| {
                (
                    v["state"] == "approved",
                    v["createdAt"].as_i64().unwrap_or(0),
                )
            })
            .map(|(k, _)| k.clone())
            .ok_or(RECONNECT)?;
        state["sessions"]
            .as_object_mut()
            .ok_or(RECONNECT)?
            .remove(&oldest);
    }
    let requested = json!(SCOPES);
    let request_id = Uuid::new_v4().to_string();
    state["sessions"][id] = json!({"id":id,"members":{id:member},"assistant":assistant,"assistantApp":assistant_app,"binding":workspace,"account":actual,
        "client":{"id":id,"name":label},
        "requestId":request_id,"createdAt":chrono::Utc::now().timestamp_millis(),"requestedScopes":requested,"scopes":[],"connectedAt":null,
        "state":if valid{"pending"}else{"signed_out"},"expiresAt":(chrono::Utc::now()+chrono::Duration::minutes(10)).to_rfc3339()});
    write_state(&state)?;
    Ok(
        json!({"state":if valid{"pending"}else{"signed_out"},"requestId":if valid{json!(request_id)}else{Value::Null},"raiseConsent":first_request}),
    )
}

pub(crate) fn close_session(id: &str, secret: &str) -> Result<()> {
    let _lock = state_lock()?;
    let mut state = live_state()?;
    let connection = session(&state, id, secret)?["id"]
        .as_str()
        .ok_or(RECONNECT)?
        .to_string();
    let value = &mut state["sessions"][&connection];
    if let Some(members) = value["members"].as_object_mut() {
        members.remove(id);
        if !members.is_empty() {
            return write_state(&state);
        }
    }
    if value["state"] == "approved" {
        return write_state(&state);
    }
    state["sessions"]
        .as_object_mut()
        .ok_or(RECONNECT)?
        .remove(&connection);
    write_state(&state)
}

pub(crate) fn identify_session(id: &str, secret: &str, peer: &Peer) -> Result<()> {
    let _lock = state_lock()?;
    let mut state = live_state()?;
    let connection = session(&state, id, secret)?["id"]
        .as_str()
        .ok_or(RECONNECT)?
        .to_string();
    let value = &mut state["sessions"][&connection];
    if value["members"].is_object() {
        let member = &value["members"][id];
        if member["process"] != json!(peer.helper)
            || *member.get("assistant").unwrap_or(&value["assistant"]) != json!(peer.assistant)
        {
            return Err(RECONNECT.into());
        }
    } else {
        // Retain a live pre-upgrade session's existing grant, never copy one by name.
        value["members"] = json!({id:{"secretHash":value["secretHash"],"process":peer.helper}});
        value["assistant"] = json!(peer.assistant);
        value.as_object_mut().ok_or(RECONNECT)?.remove("secretHash");
        write_state(&state)?;
    }
    Ok(())
}

pub(crate) fn authorize(id: &str, secret: &str, scope: &str) -> Result<Binding> {
    let value = {
        let _lock = state_lock()?;
        session(&live_state()?, id, secret)?.clone()
    };
    if value["state"] != "approved" {
        return Err(match value["state"].as_str() {
            Some("pending") if expires(&value["expiresAt"]) => "Approve this request in Orka Settings → Connectors, then retry the tool.",
            Some("signed_out") => "Sign in to Orka desktop, then reconnect this connector in your assistant and approve it in Orka.",
            Some("denied") => "This connector session was denied in Orka. Reconnect in your assistant to request approval again.",
            _ => RECONNECT,
        }.into());
    }
    let mut binding: Binding =
        serde_json::from_value(value["binding"].clone()).map_err(|_| RECONNECT)?;
    binding.check_current()?;
    if !value["scopes"]
        .as_array()
        .is_some_and(|s| s.contains(&json!(scope)))
    {
        return Err(format!("This connector session lacks {scope}. In Orka Settings → Connectors, revoke its access, then reconnect in your assistant and approve the required access."));
    }
    if account(&db::open()?)?["id"] != binding.account_id {
        return Err(RECONNECT.into());
    }
    binding.session_id = value["id"].as_str().map(String::from);
    Ok(binding)
}

#[tauri::command]
pub fn plugin_connection_requests() -> Result<Value> {
    let current = Binding::current().ok();
    let _lock = state_lock()?;
    let state = live_state()?;
    Ok(json!(state["sessions"]
        .as_object()
        .ok_or(RECONNECT)?
        .values()
        .filter(|v| {
            v["members"].is_object()
                && v["state"] == "pending"
                && expires(&v["expiresAt"])
                && current
                    .as_ref()
                    .is_some_and(|b| v["binding"]["generation"] == b.generation)
        })
        .map(preview)
        .collect::<Vec<_>>()))
}
fn first_pending_consent(state: &Value) -> Option<&Value> {
    state["sessions"].as_object()?.values().find(|session| {
        session["state"] == "pending"
            && session["binding"]["generation"] == state["generation"]
            && expires(&session["expiresAt"])
            && session["assistantApp"]
                .as_str()
                .is_some_and(|app| state["assistantAttention"][app]["reviewed"] != true)
    })
}

pub(crate) fn has_first_pending_consent() -> Result<bool> {
    let _lock = state_lock()?;
    Ok(first_pending_consent(&live_state()?).is_some())
}

/// Supply the main window with an initial consent request or a quiet reconnect notice.
#[tauri::command]
pub fn plugin_connection_attention(
    allow_prompt: bool,
    reported_notice: Option<String>,
) -> Result<Value> {
    let _lock = state_lock()?;
    let mut state = live_state()?;
    if let Some(id) = reported_notice {
        if let Some(notice) = state["assistantAttention"]
            .as_object_mut()
            .ok_or(RECONNECT)?
            .values_mut()
            .find(|attention| attention["noticeId"] == id && attention["notified"] != true)
        {
            notice["notified"] = json!(true);
            write_state(&state)?;
        }
        return Ok(Value::Null);
    }
    if allow_prompt {
        if let Some(request) = first_pending_consent(&state) {
            return Ok(json!({"requestId":request["requestId"]}));
        }
    }
    let sessions = state["sessions"].as_object().ok_or(RECONNECT)?;
    let failed = sessions.values().find_map(|session| {
        let app = session["assistantApp"].as_str()?;
        let attention = &state["assistantAttention"][app];
        if attention["reviewed"] != true
            || attention["notified"] == true
            || session["automaticReview"] == true
            || session["reconnectResolved"] == true
            || !matches!(session["state"].as_str(), Some("pending" | "signed_out"))
            || sessions.values().any(|candidate| {
                candidate["assistantApp"] == app
                    && candidate["state"] == "approved"
                    && candidate["binding"]["generation"] == state["generation"]
                    && candidate["members"]
                        .as_object()
                        .is_some_and(|members| !members.is_empty())
            })
        {
            return None;
        }
        Some((app.to_owned(), session["client"]["name"].clone()))
    });
    if let Some((app, name)) = failed {
        let attention = &mut state["assistantAttention"][&app];
        if !attention["noticeId"].is_string() {
            attention["noticeId"] = json!(Uuid::new_v4().to_string());
            write_state(&state)?;
        }
        return Ok(
            json!({"reconnect":{"id":state["assistantAttention"][&app]["noticeId"],"name":name}}),
        );
    }
    Ok(Value::Null)
}

#[tauri::command]
pub fn plugin_connection_status() -> Result<Value> {
    let db = db::open()?;
    let actual = account(&db).unwrap_or(Value::Null);
    let service = db::get(&db, "config")?["apiUrl"].clone();
    let _lock = state_lock()?;
    let state = live_state()?;
    let connections = state["sessions"]
        .as_object()
        .ok_or(RECONNECT)?
        .values()
        .filter(|v| v["members"].is_object())
        .map(|v| public_session(v, &state["generation"]))
        .collect::<Vec<_>>();
    let linked = !actual.is_null() && connections.iter().any(|v| v["state"] == "approved");
    let only_idle = !actual.is_null()
        && !connections.is_empty()
        && connections.iter().all(|v| v["state"] == "idle");
    let pending = connections
        .iter()
        .filter(|v| v["state"] == "pending")
        .count();
    Ok(
        json!({"state":if actual.is_null(){"signed_out"}else if linked{"linked"}else if pending>0{"pending"}else if connections.iter().all(|v| v["state"] == "idle"){"not_linked"}else{"reconnect_required"},
        "account":actual,"serviceOrigin":service,"connections":connections,"pendingCount":pending,"reconnectRequired":!linked && !only_idle,
        "reason":if linked{Value::Null}else if actual.is_null(){json!("Sign in to Orka desktop, then reconnect the connector in your assistant.")}else if pending>0{json!("Review the request below to allow access.")}else if only_idle{json!("No active assistant sessions. Saved access resumes when the assistant connects.")}else{json!(RECONNECT)}}),
    )
}
pub(crate) fn session_status(id: &str, secret: &str) -> Result<Value> {
    let mut result = plugin_connection_status()?;
    let _lock = state_lock()?;
    let state = live_state()?;
    let value = session(&state, id, secret)?;
    result
        .as_object_mut()
        .ok_or(RECONNECT)?
        .remove("connections");
    result["connection"] = public_session(value, &state["generation"]);
    result["state"] = result["connection"]["state"].clone();
    result["reconnectRequired"] = json!(result["state"] != "approved");
    if result["state"] != "approved" {
        result["reason"]=json!(match result["state"].as_str(){Some("pending")=>"Approve this request in Orka Settings → Connectors, then retry.",Some("denied")=>"This connector session was denied. Reconnect in your assistant to request approval again.",Some("signed_out")=>"Sign in to Orka desktop, then reconnect in your assistant.",_=>RECONNECT});
    }
    Ok(result)
}

#[tauri::command]
pub async fn plugin_authorization(operation: String, input: Value) -> Result<Value> {
    let _operation = projects::lock()?;
    let current = Binding::current().ok();
    let actual = account(&db::open()?).unwrap_or(Value::Null);
    let Some(current) = current.filter(|binding| actual["id"] == binding.account_id) else {
        return if operation == "revoke" {
            Err(RECONNECT.into())
        } else {
            Ok(Value::Null)
        };
    };
    let _lock = state_lock()?;
    let mut state = live_state()?;
    if operation == "revoke" {
        let id = input["connectionId"]
            .as_str()
            .ok_or("Choose a connector session")?;
        let value = state["sessions"]
            .get_mut(id)
            .ok_or("Connector session unavailable")?;
        value["state"] = json!("reconnect_required");
        write_state(&state)?;
        return Ok(json!({"revoked":true}));
    }
    let request = input["requestId"]
        .as_str()
        .ok_or("Open the pending connector request in Orka")?;
    let Some(value) = state["sessions"]
        .as_object_mut()
        .ok_or(RECONNECT)?
        .values_mut()
        .find(|v| v["requestId"] == request)
    else {
        return Ok(Value::Null);
    };
    if value["state"] != "pending"
        || !expires(&value["expiresAt"])
        || value["binding"] != json!(current)
        || value["account"]["id"] != current.account_id
    {
        return Ok(Value::Null);
    }
    let app = value["assistantApp"].as_str().map(String::from);
    if operation == "preview" {
        let details = preview(value);
        if input["automatic"] == true && value["automaticReview"] != true {
            let Some(app) = app else {
                return Ok(Value::Null);
            };
            value["automaticReview"] = json!(true);
            if state["assistantAttention"][&app]["reviewed"] == true {
                return Ok(Value::Null);
            }
            state["assistantAttention"][&app]["reviewed"] = json!(true);
            write_state(&state)?;
        }
        return Ok(details);
    }
    if operation == "cancel" {
        value["state"] = json!("denied");
        if let Some(app) = app {
            state["assistantAttention"][&app]["reviewed"] = json!(true);
        }
        write_state(&state)?;
        return Ok(json!({"cancelled":true}));
    }
    if operation != "approve" {
        return Err("Unknown connector action".into());
    }
    let scopes = input
        .get("scopes")
        .cloned()
        .unwrap_or_else(|| value["requestedScopes"].clone());
    let list = scopes.as_array().ok_or("Choose connector access")?;
    if !list.contains(&json!("orka.read"))
        || list.iter().any(|s| !SCOPES.iter().any(|a| s == a))
        || list.len() > 3
    {
        return Err("Choose read access and only the requested connector scopes".into());
    }
    value["scopes"] = scopes;
    value["state"] = json!("approved");
    value["connectedAt"] = json!(db::now());
    if let Some(app) = app {
        connection_completed(&mut state, &app);
    }
    write_state(&state)?;
    Ok(json!({"approved":true}))
}

// Browser OAuth handoffs no longer grant access to the desktop connector.
pub(crate) fn callback(_raw: &str) -> Result<(String, String, String)> {
    Err("Connect the Orka desktop connector in your assistant. Browser plugin login is no longer supported.".into())
}
