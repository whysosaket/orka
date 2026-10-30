use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;
pub type Result<T> = std::result::Result<T, String>;
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn digest(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn executable_identity() -> Result<String> {
    let path = std::env::current_exe().map_err(|e| e.to_string())?;
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    let modified = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    Ok(digest(
        format!("{}:{}:{modified}", path.display(), metadata.len()).as_bytes(),
    ))
}
pub fn home() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("ORKA_TEST_HOME") {
        return Ok(p.into());
    }
    dirs::home_dir().ok_or("Home directory unavailable".into())
}
pub fn root() -> Result<PathBuf> {
    crate::profiles::root(crate::profiles::current())
}
pub fn base_root() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("ORKA_TEST_HOME") {
        return Ok(PathBuf::from(p).join("orka"));
    }
    Ok(dirs::data_local_dir()
        .ok_or("Application data unavailable")?
        .join("com.orka.v1"))
}
pub fn daemon_lock() -> Result<fs::File> {
    let root = root()?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("daemon.lock"))
        .map_err(|e| e.to_string())
}
pub fn daemon_running() -> Result<bool> {
    use fs2::FileExt;
    let lock = daemon_lock()?;
    match lock.try_lock_exclusive() {
        Ok(()) => {
            FileExt::unlock(&lock).map_err(|e| e.to_string())?;
            Ok(false)
        }
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}
pub fn profile(id: &str) -> Result<()> {
    Uuid::parse_str(id).map_err(|e| e.to_string())?;
    let r = root()?;
    fs::create_dir_all(&r).map_err(|e| e.to_string())?;
    atomic(&r.join("account"), id.as_bytes())
}
pub fn guest() -> Result<()> {
    let p = root()?.join("account");
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn open() -> Result<Connection> {
    let r = root()?;
    let profile = fs::read_to_string(r.join("account")).unwrap_or("guest".into());
    if profile != "guest" {
        Uuid::parse_str(&profile).map_err(|e| e.to_string())?;
    }
    let config = global_setting("config")?;
    let origin = config["apiUrl"].as_str().unwrap_or("");
    // Bind pre-mode caches to their original service once, before any switch.
    let legacy = r.join("legacy-service.json");
    if !origin.is_empty() && !legacy.exists() {
        fs::create_dir_all(&r).map_err(|e| e.to_string())?;
        atomic(&legacy, json!(origin).to_string().as_bytes())?;
    }
    if profile == "guest" {
        open_at(&r.join(profile))
    } else {
        open_at(&profile_path(&profile, origin)?)
    }
}
pub fn profile_path(id: &str, origin: &str) -> Result<PathBuf> {
    Uuid::parse_str(id).map_err(|e| e.to_string())?;
    let root = root()?;
    let legacy: Value = fs::read(root.join("legacy-service.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    if legacy.as_str() == Some(origin) && root.join(id).is_dir() {
        return Ok(root.join(id));
    }
    Ok(root
        .join("services")
        .join(digest(origin.as_bytes()))
        .join(id))
}
pub fn open_at(root: &Path) -> Result<Connection> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let db = Connection::open(root.join("sync.sqlite")).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,project TEXT NOT NULL,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS bindings(id TEXT PRIMARY KEY,project TEXT NOT NULL,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,project TEXT NOT NULL,path TEXT NOT NULL,value TEXT NOT NULL,error TEXT); CREATE TABLE IF NOT EXISTS cursors(project TEXT PRIMARY KEY,cursor INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS conflicts(id TEXT PRIMARY KEY,project TEXT NOT NULL,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS active(native_id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS errors(source TEXT PRIMARY KEY,error TEXT NOT NULL); CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,project TEXT NOT NULL,value TEXT NOT NULL);").map_err(|e|e.to_string())?;
    Ok(db)
}
fn global_setting(key: &str) -> Result<Value> {
    match fs::read(root()?.join(format!("{key}.json"))) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}
pub fn get(db: &Connection, key: &str) -> Result<Value> {
    if key == "config" || key == "background" {
        return global_setting(key);
    }
    let raw = db.query_row("SELECT value FROM meta WHERE key=?", [key], |r| {
        r.get::<_, String>(0)
    });
    match raw {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}
pub fn set(db: &Connection, key: &str, value: &Value) -> Result<()> {
    if key == "config" || key == "background" {
        let r = root()?;
        fs::create_dir_all(&r).map_err(|e| e.to_string())?;
        return atomic(&r.join(format!("{key}.json")), value.to_string().as_bytes());
    }
    db.execute(
        "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn rows(db: &Connection, sql: &str, values: &[&dyn rusqlite::ToSql]) -> Result<Vec<Value>> {
    let mut q = db.prepare(sql).map_err(|e| e.to_string())?;
    let rows = q
        .query_map(values, |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect()
}
pub fn upsert(db: &Connection, table: &str, id: &str, project: &str, value: &Value) -> Result<()> {
    if !["projects", "resources", "bindings", "conflicts", "drafts"].contains(&table) {
        return Err("Invalid table".into());
    }
    let sql = if table == "projects" {
        // Only the local-name command changes this preference. Preserve it even
        // when a folder operation saves a project read before that command ran.
        format!(
            "INSERT INTO {table} VALUES(?1,?3) ON CONFLICT(id) DO UPDATE SET value=json_set(excluded.value,'$.localName',json_extract(projects.value,'$.localName'))"
        )
    } else {
        format!("INSERT INTO {table} VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
    };
    db.execute(&sql, params![id, project, value.to_string()])
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn device(db: &Connection) -> Result<String> {
    let v = get(db, "device")?;
    if let Some(s) = v.as_str() {
        return Ok(s.into());
    }
    let id = Uuid::new_v4().to_string();
    set(db, "device", &json!(id))?;
    Ok(id)
}
pub fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Missing parent")?;
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Destination is a symlink".into());
    }
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    use std::io::Write;
    staged.write_all(bytes).map_err(|e| e.to_string())?;
    staged.as_file().sync_all().map_err(|e| e.to_string())?;
    staged.persist(path).map_err(|e| e.to_string())?;
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn blob_path(hash: &str) -> Result<PathBuf> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid hash".into());
    }
    let root = root()?;
    let config = global_setting("config")?;
    let origin = config["apiUrl"].as_str().unwrap_or("");
    let legacy: Value = fs::read(root.join("legacy-service.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    let dir = if origin.is_empty() || legacy.as_str() == Some(origin) {
        root.join("blobs")
    } else {
        root.join("services")
            .join(digest(origin.as_bytes()))
            .join("blobs")
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(hash))
}
pub fn blob(bytes: &[u8]) -> Result<String> {
    let h = digest(bytes);
    let p = blob_path(&h)?;
    if !fs::read(&p).is_ok_and(|cached| digest(&cached) == h) {
        atomic(&p, bytes)?;
    }
    Ok(h)
}
pub fn blob_read(hash: &str) -> Result<Vec<u8>> {
    let b = fs::read(blob_path(hash)?).map_err(|e| e.to_string())?;
    if digest(&b) != hash {
        return Err("Blob hash mismatch".into());
    }
    Ok(b)
}
pub fn validate_url(raw: &str) -> Result<reqwest::Url> {
    let u = reqwest::Url::parse(raw).map_err(|e| e.to_string())?;
    if u.scheme() != "https"
        && !(u.scheme() == "http" && matches!(u.host_str(), Some("127.0.0.1" | "localhost")))
    {
        return Err("Use HTTPS; localhost HTTP is allowed for development".into());
    }
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("Invalid service URL".into());
    }
    Ok(u)
}
