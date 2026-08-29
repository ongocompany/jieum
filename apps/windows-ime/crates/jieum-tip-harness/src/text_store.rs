//! 시험용 텍스트 저장소 (`ITextStoreACP`).
//!
//! **이게 왜 필요한가.** TSF에서 "문서"는 앱이 제공한다. 입력기는 문서를 직접 갖고
//! 있지 않고 `ITfContext`를 통해 앱의 저장소를 고친다. 그래서 저장소가 없으면
//! 조합을 시작할 자리도, 글자를 넣을 곳도 없다 — 키 라우팅부터 막힌다.
//!
//! 실제 앱(메모장·워드·아래한글)이 각자 구현하는 것을 시험 장치가 흉내 내는 것이고,
//! 덕분에 **입력 결과를 문자열로 꺼내서 단언할 수 있다.** 스크린샷을 읽는 대신
//! `assert_eq!(store.text(), "한")`을 쓸 수 있다는 뜻이다.
//!
//! 잠금 모델이 핵심이다. 입력기가 문서를 고치려면 TSF가 저장소에 `RequestLock`을
//! 걸고, 저장소가 `OnLockGranted`를 불러 준 그 안에서만 편집이 일어난다.

use std::cell::{Cell, RefCell};

use windows::Win32::Foundation::{E_FAIL, E_NOTIMPL, HWND, POINT, RECT, S_OK};
use windows::Win32::System::Com::{IDataObject, FORMATETC};
use windows::Win32::UI::TextServices::{
    ITextStoreACP, ITextStoreACPSink, ITextStoreACP_Impl, TS_ATTRVAL, TS_RUNINFO, TS_RT_PLAIN,
    TEXT_STORE_LOCK_FLAGS, TS_AE_NONE, TS_IAS_QUERYONLY, TS_SELECTIONSTYLE, TS_SELECTION_ACP, TS_STATUS,
    TS_TEXTCHANGE,
};
use windows_core::{implement, BOOL, GUID, Interface, PCWSTR, PWSTR, Ref, Result, HRESULT};

#[implement(ITextStoreACP)]
pub struct TextStore {
    text: RefCell<Vec<u16>>,
    /// 선택 영역 (시작, 끝). 커서만 있을 때는 둘이 같다.
    selection: Cell<(i32, i32)>,
    sink: RefCell<Option<ITextStoreACPSink>>,
    /// 지금 걸려 있는 잠금. 0이면 잠금 없음.
    lock: Cell<u32>,
    hwnd: Cell<isize>,
}

impl TextStore {
    pub fn new(hwnd: HWND) -> Self {
        Self {
            text: RefCell::new(Vec::new()),
            selection: Cell::new((0, 0)),
            sink: RefCell::new(None),
            lock: Cell::new(0),
            hwnd: Cell::new(hwnd.0 as isize),
        }
    }
}

impl TextStore_Impl {
    /// 지금 문서에 들어 있는 글자. 시험이 결과를 확인하는 창구다.
    pub fn snapshot(&self) -> String {
        String::from_utf16_lossy(&self.text.borrow())
    }
}

impl ITextStoreACP_Impl for TextStore_Impl {
    fn AdviseSink(&self, _riid: *const GUID, punk: Ref<windows_core::IUnknown>, _mask: u32) -> Result<()> {
        let Some(unk) = punk.as_ref() else {
            return Err(E_FAIL.into());
        };
        match unk.cast::<ITextStoreACPSink>() {
            Ok(sink) => {
                println!("   [store] AdviseSink 성공 mask=0x{_mask:x}");
                *self.sink.borrow_mut() = Some(sink);
                Ok(())
            }
            Err(e) => {
                println!("   [store] AdviseSink cast 실패 0x{:08X}", e.code().0);
                Err(e)
            }
        }
    }

    fn UnadviseSink(&self, _punk: Ref<windows_core::IUnknown>) -> Result<()> {
        *self.sink.borrow_mut() = None;
        Ok(())
    }

    /// 편집 잠금을 건다.
    ///
    /// 동기로만 준다. 비동기 요청이 와도 그 자리에서 바로 승인하는데, 시험 장치에는
    /// 다른 스레드가 문서를 만질 일이 없어 구분할 이유가 없다. 실제 앱은 자기 UI
    /// 스레드 사정에 따라 미뤄야 할 수 있고, 그게 앱마다 호환성이 갈리는 지점이다.
    fn RequestLock(&self, lock_flags: u32) -> Result<HRESULT> {
        println!("   [store] RequestLock flags=0x{lock_flags:x}");
        let sink = self.sink.borrow().clone();
        let Some(sink) = sink else {
            return Ok(E_FAIL);
        };
        if self.lock.get() != 0 {
            // 잠금 안에서 또 요청하는 것은 거부한다. 허용하면 재진입으로 상태가 깨진다.
            return Ok(E_FAIL);
        }
        self.lock.set(lock_flags);
        let hr = unsafe { sink.OnLockGranted(TEXT_STORE_LOCK_FLAGS(lock_flags)) };
        self.lock.set(0);
        println!("   [store] OnLockGranted 결과 = {hr:?}");
        Ok(match hr {
            Ok(()) => S_OK,
            Err(e) => e.code(),
        })
    }

    fn GetStatus(&self) -> Result<TS_STATUS> {
        Ok(TS_STATUS {
            dwDynamicFlags: 0,
            dwStaticFlags: 0,
        })
    }

    fn QueryInsert(
        &self,
        acp_start: i32,
        acp_end: i32,
        _cch: u32,
        result_start: *mut i32,
        result_end: *mut i32,
    ) -> Result<()> {
        let len = self.text.borrow().len() as i32;
        unsafe {
            *result_start = acp_start.clamp(0, len);
            *result_end = acp_end.clamp(0, len);
        }
        Ok(())
    }

    fn GetSelection(
        &self,
        _index: u32,
        count: u32,
        selection: *mut TS_SELECTION_ACP,
        fetched: *mut u32,
    ) -> Result<()> {
        unsafe { *fetched = 0 };
        if count == 0 {
            return Ok(());
        }
        let (start, end) = self.selection.get();
        unsafe {
            *selection = TS_SELECTION_ACP {
                acpStart: start,
                acpEnd: end,
                style: TS_SELECTIONSTYLE {
                    ase: TS_AE_NONE,
                    fInterimChar: false.into(),
                },
            };
            *fetched = 1;
        }
        Ok(())
    }

    fn SetSelection(&self, count: u32, selection: *const TS_SELECTION_ACP) -> Result<()> {
        if count == 0 {
            return Ok(());
        }
        let sel = unsafe { &*selection };
        self.selection.set((sel.acpStart, sel.acpEnd));
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn GetText(
        &self,
        acp_start: i32,
        acp_end: i32,
        plain: PWSTR,
        plain_req: u32,
        plain_ret: *mut u32,
        run_info: *mut TS_RUNINFO,
        run_info_req: u32,
        run_info_ret: *mut u32,
        acp_next: *mut i32,
    ) -> Result<()> {
        let text = self.text.borrow();
        let len = text.len() as i32;
        let start = acp_start.clamp(0, len);
        // -1은 "끝까지"라는 뜻이다.
        let end = if acp_end < 0 { len } else { acp_end.clamp(start, len) };
        let avail = (end - start) as u32;
        let copy = avail.min(plain_req);

        if !plain.is_null() && copy > 0 {
            unsafe {
                std::ptr::copy_nonoverlapping(
                    text[start as usize..].as_ptr(),
                    plain.0,
                    copy as usize,
                );
            }
        }
        unsafe {
            if !plain_ret.is_null() {
                *plain_ret = copy;
            }
            if !run_info.is_null() && run_info_req > 0 {
                *run_info = TS_RUNINFO {
                    uCount: copy,
                    r#type: TS_RT_PLAIN,
                };
            }
            if !run_info_ret.is_null() {
                *run_info_ret = if run_info_req > 0 { 1 } else { 0 };
            }
            if !acp_next.is_null() {
                *acp_next = start + copy as i32;
            }
        }
        Ok(())
    }

    fn SetText(
        &self,
        _flags: u32,
        acp_start: i32,
        acp_end: i32,
        text: &PCWSTR,
        cch: u32,
    ) -> Result<TS_TEXTCHANGE> {
        println!("   [store] SetText [{acp_start},{acp_end}) cch={cch}");
        let mut buf = self.text.borrow_mut();
        let len = buf.len() as i32;
        let start = acp_start.clamp(0, len) as usize;
        let end = if acp_end < 0 { len } else { acp_end.clamp(acp_start, len) } as usize;

        let incoming: Vec<u16> = if cch == 0 || text.is_null() {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(text.0, cch as usize) }.to_vec()
        };

        buf.splice(start..end, incoming.iter().copied());
        let new_end = start + incoming.len();
        drop(buf);

        self.selection.set((new_end as i32, new_end as i32));

        Ok(TS_TEXTCHANGE {
            acpStart: start as i32,
            acpOldEnd: end as i32,
            acpNewEnd: new_end as i32,
        })
    }

    fn InsertTextAtSelection(
        &self,
        flags: u32,
        text: &PCWSTR,
        cch: u32,
        acp_start: *mut i32,
        acp_end: *mut i32,
        change: *mut TS_TEXTCHANGE,
    ) -> Result<()> {
        println!("   [store] InsertTextAtSelection flags=0x{flags:x} cch={cch}");
        let (sel_start, sel_end) = self.selection.get();

        // QUERYONLY는 "넣지 말고 넣을 자리만 알려 달라"는 뜻이다. 입력기가 조합을
        // 시작할 범위를 얻을 때 쓴다.
        if flags & TS_IAS_QUERYONLY != 0 {
            unsafe {
                if !acp_start.is_null() {
                    *acp_start = sel_start;
                }
                if !acp_end.is_null() {
                    *acp_end = sel_end;
                }
            }
            return Ok(());
        }

        let tc = self.SetText(0, sel_start, sel_end, text, cch)?;
        unsafe {
            if !acp_start.is_null() {
                *acp_start = tc.acpStart;
            }
            if !acp_end.is_null() {
                *acp_end = tc.acpNewEnd;
            }
            if !change.is_null() {
                *change = tc;
            }
        }
        Ok(())
    }

    fn GetEndACP(&self) -> Result<i32> {
        Ok(self.text.borrow().len() as i32)
    }

    fn GetActiveView(&self) -> Result<u32> {
        Ok(0)
    }

    fn GetWnd(&self, _view: u32) -> Result<HWND> {
        Ok(HWND(self.hwnd.get() as *mut core::ffi::c_void))
    }

    fn GetScreenExt(&self, _view: u32) -> Result<RECT> {
        Ok(RECT { left: 0, top: 0, right: 800, bottom: 600 })
    }

    fn GetTextExt(
        &self,
        _view: u32,
        _acp_start: i32,
        _acp_end: i32,
        rc: *mut RECT,
        clipped: *mut BOOL,
    ) -> Result<()> {
        unsafe {
            if !rc.is_null() {
                *rc = RECT { left: 0, top: 0, right: 10, bottom: 20 };
            }
            if !clipped.is_null() {
                *clipped = false.into();
            }
        }
        Ok(())
    }

    // --- 아래는 시험에 필요 없다. 실제 앱은 구현해야 할 수도 있다. ---

    fn RequestSupportedAttrs(&self, _f: u32, _c: u32, _a: *const GUID) -> Result<()> {
        Ok(())
    }
    fn RequestAttrsAtPosition(&self, _p: i32, _c: u32, _a: *const GUID, _f: u32) -> Result<()> {
        Ok(())
    }
    fn RequestAttrsTransitioningAtPosition(
        &self,
        _p: i32,
        _c: u32,
        _a: *const GUID,
        _f: u32,
    ) -> Result<()> {
        Ok(())
    }
    fn RetrieveRequestedAttrs(
        &self,
        _count: u32,
        _vals: *mut TS_ATTRVAL,
        fetched: *mut u32,
    ) -> Result<()> {
        unsafe {
            if !fetched.is_null() {
                *fetched = 0;
            }
        }
        Ok(())
    }
    fn FindNextAttrTransition(
        &self,
        _s: i32,
        _h: i32,
        _c: u32,
        _a: *const GUID,
        _f: u32,
        _next: *mut i32,
        _found: *mut BOOL,
        _off: *mut i32,
    ) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetFormattedText(&self, _s: i32, _e: i32) -> Result<IDataObject> {
        Err(E_NOTIMPL.into())
    }
    fn GetEmbedded(&self, _p: i32, _svc: *const GUID, _iid: *const GUID) -> Result<windows_core::IUnknown> {
        Err(E_NOTIMPL.into())
    }
    fn QueryInsertEmbedded(&self, _svc: *const GUID, _fmt: *const FORMATETC) -> Result<BOOL> {
        Ok(false.into())
    }
    fn InsertEmbedded(
        &self,
        _f: u32,
        _s: i32,
        _e: i32,
        _o: Ref<IDataObject>,
    ) -> Result<TS_TEXTCHANGE> {
        Err(E_NOTIMPL.into())
    }
    fn InsertEmbeddedAtSelection(
        &self,
        _f: u32,
        _o: Ref<IDataObject>,
        _s: *mut i32,
        _e: *mut i32,
        _c: *mut TS_TEXTCHANGE,
    ) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn GetACPFromPoint(&self, _v: u32, _pt: *const POINT, _f: u32) -> Result<i32> {
        Err(E_NOTIMPL.into())
    }
}

/// COM 객체로 만들되 구체 타입을 유지한다.
///
/// `ITextStoreACP`만 들고 있으면 시험이 결과 문자열을 꺼낼 수 없다. `ComObject`는
/// 인터페이스로도 넘길 수 있고 내부 구현에도 닿을 수 있다.
pub fn new(hwnd: HWND) -> windows_core::ComObject<TextStore> {
    TextStore::new(hwnd).into()
}
