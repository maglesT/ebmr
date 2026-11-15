// Mutation testing of packages/rules (ADR 0023, decision 9: the interpreter and the generator are qualified tools).
// Decision 0032's rule applies: no surviving mutant. The break threshold is 100, so one survivor fails the run; an
// equivalent mutant is disabled at its line with a Stryker comment that says why it is equivalent.
// The command-line wrapper (src/generate/cli.ts) is left out: it only reads arguments and writes the file the tested
// functions produce. Static mutants (module-level constants: the definitions, the catalogue, the primitives' SQL text,
// the markers and patterns) are ignored, as in stryker.config.mjs: Stryker's Vitest runner does not re-evaluate a module
// for them, so it reports them survived whatever the tests do. Every byte they produce is pinned instead by the
// rules:check test (test/generate.test.ts: the committed migration equals the generator's output) and the conformance
// suite (the committed SQL against the interpreter).
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.rules-mutation.config.ts', related: false },
  coverageAnalysis: 'perTest',
  mutate: ['packages/rules/src/**/*.ts', '!packages/rules/src/generate/cli.ts'],
  ignoreStatic: true,
  concurrency: 4,
  dryRunTimeoutMinutes: 30,
  timeoutMS: 60000,
  thresholds: { high: 100, low: 100, break: 100 },
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: { fileName: '.reports/mutation/rules.json' },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
};
