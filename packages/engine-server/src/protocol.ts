/**
 * 지음 엔진 프로토콜 v1 — NDJSON over local socket
 *
 * 플랫폼 셸(macOS IMK 입력기, 나중에 윈도우 TSF)과 엔진 서버 사이의 **유일한 계약**이다.
 * 변환 로직은 셸에 들어가지 않는다 (docs/07 §0). 셸에서 엔진 로직이 필요해 보이면
 * 그것은 여기에 메시지가 빠진 것이므로, 셸에 로직을 넣지 말고 이 파일을 늘린다.
 *
 * 파괴적 변경은 {@link PROTOCOL_VERSION}을 올리고 **양쪽을 같은 커밋에** 고친다.
 * 필드 추가는 파괴적 변경이 아니다 (구버전 클라이언트는 모르는 필드를 무시한다).
 *
 * M0 시점 구현 범위: `hello` / `ping` / `lookup`.
 * `sessionOpen` / `sessionClose` / `commit`은 타입만 여기 박아 두고 M2에서 처리기를 채운다 —
 * 와이어 계약을 한 번에 적어 두어야 세션 간 설계 드리프트가 생기지 않는다.
 *
 * ## 숫자 필드에 관한 규약 (2026-08-01, M0에서 실제로 당함)
 *
 * JSON에는 정수/실수 구분이 없고 TS의 `number`도 마찬가지라, 이쪽에서는 아무 문제가
 * 없어 보이는 필드가 **강타입 클라이언트(Swift)에서 해석 실패로 터진다.**
 * `Candidate.level`(급수)이 `7.5`로 나가는 것을 Swift가 `Int`로 받아 조회 응답 전체가
 * 조용히 버려졌고, 증상은 "제안이 아예 안 뜬다"였다.
 *
 * 그래서 이 프로토콜은 **정수를 보장하는 필드를 명시적으로 한정한다**:
 * `v`, `id`, `token`, `WireLookupGroup.length`. 나머지 숫자는 소수가 올 수 있다.
 * 이 목록을 늘리려면 서버가 정말로 정수만 낸다는 근거가 있어야 한다.
 */

import type { Candidate, LookupResult } from '@jieum/core';

/** 프로토콜 버전. 불일치는 조용히 넘어가지 않고 즉시 실패한다 (Mozc 선례) */
export const PROTOCOL_VERSION = 1;

// --- 요청 ---

export type RequestOp =
  | 'hello'
  | 'ping'
  | 'lookup'
  | 'sessionOpen'
  | 'sessionClose'
  | 'commit'
  | 'forgetUserWord';

export interface RequestBase {
  /** 프로토콜 버전 */
  v: number;
  /** 클라이언트가 매긴 요청 번호. 응답에 그대로 실려 돌아온다 */
  id: number;
  op: RequestOp;
}

/** 최초 악수. 버전·사전 지문을 확인한다 */
export interface HelloRequest extends RequestBase {
  op: 'hello';
  /** 셸의 버전 문자열 (로그·진단용) */
  clientVersion: string;
}

/** 생존 확인 + M0 측정 훅 */
export interface PingRequest extends RequestBase {
  op: 'ping';
}

/** 조합 중인 버퍼에 대한 후보 조회 */
export interface LookupRequest extends RequestBase {
  op: 'lookup';
  /** 조합 중인 한글 버퍼 */
  buffer: string;
  /** 커서 앞 문맥 (연어 판별용). 호스트 앱이 주지 못하면 생략 — 버퍼만으로 돈다 */
  precedingText?: string;
  /** M2에서 필수가 된다. M0 서버는 받되 쓰지 않는다 */
  sessionId?: string;
}

/** IMKInputController 인스턴스 하나당 세션 하나 (M2) */
export interface SessionOpenRequest extends RequestBase {
  op: 'sessionOpen';
}

export interface SessionCloseRequest extends RequestBase {
  op: 'sessionClose';
  sessionId: string;
}

/**
 * 사용자가 후보를 확정했다 (M2). MRU에 기록된다.
 *
 * `contextKey`는 **lookup 응답에서 받은 값을 그대로 돌려보낸다**. 확정 시점에
 * 문맥을 다시 읽으면 안 된다 — 그 사이 커서가 움직였을 수 있고, 그러면 사용 이력이
 * 엉뚱한 문맥에 쌓인다. 이 함정을 주석이 아니라 와이어 계약으로 막는다.
 */
export interface CommitRequest extends RequestBase {
  op: 'commit';
  sessionId?: string;
  /** 확정된 한글 표제어 */
  headword: string;
  /** 확정된 한자 */
  hanja: string;
  /** lookup 응답의 contextKey를 그대로 에코 */
  contextKey?: string;
}

/**
 * 사용자가 손으로 조합을 잊는다.
 *
 * 잘못 배운 것이 계속 첫 줄에 오면 기능이 없느니만 못하다. 자동 학습만으로는 나쁜
 * 항목을 영영 막을 수 없으므로 **사람의 거부권**이 어딘가에 있어야 한다
 * (설계 §5.6·§6).
 */
export interface ForgetUserWordRequest extends RequestBase {
  op: 'forgetUserWord';
  /** 잊을 조합의 한글 */
  reading: string;
  /** 잊을 조합의 한자 */
  hanja: string;
}

export type Request =
  | HelloRequest
  | PingRequest
  | LookupRequest
  | SessionOpenRequest
  | SessionCloseRequest
  | CommitRequest
  | ForgetUserWordRequest;

// --- 응답 ---

export type ErrorCode =
  /** JSON이 아니거나 필수 필드가 없다 */
  | 'bad_request'
  /** 프로토콜 버전 불일치 — 셸은 이 응답을 보면 재기동해야 한다 */
  | 'version_mismatch'
  /** 아는 op이지만 이 단계에서는 아직 구현되지 않았다 */
  | 'unimplemented'
  /** 처리 중 엔진이 던졌다 */
  | 'internal';

export interface ErrorReply {
  v: number;
  id: number;
  ok: false;
  error: { code: ErrorCode; message: string };
}

export interface HelloReply {
  v: number;
  id: number;
  ok: true;
  /** 엔진 서버 패키지 버전 */
  serverVersion: string;
  protocolV: number;
  /** 사전 빌드 지문. 셸이 캐시를 들고 있다면 이 값으로 무효화한다 */
  dictFingerprint: string;
}

export interface PingReply {
  v: number;
  id: number;
  ok: true;
  uptimeMs: number;
  rssBytes: number;
}

/**
 * 후보 그룹. core의 {@link LookupResult}와 같은 모양이다.
 *
 * 별도 타입으로 적어 두는 이유: core는 자유롭게 진화해야 하지만 와이어는 버전이 붙은
 * 계약이다. 아래 컴파일 타임 단언이 core에서 필드가 사라지거나 이름이 바뀌는 순간
 * (= 셸이 깨지는 변경) 빌드를 실패시킨다. 필드 추가는 통과한다 — 파괴적이지 않으니까.
 */
export interface WireCandidate {
  word: string;
  hanja: string;
  score: number;
  freq: number;
  level: number;
  meaning?: string;
  inmyeong?: boolean;
  archaic?: boolean;
  used?: number;
  collocation?: number;
  /**
   * 출처. `user`는 사용자가 낱자를 이어 만든 조합이다 — 셸은 이 값으로
   * 「이 후보 잊기」를 사용자 조합에만 켠다.
   */
  source: 'compound' | 'dictionary' | 'collocation' | 'user';
}

export interface WireLookupGroup {
  word: string;
  length: number;
  candidates: WireCandidate[];
  type?: 'normal' | 'archaic' | 'inmyeong';
  /**
   * 이 조회 시점에 이 표제어가 놓인 문맥의 이름. 확정할 때 그대로 돌려보낸다.
   *
   * **그룹마다 다르다.** 계획서(docs/07 §2)의 스케치는 응답 하나에 하나로 적었는데,
   * 조회는 길이별로 여러 표제어를 돌려주고("발전소"·"발전"·"발") 각 표제어는 서로
   * 다른 연어 규칙에 걸리므로 문맥 칸도 따로다. 응답 단위로 두면 사용자가 고른 것과
   * 다른 표제어의 키가 기록된다.
   */
  contextKey?: string;
}

// core가 와이어 계약을 조용히 깨지 못하게 하는 관문.
// core의 Candidate/LookupResult가 여기 형태로 대입 불가능해지면 컴파일이 깨진다.
type AssertAssignable<T extends U, U> = T;
export type _CandidateContract = AssertAssignable<Candidate, WireCandidate>;
export type _LookupContract = AssertAssignable<LookupResult, WireLookupGroup>;

export interface LookupReply {
  v: number;
  id: number;
  ok: true;
  /**
   * 연결마다 단조 증가하는 조회 번호. 클라이언트는 지금까지 본 최댓값보다 작은
   * 응답을 버린다 (latest-wins).
   *
   * 요청 `id`와 따로 두는 이유: latest-wins 규칙이 클라이언트의 id 발급 방식
   * (재사용·래핑 등)에 의존하지 않게 하려는 것. 순서의 근거는 서버가 쥔다.
   */
  token: number;
  /** 문맥 키는 그룹마다 붙는다 ({@link WireLookupGroup.contextKey}) */
  groups: WireLookupGroup[];
}

export interface SessionOpenReply {
  v: number;
  id: number;
  ok: true;
  sessionId: string;
}

export interface OkReply {
  v: number;
  id: number;
  ok: true;
}

/** 잊기 결과. `forgotten`이 false면 그런 조합이 없었다는 뜻이다 */
export interface ForgetUserWordReply {
  v: number;
  id: number;
  ok: true;
  forgotten: boolean;
}

export type Reply =
  | ErrorReply
  | HelloReply
  | PingReply
  | LookupReply
  | SessionOpenReply
  | ForgetUserWordReply
  | OkReply;

// --- 검증 ---

/**
 * 들어온 값이 최소한의 봉투 형태를 갖췄는지 본다.
 *
 * 세부 필드 검증은 각 처리기가 한다. 여기서는 응답을 만들려면 반드시 있어야 하는
 * `id`와 `op`만 본다 — 그것이 없으면 오류 응답조차 어디로 돌려줄지 알 수 없다.
 */
export function parseEnvelope(
  value: unknown,
): { ok: true; req: RequestBase & Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: '객체가 아님' };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj['id'] !== 'number') return { ok: false, reason: 'id 없음' };
  if (typeof obj['op'] !== 'string') return { ok: false, reason: 'op 없음' };
  if (typeof obj['v'] !== 'number') return { ok: false, reason: 'v 없음' };
  return { ok: true, req: obj as unknown as RequestBase & Record<string, unknown> };
}

export function errorReply(id: number, code: ErrorCode, message: string): ErrorReply {
  return { v: PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}
