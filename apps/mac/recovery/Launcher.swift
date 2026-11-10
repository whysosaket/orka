import AppKit
import Foundation

#if !ORKA_RECOVERY_TESTS
@main
#endif
struct Launcher {
    @MainActor
    static func main() {
        let bundle = Bundle.main
        let arguments = Array(CommandLine.arguments.dropFirst())
        let recovery = bundle.bundleIdentifier == recoveryID
        let app = recovery ? bundle.bundleURL.deletingLastPathComponent().appendingPathComponent("Orka.app") : bundle.bundleURL
        do {
            let installation = try Installation(app: app, info: bundle.infoDictionary ?? [:])
            if arguments.first == "--orka-update-status" {
                Task {
                    let status = await status(for: installation)
                    if let data = try? JSONEncoder().encode(status) { FileHandle.standardOutput.write(data) }
                    exit(0)
                }
                dispatchMain()
            }
            if arguments.first == "--orka-update-review" {
                try openRecovery(installation, mode: "--review")
                return
            }
            if recovery || arguments.first == "--orka-builtin-recovery" {
                let delegate = RecoveryWindow(installation: installation, failure: arguments.contains("--launch-failure"))
                let application = NSApplication.shared
                application.delegate = delegate
                application.setActivationPolicy(.regular)
                withExtendedLifetime(delegate) { application.run() }
                return
            }
            if arguments.first == "--orka-update-watch", arguments.count == 4,
               let pid = pid_t(arguments[1]), pid > 1,
               versionParts(arguments[2]) != nil, UUID(uuidString: arguments[3]) != nil {
                LaunchHealth(installation: installation, session: arguments[3], version: arguments[2]).watch(pid: pid)
            }
            try launch(installation, arguments: arguments)
        } catch {
            FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
            if recovery {
                NSApplication.shared.setActivationPolicy(.regular)
                message("Orka Recovery", error.localizedDescription)
            }
            exit(1)
        }
    }

    private static func launch(_ installation: Installation, arguments: [String]) throws {
        let maintenance: FileLock
        do { maintenance = try FileLock(installation.maintenanceLock, operation: LOCK_SH | LOCK_NB) }
        catch { exit(0) } // launchd retries once maintenance finishes.
        let running = try FileLock(installation.runningLock, operation: LOCK_SH | LOCK_NB)
        let command = arguments.dropFirst(arguments.first == "--profile" ? 2 : 0).first
        let headless = ["--orka-agent", "--orka-plugin", "--orka-sync", "--orka-hook", "--orka-context", "--orka-env-test", "--orka-test"].contains(command ?? "")
        let bypass = arguments.contains("--orka-try-launch")
        let current = try InstalledBuild(at: installation.app)
        let withdrawn = installation.feed?.cached()?.allows(current.version) == false
        if !bypass && (withdrawn || CrashRecord.load(installation, version: current.version).repeated) {
            if !headless { try openRecovery(installation, mode: "--launch-failure") }
            return
        }
        if !headless {
            let session = UUID().uuidString
            let watcher = Process()
            watcher.executableURL = Bundle.main.executableURL
            watcher.arguments = ["--orka-update-watch", String(getpid()), current.version, session]
            watcher.standardInput = FileHandle.nullDevice
            watcher.standardOutput = FileHandle.nullDevice
            watcher.standardError = FileHandle.nullDevice
            try watcher.run()
            setenv("ORKA_UPDATE_SESSION", session, 1)
        }
        // Keep the running lock through exec, preserving the LaunchServices PID for URLs and activation.
        guard fcntl(running.descriptor, F_SETFD, 0) == 0 else { throw UpdateError("Couldn’t start Orka.") }
        setenv("ORKA_UPDATE_LOCK", String(running.descriptor), 1)
        let binary = installation.app.appendingPathComponent("Contents/MacOS/\(desktopName)").path
        let forwarded = arguments.filter { $0 != "--orka-try-launch" }
        var argv = ([binary] + forwarded).map { strdup($0) }
        argv.append(nil)
        withExtendedLifetime((maintenance, running)) { _ = execv(binary, &argv) }
        for value in argv { free(value) }
        throw UpdateError("Couldn’t start Orka.")
    }
}

struct UpdateStatus: Encodable {
    let installedVersion: String
    var update: Release?
    var withdrawn = false
    var message: String?
}

func status(for installation: Installation) async -> UpdateStatus {
    guard let current = try? InstalledBuild(at: installation.app) else {
        return UpdateStatus(installedVersion: "Unknown", message: "Orka Recovery couldn’t read the installed version.")
    }
    guard let feed = installation.feed else {
        return UpdateStatus(installedVersion: current.version, message: "Updates are unavailable for this build.")
    }
    do {
        let policy = try await feed.refresh()
        return UpdateStatus(installedVersion: current.version, update: feed.candidate(policy, current: current),
                            withdrawn: !policy.allows(current.version))
    } catch {
        return UpdateStatus(installedVersion: current.version, withdrawn: feed.cached()?.allows(current.version) == false,
                            message: "Couldn’t verify the update feed. Try again when you’re online.")
    }
}

func openRecovery(_ installation: Installation, mode: String) throws {
    let recovery = installation.app.deletingLastPathComponent().appendingPathComponent("Orka Recovery.app")
    if (try? installation.verify(recovery, id: recoveryID)) != nil {
        try run("/usr/bin/open", ["-a", recovery.path, "--args", mode])
    } else {
        // The launcher can still present native recovery if the companion was moved or omitted.
        try run("/usr/bin/open", ["-n", "-a", installation.app.path, "--args", "--orka-builtin-recovery", mode])
    }
}

@MainActor
final class RecoveryWindow: NSObject, NSApplicationDelegate {
    let installation: Installation
    let failure: Bool
    private var progress: NSWindow?

    init(installation: Installation, failure: Bool) {
        self.installation = installation
        self.failure = failure
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.activate(ignoringOtherApps: true)
        showProgress("Checking for Orka updates…")
        Task { await review() }
    }

    private func showProgress(_ title: String) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 135), styleMask: [.titled],
                              backing: .buffered, defer: false)
        window.title = "Orka Recovery"
        let label = NSTextField(labelWithString: title)
        label.frame = NSRect(x: 25, y: 76, width: 350, height: 22)
        let indicator = NSProgressIndicator(frame: NSRect(x: 25, y: 40, width: 350, height: 16))
        indicator.isIndeterminate = true
        indicator.startAnimation(nil)
        window.contentView?.addSubview(label)
        window.contentView?.addSubview(indicator)
        window.center()
        window.makeKeyAndOrderFront(nil)
        progress = window
    }

    private func review() async {
        let update = await status(for: installation)
        progress?.orderOut(nil)
        do {
            let current = try InstalledBuild(at: installation.app)
            let previous = installation.restoreCandidate(current: current)
            let alert = NSAlert()
            alert.messageText = failure || update.withdrawn ? "Orka needs recovery" : "Orka Updates"
            var detail = "Installed version: \(current.version)."
            if let release = update.update { detail += "\n\nOrka \(release.version) is available.\n\(release.notes)" }
            if let previous { detail += "\n\nYou can restore Orka \(previous.version) from this Mac." }
            if let message = update.message { detail += "\n\n\(message)" }
            else if update.update == nil { detail += "\n\nNo compatible update is available." }
            alert.informativeText = detail
            var choices: [() async throws -> Void] = []
            if let release = update.update {
                alert.addButton(withTitle: failure || update.withdrawn ? "Install fix \(release.version)" : "Update to \(release.version) and Restart")
                choices.append {
                    self.showProgress("Installing Orka \(release.version)…")
                    try await self.installation.install(release, replacing: current)
                    self.openOrka()
                }
            }
            if let previous {
                alert.addButton(withTitle: "Restore \(previous.version)")
                choices.append {
                    self.showProgress("Restoring Orka \(previous.version)…")
                    try await self.installation.restore(previous, replacing: current)
                    self.openOrka()
                }
            }
            if failure || update.withdrawn {
                alert.addButton(withTitle: "Try Opening Orka")
                choices.append { self.openOrka(bypass: true) }
            }
            let cancel = alert.addButton(withTitle: "Later")
            cancel.keyEquivalent = "\u{1b}"
            let choice = alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
            if choices.indices.contains(choice) { try await choices[choice]() }
        } catch {
            progress?.orderOut(nil)
            message("Orka Recovery", error.localizedDescription)
        }
        exit(0)
    }

    private func openOrka(bypass: Bool = false) {
        let arguments = bypass ? ["--args", "--orka-try-launch"] : []
        try? run("/usr/bin/open", ["-n", "-a", installation.app.path] + arguments)
    }
}

func message(_ title: String, _ detail: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = detail
    alert.runModal()
}
