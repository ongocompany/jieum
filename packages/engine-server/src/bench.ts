/**
 * 왕복 지연 측정 하네스 (TS 쪽)
 *
 * C0.3 게이트("handle→lookup→reply p99 < 5ms")의 최종 판정은 **Swift에서** 재야 한다 —
 * 실제 경로에는 IMK 이벤트 처리와 Swift의 JSON 인코딩이 더 끼기 때문이다.
 * 이 하네스는 그 전에 서버 쪽 상한을 빨리 확인하고, Swift 측정치와 비교해
 * "느린 게 서버냐 셸이냐"를 가르는 기준선을 만든다.
 *
 * 사용: pnpm --filter @jieum/engine-server bench -- --socket /tmp/jieum.sock
 */

import { join } from 'node:path';
import { EngineClient } from './client.js';
import { appSupportDir } from './dict.js';

/** 타이핑을 흉내내는 조회열 — 실제로는 한 글자씩 늘어나며 조회가 나간다 */
const TYPING_WORDS = [
  '시장',
  '발전소',
  '전기',
  '한자',
  '연구',
  '문화',
  '정치',
  '사회',
  '경제',
  '역사',
  '고전문학',
  '한국사',
  '동의보감',
  '성리학',
  '훈민정음',
];

/** 연어 판별이 걸리는 앞 문맥 — 문맥 있는 조회가 더 비싸므로 함께 잰다 */
const CONTEXTS = [
  '',
  '이번 선거에서 ',
  '주식과 채권 등 ',
  '조선 후기의 ',
  '이 논문에서 다루는 ',
];

/** 한 글자씩 늘려가며 조회하는 실제 타이핑 패턴을 만든다 */
function buildProbes(): Array<{ buffer: string; context: string }> {
  const probes: Array<{ buffer: string; context: string }> = [];
  for (const word of TYPING_WORDS) {
    for (const context of CONTEXTS) {
      for (let i = 1; i <= word.length; i++) {
        probes.push({ buffer: word.slice(0, i), context });
      }
    }
  }
  return probes;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const socketIdx = argv.indexOf('--socket');
  const socketPath =
    socketIdx >= 0
      ? argv[socketIdx + 1]!
      : (process.env['JIEUM_SOCKET'] ?? join(appSupportDir(), 'engine.sock'));

  const iterIdx = argv.indexOf('--iterations');
  const iterations = iterIdx >= 0 ? Number(argv[iterIdx + 1]) : 3000;

  const client = new EngineClient();
  await client.connect(socketPath);

  const hello = await client.hello(`bench/${process.version}`);
  if (!hello.ok) throw new Error('[지음] hello 실패');
  process.stderr.write(
    `[지음] 붙었다: server ${hello.serverVersion}, 사전 ${hello.dictFingerprint}\n`,
  );

  const probes = buildProbes();

  // 워밍업 — JIT과 사전 접근 캐시가 데워진 뒤를 재야 정상 상태 수치가 나온다
  for (let i = 0; i < Math.min(500, probes.length * 2); i++) {
    const probe = probes[i % probes.length]!;
    await client.lookup(probe.buffer, probe.context || undefined);
  }

  const samples: number[] = [];
  let payloadBytes = 0;
  let maxPayload = 0;
  let emptyReplies = 0;

  for (let i = 0; i < iterations; i++) {
    const probe = probes[i % probes.length]!;
    const started = performance.now();
    const reply = await client.lookup(probe.buffer, probe.context || undefined);
    samples.push(performance.now() - started);

    if (!reply) {
      // latest-wins로 버려진 응답. 순차 요청이므로 여기 오면 안 된다
      emptyReplies++;
      continue;
    }
    const size = Buffer.byteLength(JSON.stringify(reply));
    payloadBytes += size;
    if (size > maxPayload) maxPayload = size;
  }

  samples.sort((a, b) => a - b);
  const ping = await client.ping();

  const report = {
    socket: socketPath,
    iterations,
    probeShapes: probes.length,
    latencyMs: {
      p50: +percentile(samples, 50).toFixed(3),
      p90: +percentile(samples, 90).toFixed(3),
      p99: +percentile(samples, 99).toFixed(3),
      max: +(samples[samples.length - 1] ?? 0).toFixed(3),
      mean: +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(3),
    },
    payload: {
      meanBytes: Math.round(payloadBytes / Math.max(1, iterations - emptyReplies)),
      maxBytes: maxPayload,
    },
    server: ping.ok ? { uptimeMs: ping.uptimeMs, rssBytes: ping.rssBytes } : null,
    staleReplies: emptyReplies,
    // C0.3 게이트 판정
    gateP99Under5ms: percentile(samples, 99) < 5,
  };

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  client.close();
}

main().catch((err: unknown) => {
  process.stderr.write(`[지음] 벤치 실패: ${(err as Error).message}\n`);
  process.exit(1);
});
