//! Isolated, debug-only native integration harness. Never touches the user's Keychain.
use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence};
use serde_json::{json, Value};
use std::{
    any::Any,
    collections::BTreeMap,
    io::{BufRead, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use zeroize::Zeroizing;

type Secrets = Arc<Mutex<BTreeMap<String, Zeroizing<Vec<u8>>>>>;
struct Builder(Secrets);
struct MemoryCredential {
    name: String,
    secrets: Secrets,
}
static LOCKED: AtomicBool = AtomicBool::new(false);
fn unlocked() -> keyring::Result<()> {
    if LOCKED.load(Ordering::SeqCst) {
        return Err(keyring::Error::NoStorageAccess(Box::new(
            std::io::Error::other("Test Keychain locked"),
        )));
    }
    Ok(())
}
impl CredentialBuilderApi for Builder {
    fn build(
        &self,
        _: Option<&str>,
        service: &str,
        user: &str,
    ) -> keyring::Result<Box<Credential>> {
        Ok(Box::new(MemoryCredential {
            name: format!("{service}:{user}"),
            secrets: self.0.clone(),
        }))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn persistence(&self) -> CredentialPersistence {
        CredentialPersistence::ProcessOnly
    }
}
impl CredentialApi for MemoryCredential {
    fn set_secret(&self, value: &[u8]) -> keyring::Result<()> {
        unlocked()?;
        self.secrets
            .lock()
            .unwrap()
            .insert(self.name.clone(), Zeroizing::new(value.to_vec()));
        Ok(())
    }
    fn get_secret(&self) -> keyring::Result<Vec<u8>> {
        unlocked()?;
        self.secrets
            .lock()
            .unwrap()
            .get(&self.name)
            .map(|v| v.to_vec())
            .ok_or(keyring::Error::NoEntry)
    }
    fn delete_credential(&self) -> keyring::Result<()> {
        unlocked()?;
        self.secrets
            .lock()
            .unwrap()
            .remove(&self.name)
            .map(|_| ())
            .ok_or(keyring::Error::NoEntry)
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}
pub fn run() {
    if std::env::var_os("ORKA_TEST_HOME").is_none() {
        eprintln!("Isolated test home required");
        std::process::exit(1);
    }
    keyring::set_default_credential_builder(Box::new(Builder(Arc::new(Mutex::new(
        BTreeMap::new(),
    )))));
    let runtime = tokio::runtime::Runtime::new().expect("Test runtime");
    for line in std::io::stdin().lock().lines() {
        let result = (|| -> crate::db::Result<Value> {
            let input: Value = serde_json::from_str(&line.map_err(|_| "Test input unavailable")?)
                .map_err(|_| "Invalid test input")?;
            match input["action"].as_str().unwrap_or("") {
                "cloud" => runtime.block_on(crate::commands::cloud_action(
                    super::field(&input, "operation")?.into(),
                    input["input"].clone(),
                )),
                "project" => runtime.block_on(crate::projects::project_command(
                    input["operation"]
                        .as_str()
                        .ok_or("Missing project action")?
                        .into(),
                    input["input"].clone(),
                )),
                "settings" => runtime.block_on(crate::settings::settings_command(
                    super::field(&input, "operation")?.into(),
                    input["context"].clone(),
                )),
                "onboarding" => runtime.block_on(crate::onboarding::onboarding_command(
                    super::field(&input, "operation")?.into(),
                    input["input"].clone(),
                    input.get("context").cloned(),
                )),
                "disconnect-source" => crate::sources::disconnect_project_source(
                    super::field(&input, "projectId")?.into(),
                    super::field(&input, "sourceId")?.into(),
                )
                .map(|_| json!({})),
                "switch-service" => {
                    crate::commands::switch_service(input["config"].clone()).map(|_| json!({}))
                }
                "setup" => {
                    crate::auth::sign_out()?;
                    crate::commands::configure(json!({"apiUrl":input["url"],"syncMinutes":15}))?;
                    let session = if input["session"].is_object() {
                        input["session"].clone()
                    } else {
                        json!({"user":{"id":input["user"]},"access_token":input["user"],"refresh_token":"unused-test-refresh","expires_at":chrono::Utc::now().timestamp()+86400})
                    };
                    if session["user"]["id"] != input["user"] {
                        return Err("Test session belongs to another account".into());
                    }
                    crate::auth::test_session(&session)?;
                    let db = crate::db::open()?;
                    let id = super::field(&input, "projectId")?;
                    let mut project = json!({"id":id,"name":"ENV native test","path":input["path"],"role":"member"});
                    if let Some(sources) = input["sources"].as_array() {
                        let mut sources = sources.clone();
                        for source in &mut sources {
                            if let Some(path) = source["path"].as_str() {
                                let root = std::path::Path::new(path)
                                    .canonicalize()
                                    .map_err(|error| error.to_string())?;
                                source["folderIdentity"] =
                                    json!(crate::indexer::folder_identity(&root)?);
                                source["path"] = json!(root);
                            }
                        }
                        project["sources"] = json!(sources);
                        project.as_object_mut().unwrap().remove("path");
                    }
                    crate::db::upsert(&db, "projects", id, id, &project)?;
                    Ok(json!({}))
                }
                "governance" => runtime.block_on(crate::governance::governance_command(
                    input["operation"]
                        .as_str()
                        .ok_or("Missing operation")?
                        .into(),
                    input["input"].clone(),
                )),
                "env" => runtime.block_on(super::env_command(
                    super::field(&input, "operation")?.into(),
                    input["input"].clone(),
                )),
                "snapshot" => crate::commands::snapshot(),
                "connect-sources" => runtime
                    .block_on(crate::sources::connect_project_sources(
                        super::field(&input, "projectId")?.into(),
                        input["paths"]
                            .as_array()
                            .ok_or("Choose folders")?
                            .iter()
                            .map(|path| {
                                path.as_str()
                                    .map(str::to_owned)
                                    .ok_or_else(|| "Invalid folder".into())
                            })
                            .collect::<crate::db::Result<Vec<_>>>()?,
                        input["sourceId"].as_str().map(str::to_owned),
                    ))
                    .map(|_| json!({})),
                "global-scan" => {
                    let db = crate::db::open()?;
                    let project =
                        crate::governance::project(&db, super::field(&input, "projectId")?)?;
                    let project = crate::sources::select(&project, input["sourceId"].as_str())?;
                    serde_json::to_value(crate::global_skills::scan(&db, &project)?)
                        .map_err(|error| error.to_string())
                }
                "global-add" => {
                    let _lock = crate::projects::lock()?;
                    let db = crate::db::open()?;
                    let project =
                        crate::governance::project(&db, super::field(&input, "projectId")?)?;
                    let project = crate::sources::select(&project, input["sourceId"].as_str())?;
                    crate::global_skills::add(&db, &project, super::field(&input, "skillId")?)
                }
                "global-add-many" => {
                    let ids = input["skillIds"]
                        .as_array()
                        .ok_or("Missing skills")?
                        .iter()
                        .map(|id| {
                            id.as_str()
                                .map(str::to_string)
                                .ok_or_else(|| "Invalid skill".to_string())
                        })
                        .collect::<crate::db::Result<Vec<_>>>()?;
                    crate::global_skills::add_many_when_ready(
                        super::field(&input, "projectId")?,
                        &ids,
                        input["sourceId"].as_str(),
                        std::time::Duration::from_secs(5),
                    )
                }
                "codex-skills" => crate::native::Rpc::connect()?.call(
                    "skills/list",
                    json!({"cwds":[super::field(&input, "path")?],"forceReload":false}),
                ),
                "session-action" => crate::commands::session_action(
                    super::field(&input, "id")?.into(),
                    super::field(&input, "operation")?.into(),
                    None,
                    None,
                )
                .map(|_| json!({})),
                "sync" => runtime.block_on(crate::sync::once()).map(|_| json!({})),
                "logout" => crate::auth::sign_out().map(|_| json!({})),
                "locked" => {
                    LOCKED.store(input["value"] == true, Ordering::SeqCst);
                    Ok(json!({}))
                }
                _ => Err("Unknown test operation".into()),
            }
        })();
        println!(
            "{}",
            match result {
                Ok(value) => json!({"value":value}),
                Err(error) => json!({"error":error}),
            }
        );
        std::io::stdout().flush().expect("Test output");
    }
}
