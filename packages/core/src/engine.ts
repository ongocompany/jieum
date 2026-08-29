import type {
  ImeEntry,
  DictSnapshot,
  DictLookup,
  MatchResult,
  Segment,
  LookupResult,
} from './types.js';
import { TrieEngine } from './trie.js';
import { isHeadwordTail, segment } from './boundary.js';
import { rankCandidates, USER_WORD_SCORE } from './ranker.js';
import type { MruStore } from './mru.js';
import type { UserWordEntry, UserWordStore } from './user-words.js';

/**
 * 레이어 사전은 변경 가능한 조회기를 요구한다
 *
 * 바이너리 사전은 읽기 전용 버퍼라 병합할 자리가 없다. 조용히 무시하면
 * "사전을 켰는데 후보가 안 늘어난다"로만 드러나므로 명시적으로 던진다.
 */
const MUTABLE_DICT_REQUIRED =
  '[jieum] 레이어 사전은 변경 가능한 조회기(TrieEngine)에서만 쓸 수 있다 — ' +
  '바이너리 사전(BinaryDictView)은 읽기 전용이다';

/** 레이어 사전 정보 */
export interface DictLayer {
  /** 사전 이름 (고유 식별자) */
  name: string;
  /** 표시명 */
  label: string;
  /** 단어 수 */
  wordCount: number;
  /** 활성 상태 */
  active: boolean;
}

/**
 * jieum 코어 엔진
 *
 * 입력 텍스트를 분석하여 한자 변환 후보를 반환하는 메인 클래스.
 * 플랫폼 독립적 — DOM, 브라우저, OS API 의존 없음.
 *
 * 다중 사전 지원:
 *   - 기본 사전: 항상 활성
 *   - 레이어 사전: addDict/removeDict로 동적 추가/제거
 */
export class JieumEngine {
  /**
   * 표제어 조회기
   *
   * 바이너리 사전을 받으면 {@link BinaryDictView}(읽기 전용, 버퍼 위 이진 탐색),
   * 그 외에는 {@link TrieEngine}이 온다. 엔진은 어느 쪽인지 알 필요가 없고,
   * 레이어 사전만 변경 가능한 구현을 요구한다.
   */
  private index: DictLookup;
  private snapshot: DictSnapshot;
  /** 등록된 레이어 사전 목록 */
  private layers = new Map<string, { label: string; words: Map<string, ImeEntry[]> }>();
  /**
   * 최근 변환 이력
   *
   * 사전 엔트리의 97.6%가 빈도 0이라 사실상 유일한 랭킹 신호다.
   * 어디에 어떤 범위로 저장할지는 core가 정하지 않는다 — 주입받는다.
   */
  private mru?: MruStore;
  /**
   * 사용자가 낱자를 이어 만든 조합
   *
   * 사전과 **다른 저장소**다(`user-words.ts` 머리말). 조회 결과의 맨 앞에 붙는다 —
   * 사용자가 조합하는 것은 대개 사전에 표제어가 없는 이름·서명·구절이라
   * 사전 후보와 겹칠 가능성이 낮다.
   */
  private userWords?: UserWordStore;

  constructor(snapshot: DictSnapshot, options?: { mru?: MruStore; userWords?: UserWordStore }) {
    this.snapshot = snapshot;
    this.index = snapshot.lookup ?? TrieEngine.fromDict(snapshot.dict);
    this.mru = options?.mru;
    this.userWords = options?.userWords;
  }

  /** 최근 변환 이력 교체 (저장소에서 복원한 뒤 주입) */
  setMru(mru: MruStore | undefined): void {
    this.mru = mru;
  }

  /** 사용자 조합 저장소 교체 (저장소에서 복원한 뒤 주입) */
  setUserWords(store: UserWordStore | undefined): void {
    this.userWords = store;
  }

  /**
   * 조합 하나를 배운다.
   *
   * 「이어서 쳐진 낱자들인가」를 가리는 일은 여기서 하지 않는다 — 엔진은 커서를 모른다.
   * 그 판정은 앞 문맥을 볼 수 있는 `engine-server`의 `AssemblyTracker`가 한다.
   */
  recordUserWord(reading: string, hanja: string, now = Date.now()): void {
    this.userWords?.record(reading, hanja, now);
  }

  /** 사용자가 손으로 잊는다. 잊었으면 `true` */
  forgetUserWord(reading: string, hanja: string): boolean {
    return this.userWords?.forget(reading, hanja) ?? false;
  }

  /**
   * 지금 치는 글의 접두사와 맞는 사용자 조합들을 그룹으로 만든다.
   *
   * 블록리스트는 사전과 **똑같이** 적용한다 — 사용자가 조합했다는 이유로 막아 둔 말이
   * 되살아나면 블록리스트가 있으나 마나가 된다.
   */
  private userWordResults(text: string): LookupResult[] {
    const hits = this.userWords?.prefixMatches(text) ?? [];
    if (hits.length === 0) return [];

    const byLength = new Map<number, UserWordEntry[]>();
    for (const hit of hits) {
      if (this.snapshot.blocklist.has(hit.reading)) continue;
      const list = byLength.get(hit.reading.length) ?? [];
      list.push(hit);
      byLength.set(hit.reading.length, list);
    }

    return [...byLength.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([length, group]) => ({
        word: group[0]!.reading,
        length,
        candidates: group.map((h) => ({
          word: h.reading,
          hanja: h.hanja,
          score: USER_WORD_SCORE + h.strength,
          freq: 0,
          level: 0,
          used: h.count,
          source: 'user' as const,
        })),
        type: 'normal' as const,
      }));
  }

  /**
   * 사용 이력을 담을 곳이 있는가
   *
   * 없으면 {@link recordChoice}가 **조용히 아무것도 하지 않는다.** 확정을 받아
   * 기록하는 쪽(입력기 엔진 서버 등)이 기동할 때 이것을 확인해 경고할 수 있게
   * 노출한다 — 학습이 안 되는데 아무 신호도 없는 상태를 만들지 않기 위해서다.
   */
  get hasMru(): boolean {
    return this.mru !== undefined;
  }

  /**
   * 앞 문맥에서 볼 범위 (글자 수)
   *
   * 지음에는 뒤 문맥이 없다 — 타이핑 중이라 아직 쓰이지 않았다. 그래서
   * 한자한자처럼 문서 전체를 보지 못하고 커서 앞만 본다.
   *
   * 범위를 두는 이유는 두 가지다. 길면 앞 문단의 관계없는 단어가 우연히
   * 걸리고, 조회마다 도는 문자열 탐색 비용도 길이에 비례한다. 200자는
   * 논문 한 문단 정도로, 같은 화제가 유지되는 범위다.
   */
  private static readonly CONTEXT_WINDOW = 200;

  private contextWindow(context: string | undefined): string {
    if (!context) return '';
    return context.length > JieumEngine.CONTEXT_WINDOW
      ? context.slice(-JieumEngine.CONTEXT_WINDOW)
      : context;
  }

  /**
   * 앞 문맥에 걸린 문맥어를 한자별로 센다
   *
   * 규칙은 표제어로 먼저 찾으므로 전체 문맥어 14.7만 개를 훑지 않는다 —
   * 이 표제어의 규칙(평균 1.5개, 문맥어 8.5개)만 본다.
   */
  private matchCollocation(word: string, window: string): Map<string, number> | undefined {
    if (!window) return undefined;
    const rules = this.snapshot.collocation?.get(word);
    if (!rules) return undefined;

    let hits: Map<string, number> | undefined;
    for (const rule of rules) {
      let count = 0;
      for (const ctx of rule.c) {
        if (window.includes(ctx)) count++;
      }
      if (count > 0) {
        hits ??= new Map();
        hits.set(rule.h, (hits.get(rule.h) ?? 0) + count);
      }
    }
    return hits;
  }

  /**
   * 사용 이력을 나눠 담을 문맥 키
   *
   * 연어가 가장 강하게 지목한 한자를 그대로 쓴다. 문맥어 145,964개가 "이
   * 문맥은 어느 쪽"으로 이미 요약돼 있으므로, 그 결론 한 글자가 문맥의
   * 이름이 된다. Mozc가 앞 단어 하나(bigram)로 하는 일을 더 넓은 범위로
   * 하는 셈이다.
   *
   * 연어 규칙이 없거나 아무것도 안 걸리면 undefined — 그때는 표제어 단위
   * 학습으로 돌아간다. 사전 표제어의 97.7%가 여기에 해당한다.
   *
   * 조회와 기록이 **같은 함수**로 키를 만들어야 한다. 어긋나면 방금 고른
   * 것을 다음 조회에서 못 찾는다.
   */
  private mruContext(word: string, context: string | undefined): string | undefined {
    return dominantHanja(this.matchCollocation(word, this.contextWindow(context)));
  }

  /**
   * 사용자가 후보를 확정했음을 기록한다
   *
   * 확정 시점마다 호출해야 다음 조회에서 상단으로 올라온다.
   * now를 주입받는 이유는 core를 시계에 묶지 않기 위해서다(시험 재현성).
   *
   * `context`는 조회 때와 **같은 앞 문맥**이어야 한다. 문맥마다 이력을
   * 따로 담으므로, 기록과 조회가 다른 칸을 보면 방금 고른 것이 다음
   * 조회에서 사라진다.
   */
  recordChoice(
    word: string,
    hanja: string,
    now: number = Date.now(),
    context?: string,
  ): void {
    this.recordChoiceWithContextKey(word, hanja, this.mruContext(word, context), now);
  }

  /**
   * 문맥 키를 직접 주고 기록한다
   *
   * 앞 문맥 문자열이 아니라 **조회가 돌려준 {@link LookupResult.contextKey}** 를 받는다.
   *
   * 조회와 확정이 프로세스를 사이에 두고 떨어져 있을 때 필요하다. 입력기 셸은
   * 조합 중에 조회하고 사용자가 고른 뒤에 확정하는데, 그 사이에 커서가 움직였거나
   * 앞 글자가 바뀌었을 수 있다. 확정 시점에 문맥을 다시 읽으면 조회 때와 다른 칸에
   * 기록되고, 방금 고른 것이 다음 조회에서 사라진다.
   *
   * {@link recordChoice}는 문맥을 그 자리에서 읽어도 안전한 쪽(편집기·SDK)이 쓴다.
   */
  recordChoiceWithContextKey(
    word: string,
    hanja: string,
    contextKey: string | undefined,
    now: number = Date.now(),
  ): void {
    this.mru?.record(word, hanja, now, contextKey);
  }

  /** Trie에 등록된 단어 수 */
  get dictSize(): number {
    return this.index.size;
  }

  // ─── 다중 사전 API ───

  /**
   * 레이어 사전 추가
   * @param name 고유 식별자 (예: 'archaic', 'legal')
   * @param label 표시명 (예: '고어/사어', '법률 용어')
   * @param dict 사전 데이터 { 한글: ImeEntry[] }
   */
  addDict(name: string, label: string, dict: Record<string, ImeEntry[]>): void {
    const merge = this.index.merge?.bind(this.index);
    if (!merge) throw new Error(MUTABLE_DICT_REQUIRED);

    // 이미 있으면 먼저 제거
    if (this.layers.has(name)) {
      this.removeDict(name);
    }

    const words = new Map<string, ImeEntry[]>();
    for (const [key, entries] of Object.entries(dict)) {
      // 태그 부착
      const tagged = entries.map(e => ({ ...e, _tag: name }));
      words.set(key, tagged);
      merge(key, tagged);
    }

    this.layers.set(name, { label, words });
  }

  /**
   * 레이어 사전 제거
   */
  removeDict(name: string): void {
    const layer = this.layers.get(name);
    if (!layer) return;

    const removeByTag = this.index.removeByTag?.bind(this.index);
    if (!removeByTag) throw new Error(MUTABLE_DICT_REQUIRED);

    for (const key of layer.words.keys()) {
      removeByTag(key, name);
    }

    this.layers.delete(name);
  }

  /**
   * 등록된 레이어 사전 목록
   */
  listDicts(): DictLayer[] {
    return Array.from(this.layers.entries()).map(([name, layer]) => ({
      name,
      label: layer.label,
      wordCount: layer.words.size,
      active: true,
    }));
  }

  /**
   * 레이어 사전 존재 여부
   */
  hasDict(name: string): boolean {
    return this.layers.has(name);
  }

  /**
   * 텍스트를 세그먼트로 분할
   */
  segment(text: string): Segment[] {
    return segment(text, this.index, this.snapshot.blocklist);
  }

  /**
   * 표제어가 사전에 그대로 있는지만 확인한다 (후보 랭킹 없음)
   *
   * lookup()은 후보를 스코어링·정렬하므로 "있는지"만 알면 될 때는 과하다.
   * 입력기가 매 키 입력마다 버퍼 구간을 탐색할 때 쓴다.
   * 블록리스트 판정은 lookup()과 동일하게 적용한다.
   */
  hasWord(word: string): boolean {
    if (!word || this.snapshot.blocklist.has(word)) return false;
    return this.index.exactMatch(word) !== null;
  }

  /**
   * 텍스트에서 한자 변환 후보를 검색
   *
   * 1. BoundaryDetector로 세그먼트 분할
   * 2. hanja_candidate 세그먼트에 대해 Ranker로 후보 스코어링
   * 3. MatchResult[] 반환
   */
  convert(text: string): MatchResult[] {
    const segments = this.segment(text);
    const results: MatchResult[] = [];
    let pos = 0;

    for (const seg of segments) {
      if (seg.convertible) {
        const entries = this.index.exactMatch(seg.text);
        if (entries) {
          const candidates = rankCandidates(
            seg.text,
            entries,
            this.snapshot.compound,
            this.mru,
          );

          const top = candidates[0];
          if (top) {
            results.push({
              word: seg.text,
              hanja: top.hanja,
              startIdx: pos,
              endIdx: pos + seg.text.length,
              candidates,
            });
          }
        }
      }
      pos += seg.text.length;
    }

    return results;
  }

  /**
   * 입력 버퍼에 **지금 유효한** prefix match를 길이별로 반환 (팝업용)
   *
   * 예: lookup("발전소를") → [
   *   { word: "발전소", length: 3, candidates: [{hanja: "發電所", ...}] },
   * ]
   *
   * ## 지나간 표제어는 내지 않는다
   *
   * 접두 매칭을 전부 내면 사용자가 **이미 지나쳐 간** 표제어가 계속 따라온다 —
   * `후보라고`까지 쳤는데 候補가, `말러`까지 쳤는데 말(妺·末…)이 떠 있는 식이다.
   * 노이즈일 뿐 아니라 그 상태에서 후보를 고르면 조합이 통째로 잘못 확정된다.
   *
   * 그래서 표제어 뒤에 남은 꼬리가 조사·어미이거나 조합 중인 낱자일 때만 살린다
   * (`isHeadwordTail`). `발전소를`의 `를`은 한자로 바뀌지 않고 한글로 남으므로
   * 표제어는 여전히 유효하지만, `말러`의 `러`는 사용자가 다른 단어를 치는 중이라는
   * 뜻이다.
   *
   * 대가로 "발전소를 치다 발전을 고르는" 경로가 사라진다. 그건 `발전`까지 쳤을 때
   * 고르면 된다.
   */
  lookup(text: string, context?: string): LookupResult[] {
    if (!text) return [];

    const window = this.contextWindow(context);
    const prefixes = this.index.commonPrefixSearch(text);
    const results: LookupResult[] = [];

    // 긴 매칭부터 (역순)
    for (let i = prefixes.length - 1; i >= 0; i--) {
      const prefix = prefixes[i]!;

      // 블록리스트 체크
      if (this.snapshot.blocklist.has(prefix.word)) continue;

      // 사용자가 이미 지나쳐 간 표제어인가 (위 주석 참조)
      if (!isHeadwordTail(text.slice(prefix.word.length))) continue;

      const hits = this.matchCollocation(prefix.word, window);

      // 랭킹이 볼 문맥 키와 사용 이력에 쓸 문맥 키는 **같은 값**이어야 한다.
      // 한 번 구해 둘 다에 넘긴다 — 따로 구하면 어긋날 수 있고, 어긋나면
      // 방금 고른 것을 다음 조회에서 못 찾는다 (mruContext 주석 참조).
      const contextKey = dominantHanja(hits);

      const candidates = rankCandidates(
        prefix.word,
        prefix.entries,
        this.snapshot.compound,
        this.mru,
        hits,
        contextKey,
      );

      // 인명용은 별도 축이므로 먼저 떼어낸다
      const inmyeong = candidates.filter((c) => c.inmyeong);
      const general = candidates.filter((c) => !c.inmyeong);

      // 1층(현대어) / 2층(고어·전문어) 분리
      //
      // 2층을 펼침으로 내리는 것은 **동음이의가 경합할 때만** 의미가 있다.
      // 2층 후보만 있는 표제어도 많으므로 1층이 비면 2층을 그대로 normal로 낸다.
      //
      // 한 번이라도 고른 후보는 2층이어도 1층으로 올린다. 점수만 올리면
      // 그룹 분리가 그것을 무력화해 영영 펼쳐야만 보인다 — 그러면 2층 구분의
      // 사용 이력으로 후보를 끌어올리는 효과가 사라진다.
      const modern = general.filter((c) => !c.archaic || c.used);
      const archaic = general.filter((c) => c.archaic && !c.used);
      const hasModern = modern.length > 0;

      if (hasModern) {
        results.push({
          word: prefix.word,
          length: prefix.length,
          candidates: modern,
          type: 'normal',
          contextKey,
        });
      }

      if (archaic.length > 0) {
        results.push({
          word: prefix.word,
          length: prefix.length,
          candidates: archaic,
          type: hasModern ? 'archaic' : 'normal',
          contextKey,
        });
      }

      if (inmyeong.length > 0) {
        results.push({
          word: prefix.word,
          length: prefix.length,
          candidates: inmyeong,
          type: 'inmyeong',
          contextKey,
        });
      }
    }

    // 사용자가 만든 조합을 **맨 앞에** 붙인다. 사전이 추측한 것이 아니라 사용자가
    // 한 글자씩 확인하며 만든 것이므로 신뢰 문제가 없다 (설계 §1·§9).
    results.unshift(...this.userWordResults(text));

    // 정렬하지 않는다 — 위 루프가 이미 "긴 매칭 우선, 그 안에서 층 순서"로 낸다.
    //   정치[1층] → 정치[2층] → 정치[인명용] → 정[1층] → 정[2층] → …
    // 층을 전역 우선순위로 올리면 "정치"의 2층 5개가 "정"의 1층 64개 뒤로
    // 밀려, 정작 사용자가 친 단어의 후보를 한참 지나야 만나게 된다.
    //
    // 접힘 첫 줄을 최장 매칭의 1층으로 좁히는 일은 표시 계층이 맡는다
    // (browser의 countCollapsedCandidates).
    return results;
  }

  /**
   * 텍스트를 한자 변환하여 annotated 문자열로 반환 (CLI 데모용)
   *
   * 예: "경제 발전" → "경제(經濟) 발전(發展)"
   */
  convertToString(text: string): string {
    const matches = this.convert(text);

    if (matches.length === 0) return text;

    let result = '';
    let lastIdx = 0;

    for (const match of matches) {
      // 매칭 이전의 텍스트 (조사, 공백 등)
      result += text.slice(lastIdx, match.startIdx);
      // 매칭된 부분: 원문(한자)
      result += `${match.word}(${match.hanja})`;
      lastIdx = match.endIdx;
    }

    // 나머지 텍스트
    result += text.slice(lastIdx);

    return result;
  }
}

/**
 * 문맥이 가장 강하게 지목한 한자
 *
 * 여러 규칙이 동시에 걸리면 문맥어가 더 많이 맞은 쪽을 택한다. 이 값이
 * 사용 이력을 나눠 담는 칸 이름이 되므로 **결정적**이어야 한다 —
 * 조회와 기록이 다른 칸을 고르면 방금 고른 것이 다음에 사라진다.
 */
function dominantHanja(hits: Map<string, number> | undefined): string | undefined {
  if (!hits || hits.size === 0) return undefined;

  let top: string | undefined;
  let best = 0;
  for (const [hanja, count] of hits) {
    // 동률이면 먼저 나온 쪽 — Map은 삽입 순서를 지키고 그 순서는
    // 사전의 규칙 순서라, 같은 입력이면 늘 같은 답이 나온다.
    if (count > best) {
      best = count;
      top = hanja;
    }
  }
  return top;
}
