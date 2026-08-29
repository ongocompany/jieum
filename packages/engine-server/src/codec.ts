import { StringDecoder } from 'node:string_decoder';

/**
 * NDJSON 줄 나누기
 *
 * 소켓은 줄 단위로 오지 않는다. 한 chunk에 여러 줄이 들어오기도 하고, 한 줄이 여러
 * chunk에 걸치기도 한다.
 *
 * ⚠️ `chunk.toString('utf8')`을 그대로 쓰면 안 된다. TCP/unix 소켓의 chunk 경계는
 * 바이트 단위라 **한글 3바이트 중간을 자를 수 있고**, 그 chunk를 단독으로 디코딩하면
 * 잘린 조각이 U+FFFD로 바뀌어 영영 복구되지 않는다. 지음이 주고받는 것이 대부분
 * 한글이라 이건 가정이 아니라 확실히 일어난다.
 *
 * {@link StringDecoder}가 불완전한 멀티바이트 시퀀스를 내부에 들고 있다가 다음
 * chunk와 이어 붙인다.
 */
export class LineDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  /**
   * chunk를 받아 완성된 줄들을 돌려준다. 마지막 미완성 줄은 내부에 남는다.
   *
   * @param maxLineBytes 한 줄 상한. 넘으면 던진다 — 개행이 없는 쓰레기 스트림이
   *   메모리를 무한정 먹는 것을 막는다.
   */
  push(chunk: Buffer, maxLineBytes = 4 * 1024 * 1024): string[] {
    this.pending += this.decoder.write(chunk);

    const lines: string[] = [];
    let start = 0;
    let idx: number;
    while ((idx = this.pending.indexOf('\n', start)) !== -1) {
      const line = this.pending.slice(start, idx);
      start = idx + 1;
      // \r\n으로 오는 클라이언트도 받아준다
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (trimmed.length > 0) lines.push(trimmed);
    }
    this.pending = start > 0 ? this.pending.slice(start) : this.pending;

    if (this.pending.length > maxLineBytes) {
      this.pending = '';
      throw new Error(`[jieum] 줄 하나가 ${maxLineBytes}바이트를 넘었다`);
    }

    return lines;
  }
}

/** 응답 한 건을 와이어 형식(개행 종결 JSON)으로 만든다 */
export function encodeLine(value: unknown): string {
  return JSON.stringify(value) + '\n';
}
