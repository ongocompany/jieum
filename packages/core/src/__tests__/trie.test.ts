import { describe, it, expect } from 'vitest';
import { TrieEngine } from '../trie.js';
import type { ImeEntry } from '../types.js';

function e(h: string, f = 0, l = 0): ImeEntry {
  return { h, f, l };
}

describe('TrieEngine', () => {
  function buildTrie() {
    const trie = new TrieEngine();
    trie.insert('발', [e('發', 50), e('拔', 10)]);
    trie.insert('발전', [e('發展', 120), e('發電', 80)]);
    trie.insert('발전소', [e('發電所', 0)]);
    trie.insert('경제', [e('經濟', 90)]);
    trie.insert('경제적', [e('經濟的', 0)]);
    trie.insert('대한', [e('大韓', 100)]);
    trie.insert('민국', [e('民國', 0)]);
    return trie;
  }

  describe('exactMatch', () => {
    it('존재하는 키를 찾는다', () => {
      const trie = buildTrie();
      const result = trie.exactMatch('경제');
      expect(result).toEqual([e('經濟', 90)]);
    });

    it('없는 키는 null을 반환한다', () => {
      const trie = buildTrie();
      expect(trie.exactMatch('없는단어')).toBeNull();
    });

    it('접두어만으로는 매칭하지 않는다', () => {
      const trie = buildTrie();
      expect(trie.exactMatch('발전소건설')).toBeNull();
    });
  });

  describe('commonPrefixSearch', () => {
    it('입력의 모든 접두어 매칭을 반환한다', () => {
      const trie = buildTrie();
      const results = trie.commonPrefixSearch('발전소건설');

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ word: '발', length: 1, entries: [e('發', 50), e('拔', 10)] });
      expect(results[1]).toEqual({ word: '발전', length: 2, entries: [e('發展', 120), e('發電', 80)] });
      expect(results[2]).toEqual({ word: '발전소', length: 3, entries: [e('發電所', 0)] });
    });

    it('매칭 없으면 빈 배열을 반환한다', () => {
      const trie = buildTrie();
      expect(trie.commonPrefixSearch('없는')).toEqual([]);
    });

    it('정확히 일치하는 단어도 포함한다', () => {
      const trie = buildTrie();
      const results = trie.commonPrefixSearch('경제');
      expect(results).toHaveLength(1);
      expect(results[0]!.word).toBe('경제');
    });

    it('더 긴 접두어도 매칭한다', () => {
      const trie = buildTrie();
      const results = trie.commonPrefixSearch('경제적으로');
      expect(results).toHaveLength(2);
      expect(results[0]!.word).toBe('경제');
      expect(results[1]!.word).toBe('경제적');
    });
  });

  describe('predictiveSearch', () => {
    it('접두어로 시작하는 항목을 찾는다', () => {
      const trie = buildTrie();
      const results = trie.predictiveSearch('발전');

      const words = results.map((r) => r.word).sort();
      expect(words).toContain('발전');
      expect(words).toContain('발전소');
    });

    it('limit을 초과하지 않는다', () => {
      const trie = buildTrie();
      const results = trie.predictiveSearch('', 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('없는 접두어는 빈 배열을 반환한다', () => {
      const trie = buildTrie();
      expect(trie.predictiveSearch('xyz')).toEqual([]);
    });
  });

  describe('fromDict', () => {
    it('ImeDict로부터 Trie를 구축한다', () => {
      const dict = new Map([
        ['경제', [e('經濟', 90)]],
        ['발전', [e('發展', 120), e('發電', 80)]],
      ]);

      const trie = TrieEngine.fromDict(dict);
      expect(trie.size).toBe(2);
      expect(trie.exactMatch('경제')).toEqual([e('經濟', 90)]);
    });
  });

  describe('대리쌍 표제어', () => {
    // insert는 코드포인트 단위(`for...of`)로 노드를 만든다. 검색이 코드 유닛
    // 단위로 훑으면 U+10000 이상(확장한자가 여기 산다)에서 상위 대리 하나로
    // 자식을 찾다 실패해 **넣은 표제어를 못 찾는다.** 지금 사전은 전부 한글이라
    // 드러나지 않지만, 확장한자 표제어가 들어오는 날 그 단어만 후보가 안 뜬다.
    const EXT = '\u{20000}'; // 코드 유닛 2개짜리 한 문자

    it('대리쌍으로 시작하는 표제어를 접두어 탐색이 찾는다', () => {
      const trie = new TrieEngine();
      trie.insert(EXT, [e('EXT', 10)]);
      trie.insert(`${EXT}가`, [e('EXT_GA', 20)]);

      expect(trie.commonPrefixSearch(`${EXT}가나`).map((m) => m.word)).toEqual([
        EXT,
        `${EXT}가`,
      ]);
    });

    it('접두어를 문자 경계에서 자른다 (반쪽 대리를 만들지 않는다)', () => {
      const trie = new TrieEngine();
      trie.insert(EXT, [e('EXT', 10)]);

      const match = trie.commonPrefixSearch(`${EXT}가`)[0]!;
      expect(match.word).toBe(EXT);
      // length는 코드 유닛 수 — 호출부가 이 값으로 버퍼를 잘라낸다
      expect(match.length).toBe(2);
      expect(`${EXT}가`.slice(0, match.length)).toBe(EXT);
    });
  });
});
