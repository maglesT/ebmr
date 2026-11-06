# Batchwright Injectables: edition plan (v2)

- **Status:** approved (v2) by the owner and the lead, 4 November 2026. I-0 starts once Tablets PR #100 has merged and the lead confirms the window.
- **Owner decision (4 November 2026):** Injectables is the second edition of Batchwright, on the same kernel, dynamic
  library (decision 0026), e-signatures, audit trail, MBR approval, release, deviations, terminals and platform sign-on.
  Full scope, nothing left out; **each item built at the minimum**: only binding clauses, and no new code where a
  library block made of existing field types does the job.
- **v2 (same day, owner reminder through the lead):** every item now states *binding clause → smallest means → why
  nothing smaller*. v1's eight sterile modules and the new `DEVICE_RECORD` field type are gone: each was replaced by a
  block, a qualification record, an equipment due date or the existing release gate.
- **Lead review (4 November):** **v2 chosen** (data only, edition setting plus own database). The lead's answers on v1's
  host packages, `DEVICE_RECORD` and modules are void; the rest stands (section 9). I-0 makes the edition setting
  neutral, adds the `ebmr_injectables` database and amends ADR 0001. The Tablets freeze window covers only the
  edition-setting change. The owner answered Q0, Q1 and Q6 the same day.
- **Read with:** ADR 0001, decisions 0010, 0011, 0026, outline 2.3, `docs/handbook/modules/injectables.md`,
  `compliance/controls/ST-01..79` and `IN-40..51`, `compliance/rule-tables/sterile/sterile.v1.yaml`.

## 1. The rule applied to every item

1. Find the binding clause (Revised Schedule M, 21 CFR 211 / Part 11, EU GMP Annex 1 / Annex 11 for EU-market
   batches). Cited from the requirement register (`compliance/requirements/requirements.jsonl`, rows marked
   `verified: primary`, i.e. checked against the official text); each slice re-checks its own clauses against the
   official text before coding and lists them in its notes. Guidance (FDA 2004 aseptic guidance, PDA reports, ISO
   standards, PIC/S aide-memoires, WHO texts not adopted by Schedule M) is never a reason to build.
2. Meet it with the smallest means, in this order: **(a)** a library block (data) of existing field types; **(b)**
   master data the kernel already has (qualification register, area authorisation, equipment calibration and
   qualification due dates, room classes); **(c)** the existing release gate (every block complete, every exception
   and deviation closed, every release-test result in); **(d)** only then a small shared change, sent to the lead,
   naming the clause it serves.
3. Say why the next smaller means fails.

See Q0 before approving: what "binding" means for Annex 1 and Schedule M decides how much of the table stays.

## 2. Architecture: the edition is data plus configuration

> **Platform fit (4 November, confirmed by the lead; ADR 0001 amended):** on the MEDHANTA platform one product has one database, so `platform-fit.md` replaces the own-database and `EDITION` deployment rows below with "same `ebmr` database, edition as data on the MBR family and the library". The rows below on the database, the server and the library read accordingly. The recipe-core migration for the edition column is 1871; any `inj.*` tables take 3000-3999.

With every item met by data, the edition has **no sterile code**. So:

| Part | How |
|---|---|
| Database | `ebmr_injectables`: the same kernel and recipe migrations as Tablets, no extra schema (ADR 0001 separate databases kept) |
| Site data | the shared `ebmr_site`: one person record, one lot status, one batch-number register across editions |
| Server and web | the existing applications started with `EDITION=injectables`: they connect to `ebmr_injectables`, show the INJECTABLES badge (decision 0020), and scope the market engine to the `kernel` + `sterile` rule tables (`EBMR-MKT-054` already keeps them apart). I-0 finds the places that hard-code `tablets` and reads the edition instead. |
| Library | the sterile blocks of section 4 are seed data stored in `ebmr_injectables` and approved there by QA; the palette shows only the edition's library because the database holds only it |
| Platform | the same product `ebmr`; new `ebmr.*` permission codes only if a sterile act needs one (none foreseen; see Q3) |

**Why not smaller:** none is smaller; this is configuration. **Why not v1's shared-host extraction:** it moved about
100k lines to keep sterile code out of the Tablets build, but there is no sterile code any more. It needs an ADR 0001
amendment (point 1, "own server application") recorded by the lead, and the Tablets session told, since it touches
their app's configuration.

If a later slice finds an item that truly needs sterile code, it stops and comes back to the lead with the clause; the
host extraction is the fallback then, not now.

## 3. Shared changes (candidates; each confirmed or dropped in I-0)

| Change | Clause it serves | Why nothing smaller | Status |
|---|---|---|---|
| Edition read from configuration instead of hard-coded `tablets` | none (product structure; owner decision) | cannot run a second edition otherwise | needed |
| A repeat kind "add a row when it happens" (interventions, stoppages, glove changes) | 211.100(b) (deviations recorded and justified); Annex 1 8.16, 9.34 (EU) | the four repeat kinds (count, per container, per interval, until pass) all fix the rows in advance; an event log cannot | needed unless I-0 finds an existing exception/comment log on the step that records time, person and description |
| A NUMBER field taking its value from a device original (filled, then confirmed by the operator) | none: 211.68(b) is met by typing from the printout with a second-person check | owner's scope item "equipment data via the existing gateway"; built last (I-5), smallest form | parked (lead, Q2): values typed from the attached printout, second-person check |

No new field type. expr already has `duration` (time limits), `table_lookup` (AQL tables as validated master data),
`volume_from_mass` and `mass_from_volume` (fill volume), `accountability` and `yield`. F0 is taken from the steriliser's
record as a NUMBER with its limit; recomputing it from the temperature series is not required by any binding clause.

## 4. Items: clause → smallest means → why nothing smaller

Codes: SM = Revised Schedule M (G.S.R. 922(E), 28 Dec 2023), Part II unless marked; A1 = EU GMP Annex 1 (2022), EU-market
batches only; 211 = 21 CFR 211, US-market batches. Field types: NUM, TXT, Y/N, CHOICE, DT, TIMER, WEIGH, LOT, EQUIP,
CONT, SAMPLE, TEST, CALC, SIGN. "Gate" = the existing release gate. "Qualif." = a qualification type in the kernel
register (`iam.qualification_type`), checked at signature by role or by area authorisation (`iam.area_authorisation_problem`, kernel 1190).

### 4.1 Readiness (every route)

| Item | Binding clause | Smallest means | Why nothing smaller |
|---|---|---|---|
| Operation in the right grade | SM 4.11, 4.11.1-4.11.2; SM Part XIII item 11; 211.42(c)(10); A1 4.2-4.4, 8.1-8.5 (terminally sterilised) | room classes per grade (master data); the block's EQUIP field for the room takes the class the formulation sets | a Y/N "room is Grade A" lets the wrong room pass unrecorded; the class filter costs nothing |
| Room classified and requalified | SM 4.5, 4.6; A1 4.23-4.26, 4.32 | requalification as the room's qualification due date; EQUIP refuses a room past it | as above; the due date already exists for equipment |
| Room cleaned and disinfected | SM 3.1-3.4; 211.56(b); A1 4.33-4.36 | INJ-01 line clearance: EQUIP (room clean status), LOT (disinfectant lot), TIMER (contact time), SIGN | the record must name agent, lot and contact time; nothing smaller records them |
| Only authorised, qualified people in A/B (gowning, aseptic training, APS taken part in) | SM 5.3-5.7 (media fills by operators); 211.25(a), 211.28(c); A1 7.4-7.7 | Qualif. types GOWNING.<grade> and APS.<line>, each with valid-to; the area authorisation of the A/B rooms requires them | the kernel already blocks a signature in a controlled area without a valid authorisation; no new check |
| Visual inspectors' eyesight | SM Part I 11.5.1 | Qualif. EYESIGHT with valid-to, required by the inspector role | as above |
| Equipment calibrated, qualified, clean | 211.63, 211.67, 211.68; SM Part I; A1 5.1-5.9 | the existing EQUIP checks | existing |

### 4.2 Preparation

| Item | Binding clause | Smallest means | Why nothing smaller |
|---|---|---|---|
| Components and RTU tubs accepted (incl. bioburden or endotoxin where specified) | 211.84(d), 211.94(c)-(d); A1 2.1(iv), 10.2 | INJ-02: LOT (status released, which already carries the QC result) | lot status already holds QC's decision |
| Supplier-sterilised components (gamma, e-beam, EtO) | 211.94(c); A1 8.72-8.78 (radiation, EtO) | INJ-03: LOT + TXT (certificate, dose or cycle reference) + Y/N (indicator changed) | the certificate reference must be in the record |
| Container washing, siliconisation | 211.94(c) ("cleaned and, where indicated, sterilized and processed to remove pyrogenic properties"); A1 8.18(i)-(ii) | INJ-04: EQUIP, NUM (WFI temperature, pressure), TIMER, SIGN | parameters with limits need NUM |
| Depyrogenation (tunnel, oven) | 211.94(c); 211.113(b); A1 8.66-8.70 | INJ-05: EQUIP, TXT (cycle number), NUM (temperature, belt speed or time, from the printout), Y/N (cycle passed), SIGN performed + CHECKED | the cycle parameters must be recorded against their limits; second-person check meets 211.68(b) for a typed printout |
| Moist heat of parts and components | 211.113(b); SM 6.3-6.11.1; A1 8.41-8.59 | INJ-06: as INJ-05 + CHOICE (load pattern from the formulation's validated list) + NUM (F0 or hold time) | as above |
| Sterilisation in place | 211.113(b); A1 8.63 | INJ-07: as INJ-05 | as above |
| Aseptic assembly, connections, transfer into A/B | 211.113(b); A1 8.12-8.14, 8.47-8.49 | INJ-08: Y/N (each connection made under Grade A), SIGN | the record needs who and that it was done |
| Bio-decontamination (VHP) of isolator | 211.113(b); A1 4.22 | INJ-09: as INJ-05 + DT (validity end, CALC) | as above |
| Glove and sleeve integrity | A1 4.21 | INJ-10: per glove port (COUNT repeat): Y/N result, TXT tester ID, SIGN | per-port result is what the clause asks |
| Single-use and closed systems | A1 8.127-8.139 | INJ-11: LOT (assembly), Y/N (integrity check before use), SIGN | as above |

Component acceptance (211.84) is incoming QC's lot release, enforced at use by the lot's released status; each component lot is named where it is used (washing, the stopper load, capping) for 211.188(b) traceability, and INJ-COMPONENT-ACCEPT was dropped (lead, 6 November 2026). Known gap: those lot fields do not check that the lot is the right component (the material match needs a formula line), so the second person's VERIFIED signature on each of those steps covers it.

### 4.3 Processing

| Item | Binding clause | Smallest means | Why nothing smaller |
|---|---|---|---|
| Solution preparation and compounding | 211.101, 211.103, 211.111; SM 5.12-5.17 | INJ-12: WEIGH, EQUIP (vessel; WFI point of use as equipment), NUM (WFI volume, temperature), TIMER (mixing), TEST (pH, density), CALC (volume make-up), Y/N (nitrogen overlay where the product needs it) | existing tablet patterns; nothing new |
| Time limits (preparation to filtration, filtration to fill end, sterilisation to use, fill duration) | 211.111; SM 5.12-5.17, 4.11; A1 8.18 | the master's time constraints between steps (HOLD, PROCESS_WINDOW, USE_BY: a maximum with its source, on trusted time from the steps' own events). *Changed in I-1 (lead, 5 Nov 2026):* replaces "DT in the earlier block, read through STEP_VALUE; CALC `duration`", which the library runtime cannot evaluate (no instant value) and which would rest on typed times | a TIMER cannot span blocks; the time constraint already does, on trusted time |
| Pre-filtration bioburden | 211.110(a), 211.113(b); SM 5.12-5.17; A1 8.93 | INJ-12 SAMPLE + INJ-26 TEST (result before release) + gate | the result arrives after filling; the gate already waits for release tests |
| Bulk hold, bioburden-reducing filtration (terminally sterilised products) | 211.111; A1 8.36 | INJ-14: EQUIP (filter), DT, CALC (hold time) | as above |
| Sterilising filtration, filter integrity pre- and post-use, PUPSIT where required | 211.113(b); SM 6.11.2; A1 8.79-8.95 (8.87 PUPSIT) | INJ-13: LOT (filter, its type checked against the formulation's registered filter by CHOICE "not allowed" values), NUM (integrity results: bubble point or diffusion, with limits) in sections "pre-use", "post-sterilisation pre-use" (shown only when the formulation says PUPSIT), "post-use"; NUM (pressure, time), SIGN | conditional section covers PUPSIT; nothing smaller records three tests with limits |
| Homogenisation of non-filterable bulk (suspensions, emulsions, liposomes) | 211.113(b); A1 8.7-8.9 (aseptic preparation) | INJ-16: EQUIP, NUM (speed), TIMER, TEST (particle size) | as INJ-12 |
| Filling (vial, ampoule, syringe, cartridge, bottle; liquid or powder) | 211.100, 211.110(a); A1 8.20-8.21 | INJ-15: EQUIP (line, room), CHOICE (format from the formulation), NUM per interval (fill weight; CALC volume by `volume_from_mass`), CONT (output trays), events repeat (section 3) for interventions and stoppages | per-interval NUM covers IPC; events need the one shared change |
| Fill weight or volume, device function tests (syringe glide, break-loose) | 211.110(a); A1 8.101, 8.115 | INJ-18: TEST per interval (n replicates, mean and individual limits) | existing TEST |
| Interventions | 211.100(b); A1 8.16, 9.34 | events repeat in INJ-15: CHOICE (catalogue of the formulation, with "unlisted" raising an exception), TXT, DT, SIGN | an exception on "unlisted" reaches the gate as it is; no catalogue engine needed |
| Stoppering, stopper height | A1 8.26-8.29 | INJ-15 Y/N (stopper-height check active) + NUM (rejects) | |
| Ampoule fusion sealing | A1 8.22; SM 10.3-10.8 | INJ-19: EQUIP, NUM (flame settings), Y/N | |
| Capping and crimping | SM 10.3-10.8; A1 8.26-8.29 | INJ-20: EQUIP, NUM (rejects), DT (stopper-to-crimp time; CALC with max where the formulation sets one) | |
| Lyophilisation (loading, cycle, unloading) | 211.113(b); A1 8.121-8.126 | INJ-17: EQUIP (lyophiliser; its sterilisation and leak-test due dates as equipment due dates), DT loading start and end, TXT (cycle number), NUM (shelf temperatures, pressures, phase durations from the cycle printout), SIGN + CHECKED | as INJ-05 |
| Terminal sterilisation, moist heat (F0), loads as sub-batches | 211.113(b), 211.167(a); SM 6.3-6.11.1; A1 8.1-8.5, 8.41-8.65 | INJ-21: PER_CONTAINER repeat over loads (each load a container of the batch): EQUIP (steriliser), CHOICE (load pattern), TXT (cycle), NUM (F0, temperature, time), Y/N (indicator), SIGN + CHECKED | loads as containers give per-load genealogy for free |
| Terminal radiation of product | 211.113(b); A1 8.72-8.75 | INJ-21 variant: TXT (certificate), NUM (min and max dose), Y/N (dosimeters read) | |
| Post-aseptic heat treatment | 211.113(b); A1 8.1 | INJ-21 used after INJ-15 | no extra block |
| Parametric release | A1 8.54, 10.4 (refer to Annex 17) | not built until Annex 17 is checked (Q5); sterility test stays in the formulation | building it unchecked would be guidance dressed as law |
| BFS run | A1 8.105-8.120; SM Part XIII (FFS section) | INJ-30: EQUIP, NUM (parison and mould temperatures, fill volume per interval), events repeat | |
| FFS bags and bottles (LVP), overwrap | A1 8.96-8.104; SM Part XIII | INJ-29: as INJ-30 | |
| RTU nested syringes, cartridges and vials: tub entry | A1 8.47-8.49 (transfers) | INJ-27: LOT (tub lot), CHOICE (transfer method: e-beam, wipe, VHP pass box), Y/N, SIGN | |
| Plunger and middle stopper (PFS, cartridge, dual-chamber) | 211.100; A1 8.26 | INJ-28: EQUIP, TEST (position per interval) | |
| Dual-chamber | as above | INJ-15 twice (diluent, drug), INJ-17 in-device lyo, INJ-28 | no extra block |
| Sterile powder filling | 211.113(b); A1 8.7-8.21 | INJ-31: WEIGH (powder lots), INJ-15 in powder format, INJ-18 fill weight | |

### 4.4 Contamination control

| Item | Binding clause | Smallest means | Why nothing smaller |
|---|---|---|---|
| EM during the batch (viable air, surfaces, personnel; particles incl. Grade A) | SM 4.7-4.10 with Table 3, 4.8 (EM considered in batch release review); 211.42(c)(10)(iv); A1 9.1-9.31 | INJ-32 EM block: section per location (COUNT repeat from the formulation's sampling plan): SAMPLE, DT, TEST (CFU, entered by QC after incubation; alert and action limits from the formulation, which takes them from the sterile rule table), NUM (particle counts per size, from the counter report; continuous Grade A as the window's maximum) | the gate already waits for every block; a result over the action limit raises an exception and a deviation through the existing limit tiers |
| Routine EM outside batch windows (Grade C/D, at rest) | SM 4.7; A1 9.4-9.8 | a non-product record: formulation "EM routine" built from INJ-32, run as a record with no product (as APS below) | same blocks, no batch link needed: a routine excursion is a site deviation, raised by the existing deviation screen |
| Media fill (APS) | SM 5.3-5.7; 211.113(b); A1 9.32-9.49 | a media-fill formulation: INJ-12 (media), INJ-15 in APS mode, INJ-24 unit accountability, INJ-26 incubation and reading (TEST: contaminated units, limit 0); QA accepts. QA then extends Qualif. APS.<line> for the people and the line's qualification due date (equipment) with the existing screens | the line and people gates then work through existing due dates; no APS status engine |
| WFI and clean steam results | SM 5.9; A1 6.7-6.17 | QC results on the point of use (equipment) feed its status; EQUIP refuses a point of use out of service | existing |
| Disinfectants, sporicide rotation | SM 3.1-3.4 | INJ-01 LOT of the agent | |

### 4.5 Inspection, testing and release

| Item | Binding clause | Smallest means | Why nothing smaller |
|---|---|---|---|
| 100 % visual inspection: manual, semi-automatic, automated | SM 10.3-10.8, Part I 11.5.1; A1 8.30-8.33 | INJ-22: CHOICE (mode), SIGN (inspector; EYESIGHT and inspection qualif.), NUM per defect category (rejects), CALC (reject rate with alert limit), automated mode: TXT (machine run), NUM (counts from its report) | per-category counts are what the clause asks |
| AQL of accepted units | A1 8.33 | INJ-22 section: SAMPLE (size by `table_lookup` on the AQL table as validated master data), NUM (defects found), CALC (accept or reject number) | existing `table_lookup` |
| Container closure integrity (100 % for fusion-sealed; sampled otherwise; deterministic or dye methods) | SM 10.3-10.8 (vacuum-sealed containers); A1 8.22-8.25 | INJ-23: CHOICE (method), NUM (units tested, failures), Y/N | |
| Unit accountability | 211.188(b), 211.192; SM 10.3-10.8; A1 9.41 (APS) | INJ-24: CALC `accountability` (filled = inspected + rejects + samples + losses), limit 0 unexplained | existing |
| Sterility sampling (start, middle, end, after interventions, per load) | 211.165(a), 211.167(a); SM 2.1-2.3; A1 10.6 | INJ-25: SAMPLE per point; per-load samples in the INJ-21 repeat | |
| Sterility, endotoxin (BET), particulate matter, other release tests; rapid microbial methods | 211.165, 211.167(a); SM 2.1-2.4; A1 10.1-10.11 | INJ-26: TEST (QC roles), CHOICE (method incl. a validated RMM); gate waits for them | existing release-test blocks pattern |
| Sterility pass never overrides a process failure | A1 2.2, 2.7, 10.5; 211.192 | the gate refuses release while any exception or deviation of the batch is open | existing |
| Short-shelf-life conditional release | A1 10.7, 10.10 | not built (Q8): neither Schedule M nor 211 allows release before results; EU-only and optional | |
| Labelling and packaging | 211.122-211.137; SM Part I | the existing generic packaging library blocks | existing |
| Penicillin / beta-lactam and cytotoxic segregation | 211.42(d), 211.46(d); SM Part I; EU GMP Part I 3.6 | the existing plant rules (recipe-core 0890, 0912, 0973, 1655) in the injectables database, unchanged | existing |

### 4.6 Equipment data

Owner scope item, not required by a binding clause (211.68(b) is met by typed values with a second-person check).
Parked by the lead (Q2): until a binding clause needs it, values are typed from the attached printout and checked by a second person. If unfrozen later, the smallest form is: the existing gateway drivers write device originals (DI-32); the NUMBER field of section 3
fills its value from the original of the run the operator picks, and the operator confirms. Profiles for autoclave,
tunnel, lyophiliser, filling line, EM particle counter, filter integrity tester, inspection and CCIT machines. Needs the
site gateway unfrozen for these profiles only (Q2).

## 5. Library blocks (data, 32)

INJ-01 line clearance and room readiness; 02 component and RTU acceptance; 03 supplier-sterilised components; 04
washing and siliconisation; 05 depyrogenation; 06 moist heat of parts; 07 SIP; 08 aseptic assembly and transfer; 09
VHP; 10 glove integrity; 11 single-use systems; 12 compounding; 13 sterilising filtration and integrity; 14 bulk hold
and bioburden filtration; 15 filling and stoppering (format slot; APS mode); 16 homogenisation; 17 lyophilisation; 18
fill weight and device IPC; 19 ampoule sealing; 20 capping; 21 terminal sterilisation; 22 visual inspection and AQL; 23
CCI; 24 accountability; 25 sterility sampling; 26 release and media-fill tests; 27 RTU tub entry; 28 plunger and
middle stopper; 29 FFS/LVP; 30 BFS; 31 powder handling; 32 EM.

## 6. Slices

Each: tests named by control ID, CI green, one review, the Simplicity review of section 8, squash-merge, a few lines to
the lead. Migration numbers: the injectables namespace has 3000–3999 (reserved by the lead; API has 5000–5999). A migration in a shared directory takes the next free number, cleared with the lead first. The API edition builds on I-0, so the edition setting stays fully neutral.

| Slice | Content | Done when |
|---|---|---|
| I-0 | edition as data (`platform-fit.md`: migration 1871, palette filter, badge); confirm or drop the section-3 changes; the per-control table for Q1 | Tablets suite unchanged; the injectables edition signs on with an empty library |
| I-1 Terminally sterilised small-volume vials and ampoules | INJ-01, 02, 04, 05, 06, 12, 14, 15, 18, 19, 20, 21, 22 (manual), 23, 24, 25, 26; grade room classes, qualifications | a vial batch and an ampoule batch built on screen and run to release in the sandbox |
| I-2 Aseptic fill, EM, media fill | INJ-03, 07, 08, 09, 10, 11, 13, 32; events repeat; media-fill and routine-EM formulations; isolator, RABS and open Grade A set-ups | an aseptic vial batch and a media fill run to the end; an action-level EM result blocks release |
| I-3 Lyophilisation | INJ-17 | a lyophilised vial batch to release |
| I-4 Other containers and routes | INJ-16, 27, 28, 29, 30, 31; dual-chamber; radiation | one sandbox batch per form |
| I-5 Automated inspection, CCIT, RMM | INJ-22 automated, INJ-23 deterministic, RMM in INJ-26 (machine values typed from the attached report) | each method runs to release in the sandbox |
| I-6 Edition exit | `injectables` in `compliance/phase.yaml` editions; trace per Q1's outcome; golden batches; browser suite; one review | trace green with the edition in the gate |

The trace gate stays Tablets-only until I-6; meanwhile a per-edition trace report lists each slice's controls.

## 7. Risks

| Risk | Mitigation |
|---|---|
| The 91 controls ask for more than the binding minimum (an APS status engine, cross-batch EM linkage, an intervention catalogue engine, a numeric-floor table, …). At I-6 the trace would fail them | Q1: the owner, as expert, records DONT_FOLLOW or MODIFY per clause; I-0 supplies the table. No control file is edited by the build |
| A block grows into code again | the rule of section 1; a slice that needs code stops and asks the lead with the clause |
| One application for two editions blurs their validation | there is no sterile code; each edition's content lives in its own database and is approved there |
| Typed printout values are slower than device data | the second-person check is the binding minimum; device fill comes in I-5 |
| Sibling editions (Capsules, API) change the same shared parts | every shared change goes through the lead; API may reuse the sterile blocks and rule table for sterile APIs through the lead |

## 8. Simplicity review

**What v2 cut, and why it is safe:** the eight sterile modules (clean areas, EM, people, APS, interventions,
utilities, time limits, sterile release), the `DEVICE_RECORD` field type, the F0 recomputation, the shared-host
extraction, the conditional release and the parametric release (until Q5). Each binding clause behind them is met in
section 4 by a block, a qualification, a due date or the gate.

**Checks each slice's review applies (the reviewer signs the list in the PR):**
1. Every new thing names its binding clause; anything without one is removed.
2. No new code where a block of existing field types works; no new screen where the generic block screen works.
3. An operator act takes one screen, one primary action, and at most one signature unless the clause asks for two.
4. Words an operator uses on the floor; no internal codes on screen.
5. Every block readable and usable on a terminal with gloves (large targets).
6. Defaults filled from the formulation; the operator types only what was measured.
7. Nothing asked twice (a value in an earlier block is read, not re-entered).

## 8a. Not built: guidance only (lead, Q1)

These control behaviours rest only on FDA's 2004 aseptic-processing guidance (FDA-AP). They are **not built**. Where a
binding text covers the same point, the item is built from that text instead, as noted. No control file is edited; the
owner records the matching expert decisions (Q1).

| Control | Guidance-only behaviour | Built instead from |
|---|---|---|
| ST-32 | FDA default APS incubation scheme (20-35 °C, 14 days, 7 + 7 days, lower temperature first) enforced | Annex 1 9.44-9.45: the conditions the site validated, as formulation values |
| ST-29 | FDA APS reassessment triggers (staffing change, EM anomaly, extended shutdown, finished-product positive) and the APS_ASSESSMENT_REQUIRED state | Annex 1 9.48-9.49, Schedule M 5.3-5.7: the revalidation triggers those texts list |
| ST-20 | FDA example alert and action levels (FDA-AP Table 1) as limits | Schedule M Table 3 and Annex 1 Tables 5-6 through the sterile rule table |
| ST-01 | FDA-AP's justified alternative microbial action levels as a site option | not needed: the stricter binding table applies |
| ST-18 | EM sampling every shift as a fixed rule | Annex 1 9.4-9.8 and Schedule M 4.7: frequency from the site's risk assessment, as formulation values |
| ST-22 | daily or per-lot glove sampling; no glove sanitising before sampling | Annex 1 9.25-9.27: personnel monitoring after critical interventions and at exit |
| ST-17 | 10-15 Pa between classes as a limit | Annex 1 4.30 states 10 Pa as a guidance value only: a formulation value, not a refusal (as ST-01 already treats guidance values) |
| ST-23 | growth-promotion test for every prepared media lot | Annex 1 10.8-10.11 where they apply |
| ST-06 | every power interruption is a deviation | Annex 1 4.13, 6.20-6.22 and 211.192: alarms and failures recorded and assessed |
| ST-08 | annual APS participation being enough only for automated, low-intervention lines | Annex 1 9.38: at least one successful APS a year per operator |

I-0 checks every ST and IN control clause by clause and completes this list. A row is added only when no binding text
supports the behaviour.

## 9. Open questions

| # | Question | Default if no answer |
|---|---|---|
| Q0 | What counts as binding | **Owner: yes.** Every numbered requirement of the binding instruments counts, limit tables included: Annex 1, Revised Schedule M, EU GMP, 21 CFR. Excluded: separate guidance documents, and the examples or recommended values the text itself names. |
| Q1 | The 91 ST/IN controls versus the minimum | **Owner: yes.** I-0 produces ONE table of the 91 controls (clause, binding source or none, what the plan builds). Default: no binding source means DONT_FOLLOW; a binding source means MODIFY to the plan's minimum. The lead takes it to the owner for a single approval, then it is recorded as the owner's `expert_decision`. |
| Q2 | Unfreeze the site gateway for equipment data? | **Lead: no.** Machine values are typed in with the machine printout attached and checked by a second person. Unfreeze for sterile profiles only when a slice cannot meet a binding clause without it, and ask the lead then. I-5's device-filled NUMBER is parked. |
| Q3 | Platform shape | **Lead:** same product `ebmr` is the working assumption. The lead settles multi-edition sites before I-6. New `ebmr.*` codes go to the lead per slice. |
| Q4 | Prefilled syringes, cartridges and dual-chamber are combination products (US 21 CFR Part 4, EU MDR Article 117). The register's Part 4 row is unverified. The eBMR records the drug manufacture and the device function tests only. | **Lead: yes** |
| Q5 | Parametric release needs EU Annex 17 checked first. | **Lead: yes**, it stays off |
| Q6 | Biologics (Annex 2), radiopharmaceuticals (Annex 3), advanced therapies and continuous manufacturing are product classes or regimes with their own binding texts, outside the listed scope. | **Owner (4 November):** out of scope: radiopharmaceuticals, advanced therapies and continuous manufacturing of injectables, as they are not this market. In scope: small-molecule and biologic drug-product fill-finish; the same blocks serve both. |
| Q7 | ADR 0001 point 1 (own server application per edition) changes to "one application, one database per edition". | **Lead:** the I-0 window opens after Tablets PR #100 merges. Moved-path checklist from the Tablets session: control `tests:` lists, sql-mutation targets and workflow groups, handbook `modules.yaml`, the commands-have-screens list, ops/Dockerfile and entrypoint, tools/platform, dependency-cruiser and pins; rerun flaky E2E groups once, never skip them |
| Q8 | Conditional release of short-shelf-life products (Annex 1 10.7, 10.10) is optional in the EU and has no basis in Schedule M or 211. | not built |
