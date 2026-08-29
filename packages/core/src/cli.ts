#!/usr/bin/env node
/**
 * 지음 CLI 데모
 *
 * 사용법:
 *   pnpm --filter @jieum/core cli "대한민국의 경제 발전을 위한 원자력 발전소"
 */

import { loadSnapshotFromFiles } from './dictionary.js';
import { JieumEngine } from './engine.js';
import { resolve } from 'node:path';

const BUILD_DIR = resolve(import.meta.dirname, '../../../data/build');

const input = process.argv[2];
if (!input) {
  console.error('사용법: jieum-cli "변환할 텍스트"');
  process.exit(1);
}

const snapshot = await loadSnapshotFromFiles(BUILD_DIR);
const engine = new JieumEngine(snapshot);

console.log(`사전: ${engine.dictSize.toLocaleString()}개 단어\n`);
console.log(`입력: ${input}`);
console.log(`결과: ${engine.convertToString(input)}`);

// 상세 결과
const matches = engine.convert(input);
if (matches.length > 0) {
  console.log(`\n--- 상세 ---`);
  for (const m of matches) {
    const top3 = m.candidates.slice(0, 3);
    const candidateStr = top3
      .map((c, i) => `${i + 1}. ${c.hanja} (점수:${c.score}, 빈도:${c.freq}, ${c.source})`)
      .join('  ');
    console.log(`${m.word} → ${candidateStr}`);
  }
}
