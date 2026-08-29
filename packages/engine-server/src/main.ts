/**
 * jieum-engine 진입점
 *
 * 플랫폼 셸(macOS IMK 입력기)이 이 프로세스를 띄우고 로컬 소켓으로 붙는다.
 * `bun build --compile`로 단일 바이너리가 된다 — 사용자 기계에 Node나 pnpm이
 * 없어도 돌아야 하기 때문이다.
 */

import { join } from 'node:path';
import { appSupportDir, loadEngine } from './dict.js';
import { MruFile } from './mru-file.js';
import { UserWordFile } from './user-words-file.js';
import { createEngineServer } from './server.js';
import { SERVER_VERSION } from './version.js';

interface Args {
  dictDir?: string;
  socketPath: string;
  /** 사용 이력 파일 */
  mruPath: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  let dictDir: string | undefined;
  let socketPath = process.env['JIEUM_SOCKET'] ?? join(appSupportDir(), 'engine.sock');
  let mruPath = process.env['JIEUM_MRU'] ?? join(appSupportDir(), 'mru.json');
  let verbose = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dict':
        dictDir = argv[++i];
        break;
      case '--socket':
        socketPath = argv[++i] ?? socketPath;
        break;
      case '--mru':
        mruPath = argv[++i] ?? mruPath;
        break;
      case '--verbose':
        verbose = true;
        break;
      case '--version':
        process.stdout.write(`${SERVER_VERSION}\n`);
        process.exit(0);
        break;
      case '--help':
        process.stdout.write(
          [
            'jieum-engine — 지음 엔진 서버',
            '',
            '  --dict <경로>    사전 디렉터리 (기본: JIEUM_DICT_DIR → App Support → repo data/build)',
            '  --socket <경로>  소켓 경로 (기본: JIEUM_SOCKET → App Support/engine.sock)',
            '  --mru <경로>     사용 이력 파일 (기본: JIEUM_MRU → App Support/mru.json)',
            '  --verbose        연결 로그를 stderr로',
            '  --version        버전 출력 후 종료',
            '',
          ].join('\n'),
        );
        process.exit(0);
        break;
      default:
        if (arg?.startsWith('--')) {
          process.stderr.write(`[지음] 모르는 인자: ${arg}\n`);
          process.exit(2);
        }
    }
  }

  return { dictDir, socketPath, mruPath, verbose };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const processStart = performance.now();

  const loaded = await loadEngine(args.dictDir);

  // 사용 이력을 복원해 엔진에 붙인다. 사전 엔트리의 97.6%가 빈도 0이라
  // 이력이 사실상 유일한 랭킹 신호다 — 기동마다 잃으면 안 된다.
  const mruFile = await MruFile.open(args.mruPath);
  loaded.engine.setMru(mruFile.store);

  // 사용자 조합은 사용 이력 옆에 둔다. 경로를 따로 받지 않는 것은 둘이 늘 같은 자리에
  // 있기 때문이다 — 하나만 옮겨 갈 이유가 없다.
  const userWordPath = args.mruPath.replace(/mru\.json$/, 'user-words.json');
  const userWordFile = await UserWordFile.open(userWordPath);
  loaded.engine.setUserWords(userWordFile.store);

  const server = createEngineServer({
    engine: loaded.engine,
    socketPath: args.socketPath,
    serverVersion: SERVER_VERSION,
    dictFingerprint: loaded.fingerprint,
    mruFile,
    userWordFile,
    log: args.verbose ? (m) => process.stderr.write(`[지음] ${m}\n`) : undefined,
  });

  await server.listen();

  // 기동 보고는 **stdout에 한 줄 JSON**으로 낸다. 셸과 측정 하네스가 파싱한다.
  // 사람이 읽을 로그는 stderr로 나가므로 섞이지 않는다.
  process.stdout.write(
    JSON.stringify({
      event: 'ready',
      serverVersion: SERVER_VERSION,
      socket: args.socketPath,
      dictDir: loaded.dictDir,
      dictFingerprint: loaded.fingerprint,
      words: loaded.wordCount,
      dictFormat: loaded.format,
      dictLoadMs: Math.round(loaded.loadMs),
      startupMs: Math.round(performance.now() - processStart),
      rssBytes: process.memoryUsage().rss,
      memory: loaded.memory,
      mru: { path: args.mruPath, records: mruFile.store.size },
      userWords: { path: userWordPath, records: userWordFile.store.size },
    }) + '\n',
  );

  /**
   * 종료.
   *
   * ⚠️ `process.on('SIGTERM')`을 등록하면 **기본 종료 동작이 사라진다.** 처리기가
   * 끝까지 가지 못하면 프로세스는 신호를 무시하는 것처럼 영영 살아 있는다.
   * 실제로 그랬다(2026-08-01): `server.close()`는 열린 연결이 다 닫혀야 콜백을
   * 부르는데 입력기가 연결을 붙들고 있어 영영 끝나지 않았고, `pkill`이 0을
   * 돌려주는데도 엔진이 살아 있었다.
   *
   * 그래서 두 겹으로 막는다: close가 연결을 직접 끊고(server.ts), 그래도 안 끝나면
   * 시간 상한이 강제로 내보낸다. 정중한 종료가 종료를 막으면 안 된다.
   */
  const shutdown = (signal: string) => {
    process.stderr.write(`[지음] ${signal} 수신, 종료한다\n`);

    const hardExit = setTimeout(() => {
      process.stderr.write('[지음] 정리가 늦어 강제 종료한다\n');
      process.exit(0);
    }, 2000);
    hardExit.unref?.();

    // 아직 안 쓴 사용 이력을 먼저 내린다 — 여기서 빠뜨리면 마지막 몇 분의
    // 선택이 사라지고, 사용자에겐 "학습이 가끔 안 된다"로 보인다.
    void mruFile
      .flush()
      .then(() => server.close())
      .catch(() => {})
      .then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(`[지음] 기동 실패: ${(err as Error).message}\n`);
  process.exit(1);
});
