# ADR-0001: Two editions, separate edition databases, shared site services

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 Decisions 12 and 13, option A (decision record 0001)
- **Supersedes:** none

## Context

- The product covers two dosage forms: oral tablets and sterile injectables. Both follow the same data-integrity and release rules, but their processes, building blocks (TB-xx and IB-xx), controls (ST-01..ST-79 apply only to Injectables) and validation scope differ widely.
- A GMP customer validates what it runs and decides when a change reaches its validated environment. A change made only for sterile products must not create a change-control impact for a Tablets customer (L-57).
- Some sites run both editions. Persons, qualifications and training, material lots and their usage status, batch numbers and registered devices belong to the site, not to an edition. If each edition kept its own copy, a lot rejected in one edition could still be consumed in the other, and the two editions could allocate the same batch number (IN-18).
- Consumption must stay atomic inside each edition's transaction (INV-13, INV-14) without distributed transactions across databases.
- Decision 13 offered: (A) one site-services database per site, with reservations; (B) external ERP/LIMS/LMS own these data and both editions mirror them; (C) both editions in one database per site.

## Decision

1. **Two products.** Tablets and Injectables are separate products, each with its own server application, web application, database, screens, MBR designer and release cycle. A designer palette holds only its own edition's blocks. `apps/tablets-*` and `apps/injectables-*` never import each other (lint-enforced).
2. **Separate edition databases.** `ebmr_tablets` and `ebmr_injectables`, each holding `kernel.*`, the recipe schema and its edition schema (`tab.*` or `inj.*`). Each edition also has a physically separate `ebmr_sandbox_<edition>` for test runs and training, whose role holds no grants on any GMP database (ADR-0012).
3. **One site-services database per site** (`ebmr_site`, package `site-services`): persons, accounts, credentials and badges, qualifications and training, material lots with usage status, reservations, the batch-number allocation register and the device registry. A single-edition site runs the same database on the same server, so there is one code path.
4. **Reservations keep edition transactions local.** Editions keep freshness-bounded mirrors of site-services data for their guards and consume material only through short-lived reservations granted by site services. A lot status change revokes open reservations and is pushed to the editions. Consumption against a revoked or expired reservation is refused; a revocation that arrives after consumption raises an exception in the consuming batch.
5. **Topology.** v1 is one installation per site per edition and environment (development, validation, production), on premise by default or in a single-tenant private cloud (Decision 12 A). The enterprise hub is v1.1. Lots move between sites as signed lot-transfer packages received into local quarantine and accepted by local QA.

## Consequences

### Positive

- Each edition is validated, upgraded and supported on its own; a sterile-only change never enters a Tablets validation.
- One directory of persons and one lot status per site: a lot rejected for one edition is unusable in the other, and batch numbers are unique across both.
- Person-based segregation of duties (7.2) works across editions because both see the same person record.
- An edition database can be restored or upgraded without touching the other edition's data.
- The same code path serves single-edition and dual-edition sites.

### Negative

- Cross-database consistency rests on the reservation protocol rather than one transaction; revocation races become exceptions and must be covered by model-based tests (risk 13).
- Site services is shared by both editions at a site, so its schema and API must stay compatible with every edition version installed beside it, and its upgrades go through change control for both editions.
- Guards that read mirrors must check freshness and fail closed for qualifications and lot status (INV-38), which adds heartbeat handling.
- Cross-edition genealogy and recall (one excipient lot used by both editions) is a federated query, not one SQL statement (ADR-0002).
- A dual-edition site operates, backs up and restore-drills three GMP databases.

## Alternatives considered

- **One general product for both dosage forms.** Rejected: customers could turn one edition into the other, and every sterile rule would sit inside a tablet customer's validation scope.
- **Decision 13 option B (external systems own the shared data).** Rejected for v1: many target sites have no LMS or WMS. Per data item it remains possible through adapters (outline 4.6).
- **Decision 13 option C (both editions in one database per site).** Rejected: both editions would be tied to one kernel and schema version and could no longer be validated and upgraded independently.
- **Each edition owns its own persons and lots.** Rejected: duplicated identities break person-based segregation, and a lot rejected in one edition stays usable in the other.

## Related controls and invariants

- Controls: IN-18 (batch numbering and allocation register), IN-24(a) (material usage status owned by the eBMR), PR-10 (issuance and numbering), DI-05 (segregation of sandbox and training), DI-14 and DI-15 (unique persons and accounts), DI-20 (device checks).
- Invariants: INV-11, INV-13, INV-14, INV-18, INV-26, INV-27, INV-38.

## References

- Build outline v0.2: section 1 (What is shared), 2.5 assumption 3, 4.2 (v1 topology, Site services), 4.3, 4.4 (Databases), 12 risk 13, 13 Decisions 12 and 13.
- Decision record 0001, rows 12 and 13.
- Architecture research (`docs/design/architecture.md`): 6.1, 7.3.
