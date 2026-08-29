/**
 * 한자 병기 문서 → 골든셋.
 *
 * `재산을 이전(移轉)하였다` 같은 병기는 그 자체가 정답표다. 한자를 떼면 사용자가 치는
 * 것이 되고, 뗀 한자가 정답이 된다.
 *
 * ## 병기를 **지운** 문장이 골든셋의 문장이다
 *
 * 사용자가 실제로 치는 것은 `재산을 이전하였다`이지 괄호가 붙은 형태가 아니다. 괄호를
 * 남기면 앞 문맥에 한자가 섞여 들어가는데, 지음은 그 시점에 한자를 본 적이 없으므로
 * 실사용과 다른 조건에서 재게 된다. 한 문장에 병기가 여럿이면 **전부 지운 문장** 하나를
 * 만들고 각 위치를 다시 계산한다.
 *
 * ## 무엇을 거르는가
 *
 * 병기처럼 보이지만 아닌 것이 많다. 음절 수가 안 맞는 것(`서울(京)`), 괄호 안에 한자
 * 아닌 것이 섞인 것(`이전(移轉, transfer)`), 한 글자 조사에 붙은 것 등. 거르지 않으면
 * 골든셋이 오염되고, 오염된 골든셋으로 잰 숫자는 없느니만 못하다.
 *
 * ```
 * pnpm --filter @jieum/eval build-golden -- --source <덤프.xml.bz2> --domain wikisource
 * ```
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';


/** 한글 음절 + 괄호 안 한자. 음절 수가 같은 것만 뒤에서 다시 거른다 */
const ANNOTATED = /([가-힣]{1,12})\(([一-鿿㐀-䶿]{1,12})\)/g;

/** 문장을 끝내는 부호 */
const SENTENCE_END = /(?<=[.!?。！？])\s+/;

export interface GoldenOut {
  sentence: string;
  surface: string;
  hanja: string;
  begin: number;
  end: number;
  domain: string;
  source: string;
}

/**
 * 위키 마크업을 걷어낸다.
 *
 * 완벽할 필요는 없다. 목적은 **병기 주변 문맥이 사람이 읽는 문장에 가깝게** 만드는 것이지
 * 위키 문법을 정확히 해석하는 것이 아니다. 남은 찌꺼기가 있는 문장은 뒤에서 통째로 버린다.
 */
export function stripMarkup(text: string): string {
  return text
    .replace(/<ref[^>]*\/>/g, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\{[^{}]*\}\}/g, '') // 단순 템플릿 (중첩은 아래에서 반복 제거)
    .replace(/\{\{[\s\S]*?\}\}/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]|]*)\]\]/g, '$1') // [[A|B]] → B
    .replace(/\[https?:[^\s\]]*\s([^\]]*)\]/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/'''?/g, '')
    .replace(/^[*#:;=|!].*$/gm, '') // 목록·표·머리말 줄은 문장이 아니다
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

/** 문장 하나에서 사례들을 뽑는다. 병기가 없으면 빈 배열 */
export function extractFrom(
  sentence: string,
  domain: string,
  source: string,
): GoldenOut[] {
  ANNOTATED.lastIndex = 0;
  const matches: { surface: string; hanja: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = ANNOTATED.exec(sentence)) !== null) {
    const [whole, surface, hanja] = m as unknown as [string, string, string];
    // 음절 수가 같아야 한글 한 글자 ↔ 한자 한 글자로 대응한다.
    // `서울(京)`처럼 안 맞는 것은 병기가 아니라 설명이다.
    if (surface.length !== hanja.length) continue;
    // 한 글자짜리는 조사·어미에 붙은 우연한 괄호가 많아 신호 대 잡음이 나쁘다.
    if (surface.length < 2) continue;
    matches.push({ surface, hanja, start: m.index, end: m.index + whole.length });
  }
  if (matches.length === 0) return [];

  // 병기를 전부 지운 문장을 만들면서 각 표기의 새 위치를 계산한다.
  let plain = '';
  let cursor = 0;
  const positions: { surface: string; hanja: string; begin: number }[] = [];
  for (const match of matches) {
    plain += sentence.slice(cursor, match.start);
    positions.push({ surface: match.surface, hanja: match.hanja, begin: plain.length });
    plain += match.surface; // 괄호와 한자를 버리고 한글만 남긴다
    cursor = match.end;
  }
  plain += sentence.slice(cursor);
  plain = plain.replace(/\s+/g, ' ').trim();

  // 공백 정리로 위치가 밀렸을 수 있으니 실제 문자열로 다시 확인한다.
  return positions
    .map(({ surface, hanja, begin }) => {
      const at = plain.indexOf(surface, Math.max(0, begin - 4));
      if (at < 0) return null;
      return {
        sentence: plain,
        surface,
        hanja,
        begin: at,
        end: at + surface.length,
        domain,
        source,
      } satisfies GoldenOut;
    })
    .filter((x): x is GoldenOut => x !== null)
    .filter((x) => x.sentence.slice(x.begin, x.end) === x.surface)
    // 마크업 찌꺼기가 남은 문장은 문맥으로 못 쓴다
    .filter((x) => !/[{}[\]|<>]/.test(x.sentence))
    // 너무 짧거나 긴 문장은 문맥으로서 값이 없거나 문장 분할이 실패한 것이다
    .filter((x) => x.sentence.length >= 10 && x.sentence.length <= 400);
}

/**
 * 한자 → 그 한자가 갖는 음들.
 *
 * **왜 필요한가.** 음절 수만 맞으면 병기로 보는 규칙에는 구멍이 있다. `마춤법(綴字法)`은
 * 3음절 대 3자로 통과하지만 綴은 '철'이지 '마'가 아니다 — 병기가 아니라 옛말과 한자어를
 * 나란히 적은 것이다. 이런 것이 섞이면 골든셋이 오염되고, 오염된 골든셋으로 잰 숫자는
 * 없느니만 못하다.
 *
 * ⚠️ **표제어 사전으로 이 판정을 하면 안 된다.** 처음에 1글자 표제어의 후보 목록으로
 * 역방향 표를 만들었는데, 그 목록은 화면에 띄울 만큼만 추린 것이라 완전하지 않다 —
 * `郞`은 '랑'으로 읽히지만 1글자 표제어 `랑`의 후보에 없다. 그 표로 재면 멀쩡한 병기가
 * 무더기로 버려지고, `原則`처럼 흔한 말이 "사전에 없다"로 잡힌다. 실제로 그렇게 나와
 * 숫자를 의심한 끝에 찾았다.
 *
 * 독음의 원본은 `data/source/hanja-readings.json`이다 (Unihan `kHangul` + 배정한자,
 * 8,976자). 이것이 "이 한자가 이 음으로 읽히는가"의 유일한 기준이다.
 */
function loadReadings(): Map<string, Set<string>> {
  const path = join(repoRoot(), 'data', 'source', 'hanja-readings.json');
  if (!existsSync(path)) {
    throw new Error(
      `독음표가 없다: ${path}\n` +
        `만들려면: pnpm --filter @jieum/dict-builder build-readings`,
    );
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string[]>;
  return new Map(Object.entries(raw).map(([hanja, list]) => [hanja, new Set(list)]));
}

type Verdict = 'ok' | 'mismatch' | 'unknown';

/**
 * 병기가 음-한자 대응인지 판정한다.
 *
 * `unknown`은 "틀렸다"가 아니라 **독음표에 없는 한자**라는 뜻이다. 희귀자나 이체자가
 * 여기 걸리므로 버리지 않고 따로 모은다.
 */
export function verify(
  surface: string,
  hanja: string,
  index: Map<string, Set<string>>,
): Verdict {
  let sawUnknown = false;
  for (let i = 0; i < surface.length; i++) {
    const readings = index.get(hanja[i]!);
    if (!readings) {
      sawUnknown = true;
      continue;
    }
    if (!readings.has(surface[i]!)) return 'mismatch';
  }
  return sawUnknown ? 'unknown' : 'ok';
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

async function main() {
  const argv = process.argv.slice(2);
  let source = '';
  let domain = 'wiki';
  let out = '';
  let limit = Infinity;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') source = argv[++i]!;
    else if (argv[i] === '--domain') domain = argv[++i]!;
    else if (argv[i] === '--out') out = argv[++i]!;
    else if (argv[i] === '--limit') limit = Number(argv[++i]);
  }
  if (!source) {
    console.error('사용: build-golden --source <덤프.xml.bz2> [--domain 이름] [--out 경로]');
    process.exit(2);
  }
  source = resolve(source);
  if (!existsSync(source)) {
    console.error(`덤프를 찾지 못했다: ${source}`);
    process.exit(1);
  }
  if (!out) out = join(dirname(source), '..', 'eval', `golden-${domain}.jsonl`);
  out = resolve(out);
  mkdirSync(dirname(out), { recursive: true });

  const readings = loadReadings();
  process.stderr.write(`독음표 ${readings.size.toLocaleString()}자\n`);

  // bz2를 통째로 풀면 수 GB다. 스트림으로 흘려보낸다.
  const decompress = spawn('bzip2', ['-dc', source]);
  const rl = createInterface({ input: decompress.stdout, crlfDelay: Infinity });
  const writer = createWriteStream(out, { encoding: 'utf-8' });
  // 사전이 모르는 한자가 낀 것은 버리지 않고 사전 커버리지 후보로 따로 모은다.
  const unknownPath = out.replace(/\.jsonl$/, '-unknown.jsonl');
  const unknownWriter = createWriteStream(unknownPath, { encoding: 'utf-8' });
  let unknownCount = 0;
  let mismatchCount = 0;

  let title = '';
  let inText = false;
  let buffer: string[] = [];
  let written = 0;
  let pages = 0;

  const flushPage = () => {
    if (buffer.length === 0) return;
    const text = stripMarkup(buffer.join('\n'));
    buffer = [];
    for (const chunk of text.split(/\n+/)) {
      for (const sentence of chunk.split(SENTENCE_END)) {
        if (written >= limit) return;
        for (const item of extractFrom(sentence.trim(), domain, title)) {
          const verdict = verify(item.surface, item.hanja, readings);
          if (verdict === 'mismatch') {
            mismatchCount++;
            continue;
          }
          if (verdict === 'unknown') {
            unknownWriter.write(`${JSON.stringify(item)}\n`);
            unknownCount++;
            continue;
          }
          writer.write(`${JSON.stringify(item)}\n`);
          written++;
        }
      }
    }
  };

  for await (const line of rl) {
    if (written >= limit) break;

    const titleMatch = /<title>([^<]*)<\/title>/.exec(line);
    if (titleMatch) {
      title = titleMatch[1]!;
      continue;
    }
    // 사용자·토론·틀 문서는 본문이 아니다
    if (/^\s*<ns>/.test(line) && !/<ns>0<\/ns>/.test(line)) {
      title = '';
      continue;
    }

    if (line.includes('<text')) {
      inText = true;
      const start = line.indexOf('>', line.indexOf('<text'));
      if (start >= 0) buffer.push(line.slice(start + 1));
      if (line.includes('</text>')) {
        inText = false;
        buffer[buffer.length - 1] = buffer[buffer.length - 1]!.replace('</text>', '');
        if (title) flushPage();
        pages++;
      }
      continue;
    }
    if (inText) {
      if (line.includes('</text>')) {
        buffer.push(line.replace('</text>', ''));
        inText = false;
        if (title) flushPage();
        pages++;
        if (pages % 20_000 === 0) {
          process.stderr.write(`  ${pages.toLocaleString()}쪽 · ${written.toLocaleString()}건\n`);
        }
      } else {
        buffer.push(line);
      }
    }
  }

  writer.end();
  unknownWriter.end();
  decompress.kill();
  console.log(
    `${pages.toLocaleString()}쪽에서 ${written.toLocaleString()}건 추출 → ${out}\n` +
      `  사전이 모르는 한자가 낀 것 ${unknownCount.toLocaleString()}건 → ${unknownPath}\n` +
      `  음이 안 맞아 버린 것 ${mismatchCount.toLocaleString()}건 (병기가 아니라 동의어 대응)`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
