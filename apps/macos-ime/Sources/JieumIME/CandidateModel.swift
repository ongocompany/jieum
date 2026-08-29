import Foundation

/**
 후보 목록의 상태 (순수 로직 — AppKit에 의존하지 않는다)

 조회 응답의 그룹들을 한 줄짜리 목록으로 펴고, 선택과 쪽 넘김을 관리한다.
 그리기와 분리해 두는 이유는 이 부분이 시험 가능해야 하기 때문이다 — 창을 띄우지
 않고 `--test-candidates`로 돌린다.

 ## 편집기 팝업과 같은 것, 다른 것
 **같은 것**: 3그룹(현대어 / 고어·전문어 / 인명용)과 "긴 매칭이 먼저"라는 순서.

 **다른 것**: 편집기는 가로로 펼치고 접는 2단 구조지만, 시스템 입력기는 커서 옆에
 뜨는 좁은 목록에 숫자키로 고른다. 화면 어느 앱 위에든 떠야 하므로 좁고 예측 가능한
 모양이 낫다.

 가로 한 줄을 쓰는 이유는 `CandidateWindow`에 설명되어 있다.
 */
struct CandidateItem {
    /// 이 후보가 대체할 한글 표제어. "발전소"를 치다 "발전"을 고를 수도 있다
    let word: String
    let hanja: String
    /// 훈(뜻) — 1글자 한자에만 있다
    let meaning: String?
    /// 이 조회 시점의 문맥 이름. 확정에 **그대로** 실어 보낸다
    let contextKey: String?
    /// 이 항목부터 시작하는 그룹의 머리말 (그룹이 바뀌는 첫 항목에만)
    let groupHeader: String?
    /**
     사용자가 낱자를 이어 만든 조합인가

     「이 후보 잊기」를 **사용자 조합에만** 켜기 위한 것이다. 사전 후보를 잊게 두면
     사용자가 지운 줄 알고 계속 나오는 것을 보게 된다 — 지울 수 있는 것은 우리가
     배운 것뿐이다.
     */
    let isUserWord: Bool
}

struct CandidateModel {
    /// 한 쪽에 보일 후보 수. 숫자키 1~9와 맞춘다
    static let pageSize = 9

    private(set) var items: [CandidateItem] = []
    /// 선택된 항목 (전체 목록 기준)
    private(set) var selected = 0

    /**
     후보를 전부 펼쳐 보이는가

     기본은 접힘 — 가로 한 줄에 9개다. `↓`를 누르면 나머지가 아래로 펼쳐진다.
     접힌 줄에 안 보이는 후보가 있다는 것을
     사용자가 알 길이 쪽 표시(`2/3`)뿐이었고, 그것만으로는 "더 있다"가 잘 안 읽힌다.

     펼침은 **이 조회에 한정된다.** 새 글자를 치면 모델이 새로 만들어지므로 저절로
     접힌다 — 한 번 펼쳤다고 그 뒤로 계속 큰 창이 뜨면 가림 문제가 되돌아온다.
     */
    private(set) var expanded = false

    var isEmpty: Bool { items.isEmpty }

    /// 지금 보이는 쪽의 시작 위치. 펼친 상태에서는 **선택된 줄**의 시작이기도 하다
    var pageStart: Int { (selected / Self.pageSize) * Self.pageSize }

    /// 지금 화면에 있는 항목들의 범위. 펼치면 전부, 접히면 지금 쪽만
    var visibleRange: Range<Int> {
        if expanded { return 0..<items.count }
        return pageStart..<min(pageStart + Self.pageSize, items.count)
    }

    /// 지금 보이는 항목들
    var visibleItems: ArraySlice<CandidateItem> { items[visibleRange] }

    /// 보이는 쪽 안에서 선택된 위치 (0-기반)
    var selectedInPage: Int { selected - pageStart }

    /// 펼쳤을 때 몇 줄이 되는가
    var rowCount: Int { max(1, (items.count + Self.pageSize - 1) / Self.pageSize) }

    var totalPages: Int {
        max(1, (items.count + Self.pageSize - 1) / Self.pageSize)
    }

    var currentPage: Int { pageStart / Self.pageSize }

    var selectedItem: CandidateItem? {
        items.indices.contains(selected) ? items[selected] : nil
    }

    // MARK: - 만들기

    /**
     조회 응답을 목록으로 편다.

     그룹 순서는 core가 준 그대로 둔다 — "긴 매칭 우선, 그 안에서 층 순서"로 이미
     정렬돼 있고, 그 순서 자체가 랭킹의 결론이다. 셸이 다시 정렬하면 안 된다.
     */
    static func from(groups: [WireLookupGroup]) -> CandidateModel {
        var model = CandidateModel()
        var lastHeader: String?

        for group in groups {
            let header = Self.header(for: group)
            for (index, candidate) in group.candidates.enumerated() {
                // 머리말은 그룹의 첫 항목에만, 그리고 앞 그룹과 다를 때만 붙인다
                let showHeader = index == 0 && header != lastHeader
                model.items.append(
                    CandidateItem(
                        word: group.word,
                        hanja: candidate.hanja,
                        meaning: candidate.meaning,
                        contextKey: group.contextKey,
                        groupHeader: showHeader ? header : nil,
                        isUserWord: candidate.source == "user"))
                if showHeader { lastHeader = header }
            }
        }
        return model
    }

    /**
     그룹 머리말

     표제어가 여럿이면(발전소·발전·발) 어느 글자에 대한 후보인지가 보여야 한다 —
     "발전소"를 치다 "발"의 후보를 고르면 세 글자 중 한 글자만 바뀌기 때문이다.
     */
    private static func header(for group: WireLookupGroup) -> String {
        switch group.type {
        case "archaic": return "\(group.word) · 고어·전문어"
        case "inmyeong": return "\(group.word) · 인명용"
        default: return group.word
        }
    }

    // MARK: - 이동

    /**
     ⚠️ 이름에 방향이 없다. 후보창이 **가로 한 줄**이라 `moveDown`/`moveUp`이던 옛 이름은
     이제 거짓말이다 — 다음 후보는 아래가 아니라 오른쪽에 있다. 세로 목록 시절의 이름을
     남겨 두면 키 배정이 다시 세로로 되돌아간다(실제로 2026-08-05에 창만 가로로 바꾸고
     키는 세로인 채로 두어 `←/→`가 안 먹는 상태로 하루를 보냈다).
     */
    mutating func moveNext() {
        guard !items.isEmpty else { return }
        selected = (selected + 1) % items.count
    }

    mutating func movePrevious() {
        guard !items.isEmpty else { return }
        selected = (selected - 1 + items.count) % items.count
    }

    // MARK: - 펼침

    /// 펼친다. 이미 펼쳐져 있으면 아랫줄로 내려간다
    mutating func expandOrMoveDown() {
        guard !items.isEmpty else { return }
        if !expanded {
            expanded = true
            return
        }
        let next = selected + Self.pageSize
        if next < items.count { selected = next }
    }

    /// 윗줄로 올라간다. 첫 줄에서 부르면 접는다
    mutating func collapseOrMoveUp() {
        guard !items.isEmpty, expanded else { return }
        if selected >= Self.pageSize {
            selected -= Self.pageSize
        } else {
            expanded = false
        }
    }

    /// 다음 쪽 첫 항목으로. 마지막 쪽이면 첫 쪽으로 돈다
    mutating func nextPage() {
        guard !items.isEmpty else { return }
        let next = pageStart + Self.pageSize
        selected = next < items.count ? next : 0
    }

    mutating func previousPage() {
        guard !items.isEmpty else { return }
        selected = pageStart >= Self.pageSize ? pageStart - Self.pageSize
            : (totalPages - 1) * Self.pageSize
    }

    /**
     숫자키로 고른다.

     - Parameter number: 1~9 (화면에 보이는 번호 그대로)
     - Returns: 그 자리에 후보가 있으면 해당 항목. 없으면 nil — 이때 셸은 그 키를
       먹지 말고 호스트 앱에 넘겨야 한다. 후보가 3개인데 5를 눌렀다면 사용자는
       숫자 5를 치려던 것이다.
     */
    func item(forNumber number: Int) -> CandidateItem? {
        guard (1...Self.pageSize).contains(number) else { return nil }
        let index = pageStart + number - 1
        return items.indices.contains(index) ? items[index] : nil
    }

    mutating func select(number: Int) -> CandidateItem? {
        guard let item = item(forNumber: number) else { return nil }
        selected = pageStart + number - 1
        return item
    }
}
