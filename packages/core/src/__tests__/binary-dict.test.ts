import { describe, it, expect } from 'vitest';
import { buildBinary, loadBinary, BinaryDictView } from '../binary-dict.js';
import { TrieEngine } from '../trie.js';
import { JieumEngine } from '../engine.js';
import type { DictLookup, ImeEntry } from '../types.js';

/**
 * 바이너리 사전 조회기
 *
 * Trie가 47.9만 표제어에 438 MB를 쓰던 자리를 대신하는 구현이다. Trie와 **같은
 * 답을 내는지**가 유일한 안전망이라, 여기 시험은 대부분 두 구현 대조다.
 * 조회는 입력기의 모든 제안이 지나가는 길목이라 조용히 어긋나면 "가끔 후보가
 * 안 뜬다"로만 드러난다.
 */

function e(h: string, f = 0, extra: Partial<ImeEntry> = {}): ImeEntry {
  return { h, f, l: 0, ...extra };
}

/** 같은 사전으로 두 구현을 만든다 */
function bothFrom(dict: Record<string, ImeEntry[]>): { trie: TrieEngine; view: DictLookup } {
  const trie = new TrieEngine();
  for (const [word, entries] of Object.entries(dict)) trie.insert(word, entries);

  const snapshot = loadBinary(buildBinary({ dict, compound: {}, blocklist: [] }));
  expect(snapshot.lookup).toBeInstanceOf(BinaryDictView);
  return { trie, view: snapshot.lookup! };
}

/** 두 구현이 이 입력들에 대해 완전히 같은 답을 내는지 */
function assertSameAnswers(
  trie: TrieEngine,
  view: DictLookup,
  inputs: string[],
): void {
  for (const input of inputs) {
    expect(view.exactMatch(input), `exactMatch(${input})`).toEqual(trie.exactMatch(input));
    expect(view.commonPrefixSearch(input), `commonPrefixSearch(${input})`).toEqual(
      trie.commonPrefixSearch(input),
    );
  }
}

describe('바이너리 조회기 — Trie와의 동등성', () => {
  const dict: Record<string, ImeEntry[]> = {
    발: [e('發', 80), e('拔', 10)],
    발전: [e('發展', 90), e('發電', 40)],
    발전소: [e('發電所', 70)],
    발전기: [e('發電機', 30)],
    발음: [e('發音', 50)],
    // 접두어 관계가 없는 이웃 — 조기 종료가 여기서 멈추는지 본다
    밝기: [e('明度', 5)],
    바다: [e('海', 60)],
    정치: [e('政治', 95), e('定置', 0, { a: true })],
    민: [e('閔', 0, { n: true }), e('旻', 0, { n: true, a: true })],
    // 뜻(m)은 1글자 한자에만 있다 — 있는 것과 없는 것을 섞는다
    수: [e('水', 70, { m: '물' }), e('手', 60, { m: '손' }), e('數', 50)],
  };

  it('정확 일치가 Trie와 같다 (있는 것·없는 것·경계)', () => {
    const { trie, view } = bothFrom(dict);
    assertSameAnswers(trie, view, [
      '발', '발전', '발전소', '발전기', '발음', '밝기', '바다', '정치', '민', '수',
      // 없는 것
      '발전소건설', '바', '바닥', '가', '힣', '정', '치',
    ]);
  });

  it('접두어 탐색이 Trie와 같다 (긴 입력·부분 매칭·매칭 없음)', () => {
    const { trie, view } = bothFrom(dict);
    assertSameAnswers(trie, view, [
      '발전소건설현장',
      '발전기가',
      '발음이',
      '바다에서',
      '밝기조절',
      '정치인',
      '수도권',
      // 첫 글자부터 매칭이 없다 — 조기 종료가 곧바로 일어나야 한다
      '한글날',
      '',
    ]);
  });

  it('뜻·인명용·2층 표시가 조회 결과에 그대로 살아 있다', () => {
    const { view } = bothFrom(dict);

    const su = view.exactMatch('수')!;
    expect(su[0]).toEqual({ h: '水', f: 70, l: 0, m: '물' });
    expect(su[2]!.m).toBeUndefined();

    const min = view.exactMatch('민')!;
    expect(min[0]!.n).toBe(true);
    expect(min[0]!.a).toBeUndefined();
    expect(min[1]!.n).toBe(true);
    expect(min[1]!.a).toBe(true);

    expect(view.exactMatch('정치')![1]!.a).toBe(true);
  });

  it('표제어 수를 Trie와 같게 센다', () => {
    const { trie, view } = bothFrom(dict);
    expect(view.size).toBe(trie.size);
    expect(view.size).toBe(Object.keys(dict).length);
  });
});

describe('바이너리 조회기 — 정렬과 탐색 경계', () => {
  /**
   * 빌더가 표제어를 정렬해 쓴다는 것이 이진 탐색의 유일한 근거다.
   * 입력 순서가 뒤죽박죽이어도 조회가 전부 맞아야 한다.
   */
  it('입력 순서가 역순이어도 모든 표제어를 찾는다', () => {
    const words = ['힣', '하', '자', '아', '사', '바', '마', '라', '다', '나', '가'];
    const dict = Object.fromEntries(words.map((w, i) => [w, [e(`H${i}`, i)]]));
    const { trie, view } = bothFrom(dict);

    for (const w of words) {
      expect(view.exactMatch(w), `역순 입력 후 ${w}`).toEqual(trie.exactMatch(w));
    }
  });

  it('접두어가 다른 표제어의 진접두어일 때 둘 다 찾는다', () => {
    // "발"은 "발전"의 진접두어다. 이진 탐색에서 짧은 키가 먼저 오므로
    // 길이 비교를 빠뜨리면 "발"을 찾을 때 "발전"이 걸린다.
    const { trie, view } = bothFrom({
      발: [e('發')],
      발전: [e('發展')],
      발전소: [e('發電所')],
    });

    expect(view.exactMatch('발')).toEqual([{ h: '發', f: 0, l: 0 }]);
    expect(view.commonPrefixSearch('발전소')).toEqual(trie.commonPrefixSearch('발전소'));
    expect(view.commonPrefixSearch('발전소').map((m) => m.word)).toEqual(['발', '발전', '발전소']);
  });

  it('중간 접두어가 없어도 더 긴 표제어를 놓치지 않는다', () => {
    // "발전"은 사전에 없고 "발"과 "발전소"만 있다. 매칭이 없다고 멈추면
    // "발전소"를 영영 못 찾는다 — 조기 종료 조건이 "매칭 없음"이 아니라
    // "이 접두어로 시작하는 표제어가 없음"이어야 하는 이유다.
    const { trie, view } = bothFrom({
      발: [e('發')],
      발전소: [e('發電所')],
    });

    const matches = view.commonPrefixSearch('발전소');
    expect(matches.map((m) => m.word)).toEqual(['발', '발전소']);
    expect(matches).toEqual(trie.commonPrefixSearch('발전소'));
  });

  it('사전의 첫 표제어와 마지막 표제어를 찾는다 (이진 탐색 경계)', () => {
    const dict = Object.fromEntries(
      ['가', '나', '다', '라', '마', '바', '사'].map((w) => [w, [e(`H${w}`)]]),
    );
    const { view } = bothFrom(dict);
    expect(view.exactMatch('가')).toEqual([{ h: 'H가', f: 0, l: 0 }]);
    expect(view.exactMatch('사')).toEqual([{ h: 'H사', f: 0, l: 0 }]);
    // 사전 범위 밖 — 아래로도 위로도
    expect(view.exactMatch('ㄱ')).toBeNull();
    expect(view.exactMatch('힣')).toBeNull();
  });

  it('표제어가 하나뿐이거나 아예 없어도 동작한다', () => {
    const single = bothFrom({ 발: [e('發')] });
    expect(single.view.size).toBe(1);
    expect(single.view.exactMatch('발')).toEqual([{ h: '發', f: 0, l: 0 }]);
    expect(single.view.exactMatch('전')).toBeNull();
    expect(single.view.commonPrefixSearch('발전')).toEqual(single.trie.commonPrefixSearch('발전'));

    const empty = bothFrom({});
    expect(empty.view.size).toBe(0);
    expect(empty.view.exactMatch('발')).toBeNull();
    expect(empty.view.commonPrefixSearch('발전소')).toEqual([]);
  });

  it('표제어에 대리쌍 문자가 섞여도 정렬과 조회가 어긋나지 않는다', () => {
    // 조회기는 UTF-8 바이트를 직접 비교하고 빌더는 문자열을 정렬한다.
    // JS 기본 정렬은 UTF-16 코드 유닛 순이라 U+10000 이상에서 코드포인트
    // 순서와 어긋나므로, 빌더가 보정하지 않으면 이진 탐색이 조용히 실패한다.
    // (지금 사전은 전부 한글이지만 확장한자 표제어가 들어오면 그날 깨진다)
    const dict: Record<string, ImeEntry[]> = {
      '\u{20000}': [e('EXT_A')], // 확장한자 — 대리쌍
      '�': [e('BMP_HIGH')], // BMP 상단, 코드포인트는 위보다 작다
      가: [e('BMP_LOW')],
      '\u{2A6DF}': [e('EXT_B')],
    };
    const { trie, view } = bothFrom(dict);

    for (const w of Object.keys(dict)) {
      expect(view.exactMatch(w), `대리쌍 섞인 사전에서 ${JSON.stringify(w)}`).toEqual(
        trie.exactMatch(w),
      );
    }
    // 대리쌍 문자의 하위 대리 자리는 문자 경계가 아니다 — 접두어로 잘리면 안 된다
    expect(view.commonPrefixSearch('\u{20000}가')).toEqual(
      trie.commonPrefixSearch('\u{20000}가'),
    );
  });
});

describe('바이너리 조회기 — 엔진 결과 동등성', () => {
  const dict: Record<string, ImeEntry[]> = {
    발전: [e('發展', 90), e('發電', 40)],
    발전소: [e('發電所', 70)],
    정치: [e('政治', 95), e('定置', 0, { a: true })],
    민: [e('閔', 0, { n: true })],
  };
  const compound = { 발전소: '發電所' };
  const blocklist = ['민'];

  it('같은 사전이면 엔진 조회 결과가 Trie 경로와 완전히 같다', () => {
    const trieEngine = new JieumEngine({
      dict: new Map(Object.entries(dict)),
      compound: new Map(Object.entries(compound)),
      blocklist: new Set(blocklist),
    });

    const snapshot = loadBinary(buildBinary({ dict, compound, blocklist }));
    const binaryEngine = new JieumEngine(snapshot);

    for (const input of ['발전소', '발전', '정치', '민', '발전소건설']) {
      expect(binaryEngine.lookup(input), `lookup(${input})`).toEqual(trieEngine.lookup(input));
      expect(binaryEngine.hasWord(input), `hasWord(${input})`).toBe(trieEngine.hasWord(input));
      expect(binaryEngine.convert(input), `convert(${input})`).toEqual(trieEngine.convert(input));
    }
    expect(binaryEngine.dictSize).toBe(trieEngine.dictSize);
  });

  it('복합어·블록리스트가 바이너리 왕복을 건너 살아남는다', () => {
    const snapshot = loadBinary(buildBinary({ dict, compound, blocklist }));
    expect(snapshot.compound.get('발전소')).toBe('發電所');
    expect(snapshot.blocklist.has('민')).toBe(true);
    // 사전을 두 벌 들지 않는다 — dict가 채워지면 조회기와 중복이다
    expect(snapshot.dict.size).toBe(0);
  });

  it('레이어 사전은 읽기 전용 조회기에서 조용히 무시되지 않고 던진다', () => {
    const snapshot = loadBinary(buildBinary({ dict, compound: {}, blocklist: [] }));
    const engine = new JieumEngine(snapshot);

    expect(() => engine.addDict('legal', '법률', { 계약: [e('契約')] })).toThrow(/읽기 전용/);
    expect(engine.hasDict('legal')).toBe(false);
  });
});
