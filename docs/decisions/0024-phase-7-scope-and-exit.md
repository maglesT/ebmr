# Decision record 0024: Phase 7 scope and its reconciled exit criteria

- **Date:** 17 October 2026
- **Decided by:** the lead, under the owner's standing instruction of 15 October ("dont ask any decisions take it")
  and decision 0023 (Phase 7 follows Phase 6A in this session). **Default; the owner may change it.**
- **Plan:** `docs/build-plan/phase-7/phase-7-plan.md` (defaults D-P7-1 to 16), interfaces in
  `docs/build-plan/phase-7/slice-7-0-interfaces.md`.
- **Reconciles:** the build outline's Phase 7 exit line (section 11: every FOLLOW/MODIFY control VERIFIED, mutation
  targets met, no open high-severity findings) with decision 0008 (validation-grade testing at deployment) and decision
  0019 (a time-boxed campaign with priorities).

## Scope

Phase 7 makes Batchwright Tablets v1.0-rc, in seven slices:

| Slice | Content |
|---|---|
| 7-0 | Interfaces: the evidence bundle, the gateway feed signature, the release identity, the migration-order check |
| 7a | Decision 0022's fixes: signed gateway feed and mutual TLS (6jc-R9), QA approval of the penicillin and beta-lactam settings (R10), controlled reads limited to the CONTROLLED roles and QA (R2), the remaining batch acts in the batch's {site, product} scope (rest of R16), the dead `recipe.check_engine_roles` overload dropped |
| 7b-1 | The hardening list (reconciliation runs, the gateway keeps an open chunk's samples, an accurate "saved" answer) and the residuals worth fixing |
| 7b-2 | The stand-alone record viewer, the periodic evaluation pack, the readability report (DI-08, DI-11, DI-44) |
| 7c | The validation pack generated from the register, the code and the tests (URS, risk assessment, specifications, trace matrix, IQ and OQ, PQ templates, summary report, release notes, SBOM, known issues); the validation-summary and interface-drift interlocks (DI-03, DI-06); the AI feature inventory (PR-60) |
| 7d | Load and soak against the outline's SLOs, release under concurrent ingestion; the restore, upgrade and migration drills with their records; security verification from the threat model and ASVS level 2; the accessibility audit |
| 7e | Branding (decision 0020) and the user and administrator guides |
| 7f | Exit: trace at 7, one review pass, the combined heavy run on the pod with Phase 6A's (D-6A-15), a focused mutation campaign, the release-candidate checklist |

No demo at the exit (decision 0021). IN-53 stays a draft, PENDING (decision 0022).

## Reconciled exit criteria (D-P7-1)

At the start of Phase 7 all 246 controls are PENDING: the expert has set none to FOLLOW or MODIFY, so the outline's
criterion has nothing in its scope yet. No control is VERIFIED; what VERIFIED means is defined in D-P7-2.

**At v1.0-rc (this phase):**
1. Every PENDING control of the Tablets gate is treated as FOLLOW, the stricter reading. Of the 155:
   - 147 reach VERIFIED: every clause proven on the release candidate's final run, the evidence in the pack, the code
     reviewed, no open critical or high finding against it, a database test for a core control. The status is set by a
     tool from the evidence, never by hand.
   - 5 drafts (IN-53, DI-51, DI-52, DI-53, PR-61) reach IMPLEMENTED with every clause proven, and wait there for the
     expert.
   - 3 controls with an Injectables part (PR-15, PR-26, PR-28) stay SPECIFIED, their Tablets parts proven.
2. No open critical or high finding in any backlog. Medium and low findings are listed as known issues.
3. The full suite, the golden batches, the browser suite and the trace at phase 7 green in one final run, at most two
   final runs; one review pass at the exit.
4. A focused mutation campaign under decision 0019's rules: the SQL of Phases 6A and 7 and the Phase 7 and analytics
   TypeScript; Priority 1 always fixed; one first run and at most one confirmation run per group; a box of 6 pod hours
   for SQL and 4 for Stryker. Scores are reported against the targets; a missed target does not block the release
   candidate, an unfixed Priority 1 defect does and goes to the owner.
5. The load, soak, restore, upgrade, migration, security and accessibility records written; each SLO met, or its
   residual written for the owner.

**At deployment validation (not this phase):** the expert's decision on every control and the re-verification of any
MODIFY; the customer's IQ, OQ and PQ from the generated pack on its own installation; the mutation targets of decision
0008 (at least 90 % in the high-risk groups, 70 % elsewhere) on the validated build; the external penetration test;
the screen-reader user test; the whole SQL re-run and the kill confirmations left by Phases 4 and 6.

## How the owner can change it

- Make the mutation targets an exit gate: replace item 4 with "targets met", and the box with the hours that takes.
- Call the drafts VERIFIED: change item 1's second bullet.
- Ask for a longer soak or another reference site: D-P7-4 and D-P7-5 in the plan.
- Any other default: the D-P7 list in the plan.

## What does not change

- No control, catalog test, target phase or `expert_decision` is changed. A control that seems wrong is written up for
  the owner.
- Decision 0008's cadence: tests with every feature, one review per slice, at most 2 fix rounds per finding, database
  enforcement for the regulation-required core.
- Regulations are paraphrased; the generated pack cites clause references and never reproduces regulation or guidance
  text.
- Code names stay (decision 0020); GMP records keep the manufacturer's identity.
