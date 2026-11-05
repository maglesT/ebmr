# Batchwright Capsules edition (hard capsules and soft gels): plan

- **Status:** v3, for the lead's approval. Owner (4 November): "change it to capsules edition and go with lead's
  answers": the name is the Capsules edition; the build follows the lead's answers (the catalogue in the shared oral-solid
  build, the binding rule). No code before approval.
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
  3 and 6). The binding rule as confirmed by the owner on 4 November is in section 4. For each item the plan gives the clause, the smallest way to meet it and why nothing smaller works.

## 1. Architecture: the Capsules edition as a catalogue in the shared oral-solid build

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
header. That is branding (decision 0020), not a clause. The owner named it: the **Capsules edition**. The smallest way to
show it (owner, 4 November, through the lead): the header reads "Batchwright Capsules" when the master or batch on
screen has a capsule dosage form (hard capsules and soft gels), and "Batchwright Tablets" otherwise. `CAPSULES` is added
to ui-kit's `brand.Edition` as a display value only (lead's approval; the Tablets session is told in the C2 PR).
Recorded as an amendment of decision 0020 in slice C2. No database, edition value or app is added.

**Separation from tablet products:** capsule blocks never enter a tablet master unless QA puts them there (decision 0026
point 3: the preparer and QA own the content). Existing masters keep their pinned block versions (S9), so loading the
catalogue changes no running product.

**Code: three small changes.** The header name (above, C2); the catalogue load
(`apps/tablets-server/src/features/library/index.ts`) uses the whole `SEED_CATALOGUE`, its `[PR-05][DI-35]` test updated
for the added codes (C1); and a master from a formula accepts a capsule dosage form, worded per capsule, where it refused
every non-tablet form (D-7j-11; found while building C1). Nothing else is coded.
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
or PROC-CAPS-FILL and that machine's equipment class (Q2).

**New library blocks: 20, all data.** Hard: 11 (PROC-EXTRUDE-SPHERONISE, PROC-PELLET-LAYER, COAT-PELLET-FB,
PROC-CAPS-FILL-PLATE, PROC-CAPS-FILL-MULTI, PROC-CAPS-FILL-LIQUID, PROC-CAPS-CHECKWEIGH, PROC-CAPS-BAND, PROC-CAPS-PRINT,
PROC-CAPS-INSPECT, IPC-CAPS-SEAL-LEAK) and PROC-FILL-PREP, shared with soft. Soft: 8 (SG-GEL-MASS, SG-ENCAP-ROTARY,
SG-ENCAP-SEAMLESS, SG-DRY, SG-WASH, IPC-SG-FILL-SHELL, IPC-SG-SEAL-THICKNESS, IPC-SG-HARDNESS). Two existing blocks get a
data-only version 2 (PROC-CAPS-FILL, IPC-CAPS-DT).

## 4. Binding clauses (cited, checked against `docs/regulatory/sources-extracted/`)

Rule confirmed by the owner (4 November 2026): every numbered requirement of the binding instruments counts (21 CFR
211, EU GMP Part I, Schedule M), including their limit tables. Separate guidance documents and the examples or
recommended values the text itself names are excluded. Part 11 and Annex 11 apply to the records through the kernel.
Each requirement is met by reuse unless a new block or field is named. None of the three instruments has a limit table
for capsules or soft gels; the product limits come from the registered specification.

| Clause | Requires (paraphrased) | How it is met |
|---|---|---|
| 21 CFR 211.100(a), (b) | approved written production procedures, followed and documented at the time; deviations recorded and justified | MBR approval, execution, deviations |
| 21 CFR 211.101(b)-(d) | components weighed; dispensed containers identified; second-person checks of dispensing and of each component added | dispensing blocks; shell, gelatin and fill lots in each filling or encapsulation block, with a VERIFIED signature |
| 21 CFR 211.103 | actual and theoretical yield at each appropriate phase, independently verified | CTRL-YIELD after filling or encapsulation, drying, sorting, packing |
| 21 CFR 211.105(a) | containers, lines and major equipment identified | EQUIPMENT and CONTAINER fields |
| 21 CFR 211.110(a)(1), (2), (4) | in-process controls incl. capsule weight variation, disintegration, dissolution, where appropriate | IPC-CAPS-FILL-WEIGHT, IPC-SG-FILL-SHELL, IPC-CAPS-DT, dissolution |
| 21 CFR 211.111 | time limits for each phase of production, where appropriate | TIMER and holding-time limits in SG-GEL-MASS, PROC-FILL-PREP, SG-DRY, PROC-CAPS-BAND; E: PROC-HOLD |
| 21 CFR 211.113(a) | procedures preventing objectionable microorganisms in non-sterile products | holding-time limits on gel mass, fill and band solution (as above); the procedure itself is the site's |
| 21 CFR 211.67, 211.182 | cleaning and use records of equipment | equipment logbooks and status (PR-24, CTRL-EQUIP-STATUS) |
| 21 CFR 211.122-211.134 | labelling and packaging material control, issuance, operations, inspection | PACK-*, CTRL-PRINTED-RECON, labels |
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
| EU GMP Ch. 4, 4.17, 4.18 | manufacturing formula and processing instructions: form, strength, batch size, materials, yields, location and equipment, clearance, stepwise instructions with critical parameters, IPC with limits, bulk storage, precautions | formulation from library blocks; E: PROC-HOLD for bulk storage conditions |
| EU GMP Ch. 4, 4.19, 4.21 | packaging instructions and the batch packaging record | PACK-*, CTRL-LINE-CLEAR-*, CTRL-PRINTED-RECON |
| EU GMP Ch. 4, 4.20 | batch processing record: times, operators and checkers, lots and quantities, equipment, IPC results, yields, deviations, approval by the person responsible | batch generation; CTRL-STAGE-SIGNOFF, CTRL-DEVIATION-REF |
| EU GMP Ch. 5, 5.9-5.13 | no simultaneous operations at risk of mix-up; protection from contamination; dust precautions; materials, containers, equipment and rooms identified by product, strength, batch and stage | room and equipment status, CONTAINER labels, plant rules |
| EU GMP Ch. 5, 5.14 | checks that pipelines and transfer equipment are connected correctly | **one YES_NO field** "gel mass and fill lines connected to the right machine and hopper" in SG-ENCAP-ROTARY, SG-ENCAP-SEAMLESS and PROC-CAPS-FILL-LIQUID (heated transfer lines). Found in this re-check |
| EU GMP Ch. 5, 5.15 | deviations approved in writing by a competent person | deviations |
| EU GMP Ch. 5, 5.18-5.22 | cross-contamination prevention based on a risk assessment | plant rules (dedication, campaigns, hazard screens) |
| EU GMP Ch. 5, 5.27-5.36 | supplier approval, delivery checks, identity, only QC-released materials | site receipt, approved source, lot status. Gelatin TSE is part of supplier and material approval here |
| EU GMP Ch. 5, 5.37-5.44 | designated dispensers, independent check of each dispensed weight, materials kept together and labelled, clearance before processing, IPC, investigation of yield deviations | PROC-DISP (DISPENSER role, VERIFIED), CTRL-LINE-CLEAR-START, IPC blocks, CTRL-YIELD |
| EU GMP Ch. 5, 5.50-5.62 | packaging clearance, line identity, printing checks, on-line control, reintroduction after unusual events, reconciliation, destruction of unused coded material | PACK-*, PACK-CODING, CTRL-LINE-CLEAR-*, CTRL-PRINTED-RECON, deviations |
| EU GMP Ch. 4, 4.10, 4.11 | record integrity over retention; batch documentation retention periods | kernel retention |
| EU GMP Ch. 5, Principle; 5.31; 5.45 | production per defined procedures and the authorisations; each batch in a delivery handled separately; packaging suppliers approved like starting-material suppliers | MBR; lot receipt |

**Gelatin TSE/BSE, binding status:** 21 CFR 210/211 have no TSE clause; FDA's gelatin recommendations are guidance and
are left out. In the EU, TSE compliance of gelatin is a marketing-authorisation requirement (by reference), so it is
met by approved source and lot approval; the batch record does not repeat it. In India, it is the Schedule M
risk-assessment duty above. No field is added. A site that wants the gelatin source on the record already has it in
SG-GEL-MASS.

**Not binding, so not built:** Part VIII 3.8's 30-minute sampling interval is written for tablet compression (it
applies to mini-tablet compression through the `tablets` rule key, and to nothing else here). Part VIII 7.2 (isolated
packing) names potent and beta-lactam *tablets* only. Schedule M has no soft-gel clause; soft gels follow Part I and
the capsule wording of Part VIII.

## 5. Slice order (simplest first)

Each slice: tests named by control ID, CI green, one review, squash-merge, a few lines to the lead.

| Slice | Content | Done when |
|---|---|---|
| C1 Powder hard capsule (data) | catalogue load takes the capsule blocks; PROC-CAPS-FILL v2; recipe-core tests: a powder formulation from the catalogue validates and its batch runs on the generic simulator | `[PR-05][DI-35]` load test and `[PR-03][IN-37]` tests green |
| C2 Powder hard capsule end to end | the platform reader takes `dosage_form` from core's report.product_v1 (a product is a capsule only when its dosage form contains "capsule"; none means tablet; lead, 4 November); the header name from the dosage form (decision 0020 amended); the remaining tablet wording a capsule master shows (the batch-size input name "tablets", the issue count) worded per unit or per capsule; one E2E group: catalogue to released lot through the screens (as S11b), automatic dosator | the E2E group green |
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
- The Tablets session also edits `apps/tablets-server` (the platform move). The code changes here are a few lines in
  the library feature; it is rebased onto whatever is current before merging.
- E2E time: each new end-to-end group costs about 45 minutes of CI. Only two are planned (C2, C6).

**Open questions**
- Q1: answered by the owner (the header name follows the dosage form, section 1).
- Q2 (owner): reciprocating-die and Accogel encapsulation are covered by the generic blocks with their equipment class,
  not by blocks of their own. Default: as written.
- Q3 (owner): metal detection and coating of filled capsules added to the list. Default: in.

## 8. Slice decisions

**C3 post-fill and packing (5 November 2026; defaults taken, decision 0004):**
- D-C3-1: five new blocks, data only: PROC-CAPS-CHECKWEIGH, PROC-CAPS-INSPECT, PROC-CAPS-PRINT, PROC-CAPS-BAND and
  IPC-CAPS-SEAL-LEAK (brought forward from C5: banding needs its seal check; C5 reuses it). A leaker is a critical value
  outside its registered limit of none, so the step raises an exception and the capsules wait for QA (PR-41 failures).
- D-C3-2: 21 CFR 211.132(b)(2) as a validator rule, GMP-CAPSULE-SEAL (validator 1.3.0): a master whose header says US OTC
  retail (`predicates.usOtcRetail`, as the packaging masters' PR-41 check reads it) for a hard capsule (a capsule form
  without "soft") must band or seal on every completing path. No screen sets the predicate on a processing master yet;
  the rule holds whenever one does.
- D-C3-3: Schedule M Part VIII 6.2 as a validator rule, GMP-CAPSULE-PRINT-HELD: every PROC-CAPS-PRINT step runs before a
  hold point that every completing path passes. A library master's H-PACK (QA, before packing) is that hold point; the
  block also records segregation, the approved edible ink and that the print is held for QC.
- D-C3-4: the edible ink is named in a text field (name and lot), not a formula line: an ink is not weighed into the
  batch, and a line would force every printed master to dispense it.
- D-C3-5: blister, strip and bottle packing of capsules reuse the packaging masters as they are (TB-21 to TB-24); the
  `library-caps` E2E packs the capsules in the cold-form blister. Residual (wording only, no GMP value): TB-20 and TB-23
  field descriptions say "tablets" (the bottle count, the sorter); left for the lead, since changing them changes those
  block versions' content.
