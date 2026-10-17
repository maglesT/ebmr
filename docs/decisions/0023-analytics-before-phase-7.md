# Decision record 0023: the analytics features are built now, as Phase 6A, before Phase 7

- **Date:** 17 October 2026
- **Decided by:** project owner (maglesT), after the Phase 6 exit, in three messages of the same day:
  - the analytics features of decision 0016 are built now, as Phase 6A between Phase 6 and Phase 7, so that v1.0 ships
    with them and the Phase 7 validation pack covers them once;
  - the scheduler is dropped ("shceduling not needed");
  - the order of work: Phase 6A is built in this cloud session, then Phase 7 here as well, then the heavy testing runs
    on the rented pod.
- **Amends:**
  - decision 0016: its timing ("built after Phase 6") and its list (item 16 removed);
  - decision 0022: its "When" line (Phase 7 waited for the owner's go) and the Phase 6 plan's D-P6g-1 timing;
  - the build outline's section 8 rank 17 (CPV/SPC dashboards at v1.1): items 1 to 3 below now ship in v1.0.
- **Plan:** `docs/build-plan/phase-6a/phase-6a-plan.md`; architecture in ADR 0020
  (`docs/adr/0020-analytics-module-read-only-advisory.md`).

## Decision

1. **Phase 6A builds these items of decision 0016**, under decision 0015's rule set (advisory only, a separate
   read-only module, versioned and validated outputs, statistics first, QA feedback stored):

   | Item | Feature | In 6A |
   |---|---|---|
   | 1 | Trend charts and statistical process control per critical parameter and in-process check, with capability and drift alerts | yes |
   | 2 | Multivariate monitoring: PCA with Hotelling's T-squared and Q-residual charts | yes |
   | 3 | Deviation-rate comparisons by step, equipment, supplier lot, room and shift, with confidence intervals | yes |
   | 8 | Audit-trail anomaly detection: rules first, then per-user statistical baselines | yes; the machine-learning stage (isolation forest, local outlier factor) waits for a real site's history |
   | 9 | Review-by-exception scoring of the QA review queue: it orders the queue and never skips a review | yes |
   | 10 | Golden batch profile on the OPC UA equipment series of slice 6b | yes |

2. **Item 16, the production and cleaning scheduler, is dropped.** It is not built in 6A, in Phase 7 or after v1.0.
   Its design notes stay only in decision 0016's text, in case the owner reopens it. No plan, interface or reporting
   view is kept for it.
3. **Order of work.**
   - Phase 6A is built in this cloud session. Each slice is quick-tested here with targeted tests, and GitHub CI runs
     on each pull request.
   - Phase 7 follows 6A in this session without waiting for another go. Decision 0022's Phase 7 items stay Phase 7's.
   - The heavy final run is on the pod. Plan default D-6A-15 sets when.
4. **Phase 7 is not planned by this record or the 6A plan.** The Phase 7 plan is written when Phase 7 starts. The
   validation pack covers the 6A features once, with the rest of v1.0.

## Why

- A validation pack written once for v1.0, with analytics included, costs less than validating v1.0 and then
  revalidating an analytics release.
- The data paths the features read were left ready in Phase 6: the reporting views and role (6g), the native
  equipment series (6b), the alarm log (6b) and the deviation links (Phase 4, 6a). The features add a module beside
  them and change no GMP path.
- The owner sees no need for a scheduler in this product.

## What does not change

- Decision 0015's rule set holds for every 6A feature. No analytics output releases, blocks, rejects or changes a batch,
  and none is a GMP record or a gate. A person makes every GMP decision.
- Items 4 to 7, 11 to 15 and 17 of decision 0016 stay parked.
- Decision 0008's cadence holds: tests with every feature, one review pass per slice, at most 2 fix rounds per finding,
  database enforcement for the regulation-required core. No mutation campaign unless the owner asks. Decision 0021
  holds: no demo at the 6A exit.
- No control and no `expert_decision` is changed by this record. New controls the features need are drafted with
  status U and `expert_decision` PENDING for the expert (plan section "Draft controls").
