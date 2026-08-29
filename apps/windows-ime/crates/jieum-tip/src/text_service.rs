//! 입력기 본체 — `ITfTextInputProcessorEx` + `ITfKeyEventSink` 구현.
//!
//! TSF는 사용자가 지음을 입력 소스로 고른 **스레드마다** 이 객체를 하나씩 만들고
//! `ActivateEx`를 부른다. 그때 받는 `ITfThreadMgr`가 그 스레드의 문서·문맥으로 가는
//! 유일한 통로이고, `tid`(client id)는 이후 모든 편집 요청에 붙여야 하는 신분증이다.
//!
//! 스레드 친화(apartment) 모델이라 한 객체는 한 스레드에서만 만져진다. 그래서
//! 내부 상태는 `RefCell`로 충분하고 잠금이 필요 없다.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jieum_candidates::ui_command::CaretRect;
use jieum_candidates::CandidateItem;
use windows::Win32::Foundation::{E_FAIL, E_INVALIDARG, LPARAM, RECT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_ESCAPE, VK_HANJA, VK_LEFT, VK_MENU,
    VK_NUMPAD0, VK_NUMPAD9,
    VK_RETURN, VK_RIGHT, VK_SHIFT, VK_SPACE, VK_UP,
};
use windows::Win32::System::Variant::VT_UNKNOWN;
use windows::Win32::UI::TextServices::{
    IEnumTfDisplayAttributeInfo, ITfComposition, ITfCompartmentMgr, ITfContext,
    ITfDisplayAttributeInfo, ITfDisplayAttributeProvider, ITfDisplayAttributeProvider_Impl,
    ITfDocumentMgr, ITfKeyEventSink, ITfKeyEventSink_Impl, ITfKeystrokeMgr,
    ITfTextInputProcessorEx, ITfTextInputProcessorEx_Impl, ITfTextInputProcessor_Impl,
    ITfContextView, ITfSource, ITfThreadMgr, GUID_COMPARTMENT_TRANSITORYEXTENSION_PARENT,
    TF_ANCHOR_START,
    TF_CONTEXT_EDIT_CONTEXT_FLAGS,
    TF_ES_READWRITE, TF_ES_SYNC, TS_SD_LOADING, TS_SD_READONLY, TS_SS_DISJOINTSEL,
    TS_SS_NOHIDDENTEXT, TS_SS_REGIONS, TS_SS_TRANSITORY,
};
use windows_core::{implement, BOOL, GUID, IUnknownImpl, Interface, Ref, Result};

use crate::caret_stats::{CaretOutcome, CaretStats};
use crate::edit_session::session;
use crate::engine::Engine;
use crate::{composition, hangul, log_line, log_verbose};

#[implement(ITfTextInputProcessorEx, ITfKeyEventSink, ITfDisplayAttributeProvider)]
pub struct TextService {
    state: RefCell<Option<Activation>>,
    /// 진행 중인 조합. 없으면 지금 조합 중이 아니다.
    ///
    /// `Rc`인 이유: 조합은 편집 세션 **안에서** 만들어지는데, 편집 세션은 클로저라
    /// `'static`이어야 해서 `&self`를 빌려 갈 수 없다. 소유권을 나눠 갖게 해야
    /// 세션 안에서 만든 조합을 밖으로 남길 수 있다.
    composing: Rc<RefCell<Option<ITfComposition>>>,
    /// 이번 조합에서 **이미 완성된** 음절들. libhangul이 음절을 끝낼 때마다 여기 쌓인다.
    /// 화면에 보이는 조합 문자열은 이것 + 조합기가 물고 있는 현재 음절이다.
    preedit: Rc<RefCell<String>>,
    /// 두벌식 조합기. macOS 셸과 같은 libhangul을 쓴다.
    composer: RefCell<Option<hangul::Composer>>,
    /// 캐럿 좌표를 얻었는가 / 못 얻었으면 어느 단계에서 막혔는가. 앱마다 DLL이 따로
    /// 적재되므로 이 하나가 곧 이 앱의 집계다.
    caret_stats: RefCell<CaretStats>,
    /// 키 싱크가 **처음** 불린 것을 표시했는가 (`SINK_*` 비트).
    ///
    /// 키 진단은 전부 상세 모드 전용이라(치는 내용이 그대로 남으므로) 평소에는
    /// "활성화됐다"까지만 보인다. 그런데 활성화와 "키가 실제로 온다"는 다른 사건이고,
    /// 앱이 자체 입력 처리로 키를 먼저 가로채면 정확히 그 사이에서 갈린다. 그래서
    /// **처음 한 번만** 사건의 종류를 남긴다 — 키 값은 남기지 않는다.
    sink_seen: Cell<u8>,
    /// 앱이 조합을 끊은 횟수. 종료 수신자는 조합마다 새로 만들어지므로 여기서 센다.
    composition_terminations: Rc<Cell<u32>>,
    /// 이 문맥이 임시 문서인가 (`TS_SS_TRANSITORY`). 첫 키에서 한 번 읽어 둔다.
    transitory: Rc<Cell<bool>>,
    /// **문서에 이미 그려 놓은** 조합 글자의 UTF-16 길이.
    ///
    /// 임시 문서에서는 조합이 매 키마다 끊기지만 글자는 문서에 남는다. 다음 키에서
    /// 그것을 덮어야 갈아 끼우기가 되므로, 조합이 끊겨도 이 값은 **지우지 않는다**.
    /// 확정하거나 취소할 때만 0이 된다.
    composed_len: Cell<usize>,
}

const SINK_FOCUS: u8 = 1 << 0;
const SINK_TEST_KEY: u8 = 1 << 1;
const SINK_KEY: u8 = 1 << 2;
const SINK_STATUS: u8 = 1 << 3;

/// 활성화되어 있는 동안만 존재하는 상태.
struct Activation {
    thread_mgr: ITfThreadMgr,
    client_id: u32,
    /// 엔진으로 가는 통로. 만들지 못해도 활성화는 살려 둔다 — 한글 입력은 엔진 없이도
    /// 돌아야 하고, 엔진이 없을 때 잃는 것은 한자 제안뿐이다 (D6).
    engine: Option<Engine>,
}

impl TextService {
    pub fn new() -> Self {
        crate::lock_server(true);
        Self {
            state: RefCell::new(None),
            composing: Rc::new(RefCell::new(None)),
            preedit: Rc::new(RefCell::new(String::new())),
            composer: RefCell::new(None),
            caret_stats: RefCell::new(CaretStats::default()),
            sink_seen: Cell::new(0),
            composition_terminations: Rc::new(Cell::new(0)),
            transitory: Rc::new(Cell::new(false)),
            composed_len: Cell::new(0),
        }
    }
}

impl Drop for TextService {
    fn drop(&mut self) {
        crate::lock_server(false);
    }
}

// ---------------------------------------------------------------- 활성화

impl ITfTextInputProcessor_Impl for TextService_Impl {
    fn Activate(&self, thread_mgr: Ref<'_, ITfThreadMgr>, client_id: u32) -> Result<()> {
        // 구형 진입점. TSF가 Ex를 못 찾을 때만 온다 — 같은 경로로 합류시킨다.
        self.ActivateEx(thread_mgr, client_id, 0)
    }

    fn Deactivate(&self) -> Result<()> {
        // 내려가기 전에 합계를 낸다. 100회 간격만으로는 짧게 쓰고 끈 앱의 기록이
        // 통째로 사라진다 — 조사하려던 순간이 대개 그 짧은 쪽에 있다.
        {
            let stats = self.caret_stats.borrow();
            if !stats.is_empty() {
                log_line!("캐럿 집계 (마감): {}", stats.summary());
            }
        }
        log_line!("Deactivate");

        if let Some(activation) = self.state.borrow().as_ref() {
            if let Ok(keystroke) = activation.thread_mgr.cast::<ITfKeystrokeMgr>() {
                let _ = unsafe { keystroke.UnadviseKeyEventSink(activation.client_id) };
            }
        }

        // 조합이 남은 채로 내려가면 앱에 확정되지 않은 글자가 그대로 박힌다.
        *self.composing.borrow_mut() = None;
        self.composed_len.set(0);
        self.preedit.borrow_mut().clear();
        *self.composer.borrow_mut() = None;
        *self.state.borrow_mut() = None;
        Ok(())
    }
}

impl ITfTextInputProcessorEx_Impl for TextService_Impl {
    fn ActivateEx(
        &self,
        thread_mgr: Ref<'_, ITfThreadMgr>,
        client_id: u32,
        flags: u32,
    ) -> Result<()> {
        let Some(thread_mgr) = thread_mgr.cloned() else {
            log_line!("ActivateEx: thread_mgr 없음");
            return Err(E_INVALIDARG.into());
        };

        // 호스트 앱 이름을 같이 남긴다. 로그 줄머리에는 pid밖에 없어서, 나중에 로그만
        // 보고서는 어느 앱의 줄인지 가릴 수 없다 — 앱별로 갈리는 고장(아래한글)을 쫓을 때
        // 그 구분이 곧 조사 그 자체다.
        let host = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "알수없음".into());
        log_line!("ActivateEx: 호스트={host} client_id={client_id} flags=0x{flags:x}");

        // 키를 받으려면 키 이벤트 싱크를 등록해야 한다. 이걸 안 하면 입력기는
        // 활성 상태인데 키가 앱으로 그냥 지나간다 — 목록엔 보이는데 안 먹는 상태.
        let keystroke: ITfKeystrokeMgr = match thread_mgr.cast() {
            Ok(k) => k,
            Err(e) => {
                log_line!("ITfKeystrokeMgr cast 실패: 0x{:08X}", e.code().0);
                return Err(e);
            }
        };
        let sink: ITfKeyEventSink = self.to_interface();
        match unsafe { keystroke.AdviseKeyEventSink(client_id, &sink, true) } {
            Ok(()) => log_line!("키 이벤트 싱크 등록 완료"),
            Err(e) => {
                // 여기서 실패해도 활성화 자체는 살려 둔다. 실패를 그대로 돌려주면
                // TSF가 입력기를 통째로 내려 버려 원인을 볼 기회조차 없어진다.
                log_line!("AdviseKeyEventSink 실패: 0x{:08X} — {}", e.code().0, e.message());
            }
        }

        // 두벌식("2"). 자판 선택은 나중에 설정으로 뺀다 — macOS 쪽도 두벌식 고정이다.
        match hangul::Composer::new("2") {
            Some(c) => *self.composer.borrow_mut() = Some(c),
            None => log_line!("libhangul 조합기 생성 실패 — 한글 조합 없이 동작한다"),
        }

        // 엔진 통로. 실패해도 진행한다 — 파이프가 없는 것은 흔한 상태이고(엔진이 아직
        // 안 떴을 수 있다), 그때 잃는 것은 제안뿐이다.
        let engine = Engine::start(host.clone());
        if engine.is_none() {
            log_line!("엔진 통로 생성 실패 — 한글 입력은 그대로 동작한다");
        }

        *self.state.borrow_mut() = Some(Activation {
            thread_mgr,
            client_id,
            engine,
        });

        Ok(())
    }
}

// ---------------------------------------------------------------- 키 입력

/// Ctrl이나 Alt가 눌려 있는가.
///
/// 눌려 있으면 그 키는 단축키이지 글자가 아니다. 이걸 안 보면 Ctrl+A가 'a'로
/// 먹혀 화면에 `ㅁ`이 찍힌다 — 실제로 메모장 검증에서 `한 ㅁㅊ`가 나왔다.
/// 시험 장치는 조합키를 보내지 않으므로 이 결함을 잡지 못했다.
fn modifier_down() -> bool {
    // GetKeyState의 최상위 비트가 "지금 눌려 있음"이다. 하위 비트는 토글 상태라
    // (CapsLock 같은 것) 그걸 보면 엉뚱한 판정이 된다.
    let pressed = |vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY| {
        unsafe { GetKeyState(vk.0 as i32) as u16 & 0x8000 != 0 }
    };
    pressed(VK_CONTROL) || pressed(VK_MENU)
}

/// Shift가 눌려 있는가.
///
/// **후보를 숫자키로 고를 때 이것을 봐야 한다.** Shift+9는 `(`이지 9가 아니다. 안 보면
/// 괄호를 칠 때마다 9번 후보가 확정된다 — macOS에서 '한글' 뒤에 괄호를 치자 `寒글`이
/// 된 것이 이것이다(2026-08-01). 같은 함정이 플랫폼을 가리지 않는다.
fn shift_down() -> bool {
    unsafe { GetKeyState(VK_SHIFT.0 as i32) as u16 & 0x8000 != 0 }
}

fn ctrl_down() -> bool {
    unsafe { GetKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000 != 0 }
}

/// 후보 목록이 떠 있을 때의 키 상태.
/// 앞 문맥으로 읽어 올 글자 수. core의 문맥 창·macOS 셸과 같은 크기다.
const CONTEXT_WINDOW: usize = 200;

#[derive(Clone, Copy)]
struct KeyContext {
    composing: bool,
    has_candidates: bool,
    /// 사용자가 후보를 짚었는가 (방향키로 골랐는가)
    active: bool,
}

/// 이 키를 입력기가 먹을지 판단한다.
///
/// **먹는다고 답한 키는 반드시 처리해야 한다.** `OnTestKeyDown`에서 참을 돌려놓고
/// `OnKeyDown`에서 아무것도 안 하면 그 키는 사라진다 — 사용자에게는 "가끔 글자가
/// 씹힌다"로 보이고, 원인을 찾기 가장 어려운 부류의 결함이 된다.
fn wants_key(vk: u16, ctx: KeyContext) -> bool {
    // ⚠️ **Ctrl+Delete만 예외다.** 잘못 배운 조합을 잊는 손짓이라 후보가 떠 있을 때만
    // 우리 것이 된다. Mozc가 네 키맵 모두에서 같은 자리를 쓴다
    // (`DELETE_CANDIDATE_FROM_HISTORY`).
    if vk == VK_DELETE.0 && ctrl_down() && !shift_down() {
        return ctx.has_candidates;
    }
    if modifier_down() {
        return false;
    }
    match vk {
        // 한자 키는 언제나 우리 것이다 — 모드 전환은 조합 중이든 아니든 된다
        k if k == VK_HANJA.0 => true,
        // 조합 중일 때만 의미가 있는 키들
        k if k == VK_BACK.0 || k == VK_ESCAPE.0 || k == VK_RETURN.0 => ctx.composing,
        k if k == VK_SPACE.0 => ctx.composing,
        // 후보 짚기. 후보가 없으면 커서 이동이므로 건드리지 않는다
        k if k == VK_UP.0 || k == VK_DOWN.0 => ctx.has_candidates,
        // 쪽 넘김은 **후보를 짚은 뒤에만**이다. 그전의 좌우는 커서 이동이다
        k if k == VK_LEFT.0 || k == VK_RIGHT.0 => ctx.has_candidates && ctx.active,
        // 숫자키 선택. Shift가 눌렸으면 특수문자이므로 넘긴다
        k if (0x30..=0x39).contains(&k) => ctx.has_candidates && !shift_down(),
        // 넘패드 숫자는 Shift와 무관하게 숫자다
        k if (VK_NUMPAD0.0..=VK_NUMPAD9.0).contains(&k) => ctx.has_candidates,
        // 영문자 자리 (두벌식 자판이 놓인 자리)
        k if (0x41..=0x5A).contains(&k) => true,
        _ => false,
    }
}

/// 숫자키를 눌린 자리의 숫자로 바꾼다. 숫자키가 아니면 `None`.
fn digit_of(vk: u16) -> Option<usize> {
    if (0x30..=0x39).contains(&vk) {
        return Some((vk - 0x30) as usize);
    }
    if (VK_NUMPAD0.0..=VK_NUMPAD9.0).contains(&vk) {
        return Some((vk - VK_NUMPAD0.0) as usize);
    }
    None
}

impl TextService_Impl {
    fn activation_client_id(&self) -> Option<u32> {
        self.state.borrow().as_ref().map(|a| a.client_id)
    }

    /// 지금 글자를 치고 있는 중인가.
    ///
    /// ⚠️ **조합 객체가 살아 있는지로만 판단하면 안 된다.** 임시 문서
    /// (`TS_SS_TRANSITORY`, 아래한글)에서는 키마다 조합이 끊겨서 그 값이 늘 거짓이 되고,
    /// 그러면 공백·`Esc`·backspace가 전부 "조합 중이 아니다"로 흘러가 버린다.
    /// **문서에 그려 둔 글자가 있으면 아직 치는 중이다.**
    fn is_composing(&self) -> bool {
        self.composing.borrow().is_some() || self.composed_len.get() > 0
    }

    /// 키를 먹을지 판단하는 데 필요한 지금 상태.
    fn key_context(&self) -> KeyContext {
        let state = self.state.borrow();
        let engine = state.as_ref().and_then(|a| a.engine.as_ref());
        KeyContext {
            composing: self.is_composing(),
            has_candidates: engine.is_some_and(|e| e.has_candidates()),
            active: engine.is_some_and(|e| e.is_active()),
        }
    }

    /// 편집 세션을 신청해 문서를 고친다.
    ///
    /// `TF_ES_SYNC`는 "지금 당장"이라는 뜻인데, 키 처리 중에만 허락된다. 비동기로
    /// 돌리면 키 순서와 화면 갱신 순서가 어긋난다.
    fn edit<F>(&self, context: &ITfContext, work: F) -> Result<()>
    where
        F: FnOnce(u32) -> Result<()> + 'static,
    {
        self.session(context, TF_ES_SYNC | TF_ES_READWRITE, work)
    }

    fn session<F>(
        &self,
        context: &ITfContext,
        flags: TF_CONTEXT_EDIT_CONTEXT_FLAGS,
        work: F,
    ) -> Result<()>
    where
        F: FnOnce(u32) -> Result<()> + 'static,
    {
        let Some(client_id) = self.activation_client_id() else {
            log_verbose!("edit: 활성화 상태 없음");
            return Err(E_INVALIDARG.into());
        };
        let es = session(work);
        let hr = match unsafe { context.RequestEditSession(client_id, &es, flags) } {
            Ok(hr) => hr,
            Err(e) => {
                log_verbose!("RequestEditSession 실패: 0x{:08X}", e.code().0);
                return Err(e);
            }
        };
        if hr.is_err() {
            log_verbose!("편집 세션 결과 실패: 0x{:08X}", hr.0);
        }
        hr.ok()
    }

    /// 키 싱크 사건을 **처음 한 번만** 남긴다. 두 번째부터는 조용하다 — 키마다 한 줄씩
    /// 쌓이면 로그가 못 쓰게 되고, 그 내용이 곧 사용자가 친 글이다.
    fn note_sink(&self, bit: u8, what: &str) {
        let seen = self.sink_seen.get();
        if seen & bit == 0 {
            self.sink_seen.set(seen | bit);
            log_line!("키 싱크: {what} — 처음");
        }
    }

    /// 조합 종료 알림 수신자.
    ///
    /// 조합보다 오래 살아야 한다 — 앱이 조합을 끊을 때 우리 상태를 정리하는 것이
    /// 이 객체의 일이다.
    fn composition_sink(&self) -> windows::Win32::UI::TextServices::ITfCompositionSink {
        crate::composition_sink::sink(
            Rc::clone(&self.composing),
            Rc::clone(&self.preedit),
            Rc::clone(&self.transitory),
            Rc::clone(&self.composition_terminations),
        )
    }

    /// 이 문맥이 **어떤 종류인지** 한 번 남긴다.
    ///
    /// 앱이 신고하는 성격에 따라 입력기가 할 수 있는 일이 달라진다. 특히
    /// `TS_SS_TRANSITORY`("임시 문서")면 호스트가 편집마다 조합을 정리해도 규격
    /// 위반이 아니다 — 검색창처럼 문서를 안 들고 있는 자리를 위한 표시다. 그런
    /// 자리에서는 조합을 붙들지 말고 바로 확정해야 한다.
    ///
    /// 아래한글이 조합을 매 키마다 끊는 이유를 "우리가 뭘 빠뜨렸나"로만 쫓다가 다섯
    /// 번 헛짚었다. 앱이 스스로 신고하는 값을 먼저 읽었어야 했다.
    fn note_context_status(&self, context: &ITfContext) {
        if self.sink_seen.get() & SINK_STATUS != 0 {
            return;
        }
        self.sink_seen.set(self.sink_seen.get() | SINK_STATUS);
        match unsafe { context.GetStatus() } {
            Ok(status) => {
                let mut kinds: Vec<&str> = Vec::new();
                if status.dwStaticFlags & TS_SS_TRANSITORY != 0 {
                    kinds.push("임시문서(TRANSITORY)");
                    self.transitory.set(true);
                }
                if status.dwStaticFlags & TS_SS_DISJOINTSEL != 0 {
                    kinds.push("떨어진선택");
                }
                if status.dwStaticFlags & TS_SS_REGIONS != 0 {
                    kinds.push("구역");
                }
                if status.dwStaticFlags & TS_SS_NOHIDDENTEXT != 0 {
                    kinds.push("숨은글자없음");
                }
                if status.dwDynamicFlags & TS_SD_READONLY != 0 {
                    kinds.push("읽기전용");
                }
                if status.dwDynamicFlags & TS_SD_LOADING != 0 {
                    kinds.push("적재중");
                }
                let names = if kinds.is_empty() {
                    "없음".to_string()
                } else {
                    kinds.join("·")
                };
                log_line!(
                    "문맥: 고정=0x{:x} 동적=0x{:x} [{names}]",
                    status.dwStaticFlags,
                    status.dwDynamicFlags
                );
                if self.transitory.get() {
                    Self::note_transitory_parent(context);
                }
            }
            Err(e) => log_line!("문맥 상태를 못 읽음: 0x{:08X}", e.code().0),
        }
    }

    /// 임시 문서에 **딸린 온전한 문서**가 있는지 한 번 남긴다.
    ///
    /// ## 왜 이걸 보는가 (2026-08-07)
    ///
    /// TSF를 모르는 앱에는 문서가 **둘** 있다 — 윈도우가 중개하는 임시 문서와, TSF가
    /// 요청받으면 만들어 주는 온전한 문서(마이크로소프트 문서의 "virtual document").
    /// 규격이 용도를 갈라 둔다: **한 번에 끝나는 삽입과 고침은 온전한 문서로**, 키보드
    /// 조합은 임시 문서로.
    ///
    /// 우리가 아래한글에서 앞 글자를 못 덮은 것이 이 갈래를 몰랐기 때문이다. 임시 문서는
    /// 조합이 끝나는 순간 앞서 넣은 것에 대한 기억을 버리므로(규격), `ShiftStart(-1)`이
    /// 실패 없이 0만큼 움직인다 — 거기에는 그 글자가 없다.
    ///
    /// ⚠️ **쓸 것이 아니면 물어보지도 말라고 규격이 못박는다.** 온전한 문서는 물어본
    /// 순간 만들어지고, 그때부터 앱 이벤트를 따라다니며 자신을 동기화한다. 그래서 임시
    /// 문서일 때만, 그것도 한 번만 묻는다.
    ///
    /// 출처: "Transitory Extensions, or, how to get full text store support in
    /// TSF-unaware controls" (Microsoft TSF Aware blog, 2007-05-21)
    fn note_transitory_parent(context: &ITfContext) {
        match Self::transitory_parent_step(context) {
            Ok(top) => match unsafe { top.GetStatus() } {
                Ok(st) => log_line!(
                    "임시문서 부모: 있음 — 고정=0x{:x} 동적=0x{:x}",
                    st.dwStaticFlags,
                    st.dwDynamicFlags
                ),
                Err(e) => log_line!("임시문서 부모: 있음 (상태 못 읽음 0x{:08X})", e.code().0),
            },
            // ⚠️ **어느 단계에서 막혔는지가 고칠 방향을 가른다.** 「부모 칸」이 없으면 이
            // 앱에는 온전한 문서가 아예 없는 것이고(옛 IMM32를 흉내만 내는 부류), 「칸이
            // 비었음」이면 아직 안 만들어진 것이라 나중에 다시 물으면 되고, 형변환이
            // 막히면 우리가 잘못된 것을 꺼낸 것이다. 2026-08-28에 0x80004002 하나만
            // 남아 있어 셋을 구분할 수 없었다.
            Err((step, code)) => {
                log_line!("임시문서 부모: 없음 — {step}에서 0x{:08X}", code);
                if step == "부모 형변환" {
                    Self::note_parent_identity(context);
                }
            }
        }
    }

    /// 부모 칸의 물건이 `ITfDocumentMgr`가 아닐 때, **그럼 무엇인지** 물어 본다.
    ///
    /// 규격은 이 칸에 `ITfDocumentMgr`를 담으라고 못박는다(Microsoft "Predefined
    /// Compartments", TSF Aware 블로그 샘플, Mozc 구현이 모두 일치). 그런데 2026-08-28
    /// 아래한글에서 그 형변환만 `E_NOINTERFACE`로 튕겼다 — 칸도 있고 값도 있고 널도
    /// 아닌데. 그러면 **누가 계약을 어겼는지**를 봐야 한다. 진단 전용이고, 여기서 무엇이
    /// 나오든 그것을 제품 경로의 대체물로 쓰지 않는다.
    fn note_parent_identity(context: &ITfContext) {
        let Ok(manager) = (unsafe { context.GetDocumentMgr() }) else {
            return;
        };
        let Ok(compartments) = manager.cast::<ITfCompartmentMgr>() else {
            return;
        };
        let Ok(slot) =
            (unsafe { compartments.GetCompartment(&GUID_COMPARTMENT_TRANSITORYEXTENSION_PARENT) })
        else {
            return;
        };
        let Ok(value) = (unsafe { slot.GetValue() }) else {
            return;
        };
        let unknown = unsafe {
            let inner = &value.Anonymous.Anonymous;
            if inner.vt != VT_UNKNOWN {
                return;
            }
            inner.Anonymous.punkVal.as_ref().cloned()
        };
        let Some(unknown) = unknown else {
            return;
        };

        let mut yes: Vec<&str> = Vec::new();
        let mut no: Vec<&str> = Vec::new();
        macro_rules! probe {
            ($iface:ty, $name:literal) => {
                if unknown.cast::<$iface>().is_ok() {
                    yes.push($name)
                } else {
                    no.push($name)
                }
            };
        }
        probe!(ITfDocumentMgr, "ITfDocumentMgr");
        probe!(ITfContext, "ITfContext");
        probe!(ITfCompartmentMgr, "ITfCompartmentMgr");
        probe!(ITfSource, "ITfSource");
        probe!(ITfContextView, "ITfContextView");

        log_line!(
            "부모 칸의 정체: 됨=[{}] 안됨=[{}]",
            yes.join(", "),
            no.join(", ")
        );
    }

    /// 임시 문서에 딸린 **온전한 문서**의 맨 위 문맥.
    ///
    /// 없으면 오류다 — 옛 방식(IMM32)을 윈도우가 흉내 내 주기만 하는 앱이 그렇고,
    /// 그때는 임시 문서로 버티는 수밖에 없다. Mozc도 그 부류를 같은 방식으로 걸러 낸다.
    fn transitory_parent_context(context: &ITfContext) -> Result<ITfContext> {
        Self::transitory_parent_step(context)
            .map_err(|(_, code)| windows_core::Error::from(windows_core::HRESULT(code)))
    }

    /// 위와 같은 일을 하되 **막힌 단계의 이름**을 함께 돌려준다. 진단 전용.
    fn transitory_parent_step(
        context: &ITfContext,
    ) -> std::result::Result<ITfContext, (&'static str, i32)> {
        let manager = unsafe { context.GetDocumentMgr() }.map_err(|e| ("문서관리자", e.code().0))?;
        let compartments: ITfCompartmentMgr = manager.cast().map_err(|e| ("칸 목록", e.code().0))?;
        let slot = unsafe {
            compartments.GetCompartment(&GUID_COMPARTMENT_TRANSITORYEXTENSION_PARENT)
        }
        .map_err(|e| ("부모 칸", e.code().0))?;
        let value = unsafe { slot.GetValue() }.map_err(|e| ("칸 값", e.code().0))?;

        // 칸이 비어 있으면 이 앱에는 온전한 문서가 없다.
        let unknown = unsafe {
            let inner = &value.Anonymous.Anonymous;
            if inner.vt != VT_UNKNOWN {
                return Err(("칸이 비었음(vt)", inner.vt.0 as i32));
            }
            inner.Anonymous.punkVal.as_ref().cloned()
        };
        let unknown = unknown.ok_or(("칸이 비었음(널)", E_FAIL.0))?;
        let parent: ITfDocumentMgr = unknown.cast().map_err(|e| ("부모 형변환", e.code().0))?;
        unsafe { parent.GetTop() }.map_err(|e| ("부모 맨위", e.code().0))
    }

    /// **글자를 넣고 고칠 때 쓸 문맥.**
    ///
    /// ## 왜 받은 문맥을 그대로 안 쓰는가 (2026-08-07)
    ///
    /// TSF를 모르는 앱(아래한글)에는 문서가 둘이다. 키가 도착하는 임시 문서는 조합이
    /// 끝나는 순간 **앞서 넣은 것에 대한 기억을 버린다** — 규격에 그렇게 적혀 있고,
    /// 그래서 `ShiftStart(-1)`이 실패 없이 0만큼 움직였다. 갈아 끼우려던 것이 덧붙기가
    /// 되어 `한`이 `ㅎ하한`으로 박힌 것이 이 때문이다.
    ///
    /// 딸린 온전한 문서는 상태를 유지한다. 마이크로소프트는 **"한 번에 끝나는 삽입과
    /// 고침은 온전한 문서로"**라고 못박는다(조합은 임시 문서로 하라고도 한다 — 그래서
    /// 이 선택은 규격을 반쯤만 따르는 것이고, 실측으로 판정한다).
    ///
    /// 못 얻으면 받은 것을 그대로 쓴다. 그 앱에서는 지금까지와 똑같이 동작한다.
    fn edit_context(&self, context: &ITfContext) -> ITfContext {
        if !self.transitory.get() {
            return context.clone();
        }
        Self::transitory_parent_context(context).unwrap_or_else(|_| context.clone())
    }

    /// 지금 화면에 보여야 할 조합 문자열 = 완성된 음절들 + 조합기가 물고 있는 음절.
    fn display_text(&self) -> String {
        let settled = self.preedit.borrow().clone();
        let pending = self
            .composer
            .borrow()
            .as_ref()
            .map(|c| c.preedit())
            .unwrap_or_default();
        format!("{settled}{pending}")
    }

    /// 조합 중인 글자가 화면 어디에 있는가. **편집 세션 안에서** 잰다.
    ///
    /// 후보 창을 캐럿 옆에 놓으려면 이 값이 있어야 한다. `ITfContextView::GetTextExt`가
    /// 문서 범위를 화면 좌표로 바꿔 준다.
    ///
    /// ## 왜 세션을 따로 열지 않는가 (2026-08-07, 아래한글)
    ///
    /// 예전에는 조합을 갱신하는 세션과 **별개로** 세션을 하나 더 열어 여기서 쟀다.
    /// 그러면 키 하나에 편집 세션이 둘 열린다. **아래한글은 그 두 번째 세션에서
    /// 진행 중인 조합을 끊는다** — 그래서 `한`이 `ㅎ하한`으로 박혔다. 두 번째 세션을
    /// 읽기 전용(`TF_ES_READ`)으로 낮춰도 끊기는 것은 같았고, 그 모드에서는 좌표까지
    /// 문단 크기로 나와 쓸 수 없었다. 남은 길은 **세션을 하나로 합치는 것**이다.
    ///
    /// 실패는 **어느 단계에서** 막혔는지까지 남긴다. `GetTextExt`가 `TS_E_NOLAYOUT`이면
    /// 다시 물으면 되고, `GetActiveView`가 막히면 호스트가 문서 뷰를 안 주는 것이라
    /// 다른 길을 찾아야 한다 — 고칠 방향이 갈린다.
    fn caret_in_session(
        context: &ITfContext,
        composition: &ITfComposition,
        edit_cookie: u32,
    ) -> CaretOutcome {
        let view = match unsafe { context.GetActiveView() } {
            Ok(view) => view,
            Err(e) => return CaretOutcome::ActiveView(e.code().0),
        };
        let range = match unsafe { composition.GetRange() } {
            Ok(range) => range,
            Err(e) => return CaretOutcome::Range(e.code().0),
        };
        let mut rect = RECT::default();
        let mut clipped = BOOL::default();
        if let Err(e) = unsafe { view.GetTextExt(edit_cookie, &range, &mut rect, &mut clipped) } {
            return CaretOutcome::TextExt(e.code().0);
        }
        CaretOutcome::Ok {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        }
    }

    /// 조합 **앞의** 글자들. 연어 판별과 사용자 조합 학습이 이것을 본다.
    ///
    /// ## 왜 세션을 새로 열지 않는가
    ///
    /// 예전 주석은 "커서 앞 텍스트를 읽으려면 편집 세션이 하나 더 필요하다"고 적고
    /// 미뤄 두었는데, **두 번째 세션을 여는 것이 2026-08-07에 아래한글의 조합을 끊었던
    /// 바로 그 행위다**(`caret_in_session` 머리말). 그래서 캐럿과 똑같이,
    /// 조합을 갱신하는 **그 세션 안에서** 읽는다. 세션은 여전히 하나다.
    ///
    /// 조합 시작점 **앞**만 읽으므로 지금 치고 있는 글자가 문맥에 섞이지 않는다 —
    /// macOS 셸이 "단어 첫 글자에서 한 번만 읽는다"로 푸는 문제가 여기서는 생기지 않는다.
    fn preceding_in_session(composition: &ITfComposition, edit_cookie: u32) -> Option<String> {
        let range = unsafe { composition.GetRange() }.ok()?;
        let before = unsafe { range.Clone() }.ok()?;
        unsafe { before.Collapse(edit_cookie, TF_ANCHOR_START) }.ok()?;

        let mut shifted = 0i32;
        unsafe {
            before.ShiftStart(edit_cookie, -(CONTEXT_WINDOW as i32), &mut shifted, std::ptr::null())
        }
        .ok()?;
        if shifted == 0 {
            // 앞에 아무것도 없다 (문서 첫머리). 실패가 아니다.
            return Some(String::new());
        }

        let mut buffer = vec![0u16; CONTEXT_WINDOW];
        let mut fetched = 0u32;
        unsafe { before.GetText(edit_cookie, 0, &mut buffer, &mut fetched) }.ok()?;
        buffer.truncate(fetched as usize);
        Some(String::from_utf16_lossy(&buffer))
    }

    /// 지금 조합 중인 글자로 후보를 조회한다.
    ///
    /// **응답을 기다리지 않는다.** 여기서 기다리면 호스트 앱이 그동안 멈춘다 — 엔진이
    /// 죽어 있으면 영원히 멈춘다 (D6). 결과는 나중에 창 메시지로 도착한다.
    fn request_candidates(&self, buffer: &str, caret: Option<CaretRect>, preceding: Option<&str>) {
        let state = self.state.borrow();
        let Some(engine) = state.as_ref().and_then(|a| a.engine.as_ref()) else {
            return;
        };
        // 모드 표시가 뜰 자리를 알려면 캐럿은 늘 기억해 둬야 한다 — 조회를 건너뛰기
        // **전에** 넣는다.
        engine.note_caret(caret);
        // 단어를 조회하는 이 자리가 세션을 확보하는 자리다 — 기동 직후에 놓친 세션을
        // 여기서 만회한다 (`Engine::ensure_session` 머리말).
        engine.ensure_session();

        // 한글 전용 모드면 **조회 자체를 건너뛴다.** 후보 창만 숨기면 키마다 나가는
        // 소켓 왕복이 그대로 남는다.
        if !crate::settings::suggestions_enabled() {
            return;
        }
        engine.lookup(buffer, preceding, caret);
    }

    /// 조합이 끝났다. 남은 후보를 버린다 — 다음 조합에 옛 후보가 보이면 안 된다.
    fn clear_candidates(&self) {
        if let Some(engine) = self.state.borrow().as_ref().and_then(|a| a.engine.as_ref()) {
            engine.clear();
        }
    }

    /// 조합 문자열을 화면에 반영한다. 비었으면 조합을 끝낸다.
    fn sync_composition(&self, context: &ITfContext) -> Result<()> {
        let text = self.display_text();
        // 조합을 갱신하는 **그 세션 안에서** 캐럿까지 받아 온다. 조회는 세션 밖에서
        // 한다 — 엔진 응답을 기다리지 않으므로 세션을 붙들고 있을 이유가 없다.
        let (result, caret, preceding) = self.update_composition(context, &text);
        self.request_candidates(&text, caret, preceding.as_deref());
        result
    }

    /// 조합을 갱신하고, **같은 세션 안에서** 잰 캐럿 좌표를 함께 돌려준다.
    ///
    /// 캐럿을 여기서 함께 받는 것이 요점이다 — 따로 세션을 열면 아래한글이 조합을
    /// 끊는다(`caret_in_session` 머리말).
    fn update_composition(
        &self,
        context: &ITfContext,
        text: &str,
    ) -> (Result<()>, Option<CaretRect>, Option<String>) {
        // 임시 문서면 딸린 온전한 문서로 옮겨 탄다 — `edit_context` 머리말.
        let context = &self.edit_context(context);
        let text = text.to_string();
        let existing = self.composing.borrow().clone();
        let new_len = text.encode_utf16().count();
        // 세션 클로저는 `'static`이라 `&self`를 못 빌린다. 결과는 칸에 담아 내온다.
        let caret = Rc::new(Cell::new(None::<CaretOutcome>));
        let preceding = Rc::new(RefCell::new(None::<String>));

        let result = match (existing, text.is_empty()) {
            (Some(composition), true) => {
                *self.composing.borrow_mut() = None;
                self.composed_len.set(0);
                self.edit(context, move |ec| composition::cancel(&composition, ec))
            }
            (Some(composition), false) => {
                let ctx = context.clone();
                let out = Rc::clone(&caret);
                let before = Rc::clone(&preceding);
                let done = self.edit(context, move |ec| {
                    composition::set_text(&ctx, &composition, ec, &text)?;
                    out.set(Some(Self::caret_in_session(&ctx, &composition, ec)));
                    *before.borrow_mut() = Self::preceding_in_session(&composition, ec);
                    Ok(())
                });
                if done.is_ok() {
                    self.composed_len.set(new_len);
                }
                done
            }
            (None, true) => Ok(()),
            (None, false) => {
                let ctx = context.clone();
                let slot = Rc::clone(&self.composing);
                let out = Rc::clone(&caret);
                let sink = self.composition_sink();
                // 임시 문서에서는 직전 조합이 끊겼어도 그 글자가 문서에 남아 있다.
                // 그만큼을 덮으며 시작해야 갈아 끼우기가 된다.
                let replace_len = self.composed_len.get();
                let before = Rc::clone(&preceding);
                let done = self.edit(context, move |ec| {
                    let composition = composition::start(&ctx, ec, &sink, replace_len)?;
                    composition::set_text(&ctx, &composition, ec, &text)?;
                    out.set(Some(Self::caret_in_session(&ctx, &composition, ec)));
                    *before.borrow_mut() = Self::preceding_in_session(&composition, ec);
                    *slot.borrow_mut() = Some(composition);
                    Ok(())
                });
                self.composed_len.set(if done.is_ok() { new_len } else { 0 });
                done
            }
        };

        // 조합이 없어 재 볼 자리조차 없었던 것도 하나의 결과다 — 안 세면 "안 나온다"와
        // "안 재봤다"가 구별되지 않는다.
        let outcome = caret.get().unwrap_or(CaretOutcome::NoComposition);
        self.caret_stats.borrow_mut().record(outcome);
        let before = preceding.borrow().clone();
        (result, outcome.rect(), before)
    }

    /// 조합 자리의 글자를 `text`로 갈아 끼우고 **확정한다.**
    ///
    /// 조합이 살아 있으면 그것을 쓰고, **끊긴 뒤면 문서에 남은 우리 글자를 덮는 새
    /// 조합**을 만들어 쓴다. 임시 문서(`TS_SS_TRANSITORY`)에서는 확정하려는 순간에
    /// 조합이 이미 없는 것이 정상이고, 그때 그냥 돌아가면 후보로 고른 한자가 문서에
    /// 안 들어간다 — `한자`를 골랐는데 `한자`가 남는다.
    fn replace_and_commit(&self, context: &ITfContext, text: &str) -> Result<()> {
        let context = &self.edit_context(context);
        let text = text.to_string();
        let existing = self.composing.borrow_mut().take();
        let replace_len = self.composed_len.get();
        self.composed_len.set(0);

        if existing.is_none() && replace_len == 0 {
            // 문서에 그려 둔 것도, 조합도 없다. 확정할 것이 없다.
            self.preedit.borrow_mut().clear();
            return Ok(());
        }

        let ctx = context.clone();
        let sink = self.composition_sink();
        let result = self.edit(context, move |ec| {
            let composition = match existing {
                Some(c) => c,
                None => composition::start(&ctx, ec, &sink, replace_len)?,
            };
            composition::set_text(&ctx, &composition, ec, &text)?;
            composition::commit(&composition, ec)
        });
        self.preedit.borrow_mut().clear();
        result
    }

    /// 조합을 확정하고 상태를 비운다.
    fn commit_all(&self, context: &ITfContext) -> Result<()> {
        // 조합기에 남아 있는 음절을 마저 꺼내 문자열에 합친 뒤 확정한다.
        if let Some(composer) = self.composer.borrow().as_ref() {
            let rest = composer.flush();
            if !rest.is_empty() {
                self.preedit.borrow_mut().push_str(&rest);
            }
        }
        self.clear_candidates();
        let text = self.preedit.borrow().clone();
        let count = text.chars().count();
        self.replace_and_commit(context, &text)?;
        log_verbose!("확정: {count}자");
        Ok(())
    }

    /// 후보 목록이 떠 있을 때만 의미가 있는 키들.
    ///
    /// 돌려주는 값이 `None`이면 "이 키는 후보와 무관하다"이고, 그때 뒤의 일반 처리로
    /// 넘어간다. `Some(먹었는가)`면 여기서 끝난다.
    fn handle_candidate_key(&self, context: &ITfContext, vk: u16) -> Result<Option<bool>> {
        let engine_present = {
            let state = self.state.borrow();
            state
                .as_ref()
                .and_then(|a| a.engine.as_ref())
                .is_some_and(|e| e.has_candidates())
        };
        if !engine_present {
            return Ok(None);
        }

        // 아래 분기들에서 `state`를 계속 빌리면 확정 경로에서 다시 빌릴 때 겹친다.
        // 필요한 것만 꺼내고 빌림을 놓는다.
        enum Action {
            /// 다음 후보 (가로 한 줄이므로 **오른쪽**)
            MoveNext,
            MovePrevious,
            /// 접힌 줄을 펼치거나, 펼친 상태면 아랫줄로
            ExpandOrDown,
            CollapseOrUp,
            /// 후보 창을 커서 위/아래 어디에 둘지 (`Shift+↑/↓`)
            SetAbove(bool),
            Commit(CandidateItem),
            Dismiss,
            None,
        }

        let action = {
            let state = self.state.borrow();
            let Some(engine) = state.as_ref().and_then(|a| a.engine.as_ref()) else {
                return Ok(None);
            };

            match vk {
                // ⚠️ Shift 조합을 **먼저** 가른다. 아래에 두면 맨 방향키가 먼저 먹어
                //    후보만 움직인다.
                //
                // 후보 창을 커서 위로 올릴지 아래로 내릴지는 기계가 가릴 수 없다
                // (`settings.rs` 머리말). 사용자가 그 자리에서 정하고 앱별로 기억한다.
                // 조합 중에만 우리가 키를 먹으므로 앱의 선택 확장(Shift+방향키)과 부딪히지
                // 않는다 — 후보가 없으면 이 함수 자체를 지나간다.
                k if k == VK_UP.0 && shift_down() => Action::SetAbove(true),
                k if k == VK_DOWN.0 && shift_down() => Action::SetAbove(false),

                // 후보 창은 **가로 한 줄**이다. 다음 후보는 아래가 아니라 오른쪽에 있다.
                //
                // 가로 후보창에서는 좌우 키가 이전·다음 후보로 움직여야 한다.
                //
                // 옛 윈도우 판은 좌우를 「후보를 짚은 뒤의 쪽 넘김」으로 썼다. 가로로 바꾸며
                // macOS와 같은 뜻(다음/이전 후보)으로 맞춘다 — 두 플랫폼이 다르면 손이 헷갈린다.
                k if k == VK_RIGHT.0 => Action::MoveNext,
                k if k == VK_LEFT.0 => Action::MovePrevious,

                // 위아래는 **펼치고 접는다.** 접힌 줄 뒤에 후보가 더 있다는 것을 쪽 표시
                // (`2/3`) 하나로만 알리는 것은 약하다.
                k if k == VK_DOWN.0 => Action::ExpandOrDown,
                k if k == VK_UP.0 => Action::CollapseOrUp,
                k if k == VK_RETURN.0 => {
                    // 후보를 짚지 않았으면 Enter는 사용자의 줄바꿈이다.
                    match engine.is_active().then(|| engine.selected()).flatten() {
                        Some(item) => Action::Commit(item),
                        None => return Ok(None),
                    }
                }
                // 후보만 접는다. 조합은 남는다 — 사용자는 한글로 계속 칠 수 있다.
                k if k == VK_ESCAPE.0 => Action::Dismiss,
                _ => match digit_of(vk) {
                    // 0은 후보 번호가 아니다 (번호는 1~9).
                    Some(0) | None => Action::None,
                    Some(digit) => {
                        // Shift+숫자는 특수문자다. 여기까지 오면 안 되지만, 키를 먹는
                        // 판단이 두 곳에 있으므로 확정 직전에 한 번 더 막는다.
                        if (0x30..=0x39).contains(&vk) && shift_down() {
                            return Ok(None);
                        }
                        match engine.select_number(digit) {
                            Some(item) => Action::Commit(item),
                            // 그 자리에 후보가 없다. 사용자는 숫자를 치려던 것이므로
                            // 먹지 않고 넘긴다.
                            None => return Ok(None),
                        }
                    }
                },
            }
        };

        let state = self.state.borrow();
        let engine = state.as_ref().and_then(|a| a.engine.as_ref());
        match action {
            Action::MoveNext => engine.map(|e| e.move_next()),
            Action::MovePrevious => engine.map(|e| e.move_previous()),
            Action::ExpandOrDown => engine.map(|e| e.expand_or_move_down()),
            Action::CollapseOrUp => engine.map(|e| e.collapse_or_move_up()),
            Action::SetAbove(above) => engine.map(|e| e.set_prefer_above(above)),
            Action::Dismiss => engine.map(|e| e.dismiss()),
            Action::Commit(item) => {
                drop(state);
                self.commit_candidate(context, &item)?;
                return Ok(Some(true));
            }
            Action::None => return Ok(None),
        };
        Ok(Some(true))
    }

    /// 고른 후보를 문서에 넣는다.
    ///
    /// 조합 중인 글자 전체가 아니라 **그 후보의 표제어에 해당하는 앞부분만** 바꾼다.
    /// "발전소"를 치다 "발전"을 고르면 `發電소`가 되어야 하고, 남은 "소"는 그대로
    /// 이어져야 한다.
    fn commit_candidate(&self, context: &ITfContext, item: &CandidateItem) -> Result<()> {
        // 조합기에 걸린 자모까지 합쳐야 지금 화면에 보이는 것과 같아진다.
        if let Some(composer) = self.composer.borrow().as_ref() {
            let rest = composer.flush();
            if !rest.is_empty() {
                self.preedit.borrow_mut().push_str(&rest);
            }
        }
        let buffer = self.preedit.borrow().clone();
        let remainder = buffer
            .strip_prefix(item.word.as_str())
            .unwrap_or("")
            .to_string();
        let text = format!("{}{}", item.hanja, remainder);

        // 사용 이력은 화면에 넣은 모양이 아니라 **표제어와 한자**로 기록한다.
        // 그리고 문맥 키는 **조회 때 받은 것**을 그대로 돌려보낸다 — 여기서 앞 문맥을
        // 다시 읽으면 조합 때와 다른 칸에 쌓여 다음에 안 올라온다.
        if let Some(engine) = self.state.borrow().as_ref().and_then(|a| a.engine.as_ref()) {
            engine.commit(&item.word, &item.hanja, item.context_key.as_deref());
            engine.clear();
        }

        let count = text.chars().count();
        self.replace_and_commit(context, &text)?;
        log_verbose!("후보 확정: {count}자");
        Ok(())
    }

    /// 키 하나를 처리한다. 돌려주는 값은 "먹었는가".
    fn handle_key_down(&self, context: &ITfContext, vk: u16) -> Result<bool> {
        let composing = self.is_composing();

        // ---- 잘못 배운 조합 잊기 (Ctrl+Delete) ----
        //
        // 윈도우 TIP에는 메뉴가 없다(macOS는 입력 소스 메뉴에 항목을 둔다). 자동 학습만으로는
        // 나쁜 항목을 영영 막을 수 없어 **사람의 거부권**이 있어야 하므로 키로 낸다.
        if vk == VK_DELETE.0 && ctrl_down() && !shift_down() {
            let forgotten = self
                .state
                .borrow()
                .as_ref()
                .and_then(|a| a.engine.as_ref())
                .map(|e| e.forget_selected())
                .unwrap_or(false);
            log_verbose!(
                "Ctrl+Delete: 잊음={forgotten} 후보={}",
                self.key_context().has_candidates
            );
            if forgotten {
                log_line!("조합 잊기");
                self.clear_candidates();
                return Ok(true);
            }
            // 사용자 조합이 아니면 우리 것이 아니다 — 앱의 Ctrl+Delete(단어 삭제)로 간다
            return Ok(false);
        }

        // ---- 한자 모드 / 한글 전용 모드 ----
        //
        // 한국어 키보드의 **한자 키**(오른쪽 Alt 자리)로 오간다.
        //
        // ⚠️ 오른쪽 Alt를 `VK_RMENU`로 잡으려 하면 안 된다. 실측(2026-08-28, livingroom)
        // 결과 Alt는 시스템 키로 먹혀 입력기까지 오지 않는다. 한국어 자판에서 그 물리 키는
        // `VK_HANJA`(0x19)를 보내고 **그것은 온다.**
        //
        // macOS는 왼쪽 ⌘+Shift다. 자리가 다른 것은 윈도우 키가 혼자 눌려도 시작 메뉴를
        // 띄우고, Alt+Shift·Ctrl+Shift가 윈도우의 언어·자판 전환 자리이기 때문이다.
        if vk == VK_HANJA.0 {
            // 조합 중이었으면 먼저 확정한다 — 모드가 바뀌는 순간 조합이 어중간하게
            // 남아 있으면 다음 글자가 그것에 붙는다.
            if composing {
                self.commit_all(context)?;
            }
            let enabled = crate::settings::toggle_suggestions();
            log_line!("한자 키: 후보 {}", if enabled { "켬" } else { "끔" });
            if !enabled {
                self.clear_candidates();
            }
            if let Some(engine) = self.state.borrow().as_ref().and_then(|a| a.engine.as_ref()) {
                engine.show_mode(if enabled { "漢字" } else { "한글" });
            }
            return Ok(true);
        }

        // 단축키는 우리 것이 아니다. 다만 조합 중이었다면 먼저 확정한다 — 조합을
        // 띄워 둔 채로 앱이 전체 선택이나 붙여넣기를 하면 문서 상태가 어긋난다.
        if modifier_down() {
            // ⚠️ **수식키 자체가 눌린 것으로는 확정하지 않는다.** 아직 무슨 단축키인지
            // 모르는 시점이고, 확정하면 후보 목록이 사라진다. 그러면 뒤이어 오는
            // `Ctrl+Delete`(조합 잊기)에는 지울 후보가 없다 — 2026-08-28에 그 기능이
            // 조용히 안 먹은 원인이 이것이었다. 확정은 **조합 키가 실제로 올 때** 한다.
            if vk == VK_CONTROL.0 || vk == VK_MENU.0 || vk == VK_SHIFT.0 {
                return Ok(false);
            }
            if composing {
                self.commit_all(context)?;
            }
            return Ok(false);
        }

        // ---- 후보가 떠 있을 때만 의미가 있는 키들 ----
        if let Some(handled) = self.handle_candidate_key(context, vk)? {
            return Ok(handled);
        }

        if composing && (vk == VK_SPACE.0 || vk == VK_RETURN.0) {
            self.commit_all(context)?;
            // 먹지 않았다고 답해 공백·줄바꿈 자체는 앱이 처리하게 한다. 여기서
            // 참을 돌려주면 확정은 되는데 공백이 사라진다.
            return Ok(false);
        }

        if composing && vk == VK_ESCAPE.0 {
            if let Some(composer) = self.composer.borrow().as_ref() {
                let _ = composer.flush();
            }
            self.clear_candidates();
            // 빈 글자로 갈아 끼우고 끝낸다 = 취소. 조합이 이미 끊긴 뒤여도 문서에 남은
            // 글자를 덮어 지우므로 임시 문서에서도 같은 결과가 된다.
            self.replace_and_commit(context, "")?;
            log_verbose!("취소");
            return Ok(true);
        }

        if composing && vk == VK_BACK.0 {
            // 먼저 조합 중인 음절에서 자모를 하나 뺀다. 뺄 게 없으면 이미 완성된
            // 음절을 하나 지운다. 이 순서가 뒤바뀌면 "각"에서 backspace가 "가"가
            // 아니라 빈 문자열이 된다.
            let removed_jamo = self
                .composer
                .borrow()
                .as_ref()
                .map(|c| c.backspace())
                .unwrap_or(false);
            if !removed_jamo {
                self.preedit.borrow_mut().pop();
            }
            self.sync_composition(context)?;
            return Ok(true);
        }

        if (0x41..=0x5A).contains(&vk) {
            let ascii = b'a' + (vk - 0x41) as u8;

            let eaten = {
                let composer_ref = self.composer.borrow();
                let Some(composer) = composer_ref.as_ref() else {
                    return Ok(false);
                };
                if !composer.process(ascii) {
                    false
                } else {
                    // 음절이 완성돼 밀려나오면 확정된 쪽에 쌓는다.
                    let done = composer.commit();
                    if !done.is_empty() {
                        self.preedit.borrow_mut().push_str(&done);
                    }
                    true
                }
            };

            if !eaten {
                return Ok(false);
            }
            self.sync_composition(context)?;
            log_verbose!("조합 갱신: {}자", self.display_text().chars().count());
            return Ok(true);
        }

        // ⚠️ **우리 것이 아닌 키는 조합을 끝낸 뒤에 넘긴다.**
        //
        // 숫자·문장부호처럼 우리가 안 먹는 키를 조합을 **열어 둔 채로** 넘기면, 앱은
        // 그 글자를 넣지만 이어지는 글자가 조합 범위를 다시 덮어써서 방금 넣은 것이
        // 지워진다. `사당3동`을 치면 `사당동`이 되는 것이 이것이다 (2026-08-28 실측).
        //
        // 공백·엔터는 이미 위에서 그렇게 하고 있었다. 나머지가 빠져 있었을 뿐이다.
        // 한글 전용 모드를 붙이며 드러났는데, 모드와 무관한 결함이다 — 후보가 없는
        // 표제어를 치다 숫자를 쳐도 같았다.
        if composing {
            self.commit_all(context)?;
        }

        Ok(false)
    }
}

impl ITfKeyEventSink_Impl for TextService_Impl {
    fn OnSetFocus(&self, foreground: BOOL) -> Result<()> {
        if foreground.as_bool() {
            self.note_sink(SINK_FOCUS, "OnSetFocus(앞으로)");
        }
        log_verbose!("OnSetFocus: {}", foreground.as_bool());
        Ok(())
    }

    fn OnTestKeyDown(
        &self,
        _context: Ref<'_, ITfContext>,
        wparam: WPARAM,
        _lparam: LPARAM,
    ) -> Result<BOOL> {
        self.note_sink(SINK_TEST_KEY, "OnTestKeyDown");
        let want = wants_key(wparam.0 as u16, self.key_context());
        log_verbose!("OnTestKeyDown: vk=0x{:02X} → {want}", wparam.0);
        Ok(want.into())
    }

    fn OnKeyDown(
        &self,
        context: Ref<'_, ITfContext>,
        wparam: WPARAM,
        _lparam: LPARAM,
    ) -> Result<BOOL> {
        self.note_sink(SINK_KEY, "OnKeyDown");
        log_verbose!("OnKeyDown: vk=0x{:02X}", wparam.0);
        if let Some(ctx) = context.as_ref() {
            self.note_context_status(ctx);
        }
        let Some(context) = context.as_ref() else {
            log_verbose!("OnKeyDown: 문맥 없음");
            return Ok(false.into());
        };
        match self.handle_key_down(context, wparam.0 as u16) {
            Ok(eaten) => Ok(eaten.into()),
            Err(e) => {
                // 오류를 그대로 올리면 키가 사라진다. 먹지 않았다고 답해 앱에 넘긴다.
                log_verbose!("handle_key_down 실패: 0x{:08X} — {}", e.code().0, e.message());
                Ok(false.into())
            }
        }
    }

    fn OnTestKeyUp(
        &self,
        _context: Ref<'_, ITfContext>,
        _wparam: WPARAM,
        _lparam: LPARAM,
    ) -> Result<BOOL> {
        Ok(false.into())
    }

    fn OnKeyUp(
        &self,
        _context: Ref<'_, ITfContext>,
        _wparam: WPARAM,
        _lparam: LPARAM,
    ) -> Result<BOOL> {
        Ok(false.into())
    }

    fn OnPreservedKey(&self, _context: Ref<'_, ITfContext>, _guid: *const GUID) -> Result<BOOL> {
        Ok(false.into())
    }
}

// ------------------------------------------------------ 조합 표시 속성 제공

/// 조합 중인 글자에 걸 표시 속성을 앱에 내준다.
///
/// TSF는 조합 범위의 `GUID_PROP_ATTRIBUTE` 값(원자 번호)을 보고, 그것을 등록한
/// 제공자에게 "그 속성이 어떤 모양이냐"고 되묻는다. 그 되물음에 답하는 것이 여기다.
/// 이것이 없으면 속성을 걸어도 앱이 뜻을 알 수 없어 무시한다 — 그리고 조합을 자기가
/// 그리는 앱(아래한글)은 그 조합을 아예 안 받아들인다.
impl ITfDisplayAttributeProvider_Impl for TextService_Impl {
    fn EnumDisplayAttributeInfo(&self) -> Result<IEnumTfDisplayAttributeInfo> {
        Ok(crate::display_attr::DisplayAttributeEnum::new().into())
    }

    fn GetDisplayAttributeInfo(&self, guid: *const GUID) -> Result<ITfDisplayAttributeInfo> {
        if guid.is_null() {
            return Err(E_INVALIDARG.into());
        }
        if unsafe { *guid } != crate::guids::GUID_JIEUM_DISPLAY_ATTR_INPUT {
            // 모르는 속성이다. 아무거나 돌려주면 앱이 엉뚱한 모양으로 그린다.
            return Err(E_INVALIDARG.into());
        }
        Ok(crate::display_attr::DisplayAttributeInfo::new().into())
    }
}
