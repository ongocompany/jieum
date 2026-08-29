/**
 * 독음표(hanja-readings.json) 생성
 *
 * `reading-check.ts`가 판정에 쓰는 "한자 → 가능한 독음들" 조회 테이블을
 * 두 출처에서 만든다:
 *
 *   - Unihan `kHangul` — 8,525자. `Unihan_Readings.txt`에서 `\tkHangul\t`
 *     줄만 골라 `:출처` 접미사를 뗀다. 예: `U+349A\tkHangul\t온:N 은:N` → 온·은.
 *   - `data/source/single-hanja.json` — 5,978자 (배정한자). `byReading`·
 *     `byCharacter` 양쪽에서 문자→독음 쌍을 모은다(현재 데이터는 1:1이지만
 *     장차 한 출처만 다음향을 실어도 놓치지 않도록 양쪽 다 본다).
 *
 * 합집합 8,976자. 결과는 **커밋한다** — `pnpm build:dict`가 매번 Unihan.zip을
 * 요구하지 않도록. 재생성은 이 스크립트를 수동으로 돌리는, 드문 일이다.
 *
 * 사용법:
 *   pnpm --filter @jieum/dict-builder build-readings
 *   pnpm --filter @jieum/dict-builder build-readings -- --unihan /path/to/Unihan.zip
 *
 * 출력: data/source/hanja-readings.json
 *   { "金": ["금", "김"], ... } (독음은 정렬됨)
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_UNIHAN_PATH = join(homedir(), 'development/hanjadict/pipeline/cache/Unihan.zip');
const SOURCE_DIR = resolve(import.meta.dirname, '../../../data/source');
const SINGLE_HANJA_PATH = join(SOURCE_DIR, 'single-hanja.json');
const OUT_PATH = join(SOURCE_DIR, 'hanja-readings.json');
const BUILD_DICT_PATH = resolve(import.meta.dirname, '../../../data/build/jieum-dict.json');

interface SingleHanjaEntry {
  character: string;
  reading: string;
}

interface SingleHanjaData {
  byReading: Record<string, SingleHanjaEntry[]>;
  byCharacter: Record<string, SingleHanjaEntry>;
}

function parseArgs(argv: string[]): { unihan: string } {
  let unihan = DEFAULT_UNIHAN_PATH;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--unihan' && argv[i + 1]) {
      unihan = argv[i + 1]!;
      i++;
    }
  }
  return { unihan };
}

/** Unihan_Readings.txt의 kHangul 줄에서 문자 → 독음 집합을 뽑는다 */
function extractUnihanHangul(unihanZipPath: string): Map<string, Set<string>> {
  const text = execFileSync('unzip', ['-p', unihanZipPath, 'Unihan_Readings.txt'], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const chars = new Map<string, Set<string>>();
  for (const line of text.split('\n')) {
    if (!line.includes('\tkHangul\t')) continue;
    const [cp, , value] = line.split('\t');
    if (!cp || !value) continue;

    const char = String.fromCodePoint(parseInt(cp.slice(2), 16));
    const readings = value
      .trim()
      .split(/\s+/)
      .map((tok) => tok.split(':')[0]!)
      .filter((r) => r.length > 0);

    const set = chars.get(char) ?? new Set<string>();
    for (const r of readings) set.add(r);
    chars.set(char, set);
  }
  return chars;
}

/** single-hanja.json의 byReading·byCharacter 양쪽에서 문자 → 독음 집합을 뽑는다 */
function extractSingleHanja(path: string): Map<string, Set<string>> {
  const data = JSON.parse(readFileSync(path, 'utf-8')) as SingleHanjaData;
  const chars = new Map<string, Set<string>>();

  const add = (char: string, reading: string) => {
    const set = chars.get(char) ?? new Set<string>();
    set.add(reading);
    chars.set(char, set);
  };

  for (const [reading, entries] of Object.entries(data.byReading)) {
    for (const entry of entries) add(entry.character, reading);
  }
  for (const [char, entry] of Object.entries(data.byCharacter)) {
    add(char, entry.reading);
  }
  return chars;
}

function main(): void {
  const { unihan } = parseArgs(process.argv.slice(2));

  console.log('[build-readings] 독음표 생성 시작\n');

  if (!existsSync(unihan)) {
    console.error(`[build-readings] Unihan.zip을 찾을 수 없습니다: ${unihan}`);
    console.error('   --unihan <path>로 위치를 지정할 수 있습니다.');
    process.exit(1);
  }
  if (!existsSync(SINGLE_HANJA_PATH)) {
    console.error(`[build-readings] single-hanja.json을 찾을 수 없습니다: ${SINGLE_HANJA_PATH}`);
    process.exit(1);
  }

  console.log(`1. Unihan kHangul 추출... (${unihan})`);
  const unihanChars = extractUnihanHangul(unihan);
  console.log(`   → ${unihanChars.size.toLocaleString()}자\n`);

  console.log('2. single-hanja.json 추출...');
  const singleChars = extractSingleHanja(SINGLE_HANJA_PATH);
  console.log(`   → ${singleChars.size.toLocaleString()}자\n`);

  console.log('3. 합집합...');
  const merged = new Map<string, Set<string>>();
  for (const [char, readings] of unihanChars) {
    merged.set(char, new Set(readings));
  }
  for (const [char, readings] of singleChars) {
    const set = merged.get(char) ?? new Set<string>();
    for (const r of readings) set.add(r);
    merged.set(char, set);
  }
  console.log(`   → ${merged.size.toLocaleString()}자 (Unihan ∪ single-hanja)\n`);

  // 코드포인트 순 정렬 — 재생성할 때마다 같은 순서가 나와야 diff가 의미를 가진다
  const out: Record<string, string[]> = {};
  for (const [char, readings] of [...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    out[char] = [...readings].sort();
  }

  writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`4. 저장 완료 → ${OUT_PATH}\n`);

  // 5. 빌드된 사전 대비 커버리지 (있으면)
  if (existsSync(BUILD_DICT_PATH)) {
    console.log('5. 빌드된 사전 대비 커버리지...');
    const dict = JSON.parse(readFileSync(BUILD_DICT_PATH, 'utf-8')) as Record<
      string,
      Array<{ h: string }>
    >;

    const coverage = (chars: Map<string, Set<string>>) => {
      let total = 0;
      let undecidable = 0;
      for (const entries of Object.values(dict)) {
        for (const entry of entries) {
          total++;
          if (Array.from(entry.h).some((c) => !chars.has(c))) undecidable++;
        }
      }
      return { total, undecidable };
    };

    const withSingleOnly = coverage(singleChars);
    const withMerged = coverage(merged);

    console.log(
      `   배정한자만 (${singleChars.size.toLocaleString()}자): 판정 보류 ` +
        `${withSingleOnly.undecidable.toLocaleString()} / ${withSingleOnly.total.toLocaleString()} ` +
        `(${((withSingleOnly.undecidable / withSingleOnly.total) * 100).toFixed(1)}%)`,
    );
    console.log(
      `   합집합 (${merged.size.toLocaleString()}자): 판정 보류 ` +
        `${withMerged.undecidable.toLocaleString()} / ${withMerged.total.toLocaleString()} ` +
        `(${((withMerged.undecidable / withMerged.total) * 100).toFixed(2)}%)\n`,
    );
  } else {
    console.log(`5. 빌드된 사전(${BUILD_DICT_PATH})이 없어 커버리지 계산을 건너뜁니다.\n`);
  }

  console.log('[build-readings] 완료');
}

main();
