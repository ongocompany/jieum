// @vitest-environment jsdom
/**
 * 자동 독음 루비 테스트
 *
 * 위치 계산이 핵심이다. commitPick은 버퍼 전체를 (한자 + 매칭되지 않은
 * 나머지 한글)로 치환하고 커서를 그 뒤로 보내므로, 커서에서 한자 길이만큼
 * 역산하면 나머지가 있을 때 엉뚱한 자리에 루비가 붙는다.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { Ruby } from '../ruby-ext.js';
import { attachAutoRuby } from '../auto-ruby.js';

let editor: Editor | null = null;

function createEditor(content: string): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, Ruby],
    content,
  });
  return editor;
}

/** 지음 컨트롤러가 확정 시 버블시키는 이벤트를 흉내낸다 */
function emitCommit(ed: Editor, word: string, hanja: string): void {
  ed.view.dom.dispatchEvent(
    new CustomEvent('jieum:commit', { bubbles: true, detail: { word, hanja } }),
  );
}

/** 문서에서 ruby mark가 걸린 구간과 그 독음을 뽑는다 */
function rubyRanges(ed: Editor): Array<{ text: string; annotation: string }> {
  const out: Array<{ text: string; annotation: string }> = [];
  ed.state.doc.descendants((node) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === 'ruby');
    if (mark) out.push({ text: node.text ?? '', annotation: mark.attrs['annotation'] });
  });
  return out;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('attachAutoRuby', () => {
  it('확정된 한자에 원래 독음을 단다', () => {
    const ed = createEditor('<p>閔</p>');
    ed.commands.setTextSelection(2); // "閔" 뒤
    attachAutoRuby(ed, () => true);

    emitCommit(ed, '민', '閔');

    expect(rubyRanges(ed)).toEqual([{ text: '閔', annotation: '민' }]);
  });

  it('매칭되지 않은 나머지 한글이 뒤에 있어도 한자에만 단다', () => {
    // 버퍼 "발전"에서 "발"만 매칭돼 "發전"이 된 상황 — 커서는 "전" 뒤에 있다
    const ed = createEditor('<p>發전</p>');
    ed.commands.setTextSelection(3);
    attachAutoRuby(ed, () => true);

    emitCommit(ed, '발', '發');

    // 커서에서 한자 길이만큼 역산하면 "전"에 루비가 붙는다
    expect(rubyRanges(ed)).toEqual([{ text: '發', annotation: '발' }]);
  });

  it('꺼져 있으면 아무것도 하지 않는다', () => {
    const ed = createEditor('<p>閔</p>');
    ed.commands.setTextSelection(2);
    attachAutoRuby(ed, () => false);

    emitCommit(ed, '민', '閔');

    expect(rubyRanges(ed)).toEqual([]);
  });

  it('루비를 단 뒤에도 커서가 제자리에 있다', () => {
    const ed = createEditor('<p>發전</p>');
    ed.commands.setTextSelection(3);
    attachAutoRuby(ed, () => true);

    emitCommit(ed, '발', '發');

    expect(ed.state.selection.from).toBe(3);
    expect(ed.state.selection.empty).toBe(true);
  });

  it('루비 뒤에 이어 친 글자에는 독음이 물려붙지 않는다', () => {
    const ed = createEditor('<p>閔</p>');
    ed.commands.setTextSelection(2);
    attachAutoRuby(ed, () => true);

    emitCommit(ed, '민', '閔');
    ed.commands.insertContent('철');

    expect(rubyRanges(ed)).toEqual([{ text: '閔', annotation: '민' }]);
    expect(ed.getText()).toBe('閔철');
  });

  it('detach 후에는 반응하지 않는다', () => {
    const ed = createEditor('<p>閔</p>');
    ed.commands.setTextSelection(2);
    const handle = attachAutoRuby(ed, () => true);
    handle.detach();

    emitCommit(ed, '민', '閔');

    expect(rubyRanges(ed)).toEqual([]);
  });
});
