/**
 * 한글 입력 버퍼 유틸리티
 *
 * - 완성형 한글 음절(U+AC00~U+D7A3)만 추출
 * - 커서 앞의 연속 한글을 변환 버퍼로 관리
 * - 조합 중 텍스트와 확정 텍스트를 병합
 */

/** 완성형 한글 음절 정규식 */
const HANGUL_SYLLABLE = /[\uAC00-\uD7A3]/;
const TRAILING_HANGUL = /[\uAC00-\uD7A3]+$/;

/** 완성형 한글 음절만 남기고 나머지 제거 */
export function sanitizeHangul(value: string): string {
  return [...value].filter((ch) => HANGUL_SYLLABLE.test(ch)).join('');
}

/**
 * 텍스트에서 커서 위치 앞의 연속 한글 추출
 *
 * extractTrailingHangul("발전", 2) → "발전"
 * extractTrailingHangul("발전 ", 3) → ""  (공백으로 끊김)
 * extractTrailingHangul("hello발전소", 8) → "발전소"
 */
export function extractTrailingHangul(text: string, cursor?: number): string {
  const safeCursor = cursor ?? text.length;
  const segment = text.slice(0, safeCursor);
  const match = segment.match(TRAILING_HANGUL);
  return match ? match[0] : '';
}

/**
 * DOM 버퍼와 조합 중 텍스트를 병합
 *
 * mergeTrailingBuffer("발전", "소") → "발전소"
 * mergeTrailingBuffer("발전소", "소") → "발전소"  (이미 포함)
 * mergeTrailingBuffer("발전", "") → "발전"
 */
export function mergeTrailingBuffer(
  baseBuffer: string,
  compositionBuffer: string,
): string {
  const base = sanitizeHangul(baseBuffer);
  const comp = sanitizeHangul(compositionBuffer);

  if (!comp) return base;
  if (base.endsWith(comp)) return base;
  return base + comp;
}

/** 치환 범위 */
export interface BufferRange {
  start: number;
  end: number;
}

/**
 * 커서 앞에서 버퍼에 해당하는 텍스트 범위를 찾음
 *
 * findTrailingBufferRange("발전", 2, "발전") → {start:0, end:2}
 * findTrailingBufferRange("발전 ", 3, "발전") → {start:0, end:2}  (공백 건너뜀)
 * findTrailingBufferRange("발전소", 3, "발전") → null  (매칭 안됨)
 */
export function findTrailingBufferRange(
  text: string,
  cursor: number,
  buffer: string,
): BufferRange | null {
  if (!buffer) return null;

  const safeCursor = cursor ?? text.length;
  const segment = text.slice(0, safeCursor);

  // Case 1: 직접 매칭
  if (segment.endsWith(buffer)) {
    return { start: safeCursor - buffer.length, end: safeCursor };
  }

  // Case 2: 후행 공백 건너뛰고 매칭
  const trailingSpace = segment.match(/\s+$/)?.[0] ?? '';
  if (!trailingSpace) return null;

  const beforeSpace = safeCursor - trailingSpace.length;
  if (segment.slice(0, beforeSpace).endsWith(buffer)) {
    return { start: beforeSpace - buffer.length, end: beforeSpace };
  }

  return null;
}
