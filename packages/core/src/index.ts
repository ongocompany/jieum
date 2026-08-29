// 타입
export type {
  ImeEntry,
  ImeDict,
  CompoundDict,
  Blocklist,
  CollocationRule,
  CollocationDict,
  DictSnapshot,
  DictLookup,
  PrefixMatch,
  Candidate,
  MatchResult,
  Segment,
  LookupResult,
} from './types.js';

// 사전 로더
export { createSnapshot, loadSnapshotFromFiles, type DictFormat } from './dictionary.js';

// Trie 엔진
export { TrieEngine } from './trie.js';

// 경계 감지
export { segment } from './boundary.js';

// 후보 랭킹
export { rankCandidates, type MruLookup } from './ranker.js';

// 최근 변환 이력 (랭킹 신호)
export {
  MruStore,
  DECAY_TICKS,
  FORGET_THRESHOLD,
  type MruRecord,
  type MruSnapshot,
  type MruStrength,
} from './mru.js';
export {
  UserWordStore,
  USER_WORD_CAPACITY,
  MAX_FIELD_BYTES,
  type UserWordEntry,
  type UserWordSnapshot,
} from './user-words.js';

// 바이너리 사전
export { buildBinary, loadBinary, BinaryDictView } from './binary-dict.js';

// 메인 엔진
export { JieumEngine, type DictLayer } from './engine.js';
