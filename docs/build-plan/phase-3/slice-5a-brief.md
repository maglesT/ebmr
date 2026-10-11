# Slice 5a builder brief (deviation-lite, LIMS-lite, ERP stub)

Branch phase-3/slice-5a (from phase-3/slice-4b). Read CLAUDE.md, docs/build-plan/phase-3/slice-5-plan.md (5a scope,
ownership lists, interfaces, classes, defaults D-S5-1..9) and the slice 1 and 2 briefs (rules: new migrations only;
create-or-replace from the LATEST definition; definers hardened (ADR 0012, 0016); insert-only tables, the person's own
reason; tests as the app role with bypass attempts; control-id tags only where proven; existing sweeps pass).

Specs: outline 5.2.5 (deviation; the lite part only), 5.2.9 (material lot), 5.2.2 (issue guard: ERP BOM), 4.6
(systems of record); controls PR-49, PR-50, IN-20, PR-17, PR-18, IN-24, PR-19, DI-33, DI-37, PR-47 (QC decision).
Search, do not read whole. Backlog items: slice 1 #5 and #7, slice 2 #1b and #6, slice 2b open item (GMP seed lots),
slice 3b open item (assay approval), slice 4b low (beta-lactam from master data).

Order:
1. **5a-0 first** (site-services 0730 to 0734 and the test-kit personas): every table and function under "Built by 5a
   in 5a-0" in the plan, with names and signatures exactly as written, and their tests. Commit it alone and report
   the commit id at once: 5b merges it before its whole-batch step.
2. Deviation references in recipe-core 0600 to 0619 (GMP only, D-S5-2): replace `recipe.change_path_problem`,
   `recipe.check_exception_changes`, `recipe.execution_change_path_check` and `recipe.review_exception` from their
   latest definitions with the `site.deviation_ref_problem` calls and the evidence-document check; nothing else changes.
3. LIMS-lite and retest (site-services 0740 onwards): results, approval, revision, OOS link, retest, the lot release
   rule, the QC extra-testing decision writer. Replace the retest reads in tablets 0801 and 0843 (tablets 1000 to
   1019) with `site.lot_retest_at`; `tab.record_lot_assay` on GMP takes approved result ids, values copied, never typed.
4. ERP stub (site-services 0750 onwards): material master, product master, orders with BOM; `site.receive_lot` from the
   master; `recipe.prepare_gmp_issue` (latest: 0582) checks the named `erpOrder` (recipe-core range); TB-21 isolation
   reads beta-lactam from the master (tablets range); update the existing GMP issue tests to create orders.
5. Server and simulator: a new feature `apps/tablets-server/src/features/quality/` (deviation, LIMS, ERP import routes;
   one line in features/index.ts); in features/execution only gmp-issue.ts, lots.ts, tb01.ts and seed.ts; api-contract
   in a new `quality.ts` with one export line; `apps/simulators/src/erp` with a seeded catalogue; the GMP seed
   receives, tests and releases lots.

Not yours: block files, `edition-blocks.ts`, features/execution/index.ts, the 5b function list. If you need one, report.

Tests: the 5a list in the plan, at least. Update the controls' implemented_by and tests only for PR-49, PR-50, IN-20,
PR-17, PR-18, IN-24, PR-19 (5b edits PR-47, IN-19, IN-18, PR-57). Do not commit beyond 5a-0 without the planner; report
in at most 25 lines (files, rules enforced in the database, tests, defaults, open items).
