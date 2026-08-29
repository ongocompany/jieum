import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import { dirname } from 'node:path';
import type { JieumEngine } from '@jieum/core';
import { LineDecoder, encodeLine } from './codec.js';
import type { MruFile } from './mru-file.js';
import type { UserWordFile } from './user-words-file.js';
import { AssemblyTracker } from './assembly.js';
import {
  PROTOCOL_VERSION,
  errorReply,
  parseEnvelope,
  type CommitRequest,
  type ForgetUserWordRequest,
  type LookupRequest,
  type Reply,
  type RequestBase,
  type SessionCloseRequest,
} from './protocol.js';

export interface EngineServerOptions {
  engine: JieumEngine;
  socketPath: string;
  serverVersion: string;
  dictFingerprint: string;
  /**
   * 진단 로그.
   *
   * ⚠️ 이 프로세스는 사용자가 치는 **모든 것**을 본다. 조회 버퍼·문맥·확정된 단어는
   * 어떤 수준에서도 로그에 넣지 않는다 (docs/07 리스크 표: 구름입력기가 입력기
   * 프로세스에 Firebase를 링크해 둔 것이 반면교사). 길이·개수만 남긴다.
   */
  log?: (message: string) => void;
  /**
   * 사용 이력 보존. 없으면 이력을 메모리에만 둔다 (시험).
   *
   * 엔진의 MruStore는 이 파일이 들고 있는 것과 **같은 인스턴스**여야 한다 —
   * 확정이 엔진에 기록되고 파일이 그것을 쓴다.
   */
  mruFile?: MruFile;
  /** 사용자 조합 저장소. 없으면 배우지 않는다 */
  userWordFile?: UserWordFile;
}

/**
 * 세션 상한
 *
 * 세션은 IMKInputController 인스턴스 하나에 하나씩 생긴다. 셸이 sessionClose를
 * 빠뜨리는 경로(앱이 강제 종료되는 등)가 반드시 있으므로 상한이 필요하다.
 * 오래 안 쓴 것부터 버린다 — 세션에 담긴 것이 없어 버려도 손실이 없다.
 */
const MAX_SESSIONS = 64;

/** 연결 하나가 들고 있는 상태 */
interface ConnectionState {
  /** 조회 번호. 클라이언트의 latest-wins 판정 근거 */
  lookupToken: number;
  /** 이 연결이 연 세션들. 연결이 끊기면 함께 사라진다 */
  sessions: Set<string>;
}

export interface EngineServer {
  listen(): Promise<string>;
  close(): Promise<void>;
  /** 지금까지 처리한 조회 수 (진단용) */
  readonly lookupCount: number;
}

/**
 * 죽은 서버가 남긴 소켓 파일을 치운다.
 *
 * unix 소켓은 프로세스가 죽어도 파일이 남아, 다음 기동의 `listen`이 EADDRINUSE로
 * 실패한다. 살아 있는 서버가 있는지는 **연결을 시도해 봐야만** 알 수 있다 —
 * 연결되면 남이 쓰는 중이고, ECONNREFUSED면 시체다.
 */
async function clearStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;

  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    const done = (result: boolean) => {
      probe.destroy();
      resolve(result);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    setTimeout(() => done(false), 500).unref?.();
  });

  if (alive) {
    throw new Error(`[jieum] 이미 엔진 서버가 돌고 있다: ${socketPath}`);
  }
  unlinkSync(socketPath);
}

export function createEngineServer(options: EngineServerOptions): EngineServer {
  const { engine, socketPath, serverVersion, dictFingerprint, mruFile, userWordFile } = options;

  /**
   * 낱자 확정이 이어진 것인지 가리는 상태. **연결이 아니라 서버 단위**다 —
   * 세션 하나가 텍스트 칸 하나이고, 그것을 넘나드는 조합은 없어야 한다.
   */
  const assembly = new AssemblyTracker();
  const log = options.log ?? (() => {});
  const startedAt = performance.now();
  let lookupCount = 0;

  /** 열린 세션. 값은 마지막으로 쓰인 시각 (LRU 정리용) */
  const sessions = new Map<string, number>();

  // 사용 이력을 담을 곳이 없으면 확정이 조용히 버려진다. 증상은 "학습이 안 된다"뿐이라
  // 원인에 닿기 어렵다 — 기동할 때 한 번 말해 둔다.
  if (!engine.hasMru) {
    log('사용 이력 저장소가 없다 — 확정을 받아도 기록되지 않는다');
  }

  function openSession(state: ConnectionState): string {
    const id = randomUUID();
    sessions.set(id, Date.now());
    state.sessions.add(id);

    if (sessions.size > MAX_SESSIONS) {
      // 가장 오래 안 쓴 것부터 버린다
      const oldest = [...sessions.entries()].sort((a, b) => a[1] - b[1]);
      const excess = sessions.size - MAX_SESSIONS;
      for (let i = 0; i < excess; i++) sessions.delete(oldest[i]![0]);
      log(`세션 상한 초과 — ${excess}개 정리`);
    }
    return id;
  }

  function touchSession(id: string | undefined): void {
    if (id && sessions.has(id)) sessions.set(id, Date.now());
  }

  function handle(req: RequestBase & Record<string, unknown>, state: ConnectionState): Reply {
    if (req.v !== PROTOCOL_VERSION) {
      return errorReply(
        req.id,
        'version_mismatch',
        `프로토콜 v${PROTOCOL_VERSION}만 받는다 (받은 값: v${String(req.v)})`,
      );
    }

    switch (req.op) {
      case 'hello':
        return {
          v: PROTOCOL_VERSION,
          id: req.id,
          ok: true,
          serverVersion,
          protocolV: PROTOCOL_VERSION,
          dictFingerprint,
        };

      case 'ping':
        return {
          v: PROTOCOL_VERSION,
          id: req.id,
          ok: true,
          uptimeMs: Math.round(performance.now() - startedAt),
          rssBytes: process.memoryUsage().rss,
        };

      case 'lookup': {
        const { buffer, precedingText, sessionId } = req as unknown as LookupRequest;
        if (typeof buffer !== 'string') {
          return errorReply(req.id, 'bad_request', 'buffer는 문자열이어야 한다');
        }
        if (precedingText !== undefined && typeof precedingText !== 'string') {
          return errorReply(req.id, 'bad_request', 'precedingText는 문자열이어야 한다');
        }
        touchSession(sessionId);
        assembly.noteLookup(sessionId, precedingText, Date.now());

        // 문맥 키는 core가 그룹마다 함께 낸다 — 셸은 그것을 들고 있다가 확정에
        // 실어 보낸다. 확정 시점에 문맥을 다시 읽는 함정을 와이어가 막는다.
        const groups = engine.lookup(buffer, precedingText);
        lookupCount++;
        return {
          v: PROTOCOL_VERSION,
          id: req.id,
          ok: true,
          token: ++state.lookupToken,
          groups,
        };
      }

      case 'sessionOpen':
        return {
          v: PROTOCOL_VERSION,
          id: req.id,
          ok: true,
          sessionId: openSession(state),
        };

      case 'sessionClose': {
        const { sessionId } = req as unknown as SessionCloseRequest;
        if (typeof sessionId !== 'string') {
          return errorReply(req.id, 'bad_request', 'sessionId는 문자열이어야 한다');
        }
        sessions.delete(sessionId);
        state.sessions.delete(sessionId);
        assembly.closeSession(sessionId);
        return { v: PROTOCOL_VERSION, id: req.id, ok: true };
      }

      case 'forgetUserWord': {
        const { reading, hanja } = req as unknown as ForgetUserWordRequest;
        if (typeof reading !== 'string' || reading.length === 0) {
          return errorReply(req.id, 'bad_request', 'reading이 비었다');
        }
        if (typeof hanja !== 'string' || hanja.length === 0) {
          return errorReply(req.id, 'bad_request', 'hanja가 비었다');
        }
        const forgotten = engine.forgetUserWord(reading, hanja);
        if (forgotten) userWordFile?.touch();
        return { v: PROTOCOL_VERSION, id: req.id, ok: true, forgotten };
      }

      case 'commit': {
        const { headword, hanja, contextKey, sessionId } = req as unknown as CommitRequest;
        if (typeof headword !== 'string' || headword.length === 0) {
          return errorReply(req.id, 'bad_request', 'headword가 비었다');
        }
        if (typeof hanja !== 'string' || hanja.length === 0) {
          return errorReply(req.id, 'bad_request', 'hanja가 비었다');
        }
        if (contextKey !== undefined && typeof contextKey !== 'string') {
          return errorReply(req.id, 'bad_request', 'contextKey는 문자열이어야 한다');
        }
        touchSession(sessionId);

        // ⚠️ 여기서 앞 문맥을 **다시 읽지 않는다**. 조회가 준 contextKey를 그대로
        // 쓴다. 조회와 확정 사이에 커서가 움직였을 수 있고, 그러면 방금 고른 것이
        // 엉뚱한 칸에 쌓여 다음 조회에서 사라진다.
        engine.recordChoiceWithContextKey(headword, hanja, contextKey);
        mruFile?.touch();

        // 낱자를 이어 확정했으면 그 조합을 배운다. 판정은 `AssemblyTracker`가 한다 —
        // 여기서 「이어졌나」를 다시 따지지 않는다.
        if (userWordFile) {
          const learned = assembly.noteCommit(sessionId, headword, hanja, Date.now());
          if (learned) {
            // 자란 조합이 짧은 것을 대신한다 — 안 지우면 긴 것을 잊어도 짧은 것이
            // 남아 또 뜬다 (`AssemblyPiece.supersedes`)
            if (learned.supersedes) {
              engine.forgetUserWord(learned.supersedes.reading, learned.supersedes.hanja);
            }
            engine.recordUserWord(learned.reading, learned.hanja);
            userWordFile.touch();
            // ⚠️ 길이만 남긴다. 내용은 어떤 수준에서도 로그에 넣지 않는다.
            log(`조합 배움: ${[...learned.reading].length}자`);
          } else {
            log(`조합 아님: ${assembly.lastSkip ?? '?'}`);
          }
        }
        return { v: PROTOCOL_VERSION, id: req.id, ok: true };
      }

      default:
        return errorReply(req.id, 'bad_request', `모르는 op: ${String(req.op)}`);
    }
  }

  /**
   * 열린 연결들.
   *
   * `server.close()`는 **모든 연결이 닫혀야** 콜백을 부른다. 입력기는 연결을 계속
   * 붙들고 있으므로, 이것을 들고 있다가 종료할 때 직접 끊어 주지 않으면 close가
   * 영영 끝나지 않는다. SIGTERM 처리기가 그 콜백을 기다리면 프로세스가
   * 종료 신호를 무시하는 것처럼 보인다.
   */
  const openSockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    openSockets.add(socket);
    const decoder = new LineDecoder();
    const state: ConnectionState = { lookupToken: 0, sessions: new Set() };
    log('클라이언트 연결됨');

    socket.on('data', (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (err) {
        log(`줄 디코딩 실패, 연결을 끊는다: ${(err as Error).message}`);
        socket.destroy();
        return;
      }

      for (const line of lines) {
        let reply: Reply;
        try {
          const parsed = parseEnvelope(JSON.parse(line));
          reply = parsed.ok
            ? handle(parsed.req, state)
            : // id를 모르면 0으로 돌려준다. 클라이언트는 짝지을 요청이 없으므로
              // 이 응답을 로그로만 쓴다.
              errorReply(0, 'bad_request', parsed.reason);
        } catch (err) {
          // 요청 내용은 로그에 넣지 않는다 (사용자가 친 글자가 들어 있다)
          reply = errorReply(0, 'bad_request', `JSON 파싱 실패: ${(err as Error).message}`);
        }
        socket.write(encodeLine(reply));
      }
    });

    socket.on('error', (err) => log(`소켓 오류: ${err.message}`));
    socket.on('close', () => {
      openSockets.delete(socket);
      // 셸이 죽으면 sessionClose가 오지 않는다. 연결이 끊긴 세션은 주인이 없다.
      for (const id of state.sessions) sessions.delete(id);
      log(`클라이언트 연결 종료 (세션 ${state.sessions.size}개 정리)`);
    });
  });

  return {
    get lookupCount() {
      return lookupCount;
    },

    async listen(): Promise<string> {
      await mkdir(dirname(socketPath), { recursive: true });
      await clearStaleSocket(socketPath);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      return socketPath;
    },

    async close(): Promise<void> {
      // 연결을 먼저 끊는다 — 안 그러면 close 콜백이 오지 않는다
      for (const socket of openSockets) socket.destroy();
      openSockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (existsSync(socketPath)) {
        try {
          unlinkSync(socketPath);
        } catch {
          // 이미 사라졌으면 그만이다
        }
      }
    },
  };
}
