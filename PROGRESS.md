# eBMR: current state

Keep this page short (under 150 lines): the current state, the rules in force and the next steps. Append history to
`docs/progress/history.md` (search it; do not read it whole). Last updated: 9 October 2026.

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
  5b reprocessing and recovery), built on `phase-3/slice-5`. Next: slice 5 (TB-08 reprocessing, ERP stub, LIMS-lite, deviation-lite).
- CI runs the tests in four shards (the single job had reached 58 of its 60 minutes); see REPO-GUIDE.md.

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
