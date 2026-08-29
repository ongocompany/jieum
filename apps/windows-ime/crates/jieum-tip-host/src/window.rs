//! 후보 창 — 만들기, 명령 받기, 그리기.
//!
//! ## 명령은 공유 메모리로 온다 (2026-08-07에 바뀌었다)
//!
//! 전에는 `WM_COPYDATA`로 받았다. 그 방식은 보내는 쪽이 우리가 다 읽을 때까지 기다리는데,
//! 그 「보내는 쪽」이 입력기가 얹혀 있는 **호스트 앱의 입력 스레드**다. 경위는
//! `jieum_candidates::ui_channel`에 있다.
//!
//! 지금은 **이 프로세스가 통로를 만들고**(창보다 먼저 — 입력기는 창을 찾은 뒤에 통로를
//! 열기 때문이다), 입력기는 거기에 명령을 놓고 알림만 던진다.
//!
//! ## 가로 한 줄을 사용하는 이유
//!
//! 세로 9줄짜리 목록은 높이가 280px이었고, 그것이 두 가지 고장을 한꺼번에 일으켰다.
//!
//! 1. **앱의 자동완성을 덮는다.** 검색창에 한글을 치면 앱이 추천 목록을 입력칸 아래에
//!    그리는데, 후보 창이 정확히 같은 자리를 먹는다. 한글은 그 자체로 완결되므로 사용자가
//!    보려던 것은 대개 앱의 추천이지 한자가 아니다 — 묻지도 않고 덮은 셈이다.
//! 2. **커서에서 멀어 보인다.** 화면 아래쪽에서 타이핑하면 창이 커서 위로 뒤집히는데,
//!    280px 높이만큼 떨어지니 무관한 자리에 뜬 것처럼 보인다.
//!
//! 한자를 가로로 늘어놓고 훈(뜻)을 그 아래 루비로 붙이면 높이가 6분의 1로 준다. 중국어
//! 병음 입력기 다수(Sogou·微软拼音)가 이미 가로 한 줄을 기본으로 쓴다.
//!
//! 가로 목록에서는 `←/→`가 이전·다음 후보로 움직인다. 키 배정은 `jieum-tip`의
//! `text_service.rs`에 있다.

use std::cell::RefCell;

use jieum_candidates::ui_channel::{Channel, MAPPING_NAME, TOTAL_SIZE, WM_JIEUM_UI};
use jieum_candidates::ui_command::{CaretRect, Command, Row};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, COLORREF, HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreatePen, CreateSolidBrush, DeleteObject, EndPaint, GetDC,
    GetTextExtentPoint32W, GetTextMetricsW, InvalidateRect, MonitorFromPoint, ReleaseDC, RoundRect,
    SelectObject, SetBkMode, SetTextColor, TextOutW, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET,
    DEFAULT_PITCH, DEFAULT_QUALITY, FF_DONTCARE, FW_NORMAL, HBRUSH, HDC, HFONT, HPEN, MONITORINFO,
    MONITOR_DEFAULTTONEAREST, OUT_DEFAULT_PRECIS, PAINTSTRUCT, PS_DOT, PS_SOLID, TEXTMETRICW,
    TRANSPARENT,
};
use windows::Win32::Graphics::Gdi::GetMonitorInfoW;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_ALL_ACCESS,
    MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    KillTimer, SetTimer, WM_TIMER,
    CreateWindowExW, DefWindowProcW, FindWindowW, PostQuitMessage, RegisterClassW, SetWindowPos,
    ShowWindow, CW_USEDEFAULT, HWND_TOPMOST, SWP_NOACTIVATE, SW_HIDE, SW_SHOWNOACTIVATE,
    WM_DESTROY, WM_PAINT, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};
use windows_core::HSTRING;

use crate::log_line;

/// 입력기가 이 이름으로 창을 찾는다. **입력기 쪽 상수와 같아야 한다.**
pub const CLASS_NAME: PCWSTR = windows_core::w!("JieumCandidateHost");

/// 화면에 그릴 것. 이 프로세스가 가진 상태의 전부다.
#[derive(Default)]
struct View {
    rows: Vec<Row>,
    /// **보내진 줄들 중** 선택된 자리. 쪽 기준이 아니다.
    selected: usize,
    page: usize,
    total_pages: usize,
    expanded: bool,
    /// 계산해 둔 자리. `apply`가 창 크기를 정할 때와 `paint`가 그릴 때가 **같은 값을 봐야**
    /// 한다 — 따로 계산하면 반드시 어긋나 창이 내용을 자르거나 여백이 남는다.
    layout: Option<Layout>,
}

/// 앞에 무엇을 긋는가
#[derive(Clone, Copy, PartialEq)]
enum Divider {
    None,
    /// 표제어가 바뀐다 (발전소 → 발전). 실선
    Word,
    /// 표제어는 같고 층이 바뀐다 (현대어 → 고어·전문어). 점선
    Layer,
}

struct Cell {
    /// `View::rows`에서의 자리. 선택 표시는 이것으로 가른다
    index: usize,
    x: i32,
    y: i32,
    width: i32,
    divider: Divider,
    /// 이 칸 앞에 다시 쓸 표제어. 표제어가 바뀔 때와 맨 처음에만 있다
    word_label: Option<String>,
}

struct Layout {
    cells: Vec<Cell>,
    size: (i32, i32),
    /// 한 줄의 높이(한자층 + 루비층)와 한자층 높이. 그리기에서 다시 재지 않는다
    row_height: i32,
    top_height: i32,
}

thread_local! {
    static VIEW: RefCell<View> = RefCell::new(View::default());
    /// 입력기가 명령을 놓아 두는 통로. 창 프로시저가 여기서 꺼내 읽는다.
    static CHANNEL: RefCell<Option<SharedChannel>> = const { RefCell::new(None) };
}

/// 우리가 만들어 내놓는 공유 메모리.
///
/// 이 프로세스가 살아 있는 동안 유지된다 — 커널 객체는 마지막 핸들이 닫힐 때 사라지므로,
/// 우리가 쥐고 있는 것이 곧 "통로가 있다"는 보장이다.
struct SharedChannel {
    handle: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    channel: Channel,
}

impl SharedChannel {
    /// **창을 만들기 전에 부른다.** 입력기는 창을 찾은 다음에 통로를 열기 때문에, 순서가
    /// 뒤집히면 첫 후보들이 갈 곳을 잃는다.
    fn create() -> Option<Self> {
        let name = HSTRING::from(MAPPING_NAME);
        // `INVALID_HANDLE_VALUE`는 여기서 오류가 아니라 **"파일이 아니라 페이지 파일에
        // 기대라"**는 뜻이다. 디스크에 남기지 않는 익명 매핑이 된다.
        let handle = unsafe {
            CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                None,
                PAGE_READWRITE,
                0,
                TOTAL_SIZE as u32,
                &name,
            )
        }
        .ok()?;
        let view = unsafe { MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, TOTAL_SIZE) };
        if view.Value.is_null() {
            let _ = unsafe { CloseHandle(handle) };
            return None;
        }
        // SAFETY: 매핑이 TOTAL_SIZE 바이트이고 이 구조체가 사는 동안 유지된다.
        let channel = unsafe { Channel::new(view.Value as *mut u8) };
        // 새로 만든 공유 메모리는 0으로 채워져 있다. 표식을 적는 것이 곧 개시 신호다.
        channel.initialize();
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

// 96 DPI 기준 치수. 실제 그릴 때 배율을 곱한다. macOS 셸의 `CandidateListView`와 같은 값.
/// 모드 표시가 스스로 사라지기까지 (밀리초).
///
/// 눈에 걸리되 방해되지 않는 길이. macOS 셸의 `ModeIndicator`와 같은 값이다.
const MODE_VISIBLE_MS: u32 = 800;
const MODE_TIMER_ID: usize = 1;

const BASE_PADDING: i32 = 8;
const BASE_CELL_GAP: i32 = 11;
const BASE_RUBY_GAP: i32 = 1;
const BASE_DIVIDER_GAP: i32 = 8;
const BASE_NUMBER_GAP: i32 = 1;
const BASE_HANJA_SIZE: i32 = 17;
/// 루비와 번호. macOS는 9pt인데 윈도우 GDI에서 그 크기는 한글이 뭉개져서 한 단계 키웠다.
const BASE_RUBY_SIZE: i32 = 11;
const BASE_WORD_SIZE: i32 = 12;

pub fn find_existing() -> Option<HWND> {
    unsafe { FindWindowW(CLASS_NAME, PCWSTR::null()) }.ok()
}

pub fn create() -> Option<HWND> {
    let instance = unsafe { GetModuleHandleW(None) }.ok()?;

    let wc = WNDCLASSW {
        lpfnWndProc: Some(wnd_proc),
        hInstance: instance.into(),
        lpszClassName: CLASS_NAME,
        ..Default::default()
    };
    unsafe { RegisterClassW(&wc) };

    // 창보다 먼저다 — 입력기가 창을 찾는 순간 통로가 준비돼 있어야 한다.
    match SharedChannel::create() {
        Some(channel) => CHANNEL.with(|c| *c.borrow_mut() = Some(channel)),
        // 통로가 없으면 명령이 올 길이 없다. 창만 띄워 봐야 빈 껍데기다.
        None => {
            log_line("명령 통로를 만들지 못했다");
            return None;
        }
    }

    let hwnd = unsafe {
        CreateWindowExW(
            // NOACTIVATE: **이 창이 뜬다고 호스트 앱이 포커스를 잃으면 안 된다.**
            //   잃으면 타이핑이 끊기거나 후보 창으로 빨려 들어간다.
            // TOOLWINDOW: 작업 표시줄과 Alt+Tab 목록에 나타나지 않게 한다. 후보 창은
            //   '창'이 아니라 커서 옆 말풍선이다.
            // TOPMOST: 호스트 앱 위에 떠야 보인다.
            WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            CLASS_NAME,
            PCWSTR::null(),
            WS_POPUP, // 제목 표시줄·테두리 없음
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            240,
            48,
            None,
            None,
            Some(instance.into()),
            None,
        )
    }
    .ok()?;

    log_line("후보 창 생성");
    Some(hwnd)
}

extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_JIEUM_UI => {
            // 알림에는 순번만 실려 있다. 내용은 통로에서 꺼낸다.
            //
            // 꺼내지 못하면 그 사이 더 새로운 명령이 슬롯을 가져간 것이고, 그 알림이 이미
            // 큐에 있으므로 이번 것을 버려도 화면은 최신이 된다.
            let seq = wparam.0 as u32;
            let payload = CHANNEL.with(|c| c.borrow().as_ref().and_then(|ch| ch.channel.read(seq)));
            if let Some(bytes) = payload {
                if let Some(command) = Command::decode(&bytes) {
                    apply(hwnd, command);
                }
            }
            LRESULT(0)
        }
        WM_TIMER if wparam.0 == MODE_TIMER_ID => {
            unsafe {
                let _ = KillTimer(Some(hwnd), MODE_TIMER_ID);
            }
            hide(hwnd);
            LRESULT(0)
        }
        WM_PAINT => {
            paint(hwnd);
            LRESULT(0)
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn apply(hwnd: HWND, command: Command) {
    match command {
        Command::Show {
            caret,
            rows,
            selected,
            page,
            total_pages,
            expanded,
            prefer_above,
        } => {
            if rows.is_empty() {
                hide(hwnd);
                return;
            }
            let count = rows.len();
            // ⚠️ 후보 내용은 남기지 않는다 — 개수만.
            log_line(&format!("표시: {count}칸 (펼침 {expanded})"));

            let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
            let layout = compute_layout(hwnd, &rows, expanded, total_pages, page, dpi);
            let size = layout.size;

            VIEW.with(|v| {
                *v.borrow_mut() = View {
                    rows,
                    selected,
                    page,
                    total_pages,
                    expanded,
                    layout: Some(layout),
                }
            });

            let (x, y) = place(caret, size, prefer_above);

            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    x,
                    y,
                    size.0,
                    size.1,
                    // NOACTIVATE: 자리를 옮기는 것으로도 포커스를 뺏으면 안 된다.
                    SWP_NOACTIVATE,
                );
                // SW_SHOWNOACTIVATE — 보여 주되 활성화하지 않는다.
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                let _ = InvalidateRect(Some(hwnd), None, true);
            }
        }
        Command::Mode {
            caret,
            label,
            prefer_above,
        } => {
            // 모드는 **고를 수 있는 것이 아니다.** 번호를 0으로 두어 번호를 안 그리게 하고,
            // 한 줄짜리 후보와 같은 배치를 그대로 쓴다 — 같은 자리에 같은 모양으로 떠야
            // 사용자가 「같은 창이 말을 거는 것」으로 읽는다.
            log_line("모드 표시");
            let rows = vec![Row {
                hanja: label,
                meaning: None,
                header: None,
                word: String::new(),
                number: 0,
            }];
            let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
            let layout = compute_layout(hwnd, &rows, false, 1, 1, dpi);
            let size = layout.size;
            VIEW.with(|v| {
                *v.borrow_mut() = View {
                    rows,
                    selected: usize::MAX, // 아무것도 선택되지 않은 상태
                    page: 1,
                    total_pages: 1,
                    expanded: false,
                    layout: Some(layout),
                }
            });
            let (x, y) = place(caret, size, prefer_above);
            unsafe {
                let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, size.0, size.1, SWP_NOACTIVATE);
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                let _ = InvalidateRect(Some(hwnd), None, true);
                // 스스로 사라진다. 타이머를 여기(창 쪽)에 두는 것이 요점이다 —
                // 입력기가 재면 그 스레드가 타이핑 처리 중에 깨어나야 한다.
                SetTimer(Some(hwnd), MODE_TIMER_ID, MODE_VISIBLE_MS, None);
            }
        }
        Command::Hide => hide(hwnd),
        Command::Quit => {
            log_line("종료 명령 수신");
            unsafe { PostQuitMessage(0) };
        }
    }
}

fn hide(hwnd: HWND) {
    VIEW.with(|v| {
        let mut view = v.borrow_mut();
        view.rows.clear();
        view.layout = None;
    });
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
}

fn scale(value: i32, dpi: u32) -> i32 {
    value * dpi as i32 / 96
}

// ------------------------------------------------------------------ 자리 계산

/// 칸들의 자리를 한 번 계산한다. `apply`(창 크기)와 `paint`(그리기)가 이 결과를 나눠 쓴다.
///
/// macOS 셸의 `CandidateListView.currentLayout()`과 같은 알고리즘이다. 한 칸은 두 층 —
/// 위에 번호+한자, 아래에 훈을 루비로. 훈이 없는 후보(2글자 이상 한자)도 아래층 높이를
/// 차지한다. 칸마다 높이가 달라지면 한자들이 들쭉날쭉해 읽기 어렵다.
fn compute_layout(
    hwnd: HWND,
    rows: &[Row],
    expanded: bool,
    total_pages: usize,
    page: usize,
    dpi: u32,
) -> Layout {
    let fonts = Fonts::new(dpi);
    let dc = Measurer::new(hwnd);

    let padding = scale(BASE_PADDING, dpi);
    let cell_gap = scale(BASE_CELL_GAP, dpi);
    let ruby_gap = scale(BASE_RUBY_GAP, dpi).max(1);
    let divider_gap = scale(BASE_DIVIDER_GAP, dpi);
    let number_gap = scale(BASE_NUMBER_GAP, dpi).max(1);

    let top_height = dc.height(&fonts.hanja);
    let row_height = top_height + ruby_gap + dc.height(&fonts.ruby);

    let mut cells: Vec<Cell> = Vec::with_capacity(rows.len());
    let mut x = padding;
    let mut y = padding;
    let mut max_x = padding;
    let mut last_word: Option<String> = None;

    for (index, row) in rows.iter().enumerate() {
        // 펼친 상태에서 줄이 바뀌는 자리. 접힌 상태에서는 한 줄뿐이라 걸리지 않는다.
        if index > 0 && row.number == 1 {
            max_x = max_x.max(x - cell_gap);
            x = padding;
            y += row_height + ruby_gap * 2;
            last_word = None; // 새 줄에서는 표제어를 다시 보여 준다
        }

        let mut divider = Divider::None;
        let mut word_label = None;

        if last_word.is_none() {
            word_label = Some(row.word.clone());
        } else if row.header.is_some() {
            // 표제어까지 바뀌면 어느 글자에 대한 후보인지 다시 보여야 한다 —
            // "발전소"를 치다 "발"의 후보를 고르면 세 글자 중 하나만 바뀐다.
            if Some(&row.word) != last_word.as_ref() {
                divider = Divider::Word;
                word_label = Some(row.word.clone());
            } else {
                divider = Divider::Layer;
            }
        }
        last_word = Some(row.word.clone());

        if divider != Divider::None {
            x += divider_gap * 2;
        }
        if let Some(label) = &word_label {
            x += dc.width(label, &fonts.word) + cell_gap;
        }

        // 번호 0은 「번호 없음」이다 (모드 표시). 자리도 차지하지 않는다.
        let number_label = if row.number == 0 {
            String::new()
        } else {
            row.number.to_string()
        };
        let top_width = dc.width(&number_label, &fonts.number)
            + number_gap
            + dc.width(&row.hanja, &fonts.hanja);
        let ruby_width = row
            .meaning
            .as_ref()
            .map(|m| dc.width(m, &fonts.ruby))
            .unwrap_or(0);
        let width = top_width.max(ruby_width);

        cells.push(Cell {
            index,
            x,
            y,
            width,
            divider,
            word_label,
        });
        x += width + cell_gap;
    }

    // 접힌 상태에서만 쪽 표시를 위한 자리를 남긴다. 펼치면 전부 보이므로 필요 없다.
    if !expanded && total_pages > 1 {
        x += dc.width(&format!("{page}/{total_pages}"), &fonts.ruby);
    } else {
        x -= cell_gap;
    }
    max_x = max_x.max(x);

    Layout {
        cells,
        size: (max_x + padding, y + row_height + padding),
        row_height,
        top_height,
    }
}

/// 창을 놓을 자리.
///
/// 기본은 캐럿 **아래**다. 화면 아래로 넘치면 캐럿 위로 뒤집는다 — 화면 맨 아랫줄에서
/// 타이핑할 때 후보가 화면 밖으로 나가면 아무 소용이 없다. 좌우도 같은 이유로 화면 안으로
/// 당긴다. macOS 셸의 `CandidateWindow.origin`과 같은 규칙이다.
///
/// `prefer_above`면 위아래를 뒤집어 시작한다. 검색창처럼 앱의 자동완성이 입력칸 아래에
/// 뜨는 자리를 위한 것이고, **사용자가 `Shift+↑/↓`로 정해 앱별로 기억된다.** 기계가 가를
/// 신호가 없다는 것이 macOS에서 두 세션의 실측으로 확정됐다 — 재론 전 `Settings`의
/// `placements` 주석을 볼 것.
fn place(caret: CaretRect, size: (i32, i32), prefer_above: bool) -> (i32, i32) {
    let work = monitor_work_area(caret.left, caret.bottom);
    let gap = 4;

    let mut x = caret.left;
    let mut y;

    if prefer_above {
        y = caret.top - size.1 - gap;
        if y < work.top {
            y = caret.bottom + gap;
        }
    } else {
        y = caret.bottom + gap;
        if y + size.1 > work.bottom {
            y = caret.top - size.1 - gap;
        }
    }
    y = y.clamp(work.top, (work.bottom - size.1).max(work.top));

    if x + size.0 > work.right {
        x = work.right - size.0;
    }
    if x < work.left {
        x = work.left;
    }
    (x, y)
}

fn monitor_work_area(x: i32, y: i32) -> RECT {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let monitor = unsafe { MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST) };
    if unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        info.rcWork
    } else {
        RECT {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        }
    }
}

// ------------------------------------------------------------------ 글자 재기

/// 글자 크기를 재는 데만 쓰는 DC.
///
/// 자리 계산은 그리기 **전에** 끝나야 하므로(창 크기를 그때 정한다) `BeginPaint`의 DC를
/// 쓸 수 없다. 창의 DC를 잠깐 빌린다.
struct Measurer {
    hwnd: HWND,
    hdc: HDC,
}

impl Measurer {
    fn new(hwnd: HWND) -> Self {
        Self {
            hwnd,
            hdc: unsafe { GetDC(Some(hwnd)) },
        }
    }

    fn width(&self, text: &str, font: &Font) -> i32 {
        let wide: Vec<u16> = text.encode_utf16().collect();
        if wide.is_empty() {
            return 0;
        }
        let mut size = windows::Win32::Foundation::SIZE::default();
        unsafe {
            let old = SelectObject(self.hdc, font.0.into());
            let _ = GetTextExtentPoint32W(self.hdc, &wide, &mut size);
            SelectObject(self.hdc, old);
        }
        size.cx
    }

    /// 이 폰트로 글을 쓸 때 차지하는 줄 높이.
    fn height(&self, font: &Font) -> i32 {
        let mut tm = TEXTMETRICW::default();
        unsafe {
            let old = SelectObject(self.hdc, font.0.into());
            let _ = GetTextMetricsW(self.hdc, &mut tm);
            SelectObject(self.hdc, old);
        }
        tm.tmHeight
    }
}

impl Drop for Measurer {
    fn drop(&mut self) {
        unsafe {
            ReleaseDC(Some(self.hwnd), self.hdc);
        }
    }
}

// ------------------------------------------------------------------ 그리기

struct Font(HFONT);

impl Font {
    fn new(height: i32, dpi: u32) -> Self {
        let face = windows_core::w!("맑은 고딕");
        let hfont = unsafe {
            CreateFontW(
                -scale(height, dpi),
                0,
                0,
                0,
                FW_NORMAL.0 as i32,
                0,
                0,
                0,
                // 한자를 그려야 하므로 charset을 좁히면 안 된다.
                DEFAULT_CHARSET,
                OUT_DEFAULT_PRECIS,
                CLIP_DEFAULT_PRECIS,
                DEFAULT_QUALITY,
                (DEFAULT_PITCH.0 | FF_DONTCARE.0) as u32,
                face,
            )
        };
        Self(hfont)
    }
}

impl Drop for Font {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.0.into());
        }
    }
}

/// 한 번 그리는 동안 쓰는 폰트 넷.
struct Fonts {
    hanja: Font,
    ruby: Font,
    number: Font,
    word: Font,
}

impl Fonts {
    fn new(dpi: u32) -> Self {
        Self {
            hanja: Font::new(BASE_HANJA_SIZE, dpi),
            ruby: Font::new(BASE_RUBY_SIZE, dpi),
            number: Font::new(BASE_RUBY_SIZE, dpi),
            word: Font::new(BASE_WORD_SIZE, dpi),
        }
    }
}

struct Brush(HBRUSH);

impl Brush {
    fn new(color: u32) -> Self {
        Self(unsafe { CreateSolidBrush(COLORREF(color)) })
    }
}

impl Drop for Brush {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.0.into());
        }
    }
}

struct Pen(HPEN);

impl Pen {
    fn new(style: windows::Win32::Graphics::Gdi::PEN_STYLE, color: u32) -> Self {
        Self(unsafe { CreatePen(style, 1, COLORREF(color)) })
    }
}

impl Drop for Pen {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.0.into());
        }
    }
}

/// 색은 COLORREF(0x00BBGGRR)다 — 흔히 쓰는 RGB 순서의 반대다.
const COLOR_BG: u32 = 0x00FFFFFF;
const COLOR_BORDER: u32 = 0x00C8C8C8;
const COLOR_TEXT: u32 = 0x00202020;
const COLOR_DIM: u32 = 0x00808080;
const COLOR_SELECT_BG: u32 = 0x00E8792D; // 파란 강조 (BGR이라 값이 뒤집혀 보인다)
const COLOR_SELECT_TEXT: u32 = 0x00FFFFFF;

fn paint(hwnd: HWND) {
    let mut ps = PAINTSTRUCT::default();
    let hdc = unsafe { BeginPaint(hwnd, &mut ps) };
    if hdc.is_invalid() {
        return;
    }

    let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96);
    let mut client = RECT::default();
    let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut client) };

    let fonts = Fonts::new(dpi);
    let padding = scale(BASE_PADDING, dpi);
    let cell_gap = scale(BASE_CELL_GAP, dpi);
    let ruby_gap = scale(BASE_RUBY_GAP, dpi).max(1);
    let divider_gap = scale(BASE_DIVIDER_GAP, dpi);
    let number_gap = scale(BASE_NUMBER_GAP, dpi).max(1);
    let radius = scale(6, dpi);

    // 배경 — 둥근 모서리로 커서 옆 말풍선처럼 보이게 한다
    {
        let bg = Brush::new(COLOR_BG);
        let border = Pen::new(PS_SOLID, COLOR_BORDER);
        unsafe {
            let old_brush = SelectObject(hdc, bg.0.into());
            let old_pen = SelectObject(hdc, border.0.into());
            let _ = RoundRect(hdc, 0, 0, client.right, client.bottom, radius, radius);
            SelectObject(hdc, old_brush);
            SelectObject(hdc, old_pen);
        }
    }
    unsafe { SetBkMode(hdc, TRANSPARENT) };

    VIEW.with(|v| {
        let view = v.borrow();
        let Some(layout) = view.layout.as_ref() else {
            return;
        };
        let top_height = layout.top_height;

        for cell in &layout.cells {
            let Some(row) = view.rows.get(cell.index) else {
                continue;
            };
            let ruby_y = cell.y + top_height + ruby_gap;

            if cell.divider != Divider::None {
                let label_width = cell
                    .word_label
                    .as_ref()
                    .map(|l| measure_with(hdc, l, &fonts.word) + cell_gap)
                    .unwrap_or(0);
                draw_divider(
                    hdc,
                    cell.divider,
                    cell.x - label_width - divider_gap,
                    cell.y,
                    layout.row_height,
                );
            }

            if let Some(label) = &cell.word_label {
                let width = measure_with(hdc, label, &fonts.word);
                draw_text(
                    hdc,
                    label,
                    &fonts.word,
                    cell.x - width - cell_gap,
                    cell.y + scale(4, dpi),
                    COLOR_DIM,
                );
            }

            // ⚠️ **보내진 것 기준으로** 가른다. 펼친 상태에서는 줄마다 번호가 1~9로
            //    되풀이되므로 번호로 비교하면 모든 줄의 같은 번호가 선택돼 보인다.
            let selected = cell.index == view.selected;
            if selected {
                let brush = Brush::new(COLOR_SELECT_BG);
                let pen = Pen::new(PS_SOLID, COLOR_SELECT_BG);
                unsafe {
                    let old_brush = SelectObject(hdc, brush.0.into());
                    let old_pen = SelectObject(hdc, pen.0.into());
                    let _ = RoundRect(
                        hdc,
                        cell.x - scale(4, dpi),
                        cell.y - scale(3, dpi),
                        cell.x + cell.width + scale(4, dpi),
                        cell.y + layout.row_height + scale(3, dpi),
                        scale(4, dpi),
                        scale(4, dpi),
                    );
                    SelectObject(hdc, old_brush);
                    SelectObject(hdc, old_pen);
                }
            }

            let primary = if selected { COLOR_SELECT_TEXT } else { COLOR_TEXT };
            let secondary = if selected { COLOR_SELECT_TEXT } else { COLOR_DIM };

            // 위층: 번호 + 한자. 번호는 작게 앞에 붙여 폭을 아낀다
            let number_text = if row.number == 0 {
                String::new()
            } else {
                row.number.to_string()
            };
            let number_width = measure_with(hdc, &number_text, &fonts.number);
            if !number_text.is_empty() {
                draw_text(
                    hdc,
                    &number_text,
                    &fonts.number,
                    cell.x,
                    cell.y + (top_height - measure_height(hdc, &fonts.number)),
                    secondary,
                );
            }
            draw_text(
                hdc,
                &row.hanja,
                &fonts.hanja,
                cell.x + number_width + number_gap,
                cell.y,
                primary,
            );

            // 아래층: 훈(뜻)을 루비로. 칸 폭에 가운데 맞춤
            if let Some(meaning) = &row.meaning {
                let width = measure_with(hdc, meaning, &fonts.ruby);
                draw_text(
                    hdc,
                    meaning,
                    &fonts.ruby,
                    cell.x + (cell.width - width) / 2,
                    ruby_y,
                    secondary,
                );
            }
        }

        if !view.expanded && view.total_pages > 1 {
            let text = format!("{}/{}", view.page, view.total_pages);
            let width = measure_with(hdc, &text, &fonts.ruby);
            draw_text(
                hdc,
                &text,
                &fonts.ruby,
                client.right - padding - width,
                padding + top_height + ruby_gap,
                COLOR_DIM,
            );
        }
    });

    unsafe {
        let _ = EndPaint(hwnd, &ps);
    }
}

/// 그룹 경계. 표제어가 바뀌면 실선, 층만 바뀌면 점선
fn draw_divider(hdc: HDC, kind: Divider, x: i32, y: i32, height: i32) {
    let style = if kind == Divider::Layer { PS_DOT } else { PS_SOLID };
    let pen = Pen::new(style, COLOR_BORDER);
    unsafe {
        let old = SelectObject(hdc, pen.0.into());
        let _ = windows::Win32::Graphics::Gdi::MoveToEx(hdc, x, y, None);
        let _ = windows::Win32::Graphics::Gdi::LineTo(hdc, x, y + height);
        SelectObject(hdc, old);
    }
}

fn measure_with(hdc: HDC, text: &str, font: &Font) -> i32 {
    let wide: Vec<u16> = text.encode_utf16().collect();
    if wide.is_empty() {
        return 0;
    }
    let mut size = windows::Win32::Foundation::SIZE::default();
    unsafe {
        let old = SelectObject(hdc, font.0.into());
        let _ = GetTextExtentPoint32W(hdc, &wide, &mut size);
        SelectObject(hdc, old);
    }
    size.cx
}

fn measure_height(hdc: HDC, font: &Font) -> i32 {
    let mut tm = TEXTMETRICW::default();
    unsafe {
        let old = SelectObject(hdc, font.0.into());
        let _ = GetTextMetricsW(hdc, &mut tm);
        SelectObject(hdc, old);
    }
    tm.tmHeight
}

fn draw_text(hdc: HDC, text: &str, font: &Font, x: i32, y: i32, color: u32) {
    let wide: Vec<u16> = text.encode_utf16().collect();
    if wide.is_empty() {
        return;
    }
    unsafe {
        let old = SelectObject(hdc, font.0.into());
        SetTextColor(hdc, COLORREF(color));
        let _ = TextOutW(hdc, x, y, &wide);
        SelectObject(hdc, old);
    }
}
