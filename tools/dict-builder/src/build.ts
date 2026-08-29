/**
 * 지음 사전 빌드 스크립트
 *
 * 한자한자 소스 데이터 → IME용 경량 JSON 변환
 *
 * 출력:
 *   data/build/jieum-dict.json       — 메인 사전 {한글: [{hanja, freq, level}]}
 *   data/build/jieum-compound.json   — 복합어 {한글: 한자}
 *   data/build/jieum-blocklist.json  — 고유어 블록리스트 [string]
 *   data/build/jieum-meta.json       — 빌드 메타데이터
 *
 * 사용법: pnpm build:dict
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { classify, splitVariant, loadReadings, type ReadingClass } from './reading-check.js';

const SOURCE_DIR = resolve(import.meta.dirname, '../../../data/source');
const BUILD_DIR = resolve(import.meta.dirname, '../../../data/build');
const DICT_DIR = join(SOURCE_DIR, 'apps/mobile/assets/dict');
const GENERATED_DIR = join(SOURCE_DIR, 'generated');
const PRUNE_DIR = resolve(import.meta.dirname, '../../../data/prune');

// --- 타입 정의 ---

interface SourceEntry {
  hanja: string;
  reading: string;
  meaning: string;
  level: number;
  source: string;
  chars?: Array<{ char: string; reading: string; meaning: string; level: number }>;
}

interface ImeEntry {
  /** 한자 */
  h: string;
  /** 빈도 (0~100, 없으면 0) */
  f: number;
  /** 급수 */
  l: number;
  /** 뜻풀이 */
  m?: string;
  /** 인명용 한자 여부 */
  n?: boolean;
  /** 2층(고어·전문어) 여부 — 한자한자가 현대어 기준에서 제외한 항목 */
  a?: boolean;
}

// --- 유틸 ---

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function fileSize(content: string): string {
  return formatBytes(Buffer.byteLength(content, 'utf-8'));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// --- 메인 로직 ---

if (!existsSync(DICT_DIR)) {
  console.error('[build] 소스 데이터가 없습니다. 먼저 pnpm sync:source를 실행하세요.');
  process.exit(1);
}

console.log('[build] jieum 사전 빌드 시작\n');
const startTime = performance.now();

// 1. level 파일 병합
console.log('1. 사전 병합...');
const levelFiles = readdirSync(DICT_DIR)
  .filter((f) => /^level-[\d.]+\.json$/.test(f))
  .sort();

const dict = new Map<string, SourceEntry[]>();
let totalSourceEntries = 0;

for (const file of levelFiles) {
  const data = readJson<Record<string, SourceEntry[]>>(join(DICT_DIR, file));
  for (const [word, entries] of Object.entries(data)) {
    const existing = dict.get(word);
    if (!existing) {
      dict.set(word, entries);
    } else {
      const knownHanjas = new Set(existing.map((e) => e.hanja));
      for (const entry of entries) {
        if (!knownHanjas.has(entry.hanja)) {
          existing.push(entry);
        }
      }
    }
    totalSourceEntries += entries.length;
  }
  console.log(`   ${file}: ${Object.keys(data).length}개 단어`);
}

console.log(`   → 병합 결과: ${dict.size}개 고유 단어, ${totalSourceEntries}개 엔트리\n`);

// 2. 빈도 데이터 로드
//
// 병합본(v1 + 한자한자 v2)이 있으면 그쪽을 쓴다. `merge-homonym-freq.ts`가
// 만들며, 값이 0~100으로 정규화돼 있다. 없으면 2026-04 복사본인 v1로 물러난다.
console.log('2. 빈도 데이터 로드...');
const MERGED_FREQ_PATH = join(GENERATED_DIR, 'homonym-freq-merged.json');
const usingMergedFreq = existsSync(MERGED_FREQ_PATH);
const homonymFreq = readJson<Record<string, Record<string, number>>>(
  usingMergedFreq ? MERGED_FREQ_PATH : join(DICT_DIR, 'homonym-freq.json'),
);
console.log(
  `   → ${Object.keys(homonymFreq).length}개 동음이의어 빈도` +
    (usingMergedFreq ? ' (v1+v2 병합본)' : ' (v1 원본 — merge-freq 미실행)'),
);
if (!usingMergedFreq) {
  console.log('     병합본을 쓰려면: pnpm --filter @jieum/dict-builder merge-freq');
}
console.log('');

/**
 * 빈도를 0~100으로 가둔다
 *
 * 바이너리 사전이 빈도를 u8에 담고, 랭커는 "빈도(0~100)와 복합어 보너스(50)를
 * 합쳐도 2층 감점(1000)을 넘지 못한다"를 전제로 설계돼 있다. v1 원본에는 이
 * 전제를 깨는 값이 있었다 — `이상/以上`이 1891이라 u8에서 99로 잘렸다.
 * 병합본은 이미 0~100이므로 이 가드는 폴백 경로를 위한 것이다.
 */
const MAX_FREQ = 100;
let clampedFreqCount = 0;
function clampFreq(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > MAX_FREQ) {
    clampedFreqCount++;
    return MAX_FREQ;
  }
  return Math.round(value);
}

// 3. IME용 경량 사전 생성 (2글자 이상)
console.log('3. IME용 사전 생성...');
const imeDict: Record<string, ImeEntry[]> = {};

for (const [word, entries] of dict) {
  if (word.length < 2) continue;

  const freq = homonymFreq[word] ?? {};

  const sorted = [...entries]
    .map((e) => ({
      h: e.hanja,
      f: clampFreq(freq[e.hanja] ?? 0),
      l: e.level,
    }))
    .sort((a, b) => {
      if (a.f !== b.f) return b.f - a.f;
      return b.l - a.l;
    })
    .slice(0, 10);

  imeDict[word] = sorted;
}

// 빈도가 실제로 몇 자리에 닿았는지 — 빈도 데이터에 있어도 사전 엔트리와
// 한자가 맞지 않으면 랭킹에 쓰이지 않는다.
{
  let withFreq = 0;
  let total = 0;
  for (const entries of Object.values(imeDict)) {
    for (const e of entries) {
      total++;
      if (e.f > 0) withFreq++;
    }
  }
  const pct = ((withFreq / total) * 100).toFixed(1);
  console.log(`   빈도가 붙은 엔트리: ${withFreq.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`);
  if (clampedFreqCount > 0) {
    console.log(`   ! 상한(${MAX_FREQ})으로 자른 빈도: ${clampedFreqCount.toLocaleString()}건`);
  }
}

// 3.5. 1글자 한자 통합 (single-hanja.json)
console.log('3.5. 1글자 한자 통합...');
const SINGLE_HANJA_PATH = join(SOURCE_DIR, 'single-hanja.json');

interface SingleHanjaEntry {
  character: string;
  reading: string;
  meaning: string;
  level: number;
  levelLabel: string;
  radical: string;
  strokeCount: number;
}

interface SingleHanjaData {
  meta: { count: number };
  byReading: Record<string, SingleHanjaEntry[]>;
  byCharacter: Record<string, SingleHanjaEntry>;
}

let singleCharCount = 0;

if (existsSync(SINGLE_HANJA_PATH)) {
  const singleData = readJson<SingleHanjaData>(SINGLE_HANJA_PATH);

  for (const [reading, chars] of Object.entries(singleData.byReading)) {
    // 급수 내림차순 정렬 (높은 급수 = 상용 한자 먼저)
    const sorted = [...chars]
      .sort((a, b) => b.level - a.level)
      .map((c) => ({
        h: c.character,
        f: 0,
        l: c.level,
        m: c.meaning,
      }));

    imeDict[reading] = sorted;
    singleCharCount += sorted.length;
  }

  console.log(`   → ${Object.keys(singleData.byReading).length}개 음독, ${singleCharCount}개 한자`);
} else {
  console.log('   → single-hanja.json 없음, 건너뜀');
}

// 3.6. 인명용 한자 병합 (inmyeong-hanja.json)
console.log('3.6. 인명용 한자 병합...');
const INMYEONG_PATH = join(SOURCE_DIR, 'inmyeong-hanja.json');

interface InmyeongEntry {
  character: string;
  reading: string;
  meaning: string;
  strokeCount: number;
}

interface InmyeongData {
  meta: { count: number };
  characters: InmyeongEntry[];
}

let inmyeongAdded = 0;

if (existsSync(INMYEONG_PATH)) {
  const inmyeongData = readJson<InmyeongData>(INMYEONG_PATH);

  // 기존 사전에 이미 있는 한자 Set (모든 음독의 모든 한자)
  const existingChars = new Set<string>();
  for (const entries of Object.values(imeDict)) {
    for (const e of entries) {
      existingChars.add(e.h);
    }
  }

  // 인명용에만 있는 한자를 음독별로 그룹핑하여 추가
  let inmyeongSkipped = 0;
  for (const entry of inmyeongData.characters) {
    if (existingChars.has(entry.character)) continue;

    // 확장 B/C+ (U+20000~) 글자 제외 — 일반 폰트에서 렌더링 불가
    const cp = entry.character.codePointAt(0) ?? 0;
    if (cp >= 0x20000) {
      inmyeongSkipped++;
      continue;
    }

    const reading = entry.reading;
    if (!imeDict[reading]) imeDict[reading] = [];

    imeDict[reading].push({
      h: entry.character,
      f: 0,
      l: 0,
      m: entry.meaning || reading,
      n: true,
    });

    existingChars.add(entry.character);
    inmyeongAdded++;
  }

  console.log(`   → ${inmyeongAdded}개 인명용 한자 추가 (${inmyeongSkipped}개 확장B/C+ 제외)\n`);
} else {
  console.log('   → inmyeong-hanja.json 없음, 건너뜀\n');
}

// 3.65. 독음표 기준 1글자 보완 — 벽자·희귀자·古字와 두음 변형
//
// 3.5·3.6이 쓰는 자원에는 **한 글자의 두 번째 독음이 없다.** `single-hanja.json`은
// 5,978자에 金이 아예 없고, 인명용 한자표는 `金→금`·`李→리`만 담는다. 게다가 3.6은
// 글자 단위로 중복을 걸러(`existingChars`) 이미 다른 독음에 있는 글자를 두 번째
// 독음으로 넣지 못한다. 그 결과 **'김'과 '이'에 金·李가 없었다** — 한국에서 가장 흔한
// 두 성씨다.
//
// `hanja-readings.json`(Unihan kHangul ∪ 배정한자, 8,976자)은 두음 변형을 정확히
// 담고 있는데 지금까지 5.55(독음 검증)에서만 쓰였다. 여기서 1글자 표제어를 이 표에
// 맞춰 채운다 — 독음표의 9,403쌍 중 3,425쌍(36%)이 빠져 있었다.
//
// 이 단계는 실제 한자인데도 변환할 방법이 없던 3,425개 독음 쌍을 보완한다.
//
// **층을 나눈다.** 이미 아는 글자(급수가 매겨졌거나 인명용에 오른 것)의 다른 독음은
// 1층이고 — 金이 '김'의 첫 줄이어야 한다 — 독음표에만 있는 진짜 벽자는 2층이다.
// 그러지 않으면 '이'의 후보 62개 위에 벽자 46개가 섞여 상용 글자를 밀어낸다.
console.log('3.65. 독음표 기준 1글자 보완...');
const READINGS_FOR_SINGLE = join(SOURCE_DIR, 'hanja-readings.json');

if (existsSync(READINGS_FOR_SINGLE)) {
  const readingTable = readJson<Record<string, string | string[]>>(READINGS_FOR_SINGLE);

  // '아는 글자' = 3.5·3.6이 넣은 것. 이들의 다른 독음은 상용으로 본다.
  const known = new Set<string>();
  for (const entries of Object.values(imeDict)) {
    for (const e of entries) if (e.h.length === 1) known.add(e.h);
  }

  let addedTier1 = 0;
  let addedTier2 = 0;

  for (const [hanja, raw] of Object.entries(readingTable)) {
    // 확장 B/C+(U+20000~)는 일반 폰트에서 안 그려진다 — 3.6과 같은 기준
    if ((hanja.codePointAt(0) ?? 0) >= 0x20000) continue;

    // CJK 호환 한자(U+F900~U+FAFF)를 통합 한자로 되돌린다. 그 영역은 유니코드가
    // **한국어 독음별 중복 등록**을 위해 만든 것이라 `冷 U+F92E`(냉)가 `冷 U+51B7`(랭)과
    // 화면에서 구별되지 않는다. 그대로 두면 후보에 똑같아 보이는 글자가 둘 뜨고,
    // 사용자가 고른 글자가 NFC 정규화를 거치며 다른 코드로 바뀐다.
    const normalized = hanja.normalize('NFC');

    const readings = Array.isArray(raw) ? raw : [raw];
    for (const reading of readings) {
      if (!reading) continue;
      const entries = (imeDict[reading] ??= []);
      if (entries.some((e) => e.h === normalized)) continue;

      const isKnown = known.has(normalized);
      entries.push({ h: normalized, f: 0, l: 0, ...(isKnown ? {} : { a: true }) });
      if (isKnown) addedTier1++;
      else addedTier2++;
    }
  }

  console.log(`   → ${(addedTier1 + addedTier2).toLocaleString()}개 보완`);
  console.log(
    `   → 아는 글자의 다른 독음 ${addedTier1.toLocaleString()}개(1층) · ` +
      `벽자·희귀자 ${addedTier2.toLocaleString()}개(2층)\n`,
  );
} else {
  console.log('   → hanja-readings.json 없음, 건너뜀\n');
}

// 3.7. 원본 CSV 보충 병합 (고어/사어 등 level 파일에서 제외된 항목 복원)
console.log('3.7. 원본 CSV 보충 병합...');
const CSV_PATH = join(SOURCE_DIR, 'hanja-words-extracted.csv');

let csvSupplemented = 0;
let csvNewWords = 0;

if (existsSync(CSV_PATH)) {
  const csvRaw = readFileSync(CSV_PATH, 'utf-8');
  const lines = csvRaw.split('\n');
  // 헤더: korean,hanja,meaning,pos,source
  const header = lines[0].split(',');
  const koreanIdx = header.indexOf('korean');
  const hanjaIdx = header.indexOf('hanja');
  const meaningIdx = header.indexOf('meaning');

  // 기존 사전에 이미 있는 한자 Set (word+hanja 조합)
  const existingPairs = new Set<string>();
  for (const [word, entries] of Object.entries(imeDict)) {
    for (const e of entries) {
      existingPairs.add(`${word}\t${e.h}`);
    }
  }

  // CSV 파싱 (간단한 CSV — meaning 필드에 쉼표가 있을 수 있으므로 인용부호 처리)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // CSV 필드 파싱 (인용부호 내 쉼표 처리)
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current);

    const korean = fields[koreanIdx];
    const hanja = fields[hanjaIdx];
    const meaning = fields[meaningIdx];

    if (!korean || !hanja || korean.length < 2) continue;
    if (existingPairs.has(`${korean}\t${hanja}`)) continue;

    if (!imeDict[korean]) {
      imeDict[korean] = [];
      csvNewWords++;
    }

    // 기존 엔트리가 10개 미만일 때만 추가
    if (imeDict[korean].length < 10) {
      imeDict[korean].push({
        h: hanja,
        f: 0,
        l: 0,
      });
      existingPairs.add(`${korean}\t${hanja}`);
      csvSupplemented++;
    }
  }

  console.log(`   → ${csvNewWords}개 신규 단어, ${csvSupplemented}개 엔트리 보충\n`);
} else {
  console.log('   → hanja-words-extracted.csv 없음, 건너뜀\n');
}

// 3.8. 위키문헌 병기 보충 (고전·역사 어휘)
//
// 한자 병기 문서에서 뽑은 (표제어, 한자) 쌍 중 **표제어는 이미 있고 그 한자만
// 없던** 것이다. 표제어를 새로 만들지 않으므로 구조를 안 건드리고, 후보가 하나
// 느는 것이라 오변환이 생기는 게 아니라 선택지가 는다.
//
// 원본 CSV는 표준국어대사전·opendict 기반이라 고전 인명·지명·문헌 고유어가
// 애초에 없다. 그래서 고전·역사 골든셋에서 못 찾는 비율이 30.7%였고, 그것을
// 메우는 것이 이 단계다 (2026-08-04 실측).
//
// **개수 제한을 두지 않는다.** 3.7의 10개 제한은 CSV에 나온 순서대로 앞에서
// 자르는 것이라 빈도순이 아니다 — '사사'의 열 칸이 使事·四絲·死士 같은 희귀어로
// 차고 정작 한문 문헌의 상용어인 師事·賜死가 밀려났다. 이 목록은 '서로 다른
// 문서에서 2회 이상'이라는 문지기를 이미 통과했고 5.55 독음 검증이 뒤에서 한 번
// 더 거른다. 추가 후 최대 17개이며, 사전에는 이미 13개 이상인 표제어가 234개
// 있으므로 상한을 푸는 쪽이 오히려 일관된다.
//
// 1층으로 넣는다(`a` 표시 없음). '사사'의 기존 열 개가 전부 2층이었듯 고전
// 어휘만 있는 표제어가 있고, 거기서 2층으로 넣으면 아무것도 위로 못 올라온다.
// `f: 0`이라 빈도가 있는 현대어보다는 아래에 놓인다.
console.log('3.8. 위키문헌 병기 보충...');
const WIKISOURCE_PATH = join(SOURCE_DIR, 'wikisource-pairs.json');

if (existsSync(WIKISOURCE_PATH)) {
  const pairsFile = readJson<{
    total: number;
    thresholds: { minCount: number; minWorks: number; maxWordLength: number };
    entries: { word: string; hanja: string; count: number; works: number }[];
  }>(WIKISOURCE_PATH);
  const { minCount, minWorks, maxWordLength } = pairsFile.thresholds;

  // 3.7이 방금 엔트리를 더 넣었으므로 존재 여부를 여기서 다시 센다.
  const pairs = new Set<string>();
  for (const [word, entries] of Object.entries(imeDict)) {
    for (const e of entries) pairs.add(`${word}\t${e.h}`);
  }

  let added = 0;
  let skippedNoHeadword = 0;
  let skippedDuplicate = 0;
  let skippedThreshold = 0;

  for (const item of pairsFile.entries) {
    const entries = imeDict[item.word];
    // 표제어가 없으면 여기서는 건너뛴다 — 3.9가 다른 문턱으로 다룬다.
    if (!entries) {
      skippedNoHeadword++;
      continue;
    }
    // 파일에는 두 갈래가 함께 담겨 있다(추출이 사전을 안 보므로). 한자 추가는
    // 등장 횟수 문턱을 쓴다.
    if (item.count < minCount) {
      skippedThreshold++;
      continue;
    }
    if (pairs.has(`${item.word}\t${item.hanja}`)) {
      skippedDuplicate++;
      continue;
    }

    entries.push({ h: item.hanja, f: 0, l: 0 });
    pairs.add(`${item.word}\t${item.hanja}`);
    added++;
  }

  console.log(`   → ${added.toLocaleString()}개 엔트리 보충`);
  console.log(
    `   → 건너뜀: 표제어 없음 ${skippedNoHeadword.toLocaleString()} (3.9가 다룬다) / ` +
      `이미 있음 ${skippedDuplicate.toLocaleString()} / 문턱 미달 ${skippedThreshold.toLocaleString()}\n`,
  );

  // 3.9. 위키문헌 새 표제어 (2층)
  //
  // 표제어 자체가 사전에 없던 것이다. 원본 CSV가 표준국어대사전·opendict 기반이라
  // 고전 인명·지명·문헌 고유어가 애초에 없고, 그것이 고전·역사 골든셋에서 '표제어가
  // 없음' 20.5%로 나타난다.
  //
  // **다 넣지 않는다.** 한 문헌에만 등장한 표기는 오기나 저자 고유 표기일 수 있다.
  // 표본의 95.1%가 단 하나의 문헌에만 나왔고, 그중에는
  // `유세차감소고우(維歲次敢昭告于)` 같은 제문 상투구가 표제어인 양 섞여 있다.
  //
  // 그래서 '서로 다른 문헌 몇 개에 나오는가'로 통용 여부를 재고(추출에서 이미 걸렀다),
  // 여기서는 **2층으로** 넣는다. 2층은 드문 어휘를 아래쪽에 두려고 만든 장치이므로
  // 흔한 말을 칠 때 방해가 되지 않고, 그 표제어에 2층밖에 없으면 5.5의 규칙에 따라
  // lookup이 첫 줄로 승격한다 — '온조'를 친 사람은 溫祚를 원한 것이다.
  console.log('3.9. 위키문헌 새 표제어 (2층)...');

  let newWords = 0;
  let newEntries = 0;
  let skippedExisting = 0;
  // 이 단계에서 만든 표제어. 한 표제어에 한자가 둘 이상인 경우(온조/溫祚·溫柞 같은)
  // 두 번째부터는 '이미 있음'으로 빠지므로 우리가 만든 것인지 구분해야 한다.
  const created = new Set<string>();

  for (const item of pairsFile.entries) {
    if (item.works < minWorks || item.word.length > maxWordLength) continue;
    if (imeDict[item.word] && !created.has(item.word)) {
      skippedExisting++;
      continue;
    }
    if (pairs.has(`${item.word}\t${item.hanja}`)) continue;

    if (created.has(item.word)) {
      imeDict[item.word]!.push({ h: item.hanja, f: 0, l: 0, a: true });
    } else {
      imeDict[item.word] = [{ h: item.hanja, f: 0, l: 0, a: true }];
      created.add(item.word);
      newWords++;
    }
    pairs.add(`${item.word}\t${item.hanja}`);
    newEntries++;
  }

  console.log(`   → ${newWords.toLocaleString()}개 표제어 신설 (${newEntries.toLocaleString()}개 엔트리)`);
  console.log(`   → 건너뜀: 이미 표제어가 있음 ${skippedExisting.toLocaleString()}\n`);
} else {
  console.log(
    '   → wikisource-pairs.json 없음, 건너뜀 (pnpm --filter @jieum/eval extract-supplement)\n',
  );
}

// let: 5.55(독음 검증)가 오매핑을 지우고 표제어를 통째로 비우기도 해서, 그
// 뒤에 이 값들을 다시 계산해 넣는다. meta.json의 최종 통계가 여기 있는
// 스냅샷(검증 전)이 아니라 실제 출력 파일 기준이어야 한다.
let imeDictWordCount = Object.keys(imeDict).length;
let imeDictEntryCount = Object.values(imeDict).reduce((sum, arr) => sum + arr.length, 0);
console.log(`   → 총 ${imeDictWordCount}개 단어, ${imeDictEntryCount}개 엔트리`);

// 4. 복합어 로드
console.log('4. 복합어 로드...');
const compoundWords = readJson<Record<string, string>>(join(DICT_DIR, 'compound-words.json'));
console.log(`   → ${Object.keys(compoundWords).length}개 복합어\n`);

// 5. 블록리스트 로드
console.log('5. 블록리스트 로드...');
const blocklist = readJson<string[]>(join(GENERATED_DIR, 'native-korean-blocklist.json'));
console.log(`   → ${blocklist.length}개 고유어\n`);

// 5.5. 2층(고어·전문어) 표시
//
// 현대 한국어 기준으로 제외된 항목도 지우지 않고 층으로만 나눈다. 동음이의가
// 경합할 때 첫 줄을 현대어로 채우는
// 정렬 신호다. 목록은 extract-archaic이 한자한자 원장에서 미리 뽑아둔다.
console.log('5.5. 2층(고어·전문어) 표시...');
const ARCHAIC_TIER_PATH = join(GENERATED_DIR, 'archaic-tier.json');
if (existsSync(ARCHAIC_TIER_PATH)) {
  const archaicTier = readJson<Record<string, string[]>>(ARCHAIC_TIER_PATH);
  let marked = 0;
  let modernOnly = 0;
  let archaicOnly = 0;
  let mixed = 0;

  for (const [word, entries] of Object.entries(imeDict)) {
    const archaicHanja = archaicTier[word];
    if (!archaicHanja) { modernOnly++; continue; }

    let count = 0;
    for (const entry of entries) {
      if (archaicHanja.includes(entry.h)) {
        entry.a = true;
        marked++;
        count++;
      }
    }
    if (count === 0) modernOnly++;
    else if (count === entries.length) archaicOnly++;
    else mixed++;
  }

  console.log(`   → ${marked.toLocaleString()}개 엔트리를 2층으로 표시`);
  console.log(`   → 표제어: 1층만 ${modernOnly.toLocaleString()} / 섞임 ${mixed.toLocaleString()} / 2층만 ${archaicOnly.toLocaleString()}`);
  console.log('   ※ 2층만인 표제어는 lookup에서 첫 줄로 승격된다 (전공 어휘 보존)\n');
} else {
  console.log('   → archaic-tier.json 없음, 건너뜀 (pnpm --filter @jieum/dict-builder extract-archaic)\n');
}

// 5.55. 독음 검증
//
// 후보 한자가 표제어로 실제로 읽히는지 확인한다. 우리말샘 유의어/반의어
// 관계가 hanja-words-extracted.csv의 한자 필드로 새어 들어온 것들이 있다
// (빌드 결함이 아니라 원본 데이터 문제) — 권외의 후보에 반의어 圈內·權內가
// 섞여 있는 식이다. 판정 로직(reading-check.ts)은 검증된 Python 프로토타입을
// 그대로 옮긴 것이며, 이형태 이어붙임(竝記倂記 같은)은 쪼개서 살리고 나머지
// 오매핑은 지운다. 5.6(연어 규칙 정리)보다 먼저 둬야 그쪽이 교정된 후보
// 목록을 보고 규칙을 떨어낸다.
console.log('5.55. 독음 검증...');
const READINGS_PATH = join(SOURCE_DIR, 'hanja-readings.json');

if (!existsSync(READINGS_PATH)) {
  console.log(
    `   → hanja-readings.json 없음, 건너뜀 (pnpm --filter @jieum/dict-builder build-readings)\n`,
  );
} else {
  const readingsJson = readJson<Record<string, string[]>>(READINGS_PATH);
  const readingTable = loadReadings(readingsJson);

  const classCounts: Record<ReadingClass, number> = {
    ok: 0,
    unknown: 0,
    repeat: 0,
    truncated: 0,
    extended: 0,
    partial: 0,
    unrelated: 0,
  };

  interface MismatchRow {
    word: string;
    hanja: string;
    kind: 'truncated' | 'extended' | 'partial' | 'unrelated';
    f: number;
    l: number;
    a: boolean;
  }
  interface VariantSplitRow {
    word: string;
    original: string;
    pieces: string[];
    skipped: string[];
  }

  const mismatchEntries: MismatchRow[] = [];
  const variantSplitEntries: VariantSplitRow[] = [];
  let piecesAdded = 0;
  let duplicatesSkipped = 0;
  let emptiedWords = 0;

  for (const [word, entries] of Object.entries(imeDict)) {
    // 그 표제어의 "현재 후보" 집합 — 조각을 하나씩 추가할 때마다 갱신해서,
    // 같은 표제어 안에서 나온 조각끼리도, 원래 있던 후보와도 겹치지 않게 한다.
    const known = new Set(entries.map((e) => e.h));
    const nextEntries: ImeEntry[] = [];

    for (const entry of entries) {
      const kind = classify(word, entry.h, readingTable);
      classCounts[kind]++;

      if (kind === 'ok' || kind === 'unknown') {
        nextEntries.push(entry);
        continue;
      }

      if (kind === 'repeat') {
        const pieces = splitVariant(word, entry.h, readingTable) ?? [];
        const skipped: string[] = [];
        for (const piece of pieces) {
          if (known.has(piece)) {
            skipped.push(piece);
            duplicatesSkipped++;
            continue;
          }
          known.add(piece);
          nextEntries.push({ ...entry, h: piece });
          piecesAdded++;
        }
        variantSplitEntries.push({ word, original: entry.h, pieces, skipped });
        continue;
      }

      // truncated / extended / partial / unrelated → 제거, 원장에 기록
      mismatchEntries.push({
        word,
        hanja: entry.h,
        kind,
        f: entry.f,
        l: entry.l,
        a: entry.a ?? false,
      });
    }

    if (nextEntries.length === 0) {
      delete imeDict[word];
      emptiedWords++;
    } else {
      imeDict[word] = nextEntries;
    }
  }

  const badTotal =
    classCounts.truncated + classCounts.extended + classCounts.partial + classCounts.unrelated;

  mkdirSync(PRUNE_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();
  const readingTableMeta = {
    characters: Object.keys(readingsJson).length,
    source: 'data/source/hanja-readings.json',
  };

  writeFileSync(
    join(PRUNE_DIR, 'reading-mismatch-2026-08-01.json'),
    JSON.stringify(
      {
        generatedAt,
        reason: 'reading-mismatch',
        method:
          'hanja readings (Unihan kHangul + 배정한자) vs headword syllables. 두음법칙은 단어 ' +
          '전체의 첫머리뿐 아니라 모든 글자 위치에서 적용한다 — 郎廳(낭청)처럼 합성어 내부 ' +
          '경계에서도 본음(郎=랑)이 두음법칙 변형(낭)으로 바뀌고, 그 경계를 형태소 분석 없이 ' +
          '미리 알 수 없기 때문이다(가낭청·겸낭청·강직성연축·애인여기 등 205개 표제어가 ' +
          '어두 한정 규칙으로는 잘못 잘렸다). 대가로 세뇌→洗罍(罍=뢰→뇌) 같은 극소수 우연한 ' +
          '오탐이 남는다.',
        readingTable: readingTableMeta,
        counts: {
          truncated: classCounts.truncated,
          extended: classCounts.extended,
          partial: classCounts.partial,
          unrelated: classCounts.unrelated,
        },
        entries: mismatchEntries,
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(PRUNE_DIR, 'variant-split-2026-08-01.json'),
    JSON.stringify(
      {
        generatedAt,
        reason: 'variant-split',
        method:
          '이형태 이어붙임 — 한자를 어근 길이로 등분했을 때 모든 조각이 읽히면 조각으로 교체. ' +
          '이미 있는 후보와 겹치는 조각은 건너뛴다(skipped).',
        readingTable: readingTableMeta,
        counts: {
          repeat: classCounts.repeat,
          piecesAdded,
          duplicatesSkipped,
        },
        entries: variantSplitEntries,
      },
      null,
      2,
    ),
  );

  // 3.7에서 찍은 스냅샷이 이제 낡았다 — 오매핑 제거·표제어 소실을 반영해 다시 센다.
  imeDictWordCount = Object.keys(imeDict).length;
  imeDictEntryCount = Object.values(imeDict).reduce((sum, arr) => sum + arr.length, 0);

  console.log(
    `   → 정상 ${classCounts.ok.toLocaleString()} · 판정 보류 ${classCounts.unknown.toLocaleString()}`,
  );
  console.log(
    `   → 이형태 쪼갬 ${classCounts.repeat.toLocaleString()}건 → ${piecesAdded.toLocaleString()} 엔트리 ` +
      `(중복 ${duplicatesSkipped.toLocaleString()}건 제외)`,
  );
  console.log(
    `   → 오매핑 제거 ${badTotal.toLocaleString()}건 (짧음 ${classCounts.truncated.toLocaleString()} / ` +
      `김 ${classCounts.extended.toLocaleString()} / 부분 ${classCounts.partial.toLocaleString()} / ` +
      `무관 ${classCounts.unrelated.toLocaleString()})`,
  );
  console.log(`   → 후보가 모두 사라진 표제어 ${emptiedWords.toLocaleString()}개\n`);
}

// 5.6. 연어(문맥 판별) 규칙 정리
//
// 한자한자가 쌓은 문맥 규칙이다. 그쪽은 이것으로 한자를 확정하지만(자동 변환),
// 지음은 후보 순위를 올리는 데만 쓴다. 여기서는 지음 사전과 대조해 닿지 않는
// 규칙을 떨어낸다 — 실제로 판별이 갈리는 자리만 남겨야 파일도 작고 조회도 싸다.
console.log('5.6. 연어 규칙 정리...');
const COLLOCATION_PATH = join(GENERATED_DIR, 'collocation.json');
interface CollocationRuleOut { h: string; c: string[] }
const collocation: Record<string, CollocationRuleOut[]> = {};

if (existsSync(COLLOCATION_PATH)) {
  const source = readJson<Record<string, CollocationRuleOut[]>>(COLLOCATION_PATH);
  const dropped = { noWord: 0, noContest: 0, noHanja: 0, noRule: 0 };

  for (const [word, rules] of Object.entries(source)) {
    const entries = imeDict[word];
    if (!entries) { dropped.noWord++; continue; }
    // 후보가 하나뿐이면 문맥을 봐도 고를 것이 없다
    if (entries.length < 2) { dropped.noContest++; continue; }

    const known = new Set(entries.map((e) => e.h));
    const kept: CollocationRuleOut[] = [];
    for (const rule of rules) {
      if (!known.has(rule.h)) { dropped.noHanja++; continue; }
      kept.push(rule);
    }
    if (kept.length === 0) { dropped.noRule++; continue; }
    collocation[word] = kept;
  }

  const words = Object.keys(collocation).length;
  const rules = Object.values(collocation).reduce((s, r) => s + r.length, 0);
  const contexts = Object.values(collocation).reduce(
    (s, r) => s + r.reduce((n, x) => n + x.c.length, 0), 0,
  );
  console.log(`   → ${words.toLocaleString()}개 표제어 / ${rules.toLocaleString()}개 규칙 / ${contexts.toLocaleString()}개 문맥어`);
  console.log(`   떨어낸 것: 사전에 없는 표제어 ${dropped.noWord} / 경합 없음 ${dropped.noContest} / 후보에 없는 한자 ${dropped.noHanja} / 남은 규칙 없음 ${dropped.noRule}\n`);
} else {
  console.log('   → collocation.json 없음, 건너뜀 (pnpm --filter @jieum/dict-builder extract-collocation)\n');
}

// 5.7. CJK 호환 한자 정규화
//
// U+F900~U+FAFF는 유니코드가 **한국어 독음별 중복 등록**을 위해 만든 영역이다.
// `冷 U+F92E`(냉)는 `冷 U+51B7`(랭)과 화면에서 구별되지 않는데 코드가 다르다.
//
// 그대로 두면 세 가지가 어긋난다:
//  1. 후보에 똑같아 보이는 글자가 둘 뜬다 — 사용자가 어느 쪽인지 알 수 없다
//  2. 고른 글자가 NFC 정규화를 거치며 다른 코드로 바뀐다 (저장·전송·검색에서 어긋남)
//  3. 골든셋 대조에서 같은 글자가 다르게 세어진다
//
// 원본 자료(level 파일·CSV·위키문헌)에서 새어 들어온 것이 377개 엔트리 있었다.
// 정규화하면 같은 표제어 안에서 겹치므로 병합한다.
//
// **모든 병합이 끝난 뒤에 돌려야 한다.** 3.x 사이에 두었더니 뒤 단계(CSV 보충·
// 위키문헌)가 호환 한자를 다시 넣어 107개가 남았다.
console.log('5.7. CJK 호환 한자 정규화...');
{
  let normalizedCount = 0;
  let mergedCount = 0;

  for (const [word, entries] of Object.entries(imeDict)) {
    let touched = false;
    for (const e of entries) {
      const n = e.h.normalize('NFC');
      if (n !== e.h) {
        e.h = n;
        normalizedCount++;
        touched = true;
      }
    }
    if (!touched) continue;

    // 정규화로 생긴 중복을 없앤다. 먼저 온 것을 남긴다 — 앞쪽이 상용이다.
    const seen = new Set<string>();
    const deduped = entries.filter((e) => {
      if (seen.has(e.h)) {
        mergedCount++;
        return false;
      }
      seen.add(e.h);
      return true;
    });
    if (deduped.length !== entries.length) imeDict[word] = deduped;
  }

  console.log(`   → ${normalizedCount.toLocaleString()}개 정규화, ${mergedCount.toLocaleString()}개 중복 병합\n`);
}

// 6. 출력
console.log('6. 빌드 파일 생성...');
mkdirSync(BUILD_DIR, { recursive: true });

const dictJson = JSON.stringify(imeDict);
const compoundJson = JSON.stringify(compoundWords);
const blocklistJson = JSON.stringify(blocklist);
// 연어는 사전 바이너리에 넣지 않고 따로 둔다 — 없어도 엔진이 돌고,
// 문맥 판별이 필요 없는 통합처는 받지 않아도 된다.
const collocationJson = JSON.stringify(collocation);

writeFileSync(join(BUILD_DIR, 'jieum-dict.json'), dictJson);
writeFileSync(join(BUILD_DIR, 'jieum-compound.json'), compoundJson);
writeFileSync(join(BUILD_DIR, 'jieum-blocklist.json'), blocklistJson);
writeFileSync(join(BUILD_DIR, 'jieum-collocation.json'), collocationJson);

// 바이너리 사전 생성
console.log('   바이너리 사전 생성...');
import { buildBinary } from '../../../packages/core/src/binary-dict.js';
const binaryBuffer = buildBinary({
  // BinaryBuildInput.dict가 이미 Record<string, ImeEntry[]>다.
  // 손으로 적은 캐스팅은 필드가 늘 때마다 뒤처져 새 플래그를 조용히 떨어뜨린다.
  dict: imeDict,
  compound: compoundWords,
  blocklist,
});
writeFileSync(join(BUILD_DIR, 'jieum-dict.dat'), Buffer.from(binaryBuffer));
console.log(`   jieum-dict.dat       ${formatBytes(binaryBuffer.byteLength)}`);

// gzip 압축 파일 생성
console.log('   gzip 압축...');
const dictGz = gzipSync(dictJson, { level: 9 });
const compoundGz = gzipSync(compoundJson, { level: 9 });
const blocklistGz = gzipSync(blocklistJson, { level: 9 });
const collocationGz = gzipSync(collocationJson, { level: 9 });

const binaryGz = gzipSync(Buffer.from(binaryBuffer), { level: 9 });

writeFileSync(join(BUILD_DIR, 'jieum-dict.json.gz'), dictGz);
writeFileSync(join(BUILD_DIR, 'jieum-compound.json.gz'), compoundGz);
writeFileSync(join(BUILD_DIR, 'jieum-blocklist.json.gz'), blocklistGz);
writeFileSync(join(BUILD_DIR, 'jieum-collocation.json.gz'), collocationGz);
writeFileSync(join(BUILD_DIR, 'jieum-dict.dat.gz'), binaryGz);

const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

const meta = {
  buildDate: new Date().toISOString(),
  buildTimeSeconds: Number(elapsed),
  stats: {
    sourceWords: dict.size,
    sourceEntries: totalSourceEntries,
    imeWords: imeDictWordCount,
    imeEntries: imeDictEntryCount,
    compoundWords: Object.keys(compoundWords).length,
    blocklist: blocklist.length,
    singleCharCount,
    collocationWords: Object.keys(collocation).length,
  },
  sizes: {
    'jieum-dict.json': fileSize(dictJson),
    'jieum-compound.json': fileSize(compoundJson),
    'jieum-blocklist.json': fileSize(blocklistJson),
    'jieum-collocation.json': fileSize(collocationJson),
    'jieum-dict.dat': formatBytes(binaryBuffer.byteLength),
  },
  gzipSizes: {
    'jieum-dict.json.gz': formatBytes(dictGz.byteLength),
    'jieum-compound.json.gz': formatBytes(compoundGz.byteLength),
    'jieum-blocklist.json.gz': formatBytes(blocklistGz.byteLength),
    'jieum-collocation.json.gz': formatBytes(collocationGz.byteLength),
    'jieum-dict.dat.gz': formatBytes(binaryGz.byteLength),
  },
};

writeFileSync(join(BUILD_DIR, 'jieum-meta.json'), JSON.stringify(meta, null, 2));

console.log(`   jieum-dict.json      ${meta.sizes['jieum-dict.json']} → gzip ${formatBytes(dictGz.byteLength)}`);
console.log(`   jieum-compound.json  ${meta.sizes['jieum-compound.json']} → gzip ${formatBytes(compoundGz.byteLength)}`);
console.log(`   jieum-blocklist.json ${meta.sizes['jieum-blocklist.json']} → gzip ${formatBytes(blocklistGz.byteLength)}`);
console.log(`   jieum-collocation.json ${meta.sizes['jieum-collocation.json']} → gzip ${formatBytes(collocationGz.byteLength)}`);

// 원본 대비 압축률 계산
const sourceSize = levelFiles.reduce((sum, f) => {
  const stat = readFileSync(join(DICT_DIR, f));
  return sum + stat.byteLength;
}, 0);
const buildSize = Buffer.byteLength(dictJson, 'utf-8');
const ratio = ((1 - buildSize / sourceSize) * 100).toFixed(1);
const gzipTotal = dictGz.byteLength + compoundGz.byteLength + blocklistGz.byteLength;

// 7. 앱으로 배포
//
// 런타임은 각 앱의 public/data/에서 사전을 읽는다. 이 복사가 수동이면
// "사전을 다시 빌드했는데 앱은 그대로"가 조용히 반복된다.
console.log('\n7. 앱으로 배포...');
const APP_DATA_DIRS = [
  resolve(import.meta.dirname, '../../../apps/editor/public/data'),
  resolve(import.meta.dirname, '../../../apps/demo/public/data'),
];
const DEPLOY_FILES = [
  'jieum-dict.json',
  'jieum-dict.dat',
  'jieum-compound.json',
  'jieum-blocklist.json',
  'jieum-collocation.json',
  'jieum-meta.json',
];

for (const dir of APP_DATA_DIRS) {
  if (!existsSync(dir)) {
    console.log(`   ! 없음, 건너뜀: ${dir}`);
    continue;
  }
  for (const file of DEPLOY_FILES) {
    copyFileSync(join(BUILD_DIR, file), join(dir, file));
  }
  console.log(`   → ${dir.replace(resolve(import.meta.dirname, '../../..') + '/', '')}`);
}

console.log(`\n[build] 완료! (${elapsed}초)`);
console.log(`   원본: ${(sourceSize / 1024 / 1024).toFixed(1)}MB → IME: ${fileSize(dictJson)} → gzip: ${formatBytes(gzipTotal)} (${ratio}% 절감)`);
