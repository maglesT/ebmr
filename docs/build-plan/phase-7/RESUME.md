# Phase 7: resume here (paused and resumed on 18 October 2026)

The owner paused Phase 7 for urgent work on another product ("pause it at some place from where it can be resumed later
from github"). Everything below is pushed to GitHub; no work exists only in a container. Read this page, then
`PROGRESS.md` and `docs/build-plan/phase-7/phase-7-plan.md` (the slice sections), then
`docs/build-plan/phase-7/review-backlog.md`. Decision 0025 (every act has a screen, no terminal to use the system) is on
branch `phase-7/slice-7g`.

## Merged into main

| Slice | PR | Content |
|---|---|---|
| 7-0 | #52 | interfaces: release identity, validation-summary approval, system description, evidence bundle v1, feed signature |
| 7a | #53 | decision 0022 fixes: signed gateway feed and mTLS, QA approval of plant rules, controlled reads, batch scope |
| 7b-1 | #54 | hardening list and review residuals |
| (notes) | #55 | these resume notes and the CLAUDE.md token rules |
| 7b-2 | #56 | stand-alone record viewer, full export of closed records, periodic evaluation pack |
| 7c | #57 | validation pack generators, DI-03 validation-summary gate (recipe-core 1250), DI-06 interface drift (kernel 1350 rebuilt from main's latest definitions, SERIES_GAP kept); review: no findings; golden 44/44 without a re-take |
| 7d | #58 | release drills, security tools and the route-by-role matrix, load driver (analytics runner in a worker thread, P6A7-8 role check kept in the worker), inactivity warning (tablets 1460), accessibility audit run (A11Y-4 to -7 fixed); review: no findings; golden run by CI's golden job (decision D-P7R-1: the local golden cluster was busy with 7e; same suite, same clock library) |
| 7e | #59 | branding (Batchwright, decision 0020), user and administrator guides, `tools/guides` (reference lists from a migration-built database, self-contained HTML and PDF); review: P7E-1 (low: a link with another scheme than http, https or mailto was live) fixed with a test; golden 51/51 |
| 7g | #60 | every act has a screen (decision 0025): administration and access governance, MBR signing, plant rules, incidents, operations and first-run set-up, and the four work packages (validation, export and records; restore, drills, platform and access settings; master-record, market and plant settings; floor, materials, batch numbers); US e-signature certification enforced (recipe-core 1260, fail closed); D-P7R-3 to -9; review P7G-1 to -5 fixed; golden 51/51, E2E 19/19 |

## Merge order from here (D-P7-9, amended by decision 0025)

7g (its parts 7g-1, 7g-2, 7g-4, 7g-5, and 7g-3 still to build), then 7f (exit).
Each slice: merge main into its branch, resolve, register its new SQL functions in `tools/sql-mutation/src/targets.ts`
(with a job in `.github/workflows/mutation.yml` for a new group, same order as TARGETS), claim its migrations in
`docs/handbook/modules.yaml`, `pnpm handbook`, run every test file the slice changed (and the folders around them) and
`pnpm register:sync-tests` from those results (missing a folder fails CI's register check: it happened on #54), run the
golden batches on the clock cluster if the slice can move them, one quick review, at most 2 fix rounds per finding, PR,
merge when green.

## State of each branch

| Branch | State | What is left |
|---|---|---|
| `phase-7/slice-7g` | decision 0025 and the 7g plan | the integration branch of the 7g parts |
| `phase-7/slice-7g1` | built: administration screens (people, grants, recertification, break-glass, devices), the route-completeness `[meta]` test | modules.yaml `ts-administration`; review |
| `phase-7/slice-7g2` | done 9a33286d: main merged; incidents E2E fixed (P7G2-2: report time without seconds was refused by the contract; the screen adds `:00`, the spec takes the server's clock); E2E phase7 3/3; group `specimen-approval`; modules ts-designer/ts-alarms/ts-incidents; register synced | integrate into 7g; the completeness `[meta]` test (only on 7g-1) must drop `plantRules.setFacilityRule`, `plantRules.classifyBetaLactam` and signable `MBR_TRANSITION`; `labels.masterLabelling` and `labels.declareLabelling` still have no screen (PENDING_7G2, open) |
| `phase-7/slice-7g4` | done a393aa52: main merged; operations E2E 5/5 (demo load: routes without a session no longer look one up during maintenance; the job panel follows the job); groups first-run-setup, operations-acts, operations-demo-backups; modules kernel-operations, ts-operations, tools-install; register synced | integrate into 7g; apply D-P7R-2 to `commands-have-screens.test.ts`; residual: `/api/meta` reads the database during maintenance (the page does not call it then) |
| `phase-7/slice-7g5` (from 7g-1) | WIP 6625ec3 plus 60628136: main merged; the US e-signature certification is now enforced (recipe-core 1260: `gmp_issue_problem` from 1250 plus the check, and a BEFORE INSERT trigger on `recipe.batch_execution`; 3 `[DI-15]` tests; demo set-up records the DEMO-ONLY letter) | run `governance.spec.ts` and `screen-gaps.spec.ts`; the 64 database acts of 7g5-1 need routes and screens (decision 0025); claim the 5 unclaimed WIP files in modules.yaml (administration feature and screens; contract people, device-registry, access-governance); review whether the merge's choice of main's idle warning lost the branch's rule that device-nonce and identify requests are not activity |
| 7g-3 | not started | after 7b-2, 7c, 7d merge: screens for the system description, validation-summary approval, full export, evaluation pack and its QA sign-off, evidence bundle, validation pack, IQ, restore and upgrade drills |

## State (19 October 2026): Phase 7 done, v1.0.0-rc.1

7f merged (the Phase 7 exit; checklist `v1.0-rc-checklist.md`, release notes `release-notes.md`, mutation record
`mutation-results.md`); tag `batchwright-tablets-v1.0.0-rc.1`; the bundle, pack, IQ record, SBOM and signed manifest are
assets of the GitHub release of the tag. Next: the v1.0 demo on the owner's server (server, SSH, a domain), then v1.0.

Decisions taken in 7f (owner rule: functionality first, least strict option within the hard rules):
- D-P7R-12: the load driver's site approves a DEMO-ONLY validation summary through QA's real signed act, as the test
  templates do (the DI-03 gate unchanged).
- D-P7R-13: the IQ checks and the build-status tool (not Priority 1) were not triaged in the mutation campaign (box);
  their first-run scores are residuals for the deployment re-run, with the 58 stale equivalent entries.
- D-P7R-14: final run 2's golden batches ran on 634bf2be, whose code under test equals 6f4adf9e (the difference is the
  E2E fixture and two compliance/validation YAML files).
- D-P7R-15: HIGH-5 of the Phase 3 exit review is recorded as closed by ADR-0019 (the guards are in force in the Tablets
  edition; their move to recipe-core comes before Phase 5).
- Owner, 19 October: the handbook is left as it is in 7f (only the generated pages are regenerated).

## 7g steps (done)

1. Integrate the 7g parts on `phase-7/slice-7g`: merge main, then 7g-1, 7g-2, 7g-4, 7g-5 (each already has main up to
   7d merged; 7e is merged in main by then). Expected conflicts: `targets.ts`/`mutation.yml` (keep all groups, main's
   first), the defect log and runbooks (keep all sections), generated handbook pages (regenerate), the completeness
   `[meta]` tests (apply the 7g-2 row above and D-P7R-2).
2. Finish 7g-5 (row above), then build 7g-3 (screens for the system description, validation-summary approval, full
   export, evaluation pack and its QA sign-off, evidence bundle, validation pack, IQ, restore and upgrade drills).
3. Per slice steps as above; the golden batches on the clock cluster (GB-T-03 moves with the US letter); E2E specs
   phase7, operations, administration; one quick review; PR; merge when green.
4. 7f exit: trace at 7, one review pass, the release-candidate checklist.
   Migration numbers: the exit-fix ranges of the Phase 7 plan (kernel 1390-1399, tablets 1490-1499) are partly used by
   7g (kernel 1395; tablets 1491, 1493, 1496), so a 7f exit fix takes the next number above the highest used in its
   package at that time.

Decisions taken on resume (owner's standing instruction to decide and record):
- D-P7R-1: when the local golden cluster is busy, CI's golden job on the PR (same suite, same clock library) serves as
  the slice's golden run (used for 7d).
- D-P7R-2 (`commands-have-screens`): IQ, the records CLI and the validation-pack builds (bundle, generate, oq) are
  acts that wait for 7g-3's screens (listed pending 7g-3, not exempt); `register:status` (a developer tool on the
  control register) and the stand-alone record viewer (itself the reading tool) are exempt.

- D-P7R-3: market policies stay in v1.0; their acts get screens (WP3). If the GMP batch issue does not already pin a
  batch's market policies, `market.pin_policies_for_batch` runs inside the issue transaction (a step of the person's
  issue, not a screen); a golden output that moves is re-taken once with the reason in the defect log.
- D-P7R-4: the upgrade drill runs only on a sandbox or staging installation (it needs admin database access and
  creates databases); on a GMP installation the screen shows the drill records and runs the restore drill as a job.
- D-P7R-5: IQ (`runIq`) moves into `packages/validation-kit` so a route can run it and store its record; the CLI
  keeps working by importing it.
- D-P7R-6: WP3's reclassification (tablets 1493) of `compendial_rule_set` and `qp_register` from GOVERNANCE to RECORD
  in `tab.aggregate_read_class` is rejected: it widened read access to every RECORD.READ role and reversed tablets 1161
  without a control review. Both stay GOVERNANCE; the signer reads what they sign in their own session (tablets 1493
  re-creates `tab.record_read_problem`: a role that may sign the meaning, or a governance role; the handlers read through
  `tab.content_for_signing` with `readForSigner`, as RESTORE_APPROVE does). Test: `test/esig/signing-meanings-7g.test.ts`.
- D-P7R-7 (owner, 19 October): the full reference-site load test and the 4-hour soak move to deployment. The 10-minute
  load smoke of 7d stays in the 7f pod run, and so does the focused mutation campaign of D-P7-1 item 4 (on Phase 6A and
  Phase 7 code and anything they re-created). The release-candidate checklist reads "deferred to deployment (owner
  decision D-P7R-7)" for the SLO and soak records. The pod run is about 17-18 hours instead of 24.
- D-P7R-8 (owner's standing instruction): a route whose only effect is an audited export or copy of existing records
  changes no GMP record, so the segregation check of `route-matrix.test.ts` counts it as an audited read for the
  read-only auditor (kernel 1335 grants RECORD.EXPORT to the auditor, a reviewed 7b-2 design). The explicit, commented
  list: `validation.startFullExport`, `archive.assembleExport` (true copies and the evidence export register),
  `controlled.runRegister` (the stored register export). Every other write still fails the check for the auditor; the
  system administrator stays refused all three.
- Owner rule (19 October): the focus is functionality; for an open question with a choice, take the less strict
  option, the minimum compliance that keeps the product usable. The CLAUDE.md hard rules stay (no control removed, no
  expert_decision changed by an agent; a control that blocks basic use is written up for the owner).
- D-P7R-10 (owner): the system administrator keeps the grant-approval rights of kernel 0120 (no change).
- D-P7R-11 (owner): a loan licensee needs no US e-signature letter of its own; the host licence holder's covers it (as
  built in recipe-core 1260).
- D-P7R-9 (review P7G-1): the segregation check no longer exempts the whole `people` and `deviceRegistry` namespaces for
  the system administrator; it names the routes that may succeed (person, account, credential and badge
  administration, devices and gateways, the creation of an empty role, the attribution method), each with its reason.
  Granting authority is not among them. The administrator keeps IAM.GRANT_APPROVE and IAM.ROLE_MANAGE (kernel 0120, a
  Phase 1 design); new tests show they cannot approve a grant or role-permission request they made, nor one that grants
  themselves (both refused by kernel 0120's triggers, EBMR-IAM-032; no new guard was needed).

### 7g state (18 October, evening)

`phase-7/slice-7g` holds the integrated parts (9647df5d) and the scaffold for four parallel work packages (73461266:
reserved signable kinds, stub `validation` and `market` features, `// WP1..WP4` blocks in the three meta tests). The
packages build on `phase-7/slice-7g-wp1` (validation, export, records, esig), `-wp2` (continuity, drills, platform and
access configuration), `-wp3` (master-record, market, plant configuration, labelling), `-wp4` (floor, materials, batch
numbers). Then: merge the four into `phase-7/slice-7g`; root-cause the web test `justify-revision` that fails only in
full runs (and check `readings-after-refusal`); run E2E administration, operations, phase7 and sync the register (18
E2E entries wait for it); golden on the clock cluster (GB-T-03 and the US letter; D-P7R-3); one quick review that also
checks the integration's change letting the system administrator use the `people` and `deviceRegistry` routes (it must
not reach role or permission grants) and the idle-warning rule the 7g-5 merge dropped; PR; merge when green.

## Open findings to carry

- **US e-signature certification (high, from 7g-5): fixed on `phase-7/slice-7g5`** (recipe-core 1260, 3 `[DI-15]`
  tests), merges with 7g. GB-T-03 issues a US-market batch: run the golden batches in the 7g integration (the demo
  set-up now records the letter; re-take a golden output once with the reason in the defect log if it moves, D-P7-12).
  A loan licensee needs no letter of its own: the host licence holder's letter covers loan-licence batches (owner,
  D-P7R-11; as built).
- A role-permission approval needs an approved change record (DI-09): the 7g-5 screen must lead the user through it.
- The system administrator keeps IAM.GRANT_APPROVE and IAM.ROLE_MANAGE (kernel 0120, as built; owner, D-P7R-10); the
  second-person rules hold (D-P7R-9).
- P7A-6 (feed signature does not cover the envelope's source time and record id): residual, low.
- F-6jb-g1 (record lock counts as a change since review): residual, fail-safe.

## Local environment notes (a fresh container needs none of these; for a resumed one)

- Clusters: main 5432, b5a 5435, b6a 5437, b6b 5439, gate6 5444, golden6e 5449, the golden clock cluster g6a1 5451
  (`EBMR_FAKETIME_FILE=/var/lib/postgresql/faketime-g6a1/offset`,
  `EBMR_GOLDEN_CLOCK_LIB=/usr/local/lib/ebmr/golden-clock.so`). 7d kept its drill databases `ebmr_drill6a_e2e_7d01` and
  `ebmr_drillrc_e2e_7d01` on 5439 (the first takes 12 minutes to rebuild).
- Golden runs: never start a second golden run while one is alive (a killed background run's workers can survive and
  move the shared clock file; GB-T-01 then fails with "the golden clock only moves forward"). Check `ps` first.
- A 4-CPU container cannot run more than about three suites at once: clusters crash under memory pressure and restore
  tests time out (load, not code).
- E2E on a spare cluster needs both `EBMR_PG_ADMIN_URL` and `EBMR_PG_PORT`; always under `flock /tmp/ebmr-e2e.lock`.

## Slice 7h (20 October 2026): the v1.0 gaps found on the hosted demo

Source: `demo-gap-report.md` (the hosted demo's review of v1.0.0-rc.1: acts without a screen, A1-F3). Branch
`phase-7/slice-7h` (main plus `deploy/demo-server`). Work packages, each on its own branch from `phase-7/slice-7h`:

| WP | Scope | Branch | Migration numbers |
|---|---|---|---|
| WP-A | A1-A9 floor acts: routes, kiosk badge-tap attribution (INV-40), step-screen actions; A1 on the lot screen, A9 on `/plant` | `phase-7/slice-7h-a` | 1530-1549 |
| WP-B | B1-B4 master record: change record, risk assessment, draft attributes, automatic validator/simulation evidence, sandbox-to-GMP test-run result package | `phase-7/slice-7h-b` | 1550-1569 |
| WP-C | C1-C5, E1, E2, E5, F1, F2, D4 | `phase-7/slice-7h-c` | 1570-1589 |
| then | D1 meta test, D2 and D3 browser tests (no database arrangement), integration, one review pass | `phase-7/slice-7h` | 1590-1599 |

Decisions (owner rule: functionality first, least strict option within the hard rules):
- D-P7R-16: the designer's validator report and simulation are recorded as evidence automatically when the author
  starts verification; the sandbox test run returns as a hash-checked result package (exported on the sandbox run
  page, imported on GMP), mirroring the outbound package; nothing is typed in by hand.
- D-P7R-17: E3 (a simulated GMP balance and gateway), E4 (the scale console behind the proxy) and E6 (trusted proxy)
  are deferred to deployment; GMP weighing on the demo stays the manual two-person path; E4 keeps the SSH tunnel.
- D-P7R-18: F1 hides the home tiles a role cannot use (the server stays the authority); F2 is checked and, if the
  fresh-authentication check answers before the permission check on a read, the permission check goes first.
- D-P7R-19 (D1): `db-acts-have-routes` no longer counts `apps/tablets-server/src/cli` (the demo load's library) as a
  route; it then found C1, C3, C4 and `esig.register_seal_key`, which stays without a screen: registering a seal key
  comes with installing its secret on the server (first-run set-up, set-up CLI); retiring one has its screen.
- D-P7R-20 (WP-B): the sandbox test-run result package is hash- and stamp-checked, not signed (the phase-2 plan's
  Ed25519 signature is left to deployment); its GMP checks are in TypeScript.
- D-P7R-21 (D2): the G-21 step screen shows the record's coding (what the coder must print) beside the operator's own
  reading of the specimen, as a printed-line check normally does; the database still compares the reading (IN-16).

## Slice 7i (20 October 2026): the hosted demo's follow-up after 7h

From `demo-followup-7h.md`, on branch `phase-7/slice-7i`; no migrations.
- G1: `session.demoDevices` adds `otherPersonas` to each shop-floor terminal (every badge holder of the installation
  not at home there; `features/session/demo-devices.ts`); the demo badge reader groups them "Works here" and "Other
  people". The badge field's autofill and paste refusal (BADGE-AUTOFILL) is unchanged; the server decides at sign-in.
  `gmp-kiosk-batch.spec.ts` signs the floor people in with the Tap buttons (`signIn.kiosk(..., 'demoButton')`);
  `phase7/demo-badge-reader.spec.ts` signs in on KIOSK-BLEND-1 by pressing a button.
- G2 (P7H-4): `execution.planBatch` takes `erpOrder`; the plan form sends the order card's number; the database checks
  it (recipe.erp_order_problem); without it the oldest open order is taken as before. No user-guide caveat is needed.
- P7H-5: the session's `EBMR-TAB-*` guidance (409 STALE, "The sign-in could not be completed") caught every block
  guard's EBMR-TAB code; it now applies to the session-binding codes only, and the family is a 422 refusal whose `why`
  is the database's message. The floor's stale notice also shows the refusal's message and code.

## Slice 7j (22 October 2026): R4, a company's own tablet product without a template

From `demo-trial-requirements.md` R4, on branch `phase-7/slice-7j`; migrations site-services 1530, recipe-core 1535.
- D-7j-1: products and materials are entered on screen (Master data, Products and materials) by the master-data
  steward (MASTER_DATA.ENTER) into the same ERP master tables with the reference `ENTERED ON SCREEN`; such a version
  never takes effect on receipt: QA confirms it (ERP_MASTER_CONFIRMED on the ERP import status screen, a second person).
  The ERP stays the normal source. Grade, pharmacopoeia and dosage form are kept in `site.master_entry` and signed.
- D-7j-2: the approved-manufacturer link of a material is the register's own (Quality, Approved manufacturers): the
  materials table lists the approved manufacturers of each material and links the register; the steward does not
  propose them (MATERIAL.QA_DISPOSITION stays QA's).
- D-7j-3: a formula version may carry the target tablet weight (mg) and further batch sizes (units), written once with
  the composition and signed with it (recipe-core 1535). The formula's identity keeps one reference batch size.
- D-7j-4: a material with no MATERIAL document is pinned to the material master version in effect (reference version
  `ERP-<id>`, hash over its values); a registered document always wins.
- D-7j-5: `designer.createFamily` without `templateId` starts from the approved formula: SKELETON, BLANK or COPY of an
  approved master; header, batch sizes (scaled from the formula's batch mass, three decimals) and BOM from the formula;
  the template-match check (`withFormulaBom`) stays on the template path only.
- D-7j-6: the skeleton is shaped from the dc-mini demo master's dispensing and blending stages (G-09@1 and G-10@1, which
  the sandbox runs; the validator's INFO says a GMP batch refuses them, the author inserts @2 from the palette once the
  plant is registered), blending as TB-07 (60 to 900 s blend, 30 to 300 s lubrication, VR-BLEND-01), and reuses the demo SOP, validation and
  hold-study references; the author replaces them with the product's own documents in the designer.
- D-7j-7: the palette is the Tablets registry: every TB-01 to TB-24 version and every generic step block (G-06 and G-21
  unhidden); configuration forms come from each block's schema as before.
- D-7j-8: the designer adds, renames, rebinds (rooms), moves and removes stages and adds or removes stage equipment by an
  effective EQUIPMENT_CLASS document; a new stage starts with its clearance and equipment status. Parameters,
  calculations, yield checkpoints and intermediates are still created by the template, the skeleton or the API.
- D-7j-9: the sandbox's TEST- lots are registered on screen (sandbox home, Test lots; `execution.registerTestLot` over
  tab.register_sandbox_lot, MASTERDATA.CHANGE): released and identity-tested, as the seed's demo lots.
- D-7j-10: the demo seed puts the walk-through's materials (DMT-API, DMT-LAC, DMT-MGS) in the ERP master and a sandbox
  TEST- lot of each after every reset; the product is entered on screen.
- D-7j-11 (review P7J-2, lead): a master from a formula takes the product name from the product master in effect and
  its dosage form, or 'Tablet' when the master carries none (the ERP feed has none; every product of the edition is a
  tablet), so ERP-only products stay usable; a master stating a non-tablet dosage form is refused.
- Not done: R4's optional "save an approved master as a template"; the GMP batch of the new product (needs R1's plant).
  The browser flow uses the start page's address and the existing screens' addresses for the change record, review and
  signing screens (as `master-records.spec.ts`), clicks elsewhere.

## Slice 7o (23 October 2026): R4 end to end, the coating layers (R8 P3)

On branch `phase-7/slice-7o`; no migration (the engine, validator, simulation and database take three TB-18 layers as
they are). Decisions in `slice-7o-routes.md`:
- D-7o-1: the plant, containers, the batch's plant reads and the packaging completion on both installations, each against
  its own database (ADR 0021); the DEMO-ONLY sandbox plant (`cli/sandbox-plant.ts`, `--sandbox-plant`).
- D-7o-2: the designer's "Add a coating layer" (own TB-03, TB-18 cores and TB-18 coating loop, in one coating stage).
- D-7o-3: a packaging master as a copy of an approved packaging master with the product's printed items.
- D-7o-4: a lot's assay (GMP: approved LIMS results; sandbox: typed) and a printed lot's artwork version on screen; the
  identity result on the lot page.
- D-7o-5: a copy for another formula takes the formula's standard per tablet.
- Browser helpers for the R8 products: `tools/e2e/specs/phase7/own-product-flow.ts` (office) and `own-product-floor.ts`
  (kiosks, either installation).

## After Phase 7

7f exit (trace at 7, one review pass, the release-candidate checklist), then the heavy run on the pod (about 17-18 pod hours,
D-P7-3 as amended by D-P7R-7), then the demo server (owner to provide a server, SSH and a domain; decision 0021 and 0025), then Tablets v1.0.
