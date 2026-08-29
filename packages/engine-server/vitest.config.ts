import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * workspace 패키지를 dist가 아니라 소스로 해석한다.
 *
 * 이유는 `packages/browser/vitest.config.ts`에 적힌 것과 같다 — alias가 없으면
 * 시험이 옛 빌드 산출물을 검증한다. 엔진 서버는 core를 그대로 감싸는 것이 일이라
 * 이 함정에 특히 취약하다.
 */
const pkg = (name: string) =>
  fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@jieum/core': pkg('core'),
    },
  },
  test: {
    // 실사전(31MB JSON)을 올리는 시험이 있다
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
