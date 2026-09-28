// Vitest configuration for mutation testing (stryker.config.mjs): only the tests that exercise the
// mutated kernel and site-services code. Tool tests (e.g. tools/boundaries, which changes the working
// directory) cannot run inside Stryker's worker threads and cannot kill kernel mutants anyway.
//
// vitest.config.ts defines three projects (db, server, dom). A root `include` does not narrow them: each
// project that extends the root merges it into its own list, so every project would run (the server
// project building its template databases, the dom project running kernel tests in happy-dom). This
// config therefore takes only the shared exclusions and timeouts from the base and defines one node
// project of its own, with the kernel's template database.
import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

const { exclude, hookTimeout, testTimeout } = base.test ?? {};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'mutation',
          include: ['packages/kernel/test/**/*.test.ts', 'packages/site-services/test/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['packages/kernel/test/support/global-setup.ts'],
          ...(exclude === undefined ? {} : { exclude }),
          ...(hookTimeout === undefined ? {} : { hookTimeout }),
          ...(testTimeout === undefined ? {} : { testTimeout }),
        },
      },
    ],
  },
});
