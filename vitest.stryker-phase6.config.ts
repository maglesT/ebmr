// Vitest configuration for the Phase 6 Stryker runs (stryker.phase6.config.mjs, decision 0019): one project holding
// only the test files of the feature being mutated, with the set-up its tests need. The Stryker config passes the
// feature's test kind and files in EBMR_STRYKER_PHASE6_TESTS ({ kind, tests }); without it this config refuses to
// load, so it never runs a whole suite by mistake. As in vitest.mutation.config.ts, only the shared exclusions and
// timeouts come from the base config (its projects would otherwise all run).
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

const { exclude, hookTimeout, testTimeout } = base.test ?? {};
const raw = process.env['EBMR_STRYKER_PHASE6_TESTS'];
if (raw === undefined) throw new Error('EBMR_STRYKER_PHASE6_TESTS is not set: run through stryker.phase6.config.mjs');
const { kind, tests, aliases } = JSON.parse(raw) as { kind: 'db' | 'server' | 'unit'; tests: string[]; aliases?: Record<string, string> };
const globalSetup = {
  db: ['packages/kernel/test/support/global-setup.ts'],
  server: ['apps/tablets-server/test/support/global-setup.ts'],
  unit: [],
}[kind];

// A feature whose tests reach the mutated files through a workspace package name (`@ebmr/validation-kit`) names that
// package's entry here (stryker.phase7.config.mjs): the package link points at the original tree, not Stryker's sandbox,
// so without the alias no mutant would be exercised.
export default defineConfig({
  ...(aliases === undefined ? {} : { resolve: { alias: Object.fromEntries(Object.entries(aliases).map(([k, v]) => [k, resolve(v)])) } }),
  test: {
    projects: [
      {
        test: {
          name: `stryker-phase6-${kind}`,
          include: tests,
          environment: 'node',
          globalSetup,
          ...(exclude === undefined ? {} : { exclude }),
          ...(hookTimeout === undefined ? {} : { hookTimeout }),
          ...(testTimeout === undefined ? {} : { testTimeout }),
        },
      },
    ],
  },
});
