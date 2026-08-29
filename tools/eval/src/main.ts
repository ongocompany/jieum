/**
 * 제안 품질 채점 — 골든셋으로 "맞는 한자를 위에 올리는가"를 잰다.
 *
 * ```
 * pnpm eval:suggestions                    # 기본 표본으로 채점
 * pnpm eval:suggestions --limit 50000      # 표본 크기
 * pnpm eval:suggestions --save             # 결과를 이력에 남긴다
 * ```
 *
 * 골든셋은 한자한자 repo의 것을 **읽기만** 한다 (복사하지 않는다). 위치는
 * `JIEUM_GOLDEN_DIR`로 바꿀 수 있다.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { JieumEngine, loadSnapshotFromFiles } from '@jieum/core';

import { loadSample, type EvalCase } from './golden.js';
import { formatSummary, scoreCase, summarize, type Outcome, type Summary } from './score.js';

/**
 * 골든셋 갈래.
 *
 * 앞의 셋은 현대 뉴스 말뭉치이고, 마지막 갈래는 고전·역사 문서에서 추출했다.
 * 서로 다른 문체와 어휘를 함께 평가하기 위한 구성이다.
 */
const SETS = [
  {
    name: '고빈도 동음이의어',
    file: 'high-frequency-homonym.jsonl',
    /** 지음이 가장 잘해야 하는 곳. 같은 소리에 여러 한자가 붙는 자리다 */
    from: 'hanjahanja',
  },
  { name: '뉴스 무작위', file: 'news-random.jsonl', from: 'hanjahanja' },
  {
    name: '고유명사',
    file: 'proper-noun.jsonl',
    /** 인명·지명. 지음의 주 목적은 아니지만 인명용 그룹이 있어 함께 본다 */
    from: 'hanjahanja',
  },
  {
    name: '고전·역사 (위키문헌)',
    file: 'golden-wikisource.jsonl',
    /** 고전·역사 어휘 표본 */
    from: 'local',
  },
] as const;

interface Report {
  at: string;
  dictFingerprint: string;
  limit: number;
  sets: Record<string, Summary>;
  /** 진단용 실패 표본 — 무엇이 왜 틀렸는지 눈으로 보려는 것 */
  misses: Record<string, { input: string; expected: string; context: string; reason: string }[]>;
}

function parseArgs(argv: string[]) {
  let limit = 20_000;
  let save = false;
  let dictDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') limit = Number(argv[++i]);
    else if (arg === '--save') save = true;
    else if (arg === '--dict') dictDir = argv[++i];
    else if (arg === '--help') {
      console.log('사용: eval [--limit N] [--save] [--dict <경로>]');
      process.exit(0);
    }
  }
  return { limit, save, dictDir };
}

/** repo 루트 — `pnpm-workspace.yaml`이 있는 곳 */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

function goldenDir(): string {
  const fromEnv = process.env['JIEUM_GOLDEN_DIR'];
  if (fromEnv) return resolve(fromEnv);
  return join(homedir(), 'development', 'hanjahanja', 'data', 'eval', 'wsd-golden-v1');
}

function resolveDictDir(explicit?: string): string {
  const candidates = [
    explicit,
    process.env['JIEUM_DICT_DIR'],
    join(process.cwd(), 'data', 'build'),
    join(process.cwd(), '..', '..', 'data', 'build'),
  ].filter((c): c is string => Boolean(c));

  for (const dir of candidates) {
    const resolved = resolve(dir);
    if (existsSync(join(resolved, 'jieum-dict.dat'))) return resolved;
    if (existsSync(join(resolved, 'jieum-dict.json'))) return resolved;
  }
  throw new Error(`사전을 찾지 못했다. --dict 로 지정하거나 pnpm build:dict 를 먼저 돌릴 것`);
}

async function main() {
  const { limit, save, dictDir } = parseArgs(process.argv.slice(2));

  const dir = resolveDictDir(dictDir);
  console.log(`사전: ${dir}`);
  const snapshot = await loadSnapshotFromFiles(dir);

  // ⚠️ 이력(MRU)을 주지 않는다. 이력이 있으면 한 번 고른 후보에 2000점이 붙어
  // 거의 다 맞고, 그 숫자는 아무것도 말해주지 않는다. 여기서 재는 것은
  // **처음 치는 단어를 얼마나 맞히는가**다.
  const engine = new JieumEngine(snapshot);

  const golden = goldenDir();
  if (!existsSync(golden)) {
    throw new Error(`골든셋을 찾지 못했다: ${golden}\nJIEUM_GOLDEN_DIR 로 지정할 것`);
  }
  console.log(`골든셋: ${golden}`);
  console.log(`표본: 갈래마다 최대 ${limit.toLocaleString()}건 (이력 없음 = 첫 노출 기준)\n`);

  const report: Report = {
    at: new Date().toISOString(),
    dictFingerprint: fingerprintOf(dir),
    limit,
    sets: {},
    misses: {},
  };

  for (const set of SETS) {
    // 한자한자에서 온 것은 그쪽 repo에서 읽고, 우리가 뽑은 것은 이 repo 안에 있다.
    const path =
      set.from === 'local' ? join(repoRoot(), 'data', 'eval', set.file) : join(golden, set.file);
    if (!existsSync(path)) {
      console.log(`[${set.name}] 파일 없음 — 건너뜀`);
      continue;
    }

    const started = Date.now();
    const cases = await loadSample(path, limit);
    const outcomes: Outcome[] = cases.map((c) => scoreCase(engine, c));
    const summary = summarize(outcomes);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    report.sets[set.name] = summary;
    report.misses[set.name] = collectMisses(cases, outcomes, 15);

    console.log(formatSummary(set.name, summary));

    // 앞 문맥을 빼고 한 번 더 잰다. 두 숫자가 같으면 연어 규칙이 값을 못 내고
    // 있는 것이고, 그 자체가 잡아야 할 결함이다.
    const blind = summarize(cases.map((c) => scoreCase(engine, c, false)));
    const gain = (summary.ambiguousTop1 - blind.ambiguousTop1) * 100;
    console.log(
      `  앞 문맥 기여: ${gain >= 0 ? '+' : ''}${gain.toFixed(2)}%p ` +
        `(문맥 없이 재면 ${(blind.ambiguousTop1 * 100).toFixed(1)}%)`,
    );
    report.sets[`${set.name} (문맥 없음)`] = blind;

    console.log(`  (${elapsed}초)\n`);
  }

  if (save) {
    // repo 루트에 남긴다. `pnpm --filter`로 부르면 cwd가 패키지 폴더라
    // 그대로 쓰면 결과가 tools/eval 아래로 흩어진다.
    const outDir = join(repoRoot(), 'data', 'eval');
    mkdirSync(outDir, { recursive: true });
    const stamp = report.at.replace(/[:.]/g, '-');
    writeFileSync(join(outDir, `suggestion-${stamp}.json`), JSON.stringify(report, null, 2));
    writeFileSync(join(outDir, 'suggestion-latest.json'), JSON.stringify(report, null, 2));
    console.log(`기록: data/eval/suggestion-latest.json`);
  }

  compareWithPrevious(report);
}

/** 사전 지문 — 어느 사전으로 잰 숫자인지 남겨야 비교가 성립한다 */
function fingerprintOf(dir: string): string {
  try {
    const meta = join(dir, 'jieum-dict-meta.json');
    if (existsSync(meta)) {
      const parsed = JSON.parse(readFileSync(meta, 'utf-8')) as { fingerprint?: string };
      if (parsed.fingerprint) return parsed.fingerprint;
    }
  } catch {
    // 지문이 없어도 채점은 성립한다
  }
  return 'unknown';
}

/**
 * 진단 표본.
 *
 * **넣을 수 없는 것을 먼저 담는다.** 그것이 고쳐야 할 것이고, 쪼개 치면 되는 사례가
 * 섞여 있으면 눈으로 훑을 때 진짜 결함이 묻힌다.
 */
function collectMisses(cases: EvalCase[], outcomes: Outcome[], count: number) {
  const misses: Report['misses'][string] = [];

  const describe = (o: Outcome) => {
    if (o.reach === 'none') return o.noHeadword ? '넣을 수 없음 (표제어 없음)' : '넣을 수 없음 (한자 미수록)';
    if (o.reach === 'split2') return '둘로 쪼개면 됨';
    if (o.reach === 'split-chars') return '한 글자씩이면 됨';
    return `${o.rank + 1}번째`;
  };

  const pick = (want: (o: Outcome) => boolean) => {
    for (let i = 0; i < cases.length && misses.length < count; i++) {
      const o = outcomes[i]!;
      if (o.rank === 0 || !want(o)) continue;
      misses.push({
        input: cases[i]!.input,
        expected: cases[i]!.expected,
        // 앞 문맥은 끝부분이 판정에 쓰이므로 그쪽을 남긴다
        context: cases[i]!.context.slice(-30),
        reason: describe(o),
      });
    }
  };

  pick((o) => o.reach === 'none');
  pick((o) => o.reach !== 'none');
  return misses;
}

/** 지난 기록이 있으면 무엇이 달라졌는지 보여 준다 */
function compareWithPrevious(report: Report) {
  const previous = join(repoRoot(), 'data', 'eval', 'suggestion-latest.json');
  if (!existsSync(previous)) return;
  try {
    const old = JSON.parse(readFileSync(previous, 'utf-8')) as Report;
    if (old.at === report.at) return;

    console.log(`\n지난 기록(${old.at.slice(0, 16)}) 대비:`);
    for (const [name, summary] of Object.entries(report.sets)) {
      const before = old.sets[name];
      if (!before) continue;
      const delta = (summary.top1 - before.top1) * 100;
      const mark = Math.abs(delta) < 0.05 ? '=' : delta > 0 ? '▲' : '▼';
      console.log(`  ${mark} ${name} 1번 적중 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%p`);
    }
  } catch {
    // 지난 기록이 깨져 있어도 이번 채점은 유효하다
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
