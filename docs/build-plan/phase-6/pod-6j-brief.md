# Phase 6 exit (slice 6j): hand-off to the pod

Repository maglesT/ebmr. Main is at 8331e94, with all Phase 6 slices merged (6h dropped, decision 0018). Read
CLAUDE.md, PROGRESS.md ("Next"), REPO-GUIDE.md and the "Slice 6j" section of
docs/build-plan/phase-6/phase-6-plan.md: search for it, do not read the whole file. All hard rules apply:
- Never weaken a control or change `expert_decision`.
- Never edit an existing migration.
- Tests carry their control IDs in their names.
- No `Date.now()` or JavaScript `number` for GMP values.
- No model names in commits.
- Delete nothing without the owner's OK.

Three sub-branches were started in the cloud session and pushed:

1. `phase-6/slice-6j-a` (trace), nearly done:
   - mermaid diagrams fixed
   - phase-5 deferral rule for PR-26/PR-28
   - exit clause mappings

   Left to do: the full lint, then check that every clause deferred to 6 names a passing test. A clause still
   unbuildable goes to Phase 7, with its reason, on a list for the owner. Draft IN-53 stays PENDING; add it to the
   owner list. Do NOT raise `phase.yaml` here.
2. `phase-6/slice-6j-b` (golden batches and browser suite), in progress. Its first commit, 3cec207, replaces
   libfaketime on the golden cluster with a signal-safe clock library: check that the CI golden job still works with
   it. Its WIP commit, d0f7502, was being written when the agent stopped (the OPC UA press part of GB-T-03).
   Left to do:
   - GB-T-01 and GB-T-02 unchanged, with exact outputs. Check that the INTERNAL or device-nonce stops are gone,
     without raising the 120-per-minute limit.
   - Finish GB-T-03 "connected" (ERP/WMS, LMS/CMMS mirrors, OPC UA press via apps/simulators, L3/L4 serialisation,
     mock recall from its API lot), with exact outputs, wired into the golden CI job.
   - Browser flows: health page with a stale mirror refusal, alarm acknowledgment, trend viewer (plus the DI-32
     restored-archive re-render if feasible), genealogy explorer and mock recall, controlled dispensing, English step
     screen.
   - If a migration is needed: tablets 1320–1329.
3. `phase-6/slice-6j-c` (review pass), findings so far:
   - 6jc-R1 fixed: an integration account never records a person's material act (site-services 0990).
   - Findings and residuals are written in the plan under "6j-c review".

   Left to do: finish the review of the rest of Phase 6. Fix every critical and high with a test and a new migration,
   at most 2 rounds each, then a residual. Ranges: kernel 1230–1239, recipe-core 1100–1109, site-services 0991–0999,
   tablets 1330–1339.

Then, following the order in decision 0019 (`docs/decisions/0019-phase-6-full-mutation.md` on branch
`phase-6/slice-6j-a`):
1. Merge a, b and c into a new `phase-6/slice-6j` (merge commits).
2. Raise `phase.yaml` to 6, last.
3. Final run, all green in one run:
   - `pnpm run ci`, with the tests sharded across the cores
   - the golden batches GB-T-01, GB-T-02 and GB-T-03
   - the full browser suite
   - `pnpm trace` at 6
   - `pnpm handbook:check`
4. **Full mutation campaign** (decision 0019; read `.claude/skills/mutation-check/SKILL.md`):
   - Part 1, all Phase 6 code:
     - Add SQL harness groups for every Phase 6 database function in `tools/sql-mutation/src/targets.ts`.
     - Run Stryker on the Phase 6 TypeScript.
   - Part 2, the Phase 4 leftovers listed in `docs/build-plan/phase-4/mutation-results.md`:
     - kill confirmation of the scope A and B survivors
     - the us-disposition, qp-certification and market-changes groups
     - Stryker triage
     - one whole SQL re-run
   - Use as many workers as the cores allow, and keep the reports, so a restart resumes with `--only` instead of
     starting over.
   - Targets: 90 % on guards, signatures, limits, rounding, flow validation and release gating; 80 % elsewhere.
   - Survivors get killing tests, or written equivalence reasons in `tools/sql-mutation/equivalent.json`.
   - Real defects are fixed per `.claude/skills/fix-finding/SKILL.md` with new migrations. Ranges after 6j-c's:
     kernel 1240–1249, recipe-core 1110–1119, site-services 1000–1009, tablets 1340–1349. At most 2 rounds,
     then a residual.
   - Results go in `docs/build-plan/phase-6/mutation-results.md`.
   - **LIMITS (owner): focus on important issues; no days of re-testing.** See decision 0019, "Limits".
     - Priority 1: real defects in the regulated core (access, e-signature, audit, release and serial gates, limits
       and rounding, dual custody, stale mirrors, federation seals) are always fixed, at most 2 rounds.
     - Priority 2: high-risk survivors get about 1 hour each at most, then a residual.
     - Priority 3: everything else (display, logging, simulators, retry timing, equivalents) is only recorded, with
       one line each.
     - At most one confirmation run per group; never a third run.
     - Time box: part 1 at most 12 h, part 2 at most 8 h. Then stop and list the residuals.
     - A missed score target never blocks the PR; only an unfixed Priority 1 defect does, and you report it to the
       owner.
5. Final run again, all green in one run, with the new tests. This is the second and last full final run. A failure
   that is not a real defect gets one re-run, no more.
6. The demo run (exit criteria in the plan): systems exchanging data under faults, a stale LMS mirror refusing a
   step signature, a press excursion over OPC UA acknowledged in the batch's alarm log, a serial query, a mock
   recall. Record it.
7. Update PROGRESS.md and docs/progress/history.md.
8. Push and open the PR "Phase 6 slice 6j: Phase 6 exit".
9. Report to the owner:
   - the counts
   - the clauses moved to Phase 7
   - the review findings and residuals
   - the mutation scores per group, survivors killed, equivalents, defects found
   - the owner items (IN-53 decision, residuals)
