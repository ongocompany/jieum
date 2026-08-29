//! 후보 창 조종 — 별도 프로세스에 "이 모양으로 그려라"를 보낸다.
//!
//! 그리기는 `jieum-tip-host.exe`가 한다. 왜 그 프로세스가 따로 있는지는 그쪽 주석에
//! 있다. 여기서는 **입력 경로가 그 프로세스 때문에 멈추지 않게 하는 것**이 핵심이다.
//!
//! ## ⭐ 기다리지 않는다 (2026-08-07)
//!
//! 전에는 `WM_COPYDATA`를 `SendMessageTimeout`으로 보냈다. 그러면 **받는 쪽이 다 읽을
//! 때까지 보내는 쪽이 기다린다.** 입력기는 DLL이라 그 「보내는 쪽」이 곧 호스트 앱의
//! 입력 스레드다 — 남의 앱의 타이핑이 우리 후보 창의 상태에 묶여 있었다.
//!
//! 지금은 명령을 공유 메모리에 놓고 `PostMessage`로 알리기만 한다. `WM_COPYDATA`를 못
//! 미루던 이유(보낸 쪽 버퍼가 읽힐 때까지 살아 있어야 한다)가 공유 메모리에서는 사라진다
//! — 수명을 커널이 쥐기 때문이다. 형식은 `jieum_candidates::ui_channel`에 있고 후보 창
//! 쪽도 같은 것을 본다.
//!
//! ⛔ **다시 동기 전송으로 돌아가지 말 것.** `SMTO_BLOCK`도 시도했고 소용없었다 — 그
//! 플래그가 막는 것은 "남이 우리 스레드에 보낸 메시지"뿐이고 프로세스 경계를 넘는 대기
//! 자체는 그대로 남는다.
//!
//! ⛔ **잠금으로 슬롯을 지키지도 말 것.** 후보 창이 멎은 채 잠금을 쥐면 고치려던 것이
//! 그대로 돌아온다. 통로에 기다리는 지점이 하나도 없는 것이 설계의 요점이다.
//!
//! ## ⛔ 이것은 아래한글 조합 끊김의 원인이 **아니었다** (2026-08-07 실측)
//!
//! 이 전환은 그 결함을 고치려고 한 것이고, 하나 앞선 기록은 "원인은 우리 후보 창"이라고
//! 단정했다. **틀렸다.** 동기 전송을 없앤 뒤에도 아래한글에서는 `ㅎ하한핝한자`가 그대로
//! 나온다.
//!
//! 뒤집은 근거는 **엔진과 후보 창을 둘 다 끈 채로 친 것**이다. 조회도 후보도 없으니 이
//! 파일의 코드는 한 줄도 돌지 않는데 글자는 똑같이 쌓였다
//! `[근거: 엔진·후보 창 프로세스 종료 후 verify-in-app.ps1 -App hwp → 'ㅎ하한핝한자1']`
//!
//! 앞선 판정이 틀렸던 이유는 **엔진과 후보 창을 함께 껐기 때문**이다. 그러면 둘 중
//! 어느 것이 원인인지 갈리지 않고, 실제로는 **둘 다 아니었다.** 하나씩 빼야 갈린다.
//!
//! 남은 결함의 자리는 조합 처리 자체다 — `composition.rs`의 머리말을 볼 것.

use std::cell::{Cell, RefCell};

use jieum_candidates::ui_channel::{Channel, MAPPING_NAME, TOTAL_SIZE, WM_JIEUM_UI};
use jieum_candidates::ui_command::{CaretRect, Command, Row};
use jieum_candidates::CandidateModel;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, WPARAM};
use windows::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_ALL_ACCESS,
    MEMORY_MAPPED_VIEW_ADDRESS,
};
use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, IsWindow, PostMessageW};
use windows_core::HSTRING;

use crate::{log_line, log_verbose};

/// 후보 창 프로세스의 창 클래스. **`jieum-tip-host` 쪽 상수와 같아야 한다.**
const HOST_CLASS: PCWSTR = windows_core::w!("JieumCandidateHost");

const HOST_EXE: &str = "jieum-tip-host.exe";

/// 후보 창이 만들어 둔 공유 메모리에 붙은 상태.
///
/// **여는 쪽이지 만드는 쪽이 아니다.** 후보 창이 창을 만들기 전에 통로를 준비하므로,
/// 창을 찾았다는 것은 통로가 이미 있다는 뜻이다.
struct SharedChannel {
    handle: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    channel: Channel,
}

impl SharedChannel {
    fn open() -> Option<Self> {
        let name = HSTRING::from(MAPPING_NAME);
        let handle = unsafe { OpenFileMappingW(FILE_MAP_ALL_ACCESS.0, false, &name) }.ok()?;
        let view = unsafe { MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, TOTAL_SIZE) };
        if view.Value.is_null() {
            let _ = unsafe { CloseHandle(handle) };
            return None;
        }
        // SAFETY: 매핑이 TOTAL_SIZE 바이트이고, `view`는 이 구조체가 사는 동안 유지된다.
        let channel = unsafe { Channel::new(view.Value as *mut u8) };
        if !channel.is_ready() {
            // 후보 창이 아직 표식을 적지 않았거나 판이 다르다. 다음 키에서 다시 연다.
            let _ = unsafe { UnmapViewOfFile(view) };
            let _ = unsafe { CloseHandle(handle) };
            return None;
        }
        Some(Self {
            handle,
            view,
            channel,
        })
    }
}

impl Drop for SharedChannel {
    fn drop(&mut self) {
        unsafe {
            let _ = UnmapViewOfFile(self.view);
            let _ = CloseHandle(self.handle);
        }
    }
}

pub struct CandidateUi {
    /// 찾아 둔 창. 매번 `FindWindow`를 부르면 키마다 창 목록을 훑게 된다.
    hwnd: Cell<isize>,
    /// 띄우기를 이미 시도했는가. 실패를 매 키마다 반복하지 않는다.
    spawn_attempted: Cell<bool>,
    /// 명령을 놓아 두는 공유 메모리. 창을 찾은 뒤에 연다.
    channel: RefCell<Option<SharedChannel>>,
}

impl CandidateUi {
    pub fn new() -> Self {
        Self {
            hwnd: Cell::new(0),
            spawn_attempted: Cell::new(false),
            channel: RefCell::new(None),
        }
    }

    /// 후보 창 프로세스를 미리 띄워 둔다.
    ///
    /// **입력기가 켜질 때 부른다.** 첫 조회가 올 때까지 기다리면 늦는다 — 프로세스가
    /// 뜨는 데 걸리는 시간 동안 표시 명령은 갈 곳이 없고, 입력 경로에서 기다릴 수는
    /// 없으므로(기다리면 그만큼 타이핑이 멈춘다) 그 조회분은 그냥 화면에 못 나온다.
    /// 사용자에게는 "첫 단어만 후보가 안 뜬다"로 보인다.
    pub fn warm_up(&self) {
        let _ = self.window();
    }

    /// 창을 찾는다. 없으면 프로세스를 띄우되 **기다리지 않는다** —
    /// 이번 표시는 건너뛰고 다음 키에서 잡힌다. 입력 경로에서 프로세스가 뜨기를
    /// 기다리면 그 시간만큼 타이핑이 멈춘다.
    fn window(&self) -> Option<HWND> {
        let cached = self.hwnd.get();
        if cached != 0 {
            let hwnd = HWND(cached as *mut std::ffi::c_void);
            if unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                return Some(hwnd);
            }
            // 프로세스가 죽었다. 다시 찾고, 필요하면 다시 띄운다.
            // **통로도 함께 버린다** — 새로 뜬 후보 창은 자기 통로를 새로 준비한다.
            self.forget();
        }

        if let Ok(hwnd) = unsafe { FindWindowW(HOST_CLASS, PCWSTR::null()) } {
            self.hwnd.set(hwnd.0 as isize);
            return Some(hwnd);
        }

        if !self.spawn_attempted.get() {
            self.spawn_attempted.set(true);
            self.spawn();
        }
        None
    }

    fn spawn(&self) {
        let Some(dir) = crate::hangul::module_dir() else {
            log_line!("후보 창 프로세스 경로를 알 수 없다");
            return;
        };
        let exe = format!("{dir}\\{HOST_EXE}");
        match std::process::Command::new(&exe).spawn() {
            Ok(_child) => log_line!("후보 창 프로세스 시작 요청"),
            // 없어도 입력은 계속돼야 한다. 잃는 것은 후보 표시뿐이다.
            Err(e) => log_line!("후보 창 프로세스를 띄우지 못했다: {e}"),
        }
    }

    /// `prefer_above`는 사용자가 이 앱에서 정해 둔 자리다 (`Shift+↑/↓`, `settings.rs`).
    pub fn show(&self, caret: CaretRect, model: &CandidateModel, prefer_above: bool) {
        if model.is_empty() {
            self.hide();
            return;
        }
        // 번호는 **입력기가 계산해 실어 보낸다.** 후보 창이 자리로 되짚으면 펼친 상태에서
        // 어긋난다 — 번호는 줄마다 1부터 다시 세기 때문이다.
        let rows: Vec<Row> = model
            .visible_items()
            .iter()
            .zip(model.visible_numbers())
            .map(|(item, number)| Row {
                hanja: item.hanja.clone(),
                meaning: item.meaning.clone(),
                header: item.group_header.clone(),
                word: item.word.clone(),
                number,
            })
            .collect();

        self.send(&Command::Show {
            caret,
            rows,
            selected: model.selected_in_view(),
            page: model.current_page() + 1,
            total_pages: model.total_pages(),
            expanded: model.is_expanded(),
            prefer_above,
        });
    }

    /// 모드가 바뀐 것을 커서 옆에 잠깐 보여 준다.
    ///
    /// 사라지는 것은 창이 스스로 한다 — 타이머를 입력기에 두면 그 스레드가 타이핑을
    /// 처리하는 도중에 깨어나야 한다.
    pub fn show_mode(&self, label: &str, caret: CaretRect, prefer_above: bool) {
        self.send(&Command::Mode {
            caret,
            label: label.to_string(),
            prefer_above,
        });
    }

    pub fn hide(&self) {
        // 창이 아직 없으면 감출 것도 없다. 여기서 프로세스를 띄우면 후보가 한 번도
        // 안 뜬 상태에서 감추기만으로 프로세스가 생긴다.
        if self.hwnd.get() == 0 {
            return;
        }
        self.send(&Command::Hide);
    }

    /// 찾아 둔 창과 통로를 버린다. 다음 명령에서 처음부터 다시 잡는다.
    fn forget(&self) {
        self.hwnd.set(0);
        self.spawn_attempted.set(false);
        *self.channel.borrow_mut() = None;
    }

    /// ⭐ **이 함수는 기다리지 않는다.** 파일 머리말의 경위를 먼저 읽을 것.
    fn send(&self, command: &Command) {
        // `window()`가 통로를 버릴 수 있으므로 빌리기 전에 부른다.
        let Some(hwnd) = self.window() else { return };
        let bytes = command.encode();
        if bytes.is_empty() {
            return;
        }

        let mut slot = self.channel.borrow_mut();
        if slot.is_none() {
            *slot = SharedChannel::open();
        }
        let Some(shared) = slot.as_ref() else {
            log_verbose!("후보 창 통로를 열지 못했다");
            return;
        };

        let Some(seq) = shared.channel.publish(&bytes) else {
            // 명령이 슬롯보다 크다. 후보가 이번 한 번 안 뜰 뿐이지만 설계 문제이므로
            // 조용히 넘기지 않는다.
            log_line!("후보 창 통로에 명령을 놓지 못했다 ({}바이트)", bytes.len());
            return;
        };

        // 던지고 즉시 돌아온다. 후보 창이 멎어 있어도 타이핑은 계속된다 (D6).
        if unsafe { PostMessageW(Some(hwnd), WM_JIEUM_UI, WPARAM(seq as usize), LPARAM(0)) }.is_err()
        {
            // 창이 사라졌거나 상대 메시지 큐가 가득 찼다. 다음 번에 다시 잡는다.
            log_verbose!("후보 창에 알리지 못했다");
            drop(slot);
            self.forget();
        }
    }
}

impl Drop for CandidateUi {
    fn drop(&mut self) {
        // **감추기만 한다. 끝내지 않는다.**
        //
        // 입력기 객체는 앱마다·스레드마다 생기고 사라진다. 그중 하나가 내려갈 때 후보 창
        // 프로세스를 끝내면 메모장을 닫는 순간 아래한글에서 쓰던 후보 창까지 죽는다.
        // 후보 창은 여럿이 함께 쓰는 자원이므로 개별 입력기가 수명을 정하면 안 된다.
        // (`Command::Quit`은 설치 스크립트가 새 실행 파일로 갈아 끼울 때 쓴다)
        self.hide();
    }
}
