/**
 * jieum Web SDK — <script> 한 줄로 한자 입력기 임베드
 *
 * 사용법:
 *   <script src="https://cdn.example.com/jieum.iife.js"></script>
 *   <script>
 *     Jieum.init({ dictUrl: '/data/' }).then(() => {
 *       console.log('jieum 준비 완료!');
 *     });
 *   </script>
 *
 * 또는 ES module:
 *   import { init } from '@jieum/sdk';
 *   await init({ dictUrl: '/data/' });
 */

import { JieumEngine } from '@jieum/core';
import type { DictSnapshot, LookupResult } from '@jieum/core';
import {
  attachEditableSurface,
  attachAll as browserAttachAll,
  observeEditableSurfaces,
  type JieumController,
} from '@jieum/browser';
import { loadDict, clearCache, type DictUrls } from './dict-loader.js';

// --- 타입 ---

export interface JieumInitOptions {
  /** 사전 데이터 디렉토리 URL (끝에 / 포함) */
  dictUrl: string;
  /** 초기 부착 대상 (CSS 셀렉터 또는 요소) */
  target?: string | HTMLElement | HTMLElement[];
  /** true면 페이지 내 모든 editable 요소에 자동 부착 (기본: false) */
  autoAttach?: boolean;
  /** true면 동적 추가 요소도 자동 감지 (기본: autoAttach과 동일) */
  observe?: boolean;
}

export interface JieumInstance {
  /** 엔진 인스턴스 */
  engine: JieumEngine;
  /** 특정 요소에 입력기 부착 */
  attach(target: HTMLElement): JieumController | null;
  /** 페이지 내 모든 editable 요소에 부착 */
  attachAll(): void;
  /** 이벤트 리스너 등록 */
  on(event: 'convert', callback: (detail: ConvertEventDetail) => void): void;
  /** 이벤트 리스너 해제 */
  off(event: 'convert', callback: (detail: ConvertEventDetail) => void): void;
  /** IndexedDB 사전 캐시 삭제 */
  clearCache(): Promise<void>;
  /** 사전 데이터 스냅샷 */
  snapshot: DictSnapshot;
}

export interface ConvertEventDetail {
  word: string;
  hanja: string;
  source: HTMLElement;
  /**
   * 확정 시점의 앞 문맥
   *
   * 사용 이력을 문맥별로 나눠 담으므로 `recordChoice`에 그대로 넘겨야 한다.
   * 확정 뒤에 다시 읽으면 방금 넣은 한자가 섞여 다른 칸에 기록된다.
   */
  context?: string;
}

// --- 상태 ---

let instance: JieumInstance | null = null;

// --- 공개 API ---

/**
 * jieum 초기화 — 사전 로드 + 엔진 생성 + 요소 부착
 */
export async function init(options: JieumInitOptions): Promise<JieumInstance> {
  if (instance) return instance;

  const baseUrl = options.dictUrl.endsWith('/') ? options.dictUrl : options.dictUrl + '/';

  const urls: DictUrls = {
    binary: baseUrl + 'jieum-dict.dat',
    meta: baseUrl + 'jieum-meta.json',
    dict: baseUrl + 'jieum-dict.json',
    compound: baseUrl + 'jieum-compound.json',
    blocklist: baseUrl + 'jieum-blocklist.json',
    collocation: baseUrl + 'jieum-collocation.json',
  };

  const snapshot = await loadDict(urls);
  const engine = new JieumEngine(snapshot);

  // 이벤트 핸들러 관리
  const listeners = new Set<(detail: ConvertEventDetail) => void>();

  const handleCommit = (e: Event) => {
    const detail = (e as CustomEvent).detail as ConvertEventDetail;
    for (const cb of listeners) {
      cb(detail);
    }
  };

  document.addEventListener('jieum:commit', handleCommit);

  instance = {
    engine,
    snapshot,

    attach(target: HTMLElement) {
      return attachEditableSurface(target, { engine });
    },

    attachAll() {
      browserAttachAll(document, { engine });
    },

    on(_event: 'convert', callback: (detail: ConvertEventDetail) => void) {
      listeners.add(callback);
    },

    off(_event: 'convert', callback: (detail: ConvertEventDetail) => void) {
      listeners.delete(callback);
    },

    async clearCache() {
      await clearCache();
    },
  };

  // 타겟 부착
  if (options.target) {
    if (typeof options.target === 'string') {
      const els = document.querySelectorAll<HTMLElement>(options.target);
      for (const el of els) {
        instance.attach(el);
      }
    } else if (Array.isArray(options.target)) {
      for (const el of options.target) {
        instance.attach(el);
      }
    } else {
      instance.attach(options.target);
    }
  }

  // 자동 부착
  if (options.autoAttach) {
    instance.attachAll();
  }

  // 동적 요소 감지
  if (options.observe ?? options.autoAttach) {
    observeEditableSurfaces(document, { engine });
  }

  return instance;
}

/**
 * 현재 인스턴스 반환 (init 전이면 null)
 */
export function getInstance(): JieumInstance | null {
  return instance;
}

// re-export useful types
export type { JieumController, LookupResult, DictSnapshot };
