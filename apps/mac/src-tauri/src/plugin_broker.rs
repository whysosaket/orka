//! Same-user Unix transport. Only the desktop owner executes tools and reads credentials.
use crate::{
    db::{self, Result},
    plugin_connection, plugin_mcp,
    plugin_process::Peer,
};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

const REQUEST_LIMIT: usize = 2_000_000;
const RESPONSE_LIMIT: usize = 16_000_000;
pub(crate) const UNAVAILABLE: &str = "Orka desktop is unavailable. Open Orka and try again.";

// Valid native profile paths can exceed macOS's 104-byte Unix socket path limit.
// The short directory is derived from the entire profile path and private to this UID.
pub(crate) fn directory() -> Result<PathBuf> {
    let profile = db::root()?;
    Ok(PathBuf::from("/tmp").join(format!(
        "orka-connector-{}-{}",
        unsafe { libc::geteuid() },
        &db::digest(profile.to_string_lossy().as_bytes())[..24]
    )))
}
fn secure_directory(create: bool) -> Result<PathBuf> {
    let path = directory()?;
    if create {
        match fs::DirBuilder::new().mode(0o700).create(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    let meta = fs::symlink_metadata(&path).map_err(|_| UNAVAILABLE)?;
    if !meta.is_dir()
        || meta.file_type().is_symlink()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o777 != 0o700
    {
        return Err("Unsafe Orka connector directory".into());
    }
    Ok(path)
}
pub(crate) fn verify_peer(stream: &UnixStream) -> Result<()> {
    #[cfg(target_os = "macos")]
    let uid = {
        let (mut uid, mut gid) = (0, 0);
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
            return Err("Cannot verify connector peer".into());
        }
        uid
    };
    #[cfg(target_os = "linux")]
    let uid = {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut length,
            )
        } != 0
        {
            return Err("Cannot verify connector peer".into());
        }
        credentials.uid
    };
    if uid != unsafe { libc::geteuid() } {
        return Err("Connector peer belongs to another user".into());
    }
    Ok(())
}
fn read_frame(stream: &mut UnixStream, limit: usize) -> Result<Value> {
    let mut header = [0u8; 4];
    stream
        .read_exact(&mut header)
        .map_err(|_| "Connector transport closed")?;
    let len = u32::from_be_bytes(header) as usize;
    if len == 0 || len > limit {
        return Err("Invalid connector frame size".into());
    }
    let mut body = vec![0u8; len];
    stream
        .read_exact(&mut body)
        .map_err(|_| "Connector transport closed")?;
    serde_json::from_slice(&body).map_err(|_| "Invalid connector message".into())
}
fn write_frame(stream: &mut UnixStream, value: &Value, limit: usize) -> Result<()> {
    let body = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if body.len() > limit {
        return Err("Connector response exceeds size limit".into());
    }
    stream
        .write_all(&(body.len() as u32).to_be_bytes())
        .and_then(|_| stream.write_all(&body))
        .map_err(|_| "Connector transport closed".into())
}

pub(crate) struct Broker {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    path: PathBuf,
    _lock: fs::File,
}
impl Drop for Broker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = fs::remove_file(&self.path);
    }
}
pub(crate) fn start() -> Result<Broker> {
    let dir = secure_directory(true)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(dir.join("owner.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock_exclusive()
        .map_err(|_| "The Orka desktop connector is already running")?;
    let path = dir.join("broker.sock");
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    let listener =
        UnixListener::bind(&path).map_err(|e| format!("Cannot start desktop connector: {e}"))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = stop.clone();
    let active = Arc::new(AtomicUsize::new(0));
    let thread = std::thread::spawn(move || {
        while !stopping.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    if active.load(Ordering::SeqCst) >= 16 {
                        continue;
                    }
                    let Ok(peer) = Peer::read(&stream) else {
                        continue;
                    };
                    active.fetch_add(1, Ordering::SeqCst);
                    let active = active.clone();
                    std::thread::spawn(move || {
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(35)));
                        let result = read_frame(&mut stream, REQUEST_LIMIT).and_then(|request| {
                            tokio::runtime::Runtime::new()
                                .map_err(|e| e.to_string())?
                                .block_on(dispatch(&request, &peer))
                        });
                        let response = match result {
                            Ok(value) => json!({"value":value}),
                            Err(error) => json!({"error":error}),
                        };
                        if write_frame(&mut stream, &response, RESPONSE_LIMIT).is_err() {
                            let _ = write_frame(
                                &mut stream,
                                &json!({"error":"Connector response exceeds the supported size limit"}),
                                RESPONSE_LIMIT,
                            );
                        }
                        active.fetch_sub(1, Ordering::SeqCst);
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(30))
                }
                Err(_) => break,
            }
        }
    });
    Ok(Broker {
        stop,
        thread: Some(thread),
        path,
        _lock: lock,
    })
}

async fn dispatch(request: &Value, peer: &Peer) -> Result<Value> {
    if request["version"] != 1 {
        return Err("Unsupported connector transport".into());
    }
    let id = request["sessionId"]
        .as_str()
        .ok_or("Missing connector session")?;
    let secret = request["secret"]
        .as_str()
        .ok_or("Missing connector credential")?;
    if matches!(
        request["operation"].as_str(),
        Some("close" | "tools" | "call")
    ) {
        plugin_connection::identify_session(id, secret, peer)?;
    }
    match request["operation"].as_str().unwrap_or("") {
        "initialize" => {
            let result = plugin_connection::initialize_session(
                id,
                secret,
                request["clientName"].as_str().unwrap_or("Assistant"),
                peer,
                peer.verified_app(),
            )?;
            if result["raiseConsent"] == true {
                if let Ok(root) = db::root() {
                    let _ = db::atomic(&root.join("connector-focus"), b"");
                }
            }
            Ok(result)
        }
        "close" => plugin_connection::close_session(id, secret).map(|_| json!({})),
        "tools" => {
            plugin_connection::session_status(id, secret)?;
            Ok(plugin_mcp::tools())
        }
        "call" => {
            plugin_mcp::call_session(
                id,
                secret,
                request["name"].as_str().unwrap_or(""),
                &request["arguments"],
            )
            .await
        }
        _ => Err("Unknown connector transport operation".into()),
    }
}
pub(crate) fn exchange(request: &Value) -> Result<Value> {
    let dir = secure_directory(false)?;
    let path = dir.join("broker.sock");
    let meta = fs::symlink_metadata(&path).map_err(|_| UNAVAILABLE)?;
    use std::os::unix::fs::FileTypeExt;
    if !meta.file_type().is_socket()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o777 != 0o600
    {
        return Err("Unsafe Orka connector socket".into());
    }
    let mut stream = UnixStream::connect(path).map_err(|_| UNAVAILABLE)?;
    verify_peer(&stream)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(90)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    write_frame(&mut stream, request, REQUEST_LIMIT)?;
    let response = read_frame(&mut stream, RESPONSE_LIMIT)?;
    if let Some(error) = response["error"].as_str() {
        return Err(error.into());
    }
    response
        .get("value")
        .cloned()
        .ok_or("Invalid desktop connector response".into())
}
