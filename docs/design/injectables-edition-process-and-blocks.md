# Injectables edition: process and building-block specification (MBR designer)

Scope: the INJECTABLES edition of the eBMR (sterile injectables made in India, often exported). It covers aseptically filled vials, ampoules and prefilled syringes/cartridges, lyophilised products, terminally sterilised small- and large-volume parenterals, aseptically compounded non-filterable products, and the isolator / RABS / conventional / BFS / FFS / single-use technology profiles. It tells the MBR designer which typed building blocks exist, how they are configured, what the engine enforces and which control each block implements. It is a specification, not code.

Inputs and precedence (highest first):
1. Official texts in `primary/` (EU Annex 1 2022, FDA aseptic guidance 2004, 21 CFR 211).
2. The control catalogs: `digest-sterile-controls.md` (ST-01..ST-79), `digest-india.md` (IN-01..IN-52; injectables IN-40..IN-51), `digest-production.md` (PR-01..PR-60), `digest-data-integrity.md` (DI-01..DI-50). Blocks implement these controls and never contradict them.
3. Research and configurability files: `research/injectables.json`, `_sterile-blocks-and-limits.json`, `_blocks-injectables.json`, `_blocks-both.json`. Where these disagree with (1) or (2), (1)/(2) win and the disagreement is listed in G.3.

All regulatory content is paraphrased.

## Conventions

- **Block IDs.** `KB-nn` = kernel block shared with the Tablets edition (listed here only as far as the injectables edition uses it). `IB-nn` = injectables-edition block. `UP-nn` = unit procedure template. `V-n` = process variant.
- **Types** (same meaning as in the catalogs). ENFORCED = engine behaviour no tenant, site, MBR or administrator can weaken. CONFIGURABLE = safe default plus an allowed range, tighten-only against the floor table (ST-01). DESIGN-CHOICE = product decision not demanded by a text; can be switched off per site only with a recorded rationale unless stated otherwise.
- **Market profile.** India is always in the set (every batch is made under an Indian licence, IN-52). A batch adds US and/or EU. The **shipped default profile is India + EU + US**. Product-level rules resolve to the strictest value across the batch's markets; line-, room- and person-level rules resolve across every product qualified on that line or room (ST conventions). The resolved value and the market that drove it are stored in the record (IN-52).
- **Evidence markers.** [P] = re-checked in a primary text during this pass. [C] = taken from a control catalog (which was itself checked against primary text). [R] = research/secondary only, not in the uploaded primary texts: shown for information or as master data, **never used as a hard floor** unless a catalog control already enforces it.
- **Gate vocabulary** (from ST catalog): *Block* = step cannot start or be signed. *Deviation-gate* = work continues only after a deviation is raised and a QA decision is recorded. *Release block* = QA disposition / QP certification signature unavailable.
- Times are server time (UTC + site offset); values are stored at full precision with units (DI-02, DI-27, DI-33).

---

## A. Process variants and ISA-88 structure

### A.1 How ISA-88 maps onto the injectables MBR

| ISA-88 element | Meaning in this edition | Where it is defined |
|---|---|---|
| Procedure | One approved MBR version for product x strength x batch size x line (discrete approved sizes only). | PR-01, PR-02, IN-13 |
| Unit procedure (UP) | A stage bound to one unit or equipment train (compounding train, filter train, filling line, lyophiliser, steriliser, inspection station, packaging line). Templates UP-00..UP-16 below. | A.3 |
| Operation (OP) | Ordered group of phases inside a UP (e.g. "PUPSIT", "post-use integrity test"). | A.3 |
| Phase | One configured instance of a building block (KB/IB) with its parameter bindings. | Section B |
| Product attribute: sterility-assurance route | terminal / aseptic / aseptic + post-aseptic terminal heat treatment. Selects the variant template and rule set; any route other than terminal needs a justification reference. | ST-02, IB-01 |
| Line attribute: technology profile | isolator (open/closed), RABS (open/closed), conventional A-in-B, BFS, FFS, closed/SUS. Inserts or removes blocks automatically (glove tests, bio-decontamination, door log, BFS/FFS CPPs, SUS checks). | ST-74, IB-10, IB-11, IB-22 |

### A.2 Process variants

| Code | Variant | Route | What distinguishes it | Key controls |
|---|---|---|---|---|
| V-1 AF-VIAL | Aseptically filled solution in vials | aseptic | Sterilising filtration; filling and full stoppering in Grade A; capping either aseptic (sterilised caps) or as a clean process under Grade A air supply with stopper-height detection. | ST-50..57 |
| V-2 AF-AMP | Aseptically filled glass ampoules, fusion (flame) sealed | aseptic | Tunnel-depyrogenated ampoules; fusion sealing parameters monitored; **100% CCI** (glass ampoules, any volume); no capping. | ST-64 [P 8.22] |
| V-3 AF-PFS | Prefilled syringes / cartridges from ready-to-use nested tubs | aseptic | RTU tub acceptance and surface-decontamination transfer; plunger placement by vacuum or vent tube; CCI by justified sampling; device assembly (plunger rod, backstop, safety device) and functional IPCs in packaging. Combination-product (21 CFR Part 4) detail is unverified. | ST-40, ST-56, ST-64 |
| V-4 AF-LYO | Aseptically filled and lyophilised in vials | aseptic | Partial stoppering; Grade A transfer and loading; freeze-drying cycle; in-chamber stoppering; unloading; capping. Lyophilisation is an extension of aseptic processing until full sealing; sterility samples per lyo load. | ST-58, ST-59, ST-66 |
| V-5 TS-SVP | Terminally sterilised small-volume parenterals (vials or ampoules), moist heat | terminal | Preparation >= Grade D (C at unusual risk); filling >= Grade C (A in C at unusual risk); bioburden-reduction filtration where possible; loads are sub-batches; per-load sterility samples from coolest positions. | ST-60, ST-61 [P 8.1-8.5, 10.6] |
| V-6 TS-LVP | Terminally sterilised large-volume parenterals (bags/bottles, including FFS/BFS made for terminal sterilisation) | terminal | Air-overpressure or superheated-water cycles; non-rigid container distortion prevention and post-cycle deformation/leak inspection; glass ampoules, BFS units and fusion-sealed containers <=100 mL 100% CCI, other fusion-sealed containers >100 mL reduced sampling only with justification; LVP endotoxin step on water/intermediate cannot be removed from the MBR (India). | ST-61, ST-64, IN-46 |
| V-7 AC-SUSP/EMUL | Aseptically compounded non-filterable suspensions/emulsions | aseptic | All contact equipment and all components sterilised; every addition aseptic in Grade A/B with sterility evidence; homogenisation; agitation during filling; formulation-stage simulation at least twice a year. Lipid emulsions may instead follow V-5/V-6. | ST-29, ST-40 [P 8.11] |
| V-8 BFS/FFS aseptic | Blow-fill-seal or form-fill-seal under aseptic conditions (optional profile) | aseptic | Extrusion/forming/sealing CPPs imported continuously; Grade A critical zone; BFS machine background >= Grade C with operators in Grade A/B garments; 100% CCI for BFS units and for FFS fusion-sealed units <=100 mL. | ST-64, ST-77, ST-78 |
| V-9 Post-aseptic heat treatment | Adjunct terminal moist-heat step after aseptic processing (route "aseptic + post-aseptic heat treatment") | aseptic + adjunct | All aseptic controls still apply; adds UP-11 in adjunct mode. Annex 1 glossary: shown SAL <=10^-6 but not meeting steam-sterilisation requirements (e.g. F0 >= 8 min cited as an example). | ST-02 [P glossary] |
| V-10 APS | Aseptic process simulation (media fill) record type for each aseptic variant/line/format | n/a | Generated from the commercial MBR (same UP/OP structure); media replaces product; air replaces inert gas; incubation and reading UPs; never releasable. | ST-31, ST-32, ST-33 |

Out of detailed scope (framework reusable, blocks not specified here): sterile powder filling, cell-therapy module (ST-69 optional), radiopharmaceuticals.

### A.3 Unit-procedure templates (library)

Grade floors below are the resolved defaults for the India + EU + US profile. Each OP lists the blocks it is built from.

**UP-00 Record issuance and sterility-assurance pre-start** (all variants; no grade)
- OP-00.1 Issue executed record from the effective MBR; bind batch number, batch size, market set and resolved rule pack; show CCS version in force. [KB-01]
- OP-00.2 Readiness gate: room/zone classification and requalification, HEPA/DP/UDAF status, cleaning and sporicide status, return-to-service after maintenance/shutdown, utility release, steriliser readiness, open change controls, unassessed critical alarms. [IB-02, IB-05, IB-08]
- OP-00.3 APS gate: line x process x shift x container/closure configuration current; every sterilisation process used is validated and not suspended. [IB-15]
- OP-00.4 Barrier readiness (isolator/RABS profile): decontamination valid, glove ports in date and passed, enclosure leak test current. [IB-10]
- OP-00.5 Personnel roster and entry gate; gowning entries. [IB-03]
- OP-00.6 EM plan instantiated for every shift the batch will span; particle counters online; EM media lots GPT-released. [IB-04]
- OP-00.7 Processing pre-start clearance (previous product, documents, materials removed). [KB-08]

**UP-01 Dispensing and material issue** (all; Grade C for solutions to be filtered, Grade D for TS preparation, C at unusual risk; sterile powders only in Grade A)
- OP-01.1 Formula scaling and potency/salt/water adjustment; overage stated. [KB-04]
- OP-01.2 Component status: QC-released, within retest/expiry, microbial/bioburden/endotoxin flags met; sterile components with sterility evidence matching the registered method. [KB-05, IB-06]
- OP-01.3 Weigh/measure, independent check, container labels, batch kit. [KB-05, KB-11]
- OP-01.4 (V-7) Sterile material transfer into Grade A (RTP/alpha-beta or validated route). [IB-09]

**UP-02 Primary container preparation** (V-1, V-2, V-4, V-5, V-6 glass; V-3 and RTU vials use the RTU path)
- Path A (washed glass): OP-02.1 wash with WFI final rinse [IB-07, IB-05]; OP-02.2 dry-heat depyrogenation in tunnel or oven [IB-08 dry-heat mode, IB-07]; OP-02.3 sterile-hold clock to end of use [IB-14]. Washing and handling of cleaned items >= Grade D; tunnel exit and staging Grade A.
- Path B (RTU): OP-02.4 RTU lot acceptance (supplier approval, sterilisation certificate, contractor validation review, CoA reliability) [IB-06]; OP-02.5 outer-pack integrity and surface-decontamination transfer (e-beam or VHP cycle) into Grade A [IB-09, IB-10]; OP-02.6 tub/nest counts to accountability [IB-25].
- TS variants: containers cleaned by a validated process controlling particles, endotoxin and bioburden; depyrogenation per product risk.

**UP-03 Closure preparation** (stoppers, plungers, tip caps; caps/seals) (not V-2)
- OP-03.1 Wash (low-endotoxin water first washes, WFI final rinse), siliconise (released silicone lot), steam-sterilise with validated load pattern, dry; or RTU acceptance. [IB-07, IB-08, IB-06]
- OP-03.2 Residual moisture of lyo stoppers (product-specific limit). [KB-09]
- OP-03.3 Cap lot, colour/cautionary text; cap sterilisation record when capping is aseptic. [IB-19]

**UP-04 Equipment, product path and barrier preparation** (aseptic variants; TS uses cleaned equipment unless the CCS requires sterilisation)
- OP-04.1 CIP/manual cleaning with final-rinse quality; dirty/clean hold. [KB-07, IB-14]
- OP-04.2 Assembly of cleaned parts under HEPA airflow (Grade D) and wrapping. [IB-09]
- OP-04.3 Autoclave loads against validated load patterns; SIP of vessels, lines and filter housings; post-SIP pressure hold. [IB-08]
- OP-04.4 SUS receipt/pre-use verification and connections. [IB-11]
- OP-04.5 Isolator cleaning then bio-decontamination; RABS sporicidal disinfection; glove tests. [IB-10]
- OP-04.6 (V-4) Lyophiliser SIP and readiness. [IB-20]

**UP-05 Compounding** (bulk preparation)
- OP-05.1 T0 event (definition fixed in MBR, e.g. first WFI into vessel) starts the product clocks. [IB-14]
- OP-05.2 WFI draw with point-of-use status. [IB-05, KB-05]
- OP-05.3 Additions in defined order with charge-in verification. [KB-06, KB-11]
- OP-05.4 Dissolution/mixing (speed, time, temperature); inert-gas sparge/overlay through a sterilising gas filter; dissolved oxygen where relevant. [IB-12, IB-05]
- OP-05.5 pH adjustment loop with maximum cumulative adjusting agent. [IB-12, KB-14]
- OP-05.6 q.s. to final weight (via density) or volume. [IB-12, KB-04]
- OP-05.7 Bulk IPCs (pH, density, osmolality, assay, clarity/appearance) and bulk endotoxin where specified. [KB-09, IB-26]
- OP-05.8 Bulk yield and bulk hold (conditions, N2 blanket, light protection). [KB-15, KB-16, IB-14]
- Grades: aseptic filterable >= Grade C; TS >= Grade D (C when growth-supporting, long hold or not mainly closed vessels; C for ointments, creams, suspensions, emulsions); V-7 aseptic compounding Grade A with Grade B background.
- V-7 extra operations: sterile additions with sterility evidence; homogenisation (pressure, passes, temperature); particle/globule size; agitation during hold and fill. [IB-12]

**UP-06 Sterilising filtration** (V-1..V-4, V-8; V-7 components only) / **bioburden-reduction filtration** (V-5, V-6, where possible)
- OP-06.1 Pre-filtration bioburden sample at end of hold, immediately before the final filter (before the first filter in a redundant train). [IB-26]
- OP-06.2 Install validated filter train; scan part numbers against the registered filter; filter sterilisation evidence. [IB-13]
- OP-06.3 PUPSIT (or referenced waiver) / pre-use integrity test. [IB-13]
- OP-06.4 Filtration with CPP capture (volume, flow, pressures/DP, temperature, time per known volume, total contact time incl. pauses). [IB-13, KB-03]
- OP-06.5 Receiving sterile vessel/bag status (sterilisation or SIP, positive pressure, vent filter). [IB-08, IB-05]
- OP-06.6 Post-use integrity test before removal from housing; redundant/serial logic; vent and gas filter tests. [IB-13]
- OP-06.7 Filtered-bulk hold and filtration-time clocks. [IB-14]

**UP-07 Aseptic line set-up** (aseptic variants; TS variants use a clean set-up in Grade C)
- OP-07.1 Gowning and entry; roster and headcount. [IB-03]
- OP-07.2 Transfer of sterile items into Grade B/A against the approved transfer list. [IB-09]
- OP-07.3 Unwrapping, aseptic assembly and aseptic connections (logged as inherent interventions). [IB-09, IB-16]
- OP-07.4 EM running from the start of set-up (continuous Grade A particles and viable air). [IB-04]
- OP-07.5 Barrier status confirmed; UDAF running; critical alarms clear. [IB-10, IB-05]
- OP-07.6 Set-up fill weights per needle; set-up units counted separately. [IB-18, IB-25]
- OP-07.7 Pre-fill checklist and authorisation to start filling (APS gate re-checked). [KB-02, IB-15]

**UP-08 Filling and primary closure**
- OP-08.1 Filling (line speed within APS envelope; counters; restart after stoppages). [IB-17]
- OP-08.2 Fill weight/volume IPC per needle; SPC. [IB-18]
- OP-08.3 Closure: full stoppering (V-1), partial stoppering (V-4), fusion sealing (V-2), plunger placement (V-3); presence/position detection. [IB-17]
- OP-08.4 Inert-gas overlay and headspace oxygen where relevant. [IB-17, IB-05]
- OP-08.5 Interventions and stoppages; post-intervention glove print and outer-glove change. [IB-16, IB-04]
- OP-08.6 EM/PM during fill; end-of-operation surface sampling after fill end. [IB-04]
- OP-08.7 Event-driven sterility pulls (start, middle, end, post-intervention, post-interruption). [IB-26]
- OP-08.8 Filler accountability. [IB-25]
- Grades: aseptic Grade A with Grade B background (isolator: background per ST-74); TS Grade C (Grade A with >= C background when the CCS shows unusual risk: slow filling, wide-necked containers, exposure beyond a few seconds).

**UP-09 Lyophilisation** (V-4)
- OP-09.1 Lyophiliser readiness (SIP rule by loading mode, leak rate at cycle start, vent filter sterilised, trays inspected). [IB-20]
- OP-09.2 Grade A transfer and loading (shelf map; partial-stopper exposure timer). [IB-20, IB-14]
- OP-09.3 Cycle execution and record against validated recipe. [IB-20, KB-03]
- OP-09.4 Backfill, in-chamber stoppering, unloading, stopper-seating check. [IB-20]
- OP-09.5 Load counts (loaded = unloaded + broken/fallen + removed); per-load sterility samples; moisture/cake IPC. [IB-25, IB-26, KB-09]

**UP-10 Capping / crimping** (V-1, V-4, vials in V-5)
- OP-10.1 Capping mode and zone status (aseptic; clean process under Grade A air supply with >= Grade D background; manual only in Grade A). [IB-19]
- OP-10.2 Stopper-height detector challenge before capping; rejects counted. [IB-19, IB-25]
- OP-10.3 Crimp quality checks; stopper-to-crimp clock. [IB-19, IB-14]

**UP-11 Terminal sterilisation** (V-5, V-6; V-9 adjunct mode)
- OP-11.1 Preparation-to-sterilisation clock; pre-sterilisation bioburden at worst case/end of hold. [IB-14, IB-26]
- OP-11.2 Build loads as sub-batches against validated load patterns; pre-cycle nozzle/drain checklist for spray/superheated-water autoclaves. [IB-21, KB-16]
- OP-11.3 Cycle record: probes, F0 per position, pressure/overpressure, cooling medium sterility evidence. [IB-08, IB-21]
- OP-11.4 Unload: deformation/leak inspection (non-rigid), counts, sterilised status. [IB-21, IB-25]
- OP-11.5 Per-load sterility samples from coolest/slowest-heating positions; parametric-release branch if authorised. [IB-26, IB-21]

**UP-12 100% visual inspection and acceptance sampling** (all) [IB-23, IB-25]

**UP-13 Container-closure integrity** (100% for glass ampoules, BFS and fusion-sealed <=100 mL; sampled otherwise; vacuum retention for vacuum-sealed) [IB-24, IB-25]

**UP-14 QC release sampling and reserve samples** (sterility, endotoxin, particulate, content, reserve) [IB-26, KB-09]

**UP-15 Labelling and secondary packaging (batch packaging record)** — line clearance, printed material issue, coding and vision challenges, serialisation, PFS device assembly and functional IPCs, time out of refrigeration, reconciliation. [KB-08, KB-17, IB-18, IB-14, IB-25]

**UP-16 Review, sterile release dossier and disposition** [IB-30, IB-27, IB-29, KB-19]

APS record type (V-10): UP-00 (APS mode), UP-04, UP-06 (media filtration), UP-07, UP-08, UP-09 (V-4), UP-10 plus **UP-A1 incubation** and **UP-A2 reading and reconciliation** [IB-28]; no UP-12..UP-16 release steps.

### A.4 Variant sequence matrix

Y = required; opt = configurable / conditional; – = not used. Order top to bottom is the default execution order (parallel branches allowed for UP-02/03/04 via KB-14).

| UP | V-1 VIAL | V-2 AMP | V-3 PFS | V-4 LYO | V-5 TS-SVP | V-6 TS-LVP | V-7 AC | V-8 BFS/FFS aseptic | V-10 APS |
|---|---|---|---|---|---|---|---|---|---|
| UP-00 issuance and gates | Y | Y | Y | Y | Y (no APS/aseptic roster gates) | Y (same) | Y | Y | Y (APS mode) |
| UP-01 dispensing | Y | Y | Y | Y | Y | Y | Y (sterile components) | Y | media |
| UP-02 containers | Y (A) | Y (A) | Y (B, RTU) | Y (A) | Y (A, depyro per risk) | opt (bags/bottles; FFS/BFS form in-line) | Y | – (formed in machine) | Y |
| UP-03 closures | Y | – | Y (plungers/tip caps) | Y (low-moisture) | Y (vials) | opt (ports/caps) | Y | opt (added caps) | Y |
| UP-04 equipment/barrier/SUS | Y | Y | Y | Y (+lyo SIP) | opt (clean; sterilised if CCS) | opt | Y | Y (product-path SIP) | Y |
| UP-05 compounding | Y | Y | Y | Y | Y | Y | Y (aseptic) | Y | media prep |
| UP-06 filtration | Y (sterilising) | Y | Y | Y | opt (bioburden-reduction) | opt | components only | Y | media (if filtered) |
| UP-07 aseptic set-up | Y | Y | Y | Y | clean set-up | clean set-up | Y | Y | Y |
| UP-08 fill and close | Y (stopper) | Y (fusion seal) | Y (plunger) | Y (partial stopper) | Y (Grade C / A-in-C) | Y | Y | Y (form-fill-seal) | Y |
| UP-09 lyophilisation | – | – | – | Y | – | – | – | – | Y (V-4 lines) |
| UP-10 capping | Y | – | – | Y | Y (vials) | opt | opt (vials) | opt (added caps) | opt (vials, as the protocol defines) |
| UP-11 terminal sterilisation | V-9 opt | V-9 opt | – | – | Y | Y | opt (emulsions via V-5/6) | opt (terminal FFS/BFS -> V-6) | – |
| UP-12 visual inspection | Y | Y | Y | Y (+ supplemental destructive for cake) | Y | Y | Y | Y | pre-incubation inspection only |
| UP-13 CCI | sampled (vacuum retention if under vacuum) | 100% | sampled | sampled + vacuum retention if under vacuum | per container (100% for glass ampoules) | 100% for BFS units and fusion-sealed <=100 mL; >100 mL justified reduced sampling | per container | 100% (BFS units; FFS <=100 mL) | – |
| UP-14 QC/reserve samples | Y | Y | Y | Y (per lyo load) | Y (per load) | Y (per load) | Y | Y | – |
| UP-15 packaging | Y | Y | Y (+device assembly) | Y | Y | Y | Y | Y | – |
| UP-16 review/disposition | Y | Y | Y | Y | Y | Y | Y | Y | APS closure (never release) |

### A.5 Technology-profile overlays (line attribute, ST-74)

| Profile | Background floor (resolved) | Blocks inserted | Notes |
|---|---|---|---|
| Open isolator | >= Grade C | IB-10 (cleaning then sporicidal vapour bio-decontamination; "valid until"; glove tests start and end of batch/campaign; enclosure leak test; continuous overpressure and exit-port overpressure; RTP/transfer log) | FDA text: background commonly ISO 8, never unclassified; EU floor is stricter and applies. |
| Closed isolator | >= Grade D (CCS risk assessment) | IB-10 as above | |
| RABS (open/closed) | >= Grade B | IB-10 (glove sterilisation before fitting and before each campaign; door-opening events with assessment; disinfection after glove exposure; periodic sporicidal disinfection of interior) | |
| Conventional A-in-B | Grade B | IB-02 requires a CCS justification reference before the line is released for use | |
| BFS | aseptic: machine >= Grade C, operators in Grade A/B garments; terminal: >= Grade D | IB-22 BFS mode | ST-77 |
| FFS | per route (terminal: ST-60 grades; aseptic: A/B) | IB-22 FFS mode | ST-78 |
| Closed / SUS | Grade A if integrity could be compromised; lower grade only with integrity result at every use | IB-11 | ST-79 |

---

## B. Building-block catalog

### B.0 How to read a block

Every block below has: **Purpose**; **Config** (option: default -> allowed range; "tighten-only" means the value may be made stricter than the floor but never looser, ST-01); **Fields** captured; **Enforced** engine rules (ENFORCED unless marked); **Links** to other records/blocks; **Implements** (control IDs); **Sources**. Common to every block and not repeated: each captured value carries unit, user, server time, source, instrument ID and MBR version/step (DI-02); corrections keep the original and need a reason (DI-24, PR-12); every signature is a full Part 11 / Annex 11 e-signature with manifestation and record binding (DI-35..DI-38); every system-detected breach creates a non-deletable exception (KB-13); training/role is checked at every signature (IB-03, PR-15).

Totals: **19 kernel blocks (KB-01..KB-19) + 30 injectables blocks (IB-01..IB-30) = 49 blocks.**

### B.1 Kernel blocks used by the injectables edition

#### KB-01 Batch record issuance, numbering and market rule-pack binding
- **Purpose:** create the executed record (ISA-88 control recipe) from the effective MBR and bind batch number, size, markets and the resolved rule pack.
- **Config:** number format (any unique format); batch size = one of the MBR's discrete approved sizes (ranges/free scaling not offered, PR-01); market set at issue (India fixed; add US/EU); packaging orders may narrow the set later under control; extra issuance approval and evaluation for the first batch after a change (default on, IN-03); process-validation flag (PPQ / concurrent validation) with enhanced sampling plan and release held until the validation outcome is recorded (PR-09).
- **Fields:** MBR ID/version/effective date/content hash; product, strength, dosage form, container-closure, nominal fill; batch size (L or kg and theoretical units); batch number; market set; rule-pack version and governing market per resolved parameter; site/line/rooms with grade and barrier type; CCS version in force; manufacturing licence and (if any) loan-licence numbers; issuer e-signature ("issued, reproduction verified").
- **Enforced:** only an Effective MBR valid for every market in the set can be instantiated; instance hash-checked against master; batch number unique site-wide and never reissued (including cancelled records); rework gets a new number and parent link; later MBR edits never change an issued record; test/training runs segregated and watermarked; a market-set change before release re-resolves every rule and forces QA review.
- **Links:** IB-01 (approved MBR), IB-15 (container size and batch size vs APS envelope at creation), IB-30.
- **Implements:** PR-01, PR-04, PR-05, PR-09, PR-10, IN-03, IN-13(a), IN-18, IN-30, IN-52, DI-10, DI-42, ST-01 (limit versions stamped), ST-02 (CCS version on header), ST-04 (QA-approved MBR only).
- **Sources:** 21 CFR 211.186(a), 211.188(a); EU Ch.4 4.2, 4.20; Schedule M Part I 14.32, 17.3.6, 17.3.10.

#### KB-02 Instruction and typed data capture
- **Purpose:** show approved instructions and capture numeric, choice/checklist, free-text and date/time data.
- **Config:** parameter code, unit (controlled catalogue), precision; target and tiered limits (registered / internal action / optional alert) with inclusive/exclusive bounds and compendial rounding rule attached; criticality (CPP / KPP / non-critical); allowed sources (device / automation / manual); verification requirement; N/A allowed only for conditional items with signed reason; mandatory comment when out of limit; approved translations; SOP link; late-entry window (DESIGN-CHOICE default 15 min; no text gives a number).
- **Fields:** value with metadata; for manual critical values the verifier; for late entries claimed activity time, entry time, reason.
- **Enforced:** nothing pre-filled; each checklist item stored individually; value committed before limit evaluation; out-of-limit values stored and flagged, never replaced; registered-limit breach auto-creates a deviation flagged "registration-relevant"; manual critical data needs an accuracy check (second person or validated electronic check; "none" not selectable); free text can never be the source of a GMP field; user-entered event times never replace the server timestamp; only registered, grade-rated devices open sessions in classified areas and Grade A/B steps are paperless (DESIGN-CHOICE per ST-02/ST-13).
- **Links:** KB-11, KB-13.
- **Implements:** PR-03, PR-08, PR-11, PR-12, IN-06, IN-07, DI-02, DI-24, DI-28, DI-29, DI-30, ST-04, ST-13 (device rules).
- **Sources:** 21 CFR 211.100(b), 211.188(b), 11.10(e); EU Annex 11 sections 5, 6, 9; EU Ch.4 4.8-4.9.

#### KB-03 Equipment phase / Level-2 data import and external evidence
- **Purpose:** exchange setpoints, actuals, trends, alarms and reports with PLC/SCADA/historian, sterilisers, tunnels, lyophilisers, integrity testers, particle counters and EMS; attach external evidence.
- **Config:** equipment class and phase/recipe ID; formula-parameter to tag mapping; values to collect (actuals, totals, min/max over window, end-of-phase report); sampling interval; acceptance limits; alarm classes imported and review-relevant; fallback sub-procedure; permitted file types and capture method.
- **Fields:** provenance for each value (source system, tag, device ID, source timestamp, raw value, unit); recipe read-back; attachment hash.
- **Enforced:** setpoints only from approved values; download read back and compared before start; interface loss, stale data or read-back mismatch raises an exception; manual fallback only via the MBR path, flagged and verified; no silent drop, default substitution or partial commit; dynamic data (cycle traces, lyo trends, integrity-tester files) kept native with a viewer; attachments immutable; paper originals true-copied before discard; where automated equipment performed the operation, one person confirms it (211.68(c) scope only).
- **Links:** IB-08, IB-13, IB-20, IB-04, IB-05.
- **Implements:** DI-31, DI-32, DI-41, PR-14, ST-19 (particle stream), ST-44 (duplex channels), ST-59 (lyo SCADA), ST-06 (feed gaps).
- **Sources:** 21 CFR 211.68(a)-(c); EU Annex 11 section 5; FDA DI Q&A (2018) Q9-Q10.

#### KB-04 Calculation engine (including formula scaling and potency adjustment)
- **Purpose:** every GMP derivation in Section C (quantities, densities, fill targets, yields, F0, times, reconciliations).
- **Config:** expression from the closed, validated function library; output unit/precision; rounding policy (full precision internally, rounding only at limit comparison/report); limits on result; display of formula; verification requirement.
- **Enforced:** sandboxed, side-effect-free; unit/dimension check and cycle detection at design time; lot values (assay, water, density) pulled from approved results, never typed; potency-adjusted target that would deliver less than 100% of label is refused; correction of an input recomputes and keeps the old result; no manual override; trace (inputs, versions, output) stored; yield calculations verified by one person (automated) or a second person (manual).
- **Implements:** DI-33, PR-19, PR-31, IN-17.
- **Sources:** 21 CFR 211.68(b), 211.101(a), 211.103 [P]; EU Annex 11 sections 5-6.

#### KB-05 Dispensing (gravimetric and volumetric) with independent check
- **Purpose:** dispense APIs, excipients and WFI to calculated targets.
- **Config:** tolerance per item (company-defined; research examples of +/-0.5% API and +/-1-2% excipients are illustrative [R] and not shipped); method (net/gross/by difference/whole container); volumetric principle (flow-meter totaliser, load cell, calibrated vessel) with density source recorded (specification / lot CoA / measured); lot proposal FEFO or FIFO (override needs reason); verification mode (manual two-person default; one human verifier only with a validated automated device under 211.68).
- **Fields:** material code, supplier lot, internal control number, status, retest/expiry, target, tolerance, gross/tare/net, balance ID and daily check, room/grade, time, dispenser, verifier; WFI point of use, quantity, temperature; label (component, control number, quantity, destination batch, container ID).
- **Enforced:** only released, in-date, correct-item lots; identity by scan; balance calibrated and suitable (minimum weight, readability); weight captured from device (manual keying only as flagged fallback with verification); out-of-tolerance needs a deviation; second person confirms release status, quantity and identification of every container (one person when weighing was automated); India vendor-history excipient route blocked for any batch with US or EU in the set; lots flagged for bioburden/endotoxin need results before issue (IB-06).
- **Links:** KB-04, IB-06, IB-05, KB-11.
- **Implements:** PR-18, PR-19, PR-20, IN-23, IN-24, ST-39 (at issue), ST-05 (balance), DI-30.
- **Sources:** 21 CFR 211.84, 211.101(a)-(c), 211.68; EU Ch.5 5.34-5.39; Schedule M Part I 14.14-14.20.

#### KB-06 Material identification and charge-in
- **Purpose:** add dispensed containers to the right vessel, in the right order, once.
- **Config:** sequence (strict / free within group / parallel); addition rate or time; partial charges and rinses; verification rule.
- **Enforced:** each container scanned and must belong to this batch and step and not be consumed; status/expiry re-checked; step cannot complete while any required container is uncharged; manual charge-in needs a different second person (one verifier only for automated addition).
- **Implements:** PR-21, IN-15, DI-30.
- **Sources:** 21 CFR 211.101(d), 211.188(b)(3)-(4),(11); EU Ch.4 4.18(d).

#### KB-07 Equipment status, cleaning and logbook
- **Purpose:** bind equipment units, prove fitness, record cleaning (manual or CIP) and keep logbooks.
- **Config:** equipment class and capacity; permitted units; clean-hold and dirty-hold (values from cleaning validation, mandatory, no shipped number); CIP recipe and final-rinse limits (e.g. conductivity/TOC); changeover cleaning level; campaign rule (maximum batches or hours plus validation reference).
- **Fields:** unit ID; qualification, PM, calibration status; cleaning cycle ID, procedure version, final-rinse result; dirty/clean times; logbook entries (use, cleaning, maintenance, calibration, repairs).
- **Enforced:** wrong class, overdue calibration/PM, dirty or in-use-elsewhere unit blocks the step; a reading from an overdue instrument accepted only via deviation; as-found out-of-tolerance lists every batch since the last good calibration; state chain dirty -> cleaned -> dried -> sterilised -> in use with hold limits; out-of-spec CIP final rinse leaves the item "not clean"; endotoxin removal credited only to cleaning or dry heat (never to moist heat or filtration); product-contact equipment re-sterilised for every batch unless a validated campaign rule exists (exceeding it refused); dedication flags on product-contact parts (e.g. filters, filling needles) and penicillin segregation enforced; logbooks auto-filled in chronological order; manual cleaning needs performer plus verifier (single verifier for validated automated CIP); an equipment failure signal takes the unit out of use.
- **Links:** IB-08, IB-14, IB-02.
- **Implements:** PR-22, PR-23, PR-24, PR-27, IN-25, ST-05, ST-38, DI-49 (equipment events).
- **Sources:** 21 CFR 211.63, 211.67, 211.68, 211.105 [P], 211.182; EU Ch.4 4.31; EU Annex 1 5.4, 8.18(i); FDA-AP IX.C.

#### KB-08 Room/line status and line clearance
- **Purpose:** pre-start clearance for processing; before- and after-use clearance for packaging; room/line occupancy.
- **Config:** checklist per room/line and operation (processing checklist default on; packaging checklist always); second-person verifier default ON (CONFIGURABLE: required by text only when the site designates clearance a significant step, PR-34); repeat clearance after interruption default on; photo evidence optional.
- **Enforced:** previous batch closed in room and equipment logs; equipment clean; no materials of other orders allocated; previous product/batch shown by the system; any failed item blocks start; packaging: clearance signed before any print job or line start and post-use inspection before order close; one active packaging order per line; a room occupied by another product refuses a second unless configured as segregated with a risk reference; room conditions for the step window attached.
- **Implements:** PR-25, PR-26, PR-34, PR-35, IN-21, IN-26, ST-14 (one batch per room; incompatible activities).
- **Sources:** 21 CFR 211.67(b)(6), 211.130(e), 211.188(b)(6); EU Ch.5 5.40, 5.50; Schedule M Part I 18.2.5, 18.4.1-18.4.2, 18.5.2-18.5.3.

#### KB-09 Sampling and IPC test
- **Purpose:** uniquely identified samples with chain of custody; IPC tests with n readings and statistics.
- **Config:** sample type, quantity, container, point (location / time / event / every n units), plan reference, label template, LIMS mapping; IPC readings per sample, grouping (per needle, station, shelf), individual and mean limits, statistics, frequency (with QRM reference), retest rule reference.
- **Fields:** sample ID; label (material/product, batch, container number, sample number, sampler, date); sampler; time; quantity; readings with instrument ID and calibration, method version, performer.
- **Enforced:** system-generated IDs and labels; sample quantities flow to yield/accountability; missed, late or short samples are exceptions; every reading retained and a repeat never overwrites; IPCs that are specification tests follow the OOS workflow (original stays, OOS open until investigation closes); reagents and buffers checked for expiry.
- **Implements:** PR-29, IN-20(c)-(d), DI-29.
- **Sources:** 21 CFR 211.84(c), 211.110(a)-(c) [P], 211.160(b), 211.188(b)(5),(10); EU Ch.4 4.25-4.26; Schedule M Part I 19.6.6-19.6.7.

#### KB-10 Timer and time-limit engine
- **Purpose:** minimum/maximum elapsed times between recorded events within a step, across unit procedures or across batches. The sterile mandatory set is IB-14.
- **Config:** start and stop events; minimum, maximum; warning threshold (DESIGN-CHOICE default: warning when 10% of the limit remains; may be earlier); pause handling (count or exclude, per rule); breach behaviour (exception only, or exception plus block; the IB-14 mandatory set is always block).
- **Enforced:** durations computed from server timestamps, never typed; timers survive client/server restarts; a step guarded by a minimum cannot complete early; a breach always creates an exception; every limit cites an approved validation or hold-study reference or the MBR cannot be approved; storage condition during a hold is attached.
- **Implements:** PR-30, IN-13, IN-15, DI-27.
- **Sources:** 21 CFR 211.111 [P]; EU Ch.4 4.18(f); Schedule M Part I 17.3.6, 17.3.8.

#### KB-11 Verification / witness
- **Purpose:** independent second-person check, concurrent (witness) or subsequent.
- **Config:** target steps/fields; mode; verifier roles; what must be re-checked (re-scan, view display, compare values); optional stricter independence.
- **Enforced:** verifier is a different authenticated individual and signs with own credentials; cannot precede the action; shows the actual evidence; mandatory for manual dispensing, charge-in, manual yield calculation, critical manual data and significant steps; reduced to one checking person only when qualified automated equipment performed an operation within the 211.68(c) scope (211.101(c)-(d), 211.103, 211.182, 211.188(b)(11)); never relaxes 211.122(g)(3), 211.186(a) or 211.194(a)(8).
- **Implements:** PR-14, PR-20, PR-21, DI-30, DI-35, DI-38.
- **Sources:** 21 CFR 211.68(c), 211.101(c)-(d), 211.103 [P], 211.188(b)(11); EU Annex 11 section 6.

#### KB-12 QA hold point / in-process release gate
- **Purpose:** stop the flow until QA dispositions an intermediate or continuation.
- **Config:** gate position; evidence list (IPC, LIMS, EM, open exceptions); authorised role and number of signatures; allowed dispositions.
- **Enforced:** downstream steps locked until an authorised QA disposition; no release while a mandatory result is missing or failing without a documented QA decision; rejection blocks use in any batch.
- **Injectables uses:** bulk sterility result before downstream processing when the MBR requires it (ST-40); gate before reinspection (IB-23); parametric-release gate (IB-21); optional bulk release to filtration.
- **Implements:** PR-45, ST-40 (bulk sterility gate).
- **Sources:** 21 CFR 211.22(a), 211.110(c) [P]; EU Ch.5.

#### KB-13 Exception, deviation and investigation link
- **Purpose:** capture any departure or system-detected breach and connect it to the QMS.
- **Config:** categories, routing (QC/QA for quality-relevant classes), mandatory fields, QMS mapping.
- **Enforced:** system-detected breaches (limit, status override, time limit, interface failure, late entry, out-of-sequence step, substitute equipment) always create exceptions and cannot be disabled per MBR; exceptions are never deleted, only dispositioned; departures only via an in-line deviation approved by a competent person who is not the raiser; linked batches held; investigation closure needs root cause (or most probable cause), CAPA reference, product-risk statement, non-empty "other batches/products assessed" with per-batch inclusion/exclusion rationale; "human error" needs a system-factor assessment; applies after distribution; EU in set: Annex 16 section 3 fields; release blocked while open (the e-signed QCU/QP justification exception is never available for reconciliation discrepancies or registered-specification failures).
- **Implements:** PR-13, PR-49, PR-50, PR-51, PR-53, IN-20, ST-04, ST-71 (closure fields), DI-34.
- **Sources:** 21 CFR 211.100(b), 211.192; EU Ch.5 5.15; Schedule M Part I 18.2.2, 18.5.12.

#### KB-14 Flow control (branch, bounded loop, parallel, library call)
- **Purpose:** ISA-88 sequencing: alternative branches, bounded repeat loops, parallel branches with joins, reuse of approved library elements (e.g. "PUPSIT", "post-use integrity test", "glove print + glove change").
- **Config:** conditions; branch targets; operator-choice branch roles and reason; loop exit condition, maximum iterations and/or elapsed time; join type; resource constraints; library element and version.
- **Enforced:** branch conditions exhaustive, non-overlapping and reachable (design-time); untaken branches set N/A by the system; loop iterations all retained and a maximum breach always raises an exception; loops allowed only on process endpoints (e.g. pH adjustment, sparging to DO), never on release/acceptance tests (those follow OOS); joins wait for mandatory branches; shared equipment/material conflicts blocked; library element versions frozen at MBR approval with a where-used index.
- **Implements:** DI-34, PR-05, PR-06, IN-20(c).
- **Sources:** 21 CFR 11.10(f), 211.100; ISA-88 Part 2 [R].

#### KB-15 Yield and mass/volume reconciliation
- **Purpose:** actual yield vs theoretical at each appropriate stage (bulk, filling, overall) and mass/volume balances.
- **Config:** stage; theoretical basis (formula, actual charged quantities, previous stage output); categories; minimum and maximum % (mandatory, from the MBR; no shipped numbers); display precision (DESIGN-CHOICE default 0.1%).
- **Enforced:** an MBR cannot be approved with a yield stage lacking min/max; yield computed by the engine, never typed; verified (one person automated / second person manual); outside limits creates an investigation and a release block, with a mandatory explanation (India); sample, waste and reject quantities flow in automatically; blocking the next step on an out-of-limit yield is a DESIGN-CHOICE (see D.3).
- **Implements:** PR-31, IN-17, ST-71 (yield at release), DI-33.
- **Sources:** 21 CFR 211.103 [P], 211.186(b)(7), 211.188(b)(7), 211.192; EU Ch.4 4.17(d), 4.20(g); EU Ch.5 5.8, 5.44; Schedule M Part I 18.2.3.

#### KB-16 Output container status, bulk/bright-stock hold and genealogy (split/merge)
- **Purpose:** identified containers of bulk, intermediates and filled-unlabelled units; quarantine; holds; sub-lots (steriliser loads, lyo loads, trays, part-batches).
- **Config:** container types and tare source; sub-lot numbering; label template; allowed split/merge points; merge rules.
- **Enforced:** system-unique IDs and labels; net = gross - tare by engine; quarantine until QA disposition; hold clock checked at next use and storage excursions pulled in; filled unlabelled trays identified sufficiently for name, strength, quantity and lot and consumed only by a labelling order of the same batch (scan); every sub-lot has its own ID, record section and quantities with system genealogy; merge blocked while any sub-lot has open exceptions, failed IPC or expired hold; genealogy edges committed atomically with the business event.
- **Implements:** PR-38, PR-45, PR-57, IN-15 (per-intermediate hold), ST-61 (loads as sub-batches), ST-66 (sample origin by load).
- **Sources:** 21 CFR 211.80(d), 211.105 [P], 211.110(c) [P], 211.130(b); EU Ch.5 5.53-5.54.

#### KB-17 Packaging: printed materials, coding and vision challenges, reconciliation, serialisation
- **Purpose:** batch packaging record functions for injectable packs.
- **Config:** artwork per destination class (India domestic, India export, US, EU); issuance allowance; counting method; reconciliation limits (narrow, preset, historical); coding check frequency; print-check method (default 100% vision; allowed: start-up plus periodic specimens); challenge plan (start, after stoppage, periodic, end); serialisation profile (US product identifier; EU unique identifier plus anti-tampering device); cold-chain TOR via IB-14; PFS device assembly steps (IB-18).
- **Enforced:** separate approved packaging master per product x pack size x pack type with specimens; only released lots of the specified artwork issued (scan); line clearance before and after; variable data sent from the record (no manual keying), job invalidated if batch data change; failed or missed challenge stops the step and holds output since the last good challenge; batch-coded leftovers destroyed and recorded (witness DESIGN-CHOICE default on); uncoded returns only by counted transaction; reconciliation issued = used + destroyed + returned + samples + rejects + set-aside within limits, no roll-label waiver (India); serial reconciliation zero unexplained before release; India-domestic packs carry manufacturing and expiry dates uncoded (and MRP, Schedule H2 code where applicable [S]); USP <7> ferrule/cap rules as master data [R].
- **Implements:** PR-32, PR-33, PR-34, PR-35, PR-36, PR-37, PR-39, PR-40, PR-42, PR-43, IN-14, IN-16, IN-22, IN-24(d), IN-31, IN-17.
- **Sources:** 21 CFR 211.122, 211.125, 211.130, 211.134; EU Ch.5 5.45-5.62; Schedule M Part I 17.3.1, 17.3.7, 17.3.9, 18.5; DSCSA and Reg. (EU) 2016/161 [R].

#### KB-18 Rejects, returns, reprocessing/reinspection gate and destruction
- **Purpose:** controlled handling of rejected units/material, returned goods, reprocessing, reinspection and destruction.
- **Config:** approved reprocessing sub-procedures; per product "reprocessing disabled" (**injectables default: disabled** unless a validated and registered procedure exists, e.g. re-filtration or re-sterilisation); reinspection procedure; destruction witness (DESIGN-CHOICE default on).
- **Enforced:** "Rejected" is a hard status with restricted location; in-process rejects counted in identified containers; reprocessing only with QCU authorisation linked to an investigation and risk evaluation, as a child record with a new batch number and a mandatory QC decision on additional testing; reinspection only under SOP with QA approval and a deviation, counts kept separately, tightened acceptance sampling after reinspection [R USP <1790>]; returned goods destroyed by default when any doubt is recorded.
- **Implements:** PR-46, PR-47, PR-48, IN-19, IN-24(e), ST-63 (reinspection).
- **Sources:** 21 CFR 211.89, 211.115, 211.165(f), 211.204; EU Ch.5 5.66-5.70; Schedule M Part I 14.32-14.36.

#### KB-19 Record approval, review-by-exception and market-specific disposition
- **Purpose:** section sign-off, production approval, QA review, and disposition per market.
- **Config:** review stages and roles; reduced (exception-only) reports allowed only for steps validated and continuously monitored under change control; release interface to ERP.
- **Enforced:** section sign-off only when all steps complete and exceptions acknowledged, invalidated by any later correction; person responsible for each stage named and processing-lead completion signature (India); production-responsible approval (mandatory with EU in set); exception taxonomy cannot be reduced (limit breaches, deviations, overrides, critical-data corrections, late entries, interface fallbacks, timer breaches, open verifications, alarms, audit-trail events on critical data); audit-trail review of critical data before approval; disposition held per lot and market (US QCU release; EU QP certification only by QP, normally recorded as an external reference from the EU importer; Indian authorised-person release with head-of-QC approval); record locked after disposition; ERP cannot ship unreleased stock.
- **Implements:** PR-16, PR-52, PR-53, PR-54, PR-55, PR-56, IN-05, IN-15, DI-25, DI-26, DI-35, DI-36, DI-37, DI-38, DI-39, ST-70 (base).
- **Sources:** 21 CFR 211.22, 211.188, 211.192; EU Ch.4 4.20(i), 4.21(i), 4.27; EU Annex 11 sections 14-15; Schedule M Part I 17.3.8.

### B.2 Injectables-edition blocks

#### IB-01 Sterile MBR design validator
- **Purpose:** stop non-compliant injectable masters at design time so execution-time checks receive correct inputs.
- **Config:** sterility-assurance route (terminal / aseptic / aseptic + post-aseptic heat treatment; non-terminal needs a justification reference); product risk flags (supports microbial growth, long hold before filling, not processed mainly in closed vessels, ointment/cream/suspension/emulsion, unusual environmental risk: slow filling, wide neck, exposure beyond a few seconds; non-filterable; manual aseptic; hazardous material (live organisms, powders, radiopharmaceuticals: switches the EM plan, ST-18) and hazard class for sex hormones, steroids, cytotoxics (restricts rooms/equipment to contained ones and inserts PPE, containment-check and decontamination steps, IN-27); penicillin/dedication flags (PR-27); short shelf life; parametric release with authorisation reference; LVP; vacuum-sealed; oxygen-sensitive; cold chain); per-step minimum grade and zone type (Grade A zone / Grade A air supply / B / C / D / unclassified; raise only); CCS critical-control-point tags with CCS document ID and version; "Annex 1 principles applied to a non-sterile product" flag (never yields a sterility claim).
- **Fields:** the MBR's step map, grade map, filter train, timer set, intervention-catalogue binding, EM-programme binding, referenced cycles/load patterns, CCS references, pharmacopoeia/edition per limit.
- **Enforced (approval refused unless):**
  1. No limit is looser than the floor table (E); guidance values (10 Pa DP, clean-up <20 min, 0.36-0.54 m/s) may be relaxed only with a CCS reference and QA approval and are shown on every batch (ST-01).
  2. Every CCS critical-control-point step carries the CCS ID and version (ST-02).
  3. Grade mapping follows E-9: exposed sterile product, open primary containers, aseptic assembly, aseptic connections after the final filter, lyophiliser loading, removal of unwrapped items from sterilisers -> Grade A with Grade B background (isolator per E-10); aseptic filterable solution preparation >= Grade C; TS preparation >= Grade D (>= C with risk flags or for semi-solids/suspensions/emulsions); TS filling >= Grade C (Grade A with >= C background with unusual-risk flags); clean-process capping -> Grade A air supply with >= Grade D background; open containers routed only through Grade A zones (ST-55).
  4. Mandatory blocks for the route, variant and technology profile are present and cannot be deleted (A.4, A.5): aseptic -> IB-04, IB-13 (or V-7 rules), IB-14 mandatory set, IB-15 gate, IB-16, IB-23, IB-24, IB-26, IB-30; lyo -> IB-20; TS -> IB-21; vials -> IB-19 (clean-process capping requires stopper-height detection); isolator/RABS -> IB-10; SUS -> IB-11; BFS/FFS -> IB-22.
  5. CCI: glass ampoules, BFS units and fusion-sealed containers <=100 mL carry 100% CCI; >100 mL fusion reduced sampling only with a justification reference; visual inspection not selectable as a CCI method; vacuum-sealed containers carry a vacuum-retention test (ST-64).
  6. Sterilisation methods: UV not offered; EO only with a "no alternative practicable" justification; surface decontamination of a product-contact surface only for heat-labile items with a >=6-log validation reference (ST-42, ST-49).
  7. Final sterilising filter = registered/validated part number, <=0.22 um nominal; a fibre-releasing filter requires a downstream non-fibre-releasing filter of <=0.2 um (0.45 um only with recorded justification that manufacturing conditions require it); asbestos filters never (ST-50).
  8. Non-filterable (V-7): every addition sterile with evidence; all contact equipment and bulk sterilised; bulk sterility-test gate where required (ST-40).
  9. A manual aseptic assembly/connection where SIP or a pre-assembled sterile kit is feasible raises a "justify manual manipulation" review item (DESIGN-CHOICE, ST-02).
  10. The mandatory timer set is complete with validation references (ST-37) and every intermediate has a hold time (IN-13).
  11. DESIGN-CHOICE: a terminal-route product whose validated minimum F0 is below 8 min triggers a route review, because the Annex 1 glossary uses F0 >= 8 min as an example of steam-sterilisation requirements and classes lower-lethality moist heat after aseptic processing as post-aseptic heat treatment [P glossary].
  12. LVP: the water/intermediate endotoxin step cannot be removed; purge/blanket-gas steps reference a sterilising gas filter (IN-46).
  13. Every specification/IPC limit stores its pharmacopoeia and edition (IN-33).
  14. Any change needs a CCS-impact assessment before approval and an effectiveness check after (ST-03, PR-06); preparer, independent checker and QA approval (PR-02).
  15. Area types and equipment classes come from the Part XIII master data (IN-51).
- **Links:** KB-01, IB-14, IB-15, IB-16, IB-04, IB-08.
- **Implements:** ST-01, ST-02, ST-03, ST-14 (step grade), ST-18 (hazardous-product flag), ST-37 (completeness), ST-40, ST-42, ST-49, ST-50, ST-55, ST-60, ST-64, ST-74, IN-13, IN-27, IN-33, IN-41, IN-46, IN-51, PR-02, PR-03, PR-06, PR-07, PR-27.
- **Sources:** Annex 1 section 1, 2.3-2.6, 4.20, 8.1-8.15, 8.20-8.22, 8.27, 8.71, 8.79, glossary [P for 8.1-8.5, 8.20-8.22, 8.27, glossary]; 21 CFR 211.72 [P], 211.113(b), 211.186; Schedule M Part II 4.11, Part XIII.

#### IB-02 Line and room readiness gate
- **Purpose:** at step start, line clearance and shift change, prove that rooms, zones and air systems are fit.
- **Config:** requalification maximum A/B 6 months, C/D 12 months (locked, shorter allowed); HEPA in-place leak test: shipped default 6 months for every classified room (ST-17), maximum allowed A/B 6 months and C/D 12 months (India-only profile: block beyond 12 months, warn beyond 6); tunnel/oven HEPA test 6 months; DP set points: >=10 Pa between different grades (guidance; lower only with CCS reference + QA), >=12.5 Pa aseptic room to unclassified (hard); UDAF velocity per E-3 (India hard minimum 0.36 m/s at working level); clean-up period from room qualification (guidance <20 min; India 15-20 min with 100-fold reduction); maximum door-open time (site); headcount maximum <= APS-qualified; disinfection/sporicide frequency and rotation from the validated programme (no shipped numbers); room-release validity (site).
- **Fields:** room/zone ID; EU grade, ISO class, FDA class, zone type, background; qualification status and due date; "requalification required" flag and reason; DP pairs with window minima; UDAF check date/value; HEPA test dates; airflow-visualisation study reference; cleaning and disinfection log (cleaning before disinfection; agent, lot, sterility status, preparation time, in-use expiry, contact time, areas, operator); sporicide due; fumigation/VHP cycle ID and result; maintenance, shutdown and construction events with return-to-service records; clean-up timer; facility-system attributes of 211.42(c)(10) (read only); status snapshot at execution.
- **Enforced:**
  - Block when: qualification expired or requalification overdue; "requalification required" open (air-movement interruption, HVAC or set-point change, final-filter change, special maintenance, remedial action); room grade below step requirement; HEPA test, UDAF check or airflow study missing/overdue; cleaning, disinfection or sporicide overdue; expired or non-sterile agent in Grade A/B (Grade C/D where the CCS says so); failed fumigation; shutdown without return-to-service record; asset under change control with requalification required (the change-control ID is cited); conventional open line without CCS justification.
  - EM data never counts as qualification evidence.
  - Unplanned maintenance on sterility-critical equipment needs a sterility-impact assessment before work and links to in-process and adjacent batches; maintenance inside a cleanroom inserts cleaning/disinfection, extra EM and re-sterilisation of reassembled parts before restart.
  - After line clearance or disruption the clean-up timer must elapse (optionally until at-rest counts return) before the next batch or resumption.
  - DP below limit during open processing -> impact assessment, then a restoration/confirmation record before the next aseptic step; alarms not clearable without assessment.
  - Spore-former recovery creates a sporicidal-clean task that must precede the next aseptic batch in the area.
  - One batch per room at a time; component preparation, product preparation and filling kept separate.
  - Status and due dates in force are stored in the batch. DESIGN-CHOICE: warn when classification sampling is planned inside a batch window.
- **Links:** IB-04, IB-05, IB-08, IB-10, IB-15, KB-07, KB-08.
- **Implements:** ST-03, ST-12 (room maximum), ST-14, ST-15, ST-16, ST-17, ST-74 (background classification at start), IN-40(c)-(d), IN-43, IN-44 (cleaning), PR-25.
- **Sources:** Annex 1 4.4, 4.14-4.16, 4.23-4.36, 5.3, 5.6-5.7 [C]; FDA-AP IV.A-D [P: 0.45 m/s +/-20%, 10-15 Pa, 12.5 Pa, twice-yearly HEPA test]; 21 CFR 211.42(c)(10), 211.46(b), 211.56; Schedule M Part II 3, 4.3-4.7.

#### IB-03 Personnel qualification, gowning and aseptic roster
- **Purpose:** only currently qualified people perform or sign each activity in each grade; every entry, garment and glove event is traceable.
- **Config:** gowning requalification <=12 months (shorter allowed; recommended shorter for manual or intervention-heavy work); successful APS <=12 months in the role signed (filling, set-up, maintenance intervention, EM sampling, SUS assembly/connection); manual aseptic (EU): per operator x container x closure x equipment train, 3 consecutive initial APS then one about every 6 months (<=6 months); supervised-only mode allowed or not (site); expert observation frequency (DESIGN-CHOICE default at least one per line per month); maximum gown wear time, glove-disinfection interval and maximum laundry/sterilisation cycles from garment qualification (no shipped numbers); training curriculum per grade and task.
- **Fields:** roster (person, role/activity, room, entry/exit times); training snapshot at each signature; gowning qualification date/result (visual plus microbial: gloved fingers, forearms, chest, hood/mask/forehead); APS history (line, shift, process, configuration, role, result); status (qualified / supervised-only / retrain / requalification required / disqualified); fitness declaration (illness, open lesions, recent tissue or culture work); medical-exclusion flag; access authorisation; exceptional supervised entry (person, reason, times, supervising authorised person, cleanliness impact assessment); garment and eye-cover pack lots, sterilisation lot and expiry, pack intact, visual checks before/after donning, exit integrity check; wear timer; glove events (sanitisation, change, breach, instrument replacement); peak headcount; critical-zone transfer count; observation record (observer role, window, operator, checklist, findings, coaching).
- **Enforced:**
  - Signature refused when training on the aseptic curriculum or step SOPs is missing/expired; snapshot stored. EM/PM/bioburden/sterility sampling needs "aseptic sampler" qualification; micro investigations need a microbiology/sterility-assurance approver.
  - No unsupervised Grade A/B signature without gowning qualification <=12 months AND a successful APS <=12 months in that role; otherwise supervised-only (if allowed) or blocked.
  - Status changes automatically on a PM action result or adverse PM trend, implication in a failed APS, a gown breach or observation finding, or QA action; while disqualified or awaiting requalification, the person is refused on Grade A/B steps of every open batch; clearing needs QA sign-off with linked retraining, gowning assessment and (default on) a successful APS.
  - Not on the access list -> refused; medical exclusion blocks product-contact steps until clearance; declared culture/tissue work blocks entry until a decontamination record exists.
  - Exceptional supervised entry links to every batch in progress in the area and appears in review.
  - Fresh sterile gown set on every Grade A/B entry; garment type checked against grade; expired, unsterilised or damaged packs rejected at scan; RFID cycle count <= qualified maximum; wear timer warns before and alerts at the maximum.
  - A glove or gown breach while product is exposed needs an immediate garment-change entry and an assessment of the units exposed during the breach.
  - Peak headcount above the room maximum -> batch event and deviation.
  - Observations only by aseptic-expert, supervisor or QA roles; findings feed status.
- **Links:** IB-04 (PM), IB-15, IB-16, IB-23 (inspector qualification), IB-28.
- **Implements:** ST-07, ST-08, ST-09, ST-10, ST-11, ST-12, ST-13, ST-30 (operator side), ST-79 (SUS role coverage), PR-15, IN-04, DI-17, DI-21.
- **Sources:** Annex 1 7.1-7.18, 8.19, 9.38-9.39, Table 2 note 3 [C]; FDA-AP V; 21 CFR 211.25, 211.28.

#### IB-04 EM and PM batch window
- **Purpose:** bind all viable, total-particle, DP and T/RH data and personnel monitoring for every room/zone and shift the batch used; evaluate coverage, limits and trends; gate release.
- **Config:** EM plan generated from the approved EM programme version (locations, methods, frequency per activity, timing, volume/area, exposure, limits; critical locations flagged); Grade B continuous viable monitoring default on (risk-configurable); alert levels per location from qualification data for Grade A particles and Grades B-D (no alert tier for Grade A viable); trend rules (each required, parameters configurable): rising excursions, consecutive alerts, recurring isolated actions with a common cause, flora change (first-seen organism, spore-former/mould), recovery rate per location over a rolling window; 5 um recurring low-count window; PM frequency: gloves at least daily or per lot (FDA) plus every Grade B exit for gloves and gown (EU) plus after critical interventions, extra samples for high-intervention operators; anti-masking interval (DESIGN-CHOICE default: glove sanitisation within 5 min before the print needs justification or re-sample); incubation scheme default = FDA example 30-35 C for 48-72 h (bacteria) and 20-25 C for 5-7 days (yeasts/moulds), as validated; validated rapid methods with correlated limits; hazardous-product plan switch.
- **Fields:** plan version; tasks per shift; location, grade, method; sampler device ID and calibration; actual volume; exposure start/stop; media lot, GPT status, neutraliser; sampler identity and qualification; result, unit, limit version (alert/action); organism ID (species for A/B); particle stream reference (>=0.5 um and >=5 um, flow >=28 L/min, counter and probe ID); DP and T/RH trends; alarms with acknowledgement and assessment; PM sample ID, person, sites, trigger, time, last glove sanitisation, result.
- **Enforced:**
  - Tasks for every shift the batch spans; missed or late sample -> deviation.
  - Grade A viable monitoring continuous from start of aseptic set-up to last unit sealed; gaps are exceptions; each settle plate <=4 h (longer: invalid or deviation-gated); C/D plates <=4 h with QRM frequency.
  - Grade A particles continuous at >=0.5 um and >=5 um, >=28 L/min, spanning critical processing including assembly; FDA profile: probe within about 30 cm of the work site in the airflow, data for every shift; missing feed = alarm.
  - Effective limits per E-1/E-2 (stricter of India/EU/FDA for the market set); each result judged individually, no averaged-only view.
  - Any Grade A / ISO 5 recovery -> automatic investigation linked to every batch whose aseptic window overlaps; release blocked until closed with a documented batch-impact disposition (rejection not automatic; signed rationale mandatory).
  - Action excursion in any grade -> links every batch processed in the room/zone from sampling time to reporting time; holds them; root cause, product impact and CAPA.
  - Grade A/B isolates to species; genus-only cannot close an A/B record.
  - End-of-operation surface sampling before line clearance; critical product-contact surfaces (needles, stopper bowl, feed tracks) sampled only after the fill-end event; sampling inside Grade A logged as an inherent intervention.
  - Media lot issuable only with passing GPT (reference organisms and local isolates); a later GPT failure invalidates results -> re-sample or deviation. Isolator EM media introduced only after aeration is recorded complete.
  - PM: after a critical intervention each involved operator gives a glove sample and an outer-glove change must be recorded before that operator's next action (blocked until then); a gown sample requires re-gowning; limits Grade A gloves no growth, Grade B gloves/gown 5 CFU; an alert/action PM result links to every batch the person worked that session; action -> investigation and status change (IB-03); review blocked until every roster member's results are back.
  - Release: certification blocked while any result is outstanding (plates incubating) or an out-of-trend event is open; explicit "EM and trend data reviewed" signature; applies to terminally sterilised batches too; exception only via the short-shelf-life path (IB-27).
- **Links:** IB-02, IB-03, IB-16, IB-29, IB-30.
- **Implements:** ST-18, ST-19, ST-20, ST-21, ST-22, ST-23, ST-24, IN-40(b),(e), IN-42, PR-28, DI-49.
- **Sources:** Annex 1 4.31, 9.1-9.31, Tables 1, 2, 5, 6, 10.9-10.10 [P tables via limit file]; FDA-AP IV.A, V.C, X.A-B, Table 1 [P]; 21 CFR 211.42(c)(10)(iv), 211.113(b), 211.192; Schedule M Part II 4.7-4.10, Tables 1 and 3.

#### IB-05 Utilities, alarms and support-system events
- **Purpose:** attach the quality state of every high-risk utility point used and every alarm/event in the batch window.
- **Config:** high-risk points (default: WFI, pure steam used as direct sterilant, product-contact gases; CCS may add); WFI loop validated ranges (hot storage example: circulation above 70 C) with continuous TOC and conductivity; daily WFI sampling (owned by the water system; eBMR reads); steam test frequencies (site); gas specification (chemical, particulate, microbial, oil, water) and point-of-use sterilising filter <=0.22 um; vent/gas filter register (service life in days/uses/SIP cycles; test at installation, periodically or at end of use, after damage); alarm criticality mapping; data-feed gap alarm (DESIGN-CHOICE default 5 min).
- **Fields:** point of use per step; draw time, quantity, temperature at use; loop TOC/conductivity/temperature at draw; results for outlets/loop used (alert/action status); sanitisation/regeneration events and post-event chemical/micro/endotoxin approvals; WFI tank vent filter status; steam condensate and NCG/dryness/superheat status; gas source (bulk, cylinder, generator) lot/CoA/status, POU filter ID and integrity, POU microbial monitoring status; sterile holding-tank pressure trend; alarms (DP, particles, T/RH, interlock override, simultaneous door opening, leak/backflow, power) with acknowledgement user/time, assessment, deviation link.
- **Enforced:** out-of-range draw values flagged for assessment; after sanitisation/regeneration water use blocked until chemical approval and batches using post-event water blocked from certification until micro and endotoxin approval; water action excursion links every batch that drew from the outlet/loop in the period and blocks release pending investigation; stale or failed steam-quality tests mark the steriliser/SIP cycle "unverified steam" (deviation-gated); gas source not current -> blocked; tubing downstream of the final gas filter sterilised; batch-basis gas filters and product-vessel vent filters integrity-tested as release items; failed vent/gas filter links every batch since the last pass; use past change interval blocked; sterile tank pressure loss -> deviation; critical alarm pauses the step until evaluated; limit-breaching alarm needs a deviation; **any power interruption that could affect quality automatically creates a deviation**; feed gap beyond limit = alarm; release blocked while any alarm in the window is unassessed; alarm log cannot be erased; each water draw records the loop and point of use (India).
- **Links:** IB-08, IB-12, IB-13, IB-29, IB-30.
- **Implements:** ST-06, ST-25, ST-26, ST-27, ST-28, IN-44 (water), IN-46 (gas filter reference), IN-51, DI-49.
- **Sources:** Annex 1 4.16, 5.2, 6.1-6.22 [C]; FDA-AP IV.C-D, XII; 21 CFR 211.46(c), 211.100, 211.192; Schedule M Part II 5.9.

#### IB-06 Component, RTU and sterile-material acceptance
- **Purpose:** only released, fit components enter the batch; sterile and ready-to-use items carry verified sterility evidence.
- **Config:** material-master flags (microbial, bioburden, endotoxin, particulate specifications) for APIs, excipients, WFI as ingredient, containers, closures; item classes RTU/RTS (nested syringes, RTU vials/stoppers, gamma-sterilised assemblies), contract-sterilised, sterile API/excipient, EO-sterilised, irradiated.
- **Fields:** lot, CoA, QC release, flagged results, storage location/condition; RTU: supplier and contract-steriliser approval, date of review of the contractor's validation protocol and report, 211.84(d)(3) CoA-reliability confirmation date, sterilisation certificate (method, dose or cycle, date), expiry, visual identity check; irradiation certificate, processing lot, dose vs validated range; EO justification, cycle record (preconditioning time/temperature/RH; gas concentration, pressure, quantity; exposure time), BI results at every validated location with positive control, aeration start/end/conditions, residual EO and reaction products.
- **Enforced:** lot must be QC-released with every flagged result present and within limits at issue; endotoxin failure -> rejected; quarantined, untested or "micro test before use" lots cannot be staged or consumed; RTU/contract-sterilised items need approved supplier and steriliser, current validation review, current CoA reliability (otherwise full testing), CoA, sterilisation certificate and identity check; aseptically added sterile components must use the registered sterilisation method with linked evidence (missing -> addition blocked); irradiation dose below validated minimum -> lot rejected; EO lots not issuable until every EO element is recorded and the validated minimum aeration has elapsed; UV never offered as a sterilisation method; lot numbers and result references written into the batch.
- **Links:** KB-05, IB-07, IB-09, IB-11, IB-22.
- **Implements:** ST-39, ST-40, ST-49, PR-17, PR-18, IN-24.
- **Sources:** Annex 1 2.1(iv), 2.5, 8.11, 8.71-8.78, 10.2 [C; 8.11 P]; FDA-AP VI; 21 CFR 211.80, 211.84(d)(3),(6), 211.94(d).

#### IB-07 Container and closure preparation
- **Purpose:** deliver clean, sterile, non-pyrogenic containers and closures to Grade A within validated holds.
- **Config:** wash programme ID and water point (final rinse of parenteral containers with WFI-quality water; for stoppers, initial washes with purified water of low endotoxin (or better) and a WFI final rinse); silicone lot (released); validated stopper load configuration (bag count, fill level) and penetration-validated recipe; depyrogenation/sterilisation cycle (IB-08); maximum wash-to-sterilise time and sterile hold per item and pack type (validated; no shipped default); residual moisture limit for lyo stoppers (product-specific); glass-breakage handling (SOP-defined number of neighbouring units removed [R]).
- **Fields:** container/closure code, supplier lot, quantity issued; washer ID/programme; water point and status; rinse pressures/temperatures; filtered compressed air; numbers washed; breakage events; wash-end, drying-end and sterilisation-start times; silicone lot; load configuration; cycle ID; computed use-by; preparation-process revalidation due date.
- **Enforced:** the filler accepts a lot only with a complete preparation record (a stopper load with wash record but no cycle is refused); use-by computed at cycle end and use after it blocked or deviation-gated; preparation revalidation due date checked at line clearance; tunnel/oven excursions quarantine containers by time window (IB-08); TS: containers cleaned by a validated process controlling particles, endotoxin and bioburden.
- **Links:** IB-08, IB-14, IB-17, IB-25.
- **Implements:** ST-41, ST-47 (per-run attachment), IN-46 (component timers).
- **Sources:** Annex 1 8.2, 8.18(i)-(ii), 8.66-8.70 [P]; FDA-AP VI.B.1 [P 3-log]; 21 CFR 211.94(c)-(d).

#### IB-08 Sterilisation, depyrogenation and SIP cycle/load record
- **Purpose:** identify every load and prove each cycle conformed before any item is used; present all contributing cycles at release. Modes: moist heat (porous/hard goods, fluids), SIP, dry-heat oven, depyrogenation tunnel, EO and irradiation (bought-in via IB-06); terminal product loads extend this block (IB-21).
- **Config:** vacuum leak test <=7 days where a vacuum phase or sub-ambient return exists (shorter allowed); air-removal test the same day before porous loads, or an air detector on every cycle; heat-sterilisation revalidation <=12 months for worst-case load patterns (EU) and for every process (India) -> effective <=12 months for all heat processes; tunnel HEPA test <=6 months; control-vs-monitor channel tolerance, come-up/equilibration trend limits, packing-to-sterilisation and sterile-hold limits, post-SIP hold (all validated); SAL target <=10^-6 (locked); BI use per validation.
- **Fields:** unique cycle ID; equipment ID, qualification, PM, open change control flag; sensor calibration; leak and air-removal test status; recipe ID/version; validated load-pattern ID (item types, quantities, positions, min/max); load contents (items/carriers, product, batch); carrier state (to be sterilised / sterilised pending review / released / rejected); packing time; control and independent monitoring probes (IDs, positions); drain temperature; pressure; equilibration and exposure times; min/max exposure temperature; pressure-temperature saturation agreement; F0 (fluids); SIP temperature/pressure/time at each monitored location including condensate drains, manual valve checklist (valve ID, required and actual position, time, user), post-SIP pressure or vent-filter status; dry heat: belt speed/dwell, zone min/max temperatures, time at temperature, DP/airflow profile, chamber overpressure through post-hold, Fh/FD vs validated minimum, exit particles; BI lot, verified population, D-value source, positions, results, positive control; cooling medium and sterility evidence; unload dryness and per-item damage/wet-pack/barrier inspection; outcome and reviewer approval; sterile expiry per item.
- **Enforced:** selectable only when qualified, PM current, no open requalification change, sensors calibrated, leak test <=7 days (vacuum), air-removal test that day (porous) or air detector; a pattern past its 12-month revalidation cannot be selected (India: any heat process); load must match a validated pattern and recipe (items/quantities outside pattern refused); automated comparison of phase durations (longer **or** shorter than validated = deviation even if exposure passed), temperatures, pressures, porous criteria, fluid F0/time-temperature, SIP drain temperatures; exposure counted only after the whole load reached temperature; control-monitor difference beyond tolerance fails review; any failure auto-quarantines the load, items not consumable, investigation opened; a passing BI never clears a failed physical parameter; unload record required before load release; items consumable only when "released sterile" and in hold (process indicators never sufficient alone); manual valve sequence errors blocked; tunnel/oven excursion quarantines containers processed in that window; oven pressure loss on an unwrapped load rejects it; depyrogenation validation reference must show >=3 log10 endotoxin reduction with fully reconciled spiked containers; post-SIP pressure loss invalidates the SIP and blocks product transfer; carrier labels show material, batch and sterilised/not-sterilised status (India); every cycle reviewed and alarms dispositioned before release (IB-30).
- **Links:** IB-05 (steam), IB-07, IB-09, IB-20, IB-21, IB-30, KB-03.
- **Implements:** ST-27 (check), ST-43, ST-44, ST-45, ST-47, ST-48, ST-72, IN-47, PR-28.
- **Sources:** Annex 1 8.34-8.70 [P 8.36, 8.38-8.41, 8.59-8.60, 8.66-8.70]; FDA-AP VI.B.1, IX.C [P 3-log]; 21 CFR 211.63-211.68, 211.113(b); Schedule M Part II 6.3-6.11.

#### IB-09 Sterile item status, transfer into Grade A/B, aseptic assembly and connections
- **Purpose:** only released sterile items enter the aseptic zone; every direct and indirect product-contact item is sterile and traceable; aseptic assembly and connections are controlled.
- **Config:** approved transfer list per area; transfer methods (double-ended steriliser, tunnel, wipe-down disinfection, RTP, bacteria-retentive filter, e-beam or VHP pass-box); product-contact item list per MBR (needles, pumps, manifolds, tubing, filter housings, stopper bowls, guides, hoppers); allowed connection methods; time-based separation rules.
- **Fields:** item ID/type; state history and sterile expiry; packaging integrity at use; transfer method and validated procedure ID; load/tunnel/decontamination cycle ID; disinfection (agent, lot, expiry, contact time, operator); QA exception ID; time in/out; assembly steps (start/end, operators); each connection: method (open in Grade A with B background / post-connection SIP cycle ID / intrinsic sterile connector type and lot); non-sterilisable item's EM location.
- **Enforced:** scanners refuse anything not "released sterile"; operator confirms sterile barrier integrity for each item or rejects it; unlisted item blocked unless a pre-approved QA exception (risk assessment, disinfection, extra monitoring) is linked and shown in review; lower-to-higher grade needs a disinfection record; expired agent rejected; critical-zone items need a valid sterilisation record in hold (disinfection alone refused); non-sterilisable Grade A items get validated disinfection and are added to the surface-EM plan; at fill start every product-contact item resolves to a passed cycle, SIP or irradiation certificate, within hold and intact, otherwise fill start is blocked naming the item; unwrapping, assembly and set-up forced to Grade A with B background (isolator per E-10), aseptic-qualified operators, intervention and EM linkage; open connection outside Grade A blocked; exits logged, time-separation overlap warns.
- **Links:** IB-03, IB-04, IB-08, IB-10, IB-11, IB-16.
- **Implements:** ST-42, ST-45, ST-46, ST-55, PR-28.
- **Sources:** Annex 1 4.10-4.12, 5.5, 8.12-8.14, 8.44-8.49, Table 4 [C; Table 4 P]; FDA-AP IV.E, IX.C, Appendix 1.E; 21 CFR 211.67, 211.113(b).

#### IB-10 Barrier systems: isolator/RABS decontamination, glove integrity, pressure and transfers
- **Purpose:** prove the barrier was intact and decontaminated for the batch and capture events that break separation.
- **Config:** profile (open/closed isolator, open/closed RABS); pressure limits from qualification (FDA typical isolator overpressure about 17.5-50 Pa [P]); glove/sleeve replacement frequency (CCS); glove integrity test floor: start and end of each batch or campaign (more tests for long campaigns; small manual batches: session start and end); enclosure leak-test interval; decontamination validity (validated); RABS sporicidal disinfection frequency; negative-pressure isolator only as a flagged containment configuration.
- **Fields:** per port: glove/sleeve/half-suit ID, install date, replacement due, last integrity result, visual check at each use; enclosure leak test; cleaning record preceding bio-decontamination; bio-decontamination cycle ID, recipe/version, agent lot, parameters vs validated ranges (agent amount/concentration, phase durations), gloves extended with fingers separated, end-of-aeration residual vs limit, chemical-indicator results, pass/fail; "decontaminated, valid until"; continuous overpressure and exit-port overpressure; transfers (RTP alpha/beta, mousehole, transfer isolator, port ID, beta-container sterilisation reference, time, local UDAF cover status); RABS door openings; glove-exposure disinfections; glove-port manipulations (type, port, duration, operator, tools and their sterilisation records).
- **Enforced:** batch start blocked if any port is overdue or failed or the enclosure leak test is overdue; a bio-decontamination is valid only if a completed cleaning record precedes it with no use in between; the aseptic phase cannot open until the cycle passed; aseptic steps after "valid until" blocked; integrity breach (overpressure loss, glove/seam hole, power or valve failure) sets "decontamination required", creates a deviation, and the default disposition of units filled during the suspect period is reject, which QA can overturn only with a documented finding that the enclosure environment stayed uncompromised; a failed glove test after use links every batch/time window since that glove last passed; RABS gloves sterilised before fitting and before each campaign; after background exposure a disinfection entry is required before the next aseptic step; RABS door opening = batch event needing assessment; overdue RABS sporicidal disinfection blocks line start; background classification checked at start (IB-02); isolator EM media only after aeration; fingertip PM for each port used.
- **Links:** IB-02, IB-04, IB-14 (decontaminated-hold timer), IB-16, IB-29.
- **Implements:** ST-74, ST-75, ST-76, ST-37 item 3.
- **Sources:** Annex 1 4.3, 4.18-4.22, 8.18(iii) [C]; FDA-AP Appendix 1 [P pressure range]; 21 CFR 211.113(b).

#### IB-11 Single-use and closed-system verification
- **Purpose:** verify each SUS/closed assembly from receipt to installation and use.
- **Config:** approved part numbers and BOM revision per step; pre-use system integrity test (e.g. pressure decay) where the CCS requires; validated maximum contact time; freeze/thaw qualification; location grade.
- **Fields:** part number, BOM revision, supplier approval and sterility-assurance verification, lot/serial, sterilisation proof (irradiation certificate, dose, indicator), certificate of conformance, receipt and pre-use checks (outer packaging, pouch, labels, opening method), post-installation visual (holes, kinks, clamp positions), E&L/adsorption status per product x part, each connection (intrinsic sterile connector type/lot, weld inspection, SIP after connection, open aseptic in Grade A), integrity results, "system opened" events.
- **Enforced:** unverified lots stay quarantined; part mismatch refused; every product-contact element of an aseptic closed system resolves to a sterilisation record or supplier sterility proof (no N/A); any connection made into the sterile path downstream of the final filter is designed to use an intrinsic sterile connector; outside Grade A an integrity result is required at every use; a "system opened" event forces opening in Grade A (aseptic) or Grade C (terminal) or extra cleaning/disinfection/sterilisation; unassessed E&L part blocked; contact time enforced; SUS assembly/connection operators need APS coverage (IB-03); integrated filters follow IB-13.
- **Links:** IB-03, IB-06, IB-09, IB-13.
- **Implements:** ST-79, ST-08 (SUS roles), PR-17.
- **Sources:** Annex 1 8.127-8.139, Table 4 [C]; 21 CFR 211.65, 211.67.

#### IB-12 Compounding (filterable solution; aseptic non-filterable variant)
- **Purpose:** prepare a homogeneous bulk at correct concentration, pH, density and osmolality with controlled oxygen, bioburden and endotoxin; start the product clocks.
- **Config:** T0 definition (e.g. first WFI or first component into vessel); WFI temperature at addition; order and rate of additions; mixing speed/time/temperature; inert-gas sparge/overlay (flow, time, dissolved-oxygen limit where relevant); pH target/limits, adjusting agents, maximum cumulative adjusting volume, maximum loop iterations; q.s. basis (weight via measured density at a stated temperature, or volume); bulk IPC set and limits (pH, density, osmolality, assay, clarity/appearance; from registration or company, research examples such as 98.0-102.0% assay or 270-330 mOsm/kg are illustrative [R] and not shipped); bulk endotoxin (risk-based or per CCS); hold conditions. V-7: homogeniser parameters (pressure, passes, temperature, time), particle-size or globule-size limits (USP <729>: MDD <500 nm, PFAT5 <=0.05% [R]), agitation during hold and filling, homogeneity samples at start/middle/end of fill.
- **Fields:** vessel ID with clean/sterile status and expiry, agitator, load cell; T0; each addition (order, material, lot, quantity, time, performer, verifier); dissolution/clarity checks; gas source, POU filter ID, flow/pressure, start/end, DO readings; pH meter ID/calibration, each reading, adjusting agent lot and volume; q.s. target and actual net weight, temperature at q.s.; density (densitometer ID, temperature); osmolality (osmometer ID); bulk sample IDs/times; hold start/end, temperature, blanket, light protection; bulk yield; room and grade.
- **Enforced:** WFI point of use released (no active excursion) at draw; additions in master order with second-person verification (out of order -> deviation); every pH iteration retained, exceeding maximum adjusting volume or iterations -> exception/deviation; final quantity computed by the engine from measured density (C-04); T0 starts the chained timers (IB-14); gas steps reference a sterilising gas filter; V-7: every addition sterile with evidence, performed in Grade A/B by aseptic-qualified operators, homogeniser excursions -> deviation, formulation-stage simulation status current (IB-15); bulk IPC failure -> hold, corrections only by approved procedure with QU approval; LVP water/intermediate endotoxin step mandatory.
- **Links:** KB-04, KB-05, KB-06, KB-09, KB-14, IB-05, IB-14, IB-15, IB-26.
- **Implements:** PR-21, PR-29, IN-41, IN-46, ST-37 (T0), ST-40 (V-7), ST-60 (grade floors).
- **Sources:** Annex 1 6.18-6.19, 8.1, 8.11, 8.18(iv), Table 4 [P 8.1, 8.11, 8.18]; 21 CFR 211.101, 211.110(a)(5)-(6) [P], 211.111 [P]; FDA-AP VIII; USP <785>, <791>, <729> [R].

#### IB-13 Sterilising filtration and filter integrity
- **Purpose:** render the bulk sterile through a validated filter train and prove integrity before and after use; control vent and gas filters.
- **Config:**
  - Train master data: each position's role (bioburden-reduction prefilter / primary sterilising / redundant sterilising near point of fill / serial-validated member / critical gas or vent / non-critical vent / lyophiliser integrity filter); redundant filter is a CCS decision.
  - Registered/validated part numbers per product; final filter <=0.22 um nominal.
  - Validated envelope per product x filter (master data, not editable at execution): integrity-test wetting fluid and product-specific limit correlated to bacterial retention (challenge >=10^7 CFU/cm2, typically B. diminuta), pre-filtration hold and bioburden effect, conditioning, maximum filtration and contact time, maximum pressure, flow range, maximum volume, temperature, time to filter a known volume and DP.
  - Pre-use testing: **EU in set: PUPSIT ENFORCED** unless an approved waiver risk assessment exists (filter-sterilisation control, supply chain incl. contract steriliser/transport/protective packaging, product knowledge such as particle load masking a non-integral filter); **India always: a pre-use integrity test is always required** (post-sterilisation timing required when EU is in the set); retest decision tree with pre-defined maximum repeats (PDA TR26 2025 [R]); every attempt kept.
  - Use limits: one batch (EU) and continuous use <=1 working day unless validated (India and EU); multi-lot reuse only on a line with no EU product and only with validation stating the maximum lots (FDA), still within the one-working-day rule unless extended use is validated; prefilter accumulated-use maximum.
  - Vent/gas filters: critical ones post-use tested in housing per batch (release item); non-critical at intervals, at installation and before replacement; maximum duration/uses/SIP cycles.
- **Fields:** train configuration ID; each filter's manufacturer, part number, lot, serial, pore rating, area, role, 211.72 attributes (non-fibre-releasing, asbestos-free); housing/capsule ID; sterilisation evidence (autoclave/SIP cycle or supplier irradiation certificate); wetting fluid, flush volume and disposal; bioburden sample ID/time; each integrity test (type: bubble point / diffusive flow / pressure hold / water intrusion; test gas, pressure, temperature, stabilisation time, measured value, limit pulled from master data, result, attempt number, tester ID and calibration, raw file with hash); filtration start/end including pauses, volume, flow, upstream/downstream pressure and DP, temperature, time per known volume (from instrument data), total contact time; receiving vessel/bag ID and status; vent/gas filter results; disposal confirmation; waiver ID.
- **Enforced:** installed part must equal the registered/validated part (same polymer and rating is not enough) and be within sterile hold; bioburden sample precedes filtration start (before first filter if redundant; later = sequence violation); PUPSIT/pre-use test between filter sterilisation and product filtration unless a waiver applies (waiver ID shown in record and QP review); post-use test mandatory before removal is recorded (removal first refused); limit never typed; failed/invalid test -> deviation, batch hold, certification block; serial-validated train: every filter must pass post-use; redundant train: primary tested, on primary failure the backup test step appears automatically with an investigation and risk assessment, both shown at QP review; CPPs outside the envelope -> automatic deviation, significant differences investigated, and the record holds at least time for a known volume and DP; filter serial bound to one batch, beyond one working day blocked unless validated; a defective/contaminated flag retires the filter permanently; critical gas/vent results are release items and a failure links every batch since the last pass; filtration refused as the only sterilisation method for a product flagged terminally sterilisable; TS: microorganism-retaining filtration where possible with filter ID and maximum time to filling.
- **Links:** IB-05, IB-08, IB-11, IB-14, IB-26, IB-29, IB-30, KB-03.
- **Implements:** ST-28 (vent/gas), ST-50, ST-51, ST-52, ST-53, ST-54 (sequence), ST-60 (TS filter), IN-48, B-17.
- **Sources:** Annex 1 6.19, 8.79-8.95 [P 8.85-8.87, 8.93-8.95], glossary [P]; FDA-AP VIII, IX.B; 21 CFR 211.72 [P], 211.113(b); Schedule M Part II 6.11.2; PDA TR26 (2025) [R].

#### IB-14 Sterile time-limit rule set
- **Purpose:** the mandatory, event-driven set of validated maxima for sterile manufacture (built on KB-10).
- **Config:** per rule: start event, end event, maximum (minimum where relevant), warning threshold, pause handling, validation/hold-study reference, storage condition. **No numeric defaults are shipped** (neither text sets values; research values are illustrative [R]); exceptions with fixed floors are in E-7.
- **Mandatory set (items 1-12: aseptic route; item 13: terminal route, which also uses items 1-2 wherever equipment/components are sterilised):** (1) cleaning -> drying -> sterilisation of equipment, components, containers (dirty/clean hold); (2) sterilised equipment, components and containers from cycle end to last use, including during filling/assembly; (3) RABS/isolator hold from completion of bio-decontamination until aseptic work begins; (4) T0 (preparation start) -> start of sterilising filtration or product sterilisation; (5) T0 -> end of aseptic filling (product-specific, reflecting composition and storage); (6) filtered/sterilised product hold before filling; (7) total filtration time including pauses; (8) total aseptic processing time; (9) filling time; (10) line exposure of product, from the first container opened to the last unit closed; (11) lyo: filling -> lyophiliser loading, and exposure of partially stoppered units; (12) stopper -> crimp; (13) terminal: preparation -> sterilisation (and preparation -> filling).
- **Additional rules (used where applicable):** packing -> sterilisation and sterile shelf life of packed items; post-SIP hold; lyophiliser sterilisation -> load (<= APS-challenged); hold of every intermediate (India); gown wear time (IB-03); settle-plate exposure (IB-04); filter use duration (IB-13); disinfectant in-use expiry (IB-02); EO minimum aeration (IB-06); APS fill-end -> incubation start (IB-28); clean-up period (IB-02); cumulative time out of refrigeration per unit/tray/lot (product stability budget; no pharmacopoeial value exists).
- **Enforced:** MBR approval refused if a mandatory rule for the route is missing or lacks a validation reference; timers start/stop from recorded events and warn before the limit; a breach blocks the step and every downstream step until a justified deviation carries a QA decision (under 211.111 an overrun is acceptable only when product quality is shown to be unaffected and the departure is justified and documented); every limit is also checked against the longest duration qualified by APS (IB-15), and exceeding it raises a deviation for QA; storage conditions during holds attached; time-limit compliance summary in the review dossier.
- **Links:** KB-10, IB-15, IB-30.
- **Implements:** ST-37, ST-38 (holds), ST-41 (use-by), ST-57 (stopper-to-crimp), ST-59 (partial-stopper exposure), ST-60 (prep -> sterilisation), IN-13, IN-15, IN-46, B-06, PR-30.
- **Sources:** Annex 1 8.5, 8.18(i)-(vii), 8.36, 8.46, 8.48, 8.63, 8.85, 8.122 [P 8.5, 8.18, 8.36, 8.85, 8.122]; FDA-AP VIII; 21 CFR 211.111 [P]; Schedule M Part I 17.3.6, 17.3.8, Part II 5.12-5.16.

#### IB-15 APS status and qualified-envelope engine
- **Purpose:** know at any moment whether a line/process/shift/format and each operator is covered by a valid APS and what worst case it qualified; gate batches; apply failure consequences.
- **Config:** status granularity: aseptic process x filling line x shift x container/closure configuration; formulation/bulk aseptic stage separately; per operator per configuration for manual aseptic; periodic interval default and maximum 6 months after last successful APS (grace period: none by default, see G.4); inactivity trigger (site parameter; no number in either text); formulation-stage simulation at least twice a year; acceptance profile per line: **EU (mandatory when any EU/PIC/S product is qualified on the line)** or non-EU tiered (India +/- US), see E-6.
- **Fields:** APS ID, line, process, shifts, container/closure bracket or matrix, date, result; initial-validation counter; revalidation due; **envelope derived from successful APS records, never typed**: maximum duration, line-speed range, maximum holds of exposed product and equipment, maximum headcount and operator time in cleanroom, interventions with maximum counts/durations, idle interruptions, campaign length, lyo SIP -> use, filtration -> lyo, trays and loading duration, gas used; participants and roles; linked change controls; last production date.
- **Enforced:**
  - Status "initial validation incomplete" until >=3 consecutive successful APS covering every shift the process runs in.
  - Batch creation and aseptic fill start blocked unless the line/shift/format status is current and passing and every sterilisation process used is validated and not suspended; the status seen is stored.
  - Back to initial validation or "requalification pending" on: an approved change flagged as affecting sterility assurance (for example HVAC, equipment or process changes, a change in shift pattern or staffing, a major shutdown), inactivity beyond the configured period, a new container or container-closure combination; FDA triggers flagged "media-fill assessment required" (significant staffing change, EM anomaly, extended shutdown, finished-product sterility positive) may be lifted by a documented QA risk decision except where the change affects the aseptic process on an EU line (APS required).
  - Envelope checks: container size not covered -> batch creation blocked; batch larger than an APS of under 5,000 units -> blocked; longer duration, higher peak headcount, more intervention occurrences than demonstrated, line speed out of range, longer lyo loading or longer holds -> deviation for QA before release.
  - EU failure consequences: line "production suspended"; quarantine of everything made after the failed APS; list of batches since the last successful APS with prompt record review and per-batch sterility-breach risk assessment (unreleased batches in scope with release blocked; released batches flagged for a market-impact decision); root-cause investigation, CAPA, species ID; normally >=3 consecutive successful repeat APS before status returns; implicated operators restricted (IB-03).
  - Non-EU line: tiered outcomes (E-6), every positive investigated, intermittent/recurring positives escalate to revalidation, confirmatory runs (one or more after corrections, three consecutive when root cause is not conclusive), impact on batches since the last pass always assessed.
  - Manual aseptic: operator cannot sign a combination not currently qualified.
  - DESIGN-CHOICE: prompt for an APS after the last batch before shutdown, long inactivity, decommissioning or relocation.
- **Links:** IB-03, IB-14, IB-16, IB-28, IB-29, KB-01.
- **Implements:** ST-29, ST-30, ST-31 (envelope), ST-33, IN-45, B-10, B-11, PR-28.
- **Sources:** Annex 1 9.32-9.49 [C]; FDA-AP IX.A, Appendix 3.A [C]; 21 CFR 211.113(b); Schedule M Part II 5.3-5.7.

#### IB-16 Intervention catalogue and intervention/stoppage log
- **Purpose:** every intervention and stoppage recorded in a structured way, tied to APS qualification, EM, sampling, accountability and disposition.
- **Config:** per-line catalogue (QA-approved, change-controlled): ID, description; type inherent/corrective and criticality (enters the critical zone) as independent attributes; procedure reference; qualifying APS (ID, date); maximum count and duration demonstrated in APS; frequency class common/rare with simulation interval; airflow-visualisation (smoke) study reference; number and positions of units to remove; required clearance (none/local/full) and the duration/exposure beyond which clearance becomes mandatory; post-intervention actions (glove print + glove change, extra sterility sample); BFS flags "stops extrusion/filling" or "requires re-sterilisation".
- **Fields:** start and end (duration computed, never typed); catalogue ID or "unqualified"; type; zone/filling position; operators; units removed (count, positions); clearance record; tools/parts with sterilisation records; for corrective/major interventions what failed and what was adjusted/replaced; PLC/SCADA stop reference; triggered sample IDs; QA authorisation; deviation ID; box/tray number.
- **Enforced:** only entries qualified in a valid APS for the line are selectable; an entry without a smoke-study reference is flagged unqualified; an unqualified intervention needs a real-time QA e-authorisation before the operator continues, auto-creates a deviation, flags affected units and window, and creates a QA disposition item that blocks certification; operators' qualification and APS coverage of the intervention checked; units removed must equal the catalogue number (a different number in production = deviation; APS never removes more than production); clearance required or maximum duration exceeded -> restart blocked until a clearance record (scope, units and positions removed, reconciliation) exists; removed units excluded from good output and counted; PLC/SCADA stops create entries automatically and unmatched stops are flagged (operators and reason required before review); post-intervention actions triggered (glove sample then outer-glove change blocking the operator's next action; extra sterility sample per risk rule; India: after a significant interruption a sterility pull after restart is mandatory); more occurrences than demonstrated in APS, or a rare intervention not simulated within its interval -> deviation for QA; a manual weight check inside ISO 5 is logged as an intervention; BFS re-sterilisation entries force a passing SIP before resumption; all events shown on the batch timeline with particle and EM data. DESIGN-CHOICE: master-record review prefers engineering alternatives (in-line weighing, SIP, automation).
- **Links:** IB-03, IB-04, IB-10, IB-15, IB-25, IB-26, IB-30.
- **Implements:** ST-34, ST-35, ST-36, ST-22 (trigger), ST-66 (trigger), ST-77 (BFS interventions), IN-49 (post-interruption pull), IN-45(a).
- **Sources:** Annex 1 8.16-8.17, 9.25, 9.34, 9.41, glossary [C]; FDA-AP IV.E, IX.A.3, XII; 21 CFR 211.100, 211.188(b); Schedule M Part II 2.1-2.3.

#### IB-17 Aseptic line set-up, filling and primary closure
- **Purpose:** fill the dose into sterile containers and close them in Grade A (vial stoppering, ampoule fusion sealing, PFS/cartridge plunger placement), capturing everything needed to demonstrate asepsis.
- **Config:** container format and format-part IDs; filling system (piston, peristaltic, time-pressure) and number of needles; line-speed set point and range (must lie within the APS envelope); set-up units to discard; closure type and parameters: full stopper (V-1), partial stopper (V-4), fusion seal (V-2: gas/oxygen flows, flame settings, station speed; seal-appearance checks for tips, bubbles, charring), plunger placement (V-3: vacuum level or vent-tube insertion depth; position limits; bubble size); inert-gas overlay (filter ID, flow); headspace oxygen method (e.g. non-destructive laser), product-specific limit and frequency; restart rules after stoppages; validated open-container routing map.
- **Fields:** filling start/end; line speed set point/actual; machine counters (containers in, filled, rejected by reason); stopper presence/seating, seal-parameter and plunger-position results; headspace O2 results; stoppages (start/end, cause); end-of-fill residual bulk and line losses; tub/nest IDs traced from RTU acceptance (V-3); authorisation to start.
- **Enforced:** open primary containers only through Grade A zones from depyrogenation/sterilisation exit to closure (partially stoppered units follow IB-20 transfer rules); fill start gated by IB-15, IB-09 (every product-contact item sterile and in hold), IB-10, IB-02 and IB-04 coverage from set-up; closure step records the validated closing method, equipment and key settings; stopper/plunger presence and position detected 100% automatically, defective units auto-rejected and counted, a manual fix is a corrective intervention; fusion-seal parameter excursion segregates the affected window and an ampoule batch cannot be dispositioned without 100% CCI results (IB-24); plunger-placement excursions identify affected tubs; headspace O2 out of limit holds units since the last passing check (deviation at action limit); filling, aseptic-processing and exposure clocks run (IB-14); line speed outside the APS range -> deviation.
- **Links:** IB-04, IB-09, IB-14, IB-15, IB-16, IB-18, IB-24, IB-25, IB-26.
- **Implements:** ST-31 (speed), ST-55, ST-56 (closure checks), ST-64 (seal parameters), PR-29.
- **Sources:** Annex 1 8.20-8.22, 8.28, Table 4 [P]; FDA-AP IV.E; 21 CFR 211.110(a) [P], 211.113(b).

#### IB-18 Fill weight/volume and device functional IPC
- **Purpose:** dose accuracy per needle, and functional checks for syringe/cartridge/autoinjector presentations.
- **Config:** target basis (net weight via density, or volume); labelled volume and excess volume (USP <1151> table loaded as pharmacopoeial master data [R], or the registered value); individual and mean limits with alert (a%) and action (b%), a < b (company-defined; research +/-1-2% is illustrative [R], not shipped); schedule: all needles at start, then per needle at an MBR-defined interval (research practice 15-30 min is illustrative [R]; no regulatory default), after every adjustment, intervention or stoppage, and at end; or 100% in-line checkweighing (preferred design, reduces interventions); adjustment roles; first-units discard; device IPCs (delivery volume, break-loose/glide force, activation, plunger-rod/backstop/safety-device assembly checks) with sampling plan.
- **Fields:** time, needle/pump, gross, tare, net, calculated volume via density, balance or checkweigher ID and calibration, operator; adjustments (before/after, user, time); device IPC results; device-component genealogy (plunger rods, sub-assemblies).
- **Enforced:** weights captured from the balance/checkweigher interface (manual entry flagged and verified); a missed IPC is flagged; out-of-limit -> deviation and 211.192 investigation, units since the last passing check for that needle segregated, out-of-limit units rejected and counted; a manual weight check inside ISO 5 is also an intervention with duration (IB-16); balance calibration current at point of use; target computed by the engine (C-05) and individual units must deliver at least the labelled volume (USP <697> as master data [R]); device IPC failure -> hold; device genealogy mandatory. 21 CFR Part 4 cross-references for combination products are not verified (G.4).
- **Links:** KB-04, KB-09, IB-16, IB-17, IB-25, KB-17.
- **Implements:** ST-05, ST-56, PR-08, PR-29.
- **Sources:** 21 CFR 211.110(a) [P], 211.68; Annex 1 8.101, 8.115 (fill volume as CPP for FFS/BFS) [C]; FDA-AP IV.E, VI.B.2; USP <697>, <1151> [R]; 21 CFR Part 4 [R, unverified].

#### IB-19 Capping and crimping
- **Purpose:** keep stoppered vials protected until crimped and remove units with missing or displaced stoppers before capping.
- **Config:** capping mode per line: aseptic (sterilised caps) / clean process outside the aseptic core under Grade A air supply / manual only in an isolator or Grade A with Grade B background; zone types "Grade A zone" vs "Grade A air supply" (background >= Grade D); stopper-height detector qualification reference and challenge schedule (batch start mandatory, then periodic; research adds end of run [R]); crimp settings (force/pressure, head height); crimp quality checks (visual, rotation/torque or residual seal force) with company-defined limits and frequency; maximum stopper-to-crimp time (validated); cap type, colour and top-surface text.
- **Fields:** capper ID and mode; station ID (separate station with extraction is a station master attribute, India); cap lot and sterilisation evidence (aseptic mode); Grade A air-supply status; detector challenge results; rejects (missing/displaced stopper, crimp); crimp checks; interventions at the capper; counts in/capped/rejected; cap verification (type, colour, cautionary text per USP <7> [R]).
- **Enforced:** clean-process capping cannot start without a passed challenge of the qualified automated stopper-height detection (failed challenge stops the step; units since the last good challenge re-challenged or re-inspected); missing/displaced-stopper vials rejected before capping, counted, never back into the good stream; loss of Grade A air supply raises a batch event for vials in that window; air-supply zones need no continuous particle counting or Grade A viable limits but status is recorded; stopper-to-crimp time exceeded or loss of local protection -> deviation; manual capping only in Grade A locations and interventions avoid direct vial contact; crimp-check failure holds output since the last passing check and triggers a CCI assessment; wrong cap stops and segregates.
- **Links:** IB-02, IB-14, IB-16, IB-24, IB-25.
- **Implements:** ST-57, IN-50(a), PR-29.
- **Sources:** Annex 1 8.26-8.29, glossary (Grade A air supply) [P 8.26-8.29]; FDA-AP IV.E; 21 CFR 211.94; Schedule M Part II 10.3-10.5.

#### IB-20 Lyophilisation (readiness, transfer/loading, cycle, stoppering, unloading)
- **Purpose:** treat the lyo chain as an extension of aseptic processing and record its integrity, loading and cycle evidence.
- **Config:** loading mode (manual-open / automated / closed-barrier) and CCS sterilisation-frequency reference; maximum permitted leak rate (equipment-specific) and documented chamber leak-test frequency; validated recipe ID/version per product/fill; transfer devices (conveyor, qualified clean-air cart, portable UDAF, validated closed trays/boxes); tray inspection interval; loading pattern; end-of-primary-drying method (pressure rise or Pirani/capacitance-manometer comparison); backfill gas and stoppering pressure/force; maximum fill -> loading and loading duration (must not exceed APS-challenged values).
- **Fields:** lyophiliser ID; last SIP cycle ID, end time, result; hold until loading vs longest APS-challenged interval; maintenance/cleaning since SIP; integrity/vent filter ID, sterilisation record, integrity result; start-of-cycle leak rate; tray/ring IDs, sterilisation IDs, inspection status; transfer device ID, qualification and Grade A status in transit; first tray out of filler, last tray loaded, chamber closure; shelf map (tray IDs, vial counts, product-probe positions); sterile utensil IDs; recipe; per-phase set points and actuals (shelf temperature, chamber pressure, condenser temperature), product temperatures, pressure-rise tests, phase durations; alarms (vacuum loss, refrigeration, power) with acknowledgement and assessment; backfill gas and stoppering pressure/force; unloading start/end; stopper-seating check; counts loaded / unloaded / broken or fallen with shelf position.
- **Enforced:** manual-open lyophilisers need a new successful sterilisation between every unload and the next load (hard block, applicable from 25 Aug 2024); automated/closed-barrier units follow the CCS-justified frequency with the reference displayed; loading only with a passing SIP no older than the longest APS-challenged interval and no maintenance/cleaning since, otherwise re-sterilise; leak rate at the start of every cycle at or below the specified maximum (failure blocks cycle and release); integrity/vent filter sterilised before each use and its integrity result on the certification checklist; overdue or misshapen/damaged trays refused; transfer only under Grade A (or validated closed trays closed in A and not opened in B), unqualified cart blocked, transit alarm flags trays; transfer, loading, cycle and unloading inherit aseptic rules (Grade A checks, aseptic-qualified operators, intervention logging, EM window extended to end of unloading/sealing); partial-stopper exposure timer from first tray out of the filler to chamber closure (IB-14); downloaded recipe = validated recipe and controller edits raise exceptions; cycle values compared with the validated (filed) cycle, excursions -> deviations and critical alarms block disposition until assessed; stoppers not fully seated before chamber opening -> units stay under Grade A until capped; loading beyond the APS envelope (trays, duration, filtration -> lyo, SIP -> use) flagged; sterility samples from each lyo load (IB-26).
- **Links:** IB-04, IB-08, IB-14, IB-15, IB-16, IB-25, IB-26, KB-03.
- **Implements:** ST-37 item 11, ST-58, ST-59, ST-66 (per lyo load), PR-28.
- **Sources:** Annex 1 8.121-8.126 [P 8.122-8.126], 9.33 [C]; FDA-AP IV.D.1, IV.E; FDA lyophilisation inspection guide (1993) for cycle-record detail [R, unverified].

#### IB-21 Terminal sterilisation of filled units (loads as sub-batches; parametric release)
- **Purpose:** map filled units to steriliser loads and prove each load reached the validated lethality without damaging containers; optional parametric release.
- **Config:** grade floors via IB-01 risk flags; validated cycle and load pattern per product/container with min/max load (single product lot and container size per load: DESIGN-CHOICE default following USP <1229.2> [R]); routine probe positions (fixed master data correlated to the worst case from load mapping); F0 convention (T_ref 121.0 C or 121.1 C, z = 10 C; stored with every value); validated minimum F0 at the slowest-heating position and maximum F0 (product degradation); exposure temperature band; pressure/air-overpressure limits; heating/cooling rates; superheated-water/spray pre-cycle checklist; parametric-release flag (requires an authorisation reference on the product master); post-aseptic heat-treatment mode (V-9).
- **Fields:** load (sub-batch) ID, units per load, pattern ID, container type; preparation -> filling -> sterilisation times; pre-sterilisation bioburden (worst-case, end of hold, before loading) and result; steriliser and cycle ID; probe traces; F0 per position (min/max); equilibration and exposure; pressure/overpressure; cooling-water sterility evidence; nozzle/drain checklist; chemical/biological indicator or load-monitor results (parametric release); unloading deformation/leak inspection; counts in/out/leakers/damaged; sterility samples from coolest positions of each load.
- **Enforced:** preparation >= Grade D (>= C with risk flags/semi-solids), filling >= Grade C (Grade A with >= C background with unusual-risk flags); preparation -> sterilisation and preparation -> filling timers from validated maxima (IB-14); each load is a sub-batch linked by load/tray/pallet; units from a failed or deviating load cannot be released and are segregated by load; spray or superheated-water autoclave cannot start without the nozzle/drain checklist; non-rigid containers get a post-cycle deformation and leak inspection with rejects to accountability; every load tested for sterility separately unless parametric release is authorised; parametric release only with an authorisation reference and a gate requiring complete in-limit critical parameters (time, temperature, pressure, F0) at every monitoring position, chemical indicator results (FDA recommends Class 5 [C, secondary]), per-batch filled-unit bioburden from worst-case positions with organism ID and resistance assessment, endotoxin where appropriate; any failure makes parametric release impossible and fallback to a sterility test is allowed only if the authorisation permits; without authorisation the per-batch sterility test applies (211.167(a)); SAL <=10^-6 master data; "overkill" means >=12 log10 reduction with D >= 1 min and permits scheduled-interval bioburden with justification; F0 minimum below 8 min under the terminal route triggers the IB-01 route review.
- **Links:** IB-08, IB-14, IB-25, IB-26, IB-27, IB-30, KB-16.
- **Implements:** ST-54 (TS sampling point), ST-60, ST-61, ST-66 (per load), IN-46, IN-47, IN-49.
- **Sources:** Annex 1 8.1-8.5, 8.34-8.54, 8.59, 8.62, 8.64-8.65, 10.3-10.6, glossary [P 8.1-8.5, 8.36, 8.38-8.41, 8.59, 10.3-10.6, glossary]; 21 CFR 211.113(b), 211.167(a); FDA parametric-release submission guidance (2010) and CPG [R; CPG number conflicts, G.3]; EU Annex 17 [R, not in inputs]; Ph. Eur. 5.1.1, 5.1.5; USP <1229.2>, <1222> [R].

#### IB-22 BFS/FFS form-fill-seal record
- **Purpose:** capture the continuous forming, filling and sealing parameters and integrity controls of BFS and FFS machines.
- **Config:** machine type (BFS shuttle or rotary; FFS single or dual web); route (aseptic/terminal) -> environment rules; CPP limits; campaign duration; FFS batch-specific seal strength/uniformity test; BFS wall thickness and container weight IPCs; parison/support air and product gas filter IDs; tooling inspection interval; reject-rate thresholds for investigation.
- **Fields:** polymer granulate or film roll lots with release (bioburden/endotoxin where specified; supplier qualified); CIP/SIP cycle IDs for product path and mandrels; BFS: extrusion temperature, speed, throat settings, melt temperature and residence time, mould temperatures and cooling rate; FFS: forming temperatures (pre-heat, cooling), times, pressures, sealing temperature and uniformity, sealing time and pressure, package dimensions and cutting; environmental and product temperature; fill volume, speed, uniformity; print/emboss settings; flash-removal cutter settings; set-point changes (user, time, justification); alarms; wall thickness, container weight, fill weight, leak checks, process air pressure; 100% CCI counts and known-defect challenge; rejects by reason (blowing, forming, sealing, cutting); viable EM coverage; interventions.
- **Enforced:** CCI per ST-64: 100% for BFS units and for FFS fusion-sealed units <=100 mL (FFS >100 mL: reduced sampling only with justification); terminal BFS machine >= Grade D; aseptic shuttle: Grade A at parison extrusion, blow-moulding and sealing zones plus Grade A filling environment; aseptic rotary: Grade A inside the parison; aseptic BFS machine background >= Grade C with operators in Grade A/B garments (a Grade C gowning record is refused); FFS environment per route; critical-zone in-operation particle monitoring not expected (design-data reference required instead); viable monitoring from assembly to end of filling with samples spread across the run (gaps flagged); start checks: PM current, machine-utility integrity (e.g. mould-cooling leak check) current, seal-critical tooling inspected, mould change/modification blocked until its CCI assessment is closed, polymer/film lot released (film roll with a pending result blocked), air-filter integrity current, product-path SIP within the validated recipe; CPP excursion segregates units made in the window and raises a deviation; interventions flagged "stops extrusion/filling" or "requires re-sterilisation" force a passing SIP before resumption; 100% CCI run with known-defect challenge verification; rejects by reason into accountability; significant forming/sealing defect -> 211.192 investigation; FFS batch-specific seal strength and uniformity tests mandatory before batch close; out-of-range set-point change needs justification; added components (e.g. LVP caps) in the aseptic case pre-sterilised and added in Grade A with validated sealing tests; campaign-duration timer runs.
- **Links:** IB-04, IB-06, IB-08, IB-16, IB-24, IB-25.
- **Implements:** ST-64, ST-77, ST-78.
- **Sources:** Annex 1 8.22 [P], 8.96-8.120 [C]; FDA-AP Appendix 2; 21 CFR 211.100, 211.192.

#### IB-23 100% visual inspection and acceptance sampling
- **Purpose:** individual inspection of every filled unit, defect classification and trending, acceptance sampling of accepted units, controlled reinspection.
- **Config:** mode per product/container (manual, semi-automated, automated); defect library (codes; criticality critical/major/minor; particle type fibre/glass/metal; integrity defects such as cracks and missing/loose stoppers; fill level; cake defects; cosmetic); per-defect alert/action limits from historical data using statistical principles; inspector qualification <=12 months using defect-library sets under worst-case conditions (inspection time, conveyor speed, container size, fatigue) wearing usual corrective lenses, plus an eyesight check (India: periodic eye check, interval configured, default 12 months); maximum continuous inspection time before a break (configurable; research cites at least hourly breaks [R]); inspection rate; illumination and background (USP <790>/Ph. Eur. 2.9.20: 2,000-3,750 lux for clear glass, black and white backgrounds [R]); AVI recipe and validation reference; challenge-set IDs and schedule (before start-up and at defined intervals; research adds end [R]); acceptance-sampling plan (default master data: ANSI/ASQ Z1.4 general inspection level II, normal, single sampling; visible particulates AQL 0.65% per USP <790>; class ranges critical 0.010-0.10%, major 0.10-0.65%, minor 1.0-4.0% per USP <1790> — all [R]; customer QA sets the plan); supplemental destructive inspection for limited-visibility products (lyo cake, amber, suspensions) [R]; reinspection procedure.
- **Fields:** mode; booth/machine ID; AVI recipe/version; inspector IDs with qualification and eye-check validity; illumination/background check; start/stop and breaks; rate; units presented, accepted, rejected by defect code and criticality; per-inspector counts; challenge results; acceptance sample: lot size, code letter, sample size, accept/reject numbers per class, defects found, inspector; reinspection counts (separate); reject rates vs limits.
- **Enforced:** the 100% inspection step cannot be removed from any injectable MBR; manual sign-on refused when VI qualification is older than 12 months or the eyesight check has lapsed; enforced breaks; illumination/background check recorded; AVI must run the validated recipe, pass the challenge at start-up and at defined intervals, and a failed interim challenge puts every unit since the last passing challenge on hold for reinspection (recipe change mid-run is an exception); reconciliation presented = accepted + rejected by code + samples + destroyed within limits (IB-25); reject rate for any defect code above its alert or action limit -> investigation and release block; any critical defect found in accepted units (acceptance sample or later) -> automatic investigation, release block and re-inspection decision (reinspection only under SOP with deviation, counts separate, KB-18); OOS inspection result -> 211.192 investigation including other batches; defect counts per code per batch stored for SPC and an adverse trend opens an investigation with a mandatory market-impact assessment; every unit with visible particulates rejected (USP <1> [R]).
- **Links:** IB-03, IB-24, IB-25, IB-29, IB-30, KB-18.
- **Implements:** ST-62, ST-63, IN-50(c)-(e), B-19.
- **Sources:** Annex 1 8.30-8.33 [P]; FDA-AP VI.B.2; 21 CFR 211.192; Schedule M Part II 10.7-10.8, Part I 11.5.1; USP <1>, <790>, <1790>; Ph. Eur. 2.9.20 [R]; FDA draft visible-particulates guidance (2021) [R, draft].

#### IB-24 Container-closure integrity
- **Purpose:** seal-parameter control and integrity testing appropriate to the closure type.
- **Config:** closure type (fusion: glass/plastic ampoule, BFS, FFS, SVP/LVP bag; non-fusion: stopper/crimp, plunger/tip cap); container volume; method (validated; deterministic preferred such as vacuum decay, high-voltage leak detection, laser headspace, helium; probabilistic dye/microbial ingress only where justified [R USP <1207>]); visual inspection never selectable; equipment class (India Part XIII names a pressure leak tester; see G.3); sampling plan (non-fusion: scientifically justified from container-closure knowledge, supplier management and component specifications; fusion >100 mL: reduced sampling only with scientific justification and process-consistency data); positive/negative controls at start and end of run [R]; predetermined waiting period for vacuum-retention tests; seal-parameter limits.
- **Fields:** method, instrument ID and calibration, recipe; controls; units tested/passed/rejected by reason (100%) or sample results; leakers and dispositions; seal parameters (heater temperatures, dwell, pressure); vacuum-retention results; mould/tooling status (BFS/FFS).
- **Enforced:** glass ampoules, BFS units and fusion-sealed containers <=100 mL tested 100% (sampling not selectable in the MBR); a 100% visual-inspection record never satisfies a CCI requirement; non-fusion closures: validated CCI on samples and any failure opens an investigation and blocks release; vacuum-sealed containers: retention test after the predetermined period and certification blocked until it passes; failed control invalidates the run and units since the last passing control are retested; seal-parameter excursion segregates the window; integrity-defect units removed at final inspection; rejects counted into accountability.
- **Links:** IB-17, IB-19, IB-22, IB-23, IB-25, IB-30.
- **Implements:** ST-64, IN-50(b), IN-51 (equipment class).
- **Sources:** Annex 1 8.21-8.25 [P]; FDA-AP VI.B.2; USP <1207> series [R]; Schedule M Part XIII.

#### IB-25 Unit accountability ledger
- **Purpose:** close the unit balance at every stage from container issue to packed output (rules in D).
- **Config:** stages (container issue, filler, lyophiliser, capper, terminal load, inspection, CCI, sampling, packaging, serialisation); categories per stage; count sources (machine counters imported vs manual counts with verification); tolerance per stage: **default 0 unexplained units**; a justified count tolerance may be set in the MBR with QA approval (DESIGN-CHOICE); APS: zero, locked.
- **Fields:** per stage, units in and units out by category (D.2).
- **Enforced:** machine counts imported not typed and manual counts verified; each stage balance closes within tolerance or raises a deviation that blocks release (reconciliation discrepancies can never be released on a justification, PR-53); reject categories cannot be merged after the fact and each is traceable to its source step; intervention removals must equal catalogue numbers (IB-16); sample quantities flow in from IB-26/KB-09; stage yields computed with min/max (KB-15).
- **Links:** IB-16, IB-17, IB-19, IB-20, IB-21, IB-23, IB-24, IB-26, KB-15, KB-17.
- **Implements:** IN-17, PR-31, PR-39, ST-32 (APS structure), ST-35 (removed units), ST-62 (inspection reconciliation), ST-71 (release gate).
- **Sources:** 21 CFR 211.103 [P], 211.125(c), 211.186(b)(7), 211.192; Annex 1 8.30, 9.41, 9.47 [C]; EU Ch.4 4.20-4.21; EU Ch.5 5.8, 5.61.

#### IB-26 Event-driven sampling plan (bioburden, sterility, endotoxin, other QC, reserve)
- **Purpose:** generate and trace worst-case, representative samples from execution events.
- **Config:**
  - Pre-sterilisation bioburden (every batch, aseptic and terminal): product limit tied to the filter challenge or cycle lethality (no shipped value; the EU expectation of not more than 10 CFU/100 mL before sterile filtration is [R] unverified and is not a floor); point: aseptic = bulk immediately before the final filter (before the first filter if redundant), at end of hold; terminal = immediately before loading, at end of hold; overkill terminal cycles: scheduled intervals allowed with justification; parametric release: per-batch filled-unit bioburden at worst-case positions.
  - Sterility pulls: start, middle (FDA) and end of the aseptic fill by unit count or time; after each recorded critical intervention or environmental excursion per a risk rule; after every significant interruption (India, mandatory); each terminal load from coolest/slowest-heating positions (own sample set and test); each lyo load; number of units and quantity per medium from USP <71>/Ph. Eur. 2.6.1 tables loaded as master data [R] or the registered plan.
  - Endotoxin (limit K/M, [R] USP <85>), subvisible particulates (USP <788> [R]), container content (USP <697> [R]), other specification tests.
  - Reserve samples: at least twice the quantity for all tests **including sterility** (India rule applied by design; the FDA sterility/pyrogen exclusion is not used), in the marketed container; retention = maximum over markets (India expiry + 3 months [S]; US and EU expiry + 1 year); yearly visual examination of representative reserve samples when US is in the set.
  - Sterile-material sampling (sterile bulk, sterile API, post-filtration): sterile sampling device and its sterilisation record, aseptic method/SOP, location/class, sampler qualification.
- **Fields:** sample ID, type, quantity, time, unit counter, tray/position, load ID, triggering event, sampler, label, chain of custody, LIMS IDs, exterior decontamination method.
- **Enforced:** filtration start without a bioburden sample blocked; sampling after filtration started = sequence violation; sampling at the start of a long hold warns; bioburden over limit -> deviation; bioburden result is a mandatory release item and trended per product; pull tasks generated automatically from events and each sample keeps its origin through LIMS; release check confirms every required pull was sampled and tested and a missing event-driven sample blocks batch completion; incomplete sterile-material sampling records cannot be completed; sample units removed from good count (IB-25); reserve-sample step mandatory and packaging cannot complete without it; disposal blocked before retention date.
- **Links:** IB-13, IB-16, IB-20, IB-21, IB-25, IB-27, KB-09, KB-17.
- **Implements:** ST-54, ST-65 (traceability), ST-66, IN-32, IN-46, IN-49, PR-44, B-02, B-26.
- **Sources:** Annex 1 8.93, 10.3-10.6 [P]; FDA-AP X.C, XI.B [P]; 21 CFR 211.84(c), 211.160(b), 211.165(a), 211.167(a), 211.170(b); Schedule M Part II 2.1-2.3, 5.12-5.17, Part I 19.3(g); USP <71>, <85>, <697>, <788> [R].

#### IB-27 Sterility and endotoxin results, positives and conditional release
- **Purpose:** valid, traceable sterility and endotoxin evidence, correct handling of positives, and the optional short-shelf-life path.
- **Config:** method-suitability link per product x formulation version; test environment; short-shelf-life flag (off by default) with risk-mitigation reference; optional cell-therapy module (intermediate sterility, stain and endotoxin before release; final sterility tracked afterwards).
- **Fields:** test IDs; sample traceability to batch, sub-batch or load; method-suitability reference; environment (isolator/cleanroom ID and status); media lots with sterility and GPT status; analyst qualification on the test date; incubation start/end; result; endotoxin method and result; invalidation record and evidence; retest link; investigation link.
- **Enforced:** release requires approved sterility and bacterial endotoxins (or pyrogen) results traced to this batch (and sub-batch/load) and within specification, and a result from another batch cannot be linked; only alternative is authorised parametric release (IB-21); sterility accepted only with method suitability current for this formulation version (formulation change breaks the link until re-verified); missing environment/media/analyst/incubation elements flagged for QA; exterior decontamination of samples must be validated; a positive sets "sterility failure: presumed non-sterile" and blocks release; invalidation needs QA-approved conclusive evidence of laboratory origin, retest linkable only after that approval, "inconclusive" allows only "reject", originals never replaced, "lab error" without specific evidence refused; investigation pre-filled (IB-29) with associated batches proposed; a passing sterility result is evaluated only after process, procedural and validation checks pass and never closes an open nonconformance; short shelf life: certification before sterility/EM results only with mitigation reference, most recent EM reviewed and late results linked, an adverse late result triggers escalation including a recall assessment; results visible in the batch record, not only in LIMS.
- **Links:** IB-21, IB-26, IB-29, IB-30.
- **Implements:** ST-65, ST-67, ST-68, ST-69, IN-49, PR-54.
- **Sources:** Annex 1 3.2, 10.5-10.10 [P 10.5-10.6]; FDA-AP XI; 21 CFR 211.165, 211.167(a), 211.192, 211.194.

#### IB-28 APS (media fill) batch record type
- **Purpose:** execute and document a media fill with the commercial structure plus APS-specific design, incubation, reading and reconciliation.
- **Config:** generated from the commercial MBR with the same step structure; protocol (worst case justified): container/closure sizes with bracketing/matrixing, maximum line speed and duration (at least routine; manual or intervention-heavy processes at least as long as the real process), maximum exposed holds, fill volume wetting all surfaces with headspace, air instead of inert gas (occasional anaerobic runs considered), maximum headcount and operator time, shift changes and idle interruptions, EM as routine, campaign start/end (an end-of-campaign APS only supplements routine APS), all routine inherent and corrective interventions at representative frequency (rare ones per interval), lyo items (SIP -> load, filtration -> loading, trays, loading duration, representative chamber dwell; media must not boil or freeze; partial vacuum); unit count (typically >=5,000-10,000; for batches under 5,000 units at least the production batch size); medium or non-inhibitory surrogate; incubation default = FDA numbers, enforced (20-35 C, within +/-2.5 C of target, >=14 days in total; with two temperatures >=7 days at each, lower first); fill-end -> incubation-start maximum (DESIGN-CHOICE default 24 h); clear-container substitution for amber/opaque; qualified readers.
- **Fields:** rationale; planned-vs-executed intervention matrix; participants and roles; line speed; duration; embedded EM/PM; media lot with GPT (Gram-positive, Gram-negative, yeast and mould at <100 CFU plus relevant isolates) and sterility status; units filled, incubated, non-incubated (catalogue justification), set-up and line-clearance units (separate population), flush-media units; inversion/agitation confirmation; incubation phases (incubator, temperature, start, end); interim and final reads (research: 7-day and 14-day inspection counts [R]); suspect units referred to QC microbiologist; positives with tray/time block and species ID; QC observer signature; optional video reference; abort/invalidation justification.
- **Enforced:** separate record that can never be released and consumes no product inventory; every unit inverted/swirled; all integral units incubated including cosmetic rejects and units passing non-destructive IPC (wrongly rejected units return to incubation); removal without incubation only in the exact catalogue number for that intervention and line location and **never more than in production** [EU hard]; reconciliation filled = incubated + justified non-incubated + separately incubated set-up units with zero unexplained; excluding an incubated unit needs justification and QA signature; incubation outside the phase rule invalid; cannot close as passed until GPT passes and the QC observer signs (GPT failure forces a repeat APS and investigations); any positive -> result per line profile (IB-15) with investigation; abort/invalidation only by an SOP rule equally applicable to commercial lots, with justification, QA approval and investigation (invalidation frequency reported per line); on closure the line status becomes "post-media-fill clean required" and stays so until the cleaning, sanitisation and sterilisation records exist; results update line envelope and operator participation.
- **Links:** IB-03, IB-04, IB-15, IB-16, IB-25.
- **Implements:** ST-31, ST-32, ST-33, IN-45.
- **Sources:** Annex 1 9.32-9.48 [C]; FDA-AP IX.A [C]; 21 CFR 211.113(b); PDA TR22 (2025) [R].

#### IB-29 Contamination-event impact engine and investigation evidence pack
- **Purpose:** turn any sterility-relevant event into a scoped, justified impact assessment across every potentially affected batch, and pre-fill the investigation.
- **Config:** trigger catalogue; scope rules (time window, room/zone, line, shared equipment such as a lyophiliser serving several lines, utility point/loop, filter lot/serial, component lot, operator, glove port); microbiology reviewer role; market-impact template.
- **Default triggers:** EM/PM action excursion (window from sampling to reporting); any Grade A growth; adverse EM trend; failed APS (all batches since the last successful APS; quarantine since the failure); unqualified intervention; failed or deviating sterilisation/depyrogenation/SIP cycle; failed PUPSIT, post-use, vent, gas or lyophiliser filter test; filtration CPP deviation; glove or barrier integrity failure; critical DP alarm or loss of air supply; unplanned maintenance on sterility-critical equipment; water action excursion or post-sanitisation results pending; hold-time exceedance; unusual defect rates or a critical defect after 100% inspection; AVI challenge failure; lyophiliser leak-rate failure; unqualified person entry; power interruption; operator disqualification; HEPA leak; sterility-test failure.
- **Fields:** trigger and source record; window; auto-proposed batch scope; per-batch inclusion/exclusion with rationale; root cause; product-risk statement; CAPA link; residual-risk acceptance; organism ID and method; EM short- and long-term trends; PM trends for the roster; bioburden trend; interventions and stoppages; alarms, DP and particle excursions; utility and power events; maintenance and construction work orders; prior deviations and changes; lab records and lab EM trend; HEPA retest task; disposition per batch.
- **Enforced:** certification of every linked batch blocked while an assessment is open; inclusion/exclusion rationale mandatory for each candidate batch; outcomes propagate to all listed batches, including released ones (market-impact decision); "other batches/products assessed" cannot be empty; "lab error" needs conclusive evidence; isolates compared using the same identification method; media-fill and sterility-failure templates generate a HEPA retest task; DESIGN-CHOICE: impact traversal runs on a derived, rebuildable projection reconciled against the system of record (if it drives automatic quarantine it is validated).
- **Links:** every IB block; KB-13.
- **Implements:** ST-17 (HEPA retest task), ST-21, ST-33 (scope), ST-36, ST-67, ST-71, PR-50, PR-57, IN-20.
- **Sources:** Annex 1 3.1-3.2, 9.13, 9.46 [C]; FDA-AP X.A.1, XI.C; 21 CFR 211.192.

#### IB-30 Sterile release dossier and certification gate
- **Purpose:** present every sterility-relevant element in signed sections and hold QA release / QP certification until all are complete and acceptable.
- **Config:** dossier sections (fixed minimum; tenant may add); required-results list per MBR; consolidated timeline (DESIGN-CHOICE, exportable); review-by-exception for validated, continuously monitored data (cycle traces, EM streams) with non-suppressible escalation of sterility-critical exceptions.
- **Sections:** viable and total-particle EM across all rooms/zones used during the full processing window; roster personnel monitoring; HVAC, HEPA and pressure-differential status; water (WFI) and clean-steam results covering the batch period; equipment/EMS alarm report and power events; **all** filter integrity results (product, vent, gas, lyophiliser); sterilisation, depyrogenation and SIP cycle roll-up; container/closure preparation; interventions and stoppages; time-limit compliance; APS and personnel-qualification snapshot at the fill date; IPC and lab results; visual inspection, CCI and accountability; bioburden; sterility and endotoxin; yields; storage/transport excursions; linked deviations and investigations with batch-scope rationale; header items (route, CCS version, parametric-release and short-shelf-life flags).
- **Enforced:** each section signed by a reviewer and the release/certification signature enabled only when every section is signed and nothing is open (data gaps count as open items); required results linked immutably (value, limit, status) and visible in the batch record, with a later source change showing history and forcing re-review; every consumed item resolves to a unique cycle ID and any unreviewed or non-conforming cycle blocks certification; certification also blocked when any filter/vent/gas/lyo result is missing or failed, EM/PM results are pending (unless the short-shelf-life path applies), water post-sanitisation results are unapproved, the line APS was failed/suspended at manufacture or the batch is in an APS-failure scope, any linked deviation or investigation is open (or not assessed as non-affecting), yield/accountability is outside limits and unexplained, a storage excursion or an alarm is unassessed, or only a sterility result is offered while process items are open; explicit "EM and trend data reviewed" signature; certifier role needs a sterile-products training record; QP/QA reach every source from one screen; India: processing record, EM data and sterility result presented together and each opened and acknowledged; structured data kept for PQR/APR, CCS review and management review (interventions, holds, defects, excursions, filter values, cycle results, time-limit exceedances, APS, sterility/endotoxin, deviations).
- **Links:** all blocks; KB-19.
- **Implements:** ST-24, ST-68, ST-70, ST-71, ST-72, ST-73, IN-05, IN-42(b), IN-49, PR-52, PR-53, PR-54, PR-55, PR-56, PR-58, DI-25.
- **Sources:** Annex 1 2.4, 2.7, 3.1-3.2, 8.45, 10.5, 10.10 [C; 10.5 P]; FDA-AP XII; 21 CFR 211.180(e), 211.188, 211.192; Schedule M Part II 2.3, 4.8.

---

## C. Calculations

### C.0 Engine conventions (apply to every formula)
- Calculations run only in the validated expression library (KB-04, DI-33). Inputs come from captured or approved values (device, LIMS, master data); the trace (inputs, formula version, units, output) is stored; a corrected input recomputes the result and keeps the previous one.
- **Precision and rounding:** intermediates at full precision; rounding only for display and for comparison with a limit, using the rounding rule attached to that limit (default: round the result to the last digit of the limit, halves rounded up, the compendial general-notice convention [R]). Unit counts are integers; theoretical units are rounded down (floor). Yield percentages are displayed to 0.1% (DESIGN-CHOICE).
- **Units:** SI with a controlled unit catalogue; the engine rejects dimensionally inconsistent expressions at design time. Density in g/mL (= kg/L) at a stated temperature; temperature in C; lethality in minutes; pressure in stated units (mbar, bar, Pa) with explicit conversion.
- **Verification:** yield and reconciliation results computed automatically are verified by one person; manual calculations need a performer and a second verifier (21 CFR 211.103 [P]).
- Worked examples below are arithmetic checks, not regulatory values.

### C.1 Formulation and quantities

**C-01 Mass/volume conversion via density**
- m = V x rho ; V = m / rho. Inputs: V (mL or L), rho (g/mL = kg/L) with its measurement temperature and instrument ID; source of rho recorded (specification constant / lot CoA / measured on this batch).
- Rule: fill-weight targets use the density measured on the final bulk of this batch unless the MBR states otherwise; temperature basis must match the density specification.
- Dimension check: mL x g/mL = g; L x kg/L = kg. OK.

**C-02 Potency-adjusted API quantity**
- m_API (g) = [C_label (mg/mL) x V_batch (mL) / 1000] x F_salt x (100 / A_asis) x (1 + OV/100)
- F_salt = MW_salt / MW_base: applied only when the label claim is expressed as the base/active moiety, the dispensed material is the salt, and the assay is reported as % of the salt (otherwise F_salt = 1).
- A_asis = assay on the as-is basis (%). If the CoA/LIMS assay is on the anhydrous (or dried/solvent-free) basis: A_asis = A_anhydrous x (100 - W - S)/100, where W = water % and S = residual solvent % that the assay basis excludes.
- OV = approved overage % stated and justified in the MBR (211.186(b)(5)); OV = 0 if none.
- Rules: A_asis, W, S pulled from the approved LIMS result of the released lot, never typed; the target may never deliver less than 100% of label (211.101(a)); in a solution made up by q.s., no compensating excipient is needed because the vehicle (WFI) brings the batch to final weight/volume (C-04).
- Dimension check: mg/mL x mL = mg; /1000 -> g; all factors dimensionless. OK.
- Arithmetic check: C_label 10 mg/mL (base), V_batch 100,000 mL, F_salt 1.10, A_asis 98.5%, OV 0 -> 1,000 g x 1.10 x 100/98.5 = 1,116.75 g.

**C-03 Other components (solutions)**
- m_i (g) = c_i (mg/mL) x V_batch (mL) / 1000, with V_batch one of the approved discrete batch sizes (PR-01). Dimension check OK.

**C-04 Final q.s. target**
- By weight: W_bulk,target (kg) = V_batch (L) x rho_bulk (kg/L). By volume: read at the stated temperature.
- Tolerance on the final weight per MBR. Dimension check: L x kg/L = kg. OK.

### C.2 Filling

**C-05 Target fill volume and fill weight**
- V_target (mL) = V_label + V_excess.
- V_excess = registered value, or the USP <1151> recommended excess loaded as master data [R] (checked by research only against a translated USP 44 copy; re-verify): labelled 0.5 mL -> 0.10 mobile / 0.12 viscous; 1.0 -> 0.10 / 0.15; 2.0 -> 0.15 / 0.25; 5.0 -> 0.30 / 0.50; 10.0 -> 0.50 / 0.70; 20.0 -> 0.60 / 0.90; 30.0 -> 0.80 / 1.20; 50 mL or more -> 2% / 3% of the labelled volume.
- W_net,target (g) = V_target (mL) x rho (g/mL); W_gross,target = W_net,target + tare (container, plus closure when weighed closed; tare measured per unit or nominal, as the MBR defines).
- Alert limits = W_net,target x (1 +/- a/100); action limits = W_net,target x (1 +/- b/100), a < b (company-defined).
- Volume from a measured weight: V_unit = W_net / rho.
- DESIGN-CHOICE design-time guard: the lower action limit may not be below V_label x rho (individual units must deliver at least the labelled volume, USP <697> [R]).
- Dimension check: mL x g/mL = g. Arithmetic check (research example): 10 mL label, mobile, rho 1.012 g/mL -> V_target 10.50 mL -> W_net 10.626 g.

**C-06 Theoretical number of units**
- N_theo = floor[(V_bulk,net - V_holdup - V_QC,bulk - V_setup/purge) / V_target], all volumes in the same unit; deductions fixed in the MBR (or the MBR states batch size directly in units). If bulk is measured by weight: V_bulk,net = W_bulk,net / rho.
- The point at which N_theo is fixed (after q.s. or after filtration) is defined in the MBR and used consistently as the denominator of C-07.
- Dimension check: L/L dimensionless. Arithmetic check: (105.0 - 2.0 - 0.3 - 0.2) L / 0.0105 L = 9,761.9 -> 9,761 units.

### C.3 Yields and reconciliation (rules in D)

**C-07 Stage yield**
- Yield % = actual output at stage / theoretical output at stage x 100. Instances: bulk yield = W_bulk,actual / W_bulk,theoretical x 100; filling yield = N_passed from filler / N_theo x 100; lyo yield = N_unloaded,good / N_loaded x 100; capping yield = N_capped / N_in x 100; inspection yield = N_accepted / N_presented x 100; overall yield = N_packed,finished / N_theo x 100.
- Dimensionless. Min/max per MBR (KB-15).

**C-08 Unit accountability**
- Accounted = N_out,accepted + sum(rejects by reason) + sum(samples: QC, destructive IPC, acceptance-sample units destroyed, reserve, stability) + N_broken/destroyed + N_returned unused.
- Unexplained = N_in - Accounted (integer); Accountability % = Accounted / N_in x 100.
- Target: Unexplained = 0 (or within a justified count tolerance, IB-25).

**C-09 Printed-material reconciliation**
- Accounted = Used + Destroyed_coded + Destroyed_damaged + Returned_uncoded + specimens/samples; Discrepancy = Issued - Accounted (positive = missing, negative = over-accounted; both are discrepancies); Reconciliation % = Accounted / Issued x 100; cross-check Used against units labelled plus label rejects.
- Limits narrow, preset, historical (211.125(c)); dimensionless counts.

**C-10 Serial-number reconciliation**
- Commissioned = packed/aggregated + decommissioned (destroyed, sampled, rejected) + returned to pool; unexplained must be 0 before release.

**C-11 Reserve-sample quantity**
- n_reserve >= 2 x sum over all release tests j of n_test,j, including sterility (India rule applied by design; the FDA exclusion of sterility and pyrogen tests is not used).

### C.4 Sterilisation lethality

**C-12 Moist-heat F0**
- Lethal rate: L(t) = 10^((T(t) - T_ref)/z), with z = 10 C and T_ref = 121.0 C (convention attributed by research to Ph. Eur. 5.1.1 / USP <1229.2>) or 121.1 C (PDA TR1) [R]. The site selects one convention; it is stored with every F0 value and with every F0 limit, and the engine refuses to compare values computed under different conventions.
- F0 (min) = sum over logging intervals of [(L_i + L_(i+1)) / 2] x delta_t_i (trapezoid rule, delta_t in minutes), computed separately for every probe (control and independent monitoring), integrated between configurable threshold temperatures (research: e.g. 100 C [R]); the record shows F0 per position and the minimum across positions.
- Checks: L at T_ref - 1 C = 0.794; 25.9 min at 116 C gives F0 = 8.00 min with T_ref 121.1 C and 8.19 min with T_ref 121.0 C; F0 computed with T_ref 121.1 C = F0 with 121.0 C x 0.9772 (about 2.3% lower).
- Acceptance: minimum F0 at the slowest-heating position >= validated minimum; maximum F0 <= validated maximum (degradation). The Annex 1 glossary cites F0 >= 8 min as an example of steam-sterilisation requirements [P]; the eBMR ships no F0 floor (validated value per product) but applies the IB-01 route review below 8 min.
- Dimension check: L dimensionless; F0 in minutes. OK.

**C-13 Biological lethality and probability of a non-sterile unit (PNSU)**
- Log reduction delivered = F / D_Tref (F and D in minutes at the same reference temperature).
- log10 N_final = log10 N0 - F / D ; PNSU per unit = N_final; requirement PNSU <= 10^-6 (SAL <= 10^-6 [P glossary]) -> required F >= D x (log10 N0 + 6).
- F_bio = D_121 x (log10 N0 - log10 N) (Ph. Eur. 5.1.1 per research [R]).
- Overkill (Annex 1 glossary [P]): >= 12 log10 reduction of organisms with D >= 1 min, i.e. delivered lethality of at least 12 x D.
- Arithmetic check: N0 = 100 per unit, D = 1 min -> F >= 1 x (2 + 6) = 8 min. Dimension check: min / min = log units. OK.

**C-14 Dry-heat equivalence (FD / Fh) and depyrogenation**
- FD (min) = sum of 10^((T_i - T_ref)/z) x delta_t_i, with T_ref = 250 C and z = 50 C per USP <1228.1> [R] (z range 45-55 C per research); Annex 1 uses the term Fh without fixing a convention, so the convention is stored with the value. Computed at the coldest monitored position of each tunnel/oven run and compared with the validated minimum.
- Validation reference must show endotoxin log reduction LRV = log10(E_recovered,positive control / E_recovered,after process) >= 3 (Annex 1 8.68, FDA-AP VI.B.1 [P]).
- Arithmetic check: 5 min at 300 C -> FD = 5 x 10^((300-250)/50) = 50 min.

### C.5 Endotoxin

**C-15 Endotoxin limit and maximum valid dilution** [R USP <85>, per research]
- EL = K / M. K = 5 EU/kg (non-intrathecal), 0.2 EU/kg (intrathecal); radiopharmaceuticals 175/V (intrathecal 14/V; V = maximum recommended dose in mL); K = 100 EU/m2 for products dosed per body surface. M = maximum dose per kg per hour (or bolus). The body-weight convention (70 kg) was not verified.
- MVD = EL x C / lambda (C = concentration of the test solution; lambda = labelled lysate sensitivity in EU/mL).
- Dimension check: (EU/kg)/(mg/kg) = EU/mg; (EU/mg x mg/mL)/(EU/mL) = dimensionless. OK.

### C.6 Filtration and filter integrity

**C-16 Filtration process values**
- Average flow Q = V_filtered / t (L/min); DP = P_upstream - P_downstream; time for a known volume t_ref = time for V_ref taken from the totaliser/load-cell trace; total filtration/contact time = t_last product contact - t_first wetting, **pauses included** (ST-37); throughput per area = V_filtered / A_filter (L/m2) <= validated maximum.

**C-17 Integrity-test specifications and conversions** [R PDA TR26 (2025), per research]
- Product-wet limits derived from water-wet limits: PBP_min = WBP_min x (PBP_avg / WBP_avg); test pressure TP_pw = MTP_ww x (PBP_avg / WBP_avg); DFL_pw = DFL_ww x (DF_pw / DF_ww). Pass: measured bubble point >= minimum; diffusive flow at test pressure <= maximum.
- Pressure decay to approximate diffusive flow: Q (mL/min) ~ (DP_decay / P_atm) x V_upstream (mL) / t (min), DP_decay and P_atm in the same unit. Arithmetic check: 0.02 bar in 10 min, V 500 mL, P_atm 1.013 bar -> 0.99 mL/min.
- Informative: bubble point P = 4 k gamma cos(theta) / d (why wetting fluid and temperature change the result).
- Rule: the limit and its wetting fluid/temperature basis come from filter master data; a test run with a different fluid or outside the temperature basis is invalid.

### C.7 Lyophilisation

**C-18 Leak rate**
- Q_leak (mbar.L/s) = DP (mbar) x V (L) / delta_t (s), V = chamber + condenser volume, chamber isolated at test vacuum; compared with the specified maximum at the start of every cycle (Annex 1 8.124 [P]).
- Arithmetic check: 0.05 mbar rise in 600 s, V 500 L -> 0.042 mbar.L/s.

### C.8 Time

**C-19 Elapsed and remaining time**
- Elapsed = t_end - t_start (server timestamps). Pause handling per rule: included (wall clock; mandatory for total filtration time) or excluded (sum of active intervals).
- Remaining = Limit - Elapsed; warning when Remaining <= w x Limit (w DESIGN-CHOICE default 10%).
- Named derived times: product exposure = t_last unit sealed - t_first open container; partial-stopper exposure = t_chamber closed - t_first tray out of filler (per load); stopper-to-crimp = t_crimp - t_stoppering, evaluated per tray or time block and reported as the maximum (DESIGN-CHOICE basis); use-by = t_cycle end + validated hold.

**C-20 Cumulative time out of refrigeration** = sum over excursions of (t_return,i - t_removal,i) per unit/tray/lot; limit from stability data.

### C.9 Monitoring

**C-21 Air and particle normalisation**
- Viable air (CFU/m3) = CFU / [Q (L/min) x t (min) / 1000]. Particles (per m3) = counts / V_sampled (m3). At 28.3 L/min one minute samples 0.0283 m3, so a single count equals 35.3 per m3.
- Consequence (see G.4-1): one >=5 um count in a one-minute Grade A sample already exceeds both the EU (29) and India (20) per-m3 values. Annex 1 Table 5 note 2 treats occasional single counts as possible false counts but requires investigation of consecutive or regular low counts [P]. The engine therefore evaluates every sample normalised per m3, annotates an isolated single count, and raises an investigation event under the configurable consecutive/recurrence rule (ST-19); the evaluation window is a QA decision.

**C-22 Contamination recovery rate (trending)** [R USP <1116>]: CRR % = samples with any growth / total samples of that type and area in the period x 100.

**C-23 Reject rate per defect code** = N_rejected,code / N_inspected x 100; alert/action limits set from historical data by a statistical method chosen by the site (DESIGN-CHOICE, e.g. control-chart limits).

**C-24 Peak headcount** = maximum over time of concurrent persons in the room from entry/exit intervals. **DP excursion** = minimum DP in window and total time below limit.

**C-25 pH adjustment** = cumulative adjusting-agent volume = sum of additions <= MBR maximum.

### C.10 Sampling and acceptance tables (implemented as validated lookup tables, not free formulas)

**C-26 Sterility-test number of units** [R USP <71> Table 3, per research; harmonised with Ph. Eur. 2.6.1]
- Parenterals, per medium: N <= 100 containers -> max(ceil(0.10 x N), 4); 100 < N <= 500 -> 10; N > 500 -> min(ceil(0.02 x N), 20); large-volume parenterals -> min(ceil(0.02 x N), 10); double the number when one container cannot supply both media.
- Quantity per medium (Table 2): < 1 mL whole contents; 1-40 mL half the contents, not less than 1 mL; > 40-100 mL 20 mL; > 100 mL 10% of contents, not less than 20 mL.
- Arithmetic check: N = 12,000 vials of 5 mL -> 20 per medium (2.5 mL each if a container is split between media; otherwise 40 containers).

**C-27 Acceptance sampling (AQL)** [R]: code letter = f(lot size, general inspection level II) and (n, Ac, Re) = f(code letter, AQL) from ANSI/ASQ Z1.4 / ISO 2859-1 (single, normal); n taken for the most critical class, accept numbers for other classes at that n; tightened plan after reinspection.

**C-28 Visual-inspection qualification metrics** [R USP <1790>]: probability of detection %PoD = times rejected / times inspected x 100; reject zone >= 70% PoD, accept zone < 30%, grey zone 30-70%.

**C-29 APS unit count and outcome** : N_APS justified in the CCS (typically >= 5,000-10,000); if the production batch is < 5,000 units, N_APS >= N_batch; outcome by E-6 using the number of units filled and contaminated units.

---

## D. Yield and reconciliation rules

### D.1 Basis
- Actual yield and % of theoretical at the end of each appropriate phase, verified by a second person (one person when calculated by automated equipment) [P 21 CFR 211.103]; master records carry min/max % beyond which investigation is required (211.186(b)(7)); unexplained discrepancies, including yields outside master limits, are investigated and the investigation extends to other batches (211.192; FDA-AP XII text box repeats this [P]).
- EU: expected final yield with limits (Ch.4 4.17(d)); record yields (4.20(g)); significant deviations from expected yield recorded and investigated (Ch.5 5.44); discrepancies in reconciliation explained before release (5.61).
- India: stage yields computed automatically against MBR limits; bulk and printed components reconciled; any out-of-limit yield or unusual discrepancy opens a deviation that blocks release (IN-17); no roll-label waiver.
- Sterile catalog: yield and reconciliation (bulk, fill count, inspection, labelling) within limits or explained is a release condition (ST-71); inspection reconciliation (ST-62); intervention removals counted (ST-35); APS reconciliation with zero unexplained (ST-32).

### D.2 Checkpoints (default set; MBR may add, not remove, for the variant)

| # | Checkpoint | Balance / formula | Categories that must be counted | Limit source | Block |
|---|---|---|---|---|---|
| R-1 | Dispensing | dispensed vs target per item; accumulated charged = sum of containers | returned unused material, spillage (with event) | tolerance per item (MBR) | KB-05, KB-06 |
| R-2 | Bulk | bulk yield (C-07) after q.s. | QC bulk samples, hold-up | min/max % (MBR) | KB-15, IB-12 |
| R-3 | Filtration (optional, informative) | V received in sterile vessel / V to filtration | filter/line hold-up, flush | MBR | IB-13 |
| R-4 | Container preparation | issued = passed to filler + breakage + wash/tunnel rejects + returned | glass-breakage removals (SOP count) | 0 unexplained | IB-07, IB-25 |
| R-5 | Filler | presented to filler = passed to next step + filler rejects by reason (weight, missing/displaced stopper or plunger, broken, seal defect) + set-up/adjustment units + intervention removals (catalogue number) + line-clearance removals + destructive IPC units + sterility/QC samples taken at filler + broken/lost + unused returned; filling yield = passed / N_theo | every reason separately | 0 unexplained (or justified tolerance); filling yield min/max | IB-17, IB-16, IB-25 |
| R-6 | Lyophiliser | loaded = unloaded + broken/fallen (with shelf position) + samples removed | per load | 0 unexplained | IB-20, IB-25 |
| R-7 | Capping | in = capped + rejects (missing/displaced stopper, crimp) | | 0 unexplained | IB-19, IB-25 |
| R-8 | Terminal sterilisation (per load and total) | units into load = units out + leakers/damaged; sum of loads = units filled | per sub-batch | 0 unexplained | IB-21, IB-25 |
| R-9 | CCI (100% stages) | tested = passed + rejected by reason; sample units accounted | control units excluded from product counts | 0 unexplained | IB-24, IB-25 |
| R-10 | 100% visual inspection | presented = accepted + rejects per defect code + acceptance-sample units (returned or destroyed) + QC samples + destroyed; reject rate per code (C-23) | per defect code and criticality; per inspector | 0 unexplained; alert/action per code | IB-23, IB-25 |
| R-11 | Packaging (units) | received from inspection = packed + samples (reserve, QC, stability) + rejects + destroyed + set-aside | per packaging order / part batch | 0 unexplained | KB-17, IB-25 |
| R-12 | Printed components | C-09 per item | coded destroyed vs uncoded returned | narrow, preset, historical (MBR) | KB-17 |
| R-13 | Serials | C-10 | decommission reasons | 0 unexplained | KB-17 |
| R-14 | Overall | N_packed,finished / N_theo x 100 | | min/max % (MBR) | KB-15 |
| R-15 | APS | filled = incubated + justified non-incubated (catalogue) + separately incubated set-up units (+ flush units); incubated count identical at each read | cosmetic rejects incubated; wrongly rejected units returned | 0 unexplained, locked | IB-28 |
| R-16 | Reprocessing / reinspection | separate step with its own yield and counts | reinspection rejects kept separate | MBR / SOP | KB-18 |

### D.3 What happens outside limits
1. **Yield outside min/max (any stage):** automatic deviation and 211.192 investigation, extended to other batches and products; mandatory explanation (India); release/certification blocked until the investigation is closed (ST-71, IN-17, PR-31). The PR-53 option of releasing on an e-signed justification while an investigation is open is **not** available for reconciliation/accountability discrepancies.
2. **Blocking the next step** on an out-of-limit yield is not required by the texts (production catalog C-24): DESIGN-CHOICE. Injectables default: **bulk yield outside limits deviation-gates the start of sterilising filtration** (supervisor acknowledgement plus QA decision), because a compounding error cannot be corrected after filling; other stages continue with the deviation open and release blocked.
3. **Unit accountability with unexplained units** (above zero or the justified tolerance): deviation, release block; the investigation template compares the gap with PLC/SCADA stops and intervention records (possible unrecorded interventions) (DESIGN-CHOICE aid).
4. **Intervention removal count differs from the catalogue value:** deviation (ST-35); in an APS, removal above the production value is refused (ST-32).
5. **APS:** any unexplained unit opens an APS-validity investigation and the APS cannot close as passed (IB-28).
6. **Printed components outside limits:** investigation; packaging order close and release blocked until explained (PR-39); no waiver for roll labels (India); bulk and batch-coded printed-material reconciliation never waived when EU is in the set.
7. **Serial discrepancy:** release blocked (PR-42).
8. **Inspection reject rate above alert/action for a defect code:** investigation and release block (ST-62); a critical defect found in accepted units: investigation, release block, reinspection decision under SOP (ST-63); adverse trends: market-impact assessment (Annex 1 8.33 [P]).
9. **Correction of any input quantity:** yields and balances recomputed with audit trail; earlier result kept; re-verification required (DI-33).
10. **Trending:** yields, reject rates by code and accountability gaps are stored as structured data for PQR/APR (ST-73, PR-58).

### D.4 Limit setting
- Every checkpoint must carry min/max (yields) or tolerance (counts) in the MBR before approval (PR-03, KB-15); no numeric yield limits are shipped because none exist in the texts.
- Printed-material limits: narrow, preset and based on historical operating data (211.125(c)).
- Unit-count tolerance default 0; a non-zero tolerance needs a documented justification and QA approval in the MBR (DESIGN-CHOICE); APS tolerance is always 0.

---

## E. Limit tables (shipped defaults; tighten-only)

Floor type: **H** = hard number (cannot be loosened, ST-01); **G** = Annex 1 guidance value (loosening only with a CCS justification and QA approval, displayed on every affected batch); **D** = derived from another record (APS envelope, validation); **V** = must be validated per product/site, no shipped number; **DC** = product design-choice default. "Resolved" = value applied for the shipped default profile India + EU + US (strictest wins; India is always present). Every limit record stores source, clause, market, floor type and version (ST-01).

### E-1 Total particles, maximum per m3 (monitoring action limits)

| Grade | >=0.5 um at rest | >=0.5 um in operation | >=5 um at rest | >=5 um in operation | Resolved source |
|---|---|---|---|---|---|
| A | 3,520 | 3,520 | **20** | **20** | 0.5 um: EU Table 5 = India = FDA ISO 5; 5 um: India Table 1 (EU monitoring value 29) |
| B | 3,520 | 352,000 | 29 | **2,900** | India (EU 2,930 in operation) |
| C | 352,000 | 3,520,000 | **2,900** | **29,000** | India (EU 2,930 / 29,300) |
| D | 3,520,000 | site-set from risk assessment and routine data (EU); not defined (India) | **29,000** | site-set | India at rest (EU 29,300) |

- Source values: EU Annex 1 Table 5 and 9.15-9.17 [P]; Schedule M Part II Table 1 (IN-40; values reassembled from a scrambled Gazette copy, F-6: confirm); FDA-AP Table 1: ISO 5 3,520, ISO 6 35,200, ISO 7 352,000, ISO 8 3,520,000, >=0.5 um only, in operation [P].
- Classification (not monitoring): EU Table 1 leaves >=5 um "not specified" for Grade A and for Grade B at rest; India Table 1 gives 20 (A) and 29 (B at rest). Resolved: India values also used for classification acceptance; the EU monitoring value 29/m3 for Grade A applies only to monitoring (ST-19). India classification sampling: at least 1 m3 per location in Grade A (IN-40(e)).
- Floor type H for all numbers above; alert levels V (from qualification data), required for Grade A particles and all of B-D.
- Monitoring mechanics (H): Grade A continuous for >=0.5 and >=5 um at >=28 L/min (1 ft3/min) for the full critical processing including equipment assembly (9.16-9.17 [P]); FDA profile: probe within about 30 cm (1 ft) of the work site [C]; single >=5 um counts per Table 5 note 2 [P] and C-21.

### E-2 Viable action limits (routine monitoring)

| Grade | Air (CFU/m3) | Settle plate 90 mm (CFU/4 h) | Contact plate 55 mm (CFU/plate) | Glove print, 5 fingers (CFU/glove) |
|---|---|---|---|---|
| A | no growth | no growth | no growth | no growth |
| B | 10 | 5 | 5 | 5 |
| C | 100 | 50 | 25 | not set |
| D, no US market | 200 | 100 | 50 | not set |
| D, US in market set, room FDA would class ISO 8 | **100** | **50** | 50 | not set |

- Sources: EU Table 6 with notes (a)-(c) (9.30) [P]; FDA-AP Table 1 action levels: ISO 5 1 CFU/m3 and 1 CFU/4 h (normally no growth), ISO 6 7 / 3, ISO 7 10 / 5, ISO 8 100 / 50, settle plates optional [P]; Schedule M Part II Table 3: A < 1 for all four, B-D as EU, stated to be averages and informative (IN-42).
- Resolved rules (H): each sample judged individually (no averaging); Grade A has no alert tier and any growth is an action event; species-level identification for A/B isolates; contact-plate limits apply to equipment, room and gown surfaces in A/B.
- Qualification microbial limits (EU Table 2, 4.31): A no growth; B 10 / 5 / 5; C 100 / 50 / 25; D 200 / 100 / 50 (air / settle / contact) [C]. Gowning qualification judged against Table 6 contact/glove limits (Grade B 5 CFU; Grade A no growth; Table 2 note 3) [C].
- Personnel monitoring (H): Grade A gloves no growth; Grade B gloves and gown contact plates 5 CFU (Table 6) [C].

### E-3 Airflow, pressure, recovery and monitoring mechanics

| Parameter | Shipped default / floor | Type | Clause |
|---|---|---|---|
| DP between adjacent rooms of different grades | >= 10 Pa | G | Annex 1 4.14 [P] (FDA: 10-15 Pa between classes [P]) |
| DP aseptic room to unclassified area | >= 12.5 Pa at all times | H | FDA-AP IV.A [P] |
| UDAF air speed at working position | 0.36-0.54 m/s | G (range) | Annex 1 4.30 [P]; FDA 0.45 m/s +/- 20% about 15 cm below filter face and at working height [P] |
| UDAF minimum at working level | 0.36 m/s | H (India) | Schedule M Part II 4.3 (IN-40, B-25) |
| Clean-up (recovery) period to at-rest limits | from qualification; < 20 min | G | Annex 1 4.29(iii), Table 5 note 1 [P note 1]; India 15-20 min with 100-fold reduction (IN-40(d)) |
| Settle-plate exposure per plate | <= 4 h | H | Annex 1 Table 6 note (a) [P] |
| Grade A particle sample flow | >= 28 L/min | H | Annex 1 9.17 [P] |
| Particle counter tubing | typically <= 1 m | qualification item, not per batch | Annex 1 5.9 [C] |
| Isolator overpressure | qualified limits (FDA typical 17.5-50 Pa) | V | FDA-AP Appendix 1 [P] |
| HEPA in-place leak test: significant leak | single probe reading about 0.01% of upstream challenge | H | FDA-AP IV.D [P] |
| Maximum headcount per room | <= maximum qualified in latest successful APS | D | Annex 1 7.2, 9.36 [C] |
| Door-open maximum | site value | V | ST-17 |

### E-4 Periodic intervals and frequencies

| Item | Shipped default (maximum) | Type | Clause |
|---|---|---|---|
| Cleanroom/clean-air equipment requalification | A/B 6 months; C/D 12 months | H | Annex 1 4.32 [C] |
| HEPA in-place leak test | default 6 months for all classified rooms (ST-17); maximum A/B 6 months, C/D 12 months; India-only profile: block beyond 12, warn beyond 6 | H (maximum) | Annex 1 4.32; FDA-AP IV.D (twice a year) [P]; Schedule M Part II 4.5 (IN-43) |
| Depyrogenation-tunnel HEPA integrity | 6 months ("at least biannually" read as twice a year) | H | Annex 1 8.67 [P]; FDA-AP IV.D |
| Steriliser vacuum leak test (vacuum phase or sub-ambient return) | 7 days | H | Annex 1 8.60 [P] |
| Air-removal (Bowie-Dick type) test | same day before porous loads, or air detector every cycle | H | Annex 1 8.61 [C] |
| Heat-sterilisation revalidation | 12 months for **every** heat process (EU: worst-case patterns; India: every process) | H | Annex 1 8.39 [P]; Schedule M Part II 6.5 (IN-47) |
| Lyophiliser leak rate | start of every cycle, <= specified maximum | H | Annex 1 8.124 [P] |
| Lyophiliser sterilisation (manual-open loading) | before every load (from 25 Aug 2024) | H | Annex 1 8.123 [P] |
| Isolator glove integrity test | start and end of each batch or campaign (session start/end for small manual batches) + visual check each use | H | Annex 1 4.21 [C] |
| Gowning requalification | 12 months | H | Annex 1 7.4 [C] |
| Operator participation in a successful APS | 12 months, in the role performed | H | Annex 1 9.38 [C] |
| Periodic APS | about 6 months per process x line x shift (EU); initial 3 consecutive successful runs covering all shifts | H | Annex 1 9.38 [C]; FDA-AP IX.A.2 |
| Manual aseptic operator APS | 3 initial, then about 6 months per operator x configuration | H (EU in set) | Annex 1 9.39 [C] |
| Formulation/bulk aseptic-stage simulation | at least twice a year | H | FDA-AP Appendix 3.A [C] |
| Visual-inspection qualification (incl. eyesight consideration) | 12 months | H | Annex 1 8.31 [P]; Schedule M Part I 11.5.1 |
| WFI sampling | at least one representative sample every day of use, all outlets over defined interval | H (water system) | Annex 1 6.7-6.15 [C] |
| Expert observation of aseptic operations | at least monthly per line | DC | Annex 1 8.19 ("regular") [P] |
| PM glove sampling | at least daily or per lot, plus every Grade B exit (gloves and gown) and after critical interventions | H | FDA-AP V.C; Annex 1 9.25 [C] |

### E-5 Process and validation values

| Value | Default / floor | Type | Clause |
|---|---|---|---|
| Sterility assurance level (terminal) | <= 10^-6 | H | Annex 1 glossary [P] |
| Overkill cycle | >= 12 log10 reduction, D >= 1 min | H (definition) | Annex 1 glossary [P] |
| Post-aseptic terminal heat treatment | SAL <= 10^-6 shown, steam-sterilisation requirement (e.g. F0 >= 8 min) not met | definition | Annex 1 glossary [P] |
| Minimum F0 of a terminal cycle | validated per product (no shipped floor; route review if < 8 min, IB-01) | V / DC | Annex 1 8.59, glossary [P] |
| Final sterilising filter pore rating | <= 0.22 um nominal (FDA 0.2 um, interchangeable) | H | Annex 1 8.79, glossary [P]; FDA-AP IX.B |
| Process-gas point-of-use filter | <= 0.22 um nominal sterilising grade | H | Annex 1 6.19 [P] |
| Fibre-releasing filter | then a downstream non-fibre-releasing filter <= 0.2 um (0.45 um only if manufacturing conditions require); asbestos prohibited | H | 21 CFR 211.72 [P] |
| Bacterial-retention validation challenge | >= 10^7 CFU/cm2 (typically B. diminuta) | H (validation ref) | Annex 1 glossary [P] |
| Liquid sterilising filter use | one batch; <= 1 working day continuous unless validated | H | Annex 1 8.94 [P]; Schedule M Part II 6.11.2 |
| Depyrogenation validation | >= 3 log10 endotoxin reduction, suitable Fh | H (validation ref) | Annex 1 8.68 [P]; FDA-AP VI.B.1 [P] |
| Decontamination of a product-contact surface (heat-labile items only) | >= 6-log reduction validated | H | FDA-AP IX.C [C] |
| Isolator bio-decontamination validation | normally 4-6 log reduction | validation ref | FDA-AP Appendix 1 [C] |
| CCI of glass ampoules, BFS units, fusion-sealed <= 100 mL | 100% by validated method; visual inspection not a CCI method | H | Annex 1 8.22 [P] |
| APS size | justified in CCS, typically >= 5,000-10,000; batches < 5,000 units: APS >= batch size | H | Annex 1 9.40 [P] |
| APS incubation | 20-35 C, within +/-2.5 C of target, >= 14 days total; two temperatures >= 7 days each, lower first | H (FDA numbers used as enforced default; EU requires justified, validated conditions) | FDA-AP IX.A.8 [C]; Annex 1 9.44 |
| APS media growth promotion | Gram-positive, Gram-negative, yeast, mould at < 100 CFU plus relevant isolates | H | ST-32 [C] |
| EM media incubation (default example) | 30-35 C for 48-72 h (bacteria); 20-25 C for 5-7 days (yeasts/moulds) | V (FDA example) | FDA-AP X.B [C] |
| WFI hot storage/circulation | validated range (example above 70 C) | V | Annex 1 6.10 [C] |
| Biological indicators | a BI pass never overrides a failed physical parameter | H | Annex 1 8.41-8.43 [C] |

### E-6 APS acceptance (line profile)

| Profile | Units filled | 1 contaminated unit | 2 contaminated units | Always |
|---|---|---|---|---|
| **EU** (mandatory when any EU/PIC/S product is qualified on the line) | any | APS failed | APS failed | target zero; production suspended; quarantine after failure; review since last pass; normally >= 3 consecutive successful repeats (Annex 1 9.46) |
| Non-EU (India +/- US) | < 5,000 | investigation, then revalidation (India: no contaminated unit allowed) | – | every positive investigated; intermittent/recurring positives escalate; impact on batches since last pass assessed (FDA-AP IX.A.9; Schedule M Part II 5.6-5.7) |
| Non-EU | 5,000-10,000 | investigation, including whether to repeat | revalidation after investigation | as above |
| Non-EU | > 10,000 | investigation | revalidation after investigation | as above |

### E-7 Time limits

| Rule | Default | Type | Clause |
|---|---|---|---|
| IB-14 mandatory set (13 rules) and additional holds | none shipped; validated value and reference required | V | Annex 1 8.5, 8.18, 8.36 [P]; 21 CFR 211.111 [P] |
| Any routine duration or hold | <= longest value qualified in the latest successful APS | D | Annex 1 9.33, 9.36 [C] |
| Lyophiliser sterilisation -> load | <= longest interval challenged in APS | D | Annex 1 8.122 [P] |
| Settle plate exposure | <= 4 h | H | Table 6 note (a) [P] |
| Liquid sterilising filter continuous use | <= 1 working day unless validated | H | Annex 1 8.94 [P] |
| Late-entry flag | 15 min after the activity | DC | ST-04 |
| Data-feed gap treated as alarm | 5 min | DC | ST-06 |
| Glove sanitisation before glove print | justification if within 5 min | DC | ST-22 |
| APS fill end -> incubation start | 24 h | DC | ST-32 |
| Terminal inactivity lock | 5 min (allowed 1-15 min) | DC | DI-38 |
| Timer pre-warning | when 10% of the limit remains | DC | KB-10 |
| Gown wear time, glove disinfection interval, laundry cycles, clean-up period, disinfectant in-use expiry, stopper-to-crimp, TOR budget | from qualification/validation/stability | V | Annex 1 7.15, 4.29, 4.35, 8.28 [C] |

### E-8 Minimum garments by grade (summary)
- Grade B and any entry into Grade A: dedicated undergarments; sterile headgear enclosing all hair and facial hair; sterile facemask and eye covers covering all facial skin; sterile gloves while donning and a second pair over sleeves; sterilised footwear/over-boots with trousers tucked in; fresh sterilised garments on every entry; maximum wear time from garment qualification.
- Grade C: hair and beard covered; one- or two-piece trouser suit gathered at the wrists with a high neck; disinfected shoes or overshoes.
- Grade D: hair and beard covered; general protective suit; disinfected shoes or overshoes.
- Extra gloves/facemask in C/D where the CCS identifies a contamination-risk activity. Source: Annex 1 7.13-7.15 [C].

### E-9 Minimum grade per operation (resolved default; MBR validator IB-01)

| Operation | Aseptic route | Terminal route | Clause |
|---|---|---|---|
| Cleaning of equipment; handling cleaned components/equipment; assembly of cleaned items under HEPA airflow before sterilisation; assembly of closed sterilised SUS with intrinsic sterile connectors | D | D | Annex 1 Table 4 [P]; Schedule M IN-41 (components after washing >= D) |
| Preparation (incl. sampling and dispensing) of solutions to be sterile-filtered | C (India-only lines: D if closed system, see G.3-21) | – | Annex 1 Table 4 [P]; IN-41 |
| Preparation of components and solutions (terminal) | – | D; C when product supports growth, long hold, or not mainly closed vessels; C for ointments, creams, suspensions, emulsions | Annex 1 8.1 [P] |
| Filling (terminal) | – | C; A with >= C background at unusual risk (slow filling, wide neck, exposure beyond a few seconds) | Annex 1 8.3-8.4 [P] |
| Aseptic assembly of filling equipment; aseptic connections after the final filter (SIP preferred); aseptic compounding/mixing; replenishing sterile bulk, containers, closures; removing/cooling unwrapped items from sterilisers; staging/conveying unwrapped sterile components; aseptic filling, ampoule sealing, vial closure, transfer of open or partly stoppered vials; lyophiliser loading | A (background B; isolator per E-10) | – | Annex 1 Table 4, 8.12-8.14 [P] |
| Protected conveying/staging of items for introduction into Grade A | B | – | Annex 1 Table 4 [P] |
| Non-filterable products: all additions and exposure of sterile materials | A with B background | – | Annex 1 8.11 [P]; IN-41 |
| Transfer of partially stoppered containers to/from lyophiliser | A at all times, or validated closed trays closed in A and not opened in B | – | Annex 1 8.126 [P] |
| Clean-process vial capping | Grade A air supply, background >= D | – | Annex 1 8.27 [P] |
| Manual capping | A (isolator, or A with B background) | – | Annex 1 8.27 [P] |
| FDA support areas | area next to the aseptic line >= ISO 7 in operation; ISO 8 for less critical work (e.g. equipment washing) | – | FDA-AP IV [C] |

### E-10 Minimum background grade by barrier technology

| Technology | Background | Clause |
|---|---|---|
| Open isolator | >= Grade C | Annex 1 4.20 [C] (FDA: commonly ISO 8, never unclassified) |
| Closed isolator | >= Grade D (CCS risk assessment) | Annex 1 4.20 [C] |
| RABS (aseptic) | >= Grade B | Annex 1 4.20 [C] |
| Conventional open Grade A zone | Grade B (CCS justification needed for the line) | Annex 1 4.20, Table 4; ST-74 |
| Aseptic BFS | machine >= Grade C, operators in Grade A/B garments | Annex 1 8.105-8.106 [C] |
| BFS for terminal sterilisation | >= Grade D | Annex 1 8.105 [C] |
| Clean-process capping (Grade A air supply) | >= Grade D | Annex 1 8.27 [P] |

---

## F. Pharmacopoeial references as master data

### F.1 Master-data model (implements IN-33, PR-08)
- Each reference record: compendium (USP-NF / Ph. Eur. / IP / JP), chapter or monograph ID, title, edition and supplement, official date, harmonisation status, verification status (verified against official text / secondary / unverified), the values the eBMR uses, and the MBR limits that cite it (where-used index).
- Every specification and IPC limit in an MBR stores its compendial source and edition. When a new edition is marked effective (e.g. IP 2026 from 1 Jul 2026 [S]), every MBR citing the previous edition is listed and a change-control task opens (IN-33). For multi-market products each limit shows its source and the narrower range is enforced.
- Pharmacopoeial values are **master data, not engine floors**: the engine enforces what the MBR/registration states; only values also required by the control catalogs are floors (Section E).
- Reference standards record their source (IP reference standards from the Indian Pharmacopoeia Commission, IN-33).
- The inputs contain **no IP chapter or appendix numbers** for the tests below; the IP column must be filled from the licensed IP 2026 text by the customer (IN-33 requires the IP reference for Indian compliance). Values marked [R] were taken from research that checked copies of USP (official as of 12 Feb 2025) and Ph. Eur. 11.0; later revisions and the current Ph. Eur. edition were not verified.

### F.2 Tests and chapters that matter for injectables

| Topic | USP | Ph. Eur. | IP | Values/uses in the eBMR | Status | Blocks |
|---|---|---|---|---|---|---|
| Parenteral product quality tests (umbrella) | <1> Injections and implanted drug products | (general monograph for parenteral preparations; number not in inputs) | load from IP 2026 | every container inspected; units with visible particulates rejected; points to <71>, <85>/<151>, <788>, <697>, <1207>, <7> | [R] | IB-23, IB-26 |
| Sterility test | <71> | 2.6.1 (harmonised) | load | Table 3 units per batch size; Table 2 quantity per medium; incubation >= 14 days; invalidation rules (C-26) | [R] | IB-26, IB-27 |
| Bacterial endotoxins | <85>; <86> recombinant reagents (status not verified) | 2.6.14; 2.6.32 rFC (not verified) | load | EL = K/M, MVD (C-15) | [R] | IB-26, IB-27 |
| Pyrogen test | <151> | (not in inputs) | load | alternative where BET unsuitable | [R] | IB-27 |
| Subvisible particulate matter | <788>; <787> therapeutic proteins | 2.9.19 | load | light obscuration: containers <= 100 mL <= 6,000 (>=10 um) and <= 600 (>=25 um) per container; > 100 mL <= 25/mL and <= 3/mL; microscopic <= 3,000 / <= 300 per container and <= 12 / <= 2 per mL | [R] | IB-26 |
| Visible particulates / 100% inspection | <790>; <1790> (guidance chapter) | 2.9.20 | load | 2,000-3,750 lux (clear glass), black and white backgrounds, about 5 s per background; post-inspection sampling Z1.4 GIL II normal single, AQL 0.65% for visible particulates; <1790> class AQL ranges (critical 0.010-0.10%, major 0.10-0.65%, minor 1.0-4.0%), PoD zones, reinspection, supplemental destructive testing | [R] (catalog open question: AQL values secondary) | IB-23 |
| Extractable volume / container content | <697> | 2.9.17 (not verified) | load | each unit delivers at least the labelled volume; basis of fill target (C-05) | [R] | IB-18 |
| Excess volume for injections | <1151> | – | – | recommended excess table (C-05) | [R] translated USP 44 copy only | IB-18 |
| Sterilisation principles and methods | <1211>; <1229>, <1229.1>, <1229.2> (moist heat, aqueous liquids), <1229.4> (sterilising filtration), <1229.5> (BIs), <55> (BIs) | 5.1.1 (methods of preparation of sterile products), 5.1.5 (F0 concept, not verified) | load | SAL <= 10^-6; F0 with z = 10 C (T_ref convention stored); PNSU; one product lot per load (DC); filtration routine records | [R] | IB-08, IB-13, IB-21 |
| Parametric release | <1222> (not verified) | (EU Annex 17 is GMP, not pharmacopoeia; not in inputs) | – | parametric-release gate | unverified | IB-21 |
| Depyrogenation | <1228>, <1228.1> (dry heat), <1228.5> (endotoxin indicators) | 5.1.12 (not verified) | load | FD with T_ref 250 C, z 50 C; confirmation <= 0.1 EU per sample (USP); validation must still show >= 3 log (Annex 1 8.68, FDA-AP VI.B.1) | [R] | IB-08 |
| Container-closure integrity | <1207>, <1207.1>, <1207.2>, <1207.3> | – | load | deterministic vs probabilistic methods; example maximum allowable leakage for rigid containers (< 6 x 10^-6 mbar.L/s helium) | [R] | IB-24 |
| Elastomeric closures | <381>, <382> (official date not verified) | (not in inputs) | load | incoming stopper/plunger specifications, functional suitability | [R] | IB-06, IB-07 |
| Glass containers; packaging and storage | <660>; <659> | (not in inputs) | load | container specifications; storage definitions | [R] | IB-06 |
| Water for pharmaceutical purposes; TOC; conductivity | <1231>; <643>; <645> | WFI monograph (number not in inputs) | load | WFI microbial action level <= 10 CFU/100 mL unless justified; TOC limit response 0.50 mg/L carbon; stage 1 conductivity 1.3 uS/cm at 25 C; WFI endotoxin 0.25 EU/mL not verified | [R] | IB-05 |
| Osmolality; pH | <785>; <791> | (not in inputs) | load | bulk IPC methods | [R] | IB-12 |
| Lipid injectable emulsions | <729> | – | load | intensity-weighted MDD < 500 nm; PFAT5 <= 0.05% | [R] | IB-12 |
| Microbiological control of aseptic environments | <1116> (informational) | – | – | contamination recovery rates for trending (isolator/closed RABS < 0.1%; ISO 5 < 1%; ISO 6 < 3%; ISO 7 < 5%; ISO 8 < 10%) | [R] | IB-04 |
| Labelling of injection closures | <7> | – | – | ferrule/cap: only cautionary statements on the top surface; paralysing-agent warning for neuromuscular blockers; black closures only for Potassium Chloride Injection Concentrate | [R] translated USP 44 copy only | IB-19, KB-17 |
| Pharmacy compounding of sterile preparations | <797> | – | – | **not applicable** to industrial manufacture (21 CFR 210/211 and Annex 1 govern) | [R] | – |

Notes:
- Where a limit exists in both a pharmacopoeia and a GMP text, the GMP text decides the eBMR behaviour (e.g. 3-log depyrogenation from Annex 1 8.68 and FDA-AP VI.B.1 even though USP <1228.1> may accept time-temperature evidence alone, G.3-10).
- Ph. Eur. 5.1.1 statements reported by research (reference steam cycle 121 C for 15 min; minimum temperature 110 C; minimum F0 8 min at the slowest-heating position; dry heat 160 C for 2 h reference; depyrogenation above 220 C) could not be checked against the inputs and are shown only as [R] information in the product master; they are not engine floors (G.3-12).

---

## G. Coverage self-check, conflicts and gaps

### G.1 Unit procedures -> blocks

| UP | Operations built from | Variants |
|---|---|---|
| UP-00 Issuance and pre-start | KB-01, IB-02, IB-05, IB-08 (readiness), IB-15, IB-10, IB-03, IB-04, KB-08 | all (APS/roster gates aseptic only) |
| UP-01 Dispensing | KB-04, KB-05, KB-11, IB-06, IB-09 (V-7 sterile transfer) | all |
| UP-02 Containers | IB-07, IB-08, IB-05, IB-14, IB-06 + IB-09/IB-10 (RTU), IB-25 | V-1..V-7 |
| UP-03 Closures | IB-07, IB-08, IB-06, KB-09, IB-19 (caps) | all except V-2 |
| UP-04 Equipment/barrier/SUS | KB-07, IB-09, IB-08, IB-11, IB-10, IB-20 (lyo SIP), IB-14 | aseptic; TS optional |
| UP-05 Compounding | IB-12, IB-05, KB-05, KB-06, KB-11, KB-14, KB-04, KB-09, IB-26, KB-15, KB-16, IB-14 | all |
| UP-06 Filtration | IB-26, IB-13, KB-03, IB-08, IB-05, IB-14 | aseptic; TS where possible |
| UP-07 Aseptic set-up | IB-03, IB-09, IB-16, IB-04, IB-10, IB-05, IB-18, IB-25, KB-02, IB-15 | aseptic (TS: clean set-up via KB-02/KB-08) |
| UP-08 Filling and closure | IB-17, IB-18, IB-16, IB-04, IB-26, IB-25, IB-05, IB-14 | all |
| UP-09 Lyophilisation | IB-20, IB-14, KB-03, IB-25, IB-26, KB-09 | V-4 |
| UP-10 Capping | IB-19, IB-25, IB-14 | vials |
| UP-11 Terminal sterilisation | IB-21, IB-08, IB-14, IB-26, KB-16, IB-25 | V-5, V-6, V-9 |
| UP-12 Visual inspection | IB-23, IB-25, KB-18 | all |
| UP-13 CCI | IB-24, IB-25 | all (100% or sampled) |
| UP-14 QC/reserve samples | IB-26, KB-09 | all |
| UP-15 Packaging | KB-08, KB-17, IB-18 (device IPC), IB-14 (TOR), IB-25 | all |
| UP-16 Review/disposition | IB-30, IB-27, IB-29, KB-19, KB-13 | all |
| UP-A1/A2 APS incubation and reading | IB-28, IB-25, IB-15 | V-10 |

Every unit operation in A.3 is covered by at least one block.

### G.2 Sterile controls ST-01..ST-79 -> blocks

| ST | Short title | Implemented in |
|---|---|---|
| ST-01 | Regulatory-floor table | IB-01, KB-01, Section E |
| ST-02 | Sterility-assurance route, CCS, master design | IB-01, KB-01, KB-02 |
| ST-03 | Change control drives requalification | IB-02, IB-01 |
| ST-04 | Contemporaneous recording, departures | KB-02, KB-13, KB-01 |
| ST-05 | Calibration at point of use | KB-07, KB-05, IB-18 |
| ST-06 | Alarm/event register, power interruption | IB-05, KB-03 |
| ST-07 | Role and training at every signature | IB-03 |
| ST-08 | Unsupervised Grade A/B access gate | IB-03, IB-11 |
| ST-09 | Disqualification and requalification | IB-03 |
| ST-10 | Access list, health, supervised entry | IB-03 |
| ST-11 | Gowning record, garments, wear time, glove events | IB-03 |
| ST-12 | Headcount and presence log | IB-03, IB-02 |
| ST-13 | Behaviour observation, devices | IB-03, KB-02 |
| ST-14 | Room grade/classification gate | IB-02, IB-01, KB-08 |
| ST-15 | Cleaning and disinfection status | IB-02 |
| ST-16 | Return to service, clean-up period | IB-02 |
| ST-17 | DP, airflow, HEPA | IB-02, IB-29 (HEPA retest) |
| ST-18 | Batch EM plan and coverage | IB-04, IB-01 (hazardous flag) |
| ST-19 | Total particle monitoring | IB-04, KB-03 |
| ST-20 | EM limits, alert levels, trends | IB-04, E-1/E-2 |
| ST-21 | Viable excursion handling | IB-04, IB-29 |
| ST-22 | Personnel monitoring | IB-04, IB-16 |
| ST-23 | EM media GPT and incubation | IB-04 |
| ST-24 | EM/PM completeness at release | IB-04, IB-30 |
| ST-25 | High-risk utility points | IB-05 |
| ST-26 | WFI draw, daily sample, sanitisation hold | IB-05 |
| ST-27 | Pure steam quality | IB-05, IB-08 |
| ST-28 | Gases, POU filters, vent filters, tank pressure | IB-05, IB-13 |
| ST-29 | APS status and gate | IB-15 |
| ST-30 | Manual aseptic per-operator APS | IB-15, IB-03 |
| ST-31 | APS design and envelope | IB-15, IB-28, IB-17 |
| ST-32 | APS execution, accountability, incubation | IB-28, IB-25 |
| ST-33 | APS failure consequences | IB-15, IB-28, IB-29 |
| ST-34 | Intervention catalogue | IB-16 |
| ST-35 | Intervention/stoppage log, line clearance | IB-16, IB-25 |
| ST-36 | Unqualified interventions, frequency exceedance | IB-16, IB-29 |
| ST-37 | Time-limit rule engine | IB-14, KB-10, IB-01 |
| ST-38 | Equipment status/hold chain, re-sterilisation | KB-07, IB-14 |
| ST-39 | Component release incl. micro/endotoxin | IB-06, KB-05 |
| ST-40 | Sterile components, contract sterilisers, sterile additions | IB-06, IB-12, IB-01, KB-12 |
| ST-41 | Container/closure preparation and hold | IB-07, IB-14 |
| ST-42 | Product-contact parts, aseptic assembly/connections | IB-09, IB-01 |
| ST-43 | Steriliser readiness, recipes, load patterns | IB-08 |
| ST-44 | Automated cycle acceptance, quarantine | IB-08, KB-03 |
| ST-45 | Sterile-state tracking | IB-08, IB-09 |
| ST-46 | Transfer into Grade A/B | IB-09 |
| ST-47 | Dry heat tunnels/ovens | IB-08, IB-07 |
| ST-48 | SIP and post-SIP integrity | IB-08 |
| ST-49 | Radiation, EO, UV exclusion | IB-06, IB-01 |
| ST-50 | Registered sterilising filter | IB-13, IB-01 |
| ST-51 | Filter train and routine parameters | IB-13 |
| ST-52 | PUPSIT, post-use, redundant/serial | IB-13 |
| ST-53 | Single-batch use, duration, vent lifecycle | IB-13 |
| ST-54 | Pre-sterilisation bioburden | IB-26, IB-13, IB-21 |
| ST-55 | Open-container routing, closure method | IB-17, IB-09, IB-01 |
| ST-56 | Fill weight/volume and device IPC | IB-18, IB-17 |
| ST-57 | Stoppering/capping, stopper-to-crimp | IB-19, IB-14 |
| ST-58 | Lyophiliser readiness | IB-20 |
| ST-59 | Lyo transfer/loading/unloading, cycle record | IB-20, IB-14 |
| ST-60 | TS grades, prep-to-sterilisation time | IB-21, IB-01, IB-12 |
| ST-61 | TS loads, non-rigid containers, parametric release | IB-21, KB-16 |
| ST-62 | 100% inspection | IB-23, IB-25 |
| ST-63 | AQL, critical defects, trending | IB-23, KB-18 |
| ST-64 | Container-closure integrity | IB-24, IB-01, IB-17, IB-22 |
| ST-65 | Sterility/endotoxin per batch, method suitability | IB-27, IB-26 |
| ST-66 | Sterility sampling plan | IB-26, IB-16, IB-20, IB-21 |
| ST-67 | Sterility positive handling | IB-27, IB-29 |
| ST-68 | Pass never overrides process failure | IB-27, IB-30 |
| ST-69 | Short shelf life / conditional release | IB-27 |
| ST-70 | Review dossier, timeline | IB-30, KB-19 |
| ST-71 | Release gate: deviations, yield, storage | IB-30, KB-13, KB-15, IB-25, IB-29 |
| ST-72 | Cycle roll-up at release | IB-30, IB-08 |
| ST-73 | Structured data for PQR/CCS review | IB-30 |
| ST-74 | Barrier profile, background, isolator pressure, transfers | IB-10, IB-02, IB-01 |
| ST-75 | Glove/sleeve/enclosure integrity | IB-10 |
| ST-76 | Bio-decontamination, validity, breach | IB-10 |
| ST-77 | BFS | IB-22, IB-16 |
| ST-78 | FFS | IB-22 |
| ST-79 | Closed systems and SUS | IB-11 |

**Result: all 79 ST controls are implemented by at least one block. No ST control is left without a block.** Parts of ST controls that are facility or qualification items are consumed as status only (e.g. ST-14 facility systems under 211.42(c)(10), counter tubing length, crimper extraction design), consistent with the catalog's "not an eBMR concern" list.

India injectables controls:

| IN | Implemented in |
|---|---|
| IN-40 Grades, particle limits, airflow, clean-up | IB-02, IB-04, E-1, E-3 |
| IN-41 Minimum grade per operation | IB-01, IB-12, E-9 |
| IN-42 EM in batch record, microbial limits | IB-04, IB-30, E-2 |
| IN-43 HEPA leak-test interval | IB-02, E-4 |
| IN-44 Sanitation, disinfectants, water monitoring | IB-02, IB-05 |
| IN-45 APS envelope and acceptance | IB-15, IB-28, E-6 |
| IN-46 Time limits, bioburden, endotoxin, gas filters, LVP endotoxin | IB-14, IB-26, IB-12, IB-01, IB-21 |
| IN-47 Sterilisation records and revalidation | IB-08, IB-21, E-4 |
| IN-48 Sterile filtration | IB-13, E-5 |
| IN-49 Sterility sampling and release review | IB-26, IB-16, IB-27, IB-30 |
| IN-50 Capping, vacuum-sealed, 100% inspection | IB-19, IB-24, IB-23 |
| IN-51 Part XIII areas and equipment classes | IB-01, IB-05, IB-24 |

Kernel controls used by blocks: IN-03, IN-04, IN-05, IN-06, IN-07, IN-13, IN-14, IN-15, IN-16, IN-17, IN-18, IN-19, IN-20, IN-21, IN-22, IN-23, IN-24, IN-25, IN-26, IN-27, IN-30, IN-31, IN-32, IN-33, IN-52; PR-01..PR-40, PR-42..PR-58 through KB-01..KB-19 (PR-41 OTC tamper-evident packaging does not apply to injectables; PR-59 retention and PR-60 draft-text readiness are platform functions, not blocks); DI controls are platform-wide (B.0) with DI-02, DI-10, DI-17, DI-21, DI-24..DI-39, DI-41, DI-42, DI-49 cited by specific blocks. IN-01, IN-02, IN-08..IN-12, IN-28, IN-29 are platform/QMS functions outside the block catalog.

### G.3 Conflicts found (inputs vs catalogs/official texts) and resolution

1. **Grade A-D >=5 um limits.** Sterile catalog ST-19 and research list EU Table 5 values (A 29; B 2,930 in operation; C 2,930/29,300; D 29,300). India Table 1 (IN-40) is lower (A 20; B 2,900; C 2,900/29,000; D 29,000). India always applies -> India values are the resolved monitoring limits for every profile (E-1). Research UO2/UO9 quoting 29/m3 for Grade A is superseded. India table cells were reassembled from a scrambled copy (IN F-6): confirm.
2. **Grade A >=5 um for classification.** EU Table 1 "not specified" vs India 20/m3 -> India value applied to classification acceptance.
3. **Heat-sterilisation revalidation scope.** ST-43/Annex 1 8.39: annual for worst-case patterns, others per CCS; India IN-47: every process at least yearly -> 12 months for every heat process (E-4).
4. **Pre-use filter integrity test on non-EU lines.** ST-52 makes the pre-use test CONFIGURABLE (default on) for US-only profiles; India IN-48 requires a pre-use test always. Because India is always in the set, the pre-use test can never be switched off; the post-sterilisation timing (PUPSIT) is mandatory whenever EU is in the set.
5. **Sterility pull after interruptions.** Annex 1 10.6 ("considered based on risk") and ST-66 (risk rule) vs India IN-49 (mandatory after every significant interruption) -> mandatory pull after a significant stoppage (IB-16, IB-26).
6. **APS acceptance profile naming.** ST-33 describes a "US-only line" profile, but India is always present; the non-EU profile is India +/- US. India's tier for < 5,000 units (no contaminated unit) and FDA's (one positive -> revalidation after investigation) lead to the same outcome (E-6).
7. **Reserve-sample quantity.** Research and 21 CFR 211.170(b) exclude sterility/pyrogen tests from the doubling; India IN-32 (secondary basis) includes them -> doubling includes sterility (IB-26, C-11); confirm Drugs Rules text (IN G-1).
8. **Reserve-sample retention.** India expiry + 3 months [S] vs US/EU expiry + 1 year -> maximum over markets.
9. **Processing-room clearance citation.** Research UO0 cites 21 CFR 211.130(e) for room/line clearance before processing; 211.130(e) concerns packaging and labelling facilities. Kernel basis is 211.67(b)(6), EU 5.40 and 4.18(c) (PR-26); corrected in KB-08.
10. **Depyrogenation framed as an EU/US difference.** Research contrasts Annex 1 8.68 (3-log) with USP <1228.1> (time-temperature evidence may suffice). FDA-AP VI.B.1 itself expects validation data showing at least 99.9% (3 log) endotoxin reduction [P], so there is no EU/FDA conflict; USP is the outlier. 3-log is a floor for all profiles (E-5).
11. **"Single product lot and container size per load" attributed to Annex 1 8.38.** 8.38 requires validated load patterns with periodic revalidation and min/max loads [P]; it does not state a single-lot rule. Kept only as a DESIGN-CHOICE default citing USP <1229.2> [R] (IB-21).
12. **Ph. Eur. 5.1.1 numbers (minimum F0 8 min; minimum temperature 110 C).** Not verifiable in the inputs; the Annex 1 glossary cites F0 >= 8 min only as an example within the post-aseptic heat-treatment definition [P]. Not shipped as a floor; used for the IB-01 route-review design choice.
13. **Parametric-release CPG number.** ST-61 cites CPG 490.200; research cites CPG 460.800. Neither document is in the inputs; unresolved, must be verified before the parametric path is validated.
14. **Line-clearance verifier.** `_blocks-both.json` makes second-person verification ENFORCED; PR-34/production C-4 say it is required only when the site designates clearance a significant step -> CONFIGURABLE, default ON (KB-08).
15. **Destruction witness.** `_blocks-both.json` ENFORCED vs PR-40/production C-23 (not required by text) -> DESIGN-CHOICE, default ON (KB-17, KB-18).
16. **Time-limit breach behaviour.** `_blocks-injectables.json` lets the MBR choose block vs exception-only for sterile limits; ST-37 ENFORCES blocking for the mandatory set -> blocking fixed for the IB-14 mandatory set, configurable only for additional timers.
17. **FDA-flavoured defaults in `_sterile-blocks-and-limits.json`.** Its zone register uses "limit profile: FDA default" and "isolator background typically ISO 8"; the catalogs ship India + EU + US and EU background floors (open isolator >= C) -> catalogs win (E-10).
18. **Filter reuse.** FDA-derived block allows reuse up to the validated number of lots; EU 8.94 limits a liquid filter to one batch; India limits continuous use to one working day unless validated -> reuse only on lines with no EU product, with validation, and still within the working-day rule unless extended use is validated (IB-13).
19. **Bulk yield outside limits.** Research says "investigation before proceeding"; production catalog C-24 says a hard stop is not required -> DESIGN-CHOICE deviation-gate before sterilising filtration (default on), release block ENFORCED (D.3).
20. **CCI equipment class.** IN-51 says leak-test steps may only reference the pressure-leak-tester class (Part XIII list, fragmentary per IN F-11), while Annex 1 8.22-8.23 require validated methods and research lists deterministic methods (vacuum decay, HVLD, laser headspace, helium). Resolution: IN-51 classes are shipped defaults and validated CCI method classes are added; confirm with Indian QA/regulatory (IB-24).
21. **Preparation of solutions to be filtered in a closed system.** IN-41 allows Grade D if closed; Annex 1 Table 4 lists Grade C [P] -> Grade C whenever EU is in the set; Grade D configurable only on India-only lines with closed-system evidence (E-9).
22. **AQL 0.65% for visible particulates.** Sterile catalog open question 4 says the value appears only in secondary sources; research reports it verified against a USP <790> copy. Shipped as pharmacopoeial master data [R], not as a floor; customer QA sets the plan (IB-23).
23. **UDAF velocity basis.** EU guidance range 0.36-0.54 m/s at the working position, FDA 0.45 m/s +/- 20% measured about 15 cm below the filter face, India hard minimum 0.36 m/s at working level -> range as guidance, lower bound 0.36 m/s hard (E-3).
24. **Tunnel HEPA test "at least biannually".** Ambiguous in Annex 1 8.67 [P]; FDA-AP says twice a year -> 6 months (catalog resolution retained).
25. **Illustrative numbers in research** (dispensing tolerances, 15-30 min fill checks, 8-12 h / 24 h compounding limits, 24-72 h depyrogenated-vial hold, 72 h-7 day wrapped-part hold, H2O2 residual 1 ppm, headspace O2 2-5%, DO 1-2 mg/L, osmolality 270-330 mOsm/kg, assay 98-102%, pre-filtration bioburden 10 CFU/100 mL, false-reject 5%): none is in the primary texts or catalogs -> not shipped as defaults; each is product/site-validated (E-7).
26. **Research "Sampling statistics: USP plan detects 10% contamination about nine times in ten" vs catalog "0.1% contamination passes about 98% of the time".** Both statements are in FDA-AP XI.B [P]; no conflict.

### G.4 Gaps and open items
1. **Continuous particle evaluation window.** Neither text defines the volume over which a continuous count is compared with a per-m3 limit; one >=5 um count in a one-minute, 28.3 L sample already exceeds 20 and 29 per m3. Engine default (C-21) annotates isolated single counts per Annex 1 Table 5 note 2 and escalates recurrences; customer QA must approve the rule, especially against the stricter India values.
2. **Unverified pharmacopoeial content:** USP <71>, <85>, <697>, <729>, <788>, <790>, <1151>, <1207>, <1228.1>, <1229.2>, <1231>, <7>; Ph. Eur. 2.6.1, 2.9.17, 2.9.19, 2.9.20, 5.1.1, 5.1.5, 5.1.12; post-Feb-2025 USP revisions; IP chapter numbers and IP 2026 content (not in inputs).
3. **Parametric release:** EU Annex 17, FDA 2010 guidance and the CPG are not in the inputs (IB-21 path must be verified before validation).
4. **Lyophilisation cycle-record content** relies on the FDA 1993 lyo inspection guide (not in inputs).
5. **Combination products (PFS/autoinjectors):** 21 CFR Part 4 / device-record cross-references not verified (IB-18, KB-17).
6. **Site values without a regulatory number:** APS grace period (default none), inactivity trigger, gown wear time, laundry cycles, glove-disinfection interval, clean-up period, disinfectant rotation, door-open time, AQL plan, reject-rate limits, crimp/RSF limits, headspace O2/DO limits, lyo leak-rate maximum, TOR budgets, unit-count tolerance, all IB-14 time limits.
7. **F0 reference-temperature convention** (121.0 vs 121.1 C) must be chosen per site and matched to validation.
8. **India Schedule M gaps** carried over: Part II sections 7-9 (gowning/premises) not matched to Indian text (IN F-5), so IB-03 uses EU/FDA rules; Part II 10.1-10.2 CCI not found (IN F-7); Tables 1 and 3 reassembled (IN F-6).
9. **EMA sterilisation guideline (2019)** expectations (pre-filtration bioburden, decision trees) not verified.
10. **Endotoxin body-weight convention** (70 kg) not verified.
11. **Not specified in this catalog:** sterile powder filling; cell-therapy module (ST-69 optional); radiopharmaceutical specifics beyond the hazardous-product EM switch.
12. **Stopper-to-crimp measurement basis** (per tray, per time block or per unit) is a design choice pending customer confirmation.
13. **Graph projection for impact analysis** (IB-29): if it drives automatic quarantine it must be validated and reconciled against the system of record.

### G.5 Summary
- Blocks: 49 (19 kernel KB + 30 injectables IB).
- Variants: 10 (V-1..V-10) over 17 unit-procedure templates plus 2 APS-only UPs.
- ST controls without a block: none. India injectables controls IN-40..IN-51: all mapped.
- Conflicts recorded: 24 (G.3-1..G.3-24), 23 resolved and 1 unresolved (parametric-release CPG number, G.3-13); plus 2 notes (G.3-25 illustrative research values not shipped; G.3-26 checked, no conflict).
- Open gaps: 13 (G.4).
