# Decision record 0019: a full mutation campaign at the Phase 6 exit

- **Date:** 16 October 2026
- **Decided by:** project owner (maglesT), in the Phase 6 session ("lets go for full mutation campaign also"),
  choosing a full campaign over the focused run on the Phase 6 core that was recommended.
- **Amends:** decision 0008 for the Phase 6 exit only. Decision 0008 left mutation campaigns to deployment.
- **Where it runs:** on the rented pod (owner, 16 October: the Phase 6 exit testing runs on the pod). GitHub CI
  stays the merge gate.

## Decision

After the Phase 6 exit's final run is green, and before the Phase 6 PR merges, a mutation campaign runs in two parts.

1. **All Phase 6 code** (main 8331e94 plus slice 6j):
   - **SQL:** the SQL mutation harness on every database function added or re-created in Phase 6, in the new
     groups in `tools/sql-mutation/src/targets.ts`, one group per slice area:
     - adapters and mirrors
     - equipment, alarms and plant rules
     - packaging and serialisation
     - genealogy and recall
     - the controlled-substance mode
     - governance, change control and the India DSC
     - reporting and training mode
     - inter-site transfer and federation
   - **TypeScript:** Stryker on the Phase 6 TypeScript:
     - integration SDK, adapters and workers
     - server features
     - simulators, where they decide behaviour the tests rely on
2. **The Phase 4 leftovers that decision 0012 left to deployment:**
   - kill confirmation of the scope A (232) and scope B (118) survivors
   - the us-disposition group (no score yet)
   - the qp-certification and market-changes groups
   - Stryker survivor triage of the server release, records, India, archive and PQR features
   - one whole SQL re-run under the decision 0009 organisation

Targets are those of build outline 9.1:
- at least 90 % on guards, signature invalidation, limits, rounding, flow validation and release gating
- 80 % elsewhere

A survivor in high-risk code gets a test that kills it, or a written reason it is equivalent (no input changes any
observable result). A survivor that shows a real defect is fixed with a test and a new migration, under the
fix-finding skill, at most 2 fix rounds, then a residual for the owner. Never delete or loosen a test, or narrow a
mutated range, to raise a score. Results go in `docs/build-plan/phase-6/mutation-results.md`, in the form of the
Phase 4 results.

## Order

1. Finish 6j-a, 6j-b and 6j-c.
2. Merge them into `phase-6/slice-6j`, then raise `phase.yaml` to 6.
3. The final run (full suite, golden batches GB-T-01 to GB-T-03, browser suite, trace at 6), all green.
4. Part 1 of the campaign, then part 2.
5. The new tests and fixes, then the final run again, all green in one run.
6. The demo run, then the PR.

## What does not change

- Deployment validation still owns IQ/OQ/PQ and its own campaign on the validated build.
- Every rule of decision 0008 other than when mutation runs stays in force.
