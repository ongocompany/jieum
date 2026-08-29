import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * workspace 패키지를 dist가 아니라 소스로 해석한다.
 *
 * `@jieum/core`의 package.json main은 `dist/index.js`를 가리킨다. alias가
 * 없으면 시험이 **옛 빌드 산출물을 검증한다** — core 소스를 고쳐도
 * `pnpm build`를 다시 돌리기 전까지 반영되지 않는다.
 *
 * 실제로 당했다(2026-08-01). 사용 이력을 문맥별로 나누는 변경을 넣고
 * 컨트롤러 시험을 돌렸는데, core dist가 옛 코드라 `recordChoice`의 문맥
 * 인자가 조용히 버려졌다. 시험은 "고치기 전 동작"을 정확히 재현하며
 * 실패했고, 원인을 찾는 데 코드가 아니라 빌드 상태를 의심해야 했다.
 *
 * 앱 쪽 같은 함정은 `apps/editor/vite.config.ts`가 이미 막고 있다.
 */
const pkg = (name: string) =>
  fileURLToPath(new URL(`../${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@jieum/core': pkg('core'),
    },
  },
});
