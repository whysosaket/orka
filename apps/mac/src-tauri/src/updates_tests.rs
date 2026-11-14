use crate::updates;
use fs2::FileExt;
use std::fs::OpenOptions;

#[test]
fn native_launch_stops_during_maintenance_and_keeps_installation_locked_until_exit() {
    let directory = tempfile::tempdir().unwrap();
    let (maintenance, running) = updates::launch_locks(directory.path()).unwrap().unwrap();
    let open = |name| {
        OpenOptions::new()
            .read(true)
            .write(true)
            .open(directory.path().join(name))
            .unwrap()
    };
    let installer = open("maintenance.lock");
    assert_eq!(
        installer.try_lock_exclusive().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    drop(maintenance);
    installer.try_lock_exclusive().unwrap();
    assert!(updates::launch_locks(directory.path()).unwrap().is_none());
    let replacement = open("running.lock");
    assert_eq!(
        replacement.try_lock_exclusive().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    drop(running);
    replacement.try_lock_exclusive().unwrap();
}

#[test]
fn native_runtime_locks_do_not_leak_to_helpers() {
    use std::os::fd::AsRawFd;

    let directory = tempfile::tempdir().unwrap();
    let (maintenance, running) = updates::launch_locks(directory.path()).unwrap().unwrap();
    for file in [&maintenance, &running] {
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
        assert_ne!(flags, -1);
        assert_ne!(flags & libc::FD_CLOEXEC, 0);
    }
}

#[test]
fn native_launch_rejects_symlinked_installation_locks() {
    use std::os::unix::fs::symlink;

    for name in ["maintenance.lock", "running.lock"] {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("unrelated-file");
        std::fs::write(&target, b"preserved").unwrap();
        symlink(&target, directory.path().join(name)).unwrap();
        assert_eq!(
            updates::launch_locks(directory.path())
                .unwrap_err()
                .raw_os_error(),
            Some(libc::ELOOP)
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"preserved");
    }
}
