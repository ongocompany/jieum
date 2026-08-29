//! 조합 종료 알림 수신자 (`ITfCompositionSink`).
//!
//! **왜 필수인가.** `StartComposition`이 이 객체를 요구한다(없으면 E_INVALIDARG).
//! 형식적인 요구가 아니다 — 조합을 끝내는 주체가 입력기만이 아니기 때문이다.
//! 사용자가 다른 곳을 클릭하거나, 앱이 문서를 갈아 끼우거나, 포커스가 옮겨 가면
//! **앱이** 조합을 강제 종료한다. 그때 이 알림이 오지 않으면 입력기는 이미 사라진
//! 조합을 계속 들고 있게 되고, 다음 키에서 죽은 범위를 건드린다.
//!
//! macOS IMK에는 이에 해당하는 것이 없다. 조합을 입력기가 소유하기 때문이다.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use windows::Win32::UI::TextServices::{
    ITfComposition, ITfCompositionSink, ITfCompositionSink_Impl,
};
use windows_core::{implement, Ref, Result};

#[implement(ITfCompositionSink)]
pub struct CompositionSink {
    composing: Rc<RefCell<Option<ITfComposition>>>,
    preedit: Rc<RefCell<String>>,
    /// 이 문맥이 임시 문서인가 (`TS_SS_TRANSITORY`).
    ///
    /// 임시 문서에서는 앱이 편집마다 조합을 정리한다 — **사용자가 입력을 그만둔 것이
    /// 아니다.** 그래서 여기서 조합 상태만 비우고 **입력 상태(`preedit`)는 남긴다.**
    /// 남기지 않으면 다음 키가 빈 상태에서 시작해 `ㅎ 하 한`이 줄줄이 박힌다.
    ///
    /// 임시 문서가 아닌 곳에서 조합이 끊기는 것은 뜻이 다르다 — 사용자가 다른 데를
    /// 클릭했거나 앱이 문서를 갈아 끼운 것이다. 그때는 입력 상태도 버려야 한다.
    transitory: Rc<Cell<bool>>,
    /// 앱이 조합을 끊은 횟수. **수신자는 조합마다 새로 만들어지므로** 이 값은
    /// 입력기 쪽이 들고 있어야 누적된다.
    ///
    /// 왜 세는가: 한 글자를 치는 동안 앱이 매번 조합을 끊으면 다음 키가 **새 조합을
    /// 처음부터** 시작해, 화면에는 `ㅎ 하 한`처럼 중간 상태가 줄줄이 남는다. 조합을
    /// 갈아 끼우는 코드가 틀린 것과 겉모습이 같지만 고칠 자리가 전혀 다르므로,
    /// 이 숫자 하나가 둘을 가른다.
    terminations: Rc<Cell<u32>>,
}

impl ITfCompositionSink_Impl for CompositionSink_Impl {
    fn OnCompositionTerminated(
        &self,
        _edit_cookie: u32,
        _composition: Ref<'_, ITfComposition>,
    ) -> Result<()> {
        let n = self.terminations.get() + 1;
        self.terminations.set(n);
        // 앞의 몇 번은 그대로 남기고 그 뒤로는 드문드문. **처음 한 번만 남기면 "가끔
        // 끊긴다"와 "키마다 끊긴다"가 구별되지 않는다** — 실제로 그 둘을 헷갈려
        // 한 번 헛짚었다. 남기는 것은 횟수뿐이라 몇 줄 더 나가도 위생에 문제가 없다.
        if n <= 3 || n % 50 == 0 {
            crate::log_line!("조합이 밖에서 종료됨 — 누적 {n}회");
        }
        crate::log_verbose!("조합이 밖에서 종료됨");
        *self.composing.borrow_mut() = None;
        if !self.transitory.get() {
            self.preedit.borrow_mut().clear();
        }
        Ok(())
    }
}

pub fn sink(
    composing: Rc<RefCell<Option<ITfComposition>>>,
    preedit: Rc<RefCell<String>>,
    transitory: Rc<Cell<bool>>,
    terminations: Rc<Cell<u32>>,
) -> ITfCompositionSink {
    CompositionSink {
        composing,
        preedit,
        transitory,
        terminations,
    }
    .into()
}
