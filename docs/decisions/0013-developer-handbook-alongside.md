# Decision record 0013: a developer handbook, written alongside the build

- **Date:** 13 October 2026
- **Decided by:** project owner (maglesT), in the Phase 4 session: full technical documentation of how the software is
  built (the code, what worked, the bugs found and fixed) so that a software team can understand it, debug it and test
  it; asked whether it should be written later or alongside. Taken: alongside, consolidated in Phase 7.

## Decision

1. `docs/handbook/` is the entry point for a software team: architecture overview; one module guide per package (what
   it does, its main tables and functions, which control each guard enforces, how to test it, pitfalls); the database
   reference (migration order and rules, security conventions, a function and trigger catalogue generated from the
   migrations); the testing and debugging guide (test layers, golden batches, browser suite, mutation runs, CI failure
   diagnosis with this project's real cases); the defect and lessons log (each significant bug: cause, fix, guarding
   test, from the review backlogs and history); the control-to-code map (generated from the register); operations
   runbooks.
2. Phases 1 to 4 are documented now, after the Phase 4 focused mutation run (decision 0012) and before Phase 6.
3. From Phase 6 on, every slice updates its module guides and the defect log as part of being done; the quick review
   checks it.
4. Phase 7 consolidates the handbook into the final technical reference, beside the validation pack.
5. Generated parts (function catalogue, control-to-code map, OpenAPI) are produced by scripts with a test that they are
   current, so they cannot drift from the code.

## Owner's requirements for the handbook (13 October 2026)

The owner added: the handbook must be very exhaustive, user friendly and in easy language; the developers do not know
pharma, so it gives the pharma context, explains it and links each pharma rule to the code that carries it; and it
must hold what developers need to understand the project's logic and code. So:

- **Easy language** throughout: short sentences, plain words, each technical or pharma term explained the first time
  it appears, with examples from the demo data (GB-T-01, GB-T-02).
- **Pharma for developers**: a primer (what a batch record is, why GMP, who signs what and why, what release means,
  why records are locked, what a deviation, an OOS, a recall is), a glossary of every pharma and regulatory term used
  in the code (G-REL, AP, QP, QCU, INV-xx, PR-xx, ...), and the regulations paraphrased in plain words (never pasted).
- **Pharma-to-code links**: every module guide and every guard has a "why this exists" box: the pharma reason, the
  control ID, the code (file and function) that enforces it, and the tests that prove it.
- **Walkthroughs**: the life of a batch from master record to release, recall and archive, step by step, showing the
  screens, the routes, the database functions and triggers each step passes through.
- **Logic and code depth**: data model and state machines with diagrams, the signing and epoch mechanisms, the locking
  and audit design, the error-code catalogue, how to add a feature safely (a worked example), how to debug a failing
  guard, and the testing guide.
- **History**: the defect and lessons log and the "removed and replaced" section from git history and the docs.
