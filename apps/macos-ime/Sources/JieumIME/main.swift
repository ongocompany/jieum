import Carbon
import Cocoa
import InputMethodKit

/**
 지음 macOS 입력기 진입점

 세 가지 모드로 뜬다:
 - 기본: IMK 서버로 뜬다 (시스템이 입력기로 띄울 때)
 - `--bench`: 왕복 지연을 재고 결과를 JSON으로 낸다 (C0.3)
 - `--register`: 자신을 입력 소스로 등록하고 끝낸다 (디버그 설치 스크립트가 부른다)
 */

let arguments = CommandLine.arguments

if arguments.contains("--bench") {
    exit(Bench.run(arguments: arguments))
}

if arguments.contains("--test-mode-chord") {
    // 왼쪽 ⌘+Shift만 눌렀다 떼면 한자 모드가 뒤집힌다. **다른 키가 끼면 안 뒤집힌다** —
    // ⌘⇧4(화면 캡처)를 누를 때마다 모드가 뒤집히면 쓸 수 없는 입력기가 된다.
    var failures = 0
    func check(_ label: String, _ actual: String, _ expected: String) {
        let ok = actual == expected
        if !ok { failures += 1 }
        print("\(label): '\(actual)' 기대 '\(expected)' \(ok ? "OK" : "*** 불일치 ***")")
    }

    let LCMD: UInt16 = 55, RCMD: UInt16 = 54, LSHIFT: UInt16 = 56, RSHIFT: UInt16 = 60
    let LOPT: UInt16 = 58
    let cmd = NSEvent.ModifierFlags.command.rawValue
    let shift = NSEvent.ModifierFlags.shift.rawValue
    let opt = NSEvent.ModifierFlags.option.rawValue

    // 기본 — 눌렀다 떼면 뒤집힌다
    var chord = ModeChord()
    _ = chord.flagsChanged(keyCode: LCMD, flags: cmd)
    _ = chord.flagsChanged(keyCode: LSHIFT, flags: cmd | shift)
    check("떼면 뒤집힌다", "\(chord.flagsChanged(keyCode: LSHIFT, flags: cmd))", "true")

    // 순서가 반대여도 같다
    chord = ModeChord()
    _ = chord.flagsChanged(keyCode: LSHIFT, flags: shift)
    _ = chord.flagsChanged(keyCode: LCMD, flags: cmd | shift)
    check("Shift 먼저여도 뒤집힌다", "\(chord.flagsChanged(keyCode: LCMD, flags: shift))", "true")

    // ⌘⇧4 — 사이에 글자 키가 끼면 안 뒤집힌다
    chord = ModeChord()
    _ = chord.flagsChanged(keyCode: LCMD, flags: cmd)
    _ = chord.flagsChanged(keyCode: LSHIFT, flags: cmd | shift)
    chord.keyDown()
    check("사이에 키가 끼면 안 뒤집힌다", "\(chord.flagsChanged(keyCode: LSHIFT, flags: cmd))", "false")

    // 다른 수식키가 끼어도 안 뒤집힌다
    chord = ModeChord()
    _ = chord.flagsChanged(keyCode: LCMD, flags: cmd)
    _ = chord.flagsChanged(keyCode: LSHIFT, flags: cmd | shift)
    _ = chord.flagsChanged(keyCode: LOPT, flags: cmd | shift | opt)
    check("Option이 끼면 안 뒤집힌다", "\(chord.flagsChanged(keyCode: LSHIFT, flags: cmd | opt))", "false")

    // 오른쪽 ⌘는 이 단축키가 아니다
    chord = ModeChord()
    _ = chord.flagsChanged(keyCode: RCMD, flags: cmd)
    _ = chord.flagsChanged(keyCode: LSHIFT, flags: cmd | shift)
    check("오른쪽 ⌘는 아니다", "\(chord.flagsChanged(keyCode: LSHIFT, flags: cmd))", "false")

    // Shift는 어느 쪽이든 된다
    chord = ModeChord()
    _ = chord.flagsChanged(keyCode: LCMD, flags: cmd)
    _ = chord.flagsChanged(keyCode: RSHIFT, flags: cmd | shift)
    check("오른쪽 Shift는 된다", "\(chord.flagsChanged(keyCode: RSHIFT, flags: cmd))", "true")

    // ⌘만 눌렀다 떼는 것은 아니다 (⌘Tab 뒤 등)
    chord = ModeChord()
    _ = chord.flagsChanged(keyCode: LCMD, flags: cmd)
    check("⌘만으로는 안 뒤집힌다", "\(chord.flagsChanged(keyCode: LCMD, flags: 0))", "false")

    // 한 번 뒤집힌 뒤 곧바로 다시 누르면 또 뒤집힌다 (상태가 남지 않는다)
    chord = ModeChord()
    _ = chord.flagsChanged(keyCode: LCMD, flags: cmd)
    _ = chord.flagsChanged(keyCode: LSHIFT, flags: cmd | shift)
    _ = chord.flagsChanged(keyCode: LSHIFT, flags: cmd)
    _ = chord.flagsChanged(keyCode: LCMD, flags: 0)
    _ = chord.flagsChanged(keyCode: LCMD, flags: cmd)
    _ = chord.flagsChanged(keyCode: LSHIFT, flags: cmd | shift)
    check("연달아 두 번", "\(chord.flagsChanged(keyCode: LSHIFT, flags: cmd))", "true")

    print(failures == 0 ? "MODE_CHORD_OK" : "MODE_CHORD_FAIL (\(failures))")
    exit(failures == 0 ? 0 : 1)
}

if arguments.contains("--test-candidates") {
    func group(_ word: String, _ type: String?, _ hanja: [String], contextKey: String? = nil)
        -> WireLookupGroup
    {
        WireLookupGroup(
            word: word, length: word.count,
            candidates: hanja.map {
                WireCandidate(
                    word: word, hanja: $0, score: 0, freq: 0, level: 0, meaning: nil,
                    inmyeong: nil, archaic: nil, used: nil, collocation: nil, source: "dictionary")
            },
            type: type, contextKey: contextKey)
    }

    var failures = 0
    func check(_ label: String, _ actual: String, _ expected: String) {
        let ok = actual == expected
        if !ok { failures += 1 }
        print("\(label): '\(actual)' 기대 '\(expected)' \(ok ? "OK" : "*** 불일치 ***")")
    }

    var model = CandidateModel.from(groups: [
        group("발전소", "normal", ["發電所"]),
        group("발전", "normal", ["發展", "發電"], contextKey: "發展"),
        group("발전", "archaic", ["撥電"]),
    ])

    check("항목 수", "\(model.items.count)", "4")
    check("첫 항목", model.items[0].hanja, "發電所")
    check("긴 매칭이 먼저", model.items[0].word, "발전소")
    check("그룹 머리말", model.items[1].groupHeader ?? "-", "발전")
    check("층 머리말", model.items[3].groupHeader ?? "-", "발전 · 고어·전문어")
    check("문맥 키가 항목에 실린다", model.items[1].contextKey ?? "-", "發展")
    check("머리말은 그룹 첫 항목에만", model.items[2].groupHeader ?? "-", "-")

    // 사용자 조합은 메뉴에서 잊을 수 있어야 하므로 항목이 출처를 들고 있어야 한다
    let userModel = CandidateModel.from(groups: [
        WireLookupGroup(
            word: "김홍경", length: 3,
            candidates: [
                WireCandidate(
                    word: "김홍경", hanja: "金洪京", score: 0, freq: 0, level: 0, meaning: nil,
                    inmyeong: nil, archaic: nil, used: nil, collocation: nil, source: "user")
            ],
            type: "normal", contextKey: nil)
    ])
    check("사용자 조합 표시", userModel.items[0].isUserWord ? "예" : "아니오", "예")
    check("사전 후보는 아니다", model.items[0].isUserWord ? "예" : "아니오", "아니오")

    // 숫자키: 범위를 벗어나면 nil이어야 한다 (그래야 셸이 그 키를 호스트에 넘긴다)
    check("2번 선택", model.item(forNumber: 2)?.hanja ?? "-", "發展")
    check("범위 밖 숫자", model.item(forNumber: 7)?.hanja ?? "없음", "없음")
    check("0은 숫자키가 아니다", model.item(forNumber: 0)?.hanja ?? "없음", "없음")

    // 이동은 순환한다 (가로 한 줄 — 왼쪽/오른쪽)
    model.movePrevious()
    check("첫 항목에서 왼쪽 → 마지막", "\(model.selected)", "3")
    model.moveNext()
    check("마지막에서 오른쪽 → 처음", "\(model.selected)", "0")

    // 쪽 넘김
    var many = CandidateModel.from(groups: [
        group("정", "normal", (1...20).map { "\($0)" })
    ])
    check("쪽 수", "\(many.totalPages)", "3")
    check("한 쪽 크기", "\(many.visibleItems.count)", "9")
    many.nextPage()
    check("다음 쪽 첫 항목", "\(many.selected)", "9")
    check("쪽 안 번호로 고른다", many.item(forNumber: 1)?.hanja ?? "-", "10")

    // 펼치기 — 아래로 누르면 전부 보이고, 한 번 더 누르면 아랫줄로
    var wide = CandidateModel.from(groups: [
        group("정", "normal", (1...20).map { "\($0)" })
    ])
    check("처음엔 접혀 있다", "\(wide.expanded)", "false")
    check("접히면 한 줄만 보인다", "\(wide.visibleItems.count)", "9")
    wide.expandOrMoveDown()
    check("아래 → 펼쳐진다", "\(wide.expanded)", "true")
    check("펼치면 전부 보인다", "\(wide.visibleItems.count)", "20")
    check("펼쳐도 선택은 그대로", "\(wide.selected)", "0")
    check("줄 수", "\(wide.rowCount)", "3")
    wide.expandOrMoveDown()
    check("한 번 더 → 아랫줄", "\(wide.selected)", "9")
    check("아랫줄에서 숫자키는 그 줄 것", wide.item(forNumber: 1)?.hanja ?? "-", "10")
    wide.collapseOrMoveUp()
    check("위 → 윗줄로", "\(wide.selected)", "0")
    check("아직 펼쳐져 있다", "\(wide.expanded)", "true")
    wide.collapseOrMoveUp()
    check("첫 줄에서 위 → 접힌다", "\(wide.expanded)", "false")

    // 마지막 줄에서 더 내려가지 않는다 (20개 = 3줄, 마지막 줄 시작은 18)
    var edge = CandidateModel.from(groups: [
        group("정", "normal", (1...20).map { "\($0)" })
    ])
    edge.expandOrMoveDown()  // 펼침
    edge.expandOrMoveDown()  // 9
    edge.expandOrMoveDown()  // 18
    check("마지막 줄", "\(edge.selected)", "18")
    edge.expandOrMoveDown()
    check("마지막 줄에서는 더 안 내려간다", "\(edge.selected)", "18")

    exit(failures == 0 ? 0 : 1)
}

if arguments.contains("--test-compose") {
    // 조합기를 UI 없이 확인해 Swift 래퍼의 회귀를 걸러 낸다.
    #if HAS_LIBHANGUL
        /// 키 이벤트가 오는 것과 같은 경로로 친다: 눌린 물리 키(소문자)와 Shift 상태를
        /// 주고, KeyTranslation → HangulComposer를 거친다.
        func type(_ keys: [(Character, Bool)]) -> String? {
            guard let composer = HangulComposer(keyboard: "2") else { return nil }
            var result = ""
            for (key, shift) in keys {
                guard
                    let ascii = KeyTranslation.asciiForHangul(
                        characters: String(key), shift: shift)
                else { continue }
                _ = composer.process(ascii: ascii)
                result += composer.commit
            }
            return result + composer.flush()
        }

        /// 셋째 값이 Shift를 누른 위치 (0-기반 인덱스 집합)
        let cases: [(String, Set<Int>, String)] = [
            ("gksrmf", [], "한글"),
            // Shift 조합
            ("rk", [0], "까"),
            ("tk", [0], "싸"),
            ("Qk", [0], "빠"),
            ("dp", [1], "예"),
            ("do", [1], "얘"),
            // Caps Lock으로 대문자가 와도 Shift가 없으면 쌍자음이 되면 안 된다
            ("RK", [], "가"),
        ]

        var failures = 0
        for (keys, shiftAt, expected) in cases {
            let pressed = keys.enumerated().map { (Character($1.lowercased()), shiftAt.contains($0)) }
            let actual = type(pressed) ?? "(조합기 생성 실패)"
            let ok = actual == expected
            if !ok { failures += 1 }
            let shiftNote = shiftAt.isEmpty ? "" : " (Shift: \(shiftAt.sorted().map(String.init).joined(separator: ",")))"
            print("'\(keys)'\(shiftNote) → '\(actual)' 기대 '\(expected)' \(ok ? "OK" : "*** 불일치 ***")")
        }
        exit(failures == 0 ? 0 : 1)
    #else
        Log.error("libhangul이 링크되지 않았다 — scripts/fetch-libhangul.sh를 먼저 돌려라")
        exit(1)
    #endif
}

// 입력 소스 관리. 등록(register)·활성화(enable)·전환(select)은 서로 다른 일이다 —
// 자세한 구분은 InputSourceTool 참조.
if arguments.contains("--register") {
    exit(InputSourceTool.register(bundleURL: Bundle.main.bundleURL))
}
if arguments.contains("--enable") {
    exit(InputSourceTool.enable())
}
if arguments.contains("--select") {
    exit(InputSourceTool.select())
}
if arguments.contains("--current") {
    exit(InputSourceTool.current())
}
if let index = arguments.firstIndex(of: "--select-id"), index + 1 < arguments.count {
    exit(InputSourceTool.select(id: arguments[index + 1]))
}
if arguments.contains("--disable") {
    exit(InputSourceTool.disable())
}
if arguments.contains("--list-sources") {
    exit(InputSourceTool.list())
}

// 여기부터는 입력기 본체로 뜨는 경로다. 시스템이 띄운 프로세스는 stderr도
// os.Logger도 사후에 읽을 수 없으므로 (Log.diagnostic 문서 참조) 기동이 어디까지
// 도달했는지를 파일로 남긴다 — "떴다가 0.2초 안에 조용히 죽는" 문제는 이것 없이
// 진단할 수 없다 (2026-08-02 회귀).
Log.diagnostic("기동 시작 — 부모 pid \(getppid())")

guard let bundleIdentifier = Bundle.main.bundleIdentifier else {
    Log.error(".app 번들로 실행해야 한다 (번들 식별자를 찾지 못했다)")
    Log.diagnostic("기동 실패: 번들 식별자 없음")
    exit(1)
}

let connectionName =
    (Bundle.main.infoDictionary?["InputMethodConnectionName"] as? String)
    ?? "Jieum_1_Connection"

// IMKServer는 전역으로 잡아 둬야 한다. 지역 변수로 두면 곧바로 해제되어
// 입력기가 아무 이벤트도 받지 못한 채 조용히 죽은 것처럼 보인다.
guard let server = IMKServer(name: connectionName, bundleIdentifier: bundleIdentifier) else {
    Log.error("IMKServer 생성 실패 (연결 이름 \(connectionName))")
    Log.diagnostic("기동 실패: IMKServer 생성 실패 — 연결 \(connectionName)")
    exit(1)
}
Log.diagnostic("IMKServer 생성됨 — 연결 \(connectionName)")

Log.info("지음 입력기 기동 — 연결 \(connectionName), 번들 \(bundleIdentifier)")
if Log.keyTracing {
    Log.info("키 추적이 켜져 있다 (JIEUM_DEBUG_KEYS=1) — 키코드만 남긴다")
}

JieumRuntime.shared.start()

// server를 쓰는 시늉을 해서 최적화로 사라지지 않게 한다
_ = server

Log.diagnostic("기동 완료 — 이벤트 루프 진입")
NSApplication.shared.run()
