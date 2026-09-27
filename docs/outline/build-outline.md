# eBMR Build Outline: Tablets edition and Injectables edition

Version 0.1, for your approval. 27 Sep 2026. Plan only: no application code has been written.

**How to read this.** Each technical choice is first explained in plain language (*In plain words*), then stated precisely. DI-xx, PR-xx, ST-xx and IN-xx are the 241 controls in the review pack v0.9 that the external expert is checking. K-xx/TB-xx and KB-xx/IB-xx are building blocks from the Tablets and Injectables process specifications. INV-xx are invariants: rules that must be true at every moment, enforced by the application and again by the database.

**Inputs.** research/architecture.md; digest-features-ux-config.md; digest-tablets-process.md; digest-injectables-process.md; the DI, PR, ST and IN control catalogs; PROGRESS.md; sample-bmr-analysis.md. Where they disagree, section 5.9 states the resolution.

---

## 1. Summary

**What gets built.** Two separate web products that replace paper batch manufacturing records for Indian drug manufacturers, many of them exporters:

- **Tablets edition:** oral tablets from dispensing to finished packs (direct compression, wet and dry granulation, film/functional/sugar coating, bilayer, printing, inspection, blister/strip/bottle packaging, cartoning, serialisation).
- **Injectables edition:** sterile injectables (aseptic vials, ampoules and prefilled syringes, lyophilised vials, terminally sterilised small- and large-volume products, aseptic suspensions/emulsions, BFS/FFS; isolator, RABS, conventional and single-use lines) plus the media-fill (APS) record type.

Each edition is sold, installed, validated and upgraded on its own, with its own server application, web application, database, screens and MBR designer. The designer's palette holds only that edition's blocks: a customer can shape any product within the dosage form but cannot turn one edition into the other.

**What is shared.** A **compliance kernel** used by both: identity and access, electronic signatures, audit trail and trusted time, plus the compliance plumbing around them (record hashing and sealing, the control register, the market-profile engine, retention, true-copy export; boundary confirmed in Decision 1). One code base, tested and validated once, pinned by exact version in each edition, so the products can never drift apart on data integrity. Whether they also share **recipe-core** (flow engine, expression language, limit model) is open; Decision 1 recommends sharing it.

**Market-profile engine.** Every batch is made in India, so Revised Schedule M always applies; each batch adds US and/or EU. For every rule that differs, the engine takes the strictest value across India plus the batch's markets, stores it with the market that required it, and applies it at MBR approval, batch issue, execution, release, sample retention and archiving (IN-52). Rules that belong to a line, room or person (media-fill acceptance, cleanroom limits, requalification) take the strictest value across all products qualified on that line or room. Label rules resolve per pack destination.

**Stack.** *In plain words:* one language everywhere, one mainstream database, well-known open-source tools. TypeScript end to end, so the same checks run in the browser (instant feedback) and on the server (the authority). Node.js LTS with Fastify and Zod; PostgreSQL 16+ as the only system of record, one database per edition, accessed with Kysely and reviewed SQL migrations, with triggers, constraints and row-level security enforcing key rules a second time. React + Vite web apps; React Flow for the designer canvas; XState state machines; decimal.js and UCUM units; pg-boss for timers and jobs. Tests with Vitest, fast-check, Playwright and StrykerJS. pnpm + Turborepo monorepo in the private GitHub repository github.com/maglesT/ebmr.

**Phases at a glance** (each ends in a tagged release with a demo and passing tests):

| Phase | Delivers | Demo |
|---|---|---|
| 0 | Repo, CI, control register as data, first ADRs | CI green; 241 controls listed with test status |
| 1 | Compliance kernel and market-profile engine | Four-eyes role grant; sign, change, see the signature invalidated; database tampering detected; rules resolved for {IN} and {IN, US, EU} |
| 2 | Recipe engine, expression language, MBR designer, verification sandbox | Build an MBR, fix validation errors, simulate, test-run, approve (Prepared, Checked, Approved) |
| 3 | Tablets edition end to end; sample BMR as first golden batch | Wet-granulation, film-coated batch with LOD loop, extra-IPA branch, rework addition, left/right IPC, on simulated scale and press |
| 4 | Production and QA review, release cockpit per market, India fields and labels, true copies | Released for India and US; EU "awaiting QP certification"; verifiable true copy |
| 5 | Injectables edition end to end | Isolator vial batch with EM, interventions, filter tests, APS gate; late EM excursion blocks release |
| 6 | Site gateway and integrations with simulators, dashboards, genealogy, languages, extras | Mock recall; Hindi screens; ERP/LIMS/QMS/LMS stubs exchanging data |
| 7 | Generated validation pack; performance, security and recovery hardening | Validation pack; IQ/OQ run with evidence; load and restore reports |

Honest size: this is comparable to a commercial manufacturing-execution product. Here we can build and demonstrate a working, heavily tested reference implementation of both editions with simulated equipment and systems; section 11.1 lists what needs a pilot customer.

---

## 2. Product scope per edition

### 2.1 What customers configure (both editions)

*In plain words:* customers assemble processes from validated blocks and enter their own values; they cannot write code or weaken a regulatory rule.

- **MBRs** from typed blocks: stages, operations, steps, formula/BOM, equipment-class requirements, parameters with tiered limits (registered / internal action / alert), calculations, IPC plans, timers and hold times (each with a validation reference), sampling, signature points, QA hold points, branches and bounded loops. **Library elements**: reusable compositions verified once.
- **Generic masters + variant parameter sets** (strength, tablet weight, fill volume, artwork per market). Approval covers the pairing; only the discrete batch sizes listed in the master (PR-01, IN-13).
- **Master data** (materials, suppliers, equipment, rooms/lines, tooling, templates, reason codes, units, custom fields; a custom field used in logic is GMP data), **organisation** (sites, roles and bundles, approval routes that can be extended but never reduced, deviation-class competence, training gates, languages), **site values** in rule tables (tighten-only, ST-01), and the **policy switches** the expert and customer may change (3.5).
- Never changeable (features spec E.2): the audit trail, the minimum signature set, the locked separations (7.2), commit-before-evaluate, no pre-filled measured values, no labelling-reconciliation waiver for Indian-made product.

### 2.2 Tablets edition: variants in v1

| Code | Variant | Key controls in the process |
|---|---|---|
| DC | Direct compression | Blend-uniformity plan |
| WG-HS / WG-FB | Wet granulation (high-shear + dryer; fluid-bed) | Binder use-by, endpoint, LOD loop, filter bags (IN-36) |
| DG-RC | Roller compaction (slugging legacy) | Ribbon checks, fines-recycle limit |
| UNC | Uncoated and sub-types (chewable, dispersible, orodispersible, soluble, effervescent) | Sub-type selects disintegration rule set |
| FC / FC-F / SC | Film, functional and sugar coating | Weight-gain endpoint; US controlled release needs a release-rate result per active (PR-54) |
| BL | Bilayer / multilayer | Layer weights kept apart from whole-tablet statistics |
| PK-BL, ST, BT, SEC, TER, SER | Blister, strip, bottle, secondary, tertiary, serialisation (US, EU, India Schedule H2) | One packaging record per packaging order; market-specific orders from one bulk batch |
| Modes | Potent/hormonal/cytotoxic, hygroscopic/effervescent, light-sensitive | Insert containment, RH limits, exposure timers |

Sub-lots split and merge with genealogy (K-25).

### 2.3 Injectables edition: variants

| Code | Variant | Proposed v1 depth (Decision 7) |
|---|---|---|
| V-1 | Aseptic solution in vials | Full, golden batch |
| V-2 | Aseptic glass ampoules (100 % CCI) | Full |
| V-3 | Prefilled syringes/cartridges from RTU tubs | Blocks in v1; golden batch v1.1 (combination-product detail unverified) |
| V-4 | Aseptic fill + lyophilisation | Full, golden batch |
| V-5 | Terminally sterilised small volume | Full, golden batch |
| V-6 | Terminally sterilised large volume | Blocks in v1; golden batch v1.1 |
| V-7 | Aseptic suspensions/emulsions | Blocks in v1; golden batch v1.1 |
| V-8 | BFS/FFS aseptic | v1.1 |
| V-9 | Aseptic + post-aseptic heat treatment | Full (adjunct terminal mode) |
| V-10 | APS (media fill) record | Full, golden batch |

Technology profiles (ST-74): open/closed isolator, open/closed RABS, conventional A-in-B (needs a contamination-control-strategy justification), BFS, FFS, closed/single-use.

### 2.4 Out of scope for v1

Continuous manufacturing (ICH Q13); capsule filling (Decision 7); biologics (EU Annex 2), investigational products, API manufacture, liquids, semi-solids; sterile powder filling, cell therapy, radiopharmaceutical specifics; the parametric-release path until EU Annex 17, the FDA 2010 guidance and the compliance policy guide are verified (ST-61; the policy-guide number is still unresolved); WHO-GMP and other markets (addable later, 10.2); full ERP/LIMS/QMS/LMS/CMMS/EMS functionality (integrated, with optional stand-ins, Decision 11); device-side offline signing (Decision 12); AI features and a graph analytics copy; migration of legacy records (DI-48 kept for later).

### 2.5 Assumptions (please correct any that are wrong)

1. Every batch is made in India under an Indian licence; India is always in the market set and cannot be removed (IN-52).
2. Export markets in v1 are US and EU. EU batches are certified by the EU importer's QP outside this system; the Indian site records the authorised-person release and the external certification reference. In-system QP certification is a tenant switch, OFF by default (DI-39, PR-55).
3. One installation per edition per company and environment (development, validation, production); contract manufacturers can separate client data inside it.
4. ERP owns items, orders and inventory valuation; the eBMR owns masters, execution and batch records (ISA-95).
5. Customers qualify their own installation (IQ/OQ/PQ) using the pack we generate.
6. English is the master language; Hindi and regional languages are display languages whose MBR translations are approved with each version.
7. Pharmacopoeial values (USP, Ph. Eur., IP 2026) ship as master data marked unverified until customer QA confirms them.
8. The user's sample BMR is a coverage test and the first golden batch, not a template.

---

## 3. Regulatory approach

### 3.1 The control register is data

*In plain words:* the 241 rules under expert review are stored as structured files in the repository; code, tests and validation documents are generated from the same list, so they cannot silently disagree.

- `compliance/controls/`: one YAML file per control (DI-01..50, PR-01..60, ST-01..79, IN-01..52). `compliance/requirements/`: the 678 clause-level rows (n-numbers) with verification status (checked, secondary, unverified, draft).
- Each control file holds: ID, title, editions, type (ENFORCED / CONFIGURABLE / DESIGN_CHOICE), markets, source clauses with verification markers, requirement rows, paraphrased behaviour, **implemented_by** (modules M01-M37/T01-T12/I01-I20, blocks, guards, invariants, database constraints, rule keys, policy switches), **tests** (derived from the catalog's "Test" line), **expert_decision** (PENDING / FOLLOW / DONT_FOLLOW / MODIFY, reviewer, date, pack version, comment) and build status (SPECIFIED / IMPLEMENTED / VERIFIED).

```yaml
id: DI-25
title: Audit-trail review within batch review
editions: [tablets, injectables]
type: [ENFORCED]
sources: [{ref: "21 CFR 211.192", status: checked}, {ref: "Annex 11 draft s.12", status: draft}]
implemented_by: {modules: [M02, M19], blocks: [K-26, KB-19], invariants: [INV-35], policies: [AUDIT_REVIEWER_INDEPENDENCE]}
tests: [T-DI-25-01, T-DI-25-02]
expert_decision: {status: PENDING, pack_version: "0.9"}
```

### 3.2 Trace chain

Clause (n-row) -> control -> user requirement (URS, generated per edition) -> design element (module, block, guard, invariant, constraint, rule key) -> automated test named with the control ID, e.g. `[DI-25][INV-35] a reviewer who verified a step cannot sign the audit-trail review` -> result and evidence. CI rebuilds the traceability matrix on every change and fails if a FOLLOW, MODIFY or pending ENFORCED control lacks a passing test in its editions, if a test cites an unknown control, or if a DONT_FOLLOW control still has active enforcement. Every catalog "Test" line becomes at least one automated test (at least 241 control-level tests).

### 3.3 How the market-profile engine works

*In plain words:* all market differences live in one versioned table; one small engine picks the strictest value and records why, instead of "if US... if EU..." scattered through the code.

- **Rule table** (`compliance/rule-tables/`, versioned): one row per key (e.g. `tablets.compression.ipcSampleMaxInterval`, `sterile.aps.acceptance`, `records.retention.batchRecord`, `sterile.filter.preUseTest`) with the IN, US and EU values (or "no rule"), unit, a **strictness comparator** (smaller-is-stricter, larger-is-stricter, an ordered list for categorical rules, or "required if any market requires"), **scope** (PRODUCT, PACK, LINE, ROOM, PERSON, SITE), hard floor or Annex 1 guidance value, sources with verification status, and the controls served.
- **Resolution:** strictest over {IN} plus the batch's markets. For LINE, ROOM and PERSON scope the market set is the union over all products qualified on that line or room (for a person, the lines and rooms they are qualified for); qualifying a new product can tighten a line (the first EU product switches APS acceptance to "any contaminated unit fails") and raises a QA review task.
- **Stored:** resolved value, governing market(s), rule-table version and inputs at each resolution point; every limit or timer evaluation stamps the limit version (ST-01). Changing a batch's market set before release re-resolves all rules and forces QA review. India is never removed, so an export-only batch never loosens an Indian rule.
- **Site values** may be stricter; a value looser than a hard number is refused; loosening an Annex 1 guidance value (e.g. the 10 Pa step between grades) needs a contamination-control-strategy reference and QA approval and is shown on every affected batch.
- **Examples** (IN-52 test, table B): retention = longest of expiry + 1 y, manufacture + 5 y (India, unconfirmed) and QP certification + 5 y, kept open until the EU date is known; excipient identity test every lot when US or EU is in the set (B-09); compression sampling against the in-process specification at most every 30 min (B-03); IP weight bands (B-14, unverified); APS "any contaminated unit fails" on lines with EU product (B-10); Grade B in-operation 5 µm limit 2,900/m3 from India (B-13); HEPA test every 6 months for A/B when US or EU is in the set (B-16); pre-use filter test always, after sterilisation when EU is in the set (B-17); uncoded manufacturing date on India-domestic packs only (B-15).
- **Behaviours as keys:** label specimens in the packaging master when US is in the set (PR D-1), area logbooks when EU is in the set (PR D-14), reconciliation waiver never offered (IN-17): boolean or categorical keys read by guards and the MBR validator.

### 3.4 How the expert's Follow / Don't follow / Modify decisions flow into the build

1. **Capture:** decisions from the PDF are imported into each control's `expert_decision` as a reviewed commit (the decision history is auditable).
2. **FOLLOW:** build as specified. **MODIFY:** control text changed to the agreed wording (diff reviewed), implemented_by and tests updated, new control version.
3. **DON'T FOLLOW:** for a design choice, the policy switch is set off in the vendor profile or the feature is not built. For a control resting on binding text, nothing is dropped silently: the build shows which markets would no longer be met and asks you to confirm; if confirmed, it is disabled only for the affected profile and the release notes say so.
4. Architecture-level changes get an ADR.
5. **Timing:** Phases 0-2 can start before the pack returns, because design choices are switches defaulting to the pack's proposal; controls still pending at a phase end are listed in its release notes.
6. The review-pack builder reads the register, so a v1.0 pack with decisions is regenerated automatically.

### 3.5 Design choices are switchable

`compliance/policies/` lists each switch: key, controls, default, allowed positions, **level** (vendor profile set from the expert's decisions, or tenant setting owned by customer QA under change control), what loosening requires, and tests for every position. Examples: checker may also approve an MBR (S4, default no); second person for processing line clearance (S24, default on); QA approval of each void (S28, default on); destruction witness (default on); reviewer and release-signer independence (S10, default: anyone who performed or verified a step is excluded); all signature components at every signing (DI-38, default on; relaxation for routine signings within one session only with QA approval, never for disposition, certification or MBR approval); review by exception (default full review until the MBR meets its confidence criterion, DI-26); release with an open investigation by e-signed justification (default blocked; never for reconciliation discrepancies or registered-specification failures, PR-53); CAPA blocking release (default no, PR-51); in-system QP (default off). The training gate is fixed as a hard block for India-licensed batches (IN-04). Tenant switches are versioned configuration items with author, approver, audit trail and effective date (DI-09).

### 3.6 Absorbing regulatory change

- **Watch list** (`compliance/watch-list.yaml`, owner and next check): final EU Annex 11, Chapter 4 and Annex 22; IP 2026 amendments; Schedule H2 data after G.S.R. 506(E); Schedule M corrigenda and the unreadable pages (IN F-1 to F-12); CSA status; DSCSA and EU safety-feature details.
- **Workflow:** update requirement rows -> tool lists affected controls (for Annex 11 and Chapter 4 the DI catalog already names them: DI-02, DI-08, DI-11, DI-13 to DI-19, DI-22, DI-23, DI-25, DI-36 to DI-39, DI-41, DI-43, DI-45 to DI-47, DI-49) -> controls modified with expert review -> rule-table or code change -> release with a validation delta.
- **Change classes** (E.7): platform release (full regression + customer acceptance); rule-table version (impact list of MBRs using changed keys, e.g. every MBR citing IP 2022 when IP 2026 applies); configuration item; MBR or library element.
- **Drafts:** stricter draft expectations that conflict with no binding text are already followed. Three are deliberately not: removing the stand-alone QP e-signature clause, audit-trail review after release, MFA at every signature as default (DI catalog section b). These are re-checked first when final texts appear.
- **In-flight batches** keep their issue-time rule-table version unless QA re-resolves through change control (5.8).

---

## 4. Architecture

### 4.1 Web application

*In plain words:* people use a browser; the server makes every decision; the database double-checks the important rules.

Browsers on shop-floor panel PCs and cleanroom-rated tablets (kiosk mode, badge reader, 2D scanner) and on office PCs. Stateless Fastify API processes plus workers (timers, outbox relay, read models, audit anchoring, integrity verifier, PDF rendering). Every command is validated and executed on the server in one database transaction; the UI never decides whether a step may start, a value is in limits or a signature is valid.

### 4.2 Deployment options

| Option | Suits | Notes |
|---|---|---|
| **A. On-premise at the site** (default proposal) | Most manufacturers | App + PostgreSQL with synchronous standby on site; customer controls upgrades; survives WAN loss |
| **B. Customer's private cloud tenancy** | Groups with a cloud landing zone | Single-tenant, Indian region; needs a reliable site link or option C |
| **C. Site cells + enterprise hub** | Large groups | Each site runs an execution node; the hub holds global templates and master data (sent to sites as signed, hash-checked packages) and receives outbox streams for cross-site reporting and genealogy |

**Network loss.** The site server keeps the floor running through WAN or cloud outages. If a terminal loses its link, the unsent entry stays on screen with a blocking "not saved" banner (it is not yet a record) and is re-sent with the same idempotency key; the gateway buffers instrument data with source timestamps. In longer outages the paper-fallback kit prints numbered contingency forms generated from the issued record; entries are back-entered as "transcribed from paper" with the scan attached and a second-person check, and every guard is re-evaluated against the historical state (DI-43, M25). Aseptic filling has a pre-staged immediate fallback. Server timers keep running. **Terminals never sign offline:** device-side signing would judge material, equipment and training status on stale data with an untrusted clock (Decision 12).

### 4.3 Monorepo layout

```
ebmr/
  compliance/         controls/ (241 + decisions), requirements/ (678), rule-tables/, floors/ (ST-01),
                      pharmacopoeia/, policies/, catalogs/ (signature meanings, exceptions, reason codes, units),
                      watch-list.yaml
  packages/
    kernel/           identity/access, e-signature, audit trail, time, hashing/sealing, idempotency, outbox,
                      retention, true copies, control-register loader, market-profile engine; sql/ kernel.*
    expr/             expression language
    recipe-core/      flow model, compiler, validator, engine, simulator, limits, generic blocks,
                      lifecycle machines (shared if Decision 1 = A; else forked per edition)
    integration-sdk/  adapter contracts for every external system
    ui-kit/           design system, signature dialog, audit viewer, review components, i18n
    validation-kit/   URS/risk generators, trace matrix, PDF test records
    test-kit/         golden-batch harness, invariant SQL library, bypass tests
  apps/
    tablets-server/  tablets-web/          blocks TB-xx; sql/ tab.*
    injectables-server/  injectables-web/  blocks IB-xx; sql/ inj.*
    site-gateway/     scale/printer drivers, OPC UA client, buffering (edition-agnostic)
    simulators/       scale, press, autoclave, lyophiliser, particle counter, ERP/LIMS/QMS/LMS stubs
  validation/tablets/  validation/injectables/
  docs/adr/  docs/architecture/  docs/user/  docs/regulatory/
  tools/verifier-cli/  tools/review-pack/  tools/bench/   infra/
```

Lint-enforced boundaries: apps never import each other; packages never import apps; `kernel` imports nothing else in the repo; `recipe-core` may import `kernel` and `expr`. Shared packages are versioned with Changesets and pinned exactly by each edition, so a kernel change reaches an edition only through that edition's change control.

### 4.4 PostgreSQL, one database per edition

`ebmr_tablets` and `ebmr_injectables`, each with `kernel.*`, the recipe schema and `tab.*` or `inj.*`. Every GMP row has a time-ordered UUIDv7 key, tenant and site IDs, a row version for optimistic locking and creation metadata; row-level security by tenant; exact `numeric` values with UCUM unit codes, never floating point; no physical DELETE. Large tables are partitioned by month; high-frequency instrument data stays in the source system, with per-interval statistics, excursions, cycle summaries and a hash-checked reference in the record. The table owner cannot log in; the application role cannot UPDATE or DELETE audit, signature, data-point or genealogy rows; migrations run only through the pipeline; break-glass superuser access needs two people and is logged by pgaudit to a sink administrators cannot write.

### 4.5 Graph question: verdict and benchmark

*In plain words:* a graph database was considered for batch genealogy and rejected; the normal database answers the same questions fast enough and keeps one validated platform.

PostgreSQL is the only system of record. Genealogy is an insert-only link table (mistakes neutralised by reversal links), indexed both ways, traversed by recursive SQL with set semantics, depth guard and cycle detection behind one `GenealogyService`. MBR flows (at most a few thousand nodes) are in-memory graphs persisted as immutable hashed JSON. A graph database is acceptable later only as a rebuildable, non-GMP analytics copy. Benchmark here (PostgreSQL 16, 4 vCPU, 15 GB; synthetic hub-heavy tablet genealogy, 9.73 M lots, 20.0 M links, roughly 20 sites over 15 years):

| Query | Result |
|---|---|
| Backward trace from a packed lot | 0.03 ms average (0.30 ms worst of 300) |
| Forward trace from an API lot | 0.30 ms average |
| Forward trace from the 10 worst hub excipient lots (~38,500 lots each) | 46 ms average, 48 ms worst |
| Supplier recall, 20 lots of the most-used excipient (447,139 lots) | 0.86 s |
| Cold start: backward / API forward / worst hub | 6.5 / 1.8 / 43.5 ms |
| Audit-trail write cost (trigger + hash chain, 8 clients) | ~6,000 audited commits/s; ~0.6 ms added per write |

Drug genealogy is shallow (4-8 steps), so a graph engine's strength never applies; it would add a second validated platform and rare skills. No major pharma batch-record vendor found uses one as the record store. Recall and impact results are stored and signed by QA with the as-of point, query version and hash.

### 4.6 Integrations: adapters, site gateway, simulators

*In plain words:* each outside system connects through a small replaceable adapter; for the demo, simulators stand in for machines and systems.

`integration-sdk` defines one contract per system type (messages, idempotency keys, error classes, reconciliation report). Inbound data enters only as domain commands through the same checks and audit trail, under integration identities that can never sign (DI-14, DI-31); outbound events use the transactional outbox. The **site gateway** at the automation boundary drives scales and printers, speaks OPC UA to presses, coaters, sterilisers, lyophilisers, particle counters and packaging lines, buffers with source timestamps and stamps device IDs (DI-20, DI-32).

| System | Direction | Key behaviour |
|---|---|---|
| ERP / WMS (ISA-95, B2MML) | both | Orders and BOM in; goods movements, yields, lot status out; no shipment of unreleased or uncertified stock |
| LIMS | both | Sample requests out; results, specifications, OOS status in; revised results force re-review |
| QMS | both | Deviations, CAPA, change records linked both ways; live status check at release |
| LMS / CMMS | in | Training status checked at action time; calibration and maintenance due dates, as-found failure impact |
| EMS / BMS | in | Particles, viable results, pressure differentials, T/RH, alarms; a feed gap is an alarm |
| SCADA / historian (OPC UA) | both | Setpoints read back before start; cycle data, trends, alarms; recipe version checked |
| Scales, lab instruments | in | Stable reading, raw string, device ID; calibration and daily check at point of use |
| Printers, coders, vision (GS1) | both | Variable data from the record, job voided if batch data change; challenge results |
| Serialisation L3/L4 (OPEN-SCS, EPCIS) | both | Serial pools, commissioning, aggregation; zero unexplained serials before release |

**Simulators** (`apps/simulators`): scale with stability and noise; press and coater publishing OPC UA tags; autoclave and lyophiliser cycle records; particle counter with configurable excursions; ERP, LIMS, QMS and LMS stubs with consoles; printers rendering to PNG/PDF. All can inject faults (feed gap, stale value, recipe mismatch) so exception paths are demonstrable and tested.

---

## 5. Core logic

### 5.1 Entities

*In plain words:* the main kinds of records the system keeps. The kernel part is identical in both editions; the process part has the same shape in both with different content.

- **Kernel (`kernel.*`):** organisation units with time zone; user accounts (unique forever, never deleted or reassigned; human, integration or break-glass); credentials, MFA factors, sessions, security events; roles, scoped role assignments (requester, approver, validity) and segregation rules; qualifications (SOP/MBR training, equipment, gowning, aseptic, eyesight, visual inspection) with validity; signatures (signer, legal-name snapshot, role, meaning, server time, zone, record and row version, content hash, authentication event, qualification snapshot, status, server seal) and outstanding signature requirements; audit events with per-aggregate hash chains, chain heads and external anchors; audit reviews; reason codes; content-addressed attachments; idempotency keys; outbox; time-sync samples; retention rules and legal holds; true-copy exports; versioned configuration; control-register snapshot, rule-table versions, market-resolution records.
- **Recipe (both editions):** MBR and versions (content, hash, based-on version, change-control reference, approved sites/lines/batch sizes, effective date, validity per market); library elements; parameter definitions; block-type registry; where-used index; production orders; batches (pinned MBR version, issued-record hash, market set, purpose); issued records (control-recipe snapshot); stage and step executions (loop path, attempt number); flow tokens and branch decisions; data points (value, unit, channel, reading number, entry mode, device, server time, limit evaluation and version, supersedes link); calculation results; timers and IPC slots; exceptions; deviation links; samples; yields; lots, containers, genealogy links; equipment and room occupancy (non-overlapping time ranges); line clearances; reviews; market dispositions; packaging orders with printed-material issue and reconciliation; shipment lines from ERP.
- **Tablets (`tab.*`):** tablet equipment classes; tooling sets with stroke counts and inspection status; sieves/screens with integrity history; FBD bags with dedication; press streams (side, station, layer); container-level IPC bracketing; printed-tablet QC approval; rework/recovered-material additions (TB-08).
- **Injectables (`inj.*`):** clean areas (grade A-D, ISO class, zone type, requalification dates); EM locations, plans, sessions, results, excursions; gowning, aseptic and visual-inspection qualifications; APS runs, envelopes, line status; intervention catalogue and log; sterilisation, depyrogenation and SIP cycles with load patterns; filter uses with pre-use and post-use integrity; lyophilisation cycles and loads; hold-time chain (dirty, clean, dried, sterile); WFI draws and samples; inspection results by defect code; CCI results; unit accountability ledger; sterile dossier sections.

### 5.2 State machines and key guards

*In plain words:* every record with a life cycle follows an explicit map of allowed moves; nothing can jump outside the map, not even by a direct database edit.

Each machine is defined once as data (XState). From it the build generates the database's allowed-transition table (checked by a trigger on every status change), the diagrams, the guard table for reviewers and the model-based test paths. Guards run on the server inside the transaction with the relevant rows locked. Sig(X) = e-signature with meaning X.

**MBR version** (merges architecture 4.1 and features E.6)
- DRAFT -> IN_VERIFICATION: author freezes a candidate; content hash computed; static gates pass with zero errors and every warning justified. Any edit returns to DRAFT and voids evidence gathered on the old hash.
- IN_VERIFICATION -> SUBMITTED: formula test vectors pass; sandbox test runs completed on this exact hash with coverage report; change record linked; Sig(PREPARED) by the author.
- SUBMITTED -> CHECKED: Sig(CHECKED) by an independent checker (S1).
- CHECKED -> APPROVED: Sig(APPROVED) by QA (not the author, S3; not the checker unless S4 allows); regulatory-conformity sign-off per market (PR-04); a changed Established Condition needs a regulatory assessment with reporting category; effective date set.
- APPROVED -> EFFECTIVE (system, at the effective date; no overlapping effective version for the same scope; predecessor -> SUPERSEDED in the same transaction). Validity is recorded per market; a batch may use the version only for markets where it is valid.
- Returns to DRAFT with reason (signatures invalidated); EFFECTIVE -> RETIRED by QA (no new batches; QA decides on running ones); pre-effective -> WITHDRAWN. The first batch after a change needs a post-change evaluation before release (IN-03); PPQ batches carry their flag (PR-09).

**Batch record** (processing record; each packaging order has its own record with the same states)
- PLANNED -> ISSUED: MBR effective and valid for every market in the set; batch size one of the approved sizes; batch number never used before (voided numbers included) and entered in the allocation register; rules resolved; control-recipe snapshot and hash stored; Sig(ISSUED) "issued, reproduction verified" (PR-10, IN-18, DI-42).
- ISSUED -> CANCELLED (nothing started; supervisor Sig + reason; number retired) or -> IN_PROGRESS (first step start, after production's receipt).
- IN_PROGRESS <-> ON_HOLD (supervisor, QA, or automatically on a blocking exception, QA hold point or environment hold; no step starts; timers keep running; only QA lifts a QA hold). -> ABORTED (production head and QA, two Sig + reason; outputs held or rejected by QA; equipment set dirty; the record is still reviewed).
- -> EXECUTION_COMPLETE (system): every step terminal, every required signature valid, every stage signed off, yields and reconciliations recorded, every IPC slot done or covered by an exception (PR-16).
- -> PRODUCTION_APPROVED: person responsible or designated production reviewer; every exception dispositioned or raised as a deviation; Sig(APPROVED). Always before QA review (S8).
- -> QA_REVIEWED: every exception-register item dispositioned individually (no bulk accept); batch audit-trail review signed by someone who performed or verified no step (S10, DI-25); required LIMS results present; reviewed content hash stored; Sig(REVIEWED).
- Any review state -> IN_PROGRESS ("reopen" for a correction; QA Sig + reason; review signatures invalidated). After the first market disposition the record is LOCKED; LOCKED -> UNDER_AMENDMENT (QA, linked deviation or change record; affected dispositions invalidated; QA decides on released stock) -> LOCKED after re-review and new signatures.

**Market disposition** (one per finished lot and market; there is no single batch-level "released" state)
- NOT_READY -> READY is computed by the release guard **G-REL**, never set by hand. G-REL (one serialisable transaction): processing and packaging records QA_REVIEWED with unchanged hashes; no open exception, non-terminal step or unreplaced invalidated signature; each linked deviation closed or cancelled, or impact-assessed for this batch with QA approval (critical: closed only by default; every deviation at least formally assessed for Indian-made product, IN-05(c)); an open investigation only with an e-signed justification and never for reconciliation discrepancies or registered-specification failures (PR-53); release tests passed with head-of-QC approval and all samples taken, including reserve samples (PR-44, IN-32); yield, printed-material and serial reconciliation within limits (PR-39, IN-17); consumed lots still usable; audit-trail review complete; post-change evaluation done (IN-03); QC decision on extra testing for rework or recovered material (PR-47); PPQ outcome where flagged (PR-09); no unassessed incident or critical alarm (DI-12, DI-49); market extras (US controlled-release tablets: release-rate result, PR-54; injectables: every sterile dossier section signed, sterilisation cycles reviewed, every EM result read with no plate still incubating and every excursion assessed, APS valid for the whole fill, sterility and endotoxin results, filter integrity, 100 % inspection and CCI, ST-70 to ST-72).
- READY -> RELEASED or REJECTED. **India (always):** authorised person or named delegate with a cited delegation, after head-of-QC approval; re-authentication; not a performer or verifier in the batch (S10 default). **US in set:** QCU disposition; if the AP belongs to the quality unit and holds the QCU-disposition permission, one signing act records both meanings (interpretation to confirm with customer QA); a contract giver's QCU disposition is recorded when applicable. **EU in set:** the AP release is a manufacturer release; the EU status stays AWAITING_QP_CERTIFICATION until authorised QA records the external certification reference; with the tenant switch on, only registered QP accounts certify in-system, into an append-only register.
- Markets are independent (S32). Released status is pushed to ERP, which cannot ship unreleased or uncertified stock (DI-39).

**Step execution:** PENDING -> ENABLED (token arrives) -> IN_PROGRESS (batch not on hold; user holds role and every required qualification now; equipment, room and material checks pass; time limits respected) -> AWAITING_VERIFICATION (mandatory data present, calculations done, minimum duration elapsed, no blocking exception; Sig(PERFORMED)) -> COMPLETED (Sig(VERIFIED)/Sig(WITNESSED) by someone who neither performed nor entered data in the step). NOT_APPLICABLE is set only by the system for untaken branches; item-level "N/A" only on items the MBR marks conditional, with reason and signature (PR-16). SKIPPED only for skippable phases, approved by a different supervisor or QA, never for CPP/CQA inputs, reconciliation, line clearance or release signatures. VOIDED plus a new attempt for a legitimate repeat (the voided attempt stays visible). "Correct" before QA review keeps the old value, invalidates dependent signatures and recalculates dependents. Status is re-checked at commit and at signing, not only at step open.

**Exception:** OPEN -> DISPOSITIONED (no impact with justification, or deviation raised) by a supervisor or QA user who did not cause it; blocking exceptions stop step completion; never deleted; mandatory types cannot be switched off (DI-26).

**Deviation** (built-in stand-in; with an external QMS the status is mirrored and checked live at release): OPEN (linked batches release-blocked at once) -> UNDER_INVESTIGATION (QA classifies minor/major/critical, owner, due date) -> IMPACT_ASSESSED (per batch: none, potential or confirmed with rationale; QA Sig) -> PENDING_CLOSURE (root cause or most probable cause; "human error" needs a system-factor assessment; CAPA references; non-empty list of other batches and products assessed with reasons, ST-71) -> CLOSED (QA Sig). OPEN -> CANCELLED (QA, reason). Nobody approves their own deviation (S7).

**Equipment** (three independent regions): *cleanliness* CLEAN -> IN_PRODUCT -> DIRTY (dirty-hold clock) -> CLEANING -> CLEAN (manual cleaning: performer plus different verifier; validated CIP: one verifier, S22; clean-hold clock starts); injectables add DRIED and STERILISED with hold limits and re-sterilisation of product-contact items every batch unless a validated campaign exists (ST-38). *Fitness*: QUALIFIED, CALIBRATION_DUE_SOON, CALIBRATION_OVERDUE, OUT_OF_TOLERANCE, MAINTENANCE, OUT_OF_SERVICE, RETIRED; an as-found calibration failure lists every batch since the last good calibration and opens a linked deviation. *Usage*: IDLE or IN_USE(batch), with non-overlapping occupancy. Use guard: clean within hold at the required cleaning level, qualified, calibration valid beyond planned use, idle; tablets: tooling inspected and within stroke limit, sieve checked; injectables: sterile items within sterile hold. Instruments are re-checked at every reading.

**Room / line:** DIRTY -> CLEANING -> CLEAN -> CLEARED_FOR_BATCH (clearance performed and, where required, verified by a different person; previous product and batch recorded) -> IN_USE -> DIRTY; OUT_OF_SERVICE. One active packaging order per line (PR-35).

**Material lot:** QUARANTINE (incl. on test) -> RELEASED (tests passed, CoA reviewed, approved supplier, identity test as resolved; QC/QA Sig) or REJECTED; -> RELEASED_FOR_FURTHER_PROCESSING (intermediates, QA hold point); RELEASED <-> ON_HOLD (QA); RETEST_DUE and EXPIRED by date; RETURNED and RECALLED by QA; CONSUMED at zero; DESTROYED only with a witnessed record. A finished lot leaves quarantine only through a market disposition. Consumption guard: right item, usable status, before retest and expiry, container dispensed for this batch (scan), quantity available, hold time not exceeded.

**Clean area and EM** (injectables): CLEANING_DISINFECTION -> CLEAN_READY (cleaning verified; isolators: passed bio-decontamination and glove tests) -> IN_OPERATION (validity not expired; requalification within 6 months for A/B and 12 months for C/D; pressure and HVAC within limits from the BMS; EM session started; every entrant qualified for the grade; APS valid and planned interventions covered) -> DIRTY; any -> ENVIRONMENT_HOLD on a non-viable action alarm or pressure failure beyond its allowed time; -> REQUALIFICATION after shutdown or construction. **EM result:** RECORDED -> ALERT_REVIEWED, or EXCURSION_OPEN (any Grade A growth is action level, with no alert tier) -> deviation created and linked to every batch whose EM session or area occupancy overlaps the sampling window -> IMPACT_ASSESSED -> CLOSED; Grade A/B isolates identified to species (ST-21); each result evaluated individually, never only as an average (IN-42).

**APS status** (per process x line x shift x container-closure configuration): NOT_QUALIFIED -> QUALIFIED -> DUE -> EXPIRED at last success + about 6 months (no grace by default, ST-29); -> SUSPENDED on a failed or invalid APS. Where any EU/PIC/S product runs on the line, any contaminated unit fails; product since the failure is quarantined and batches back to the last success reviewed (ST-33). The qualified envelope (duration, headcount, interventions, container size, speed) is derived only from APS records (ST-31) and checked at issue and fill start.

**Operator qualification:** NOT_QUALIFIED -> IN_TRAINING -> QUALIFIED -> EXPIRING -> EXPIRED; QUALIFIED -> SUPERVISED_ONLY / RETRAIN / SUSPENDED (failed gown or glove monitoring, failed APS, deviation) -> QUALIFIED only with requalification evidence; any -> REVOKED. Unsupervised Grade A/B signatures need gowning qualification within 12 months, current aseptic training and a successful APS within 12 months on this line covering the activity signed (ST-08). The status found is stored with each signature.

### 5.3 Invariants that must always hold

Each has an application guard, a database enforcement (constraint, trigger or privilege), a bypass test that attacks it with raw SQL under the application's role, and an invariant query that must return zero rows; production runs the same queries on a schedule.

| ID | Invariant |
|---|---|
| INV-01 | A GMP batch has exactly one pinned, immutable MBR version, which was EFFECTIVE and in scope at issue |
| INV-02 | The issued control recipe never changes; its stored hash matches |
| INV-03 | A verifier or witness is never the performer or anyone who entered data in that step |
| INV-04 | MBR author, checker and approver are distinct (checker = approver only if S4 allows) |
| INV-05 | At the instant of any market release, G-REL held for that market ("as of" check) |
| INV-06 | Data points, calculations, genealogy links, signatures and audit events are insert-only; corrections add linked rows with a reason |
| INV-07 | Every GMP insert or update writes an audit event in the same transaction (user, role, server time, zone, old/new, reason for changes) |
| INV-08 | Every audit chain is gapless and verifies; anchors match |
| INV-09 | A signature is valid only while its content hash is unchanged; a change invalidates it in the same transaction |
| INV-10 | Every signature follows a successful re-authentication of the same person in the same request with the components the policy requires |
| INV-11 | No administrator role and GMP role for one user in one scope; accounts never deleted or reused |
| INV-12 | Equipment occupancy never overlaps; equipment is used only clean within hold, qualified and calibrated |
| INV-13 | Consumption only from usable lots; lot quantity never negative |
| INV-14 | Every consumption and output creates genealogy links in the same transaction |
| INV-15 | A stage in a room/line starts only after a passed clearance recorded after the previous occupancy |
| INV-16 | Business timestamps come only from the database server clock |
| INV-17 | At most one EFFECTIVE version per MBR and scope at any instant |
| INV-18 | Test/simulation data never enter GMP tables; GMP batches only from EFFECTIVE versions |
| INV-19 | Loops never exceed their maximum without an exception; all iteration data kept |
| INV-20 | No step completes before its minimum duration; every maximum breach creates an exception |
| INV-21 | A locked record changes only through the amendment process |
| INV-22 | Nothing is purged before retain-until or while on legal hold |
| INV-23 | Injectables: filling only in a CLEAN_READY area with active EM session, valid APS and qualified operators; release waits for all EM results and excursion assessments |
| INV-24 | Tablets: compression only with inspected tooling within stroke limits |
| INV-25 | Derived values (expiry, theoretical yield, scaled and potency-adjusted quantities, counts, yields) are computed, never typed |
| INV-26 | Every signer held the required role and qualification at that instant; the evaluation is stored |
| INV-27 | Batch numbers, user IDs and signature IDs are never reused |
| INV-28 | India is in every market set; no resolved value is looser than India's |
| INV-29 | Every rule evaluation stores value, governing market and rule-table version |
| INV-30 | Production approval precedes QA review |
| INV-31 | No verification by zero humans; single-person automated checking only on the step types 21 CFR 211.68(c) covers (S5a) |
| INV-32 | Labelling and printed-material reconciliation always runs; no waiver for Indian-made product |
| INV-33 | Reworked or reprocessed output gets a new batch number linked to its parents |
| INV-34 | An MBR cannot become EFFECTIVE unless every intermediate has a hold time, every timer and yield checkpoint has limits and a source, and (tablets) the compression sampling interval is at most 30 minutes |
| INV-35 | Audit-trail review and market disposition are never signed by anyone who performed or verified a step in that batch (default policy) |
| INV-36 | Injectables: a pre-use filter integrity test is always recorded; the post-use test precedes removal from the housing |
| INV-37 | Injectables: a passing sterility test never overrides a process failure (ST-68) |
| INV-38 | GMP decisions never read a read model; they re-read system-of-record tables in their transaction |
| INV-39 | One market's disposition never changes another's |

### 5.4 Audit trail

*In plain words:* the database writes a tamper-evident diary of every change, and nothing can switch it off.

- **Capture:** row-level triggers on every GMP table write field-level entries in the same transaction; the application sets the actor context (user, role, session, reason, correlation ID, source) and a missing context fails the transaction. The domain layer adds a plain-language business entry with the same correlation ID ("weighing recorded, 12.503 kg, balance B-17, container C-0042").
- **Content:** who (ID, legal name, role), what (record, field, old/new), when (server UTC + site zone and offset), why (reason code and text, mandatory for every change or void after first entry), how (UI, API, integration, system; device). Creation is audited (DI-22).
- **Always on** (DI-23): no setting disables, pauses, filters, edits or purges it; a start-up and hourly check confirm every GMP table's trigger is enabled, otherwise GMP writes are refused and an alarm raised.
- **Tamper evidence:** per-aggregate hash chains (batch, MBR version, lot, equipment, user, configuration area); every few minutes the chain heads form a Merkle root written to write-once storage (optionally an RFC 3161 time-stamp); nightly re-verification. A superuser who rewrites rows still cannot match the external anchors, and pgaudit records the session.
- **Review:** validated, versioned report per scope (batch, MBR version, system period, user access); criticality orders and highlights but never hides a post-entry change (DI-25); the review stores the report version and hash.

### 5.5 Electronic signatures

*In plain words:* the server shows exactly what you sign, you re-enter your credentials, and the signature is mathematically tied to that content.

1. **Challenge:** the client sends record, meaning and the hash of what it displays; the server rebuilds the canonical content (values, units, limit evaluations, performer, MBR version, attachment hashes), checks the hash, and returns a single-use challenge valid for 120 s with the manifestation preview.
2. **Sign:** re-authentication (password or badge + PIN, or identity-provider step-up; MFA for disposition, certification and remote sessions); guards (role, segregation, qualification, performer is not verifier, record state); signature row with content hash, authentication event, name, role, meaning and server time; state change, audit and outbox rows; the row is sealed with a server key in a KMS/HSM. Any failure aborts everything.

- Meanings come from a closed catalogue of every signature point a rule requires (DI-35); customers can add points, not remove the minimum. Manifestation: legal name, user ID, role, meaning, date/time with offset and zone on every display and print (DI-36). Any change to signed content (including a recalculated dependent value) invalidates the signature in the same transaction; it stays visible and a new signature is required (DI-37). Both components at every signing by default (DI-38); no "remember me", pre-signing or proxy signing; the verifier signs with own credentials in the same dialog. Identity verified before a signing account is activated; first-use acknowledgement; lockout after 5 failed attempts by default (3-5 allowed); for US tenants, a record of the 11.100(c) certification letter. India option: a second signature for selected meanings with a Class 3 DSC or eSign over the same content hash (IN-10, Decision 3).

### 5.6 Time

All GMP timestamps come from the database server clock, stored in UTC with the site zone (displays show site time with offset regardless of browser); durations use UTC instants, so daylight-saving changes cannot distort them (DI-27). A monitor records host clock offset; above the alarm threshold (default 1 s, allowed 0.1-5 s) it raises a data-integrity incident and flags entries in the drift window. It does not block capture, because blocking without a fallback pushes people to scrap paper (DI conflict 17); the contingency path exists instead. Device and user-claimed times are stored as separate information (late entries flagged for review); a per-batch counter gives a total order independent of clock resolution.

### 5.7 Concurrency and idempotency

Optimistic locking on every record (stale commands receive the current state); short row locks in a fixed order (batch, step, lot, equipment, chain head) for rules spanning records; exclusion constraints for no-overlap rules; serialisable transactions with retry for release, certification and MBR effectivity. Every mutating request carries an idempotency key, so double clicks and network retries are harmless. Several operators can work one batch in parallel branches; locks are per step.

### 5.8 A running batch is never affected by later changes

The batch pins its MBR version; the issued record is a hashed snapshot of the resolved, scaled master; every internal reference (library elements, parameter definitions, material and equipment-class versions, SOP revisions, templates) is pinned by version and hash, never "latest" (DI-10). The rule-table version and resolved values are stored at issue; a newer table applies to a running batch only through a QA change-control decision that triggers an audited re-resolution. Block handlers are versioned and old versions stay in the code base, so a running batch keeps the exact semantics it was issued with; a pre-upgrade check refuses any upgrade that would change them. The batch records the software release it ran on (DI-03). A superseded MBR version starts no new batches but running ones continue unless QA decides otherwise (PR-05).

### 5.9 Disagreements between inputs and their resolution

1. **MBR state names** (architecture vs features E.6): merged into the machine in 5.2, keeping all gates and the three signatures.
2. **Kernel block numbering** (K-01..K-26 vs KB-01..KB-19 for the same generic blocks): one canonical list G-01..G-25 with both aliases (6.6).
3. **Batch "RELEASED" state with an in-system QP signature** (architecture 4.2) vs per-market disposition with no QP slot at the Indian site (features A.6, India correction 8, PR-55): per-lot, per-market disposition; external QP reference; in-system QP only by switch.
4. **Blocking signatures on clock drift** (architecture 5.4) vs alarm-flag-contingency (DI-27, DI conflict 17): DI catalog wins.
5. **Offline signing on devices** (features extra 12) vs "terminals never sign" (architecture 5.6): not in v1 (Decision 12).
6. **Re-authentication** always both components (architecture INV-10) vs a QA-approvable relaxation (DI-38): strict default, relaxation as a policy switch where DI-38 allows.
7. **Default sterile market profile** "EU + US" (ST catalog) vs "India + EU + US" (injectables spec): India always present; the line-level default is India + EU + US until real product qualifications say otherwise.
8. **Stage frame K-02** exists only in the Tablets spec, but IN-15 applies to both: it becomes generic block G-02.
9. **Late-entry window** defaults differ (kernel: after the planned step window; injectables: 15 min): kept as edition defaults, configurable.

---

## 6. MBR designer and building blocks

### 6.1 Structure (ISA-88)

*In plain words:* a master record follows the industry's recipe standard, from the whole procedure down to single steps.

Procedure (one MBR per product, strength, batch size and, for injectables, line) -> **stage** bound to a room, line or equipment train -> **operation** (e.g. "dry to LOD endpoint", "PUPSIT") -> **phase** = one configured block. Each stage runs in a stage frame (G-02) that records start and end, rooms and equipment with previous product and batch, the person responsible (IN-15), stage yield, and a derived "completed per MBR / with deviations" statement nobody can type. Packaging is a separate procedure per packaging order, linked to the bulk batch (PR-01, IN-14).

### 6.2 Block-structured flow

*In plain words:* the designer draws a flowchart, but only with shapes guaranteed to finish properly; there are no free "go to" arrows.

- **Sequence; parallel** branches with an all-must-finish join; **alternatives** decided by recorded data, by an authorised operator's choice with reason, or at issue for variants (untaken branches are marked not applicable by the system); **repeat-until loops** with a mandatory maximum (and optional duration) that raise an exception when exhausted, allowed only on process endpoints (LOD, pH, weight gain), never on release or acceptance tests ("re-blend until uniformity passes" is refused; that is reprocessing, G-24); **hold points** that lock everything downstream until QA signs; **library calls** to pinned element versions.
- **Time constraints** are a separate list of min/max durations between any two step events, even across stages or batches (dirty hold, bulk hold, compounding start to end of filtration); per iteration inside loops; void if an end lies in an untaken branch.
- **Exceptions are not arrows:** each block declares what it can raise (limit, time, status, missing verification, interface failure) and the kernel turns it into an exception record. Authorised roles can always hold or abort a batch. Rework runs only as a separately approved reprocessing procedure invoked by QA (PR-47, IN-19).

### 6.3 Static verification gates

The same validator runs live in the designer and authoritatively on the server; errors block submission, warnings need a recorded justification, and each message names its rule and control (e.g. "Timer lacks validation reference (ST-37)").

- **Structure:** one start and end; every step reachable and able to finish; only declared loops; matched splits and joins; no edge crossing a parallel or loop boundary; loops have a maximum and an exit that reads a value written inside; time constraints consistent.
- **Data:** every value written before it is read on every path; expressions parse, type-check and unit-check; no calculation cycles; branch conditions exhaustive and exclusive; parallel branches never write the same value or claim the same equipment or lot unsequenced.
- **GMP content:** every BOM line consumed on every completing path; each stage starts with clearance and ends with yield/reconciliation; equipment use preceded by a status check; critical parameters have unit, precision, limits with source and pharmacopoeia edition, and an accuracy-check method for manual entry (DI-30); performer plus checker on significant steps (PR-14); timers have validation references; yield checkpoints have min and max (PR-31); reconciliation limits exist (PR-39); content minima for the market set, including India's hold time for every intermediate and India-domestic artwork (PR-03, IN-13, IN-14); all references effective; Established-Condition elements have a reporting category.
- **Tablets:** compression sampling interval at most 30 min (IN-35); station-wise start check; tooling and sieve checks before and after use; time and temperature on every mixing, blending and drying step (IN-13); QC gate after printing (IN-37).
- **Injectables (IB-01):** contamination-control-strategy reference on every critical control point; sterility-route justification; step grades consistent with mapped rooms (IN-41, ST-14); pre-use filter test always, PUPSIT or a referenced waiver; 100 % CCI for fusion-sealed containers up to 100 mL; a sterilisation method for every product-contact item; open containers only through Grade A; mandatory sterile timer set; 100 % visual inspection.
- **Also:** market-resolution run showing resolved values and governing markets (IN-52); translations complete.

### 6.4 Expression language

*In plain words:* calculations use a small formula language with exact decimals and units that cannot loop forever and gives identical answers in browser and server.

- Pure and deterministic; no I/O, user functions or unbounded loops; reads only declared inputs; aggregates only over recorded series.
- **Decimal** at 34 significant digits, never binary floating point (raw 94.95 against a 95.0-105.0 limit must round to 95.0 and pass).
- **Units:** UCUM plus a semantic tag (% w/w, % label claim, % LOD, % yield, count), checked at design time: adding % LOD to % yield, or breaking force in kg/cm2 (a pressure), is refused.
- **Rounding** only at limit comparison and display, always half-up, to the limit's decimal places (USP) or significant figures (Ph. Eur.) per its rule set; full precision stored, never replaced by a rounded value.
- **Explicit errors:** missing input, division by zero or out-of-range raise an exception, never a silent zero.
- **Closed function library:** arithmetic, min/max, mean, SD, RSD, yield, potency/assay/LOD-adjusted quantity with compensating excipient (C-01..C-06), reconciliation, durations, F0 and lethality, compendial acceptance tables. Customers parameterise; they do not re-implement compendial statistics.
- **Test vectors** by the author (typical, at limits, at rounding boundaries, absent inputs) run automatically into the verification report. Each result stores expression version, inputs with units and sources, and output; correcting an input recomputes dependents, keeps old results and flags signed dependents.

### 6.5 Versioning, where-used, simulation and test runs

- Every reference pinned by version and hash. Where-used answers "which effective MBRs and running batches use material M, equipment class E, block B v3, SOP S rev 7 or Established Condition X"; a library change yields an impact report and optional bulk draft versions under one change control, each still verified and approved. Reviewers see a structured difference against the previous effective version plus the full rendering.
- **Automated simulation** (no writes): every path with loops unrolled to their maximum; boundary values for every guard and limit (on, just inside, just outside, missing); calculations against golden inputs; coverage report.
- **Sandbox test runs** on the real screens in a segregated store with reserved identifiers and a "TEST, NOT GMP" watermark: no real inventory, genealogy, equipment status or release, never in GMP reports; a trigger refuses GMP issue from non-EFFECTIVE versions (DI-05, INV-18). The same store serves training/simulation mode.
- **Generic masters:** structure version + approved parameter set; approval covers the pairing and the issued record cites both; only declared parameters vary.

### 6.6 Building blocks per edition

**Generic blocks** (recipe-core if shared), with aliases from both specs:

| Canonical | Tablets | Injectables | Main controls |
|---|---|---|---|
| G-01 Issuance and header | K-01 | KB-01 | PR-01, PR-10, IN-18, IN-52, DI-42 |
| G-02 Stage frame and summary | K-02 | new | PR-16, IN-15 |
| G-03 Instruction and acknowledgement | K-03 | KB-02 | PR-03, DI-10 |
| G-04 Process parameter record | K-04 | KB-02 | PR-08, IN-13, DI-07, DI-30 |
| G-05 Observation capture | K-05 | KB-02 | PR-11, DI-28, DI-41 |
| G-06 Automated equipment phase | K-06 | KB-03 | PR-14, DI-31, DI-32, DI-49 |
| G-07 Weighing and dispensing | K-07 | KB-05 | PR-18 to PR-20, IN-23, IN-24 |
| G-08 Identification and charge-in | K-08 | KB-06 | PR-21, DI-30 |
| G-09 Equipment status, cleaning, logbook | K-09 | KB-07 | PR-22 to PR-24, PR-27, IN-25 |
| G-10 Room/line status and clearance | K-10 | KB-08 | PR-25, PR-26, PR-34, IN-21, IN-26 |
| G-11 Environmental condition check | K-11 | (IB-02, IB-05) | PR-25, IN-39 |
| G-12 Sampling | K-12 | KB-09 | PR-29, PR-44, IN-20, IN-32 |
| G-13 IPC with readings and statistics | K-13 | KB-09 | PR-29, IN-35, DI-29 |
| G-14 Calculation | K-14 | KB-04 | PR-31, DI-33 |
| G-15 Timer, hold time, transfer | K-15 | KB-10 | PR-30, IN-13, IN-15 |
| G-16 Verification / witness | service S-3 | KB-11 | PR-14, PR-20, DI-30 |
| G-17 QA hold point | K-16 | KB-12 | PR-45, IN-37 |
| G-18 Exception and deviation link | service S-4 | KB-13 | PR-13, PR-49 to PR-51 |
| G-19 Flow control | K-17 | KB-14 | DI-34, PR-13 |
| G-20 Yield and reconciliation | K-18 | KB-15 | PR-31, PR-39, IN-17 |
| G-21 Printed materials, coding, challenges, serialisation | K-19..K-21 | KB-17 | PR-32 to PR-42, IN-16, IN-22, IN-31 |
| G-22 Output containers, holds, split/merge | K-22, K-25 | KB-16 | PR-38, PR-45, PR-57 |
| G-23 Returns, rejects, destruction | K-23 | KB-18 | PR-40, PR-46, PR-48 |
| G-24 Reprocessing / rework gate | K-24 | KB-18 | PR-47, IN-18, IN-19 |
| G-25 Sign-off, review, market disposition | K-26 | KB-19 | PR-52 to PR-56, IN-04, IN-05, DI-25, DI-26, DI-39 |

**Tablets (TB-01..24).** *Dispensing and granulation:* TB-01 potency/assay/LOD-adjusted dispensing with compensating excipient; TB-02 sifting and milling with screen checks before and after; TB-03 binder/coating/sugar solutions with use-by; TB-04 wet granulation endpoint; TB-05 drying with LOD loop and filter bags; TB-06 roller compaction; TB-07 blending, lubrication, blend uniformity; TB-08 rework/recovered-material addition. *Compression:* TB-09 tooling custody and inspection; TB-10 set-up and first-off; TB-11 periodic IPC scheduler with multi-channel streams and bracketing hold; TB-12 weight IPCs; TB-13 breaking force, thickness, appearance; TB-14 friability; TB-15 disintegration; TB-16 bilayer; TB-17 reject and detection devices. *Coating and finishing:* TB-18 coating and weight gain; TB-19 printing with QC approval; TB-20 inspection, sorting, AQL. *Packaging:* TB-21 blister/strip set-up with independent check; TB-22 leak test; TB-23 bottle line; TB-24 secondary/tertiary and finished-pack examination. Mainly IN-13, IN-34 to IN-39, PR-19, PR-27, PR-29, PR-33 to PR-41, PR-47, DI-29, DI-33.

**Injectables (IB-01..30).** *Design and readiness:* IB-01 sterile MBR validator; IB-02 line/room readiness; IB-03 personnel, gowning, aseptic roster; IB-04 EM/PM batch window; IB-05 utilities and alarms. *Preparation:* IB-06 component/RTU acceptance; IB-07 container and closure preparation; IB-08 sterilisation, depyrogenation, SIP; IB-09 sterile items, transfers, aseptic assembly; IB-10 isolator/RABS decontamination and gloves; IB-11 single-use systems. *Processing:* IB-12 compounding; IB-13 sterilising filtration and integrity; IB-14 sterile time limits; IB-15 APS status and envelope; IB-16 interventions; IB-17 filling and closure; IB-18 fill weight/volume and device IPC; IB-19 capping; IB-20 lyophilisation; IB-21 terminal sterilisation (loads as sub-batches); IB-22 BFS/FFS. *Inspection and release:* IB-23 visual inspection and AQL; IB-24 CCI; IB-25 unit accountability; IB-26 event-driven sampling; IB-27 sterility and endotoxin results; IB-28 APS record; IB-29 contamination-event impact; IB-30 sterile dossier and certification gate. Every ST-01..ST-79 control and IN-40..IN-51 maps to at least one block.

A block type is vendor code (config and data schemas, handler, exception rules, UI, review renderer, edition tag, version). Customers cannot create primitive types; a partner extension would be bespoke software (GAMP category 5), not configuration.

---

## 7. Users, segregation of duties and key screens

### 7.1 Roles

*In plain words:* each person gets roles for specific sites and areas; role, training and "not the same person" rules are checked at every action, not only at login.

29 kernel roles (features A.2) in four groups: **master records** (author, independent checker, QA approver, regulatory-conformity signer, master-data steward); **execution** (batch issuer, operator, verifier, designated dispenser, shift supervisor, person responsible for a stage, head of production, shop-floor QA, labelling store, maintenance/calibration/cleaning); **quality and release** (QA and audit-trail reviewer, head of QC, QC analyst, India authorised person or named delegate, US QCU disposition signer, EU QP only with the switch); **governance** (training coordinator, system administrator, process owner, CSV lead, read-only auditor, contract-giver reviewer, service account, time-boxed vendor support). Edition skills are qualifications on operator and verifier roles, not new authority levels (Tablets: granulation, compression, IPC, packing, blister clearance verifier, printed-tablet QC approver; Injectables: aseptic operator, sterilisation operator and cycle reviewer, EM sampler, visual inspector, APS reader and QC observer, microbiology approver, QA real-time authoriser, sterile certifier and others). Grants are scoped (entity, site, area, product, line, step type) and need a separate approver.

### 7.2 Segregation of duties

*Static* conflicts are refused at role assignment (administrator + GMP role; write rights on a generic account); *dynamic* conflicts are refused per record at the moment of action (verifying your own entry, reviewing your own batch, approving your own MBR or deviation).

- **Locked:** S1-S3 (author not checker, QA approves every MBR, no self-approval); S5 performer is not verifier on significant steps, dispensing, charge-in, yields and critical manual data (US rule for all markets); S6 verifier's own credentials; S7 no self-approved deviation; S8 production approval before QA review; S9 production head is not quality head on a batch; S10 performers and verifiers barred from the batch's audit-trail review and disposition; S11 only the market's release authority releases; S12-S16 administrator separation, break-glass limits, requester is not approver, no shared write or signing service accounts, no proxy signing; S18-S23 designated dispensers, authorised labelling issue, status changes by QC/QU only, QC approver is not the analyst, manual-cleaning and blister-clearance performer is not verifier; S26-S27 yield verifier and unusual-event approver independence; S29-S31 sterile approvals; S32 markets independent.
- **Configurable:** S4 checker may approve (default no); S5a one human verifier for validated automated operations only on 211.68(c) step types (default keeps two people for US-market dispensing and charge-in, Decision 8); S17 approved technical staff (default on for Indian licences); S24 second person on packaging clearance (default on; always on for blister/strip); S25 approval level for critical-data corrections; S28 QA approval of voids (default on).

### 7.3 Key screens

- **Shop floor:** operator cockpit (one queue of steps, verification requests, IPCs and timers, showing why an item is not available); step screen (one action at a time; fixed header with product, batch, IN/US/EU badges, stage, room, equipment, user, timers, connection; prerequisites re-checked at commit and signing); scan dialog; dispensing (live gauge with tolerance band, stable-reading capture, potency trace, label print, automatic two-person mode when the scale is offline); IPC entry (mean, RSD and mini chart from committed values, next-check countdown, station grid); exception capture; signature dialog (lists exactly what is covered, never pre-filled); verification queue with inline post-entry changes; equipment/room board and e-logbook; late-entry and contingency screens; [T] packaging line with live reconciliation; [I] aseptic quick-log (interventions only from the APS-qualified catalogue), visual-inspection station.
- **QA review by exception:** production review first; then exception register (all mandatory types, grouped, each item Accept / Query / Escalate individually, keyboard "next item", no bulk accept), item detail (expected vs actual, limit source, audit snippet, instruction as issued, raw device data) and the full record one click away; audit-trail review panel; "Full review" or "RBE rule set vN" badge; signature enabled only when production approval, every item and the audit-trail review are complete.
- **Release cockpit:** one tab per market with a red/green G-REL checklist linked to evidence; justified-open-investigation path where allowed; EU tab "awaiting QP certification" with the reference field.
- **MBR designer:** synchronised canvas and outline tree (keyboard alternatives to every drag); edition-only palette with pinned versions; property panel; formula editor with test vectors; operator preview per language; IDE-style validation panel citing control IDs; market panel; where-used; difference view; test-run launcher with coverage; review mode (Prepared -> Checked -> Approved).
- **Dashboards** (right-first-time, exception Pareto, review cycle time, deviation ageing, hold-time risk; [T] IPC SPC, press OEE; [I] EM trends, interventions vs APS envelope, APS due dates, inspection rejects), each showing data age and drilling to the record, never used for GMP decisions. Also: genealogy explorer, audit-trail viewer, separate administration console, read-only inspection workspace.

### 7.4 Accessibility, languages and gloved use

- **Accessibility:** WCAG 2.2 AA as target; shop-floor targets at least 44 x 44 CSS px (primary actions about 15-20 mm for double gloves); state shown by colour + icon + word; contrast at least 4.5:1; keyboard and screen-reader support on office screens; warning with one-tap extend before inactivity lock; a non-memory sign-in option on kiosks (badge + biometric or hardware key) subject to customer IT/QA sign-off; automated axe checks in CI.
- **Languages:** English + Hindi in v1; regional languages per customer (candidates Gujarati, Marathi, Telugu, Tamil, Kannada, Bengali) with full Indic shaping. MBR translations are reviewed bilingually and approved with the MBR version; machine translation only as draft; the record stores the language shown; language never changes a limit, unit or meaning. GMP values in Western digits with SI symbols; lakh/crore grouping only as display option; parsed numbers echoed with unit before commit; dates like 27-SEP-2026.
- **Gloves and cleanrooms:** scanner first, keyboard last; numeric keypads with fixed units; no drag, multi-finger or hover-only controls; large fonts readable through visors; [I] paperless Grade A/B on registered, grade-rated devices with quick-log buttons. Gowned usability tests happen with pilot customers.

---

## 8. Helpful extras (ranked) and what is deferred

Ranked by value against effort (features spec C). None turns a block into a warning or takes a GMP decision.

| Rank | Extra | Plan |
|---|---|---|
| 1 | Scan-everything with GS1 and Indian API QR parsing (manual identity entry is an exception needing verification) | v1 |
| 2 | Right-first-time and exception analytics | v1 |
| 3 | Operator cockpit with server-side timers and escalation | v1 |
| 4 | [I] Consolidated sterile timeline for review | v1 |
| 5 | Genealogy visualisation with mock-recall simulator | v1 |
| 6 | Training/simulation mode (same segregated store as test runs) | v1 |
| 7 | Hindi UI (regional languages per customer) | v1 |
| 9 | Change-impact explorer | v1 |
| 11 | Paper-fallback kit generator (delivers mandatory DI-43) | v1 |
| 15 | Certified evidence export supporting a BSA s.63 certificate (format to confirm) | v1 |
| 13 | Class 3 DSC / eSign for key signatures | interface v1; provider after legal opinion (Decision 3) |
| 8, 10, 14 | Batch comparison overlay; [I] EM mobile sampling app; camera-based code verification | v1.1 |
| 17-19 | CPV/APR feed; rich-media instructions; BatchML/B2MML export | v1.1 |
| 16, 22 | Foot pedal/voice for non-critical confirmations (never signatures, values or identity); [T] MACO/HBEL calculator | later |
| 12 | Offline terminal mode under DI-28 | deferred (Decision 12) |
| 20, 21 | AI-assisted MBR digitisation and review hints (advisory, logged, never the review) | after EU Annex 22 is final |
| 23-25 | Predictive ETA; graph analytics copy; AGV transport | deferred |

Never offered: a "skip review for testing" switch, free scripting, or anything that turns an interlock into a warning.

---

## 9. Quality and validation strategy

*In plain words:* correctness is shown by thousands of automatic tests that attack the rules from every side, and the validation documents are generated from those same tests, so they stay current.

### 9.1 Test layers

| Layer | What it proves |
|---|---|
| Unit (Vitest) | Each guard, calculation, limit evaluation, rounding rule, block handler and adapter |
| Property-based (fast-check) | Over random inputs: the evaluator matches an exact-rational reference; unit conversions round-trip and dimension errors are refused; USP and Ph. Eur. rounding; hashing ignores key order and any signed-field change alters the hash; limit classes consistent; every random block-structured flow compiles to a sound graph and every broken one is rejected with the right rule |
| Model-based (XState paths, fast-check commands) | Every transition and guard-false branch replayed against the real API and database; random command sequences (issue, record, correct, sign, verify, skip, void, hold, abort, deviation, release) with all invariant queries returning zero rows after every command; race interleavings (two operators on one lot, correcting while someone signs, releasing while a deviation is linked) |
| Database bypass | Raw SQL as the application role cannot update a data point, delete an audit row, overlap occupancy, set a disposition or insert an unauthenticated signature |
| Golden batches | End-to-end batches with exact expected outputs (states, exception report, quantities, yields, genealogy, record hash, normalised true copy), each with happy and exception-rich variants |
| Browser end-to-end (Playwright) | Real screens as each role, producing step-by-step evidence (expected, actual, screenshot, time) as PDF test records |
| Mutation (StrykerJS) | Planted bugs are caught: at least 90 % score for guards, signature invalidation, limits, rounding and flow validation; 80 % elsewhere; survivors in high-risk code need a test or written justification |
| Non-functional | Load (50,000-entry batch review under 5 s; p95 command under 300 ms on site LAN), restore with chain verification, accessibility, translation completeness, dependency and licence scans |

**Golden batches.** Tablets GB-T-01 from the user's sample BMR: high-shear wet granulation, fluid-bed drying with LOD loop, film coating, 2,00,000 tablets; salt-to-base potency with compensating excipient; optional extra-IPA branch; rework addition limited to 3 % of batch and 3 months age; left/right IPC; "approved for coating" and "release for packing" gates; inspection rejects and witnessed destruction. The sample's data problems become negative tests: hardness in kg/cm2 refused as a pressure unit; trihydrate label on an anhydrous molar mass flagged; rework without an approval step refused; its (A + B)/T yield shown beside the good-output yield. Also direct compression, roller compaction, bilayer, blister with printed-material reconciliation, bottle. Injectables: isolator vial fill with EM and interventions, lyophilised vial, terminally sterilised ampoules, APS; negative variants: EM action result after incubation, failed post-use filter test, unqualified intervention, expired APS.

### 9.2 Validation approach and deliverables

- **GAMP 5 category 4** platform, validated once per vendor release, plus **verification of every MBR**, library element, workflow, report, calculation, interface mapping and RBE rule set before it becomes effective (DI-04: qualifying the platform does not prove a given electronic master is right). No script escape hatch, so configuration never becomes bespoke code.
- **CSA** (FDA, 2025) only as informative rationale for scaling rigour; the binding basis is 21 CFR 211.68 and Part 11, EU Annex 11 and Schedule M Part I section 20. High-risk functions (limits, calculations, signature binding, status and release interlocks, record generation, audit trail, interfaces, RBE rules) get scripted tests with evidence plus exploratory sessions; low-risk ones (layout, dashboards, notifications) unscripted or scenario tests with recorded outcomes.
- **Generated per edition in CI:** URS from the register; risk assessment per requirement (ICH Q9(R1)); functional and design specifications from the code (state diagrams, guard tables, block catalog, permission matrix, constraint and trigger inventory, audit event catalogue); traceability matrix; IQ script (versions, image digests vs SBOM, triggers and constraints enabled, locked settings); OQ = regression and golden suites on the customer environment; PQ templates on the customer's MBRs; validation summary; release notes with requirement-level impact; SBOM; known issues.
- **Kept current:** each pull request names its control IDs and risk class; CI regenerates everything, fails if a high-risk requirement lacks a passing scripted test, and emits a validation delta per release for customers' change control.

---

## 10. Modifiability

### 10.1 Practices

*In plain words:* rules live in data files, processes are built from plug-in blocks, life cycles are explicit maps and decisions are written down, so a future developer can change one thing without breaking another.

- **Rules as data** in `compliance/` (controls, rule and floor tables, pharmacopoeia sets, policies, signature meanings, exception taxonomy, reason codes), schema-checked in CI.
- **Plug-in blocks:** one self-contained folder per block (schemas, handler, exception rules, UI, review renderer, tests, golden fixture), registered by code and version.
- **State charts:** one definition per life cycle; the transition table, diagrams and tests are generated from it (a test fails if they differ).
- **ADRs** (`docs/adr/`): 001 two editions, separate databases; 002 PostgreSQL only, no graph database; 003 TypeScript end to end; 004 block-structured flows; 005 in-house decimal/UCUM expression language; 006 server-authoritative execution, no device signing; 007 hash-chained audit trail with external anchors; 008 market-profile engine with stored resolutions; 009 control register as data; 010 versioned block handlers; 011 recipe-core sharing (after Decision 1).
- **REPO-GUIDE.md:** where things live, how to run locally, how to add a block, limit, market or rule, definition of done.
- **Coding standards:** TypeScript strict; JavaScript `number` banned for GMP values; `Date.now()` banned in domain code; no cross-edition imports; reviewed, linted SQL migrations; Conventional Commits; PR template asking for control IDs, risk class and validation impact; CODEOWNERS second review for `packages/kernel`, `compliance/` and migrations.
- **CI on every change:** type-check, lint and boundaries; unit, property, model-based and bypass tests; golden batches; browser smoke tests; incremental mutation testing (full weekly); register and table schemas; trace-matrix completeness; machine/transition-table consistency; accessibility; dependency, licence and secret scans; SBOM.

### 10.2 How a future developer...

- **Adds a block:** copy the block template; define config and data schemas; implement the handler against the recipe-core phase contract (prerequisites, signature points, exceptions, genealogy and logbook events); add UI and review renderer; add validator rules if needed; list the controls in their register files; add tests and a golden fixture; register a new block-type version. Existing MBRs are untouched until an author uses it.
- **Changes a limit:** a product limit is not a code change: the author edits it in a new MBR version (verification and approval). A regulatory value is edited in the rule or floor table (value, source, verification status); the new table version produces an impact list of MBRs and site values.
- **Adds a market** (e.g. WHO-GMP, UK): add the market code and a rule-table column with sources; add or extend controls; define the release authority and disposition requirements; add label and serialisation rules per pack destination; the resolution test matrix picks up the new market in every combination.
- **Updates a rule after a regulation changes:** the section 3.6 workflow.

---

## 11. Phased build plan

*In plain words:* foundation first, then one complete product, then the second; every phase ends with something you can watch working and passing tests.

Each phase ends with a tagged release, a demo script, green CI, the trace matrix updated (controls SPECIFIED -> IMPLEMENTED/VERIFIED) and release notes listing controls still pending the expert. Effort shares are rough.

- **Phase 0, repo and CI (~3 %).** Monorepo skeleton, strict TypeScript, boundary lint, local PostgreSQL scripts, CI with every check stubbed; register import (241 controls, 678 rows), decision import tool, trace-matrix generator; ADR-001..010, REPO-GUIDE, PR template. *Exit:* register schema valid; a deliberate boundary violation fails CI.
- **Phase 1, compliance kernel (~15 %).** Local accounts (argon2id), optional OIDC, badge + PIN, MFA, sessions and kiosk lock, scoped roles, static and dynamic segregation, four-eyes grants; audit triggers, actor context, hash chains, anchoring to a local write-once directory (demo stand-in), verifier, viewer; signature challenge/sign, canonical hashing, meanings, manifestation, invalidation, local-key KMS abstraction; time and drift monitor; idempotency; outbox; state-machine engine with generated transition tables; market-profile engine and first rule tables; retention skeleton; true-copy JSON bundle and verifier CLI. *Exit:* INV-03, 06-11, 16, 22, 26-29 with bypass tests; DI-14 to DI-24, DI-27, DI-35 to DI-38 and IN-52 tests pass; kernel mutation targets met.
- **Phase 2, recipe engine and designer (~15 %).** Expression language with reference-model tests; flow model, compiler, validator, engine, simulator; limits and rounding; generic blocks G-01..G-25; MBR life cycle, library elements, generic masters, where-used, difference view; sandbox and watermark; verification workbench and approval package; designer UI. *Exit:* INV-01, 02, 04, 17-20, 25, 34; DI-04, DI-05, DI-33, DI-34, PR-01 to PR-08 tests pass.
- **Phase 3, Tablets edition (~18 %).** Tablets master data; TB-01..TB-24; equipment, room and lot machines; issue and execution; dispensing with scale simulator; charge-in; IPC scheduler with left/right streams and bracketing hold; timers, exceptions, yields, genealogy; blister packaging order with reconciliation; shop-floor screens. *Demo:* GB-T-01 including a correction after verification and a missed IPC that holds containers. *Exit:* INV-12 to 15, 24, 31-33; IN-34 to IN-39 and tablet PR controls tested; GB-T-01 matches expected outputs exactly.
- **Phase 4, review, release and India specifics (~12 %).** Production review; QA RBE workspace with versioned exception-report definition; audit-trail review; release cockpit with G-REL; India AP, US QCU, EU external reference (in-system QP switch); deviation stand-in or QMS adapter with live check; amendments; India fields (licences, allocation register, India-domestic label with uncoded manufacturing date, Schedule H2 QR payload); retention; PDF/A-3 true copy with embedded JSON; evidence export; paper-fallback kit. *Demo:* released for {IN, US}; EU waits; a market-set change forces QA review. *Exit:* INV-05, 21, 30, 35, 38, 39; PR-52 to PR-56, PR-59, DI-25, DI-26, DI-39 to DI-47, IN-05, IN-08, IN-11, IN-31 tests pass.
- **Phase 5, Injectables edition (~20 %).** Clean areas, EM programmes, sterilisers and load patterns, filter trains, lines with technology profiles, intervention catalogues; IB-01..IB-30; clean-area, EM, APS and qualification machines; sterile timers; sterilisation, filtration, lyo, inspection and CCI records; APS record type; sterile dossier and timeline; autoclave, lyophiliser and particle-counter simulators; golden batches of 9.1. *Demo:* isolator vial batch with an unqualified intervention needing real-time QA authorisation; a late EM action result opens a linked deviation and blocks release. *Exit:* INV-23, 36, 37; all ST-01..ST-79 and IN-40..IN-51 tests pass.
- **Phase 6, integrations and extras (~10 %).** Site gateway; adapters with contract tests (ERP, LIMS, QMS, LMS, CMMS, EMS/BMS, OPC UA, scales, printers, serialisation stub); fault-injecting simulators; read models, dashboards; genealogy explorer and mock recall (federated across editions); Hindi + one regional language; training mode; change-impact explorer. *Exit:* DI-20, DI-31, DI-32, DI-49, PR-57, IN-29 tests pass; no silent loss under fault injection.
- **Phase 7, validation pack and hardening (~7 %).** Generated URS, risk, specifications, trace matrix, IQ/OQ scripts, PQ templates, summary report; load and soak tests; backup, point-in-time restore and restore record; threat model and OWASP ASVS level 2 hardening, dependency and container scanning; accessibility audit; user and admin guides; v1.0-rc. *Exit:* every FOLLOW/MODIFY control VERIFIED; mutation targets met; no open high-severity findings.

### 11.1 What can and cannot be demonstrated here

- **Can:** everything above on this machine (Node 22, pnpm 10, PostgreSQL 16, Playwright; 4 vCPU, 15 GB), both editions side by side (e.g. ports 3001/5173 and 3002/5174), simulators for all equipment and systems, local accounts, a local signing key and an append-only directory standing in for write-once storage, labelled demo-only.
- **Cannot here** (needs a pilot customer or later step): real scales, presses, sterilisers and OPC UA servers; an enterprise identity provider, HSM or cloud KMS; real WORM storage; DSC tokens or an eSign provider; Docker deployment (the daemon is not running here, so the demo uses PostgreSQL directly); gowned usability tests; penetration testing; IQ/OQ on customer infrastructure; the Indian legal opinion; pharmacopoeia verification against current texts; a clean Schedule M copy.
- **Scale:** for a conventional team this is in the order of a year or more of work for several experienced engineers before a customer could validate v1; the plan front-loads the parts that carry regulatory risk.

---

## 12. Risks and mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | Regulatory interpretation errors (secondary, unverified or draft items; interpretations such as one AP signature covering US QCU disposition) | Expert review of all 241 controls; verification status carried into code and tables; interpretations listed for customer QA; watch list; nothing unverified presented as a floor |
| 2 | Missing or scrambled Schedule M pages (IN F-1 to F-12: equipment, parts of QC, sterile personnel/premises, CCI, tablet Part XIII) | Obtain a clean official copy; affected controls tagged; values marked P~ or U; the US/EU rule applies meanwhile; re-check before validation documents cite them |
| 3 | Unverified pharmacopoeia values (weight bands, disintegration, friability, USP 905 constants, sterile chapters, IP 2026) | Shipped as UNVERIFIED master data; unusable for GMP batches until QA confirms each value by signature; tests check the mechanism, not the numbers |
| 4 | Legal validity of password e-signatures in India (IT Act s.5 vs Schedule M's acceptance of electronic passwords) | Part 11/Annex 11-grade signatures everywhere; pluggable DSC/eSign (Decision 3); counsel questions in India catalog D.5 |
| 5 | Scope size | Strict v1 scope (Decision 7); shared recipe-core (Decision 1); vertical slices with demos; extras deferred |
| 6 | Performance at large sites | Benchmarks done for genealogy and audit writes; partitioning; raw high-frequency data stays at source; read models; Phase 7 load tests against SLOs |
| 7 | Subtle errors in interacting state machines | Model-based and property-based tests, database invariants, bypass and mutation tests; optional small formal model of sign-correct-invalidate-release |
| 8 | Integration variety | Adapter contracts and contract tests; fault-injecting simulators; flagged, verified manual fallback |
| 9 | Shop-floor usability untested with gowned users | Glove-first design system; formative tests with pilot customers before go-live |
| 10 | EU drafts change after build | Stricter drafts already followed; affected controls named (3.6); versioned tables and controls |
| 11 | Open-source supply chain | Pinned lockfile, few dependencies, SBOM, vulnerability and licence scans, signed artefacts |
| 12 | Cost of keeping old block-handler versions | Accepted price of never changing semantics mid-batch; retired only when no open batch uses them |

---

## 13. Decisions needed from you

Phases 0-2 can start on the recommendations; items that are policy switches can change later without rework.

1. **Share recipe-core between editions?** (A) share kernel and recipe-core, each edition pinning exact versions; (B) share only the kernel, separate recipe-core copies; (C) share now, fork later if needed. **Recommend A:** the flow engine, expression language and limits hold the most error-prone logic; one copy is tested and validated once, and each edition still takes changes only through its own change control. Also confirm the **kernel boundary**: identity/access, e-signatures, audit trail and time plus the compliance plumbing in section 1 (hashing/sealing, control register, market-profile engine, retention, true copies), none of which holds process logic.
2. **FDA/India tiered media-fill acceptance on lines with no EU/PIC/S product?** (A) offer the tiers there, as the catalogs allow; (B) "any contaminated unit fails" on every line, tiers out of v1. **Recommend B:** stricter, simpler to validate; most exporters serve both markets; the table can add tiers later.
3. **DSC/eSign for Indian signatures?** (A) password e-signatures only; (B) optional DSC/eSign per meaning, default on for MBR and packaging-master approval and AP release; (C) DSC/eSign for all signatures. **Recommend B:** build the plug-in with a test certificate authority in v1; integrate a licensed provider after counsel answers the India catalog questions.
4. **Pressure-differential default between grades.** (A) 10 Pa floor with the site's qualified value governing (meets Annex 1 and FDA's 10-15 Pa); (B) ship 12.5 or 15 Pa for US exporters. **Recommend A**, keeping the 12.5 Pa minimum from aseptic rooms to unclassified areas as a hard value.
5. **Continuous particle-count evaluation window** (no text defines it; one 5 µm particle in a one-minute sample already exceeds 20/m3). (A) every single count is an excursion; (B) annotate isolated counts and escalate repeated or consecutive counts per the Annex 1 table note, with QA-approved parameters; (C) rolling cubic-metre window. **Recommend B**, evaluated against India's lower limits.
6. **IP weight bands for export-only tablet batches.** (A) IP bands on every India-made batch (tighter wins); (B) only the export market's pharmacopoeia. **Recommend A** until Indian QA or regulators confirm otherwise.
7. **v1 scope.** Proposed: Tablets without capsules or continuous manufacturing; Injectables V-1, V-2, V-4, V-5, V-9, V-10 fully; V-3, V-6, V-7 blocks with golden batches in v1.1; V-8 in v1.1; no parametric release, powder filling or biologics. **Recommend accept**, or name which of capsules, prefilled syringes or BFS your customers need first.
8. **One human verifier when validated automated equipment dispensed or charged (211.68(c))?** (A) keep two people for US-market dispensing and charge-in by default, enabling one-verifier mode per step type only after the customer's regulatory position; (B) one-verifier mode by default. **Recommend A.** Zero-human verification is never allowed.
9. **Batch sizes and generic masters.** (A) discrete approved sizes only, and approval of "structure + parameter set" counts as the master; (B) validated size ranges with linear scaling. **Recommend A** (B is an open question, PR F-11).
10. **Review by exception.** (A) build it in v1 with full review as default until each MBR meets a validated confidence criterion defined per customer (e.g. consecutive batches with seeded-exception challenges and zero misses); (B) full review only. **Recommend A.**
11. **Build or integrate LIMS, QMS, LMS, EMS?** (A) integrate only; (B) integrate plus minimal built-in stand-ins (qualification register, deviation record, sample and result entry) so a site can run without them; EMS always imported. **Recommend B.**
12. **Deployment and offline.** (A) site-local server plus paper fallback, no device signing; (B) add an offline terminal mode under DI-28 in v1. **Recommend A**; revisit B with poorly connected pilot sites.

**Defaults unless you say otherwise:** a QA person who did in-process checks counts as involved and cannot review the audit trail or release that batch; all signature components at every signing; MBR checker and QA approver are different people; no grace period on the 6-month APS interval; the first batch after a change waits for post-change evaluation; in-system EU QP certification off; retention stays open until the EU certification date is received.
