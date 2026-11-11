import CryptoKit
import Foundation
import Security

@main
struct RecoveryTests {
    static func main() async throws {
        let files = FileManager.default
        let scratch = files.temporaryDirectory.appendingPathComponent("orka-recovery-tests-\(UUID().uuidString)")
        try files.createDirectory(at: scratch, withIntermediateDirectories: false)
        defer { try? files.removeItem(at: scratch) }
        try policyTests(scratch)
        try lockTests(scratch)
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--plugin-app" {
            try await pluginMaintenanceTests(URL(fileURLWithPath: CommandLine.arguments[2]), scratch: scratch)
        } else if CommandLine.arguments.count == 2 {
            try await signedDrill(URL(fileURLWithPath: CommandLine.arguments[1]), scratch: scratch)
        }
        print("macOS recovery checks passed")
    }

    static func policyTests(_ scratch: URL) throws {
        let key = Curve25519.Signing.PrivateKey()
        let url = URL(string: "https://example.invalid/update.zip")!
        let feed = Feed(url: url, key: key.publicKey.rawRepresentation, directory: scratch)
        let now = Int64(Date().timeIntervalSince1970)
        let build = InstalledBuild(version: "0.3.0", dataEpoch: 1)
        let release = Release(version: "0.3.1", notes: "Test", url: url, sha256: String(repeating: "a", count: 64),
                              size: 42, architectures: [hostArchitecture()], minimumMacOS: "12.0.0", dataEpoch: 1)
        let first = Policy(schema: 1, sequence: 1, expires: now + 60, release: release, withdrawn: [], minimumVersion: "0.0.0")
        let withdrawn = Policy(schema: 1, sequence: 2, expires: now + 60, release: release,
                               withdrawn: [release.version], minimumVersion: "0.3.0")
        let expired = Policy(schema: 1, sequence: 3, expires: now - 1, release: release,
                             withdrawn: [], minimumVersion: "0.0.0")
        let undo = Policy(schema: 1, sequence: 3, expires: now + 60, release: release,
                          withdrawn: [], minimumVersion: "0.0.0")
        let original = try signed(first, key)
        try require(feed.candidate(feed.accept(original), current: build) == release, "verified update is offered")
        try require(feed.accept(original).sequence == 1, "unchanged signed feed can be refreshed")
        try Data().write(to: scratch.appendingPathComponent("skipped-0.3.1"))
        try require(feed.candidate(first, current: build) == nil, "restored-away version is suppressed locally")
        try require(feed.candidate(feed.accept(signed(withdrawn, key)), current: build) == nil, "withdrawn release is suppressed")
        try require(feed.cached()?.withdrawn == [release.version], "withdrawal is available offline")
        try rejects { _ = try feed.accept(original) }
        try rejects { _ = try feed.accept(signed(expired, key)) }
        try rejects { _ = try feed.accept(signed(undo, key)) }
        try rejects { _ = try feed.accept(signed(first, Curve25519.Signing.PrivateKey())) }
        try require(feed.cached()?.sequence == 2, "rejected feeds leave accepted state intact")
        print("signed policy, expiry, replay, withdrawal, and local skip passed")
    }

    static func lockTests(_ scratch: URL) throws {
        let path = scratch.appendingPathComponent("running.lock")
        var shared: FileLock? = try FileLock(path, operation: LOCK_SH | LOCK_NB)
        try require(shared != nil, "shared runtime lock was acquired")
        try rejects { _ = try FileLock(path, operation: LOCK_EX | LOCK_NB) }
        shared = nil
        let exclusive = try FileLock(path, operation: LOCK_EX | LOCK_NB)
        try withExtendedLifetime(exclusive) {
            try rejects { _ = try FileLock(path, operation: LOCK_SH | LOCK_NB) }
        }
        print("runtime and installer mutual exclusion passed")
    }

    static func pluginMaintenanceTests(_ source: URL, scratch: URL) async throws {
        let app = scratch.appendingPathComponent("Orka.app")
        try run("/usr/bin/ditto", [source.path, app.path])
        let installation = try Installation(app: app, info: Bundle(url: app)!.infoDictionary!)
        defer { try? FileManager.default.removeItem(at: installation.state) }
        let plugin = Process()
        plugin.executableURL = app.appendingPathComponent("Contents/MacOS/\(launcherName)")
        plugin.arguments = ["--orka-plugin"]
        let input = Pipe()
        let output = Pipe()
        plugin.standardInput = input
        plugin.standardOutput = output
        plugin.standardError = FileHandle.nullDevice
        try plugin.run()
        defer { if plugin.isRunning { plugin.terminate(); plugin.waitUntilExit() } }
        try input.fileHandleForWriting.write(contentsOf: Data("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n".utf8))
        let response = output.fileHandleForReading.availableData
        let reply = try JSONSerialization.jsonObject(with: response) as? [String: Any]
        try require(reply?["id"] as? Int == 1, "plugin serves requests before maintenance")
        try rejects { _ = try FileLock(installation.runningLock, operation: LOCK_EX | LOCK_NB) }
        let maintenance = try FileLock(installation.maintenanceLock, operation: LOCK_EX | LOCK_NB)
        defer { withExtendedLifetime(maintenance) {} }
        for _ in 0..<20 {
            if !plugin.isRunning { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        try require(!plugin.isRunning, "an idle plugin must exit for installation instead of holding the runtime lock")
        try require(plugin.terminationStatus == 0, "plugin exits cleanly for maintenance")
        let exclusive = try FileLock(installation.runningLock, operation: LOCK_EX | LOCK_NB)
        withExtendedLifetime(exclusive) {}
        print("real plugin requests, idle maintenance exit, and runtime lock release passed")
    }

    static func signedDrill(_ work: URL, scratch: URL) async throws {
        let files = FileManager.default
        let copy = scratch.appendingPathComponent("installation")
        try run("/usr/bin/ditto", [work.appendingPathComponent("installation/Orka.app").path, copy.appendingPathComponent("Orka.app").path])
        let app = copy.appendingPathComponent("Orka.app")
        var info = Bundle(url: app)!.infoDictionary!
        if let trust = NSDictionary(contentsOf: work.appendingPathComponent("trust.plist")) {
            info["OrkaUpdateFeed"] = trust["OrkaUpdateFeed"]
            info["OrkaUpdatePublicKey"] = trust["OrkaUpdatePublicKey"]
        }
        let root = try Data(contentsOf: work.appendingPathComponent("tls.der"))
        let installation = try Installation(app: app, info: info, supportDirectory: scratch.appendingPathComponent("isolated-support")) {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 2
            config.timeoutIntervalForResource = 10
            return URLSession(configuration: config, delegate: TestTLS(root: root), delegateQueue: nil)
        }
        let feed = installation.feed!
        let current = try InstalledBuild(at: app)
        let release = try await feed.refresh().release!
        try installation.verify(app)
        try installation.verify(installation.embeddedUpdater, id: recoveryID)
        try installation.provisionUpdater()
        try installation.verify(installation.updater, id: recoveryID)
        try require(helperVersion(installation.updater) == helperVersion(installation.embeddedUpdater),
                    "newer embedded helper replaces the older installed helper")
        try require(installation.updater != installation.embeddedUpdater, "the updater is installed outside the replaced bundle")
        try require(Bundle(url: installation.updater)?.object(forInfoDictionaryKey: "LSUIElement") as? Bool == true,
                    "the provisioned updater is a background app")
        try rejects { try installation.verifyDesktopCaller(getpid()) }
        let held = work.appendingPathComponent("downloads/revoke-after-download")
        let marker = scratch.appendingPathComponent("sqlite-and-outbox-sentinel")
        try Data("local workspace data".utf8).write(to: marker)
        try Data().write(to: installation.state.appendingPathComponent("healthy-\(current.version)"))
        try Data().write(to: work.appendingPathComponent("downloads/corrupt-download"))
        do {
            try await installation.install(release, replacing: current)
            throw TestFailure("tampered archive must be rejected")
        } catch let failure as TestFailure { throw failure }
        catch { print("tampered archive refused: \(error.localizedDescription)") }
        try require(InstalledBuild(at: app) == current, "tampered update must leave the installed app in place")
        try Data().write(to: held)
        do {
            try await installation.install(release, replacing: current)
            throw TestFailure("withdrawing during download must stop installation")
        } catch let failure as TestFailure { throw failure }
        catch { print("mid-download withdrawal refused: \(error.localizedDescription)") }
        try require(InstalledBuild(at: app) == current, "refused update must leave the installed app in place")
        try require(feed.cached()?.withdrawn.contains(release.version) == true, "withdrawal was observed before replacement")
        let hotfix = work.appendingPathComponent("downloads/hotfix.json")
        let manifest = work.appendingPathComponent("downloads/macos.json")
        try files.removeItem(at: manifest)
        try files.moveItem(at: hotfix, to: manifest)
        let approved = try await feed.refresh().release!
        let progress = ProgressLog()
        try await installation.install(approved, replacing: current, progress: progress.record)
        let events = progress.events
        try require(events.first?.phase == "downloading", "download begins before verification")
        try require(events.contains { $0.phase == "downloading" && ($0.downloadedBytes ?? 0) > 0 },
                    "real HTTPS download emits byte progress")
        try require(events.contains { $0.phase == "verifying" } && events.last?.phase == "restarting",
                    "verification and restart progress follow the download")
        let installed = try InstalledBuild(at: app)
        try require(installed.version == approved.version, "hotfix replaced Orka at the same path")
        try installation.provisionUpdater()
        try installation.verify(installation.updater, id: recoveryID)
        try require(helperVersion(installation.updater) == helperVersion(installation.embeddedUpdater),
                    "hotfix provisions the newer embedded helper")
        try require(installation.restoreCandidate(current: installed) == current, "verified original remains available")
        try files.removeItem(at: manifest)
        try await installation.restore(current, replacing: installed)
        try require(InstalledBuild(at: app) == current, "offline restore returned to the known-good version")
        try require(String(contentsOf: marker, encoding: .utf8) == "local workspace data", "restore preserved files outside app bundle")
        print("Developer ID signatures, independent helper, verified HTTPS download, hotfix, and offline restore passed")
    }

    static func signed(_ policy: Policy, _ key: Curve25519.Signing.PrivateKey) throws -> Data {
        let payload = try JSONEncoder().encode(policy)
        return try JSONEncoder().encode(SignedPolicy(payload: payload, signature: key.signature(for: payload)))
    }

    static func helperVersion(_ app: URL) -> String? {
        NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))?["CFBundleVersion"] as? String
    }

    static func require(_ predicate: @autoclosure () throws -> Bool, _ message: String) throws {
        if try !predicate() { throw TestFailure(message) }
    }

    static func rejects(_ block: () throws -> Void) throws {
        do { try block() }
        catch { return }
        throw TestFailure("operation unexpectedly succeeded")
    }
}

struct TestFailure: LocalizedError {
    let errorDescription: String?
    init(_ detail: String) { errorDescription = detail }
}

final class ProgressLog {
    private let lock = NSLock()
    private var values: [UpdateProgress] = []

    func record(_ progress: UpdateProgress) {
        lock.lock()
        defer { lock.unlock() }
        values.append(progress)
    }

    var events: [UpdateProgress] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}

final class TestTLS: NSObject, URLSessionTaskDelegate {
    let root: Data
    init(root: Data) { self.root = root }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        verify(challenge, completionHandler: completionHandler)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        verify(challenge, completionHandler: completionHandler)
    }

    private func verify(_ challenge: URLAuthenticationChallenge,
                        completionHandler: (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if let trust = challenge.protectionSpace.serverTrust, let certificate = SecCertificateCreateWithData(nil, root as CFData) {
            SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
            SecTrustSetAnchorCertificatesOnly(trust, true)
            var error: CFError?
            if SecTrustEvaluateWithError(trust, &error) {
                completionHandler(.useCredential, URLCredential(trust: trust))
                return
            }
            FileHandle.standardError.write(Data("Loopback trust evaluation: \(String(describing: error))\n".utf8))
        }
        completionHandler(.cancelAuthenticationChallenge, nil)
    }
}
