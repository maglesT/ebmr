# Slice 7r: the R4 GMP batches (piece 1 of 2: Demotab from its first lots to the released lot)

Requirement R4 of `demo-trial-requirements.md`: "GMP batch on the kiosks through packing, QC, review and release" for the
company's own product made on the screens. Slice 7o proved Demotab 400 mg (invented) up to an approved master authorised
for India (browser tests Demotab 1 to 3). This piece runs Demotab's GMP batch on the screens only, as a presenter would
(browser tests Demotab 4 to 12 in `tools/e2e/specs/phase7/own-product-gmp.spec.ts`, E2E group `own-demotab`). Piece 2
(the P3 rabeprazole batch with three coating layers and P3's two-stage dissolution release from 7p) is not part of it.

## Status

In progress (piece 1 stopped early at the lead's call, 24 October). Branch `phase-7/slice-7r`. Pod run 40085241774
(head 78426fe3): Demotab 1 to 4 passed; Demotab 5 failed only on the spec's check of the receipt examination (the form
goes once the examination is recorded; fixed at afe25bd8: the receipt record's Examination line is read). Pod run
40087409907 (head afe25bd8) was running when this was written: its result is the next agent's first read
(`gh api repos/maglesT/ebmr/actions/runs/40087409907 --jq .conclusion`; on failure the artifacts e2e-blob-own-demotab
(report.jsonl) and e2e-output-own-demotab (error-context.md)). Demotab 5 to 12 have never passed yet on the pod.

Where the next agent continues: read run 40087409907's first failing test, fix the spec or the product (fix-finding
skill), push, dispatch the own-demotab group again (`gh api -X POST repos/maglesT/ebmr/actions/workflows/ci.yml/dispatches
-f ref=phase-7/slice-7r -f 'inputs[e2e_groups]=own-demotab'`), until Demotab 12 releases the lot. Expected risk points,
in order: the GMP lot release (Demotab 5: QA's decision, the assay chosen from results), the batch issue (Demotab 6:
the licence endorsement added in Demotab 4, the reservations of the shared lots, GBT-FCS-001's stock), the GMP floor
(Demotab 7, the same acts that pass on the sandbox), the packaging copy's checks (Demotab 8: the copied TB-24 keeps its
EU anti-tampering check on an IN-only copy), the sandbox packaging run (Demotab 9: TB-24's configured unit CTN-03 on a
sandbox whose units are TEST-, the coding with D-7r-1), and the release checklist of a new product (Demotab 12).

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

## Residuals

- Demotab 5 to 12 not yet green on the pod (see Status).
- The R4 guide part "create your own product" is not extended to the GMP batch (R3.14 regeneration item).
- Navigation: the shared kiosk and planning helpers still open some screens by address (as the route specs, D-7l-2);
  click-only navigation stays item 5 of the handover.
- D-7r-1's GMP branch is proven by the function's guard (pg_get_functiondef) in the sandbox test, not by a GMP batch
  without a product master (a GMP issue needs one).
