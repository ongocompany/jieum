// @vitest-environment jsdom
/**
 * IME 조합 경로 회귀 테스트
 *
 * 2026-08-01에 고친 결함 중, 근거가 주석에만 남아 되돌려지기 쉬운 두 자리를 고정한다.
 * 둘 다 "조용히 실패"하는 종류라 실측 로그 없이는 회귀를 알아채기 어렵다.
 *
 * 1. keydown capture 등록 (controller.ts의 addEventListener 세 번째 인자)
 *    ProseMirror가 먼저 등록돼 있으면 버블 차례엔 Enter가 이미 새 문단을 만든 뒤다.
 *    capture로 앞당기지 않으면 확정 시 어댑터가 빈 문단을 읽어 치환이 실패한다.
 *
 * 2. Enter 확정의 pending 경로 (즉시 commitPick 금지)
 *    조합 직후에는 ProseMirror가 결과를 아직 모델에 흡수하지 못한 상태라
 *    즉시 치환하면 range=null로 조용히 실패한다.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JieumEngine, MruStore } from '@jieum/core';
import type { DictSnapshot, ImeEntry } from '@jieum/core';
import { attachEditableSurface, type JieumController } from '../controller.js';
import type { SurfaceAdapter } from '../surface-adapter.js';
import { extractTrailingHangul, findTrailingBufferRange } from '../buffer-utils.js';

function e(h: string, f = 0, l = 0): ImeEntry {
  return { h, f, l };
}

function createSnapshot(): DictSnapshot {
  return {
    dict: new Map([
      ['담', [e('談', 50), e('潭', 30)]],
      ['철', [e('鐵', 40), e('哲', 20)]],
      // 실제 사전과 같은 조건: "안녕"은 표제어로 있고 "담철"은 없다
      ['안', [e('安', 60), e('案', 40)]],
      ['녕', [e('寧', 30)]],
      ['안녕', [e('安寧', 70)]],
    ]),
    compound: new Map(),
    blocklist: new Set<string>(),
  };
}

const ZERO_RECT = {
  x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0,
  toJSON: () => ({}),
} as DOMRect;

/**
 * 모델(ProseMirror)을 흉내내는 어댑터
 *
 * 문서 텍스트 전체를 들고 실제 어댑터와 같은 계약으로 동작한다:
 * - 한글 버퍼는 커서 앞 연속 한글만 (extractTrailingHangul)
 * - 치환 범위를 못 찾으면 **조용히 물러난다** (findTrailingBufferRange가 null)
 *
 * 버퍼를 직접 들고 있는 관대한 mock이면 두 가지 결함이 그대로 통과한다:
 * 모델이 따라잡기 전 즉시 치환, 그리고 조합에 삼켜진 숫자가 문서에 남는 상황.
 */
function createMockAdapter(initialText: string) {
  let text = initialText;
  /** 실제로 반영된 치환 */
  const replacements: Array<{ buffer: string; replacement: string }> = [];
  /** 시도했으나 범위를 못 찾아 무산된 치환 — 진단용 */
  const failedAttempts: Array<{ buffer: string; text: string }> = [];
  let removeCalls = 0;

  const adapter: SurfaceAdapter = {
    getTrailingHangulBuffer: () => extractTrailingHangul(text),
    // 실제 어댑터와 같은 계약: 한글 연속에서 끊지 않고 커서 앞 전체를 준다.
    // 조합 중인 버퍼까지 포함되므로 컨트롤러가 그것을 떼어내야 한다.
    getPrecedingText: () => text,
    getAnchorRect: () => ZERO_RECT,
    replaceTrailingBuffer: (b, r) => {
      const range = findTrailingBufferRange(text, text.length, b);
      if (!range) {
        failedAttempts.push({ buffer: b, text });
        return;
      }
      replacements.push({ buffer: b, replacement: r });
      text = text.slice(0, range.start) + r + text.slice(range.end);
    },
    removeCharBeforeCursor: () => {
      removeCalls += 1;
      text = text.slice(0, -1);
    },
  };

  return {
    adapter,
    replacements,
    failedAttempts,
    /** 모델이 조합 결과를 흡수한 시점을 시험이 지정한다 */
    setModelText: (v: string) => { text = v; },
    getText: () => text,
    getRemoveCalls: () => removeCalls,
  };
}

function keydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

function compositionEvent(type: string, data: string): CompositionEvent {
  return new CompositionEvent(type, { data, bubbles: true });
}

/**
 * 조합이 끝난 뒤 브라우저가 한 번 더 보내는 input
 *
 * 이 한 줄이 없어서 아래 「안녕 → 安寧」 테스트가 실제 결함을 통과시켰다.
 * compositionend만 보내면 그 뒤 syncState가 다시 돌지 않아, 문제가 되는 창 자체가
 * 열리지 않는다. 실제 브라우저는 반드시 보낸다.
 */
function inputEvent(data: string): InputEvent {
  return new InputEvent('input', { data, inputType: 'insertText', bubbles: true });
}

/** setTimeout(fn, 0)으로 예약된 작업이 실행될 때까지 양보 */
function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let engine: JieumEngine;
let target: HTMLElement;
let controller: JieumController | null = null;

beforeEach(() => {
  engine = new JieumEngine(createSnapshot());
  target = document.createElement('div');
  target.setAttribute('contenteditable', 'true');
  document.body.appendChild(target);
});

afterEach(() => {
  controller?.destroy();
  controller = null;
  target.remove();
});

describe('keydown capture 등록', () => {
  it('먼저 등록된 버블 리스너보다 앞서 preventDefault한다', () => {
    // ProseMirror 흉내 — 지음 부착보다 먼저 자기 keydown 핸들러를 건다
    let defaultPreventedAtBubble: boolean | null = null;
    target.addEventListener('keydown', (ev) => {
      defaultPreventedAtBubble = ev.defaultPrevented;
    });

    const mock = createMockAdapter('담');
    controller = attachEditableSurface(target, { engine, adapter: mock.adapter });
    controller!.sync();

    target.dispatchEvent(keydown('Enter', { keyCode: 13 }));

    // capture 단계에서 이미 막혔어야 한다.
    // 버블 등록으로 되돌리면 등록 순서상 우리가 뒤라 여기서 false가 된다.
    expect(defaultPreventedAtBubble).toBe(true);
  });

  it('버퍼가 없으면 키를 가로채지 않는다', () => {
    let defaultPreventedAtBubble: boolean | null = null;
    target.addEventListener('keydown', (ev) => {
      defaultPreventedAtBubble = ev.defaultPrevented;
    });

    const mock = createMockAdapter('');
    controller = attachEditableSurface(target, { engine, adapter: mock.adapter });
    controller!.sync();

    target.dispatchEvent(keydown('Enter', { keyCode: 13 }));

    expect(defaultPreventedAtBubble).toBe(false);
  });
});

describe('조합 중 버퍼 구성', () => {
  // 조합 중에는 ProseMirror 모델이 커서 앞 확정 한글을 내주지 않는 구간이 있다.
  // 실측 (2026-08-01, Tauri + macOS 한글 IME, 어댑터 반환값 파일 계측):
  //   모델버퍼 "안"   ← "안" 확정
  //   모델버퍼 ""     ← "녕" 조합 중. "안"이 사라진다
  //   치환 buf="녕" → "寧"
  // 이 ""에 compositionText를 이어붙이면 버퍼가 "녕"이 되어, 사전에 있는
  // "안녕"(安寧)을 통째로 놓치고 "녕"만 바뀐다.

  it('조합 중 모델이 확정분을 잃어도 버퍼를 유지한다 (안녕 → 安寧)', () => {
    const mock = createMockAdapter('안');
    controller = attachEditableSurface(target, { engine, adapter: mock.adapter });

    target.dispatchEvent(compositionEvent('compositionstart', ''));
    // 조합이 시작되면 모델이 커서 앞 한글을 못 내주는 구간에 들어간다
    mock.setModelText('');
    target.dispatchEvent(compositionEvent('compositionupdate', '녕'));

    expect(controller!.getState().buffer).toBe('안녕');
    expect(controller!.getState().groups[0]?.candidates[0]?.hanja).toBe('安寧');
  });

  it('사전에 없는 조합은 커서 쪽 음절로 좁힌다 (담철 → 철)', () => {
    // 사전에 없는 앞 음절은 한글로 두고, 후보가 있는 뒤 음절만 바꾼다
    const mock = createMockAdapter('담');
    controller = attachEditableSurface(target, { engine, adapter: mock.adapter });

    target.dispatchEvent(compositionEvent('compositionstart', ''));
    mock.setModelText('');
    target.dispatchEvent(compositionEvent('compositionupdate', '철'));

    expect(controller!.getState().buffer).toBe('철');
  });

  it('조합이 끝나면 다시 모델을 기준으로 읽는다', () => {
    const mock = createMockAdapter('안');
    controller = attachEditableSurface(target, { engine, adapter: mock.adapter });

    target.dispatchEvent(compositionEvent('compositionstart', ''));
    mock.setModelText('');
    target.dispatchEvent(compositionEvent('compositionupdate', '녕'));

    // 조합 확정 — 모델이 최종 결과를 흡수한다
    mock.setModelText('안녕');
    target.dispatchEvent(compositionEvent('compositionend', '녕'));

    expect(controller!.getState().buffer).toBe('안녕');
  });

  it('조합 중 확정분은 조합 시작 시점 기준이다 — 이전 조합의 잔재를 쓰지 않는다', () => {
    // "민" 확정 → "철" 조합 → 확정 → 다시 조합. 매 조합마다 base를 새로 잡아야 한다
    const mock = createMockAdapter('');
    controller = attachEditableSurface(target, { engine, adapter: mock.adapter });

    target.dispatchEvent(compositionEvent('compositionstart', ''));
    target.dispatchEvent(compositionEvent('compositionupdate', '담'));
    mock.setModelText('담');
    target.dispatchEvent(compositionEvent('compositionend', '담'));

    // 두 번째 조합 — base는 이제 "담"이어야 한다
    target.dispatchEvent(compositionEvent('compositionstart', ''));
    mock.setModelText('');
    target.dispatchEvent(compositionEvent('compositionupdate', '철'));

    // "담철"은 사전에 없으므로 커서 쪽 "철"로 좁혀진다
    expect(controller!.getState().buffer).toBe('철');
  });
});

describe('조합 중 Enter 확정 — pending 경로', () => {
  it('조합 중에는 즉시 치환하지 않고, 조합이 끝난 뒤 치환한다', async () => {
    // 모델은 아직 비어 있다 — 조합 중인 "민"은 DOM에만 있고 ProseMirror 모델에 없다
    const mock = createMockAdapter('');
    controller = attachEditableSurface(target, { engine, adapter: mock.adapter });

    target.dispatchEvent(compositionEvent('compositionstart', ''));
    target.dispatchEvent(compositionEvent('compositionupdate', '담'));

    expect(controller!.getState().buffer).toBe('담');

    // 조합 중 Enter — IME용 이벤트(keyCode 229)가 먼저, 실제 키가 뒤따른다
    target.dispatchEvent(keydown('Enter', { keyCode: 229, isComposing: true }));
    target.dispatchEvent(keydown('Enter', { keyCode: 13, isComposing: true }));

    // 모델이 조합 결과를 흡수
    mock.setModelText('담');
    target.dispatchEvent(compositionEvent('compositionend', '담'));

    await flushMacrotask();

    // 확정이 pending 경로를 거쳐 모델이 따라잡은 뒤 반영돼야 한다.
    // 즉시 치환으로 되돌리면 모델이 빈 상태일 때 시도해 조용히 무산된다.
    expect(mock.failedAttempts).toHaveLength(0);
    expect(mock.replacements).toEqual([{ buffer: '담', replacement: '談' }]);
    // 모델과 저장 버퍼가 일치하므로 "삽입 후 제거"는 발동하지 않아야 한다
    expect(mock.getRemoveCalls()).toBe(0);
  });

  it('compositionend가 오지 않아도 예약된 확정이 실행된다', async () => {
    const mock = createMockAdapter('');
    controller = attachEditableSurface(target, { engine, adapter: mock.adapter });

    target.dispatchEvent(compositionEvent('compositionstart', ''));
    target.dispatchEvent(compositionEvent('compositionupdate', '철'));

    // 조합 상태가 이미 풀린 채로 실제 키가 오는 경우 (IME 구현차)
    target.dispatchEvent(compositionEvent('compositionend', '철'));
    mock.setModelText('철');
    await flushMacrotask();

    target.dispatchEvent(keydown('Enter', { keyCode: 13 }));
    await flushMacrotask();

    expect(mock.replacements).toEqual([{ buffer: '철', replacement: '鐵' }]);
  });

  it('숫자키 확정도 예약된다 — 확정을 깨울 이벤트가 뒤에 없다', async () => {
    // 실측 시퀀스 (2026-08-01, Tauri + macOS 한글 IME):
    //   beforeinput insertFromComposition data="철2"   ← IME가 숫자를 조합에 삼켜 통째로 커밋
    //   compositionend data="철2"
    //   keydown key="2" keyCode=229 prevented=true     ← keydown이 조합 종료 뒤에 온다
    //   (이후 아무 이벤트도 오지 않는다)
    //
    // keydown에서 pending으로 예약만 하고 flush를 걸지 않으면 영영 확정되지 않는다.
    // Enter 경로에만 setTimeout이 있어 Enter는 되고 숫자키는 안 되던 것이 이 차이다.
    const mock = createMockAdapter('담');
    controller = attachEditableSurface(target, { engine, adapter: mock.adapter });

    target.dispatchEvent(compositionEvent('compositionstart', ''));
    target.dispatchEvent(compositionEvent('compositionupdate', '철'));
    expect(controller!.getState().buffer).toBe('철');

    // IME가 숫자를 조합 결과에 삼켜 "철2"를 한 덩어리로 삽입
    mock.setModelText('담철2');
    target.dispatchEvent(compositionEvent('compositionend', '철2'));

    // 실측에서 compositionend와 keydown 사이는 1ms다. 그 사이에 compositionend가
    // 예약한 flush가 이미 소진되므로, keydown이 거는 pending은 그 flush를 놓친다.
    // 이 양보를 빼면 jsdom에서는 compositionend의 flush가 keydown 뒤에 실행돼
    // 우연히 통과한다 — 실제 앱과 다른 순서다.
    await flushMacrotask();

    // keydown은 그 뒤에 온다. keyCode는 여전히 229지만 isComposing은 이미 false
    target.dispatchEvent(keydown('2', { keyCode: 229, isComposing: false }));

    await flushMacrotask();

    // 삽입된 숫자를 걷어내고 2번 후보로 치환돼야 한다
    expect(mock.getRemoveCalls()).toBe(1);
    expect(mock.replacements).toEqual([{ buffer: '철', replacement: '哲' }]);
    expect(mock.getText()).toBe('담哲');
  });

  it('두 음절 단어를 숫자키로 확정한다 (안녕 → 安寧)', async () => {
    // 실측 실패 사례 (2026-08-01):
    //   sync  raw="안녕" → "안녕" (composing=true)   ← 여기까진 정상
    //   end   data="녕1" model=""                    ← 숫자가 삼켜져 문서 끝이 "1"
    //   sync  raw="녕" → "녕" (composing=false)      ← 모델을 다시 읽어 "안"이 증발
    //   치환  buf="녕" → "寧"
    const mock = createMockAdapter('');
    controller = attachEditableSurface(target, { engine, adapter: mock.adapter });

    // 첫 음절 "안" 확정
    target.dispatchEvent(compositionEvent('compositionstart', ''));
    target.dispatchEvent(compositionEvent('compositionupdate', '안'));
    mock.setModelText('안');
    target.dispatchEvent(compositionEvent('compositionend', '안'));
    await flushMacrotask();

    // 둘째 음절 "녕" 조합 — 이 동안 버퍼는 "안녕"이어야 한다
    target.dispatchEvent(compositionEvent('compositionstart', ''));
    target.dispatchEvent(compositionEvent('compositionupdate', '녕'));
    expect(controller!.getState().buffer).toBe('안녕');

    // IME가 숫자를 조합에 삼켜 "녕1"을 통째로 커밋 → 문서는 "안녕1"
    mock.setModelText('안녕1');
    target.dispatchEvent(compositionEvent('compositionend', '녕1'));
    await flushMacrotask();

    target.dispatchEvent(keydown('1', { keyCode: 229, isComposing: false }));
    await flushMacrotask();

    // 숫자를 걷어내고 두 음절 전체를 치환해야 한다
    expect(mock.getRemoveCalls()).toBe(1);
    expect(mock.replacements).toEqual([{ buffer: '안녕', replacement: '安寧' }]);
    expect(mock.getText()).toBe('安寧');
  });

  it('조합 종료 뒤 오는 input이 버퍼를 무너뜨리지 않는다 (낭만 → 浪漫)', async () => {
    // 실측 실패 사례 (2026-08-28, 웹 데모 · Chrome):
    //   "낭만" + 1  →  "낭萬"      두 음절 표제어가 아니라 마지막 낱자만 치환됐다
    //
    // 바로 위 테스트와 시나리오가 같은데 결과가 달랐던 이유는 **이벤트 하나**다.
    // 실제 브라우저는 compositionend 다음에 input을 한 번 더 보낸다. 그때는
    // composing이 이미 false라 readBuffer가 문서를 읽는데, 문서 끝이 "1"이라
    // 커서 앞 한글이 빈 문자열이 되고, 아직 지워지지 않은 compositionText와
    // 합쳐지며 버퍼가 "낭만"에서 "만"으로 줄었다.
    //
    // compositionend는 composing을 내리기 전에 syncState를 불러 이 함정을 피하는데,
    // 그 뒤 input에는 같은 방어가 없었다. 위 테스트가 input을 보내지 않아
    // 이 창이 열리지 않았고, 그래서 결함이 초록불 아래 살아남았다.
    const mock = createMockAdapter('');
    controller = attachEditableSurface(target, { engine, adapter: mock.adapter });

    target.dispatchEvent(compositionEvent('compositionstart', ''));
    target.dispatchEvent(compositionEvent('compositionupdate', '안'));
    mock.setModelText('안');
    target.dispatchEvent(compositionEvent('compositionend', '안'));
    target.dispatchEvent(inputEvent('안'));
    await flushMacrotask();

    target.dispatchEvent(compositionEvent('compositionstart', ''));
    target.dispatchEvent(compositionEvent('compositionupdate', '녕'));
    expect(controller!.getState().buffer).toBe('안녕');

    mock.setModelText('안녕1');
    target.dispatchEvent(compositionEvent('compositionend', '녕1'));
    // ↓ 이 줄이 이 테스트의 전부다
    target.dispatchEvent(inputEvent('녕1'));
    expect(controller!.getState().buffer).toBe('안녕');

    await flushMacrotask();
    target.dispatchEvent(keydown('1', { keyCode: 229, isComposing: false }));
    await flushMacrotask();

    expect(mock.replacements).toEqual([{ buffer: '안녕', replacement: '安寧' }]);
    expect(mock.getText()).toBe('安寧');
  });

  it('IME용 keyCode 229는 상태 전이를 일으키지 않는다', () => {
    const mock = createMockAdapter('담');
    controller = attachEditableSurface(target, { engine, adapter: mock.adapter });
    controller!.sync();

    const before = controller!.getState().expanded;
    // 229만 단독으로 오면 아무 일도 없어야 한다 — 두 번 세면 후보가 두 칸씩 건너뛴다
    target.dispatchEvent(keydown('ArrowDown', { keyCode: 229, isComposing: true }));

    expect(controller!.getState().expanded).toBe(before);
  });
});

/**
 * 연어 문맥 전달
 *
 * 엔진에 문맥 판별이 있어도 컨트롤러가 앞 문맥을 넘기지 않으면 아무 일도
 * 일어나지 않는다. 실제로 편집기 입력 경로는 boundary.segment를 쓰지 않고
 * engine.lookup만 부르므로, 문맥이 닿는 자리는 여기 하나뿐이다.
 */
describe('연어 문맥 전달', () => {
  function collocationEngine(): JieumEngine {
    return new JieumEngine({
      dict: new Map([['시장', [e('市場', 100), e('市長', 15)]]]),
      compound: new Map(),
      blocklist: new Set<string>(),
      collocation: new Map([
        ['시장', [
          { h: '市長', c: ['선거', '출마'] },
          // 표제어 자신이 문맥어인 규칙 — 실제 원본에 69건 있다.
          // 버퍼를 떼어내지 않으면 이것이 늘 걸려 市場에 영구 보너스가 붙는다.
          { h: '市場', c: ['시장', '주식'] },
        ]],
      ]),
    });
  }

  async function pickFirst(text: string) {
    const mock = createMockAdapter(text);
    controller = attachEditableSurface(target, {
      engine: collocationEngine(),
      adapter: mock.adapter,
    });
    controller!.sync();
    target.dispatchEvent(keydown('1'));
    await flushMacrotask();
    return mock;
  }

  it('앞 문맥이 후보 순서를 바꾼다', async () => {
    const mock = await pickFirst('이번 선거에 출마한 시장');

    expect(mock.replacements.at(-1)?.replacement).toBe('市長');
  });

  it('문맥이 없으면 빈도 순서를 그대로 쓴다', async () => {
    const mock = await pickFirst('시장');

    expect(mock.replacements.at(-1)?.replacement).toBe('市場');
  });

  /**
   * 회귀 가드 — 지금 치고 있는 버퍼는 문맥이 아니다.
   *
   * getPrecedingText는 커서 앞 전체라 버퍼를 포함한다. 그대로 넘기면
   * 표제어 자신이 문맥어인 규칙이 항상 걸려, 문맥이 무엇이든 그 후보가
   * 이긴다. 위 "앞 문맥이 순서를 바꾼다"가 통과하는 것으로는 부족하다 —
   * 그 시험은 버퍼를 안 떼도 市長 문맥어가 더 많이 걸려 통과한다.
   */
  it('버퍼 자신은 문맥으로 세지 않는다', async () => {
    const mock = await pickFirst('선거 시장');

    // 앞 문맥은 "선거 "뿐이다. 버퍼 "시장"이 남아 있으면 市場 규칙도 걸려
    // 둘 다 1히트가 되고, 빈도 100인 市場이 이겨버린다.
    expect(mock.replacements.at(-1)?.replacement).toBe('市長');
  });
});

/**
 * 문맥별 사용 이력 (Mozc의 bigram 학습 구조)
 *
 * 편집기에서 발생했던 문맥별 MRU 회귀를 재현한다:
 * `이번 선거에 출마한 시장`에서 市長을 고르자, 다음 줄 `주식 가격이 오르는
 * 시장`까지 市長이 됐다. 이력을 표제어 단위로 담았기 때문이다.
 *
 * 이 시험은 엔진 단위 시험이 못 잡는 자리를 본다 — 확정 시점에 문맥을
 * 어느 시점에 읽어 어디로 넘기는지는 컨트롤러만 안다.
 */
describe('문맥별 사용 이력', () => {
  function setup() {
    const mru = new MruStore();
    const engine = new JieumEngine({
      dict: new Map([['시장', [e('市場', 100), e('市長', 15)]]]),
      compound: new Map(),
      blocklist: new Set<string>(),
      collocation: new Map([
        ['시장', [
          { h: '市長', c: ['선거', '출마'] },
          { h: '市場', c: ['가격', '주식'] },
        ]],
      ]),
    }, { mru });

    // 실제 앱과 같은 배선: 확정 이벤트를 받아 이력에 남긴다
    document.addEventListener('jieum:commit', (ev) => {
      const d = (ev as CustomEvent).detail as { word: string; hanja: string; context?: string };
      engine.recordChoice(d.word, d.hanja, 1000, d.context);
    });

    return engine;
  }

  async function typeAndPick(engine: JieumEngine, text: string) {
    const mock = createMockAdapter(text);
    controller?.destroy();
    controller = attachEditableSurface(target, { engine, adapter: mock.adapter });
    controller!.sync();
    target.dispatchEvent(keydown('1'));
    await flushMacrotask();
    return mock.replacements.at(-1)?.replacement;
  }

  it('한 문맥에서 고른 것이 다른 문맥으로 번지지 않는다', async () => {
    const engine = setup();

    // 형 화면 1행 — 여기서 市長을 고른다
    expect(await typeAndPick(engine, '이번 선거에 출마한 시장')).toBe('市長');

    // 형 화면 2행 — 문맥이 다르므로 연어가 다시 결정해야 한다.
    // 이력을 표제어 단위로 담으면 여기서 市長이 나온다.
    expect(await typeAndPick(engine, '주식 가격이 오르는 시장')).toBe('市場');
  });

  it('같은 문맥으로 돌아오면 고른 것이 되살아난다', async () => {
    const engine = setup();

    await typeAndPick(engine, '이번 선거에 출마한 시장');
    await typeAndPick(engine, '주식 가격이 오르는 시장');

    expect(await typeAndPick(engine, '다시 선거 이야기로 시장')).toBe('市長');
  });

  it('규칙과 다르게 골라도 그 문맥에서는 사용자가 이긴다', async () => {
    const engine = setup();

    // 연어는 이 문맥에서 市場을 지목하지만 사용자가 2번(市長)을 고른다
    const mock = createMockAdapter('주식 가격이 오르는 시장');
    controller?.destroy();
    controller = attachEditableSurface(target, { engine, adapter: mock.adapter });
    controller!.sync();
    target.dispatchEvent(keydown('2'));
    await flushMacrotask();
    expect(mock.replacements.at(-1)?.replacement).toBe('市長');

    expect(await typeAndPick(engine, '주식 가격이 오르는 시장')).toBe('市長');
  });
});
