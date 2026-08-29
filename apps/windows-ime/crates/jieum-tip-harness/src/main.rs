//! 지음 TSF 입력기 시험 장치.
//!
//! **왜 있는가.** 입력기를 확인하려면 보통 사람이 앱을 열고 입력 소스를 바꾸고 타이핑해
//! 화면을 봐야 한다. 그런데 TSF에서는 `ITfThreadMgr`를 아무 프로세스에서나 직접 만들 수
//! 있고, 그러면 TSF가 우리 DLL을 실제로 적재하고 `ActivateEx`까지 부른다. 즉 화면 없이
//! 기계적으로 검증할 수 있다. macOS의 IMK는 앱 경계에 묶여 이게 안 됐다.
//!
//! **무엇을 증명하는가.**
//! - 레지스트리 등록이 실제로 TSF에 읽힌다 (읽히지 않으면 CoCreateInstance부터 실패)
//! - DLL이 남의 프로세스에 적재된다
//! - 클래스 팩토리가 객체를 만든다
//! - `ActivateEx`가 불리고 `ITfThreadMgr`·client id가 전달된다
//!
//! **무엇을 증명하지 못하는가.** 실제 앱의 텍스트 저장소 동작, 후보 창 표시, 앱별 호환.
//! 그건 여전히 실제 앱에서 봐야 한다.

use windows::Win32::Foundation::E_FAIL;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, PeekMessageW, RegisterClassW,
    SetForegroundWindow, ShowWindow, TranslateMessage, CW_USEDEFAULT, MSG, PM_REMOVE, SW_SHOW,
    WINDOW_EX_STYLE, WNDCLASSW, WS_OVERLAPPEDWINDOW,
};
mod text_store;

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::TextServices::{
    ITfDocumentMgr, ITfInputProcessorProfileMgr, ITfInputProcessorProfiles, ITfKeystrokeMgr,
    ITfThreadMgr,
    CLSID_TF_InputProcessorProfiles, CLSID_TF_ThreadMgr, TF_IPPMF_ENABLEPROFILE,
    TF_IPPMF_FORSESSION, TF_PROFILETYPE_INPUTPROCESSOR,
};
use windows_core::{Interface, GUID, Result};

const CLSID_JIEUM_TIP: GUID = GUID::from_u128(0x7bae2d1e_e156_4329_b243_f9f7224deda2);
const GUID_JIEUM_PROFILE: GUID = GUID::from_u128(0x9312b5d2_7323_4f3e_987b_23ed785a2952);
const LANGID_KO_KR: u16 = 0x0412;

fn main() {
    // `engine` 인자를 주면 엔진 왕복만 따로 본다. 입력기를 거치지 않으므로, 조회가
    // 안 될 때 "클라이언트가 틀렸나 / TIP이 안 부르나"를 가를 수 있다.
    if std::env::args().nth(1).as_deref() == Some("engine") {
        std::process::exit(engine_check::run());
    }

    // 조회 진단을 켠다. TIP은 이 프로세스 안에 적재되므로 환경변수를 상속한다.
    // 실사용에서는 이 변수가 없고, 그때는 키 단위 기록이 남지 않는다.
    std::env::set_var("JIEUM_TIP_VERBOSE", "1");

    // 입력기는 스레드 친화(apartment) 모델이다. 여기서 MTA로 초기화하면 실제 환경과
    // 달라지고, 그 차이가 나중에 재현 안 되는 문제로 돌아온다.
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }.expect("CoInitializeEx 실패");

    let code = match run() {
        Ok(()) => {
            println!("HARNESS_OK");
            0
        }
        Err(e) => {
            println!("HARNESS_FAIL: {e:?}");
            1
        }
    };

    unsafe { CoUninitialize() };
    std::process::exit(code);
}

/// TIP이 남긴 진단 로그를 읽는다.
///
/// **왜 로그로 확인하는가.** 입력기는 COM 경계 너머에 있어 시험 장치가 그 내부 상태를
/// 들여다볼 방법이 없다. 조회가 실제로 나갔는지·후보가 도착했는지는 입력기 자신만 안다.
/// 진단용 인터페이스를 새로 뚫는 것보다, 이미 있는 로그를 읽는 편이 검증을 위해 제품
/// 코드를 늘리지 않는다.
mod tip_log {
    use std::io::{Read, Seek, SeekFrom};
    use std::path::PathBuf;

    pub fn path() -> Option<PathBuf> {
        let base = std::env::var_os("LOCALAPPDATA")?;
        Some(PathBuf::from(base).join("Jieum").join("tip.log"))
    }

    /// 지금 크기. 이 뒤에 붙는 것만이 이번 실행의 기록이다.
    pub fn mark() -> u64 {
        path()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0)
    }

    /// `mark` 이후에 붙은 부분.
    pub fn since(mark: u64) -> String {
        let Some(path) = path() else {
            return String::new();
        };
        let Ok(mut f) = std::fs::File::open(path) else {
            return String::new();
        };
        if f.seek(SeekFrom::Start(mark)).is_err() {
            return String::new();
        }
        let mut buf = Vec::new();
        let _ = f.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    }
}

/// 엔진 왕복만 확인한다 — 입력기를 거치지 않는다.
mod engine_check {
    use jieum_engine_client::{EngineClient, EngineEvent, DEFAULT_PIPE_NAME};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    pub fn run() -> i32 {
        let woke = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&woke);

        let client = match EngineClient::connect(DEFAULT_PIPE_NAME, move || {
            flag.store(true, Ordering::SeqCst);
        }) {
            Ok(c) => c,
            Err(e) => {
                println!("ENGINE_FAIL: 파이프 연결 실패 — {e}");
                return 1;
            }
        };
        println!("1. 파이프 연결: {DEFAULT_PIPE_NAME}");

        if let Err(e) = client.hello("jieum-tip-harness") {
            println!("ENGINE_FAIL: hello 전송 실패 — {e}");
            return 1;
        }

        let mut greeted = false;
        let mut groups = 0usize;
        let mut candidates = 0usize;
        let mut sample = String::new();
        let deadline = Instant::now() + Duration::from_secs(5);

        while Instant::now() < deadline {
            for event in client.drain() {
                match event {
                    EngineEvent::Hello(reply) => {
                        println!(
                            "2. 악수: {} 프로토콜 v{} 사전지문 {}",
                            reply.server_version, reply.protocol_v, reply.dict_fingerprint
                        );
                        greeted = true;
                        // 시험 장치는 사용자 환경이 아니므로 내용을 봐도 된다.
                        // "한자"는 사전에 반드시 있는 말이라 0건이면 그 자체가 결함이다.
                        if let Err(e) = client.lookup("한자", None, None) {
                            println!("ENGINE_FAIL: lookup 전송 실패 — {e}");
                            return 1;
                        }
                        println!("3. 조회 요청: \"한자\"");
                    }
                    EngineEvent::Lookup(reply) => {
                        groups = reply.groups.len();
                        candidates = reply.groups.iter().map(|g| g.candidates.len()).sum();
                        sample = reply
                            .groups
                            .first()
                            .and_then(|g| g.candidates.first())
                            .map(|c| c.hanja.clone())
                            .unwrap_or_default();
                        println!(
                            "4. 조회 응답: 토큰={} 그룹 {groups}개 후보 {candidates}개 첫 후보={sample:?}",
                            reply.token
                        );
                    }
                    EngineEvent::Failed {
                        kind,
                        code,
                        message,
                    } => {
                        println!("ENGINE_FAIL: [{kind:?}] {code}: {message}");
                        return 1;
                    }
                    EngineEvent::Disconnected => {
                        println!("ENGINE_FAIL: 연결이 끊겼다");
                        return 1;
                    }
                    EngineEvent::SessionOpen(_) => {}
                }
            }
            if greeted && groups > 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = woke;

        if !greeted {
            println!("ENGINE_FAIL: 악수 응답이 오지 않았다");
            return 1;
        }
        if groups == 0 || candidates == 0 {
            println!("ENGINE_FAIL: \"한자\"에 후보가 없다 — 사전이 비었거나 조회가 깨졌다");
            return 1;
        }
        if sample != "漢字" {
            // 랭킹이 바뀌면 1등이 달라질 수 있으므로 실패로 보지 않는다. 다만
            // 눈에 띄게 남겨서 사전이 바뀐 것을 놓치지 않게 한다.
            println!("   (주의: 첫 후보가 漢字가 아니다 — 사전이나 랭킹이 바뀌었다)");
        }
        println!("ENGINE_OK");
        0
    }
}

/// 지정한 시간 동안 창 메시지를 처리한다.
///
/// TSF의 입력기 적재·활성화는 창 메시지를 타고 온다. 콘솔 프로세스에는 메시지 큐가
/// 아예 없다가 `PeekMessage`를 처음 부르는 순간 생긴다. 이걸 안 돌리면 프로파일은
/// 활성으로 바뀌는데 DLL은 적재되지 않아, 겉보기엔 성공인데 아무 일도 안 일어난다.
fn pump_messages(duration: std::time::Duration) {
    let deadline = std::time::Instant::now() + duration;
    let mut msg = MSG::default();
    while std::time::Instant::now() < deadline {
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// 눈에 보이는 창을 하나 만든다.
///
/// TSF는 키를 포그라운드 스레드로 보낸다. 창이 없는 콘솔 프로세스는 그 판단에서
/// 빠지므로, 실제 앱과 같은 조건을 만들려면 창이 있어야 한다. 텍스트 저장소의
/// `GetWnd`도 이 창을 돌려준다.
fn create_window() -> Result<HWND> {
    let instance = unsafe { GetModuleHandleW(None)? };
    let class_name = windows_core::w!("JieumHarnessWindow");

    let wc = WNDCLASSW {
        lpfnWndProc: Some(wnd_proc),
        hInstance: instance.into(),
        lpszClassName: class_name,
        ..Default::default()
    };
    unsafe { RegisterClassW(&wc) };

    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class_name,
            windows_core::w!("지음 시험 장치"),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            480,
            240,
            None,
            None,
            Some(instance.into()),
            None,
        )?
    };
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
    }
    Ok(hwnd)
}

extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn fmt(r: &Result<windows_core::BOOL>) -> String {
    match r {
        Ok(b) => format!("{}", b.as_bool()),
        Err(e) => format!("오류 0x{:08X}", e.code().0),
    }
}

fn run() -> Result<()> {
    // TIP이 적재되기 전에 찍는다. 이 뒤에 붙는 줄만이 이번 실행의 기록이다.
    let log_mark = tip_log::mark();

    // 1. TSF 스레드 관리자 — 실제 앱이 텍스트 입력을 시작할 때 만드는 그 객체다.
    let thread_mgr: ITfThreadMgr =
        unsafe { CoCreateInstance(&CLSID_TF_ThreadMgr, None, CLSCTX_INPROC_SERVER)? };
    println!("1. ITfThreadMgr 생성");

    let client_id = unsafe { thread_mgr.Activate()? };
    println!("2. Activate → client_id={client_id}");

    // 2. 문서와 문맥. 입력기가 글자를 넣을 대상이 있어야 활성화가 의미를 갖는다.
    let doc_mgr: ITfDocumentMgr = unsafe { thread_mgr.CreateDocumentMgr()? };
    println!("3. ITfDocumentMgr 생성");

    let hwnd = create_window()?;
    println!("3b. 창 생성 (hwnd={:?})", hwnd.0);

    // 문서 저장소를 붙인다. 이게 없으면 입력기가 글자를 넣을 곳이 없다.
    let store = text_store::new(hwnd);
    let store_iface: windows::Win32::UI::TextServices::ITextStoreACP = store.to_interface();

    let mut context = None;
    let mut edit_cookie = 0u32;
    unsafe {
        doc_mgr.CreateContext(
            client_id,
            0,
            &store_iface.cast::<windows_core::IUnknown>()?,
            &mut context,
            &mut edit_cookie,
        )?
    };
    let context = context.ok_or_else(|| windows_core::Error::from(E_FAIL))?;
    println!("4. 문맥 생성 (edit_cookie={edit_cookie})");

    unsafe { doc_mgr.Push(&context)? };
    unsafe { thread_mgr.SetFocus(&doc_mgr)? };
    println!("5. 문맥 push + 포커스 설정");

    // 3. 여기서 TSF가 우리 DLL을 적재하고 ActivateEx를 부른다.
    let profiles: ITfInputProcessorProfiles =
        unsafe { CoCreateInstance(&CLSID_TF_InputProcessorProfiles, None, CLSCTX_INPROC_SERVER)? };

    // 프로파일이 "사용함" 상태가 아니면 활성화해도 TSF가 입력기를 적재하지 않는다.
    // 등록(AddLanguageProfile)과 사용 설정(EnableLanguageProfile)은 별개다.
    let enabled =
        unsafe { profiles.IsEnabledLanguageProfile(&CLSID_JIEUM_TIP, LANGID_KO_KR, &GUID_JIEUM_PROFILE) };
    println!("6a. 프로파일 사용 여부 = {enabled:?}");
    if enabled.map(|b| !b.as_bool()).unwrap_or(true) {
        unsafe {
            profiles.EnableLanguageProfile(
                &CLSID_JIEUM_TIP,
                LANGID_KO_KR,
                &GUID_JIEUM_PROFILE,
                true,
            )?
        };
        println!("6b. 프로파일 사용 설정함");
    }

    // 구형 ActivateLanguageProfile 대신 프로파일 관리자를 쓴다. FORSESSION이 있어야
    // 이 로그온 세션 전체에 적용되고, ENABLEPROFILE이 꺼진 프로파일도 켜 준다.
    let profile_mgr: ITfInputProcessorProfileMgr = profiles.cast()?;
    unsafe {
        profile_mgr.ActivateProfile(
            TF_PROFILETYPE_INPUTPROCESSOR,
            LANGID_KO_KR,
            &CLSID_JIEUM_TIP,
            &GUID_JIEUM_PROFILE,
            windows::Win32::UI::Input::KeyboardAndMouse::HKL(std::ptr::null_mut()),
            (TF_IPPMF_FORSESSION | TF_IPPMF_ENABLEPROFILE) as u32,
        )?
    };
    println!("6c. 지음 프로파일 활성화 요청 (ProfileMgr)");

    // TSF는 입력기 적재를 창 메시지로 전달한다. 콘솔 프로세스는 메시지 큐가 없어
    // 그냥 sleep 하면 활성화가 영원히 오지 않는다 — 프로파일 등록만 바뀌고 DLL은
    // 적재되지 않는다. PeekMessage를 부르는 순간 이 스레드에 메시지 큐가 생기고,
    // 그때부터 펌프를 돌려야 TSF가 우리 객체를 만든다.
    pump_messages(std::time::Duration::from_millis(1500));

    // 실제로 우리 것이 활성 프로파일이 됐는지 되물어 확인한다.
    let mut active_lang = 0u16;
    let mut active_profile = GUID::zeroed();
    unsafe {
        profiles.GetActiveLanguageProfile(
            &CLSID_JIEUM_TIP,
            &mut active_lang,
            &mut active_profile,
        )?
    };
    println!("7. 활성 프로파일 조회 → lang=0x{active_lang:04x} profile={active_profile:?}");
    if active_profile != GUID_JIEUM_PROFILE {
        return Err(windows_core::Error::new(
            E_FAIL,
            "활성 프로파일이 지음이 아니다",
        ));
    }

    // 9. 키를 직접 밀어 넣는다.
    //
    // `ITfKeystrokeMgr::TestKeyDown`/`KeyDown`은 원래 **앱이** TSF에 키를 넘길 때
    // 쓰는 통로다. 시험 장치가 앱 노릇을 하면 실제 타이핑과 같은 경로로 입력기에
    // 도달한다 — 가짜 호출이 아니라 진짜 경로다.
    let keystroke: ITfKeystrokeMgr = thread_mgr.cast()?;
    println!("9. 키 주입 (두벌식 '한'= G,K,S)");
    for (name, vk) in [("G", 0x47u16), ("K", 0x4B), ("S", 0x53)] {
        let wparam = WPARAM(vk as usize);
        let lparam = LPARAM(1);
        let test = unsafe { keystroke.TestKeyDown(wparam, lparam) };
        let down = unsafe { keystroke.KeyDown(wparam, lparam) };
        println!(
            "   {name}: TestKeyDown={} KeyDown={}",
            fmt(&test),
            fmt(&down)
        );
    }
    pump_messages(std::time::Duration::from_millis(300));

    // 두벌식에서 g=ㅎ, k=ㅏ, s=ㄴ 이므로 "한"이 되어야 한다.
    let expected = "한";
    let actual = store.snapshot();
    println!("10. 문서 내용 = {actual:?} (기대 {expected:?})");
    if actual != expected {
        return Err(windows_core::Error::new(
            E_FAIL,
            format!("문서 내용이 기대와 다르다: {actual:?} ≠ {expected:?}"),
        ));
    }

    // 11. 엔진 연결 — 입력기가 조합 중에 실제로 후보를 받아왔는가.
    //
    // 조회는 비동기라(D6) 키를 넣은 직후에는 아직 안 왔을 수 있다. 응답이 창 메시지로
    // 돌아오므로 펌프를 더 돌려야 한다 — 여기서 그냥 sleep 하면 메시지가 처리되지 않아
    // 영원히 안 온다.
    pump_messages(std::time::Duration::from_millis(1200));
    let log = tip_log::since(log_mark);

    if log.contains("엔진 파이프 연결") {
        if !log.contains("엔진 악수 완료") {
            return Err(windows_core::Error::new(
                E_FAIL,
                "파이프에는 붙었는데 악수 응답이 없다",
            ));
        }
        if !log.contains("조회 응답") {
            return Err(windows_core::Error::new(
                E_FAIL,
                "엔진에 붙었는데 조회 응답이 오지 않았다",
            ));
        }
        println!("11. 엔진 연결 확인 — 악수 + 조회 응답 도착");

        // 12. 후보 창이 실제로 보이는가.
        //
        // 로그에 "표시" 명령이 남는 것과 창이 화면에 있는 것은 다른 사실이다. 창을
        // 직접 찾아 가시성을 묻는다 — 이것이 "후보가 뜬다"에 가장 가까운 기계적 증거다.
        let host = unsafe {
            windows::Win32::UI::WindowsAndMessaging::FindWindowW(
                windows_core::w!("JieumCandidateHost"),
                windows_core::PCWSTR::null(),
            )
        };
        match host {
            Ok(hwnd)
                if unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(hwnd) }
                    .as_bool() =>
            {
                let mut rect = windows::Win32::Foundation::RECT::default();
                let _ = unsafe {
                    windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut rect)
                };
                println!(
                    "12. 후보 창이 보인다 — {}x{} @ ({},{})",
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    rect.left,
                    rect.top
                );
            }
            Ok(_) => {
                return Err(windows_core::Error::new(
                    E_FAIL,
                    "후보 창 프로세스는 있는데 창이 보이지 않는다",
                ));
            }
            Err(_) => {
                // 첫 실행에서는 정상이다 — 입력기가 프로세스를 막 띄웠고, 뜨기를
                // 기다리지 않기 때문이다(기다리면 그만큼 타이핑이 멈춘다).
                println!("12. ⚠ 후보 창 프로세스가 아직 없다 — 다시 실행하면 잡힌다");
            }
        }
    } else {
        // 조용히 통과시키지 않는다. 엔진이 꺼져 있으면 이 실행은 한글 조합까지만
        // 증명한 것이고, 그 사실이 출력에 남아야 한다.
        println!("11. ⚠ 엔진이 떠 있지 않아 조회 검증을 건너뛴다 (한글 조합까지만 확인됨)");
    }

    unsafe { doc_mgr.Pop(windows::Win32::UI::TextServices::TF_POPF_ALL)? };
    unsafe { thread_mgr.Deactivate()? };
    println!("8. 정리 완료");

    Ok(())
}
