import AppKit

/// 호스트가 준 캐럿 사각형의 성질
enum CaretOutcome: String, CaseIterable {
    /// 어느 화면 안에 들어가는 사각형이다
    case ok = "정상"
    /// `.zero` — 호스트가 아무것도 주지 않았다
    case zero = "원점"
    /// 값은 있는데 어느 화면에도 걸치지 않는다
    case offscreen = "화면밖"
}

/**
 호스트가 주는 캐럿 사각형을 앱별로 관찰한다.

 ## 왜 고치지 않고 재기부터 하는가

 원장(`docs/notes/macos-app-compat.md` 1번)에 터미널에서 후보창이 커서와 떨어진 곳에
 뜨는 항목이 열려 있고, 거기 재검토 조건이 이렇게 적혀 있다 — **"손대기 전에 호스트가
 실제로 어떤 사각형을 주는지 진단 로그로 먼저 기록할 것. 값을 모르는 채로 보정을 넣으면
 네이티브 앱에서 멀쩡하던 것까지 어긋난다."**

 값을 모르면 대응을 고를 수 없기 때문이다. 갈림길은 이렇다:

 - 호스트가 **같은 사각형만 되풀이해서 준다** → 커서를 따라 갱신하지 않는 것이다.
   직전에 성공한 사각형을 재사용하는 폴백은 도움이 안 되고, 다른 좌표원이 필요하다.
 - 값이 **움직이는데 창이 엉뚱한 데 뜬다** → 좌표계가 어긋난 것이다. 변환 보정이 답이다.

 대응이 정반대라서, 이 구분 없이 손대면 반드시 다른 앱을 망가뜨린다. 그래서 이 파일은
 값의 **범위**(x·y의 최소~최대)를 남긴다 — 범위가 한 점으로 뭉개지면 전자, 벌어지면
 후자다. 첫 실값도 앱마다 한 번 남겨 좌표계 자체를 눈으로 확인할 수 있게 한다.

 집계·배출 방식은 `ContextStats`와 같다 (그쪽 문서 참조).
 */
enum CaretStats {

    private static let flushInterval: TimeInterval = 10 * 60
    private static let queue = DispatchQueue(label: "com.ongocompany.jieum.caret-stats")

    private static var currentApp: String?
    private static var counts: [CaretOutcome: Int] = [:]
    private static var since = Date()

    /// 앱마다 처음 받은 사각형. 좌표계를 눈으로 확인하는 용도
    private static var firstRect: NSRect?
    /// `.zero`가 아닌 값들의 범위. 한 점으로 뭉개지면 호스트가 갱신하지 않는 것이다
    private static var xRange: (min: CGFloat, max: CGFloat)?
    private static var yRange: (min: CGFloat, max: CGFloat)?

    /**
     사각형 하나를 기록한다.

     ⚠️ **주 스레드에서 부른다.** 분류가 `NSScreen`을 보기 때문에 여기서 미리 판정하고,
     집계만 배경 큐로 넘긴다.
     */
    static func record(app: String?, rect: NSRect) {
        let outcome = classify(rect)
        let now = Date()
        let name = app ?? "(알수없음)"

        queue.async {
            if name != currentApp || now.timeIntervalSince(since) >= flushInterval {
                flushOnQueue(at: now)
                currentApp = name
            }
            counts[outcome, default: 0] += 1
            if firstRect == nil { firstRect = rect }
            guard outcome != .zero else { return }
            xRange = (min(xRange?.min ?? rect.minX, rect.minX), max(xRange?.max ?? rect.minX, rect.minX))
            yRange = (min(yRange?.min ?? rect.minY, rect.minY), max(yRange?.max ?? rect.minY, rect.minY))
        }
    }

    static func flush() {
        let now = Date()
        queue.async { flushOnQueue(at: now) }
    }

    private static func classify(_ rect: NSRect) -> CaretOutcome {
        if rect == .zero { return .zero }
        // 걸치기만 해도 정상으로 본다. 화면 경계의 커서를 화면 밖으로 몰지 않기 위해서다
        if !NSScreen.screens.contains(where: { $0.frame.intersects(rect) }) { return .offscreen }
        return .ok
    }

    /// **반드시 `queue` 위에서만 부른다.**
    private static func flushOnQueue(at now: Date) {
        defer {
            counts.removeAll()
            firstRect = nil
            xRange = nil
            yRange = nil
            since = now
        }

        guard let app = currentApp, !counts.isEmpty else { return }

        let total = counts.values.reduce(0, +)
        let countPart = CaretOutcome.allCases
            .compactMap { key in counts[key].map { "\(key.rawValue)=\($0)" } }
            .joined(separator: " ")

        let minutes = String(format: "%.1f", now.timeIntervalSince(since) / 60)
        var line = "캐럿 집계 앱=\(app) 구간=\(minutes)분 조회=\(total) \(countPart)"
        if let xRange, let yRange {
            line += String(
                format: " x=[%.0f~%.0f] y=[%.0f~%.0f]", xRange.min, xRange.max, yRange.min, yRange.max)
        }
        if let firstRect {
            line += String(
                format: " 첫값=(%.0f,%.0f,%.0f,%.0f)",
                firstRect.minX, firstRect.minY, firstRect.width, firstRect.height)
        }
        Log.diagnostic(line)
    }
}
