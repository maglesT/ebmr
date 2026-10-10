# Decision record 0010: Tablets edition to v1.0 first; Injectables after Phase 7

- **Date:** 10 October 2026
- **Decided by:** project owner (maglesT), in the Phase 3 session: "yes record it as decision 0010 tablets then
  injectables", after weighing two options: build Injectables in Phase 5 between Tablets phases, or take Tablets
  through Phases 6 and 7 first.
- **Confirms and extends:** decision 0002 (Tablets first, Injectables deferred until the owner reopens it).

## Decision

The build order is 0 to 4, then 6 (integrations and extras) and 7 (validation pack and hardening) for the Tablets
edition, ending in Tablets v1.0. The Injectables edition (outline section 11, Phase 5) is built after that, as its own
release, followed by its own integration and validation delta.

## Why

- A complete, validated Tablets product reaches sites sooner.
- Injectables is the largest and riskiest part (about 22 % of the work, 79 sterile controls); building it on a
  shared core already proven in use lowers the risk.
- The shared packages (kernel, site services, recipe-core, plant master data) are built edition-neutral, so waiting
  needs no redesign.

## Consequences

- **Shared code stays ready for Injectables.** Every change to a shared package keeps the injectables extension points
  open (equipment states such as DRIED and STERILISED, clean-area grades, sterile hold timers, the site-services mirrors
  of ADR 0001). A review of a shared-package change asks this question.
- **Part of Phases 6 and 7 runs twice.** Each adapter gets an Injectables pass later, and the validation pack is
  generated again for Injectables; the generators and adapters are shared, so most of it is reused.
- **Trace gate.** Raising `compliance/phase.yaml` to 5 or above for the Tablets Phases 6 and 7 would make the 91
  injectables-only controls (target phase 5) due. Before that raise, the register tooling must leave controls whose only
  edition is injectables out of the gate while the edition is deferred (for example an `editions` list in
  `phase.yaml`), with a `[meta]` test proving it. No control file or `expert_decision` changes.
- **Two-edition operation is proven later:** one site running both editions with shared lots and persons is first
  exercised when Injectables arrives.
