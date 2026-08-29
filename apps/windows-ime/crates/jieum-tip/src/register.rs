//! 등록·해제.
//!
//! 윈도우 입력기는 세 곳에 자기를 알린다. 하나라도 빠지면 증상이 서로 다르다:
//!
//! 1. **COM 등록** (`HKCR\CLSID\{...}\InprocServer32`) — 없으면 TSF가 DLL을 못 찾는다.
//! 2. **언어 프로파일** (`ITfInputProcessorProfiles`) — 없으면 입력 소스 목록에 안 뜬다.
//! 3. **범주** (`ITfCategoryMgr`) — 없으면 목록엔 뜨는데 실제로 키를 못 받거나,
//!    스토어 앱·보안 입력 화면에서만 조용히 빠진다.
//!
//! macOS에서 `Info.plist` 하나로 끝나던 일이 여기서는 세 갈래다.

use windows::Win32::Foundation::MAX_PATH;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::LibraryLoader::GetModuleFileNameW;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_CLASSES_ROOT,
    KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows::Win32::UI::TextServices::{
    ITfCategoryMgr, ITfInputProcessorProfiles, CLSID_TF_CategoryMgr,
    CLSID_TF_InputProcessorProfiles, GUID_TFCAT_TIPCAP_COMLESS,
    GUID_TFCAT_TIPCAP_IMMERSIVESUPPORT, GUID_TFCAT_TIPCAP_INPUTMODECOMPARTMENT,
    GUID_TFCAT_TIPCAP_SECUREMODE, GUID_TFCAT_TIPCAP_SYSTRAYSUPPORT,
    GUID_TFCAT_TIPCAP_UIELEMENTENABLED, GUID_TFCAT_TIP_KEYBOARD,
    GUID_TFCAT_DISPLAYATTRIBUTEPROVIDER,
};
use windows_core::{GUID, HSTRING, PCWSTR, Result};

use crate::guids::{CLSID_JIEUM_TIP, GUID_JIEUM_PROFILE, LANGID_KO_KR, PROFILE_DESCRIPTION};
use crate::log_line;

/// TSF가 요구하는 범주 목록.
///
/// `TIP_KEYBOARD`만 있으면 데스크탑 앱에서는 돌지만 스토어 앱에서는 빠진다.
/// `IMMERSIVESUPPORT`·`SYSTRAYSUPPORT`가 그 문을 열고, `SECUREMODE`는 UAC 같은
/// 보안 화면에서의 취급을 정하며, `COMLESS`는 COM 없이 적재되는 경로를 허용한다.
const CATEGORIES: &[GUID] = &[
    GUID_TFCAT_TIP_KEYBOARD,
    // 조합 표시 속성 제공자. 이게 없으면 조합 범위에 속성을 걸어도 앱이 뜻을 못 읽고,
    // 조합을 자기가 그리는 앱은 그 조합을 통째로 안 받아들인다 (아래한글, 2026-08-07).
    GUID_TFCAT_DISPLAYATTRIBUTEPROVIDER,
    GUID_TFCAT_TIPCAP_UIELEMENTENABLED,
    GUID_TFCAT_TIPCAP_SECUREMODE,
    GUID_TFCAT_TIPCAP_COMLESS,
    GUID_TFCAT_TIPCAP_INPUTMODECOMPARTMENT,
    GUID_TFCAT_TIPCAP_IMMERSIVESUPPORT,
    GUID_TFCAT_TIPCAP_SYSTRAYSUPPORT,
];

fn clsid_key_path() -> String {
    format!("CLSID\\{{{:?}}}", CLSID_JIEUM_TIP)
}

/// 이 DLL이 디스크의 어디에 있는지. 레지스트리에 절대 경로를 적어야 한다.
fn module_path() -> Result<String> {
    let mut buf = [0u16; MAX_PATH as usize];
    let len = unsafe { GetModuleFileNameW(Some(crate::dll_instance()), &mut buf) };
    if len == 0 {
        return Err(windows_core::Error::from_thread());
    }
    Ok(String::from_utf16_lossy(&buf[..len as usize]))
}

fn write_string_value(key: HKEY, name: Option<&str>, value: &str) -> Result<()> {
    let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = unsafe {
        std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2)
    };
    let name_h = name.map(HSTRING::from);
    let name_pcwstr = name_h
        .as_ref()
        .map(|h| PCWSTR(h.as_ptr()))
        .unwrap_or(PCWSTR::null());
    unsafe { RegSetValueExW(key, name_pcwstr, None, REG_SZ, Some(bytes)) }.ok()?;
    Ok(())
}

fn create_key(sub: &str) -> Result<HKEY> {
    let mut key = HKEY::default();
    unsafe {
        RegCreateKeyExW(
            HKEY_CLASSES_ROOT,
            &HSTRING::from(sub),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut key,
            None,
        )
    }
    .ok()?;
    Ok(key)
}

/// `DllRegisterServer` 본체.
pub fn register_server() -> Result<()> {
    let dll = module_path()?;
    log_line!("register_server: dll={dll}");

    // 1. COM 등록
    let root = clsid_key_path();
    let key = create_key(&root)?;
    write_string_value(key, None, PROFILE_DESCRIPTION)?;
    unsafe { RegCloseKey(key).ok()? };

    let inproc = create_key(&format!("{root}\\InprocServer32"))?;
    write_string_value(inproc, None, &dll)?;
    // 스레드 친화(Apartment) — 입력기는 UI 스레드에 묶인다. Both나 Free로 두면
    // TSF가 다른 스레드에서 부를 수 있게 되고, 그 순간 상태가 깨진다.
    write_string_value(inproc, Some("ThreadingModel"), "Apartment")?;
    unsafe { RegCloseKey(inproc).ok()? };

    // 2. 언어 프로파일
    let profiles: ITfInputProcessorProfiles =
        unsafe { CoCreateInstance(&CLSID_TF_InputProcessorProfiles, None, CLSCTX_INPROC_SERVER)? };
    unsafe { profiles.Register(&CLSID_JIEUM_TIP)? };

    let desc: Vec<u16> = PROFILE_DESCRIPTION.encode_utf16().collect();
    let dll_wide: Vec<u16> = dll.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        profiles.AddLanguageProfile(
            &CLSID_JIEUM_TIP,
            LANGID_KO_KR,
            &GUID_JIEUM_PROFILE,
            &desc,
            &dll_wide,
            0, // 아이콘 색인. 아직 아이콘 자원이 없다
        )?
    };

    // 3. 범주
    let categories: ITfCategoryMgr =
        unsafe { CoCreateInstance(&CLSID_TF_CategoryMgr, None, CLSCTX_INPROC_SERVER)? };
    for cat in CATEGORIES {
        unsafe { categories.RegisterCategory(&CLSID_JIEUM_TIP, cat, &CLSID_JIEUM_TIP)? };
    }

    log_line!("register_server: 완료");
    Ok(())
}

/// `DllUnregisterServer` 본체. 실패해도 최대한 진행한다 — 부분 등록 상태로 남는 것이
/// 가장 나쁘다(입력 소스 목록에 유령이 남는다).
pub fn unregister_server() -> Result<()> {
    log_line!("unregister_server 시작");

    if let Ok(categories) =
        unsafe { CoCreateInstance::<_, ITfCategoryMgr>(&CLSID_TF_CategoryMgr, None, CLSCTX_INPROC_SERVER) }
    {
        for cat in CATEGORIES {
            let _ = unsafe { categories.UnregisterCategory(&CLSID_JIEUM_TIP, cat, &CLSID_JIEUM_TIP) };
        }
    }

    if let Ok(profiles) = unsafe {
        CoCreateInstance::<_, ITfInputProcessorProfiles>(
            &CLSID_TF_InputProcessorProfiles,
            None,
            CLSCTX_INPROC_SERVER,
        )
    } {
        let _ = unsafe { profiles.Unregister(&CLSID_JIEUM_TIP) };
    }

    let _ = unsafe { RegDeleteTreeW(HKEY_CLASSES_ROOT, &HSTRING::from(clsid_key_path())) };

    log_line!("unregister_server: 완료");
    Ok(())
}
