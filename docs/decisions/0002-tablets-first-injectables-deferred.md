# Decision record 0002: Tablets edition first; Injectables edition deferred

- **Date:** 28 September 2026
- **Decided by:** project owner (maglesT)
- **Decision:** "drop injectables plan for now, we will go with tablets". The Injectables edition is deferred; the build
  continues with the Tablets edition only.

## What changes

| Item | Before | Now |
|---|---|---|
| Build order (outline section 11) | 0 Foundation, 1 Kernel, 2 Recipe engine, 3 Tablets, 4 Review/release/India, 5 Injectables, 6-7 | 0, 1, 2, 3 Tablets, 4 Review/release/India, then 6-7 for the Tablets edition. **Phase 5 (Injectables) is deferred** until the owner reopens it. |
| Phase 2 scope | Generic engine with tablets and sterile fixtures | Generic engine proven with tablets fixtures only; injectables-only calculations (F0/lethality, fill volume/weight, vial counts) and sterile validator rules are not built now. |
| Controls | ST-01..ST-79 and injectables-only IN controls target Phase 5 | Unchanged in the register (target phase 5). Because `compliance/phase.yaml` never reaches 5 while the deferral stands, CI never requires them; the Tablets edition's validation scope excludes them. |
| Architecture | Two editions, separate databases, shared kernel/site services/recipe-core (ADR 0001, 0011) | **Unchanged.** Shared packages stay edition-neutral and the `apps/injectables-*` skeletons stay, so the edition can be resumed without redesign. Nothing sterile is removed from docs, research, the control register or the rule tables. |

## Consequences

- Phase 3 (Tablets) and Phase 4 (review, release, India specifics) follow Phase 2 directly; the first releasable product
  is the Tablets edition.
- Generic blocks and kernel features are still built edition-neutral (they are shared by design); features needed only by
  injectables (clean-area hierarchy and EM linkage, APS, sterile timers, filter integrity) are not built.
- The sterile rule table (`compliance/rule-tables/sterile/sterile.v1.yaml`) stays as reviewed data; it is not extended.
- Reopening the Injectables edition needs a new decision record; its plan is outline section 11 Phase 5.
