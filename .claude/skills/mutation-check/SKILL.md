---
name: mutation-check
description: Run a focused mutation test on changed TypeScript lines (Stryker) or on a group of database functions (the SQL mutation harness), and act on surviving mutants. Use after changing guard code, limits, rounding, signing, access or state logic, or when asked for mutation scores.
---

# Focused mutation check

Targets (build outline 9.1): at least 90 % on guards, signature invalidation, limits, rounding, flow validation
and release gating; 80 % elsewhere. A surviving mutant in high-risk code needs a test that kills it or a written
justification that it is equivalent (no input changes any observable result). Never delete or loosen a test, and
never narrow the mutated range, to raise a score.

PostgreSQL must be running (`sudo pg_ctlcluster 16 main start`; check with `pg_lsclusters`).

## TypeScript: Stryker on the changed lines only

The full run (`pnpm mutation:ts`) takes hours. For a change, run Stryker on the changed line ranges with the
tests of that area. Put both temporary configs in the repository root (Stryker resolves them from there) and
delete them afterwards; never commit them.

`stryker.focus.tmp.config.mjs`:

```js
import base from './stryker.config.mjs';
export default {
  ...base,
  vitest: { configFile: 'vitest.mutation-focus.tmp.config.ts', related: false },
  mutate: ['packages/kernel/src/market/validate.ts:92-104'], // file:first-last line, one entry per range
  incremental: false,
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: '<scratchpad>/stryker-focus.json' },
  concurrency: 3,
};
```

`vitest.mutation-focus.tmp.config.ts`: copy `vitest.mutation.config.ts` and narrow its `include` to the test
files of the area (for example `packages/kernel/test/market/*.test.ts`). Keep its `globalSetup`, `exclude` and
timeouts.

Run `pnpm exec stryker run stryker.focus.tmp.config.mjs`, then read the survivors in the clear-text report.
For each one: write the test that kills it (named with the control IDs), or justify it as equivalent in your
report. Re-run until the range meets its target. `ignoreStatic` stays on (module-level constants are asserted
directly by the module tests).

## SQL: the mutation harness

`tools/sql-mutation` mutates database functions one at a time in copies of a migrated template database and runs
the group's tests against each mutant.

- Groups, their functions, tests and thresholds are in `tools/sql-mutation/src/targets.ts`. Extra tests written
  to kill a group's mutants go in `packages/kernel/test/mutation/<group>.test.ts` and are picked up
  automatically.
- `pnpm mutation:sql --count` lists mutant counts; `pnpm mutation:sql --group <name> --workers 3` runs one
  group. Results land in `.reports/sql-mutation/report.json` and `summary.md` (`--out <dir>` to change).
- The harness mutates the last definition of each function across all migrations, so a function replaced by a
  new migration is tested in its current form.
- A new guard function belongs in a group: add it to the right group in `targets.ts` (or a new group with its
  tests and threshold) in the same change that adds the function.
- An equivalent mutant is recorded in `tools/sql-mutation/equivalent.json`, keyed `<function>#<mutant number>`,
  with the reasoning: which line changes, why no input can tell the two apart. "Hard to test" is not
  equivalence.

`EBMR_PG_ADMIN_URL` points both tools at another cluster (see skill `local-ci`), so a mutation run can go on
while CI uses the main cluster.
