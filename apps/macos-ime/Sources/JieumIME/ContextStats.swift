import Foundation

/**
 앞 문맥을 어디서 얻었는가 — 조회 한 번의 결말.

 세 값의 합이 곧 조회 횟수다. 어느 하나로 반드시 끝나므로 겹치지 않는다.
 */
enum ContextSource: String, CaseIterable {
    /// 호스트 앱이 커서 앞 글자를 줬다 (가장 정확하다)
    case host = "호스트"
    /// 호스트가 못 줘서 우리가 넣은 글자로 물러났다
    case ownHistory = "자체기록"
    /// 둘 다 없어 버퍼만으로 조회했다 (연어가 빠진다)
    case bufferOnly = "문맥없음"
}

/**
 호스트가 문맥을 주지 못한 이유.

 `ContextSource`와 **다른 축이다.** 호스트가 실패해도 자체기록이 살아 있으면 문맥은
 살아남으므로, 두 축을 하나로 합치면 "실패 32건인데 문맥없음은 12건"이 모순으로 보인다.
 앱을 판정할 때 필요한 구분이 정확히 이것이다 — 호스트를 못 믿는 앱인가, 아니면
 대비책까지 무너지는 앱인가.
 */
enum HostContextFailure: String, CaseIterable {
    /// 클라이언트가 IMKTextInput이 아니다 (문맥 API 자체가 없다)
    case notTextInput = "비텍스트입력"
    /// 호스트가 커서 위치를 **모른다** (`selectedRange`가 NSNotFound).
    /// 문서 모델을 온전히 노출하지 않는 칸이라는 신호다 — 후보창 자리 판정에 쓴다
    case cursorUnknown = "커서모름"
    /// 커서는 아는데 문서 시작이다 (`selectedRange.location == 0`).
    /// 빈 입력칸에 첫 글자를 치는 정상 상태이지 앱의 결함이 아니다
    case documentStart = "문서시작"
    /// 문서 길이가 0으로 왔다
    case emptyDocument = "빈문서"
    /// 범위는 멀쩡한데 `attributedSubstring`이 비었다
    case emptySubstring = "부분문자열"
}

/**
 문맥 획득 결과를 **앱별로 모아** 요약 한 줄로 남긴다.

 ## 왜 세어서 남기는가

 M3의 산출물은 "어떤 앱이 지음과 잘 지내는가"의 원장(`docs/notes/macos-app-compat.md`)이다.
 그 판정에 필요한 사실 — 이 앱이 앞 문맥을 주는가 — 은 **단어마다** 일어난다. 일어날
 때마다 한 줄씩 남기면 두 가지가 동시에 잘못된다:

 1. 로그가 그 줄로 덮인다. 2026-08-02 실측: 2,155줄 중 2,064줄(95.8%)이 이 계열이었고,
    실제 사건(기동·연결·메뉴)은 91줄이었다. 일주일 실사용 뒤 무슨 일이 있었는지 읽을 수 없다.
 2. **정작 어느 앱이었는지가 없다.** `attributedSubstring이 비었다` 209건이 어느 앱에서
    났는지 로그 어디에도 남지 않아, 원장을 채울 수 없다.

 그래서 이 파일은 로그를 *줄이는* 장치가 아니라 **원장을 채울 수 있는 형태로 바꾸는**
 장치다. 일주일 뒤 `grep "문맥 집계"` 한 번이면 앱별 표가 나온다.

 ## 언제 남기는가

 타이머를 두지 않는다. 기록 시점에 (a) 앱이 바뀌었거나 (b) 마지막 요약에서 충분히
 지났으면 그 자리에서 요약한다. 입력이 없는 동안에는 아무 일도 일어나지 않아야 한다 —
 입력기 프로세스가 하루 종일 떠 있기 때문이다.

 하루 종일 한 앱만 쓰는 날에도 기록이 남도록 (b)를 둔다. 이것이 없으면 터미널에서만
 열 시간 작업한 날의 요약이 통째로 한 줄이 되고, 언제 무슨 일이 있었는지 사라진다.
 */
enum ContextStats {

    /// 같은 앱을 계속 쓰는 동안에도 이만큼 지나면 한 줄 남긴다
    private static let flushInterval: TimeInterval = 10 * 60

    /// 집계 상태를 지키는 직렬 큐. 입력 경로(주 스레드)를 붙잡지 않도록 비동기로만 쓴다
    private static let queue = DispatchQueue(label: "com.ongocompany.jieum.context-stats")

    private static var currentApp: String?
    private static var sources: [ContextSource: Int] = [:]
    private static var failures: [HostContextFailure: Int] = [:]
    private static var since = Date()

    /// 앱 식별자를 못 얻었을 때 쓰는 이름. 그런 일이 얼마나 잦은지도 알아야 한다
    private static let unknownApp = "(알수없음)"

    /**
     조회 한 번의 결과를 기록한다.

     `hostFailure`는 호스트가 문맥을 못 준 경우에만 넣는다 — `source`가 `.host`이면
     언제나 nil이다.
     */
    static func record(app: String?, source: ContextSource, hostFailure: HostContextFailure?) {
        let now = Date()
        let name = app ?? unknownApp
        queue.async {
            if name != currentApp || now.timeIntervalSince(since) >= flushInterval {
                flushOnQueue(at: now)
                currentApp = name
            }
            sources[source, default: 0] += 1
            if let hostFailure { failures[hostFailure, default: 0] += 1 }
        }
    }

    /// 남은 집계를 지금 기록한다 (프로세스가 오래 조용할 때를 대비한 수동 배출구)
    static func flush() {
        let now = Date()
        queue.async { flushOnQueue(at: now) }
    }

    /// **반드시 `queue` 위에서만 부른다.**
    private static func flushOnQueue(at now: Date) {
        defer {
            sources.removeAll()
            failures.removeAll()
            since = now
        }

        guard let app = currentApp, !sources.isEmpty else { return }

        let total = sources.values.reduce(0, +)
        // 0인 항목은 빼서 한 줄이 읽히게 둔다. 순서는 선언 순서로 고정한다 —
        // 사전 순서에 맡기면 같은 상황이 실행마다 다른 모양으로 남아 비교가 안 된다
        let sourcePart = ContextSource.allCases
            .compactMap { key in sources[key].map { "\(key.rawValue)=\($0)" } }
            .joined(separator: " ")
        let failurePart = HostContextFailure.allCases
            .compactMap { key in failures[key].map { "\(key.rawValue)=\($0)" } }
            .joined(separator: " ")

        let minutes = String(format: "%.1f", now.timeIntervalSince(since) / 60)
        var line = "문맥 집계 앱=\(app) 구간=\(minutes)분 조회=\(total) \(sourcePart)"
        if !failurePart.isEmpty { line += " [호스트실패 \(failurePart)]" }
        Log.diagnostic(line)
    }
}
