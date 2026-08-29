/**
 * 자동 독음 루비
 *
 * 지음이 한자를 확정할 때마다 그 한자 위에 원래 독음(한글)을 루비로 단다.
 * 툴바의 振 버튼은 임의의 읽기를 손으로 다는 기능이고, 이쪽은 변환 결과에
 * 자동으로 따라붙는다.
 *
 * 엔진·컨트롤러는 건드리지 않는다. 지음이 확정 때 버블시키는 jieum:commit
 * (detail: { word, hanja }) 하나만 듣는다.
 */

import type { Editor } from '@tiptap/core';

export interface AutoRubyHandle {
  detach(): void;
}

/**
 * 에디터에 자동 독음 루비를 붙인다.
 *
 * isEnabled는 매 확정 시점에 평가하므로, 토글을 껐다 켜도 재부착이 필요 없다.
 */
export function attachAutoRuby(editor: Editor, isEnabled: () => boolean): AutoRubyHandle {
  const dom = editor.view.dom as HTMLElement;

  function onCommit(event: Event): void {
    if (!isEnabled()) return;
    const detail = (event as CustomEvent).detail as { word?: string; hanja?: string };
    const word = detail?.word;
    const hanja = detail?.hanja;
    if (!word || !hanja) return;
    applyRuby(editor, word, hanja);
  }

  dom.addEventListener('jieum:commit', onCommit);

  return {
    detach() {
      dom.removeEventListener('jieum:commit', onCommit);
    },
  };
}

/**
 * 방금 확정된 한자를 찾아 루비를 적용한다.
 *
 * 커서에서 hanja 길이만큼 역산하지 않는 이유: commitPick은 버퍼 전체를
 * (한자 + 매칭되지 않은 나머지 한글)로 치환하고 커서를 그 뒤로 보낸다.
 * 나머지 길이는 이벤트에 실려오지 않으므로, 커서 앞 텍스트에서 hanja의
 * 마지막 출현을 찾는 편이 정확하다.
 */
function applyRuby(editor: Editor, word: string, hanja: string): void {
  const { $from, from: caret } = editor.state.selection;
  if (!$from.parent.isTextblock) return;

  // leafText를 지정해 이미지 등 리프 노드도 1글자로 세어 오프셋 정합성 유지
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const idx = textBefore.lastIndexOf(hanja);
  if (idx < 0) return;

  const blockStart = $from.start();
  const from = blockStart + idx;
  const to = from + hanja.length;

  editor
    .chain()
    .setTextSelection({ from, to })
    .setRuby(word)
    // mark 적용은 문서 길이를 바꾸지 않으므로 원래 커서 위치가 그대로 유효하다
    .setTextSelection(caret)
    // 커서가 루비 바로 뒤에 서면 다음 입력이 mark를 물려받는다. 끊어준다
    .unsetRuby()
    .run();
}
