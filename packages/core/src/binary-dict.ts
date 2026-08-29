/**
 * jieum 바이너리 사전 포맷
 *
 * 두 가지를 동시에 푼다.
 *
 * **로딩 시간** — JSON 파싱(185ms) + Map 변환(140ms) + Trie 구축(158ms) = 484ms를
 * 바이너리 직접 로드로 줄인다.
 *
 * **메모리** — v3부터는 읽어서 펴지 않는다. JSON 경로는 47.9만 표제어를 JS 객체
 * 그래프로 두 번(Map + Trie) 펼쳐 **572 MB**를 썼다(2026-08-01 실측: Map 318 MB
 * + Trie 438 MB). v3는 표제어를 정렬해 두고 워드 오프셋 표를 함께 실어서,
 * {@link BinaryDictView}가 버퍼 위에서 이진 탐색으로 답한다 — 조회에 걸린 후보만
 * 그때 객체가 된다.
 *
 * 포맷:
 *   Header (8 bytes): "JIEUM" magic + u16 version + u16 flags
 *   String Pool: u32 size + UTF-8 bytes (+ u32 정렬 패딩, v3부터)
 *   Dict: u32 numWords
 *         u32 × numWords 워드 오프셋 표 (v3부터)
 *         per word: key ref + candidates          (v3부터 키 코드포인트 오름차순)
 *   Compound: u32 numCompounds, then per entry: key ref + value ref
 *   Blocklist: u32 numBlocked, then per word: word ref
 *
 * String ref = [u32 offset, u16 byteLen]
 * Word record = [key ref(6), u16 numCands, candidates...]
 * Candidate = [hanja ref(6), u8 freq, u8 level, meaning ref(6), u16 flags]
 */

import type { ImeEntry, DictSnapshot, PrefixMatch, DictLookup } from './types.js';
import { TrieEngine } from './trie.js';

const MAGIC = 0x454d4948; // "JIEUM" in little-endian
/**
 * v2: 후보 플래그를 비트필드로 확장 (bit1 = 2층). 레이아웃은 v1과 동일
 * v3: 표제어 정렬 + 워드 오프셋 표. 펴지 않고 읽는 조회가 가능해진다
 */
const VERSION = 3;

/** 워드 오프셋 표가 들어온 최초 버전 — 이 미만은 Trie로 펴서 읽는다 */
const VERSION_INDEXED = 3;

/** 후보 플래그 비트 */
const FLAG_INMYEONG = 1 << 0;
const FLAG_ARCHAIC = 1 << 1;

/** 워드 레코드 헤더 크기: keyRef(6) + numCands(2) */
const WORD_HEADER_SIZE = 8;
/** 후보 하나의 크기: hanjaRef(6) + freq(1) + level(1) + meaningRef(6) + flags(2) */
const CANDIDATE_SIZE = 16;
/** 뜻이 없음을 나타내는 문자열 참조 */
const NO_STRING = 0xffffffff;

/**
 * u8 한 칸에 담기게 자른다
 *
 * `DataView.setUint8`은 범위를 넘는 값을 던지지 않고 256으로 나눈 나머지를
 * 쓴다. 그래서 빈도 1891은 99가 되어 **순위가 조용히 뒤집힌다** —
 * 실제로 `이상/以上`(1891)과 `의미/意味`(1078)가 그렇게 손상돼 있었다.
 * 잘라내면 상한에 몰릴 뿐 순서는 뒤집히지 않으므로 모듈로보다 안전하다.
 * (빌드 쪽에서 이미 0~100으로 정규화하지만, 포맷 자체가 스스로를 지켜야 한다)
 */
function toByte(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(255, Math.round(value));
}

/**
 * 유니코드 코드포인트 순 문자열 비교 — UTF-8 바이트 순과 같은 순서다
 *
 * JS의 `<`와 기본 `sort()`는 **UTF-16 코드 유닛 순**이라 코드포인트 순과
 * 어긋난다. 대리쌍(U+10000 이상)이 0xD800~0xDFFF로 표현되는데, 그 값이
 * U+E000~U+FFFF보다 작아서 실제로는 더 큰 문자가 앞에 오기 때문이다.
 *
 * 이 사전의 표제어는 전부 한글(U+AC00~U+D7A3)이라 지금은 두 순서가 같다.
 * 그래도 보정을 넣는 이유는 조회기가 **UTF-8 바이트를 직접 비교**하기
 * 때문이다 — 빌드 정렬과 조회 비교가 어긋나면 이진 탐색이 표제어를 조용히
 * 못 찾는다. 표제어에 한자나 확장 문자가 섞이는 날 그렇게 깨진다.
 */
function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let ca = a.charCodeAt(i);
    let cb = b.charCodeAt(i);
    if (ca === cb) continue;
    // 대리쌍을 BMP 뒤로 밀어 코드포인트 순서를 복원한다
    if (ca >= 0xe000) ca -= 0x800;
    else if (ca >= 0xd800) ca += 0x2000;
    if (cb >= 0xe000) cb -= 0x800;
    else if (cb >= 0xd800) cb += 0x2000;
    return ca - cb;
  }
  return a.length - b.length;
}

/** 문자열 풀 뒤에 넣을 u32 정렬 패딩 */
function poolPadding(poolSize: number): number {
  return (4 - (poolSize % 4)) % 4;
}

// --- 빌더 (Node.js 빌드 시 사용) ---

export interface BinaryBuildInput {
  dict: Record<string, ImeEntry[]>;
  compound: Record<string, string>;
  blocklist: string[];
}

export function buildBinary(input: BinaryBuildInput): ArrayBuffer {
  const encoder = new TextEncoder();

  // 1. 문자열 풀 구축
  const stringPool: number[] = []; // UTF-8 바이트 배열
  const stringMap = new Map<string, { offset: number; byteLen: number }>();

  function addString(s: string): { offset: number; byteLen: number } {
    const existing = stringMap.get(s);
    if (existing) return existing;
    const encoded = encoder.encode(s);
    const offset = stringPool.length;
    for (const b of encoded) stringPool.push(b);
    const ref = { offset, byteLen: encoded.length };
    stringMap.set(s, ref);
    return ref;
  }

  // 표제어를 정렬해 둔다 — 조회기가 이진 탐색으로 찾을 수 있는 유일한 근거다.
  // 정렬 순서와 조회기의 바이트 비교 순서는 반드시 같아야 한다
  // (compareCodePoints 주석 참조).
  const dictEntries = Object.entries(input.dict).sort((a, b) => compareCodePoints(a[0], b[0]));

  // 모든 문자열 수집
  for (const [word, entries] of dictEntries) {
    addString(word);
    for (const e of entries) {
      addString(e.h);
      if (e.m) addString(e.m);
    }
  }
  for (const [k, v] of Object.entries(input.compound)) {
    addString(k);
    addString(v);
  }
  for (const w of input.blocklist) {
    addString(w);
  }

  // 2. 크기 계산
  const headerSize = 8;
  const poolHeaderSize = 4; // u32 poolSize
  const poolSize = stringPool.length;
  const padding = poolPadding(poolSize);

  // Dict: u32 numWords + u32 × numWords 오프셋 표 + per word (헤더 + 후보들)
  const wordIndexSize = dictEntries.length * 4;
  let wordDataSize = 0;
  for (const [, entries] of dictEntries) {
    wordDataSize += WORD_HEADER_SIZE + entries.length * CANDIDATE_SIZE;
  }
  const dictSize = 4 + wordIndexSize + wordDataSize;

  // Compound: u32 numCompounds + per entry 12 bytes (keyRef + valueRef)
  const compoundEntries = Object.entries(input.compound);
  const compoundSize = 4 + compoundEntries.length * 12;

  // Blocklist: u32 numBlocked + per word 6 bytes (wordRef)
  const blocklistSize = 4 + input.blocklist.length * 6;

  const totalSize =
    headerSize + poolHeaderSize + poolSize + padding + dictSize + compoundSize + blocklistSize;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let pos = 0;

  // 3. Header
  view.setUint32(pos, MAGIC, true); pos += 4;
  view.setUint16(pos, VERSION, true); pos += 2;
  view.setUint16(pos, 0, true); pos += 2; // flags

  // 4. String Pool (+ 패딩 — 뒤따르는 u32 표가 정렬돼야 Uint32Array로 볼 수 있다)
  view.setUint32(pos, poolSize, true); pos += 4;
  bytes.set(stringPool, pos); pos += poolSize + padding;

  // 5. Dict — 오프셋 표를 먼저 잡아 두고 레코드를 쓰면서 채운다
  view.setUint32(pos, dictEntries.length, true); pos += 4;
  const wordIndexPos = pos;
  pos += wordIndexSize;

  for (let w = 0; w < dictEntries.length; w++) {
    const [word, entries] = dictEntries[w]!;
    view.setUint32(wordIndexPos + w * 4, pos, true);

    const keyRef = stringMap.get(word)!;
    view.setUint32(pos, keyRef.offset, true); pos += 4;
    view.setUint16(pos, keyRef.byteLen, true); pos += 2;
    view.setUint16(pos, entries.length, true); pos += 2;

    for (const e of entries) {
      const hanjaRef = stringMap.get(e.h)!;
      view.setUint32(pos, hanjaRef.offset, true); pos += 4;
      view.setUint16(pos, hanjaRef.byteLen, true); pos += 2;
      view.setUint8(pos, toByte(e.f)); pos += 1;
      view.setUint8(pos, toByte(e.l)); pos += 1;

      if (e.m) {
        const meaningRef = stringMap.get(e.m)!;
        view.setUint32(pos, meaningRef.offset, true); pos += 4;
        view.setUint16(pos, meaningRef.byteLen, true); pos += 2;
      } else {
        view.setUint32(pos, NO_STRING, true); pos += 4;
        view.setUint16(pos, 0, true); pos += 2;
      }

      // 플래그 비트필드 — bit0 인명용, bit1 2층(고어·전문어).
      // u16을 이미 잡아두고 0/1만 쓰고 있었으므로 파일 크기는 그대로다.
      let flags = 0;
      if (e.n) flags |= FLAG_INMYEONG;
      if (e.a) flags |= FLAG_ARCHAIC;
      view.setUint16(pos, flags, true); pos += 2;
    }
  }

  // 6. Compound
  view.setUint32(pos, compoundEntries.length, true); pos += 4;
  for (const [k, v] of compoundEntries) {
    const keyRef = stringMap.get(k)!;
    const valRef = stringMap.get(v)!;
    view.setUint32(pos, keyRef.offset, true); pos += 4;
    view.setUint16(pos, keyRef.byteLen, true); pos += 2;
    view.setUint32(pos, valRef.offset, true); pos += 4;
    view.setUint16(pos, valRef.byteLen, true); pos += 2;
  }

  // 7. Blocklist
  view.setUint32(pos, input.blocklist.length, true); pos += 4;
  for (const w of input.blocklist) {
    const ref = stringMap.get(w)!;
    view.setUint32(pos, ref.offset, true); pos += 4;
    view.setUint16(pos, ref.byteLen, true); pos += 2;
  }

  return buffer;
}

// --- 조회기 ---

/**
 * UTF-16 코드 유닛 하나가 UTF-8에서 차지하는 바이트 수
 *
 * 하위 대리는 0을 돌려준다 — 상위 대리에서 4바이트를 이미 셌기 때문이다.
 * 그 자리는 문자 경계가 아니므로 접두어를 자르는 지점이 될 수 없다.
 */
function utf8Len(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code < 0xdc00) return 4; // 상위 대리 = 대리쌍 전체
  if (code >= 0xdc00 && code < 0xe000) return 0; // 하위 대리 — 이미 셈
  return 3;
}

/**
 * 펴지 않고 읽는 사전 조회기
 *
 * 버퍼를 그대로 들고 있으면서 오프셋 계산으로 답한다. Trie가 표제어 47.9만 개에
 * 438 MB를 쓰던 자리를 **버퍼 24.7 MB + 오프셋 표 1.8 MB**가 대신한다.
 *
 * 조회 비용은 접두어 하나당 이진 탐색 한 번(log₂ 47.9만 ≈ 19회 바이트 비교)이다.
 * 문자열 디코딩은 **조회에 걸린 후보에만** 일어난다 — 사전 전체를 문자열로
 * 만들지 않는 것이 메모리 절감의 핵심이다.
 *
 * 읽기 전용이다. {@link DictLookup.merge}·{@link DictLookup.removeByTag}를
 * 제공하지 않으므로 레이어 사전은 이 경로에서 쓸 수 없다.
 */
export class BinaryDictView implements DictLookup {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  /** 워드 레코드의 버퍼 절대 오프셋 (표제어 오름차순) */
  private readonly index: Uint32Array;
  private readonly poolStart: number;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  constructor(buffer: ArrayBuffer, poolStart: number, index: Uint32Array) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.poolStart = poolStart;
    this.index = index;
  }

  get size(): number {
    return this.index.length;
  }

  private readStringAt(offset: number, byteLen: number): string {
    const start = this.poolStart + offset;
    return this.decoder.decode(this.bytes.subarray(start, start + byteLen));
  }

  /**
   * 레코드 i의 키를 needle과 비교한다 — needle 길이까지만 본다
   *
   * 돌려주는 값이 두 가지 질문에 동시에 답한다:
   * - `< 0`이면 키가 needle보다 앞선다 (이진 탐색이 쓰는 값)
   * - `0`이면 키가 needle로 **시작한다**. 길이까지 같으면 정확히 일치다
   *
   * 키가 needle보다 짧으면 needle의 진접두어이므로 사전식으로 앞선다.
   */
  private compareKey(rec: number, needle: Uint8Array): number {
    const keyOffset = this.poolStart + this.view.getUint32(rec, true);
    const keyLen = this.view.getUint16(rec + 4, true);
    const n = Math.min(keyLen, needle.length);
    for (let k = 0; k < n; k++) {
      const d = this.bytes[keyOffset + k]! - needle[k]!;
      if (d !== 0) return d;
    }
    return keyLen < needle.length ? -1 : 0;
  }

  private keyByteLen(rec: number): number {
    return this.view.getUint16(rec + 4, true);
  }

  /** needle 이상인 첫 표제어의 위치 */
  private lowerBound(needle: Uint8Array, lo: number, hi: number): number {
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compareKey(this.index[mid]!, needle) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private readEntries(rec: number): ImeEntry[] {
    const numCands = this.view.getUint16(rec + 6, true);
    const entries: ImeEntry[] = new Array(numCands);
    let pos = rec + WORD_HEADER_SIZE;

    for (let c = 0; c < numCands; c++) {
      const hanjaOffset = this.view.getUint32(pos, true);
      const hanjaByteLen = this.view.getUint16(pos + 4, true);
      const freq = this.view.getUint8(pos + 6);
      const level = this.view.getUint8(pos + 7);
      const meaningOffset = this.view.getUint32(pos + 8, true);
      const meaningByteLen = this.view.getUint16(pos + 12, true);
      const flags = this.view.getUint16(pos + 14, true);
      pos += CANDIDATE_SIZE;

      const entry: ImeEntry = {
        h: this.readStringAt(hanjaOffset, hanjaByteLen),
        f: freq,
        l: level,
      };
      if (meaningOffset !== NO_STRING) {
        entry.m = this.readStringAt(meaningOffset, meaningByteLen);
      }
      if (flags & FLAG_INMYEONG) entry.n = true;
      if (flags & FLAG_ARCHAIC) entry.a = true;
      entries[c] = entry;
    }

    return entries;
  }

  exactMatch(key: string): ImeEntry[] | null {
    if (!key) return null;
    const needle = this.encoder.encode(key);
    const i = this.lowerBound(needle, 0, this.index.length);
    if (i >= this.index.length) return null;

    const rec = this.index[i]!;
    // compareKey는 needle 길이까지만 본다 — 길이가 같아야 정확히 일치다
    if (this.compareKey(rec, needle) !== 0 || this.keyByteLen(rec) !== needle.length) return null;
    return this.readEntries(rec);
  }

  commonPrefixSearch(input: string): PrefixMatch[] {
    const results: PrefixMatch[] = [];
    if (!input) return results;

    const needle = this.encoder.encode(input);
    const total = this.index.length;
    let byteEnd = 0;
    let lo = 0;

    // 문자 단위로 나아간다 — 대리쌍(U+10000 이상)은 코드 유닛 2칸을 한 문자로
    // 소비해야 한다. 한 칸씩 가면 접두어가 문자를 반으로 잘라 깨진 글자가 된다.
    for (let i = 0; i < input.length; ) {
      const code = input.charCodeAt(i);
      const isPair = code >= 0xd800 && code < 0xdc00 && i + 1 < input.length;
      const end = i + (isPair ? 2 : 1);
      byteEnd += utf8Len(code);
      i = end;

      const prefix = needle.subarray(0, byteEnd);
      // 탐색 구간을 이어받는다 — 접두어가 길어질수록 후보 구간은 좁아지기만 한다
      lo = this.lowerBound(prefix, lo, total);
      if (lo >= total) break;

      const rec = this.index[lo]!;
      // 이 접두어로 시작하는 표제어가 하나도 없으면 더 긴 접두어도 없다
      if (this.compareKey(rec, prefix) !== 0) break;

      if (this.keyByteLen(rec) === byteEnd) {
        results.push({
          word: input.slice(0, end),
          length: end,
          entries: this.readEntries(rec),
        });
      }
    }

    return results;
  }
}

// --- 로더 (브라우저/Node.js 양쪽 사용) ---

export function loadBinary(buffer: ArrayBuffer): DictSnapshot {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();
  let pos = 0;

  // Header
  const magic = view.getUint32(pos, true); pos += 4;
  if (magic !== MAGIC) throw new Error('[jieum] 잘못된 바이너리 사전 포맷');
  const version = view.getUint16(pos, true); pos += 2;
  // 하위 버전은 그대로 읽는다 — 레이아웃이 같고 새 플래그 비트만 0이 된다.
  // SDK가 IndexedDB에 캐시해 둔 옛 사전이 갑자기 못 읽히면 안 된다.
  if (version > VERSION) throw new Error(`[jieum] 지원하지 않는 사전 버전: ${version}`);
  pos += 2; // flags

  const indexed = version >= VERSION_INDEXED;

  // String Pool
  const poolSize = view.getUint32(pos, true); pos += 4;
  const poolStart = pos;
  pos += poolSize;
  // v3부터 뒤따르는 u32 표를 정렬하기 위한 패딩이 붙는다
  if (indexed) pos += poolPadding(poolSize);

  function readStringAt(offset: number, byteLen: number): string {
    return decoder.decode(bytes.subarray(poolStart + offset, poolStart + offset + byteLen));
  }

  // Dict
  const numWords = view.getUint32(pos, true); pos += 4;
  let lookup: DictLookup;

  if (indexed) {
    // 펴지 않는다 — 오프셋 표를 버퍼 위의 뷰로 잡고 넘긴다.
    // ArrayBuffer가 4바이트 정렬돼 있지 않으면 Uint32Array 뷰를 만들 수 없으므로
    // (fetch·파일 읽기 결과가 그럴 수 있다) 그때만 복사한다 — 1.8 MB다.
    const indexBytes = numWords * 4;
    const index =
      pos % 4 === 0
        ? new Uint32Array(buffer, pos, numWords)
        : new Uint32Array(buffer.slice(pos, pos + indexBytes));
    pos += indexBytes;

    // 워드 레코드 구간은 읽지 않고 건너뛴다 — 조회기가 오프셋으로 직접 읽는다.
    // 레코드는 표 순서대로 이어 쓰였으므로 마지막 레코드의 끝이 구간의 끝이다.
    if (numWords > 0) {
      const last = index[numWords - 1]!;
      pos = last + WORD_HEADER_SIZE + view.getUint16(last + 6, true) * CANDIDATE_SIZE;
    }

    lookup = new BinaryDictView(buffer, poolStart, index);
  } else {
    // v1·v2는 오프셋 표가 없고 정렬도 안 돼 있다 — 옛 방식대로 Trie로 편다
    const trie = new TrieEngine();

    for (let w = 0; w < numWords; w++) {
      const keyOffset = view.getUint32(pos, true); pos += 4;
      const keyByteLen = view.getUint16(pos, true); pos += 2;
      const numCands = view.getUint16(pos, true); pos += 2;
      const word = readStringAt(keyOffset, keyByteLen);

      const entries: ImeEntry[] = [];
      for (let c = 0; c < numCands; c++) {
        const hanjaOffset = view.getUint32(pos, true); pos += 4;
        const hanjaByteLen = view.getUint16(pos, true); pos += 2;
        const freq = view.getUint8(pos); pos += 1;
        const level = view.getUint8(pos); pos += 1;
        const meaningOffset = view.getUint32(pos, true); pos += 4;
        const meaningByteLen = view.getUint16(pos, true); pos += 2;
        const flags = view.getUint16(pos, true); pos += 2;

        const entry: ImeEntry = {
          h: readStringAt(hanjaOffset, hanjaByteLen),
          f: freq,
          l: level,
        };
        if (meaningOffset !== NO_STRING) {
          entry.m = readStringAt(meaningOffset, meaningByteLen);
        }
        if (flags & FLAG_INMYEONG) {
          entry.n = true;
        }
        if (flags & FLAG_ARCHAIC) {
          entry.a = true;
        }
        entries.push(entry);
      }

      trie.insert(word, entries);
    }

    lookup = trie;
  }

  // Compound
  const numCompounds = view.getUint32(pos, true); pos += 4;
  const compound = new Map<string, string>();
  for (let i = 0; i < numCompounds; i++) {
    const kOffset = view.getUint32(pos, true); pos += 4;
    const kByteLen = view.getUint16(pos, true); pos += 2;
    const vOffset = view.getUint32(pos, true); pos += 4;
    const vByteLen = view.getUint16(pos, true); pos += 2;
    compound.set(readStringAt(kOffset, kByteLen), readStringAt(vOffset, vByteLen));
  }

  // Blocklist
  const numBlocked = view.getUint32(pos, true); pos += 4;
  const blocklist = new Set<string>();
  for (let i = 0; i < numBlocked; i++) {
    const wOffset = view.getUint32(pos, true); pos += 4;
    const wByteLen = view.getUint16(pos, true); pos += 2;
    blocklist.add(readStringAt(wOffset, wByteLen));
  }

  // dict는 조회기가 들고 있으므로 빈 Map을 둔다 — 이것을 채우면 사전이 두 벌이 된다
  const dict = new Map<string, ImeEntry[]>();

  return { dict, compound, blocklist, lookup };
}
