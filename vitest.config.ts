import { defineConfig } from 'vitest/config';

/**
 * Three Vitest projects (Phase 2 apps plan section 3):
 *  - db: packages, tools, the gateway and the simulators, with the kernel's template database;
 *  - server: apps/tablets-server/test, with its own GMP and sandbox template databases (test-kit);
 *  - dom: ui-kit and web component tests in happy-dom, no database.
 * On 4 CPUs agents run only their own directories, e.g. `pnpm vitest run --project server apps/tablets-server/test/session`.
 */
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/fixtures/**'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'db',
          include: [
            'packages/*/test/**/*.test.ts',
            'tools/*/test/**/*.test.ts',
            'apps/site-gateway/test/**/*.test.ts',
            'apps/simulators/test/**/*.test.ts',
            'apps/injectables-*/test/**/*.test.ts',
            'apps/record-viewer/test/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/fixtures/**', 'packages/ui-kit/**'],
          environment: 'node',
          globalSetup: ['packages/kernel/test/support/global-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'server',
          include: ['apps/tablets-server/test/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['apps/tablets-server/test/support/global-setup.ts'],
        },
      },
      {
        extends: true,
        oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
        test: {
          name: 'dom',
          include: ['packages/ui-kit/test/**/*.test.{ts,tsx}', 'apps/tablets-web/test/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
          setupFiles: ['packages/ui-kit/test/setup-dom.ts'],
        },
      },
    ],
  },
});
