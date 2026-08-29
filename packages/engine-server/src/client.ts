import net from 'node:net';
import { LineDecoder, encodeLine } from './codec.js';
import {
  PROTOCOL_VERSION,
  type HelloReply,
  type LookupReply,
  type PingReply,
  type Reply,
  type SessionOpenReply,
} from './protocol.js';

/**
 * 참조 클라이언트 (TypeScript)
 *
 * 실제 셸은 Swift로 다시 쓰지만, 프로토콜을 시험과 벤치에서 돌려 보려면 TS 쪽에도
 * 한 벌이 필요하다. 이 구현이 곧 **셸이 따라야 할 규약의 실행 가능한 명세**다:
 * 어떻게 id를 발급하고, latest-wins 토큰을 어떻게 판정하는지가 여기 적혀 있다.
 */
export class EngineClient {
  private socket?: net.Socket;
  private readonly decoder = new LineDecoder();
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (err: Error) => void }
  >();

  /** 지금까지 본 최대 lookup 토큰. 이보다 낮은 응답은 낡은 것이다 */
  private highestToken = 0;

  async connect(socketPath: string, timeoutMs = 3000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`[지음] 연결 시간 초과: ${socketPath}`));
      }, timeoutMs);

      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        this.socket = socket;
        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        socket.on('close', () => this.failAll(new Error('[지음] 연결이 끊겼다')));
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private onData(chunk: Buffer): void {
    for (const line of this.decoder.push(chunk)) {
      let reply: Reply;
      try {
        reply = JSON.parse(line) as Reply;
      } catch {
        continue;
      }
      const waiter = this.pending.get(reply.id);
      if (!waiter) continue;
      this.pending.delete(reply.id);
      waiter.resolve(reply);
    }
  }

  private failAll(err: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }

  private send(op: string, payload: Record<string, unknown> = {}): Promise<Reply> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('[지음] 연결되지 않았다'));

    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.write(encodeLine({ v: PROTOCOL_VERSION, id, op, ...payload }));
    });
  }

  /** 원문 그대로 보낸다 (잘못된 요청에 서버가 어떻게 답하는지 보는 시험용) */
  sendRaw(payload: Record<string, unknown>): Promise<Reply> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('[지음] 연결되지 않았다'));
    const id = typeof payload['id'] === 'number' ? (payload['id'] as number) : this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.write(encodeLine({ ...payload, id }));
    });
  }

  async hello(clientVersion: string): Promise<HelloReply> {
    return (await this.send('hello', { clientVersion })) as HelloReply;
  }

  async ping(): Promise<PingReply> {
    return (await this.send('ping')) as PingReply;
  }

  /**
   * 후보 조회.
   *
   * 낡은 응답(이미 본 토큰보다 작은 것)은 `null`을 돌려준다 — 셸도 같은 판정을
   * 해야 한다. 타이핑 중에는 조회가 응답보다 빨리 나가므로 순서가 뒤집힌다.
   */
  async lookup(
    buffer: string,
    precedingText?: string,
    sessionId?: string,
  ): Promise<LookupReply | null> {
    // ⚠️ 세션을 함께 보낸다. 서버가 「낱자가 이어서 쳐졌는가」를 세션 단위로 판정하기
    // 때문이다(`assembly.ts`). 규약에는 이 칸이 처음부터 있었는데 양쪽 다 안 채우고
    // 있었다 — 사용자 조합 학습을 붙이며 드러났다 (2026-08-28).
    const reply = (await this.send('lookup', { buffer, precedingText, sessionId })) as LookupReply;
    if (!reply.ok) return reply;
    if (reply.token <= this.highestToken) return null;
    this.highestToken = reply.token;
    return reply;
  }

  /** 입력 지점 하나에 세션 하나 (IMKInputController 인스턴스 단위) */
  async sessionOpen(): Promise<string> {
    const reply = (await this.send('sessionOpen')) as SessionOpenReply;
    if (!reply.ok) throw new Error('[지음] sessionOpen 실패');
    return reply.sessionId;
  }

  async sessionClose(sessionId: string): Promise<void> {
    await this.send('sessionClose', { sessionId });
  }

  /**
   * 사용자가 후보를 확정했다.
   *
   * `contextKey`는 **조회 응답의 그 그룹에서 받은 값을 그대로** 넘긴다. 여기서
   * 앞 문맥을 다시 계산하면 조회 때와 다른 칸에 기록되고, 방금 고른 것이 다음
   * 조회에서 사라진다.
   */
  async commit(
    headword: string,
    hanja: string,
    contextKey?: string,
    sessionId?: string,
  ): Promise<void> {
    await this.send('commit', { headword, hanja, contextKey, sessionId });
  }

  /**
   * 사용자가 손으로 조합을 잊는다.
   *
   * 잘못 배운 것이 계속 첫 줄에 오면 기능이 없느니만 못하다. 자동 학습만으로는 나쁜
   * 항목을 영영 막을 수 없으므로 사람의 거부권이 있어야 한다 (설계 §5.6·§6).
   */
  async forgetUserWord(reading: string, hanja: string): Promise<boolean> {
    const reply = (await this.send('forgetUserWord', { reading, hanja })) as {
      forgotten?: boolean;
    };
    return reply.forgotten === true;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.failAll(new Error('[지음] 클라이언트가 닫혔다'));
  }
}
