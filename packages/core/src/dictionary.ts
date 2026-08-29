import type {
  ImeEntry,
  ImeDict,
  CompoundDict,
  Blocklist,
  DictSnapshot,
  CollocationDict,
  CollocationRule,
} from './types.js';
import { loadBinary } from './binary-dict.js';

/**
 * JSON 객체에서 DictSnapshot 생성
 * 빌드된 jieum-dict.json, jieum-compound.json, jieum-blocklist.json을 로드한 결과를 받아 처리
 */
export function createSnapshot(
  dictData: Record<string, ImeEntry[]>,
  compoundData: Record<string, string>,
  blocklistData: string[],
  collocationData?: Record<string, CollocationRule[]>,
): DictSnapshot {
  const dict: ImeDict = new Map(Object.entries(dictData));
  const compound: CompoundDict = new Map(Object.entries(compoundData));
  const blocklist: Blocklist = new Set(blocklistData);

  // 연어는 선택 자산이다 — 없으면 문맥 보너스 없이 그대로 동작한다
  const collocation: CollocationDict | undefined = collocationData
    ? new Map(Object.entries(collocationData))
    : undefined;

  return { dict, compound, blocklist, collocation };
}

/** 어느 표현으로 사전을 올렸는지 — 메모리·기동 시간 진단에 쓴다 */
export type DictFormat = 'binary' | 'json';

/**
 * Node.js 환경에서 파일 시스템으로부터 스냅샷 로드
 *
 * **바이너리(`jieum-dict.dat`)가 있으면 그것을 쓴다.** 같은 사전의 더 나은
 * 표현이라서다 — JSON 경로는 47.9만 표제어를 Map과 Trie로 두 번 펴서 사전
 * 하나에 **540 MB**를 더 쓴다(2026-08-01 실측). 바이너리는 버퍼를 그대로
 * 들고 조회에 걸린 후보만 객체로 만든다.
 *
 * 연어는 바이너리에 담기지 않으므로 어느 경로에서든 JSON으로 따로 읽는다.
 */
export async function loadSnapshotFromFiles(
  buildDir: string,
): Promise<DictSnapshot & { format: DictFormat }> {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  // 연어는 선택 자산 — 빌드에 없으면 문맥 보너스 없이 돈다
  const collocationRaw = await readFile(
    join(buildDir, 'jieum-collocation.json'),
    'utf-8',
  ).catch(() => null);
  const collocation: CollocationDict | undefined = collocationRaw
    ? new Map(Object.entries(JSON.parse(collocationRaw) as Record<string, CollocationRule[]>))
    : undefined;

  const binary = await readFile(join(buildDir, 'jieum-dict.dat')).catch(() => null);
  if (binary) {
    // Node의 `readFile`은 작은 파일을 공유 풀에 담을 수 있다. 그때는 버퍼
    // 뒤에 남의 데이터가 붙어 있으므로 우리 구간만 떼어 낸다.
    const buffer =
      binary.byteOffset === 0 && binary.byteLength === binary.buffer.byteLength
        ? (binary.buffer as ArrayBuffer)
        : binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
    return { ...loadBinary(buffer), collocation, format: 'binary' };
  }

  const [dictRaw, compoundRaw, blocklistRaw] = await Promise.all([
    readFile(join(buildDir, 'jieum-dict.json'), 'utf-8'),
    readFile(join(buildDir, 'jieum-compound.json'), 'utf-8'),
    readFile(join(buildDir, 'jieum-blocklist.json'), 'utf-8'),
  ]);

  return {
    ...createSnapshot(
      JSON.parse(dictRaw),
      JSON.parse(compoundRaw),
      JSON.parse(blocklistRaw),
    ),
    collocation,
    format: 'json',
  };
}
