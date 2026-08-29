import Foundation

/**
 키 이벤트에서 한글 오토마타에 넣을 ASCII를 뽑는다.

 ## 왜 NSEvent가 준 글자를 그대로 쓰지 않는가

 `charactersIgnoringModifiers`가 Shift를 반영하는지는 **활성 입력 소스와 레이아웃에
 따라 달라진다.** 합성 이벤트로 재 보면 대문자가 나오지만 그 시험은 실제 활성
 레이아웃을 거치지 않으므로 근거가 되지 못한다. 실제로 지음을 켜고 치면 쌍자음
 (ㄲ·ㅆ·ㅃ·ㅉ·ㄸ)과 ㅒ·ㅖ가 나오지 않았다 — Shift가 어디선가 떨어진다.

 그래서 그 속성의 동작에 **의존하지 않는다**. 수식키 플래그를 직접 읽어 대소문자를
 정한다. 이미 대문자로 왔든 소문자로 왔든 결과가 같으므로 어느 쪽이어도 옳다.

 ## Caps Lock은 무시한다

 Caps Lock으로 쌍자음이 나오면 안 된다. 한글 입력에서 쌍자음은 Shift로만 낸다는 것이
 모든 한글 입력기의 관례이고, Caps Lock 켠 채로 타이핑하다 ㄲ이 쏟아지면 그건 결함이다.
 Shift가 눌리지 않았으면 **명시적으로 소문자로 내린다.**
 */
enum KeyTranslation {

    /**
     - Parameters:
       - characters: `NSEvent.charactersIgnoringModifiers`
       - shift: 이벤트의 Shift 플래그
     - Returns: 오토마타에 넣을 ASCII 코드. 한글 자판과 무관한 키면 `nil`
     */
    static func asciiForHangul(characters: String?, shift: Bool) -> Int32? {
        guard
            let characters,
            let scalar = characters.unicodeScalars.first,
            scalar.isASCII
        else { return nil }

        // 알파벳이 아닌 키(숫자·기호)는 Shift와 무관하게 그대로 넘긴다.
        // libhangul이 소비하지 않으면 호출부가 단어 경계로 처리한다.
        guard scalar.properties.isAlphabetic else { return Int32(scalar.value) }

        let character = Character(scalar)
        let normalized = shift ? character.uppercased() : character.lowercased()
        guard let result = normalized.unicodeScalars.first else { return Int32(scalar.value) }
        return Int32(result.value)
    }
}
