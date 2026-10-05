# Working in this repository

This is a regulated-software project: an electronic Batch Manufacturing Record system with a Tablets
edition and an Injectables edition for Indian manufacturers who export (India Revised Schedule M always
applies; US FDA and EU GMP per market; the stricter rule wins).

Read before changing anything:
- `PROGRESS.md`: current state, decisions and next steps.
- `REPO-GUIDE.md`: layout, commands, CI rules, how-tos.
- `docs/outline/build-outline.md`: the approved plan (v0.2). Section 11 is the phase plan.
- `docs/decisions/`: owner decisions. `docs/adr/`: architecture decisions.

Hard rules:
- Never weaken a control in `compliance/controls/` to make code or tests easier. If a control seems wrong,
  write it up for the owner; do not change `expert_decision` yourself.
- Tests that prove a control carry its ID in the test name: `[DI-22]`, `[ST-33]`, plus `[INV-xx]` for invariants.
- Keep the boundaries in `.dependency-cruiser.cjs` and exact `workspace:<version>` pins.
- No `Date.now()` or JavaScript `number` for GMP values in domain code.
- Paraphrase regulations in docs and code comments; never paste more than a short phrase of regulation text.
- Run `pnpm run ci` before pushing. Work on a branch; update `PROGRESS.md` at each milestone.
- Cadence and depth follow owner decision 0008: tests with every feature and green CI always; one review pass per
  feature; a quick review at the Phase 3 exit; the heavy check (adversarial review, mutation targets, golden batches,
  browser suite) at the Phase 4 exit for Phases 2 to 4; at most 2 fix rounds per finding, then a residual for the
  owner; database enforcement for the regulation-required core (decision 0008 section 2); 2 to 3 agents at a time.

## Skills and tools

Project skills in `.claude/skills/`:
- `fix-finding`: fixing a review finding, defect or demo report (reproduce first, database guard, new migration).
- `mutation-check`: focused Stryker on changed lines; the SQL mutation harness for database functions.
- `postgres-oracle`: ask the real PostgreSQL 16 server instead of reasoning about its behaviour.
- `local-ci`: CI and E2E as GitHub runs them, spare clusters for parallel runs, failure diagnosis.
- `graphify`: code map built at session start into `graphify-out/` (not committed). It does not see calls inside
  SQL function bodies; read its "In this repository" section before relying on it.

The rules above and the controls win over any tool or skill. Do not add a tool, plugin or skill whose rules
cut testing (fewer tests, "one check is enough", coverage or mutation targets as optional); Ponytail was
rejected for this reason. No tool or skill reduces tests named with control IDs, mutation targets, database
enforcement, audit trail, e-signature or access checks; only an owner decision sets when they run and how deep
(decision 0008). A graph answer is never evidence; the code and the tests are.
