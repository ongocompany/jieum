/**
 * 연어(collocation) 규칙 추출
 *
 * 한자한자가 쌓아온 문맥 판별 규칙을 지음 빌드 입력으로 옮긴다.
 * 기획서 1번 차별점인 "문맥 단위 판별"의 실체이자, 지음이 3.5개월 멈춰 있는
 * 동안 연결되지 않은 최대 자산이다.
 *
 * **한자한자와 쓰임이 다르다.** 한자한자는 완성된 문장을 자동 변환하므로
 * `resolveByCollocation`이 한자 하나를 확정해 돌려준다. 지음은 후보를
 * 제안하고 사용자가 고르므로 확정이 아니라 **순위 보너스**로 쓴다.
 * 문맥이 맞으면 위로 올리고, 안 맞아도 후보에서 빼지 않는다.
 *
 * 그리고 지음에는 **뒤 문맥이 없다** — 타이핑 중이라 아직 쓰이지 않았다.
 * 규칙의 `context`는 앞뒤 구분 없이 모아둔 것이라 절반은 닿지 않는다.
 * 그래도 손해는 없다. 앞에서 걸리면 순위가 오르고, 안 걸리면 지금과 같다.
 *
 * 원본은 타입 주석이 붙은 TypeScript 모듈이고 규칙 객체를 export 하지 않는다.
 * 정규식으로 긁으면 문자열 이스케이프·중첩에서 조용히 틀리므로, export만
 * 덧붙인 임시 모듈을 만들어 tsx가 직접 평가하게 한다.
 *
 * 사용법:
 *   pnpm --filter @jieum/dict-builder extract-collocation
 *   HANJAHANJA_DIR=/path/to/hanjahanja pnpm --filter @jieum/dict-builder extract-collocation
 *
 * 출력: data/source/generated/collocation.json
 *   { "표제어": [ { "h": "한자", "c": ["문맥어", ...] }, ... ] }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const HANJAHANJA_DIR =
  process.env['HANJAHANJA_DIR'] ?? join(homedir(), 'development/hanjahanja');
const SOURCE_PATH = join(HANJAHANJA_DIR, 'apps/mobile/lib/hanja/collocation.ts');
const OUT_DIR = resolve(import.meta.dirname, '../../../data/source/generated');
const OUT_PATH = join(OUT_DIR, 'collocation.json');

/** 원본의 규칙 객체 이름 — 뒤에 오는 것이 우선한다(원본 resolve 순서와 동일) */
const RULE_TABLES = ['CURATED_WSD_RULES', 'COLLOCATION_RULES'] as const;

interface SourceRule {
  hanja: string;
  context: string[];
}

/** 지음 빌드가 읽는 형태 — 키를 줄여 파일 크기를 아낀다 */
interface OutRule {
  h: string;
  c: string[];
}

/**
 * 원본 모듈을 평가해 규칙 표를 얻는다
 *
 * `const X = {...}`를 `export const X = {...}`로 바꾼 사본을 임시 파일로 쓰고
 * import 한다. 원본은 외부 import가 없는 자기완결 모듈이라 이대로 평가된다.
 */
async function loadRuleTables(): Promise<Record<string, Record<string, SourceRule[]>>> {
  let source = readFileSync(SOURCE_PATH, 'utf-8');

  for (const table of RULE_TABLES) {
    const declaration = `const ${table}`;
    if (!source.includes(declaration)) {
      throw new Error(`원본에서 ${table} 선언을 찾지 못했습니다: ${SOURCE_PATH}`);
    }
    source = source.replace(declaration, `export const ${table}`);
  }

  const tempPath = join(tmpdir(), `jieum-collocation-${process.pid}.ts`);
  writeFileSync(tempPath, source);
  try {
    return (await import(pathToFileURL(tempPath).href)) as Record<
      string,
      Record<string, SourceRule[]>
    >;
  } finally {
    rmSync(tempPath, { force: true });
  }
}

async function main(): Promise<void> {
  if (!existsSync(SOURCE_PATH)) {
    console.error(`[지음] 한자한자 연어규칙을 찾을 수 없습니다: ${SOURCE_PATH}`);
    console.error('       HANJAHANJA_DIR 환경변수로 위치를 지정할 수 있습니다.');
    process.exit(1);
  }

  const tables = await loadRuleTables();
  const merged: Record<string, OutRule[]> = {};

  for (const table of RULE_TABLES) {
    const rules = tables[table];
    if (!rules) continue;
    let words = 0;

    for (const [word, list] of Object.entries(rules)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      const bucket = (merged[word] ??= []);
      for (const rule of list) {
        if (!rule?.hanja || !Array.isArray(rule.context) || rule.context.length === 0) {
          continue;
        }
        // 같은 한자가 두 표에 다 있으면 문맥을 합친다 (앞 표가 우선 등록됨)
        const existing = bucket.find((r) => r.h === rule.hanja);
        if (existing) {
          for (const ctx of rule.context) {
            if (!existing.c.includes(ctx)) existing.c.push(ctx);
          }
        } else {
          bucket.push({ h: rule.hanja, c: [...new Set(rule.context)] });
        }
      }
      words++;
    }
    console.log(`   ${table.padEnd(20)} ${words.toLocaleString()}개 표제어`);
  }

  const words = Object.keys(merged).length;
  const ruleCount = Object.values(merged).reduce((s, list) => s + list.length, 0);
  const contextCount = Object.values(merged).reduce(
    (s, list) => s + list.reduce((n, r) => n + r.c.length, 0),
    0,
  );

  // 판별이 필요한 자리 = 한자 후보가 둘 이상인 표제어.
  // 하나뿐인 규칙은 문맥을 봐도 고를 것이 없으니 순위를 바꾸지 못한다.
  const decisive = Object.values(merged).filter((list) => list.length > 1).length;

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(merged));

  console.log(`\n   표제어: ${words.toLocaleString()}`);
  console.log(`   규칙: ${ruleCount.toLocaleString()} / 문맥어: ${contextCount.toLocaleString()}`);
  console.log(`   판별이 갈리는 표제어(후보 2개 이상): ${decisive.toLocaleString()}`);
  console.log(`\n   → ${OUT_PATH}`);
}

await main();
