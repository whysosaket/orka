import CryptoKit
import Foundation

struct UpdateError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

struct Release: Codable, Equatable {
    let version: String
    let notes: String
    let url: URL
    let sha256: String
    let size: Int
    let architectures: [String]
    let minimumMacOS: String
    let dataEpoch: Int

    func validate() throws {
        guard versionParts(version) != nil, versionParts(minimumMacOS) != nil,
              notes.utf8.count <= 4000, isHTTPS(url),
              sha256.utf8.count == 64, sha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              size > 0, size <= 250_000_000, dataEpoch > 0,
              !architectures.isEmpty, Set(architectures).isSubset(of: ["arm64", "x86_64"])
        else { throw UpdateError("The update feed contains an invalid release.") }
    }
}

struct Policy: Codable {
    let schema: Int
    let sequence: Int
    let expires: Int64
    let release: Release?
    let withdrawn: [String]
    let minimumVersion: String

    func allows(_ version: String) -> Bool {
        !withdrawn.contains(version) && compareVersion(version, minimumVersion) != .orderedAscending
    }
}

struct SignedPolicy: Codable {
    let payload: Data
    let signature: Data

    static func verify(_ data: Data, key: Data, now: Date = Date(), requireFresh: Bool = true) throws -> Policy {
        let decoder = JSONDecoder()
        let envelope = try decoder.decode(Self.self, from: data)
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: key)
        guard publicKey.isValidSignature(envelope.signature, for: envelope.payload) else {
            throw UpdateError("The update feed signature is invalid.")
        }
        let policy = try decoder.decode(Policy.self, from: envelope.payload)
        guard policy.schema == 1, policy.sequence > 0, versionParts(policy.minimumVersion) != nil,
              policy.withdrawn.allSatisfy({ versionParts($0) != nil }) else {
            throw UpdateError("The update feed format is invalid.")
        }
        let current = Int64(now.timeIntervalSince1970)
        if requireFresh && (policy.expires <= current || policy.expires > current + 2 * 86_400 + 300) {
            throw UpdateError("The update feed is out of date.")
        }
        try policy.release?.validate()
        return policy
    }
}

func versionParts(_ value: String) -> [Int]? {
    let parts = value.split(separator: ".", omittingEmptySubsequences: false)
    let numbers = parts.compactMap { part -> Int? in
        guard part.utf8.count <= 9, part.utf8.allSatisfy({ (48...57).contains($0) }),
              let number = Int(part), String(number) == part else { return nil }
        return number
    }
    return numbers.count == 3 && parts.count == 3 ? numbers : nil
}

func compareVersion(_ lhs: String, _ rhs: String) -> ComparisonResult {
    let left = versionParts(lhs) ?? [0, 0, 0]
    let right = versionParts(rhs) ?? [0, 0, 0]
    if left == right { return .orderedSame }
    return left.lexicographicallyPrecedes(right) ? .orderedAscending : .orderedDescending
}

func isHTTPS(_ url: URL) -> Bool {
    url.scheme == "https" && url.host != nil && url.user == nil && url.password == nil && url.fragment == nil
}

func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func hostArchitecture() -> String {
    var arm: Int32 = 0
    var size = MemoryLayout<Int32>.size
    sysctlbyname("hw.optional.arm64", &arm, &size, nil, 0)
    return arm == 1 ? "arm64" : "x86_64"
}

final class HTTPSOnly: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(request.url.map(isHTTPS) == true ? request : nil)
    }
}

struct Feed {
    let url: URL
    let key: Data
    let directory: URL
    var makeSession: () -> URLSession = networkSession
    private var cachedFile: URL { directory.appendingPathComponent("policy.json") }

    func cached() -> Policy? {
        guard let data = try? Data(contentsOf: cachedFile) else { return nil }
        return try? SignedPolicy.verify(data, key: key, requireFresh: false)
    }

    func refresh(bypassCache: Bool = false) async throws -> Policy {
        let session = makeSession()
        defer { session.finishTasksAndInvalidate() }
        var address = url
        if bypassCache, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "orka-check", value: UUID().uuidString)]
            address = components.url ?? url
        }
        var request = URLRequest(url: address)
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        let (bytes, response) = try await session.bytes(for: request)
        try checkResponse(response)
        var data = Data()
        for try await byte in bytes {
            guard data.count < 65_536 else { throw UpdateError("The update feed is too large.") }
            data.append(byte)
        }
        return try accept(data)
    }

    func accept(_ data: Data) throws -> Policy {
        let policy = try SignedPolicy.verify(data, key: key)
        let lock = try FileLock(directory.appendingPathComponent("policy.lock"), operation: LOCK_EX)
        return try withExtendedLifetime(lock) {
            if let previous = try? Data(contentsOf: cachedFile),
               let cached = try? SignedPolicy.verify(previous, key: key, requireFresh: false) {
                let samePayload = try JSONDecoder().decode(SignedPolicy.self, from: previous).payload
                    == JSONDecoder().decode(SignedPolicy.self, from: data).payload
                guard policy.sequence > cached.sequence || (policy.sequence == cached.sequence && samePayload) else {
                    throw UpdateError("The update feed is older than a previously verified feed.")
                }
                guard Set(policy.withdrawn).isSuperset(of: cached.withdrawn),
                      compareVersion(policy.minimumVersion, cached.minimumVersion) != .orderedAscending else {
                    throw UpdateError("The update feed attempted to restore a withdrawn release.")
                }
            }
            try data.write(to: cachedFile, options: .atomic)
            return policy
        }
    }

    func candidate(_ policy: Policy, current: InstalledBuild) -> Release? {
        guard let release = policy.release, policy.allows(release.version),
              compareVersion(release.version, current.version) == .orderedDescending,
              release.architectures.contains(hostArchitecture()), release.dataEpoch >= current.dataEpoch,
              !FileManager.default.fileExists(atPath: directory.appendingPathComponent("skipped-\(release.version)").path) else { return nil }
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let version = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
        return compareVersion(version, release.minimumMacOS) == .orderedAscending ? nil : release
    }
}

func networkSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 8
    configuration.timeoutIntervalForResource = 180
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    return URLSession(configuration: configuration, delegate: HTTPSOnly(), delegateQueue: nil)
}

func checkResponse(_ response: URLResponse) throws {
    guard let http = response as? HTTPURLResponse, http.statusCode == 200,
          http.url.map(isHTTPS) == true else { throw UpdateError("The update server is unavailable.") }
}

final class FileLock {
    let descriptor: Int32

    init(_ path: URL, operation: Int32) throws {
        let fd = open(path.path, O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_RDWR, 0o600)
        guard fd >= 0 else { throw UpdateError("Couldn’t open the Orka update lock.") }
        guard flock(fd, operation) == 0 else {
            close(fd)
            throw UpdateError("Another Orka process is busy. Try again in a moment.")
        }
        descriptor = fd
    }

    deinit { close(descriptor) }
}
