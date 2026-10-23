# Architecture Decision Records

This folder holds the architecture decisions for the eBMR Tablets and Injectables editions, in Michael Nygard's format. Each record states one decision, the context that forced it, what it costs, what was rejected, and which controls (DI/PR/ST/IN) and invariants (INV-xx) it serves.

Records 0001-0015 were accepted on 2026-09-27 together with build outline v0.2 (`docs/outline/build-outline.md`) and decision record 0001 (`docs/decisions/0001-outline-v0.2-decisions.md`). Expert decisions on the 241 controls in review pack v0.9 are still pending; an expert MODIFY or DONT_FOLLOW that changes an architecture-level choice gets a new ADR (outline 3.4 step 4).

## Index

| No. | Title | Status | Summary |
|---|---|---|---|
| [0001](0001-two-editions-separate-databases-shared-site-services.md) | Two editions, separate edition databases, shared site services | Accepted (2026-09-27) | Tablets and Injectables are separate products with separate databases; one site-services database per site holds persons, qualifications, lots and batch numbers, consumed through reservations. |
| [0002](0002-postgresql-only-no-graph-database.md) | PostgreSQL as the only system of record; no graph database | Accepted (2026-09-27) | Genealogy is an insert-only link table traversed by recursive SQL (0.03 ms backward trace, 48 ms worst hub, 0.86 s supplier recall on 20 M links); a graph store only as a later non-GMP copy. |
| [0003](0003-typescript-end-to-end.md) | TypeScript end to end | Accepted (2026-09-27) | One strict TypeScript codebase for browser and server (Node LTS, Fastify, Zod, Kysely, React, XState) so high-risk logic is written and validated once. |
| [0004](0004-block-structured-flows-with-replicate-sections.md) | Block-structured flows with replicate sections | Accepted (2026-09-27) | MBR flows are block-structured trees (sequence, AND-parallel, alternative, bounded endpoint loops, hold points, replicate-per-sub-lot) that are sound by construction. |
| [0005](0005-in-house-decimal-ucum-expression-language.md) | In-house expression language with decimal arithmetic and UCUM units | Accepted (2026-09-27) | A small, pure, CEL-like language on 34-digit decimals with UCUM units, pharmacopoeial rounding at comparison and a closed function library. |
| [0006](0006-server-authoritative-execution-no-device-signing.md) | Server-authoritative execution; no signing on devices | Accepted (2026-09-27) | The server decides every command in one transaction; terminals never sign offline; continuity through a site server and pre-staged paper packs. |
| [0007](0007-hash-chained-audit-trail-checkpoints-anchors-restore-events.md) | Hash-chained audit trail with checkpoints, anchors and restore events | Accepted (2026-09-27) | Trigger-captured audit with per-aggregate SHA-256 chains, external anchors, closure checkpoints, signed restore events and tombstoned purge. |
| [0008](0008-market-profile-engine-atomic-keys-stored-resolutions.md) | Market-profile engine with atomic keys and stored resolutions | Accepted (2026-09-27) | Market rules are versioned rows of atomic keys resolved by explicit methods, never looser than India, with every resolution stored. |
| [0009](0009-control-register-as-data.md) | The control register is data | Accepted (2026-09-27) | Controls and requirements are YAML files; tests, trace matrix, URS and review pack are generated from them and CI gates each phase. |
| [0010](0010-versioned-execution-handlers-retained-renderers.md) | Versioned execution handlers, retained renderers | Accepted (2026-09-27) | Execution handlers are versioned and retired when unused; renderings are frozen at closure so records stay readable without old code. |
| [0011](0011-recipe-core-shared-between-editions.md) | recipe-core is shared between the editions | Accepted (2026-09-27) | Decision 1 = A: kernel, site services, expr and recipe-core are shared and exactly pinned; the kernel holds no process logic. |
| [0012](0012-privilege-separation-security-definer-transitions.md) | Privilege separation and SECURITY DEFINER transitions | Accepted (2026-09-27) | The application role cannot update status, audit, signature or data rows; transitions and signatures run only through SECURITY DEFINER functions, proven by bypass tests. |
| [0013](0013-manufacturer-release-plus-market-dispositions.md) | India manufacturer release plus per-market dispositions | Accepted (2026-09-27) | The India AP release gates every market; US QCU disposition and EU QP certification (at the EU site, after quarantined shipment to the named importer) follow per market. |
| [0014](0014-per-market-mbr-effectivity.md) | Per-market MBR effectivity | Accepted (2026-09-27) | An approved MBR version becomes CURRENT per market and scope through signed authorisation records, with time-limited bridging while another market's approval is pending. |
| [0015](0015-exactly-pinned-shared-packages.md) | Exactly pinned shared packages | Accepted (2026-09-27) | Editions pin exact shared versions (Phase 0: `workspace:<exact>` with a CI check; later a private registry with Changesets) with a backport policy per kernel minor line. |
| [0016](0016-validated-actor-context-and-definer-hardening.md) | Validated actor context and SECURITY DEFINER hardening | Accepted (2026-09-27) | Only contexts installed by kernel code count (owner-only marker per transaction); forged `set_config` contexts are ignored and refused; definer functions list pg_temp last and the application cannot create temporary objects. |
| [0017](0017-web-runtime.md) | Web runtime: two installations of one server, typed contract, device-bound sessions, exchange directory | Accepted (2026-09-28) | One tablets server binary serves GMP and sandbox installations; a frozen zod contract binds server and browser; browsers state intents, never facts; sessions are opaque tokens bound to device-proven terminals; strict CSP; an exchange directory between installations. |
| [0018](0018-platform-scope-hook.md) | A SCOPE hook for the platform's permission checks | Accepted (2026-10-10) | Domain modules add the scope of the record a transition acts on (e.g. its product) through a kernel SCOPE hook merged into the authority adapter's location scope; without one the kernel checks as before. |
| [0019](0019-generic-block-guards-in-recipe-core.md) | Database guards of generic blocks move to recipe-core before Injectables | Accepted (2026-10-11) | A guard enforcing a generic block's rule belongs to recipe-core; the Tablets copies are re-created there before Phase 5. |
| [0020](0020-analytics-module-read-only-advisory.md) | The analytics module: a pure package, a read-only runner role and an advisory output schema | Accepted (2026-10-17) | `@ebmr/analytics` computes only; a runner reads as `ebmr_analytics` (no GMP privilege) and records insert-only, audited, versioned outputs in the non-GMP `analytics` schema; floats only inside analytics; TypeScript with `ml-matrix` and `@stdlib`. |
| [0021](0021-plant-on-the-sandbox.md) | The plant and the containers on the sandbox too | Accepted (2026-10-23) | Plant, containers and the batch's plant reads serve both installations, each against its own database, so a master's sandbox test run records its plant acts and earns its SANDBOX_RUN evidence on screen. |

## Conventions

- **File name:** `NNNN-short-kebab-title.md`, numbered in sequence; numbers are never reused.
- **Status values:** Proposed, Accepted (date), Rejected (date), Deprecated (date), Superseded by ADR-NNNN (date). An accepted record is not rewritten; a changed decision gets a new record, and the old one is marked superseded. Typos and broken links may be fixed in place.
- **When to write one:** any choice that changes the architecture, the kernel boundary, a database or privilege model, a dependency direction, the release or signature model, or how controls are traced; and any expert MODIFY or DONT_FOLLOW decision with architectural effect.
- **Length:** 40-120 lines; plain, precise language.
- **Regulations:** paraphrase; never copy more than about ten consecutive words from a regulation. Cite clause numbers with the verification markers used in the outline (S, U, P~) where they apply.
- **Traceability:** cite the controls (DI-xx, PR-xx, ST-xx, IN-xx) and invariants (INV-xx) the decision serves, and list the ADR under `implemented_by` or in the comment of those control files where relevant.
- **Review:** ADRs are reviewed in the same pull request as the first code that depends on them; CODEOWNERS for `packages/kernel` and `compliance/` review ADRs that touch them.

## Template

Copy this into a new file and replace every placeholder.

```markdown
# ADR-NNNN: <Decision title, stated as the choice made>

- **Status:** Proposed | Accepted (YYYY-MM-DD) | Superseded by ADR-NNNN (YYYY-MM-DD)
- **Deciders:** <who decided, and the decision record or outline decision it rests on>
- **Supersedes:** <ADR-NNNN, earlier design, or "none">

## Context

<The forces at play: requirements, regulatory constraints (paraphrased), technical facts,
measurements, and the options that were open. No solution yet.>

## Decision

<What we will do, as numbered, testable statements. Name packages, schemas, roles, states
and rule keys where they are fixed by this decision.>

## Consequences

### Positive

- <What becomes easier, safer or cheaper.>

### Negative

- <What becomes harder, riskier or more expensive, and how it is mitigated.
  Open points that a later phase must settle are listed here.>

## Alternatives considered

- **<Alternative>.** <Why it was rejected, or under what conditions it would be revisited.>

## Related controls and invariants

- Controls: <DI-xx, PR-xx, ST-xx, IN-xx with a few words each>
- Invariants: <INV-xx>

## References

- Build outline: <section numbers>
- Decision records, resolution log items (R-xx, L-xx), architecture research sections, other ADRs.
```
