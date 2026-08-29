//! 엔진 연결 — 입력기 스레드와 배경 파이프 스레드 사이의 다리.
//!
//! `jieum-engine-client`가 파이프를 맡고, 이 모듈은 그 결과를 **입력기 스레드로 안전하게
//! 옮기는 일**만 한다.
//!
//! ## 왜 창이 필요한가
//!
//! 입력기 객체는 apartment(스레드 친화) COM이라 만들어진 스레드에서만 만질 수 있다.
//! 파이프를 읽는 배경 스레드가 후보를 직접 넘겨주면 그 규칙을 어긴다. 윈도우에서 다른
//! 스레드의 일을 특정 스레드로 넘기는 표준 수단이 창 메시지이고, 입력기는 이미 호스트
//! 앱의 메시지 루프 안에 있으므로 **메시지 전용 창**(`HWND_MESSAGE`) 하나만 만들면
//! 그 루프를 얻어 탈 수 있다. 화면에 아무것도 그리지 않는 창이다.
//!
//! 배경 스레드가 하는 일은 `PostMessage` 하나뿐이다 — 이건 스레드 안전이 보장된 몇 안 되는
//! 창 함수다.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use jieum_candidates::ui_command::CaretRect;
use jieum_candidates::{CandidateItem, CandidateModel, Entry, Group, GroupKind};
use jieum_engine_client::{EngineClient, EngineEvent, LookupReply, DEFAULT_PIPE_NAME};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowLongPtrW, PostMessageW,
    RegisterClassW, SetWindowLongPtrW, UnregisterClassW, GWLP_USERDATA, HWND_MESSAGE, WINDOW_EX_STYLE,
    WINDOW_STYLE, WM_APP, WM_NCDESTROY, WNDCLASSW,
};

use crate::{log_line, log_verbose};

/// 엔진 응답이 도착했다는 알림. 내용은 실려 있지 않다 — 받는 쪽이 `drain`한다.
const WM_JIEUM_ENGINE: u32 = WM_APP + 1;

const CLASS_NAME: PCWSTR = windows_core::w!("JieumEngineBridge");

/// 재연결 시도 최소 간격.
///
/// 엔진이 꺼져 있으면 조합할 때마다 연결을 시도하게 되는데, 실패하는 `CreateFileW`도
/// 공짜가 아니다. 키 입력마다 그 값을 치르면 안 된다.
const RECONNECT_INTERVAL: Duration = Duration::from_secs(3);

/// 입력기 스레드와 창 프로시저가 함께 보는 상태.
///
/// `Rc`인 이유: 창 프로시저는 `&self`를 받을 수 없는 `extern "system"` 함수라 상태를
/// 포인터로 건네야 하고, 그 포인터가 가리키는 것이 창보다 오래 살아야 한다.
struct Bridge {
    client: RefCell<Option<EngineClient>>,
    /// 화면에 보이는 후보 목록과 선택 상태. **키 처리도 이것을 본다** — 상태를 후보 창
    /// 프로세스와 나눠 가지면 화면과 키가 어긋난다.
    model: RefCell<CandidateModel>,
    /// 사용자가 후보를 **짚었는가**.
    ///
    /// 후보가 떠 있기만 한 상태와 사용자가 방향키로 하나를 고른 상태는 다르다. 전자에서
    /// Enter는 사용자의 줄바꿈이고, 후자에서 Enter는 확정이다. 새 조회가 오면 다시
    /// 안 짚은 상태로 돌아간다.
    active: std::cell::Cell<bool>,
    /// 후보 창을 놓을 자리.
    ///
    /// **조회를 보낼 때** 재어 둔다. 응답이 오는 시점에는 편집 세션 밖이라 캐럿을 다시
    /// 잴 수 없다 — 창 메시지로 돌아오기 때문에 `ITfContext`가 손에 없다. 그 사이의
    /// 캐럿 이동은 한 글자 폭이고, 다음 키에서 갱신된다.
    caret: std::cell::Cell<Option<CaretRect>>,
    /// **지우지 않는** 마지막 캐럿.
    ///
    /// 위의 `caret`은 조회마다 갈리고 조합이 없으면 비는데, 모드 표시는 **조합 중이
    /// 아닐 때** 뜨는 것이 보통이다(모드를 바꾸고 나서 치기 시작하므로). 그래서 마지막에
    /// 알던 자리를 따로 들고 있는다 — 조금 낡아도 화면 구석보다는 낫다.
    last_caret: std::cell::Cell<Option<CaretRect>>,
    /**
     이 입력 지점의 세션.

     서버가 「낱자가 이어서 쳐졌는가」를 세션 단위로 판정한다(`assembly.ts`). 세션이
     없으면 **아무 말 없이 안 배운다** — macOS 셸이 같은 이유로 조용히 안 돌았고,
     엔진 로그에 `조합 아님: no-session`만 쌓였다 (2026-08-28).
     */
    session_id: RefCell<Option<String>>,
    /// 세션 요청이 날아가 있는가. 키마다 요청이 쌓이지 않게 막는다
    session_pending: std::cell::Cell<bool>,
    ui: crate::candidate_ui::CandidateUi,
    last_attempt: RefCell<Option<Instant>>,
    /// 첫 조회 응답을 기록했는가.
    ///
    /// "엔진에 붙었다"와 "조회가 실제로 돌아온다"는 다른 사실이고, 둘 사이에서 고장이
    /// 난다(파이프 권한이 대표적이다 — 붙기는 붙는데 요청을 못 쓴다). 그래서 첫 응답은
    /// 상세 진단이 꺼진 실사용에서도 한 줄 남긴다. 매번 남기지 않으므로 로그는 커지지
    /// 않고, 개수만 적으므로 사용자가 친 내용은 들어가지 않는다.
    first_reply_logged: std::cell::Cell<bool>,
    /// 이 입력기가 얹혀 있는 앱의 실행 파일 이름. 후보 창 자리를 **앱별로** 기억하므로
    /// 설정을 읽고 쓸 때 열쇠가 된다.
    app: String,
}

impl Bridge {
    /// 이 앱에서 후보 창을 커서 위에 둘 것인가.
    fn prefer_above(&self) -> bool {
        crate::settings::prefers_above(&self.app)
    }
}

pub struct Engine {
    shared: Rc<Bridge>,
    hwnd: HWND,
}

impl Engine {
    /// 메시지 전용 창을 만든다. 연결은 아직 하지 않는다 —
    /// 첫 조회 때 `ensure_connected`가 붙는다.
    pub fn start(app: String) -> Option<Self> {
        let shared = Rc::new(Bridge {
            client: RefCell::new(None),
            model: RefCell::new(CandidateModel::default()),
            active: std::cell::Cell::new(false),
            caret: std::cell::Cell::new(None),
            last_caret: std::cell::Cell::new(None),
            session_id: RefCell::new(None),
            session_pending: std::cell::Cell::new(false),
            ui: crate::candidate_ui::CandidateUi::new(),
            last_attempt: RefCell::new(None),
            first_reply_logged: std::cell::Cell::new(false),
            app,
        });

        let hwnd = create_message_window(Rc::clone(&shared))?;

        // 후보 창 프로세스를 지금 띄운다. 첫 조회가 올 때는 이미 떠 있어야 한다.
        shared.ui.warm_up();

        Some(Self { shared, hwnd })
    }

    /// 연결이 없거나 끊겼으면 다시 붙는다. 실패는 정상 경로다 — 엔진이 아직 안 떴을 수 있고,
    /// 그때는 **제안만 없고 타이핑은 계속돼야 한다**.
    fn ensure_connected(&self) -> bool {
        if self
            .shared
            .client
            .borrow()
            .as_ref()
            .is_some_and(|c| c.is_connected())
        {
            return true;
        }

        {
            let last = self.shared.last_attempt.borrow();
            if let Some(t) = *last {
                if t.elapsed() < RECONNECT_INTERVAL {
                    return false;
                }
            }
        }
        *self.shared.last_attempt.borrow_mut() = Some(Instant::now());

        // 콜백은 배경 스레드에서 불린다. `HWND`는 `Send`가 아니므로 정수로 옮겨
        // 담고 안에서 되살린다 — `PostMessage`는 스레드 경계를 넘어 부를 수 있다.
        let hwnd_bits = self.hwnd.0 as isize;
        let result = EngineClient::connect(DEFAULT_PIPE_NAME, move || {
            let hwnd = HWND(hwnd_bits as *mut std::ffi::c_void);
            unsafe {
                let _ = PostMessageW(Some(hwnd), WM_JIEUM_ENGINE, WPARAM(0), LPARAM(0));
            }
        });

        match result {
            Ok(client) => {
                let version = concat!("jieum-tip/", env!("CARGO_PKG_VERSION"));
                let _ = client.hello(version);
                *self.shared.client.borrow_mut() = Some(client);
                log_line!("엔진 파이프 연결");
                true
            }
            Err(e) => {
                // 엔진이 안 떠 있는 것은 흔한 상태다. 매번 남기면 로그가 이것만 남는다.
                log_verbose!("엔진 연결 실패: {e}");
                false
            }
        }
    }

    /// 세션이 없으면 연다.
    ///
    /// ⚠️ **한 번만 시도하면 안 된다.** 입력기가 막 붙은 직후에는 파이프가 아직 안
    /// 열려 있어 조용히 실패하고, 그러면 그 입력 지점은 영영 세션이 없다.
    pub fn ensure_session(&self) {
        if self.shared.session_id.borrow().is_some() || self.shared.session_pending.get() {
            return;
        }
        self.shared.session_pending.set(true);
        if let Some(client) = self.shared.client.borrow().as_ref() {
            if client.session_open().is_err() {
                // 다음 단어에서 다시 시도한다
                self.shared.session_pending.set(false);
            }
        } else {
            self.shared.session_pending.set(false);
        }
    }

    fn session(&self) -> Option<String> {
        self.shared.session_id.borrow().clone()
    }

    /// 조합 중인 버퍼로 후보를 조회한다. **응답을 기다리지 않는다.**
    ///
    /// `caret`이 `None`이면 호스트 앱이 캐럿 위치를 알려 주지 못한 것이다. 그때는
    /// 조회는 하되 창을 띄우지 않는다 — 화면 왼쪽 위 구석에 뜬 후보 창은 없느니만 못하다.
    pub fn lookup(&self, buffer: &str, preceding_text: Option<&str>, caret: Option<CaretRect>) {
        self.shared.caret.set(caret);
        if caret.is_some() {
            self.shared.last_caret.set(caret);
        }
        if buffer.is_empty() {
            self.clear();
            return;
        }
        if !self.ensure_connected() {
            return;
        }
        if let Some(client) = self.shared.client.borrow().as_ref() {
            let _ = client.lookup(buffer, preceding_text, self.session().as_deref());
        }
    }

    /// 지금 화면에 보이는 후보를 다시 그린다. 선택이 움직였을 때 부른다.
    fn refresh(&self) {
        let Some(caret) = self.shared.caret.get() else {
            return;
        };
        self.shared
            .ui
            .show(caret, &self.shared.model.borrow(), self.shared.prefer_above());
    }

    /// 모드가 바뀐 것을 커서 옆에 잠깐 보여 준다.
    ///
    /// 커서 자리를 모르면 아무것도 안 한다 — 화면 구석에 뜬 표시는 후보 창과 같은
    /// 이유로 없느니만 못하다.
    pub fn show_mode(&self, label: &str) {
        let Some(caret) = self.shared.last_caret.get() else {
            return;
        };
        self.shared
            .ui
            .show_mode(label, caret, self.shared.prefer_above());
    }

    /// 캐럿 자리만 기억해 둔다. 한글 전용 모드에서는 조회를 안 나가므로 이것이라도
    /// 없으면 모드 표시가 뜰 자리를 영영 모른다.
    pub fn note_caret(&self, caret: Option<CaretRect>) {
        if caret.is_some() {
            self.shared.last_caret.set(caret);
        }
    }

    /// 지금 짚은 후보가 사용자 조합이면 잊는다. 잊었으면 `true`.
    pub fn forget_selected(&self) -> bool {
        let item = match self.shared.model.borrow().selected_item() {
            Some(item) if item.user_word => item.clone(),
            _ => return false,
        };
        if let Some(client) = self.shared.client.borrow().as_ref() {
            let _ = client.forget_user_word(&item.word, &item.hanja);
        }
        true
    }

    pub fn has_candidates(&self) -> bool {
        !self.shared.model.borrow().is_empty()
    }

    /// 사용자가 후보를 짚었는가. Enter의 뜻이 이것으로 갈린다.
    pub fn is_active(&self) -> bool {
        self.shared.active.get()
    }

    /// ⚠️ 이름에 방향이 없다 — 후보 창이 **가로 한 줄**이라 다음 후보는 아래가 아니라
    /// 오른쪽에 있다. `move_down`/`move_up`이던 옛 이름은 키 배정을 세로로 되돌린다.
    pub fn move_next(&self) {
        self.shared.active.set(true);
        self.shared.model.borrow_mut().move_next();
        self.refresh();
    }

    pub fn move_previous(&self) {
        self.shared.active.set(true);
        self.shared.model.borrow_mut().move_previous();
        self.refresh();
    }

    /// 접힌 한 줄을 아래로 쫙 펼친다. 이미 펼쳐져 있으면 아랫줄로 내려간다.
    pub fn expand_or_move_down(&self) {
        self.shared.active.set(true);
        self.shared.model.borrow_mut().expand_or_move_down();
        self.refresh();
    }

    /// 윗줄로 올라간다. 첫 줄에서 부르면 접는다.
    pub fn collapse_or_move_up(&self) {
        self.shared.active.set(true);
        self.shared.model.borrow_mut().collapse_or_move_up();
        self.refresh();
    }

    /// 후보 창을 커서 위/아래 어디에 둘지 사용자가 정한다 (`Shift+↑/↓`).
    ///
    /// **기억해 두는 것이 핵심이다.** 매번 눌러야 하면 결국 아무도 안 쓴다 — 검색창에
    /// 들어갈 때마다 손이 한 번 더 가느니 가려진 채로 쓰게 된다.
    pub fn set_prefer_above(&self, above: bool) {
        crate::settings::set_prefers_above(&self.shared.app, above);
        log_line!("후보창 자리: {} (앱 {})", if above { "위" } else { "아래" }, self.shared.app);
        // 누른 그 자리에서 창이 움직여야 사용자가 결과를 본다
        self.refresh();
    }


    /// 지금 짚고 있는 후보.
    pub fn selected(&self) -> Option<CandidateItem> {
        self.shared.model.borrow().selected_item().cloned()
    }

    /// 숫자키로 고른다. 그 자리에 후보가 없으면 `None` —
    /// **이때 입력기는 그 키를 먹지 말고 호스트 앱에 넘겨야 한다.**
    pub fn select_number(&self, number: usize) -> Option<CandidateItem> {
        self.shared
            .model
            .borrow_mut()
            .select_number(number)
            .cloned()
    }

    /// 후보만 접는다. 조합은 남는다 — 사용자는 한글로 계속 칠 수 있다.
    pub fn dismiss(&self) {
        *self.shared.model.borrow_mut() = CandidateModel::default();
        self.shared.active.set(false);
        self.shared.ui.hide();
    }

    /// 사용자가 후보를 확정했다.
    ///
    /// 아직 부르는 곳이 없다 — 후보를 고르는 UI가 붙어야 확정할 것이 생긴다. 계약을 먼저
    /// 맞춰 두는 이유는 `context_key`를 조회 응답에서 그대로 실어 보내야 하기 때문이다.
    #[allow(dead_code)]
    pub fn commit(&self, headword: &str, hanja: &str, context_key: Option<&str>) {
        if let Some(client) = self.shared.client.borrow().as_ref() {
            let _ = client.commit(headword, hanja, context_key, self.session().as_deref());
        }
    }

    /// 조합이 끝났다. 남은 후보를 버리고 창을 감춘다 — 다음 조합에 옛 후보가 보이면 안 된다.
    pub fn clear(&self) {
        self.dismiss();
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // 창을 없애면 `WM_NCDESTROY`에서 창이 쥔 `Rc`가 회수된다.
        unsafe {
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

// ------------------------------------------------------------------ 창

fn create_message_window(shared: Rc<Bridge>) -> Option<HWND> {
    register_class();

    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            CLASS_NAME,
            PCWSTR::null(),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            // 메시지 전용 창. 화면에 나타나지 않고 Z 순서에도 끼지 않으며,
            // 브로드캐스트 메시지도 받지 않는다 — 순수하게 우리 알림만 받는다.
            Some(HWND_MESSAGE),
            None,
            Some(crate::dll_instance().into()),
            None,
        )
    };

    let hwnd = match hwnd {
        Ok(h) => h,
        Err(e) => {
            log_line!("엔진 알림 창 생성 실패: 0x{:08X}", e.code().0);
            return None;
        }
    };

    // 창이 상태를 쥔다(참조 +1). `WM_NCDESTROY`에서 되돌려 받아 놓는다.
    //
    // `as _`로 두는 것은 게으름이 아니다. 32비트 윈도우에는 `SetWindowLongPtrW`가
    // 따로 없어 `SetWindowLongW`(인자 `i32`)로 이어지고, 64비트에서는 `isize`다.
    // 한쪽으로 못박으면 다른 비트수에서 컴파일이 깨진다 — 아래한글은 32비트라
    // 양쪽이 다 필요하다.
    let raw = Rc::into_raw(shared);
    unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, raw as _) };

    Some(hwnd)
}

fn register_class() {
    // 프로세스마다 한 번이면 된다. 이미 있으면 `RegisterClassW`가 0을 돌려주는데,
    // 그건 실패가 아니라 "이미 등록됨"이므로 그냥 넘어간다.
    let wc = WNDCLASSW {
        lpfnWndProc: Some(wnd_proc),
        hInstance: crate::dll_instance().into(),
        lpszClassName: CLASS_NAME,
        ..Default::default()
    };
    unsafe { RegisterClassW(&wc) };
}

/// DLL이 내려가기 직전에 창 클래스를 지운다.
///
/// **왜 필요한가.** 창 프로시저는 이 DLL 안의 함수 주소다. 클래스를 남긴 채 DLL이
/// 언로드되면 그 주소는 사라진 코드를 가리키고, 다음에 같은 클래스로 창이 만들어지는
/// 순간 죽는다. `DllCanUnloadNow`가 "내려도 좋다"고 답하는 시점은 살아 있는 객체가
/// 0인 때이므로 창도 없음이 보장된다 — 여기가 지울 수 있는 유일한 자리다.
pub fn unregister_class() {
    unsafe {
        let _ = UnregisterClassW(CLASS_NAME, Some(crate::dll_instance().into()));
    }
}

extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_JIEUM_ENGINE => {
            let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const Bridge;
            if !ptr.is_null() {
                // 빌리기만 한다 — 소유권은 여전히 창에 있다.
                let shared = unsafe { &*ptr };
                drain_events(shared);
            }
            LRESULT(0)
        }
        WM_NCDESTROY => {
            // 창이 쥐고 있던 참조를 회수한다. 이걸 빠뜨리면 상태가 영영 안 죽고,
            // 그 안의 `EngineClient`가 배경 스레드 둘을 계속 살려 둔다.
            let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *const Bridge;
            unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) };
            if !ptr.is_null() {
                drop(unsafe { Rc::from_raw(ptr) });
            }
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn drain_events(shared: &Bridge) {
    let events = match shared.client.borrow().as_ref() {
        Some(client) => client.drain(),
        None => return,
    };

    for event in events {
        match event {
            EngineEvent::Hello(reply) => {
                if reply.protocol_v != jieum_engine_client::PROTOCOL_VERSION {
                    // 조용히 넘어가면 나중에 이해 못 할 방식으로 어긋난다.
                    log_line!(
                        "프로토콜 불일치: 엔진 v{} ≠ 입력기 v{}",
                        reply.protocol_v,
                        jieum_engine_client::PROTOCOL_VERSION
                    );
                    continue;
                }
                log_line!(
                    "엔진 악수 완료: {} 사전지문={}",
                    reply.server_version,
                    reply.dict_fingerprint
                );
            }
            EngineEvent::Lookup(reply) => {
                if !shared.first_reply_logged.get() {
                    shared.first_reply_logged.set(true);
                    log_line!("첫 조회 응답 도착 (그룹 {}개)", reply.groups.len());
                }
                // ⚠️ 표제어·후보 내용은 남기지 않는다. 이 프로세스는 사용자가 치는 모든
                // 것을 본다 (계획서 §0 로그 위생). 남기는 것은 개수뿐이다.
                log_verbose!(
                    "조회 응답: 그룹 {}개, 후보 {}개",
                    reply.groups.len(),
                    reply.groups.iter().map(|g| g.candidates.len()).sum::<usize>()
                );
                let model = CandidateModel::from_groups(&to_groups(&reply));
                let empty = model.is_empty();
                *shared.model.borrow_mut() = model;
                // 새 후보가 왔으므로 사용자는 아직 아무것도 짚지 않은 상태다.
                shared.active.set(false);

                match (shared.caret.get(), empty) {
                    (_, true) => shared.ui.hide(),
                    (Some(caret), false) => {
                        shared
                            .ui
                            .show(caret, &shared.model.borrow(), shared.prefer_above())
                    }
                    // 캐럿을 모르면 띄우지 않는다. 자리를 모르는 후보 창은 방해만 된다.
                    (None, false) => log_verbose!("캐럿 위치를 몰라 후보 창을 띄우지 않는다"),
                }
            }
            EngineEvent::SessionOpen(id) => {
                shared.session_pending.set(false);
                *shared.session_id.borrow_mut() = Some(id);
            }
            EngineEvent::Failed {
                kind,
                code,
                message,
            } => {
                log_line!("엔진 오류 [{kind:?}] {code}: {message}");
            }
            EngineEvent::Disconnected => {
                log_line!("엔진 연결이 끊겼다 — 타이핑은 계속되고 제안만 멈춘다");
                *shared.model.borrow_mut() = CandidateModel::default();
                shared.ui.hide();
            }
        }
    }
}

/// 와이어 형식을 후보 모델의 입력 형식으로 옮긴다.
///
/// 두 형식을 따로 두는 이유: 후보 모델은 플랫폼도 프로토콜도 모르는 순수 로직이라
/// 리눅스에서 시험된다. 와이어 타입을 그대로 쓰면 그 시험이 윈도우에 묶인다.
fn to_groups(reply: &LookupReply) -> Vec<Group> {
    reply
        .groups
        .iter()
        .map(|g| Group {
            word: g.word.clone(),
            kind: GroupKind::from_wire(g.r#type.as_deref()),
            context_key: g.context_key.clone(),
            entries: g
                .candidates
                .iter()
                .map(|c| Entry {
                    hanja: c.hanja.clone(),
                    meaning: c.meaning.clone(),
                    user_word: c.source == "user",
                })
                .collect(),
        })
        .collect()
}
