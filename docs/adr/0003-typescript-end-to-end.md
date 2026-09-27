# ADR-0003: TypeScript end to end

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 (decision record 0001)
- **Supersedes:** none

## Context

- The highest-risk logic in an eBMR (guards, state machines, limit evaluation, calculations, flow validation, canonicalisation of signed content) must give identical answers in the browser (instant feedback for operators, live designer validation, simulation) and on the server, which is the authority (ADR-0006).
- Writing that logic twice in two languages doubles what must be reviewed, tested and validated, and lets what the operator is shown drift from what the server decides.
- The correctness strategy (outline 9.1) needs mature tools for model-based, property-based and mutation testing, schema validation at every boundary, and browser end-to-end tests that produce evidence.
- This environment provides Node 22 and PostgreSQL 16. The team needs a large hiring pool and long-term runtime support.

## Decision

1. TypeScript in strict mode for every package and app, on the server and in the browser.
2. Runtime: Node.js LTS (22 in development here; production on 24 LTS, moving to 26 once it becomes LTS). A runtime major upgrade is a platform release with full regression (ADR-0010).
3. Server: Fastify 5 with Zod 4. One schema serves API contracts, forms, block configurations and database-bound types; OpenAPI is generated from Zod.
4. Data access: `pg` with Kysely and plain, reviewed SQL migrations. No ORM, because triggers, row-level security, EXCLUDE constraints, partitions and `SET LOCAL` actor context must stay visible in review.
5. Browser: React 19 + Vite with TanStack Router/Query, accessible headless primitives and our own glove-first design system; React Flow only as the secondary canvas view of the designer.
6. State machines: XState 5 definitions as data; the database transition table, diagrams and model-based test paths are generated from them.
7. Numbers and units: decimal.js and UCUM through `@ebmr/expr` (ADR-0005). Jobs and timers: pg-boss (PostgreSQL-based, no extra infrastructure).
8. Tests and build: Vitest, fast-check, `@xstate/graph`, Playwright, StrykerJS; pnpm + Turborepo with TypeScript project references and boundary lint.
9. Coding rules enforced by lint and review: JavaScript `number` banned for GMP values; `Date.now()` banned in domain code (GMP time comes from the database, INV-16); Zod validation on every input; no cross-edition imports.

## Consequences

### Positive

- Shared logic is written, reviewed, tested and validated once and runs in both places.
- One language and toolchain for the whole team; a large talent pool.
- The tools the validation strategy relies on (fast-check, XState path generation, StrykerJS, Playwright evidence) are mature in this ecosystem.
- Everything runs in the provided container, so every phase can be demonstrated here.

### Negative

- Binary floating point must be kept out of GMP arithmetic by lint rules and review; the type system alone does not prevent it.
- Static types vanish at run time, so schema validation at every boundary is mandatory.
- npm supply-chain exposure: lockfile, exact pins, few dependencies, SBOM, vulnerability and licence scans, provenance and signed artefacts are required (risk 11).
- The Node LTS calendar (Node 22 reaches end of life on 30 April 2027) forces platform releases that customers must validate.
- Shared code ships validation logic to the browser; the server must still never trust a client result.

## Alternatives considered

- **Java/Kotlin (Spring) server with a TypeScript UI.** Viable second choice. Domain logic is either duplicated in the UI or the UI stays thin and gives worse feedback; two toolchains.
- **C#/.NET with a TypeScript or Blazor UI.** Same duplication problem; Blazor narrows the UI ecosystem.
- **Rust core compiled to WASM for browser and server, with a TypeScript shell.** Strongest guarantees, but higher build cost and a smaller hiring pool. Kept as a later hardening path for `expr` and `recipe-core` behind the same interfaces, with the golden-batch suite as the equivalence oracle.
- **Python server with a TypeScript UI.** Rejected: no logic shared with the UI and weaker typing.

## Related controls and invariants

- Controls: DI-03 (computerised-system validation), DI-13 (security baseline: dependency scanning, signed artefacts), DI-33 (calculations), DI-34 (operational sequencing).
- Invariants: INV-16 (database clock for `recorded_at`), INV-25 (derived values computed, never typed).

## References

- Build outline v0.2: sections 1 (Stack), 4.1, 9.1, 10.1 (Coding standards, CI), 12 risk 11.
- Architecture research: 7.1, 7.2, 7.4.
