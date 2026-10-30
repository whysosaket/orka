use crate::db::{self, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::TryRng;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{LazyLock, Mutex};
const REDIRECT: &str = "orka://auth/callback";
struct UnsavedSession {
    value: Value,
    config: Value,
    expires_at: i64,
}
// An exchanged code cannot be exchanged twice. Hold a failed save only in this
// process, never in a draft, log, or local file, while Keychain access is retried.
static UNSAVED: LazyLock<Mutex<Option<UnsavedSession>>> = LazyLock::new(|| Mutex::new(None));
fn keychain_error(error: keyring::Error) -> String {
    format!("Keychain unavailable: {error}")
}
fn credential(name: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(&crate::profiles::credential_service()?, name).map_err(keychain_error)
}
fn entry() -> Result<keyring::Entry> {
    credential("supabase-session")
}
fn remove(name: &str) -> Result<()> {
    match credential(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(keychain_error(e)),
    }
}
#[cfg(debug_assertions)]
pub fn test_session(value: &Value) -> Result<()> {
    if std::env::var_os("ORKA_TEST_HOME").is_none() {
        return Err("Isolated test home required".into());
    }
    save(value, &db::get(&db::open()?, "config")?)
}
pub fn session() -> Result<Value> {
    let raw = entry()?.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => "Sign in required".into(),
        other => format!("Cannot read Orka's Keychain session: {other}"),
    })?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}
fn save(value: &Value, config: &Value) -> Result<()> {
    if db::get(&db::open()?, "config")?["apiUrl"] != config["apiUrl"] {
        return Err("Service changed; sign in again".into());
    }
    let mut value = value.clone();
    value["apiUrl"] = config["apiUrl"].clone();
    if !value["expires_at"].is_number() {
        value["expires_at"] =
            json!(chrono::Utc::now().timestamp() + value["expires_in"].as_i64().unwrap_or(3600));
    }
    let id = value["user"]["id"]
        .as_str()
        .ok_or("Missing signed-in identity")?;
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid signed-in identity")?;
    if value["access_token"].as_str().is_none() || value["refresh_token"].as_str().is_none() {
        return Err("Missing sign-in session".into());
    }
    // Provider tokens are not needed by Orka; never retain GitHub API credentials.
    if let Some(object) = value.as_object_mut() {
        object.remove("provider_token");
        object.remove("provider_refresh_token");
    }
    entry()?
        .set_password(&value.to_string())
        .map_err(keychain_error)?;
    db::profile(value["user"]["id"].as_str().unwrap())?;
    db::set(&db::open()?, "user", &value["user"]["id"])
}
fn save_or_hold(value: &Value, config: &Value) -> Result<()> {
    let mut value = value.clone();
    if !value["expires_at"].is_number() {
        value["expires_at"] =
            json!(chrono::Utc::now().timestamp() + value["expires_in"].as_i64().unwrap_or(3600));
    }
    match save(&value, config) {
        Ok(()) => {
            *UNSAVED.lock().map_err(|_| "Sign-in recovery unavailable")? = None;
            Ok(())
        }
        Err(error) => {
            if let Some(object) = value.as_object_mut() {
                object.remove("provider_token");
                object.remove("provider_refresh_token");
            }
            *UNSAVED.lock().map_err(|_| "Sign-in recovery unavailable")? = Some(UnsavedSession {
                value,
                config: config.clone(),
                expires_at: chrono::Utc::now().timestamp() + 600,
            });
            Err(error)
        }
    }
}
pub fn retry_storage() -> Result<Value> {
    let _lock = crate::projects::lock()?;
    let mut pending = UNSAVED.lock().map_err(|_| "Sign-in recovery unavailable")?;
    let Some(saved) = pending.as_ref() else {
        return Ok(json!({"signedIn":false}));
    };
    if saved.expires_at < chrono::Utc::now().timestamp()
        || saved.config["apiUrl"] != db::get(&db::open()?, "config")?["apiUrl"]
    {
        *pending = None;
        return Err("Sign-in expired or the service changed. Start sign-in again.".into());
    }
    save(&saved.value, &saved.config)?;
    *pending = None;
    drop(pending);
    cancel()?;
    Ok(json!({"signedIn":true}))
}
fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}
pub async fn request(config: &Value, method: &str, path: &str, body: Value) -> Result<Value> {
    let base = config["apiUrl"]
        .as_str()
        .ok_or("Configure the service first")?;
    db::validate_url(base)?;
    let response = client()?
        .request(
            method
                .parse::<reqwest::Method>()
                .map_err(|e| e.to_string())?,
            format!("{}/auth{}", base.trim_end_matches('/'), path),
        )
        .json(&body)
        .send()
        .await
        .map_err(|_| "Cannot reach the sign-in service")?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Invalid response from sign-in service")?;
    if !status.is_success() {
        return Err(value["msg"]
            .as_str()
            .or(value["error_description"].as_str())
            .or(value["error"].as_str())
            .unwrap_or("Sign-in failed")
            .into());
    }
    Ok(value)
}
pub async fn sign_in(email: String, password: String) -> Result<Value> {
    let _lock = crate::projects::lock()?;
    *UNSAVED.lock().map_err(|_| "Sign-in recovery unavailable")? = None;
    let config = db::get(&db::open()?, "config")?;
    let value = request(
        &config,
        "POST",
        "/token?grant_type=password",
        json!({"email":email.trim(),"password":password}),
    )
    .await?;
    save_or_hold(&value, &config)?;
    cancel()?;
    Ok(json!({"signedIn":true}))
}
pub async fn capabilities(api_url: String) -> Result<Value> {
    let url = db::validate_url(&api_url)?;
    let response = client()?
        .get(format!(
            "{}/v2/instance",
            url.as_str().trim_end_matches('/')
        ))
        .send()
        .await
        .map_err(|_| "Cannot reach this service. Check the URL and connection.")?;
    // Existing deployments remain usable while their API is upgraded.
    if matches!(response.status().as_u16(), 401 | 404) {
        return Ok(json!({"version":0,"auth":{"password":true,"github":false,"magicLink":false}}));
    }
    if !response.status().is_success() {
        return Err("Service is unavailable".into());
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| "Invalid service response")?;
    if value["version"] != 1 || !value["auth"].is_object() {
        return Err("This URL is not an Orka service".into());
    }
    Ok(value)
}
fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::SysRng
        .try_fill_bytes(&mut bytes)
        .expect("OS randomness is required for sign-in");
    URL_SAFE_NO_PAD.encode(bytes)
}
fn pending() -> Result<Value> {
    let raw = credential("pending-pkce")?
        .get_password()
        .map_err(|e| match e {
            keyring::Error::NoEntry => "Start sign-in on this Mac first".into(),
            other => keychain_error(other),
        })?;
    let pending: Value = serde_json::from_str(&raw).map_err(|_| "Invalid pending sign-in")?;
    if pending["expiresAt"].as_i64().unwrap_or(0) < chrono::Utc::now().timestamp() {
        cancel()?;
        return Err("Sign-in expired. Request a new link".into());
    }
    if pending["apiUrl"] != db::get(&db::open()?, "config")?["apiUrl"] {
        return Err("Service changed. Start sign-in again".into());
    }
    if pending["requestId"] != db::get(&db::open()?, "authRequestId")? {
        return Err("Start sign-in on this Mac first".into());
    }
    Ok(pending)
}
pub fn cancel() -> Result<()> {
    *UNSAVED.lock().map_err(|_| "Sign-in recovery unavailable")? = None;
    // Invalidate the request locally even if a locked Keychain cannot delete it.
    db::set(
        &db::open()?,
        "authRequestId",
        &json!(uuid::Uuid::new_v4().to_string()),
    )?;
    if let Err(error) = remove("pending-pkce") {
        if !error.starts_with("Keychain unavailable:") {
            return Err(error);
        }
    }
    let path = db::root()?.join("auth-callback.json");
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
pub async fn begin(method: String, email: Option<String>) -> Result<Value> {
    let _lock = crate::projects::lock()?;
    *UNSAVED.lock().map_err(|_| "Sign-in recovery unavailable")? = None;
    let config = db::get(&db::open()?, "config")?;
    let base = config["apiUrl"]
        .as_str()
        .ok_or("Configure the service first")?;
    db::validate_url(base)?;
    if !["github", "magic-link"].contains(&method.as_str()) {
        return Err("Unknown sign-in method".into());
    }
    if crate::profiles::current() != "default"
        && capabilities(base.into()).await?["auth"]["profileRedirect"] != true
    {
        return Err(
            "Upgrade this service to enable browser sign-in in this window, or use a password"
                .into(),
        );
    }
    let email = email.unwrap_or_default().trim().to_string();
    if method == "magic-link" && (email.len() > 254 || !email.contains('@')) {
        return Err("Enter a valid email address".into());
    }
    let verifier = random_secret();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let redirect = if crate::profiles::current() == "default" {
        REDIRECT.into()
    } else {
        format!("{REDIRECT}?profile={}", crate::profiles::current())
    };
    let value = json!({"apiUrl":base,"verifier":verifier,"email":email,"method":method,"expiresAt":chrono::Utc::now().timestamp()+600,"requestId":uuid::Uuid::new_v4().to_string()});
    credential("pending-pkce")?
        .set_password(&value.to_string())
        .map_err(keychain_error)?;
    db::set(&db::open()?, "authRequestId", &value["requestId"])?;
    if method == "github" {
        let mut url =
            reqwest::Url::parse(&format!("{base}/auth/authorize")).map_err(|e| e.to_string())?;
        url.query_pairs_mut().extend_pairs([
            ("provider", "github"),
            ("redirect_to", &redirect),
            ("code_challenge_method", "s256"),
            ("code_challenge", &challenge),
        ]);
        let opened = std::process::Command::new("/usr/bin/open")
            .arg(url.as_str())
            .status()
            .map_err(|e| e.to_string())?;
        if !opened.success() {
            cancel()?;
            return Err("Could not open the browser".into());
        }
    } else {
        let url = reqwest::Url::parse_with_params(
            &format!("{base}/auth/otp"),
            [("redirect_to", &redirect)],
        )
        .map_err(|e| e.to_string())?;
        let path = format!("/otp?{}", url.query().unwrap_or(""));
        if let Err(error) = request(&config, "POST", &path, json!({"email":email,"create_user":true,"code_challenge":challenge,"code_challenge_method":"s256"})).await {
            cancel()?;
            return Err(error);
        }
    }
    Ok(json!({"pending":true}))
}
pub fn callback_profile(raw: &str) -> Result<String> {
    if raw.len() > 8192 {
        return Err("Invalid sign-in callback".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid sign-in callback")?;
    if url.scheme() != "orka"
        || url.host_str() != Some("auth")
        || url.path() != "/callback"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid sign-in callback".into());
    }
    let names: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key == "profile")
        .map(|(_, value)| value.into_owned())
        .collect();
    if names.len() > 1 {
        return Err("Invalid sign-in callback".into());
    }
    let name = names.first().map(String::as_str).unwrap_or("default");
    crate::profiles::validate(name)?;
    Ok(name.into())
}
fn callback_code(raw: &str) -> Result<String> {
    if callback_profile(raw)? != crate::profiles::current() {
        return Err("Open this sign-in link in the window that requested it".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid sign-in callback")?;
    if url
        .query_pairs()
        .any(|(key, _)| key == "error" || key == "error_code")
    {
        return Err("Sign-in was declined or the link expired. Try again".into());
    }
    let codes: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key == "code")
        .map(|(_, value)| value.into_owned())
        .collect();
    if codes.len() != 1 || uuid::Uuid::parse_str(&codes[0]).is_err() {
        return Err("Invalid sign-in code".into());
    }
    Ok(codes[0].clone())
}
pub async fn complete(callback: Option<String>, code: Option<String>) -> Result<Value> {
    let _lock = crate::projects::lock()?;
    let pending = pending()?;
    let config = db::get(&db::open()?, "config")?;
    let value = if let Some(callback) = callback {
        let code = callback_code(&callback)?;
        request(
            &config,
            "POST",
            "/token?grant_type=pkce",
            json!({"auth_code":code,"code_verifier":pending["verifier"]}),
        )
        .await?
    } else {
        let code = code.unwrap_or_default();
        if pending["method"] != "magic-link"
            || !(6..=10).contains(&code.len())
            || !code.bytes().all(|c| c.is_ascii_digit())
        {
            return Err("Enter the code from your sign-in email".into());
        }
        request(
            &config,
            "POST",
            "/verify",
            json!({"email":pending["email"],"token":code,"type":"email"}),
        )
        .await?
    };
    save_or_hold(&value, &config)?;
    cancel()?;
    Ok(json!({"signedIn":true}))
}
pub async fn token_for_service(owner: &str, base: &str) -> Result<String> {
    let value = session()?;
    let config = db::get(&db::open()?, "config")?;
    // Old sessions are bound to the legacy origin on first upgrade.
    let bound = value["apiUrl"]
        .as_str()
        .unwrap_or_else(|| config["apiUrl"].as_str().unwrap_or(""));
    if value["user"]["id"] != owner || bound != base || config["apiUrl"] != base {
        return Err("Account or service changed; sync will restart with its own cache".into());
    }
    if value["expires_at"].as_i64().unwrap_or(0) > chrono::Utc::now().timestamp() + 60 {
        return value["access_token"]
            .as_str()
            .map(str::to_string)
            .ok_or("Session is invalid".into());
    }
    let refreshed = request(
        &config,
        "POST",
        "/token?grant_type=refresh_token",
        json!({"refresh_token":value["refresh_token"]}),
    )
    .await?;
    if session()?["refresh_token"] != value["refresh_token"] {
        return Err("Account changed during refresh".into());
    }
    save(&refreshed, &config)?;
    refreshed["access_token"]
        .as_str()
        .map(str::to_string)
        .ok_or("Session is invalid".into())
}
pub fn sign_out() -> Result<()> {
    crate::env::clear();
    cancel()?;
    remove("supabase-session")?;
    db::guest()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_code_callbacks() {
        let code = uuid::Uuid::new_v4();
        assert_eq!(
            callback_code(&format!("orka://auth/callback?code={code}")).unwrap(),
            code.to_string()
        );
        assert_eq!(
            callback_profile(&format!("orka://auth/callback?profile=alice&code={code}")).unwrap(),
            "alice"
        );
        assert!(callback_code(&format!("orka://auth/callback?profile=alice&code={code}")).is_err());
        for url in [
            "https://auth/callback?code=x",
            "orka://auth/other?code=x",
            "orka://auth/callback#access_token=x",
            "orka://auth/callback?error=denied",
            "orka://auth/callback?code=x&code=y",
            "orka://auth/callback?profile=../default&code=x",
            "orka://auth/callback?profile=alice&profile=bob&code=x",
        ] {
            assert!(callback_code(url).is_err());
        }
    }
    #[test]
    fn pkce_secrets_are_unpredictable_and_url_safe() {
        let a = random_secret();
        assert_eq!(a.len(), 43);
        assert_ne!(a, random_secret());
        assert!(a
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
    }
}
