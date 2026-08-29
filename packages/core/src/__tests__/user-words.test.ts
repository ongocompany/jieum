import { describe, expect, it } from 'vitest';
import { UserWordStore } from '../user-words.js';

const T0 = 1_700_000_000_000;

describe('UserWordStore', () => {
  it('만든 조합을 접두사로 찾는다', () => {
    const store = new UserWordStore();
    store.record('김홍경', '金洪京', T0);
    const hits = store.prefixMatches('김홍경을');
    expect(hits.map((h) => h.hanja)).toEqual(['金洪京']);
    expect(hits[0]!.count).toBe(1);
  });

  it('접두사가 아니면 안 걸린다', () => {
    const store = new UserWordStore();
    store.record('김홍경', '金洪京', T0);
    expect(store.prefixMatches('홍경')).toEqual([]);
  });

  it('긴 조합이 먼저 온다', () => {
    const store = new UserWordStore();
    store.record('김홍', '金洪', T0);
    store.record('김홍경', '金洪京', T0);
    expect(store.prefixMatches('김홍경').map((h) => h.hanja)).toEqual(['金洪京', '金洪']);
  });

  it('같은 조합을 다시 만들면 횟수가 오른다', () => {
    const store = new UserWordStore();
    store.record('김홍경', '金洪京', T0);
    store.record('김홍경', '金洪京', T0 + 1000);
    expect(store.prefixMatches('김홍경')[0]!.count).toBe(2);
  });

  it('같은 한글에 다른 한자 조합을 둘 다 들고 있는다', () => {
    const store = new UserWordStore();
    store.record('김홍경', '金洪京', T0);
    store.record('김홍경', '金弘慶', T0 + 1000);
    expect(
      store
        .prefixMatches('김홍경')
        .map((h) => h.hanja)
        .sort(),
    ).toEqual(['金弘慶', '金洪京']);
  });

  it('안 쓰면 강도가 내려간다 — 그러나 기록은 남는다', () => {
    const store = new UserWordStore();
    store.record('김홍경', '金洪京', T0);
    const fresh = store.prefixMatches('김홍경')[0]!.strength;
    for (let i = 0; i < 500; i++) store.record('다른것', '他物', T0 + i);
    const aged = store.prefixMatches('김홍경')[0];
    expect(aged).toBeDefined();
    expect(aged!.strength).toBeLessThan(fresh);
  });

  it('지우면 사라진다', () => {
    const store = new UserWordStore();
    store.record('김홍경', '金洪京', T0);
    expect(store.forget('김홍경', '金洪京')).toBe(true);
    expect(store.prefixMatches('김홍경')).toEqual([]);
    expect(store.forget('김홍경', '金洪京')).toBe(false);
  });

  it('256바이트를 넘는 것은 안 배운다', () => {
    const store = new UserWordStore();
    store.record('가'.repeat(200), '家'.repeat(200), T0);
    expect(store.size).toBe(0);
  });

  it('용량을 넘으면 가장 약한 것부터 버린다', () => {
    const store = new UserWordStore(3);
    store.record('가', '可', T0);
    store.record('나', '奈', T0 + 1);
    store.record('다', '茶', T0 + 2);
    store.record('라', '羅', T0 + 3);
    expect(store.size).toBe(3);
    expect(store.prefixMatches('가')).toEqual([]);
  });

  it('저장하고 되읽으면 같다', () => {
    const store = new UserWordStore();
    store.record('김홍경', '金洪京', T0);
    store.record('이순신', '李舜臣', T0 + 1000);
    const back = UserWordStore.fromJSON(JSON.parse(JSON.stringify(store.toJSON())));
    expect(back.size).toBe(2);
    expect(back.prefixMatches('이순신')[0]!.hanja).toBe('李舜臣');
  });

  it('망가진 스냅샷은 빈 저장소가 된다', () => {
    expect(UserWordStore.fromJSON({ v: 99, junk: true }).size).toBe(0);
    expect(UserWordStore.fromJSON(null).size).toBe(0);
  });
});
