# Slice 7r: the R4 GMP batches (Demotab, then P3 rabeprazole, from their first lots to the released lot)

Requirement R4 of `demo-trial-requirements.md`: "GMP batch on the kiosks through packing, QC, review and release" for the
company's own product made on the screens. Slice 7o proved Demotab 400 mg (invented) up to an approved master authorised
for India (browser tests Demotab 1 to 3). This piece runs Demotab's GMP batch on the screens only, as a presenter would
(browser tests Demotab 4 to 12 in `tools/e2e/specs/phase7/own-product-gmp.spec.ts`, E2E group `own-demotab`). Piece 2
runs the P3 rabeprazole batch the same way (browser tests Rabeprazole 4 to 12 in `own-product-p3.spec.ts`, E2E group
`own-p3`): three coating layers and P3's two-stage dissolution as one release requirement (7p, R8 C3 and C4).

## Status

Both pieces done on the pod. Branch `phase-7/slice-7r` (not merged; no PR yet). Pod runs of the own-demotab group,
24 October:

| Run | Head | Result |
| --- | --- | --- |
| 40087409907 | afe25bd8 | Demotab 1-5 pass; 6 refused: no PROCESSING numbering rule for the product (D-7r-6) |
| 40089985136 | 312ad680 | 1-5 pass; 6 planned and issued, stores' start page refused by the identification limit (D-7r-7) |
| 40092568779 | 946bd047 | 1-8 pass (the GMP batch processed on the kiosks); 9 refused at TB-24's first challenge (D-7r-5) |
| 40096745431 | 331e6729 | 1-10 pass (the packaging master's sandbox run, its IN authorisation, the GMP packaging order); 11's reserve sample refused: the product specification gave no sample quantities in packs (fixed at 2dca213d) |
| 40100765017 | 2dca213d | 12 of 12: Demotab's GMP batch through release |

Piece 2, the own-p3 group:

| Run | Head | Result |
| --- | --- | --- |
| 40105647269 | 408d31d9 | 12 of 12 (65 minutes): P3's GMP batch with its three coats through release, the two-stage dissolution one green line |
| COMBINED_RUN | COMBINED_HEAD | both groups together on the changed shared helpers: RESULT |

Where to continue: open the pull request of the slice once the combined run is green (on a failure: its artifacts
e2e-blob-<group> (report.jsonl, onTestEnd errors) and e2e-output-<group> (error-context.md)). The other R8 products
(P1, P2, P4 to P8) can follow the same pattern: a product spec file with its own group, reusing
`own-product-gmp-flow.ts` and `own-product-floor.ts`.

## What the browser tests prove (Demotab 4 to 12)

- **Demotab 4**: the steward enters Demotab's printed lidding foil and carton (PRINTED_PACKAGING) and QA confirms them;
  QC drafts four specifications (the active: assay 98.0 to 102.0 %, water at most 1.5 %; the foil and the carton: text
  check; Demotab: assay 95.0 to 105.0 %, dissolution at least 80 %), the head of QC approves each; QA proposes and
  approves the manufacturer of the active and of both printed materials (PR-17).
- **Demotab 5**: stores receive one delivery of each (the database numbers each lot) and examine its container; QC
  records the results (the limits are the specification's, the verdict the database's) and the identity; the head of
  QC approves the results; QC records the active's assay by choosing its approved ASSAY and WATER results (tablets
  1001: never typed) and each printed lot's artwork version; QA releases the three lots (identity tested); the steward
  defines Demotab's tooling set TS-DMT-<tag> on Plant master data.
- **Demotab 6**: the ERP simulator ("Send a production order", D-7o-7) sends Demotab's processing order; the issuer plans
  the batch on SITE-1 line L1 and issues it (office ceremony); stores reserve the lots (the active's own, the excipients
  from the demo set-up's route W lots, the film coat from GB-T-01's).
- **Demotab 7**: the GMP batch on the kiosks, the same acts as the sandbox run of Demotab 3 (`processingRun` of
  `own-product-floor.ts`): cleaning of what the stages need, dispensing with TB-01 from the new lot's assay,
  granulation, blending, compression with Demotab's tooling, the plain film coat, inspection, QA's H-COAT and H-PACK,
  a 1,000-tablet bulk container.
- **Demotab 8**: the packaging master as a copy of the approved cold-form master (D-7o-3) naming Demotab's own printed foil
  and carton and their artwork versions; the designer's checks pass; change control; the test package in the sandbox
  inbox.
- **Demotab 9**: the packaging master's own sandbox test run (TEST- lots of the laminate and of Demotab's printed foil and
  carton with their artwork versions; the cold-form order on TEST-KIOSK-PACK-2, `packagingRun`), its result exported and
  imported as SANDBOX_RUN evidence, the four signatures and the IN authorisation (site SITE-1, line L1, size PK-1K).
- **Demotab 10**: the ERP simulator sends Demotab's packaging order; the issuer plans it from the batch released for
  packing and issues it; stores reserve the laminate; the order on KIOSK-PACK-2 (`packagingRun`, as route W 9: bulk
  issued, line cleared, laminate weighed, printed lots taken from the register, specimens, TB-21 line check and run,
  TB-22 leak tests, TB-24 cartons and the shipper, reconciliations, the witnessed destruction, coding specimens, the
  post-use inspection, tablets issued and packed, yield, stage sign-off).
- **Demotab 11**: stores post the finished lot in quarantine; QC records assay and dissolution against Demotab's
  specification and pulls the reserve sample; the head of QC approves.
- **Demotab 12**: both records reviewed (production approval, register, audit-trail review, QA review) and the lot
  released by the authorised person on a checklist with no red item.

Rabeprazole 4 to 12 (piece 2) are the same acts for P3 (its own active, printed foil and carton, tooling TS-RAB-<tag>,
numbering rules `R<tag>{SEQ:3}` and `{PARENT}/P{SEQ:2}`, the excipients and the enteric coating system from route W's
lots, the processing with the seal, enteric and top coats and the acid-then-buffer disintegration, the cold-form
packaging master copy with its own sandbox run and IN authorisation, the packaging order), with one difference: the
product's specification has the two-stage dissolution as one profile test (D-7r-8); QC records the acid point (3 %)
and the buffer point (86 %) of the finished lot, the head of QC approves each, the lot page shows the profile PASS, and
the release checklist's G3.PROFILE_DISSOLUTION line is GREEN before the authorised person signs.

New browser helpers, for the R8 products too: `own-product-gmp-flow.ts` (the office acts: specifications, approved
manufacturers, deliveries, lot results, identity, assay and artwork, lot release, ERP orders, planning and issue,
reservations, the finished lot, the reserve sample, the release cockpit) and `packagingRun` in `own-product-floor.ts`
(the cold-form packaging order on either installation).

## Decisions

- **D-7r-1** (found by the run of Demotab's packaging master on the sandbox): the sandbox has no product master, so the
  record of a test run gave no expiry and no coding (tab.g21_expected_coding), and a coded packaging master's test run
  could neither record its coding specimens (EBMR-LBL-034) nor complete: no company's own packaging master could get its
  SANDBOX_RUN evidence (DI-04). Recipe-core 1750: `recipe.batch_shelf_life` falls back, for a test run (a batch running
  a test package) on the sandbox installation only and only when no product master version exists there, to the shelf
  life the run's own master states on its G-21 step (tentative, no stability reference). A GMP batch is dated from the
  product master as before (PR-43); a master whose G-21 step states none gives none. The least strict option: no
  "test products" register on the sandbox, no change of the package format.
- **D-7r-2**: a packaging copy (D-7o-3) writes the product master's shelf life into the G-21 steps of the source that
  state one (before, the copy kept the source product's months; the GMP batch data refuses a step whose shelf life is
  not the product master's, tablets 1201, and the sandbox now dates a test run from it).
- **D-7r-3**: the E2E job may take 150 minutes (was 90): the own-demotab group runs Demotab from its materials to the
  released lot in one file (two sandbox test runs, the GMP batch and its packaging order), about 80 minutes of tests;
  a file is never split, so its tests keep their order and hand on their state.
- **D-7r-4**: the GMP lots of Demotab's own materials (the active, the printed foil and carton) are made on the screens
  (approved manufacturer, delivery, examination, specification, results, identity, assay or artwork, QA release); the
  excipients Demotab shares with route W come from the demo set-up's lots, as a site's stock would.

- **D-7r-5** (found by Demotab 9 on the pod, run 40092568779): a bottle line (TB-23) or secondary packaging step (TB-24)
  names its plant unit in the master's configuration (the cartoner CTN-03); its checks, challenges, holds and line
  clearance are recorded on that unit. The sandbox's plant labels every unit TEST- (DI-05; the DI-05 test of
  `sandbox-plant.ts` keeps that) and a test run runs the GMP master itself, so the cold-form master's first checkweigher
  challenge in its sandbox run was refused (EBMR-CNT-023): no packaging master with TB-23 or TB-24 could get its
  SANDBOX_RUN evidence (DI-04). Tablets 1701: on the sandbox only, a configured unit code that is no sandbox unit reads as
  the sandbox's TEST- unit of the same code when one exists (`tab.configured_unit`, `tab.packline_unit`), in the holds,
  the pass check, the line clearance, the overdue checks and the delegated pass check; GMP reads the code as it is and
  every guard keeps its rule (test `apps/tablets-server/test/plant/sandbox-configured-unit.test.ts`). Not taken: giving
  the sandbox cartoner the GMP code (it would loosen the DI-05 test that every sandbox unit is TEST-).
- **D-7r-6** (run 40087409907): a new product's batch is planned only under a numbering rule of the product in force
  (IN-18): Demotab 6 has the steward define Demotab's PROCESSING rule (`D<tag>{SEQ:3}`) and PACKAGING rule
  (`{PARENT}/P{SEQ:2}`) on Batch numbers (`defineNumberingRule`), as the demo set-up does for its products.
- **D-7r-7** (run 40089985136): the server identifies a terminal at most 60 times a minute from one address; a long
  serial file of office acts meets that limit. The own-product helpers go to the start page by the banner's Home link
  (no page load) and open every address through `load()` (own-product-flow.ts), which waits out the window and reloads as
  the fixture's `pickTerminal` does; the floor helpers too. A page's context is closed before the next person signs in on
  the same PC (as route W).

- **D-7r-8** (piece 2; R8 C4 on the least strict reading, D-7p-5): P3's finished-product specification carries the
  two-stage dissolution from its version 1 as one profile test DISSOLUTION with a stage on each point: "Acid 2 h"
  (stage Acid 0.1 M HCl, 2 h, at most 10 %) and "Buffer 45 min" (stage Buffer pH 6.8, 45 min, at least 75 %), one
  result per point (the mean, D-7p-1), samples in packs as the assay. The release checklist shows it as one line
  (G3.PROFILE_DISSOLUTION) beside the assay; nothing new was built for it.
- **D-7r-9**: P3's GMP batch takes the materials it shares with route W from the demo set-up's lots (D-7r-4), the enteric
  coating system from RTW-ECS-001 (the formula's 2.8 kg serves the three coats); stores reserve the active 3.100 kg for
  the 3.037 kg TB-01 computes and the compensating cellulose to the top of its range (5.000 kg).
- **D-7r-10**: piece 1's helpers are extended, not copied: `draftSpecification` takes a profile test's points (with
  stages), `recordProfile` records a lot's points, `approveResults` takes a profile's [test, point] beside a test code,
  and `releaseFinishedLot` checks the items it is given are GREEN. Demotab's spec is unchanged; the combined run proves
  both groups on the changed helpers.

## Residuals

- No product defect was found by piece 2: P3 passed its nine new tests on its first pod run.
- The pharmacopoeial staged acceptance of a delayed-release dissolution (acid stage A1 to A3, buffer stage B1 to B3 with
  more units) is not built, as for SR dissolution (P7P-1, R8 C6): one result per stage, the mean.
- P3's three coats use the one coating recipe RCP-RTW-COAT of route W (demo data); a product with a recipe per coat
  needs only master data.

- D-7r-5 is proven by the database functions' test (the unit read on each installation, and the five guards reading it
  through `tab.packline_unit`/`tab.configured_unit`) and by Demotab 9 on the pod, not by a database test of a whole
  sandbox packaging run; no focused SQL mutation run on 1701 (decision 0008: at deployment).
- The R4 guide part "create your own product" is not extended to the GMP batch (R3.14 regeneration item).
- Navigation: the shared kiosk and planning helpers still open some screens by address (as the route specs, D-7l-2);
  click-only navigation stays item 5 of the handover.
- D-7r-1's GMP branch is proven by the function's guard (pg_get_functiondef) in the sandbox test, not by a GMP batch
  without a product master (a GMP issue needs one).
