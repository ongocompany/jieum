import { describe, expect, it } from 'vitest';
import {
  countCollapsedCandidates,
  resolveCandidateIndex,
  transitionCandidateNavigation,
  type CandidateNavigationLayout,
  type CandidateNavigationState,
} from '../candidate-navigation.js';

const layout: CandidateNavigationLayout = {
  collapsedCount: 9,
  rowSizes: [6, 6, 2, 6],
};

function move(
  state: CandidateNavigationState,
  key: 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'Enter',
) {
  return transitionCandidateNavigation(state, key, layout);
}

describe('후보 키보드 탐색', () => {
  it('접힘 상태에서도 좌우로 하이라이트를 이동한다', () => {
    const state = { expanded: false, activeRow: 0, activeCol: 0 };

    const right = move(state, 'ArrowRight');
    expect(right.state.activeCol).toBe(1);
    expect(move(right.state, 'ArrowLeft').state.activeCol).toBe(0);
  });

  it('행을 오갈 때 대상 행에 존재하는 열을 유지한다', () => {
    const firstRow = { expanded: true, activeRow: 0, activeCol: 4 };

    const secondRow = move(firstRow, 'ArrowDown').state;
    expect(secondRow).toEqual({ expanded: true, activeRow: 1, activeCol: 4 });
    expect(move(secondRow, 'ArrowUp').state).toEqual(firstRow);
  });

  it('대상 행이 짧으면 마지막 열로만 보정한다', () => {
    const secondRow = { expanded: true, activeRow: 1, activeCol: 4 };

    expect(move(secondRow, 'ArrowDown').state).toEqual({
      expanded: true,
      activeRow: 2,
      activeCol: 1,
    });
  });

  it('접힘과 펼침 사이에서도 가능한 열을 유지한다', () => {
    const collapsed = { expanded: false, activeRow: 0, activeCol: 4 };
    const expanded = move(collapsed, 'ArrowDown').state;

    expect(expanded).toEqual({ expanded: true, activeRow: 0, activeCol: 4 });
    expect(move(expanded, 'ArrowUp').state).toEqual(collapsed);
  });

  it('접힘 상태에서 Enter는 하이라이트된 후보를 확정한다', () => {
    const state = { expanded: false, activeRow: 0, activeCol: 3 };

    expect(move(state, 'Enter').commitIndex).toBe(3);
  });

  it('펼침 상태에서 Enter는 행 오프셋을 포함한 후보를 확정한다', () => {
    const state = { expanded: true, activeRow: 2, activeCol: 1 };

    expect(move(state, 'Enter').commitIndex).toBe(13);
    expect(resolveCandidateIndex(state, layout)).toBe(13);
  });
});

describe('접힘 첫 줄 후보 수', () => {
  const g = (word: string, len: number, n: number, type?: string) => ({
    word,
    length: len,
    candidates: Array.from({ length: n }, (_, i) => `${word}${i}`),
    ...(type ? { type } : {}),
  });

  it('최장 매칭만 센다 — 짧은 매칭이 첫 줄을 잠식하지 않는다', () => {
    // "정치" 실측: 첫 줄 9칸 중 6칸이 正·庭·定·情·停·政("정" 1음절)이었다
    const groups = [
      g('정치', 2, 3, 'normal'),
      g('정치', 2, 5, 'archaic'),
      g('정', 1, 64, 'normal'),
      g('정', 1, 44, 'inmyeong'),
    ];

    // 최장 매칭 "정치"의 1층 3 + 2층 5 = 8. 자리가 남으면 2층도 보여준다
    expect(countCollapsedCandidates(groups, 9)).toBe(8);
  });

  it('최장 매칭 후보가 한도를 넘으면 한도까지만 채운다', () => {
    expect(countCollapsedCandidates([g('정', 1, 64, 'normal')], 9)).toBe(9);
  });

  it('2층뿐인 전공 어휘도 그대로 센다', () => {
    expect(countCollapsedCandidates([g('거담작용', 4, 1, 'normal')], 9)).toBe(1);
  });

  it('type이 없는 그룹은 1층으로 본다', () => {
    expect(countCollapsedCandidates([g('발전', 2, 2)], 9)).toBe(2);
  });
});
