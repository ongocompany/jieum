import type { ImeEntry, CompoundDict, Candidate } from './types.js';

/** 스코어링 가중치 */
const COMPOUND_BONUS = 50;
const BASE_FREQ_WEIGHT = 1;
/**
 * 2층(고어·전문어) 감점
 *
 * 빈도(0~100)와 복합어 보너스(50)를 합쳐도 넘지 못하는 크기로 둬서
 * 1층 후보가 하나라도 있으면 항상 그쪽이 앞선다. 감점이지 배제가 아니다 —
 * 후보 목록에는 언제나 남고, 1층이 없으면 그대로 1순위가 된다.
 */
const ARCHAIC_PENALTY = 1000;
/**
 * 한 번이라도 고른 후보에 주는 보너스
 *
 * 2층 감점(1000)보다 크다. 사용자가 고어·전문어 후보를 직접 고른 뒤에는
 * 일반 후보보다 앞에 올 수 있어야 한다.
 */
const MRU_BONUS = 2000;

/**
 * 사용자가 낱자를 이어 만든 조합의 기본 점수
 *
 * **MRU(2000)보다 크다.** 사전 후보를 한 번 고른 기록보다 사용자가 글자마다
 * 확인해 직접 만든 조합을 우선한다.
 */
export const USER_WORD_SCORE = 5000;
/**
 * 최근에 고른 순서에 주는 가산 (같은 표제어 안에서만 따진다)
 *
 * MRU의 주 신호는 최근성이다. 횟수만 보면 예전에 자주 쓰던 후보가 방금 고른
 * 후보를 계속 누른다. 직전 선택은 오래된 누적 횟수보다 현재 문서에서 사용할
 * 가능성이 높으므로 최근성을 더 강하게 반영한다.
 *
 * 순위 한 칸 차이(150)가 횟수 가산의 최대 폭(100)보다 크다. 그래서 가장
 * 최근에 고른 후보가 항상 앞선다.
 */
const MRU_RECENCY_BONUS = 500;
const MRU_RECENCY_STEP = 150;
/**
 * 사용량당 가산 — 최근성이 같을 때 자주 쓴 것을 위로
 *
 * 여기 들어오는 값은 날 횟수가 아니라 **흐려진 사용량**이다 (`MruStore`의 `dee`).
 * 그래서 "예전에 많이 쓰던 것"은 시간이 아니라 **그동안 친 양**에 따라 저절로 밀려난다.
 */
const MRU_COUNT_WEIGHT = 5;
/** 사용량 가산 상한 — 한 후보가 무한정 강해지지 않게 한다 */
const MRU_COUNT_CAP = 20;

/**
 * 앞 문맥이 이 한자를 가리킬 때 주는 보너스
 *
 * 세 신호 사이에 자리를 잡는다:
 * - 빈도(0~100)보다 **크다**. "선거" 뒤의 `시장`은 통계적으로 흔한 市場이
 *   아니라 市長이다. 문맥은 빈도보다 강한 증거다.
 * - 2층 감점(1000)보다 **작다**. 문맥이 맞아도 고어·전문어를 첫 줄로
 *   끌어올리지는 않는다.
 * - MRU(2000)보다 **작다**. 사용자가 실제로 고른 이력이 규칙보다 앞선다.
 *   규칙은 일반론이고 이력은 이 사람의 글이다.
 */
const COLLOCATION_BONUS = 300;
/** 문맥어가 여러 개 걸릴수록 확신이 커진다 — 상한을 둬 규칙 크기 편향을 막는다 */
const COLLOCATION_MATCH_WEIGHT = 10;
const COLLOCATION_MATCH_CAP = 5;

/**
 * 랭킹에 쓰는 사용 이력 조회 (core는 저장소를 알지 않는다)
 *
 * **다 흐려진 이력은 여기서 `undefined`로 나와야 한다.** 저장소가 잊음을 판정하고,
 * 랭커는 "있다/없다"만 본다. 그래야 잊힌 고어에 2층 감점이 제자리로 돌아온다.
 */
export interface MruLookup {
  get(
    word: string,
    hanja: string,
    context?: string,
  ): { count: number; at: number; strength: number } | undefined;
}

/**
 * 후보 순위 스코어링
 *
 * score = base_frequency * WEIGHT
 *       + (compound_match ? COMPOUND_BONUS : 0)
 *       - (archaic ? ARCHAIC_PENALTY : 0)
 *       + (used ? MRU_BONUS + min(strength, CAP) * COUNT_WEIGHT : 0)
 *       + (collocation_hit ? COLLOCATION_BONUS + min(hits, CAP) * MATCH_WEIGHT : 0)
 *
 * `collocationHits`는 한자 → 앞 문맥에서 걸린 문맥어 수. 문자열 매칭은
 * 엔진이 맡고 랭커는 점수만 매긴다 — 그래야 배분 규칙을 문맥 로직 없이
 * 시험할 수 있다.
 */
export function rankCandidates(
  word: string,
  entries: ImeEntry[],
  compound: CompoundDict,
  mru?: MruLookup,
  collocationHits?: Map<string, number>,
  mruContext?: string,
): Candidate[] {
  const compoundHanja = compound.get(word);

  // 이 표제어 안에서 "몇 번째로 최근에 고른 후보인가"를 매긴다.
  // 전역 순위가 아니라 표제어 안에서만 따지므로 후보 수만큼의 비용이다.
  const usedAtDesc: number[] = [];
  if (mru) {
    for (const entry of entries) {
      const record = mru.get(word, entry.h, mruContext);
      if (record) usedAtDesc.push(record.at);
    }
    usedAtDesc.sort((a, b) => b - a);
  }

  const candidates: Candidate[] = entries.map((entry) => {
    let score = entry.f * BASE_FREQ_WEIGHT;

    // 복합어 매칭 보너스
    if (compoundHanja && entry.h === compoundHanja) {
      score += COMPOUND_BONUS;
    }

    // 사용 이력 — 사전 빈도가 없는 자리를 사용자 자신의 선택으로 메운다
    const used = mru?.get(word, entry.h, mruContext);

    // 2층 감점 — 단, 고른 적 있으면 붙이지 않는다.
    //
    // 사용자가 한 번 골랐다는 것은 그 후보가 이 사용자에게 유효하다는 뜻이다.
    // 그 시점부터 고어·전문어로 낮춰 볼 이유가 없다. 감점을 남긴 채 보너스만
    // 키우면 1층 후보도 같은 보너스를 받아 1000 차이가 그대로 남는다.
    if (entry.a && !used) {
      score -= ARCHAIC_PENALTY;
    }

    if (used) {
      const recencyRank = usedAtDesc.indexOf(used.at);
      score += MRU_BONUS
        + Math.max(0, MRU_RECENCY_BONUS - recencyRank * MRU_RECENCY_STEP)
        + Math.min(used.strength, MRU_COUNT_CAP) * MRU_COUNT_WEIGHT;
    }

    // 앞 문맥이 이 한자를 가리키면 밀어올린다
    const hits = collocationHits?.get(entry.h) ?? 0;
    if (hits > 0) {
      score += COLLOCATION_BONUS
        + Math.min(hits, COLLOCATION_MATCH_CAP) * COLLOCATION_MATCH_WEIGHT;
    }

    return {
      word,
      hanja: entry.h,
      score,
      used: used ? used.count : undefined,
      freq: entry.f,
      level: entry.l,
      meaning: entry.m,
      inmyeong: entry.n,
      archaic: entry.a,
      collocation: hits > 0 ? hits : undefined,
      source: compoundHanja === entry.h
        ? 'compound' as const
        : hits > 0
          ? 'collocation' as const
          : 'dictionary' as const,
    };
  });

  // 스코어 내림차순 정렬
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}
