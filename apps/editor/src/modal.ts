/**
 * 앱 내 대화상자
 *
 * window.prompt는 Tauri(WKWebView)에서 뜨지 않는다 — 실측 2026-08-01,
 * 툴바 루비 버튼이 아무 반응 없이 죽어 있었다. file-io의 pickFormat이
 * 이미 같은 이유로 자체 모달을 쓰고 있었고, 이 모듈은 그 패턴을 공용화한 것이다.
 */

const OVERLAY_STYLE =
  'position:fixed;inset:0;background:rgba(0,0,0,0.3);z-index:10000;' +
  'display:flex;align-items:center;justify-content:center;';

const PANEL_STYLE =
  'background:white;border-radius:12px;padding:24px;' +
  'box-shadow:0 8px 32px rgba(0,0,0,0.2);min-width:320px;font-family:inherit;';

export interface PromptTextOptions {
  title: string;
  /** 제목 아래 보조 설명 (선택) */
  hint?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
}

/**
 * 한 줄 텍스트 입력 — window.prompt 대체
 *
 * 확인은 입력값, 취소·빈 값은 null을 돌려준다.
 */
export function promptText(options: PromptTextOptions): Promise<string | null> {
  const {
    title,
    hint,
    defaultValue = '',
    placeholder = '',
    confirmLabel = '확인',
  } = options;

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = OVERLAY_STYLE;

    const panel = document.createElement('div');
    panel.style.cssText = PANEL_STYLE;

    const titleEl = document.createElement('h3');
    titleEl.textContent = title;
    titleEl.style.cssText = 'margin:0 0 12px;font-size:16px;color:#1a1a1a;';
    panel.appendChild(titleEl);

    if (hint) {
      const hintEl = document.createElement('p');
      hintEl.textContent = hint;
      hintEl.style.cssText = 'margin:0 0 12px;font-size:13px;color:#888;';
      panel.appendChild(hintEl);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue;
    input.placeholder = placeholder;
    input.style.cssText =
      'width:100%;box-sizing:border-box;padding:8px 10px;font-size:14px;' +
      'font-family:inherit;border:1px solid #d0d0d0;border-radius:6px;outline:none;';
    input.addEventListener('focus', () => { input.style.borderColor = '#1971c2'; });
    input.addEventListener('blur', () => { input.style.borderColor = '#d0d0d0'; });
    panel.appendChild(input);

    const buttonRow = document.createElement('div');
    buttonRow.style.cssText = 'display:flex;gap:8px;margin-top:16px;';

    let settled = false;
    function close(value: string | null): void {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onDocKeyDown, true);
      overlay.remove();
      resolve(value);
    }

    const cancel = document.createElement('button');
    cancel.textContent = '취소';
    cancel.style.cssText =
      'flex:1;padding:8px;border:1px solid #d0d0d0;background:none;border-radius:6px;' +
      'cursor:pointer;color:#666;font-size:13px;font-family:inherit;';
    cancel.addEventListener('click', () => close(null));

    const confirm = document.createElement('button');
    confirm.textContent = confirmLabel;
    confirm.style.cssText =
      'flex:1;padding:8px;border:none;background:#1971c2;border-radius:6px;' +
      'cursor:pointer;color:white;font-size:13px;font-family:inherit;';
    confirm.addEventListener('click', () => close(input.value.trim() || null));

    buttonRow.appendChild(cancel);
    buttonRow.appendChild(confirm);
    panel.appendChild(buttonRow);

    /**
     * 키 처리는 capture 단계에서 한다.
     *
     * 에디터·지음 컨트롤러가 document/에디터 DOM에 리스너를 걸고 있어
     * 버블 단계로 두면 모달의 Enter가 본문 편집으로 새어나간다.
     * 조합 중(keyCode 229)에는 물러난다 — IME가 한글을 확정하는 Enter까지
     * 가로채면 읽기를 한글로 입력할 수 없다.
     */
    function onDocKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(null);
        return;
      }
      if (e.key === 'Enter') {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        e.stopPropagation();
        close(input.value.trim() || null);
      }
    }
    document.addEventListener('keydown', onDocKeyDown, true);

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(null);
    });

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    input.focus();
    input.select();
  });
}
