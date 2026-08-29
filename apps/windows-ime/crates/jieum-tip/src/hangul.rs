//! libhangul 연결 — 두벌식 조합기.
//!
//! macOS 셸이 쓰는 것과 **같은 C 라이브러리**를 쓴다. Rust로 두벌식을 다시 짜면
//! 겹받침 처리나 조합 중 backspace 같은 데서 미묘하게 갈리는데, 그 차이는 사용자에게
//! "윈도우에서만 이상하다"로 보이고 재현이 어렵다. 같은 라이브러리를 쓰면 그 부류의
//! 차이가 아예 생기지 않는다.
//!
//! LGPL 2.1이므로 **동적 링크**로만 붙인다(`libhangul.dll`을 옆에 둔다).
//! macOS에서 `.dylib`을 번들에 넣는 것과 같은 방식이다.
//!
//! libhangul의 문자열은 널로 끝나는 UCS-4(`uint32_t`) 배열이다.

//! ## 왜 정적 import가 아니라 실행 시점에 부르는가
//!
//! 윈도우가 DLL의 의존 DLL을 찾을 때 보는 것은 **실행 파일**의 폴더이지 그 DLL의
//! 폴더가 아니다. 입력기는 남의 프로그램 안으로 들어가므로 실행 파일 폴더가 매번
//! 다르고, `libhangul.dll`을 우리 옆에 둬도 못 찾는다. 그래서 우리 모듈 경로를
//! 직접 계산해 `LoadLibrary`로 부른다. LGPL 관점에서도 이쪽이 더 분명하다.

use std::ffi::{c_char, c_int, c_void, CString};
use std::sync::OnceLock;

use windows::Win32::Foundation::{HMODULE, MAX_PATH};
use windows::Win32::System::LibraryLoader::{GetModuleFileNameW, GetProcAddress, LoadLibraryW};
use windows_core::HSTRING;

type HangulInputContext = c_void;

type FnNew = unsafe extern "C" fn(*const c_char) -> *mut HangulInputContext;
type FnDelete = unsafe extern "C" fn(*mut HangulInputContext);
type FnProcess = unsafe extern "C" fn(*mut HangulInputContext, c_int) -> bool;
type FnString = unsafe extern "C" fn(*mut HangulInputContext) -> *const u32;
type FnBool = unsafe extern "C" fn(*mut HangulInputContext) -> bool;

struct Api {
    ic_new: FnNew,
    ic_delete: FnDelete,
    ic_process: FnProcess,
    ic_preedit: FnString,
    ic_commit: FnString,
    ic_backspace: FnBool,
    ic_flush: FnString,
    ic_is_empty: FnBool,
}

/// 우리 DLL이 있는 폴더.
///
/// 후보 창 프로세스도 이 옆에 있으므로 같은 계산을 쓴다.
pub(crate) fn module_dir() -> Option<String> {
    let mut buf = [0u16; MAX_PATH as usize];
    let len = unsafe { GetModuleFileNameW(Some(crate::dll_instance()), &mut buf) };
    if len == 0 {
        return None;
    }
    let full = String::from_utf16_lossy(&buf[..len as usize]);
    let idx = full.rfind('\\')?;
    Some(full[..idx].to_string())
}

fn api() -> Option<&'static Api> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    API.get_or_init(|| {
        let dir = module_dir()?;
        let path = format!("{dir}\\libhangul.dll");
        let module: HMODULE = unsafe { LoadLibraryW(&HSTRING::from(&path)) }.ok()?;
        if module.is_invalid() {
            crate::log_line!("libhangul.dll 적재 실패: {path}");
            return None;
        }

        macro_rules! sym {
            ($name:literal) => {{
                let c = std::ffi::CString::new($name).ok()?;
                let p = unsafe { GetProcAddress(module, windows_core::PCSTR(c.as_ptr() as *const u8)) }?;
                unsafe { std::mem::transmute(p) }
            }};
        }

        Some(Api {
            ic_new: sym!("hangul_ic_new"),
            ic_delete: sym!("hangul_ic_delete"),
            ic_process: sym!("hangul_ic_process"),
            ic_preedit: sym!("hangul_ic_get_preedit_string"),
            ic_commit: sym!("hangul_ic_get_commit_string"),
            ic_backspace: sym!("hangul_ic_backspace"),
            ic_flush: sym!("hangul_ic_flush"),
            ic_is_empty: sym!("hangul_ic_is_empty"),
        })
    })
    .as_ref()
}

/// 널로 끝나는 UCS-4 배열을 Rust 문자열로.
unsafe fn ucs4_to_string(ptr: *const u32) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut out = String::new();
    let mut i = 0isize;
    loop {
        let code = unsafe { *ptr.offset(i) };
        if code == 0 {
            break;
        }
        if let Some(c) = char::from_u32(code) {
            out.push(c);
        }
        i += 1;
        // 조합 문자열은 한 음절 수준이다. 이 길이를 넘으면 널 종료를 놓친 것이므로
        // 무한히 읽지 않고 멈춘다 — 남의 프로세스에서 도는 코드다.
        if i > 64 {
            break;
        }
    }
    out
}

pub struct Composer {
    hic: *mut HangulInputContext,
    api: &'static Api,
}

impl Composer {
    /// `keyboard`는 libhangul 자판 이름. 두벌식은 `"2"`.
    pub fn new(keyboard: &str) -> Option<Self> {
        let api = api()?;
        let name = CString::new(keyboard).ok()?;
        let hic = unsafe { (api.ic_new)(name.as_ptr()) };
        if hic.is_null() {
            None
        } else {
            Some(Self { hic, api })
        }
    }

    /// 키 하나를 넣는다. 돌려주는 값은 "조합기가 먹었는가".
    pub fn process(&self, ascii: u8) -> bool {
        unsafe { (self.api.ic_process)(self.hic, ascii as c_int) }
    }

    /// 조합 중인 음절 (아직 확정되지 않은 것).
    pub fn preedit(&self) -> String {
        unsafe { ucs4_to_string((self.api.ic_preedit)(self.hic)) }
    }

    /// 방금 완성돼 밀려나온 음절. 한 글자가 끝나면 여기로 나온다.
    pub fn commit(&self) -> String {
        unsafe { ucs4_to_string((self.api.ic_commit)(self.hic)) }
    }

    /// 조합 중인 음절에서 한 자모를 지운다. 지울 게 없으면 false.
    pub fn backspace(&self) -> bool {
        unsafe { (self.api.ic_backspace)(self.hic) }
    }

    /// 조합기를 비우고 남아 있던 글자를 돌려준다.
    pub fn flush(&self) -> String {
        unsafe { ucs4_to_string((self.api.ic_flush)(self.hic)) }
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        unsafe { (self.api.ic_is_empty)(self.hic) }
    }
}

impl Drop for Composer {
    fn drop(&mut self) {
        unsafe { (self.api.ic_delete)(self.hic) };
    }
}
