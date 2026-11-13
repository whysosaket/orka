mod crypto;
pub(crate) mod dotenv;
pub(crate) mod files;
#[cfg(debug_assertions)]
pub mod test_support;

use crate::{
    auth,
    db::{self, Result},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use crypto::{Approval, Header, Keys, Manifest, Pin, ReadResponse, Version};
use dotenv::Entry;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

static SESSION_EPOCH: AtomicU64 = AtomicU64::new(0);
const ENV_CONFLICT: &str =
    "ENV changed or a retry is stale. Pull the latest version and review before publishing again";

pub fn enabled() -> bool {
    serde_json::from_str::<Value>(include_str!("../../../src/features.json"))
        .expect("Valid product feature configuration")["env"]
        == true
}
struct Context {
    owner: String,
    origin: String,
    scope: String,
    epoch: u64,
    source_id: Option<String>,
}
impl Context {
    fn current() -> Result<Self> {
        let db = db::open()?;
        let owner = db::get(&db, "user")?
            .as_str()
            .ok_or("Sign in to use ENVs")?
            .to_string();
        if auth::session()?["user"]["id"] != owner {
            return Err("Account changed; reopen ENVs".into());
        }
        let origin = db::get(&db, "config")?["apiUrl"]
            .as_str()
            .ok_or("Configure the service")?
            .trim_end_matches('/')
            .to_string();
        db::validate_url(&origin)?;
        let scope = db::digest(format!("{origin}\n{owner}").as_bytes());
        Ok(Self {
            owner,
            origin,
            scope,
            epoch: SESSION_EPOCH.load(Ordering::SeqCst),
            source_id: None,
        })
    }
    fn ensure(&self) -> Result<()> {
        if Self::current()?.scope != self.scope
            || self.epoch != SESSION_EPOCH.load(Ordering::SeqCst)
        {
            return Err("Account or service changed; reopen ENVs".into());
        }
        Ok(())
    }
    fn connection(&self) -> Result<rusqlite::Connection> {
        db::open_at(&db::profile_path(&self.owner, &self.origin)?)
    }
    fn get(&self, key: &str) -> Result<Value> {
        db::get(&self.connection()?, &format!("env:{}:{key}", self.scope))
    }
    fn put(&self, key: &str, value: &Value) -> Result<()> {
        db::set(
            &self.connection()?,
            &format!("env:{}:{key}", self.scope),
            value,
        )
    }
    fn advance_pin(&self, project: &str, set: &str, next: &Pin, receipt: bool) -> Result<()> {
        let mut db = self.connection()?;
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "Cannot save ENV trust state")?;
        let key = format!("env:{}:{}", self.scope, pin_key(project, set));
        let value = db::get(&tx, &key)?;
        if !value.is_null() {
            let previous: Pin =
                serde_json::from_value(value).map_err(|_| "Invalid saved ENV trust state")?;
            if previous.root_hash != next.root_hash
                || (previous.revision == next.revision && previous.head_hash != next.head_hash)
            {
                return Err("ENV trust history changed; use a trusted Mac to investigate".into());
            }
            if previous.revision > next.revision {
                if receipt {
                    return Ok(());
                }
                return Err("An older ENV version was returned; pull again".into());
            }
        }
        db::set(&tx, &key, &json!(next))?;
        tx.commit()
            .map_err(|_| "Cannot save ENV trust state".into())
    }
    fn keyring(&self) -> Result<keyring::Entry> {
        let service = format!(
            "com.orka.v1.env.{}",
            db::digest(db::root()?.to_string_lossy().as_bytes())
        );
        keyring::Entry::new(&service, &self.scope)
            .map_err(|_| "Cannot open the ENV Keychain entry".into())
    }
    fn keys(&self) -> Result<Option<Keys>> {
        match self.keyring()?.get_password() {
            Ok(raw) => serde_json::from_str(&Zeroizing::new(raw))
                .map(Some)
                .map_err(|_| "Cannot read ENV keys; use trusted-device recovery".into()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Unlock macOS Keychain to use ENVs".into()),
        }
    }
    fn project_root(&self, id: &str, source_id: Option<&str>) -> Result<PathBuf> {
        crate::projects::active(&self.connection()?, id)?;
        let project = db::rows(
            &self.connection()?,
            "SELECT value FROM projects WHERE id=?",
            &[&id],
        )?
        .into_iter()
        .next()
        .ok_or("Project is not connected")?;
        let project = crate::sources::select(&project, source_id)?;
        crate::sources::validate(&project)?;
        let path = PathBuf::from(
            project["path"]
                .as_str()
                .ok_or("Connect this project’s local folder first")?,
        );
        if project["folderIdentity"].as_str().is_some_and(|expected| {
            !crate::indexer::folder_identity_matches(&path, expected).unwrap_or(false)
        }) {
            return Err("Connected project folder changed; reconnect before applying ENVs".into());
        }
        Ok(path)
    }
}
struct Draft {
    scope: String,
    project: String,
    source_id: Option<String>,
    set: String,
    entries: Vec<Entry>,
    base: Option<Header>,
    preview: Option<Value>,
    created: Instant,
}
static DRAFTS: OnceLock<Mutex<BTreeMap<String, Draft>>> = OnceLock::new();
static OPERATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn drafts() -> &'static Mutex<BTreeMap<String, Draft>> {
    DRAFTS.get_or_init(|| Mutex::new(BTreeMap::new()))
}
pub fn clear() {
    SESSION_EPOCH.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut state) = drafts().lock() {
        state.clear();
    }
}
fn with_draft<T>(ctx: &Context, id: &str, f: impl FnOnce(&mut Draft) -> Result<T>) -> Result<T> {
    let mut state = drafts().lock().map_err(|_| "ENV draft unavailable")?;
    state.retain(|_, d| d.created.elapsed() < Duration::from_secs(1800));
    let draft = state
        .get_mut(id)
        .filter(|d| d.scope == ctx.scope)
        .ok_or("ENV draft expired; import or pull it again")?;
    f(draft)
}
fn new_source_id(local: &Value, requested: Option<&str>) -> Result<Option<String>> {
    let Some(sources) = local["sources"].as_array() else {
        return Ok(requested.map(str::to_owned));
    };
    let active: Vec<_> = sources
        .iter()
        .filter(|source| source["removedAt"].is_null())
        .collect();
    let source = if let Some(id) = requested {
        active
            .into_iter()
            .find(|source| source["id"] == id)
            .ok_or("ENV repository was removed or no longer belongs to this project")?
    } else {
        match active.as_slice() {
            [source] => *source,
            _ => return Err("Choose a repository for this ENV set".into()),
        }
    };
    Ok(source["id"].as_str().map(str::to_owned))
}

#[cfg(test)]
mod source_selection_tests {
    use super::*;
    #[test]
    fn new_env_sets_reject_removed_sources_and_default_to_the_active_repository() {
        let project = json!({"sources":[{"id":"removed","removedAt":"2026-11-13T00:00:00Z"},{"id":"active"}]});
        assert!(new_source_id(&project, Some("removed")).is_err());
        assert_eq!(
            new_source_id(&project, None).unwrap().as_deref(),
            Some("active")
        );
        assert_eq!(
            new_source_id(&project, Some("active")).unwrap().as_deref(),
            Some("active")
        );
    }
}

fn add_draft(
    ctx: &Context,
    project: &str,
    set: &str,
    entries: Vec<Entry>,
    base: Option<Header>,
) -> Result<Value> {
    dotenv::validate_entries(&entries)?;
    let id = uuid::Uuid::new_v4().to_string();
    let source_id = if let Some(base) = &base {
        Some(base.manifest.source_id.clone().unwrap_or(project.into()))
    } else {
        let local = crate::governance::project(&ctx.connection()?, project)?;
        new_source_id(&local, ctx.source_id.as_deref())?
    };
    if let Some(source_id) = &source_id {
        let local = crate::governance::project(&ctx.connection()?, project)?;
        if local["sources"].is_array()
            && !local["sources"]
                .as_array()
                .unwrap()
                .iter()
                .any(|source| source["id"] == *source_id)
        {
            return Err("ENV repository no longer belongs to this project".into());
        }
    }
    let output = json!({"draftId":id,"projectId":project,"sourceId":source_id,"setId":set,"keys":entries.iter().map(|e| &e.key).collect::<Vec<_>>(),"revision":base.as_ref().map(|b| b.manifest.revision),"manifest":base.as_ref().map(|b| &b.manifest)});
    let mut state = drafts().lock().map_err(|_| "ENV draft unavailable")?;
    state.retain(|_, d| d.created.elapsed() < Duration::from_secs(1800));
    if state.len() >= 12 {
        return Err("Close an ENV draft before opening another".into());
    }
    state.insert(
        id,
        Draft {
            scope: ctx.scope.clone(),
            project: project.into(),
            source_id,
            set: set.into(),
            entries,
            base,
            preview: None,
            created: Instant::now(),
        },
    );
    Ok(output)
}
fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .ok_or_else(|| format!("Missing ENV {name}"))
}
fn strings(value: &Value, name: &str) -> Result<Vec<String>> {
    value[name]
        .as_array()
        .ok_or_else(|| format!("Missing ENV {name}"))?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_string)
                .ok_or("Invalid ENV selection".into())
        })
        .collect()
}
fn identifier(value: &Value, name: &str) -> Result<String> {
    let id = field(value, name)?;
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid ENV identifier")?;
    Ok(id.into())
}
fn pin_key(project: &str, set: &str) -> String {
    format!("pin:{project}:{set}")
}
async fn api(ctx: &Context, keys: &Keys, operation: &str, input: Value) -> Result<Value> {
    ctx.ensure()?;
    if let Some(project) = input["projectId"]
        .as_str()
        .or_else(|| input["version"]["manifest"]["projectId"].as_str())
    {
        crate::projects::require_sharing(&ctx.connection()?, project, "env")?;
    }
    let call = json!({"format":1,"deviceId":keys.device.id,"time":chrono::Utc::now().timestamp_millis(),"nonce":uuid::Uuid::new_v4().to_string(),"operation":operation,"input":input});
    let signature = keys.sign(&call)?;
    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Cannot connect to ENV service")?
        .post(format!("{}/v2/env/action", ctx.origin))
        .header("X-Orka-Governance", "1")
        .bearer_auth(auth::token_for_service(&ctx.owner, &ctx.origin).await?)
        .json(&json!({"call":call,"signature":signature}))
        .send()
        .await
        .map_err(|_| "ENV service unavailable. Retry when connected")?;
    let status = response.status();
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "ENV response interrupted; retry when connected")?
    {
        if bytes.len() + chunk.len() > 32_000_000 {
            return Err("ENV response exceeds size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    ctx.ensure()?;
    if !status.is_success() {
        // Do not relay arbitrary server text into an error: it could contain a secret.
        return Err(match status.as_u16() {
            409 => ENV_CONFLICT,
            401 => "Sign in again to use ENVs",
            403 => "ENV permission denied. Check publishing access, recipients, device approval or set replacement",
            404 => "ENV sharing is unavailable or the set was deleted",
            400 => "ENV request rejected. Check device approval expiry and this Mac’s clock",
            413 => "ENV request exceeds the size limit",
            _ => "ENV service unavailable. Retry when connected",
        }.into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid ENV service response".into())
}
async fn read(
    ctx: &Context,
    keys: &Keys,
    project: &str,
    set: &str,
    initial: Option<Pin>,
) -> Result<ReadResponse> {
    let accepting = initial.is_some();
    let pin: Pin = initial.map(Ok).unwrap_or_else(|| {
        serde_json::from_value(ctx.get(&pin_key(project, set))?)
            .map_err(|_| "Import an approval response from a trusted Mac first".to_string())
    })?;
    let response: ReadResponse = serde_json::from_value(
        api(ctx, keys, "read", json!({"projectId":project,"setId":set})).await?,
    )
    .map_err(|_| "Invalid encrypted ENV response")?;
    let next = crypto::verify_chain(&response, &pin, project, set)?;
    if !response.version.manifest.grants.contains(&ctx.owner)
        || !response.version.manifest.devices.contains(&keys.device)
    {
        return Err("This Mac is not approved for this ENV set".into());
    }
    ctx.ensure()?;
    if !accepting {
        ctx.advance_pin(project, set, &next, false)?;
    }
    Ok(response)
}
fn entries(keys: &Keys, version: &Version) -> Result<Vec<Entry>> {
    let decrypted = keys.decrypt(&version.ciphertext)?;
    let entries: Vec<Entry> =
        serde_json::from_slice(&decrypted).map_err(|_| "Invalid encrypted ENV content")?;
    dotenv::validate_entries(&entries)?;
    Ok(entries)
}
fn code(prefix: &str, value: &impl serde::Serialize) -> Result<String> {
    Ok(format!(
        "ORKA-ENV-{prefix}-1:{}",
        STANDARD.encode(crypto::canonical(value)?)
    ))
}
fn decode_code(prefix: &str, raw: &str) -> Result<Value> {
    if raw.len() > 100_000 {
        return Err("ENV approval code exceeds size limit".into());
    }
    let value = raw
        .trim()
        .strip_prefix(&format!("ORKA-ENV-{prefix}-1:"))
        .ok_or("Invalid ENV approval code")?;
    serde_json::from_slice(
        &STANDARD
            .decode(value)
            .map_err(|_| "Invalid ENV approval code")?,
    )
    .map_err(|_| "Invalid ENV approval code".into())
}
fn approval(raw: &str) -> Result<Approval> {
    let approval: Approval = serde_json::from_value(decode_code("REQUEST", raw)?)
        .map_err(|_| "Invalid ENV approval request")?;
    if approval.request.format != 1
        || approval.request.expires_at > chrono::Utc::now().timestamp_millis() + 900_000
    {
        return Err("Device approval expired; generate a new request".into());
    }
    crypto::verify(
        &approval.request.device,
        &approval.request,
        &approval.signature,
    )?;
    Ok(approval)
}
async fn send_pending(ctx: &Context, keys: &Keys, id: &str) -> Result<Value> {
    let pending = ctx.get(&format!("pending:{id}"))?;
    if pending.is_null() {
        return Err("No pending ENV publication".into());
    }
    let result = api(ctx, keys, "mutate", pending["mutation"].clone()).await.map_err(|error| {
            if !pending["sourceRemoval"].is_null() && error == ENV_CONFLICT {
            format!("{error} The encrypted ENV publication is preserved on this Mac after its source folder was removed.")
        } else { error }
    })?;
    let header: Header = serde_json::from_value(pending["header"].clone())
        .map_err(|_| "Invalid pending ENV publication")?;
    if result["revision"] != header.manifest.revision || result["hash"] != crypto::hash(&header)? {
        return Err("ENV publication receipt does not match; retry the publication".into());
    }
    let project = &header.manifest.project_id;
    let set = &header.manifest.set_id;
    ctx.advance_pin(
        project,
        set,
        &Pin {
            root_hash: field(&pending, "rootHash")?.into(),
            head_hash: crypto::hash(&header)?,
            revision: header.manifest.revision,
        },
        true,
    )?;
    if let Some(code) = pending["approvalCode"].as_str() {
        let decoded = decode_code("RESPONSE", code)?;
        let nonce = identifier(&decoded["receipt"], "nonce")?;
        let device = header
            .manifest
            .approvals
            .iter()
            .find(|a| a.request.nonce == nonce)
            .ok_or("Missing device approval")?;
        ctx.put(&format!("response:{nonce}"), &json!({"projectId":project,"code":code,"device":device.request.device.name,"createdAt":chrono::Utc::now().timestamp_millis()}))?;
    }
    ctx.put(&format!("pending:{id}"), &Value::Null)?;
    Ok(
        json!({"revision":header.manifest.revision,"setId":set,"approvalCode":pending["approvalCode"]}),
    )
}
async fn publish(
    ctx: &Context,
    keys: &Keys,
    previous: Option<&Header>,
    mut manifest: Manifest,
    content: &[Entry],
    response_nonce: Option<&str>,
) -> Result<Value> {
    crate::projects::require_sharing(&ctx.connection()?, &manifest.project_id, "env")?;
    // Persist only the encrypted, signed retry payload; plaintext drafts remain in memory.
    let plaintext = Zeroizing::new(serde_json::to_vec(content).map_err(|_| "Invalid ENV content")?);
    let ciphertext = if manifest.deleted {
        String::new()
    } else {
        crypto::encrypt(&plaintext, &manifest.devices)?
    };
    manifest.ciphertext_hash = db::digest(&crypto::decode_ciphertext(&ciphertext)?);
    manifest.author_device_id = keys.device.id.clone();
    manifest.revision = previous.map(|h| h.manifest.revision + 1).unwrap_or(1);
    manifest.previous_hash = previous.map(crypto::hash).transpose()?.unwrap_or_default();
    manifest.access_revision = previous
        .map(|old| {
            old.manifest.access_revision
                + u64::from(
                    old.manifest.grants != manifest.grants
                        || old.manifest.devices != manifest.devices
                        || old.manifest.approvals != manifest.approvals,
                )
        })
        .unwrap_or(1);
    crypto::validate_transition(previous.map(|h| &h.manifest), &manifest)?;
    let header = Header {
        signature: keys.sign(&manifest)?,
        manifest,
    };
    let root_hash = if previous.is_none() {
        crypto::hash(&header)?
    } else {
        field(
            &ctx.get(&pin_key(
                &header.manifest.project_id,
                &header.manifest.set_id,
            ))?,
            "rootHash",
        )?
        .to_string()
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    let mut approval_code = Value::Null;
    if let Some(nonce) = response_nonce {
        let added = header
            .manifest
            .approvals
            .iter()
            .find(|a| a.request.nonce == nonce)
            .ok_or("Missing approved device")?;
        let receipt = json!({"format":1,"projectId":header.manifest.project_id,"setId":header.manifest.set_id,"nonce":nonce,
            "deviceId":added.request.device.id,"rootHash":root_hash,"headHash":crypto::hash(&header)?,"revision":header.manifest.revision,"approver":keys.device});
        approval_code = json!(code(
            "RESPONSE",
            &json!({"receipt":receipt,"signature":keys.sign(&receipt)?})
        )?);
    }
    ctx.put(&format!("pending:{request_id}"), &json!({"rootHash":root_hash,"header":header,"approvalCode":approval_code,
        "mutation":{"requestId":request_id,"expectedRevision":previous.map(|h| h.manifest.revision).unwrap_or(0),
            "expectedAccessRevision":previous.map(|h| h.manifest.access_revision).unwrap_or(0),
            "version":{"manifest":header.manifest,"signature":header.signature,"ciphertext":ciphertext}}}))?;
    send_pending(ctx, keys, &request_id).await
}

#[tauri::command]
pub async fn env_command(action: String, input: Value) -> Result<Value> {
    let _operation = OPERATIONS.lock().await;
    if action == "clear" {
        clear();
        return Ok(json!({}));
    }
    if !enabled() {
        return Err("ENV support is disabled".into());
    }
    let mut ctx = Context::current()?;
    ctx.source_id = input["sourceId"].as_str().map(str::to_owned);
    if action == "capabilities" {
        let result = crate::sync::api("GET", "/v2/env/capabilities", None).await;
        ctx.ensure()?;
        return match result {
            Ok(v) => {
                let keys = ctx.keys()?;
                if v["format"] == 1 {
                    if let Some(keys) = &keys {
                        api(&ctx, keys, "enroll", json!(keys.device)).await?;
                    }
                }
                Ok(json!({"supported":v["format"] == 1,"enabled":keys.is_some()}))
            }
            Err(e) if e.starts_with("404:") => Ok(json!({"supported":false,"enabled":false})),
            Err(_) => Err("Connect to the service to check ENV availability".into()),
        };
    }
    if action == "enable" {
        let keys = if let Some(keys) = ctx.keys()? {
            keys
        } else {
            let name = field(&input, "name")?.trim();
            if name.is_empty() || name.len() > 100 {
                return Err("Enter a device name up to 100 characters".into());
            }
            let keys = Keys::generate(&ctx.owner, name);
            let raw = Zeroizing::new(
                serde_json::to_string(&keys).map_err(|_| "Cannot serialize ENV keys")?,
            );
            ctx.keyring()?
                .set_password(&raw)
                .map_err(|_| "Cannot save ENV keys in macOS Keychain")?;
            keys
        };
        return api(&ctx, &keys, "enroll", json!(keys.device)).await;
    }
    let keys = ctx.keys()?.ok_or("Enable ENVs on this Mac first")?;
    match action.as_str() {
        "list" => {
            let project = identifier(&input, "projectId")?;
            let (mut sets, directory) = tokio::try_join!(
                api(&ctx, &keys, "list", json!({"projectId":project})),
                api(&ctx, &keys, "directory", json!({"projectId":project}))
            )?;
            for set in sets["sets"].as_array_mut().ok_or("Invalid ENV list")? {
                let id = identifier(set, "setId")?;
                let trusted = set["approved"] == true
                    && serde_json::from_value::<Pin>(ctx.get(&pin_key(&project, &id))?).is_ok();
                set["trusted"] = json!(trusted);
            }
            let pending:Vec<Value> = db::rows(&ctx.connection()?, "SELECT value FROM meta WHERE key LIKE ? AND value!='null'", &[&format!("env:{}:pending:%", ctx.scope)])?
                .into_iter().filter(|v| v["header"]["manifest"]["projectId"] == project).map(|v| json!({"id":v["mutation"]["requestId"],"setId":v["header"]["manifest"]["setId"],"name":v["header"]["manifest"]["name"]})).collect();
            let responses = db::rows(
                &ctx.connection()?,
                "SELECT value FROM meta WHERE key LIKE ? AND value!='null'",
                &[&format!("env:{}:response:%", ctx.scope)],
            )?
            .into_iter()
            .filter(|v| {
                v["projectId"] == project
                    && v["createdAt"].as_i64().unwrap_or(0)
                        > chrono::Utc::now().timestamp_millis() - 86_400_000
            })
            .collect::<Vec<_>>();
            let policy = db::get(&ctx.connection()?, &format!("governance:{project}"))?;
            let local = crate::governance::project(&ctx.connection()?, &project)?;
            let can_create = local["governed"] != true
                || policy["access"]["env"]["create"] == "publish"
                || local["role"] == "owner";
            Ok(
                json!({"canCreate":can_create,"sets":sets["sets"],"members":directory["members"],"device":keys.device,"pending":pending,"responses":responses}),
            )
        }
        "import" => {
            let project = identifier(&input, "projectId")?;
            crate::projects::require_sharing(&ctx.connection()?, &project, "env")?;
            let (set, base) = if let Some(id) = input["baseDraft"].as_str() {
                with_draft(&ctx, id, |d| {
                    if d.project != project {
                        return Err("ENV draft belongs to another project".into());
                    }
                    Ok((d.set.clone(), d.base.clone()))
                })?
            } else {
                (uuid::Uuid::new_v4().to_string(), None)
            };
            let text = if let Some(path) = input["path"].as_str() {
                files::read_text(&PathBuf::from(path))?
            } else {
                Zeroizing::new(field(&input, "text")?.to_string())
            };
            let doc = dotenv::parse(text.to_string())?;
            add_draft(
                &ctx,
                &project,
                &set,
                doc.assignments.into_iter().map(|a| a.entry).collect(),
                base,
            )
        }
        "clone-set" => {
            let id = field(&input, "draftId")?;
            let (project, entries, source_id) = with_draft(&ctx, id, |d| {
                Ok((d.project.clone(), d.entries.clone(), d.source_id.clone()))
            })?;
            ctx.source_id = source_id;
            crate::projects::require_sharing(&ctx.connection()?, &project, "env")?;
            add_draft(
                &ctx,
                &project,
                &uuid::Uuid::new_v4().to_string(),
                entries,
                None,
            )
        }
        "pull" => {
            let project = identifier(&input, "projectId")?;
            let set = identifier(&input, "setId")?;
            let response = read(&ctx, &keys, &project, &set, None).await?;
            add_draft(
                &ctx,
                &project,
                &set,
                entries(&keys, &response.version)?,
                Some(response.version.header()),
            )
        }
        "discard" => {
            if let Some(id) = input["draftId"].as_str() {
                with_draft(&ctx, id, |_| Ok(()))?;
                drafts()
                    .lock()
                    .map_err(|_| "ENV draft unavailable")?
                    .remove(id);
            }
            if let Some(id) = input["pendingId"].as_str() {
                uuid::Uuid::parse_str(id).map_err(|_| "Invalid ENV retry ID")?;
                ctx.put(&format!("pending:{id}"), &Value::Null)?;
            }
            Ok(json!({}))
        }
        "reveal" => with_draft(&ctx, field(&input, "draftId")?, |d| {
            let key = field(&input, "key")?;
            Ok(
                json!({"value":d.entries.iter().find(|e| e.key == key).ok_or("ENV key not found")?.literal}),
            )
        }),
        "publish" => {
            let (project, set, content, base) = with_draft(&ctx, field(&input, "draftId")?, |d| {
                Ok((
                    d.project.clone(),
                    d.set.clone(),
                    dotenv::select(&d.entries, &strings(&input, "keys")?)?,
                    d.base.clone(),
                ))
            })?;
            let manifest = if let Some(base) = &base {
                base.manifest.clone()
            } else {
                let name = field(&input, "name")?.trim().to_string();
                if name.is_empty() || name.len() > 100 {
                    return Err("Enter an ENV set name up to 100 characters".into());
                }
                let mut grants = strings(&input, "grants")?;
                grants.push(ctx.owner.clone());
                grants.sort();
                grants.dedup();
                Manifest {
                    format: 1,
                    project_id: project,
                    source_id: with_draft(&ctx, field(&input, "draftId")?, |d| {
                        Ok(d.source_id.clone())
                    })?,
                    set_id: set,
                    name,
                    creator: ctx.owner.clone(),
                    revision: 1,
                    access_revision: 1,
                    grants,
                    devices: vec![keys.device.clone()],
                    approvals: vec![],
                    author_device_id: keys.device.id.clone(),
                    previous_hash: String::new(),
                    ciphertext_hash: String::new(),
                    deleted: false,
                }
            };
            publish(&ctx, &keys, base.as_ref(), manifest, &content, None).await
        }
        "retry" => send_pending(&ctx, &keys, &identifier(&input, "pendingId")?).await,
        "request" => {
            let project = identifier(&input, "projectId")?;
            let set = identifier(&input, "setId")?;
            let list = api(&ctx, &keys, "list", json!({"projectId":project})).await?;
            if !list["sets"]
                .as_array()
                .is_some_and(|sets| sets.iter().any(|s| s["setId"] == set))
            {
                return Err("Ask the ENV creator to select you as a recipient first".into());
            }
            let request = crypto::Request {
                format: 1,
                project_id: project,
                set_id: set,
                device: keys.device.clone(),
                nonce: uuid::Uuid::new_v4().to_string(),
                expires_at: chrono::Utc::now().timestamp_millis() + 900_000,
            };
            let approval = Approval {
                signature: keys.sign(&request)?,
                request,
            };
            ctx.put(
                &format!("request:{}", approval.request.nonce),
                &json!(approval),
            )?;
            Ok(json!({"code":code("REQUEST", &approval)?}))
        }
        "approval_info" => Ok(json!(approval(field(&input, "code")?)?.request)),
        "approve" => {
            let approval = approval(field(&input, "code")?)?;
            let request = &approval.request;
            let saved = ctx.get(&format!("response:{}", request.nonce))?;
            if saved["code"].is_string() {
                return Ok(json!({"setId":request.set_id,"approvalCode":saved["code"]}));
            }
            if request.expires_at < chrono::Utc::now().timestamp_millis() {
                return Err("Device approval expired; generate a new request".into());
            }
            let response = read(&ctx, &keys, &request.project_id, &request.set_id, None).await?;
            let base = response.version.header();
            let mut next = base.manifest.clone();
            if ctx.owner != next.creator && ctx.owner != request.device.owner {
                return Err(
                    "Only the creator or this teammate’s trusted Mac can approve this device"
                        .into(),
                );
            }
            if !next.grants.contains(&request.device.owner) {
                return Err(
                    "Select this teammate as an ENV recipient before approving their Mac".into(),
                );
            }
            if next.devices.iter().any(|d| d.id == request.device.id) {
                return Err(
                    "This Mac is already approved; use the saved response or revoke this device and request approval again".into(),
                );
            }
            next.devices.push(request.device.clone());
            next.devices.sort_by(|a, b| a.id.cmp(&b.id));
            next.approvals.push(approval.clone());
            next.approvals
                .sort_by(|a, b| a.request.device.id.cmp(&b.request.device.id));
            publish(
                &ctx,
                &keys,
                Some(&base),
                next,
                &entries(&keys, &response.version)?,
                Some(&request.nonce),
            )
            .await
        }
        "accept" => {
            let value = decode_code("RESPONSE", field(&input, "code")?)?;
            let receipt = &value["receipt"];
            let approver: crypto::Device = serde_json::from_value(receipt["approver"].clone())
                .map_err(|_| "Invalid approval response")?;
            crypto::verify(&approver, receipt, field(&value, "signature")?)?;
            let nonce = identifier(receipt, "nonce")?;
            let request: Approval =
                serde_json::from_value(ctx.get(&format!("request:{nonce}"))?)
                    .map_err(|_| "Approval response does not match a request from this Mac")?;
            let project = identifier(receipt, "projectId")?;
            let set = identifier(receipt, "setId")?;
            if receipt["format"] != 1
                || receipt["deviceId"] != keys.device.id
                || request.request.project_id != project
                || request.request.set_id != set
                || request.request.device != keys.device
            {
                return Err("Approval response belongs to another Mac or ENV set".into());
            }
            let pin = Pin {
                root_hash: field(receipt, "rootHash")?.into(),
                head_hash: field(receipt, "headHash")?.into(),
                revision: receipt["revision"]
                    .as_u64()
                    .filter(|r| *r > 0)
                    .ok_or("Invalid approval revision")?,
            };
            let old = ctx.get(&pin_key(&project, &set))?;
            if !old.is_null()
                && (old["rootHash"] != pin.root_hash
                    || old["revision"].as_u64().unwrap_or(0) > pin.revision)
            {
                return Err("Approval response is older than this Mac’s trusted ENV state".into());
            }
            let response = read(&ctx, &keys, &project, &set, Some(pin.clone())).await?;
            let approved = &response.chain[pin.revision as usize - 1];
            if approved.manifest.author_device_id != approver.id
                || !approved.manifest.devices.contains(&approver)
                || !approved.manifest.approvals.contains(&request)
            {
                return Err("Approval response does not match the signed ENV history".into());
            }
            let next_pin = crypto::verify_chain(&response, &pin, &project, &set)?;
            ctx.advance_pin(&project, &set, &next_pin, false)?;
            ctx.put(&format!("request:{nonce}"), &Value::Null)?;
            add_draft(
                &ctx,
                &project,
                &set,
                entries(&keys, &response.version)?,
                Some(response.version.header()),
            )
        }
        "access" | "delete" => {
            let project = identifier(&input, "projectId")?;
            let set = identifier(&input, "setId")?;
            let response = read(&ctx, &keys, &project, &set, None).await?;
            let base = response.version.header();
            if input["revision"].as_u64() != Some(base.manifest.revision) {
                return Err("ENV changed; pull and review access again".into());
            }
            let mut next = base.manifest.clone();
            if action == "delete" {
                next.deleted = true;
            } else {
                next.grants = strings(&input, "grants")?;
                next.grants.sort();
                next.grants.dedup();
                let removed = strings(&input, "removeDevices")?;
                next.devices
                    .retain(|d| next.grants.contains(&d.owner) && !removed.contains(&d.id));
                next.approvals
                    .retain(|a| next.devices.contains(&a.request.device));
            }
            publish(
                &ctx,
                &keys,
                Some(&base),
                next,
                &entries(&keys, &response.version)?,
                None,
            )
            .await
        }
        "preview" => {
            let (project, source_id, content) = with_draft(&ctx, field(&input, "draftId")?, |d| {
                Ok((
                    d.project.clone(),
                    d.source_id.clone(),
                    dotenv::select(&d.entries, &strings(&input, "keys")?)?,
                ))
            })?;
            let root = ctx.project_root(&project, source_id.as_deref())?;
            let preview = files::preview(&root, field(&input, "path")?, &content)?;
            with_draft(&ctx, field(&input, "draftId")?, |d| {
                d.preview =
                    Some(json!({"preview":preview,"root":root,"keys":strings(&input,"keys")?}));
                Ok(())
            })?;
            Ok(preview)
        }
        "exclude" => {
            let _lock = crate::projects::lock()?;
            let project = identifier(&input, "projectId")?;
            files::exclude(
                &ctx.project_root(&project, ctx.source_id.as_deref())?,
                field(&input, "path")?,
            )?;
            Ok(json!({}))
        }
        "apply" => {
            let _lock = crate::projects::lock()?;
            let (project, source_id, set, base, content, preview, reviewed_root) =
                with_draft(&ctx, field(&input, "draftId")?, |d| {
                    let preview = d
                        .preview
                        .clone()
                        .ok_or("Preview local changes before applying")?;
                    Ok((
                        d.project.clone(),
                        d.source_id.clone(),
                        d.set.clone(),
                        d.base
                            .clone()
                            .ok_or("Pull a published ENV set before applying")?,
                        dotenv::select(&d.entries, &strings(&preview, "keys")?)?,
                        preview["preview"].clone(),
                        preview["root"].clone(),
                    ))
                })?;
            let response = read(&ctx, &keys, &project, &set, None).await?;
            if response.version.header() != base {
                return Err(
                    "Shared ENV set changed. Pull and preview again before applying".into(),
                );
            }
            ctx.ensure()?;
            let root = ctx.project_root(&project, source_id.as_deref())?;
            if reviewed_root != json!(root) {
                return Err("Repository folder changed; preview the ENV changes again".into());
            }
            files::apply(
                &root,
                field(&preview, "path")?,
                field(&preview, "fingerprint")?,
                &content,
            )?;
            with_draft(&ctx, field(&input, "draftId")?, |d| {
                d.preview = None;
                Ok(())
            })?;
            Ok(json!({"applied":true}))
        }
        "compare" | "rebase" => {
            let selected_keys = strings(&input, "keys")?;
            let (project, set, local, local_base) =
                with_draft(&ctx, field(&input, "draftId")?, |d| {
                    Ok((
                        d.project.clone(),
                        d.set.clone(),
                        // Compare the complete publication the user selected, including omissions.
                        if selected_keys.is_empty() {
                            Vec::new()
                        } else {
                            dotenv::select(&d.entries, &selected_keys)?
                        },
                        d.base.clone(),
                    ))
                })?;
            let (remote, base) = with_draft(&ctx, field(&input, "remoteDraft")?, |d| {
                if d.project != project
                    || d.set != set
                    || d.base.is_none()
                    || d.base.as_ref().map(|b| b.manifest.revision)
                        < local_base.as_ref().map(|b| b.manifest.revision)
                {
                    return Err("Pull the latest version of this ENV set first".into());
                }
                Ok((d.entries.clone(), d.base.clone()))
            })?;
            let mut names: Vec<String> =
                local.iter().chain(&remote).map(|e| e.key.clone()).collect();
            names.sort();
            names.dedup();
            if action == "compare" {
                return Ok(json!({"keys":names.iter().map(|key| {
                let l=local.iter().find(|e| &e.key==key); let r=remote.iter().find(|e| &e.key==key);
                json!({"key":key,"local":l.is_some(),"remote":r.is_some(),"changed":l.map(|e| &e.literal)!=r.map(|e| &e.literal)})
            }).collect::<Vec<_>>()}));
            }
            let choices = input["choices"]
                .as_object()
                .ok_or("Choose a version for every ENV key")?;
            let mut selected = Vec::new();
            for key in names {
                let list = match choices.get(&key).and_then(Value::as_str) {
                    Some("local") => &local,
                    Some("remote") => &remote,
                    Some("omit") => continue,
                    _ => return Err("Choose a version for every ENV key".into()),
                };
                selected.push(
                    list.iter()
                        .find(|e| e.key == key)
                        .cloned()
                        .ok_or("Selected ENV key is unavailable")?,
                );
            }
            add_draft(&ctx, &project, &set, selected, base)
        }
        _ => Err("Unknown ENV action".into()),
    }
}
