import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    /**
     * workspace 패키지를 dist가 아니라 소스로 해석한다.
     *
     * package.json의 main은 dist/index.js를 가리키므로, alias가 없으면
     * packages/*를 고쳐도 pnpm build를 다시 돌리기 전까지 앱에 반영되지 않는다.
     * vite가 링크된 의존성을 pre-bundle해 .vite/deps에 캐시하기 때문에
     * 새로고침만으로는 옛 코드가 계속 뜬다 — "고쳤는데 안 된다"의 흔한 원인이다.
     *
     * 소스를 직접 가리키면 HMR이 그대로 걸린다. 배포 빌드는 이 alias를 거쳐도
     * 같은 소스를 번들하므로 결과가 달라지지 않는다.
     */
    alias: {
      '@jieum/core': pkg('core'),
      '@jieum/browser': pkg('browser'),
      '@jieum/sdk': pkg('sdk'),
    },
  },
  server: {
    port: 5180,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
  },
});
