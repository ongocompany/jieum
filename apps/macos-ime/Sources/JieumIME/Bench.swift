import Foundation

/**
 Swift 쪽 왕복 지연 측정 (C0.3의 최종 판정)

 TS 하네스(`packages/engine-server/src/bench.ts`)와 같은 것을 재지만, 이쪽이
 **셸이 실제로 치르는 비용**이다 — Swift의 JSON 인코딩·디코딩과 Foundation의
 소켓 처리가 포함된다. 두 수치의 차이가 곧 "셸이 더하는 비용"이라 어느 쪽을
 손봐야 할지가 갈린다.

 조회는 한 번에 하나씩 순차로 보낸다. 실제 타이핑도 키 하나에 조회 하나이고,
 동시에 여러 개를 띄우면 지연이 좋아 보이지만 현실을 반영하지 않는다.
 */
enum Bench {

    private static let words = ["시", "시장", "발전", "발전소", "고전문학", "한국사", "훈민정음"]
    private static let contexts: [String?] = [nil, "이번 선거에서 ", "주식과 채권 등 ", "조선 후기의 "]

    static func run(arguments: [String]) -> Int32 {
        var iterations = 2000
        if let index = arguments.firstIndex(of: "--iterations"),
           index + 1 < arguments.count,
           let value = Int(arguments[index + 1]) {
            iterations = value
        }

        let client = EngineClient()
        guard EngineLauncher.ensureRunning(client: client) else {
            Log.error("엔진에 붙지 못해 측정할 수 없다")
            return 1
        }

        let handshake = DispatchSemaphore(value: 0)
        var serverVersion = "?"
        var fingerprint = "?"
        client.hello(clientVersion: "bench") { result in
            if case let .success(reply) = result {
                serverVersion = reply.serverVersion
                fingerprint = reply.dictFingerprint
            }
            handshake.signal()
        }
        _ = handshake.wait(timeout: .now() + 5)

        // 워밍업 — 첫 조회들은 캐시가 차갑다
        for i in 0..<200 {
            _ = client.lookupSync(
                buffer: words[i % words.count],
                precedingText: contexts[i % contexts.count])
        }

        let recorder = LatencyRecorder()
        var failures = 0
        var stale = 0

        for i in 0..<iterations {
            let buffer = words[i % words.count]
            let context = contexts[i % contexts.count]

            let started = DispatchTime.now().uptimeNanoseconds
            let result = client.lookupSync(buffer: buffer, precedingText: context)
            let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000

            switch result {
            case let .success(reply):
                if reply == nil { stale += 1 } else { recorder.record(elapsedMs) }
            case let .failure(error):
                if failures < 3 { Log.error("조회 실패: \(error)") }
                failures += 1
            }
        }

        let summary = recorder.summarize()
        let report: [String: Any] = [
            "source": "swift",
            "socket": EngineLauncher.socketPath,
            "serverVersion": serverVersion,
            "dictFingerprint": fingerprint,
            "iterations": iterations,
            "latencyMs": [
                "p50": summary.p50, "p90": summary.p90, "p99": summary.p99,
                "max": summary.max, "mean": summary.mean,
            ],
            "samples": summary.count,
            "failures": failures,
            "stale": stale,
            "gateP99Under5ms": summary.passesGate,
        ]

        if let data = try? JSONSerialization.data(
            withJSONObject: report, options: [.prettyPrinted, .sortedKeys]),
            let text = String(data: data, encoding: .utf8) {
            print(text)
        }

        client.disconnect()
        return summary.passesGate && failures == 0 ? 0 : 1
    }
}
