/**
 * 사전 데이터 로더 — 바이너리 우선 + fetch + IndexedDB 캐시
 *
 * 우선순위:
 * 1. IndexedDB 캐시 (바이너리 ArrayBuffer)
 * 2. .dat 바이너리 fetch → IndexedDB 저장
 * 3. .json 폴백 (바이너리 없을 때)
 */

import type {
  ImeEntry,
  DictSnapshot,
  CollocationDict,
  CollocationRule,
} from '@jieum/core';
import { createSnapshot, loadBinary } from '@jieum/core';

const DB_NAME = 'jieum-dict';
/**
 * 3: 사전 바이너리 포맷 v2(2층 플래그) + 지문 기반 무효화 도입
 * 4: 연어 규칙 추가 — 옛 캐시에는 없어 지문이 같으면 영영 안 받는다
 *
 * 올릴 때마다 아래 onupgradeneeded가 스토어를 통째로 버린다. 지문 대조는
 * 다음 빌드부터 동작하므로, 그 이전에 쌓인 캐시를 걷어낼 창구가 따로 필요하다.
 */
const DB_VERSION = 4;
const STORE_NAME = 'files';

interface CachedEntry {
  key: string;
  data: unknown;
  fetchedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // 스토어를 새로 만든다 — DB_VERSION을 올린다는 것은 옛 캐시를
      // 더 믿을 수 없다는 뜻이다. 남겨두면 포맷이 바뀐 사전을 계속 쓴다.
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      db.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCached(db: IDBDatabase, key: string): Promise<unknown | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => {
      const entry = req.result as CachedEntry | undefined;
      resolve(entry ? entry.data : null);
    };
    req.onerror = () => reject(req.error);
  });
}

async function setCache(db: IDBDatabase, key: string, data: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const entry: CachedEntry = { key, data, fetchedAt: Date.now() };
    const req = store.put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export interface DictUrls {
  dict: string;
  compound: string;
  blocklist: string;
  binary?: string;
  /** 빌드 메타 — 캐시 무효화 지문 (jieum-meta.json) */
  meta?: string;
  /**
   * 연어 규칙 (jieum-collocation.json) — 선택
   *
   * 앞 문맥으로 동음이의 후보 순위를 바꾼다. 사전 바이너리와 따로 두는 이유는
   * 없어도 엔진이 돌기 때문이다 — 문맥 판별이 필요 없는 통합처는 이 854KB를
   * 받지 않아도 된다.
   */
  collocation?: string;
}

/**
 * 현재 배포된 사전의 지문을 가져온다
 *
 * 사전이 새로 빌드됐는지 판단하는 유일한 근거다. 메타 파일은 수백 바이트라
 * 매번 받아도 부담이 없고, 브라우저 HTTP 캐시까지 우회해야 의미가 있다.
 * 실패하면 null — 오프라인에서 캐시를 버리면 안 되므로 그대로 쓴다.
 */
async function fetchFingerprint(url: string | undefined): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const meta = await res.json() as { buildDate?: string };
    return meta.buildDate ?? null;
  } catch {
    return null;
  }
}

/**
 * 연어 규칙 로드 (선택 자산)
 *
 * 사전과 같은 지문으로 캐시를 무효화한다. 실패하면 undefined —
 * 문맥 보너스만 빠지고 나머지는 그대로 동작해야 한다.
 */
async function loadCollocation(
  url: string | undefined,
  db: IDBDatabase | null,
  fingerprint: string | null,
  stale: boolean,
): Promise<CollocationDict | undefined> {
  if (!url) return undefined;

  const toMap = (data: Record<string, CollocationRule[]>): CollocationDict =>
    new Map(Object.entries(data));

  if (db && !stale) {
    const cached = await getCached(db, 'collocation') as Record<string, CollocationRule[]> | null;
    if (cached) return toMap(cached);
  }

  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const data = await res.json() as Record<string, CollocationRule[]>;
    if (db) {
      await setCache(db, 'collocation', data);
      if (fingerprint !== null) await setCache(db, 'fingerprint', fingerprint);
    }
    return toMap(data);
  } catch {
    return undefined;
  }
}

/**
 * 사전 데이터 로드 (바이너리 우선, JSON 폴백)
 */
export async function loadDict(urls: DictUrls): Promise<DictSnapshot> {
  // 1. IndexedDB 캐시 시도
  let db: IDBDatabase | null = null;
  try {
    db = await openDB();
  } catch {
    // IndexedDB 사용 불가 → 직접 fetch
  }

  // 2. 배포된 사전의 지문 확인
  const fingerprint = await fetchFingerprint(urls.meta);

  // 3. 바이너리 캐시 확인 — 지문이 다르면 버린다
  //
  // 이 대조가 없으면 사전을 다시 빌드해도 앱이 옛 사전을 계속 쓴다.
  // 실측 2026-08-01: 2층 분리를 넣고 사전을 재빌드했는데 편집기는
  // 캐시된 옛 사전을 그대로 써서 후보 순서가 하나도 바뀌지 않았다.
  let stale = false;
  if (db) {
    const cachedFingerprint = await getCached(db, 'fingerprint') as string | null;
    stale = fingerprint !== null && cachedFingerprint !== fingerprint;

    if (!stale) {
      const cachedBinary = await getCached(db, 'binary') as ArrayBuffer | null;
      if (cachedBinary) {
        const snapshot = loadBinary(cachedBinary);
        snapshot.collocation = await loadCollocation(urls.collocation, db, fingerprint, stale);
        db.close();
        return snapshot;
      }
    }
  }

  // 3. 바이너리 fetch 시도
  if (urls.binary) {
    try {
      const res = await fetch(urls.binary);
      if (res.ok) {
        const buffer = await res.arrayBuffer();
        const snapshot = loadBinary(buffer);
        // 캐시 저장 — 지문을 함께 남겨야 다음 빌드를 알아챌 수 있다
        if (db) {
          await setCache(db, 'binary', buffer);
          if (fingerprint !== null) await setCache(db, 'fingerprint', fingerprint);
        }
        snapshot.collocation = await loadCollocation(urls.collocation, db, fingerprint, stale);
        if (db) db.close();
        return snapshot;
      }
    } catch {
      // 바이너리 실패 → JSON 폴백
    }
  }

  // 4. JSON 폴백
  const fetchJson = async <T>(url: string): Promise<T> => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`[jieum] 사전 로드 실패: ${url} (${res.status})`);
    return res.json() as Promise<T>;
  };

  const [dict, compound, blocklist, collocation] = await Promise.all([
    fetchJson<Record<string, ImeEntry[]>>(urls.dict),
    fetchJson<Record<string, string>>(urls.compound),
    fetchJson<string[]>(urls.blocklist),
    loadCollocation(urls.collocation, db, fingerprint, stale),
  ]);

  if (db) db.close();
  const snapshot = createSnapshot(dict, compound, blocklist);
  snapshot.collocation = collocation;
  return snapshot;
}

/**
 * IndexedDB 캐시 무효화
 */
export async function clearCache(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => { db.close(); resolve(); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}
