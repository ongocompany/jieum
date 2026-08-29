//! 조합(composition) — 아직 확정되지 않은 글자를 앱에 보여 주는 상태.
//!
//! macOS의 marked text와 같은 개념이다. 다른 점은 TSF에서는 조합이 **문서 안의 범위**
//! (`ITfRange`)로 표현된다는 것 — 앱의 실제 텍스트에 자리를 잡고 있고, 밑줄 같은 표시
//! 속성이 그 범위에 붙는다. IMK처럼 "입력기가 들고 있다가 확정할 때 넘기는" 것이 아니다.
//!
//! 그래서 조합 중에 앱이 스크롤하거나 다른 편집이 일어나도 위치가 따라간다.

use std::mem::ManuallyDrop;
use std::sync::atomic::{AtomicBool, Ordering};

use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::TextServices::{
    ITfCategoryMgr, ITfComposition, ITfContext, ITfContextComposition, ITfInsertAtSelection,
    CLSID_TF_CategoryMgr, GUID_PROP_ATTRIBUTE, TF_AE_NONE, TF_ANCHOR_END, TF_IAS_QUERYONLY,
    TF_SELECTION, TF_SELECTIONSTYLE, TF_ST_CORRECTION,
};
use windows_core::{Interface, Result};

use crate::guids::GUID_JIEUM_DISPLAY_ATTR_INPUT;

/// 조합 범위가 어떻게 움직이는지 **프로세스마다 한 줄만** 남긴다. 글자마다 남기면
/// 그 줄 수가 곧 사용자가 친 양이 된다.
fn note_once(msg: &str) {
    static DONE: AtomicBool = AtomicBool::new(false);
    if !DONE.swap(true, Ordering::Relaxed) {
        crate::logging::line(msg);
    }
}

/// 커서 자리에 조합을 시작한다. `replace_len`만큼 **커서 앞을 덮는다.**
///
/// ## 왜 앞을 덮어야 하는가 — 임시 문서 (2026-08-07, 아래한글)
///
/// 보통은 커서 자리에 빈 범위를 잡고 시작하면 된다(`replace_len = 0`). 그런데
/// **임시 문서**(`TS_SS_TRANSITORY`)라고 신고하는 앱은 편집 세션이 끝날 때마다
/// 조합을 정리한다. 규격대로다 — 검색창처럼 문서를 오래 들고 있지 않은 자리를 위한
/// 표시이고, 아래한글의 편집 화면이 그렇게 신고한다.
///
/// 조합이 끊겨도 **넣은 글자는 문서에 남는다.** 그래서 다음 키에서 빈 범위로 새로
/// 시작하면 갈아 끼우려던 것이 덧붙기가 되어 `ㅎ 하 한`이 줄줄이 남는다. 남아 있는
/// 그만큼을 `replace_len`으로 받아 덮으면, 조합이 매번 끊겨도 화면에는 한 글자가
/// 모양만 바뀌며 보인다.
///
/// ⚠️ `replace_len`은 **우리가 넣은 글자 수**여야 한다. 문서에서 세면 안 된다 —
/// 그 앞이 사용자가 이미 써 놓은 글인지 우리 글자인지 문서 쪽에서는 구별할 수 없고,
/// 잘못 덮으면 남의 글을 지운다.
pub fn start(
    context: &ITfContext,
    edit_cookie: u32,
    sink: &windows::Win32::UI::TextServices::ITfCompositionSink,
    replace_len: usize,
) -> Result<ITfComposition> {
    // QUERYONLY는 "넣지 말고 넣을 자리만 알려 달라"는 뜻이다. 실제 삽입은
    // 조합 범위에 SetText로 한다.
    let insert_at: ITfInsertAtSelection = match context.cast() {
        Ok(v) => v,
        Err(e) => {
            crate::log_verbose!("ITfInsertAtSelection cast 실패: 0x{:08X}", e.code().0);
            return Err(e);
        }
    };
    let range = match unsafe { insert_at.InsertTextAtSelection(edit_cookie, TF_IAS_QUERYONLY, &[]) }
    {
        Ok(r) => r,
        Err(e) => {
            crate::log_verbose!("InsertTextAtSelection 실패: 0x{:08X}", e.code().0);
            return Err(e);
        }
    };

    if replace_len > 0 {
        let mut shifted = 0i32;
        // 못 물리면 그냥 진행한다. 덜 덮은 채로 갈아 끼우면 글자가 겹치지만,
        // 여기서 멈추면 입력 자체가 안 된다.
        //
        // **요청한 만큼 움직였는지 한 번 남긴다.** `ShiftStart`는 실패하지 않고도
        // 0만큼만 움직일 수 있고(문단 처음 등), 그러면 갈아 끼우기가 조용히
        // 덧붙기가 된다 — 오류 코드만 봐서는 안 보이는 고장이다.
        match unsafe {
            range.ShiftStart(edit_cookie, -(replace_len as i32), &mut shifted, std::ptr::null())
        } {
            Ok(()) => note_once(&format!("조합 범위 물림: 요청 {replace_len} → 실제 {shifted}")),
            Err(e) => note_once(&format!("조합 범위 물림 실패: 0x{:08X}", e.code().0)),
        }
    }

    let ctx_composition: ITfContextComposition = match context.cast() {
        Ok(v) => v,
        Err(e) => {
            crate::log_verbose!("ITfContextComposition cast 실패: 0x{:08X}", e.code().0);
            return Err(e);
        }
    };
    match unsafe { ctx_composition.StartComposition(edit_cookie, &range, sink) } {
        Ok(c) => Ok(c),
        Err(e) => {
            crate::log_verbose!("StartComposition 실패: 0x{:08X}", e.code().0);
            Err(e)
        }
    }
}

/// 조합 중인 글자를 통째로 바꾼다.
///
/// 조합기는 매 키마다 "지금까지의 결과" 전체를 돌려주므로, 증분으로 덧붙이지 않고
/// 매번 갈아 끼운다. 한글은 한 글자가 자모 조합으로 모양이 바뀌기 때문에
/// (ㄱ → 가 → 각) 덧붙이기로는 표현할 수 없다.
///
/// ## 아래한글 조합 끊김 — 여기서 기각한 것 둘 (2026-08-07)
///
/// 아래한글은 이 함수가 돌 때마다 조합을 끊는다. 이 안에서 의심할 만한 두 가지를
/// 각각 빼고 실측했고 **둘 다 원인이 아니었다.** 같은 것을 다시 시도하지 말 것:
///
/// - **끝의 `SetSelection`을 뺀다** — 커서를 조합 밖으로 옮기는 것이 조합을 끝내는
///   신호일까 싶었으나, 빼도 끊기는 횟수가 그대로였다
/// - **`TF_ST_CORRECTION` 대신 플래그 없이 넣는다** — 한컴이 "고침"을 확정으로
///   읽는가 싶었으나, 역시 그대로였다
///
/// 표시 속성을 붙이는 것(아래 `mark_composing`)도 해 봤으나 **그것도 아니었다.**
///
/// ## ⭐ 결함은 이 파일 안에 있다 (2026-08-07 실측으로 좁혀짐)
///
/// **엔진과 후보 창을 둘 다 끈 채로 쳐도 `ㅎ하한핝한자`가 그대로 나온다**
/// `[근거: 엔진·후보 창 프로세스 종료 후 verify-in-app.ps1 -App hwp → 'ㅎ하한핝한자1']`
///
/// 그러면 남는 것은 키 → 편집 세션 → `start`/`set_text`뿐이다. 밖에서 온 것(엔진 조회,
/// 후보 창 그리기)은 전부 배제됐다 — 그 둘을 **함께** 끄고 관찰해 "후보 창이 원인"이라고
/// 단정했던 앞선 판정이 여기서 뒤집혔다. **하나씩 빼야 갈린다.**
///
/// 직접 증거는 로그의 `조합 범위 물림: 요청 1 → 실제 0`이다. 위 `start`가 앞 글자를
/// 덮으려고 `ShiftStart(-1)`을 부르는데 임시 문서에서는 0만큼 움직인다 — 아래한글이
/// 확정된 글자를 자기 본문으로 가져가고 TSF 문서에는 남기지 않기 때문으로 보인다.
/// 그래서 갈아 끼우기가 덧붙기가 된다.
///
/// **아직 안 해 본 것**: 조합 범위를 `InsertTextAtSelection`(위 `start`)이 아니라
/// `GetSelection`으로 얻는 것. 전자는 앱에게 "넣을 자리를 달라"고 묻는 것이라 한컴이
/// 그 처리 중에 조합을 정리할 여지가 있다. Microsoft SampleIME은 후자를 쓴다.
pub fn set_text(
    context: &ITfContext,
    composition: &ITfComposition,
    edit_cookie: u32,
    text: &str,
) -> Result<()> {
    let range = unsafe { composition.GetRange()? };
    let wide: Vec<u16> = text.encode_utf16().collect();
    unsafe { range.SetText(edit_cookie, TF_ST_CORRECTION, &wide)? };

    // **글자를 넣은 뒤에** 속성을 건다. 먼저 걸면 아직 빈 범위에 거는 것이라 아무 데도
    // 안 붙는다. 실패해도 진행한다 — 그때 잃는 것은 밑줄이고, 입력 자체는 돌아야 한다.
    if let Err(e) = mark_composing(context, &range, edit_cookie) {
        crate::log_verbose!("조합 표시 속성 실패: 0x{:08X}", e.code().0);
    }

    // 커서를 조합 끝으로 옮긴다. 이걸 빼먹으면 다음 글자가 조합 앞에 들어간다.
    let end = unsafe { range.Clone()? };
    unsafe { end.Collapse(edit_cookie, TF_ANCHOR_END)? };

    let selection = TF_SELECTION {
        range: ManuallyDrop::new(Some(end)),
        style: TF_SELECTIONSTYLE {
            ase: TF_AE_NONE,
            fInterimChar: false.into(),
        },
    };
    unsafe { context.SetSelection(edit_cookie, &[selection])? };
    Ok(())
}

/// 이 범위가 **조합 중**임을 표시한다.
///
/// TSF에서 표시 속성은 GUID가 아니라 **원자 번호**(`TfGuidAtom`)로 오간다. 범위마다
/// 16바이트 GUID를 실어 나르면 비싸서, 시스템이 GUID 하나에 번호를 하나 붙여 두고
/// 그 번호를 쓴다. 그래서 걸기 전에 번호를 받아 와야 한다.
///
/// 번호는 프로세스 안에서 변하지 않으므로 한 번만 받아 둔다 — 글자마다 COM 객체를
/// 만들면 타이핑 경로에 쓸데없는 비용이 붙는다.
fn mark_composing(
    context: &ITfContext,
    range: &windows::Win32::UI::TextServices::ITfRange,
    edit_cookie: u32,
) -> Result<()> {
    let atom = attribute_atom()?;
    let property = unsafe { context.GetProperty(&GUID_PROP_ATTRIBUTE)? };
    let value = VARIANT::from(atom as i32);
    unsafe { property.SetValue(edit_cookie, range, &value) }
}

/// 조합 표시 속성의 원자 번호. 프로세스마다 한 번만 받는다.
fn attribute_atom() -> Result<u32> {
    thread_local! {
        static ATOM: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    }
    let cached = ATOM.with(|a| a.get());
    if cached != 0 {
        return Ok(cached);
    }
    let categories: ITfCategoryMgr =
        unsafe { CoCreateInstance(&CLSID_TF_CategoryMgr, None, CLSCTX_INPROC_SERVER)? };
    let atom = unsafe { categories.RegisterGUID(&GUID_JIEUM_DISPLAY_ATTR_INPUT)? };
    ATOM.with(|a| a.set(atom));
    Ok(atom)
}

/// 조합을 확정한다. 범위에 남아 있는 글자가 그대로 본문이 된다.
pub fn commit(composition: &ITfComposition, edit_cookie: u32) -> Result<()> {
    unsafe { composition.EndComposition(edit_cookie) }
}

/// 조합을 버린다. 범위를 비우고 끝낸다.
pub fn cancel(composition: &ITfComposition, edit_cookie: u32) -> Result<()> {
    let range = unsafe { composition.GetRange()? };
    unsafe { range.SetText(edit_cookie, TF_ST_CORRECTION, &[])? };
    unsafe { composition.EndComposition(edit_cookie) }
}
