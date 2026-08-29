import Cocoa

/**
 모드가 바뀐 것을 **커서 옆에** 잠깐 보여 준다 — `한글` 또는 `漢字`.

 전환 결과를 바로 확인할 수 있도록 현재 모드를 눈에 보이게 표시한다.

 메뉴 막대 아이콘을 바꾸는 길도 있었으나 커서 옆을 골랐다 — 타이핑하는 사람의 눈은
 커서에 있지 화면 위끝에 있지 않다.

 자리는 후보창과 같은 계산을 쓴다(`CandidateWindow.origin`). 후보창과 겹치지 않도록
 **창을 따로 둔다** — 같은 창을 나눠 쓰면 모드를 바꾸는 순간 떠 있던 후보가 사라진다.
 */
final class ModeIndicator {
    /// 얼마나 보여 주는가. 눈에 걸리되 방해되지 않는 길이 — 실사용으로 조정할 것
    private static let duration: TimeInterval = 0.8

    private let panel: NSPanel
    private let label: NSTextField
    private var hideWork: DispatchWorkItem?

    init() {
        label = NSTextField(labelWithString: "")
        label.font = .systemFont(ofSize: 18, weight: .medium)
        label.alignment = .center
        label.textColor = .labelColor

        let box = NSVisualEffectView()
        box.material = .hudWindow
        box.blendingMode = .behindWindow
        box.state = .active
        box.wantsLayer = true
        box.layer?.cornerRadius = 8
        box.layer?.masksToBounds = true

        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 80, height: 40),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: true)
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        // 키도 마우스도 받지 않는다 — 보여 주기만 한다
        panel.ignoresMouseEvents = true
        panel.contentView = box

        box.addSubview(label)
        label.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: box.centerYAnchor),
        ])
    }

    /**
     한 번 보여 주고 스스로 사라진다.

     - Parameter caretRect: 커서의 화면 좌표. `.zero`면 띄우지 않는다 — 화면 구석에
       뜬 표시는 후보창과 같은 이유로 없느니만 못하다.
     */
    func flash(_ text: String, caretRect: NSRect) {
        guard caretRect != .zero else { return }

        label.stringValue = text
        let textSize = label.intrinsicContentSize
        let size = NSSize(width: max(72, textSize.width + 28), height: textSize.height + 18)
        panel.setContentSize(size)
        panel.setFrameOrigin(CandidateWindow.origin(for: caretRect, size: size))
        panel.orderFront(nil)

        // 연달아 누르면 마지막 것만 남는다 — 앞의 예약을 취소하지 않으면 두 번째
        // 표시가 첫 번째의 시계에 맞춰 일찍 사라진다.
        hideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.panel.orderOut(nil) }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.duration, execute: work)
    }
}
