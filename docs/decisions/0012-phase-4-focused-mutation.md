# Decision record 0012: focused mutation testing of the Phase 4 core before Phase 6

- **Date:** 13 October 2026
- **Decided by:** project owner (maglesT), in the Phase 4 session, choosing the recommended option ("Focused on core")
  over a full Phase 4 campaign or none.
- **Amends:** decision 0008 for Phase 4 only (which left mutation campaigns to deployment).

## Decision

Before Phase 6 starts, Opus runs mutation testing (the SQL mutation harness and Stryker on changed TypeScript) on the
regulation-critical core of Phase 4:

1. the release gate (G-REL and its items), the manufacturer release and the market dispositions (US QCU, EU QP
   certification and intake, India), market add and removal;
2. suspension, re-confirmation, recall, rejection after release and disposal; record locking and amendment;
3. the India issue gate (licences, export permissions, hazard and dedication), expiry, the contingency-form completion
   gate, the evidence export check, and signature binding in these acts.

Surviving mutants are killed with stronger tests; a survivor that shows a real defect is fixed with a test (new
migration); equivalent mutants are written up with reasons. Then one final full run (suite, golden batches, browser
suite) and Phase 6. The rest of Phase 4 keeps decision 0008: its mutation campaign belongs to deployment validation.

## Limit on re-running (owner, 14 October 2026)

The owner limited the re-running: no group starts after the ones running now (builder A stops after us-disposition;
qp-certification and market-changes go to deployment validation under decision 0008; builders B and C stop after their
current group or run). Survivors are confirmed once, by re-running only those mutants; whatever still survives is
written up with its reason (CLAUDE.md: at most 2 fix rounds). Then one final full run (suite, golden batches, browser
suite) before the PR, and no repeated full runs.
