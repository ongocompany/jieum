import type { ImeEntry, ImeDict, PrefixMatch } from './types.js';

/** Trie 노드 */
interface TrieNode {
  /** 자식 노드 (음절 → 노드) */
  children: Map<string, TrieNode>;
  /** 이 노드가 단어의 끝이면 사전 엔트리 배열, 아니면 null */
  entries: ImeEntry[] | null;
}

function createNode(): TrieNode {
  return { children: new Map(), entries: null };
}

/**
 * 음절 단위 Trie Engine
 *
 * - Map 기반 Trie로 commonPrefixSearch를 O(n) 단일 패스로 수행
 * - 318K 엔트리 기준 exactMatch < 0.01ms, commonPrefixSearch < 0.1ms
 * - DA-Trie 최적화는 성능 병목 확인 후 진행 예정
 */
export class TrieEngine {
  private root: TrieNode = createNode();
  private _size = 0;

  get size(): number {
    return this._size;
  }

  /** 단어와 엔트리를 Trie에 삽입 */
  insert(key: string, entries: ImeEntry[]): void {
    let node = this.root;
    for (const ch of key) {
      let child = node.children.get(ch);
      if (!child) {
        child = createNode();
        node.children.set(ch, child);
      }
      node = child;
    }
    if (!node.entries) this._size++;
    node.entries = entries;
  }

  /** 기존 엔트리에 병합 (레이어 사전용) — 중복 한자는 건너뜀 */
  merge(key: string, entries: ImeEntry[]): void {
    let node = this.root;
    for (const ch of key) {
      let child = node.children.get(ch);
      if (!child) {
        child = createNode();
        node.children.set(ch, child);
      }
      node = child;
    }
    if (!node.entries) {
      node.entries = [...entries];
      this._size++;
    } else {
      const existing = new Set(node.entries.map(e => e.h));
      for (const e of entries) {
        if (!existing.has(e.h)) {
          node.entries.push(e);
        }
      }
    }
  }

  /** 특정 사전 태그의 엔트리 제거 (레이어 제거용) */
  removeByTag(key: string, tag: string): void {
    let node = this.root;
    for (const ch of key) {
      const child = node.children.get(ch);
      if (!child) return;
      node = child;
    }
    if (!node.entries) return;
    node.entries = node.entries.filter(e => e._tag !== tag);
    if (node.entries.length === 0) {
      node.entries = null;
      this._size--;
    }
  }

  /** ImeDict로부터 Trie 구축 */
  static fromDict(dict: ImeDict): TrieEngine {
    const trie = new TrieEngine();
    for (const [key, entries] of dict) {
      trie.insert(key, entries);
    }
    return trie;
  }

  /** 정확히 일치하는 키 검색 */
  exactMatch(key: string): ImeEntry[] | null {
    let node = this.root;
    for (const ch of key) {
      const child = node.children.get(ch);
      if (!child) return null;
      node = child;
    }
    return node.entries;
  }

  /**
   * 입력 문자열의 모든 접두어 매칭을 단일 패스로 검색
   *
   * 예: commonPrefixSearch("발전소건설") → [{발, 1}, {발전, 2}, {발전소, 3}]
   */
  commonPrefixSearch(input: string): PrefixMatch[] {
    const results: PrefixMatch[] = [];
    let node = this.root;
    let end = 0;

    // insert가 코드포인트 단위(`for...of`)로 노드를 만드므로 검색도 같은 단위여야
    // 한다. 코드 유닛으로 훑으면 대리쌍(U+10000 이상 — 확장한자가 여기 산다)의
    // 상위 대리 하나로 자식을 찾다 실패해, **넣은 표제어를 못 찾는다.**
    for (const ch of input) {
      const child = node.children.get(ch);
      if (!child) break;
      node = child;
      end += ch.length;

      if (node.entries) {
        results.push({
          word: input.slice(0, end),
          length: end,
          entries: node.entries,
        });
      }
    }

    return results;
  }

  /**
   * 키로 시작하는 모든 항목 검색 (자동완성용)
   */
  predictiveSearch(prefix: string, limit = 10): Array<{ word: string; entries: ImeEntry[] }> {
    let node = this.root;
    for (const ch of prefix) {
      const child = node.children.get(ch);
      if (!child) return [];
      node = child;
    }

    const results: Array<{ word: string; entries: ImeEntry[] }> = [];
    const stack: Array<[TrieNode, string]> = [[node, prefix]];

    while (stack.length > 0 && results.length < limit) {
      const [current, word] = stack.pop()!;
      if (current.entries) {
        results.push({ word, entries: current.entries });
      }
      // 역순으로 push해서 사전순으로 pop
      const childEntries = [...current.children.entries()].reverse();
      for (const [ch, child] of childEntries) {
        if (results.length >= limit) break;
        stack.push([child, word + ch]);
      }
    }

    return results;
  }
}
