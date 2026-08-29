// @vitest-environment jsdom
/**
 * TipTap 네이티브 Surface Adapter 회귀 테스트
 *
 * 커버하는 결함 (2026-08-01 티켓):
 * 1. IME 조합 중 DOM selection이 Element를 가리켜 버퍼가 ""로 붕괴
 *    → 모델(editor.state.selection)에 직접 질의하므로 캐럿 이동 없이도 전체 버퍼 반환
 * 2. textContent 기반 읽기로 이전 문단 텍스트가 버퍼에 새어나옴
 *    → 현재 텍스트블록 낸 텍스트만 사용
 * 3. 잘못된 버퍼 비교로 숫자가 문서에 잔존
 *    → 치환/삭제가 ProseMirror 트랜잭션으로 정확히 수행
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { createTiptapAdapter } from '../jieum-adapter.js';

let editor: Editor | null = null;

function createEditor(content: string): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit],
    content,
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('createTiptapAdapter', () => {
  describe('getTrailingHangulBuffer', () => {
    it('커서 앞의 연속 한글 전체를 반환한다 (미국 → "미국")', () => {
      const ed = createEditor('<p>미국</p>');
      ed.commands.setTextSelection(3); // "미국" 뒤
      const adapter = createTiptapAdapter(ed);
      expect(adapter.getTrailingHangulBuffer()).toBe('미국');
    });

    it('이전 문단 텍스트가 버퍼에 새지 않는다', () => {
      const ed = createEditor('<p>이전문단</p><p>국</p>');
      // 첫 문단이 pos 0~6, 두 번째 문단 "국" 뒤 = 8
      ed.commands.setTextSelection(8);
      const adapter = createTiptapAdapter(ed);
      expect(adapter.getTrailingHangulBuffer()).toBe('국');
    });

    it('커서가 단어 중간에 있으면 커서 앞까지만 읽는다', () => {
      const ed = createEditor('<p>미국</p>');
      ed.commands.setTextSelection(2); // "미" 뒤
      const adapter = createTiptapAdapter(ed);
      expect(adapter.getTrailingHangulBuffer()).toBe('미');
    });

    it('한글 앞의 영문은 버퍼에 포함되지 않는다', () => {
      const ed = createEditor('<p>abc미국</p>');
      ed.commands.setTextSelection(6); // 끝
      const adapter = createTiptapAdapter(ed);
      expect(adapter.getTrailingHangulBuffer()).toBe('미국');
    });

    it('선택 영역이 있으면 빈 문자열을 반환한다', () => {
      const ed = createEditor('<p>미국</p>');
      ed.commands.setTextSelection({ from: 1, to: 3 });
      const adapter = createTiptapAdapter(ed);
      expect(adapter.getTrailingHangulBuffer()).toBe('');
    });
  });

  describe('replaceTrailingBuffer', () => {
    it('버퍼를 한자로 치환하고 커서를 치환 텍스트 뒤에 둔다', () => {
      const ed = createEditor('<p>미국</p>');
      ed.commands.setTextSelection(3);
      const adapter = createTiptapAdapter(ed);

      adapter.replaceTrailingBuffer('미국', '美國');

      expect(ed.getText()).toBe('美國');
      expect(ed.state.selection.from).toBe(3); // "美國" 뒤
    });

    it('부분 변환(선택 단어만 한자로)도 정확히 치환한다', () => {
      const ed = createEditor('<p>발전</p>');
      ed.commands.setTextSelection(3);
      const adapter = createTiptapAdapter(ed);

      // 버퍼 "발전", 선택 "발"→"發" → "發전"
      adapter.replaceTrailingBuffer('발전', '發전');

      expect(ed.getText()).toBe('發전');
    });

    it('이전 문단을 건드리지 않고 현재 문단만 치환한다', () => {
      const ed = createEditor('<p>미국</p><p>미국</p>');
      ed.commands.setTextSelection(7); // 두 번째 "미국" 뒤
      const adapter = createTiptapAdapter(ed);

      adapter.replaceTrailingBuffer('미국', '美國');

      // v3 getText() 기본 blockSeparator는 '\n\n' — 명시해서 단일 개행으로 비교
      expect(ed.getText({ blockSeparator: '\n' })).toBe('미국\n美國');
    });

    it('버퍼가 일치하지 않으면 아무 것도 바꾸지 않는다', () => {
      const ed = createEditor('<p>미국</p>');
      ed.commands.setTextSelection(3);
      const adapter = createTiptapAdapter(ed);

      adapter.replaceTrailingBuffer('없는버퍼', '美國');

      expect(ed.getText()).toBe('미국');
    });
  });

  describe('removeCharBeforeCursor', () => {
    it('커서 앞 한 글자(조합 중 삽입된 숫자)를 제거한다', () => {
      const ed = createEditor('<p>미국1</p>');
      ed.commands.setTextSelection(4); // 끝
      const adapter = createTiptapAdapter(ed);

      adapter.removeCharBeforeCursor();

      expect(ed.getText()).toBe('미국');
    });

    it('블록 시작에서는 지우지 않는다 (이전 블록 침범 방지)', () => {
      const ed = createEditor('<p>미국</p><p>1</p>');
      ed.commands.setTextSelection(5); // 두 번째 문단 "1" 앞 (블록 시작)
      const adapter = createTiptapAdapter(ed);

      adapter.removeCharBeforeCursor();

      expect(ed.getText({ blockSeparator: '\n' })).toBe('미국\n1');
    });
  });

  describe('getAnchorRect', () => {
    it('캐럿 위치의 DOMRect를 반환한다', () => {
      const ed = createEditor('<p>미국</p>');
      ed.commands.setTextSelection(3);
      const adapter = createTiptapAdapter(ed);

      const rect = adapter.getAnchorRect();
      expect(typeof rect.left).toBe('number');
      expect(typeof rect.top).toBe('number');
      expect(typeof rect.height).toBe('number');
    });
  });

  /**
   * 회귀 가드 — selection이 접혀 있다는 전제를 다시 넣지 말 것.
   *
   * 한글 IME는 받침을 붙일 때 직전 음절을 선택 상태로 잡고 교체한다.
   * 따라서 조합 중 selection이 non-empty인 것은 오류가 아니라 정상이다.
   * 초기 구현은 `if (!empty) return null`로 방어했는데, 그 결과 "미"를 확정하고
   * "국"을 조합하는 순간 버퍼가 ""로 붕괴해 후보가 "국" 하나로 조회됐다.
   *
   * 실측(2026-08-01, Chrome + macOS 한글 IME):
   *   갱신 조합="구" 모델="미" empty=true  off=1  → 정상
   *   갱신 조합="국" 모델=""   empty=false off=1  → 붕괴, 가드를 무시하면 "미"
   */
  describe('조합 중 selection이 접혀 있지 않을 때', () => {
    it('선택 영역이 있어도 $from 앞의 확정 텍스트를 반환한다', () => {
      const ed = createEditor('<p>미구</p>');
      // IME가 "구"를 선택해 "국"으로 교체하려는 상태
      ed.commands.setTextSelection({ from: 2, to: 3 });
      const adapter = createTiptapAdapter(ed);

      expect(adapter.getTrailingHangulBuffer()).toBe('미');
    });

    it('선택이 여러 글자에 걸쳐 있어도 시작점 기준으로 읽는다', () => {
      const ed = createEditor('<p>대한민국</p>');
      ed.commands.setTextSelection({ from: 3, to: 5 }); // "민국" 선택
      const adapter = createTiptapAdapter(ed);

      expect(adapter.getTrailingHangulBuffer()).toBe('대한');
    });

    it('선택이 있어도 이전 문단 텍스트는 새지 않는다', () => {
      const ed = createEditor('<p>이전문단</p><p>미구</p>');
      ed.commands.setTextSelection({ from: 8, to: 9 });
      const adapter = createTiptapAdapter(ed);

      expect(adapter.getTrailingHangulBuffer()).toBe('미');
    });
  });
});
