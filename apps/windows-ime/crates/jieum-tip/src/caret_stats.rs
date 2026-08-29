//! 캐럿 좌표를 얻었는지, 못 얻었으면 **어느 단계에서** 막혔는지 센다.
//!
//! 후보 창은 캐럿 좌표가 있어야만 뜬다. 좌표가 없으면 한글은 그대로 쳐지고 제안만
//! 영영 안 나오는데, 지금까지는 그 이유가 로그에 남지 않았다 — `caret_rect`가 세
//! 단계(`GetActiveView` · `GetRange` · `GetTextExt`)를 한 덩어리로 삼키고 `Option`만
//! 돌려줬기 때문이다. 아래한글에서 후보가 안 뜨는 원인을 가르려면 그 셋을 갈라야 한다.
//!
//! 가르는 축은 둘이다:
//!
//! - **어느 단계인가** — `GetActiveView`부터 실패하면 호스트가 문서 뷰 자체를 안 주는
//!   것이고, `GetTextExt`만 실패하면 뷰는 있는데 위치를 모르는 것이다
//! - **무슨 코드인가** — `TS_E_NOLAYOUT`(0x80040300)은 "아직 배치를 모른다"는 뜻이라
//!   일시적이고, 다시 물으면 된다. 다른 코드는 호스트가 아예 답하지 않는 것이다
//!
//! ⚠️ **집계만 남기고 내용은 남기지 않는다.** 이 프로세스는 사용자가 치는 모든 것을
//! 본다. 여기서 로그로 나가는 것은 단계 이름·HRESULT·횟수·화면 좌표뿐이다.
//!
//! 처음 보는 사유는 **즉시** 한 줄 남기고(그 한 줄이 조사의 답이다), 그 뒤로는 조용히
//! 세다가 일정 간격으로만 합계를 낸다. 다 남기면 글자마다 한 줄씩 쌓여 로그가 못 쓰게 된다.

use jieum_candidates::ui_command::CaretRect;

use crate::log_line;

/// 캐럿 좌표를 물은 결과.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CaretOutcome {
    /// 좌표를 얻었다. 화면 좌표(픽셀).
    Ok {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    },
    /// 조합이 없어 물어보지도 못했다. 호스트 탓이 아니다.
    NoComposition,
    /// 편집 세션 신청 자체가 막혔다.
    EditSession(i32),
    /// `ITfContext::GetActiveView` 실패 — 호스트가 문서 뷰를 안 준다.
    ActiveView(i32),
    /// `ITfComposition::GetRange` 실패.
    Range(i32),
    /// `ITfContextView::GetTextExt` 실패 — 뷰는 있는데 위치를 모른다.
    TextExt(i32),
}

/// `TS_E_NOLAYOUT` — "그 범위의 배치를 아직 모른다". 일시적이다.
const TS_E_NOLAYOUT: i32 = 0x8004_0300u32 as i32;

impl CaretOutcome {
    /// 로그에 쓸 이름. 성공은 좌표까지 붙는다.
    fn label(&self) -> String {
        match *self {
            CaretOutcome::Ok {
                left,
                top,
                right,
                bottom,
            } => {
                format!("성공 ({left},{top} {}x{})", right - left, bottom - top)
            }
            CaretOutcome::NoComposition => "조합없음".into(),
            CaretOutcome::EditSession(code) => format!("편집세션 {}", hresult(code)),
            CaretOutcome::ActiveView(code) => format!("GetActiveView {}", hresult(code)),
            CaretOutcome::Range(code) => format!("GetRange {}", hresult(code)),
            CaretOutcome::TextExt(code) => format!("GetTextExt {}", hresult(code)),
        }
    }

    /// 합계에 쓸 이름. 성공은 좌표를 뺀다 — 좌표는 매번 다르므로 처음 것을 붙여 두면
    /// 나머지 99번도 거기 있었던 것처럼 읽힌다.
    fn summary_label(&self) -> String {
        match *self {
            CaretOutcome::Ok { .. } => "성공".into(),
            other => other.label(),
        }
    }

    /// 얻은 좌표. 실패면 없다.
    pub fn rect(&self) -> Option<CaretRect> {
        match *self {
            CaretOutcome::Ok {
                left,
                top,
                right,
                bottom,
            } => Some(CaretRect {
                left,
                top,
                right,
                bottom,
            }),
            _ => None,
        }
    }

    /// 같은 사유끼리 묶는 열쇠. 성공은 좌표가 매번 달라지므로 좌표를 빼고 묶는다 —
    /// 안 그러면 글자마다 "처음 보는 결과"가 되어 즉시 로그가 매번 나간다.
    fn key(&self) -> (u8, i32) {
        match *self {
            CaretOutcome::Ok { .. } => (0, 0),
            CaretOutcome::NoComposition => (1, 0),
            CaretOutcome::EditSession(code) => (2, code),
            CaretOutcome::ActiveView(code) => (3, code),
            CaretOutcome::Range(code) => (4, code),
            CaretOutcome::TextExt(code) => (5, code),
        }
    }
}

/// HRESULT를 사람이 읽을 수 있게. 아는 코드는 이름을 붙인다.
fn hresult(code: i32) -> String {
    if code == TS_E_NOLAYOUT {
        "TS_E_NOLAYOUT(0x80040300, 일시적)".into()
    } else {
        format!("0x{:08X}", code as u32)
    }
}

/// 몇 번마다 합계를 낼 것인가.
const SUMMARY_EVERY: u32 = 100;

/// 한 프로세스(=한 앱) 안의 집계.
///
/// 입력기는 DLL이라 호스트 앱마다 따로 적재된다 — 그래서 이 구조체 하나가 곧 한 앱의
/// 집계이고, 로그 줄머리의 pid가 앱을 가른다(활성화 때 실행 파일 이름도 한 줄 남긴다).
#[derive(Default)]
pub struct CaretStats {
    seen: Vec<((u8, i32), String, u32)>,
    total: u32,
}

impl CaretStats {
    pub fn record(&mut self, outcome: CaretOutcome) {
        let key = outcome.key();
        self.total += 1;

        match self.seen.iter_mut().find(|(k, _, _)| *k == key) {
            Some((_, _, count)) => *count += 1,
            None => {
                log_line!("캐럿: {} — 처음", outcome.label());
                self.seen.push((key, outcome.summary_label(), 1));
            }
        }

        if self.total % SUMMARY_EVERY == 0 {
            log_line!("캐럿 집계 ({}회): {}", self.total, self.summary());
        }
    }

    /// `사유 N회` 목록. 많은 것부터.
    pub fn summary(&self) -> String {
        let mut rows: Vec<&(_, String, u32)> = self.seen.iter().collect();
        rows.sort_by(|a, b| b.2.cmp(&a.2));
        rows.iter()
            .map(|(_, label, count)| format!("{label} {count}회"))
            .collect::<Vec<_>>()
            .join(" · ")
    }

    pub fn is_empty(&self) -> bool {
        self.total == 0
    }
}
