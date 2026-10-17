// Vitest configuration of the Phase 6 exit demo's server-side item (`pnpm demo:phase6-exit`, tools/e2e/demo/run.ts): the
// lot transfer between two installations, each a GMP server on its own database and listening on HTTP
// (apps/tablets-server/test/demo/*.demo.ts). The file name is not *.test.ts, so the suite's projects never pick it up.
import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

const { exclude, hookTimeout, testTimeout } = base.test ?? {};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'demo-server',
          include: ['apps/tablets-server/test/demo/**/*.demo.ts'],
          environment: 'node',
          globalSetup: ['apps/tablets-server/test/support/global-setup.ts'],
          ...(exclude === undefined ? {} : { exclude }),
          ...(hookTimeout === undefined ? {} : { hookTimeout }),
          ...(testTimeout === undefined ? {} : { testTimeout }),
        },
      },
    ],
  },
});
