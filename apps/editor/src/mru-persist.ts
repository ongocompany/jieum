/**
 * 최근 변환 이력 저장
 *
 * 문서는 여러 번에 걸쳐 편집할 수 있으므로 창을 닫아도 이력이 유지되어야 한다.
 * 따라서 이력은 앱 전역에 저장한다.
 */

import { MruStore } from '@jieum/core';

const STORAGE_KEY = 'jieum:mru:v1';
/** 저장 지연 — 확정 때마다 직렬화하면 타이핑 흐름에 얹힌다 */
const FLUSH_DELAY_MS = 1500;

export interface MruPersistence {
  store: MruStore;
  /** 확정 직후 호출 — 저장은 뒤로 미룬다 */
  scheduleSave(): void;
  /** 창을 닫기 전 등 즉시 저장이 필요할 때 */
  saveNow(): void;
}

/**
 * localStorage에서 이력을 복원하고 저장 훅을 돌려준다.
 *
 * 저장소를 못 쓰는 환경(사생활 보호 모드 등)에서도 입력기는 동작해야 하므로
 * 실패는 조용히 삼키고 메모리 전용으로 계속 간다.
 */
export function createMruPersistence(): MruPersistence {
  let store: MruStore;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    store = raw ? MruStore.fromJSON(JSON.parse(raw)) : new MruStore();
  } catch {
    store = new MruStore();
  }

  let timer: ReturnType<typeof setTimeout> | null = null;

  function saveNow(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store.toJSON()));
    } catch {
      // 용량 초과·저장소 차단 — 이력은 편의 기능이므로 조용히 넘어간다
    }
  }

  function scheduleSave(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(saveNow, FLUSH_DELAY_MS);
  }

  // 창이 닫히거나 숨겨질 때 미뤄둔 저장을 마무리한다
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });

  return { store, scheduleSave, saveNow };
}
