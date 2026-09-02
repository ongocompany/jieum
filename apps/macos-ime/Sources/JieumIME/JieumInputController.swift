import Cocoa
import InputMethodKit

/**
 IMK 입력 컨트롤러

 `Info.plist`의 `InputMethodServerControllerClass`가 이 클래스를 가리킨다. Swift
 클래스 이름은 런타임에서 모듈 이름이 붙은 형태로 맹글링되므로 `@objc(...)`로
 이름을 고정해야 IMK가 찾을 수 있다. 어긋나면 입력기가 뜨긴 하는데 키 이벤트가
 하나도 오지 않는 형태로 조용히 실패한다.

 ## 조합 중인 단어는 문서에 넣지 않는다

 libhangul은 완성된 음절을 곧바로 확정해 흘려보내지만, 지음은 그것을 **문서에
 넣지 않고 모아 두었다가 단어 전체를 marked text로** 보여 준다.

 이유는 한자 치환이다. 음절을 즉시 넣으면 "발전소"를 發電所로 바꿀 때 이미 문서에
 들어간 세 글자를 되돌려 잡아야 하고, 그건 호스트 앱이 `replacementRange`에
 협조해야만 성립한다 — Mozc와 구름 양쪽에서 앱별 예외 목록이 자라는 바로 그
 지점이다. 단어를 marked text로 들고 있으면 `insertText`가 그것을 알아서 대체하므로
 그 문제 자체가 없다.

 대가는 조합 밑줄이 음절이 아니라 단어 전체에 걸린다는 것이다(시스템 한글 입력기와
 느낌이 다르다). 일본어·중국어 입력기가 모두 이 방식이며, 단어 단위로 변환하는 이상
 이쪽이 맞다고 보았다. 실사용에서 거슬리면 재론할 지점이다.
 */
@objc(JieumInputController)
final class JieumInputController: IMKInputController {

    /// 커서 위치를 바꾸지 않는다는 뜻의 범위
    private static let noReplacement = NSRange(location: NSNotFound, length: 0)

    /// 앞 문맥으로 읽어 올 글자 수 (core의 문맥 창과 같은 크기)
    private static let contextWindow = 200

    /// macOS 가상 키코드
    private enum KeyCode {
        static let delete: UInt16 = 51
        static let escape: UInt16 = 53
        static let returnKey: UInt16 = 36
        static let keypadEnter: UInt16 = 76
        static let arrowLeft: UInt16 = 123
        static let arrowRight: UInt16 = 124
        static let arrowDown: UInt16 = 125
        static let arrowUp: UInt16 = 126
    }

    #if HAS_LIBHANGUL
        private let composer: HangulComposer? = {
            if ProcessInfo.processInfo.environment["JIEUM_DISABLE_COMPOSITION"] == "1" {
                Log.info("조합이 꺼져 있다 (JIEUM_DISABLE_COMPOSITION=1)")
                return nil
            }
            guard let composer = HangulComposer(keyboard: "2") else {
                Log.error("libhangul 조합기 생성 실패 — 조합 없이 동작한다")
                return nil
            }
            return composer
        }()
    #endif

    /// 조합이 끝난 음절들 (문서에는 아직 없다 — marked text로만 보인다)
    private var wordBuffer = ""

    /// 이 단어가 시작될 때의 커서 앞 문맥. 단어를 치는 동안 다시 읽지 않는다
    private var precedingContext: String?
    private var candidates = CandidateModel()
    private let candidateWindow = CandidateWindow()

    /// 모드가 바뀐 것을 커서 옆에 잠깐 보여 준다
    private let modeIndicator = ModeIndicator()

    /**
     사용자가 후보를 실제로 고르는 중인가

     후보창이 떠 있다고 Enter를 먹으면 안 된다 — 한글만 치려던 사용자의 줄바꿈이
     사라진다. 방향키로 후보를 짚었을 때만 Enter가 확정이 된다.
     숫자키는 이 상태와 무관하게 동작한다(그것 자체가 명시적 선택이므로).
     */
    private var candidatesActive = false

    private var sessionId: String?
    /// 세션 요청이 날아가 있는가. 매 키마다 요청이 쌓이지 않게 막는다
    private var sessionRequestInFlight = false
    private var lookupSeq = 0

    /**
     이 입력 지점이 속한 앱의 번들 식별자.

     앱 호환 원장(`ContextStats`)의 기준 축이다. `bundleIdentifier()`는 IMK 왕복이라
     단어마다 부르지 않고 칸에 들어올 때 한 번만 읽는다.
     */
    private var clientBundleID: String?

    /**
     지금 붙들고 있는 텍스트 칸의 표식 (`ClientStats.tag`).

     키가 **다른 칸**으로 오는 것을 잡으려고 둔다 — 지음이 옛 칸에 대고 일하면 글자가
     화면에 닿지 않는다. 참조가 아니라 표식만 들고 있다(`ClientStats.tag` 주석).
     */
    private var activeClientTag: String?

    /// 지금 조합 중인 글자 수 (문서에는 아직 없는 것). 관찰용이라 내용은 세지 않는다
    private var composingLength: Int {
        #if HAS_LIBHANGUL
            return wordBuffer.count + (composer?.preedit.count ?? 0)
        #else
            return 0
        #endif
    }

    // MARK: - 수명

    override func activateServer(_ sender: Any!) {
        super.activateServer(sender)
        // 다른 텍스트 칸으로 옮겨 왔다 — 앞 문맥 기록은 그 칸의 것이 아니다
        insertedHistory = ""
        hasMarkedText = false
        clientBundleID = (sender as? IMKTextInput)?.bundleIdentifier()

        // ⚠️ 조합 상태(`wordBuffer`·`composer`)는 여기서 지우지 않는다. 짝이 되는
        //    `deactivateServer`가 비웠을 것이기 때문인데, 그 짝이 항상 오는지는
        //    확인된 바 없다 — `stranded`가 그것을 잰다 (`ClientStats`)
        let tag = ClientStats.tag(sender)
        activeClientTag = tag
        ClientStats.enter(app: clientBundleID, client: tag, stranded: composingLength)

        ensureSession()
    }

    /**
     세션이 없으면 연다.

     ⚠️ **한 번만 시도하면 안 된다.** `activateServer`는 입력기가 막 뜬 직후에도 불리는데,
     그때는 엔진 소켓이 아직 안 붙어 있어 `sessionOpen`이 조용히 실패한다. 그러면 그 칸의
     세션은 **영영 비어 있고**, 세션이 필요한 것들이 아무 말 없이 동작하지 않는다.

     사용 이력(MRU)은 세션 없이도 돌기 때문에 이 구멍은 오래 보이지 않았다. 사용자 조합
     학습을 붙이고 나서야 드러났다 — 실기기에서 글자는 멀쩡히 쳐지는데 조합이 하나도
     안 배워졌고, 엔진 로그에 `조합 아님: no-session`만 쌓였다 (2026-08-28).
     */
    private func ensureSession() {
        if sessionId != nil || sessionRequestInFlight { return }
        sessionRequestInFlight = true
        JieumRuntime.shared.client.sessionOpen { [weak self] result in
            self?.sessionRequestInFlight = false
            switch result {
            case let .success(id):
                self?.sessionId = id
            case let .failure(error):
                // 다음 타이핑에서 다시 시도한다. 여기서 포기하면 그 칸은 영영 세션이 없다.
                Log.diagnostic("세션 열기 실패 — 다음 입력에서 재시도한다 (\(error))")
            }
        }
    }

    override func deactivateServer(_ sender: Any!) {
        // ⚠️ `flushComposition`보다 **먼저** 재야 한다. 그 뒤에는 조합이 비어 있어
        //    무엇을 넘겼는지 알 수 없다
        ClientStats.leave(
            app: resolveBundleID(sender), client: ClientStats.tag(sender),
            carried: composingLength)

        // 포커스를 잃을 때 조합 중인 글자를 잃어버리면 안 된다
        flushComposition(client: sender)
        hideCandidates()
        modeIndicator.hide()
        if let sessionId {
            JieumRuntime.shared.client.sessionClose(sessionId)
            self.sessionId = nil
        }
        // 앱 식별자도 함께 비운다. 남겨 두면 `activateServer` 없이 다음 칸으로 키가
        // 오는 경우 **옛 앱 이름**으로 기록되어, 조사하려던 사건이 엉뚱한 앱에 붙는다
        activeClientTag = nil
        clientBundleID = nil
        super.deactivateServer(sender)
    }

    /**
     키가 온 칸이 우리가 붙들고 있는 칸과 같은가.

     다르면서 **조합 중이면** 사건이다 — 지음은 옛 칸에 marked text를 띄워 두었는데
     사용자는 새 칸을 보고 있으므로, 그 글자는 어디에도 없다. 조합이 비어 있을 때의
     전환은 잃을 글자가 없어 무해하다.

     알린 뒤에는 새 칸을 기준으로 삼는다. 안 그러면 같은 어긋남이 키마다 쌓인다.
     */
    private func noteClientIfChanged(_ sender: Any!) {
        let tag = ClientStats.tag(sender)
        guard tag != activeClientTag else { return }
        if composingLength > 0, let previous = activeClientTag {
            ClientStats.mismatch(
                app: resolveBundleID(sender), from: previous, to: tag, composing: composingLength)
        }
        activeClientTag = tag
    }

    /**
     앱 식별자. 아직 못 읽었으면 이 자리에서 읽어 캐시에 채운다.

     `activateServer`에서만 읽으면 **그 콜백이 오지 않는 경로**에서 앱이 통째로
     비는데, 지금 쫓는 것이 정확히 그 경로다. 어느 앱이었는지가 원장의 전부라
     비워 둔 채로 세면 집계가 무의미해진다 (`readPrecedingContext`와 같은 이유).

     `[근거: 2026-08-07 설치 직후 "떠나며 확정 앱=(알수없음) 글자=1자" — 활성=0 비활성=1]`

     IMK 왕복이라 값이 없을 때만 부른다.
     */
    private func resolveBundleID(_ sender: Any!) -> String? {
        if clientBundleID == nil {
            clientBundleID = (sender as? IMKTextInput)?.bundleIdentifier()
        }
        return clientBundleID
    }

    // MARK: - 키 처리

    /**
     어떤 이벤트를 받을 것인가.

     글자 키만이 아니라 **수식키 상태 변화**도 받는다 — 왼쪽 ⌘+Shift만 눌렀다 떼는
     손짓은 글자 키를 하나도 만들지 않으므로, 이것을 신청하지 않으면 지음 귀에는
     아무 일도 일어나지 않은 것으로 들린다.

     ⚠️ 이걸 열어도 **글자 키 쪽 규칙은 그대로다.** 아래 `handle`의 「⌘·⌃ 조합은
     절대 먹지 않는다」가 그대로 살아 있어야 ⌘S가 죽지 않는다. 수식키 이벤트도
     처리만 하고 항상 `false`를 돌려준다.
     */
    override func recognizedEvents(_ sender: Any!) -> Int {
        Int(NSEvent.EventTypeMask.keyDown.rawValue | NSEvent.EventTypeMask.flagsChanged.rawValue)
    }

    override func handle(_ event: NSEvent!, client sender: Any!) -> Bool {
        guard let event else { return false }

        if event.type == .flagsChanged {
            if ModeChord.shared.flagsChanged(
                keyCode: event.keyCode, flags: event.modifierFlags.rawValue)
            {
                toggleSuggestions(reason: "단축키", client: sender)
            }
            // 수식키는 **절대 먹지 않는다**. 먹으면 그 뒤에 오는 단축키가 죽는다.
            return false
        }

        guard event.type == .keyDown else { return false }

        // 손짓 중에 글자 키가 왔다 — 이건 ⌘⇧4 같은 단축키의 앞자리였다는 뜻이다
        ModeChord.shared.keyDown()

        Log.key(keyCode: event.keyCode, modifiers: event.modifierFlags.rawValue)

        // 어떤 키에서든 칸 어긋남은 관찰돼야 한다. 아래 ⌘·⌃ 갈래가 조합을 비우므로
        // 그전에 재야 무엇을 안고 있었는지가 남는다
        noteClientIfChanged(sender)

        // ⌘·⌃ 조합은 **절대** 먹지 않는다. 먹으면 ⌘S·⌃A 같은 것이 죽고, 그건
        // 입력기를 쓸 수 없게 만드는 종류의 결함이다.
        if event.modifierFlags.contains(.command) || event.modifierFlags.contains(.control) {
            flushComposition(client: sender)
            return false
        }

        // 지음 안에 영문 모드를 두지 않는다.
        //
        // 한/영은 **시스템 입력 소스 전환**에 맡긴다 (지음 ↔ macOS 기본 영문).
        // Shift+Space 내부 전환은 두 가지 이유로 사용하지 않는다:
        //
        // 1. 입력 소스와 내부 모드라는 **두 개의 상태**가 생기고, 어긋나면 "지음인데
        //    한글이 안 쳐진다"가 된다 — 화면에는 지음이라고 표시되므로 원인을 찾기
        //    어렵다. 실제로 이 증상으로 하루를 썼다.
        // 2. Shift+Space는 문자를 만드는 키라서, kitty 키보드 프로토콜을 켠 TUI에서는
        //    우리가 소비(`return true`)해도 터미널이 PTY로 흘려 공백이 한 칸 들어갔다
        //    (`docs/notes/macos-app-compat.md` 3번).
        //
        // 되살리고 싶어지면 그 두 가지를 먼저 해결해야 한다.

        #if HAS_LIBHANGUL
            if let composer {
                if handleCandidateKey(event, client: sender) { return true }
                return handleComposing(event, composer: composer, client: sender)
            }
            // 조합기가 없으면 키가 그대로 앱에 흘러간다 — 입력 소스는 지음인데 한글이
            // 안 나오는 상태다. 기동 때 한 번 오류를 남기지만 그 줄은 로그 위쪽에
            // 파묻히므로, 실제로 그 상태에서 타이핑이 일어났다는 것을 여기서 센다
            ClientStats.noComposer(app: clientBundleID)
        #endif
        return false
    }

    // MARK: - 후보 조작

    /// 후보창이 떠 있을 때만 의미가 있는 키들. 처리했으면 true
    private func handleCandidateKey(_ event: NSEvent, client sender: Any!) -> Bool {
        guard !candidates.isEmpty else { return false }

        switch event.keyCode {
        // ⚠️ Shift 조합을 **먼저** 가른다. Swift의 switch는 위에서부터 맞추므로 아래에
        //    두면 맨 방향키 케이스가 먼저 먹어 후보만 움직인다.
        //
        // 후보창을 커서 위로 올릴지 아래로 내릴지는 기계가 가릴 수 없다(`Settings`의
        // `placements` 주석 참조). 사용자가 그 자리에서 정하고 앱별로 기억한다.
        // 조합 중에는 우리가 키를 먹으므로 앱의 선택 확장(Shift+방향키)과 부딪히지
        // 않는다 — 조합이 없으면 `candidates`가 비어 이 함수 자체를 지나간다.
        case KeyCode.arrowUp where event.modifierFlags.contains(.shift):
            movePlacement(above: true, client: sender)
            return true

        case KeyCode.arrowDown where event.modifierFlags.contains(.shift):
            movePlacement(above: false, client: sender)
            return true

        // 후보창은 **가로 한 줄**이다. 다음 후보는 아래가 아니라 오른쪽에 있다.
        //
        // 가로 후보창에서는 좌우 키가 이전·다음 후보로 움직여야 한다.
        case KeyCode.arrowRight:
            candidatesActive = true
            candidates.moveNext()
            refreshCandidateWindow(client: sender)
            return true

        case KeyCode.arrowLeft:
            candidatesActive = true
            candidates.movePrevious()
            refreshCandidateWindow(client: sender)
            return true

        // 위아래는 **펼치고 접는다.** 접힌 줄 뒤에 후보가 더 있다는 것을 쪽 표시(`2/3`)
        // 하나로만 알리기보다 아래 키로 전체 목록을 펼친다.
        case KeyCode.arrowDown:
            candidatesActive = true
            candidates.expandOrMoveDown()
            refreshCandidateWindow(client: sender)
            return true

        case KeyCode.arrowUp:
            candidatesActive = true
            candidates.collapseOrMoveUp()
            refreshCandidateWindow(client: sender)
            return true

        case KeyCode.returnKey, KeyCode.keypadEnter:
            // 후보를 짚지 않았으면 Enter는 사용자의 줄바꿈이다
            guard candidatesActive, let item = candidates.selectedItem else { return false }
            commitCandidate(item, client: sender)
            return true

        case KeyCode.escape:
            // 후보만 접는다. 조합은 남는다 — 사용자는 한글로 계속 칠 수 있다
            hideCandidates()
            return true

        default:
            break
        }

        // 숫자키 선택. 그 자리에 후보가 없으면 먹지 않는다 —
        // 후보가 3개인데 5를 눌렀다면 사용자는 숫자 5를 치려던 것이다.
        //
        // 숫자를 문자로 넣으려면 `Esc`로 후보를 먼저 닫는다.
        // `제3한강교`·`사당3동`처럼 숫자가 단어 중간에 들어가는 것은 실사용에서 잦다.
        // `Esc`는 후보만 접고 조합은 남기므로(위 `KeyCode.escape`), 이어 친 숫자가
        // 단어 경계가 되어 `제`가 한글로 확정되고 `3`이 그대로 들어간다.
        //
        // 다른 길을 전부 검토하고 이것을 골랐다:
        // - **자동 판정은 불가능하다.** "숫자로 확정한 뒤 한글이 오면 되돌린다"는
        //   `韓國`+`사람`처럼 복합어를 나눠 치는 것과 키 순서가 같다.
        // - **사후 무르기(Backspace) 기각.** 이미 문서에 들어간 글자를 지우는 일이라
        //   두 글자(`祠堂`)면 범위 치환이 필요하고 호스트마다 다르게 깨진다. 확정 **전에**
        //   막는 것은 호스트와 무관하게 어디서나 같이 동작한다.
        // - **선택키를 숫자에서 옮기는 안 기각.** `tools/eval`에서 "그냥 확정"으로 집계되는
        //   90%도 실제로는 숫자 `1`을 누르는 것이다(`score.ts`의 rank 0). 옮기면 한자 입력
        //   **전부**가 키 두 번이 된다 — 5~7%를 살리려고 90%를 비싸게 만드는 거래다.
        //
        // ⚠️ 수식키가 눌렸으면 숫자로 보지 않는다. `charactersIgnoringModifiers`는
        // 이름 그대로 **수식키를 무시한** 문자를 돌려주므로 Shift+9(`(`)에서 `9`가
        // 온다. 그대로 두면 괄호를 칠 때마다 9번 후보가 확정된다. Shift·Option 조합은 특수문자이므로
        // 후보 선택은 맨 숫자키에만 허용한다.
        let selectionBlockers: NSEvent.ModifierFlags = [.shift, .option, .command, .control]
        if event.modifierFlags.intersection(selectionBlockers).isEmpty,
            let scalar = event.charactersIgnoringModifiers?.unicodeScalars.first,
            let digit = Int(String(scalar)),
            digit >= 1,
            let item = candidates.select(number: digit)
        {
            commitCandidate(item, client: sender)
            return true
        }

        return false
    }

    #if HAS_LIBHANGUL
        private func handleComposing(
            _ event: NSEvent, composer: HangulComposer, client sender: Any!
        ) -> Bool {
            switch event.keyCode {
            case KeyCode.delete:
                if composer.backspace() {
                    updateComposition(composer: composer, client: sender)
                    return true
                }
                if !wordBuffer.isEmpty {
                    wordBuffer.removeLast()
                    updateComposition(composer: composer, client: sender)
                    return true
                }
                return false

            case KeyCode.escape:
                // 후보가 없을 때의 Escape — 조합 중인 것을 확정한다.
                // 버리는 쪽이 관례지만 확정 규칙은 실사용을 보고 정한다.
                flushComposition(client: sender)
                return false

            default:
                break
            }

            // Shift는 이벤트 플래그에서 직접 읽는다 — charactersIgnoringModifiers가
            // Shift를 반영하는지가 레이아웃에 따라 달라지기 때문이다 (KeyTranslation 참조).
            guard
                let ascii = KeyTranslation.asciiForHangul(
                    characters: event.charactersIgnoringModifiers,
                    shift: event.modifierFlags.contains(.shift))
            else {
                flushComposition(client: sender)
                return false
            }

            // 단어의 첫 글자를 치는 순간 앞 문맥을 한 번 읽어 둔다.
            // 치는 동안 다시 읽지 않는다 — marked text가 커지면서 커서가 움직이므로
            // 도중에 읽으면 조합 중인 글자 자신이 문맥에 섞인다.
            if wordBuffer.isEmpty && composer.isEmpty {
                precedingContext = readPrecedingContext(client: sender)
                // 단어를 시작하는 이 자리가 세션을 다시 여는 자리이기도 하다 —
                // 기동 직후에 놓친 세션을 여기서 만회한다 (`ensureSession` 머리말).
                ensureSession()
            }

            let consumed = composer.process(ascii: ascii)
            wordBuffer += composer.commit

            guard consumed else {
                // 한글 자판과 무관한 키 — 여기가 단어 경계다
                flushComposition(client: sender)
                // 이 키는 호스트가 문서에 넣을 것이다(공백·문장부호 등). 자체 기록에도
                // 반영해 둬야 "이번 선거에 출마한 "처럼 띄어쓰기가 살아 있는 문맥이 된다.
                // 호스트가 정말 넣었는지는 알 수 없는 추정이지만, 이 기록은 어차피
                // 호스트가 협조하지 않을 때의 대비책이라 근사로 충분하다.
                if ascii >= 0x20, let scalar = Unicode.Scalar(UInt32(ascii)) {
                    rememberInserted(String(Character(scalar)))
                }
                return false
            }

            updateComposition(composer: composer, client: sender)
            return true
        }

        /// marked text와 후보를 현재 조합 상태에 맞춘다
        private func updateComposition(composer: HangulComposer, client sender: Any!) {
            let buffer = wordBuffer + composer.preedit
            setMarkedText(buffer, client: sender)

            guard !buffer.isEmpty else {
                hideCandidates()
                return
            }
            requestCandidates(for: buffer, client: sender)
        }
    #endif

    // MARK: - 확정

    /**
     조합 중인 것을 한글 그대로 확정한다.

     ⚠️ **`preedit`를 더하지 않는다.** `hangul_ic_flush`는 버퍼를 비우면서 조합 중이던
     글자를 **반환한다**(`hangulinputcontext.c` — `hangul_buffer_get_string` →
     `flushed_string` 반환). 둘을 더하면 글자가 두 번 들어간다.

     이 결함이 오래 숨어 있던 이유: 공백·문장부호로 단어가 끝나는 흔한 경로는
     `composer.process(ascii:)`를 먼저 거치는데, 거기서 조합이 확정돼 `commit`으로
     빠지므로 preedit가 이미 비어 있다. `process`를 건너뛰고 여기로 바로 오는 경로
     (Shift+Space 한/영 전환, ⌘·⌃ 조합, 포커스 이탈)에서만 드러난다.
     조합 중 Shift+Space에서 `한한`이 입력되던 회귀가 이 경로에서 발생했다.
     */
    private func flushComposition(client sender: Any!) {
        hideCandidates()
        #if HAS_LIBHANGUL
            guard let composer else { return }
            let remaining = wordBuffer + composer.flush()
            wordBuffer = ""
            precedingContext = nil
            guard !remaining.isEmpty else {
                // 지울 marked text가 없으면 **부르지 않는다.** 빈 문자열로 marked text를
                // 설정하는 것은 "조합 없음"을 뜻하지만, 일부 터미널은 그것을 빈 문자
                // 확정으로 처리해 공백 한 칸을 넣는다.
                if hasMarkedText { setMarkedText("", client: sender) }
                return
            }
            // insertText가 marked text를 대체한다 — 따로 지울 필요가 없다
            insert(remaining, client: sender)
        #endif
    }

    /**
     후보를 한자로 확정한다.

     고른 후보가 조합 버퍼보다 짧을 수 있다 — "발전소"를 치다 "발전"을 고르면
     남은 "소"는 한글로 뒤에 붙인다. 그 경우 조합은 거기서 끝난다.
     */
    private func commitCandidate(_ item: CandidateItem, client sender: Any!) {
        #if HAS_LIBHANGUL
            let buffer = wordBuffer + (composer?.preedit ?? "")
            let remainder = buffer.hasPrefix(item.word)
                ? String(buffer.dropFirst(item.word.count)) : ""

            _ = composer?.flush()
            wordBuffer = ""
            hideCandidates()

            // 설정에 따라 한자만 넣거나 한글을 살린 채 괄호로 병기한다.
            // 사용 이력은 화면에 넣은 모양이 아니라 **표제어와 한자**로 기록한다 —
            // 병기 설정을 바꿔도 그동안 쌓인 학습이 그대로 살아야 한다.
            let converted = Settings.shared.format(hangul: item.word, hanja: item.hanja)
            logCommitStyleIfChanged()
            insert(converted + remainder, client: sender)

            // 사용 이력은 **조회 때 받은 문맥 키**로 기록한다. 여기서 앞 문맥을
            // 다시 읽으면 조합 때와 다른 칸에 쌓여 다음에 안 올라온다.
            JieumRuntime.shared.client.commit(
                headword: item.word, hanja: item.hanja,
                contextKey: item.contextKey, sessionId: sessionId)

            precedingContext = nil
        #endif
    }

    // MARK: - 후보 조회

    private func requestCandidates(for buffer: String, client sender: Any!) {
        // 후보를 끄면 조회 자체를 건너뛴다. 창만 감추면 한글만 쓰는 동안에도
        // 매 키 입력마다 소켓 왕복이 계속된다 — 거슬림만 없어지고 비용은 그대로다.
        guard Settings.shared.suggestionsEnabled else {
            hideCandidates()
            return
        }

        let runtime = JieumRuntime.shared
        guard runtime.client.isConnected else {
            // 엔진이 없어도 타이핑은 계속된다 — 제안만 사라진다 (D6).
            // 배경에서 다시 붙기를 시도한다. 이 호출은 즉시 돌아오므로 지금 치는
            // 키가 늦어지지 않고, 붙는 데 성공하면 다음 조회부터 제안이 돌아온다.
            runtime.ensureConnected()
            hideCandidates()
            return
        }

        lookupSeq += 1
        let seq = lookupSeq
        let started = DispatchTime.now().uptimeNanoseconds

        runtime.client.lookup(
            buffer: buffer, precedingText: precedingContext, sessionId: sessionId
        ) {
            [weak self] result in
            let elapsedMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000

            DispatchQueue.main.async {
                guard let self else { return }
                // 이 응답을 기다리는 사이에 더 친 글자가 있으면 버린다.
                // 클라이언트의 토큰 판정과 별개로, 조합 상태가 이미 달라졌다.
                guard seq == self.lookupSeq else { return }

                switch result {
                case let .success(reply):
                    guard let reply else { return }
                    runtime.latency.record(elapsedMs)
                    self.candidates = CandidateModel.from(groups: reply.groups)
                    self.candidatesActive = false
                    self.refreshCandidateWindow(client: sender)
                case let .failure(error):
                    Log.error("조회 실패: \(error)")
                    self.hideCandidates()
                }
            }
        }
    }

    private func refreshCandidateWindow(client sender: Any!) {
        guard !candidates.isEmpty else {
            hideCandidates()
            return
        }
        candidateWindow.show(model: candidates,
                             caretRect: caretRect(client: sender),
                             preferAbove: Settings.shared.prefersAbove(app: clientBundleID))
    }

    /**
     이 앱에서 후보창을 어느 쪽에 둘지 사용자가 정한다 (`Shift+↑/↓`).

     기억해 두는 것이 핵심이다. 매번 눌러야 하면 결국 아무도 안 쓴다 — 검색창에
     들어갈 때마다 손이 한 번 더 가느니 가려진 채로 쓰게 된다.
     */
    private func movePlacement(above: Bool, client sender: Any!) {
        Settings.shared.setPrefersAbove(above, app: clientBundleID)
        Log.info("후보창 자리: \(above ? "위" : "아래") (앱 \(clientBundleID ?? "모름"))")
        // 누른 그 자리에서 창이 움직여야 사용자가 결과를 본다
        refreshCandidateWindow(client: sender)
    }

    private func hideCandidates() {
        candidates = CandidateModel()
        candidatesActive = false
        candidateWindow.hide()
    }

    // MARK: - 호스트 앱과의 대화

    private func insert(_ text: String, client sender: Any!) {
        (sender as? IMKTextInput)?.insertText(text, replacementRange: Self.noReplacement)
        // insertText가 marked text를 대체하므로 이후에는 떠 있는 것이 없다
        hasMarkedText = false
        rememberInserted(text)
    }

    /**
     marked text가 지금 떠 있는가.

     "지울 것이 없는데 지우는" 호출을 막는 데 쓴다 — 그 호출이 일부 호스트에서 공백을
     낳는다(`flushComposition` 참조). 상태를 따로 들고 있는 이유는 IMK가 이것을 물어볼
     방법을 주지 않기 때문이다.
     */
    private var hasMarkedText = false

    private func setMarkedText(_ text: String, client sender: Any!) {
        // 선택 범위를 문자열 끝에 둬야 커서가 조합 중인 글자 뒤에 온다.
        // UTF-16 길이로 세야 한다 — 한글은 대부분 1이지만 확장 영역은 2다.
        (sender as? IMKTextInput)?.setMarkedText(
            text,
            selectionRange: NSRange(location: text.utf16.count, length: 0),
            replacementRange: Self.noReplacement)
        hasMarkedText = !text.isEmpty
    }

    /**
     커서 앞 문맥.

     ## 두 출처를 쓴다

     1. **호스트 앱**(`selectedRange` + `attributedSubstring`). 정확하지만 앱이
        협조해야 성립한다. 일부 호스트는 이 값을 주지 않거나 부정확하게 돌려준다.
     2. **우리가 방금 넣은 글자**(`insertedHistory`). 호스트가 뭘 하든 우리는 우리가
        무엇을 넣었는지 안다. 사용자가 지음으로 계속 치고 있다면 앞 문맥은 거의 전부
        우리가 넣은 것이므로, 이 출처만으로도 연어 판별이 산다.

     1번이 더 정확하니(다른 입력기로 친 글자, 붙여넣은 글자까지 본다) 먼저 쓰고,
     비면 2번으로 물러난다. 둘 다 없으면 버퍼만으로 후보를 낸다 — 연어가 빠질 뿐
     입력은 멈추지 않는다.
     */
    private func readPrecedingContext(client sender: Any!) -> String? {
        // 앱 식별자는 칸에 들어올 때 한 번 읽어 둔다. 못 읽었으면 지금 시도한다 —
        // 어느 앱이었는지가 원장의 전부라서, 비워 둔 채로 세면 집계가 무의미해진다
        let app = clientBundleID ?? (sender as? IMKTextInput)?.bundleIdentifier()

        var hostFailure: HostContextFailure?
        switch readPrecedingContextFromHost(client: sender) {
        case let .ok(text):
            ContextStats.record(app: app, source: .host, hostFailure: nil)
            return text
        case let .unavailable(reason):
            hostFailure = reason
        }

        if !insertedHistory.isEmpty {
            ContextStats.record(app: app, source: .ownHistory, hostFailure: hostFailure)
            return insertedHistory
        }
        ContextStats.record(app: app, source: .bufferOnly, hostFailure: hostFailure)
        return nil
    }

    /// 호스트에서 앞 문맥을 읽은 결과. 실패는 **사유가 붙은 값**으로 돌려준다 —
    /// 그래야 집계가 "왜 못 받았는가"까지 셀 수 있다 (`ContextStats`)
    private enum HostContext {
        case ok(String)
        case unavailable(HostContextFailure)
    }

    private func readPrecedingContextFromHost(client sender: Any!) -> HostContext {
        guard let client = sender as? IMKTextInput else {
            return .unavailable(.notTextInput)
        }

        // 둘을 갈라야 한다. "호스트가 커서를 모른다"는 문서 모델을 안 주는 칸이라는
        // 신호이고(검색창류), "커서는 아는데 0"은 빈 입력칸의 정상 상태다(채팅·편집기).
        // 뭉쳐 두면 후보창을 어디에 놓을지 가릴 수 없다.
        let cursor = client.selectedRange().location
        guard cursor != NSNotFound else {
            return .unavailable(.cursorUnknown)
        }
        guard cursor > 0 else {
            return .unavailable(.documentStart)
        }

        // 문서 길이로 잘라 낸다.
        //
        // 커서 위치가 문서 길이를 넘게 오는 경우가 있다(호스트마다 다르다). 그대로
        // 범위를 만들면 문서 밖을 요구하게 되고 호스트는 통째로 nil을 준다 — 앞
        // 200자가 멀쩡히 있는데도 문맥이 통째로 사라진다. 실제로 진단 로그에서
        // "요청 길이=200인데 nil"로 잡혔다.
        var end = cursor
        let documentLength = client.length()
        if documentLength > 0 { end = min(end, documentLength) }
        guard end > 0 else {
            return .unavailable(.emptyDocument)
        }

        let start = max(0, end - Self.contextWindow)
        let range = NSRange(location: start, length: end - start)
        // 빈 문자열도 실패로 친다. 호출자가 다시 판정하면 "받았는데 비었다"가 어느
        // 칸에도 안 세어져 집계에서 사라진다
        guard let text = client.attributedSubstring(from: range)?.string, !text.isEmpty else {
            return .unavailable(.emptySubstring)
        }
        return .ok(text)
    }

    /**
     우리가 넣은 글자의 기록 (호스트가 문맥을 안 줄 때의 대비책)

     화면에 실제로 들어간 것만 담는다 — 조합 중인 marked text는 아직 문서가 아니므로
     넣지 않는다. 앞쪽은 문맥 창 크기만큼만 남기고 버린다.
     */
    private var insertedHistory = ""

    private func rememberInserted(_ text: String) {
        insertedHistory += text
        if insertedHistory.count > Self.contextWindow {
            insertedHistory = String(insertedHistory.suffix(Self.contextWindow))
        }
    }

    // MARK: - 입력 소스 메뉴

    /**
     메뉴 막대의 입력 소스 드롭다운에 붙는 메뉴

     확정 형식과 괄호는 자주 바뀌지 않는 설정이므로 입력 소스 메뉴에 둔다.
     */
    override func menu() -> NSMenu! {
        let settings = Settings.shared
        let menu = NSMenu(title: "지음")
        // 자동 활성화를 끈다. 켜 두면 AppKit이 target/action 응답 여부로 활성 상태를
        // 스스로 정하고 우리가 지정한 isEnabled를 무시하는데, 서브메뉴를 가진 항목은
        // action이 nil이라 통째로 비활성이 된다.
        //
        // **항목에 target을 지정하지 않는다.** IMK 메뉴는 우리 프로세스가 아니라
        // 시스템 UI가 그리므로 객체 참조가 경계를 넘지 못한다. target을 비워 두면
        // IMK가 선택을 현재 입력 컨트롤러로 보낸다 — Apple의 IMK 예제가 메뉴를
        // nib에 두고 First Responder에 연결하는 것과 같은 이유다.
        menu.autoenablesItems = false

        let toggle = NSMenuItem(
            title: "한자 후보 보이기", action: #selector(toggleSuggestions(_:)), keyEquivalent: "")
        toggle.state = settings.suggestionsEnabled ? .on : .off
        toggle.isEnabled = true
        menu.addItem(toggle)

        // 잘못 배운 조합을 지우는 길. 자동 학습만으로는 나쁜 항목을 영영 막을 수 없어
        // **사람의 거부권**이 있어야 한다 (설계 §5.6·§6).
        //
        // 사용자가 만든 조합일 때만 켠다. 사전 후보에 이걸 걸면 사용자는 지운 줄
        // 알았는데 계속 나오는 것을 보게 된다 — 지울 수 있는 것은 우리가 배운 것뿐이다.
        let forget = NSMenuItem(
            title: "이 후보 잊기", action: #selector(forgetSelectedCandidate(_:)), keyEquivalent: "")
        forget.isEnabled = candidates.selectedItem?.isUserWord ?? false
        menu.addItem(forget)

        menu.addItem(.separator())

        // ⚠️ **서브메뉴를 쓰지 않는다.** 시스템 UI는 서브메뉴 항목의 액션을 우리
        // 컨트롤러로 보내지 않는다 — 최상위 "한자 후보 보이기"는 눌리는데 서브메뉴
        // 안의 항목은 회색으로 남고 아무 일도 일어나지 않았다. 진단 로그로 최상위
        // 액션만 도달한다는 것을 확인했다(2026-08-01 12:15 "한자 후보 끔/켬").
        // 그래서 선택지를 평면으로 펴고 제목 줄은 비활성 항목으로 둔다.

        addSectionHeader("확정 형식", to: menu)
        // 항목 이름 대신 문서에 실제로 들어갈 모양만 보여 준다.
        for (index, style) in Settings.CommitStyle.allCases.enumerated() {
            let item = NSMenuItem(
                title: sampleText(style: style, brackets: settings.bracketStyle),
                action: #selector(setCommitStyle(_:)), keyEquivalent: "")
            item.state = settings.commitStyle == style ? .on : .off
            item.tag = index
            item.isEnabled = true
            item.indentationLevel = 1
            menu.addItem(item)
        }

        menu.addItem(.separator())

        // 괄호 — 병기하지 않는 형식에서는 쓰이지 않으므로 비활성으로 둔다
        let bracketsUsed = settings.commitStyle != .hanjaOnly
        addSectionHeader("병기 괄호", to: menu)
        for (index, bracket) in Settings.BracketStyle.allCases.enumerated() {
            let item = NSMenuItem(
                title: bracket.label, action: #selector(setBracketStyle(_:)), keyEquivalent: "")
            item.state = settings.bracketStyle == bracket ? .on : .off
            item.tag = index
            item.isEnabled = bracketsUsed
            item.indentationLevel = 1
            menu.addItem(item)
        }

        menu.addItem(.separator())

        let runtime = JieumRuntime.shared
        let about = NSMenuItem(
            title: "지음 \(Bundle.main.displayVersion)"
                + (runtime.serverVersion.map { " · 엔진 \($0)" } ?? " · 엔진 연결 안 됨")
                + (runtime.dictFingerprint.map { " · 사전 \($0)" } ?? ""),
            action: nil, keyEquivalent: "")
        about.isEnabled = false
        menu.addItem(about)

        return menu
    }

    /// 평면 메뉴에서 선택지 묶음을 나누는 제목 줄 (누를 수 없다)
    private func addSectionHeader(_ title: String, to menu: NSMenu) {
        let header = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
    }

    /// 메뉴에 보여 줄 확정 모양 미리보기
    private func sampleText(style: Settings.CommitStyle, brackets: Settings.BracketStyle) -> String {
        let (open, close) = brackets.pair
        switch style {
        case .hanjaOnly: return "漢字"
        case .hangulThenHanja: return "한자\(open)漢字\(close)"
        case .hanjaThenHangul: return "漢字\(open)한자\(close)"
        }
    }

    // ⚠️ **IMK는 메뉴 액션의 sender로 NSMenuItem이 아니라 infoDictionary를 넘긴다.**
    // IMKInputController.h가 문서화한 계약이다 — kIMKCommandMenuItemName 키에 항목,
    // kIMKCommandClientName 키에 클라이언트. sender를 NSMenuItem으로 선언하고 tag를
    // 부르면 NSDictionary에 tag 셀렉터가 날아가 예외가 나는데, IMK가 그 예외를
    // 삼키면서 **메뉴 연결만 조용히 죽는다** — 프로세스는 살고 크래시 리포트도 없어
    // "항목이 한 번 보이고, 형식을 고르면 사라진다"는 미스터리가 된다(2026-08-02
    // 실측). 어제 "서브메뉴 액션 미도달"로 보였던 것도 상당 부분 이것이다: sender를
    // 안 만지는 토글만 살아남았고, tag를 읽는 형식·괄호 액션은 전부 죽었다.
    //
    // 그래서 진입 로그는 **sender를 건드리기 전에, 인자 없이** 남긴다. 항목 식별은
    // 여전히 tag다(정수라 직렬화 경계를 안전하게 넘는다) — 단, 딕셔너리에서 꺼낸
    // NSMenuItem의 tag를 읽는다.

    /// IMK 메뉴 액션의 sender에서 실제 NSMenuItem을 꺼낸다
    private func menuItem(from sender: Any?) -> NSMenuItem? {
        if let item = sender as? NSMenuItem { return item }
        guard let info = sender as? [AnyHashable: Any] else { return nil }
        if let item = info["IMKCommandMenuItem"] as? NSMenuItem { return item }
        // 키 문자열이 OS 버전에 따라 흔들려도 딕셔너리 안의 NSMenuItem은 하나뿐이다
        return info.values.compactMap { $0 as? NSMenuItem }.first
    }

    @objc private func toggleSuggestions(_ sender: Any?) {
        toggleSuggestions(reason: "메뉴", client: nil)
    }

    /**
     한자 모드와 한글 전용 모드를 오간다.

     메뉴와 단축키가 같은 길을 탄다 — 갈라 두면 한쪽만 고쳐져 어긋난다.

     - Parameter client: 커서 옆에 표시를 띄울 대상. 메뉴에서 부를 때는 없다
       (메뉴를 고르는 순간 눈은 메뉴에 있고, 고른 것이 곧 표시다).
     */
    private func toggleSuggestions(reason: String, client sender: Any?) {
        let settings = Settings.shared
        settings.suggestionsEnabled.toggle()
        Log.diagnostic("\(reason): 한자 후보 \(settings.suggestionsEnabled ? "켬" : "끔")")
        // 끄는 순간 떠 있던 후보창은 즉시 치운다 — 다음 키를 칠 때까지 남아 있으면
        // 방금 끈 설정이 안 먹은 것처럼 보인다.
        if !settings.suggestionsEnabled { hideCandidates() }

        if let sender {
            // 표시는 관찰 집계에 넣지 않는다 — 캐럿 통계는 조합 중의 값을 재는 것이다
            modeIndicator.flash(
                settings.suggestionsEnabled ? "漢字" : "한글",
                caretRect: caretRect(client: sender, record: false))
        }
    }

    /**
     지금 짚은 후보가 사용자 조합이면 잊는다.

     후보창을 곧바로 닫는다 — 잊은 것이 목록에 그대로 남아 있으면 안 지워진 것처럼
     보인다. 다음 글자를 치면 새 조회가 나가므로 목록은 저절로 갱신된다.
     */
    @objc private func forgetSelectedCandidate(_ sender: Any?) {
        guard let item = candidates.selectedItem, item.isUserWord else {
            Log.diagnostic("메뉴: 잊기 — 사용자 조합이 아니다")
            return
        }
        JieumRuntime.shared.client.forgetUserWord(reading: item.word, hanja: item.hanja)
        Log.diagnostic("메뉴: 조합 잊기 (길이 \(item.word.count))")
        hideCandidates()
    }

    @objc private func setCommitStyle(_ sender: Any?) {
        Log.diagnostic("메뉴: 확정 형식 액션 도달")
        guard let item = menuItem(from: sender) else {
            Log.diagnostic("메뉴: 확정 형식 — sender에서 항목을 못 꺼냈다")
            return
        }
        let all = Settings.CommitStyle.allCases
        guard all.indices.contains(item.tag) else { return }
        Settings.shared.commitStyle = all[item.tag]
        Log.diagnostic("메뉴: 확정 형식 = \(Settings.shared.commitStyle.rawValue)")
    }

    @objc private func setBracketStyle(_ sender: Any?) {
        Log.diagnostic("메뉴: 병기 괄호 액션 도달")
        guard let item = menuItem(from: sender) else {
            Log.diagnostic("메뉴: 병기 괄호 — sender에서 항목을 못 꺼냈다")
            return
        }
        let all = Settings.BracketStyle.allCases
        guard all.indices.contains(item.tag) else { return }
        Settings.shared.bracketStyle = all[item.tag]
        Log.diagnostic("메뉴: 병기 괄호 = \(Settings.shared.bracketStyle.rawValue)")
    }

    /**
     확정에 실제로 쓰인 형식을 남긴다 — **바뀔 때만**.

     확정마다 남기면 로그가 다시 그 줄로 덮인다. 상태가 바뀐 지점만 있으면 "이 시점
     이후의 모든 확정은 이 형식"으로 읽히므로, 한 줄이 그 뒤 전 구간을 판정한다.

     메뉴 조작과 실제 확정 시점을 연결할 수 있도록 앱과 형식을 함께 기록한다.
     */
    private static var lastLoggedCommit: (style: Settings.CommitStyle, app: String)?

    private func logCommitStyleIfChanged() {
        let style = Settings.shared.commitStyle
        let app = clientBundleID ?? "(알수없음)"
        guard Self.lastLoggedCommit?.style != style || Self.lastLoggedCommit?.app != app else {
            return
        }
        Self.lastLoggedCommit = (style, app)
        Log.diagnostic("확정 형식=\(style.rawValue) 괄호=\(Settings.shared.bracketStyle.rawValue) 앱=\(app)")
    }

    /**
     조합 중인 글자의 화면 사각형 — 후보창을 여기 붙인다.

     호스트가 준 값을 그대로 쓴다. 터미널에서 창이 어긋나는 항목(원장 1번)이 열려 있지만
     **아직 보정하지 않는다** — 그쪽 재검토 조건이 실값 관찰을 먼저 요구한다. 여기서는
     재기만 하고, 무엇을 고칠지는 실사용 관찰이 남긴 집계를 보고 정한다 (`CaretStats`).
     */
    private func caretRect(client sender: Any!, record: Bool = true) -> NSRect {
        guard let client = sender as? IMKTextInput else { return .zero }
        var rect = NSRect.zero
        _ = client.attributes(forCharacterIndex: 0, lineHeightRectangle: &rect)
        if record { CaretStats.record(app: clientBundleID, rect: rect) }
        return rect
    }
}
