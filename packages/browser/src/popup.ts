/**
 * Shadow DOM 기반 한자 후보 팝업 — 병음 IME 스타일 가로 컴팩트 레이아웃
 */

import type { LookupResult } from '@jieum/core';
import { countCollapsedCandidates } from './candidate-navigation.js';

/** 팝업 상태 */
export interface PopupState {
  buffer: string;
  groups: LookupResult[];
  expanded: boolean;
  activeRow: number;
  activeCol: number;
  blocked?: boolean;
}

/** 펼침 모드 열 수 */
const EXPANDED_COLS = 6;

/** 팝업 선택 결과 */
export interface PickResult {
  word: string;
  hanja: string;
  groupIndex: number;
  candidateIndex: number;
}

/** 팝업 컴포넌트 */
export interface JieumPopup {
  render(state: PopupState, anchorRect: DOMRect, onPick: (pick: PickResult) => void): void;
  hide(): void;
  isHovered(): boolean;
  destroy(): void;
}

const POPUP_STYLES = /* css */ `
:host {
  position: fixed;
  z-index: 2147483647;
  pointer-events: auto;
}

.jieum-popup {
  font-family: -apple-system, "Pretendard", "Noto Sans KR", sans-serif;
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  font-size: 13px;
  color: #222;
  max-width: 90vw;
}

.jieum-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  padding: 4px 8px;
  gap: 2px;
}

.jieum-row:last-child {
  border-bottom: none;
}

.jieum-label {
  font-size: 11px;
  color: #999;
  margin-right: 4px;
  flex-shrink: 0;
}

.jieum-cand {
  display: inline-flex;
  align-items: baseline;
  gap: 1px;
  padding: 1px 4px;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s;
}

.jieum-cand:hover {
  background: rgba(0, 100, 255, 0.1);
}

.jieum-cand.active {
  background: #2563eb;
  color: white;
  border-radius: 4px;
}

.jieum-cand.active .jieum-num { color: rgba(255,255,255,0.7); }
.jieum-cand.active .jieum-mean { color: rgba(255,255,255,0.7); }

.jieum-expand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: none;
  cursor: pointer;
  color: #999;
  font-size: 12px;
  padding: 0;
  flex-shrink: 0;
}

.jieum-expand:hover { color: #333; }

.jieum-scroll {
  max-height: calc(28px * 4);
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px 0;
}

.jieum-scroll::-webkit-scrollbar { width: 4px; }
.jieum-scroll::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 2px; }

.jieum-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 1px;
  padding: 2px 4px;
  min-height: 26px;
}

.jieum-grid-row-active {
  background: rgba(37, 99, 235, 0.06);
}

.jieum-section-label {
  padding: 2px 6px;
  font-size: 10px;
  color: #999;
  border-top: 1px solid rgba(0,0,0,0.08);
}

.jieum-num {
  font-size: 10px;
  color: #999;
  margin-right: 1px;
}

.jieum-hz {
  font-size: 14px;
}

.jieum-mean {
  font-size: 10px;
  color: #888;
  margin-left: 1px;
}

.jieum-toggle {
  position: absolute;
  top: 2px;
  right: 4px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 12px;
  padding: 1px 3px;
  border-radius: 3px;
  color: #000;
  line-height: 1;
}

.jieum-toggle:hover {
  background: rgba(0,0,0,0.1);
}

.jieum-popup.dark {
  background: rgba(35, 35, 35, 0.98);
  border-color: rgba(255, 255, 255, 0.12);
  color: #ddd;
}

.jieum-popup.dark .jieum-row { border-bottom-color: rgba(255, 255, 255, 0.06); }
.jieum-popup.dark .jieum-label { color: #777; }
.jieum-popup.dark .jieum-num { color: #777; }
.jieum-popup.dark .jieum-mean { color: #666; }
.jieum-popup.dark .jieum-cand:hover { background: rgba(100, 160, 255, 0.15); }
.jieum-popup.dark .jieum-toggle { color: #fff; }
.jieum-popup.dark .jieum-toggle:hover { background: rgba(255,255,255,0.15); }
.jieum-popup.dark .jieum-cand.active { background: #3b82f6; }
.jieum-popup.dark .jieum-expand { color: #666; }
.jieum-popup.dark .jieum-expand:hover { color: #ccc; }
.jieum-popup.dark .jieum-grid-row-active { background: rgba(59,130,246,0.08); }
.jieum-popup.dark .jieum-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); }
.jieum-popup.dark .jieum-section-label { color: #666; border-top-color: rgba(255,255,255,0.08); }
`;

/** 후보 번호 표시 최대 (컨트롤러에서 페이지 단위로 전달) */

export function createPopup(doc: Document): JieumPopup {
  const host = doc.createElement('jieum-popup');
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = doc.createElement('style');
  style.textContent = POPUP_STYLES;
  shadow.appendChild(style);

  const container = doc.createElement('div');
  container.className = 'jieum-popup';
  container.style.position = 'relative';

  // 라이트 모드 기본 + 세션 토글
  let isDark = false;

  const toggle = doc.createElement('button');
  toggle.className = 'jieum-toggle';
  toggle.textContent = isDark ? '☀' : '☾';
  toggle.title = '라이트/다크 전환';
  toggle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDark = !isDark;
    container.classList.toggle('dark', isDark);
    toggle.textContent = isDark ? '☀' : '☾';
  });
  container.appendChild(toggle);
  shadow.appendChild(container);

  let hovered = false;
  host.addEventListener('mouseenter', () => { hovered = true; });
  host.addEventListener('mouseleave', () => { hovered = false; });

  host.style.display = 'none';
  doc.body.appendChild(host);

  return {
    render(state, anchorRect, onPick) {
      if (!state.buffer || state.groups.length === 0) {
        this.hide();
        return;
      }

      // 토글 버튼 유지, 나머지 클리어
      while (container.firstChild && container.firstChild !== toggle) {
        container.removeChild(container.firstChild);
      }
      while (toggle.nextSibling) {
        container.removeChild(toggle.nextSibling);
      }

      // 모든 후보를 flat 배열로
      type FlatEntry = { c: typeof state.groups[0]['candidates'][0]; gi: number; ci: number; type?: string };
      const allCandidates: FlatEntry[] = [];
      for (let gi = 0; gi < state.groups.length; gi++) {
        const group = state.groups[gi]!;
        for (let ci = 0; ci < group.candidates.length; ci++) {
          allCandidates.push({ c: group.candidates[ci]!, gi, ci, type: group.type });
        }
      }

      function makeCand(entry: FlatEntry, num: string | null, isActive: boolean): HTMLElement {
        const cand = doc.createElement('span');
        cand.className = 'jieum-cand';
        if (isActive) cand.classList.add('active');

        let html = '';
        if (num) html += `<span class="jieum-num">${escapeHtml(num)}</span>`;
        html += `<span class="jieum-hz">${escapeHtml(entry.c.hanja)}</span>`;
        if (entry.c.meaning) html += `<span class="jieum-mean">${escapeHtml(entry.c.meaning)}</span>`;
        cand.innerHTML = html;

        const group = state.groups[entry.gi]!;
        cand.addEventListener('mousedown', (e) => {
          e.preventDefault();
          onPick({ word: group.word, hanja: entry.c.hanja, groupIndex: entry.gi, candidateIndex: entry.ci });
        });
        return cand;
      }

      if (!state.expanded) {
        // ─── 접힘: 1줄, 최대 9개 + ˅ 버튼 ───
        const row = doc.createElement('div');
        row.className = 'jieum-row';

        // 첫 줄은 최장 매칭의 1층만 — 고어·전문어도, 짧은 매칭도 펼쳐야 나온다.
        // engine.lookup이 그 순서로 정렬해 주므로 앞에서부터 세면 된다.
        const show = countCollapsedCandidates(state.groups, 9);
        for (let i = 0; i < show; i++) {
          row.appendChild(makeCand(allCandidates[i]!, `${i + 1}.`, i === state.activeCol));
        }

        if (allCandidates.length > show) {
          const btn = doc.createElement('button');
          btn.className = 'jieum-expand';
          btn.textContent = '˅';
          btn.title = '더 보기 (↓)';
          btn.addEventListener('mousedown', (e) => e.preventDefault());
          row.appendChild(btn);
        }

        container.appendChild(row);
      } else {
        // ─── 펼침: 그리드, 6열, 4줄 제한 + 스크롤 ───
        const byType = (t: string) => allCandidates.filter((x) => (x.type ?? 'normal') === t);

        // controller의 GROUP_ORDER와 같은 순서여야 방향키 이동과 어긋나지 않는다
        const sections = [
          { label: null as string | null, cands: byType('normal') },
          { label: '고어·전문어', cands: byType('archaic') },
          { label: '인명용', cands: byType('inmyeong') },
        ];

        const scrollBox = doc.createElement('div');
        scrollBox.className = 'jieum-scroll';

        let globalRow = 0;
        let activeGridEl: HTMLElement | null = null;

        for (const section of sections) {
          if (section.cands.length === 0) continue;

          if (section.label) {
            const labelEl = doc.createElement('div');
            labelEl.className = 'jieum-section-label';
            labelEl.textContent = section.label;
            scrollBox.appendChild(labelEl);
          }

          for (let i = 0; i < section.cands.length; i += EXPANDED_COLS) {
            const rowCands = section.cands.slice(i, i + EXPANDED_COLS);
            const grid = doc.createElement('div');
            grid.className = 'jieum-grid';
            if (globalRow === state.activeRow) {
              grid.classList.add('jieum-grid-row-active');
              activeGridEl = grid;
            }

            const isActiveRow = globalRow === state.activeRow;
            for (let j = 0; j < rowCands.length; j++) {
              const num = isActiveRow ? `${j + 1}.` : null;
              const isHighlighted = isActiveRow && j === state.activeCol;
              grid.appendChild(makeCand(rowCands[j]!, num, isHighlighted));
            }

            scrollBox.appendChild(grid);
            globalRow++;
          }
        }

        container.appendChild(scrollBox);

        // 활성 행이 보이도록 자동 스크롤
        if (activeGridEl) {
          requestAnimationFrame(() => {
            activeGridEl!.scrollIntoView({ block: 'nearest' });
          });
        }
      }

      host.style.display = 'block';
      positionPopup(host, anchorRect);
    },

    hide() {
      host.style.display = 'none';
      while (toggle.nextSibling) {
        container.removeChild(toggle.nextSibling);
      }
    },

    isHovered() {
      return hovered;
    },

    destroy() {
      host.remove();
    },
  };
}

function positionPopup(host: HTMLElement, anchorRect: DOMRect): void {
  const margin = 4;
  const gap = 2;

  let top = anchorRect.bottom + gap;
  let left = anchorRect.left;

  if (top + host.offsetHeight > window.innerHeight - margin) {
    top = anchorRect.top - host.offsetHeight - gap;
  }
  if (left + host.offsetWidth > window.innerWidth - margin) {
    left = window.innerWidth - host.offsetWidth - margin;
  }
  if (left < margin) left = margin;

  host.style.left = `${left}px`;
  host.style.top = `${Math.max(margin, top)}px`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
