# eBMR: current state

Keep this page short (under 150 lines): the current state, the rules in force and the next steps. Append history to
`docs/progress/history.md` (search it; do not read it whole). Last updated: 1 November 2026 (decision 0026: dynamic library; slices S0 and S1).

## What this is

An electronic Batch Manufacturing Record system for Indian pharma manufacturers who export. India Revised Schedule M
always applies; US FDA and EU GMP apply per market; the stricter rule wins. Tablets edition first, through Phases 6 and 7 to
v1.0; Injectables (Phase 5) comes after that (decisions 0002, 0010). The approved plan is `docs/outline/build-outline.md` (v0.2; section 11 is the phase
plan), as changed by the owner decisions in `docs/decisions/` (0001 to 0010).

## Rules in force (owner)

- **Decision 0026 (1 November 2026): dynamic library, freeze the extras.** Library blocks are data (forms built
  from fixed field types, QA-approved and versioned); formulations are assembled on screen and batches generated from
  them. Frozen (kept in the repo and in CI, no new work): injectables, site gateway, simulators, analytics/MSPC,
  integrations, QP package, contract giver, EU importer register, PQR, dashboards, CAPA, training, incidents,
  alarms, kiosk extras, the sandbox evidence package and the Phase 7 product backlog (R7, R8, R11, R12). Plan:
  `docs/build-plan/dynamic-library/plan.html`.
- Owner, 19 October: the focus is functionality; open questions take the less strict option, the minimum compliance
  that keeps the product usable (within the CLAUDE.md hard rules). Load test and soak move to deployment (D-P7R-7).

- Decision 0008: the goal is software that works properly with no major defects. Tests with every feature and green
  CI always; one quick review per feature or slice; a quick review at the Phase 3 exit; at the Phase 4 exit one review
  pass, the full suite, the golden batches and the browser suite. At most 2 fix rounds per finding. Validation-grade
  testing (mutation targets, multi-round adversarial review, IQ/OQ/PQ) belongs to deployment. Database enforcement for
  the regulation-required core only. The F12 sandbox identifier rule is frozen at kernel 1140 / recipe-core 0350.
- Decision 0009 (10 October, approved; amends 0008 for the Phase 3 exit): an Opus mutation run on all Phase 3 code and
  on Phase 1 and 2 code changed since their exit runs; one Opus review pass (design, serious defects); critical and high
  fixed, each with its own test; then one final run of the suite, E2E, trace and GB-T-01. The 0008 relief stands.
- Decision 0010 (10 October): Tablets to v1.0 (Phases 3, 4, 6, 7) first, Injectables after. Shared-code changes keep
  the injectables extension points open; the trace gate must leave injectables-only controls out before phase.yaml passes 4.
- Token economy (owner, 9 October): see CLAUDE.md. Top model for building, design and security fixes; Sonnet for
  quick reviews; Haiku for mechanical jobs. Up to 5 agents at a time and overlapping independent slices (decision 0017), short reports, short command output.
- Defaults: take the default for any open question (decision 0004) and record it.
- Merge a PR yourself when CI is green, then start the next slice at once: keep going slice after slice without waiting
  for the owner (owner, 15 October); take every decision yourself (owner, 15 October: "dont ask any decisions take it"),
  record each with its reason; only the hard rules stay the owner's (never weaken a control or change `expert_decision`). Push each checked commit. No deletion without the owner's OK.
- Never edit an existing migration; add new ones. Never weaken a control or change `expert_decision`.
- Paraphrase regulations. No patent formulations. No model names in commits. Never commit the scratchpad `src/`
  folder (copyrighted pharmacopoeia texts). Do not use the repositories maglesT/ds or
  maglesT/deep-learning-for-earth-observation for this project.

## Where things stand

- Phases 0, 1 (compliance kernel), 2 (recipe engine and designer) and 3 (Tablets edition, PRs #7 to #18) are done;
  details in `docs/progress/history.md` and the phase plans. Phase 3 exit per decision 0009 (Opus review and mutation
  runs; residuals in `docs/build-plan/phase-3/review-backlog.md`).
- Decision 0010: Tablets reaches v1.0 first (Phases 3, 4, 6, 7), then Injectables.
- Phase 4 (review, release and India specifics; PRs #19 to #28): seven slices, the exit review (no critical or high),
  the trace at phase 4 and the focused mutation work (decision 0012; `docs/build-plan/phase-4/mutation-results.md`).
  The owner's defaults of 13 October stand (D-7b-1, PR-30, IN-18 as D-6a-7, D-2a-9, D-P4-6, D-3a-10, D-5b-2, the
  drying-loop correction and India subdivision). Details: history, "Phase 4" and "PROGRESS.md condensed".
- Phase 6 (integrations and extras; PRs #30 to #42): slices 6a to 6g, 6i and the exit 6j (6h dropped, decision 0018).
  Final run 2 (17 October): 6,695 tests passed, golden GB-T-01 to GB-T-03 41/41, browser suite 50/50, `pnpm trace` at
  phase 6 ok (146/242 controls), `handbook:check` ok; mutation campaign results in
  `docs/build-plan/phase-6/mutation-results.md`. `phase.yaml` is at 6. Owner decisions 0020 (product name Batchwright),
  0021 (no demo at phase exits from Phase 7 on), 0022 (the Phase 6 owner items; R9, R10, R2 and the rest of R16 are
  fixed early in Phase 7; IN-53 stays a draft).
- Developer handbook and code map for Phases 1 to 4 (decisions 0013, 0014) on `docs/handbook-phase-1-4`:
  `docs/handbook/` (primer, glossary, architecture, life of a batch, database, testing, adding a feature, defect log,
  removed and replaced, runbooks, eleven module guides; Draft) and the generated code map and reference pages
  (`pnpm handbook`; `pnpm handbook:check` and a [meta] test keep them current and the links valid). Default D-HB-1:
  existing migrations stay byte-identical; only new ones carry a `-- Handbook:` line. Code/doc disagreements found
  while writing are in history (14 October) for the owner.
- CI runs the tests in six shards; see REPO-GUIDE.md. The chained `pnpm run ci` can hit the lint heap limit locally;
  lint now runs with an 8 GB heap.

## Next

**Start here (1 November 2026): the dynamic library (decision 0026).** Slices S0 to S11 in
`docs/build-plan/dynamic-library/plan.html` section 5. S0 (decision record, this page) and S1 (block-definition
model and sanity checks, `packages/recipe-core/src/library/`) are on branch `dyn/s0-s1`. Next: S2, the generic
handler that runs a library definition in the engine. The Phase 7 notes below are history for the frozen work.

**Start here (24 October 2026):** `docs/build-plan/phase-7/HANDOVER-2026-10-24.md`: open PRs and branches (7p, 7q, 7o),
the next work in order, the RunPod CI runner plan and the token rules.

**Phase 6A (analytics; decision 0023, owner, 17 October).** Plan `docs/build-plan/phase-6a/phase-6a-plan.md`; ADR
0020 (the pure package `@ebmr/analytics`, a runner reading as `ebmr_analytics` with no GMP privilege, the non-GMP,
insert-only, audited `analytics` schema); interfaces in `slice-6A-0-interfaces.md`. Draft controls DI-51, DI-52, DI-53
and PR-61 (status U, PENDING, target phase 7; 246 controls, 680 rows). Defaults D-6A-1 to 23 and each slice's
D-6A-n-* in the plan. On main at ddf3dfe (PRs #43 to #49):
- 6A-0 interfaces (kernel 1240 to 1244, recipe-core 1110, tablets 1330); 6A-1 foundation (runner, input views
  recipe-core 1115, method change control kernel 1245, screens; golden batches unchanged with the runner on);
- 6A-2 SPC, capability, drift and deviation rates (recipe-core 1130); 6A-3 multivariate monitoring (kernel 1270, 1271:
  a set carries its candidate's model, a repeated flag listed once); 6A-4 audit-trail flags (kernel 1260, 1261,
  recipe-core 1150, 1151); 6A-5 review priority (recipe-core 1160; one high fixed in its review, P6A5-1); 6A-6 golden
  batch profile (recipe-core 1170; one high fixed, D-6A-6-12). Per-slice details: the plan's "as built" sections and
  history ("PROGRESS.md condensed").

**Phase 6A exit (slice 6A-7, 17 October; branch `phase-6a/slice-7`, trace half and review half merged).** Phase 6A is
built and merged (PRs #43 to #49): the six analytics features, all advisory.
- **Exit review:** 0 critical. 3 high, fixed: P6A7-1 (flag grouping made one design, kernel 1280), P6A7-2 (the
  audit-trail term of the review score restricted in the database, kernel 1281), P6A7-3 (bounded runs). P6A5-2 fixed
  too (kernel 1282: a QA false alarm no longer counts in the review score). Residuals P6A7-4 to 9 are in
  `docs/build-plan/phase-6a/review-backlog.md`; defaults D-6A-7-R1 to R5 and D-6A-7-b-1 to 7 are in the plan.
- **Trace:** the 4 drafts DI-51, DI-52, DI-53 and PR-61 have all 23 clauses proven at a phase-7 dry run, still PENDING
  the owner (target phase 7 kept, `phase.yaml` at 6). `pnpm trace` at 6 is ok (151/246).
- **Local runs:** 6,882 tests, golden 44/44 with the runner on, E2E 4 new flows (`tools/e2e/specs/phase6a/`). The
  handbook module `modules/analytics.md` is complete.
- **Open:** the 6A exit closes on GitHub CI; its heavy final run is combined with the Phase 7 exit run on the pod
  (D-6A-15).

**Phase 7 done (19 October 2026): Batchwright Tablets v1.0.0-rc.1.** PRs #52 to #60 and the 7f exit PR; tag
`batchwright-tablets-v1.0.0-rc.1` on the 7f merge commit. Details: `docs/build-plan/phase-7/phase-7-plan.md`, the
checklist `docs/build-plan/phase-7/v1.0-rc-checklist.md`, release notes `docs/build-plan/phase-7/release-notes.md`,
history (19 October).
- Final run 2 (pod, 16 vCPU): 7,471 tests passed, 0 failed; golden 51/51; browser suite 75/75; `pnpm trace:e2e` at
  phase 7 ok (156/246). `phase.yaml` is at 7; no clause is deferred to 7.
- Exit review: no critical or high (P7X-1 medium, P7X-2 low: known issues). No open critical or high in any backlog.
- Drills on the pod: upgrade from the 6A exit and migration dry run PASS, restore PASS; security scans clean; IQ 10/11
  (IQ-09 fails on a demo database by design); load smoke every SLO met. Reference load test and soak: deployment
  (D-P7R-7).
- Mutation campaign (`docs/build-plan/phase-7/mutation-results.md`): no product defect; no Priority 1 survivor open
  except `iam.first_run_setup#11` (one-microsecond expiry boundary, for the owner); a harness defect fixed (M7-T3b-1).
- Build statuses (register:status): 111 VERIFIED, 13 IMPLEMENTED; the gap to D-P7-1's 147 is listings (release notes).

**Hosted demo (19 October)** on the owner's VPS: `docs/operations/hosted-demo.md`. Its review of rc.1 found person acts
with no screen (`docs/build-plan/phase-7/demo-gap-report.md`).

**Slice 7h (20 October, PR #63): every act has a screen again.** Floor plant acts on the step screen (A1-A9), the new
master record through screens only (B1-B4, the sandbox test-run result package), configuration forms (C1-C5), the
decision-0025 meta test no longer counts the demo load as a route (D1), browser tests for a full GMP batch on the kiosks
(`phase7/gmp-kiosk-batch.spec.ts`) and a new master record to approval with nothing arranged in the database (D2, D3),
demo set-up with GMP samples and the missing personas (E1, E2, E5), home tiles by role and kiosk reads checked for the
right first (F1, F2). Decisions D-P7R-16 to 21 (RESUME.md); review residuals P7H-2 to 5. No migrations.

**Slice 7i (20 October): the hosted demo's follow-up** (`docs/build-plan/phase-7/demo-followup-7h.md`). G1: on a demo
installation every kiosk's demo badge reader offers every badge holder ("Works here", then "Other people"); G2 (P7H-4):
a processing batch is planned against the ERP order clicked; P7H-5: a database refusal of a step entry is shown in its
own words (the EBMR-TAB family no longer reads as a failed sign-in). No migrations.

**Slice 7k (22 October, branch `phase-7/slice-7k`): hosted-demo trial requirements R2, R3.1-R3.13 (not R3.14), R5**
(`docs/build-plan/phase-7/demo-trial-requirements.md`; decisions D-7k-1 to -6 in `RESUME.md`). Servers survive a
PostgreSQL restart and `pnpm demo` exits non-zero when a child dies; navigation-reachability and demo-completeness
`[meta]` tests; the plant act and its step record as one act (batches.plantEntry); tablet count checked at issue;
saved forms close; lots on blur; still to weigh; stage sign-off ends uses; cleaning list per batch; kiosk session-end
notice (tablets 1570); credential card on Operations; Send a production order (tablets 1571); GB-T-02 second lots and
orders. Browser flow `specs/phase7/presenter-floor.spec.ts`.

**Slice 7j (22 October): R4, a company's own tablet product without a template** (`demo-trial-requirements.md` R4;
decisions D-7j-1 to D-7j-10 in RESUME.md; site-services 1530, recipe-core 1535). Products and materials entered on
screen and confirmed by QA; the formula's target tablet weight and batch sizes; a new master from an approved formula
(skeleton, blank or copy); the Tablets palette (TB-01 to TB-24) and stage editing in the designer; sandbox test lots on
screen; browser flow `phase7/own-product.spec.ts`; user guide page 9. The GMP batch of the new product needs R1's plant.

**Slice 7l (22-23 October): demo routes for R1** (`docs/build-plan/phase-7/slice-7l-routes.md`). Route W (wet,
enteric film, alu-alu cold form) with its plant, masters, lots and orders in the GMP demo set-up, and its browser test
from the ERP order to the released lot; step-screen fixes 7L-1 to 7L-9 (TB-01 potency, alternatives, loop iterations,
named preparations and containers, empty lists, automation fallback, forms cleared at save). Decisions D-7l-1 to 5. No
migrations. Routes D and S remain.

**Slice 7p (23 October):** a dissolution profile as one release requirement (R4 third check, R8 C4/C7; site-services
1720, recipe-core 1725; `slice-7p-routes.md`); demo SR product GLV-SR-500; browser `phase7/sr-profile.spec.ts`.

**Slice 7r (24 October, branch `phase-7/slice-7r`, not merged):** the R4 GMP batches on the screens only
(`slice-7r-routes.md`): Demotab (own-demotab, 12 of 12 on the pod) and P3 rabeprazole with its three coats and its
two-stage dissolution as one release line (own-p3, 12 of 12); recipe-core 1750, tablets 1701; decisions D-7r-1 to 10.

**Owner, 25 October: R8 is P3 rabeprazole only for now** (P1, P2, P4-P12 deferred). **Slice 7s (branch
`phase-7/slice-7s`, from 7r, not merged):** `pnpm demo:setup --with-gmp-samples` (set-up option `--gmp-p3-demo`,
`cli/demo-p3.ts`) loads P3 ready for the presenter (approved, IN-authorised masters with the three coats, specifications
with the two-stage dissolution, released lots, numbering, tooling); E2E group `p3-demo`; `slice-7s-routes.md`.

**Slice 7u (29 October, branch `phase-7/slice-7u-r10-p2p3`): R10 #6 to #20** (P2/P3 from the rabeprazole demo): a
released lot shows its release; reads refreshed after each act; QA's disposition offered only to roles that may give it;
a copied master names its own active; no test-run wording on GMP; computed values at their limits' precision (display
only); the finished lot given back by its code; container links; plain words and unit words; lot forms by material kind;
the anti-tampering check explained; packaging {SEQ} per parent batch (recipe-core 1790; IN-18 kept: after a counter skip
a parent's next serial may jump, D-7u-1); every entry kind summarised as a sentence in its block definition (R11 needs
it). Demo databases seeded before keep the old master names; a fresh seed takes the fixes.

**Slice 7t (28 October, branch `phase-7/slice-7t-potency`): R10 #1 to #5 and R13** from the owner's rabeprazole demo
(`docs/build-plan/phase-7/demo-requirements-R10-R13.txt`). TB-01 shows its calculation and weighs against its targets;
a lot's potency with its history, a potency preview at reservation and planning, QC's guided "Update the potency" page,
POTENCY_RECALCULATED for QA; after TB-21's Run end a missing entry follows a LATE_REASON (RUN_ENTRY_LATE for QA), with a
warning before Run end; bulk issue offers only the final stage's non-reject containers; the processing record closes at
the first lot disposition when no bulk is left. Tablets 1760, 1770, 1771. Defaults: D-7t-1 the potency change is an
attributed QC act with a reason (no e-signature; the results it takes are signed); D-7t-2 every recalculation is an
exception; D-7t-3 TB-21@1 changed in place (additive) so the stuck order RAB26001/P01 can finish; D-7t-4 the automatic
lock is attributed to the releasing AP, and RAB26001/2 are closed by production on /records. Next: slices B (R10 #6-#20),
C (R11), D (R12).

**Slice 7n (23 October): R7, a beta-lactam product in a dedicated suite** (`docs/build-plan/phase-7/slice-7n-routes.md`).
Recipe-core 1655 dedicates rooms and lines to beta-lactam products (IN-27 dedications, class `BETA_LACTAM`) and refuses
a beta-lactam batch outside them and any other batch inside them (PR-27). Demo route B (CXC-325, invented: direct
compression, film coat, alu-alu with desiccant) in the suite BL-DISP to BL-PL with its kiosks; browser tests
`route-b.spec.ts` and `route-b-refusals.spec.ts`; user guide page 10. Decisions D-7n-1 to 11; review P7N-1 to 3 fixed.

**Slice 7m (23 October): demo routes D and S for R1** (`docs/build-plan/phase-7/slice-7m-routes.md`). Route D (roller
compaction, bilayer, ink printing, aluminium strip) and route S (sugar coating in five applications, PVC/aluminium
thermoform) with their plant, kiosks, masters, lots and orders in the GMP demo set-up, and their browser tests from the
ERP order to the released lot; TB-08 on a second route W batch (`route-w2.spec.ts`). Fixes 7M-1 to 7M-4 (TB-16 layer
charges, TB-17 challenge entry, TB-08 authorisation request and sources picked on screen) and review finding P7L-1
(recipe-core 1650). Decisions D-7m-1 to 5. Every tablet block and every coating and pack type is now on a route.

**Slice S16 (31 October, branch `s16-reference-views`, not merged): report views for the external Deviations and CAPA
system** (ADR 0022, D-S16-1 to D-S16-6). Tablets 1800 adds `report.reference_document_v1` and `report.batch_reference_v1`
(the documents a GMP batch's pinned master cites in its `references`); tablets 1801 adds `equipment_use_v1`,
`ipc_result_v1`, `process_actual_v1` and `exception_detail_v1`, each with a `_v1_for(batch_numbers)` function for one
batch (tested on a GMP batch with a failing physical check in `report-views-investigation.test.ts`). GMP records only;
persons by pseudonymous id only. SELECT to `ebmr_app` and `ebmr_report` only; the segregation check is unchanged and
stays clean. The eleven views the reader uses are pinned by
`apps/tablets-server/test/contract/report-views-deviations.test.ts`; a column change is a new `_v2`. Ops note
`docs/operations/report-reader.md` and an `ebmr_report` line in the `pg_hba.conf` template. The shared demo scenario is on
the hosted demo (RAB-GR-20, RAB26002 and RAB26004), built there by the owner's server session; no demo tooling here.

Next: update the hosted demo to 7i and rehearse the demo guide's full-batch act on it (D2), then Tablets v1.0.
Injectables (Phase 5) after that.

## How to work here

- Commands, layout and CI rules: `REPO-GUIDE.md`. Skills in `.claude/skills/` (fix-finding, local-ci, mutation-check,
  postgres-oracle, graphify).
- Machine: a RunPod container whose disk is erased when the pod stops. Run `bash tools/dev-env/runpod-setup.sh` after
  each pod start; commit and push to the working branch (never main) after every step and at least every 30 minutes.
- Local PostgreSQL 16 clusters: main 5432, ci 5433, ci2 5434, golden 5435 (golden clock library; the CI golden job uses 5433 on
  its own runner). On Ubuntu 22.04 the kernel site-zone-policy "[DI-27] over every zone name" test needs about 65 s
  (posix/ zone copies) and times out locally; it passes on CI. Test databases are created per run and dropped after.
- Run `pnpm run ci` (or the changed packages' tests) before pushing.
