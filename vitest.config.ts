import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@trayvi/accounts': fileURLToPath(
        new URL('./modules/accounts/src/index.ts', import.meta.url),
      ),
      '@trayvi/config': fileURLToPath(new URL('./packages/config/src/index.ts', import.meta.url)),
      '@trayvi/identity': fileURLToPath(
        new URL('./modules/identity/src/index.ts', import.meta.url),
      ),
      '@trayvi/observability': fileURLToPath(
        new URL('./packages/observability/src/index.ts', import.meta.url),
      ),
      '@trayvi/test-support': fileURLToPath(
        new URL('./packages/test-support/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    root,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      exclude: ['**/dist/**', '**/test/**', '**/*.d.ts', 'scripts/**'],
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['**/*.unit.test.ts'],
          testTimeout: 10_000,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['**/*.integration.test.ts'],
          hookTimeout: 30_000,
          testTimeout: 30_000,
          sequence: { concurrent: false },
        },
      },
    ],
  },
});
