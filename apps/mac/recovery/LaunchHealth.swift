import Foundation

struct CrashRecord: Codable {
    var failures: [Int64] = []
    private static let window: Int64 = 600

    var repeated: Bool { recent.count >= 2 }
    private var recent: [Int64] {
        let now = Int64(Date().timeIntervalSince1970)
        return failures.filter { $0 <= now && now - $0 <= Self.window }
    }

    private static func file(_ installation: Installation, _ version: String) -> URL {
        installation.state.appendingPathComponent("crashes-\(version).json")
    }

    static func load(_ installation: Installation, version: String) -> Self {
        let data = try? Data(contentsOf: file(installation, version))
        return data.flatMap { try? JSONDecoder().decode(Self.self, from: $0) } ?? Self()
    }

    static func record(_ installation: Installation, version: String) -> Self {
        guard let lock = try? FileLock(installation.state.appendingPathComponent("health.lock"), operation: LOCK_EX) else { return Self() }
        return withExtendedLifetime(lock) {
            var record = load(installation, version: version)
            record.failures = Array(record.recent.suffix(3)) + [Int64(Date().timeIntervalSince1970)]
            try? JSONEncoder().encode(record).write(to: file(installation, version), options: .atomic)
            return record
        }
    }
}

struct LaunchHealth {
    let installation: Installation
    let session: String
    let version: String

    private func marker(_ name: String) -> URL {
        installation.state.appendingPathComponent("\(session).\(name)")
    }

    static func isHealthy(_ installation: Installation, version: String) -> Bool {
        installation.files.fileExists(atPath: installation.state.appendingPathComponent("healthy-\(version)").path)
    }

    func watch(pid: pid_t) -> Never {
        let queue = DispatchQueue(label: "ai.tryorka.update-health")
        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: queue)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        let began = DispatchTime.now()
        let ready = marker("ready")
        let clean = marker("clean")
        let healthy = installation.state.appendingPathComponent("healthy-\(version)")
        let observedExit = {
            let quit = installation.files.fileExists(atPath: clean.path)
            let opened = installation.files.fileExists(atPath: ready.path)
            try? installation.files.removeItem(at: ready)
            try? installation.files.removeItem(at: clean)
            if quit && opened { try? Data().write(to: healthy, options: .atomic) }
            if !quit {
                let record = CrashRecord.record(installation, version: version)
                if !opened || record.repeated {
                    try? openRecovery(installation, mode: "--launch-failure")
                }
            }
            exit(0)
        }
        source.setEventHandler(handler: observedExit)
        timer.setEventHandler {
            if kill(pid, 0) == -1 && errno == ESRCH { observedExit() }
            if DispatchTime.now() >= began + .seconds(30), installation.files.fileExists(atPath: ready.path) {
                try? Data().write(to: healthy, options: .atomic)
                timer.cancel()
            }
        }
        timer.schedule(deadline: .now(), repeating: .seconds(2))
        source.resume()
        timer.resume()
        withExtendedLifetime((source, timer)) { dispatchMain() }
    }
}
