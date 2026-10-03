---
name: fix-finding
description: How to fix a review finding, a reported defect or a demo finding in this repository. Use when asked to fix a finding (F-numbers, critic or reviewer findings, owner demo reports), a bug, or a control gap.
---

# Fixing a finding

A finding is fixed when a test that names its controls failed before the change and passes after it, the rule is
enforced at the layer every writer goes through, and `pnpm run ci` passes. Work through the steps in order.

## 1. Re-check it against the current code

Findings are often written against an older commit. Read the code at your branch's HEAD, and the finding's cited
lines, before doing anything. If HEAD already behaves correctly, say so with the evidence (the test or the code
path) and stop; do not "fix" it twice.

## 2. Reproduce it first

Write the test before the fix and run it to see it fail for the reason the finding gives (not a set-up error).
- Name the controls in the test title: `it('[DI-34] ...')`, plus `[INV-xx]` for invariants. Look the IDs up in
  `compliance/controls/`; a citation of an unknown ID fails CI.
- A rule about what may be stored, signed or changed is tested against the database directly (a writer that
  bypasses the server), not only through the API. The kernel's `packages/kernel/test/support/` and the server's
  `apps/tablets-server/test/support/harness.ts` give the database and server set-ups.
- If you cannot reproduce it, write down what you ran and what happened, and report that instead of a fix.

## 3. Fix it where the rule belongs

- **Database first.** A rule that must hold for every writer (order of steps, who may sign, what a signature
  covers, durations, immutability) is enforced in PostgreSQL (trigger, constraint, function or grant). Server
  code may check it too, for a clear message, but the database is the guard.
- **New migrations only.** Never edit a migration file that exists on `main` or on a pushed branch: installed
  databases (including the owner's demo databases) already ran it. Add a new numbered file that replaces the
  function or adds the constraint.
- **No weakened controls.** Never change a control's YAML, a limit, a required signature or a test's assertion
  to make the fix pass. If the control looks wrong, write it up for the owner.
- Keep the change to what the finding needs. A second problem you notice goes in your report, not in this commit.

## 4. Prove it

1. The new test passes; the tests of the touched area pass (`pnpm vitest run <paths>`).
2. Guard code (signing, access, limits, rounding, state changes): run the focused mutation check (skill
   `mutation-check`) on the changed lines or SQL group. Targets: 90 % for guards, 80 % elsewhere; a surviving
   mutant needs a test or a written justification.
3. `pnpm run ci` (skill `local-ci`), and the E2E specs for any screen you touched.
4. Re-read your diff as a reviewer who wants to reject it.

## 5. Record it

- One commit per finding: the subject says what now holds, then the finding and control IDs in brackets, for
  example `A weighing refused as stale no longer uses up its scale readings (F58; DI-32, DI-34)`.
- Update `PROGRESS.md` at the milestone (what was fixed, what stays open and why).
