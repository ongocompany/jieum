import Foundation

/**
 프로토콜 v1 — Swift 쪽 계약

 `packages/engine-server/src/protocol.ts`와 **같은 커밋에서** 고쳐야 한다.
 파괴적 변경은 `protocolVersion`을 양쪽에서 함께 올린다.
 */
enum JieumProtocol {
    static let version = 1
}

// MARK: - 응답

/**
 후보 하나.

 ⚠️ **숫자 필드는 전부 Double로 받는다.** JSON에는 정수/실수 구분이 없고 TS 쪽은
 `number` 하나뿐이라, 정수처럼 보이는 값이 언제든 소수로 올 수 있다. 실제로 그랬다:
 `level`(급수)은 표제어에 따라 `7.5`가 온다(여러 엔트리의 급수가 평균된 값). Swift에서
 `Int`로 받자 조회 응답 **전체**가 조용히 해석 실패했고, 증상은 "제안이 아예 안 뜬다"였다.

 `Int`로 받아도 되는 것은 프로토콜이 정수를 보장하는 필드뿐이다 — `v`, `id`, `token`,
 `length`(문자열 길이).
 */
struct WireCandidate: Codable {
    let word: String
    let hanja: String
    let score: Double
    let freq: Double
    /// 급수. 정수가 아니다 (예: 7.5)
    let level: Double
    /// 훈(뜻) — 1글자 한자에만 있다
    let meaning: String?
    let inmyeong: Bool?
    /// 2층(고어·전문어) 여부
    let archaic: Bool?
    /// 사용 이력 신호. 최근성 기반이라 큰 수가 올 수 있다
    let used: Double?
    /// 앞 문맥에서 걸린 연어 문맥어 수
    let collocation: Double?
    let source: String
}

struct WireLookupGroup: Codable {
    let word: String
    let length: Int
    let candidates: [WireCandidate]
    /// "normal" | "archaic" | "inmyeong"
    let type: String?
    /// 이 조회 시점에 이 표제어가 놓인 문맥의 이름. 확정에 그대로 실어 보낸다.
    /// **그룹마다 다르다** — 표제어가 다르면 걸리는 연어 규칙도 다르다.
    let contextKey: String?
}

struct SessionOpenReply: Codable {
    let id: Int
    let ok: Bool
    let sessionId: String
}

struct HelloReply: Codable {
    let id: Int
    let ok: Bool
    let serverVersion: String
    let protocolV: Int
    let dictFingerprint: String
}

struct PingReply: Codable {
    let id: Int
    let ok: Bool
    let uptimeMs: Double
    let rssBytes: Double
}

struct LookupReply: Codable {
    let id: Int
    let ok: Bool
    /// 연결마다 단조 증가. 이보다 낮은 응답은 낡은 것이므로 버린다
    let token: Int
    let groups: [WireLookupGroup]
    let contextKey: String?
}

struct WireError: Codable {
    struct Body: Codable {
        let code: String
        let message: String
    }
    let id: Int
    let ok: Bool
    let error: Body
}

enum EngineError: Error, CustomStringConvertible {
    case notConnected
    case timeout
    case server(code: String, message: String)
    case decode(String)

    var description: String {
        switch self {
        case .notConnected: return "엔진에 연결되지 않았다"
        case .timeout: return "응답 시간 초과"
        case let .server(code, message): return "엔진 오류(\(code)): \(message)"
        case let .decode(detail): return "응답 해석 실패: \(detail)"
        }
    }
}
