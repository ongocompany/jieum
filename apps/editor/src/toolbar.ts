/**
 * 에디터 툴바 — 서식, 폰트, 표, 루비 등 (다중 탭 지원)
 */

import type { Editor } from '@tiptap/core';
import type { TabManager } from './tabs.js';
import { promptText } from './modal.js';

// ─── 폰트 목록 ───

const FONTS = [
  { label: '기본', value: '' },
  { label: '본고딕 (Noto Sans)', value: '"Noto Sans KR", "Noto Sans SC", "Noto Sans JP", sans-serif' },
  { label: '본명조 (Noto Serif)', value: '"Noto Serif KR", "Noto Serif SC", "Noto Serif JP", serif' },
  { label: 'Pretendard', value: 'Pretendard' },
  { label: '나눔명조', value: '"Nanum Myeongjo"' },
  { label: '나눔고딕', value: '"Nanum Gothic"' },
  { label: '맑은 고딕', value: '"Malgun Gothic"' },
  { label: '바탕', value: 'Batang' },
  { label: '돋움', value: 'Dotum' },
  { label: '궁서', value: 'Gungsuh' },
  { label: 'Georgia', value: 'Georgia' },
  { label: 'Times New Roman', value: '"Times New Roman"' },
  { label: 'Arial', value: 'Arial' },
  { label: 'Courier New', value: '"Courier New"' },
];

const SIZES = [
  '9pt', '10pt', '11pt', '12pt', '14pt', '16pt',
  '18pt', '20pt', '24pt', '28pt', '36pt', '48pt',
];

const COLORS = [
  '#000000', '#434343', '#666666', '#999999',
  '#e03131', '#e8590c', '#f08c00', '#2f9e44',
  '#1971c2', '#6741d9', '#c2255c', '#0c8599',
];

interface Btn {
  icon: string;
  title: string;
  action: (e: Editor) => void;
  isActive?: (e: Editor) => boolean;
}

function getGroups(): Btn[][] {
  return [
    [
      { icon: 'B', title: '굵게', action: e => e.chain().focus().toggleBold().run(), isActive: e => e.isActive('bold') },
      { icon: 'I', title: '기울임', action: e => e.chain().focus().toggleItalic().run(), isActive: e => e.isActive('italic') },
      { icon: 'U', title: '밑줄', action: e => e.chain().focus().toggleUnderline().run(), isActive: e => e.isActive('underline') },
      { icon: 'S', title: '취소선', action: e => e.chain().focus().toggleStrike().run(), isActive: e => e.isActive('strike') },
      { icon: 'x²', title: '윗첨자', action: e => e.chain().focus().toggleSuperscript().run(), isActive: e => e.isActive('superscript') },
      { icon: 'x₂', title: '아랫첨자', action: e => e.chain().focus().toggleSubscript().run(), isActive: e => e.isActive('subscript') },
    ],
    [
      { icon: 'H1', title: '제목 1', action: e => e.chain().focus().toggleHeading({ level: 1 }).run(), isActive: e => e.isActive('heading', { level: 1 }) },
      { icon: 'H2', title: '제목 2', action: e => e.chain().focus().toggleHeading({ level: 2 }).run(), isActive: e => e.isActive('heading', { level: 2 }) },
      { icon: 'H3', title: '제목 3', action: e => e.chain().focus().toggleHeading({ level: 3 }).run(), isActive: e => e.isActive('heading', { level: 3 }) },
    ],
    [
      { icon: '•', title: '글머리 기호', action: e => e.chain().focus().toggleBulletList().run(), isActive: e => e.isActive('bulletList') },
      { icon: '1.', title: '번호 매기기', action: e => e.chain().focus().toggleOrderedList().run(), isActive: e => e.isActive('orderedList') },
      { icon: '❝', title: '인용', action: e => e.chain().focus().toggleBlockquote().run(), isActive: e => e.isActive('blockquote') },
      { icon: '─', title: '가로선', action: e => e.chain().focus().setHorizontalRule().run() },
    ],
    [
      { icon: '⫷', title: '왼쪽 정렬', action: e => e.chain().focus().setTextAlign('left').run(), isActive: e => e.isActive({ textAlign: 'left' }) },
      { icon: '☰', title: '가운데 정렬', action: e => e.chain().focus().setTextAlign('center').run(), isActive: e => e.isActive({ textAlign: 'center' }) },
      { icon: '⫸', title: '오른쪽 정렬', action: e => e.chain().focus().setTextAlign('right').run(), isActive: e => e.isActive({ textAlign: 'right' }) },
    ],
    [
      { icon: '▦', title: '표 삽입 (3x3)', action: e => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
      { icon: '+↓', title: '행 추가', action: e => e.chain().focus().addRowAfter().run() },
      { icon: '+→', title: '열 추가', action: e => e.chain().focus().addColumnAfter().run() },
      { icon: '−↓', title: '행 삭제', action: e => e.chain().focus().deleteRow().run() },
      { icon: '−→', title: '열 삭제', action: e => e.chain().focus().deleteColumn().run() },
      { icon: '⊠', title: '표 삭제', action: e => e.chain().focus().deleteTable().run() },
    ],
    [
      { icon: '↶', title: '실행 취소', action: e => e.chain().focus().undo().run() },
      { icon: '↷', title: '다시 실행', action: e => e.chain().focus().redo().run() },
    ],
  ];
}

// ─── 메인 ───

export function createToolbar(container: HTMLElement, initialEditor: Editor, tabManager?: TabManager): void {
  const groups = getGroups();
  const getEditor = (): Editor => tabManager ? tabManager.getActive().editor : initialEditor;

  // 1. 폰트 + 크기
  const fontGroup = mkGroup();
  const fontSelect = mkSelect('글꼴', FONTS.map(f => ({ label: f.label, value: f.value })));
  fontSelect.addEventListener('change', () => {
    const ed = getEditor();
    if (fontSelect.value) ed.chain().focus().setFontFamily(fontSelect.value).run();
    else ed.chain().focus().unsetFontFamily().run();
  });
  fontGroup.appendChild(fontSelect);

  const sizeSelect = mkSelect('글자 크기', SIZES.map(s => ({ label: s.replace('pt', ''), value: s })));
  sizeSelect.value = '16pt';
  sizeSelect.addEventListener('change', () => getEditor().chain().focus().setFontSize(sizeSelect.value).run());
  fontGroup.appendChild(sizeSelect);
  container.appendChild(fontGroup);

  // 2. 버튼 그룹들
  let btnCounter = 0;
  for (const group of groups) {
    const el = mkGroup();
    for (const btn of group) {
      const b = document.createElement('button');
      b.className = 'toolbar-btn';
      b.textContent = btn.icon;
      b.title = btn.title;
      b.dataset['idx'] = String(btnCounter++);
      b.addEventListener('mousedown', (e) => { e.preventDefault(); btn.action(getEditor()); });
      el.appendChild(b);
    }
    container.appendChild(el);
  }

  // 3. 글자색
  const colorGroup = mkGroup();
  colorGroup.style.position = 'relative';

  const colorBtn = document.createElement('button');
  colorBtn.className = 'toolbar-btn';
  colorBtn.title = '글자색';
  colorBtn.innerHTML = '<span style="pointer-events:none">A</span><span class="color-bar" style="position:absolute;bottom:2px;left:6px;right:6px;height:3px;background:#e03131;border-radius:1px;pointer-events:none"></span>';
  colorBtn.style.position = 'relative';

  const picker = document.createElement('div');
  picker.className = 'color-picker';
  picker.style.display = 'none';

  for (const color of COLORS) {
    const swatch = document.createElement('button');
    swatch.className = 'color-swatch';
    swatch.style.background = color;
    swatch.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      getEditor().chain().focus().setColor(color).run();
      colorBtn.querySelector('.color-bar')!.setAttribute('style',
        `position:absolute;bottom:2px;left:6px;right:6px;height:3px;background:${color};border-radius:1px;pointer-events:none`);
      picker.style.display = 'none';
    });
    picker.appendChild(swatch);
  }

  colorBtn.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    picker.style.display = picker.style.display === 'none' ? 'grid' : 'none';
  });
  document.addEventListener('mousedown', () => { picker.style.display = 'none'; });
  colorGroup.appendChild(colorBtn);
  colorGroup.appendChild(picker);
  container.appendChild(colorGroup);

  // 4. 루비
  const rubyGroup = mkGroup();

  const rubyBtn = document.createElement('button');
  rubyBtn.className = 'toolbar-btn';
  rubyBtn.textContent = '振';
  rubyBtn.title = '루비문자 (읽기 표시)';
  rubyBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const ed = getEditor();
    const { from, to } = ed.state.selection;
    if (from === to) return;
    const text = ed.state.doc.textBetween(from, to);

    // 모달이 열려 있는 동안 본문 선택이 바뀔 수 있으므로 위치를 붙잡아 둔다
    void promptText({
      title: '루비문자 (읽기 표시)',
      hint: `"${text}"의 읽기를 입력하세요`,
      placeholder: '예: 한자',
    }).then((annotation) => {
      if (!annotation) return;
      ed.chain().focus().setTextSelection({ from, to }).setRuby(annotation).run();
    });
  });
  rubyGroup.appendChild(rubyBtn);

  const unsetRubyBtn = document.createElement('button');
  unsetRubyBtn.className = 'toolbar-btn';
  unsetRubyBtn.textContent = '振̶';
  unsetRubyBtn.title = '루비 제거';
  unsetRubyBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    getEditor().chain().focus().unsetRuby().run();
  });
  rubyGroup.appendChild(unsetRubyBtn);
  container.appendChild(rubyGroup);

  // 5. 상태 동기화
  const allBtns = container.querySelectorAll<HTMLElement>('.toolbar-btn[data-idx]');
  const update = () => {
    const ed = getEditor();
    let idx = 0;
    for (const group of groups) {
      for (const btn of group) {
        const el = allBtns[idx];
        if (el && btn.isActive) el.classList.toggle('active', btn.isActive(ed));
        idx++;
      }
    }
  };

  initialEditor.on('selectionUpdate', update);
  initialEditor.on('update', update);

  if (tabManager) {
    // 이미 구독한 에디터를 기억한다. 탭을 왕복할 때마다 다시 on()을 걸면
    // 같은 핸들러가 누적돼 키 입력 한 번에 update가 여러 번 돈다.
    const subscribed = new WeakSet<Editor>([initialEditor]);
    const origSwitch = tabManager.onSwitch;
    tabManager.onSwitch = (tab) => {
      origSwitch?.(tab);
      if (!subscribed.has(tab.editor)) {
        subscribed.add(tab.editor);
        tab.editor.on('selectionUpdate', update);
        tab.editor.on('update', update);
      }
      update();
    };
  }
}

// ─── 헬퍼 ───

function mkGroup(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'toolbar-group';
  return el;
}

function mkSelect(title: string, options: { label: string; value: string }[]): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'toolbar-select';
  sel.title = title;
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  return sel;
}
