import { describe, expect, it } from 'vitest';
import { AssemblyTracker, ASSEMBLY_TIMEOUT_MS } from '../assembly.js';

const S = 'sess-1';
const T0 = 1_700_000_000_000;

describe('AssemblyTracker', () => {
  it('낱자를 이어 확정하면 조합이 된다', () => {
    const t = new AssemblyTracker();
    expect(t.noteCommit(S, '김', '金', T0)).toBeUndefined(); // 아직 한 글자
    t.noteLookup(S, '앞에 있던 글 金', T0 + 1);
    expect(t.noteCommit(S, '홍', '洪', T0 + 2)).toEqual({
      reading: '김홍',
      hanja: '金洪',
      supersedes: undefined,
    });
    t.noteLookup(S, '앞에 있던 글 金洪', T0 + 3);
    // 자란 조합이 짧은 것을 대신한다 — 안 그러면 긴 것을 잊어도 짧은 것이 남는다
    expect(t.noteCommit(S, '경', '京', T0 + 4)).toEqual({
      reading: '김홍경',
      hanja: '金洪京',
      supersedes: { reading: '김홍', hanja: '金洪' },
    });
  });

  it('앞 문맥이 이어지지 않으면 끊긴다', () => {
    const t = new AssemblyTracker();
    t.noteCommit(S, '김', '金', T0);
    t.noteLookup(S, '전혀 다른 자리', T0 + 1); // 金으로 끝나지 않는다
    expect(t.noteCommit(S, '홍', '洪', T0 + 2)).toBeUndefined();
  });

  it('두 음절 표제어가 끼면 조합이 아니다', () => {
    const t = new AssemblyTracker();
    t.noteCommit(S, '김', '金', T0);
    t.noteLookup(S, '앞에 있던 글 金', T0 + 1);
    // 漢字는 2음절 표제어다 — 여기서 조합이 끝난다 (설계 §5.1)
    expect(t.noteCommit(S, '한자', '漢字', T0 + 2)).toBeUndefined();
    t.noteLookup(S, '앞에 있던 글 金漢字', T0 + 3);
    expect(t.noteCommit(S, '경', '京', T0 + 4)).toBeUndefined();
  });

  it('세션이 다르면 서로 섞이지 않는다', () => {
    const t = new AssemblyTracker();
    t.noteCommit(S, '김', '金', T0);
    t.noteLookup('sess-2', '金', T0 + 1);
    expect(t.noteCommit('sess-2', '홍', '洪', T0 + 2)).toBeUndefined();
  });

  it('세션이 닫히면 조합이 사라진다', () => {
    const t = new AssemblyTracker();
    t.noteCommit(S, '김', '金', T0);
    t.closeSession(S);
    t.noteLookup(S, '金', T0 + 1);
    expect(t.noteCommit(S, '홍', '洪', T0 + 2)).toBeUndefined();
  });

  it('오래 쉬면 끊긴다', () => {
    const t = new AssemblyTracker();
    t.noteCommit(S, '김', '金', T0);
    t.noteLookup(S, '金', T0 + ASSEMBLY_TIMEOUT_MS + 1);
    expect(t.noteCommit(S, '홍', '洪', T0 + ASSEMBLY_TIMEOUT_MS + 2)).toBeUndefined();
  });

  it('앞 문맥이 없으면(셸이 안 보내면) 조합하지 않는다', () => {
    const t = new AssemblyTracker();
    t.noteCommit(S, '김', '金', T0);
    t.noteLookup(S, undefined, T0 + 1);
    expect(t.noteCommit(S, '홍', '洪', T0 + 2)).toBeUndefined();
  });

  it('한 글자짜리 한자가 아닌 확정도 조합을 끊는다', () => {
    const t = new AssemblyTracker();
    t.noteCommit(S, '김', '金', T0);
    t.noteLookup(S, '金', T0 + 1);
    // 한글은 한 글자인데 한자가 두 글자다 — 낱자 확정이 아니다
    expect(t.noteCommit(S, '수', '數學', T0 + 2)).toBeUndefined();
  });

  it('세션이 없어도(셸이 sessionId를 안 보내도) 죽지 않는다', () => {
    const t = new AssemblyTracker();
    expect(t.noteCommit(undefined, '김', '金', T0)).toBeUndefined();
    t.noteLookup(undefined, '金', T0 + 1);
    expect(t.noteCommit(undefined, '홍', '洪', T0 + 2)).toBeUndefined();
  });
});
