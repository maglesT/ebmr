# Batchwright Injectables: edition plan

- **Status:** draft for the owner and the lead (4 November 2026). No code before approval.
- **Owner decision (4 November 2026):** build Injectables inside Batchwright as the second edition beside Tablets, on the
  same kernel, dynamic library (decision 0026), e-signatures, audit trail, MBR approval, release, deviations, terminals
  and platform sign-on. Cover every current injectable method ("no leaving anything"); the slice order decides only
  what comes first.
- **Read with:** ADR 0001 (two editions, separate databases), ADR 0011 (recipe-core shared), decisions 0010, 0011,
  0026, the outline sections 2.3, 5.2.10, 5.2.11 and 6.6, `docs/handbook/modules/injectables.md` (extension points),
  `compliance/controls/ST-01..79` and `IN-40..51` (91 injectables-only controls, all `target_phase: 5`, expert decision
  PENDING), `compliance/rule-tables/sterile/sterile.v1.yaml` (78 keys).

## 1. Architecture of the edition

One product, two editions. What differs between them is data, one database schema and a small set of sterile modules.

| Layer | Tablets today | Injectables |
|---|---|---|
| Database | `ebmr_tablets`: `kernel.*`, recipe schema, `tab.*` | `ebmr_injectables`: the same `kernel.*` and recipe migrations, plus `inj.*` (ADR 0001). Tablets never runs an `inj` migration. |
| Site data | `ebmr_site` (persons, training, lots, batch numbers, devices) | the same database, shared: a lot rejected in one edition is unusable in the other, one person record, one batch-number register |
| Server | `apps/tablets-server` | `apps/injectables-server`: the shared host plus the sterile modules (section 3) |
| Web | `apps/tablets-web` | `apps/injectables-web`: the shared host screens plus the sterile screens |
| Library | tablet library blocks (data) | sterile library blocks (data) in the injectables database; the designer palette shows only them |
| Market rules | `kernel` + `tablets` tables | `kernel` + `sterile` tables (`EBMR-MKT-054` already keeps the two apart) |
| Platform | product `ebmr`, permissions `ebmr.*` | the same product with the edition badge INJECTABLES (decision 0020); new `ebmr.*` codes for sterile acts go to the lead for databsee |

**The one structural step: a shared host.** About 100k lines of edition-neutral server and web code (session, esig,
audit, records, library, designer, formulation, execution, review, release, deviations, plant, master data, market,
terminals, platform sign-on) live today in `apps/tablets-*`, and an app may not import another app (lint, ADR 0001).
Slice I-0 moves the edition-neutral features, unchanged, into two packages, `@ebmr/server-host` and `@ebmr/web-host`
(exact `workspace:` pins, ADR 0015). `apps/tablets-*` then compose the host with the tablet blocks and screens, with no
behaviour change: the whole Tablets suite, golden batches and browser suite must pass unchanged. Rejected alternative:
one app started with an edition flag. It is less work, but every sterile change would then sit inside the validated
Tablets build, which ADR 0001 and the owner ("do not mix sterile rules into tablets") rule out.

## 2. Reused versus new

**Reused unchanged:** kernel (audit trail, e-signatures, time, identity, market engine, records, continuity, platform
sign-on), recipe-core (library model, field types, sanity validator, formulation, scaling, batch generation, generic
guards of ADR 0019, plant rules including the beta-lactam and hazardous-product screens of 0890, 0912, 0973, 1655),
site-services, expr, ui-kit, integration-sdk, the site gateway drivers (OPC UA, process journal, device originals),
review by exception, release gate, deviations, terminals, labelling and packaging library blocks, the sterile rule table.

**New, edition code (`inj.*` and the injectables apps):** the sterile modules of section 3. They hold state that lives
outside one batch step (a room, a line, a person, an EM sample, an APS) and that the outline already designs
(5.2.10, 5.2.11). Everything that happens inside a batch step is a library block, i.e. data.

**New in shared packages (each one told to the lead first):**
- one field type, `DEVICE_RECORD` (section 4);
- the deferred expr functions F0 (lethality from a temperature series), fill volume from weight and density, filled
  units (named as deferred in `packages/expr/src/library/index.ts`);
- new plant machine versions with the states `DRIED`, `STERILISED`, `DEPYROGENATED`, a sterile-hold expiry, and the
  room grade (the extension points kept open since decision 0010);
- the trace tool's per-edition report (section 8).

## 3. Sterile modules (code; the minimum Annex 1 forces outside a step)

| Module | What it does | Controls |
|---|---|---|
| M1 Clean areas | room/zone hierarchy (A inside B, isolator and RABS mapping), grade, qualification and validity, cleaning and disinfection status, return to service, pressure and HEPA status from the BMS; a step-start gate | ST-14..17, ST-74, IN-40, IN-41, IN-43, IN-44, IN-51 |
| M2 Environmental monitoring | sampling plan per batch window, viable air/surface/personnel samples and results, total particles including continuous Grade A from counters, alert and action limits from the sterile table, trend rules, excursions linked to every batch in the room and window, completeness as a release prerequisite | ST-18..24, IN-42 |
| M3 People | gowning qualification, aseptic qualification per line (and per manual configuration), presence and headcount log, health declaration, disqualification and requalification; checked at every e-signature in A/B | ST-07..13, ST-30 |
| M4 APS | APS status per process × line × shift × container format, envelope from successful APS, APS record life cycle with incubation and reading, failure look-back | ST-29..33, IN-45 |
| M5 Interventions | catalogue per line, one-tap quick log with "unlisted intervention", stoppages, exceedance of APS-demonstrated counts | ST-34..36 |
| M6 Utilities and alarms | WFI, clean steam and process-gas points of use with status, excursions linked to batches that drew from them; batch alarm register | ST-06, ST-25..28 |
| M7 Sterile items and time limits | sterile state and hold expiry of items, carriers, parts and equipment; cross-step time limits (preparation to filtration, filtration to end of fill, sterilisation to use, and the rest of the ST-37 set) | ST-37, ST-38, ST-45, IN-46 |
| M8 Sterile release | dossier sections, sterilisation-cycle roll-up, contamination-event impact, the sterile part of the release gate (a passing sterility test never overrides a process failure), conditional release of short-shelf-life products | ST-24, ST-65..72, IN-49 |

Each module reuses the kernel's state machines, audit, e-signature and deviation plumbing; none has its own.

## 4. Field types: one new, `DEVICE_RECORD`

Every sterilising, depyrogenating, freeze-drying, integrity-testing and inspecting machine produces a **record of a
run** (cycle number, recipe, phases, parameters over time, alarms, the machine's own verdict). Annex 1 (8.41-8.43,
8.50-8.59) and 211.113(b) need that record bound to the batch, checked against the validated recipe and load pattern,
and a non-conforming run quarantined. No existing field type can do this: NUMBER and TEST_RESULT are typed values,
and the equipment-data feature shows series but does not judge them.

`DEVICE_RECORD`: pick the run (from the gateway's device originals, or a manual entry with the printout attached and a
second-person check when no interface exists), check equipment, recipe ID and load pattern against the formulation,
take named parameters from the run (each judged as a NUMBER with limits), compute derived values with expr (F0 from
the temperature series, lyo phase durations), and store the original record hash (DI-32, DI-49). It is useful to at
least nine blocks (autoclave, tunnel, oven, SIP, VHP, lyophiliser, filter integrity tester, CCIT machine, automated
inspection machine), which passes the decision-0026 rule (a new field type serves at least three blocks).

Checked and **not** needed as new field types: inspection reject counts (repeat group of NUMBER + CALC); AQL (sample
size and acceptance number are formulation values per approved batch size, decision 0026 O-8); EM results (module
M2, not a step field); gates such as room grade or APS validity (the module's step-start guard through the generic
guard hook of ADR 0019).

## 5. Every method mapped to blocks

Library blocks (data) are named INJ-nn. A formulation assembles them; the technology profile and sterility route are
formulation values checked by the sterile validator (ST-02, ST-74). "M" names the module that supplies a gate or
status.

### 5.0 The block catalogue (data)

| Block | Name | Block | Name |
|---|---|---|---|
| INJ-01 | Line clearance and room readiness | INJ-17 | Lyophilisation (loading, cycle, unloading) |
| INJ-02 | Component and RTU acceptance | INJ-18 | Fill weight/volume and device IPC |
| INJ-03 | Supplier-sterilised component receipt | INJ-19 | Ampoule fusion sealing |
| INJ-04 | Container and closure washing, siliconisation | INJ-20 | Capping and crimping |
| INJ-05 | Depyrogenation (tunnel, oven) | INJ-21 | Terminal sterilisation (moist heat, radiation, post-aseptic heat) |
| INJ-06 | Moist heat of parts and components | INJ-22 | 100 % visual inspection and AQL |
| INJ-07 | Sterilisation in place | INJ-23 | Container closure integrity |
| INJ-08 | Aseptic assembly, connections, transfer into A/B | INJ-24 | Unit accountability |
| INJ-09 | Bio-decontamination (VHP) | INJ-25 | Sterility sampling |
| INJ-10 | Glove and sleeve integrity | INJ-26 | Release tests: sterility, BET, particulates, RMM; APS incubation and reading |
| INJ-11 | Single-use and closed systems | INJ-27 | RTU nest/tub entry (e-beam or wipe transfer) |
| INJ-12 | Solution preparation and compounding | INJ-28 | Plunger and middle-stopper placement |
| INJ-13 | Sterilising filtration and filter integrity | INJ-29 | FFS bag or bottle line, overwrap |
| INJ-14 | Bulk hold and bioburden-reducing filtration | INJ-30 | Blow-fill-seal run |
| INJ-15 | Filling and stoppering (format slot; APS mode) | INJ-31 | Sterile powder handling and filling |
| INJ-16 | Homogenisation of non-filterable bulk | | |

### 5.1 Dosage forms and containers

| Form | Blocks | Notes |
|---|---|---|
| Liquid vials | INJ-01..08, INJ-12..15, INJ-18, INJ-20..26 | aseptic or terminally sterilised |
| Ampoules (glass) | as vials, with INJ-19 fusion sealing instead of stoppering and capping | 100 % CCI (Annex 1 8.22) |
| Prefilled syringes | INJ-27 RTU nest/tub entry, INJ-15 filling (syringe format), INJ-28 plunger placement, device functional tests in INJ-18 | combination product: see Q4 |
| Cartridges | as PFS (cartridge format, lined seal crimp in INJ-20) | |
| Large-volume parenterals (bags, bottles) | INJ-29 FFS bag or bottle line, INJ-21 terminal sterilisation (sub-batch loads), overwrap in INJ-29 | non-rigid containers (ST-61) |
| Lyophilised vials | INJ-15 with partial stoppering, INJ-17 lyo loading and cycle, INJ-20 | M4 lyo envelope items |
| Dual-chamber (syringe or cartridge) | INJ-15 twice (diluent chamber and drug chamber), INJ-17 in-device lyo, INJ-28 middle and end stoppers, functional test in INJ-18 | combination product: Q4 |
| Blow-fill-seal | INJ-30 BFS run (parison, extrusion, mould, fill, seal), INJ-23 CCI, INJ-22 inspection | ST-77 |
| **Added (flag):** sterile powder fill | INJ-31 aseptic powder handling and filling (powder weight IPC) | was out of scope in outline 2.4; current method |
| **Added (flag):** suspensions, emulsions, liposomes (non-filterable) | INJ-12 aseptic bulk compounding from sterile components, INJ-16 homogenisation step; M4 bulk-stage APS | outline V-7; ST-29 bulk APS |
| **Added (flag):** closed RTU vials and nested vials | INJ-27 | ST-40 |

### 5.2 Sterilisation routes

| Route | Blocks | Controls |
|---|---|---|
| Terminal moist heat (F0) | INJ-21 (DEVICE_RECORD; F0 by expr; loads as replicate sub-batches; preparation-to-sterilisation timer from M7) | ST-60, ST-61, IN-47 |
| Parametric release of terminally sterilised product | INJ-21 with the parametric acceptance set; release by M8 | ST-61; needs Annex 17 checked (Q5) |
| Aseptic: sterile filtration | INJ-13 filter identity against the registered filter, pre-use test, PUPSIT where required, post-use test, redundant and serial logic, time and pressure, single use | ST-50..53, IN-48 |
| Pre-filtration bioburden | INJ-12 sample field; result gate in M8 | ST-54 |
| Dry-heat depyrogenation (tunnel, oven) | INJ-05 (DEVICE_RECORD) | ST-47 |
| Moist heat of parts, components, garments | INJ-06 (DEVICE_RECORD, load pattern) | ST-43..45 |
| Sterilisation in place | INJ-07 (DEVICE_RECORD, post-SIP integrity) | ST-48 |
| VHP / isolator bio-decontamination | INJ-09 (DEVICE_RECORD, validity interval in M1) | ST-76 |
| Gamma, e-beam or EtO sterilised components (supplier) | INJ-03 sterile component receipt (certificate, dose or cycle, lot, indicator) | ST-40, ST-49 |
| **Added (flag):** terminal radiation of product | INJ-21 radiation variant (dose map, indicator, contract steriliser certificate) | ST-49 (Annex 1 8.72-8.78) |
| **Added (flag):** post-aseptic heat treatment | INJ-21 adjunct mode after aseptic fill | outline V-9 |
| **Added (flag):** e-beam tub surface decontamination at transfer | INJ-27 | ST-46 |

### 5.3 Barrier technology

| Technology | How | Controls |
|---|---|---|
| Isolator (open, closed) | technology profile on the line (M1); INJ-09 decontamination; INJ-10 glove and sleeve integrity; isolator pressure from the BMS | ST-74..76 |
| RABS (open, closed) | as isolator, with background Grade B and RABS door-open events as interventions (M5) | ST-74, ST-75 |
| Open Grade A in Grade B | profile with its contamination-control-strategy reference (ST-02) | ST-74 |
| Single-use systems | INJ-11 SUS receipt, installation, integrity check, connections | ST-79 |
| Closed systems | INJ-11 | ST-79 |

### 5.4 Process steps

| Step | Block | Controls |
|---|---|---|
| Line clearance and room readiness | INJ-01 (gates from M1, M3, M4) | ST-14..17, ST-35 |
| Gowning and entry | M3 (presence log); INJ-01 confirms the roster | ST-08, ST-10..12 |
| Component and RTU acceptance | INJ-02, INJ-03 | ST-39, ST-40 |
| Container washing and siliconisation | INJ-04 | ST-41 |
| Closure preparation | INJ-04 (stopper variant) then INJ-06 | ST-41 |
| Aseptic assembly and connections | INJ-08 | ST-42 |
| Transfer into A/B | INJ-08 transfer section | ST-46 |
| Solution preparation and compounding | INJ-12 (weighing, WFI draw from a point of use in M6, mixing timer, pH, density, volume make-up, nitrogen overlay) | ST-26, ST-28, IN-46 |
| Sterile filtration | INJ-13 | ST-50..53 |
| Filling | INJ-15 (format slot: vial, ampoule, syringe, cartridge, bottle; interventions through M5; fill weight IPC every interval) | ST-55, ST-56 |
| Stoppering | INJ-15 (stopper-height detection) | ST-57 |
| Capping and crimping | INJ-20 | ST-57, IN-50 |
| Lyophilisation | INJ-17 (lyo readiness, loading as aseptic operation, cycle as DEVICE_RECORD, unloading) | ST-58, ST-59 |
| Fill weight and device IPC | INJ-18 | ST-56 |
| Container closure integrity | INJ-23 (deterministic methods: vacuum decay, HVLD, laser headspace; probabilistic dye ingress; 100 % for fusion-sealed) | ST-64 |
| 100 % visual inspection: manual, semi-automatic, automated | INJ-22 (inspector qualification from M3; rejects by defect category; AQL of accepted units; automated run as DEVICE_RECORD) | ST-62, ST-63, IN-50 |
| Unit accountability | INJ-24 (filled = inspected + rejects + samples + losses, zero unexplained) | ST-32 pattern, IN-50 |
| Sterility sampling | INJ-25 (start, middle, end, after interventions, per load and sub-batch) | ST-66 |
| Labelling and packaging | existing generic library blocks | as Tablets |

### 5.5 Contamination control and QC

| Topic | Where | Controls |
|---|---|---|
| Grade A/B/C/D, classification, requalification | M1 | ST-14, IN-40, IN-43 |
| Gowning qualification | M3 | ST-08..11 |
| Total particles, continuous in Grade A | M2 with the EM counter adapter | ST-19 |
| Viable air, surface, personnel | M2 | ST-18, ST-20..22 |
| Alert and action limits linked to the batch | M2 (sterile table limits; linkage rule of outline 5.2.10) | ST-20, ST-21 |
| Media fill (APS) and operator qualification | M4 with INJ-15 in APS mode, INJ-24 APS accountability, INJ-26 incubation and reading | ST-29..33, IN-45 |
| WFI and clean steam results | M6 | ST-26, ST-27 |
| Sterility, endotoxin (BET), particulate matter | INJ-26 release-test blocks (TEST_RESULT; QC roles); gate in M8 | ST-65..68 |
| Rapid microbial methods | INJ-26 method choice with its validation reference; same limits and gate | ST-65 (Annex 1 10.5) |
| Penicillin / beta-lactam and cytotoxic segregation | existing plant rules (0890, 0912, 0973, 1655) in the injectables database; no change | PR-27, IN-27 |

### 5.6 Equipment data (existing gateway and adapter framework)

Adapters, each an OPC UA or file-drop profile on the existing drivers feeding device originals and series: autoclave,
depyrogenation tunnel and oven, lyophiliser, filling line (counts, speed, stoppages, rejects), EM particle counters
(continuous Grade A), VHP generator, filter integrity tester, CCIT machine, automated inspection machine. Each has a
simulator profile in the existing process simulator for tests. This unfreezes the site gateway for these adapters only
(Q2).

## 6. Binding clauses (cited; paraphrased)

Only binding texts. The controls' `sources` already cite clause numbers; the requirement register
(`compliance/requirements/requirements.jsonl`) holds the paraphrases, checked against the official texts (rows marked
`verified: primary`). Each slice re-checks its own clauses against the official text before coding and lists them in
its slice notes. FDA's 2004 aseptic-processing guidance, PDA and ISO standards are **not** in this table: where a
control behaviour rests only on them, see Q1.

| Text | Clauses this edition relies on | Topic | Slice |
|---|---|---|---|
| Revised Schedule M (G.S.R. 922(E), 28 Dec 2023), Part II sterile products | 1.1-1.3, 4.1-4.11 and Tables 1-3 | grades, classification, EM, grade per operation | I-1, I-2 |
| | 2.1-2.4, 4.8 | sterility testing, EM in release review | I-1 |
| | 3.1-3.4, 5.9 | sanitation, disinfectants, water monitoring | I-2 |
| | 5.3-5.7, 4.11 | media fills, hold times, fill duration | I-2 |
| | 5.12-5.17 | time limits, bioburden, endotoxins | I-1 |
| | 6.3-6.11 (6.11.1 heat, 6.11.2 filtration) | sterilisation, records, filtration | I-1, I-2 |
| | 10.3-10.8 | capping, vacuum-sealed containers, inspection | I-1 |
| Schedule M Part I | 11.5.1 | eyesight checks for inspectors | I-1 |
| Schedule M Part XIII | item 11 (parenterals), FFS section | areas and equipment for parenterals and FFS | I-1, I-4 |
| EU GMP Annex 1 (2022; in operation 25 Aug 2023, 8.123 from 25 Aug 2024) | 2.1-2.7 | contamination control strategy | I-1 |
| | 3.1-3.2 | PQS: release review, investigations | I-1 |
| | 4.1-4.36 | premises, grades, barrier technology (4.18-4.22), pressures, cleaning | I-1, I-2 |
| | 5.1-5.9 | equipment | I-2 |
| | 6.1-6.22 | utilities: WFI (6.7-6.15), steam (6.16-6.17), gases (6.18-6.19), alarms | I-2 |
| | 7.1-7.18 | personnel, gowning, qualification | I-2 |
| | 8.1-8.5 | terminally sterilised products | I-1 |
| | 8.7-8.33 | aseptic preparation, finishing, CCI (8.22-8.25), inspection (8.30-8.33) | I-1, I-2 |
| | 8.34-8.78 | sterilisation: moist heat, dry heat, radiation, EtO | I-1, I-2, I-4 |
| | 8.79-8.95 | sterile filtration, PUPSIT (8.87), bioburden (8.93) | I-2 |
| | 8.96-8.120 | FFS (8.96-8.104), BFS (8.105-8.120) | I-4 |
| | 8.121-8.126 | lyophilisation | I-3 |
| | 8.127-8.139 | closed and single-use systems | I-2 |
| | 9.1-9.49 | EM (9.1-9.31), APS (9.32-9.49) | I-2 |
| | 10.1-10.11 | QC: sterility (10.5-10.6), short shelf life (10.7, 10.10), media (10.8-10.9) | I-1 |
| EU GMP Annex 11 | 4, 7, 9, 12, 14 (as already met by the kernel) | validation, data storage, audit trail, security, e-signature | reused |
| 21 CFR Part 11 | 11.10, 11.50, 11.70, 11.100, 11.200, 11.300 (kernel) | records and signatures | reused |
| 21 CFR 211 | 211.42(c)(10) | aseptic processing areas and their monitoring systems | I-2 |
| | 211.63, 211.67, 211.68 | equipment, cleaning and sterilisation of equipment, automatic equipment | I-1 |
| | 211.84(d), 211.94(c)-(d) | component testing, containers and closures (pyrogen removal, sterilisation) | I-1 |
| | 211.100, 211.110(a), 211.111 | written procedures, in-process controls, time limits | I-1 |
| | 211.113(b) | validated sterilisation of aseptic and sterile processes | I-1, I-2 |
| | 211.160(b), 211.165, 211.167(a) | lab controls, release testing, sterility and pyrogen testing | I-1 |
| | 211.186, 211.188, 211.192 | master and batch records, record review and investigations | reused + I-1 |
| | 211.42(d), 211.46(d) | penicillin segregation (existing screens) | reused |

## 7. Slice order

Each slice: tests named by control ID (`[ST-44]`, `[IN-47]`, plus `[INV-xx]`), CI green, one review, a Simplicity review
of its screens, squash-merge, a few lines to the lead. At most 2-3 agents at once.

| Slice | Content | Done when |
|---|---|---|
| **I-0 Edition skeleton** | shared host packages (moved, not changed); `ebmr_injectables` migrations and `inj` schema; edition badge; per-edition trace report; sterile clause re-check list; the Q1 list for the owner | the Tablets suite, golden batches and browser suite pass unchanged; the injectables app signs on and shows an empty library |
| **I-1 Terminally sterilised small-volume vials and ampoules** | `DEVICE_RECORD`, F0 in expr, plant states; M1 basic (grade and qualification gate), M7 time limits, M8 minimal; blocks INJ-01, 02, 04, 05, 06, 12, 14, 15 (vial and ampoule), 18, 19, 20, 21, 22 (manual), 23 (fusion seal 100 %), 24, 25, 26; autoclave and tunnel adapters | a sterile formulation is built on screen from the library and a sandbox batch of each (vials, ampoules) runs to release |
| **I-2 Aseptic fill, EM and media fill** | M1 full, M2, M3, M4, M5, M6; blocks INJ-03, 07, 08, 09, 10, 11, 13, 16; barrier profiles (isolator, RABS, open A); EM counter, VHP, integrity-tester and filling-line adapters | an aseptic vial batch and an APS run end to end; an EM action excursion holds the linked batches |
| **I-3 Lyophilisation** | INJ-17; lyo envelope items in M4; lyophiliser adapter | a lyophilised vial batch runs to release |
| **I-4 Other containers and routes** | PFS and cartridges (INJ-27, 28), LVP bags and bottles and FFS (INJ-29), BFS (INJ-30), dual-chamber, sterile powder (INJ-31), suspensions and emulsions, terminal radiation, post-aseptic heat treatment | one sandbox batch per form |
| **I-5 Automated inspection, CCIT and RMM** | INJ-22 semi-automatic and automated, INJ-23 deterministic methods, RMM in INJ-26; inspection and CCIT adapters | automated runs bind to the batch; RMM results gate release |
| **I-6 Edition exit** | `injectables` added to `compliance/phase.yaml` editions; full trace of the 91 controls; golden batches (one per I-1..I-3 form); browser suite; one review pass | trace green with the edition in the gate |

I-1 and later split into sub-slices of one PR each (about 4-6 per slice), planned at the start of the slice.

## 8. Trace gate during the build

Adding `injectables` to `compliance/phase.yaml` today would make all 91 controls due at once (target phase 5, current
phase 7), so the gate stays as it is until I-6. Meanwhile a per-edition trace report (`pnpm trace --edition
injectables`) lists each control's tests; a slice's own controls must be fully proven by that report before it merges
(a `[meta]` test in tools/register holds the list per slice). No control file and no `expert_decision` changes.

## 9. Screens and simplicity

The floor uses the generic library renderer; no per-block screens. New screens only for the modules: the clean-area
board (one tile per room: grade, status, validity, live pressure and particles), EM entry and results, the APS board
per line, the intervention quick log (one tap, big targets, works with gloves on a terminal), inspection counts, and the
sterile release dossier. Each slice ends with a Simplicity review: fewest clicks per act, plain words, one primary action
per screen, every block readable on a terminal, no sterile jargon a trained operator would not use.

## 10. Risks

| Risk | Mitigation |
|---|---|
| The host move collides with the Tablets session (PR #100 and later) | I-0 waits for an agreed window with the lead; a mechanical `git mv` with import rewrites only; Tablets suite unchanged as the acceptance |
| The sterile modules grow into a second product | each module is limited to the controls listed in section 3; anything else is a block (data) |
| `DEVICE_RECORD` grows into block programs again | one generic type; machine specifics are adapter profiles and formulation values, never field-type code |
| Guidance-derived behaviours in the controls conflict with the owner's binding-only rule | Q1: the owner decides, through `expert_decision`; meanwhile the controls are built as written |
| Edition-local data versus shared site data (persons, lots) | ADR 0001 mirrors and reservations already exist; I-0 proves one person and one lot across both editions |
| Size: 91 controls, about 31 library blocks, 8 modules | slice order puts the simplest route first; each slice is usable on its own |
| Equipment interfaces differ per site | manual entry with printout and second-person check is always available in `DEVICE_RECORD` |

## 11. Open questions

| # | Question | Default if no answer |
|---|---|---|
| Q1 | Some control behaviours rest only on guidance (mainly FDA 2004 aseptic guidance: the enforced FDA APS incubation scheme, FDA APS reassessment triggers, FDA alert-level examples). Under the binding-only rule the owner, as expert, may mark those clauses DONT_FOLLOW or MODIFY. I-0 delivers the list. | built as written until the owner records an expert decision |
| Q2 | Unfreeze the site gateway (decision 0026) for the sterile adapters only? | yes, adapters only |
| Q3 | Platform: is Injectables the same platform product `ebmr` (edition chosen per deployment, own database), or a second product entry in databsee? New `ebmr.*` permission codes for sterile acts (EM, APS, interventions, inspection) go to the lead. | same product `ebmr`, codes sent to the lead per slice |
| Q4 | Prefilled syringes, cartridges and dual-chamber are combination products (US 21 CFR Part 4; EU MDR Article 117). The register's Part 4 row is unverified. The eBMR covers the drug manufacturing record and device functional tests only; device design controls are out. | as stated |
| Q5 | Parametric release needs EU Annex 17, which is not in the register yet. | INJ-21 builds the parametric acceptance set; release by it stays off until Annex 17 is checked |
| Q6 | Outline 2.4 left out sterile powder filling, biologics (Annex 2), radiopharmaceuticals, advanced therapies and continuous manufacturing. The plan now includes sterile powder filling (a filling method). Biologics, radiopharmaceuticals, advanced therapies and continuous manufacturing are product classes or regimes with their own binding annexes. | in the plan only if the owner says so; flagged here, not dropped silently |
| Q7 | I-0 moves shared code out of `apps/tablets-*`. It needs a window agreed with the Tablets session. | after PR #100 merges, in a quiet window the lead names |
