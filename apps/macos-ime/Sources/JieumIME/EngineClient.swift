import Foundation

/**
 엔진 서버 클라이언트 (NDJSON over unix domain socket)

 **여기에 변환 로직은 없다.** 이 파일이 하는 일은 바이트를 주고받는 것뿐이며,
 무엇이 후보인지·어떤 순서인지는 전적으로 서버가 정한다 (docs/07 §0).

 조회는 비동기다. 엔진이 죽어도 타이핑은 멈추지 않아야 하고, 제안만 사라져야
 한다 (D6). 그래서 이 클라이언트의 어떤 경로도 입력 처리 스레드를 무한정 붙잡지
 않는다 — 동기 호출은 벤치 전용으로만 두고 반드시 시간 상한을 받는다.
 */
final class EngineClient {

    private var fd: Int32 = -1
    private let queue = DispatchQueue(label: "com.ongocompany.jieum.engine-client")
    private var readSource: DispatchSourceRead?
    private var inbox = Data()
    private var nextId = 1
    private var pending: [Int: (Result<Data, EngineError>) -> Void] = [:]

    /// 지금까지 본 최대 조회 토큰. 이보다 낮은 응답은 낡았으므로 버린다 (latest-wins)
    private var highestToken = 0

    private(set) var isConnected = false

    // MARK: - 연결

    /// 소켓에 붙는다. 이미 붙어 있으면 아무것도 하지 않는다.
    @discardableResult
    func connect(socketPath: String) -> Bool {
        return queue.sync {
            if isConnected { return true }

            let sock = socket(AF_UNIX, SOCK_STREAM, 0)
            guard sock >= 0 else {
                Log.error("소켓 생성 실패: errno=\(errno)")
                return false
            }

            var addr = sockaddr_un()
            addr.sun_family = sa_family_t(AF_UNIX)
            let pathBytes = Array(socketPath.utf8)
            let capacity = MemoryLayout.size(ofValue: addr.sun_path)
            guard pathBytes.count < capacity else {
                Log.error("소켓 경로가 너무 길다 (\(pathBytes.count) >= \(capacity))")
                close(sock)
                return false
            }
            withUnsafeMutableBytes(of: &addr.sun_path) { raw in
                raw.copyBytes(from: pathBytes)
                raw[pathBytes.count] = 0
            }

            let connected = withUnsafePointer(to: &addr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                    Darwin.connect(sock, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard connected == 0 else {
                close(sock)
                return false
            }

            // unix 도메인 소켓에는 Nagle이 없다 — TCP_NODELAY 같은 것을 걸 필요가 없다.
            // (TCP 전송으로 바꾸는 날에는 여기서 다시 생각해야 한다)

            fd = sock
            isConnected = true
            startReading()
            return true
        }
    }

    private func startReading() {
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in self?.drainSocket() }
        source.setCancelHandler { [weak self] in
            guard let self else { return }
            if self.fd >= 0 { close(self.fd) }
            self.fd = -1
        }
        readSource = source
        source.resume()
    }

    private func drainSocket() {
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        let n = read(fd, &chunk, chunk.count)

        if n <= 0 {
            // 0 = 서버가 닫음, 음수 = 오류. 어느 쪽이든 엔진이 사라진 것이다.
            Log.error("소켓 읽기 종료: n=\(n) errno=\(errno)")
            handleDisconnect()
            return
        }

        inbox.append(contentsOf: chunk[0..<n])

        // 줄 단위로 잘라낸다. **바이트에서 자르고 줄 단위로만 UTF-8 디코딩**하므로
        // chunk 경계가 한글 3바이트 중간을 잘라도 글자가 깨지지 않는다.
        while let newlineIndex = inbox.firstIndex(of: 0x0A) {
            let line = inbox[inbox.startIndex..<newlineIndex]
            inbox = inbox[inbox.index(after: newlineIndex)...]
            if !line.isEmpty { dispatchReply(Data(line)) }
        }
    }

    private func dispatchReply(_ line: Data) {
        // 어떤 요청의 응답인지만 먼저 본다. 본문 해석은 요청자의 몫이다.
        guard
            let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            let id = object["id"] as? Int
        else {
            Log.error("응답에 id가 없다")
            return
        }

        guard let waiter = pending.removeValue(forKey: id) else { return }

        if let ok = object["ok"] as? Bool, ok == false {
            let err = (try? JSONDecoder().decode(WireError.self, from: line))?.error
            waiter(.failure(.server(code: err?.code ?? "unknown", message: err?.message ?? "")))
            return
        }
        waiter(.success(line))
    }

    private func handleDisconnect() {
        isConnected = false
        readSource?.cancel()
        readSource = nil
        let waiters = pending
        pending.removeAll()
        highestToken = 0
        inbox.removeAll()
        for (_, waiter) in waiters { waiter(.failure(.notConnected)) }
        Log.info("엔진 연결이 끊겼다 — 타이핑은 계속되고 제안만 멈춘다")
    }

    func disconnect() {
        queue.sync { handleDisconnect() }
    }

    // MARK: - 요청

    /**
     요청을 보내고 응답을 기다린다.

     ⚠️ `completion`은 **언제나 `queue`(이 클라이언트의 직렬 큐) 위에서** 불린다 —
     성공·실패·시간 초과·연결 없음 모두 그렇다. 그래서 completion 안에서 다시
     `queue.sync`를 부르면 교착한다. 내부 상태(highestToken 등)는 completion 안에서
     잠금 없이 그냥 읽고 쓰면 된다.
     */
    private func send(
        op: String,
        payload: [String: Any],
        timeout: TimeInterval,
        completion: @escaping (Result<Data, EngineError>) -> Void
    ) {
        queue.async {
            guard self.isConnected else {
                completion(.failure(.notConnected))
                return
            }

            let id = self.nextId
            self.nextId += 1

            var body: [String: Any] = payload
            body["v"] = JieumProtocol.version
            body["id"] = id
            body["op"] = op

            guard var data = try? JSONSerialization.data(withJSONObject: body) else {
                completion(.failure(.decode("요청 직렬화 실패")))
                return
            }
            data.append(0x0A)

            self.pending[id] = completion

            let written = data.withUnsafeBytes { raw -> Int in
                write(self.fd, raw.baseAddress, raw.count)
            }
            if written != data.count {
                self.pending.removeValue(forKey: id)
                completion(.failure(.notConnected))
                return
            }

            // 응답이 영영 오지 않는 경우를 대비한다. 대기자가 쌓이면 메모리도 새고,
            // 무엇보다 호출자가 영원히 기다리게 된다.
            self.queue.asyncAfter(deadline: .now() + timeout) {
                if let waiter = self.pending.removeValue(forKey: id) {
                    waiter(.failure(.timeout))
                }
            }
        }
    }

    /**
     응답 본문 해석.

     `try?`로 삼키지 않는다. 실제로 당했다: `level`이 소수로 오는 것을 Swift가
     `Int`로 받아 조회 응답 전체가 해석 실패했는데, 증상은 "제안이 아예 안 뜬다"뿐이라
     소켓·엔진·사전을 차례로 의심하고 나서야 원인에 닿았다. 왜 실패했는지가 남아야 한다.
     */
    private func decode<T: Decodable>(_ type: T.Type, from data: Data) -> Result<T, EngineError> {
        do {
            return .success(try JSONDecoder().decode(type, from: data))
        } catch {
            return .failure(.decode("\(type) — \(error)"))
        }
    }

    func hello(clientVersion: String, completion: @escaping (Result<HelloReply, EngineError>) -> Void) {
        send(op: "hello", payload: ["clientVersion": clientVersion], timeout: 3.0) { [weak self] result in
            guard let self else { return }
            completion(result.flatMap { self.decode(HelloReply.self, from: $0) })
        }
    }

    func ping(completion: @escaping (Result<PingReply, EngineError>) -> Void) {
        send(op: "ping", payload: [:], timeout: 3.0) { [weak self] result in
            guard let self else { return }
            completion(result.flatMap { self.decode(PingReply.self, from: $0) })
        }
    }

    /**
     후보 조회.

     낡은 응답(이미 본 토큰 이하)은 `nil`로 걸러 준다. 타이핑 중에는 조회가 응답보다
     빨리 나가므로 순서가 뒤집히고, 그것을 거르지 않으면 팝업이 한 글자 전 후보로
     되돌아간다.
     */
    func lookup(
        buffer: String,
        precedingText: String?,
        sessionId: String? = nil,
        timeout: TimeInterval = 1.0,
        completion: @escaping (Result<LookupReply?, EngineError>) -> Void
    ) {
        var payload: [String: Any] = ["buffer": buffer]
        if let precedingText { payload["precedingText"] = precedingText }
        // ⚠️ 세션을 함께 보낸다. 서버가 「낱자가 이어서 쳐졌는가」를 세션 단위로
        // 판정하기 때문이다. 규약에는 이 칸이 처음부터 있었는데 셸이 안 채우고
        // 있었고, 그대로 뒀으면 사용자 조합 학습이 조용히 안 돌았다 (2026-08-28).
        if let sessionId { payload["sessionId"] = sessionId }

        send(op: "lookup", payload: payload, timeout: timeout) { [weak self] result in
            guard let self else { return }
            completion(
                result
                    .flatMap { self.decode(LookupReply.self, from: $0) }
                    .map { reply in
                        // 이 블록은 이미 queue 위에서 돈다 (send 주석 참조) — 잠금이
                        // 필요 없고, 잠그면 오히려 교착한다.
                        guard reply.token > self.highestToken else { return nil }
                        self.highestToken = reply.token
                        return reply
                    })
        }
    }

    /// 입력 지점 하나에 세션 하나 (IMKInputController 인스턴스 단위)
    func sessionOpen(completion: @escaping (Result<String, EngineError>) -> Void) {
        send(op: "sessionOpen", payload: [:], timeout: 3.0) { [weak self] result in
            guard let self else { return }
            completion(
                result
                    .flatMap { self.decode(SessionOpenReply.self, from: $0) }
                    .map(\.sessionId))
        }
    }

    /// 세션을 닫는다. 응답을 기다릴 이유가 없다 (실패해도 서버가 연결 종료로 정리한다)
    func sessionClose(_ sessionId: String) {
        send(op: "sessionClose", payload: ["sessionId": sessionId], timeout: 3.0) { _ in }
    }

    /**
     사용자가 후보를 확정했다.

     `contextKey`는 **조회 응답의 그 그룹에서 받은 값을 그대로** 넘긴다. 확정 시점에
     앞 문맥을 다시 읽으면 조합 때와 다른 칸에 기록되고, 방금 고른 것이 다음 조회에서
     사라진다.

     응답을 기다리지 않는다 — 확정의 결과는 사용자가 이미 화면에서 봤고, 이력 기록이
     늦거나 실패해도 입력은 진행돼야 한다.
     */
    func commit(headword: String, hanja: String, contextKey: String?, sessionId: String?) {
        var payload: [String: Any] = ["headword": headword, "hanja": hanja]
        if let contextKey { payload["contextKey"] = contextKey }
        if let sessionId { payload["sessionId"] = sessionId }
        send(op: "commit", payload: payload, timeout: 3.0) { result in
            if case let .failure(error) = result { Log.error("확정 기록 실패: \(error)") }
        }
    }

    /**
     사용자가 손으로 조합을 잊는다.

     잘못 배운 것이 계속 첫 줄에 오면 기능이 없느니만 못하다. 자동 학습만으로는 나쁜
     항목을 영영 막을 수 없으므로 사람의 거부권이 있어야 한다.
     */
    func forgetUserWord(reading: String, hanja: String) {
        send(op: "forgetUserWord", payload: ["reading": reading, "hanja": hanja], timeout: 3.0) {
            result in
            if case let .failure(error) = result { Log.error("조합 잊기 실패: \(error)") }
        }
    }

    /// 벤치 전용 동기 호출. 반드시 상한을 받는다 — 입력 경로에서는 쓰지 않는다.
    func lookupSync(buffer: String, precedingText: String?, timeout: TimeInterval = 1.0)
        -> Result<LookupReply?, EngineError>
    {
        let semaphore = DispatchSemaphore(value: 0)
        var outcome: Result<LookupReply?, EngineError> = .failure(.timeout)
        lookup(buffer: buffer, precedingText: precedingText, timeout: timeout) { result in
            outcome = result
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + timeout + 0.5)
        return outcome
    }
}
