// Vitest configuration for mutation testing of packages/rules (stryker.rules.config.mjs; ADR 0023, decision 9): the
// package's own tests, with the kernel's template database the conformance suite runs on. One node project, for the
// reason vitest.mutation.config.ts gives.
import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

const { exclude, hookTimeout, testTimeout } = base.test ?? {};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'rules-mutation',
          include: ['packages/rules/test/**/*.test.ts'],
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
