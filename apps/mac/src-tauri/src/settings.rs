use crate::{
    db::{self, Result},
    sync,
};
use serde_json::Value;

#[tauri::command]
pub async fn settings_command(action: String, context: Value) -> Result<Value> {
    let db = db::open()?;
    let owner = db::get(&db, "user")?;
    let service = db::get(&db, "config")?["apiUrl"].clone();
    if context["user"] != owner || context["service"] != service {
        return Err("Account or service changed. Reopen Settings.".into());
    }
    let path = match action.as_str() {
        "capabilities" => "/v2/projects/capabilities",
        "devices" => "/v2/devices",
        _ => return Err("Unknown Settings action".into()),
    };
    let mut result =
        sync::api_as(owner.as_str().ok_or("Sign in first")?, "GET", path, None).await?;
    let current = db::open()?;
    if db::get(&current, "user")? != owner || db::get(&current, "config")?["apiUrl"] != service {
        return Err("Account or service changed. Reopen Settings.".into());
    }
    if action == "devices" {
        result = crate::device_metadata::update_devices(&current, &result)?;
    }
    Ok(result)
}
