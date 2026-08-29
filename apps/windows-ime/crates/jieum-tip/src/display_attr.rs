//! 조합 중인 글자의 **표시 속성** — "이건 아직 확정 전"이라고 앱에 알리는 통로.
//!
//! macOS에서는 marked text에 밑줄이 저절로 그어진다. TSF에는 그런 기본값이 없다.
//! 입력기가 속성을 하나 정의해 등록하고, 조합 범위에 `GUID_PROP_ATTRIBUTE` 속성으로
//! 그것을 걸어 줘야 앱이 밑줄을 긋는다.
//!
//! ## 왜 필요한가 — 모양 문제가 아니다 (2026-08-07, 아래한글)
//!
//! 처음에는 "밑줄이 안 그어지는 것뿐"으로 보여 미뤄 뒀다. 그런데 **아래한글은 표시
//! 속성이 없는 범위를 조합으로 받아들이지 않고 매 키마다 끊었다** — `한`을 치면
//! `ㅎ하한`이 박혔다. 메모장·Word는 속성이 없어도 봐주지만, 조합을 자기가 그리는 앱은
//! 속성을 조합의 표시가 아니라 **조합이라는 증거**로 쓴다.
//!
//! 앱이 이 속성을 실제로 읽으려면 세 가지가 다 있어야 한다. 하나라도 빠지면 조용히
//! 무시된다:
//!
//! 1. 이 모듈의 `ITfDisplayAttributeProvider` (같은 CLSID로 만들어진다)
//! 2. `GUID_TFCAT_DISPLAYATTRIBUTEPROVIDER` 범주 등록 (`register.rs`)
//! 3. 조합 범위에 속성 걸기 (`composition::set_text`)

use std::cell::RefCell;

use windows::Win32::Foundation::{COLORREF, E_INVALIDARG, S_FALSE};
use windows::Win32::UI::TextServices::{
    IEnumTfDisplayAttributeInfo, IEnumTfDisplayAttributeInfo_Impl, ITfDisplayAttributeInfo,
    ITfDisplayAttributeInfo_Impl, TF_ATTR_INPUT, TF_CT_NONE, TF_DA_COLOR, TF_DA_COLOR_0,
    TF_DISPLAYATTRIBUTE, TF_LS_SOLID,
};
use windows_core::{implement, BSTR, GUID, Result};

use crate::guids::GUID_JIEUM_DISPLAY_ATTR_INPUT;

/// 조합 중일 때의 모양: 글자색·배경색은 앱에 맡기고 **실선 밑줄**만 요구한다.
///
/// 색을 지정하지 않는 것이 중요하다. 앱마다 배경이 달라서(어두운 편집기도 있다)
/// 입력기가 색을 정하면 어딘가에서는 글자가 안 보인다. 밑줄만 그으면 어디서든 읽힌다.
fn input_attribute() -> TF_DISPLAYATTRIBUTE {
    TF_DISPLAYATTRIBUTE {
        crText: TF_DA_COLOR {
            r#type: TF_CT_NONE,
            Anonymous: TF_DA_COLOR_0 { cr: COLORREF(0) },
        },
        crBk: TF_DA_COLOR {
            r#type: TF_CT_NONE,
            Anonymous: TF_DA_COLOR_0 { cr: COLORREF(0) },
        },
        lsStyle: TF_LS_SOLID,
        fBoldLine: false.into(),
        crLine: TF_DA_COLOR {
            r#type: TF_CT_NONE,
            Anonymous: TF_DA_COLOR_0 { cr: COLORREF(0) },
        },
        // 입력 중(확정 전). 변환 후보를 고르는 중이라는 별도 값도 있으나, 지음은
        // 후보를 고르는 동안에도 글자 모양이 같으므로 하나로 둔다.
        bAttr: TF_ATTR_INPUT,
    }
}

/// 속성 하나. 지음은 "조합 중" 하나만 쓴다.
#[implement(ITfDisplayAttributeInfo)]
pub struct DisplayAttributeInfo {
    /// 앱이 `SetAttributeInfo`로 바꿔 놓을 수 있어 상태를 들고 있는다.
    /// `Reset`은 기본값으로 되돌린다.
    current: RefCell<TF_DISPLAYATTRIBUTE>,
}

impl DisplayAttributeInfo {
    pub fn new() -> Self {
        Self {
            current: RefCell::new(input_attribute()),
        }
    }
}

impl ITfDisplayAttributeInfo_Impl for DisplayAttributeInfo_Impl {
    fn GetGUID(&self) -> Result<GUID> {
        Ok(GUID_JIEUM_DISPLAY_ATTR_INPUT)
    }

    fn GetDescription(&self) -> Result<BSTR> {
        Ok(BSTR::from("지음 조합 중"))
    }

    fn GetAttributeInfo(&self, pda: *mut TF_DISPLAYATTRIBUTE) -> Result<()> {
        if pda.is_null() {
            return Err(E_INVALIDARG.into());
        }
        unsafe { *pda = *self.current.borrow() };
        Ok(())
    }

    fn SetAttributeInfo(&self, pda: *const TF_DISPLAYATTRIBUTE) -> Result<()> {
        if pda.is_null() {
            return Err(E_INVALIDARG.into());
        }
        *self.current.borrow_mut() = unsafe { *pda };
        Ok(())
    }

    fn Reset(&self) -> Result<()> {
        *self.current.borrow_mut() = input_attribute();
        Ok(())
    }
}

/// 속성 목록 열거자. 항목이 하나뿐이라 위치는 "냈는가/안 냈는가" 둘뿐이다.
#[implement(IEnumTfDisplayAttributeInfo)]
pub struct DisplayAttributeEnum {
    done: RefCell<bool>,
}

impl DisplayAttributeEnum {
    pub fn new() -> Self {
        Self {
            done: RefCell::new(false),
        }
    }
}

impl IEnumTfDisplayAttributeInfo_Impl for DisplayAttributeEnum_Impl {
    fn Clone(&self) -> Result<IEnumTfDisplayAttributeInfo> {
        // 복제는 **위치까지 같아야 한다.** 처음으로 되돌려 주면 부르는 쪽이 같은
        // 항목을 두 번 받는다.
        let copy = DisplayAttributeEnum {
            done: RefCell::new(*self.done.borrow()),
        };
        Ok(copy.into())
    }

    fn Next(
        &self,
        count: u32,
        info: *mut Option<ITfDisplayAttributeInfo>,
        fetched: *mut u32,
    ) -> Result<()> {
        let mut written = 0u32;
        if count > 0 && !info.is_null() && !*self.done.borrow() {
            unsafe { *info = Some(DisplayAttributeInfo::new().into()) };
            *self.done.borrow_mut() = true;
            written = 1;
        }
        if !fetched.is_null() {
            unsafe { *fetched = written };
        }
        // 요청한 만큼 못 채우면 `S_FALSE`다. `Ok(())`(S_OK)로 답하면 부르는 쪽이
        // 더 있다고 여기고 계속 묻는다.
        if written < count {
            Err(S_FALSE.into())
        } else {
            Ok(())
        }
    }

    fn Reset(&self) -> Result<()> {
        *self.done.borrow_mut() = false;
        Ok(())
    }

    fn Skip(&self, count: u32) -> Result<()> {
        if count == 0 {
            return Ok(());
        }
        if *self.done.borrow() {
            return Err(S_FALSE.into());
        }
        *self.done.borrow_mut() = true;
        if count > 1 {
            return Err(S_FALSE.into());
        }
        Ok(())
    }
}
