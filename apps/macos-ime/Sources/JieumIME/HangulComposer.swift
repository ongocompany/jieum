#if HAS_LIBHANGUL

import CHangul
import Foundation

/**
 libhangul 두벌식 조합기 (C0.4)

 조합은 **셸이 소유한다** (docs/07 D6). 엔진 서버가 죽어도 타이핑은 멈추면 안 되고,
 조합 상태가 소켓 너머에 있으면 그 약속을 지킬 수 없다. Mozc는 반대로 조합까지
 서버에 두어 키마다 IPC 왕복이 필수인데, 지음은 IPC가 팝업 신선도에만 영향을 준다.

 libhangul은 완성된 음절을 **commit 문자열로 흘려보내고** 조합 중인 것만 preedit에
 남긴다. 즉 "한글"을 치면 '한'이 commit으로 나오고 '글'이 preedit에 남는다 —
 단어 단위로 후보를 찾는 지음은 그 commit들을 따로 모아 둬야 한다
 ({@link JieumInputController}의 단어 버퍼).
 */
final class HangulComposer {

    private let context: OpaquePointer

    /// - Parameter keyboard: libhangul 키보드 식별자. "2"=두벌식, "3f"=세벌식 최종 등
    init?(keyboard: String = "2") {
        guard let context = hangul_ic_new(keyboard) else { return nil }
        self.context = context
    }

    deinit {
        hangul_ic_delete(context)
    }

    /// 조합 중인 것이 없는가
    var isEmpty: Bool {
        hangul_ic_is_empty(context)
    }

    /// 조합 중인 글자 (marked text로 보여줄 것)
    var preedit: String {
        Self.string(from: hangul_ic_get_preedit_string(context))
    }

    /**
     키 하나를 오토마타에 넣는다.

     - Returns: libhangul이 그 키를 소비했으면 `true`. `false`면 한글과 무관한
       키이므로 셸이 먹지 말고 호스트 앱에 넘겨야 한다.
     */
    func process(ascii: Int32) -> Bool {
        hangul_ic_process(context, ascii)
    }

    /// 직전 `process` 호출로 확정된 글자 (없으면 빈 문자열)
    var commit: String {
        Self.string(from: hangul_ic_get_commit_string(context))
    }

    /// 조합 중인 글자를 한 자모 지운다. 지울 것이 없으면 `false`
    func backspace() -> Bool {
        hangul_ic_backspace(context)
    }

    /// 조합을 끝내고 남아 있던 글자를 돌려준다 (포커스 이탈·앱 전환 시)
    func flush() -> String {
        Self.string(from: hangul_ic_flush(context))
    }

    /**
     libhangul의 UTF-32 문자열을 Swift String으로.

     `ucschar`는 `uint32_t`이고 널로 끝난다. 길이를 미리 알 수 없어 훑어야 한다.
     */
    private static func string(from pointer: UnsafePointer<ucschar>?) -> String {
        guard let pointer else { return "" }
        var scalars = String.UnicodeScalarView()
        var index = 0
        while pointer[index] != 0 {
            if let scalar = Unicode.Scalar(pointer[index]) {
                scalars.append(scalar)
            }
            index += 1
        }
        return String(scalars)
    }
}

#endif
