# eBMR: current state

Keep this page short (under 150 lines): the current state, the rules in force and the next steps. Append history to
`docs/progress/history.md` (search it; do not read it whole). Last updated: 11 October 2026.

## What this is

An electronic Batch Manufacturing Record system for Indian pharma manufacturers who export. India Revised Schedule M
always applies; US FDA and EU GMP apply per market; the stricter rule wins. Tablets edition first, through Phases 6 and 7 to
v1.0; Injectables (Phase 5) comes after that (decisions 0002, 0010). The approved plan is `docs/outline/build-outline.md` (v0.2; section 11 is the phase
plan), as changed by the owner decisions in `docs/decisions/` (0001 to 0010).

## Rules in force (owner)

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
  quick reviews; Haiku for mechanical jobs. Few agents (2 to 3 at a time), short reports, short command output.
- Defaults: take the default for any open question (decision 0004) and record it.
- Merge a PR yourself when CI is green. Push each checked commit. No deletion without the owner's OK.
- Never edit an existing migration; add new ones. Never weaken a control or change `expert_decision`.
- Paraphrase regulations. No patent formulations. No model names in commits. Never commit the scratchpad `src/`
  folder (copyrighted pharmacopoeia texts). Do not use the repositories maglesT/ds or
  maglesT/deep-learning-for-earth-observation for this project.

## Where things stand

- Phase 0 (repo, CI, register) and Phase 1 (compliance kernel) are done.
- Phase 2 (recipe engine and designer) is done: PR #4 (`phase-2/recipe-core`) merged on 9 October 2026 with the exit
  review's findings, the SQL mutation run on the Phase 2 guards and defects D1 to D17 fixed
  (`docs/build-plan/phase-2-exit/`). Review backlog for later phases: `docs/build-plan/phase-2-exit/review-backlog.md`.
- `compliance/phase.yaml` is at 2: CI needs a passing test for every Phase 1 and Phase 2 control. It goes to 3 with the
  slice that completes Phase 3.
- Phase 3 slice 1 is merged (PR #7, 9 October 2026; plan and defaults D-S1-1 to D-S1-6:
  `docs/build-plan/phase-3/slice-1-plan.md`): material lots with release routes, reservations and guarded consumption
  (site-services 0710 to 0712, recipe-core 0430); equipment kinds, cleaning, campaigns, rooms and lines, clearance types
  (recipe-core 0400 to 0405, schema `plant`); output containers with the IPC hold window (recipe-core 0420 to 0422).
  One quick review: 2 high and 2 medium fixed, the rest in `docs/build-plan/phase-3/review-backlog.md`.
- Phase 3 slice 2 (execution paths) is merged (PR #8, 10 October 2026; plan and defaults D-S2-1 to D-S2-3:
  `docs/build-plan/phase-3/slice-2-plan.md`): the exception register in the database (0440, 0441), void, invalidation,
  skip, abort and cancel guarded with approvals bound to the act (0450 to 0453, 0470 to 0472), step hand-over (0461 to
  0463, 0480), engine 1.6.0; slice 1 backlog #6 and #10 (site-services 0720, 0721; recipe-core 0460).
- Phase 3 slice 2b (execution on the GMP installation) is merged (PR #9, 10 October 2026; plan and defaults D-S2b-1 to
  D-S2b-3: `docs/build-plan/phase-3/slice-2b-plan.md`): GMP batches issued from an effective MBR with a register number
  and an ISSUED signature (recipe-core 0500 to 0504); the tablets server plans, signs, issues and runs GMP batches with
  site lots and no watermark (tablets 0800, 0801).
- Phase 3 slice 3 (tablet blocks with the press and coater simulators) is split into 3a to 3d
  (`docs/build-plan/phase-3/slice-3-plan.md`); 3a (equipment interface) is built on `phase-3/slice-3a`: the integration-sdk process
  module, press and coater simulators, the gateway's process driver and uplink; process readings, setpoint downloads and
  alarms on the server (tablets 0820); G-06@1, G-09@2 and G-10@2 (recipe-core 0520 to 0523); the tablets block
  registry; the kernel SCOPE hook (kernel 1150, ADR 0018); merged (PR #10). 3b (TB-01 dispensing and the granulation
  blocks TB-02 to TB-05 and TB-07, tablets sql 0840 to 0852) merged (PR #11). 3c (compression: TB-09 tooling,
  TB-10 press set-up, TB-17 detectors, TB-11 IPC scheduler, TB-12 to TB-15 compendial checks; tablets sql 0870 to 0894,
  recipe-core 0540, 0541) merged (PR #12). 3d (TB-18 coating, TB-19 printing with the QC gate, TB-20 AQL, TB-06 roller
  compaction, TB-16 bilayer; tablets sql 0910 to 0913, 0930 to 0932) is built on `phase-3/slice-3d`. The compendial
  rule-set values and the AQL tables await the expert's check (review backlog); merged (PR #13). Slice 3 complete.
- Phase 3 slice 4 (packaging, `docs/build-plan/phase-3/slice-4-plan.md`): 4a (G-21 with the printer simulator and the
  serialisation stub; recipe-core 0580 to 0582, tablets 0950 to 0952) merged (PR #14). 4b (TB-21 blister, TB-22 leak
  test, TB-23 bottle line, TB-24 secondary packaging and SSCC aggregation; tablets 0970 to 0972, 0985 to 0989) merged
  (PR #15). Slice 4 complete. Slice 5 plan: `docs/build-plan/phase-3/slice-5-plan.md` (5a quality and master data,
  5b reprocessing and recovery), built on `phase-3/slice-5`: deviation-lite, LIMS-lite with second-person approval and
  retest, ERP stub with the BOM match at GMP issue (site-services 0730 to 0753, recipe-core 0600 to 0603, tablets 1000 to
  1002); TB-08 additions and G-24@2, whole-batch reprocessing with a new batch number linked to its parents (INV-33),
  the expiry cap (recipe-core 0620 to 0625, tablets 1020 to 1022). Merged (PR #16). Slice 6 plan:
  `docs/build-plan/phase-3/slice-6-plan.md`, built on `phase-3/slice-6`: screens (shop floor for TB-01..24, G-06, G-21,
  G-24@2; planning; master data with the formulation library and "Choose a product"; plant; quality), the GMP batch,
  planning, master-data, plant and quality routes with every signed act over HTTP, devices and GMP seeds, and GB-T-01
  matching its expected outputs exactly. compliance/phase.yaml is 3; the trace passes at phase 3. Merged (PR #17).
- Phase 3 exit (decision 0009, `docs/build-plan/phase-3/exit-plan.md`, branch `phase-3/exit`): one Opus review pass
  (no critical; five high, four fixed with tests, the fifth decided by ADR-0019), SQL and TypeScript mutation runs by
  Opus (results and residuals in the review backlog), and the final run green. Open for the owner: the drying-loop
  correction question and the India subdivision rule (review backlog). Merged (PR #18); Phase 3 complete.
- Phase 4 (review, release and India specifics): plan `docs/build-plan/phase-4/phase-4-plan.md`, seven slices; slice 1
  (record review and evidence epochs) on `phase-4/slice-1`: 1-0 (contract `review`, epochs, review register, GB-T-01
  baseline) pushed; 1a (review acts, audit-trail review, epochs' triggers, CORRECT_ENTRY route; recipe-core 0710 to
  0721, tablets 1140 and 1141; defaults D-1a-1 to D-1a-7 in the plan); 1b (containers with a weighed or verified
  close, release refused while the hold is open, the GMP sweeper, device readings to entries, TB-20@2 NO_PLAN;
  recipe-core 0740 and 0741, tablets 1110 to 1113, site-services 0810); 1c (review, register, audit-trail, container,
  device-reading and correction screens; the `--gmp-review-batch` seed; two browser flows). Quick review: two high, one
  medium-high and five core mediums fixed with tests (Phase 4 review backlog).
- Phase 4 slice 2c (`phase-4/slice-2c`, 12 October; 2a and 2b merged in): packaging orders planned over HTTP from an
  issued processing batch, pack type in the packaging family's identity (D-P4-13), a packaging master without TB-24
  refused, a number allocated ahead planned only by its allocator (recipe-core 0760 to 0762; defaults D-2c-1 to D-2c-5 in
  the plan); screens for packaging planning and the bulk issue, the full deviation record, specifications, lot events,
  samples and returned goods; e2e: packaging order with its bulk issue (`--gmp-packaging` demo seed), deviation life
  cycle through closure.
- Phase 4 slice 1 merged (PR #20). Slice 2 (quality records) on `phase-4/slice-2`: the full deviation stand-in (QA
  classification, per-market impact signed by an independent QA person, closure basis, cancellation rules, insert-only
  links, release blocked at once on link; evidence stored as bytes), specifications with pharmacopoeia editions and
  limits never typed, required tests, OOS-linked revisions, finished lots in quarantine, returned goods, retention
  samples, lot events with the propose step, packaging-order planning with pack type and the bulk-issue screen.
  Quick review: four high and two core mediums fixed. Open for the owner: D-2a-9 (CONFIRMED impact keeps release
  blocked after closure).
- Phase 4 slice 3a (`phase-4/slice-3a`, 12 October): G-REL items 1 to 9 and the manufacturer release in the database
  (recipe-core 0781, 0782; site-services 0860, 0861 material_lot v2; tablets 1179 signing meanings), routes
  `/api/release/*` and RELEASE_ACT. Defaults D-3a-1 to D-3a-9 in the plan; open for the owner: D-P4-6 consequence (with
  India treated as the EU, a PPQ batch's manufacturer release always waits for the validation outcome).
- Phase 4 slice 2 merged (PR #21). Slice 3 (G-REL and the manufacturer release) on `phase-4/slice-3`: the release
  evaluator with items 1 to 11 re-evaluated at an unchanged epoch inside the signing transaction, the AP or a valid
  delegate (never an involved person), since-review acknowledgement, the checklist stored with the decision, finished
  lots leaving quarantine only by this release; the Tablets edition items (reconciliation, finished-pack examination,
  printed-tablet QC, held containers, rule-set verification, whole-batch parents), all failing closed; the release
  cockpit and the notification centre (both departments notified). Open for the owner: D-P4-6, D-3a-10.
- Phase 4 slice 4a (`phase-4/slice-4a`, 12 October; 4-0 interfaces on `phase-4/slice-4`): US disposition by the QCU,
  the two-row release (D-P4-5), EU outcome from a signed message, a verified transcription or a registered in-system QP,
  INELIGIBLE, market add and removal with the market-add evaluation, packaging orders only for the parent's markets, the
  manufacturer rejection cascading (recipe-core 0820 to 0825, tablets 1180, 1189). Defaults D-4a-1 to D-4a-9 in the plan.
- CI runs the tests in four shards (the single job had reached 58 of its 60 minutes); see REPO-GUIDE.md.

- Phase 3 exit fixes (`phase-3/exit-fix`, 11 October): the review's four highs and one medium. HIGH-1: ERP masters and
  orders need ERP.MASTER_WRITE (ERP interface only); a new code, or a change of reprocessing permission, shelf life,
  material kind or retest interval, takes effect only on QA's ERP_MASTER_CONFIRMED signature (site-services 0802, tablets
  1101; ERP status screen lists and confirms; seed and e2e fixture confirm). HIGH-2: QA proposes a lot status decision
  first and the signed content names it (0800). HIGH-3: bulk is issued to a packaging order only after its processing
  batch's H-PACK, from usable containers (recipe-core 0701, route `POST /api/batches/:id/bulk`); TB-21 RUN_START, TB-23
  and TB-24 refused on GMP until then (tablets 1102). HIGH-4: consumption only into a running batch and named by an entry
  of the same command; reservations revoked at batch end (0801, recipe-core 0700, tablets 1100). MEDIUM: TB-11 counter as
  bigint. GB-T-01 unchanged. Open for the owner: no screen yet for the bulk issue; packing steps in a GMP processing batch
  are now refused (stricter default); HTTP LOT_DECISION still offers only release and reject.
- GB-T-01 date fix (`phase-4/golden-date-fix`, 12 October): the true-copy hashes changed with the day of the run, because
  the normalisation took the seeded lots' fixed retest and expiry dates (2027 to 2029) for run instants and wrote them as
  minutes from the issue; the exception-rich one also held the year in its deviation number. The lot dates now stay as
  they are and the deviation year is a placeholder; hashes re-recorded and shown equal on runs started on different days
  (`EBMR_GOLDEN_LATER_DAYS`). Test code only.

## Next: Phase 3, Tablets edition (outline section 11)

Built in slices, each on its own branch and PR, merged when CI is green; one quick review each; a plan before each.
Each slice first sorts the controls it touches into core (database-enforced, full tests) or other (application code
allowed), using the control's sources and outline section 9.2.

1. Equipment kinds, campaigns, clearance types; lots with release routes and reservations; containers.
2. Execution paths: exception tiers, correction, void and invalidation, hand-over.
3. Tablet blocks TB-01 to TB-24 with the press and coater simulators (G-06).
4. Blister packaging (G-21) with the printer simulator and a serialisation stub.
5. Reprocessing and recovery; ERP stub, LIMS-lite, deviation-lite.
6. Shop-floor, planning and master-data screens; the GB-T-01 golden batch demo.

Exit (decision 0009): the Phase 3 controls have passing tests; the Opus mutation run and review pass; critical and high
fixed with tests; one final run of the suite, E2E, trace and GB-T-01 (exact outputs).

## How to work here

- Commands, layout and CI rules: `REPO-GUIDE.md`. Skills in `.claude/skills/` (fix-finding, local-ci, mutation-check,
  postgres-oracle, graphify).
- Local PostgreSQL 16 clusters: main 5432, ci 5433, ci2 5434 (`sudo pg_ctlcluster 16 <name> start` after a container
  restart; ci2 recovers slowly). Test databases are created per run and dropped after.
- Run `pnpm run ci` (or the changed packages' tests) before pushing.
