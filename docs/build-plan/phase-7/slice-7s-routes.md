# Slice 7s: P3 rabeprazole ready for the presenter (the demo set-up's seeded state)

Owner decision, 25 October 2026: requirement R8 is limited to P3 rabeprazole for now (P1, P2 and P4 to P12 are
deferred), and the owner wants to demo a rabeprazole batch. Branch `phase-7/slice-7s`, from `phase-7/slice-7r` (PR #76,
which merges first; merge main into this branch after it).

## What was built

- **Seed** `apps/tablets-server/src/cli/demo-p3.ts` (DEMO-ONLY; refuses production through the set-up CLI's
  `demoSeedRefusal` like every packaging-option seed). Every act is the seeded persona's own, through the in-process
  server (`demo-app.ts`) or the feature-seed acts the other demo seeds use (`seedLot`, `seedSpecification`,
  `confirmErpMasters`):
  - the ERP posts the product RAB-GR-20 ("Rabeprazole sodium 20 mg gastro-resistant tablets (invented, DEMO-ONLY)"),
    its active MAT-RAB-API and its printed foil MAT-RAB-FOIL and carton MAT-RAB-CTN; QA confirms them; the licence
    DEMO/MH/25/0703 (Form 25) endorses the product (regulatory records, QA approves);
  - specifications approved by the head of QC: the active (assay 98.0 to 102.0 %, water at most 1.5 %), the foil and
    the carton (text check), the product (assay 95.0 to 105.0 %; DISSOLUTION as one profile test: "Acid 2 h" in 0.1 M
    HCl at most 10 %, "Buffer 45 min" in pH 6.8 buffer at least 75 %; samples in packs). The in-process tests are the
    master's own steps (TB-12 weight, TB-13 thickness and hardness, TB-14 friability, TB-15 acid-then-buffer
    disintegration, TB-18 each coat's core sample and weight gain);
  - lots RAB-API-0001 (25 kg, assay 99.40 %, water 0.60 %, its approved assay on the anhydrous basis for TB-01),
    RAB-FOIL-0001 (20,000, artwork ART-RAB-FOIL-1), RAB-CTN-0001 (5,000, artwork ART-RAB-CTN-1): received, examined,
    tested, approved, identity tested and released, from the approved manufacturer; the excipients, the enteric coating
    system and the cold-form laminate are the demo routes' lots (RTW-*, D-7r-4);
  - the formula of 1,50,000 tablets (125 mg cores) written by the steward and approved by QA;
  - the processing master RAB-WG-DEMO: from the formula as a copy of route W's approved wet-granulation master
    (`designer.createFamily`, start COPY, as the author's screen), the author's designer edits of Rabeprazole 2
    (`rabeprazoleEdits`), the seal coat before and the top coat after the enteric coat (the designer's layer builder),
    saved as a revision; change control, the sandbox-run evidence of its content, the verification (the designer's
    gate: no error, no unjustified warning), the four signatures, the IN authorisation at SITE-1 L1 for BS-150000U,
    numbering rule RAB-PROC-DEMO `RAB{YY}{SEQ:3}`;
  - the packaging master RAB-CF-DEMO: a copy of route W's approved cold-form master naming the product's foil and
    carton and their artwork versions (`designer.createFamily`, start PACKAGING_COPY, D-7o-3), approved the same way,
    IN at SITE-1 L1 for PK-1K, numbering rule RAB-PACK-DEMO `{PARENT}/P{SEQ:2}`;
  - the plant product and its tooling set TS-RAB-DEMO (B, round 7.0 mm biconvex, R20).
  `<keys>/gmp-p3-demo.json` names the product, lots, masters, tooling and the profile's point labels.
- **Gate** (as the SR seed, D-7p-8): set-up CLI `--gmp-p3-demo` (with `--gmp-packaging`); `pnpm demo:setup
  --with-gmp-samples` turns it on (`tools/demo/src/options.ts`, `stack.ts`, `setup-options.test.ts`); the E2E global
  set-up only for the group `p3-demo` or a run without a group.
- **E2E group** `p3-demo` (`playwright.config.ts` E2E_GROUPS, `ci.yml` dispatch description and the e2e-plan `ALL`
  list): `tools/e2e/specs/phase7/p3-demo.spec.ts`, five tests, the presenter's path from the seeded state with the own-p3
  helpers and control IDs: (1) the seeded numbering rules, the ERP order, plan and issue, reservations; (2) the
  processing on the kiosks with the three coats; (3) the packaging order on KIOSK-PACK-2; (4) the finished lot, QC's
  assay and both dissolution stages, the reserve sample, the head of QC's approval; (5) both reviews and the release with
  G3.PROFILE_DISSOLUTION green. The P3 floor plan and reservations moved to `own-product-p3-plan.ts` (shared with
  own-p3).
- **Unit test** `apps/tablets-server/test/seed/p3-demo.test.ts` (IN-37, PR-29): the edited master defines without an
  error, the three coats in order with their own items, the edits' values.
- `commands-have-screens.test.ts` lists `demo-p3.ts` like `demo-sr-profile.ts`. No migration, no SQL function (nothing
  for sql-mutation).

## Decisions

- **D-7s-1**: the P3 demo is opt-in (`--gmp-p3-demo`), turned on by `pnpm demo:setup --with-gmp-samples` and by the E2E
  set-up only for the `p3-demo` group (or no group), not for every group (the lesson of the SR seed, D-7p-8).
- **D-7s-2**: the designer's "Add a coating layer" builder (`coatingLayerParts`, `layerProblem`) and the content-id set
  (`contentIds`, the designer's `allIds`) moved from the web designer to `@ebmr/recipe-core/pure` (flow/coating-layer.ts),
  unchanged; the designer re-exports them. The seed builds the layers with the same code as the screen (apps never
  import each other), so the seeded master is the master the own-p3 browser test builds on screen.
- **D-7s-3**: like every demo master (`release-path.ts` approve, now split into `approve` and `approveVersion`), each P3
  master's SANDBOX_RUN evidence is recorded for its content rather than run on the sandbox's kiosks; the own-p3 group
  proves the real sandbox runs of the same masters. The verification gate, the four signatures and the IN authorisation
  are the real ones.
- **D-7s-4**: fixed codes (RAB-GR-20, RAB-WG-DEMO, RAB-CF-DEMO, TS-RAB-DEMO, lot codes RAB-*-0001) rather than a random
  tag, so the presenter's script names them; the seed is skipped part by part when its records exist (a set-up run
  again).
- **D-7s-5**: the product, its active and printed materials come from the ERP catalogue (as the other demo products);
  own-p3 proves the on-screen entry.

## Status

| What | Result |
| --- | --- |
| Seed locally (copy of a `--gmp-review-batch --gmp-packaging` demo database, PostgreSQL 16) | OK in 9 to 10 s; both masters APPROVED, both numbering rules, lots released |
| Base set-up the seed adds to (`--gmp-review-batch --gmp-packaging`, this 4-CPU container) | about 14 minutes |
| Unit test p3-demo.test.ts, designer tests, meta tests, tools/demo/test | green |
| CI run 40157721804 (dispatch, group p3-demo, head 5a0a10ee) | **5 of 5 passed** (about 29 minutes of tests: 0.4, 20.1, 3.6, 0.2, 4.7 min) |
| Register | the 25 control entries synced from that run and the unit test (`register:sync-tests`) |

## Residuals and where to continue

- Done: the p3-demo group is green. Merge main into the branch once PR #76 (slice 7r) is merged; then one quick review pass and the PR.
- The hosted demo needs `pnpm demo:setup --with-gmp-samples` again to get P3 (the set-up adds about 10 s to it).
- A presenter's script for the P3 demo (the five steps above, the personas and terminals of `p3-demo.spec.ts`) could go
  into the user guide.
