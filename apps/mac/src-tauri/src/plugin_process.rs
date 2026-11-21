//! Kernel identity binds each helper to its parent. macOS verifies supported assistant signatures.
use crate::db::Result;
use serde::{Deserialize, Serialize};
use std::{os::fd::AsRawFd, os::unix::net::UnixStream};

#[cfg(target_os = "macos")]
use security_framework::os::macos::code_signing::{
    Flags, GuestAttributes, SecCode, SecRequirement,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ProcessIdentity {
    pid: u32,
    started: u64,
    fraction: u64,
}

impl ProcessIdentity {
    pub(crate) fn read(pid: u32) -> Result<(Self, u32)> {
        #[cfg(target_os = "macos")]
        {
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of_val(&info) as i32;
            let read = unsafe {
                libc::proc_pidinfo(
                    pid as i32,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    (&mut info as *mut libc::proc_bsdinfo).cast(),
                    size,
                )
            };
            if pid <= 1
                || read != size
                || info.pbi_pid != pid
                || info.pbi_uid != unsafe { libc::geteuid() }
                || info.pbi_status == 5
            {
                return Err("Connector process is unavailable".into());
            }
            Ok((
                Self {
                    pid,
                    started: info.pbi_start_tvsec,
                    fraction: info.pbi_start_tvusec,
                },
                info.pbi_ppid,
            ))
        }
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::MetadataExt;
            let path = format!("/proc/{pid}/stat");
            let stat =
                std::fs::read_to_string(&path).map_err(|_| "Connector process is unavailable")?;
            let fields = stat
                .rsplit_once(')')
                .ok_or("Invalid connector process")?
                .1
                .split_whitespace()
                .collect::<Vec<_>>();
            if pid <= 1
                || std::fs::metadata(&path).map_err(|e| e.to_string())?.uid()
                    != unsafe { libc::geteuid() }
                || fields.first() == Some(&"Z")
            {
                return Err("Connector process is unavailable".into());
            }
            let parent = fields
                .get(1)
                .and_then(|v| v.parse().ok())
                .ok_or("Invalid connector parent")?;
            let started = fields
                .get(19)
                .and_then(|v| v.parse().ok())
                .ok_or("Invalid connector process start")?;
            Ok((
                Self {
                    pid,
                    started,
                    fraction: 0,
                },
                parent,
            ))
        }
    }

    pub(crate) fn alive(&self) -> bool {
        Self::read(self.pid).is_ok_and(|(current, _)| current == *self)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AssistantApp {
    Codex,
    ClaudeCode,
    ClaudeDesktop,
}

impl AssistantApp {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::ClaudeCode => "Claude Code",
            Self::ClaudeDesktop => "Claude",
        }
    }

    #[cfg(target_os = "macos")]
    fn verify(process: &ProcessIdentity) -> Option<Self> {
        // Check running code from the kernel, not a path or a client-supplied name.
        let code = running_code(process.pid)?;
        let app = [
            (Self::Codex, r#"(identifier "codex" or identifier "com.openai.codex")"#, "2DC432GLL2"),
            (Self::ClaudeCode, r#"identifier "com.anthropic.claude-code""#, "Q6L2SF6YDW"),
            (Self::ClaudeDesktop, r#"identifier "com.anthropic.claudefordesktop""#, "Q6L2SF6YDW"),
        ]
        .into_iter()
        .find_map(|(app, identifier, team)| {
            let requirement = format!(
                r#"{identifier} and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "{team}""#
            )
            .parse::<SecRequirement>()
            .ok()?;
            code.check_validity(Flags::empty(), &requirement).ok()?;
            Some(app)
        })?;
        process.alive().then_some(app)
    }
}

#[cfg(target_os = "macos")]
fn running_code(pid: u32) -> Option<SecCode> {
    let mut attributes = GuestAttributes::new();
    attributes.set_pid(pid as i32);
    SecCode::copy_guest_with_attribues(None, &attributes, Flags::empty()).ok()
}

#[cfg(target_os = "macos")]
fn own_code_requirement() -> Option<SecRequirement> {
    use core_foundation::base::TCFType;
    use std::ptr;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        // Security also accepts a dynamic SecCodeRef here to obtain its requirement.
        fn SecCodeCopyDesignatedRequirement(
            code: <SecCode as TCFType>::Ref,
            flags: u32,
            requirement: *mut <SecRequirement as TCFType>::Ref,
        ) -> i32;
    }

    let own_code = SecCode::for_self(Flags::empty()).ok()?;
    let mut requirement = ptr::null_mut();
    let result = unsafe {
        SecCodeCopyDesignatedRequirement(own_code.as_concrete_TypeRef(), 0, &mut requirement)
    };
    if result != 0 || requirement.is_null() {
        return None;
    }
    let requirement = unsafe { SecRequirement::wrap_under_create_rule(requirement) };
    // The designated requirement works across slices of a signed universal app.
    // Verify it against the running broker before trusting a helper that matches it.
    own_code.check_validity(Flags::empty(), &requirement).ok()?;
    Some(requirement)
}

#[derive(Clone, Debug)]
pub(crate) struct Peer {
    pub(crate) helper: ProcessIdentity,
    pub(crate) assistant: ProcessIdentity,
}

impl Peer {
    pub(crate) fn verified_app(&self) -> Option<AssistantApp> {
        #[cfg(target_os = "macos")]
        {
            if self.helper != self.assistant {
                // Assistants can launch arbitrary MCP servers. Remember access only
                // for Orka's own running connector binary, even under a trusted host.
                running_code(self.helper.pid)?
                    .check_validity(Flags::empty(), &own_code_requirement()?)
                    .ok()?;
                let app = AssistantApp::verify(&self.assistant)?;
                let (helper, parent) = ProcessIdentity::read(self.helper.pid).ok()?;
                if helper == self.helper && parent == self.assistant.pid {
                    return Some(app);
                }
            }
        }
        None
    }

    pub(crate) fn read(stream: &UnixStream) -> Result<Self> {
        crate::plugin_broker::verify_peer(stream)?;
        #[cfg(target_os = "macos")]
        let pid = {
            let mut pid: libc::pid_t = 0;
            let mut size = std::mem::size_of_val(&pid) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_LOCAL,
                    libc::LOCAL_PEERPID,
                    (&mut pid as *mut libc::pid_t).cast(),
                    &mut size,
                )
            } != 0
                || pid <= 1
            {
                return Err("Cannot identify connector process".into());
            }
            pid as u32
        };
        #[cfg(target_os = "linux")]
        let pid = {
            let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
            let mut size = std::mem::size_of_val(&credentials) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    (&mut credentials as *mut libc::ucred).cast(),
                    &mut size,
                )
            } != 0
                || credentials.pid <= 1
            {
                return Err("Cannot identify connector process".into());
            }
            credentials.pid as u32
        };
        let (helper, parent) = ProcessIdentity::read(pid)?;
        // An orphan has no assistant authority to share. It remains its own connection.
        let assistant = ProcessIdentity::read(parent)
            .map(|(identity, _)| identity)
            .unwrap_or_else(|_| helper.clone());
        Ok(Self { helper, assistant })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exited_processes_and_reused_process_ids_are_not_live() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let (identity, parent) = ProcessIdentity::read(child.id()).unwrap();
        assert_eq!(parent, std::process::id());
        assert!(identity.alive());
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            let requirement = own_code_requirement().unwrap();
            assert!(running_code(std::process::id())
                .unwrap()
                .check_validity(Flags::empty(), &requirement)
                .is_ok());
            assert!(running_code(child.id())
                .unwrap()
                .check_validity(Flags::empty(), &requirement)
                .is_err());
        }
        let mut reused = identity.clone();
        reused.started += 1;
        assert!(!reused.alive());
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!identity.alive());
    }
}
