/** 후보 팝업의 키보드 탐색 상태 */
export interface CandidateNavigationState {
  expanded: boolean;
  activeRow: number;
  activeCol: number;
}

/** 현재 후보 배치 */
export interface CandidateNavigationLayout {
  /** 접힘 상태에서 보이는 후보 수 */
  collapsedCount: number;
  /** 펼침 상태의 행별 후보 수 */
  rowSizes: readonly number[];
}

export type CandidateNavigationKey =
  | 'ArrowDown'
  | 'ArrowUp'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'Enter';

export interface CandidateNavigationTransition {
  state: CandidateNavigationState;
  /** Enter로 확정할 전체 후보 인덱스. 이동 키이면 null. */
  commitIndex: number | null;
}

function clampColumn(column: number, rowSize: number): number {
  return Math.max(0, Math.min(column, rowSize - 1));
}

/** 현재 행/열을 전체 후보 인덱스로 변환한다. */
export function resolveCandidateIndex(
  state: CandidateNavigationState,
  layout: CandidateNavigationLayout,
): number | null {
  if (!state.expanded) {
    if (state.activeCol < 0 || state.activeCol >= layout.collapsedCount) return null;
    return state.activeCol;
  }

  const rowSize = layout.rowSizes[state.activeRow];
  if (rowSize === undefined || state.activeCol < 0 || state.activeCol >= rowSize) return null;

  let offset = 0;
  for (let row = 0; row < state.activeRow; row++) {
    offset += layout.rowSizes[row] ?? 0;
  }
  return offset + state.activeCol;
}

/**
 * 후보 팝업의 방향키/Enter 상태 전이.
 *
 * DOM이나 IME 조합 상태를 참조하지 않으므로 조합/비조합 키 이벤트가 같은
 * 탐색 규칙을 공유할 수 있다.
 */
export function transitionCandidateNavigation(
  state: CandidateNavigationState,
  key: CandidateNavigationKey,
  layout: CandidateNavigationLayout,
): CandidateNavigationTransition {
  if (key === 'Enter') {
    return { state, commitIndex: resolveCandidateIndex(state, layout) };
  }

  if (key === 'ArrowDown') {
    if (!state.expanded) {
      const firstRowSize = layout.rowSizes[0];
      if (firstRowSize === undefined) return { state, commitIndex: null };
      return {
        state: {
          expanded: true,
          activeRow: 0,
          activeCol: clampColumn(state.activeCol, firstRowSize),
        },
        commitIndex: null,
      };
    }

    const nextRow = state.activeRow + 1;
    const nextRowSize = layout.rowSizes[nextRow];
    if (nextRowSize === undefined) return { state, commitIndex: null };
    return {
      state: {
        expanded: true,
        activeRow: nextRow,
        activeCol: clampColumn(state.activeCol, nextRowSize),
      },
      commitIndex: null,
    };
  }

  if (key === 'ArrowUp') {
    if (!state.expanded) return { state, commitIndex: null };

    if (state.activeRow === 0) {
      return {
        state: {
          expanded: false,
          activeRow: 0,
          activeCol: clampColumn(state.activeCol, layout.collapsedCount),
        },
        commitIndex: null,
      };
    }

    const previousRow = state.activeRow - 1;
    const previousRowSize = layout.rowSizes[previousRow];
    if (previousRowSize === undefined) return { state, commitIndex: null };
    return {
      state: {
        expanded: true,
        activeRow: previousRow,
        activeCol: clampColumn(state.activeCol, previousRowSize),
      },
      commitIndex: null,
    };
  }

  const currentRowSize = state.expanded
    ? (layout.rowSizes[state.activeRow] ?? 0)
    : layout.collapsedCount;

  if (key === 'ArrowRight') {
    return {
      state: {
        ...state,
        activeCol: clampColumn(state.activeCol + 1, currentRowSize),
      },
      commitIndex: null,
    };
  }

  return {
    state: {
      ...state,
      activeCol: Math.max(0, state.activeCol - 1),
    },
    commitIndex: null,
  };
}

/**
 * 접힘 상태 첫 줄에 넣을 후보 수
 *
 * engine.lookup은 commonPrefixSearch 기반이라 "정치"를 치면 "정치"와 "정"
 * 매칭을 모두 돌려준다. 긴 매칭이 앞에 오지만 개수가 적으면 나머지 칸을
 * 짧은 매칭이 채운다 — "정치"를 쳤는데 첫 줄 2/3이 "정"의 후보가 된다.
 *
 * 그래서 첫 줄은 **가장 긴 매칭**으로만 채운다. 짧은 매칭은 펼쳐야 나온다.
 * 사용자가 "정"만 바꾸고 싶으면 커서를 옮기면 되고, 그때는 버퍼 자체가
 * 좁혀져 "정"이 최장 매칭이 된다.
 *
 * 층은 여기서 거르지 않는다 — 자리가 남는데 굳이 감출 이유가 없다.
 * 후보 수를 임의로 줄이지 않고 모두 탐색할 수 있게 한다.
 * 2층은 ranker의 감점으로 이미 뒤로 밀려 있어, 첫 줄 안에서도 1층이 앞선다.
 * 후보가 한도를 넘으면 뒤쪽 2층부터 자연스럽게 잘린다.
 */
export function countCollapsedCandidates(
  groups: ReadonlyArray<{ length: number; candidates: readonly unknown[]; type?: string }>,
  limit: number,
): number {
  let longest = 0;
  for (const group of groups) {
    if (group.length > longest) longest = group.length;
  }

  let count = 0;
  for (const group of groups) {
    if (group.length !== longest) continue;
    count += group.candidates.length;
  }

  return Math.min(count, limit);
}
