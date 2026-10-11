# Phase 3 exit plan (decision 0009)

Branch `phase-3/exit` from main after slice 6 (PR #17). Baseline for "changed since the Phase 2 exit": commit
`dd66b59` (merge of PR #4).

## Work streams (Opus, at most 3 agents at a time)

- **M-SQL (mutation, database):** every SQL function added or replaced since `dd66b59` that is a guard, a limit, a
  signature or state check, or a writer of GMP data (kernel, site-services, recipe-core, tablets). Each is placed in a
  group in `tools/sql-mutation/src/targets.ts`; groups are run with the harness. Survivors that show a missing test
  for a real behaviour get a test (named with control IDs); equivalent mutants go in `equivalent.json` with reasons.
  Branch `phase-3/exit-msql`.
- **M-TS (mutation, TypeScript):** Stryker on the Phase 3 TypeScript (tablets blocks and features, the generic blocks
  and engine code changed since `dd66b59`, site-services and api-contract code with logic), by focused ranges with the
  area's tests. Targets as in the mutation-check skill (90 % on guards, limits, rounding, signing, release gating;
  80 % elsewhere). Branch `phase-3/exit-mts`.
- **R (review):** one Opus pass over Phases 1 to 3 as built, for design and serious defects only. Read-only; findings
  ranked critical, high, medium, low.

## Fixes and the final run

Critical and high findings from all three streams are fixed, each with its own test that fails without the fix (at
most 2 fix rounds per finding, then a residual for the owner). Medium and low go to the review backlog. Then one final
run on the integrated branch: the whole suite, E2E, the trace gate at phase 3, and GB-T-01 matching `expected.json`.
No further re-test loops once that run is green. Also in scope: the root cause of the `db-guards-free-text-shown`
failure seen once under load.
