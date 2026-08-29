import Carbon
import Foundation

/**
 입력 소스 등록·활성화 (Text Input Sources API)

 ## 등록과 활성화는 다른 일이다
 `TISRegisterInputSource`는 "이런 입력기가 설치돼 있다"를 시스템에 알릴 뿐이다.
 그것만으로는 **시스템 설정의 입력 소스 목록에 나타나지 않는다** — 목록에 실리려면
 `TISEnableInputSource`로 켜야 한다. 시스템 설정에서 ＋로 추가하는 동작이 바로 이것이고,
 같은 일을 여기서 API로 한다. 재로그인이 필요하다는 통념은 이 구분을 몰라서 생긴다.

 활성화(enable)와 선택(select)도 다르다. 켜는 것은 목록에 올리는 것이고, 고르는 것은
 지금 타이핑에 쓰는 입력기를 바꾸는 것이다. 남의 기계에서 쓰는 입력기를 말없이 바꾸면
 안 되므로 별도 명령으로 나눠 둔다.
 */
enum InputSourceTool {

    static let bundleID = "com.ongocompany.inputmethod.Jieum"

    // MARK: - 속성 읽기

    private static func stringProperty(_ source: TISInputSource, _ key: CFString) -> String? {
        guard let pointer = TISGetInputSourceProperty(source, key) else { return nil }
        return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
    }

    private static func boolProperty(_ source: TISInputSource, _ key: CFString) -> Bool {
        guard let pointer = TISGetInputSourceProperty(source, key) else { return false }
        return CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(pointer).takeUnretainedValue())
    }

    /// 지음이 제공하는 입력 소스들 (번들 자체 + 입력 모드)
    private static func ourSources() -> [TISInputSource] {
        let filter = [kTISPropertyBundleID as String: bundleID] as CFDictionary
        let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue()
        return (list as? [TISInputSource]) ?? []
    }

    private struct Info {
        let source: TISInputSource
        let id: String
        let name: String
        let isEnabled: Bool
        let isEnableCapable: Bool
        let isSelectCapable: Bool
        /// 입력 모드인가 (번들 자체가 아니라 실제로 고를 수 있는 항목)
        let isInputMode: Bool
    }

    private static func describe(_ source: TISInputSource) -> Info {
        let category = stringProperty(source, kTISPropertyInputSourceCategory)
        return Info(
            source: source,
            id: stringProperty(source, kTISPropertyInputSourceID) ?? "(식별자 없음)",
            name: stringProperty(source, kTISPropertyLocalizedName) ?? "(이름 없음)",
            isEnabled: boolProperty(source, kTISPropertyInputSourceIsEnabled),
            isEnableCapable: boolProperty(source, kTISPropertyInputSourceIsEnableCapable),
            isSelectCapable: boolProperty(source, kTISPropertyInputSourceIsSelectCapable),
            isInputMode: (category as String?) == (kTISCategoryKeyboardInputSource as String)
                && stringProperty(source, kTISPropertyInputModeID) != nil
        )
    }

    // MARK: - 명령

    /// 설치 위치를 시스템에 알린다
    static func register(bundleURL: URL) -> Int32 {
        let status = TISRegisterInputSource(bundleURL as CFURL)
        if status == noErr {
            Log.info("입력 소스로 등록했다: \(bundleURL.path)")
            return 0
        }
        // paramErr(-50)은 대개 이미 등록돼 있다는 뜻이다 — 재설치 때 정상적으로 난다
        Log.error("등록 실패 (OSStatus \(status)) — 이미 등록돼 있으면 정상이다")
        return 0
    }

    /// 입력 소스 목록에 올린다 (시스템 설정에서 ＋로 추가하는 것과 같은 일)
    static func enable() -> Int32 {
        let sources = ourSources()
        guard !sources.isEmpty else {
            Log.error("지음 입력 소스를 찾지 못했다 — 먼저 --register를 돌려라")
            return 1
        }

        // ⚠️ `kTISPropertyInputSourceIsEnabled`를 켜기 여부의 관문으로 쓰면 안 된다.
        // 입력 모드는 Info.plist의 `tsInputModeDefaultStateKey`가 true이면 실제로
        // 사용자 목록(AppleEnabledInputSources)에 없는데도 "켜짐"으로 보고한다.
        // 그 보고를 믿고 건너뛰면 아무것도 켜지지 않은 채 성공한 것처럼 보인다.
        var enabledAny = false
        for info in sources.map(describe) {
            guard info.isEnableCapable else {
                print("켤 수 없는 항목(건너뜀): \(info.id)")
                continue
            }
            let status = TISEnableInputSource(info.source)
            if status == noErr {
                print("켰다: \(info.name) [\(info.id)]\(info.isInputMode ? " (입력 모드)" : "")")
                enabledAny = true
            } else {
                print("켜기 실패 (OSStatus \(status)): \(info.id)")
            }
        }

        if enabledAny {
            print("")
            print("메뉴 막대 입력 소스 메뉴(또는 ⌃Space)에서 \"지음\"을 고르면 된다.")
            print("메뉴가 갱신되지 않으면: killall TextInputMenuAgent")
        }
        return enabledAny ? 0 : 1
    }

    /// 지금 쓰는 입력기를 지음으로 바꾼다
    static func select() -> Int32 {
        for info in ourSources().map(describe) where info.isInputMode && info.isSelectCapable {
            let status = TISSelectInputSource(info.source)
            if status == noErr {
                print("지음으로 바꿨다: \(info.name) [\(info.id)]")
                return 0
            }
            print("전환 실패 (OSStatus \(status)): \(info.id)")
        }
        Log.error("고를 수 있는 지음 입력 모드가 없다 — --enable을 먼저 돌려라")
        return 1
    }

    /// 지금 쓰는 입력 소스 식별자를 한 줄로 낸다 (스크립트가 저장·복원에 쓴다)
    static func current() -> Int32 {
        guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
            let id = stringProperty(source, kTISPropertyInputSourceID)
        else { return 1 }
        print(id)
        return 0
    }

    /**
     식별자로 입력 소스를 고른다.

     디버그 설치가 원래 쓰던 입력기를 되돌리는 데 쓴다. 입력 소스를 켜면 시스템이
     그것을 활성으로 바꿔 버리는 일이 있는데, 개발자 도구가 사용자가 쓰던 입력기를
     말없이 갈아치우면 안 된다.
     */
    static func select(id: String) -> Int32 {
        let all = TISCreateInputSourceList(nil, false)?.takeRetainedValue() as? [TISInputSource] ?? []
        for source in all where stringProperty(source, kTISPropertyInputSourceID) == id {
            let status = TISSelectInputSource(source)
            if status == noErr { return 0 }
            print("전환 실패 (OSStatus \(status)): \(id)")
            return 1
        }
        print("활성 목록에 없다: \(id)")
        return 1
    }

    /// 목록에서 내린다 (빠져나오는 길)
    static func disable() -> Int32 {
        var changed = false
        for info in ourSources().map(describe) where info.isEnabled {
            let status = TISDisableInputSource(info.source)
            print(status == noErr ? "껐다: \(info.id)" : "끄기 실패 (\(status)): \(info.id)")
            changed = changed || status == noErr
        }
        if !changed { print("켜져 있는 지음 입력 소스가 없다") }
        return 0
    }

    /// 현재 상태를 그대로 보여 준다
    static func list() -> Int32 {
        let sources = ourSources()
        guard !sources.isEmpty else {
            print("시스템이 지음을 모른다 — --register를 먼저 돌려라")
            return 1
        }
        for info in sources.map(describe) {
            print(
                """
                \(info.name)
                  식별자   : \(info.id)
                  입력모드 : \(info.isInputMode ? "예" : "아니오 (번들 자체)")
                  켜짐     : \(info.isEnabled ? "예" : "아니오")
                  켤 수 있음: \(info.isEnableCapable ? "예" : "아니오")
                  고를 수 있음: \(info.isSelectCapable ? "예" : "아니오")
                """)
        }
        return 0
    }
}
