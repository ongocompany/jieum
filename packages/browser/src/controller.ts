/**
 * jieum 브라우저 컨트롤러
 *
 * 편집 가능한 요소에 한자 입력기를 부착하는 핵심 모듈:
 * - 한글 조합(composition) 이벤트 처리
 * - 입력 버퍼 → 코어 엔진 → 후보 팝업 파이프라인
 * - 숫자키/Tab/Esc 키보드 네비게이션
 * - 텍스트 치환 실행
 */

import type { JieumEngine, LookupResult } from '@jieum/core';
import { mergeTrailingBuffer, sanitizeHangul } from './buffer-utils.js';
import {
  countCollapsedCandidates,
  resolveCandidateIndex,
  transitionCandidateNavigation,
  type CandidateNavigationKey,
  type CandidateNavigationLayout,
} from './candidate-navigation.js';
import { createSurfaceAdapter, findEditableTargets, type SurfaceAdapter } from './surface-adapter.js';
import { createPopup, type PopupState } from './popup.js';

/** 부착된 컨트롤러 마커 */
const ATTACHED = Symbol('jieum-attached');

/** 컨트롤러 인스턴스 */
export interface JieumController {
  /** 현재 상태 */
  getState(): ControllerState;
  /** jieum 활성/비활성 전환 */
  setActive(active: boolean): void;
  /** 수동으로 상태 동기화 */
  sync(): void;
  /** 파괴 (이벤트 리스너 제거, 팝업 제거) */
  destroy(): void;
}

/** 컨트롤러 상태 */
export interface ControllerState {
  buffer: string;
  groups: LookupResult[];
  active: boolean;
  expanded: boolean;
}

/** 부착 옵션 */
export interface AttachOptions {
  engine: JieumEngine;
  /**
   * 커스텀 surface adapter (선택)
   *
   * 생략하면 DOM 기반 generic adapter를 자동 생성한다.
   * ProseMirror/TipTap처럼 DOM 관찰이 신뢰할 수 없는 표면은
   * 모델에 직접 질의하는 adapter를 주입한다.
   */
  adapter?: SurfaceAdapter;
}

/**
 * 편집 가능한 요소에 jieum 한자입력기 부착
 */
export function attachEditableSurface(
  target: HTMLElement,
  options: AttachOptions,
): JieumController | null {
  // 이미 부착된 경우
  if ((target as any)[ATTACHED]) return (target as any)[ATTACHED];

  const maybeAdapter = options.adapter ?? createSurfaceAdapter(target);
  if (!maybeAdapter) return null;
  const adapter = maybeAdapter; // non-null 확정 (클로저에서 사용)

  const { engine } = options;
  const popup = createPopup(target.ownerDocument);

  // ─── 상태 ───
  let composing = false;
  let compositionText = '';
  /**
   * 조합 시작 시점의 확정 텍스트 (커서 앞 연속 한글)
   *
   * 조합 중에는 표면에 매번 다시 묻지 않고 이 값을 쓴다. 조합 중 표면이
   * 커서 앞 확정 한글을 온전히 내주지 못하는 구간이 있기 때문이다.
   * (실측 2026-08-01 Tauri+TipTap: "안" 확정 후 "녕"을 조합하는 동안
   *  어댑터가 ""를 반환 → 버퍼가 "녕"이 되어 사전에 있는 "안녕"을 놓쳤다)
   *
   * compositionstart 시점에는 조합 텍스트가 아직 문서에 없으므로
   * 여기서 읽은 값이 정확히 확정분이다.
   */
  let compositionBase = '';
  let currentBuffer = '';
  let currentGroups: LookupResult[] = [];
  /** flat index → {groupIndex, candidateIndex} 매핑 (전체) */
  let flatMap: Array<{ gi: number; ci: number }> = [];
  /** 펼침 모드 */
  let expanded = false;
  /** 펼침 모드 활성 행/열 */
  let activeRow = 0;
  let activeCol = 0;
  const EXPANDED_COLS = 6;
  let pendingCommitIndex: number | null = null;
  let pendingCommitBuffer: string | null = null;
  let pendingClear = false;
  let active = true;
  /** Esc로 팝업을 닫은 상태 — 버퍼가 바뀔 때까지 팝업/변환 차단 */
  let dismissed = false;
  let dismissedBuffer = '';

  // ─── 핵심 로직 ───

  function readBuffer(): string {
    // compositionText가 남아 있으면 조합이 방금 끝나고 flush를 기다리는 구간이다.
    // 그동안에도 base를 쓴다 — composing만 보면 그 창에서 버퍼가 무너진다.
    //
    // IME는 숫자키를 조합에 삼켜 "만1"을 통째로 커밋한다. compositionend는
    // composing을 내리기 전에 syncState를 불러 이 함정을 피하지만, 브라우저는
    // 그 **뒤에 input을 한 번 더** 보낸다. 그때는 composing이 이미 false여서
    // 문서를 읽고, 문서 끝이 "1"이라 커서 앞 한글이 빈 문자열이 되어,
    // 남아 있는 compositionText와 합쳐지며 버퍼가 마지막 음절로 줄어든다.
    // (실측 2026-08-28 웹 데모: "낭만"+1 → 浪漫 대신 萬만 치환. 같은 원인으로
    //  2026-08-01에 "안녕"이 寧이 되던 것을 compositionend에서만 막았었다)
    const composingWindow = composing || compositionText !== '';
    const baseBuffer = composingWindow ? compositionBase : adapter.getTrailingHangulBuffer();
    return mergeTrailingBuffer(baseBuffer, compositionText);
  }

  /**
   * 연어 판별에 쓸 앞 문맥
   *
   * 지금 치고 있는 버퍼는 문맥이 아니므로 떼어낸다. 규칙 중에는 표제어
   * 자신이 문맥어로 등록된 것이 있어서(`市場`의 문맥어에 '시장'이 있다),
   * 버퍼를 남겨두면 그 후보에 영구 보너스가 붙는다. 떼어내면 원래 의미대로
   * "앞에서 이미 같은 단어를 썼는가"가 된다.
   *
   * 어댑터가 이 기능을 구현하지 않았으면 문맥 없이 동작한다.
   */
  function readContext(buffer: string): string {
    const text = adapter.getPrecedingText?.() ?? '';
    if (!text) return '';
    return buffer && text.endsWith(buffer) ? text.slice(0, -buffer.length) : text;
  }

  function buildFlatMap(groups: LookupResult[]): Array<{ gi: number; ci: number }> {
    const map: Array<{ gi: number; ci: number }> = [];
    for (let gi = 0; gi < groups.length; gi++) {
      for (let ci = 0; ci < groups[gi]!.candidates.length; ci++) {
        map.push({ gi, ci });
      }
    }
    return map;
  }

  /**
   * 후보 그룹 표시 순서
   *
   * engine.lookup이 이 순서로 정렬해 돌려주므로 flatMap도 같은 순서다.
   * 접힘 상태의 첫 줄은 normal(1층)만 채운다 — 2층은 펼쳐야 나온다.
   * 1층 후보가 아예 없는 전공 어휘는 lookup이 normal로 승격해 보내므로
   * 여기서 따로 다룰 필요가 없다.
   */
  const GROUP_ORDER = ['normal', 'archaic', 'inmyeong'] as const;

  function countByType(type: (typeof GROUP_ORDER)[number]): number {
    return currentGroups
      .filter((g) => (g.type ?? 'normal') === type)
      .reduce((s, g) => s + g.candidates.length, 0);
  }

  function buildRowSizes(count: number): number[] {
    const rowSizes: number[] = [];
    for (let remaining = count; remaining > 0; remaining -= EXPANDED_COLS) {
      rowSizes.push(Math.min(EXPANDED_COLS, remaining));
    }
    return rowSizes;
  }

  function getNavigationLayout(): CandidateNavigationLayout {
    return {
      // 접힘에는 최장 매칭의 1층만 — 고어·전문어도, 짧은 매칭도 끼어들지 않는다
      collapsedCount: countCollapsedCandidates(currentGroups, 9),
      rowSizes: GROUP_ORDER.flatMap((type) => buildRowSizes(countByType(type))),
    };
  }

  /** 현재 모드에서 숫자키 선택 시 flat index 계산 */
  function resolveKeyIndex(keyIdx: number): number {
    if (!expanded) return keyIdx; // 접힘: 0-8 직접 매핑
    return resolveCandidateIndex(
      { expanded, activeRow, activeCol: keyIdx },
      getNavigationLayout(),
    ) ?? -1;
  }

  /**
   * 커서에 가장 가까운, 사전에 실제로 있는 구간까지 버퍼를 좁힌다.
   *
   * engine.lookup은 commonPrefixSearch 기반이라 버퍼 앞에서부터만 매칭한다.
   * 그래서 "담철"처럼 전체가 사전에 없는 버퍼에서는 "담"의 후보만 나오고,
   * 정작 사용자가 방금 친 "철"은 접두사가 아니라 후보에 등장할 수 없다.
   *
   * 전체를 덮는 매칭이 있으면 그대로 둔다("발전소" 등 정상 경로는 영향 없음).
   * 없을 때만 앞에서부터 한 음절씩 떼어내며 커서 쪽 구간을 찾는다.
   *
   * 버퍼 자체를 좁혀야 하는 이유: commitPick이 currentBuffer 기준으로 치환
   * 범위를 잡으므로, 조회 대상과 치환 대상이 어긋나면 엉뚱한 글자를 덮어쓴다.
   */
  function narrowToLookupable(buffer: string): string {
    for (let start = 0; start < buffer.length; start++) {
      const tail = buffer.slice(start);
      if (engine.hasWord(tail)) return tail;
    }
    return buffer;
  }

  function syncState(): void {
    if (!active) {
      popup.hide();
      return;
    }

    currentBuffer = narrowToLookupable(readBuffer());

    if (!currentBuffer) {
      currentGroups = [];
      flatMap = [];
      dismissed = false;
      dismissedBuffer = '';
      popup.hide();
      return;
    }

    // dismissed 상태에서 버퍼가 바뀌면 해제
    if (dismissed && currentBuffer !== dismissedBuffer) {
      dismissed = false;
      dismissedBuffer = '';
    }

    // dismissed 상태면 팝업 표시 안 함
    if (dismissed) {
      currentGroups = [];
      flatMap = [];
      popup.hide();
      return;
    }

    const prevGroups = currentGroups;
    currentGroups = engine.lookup(currentBuffer, readContext(currentBuffer));
    flatMap = buildFlatMap(currentGroups);

    // 버퍼 내용이 바뀌었을 때만 접힘 리셋
    if (currentGroups.length !== prevGroups.length ||
        (currentGroups[0]?.word !== prevGroups[0]?.word)) {
      expanded = false;
      activeRow = 0;
      activeCol = 0;
    }

    renderPopup();
  }

  function renderPopup(): void {
    const popupState: PopupState = {
      buffer: currentBuffer,
      groups: currentGroups,
      expanded,
      activeRow,
      activeCol,
    };

    popup.render(popupState, adapter.getAnchorRect(), (pick) => {
      commitPick(pick.word, pick.hanja);
    });
  }

  function commitPick(word: string, hanja: string): void {
    if (!currentBuffer) return;

    // 확정 **전에** 문맥을 읽는다. 치환하고 나면 방금 넣은 한자가 앞 문맥에
    // 섞여, 사용 이력이 조회 때와 다른 칸에 들어간다.
    const context = readContext(currentBuffer);

    // 버퍼 전체를 (선택된 한자 + 나머지 미매칭 글자)로 치환
    // 예: 버퍼 "발전", 선택 "발"→"發" → "發전"
    const remaining = currentBuffer.slice(word.length);
    adapter.replaceTrailingBuffer(currentBuffer, hanja + remaining);

    currentBuffer = '';
    currentGroups = [];
    flatMap = [];
    popup.hide();

    target.dispatchEvent(
      new CustomEvent('jieum:commit', {
        bubbles: true,
        detail: { word, hanja, context },
      }),
    );
  }


  /**
   * 후보 확정을 예약한다 — 모든 키보드 확정 경로의 단일 출구
   *
   * 즉시 치환하지 않는 이유: IME가 조합을 끝낸 직후에는 모델이 아직 결과를
   * 흡수하지 못해 치환이 조용히 실패한다. flushPendingAction은 저장한 버퍼로
   * 후보를 재계산하고 모델과 대조하므로 그 시차를 흡수한다.
   *
   * 스스로 flush를 예약해야 하는 이유: macOS 한글 IME는 숫자키를 조합에 삼켜
   * "철2"를 한 덩어리로 커밋하고 keydown을 그 뒤에 보낸다. 그 시점엔
   * compositionend가 이미 지나갔고(그때 건 flush도 이미 소진됐고) 뒤따르는
   * input도 없어서, 여기서 걸지 않으면 확정이 영영 실행되지 않는다.
   * (실측 2026-08-01 Tauri+macOS: Enter 경로에만 예약이 있어 Enter는 되고
   *  숫자키는 숫자만 남던 것이 이 차이였다)
   *
   * flushPendingAction은 조합 중이면 스스로 물러나므로 이중 실행도 안전하다.
   */
  function scheduleCommit(globalIdx: number): void {
    pendingCommitIndex = globalIdx;
    pendingCommitBuffer = currentBuffer;
    setTimeout(flushPendingAction, 0);
  }

  function clear(): void {
    currentBuffer = '';
    currentGroups = [];
    flatMap = [];
    expanded = false;
    activeRow = 0;
    activeCol = 0;
    compositionText = '';
    popup.hide();
  }

  function flushPendingAction(): void {
    if (composing) return;

    if (pendingClear) {
      pendingClear = false;
      pendingCommitIndex = null;
      pendingCommitBuffer = null;
      clear();
      return;
    }

    if (pendingCommitIndex !== null) {
      const flatIdx = pendingCommitIndex;
      const savedBuffer = pendingCommitBuffer;
      pendingCommitIndex = null;
      pendingCommitBuffer = null;

      if (!savedBuffer) {
        syncState();
        const entry = flatMap[flatIdx];
        if (entry) {
          const group = currentGroups[entry.gi];
          const candidate = group?.candidates[entry.ci];
          if (group && candidate) commitPick(group.word, candidate.hanja);
        }
        return;
      }

      // "삽입 후 제거" 전략:
      // preventDefault가 실패하여 숫자가 DOM에 삽입된 경우 감지 + 제거
      // readBuffer()는 compositionText를 포함하므로 adapter에서 직접 확인
      //
      // 비교 전에 narrowToLookupable을 거친다. savedBuffer는 좁혀진 버퍼("철")인
      // 반면 adapter는 커서 앞 한글 전체("담철")를 주므로, 그대로 비교하면 늘
      // 불일치로 보여 멀쩡한 글자를 지운다.
      const rawTrailing = adapter.getTrailingHangulBuffer();
      if (narrowToLookupable(rawTrailing) !== savedBuffer) {
        adapter.removeCharBeforeCursor();
      }

      // 저장된 버퍼로 후보를 다시 계산하여 커밋
      //
      // 문맥도 함께 넘겨야 한다. 사용자가 화면에서 본 순서는 문맥 보너스가
      // 반영된 것이라, 여기서 문맥을 빼면 같은 숫자키가 다른 후보를 확정한다.
      const context = readContext(savedBuffer);
      const groups = engine.lookup(savedBuffer, context);
      const savedFlatMap = buildFlatMap(groups);
      const globalIdx = flatIdx; // 항상 global index
      const entry = savedFlatMap[globalIdx];
      if (entry) {
        const group = groups[entry.gi];
        const candidate = group?.candidates[entry.ci];
        if (group && candidate) {
          const remaining = savedBuffer.slice(group.word.length);
          adapter.replaceTrailingBuffer(savedBuffer, candidate.hanja + remaining);
          popup.hide();
          currentBuffer = '';
          currentGroups = [];
          flatMap = [];

          target.dispatchEvent(
            new CustomEvent('jieum:commit', {
              bubbles: true,
              detail: { word: group.word, hanja: candidate.hanja, context },
            }),
          );
        }
      }
      return;
    }
  }

  // ─── 이벤트 핸들러 ───

  function onCompositionStart(): void {
    // 조합 텍스트가 아직 문서에 들어가기 전이므로 지금 읽어야 확정분만 잡힌다
    compositionBase = adapter.getTrailingHangulBuffer();
    composing = true;
    compositionText = '';
  }

  function onCompositionUpdate(e: CompositionEvent): void {
    compositionText = sanitizeHangul(e.data ?? '');
    syncState();
  }

  function onCompositionEnd(e: CompositionEvent): void {
    compositionText = sanitizeHangul(e.data ?? '');

    // composing을 내리기 전에 동기화한다.
    //
    // IME는 숫자키를 조합 안으로 삼켜 "녕1"을 통째로 커밋한다. 그러면 문서
    // 끝이 한글이 아니게 되어, 모델을 기준으로 읽는 순간 커서 앞 확정분이
    // 통째로 사라진다. 조합 시작 시점에 붙잡아 둔 base를 그대로 쓰면
    // 그 구간을 무사히 건너뛴다.
    // (실측 2026-08-01: end data="녕1" model="" → 버퍼가 "안녕"에서 "녕"으로
    //  무너져 사전에 있는 安寧 대신 寧만 치환됐다)
    syncState();
    composing = false;

    setTimeout(() => {
      flushPendingAction();
      compositionText = '';
    }, 0);
  }

  function onBeforeInput(e: InputEvent): void {
    if (!active || !currentBuffer || flatMap.length === 0) return;

    // 숫자키 1~9: 후보 선택
    if (e.inputType === 'insertText' && /^[1-9]$/.test(e.data ?? '')) {
      const globalIdx = resolveKeyIndex(Number(e.data) - 1);
      if (!flatMap[globalIdx]) return;

      e.preventDefault();
      scheduleCommit(globalIdx);
      return;
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!active || !currentBuffer) return;

    const isImeComposing = composing || e.isComposing || e.keyCode === 229;

    // Tab: 1번 후보 확정
    if (e.key === 'Tab' && flatMap.length > 0) {
      e.preventDefault();
      scheduleCommit(0);
      return;
    }

    // Escape: 취소 + dismissed 설정
    if (e.key === 'Escape') {
      e.preventDefault();
      dismissed = true;
      dismissedBuffer = currentBuffer;
      if (isImeComposing) {
        pendingClear = true;
        pendingCommitIndex = null;
        pendingCommitBuffer = null;
        // 확정과 같은 이유로 스스로 flush를 예약한다 — 조합이 이미 끝난 뒤
        // 키가 오면 이걸 깨울 이벤트가 뒤에 없어 pendingClear가 남는다
        setTimeout(flushPendingAction, 0);
      } else {
        clear();
      }
      return;
    }

    // 숫자키 1~9: 해당 후보 확정
    if (/^[1-9]$/.test(e.key) && flatMap.length > 0) {
      const globalIdx = resolveKeyIndex(Number(e.key) - 1);
      if (flatMap[globalIdx]) {
        e.preventDefault();
        scheduleCommit(globalIdx);
      }
      return;
    }

    const navigationKeys: readonly CandidateNavigationKey[] = [
      'ArrowDown',
      'ArrowUp',
      'ArrowLeft',
      'ArrowRight',
      'Enter',
    ];
    if (navigationKeys.includes(e.key as CandidateNavigationKey) && flatMap.length > 0) {
      // 조합 중에는 같은 키가 두 번 온다 — IME용(keyCode 229)과 실제 키.
      // (실측 2026-08-01, Chrome + macOS 한글 IME: 229 → 39/13, 간격 0ms)
      // 둘 다 처리하면 후보가 두 칸씩 건너뛴다.
      //
      // 229는 IME가 조합을 마무리하는 이벤트이므로 가로채지 않는다. 막으면
      // ProseMirror가 DOM 변경을 모델로 흡수하지 못해, 화면에는 글자가 있는데
      // 모델은 빈 상태가 된다. 그러면 확정 시 findTrailingBufferRange가
      // range=null을 반환해 치환이 조용히 실패한다.
      // (실측: caretText="" range=null → 후보를 골라도 변환되지 않음)
      //
      // 상태 전이와 preventDefault는 뒤따르는 실제 키 이벤트에서 한 번만 한다.
      if (e.keyCode === 229) return;

      e.preventDefault();
      const transition = transitionCandidateNavigation(
        { expanded, activeRow, activeCol },
        e.key as CandidateNavigationKey,
        getNavigationLayout(),
      );

      if (transition.commitIndex !== null) {
        scheduleCommit(transition.commitIndex);
      } else {
        expanded = transition.state.expanded;
        activeRow = transition.state.activeRow;
        activeCol = transition.state.activeCol;
        renderPopup();
      }
      return;
    }
  }

  function onInput(): void {
    syncState();
    flushPendingAction();
    if (!composing) {
      compositionText = '';
    }
  }

  function onBlur(): void {
    setTimeout(() => {
      if (!popup.isHovered()) {
        clear();
      }
    }, 0);
  }

  // ─── 이벤트 등록 ───

  target.addEventListener('compositionstart', onCompositionStart);
  target.addEventListener('compositionupdate', onCompositionUpdate as EventListener);
  target.addEventListener('compositionend', onCompositionEnd as EventListener);
  target.addEventListener('beforeinput', onBeforeInput as EventListener);
  // keydown만 capture 단계로 등록한다.
  //
  // ProseMirror(TipTap)는 에디터 생성 시점에 자기 keydown 핸들러를 먼저
  // 걸어두므로, 버블 단계에서는 우리 차례가 오기 전에 Enter가 이미 새 문단을
  // 만들고 커서를 옮긴 뒤다. 그 상태로 확정하면 어댑터가 빈 문단을 읽어
  // 치환이 조용히 실패한다.
  // (실측 2026-08-01: Enter → <p>민</p><p></p> 생성 후 caretText="" range=null)
  //
  // preventDefault는 아직 일어나지 않은 기본 동작만 막을 뿐, 이미 실행된 다른
  // 리스너의 결과는 되돌리지 못한다. 그래서 순서를 앞당긴다.
  target.addEventListener('keydown', onKeyDown, true);
  target.addEventListener('input', onInput);
  target.addEventListener('blur', onBlur);

  // ─── 컨트롤러 ───

  const controller: JieumController = {
    getState() {
      return { buffer: currentBuffer, groups: currentGroups, active, expanded };
    },
    setActive(value: boolean) {
      active = value;
      if (!active) {
        clear();
      }
    },
    sync() {
      syncState();
    },
    destroy() {
      target.removeEventListener('compositionstart', onCompositionStart);
      target.removeEventListener('compositionupdate', onCompositionUpdate as EventListener);
      target.removeEventListener('compositionend', onCompositionEnd as EventListener);
      target.removeEventListener('beforeinput', onBeforeInput as EventListener);
      target.removeEventListener('keydown', onKeyDown, true);
      target.removeEventListener('input', onInput);
      target.removeEventListener('blur', onBlur);
      popup.destroy();
      delete (target as any)[ATTACHED];
    },
  };

  (target as any)[ATTACHED] = controller;
  return controller;
}

/**
 * 루트 내 모든 편집 가능 요소에 jieum 부착
 */
export function attachAll(
  root: HTMLElement | Document,
  options: AttachOptions,
): JieumController[] {
  const targets = findEditableTargets(root);
  const controllers: JieumController[] = [];

  for (const target of targets) {
    const ctrl = attachEditableSurface(target, options);
    if (ctrl) controllers.push(ctrl);
  }

  return controllers;
}

/**
 * 동적으로 추가되는 편집 요소 감시 + 자동 부착
 */
export function observeEditableSurfaces(
  root: HTMLElement | Document,
  options: AttachOptions,
): MutationObserver {
  const container = root instanceof Document ? root.body : root;

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;

        // 추가된 노드 자체가 편집 가능
        if (isEditable(node)) {
          attachEditableSurface(node, options);
        }

        // 하위에 편집 가능 요소가 있는지 확인
        const editables = node.querySelectorAll<HTMLElement>(
          'input[type="text"], input[type="search"], input:not([type]), textarea, [contenteditable="true"]',
        );
        for (const el of editables) {
          attachEditableSurface(el, options);
        }
      }
    }
  });

  observer.observe(container, { childList: true, subtree: true });
  return observer;
}

function isEditable(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement) {
    return !el.type || el.type === 'text' || el.type === 'search';
  }
  if (el instanceof HTMLTextAreaElement) return true;
  return el.isContentEditable;
}
