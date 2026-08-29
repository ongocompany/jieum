import Foundation

/**
 사용자 설정

 **프로세스 전역이다.** IMK는 텍스트 입력 지점마다 {@link JieumInputController}를
 따로 만들므로, 설정을 인스턴스에 두면 "이 창에선 병기가 되는데 저 창에선 안 되는"
 상태가 된다.

 파일은 `~/Library/Application Support/Jieum/settings.json`. 사용 이력(mru.json)과
 같은 자리이고, 같은 방식으로 원자적으로 쓴다(임시 파일 → rename). 설정을 쓰는
 도중에 프로세스가 죽어 반쪽 JSON이 남으면 다음 기동에서 설정이 통째로 초기화된다.
 */
final class Settings {
    static let shared = Settings()

    /**
     한자 후보를 보여 주는가

     끄면 후보창이 안 뜰 뿐 아니라 **엔진 조회 자체를 건너뛴다**. 한글만 쓰는
     동안 매 키 입력마다 나가던 소켓 왕복이 사라진다.

     **왼쪽 ⌘+Shift로 오간다.** 숫자가 단어에 붙는 입력(`사당3동`)에서는 앞 한글이
     후보로 잡힐 수 있으므로, 한자를 쓰지 않을 때 빠르게 후보를 끌 수 있어야 한다.

     상태는 전환하는 순간 커서 옆에 보인다(`ModeIndicator`) — 모드를 두면서 그것이
     안 보이게 두면 2026-08-02에 걷어낸 영문 모드와 같은 함정에 빠진다.
     */
    var suggestionsEnabled = true { didSet { saveIfChanged(oldValue != suggestionsEnabled) } }

    /// 후보를 확정할 때 문서에 넣을 모양
    enum CommitStyle: String, CaseIterable {
        /// 漢字 — 한자만 넣는다
        case hanjaOnly
        /// 한자(漢字) — 한글을 두고 괄호 안에 한자
        case hangulThenHanja
        /// 漢字(한자) — 한자를 두고 괄호 안에 한글
        case hanjaThenHangul

        var label: String {
            switch self {
            case .hanjaOnly: return "한자만"
            case .hangulThenHanja: return "한글(한자)"
            case .hanjaThenHangul: return "한자(한글)"
            }
        }
    }

    var commitStyle: CommitStyle = .hanjaOnly { didSet { saveIfChanged(oldValue != commitStyle) } }

    /// 병기에 쓸 괄호
    enum BracketStyle: String, CaseIterable {
        case paren, square, lenticular, tortoise

        var pair: (String, String) {
            switch self {
            case .paren: return ("(", ")")
            case .square: return ("[", "]")
            case .lenticular: return ("【", "】")
            case .tortoise: return ("〔", "〕")
            }
        }

        var label: String {
            let (open, close) = pair
            return "\(open)\(close)"
        }
    }

    var bracketStyle: BracketStyle = .paren { didSet { saveIfChanged(oldValue != bracketStyle) } }

    // MARK: - 후보창 자리 (앱별)

    /**
     앱마다 후보창을 커서 위로 올릴지 아래로 내릴지.

     ## 후보 창 위치를 앱별로 저장한다

     검색창은 위(앱의 자동완성이 아래에 뜨므로), 채팅·편집기는 아래(윗줄이 방금 쓴
     글이므로)가 맞다. 하지만 호스트가 제공하는 정보만으로 둘을 안정적으로 구분할 수 없다.

     - 앞 문맥의 길이 → 카카오톡에서 깨졌다. 채팅칸은 짧지만 그 위는 대화 기록이다
     - 호스트가 문서 모델을 주는가 → 브라우저도 커서 위치를 정확히 준다 (2026-08-05)
     - 접근성의 역할(`AXTextField`/`AXTextArea`) → **구글 검색창도 `AXTextArea`다.**
       구글이 검색창을 `<textarea>`로 만들기 때문이다 (2026-08-06 실측)
     - 접근성의 조상에 `AXWebArea`가 있는가 → 갈리기는 하나 "브라우저면 위"라는 뜻이라
       웹 편집기·웹 채팅에서 틀린다. 게다가 접근성 권한을 요구한다

     사용자가 `Shift+↑/↓`로 정한 위치를 앱별로 기억한다. 접근성 권한은 요구하지 않는다.

     기본값은 **아래**다. 글 쓰는 앱이 다수이고, 위로 올리면 방금 쓴 윗줄이 가려진다.
     */
    private var placements: [String: Bool] = [:]

    func prefersAbove(app: String?) -> Bool {
        guard let app else { return false }
        return placements[app] ?? false
    }

    func setPrefersAbove(_ above: Bool, app: String?) {
        guard let app, placements[app] != above else { return }
        placements[app] = above
        saveIfChanged(true)
    }

    // MARK: - 확정 문자열

    /**
     고른 후보를 문서에 넣을 모양으로 만든다

     병기는 한글을 **지우지 않는다**. 한자 병기 논쟁에서 실제로 쓰이는 표기가
     `한자(漢字)`이므로 원문을 살린 채 괄호를 덧붙이는 것이 기본 방향이다.
     */
    func format(hangul: String, hanja: String) -> String {
        let (open, close) = bracketStyle.pair
        switch commitStyle {
        case .hanjaOnly: return hanja
        case .hangulThenHanja: return hangul + open + hanja + close
        case .hanjaThenHangul: return hanja + open + hangul + close
        }
    }

    // MARK: - 저장

    private static let fileName = "settings.json"
    private var loaded = false

    private init() {
        load()
        loaded = true
    }

    private var fileURL: URL {
        appSupportDirectory().appendingPathComponent(Self.fileName)
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        if let v = obj["suggestionsEnabled"] as? Bool { suggestionsEnabled = v }
        if let v = obj["commitStyle"] as? String, let s = CommitStyle(rawValue: v) { commitStyle = s }
        if let v = obj["bracketStyle"] as? String, let s = BracketStyle(rawValue: v) {
            bracketStyle = s
        }
        if let v = obj["placements"] as? [String: Bool] { placements = v }
    }

    /// 초기 load 중에는 저장하지 않는다 — 방금 읽은 값을 그대로 되쓸 이유가 없다
    private func saveIfChanged(_ changed: Bool) {
        guard loaded, changed else { return }
        save()
    }

    private func save() {
        let obj: [String: Any] = [
            "suggestionsEnabled": suggestionsEnabled,
            "commitStyle": commitStyle.rawValue,
            "bracketStyle": bracketStyle.rawValue,
            "placements": placements,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted])
        else { return }

        let url = fileURL
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // .atomic — 임시 파일에 쓰고 rename한다. 쓰는 도중 죽어도 반쪽 파일이 남지 않는다
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            Log.error("설정 저장 실패: \(error)")
        }
    }
}

/// `~/Library/Application Support/Jieum` — 엔진의 App Support 경로와 같은 곳
func appSupportDirectory() -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
        .first ?? URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support")
    return base.appendingPathComponent("Jieum")
}
