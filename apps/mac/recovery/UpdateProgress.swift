import Foundation

struct UpdateProgress: Encodable {
    let phase: String
    var downloadedBytes: Int64? = nil
    var totalBytes: Int? = nil
}

final class UpdateDownload: HTTPSOnly, URLSessionDownloadDelegate {
    let size: Int
    let progress: (UpdateProgress) -> Void
    private var lastPercent = -1
    private var completion: CheckedContinuation<(URL, URLResponse), Error>?
    private var result: Result<(URL, URLResponse), Error>?

    init(size: Int, progress: @escaping (UpdateProgress) -> Void) {
        self.size = size
        self.progress = progress
    }

    func download(from url: URL, using session: URLSession) async throws -> (URL, URLResponse) {
        try await withCheckedThrowingContinuation { completion in
            self.completion = completion
            let task = session.downloadTask(with: url)
            task.delegate = self
            task.resume()
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        do {
            guard let response = downloadTask.response else { throw UpdateError("The update server is unavailable.") }
            let archive = FileManager.default.temporaryDirectory.appendingPathComponent("orka-update-\(UUID().uuidString).zip")
            try FileManager.default.moveItem(at: location, to: archive)
            result = .success((archive, response))
        } catch {
            result = .failure(error)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            if case .success(let (archive, _)) = result { try? FileManager.default.removeItem(at: archive) }
            completion?.resume(throwing: error)
        } else {
            completion?.resume(with: result ?? .failure(UpdateError("The update download did not finish.")))
        }
        completion = nil
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        let percent = Int(min(totalBytesWritten, Int64(size)) * 100 / Int64(size))
        guard percent != lastPercent else { return }
        lastPercent = percent
        progress(UpdateProgress(phase: "downloading", downloadedBytes: totalBytesWritten, totalBytes: size))
    }
}
