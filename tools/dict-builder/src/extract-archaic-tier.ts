/**
 * 2층(고어·전문어) 목록 추출
 *
 * 한자한자가 현대 한국어 기준으로 제외한 항목을 모아 지음 빌드 입력으로 만든다.
 * 지음은 이 항목들을 지우지 않고, 동음이의가 경합할 때 첫 줄을 현대어로
 * 채우기 위한 정렬 신호로만 쓴다.
 *
 * 판정을 새로 하지 않고 한자한자의 원장을 그대로 옮기므로 선별 공수가 없다.
 *
 * 사용법:
 *   pnpm --filter @jieum/dict-builder extract-archaic
 *   HANJAHANJA_DIR=/path/to/hanjahanja pnpm --filter @jieum/dict-builder extract-archaic
 *
 * 출력: data/source/generated/archaic-tier.json
 *   { "표제어": ["한자", ...], ... }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const HANJAHANJA_DIR =
  process.env['HANJAHANJA_DIR'] ?? join(homedir(), 'development/hanjahanja');
const LEDGER_DIR = join(HANJAHANJA_DIR, 'data/dict');
const OUT_DIR = resolve(import.meta.dirname, '../../../data/source/generated');
const OUT_PATH = join(OUT_DIR, 'archaic-tier.json');

/** 원장 파일 — 모두 { word, hanja, ... } 배열 */
const LEDGERS = [
  'prune-hygiene-2026-06.json',
  'prune-legacy-2026-06.json',
  'archaic-prune.json',
  'prune-rare-homonym-2026-07.json',
  'no-convert-rare-homonym-2026-07.json',
] as const;

interface LedgerRow {
  word?: string;
  hanja?: string;
  bucket?: string;
  source?: string;
  ls_count?: number;
}

function main(): void {
  if (!existsSync(LEDGER_DIR)) {
    console.error(`[지음] 한자한자 원장을 찾을 수 없습니다: ${LEDGER_DIR}`);
    console.error('       HANJAHANJA_DIR 환경변수로 위치를 지정할 수 있습니다.');
    process.exit(1);
  }

  const tier: Record<string, string[]> = {};
  const buckets = new Map<string, number>();
  let rows = 0;

  for (const file of LEDGERS) {
    const path = join(LEDGER_DIR, file);
    if (!existsSync(path)) {
      console.warn(`   ! 없음, 건너뜀: ${file}`);
      continue;
    }

    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as LedgerRow[];
    for (const row of parsed) {
      if (!row.word || !row.hanja) continue;
      const list = (tier[row.word] ??= []);
      if (!list.includes(row.hanja)) list.push(row.hanja);
      rows++;
      const bucket = row.bucket ?? row.source ?? file;
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    console.log(`   ${file.padEnd(38)} ${parsed.length.toLocaleString()}건`);
  }

  const words = Object.keys(tier).length;
  const pairs = Object.values(tier).reduce((sum, list) => sum + list.length, 0);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(tier));

  console.log(`\n   원장 행: ${rows.toLocaleString()}`);
  console.log(`   표제어: ${words.toLocaleString()} / 쌍: ${pairs.toLocaleString()}`);
  console.log('\n   버킷별 근거:');
  for (const [bucket, count] of [...buckets].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${bucket.padEnd(34)} ${count.toLocaleString()}`);
  }
  console.log(`\n   → ${OUT_PATH}`);
}

main();
