import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'Jieum',
      fileName: 'jieum',
      formats: ['iife', 'es'],
    },
    outDir: 'dist',
    minify: 'esbuild',
    sourcemap: true,
    rollupOptions: {
      output: {
        // IIFE: window.Jieum으로 접근
        extend: true,
      },
    },
  },
});
