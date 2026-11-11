import AppKit
import Foundation
import Security

extension Installation {
    var embeddedUpdater: URL { app.appendingPathComponent("Contents/Helpers/Orka Updater.app") }
    var updater: URL { state.appendingPathComponent("Orka Updater.app") }
    var updaterExecutable: URL { updater.appendingPathComponent("Contents/MacOS/orka-updater") }
    var desktopExecutable: URL { app.appendingPathComponent("Contents/MacOS/\(desktopName)") }

    func provisionUpdater() throws {
        if hasTrustedUpdater() { return }
        let lock = try FileLock(state.appendingPathComponent("updater.lock"), operation: LOCK_EX)
        try withExtendedLifetime(lock) {
            if hasTrustedUpdater() { return }
            try verify(embeddedUpdater, id: recoveryID)
            let stage = state.appendingPathComponent(".updater-\(UUID().uuidString)")
            defer { try? files.removeItem(at: stage) }
            try run("/usr/bin/ditto", [embeddedUpdater.path, stage.path])
            try verify(stage, id: recoveryID)
            if files.fileExists(atPath: updater.path) || (try? files.destinationOfSymbolicLink(atPath: updater.path)) != nil {
                guard renamex_np(stage.path, updater.path, UInt32(RENAME_SWAP)) == 0 else {
                    throw UpdateError("Couldn’t prepare the background updater.")
                }
            } else {
                try files.moveItem(at: stage, to: updater)
            }
        }
    }

    private func hasTrustedUpdater() -> Bool {
        guard (try? updater.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == false,
              (try? verify(updater, id: recoveryID)) != nil,
              let info = NSDictionary(contentsOf: updater.appendingPathComponent("Contents/Info.plist")),
              let embeddedInfo = NSDictionary(contentsOf: embeddedUpdater.appendingPathComponent("Contents/Info.plist")),
              let version = info["CFBundleVersion"] as? String,
              let embeddedVersion = embeddedInfo["CFBundleVersion"] as? String else { return false }
        // Reuse the independent helper only while it has the current updater fixes and trust configuration.
        return info["OrkaUpdateFeed"] as? String == feed?.url.absoluteString
            && info["OrkaUpdatePublicKey"] as? String == feed?.key.base64EncodedString()
            && compareVersion(version, embeddedVersion) != .orderedAscending
    }

    func updaterProcess(_ mode: String, arguments: [String] = []) throws -> Process {
        try provisionUpdater()
        let process = Process()
        process.executableURL = updaterExecutable
        process.arguments = [mode, app.path] + arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        return process
    }

    func verifyDesktopCaller(_ pid: pid_t) throws {
        let invalid = UpdateError("Approve this update from the Orka sidebar.")
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard pid > 1, proc_pidpath(pid, &path, UInt32(path.count)) > 0,
              canonicalPath(URL(fileURLWithPath: String(cString: path))) == desktopExecutable.path,
              let requirement = try? signingRequirement(id: desktopID) else { throw invalid }
        var caller: SecCode?
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &caller) == errSecSuccess, let caller,
              SecCodeCheckValidity(caller, [], requirement) == errSecSuccess else { throw invalid }
    }

    func openDesktop(arguments: [String] = []) throws {
        let forwarded = arguments.isEmpty ? [] : ["--args"] + arguments
        try run("/usr/bin/open", ["-n", "-a", app.path] + forwarded)
    }
}

@MainActor
func installApprovedUpdate(_ installation: Installation, version: String, sha256: String, profile: String) throws -> Never {
    let caller = getppid()
    try installation.verifyDesktopCaller(caller)
    signal(SIGPIPE, SIG_IGN)
    let application = NSApplication.shared
    application.setActivationPolicy(.prohibited)
    Task {
        do {
            guard let feed = installation.feed else { throw UpdateError("Updates are unavailable for this build.") }
            let current = try InstalledBuild(at: installation.app)
            let policy = try await feed.refresh(bypassCache: true)
            guard let release = feed.candidate(policy, current: current), release.version == version, release.sha256 == sha256 else {
                throw UpdateError("This update changed or is no longer available. Review the available update again.")
            }
            try await installation.install(release, replacing: current, progress: { progress in
                if let data = try? JSONEncoder().encode(progress) {
                    try? FileHandle.standardOutput.write(contentsOf: data + Data("\n".utf8))
                }
            })
            try installation.openDesktop(arguments: ["--profile", profile])
            exit(0)
        } catch {
            if kill(caller, 0) == 0 {
                FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
            } else {
                application.setActivationPolicy(.accessory)
                application.activate(ignoringOtherApps: true)
                let alert = NSAlert()
                alert.messageText = "Couldn’t finish updating Orka"
                alert.informativeText = error.localizedDescription
                alert.addButton(withTitle: "Open Orka")
                alert.addButton(withTitle: "Later")
                if alert.runModal() == .alertFirstButtonReturn {
                    try? installation.openDesktop(arguments: ["--profile", profile])
                }
            }
            exit(1)
        }
    }
    application.run()
    exit(1)
}

func replaceProcess(with executable: URL, arguments: [String]) throws -> Never {
    let path = executable.path
    var argv = ([path] + arguments).map { strdup($0) }
    argv.append(nil)
    execv(path, &argv)
    for value in argv { free(value) }
    throw UpdateError("Couldn’t start Orka.")
}
