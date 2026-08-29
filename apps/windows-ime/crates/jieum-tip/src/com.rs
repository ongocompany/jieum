//! COM 클래스 팩토리.
//!
//! TSF는 입력기를 직접 `new` 하지 않는다. 레지스트리에서 CLSID를 찾아
//! `CoCreateInstance`를 부르고, 그러면 OLE가 이 DLL의 `DllGetClassObject`로 팩토리를
//! 얻은 뒤 `CreateInstance`를 호출한다. 그 사슬의 중간 고리가 이 파일이다.

use std::ffi::c_void;

use windows::Win32::Foundation::{CLASS_E_NOAGGREGATION, E_POINTER};
use windows::Win32::System::Com::{IClassFactory, IClassFactory_Impl};
use windows_core::{implement, BOOL, GUID, IUnknown, Interface, Ref, Result};

use crate::log_line;
use crate::text_service::TextService;

#[implement(IClassFactory)]
pub struct ClassFactory;

impl IClassFactory_Impl for ClassFactory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<'_, IUnknown>,
        iid: *const GUID,
        object: *mut *mut c_void,
    ) -> Result<()> {
        if object.is_null() {
            return Err(E_POINTER.into());
        }
        unsafe { *object = std::ptr::null_mut() };

        // 집합(aggregation)은 지원하지 않는다. TSF는 요구하지 않는다.
        if !outer.is_null() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }

        log_line!("ClassFactory::CreateInstance");

        let service: IUnknown = TextService::new().into();
        unsafe { service.query(&*iid, object).ok() }
    }

    fn LockServer(&self, lock: BOOL) -> Result<()> {
        crate::lock_server(lock.as_bool());
        Ok(())
    }
}

/// `IClassFactory`로 감싼 인스턴스를 돌려준다. `DllGetClassObject`가 쓴다.
pub fn factory() -> IClassFactory {
    ClassFactory.into()
}
