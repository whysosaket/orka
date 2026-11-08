//! Account details for onboarding. Photos are bounded PNG data, never file paths.
use crate::{
    auth,
    db::{self, Result},
    sync,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

fn valid_avatar_url(raw: &str) -> bool {
    reqwest::Url::parse(raw).is_ok_and(|u| {
        u.scheme() == "https"
            && u.host_str() == Some("avatars.githubusercontent.com")
            && u.username().is_empty()
            && u.password().is_none()
            && u.port().is_none()
    })
}
fn valid_avatar_data(raw: &str) -> bool {
    let Some(encoded) = raw.strip_prefix("data:image/png;base64,") else {
        return false;
    };
    if encoded.len() > 700_000 {
        return false;
    }
    let Ok(bytes) = STANDARD.decode(encoded) else {
        return false;
    };
    if bytes.len() < 33
        || bytes.len() > 524_288
        || STANDARD.encode(&bytes) != encoded
        || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
        || bytes[8..12] != 13u32.to_be_bytes()
        || &bytes[12..16] != b"IHDR"
    {
        return false;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 || width > 512 || height > 512 {
        return false;
    }
    #[cfg(target_os = "macos")]
    return objc2::rc::autoreleasepool(|_| {
        use objc2_app_kit::NSBitmapImageRep;
        use objc2_foundation::NSData;
        NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(&bytes)).is_some_and(|image| {
            image.pixelsWide() == width as isize
                && image.pixelsHigh() == height as isize
                && !image.bitmapData().is_null()
        })
    });
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}
fn validate(input: &Value) -> Result<Value> {
    let name = input["displayName"].as_str().unwrap_or("").trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("Enter a name of up to 80 characters".into());
    }
    let role = input["jobRole"].as_str().unwrap_or("").trim();
    if role.chars().count() > 80 {
        return Err("Choose a role of up to 80 characters".into());
    }
    if input["avatarUrl"]
        .as_str()
        .is_some_and(|v| !valid_avatar_url(v))
    {
        return Err("Choose your GitHub photo or upload a photo".into());
    }
    if input["avatarData"]
        .as_str()
        .is_some_and(|v| !valid_avatar_data(v))
    {
        return Err("Choose a PNG photo up to 512 by 512 pixels".into());
    }
    Ok(
        json!({"displayName":name,"jobRole":if role.is_empty(){Value::Null}else{json!(role)},"avatarUrl":input["avatarUrl"],"avatarData":input["avatarData"],"source":"user"}),
    )
}
async fn capabilities() -> Result<Value> {
    let config = db::get(&db::open()?, "config")?;
    auth::capabilities(config["apiUrl"].as_str().ok_or("Sign in first")?.into()).await
}
fn same_account(owner: &Value, service: &Value) -> Result<()> {
    let db = db::open()?;
    if db::get(&db, "user")? != *owner || db::get(&db, "config")?["apiUrl"] != *service {
        return Err("Account or service changed. Reopen profile setup.".into());
    }
    Ok(())
}
async fn github_preview(url: &str) -> Result<String> {
    if !valid_avatar_url(url) {
        return Err("Invalid photo address".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Could not load your GitHub photo")?;
    if !response.status().is_success() {
        return Err("Could not load your GitHub photo".into());
    }
    let mime = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_string();
    if !["image/png", "image/jpeg", "image/webp"].contains(&mime.as_str())
        || response.content_length().is_some_and(|n| n > 1_048_576)
    {
        return Err("Unsupported photo".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not load your photo")?
    {
        if bytes.len() + chunk.len() > 1_048_576 {
            return Err("Photo is too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}
pub async fn load() -> Result<Value> {
    let db = db::open()?;
    let owner = db::get(&db, "user")?;
    let service = db::get(&db, "config")?["apiUrl"].clone();
    if !owner.is_string() {
        return Err("Sign in first".into());
    }
    let mut profile = db::get(&db, "accountProfile")?;
    if !profile["displayName"].is_string() {
        let session = auth::session()?;
        let user = &session["user"];
        let metadata = &user["user_metadata"];
        let email = user["email"].as_str().unwrap_or("");
        let name = metadata["full_name"]
            .as_str()
            .or(metadata["name"].as_str())
            .or(metadata["user_name"].as_str())
            .unwrap_or_else(|| email.split('@').next().unwrap_or(""));
        let github = metadata["avatar_url"]
            .as_str()
            .filter(|url| valid_avatar_url(url));
        profile = json!({"displayName":name.chars().take(80).collect::<String>(),"jobRole":null,"avatarUrl":github,"avatarData":null,"email":email,"supported":false,"pending":false,"source":if github.is_some(){"github"}else{"email"}});
        db::set(&db, "accountProfile", &profile)?;
    }
    match capabilities().await {
        Ok(caps) => {
            profile["supported"] = json!(caps["onboarding"] == 1);
            profile["detailsSupported"] =
                json!(caps["profile"]["version"] == 2 && caps["profile"]["conditionalSave"] == 1);
            profile["offline"] = json!(false);
            if profile["supported"] == true && profile["pending"] != true {
                let input = json!({"displayName":profile["displayName"],"avatarUrl":profile["avatarUrl"],"source":profile["source"],"ifAbsent":true});
                sync::api("PUT", "/v2/profile", Some(&input)).await?;
                let saved = sync::api("GET", "/v2/profile", None).await?;
                for key in [
                    "displayName",
                    "jobRole",
                    "avatarUrl",
                    "avatarData",
                    "source",
                    "revision",
                ] {
                    profile[key] = saved[key].clone();
                }
            }
        }
        Err(_) => profile["offline"] = json!(true),
    }
    if profile["avatarPreview"].is_null() {
        if let Some(url) = profile["avatarUrl"].as_str() {
            if let Ok(data) = github_preview(url).await {
                profile["avatarPreview"] = json!(data);
            }
        }
    }
    same_account(&owner, &service)?;
    db::set(&db::open()?, "accountProfile", &profile)?;
    Ok(profile)
}
pub async fn save(input: Value) -> Result<Value> {
    save_with_confirmation(input, false).await
}
pub async fn save_confirmed(input: Value) -> Result<Value> {
    save_with_confirmation(input, true).await
}
async fn save_with_confirmation(input: Value, require_confirmation: bool) -> Result<Value> {
    let mut data = validate(&input)?;
    let db = db::open()?;
    let owner = db::get(&db, "user")?;
    let service = db::get(&db, "config")?["apiUrl"].clone();
    if !owner.is_string() {
        return Err("Sign in first".into());
    }
    let old = db::get(&db, "accountProfile")?;
    let mut profile = data.clone();
    profile["email"] = old["email"].clone();
    profile["avatarPreview"] = if profile["avatarUrl"] == old["avatarUrl"] {
        old["avatarPreview"].clone()
    } else {
        Value::Null
    };
    let caps = capabilities().await?;
    let supported = caps["onboarding"] == 1 && caps["profile"]["version"] == 2;
    if require_confirmation && (!supported || caps["profile"]["conditionalSave"] != 1) {
        return Err(
            "This service does not support profile edits yet. Your changes have not been saved."
                .into(),
        );
    }
    if require_confirmation {
        let revision = input["expectedRevision"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 64)
            .ok_or("Reload your profile before saving.")?;
        data["expectedRevision"] = json!(revision);
    }
    if supported {
        let saved = sync::api("PUT", "/v2/profile", Some(&data)).await?;
        profile["revision"] = saved["revision"].clone();
    }
    profile["supported"] = json!(caps["onboarding"] == 1);
    profile["detailsSupported"] = json!(supported);
    profile["pending"] = json!(!supported);
    same_account(&owner, &service)?;
    db::set(&db::open()?, "accountProfile", &profile)?;
    Ok(profile)
}
pub async fn flush_pending() -> Result<()> {
    let profile = db::get(&db::open()?, "accountProfile")?;
    if profile["pending"] != true {
        return Ok(());
    }
    let caps = capabilities().await?;
    if caps["onboarding"] == 1 && caps["profile"]["version"] == 2 {
        save(profile).await?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_input_is_bounded_and_roles_are_not_permissions() {
        let photo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=";
        assert!(valid_avatar_data(photo));
        assert!(!valid_avatar_data("data:image/svg+xml;base64,PHN2Zy8+"));
        assert!(!valid_avatar_url(
            "https://avatars.githubusercontent.com.evil.test/a"
        ));
        assert!(!valid_avatar_url(
            "https://user@avatars.githubusercontent.com/a"
        ));
        let data = validate(&json!({"displayName":" Alex ","jobRole":" Designer ","role":"owner","avatarData":photo})).unwrap();
        assert_eq!(data["displayName"], "Alex");
        assert_eq!(data["jobRole"], "Designer");
        assert!(data.get("role").is_none());
        assert!(validate(&json!({"displayName":" "})).is_err());
    }
}
