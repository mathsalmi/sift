import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./test/vscode-mock.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // The end-to-end tests run many git commands; Windows runners are slow at that.
    testTimeout: 30_000,
  },
});
