# Decision record 0008: faster delivery; robust software here, heavy validation at deployment

- **Date:** 5 October 2026
- **Decided by:** project owner (maglesT): "yes then give the plan to do using the new thing ... compliance make it
  less strict and also the plan you gave for phase 4 till then do according to it and try to do it faster but also not
  with major bugs or issues". Amended the same day: "during deployment and testing anyways it would need heavy testing
  which developers would do so ... if its robust enough to work properly normally and not have major issues its okay".
- **Context:** the Phase 2 exit took most of its time and tokens in repeated review rounds (F12 alone took 8), in the
  full SQL mutation campaign with skeptic agents for every group, and in running many agents at once on one machine. The
  tests written with each feature were a small share. Decision 0005 (28 September) had proposed building to the core of
  the binding regulations only and was withdrawn the same day; this decision is narrower: no control is removed and no
  `expert_decision` changes. What changes is when the heavy checks run and how deep the work goes beyond what a control
  and its regulation ask.

> **Amended for the Phase 3 exit** by decision 0009 (10 October 2026): the Phase 3 exit row of section 1 is replaced by
> the plan in `0009-phase-3-exit-mutation-and-full-testing.md` (an Opus mutation run on the Phase 3 code and on Phase 1
> and 2 code changed since their exit runs, one Opus review pass, fixes each with a test, one final full run). The rest
> of this decision stands.

## 1. Testing cadence

| Item | Before | Now |
|---|---|---|
| Tests written with each feature, database rule tests named with control ids, CI green before merge | Every change | **Unchanged** |
| Review of a feature | Lanes with adversarial verifiers, up to 3 rounds | One review pass per feature or slice |
| Phase 2 exit | Exit review, follow-up rounds, full SQL mutation run | Finished with the work already running (defect lanes, the last kill groups, D16); the harness runs only on the functions those fixes change |
| Phase 3 exit | Full exit review and mutation run | One quick review pass (design and serious defects only), no rounds, no mutation campaign; GB-T-01 must still match its expected outputs |
| Phase 4 exit | Same as every phase | **A robustness check for Phases 2 to 4:** one review pass (serious defects only), the full test suite, the golden batches with exact outputs and the browser suite. The validation-grade heavy testing (multi-round adversarial review, mutation campaigns, IQ/OQ/PQ) is done by the developers who deploy, in the deployment and validation work (decision 0003, outline 9.2) |
| Rounds per finding | Until the verifier agrees (F12: 8) | At most 2 fix rounds; what is left is written up as a residual for the owner to decide |
| Findings | All block the exit | Critical and high are fixed at once; medium and low go to the backlog (docs/build-plan/phase-2-exit/review-backlog.md and its successors) |
| Agents at once | Up to 6 or more | 2 to 3, so test databases and disk stay in bounds |

## 2. Depth beyond what the regulations ask

The regulation-required core keeps its full depth, enforced in the database and tested as now: the audit trail (who,
what, when, why, old and new values), electronic signatures with their meaning bound to the record, role-based access
and segregation of duties, records that cannot be changed or deleted unnoticed, trusted time, status changes and the
review and release interlocks, limits, calculations and recorded data points, and the stricter-rule-wins market
resolution. These are the high-risk functions of outline section 9.2.

Where the build has gone beyond that, it is relaxed:

1. **The sandbox identifier rule (F12, DI-05) is frozen as it is** (kernel 1030 to 1140, recipe-core 0344 to 0350). No
   further rounds on free text that looks like a real identifier. DI-05's own behaviour stays: a separate sandbox
   database, reserved TEST- identifiers for what the system generates, the NOT-GMP watermark, no path into GMP records.
2. **Database enforcement is required for the core above.** Other rules (designer guidance, message wording,
   convenience checks, read-only views that hide nothing a role may not see) may live in the application code with
   their tests. ADR 0012's rule that the core holds under the application's own database credentials is unchanged.
3. **Mutation targets (outline 9.1)** move to the deployment validation: at least 90 % for the high-risk groups
   (guards, signature invalidation, limits, rounding, flow validation, release gating, audit trail) and 70 % elsewhere
   (was 80 %). This build keeps the SQL harness and Stryker working and runs them only where a change touches a
   high-risk guard and the run is cheap.
4. **Hiding investigations and holds from the application role** (F34, F35, HW.1 to HW.3) stays where it is; no
   further work beyond role-based read rules.
5. **Exact-microsecond edge tests** are written only where a rule depends on the exact instant (signature windows,
   time constraints, holds); elsewhere a test at a normal margin is enough.

Phase 3 and 4 work classifies each new control's implementation as core (database-enforced, full tests) or other
(application code allowed) before building it, using the control's sources and outline 9.2.

## What does not change

- The control register stays the scope; no control is removed or reclassified, no `expert_decision` changes.
- No migration is edited; nothing already built is taken out (removing working guards would cost time and add risk).
- Each phase still ends with green CI, the trace gate for its controls, and a demo.
- A site that adopts the system still validates it (outline 9.2). The tests named with control ids, the trace matrix
  and the golden batches built here are the evidence that validation starts from.
