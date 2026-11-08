use crate::db::{self, Result};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::Read,
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

const RETRY_AFTER: Duration = Duration::from_secs(30);
const PROBE_BUDGET: Duration = Duration::from_secs(3);
const MAX_OUTPUT: u64 = 64_000;

fn known(value: &str) -> Option<&'static str> {
    match value {
        "laptop" => Some("laptop"),
        "all-in-one" => Some("all-in-one"),
        "mac-mini" => Some("mac-mini"),
        "mac-studio" => Some("mac-studio"),
        "mac-pro" => Some("mac-pro"),
        _ => None,
    }
}

/// Use only hardware model names/identifiers, never an editable ComputerName.
/// Opaque Apple Silicon MacNN,N identifiers need system_profiler's model name.
fn family(model: &str) -> Option<&'static str> {
    let model = match model.trim().split_once('(') {
        Some((name, detail)) if detail.ends_with(')') => name.trim(),
        Some(_) => return None,
        None => model.trim(),
    };
    let model = model.to_ascii_lowercase().replace(' ', "");
    for (prefix, family) in [
        ("macbookair", "laptop"),
        ("macbookpro", "laptop"),
        ("macbook", "laptop"),
        ("imacpro", "all-in-one"),
        ("imac", "all-in-one"),
        ("macmini", "mac-mini"),
        ("macstudio", "mac-studio"),
        ("macpro", "mac-pro"),
    ] {
        if let Some(suffix) = model.strip_prefix(prefix) {
            if suffix.is_empty()
                || (suffix.as_bytes().first().is_some_and(u8::is_ascii_digit)
                    && suffix.bytes().all(|c| c.is_ascii_digit() || c == b','))
            {
                return Some(family);
            }
        }
    }
    None
}

fn profiler_family(bytes: &[u8]) -> Option<&'static str> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let hardware = value.get("SPHardwareDataType")?.as_array()?.first()?;
    ["machine_name", "machine_model"]
        .iter()
        .filter_map(|key| hardware.get(key)?.as_str())
        .find_map(family)
}

/// Nonblocking reads keep the deadline effective even if a descendant holds
/// stdout open. A private process group lets timeout cleanup stop the probe and
/// its children without touching the app's other work.
#[cfg(unix)]
fn output(mut command: Command, deadline: Instant) -> Option<Vec<u8>> {
    use std::os::{fd::AsRawFd, unix::process::CommandExt};
    if Instant::now() >= deadline {
        return None;
    }
    let mut child = command
        .process_group(0)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stop = |child: &mut std::process::Child| {
        // The child was spawned as leader of its own process group above.
        let group = child.id() as libc::pid_t;
        if group > 1 {
            unsafe {
                libc::kill(-group, libc::SIGKILL);
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    };
    let Some(mut stdout) = child.stdout.take() else {
        stop(&mut child);
        return None;
    };
    let fd = stdout.as_raw_fd();
    // The owned pipe is valid for this scope. Preserve its existing flags.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        stop(&mut child);
        return None;
    }
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    let mut eof = false;
    loop {
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => {
                    eof = true;
                    break;
                }
                Ok(count) if bytes.len() + count <= MAX_OUTPUT as usize => {
                    bytes.extend_from_slice(&buffer[..count])
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                _ => {
                    stop(&mut child);
                    return None;
                }
            }
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() && eof => return Some(bytes),
            Ok(Some(status)) if !status.success() => {
                stop(&mut child);
                return None;
            }
            Err(_) => {
                stop(&mut child);
                return None;
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            stop(&mut child);
            return None;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn detect() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        let deadline = Instant::now() + PROBE_BUDGET;
        let mut sysctl = Command::new("/usr/sbin/sysctl");
        sysctl.args(["-n", "hw.model"]);
        if let Some(found) = output(sysctl, Instant::now() + Duration::from_millis(250))
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .and_then(|model| family(model.trim()))
        {
            return Some(found);
        }
        let mut profiler = Command::new("/usr/sbin/system_profiler");
        profiler
            .args(["SPHardwareDataType", "-json", "-detailLevel", "mini"])
            .env("LANG", "C")
            .env("LC_ALL", "C");
        output(profiler, deadline).and_then(|bytes| profiler_family(&bytes))
    }
    #[cfg(not(target_os = "macos"))]
    None
}

#[derive(Default)]
struct HardwareCache {
    family: Option<&'static str>,
    attempted: Option<Instant>,
}
impl HardwareCache {
    fn get(&mut self, now: Instant, detect: impl FnOnce() -> Option<&'static str>) -> &'static str {
        if let Some(family) = self.family {
            return family;
        }
        if self
            .attempted
            .is_none_or(|at| now.duration_since(at) >= RETRY_AFTER)
        {
            self.attempted = Some(now);
            self.family = detect().and_then(known);
        }
        self.family.unwrap_or("generic")
    }
}

pub fn hardware_family() -> &'static str {
    static CACHE: OnceLock<Mutex<HardwareCache>> = OnceLock::new();
    CACHE
        .get_or_init(|| Mutex::new(HardwareCache::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(Instant::now(), detect)
}

fn remember_local(db: &Connection, detected: &str) -> Result<&'static str> {
    let previous = db::get(db, "localHardwareFamily")?;
    let detected = known(detected);
    if let Some(family) = detected {
        if previous.as_str() != Some(family) {
            db::set(db, "localHardwareFamily", &json!(family))?;
        }
    }
    Ok(detected
        .or_else(|| previous.as_str().and_then(known))
        .unwrap_or("generic"))
}

/// Never erase positively identified local hardware after a process restart.
pub fn local_family(db: &Connection) -> Result<&'static str> {
    remember_local(db, hardware_family())
}

fn merge(reported: &Value, previous: &Value, device: &str, local: &str) -> Value {
    let mut result = reported.clone();
    let Some(rows) = result.as_array_mut() else {
        return result;
    };
    let previous: HashMap<_, _> = previous
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| Some((row["id"].as_str()?, known(row["hardwareFamily"].as_str()?)?)))
        .collect();
    for row in rows {
        let id = row["id"].as_str().unwrap_or("");
        let family = (id == device)
            .then(|| known(local))
            .flatten()
            .or_else(|| row["hardwareFamily"].as_str().and_then(known))
            .or_else(|| previous.get(id).copied())
            .unwrap_or("generic");
        if let Some(row) = row.as_object_mut() {
            row.insert("hardwareFamily".into(), json!(family));
        }
    }
    result
}

/// Retain only actual registered rows. This Mac can use local hardware with an
/// older service; remote rows use only their own reported/previous metadata.
pub fn devices(db: &Connection, reported: &Value) -> Result<Value> {
    Ok(merge(
        reported,
        &db::get(db, "devices")?,
        &db::device(db)?,
        local_family(db)?,
    ))
}

pub fn update_devices(db: &Connection, reported: &Value) -> Result<Value> {
    if !reported.is_array() {
        return Err("The service returned an invalid device list. Try again.".into());
    }
    let result = devices(db, reported)?;
    db::set(db, "devices", &result)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_mac_families_use_hardware_names_and_identifiers() {
        for (model, expected) in [
            ("MacBook", "laptop"),
            ("MacBook Air", "laptop"),
            ("MacBook Pro", "laptop"),
            ("MacBookAir10,1", "laptop"),
            ("MacBookPro18,3", "laptop"),
            ("iMac", "all-in-one"),
            ("iMac Pro", "all-in-one"),
            ("iMacPro1,1", "all-in-one"),
            ("Mac mini", "mac-mini"),
            ("Macmini9,1", "mac-mini"),
            ("Mac Studio", "mac-studio"),
            ("MacStudio1,1", "mac-studio"),
            ("Mac Pro", "mac-pro"),
            ("Mac Pro (Rack)", "mac-pro"),
            ("Mac Pro (Cylinder)", "mac-pro"),
            ("Mac Pro (Tower)", "mac-pro"),
            ("MacPro6,1", "mac-pro"),
            ("MacPro7,1", "mac-pro"),
        ] {
            assert_eq!(family(model), Some(expected), "{model}");
        }
        for model in [
            "",
            "Mac14,7",
            "Mac999,99",
            "MacBookish",
            "MacProse",
            "Pratham’s MacBook Pro",
        ] {
            assert_eq!(family(model), None, "{model}");
        }
    }
    #[test]
    fn profiler_ignores_editable_names_and_handles_bad_or_missing_fields() {
        for (name, model, expected) in [
            ("MacBook Air", "Mac14,2", "laptop"),
            ("MacBook Pro", "Mac15,9", "laptop"),
            ("iMac", "Mac15,4", "all-in-one"),
            ("iMac Pro", "iMacPro1,1", "all-in-one"),
            ("Mac mini", "Mac14,3", "mac-mini"),
            ("Mac Studio", "Mac14,13", "mac-studio"),
            ("Mac Pro", "MacPro6,1", "mac-pro"),
            ("Mac Pro", "MacPro7,1", "mac-pro"),
            ("Mac Pro", "Mac14,8", "mac-pro"),
            ("", "Macmini8,1", "mac-mini"),
        ] {
            let value = json!({"SPHardwareDataType":[{"machine_name":name,"machine_model":model,"computer_name":"Misleading MacBook Air"}]});
            assert_eq!(
                profiler_family(value.to_string().as_bytes()),
                Some(expected)
            );
        }
        for value in [
            json!({}),
            json!({"SPHardwareDataType":[]}),
            json!({"SPHardwareDataType":{}}),
            json!({"SPHardwareDataType":[{"machine_name":42,"machine_model":null,"computer_name":"Mac Studio"}]}),
            json!({"SPHardwareDataType":[{"machine_name":"Unknown","machine_model":"Mac999,99"}]}),
        ] {
            assert_eq!(profiler_family(value.to_string().as_bytes()), None);
        }
        assert_eq!(profiler_family(b"malformed"), None);
    }
    #[test]
    fn failed_detection_retries_then_preserves_positive_cached_metadata() {
        let mut cache = HardwareCache::default();
        let now = Instant::now();
        assert_eq!(cache.get(now, || None), "generic");
        assert_eq!(
            cache.get(now + Duration::from_secs(1), || panic!("cooldown")),
            "generic"
        );
        assert_eq!(
            cache.get(now + RETRY_AFTER, || Some("mac-studio")),
            "mac-studio"
        );
        assert_eq!(
            cache.get(now + RETRY_AFTER * 2, || panic!(
                "known hardware stays cached"
            )),
            "mac-studio"
        );
    }
    #[test]
    fn persisted_local_family_survives_detection_failure_and_invalid_values() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
            .unwrap();
        assert_eq!(remember_local(&db, "generic").unwrap(), "generic");
        assert_eq!(remember_local(&db, "mac-mini").unwrap(), "mac-mini");
        assert_eq!(remember_local(&db, "generic").unwrap(), "mac-mini");
        assert_eq!(remember_local(&db, "invalid").unwrap(), "mac-mini");
        assert_eq!(db::get(&db, "localHardwareFamily").unwrap(), "mac-mini");
    }
    #[test]
    fn local_and_remote_rows_keep_their_own_metadata_without_fabricating_devices() {
        let previous = json!([{"id":"remote","hardwareFamily":"mac-pro"}]);
        let reported = json!([{"id":"this","name":"Office"},
            {"id":"remote","name":"MacBook Air","hardwareFamily":"generic"},
            {"id":"unknown","name":"Mac Studio"}]);
        let rows = merge(&reported, &previous, "this", "laptop");
        assert_eq!(rows[0]["hardwareFamily"], "laptop");
        assert_eq!(rows[1]["hardwareFamily"], "mac-pro");
        assert_eq!(rows[2]["hardwareFamily"], "generic");
        let updated = merge(
            &json!([{"id":"remote","hardwareFamily":"mac-studio"}]),
            &rows,
            "this",
            "laptop",
        );
        assert_eq!(updated[0]["hardwareFamily"], "mac-studio");
        assert_eq!(updated.as_array().unwrap().len(), 1);
        assert_eq!(merge(&json!([]), &rows, "this", "laptop"), json!([]));
        assert_eq!(merge(&Value::Null, &rows, "this", "laptop"), Value::Null);
    }

    #[test]
    fn malformed_device_refresh_does_not_replace_the_known_list() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
            .unwrap();
        let previous = json!([{"id":"remote","hardwareFamily":"mac-pro"}]);
        db::set(&db, "devices", &previous).unwrap();
        assert!(update_devices(&db, &json!({"error":"Unavailable"})).is_err());
        assert_eq!(db::get(&db, "devices").unwrap(), previous);
    }
    #[test]
    #[cfg(unix)]
    fn process_output_has_a_deadline_and_a_size_limit() {
        let mut sleep = Command::new("/bin/sleep");
        sleep.arg("2");
        let start = Instant::now();
        assert!(output(sleep, start + Duration::from_millis(40)).is_none());
        assert!(start.elapsed() < Duration::from_secs(1));
        let mut descendants = Command::new("/bin/sh");
        descendants.args(["-c", "sleep 2 & wait"]);
        let start = Instant::now();
        assert!(output(descendants, start + Duration::from_millis(40)).is_none());
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "inherited stdout must not extend the deadline"
        );
        let mut print = Command::new("/usr/bin/printf");
        print.arg("x".repeat(MAX_OUTPUT as usize + 1));
        assert!(output(print, Instant::now() + Duration::from_secs(1)).is_none());
        assert!(output(
            Command::new("/usr/bin/false"),
            Instant::now() + Duration::from_secs(1)
        )
        .is_none());
    }
}
