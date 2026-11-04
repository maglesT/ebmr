# Batchwright API (drug substance): edition plan

- **Status:** draft for the lead's and the owner's approval. No code until approved.
- **Date:** 4 November 2026. **Owner decision:** 4 November 2026 (API manufacturing as its own edition on the same kernel).
- **Builds on:** decisions 0010, 0011, 0020, 0026 (dynamic library); ADRs 0001 (separate edition databases), 0011
  (recipe-core shared), 0019 (generic guards in recipe-core). The binding text was checked against the official
  gazette of Revised Schedule M (G.S.R. 922(E), Part XII, from branch `docs/schedule-m-gazette`) and the official
  ICH Q7 text (ich.org). Clauses are paraphrased; numbers are given for both.

## 1. The answer in short

An API plant's batch record is the same kind of record a tablet plant keeps: a master record approved by QA, batches
issued from it, steps recorded and signed, deviations, review and QA release. Batchwright already has all of that. Each
unit operation (reaction, crystallisation, filtration, drying) is a **library block built from the existing 13 field
types**. Each **intermediate is its own master record and its own batch**. Its output is a lot, and the next step's batch
consumes that lot. So the whole API edition is mostly **data**: a library catalogue and master records. Only five small
pieces of code are proposed. Each one comes from a binding clause that data alone cannot meet (section 4).

## 2. Edition architecture

### 2.1 What is reused (no new code)

| Part | Used for |
|---|---|
| kernel | Identity, access, e-signatures, audit trail, trusted time, retention, platform sign-on through core (DI controls) |
| recipe-core engine | Stages, step states, data points and corrections, exceptions, review by exception, generic G blocks (issuance, sampling, hold timer, yield and reconciliation, reprocessing and rework gate G-24, verification and witness, clearance) |
| Dynamic library (0026) | Block definitions as data, slots, conditional fields, repeat groups ("until within limits" for reaction completion and drying to LOD), calculations that read the batch size, a formula line, **a lot's approved assay** (charge corrected for the key starting material's assay) and earlier steps |
| Master record life cycle | Preparer, independent checker, QA approval, versions, pinning of block versions (PR-02, SM 6.4.1) |
| Batch issue, execution, review, release | Unique batch number at issue (SM 6.5.2), kiosk step screen, batch review, QA release |
| site-services lots | Lot status (quarantine, released, rejected), retest and expiry dates, chemical recovery (0960) and distribution records (0961) |
| plant | Equipment classes, cleanliness status, MINOR/MAJOR cleaning, **campaigns with maximum batches and days** (SM 5.2.4), line clearance, calibration status |
| Genealogy | Lot → batch → lot edges across steps (SM 8.4.5, 14.4.4) |
| Deviations, OOS links, change control | As they are (SM 6.5.3 (xi), 6.5.4, 8.1.6, 13) |

### 2.2 What is new

1. **The edition shell**: edition id, its database (ADR 0001), its own SQL namespace and migration folder, the
   "API" edition badge on the Batchwright lockup. How the shell hosts the shared server features is open question
   Q1 (it is for the lead).
2. **The API library catalogue** (data, section 5), loaded through DRAFT → APPROVED like the tablets seed. QA approves
   what the site uses. Nothing is approved by default.
3. **Five pieces of code**, each tied to its clause (section 4).

### 2.3 How a multistep process with intermediates maps onto master records and batches

```
KSM lot (received, released)            Recovered solvent lot (S6)
        │                                        │
        ▼                                        ▼
[MR: Intermediate A]  ──batch A-001──▶  lot A-001 (INTERMEDIATE, retest date, label)
                                                 │  QA release, or release delegated to production
                                                 │  (SM 6.7.4: only while it stays in-house)
                                                 ▼
[MR: Intermediate B]  ──batch B-001──▶  lot B-001 ──▶ [MR: API, final step] ──batch P-001──▶ lot P-001 (API)
                                                                                             QA release, CoA
```

- One **master record per step that isolates a material** (SM 6.4.1 says master instructions are needed "for each
  intermediate and API"). Steps that are not isolated (telescoped, carried on in solution) are stages inside one
  master record.
- A **batch's output is a lot** in site-services, with its kind (intermediate or API), quantity, retest or expiry
  date and storage conditions taken from the master (SM 6.4.2 (vii)). The next step's master lists that intermediate as
  a BOM line, and the batch consumes the lot through the existing material-lot and weighing fields. A lot that is not
  released cannot be consumed (SM 2.1.8).
- **Genealogy** follows the lot and batch edges, so a final API lot traces back through every intermediate to the
  starting-material lots.
- **A process route** (A → B → API) is just the set of approved master records whose BOMs name each other's outputs.
  No new "route" object is needed. The genealogy and the BOM links already give the chain.

## 3. New field types

**None.** All 13 existing field types (NUMBER, TEXT, YES_NO, CHOICE, DATE_TIME, TIMER, WEIGHING, MATERIAL_LOT,
EQUIPMENT, CONTAINER, SAMPLE, TEST_RESULT, CALC), plus sections, repeat groups and conditional fields, cover every
method in section 5. These candidates were looked at and rejected:

| Candidate | Why it is not needed |
|---|---|
| Reaction profile or trend field | A repeat group of NUMBER (temperature, pressure) plus DATE_TIME every interval, each with limit slots, records the CPPs SM 6.5.3 (iv) asks for. A chart is a display, not a record. |
| Molar or equivalents calculation | CALC already does decimals with UCUM units (`mol`, `mmol`). The formula line and the lot's assay are already external values. |
| Cell bank vial field | A vial is a material lot. MATERIAL_LOT records its use (SM 17.2.3). |
| Impurity table field | Release impurities and residual solvents are the lot's specification tests (existing). In-process impurity checks are TEST_IPC blocks with one NUMBER or TEST_RESULT per named impurity, written for the product as data. |
| Retest date field | DATE_TIME, plus the lot's own `retestAt` |

## 4. Code that a binding clause requires (and nothing else)

| # | Binding clause | Smallest way to meet it | Why nothing smaller works |
|---|---|---|---|
| C1 | SM 6.5.1 and 6.5.3, 6.7.4, 10.2.1 (Q7 6.50, 6.52, 6.73, 10.20): a batch record for each intermediate. Intermediates may be released by production under QU delegation only while they stay inside the company. | Let a batch post its output as a lot of kind INTERMEDIATE (today a batch posts only a FINISHED lot, `site.finished_lot`). Release goes through the existing lot release. A database guard refuses a delegated (production) release of a lot that is shipped outside. | Without it the next step's batch has no released lot to consume, and the chain breaks. This is a **shared change** to site-services and recipe-core. The lead coordinates it (Q6). |
| C2 | SM 8.4.2, 8.4.5, 8.4.8 (Q7 8.41, 8.44, 8.47): OOS batches are never blended. A blend traces back to every batch in it. Its retest or expiry date comes from the oldest batch or tailing in it. | A blending master record built from library blocks (data). One SQL guard in the edition namespace refuses (a) a component lot that is not released, and (b) a retest or expiry date on the blended lot later than the one the oldest component allows. | A CALC field cannot read a lot's manufacturing date, and a date entered by hand needs a guard (decision 0008 section 2: the database enforces the regulation-required core). |
| C3 | SM 11.3.1 to 11.3.4 (Q7 11.40 to 11.43): an authentic CoA for each batch on request, giving the name, grade, batch, release date, retest or expiry date, each test with its limits and numerical results, dated and signed by the QU, with the original manufacturer's name, address and telephone. | One read-only CoA view and print of a released lot, built from data that already exists (lot, specification tests, results, release signature, site address). It is signed with the existing e-signature (meaning QA_APPROVED) and kept as a true copy. | Nothing outside the frozen QP package prints a CoA today. The clause names the content and the signature. |
| C4 | SM 14.3.1 (Q7 14.30): an investigation before a decision to rework. | Check whether G-24 (reprocessing and rework gate, database facts) already requires a linked deviation or investigation for **rework** as opposed to **reprocessing**. If it does, there is no code (test only). If not, add one guard in the edition namespace. | A rework without its investigation would breach a "shall" clause. |
| C5 | SM 6.1.4 (Q7 6.13): records of an API with a retest date are kept at least 3 years after the batch is completely distributed (other records: 1 year after expiry). | Check that the kernel retention rule can be set to "3 years after the last distribution" (0961 distribution records). If yes, it is config. If not, one retention basis is added (shared, through the lead). | Retention is a hard records rule (DI). |

Everything else is data.

## 5. Method list mapped to blocks

Block codes are the edition catalogue's (`API-…`). All are built from the existing field types. "G" means an
existing generic block, used as it is.

| Method / operation | Blocks (data) | Key clauses |
|---|---|---|
| Dispensing and charging (solids, liquids by weight or volume, gases), assay-corrected charge | API-DISP (WEIGHING with two-person check, MATERIAL_LOT, CALC from the lot's assay), API-CHARGE (EQUIPMENT reactor, sequence, temperature at addition, addition time TIMER) | SM 8.1.1, 8.1.3, 6.5.3 (iii) |
| Reaction: temperature, pressure, time control, pH | API-REACT (repeat group per interval: NUMBER T, P, pH with limit slots, critical; TIMER for reaction time) | SM 6.4.2 (v)(b), 6.5.3 (iv), 8.2.1 |
| Reaction completion by IPC (repeat until within limit) | API-IPC-COMPLETE (SAMPLE, TEST_RESULT or NUMBER per named component, repeat "until within limits") | SM 8.3.1, 8.3.4, 14.2.2 (continuing is not reprocessing) |
| Hydrogenation and pressure reactions | API-REACT with gas uptake NUMBER and pressure slots | as above |
| Work-up: quench, pH adjustment, phase separation, washes | API-WORKUP (CHOICE phase kept, NUMBER pH and volumes, CONTAINER REGISTER for aqueous or organic waste and mother liquor) | SM 6.5.3, 14.4.4 |
| Liquid–liquid extraction | API-EXTRACT (repeat per extraction: solvent lot, volume, phase kept) | SM 6.5.3 (iii) |
| Distillation (atmospheric, vacuum, solvent swap, concentration) | API-DISTIL (NUMBER T, vacuum, volume distilled; TIMER) | SM 6.5.3 (iv) |
| Crystallisation (cooling, anti-solvent, seeding) | API-CRYST (seed lot MATERIAL_LOT, cooling-profile repeat group, hold TIMER) | SM 6.5.3 (iv) |
| Filtration: Nutsche, centrifuge, ANFD; cake wash | API-FILTER (EQUIPMENT class slot NUTSCHE, CENTRIFUGE or ANFD; wash volumes; CONTAINER REGISTER mother liquor) | SM 6.5.3 (ii), 14.4.1 |
| Drying: tray, vacuum, fluid-bed, spray, to LOD | API-DRY (EQUIPMENT class slot; T, vacuum, inlet and outlet T for spray; LOD repeat "until within limits") | SM 8.2.1 (drying to a specification), 8.3 |
| Lyophilisation of an API **(added; not on the brief's list)** | API-LYO (shelf T, chamber pressure per phase, TIMER) | SM 6.5.3 (iv) |
| Milling, micronisation, sieving and delumping (sieving **added**) | API-MILL (EQUIPMENT, feed rate, pressure for jet mill, PSD as an IPC test) | SM 6.5.3 (ii), 8.5.1 (carry-over in a microniser) |
| Physical blending of one batch (homogeneity) | API-BLEND-MIX (EQUIPMENT, TIMER, SAMPLE) | SM 8.4.1 (mixing fractions of one batch is not blending of batches) |
| Blending of batches and tailings | API-BLEND-BATCHES (repeat group of MATERIAL_LOT components, WEIGHING, CALC total) + guard C2 | SM 8.4.2 to 8.4.8 |
| Mother liquors: hold, second crop | CONTAINER REGISTER (ML) + API-RECOVER master (consumes the ML container) | SM 14.4.1, 14.4.4 |
| Solvent recovery and re-use; fresh and recovered mixed | Recovery master record (API-DISTIL, IPC on the recovered solvent); the recovered solvent is a quarantined lot, tested and released, then consumed as a MATERIAL_LOT | SM 14.4.2 to 14.4.4 |
| Reprocessing (repeat a step of the established process) | G-24 + the step's own block | SM 14.2.1, 14.2.3 |
| Reworking (a different process) | G-24 + deviation link (C4) + rework master record | SM 14.3.1 to 14.3.3 |
| Continuous and flow processes | API-FLOW (repeat group per interval: flow rates, residence time, T, P; YES_NO steady state; CONTAINER REGISTER for diverted material); the batch is defined by quantity or time window at issue | SM 6.5.2 (continuous production identifier), 5.2.4 (cleaning intervals) |
| Fermentation and cell culture | API-CELLBANK (MATERIAL_LOT vial, storage check), API-INOC, API-FERM (repeat: T, pH, DO, agitation, gas flow, pressure; growth and viability as IPC), API-STERILISE-MEDIA, API-HARVEST | SM 17.2.3, 17.3.4, 17.3.6, 17.4.1 |
| Purification: chromatography, membrane UF and DF (both **added** as their own blocks) | API-CHROM (resin lot or column id, loading, fractions as CONTAINER), API-UFDF | SM 17.4.2, 17.4.5 |
| Viral removal or inactivation | API-VIRAL (critical NUMBER within validated parameters: time, pH, T) | SM 17.5.1 |
| Contamination events (fermentation) | Existing deviation, kind "contamination" | SM 17.3.7, 17.3.8 |
| Extraction from natural sources (maceration, percolation, steam distillation, supercritical) | API-NAT-EXTRACT (plant-material lot, solvent ratio, T, time), then API-DISTIL, API-CRYST or API-CHROM | SM 1.2 (Table: point of GMP application) |
| Semi-synthesis | A fermentation or natural-source intermediate master, then chemical-step masters (section 2.3) | as for each step |
| Solid-phase peptide and oligonucleotide synthesis **(added; not on the brief's list)** | API-SPPS-CYCLE (repeat group per coupling cycle: reagent lots, coupling time, completion test), cleavage, then API-CHROM, API-LYO | SM 6.5.3 (iii), (iv) |
| Biocatalytic and enzymatic steps **(added)** | API-REACT with the enzyme lot as a MATERIAL_LOT | as for reactions |
| Sterile APIs (sterile filtration, aseptic crystallisation, sterile drying and filling) | Reuse the injectables edition's sterile blocks and rules (Annex 1). Sequenced last (Q5). | SM Part XII scope stops before sterilisation (as Q7 1.3); the sterile rules then apply |
| Equipment cleaning: changeover vs campaign | Existing plant cleaning (MINOR, MAJOR) and campaigns (maximum batches and days); API-CLEAN block for the record | SM 5.2.4, 5.2.5, 5.2.7, 6.2.1 |
| Dedicated vs shared equipment; closed systems; HPAPI containment | Data: an equipment class per dedication (for example "REACTOR-ONCO-DEDICATED") named in the master's class slot. The equipment field already refuses another class. A closed-system YES_NO where the master needs it. | SM 4.4.1, 4.4.2, 5.1.6, 6.2.2 |
| In-process controls and sampling | API-IPC-* (TEST_IPC) + G sampling | SM 8.3.1 to 8.3.6 |
| Impurity and residual-solvent results | Release: the lot's specification tests (existing). In-process: TEST_IPC blocks per product. | SM 11.2.1, 11.2.2, 6.5.3 (vii), (xii) |
| Retest dates, expiry | Lot `retestAt` / `expiresAt` from the master's storage instructions | SM 11.5.2, 9.4.4 |
| Yield at stages | G yield and reconciliation + CALC with limit slots; a breach raises an exception, then a deviation | SM 8.1.5, 6.5.3 (viii) |
| Time limits and hold times | TIMER with limit slots; intermediate hold by the lot's retest or expiry date | SM 8.2.1, 8.2.2 |
| Packaging of the API (drums, double liner, nitrogen blanket, seals) **(added; not on the list as such)** and labelling of intermediates and the API | API-PACK (container REGISTER per drum, tare, gross, net, seal number), G printed materials (label issue, reconciliation, specimen in the record), API-LABEL-CHECK | SM 9.3.2, 9.3.6, 9.3.7, 9.4.3 to 9.4.7, 6.5.3 (ix), (x) |
| QU release and CoA | Existing review and release; CoA (C3) | SM 2.1.8, 6.7.2, 6.7.3, 10.2.1, 11.3 |
| Contract manufacturers, agents, brokers | A contract manufacturer running Batchwright is simply a manufacturer: its records stay at its site (SM 16.6). Agents and brokers: Schedule M Part XII has no agents chapter. Q7 chapter 17 binds the agent, not the manufacturer, so it needs **no record here**. The CoA shows the original manufacturer (SM 11.3.4). | SM 16.6, 11.3.4 |

## 6. Binding-clause table

**What is binding, and why.**
- **India, Revised Schedule M, Part XII** (specific requirements for APIs) always applies. It turns Q7's text into
  "shall", so it is the binding wording used here.
- **EU GMP Part II** is ICH Q7. It is binding on active-substance manufacturers through Directive 2001/83/EC Article
  46(f) and Delegated Regulation (EU) 1252/2014. In it, "should" means "expected to apply unless shown inapplicable or
  replaced by an equivalent" (Q7 1.1). Its content matches Part XII clause for clause (numbering: SM a.b.c is nearly always Q7
  a.b(c−1), and SM chapters 17 and 18 are Q7 chapters 18 and 19). It adds only chapter 17 (agents), which binds agents,
  not manufacturers.
- **21 CFR 211** covers finished pharmaceuticals (211.1). It does **not** apply to APIs. FDA holds APIs to CGMP under
  the FD&C Act section 501(a)(2)(B), with Q7 as its guidance. So no 211 item enters this plan.
- **Part 11 and Annex 11** apply to the records. The kernel already meets them (the DI controls). SM 5.4 (computerised
  systems: validation, access control, a record of every change) is met by the same kernel.

| ID (proposed) | SM Part XII | ICH Q7 | Requirement (paraphrased) | Met by |
|---|---|---|---|---|
| AS-01 | 6.4.1 | 6.40 | A master instruction for each intermediate and API: prepared and signed by one person, independently checked and signed by the QU | Master life cycle (PR-02), one master per isolated step |
| AS-02 | 6.4.2 | 6.41 | Master content: materials, quantities or ratios (a calculation per batch size), location and major equipment, sequence, parameter ranges, sampling and IPC criteria, time limits, expected yield ranges, storage | Library slots + validator sanity checks (PR-03) |
| AS-03 | 6.5.1, 6.5.2 | 6.50, 6.51 | A batch record for each intermediate and API, checked at issue against the current master, uniquely numbered, dated and signed at issue | Batch issue (existing) + C1 for intermediates |
| AS-04 | 6.5.3 | 6.52 | Each significant step: dates and times, major equipment, each input lot and quantity, actual CPP results, sampling, performer and checker signatures, IPC and lab results, actual yields, package and label, deviations, release results | Blocks (section 5), G blocks, lot results |
| AS-05 | 8.1.3, 8.1.4 | 8.12, 8.13 | Critical weighing, sub-dividing and other critical activities are witnessed or equivalently controlled | WEIGHING two-person check, CHECKED and VERIFIED signatures |
| AS-06 | 8.1.5, 8.1.6 | 8.14, 8.15 | Actual against expected yield at set steps; deviations recorded and explained; critical ones investigated | CALC yield with limits → exception → deviation |
| AS-07 | 8.1.7, 5.2.7 | 8.16, 5.26 | Processing and cleanliness status of major equipment shown | plant status |
| AS-08 | 8.1.8, 14.1 | 8.17, 14.10 | Material to be reprocessed or reworked is controlled against unauthorised use; failing material is quarantined | Lot status, G-24 |
| AS-09 | 8.2.1, 8.2.2 | 8.20, 8.21 | Time limits in the master are met (deviations evaluated); held intermediates stored suitably | TIMER limits, lot dates |
| AS-10 | 8.3.1, 8.3.3, 8.3.4 | 8.30, 8.32, 8.33 | IPCs and their criteria are defined; critical IPCs approved by the QU; production adjusts only within QU-approved limits | Approved master, limit slots, out-of-limit exception |
| AS-11 | 8.4.2, 8.4.4, 8.4.5, 8.4.8 | 8.41, 8.43, 8.44, 8.47 | Blending of batches: no OOS batch; each component tested and passing; documented; traceable to each batch; date from the oldest | Blending master + **C2** |
| AS-12 | 5.2.4, 5.2.5, 6.2.1, 6.2.2 | 5.23, 5.24, 6.20, 6.21 | Campaign cleaning at intervals; cleaning between different products; equipment use and cleaning log (dedicated equipment may keep it in the batch record) | plant campaigns and cleaning |
| AS-13 | 4.4.1, 4.4.2 | 4.40, 4.42 | Dedicated areas and equipment for highly sensitising materials; no cross-contamination between dedicated areas | Equipment class per dedication (data); the equipment field refuses others |
| AS-14 | 9.3.2, 9.3.6, 9.3.7 | 9.31, 9.35, 9.36 | Label reconciliation; issued labels examined and the result recorded; a representative label in the batch record | G printed materials |
| AS-15 | 9.4.3, 9.4.4, 9.4.5, 9.4.6 | 9.42 to 9.45 | Label content (name, batch, storage; outside the company also manufacturer, quantity, transport conditions, retest or expiry); line inspection before use; labelled containers checked | API-PACK, API-LABEL-CHECK, clearance |
| AS-16 | 6.7.2, 6.7.3, 6.7.4, 2.1.8, 10.2.1 | 6.71 to 6.73, 2.17, 10.20 | QU reviews critical-step records and all deviations and OOS before release; delegation of intermediate release only in-house; nothing used or shipped before QU release | Review and release + **C1** guard |
| AS-17 | 11.3.1 to 11.3.4 | 11.40 to 11.43 | Authentic CoA per batch on request, with the stated content, signed by the QU | **C3** |
| AS-18 | 11.5.2, 9.4.4 | 11.61, 9.43 | Retest or expiry date assigned and shown on the label and CoA | Lot dates, label, CoA |
| AS-19 | 14.2.1, 14.2.3 | 14.20, 14.22 | Reprocessing within the established process; unreacted material returned only after evaluation and recorded | G-24 |
| AS-20 | 14.3.1, 14.3.2 | 14.30, 14.31 | Investigation before rework; reworked batches evaluated, tested and documented | G-24, deviation, **C4** |
| AS-21 | 14.4.1, 14.4.2, 14.4.4 | 14.40, 14.41, 14.43 | Recovery from mother liquors under approved procedures, recovered material within specification; recovered solvents meet standards before re-use; their use documented | Recovery masters, quarantined recovered lots, genealogy |
| AS-22 | 17.2.3, 17.3.4, 17.3.8 | 18.22, 18.33, 18.37 | Cell bank vial use recorded; critical fermentation parameters monitored; contamination events recorded | API-CELLBANK, API-FERM, deviation |
| AS-23 | 17.5.1 | 18.51 | Viral removal or inactivation within validated parameters | API-VIRAL critical limits |
| AS-24 | 6.1.4 | 6.13 | Retention: 1 year after expiry; for retest-dated APIs, 3 years after complete distribution | **C5** |
| (kernel) | 6.1.5, 5.4.4 | 6.14, 5.43 | Entries made at the time, attributable; corrections keep the original; access control; record of changes | Existing DI controls; `api` added to their editions |

Each AS control gets a file in `compliance/controls/` (new files only, no existing control text changed), with tests
named `[AS-xx]`. Shared DI and PR controls gain the edition in their `editions` list. Both go through the lead (Q3).

**Out of scope: binding, but not batch-record functions.** The stability programme (SM 11.4), reserve-sample
management (11.6), complaints and recalls (15), supplier qualification (7.1.2), cleaning validation (12.7) and
impurity-profile trending (11.2.3) are QC, QMS or validation functions. Batchwright records only what the batch record
needs from them: the sample taken (SAMPLE), the retest date, the deviation link. This matches the decision 0026 freeze
of QMS modules. See Q7.

## 7. Slice order

Each slice is one PR: tests named by rule ID, green CI, one review, squash-merge, and a short report to the lead.

| # | Slice | Proves |
|---|---|---|
| A0 | **Edition shell**: edition id, database, namespace and migration range (reserved by the lead), `editions` entry in `phase.yaml`, AS control files, edition badge | An empty API edition passes the shared DI and PR control tests on its own database |
| A1 | **One-step synthesis to a released API lot**: catalogue v1 (dispense, charge, react, completion IPC, crystallise, Nutsche or centrifuge filter, tray dry to LOD, yield, pack and label); master on screen; batch; QA release; C5 check | AS-01 to AS-10, AS-14 to AS-16, AS-18, AS-24 |
| A2 | **Multistep with intermediates** (C1): intermediate lots, delegated in-house release, hold, next-step consumption, genealogy across three steps | AS-03, AS-09, AS-16 |
| A3 | **CoA** (C3) | AS-17 |
| A4 | **Recovery, reprocessing, rework**: mother liquor second crop, solvent recovery and re-use, G-24, C4 | AS-08, AS-19 to AS-21 |
| A5 | **Blending of batches and tailings** (C2) | AS-11 |
| A6 | **Equipment**: campaign vs changeover cleaning, dedicated and HPAPI classes, closed system | AS-07, AS-12, AS-13 |
| A7 | **The rest of the chemical catalogue**: work-up, extraction, distillation, ANFD, vacuum, fluid-bed and spray drying, lyophilisation, milling, micronisation, sieving, pressure reactions | data only |
| A8 | **Continuous and flow** | AS-03 (continuous identifier), AS-12 |
| A9 | **Fermentation and cell culture**, chromatography, UF and DF, viral steps | AS-22, AS-23 |
| A10 | **Natural extraction, semi-synthesis, SPPS and oligonucleotides, biocatalysis** | data only |
| A11 | **Sterile APIs**, reusing the injectables sterile rules (after Q5) | the sterile controls that apply |
| A12 | **Acceptance**: three different APIs (a multistep synthetic, a fermentation-derived and a natural extract) set up on screen with zero code changes; the exit review | all AS |

## 8. Simplicity review

- **No new field type, no new block category, no new screen** except the CoA view (C3). The kiosk, review and record
  screens are the generic renderer's.
- **No route or process-chain object.** Masters linked through their BOMs, plus genealogy, already give the chain.
- **No solvent inventory, cell-bank inventory, campaign planner or stability module.** Lots, plant campaigns and
  blocks already record what the clauses ask for.
- **No agent or broker module.** Nothing binds the manufacturer's record there.
- **No 21 CFR 211 work.** It does not apply to APIs.
- **The code is five items, each with its clause.** Two of them (C4, C5) may turn out to need only a test.
- **What could still be cut:** C3 is "on request", so a printable view built from existing data is the floor. A
  CoA editor or templates are not planned.
- **Watch item:** methods with many product-specific named results (impurities) are written as product-specific
  blocks (data). If that turns into heavy data entry, it is a usability issue for later, not a reason for code now.

## 9. Risks

1. **Edition host (Q1).** Most server features (quality, release, review, designer, library) sit inside
   `apps/tablets-server`, and dependency-cruiser forbids one app importing another. Lifting them into a shared host is
   a large shared change that touches tablets. Running a second app means duplicating them. The capsules and soft-gels
   editions face the same choice, so one lead decision should cover all three.
2. **Intermediate lot posting (C1)** changes shared site-services and recipe-core behaviour. It must leave tablets
   unchanged (its output stays FINISHED).
3. **Sterile APIs** depend on the frozen injectables edition (decision 0026).
4. **Continuous processes:** a batch defined by a time window must fit the fixed list of approved batch sizes (IN-13,
   O-8). Default: the size is a quantity, and the run's time window is recorded in the batch.
5. **Library expressiveness at scale:** long cycle-based records (SPPS with 40 or more couplings, fermentations of
   several days) mean large repeat groups. Screen performance must be checked in A9 and A10.

## 10. Open questions (each with the default taken if the lead agrees)

| # | Question | For | Default |
|---|---|---|---|
| Q1 | How does the API edition host the shared server features (now in `apps/tablets-server`)? | Lead | One shared approach for capsules, soft gels and API, set by the lead. Until then, A0 to A2 are built as the edition's own SQL namespace and library data with no new app, and the app question waits for the lead |
| Q2 | Code name of the edition | Lead | Edition id `api`, but the folder, SQL schema and namespace are `substance` (`api` already means the HTTP API in `api-contract`). Users see "Batchwright API". |
| Q3 | New control prefix and edition entries in `compliance/` (shared) | Lead / owner | Prefix `AS` (active substance), new files only; `api` added to the `editions` of the shared DI and PR controls |
| Q4 | Migration number range | Lead | Reserved by the lead before A0 |
| Q5 | Sterile APIs need injectables' sterile rules (frozen) | Owner via lead | Sequenced last (A11), after the owner unfreezes the sterile part |
| Q6 | C1: a batch posts an INTERMEDIATE lot (shared change) | Lead | The lead's platform session makes the shared change, or approves this session making it with tablets unchanged |
| Q7 | Binding QC and QMS clauses outside the batch record (stability, reserve samples, complaints, supplier approval) | Owner | Out of scope, consistent with the 0026 freeze; the batch record links to them |
| Q8 | Methods added beyond the brief: lyophilisation, chromatography and UF/DF as blocks, SPPS and oligonucleotide synthesis, biocatalysis, sieving, API packaging | Owner | Included (flagged) |
