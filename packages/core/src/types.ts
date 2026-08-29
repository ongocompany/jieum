/** IME 사전 엔트리 (빌드된 경량 포맷) */
export interface ImeEntry {
  /** 한자 */
  h: string;
  /** 빈도 (0~100) */
  f: number;
  /** 급수 */
  l: number;
  /** 훈(뜻) — 1글자 한자에만 존재 */
  m?: string;
  /** 인명용 한자 여부 */
  n?: boolean;
  /**
   * 2층(고어·전문어) 여부
   *
   * 현대 한국어 중심 사전에서 제외한 항목이다. 지음은 이 항목을 지우지 않고
   * 후보 층만 나눈다.
   * 동음이의가 경합할 때 첫 줄을 현대어로 채우고 나머지는 펼침으로 내리는
   * 정렬 신호로 쓴다. 1층 후보가 아예 없으면 그대로 첫 줄에 낸다.
   */
  a?: boolean;
  /** 레이어 사전 태그 (내부용) */
  _tag?: string;
}

/** IME 사전: 한글 → 한자 후보 배열 */
export type ImeDict = Map<string, ImeEntry[]>;

/** 복합어 사전: 한글 → 한자 (1:1) */
export type CompoundDict = Map<string, string>;

/** 고유어 블록리스트 */
export type Blocklist = Set<string>;

/** 연어 규칙 하나 — 이 문맥어 중 하나가 앞에 있으면 이 한자를 밀어올린다 */
export interface CollocationRule {
  /** 밀어올릴 한자 */
  h: string;
  /** 문맥어 (OR 조건) */
  c: string[];
}

/**
 * 연어 사전: 한글 → 규칙 배열
 *
 * 한자한자에서 옮겨온 문맥 판별 자산이다. 한자한자는 이것으로 한자를
 * **확정**하지만(자동 변환이라 골라줘야 한다), 지음은 후보를 제안하고
 * 사용자가 고르므로 **순위 보너스**로만 쓴다. 문맥이 맞으면 위로 올리고,
 * 안 맞아도 후보에서 빼지 않는다.
 */
export type CollocationDict = Map<string, CollocationRule[]>;

/** 사전 스냅샷 (엔진에 주입) */
export interface DictSnapshot {
  dict: ImeDict;
  compound: CompoundDict;
  blocklist: Blocklist;
  /** 연어 규칙 — 없으면 문맥 보너스 없이 동작한다 */
  collocation?: CollocationDict;
  /**
   * 미리 만들어진 조회기 — 있으면 {@link dict}는 쓰이지 않는다
   *
   * 바이너리 사전은 표제어를 Map으로 펴지 않고 버퍼 위에서 바로 조회하므로,
   * 이 자리가 채워져 오면 `dict`는 빈 Map으로 온다. 둘 다 채우면 같은 사전을
   * 두 벌 들게 된다 — 그것이 엔진이 572 MB를 쓰던 이유다.
   */
  lookup?: DictLookup;
}

/** Trie Common Prefix Search 결과 */
export interface PrefixMatch {
  /** 매칭된 한글 단어 */
  word: string;
  /** 매칭 길이 (음절 수) */
  length: number;
  /** 매칭된 사전 엔트리 */
  entries: ImeEntry[];
}

/**
 * 표제어 조회 계약
 *
 * 엔진이 사전에 요구하는 것은 이 둘뿐이다 — 정확히 있는가, 그리고 이 입력의
 * 어느 접두어까지가 표제어인가. 구현은 두 가지다:
 *
 * - {@link TrieEngine} — 음절 Trie. 만들기 쉽지만 노드마다 `Map`이 하나씩 붙어
 *   47.9만 표제어에서 **438 MB**를 쓴다(2026-08-01 실측). 시험과 소규모 사전용.
 * - {@link BinaryDictView} — 정렬된 바이너리 위의 이진 탐색. 객체를 만들지
 *   않으므로 원본 크기(24.7 MB)에 머문다. 실사전을 올리는 경로.
 *
 * 계약을 분리해 두는 이유는 **두 구현이 같은 답을 내는지 대조**하기 위해서다.
 * 조회는 입력기의 모든 제안이 지나가는 길목이라, 조용히 어긋나면 "가끔 후보가
 * 안 뜬다"로만 드러난다.
 */
export interface DictLookup {
  /** 등록된 표제어 수 */
  readonly size: number;
  /** 정확히 일치하는 표제어의 엔트리 (없으면 null) */
  exactMatch(key: string): ImeEntry[] | null;
  /** 입력의 모든 접두어 매칭 (짧은 것부터) */
  commonPrefixSearch(input: string): PrefixMatch[];
  /**
   * 레이어 사전 병합 — 변경 가능한 구현만 제공한다
   *
   * 바이너리 조회기는 읽기 전용이라 이 자리가 비어 있다. 호출부가 없으면
   * 조용히 무시하는 대신 {@link JieumEngine.addDict}가 명시적으로 던진다.
   */
  merge?(key: string, entries: ImeEntry[]): void;
  /** 레이어 사전 제거 — 변경 가능한 구현만 제공한다 */
  removeByTag?(key: string, tag: string): void;
}

/** 텍스트 세그먼트 (경계 감지 결과) */
export interface Segment {
  /** 텍스트 */
  text: string;
  /** 유형 */
  type: 'hanja_candidate' | 'native_korean' | 'particle' | 'whitespace';
  /** 한자 변환 가능 여부 */
  convertible: boolean;
}

/** 변환 후보 */
export interface Candidate {
  /** 원문 한글 */
  word: string;
  /** 한자 */
  hanja: string;
  /** 스코어 (높을수록 우선) */
  score: number;
  /** 빈도 (0~100) */
  freq: number;
  /** 급수 */
  level: number;
  /** 훈(뜻) — 1글자 한자에만 존재 */
  meaning?: string;
  /** 인명용 한자 여부 */
  inmyeong?: boolean;
  /** 2층(고어·전문어) 여부 */
  archaic?: boolean;
  /** 사용자가 고른 횟수 (MRU) — 고른 적 없으면 undefined */
  used?: number;
  /** 앞 문맥에서 걸린 연어 문맥어 수 — 걸리지 않았으면 undefined */
  collocation?: number;
  /** 출처 */
  source: 'compound' | 'dictionary' | 'collocation' | 'user';
}

/** 길이별 후보 그룹 (lookup용) */
export interface LookupResult {
  /** 매칭된 한글 */
  word: string;
  /** 매칭 길이 */
  length: number;
  /** 후보 목록 (스코어순) */
  candidates: Candidate[];
  /**
   * 그룹 유형
   *
   * archaic은 **1층 후보가 따로 있을 때만** 생긴다. 1층 후보가 없는 표제어는
   * normal로 승격해 첫 줄에 낸다.
   */
  type?: 'normal' | 'archaic' | 'inmyeong';
  /**
   * 이 조회 시점에 이 표제어가 놓인 문맥의 이름 (사용 이력을 나눠 담는 칸)
   *
   * 확정할 때 앞 문맥을 **다시 읽으면 안 된다**. 조회와 확정 사이에 커서가
   * 움직였을 수 있고, 그러면 방금 고른 것이 엉뚱한 칸에 쌓여 다음 조회에서
   * 사라진다. 조회가 쓴 키를 그대로 들고 와서 기록해야 한다
   * ({@link JieumEngine.recordChoiceWithContextKey}).
   *
   * 표제어마다 다르다 — "발전소"와 "발전"은 같은 앞 문맥에서도 서로 다른
   * 연어 규칙에 걸리므로 칸이 다르다.
   */
  contextKey?: string;
}

/** 텍스트 매칭 결과 */
export interface MatchResult {
  /** 원문 한글 */
  word: string;
  /** 대표 한자 (1순위) */
  hanja: string;
  /** 원문 내 시작 인덱스 */
  startIdx: number;
  /** 원문 내 끝 인덱스 */
  endIdx: number;
  /** 모든 후보 (스코어순) */
  candidates: Candidate[];
}
