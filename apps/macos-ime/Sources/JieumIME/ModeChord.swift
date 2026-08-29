import Cocoa

/**
 왼쪽 ⌘+Shift를 눌렀다 떼면 한자 모드와 한글 전용 모드를 전환한다.

 ## 수식키 조합을 사용하는 이유

 숫자가 단어에 붙는 입력(`사당3동`)에서는 앞 한글이 후보로 잡힐 수 있다. 한자를 쓰지
 않을 때 후보를 빠르게 끄되, 문자 입력이나 기존 단축키와 충돌하지 않도록 수식키만 쓴다.

 ## 이 상태 기계가 지키는 것

 **다른 키가 끼면 뒤집지 않는다.** ⌘⇧4(화면 캡처)·⌘⇧Z처럼 ⌘+Shift는 수많은 단축키의
 앞자리다. 그것을 누를 때마다 모드가 뒤집히면 못 쓰는 입력기가 된다. 그래서 두 키가
 함께 눌린 뒤 **아무것도 끼지 않고** 떼졌을 때만 신호를 낸다.

 마우스 입력은 관찰하지 않으므로 ⌘⇧+클릭도 두 키만 눌렀다 뗀 것으로 처리된다.

 ## 왼쪽 ⌘만 받는다

 왼쪽 ⌘만 사용한다. 오른쪽 ⌘는 다른 단축키에 쓸 수 있게 비워 둔다. Shift는 양쪽 다 받는다 —
 왼쪽 ⌘를 누른 손과 반대쪽 Shift를 누르는 것이 오히려 자연스럽다.
 */
struct ModeChord {
    /**
     **프로세스 전역이다.**

     IMK는 텍스트 입력 지점마다 `JieumInputController`를 따로 만든다(`Settings`가 전역인
     것과 같은 이유). 손짓 상태를 인스턴스에 두면 두 가지가 깨진다 — 같은 손짓이 둘에게
     닿으면 **두 번 뒤집혀 제자리로 돌아오고**, ⌘를 누른 채 칸을 옮기면 누른 기억이 한쪽에
     남는다.
     */
    static var shared = ModeChord()

    /// macOS 가상 키코드 — 수식키는 눌린 것이 아니라 **바뀐 것**으로 온다
    private enum Key {
        static let leftCommand: UInt16 = 55
        static let rightCommand: UInt16 = 54
        static let leftShift: UInt16 = 56
        static let rightShift: UInt16 = 60
    }

    /// 두 키가 함께 눌린 적이 있다
    private var armed = false
    /// 그 사이에 다른 키(글자든 수식키든)가 끼었다 — 그러면 신호를 내지 않는다
    private var spoiled = false
    /// 지금 눌려 있는 것으로 보는 수식키들
    private var pressed: Set<UInt16> = []

    /**
     수식키 상태가 바뀌었다.

     - Parameter keyCode: 바뀐 수식키의 가상 키코드
     - Parameter flags: 바뀐 **뒤**의 수식키 상태 (`NSEvent.modifierFlags.rawValue`)
     - Returns: 모드를 뒤집어야 하면 `true`

     `flags`로 눌림/떼짐을 가른다. `flagsChanged`는 어느 키가 바뀌었는지만 알려 주고
     그것이 눌린 것인지 떼진 것인지는 말해 주지 않기 때문이다.
     */
    mutating func flagsChanged(keyCode: UInt16, flags: UInt) -> Bool {
        let modifiers = NSEvent.ModifierFlags(rawValue: flags)
        let isDown: Bool
        switch keyCode {
        case Key.leftCommand, Key.rightCommand: isDown = modifiers.contains(.command)
        case Key.leftShift, Key.rightShift: isDown = modifiers.contains(.shift)
        default:
            // ⌥·⌃·Caps 따위. 이것이 끼면 우리 손짓이 아니다.
            if armed { spoiled = true }
            return false
        }

        if isDown {
            pressed.insert(keyCode)
        } else {
            pressed.remove(keyCode)
        }

        // ⌥·⌃가 함께 눌려 있으면 우리 손짓이 아니다 (⌘⌥⇧ 조합의 앞자리일 수 있다)
        if modifiers.contains(.option) || modifiers.contains(.control) {
            if armed { spoiled = true }
        }

        let hasChord =
            pressed.contains(Key.leftCommand)
            && (pressed.contains(Key.leftShift) || pressed.contains(Key.rightShift))

        if hasChord {
            armed = true
            return false
        }

        guard armed else { return false }

        // 손짓이 풀렸다 — 아무것도 끼지 않았으면 지금이 신호다
        let fire = !spoiled
        armed = false
        spoiled = false
        return fire
    }

    /// 글자 키가 눌렸다. 손짓 중이었다면 그것은 단축키의 앞자리였다는 뜻이다.
    mutating func keyDown() {
        if armed { spoiled = true }
    }
}
