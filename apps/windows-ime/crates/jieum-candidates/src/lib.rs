//! 후보 목록의 상태 — 순수 로직. 창도 COM도 모른다.
//!
//! macOS 셸의 `CandidateModel.swift`와 같은 자리이고 규칙도 같다. 플랫폼 의존이 없으므로
//! **리눅스에서 `cargo test`로 그대로 돌아간다** — 윈도우 VM을 거치지 않고 검증되는 첫
//! 조각이다.
//!
//! ## 편집기 팝업과 같은 것, 다른 것
//!
//! **같은 것**: 3그룹 정체성(현대어 / 고어·전문어 / 인명용)과 "긴 매칭이 먼저"라는 순서.
//! 이것이 지음의 제품 정체성이라 플랫폼이 달라져도 유지한다.
//!
//! **다른 것**: 편집기는 가로로 펼치고 접는 2단 구조지만, 시스템 입력기는 커서 옆에 뜨는
//! 좁은 목록에 숫자키로 고른다.
//!
//! ⚠️ 이 자리에 **"세로 목록이 관례다(일본어·중국어 입력기 전부)"**라고 적혀 있었으나
//! 사실이 아니다. 세로는 일본어 쪽 관례이고, **중국어 병음 입력기는 가로 한 줄이 다수**다
//! (Sogou·微软拼音). macOS 셸이 2026-08-05에 가로로 바꾸며 바로잡았고 윈도우도 따라간다 —
//! 근거가 틀린 채로 남아 있으면 다음 사람이 그 결정을 되돌린다. 가로로 간 이유는
//! `jieum-tip-host`의 `window.rs` 머리말에 있다.

pub mod ui_channel;
pub mod ui_command;

use serde::{Deserialize, Serialize};

/// 그룹의 층. 조회 응답의 `type`에 대응한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupKind {
    Normal,
    Archaic,
    Inmyeong,
}

impl GroupKind {
    pub fn from_wire(value: Option<&str>) -> Self {
        match value {
            Some("archaic") => GroupKind::Archaic,
            Some("inmyeong") => GroupKind::Inmyeong,
            _ => GroupKind::Normal,
        }
    }
}

/// 조회 응답의 후보 하나에서 화면에 필요한 것만.
#[derive(Debug, Clone)]
pub struct Entry {
    pub hanja: String,
    /// 훈(뜻) — 1글자 한자에만 있다
    pub meaning: Option<String>,
    /// 사용자가 낱자를 이어 만든 조합인가 (와이어의 `source == "user"`)
    #[allow(dead_code)]
    pub user_word: bool,
}

/// 표제어 하나에 대한 후보 묶음.
#[derive(Debug, Clone)]
pub struct Group {
    pub word: String,
    pub kind: GroupKind,
    /// 이 조회 시점의 문맥 이름. 확정에 **그대로** 실어 보낸다
    pub context_key: Option<String>,
    pub entries: Vec<Entry>,
}

/// 목록에 펼쳐진 항목 하나.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CandidateItem {
    /// 이 후보가 대체할 한글 표제어. "발전소"를 치다 "발전"을 고를 수도 있다
    pub word: String,
    pub hanja: String,
    pub meaning: Option<String>,
    pub context_key: Option<String>,
    /// 이 항목부터 시작하는 그룹의 머리말 (그룹이 바뀌는 첫 항목에만)
    pub group_header: Option<String>,
    /**
     사용자가 낱자를 이어 만든 조합인가.

     「이 후보 잊기」를 **사용자 조합에만** 켜기 위한 것이다. 사전 후보를 잊게 두면
     사용자는 지운 줄 알았는데 계속 나오는 것을 보게 된다 — 지울 수 있는 것은 우리가
     배운 것뿐이다.
     */
    pub user_word: bool,
}

/// 한 쪽에 보일 후보 수. 숫자키 1~9와 맞춘다.
pub const PAGE_SIZE: usize = 9;

#[derive(Debug, Clone, Default)]
pub struct CandidateModel {
    items: Vec<CandidateItem>,
    /// 선택된 항목 (전체 목록 기준)
    selected: usize,
    /// 후보를 전부 펼쳐 보이는가.
    ///
    /// 기본은 접힘 — 가로 한 줄에 9개다. `↓`를 누르면 나머지가 아래로 쫙 펼쳐진다.
    /// 접힌 줄 뒤에 후보가 더 있다는 것을 쪽 표시(`2/3`) 하나로만 알리는 것은 약하다.
    ///
    /// 펼침은 **이 조회에 한정된다.** 새 글자를 치면 모델이 새로 만들어지므로 저절로
    /// 접힌다 — 한 번 펼쳤다고 그 뒤로 계속 큰 창이 뜨면 가림 문제가 되돌아온다.
    expanded: bool,
}

impl CandidateModel {
    /// 조회 응답을 목록으로 편다.
    ///
    /// 그룹 순서는 엔진이 준 그대로 둔다 — "긴 매칭 우선, 그 안에서 층 순서"로 이미
    /// 정렬돼 있고, **그 순서 자체가 랭킹의 결론이다.** 셸이 다시 정렬하면 안 된다.
    pub fn from_groups(groups: &[Group]) -> Self {
        let mut items = Vec::new();
        let mut last_header: Option<String> = None;

        for group in groups {
            let header = header_for(group);
            for (index, entry) in group.entries.iter().enumerate() {
                // 머리말은 그룹의 첫 항목에만, 그리고 앞 그룹과 다를 때만 붙인다
                let show_header = index == 0 && Some(&header) != last_header.as_ref();
                items.push(CandidateItem {
                    word: group.word.clone(),
                    hanja: entry.hanja.clone(),
                    meaning: entry.meaning.clone(),
                    context_key: group.context_key.clone(),
                    group_header: show_header.then(|| header.clone()),
                    user_word: entry.user_word,
                });
                if show_header {
                    last_header = Some(header.clone());
                }
            }
        }

        Self {
            items,
            selected: 0,
            expanded: false,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// 지금 보이는 쪽의 시작 위치
    pub fn page_start(&self) -> usize {
        (self.selected / PAGE_SIZE) * PAGE_SIZE
    }

    /// 지금 화면에 있는 항목들의 범위. 펼치면 전부, 접히면 지금 쪽만
    pub fn visible_range(&self) -> std::ops::Range<usize> {
        if self.expanded {
            return 0..self.items.len();
        }
        let start = self.page_start();
        start..(start + PAGE_SIZE).min(self.items.len())
    }

    pub fn visible_items(&self) -> &[CandidateItem] {
        &self.items[self.visible_range()]
    }

    pub fn is_expanded(&self) -> bool {
        self.expanded
    }

    /// 보이는 쪽 안에서 선택된 위치 (0-기반)
    pub fn selected_in_page(&self) -> usize {
        self.selected - self.page_start()
    }

    /// **화면에 그려지는 것들 중** 선택된 자리 (0-기반).
    ///
    /// 접힌 상태에서는 `selected_in_page`와 같지만 펼치면 다르다 — 후보 창은 보이는
    /// 것만 받으므로 그 안에서의 자리로 골라야 한다. 쪽 기준으로 보내면 펼친 상태에서
    /// **줄마다 같은 자리가 선택된 것처럼 보인다.**
    pub fn selected_in_view(&self) -> usize {
        self.selected - self.visible_range().start
    }

    /// 화면에 보이는 각 항목의 번호(1~9).
    ///
    /// 번호는 **줄 안에서** 1~9다. 펼친 상태에서도 숫자키가 「지금 선택된 줄의 N번」으로
    /// 그대로 통하므로 줄마다 되풀이된다.
    pub fn visible_numbers(&self) -> Vec<usize> {
        self.visible_range()
            .map(|index| index % PAGE_SIZE + 1)
            .collect()
    }

    pub fn total_pages(&self) -> usize {
        ((self.items.len() + PAGE_SIZE - 1) / PAGE_SIZE).max(1)
    }

    pub fn current_page(&self) -> usize {
        self.page_start() / PAGE_SIZE
    }

    pub fn selected_item(&self) -> Option<&CandidateItem> {
        self.items.get(self.selected)
    }

    // ---------------------------------------------------------------- 이동

    /// ⚠️ **이름에 방향이 없다.** 후보 창이 가로 한 줄이라 `move_down`/`move_up`이던 옛
    /// 이름은 거짓말이다 — 다음 후보는 아래가 아니라 오른쪽에 있다. 세로 목록 시절의
    /// 이름을 남겨 두면 키 배정이 다시 세로로 되돌아간다(macOS 셸에서 실제로 그랬다:
    /// 창만 가로로 바꾸고 키를 그대로 둬서 `←/→`가 안 먹는 채로 하루를 보냈다).
    pub fn move_next(&mut self) {
        if self.items.is_empty() {
            return;
        }
        self.selected = (self.selected + 1) % self.items.len();
    }

    pub fn move_previous(&mut self) {
        if self.items.is_empty() {
            return;
        }
        self.selected = (self.selected + self.items.len() - 1) % self.items.len();
    }

    /// 펼친다. 이미 펼쳐져 있으면 아랫줄로 내려간다.
    pub fn expand_or_move_down(&mut self) {
        if self.items.is_empty() {
            return;
        }
        if !self.expanded {
            self.expanded = true;
            return;
        }
        let next = self.selected + PAGE_SIZE;
        if next < self.items.len() {
            self.selected = next;
        }
    }

    /// 윗줄로 올라간다. 첫 줄에서 부르면 접는다.
    pub fn collapse_or_move_up(&mut self) {
        if self.items.is_empty() || !self.expanded {
            return;
        }
        if self.selected >= PAGE_SIZE {
            self.selected -= PAGE_SIZE;
        } else {
            self.expanded = false;
        }
    }

    /// 다음 쪽 첫 항목으로. 마지막 쪽이면 첫 쪽으로 돈다
    pub fn next_page(&mut self) {
        if self.items.is_empty() {
            return;
        }
        let next = self.page_start() + PAGE_SIZE;
        self.selected = if next < self.items.len() { next } else { 0 };
    }

    pub fn previous_page(&mut self) {
        if self.items.is_empty() {
            return;
        }
        self.selected = if self.page_start() >= PAGE_SIZE {
            self.page_start() - PAGE_SIZE
        } else {
            (self.total_pages() - 1) * PAGE_SIZE
        };
    }

    /// 숫자키로 고른다.
    ///
    /// `number`는 화면에 보이는 번호 그대로 1~9다. 그 자리에 후보가 없으면 `None`이고,
    /// **이때 입력기는 그 키를 먹지 말고 호스트 앱에 넘겨야 한다** — 후보가 3개인데 5를
    /// 눌렀다면 사용자는 숫자 5를 치려던 것이다.
    pub fn item_for_number(&self, number: usize) -> Option<&CandidateItem> {
        if !(1..=PAGE_SIZE).contains(&number) {
            return None;
        }
        self.items.get(self.page_start() + number - 1)
    }

    pub fn select_number(&mut self, number: usize) -> Option<&CandidateItem> {
        if self.item_for_number(number).is_none() {
            return None;
        }
        self.selected = self.page_start() + number - 1;
        self.items.get(self.selected)
    }
}

/// 그룹 머리말.
///
/// 표제어가 여럿이면(발전소·발전·발) 어느 글자에 대한 후보인지가 보여야 한다 —
/// "발전소"를 치다 "발"의 후보를 고르면 세 글자 중 한 글자만 바뀌기 때문이다.
fn header_for(group: &Group) -> String {
    match group.kind {
        GroupKind::Archaic => format!("{} · 고어·전문어", group.word),
        GroupKind::Inmyeong => format!("{} · 인명용", group.word),
        GroupKind::Normal => group.word.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(hanja: &str) -> Entry {
        Entry {
            hanja: hanja.into(),
            meaning: None,
            user_word: false,
        }
    }

    /// 사용자가 낱자를 이어 만든 조합. 「이 후보 잊기」가 이것에만 켜진다.
    fn user_entry(hanja: &str) -> Entry {
        Entry {
            hanja: hanja.into(),
            meaning: None,
            user_word: true,
        }
    }

    #[test]
    fn 사용자_조합_표시가_항목까지_간다() {
        let groups = vec![Group {
            word: "김홍경".into(),
            kind: GroupKind::Normal,
            context_key: None,
            entries: vec![user_entry("金洪京")],
        }];
        let model = CandidateModel::from_groups(&groups);
        assert!(model.selected_item().unwrap().user_word, "사용자 조합이어야 한다");

        let plain = CandidateModel::from_groups(&[group("경제", GroupKind::Normal, &["經濟"])]);
        assert!(!plain.selected_item().unwrap().user_word, "사전 후보는 아니어야 한다");
    }

    fn group(word: &str, kind: GroupKind, hanja: &[&str]) -> Group {
        Group {
            word: word.into(),
            kind,
            context_key: None,
            entries: hanja.iter().map(|h| entry(h)).collect(),
        }
    }

    #[test]
    fn 머리말은_그룹의_첫_항목에만_붙는다() {
        let model = CandidateModel::from_groups(&[group(
            "한자",
            GroupKind::Normal,
            &["漢字", "漢子"],
        )]);
        assert_eq!(model.visible_items()[0].group_header.as_deref(), Some("한자"));
        assert_eq!(model.visible_items()[1].group_header, None);
    }

    #[test]
    fn 층이_다르면_머리말이_구분된다() {
        let model = CandidateModel::from_groups(&[
            group("한자", GroupKind::Normal, &["漢字"]),
            group("한자", GroupKind::Archaic, &["閑者"]),
        ]);
        assert_eq!(model.visible_items()[0].group_header.as_deref(), Some("한자"));
        assert_eq!(
            model.visible_items()[1].group_header.as_deref(),
            Some("한자 · 고어·전문어")
        );
    }

    #[test]
    fn 표제어가_다르면_각각_머리말이_붙는다() {
        // "발전소"를 치다 "발전"을 고를 수 있어야 하고, 어느 글자의 후보인지 보여야 한다.
        let model = CandidateModel::from_groups(&[
            group("발전소", GroupKind::Normal, &["發電所"]),
            group("발전", GroupKind::Normal, &["發展", "發電"]),
        ]);
        let items = model.visible_items();
        assert_eq!(items[0].group_header.as_deref(), Some("발전소"));
        assert_eq!(items[1].group_header.as_deref(), Some("발전"));
        assert_eq!(items[2].group_header, None);
        // 고른 후보가 어느 표제어를 대체하는지가 항목마다 살아 있어야 한다
        assert_eq!(items[0].word, "발전소");
        assert_eq!(items[1].word, "발전");
    }

    #[test]
    fn 엔진이_준_순서를_바꾸지_않는다() {
        let model = CandidateModel::from_groups(&[group(
            "한자",
            GroupKind::Normal,
            &["漢字", "韓資", "漢子"],
        )]);
        let hanja: Vec<&str> = model
            .visible_items()
            .iter()
            .map(|i| i.hanja.as_str())
            .collect();
        assert_eq!(hanja, vec!["漢字", "韓資", "漢子"]);
    }

    #[test]
    fn 한_쪽에_아홉_개까지만_보인다() {
        let hanja: Vec<String> = (0..20).map(|i| format!("字{i}")).collect();
        let refs: Vec<&str> = hanja.iter().map(|s| s.as_str()).collect();
        let model = CandidateModel::from_groups(&[group("자", GroupKind::Normal, &refs)]);
        assert_eq!(model.visible_items().len(), PAGE_SIZE);
        assert_eq!(model.total_pages(), 3);
    }

    #[test]
    fn 아래로_넘기면_다음_쪽으로_따라간다() {
        let hanja: Vec<String> = (0..12).map(|i| format!("字{i}")).collect();
        let refs: Vec<&str> = hanja.iter().map(|s| s.as_str()).collect();
        let mut model = CandidateModel::from_groups(&[group("자", GroupKind::Normal, &refs)]);

        for _ in 0..PAGE_SIZE {
            model.move_next();
        }
        assert_eq!(model.current_page(), 1);
        assert_eq!(model.selected_in_page(), 0);
        assert_eq!(model.visible_items().len(), 3);
    }

    #[test]
    fn 목록_끝에서_아래로_가면_처음으로_돈다() {
        let mut model =
            CandidateModel::from_groups(&[group("한자", GroupKind::Normal, &["漢字", "韓資"])]);
        model.move_next();
        model.move_next();
        assert_eq!(model.selected_item().unwrap().hanja, "漢字");
    }

    #[test]
    fn 처음에서_위로_가면_끝으로_돈다() {
        let mut model =
            CandidateModel::from_groups(&[group("한자", GroupKind::Normal, &["漢字", "韓資"])]);
        model.move_previous();
        assert_eq!(model.selected_item().unwrap().hanja, "韓資");
    }

    #[test]
    fn 없는_번호를_고르면_거절한다() {
        // 후보가 2개인데 5를 눌렀다면 사용자는 숫자 5를 치려던 것이다. 먹으면 안 된다.
        let mut model =
            CandidateModel::from_groups(&[group("한자", GroupKind::Normal, &["漢字", "韓資"])]);
        assert!(model.item_for_number(5).is_none());
        assert!(model.select_number(5).is_none());
        assert_eq!(model.selected_in_page(), 0);
    }

    #[test]
    fn 숫자키는_보이는_쪽_기준이다() {
        let hanja: Vec<String> = (0..12).map(|i| format!("字{i}")).collect();
        let refs: Vec<&str> = hanja.iter().map(|s| s.as_str()).collect();
        let mut model = CandidateModel::from_groups(&[group("자", GroupKind::Normal, &refs)]);
        model.next_page();
        // 두 번째 쪽의 1번은 전체 목록의 10번째다
        assert_eq!(model.select_number(1).unwrap().hanja, "字9");
    }

    #[test]
    fn 펼치면_전부_보이고_접으면_한_쪽만_보인다() {
        let hanja: Vec<String> = (0..12).map(|i| format!("字{i}")).collect();
        let refs: Vec<&str> = hanja.iter().map(|s| s.as_str()).collect();
        let mut model = CandidateModel::from_groups(&[group("자", GroupKind::Normal, &refs)]);

        assert_eq!(model.visible_items().len(), PAGE_SIZE);
        model.expand_or_move_down();
        assert!(model.is_expanded());
        assert_eq!(model.visible_items().len(), 12);

        // 첫 줄에서 위로 가면 접힌다
        model.collapse_or_move_up();
        assert!(!model.is_expanded());
        assert_eq!(model.visible_items().len(), PAGE_SIZE);
    }

    #[test]
    fn 펼친_상태에서_아래위는_줄을_옮긴다() {
        let hanja: Vec<String> = (0..12).map(|i| format!("字{i}")).collect();
        let refs: Vec<&str> = hanja.iter().map(|s| s.as_str()).collect();
        let mut model = CandidateModel::from_groups(&[group("자", GroupKind::Normal, &refs)]);

        model.expand_or_move_down(); // 펼치기만
        model.expand_or_move_down(); // 아랫줄로
        assert_eq!(model.selected_item().unwrap().hanja, "字9");
        assert!(model.is_expanded());

        model.collapse_or_move_up(); // 윗줄로 (아직 안 접힌다)
        assert!(model.is_expanded());
        assert_eq!(model.selected_item().unwrap().hanja, "字0");
    }

    #[test]
    fn 펼친_상태의_선택은_보이는_것_기준이다() {
        let hanja: Vec<String> = (0..12).map(|i| format!("字{i}")).collect();
        let refs: Vec<&str> = hanja.iter().map(|s| s.as_str()).collect();
        let mut model = CandidateModel::from_groups(&[group("자", GroupKind::Normal, &refs)]);

        model.expand_or_move_down();
        model.expand_or_move_down(); // 10번째 항목 (둘째 줄 1번)
        // 쪽 기준(0)으로 보내면 후보 창이 **줄마다 첫 칸**을 선택된 것처럼 그린다.
        assert_eq!(model.selected_in_page(), 0);
        assert_eq!(model.selected_in_view(), 9);
    }

    #[test]
    fn 번호는_줄마다_1부터_다시_센다() {
        let hanja: Vec<String> = (0..12).map(|i| format!("字{i}")).collect();
        let refs: Vec<&str> = hanja.iter().map(|s| s.as_str()).collect();
        let mut model = CandidateModel::from_groups(&[group("자", GroupKind::Normal, &refs)]);

        model.expand_or_move_down();
        let numbers = model.visible_numbers();
        assert_eq!(numbers.len(), 12);
        assert_eq!(&numbers[..PAGE_SIZE], &[1, 2, 3, 4, 5, 6, 7, 8, 9]);
        // 둘째 줄도 1부터 — 숫자키가 「지금 선택된 줄의 N번」으로 통해야 한다
        assert_eq!(&numbers[PAGE_SIZE..], &[1, 2, 3]);
    }

    #[test]
    fn 빈_목록에서_이동해도_죽지_않는다() {
        let mut model = CandidateModel::default();
        model.move_next();
        model.move_previous();
        model.next_page();
        model.previous_page();
        assert!(model.is_empty());
        assert!(model.selected_item().is_none());
    }
}
