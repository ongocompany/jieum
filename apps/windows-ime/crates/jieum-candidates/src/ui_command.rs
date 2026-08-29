//! 입력기(TIP)와 후보 창 프로세스 사이의 계약.
//!
//! **상태는 전부 입력기가 쥔다.** 이 프로세스는 그리기만 하는 종이다 — 무엇이 선택돼
//! 있는지, 몇 쪽인지, 키를 어떻게 처리할지는 전부 입력기가 정하고 결과만 여기로 온다.
//! 그래야 키 처리와 화면이 어긋나지 않는다 (키는 입력기에만 오기 때문이다).
//!
//! Chewing의 `chewing_tip_host`가 같은 구조다. 그쪽은 varlink를 쓰지만 우리는 JSON을
//! 공유 메모리에 놓고 창 메시지로 알리기만 한다 — 파이프 서버를 세우지 않아도 되고,
//! 둘 다 같은 로그온 세션 안에서만 오가므로 사용자 격리가 공짜로 따라온다.
//! 여기는 **무엇을 보내는가**이고, 어떻게 놓고 알리는가는 [`crate::ui_channel`]에 있다.

use serde::{Deserialize, Serialize};

/// 캐럿(조합 중인 글자)의 화면 좌표. 후보 창을 놓을 기준이다.
///
/// 호스트 앱이 알려 주지 못하면 `None`이고, 그때는 창을 띄우지 않는다 — 화면 왼쪽 위
/// 구석에 뜬 후보 창은 없느니만 못하다.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct CaretRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Row {
    pub hanja: String,
    /// 훈(뜻) — 1글자 한자에만 있다
    #[serde(default)]
    pub meaning: Option<String>,
    /// 이 항목부터 그룹이 바뀐다는 표시 (그룹의 첫 항목에만 있다).
    ///
    /// 후보 창은 **내용을 그리지 않고 경계를 긋는 데만** 쓴다 — 가로 한 줄에서는
    /// 머리말을 넣을 자리가 없다. 대신 표제어가 바뀌면 실선, 층만 바뀌면 점선이다.
    #[serde(default)]
    pub header: Option<String>,
    /// 이 후보가 대체할 한글 표제어. 표제어가 바뀌는 칸 앞에 다시 적어 준다 —
    /// "발전소"를 치다 "발"의 후보를 고르면 세 글자 중 하나만 바뀌기 때문이다.
    #[serde(default)]
    pub word: String,
    /// 화면에 보이는 번호(1~9). 숫자키와 그대로 맞는다.
    ///
    /// 입력기가 계산해 실어 보낸다. 후보 창이 자리로 되짚으면 펼친 상태에서 어긋난다 —
    /// 번호는 줄마다 1부터 다시 세기 때문이다.
    #[serde(default)]
    pub number: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Command {
    /// 후보를 보여 준다.
    #[serde(rename_all = "camelCase")]
    Show {
        caret: CaretRect,
        rows: Vec<Row>,
        /// **보내진 줄들 중** 선택된 자리 (0-기반). 쪽 기준이 아니다 — 펼친 상태에서는
        /// 줄마다 번호가 되풀이되므로 쪽 기준으로 보내면 여러 칸이 동시에 선택돼 보인다.
        selected: usize,
        /// 1-기반 쪽 번호
        page: usize,
        total_pages: usize,
        /// 펼친 상태인가. 펼치면 9개씩 여러 줄로 접어 그리고 쪽 표시를 지운다
        /// (전부 보이므로 남은 쪽이 없다).
        #[serde(default)]
        expanded: bool,
        /// 커서 **위**에 놓아 달라는 요청. 사용자가 `Shift+↑/↓`로 정하고 앱별로 기억한다.
        #[serde(default)]
        prefer_above: bool,
    },
    /// 모드가 바뀐 것을 커서 옆에 잠깐 보여 준다 (`한글` / `漢字`).
    ///
    /// 후보와 **다른 명령**인 이유: 모드는 고를 수 있는 것이 아니고 스스로 사라진다.
    /// `Show`로 흉내 내면 번호가 붙어 고를 수 있는 것처럼 보이고, 사라지는 시점을
    /// 입력기가 재야 해서 타이머가 엉뚱한 쪽에 생긴다.
    #[serde(rename_all = "camelCase")]
    Mode {
        caret: CaretRect,
        /// 보여 줄 글자. 지금은 `한글` 또는 `漢字`
        label: String,
        #[serde(default)]
        prefer_above: bool,
    },
    /// 후보를 감춘다.
    Hide,
    /// 이 프로세스를 끝낸다. 입력기가 내려갈 때 보낸다.
    Quit,
}

impl Command {
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    pub fn decode(bytes: &[u8]) -> Option<Self> {
        serde_json::from_slice(bytes).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 명령이_왕복한다() {
        let cmd = Command::Show {
            caret: CaretRect {
                left: 10,
                top: 20,
                right: 12,
                bottom: 40,
            },
            rows: vec![Row {
                hanja: "漢字".into(),
                meaning: None,
                header: Some("한자".into()),
                word: "한자".into(),
                number: 1,
            }],
            selected: 0,
            page: 1,
            total_pages: 1,
            expanded: false,
            prefer_above: false,
        };
        assert_eq!(Command::decode(&cmd.encode()), Some(cmd));
    }

    #[test]
    fn 감추기와_끝내기도_왕복한다() {
        assert_eq!(Command::decode(&Command::Hide.encode()), Some(Command::Hide));
        assert_eq!(Command::decode(&Command::Quit.encode()), Some(Command::Quit));
    }

    #[test]
    fn 쓰레기를_받으면_거절한다() {
        assert!(Command::decode(b"not json").is_none());
        assert!(Command::decode(r#"{"op":"모르는것"}"#.as_bytes()).is_none());
    }
}
