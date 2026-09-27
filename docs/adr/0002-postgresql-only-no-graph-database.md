# ADR-0002: PostgreSQL as the only system of record; no graph database

- **Status:** Accepted (2026-09-27)
- **Deciders:** project owner (maglesT), accepting build outline v0.2 (decision record 0001)
- **Supersedes:** none

## Context

- The system of record must give multi-table ACID transactions (one weighing writes the reading, lot quantity, genealogy link, step state, audit entries, signature binding and outbox event together), declarative constraints (FK, UNIQUE, CHECK, EXCLUDE), database-level protection of the audit trail, point-in-time recovery and HA, records readable for 15 years or more, and as few validated platforms as possible.
- Only a few sub-problems are graph-shaped. Lot genealogy is large (10^6-10^7 lots and 10^7-10^8 links per installation over the retention period) but shallow (4-8 hops from raw material to shipment). MBR flows are deep but tiny (10^1-10^3 nodes per version) and immutable once approved. Where-used is 1-3 levels deep; impact questions are joins over time intervals.
- A graph database was evaluated against PostgreSQL for genealogy, and a benchmark was run in this environment.

## Decision

1. PostgreSQL 16+ is the only system of record for every GMP database (ADR-0001).
2. **Genealogy** is an insert-only link table (link type, quantity and unit, batch, step execution, recorded time and person). A mistaken link is neutralised by an appended reversal link; traces ignore reversed links by default and an "as recorded" mode shows both. A CHECK forbids self-links.
3. Two covering B-tree indexes, `(from, to)` and `(to, from)`. Traversal uses `WITH RECURSIVE ... UNION` (set semantics, never `UNION ALL`), a hard depth guard, the `CYCLE` clause and a `statement_timeout` per query class.
4. All callers use one `GenealogyService` (`traceForward`, `traceBackward`, `recallScope(asOf)`). A recall or impact result is itself a GMP record: lot IDs, as-of point, query-definition version and SHA-256 of the sorted result, signed by QA.
5. **MBR flows** are in-memory graphs in the domain layer (ADR-0004), persisted as immutable, hashed JSON plus normalised where-used rows.
6. **Time-interval questions** (occupancy, calibration validity, EM windows) use range types with GiST indexes and EXCLUDE constraints.
7. A graph database is acceptable later only as a rebuildable, outbox-fed, non-GMP analytics copy. A GMP decision prompted by it is confirmed against `GenealogyService` and the confirmation recorded.
8. Cross-edition and cross-site tracing is a federated call to each installation's `recallScope` with an as-of point.

## Benchmark

Setup (architecture research 1.5): PostgreSQL 16.13, 4 vCPU, 15 GB RAM, shared_buffers 4 GB. Synthetic, deliberately hub-heavy tablet genealogy for a large company (about 20 sites over 15 years): 9.73 M lots and 20.0 M links; the worst hub excipient lot is consumed by about 2,600 batches. Link table 845 MB heap, 2.05 GB with both indexes; queries run as index-only scans.

| Query (warm cache unless noted) | avg | p95 | max | nodes reached (avg / max) |
|---|---|---|---|---|
| Backward trace from a random packed lot (300 runs) | 0.03 ms | 0.05 ms | 0.30 ms | 14.7 / 21 |
| Forward trace from a random API lot | 0.30 ms | 0.39 ms | 0.74 ms | 128 / 190 |
| Forward trace from a random excipient lot | 0.83 ms | 2.18 ms | 10.45 ms | 475 / 7,389 |
| Forward trace from a random packaging-component lot | 0.56 ms | 1.40 ms | 1.63 ms | 367 / 1,143 |
| Forward trace from each of the 10 worst hub lots | 46.2 ms | 47.8 ms | 48.0 ms | 38,448 / 38,838 |
| Supplier recall: 20 consecutive lots of the most used excipient | 863 ms | - | - | 447,139 |
| Cold start: backward / API forward / worst hub | 6.5 / 1.8 / 43.5 ms | - | - | 15 / 134 / 38,513 |
| Pathological 10,000-level linear chain | 9.1 ms | - | - | 10,001 |

- Throughput with 4 clients: about 29,000 backward traces/s (0.14 ms latency) and about 1,570 forward traces/s from random excipient lots including hubs (2.55 ms).
- `UNION ALL` returned 39,220 rows for 38,514 distinct nodes on the worst hub. On data with many split/merge diamonds it grows combinatorially and never terminates on a cycle, so set semantics are mandatory.
- Exporting all 20 M links (the cost of rebuilding an external projection) took 1.9 s (binary COPY) to 8.0 s (text COPY).
- Audit write cost (architecture research 5.1): about 10,500 commits/s without the audit trigger (0.76 ms) and about 6,000 commits/s with a trigger writing the audit row and extending a SHA-256 chain (1.34 ms), i.e. about 0.6 ms added per write; worst case, eight clients writing into one batch's chain, about 1,450 commits/s (5.5 ms).

## Consequences

### Positive

- One qualified database platform; genealogy, audit and business rows commit in the same transaction under the same constraints and privileges.
- Recall-grade questions return in under a second and single-lot backward traces in well under a millisecond on 4 vCPUs, inside the proposed SLOs (backward trace under 50 ms, supplier recall under 5 s).
- Mature backup, PITR and HA tooling, mainstream skills at pharma sites, and open export formats for long retention.

### Negative

- Recursive SQL needs discipline: set semantics, depth guards and cycle clauses are mandatory and must be enforced by review and tests.
- Hub lots produce large result sets (about 38,000 nodes), so recall screens need paging and stored results.
- No native graph analytics (centrality, community detection) in v1.
- Performance relies on index-only scans; `tools/bench/` is re-run when the link schema or the PostgreSQL major version changes.

## Alternatives considered

- **Apache AGE on PostgreSQL.** Rejected: graph data lives in AGE label tables outside normal FK/CHECK modelling, the extension must be qualified and patched in step with PostgreSQL majors, some managed services do not offer it, and community reports describe variable-length path queries slowing sharply.
- **Neo4j as primary store.** Rejected: limited declarative constraints; online backup, clustering and role-based access only in the Enterprise edition; a second validated platform; rare GMP skills.
- **Neo4j as a read-only projection.** Allowed later for non-GMP analytics only (item 7).
- **In-memory genealogy graph in the application.** Rejected for genealogy (a cache to keep consistent, about 0.3 GB per 20 M links); adopted for MBR flows.
- **Specialised ledger database.** Rejected: lifecycle risk for records kept for decades (AWS ended QLDB support on 31 July 2025).

## Related controls and invariants

- Controls: PR-57 (genealogy and lot traceability), IN-29 (complaints, recalls and genealogy queries), DI-22 and DI-23 (audit trail in the same store), DI-44 to DI-47 (integrity checking, backup, archiving, retention).
- Invariants: INV-06, INV-12 (EXCLUDE on PROCESS-equipment occupancy), INV-14, INV-33.

## References

- Build outline v0.2: sections 1 (Stack), 4.4, 4.5, 6.5 (where-used), 12 risk 6.
- Architecture research: 1.1-1.7 (graph question and benchmark), 5.1 (audit feasibility probe), 6.2, 6.6 (SLOs).
