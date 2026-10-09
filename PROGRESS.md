# eBMR: current state

Keep this page short (under 150 lines): the current state, the rules in force and the next steps. Append history to
`docs/progress/history.md` (search it; do not read it whole). Last updated: 9 October 2026.

## What this is

An electronic Batch Manufacturing Record system for Indian pharma manufacturers who export. India Revised Schedule M
always applies; US FDA and EU GMP apply per market; the stricter rule wins. Tablets edition first; Injectables is
deferred to Phase 5 (decision 0002). The approved plan is `docs/outline/build-outline.md` (v0.2; section 11 is the phase
plan), as changed by the owner decisions in `docs/decisions/` (0001 to 0008).

## Rules in force (owner)

- Decision 0008: the goal is software that works properly with no major defects. Tests with every feature and green
  CI always; one quick review per feature or slice; a quick review at the Phase 3 exit; at the Phase 4 exit one review
  pass, the full suite, the golden batches and the browser suite. At most 2 fix rounds per finding. Validation-grade
  testing (mutation targets, multi-round adversarial review, IQ/OQ/PQ) belongs to deployment. Database enforcement for
  the regulation-required core only. The F12 sandbox identifier rule is frozen at kernel 1140 / recipe-core 0350.
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
- Phase 2 (recipe engine and designer) is built. Its exit work is merged on `phase-2/recipe-core` (PR #4):
  - the exit review's findings and follow-ups, F12 included (rounds 1 to 8, frozen by decision 0008);
  - the SQL mutation run on the Phase 2 guards (28 groups, kill tests, 149 recorded equivalents);
  - the defects found by that run: D1 to D17, all fixed (`docs/build-plan/phase-2-exit/sql-mutation-kill-results.md`);
  - the review backlog for later phases: `docs/build-plan/phase-2-exit/review-backlog.md`.
- Left to close Phase 2: raise `compliance/phase.yaml` to 2 (CI then needs a passing test for every Phase 2
  control), final CI and E2E, a summary to the owner, merge PR #4.

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

Exit: GB-T-01 matches its expected outputs exactly, the Phase 3 controls have passing tests, a quick review.

## How to work here

- Commands, layout and CI rules: `REPO-GUIDE.md`. Skills in `.claude/skills/` (fix-finding, local-ci, mutation-check,
  postgres-oracle, graphify).
- Local PostgreSQL 16 clusters: main 5432, ci 5433, ci2 5434 (`sudo pg_ctlcluster 16 <name> start` after a container
  restart; ci2 recovers slowly). Test databases are created per run and dropped after.
- Run `pnpm run ci` (or the changed packages' tests) before pushing.
