/**
 * 서버 버전.
 *
 * package.json을 import하지 않는다 — `rootDir: src` 밖의 파일을 끌어오면 tsc가
 * 산출물 경로를 어긋나게 잡는다 (`tools/dict-builder`가 지금 그 상태로 typecheck가
 * 깨져 있다). 대신 값이 어긋나지 않는지는 시험이 지킨다: `version.test.ts`.
 */
export const SERVER_VERSION = '0.0.1';
