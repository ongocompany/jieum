import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadSnapshotFromFiles, JieumEngine, type DictFormat } from '@jieum/core';

/** 바이너리 사전 한 장이면 표제어·복합어·블록리스트가 모두 들어 있다 */
const BINARY_FILE = 'jieum-dict.dat';
/** 바이너리가 없을 때의 대안 — 이 셋이 다 있어야 엔진을 만들 수 있다 */
const JSON_FILES = ['jieum-dict.json', 'jieum-compound.json', 'jieum-blocklist.json'];

/** 지음이 쓰는 사용자 데이터 디렉터리 */
export function appSupportDir(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Jieum');
  }
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    return appData ? join(appData, 'Jieum') : join(homedir(), 'AppData', 'Roaming', 'Jieum');
  }
  return join(homedir(), '.local', 'share', 'jieum');
}

function hasDict(dir: string): boolean {
  return existsSync(join(dir, BINARY_FILE)) || JSON_FILES.every((f) => existsSync(join(dir, f)));
}

/**
 * 사전 디렉터리를 찾는다.
 *
 * 우선순위는 "명시가 이긴다": 인자 → 환경변수 → 설치 위치 → 개발용 repo 탐색.
 * 마지막 단계가 있는 이유는 M0에서 아직 설치 절차가 없기 때문이다. 배포 시점(M4)에는
 * `.pkg`가 App Support에 사전을 깔고, repo 탐색은 개발 편의로만 남는다.
 */
export function resolveDictDir(explicit?: string): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(resolve(explicit));
  const fromEnv = process.env['JIEUM_DICT_DIR'];
  if (fromEnv) candidates.push(resolve(fromEnv));
  candidates.push(join(appSupportDir(), 'dict'));

  // 개발용: cwd에서 위로 올라가며 data/build를 찾는다
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    candidates.push(join(dir, 'data', 'build'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const c of candidates) {
    if (hasDict(c)) return c;
  }

  throw new Error(
    `[jieum] 사전을 찾지 못했다. 다음 위치를 봤다:\n  ${candidates.join('\n  ')}\n` +
      `--dict <경로> 또는 JIEUM_DICT_DIR로 지정하거나, pnpm build:dict를 먼저 돌려라.`,
  );
}

/**
 * 사전 빌드 지문
 *
 * `jieum-meta.json`은 빌드 시각과 표제어 수를 담고 있어 빌드마다 반드시 달라진다.
 * 셸이나 SDK가 캐시를 들고 있을 때 이 값이 무효화 열쇠가 된다.
 */
export function dictFingerprint(dictDir: string): string {
  const metaPath = join(dictDir, 'jieum-meta.json');
  if (!existsSync(metaPath)) return 'unknown';
  return createHash('sha256').update(readFileSync(metaPath)).digest('hex').slice(0, 12);
}

export interface LoadedDict {
  engine: JieumEngine;
  dictDir: string;
  fingerprint: string;
  /** 파일 읽기 + 스냅샷 생성 + 조회기 준비까지 걸린 시간 */
  loadMs: number;
  wordCount: number;
  /**
   * 어느 표현으로 올렸는가
   *
   * `json`이면 표제어가 Map과 Trie로 펴져 사전 하나에 540 MB를 더 쓴다.
   * 상시 데몬에서 이것이 보이면 배포에 `.dat`이 빠진 것이다.
   */
  format: DictFormat;
  /**
   * 메모리 내역.
   *
   * 상시 떠 있는 데몬이라 총량만으로는 판단할 수 없다. 사전을 올리기 전후로
   * 나눠 재서 어디가 무거운지 남긴다.
   *
   * ⚠️ 여기 값은 `process.memoryUsage().rss`다. macOS는 메모리를 압축하므로
   * 유휴 프로세스의 RSS가 실제 점유(Physical footprint)보다 훨씬 작게 나온다
   * — 같은 pid가 28 MB vs 571 MB로 갈렸다. 판단은 `vmmap --summary <pid>`로 한다.
   */
  memory: { baselineRss: number; afterSnapshotRss: number; afterEngineRss: number };
}

/** 실사전을 올린 엔진을 만든다. M0의 콜드 스타트 측정 대상이 이 함수다 */
export async function loadEngine(explicitDir?: string): Promise<LoadedDict> {
  const dictDir = resolveDictDir(explicitDir);
  const baselineRss = process.memoryUsage().rss;

  const started = performance.now();
  const snapshot = await loadSnapshotFromFiles(dictDir);
  const afterSnapshotRss = process.memoryUsage().rss;

  const engine = new JieumEngine(snapshot);
  // JSON 경로는 생성자에서 Trie를 만든다 — 여기까지가 콜드 스타트다
  const loadMs = performance.now() - started;

  return {
    engine,
    dictDir,
    fingerprint: dictFingerprint(dictDir),
    loadMs,
    wordCount: engine.dictSize,
    format: snapshot.format,
    memory: { baselineRss, afterSnapshotRss, afterEngineRss: process.memoryUsage().rss },
  };
}
