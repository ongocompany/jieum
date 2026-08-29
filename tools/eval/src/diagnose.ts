/**
 * 진단 — 채점 숫자 뒤에서 실제로 무슨 일이 일어나는지 본다.
 *
 * 적중률만 보면 "왜 그런지"를 모른다. 특히 **앞 문맥이 값을 내고 있는지**는 적중률
 * 차이로만 보면 0.2%p 같은 작은 수라 원인을 짚을 수 없다 — 문맥이 안 걸리는 것인지,
 * 걸리는데 순위를 못 바꾸는 것인지, 애초에 문맥이 비어 있는 것인지 갈라야 한다.
 *
 * ```
 * pnpm --filter @jieum/eval diagnose
 * ```
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { JieumEngine, loadSnapshotFromFiles } from '@jieum/core';

import { loadSample } from './golden.js';

const LIMIT = 3000;

function goldenDir(): string {
  return (
    process.env['JIEUM_GOLDEN_DIR'] ??
    join(homedir(), 'development', 'hanjahanja', 'data', 'eval', 'wsd-golden-v1')
  );
}

function dictDir(): string {
  const candidates = [
    process.env['JIEUM_DICT_DIR'],
    join(process.cwd(), 'data', 'build'),
    join(process.cwd(), '..', '..', 'data', 'build'),
  ].filter((c): c is string => Boolean(c));
  for (const dir of candidates) {
    if (existsSync(join(resolve(dir), 'jieum-dict.json'))) return resolve(dir);
    if (existsSync(join(resolve(dir), 'jieum-dict.dat'))) return resolve(dir);
  }
  throw new Error('사전을 찾지 못했다');
}

async function main() {
  const snapshot = await loadSnapshotFromFiles(dictDir());
  const engine = new JieumEngine(snapshot);
  const cases = await loadSample(join(goldenDir(), 'high-frequency-homonym.jsonl'), LIMIT);

  let emptyContext = 0;
  let contextLenSum = 0;
  let collocationHit = 0;
  /** 연어가 걸렸고, 그 덕에 1번이 바뀐 사례 */
  let collocationFlipped = 0;
  /** 연어가 걸렸는데 1번이 그대로인 사례 */
  let collocationNoEffect = 0;

  for (const item of cases) {
    if (!item.context) emptyContext++;
    contextLenSum += item.context.length;

    const withContext = engine.lookup(item.input, item.context || undefined);
    const blind = engine.lookup(item.input, undefined);

    const hit = withContext.some((g) =>
      g.candidates.some((c) => (c.collocation ?? 0) > 0),
    );
    if (!hit) continue;
    collocationHit++;

    const topWith = withContext[0]?.candidates[0]?.hanja;
    const topBlind = blind[0]?.candidates[0]?.hanja;
    if (topWith !== topBlind) collocationFlipped++;
    else collocationNoEffect++;
  }

  const pct = (n: number) => `${((n / cases.length) * 100).toFixed(1)}%`;

  console.log(`표본 ${cases.length.toLocaleString()}건 (고빈도 동음이의어)\n`);
  console.log(`앞 문맥이 아예 빈 사례   ${pct(emptyContext)}  ← 문장 첫 어절`);
  console.log(`앞 문맥 평균 길이        ${(contextLenSum / cases.length).toFixed(1)}자`);
  console.log(`연어 규칙이 걸린 사례    ${pct(collocationHit)}`);
  console.log(`  그중 1번이 바뀐 것     ${collocationFlipped}건`);
  console.log(`  그중 1번이 그대로      ${collocationNoEffect}건`);
  console.log(
    `\n연어 사전 적재: ${
      snapshot.collocation ? `${snapshot.collocation.size.toLocaleString()}개 표제어` : '없음'
    }`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
