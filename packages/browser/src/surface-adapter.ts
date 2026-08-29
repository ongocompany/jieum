/**
 * Surface Adapter — input/textarea/contenteditable 추상화
 *
 * 각 편집 가능한 요소 타입에 대해 동일한 인터페이스를 제공:
 * - getTrailingHangulBuffer(): 커서 앞 연속 한글 추출
 * - getAnchorRect(): 팝업 위치 기준점 (캐럿 좌표)
 * - replaceTrailingBuffer(): 버퍼 텍스트를 치환
 */

import { extractTrailingHangul, findTrailingBufferRange } from './buffer-utils.js';

/** 어댑터 공통 인터페이스 */
export interface SurfaceAdapter {
  /** 커서 앞의 연속 한글 버퍼 */
  getTrailingHangulBuffer(): string;
  /**
   * 커서 앞의 문맥 텍스트 (연어 판별용)
   *
   * 버퍼와 달리 한글 연속에서 끊지 않는다 — 문맥어는 앞 문장에 있고
   * 그 사이에 공백·부호·이미 변환된 한자가 끼어 있다.
   *
   * 지음에는 뒤 문맥이 없다. 타이핑 중이라 아직 쓰이지 않았으므로
   * 커서 앞만 돌려준다. 구현이 없으면 문맥 보너스 없이 동작한다.
   */
  getPrecedingText?(): string;
  /** 팝업 앵커 위치 (캐럿의 DOMRect) */
  getAnchorRect(): DOMRect;
  /** 버퍼 텍스트를 replacement로 치환 */
  replaceTrailingBuffer(buffer: string, replacement: string): void;
  /** 커서 바로 앞의 한 글자 제거 (조합 중 삽입된 숫자 제거용) */
  removeCharBeforeCursor(): void;
}

// ─── Input / Textarea ─────────────────────────────────────

class InputSurfaceAdapter implements SurfaceAdapter {
  constructor(private target: HTMLInputElement | HTMLTextAreaElement) {}

  getTrailingHangulBuffer(): string {
    const cursor = this.target.selectionStart ?? this.target.value.length;
    return extractTrailingHangul(this.target.value, cursor);
  }

  getPrecedingText(): string {
    const cursor = this.target.selectionStart ?? this.target.value.length;
    return this.target.value.slice(0, cursor);
  }

  getAnchorRect(): DOMRect {
    return measureTextControlCaretRect(this.target);
  }

  replaceTrailingBuffer(buffer: string, replacement: string): void {
    const cursor = this.target.selectionStart ?? this.target.value.length;
    const range = findTrailingBufferRange(this.target.value, cursor, buffer);
    if (!range) return;

    // 버퍼 끝 ~ 커서 사이의 공백 보존
    const preservedGap = this.target.value.slice(range.end, cursor);
    const before = this.target.value.slice(0, range.start);
    const after = this.target.value.slice(cursor);

    this.target.value = before + replacement + preservedGap + after;

    const nextCursor = range.start + replacement.length + preservedGap.length;
    this.target.setSelectionRange(nextCursor, nextCursor);

    dispatchSyntheticInput(this.target);
  }

  removeCharBeforeCursor(): void {
    const cursor = this.target.selectionStart ?? 0;
    if (cursor === 0) return;
    this.target.value =
      this.target.value.slice(0, cursor - 1) + this.target.value.slice(cursor);
    this.target.setSelectionRange(cursor - 1, cursor - 1);
  }
}

// ─── ContentEditable ──────────────────────────────────────

class ContentEditableSurfaceAdapter implements SurfaceAdapter {
  constructor(private target: HTMLElement) {}

  getTrailingHangulBuffer(): string {
    const offsets = getSelectionOffsets(this.target);
    if (!offsets || offsets.start !== offsets.end) return '';
    const text = this.target.textContent ?? '';
    return extractTrailingHangul(text, offsets.end);
  }

  getPrecedingText(): string {
    const offsets = getSelectionOffsets(this.target);
    if (!offsets) return '';
    return (this.target.textContent ?? '').slice(0, offsets.end);
  }

  getAnchorRect(): DOMRect {
    return getContentEditableCaretRect(this.target);
  }

  replaceTrailingBuffer(buffer: string, replacement: string): void {
    const offsets = getSelectionOffsets(this.target);
    if (!offsets || offsets.start !== offsets.end) return;

    const text = this.target.textContent ?? '';
    const rangeOffsets = findTrailingBufferRange(text, offsets.end, buffer);
    if (!rangeOffsets) return;

    const range = createRangeForOffsets(this.target, rangeOffsets.start, rangeOffsets.end);
    range.deleteContents();

    const textNode = this.target.ownerDocument.createTextNode(replacement);
    range.insertNode(textNode);

    // 커서를 치환 텍스트 뒤로 이동
    const nextOffset = offsets.end - buffer.length + replacement.length;
    const caretRange = createRangeForOffsets(this.target, nextOffset, nextOffset);
    const selection = this.target.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(caretRange);

    dispatchSyntheticInput(this.target);
  }

  removeCharBeforeCursor(): void {
    const offsets = getSelectionOffsets(this.target);
    if (!offsets || offsets.start !== offsets.end || offsets.start === 0) return;
    const range = createRangeForOffsets(this.target, offsets.start - 1, offsets.start);
    range.deleteContents();
  }
}

// ─── Factory ──────────────────────────────────────────────

export function createSurfaceAdapter(target: HTMLElement): SurfaceAdapter | null {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return new InputSurfaceAdapter(target);
  }
  if (target.isContentEditable) {
    return new ContentEditableSurfaceAdapter(target);
  }
  return null;
}

/** 편집 가능한 요소를 모두 찾음 */
export function findEditableTargets(root: HTMLElement | Document): HTMLElement[] {
  const container = root instanceof Document ? root.body : root;
  const results: HTMLElement[] = [];

  // input[type=text|search], textarea
  const inputs = container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input[type="text"], input[type="search"], input:not([type]), textarea',
  );
  for (const el of inputs) results.push(el);

  // contenteditable
  const editables = container.querySelectorAll<HTMLElement>('[contenteditable="true"]');
  for (const el of editables) results.push(el);

  return results;
}

// ─── 헬퍼: Input/Textarea 캐럿 좌표 측정 ─────────────────

/**
 * Mirror Div 기법으로 textarea/input의 캐럿 좌표를 측정
 */
function measureTextControlCaretRect(
  target: HTMLInputElement | HTMLTextAreaElement,
): DOMRect {
  const doc = target.ownerDocument;
  const win = doc.defaultView!;

  const mirror = doc.createElement('div');
  const style = win.getComputedStyle(target);

  // 대상 요소의 스타일을 미러에 복사
  const copyProps = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
    'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing',
    'textIndent', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'boxSizing', 'whiteSpace', 'wordWrap', 'overflowWrap',
  ] as const;

  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.overflow = 'hidden';
  mirror.style.width = `${target.offsetWidth}px`;

  for (const prop of copyProps) {
    mirror.style[prop as any] = style.getPropertyValue(
      prop.replace(/([A-Z])/g, '-$1').toLowerCase(),
    );
  }

  // 커서까지의 텍스트 + 마커
  const cursor = target.selectionStart ?? 0;
  const textBefore = target.value.slice(0, cursor);

  mirror.textContent = textBefore;
  const marker = doc.createElement('span');
  marker.textContent = '\u200b'; // zero-width space
  mirror.appendChild(marker);

  doc.body.appendChild(mirror);
  const markerRect = marker.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  doc.body.removeChild(mirror);

  // 미러 좌표를 target 기준으로 보정
  return new DOMRect(
    targetRect.left + (markerRect.left - mirrorRect.left),
    targetRect.top + (markerRect.top - mirrorRect.top),
    0,
    markerRect.height,
  );
}

// ─── 헬퍼: ContentEditable 캐럿 좌표 ─────────────────────

function getContentEditableCaretRect(target: HTMLElement): DOMRect {
  const selection = target.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return target.getBoundingClientRect();
  }

  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);

  const rects = range.getClientRects();
  if (rects.length > 0) {
    return rects[0]!;
  }

  return target.getBoundingClientRect();
}

// ─── 헬퍼: ContentEditable offset ↔ DOM 변환 ─────────────

interface SelectionOffsets {
  start: number;
  end: number;
}

function getSelectionOffsets(root: HTMLElement): SelectionOffsets | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;

  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let start: number | null = null;
  let end: number | null = null;
  let node = walker.nextNode();

  while (node) {
    const length = node.textContent?.length ?? 0;
    if (node === range.startContainer) start = offset + range.startOffset;
    if (node === range.endContainer) end = offset + range.endOffset;
    offset += length;
    node = walker.nextNode();
  }

  if (start === null || end === null) return null;
  return { start, end };
}

interface DomPoint {
  node: Node;
  offset: number;
}

function resolvePoint(root: HTMLElement, targetOffset: number): DomPoint {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let traversed = 0;
  let node = walker.nextNode();

  while (node) {
    const length = node.textContent?.length ?? 0;
    if (targetOffset <= traversed + length) {
      return { node, offset: Math.max(0, targetOffset - traversed) };
    }
    traversed += length;
    node = walker.nextNode();
  }

  return { node: root, offset: root.childNodes.length };
}

function createRangeForOffsets(
  root: HTMLElement,
  startOffset: number,
  endOffset: number,
): Range {
  const range = root.ownerDocument.createRange();
  const start = resolvePoint(root, startOffset);
  const end = resolvePoint(root, endOffset);
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

// ─── 공통 헬퍼 ───────────────────────────────────────────

function dispatchSyntheticInput(target: HTMLElement): void {
  target.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText' }),
  );
}
