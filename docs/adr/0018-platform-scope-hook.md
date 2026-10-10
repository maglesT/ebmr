# ADR-0018: A SCOPE hook for the platform's permission checks

- **Status:** Accepted (2026-10-10)
- **Deciders:** the lead, on the Phase 3 slice 3a quick review (finding 1) and review backlog #5 (slice 2b)
- **Supersedes:** none (extends the enforcement hooks of kernel 0500 and the authority adapter of kernel 0710)

## Context

- A platform state transition checks its machine permission through the AUTHORITY hook, `iam.platform_authority`
  (kernel 0710). It evaluated the permission in the session's location scope only (site, room).
- A grant can be limited to a product. The plant commands check STEP.EXECUTE with the batch's product, but the
  transitions they then make (a press's START_USE and END_USE, an output container's events) were evaluated without
  it, so an operator whose grant is limited to the product could never complete them (backlog #5: fails closed).
- The kernel holds no process logic (ADR-0011): it cannot know which product a plant unit or a container belongs to.
  A first fix re-created the kernel's function from a recipe-core migration and called a plant function from it; a
  kernel-only installation then failed every platform check, and a later kernel change would have been overwritten.

## Decision

1. The platform takes a third enforcement hook, **SCOPE**: `fn(permission text, aggregate_type text, aggregate_id
   text) returns jsonb`, the scope members the record adds (kernel 1150). `platform.register_hook` knows its signature.
2. `platform.scope_of` calls the registered SCOPE hook and answers `{}` when none is registered or it answers no object.
3. `iam.platform_authority` evaluates the location scope merged with `platform.scope_of(...)`. The AUTHORITY hook
   still names it; nothing else in the adapter changes.
4. A domain module registers its provider from its own migration: recipe-core 0523 registers `plant.transition_scope`
   (the product, for step.execute on plant equipment and output containers only).

## Consequences

### Positive

- A product-limited operator can run the plant commands for that product; a grant limited to another product is still
  refused and an unlimited grant matches as before (the added members only narrow which grants match).
- The kernel stays free of process logic and works on its own (proven by a kernel test with no SCOPE hook).

### Negative

- One SCOPE hook per database: a second module that needs one must compose with the first (a dispatching function by
  aggregate type). Revisit when the Injectables edition adds its own aggregates.
- The hook runs as definer code inside every platform permission check; it must stay small and must not raise for
  records it does not know (it answers `{}`).

## Alternatives considered

- **Re-create the kernel adapter from a domain migration.** Rejected: breaks the kernel-only installation and the
  layering (the first fix, review finding 1).
- **New machine versions without the transition permission.** Rejected: existing aggregates stay on the old version,
  and the permission would then rest on the command function alone.

## Related controls and invariants

- Controls: DI-17 (least privilege, scope-limited grants), IN-21 (product segregation of plant work)

## References

- Kernel migrations 0500, 0710, 1150; recipe-core migration 0523; `docs/build-plan/phase-3/review-backlog.md` (#5)
- ADR-0011, ADR-0012, ADR-0016
