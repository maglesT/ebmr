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
