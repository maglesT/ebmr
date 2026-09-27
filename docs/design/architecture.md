# eBMR architecture design research: Tablets edition and Injectables edition

Status: design research, not application code. Author role: software architect. Date: 2026-09-27.
Scope: two independent products (TABLETS eBMR and INJECTABLES eBMR) that share one internal
"compliance kernel" library. Regulations in scope: US FDA (21 CFR 210/211, Part 11, FDA guidance
including the Data Integrity Q&A of Dec 2018, Part 11 Scope and Application of 2003, and the CSA
guidance of Sept 2025 as informative only) and EU (EudraLex Vol 4 Chapters 1/4/5, Annex 1, Annex 11
of 2011 plus the July 2025 draft, Annex 15, Annex 16, EMA Q&As), plus ICH Q9(R1), Q10 and Q12.

Companion files in this folder (earlier research, reused here and not repeated):
`configurability.jsonl` (vendor patterns, 40+ building blocks, engine guardrails),
`intl-annex11-pics.jsonl` (Annex 11 2011 and 2025 draft), `intl-eu-ch4-ch5.jsonl` (EU Ch.4/5),
`sample-bmr-analysis.md` (coverage test built from a paper BMR).

Conventions: MUST = required for correctness or compliance and never configurable away;
SHOULD = strong default; MAY = option. "Kernel" = the shared compliance library; "edition" =
the Tablets or the Injectables product. Evidence is marked [E] (external source, listed in the
Sources section), [B] (benchmark measured in this session, reproducible scripts under
`scratchpad/bench/`) or [D] (domain/architectural reasoning, to be confirmed in validation).
Primary regulator sites were not reachable from this environment; regulatory statements rest on
the companion research files and search-engine summaries, paraphrased.

## 0. Executive summary (verdicts)

1. Graph question: do NOT use a graph database as the system of record. Use PostgreSQL as the
   single system of record, model lot genealogy as an append-only edge table with foreign
   keys and both-direction covering indexes, and answer traversal questions with recursive
   CTEs (set semantics, UNION not UNION ALL) behind a small `GenealogyService` (measured on
   9.7 M lots / 20 M links: 0.03 ms backward trace, <= 50 ms worst forward hub, < 1 s for a
   20-lot supplier recall on 4 vCPUs). Keep MBR flow graphs as in-memory structures in the
   domain layer (they are small and versioned as immutable JSON documents). A read-only graph
   projection (e.g. Neo4j) is an optional, later, non-GxP analytics add-on only if a customer
   asks for graph data science. Details and measurements in section 1.
2. MBR designer: ISA-88 procedure / unit procedure / operation / phase, drawn as an ISA-88 PFC
   (Procedure Function Chart) with typed, edition-specific phase blocks; statically verified as a
   sound, block-structured workflow before it can be submitted for approval.
3. Stack: TypeScript end to end (Node LTS: 22 in this container, 24 in production; Fastify, Zod,
   PostgreSQL 16+, Kysely + hand-written SQL migrations, React + Vite, XState v5 for machines,
   fast-check, Vitest, Playwright, StrykerJS), pnpm workspace with `packages/kernel`,
   `packages/expr`, `packages/recipe-core`, `apps/tablets-server|web`,
   `apps/injectables-server|web`, each edition with its own database. Details in section 7.

---

## 1. Is a graph data structure or a graph database a good idea?

Short answer: graph-shaped *algorithms* yes, a graph *database* as system of record no.
The eBMR is first of all a regulated record-keeping system whose data is mostly tabular
(parameter values, IPC readings, weighings, calculations, signatures, audit entries, status
changes). Only a few sub-problems are graph-shaped, and at pharma scale they are shallow graphs
that a relational engine traverses in milliseconds (measured below).

### 1.1 What the system of record must guarantee (these drive the decision)

| Need | Why it matters here | What it demands from the store |
|---|---|---|
| Multi-entity ACID transactions | One operator action (e.g. a dispensing weighing) must atomically write the reading, the lot quantity change, the genealogy link, the step state, the audit entries, the signature binding and the outbox event. Partial writes are data-integrity failures. | Serializable/repeatable-read transactions across many tables, row locks, savepoints. |
| Declarative integrity constraints | "No loopholes" means the database itself must reject impossible states even if application code has a bug: FK, UNIQUE, CHECK, NOT NULL, deferred constraints, EXCLUDE (e.g. one equipment unit cannot be occupied by two batches in overlapping time ranges). | Rich constraint language at DB level. |
| Tamper-evident, DB-protected audit trail | Part 11 11.10(e), Annex 11 s.9 and the 2025 draft: always on, not editable, not switchable off. | Triggers that fire in the same transaction, privilege separation (REVOKE UPDATE/DELETE, security-definer functions, row-level security), hash chaining. |
| Backup, PITR, verified restore, DR | Annex 11 s.7 (and draft: separate, regularly restore-tested backups). | Online physical backups + WAL archiving, point-in-time recovery, streaming replicas; mature tooling (pgBackRest, Barman). |
| Reporting and true copies | QA review, inspections, regulators asking for readable copies with metadata; BI. | SQL, views, standard drivers, export to open formats (PDF/A + JSON/CSV). |
| Validation burden (GAMP 5 / CSA) | Every data store holding GxP data must be qualified, monitored, backed up consistently and included in periodic review. | As few stores as possible; widely used engines with known qualification patterns. |
| Long retention | EU: longer of expiry+1 y or certification+5 y; US 211.180: at least 1 y after expiry (and 3 y after distribution for certain OTC products without expiry). Records must stay readable across system upgrades. | Stable, open, widely supported data format; migration tooling. |
| Skills in pharma IT | Sites run Oracle, SQL Server and increasingly PostgreSQL; graph DB skills are rare in GxP operations teams. | Mainstream DBMS. |

### 1.2 The graph-shaped sub-problems, sized honestly

| Sub-problem | Typical size | Query shape | Best representation |
|---|---|---|---|
| Lot genealogy, forward/backward trace, recall scope | 10^6-10^7 lots per edition-installation over a retention period, 10^7-10^8 links; but only 4-8 hops deep (raw material -> intermediate(s) -> bulk -> packed lot -> shipment; injectables: API -> compounded bulk -> filtered bulk -> filled units -> lyophilised -> inspected -> packed -> shipment) | Reachability set from a start node, occasionally with depth/path | Relational edge table + recursive CTE (measured in 1.5) |
| MBR procedure flow (ISA-88 PFC: sequence, alternative and parallel branches, declared loops) | 10^1-10^3 nodes per MBR version; immutable once approved | Validation (cycles, reachability, soundness), simulation, execution cursor | In-memory graph in the domain layer; persisted as an immutable, hashed JSON document plus normalized index rows |
| ISA-88 procedural hierarchy (procedure / unit procedure / operation / phase) and ISA-88/95 physical model (enterprise / site / area / process cell / unit / equipment module) | Trees of 10^2-10^5 nodes | Subtree, ancestors | Adjacency list + `ltree` path or closure table |
| Where-used (material, equipment class, building block, parameter, SOP, Established Condition -> MBR versions -> open batches) | Bipartite, depth 1-3 (library blocks can nest) | "Which effective MBRs / in-flight batches use X?" | Link tables written at MBR approval; recursive CTE for nested blocks |
| Deviation / event impact analysis | Joins of time intervals (equipment occupancy, room occupancy, calibration validity, EM excursion windows) with genealogy | "Which batches used equipment E between last good calibration and now, and where did their output go?" | Range types with GiST indexes and EXCLUDE constraints (a relational strength) + genealogy traversal |

Conclusion from sizing: the only large graph (genealogy) is shallow; the deep/complex graphs
(MBR flows) are tiny. Neither needs a graph engine.

### 1.3 Options compared

| Criterion | A. PostgreSQL edge tables + recursive CTE | B. PostgreSQL + Apache AGE | C. Neo4j as primary store | D. Neo4j as read-only projection | E. In-memory graph in app |
|---|---|---|---|---|---|
| ACID across all eBMR data | Yes, one store | Yes (same PG), but graph lives in AGE's own label tables with `agtype` values, outside normal FK/CHECK modelling | ACID, but the majority tabular data would also have to live there, or in a second store (then no cross-store atomicity) | N/A (not SoR); eventual consistency via outbox | N/A (cache) |
| Declarative constraints | Full (FK, CHECK, EXCLUDE, deferrable) | Only for relational part | Limited to uniqueness/existence/key-type rules, several of them Enterprise-only; no general CHECK/FK equivalents [E] | N/A | N/A |
| Audit trail protection at DB level | Triggers + privileges + RLS + hash chain | Same for relational part; AGE mutations via Cypher need their own triggers on internal tables | Would be application-enforced; DB-level immutability not a native concept | N/A | N/A |
| Backup / PITR / HA | Mature, free (pgBackRest, streaming replication) | Same as PG, but managed availability: Azure offers AGE (GA 2025, reported up to PG16), AWS RDS/Aurora do not list it [E] | Online backup, clustering and role-based access control are Enterprise-only; Community has no RBAC (every user has the same rights) and backs up by offline dump [E] | Second system to run; rebuildable from SoR | Rebuilt on start |
| Traversal performance at our scale | 0.03 ms (backward) to 45 ms (worst hub) warm; see 1.5 [B] | Community reports of variable-length path queries slowing sharply with path length, and of recursive CTEs beating AGE by large factors in some cases [E] | Best for deep traversals (pointer hops), irrelevant at <= 8 hops [D] | Same as C | Fastest (microseconds) [D]; but a cache to keep consistent, ~0.3 GB per 20 M edges |
| Validation (GAMP 5 / CSA) burden | One qualified DB platform | Extra extension to qualify and patch in lock-step with PG majors | Second DB platform to qualify; niche skills | If any GxP decision (e.g. recall scope) is taken from it, it must be validated too, plus a reconciliation control proving completeness | Low for MBR graphs (pure functions, unit-tested) |
| Licensing / vendor risk | PostgreSQL licence | Apache 2.0 | GPLv3 Community / commercial Enterprise | same | none |
| Verdict | **Recommended SoR** | Reject (no benefit, adds risk, not on AWS managed PG) | Reject | Optional later, non-GxP analytics only | **Use for MBR flows**, not for genealogy |

### 1.4 Real-world evidence of how the industry stores this

- Siemens Opcenter Execution Pharma offers forward/backward genealogy and runs on Oracle or
  Microsoft SQL Server database servers [E: Siemens fact sheet].
- Emerson Syncade (DeltaV MES) runs on SQL Server; job postings for Syncade specialists ask for
  expert SQL Server skills [E].
- SAP ECC keeps the batch where-used list in the relational table CHVW (built by report MB57,
  displayed top-down or bottom-up with MB56 / batch information cockpit); SAP's cross-system
  product SAP Global Batch Traceability aggregates batch relationships from SAP and non-SAP
  systems into one traceability store for recall analysis [E]. Pattern: genealogy = relational
  link records; cross-system tracing = a separate aggregating service.
- Körber PAS-X (installed at a majority of the top-30 pharma companies according to vendor-derived
  summaries) ships genealogy and traceability modules; PAS-X support job postings ask for Oracle
  database, JBoss (JVM) and Citrix administration, i.e. a relational Oracle back end [E, indirect].
- Rockwell FactoryTalk PharmaSuite job and project descriptions list Oracle and SQL Server as the
  RDBMS skills needed [E, indirect]. No major pharma MES/eBR vendor found uses a graph database
  as its batch-record store.
- Graph databases in this industry appear as analytics layers: Boston Scientific (medical
  devices) adopted Neo4j to analyse a complex multi-site manufacturing supply chain for defect
  root causes, replacing spreadsheet analysis [E: Neo4j customer story]. That is a read model, not
  the batch record.
- Lifecycle risk of specialised stores: AWS ended support for its ledger database QLDB on
  31 July 2025 and pointed customers to Aurora PostgreSQL [E]. For records that must stay
  readable for many years, a mainstream RDBMS with open export formats is the safer home.

### 1.5 Benchmark in this environment [B]

Setup: PostgreSQL 16.13, 4 vCPU, 15 GB RAM, shared_buffers 4 GB. Synthetic but deliberately
hub-heavy tablet genealogy for a large multi-site company (roughly 20 sites x 15 years):
600 k manufacturing batches (500 products, skewed popularity), each with a granulate lot and a
bulk lot; 1 API + 6 excipients at granulation, 2 blend/coating excipients at bulk; 3 % of batches
take rework from the previous batch of the same product (creates diamonds and longer chains);
each bulk lot packed into 1-4 packed lots with 4 packaging components; each packed lot shipped
in 1-8 shipments. Excipient lot sizes are skewed so that the worst "hub" lot (a lubricant-like
material) is consumed by ~2,600 batches. Totals: 9.73 M nodes (75 k API lots, 114 k excipient
lots, 91 k packaging-component lots, 600 k granulate, 600 k bulk, 1.50 M packed lots,
6.75 M shipments) and 20.0 M edges. Edge table 845 MB heap, 2.05 GB with the two covering
B-tree indexes `(src,dst)` and `(dst,src)`. Queries use `WITH RECURSIVE ... UNION` (set
semantics) and index-only scans (0 heap fetches). Scripts: `scratchpad/bench/gen.sql`,
`bench.sql`, `cold.sql`, `pgb_*.sql`.

| Query (warm cache unless noted) | Runs | avg ms | p95 ms | max ms | nodes reached (avg / max) |
|---|---|---|---|---|---|
| Backward trace from a random packed lot (all ancestors) | 300 | 0.03 | 0.05 | 0.30 | 14.7 / 21 |
| Forward trace from a random API lot | 100 | 0.30 | 0.39 | 0.74 | 128 / 190 |
| Forward trace from a random excipient lot | 100 | 0.83 | 2.18 | 10.45 | 475 / 7,389 |
| Forward trace from a random packaging component lot | 100 | 0.56 | 1.40 | 1.63 | 367 / 1,143 |
| Forward trace from each of the 10 worst hub lots | 10 | 46.2 | 47.8 | 48.0 | 38,448 / 38,838 |
| Supplier-level recall: 20 consecutive lots of the most used excipient | 1 | 863 | - | - | 447,139 |
| Cold start (PG restarted, OS cache dropped): backward trace / API forward / worst hub | 1 each | 6.5 / 1.8 / 43.5 | - | - | 15 / 134 / 38,513 |
| Pathological 10,000-level linear chain (e.g. corrupt rework history) | 1 | 9.1 | - | - | 10,001 |
| Throughput, 4 clients, backward traces (pgbench, 15 s) | 434 k | 0.14 latency | - | - | ~29,000 traces/s |
| Throughput, 4 clients, forward traces from random excipient lots incl. hubs | 23.5 k | 2.55 latency | - | - | ~1,570 traces/s |

Worst hub breakdown: 2,624 bulk lots, 56 granulate lots (via rework), 6,516 packed lots,
29,317 shipments. `UNION ALL` instead of `UNION` returned 39,220 rows for 38,514 distinct
nodes on that hub (paths, not nodes); harmless here, but on topologies with many split/merge
diamonds it grows combinatorially and it never terminates on a cyclic data error, so set
semantics are mandatory. A full export of all 20 M edges (the cost of rebuilding an external
projection or an in-memory copy) took 1.9 s (binary COPY) to 8.0 s (text COPY).

Interpretation: recall-grade questions return in well under a second on a 4-vCPU box, and
single-batch backward traces (QA review, complaint investigation) in microseconds. The main
advantage of native graph engines (deep multi-hop traversal) never comes into play because drug
product genealogy is shallow. A graph store would add a second validated platform, a
consistency problem and skills risk for no measurable gain.

### 1.6 Design rules for graph-shaped data in PostgreSQL

1. `lot_link` edge table (per edition database): `id`, `from_lot_id` FK, `to_lot_id` FK,
   `link_type` (CONSUMED_INTO, SPLIT_INTO, MERGED_INTO, REWORKED_INTO, RELABELLED_AS,
   REPACKED_INTO), `quantity` + `uom`, `batch_id`, `step_execution_id`,
   `recorded_at`, `recorded_by`, `reversed_by_link_id` (nullable). Written only by domain
   commands (a consumption recorded in a step); never updated or deleted; a mistaken link is
   neutralised by an appended reversal link, and traces ignore reversed links by default
   while an "as recorded" mode shows both. CHECK `from_lot_id <> to_lot_id`. Distribution
   (packed lot -> customer shipment) is owned by ERP/WMS and imported into `shipment_line`,
   which the recall query joins as the last hop (the benchmark modelled it as edges).
2. Two covering indexes `(from_lot_id, to_lot_id)` and `(to_lot_id, from_lot_id)`, optionally
   `INCLUDE (link_type)`.
3. Traversal queries: recursive part projects only the node id (`UNION`, not `UNION ALL`);
   depth via `min(depth)` in a second pass; hard depth guard (e.g. 64) and PostgreSQL 14+
   `CYCLE` clause as defence against corrupt data; `statement_timeout` per query class.
4. All callers go through `GenealogyService.traceForward/traceBackward/recallScope(asOf)`, so an
   optional projection could be swapped in later without changing callers.
5. A recall or impact assessment result is itself a GxP record: persist the result set (lot ids,
   as-of transaction timestamp/LSN, query definition version, SHA-256 of the sorted result),
   signed by QA, so it can be reproduced and inspected.
6. `supplier_lot` is its own entity: one supplier lot delivered to several sites becomes several
   internal lots linked by SAME_SUPPLIER_LOT, which makes supplier-level recalls one query.
   Cross-edition tracing (e.g. one excipient supplier lot used by both the Tablets and the
   Injectables product) is a federation call: each edition exposes `recallScope` via its API
   and an enterprise recall coordinator (or ERP/SAP GBT) merges results.
7. Time-interval questions use range types: `equipment_occupancy(equipment_id, batch_id,
   during tstzrange, EXCLUDE USING gist (equipment_id WITH =, during WITH &&))`, room
   occupancy, calibration validity and EM excursion windows, so "which batches used this unit
   while it was out of calibration" is one indexed overlap join.
8. MBR flows are graphs in memory (domain layer): cycle detection (Tarjan SCC), reachability,
   post-dominator checks and simulation are O(V+E) on at most a few thousand nodes, i.e.
   microseconds; the persisted form is an immutable JSON document with a content hash, plus
   normalized `mbr_where_used` rows for queries.

### 1.7 Verdict

- PostgreSQL is the single system of record for each edition. Genealogy = append-only edge
  table + recursive CTEs (measured: 0.03 ms backward, <= 50 ms for the worst forward hub,
  < 1 s for a 20-lot supplier recall at 9.7 M nodes / 20 M edges on 4 vCPUs).
- The MBR flow is a graph in the application (typed DAG with declared loops), validated and
  executed by a pure TypeScript flow engine; persisted as immutable versioned JSON.
- Do not adopt Apache AGE (no gain, managed-service gaps, reported variable-length path issues)
  or Neo4j as primary (weak declarative constraints, Enterprise-only backup/RBAC/clustering,
  second validated platform, rare skills).
- Keep the door open: an outbox-fed, rebuildable graph projection (Neo4j or similar) is an
  acceptable later add-on for non-GxP network analytics (supplier risk, root-cause exploration).
  If it is ever used for a GxP decision, the decision must be confirmed against the SoR
  (`GenealogyService`) and the confirmation recorded.

---

## 2. MBR designer configuration model (per edition)

### 2.1 ISA-88 mapping

ISA-88 recipe content has four parts (header, formula, equipment requirements, procedure) and
four recipe types (general, site, master, control) [E: companion file, isa88 findings]. Mapping:

| ISA-88 concept | eBMR concept | Notes |
|---|---|---|
| General / site recipe | `ProcessTemplate` (optional, per product family; equipment-independent) | Lets one validated process design serve many products (Körber's Generic MBR idea: variants as parameter sets, not copies). |
| Master recipe | `MbrVersion` = header + `Formula` (BOM lines with scaling rules) + `EquipmentRequirement`s (equipment classes / capabilities) + `ProcedureDefinition` (flow) + `ParameterSet` (values and limits) | Approved, effective, site/line and batch-size-range specific. |
| Control recipe | `IssuedBatchRecord` = frozen snapshot of the pinned `MbrVersion` with batch-specific header (batch no., size, scaled quantities, dates, resolved variant branches) and its SHA-256 | 211.188(a): accurate reproduction of the master, produced by a validated copy mechanism instead of a manual check. |
| Procedure | The whole MBR flow | One per MBR version. |
| Unit procedure | `Stage` bound to one unit/room/equipment train (e.g. Dispensing, Granulation, Compression, Coating, Packaging; Compounding, Filtration, Filling, Lyophilisation, Inspection) | Carries line clearance, room/equipment binding, stage yield/reconciliation, stage sign-off. |
| Operation | `Operation` = coherent group of phases (e.g. "Dry to LOD endpoint") | Unit of review and of time limits. |
| Phase | `Phase` = one typed building block instance (Weigh, Charge, RecordParameter, IPC test, Timer, Verification, QA hold...) | Smallest executable element; each has a typed config and a typed data record. |
| Procedure Function Chart (ISA-88 Part 2) | The designer's graphical notation: sequence, simultaneous (parallel) and selective (alternative) branches, loops | Shown as PFC; stored as a block-structured tree (2.2). |
| Batch production record (ISA-88 Part 4) | `BatchRecord` + `StepExecution` + `DataPoint` + audit trail | See section 3. |

### 2.2 Flow representation: block-structured PFC, compiled to a graph

Design choice: the designer draws a PFC, but the persisted model is a **block-structured tree**
(every split has exactly one matching join, loops are explicit blocks). Free-form "goto" edges
are not allowed. Rationale: block-structured workflows are sound by construction with local
checks (no deadlock, no lack of synchronisation, no orphan branches), they are easier to
review, and every paper-BMR idiom seen in the sample ("redry and repeat stage 6.0", "if
necessary add extra IPA") maps to a loop or an alternative block. Soundness is the formal
target: from every reachable state the batch can still reach completion, completion leaves no
active branch behind, and every step is executable on some path (the three workflow-net
soundness properties of van der Aalst) [E].

```ts
// Persisted AST (JSON, immutable after submission). Illustrative design, not application code.
type Node =
  | { kind: 'sequence'; id: NodeId; children: Node[] }
  | { kind: 'parallel'; id: NodeId; branches: Node[]; join: 'ALL';           // AND-split / AND-join only
      maxSkew?: Duration }                                                  // optional limit between branch ends
  | { kind: 'alternative'; id: NodeId; decision: 'DATA' | 'OPERATOR_CHOICE' | 'VARIANT_AT_ISSUE';
      branches: { label: string; guard: Expr | 'ELSE'; body: Node }[];
      choiceRoles?: RoleId[]; reasonRequired?: boolean }                    // OPERATOR_CHOICE only
  | { kind: 'loop'; id: NodeId; body: Node; exitWhen: Expr;                 // evaluated after each iteration
      maxIterations: number; maxDuration?: Duration;
      onExhausted: 'EXCEPTION_AND_BLOCK' | 'EXCEPTION_AND_QA_GATE';
      endpointParameter: ParamRef }                                         // must be a process endpoint, not a release test
  | { kind: 'holdPoint'; id: NodeId; gate: 'QA_RELEASE' | 'SUPERVISOR';
      evidence: EvidenceRef[]; dispositions: ('CONTINUE' | 'CONTINUE_WITH_CONDITIONS' | 'REJECT' | 'HOLD')[] }
  | { kind: 'call'; id: NodeId; element: { id: LibraryElementId; version: number }; bindings: Record<string, Expr> }
  | { kind: 'phase'; id: NodeId; block: { type: BlockTypeCode; version: number }; config: unknown /* validated by the block's Zod schema */;
      signatures: SignatureRequirement[]; entryMode: 'MANUAL' | 'INSTRUMENT' | 'AUTOMATION' };

type Stage = { id; name; unitClass: EquipmentClassRef | RoomClassRef; body: Node; lineClearance: 'REQUIRED'; yield?: YieldSpec };
type TimeConstraint = { id; from: { node: NodeId; event: 'STARTED' | 'COMPLETED' }; to: { node: NodeId; event: 'STARTED' | 'COMPLETED' };
  min?: Duration; max?: Duration; alertBefore?: Duration; onViolation: 'EXCEPTION' | 'EXCEPTION_AND_BLOCK'; sourceRef: DocRef };
type SignatureMeaning = 'AUTHORED' | 'PERFORMED' | 'VERIFIED' | 'WITNESSED' | 'REVIEWED' | 'APPROVED'
  | 'ISSUED' | 'RELEASED' | 'CERTIFIED' | 'REJECTED';                        // closed vocabulary, shown at signing
type SignatureRequirement = { meaning: SignatureMeaning; roles: RoleId[];
  distinctFrom?: SignatureMeaning[]; qualificationRequired?: QualificationCode[] };
```

- Parallel: AND-join only. OR-joins/discriminators are excluded because they make soundness
  and reviewer understanding much harder; an optional branch is an `alternative` inside a
  parallel branch.
- Alternative: DATA guards evaluate recorded values; OPERATOR_CHOICE records who chose, why,
  and requires an allowed role; VARIANT_AT_ISSUE is resolved when the record is issued (e.g.
  coating colour for this pack variant), so the issued record contains only the resolved path.
  Untaken branches are marked NOT_APPLICABLE by the engine, never by a user.
- Loop: every iteration is a new set of step executions with `iteration = n`; data from earlier
  iterations is kept and shown; `maxIterations` is mandatory; exhausting it always raises an
  exception. Loops are only allowed on parameters classified as process endpoints (LOD, pH
  adjustment, coating weight gain), never on release/acceptance tests, which follow the OOS
  procedure instead (companion file, Loop block).
- Hold point: all downstream nodes are blocked until an authorised disposition is signed.
- Time limits are a separate constraint list over node events, so they can span operations,
  stages and even batches (e.g. dirty-equipment hold, bulk hold, compounding start to end of
  filtration, filtration end to fill end). This is a Simple Temporal Network over events; the
  validator checks it is consistent (no negative cycle in the min/max distance graph).
  Semantics: a constraint whose start or end node lies in an untaken alternative branch is void
  for that batch; a constraint inside a loop body applies per iteration; a constraint from inside
  a loop to a node after it measures from the last iteration.
- Exceptions are not modelled as goto edges: each phase type defines exception events
  (limit excursion, missing verification, time-limit breach, equipment status failure); the
  kernel turns them into `Exception` records with a disposition workflow. A batch can always
  be put ON_HOLD or ABORTED by authorised roles, outside the flow.
- Reprocessing/rework (211.115, EU 5.62-5.67): only via a separately approved
  `ReprocessingProcedure` (its own MBR-like definition) invoked by a QA decision, never as a
  hidden loop.

Compilation: the tree is compiled into an execution graph (nodes, edges, split/join pairs,
loop back-edges flagged `isLoopBack`) used for visualisation, validation and execution.

### 2.3 Static validation before submission (designer "Check" and server-side gate)

The same validator package runs live in the designer and authoritatively on the server; a
version cannot move DRAFT -> IN_REVIEW with any ERROR, and every WARNING needs a recorded
justification that reviewers see. (Körber reports more than 50 automated plausibility checks
on MBRs; this is the same idea made explicit.) [E]

Structural (on the compiled graph, defence in depth even though the tree makes most of them true by construction):
- S1 exactly one start and one end; S2 every node reachable from start; S3 every node can reach
  end (co-reachability); S4 the only cycles are declared loop back-edges (Tarjan SCC: every
  non-trivial SCC contains exactly one loop back-edge and equals that loop's body); S5 every
  split has a matching join that post-dominates it; S6 no edge crosses a parallel or loop
  boundary; S7 every loop has `maxIterations >= 1` and an `exitWhen` that reads at least one
  value written inside the body; S8 time constraints form a consistent temporal network.
Data flow and expressions:
- D1 definite assignment: every variable read (guard, calculation, limit, bindings) is written
  on all paths before the read (forward data-flow analysis; loop-body values read after the loop
  use the last iteration); D2 all expressions parse, type-check and unit-check; D3 the
  calculation dependency graph is acyclic; D4 alternative guards are exhaustive (an ELSE branch,
  or proven complete by interval analysis for numeric guards) and mutually exclusive; D5 no two
  parallel branches write the same variable or claim the same exclusive equipment/material
  lot without a sequencing constraint.
GMP content rules:
- G1 every BOM line is consumed on every completing path (or is flagged optional with
  justification); G2 every stage that uses a room/line starts with line clearance and ends with
  a stage yield/reconciliation; G3 every equipment use is preceded by an equipment status check
  (clean, calibrated, qualified, not expired hold); G4 phases on critical parameters (CPP, CQA
  inputs) have limits with a source reference and a verification rule; G5 time limits reference
  an approved study; G6 signature requirements: VERIFIED/WITNESSED must be distinct from
  PERFORMED; G7 every element flagged as an ICH Q12 Established Condition has a reporting
  category; G8 loops only on endpoint parameters; G9 the procedure ends with the batch record
  review sections; G10 all referenced blocks, library elements, SOPs, materials and equipment
  classes are EFFECTIVE (no references to draft or retired items).
Edition rules (examples): Tablets: compression stage has a tooling/punch check and an IPC
schedule; coating stage computes weight gain. Injectables: filling stage binds an EM plan and
requires aseptic gowning qualification and a line with a valid media-fill status; sterile
filtration has pre-use and post-use filter integrity tests (pre-use post-sterilisation test per
contamination control strategy); terminal sterilisation or lyophilisation cycles are captured
from the equipment record; 100 % visual inspection block present; hold-time constraints for
bioburden, sterile bulk and fill duration exist.

### 2.4 Execution semantics (server-authoritative)

- The flow engine is a pure function `step(state, command, clock) -> (newState, events)` over the
  compiled graph, with Petri-net-like tokens: a batch has a set of active node positions;
  `parallel` forks one token per branch, the AND-join waits for all; `alternative` evaluates
  guards once, records the decision (inputs, expression hash, result) and moves one token;
  `loop` re-instantiates the body with `iteration+1` while `exitWhen` is false.
- Commands come from the UI (StartStep, RecordValue, Sign, Correct, Skip, RequestHold...) and
  from integrations (scale readings, SCADA cycle reports, LIMS results). Each command is
  validated by the shared domain code on the server, inside one DB transaction, with an
  idempotency key (section 5).
- Timers: time constraints become rows in `timer` (due_at, kind, batch, constraint id); a
  worker fires alerts and violations; durations are always computed from server timestamps.
- Only steps whose token is present are ENABLED; a user cannot start a step early, and the UI is
  a projection of engine state, never the authority.

### 2.5 Parameter definitions and limits

`ParameterDefinition` (library, versioned) -> `ParameterUse` (in an MBR phase):
- identity: `code`, `name`, `dataType` (QUANTITY, NUMBER, INTEGER_COUNT, BOOLEAN, ENUM, TEXT,
  DATETIME, DURATION), `ucumUnit` (UCUM code, e.g. `mg`, `kg`, `Cel`, `%`, `kPa`, `min`,
  `[pH]`), `dimension` derived from the unit.
- precision: `storedScale` (full precision decimal), `reportedDecimals` or
  `reportedSignificantFigures`, `roundingRule` (`USP_HALF_UP_AT_LIMIT_DECIMALS` or
  `PH_EUR_SIG_FIGS`; USP rounds half-up to the limit's decimal places only at the comparison
  step, Ph. Eur. rounds to the limit's significant figures) [E: companion file].
- limits (`LimitSet`, all optional but ordered): `target`; `alertLow/High` (NOR, notify and
  comment); `actionLow/High` (PAR or registered range: exception, deviation, and block or QA
  decision); `specLow/High` for IPC tests; each bound has `inclusive: boolean`.
  Invariant: `actionLow <= alertLow <= target <= alertHigh <= actionHigh`, and action range
  inside the registered range when an EC applies.
- classification: `criticality` (CPP, CQA, KPP, NON_CRITICAL); `establishedCondition`
  (boolean + `reportingCategory`: US PAS / CBE-30 / CBE-0 / annual report; EU type II / IB /
  IA; + `ecSourceRef`); `sourceRef` (validation report, registration section).
- capture: `entryMode` (MANUAL, INSTRUMENT with instrument class, AUTOMATION tag),
  `verification` (NONE, SECOND_PERSON, INSTRUMENT_INTERFACE_VALIDATED), `readings`
  (single, n readings with statistics mean/min/max/RSD, multi-channel e.g. left/right press side),
  `schedule` (once, every N minutes/units with overdue alert) for periodic IPCs.
- behaviour on excursion is fixed by the kernel: alert -> comment mandatory; action -> exception
  + deviation link; configuration may add blocking, never remove the exception.

### 2.6 Safe expression language (`packages/expr`)

Requirements: pure, deterministic, always terminates, no I/O, no user-defined functions or
recursion, decimal arithmetic (never binary floating point for GMP values), dimension/unit
checked, explicit rounding only, explicit null handling (a missing input is an evaluation error
unless the expression uses `coalesce`), identical results in browser (preview) and server
(authoritative).

Options considered: (a) CEL (Common Expression Language): designed to be non-Turing complete
and safe to embed, with JS/TS implementations (`cel-js`, `libcel-ts`) [E]; but numbers are
int/uint/double and it has no units, so it would need a decimal type and a unit layer bolted on.
(b) math.js: has units and big numbers but a large general-purpose surface to lock down. (c)
A small purpose-built language. **Recommendation: (c)** with CEL-like syntax for
familiarity: a hand-written Pratt parser -> AST -> type and unit checker -> evaluator on
`decimal.js` (configured to 34 significant digits), units via UCUM (`@lhncbc/ucum-lhc` for validation and
conversion factors, cached into a table at build time) [E]. Rationale: calculations in an
electronic master record are a validated intended use in FDA's Data Integrity Q&A (companion
file), so a tiny, fully specified, exhaustively tested language is cheaper to validate than a
locked-down general one.

Language surface: literals with units (`12.5 'kg'`), arithmetic, comparison, boolean logic,
`if(c, a, b)`, variable paths (`stage.granulation.lod.last`, `bom.api.assay`, `batch.size`),
aggregate functions over recorded series only (`sum`, `mean`, `min`, `max`, `count`, `sd`,
`rsd`), `convert(x, 'unit')`, `roundHalfUp(x, decimals)`, `roundSig(x, figures)`, `abs`, `sqrt`,
`duration(a, b)`. Evaluation cost is linear in AST size times series length; a static cost bound
is computed at design time.

Dependency graph: each calculation declares its inputs; the designer builds the graph,
rejects cycles (D3) and fixes a topological evaluation order. At run time, correcting an input
recomputes dependents in order, keeps old results in history, and flags any verification or
signature bound to a dependent value as invalidated (section 5).

Example (potency-adjusted API quantity, from the sample BMR analysis):
`qty = convert(batch.units * formula.labelClaim * (100 '%' / lot.assayAsIs) * (mw.salt / mw.base), 'kg')`,
reported with `roundHalfUp(qty, 3)`; compensating filler: `filler = formula.fillerNominal - (qty - formula.apiNominal)`.

### 2.7 Versioning and where-used

- `Mbr` (identity: code, product, edition) has many `MbrVersion`s (integer version, status per
  section 4.1, content JSON, `content_sha256`, `based_on_version`, `change_control_ref`,
  `effective_from`, `approved_scope` = sites/lines/batch-size range).
- Every reference is pinned: MBR -> library block/element versions, parameter definition
  versions, material master versions, equipment class versions, SOP document versions. No
  floating "latest". An update to a library element produces a where-used list and optional
  bulk creation of new DRAFT MBR versions under one change control (each still reviewed).
- Frozen at submission: moving to IN_REVIEW computes the canonical JSON hash; any edit sends the
  version back to DRAFT (review restarts, signatures void).
- Semantic diff: reviewers see a structured diff (blocks, parameters, limits, texts, EC flags)
  against the previous effective version as well as the full content. If any EC-flagged element
  changed, a regulatory assessment with reporting category is a mandatory approval step.
- `mbr_where_used(mbr_version_id, ref_type, ref_id, ref_version)` rows are written at
  submission, so "which effective MBRs and which in-flight batches use material M / equipment
  class E / block B v3 / SOP S rev 7 / EC X" is a single indexed query (plus recursion for
  nested library elements).

### 2.8 Test run and simulation before approval

1. Static validation report (2.3).
2. Automated path simulation (no database writes): the engine enumerates every path of the
   compiled graph with loops unrolled up to `maxIterations`; for each guard and limit it
   generates boundary values (at each bound, one precision unit inside and outside, missing
   value) and evaluates calculations against golden inputs. Output: coverage report (nodes,
   guards true/false, limit classes, exceptions raised, time constraints) attached to the
   approval package.
3. Interactive test run: a person executes the version on real screens in TEST mode. Test
   batches live in separate `test_*` tables (or a separate schema), are watermarked
   "TEST - NOT GMP", cannot reserve or consume real inventory, cannot write genealogy, cannot
   be released, and are excluded from all GMP reports. A DB trigger on the GMP `batch` table
   rejects issuing from any version not EFFECTIVE (so a test switch cannot leak into production,
   the pitfall noted for one vendor's review-bypass switch) [E: companion file].
4. Golden batch fixtures: stored input scripts with expected outputs (calculated quantities,
   yields, exceptions, final states) are re-run on every software release (regression) and on
   every new MBR version derived from the same template.
5. Approval package = content + diff + validation report + simulation coverage + test-run
   record + EC assessment, signed by author, independent checker and QA approver (distinct
   people; 211.186(a), 211.100(a)).

### 2.9 Building blocks per edition, sharing the kernel

Layering (strict dependency direction, enforced by lint rules):
- `@ebmr/kernel` (compliance kernel): identity/access, e-signature, audit trail, trusted time,
  record hashing/canonical JSON, exception and deviation-link primitives, attachments,
  idempotency, outbox. Identical for both editions.
- `@ebmr/recipe-core` (shared internal library, recommended in addition to the kernel): flow AST,
  compiler, validator, execution engine, expression language, parameter/limit model, units,
  generic phase types. Sharing it halves validation effort; each edition pins its version. If
  the user wants zero shared recipe code, this package is forked per edition at the cost of
  validating it twice.
- Edition block catalogs (`apps/<edition>-server/src/blocks`): domain phase types, each defined by a Zod
  config schema, a data schema, an execution handler, exception rules, UI component and review
  renderer. The edition's designer palette only lists its own catalog, and its validator adds
  edition rules. Examples:
  - Generic (both, from recipe-core): Instruction/acknowledge, RecordParameter, Checklist,
    Calculation, Verification/witness, Timer and time limit, QA hold point, Attachment,
    Equipment status check, Room/line clearance, Weigh/dispense, Material identify and charge,
    Sampling request, IPC test with readings and statistics, Yield and reconciliation, Label
    issuance and reconciliation, Section sign-off, Exception capture, Sub-procedure call.
  - Tablets only: Sieving with screen integrity, Dry mixing, Binder preparation, Wet granulation
    endpoint, Fluid-bed/tray drying with LOD loop, Roller compaction/slugging, Milling,
    Blending/lubrication with blend uniformity sampling, Compression set-up (tooling, punches),
    Compression IPC schedule (weight, breaking force, thickness, friability, disintegration,
    left/right channels), Bilayer layer-weight control, Coating suspension prep, Coating run with
    weight gain, Deduster/metal detector check, Blister line (forming/sealing, leak test),
    Bottle line (count, desiccant, induction seal, torque).
  - Injectables only: Component preparation (washing, depyrogenation tunnel), Stopper/closure
    sterilisation, Compounding with WFI, pH/osmolality adjustment loop, Pre-filtration bioburden
    sample, Filter integrity test (pre-use, post-use), Sterile filtration (pressure/time/volume),
    Isolator/RABS decontamination and glove integrity, Aseptic gowning check, EM session binding
    (viable/non-viable, personnel monitoring), Filling with periodic fill-weight checks,
    Aseptic intervention log (inherent/corrective), Lyophilisation cycle capture, Capping/crimping,
    Terminal sterilisation cycle (F0, BI/CI), 100 % visual inspection with AQL, Container closure
    integrity test, Media-fill status gate.

---

## 3. Core data model

Conventions for every GMP table: `id` (UUIDv7, time-ordered), `tenant_id`, `site_id` where
applicable, `row_version` (integer, optimistic locking), `created_at/created_by`; no physical
DELETE for GMP data (logical status only); every mutation goes through a domain command that
writes audit entries in the same transaction (section 5). Exactness: all measured values are
`numeric` (never float) plus a UCUM unit code. Every lifecycle status change is also written
to an insert-only `<entity>_status_history(entity_id, from_state, to_state, valid_from,
changed_by, signature_id, plus entity-specific snapshot columns such as a deviation's
classification)` so guards and invariants can be evaluated "as of" any past instant
(needed for release-time invariants and for re-checking transcribed contingency entries). Each
edition has its own database; the kernel schema is created in each edition database by the
kernel's own migrations.

### 3.1 Kernel schema (`kernel.*`, identical in both editions)

| Entity | Key fields | Notes / constraints |
|---|---|---|
| `org_unit` | id, tenant_id, type (ENTERPRISE, SITE, AREA), parent_id, code, name, `iana_time_zone` | Scope for roles, time display and retention. |
| `user_account` | id, tenant_id, username (unique forever), legal_name, display_name, email, status (INVITED, ACTIVE, LOCKED, SUSPENDED, DEACTIVATED), idp_issuer + idp_subject, account_type (HUMAN, INTEGRATION, BREAK_GLASS) | Never deleted or renamed to another person; IDs never reused (11.100(a), 11.300(a)). |
| `local_credential` | user_id, argon2id_hash, changed_at, expires_at, failed_count, locked_until, history_hashes | Only when no enterprise IdP; password policy per site. |
| `mfa_factor` | id, user_id, type (WEBAUTHN, TOTP), public_key / secret_enc, registered_at, revoked_at | MFA mandatory for remote and admin access. |
| `role` | id, code, name, category (GMP_OPERATOR, GMP_SUPERVISOR, PRODUCTION_REVIEWER, QC, QA, QP, MBR_AUTHOR, MBR_REVIEWER, MBR_APPROVER, BUSINESS_ADMIN, IT_ADMIN, AUDITOR_READONLY, INTEGRATION) | Permissions are code-defined constants, bound to roles by configuration under change control. |
| `role_assignment` | id, user_id, role_id, org_unit_id, valid_from, valid_to, requested_by, approved_by, reason, revoked_at, revoked_by | Four-eyes on grants; requester != approver != grantee. |
| `sod_rule` | role_category_a, role_category_b, scope | Built-in and non-removable: IT_ADMIN or BUSINESS_ADMIN never combined with GMP_* / QA / QP / MBR_* in the same site. |
| `qualification` | user_id, code (SOP training rev, equipment operation, gowning grade, aseptic qualification), valid_from, valid_to, source (LMS/manual), evidence_ref | Read by signature guards (training required before performing). |
| `auth_session` | id, user_id, started_at, last_activity_at, idle_timeout_s, ip, device_id, is_remote, methods (PWD, MFA, SSO), ended_at, end_reason | Continuous-session rule for signatures (11.200(a)(1)). |
| `auth_event` | id, user_id (nullable), type (LOGIN_OK, LOGIN_FAIL, LOCKOUT, LOGOUT, TIMEOUT, REAUTH_OK, REAUTH_FAIL, MFA_FAIL), at, ip, device_id | Security log; failed attempts drive lockout and alerts (11.300(d)). |
| `signature` | id, signer_user_id, signer_legal_name (snapshot), signer_role_code, meaning_code, meaning_text (snapshot), signed_at (UTC), site_time_zone, record_type, record_id, record_row_version, `content_sha256`, content_schema_version, challenge_id, auth_method, auth_event_id, session_id, qualification_check jsonb (snapshot of role/qualification evaluation), comment, status (VALID, INVALIDATED), invalidated_at, invalidated_by_audit_id, invalidation_reason, `server_seal` (KMS signature over the row) | Binding: `content_sha256` covers the canonical JSON of the signed content and its metadata (section 5.2). |
| `signature_requirement_state` | record_type, record_id, requirement_id, meaning, satisfied_by_signature_id | What is still to be signed; drives UI and guards. |
| `audit_event` | seq (bigint per chain), chain_id, tenant_id, occurred_at (UTC, server), site_time_zone, actor_user_id, actor_role_code, session_id, source (UI, API, INTEGRATION, SYSTEM, MIGRATION), action (CREATE, UPDATE, LOGICAL_DELETE, STATUS_CHANGE, SIGN, SIGNATURE_INVALIDATED, CONFIG_CHANGE, EXPORT, PRINT, LOGIN...), entity_type, entity_id, entity_row_version, field_path, old_value jsonb, new_value jsonb, reason_code, reason_text, correlation_id, client_reported_at, prev_hash, hash | Append-only, hash-chained, partitioned by month (section 5.1). |
| `audit_anchor` | chain_id, seq, hash, anchored_at, anchor_kind (WORM_OBJECT, RFC3161_TSA), anchor_ref | External proof that history was not rewritten. |
| `audit_review` | id, scope_type (BATCH, MBR_VERSION, SYSTEM_PERIOD, USER_ACCESS), scope_id, report_definition_version, report_sha256, reviewer_id, status, findings, signature_id | Reviewer must be independent of the reviewed activity (guard). |
| `reason_code` | code, category (CORRECTION, SKIP, LATE_ENTRY, OVERRIDE, REPEAT, CANCEL), text, requires_free_text | Controlled list, versioned. |
| `attachment` | id, sha256, media_type, bytes, storage_uri (WORM bucket), uploaded_by, uploaded_at, original_name | Content-addressed; never overwritten. |
| `idempotency_key` | key, user_id, command_type, request_sha256, response jsonb, created_at, expires_at | Exactly-once commands (section 5.5). |
| `outbox_event` | id, aggregate_type, aggregate_id, event_type, payload, occurred_at, published_at, attempts | Transactional outbox (section 6). |
| `time_sync_sample` | at, source, offset_ms, stratum, ok | Evidence that server time was trustworthy; alarms on drift. |
| `retention_rule` / `retention_hold` | record_type, jurisdiction, rule, computed retain_until; legal_hold flag | Purge only after retain_until and no hold, with QA-approved destruction record. |
| `true_copy_export` | id, record_type, record_id, format (PDF_A3_WITH_JSON, JSON_BUNDLE), sha256, generated_by, generated_at, purpose | Export itself is audited. |
| `config_setting` | key, value, scope, status (DRAFT/APPROVED/EFFECTIVE), approved_by | Some keys immutable by design (audit on, min signature components). |

### 3.2 Tablets edition schema (`tab.*`)

Master data:
- `material`: id, code, name, material_type (API, EXCIPIENT, COATING_MATERIAL, PRIMARY_PACK,
  SECONDARY_PACK, PRINTED_PACK, INTERMEDIATE, BULK, FINISHED_PACK), base_uom, storage_condition,
  shelf_life_rule, retest_interval, is_printed_material, compendial_grade, version, status.
- `supplier`, `supplier_lot` (supplier_id, material_id, supplier_lot_no, coa_ref).
- `lot`: id, material_id, lot_no (unique per material+site), supplier_lot_id, site_id, status
  (4.5), qty_on_hand + uom, manufactured_at, expiry_date, retest_date, assay_as_is, water_content,
  potency_basis, qc_release_ref, released_by/at, origin (RECEIPT, PRODUCTION, REWORK).
- `container`: id, lot_id, container_no, gross/tare/net, status (FULL, PARTIAL, EMPTY, DISPENSED,
  DESTROYED), location, label_printed_at.
- `equipment_class` (HIGH_SHEAR_GRANULATOR, FLUID_BED_DRYER, TRAY_DRYER, ROLLER_COMPACTOR, MILL,
  BIN_BLENDER, ROTARY_PRESS, BILAYER_PRESS, COATING_PAN, BLISTER_LINE, BOTTLE_LINE, BALANCE,
  MOISTURE_ANALYSER, HARDNESS_TESTER, FRIABILATOR, DT_APPARATUS...) with capability attributes
  (working capacity range, stations, max speed).
- `equipment`: id, code, class_id, room_id, cleanliness_state, fitness_state, usage_state (the
  three regions of 4.4), qualification_status, calibration_due_at, last_cleaned_at,
  last_cleaning_type, clean_hold_until, dirty_since, last_product_id, campaign_count,
  current_batch_id.
- `tooling_set`: id, press_class, punch_shape, embossing, stations, strokes_used, max_strokes,
  last_inspection_at, status (AVAILABLE, IN_USE, QUARANTINE, RETIRED).
- `room` / `line`: id, code, type (DISPENSING, MANUFACTURING, PACKAGING), status (CLEAN, IN_USE,
  DIRTY, CLEARANCE_PENDING, OUT_OF_SERVICE), current_batch_id.
- `product`, `product_variant` (strength, pack type, market), `marketing_authorisation`
  (market, holder, registered process references), `established_condition` (code, description,
  reporting_category_us, reporting_category_eu, ma_ref).
MBR design (the same shape in both editions, content differs):
- `mbr` (id, code, product_variant_id or template flag, edition), `mbr_version` (id, mbr_id,
  version, status (4.1), content jsonb, content_sha256, based_on_version_id,
  change_control_ref, approved_scope jsonb (sites, lines, batch size min/max), effective_from,
  superseded_at), `mbr_review_cycle`, `mbr_where_used`, `library_element` +
  `library_element_version`, `parameter_definition` (versioned), `block_type_registry` (code,
  version, software_release that introduced it; read-only, populated by deployment).
Execution:
- `production_order`: order_no (ERP), product_variant_id, planned_qty, uom, planned_start, site_id.
- `batch`: id, batch_no, production_order_id, mbr_version_id (pinned FK), issued_record_sha256,
  batch_size + uom, purpose (COMMERCIAL, VALIDATION, CLINICAL, ENGINEERING_NON_GMP), status
  (4.2), site_id, manufacture_date, expiry_date (computed), row_version.
- `issued_batch_record`: batch_id, control_recipe jsonb (resolved and scaled), sha256,
  issued_by, issued_at, issue_signature_id.
- `stage_execution`, `step_execution`: id, batch_id, node_id, loop_path (e.g. `[{"loop":"L1","i":2}]`),
  attempt_no, status (4.3), enabled_at, started_at, completed_at, performed_by, verified_by,
  skip_reason_code, row_version; UNIQUE (batch_id, node_id, loop_path, attempt_no).
- `flow_token` (batch_id, node_id, loop_path, status ACTIVE/CONSUMED), `branch_decision`
  (batch_id, node_id, loop_path, decision_type, inputs jsonb, expression_sha256, chosen_branch,
  decided_by, reason, decided_at), `stage_signoff` (stage_execution_id, signature_id).
- `data_point`: id, step_execution_id, parameter_code, channel (e.g. LEFT/RIGHT), reading_no,
  value_numeric, value_text, ucum_unit, entry_mode, instrument_id, captured_at (server),
  client_captured_at, entered_by, status (CURRENT, SUPERSEDED), supersedes_id, correction_reason,
  limit_eval (IN_RANGE, ALERT, ACTION, OOS), limit_set_sha256.
- `calculation_result`: id, step_execution_id, calc_id, inputs jsonb (ids and values),
  expression_sha256, value, unit, status (CURRENT, SUPERSEDED).
- `dispense_record` / `material_consumption`: batch_id, step_execution_id, bom_line_id, lot_id,
  container_id, target_qty, net_qty, gross, tare, balance_id, tolerance_eval, weighed_by,
  verified_by.
- `lot_link` (genealogy, section 1.6), `equipment_occupancy` and `room_occupancy`
  (`during tstzrange`, EXCLUDE overlap per equipment/room).
- `line_clearance`: id, batch_id, stage_id, room_or_line_id, previous_batch_id, checklist jsonb,
  performed_by, verified_by (QA), result (PASS, FAIL), completed_at.
- `ipc_schedule_slot`: step_execution_id, due_at, window_end, status (DUE, DONE, OVERDUE, MISSED).
- `timer`: batch_id, constraint_id, started_at, alert_at, due_at, status (RUNNING, ALERTED,
  SATISFIED, VIOLATED, CANCELLED).
- `exception`: id, batch_id, step_execution_id, type (LIMIT_ALERT, LIMIT_ACTION, TIME_LIMIT,
  MISSED_IPC, CORRECTION, LATE_ENTRY, SKIP, EQUIPMENT_STATUS, MATERIAL_STATUS, OPERATOR_CHOICE,
  LOOP_EXHAUSTED, INTEGRATION_FAILURE, MANUAL_ENTRY_FALLBACK), severity, status (OPEN,
  DISPOSITIONED), disposition (NO_IMPACT, DEVIATION_RAISED), deviation_id, dispositioned_by.
- `deviation`: id, number, source (EXCEPTION, MANUAL), classification (MINOR, MAJOR, CRITICAL),
  status (4.6), impact_assessment, root_cause, capa_refs, external_qms_ref; `deviation_batch`
  (deviation_id, batch_id, linked_at, impact (NONE, POTENTIAL, CONFIRMED), rationale,
  assessment_approved_at, assessment_signature_id).
- `sample`: id, batch_id, step_execution_id, type (IPC, QC_RELEASE, RETAIN, STABILITY), lims_ref,
  status (REQUESTED, TAKEN, IN_TEST, RESULT_PASS, RESULT_FAIL, OOS_INVESTIGATION).
- `yield_record`: batch_id, stage_id, theoretical, actual, rework_in, rework_out, samples,
  rejects, percent, limits, eval.
- `printed_material_issue` / `printed_material_reconciliation`: issued, used, returned,
  destroyed, variance with limits (211.125).
- `batch_review`: batch_id, stage (PRODUCTION_REVIEW, QA_REVIEW), exception_report_sha256,
  audit_review_id, checklist, status, signature_id.
- `batch_disposition`: batch_id, market, decision (RELEASED, REJECTED), signed_at,
  us_quality_unit_signature_id, eu_qp_certification_signature_id, qp_register_entry_id,
  release_check_snapshot jsonb + sha256 (every G-REL input as evaluated).
- `shipment_line` (imported from ERP/WMS): packed lot, customer, quantity, shipped_at; last hop
  of recall queries.

### 3.3 Injectables edition schema (`inj.*`)

Everything in 3.2 in injectables form (with its own equipment classes: WASHER, DEPYROGENATION_TUNNEL,
AUTOCLAVE, COMPOUNDING_VESSEL, FILTER_HOUSING, ISOLATOR, RABS, FILLING_MACHINE, LYOPHILISER,
CAPPER, VISUAL_INSPECTION_MACHINE, CCIT_TESTER; and container types VIAL, AMPOULE, CARTRIDGE,
PREFILLED_SYRINGE, NESTED_RTU_TUB), plus:
- `clean_area`: id, code, grade (A, B, C, D), type (ROOM, ISOLATOR, RABS, LAF_ZONE), parent_area_id,
  status (4.7), pressure cascade refs, current_batch_id.
- `em_location`: id, clean_area_id, sample_type (VIABLE_ACTIVE_AIR, SETTLE_PLATE, CONTACT_PLATE,
  GLOVE_PRINT, NON_VIABLE_0_5, NON_VIABLE_5_0), alert_limit, action_limit (per grade, with unit).
- `em_session`: id, batch_id, clean_area_id, started_at, ended_at, plan_version.
- `em_result`: id, em_session_id or routine_run_id, em_location_id, sampled_at, result, unit,
  eval (IN, ALERT, ACTION), lims_ref, read_at; `em_excursion` (em_result_id, status, deviation_id,
  impacted_batches computed by time overlap).
- `gowning_qualification`: user_id, grade, qualified_at, expires_at, last_monitoring_result;
  `aseptic_qualification`: user_id, media_fill_id, status.
- `media_fill` (aseptic process simulation): id, line_id, performed_at, units_filled, units_incubated,
  contaminated_units, result (PASS, FAIL, INVALID), participants, max_duration, interventions_covered,
  status_valid_until.
- `intervention`: id, batch_id, clean_area_id, type (INHERENT, CORRECTIVE), code, started_at,
  ended_at, operator_id, covered_by_media_fill (bool).
- `sterilisation_cycle`: id, equipment_id, cycle_type (MOIST_HEAT, DRY_HEAT_DEPYROGENATION, SIP, VHP),
  recipe, load_id, started_at, ended_at, f0, min_temp, exposure_time, bi_result, ci_result,
  status (IN_PROGRESS, PASSED, FAILED, ABORTED), data_file_attachment_id.
- `filter_use`: id, batch_id, filter_lot_id, position, pre_use_integrity (value, unit, pass),
  post_use_integrity, pupsit_performed, integrity_instrument_id.
- `lyo_cycle`: id, batch_id, equipment_id, recipe, load_map, started_at, ended_at, deviation_flags, data_ref.
- `hold_time`: id, batch_id or equipment_id, kind (BIOBURDEN_HOLD, STERILE_BULK_HOLD, FILL_DURATION,
  DIRTY_HOLD, CLEAN_HOLD, STERILE_COMPONENT_HOLD), started_at, max_duration, status.
- `visual_inspection`: id, batch_id, method (MANUAL, SEMI, AUTOMATED), units_inspected,
  rejects_by_defect_class, aql_sample_result, inspector_ids.
- `ccit_result`, `glove_integrity_test`, `wfi_sample` (TOC, conductivity, endotoxin, micro).

---

## 4. State machines, guards and invariants

Implementation principle: every lifecycle is an explicit machine defined once as data in the
shared domain package (XState v5 machine config + typed guard functions), executed on the
server, rendered (never decided) by the UI, and mirrored in the database by (a) a CHECK on the
status column, (b) an `allowed_transition(machine, from_state, to_state)` table checked by a
BEFORE UPDATE trigger, so even a direct SQL session cannot jump states. Guards that need data
are evaluated inside the same transaction with the relevant rows locked (`SELECT ... FOR
UPDATE/SHARE`). "Sig(X)" = e-signature with meaning X; "sys" = system transition (timer or
event), always audited with actor SYSTEM.

### 4.1 MBR version

States: DRAFT, IN_REVIEW, IN_APPROVAL, APPROVED, EFFECTIVE, SUPERSEDED, RETIRED, CANCELLED.

| Transition | Guard | Signature / effects |
|---|---|---|
| (new) -> DRAFT | user has MBR_AUTHOR for the site scope | version = max+1; `based_on_version_id` set |
| DRAFT -> IN_REVIEW | static validation: 0 errors, every warning justified; simulation coverage report attached; all references EFFECTIVE; change-control ref present if version > 1 | Sig(AUTHORED); content frozen, `content_sha256` computed |
| IN_REVIEW -> DRAFT | reviewer returns with comments | reason; author signature becomes INVALIDATED on next content change |
| IN_REVIEW -> IN_APPROVAL | all required reviewers signed; each reviewer != author; test-run record attached when the risk class requires it | Sig(REVIEWED) per reviewer |
| IN_APPROVAL -> APPROVED | approver has QA MBR_APPROVER role; approver not author and not a reviewer; if any Established Condition changed: regulatory assessment signed with reporting category | Sig(APPROVED) |
| IN_APPROVAL -> DRAFT | QA rejects | reason |
| APPROVED -> EFFECTIVE | sys at `effective_from`; scope does not overlap another EFFECTIVE version of the same MBR | predecessor for the same scope -> SUPERSEDED in the same transaction |
| EFFECTIVE -> SUPERSEDED | sys (successor effective) | in-flight batches keep their pinned version |
| EFFECTIVE -> RETIRED | QA | Sig(APPROVED) + reason; blocks new issues; QA decides on in-flight batches (hold or continue) |
| DRAFT or APPROVED -> CANCELLED | author (DRAFT) or QA (APPROVED) | reason |

### 4.2 Batch

States: PLANNED, ISSUED, IN_PROGRESS, ON_HOLD, EXECUTION_COMPLETE, PRODUCTION_REVIEWED,
QA_REVIEWED, RELEASED, UNDER_AMENDMENT, REJECTED, ABORTED, CANCELLED. (Lot status is separate, 4.5; for the EU
the RELEASED state is reached through QP certification, for the US through quality unit
approval; a `batch_disposition` row per market records which.)

| Transition | Guard | Signature / effects |
|---|---|---|
| PLANNED -> ISSUED | MBR version EFFECTIVE now (row locked FOR SHARE) and its approved scope covers site, line and batch size; batch no. unique and never used before; production order valid | Sig(ISSUED); control recipe snapshot + SHA-256 stored; quantities scaled; variant branches resolved |
| ISSUED -> CANCELLED | no step started | Sig(APPROVED) by supervisor + reason; batch no. retired, never reused |
| ISSUED -> IN_PROGRESS | sys on first step start | - |
| IN_PROGRESS -> ON_HOLD | supervisor or QA; or sys on a blocking exception, QA hold point, environment hold | reason; no step may start; running time limits keep running |
| ON_HOLD -> IN_PROGRESS | the hold cause is resolved; if QA placed the hold, QA lifts it | Sig(APPROVED) + reason |
| IN_PROGRESS or ON_HOLD -> ABORTED | production head and QA | two Sig(APPROVED) + reason; open steps -> CANCELLED; produced lots -> ON_HOLD or REJECTED by QA decision; equipment -> DIRTY; material return/reconciliation steps still required; the aborted record is still reviewed |
| IN_PROGRESS -> EXECUTION_COMPLETE | end node reached; every step terminal (COMPLETED, SKIPPED, NOT_APPLICABLE, VOIDED with successor); all required signatures VALID; all stage yields and reconciliations recorded; every IPC slot DONE or has an exception | sys |
| EXECUTION_COMPLETE -> PRODUCTION_REVIEWED | reviewer has production review role; all exceptions dispositioned or raised as deviations | Sig(REVIEWED) |
| PRODUCTION_REVIEWED -> QA_REVIEWED | exception report generated by the validated report definition and reviewed item by item; batch audit-trail review completed by a reviewer who performed or verified no step in this batch; all QC/LIMS results present | Sig(REVIEWED) by QA; review record stores report hash |
| QA_REVIEWED -> RELEASED | release guard G-REL (below) | US: Sig(RELEASED) by quality unit; EU: Sig(CERTIFIED) by a QP named for the site, QP register entry written |
| QA_REVIEWED -> REJECTED | QA / QP | Sig(REJECTED) + reason; all output lots -> REJECTED |
| any review state -> IN_PROGRESS ("reopen") | only when a correction to execution data is needed; QA | Sig(APPROVED) + reason; all review signatures INVALIDATED (content changed) |
| RELEASED -> UNDER_AMENDMENT | post-release correction needed; QA opens an amendment linked to a deviation or change record | Sig(APPROVED) + reason; the disposition signature is INVALIDATED; QA records an explicit decision on the status of released stock (keep or put ON_HOLD) |
| UNDER_AMENDMENT -> RELEASED | amendment reviewed; G-REL re-evaluated | new Sig(RELEASED)/Sig(CERTIFIED); original release time stays in history |

Release guard G-REL (all must hold, evaluated in one transaction):
1. batch in QA_REVIEWED and the batch record content hash equals the hash reviewed;
2. every linked deviation is CLOSED, or IMPACT_ASSESSED with an approved impact assessment
   for this batch that permits release (critical deviations: CLOSED only, default);
3. no OPEN exception; no step in a non-terminal state; no signature INVALIDATED without a
   valid replacement;
4. all release tests PASS in LIMS (or an approved OOS investigation invalidated the result);
   all mandatory samples taken;
5. yields and printed-material reconciliation within limits, or covered by an assessed
   deviation (211.125, EU Ch.5 reconciliation);
6. every consumed lot is still not REJECTED/recalled (re-check at release);
7. audit-trail review for this batch complete (see PRODUCTION_REVIEWED -> QA_REVIEWED) and
   visible to the QP;
8. Injectables: all EM results for the batch's sessions READ (incubation finished) and every
   excursion assessed; line media-fill status was valid for the whole fill; all sterilisation
   cycles and filter integrity tests PASSED; 100 % inspection and CCIT complete; sterility test
   PASS where applicable;
9. signer holds the release role for the site/market, is not a performer or verifier of any
   step in the batch (default rule; relaxing it needs documented QA justification), and
   re-authenticated for this signature.

Review by exception: allowed only through the validated, versioned exception-report definition.
The report always contains every exception, correction, invalidated signature, voided/skipped/
repeated step, late or fallback entry, operator-chosen branch, limit excursion (alert and
action), time-limit event, open or assessed deviation and critical audit-trail event; the
mandatory set cannot be reduced by configuration, and anything the report cannot classify is
listed for full review. The reviewer can always open the complete record. If the report
definition in use is not an effective, validated version, the review screen forces full review.

### 4.3 Step execution (phase instance)

States: PENDING, ENABLED, IN_PROGRESS, AWAITING_VERIFICATION, COMPLETED, SKIP_REQUESTED,
SKIPPED, NOT_APPLICABLE, VOIDED, CANCELLED.

| Transition | Guard | Signature / effects |
|---|---|---|
| PENDING -> ENABLED | sys: token arrives | - |
| PENDING/ENABLED -> NOT_APPLICABLE | sys only: alternative branch not taken | decision record referenced |
| ENABLED -> IN_PROGRESS | batch IN_PROGRESS (not ON_HOLD); user holds role and every `qualificationRequired` (training on this MBR version/SOP rev, equipment operator, gowning grade); equipment status check passed and occupancy row inserted (EXCLUDE); room/line cleared and occupied by this batch; lots RELEASED, not expired, not retest-due; hold-time and time-limit constraints not violated (or exception raised when configured non-blocking) | start timestamp (server) |
| IN_PROGRESS -> IN_PROGRESS (record data) | value type/unit valid; instrument calibrated and daily check done | data point inserted; limit evaluation; ALERT -> comment required; ACTION/OOS -> exception (blocking if configured) |
| IN_PROGRESS -> AWAITING_VERIFICATION | all mandatory data present; calculations evaluated; min-duration constraint met; no blocking exception open | Sig(PERFORMED) |
| IN_PROGRESS -> COMPLETED | as above, and the phase has no verification requirement | Sig(PERFORMED) |
| AWAITING_VERIFICATION -> COMPLETED | verifier != performer and != any user who entered data in this step; verifier has role; late verification (beyond configured window) raises LATE_ENTRY exception | Sig(VERIFIED) or Sig(WITNESSED) |
| AWAITING_VERIFICATION -> IN_PROGRESS | verifier rejects | reason; performer signature INVALIDATED |
| COMPLETED -> AWAITING_VERIFICATION or IN_PROGRESS ("correct") | batch not yet QA_REVIEWED (else reopen first); corrector is the performer or a supervisor; reason code | old data SUPERSEDED (kept), new data inserted; signatures on this step and on dependent calculations INVALIDATED; dependents recomputed; CORRECTION exception raised; stage sign-off invalidated if present |
| ENABLED -> SKIP_REQUESTED | phase config `skippable = true` (never for phases feeding CPP/CQA, reconciliation, line clearance, signatures of release) | reason code + text |
| SKIP_REQUESTED -> SKIPPED | approver is supervisor/QA and != requester | Sig(APPROVED); SKIP exception raised |
| IN_PROGRESS or COMPLETED -> VOIDED ("repeat") | legitimate repeat (spill, wrong container, instrument failure); reason; supervisor approval | Sig(APPROVED); new attempt (attempt_no + 1) created ENABLED; voided attempt stays visible in the record and the exception report |
| any non-terminal -> CANCELLED | sys when batch ABORTED | - |

Loops: a loop iteration is not a state; each iteration instantiates new step executions with
`loop_path` incremented, so "repeated" data can never overwrite earlier iterations.

### 4.4 Equipment (three orthogonal regions, XState parallel state)

- Cleanliness: CLEAN -> IN_PRODUCT (on occupancy start) -> DIRTY (on release; `dirty_since`) ->
  CLEANING -> CLEAN (Sig(PERFORMED) + Sig(VERIFIED); cleaning type MINOR/MAJOR; agent lot;
  `clean_hold_until` = now + validated clean hold). Timers: CLEAN -> CLEAN_HOLD_EXPIRED; DIRTY ->
  DIRTY_HOLD_EXCEEDED (cleaning then needs a deviation reference). Campaign rule: MINOR cleaning
  is acceptable only for the same product within the validated campaign length/duration;
  product change requires MAJOR.
- Fitness: QUALIFIED, CALIBRATION_DUE_SOON (warning), CALIBRATION_OVERDUE, OUT_OF_TOLERANCE,
  MAINTENANCE, OUT_OF_SERVICE, RETIRED. OUT_OF_TOLERANCE (as-found calibration failure)
  automatically creates an impact query: batches with occupancy overlapping (last good
  calibration, now) -> deviation with those batches linked.
- Usage: IDLE, IN_USE(batch). Occupancy enforced by `EXCLUDE USING gist (equipment_id WITH =,
  during WITH &&)`.
- Use guard: cleanliness = CLEAN and `clean_hold_until > now` and cleaning type adequate for
  the product change; fitness = QUALIFIED (or DUE_SOON) and `calibration_due_at` after the
  planned end of use; usage = IDLE; tooling (tablets) inspected and below max strokes; for
  injectables, sterilised items within sterile hold. Measuring instruments (balances, moisture
  analysers, testers) are re-checked at every reading (calibration valid, daily check done).
- Rooms and packaging lines (both editions; classified areas in injectables use 4.7 instead):
  cleanliness and usage regions as above plus line clearance: DIRTY -> CLEANING -> CLEAN ->
  CLEARED_FOR_BATCH(batch) (line clearance Sig(PERFORMED) + QA Sig(VERIFIED), previous product
  and batch recorded) -> IN_USE(batch) -> DIRTY.

### 4.5 Material lot

States: QUARANTINE, RELEASED, RELEASED_FOR_FURTHER_PROCESSING (intermediates, via QA hold
point), ON_HOLD, RETEST_DUE, EXPIRED, REJECTED, CONSUMED, DESTROYED.

| Transition | Guard | Signature / effects |
|---|---|---|
| (receipt or production output) -> QUARANTINE | - | label status QUARANTINE |
| QUARANTINE -> RELEASED | all required tests PASS (LIMS); CoA reviewed; supplier approved for this material; identity testing done as required; not expired | Sig(RELEASED) by QC/QA; retest date set <= expiry |
| QUARANTINE -> RELEASED_FOR_FURTHER_PROCESSING | intermediate: QA hold point disposition CONTINUE | Sig(RELEASED) |
| QUARANTINE -> REJECTED | QC/QA | Sig(REJECTED) + reason |
| RELEASED -> ON_HOLD / ON_HOLD -> RELEASED or REJECTED | QA (investigation, complaint, recall) | Sig + reason |
| RELEASED -> RETEST_DUE | sys at retest date | lot unusable |
| RETEST_DUE -> RELEASED or REJECTED | retest result; new retest date <= expiry | Sig |
| any non-terminal -> EXPIRED | sys at expiry | terminal except DESTROYED |
| RELEASED or RELEASED_FOR_FURTHER_PROCESSING -> CONSUMED | sys when quantity reaches zero | - |
| packed (finished) lot QUARANTINE -> RELEASED | only as an effect of the batch disposition (G-REL) for that market, never directly | disposition signature referenced |
| REJECTED or EXPIRED -> DESTROYED | destruction record with witness | Sig(PERFORMED) + Sig(WITNESSED) |

Consumption guard: status RELEASED (or RELEASED_FOR_FURTHER_PROCESSING for intermediates),
`now < retest_date` and `now < expiry_date`, container dispensed for this batch (scan match),
quantity available (CHECK `qty_on_hand >= 0`), intermediate hold time not exceeded.

### 4.6 Deviation

States: OPEN, UNDER_INVESTIGATION, IMPACT_ASSESSED, PENDING_CLOSURE, CLOSED, CANCELLED.
- OPEN: created from an exception or manually; linked batches get release-blocked immediately.
- OPEN -> UNDER_INVESTIGATION: QA classifies (MINOR, MAJOR, CRITICAL), assigns owner and due date.
- UNDER_INVESTIGATION -> IMPACT_ASSESSED: per linked batch an impact assessment (NONE,
  POTENTIAL, CONFIRMED + rationale) approved by QA (Sig(APPROVED)). This is the state in which a
  batch may be released with the deviation still open (not for CRITICAL by default).
- IMPACT_ASSESSED -> PENDING_CLOSURE: root cause, CAPA references, effectiveness check plan.
- PENDING_CLOSURE -> CLOSED: QA Sig(APPROVED).
- OPEN -> CANCELLED: QA, reason (duplicate/invalid); unblocks batches only through this signature.
- If deviations live in an external QMS, the eBMR stores the link and a mirrored status; the
  release guard performs a live status check at signing time (a stale mirror never releases).

### 4.7 Injectables only: clean area and EM

Clean area states: CLEANING_DISINFECTION, DECONTAMINATION (isolator VHP), CLEAN_READY,
IN_OPERATION, DIRTY, ENVIRONMENT_HOLD, REQUALIFICATION.
- CLEANING_DISINFECTION -> CLEAN_READY: cleaning record performed + verified; for isolators a
  PASSED decontamination cycle and passed glove integrity tests; validity window starts.
- CLEAN_READY -> IN_OPERATION: guard: validity not expired; latest pressure differential and
  HVAC status from the BMS within limits; EM session started for the batch; every person entering
  holds a valid gowning qualification for the grade; for aseptic filling the line's media fill
  (aseptic process simulation) status is valid and the intended interventions are covered.
- IN_OPERATION -> DIRTY at end of operation; any -> ENVIRONMENT_HOLD on a non-viable action alarm
  during operation or a BMS pressure-cascade failure beyond its allowed duration;
  ENVIRONMENT_HOLD -> CLEANING_DISINFECTION after QA assessment (Sig(APPROVED)); REQUALIFICATION
  after major events (shutdown, construction) with QA release.
EM result/excursion: RECORDED -> (ALERT) ALERT_REVIEWED, or (ACTION) EXCURSION_OPEN ->
deviation auto-created and linked to every batch whose EM session or area occupancy overlaps
the sampling window -> IMPACT_ASSESSED -> CLOSED. Grade A viable results: any growth is treated
as an action-level excursion (Annex 1). Viable results arrive days later (incubation), which is
why release guard item 8 waits for READ status.

### 4.8 Operator qualification and gowning

Per (user, qualification code): NOT_QUALIFIED -> IN_TRAINING -> QUALIFIED -> EXPIRING (warning
window) -> EXPIRED; QUALIFIED -> SUSPENDED (failed gown/glove monitoring, failed media fill
participation, deviation-driven); SUSPENDED -> QUALIFIED only after requalification evidence;
any -> REVOKED. Sources: LMS feed (training), EM personnel monitoring, media-fill records.
Guard use: every step start, every signature with `qualificationRequired`, and every clean
area entry checks QUALIFIED at server time; the check result is stored with the signature.

### 4.9 Exception

OPEN -> DISPOSITIONED (NO_IMPACT with justification, or DEVIATION_RAISED with link) by a
supervisor/QA user who is not the person who caused it. Blocking exceptions prevent step
completion until dispositioned. Exceptions are never deleted and all appear in the exception
report.

### 4.10 Invariants that must always hold

| ID | Invariant | Enforced in |
|---|---|---|
| INV-01 | A GMP batch references exactly one MBR version, pinned at issue; `batch.mbr_version_id` is immutable; at issue time that version was EFFECTIVE and its scope covered the batch | Domain guard + DB trigger (immutability, status check) |
| INV-02 | The issued control recipe is immutable and its stored SHA-256 matches its content | DB trigger (no UPDATE) + periodic verifier |
| INV-03 | Verifier/witness != performer and != anyone who entered data in that step | Domain guard + DB CHECK/trigger on signature insert |
| INV-04 | MBR author, reviewer(s) and approver are pairwise distinct people | Domain guard + trigger |
| INV-05 | At the instant of release, the batch had no linked deviation that was neither CLOSED/CANCELLED nor IMPACT_ASSESSED with an approved assessment (non-critical), no OPEN exception, no non-terminal step, no missing release test and no incomplete audit-trail review | Release guard in one SERIALIZABLE transaction + `release_check_snapshot` + as-of invariant query |
| INV-06 | Original values are never overwritten or deleted: data points, calculations, genealogy links, signatures and audit events are insert-only; a correction is a new row with `supersedes_id` and a reason | REVOKE UPDATE/DELETE; security-definer functions only change `status` CURRENT->SUPERSEDED |
| INV-07 | Every GMP insert/update writes an audit event in the same transaction, carrying user, role, server timestamp, time zone, old/new value and (for changes) reason | Trigger fails the transaction if the actor context is missing |
| INV-08 | The audit chain is gapless and every hash verifies; anchors match | Hash computed in trigger; verifier job; external anchors |
| INV-09 | A signature is VALID only while the canonical hash of the signed content equals `content_sha256`; any change to signed content invalidates it in the same transaction | Domain + trigger on signed tables |
| INV-10 | A signature was preceded, in the same request, by a successful re-authentication of the same user with both identification components (stricter than the 11.200(a)(1) continuous-session allowance) | Signature service; `auth_event_id` NOT NULL FK, single-use challenge |
| INV-11 | No user holds an admin role and a GMP role in the same scope; accounts are never deleted or reused | Grant guard + trigger; unique username forever |
| INV-12 | Equipment occupancy never overlaps; equipment is used only when clean (within hold), qualified and calibrated at time of use | EXCLUDE constraint + guard with row lock |
| INV-13 | Material is consumed only from lots that are usable at the time of consumption; lot quantity never negative | Guard with row lock + CHECK |
| INV-14 | Every consumption and every output creates genealogy links; links are insert-only | Same command transaction; trigger |
| INV-15 | A stage using a room/line starts only after a PASS line clearance recorded after the previous occupancy ended | Guard + EXCLUDE on room occupancy |
| INV-16 | All business timestamps come from the database server clock; client times are informational only | Column defaults `clock_timestamp()`; API ignores client time for GMP fields |
| INV-17 | At most one EFFECTIVE MBR version per MBR and scope at any instant | EXCLUDE on effective ranges |
| INV-18 | Test/simulation data never enters GMP tables; GMP tables accept only batches issued from EFFECTIVE versions | Separate tables + trigger |
| INV-19 | Loop iterations never exceed `maxIterations` without an exception; iteration data is retained | Engine + unique (step, loop_path, attempt) |
| INV-20 | A step never completes before its minimum duration; every maximum violation produces an exception | Engine using server time + timer worker |
| INV-21 | A RELEASED/REJECTED batch record changes only through the amendment process, which invalidates and requires re-signing of the disposition | Trigger + domain |
| INV-22 | Nothing is purged before `retain_until` or while on legal hold | Purge procedure checks + approved destruction record |
| INV-23 | Injectables: filling starts only in a CLEAN_READY area with an active EM session, valid line media fill and qualified operators; release waits for all EM results and excursion assessments | Guards + release guard |
| INV-24 | Tablets: compression starts only with inspected tooling within stroke limits; printed packaging reconciliation (issued = used + returned + destroyed within tolerance) or an exception | Guards |
| INV-25 | Derived record values (expiry date, theoretical yield, scaled quantities, potency-adjusted quantities, unit counts) are computed by approved rules, never typed; e.g. expiry = the MBR's shelf-life rule, capped by component expiry where the rule says so | Engine; no input field exists |
| INV-26 | Every PERFORMED/VERIFIED/APPROVED signature was given by a user who held the required role and qualification at that instant; the evaluation is stored with the signature | Signature service + `qualification_check` snapshot |
| INV-27 | Batch numbers, user IDs and signature IDs are never reused, even after cancellation or deactivation | UNIQUE constraints over all history |

---

## 5. Audit trail, e-signature, identity, time, concurrency, offline, backup, export

### 5.1 Audit trail (kernel)

Capture (cannot be bypassed by application code):
- Row-level AFTER INSERT/UPDATE triggers on every GMP table write field-level entries into
  `kernel.audit_event` in the same transaction. The trigger reads the actor context that the
  application sets with `SET LOCAL app.actor_user_id / app.actor_role / app.session_id /
  app.reason_code / app.reason_text / app.correlation_id / app.source`; if the context is
  missing, the trigger raises and the transaction fails, so an ad-hoc SQL change without an
  identified actor and (for changes) a reason is impossible. DELETE is revoked on GMP tables;
  logical deletion is an UPDATE of status and is audited as LOGICAL_DELETE.
- Business-level entries (e.g. "weighing recorded, 12.503 kg, balance B-17, container C-0042")
  are written by the domain command alongside the row-level entries and share the
  `correlation_id`, so reviewers read business language while the row-level trail proves
  completeness.
- Content per entry: who (user id, legal name snapshot, role under which the action was taken,
  session), what (entity type/id/row version, field path, old value, new value), when (server UTC
  `clock_timestamp()` plus the site IANA zone and UTC offset in force), why (reason code and
  text: mandatory for any change or invalidation after first entry; optional for creation),
  how (UI, API, integration, system, migration; device id). This covers creation as well as
  modification and deletion, as the July 2025 Annex 11 draft expects.
- No configuration switch exists to disable, pause, filter at capture or purge the trail. A
  start-up self-check and an hourly job verify from the catalog that every GMP table has its
  audit trigger enabled; on failure the application refuses GMP writes and alerts.

Tamper evidence and protection against privileged users:
- Per-aggregate hash chains: each batch, MBR version, lot, equipment item, user account and
  configuration area has a chain head row `audit_chain_head(chain_id, last_seq, last_hash)`.
  The trigger locks the head row (writers to the same aggregate are already serialised), assigns
  `seq = last_seq + 1` (gapless within the chain, because the head update rolls back with the
  transaction) and `hash = SHA-256(prev_hash || canonical_json(entry))`. Inside PostgreSQL the
  canonical form is the `jsonb` text rendering (deterministic key order) hashed with the
  built-in `sha256()`; the verifier reproduces exactly that function.
- Periodic anchoring (e.g. every 5 minutes): a job builds a Merkle tree over all chain heads that
  changed since the last anchor and writes the root to WORM object storage (S3 Object Lock in
  compliance mode or Azure immutable blob) and optionally to an RFC 3161 time-stamping
  authority. Azure SQL's ledger feature follows the same pattern (database digests stored in
  immutable storage outside the DBA's reach), which shows the approach is mainstream [D].
- Privilege separation: table owner role is NOLOGIN; the application role has INSERT on audit
  tables and no UPDATE/DELETE/TRUNCATE; migrations run through the CI/CD pipeline under change
  control with a separate role; no named human holds superuser in production; break-glass
  superuser access requires two people, is time-boxed and is logged by `pgaudit` (classes DDL,
  ROLE, WRITE and MISC, the last covering `SET session_replication_role`, which would otherwise
  silence triggers) to a log sink the DBAs cannot write (SIEM/WORM). An event trigger also
  records DDL (including DISABLE TRIGGER) inside the database.
- Result: prevention by privileges, detection by chain + anchors + external pgaudit log. Even a
  superuser who rewrites rows cannot make the recomputed chain match the anchored roots. The
  residual window is the time since the last anchor; it is kept short (minutes) and covered by
  the near-real-time pgaudit stream, which records the superuser session itself.
- Verification: a verifier recomputes chains (nightly full for recent partitions, rolling for
  older ones), checks seq continuity and anchors, and writes a signed verification record;
  any mismatch opens a data-integrity incident.
- Feasibility probe [B] (`scratchpad/bench/audit_poc.sql`, PostgreSQL 16, 4 vCPU,
  `synchronous_commit=on`, 8 clients, single-row GMP inserts, each its own transaction):
  without the audit trigger ~10,500 commits/s (0.76 ms); with the trigger writing a full
  old/new JSON audit row and extending a per-batch SHA-256 chain ~6,000 commits/s (1.34 ms)
  spread over 200 concurrent batches, i.e. about 0.6 ms added per write; worst case, all
  8 clients writing into one batch's chain (serialised on its head row) ~1,450 commits/s
  (5.5 ms), far above any human or instrument data-entry rate for one batch. The trigger
  rejected a write without actor context and an UPDATE without a reason; the PL/pgSQL verifier
  re-hashed 29,696 chain entries in 0.25 s and flagged both a superuser UPDATE of one audit row
  and a superuser DELETE of another (a superuser who also rewrites every later hash and the head
  is caught by the external anchors, as described above).

Storage and review:
- `audit_event` is range-partitioned by month; partitions stay online for the retention period
  (archival in 5.7). Typical volume: a large batch creates 10^4-10^5 entries.
- Risk-based audit-trail review: a validated report definition per scope (batch, MBR version,
  system/period, user access) selects the critical events: corrections, invalidated signatures,
  late entries, voided steps, skips, overrides, limit changes, re-authentication failures,
  configuration changes affecting the batch, time-sync alarms, integration fallbacks. The
  reviewer (who performed or verified nothing in that batch) acknowledges each item; the review
  record stores the report definition version and a hash of the report. Batch release requires
  it (G-REL 7); the QP sees it on the certification screen.

### 5.2 Electronic signatures (Part 11 11.50, 11.70, 11.100, 11.200, 11.300; Annex 11 s.14)

Flow (two requests, one transaction for the second):
1. `POST /signature-challenges {recordType, recordId, meaning, expectedContentHash}`: the server
   builds the canonical signed content (RFC 8785 JSON canonicalisation of the record view:
   values, units, limits evaluation, performer, node id, MBR version, attachment hashes),
   computes SHA-256, checks it equals the client's expected hash (so the user signs exactly
   what is on screen), and returns a single-use challenge (nonce, 120 s expiry) plus the
   manifestation preview.
2. `POST /signatures {challengeId, credentials}`: server re-authenticates the user (password,
   or IdP step-up with OIDC `max_age=0`; plus a second factor for release/certification and for
   remote sessions); evaluates guards (role, SoD, qualification, performer != verifier, record
   state); re-checks the content hash (optimistic, with row lock); inserts `signature` with
   `content_sha256`, `auth_event_id`, meaning, legal name, role and server time; performs the
   state transition; writes audit and outbox rows. Any guard failure aborts everything.

Rules:
- Two distinct components (user ID + password, or badge as ID + password/PIN) at every signing;
  this is stricter than the continuous-session allowance of 11.200(a)(1), which is permitted
  (config may be stricter, never weaker). No "remember me", no pre-signing, no signing on behalf.
- Manifestation (11.50): every display and print of a signed record shows legal name, user ID,
  role, meaning and date/time with UTC offset and site zone.
- Linking (11.70): the signature stores the content hash and is itself part of the record's audit
  chain and of the batch record hash, so it cannot be cut out or copied to another record. The
  server additionally seals each signature row with a KMS/HSM-held key (Ed25519 or ECDSA), so an
  exported true copy can be verified outside the system and a DBA cannot forge a signature row.
- Invalidation: every change to signed content (correction, recalculation of a dependent value,
  reopening) sets the affected signatures to INVALIDATED in the same transaction, referencing
  the audit entry that caused it; invalidated signatures remain visible and a new signature is
  required. A trigger on signed tables is the backstop if domain code misses a dependency.
- 11.100: identity is verified before a signing account is activated (`identity_verified_by/at`,
  method); each user acknowledges on first signing that the e-signature is the legal equivalent
  of a handwritten one (the company's certification letter to FDA is an organisational task).
- 11.300: user IDs unique forever; password ageing/history per policy; lockout after N failed
  attempts with alert to security and QA; lost tokens revoked (`mfa_factor.revoked_at`);
  periodic test of badge readers/tokens is an SOP task tracked as equipment calibration.

### 5.3 Identity and access

- Authentication: enterprise IdP via OIDC (Entra ID, Okta, Ping) or built-in local accounts for
  standalone and demo; SCIM may provision accounts, but GMP role grants are made in the eBMR
  with four-eyes approval and audit (IdP groups do not silently grant GMP rights).
- MFA: mandatory for remote access, for all admin roles and for release/certification
  signatures; WebAuthn/FIDO2 preferred; shop floor uses badge + password/PIN on shared terminals
  with fast user switching (every action attributed to the badge holder; no generic accounts).
- Authorisation: RBAC scoped to org units (site/area) + attribute guards (qualification, SoD,
  record-specific rules such as performer != verifier). Permissions are code constants; the
  role-permission mapping is versioned configuration under change control.
- Separation of GMP users and administrators: IT_ADMIN (infrastructure, deployments) and
  BUSINESS_ADMIN (user/role administration, master data set-up) cannot create or change GMP
  execution data, cannot sign GMP records and cannot alter audit data; enforced by `sod_rule`
  and by DB privileges (app role vs admin role).
- Sessions: idle timeout (shop-floor default 10 min, configurable stricter), screen lock, forced
  logout on role change, concurrent session policy per role.
- Periodic access review report (users, roles, last login, dormant accounts) reviewed and signed
  by QA as an `audit_review` of scope USER_ACCESS.
- Integration identities (scales, SCADA, LIMS, ERP) are non-human accounts that cannot sign;
  their data is attributed to the device and to the operator who triggered the capture.

### 5.4 Trusted time

- All GMP timestamps are generated by the database server (`clock_timestamp()`), stored as
  `timestamptz` (UTC); each record also stores the site IANA zone so displays show site local
  time with offset, independent of the viewer's browser. Durations use UTC instants (DST-safe).
- Hosts sync with chrony against several trusted sources; a monitor samples offset into
  `time_sync_sample`; above an alarm threshold (e.g. 500 ms) it raises a data-integrity alarm,
  above a blocking threshold (e.g. 5 s) new signatures are refused until resolved (thresholds
  configurable only to be stricter).
- Client/device times are stored as `client_captured_at` for information and offline analysis
  only; they never drive guards, durations or ordering.
- Within a batch, a per-batch `event_seq` (counter on the batch row) gives a total order for
  projections and review, independent of clock resolution.

### 5.5 Concurrency and idempotency

- Optimistic locking on every aggregate (`row_version`); a stale command gets HTTP 409 with the
  current state; lost updates are impossible.
- Short pessimistic row locks for cross-aggregate invariants (lot quantity, equipment status,
  chain heads), always in a fixed lock order (batch -> step -> lot -> equipment -> chain head) to
  avoid deadlocks; EXCLUDE constraints for time-overlap rules.
- Isolation: READ COMMITTED + explicit locks for ordinary commands; SERIALIZABLE with automatic
  retry (SQLSTATE 40001) for release/certification and for MBR effectivity switches.
- Idempotency: every mutating request carries an `Idempotency-Key` created when the user starts
  the action; the key, request hash and response are stored in the same transaction as the
  effect; a retry returns the stored response; the same key with a different payload is rejected.
  This makes network retries and double clicks safe.
- Parallel branches let several operators work on one batch at the same time; locks are per step
  execution, with the batch row locked only for batch-level transitions.

### 5.6 Offline and network loss on the shop floor

Principle: a GMP record exists only when the server has accepted it; the terminal never
creates signed records on its own. Client-side offline signing is rejected because it would
evaluate guards on stale data (material status, equipment status, qualifications), take time from
an untrusted clock and require caching credential verifiers on devices.

Layered design:
1. Deployment: each edition can run as a site-local "execution node" (application + PostgreSQL
   on site servers or an edge cluster) so that a WAN or cloud outage does not stop the shop floor;
   enterprise functions (cross-site reporting, analytics) consume the outbox asynchronously.
2. Terminal/LAN loss: the UI keeps the unsent entry on screen (not a record), shows a blocking
   "not saved" banner, and resends with the same idempotency key when the link returns.
   Instrument interfaces (balances, SCADA, historians) buffer at Level 2 with source timestamps;
   late-arriving data is imported with its source time and flagged.
3. Extended outage: a validated contingency SOP issues pre-printed, controlled contingency forms
   generated from the issued control recipe; after recovery the entries are transcribed as
   MANUAL_FALLBACK with the scanned paper original attached, second-person verification, and the
   engine re-evaluates every guard against the historical state at the recorded times (was the
   lot released then, was the equipment clean then) raising exceptions where not. The paper
   forms are retained as raw data (a defined hybrid process, which the 2025 drafts require to
   be defined and controlled).
4. Server-side timers (time limits, hold times) keep running through terminal outages.

### 5.7 Backup, disaster recovery, retention and archival

- Backups: continuous WAL archiving + scheduled base backups (pgBackRest or managed-service
  equivalent) to storage that is physically and logically separate (other account/region),
  encrypted, with object lock; attachments in versioned, object-locked storage.
- DR targets (proposed): RPO 0 for committed transactions within a site (synchronous standby),
  RPO <= 5 min cross-region; RTO <= 4 h. HA via Patroni (on-prem) or managed zone-redundant HA.
- Restore testing: automated restore into an isolated environment (e.g. weekly), then audit-chain
  verification, anchor comparison and sample record re-hash; the result is a signed restore-test
  record (Annex 11 s.7 and the draft's regular restore testing).
- Retention: `retain_until` per batch = max over markets of the jurisdiction rule; EU: longer of
  expiry + 1 year or certification + 5 years; US 211.180: at least 1 year after expiry (3 years
  after distribution for certain OTC products without expiry). MBR versions, master data
  versions, audit events and signatures are retained at least as long as any record that
  depends on them. Legal hold overrides. Purge only by an approved destruction record.
- Archival: records stay queryable online as long as practical (partitioned tables); at archival
  a batch becomes an immutable archive bundle (5.8) in WORM storage with a manifest; an archive
  integrity job periodically re-verifies hashes and readability, and retrieval is re-tested
  before every major software change, as Annex 11 s.17 requires.

### 5.8 Data export and true copies

- True copy bundle per batch (or MBR version): (1) human-readable PDF/A-3 rendering of the full
  record (all steps, values with units and limits, calculations with formulas, exceptions,
  deviations, signatures with manifestation, audit trail section); (2) the complete
  machine-readable record embedded as JSON (data, audit events, signatures, hashes, schema
  version), so the dynamic record's content and meaning survive; (3) a manifest with SHA-256 of
  every part, sealed with the server key. A small open-source verifier CLI recomputes hashes,
  checks the seal and the audit-chain segment.
- Exports and prints are themselves audited (who, what, when, purpose); inspectors get a
  time-boxed read-only role and on-request exports.

---

## 6. Scalability (multi-site, tenancy, partitioning, outbox, read models, large MBRs)

### 6.1 Deployment and tenancy

- Unit of deployment = one edition for one customer (company) per environment (DEV, VAL, PROD).
  GxP customers must control when upgrades reach their validated environment, want physical
  data segregation, and audit their supplier; pooled multi-tenant databases fight all three.
  Every row still carries `tenant_id` (plus `site_id`), enforced by PostgreSQL row-level
  security as defence in depth, so the same code serves (a) contract manufacturers that must
  segregate client data inside one installation and (b) a later pooled SaaS tier if wanted.
- Multi-site, two supported topologies with the same schema:
  - Level 1 (default, up to roughly tens of sites per region): one edition database per company
    region, many sites inside, `site_id` on every row, site-scoped roles, site time zones.
  - Level 2 (very large or latency/outage-sensitive sites): a site cell per site (application +
    PostgreSQL on site or edge, section 5.6) plus an enterprise hub. The hub governs global
    master data and MBR templates; approved MBR versions and master data travel to site cells as
    signed packages (content hash verified on import, import audited), the same idea as vendors'
    automated recipe transfer between environments [E: companion file]. Site cells publish their
    outbox streams to the hub for cross-site dashboards, genealogy federation and analytics.
- Identifiers are UUIDv7 everywhere (globally unique, time-ordered, no central sequence), so
  records from many cells can be merged or federated without collisions. Human identifiers
  (batch numbers, deviation numbers) are allocated per site from gapless counters in the
  site's database.
- Data residency: one deployment per legal region where required (e.g. EU data kept in EU).

### 6.2 Data volumes and partitioning

Order-of-magnitude estimate for a large tablet batch: 500-3,000 step executions; 5,000-50,000
data points (IPC-heavy compression dominates: e.g. 20-tablet weights every 15 min on two press
sides over 8-16 h); 3-10 audit entries per data point. At 40,000 batches/year across a company
this is 10^8-10^9 data points and several times that in audit entries per year, spread across
site databases.

- Big tables (`step_execution`, `data_point`, `calculation_result`, `em_result`,
  `audit_event`) are declaratively partitioned by month.
  Trick: because `batch_id` is a UUIDv7 (its first 48 bits are the creation time), batch-owned
  tables can be RANGE-partitioned on `batch_id` itself with monthly bounds; every query by
  `batch_id` prunes to one partition, and whole months can later be archived. `audit_event` is
  partitioned on `occurred_at`. (PostgreSQL 16 has no built-in UUIDv7 generator, so ids are
  generated in the application or by a small SQL function; PostgreSQL 18 adds `uuidv7()`.)
- High-frequency instrument data (checkweighers weighing every tablet, lyophiliser and autoclave
  sensor traces, particle counters) does not become one GMP row per reading. The validated
  source system (historian, instrument software) remains the raw-data owner; the eBMR stores
  per-interval statistics, all excursions, the cycle summary and a content-hashed reference or
  attached export. This keeps batch tables bounded and review focused.
- Genealogy (`lot_link`) is not partitioned below roughly 10^9 rows; section 1.5 shows 20 M
  edges with both indexes at 2 GB and sub-second worst-case recall traversal.
- Indexing rules: every FK indexed; partial indexes on "open" work (`WHERE status IN
  ('ENABLED','IN_PROGRESS','AWAITING_VERIFICATION')`) for worklists; GiST for time ranges.

### 6.3 Transactional outbox and integration

- Every command writes its domain events to `kernel.outbox_event` in the same transaction as
  the state change (no dual write). A relay worker claims rows with
  `FOR UPDATE SKIP LOCKED` and publishes them; large installations can instead stream the outbox
  via logical decoding (Debezium) to Kafka or NATS JetStream. Delivery is at-least-once;
  consumers are idempotent (`processed_event(consumer, event_id)` unique).
- Per-aggregate ordering comes from the batch `event_seq`; consumers apply events in that order.
- Consumers: read models, ERP interface (goods issues/receipts, confirmations, yields), LIMS
  (sample requests in, results back as commands), QMS (deviation mirror), notifications, the
  anchoring job, and the enterprise hub feed.
- Inbound integrations (scales, SCADA, LIMS, ERP orders) enter as commands through the same
  domain layer with integration identities, idempotency keys and full audit; there is no side
  door into tables.

### 6.4 Read models (CQRS-light)

- Built from the outbox into a `read` schema (same database for small sites, replica or
  separate database for large ones): operator worklist per room/line, supervisor board
  (progress, running timers, overdue IPC slots, holds), QA review queue (exception counts per
  batch, age, blocking items), incrementally maintained exception report per batch, equipment and
  room status boards, EM trending, where-used and genealogy summary tiles.
- Rule: read models are never the input to a GxP decision. Every guard (release, step start,
  consumption) re-reads the system-of-record tables inside its transaction; dashboards show a
  "data as of" watermark.
- Live UI updates via server-sent events (or WebSocket) per room/batch channel fed by the relay.

### 6.5 Very large MBRs and batches

- MBR content is immutable per version, so the compiled graph, validation result and rendered
  catalog are cached forever keyed by `content_sha256` (LRU in each API process).
- Designer: outline (stage) view, stage-level editing and lazy canvas rendering; full validation
  is linear in size (milliseconds for thousands of phases) and also runs incrementally per stage
  while editing.
- Execution never loads a whole batch aggregate per command: state lives in `flow_token`
  (batch_id, node_id, loop_path, status) and `step_execution` rows; a command touches the step,
  the relevant tokens and the batch header row.
- Operator screens show only enabled/in-progress work for their room/line; the full record is
  paged and virtualised; the review screen starts from the exception report, not from page 1.

### 6.6 Horizontal scaling and operations

- Stateless API processes behind a load balancer; separate worker processes (timers, outbox
  relay, projections, anchoring, integrity verifier, report rendering); PostgreSQL primary with
  synchronous standby and asynchronous read replicas (reporting only); PgBouncer in transaction
  mode (compatible with `SET LOCAL` actor context).
- Proposed SLOs: p95 command latency < 300 ms on site LAN; step screen < 1 s; exception report
  for a 50,000-entry batch < 5 s; backward genealogy trace < 50 ms; supplier recall < 5 s.
  Headroom evidence from this container [B]: ~6,000 audited, hash-chained GMP writes/s on
  4 vCPUs (5.1) versus a large site's estimated peak of tens to low hundreds of writes/s from
  people and instruments; the write path is not the bottleneck, review/report rendering is, hence the
  read models and precomputed exception reports.
- Upgrades: expand/contract migrations and blue/green deployment, scheduled by the customer.
  Behaviour pinning: block handlers are versioned (`block.type@version`) and old handler versions
  stay in the code base, so an in-flight batch continues with exactly the semantics it was issued
  with; an upgrade that would change semantics for in-flight batches is blocked by a
  pre-upgrade check.

---

## 7. Technology stack recommendation

### 7.1 Decision: TypeScript end to end on PostgreSQL

The highest-risk logic in an eBMR (guards, state machines, limit evaluation, calculations,
flow validation, signature-content canonicalisation) must behave identically in the browser
(instant feedback for operators and MBR authors, designer validation, simulation) and on the
server (the authority). With TypeScript this logic is written, reviewed, tested and validated
once, in shared packages. Zod schemas give one definition for API contracts, forms, block
configurations and database-bound types.

| Option | For | Against | Verdict |
|---|---|---|---|
| **TypeScript (Node LTS) + React + PostgreSQL** | One language for shared domain logic, UI and server; strong static typing (strict mode); very large talent pool; mature libraries for exactly the correctness tools needed (XState, Zod, fast-check model-based testing, StrykerJS, Playwright); runs in the provided container | Numeric pitfalls (must ban JS `number` for GMP values: decimal library + lint rule); runtime type safety needs schema validation at every boundary; npm supply-chain risk (lockfile, SBOM, pinned versions, provenance) | **Recommended** |
| Java/Kotlin (Spring) + TS UI | Enterprise familiarity (PAS-X-style JVM stacks), strong typing, mature | Domain logic duplicated in the UI (or UI becomes thin and less friendly); two toolchains | Viable, second choice |
| C#/.NET + TS UI (or Blazor) | Popular in pharma IT, strong tooling | Same duplication issue; Blazor limits UI ecosystem | Viable |
| Rust core (WASM in browser + server) + TS shell | Strongest guarantees for expr/flow engine, shared via WASM | Higher build cost, smaller hiring pool, slower iteration | Later hardening path for `expr`/`recipe-core` behind the same interfaces, using the golden suite as equivalence oracle |
| Python (Django/FastAPI) + TS UI | Fast to build | No shared logic with UI, weaker typing | Not recommended |

Runtime versions: Node 22 is what this container has (maintenance LTS, end of life 30 Apr 2027);
production should run Node 24 LTS (supported to 30 Apr 2028) and move to Node 26 once it
becomes LTS (scheduled 28 Oct 2026) [E: Node.js release schedule]. PostgreSQL 16 here; 16-18
in production (all supported majors; managed on Azure, AWS, GCP and on-prem with commercial
support).

### 7.2 Components (current npm versions checked 2026-09-27)

| Concern | Choice | Why |
|---|---|---|
| API server | Fastify 5 + `fastify-type-provider-zod`, OpenAPI generated from Zod | Fast, schema-first, plugin model; OpenAPI for integrators |
| Validation / contracts | Zod 4 | Single schema for API, forms, block configs |
| Database | PostgreSQL 16+; driver `pg`; query builder Kysely 0.29 (type-safe SQL, explicit transactions); migrations as plain reviewed SQL files (`node-pg-migrate` 9 or a 100-line runner) | Triggers, RLS, EXCLUDE, partitions, `SET LOCAL` are central, so SQL must stay first-class; ORMs hide exactly what must be reviewed |
| State machines | XState 5 (machine definitions as data, typed guards) + `@xstate/graph` 3 for path generation | One definition drives server execution, DB transition table, diagrams and model-based tests |
| Jobs, timers | pg-boss 12 (PostgreSQL-based queue using SKIP LOCKED) | No extra infrastructure; transactional with business data |
| Outbox relay | In-process worker (SKIP LOCKED); Debezium/Kafka or NATS for Level 2 | Start simple, scale later |
| Cache / pub-sub | Redis 7 optional (UI push fan-out, rate limiting); never holds GMP state | Available in container; not needed for correctness |
| Decimal and units | `decimal.js` 10 (34 significant digits), `@lhncbc/ucum-lhc` 7 (UCUM validation and conversion) | Exact decimal GMP arithmetic; standard unit codes |
| Expression language | In-house `@ebmr/expr` (Pratt parser, checker, evaluator) with CEL-like syntax | See 2.6 |
| Canonical JSON, hashing, sealing | RFC 8785 `canonicalize`; Node `crypto` SHA-256, Ed25519; KMS abstraction (local key file in demo; cloud KMS/HSM in production) | Signature binding and true-copy verification |
| Authentication | `openid-client` 6 (OIDC, step-up with `max_age=0`), `@node-rs/argon2` (local accounts), `@simplewebauthn/server` 14 (FIDO2 MFA) | Standards-based; IdP optional for demo |
| Web UI | React 19 + Vite + TanStack Router/Query; accessible headless primitives (Radix) with an own design system tuned for gloves/touch (large targets, high contrast, barcode/badge input); React Hook Form + Zod | Ecosystem, performance, shared schemas |
| MBR designer canvas | `@xyflow/react` 12 (React Flow, MIT) rendering the PFC, driven by the AST | Mature graph canvas; the AST stays the source of truth |
| PDF/A true copies | HTML rendering printed by headless Chromium (Playwright), converted/validated to PDF/A-3 with Ghostscript and veraPDF in CI [D] | Faithful rendering; validated output format |
| Observability | pino 10 structured logs, OpenTelemetry traces/metrics | Operability, audit of technical events |
| Testing | Vitest 5, fast-check 4, `@xstate/graph`, Playwright 1.63, StrykerJS 10 with vitest runner | Section 8 |
| Monorepo | pnpm 10 workspaces + Turborepo 2; TypeScript project references; ESLint boundary rules | Two apps + shared packages with enforced dependency direction |
| Supply chain | Lockfile, pinned versions, `pnpm audit`/OSV, CycloneDX SBOM, signed container images (cosign) | Supplier assessment evidence for customers |

### 7.3 Repository layout (two independent products, shared kernel)

```
ebmr/
  pnpm-workspace.yaml  turbo.json  tsconfig.base.json  eslint.config.js (boundary rules)
  packages/
    kernel/           @ebmr/kernel       identity/access, e-signature, audit (triggers + chain + anchor),
                                         trusted time, idempotency, outbox, canonical JSON/hash/seal
      sql/            kernel.* migrations: tables, triggers, roles, RLS, allowed_transition
    expr/             @ebmr/expr         expression language: grammar, parser, type/unit checker, evaluator
    recipe-core/      @ebmr/recipe-core  flow AST, compiler, validator, engine, simulator, parameters/limits,
                                         generic phase contracts, lifecycle machines (MBR, batch, step, lot,
                                         equipment, deviation, exception) + guards
    ui-kit/           @ebmr/ui-kit       design system, signature dialog, audit viewer, review components
    validation-kit/   @ebmr/validation-kit  URS/risk YAML schema, trace-matrix and evidence generators
    test-kit/         golden-batch harness, DB test helpers, invariant SQL library
  apps/
    tablets-server/   Fastify API + workers; src/blocks/* (tablet catalog); sql/ tab.* migrations
    tablets-web/      React app: shop floor, MBR designer (tablet palette), QA review, admin
    injectables-server/  Fastify API + workers; src/blocks/* (sterile catalog, clean area, EM); sql/ inj.*
    injectables-web/  React app with the injectables palette and area/EM screens
  validation/
    tablets/          URS.yaml, risk-assessment.yaml, generated trace matrix, test protocols, reports
    injectables/
  tools/
    verifier-cli/     offline true-copy and audit-chain verifier
    bench/            genealogy benchmark (section 1.5)
  infra/
    docker-compose.yml (PostgreSQL, optional Redis), k8s/ (Helm chart later)
```

Rules: `apps/tablets-*` and `apps/injectables-*` never import each other (lint-enforced);
packages never import apps; each edition has its own database (`ebmr_tablets`,
`ebmr_injectables`), its own version number and release cycle; the shared packages are
versioned with Changesets and each edition pins exact versions, so a kernel change reaches an
edition only through that edition's change control.

### 7.4 Running and demoing in this container

- PostgreSQL 16 is installed (cluster `16/main`, started for the benchmark); create two databases,
  apply kernel + edition migrations, run seed scripts that load golden fixtures (one tablet wet
  granulation product, one aseptic vial product), local accounts for demo roles, local key file
  for sealing, a local append-only directory standing in for WORM anchoring (clearly labelled
  as demo-only).
- `pnpm dev` runs tablets-server (:3001) + tablets-web (:5173) and injectables-server (:3002) +
  injectables-web (:5174); workers run in-process in dev.
- Docker CLI exists but the daemon is not running here, so the demo uses the apt PostgreSQL
  directly; the same compose file works on a normal workstation.

### 7.5 Why this is credible for large companies

PostgreSQL is available as a managed service on all major clouds and with commercial support
on-prem; Node LTS and React are mainstream; everything ships as OCI images deployable on
Kubernetes/OpenShift; the compliance kernel concentrates Part 11 / Annex 11 controls in one
validated package; the product is a GAMP 5 category 4 configurable product whose customer
configuration (MBRs) is verified by the built-in validation/simulation tooling; supplier
evidence (SBOM, test and mutation reports, traceability matrix) is generated with each release.

---

## 8. Correctness strategy and validation pack

Goal: "no loopholes" is demonstrated, not asserted. Every invariant in 4.10 and every
regulatory requirement is (1) enforced in two layers, (2) attacked by automated tests at both
layers, (3) monitored in production, and (4) traced in a generated validation pack.

### 8.1 Explicit state machines as the single source

- Each lifecycle is one XState definition in `@ebmr/recipe-core` (or the edition for clean area
  and EM). From it the build generates: the `allowed_transition` rows (a test fails if the DB
  table and the machine differ), state diagrams for the functional specification, the
  permission/guard table for reviewers, and test paths.
- Guards are pure typed functions of a snapshot `(record state, actor, clock, related records)`,
  so they are unit-testable without a database and are reused by the server command handlers.

### 8.2 Property-based testing (fast-check)

- Expression language: parse/print round-trip; evaluator agrees with an independent reference
  evaluator using exact rational arithmetic on random expressions; unit conversion round-trips
  and dimension errors always rejected; rounding properties (USP half-up at limit decimals,
  Ph. Eur. significant figures) against tabulated examples and generated values; evaluation
  always terminates within the static cost bound.
- Flow validator/engine: random block-structured trees always compile to graphs that satisfy
  S1-S8 and are sound (every random execution reaches END with no leftover token); random
  mutations (dangling edge, undeclared cycle, missing ELSE, read-before-write, parallel write
  conflict) are always rejected with the right rule ID.
- Hashing/canonicalisation: key order and whitespace never change the hash; any change of a
  signed field always changes it.
- Limits: for random limit sets and values, evaluation classes (IN/ALERT/ACTION/OOS) are
  consistent with ordering, inclusivity and rounding.

### 8.3 Model-based testing

- Machine level: `@xstate/graph` shortest and simple paths through each lifecycle machine;
  each path is replayed against the real command API + database, asserting state and guard
  outcomes at each step (every transition and every guard-false branch covered).
- System level: fast-check `fc.commands` with a simplified in-memory model of batches, steps,
  lots, equipment, signatures and deviations; random command sequences (issue, start, record,
  correct, sign, verify, skip, void, hold, abort, raise/assess/close deviation, release, change
  lot/equipment status) run against the real server (`asyncModelRun`), and after every command
  the invariant SQL library (8.4) must return zero rows. Shrinking yields minimal failing
  sequences. `fc.scheduler` explores interleavings for races: two operators consuming the same
  lot, correcting while someone signs, releasing while a deviation is being linked, two batches
  claiming the same equipment.
- Optional formal model: a small TLA+ specification of sign / correct / invalidate / release under
  concurrency, model-checked with TLC, is cheap insurance for the most critical interaction.

### 8.4 Invariants in the database and in the domain, plus bypass tests

- Each INV-xx has: a domain guard with unit tests; a DB-level enforcement (constraint, trigger,
  privilege); a bypass test that connects as the application DB role and tries to violate it
  with raw SQL (UPDATE a data point, DELETE an audit row, insert overlapping occupancy, set a
  batch RELEASED directly, insert a signature without auth event), expecting rejection; and an
  invariant query. Examples:

```sql
-- INV-03: verifier must differ from performer (must return 0 rows)
SELECT s.record_id FROM kernel.signature s
JOIN kernel.signature p ON p.record_type = s.record_type AND p.record_id = s.record_id
                       AND p.meaning_code = 'PERFORMED' AND p.status = 'VALID'
WHERE s.meaning_code IN ('VERIFIED','WITNESSED') AND s.status = 'VALID'
  AND s.signer_user_id = p.signer_user_id;

-- INV-05: no batch was released while a linked deviation was blocking, evaluated as of the
-- release instant (a deviation linked after release is handled by the complaint/recall process)
SELECT b.id FROM tab.batch b
JOIN tab.batch_disposition bd ON bd.batch_id = b.id AND bd.decision = 'RELEASED'
JOIN tab.deviation_batch db ON db.batch_id = b.id AND db.linked_at < bd.signed_at
JOIN LATERAL (SELECT h.to_state AS status, h.classification FROM tab.deviation_status_history h
              WHERE h.entity_id = db.deviation_id AND h.valid_from <= bd.signed_at
              ORDER BY h.valid_from DESC LIMIT 1) d ON true
WHERE NOT (d.status IN ('CLOSED','CANCELLED')
   OR (d.status IN ('IMPACT_ASSESSED','PENDING_CLOSURE')
       AND db.assessment_approved_at < bd.signed_at AND d.classification <> 'CRITICAL'));
```

- Production data-integrity monitor: the same invariant queries plus audit-chain verification run
  on a schedule (read replica); any hit opens an incident and is evidence for periodic review.

### 8.5 Golden batch fixtures

Scripted end-to-end batches with expected outputs (final states, exception report items,
calculated quantities, yields, genealogy links, issued-record hash, normalised true-copy JSON):
- Tablets: direct compression; high-shear wet granulation with fluid-bed drying and LOD loop
  (including loop exhaustion); roller compaction; bilayer compression with layer-weight control;
  film coating with weight gain; blister packaging with printed material reconciliation; bottle
  packaging.
- Injectables: aseptic vial fill in an isolator with EM session and interventions; terminally
  sterilised ampoules; lyophilised vials; prefilled syringes from nested RTU tubs; EM action
  excursion discovered after incubation linked back to the batch; failed post-use filter integrity.
- Each has a happy path and exception-rich variants (corrections after verification, voided and
  repeated steps, skip with approval, hold/resume, abort, deviation assessed vs closed, late
  entry, integration fallback). Fixtures run on every commit and every release; customers re-run
  them in IQ/OQ, and MBR-derived fixtures support PQ.

### 8.6 Mutation testing and static analysis

- StrykerJS (vitest runner, incremental mode on pull requests; full weekly run) on `kernel`,
  `expr`, `recipe-core` and block handlers. Targets: >= 90 % mutation score for guards,
  signature invalidation, limit evaluation, rounding and flow validation; >= 80 % elsewhere;
  surviving mutants in high-risk modules require a test or a written justification.
- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); lint rules banning
  JS `number` arithmetic on GMP values, `Date.now()` in domain code (time only via the clock
  port), and cross-edition imports; SQL migration linting; dependency and licence scanning.

### 8.7 GAMP 5 (2nd ed.) / CSA-style validation pack generated with the code

- Requirements as code: `validation/<edition>/URS.yaml` entries with ID, text, regulatory basis
  (e.g. 21 CFR 11.10(e), 211.188(b), Annex 11 s.9, Annex 1 section), GxP impact, and acceptance
  criteria; e.g. `URS-SIG-004: a verification signature by the performer of the same step is
  rejected (11.10(g), 211.188(b)(11))`.
- Risk assessment (ICH Q9(R1)): per requirement/function, severity to patient, product and data
  integrity x probability x detectability -> assurance level. High (guards, signatures, audit,
  calculations, release): scripted tests with objective evidence plus unscripted exploratory
  sessions. Medium: unscripted/scenario testing with recorded outcomes. Low: supplier unit tests
  and automated checks. This follows the CSA risk logic, used as informative guidance for a drug
  eBR whose binding basis remains 211.68, Part 11 and Annex 11 [E: companion file].
- Specifications generated from the code base: state diagrams and transition/guard tables,
  block catalog with config and data schemas, permission matrix, DB constraint/trigger inventory,
  audit event catalogue.
- Traceability matrix generated in CI: URS -> design element -> tests (IDs embedded in test names,
  e.g. `it('[URS-SIG-004] ...')`) -> JUnit results -> evidence files (Playwright screenshots,
  logs). CI fails if a high-risk requirement has no passing scripted test.
- Test protocols: Playwright scripted tests produce step-by-step records (step, expected,
  actual, screenshot, timestamp, tester) rendered as PDF test records for the validated test
  environment; failures are logged as test incidents.
- IQ/OQ support: an IQ script verifies versions, image digests against the SBOM, database
  triggers/constraints present and enabled, immutable settings; OQ = the automated regression and
  golden-batch suite executed on the customer's environment; PQ = customer MBRs with their
  approval packages (2.8).
- Release package: release notes with requirement-level impact, validation delta, test and
  mutation reports, SBOM, known issues, to feed each customer's change control and periodic
  review (backup/restore tests, access reviews, audit-trail review completion, incidents).

---

## 9. Open questions and risks

1. Final text of the revised EU Annex 11, Chapter 4 and Annex 22 (drafts of July 2025): not
   confirmed as published by Sept 2026 from reachable sources; the design follows the stricter
   draft expectations, re-check before freezing requirements.
2. Whether the release signer must be independent of every performer/verifier in the batch is a
   company policy choice beyond the regulations; the design defaults to independence.
3. Offline design deliberately excludes device-side signing; confirm with target customers
   that site-local execution nodes plus a paper contingency SOP is acceptable.
4. Behaviour pinning (retaining old block handler versions) adds maintenance cost; it is the
   price of never changing semantics under an in-flight batch.
5. Sharing `recipe-core` between the two products is recommended (validated once); if the user
   wants zero shared recipe code, fork it per edition and double that validation effort.
6. PAS-X and PharmaSuite database platforms are supported only by indirect (job posting) evidence.
7. The genealogy benchmark uses synthetic data; hub sizes and depth should be re-checked against a
   pilot customer's real consumption data before sizing hardware (the scripts are reusable).

## Sources

External sources consulted in this session (paraphrased; regulator sites were not directly
reachable, so regulatory references rely on the companion research files):
- Siemens Opcenter Execution Pharma fact sheet (Oracle or SQL Server database servers; genealogy):
  https://www.plm.automation.siemens.com/media/global/en/Siemens%20SW%20Opcenter%20Execution%20Pharma%20version%206-2-3%20Fact%20Sheet_tcm27-40138.pdf
- Emerson Syncade SQL Server job postings: https://www.dice.com/job-detail/d4441b7b-e807-4882-9b5a-6610742b41de
- PAS-X support roles (Oracle, JBoss, Citrix): https://www.ziprecruiter.com/Jobs/Werum-Pas-X ;
  PAS-X overview: https://intuitionlabs.ai/software/manufacturing-quality-supply-chain/manufacturing-execution-systems-mes/werum-pas-x-mes
- PharmaSuite overview and RDBMS skills: https://www.scribd.com/document/888362531/Pharma-Suite ;
  https://www.rockwellautomation.com/en-us/products/software/factorytalk/operationsuite/mes/life-sciences.html
- SAP batch where-used (CHVW, MB56/MB57): https://community.sap.com/t5/application-development-and-automation-discussions/finding-the-batch-genealogy-for-a-material/td-p/1175431 ;
  SAP Global Batch Traceability: https://sapinsider.org/how-to-use-sap-global-batch-traceability-to-meet-your-genealogy-reporting-requirements/
- Neo4j editions (backup, clustering, RBAC): https://neo4j.com/docs/operations-manual/current/introduction/ ;
  constraints: https://neo4j.com/docs/cypher-manual/current/constraints/managing-constraints/
- Boston Scientific on Neo4j: https://neo4j.com/customer-stories/boston-scientific/
- Apache AGE: https://age.apache.org/ ; Azure AGE overview (PG version support):
  https://learn.microsoft.com/en-us/azure/postgresql/azure-ai/generative-ai-age-overview ; Azure AGE GA: https://techcommunity.microsoft.com/blog/adforpostgresql/general-availability-of-graph-database-support-in-azure-database-for-postgresql/4413894 ;
  AWS RDS not supported: https://github.com/apache/age/issues/998 ; variable-length edge scaling
  issue: https://github.com/apache/incubator-age/issues/195 ; CTE vs AGE comparison:
  https://medium.com/@sjksingh/postgresql-showdown-complex-joins-vs-native-graph-traversals-with-apache-age-78d65f2fbdaa
- AWS QLDB end of support: https://www.infoq.com/news/2024/07/aws-kill-qldb
- Workflow-net soundness (van der Aalst): https://www.vdaalst.com/publications/p44.pdf
- CEL and JS implementations: https://github.com/google/cel-spec ; https://github.com/marcbachmann/cel-js
- UCUM JS library: https://github.com/lhncbc/ucum-lhc
- XState graph / model-based testing: https://stately.ai/docs/graph
- fast-check model-based testing: https://fast-check.dev/docs/advanced/model-based-testing/
- StrykerJS vitest runner and incremental mode: https://stryker-mutator.io/docs/stryker-js/vitest-runner/ ;
  https://stryker-mutator.io/docs/stryker-js/incremental/
- Offline mode in manufacturing apps (general description): https://connect981.com/glossary/offline-mode
- Node.js release schedule: https://github.com/nodejs/Release (schedule.json)
- Companion research in this folder: `configurability.jsonl` (vendor MBR designers, ISA-88,
  building blocks, guardrails, CSA status, FDA Data Integrity Q&A), `intl-annex11-pics.jsonl`,
  `intl-eu-ch4-ch5.jsonl`.
