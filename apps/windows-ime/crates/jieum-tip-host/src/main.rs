//! 지음 후보 창 프로세스.
//!
//! ## 왜 별도 프로세스인가 (계획서 W0, 2026-08-04 결정)
//!
//! TSF에는 시스템이 그려 주는 후보 창이 없다. 입력기가 직접 그려야 한다
//! (`ITfCandidateListUIElement`는 반대 방향이다 — 게임·스토어 앱이 자기가 그리겠다고
//! 나설 때 후보 데이터를 넘겨주는 통로다).
//!
//! 그런데 입력기는 **DLL**이라 사용자가 글을 쓰는 모든 프로그램 안으로 들어간다. 거기서
//! 창을 만들면 그 프로그램의 화면 배율 설정·테마·스레드 상태에 얽히고, 프로그램마다
//! 다르게 어긋난다. 그리기 코드에서 사고가 나면 아래한글이 통째로 죽는다.
//!
//! 살아 있는 선례 둘이 예외 없이 별도 프로세스다 — Chewing의 `chewing_tip_host`,
//! Mozc의 `mozc_renderer.exe`. 같은 결론에 도달했다.
//!
//! ## 이 프로세스는 종이다
//!
//! 상태를 갖지 않는다. 무엇이 선택됐는지·몇 쪽인지·키를 어떻게 처리할지는 전부 입력기가
//! 정하고, 여기로는 "이 모양으로 그려라"만 온다. 키는 입력기에만 도착하므로, 상태를
//! 나눠 가지면 화면과 키 처리가 어긋난다.

#![cfg(windows)]
// 콘솔 창이 뜨면 후보 창보다 그게 더 눈에 띈다. 진단은 파일로 남긴다.
#![windows_subsystem = "windows"]

mod window;

use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, TranslateMessage, MSG};

fn main() {
    // **별도 프로세스인 이점을 여기서 쓴다.** 입력기 DLL 안에서 창을 만들면 호스트 앱이
    // 선언한 배율 인식 수준을 그대로 물려받아, 옛 프로그램 안에서는 후보 창이 흐리거나
    // 자리가 어긋난다. 우리 프로세스는 우리가 정한다.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    log_line("후보 창 프로세스 시작");

    if window::find_existing().is_some() {
        // 이미 하나 떠 있다. 둘이 뜨면 후보가 두 군데 그려진다.
        log_line("이미 떠 있어 종료한다");
        return;
    }

    let Some(_hwnd) = window::create() else {
        log_line("창 생성 실패");
        return;
    };

    let mut msg = MSG::default();
    // `GetMessage`는 메시지가 올 때까지 잠든다 — 후보 창은 대부분의 시간 아무것도 하지
    // 않으므로 폴링하면 안 된다.
    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.as_bool() {
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    log_line("후보 창 프로세스 종료");
}

/// 진단 한 줄. 입력기와 같은 폴더에 쌓는다.
///
/// ⚠️ **후보 내용은 남기지 않는다.** 이 프로세스는 사용자가 무엇을 쓰려는지 다 본다
/// (계획서 §0 로그 위생). 남기는 것은 사건과 숫자뿐이다.
pub fn log_line(msg: &str) {
    use std::io::Write;
    let Some(base) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let dir = std::path::PathBuf::from(base).join("Jieum");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("host.log"))
    else {
        return;
    };
    let _ = writeln!(f, "[{}] {msg}", std::process::id());
}
