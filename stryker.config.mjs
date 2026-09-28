// Mutation testing of the kernel's pure TypeScript logic (build outline 9.1: at least 90 % for
// guards, signature invalidation, limits, rounding, flow validation and release gating; 80 %
// elsewhere; surviving mutants in high-risk code need a test or a written justification).
// Database-enforced rules (SQL functions and triggers) are covered by the SQL mutation harness in
// tools/sql-mutation instead; Stryker cannot mutate SQL.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  // related: false - vitest's related-file filter selected no test files for most mutants
  // (reported as survived with zero tests run); Stryker's per-test coverage already narrows the tests.
  vitest: { configFile: 'vitest.mutation.config.ts', related: false },
  coverageAnalysis: 'perTest',
  mutate: [
    'packages/kernel/src/market/resolve.ts',
    'packages/kernel/src/market/strictness.ts',
    'packages/kernel/src/market/validate.ts',
    'packages/kernel/src/market/decimal.ts',
    'packages/kernel/src/records/retention-rules.ts',
    'packages/kernel/src/records/calendar.ts',
    'packages/kernel/src/records/true-copy.ts',
    'packages/kernel/src/records/lossless-json.ts',
    'packages/kernel/src/time/instant.ts',
    'packages/kernel/src/time/site-time.ts',
    'packages/kernel/src/time/entry-time.ts',
    'packages/kernel/src/esig/canonical.ts',
    'packages/kernel/src/esig/keys.ts',
    'packages/kernel/src/state/extract.ts',
    'packages/kernel/src/continuity/security-baseline.ts',
    'packages/kernel/src/identity/secrets.ts',
  ],
  // Static mutants (module-level constants evaluated at import) need the whole suite per mutant:
  // about 1,300 of them at ~3 min each. They are skipped here and in the weekly run; the constants
  // they touch (catalogues, regexes, defaults) are asserted directly by the module tests.
  ignoreStatic: true,
  // Keep results between runs so the weekly job only re-tests changed code.
  incremental: true,
  incrementalFile: '.reports/mutation/stryker-incremental.json',
  concurrency: 4,
  // The initial (dry) run executes all kernel and site-services tests in one worker thread, including the
  // template database build: 912 tests took about 9 minutes locally, beyond Stryker's 5-minute default.
  dryRunTimeoutMinutes: 30,
  timeoutMS: 60000,
  thresholds: { high: 90, low: 80, break: null },
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: '.reports/mutation/index.html' },
  jsonReporter: { fileName: '.reports/mutation/mutation.json' },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
};
