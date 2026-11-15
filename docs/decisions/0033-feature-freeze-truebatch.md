# Decision record 0033: Batchwright is frozen for new features; TrueBatch replaces it

- **Date:** 15 November 2026
- **Decided by:** the owner. The owner took the decision with the demo administrator session (14 and 15 November
  2026), which relayed it to the lead (https://claude.ai/code/session_01PybpFvF4SWgYSyQDHAVFb6) at about 06:30 UTC.
  The owner answered the open-PR question in that lead session ("Close everything"), and then uploaded the TrueBatch
  decision record that is summarised below.
- **Amends:** every plan for new work in this repository (the build outline section 11, decision 0026, ADR 0023
  families 6.1 onward, Injectables I-6, decision 0032's later steps). Nothing else changes: the controls, the tests,
  the merge loop and the CLAUDE.md hard rules stay in force for any fix.

## The rule

1. **No new features in ebmr.** No new rule families, editions, controls, CI projects or migrations for features.
   **Real bug fixes only**, and the demo keeps running. A fix still follows the merge loop (decision 0032) and the
   `fix-finding` skill.
2. **Open work is closed, not merged** (owner, 15 November): #261 (expected answers re-checked in the database,
   recipe-core 1931), #271 (hidden field, 1932) and #275 (ADR 0023 family 6.1, showWhen) were closed unmerged. The
   INV-23 (b) and (c) branches were never opened as PRs. All the branches are kept for reference. Their state is in
   `docs/build-plan/injectables/resume.md` (on `inj/i6-inv23b-em-with-fill`) and `docs/build-plan/build-speed/resume.md`
   (on `rules/family-6-1-showwhen`).
3. **Build sessions are ended.** Sessions 21 and 22 were archived. Any future session in this repository starts
   only for a real bug.
4. **Owner actions that lapse:** the Ubicloud runner (`E2E_RUNNER`), the required "Main is green" check, family 6.2
   onward, and the migration-number collision fix. The Tablets v1.0.0 tag and the decision 0031 questions stay open
   for the owner.

## What replaces it: TrueBatch (summary of the owner's record)

The full record lives with the new product. This is a summary, for anyone who reads this repository.

- **A new product family, TrueBatch**, much thinner and faster to change than Batchwright. Its design follows the
  platform Logbook, not Batchwright. It runs on the Medhanta platform: core sign-in, permissions, e-signature
  re-authentication and master data. The platform does install, migration, backup and update.
- **One product per dosage form.** The first is TrueBatch Tablets: manufacturing, from dispensing to QA release of
  the coated bulk. TrueBatch Tablets Packing comes later as a separate product.
- **Markets:** EU GMP (Part I and Annex 11), US FDA (21 CFR 211 and Part 11) and India Revised Schedule M. No sterile
  products and no APIs.
- **Compliance:** Batchwright's 265 controls were reduced by one test: a rule stays only if dropping it breaks a
  binding clause. The 71 that remain were merged into 22 TrueBatch rules (TB-01 to TB-22).
- **Design:**
  - Batch rules are checked once, in the app. The database protects records only: an insert-only audit trail,
    locked signed records, and writes by the app alone.
  - There is no formula language. About 40 fixed calculation templates, each a pure function with table tests.
  - Step blocks are data.
  - A master version is one JSON document.
- **What it reuses from Batchwright:** pharma knowledge and a few proven calculations (exact GMP decimal maths,
  units, limit rounding, fixed calculations).
- **What it drops:** among much else, CAPA, training, alarms, analytics, the control-register machinery, mutation
  testing, drills and golden batches.
- **Repository:** a new public repository, built by the demo administrator session. Do not start a parallel
  TrueBatch build from this repository without the owner's decision.
