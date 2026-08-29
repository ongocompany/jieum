import Cocoa

/**
 후보창 (자체 NSPanel)

 IMKCandidates를 쓰지 않는다 (docs/07 D5). Mozc는 코드 주석으로 명시 거부하고,
 구름입력기는 쓰되 키를 넘기려고 비공개 selector 편법에 의존한다. 지음의 그룹
 머리말(표제어별·층별)은 IMKCandidates로 표현할 방법이 없다.

 ## 가로 한 줄을 사용하는 이유

 세로 9줄짜리 목록은 높이가 280px이었고, 그것이 두 가지 고장을 한꺼번에 일으켰다.

 1. **앱의 자동완성을 덮는다.** 검색창에 한글을 치면 앱이 추천 목록을 입력칸 아래에
    그리는데, 후보창이 정확히 같은 자리를 먹는다. 한글은 그 자체로 완결되므로
    사용자가 보려던 것은 대개 앱의 추천이지 한자가 아니다 — 묻지도 않고 덮은 셈이다.
    2013년 W3C에서 같은 문제가 논의됐지만 결론은 "웹이 피하라"였고 그 API는 폐기됐다.
    후보 창 높이를 줄이면 앱의 목록을 가리는 범위도 줄어든다.
 2. **커서에서 멀어 보인다.** 화면 아래쪽에서 타이핑하면 창이 커서 위로 뒤집히는데,
    280px 높이만큼 떨어지니 무관한 자리에 뜬 것처럼 보인다.

 한자를 가로로 늘어놓고 훈(뜻)을 그 아래 루비로 붙이면 높이가 ~44px로 준다. 가림
 면적이 6분의 1이 되고, 뒤집혀도 커서에 붙는다. 중국어 병음 입력기 다수(Sogou·
 微软拼音)가 이미 가로 한 줄을 기본으로 쓴다.

 ## 창의 성질
 - `.nonactivatingPanel`: 이 창이 뜬다고 호스트 앱이 키 포커스를 잃으면 안 된다.
   입력기 후보창이 앱을 비활성화시키면 타이핑이 끊긴다.
 - `.borderless` + 직접 그리기: 시스템 창 장식이 붙으면 커서 옆 작은 목록이 아니라
   창처럼 보인다.
 - `.floating` 수준: 호스트 앱 위에 떠야 한다.
 */
final class CandidateWindow {

    private let panel: NSPanel
    private let listView: CandidateListView

    init() {
        listView = CandidateListView()
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 240, height: 44),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: true)
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        // 후보창은 키를 받지 않는다 — 키는 전부 입력기 컨트롤러가 처리한다
        panel.ignoresMouseEvents = true
        panel.contentView = listView
    }

    var isVisible: Bool { panel.isVisible }

    /**
     후보를 보여 준다.

     - Parameter caretRect: 커서(조합 중인 글자)의 화면 좌표 사각형.
       호스트 앱이 알려 주는 값이며, 못 알려 주면 `.zero`가 온다. 그때는 띄우지
       않는다 — 화면 구석에 뜬 후보창은 없느니만 못하고, 윈도우 쪽 TIP도 같은
       이유로 같은 결정을 한다(`jieum-tip/src/engine.rs`).

       실사용 집계로는 `.zero`가 관찰된 적이 없다(`CaretStats`, 2026-08-05).
       그러니 이 가지는 지금 도는 코드가 아니라 두 플랫폼의 동작을 맞춰 두는 것이다.
     */
    func show(model: CandidateModel, caretRect: NSRect, preferAbove: Bool = false) {
        guard !model.isEmpty, caretRect != .zero else {
            hide()
            return
        }

        listView.model = model
        let size = listView.fittingSize
        panel.setContentSize(size)
        panel.setFrameOrigin(Self.origin(for: caretRect, size: size, preferAbove: preferAbove))
        listView.needsDisplay = true

        // orderFront: 호스트 앱의 키 포커스를 빼앗지 않고 앞에 놓는다.
        // makeKeyAndOrderFront를 쓰면 타이핑이 후보창으로 빨려 들어간다.
        panel.orderFront(nil)
    }

    func hide() {
        panel.orderOut(nil)
    }

    /**
     창을 놓을 자리

     기본은 커서 **아래**다. 화면 아래로 넘치면 커서 위로 뒤집는다 — 화면 맨
     아랫줄에서 타이핑할 때 후보가 화면 밖으로 나가면 아무 소용이 없다.
     좌우도 같은 이유로 화면 안으로 당긴다.

     ## 기본 위치

     커서 위와 오른쪽은 글을 가리거나 자동완성 목록과 겹칠 수 있어 기본값으로 쓰지 않는다.

     - **커서 위** — 글은 위에서 아래로 흐르고, 쓰는 사람은 커서만이 아니라 **앞
       문장을 함께 본다.** 윗줄을 덮으면 글쓰기 자체가 막힌다. 후보가 많은 한 글자
       한자(家 따위)는 가로로 길어져 윗줄을 통째로 덮는다.
     - **커서 오른쪽**(창 위끝을 커서 위끝에 맞춤) — "자동완성 항목은 왼쪽 정렬이라
       오른쪽이 비어 있다"고 봤으나 틀렸다. 캐럿은 **입력한 텍스트의 끝**에 있으므로
       검색창에서는 여전히 왼쪽 근처이고, 창이 제안 첫 항목 위에 그대로 얹혔다.

     한 자리로 모든 앱을 처리할 수 없으므로 사용자가 `Shift+↑/↓`로 정하고 앱별로 기억한다
     (`Settings.placements`).
     */
    static func origin(for caretRect: NSRect, size: NSSize, screen: NSScreen? = nil,
                       preferAbove: Bool = false) -> NSPoint {
        let visible = (screen ?? NSScreen.screens.first { $0.frame.contains(caretRect.origin) }
            ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)

        let gap: CGFloat = 4
        var x = caretRect.minX
        var y: CGFloat

        // macOS 좌표계는 아래가 0이므로 "커서 아래"는 minY에서 창 높이를 뺀 곳,
        // "커서 위"는 maxY에 얹는 것이다. 어느 쪽이든 화면 밖이면 반대로 물러난다.
        if preferAbove {
            y = caretRect.maxY + gap
            if y + size.height > visible.maxY {
                y = caretRect.minY - size.height - gap
            }
        } else {
            y = caretRect.minY - size.height - gap
            if y < visible.minY {
                y = caretRect.maxY + gap
            }
        }
        y = min(max(y, visible.minY), max(visible.minY, visible.maxY - size.height))

        if x + size.width > visible.maxX {
            x = visible.maxX - size.width
        }
        x = max(visible.minX, x)

        return NSPoint(x: x, y: y)
    }

    /**
     ## 자동 판정은 없다 — 사용자가 `Shift+↑/↓`로 정한다 (2026-08-06)

     ⛔ **여기에 자동 판정을 다시 넣으려 하기 전에 `Settings.placements`의 주석을 읽을
     것.** 검색창과 채팅창을 가르려고 네 가지 신호를 세우고 전부 실측으로 깨뜨렸다
     (앞 문맥 길이 · 호스트가 문서 모델을 주는가 · 접근성의 역할 · 접근성의 조상).
     마지막 것만 갈리는데 그건 "브라우저면 위"라는 뜻이라 웹 편집기에서 틀리고,
     접근성 권한까지 요구한다.

     자리는 이제 앱별 설정에서 온다. 이 함수가 알 필요가 없어졌다.
     */
}

/**
 후보를 가로 한 줄로 그리는 뷰

 한 칸은 두 층이다 — 위에 번호+한자, 아래에 훈(뜻)을 루비로. 훈이 없는 후보
 (2글자 이상 한자)도 아래층 높이를 차지한다. 칸마다 높이가 달라지면 한자들이
 들쭉날쭉해 읽기 어렵다.
 */
private final class CandidateListView: NSView {

    var model = CandidateModel() {
        didSet { cachedLayout = nil }
    }

    private let padding: CGFloat = 8
    private let cellGap: CGFloat = 11
    private let rubyGap: CGFloat = 1
    private let dividerGap: CGFloat = 8
    private let numberGap: CGFloat = 1

    private let hanjaFont = NSFont.systemFont(ofSize: 17)
    private let rubyFont = NSFont.systemFont(ofSize: 9)
    private let numberFont = NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .regular)
    private let wordFont = NSFont.systemFont(ofSize: 12)

    override var isFlipped: Bool { true }

    /// 앞에 무엇을 긋는가
    private enum Divider {
        case none
        /// 표제어가 바뀐다 (발전소 → 발전). 실선
        case word
        /// 표제어는 같고 층이 바뀐다 (현대어 → 고어·전문어). 점선
        case layer
    }

    private struct Cell {
        let item: CandidateItem
        let number: Int
        /// 전체 목록에서의 자리. 선택 표시는 이것으로 가른다
        let index: Int
        var x: CGFloat = 0
        var y: CGFloat = 0
        var width: CGFloat = 0
        var divider: Divider = .none
        /// 이 칸 앞에 다시 쓸 표제어. 표제어가 바뀔 때와 맨 처음에만 있다
        var wordLabel: String?
    }

    private var cachedLayout: (cells: [Cell], size: NSSize)?

    override var fittingSize: NSSize { currentLayout().size }

    // MARK: - 자리 계산

    /**
     칸들의 자리를 한 번만 계산해 `fittingSize`와 `draw`가 나눠 쓴다.

     둘이 따로 계산하면 반드시 어긋난다 — 창 크기는 맞는데 내용이 잘리거나 남는다.
     */
    /// 한 줄의 높이 (한자층 + 루비층)
    private var rowHeight: CGFloat {
        (hanjaFont.ascender - hanjaFont.descender) + rubyGap
            + (rubyFont.ascender - rubyFont.descender)
    }

    private func currentLayout() -> (cells: [Cell], size: NSSize) {
        if let cached = cachedLayout { return cached }

        var cells: [Cell] = []
        var x = padding
        var y = padding
        var maxX = padding
        var lastWord: String?
        let start = model.visibleRange.lowerBound

        for (offset, item) in model.visibleItems.enumerated() {
            let index = start + offset
            // 번호는 **줄 안에서** 1~9다. 접힌 상태에서는 쪽이 곧 줄이라 같은 값이 나오고,
            // 펼친 상태에서도 숫자키가 「지금 선택된 줄의 N번」으로 그대로 통한다.
            let number = index % CandidateModel.pageSize + 1

            // 펼친 상태에서 줄이 바뀌는 자리. 접힌 상태에서는 한 줄뿐이라 걸리지 않는다
            if offset > 0 && number == 1 {
                maxX = max(maxX, x - cellGap)
                x = padding
                y += rowHeight + rubyGap * 2
                lastWord = nil  // 새 줄에서는 표제어를 다시 보여 준다
            }

            var cell = Cell(item: item, number: number, index: index)

            if lastWord == nil {
                cell.wordLabel = item.word
            } else if item.groupHeader != nil {
                // 표제어까지 바뀌면 어느 글자에 대한 후보인지 다시 보여야 한다 —
                // "발전소"를 치다 "발"의 후보를 고르면 세 글자 중 하나만 바뀐다.
                if item.word != lastWord {
                    cell.divider = .word
                    cell.wordLabel = item.word
                } else {
                    cell.divider = .layer
                }
            }
            lastWord = item.word

            if cell.divider != .none { x += dividerGap * 2 }
            if let label = cell.wordLabel {
                x += textSize(label, wordFont).width + cellGap
            }

            let topWidth = textSize("\(number)", numberFont).width + numberGap
                + textSize(item.hanja, hanjaFont).width
            let rubyWidth = item.meaning.map { textSize($0, rubyFont).width } ?? 0
            cell.width = max(topWidth, rubyWidth)
            cell.x = x
            cell.y = y

            x += cell.width + cellGap
            cells.append(cell)
        }

        // 접힌 상태에서만 쪽 표시를 위한 자리를 남긴다. 펼치면 전부 보이므로 필요 없다
        if !model.expanded && model.totalPages > 1 {
            x += textSize("\(model.currentPage + 1)/\(model.totalPages)", rubyFont).width
        } else {
            x -= cellGap
        }
        maxX = max(maxX, x)

        let size = NSSize(width: maxX + padding, height: y + rowHeight + padding)

        let result = (cells: cells, size: size)
        cachedLayout = result
        return result
    }

    // MARK: - 그리기

    override func draw(_ dirtyRect: NSRect) {
        // 배경 — 시스템 팝오버 색을 따라가 다크 모드에서도 읽힌다
        let background = NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6)
        NSColor.windowBackgroundColor.setFill()
        background.fill()
        NSColor.separatorColor.setStroke()
        background.stroke()

        let layout = currentLayout()
        let topHeight = hanjaFont.ascender - hanjaFont.descender

        for cell in layout.cells {
            let rubyY = cell.y + topHeight + rubyGap
            if cell.divider != .none {
                drawDivider(cell.divider, atX: cell.x - (cell.wordLabel.map {
                    textSize($0, wordFont).width + cellGap
                } ?? 0) - dividerGap, atY: cell.y)
            }
            if let label = cell.wordLabel {
                let width = textSize(label, wordFont).width
                draw(label, font: wordFont, color: .secondaryLabelColor,
                     at: NSPoint(x: cell.x - width - cellGap, y: cell.y + 4))
            }
            drawCell(cell, topY: cell.y, rubyY: rubyY)
        }

        if !model.expanded && model.totalPages > 1 {
            let text = "\(model.currentPage + 1)/\(model.totalPages)"
            let width = textSize(text, rubyFont).width
            draw(text, font: rubyFont, color: .tertiaryLabelColor,
                 at: NSPoint(x: bounds.width - padding - width,
                             y: padding + topHeight + rubyGap))
        }
    }

    private func drawCell(_ cell: Cell, topY: CGFloat, rubyY: CGFloat) {
        // ⚠️ 전체 목록 기준 자리로 가른다. 펼친 상태에서는 줄마다 번호가 1~9로 되풀이되므로
        //    번호로 비교하면 **모든 줄의 같은 번호가 동시에 선택된 것처럼 보인다.**
        let selected = cell.index == model.selected
        if selected {
            let rect = NSRect(x: cell.x - 4, y: topY - 3,
                              width: cell.width + 8,
                              height: rowHeight + 6)
            NSColor.selectedContentBackgroundColor.setFill()
            NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4).fill()
        }

        let primary: NSColor = selected ? .alternateSelectedControlTextColor : .labelColor
        let secondary: NSColor = selected ? .alternateSelectedControlTextColor : .secondaryLabelColor

        // 위층: 번호 + 한자. 번호는 작게 앞에 붙여 폭을 아낀다
        let numberText = "\(cell.number)"
        let numberWidth = textSize(numberText, numberFont).width
        draw(numberText, font: numberFont, color: secondary,
             at: NSPoint(x: cell.x, y: topY + 5))
        draw(cell.item.hanja, font: hanjaFont, color: primary,
             at: NSPoint(x: cell.x + numberWidth + numberGap, y: topY))

        // 아래층: 훈(뜻)을 루비로. 칸 폭에 가운데 맞춤
        if let meaning = cell.item.meaning {
            let width = textSize(meaning, rubyFont).width
            draw(meaning, font: rubyFont, color: secondary,
                 at: NSPoint(x: cell.x + (cell.width - width) / 2, y: rubyY))
        }
    }

    /// 그룹 경계. 표제어가 바뀌면 실선, 층만 바뀌면 점선
    private func drawDivider(_ kind: Divider, atX x: CGFloat, atY y: CGFloat) {
        let path = NSBezierPath()
        path.move(to: NSPoint(x: x, y: y))
        path.line(to: NSPoint(x: x, y: y + rowHeight))
        path.lineWidth = 1
        if kind == .layer { path.setLineDash([2, 2], count: 2, phase: 0) }
        NSColor.separatorColor.setStroke()
        path.stroke()
    }

    // MARK: - 글자

    private func textSize(_ text: String, _ font: NSFont) -> NSSize {
        (text as NSString).size(withAttributes: [.font: font])
    }

    private func draw(_ text: String, font: NSFont, color: NSColor, at point: NSPoint) {
        (text as NSString).draw(at: point, withAttributes: [.font: font, .foregroundColor: color])
    }
}
