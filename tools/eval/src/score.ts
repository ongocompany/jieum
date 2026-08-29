/**
 * 채점 — 사용자가 원하는 한자를 **찾을 수 있는가**, 찾는 데 얼마가 드는가.
 *
 * ## 순위와 누락을 나누어 평가한다
 *
 * 그래서 지표를 **등급이 다른 둘**로 나눈다:
 *
 * - **결함**: 후보 목록에 아예 없다. 사용자에게 다른 길이 없으므로 도구가 실패한 것이다.
 *   원인은 대개 랭킹이 아니라 사전(표제어 누락·한자 미수록)이고, 이것은 고쳐야 한다.
 * - **비용**: 목록에 있는데 몇 번째인가. 3번이면 숫자키 하나면 되고, 그건 실패가 아니라
 *   이 도구가 원래 하는 일이다. 10번을 넘어 쪽을 넘겨야 할 때 비용이 급증한다.
 *
 * 1번 적중률을 성적표처럼 읽으면 안 된다. 회귀를 보는 데는 쓰지만, 낮다고 나쁜 것이
 * 아니다.
 *
 * ## 문맥이 없는 것은 한계이지 결함이 아니다
 *
 * 문장 첫머리에서는 앞 문맥이 없어 연어 규칙이 걸릴 자리가 없다. 그 사례를 섞어 재면
 * "고칠 수 없는 것" 때문에 숫자가 낮아 보이고, 고칠 수 있는 곳을 가린다. 그래서 앞
 * 문맥의 유무로 갈라 집계한다.
 *
 * ## 이력을 비우고 잰다
 *
 * 사용 이력이 있으면 한 번 고른 후보에 2000점이 붙어 거의 다 맞는다. 그 숫자는
 * 아무것도 말해주지 않는다. 우리가 알고 싶은 것은 **처음 치는 단어**를 다룰 때의
 * 모습이므로 이력 없이 잰다.
 */

import type { JieumEngine } from '@jieum/core';
import type { EvalCase } from './golden.js';

/**
 * 사용자가 그 한자에 닿는 방법.
 *
 * 표제어를 통째로 못 찾아도 **쪼개 치면 되는 경우가 많다** — `최도명(崔道明)`은
 * `최(崔)` + `도명(道明)`으로 두 번에 넣을 수 있다. 그때 사용자에게는 길이 있으므로
 * 이 경우는 후보 누락이 아니라 입력 비용으로 센다.
 *
 * 이 구분을 넣기 전에는 못 찾음이 22.4%로 나왔는데, 그중 90.7%가 쪼개면 되는 것이라
 * 실질 결함은 6% 남짓이었다 (2026-08-04 실측). 지표가 고칠 수 없는 것과 고쳐야 할
 * 것을 섞어 보여주고 있었다.
 */
export type Reach =
  /** 그 표제어의 후보 목록에 있다 */
  | 'direct'
  /** 표제어로는 없지만 둘로 쪼개면 각 조각을 넣을 수 있다 */
  | 'split2'
  /** 한 글자씩이면 넣을 수 있다. 수고가 크지만 길은 있다 */
  | 'split-chars'
  /** 어떤 방법으로도 넣을 수 없다 — 진짜 결함 */
  | 'none';

/** 한 사례의 채점 결과 */
export interface Outcome {
  /** 0-based 순위. 못 찾으면 -1 */
  rank: number;
  /** 못 찾았을 때 다른 길이 있는가 */
  reach: Reach;
  /** 화면에 뜬 후보 수 */
  candidates: number;
  /** 그 표제어 그룹이 아예 없었는가 (사전에 표제어가 없다) */
  noHeadword: boolean;
  /**
   * **그 표제어 자체의** 후보 수 (접두 표제어 제외).
   *
   * 이 값이 1이면 고를 것이 없었다는 뜻이라 맞혀도 실력이 아니다. 그런 사례를 섞어
   * 집계하면 적중률이 실제보다 부풀려진다 — 진짜 물음은 **후보가 둘 이상일 때
   * 맞히는가**이고, 그것이 동음이의어 판별 능력이다.
   */
  headwordCandidates: number;
  /**
   * 앞 문맥의 길이.
   *
   * 0이면 문장 첫머리라 연어 규칙이 걸릴 자리가 없다 — **구조적 한계이지 결함이
   * 아니다.** 섞어 재면 고칠 수 없는 것 때문에 숫자가 낮아 보인다.
   */
  contextLength: number;
}

/**
 * 표제어별 후보 집합 캐시.
 *
 * 쪼개기 판정은 한 사례마다 조회를 여러 번 하므로 캐시가 없으면 채점이 몇 배로
 * 느려진다. 엔진마다 따로 두어 사전이 다른 두 엔진을 섞어 재도 안전하다.
 */
const candidateCache = new WeakMap<JieumEngine, Map<string, Set<string>>>();

/** 그 표제어를 쳤을 때 화면에 그 한자가 뜨는가 */
function isVisible(engine: JieumEngine, word: string, hanja: string): boolean {
  let cache = candidateCache.get(engine);
  if (!cache) {
    cache = new Map();
    candidateCache.set(engine, cache);
  }
  let set = cache.get(word);
  if (!set) {
    set = new Set<string>();
    // 접두 표제어의 후보는 이 표제어의 답이 될 수 없다 — `group.word`가 같은 것만.
    for (const group of engine.lookup(word)) {
      if (group.word !== word) continue;
      for (const c of group.candidates) set.add(c.hanja);
    }
    cache.set(word, set);
  }
  return set.has(hanja);
}

/**
 * 표제어로 못 찾았을 때 남은 길을 찾는다.
 *
 * 한자어는 대개 한 음절이 한 글자라 길이가 같다. 다르면 음차·약어 같은 것이라
 * 쪼개기가 성립하지 않는다.
 */
function findReach(engine: JieumEngine, word: string, hanja: string): Reach {
  if (word.length !== hanja.length) return 'none';

  for (let i = 1; i < word.length; i++) {
    if (
      isVisible(engine, word.slice(0, i), hanja.slice(0, i)) &&
      isVisible(engine, word.slice(i), hanja.slice(i))
    ) {
      return 'split2';
    }
  }

  for (let i = 0; i < word.length; i++) {
    if (!isVisible(engine, word[i]!, hanja[i]!)) return 'none';
  }
  return 'split-chars';
}

/**
 * @param useContext 앞 문맥을 넘길지. `false`로 한 번 더 재면 **연어 규칙이 실제로
 *   값을 내는지** 확인할 수 있다 — 두 숫자가 같으면 문맥이 안 쓰이고 있는 것이고,
 *   그건 채점이 틀렸거나 연어 사전이 안 붙은 것이다.
 */
export function scoreCase(engine: JieumEngine, item: EvalCase, useContext = true): Outcome {
  const groups = engine.lookup(item.input, (useContext && item.context) || undefined);

  // 사용자가 실제로 보는 목록 = 그룹을 순서대로 편 것. 그룹 순서는 엔진이 정한
  // 랭킹의 결론이므로 여기서 다시 정렬하지 않는다.
  let rank = -1;
  let index = 0;
  let headwordSeen = false;
  let headwordCandidates = 0;

  for (const group of groups) {
    if (group.word === item.input) {
      headwordSeen = true;
      headwordCandidates += group.candidates.length;
    }
    for (const candidate of group.candidates) {
      // 표제어가 다른 후보(더 짧은 접두어)는 이 사례의 답이 될 수 없다.
      // "세계"를 치는데 "세"의 후보를 맞혔다고 볼 수는 없다.
      if (group.word === item.input && candidate.hanja === item.expected && rank < 0) {
        rank = index;
      }
      index++;
    }
  }

  return {
    rank,
    // 목록에 있으면 쪼갤 일이 없다. 없을 때만 다른 길을 찾는다.
    reach: rank >= 0 ? 'direct' : findReach(engine, item.input, item.expected),
    candidates: index,
    noHeadword: !headwordSeen,
    headwordCandidates,
    contextLength: useContext ? item.context.length : 0,
  };
}

/** 표본 전체의 집계 */
export interface Summary {
  total: number;
  /** 1번 후보가 정답 — 아무것도 안 누르고 확정했을 때 맞을 확률 */
  top1: number;
  top3: number;
  top5: number;
  /** 한 쪽(9개) 안에 있는가 — 눈으로 훑어 찾을 수 있는 범위 */
  top9: number;
  /** 목록 어딘가에는 있는가 */
  found: number;
  /** 맞힌 사례의 평균 순위 (1-based). 나빠질 때 먼저 움직이는 조기 신호 */
  meanRankWhenFound: number;
  /** 못 찾은 이유 */
  missNoHeadword: number;
  missNotInDict: number;
  /** 후보 수 평균 — 갑자기 늘면 사전이나 필터가 바뀐 것이다 */
  meanCandidates: number;

  // --- 고를 것이 있었던 사례만 ---
  /** 그 표제어의 후보가 둘 이상이었던 사례 수 */
  ambiguous: number;
  /** 그중 1번 적중. **성적표가 아니라 회귀를 보는 척도다** */
  ambiguousTop1: number;
  ambiguousTop3: number;
  /** 후보가 하나뿐이라 고를 것이 없었던 비율 (참고용) */
  singleCandidate: number;

  // --- ⚠️ 결함: 도구가 실패한 것 ---
  /**
   * **어떤 방법으로도 넣을 수 없다.** 사용자에게 다른 길이 없으므로 도구가 실패한 것이다.
   *
   * 표제어로 못 찾은 것 전부가 아니라, 쪼개서도 안 되는 것만 센다.
   */
  unreachable: number;
  /** 표제어로는 못 찾았다 (쪼개면 되는 것을 포함). 참고용 — 결함이 아니다 */
  headwordMiss: number;

  // --- 비용: 찾는 데 드는 수고 ---
  /** 그냥 확정하면 됨 */
  costFree: number;
  /** 숫자키 하나 (2~9번) */
  costOneKey: number;
  /** 쪽을 넘겨야 함 (10번 이후) — 여기서 비용이 급증한다 */
  costPaging: number;
  /** 둘로 쪼개 쳐야 함. 수고는 크지만 길은 있다 */
  costSplit2: number;
  /** 한 글자씩 쳐야 함. 비용이 가장 크다 */
  costSplitChars: number;

  // --- 구조적 한계 분리 ---
  /** 앞 문맥이 없던 사례 (문장 첫머리) */
  noContext: number;
  /** 그중 1번 적중 */
  noContextTop1: number;
  /** 앞 문맥이 있던 사례의 1번 적중 */
  withContextTop1: number;
}

export function summarize(outcomes: Outcome[]): Summary {
  const total = outcomes.length;
  const hit = (n: number) => outcomes.filter((o) => o.rank >= 0 && o.rank < n).length;
  const found = outcomes.filter((o) => o.rank >= 0);
  const rankSum = found.reduce((sum, o) => sum + o.rank + 1, 0);
  const candidateSum = outcomes.reduce((sum, o) => sum + o.candidates, 0);

  const ratio = (n: number) => (total === 0 ? 0 : n / total);

  // 고를 것이 둘 이상 있었던 사례만 따로 — 부풀림 없는 진짜 지표
  const ambiguous = outcomes.filter((o) => o.headwordCandidates >= 2);
  const ambHit = (n: number) =>
    ambiguous.length === 0
      ? 0
      : ambiguous.filter((o) => o.rank >= 0 && o.rank < n).length / ambiguous.length;

  // 문맥 유무로 갈라 본다 — 문장 첫머리는 고칠 수 없는 자리다
  const blind = outcomes.filter((o) => o.contextLength === 0);
  const sighted = outcomes.filter((o) => o.contextLength > 0);
  const top1Of = (list: Outcome[]) =>
    list.length === 0 ? 0 : list.filter((o) => o.rank === 0).length / list.length;

  return {
    ambiguous: ambiguous.length,
    ambiguousTop1: ambHit(1),
    ambiguousTop3: ambHit(3),
    singleCandidate: ratio(outcomes.filter((o) => o.headwordCandidates === 1).length),

    unreachable: ratio(outcomes.filter((o) => o.reach === 'none').length),
    headwordMiss: ratio(outcomes.filter((o) => o.rank < 0).length),
    costFree: ratio(outcomes.filter((o) => o.rank === 0).length),
    costOneKey: ratio(outcomes.filter((o) => o.rank >= 1 && o.rank < 9).length),
    costPaging: ratio(outcomes.filter((o) => o.rank >= 9).length),
    costSplit2: ratio(outcomes.filter((o) => o.reach === 'split2').length),
    costSplitChars: ratio(outcomes.filter((o) => o.reach === 'split-chars').length),

    noContext: ratio(blind.length),
    noContextTop1: top1Of(blind),
    withContextTop1: top1Of(sighted),

    total,
    top1: ratio(hit(1)),
    top3: ratio(hit(3)),
    top5: ratio(hit(5)),
    top9: ratio(hit(9)),
    found: ratio(found.length),
    meanRankWhenFound: found.length === 0 ? 0 : rankSum / found.length,
    missNoHeadword: ratio(outcomes.filter((o) => o.rank < 0 && o.noHeadword).length),
    missNotInDict: ratio(outcomes.filter((o) => o.rank < 0 && !o.noHeadword).length),
    meanCandidates: total === 0 ? 0 : candidateSum / total,
  };
}

export function formatSummary(name: string, s: Summary): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return [
    `[${name}] 표본 ${s.total.toLocaleString()}건`,
    ``,
    `  ⚠ 넣을 수 없음 ${pct(s.unreachable)}  ← 고쳐야 할 것. 어떤 방법으로도 길이 없다`,
    ``,
    `  찾는 비용`,
    `      그냥 확정 (1번)       ${pct(s.costFree)}`,
    `      숫자키 하나 (2~9번)   ${pct(s.costOneKey)}`,
    `      쪽 넘김 (10번~)       ${pct(s.costPaging)}`,
    `      둘로 쪼개 치기        ${pct(s.costSplit2)}`,
    `      한 글자씩 치기        ${pct(s.costSplitChars)}`,
    `      찾았을 때 평균 순위    ${s.meanRankWhenFound.toFixed(2)}`,
    ``,
    `  참고: 표제어 통째로 못 찾음 ${pct(s.headwordMiss)}` +
      ` (표제어 없음 ${pct(s.missNoHeadword)} · 한자 없음 ${pct(s.missNotInDict)})`,
    ``,
    `  앞 문맥 유무 (문장 첫머리는 구조적으로 문맥이 없다)`,
    `      문맥 없음 ${pct(s.noContext)} → 1번 ${pct(s.noContextTop1)}`,
    `      문맥 있음          → 1번 ${pct(s.withContextTop1)}`,
    ``,
    `  회귀 척도: 고를 것이 둘 이상이던 ${s.ambiguous.toLocaleString()}건 중 1번 ${pct(
      s.ambiguousTop1,
    )} · 상위 3 ${pct(s.ambiguousTop3)}`,
    `  화면에 뜨는 후보 수 평균 ${s.meanCandidates.toFixed(1)}`,
  ].join('\n');
}
