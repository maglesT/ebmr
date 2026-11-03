# Tablets v1.0: R3 review of the library code (3 November 2026)

One review pass (decision 0008) on design and serious defects, over b864222..fccdffc (S0 to S11b) plus O-6
(`dyn/s11-findings`), the ready-made catalogue, and the two pieces no earlier review covered: the migration dry run
(`tools/drills/src`, DI-48) and the pack builder (`packages/validation-kit/src/pack`, IN-12). Five read-only slices.
The owner's rule (3 November): critical, high and medium are fixed, each with its own test; low ones are listed.

Status (3 November, evening): every critical, high and medium finding is fixed and merged into `dyn/v1-plan`, except
R3-APP-2 and R3-ENG-6 (found during the fixes; after Phase B). The fixes ran on branches `r3/validation`, `r3/limits`, `r3/bom` and `r3/catalogue` from `dyn/v1-plan`, merged
into `dyn/v1-plan` when done. The status column is updated at the merge.

| Id | Severity | Where | Defect | Status |
|---|---|---|---|---|
| R3-VAL-1 | critical | tools/drills/src/upgrade.ts:288 | A table dropped or renamed by an upgrade is recorded DROPPED but the drill still passes | fixed (662375e) |
| R3-VAL-2 | high | tools/validation/src/reports.ts:124, bundle.ts:87 | Every report in the results directory is stamped with HEAD, so stale reports count as passed on the bundle's commit | fixed (e354d87) |
| R3-VAL-3 | medium | validation-kit pack, bundle.ts | The pack prints the stored build status without recomputing it from the bundle | fixed (4be9072) |
| R3-VAL-4 | medium | validation-kit pack/facts.ts:39 | `isDatabaseTest` trusts words in a test's title | fixed (eb81f44) |
| R3-VAL-5 | medium | upgrade.ts spot checks | A dry run with no signature, audit or unit spot check passes | fixed (169a985) |
| R3-VAL-6 | medium | upgrade.ts:297 | Rows added to record tables (ADDED_ONLY) pass | fixed (4cfe27e) |
| R3-VAL-7 | low | tools/drills/src/restore.ts:176 | A longer restored chain counts as the same without a prefix check | listed |
| R3-VAL-8 | low | validation-kit qualification.ts, release.ts | Pack documents are RELEASED whatever the bundle holds | listed |
| R3-ENG-1 | high | block-version.ts:439, 465 | An exhausted library loop raises only an ACTION exception; the final value's tier breach is lost | fixed (9ab2912) |
| R3-ENG-2 | high | block-version.ts:450 | Individual readings: judging stops at the first breach; a later, stricter-tier breach is lost | fixed (2a0fb82) |
| R3-ENG-3 | high | check-use.ts:54, block-version.ts:398 | A `bomLines` value naming no BOM line switches off the material-identity check | fixed (15870d3) |
| R3-ENG-6 | medium | check-use.ts | A STEP_VALUE slot is only checked for being non-empty, not that the step and field exist in the master (found while fixing ENG-3) | open (after Phase B) |
| R3-ENG-4 | medium | block-version.ts:476, 545 | IPC interval not checked from step start to the first round nor from the last round to perform | fixed (2677173) |
| R3-ENG-5 | medium | block-version.ts:297, check-use.ts | A non-critical until-field left without limits passes any value | fixed (2d5b71a) |
| R3-SQL-1 | high | 1810:271, 298 | The database checks that a LIB_LIMIT_BREACH exists, not its facts (tier, severity, deviation) | fixed (2ddc13f) |
| R3-SQL-2 | high | 1810:284 | The database never judges TEST_RESULT readings against their limits | fixed (82c60da) |
| R3-SQL-3 | medium | 1810:258 | A timer's duration and unit are the application's, not recomputed from trusted times | fixed (a35b083) |
| R3-SQL-4 | medium | 1810:283 | No database guard on a library loop's repeats and exit | fixed (16a444d) |
| R3-SQL-5 | medium | 1810:287 | A limited CALC value can be stored without the server's figure and evaluation record | fixed (6c9965b) |
| R3-SQL-6 | low | 1810:331 | Master approval does not re-check that required slots are filled (the validator does) | listed |
| R3-APP-1 | high | from-formula.ts:92 | The skeleton's unit mass counts per-unit processing aids; the expected tablet count is too low | fixed (3b7fb32) |
| R3-CAT-1 | high | seed/process.ts:100 | Potency dispensing corrects for water twice (as-is assay and LOD) | fixed (e9bd706) |
| R3-CAT-2 | high | seed process, coating, capsules | Material-lot fields without a BOM-line slot: the lot is not checked as the right material | fixed (88607e7) |
| R3-CAT-3 | medium | seed/process.ts:649 | Geometric dilution weighings without BOM line, limit or diluent lot | fixed (ce7496f) |
| R3-CAT-4 | medium | seed/index.ts, library/index.ts:139 | The Tablets catalogue load includes the deferred hard-capsule blocks (owner: leave them out) | fixed (d0cb760) |
| R3-CAT-5 | medium | seed/process.ts:1034 | PROC-TRANSFER performed and checked by the same role | fixed (25549ca) |
| R3-CAT-6 | medium | seed/tests-release.ts:198 | Content uniformity's AV constant is for 10 units but the count is free | fixed (58b31d6) |
| R3-APP-2 | medium | apps/tablets-server (formulary routes) | A second formula for the same product, strength and batch size gives a server error (500) instead of a refusal (found while fixing APP-1) | open |
| R3-CAT-7 | low | seed/controls.ts:220 | Material reconciliation uses the formula quantity, not the issued one | listed |
| R3-CAT-8 | low | seed/tests-ipc.ts:196 | Friability records no sample count | listed |
| R3-CAT-9 | low | seed/capsules.ts:44 | Capsule size is a free choice | listed |

Checked without a finding (summary): the library routes' permissions, segregation and audit (database-enforced); the
browser's lot and equipment facts refused; content hashes; snapshots at approval and issue; O-6; decimal handling and
trusted time in the engine; the drill's row hashing, multiset comparison, SQL quoting and source isolation; the pack's
escaping and AI inventory.

Notes from the fixes (for the owner):
- R3-CAT-3: one limit range covers every geometric-dilution step (49.5 to 404 g), since the additions double each step.
- R3-CAT-6: the block covers the first stage only (exactly 10 units, held by a critical field with a 1-to-1 limit); a
  second stage needs its own block.
- Library blocks do not yet receive the lot's assay at run time (nothing fills LOT_ASSAY); when wired, a lot whose assay
  is not on the dried basis should be refused.
- Hard capsules, when they return, need the empty shells as a bill-of-materials line.
- R3-VAL-6: tables a release may grow are listed with a reason in `ADDED_ONLY_ALLOWED` (tools/drills/src/upgrade.ts);
  the owner should look at `kernel.audit_event` and `iam.role_permission`. A future release's new catalogue table fails
  the drill until listed (deliberate: a person reviews each one).
- R3-VAL-2: every test report now carries a stamp (commit, clean tree, SHA-256) written by `pnpm validation:stamp`; a
  report without one, from another commit or rewritten after stamping is refused. Reports copied from CI and rewritten
  locally must be stamped again on a clean checkout of the same commit.
- The restore drill test timed out on a heavily loaded machine (30 s default); its CI result decides whether it needs its
  own timeout.
- R3-ENG-3: the route-master path has no such hole (G-07 refuses an unknown line; the database requires a consumed
  line; the validator requires consumed lines to be BOM lines). Left as is: `recipe.lot_usability_problem` still skips a
  line it cannot find, and the database does not itself check a master's consumed lines against its BOM (the validator
  does); this matters only for a master that was never validated.
- The limit fixes: one migration, `packages/recipe-core/sql/1862_library_limits_judgement.sql` (the breach record, the
  statistics, the timer duration and the loop exit decided in the database); `library-blocks` SQL mutation 98.7 %
  (two equivalents recorded in tools/sql-mutation/equivalent.json), Stryker on the changed lines 95.9 % (survivors
  equivalent). The database refuses timer units outside ms, s, min, h and d, which it cannot recompute.
- Not yet run end to end: a library loop's exhaustion and a timer through server and database in the E2E groups.
