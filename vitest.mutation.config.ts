// Vitest configuration for mutation testing (stryker.config.mjs): only the tests that exercise the
// mutated kernel and site-services code. Tool tests (e.g. tools/boundaries, which changes the working
// directory) cannot run inside Stryker's worker threads and cannot kill kernel mutants anyway.
import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['packages/kernel/test/**/*.test.ts', 'packages/site-services/test/**/*.test.ts'],
  },
});
