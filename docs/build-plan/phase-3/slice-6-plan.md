# Phase 3 slice 6: screens, demo seeds and devices, GB-T-01, the Phase 3 trace gate

Plan written 11 October 2026 before building. Depth follows decisions 0008 and 0009. Specs: outline 11 (Phase 3 scope,
demo and exit), 9.1 (test layers, the "Golden batches" paragraph), 7 (users and key screens); decision 0006 part 1 (the
company formulation library and "Choose a product", not built yet); `docs/design/sample-bmr-analysis.md` (GB-T-01's
source); critique-logic L-28 (GB-T-01's addition is case 2 recovery, never rework). Backlog items marked "slice 6" in
`review-backlog.md` (listed per sub-slice below). The Phase 3 exit run itself (decision 0009: mutation run, review, final
run) follows this slice and is not part of it.

## What the trace gate needs at phase 3 (checked on today's `.reports`, phase forced to 3, no repo change)

`current_phase: 3` makes the trace require, for every control with `target_phase <= 3`: passing listed tests, every
passing tagged test listed, and `clauses` mapping the catalog test (a clause tested or deferred to a phase not started).
Today that run gives 23 errors:
- **16 phase-3 controls with tests but no `clauses`:** IN-13, IN-15, IN-17, IN-21 to IN-26, IN-34 to IN-39, PR-41. The
  register assigns phase 3 only to these (outline exit list, plus tablets-only PR controls: only PR-41).
- **6 deferrals to phase 3 that become errors:** DI-04 clause 2 (PLC reports another recipe version: exception),
  DI-13 clause 3 (no formula permission: composition not opened), DI-24 clause 1 (delete through UI and API: only void
  with reason offered), DI-33 scope (reprocessing and recovery), IN-02 clause 1 (deviation classified minor without
  rationale refused), PR-01 clause 2 (packaging order for a pack type without an approved packaging master refused).
- **IN-18 failing test** (whole-batch reprocessing end to end) in the 03:24 report; the later commit fc3455f touched that
  test: re-run before treating it as a defect.
- Invariants INV-12 to 15, 24, 31 to 33, 41 are tags, not register controls; each already has passing tagged tests
  (2 to 16 files). 6c confirms each still passes in the final run.
- The 15 tablet-edition PR controls with no tests (PR-09, 15, 28, 43, 44, 48, 51 to 56, 58 to 60) are release, QA and
  records controls at register phase 4; not Phase 3 exit items (D-S6-9).

## Split (three builders in parallel after 6a-0; no shared files)

- **6a, server, contract and master data** (`apps/tablets-server/src/features/*` except the 6c files, `packages/api-contract`,
  new `packages/recipe-core/src/formula`): 6a-0 contract commit first; signed quality, lot and reprocessing acts over
  HTTP; GMP batch routes; planning, master-data and plant routes; the formulation library with FORMULA.READ; TB-08 and
  G-24@2 server support; the SSCC register route.
- **6b, screens** (`apps/tablets-web/**`, new e2e spec folders): shop-floor renderers for the tablet blocks and G-06,
  G-21, G-24@2; planning; master data with "Choose a product"; quality (deviation, LIMS, ERP); plant; e2e specs.
- **6c, golden batch, demo and exit gate** (`compliance/**`, seeds, devices, simulators, gateway, `tools/demo`, the golden
  test, gap fixes): trace clauses first; demo seeds and devices; GB-T-01 MBR, expected outputs and golden test; the
  deferral and gap tests; `phase.yaml` to 3 last.

## Interfaces fixed before building (6a-0, one commit to `phase-3/slice-6`, before 6b and 6c branch)

Contract (`packages/api-contract`), each new route with an example in the examples registry so 6b builds on fixtures:
- `ClientEntry` gains `{kind:'BLOCK_ENTRY', entryKind: TabletEntryKind, data: record<string, DataValueWire>}`;
  `TabletEntryKind` is a closed enum exported by the contract, listing every entry kind of TB-01..TB-24, G-06@1, G-21,
  G-24@2 (taken from the block registry; a contract test checks the enum equals the registry's kinds). The server
  hands `{kind: entryKind, ...data}` to the engine; the block's own schema validates (D-S6-2).
- `SignableAction` gains: `QUALITY_ACT` {act: DEVIATION_CONCLUDE | DEVIATION_CLOSE | LOT_RESULT_APPROVE |
  QC_EXTRA_TESTING_DECISION | LOT_RETEST, subjectId, input}; `LOT_DECISION` {lotId, decision RELEASE | REJECT, route?};
  `REPROCESSING_ACT` {act: RESERVE_RESIDUE | AUTHORISE_ADDITION | AUTHORISE_REQUEST, subjectId, input};
  `MASTER_DATA_APPROVE` {kind FORMULA, versionId}; `PLANT_VERIFY` {act CLEANING | CLEARANCE | REPAIR, id}. Meanings
  are the existing ones (DEVIATION_CONCLUDED, DEVIATION_CLOSED, QC_RESULT_APPROVED, QC_EXTRA_TESTING_DECIDED,
  MATERIAL_LOT_RELEASED, MATERIAL_LOT_STATUS_DECIDED, RESIDUE_RESERVED, REPROCESSING_AUTHORISED, LINE_CLEARANCE_VERIFIED)
  plus FORMULA_APPROVED (new, recipe-core range).
- Routes (all GMP, SESSION auth unless stated):
  - quality: `GET /api/quality/deviations` (list, filter state/kind/batch), `POST /api/quality/evidence-documents`,
    `GET /api/quality/batches/:batchId/extra-testing`, `GET /api/quality/erp/orders`, `GET /api/quality/erp/products`,
    `GET /api/quality/erp/materials`; existing quality routes unchanged.
  - lots: `GET /api/lots` (list), `POST /api/lots` (receive, kind and name from the material master); `GET
    /api/lots/:code` unchanged; retest via `QUALITY_ACT` LOT_RETEST, release and reject via `LOT_DECISION`.
  - GMP batches (D-S6-1): `GET /api/batches`, `GET /api/batches/:batchId`, `GET /api/batches/:batchId/steps/:stepKey`,
    `GET /api/batches/:batchId/work-queue`, `GET /api/batches/:batchId/timeline`, `POST /api/batches/:batchId/commands`,
    `GET /api/batches/:batchId/sscc`, `GET /api/batches/:batchId/steps/:stepKey/addition-sources` (TB-08 and G-24@2
    sources with database-read facts); `POST /api/batches` (plan) and the issue route unchanged.
  - planning: `GET /api/planning/orders` (open ERP orders with their matching effective MBR, or why none matches).
  - master data: `GET|POST /api/master-data/formulas`, `GET /api/master-data/formulas/:formulaId`,
    `POST /api/master-data/formulas/:formulaId/versions`, `GET /api/designer/formula-choice?product&strength&batchSize`
    ("Choose a product": the approved version's BOM lines, quantities computed); `GET|POST` under
    `/api/master-data/plant/` for `areas`, `equipment-classes`, `equipment`, `tooling-sets`, `detectors`,
    `test-pieces`, `utilities`.
  - plant acts: `POST /api/plant/cleanings`, `POST /api/plant/cleanings/:id/complete`, `POST /api/plant/clearances`,
    `POST /api/plant/equipment/:code/events`; verification via `PLANT_VERIFY`.
- Web feature names fixed for 6b: `quality`, `planning`, `master-data`, `plant` (+ the existing `floor`).
- Device kinds for 6c (integration-sdk `EQUIPMENT_KINDS`, owned by 6c): PRESS, COATER, GRANULATOR, FLUID_BED_DRYER,
  BLENDER, ROLLER_COMPACTOR, BLISTER_MACHINE, BOTTLE_LINE, CARTONER; instruments on the scale protocol: BALANCE,
  MOISTURE_ANALYSER, HARDNESS_TESTER, FRIABILATOR, DISINTEGRATION_TESTER, LEAK_TESTER, CHECKWEIGHER. If the contract's
  devices namespace enumerates kinds, 6a-0 copies this list.
- Seed hook: 6a-0 adds `apps/tablets-server/src/features/execution/seed-gmp.ts` exporting `seedGmp(ctx)` (empty), called
  from `seed.ts`; from then on 6c owns `seed.ts`, `seed-gmp.ts` and `seed-gb-t-01.ts`.

## Migration ranges (each builder only in its own; 6b writes no SQL)

| Source (highest used) | 6a | 6c |
|---|---|---|
| kernel (1150) | none | none |
| site-services (0753) | 0760 to 0779 | 0780 to 0789 |
| recipe-core (0625) | 0640 to 0669 | 0670 to 0689 |
| tablets (1022) | 1040 to 1059 | 1060 to 1089 |

New permissions and meanings in the builder's own range; reuse a kernel meaning where one fits.

## Functions each side owns (create-or-replace only by the owner, from the latest definition)

- 6a: new `recipe.formula_*` functions; the MBR approval guard that checks a pinned formula version (latest definition in
  recipe-core lifecycle SQL); any read function the new routes need (new names only).
- 6c: `recipe.prepare_gmp_issue` (PR-01 clause 2), `recipe.change_path_problem` and the TB-20 functions of tablets 0911,
  0912 (TB20-NO-PLAN through deviation-lite), `tab.bind_step_device` and the device-reading checks of tablets 0820 (new
  device kinds), the seeds.
- Neither: anything else; a need outside the list goes to the planner first.

## Controls and their class

| Control | Part in this slice | Class |
|---|---|---|
| DI-13 (cl. 3) | composition readable only with FORMULA.READ (route and database) | Core |
| DI-24 (cl. 1) | no delete of a batch entry by route or screen; only void with reason | Core (route), Other (screen) |
| IN-02 (cl. 1), PR-49 | deviation classification needs a rationale (route and database) | Core |
| PR-01 (cl. 2) | packaging order for a pack type with no approved packaging MBR refused at issue | Core |
| DI-04 (cl. 2) | PLC recipe version differing from the MBR raises the exception | Core (existing RECIPE_CHECK path) |
| Decision 0006 part 1, INV-25 | formula versions under two-person approval; quantities computed, never typed | Core |
| Signed acts over HTTP | the ceremony binds content; the database guards stay the deciders | Other (routes), Core (DB, done) |
| Screens, seeds, devices, simulators | | Other |
| GB-T-01 | end-to-end evidence over the core controls | Evidence |

## Defaults taken (decision 0004)

- **D-S6-1** GMP batches get `/api/batches/*`; the sandbox keeps `/api/test-runs/*` (backlog 2b). Both mount the same
  handlers; the installation decides which family answers (the other answers 404).
- **D-S6-2** One generic `BLOCK_ENTRY` client entry with a closed kind enum, instead of ~80 typed variants: the
  engine's block schemas stay the single source; renderers are schema-driven with block-specific layout.
- **D-S6-3** Formulation library in recipe-core: formula per product, strength and batch size; versions insert-only;
  DRAFT -> APPROVED by a second person with FORMULA_APPROVED (FORMULA.MANAGE to author); an MBR pins the formula
  version; approval of an MBR whose pinned formula is not APPROVED is refused; a new formula version needs a new MBR
  version. Quantities are computed from per-unit composition and batch size (decimals, never JS number).
- **D-S6-4** FORMULA.READ (owner question F14.3, default): granted to QA, QC, production head, formulation steward and
  designer authors; not to operators, who see only the quantities of their own dispensing step.
- **D-S6-5** GB-T-01 is an invented formula (no real or patented formula; decision 0006 part 3) built from the library
  and designer as a template `gb-t-01.mbr.json`. Scope per outline 9.1: split granulation (replicate section),
  FBD with LOD loop, film coating, 2,00,000 tablets, salt-to-base potency with compensating excipient, optional extra-IPA
  branch, case 2 recovery addition (3 %, 3 months, L-28), left/right IPC with a failing check holding overlapping
  containers, "approved for coating" and "release for packing" gates, inspection rejects with witnessed destruction.
  Packaging golden batches are Phase 4.
- **D-S6-6** Time in GB-T-01: the golden test's PostgreSQL runs under libfaketime with a shared offset file; the driver
  "waits" only by moving the offset forward (never back); no domain code changes and no test hook in SQL. Simulators in
  the test read time from the database. CI gets a golden job with its own cluster. Fallback, if libfaketime cannot run
  on the runner: a residual for the owner, never a test clock inside the GMP code.
- **D-S6-7** "Exact expected outputs" means: batch, step, stage and container states; the exception report (type,
  step, tier, disposition); every quantity and yield as exact decimals; the genealogy edges; the signature count; and the
  SHA-256 of the normalised true copy (UUIDs by first-appearance ordinal, instants as offsets from issue in whole
  minutes). Quantities and yields are computed by hand into `expected.json` before the first run; only the normalised
  hash is taken from the first reviewed run. The raw record hash is checked for chain validity, not for a fixed value.
- **D-S6-8** Demo devices are simulators behind the gateway (no new hardware drivers); TB-18/TB-20 sample weights and
  IPC instruments use the scale protocol; TB-21 pocket rejects into G-21's reconciliation (4b) goes to Phase 4 (needs
  a G-21 version).
- **D-S6-9** "The tablet PR controls tested" = the register's phase-3 PR set (PR-41) plus every tablet PR control that
  already has tests stays green; target phases are not changed.
- **D-S6-10** A clause the slice cannot test is not re-deferred silently: 6c re-defers only with the reason and lists it
  for the owner in PROGRESS.md (a deferral is never moved to make the gate green without that note).

Open for the owner (defaults stand): D-S6-4 (who reads formulas); D-S6-6 if libfaketime fails in CI.

## Tests each sub-slice must have (as the app role, with bypass attempts; tags only where proven)

Exact titles fixed here because 6c maps clauses to them:
- 6a `apps/tablets-server/test/master-data/formula.test.ts`: `[DI-13] a user without FORMULA.READ cannot open a formula
  or the composition of an MBR, by route or in the database`; `[INV-25] formula quantities are computed from the
  composition and the batch size, never typed`; a formula version approved by its author is refused; an MBR pinning a
  DRAFT formula cannot be approved.
- 6a `apps/tablets-server/test/quality/routes.test.ts`: `[IN-02] a deviation classified MINOR without a rationale is
  refused by the route and by the database`; each signed act (conclude, close, approve result, extra-testing decision,
  retest, lot release and reject, residue reservation, addition and request authorisation, formula approval, plant
  verifications) succeeds through the ceremony and is refused for the wrong person or changed content.
- 6a `apps/tablets-server/test/execution/gmp-batch-routes.test.ts`: `[DI-24] no route deletes a batch entry: a DELETE
  answers 404 and a void needs a reason`; GMP routes answer 404 on the sandbox and test-run routes 404 on GMP; a
  BLOCK_ENTRY for each tablet block reaches the engine (one per block, the golden fixture's first entry); the
  TabletEntryKind enum equals the block registry; every new route parses with its contract schema.
- 6b: renderer registry test (no tablet block or G-06, G-21, G-24@2 on the fallback); component tests per page; e2e:
  `[DI-24] the step screen offers void with a reason and never delete @kiosk`, `[DI-13] an operator cannot open the
  composition @office`, a quality flow (raise, link, investigate, conclude), a planning flow (order to issue), a
  master-data flow (formula, Choose a product), a plant cleaning and verification.
- 6c: clauses for the 16 controls; `[PR-01]` a packaging order for a pack type with no approved packaging MBR is refused
  at issue; `[DI-04]` a RECIPE_CHECK naming another recipe version raises the exception (existing test tagged, or new);
  `[IN-02]` and `[DI-13]`, `[DI-24]` mapped to the 6a/6b titles; DI-33 scope mapped to the slice 5b reprocessing tests;
  TB20-NO-PLAN leaves only through a linked deviation-lite record; slice 3d #4 (container opened on the printer before
  PRINT_SETUP) verified by a test; GB-T-01 happy and exception-rich variants plus the sample-data negatives of 9.1
  (kg/cm² only through the legacy alias with a warning, a pressure unit refused, the trihydrate label on an anhydrous
  molar mass flagged, an addition without case and approval refused, (A + B)/T yield beside the good-output yield).

## Order and close

6a-0 first (contract, examples, seed hook; about half a day), merged to `phase-3/slice-6`. Then 6a, 6b and 6c in
parallel on `phase-3/slice-6a`, `-6b`, `-6c`. 6c does the trace clauses, devices and seeds first and the GB-T-01 run
after 6a's routes are on `phase-3/slice-6`. Merge order 6a, 6b, 6c into `phase-3/slice-6`; then one register sync
(Haiku) on the integrated branch, `phase.yaml` to 3, `pnpm run ci` and the E2E trace (`pnpm trace:e2e`) green, one
quick review (Sonnet) per sub-slice, one PR. PROGRESS.md and the review backlog at each merge. Then the Phase 3 exit
(decision 0009).
