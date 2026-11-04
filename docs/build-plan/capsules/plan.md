# Batchwright Capsules (hard capsules): edition plan

- **Status:** Draft for the lead's and the owner's approval. No code before approval.
- **Owner decision (4 November 2026):** build Capsules inside Batchwright as its own edition beside Tablets, on the same
  kernel, dynamic library, e-signatures, audit trail, MBR approval, release, deviations, terminals and platform
  sign-on. Full scope of hard-capsule methods in current use. This replaces the 3 November deferral (R3-CAT-4: the
  capsule blocks were kept but left out of the Tablets catalogue load).
- **Read with:** ADR 0001 (editions, separate databases), ADR 0011 (recipe-core shared), ADR 0026 decision (library
  blocks are data, field types are vendor code), decision 0008 (cadence), the dynamic-library plan, and the
  Injectables plan on branch `inj/plan` (its slice I-0, the shared host, is what this plan builds on).
- **Owner rules applied:** binding clauses only (section 4); nothing new where the library can already do it
  (sections 2 and 6); each item names its clause, the smallest way and why nothing smaller works.

## 1. Architecture of the edition

Hard capsules are an oral solid dosage form. Schedule M treats tablets and capsules in one Part (VIII), and every
capsule step is something done *inside a batch step*: shells are a material lot, fillers and sorters are equipment,
and the records are fields. So, unlike Injectables, Capsules needs **no edition modules**: no state lives outside a
step that the kernel, recipe-core, site services and the plant rules do not already hold.

| Layer | Capsules | New? |
|---|---|---|
| Database | `ebmr_capsules`: the same kernel and recipe migrations; a `cap` migration namespace reserved, expected empty (section 7, Q3) | database only |
| Site data | the shared `ebmr_site` (persons, training, lots incl. empty-shell lots, one batch-number register) | none |
| Server and web | `apps/capsules-server` and `apps/capsules-web`: the shared host of Injectables slice I-0 composed with the edition value `capsules` and the capsule catalogue. No TB-01..24 (those stay tablets-only legacy, O-6). Expected edition code: a few dozen lines of composition | thin apps |
| Library | shared OSD blocks (dispensing, sifting, granulation, drying, milling, blending, controls, packaging) **referenced, not copied**, plus the capsule blocks (data) | data |
| Market rules | the existing `kernel` and `tablets` rule tables (Part VIII is common to tablets and capsules; its compression keys apply when a capsule product compresses mini-tablets) | none |
| Platform | product `ebmr`, edition badge CAPSULES (decision 0020); no new `ebmr.*` permission codes expected (every act is an existing one: execute, sign, approve, release) | badge |

**Reused unchanged:** kernel (audit trail, e-signatures, time, identity, records, market engine, platform sign-on),
recipe-core (library model and its 13 field types, sanity validator, formulation, scaling, batch generation, generic
guards, plant rules incl. the beta-lactam, potent and hazardous screens), site services (receipt, lot status,
reservations, batch numbers), review by exception, release, deviations, terminals, labels.

**Shared changes, all through the lead (one change serves every new edition: Capsules, Soft gels, API):**
1. The edition value `capsules` in the `edition in (...)` checks (kernel 0310 and 1220, recipe-core 0110, 0761, 0780,
   site-services 0600, 0710, 0730, 0733, 0842), recipe-core's `flow.Edition`, and the control schema's `editions` enum.
2. The shared host (Injectables I-0). Capsules adopts it and adds nothing to it.
3. The trace tool's per-edition report (also Injectables I-0).
4. Which controls apply to Capsules: add `capsules` to the `editions` list of the OSD controls that already list
   `tablets` (adds scope, weakens nothing; the tablet-only ones such as compression stay out). A register change, so the
   lead's.

## 2. New field types: none

Every capsule record maps to an existing field type. Checked one by one:

| Record | Field types | Why no new type |
|---|---|---|
| Filler, sorter, checkweigher, printer, band sealer | EQUIPMENT (class slot) | equipment class carries the method |
| Capsule size, filling principle (dosator, tamping disc, auger, vacuum, plate) | CHOICE | fixed lists |
| Empty-shell lot; pellets, mini-tablets, powder as separate inputs | MATERIAL_LOT, CONTAINER (consume) | several inputs = several fields |
| Fill weight per round; speed; liquid fill temperature | NUMBER with limit slot, `critical` | product limits |
| Rounds every N minutes (automatic and plate filling) | section repeat PER_INTERVAL | exists |
| Checkweigher challenge, accepted and rejected counts | YES_NO, NUMBER | counts are numbers |
| Weight variation, locked length, disintegration | TEST_RESULT with replicates and MEAN/INDIVIDUAL/MIN/MAX | exists (IPC-CAPS-*) |
| Band solution prepared at / use-by | DATE_TIME, TIMER with limit | as coating suspensions (IN-37) |
| Yield and reconciliation | CALC | as tablets |

One point to confirm in slice C1, not a new type: a net-content uniformity of mass (gross minus emptied shell, per
capsule) needs a per-unit difference judged on mean and individuals. The in-process check uses the filled-capsule gross
weight (as the existing IPC-CAPS-FILL-WEIGHT), and the compendial release test is QC's record on the lot (D-S11-R1), so
the batch record does not need it. If a site wants it in the batch record, the smallest change is an element-wise CALC
over two replicate series, a shared expr change through the lead.

## 3. Methods mapped to blocks

E = existing library block, reused as is. N = new library block (data only, QA-approved like any other). All N blocks are
data in `packages/recipe-core/src/library/seed/`, in a capsule catalogue module that the Tablets load never sees.

| Method or step | Block(s) | Notes |
|---|---|---|
| **Materials** | | |
| Empty shells (gelatin, HPMC, all sizes 000 to 5) receipt, sampling, testing, storage | E: site receipt and lot status; QC test record on the lot | shells are a component lot (Part VIII 5); HPMC vs gelatin is the item's data |
| Dispensing, incl. potency-adjusted | E: PROC-DISP, PROC-DISP-POTENCY | |
| **Upstream (shared with tablets)** | | |
| Sifting, milling, cone milling | E: PROC-SIFT, PROC-MILL, PROC-CONE-MILL | |
| Wet granulation (RMG, fluid-bed), binder, drying, sizing | E: PROC-BINDER, PROC-RMG, PROC-FBG, PROC-FBD, PROC-TRAY-DRY, PROC-SIZE | |
| Dry granulation | E: PROC-ROLLER | |
| Blending, lubrication, geometric dilution | E: PROC-DRY-MIX, PROC-BLEND, PROC-LUB, PROC-GEO-DIL | |
| Extrusion-spheronisation (pellets) | N: PROC-EXTRUDE-SPHERONISE (extruder and spheroniser, screen size, speeds, wet mass in, pellets out) | then E: PROC-FBD/PROC-TRAY-DRY, PROC-SIFT for sizing |
| Drug layering on inert cores (solution/suspension or powder layering) | N: PROC-PELLET-LAYER (cores lot, layering liquid prepared at and use-by, spray parameters per round) | |
| Pellet coating (seal, enteric/delayed-release, sustained-release, fluid-bed bottom spray) | N: COAT-PELLET-FB (fluid-bed coating per round; weight gain as CALC; curing time) | E: COAT-SUSPENSION-PREP for the suspension |
| Mini-tablet compression | E: PROC-COMPRESS (multi-tip tooling as equipment data); IPC-AVG-WEIGHT etc. | tablets compression keys apply |
| **Filling** | | |
| Automatic: dosator, tamping/dosing disc, vacuum, auger; powder or granules | E: PROC-CAPS-FILL (adds the filling-principle CHOICE in its version 2) | version 2 is data |
| Manual and semi-automatic plate filling | N: PROC-CAPS-FILL-PLATE (plate size, rounds per interval, fill weight) | |
| Pellets/beads, mini-tablets, combinations (pellets + powder, tablet-in-capsule, capsule-in-capsule) | N: PROC-CAPS-FILL-MULTI (one to four dosing stations, each its own input container and fill weight or unit count) | |
| Liquid and semi-solid fill (incl. thermosoftening) | N: PROC-CAPS-FILL-LIQUID (fill temperature, fill weight, leak check) | followed by banding |
| In-process fill weight, weight variation | E: IPC-CAPS-FILL-WEIGHT | |
| Checkweigher (100 % weight sorting) | N: PROC-CAPS-CHECKWEIGH (challenge at start and end, accepted and rejected counts) | |
| **Post-fill** | | |
| Polishing, de-dusting, defect sorting | E: PROC-CAPS-POLISH | |
| Metal detection | E: PROC-DEDUST-MD | **flag: not on the owner's list, in common use** |
| Banding / sealing | N: PROC-CAPS-BAND (band solution use-by, drying, seal check; US OTC: required) | |
| Capsule printing, then QC approval before packaging | N: PROC-CAPS-PRINT (ink lot, segregation answer) + E: QA hold point G-17 | as TB-19's rule, as data |
| Visual inspection (manual) | N: PROC-CAPS-INSPECT (inspected, rejected by defect class) | |
| Enteric coating of filled capsules | E: COAT-FILM with a capsule example | **flag: not on the owner's list, in use** |
| **Tests in the batch record** | | |
| Fill weight, locked length, appearance, disintegration | E: IPC-CAPS-FILL-WEIGHT, IPC-CAPS-LOCK-LENGTH, IPC-CAPS-APPEARANCE, IPC-CAPS-DT | |
| Moisture | E: IPC-LOD; release REL-WATER-KF | |
| Seal integrity (banded or liquid-filled) | N: IPC-CAPS-SEAL-LEAK | |
| Uniformity of dosage units, dissolution (single, profile, two-stage for delayed release), assay | E: REL-CONTENT-UNIFORMITY, REL-UNIFORMITY-OF-MASS, REL-CAPS-DISSO, REL-DISSO-PROFILE, REL-DISSO-TWO-STAGE, REL-ASSAY | QC's record on the lot |
| **Packaging and controls** | | |
| Blister (thermo, cold, peel), strip, bottle with desiccant, carton, coding, leak test | E: PACK-* | |
| Line clearance, room and equipment status, balance check, sampling, yield, reconciliation, stage sign-off | E: CTRL-* | |
| **Containment** | | |
| Potent, beta-lactam, cytotoxic, hormone products | E: plant rules (dedication, campaigns, hazard screens) + CTRL-ROOM-STATUS, CTRL-EQUIP-STATUS | no change |

Out of scope, flagged for the owner: capsules for dry-powder inhalers (inhalation products, a different dosage form
and Schedule M Part; Q5).

New library blocks: 11 (data). New code: none beyond the thin apps and the shared changes of section 1.

## 4. Binding clauses (cited, checked against `docs/regulatory/sources-extracted/`)

Only clauses worded "shall" or "must". All are met by reuse unless the last column names a new block.

| Clause | Requires (paraphrased) | How it is met |
|---|---|---|
| 21 CFR 211.100(a), (b) | approved written production procedures; followed and documented at the time; deviations recorded and justified | MBR approval and execution, deviations (reused) |
| 21 CFR 211.101(b)-(d) | components weighed, containers identified, second-person check of dispensing and of each component added | dispensing blocks; the shell lot in every filling block with a VERIFIED signature (shells are components) |
| 21 CFR 211.103 | actual and theoretical yield at each appropriate phase, independently verified | CTRL-YIELD after filling, sorting and packing |
| 21 CFR 211.105(a) | equipment identified | EQUIPMENT fields |
| 21 CFR 211.110(a)(1), (2), (4) | in-process controls incl. capsule weight variation, disintegration, dissolution, where appropriate | IPC-CAPS-* blocks, IPC-CAPS-DT, release dissolution |
| 21 CFR 211.110(b) | in-process specifications consistent with final specifications | formulation limits; limits looser than the registered specification are refused (O-5) |
| 21 CFR 211.132(b)(2) | an OTC two-piece hard gelatin capsule must be sealed with a tamper-evident technology | N: PROC-CAPS-BAND, IPC-CAPS-SEAL-LEAK (PR-41) |
| 21 CFR 211.84(b), (d) | samples of each lot of each shipment; at least an identity test per component | shell lots through receipt and QC (reused) |
| 21 CFR 211.186(a), (b) | master record per product and batch size, prepared and independently checked; complete instructions, specs, theoretical yield | formulation with preparer, checker, QA approval (PR-02) |
| 21 CFR 211.188(a), (b) | batch record: each significant step, dates, equipment, lots, weights, IPC results, area inspection, yield, labelling, sampling, persons | generated batch from the formulation (reused) |
| 21 CFR 211.192 | production record review; investigation of discrepancies | review by exception, deviations (reused) |
| 21 CFR 11.10, 11.50, 11.70, 11.100, 11.200 | controls for closed systems, signature manifestation and linking, unique signatures, components | kernel (reused) |
| Schedule M Part I 17.3.6 (SM-11) | authorised master formula per product and batch size | formulation approval |
| Schedule M Part I 17.3.8, 17.3.9 (SM-13, SM-14) | batch processing and packaging records from the approved documents; no transcription | batch generation |
| Schedule M Part I 18.2.3, 18.4.6, 18.5.10 (SM-17) | yields and reconciliation | CTRL-YIELD, CTRL-MATERIAL-RECON, CTRL-PRINTED-RECON |
| Schedule M Part I 18.4.1-18.4.2, 18.5.2-18.5.3 (SM-18) | identification and recorded line clearance | CTRL-LINE-CLEAR-START/END |
| Schedule M Part I 14.16, 14.17 (SM-20) | only QC-released, in-date starting materials | MATERIAL_LOT check against the lot register |
| Schedule M Part I 18.3 (SM-59), Part III (SM-53) | cross-contamination prevention; dedicated facilities for penicillins, cytotoxics, hormones | plant rules (reused) |
| Schedule M Part VIII 2.3, 2.4 | critical mixing, blending, drying parameters in the master and recorded; product-specific fluid-bed bags for potent products | process blocks; equipment data; N: COAT-PELLET-FB, PROC-PELLET-LAYER record the same |
| Schedule M Part VIII 5 | empty shells are a drug component, stored away from heat and moisture | shell lots; storage condition on the item (IN-37) |
| Schedule M Part VIII 6.1, 6.2 | printing segregated, edible inks; QC approval after printing before packaging | N: PROC-CAPS-PRINT + G-17 hold point (IN-37) |
| Schedule M Part VIII 7.1, 7.3, 7.4 | rogue capsules removed and an independent recorded check; strips inspected; periodic leak test | CTRL-LINE-CLEAR-*, PACK-*, PACK-LEAK (IN-38) |
| EU GMP Part I Ch. 4, 4.10, 4.11 | integrity controls over the retention period; batch documentation kept 1 year after expiry or 5 years after certification | kernel retention (reused) |
| EU GMP Part I Ch. 5, Principle; 5.31; 5.45 | production follows defined procedures and the authorisations; each batch in a delivery handled separately; packaging suppliers treated like starting materials | MBR, lot receipt (reused) |
| EU Annex 11, clause 3 | formal agreements with service providers | outside the software; nothing to build |

Not binding, so not built: Schedule M Part VIII 3.8's 30-minute interval is written for compression only (capsule
filling intervals are the product's value, as 211.110 leaves them); Part VIII 7.2 (isolated packing) names potent and
beta-lactam *tablets* only. EU Part I and Annex 11 are otherwise worded "should" (Q2).

## 5. Slice order

Each slice: tests named by control ID, CI green, one review, squash-merge, a few lines to the lead.

| Slice | Content | Done when | Depends on |
|---|---|---|---|
| C1 Powder on an automatic dosator (data) | capsule catalogue module `CAPSULES_CATALOGUE` (shared OSD blocks by reference + PROC-CAPS-FILL v2, POLISH, IPC-CAPS-*); recipe-core tests: a powder formulation from the catalogue validates and its generated batch runs on the generic simulator | `[PR-03][IN-37]` tests green; Tablets catalogue unchanged | none |
| C2 Edition skeleton | `ebmr_capsules`, edition value, thin apps on the host, CAPSULES badge, catalogue load, per-edition trace | powder capsule from catalogue to released lot through the screens (as S11b) | I-0, shared change 1 |
| C3 Post-fill and packing | checkweigher, inspection, printing with the QC hold point, banding for US OTC, blister/strip/bottle | a printed, banded OTC capsule batch packed and released | C2 |
| C4 Multiparticulates | extrusion-spheronisation, layering, pellet coating, pellet and mini-tablet dosing, combinations; two-stage dissolution | a delayed-release pellet capsule batch released | C2 |
| C5 Liquid and semi-solid fill | liquid filling, band sealing, seal leak test | one liquid-filled batch released | C3 |
| C6 Plate filling and containment | manual/semi-automatic plates; a beta-lactam product on dedicated rooms and equipment | the plant-rule refusals proven in the capsule edition | C2 |
| C7 Edition exit | controls tagged `capsules`, trace, one golden batch per form, browser suite, one review pass | trace green for the edition | C1-C6 |

C1 needs nothing from anyone and starts on approval. C3-C6 can overlap in their own worktrees (at most 2-3 agents).

## 6. Simplicity review

| Considered | Decision | Why |
|---|---|---|
| New field types (checkweigher, seal check, multi-station fill) | none | section 2: each is existing types |
| Capsule edition modules (code, `cap.*` tables) | none | no capsule state lives outside a step |
| Own server copy or own server features | no; thin apps on the shared host | copying ~100k lines would drift; an edition flag inside the Tablets app would mix editions (ADR 0001) |
| Own rule table | no | Part VIII is shared with tablets; the capsule-specific clauses are fields, not market-ranked values |
| Copying granulation, blending, packaging blocks into a capsule set | no; referenced | one block, one version, one approval |
| One block per filling machine type | no; one automatic filling block, method as CHOICE and equipment class | the recorded data are the same; separate blocks only where the data differ (plates, multi-station, liquid) |
| Per-block SQL guards, simulators, golden fixtures | no | decision 0026 O-3: one generic simulator and golden test |
| New platform permission codes | none | no new act |
| Net-content per-capsule calculation in the batch record | not built | QC's release record covers it (section 2) |

## 7. Risks and open questions

**Risks**
- C2 waits on Injectables I-0 (shared host) and on the shared edition value. Mitigation: C1 is data-only; ask the
  lead for one shared migration that adds every new edition value at once.
- The capsule seeds sit in recipe-core's shared seed folder. Moving them would change `SEED_CATALOGUE`; C1 only adds
  the capsule catalogue export and leaves the Tablets exports byte-identical.
- New blocks shared later by tablets (pellet blocks for MUPS tablets): offered to the Tablets session through the lead,
  not added to its catalogue by this edition.

**Open questions (lead or owner)**
- Q1 (lead): adopt the shared host from I-0 for `apps/capsules-*` (recommended) rather than an edition flag in the
  Tablets app.
- Q2 (owner): EU GMP Part I and Annex 11 are written in "should" and binding through the EU directive. Rule 1 read
  literally keeps only their "must/shall" sentences (section 4). Default: as written here, since kernel controls
  already cover the rest.
- Q3 (lead): reserve a migration range for the `cap` namespace (expected to stay empty; reserved so the first
  migration, if any, cannot clash).
- Q4 (lead): the shared changes of section 1 (edition value, controls' `editions` list, per-edition trace).
- Q5 (owner): dry-powder-inhaler capsules out of scope. Default: out.
- Q6 (owner): the two methods added to the list: metal detection, enteric coating of filled capsules. Default: in.
