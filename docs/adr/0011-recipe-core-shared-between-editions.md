# ADR-0011: recipe-core is shared between the editions

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 Decision 1, option A, including the proposed kernel boundary (decision record 0001)
- **Supersedes:** none

## Context

- The two editions (ADR-0001) need the same kinds of process logic: flow model and engine, static validator, simulator, expression language, limit tiers and rounding, lifecycle machines (MBR, batch, step, lot, equipment, deviation, exception) and 25 generic blocks (G-01..G-25, aliased K-xx in Tablets and KB-xx in Injectables).
- This is the most error-prone logic in the system. Two copies would double the testing and validation effort and would drift apart.
- Each edition must still take shared changes only through its own change control.
- Decision 1 offered: (A) share kernel, site services and recipe-core, each edition pinning exact published versions; (B) share only kernel and site services; (C) share now and fork later if needed. It also asked to confirm the kernel boundary.

## Decision

1. **Option A.** The shared packages are `kernel`, `site-services`, `expr`, `recipe-core`, `ui-kit` and `integration-sdk`. Each edition pins exact versions of each (ADR-0015).
2. **Kernel boundary (confirmed):** persons, identity and access, electronic signatures, audit trail and time, plus the compliance plumbing around them (hashing and sealing, idempotency, outbox, retention, true copies, control-register loader, market-profile engine). The kernel holds no process logic.
3. **recipe-core** holds the flow model, compiler, validator, engine, simulator, parameter and limit model, generic blocks G-01..G-25 and the lifecycle machines with their guards. Its database migrations are versioned with the package and applied to each edition database's recipe schema.
4. **Editions** hold only edition-specific blocks (TB-01..TB-24, IB-01..IB-30), edition validator rules (for example IB-01, the sterile MBR validator), edition entities and schemas (`tab.*`, `inj.*`), edition rule keys (`tablets.*`, `sterile.*`), and their implementation of the `ResolutionContextProvider` port (ADR-0008).
5. **Dependency direction** (lint-enforced): `kernel` imports nothing else in the repo; `recipe-core` may import `kernel` and `expr`; packages never import apps; apps never import each other.
6. **Extension, not forking.** Edition needs are met through the block registry, edition validator rules and ports. A change to recipe-core that only one edition needs still ships as a new version that the other edition adopts only through its own change control.

## Consequences

### Positive

- The riskiest logic is written, tested and validated once; both editions' golden batches exercise the same engine.
- A fix reaches both editions, each on its own schedule.
- Consistent behaviour across editions for corrections, exception tiers, limits and lifecycle rules, which simplifies training and inspection.
- Validation effort for this layer is roughly halved.

### Negative

- Every recipe-core change needs an impact assessment for both editions.
- A defect in recipe-core is common-mode: it affects both editions at once. Mitigated by mutation targets of 90 % for guards, limits, rounding, flow validation and release gating, and by both editions' golden suites running in CI.
- Generic abstractions can bend towards one edition; edition validator rules and the block contract must carry edition specifics instead.
- Backports are needed per minor line when editions pin different recipe-core versions (ADR-0015).

## Alternatives considered

- **Option B: share only kernel and site services.** Rejected: duplicates the most error-prone logic, doubles its validation and invites divergence.
- **Option C: share now, fork later if needed.** Rejected: a later fork leaves two maintained copies anyway and loses the shared validation; exact pinning already gives each edition control over when it takes changes.

## Related controls and invariants

- Controls: DI-03 (computerised-system validation), DI-04 (verification of each MBR), DI-09 (change management), DI-33 (calculations), DI-34 (operational sequencing), PR-08 (limit model), PR-13 (step sequence).
- Invariants: INV-01 to INV-04, INV-19, INV-20, INV-25, INV-41 (implemented in recipe-core for both editions).

## References

- Build outline v0.2: sections 1 (What is shared), 4.3, 6.6, 12 risk 5, 13 Decision 1.
- Decision record 0001, row 1.
- Architecture research: 2.9, 7.3.
