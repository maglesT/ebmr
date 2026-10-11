# Slice 5b builder brief (TB-08 and G-24 reprocessing and recovery)

Branch phase-3/slice-5b (from phase-3/slice-4b; merge 5a's 5a-0 commit before step 3). Read CLAUDE.md,
docs/build-plan/phase-3/slice-5-plan.md (5b scope, ownership lists, interfaces, classes, defaults D-S5-1..9) and the
slice 1 and 2 briefs (rules: new migrations only; create-or-replace from the LATEST definition; definers hardened;
tests as the app role with bypass attempts; control-id tags only where proven; existing sweeps and the block parity
test must pass; one released block version never changes).

Specs: outline 5.2.9 (four cases) and the INV-33 row; design doc `#### K-24` and `#### TB-08` (Config, Captures, Engine
rules), C-07 (theoretical yield), TB-20 reject categories; controls PR-47, IN-19, IN-18, PR-57. G-24@1 is in
packages/recipe-core/src/blocks/generic/process.ts with its SQL checks in recipe-core 0330 and 0332. Search, do not
read whole. Backlog: slice 3d #3 (TB20-NO-PLAN through a deviation).

Where the code goes:
- recipe-core sql 0620 to 0659: the 5b interfaces of the plan (`recipe.batch_parent_link`, `recipe.source_addition`,
  the readers, `recipe.prepare_reprocessing_issue`), the residue reservation (QA-signed, on a closed reject container),
  the addition guard (sources only from executed batch records; product, strength, generation instant, expiry and
  recovered flag read from the database; MBR limits; chained block; per-use authorisation by a person other than the
  performer), the refusal of G-24@1 SOURCE_ADDITION on GMP, MBR record kind REPROCESSING with its issue checks (product
  permission from `site.product_master_of`, the investigation through `site.deviation_ref_problem(ref,
  'REPROCESSING', parent)`, the risk evaluation through `site.evidence_document_problem`), the parent's held or rejected
  containers chargeable only by its child. New permission REPROCESSING.AUTHORISE and meanings for the authorisation and
  the residue reservation here, unless a kernel meaning fits.
- recipe-core src: G-24@2 (new BlockVersion beside G24) with its tests.
- tablets sql 1020 to 1059: TB-08 rows (block data schema, signature meanings, guards), the C-07 yield item, the TB-20
  residue and NO-PLAN changes (0911, 0912 latest), the expiry cap in `tab.record_packaging_batch_data` (0951).
- tablets server: `apps/tablets-server/src/blocks/tb-08.ts` (+ blocks/reprocessing/index.ts), one line in
  `features/edition-blocks.ts`; routes in features/execution/index.ts and a new execution/reprocessing.ts; api-contract
  in a new `reprocessing.ts` with one export line. Tests in apps/tablets-server/test/blocks/reprocessing/.
- Order: TB-08 additions and the G-24@1 refusal first (no 5a dependency), then whole-batch reprocessing on 5a-0.

Not yours: the 5a function list in the plan, site-services sql, test-kit personas (ask 5a), features/quality. If you
need one, report.

Tests: the 5b list in the plan, at least; TB-08 has the full block contract (handler, config and data schemas,
exception rules, simulator model, golden fixture). Update implemented_by and tests for PR-47, IN-19, IN-18, PR-57 only.
Do not commit; report in at most 25 lines (files, rules enforced in the database, tests, defaults, open items).
