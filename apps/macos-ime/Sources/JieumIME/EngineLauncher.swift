import Foundation

/**
 엔진 프로세스 기동·연결

 M0는 가장 단순한 방식으로 간다: 소켓이 살아 있으면 그것을 쓰고(다른 앱의 입력기
 인스턴스가 이미 띄웠을 수 있다), 없으면 직접 띄운다. launchd 온디맨드 등록은
 M3의 다듬기 항목이지 M0의 요건이 아니다 (docs/07 §2).

 엔진이 없거나 죽어도 **입력기는 정상 동작해야 한다** — 제안만 사라진다 (D6).
 그래서 이 파일의 어떤 실패 경로도 앱을 종료시키지 않는다.
 */
enum EngineLauncher {

    static var appSupportDir: URL {
        FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Jieum", isDirectory: true)
    }

    static var socketPath: String {
        if let override = ProcessInfo.processInfo.environment["JIEUM_SOCKET"] {
            return override
        }
        return appSupportDir.appendingPathComponent("engine.sock").path
    }

    /**
     엔진 바이너리를 찾는다.

     배포판(M4)에서는 앱 번들 안에 들어간다. 개발 중에는 repo의 빌드 산출물을
     환경변수로 가리킨다 — 번들을 다시 조립하지 않고 엔진만 다시 컴파일해도
     되게 하려는 것이다.
     */
    static func resolveBinary() -> String? {
        if let override = ProcessInfo.processInfo.environment["JIEUM_ENGINE_BIN"],
           FileManager.default.isExecutableFile(atPath: override) {
            return override
        }
        if let bundled = Bundle.main.url(forResource: "jieum-engine", withExtension: nil),
           FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled.path
        }
        return nil
    }

    /// 이미 도는 엔진에 붙거나, 없으면 띄우고 붙는다. 실패해도 던지지 않는다.
    @discardableResult
    static func ensureRunning(client: EngineClient, timeout: TimeInterval = 10) -> Bool {
        if client.connect(socketPath: socketPath) {
            Log.info("이미 도는 엔진에 붙었다")
            return true
        }

        guard let binary = resolveBinary() else {
            Log.error("엔진 바이너리를 찾지 못했다 — 제안 없이 동작한다. "
                + "JIEUM_ENGINE_BIN을 지정하거나 번들에 넣어라")
            return false
        }

        try? FileManager.default.createDirectory(
            at: appSupportDir, withIntermediateDirectories: true)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = ["--socket", socketPath]

        // 번들에 사전이 있으면 그것을 쓴다.
        //
        // 엔진은 사전을 스스로 찾지만, 마지막 수단이 **cwd에서 위로 올라가며 repo의
        // data/build를 뒤지는 것**이다. 개발 기계에서는 그게 걸려서 잘 돌지만
        // 남의 기계에는 repo가 없다 — 배포판이 조용히 사전 없이 뜨는 길이다.
        // 번들 경로를 명시로 넘겨 그 탐색에 기대지 않는다.
        if let dict = Bundle.main.url(forResource: "dict", withExtension: nil),
           FileManager.default.fileExists(atPath: dict.path) {
            var env = ProcessInfo.processInfo.environment
            // 명시가 이긴다 — 개발 중 JIEUM_DICT_DIR로 다른 사전을 물릴 수 있어야 한다
            if env["JIEUM_DICT_DIR"] == nil { env["JIEUM_DICT_DIR"] = dict.path }
            process.environment = env
            Log.info("번들 사전을 쓴다: \(dict.path)")
        }
        // 엔진의 출력은 입력기 로그와 섞지 않는다. 진단이 필요하면 엔진을 직접 띄운다.
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            Log.info("엔진을 띄웠다 (pid \(process.processIdentifier))")
        } catch {
            Log.error("엔진 기동 실패: \(error.localizedDescription)")
            return false
        }

        // 사전 로드에 0.5초쯤 걸린다. 소켓이 생길 때까지 짧은 간격으로 다시 시도한다.
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if client.connect(socketPath: socketPath) {
                Log.info("엔진에 붙었다")
                return true
            }
            Thread.sleep(forTimeInterval: 0.1)
        }

        Log.error("엔진이 \(Int(timeout))초 안에 뜨지 않았다 — 제안 없이 동작한다")
        return false
    }
}
