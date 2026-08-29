/**
 * 지음편집기 — Tauri + TipTap + 지음 SDK + 다중 탭
 */

import { init } from '@jieum/sdk';
import { attachEditableSurface, type JieumController } from '@jieum/browser';
import type { Editor } from '@tiptap/core';
import { createTiptapAdapter } from './jieum-adapter.js';
import { attachAutoRuby } from './auto-ruby.js';
import { createMruPersistence } from './mru-persist.js';
import { createToolbar } from './toolbar.js';
import { createTabManager } from './tabs.js';
import { openFile, saveFile, saveFileAs } from './file-io.js';

const statusEl = document.getElementById('status')!;

async function boot() {
  // 1. 탭 매니저 생성
  const tabManager = createTabManager(
    document.getElementById('editor')!,
    document.getElementById('tabbar')!,
  );

  // 2. 첫 번째 탭 생성
  const firstTab = tabManager.addTab();

  // 3. 툴바 연결
  createToolbar(document.getElementById('toolbar')!, firstTab.editor, tabManager);

  // 4. jieum SDK 초기화
  statusEl.textContent = '사전 로딩 중...';

  const jieum = await init({
    dictUrl: '/data/',
    autoAttach: false,
    observe: false,
  });

  statusEl.textContent = `지음입력기 준비 완료 — ${jieum.engine.dictSize.toLocaleString()}개 단어`;

  // 4.5. 최근 변환 이력 — 사전의 97.6%가 빈도 0이라 사실상 유일한 랭킹 신호다
  const mru = createMruPersistence();
  jieum.engine.setMru(mru.store);

  // 5. 지음입력기 토글 상태
  let jieumActive = true;
  // 변환한 한자에 독음을 자동으로 달지 여부. 기본은 꺼짐
  let autoRubyActive = false;
  const controllerMap = new Map<string, JieumController>();

  function doAttach(tabId: string, editor: Editor) {
    if (controllerMap.has(tabId)) return;
    // TipTap 네이티브 adapter: DOM 추측 대신 ProseMirror 모델에 직접 질의
    const ctrl = attachEditableSurface(editor.view.dom as HTMLElement, {
      engine: jieum.engine,
      adapter: createTiptapAdapter(editor),
    });
    if (ctrl) {
      controllerMap.set(tabId, ctrl);
      attachAutoRuby(editor, () => autoRubyActive);
    }
  }

  // 이미 있는 첫 탭 부착 시도
  doAttach(firstTab.id, firstTab.editor);

  // 탭 전환 시
  const prevOnSwitch = tabManager.onSwitch;
  tabManager.onSwitch = (tab) => {
    prevOnSwitch?.(tab);
    doAttach(tab.id, tab.editor);
    document.title = `${tab.title} — 지음편집기`;
  };

  // 6. 지음입력기 토글
  function toggleJieum() {
    jieumActive = !jieumActive;
    for (const ctrl of controllerMap.values()) {
      ctrl.setActive(jieumActive);
    }
    updateIndicator();
  }

  const jieumToggle = document.createElement('button');
  jieumToggle.className = 'jieum-toggle-btn';
  jieumToggle.addEventListener('click', toggleJieum);
  document.getElementById('statusbar')!.prepend(jieumToggle);

  function updateIndicator() {
    jieumToggle.textContent = jieumActive ? '漢 지음' : '가 한글';
    jieumToggle.classList.toggle('active', jieumActive);
    jieumToggle.title = jieumActive ? '한자입력기 활성 (⌘\\)' : '일반 입력 (⌘\\)';
  }
  updateIndicator();

  // 자동 독음 루비 토글
  const rubyToggle = document.createElement('button');
  rubyToggle.className = 'jieum-toggle-btn';
  rubyToggle.addEventListener('click', () => {
    autoRubyActive = !autoRubyActive;
    updateRubyIndicator();
  });
  jieumToggle.after(rubyToggle);

  function updateRubyIndicator() {
    rubyToggle.textContent = autoRubyActive ? '振 독음 켬' : '振 독음 끔';
    rubyToggle.classList.toggle('active', autoRubyActive);
    rubyToggle.title = autoRubyActive
      ? '변환한 한자 위에 독음을 자동으로 답니다'
      : '독음을 달지 않습니다 (툴바 振으로 직접 달 수 있습니다)';
  }
  updateRubyIndicator();

  // 변환 이벤트 — 고른 후보를 이력에 남겨 다음 입력에서 상단으로 올린다
  //
  // 문맥을 함께 넘긴다. 이력은 문맥별로 나뉘어 담기므로, 여기서 빼면
  // 조회할 때와 다른 칸에 들어가 방금 고른 것이 다음에 안 나온다.
  jieum.on('convert', ({ word, hanja, context }) => {
    jieum.engine.recordChoice(word, hanja, Date.now(), context);
    mru.scheduleSave();
    statusEl.textContent = `변환: ${word} → ${hanja}`;
  });

  // 7. 파일 제목 관리
  const setTitle = (t: string) => {
    const tab = tabManager.getActive();
    tabManager.setTitle(tab.id, t);
    tabManager.setModified(tab.id, false);
    document.title = `${t} — 지음편집기`;
  };

  // 8. Tauri 네이티브 메뉴 이벤트 수신
  try {
    // @ts-expect-error Tauri 환경에서만 사용
    if (window.__TAURI_INTERNALS__) {
      const { listen } = await import('@tauri-apps/api/event');
      listen('menu-event', (event: any) => {
        const id = event.payload as string;
        const active = tabManager.getActive();
        switch (id) {
          case 'new': tabManager.addTab(); break;
          case 'open': openFile(active.editor, setTitle, active); break;
          case 'save': saveFile(active.editor, setTitle, active); break;
          case 'save_as': saveFileAs(active.editor, setTitle, active); break;
          case 'close_tab': tabManager.closeTab(active.id); break;
          case 'toggle_jieum': toggleJieum(); break;
        }
      });
    }
  } catch { /* 웹 환경 — 무시 */ }

  // 9. 키보드 단축키

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const active = tabManager.getActive();
    if (e.key === 'n') { e.preventDefault(); tabManager.addTab(); }
    if (e.key === 'o') { e.preventDefault(); openFile(active.editor, setTitle, active); }
    if (e.key === 's' && !e.shiftKey) { e.preventDefault(); saveFile(active.editor, setTitle, active); }
    if (e.key === 's' && e.shiftKey) { e.preventDefault(); saveFileAs(active.editor, setTitle, active); }
    if (e.key === 'w') { e.preventDefault(); tabManager.closeTab(active.id); }
    if (e.key === '\\') { e.preventDefault(); toggleJieum(); }
  });

  // 8. 파일 버튼
  const toolbar = document.getElementById('toolbar')!;
  const fileGroup = document.createElement('div');
  fileGroup.className = 'toolbar-group';
  const fileButtons = [
    { icon: '📄', title: '새 문서 (⌘N)', action: () => tabManager.addTab() },
    { icon: '📂', title: '열기 (⌘O)', action: () => { const a = tabManager.getActive(); openFile(a.editor, setTitle, a); } },
    { icon: '💾', title: '저장 (⌘S)', action: () => { const a = tabManager.getActive(); saveFile(a.editor, setTitle, a); } },
  ];
  for (const fb of fileButtons) {
    const btn = document.createElement('button');
    btn.className = 'toolbar-btn';
    btn.textContent = fb.icon;
    btn.title = fb.title;
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); fb.action(); });
    fileGroup.appendChild(btn);
  }
  toolbar.insertBefore(fileGroup, toolbar.firstChild);

  // 9. 글자 수
  const charCountEl = document.createElement('span');
  document.getElementById('statusbar')!.appendChild(charCountEl);
  tabManager.onUpdate = () => {
    const text = tabManager.getActive().editor.getText();
    charCountEl.textContent = `${text.length}자`;
  };

  document.title = '새 문서 — 지음편집기';
}

boot().catch((err) => {
  statusEl.textContent = `초기화 실패: ${err?.message || err}`;
  console.error(err);
});
