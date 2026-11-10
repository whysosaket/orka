import AppKit
import Foundation

#if !ORKA_RECOVERY_TESTS
@main
#endif
struct Launcher {
    @MainActor
    static func main() {
        let bundle = Bundle.main
        var arguments = Array(CommandLine.arguments.dropFirst())
        let helper = bundle.bundleIdentifier == recoveryID
        do {
            let app: URL
            if helper {
                guard arguments.count >= 2, ["--orka-recover", "--orka-update-watch", "--orka-install-update"].contains(arguments[0]),
                      arguments[1].hasPrefix("/") else { exit(1) }
                app = URL(fileURLWithPath: arguments.remove(at: 1), isDirectory: true)
            } else {
                app = bundle.bundleURL
            }
            let installation = try Installation(app: app, info: bundle.infoDictionary ?? [:])
            if helper && canonicalPath(bundle.bundleURL) != canonicalPath(installation.updater) { exit(1) }
            switch arguments.first {
            case "--orka-update-status" where !helper:
                Task {
                    let status = await status(for: installation)
                    if let data = try? JSONEncoder().encode(status) { FileHandle.standardOutput.write(data) }
                    exit(0)
                }
                dispatchMain()
            case "--orka-install-update" where arguments.count == 4:
                if !helper {
                    try installation.provisionUpdater()
                    try replaceProcess(with: installation.updaterExecutable, arguments: [arguments[0], app.path] + arguments.dropFirst())
                }
                try installApprovedUpdate(installation, version: arguments[1], sha256: arguments[2], profile: arguments[3])
            case "--orka-recover" where helper, "--orka-builtin-recovery" where !helper:
                let lock = try FileLock(installation.state.appendingPathComponent("recovery-window.lock"), operation: LOCK_EX | LOCK_NB)
                let delegate = RecoveryWindow(installation: installation)
                let application = NSApplication.shared
                application.delegate = delegate
                application.setActivationPolicy(.accessory)
                withExtendedLifetime((delegate, lock)) { application.run() }
            case "--orka-update-watch" where arguments.count == 4:
                guard let pid = pid_t(arguments[1]), pid > 1,
                      versionParts(arguments[2]) != nil, UUID(uuidString: arguments[3]) != nil else { exit(1) }
                LaunchHealth(installation: installation, session: arguments[3], version: arguments[2]).watch(pid: pid)
            default:
                guard !helper else { exit(1) }
                try launch(installation, arguments: arguments)
            }
        } catch {
            FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
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
            if !headless { try openRecovery(installation) }
            return
        }
        if !headless {
            let session = UUID().uuidString
            let watchArguments = [String(getpid()), current.version, session]
            do {
                try installation.updaterProcess("--orka-update-watch", arguments: watchArguments).run()
            } catch {
                // A failed helper setup must still allow the desktop to open.
                let watcher = Process()
                watcher.executableURL = Bundle.main.executableURL
                watcher.arguments = ["--orka-update-watch"] + watchArguments
                watcher.standardInput = FileHandle.nullDevice
                watcher.standardOutput = FileHandle.nullDevice
                watcher.standardError = FileHandle.nullDevice
                try watcher.run()
            }
            setenv("ORKA_UPDATE_SESSION", session, 1)
        }
        // Keep the running lock through exec, preserving the LaunchServices PID for URLs and activation.
        guard fcntl(running.descriptor, F_SETFD, 0) == 0 else { throw UpdateError("Couldn’t start Orka.") }
        setenv("ORKA_UPDATE_LOCK", String(running.descriptor), 1)
        let forwarded = arguments.filter { $0 != "--orka-try-launch" }
        try withExtendedLifetime((maintenance, running)) {
            try replaceProcess(with: installation.desktopExecutable, arguments: forwarded)
        }
    }
}

struct UpdateStatus: Encodable {
    let installedVersion: String
    var update: Release?
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
        return UpdateStatus(installedVersion: current.version, update: feed.candidate(policy, current: current))
    } catch {
        return UpdateStatus(installedVersion: current.version, message: "Couldn’t verify the update feed. Try again when you’re online.")
    }
}

func openRecovery(_ installation: Installation) throws {
    do {
        try installation.updaterProcess("--orka-recover").run()
    } catch {
        try installation.openDesktop(arguments: ["--orka-builtin-recovery"])
    }
}

@MainActor
final class RecoveryWindow: NSObject, NSApplicationDelegate {
    let installation: Installation
    private var progress: NSWindow?

    init(installation: Installation) {
        self.installation = installation
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.activate(ignoringOtherApps: true)
        showProgress("Checking for Orka updates…")
        Task { await review() }
    }

    private func showProgress(_ title: String) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 135), styleMask: [.titled],
                              backing: .buffered, defer: false)
        window.title = "Update Orka"
        let label = NSTextField(labelWithString: title)
        let indicator = NSProgressIndicator()
        indicator.isIndeterminate = true
        indicator.startAnimation(nil)
        let stack = NSStackView(views: [label, indicator])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        if let content = window.contentView {
            content.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
                stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
                stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
                indicator.widthAnchor.constraint(equalTo: stack.widthAnchor),
            ])
        }
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
            alert.messageText = "Orka couldn’t keep running"
            var detail = "Installed version: \(current.version)."
            if let release = update.update {
                detail += "\n\nOrka \(release.version) is available."
                if !release.notes.isEmpty {
                    detail += "\n" + release.notes.prefix(240) + (release.notes.count > 240 ? "…" : "")
                }
            }
            if let previous { detail += "\n\nYou can restore Orka \(previous.version) from this Mac." }
            if let message = update.message { detail += "\n\n\(message)" }
            else if update.update == nil { detail += "\n\nNo compatible update is available." }
            alert.informativeText = detail
            var choices: [() async throws -> Void] = []
            if let release = update.update {
                alert.addButton(withTitle: "Install fix \(release.version)")
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
            alert.addButton(withTitle: "Try Opening Orka")
            choices.append { self.openOrka(bypass: true) }
            let cancel = alert.addButton(withTitle: "Later")
            cancel.keyEquivalent = "\u{1b}"
            let choice = alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
            if choices.indices.contains(choice) { try await choices[choice]() }
        } catch {
            progress?.orderOut(nil)
            message("Couldn’t update Orka", error.localizedDescription)
        }
        exit(0)
    }

    private func openOrka(bypass: Bool = false) {
        try? installation.openDesktop(arguments: bypass ? ["--orka-try-launch"] : [])
    }
}

func message(_ title: String, _ detail: String) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = detail
    alert.runModal()
}
