import { describe, it, expect } from 'vitest';
import { LineDecoder, encodeLine } from '../codec.js';

describe('LineDecoder', () => {
  it('한 chunk에 든 여러 줄을 모두 돌려준다', () => {
    const d = new LineDecoder();
    const lines = d.push(Buffer.from('{"a":1}\n{"a":2}\n'));
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('미완성 줄은 다음 chunk까지 들고 있는다', () => {
    const d = new LineDecoder();
    expect(d.push(Buffer.from('{"a":'))).toEqual([]);
    expect(d.push(Buffer.from('1}\n'))).toEqual(['{"a":1}']);
  });

  /**
   * 회귀 방지: chunk 경계가 한글 UTF-8 3바이트 중간을 자르는 경우.
   *
   * `chunk.toString('utf8')`을 그대로 쓰면 잘린 조각이 U+FFFD로 바뀌어 복구되지
   * 않는다. 지음이 주고받는 건 대부분 한글이라 이건 가정이 아니라 확실히 일어난다.
   * 이 시험을 통과시키려면 StringDecoder가 필요하다 — 순진한 toString으로
   * 되돌리면 여기서 깨진다.
   */
  it('chunk 경계가 한글 바이트 중간을 잘라도 글자가 깨지지 않는다', () => {
    const payload = Buffer.from('{"buffer":"발전소"}\n', 'utf8');
    const d = new LineDecoder();

    const collected: string[] = [];
    // 1바이트씩 흘려 넣어 모든 경계를 다 밟는다
    for (const byte of payload) {
      collected.push(...d.push(Buffer.from([byte])));
    }

    expect(collected).toEqual(['{"buffer":"발전소"}']);
    expect(JSON.parse(collected[0]!).buffer).toBe('발전소');
  });

  it('빈 줄은 버린다', () => {
    const d = new LineDecoder();
    expect(d.push(Buffer.from('\n\n{"a":1}\n\n'))).toEqual(['{"a":1}']);
  });

  it('\\r\\n으로 끝나는 줄도 받는다', () => {
    const d = new LineDecoder();
    expect(d.push(Buffer.from('{"a":1}\r\n'))).toEqual(['{"a":1}']);
  });

  it('개행 없이 상한을 넘으면 던지고 버퍼를 비운다', () => {
    const d = new LineDecoder();
    expect(() => d.push(Buffer.from('x'.repeat(200)), 100)).toThrow(/바이트를 넘었다/);
    // 버려졌으므로 다음 줄은 정상 처리된다
    expect(d.push(Buffer.from('{"a":1}\n'))).toEqual(['{"a":1}']);
  });
});

describe('encodeLine', () => {
  it('개행으로 끝나는 JSON 한 줄을 만든다', () => {
    expect(encodeLine({ a: 1 })).toBe('{"a":1}\n');
  });

  it('내용에 개행이 들어가도 줄 나누기를 깨지 않는다', () => {
    const encoded = encodeLine({ text: 'a\nb' });
    expect(encoded.indexOf('\n')).toBe(encoded.length - 1);
  });
});
