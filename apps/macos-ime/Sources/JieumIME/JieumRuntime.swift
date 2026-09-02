import Foundation

/**
 입력기 프로세스 전역 상태

 IMK는 앱 하나에 여러 {@link JieumInputController} 인스턴스를 만든다 (대략 텍스트
 입력 지점마다 하나). 엔진 연결은 그 전부가 공유해야 하므로 여기 둔다.
 */
final class JieumRuntime {
    static let shared = JieumRuntime()

    let client = EngineClient()
    let latency = LatencyRecorder()

    private(set) var serverVersion: String?
    private(set) var dictFingerprint: String?

    // 영문 모드(`isLatinMode`)는 2026-08-02에 걷어냈다. 한/영은 시스템 입력 소스
    // 전환에 맡긴다 — 입력 소스와 내부 모드가 어긋나면 "지음인데 한글이 안 쳐진다"가
    // 되고, 화면 표시는 멀쩡해서 원인을 찾을 수 없다.
    // 자세한 경위는 `JieumInputController.handle`의 주석과 `docs/notes/macos-app-compat.md`.

    /// 재연결 시도를 직렬화하는 큐. 입력 경로(주 스레드)를 절대 붙잡지 않는다
    private let reconnectQueue = DispatchQueue(label: "com.ongocompany.jieum.reconnect")
    private var reconnecting = false
    private var lastAttempt: Date?

    /**
     재연결 시도 간격

     엔진이 죽어 있는 동안 키를 칠 때마다 프로세스를 띄우려 들면 안 된다.
     사전 로드에 0.4초가 걸리므로 실패가 몰리면 기계가 눈에 띄게 느려진다.
     */
    private let retryInterval: TimeInterval = 3

    private init() {}

    func start() {
        ensureConnected()
    }

    /**
     끊겨 있으면 배경에서 다시 붙는다. **호출자를 막지 않는다.**

     엔진이 죽어도 타이핑은 멈추지 않아야 한다 (docs/07 D6). 그래서 이 함수는
     연결 여부와 무관하게 즉시 돌아오고, 실제 연결은 배경에서 일어난다.
     붙는 데 성공하면 다음 조회부터 제안이 돌아온다.
     */
    func ensureConnected() {
        if client.isConnected { return }

        reconnectQueue.async { [weak self] in
            guard let self, !self.reconnecting, !self.client.isConnected else { return }

            // 너무 자주 두드리지 않는다
            if let last = self.lastAttempt, Date().timeIntervalSince(last) < self.retryInterval {
                return
            }
            self.reconnecting = true
            self.lastAttempt = Date()
            defer { self.reconnecting = false }

            guard EngineLauncher.ensureRunning(client: self.client) else { return }
            self.handshake()
        }
    }

    private func handshake() {
        client.hello(clientVersion: "macos-ime/\(Bundle.main.shortVersion)") { [weak self] result in
            switch result {
            case let .success(reply):
                guard reply.protocolV == JieumProtocol.version else {
                    // 버전 불일치는 조용히 넘어가지 않는다. 조용히 넘어가면 셸이
                    // 엉뚱한 모양의 응답을 반쯤 해석해서 원인 모를 오작동이 된다.
                    Log.error(
                        "프로토콜 버전 불일치: 셸 v\(JieumProtocol.version), "
                            + "엔진 v\(reply.protocolV) — 제안을 끈다")
                    self?.client.disconnect()
                    return
                }
                self?.serverVersion = reply.serverVersion
                self?.dictFingerprint = reply.dictFingerprint
                Log.info("엔진 \(reply.serverVersion) · 사전 \(reply.dictFingerprint)")
                Log.diagnostic("엔진 연결됨 \(reply.serverVersion)/\(reply.dictFingerprint)")
            case let .failure(error):
                Log.error("악수 실패: \(error)")
            }
        }
    }
}

extension Bundle {
    var shortVersion: String {
        (infoDictionary?["CFBundleShortVersionString"] as? String) ?? "dev"
    }

    var buildVersion: String {
        (infoDictionary?["CFBundleVersion"] as? String) ?? "dev"
    }

    var displayVersion: String {
        "\(shortVersion) (\(buildVersion))"
    }
}
