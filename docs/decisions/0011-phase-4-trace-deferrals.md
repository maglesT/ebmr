# Decision record 0011: how the Phase 4 trace treats deferred controls and missing features

- **Date:** 13 October 2026
- **Decided by:** project owner (maglesT), in the Phase 4 session, choosing the recommended option on two questions
  raised by the slice 7 trace (docs/build-plan/phase-4/trace-deferrals.md).
- **Context:** with `phase.yaml` set to 4, the trace failed on controls whose every clause is deferred with a reason
  (documentation-type controls such as DI-06, DI-11, DI-48, IN-12, PR-28, PR-60), and on clauses that need features
  not yet built.

## Decision

1. **Fully deferred controls.** The trace accepts a control whose every catalog-test clause is deferred, each with a
   reason, to a phase that has not started. Such a control shows as DEFERRED in the matrix and is listed in the
   deferrals document; it needs no passing test until then. The moment the phase it is deferred to starts, the trace
   fails it again unless a passing test proves each clause. A control with even one clause not deferred still needs
   its passing tests as before. A `[meta]` test in tools/register proves both sides.
2. **Clauses that need missing features.** Each is deferred, with its reason, to Phase 6 or Phase 7, both before
   Tablets v1.0 (decision 0010), and listed in docs/build-plan/phase-4/trace-deferrals.md. Phase 4 closes without
   building them; Phase 6 builds them.

## What does not change

No control text, catalog test or `expert_decision` changes. Deferrals keep their reasons in the control files, and
the trace still refuses a deferral to a phase that has started.
