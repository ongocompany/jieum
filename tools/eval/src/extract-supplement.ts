/**
 * 사전 보강 후보 추출 — 골든셋의 (표제어, 한자) 쌍을 문턱으로 걸러 낸다.
 *
 * ```
 * pnpm --filter @jieum/eval extract-supplement
 * ```
 *
 * ## 사전 상태를 보지 않는다 (멱등)
 *
 * 무엇을 뽑을지는 **골든셋만 보고** 정한다. "이미 사전에 있으니 빼자"로 만들면
 * 재실행이 파괴적이 된다 — 보강한 뒤 다시 돌리면 자기가 넣은 것이 '이미 있음'으로
 * 빠져 목록이 비고, 그 빈 목록으로 빌드하면 보강이 통째로 사라진다. 새 표제어에서는
 * 더 치명적이라 표제어가 통째로 없어진다 (2026-08-04에 실제로 겪었다).
 *
 * 무엇이 이미 있는지는 `build.ts`가 판단하며 거기서 중복을 거른다. 사전은 여기서
 * 통계에만 쓴다.
 *
 * ## 두 갈래가 한 파일에 담긴다
 *
 * - **한자만 없음** (표제어는 사전에 있다): 후보 하나가 느는 것이라 위험이 낮다.
 *   오변환이 생기는 게 아니라 선택지가 는다. 문턱은 등장 횟수.
 * - **표제어 자체가 없음**: 새 표제어가 생기므로 더 강한 근거가 필요하다.
 *   **서로 다른 문헌 몇 개에 나오는가**로 통용 여부를 재고, 5자를 넘는 것은
 *   표제어가 아니라 한문 구절이므로(`유세차감소고우(維歲次敢昭告于)`) 자른다.
 *
 * 어느 갈래인지는 `build.ts`가 사전을 보고 정하므로 여기서는 나누지 않는다.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';

import { toCase, type GoldenRow } from './golden.js';

interface ImeEntry {
  h: string;
  f: number;
  l: number;
  a?: boolean;
}

/** 보강 후보 한 건 */
interface Supplement {
  /** 한글 표제어 */
  word: string;
  /** 붙일 한자 */
  hanja: string;
  /** 골든셋에서 몇 번 나왔는가 */
  count: number;
  /** 서로 다른 **페이지** 몇 곳에서 나왔는가 */
  sources: number;
  /** 서로 다른 **문헌** 몇 개에서 나왔는가 (실록의 여러 해는 한 문헌으로 센다) */
  works: number;
  /** 그 표제어가 이미 가진 후보 수 — 10개 제한에 걸리는지 보려는 것 */
  existing: number;
}

function parseArgs(argv: string[]) {
  let minCount = 2;
  let minSources = 1;
  let minWorks = 2;
  let maxWordLength = 4;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--min-count') minCount = Number(argv[++i]);
    else if (arg === '--min-sources') minSources = Number(argv[++i]);
    else if (arg === '--min-works') minWorks = Number(argv[++i]);
    else if (arg === '--max-length') maxWordLength = Number(argv[++i]);
    else if (arg === '--help') {
      console.log(
        '사용: extract-supplement [--min-count N] [--min-sources N] [--min-works N] [--max-length N]',
      );
      process.exit(0);
    }
  }
  return { minCount, minSources, minWorks, maxWordLength };
}

/**
 * 골든셋의 `source`는 **페이지 경로**다 (`조선왕조실록/정종대왕실록/2년`).
 * 최상위가 진짜 문헌이다 — 실록은 해마다 쪼개져 있어 페이지로 세면 "여러 문헌에
 * 나온다"가 부풀려진다. 신뢰의 대리 지표로 쓰려면 이쪽이어야 한다.
 */
function workOf(source: string | undefined): string {
  return (source ?? '').split('/')[0] ?? '';
}

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

async function main() {
  const { minCount, minSources, minWorks, maxWordLength } = parseArgs(process.argv.slice(2));
  const root = repoRoot();

  const dictPath = join(root, 'data', 'build', 'jieum-dict.json');
  if (!existsSync(dictPath)) {
    throw new Error(`사전이 없다: ${dictPath}\npnpm build:dict 를 먼저 돌릴 것`);
  }
  const goldenPath = join(root, 'data', 'eval', 'golden-wikisource.jsonl');
  if (!existsSync(goldenPath)) {
    throw new Error(
      `골든셋이 없다: ${goldenPath}\n` +
        `pnpm --filter @jieum/eval build-golden 으로 만들 것 (커밋되지 않는 산출물)`,
    );
  }

  console.log(`사전:   ${dictPath}`);
  console.log(`골든셋: ${goldenPath}\n`);

  // 사전은 **참고용으로만** 읽는다 (아래 통계). 무엇을 뽑을지는 사전 상태와 무관하게
  // 골든셋만 보고 정한다 — 이유는 `main` 위 주석의 '멱등' 절.
  const dict = JSON.parse(readFileSync(dictPath, 'utf-8')) as Record<string, ImeEntry[]>;
  console.log(`표제어 ${Object.keys(dict).length.toLocaleString()}개 적재 (통계용)\n`);

  // (표제어, 한자) 쌍마다 등장 횟수와 출처를 센다. 출처는 개수만 필요하므로
  // 문서 이름 자체는 Set에 담았다가 크기만 남긴다.
  const seen = new Map<string, { count: number; sources: Set<string>; works: Set<string> }>();
  let rows = 0;
  let usable = 0;

  const rl = createInterface({
    input: createReadStream(goldenPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    rows++;
    let row: GoldenRow & { source?: string };
    try {
      row = JSON.parse(line) as GoldenRow & { source?: string };
    } catch {
      continue;
    }
    // 채점과 **같은 유효성 기준**을 쓴다. 여기서만 느슨하게 받으면 채점에 안 잡히는
    // 항목을 넣게 되고, 넣어도 지표가 안 움직여 원인을 못 찾는다.
    const c = toCase(row);
    if (!c) continue;
    usable++;

    const key = `${c.input}\t${c.expected}`;
    const hit = seen.get(key);
    if (hit) {
      hit.count++;
      hit.sources.add(row.source ?? '');
      hit.works.add(workOf(row.source));
    } else {
      seen.set(key, {
        count: 1,
        sources: new Set([row.source ?? '']),
        works: new Set([workOf(row.source)]),
      });
    }
  }

  console.log(`골든셋 ${rows.toLocaleString()}줄 → 유효 ${usable.toLocaleString()}건`);
  console.log(`서로 다른 (표제어, 한자) 쌍 ${seen.size.toLocaleString()}개\n`);

  const supplements: Supplement[] = [];
  let alreadyHave = 0;
  let noHeadword = 0;
  const noHeadwordWords = new Set<string>();

  // 두 목록 모두 **골든셋의 모든 쌍**에서 문턱만으로 뽑는다. 사전 상태는 통계에만
  // 쓴다 — 무엇이 이미 있는지는 build.ts가 판단하며 거기서 중복을 거른다.
  for (const [key, stat] of seen) {
    const [word, hanja] = key.split('\t') as [string, string];
    const entries = dict[word];

    if (!entries) {
      noHeadword++;
      noHeadwordWords.add(word);
    } else if (entries.some((e) => e.h === hanja)) {
      alreadyHave++;
    }

    const item: Supplement = {
      word,
      hanja,
      count: stat.count,
      sources: stat.sources.size,
      works: stat.works.size,
      existing: entries?.length ?? 0,
    };
    supplements.push(item);
  }

  console.log('갈래별:');
  console.log(`  이미 사전에 있음     ${alreadyHave.toLocaleString()}쌍`);
  console.log(
    `  표제어 자체가 없음   ${noHeadword.toLocaleString()}쌍 ` +
      `(표제어 ${noHeadwordWords.size.toLocaleString()}개)`,
  );
  console.log(`  한자만 없음          ${supplements.length.toLocaleString()}쌍\n`);

  // 표제어 자체가 없는 것의 문헌 수 분포.
  // 한 문헌에만 나오면 그 저자의 표기일 뿐일 수 있고, 여러 문헌에 반복되면 통용된
  // 표기다. 2026-08-04 실측으로 **95.1%가 한 문헌**이었다.
  const worksDist = new Map<number, number>();
  for (const s of supplements) {
    if (s.existing > 0) continue;
    const bucket = s.works >= 5 ? 5 : s.works;
    worksDist.set(bucket, (worksDist.get(bucket) ?? 0) + 1);
  }
  console.log('표제어가 없는 쌍의 문헌 수 분포:');
  for (const n of [...worksDist.keys()].sort((a, b) => a - b)) {
    const label = n >= 5 ? '5개+' : `${n}개`;
    const c = worksDist.get(n)!;
    console.log(
      `  ${label.padStart(5)} ${c.toLocaleString().padStart(7)}  ${((c / noHeadword) * 100).toFixed(1)}%`,
    );
  }

  const outDir = join(root, 'data', 'source');
  mkdirSync(outDir, { recursive: true });

  // 두 갈래를 한 파일에 담는다. 같은 데이터의 다른 문턱일 뿐이라 파일을 나누면
  // 같은 내용이 두 번 커밋된다. 어느 갈래인지는 build.ts가 사전을 보고 정한다.
  const kept = supplements
    .filter(
      (s) =>
        (s.count >= minCount && s.sources >= minSources) ||
        (s.works >= minWorks && s.word.length <= maxWordLength),
    )
    .sort((a, b) => b.count - a.count || b.works - a.works);

  console.log(`\n── 파일에 담을 것 ──`);
  console.log(
    `  등장 ${minCount}회 이상  또는  문헌 ${minWorks}개 이상 & ${maxWordLength}자 이하: ` +
      `${kept.length.toLocaleString()}쌍`,
  );

  const forHeadword = kept.filter((s) => s.works >= minWorks && s.word.length <= maxWordLength);
  const newOnes = forHeadword.filter((s) => s.existing === 0);
  console.log(
    `  그중 새 표제어가 될 것: ${newOnes.length.toLocaleString()}쌍 / ` +
      `표제어 ${new Set(newOnes.map((s) => s.word)).size.toLocaleString()}개`,
  );
  console.log('  새 표제어 상위 12개:');
  for (const s of newOnes.slice(0, 12)) {
    console.log(`    ${s.word}(${s.hanja}) — 문헌 ${s.works}개 · ${s.count}회`);
  }

  const outPath = join(outDir, 'wikisource-pairs.json');
  writeFileSync(
    outPath,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: 'kowikisource — 한자 병기 어절에서 추출',
      method:
        `골든셋의 (표제어, 한자) 쌍 중 '등장 ${minCount}회 이상' 또는 ` +
        `'서로 다른 문헌 ${minWorks}개 이상 & 표제어 ${maxWordLength}자 이하'인 것. ` +
        `문헌은 source 경로의 최상위로 센다(실록의 여러 해는 한 문헌). ` +
        `사전 상태는 보지 않는다 — 중복과 갈래는 build.ts가 판단한다.`,
      thresholds: { minCount, minSources, minWorks, maxWordLength },
      total: kept.length,
      entries: kept,
    }),
  );
  console.log(`\n기록: ${outPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
