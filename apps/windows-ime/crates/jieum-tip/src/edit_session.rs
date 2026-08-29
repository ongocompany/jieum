//! 편집 세션.
//!
//! TSF에서는 문서를 아무 때나 고칠 수 없다. 고치려면 `RequestEditSession`으로
//! **edit cookie**(TSF가 내주는 편집 허가증)를 신청하고, 승인되면 `DoEditSession`을 불러 준다.
//! 그 안에서만 문자를 넣거나 조합을 만들 수 있다.
//!
//! macOS IMK에는 이런 관문이 없다 — `insertText`를 그냥 부르면 된다. TSF가 이렇게
//! 만든 이유는 입력기가 남의 프로세스 안에서 돌기 때문이다. 앱이 자기 문서를 고치는
//! 중에 입력기가 끼어들면 상태가 깨지므로, 겹치지 않는 시점을 TSF가 정해 준다.

use std::cell::RefCell;

use windows::Win32::UI::TextServices::{ITfEditSession, ITfEditSession_Impl};
use windows_core::{implement, Result};

type SessionFn = Box<dyn FnOnce(u32) -> Result<()>>;

/// 클로저 하나를 감싼 편집 세션. 쓸 때마다 새로 만든다 (한 번만 불린다).
#[implement(ITfEditSession)]
pub struct EditSession {
    work: RefCell<Option<SessionFn>>,
}

impl EditSession {
    pub fn new(work: impl FnOnce(u32) -> Result<()> + 'static) -> Self {
        Self {
            work: RefCell::new(Some(Box::new(work))),
        }
    }
}

impl ITfEditSession_Impl for EditSession_Impl {
    fn DoEditSession(&self, edit_cookie: u32) -> Result<()> {
        let work = self.work.borrow_mut().take();
        match work {
            Some(f) => f(edit_cookie),
            // 두 번 불릴 일은 없지만, 불려도 조용히 성공으로 둔다. 여기서 실패를
            // 돌려주면 앱이 편집을 롤백할 수 있다.
            None => Ok(()),
        }
    }
}

/// `ITfEditSession`으로 감싼다.
pub fn session(work: impl FnOnce(u32) -> Result<()> + 'static) -> ITfEditSession {
    EditSession::new(work).into()
}
