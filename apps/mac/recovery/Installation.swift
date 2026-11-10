import AppKit
import Foundation
import Security

let desktopID = "com.relay.portable-workspace"
let recoveryID = "com.relay.portable-workspace.recovery"
let launcherName = "portable-workspace-mac"
let desktopName = "orka-desktop"

struct InstalledBuild: Equatable {
    let version: String
    let dataEpoch: Int

    init(at url: URL) throws {
        let plist = url.appendingPathComponent("Contents/Info.plist")
        guard let metadata = NSDictionary(contentsOf: plist), metadata["CFBundleIdentifier"] as? String == desktopID,
              let version = metadata["CFBundleShortVersionString"] as? String, versionParts(version) != nil,
              let epoch = metadata["OrkaUpdateDataEpoch"] as? Int, epoch > 0 else {
            throw UpdateError("Couldn’t read the installed Orka version.")
        }
        self.version = version
        dataEpoch = epoch
    }
}

struct Installation {
    let app: URL
    let state: URL
    let team: String
    let feed: Feed?
    let files = FileManager.default
    let makeSession: () -> URLSession

    init(app: URL, info: [String: Any], supportDirectory: URL? = nil,
         makeSession: @escaping () -> URLSession = networkSession) throws {
        self.makeSession = makeSession
        let parent = canonicalPath(app.deletingLastPathComponent())
        self.app = URL(fileURLWithPath: "\(parent)/\(app.lastPathComponent)", isDirectory: true)
        let support = try supportDirectory ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                  appropriateFor: nil, create: true)
        state = support.appendingPathComponent("com.orka.updates", isDirectory: true)
            .appendingPathComponent(digest(Data(self.app.path.utf8)), isDirectory: true)
        let configuredTeam = info["OrkaUpdateTeam"] as? String ?? ""
        team = configuredTeam.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) == nil ? "" : configuredTeam
        try files.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if let address = info["OrkaUpdateFeed"] as? String, let url = URL(string: address), isHTTPS(url),
           let encoded = info["OrkaUpdatePublicKey"] as? String, let key = Data(base64Encoded: encoded),
           key.count == 32, !team.isEmpty {
            feed = Feed(url: url, key: key, directory: state, makeSession: makeSession)
        } else {
            feed = nil
        }
    }

    var runningLock: URL { state.appendingPathComponent("running.lock") }
    var maintenanceLock: URL { state.appendingPathComponent("maintenance.lock") }
    var previous: URL { state.appendingPathComponent("Previous/Orka.app") }

    func signingRequirement(id: String) throws -> SecRequirement {
        let rule = "anchor apple generic and identifier \"\(id)\" and certificate leaf[subject.OU] = \"\(team)\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
        var requirement: SecRequirement?
        guard !team.isEmpty, SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess,
              let requirement else { throw UpdateError("This build does not have an Orka release signing identity.") }
        return requirement
    }

    func verify(_ url: URL, id: String = desktopID) throws {
        let requirement = try signingRequirement(id: id)
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode), requirement) == errSecSuccess else {
            throw UpdateError("The app does not have a valid Orka Developer ID signature.")
        }
    }

    func restoreCandidate(current: InstalledBuild) -> InstalledBuild? {
        guard let policy = feed?.cached(), let backup = try? InstalledBuild(at: previous),
              backup.version != current.version, backup.dataEpoch == current.dataEpoch,
              policy.allows(backup.version), !CrashRecord.load(self, version: backup.version).repeated,
              (try? verify(previous)) != nil else { return nil }
        return backup
    }

    func install(_ release: Release, replacing current: InstalledBuild) async throws {
        guard let feed else { throw UpdateError("Updates are unavailable for this build.") }
        let transaction = try FileLock(state.appendingPathComponent("installer.lock"), operation: LOCK_EX | LOCK_NB)
        defer { withExtendedLifetime(transaction) {} }
        let session = makeSession()
        defer { session.finishTasksAndInvalidate() }
        let (archive, response) = try await session.download(from: release.url)
        defer { try? files.removeItem(at: archive) }
        try checkResponse(response)
        let size = try archive.resourceValues(forKeys: [.fileSizeKey]).fileSize
        guard size == release.size, digest(try Data(contentsOf: archive, options: .mappedIfSafe)) == release.sha256 else {
            throw UpdateError("The downloaded update failed verification.")
        }
        let staging = try stagingDirectory()
        defer { try? files.removeItem(at: staging) }
        try run("/usr/bin/ditto", ["-x", "-k", archive.path, staging.path])
        let next = staging.appendingPathComponent("Orka.app")
        try verify(next)
        try run("/usr/sbin/spctl", ["--assess", "--type", "execute", next.path])
        guard try InstalledBuild(at: next) == InstalledBuild(version: release.version, dataEpoch: release.dataEpoch) else {
            throw UpdateError("The downloaded app does not match the approved release.")
        }
        try await replace(with: next, current: current, keepPrevious: true) {
            let policy = try await feed.refresh(bypassCache: true)
            guard feed.candidate(policy, current: current) == release else {
                throw UpdateError("This update has changed or been withdrawn. Check for updates again.")
            }
        } validateCached: {
            guard let policy = feed.cached(), feed.candidate(policy, current: current) == release,
                  policy.expires > Int64(Date().timeIntervalSince1970) else {
                throw UpdateError("This update is no longer available. Check for updates again.")
            }
        }
    }

    func restore(_ approved: InstalledBuild, replacing current: InstalledBuild) async throws {
        let transaction = try FileLock(state.appendingPathComponent("installer.lock"), operation: LOCK_EX | LOCK_NB)
        defer { withExtendedLifetime(transaction) {} }
        if let feed { _ = try? await feed.refresh(bypassCache: true) }
        guard restoreCandidate(current: current) == approved else {
            throw UpdateError("The previous version is no longer safe to restore.")
        }
        let staging = try stagingDirectory()
        defer { try? files.removeItem(at: staging) }
        let next = staging.appendingPathComponent("Orka.app")
        try run("/usr/bin/ditto", [previous.path, next.path])
        try verify(next)
        guard try InstalledBuild(at: next) == approved else {
            throw UpdateError("The previous version has changed. Review the update again.")
        }
        try await replace(with: next, current: current, keepPrevious: false, refreshPolicy: {}) {
            guard restoreCandidate(current: current) == approved else {
                throw UpdateError("The previous version is no longer safe to restore.")
            }
            try Data().write(to: state.appendingPathComponent("skipped-\(current.version)"), options: .atomic)
        }
    }

    private func replace(with next: URL, current: InstalledBuild, keepPrevious: Bool,
                         refreshPolicy: () async throws -> Void, validateCached: () throws -> Void) async throws {
        let maintenance = try FileLock(maintenanceLock, operation: LOCK_EX | LOCK_NB)
        defer { withExtendedLifetime(maintenance) {} }
        try await refreshPolicy()
        await MainActor.run {
            for running in NSRunningApplication.runningApplications(withBundleIdentifier: desktopID)
                where running.processIdentifier != getpid() && running.bundleURL.map(canonicalPath) == app.path {
                _ = running.terminate()
            }
        }
        let deadline = DispatchTime.now() + .seconds(30)
        var locked: FileLock?
        repeat {
            locked = try? FileLock(runningLock, operation: LOCK_EX | LOCK_NB)
            if locked == nil { try await Task.sleep(nanoseconds: 200_000_000) }
        } while locked == nil && DispatchTime.now() < deadline
        guard let locked else { throw UpdateError("Quit Orka and finish any running sync, then try again.") }
        defer { withExtendedLifetime(locked) {} }
        guard try InstalledBuild(at: app) == current,
              try app.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == false else {
            throw UpdateError("The installed app changed during this update. Review the update again.")
        }
        // Withdrawal can change while Orka and the sync agent are stopping.
        try await refreshPolicy()
        if keepPrevious, LaunchHealth.isHealthy(self, version: current.version),
           !CrashRecord.load(self, version: current.version).repeated,
           feed?.cached()?.allows(current.version) == true, (try? verify(app)) != nil {
            try savePrevious()
        }
        // Stage on the installation volume. The original or replacement is always at the normal path.
        let policyLock = try FileLock(state.appendingPathComponent("policy.lock"), operation: LOCK_SH)
        try withExtendedLifetime(policyLock) {
            try validateCached()
            guard renamex_np(next.path, app.path, UInt32(RENAME_SWAP)) == 0 else {
                throw UpdateError("macOS couldn’t replace Orka. Check that you can write to its Applications folder.")
            }
        }
    }

    private func stagingDirectory() throws -> URL {
        let parent = app.deletingLastPathComponent()
        let prefix = ".orka-update-\(state.lastPathComponent.prefix(12))-"
        for entry in (try? files.contentsOfDirectory(at: parent, includingPropertiesForKeys: nil)) ?? [] {
            let name = entry.lastPathComponent
            if name.hasPrefix(prefix), UUID(uuidString: String(name.dropFirst(prefix.count))) != nil {
                try? files.removeItem(at: entry)
            }
        }
        let dir = parent.appendingPathComponent("\(prefix)\(UUID().uuidString)")
        do { try files.createDirectory(at: dir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
        catch { throw UpdateError("Orka needs write access to its Applications folder to install updates.") }
        return dir
    }

    private func savePrevious() throws {
        let old = previous.deletingLastPathComponent()
        let fresh = state.appendingPathComponent(".previous-\(UUID().uuidString)")
        try files.createDirectory(at: fresh, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? files.removeItem(at: fresh) }
        let copy = fresh.appendingPathComponent("Orka.app")
        try run("/usr/bin/ditto", [app.path, copy.path])
        try verify(copy)
        if files.fileExists(atPath: old.path) {
            guard renamex_np(fresh.path, old.path, UInt32(RENAME_SWAP)) == 0 else {
                throw UpdateError("Orka couldn’t save a copy of the previous version.")
            }
        } else {
            try files.moveItem(at: fresh, to: old)
        }
    }
}

extension InstalledBuild {
    init(version: String, dataEpoch: Int) {
        self.version = version
        self.dataEpoch = dataEpoch
    }
}

func run(_ executable: String, _ arguments: [String]) throws {
    let child = Process()
    child.executableURL = URL(fileURLWithPath: executable)
    child.arguments = arguments
    child.standardOutput = FileHandle.nullDevice
    child.standardError = FileHandle.nullDevice
    try child.run()
    child.waitUntilExit()
    guard child.terminationStatus == 0 else { throw UpdateError("macOS couldn’t prepare the Orka update.") }
}

// Match Rust’s canonicalize for macOS aliases such as /tmp and /var.
func canonicalPath(_ url: URL) -> String {
    guard let path = realpath(url.path, nil) else { return url.standardizedFileURL.path }
    defer { free(path) }
    return String(cString: path)
}
