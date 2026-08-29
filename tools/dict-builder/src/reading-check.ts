/**
 * 사전 후보 한자의 독음 검증
 *
 * 표제어 '병기'의 후보가 竝記면 竝=병, 記=기로 읽혀야 한다. 안 읽히면 그 한자는
 * 이 표제어의 표기가 아니다 — 골라서 치환하면 엉뚱한 글자가 들어간다.
 *
 * 우리말샘 유의어/반의어 관계가 `hanja-words-extracted.csv`의 한자 필드로 새어
 * 들어온 것이 근본 원인이다(지음 빌드 결함이 아니다). 예: 권외(圈外·權外)의
 * 후보 목록에 반의어 圈內·權內가 섞여 있다.
 *
 * 조사 경위와 분류별 실측치는 `docs/ticket/2026-08-01-dict-reading-validation.md`에
 * 있다. 각 단계는 이전 판이 틀렸던 지점에서 나왔다:
 *
 *   1. 두음법칙 — 독음표는 본음만 싣는다(鹵=로, 郎=랑). 이 처리가 없으면
 *      '노부반장→鹵簿半仗', '뇌호내해→瀨戶內海' 같은 정상 항목이 오매핑으로
 *      잡힌다. 처음엔 단어 맨 앞(어두)에서만 적용했는데, '가낭청(假郎廳)'
 *      같은 사례가 그것으로는 안 잡혔다 — 郎廳(낭청)이 그 자체로 독립된
 *      단어라 합성어 내부 경계에서도 두음법칙이 적용된다. 그 경계를 사전
 *      정보 없이 알 수 없으므로 모든 위치에서 변형을 인정한다(자세한 사유는
 *      아래 canRead 주석). 대가로 '세뇌→洗罍'(罍=뢰→뇌, 진짜 독음은 세뢰)
 *      같은 극소수 우연한 오독이 남지만, 조선 관직명·전공 의학용어·고전
 *      문헌 표제어 205개가 통째로 사라지는 것보다 낫다.
 *   2. 표제어의 공백·구분자를 떼고 비교한다('신년 음악회'→'신년음악회').
 *   3. 용언 어미를 떼고 어근과 비교한다('쾌적하다'→'쾌적'). 꼬리 분포로 확인—
 *      '하다' 22,946 · '히' 1,365 · '되다' 33이 '짧음'으로 보이던 것의 88%였다.
 *   4. 다음향자는 모든 독음을 인정한다(金=금/김, 樂=낙/락/악/요).
 *   5. 독음표에 없는 글자가 하나라도 있으면 unknown — 데이터 부족으로 지우지
 *      않는다.
 */

/** 문자 → 가능한 모든 독음 */
export type ReadingTable = Map<string, Set<string>>;

export type ReadingClass =
  | 'ok'
  | 'unknown'
  | 'repeat'
  | 'truncated'
  | 'extended'
  | 'partial'
  | 'unrelated';

/**
 * 한자어 어근 뒤에 붙는 것들 — 이만큼은 한글로 남는 게 정상이다.
 * boundary.ts의 VERB_SUFFIXES와 같은 자리이고, 실제 꼬리 분포로 확인했다.
 *
 * audit2.py의 SUFFIXES와 정확히 같은 목록·같은 정렬(길이 내림차순, 동순위는
 * 원 순서 유지)이어야 한다 — 정렬 결과가 forms[] 배열의 순서를 결정하고,
 * 그 순서가 판정(특히 truncated/extended 판정에 쓰는 forms[-1])에 영향을 준다.
 */
const SUFFIX_LIST = [
  '하다', '되다', '히', '이', '스럽다', '롭다', '답다', '시키다', '당하다', '받다',
  '지다', '하기', '되기', '거리다', '대다', '스러이', '로이',
];
const SUFFIXES = [...SUFFIX_LIST].sort((a, b) => b.length - a.length);

// 한글 음절 자모 분해 상수 (초성 인덱스: ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ)
const CHO_N = 2;
const CHO_R = 5;
const CHO_IEUNG = 11;
// 중성 인덱스 중 ㅑㅒㅕㅖㅛㅠㅣ — 이 앞에서 ㄹ·ㄴ이 ㅇ이 된다
const Y_JUNG = new Set([2, 3, 6, 7, 12, 17, 20]);
const HANGUL_BASE = 0xac00;
const HANGUL_COUNT = 11172; // 19 초성 * 21 중성 * 28 종성

/**
 * 이 음절이 두음법칙으로 취할 수 있는 변형들(자기 자신 포함).
 *
 * 초성 ㄹ은 ㅑㅒㅕㅖㅛㅠㅣ 앞에서 ㅇ, 그 외에는 ㄴ이 된다.
 * 초성 ㄴ은 같은 모음들 앞에서 ㅇ이 된다.
 *
 * 이름은 "initial"(어두)이지만 호출부(canRead)는 모든 위치에서 이 변형을
 * 인정한다 — 두음법칙은 단어 전체의 첫머리뿐 아니라 합성어 내부 경계에서도
 * 발음이 바뀌기 때문이다(郎廳=낭청, 郎 자체 본음은 랑). 그 경계를 형태소
 * 분석 없이 알 수 없어 위치를 가리지 않는다.
 */
function initialVariants(syl: string): Set<string> {
  const code = syl.codePointAt(0)! - HANGUL_BASE;
  if (code < 0 || code >= HANGUL_COUNT) return new Set([syl]);

  const cho = Math.floor(code / 588);
  const rest = code % 588;
  const jung = Math.floor(rest / 28);

  let next: number;
  if (cho === CHO_R) {
    next = Y_JUNG.has(jung) ? CHO_IEUNG : CHO_N;
  } else if (cho === CHO_N && Y_JUNG.has(jung)) {
    next = CHO_IEUNG;
  } else {
    return new Set([syl]);
  }
  return new Set([syl, String.fromCodePoint(HANGUL_BASE + next * 588 + rest)]);
}

/**
 * 한자 한 글자가 음절 syl로 읽히는가.
 *
 * 두음법칙 변형은 위치를 가리지 않고 인정한다. 처음엔 어두(index 0)에서만
 * 봤는데 '가낭청(假郎廳)'에서 틀렸다 — 郎(본음 랑)이 word[1]='낭'으로 읽히는
 * 건 郎廳이 그 자체로 독립된 단어라 내부 경계에서 두음법칙이 다시 적용되기
 * 때문이다. 겸낭청·강직성연축(攣=련→연)·애인여기(鄰=린→인)도 같은 구조다.
 * 합성어 경계를 형태소 분석 없이 찾을 방법이 없어, 모든 위치에서 변형을
 * 인정하는 쪽을 택했다 — 대가로 세뇌(洗罍의 罍=뢰→뇌를 우연히 통과시킴,
 * 실제로는 洗腦가 맞음) 같은 극소수 오탐이 남지만, 전공 어휘 표제어 205개가
 * 통째로 사라지는 손해가 훨씬 크다.
 */
function canRead(ch: string, syl: string, readings: ReadingTable): boolean {
  const rs = readings.get(ch);
  if (!rs || rs.size === 0) return false;
  if (rs.has(syl)) return true;
  for (const r of rs) {
    if (initialVariants(r).has(syl)) return true;
  }
  return false;
}

/** hanja의 각 글자가 word의 각 음절로 읽히는가 (길이가 같을 때만) */
function readsAs(hanja: string, word: string, readings: ReadingTable): boolean {
  const h = Array.from(hanja);
  const w = Array.from(word);
  if (h.length !== w.length) return false;
  for (let i = 0; i < h.length; i++) {
    if (!canRead(h[i]!, w[i]!, readings)) return false;
  }
  return true;
}

/** 한자 앞부분이 표제어 앞부분과 몇 글자까지 같은 음으로 읽히는가 */
function prefixLen(hanja: string, word: string, readings: ReadingTable): number {
  const h = Array.from(hanja);
  const w = Array.from(word);
  const max = Math.min(h.length, w.length);
  let n = 0;
  while (n < max && canRead(h[n]!, w[n]!, readings)) n++;
  return n;
}

/** 비교 대상이 되는 표제어 형태들 — 원형과 어미를 뗀 어근들 */
function stems(word: string): string[] {
  const base = word.replaceAll(' ', '').replaceAll('-', '').replaceAll('·', '');
  const out = [base];
  for (const s of SUFFIXES) {
    if (base.endsWith(s) && base.length > s.length) {
      out.push(base.slice(0, base.length - s.length));
    }
  }
  return out;
}

interface Evaluation {
  kind: ReadingClass;
  pieces: string[] | null;
}

function evaluate(word: string, hanja: string, readings: ReadingTable): Evaluation {
  const forms = stems(word);

  if (forms.some((f) => readsAs(hanja, f, readings))) {
    return { kind: 'ok', pieces: null };
  }

  const hChars = Array.from(hanja);
  if (hChars.some((ch) => !readings.has(ch))) {
    return { kind: 'unknown', pieces: null };
  }

  // 이형태 이어붙임 — 한자를 어근 길이로 등분했을 때 모든 조각이 읽히는가
  for (const f of forms) {
    if (!f) continue;
    const fLen = Array.from(f).length;
    if (fLen === 0 || hChars.length % fLen !== 0) continue;
    const k = hChars.length / fLen;
    if (k < 2) continue;

    const pieces: string[] = [];
    for (let i = 0; i < k; i++) {
      pieces.push(hChars.slice(i * fLen, (i + 1) * fLen).join(''));
    }
    if (pieces.every((p) => readsAs(p, f, readings))) {
      return { kind: 'repeat', pieces };
    }
  }

  const lastForm = forms[forms.length - 1]!;
  const lastFormLen = Array.from(lastForm).length;
  const pre = Math.max(...forms.map((f) => prefixLen(hanja, f, readings)));
  const hLen = hChars.length;

  let kind: ReadingClass;
  if (hLen < lastFormLen && pre === hLen) {
    kind = 'truncated';
  } else if (hLen > lastFormLen && pre === lastFormLen) {
    kind = 'extended';
  } else if (pre > 0) {
    kind = 'partial';
  } else {
    kind = 'unrelated';
  }
  return { kind, pieces: null };
}

/** `data/source/hanja-readings.json`(문자 → 독음 배열)을 조회 구조로 변환 */
export function loadReadings(json: Record<string, string[]>): ReadingTable {
  const table: ReadingTable = new Map();
  for (const [ch, list] of Object.entries(json)) {
    table.set(ch, new Set(list));
  }
  return table;
}

/** 표제어(word)에 대해 후보 한자(hanja)가 어떤 부류인지 판정한다 */
export function classify(word: string, hanja: string, readings: ReadingTable): ReadingClass {
  return evaluate(word, hanja, readings).kind;
}

/** kind가 'repeat'일 때만 조각(예: 竝記倂記 → [竝記, 倂記])을 반환, 그 외 null */
export function splitVariant(word: string, hanja: string, readings: ReadingTable): string[] | null {
  return evaluate(word, hanja, readings).pieces;
}
