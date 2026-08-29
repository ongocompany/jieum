import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MruFile } from '../mru-file.js';

describe('사용 이력 보존', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jieum-mru-'));
    path = join(dir, 'nested', 'mru.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('기록한 것이 다시 열었을 때 남아 있다', async () => {
    const file = await MruFile.open(path, 0);
    file.store.record('시장', '市長', 1000, '市長');
    file.touch();
    await file.flush();

    const reopened = await MruFile.open(path, 0);
    expect(reopened.store.get('시장', '市長', '市長')).toMatchObject({ count: 1, at: 1000 });
  });

  it('상위 디렉터리가 없어도 만들어 쓴다', async () => {
    const file = await MruFile.open(path, 0);
    file.store.record('시장', '市場', 1000);
    file.touch();
    await file.flush();
    expect(existsSync(path)).toBe(true);
  });

  it('파일이 없으면 빈 이력으로 시작한다', async () => {
    const file = await MruFile.open(join(dir, 'none.json'), 0);
    expect(file.store.size).toBe(0);
  });

  /**
   * 깨진 이력 파일 때문에 입력기가 안 뜨면 안 된다.
   * 이력은 편의지 필수가 아니다 — 못 읽으면 버리고 처음부터 쌓으면 된다.
   */
  it('깨진 파일이면 빈 이력으로 시작한다 (던지지 않는다)', async () => {
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{이건 JSON이 아니다');
    const file = await MruFile.open(broken, 0);
    expect(file.store.size).toBe(0);
  });

  it('바뀐 것이 없으면 쓰지 않는다', async () => {
    const file = await MruFile.open(path, 0);
    await file.flush();
    expect(existsSync(path)).toBe(false);
  });

  /**
   * 임시 파일에 쓰고 이름을 바꾼다 — 쓰는 중에 죽어도 이력을 통째로 잃지 않는다.
   * 임시 파일이 남아 있으면 정리가 안 된 것이다.
   */
  it('쓰기가 끝나면 임시 파일이 남지 않는다', async () => {
    const file = await MruFile.open(path, 0);
    file.store.record('시장', '市長', 1000);
    file.touch();
    await file.flush();

    expect(existsSync(`${path}.tmp`)).toBe(false);
    const saved = JSON.parse(readFileSync(path, 'utf-8'));
    expect(saved.records).toHaveProperty('시장\t市長');
    // 감쇠 tick도 함께 남아야 한다 — 이것이 없으면 다시 열 때 모든 이력이
    // "방금 쓴 것"으로 되살아난다.
    expect(saved.tick).toBeGreaterThan(0);
  });

  it('연달아 확정해도 한 벌로 묶여 쓰인다', async () => {
    const file = await MruFile.open(path, 5);
    for (let i = 0; i < 10; i++) {
      file.store.record('시장', '市長', 1000 + i);
      file.touch();
    }
    await file.flush();

    const reopened = await MruFile.open(path, 0);
    expect(reopened.store.get('시장', '市長')?.count).toBe(10);
  });
});
