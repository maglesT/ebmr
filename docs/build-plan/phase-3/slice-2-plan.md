# Phase 3 slice 2: execution paths (exception tiers, correction, void and invalidation, hand-over)

Plan written 9 October 2026 before building (PROGRESS.md: a plan before each slice). Depth follows decision 0008.
Source: outline 5.2.2 to 5.2.4, INV-31, INV-41; what Phase 2 left (engine paths exist in
`packages/recipe-core/src/engine/corrections.ts` and `exceptions.ts`; the database accepts only part of the commands).

## Scope

1. **Exception register in the database.** Exceptions now live only in the engine state JSON. Add a register table
   written in the same transaction as the engine event, with tier (alert, internal action, registered or validated),
   type, raising step, state OPEN -> DISPOSITIONED, and the review states ACCEPTED_BY_QA / QUERIED -> RESPONDED /
   ESCALATED -> deviation (5.2.4). Insert-only; never deleted; mandatory types cannot be switched off. Disposition by a
   person outside the involvement set (performers, enterers, correctors of the raising step); registered-tier and
   decision-affecting exceptions by QA only. Action tier: the dependent step stays blocked until a deviation is
   attached (PR-08 lets the MBR allow the current step to continue).
2. **The change paths the database still refuses (EBMR-EXE-003).** Catalogue and guard VOID_ATTEMPT (only before a
   result exists; QA approval when S28 is on), INVALIDATE_RESULT (only with a linked deviation or OOS that has an
   assignable cause, approved by QA; the original kept; INV-41), REQUEST_SKIP (MBR-allowed, QA where required),
   ABORT_BATCH (two signatures, checklist) and CANCEL_BATCH (only before IN_PROGRESS). Correction keeps its Phase 2
   path; add S25 approval for critical data and the fail-to-pass rule (objective evidence plus the invalidation
   record). A failing evaluation never becomes passing without that record; its exception closes only by disposition.
3. **Hand-over (L-07).** New engine command and step status ATTEMPT_HANDED_OVER: supervisor and QA signatures and a
   reason; old entries stay attributed and valid; the new performer signs their own entries; the verifier covers all;
   the hand-over is written to the exception register. Closes the Phase 2 backlog item "a relief operator cannot
   complete a step whose data enterer went off shift".
4. **Slice 1 backlog items for slice 2:** #6 (release route and quantity in the signed lot content), #10 (REPAIRED is a
   two-person step), the D-S1-5 crossing flags raised as exceptions, refused label scans logged.

## Controls touched and their class (decision 0008 section 2)

| Control / invariant | Part | Class |
|---|---|---|
| INV-41, DI-24, DI-29, PR-12, IN-06 | correction, void and invalidation keep the original; fail never becomes pass without the approved invalidation record | Core |
| DI-37 | signatures invalidated only on the engine's paths (0382) when a signed value changes | Core |
| PR-08, PR-13, DI-26 (register part) | tiers, action-tier stop, exception register, disposition outside the involvement set | Core |
| INV-31, PR-14 | the verifier did not perform, enter or correct; no zero-human verification; hand-over keeps it | Core |
| L-07 hand-over | signatures, attribution, register entry | Core |
| Correction, void and skip previews; register screens | | Other (application code; screens in slice 6) |

## Defaults taken (decision 0004) and recorded

- **D-S2-1** Execution stays in the sandbox installation in this slice: the change paths, register and hand-over are
  built in the engine and the database and proven there, as all of execution is today. Opening execution to the GMP
  installation (lifting the sandbox-only writers, real batch-number allocation, the GMP batch identity) changes the
  DI-05 sandbox boundary frozen by decision 0008, so it gets its own slice (2b) and review before slice 3, which
  needs it for GB-T-01.
- **D-S2-2** Deviation and OOS records are linked by reference only (deviation-lite arrives in slice 5); an
  invalidation needs a linked reference recorded with an assignable cause and a QA signature.
- **D-S2-3** Batch states PRODUCTION_APPROVED, QA_REVIEWED, LOCKED and UNDER_AMENDMENT are Phase 4 (review and
  release); the QA reopen after production approval waits for them.

## Work split

- A: exception register, tiers and disposition (recipe-core SQL, engine, tests).
- B: void, invalidation, skip, abort, cancel commands and guards; correction approvals (recipe-core SQL, engine).
- C (after A lands its table): hand-over, then the slice 1 backlog items.
- Then: register sync, one quick review, CI, PR, merge on green.
