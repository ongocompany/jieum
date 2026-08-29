import Foundation

/**
 텍스트 칸의 수명 관찰

 ## 무엇을 쫓는가

 Excel의 일부 셀에서 첫 글자가 사라지거나 한글이 입력되지 않는 간헐적 문제가 있었다.

 유력한 설명은 이렇다. 셀을 고른 상태는 아직 편집 모드가 아니고, Excel은 첫 키가
 온 뒤에야 편집용 텍스트 칸을 만든다. 그 사이에 지음은 이미 조합을 시작해 **옛 칸에**
 marked text를 띄운다. 곧 옛 칸이 죽고 `deactivateServer`가 오면 지음은 조합을 그
 죽어가는 칸에 확정해 넣는다 — 넣었다고 믿고 상태를 비우는데 화면에는 없다.

 - 칸이 한 번만 어긋나면 → **첫 글자만 씹힌다**
 - 칸이 계속 어긋나 있으면 → **아무것도 안 나온다**

 두 증상이 같은 원인인지 확인하려면 텍스트 칸이 바뀌는 시점을 기록해야 한다.

 ## 정상은 뭉쳐 세고, 이상은 낱개로 남긴다

 `ContextStats`·`CaretStats`는 단어마다 일어나는 일을 뭉쳐 센다. 여기서 쫓는 것은
 반대로 **드문 사건**이라 뭉치면 사라진다. 그래서 두 축으로 나눈다.

 - **집계** — 칸 전환 횟수. 이 앱이 칸을 얼마나 자주 갈아 끼우는지가 배경이다
 - **낱개** — 조합을 안고 있을 때의 이상만. 조합이 비어 있을 때 칸이 바뀌는 것은
   잃을 글자가 없으므로 무해하고, 그것까지 남기면 로그가 덮인다

 ## 낱개 기록에 상한을 두되, 접었다는 사실을 남긴다

 칸 태그가 매 호출마다 달라지는 호스트가 있으면 낱개 기록이 키마다 쌓여 로그를
 덮는다. 그래서 앱별 상한을 둔다. 다만 **상한에 걸렸다는 것 자체를 한 줄 남긴다** —
 "안 일어났다"와 "너무 많이 일어나 접었다"가 구별되지 않으면 관찰 장치가 아니다.
 총 횟수는 집계 줄에 그대로 남으므로 잃는 것은 없다.

 ⚠️ 입력 내용은 넣지 않는다 (`Log` 참조). 글자 **수**만 센다.
 */
enum ClientStats {

    /// 앱 하나에 대해 낱개로 남기는 최대 건수. 넘으면 집계에만 반영한다
    private static let detailLimit = 20

    /// 같은 앱을 계속 쓰는 동안에도 이만큼 지나면 한 줄 남긴다 (`ContextStats`와 같은 규칙)
    private static let flushInterval: TimeInterval = 10 * 60

    private static let queue = DispatchQueue(label: "com.ongocompany.jieum.client-stats")

    private static var currentApp: String?
    private static var since = Date()

    /// 정상 전환
    private static var activations = 0
    private static var deactivations = 0

    /// 이상 — 집계에도 남고 상한 안에서는 낱개로도 남는다
    private static var mismatches = 0
    private static var flushOnLeave = 0
    private static var strandedOnEnter = 0
    private static var composerMissing = 0

    /// 이 앱에서 이미 낱개로 남긴 건수
    private static var detailsWritten = 0
    /// 상한 도달을 한 번만 알리기 위한 표시
    private static var limitAnnounced = false

    private static let unknownApp = "(알수없음)"

    // MARK: - 칸의 정체

    /**
     칸(또는 컨트롤러)을 로그에서 알아볼 짧은 이름.

     객체의 주소를 16진수 네 자리로 줄인 것이다. **참조를 들고 있지 않다** — 죽어야 할
     칸을 살려 두면 그것 자체가 관찰 대상을 바꾼다. 주소는 재사용될 수 있으나, 여기서
     묻는 것은 "같은 순간에 두 칸이 다른가"이므로 그것으로 충분하다.
     */
    static func tag(_ object: Any?) -> String {
        guard let object else { return "없음" }
        let bits = UInt(bitPattern: ObjectIdentifier(object as AnyObject).hashValue)
        return String(format: "%04x", bits & 0xFFFF)
    }

    // MARK: - 기록

    /// 칸에 들어왔다. `stranded`는 들어온 시점에 이미 조합이 남아 있던 글자 수
    static func enter(app: String?, client: String, stranded: Int) {
        let now = Date()
        let name = app ?? unknownApp
        queue.async {
            roll(to: name, at: now)
            activations += 1

            // 앞선 `deactivateServer`가 비웠어야 할 조합이 남아 있다. 짝이 맞지 않았거나
            // 비우는 경로가 그 칸에 닿지 못했다는 뜻이고, 다음 글자에 옛 글자가 붙는다
            guard stranded > 0 else { return }
            strandedOnEnter += 1
            detail("칸 진입에 조합 잔류 앱=\(name) 글자=\(stranded)자 칸=\(client)")
        }
    }

    /// 칸을 떠났다. `carried`는 떠나면서 그 칸에 확정해 넣은 글자 수
    static func leave(app: String?, client: String, carried: Int) {
        let now = Date()
        let name = app ?? unknownApp
        queue.async {
            roll(to: name, at: now)
            deactivations += 1

            // 첫 글자 씹힘을 진단할 자리. 여기서 넘긴 글자가 화면에 실제로
            //    들어갔는지를 IMK는 알려주지 않으므로, 넘긴 사실만이라도 남겨 둔다.
            //    들어갔는지는 IMK가 알려 주지 않으므로 넘긴 사실을 남긴다
            guard carried > 0 else { return }
            flushOnLeave += 1
            detail("떠나며 확정 앱=\(name) 글자=\(carried)자 칸=\(client)")
        }
    }

    /**
     조합 중인데 키가 **다른 칸**으로 왔다.

     지음이 옛 칸을 붙들고 일하고 있었다는 뜻이다. 이 줄이 나오면 가설이 확정된다.
     */
    static func mismatch(app: String?, from: String, to: String, composing: Int) {
        let now = Date()
        let name = app ?? unknownApp
        queue.async {
            roll(to: name, at: now)
            mismatches += 1
            detail("칸 바뀜 앱=\(name) 조합=\(composing)자 앞칸=\(from) 뒤칸=\(to)")
        }
    }

    /// 조합기가 없는 채로 키가 왔다 (libhangul 생성 실패 — 한글이 아예 안 나온다)
    static func noComposer(app: String?) {
        let now = Date()
        let name = app ?? unknownApp
        queue.async {
            roll(to: name, at: now)
            composerMissing += 1
        }
    }

    /// 남은 집계를 지금 기록한다
    static func flush() {
        let now = Date()
        queue.async { flushOnQueue(at: now) }
    }

    // MARK: - 내부

    /// **반드시 `queue` 위에서만 부른다.** 앱이 바뀌었거나 구간이 찼으면 배출한다
    private static func roll(to name: String, at now: Date) {
        guard name != currentApp || now.timeIntervalSince(since) >= flushInterval else { return }
        flushOnQueue(at: now)
        currentApp = name
    }

    /// **반드시 `queue` 위에서만 부른다.**
    private static func detail(_ line: String) {
        if detailsWritten >= detailLimit {
            guard !limitAnnounced else { return }
            limitAnnounced = true
            Log.diagnostic("칸 관찰 낱개 기록 상한 — 이 구간은 집계로만 남는다 (상한 \(detailLimit))")
            return
        }
        detailsWritten += 1
        Log.diagnostic(line)
    }

    /// **반드시 `queue` 위에서만 부른다.**
    private static func flushOnQueue(at now: Date) {
        defer {
            activations = 0
            deactivations = 0
            mismatches = 0
            flushOnLeave = 0
            strandedOnEnter = 0
            composerMissing = 0
            detailsWritten = 0
            limitAnnounced = false
            since = now
        }

        guard let app = currentApp else { return }
        // 전환도 이상도 없었으면 남길 것이 없다. 앱을 스쳐 지나가기만 해도 한 줄이
        // 나오면 로그가 앱 전환 목록이 된다
        let anomalies = mismatches + flushOnLeave + strandedOnEnter + composerMissing
        guard activations + deactivations + anomalies > 0 else { return }

        let minutes = String(format: "%.1f", now.timeIntervalSince(since) / 60)
        var line = "칸 집계 앱=\(app) 구간=\(minutes)분 활성=\(activations) 비활성=\(deactivations)"
        if anomalies > 0 {
            // 0인 항목은 빼서 한 줄이 읽히게 둔다 (`ContextStats`와 같은 규칙)
            var parts: [String] = []
            if mismatches > 0 { parts.append("칸바뀜=\(mismatches)") }
            if flushOnLeave > 0 { parts.append("떠나며확정=\(flushOnLeave)") }
            if strandedOnEnter > 0 { parts.append("조합잔류=\(strandedOnEnter)") }
            if composerMissing > 0 { parts.append("조합기없음=\(composerMissing)") }
            line += " [\(parts.joined(separator: " "))]"
        }
        Log.diagnostic(line)
    }
}
