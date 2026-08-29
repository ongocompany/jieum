import Foundation
import os

/**
 진단 로그

 ⚠️ 이 프로세스는 사용자가 치는 **모든 것**을 본다. 입력 내용·조회 버퍼·확정된
 단어는 어떤 수준에서도 로그에 넣지 않는다 (docs/07 리스크 표: 구름입력기가 입력기
 프로세스에 Firebase를 링크해 둔 것이 반면교사).

 키 이벤트 추적은 M0의 C0.1 검증에 필요하지만 기본값이 아니다 — `JIEUM_DEBUG_KEYS=1`
 일 때만 켜지고, 그때도 키코드와 수식키만 남긴다.
 */
enum Log {
    private static let logger = Logger(subsystem: "com.ongocompany.inputmethod.Jieum", category: "ime")

    /// 키 이벤트 추적이 켜져 있는가 (기본 꺼짐)
    static let keyTracing: Bool = ProcessInfo.processInfo.environment["JIEUM_DEBUG_KEYS"] == "1"

    /**
     진단 한 줄.

     `notice` 수준으로 낸다. `info`는 기본 설정에서 **메모리에만 남고 로그 저장소에
     기록되지 않아** `log show`로 사후 확인이 되지 않는다. 시스템이 띄운 입력기는
     stderr가 어디에도 닿지 않으므로, 사후에 읽을 수 없는 로그는 없는 것과 같다.
     빈도가 낮은 줄만 여기로 보내므로 `notice`가 과하지 않다.
     */
    static func info(_ message: String) {
        logger.notice("\(message, privacy: .public)")
        // 디버그 설치로 직접 띄웠을 때 바로 보이도록 stderr에도 낸다
        FileHandle.standardError.write(Data("[지음] \(message)\n".utf8))
    }

    static func error(_ message: String) {
        logger.error("\(message, privacy: .public)")
        FileHandle.standardError.write(Data("[지음][오류] \(message)\n".utf8))
    }

    /// 키 추적 전용. 내용이 아니라 키코드만 받는다 (타입이 강제한다)
    static func key(keyCode: UInt16, modifiers: UInt) {
        guard keyTracing else { return }
        info("key keyCode=\(keyCode) modifiers=\(modifiers)")
    }

    // MARK: - 파일 진단

    private static let diagnosticURL = FileManager.default
        .homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Jieum/diagnostic.log")

    /// 이 크기를 넘으면 한 번 밀어 두고 새로 시작한다 (직전 한 세대까지 남는다)
    private static let rotateThreshold = 2 * 1024 * 1024

    /// 핸들과 크기 계산을 지키는 직렬 큐
    private static let fileQueue = DispatchQueue(label: "com.ongocompany.jieum.diagnostic-log")
    private static var handle: FileHandle?
    /// 지금 핸들로 쓴 바이트 수. 줄마다 파일 크기를 묻지 않으려고 세어 둔다
    private static var writtenBytes = 0
    /// 회전이 한 번 실패하면 이 프로세스에서는 다시 시도하지 않는다 (아래 rotateOnQueue)
    private static var rotationBroken = false
    private static let timestamps = ISO8601DateFormatter()

    /**
     파일로 남기는 진단 한 줄.

     시스템이 띄운 입력기는 stderr가 어디에도 닿지 않고, `os.Logger`도 이 프로세스에
     대해서는 `log show`로 잡히지 않았다(notice 수준으로 올려도 마찬가지). 사후에 읽을
     수 없는 로그는 없는 것과 같아서, 읽을 수 있는 곳에 직접 쓴다.

     ⚠️ **여기에도 입력 내용은 넣지 않는다.** 길이·개수·성공 여부만 쓴다.

     ## 왜 여전히 동기인가

     비동기로 큐에 넣으면 프로세스가 죽는 순간 대기 중인 줄이 사라진다. 이 로그의
     제일 중요한 용도가 바로 **조용히 죽는 기동을 추적하는 브레드크럼**이므로
     (`main.swift`), 마지막 한 줄을 잃으면 장치 자체가 무의미해진다. 그래서 쓰기는
     동기로 두고, 대신 줄마다 파일을 열고 닫던 것을 핸들 재사용으로 바꿨다.

     핸들은 `O_APPEND`로 연다. `seekToEnd` 후 쓰기는 두 스레드가 같은 오프셋을 잡으면
     서로 덮어쓰지만, `O_APPEND`의 쓰기는 커널이 원자적으로 끝에 붙인다.
     */
    static func diagnostic(_ message: String) {
        let now = Date()
        fileQueue.sync {
            let line = "\(timestamps.string(from: now)) \(message)\n"
            guard let data = line.data(using: .utf8) else { return }
            appendOnQueue(data)
        }
    }

    /// **반드시 `fileQueue` 위에서만 부른다.**
    private static func appendOnQueue(_ data: Data) {
        if handle == nil { openOnQueue() }
        guard let handle else { return }

        try? handle.write(contentsOf: data)
        writtenBytes += data.count
        if writtenBytes >= rotateThreshold, !rotationBroken { rotateOnQueue() }
    }

    /// **반드시 `fileQueue` 위에서만 부른다.**
    private static func openOnQueue() {
        let directory = diagnosticURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let fd = open(diagnosticURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        guard fd >= 0 else { return }
        handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)

        // 이어 쓰는 경우 기존 크기부터 세야 회전이 제때 걸린다
        let size = (try? FileManager.default.attributesOfItem(atPath: diagnosticURL.path)[.size])
        writtenBytes = (size as? Int) ?? 0
    }

    /// **반드시 `fileQueue` 위에서만 부른다.**
    private static func rotateOnQueue() {
        handle = nil  // closeOnDealloc이 파일을 닫는다

        let previous = diagnosticURL.appendingPathExtension("1")
        try? FileManager.default.removeItem(at: previous)
        try? FileManager.default.moveItem(at: diagnosticURL, to: previous)

        // 새 파일이면 0으로 다시 센다. 옮기기가 실패했다면 여전히 임계 이상이 나오는데,
        // 그대로 두면 줄마다 회전을 시도해 파일시스템만 두드리게 된다 — 한 번 실패하면
        // 이 프로세스에서는 접는다. 로그가 커지는 것이 진단을 잃는 것보다 낫다
        openOnQueue()
        if writtenBytes >= rotateThreshold {
            rotationBroken = true
            Log.info("진단 로그 회전 실패 — 이 프로세스에서는 다시 시도하지 않는다")
        }
    }
}
