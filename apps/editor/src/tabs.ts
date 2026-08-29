/**
 * 다중 탭 관리
 */

import { Editor } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { TextAlign } from '@tiptap/extension-text-align';
import { TextStyle, FontFamily, Color } from '@tiptap/extension-text-style';
import { TableKit } from '@tiptap/extension-table';
import { Superscript } from '@tiptap/extension-superscript';
import { Subscript } from '@tiptap/extension-subscript';
import { FontSize } from './font-size.js';
import { Ruby } from './ruby-ext.js';

export interface Tab {
  id: string;
  title: string;
  editor: Editor;
  filePath: string | null;
  format: 'docx' | 'html' | 'txt';
  modified: boolean;
}

export interface TabManager {
  getActive(): Tab;
  getAll(): Tab[];
  addTab(title?: string): Tab;
  switchTab(id: string): void;
  closeTab(id: string): void;
  setTitle(id: string, title: string): void;
  setModified(id: string, modified: boolean): void;
  onSwitch: ((tab: Tab) => void) | null;
  onUpdate: (() => void) | null;
}

let counter = 0;

function createEditor(container: HTMLElement): Editor {
  // 에디터 DOM 요소 생성
  const wrapper = document.createElement('div');
  wrapper.className = 'tab-editor-wrapper';
  wrapper.style.display = 'none';
  container.appendChild(wrapper);

  return new Editor({
    element: wrapper,
    extensions: [
      StarterKit,
      TextStyle,
      FontFamily,
      FontSize,
      Color,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TableKit.configure({ table: { resizable: true } }),
      Superscript,
      Subscript,
      Ruby,
    ],
    content: '<p></p>',
  });
}

export function createTabManager(editorContainer: HTMLElement, tabBarContainer: HTMLElement): TabManager {
  const tabs: Tab[] = [];
  let activeId = '';

  const manager: TabManager = {
    onSwitch: null,
    onUpdate: null,

    getActive() {
      return tabs.find(t => t.id === activeId)!;
    },

    getAll() {
      return tabs;
    },

    addTab(title?: string) {
      const id = `tab-${++counter}`;
      const editor = createEditor(editorContainer);
      const tab: Tab = {
        id,
        title: title || '새 문서',
        editor,
        filePath: null,
        format: 'docx',
        modified: false,
      };

      editor.on('update', () => {
        // 탭바는 modified 표시가 바뀔 때만 다시 그린다.
        // 매 키 입력마다 renderTabs를 돌리면 탭바 DOM 전체가 재생성된다.
        const becameModified = !tab.modified;
        tab.modified = true;
        manager.onUpdate?.();
        if (becameModified) renderTabs();
      });

      tabs.push(tab);
      manager.switchTab(id);
      renderTabs();
      return tab;
    },

    switchTab(id: string) {
      const tab = tabs.find(t => t.id === id);
      if (!tab) return;

      // 모든 에디터 숨기기
      for (const t of tabs) {
        const wrapper = t.editor.options.element as HTMLElement;
        wrapper.style.display = 'none';
      }

      // 선택된 에디터 보이기
      const wrapper = tab.editor.options.element as HTMLElement;
      wrapper.style.display = '';
      activeId = id;

      tab.editor.commands.focus();
      manager.onSwitch?.(tab);
      renderTabs();
    },

    closeTab(id: string) {
      const idx = tabs.findIndex(t => t.id === id);
      if (idx === -1) return;

      const tab = tabs[idx]!;
      if (tab.modified && !confirm(`"${tab.title}" 저장하지 않고 닫을까요?`)) return;

      // 에디터 정리
      const wrapper = tab.editor.options.element as HTMLElement;
      tab.editor.destroy();
      wrapper.remove();
      tabs.splice(idx, 1);

      // 탭이 없으면 새 탭 생성
      if (tabs.length === 0) {
        manager.addTab();
        return;
      }

      // 닫은 탭이 활성 탭이면 인접 탭 활성화
      if (activeId === id) {
        const nextIdx = Math.min(idx, tabs.length - 1);
        manager.switchTab(tabs[nextIdx]!.id);
      }

      renderTabs();
    },

    setTitle(id: string, title: string) {
      const tab = tabs.find(t => t.id === id);
      if (tab) {
        tab.title = title;
        renderTabs();
      }
    },

    setModified(id: string, modified: boolean) {
      const tab = tabs.find(t => t.id === id);
      if (tab) {
        tab.modified = modified;
        renderTabs();
      }
    },
  };

  function renderTabs() {
    tabBarContainer.innerHTML = '';

    for (const tab of tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (tab.id === activeId ? ' active' : '');
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        manager.switchTab(tab.id);
      });

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = (tab.modified ? '● ' : '') + tab.title;
      el.appendChild(label);

      // 닫기 버튼
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = '탭 닫기';
      close.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        manager.closeTab(tab.id);
      });
      el.appendChild(close);

      tabBarContainer.appendChild(el);
    }

    // 새 탭 버튼
    const addBtn = document.createElement('button');
    addBtn.className = 'tab-add';
    addBtn.textContent = '+';
    addBtn.title = '새 탭';
    addBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      manager.addTab();
    });
    tabBarContainer.appendChild(addBtn);
  }

  return manager;
}
