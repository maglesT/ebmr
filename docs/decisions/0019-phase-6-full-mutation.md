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

## Limits: important issues first, no endless re-testing (owner, 16 October)

The campaign is time-boxed and works by priority. It must not turn into days of re-runs for small gains.

- **Priority 1, always fixed:** a survivor that shows a real defect in the regulated core:
  - access checks
  - e-signatures and their binding
  - the audit trail
  - release and serial gating
  - limits and rounding
  - dual custody
  - stale-mirror refusal
  - federation and transfer seals

  It is fixed with a test, at most 2 fix rounds, then a residual.
- **Priority 2, killed where reasonable:** a survivor in high-risk code (the 90 % zone) gets a killing test, about 1
  hour at most per survivor or cluster of alike survivors. After that it is a residual, with its reason.
- **Priority 3, recorded only:**
  - a survivor elsewhere (the 80 % zone: display, formatting, logging, simulators, workers' retry timing)
  - an equivalent mutant

  It is written down with a one-line reason and not chased, unless a single obvious test line kills it.
- **Runs per group:** one first run and at most one confirmation run (`--only` on the survivors that new tests aim
  at). No third run of a group. A Stryker feature that does not finish in 1 hour runs on its high-risk files only,
  else it is a residual.
- **Time box:** part 1 at most 12 pod hours, part 2 at most 8 pod hours. When the box ends, the work stops and what
  is left becomes residuals for the owner. A container restart's lost time counts toward the box.
- **Final runs:** a failing test that is not a real defect gets at most one re-run. Two full final runs at most: one
  before the campaign, one after it.
- A missed score target is reported with its residuals; it never blocks the Phase 6 PR. Only an unfixed Priority 1
  defect does, and that goes to the owner.

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
