/**
 * 골든셋 읽기 — 한자한자의 `wsd-golden-v1`을 지음 조건으로 옮긴다.
 *
 * ## 왜 앞에서 자르는가
 *
 * 골든셋 한 줄은 문장 전체와 그 안의 위치(`begin`)를 준다. 그런데 **지음은 뒤 문맥을
 * 볼 수 없다** — 사용자가 지금 치고 있는 지점보다 뒤는 아직 존재하지 않는다. 문장을
 * 통째로 주고 채점하면 지음이 실제로는 갖지 못하는 정보로 재는 셈이고, 그 숫자는
 * 실사용을 예측하지 못한다.
 *
 * `sentence.slice(0, begin)`이 지음이 그 순간 실제로 보는 전부다.
 *
 * (한자한자는 완성된 텍스트를 변환하므로 뒤 문맥을 다 쓴다. 같은 골든셋으로 두 제품을
 *  재되 조건이 다르다 — 그 차이가 두 프로젝트를 가르는 지점이기도 하다.)
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** 골든셋 한 줄 (필요한 것만) */
export interface GoldenRow {
  sentence: string;
  /** 한글 표기 — 사용자가 치는 것 */
  surface: string;
  /** 정답 한자 */
  hanja: string;
  /** 문장 안 시작 위치 (문자 인덱스) */
  begin: number;
  end: number;
  domain?: string;
}

/** 채점에 쓰는 형태 */
export interface EvalCase {
  /** 지음이 그 순간 보는 앞 문맥 */
  context: string;
  /** 사용자가 친 한글 */
  input: string;
  /** 정답 한자 */
  expected: string;
  domain?: string;
}

/**
 * 한 줄을 채점 사례로 바꾼다. 쓸 수 없는 줄은 `null`.
 *
 * 거르는 것들:
 * - `begin`/`end`가 실제 문장과 안 맞는 줄 (원본 정렬 오류)
 * - 한자가 비었거나 한글이 섞인 줄
 * - 표기가 한 글자도 아닌 줄
 */
export function toCase(row: GoldenRow): EvalCase | null {
  const { sentence, surface, hanja, begin, end } = row;
  if (typeof sentence !== 'string' || typeof surface !== 'string') return null;
  if (typeof hanja !== 'string' || hanja.length === 0) return null;
  if (typeof begin !== 'number' || typeof end !== 'number') return null;
  if (begin < 0 || end > sentence.length || begin >= end) return null;

  // 위치가 실제 표기와 맞는지 확인한다. 안 맞으면 앞 문맥도 틀린 자리에서 잘린다.
  if (sentence.slice(begin, end) !== surface) return null;

  // 한글 음절만 입력으로 삼는다. 숫자·라틴 문자가 섞인 표기는 입력기 경로가 아니다.
  if (!/^[가-힣]+$/.test(surface)) return null;
  // 정답이 한자가 아닌 줄 (원본에 간혹 있다)
  if (/[가-힣]/.test(hanja)) return null;

  return {
    context: sentence.slice(0, begin),
    input: surface,
    expected: hanja,
    domain: row.domain,
  };
}

/**
 * 골든셋 파일에서 표본을 뽑는다.
 *
 * **결정적으로 뽑는다** — 같은 파일이면 언제 돌려도 같은 표본이 나온다. 회귀를 보려면
 * 표본이 흔들리면 안 되기 때문이다. 무작위 시드 대신 균등 간격으로 건너뛴다: 앞에서부터
 * 자르면 같은 문서의 연속된 문장만 걸려 편향된다.
 */
export async function loadSample(path: string, limit: number): Promise<EvalCase[]> {
  const rows = await readAll(path);
  const step = Math.max(1, Math.floor(rows.length / limit));

  const cases: EvalCase[] = [];
  for (let i = 0; i < rows.length && cases.length < limit; i += step) {
    const c = toCase(rows[i]!);
    if (c) cases.push(c);
  }
  return cases;
}

async function readAll(path: string): Promise<GoldenRow[]> {
  const rows: GoldenRow[] = [];
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as GoldenRow);
    } catch {
      // 깨진 줄은 조용히 건너뛴다 — 골든셋 자체를 고치는 것은 이 도구의 일이 아니다
    }
  }
  return rows;
}
