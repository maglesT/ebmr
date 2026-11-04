# Batchwright Capsules (hard capsules and soft gels): plan

- **Status:** v2, for the lead's and the owner's approval. No code before approval.
- **Owner decisions (4 November 2026):** build Capsules on the same kernel, library, e-signatures, audit trail, MBR
  approval, release, deviations, terminals and platform sign-on, covering every method in current use. Hard capsules
  and soft gels are one scope, "Batchwright Capsules", with two process families that share packaging, inspection, tests
  and release. This replaces the 3 November deferral (R3-CAT-4: capsule blocks kept but left out of the catalogue load).
- **Lead review of v1 (4 November):** take the smallest option. Capsules become a library catalogue inside the existing
  Tablets edition, with no new edition value, database, apps or migration range, and the OSD controls unchanged. Use an
  `EDITION=capsules` deployment with its own database (the Injectables pattern) only if a binding clause forces it.
- **Read with:** ADR 0001, ADR 0011, decision 0026 (library blocks are data, field types are vendor code), decision
  0008 (cadence), `packages/recipe-core/src/library/` (model, seed).
- **Owner rules applied:** binding clauses only (section 4); no code where the library already does the job (sections 2,
  3 and 6). For each item the plan gives the clause, the smallest way to meet it and why nothing smaller works.

## 1. Architecture: a catalogue in the Tablets edition

Schedule M Part VIII covers "oral solid dosage forms (tablets and capsules)" as one part, and every capsule or soft-gel
record falls *inside a batch step*. Shells, gel mass ingredients and fills are material lots. Fillers, encapsulators,
dryers and sorters are equipment. Readings are fields. So Capsules is library data that runs in the Tablets edition as
it stands:

| Layer | Capsules | Change |
|---|---|---|
| Edition, database, apps | the Tablets edition, `ebmr_tablets`, `apps/tablets-*` | none |
| Product | MBR family with `dosage_form` "Hard capsule" or "Soft capsule" (free text, required today), batch sizes in `{cap}` (a unit the UI already knows) | none |
| Library | capsule and soft-gel blocks are data in `packages/recipe-core/src/library/seed/` (capsules.ts exists; softgels.ts is new). Shared OSD blocks are reused as they are | data |
| Catalogue load | loads the capsule and soft-gel blocks as drafts, like every other block (only held codes are skipped) | about 5 lines: drop the R3-CAT-4 exclusion |
| Controls, rule tables, migrations, platform codes | unchanged. IN-37 and IN-38 already name capsules; `tablets` rule keys apply only to compression (mini-tablets) | none |

**Binding-clause check for the smaller option:** no binding clause forces a separate edition. 211.186(b)(1)'s dosage
form description is the family's `dosage_form`. Schedule M Part VIII is one part for both forms. Batch numbering,
lots, release, containment and records are the same machinery. The only thing that differs is the product name in the
header, which stays "Batchwright Tablets". That is branding (decision 0020), not a clause (Q1).

**Separation from tablet products:** capsule blocks never enter a tablet master unless QA puts them there (decision 0026
point 3: the preparer and QA own the content). Existing masters keep their pinned block versions (S9), so loading the
catalogue changes no running product.

**Code: one change.** The catalogue load (`apps/tablets-server/src/features/library/index.ts`) uses the whole
`SEED_CATALOGUE`. Its test (`[PR-05][DI-35]` catalogue load) is updated for the added codes. Nothing else is coded.
No migration is expected; if one turns out to be needed, I will ask the lead for a number first.

## 2. New field types: none

Every record maps to an existing field type:

| Record | Field types |
|---|---|
| Filler, encapsulator, dryer, sorter, checkweigher, printer, band sealer, homogeniser | EQUIPMENT (class slot; the class carries the method) |
| Capsule size, filling principle, die set, gelatin source (bovine, porcine, fish, non-animal), defect class | CHOICE or TEXT |
| Shell, gelatin, plasticiser, colour, opacifier, lubricant oil, solvent, ink lots; pellets, mini-tablets, fill, gel mass | MATERIAL_LOT, CONTAINER (consume, register) |
| Fill weight, speed, temperatures, vacuum, viscosity, ribbon and seal thickness, RH | NUMBER with limit slot, `critical` |
| Rounds every N minutes; one row per capsule; drying until the end point | section repeat PER_INTERVAL, COUNT, UNTIL_PASS |
| Gel mass, band solution and fill holding times | DATE_TIME, TIMER with limit |
| Locked length, hardness, disintegration or rupture, weights of 10 or 20 units | TEST_RESULT with replicates and MEAN, INDIVIDUAL, MIN, MAX |
| Per-capsule fill = gross − shell, then the mean fill against its limit | a COUNT section with a CALC per capsule, then a CALC `mean(fill)` in a later section. The handler already passes a repeating section's values to later sections as a series, and `mean` is an expr library function |
| Yield, reconciliation, weight gain | CALC |

No shared expr or recipe-core change is needed either.

## 3. Methods mapped to blocks

E = existing block, reused. N = new block, data only, QA-approved like any other. "Both" = used by hard and soft.

### 3.1 Shared by both families

| Method or step | Block(s) |
|---|---|
| Receipt, sampling, testing and storage of shells, gelatin, other components | E: site receipt, lot status, approved source; QC's test record on the lot |
| Dispensing (incl. potency-adjusted, liquids) | E: PROC-DISP, PROC-DISP-POTENCY, PROC-DISP-LIQUID |
| Liquid, semi-solid fill preparation: oil solutions, suspensions, emulsions, SMEDDS, pastes, thermosoftening; mixing, homogenisation, deaeration, viscosity, holding time | N: PROC-FILL-PREP (both) |
| Seal integrity, leakers | N: IPC-CAPS-SEAL-LEAK (both) |
| Visual inspection and sorting (shape, leakers, splits, dents) | N: PROC-CAPS-INSPECT (both) |
| Printing, then QC approval before packaging | N: PROC-CAPS-PRINT (both) + E: QA hold point G-17 |
| Polishing | E: PROC-CAPS-POLISH (equipment class per family) |
| Enteric or functional coating of filled capsules (incl. enteric soft gels) | E: COAT-SUSPENSION-PREP, COAT-FILM |
| Metal detection | E: PROC-DEDUST-MD. **Flag: not on the owner's list, in common use** |
| Moisture | E: IPC-LOD; release REL-WATER-KF |
| Disintegration or rupture | E: IPC-CAPS-DT, version 2 adds a CHOICE "disintegration / rupture" (data) |
| Uniformity of dosage units, dissolution (single, profile, two-stage), assay | E: REL-CONTENT-UNIFORMITY, REL-UNIFORMITY-OF-MASS, REL-CAPS-DISSO, REL-DISSO-PROFILE, REL-DISSO-TWO-STAGE, REL-ASSAY (QC's record on the lot) |
| Blister (thermo, cold, peel), strip, bottle with desiccant, carton, coding, leak test | E: PACK-* |
| Line clearance, room and equipment status, balance check, sampling, yield, reconciliation, stage sign-off, deviation reference | E: CTRL-* |
| Potent, beta-lactam, cytotoxic, hormone products | E: plant rules (dedication, campaigns, hazard screens) with CTRL-ROOM-STATUS and CTRL-EQUIP-STATUS |

### 3.2 Hard capsules

| Method or step | Block(s) |
|---|---|
| Sifting, milling, granulation (wet, fluid-bed, dry), drying, sizing, blending, lubrication | E: PROC-SIFT, PROC-MILL, PROC-CONE-MILL, PROC-BINDER, PROC-RMG, PROC-FBG, PROC-FBD, PROC-TRAY-DRY, PROC-SIZE, PROC-ROLLER, PROC-DRY-MIX, PROC-BLEND, PROC-LUB, PROC-GEO-DIL |
| Extrusion-spheronisation | N: PROC-EXTRUDE-SPHERONISE |
| Drug layering on inert cores (solution, suspension or powder) | N: PROC-PELLET-LAYER |
| Pellet coating (seal, enteric/delayed, sustained release; fluid-bed) | N: COAT-PELLET-FB, with E: COAT-SUSPENSION-PREP |
| Mini-tablet compression | E: PROC-COMPRESS and its IPC blocks |
| Automatic filling: dosator, tamping/dosing disc, vacuum, auger; powder or granules | E: PROC-CAPS-FILL, version 2 adds the filling-principle CHOICE (data) |
| Manual and semi-automatic plate filling | N: PROC-CAPS-FILL-PLATE |
| Pellets/beads, mini-tablets, combinations (pellets + powder, tablet-in-capsule, capsule-in-capsule) | N: PROC-CAPS-FILL-MULTI (one to four dosing stations, each with its own input and fill weight or count) |
| Liquid and semi-solid fill | N: PROC-CAPS-FILL-LIQUID, after PROC-FILL-PREP |
| Fill weight, weight variation; locked length; appearance | E: IPC-CAPS-FILL-WEIGHT, IPC-CAPS-LOCK-LENGTH, IPC-CAPS-APPEARANCE |
| Checkweigher (100 % weight sorting) | N: PROC-CAPS-CHECKWEIGH |
| Banding and sealing | N: PROC-CAPS-BAND |

### 3.3 Soft gels

| Method or step | Block(s) |
|---|---|
| Gel mass: melting, plasticiser, colour/opacifier, deaeration, viscosity, holding time; gelatin (bovine, porcine, fish) or non-animal (starch, carrageenan) | N: SG-GEL-MASS (gelatin source is a CHOICE; materials are the formula's) |
| Fill preparation | N: PROC-FILL-PREP (section 3.1) |
| Rotary die encapsulation: ribbon thickness, seal thickness, wedge and spreader temperatures, lubrication, die-roll changes, fill and shell weight per round; other rotary-die machines (equipment class) | N: SG-ENCAP-ROTARY |
| Seamless (concentric nozzle, drop method) | N: SG-ENCAP-SEAMLESS |
| Chewable soft gels | data: a chewable gel mass formula in SG-GEL-MASS; tests as the product's specification |
| Tumble drying, then tray drying in low-humidity tunnels; end point on hardness and/or moisture; holding times | N: SG-DRY (tumble section, then an UNTIL_PASS tunnel section with RH and temperature at intervals) |
| Washing and solvent removal | N: SG-WASH |
| Fill weight and shell weight (per capsule, gross − shell) | N: IPC-SG-FILL-SHELL |
| Seal thickness | N: IPC-SG-SEAL-THICKNESS |
| Hardness | N: IPC-SG-HARDNESS |
| Inspection, sorting, leakers, printing, polishing, enteric coating, tests, packaging | as section 3.1 |

Out of scope (agreed by the lead, Q5 of v1): capsules for dry-powder inhalers. The reciprocating-die and Accogel
encapsulation processes are not covered as separate blocks. If a site still runs one, it records it with SG-ENCAP-ROTARY
or PROC-CAPS-FILL and that machine's equipment class (Q3).

**New library blocks: 20, all data.** Hard: 11 (PROC-EXTRUDE-SPHERONISE, PROC-PELLET-LAYER, COAT-PELLET-FB,
PROC-CAPS-FILL-PLATE, PROC-CAPS-FILL-MULTI, PROC-CAPS-FILL-LIQUID, PROC-CAPS-CHECKWEIGH, PROC-CAPS-BAND, PROC-CAPS-PRINT,
PROC-CAPS-INSPECT, IPC-CAPS-SEAL-LEAK) and PROC-FILL-PREP, shared with soft. Soft: 8 (SG-GEL-MASS, SG-ENCAP-ROTARY,
SG-ENCAP-SEAMLESS, SG-DRY, SG-WASH, IPC-SG-FILL-SHELL, IPC-SG-SEAL-THICKNESS, IPC-SG-HARDNESS). Two existing blocks get a
data-only version 2 (PROC-CAPS-FILL, IPC-CAPS-DT).

## 4. Binding clauses (cited, checked against `docs/regulatory/sources-extracted/`)

Part A lists the clauses worded "shall" or "must". Part B lists the numbered EU GMP Part I requirements that count
under the lead's proposed rule (every numbered requirement of a binding instrument, excluding separate guidance and the
examples the text names) once the owner confirms it (Q2). Everything is met by reuse unless a new block is named.

**Part A**

| Clause | Requires (paraphrased) | How it is met |
|---|---|---|
| 21 CFR 211.100(a), (b) | approved written production procedures, followed and documented at the time; deviations recorded and justified | MBR approval, execution, deviations |
| 21 CFR 211.101(b)-(d) | components weighed; dispensed containers identified; second-person checks of dispensing and of each component added | dispensing blocks; shell, gelatin and fill lots in each filling or encapsulation block, with a VERIFIED signature |
| 21 CFR 211.103 | actual and theoretical yield at each appropriate phase, independently verified | CTRL-YIELD after filling or encapsulation, drying, sorting, packing |
| 21 CFR 211.105(a) | containers, lines and major equipment identified | EQUIPMENT and CONTAINER fields |
| 21 CFR 211.110(a)(1), (2), (4) | in-process controls incl. capsule weight variation, disintegration, dissolution, where appropriate | IPC-CAPS-FILL-WEIGHT, IPC-SG-FILL-SHELL, IPC-CAPS-DT, dissolution |
| 21 CFR 211.110(b) | in-process specifications consistent with final specifications | formulation limits; a limit looser than the registered specification is refused (O-5) |
| 21 CFR 211.132(b)(2) | an OTC two-piece hard gelatin capsule must be sealed with a tamper-evident technology | N: PROC-CAPS-BAND, IPC-CAPS-SEAL-LEAK (PR-41) |
| 21 CFR 211.84(b), (d) | samples of each lot of each shipment; at least an identity test per component | receipt and QC on shell, gelatin and fill lots |
| 21 CFR 211.186(a), (b) | master record per product and batch size, prepared and independently checked; dosage form, components, theoretical yield, complete instructions | formulation (preparer, checker, QA approval, PR-02); `dosage_form` |
| 21 CFR 211.188(a), (b) | batch record of each significant step: dates, equipment, lots, weights, IPC results, area inspection, yield, labelling, sampling, persons | batch generated from the formulation |
| 21 CFR 211.192 | record review; investigation of discrepancies | review by exception, deviations |
| 21 CFR 11.10, 11.50, 11.70, 11.100, 11.200 | closed-system controls, signature manifestation and linking, unique signatures | kernel |
| Schedule M Part I 17.3.6, 17.3.8, 17.3.9 (SM-11, SM-13, SM-14) | authorised master formula per product and batch size; batch processing and packaging records from approved documents, without transcription | formulation and batch generation |
| Schedule M Part I 18.2.3, 18.4.6, 18.5.10 (SM-17) | yields and reconciliation | CTRL-YIELD, CTRL-MATERIAL-RECON, CTRL-PRINTED-RECON |
| Schedule M Part I 18.4.1-18.4.2, 18.5.2-18.5.3 (SM-18) | identification; recorded line clearance | CTRL-LINE-CLEAR-START, CTRL-LINE-CLEAR-END |
| Schedule M Part I 14.16, 14.17 (SM-20) | only QC-released, in-date starting materials | MATERIAL_LOT checked against the lot register |
| Schedule M Part I 18.3 (SM-59); Part III (SM-53) | cross-contamination prevention; dedicated facilities for penicillins, cytotoxics, hormones | plant rules |
| Schedule M Part VIII 2.3, 2.4, 2.5 | critical time and temperature of mixing, blending and drying in the master and recorded; product-specific fluid-bed bags for potent products; solutions made, stored and used to minimise contamination | process blocks; N: SG-GEL-MASS, PROC-FILL-PREP, SG-DRY, COAT-PELLET-FB, PROC-PELLET-LAYER record time, temperature and holding times |
| Schedule M Part VIII 5 | empty hard shells are a drug component, stored away from heat and moisture | shell lots; storage condition on the item (IN-37) |
| Schedule M Part VIII 6.1, 6.2 | printing segregated, edible inks; QC approval after printing before packaging | N: PROC-CAPS-PRINT + G-17 hold point (IN-37) |
| Schedule M Part VIII 7.1, 7.3, 7.4 | rogue capsules removed with an independent recorded check; strips inspected; periodic leak test | CTRL-LINE-CLEAR-*, PACK-*, PACK-LEAK (IN-38) |
| Schedule M (text at extract line 4304, numbered 4.8) | supply-chain risk to starting materials assessed, with emphasis on TSE agents | a supplier and material approval (QRM) duty, met before the lot is approved; the batch record only uses approved lots (SM-20). Nothing to build |
| EU GMP Ch. 4, 4.10, 4.11 | record integrity over retention; batch documentation retention periods | kernel retention |
| EU GMP Ch. 5, Principle; 5.31; 5.45 | production per defined procedures and the authorisations; each batch in a delivery handled separately; packaging suppliers approved like starting-material suppliers | MBR; lot receipt |

**Gelatin TSE/BSE, binding status:** 21 CFR 210/211 have no TSE clause; FDA's gelatin recommendations are guidance and
are left out. In the EU, TSE compliance of gelatin is a marketing-authorisation requirement (by reference), so it is
met by approved source and lot approval; the batch record does not repeat it. In India, it is the Schedule M
risk-assessment duty above. No field is added. A site that wants the gelatin source on the record already has it in
SG-GEL-MASS.

**Part B (counted only if the owner confirms the lead's rule):** EU GMP Ch. 4, 4.17-4.21 (formula, processing and
packaging instructions, batch processing and packaging records); Ch. 5, 5.9-5.12 (no simultaneous operations, dust
precautions, labelling of materials and equipment), 5.15 (deviations), 5.18-5.22 (cross-contamination),
5.37-5.44 (dispensing, independent check, work-area clearance, IPC, yield investigation), 5.50-5.62 (packaging
clearance, line identity, printing checks, on-line control, reconciliation). Each one is the same requirement as a
Part A row and is met by the same reused block or control. No addition expected; I will re-check once the owner
answers.

**Not binding, so not built:** Part VIII 3.8's 30-minute sampling interval is written for tablet compression (it
applies to mini-tablet compression through the `tablets` rule key, and to nothing else here). Part VIII 7.2 (isolated
packing) names potent and beta-lactam *tablets* only. Schedule M has no soft-gel clause; soft gels follow Part I and
the capsule wording of Part VIII.

## 5. Slice order (simplest first)

Each slice: tests named by control ID, CI green, one review, squash-merge, a few lines to the lead.

| Slice | Content | Done when |
|---|---|---|
| C1 Powder hard capsule (data) | catalogue load takes the capsule blocks; PROC-CAPS-FILL v2; recipe-core tests: a powder formulation from the catalogue validates and its batch runs on the generic simulator | `[PR-05][DI-35]` load test and `[PR-03][IN-37]` tests green |
| C2 Powder hard capsule end to end | one E2E group: catalogue to released lot through the screens (as S11b), automatic dosator | the E2E group green |
| C3 Post-fill and packing | checkweigher, inspection, printing with the QC hold point, banding (US OTC), blister, strip, bottle | `[IN-37][PR-41][IN-38]` tests green |
| C4 Multiparticulates | extrusion-spheronisation, layering, pellet coating, pellet and mini-tablet dosing, combinations, two-stage dissolution | a delayed-release pellet formulation runs |
| C5 Liquid fill and plate filling | PROC-FILL-PREP, liquid fill, seal leak; plate filling; a beta-lactam product refused outside dedicated rooms and equipment | tests green |
| C6 Soft gels I | gel mass, rotary die, drying to end point, washing, fill/shell weight, seal thickness, hardness | one soft-gel formulation runs; one E2E group to a released lot |
| C7 Soft gels II | seamless, chewable, enteric (coating), rupture; shared post-process on soft gels | tests green |
| C8 Exit | the full suite, the browser suite, the existing golden batches unchanged, one review pass | all green |

C1 starts on approval. C3-C5 can overlap in their own worktrees (at most 2-3 agents).

## 6. Simplicity review

| Considered | Decision | Why |
|---|---|---|
| A separate edition (value, database, apps, migrations, controls) | no | no binding clause needs it (section 1); Part VIII is one oral-solid part |
| New field types | none | section 2 |
| A new expr function for per-capsule fill and its mean | none | series from a repeating section plus `mean` already exist |
| Capsule-specific code, SQL guards, simulators, golden fixtures | none | decision 0026: generic handler, guards, simulator and golden test |
| Copying the tablet process blocks | no | referenced, one version and one approval |
| One block per filling or encapsulation machine | no | the method is a CHOICE plus the equipment class; separate blocks only where the recorded data differ (plate, multi-station, liquid, rotary die, seamless) |
| Separate soft-gel inspection, printing, polishing, coating, leak and test blocks | no | shared with hard capsules |
| A TSE field on every batch | no | met at material approval (section 4) |
| New platform permission codes | none | no new act |

## 7. Risks and open questions

**Risks**
- The catalogue load changes for every Tablets site (more drafts offered). This is intended. Held codes and approved
  versions are untouched, and nothing reaches a product without QA approval.
- The Tablets session also edits `apps/tablets-server` (the platform move). The one code change here is a few lines in
  the library feature; it is rebased onto whatever is current before merging.
- E2E time: each new end-to-end group costs about 45 minutes of CI. Only two are planned (C2, C6).

**Open questions**
- Q1 (owner): the header keeps "Batchwright Tablets" for capsule products. Renaming the badge (for example "Oral
  solids") is a branding change under decision 0020. Default: unchanged.
- Q2 (owner): what counts as binding (the lead's rule, section 4 Part B). Default: Part A until the owner answers.
- Q3 (owner): reciprocating-die and Accogel encapsulation are covered by the generic blocks with their equipment class,
  not by blocks of their own. Default: as written.
- Q4 (owner): metal detection and coating of filled capsules added to the list. Default: in.
