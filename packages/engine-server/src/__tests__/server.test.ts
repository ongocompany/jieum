import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JieumEngine, MruStore, createSnapshot } from '@jieum/core';
import { EngineClient } from '../client.js';
import { createEngineServer, type EngineServer } from '../server.js';
import { UserWordFile } from '../user-words-file.js';
import { PROTOCOL_VERSION, type ErrorReply, type LookupReply } from '../protocol.js';

/**
 * 작은 합성 사전.
 *
 * 실사전(31MB)은 여기서 쓰지 않는다 — 이 시험이 검증하는 것은 **와이어 계약**이지
 * 랭킹 품질이 아니다. 랭킹은 core의 시험이 이미 지킨다.
 */
function makeEngine(options?: { mru?: MruStore }): JieumEngine {
  const snapshot = createSnapshot(
    {
      시장: [
        { h: '市場', f: 80, l: 4 },
        { h: '市長', f: 60, l: 4 },
      ],
      시: [{ h: '市', f: 50, l: 5, m: '저자' }],
      // "시" + 조사 "도"로 갈리는 표제어. 길이가 다른 그룹이 **함께** 살아남는
      // 경우를 만들려면 짧은 쪽 뒤에 남는 꼬리가 조사여야 한다 (isHeadwordTail)
      시도: [{ h: '試圖', f: 70, l: 4 }],
      발전: [{ h: '發展', f: 90, l: 4 }],
      발전소: [{ h: '發電所', f: 70, l: 4 }],
    },
    {},
    ['그것'],
    {
      // 양쪽 문맥에 규칙을 둔다 — 문맥 키가 서로 다른 칸으로 갈라지는 것을
      // 검증하려면 비어 있지 않은 키가 둘 필요하다
      시장: [
        { h: '市長', c: ['선거', '당선'] },
        { h: '市場', c: ['주식', '증권'] },
      ],
    },
  );
  return new JieumEngine(snapshot, options);
}

describe('엔진 서버 (프로토콜 v1)', () => {
  let dir: string;
  let socketPath: string;
  let server: EngineServer;
  let client: EngineClient;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jieum-engine-test-'));
    socketPath = join(dir, 'engine.sock');
    server = createEngineServer({
      engine: makeEngine(),
      socketPath,
      serverVersion: '0.0.1-test',
      dictFingerprint: 'testfp',
    });
    await server.listen();
    client = new EngineClient();
    await client.connect(socketPath);
  });

  afterAll(async () => {
    client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('hello가 버전과 사전 지문을 돌려준다', async () => {
    const reply = await client.hello('test-shell/0.1');
    expect(reply.ok).toBe(true);
    expect(reply.protocolV).toBe(PROTOCOL_VERSION);
    expect(reply.serverVersion).toBe('0.0.1-test');
    expect(reply.dictFingerprint).toBe('testfp');
  });

  it('ping이 가동 시간과 메모리를 돌려준다', async () => {
    const reply = await client.ping();
    expect(reply.ok).toBe(true);
    expect(reply.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(reply.rssBytes).toBeGreaterThan(0);
  });

  it('lookup이 길이별 후보 그룹을 돌려준다', async () => {
    // "도"가 조사라 짧은 표제어 "시"가 함께 살아남는다 — 길이가 다른 그룹이
    // 소켓 너머로 실려 오는지 보려면 그런 입력이어야 한다.
    // ("발전소"로는 이제 한 그룹뿐이다. 지나간 표제어는 core가 걸러낸다)
    const reply = await client.lookup('시도');
    expect(reply?.ok).toBe(true);
    expect(reply!.groups.map((g) => g.word)).toEqual(['시도', '시']);
    expect(reply!.groups[0]!.candidates[0]!.hanja).toBe('試圖');
  });

  it('지나쳐 간 표제어는 그룹에서 빠진다', async () => {
    // 회귀 가드 — "말러9번"이 "妺러번"이 되던 결함이 프로토콜 경계에서도 막혀야 한다
    const reply = await client.lookup('발전소');
    expect(reply!.groups.map((g) => g.word)).toEqual(['발전소']);
    expect(reply!.groups[0]!.candidates[0]!.hanja).toBe('發電所');
  });

  it('앞 문맥이 후보 순위를 바꾼다 (연어가 소켓 너머에서도 산다)', async () => {
    const plain = await client.lookup('시장');
    expect(plain!.groups[0]!.candidates[0]!.hanja).toBe('市場');

    const withContext = await client.lookup('시장', '이번 선거에서 ');
    expect(withContext!.groups[0]!.candidates[0]!.hanja).toBe('市長');
    expect(withContext!.groups[0]!.candidates[0]!.collocation).toBeGreaterThan(0);
  });

  it('블록리스트 단어는 후보를 내지 않는다', async () => {
    const reply = await client.lookup('그것');
    expect(reply!.groups.every((g) => g.word !== '그것')).toBe(true);
  });

  it('lookup 토큰은 단조 증가한다 (latest-wins 판정 근거)', async () => {
    const first = await client.lookup('시');
    const second = await client.lookup('시장');
    expect(second!.token).toBeGreaterThan(first!.token);
  });

  it('한글이 소켓 왕복에서 손상되지 않는다', async () => {
    const reply = await client.lookup('시');
    expect(reply!.groups[0]!.word).toBe('시');
    expect(reply!.groups[0]!.candidates[0]!.meaning).toBe('저자');
  });

  it('프로토콜 버전이 다르면 조용히 넘어가지 않고 실패한다', async () => {
    const reply = (await client.sendRaw({
      v: 99,
      op: 'ping',
    })) as ErrorReply;
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('version_mismatch');
  });

  it('버퍼가 문자열이 아니면 bad_request로 답한다', async () => {
    const reply = (await client.sendRaw({
      v: PROTOCOL_VERSION,
      op: 'lookup',
      buffer: 42,
    })) as ErrorReply;
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('bad_request');
  });

  it('조회가 그룹마다 문맥 키를 실어 보낸다', async () => {
    const reply = await client.lookup('시장', '이번 선거에서 ');
    expect(reply!.groups[0]!.contextKey).toBe('市長');

    const plain = await client.lookup('시장');
    expect(plain!.groups[0]!.contextKey).toBeUndefined();
  });

  it('세션을 열고 닫는다', async () => {
    const sessionId = await client.sessionOpen();
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(client.sessionClose(sessionId)).resolves.toBeUndefined();
  });

  it('sessionClose에 문자열이 아닌 것을 주면 거절한다', async () => {
    const reply = (await client.sendRaw({
      v: PROTOCOL_VERSION,
      op: 'sessionClose',
      sessionId: 42,
    })) as ErrorReply;
    expect(reply.error.code).toBe('bad_request');
  });

  it('빈 headword·hanja로 확정하려 하면 거절한다', async () => {
    for (const payload of [
      { headword: '', hanja: '市長' },
      { headword: '시장', hanja: '' },
    ]) {
      const reply = (await client.sendRaw({
        v: PROTOCOL_VERSION,
        op: 'commit',
        ...payload,
      })) as ErrorReply;
      expect(reply.ok).toBe(false);
      expect(reply.error.code).toBe('bad_request');
    }
  });

  it('연결이 여러 개여도 토큰은 연결마다 따로 센다', async () => {
    const other = new EngineClient();
    await other.connect(socketPath);
    const reply = (await other.lookup('시')) as LookupReply;
    expect(reply.token).toBe(1);
    other.close();
  });

  /**
   * 회귀 가드 — 이것이 깨지면 엔진이 SIGTERM을 무시한다.
   *
   * `server.close()`는 열린 연결이 전부 닫혀야 콜백을 부른다. 입력기는 연결을 계속
   * 붙들고 있으므로, close가 연결을 직접 끊지 않으면 종료 처리기가 영영 안 끝나고
   * 프로세스가 죽지 않는다. 실제로 그랬다(형: "터미널에서 죽였는데도 계속 작동하는데?").
   */
  it('연결이 붙어 있어도 close가 끝난다', async () => {
    const closeDir = mkdtempSync(join(tmpdir(), 'jieum-engine-close-'));
    const closePath = join(closeDir, 'engine.sock');
    const target = createEngineServer({
      engine: makeEngine(),
      socketPath: closePath,
      serverVersion: '0.0.1-test',
      dictFingerprint: 'testfp',
    });
    await target.listen();

    const holder = new EngineClient();
    await holder.connect(closePath);
    expect((await holder.ping()).ok).toBe(true);

    // 연결을 열어 둔 채로 닫는다. 상한 안에 끝나야 한다.
    await expect(
      Promise.race([
        target.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('close가 끝나지 않았다')), 2000)),
      ]),
    ).resolves.toBeUndefined();

    holder.close();
    rmSync(closeDir, { recursive: true, force: true });
  });

  it('이미 서버가 도는 소켓을 다시 잡으려 하면 거절한다', async () => {
    const dup = createEngineServer({
      engine: makeEngine(),
      socketPath,
      serverVersion: '0.0.1-test',
      dictFingerprint: 'testfp',
    });
    await expect(dup.listen()).rejects.toThrow(/이미 엔진 서버가 돌고 있다/);
  });
});

/**
 * 확정이 다음 조회를 바꾼다 — 소켓 너머에서도.
 *
 * 이것이 M2의 제품적 알맹이다: 한 번 고른 것이 같은 문맥에서 다음에 1번으로 온다.
 */
describe('확정과 사용 이력 (소켓 왕복)', () => {
  let dir: string;
  let server: EngineServer;
  let client: EngineClient;

  // ⚠️ 시험마다 서버를 새로 세운다. 사용 이력은 상태이고, 확정하는 시험들이
  // 서버를 공유하면 앞 시험이 남긴 이력이 뒤 시험의 순위를 바꾼다 — 실제로
  // 여기서 당했다(앞 시험이 표제어 칸에 남긴 이력이 뒤 시험을 통과시켰다).
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jieum-engine-commit-'));
    const socketPath = join(dir, 'engine.sock');
    server = createEngineServer({
      // 확정을 기록하려면 이력 저장소가 있어야 한다 — 없으면 조용히 버려진다
      engine: makeEngine({ mru: new MruStore() }),
      socketPath,
      serverVersion: '0.0.1-test',
      dictFingerprint: 'testfp',
    });
    await server.listen();
    client = new EngineClient();
    await client.connect(socketPath);
  });

  afterEach(async () => {
    client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('고른 것이 같은 문맥의 다음 조회에서 1번이 된다', async () => {
    const context = '주식과 채권 등 ';

    const before = await client.lookup('시장', context);
    expect(before!.groups[0]!.candidates[0]!.hanja).toBe('市場');

    // 사용자가 규칙과 다르게 고른다
    await client.commit('시장', '市長', before!.groups[0]!.contextKey);

    const after = await client.lookup('시장', context);
    expect(after!.groups[0]!.candidates[0]!.hanja).toBe('市長');
  });

  /**
   * 회귀 가드 — 확정 시점에 문맥을 다시 읽으면 깨진다.
   *
   * 조회가 준 키로 기록했으므로, 확정 뒤 커서가 다른 문맥으로 옮겨가도 그 문맥의
   * 순위는 연어 규칙이 계속 결정해야 한다.
   */
  it('한 문맥에서 고른 것이 다른 문맥으로 번지지 않는다', async () => {
    const looked = await client.lookup('시장', '이번 선거에서 ');
    expect(looked!.groups[0]!.contextKey).toBe('市長');
    await client.commit('시장', '市長', looked!.groups[0]!.contextKey);

    // 연어가 市場을 지목하는 문맥은 흔들리지 않아야 한다
    const other = await client.lookup('시장', '주식과 채권 등 ');
    expect(other!.groups[0]!.contextKey).toBe('市場');
    expect(other!.groups[0]!.candidates[0]!.hanja).toBe('市場');
  });

  it('문맥 없이 고른 이력은 문맥이 붙어도 쓰인다 (폴백)', async () => {
    const plain = await client.lookup('시장');
    expect(plain!.groups[0]!.contextKey).toBeUndefined();
    await client.commit('시장', '市長', plain!.groups[0]!.contextKey);

    // 표제어 칸에 쌓였으므로 문맥 칸이 빈 조회에서 쓰인다
    const again = await client.lookup('시장');
    expect(again!.groups[0]!.candidates[0]!.hanja).toBe('市長');
  });
});

describe('죽은 소켓 파일 정리', () => {
  /**
   * 엔진이 크래시하면 소켓 파일(inode)만 남고 그 뒤 기동이 EADDRINUSE로 죽는다.
   * 사용자에게는 "입력기가 갑자기 제안을 못 한다"로 보이고, 원인은 파일 하나다.
   *
   * 아무도 듣고 있지 않은 경로를 시체로 흉내낸다 — 서버는 연결을 시도해 보고
   * 응답이 없으면 치워야 한다.
   */
  it('아무도 듣지 않는 소켓 파일이 남아 있으면 치우고 기동한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jieum-engine-stale-'));
    const socketPath = join(dir, 'engine.sock');
    writeFileSync(socketPath, '');
    expect(existsSync(socketPath)).toBe(true);

    const server = createEngineServer({
      engine: makeEngine(),
      socketPath,
      serverVersion: '0.0.1-test',
      dictFingerprint: 'testfp',
    });
    await expect(server.listen()).resolves.toBe(socketPath);

    // 실제로 듣고 있는지까지 확인한다 (파일만 갈아치우고 끝나면 의미가 없다)
    const client = new EngineClient();
    await client.connect(socketPath);
    expect((await client.ping()).ok).toBe(true);

    client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('사용자 조합 학습 (와이어)', () => {
  let dir: string;
  let socketPath: string;
  let server: EngineServer;
  let client: EngineClient;
  let sessionId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jieum-userword-test-'));
    socketPath = join(dir, 'engine.sock');
    const engine = makeEngine();
    const userWordFile = await UserWordFile.open(join(dir, 'user-words.json'));
    engine.setUserWords(userWordFile.store);
    server = createEngineServer({
      engine,
      socketPath,
      serverVersion: '0.0.1-test',
      dictFingerprint: 'testfp',
      userWordFile,
    });
    await server.listen();
    client = new EngineClient();
    await client.connect(socketPath);
    sessionId = await client.sessionOpen();
  });

  afterEach(async () => {
    client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('낱자를 이어 확정하면 다음 조회에서 조합이 맨 위에 온다', async () => {
    await client.lookup('김', '', sessionId);
    await client.commit('김', '金', undefined, sessionId);
    await client.lookup('홍', '앞글 金', sessionId);
    await client.commit('홍', '洪', undefined, sessionId);

    const reply = await client.lookup('김홍', '', sessionId);
    expect(reply!.groups[0]!.candidates[0]!.hanja).toBe('金洪');
    expect(reply!.groups[0]!.candidates[0]!.source).toBe('user');
  });

  it('앞 문맥이 끊기면 배우지 않는다', async () => {
    await client.lookup('김', '', sessionId);
    await client.commit('김', '金', undefined, sessionId);
    await client.lookup('홍', '전혀 다른 자리', sessionId);
    await client.commit('홍', '洪', undefined, sessionId);

    const reply = await client.lookup('김홍', '', sessionId);
    expect(reply!.groups.some((g) => g.candidates.some((c) => c.source === 'user'))).toBe(false);
  });

  it('지우면 다음 조회에서 사라진다', async () => {
    await client.lookup('김', '', sessionId);
    await client.commit('김', '金', undefined, sessionId);
    await client.lookup('홍', '앞글 金', sessionId);
    await client.commit('홍', '洪', undefined, sessionId);

    expect(await client.forgetUserWord('김홍', '金洪')).toBe(true);
    const reply = await client.lookup('김홍', '', sessionId);
    expect(reply!.groups.some((g) => g.candidates.some((c) => c.source === 'user'))).toBe(false);
  });

  it('없는 조합을 지우면 false다', async () => {
    expect(await client.forgetUserWord('없는것', '無物')).toBe(false);
  });

  it('배운 즉시 파일에 남는다', async () => {
    await client.lookup('김', '', sessionId);
    await client.commit('김', '金', undefined, sessionId);
    await client.lookup('홍', '앞글 金', sessionId);
    await client.commit('홍', '洪', undefined, sessionId);

    // 즉시 저장이므로 기다리지 않고도 곧 파일이 생긴다 (설계 §5.4)
    await new Promise((resolve) => setTimeout(resolve, 50));
    const saved = JSON.parse(readFileSync(join(dir, 'user-words.json'), 'utf-8'));
    expect(Object.keys(saved.records)).toContain('김홍\t金洪');
  });
});
