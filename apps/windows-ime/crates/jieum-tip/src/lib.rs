//! 지음 — Windows TSF Text Input Processor.
//!
//! macOS 쪽 IMK 셸(`apps/macos-ime`)과 같은 자리를 차지한다. 엔진·사전·프로토콜·MRU는
//! 그대로 쓰고, 이 크레이트는 플랫폼 껍데기만 맡는다 (계획서 D2).
//!
//! DLL이 밖으로 내보내는 것은 COM이 요구하는 네 개뿐이다:
//! `DllGetClassObject` · `DllCanUnloadNow` · `DllRegisterServer` · `DllUnregisterServer`.

#![cfg(windows)]

mod candidate_ui;
mod caret_stats;
mod com;
mod composition;
mod composition_sink;
mod display_attr;
mod edit_session;
mod engine;
mod guids;
mod hangul;
pub mod logging;
mod register;
mod settings;
mod text_service;

use std::ffi::c_void;
use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering};

use windows::Win32::Foundation::{
    CLASS_E_CLASSNOTAVAILABLE, E_POINTER, HINSTANCE, HMODULE, S_FALSE, S_OK,
};
use windows::Win32::System::SystemServices::DLL_PROCESS_ATTACH;
use windows_core::{GUID, HRESULT, Interface};

/// `DllMain`이 받은 모듈 핸들. 레지스트리에 적을 DLL 경로를 알아내는 데 쓴다.
static DLL_INSTANCE: AtomicIsize = AtomicIsize::new(0);

/// 살아 있는 객체·잠금 수. 0이 되어야 OLE가 DLL을 내려도 된다.
static LOCK_COUNT: AtomicUsize = AtomicUsize::new(0);

pub(crate) fn dll_instance() -> HMODULE {
    HMODULE(DLL_INSTANCE.load(Ordering::SeqCst) as *mut c_void)
}

pub(crate) fn lock_server(lock: bool) {
    if lock {
        LOCK_COUNT.fetch_add(1, Ordering::SeqCst);
    } else {
        LOCK_COUNT.fetch_sub(1, Ordering::SeqCst);
    }
}

#[no_mangle]
pub extern "system" fn DllMain(hinst: HINSTANCE, reason: u32, _reserved: *mut c_void) -> i32 {
    if reason == DLL_PROCESS_ATTACH {
        DLL_INSTANCE.store(hinst.0 as isize, Ordering::SeqCst);
    }
    1 // TRUE
}

/// OLE가 CLSID로 팩토리를 요구한다. 등록된 CLSID가 우리 것일 때만 응한다.
#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    rclsid: *const GUID,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    if ppv.is_null() {
        return E_POINTER;
    }
    unsafe { *ppv = std::ptr::null_mut() };
    if rclsid.is_null() || riid.is_null() {
        return E_POINTER;
    }

    if unsafe { *rclsid } != guids::CLSID_JIEUM_TIP {
        return CLASS_E_CLASSNOTAVAILABLE;
    }

    let factory = com::factory();
    unsafe { factory.query(&*riid, ppv) }
}

/// 아직 쓰이는 객체가 있으면 DLL을 내리지 못하게 막는다.
#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HRESULT {
    if LOCK_COUNT.load(Ordering::SeqCst) == 0 {
        // 창 클래스를 여기서 지운다. 창 프로시저는 이 DLL 안의 함수 주소라, 클래스를
        // 남긴 채 언로드되면 그 주소는 사라진 코드를 가리킨다. 살아 있는 객체가 0인
        // 지금이 창도 없음이 보장되는 유일한 시점이다.
        engine::unregister_class();
        S_OK
    } else {
        S_FALSE
    }
}

#[no_mangle]
pub extern "system" fn DllRegisterServer() -> HRESULT {
    match register::register_server() {
        Ok(()) => S_OK,
        Err(e) => {
            log_line!("DllRegisterServer 실패: {e:?}");
            e.code()
        }
    }
}

#[no_mangle]
pub extern "system" fn DllUnregisterServer() -> HRESULT {
    match register::unregister_server() {
        Ok(()) => S_OK,
        Err(e) => {
            log_line!("DllUnregisterServer 실패: {e:?}");
            e.code()
        }
    }
}
