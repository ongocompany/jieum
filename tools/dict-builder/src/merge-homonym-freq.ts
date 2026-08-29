/**
 * 동음이의어 빈도 병합 (지음 v1 + 한자한자 v2)
 *
 * 지음이 쓰던 `homonym-freq.json`은 2026-04-01에 복사해온 한자한자 v1이다.
 * 한자한자는 2026-06-11에 실제 코퍼스 관측을 근거로 v2를 만들었고, 그 사이
 * 지음은 멈춰 있었다. v2 쪽이 맞는 자리가 분명히 있다 —
 * `고전`은 v1에서 `苦戰`(110)이 `古典`(100)을 눌렀는데, v2는 근거 147건으로
 * `古典`을 앞세운다.
 *
 * 그렇다고 v2로 교체하면 안 된다. 실측:
 *   - v1 1위 한자가 v2에 아예 없는 표제어 566건
 *     (`침식`: v1 `寢食` 100 ↔ v2 `浸蝕` 4건·`侵蝕` 1건)
 *   - 교집합 4,389건 중 근거 3건 미만이 942건
 *   - v2가 있는 표제어의 42%에 v1에만 있는 한자가 남아 있다 (2,531개)
 * 근거 1~2건짜리 관측만으로 기존 후보 순위를 뒤집기에는 표본이 부족하다.
 *
 * 그래서 **근거량에 따라 두 판을 연속적으로 섞는다**(베이지안 축소).
 * 근거가 없으면 v1 그대로, 쌓일수록 v2 쪽으로 옮겨간다.
 *
 * 도메인(news/spoken/messenger)은 **고르지 않고 균등 평균**한다. v2의 합산값을
 * 그대로 쓰면 표본이 큰 뉴스가 진실이 된다 — `검사`는 뉴스에서 檢事 425 >
 * 檢査 279지만 구어(65:34)와 메신저(30:4)에서는 檢査가 이긴다. 검찰 기사가
 * 많다는 사실이 "검사"의 일반적 의미를 바꾸지는 않는다.
 * 도메인마다 비율을 낸 뒤 평균하면 특정 도메인에 치우치지 않고 여러 자료에서
 * 일관된 신호만 남는다.
 *
 * 사용법:
 *   pnpm --filter @jieum/dict-builder merge-freq
 *   HANJAHANJA_DIR=/path/to/hanjahanja pnpm --filter @jieum/dict-builder merge-freq
 *
 * 출력: data/source/generated/homonym-freq-merged.json
 *   { "표제어": { "한자": 0..100 }, ... }   ← v1과 같은 형식이라 build.ts가 그대로 읽는다
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const HANJAHANJA_DIR =
  process.env['HANJAHANJA_DIR'] ?? join(homedir(), 'development/hanjahanja');
const V2_PATH = join(HANJAHANJA_DIR, 'data/wsd/homonym-freq-v2.json');
const ROOT = resolve(import.meta.dirname, '../../..');
const V1_PATH = join(ROOT, 'data/source/apps/mobile/assets/dict/homonym-freq.json');
const OUT_DIR = join(ROOT, 'data/source/generated');
const OUT_PATH = join(OUT_DIR, 'homonym-freq-merged.json');

/**
 * 축소 기준점 — "근거가 이만큼 쌓이면 v2를 절반 믿는다"
 *
 * 10건이면 w=0.5, 1건이면 0.09, 100건이면 0.91.
 * `침식`(관측 5건)은 w=0.33이라 v1의 `寢食`이 살아남고,
 * `고전`(147건)은 w=0.94라 v2의 `古典`이 이긴다.
 */
const SHRINK_K = 10;

/** 빈도 상한 — 바이너리 사전이 u8에 담고, 랭커의 2층 감점(1000)과 격차를 유지한다 */
const FREQ_MAX = 100;

/**
 * 도메인 하나가 평균에 참여하기 위한 최소 관측
 *
 * 균등 평균은 표본이 작은 도메인도 한 표를 주므로, 1~2건짜리 도메인이
 * 큰 도메인과 동등해지는 것을 막아야 한다. 미달인 도메인은 빠지고,
 * 전부 미달이면 합산값으로 물러난다.
 */
const MIN_DOMAIN_EVIDENCE = 3;

const DOMAINS = ['news', 'spoken', 'messenger'] as const;

type FreqMap = Record<string, number>;

interface SensePrior {
  hanja: string;
  count: number;
}

interface V2Record {
  sense_prior?: SensePrior[];
  domain_prior?: Partial<Record<(typeof DOMAINS)[number], SensePrior[]>>;
  confidence?: { evidence_count?: number };
}

/** 합이 1이 되도록 정규화 (전부 0이면 균등) */
function toDistribution(counts: FreqMap): FreqMap {
  const total = Object.values(counts).reduce((s, v) => s + v, 0);
  const keys = Object.keys(counts);
  if (total <= 0) {
    const even = keys.length > 0 ? 1 / keys.length : 0;
    return Object.fromEntries(keys.map((k) => [k, even]));
  }
  return Object.fromEntries(keys.map((k) => [k, counts[k]! / total]));
}

/**
 * v2를 한자 단위로 집계
 *
 * `sense_prior`는 의미(sense_id) 단위라 같은 한자가 여러 번 나온다
 * (`가` → 可가 sense 11·10 두 항목). 한자 단위로 합산해야 후보 비교가 된다.
 */
function aggregateV2(record: V2Record): FreqMap {
  return aggregateSenses(record.sense_prior);
}

function aggregateSenses(senses: SensePrior[] | undefined): FreqMap {
  const counts: FreqMap = {};
  for (const sense of senses ?? []) {
    if (!sense.hanja) continue;
    counts[sense.hanja] = (counts[sense.hanja] ?? 0) + (sense.count ?? 0);
  }
  return counts;
}

/**
 * v2를 도메인 균등 평균 분포로 만든다
 *
 * 표본이 큰 도메인이 결과를 독점하지 않도록 도메인마다 비율을 낸 뒤 평균한다.
 * 참여 도메인이 하나도 없으면 `undefined`를 돌려 합산값 경로로 물러난다.
 */
function macroDistribution(record: V2Record, hanjas: Set<string>): FreqMap | undefined {
  const perDomain: FreqMap[] = [];

  for (const domain of DOMAINS) {
    const counts = aggregateSenses(record.domain_prior?.[domain]);
    const total = Object.values(counts).reduce((s, v) => s + v, 0);
    if (total < MIN_DOMAIN_EVIDENCE) continue;
    perDomain.push(
      toDistribution(Object.fromEntries([...hanjas].map((h) => [h, counts[h] ?? 0]))),
    );
  }

  if (perDomain.length === 0) return undefined;

  const averaged: FreqMap = {};
  for (const h of hanjas) {
    averaged[h] =
      perDomain.reduce((sum, d) => sum + (d[h] ?? 0), 0) / perDomain.length;
  }
  return averaged;
}

/**
 * 한 표제어의 두 판을 섞는다
 *
 * v1·v2 각각을 확률분포로 만든 뒤 근거량으로 가중 평균하고,
 * 마지막에 1위가 100이 되도록 재스케일한다. 재스케일은 표제어 간 스케일을
 * 고정하면서 후보 사이의 격차 비율은 보존한다 — 격차 크기가 복합어 보너스(50)
 * 같은 다른 신호와 겨루는 데 쓰이기 때문이다.
 */
function blend(
  v1: FreqMap | undefined,
  v2Counts: FreqMap,
  evidence: number,
  v2Record?: V2Record,
): FreqMap {
  const hanjas = new Set([...Object.keys(v1 ?? {}), ...Object.keys(v2Counts)]);
  if (hanjas.size === 0) return {};

  // 양쪽 분포를 같은 후보 집합 위에 올린다 (없는 쪽은 0)
  const p1 = toDistribution(
    Object.fromEntries([...hanjas].map((h) => [h, v1?.[h] ?? 0])),
  );
  // 도메인 균등 평균이 우선. 도메인 표본이 부족하면 합산값으로 물러난다.
  const p2 =
    (v2Record && macroDistribution(v2Record, hanjas)) ??
    toDistribution(Object.fromEntries([...hanjas].map((h) => [h, v2Counts[h] ?? 0])));

  const hasV2 = Object.values(v2Counts).some((c) => c > 0);
  const w2 = hasV2 ? evidence / (evidence + SHRINK_K) : 0;

  const blended: FreqMap = {};
  for (const h of hanjas) {
    blended[h] = w2 * (p2[h] ?? 0) + (1 - w2) * (p1[h] ?? 0);
  }

  const peak = Math.max(...Object.values(blended));
  if (peak <= 0) return Object.fromEntries([...hanjas].map((h) => [h, 0]));

  const out: FreqMap = {};
  for (const h of hanjas) {
    // 어느 판에든 등장한 한자는 0으로 떨어뜨리지 않는다 —
    // 0은 "사전에 빈도 정보가 아예 없음"과 구분되지 않는다.
    out[h] = Math.max(1, Math.round((blended[h]! / peak) * FREQ_MAX));
  }
  return out;
}

function main(): void {
  if (!existsSync(V1_PATH)) {
    console.error(`[지음] v1 빈도를 찾을 수 없습니다: ${V1_PATH}`);
    process.exit(1);
  }

  const v1All = JSON.parse(readFileSync(V1_PATH, 'utf-8')) as Record<string, FreqMap>;
  console.log(`   v1 (지음, 2026-04 복사본): ${Object.keys(v1All).length.toLocaleString()}개 표제어`);

  let v2All: Record<string, V2Record> = {};
  if (existsSync(V2_PATH)) {
    v2All = JSON.parse(readFileSync(V2_PATH, 'utf-8')) as Record<string, V2Record>;
    console.log(`   v2 (한자한자, 2026-06): ${Object.keys(v2All).length.toLocaleString()}개 표제어`);
  } else {
    console.warn(`   ! v2 없음, v1 정규화만 수행: ${V2_PATH}`);
  }

  const merged: Record<string, FreqMap> = {};
  const stat = { v1Only: 0, both: 0, v2Only: 0, flipped: 0, rescued: 0 };

  for (const word of new Set([...Object.keys(v1All), ...Object.keys(v2All)])) {
    const v1 = v1All[word];
    const v2Record = v2All[word];
    const v2Counts = v2Record ? aggregateV2(v2Record) : {};
    const evidence =
      v2Record?.confidence?.evidence_count ??
      Object.values(v2Counts).reduce((s, v) => s + v, 0);

    const result = blend(v1, v2Counts, evidence, v2Record);
    if (Object.keys(result).length === 0) continue;
    merged[word] = result;

    if (v1 && v2Record) stat.both++;
    else if (v1) stat.v1Only++;
    else stat.v2Only++;

    if (v1 && v2Record) {
      const topOf = (m: FreqMap): string =>
        Object.keys(m).reduce((a, b) => ((m[b] ?? 0) > (m[a] ?? 0) ? b : a));
      const before = topOf(v1);
      const after = topOf(result);
      if (before !== after) stat.flipped++;
      // v1 1위가 v2에 없는데도 살아남았는가 (축소가 실제로 한 일)
      if (!(before in v2Counts) && after === before) stat.rescued++;
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(merged));

  console.log(`\n   병합: ${Object.keys(merged).length.toLocaleString()}개 표제어`);
  console.log(`     v1만 ${stat.v1Only.toLocaleString()} / 양쪽 ${stat.both.toLocaleString()} / v2만 ${stat.v2Only.toLocaleString()}`);
  console.log(`     v2 근거로 1위가 바뀐 표제어: ${stat.flipped.toLocaleString()}`);
  console.log(`     근거 부족으로 v1 1위를 지킨 표제어: ${stat.rescued.toLocaleString()}`);

  verify(merged, v1All, new Set(Object.keys(v2All)));
  console.log(`\n   → ${OUT_PATH}`);
}

/**
 * 병합 정책의 불변식 검증
 *
 * 산출물은 실행할 때마다 다시 만들어지므로 회귀 가드도 여기 둔다.
 * 하나라도 깨지면 빌드를 멈춘다 — 조용히 틀린 사전이 앱까지 가는 것보다 낫다.
 */
function verify(
  merged: Record<string, FreqMap>,
  v1All: Record<string, FreqMap>,
  touchedByV2: Set<string>,
): void {
  const failures: string[] = [];

  const check = (ok: boolean, label: string): void => {
    console.log(`     ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failures.push(label);
  };

  console.log('\n   불변식:');

  // 값 범위 — 랭커의 "빈도 0~100" 전제와 바이너리 u8을 동시에 지킨다
  let outOfRange = 0;
  let zeroed = 0;
  for (const m of Object.values(merged)) {
    for (const f of Object.values(m)) {
      if (!Number.isInteger(f) || f < 1 || f > FREQ_MAX) outOfRange++;
      if (f === 0) zeroed++;
    }
  }
  check(outOfRange === 0, `모든 값이 1~${FREQ_MAX} 정수 (벗어남 ${outOfRange})`);
  check(zeroed === 0, `등재된 한자가 0으로 떨어지지 않음 (0인 값 ${zeroed})`);

  // 근거가 없으면 v1 순서를 그대로 보존한다
  const v1OnlySample = Object.keys(v1All)
    .filter((w) => merged[w] && Object.keys(v1All[w]!).length > 1)
    .filter((w) => Object.keys(merged[w]!).length === Object.keys(v1All[w]!).length)
    .slice(0, 500);
  let orderBroken = 0;
  for (const w of v1OnlySample) {
    const order1 = Object.entries(v1All[w]!).sort((a, b) => b[1] - a[1]).map(([h]) => h);
    const orderM = Object.entries(merged[w]!).sort((a, b) => b[1] - a[1]).map(([h]) => h);
    // v2가 개입한 표제어는 순서가 바뀌는 것이 정상이므로 v1과 후보 집합이
    // 같은 자리만 본다. 그 자리에서 순서가 흔들리면 정규화 버그다.
    if (order1[0] !== orderM[0] && !touchedByV2.has(w)) orderBroken++;
  }
  check(orderBroken === 0, `v2가 손대지 않은 표제어의 1위 보존 (깨짐 ${orderBroken})`);

  // 알려진 기준 케이스 — 실측으로 확인한 자리들
  const expectTop: Array<[string, string, string]> = [
    ['고전', '古典', 'v1에서 苦戰이 앞섰던 것을 근거 147건이 교정'],
    ['경기', '競技', '근거 2,996건'],
    ['침식', '寢食', '근거 5건뿐이라 v1 1위를 지킨다'],
    ['교목', '喬木', '근거 1건짜리 校牧에 밀리지 않는다'],
    ['검사', '檢査', '뉴스만 檢事가 앞선다 — 도메인 균등 평균이 되돌린다'],
  ];
  for (const [word, hanja, why] of expectTop) {
    const m = merged[word];
    const top = m
      ? Object.keys(m).reduce((a, b) => ((m[b] ?? 0) > (m[a] ?? 0) ? b : a))
      : '(없음)';
    const line = m
      ? Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h, f]) => `${h}:${f}`).join(' ')
      : '(없음)';
    check(top === hanja, `${word} 1위 = ${hanja} — ${why}  [${line}]`);
  }

  if (failures.length > 0) {
    console.error(`\n[지음] 병합 불변식 ${failures.length}건 실패. 산출물을 신뢰할 수 없습니다.`);
    process.exit(1);
  }
}

main();
