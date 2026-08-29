import type { Blocklist, DictLookup, PrefixMatch, Segment } from './types.js';

/** 조사 — 한자 변환하지 않는 문법 요소 */
const PARTICLES = new Set([
  // 격조사
  '이', '가', '을', '를', '의', '에', '에서', '에게', '한테', '께',
  '으로', '로', '와', '과', '보다',
  // 보조사
  '은', '는', '도', '만', '까지', '부터', '마저', '조차',
  '처럼', '같이', '대로', '밖에',
  '이나', '나', '라도', '이라도', '든지', '이든지',
  '야', '이야',
]);

/** 용언 어미 — 한자어 어근 뒤에 붙는 활용 어미 */
const VERB_SUFFIXES = new Set([
  '하다', '되다', '하여', '하고', '하면', '하는', '한', '할',
  '하게', '하지', '해서', '했다', '히', '해',
  '되어', '되고', '되면', '되는', '된', '될', '되게', '되지',
  '시키다', '받다', '짓다', '한다', '다',
]);

/** 목적격 조사 뒤에서 현대어 용언으로 쓰이는 형태 */
const OBJECT_PARTICLES = new Set(['을', '를']);
const OBJECT_DEPENDENT_FORMS = new Set(['위한']);

const GRAMMAR_SUFFIXES = [...PARTICLES, ...VERB_SUFFIXES]
  .sort((a, b) => b.length - a.length);

/** 아직 글자가 되지 않은 낱자 (호환 자모 영역) — 조합 중인 preedit가 여기 온다 */
const INCOMPLETE_JAMO = /^[ㄱ-ㆎ]+$/;

const HANGUL_EOJEOL = /^[가-힣]+$/;
const PUNCTUATION_OR_SYMBOL = /^[\p{P}\p{S}]+$/u;
const SENTENCE_TERMINATOR = /[.!?。！？]/u;

/**
 * 주어진 텍스트가 조사 또는 용언 어미인지 판별
 *
 * `convert()`(완성 텍스트 일괄 변환)와 `lookup()`(입력기 후보 조회)이 함께 쓴다.
 * 후자에서는 "표제어 뒤에 남은 꼬리가 문법 요소인가"를 묻는 데 쓰이며, 그 답이
 * 후보를 계속 보여 줄지를 가른다 (`engine.ts`의 lookup 참조).
 */
export function isParticleOrSuffix(text: string): boolean {
  return PARTICLES.has(text) || VERB_SUFFIXES.has(text);
}

/**
 * 표제어 뒤에 남은 꼬리가 **그 표제어에 딸린 것인가**
 *
 * 입력기 후보 조회(`lookup`)에서 "이미 지나간 표제어"를 걷어내는 기준이다.
 * 두 가지만 표제어를 살려 둔다.
 *
 * 1. **문법 꼬리** — `발전소를`의 `를`. 조사는 한자로 바뀌지 않고 한글로 남으므로
 *    표제어는 여전히 유효한 변환 대상이다. 이걸 살리지 않으면 조사가 붙는 순간
 *    후보가 사라지는데, 한국어에서 명사는 거의 항상 조사를 달고 나온다.
 * 2. **조합 중인 낱자** — `발전ㅅ`의 `ㅅ`. 아직 글자가 아니라 판단할 근거가 없다.
 *    여기서 숨기면 `발전`→`발전ㅅ`→`발전소`를 치는 동안 후보창이 깜빡인다.
 *
 * 나머지는 사용자가 그 표제어를 **지나쳐 간** 것이다 — `후보라고`의 `라고`,
 * `말러`의 `러`. 지나간 후보를 계속 띄우면 노이즈일 뿐 아니라, 그 상태에서
 * 숫자키를 누르면 지나간 후보가 확정될 수 있다 (`말러9번` → `妺러번`).
 */
export function isHeadwordTail(tail: string): boolean {
  // 꼬리가 없으면 표제어가 버퍼 전체다 — 가장 흔한 경우이고, 당연히 살린다
  if (!tail) return true;
  return isParticleOrSuffix(tail) || INCOMPLETE_JAMO.test(tail);
}

function findValidPrefixes(
  text: string,
  trie: DictLookup,
  blocklist: Blocklist,
): PrefixMatch[] {
  return trie.commonPrefixSearch(text).filter((prefix) => !blocklist.has(prefix.word));
}

function findExactValidMatch(
  text: string,
  trie: DictLookup,
  blocklist: Blocklist,
): PrefixMatch | null {
  const prefixes = findValidPrefixes(text, trie, blocklist);
  const exact = prefixes[prefixes.length - 1];
  return exact?.length === text.length ? exact : null;
}

function sharesHanja(fullMatch: PrefixMatch, stemMatch: PrefixMatch): boolean {
  const stemHanja = new Set(stemMatch.entries.map((entry) => entry.h));
  return fullMatch.entries.some((entry) => stemHanja.has(entry.h));
}

function looksLikeVerbEojeol(text: string): boolean {
  return GRAMMAR_SUFFIXES.some((suffix) => (
    VERB_SUFFIXES.has(suffix) && text.length > suffix.length && text.endsWith(suffix)
  ));
}

interface GrammarSplit {
  stem: string;
  suffix: string;
}

/**
 * 어절 끝 조사·어미를 안전하게 분리한다.
 *
 * 1음절 stem은 실제 사전에 거의 항상 존재하므로 분리 근거로 쓰지 않는다.
 * 완전한 표제어가 있으면 기본적으로 보존하고, 활용형이 stem과 같은 한자를
 * 공유하거나 뒤 어절이 용언형이라 조사 문맥이 분명할 때만 분리한다.
 */
function findTrailingGrammarSplit(
  text: string,
  nextEojeol: string | null,
  trie: DictLookup,
  blocklist: Blocklist,
): GrammarSplit | null {
  for (const suffix of GRAMMAR_SUFFIXES) {
    if (text.length <= suffix.length || !text.endsWith(suffix)) continue;

    const stem = text.slice(0, -suffix.length);
    // 반려된 1차 시도처럼 1음절 stem + 1음절 문법형을 허용하면
    // 국가·한자 같은 핵심 2음절 표제어를 파괴한다. 하다·한다처럼
    // 2음절 이상인 어미는 1음절 한자어 어근에도 안전하게 붙일 수 있다.
    const minimumStemLength = suffix.length === 1 ? 2 : 1;
    if (stem.length < minimumStemLength) continue;

    const stemMatch = findExactValidMatch(stem, trie, blocklist);
    if (!stemMatch) continue;

    const fullMatch = findExactValidMatch(text, trie, blocklist);
    if (!fullMatch) return { stem, suffix };

    if (VERB_SUFFIXES.has(suffix) && sharesHanja(fullMatch, stemMatch)) {
      return { stem, suffix };
    }

    if (PARTICLES.has(suffix) && nextEojeol && looksLikeVerbEojeol(nextEojeol)) {
      return { stem, suffix };
    }
  }

  return null;
}

function segmentEojeol(
  text: string,
  previousEnding: Segment | null,
  nextEojeol: string | null,
  trie: DictLookup,
  blocklist: Blocklist,
): Segment[] {
  if (
    previousEnding &&
    OBJECT_PARTICLES.has(previousEnding.text) &&
    OBJECT_DEPENDENT_FORMS.has(text)
  ) {
    return [{ text, type: 'native_korean', convertible: false }];
  }

  const grammarSplit = findTrailingGrammarSplit(text, nextEojeol, trie, blocklist);
  if (grammarSplit) {
    return [
      { text: grammarSplit.stem, type: 'hanja_candidate', convertible: true },
      { text: grammarSplit.suffix, type: 'particle', convertible: false },
    ];
  }

  const segments: Segment[] = [];
  let pos = 0;
  let hasConvertibleStem = false;

  while (pos < text.length) {
    const valid = findValidPrefixes(text.slice(pos), trie, blocklist);

    if (valid.length === 0) {
      const remainder = text.slice(pos);
      segments.push({
        text: remainder,
        type: hasConvertibleStem && isParticleOrSuffix(remainder)
          ? 'particle'
          : 'native_korean',
        convertible: false,
      });
      break;
    }

    const longest = valid[valid.length - 1]!;

    // 내린다처럼 1음절 한자 후보 뒤에 문법으로 설명되지 않는 한글 꼬리가
    // 붙으면 어절 전체를 고유어로 본다. 산에처럼 꼬리가 조사인 경우만
    // 계속 분할한다.
    //
    // 꼬리가 사전에 없는지로 판별하던 것을 조사 여부로 바꿨다. 1음절 한자
    // 5,978자가 사실상 모든 음절을 덮어서 — `린`은 隣, `라`는 羅, `간`은 間 —
    // "사전에 없는 꼬리"라는 조건이 영원히 거짓이었고, 이 가드는 죽어 있었다.
    // 사전을 넓힌 일이 그 사전을 지키는 가드를 무력화한 셈이다.
    if (pos === 0 && longest.length === 1 && longest.length < text.length) {
      const trailing = text.slice(longest.length);
      if (!PARTICLES.has(trailing)) {
        return [{ text, type: 'native_korean', convertible: false }];
      }
    }

    if (hasConvertibleStem && isParticleOrSuffix(longest.word)) {
      segments.push({ text: longest.word, type: 'particle', convertible: false });
    } else {
      segments.push({ text: longest.word, type: 'hanja_candidate', convertible: true });
      hasConvertibleStem = true;
    }
    pos += longest.length;
  }

  return segments;
}

/**
 * 텍스트를 한자 변환 가능한 세그먼트로 분할
 *
 * 전략: 어절 문맥을 보존하는 탐욕적 전방 매칭
 * 1. 공백 기준 어절과 앞뒤 어절 문맥을 확인
 * 2. 안전하게 판별되는 조사·어미를 먼저 분리
 * 3. 어절 내부에서는 가장 긴 사전 매칭을 채택
 * 4. 1음절 후보 뒤의 설명되지 않는 고유어 꼬리는 어절 전체로 보존
 */
export function segment(
  text: string,
  trie: DictLookup,
  blocklist: Blocklist,
): Segment[] {
  const segments: Segment[] = [];
  const tokens = text.match(/\s+|[가-힣]+|[^\s가-힣]+/g) ?? [];
  let previousEnding: Segment | null = null;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;

    if (/^\s+$/.test(token)) {
      segments.push({ text: token, type: 'whitespace', convertible: false });
      continue;
    }

    if (!HANGUL_EOJEOL.test(token)) {
      segments.push({ text: token, type: 'native_korean', convertible: false });
      if (!PUNCTUATION_OR_SYMBOL.test(token) || SENTENCE_TERMINATOR.test(token)) {
        previousEnding = null;
      }
      continue;
    }

    let nextEojeol: string | null = null;
    for (let nextIndex = index + 1; nextIndex < tokens.length; nextIndex++) {
      const nextToken = tokens[nextIndex]!;
      if (/^\s+$/.test(nextToken)) continue;
      if (HANGUL_EOJEOL.test(nextToken)) {
        nextEojeol = nextToken;
        break;
      }
      if (!PUNCTUATION_OR_SYMBOL.test(nextToken) || SENTENCE_TERMINATOR.test(nextToken)) break;
    }

    const eojeolSegments = segmentEojeol(
      token,
      previousEnding,
      nextEojeol,
      trie,
      blocklist,
    );
    segments.push(...eojeolSegments);
    previousEnding = eojeolSegments[eojeolSegments.length - 1] ?? null;
  }

  return segments;
}
