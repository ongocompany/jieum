/**
 * TipTap 네이티브 Surface Adapter
 *
 * generic contenteditable adapter는 DOM을 관찰하는데, ProseMirror는
 * IME 조합 중 DOM을 일부러 그대로 두므로 DOM 추측이 어긋난다
 * (조합 중 range.startContainer가 Element가 되어 selection offset이 null).
 *
 * 이 어댑터는 DOM을 추측하지 않고 ProseMirror 모델에 직접 질의한다:
 * - 캐럿/선택: editor.state.selection
 * - 블록 경계 인식 텍스트: $from.parent.textBetween(...) — 이전 문단이 새지 않음
 * - 텍스트 치환: ProseMirror 트랜잭션 (DOM 직접 조작 금지)
 *
 * 조합 중인 텍스트는 아직 모델에 없으므로 여기서 다루지 않는다 —
 * controller가 composition 이벤트의 compositionText와 병합한다.
 */

import type { Editor } from '@tiptap/core';
import {
  extractTrailingHangul,
  findTrailingBufferRange,
  type SurfaceAdapter,
} from '@jieum/browser';

/**
 * TipTap Editor에 붙는 SurfaceAdapter 생성
 */
export function createTiptapAdapter(editor: Editor): SurfaceAdapter {
  /**
   * 커서가 속한 텍스트블록 기준 정보
   *
   * 텍스트블록 밖(표 구조 노드 등)이면 null.
   * 반환되는 text는 블록 시작~$from 사이 텍스트뿐이라 블록 경계를 넘지 않는다.
   *
   * 선택이 접혀 있는지(empty)는 보지 않는다. 한글 IME는 받침을 붙일 때 직전
   * 음절을 선택 상태로 잡고 교체하므로 조합 중 selection은 정상적으로
   * non-empty가 된다. 여기서 포기하면 "미"+"국" 병합이 "국"으로 무너진다.
   * $from은 선택의 시작점이라 그 경우에도 확정 텍스트의 끝을 가리킨다.
   */
  function caretBlock(): { blockStart: number; text: string } | null {
    const { $from } = editor.state.selection;
    if (!$from.parent.isTextblock) return null;

    const offset = $from.parentOffset;
    return {
      // 블록 내 텍스트 오프셋 → 문서 위치 변환 기준점
      blockStart: $from.start(),
      // leafText를 지정해 이미지 등 리프 노드도 1글자로 세어 오프셋 정합성 유지
      text: $from.parent.textBetween(0, offset, undefined, '\ufffc'),
    };
  }

  return {
    getTrailingHangulBuffer(): string {
      const caret = caretBlock();
      if (!caret) return '';
      return extractTrailingHangul(caret.text);
    },

    /**
     * 연어 판별용 앞 문맥
     *
     * caretBlock().text가 이미 블록 시작~커서 사이 전체다. 지금까지는
     * 여기서 한글 버퍼만 뽑고 나머지를 버렸는데, 그 나머지가 문맥이다.
     * 블록(문단) 경계를 넘지 않는 것은 오히려 맞다 — 앞 문단의 화제가
     * 지금 문장에 우연히 걸리는 것을 막는다.
     */
    getPrecedingText(): string {
      return caretBlock()?.text ?? '';
    },

    getAnchorRect(): DOMRect {
      const pos = editor.state.selection.from;
      try {
        const coords = editor.view.coordsAtPos(pos);
        return new DOMRect(
          coords.left,
          coords.top,
          coords.right - coords.left,
          coords.bottom - coords.top,
        );
      } catch {
        // 레이아웃이 없는 환경(숨김 탭, jsdom 등)에서는 에디터 영역으로 대체
        return editor.view.dom.getBoundingClientRect();
      }
    },

    replaceTrailingBuffer(buffer: string, replacement: string): void {
      const caret = caretBlock();
      if (!caret) return;

      const range = findTrailingBufferRange(caret.text, caret.text.length, buffer);
      if (!range) return;

      // insertContentAt은 문자열을 블록으로 파싱해 문단이 쪼개질 수 있다.
      // 순수 텍스트 치환은 tr.insertText로 (커서도 치환 텍스트 뒤로 이동)
      const { state, view } = editor;
      view.dispatch(
        state.tr.insertText(
          replacement,
          caret.blockStart + range.start,
          caret.blockStart + range.end,
        ),
      );
    },

    removeCharBeforeCursor(): void {
      const { $from, empty, from } = editor.state.selection;
      // 블록 시작에서는 지우지 않는다 — 이전 블록/구조를 침범하지 않도록
      if (!empty || $from.parentOffset === 0) return;
      editor.commands.deleteRange({ from: from - 1, to: from });
    },
  };
}
