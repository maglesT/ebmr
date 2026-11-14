# eBMR: current state

Keep this page short (under 150 lines): the current state, the rules in force and the next steps. Append history to
`docs/progress/history.md` (search it; do not read it whole). Last updated: 14 November 2026 (session 17, injectables
edition exit and review pass).

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

**Fix: a unit or room in use that no step names can be ended, with a reason (demo report 13 November 2026, bug 4; branch fix-end-equipment-use).**
A unit's use started on the Plant screen for a batch whose master binds no step to the unit had no screen to end it, so
the unit stayed in use and every later batch was refused (EBMR-PLANT-061). The stage sign-off offered "End the use" to
the supervisor, whom the database refuses (STEP.EXECUTE is the operator's).
- New read `plant.openEquipmentUses` (GET /api/plant/equipment-uses): every process unit's use not ended, of any batch in
  any state. The Plant screen's "Units in use" lists them and offers the operator the existing end act
  (`plant.endEquipmentUse`: same right, fresh badge tap, audit row). No database change: `plant.end_equipment_use` never
  read the batch's state, so a finished or abandoned batch's use was always endable there.
- The stage sign-off offers "End the use" only to a role holding STEP.EXECUTE (web `STEP_EXECUTE` group); others are told
  who ends it and where. The presenter-floor E2E now checks that instead of the supervisor's refusal.
- Owner decisions (13 November): (1) the shift supervisor gets no right to end a use (kept hidden); (2) ending a use
  records a reason; (3) rooms get the same Plant-screen list and end. Done in recipe-core 1926:
  `plant.end_equipment_use(use, reason)` and `plant.end_area_occupancy(occupancy, reason)` store the reason on the
  insert-only end row and write a business audit entry naming unit or room, batch and reason. A blank reason is refused
  (EBMR-PLANT-065), and a use whose batch is EXECUTION_COMPLETE, ABORTED or CANCELLED is ended only with a reason. The
  one-argument functions (step screen, demo loaders) still end a running batch's use without one. New read
  `plant.openAreaOccupancies`; both end routes take an optional `reason`, and the Plant screen always asks for it.

**Injectables I-5 (session 13, 12 November 2026).** #236 merged:
- INJ-AVI: automated visual inspection; the counts are typed from the machine report and CHECKED.
- INJ-AVI-CHALLENGE-EU: the Annex 1 8.32 challenge, EU only.
- INJ-CCIT-100: deterministic 100 % CCIT; a leaker is a counted reject, accounted through `totalRejects`.
- RMM: `rmmReportAttached` in TEST-INJ-RELEASE.

**Demo fix: an equipment status step that checks no unit (r13 bug 1, 13 November 2026; branch fix-validator-stage-equipment).**
A stage added with the designer binds rooms but no equipment, and its G-09@2 step checked nothing; the validator passed it
and on the floor the step could never be signed (G09-INCOMPLETE, EBMR-EXE-210). New validator rule
GMP-EQUIPMENT-STATUS-UNITS (validator 1.4.0; PR-23, PR-03) refuses a G-09 step from version 2 that checks no unit, naming
the stage and what to add (the stage's equipment, then "checks its status" on the step; both already on screen). G-09@1
(sandbox, any unit) is unchanged. Open: masters already approved with this shape stay stuck (revising them is r13 bug 2);
the packaging skeleton from a formula now shows this error until the author binds the line's units.

**Owner retest 13 November 2026, items 7 to 9 (branch fix-floor-messages-and-deviation).** A GMP weighing step lists
per line the lots reserved for the batch and warns before the first weighing when stores must reserve one (item 7). A
deviation raised from an exception is raised, linked to the batch and attached in one command (ATTACH_DEVIATION with
`raise`); the dialog offers the batch's open deviations so an orphan is attached, not raised again; titles show values
at their judged precision (item 8). The title block shows its signatures; a stale GMP signing says "batch" (9a, 9b).
9c (MGL260051 then MGL260101) is by design: a server start retires the rest of a 50-number block (kernel 0600, ADR 0007,
`docs/operations/ha-and-restore.md`); IN-18 forbids reuse, not gaps. Owner decision (13 November): the register screen now
lists each skipped range with its numbers, reason and time (site-services 1924, read from `continuity.sequence_bump`).

**Injectables EM tiers (12 November 2026, session 10c).** The library E2E types each limit tier into its own boxes; the
aseptic vial's EM breach is an action-tier breach. Routine EM is not a batch record (lead): owner question, a room-level
EM logbook as a future feature, if wanted.

**Injectables I-2d (12 November 2026, session 10c).** The media fill's GMP run, E2E: the mark set on screen, the batch issued
with no licence (the register says so), run on the kiosks with no release for packing, ended by QA's record review; a
finished lot of it is refused. The master-version market authorisation stays (lead).

**Owner retest fixes (13 November 2026).**
- MGL-SR-BL retest of 13 November, bugs 5 and 6 (branch fix-unit-choice-and-planning):
  - Bug 5: a status step (G-09@2) offered only the stage room's units, so a usable unit of the class in another room was
    never offered. No control or database rule ties a unit to the stage's room. Default taken: the stage room's units
    come first. When none of them can be used now, usable units of the class in other rooms are offered with their room
    and a note says why. When no unit can be used anywhere, every unit is listed with the plant's reason and what to do.
    A unit with an open use of the batch is always offered. Raw EQUIPMENT_USE/PRESS_SETUP forms pick an open use.
  - Bug 6: recipe-core 1921 makes the planning read list every matching master in `matches`. When more than one
    matches, `match` is null and `noMatch` names them; the planning screen asks the planner to choose. Owner, 13
    November: a twin family is refused at authorisation (recipe-core 1923, EBMR-RCP-438: another family of the same
    product with an active authorisation for the same market, site, line and batch quantity); the planner's choice stays
    for twins already in a database and on different lines. Owner: a unit of another room may be used (no guard).
- Hosted demo re-set-up for area_status v2: no code (owner chose the easy way; the state engine, kernel 1110, never
  changes an aggregate's machine version, so areas move to v2 by running the demo set-up again).

**Earlier state** (moved verbatim to `docs/progress/history.md` on 11 November 2026, and session 12's and I-5's
entries on 14 November (search "PROGRESS.md session 12, moved 14 November" and "PROGRESS.md I-5, moved 14 November");
search "PROGRESS.md condensed, 11 November"): the sandbox date-time fix (kernel 1406); the post-use inspection without a
second person (tablets 1908); MEDHANTA slice 2, deviations through the Deviations product (tablets 1907, decision 0029);
declutter D1 to D4b (decision record in `docs/build-plan/declutter/plan.md`); the API edition A0 to A2; the demo gaps
D-0 to D-4, R-flow and R-rest; the capsules edition; the injectables plan and I-1 to I-4; the dynamic library S0 to S16
(decision 0026); Phases 0 to 4, 6, 6A and 7 (Tablets v1.0.0-rc.1, 19 October) and the hosted-demo slices 7h to 7u.

## Next

- **Injectables I-6, edition exit (14 November 2026).** `compliance/phase.yaml` lists `injectables`, so the trace gate
  covers both editions. Merged: B1 to B5 (#245 to #248, #252), PR-15/PR-28 (#253), GB-I-01 (#254). The golden batch
  GB-I-01 takes the aseptic vial to a released lot with sterility by the validated rapid method; the lot result shows
  the method the QA-approved specification fixes (IN-33).
- **Owner residuals and questions (injectables):**
  - INV-23, INV-36, INV-44: owner residuals (the exit list supersedes outline 11's); INV-37 by ST-68, INV-45 by ST-64.
  - Decision 0031: PR-26 clause 2 (transfer-route scan) and PR-28 clause 2 (EM excursion at certification) are owner
    questions, deferred to phase 8 (register: phase 8 = an open owner question, citing a decision record).
  - The room-level EM logbook between batches: deferred by the owner ("not now", 13 November 2026); not built.
  - B5: masters do not declare isolator/RABS, so the glove test and VHP are not required automatically for EU; EU
    radiation-sterilised product waits for Annex 12 to be extracted.
  - Upgrading an existing install needs a sterile v2 rule table and a library v2 publish: B1 and B5 edit sterile.v1 and
    INJ-EM, INJ-FILL, INJ-COMPOUND and INJ-GAS-FILTER v1 in place (an existing database refuses the new sterile v1 with
    EBMR-MKT-035 and keeps the old library v1).
  - Kernel: `iam.register_device` should report a duplicate device code with an `EBMR-IAM-` message, not the raw
    unique-violation error (review pass residual; not needed now).
  - Owner question pending: the Tablets v1.0.0 tag.
- **Demo:** fresh install after the I-6 merges (lead ruling on #245).
- **Next (I-6):** (1) the review-pass PR (`docs/build-plan/injectables/review-pass.md`): the [DI-20] 64-bit endpoint
  codes, the renderer watchdog, and the Demotab 12 and reserve-lot races. (2) The kernel content-extension point
  (`esig.content_extension`) so the plant module adds the APS lines to a change record's signed content without
  changing the provider row (lead ruling on the DI-48 drill, 14 November 2026). (3) The expected-answer database
  re-check PR, on the lead's conditions: 1862's body carried forward with a diff showing nothing removed, an
  engine/database parity test on every seeded expected answer including hidden fields, and SQL mutation coverage.

- Residual of SITE-995 (lead, 11 November): an intermediate lot cannot be retested to a new date (its material code is
  the product code, which has no ERP material retest interval).
- Later CI slice: gate the E2E set-up's seeds per group (`gmpReviewBatch`, `gmpPackaging` in
  `tools/e2e/global-setup.ts`); needs a full E2E proof run.

## How to work here

- Commands, layout and CI rules: `REPO-GUIDE.md`. Skills in `.claude/skills/` (fix-finding, local-ci, mutation-check,
  postgres-oracle, graphify).
- Machine: a RunPod container whose disk is erased when the pod stops. Run `bash tools/dev-env/runpod-setup.sh` after
  each pod start; commit and push to the working branch (never main) after every step and at least every 30 minutes.
- Local PostgreSQL 16 clusters: main 5432, ci 5433, ci2 5434, golden 5435 (golden clock library; the CI golden job uses 5433 on
  its own runner). On Ubuntu 22.04 the kernel site-zone-policy "[DI-27] over every zone name" test needs about 65 s
  (posix/ zone copies) and times out locally; it passes on CI. Test databases are created per run and dropped after.
- Run `pnpm run ci` (or the changed packages' tests) before pushing.
