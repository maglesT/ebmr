import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tools/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/fixtures/**'],
    environment: 'node',
  },
});
