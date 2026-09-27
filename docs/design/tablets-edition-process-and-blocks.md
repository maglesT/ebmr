# Tablets edition: process model and building-block specification

Scope: the process and building-block layer of the TABLETS edition of the eBMR (a separate product from the Injectables edition). It covers direct compression, wet granulation (high shear and fluid bed), dry granulation (roller compaction), film and sugar coating, bilayer tablets, and blister, strip and bottle packaging with secondary/tertiary packing and serialisation. The MBR designer composes any tablet master record from the typed blocks below; no product-specific code exists.

**Inputs:** research/tablets.json (29 unit operations, 27 calculations, pharmacopoeial references); digest/_blocks-tablets.json (21 edition blocks) and digest/_blocks-both.json (39 kernel blocks); research/sample-bmr-analysis.md (user's example paper BMR: Atorvastatin 40 mg film-coated tablets made by wet granulation, batch of 2,00,000); the control catalogs digest-production.md (PR-xx), digest-india.md (IN-xx) and digest-data-integrity.md (DI-xx); official texts in primary/ (21 CFR 211, EU GMP Ch.4 (2011), Ch.5 (2015), Revised Schedule M G.S.R. 922(E)).

**Precedence.** The control catalogs are authoritative. Where the block JSON or research JSON is looser than a catalog control, the catalog wins and the difference is noted in the block (example: the block JSON says a missed compression IPC "flags" output for evaluation; PR-29 [T] and guardrail 33 say output since the last passing check is put on hold, so the block holds it).

**Market set.** Every batch is made under an Indian licence, so India is always in the market set; US and/or EU are added per batch or packaging order (IN-52). The engine applies the strictest resolved value for the set and records which market governed it.

**Keys used in this document**
- Type: **ENFORCED** = engine behaviour no tenant, site, MBR or admin can weaken. **CONFIGURABLE** = safe default plus allowed range (never looser than the resolved rule). **DESIGN-CHOICE** = product decision beyond the regulatory text.
- Value origin in configuration options: **[R]** value comes from a regulation or pharmacopoeia; **[D]** design default with no regulatory number behind it; **[P]** must come from the customer's validation, registration or process data (no default is shipped).
- Citation markers (same as the catalogs): no mark = checked in primary/ during this digest or in the cited catalog; **(s)** = secondary source only; **(u)** = unverified.
- Confidence for pharmacopoeial values: **High** = consistent across research and well-established harmonised text; **Medium** = consistent with research or reliable recollection but not re-read in an official text here; **Low** = recollection only or sources conflict. No pharmacopoeia text was available in primary/, so no compendial value in this document is marked "checked"; each must be confirmed against the current USP-NF, Ph. Eur. and IP 2026 before a rule set is released for GMP use.
- Paraphrase only: nothing below quotes a regulation.

---

## A. Process variants and ISA-88 procedures

### A.1 Model conventions
- **Procedure** (ISA-88): one processing procedure per batch = the Batch Manufacturing Record (BMR), keyed by product, strength and batch size (PR-01, IN-13(a)). Packaging is a separate procedure per packaging order or part-batch = the Batch Packaging Record (BPR), keyed by product, pack size and pack type and linked to the bulk batch (PR-01, IN-14, IN-16, EU 4.21).
- **Unit procedure (UP)** = a manufacturing stage bound to a unit or room (e.g. "Granulation in RMG-02"). Each UP is rendered as a stage frame (block K-02) that records commencement, completion, rooms/equipment, the person responsible for the stage (IN-15) and the stage yield.
- **Operation (OP)** = an ordered group of steps inside a UP (e.g. "Wet massing").
- **Phase** = one block instance (e.g. "record impeller speed", "timer: mix 10 min", "LOD loop").
- The executed record instantiates exactly one path. Variant choices that are fixed for the product (coating type, press type) are resolved at issuance and shown as fixed; run-time choices (e.g. "add extra IPA if necessary") are recorded conditional branches (K-17).

### A.2 Variant catalogue

| Code | Variant | What changes in the procedure | Tablet-specific control points |
|---|---|---|---|
| DC | Direct compression | No granulation/drying UPs; blending is the only homogenisation step | Blend uniformity plan carries more weight; segregation risk during hold and transfer |
| WG-HS | Wet granulation, high-shear mixer granulator (RMG) with fluid-bed or tray drying and dry sizing | Adds binder preparation, wet massing with endpoint, wet milling, drying loop, sizing | Binder use-by; endpoint (power/torque/time); LOD endpoint loop; time and temperature CPPs on mixing and drying (IN-13(c)) |
| WG-FB | Fluid-bed (top-spray) granulation, granulation and drying in one unit | Spray granulation and in-situ drying replace RMG + separate dryer | Spray rate, atomisation pressure, inlet/product temperature; FBD filter-bag control (IN-36(d)) |
| DG-RC | Dry granulation by roller compaction (slugging as legacy option) | Pre-blend, compaction, integrated milling, optional fines recycle | Roll force/gap; periodic ribbon checks; recycled-fines limit |
| UNC | Uncoated tablets and sub-types (scored, chewable, dispersible, orodispersible, soluble, effervescent) | No coating UP; sub-type selects disintegration rule and environment limits | Disintegration limits differ by sub-type (Section E); effervescent/hygroscopic products use the HYG mode |
| FC | Non-functional film coating (aqueous or organic) | Coating suspension preparation and pan coating UPs | Weight-gain endpoint; suspension use-by; filtered pan air, room T/RH (Sched M VIII 4.1-4.2) |
| FC-F | Functional film coat (gastro-resistant, modified release) | As FC, plus a validated minimum weight gain and a functional IPC | Minimum weight gain is a CQA surrogate; acid-stage disintegration or dissolution link; for US controlled-release products a release-rate result per active before release (PR-54 [T]) |
| SC | Sugar coating | Multi-phase coating (seal, sub-coat, smoothing, colour, polish), many manual applications | Every application recorded; phase weight gains; uniformity of mass (Ph. Eur. 2.9.5) does not cover sugar-coated tablets, so content uniformity applies (Section E) |
| BL | Bilayer / multilayer | Two (or more) blends; layered compression | Hopper-to-blend binding per layer; layer-only weight samples kept apart from full-tablet statistics |
| CM | Continuous manufacturing (ICH Q13) | Batch defined by quantity or run time; RTD-based tracking; PAT diversion | Not specified here: out of v1 scope pending the open question in tablets.json (continuous manufacturing scope) |
| PK-BL / PK-ST | Blister (thermoform or cold-form) / strip packing | Packaging procedure | Independent recorded equipment check before each batch (Sched M VIII 7.1); pocket vacuum leak test (VIII 7.4) |
| PK-BT | HDPE bottle: count, desiccant, cap, induction seal, label | Packaging procedure | Count, desiccant, torque, seal; roll-label reconciliation (no waiver for India, IN-17) |
| PK-SEC / PK-TER | Cartoning with leaflet and overprint; shipper and pallet | Packaging procedure | Checkweigher and code-reader challenges; EU anti-tampering device where required |
| PK-SER | Serialisation and aggregation; India Schedule H2 QR | Packaging procedure, market-dependent | Market profile per packaging order (PR-42; India C.2) |
| POT | Potent, hormonal or cytotoxic mode (cross-cutting) | Inserts containment, PPE and decontamination steps; restricts rooms | Negative-pressure cubicles only (Sched M VIII 1.10; IN-26); product-dedicated FBD bags and tooling where flagged (IN-36(d), PR-27) |
| HYG | Hygroscopic, moisture-sensitive or effervescent mode (cross-cutting) | Adds product RH limits and open-exposure timers to every open-handling step | Room RH checks (IN-39); exposure timers (K-15); desiccant packaging |

### A.3 Standard unit-procedure library
Block codes refer to Section B. "Output" lists the container type, yield checkpoint, hold timer and gate each UP normally carries.

| UP | Unit procedure | Operations in order | Principal blocks | Output |
|---|---|---|---|---|
| UP-00 | Batch initiation | Issue record from effective MBR; receive record; resolve market set and rule sets; link planned deviations/changes | K-01, K-03 | Issued BMR |
| UP-10 | Dispensing (one BOM section per stage, e.g. granulation BOM, coating BOM) | Booth clearance and environment; balance pre-use check; potency/assay/LOD calculation and its verification; dispense actives; dispense excipients; kit labels; remnant return; transfer to production | K-10, K-11, K-09, TB-01, K-07, K-14, K-22, K-23, K-15 | Dispensed kit; dispensing accountability; dispensed-material hold timer |
| UP-20 | Sifting | Equipment and screen issue; pre-use screen check; sift each material; oversize/residue examination; post-use screen check; output weighing | TB-02, K-04, K-22, K-18 | Sifted material; sifting yield |
| UP-30 | Wet granulation, high shear | Charge-in; timed dry mix; binder preparation (parallel branch); timed binder addition; conditional extra fluid; wet massing to endpoint; wet milling; transfer to dryer | K-08, K-04, K-15, TB-03, K-17, TB-04, TB-02, K-06 | Wet mass; wet-mass hold timer |
| UP-35 | Fluid-bed granulation | Filter-bag check; charge-in; binder preparation; spray granulation; in-situ drying with LOD loop; unload | TB-05, K-08, TB-03, TB-04, K-17, K-22 | Dried granules; granulation yield |
| UP-36 | Dry granulation | Pre-blend; roller compaction with periodic ribbon checks; milling; fines recycle; output | TB-07, TB-06, TB-11, TB-02, K-22, K-18 | Granules; yield |
| UP-40 | Drying (FBD or tray) | Filter-bag ID/wash/integrity; drying cycle; LOD loop; bag post-use check; output | TB-05, K-06, K-17, K-22, K-18 | Dried granules; drying yield; dried-granule hold timer |
| UP-50 | Sizing / dry milling | Pre-use screen check; milling; post-use screen check; output | TB-02, K-22, K-18 | Sized granules; milling yield |
| UP-60 | Blending and lubrication | Charge granules and extragranular materials (proportional adjustment only if the MBR allows); optional rework/recovered-material addition; pre-lubrication blend; lubricant sifting; lubrication; blend-uniformity sampling; output; optional QA gate | K-08, TB-01, TB-08, TB-07, TB-02, K-12, K-22, K-18, K-16 | Lubricated blend; blending yield; blend hold timer |
| UP-70 | Compression | Room/cubicle clearance and environment; tooling issue and pre-use inspection; press set-up incl. weight-control settings; start-of-run device challenges; first-off and station-wise start check; run with periodic IPC per side; rejects and stoppages; end-of-run checks; tooling post-use inspection and return; count by weight, yield; QC sample; QA gate | K-10, K-11, TB-09, TB-10, TB-17, TB-11, TB-12..TB-15, K-22, K-23, K-18, K-12, K-16 | Cores (coated products) or tablets; compression yield; core hold timer; gate "approved for coating" or "released for packing" |
| UP-75 | Bilayer compression | As UP-70 with layer binding and layer-weight checks | TB-16 plus UP-70 blocks | As UP-70 |
| UP-80 | Film coating | Suspension preparation (use-by); pan clearance; core load and core average weight; pre-warm; spraying with periodic parameter log and weight-gain loop; drying/cooling; output; coated-tablet IPC (DT, functional test); QA gate | TB-03, K-10, TB-18, K-17, K-22, K-18, TB-15, K-16 | Coated tablets; coating yield; coated-bulk hold timer |
| UP-81 | Sugar coating | Phase loop (seal, sub-coat, smoothing, colour, polish), each application recorded | TB-03, TB-18 (SC mode), K-17 | As UP-80 |
| UP-85 | Tablet printing / laser marking | Marking set-up; periodic mark checks; post-printing QC approval | TB-19, K-16 | Printed tablets (QC-approved) |
| UP-90 | Visual inspection and sorting | 100% sort (manual or vision); AQL; reject categorisation; destruction or rework quarantine | TB-20, K-23, K-22 | Inspected bulk; inspection yield |
| UP-95 | Bulk packing, hold and release for packing | Container-wise weighing and count by weight; overall manufacturing yield and reconciliation; bulk QC sample; hold; stage sign-off; QA gate | K-22, K-18, K-12, K-15, K-26, K-16 | Bulk lot in quarantine; gate "released for packing" |

Packaging procedure (one BPR per packaging order or part-batch):

| UP | Unit procedure | Operations in order | Principal blocks |
|---|---|---|---|
| UP-P10 | Packaging order start | Issue BPR linked to bulk batch; issue printed and primary materials with specimens; issue bulk (count by weight) | K-01, K-19, K-15, K-22 |
| UP-P20 | Line clearance and independent equipment check | Packaging checklist clearance; independent second-person check that no rogue tablets/foils remain (blister/strip/counting equipment); environment | K-10, TB-21, K-11 |
| UP-P30 | Line set-up and first-off | Format parts and materials scan; sealing/forming parameters; coding data transfer and first-print approval; vision/reader challenges | TB-21 or TB-23, K-20 |
| UP-P40 | Primary packaging run | Periodic leak test, print and seal checks, reel changes, stoppages, unusual events | TB-21, TB-22 or TB-23, K-20, TB-24 |
| UP-P50 | Secondary packaging | Cartoning, leaflet, overprint, checkweigher, anti-tampering device | TB-24, K-20 |
| UP-P60 | Serialisation / market codes | Commissioning, verification, aggregation; India H2 QR | K-21 |
| UP-P70 | Tertiary packaging | Shippers, SSCC labels, pallets | TB-24 |
| UP-P80 | Finished-pack examination and samples | Label examination during finishing and representative end-of-run examination; QC, reserve and stability samples | TB-24, K-12 |
| UP-P90 | Reconciliation and close-out | Bulk tablet, printed-material and serial reconciliation; destruction of batch-coded leftovers; counted returns; post-use line inspection | K-18, K-19, K-21, K-23, K-10 |
| UP-P99 | Packaging record approval | Approval by the person responsible for packaging; then batch review and per-market disposition | K-26 |

### A.4 Typical sequences per variant
Square brackets = optional or product-dependent. Every UP runs inside a K-02 stage frame, starts with clearance, equipment status and environment checks (K-10, K-09, K-11) and ends with the stage sign-off (K-26); these are not repeated below.
- **DC:** UP-00 > UP-10 > UP-20 > UP-60 (pre-blend + lubrication) > UP-70 > [UP-80/81] > [UP-85] > [UP-90] > UP-95 > packaging.
- **WG-HS:** UP-00 > UP-10 > UP-20 > UP-30 > UP-40 > UP-50 > UP-60 > UP-70 > [UP-80/81] > [UP-85] > [UP-90] > UP-95 > packaging.
- **WG-FB:** UP-00 > UP-10 > UP-20 > UP-35 > UP-50 > UP-60 > UP-70 > ... as WG-HS.
- **DG-RC:** UP-00 > UP-10 > UP-20 > UP-36 > UP-60 > UP-70 > ... as WG-HS.
- **Sub-lots:** when the granulator is smaller than the blender, UP-30/35/36 and UP-40/50 repeat per sub-lot (split) and merge at UP-60 (K-25); a merge is blocked if any sub-lot has a failed IPC, an open exception or an expired hold.
- **Bilayer:** UP-10 dispenses two BOM sections; UP-20..UP-60 run once per layer blend; UP-75 replaces UP-70.
- **FC-F:** UP-80 with a mandatory minimum weight gain and a functional IPC (TB-15 gastro-resistant mode, or dissolution via LIMS).
- **Blister/strip line:** UP-P10 > UP-P20 > UP-P30 > UP-P40 > UP-P50 > [UP-P60] > UP-P70 > UP-P80 > UP-P90 > UP-P99.
- **Bottle line:** UP-P10 > UP-P20 > UP-P30 (TB-23) > UP-P40 (TB-23) > [UP-P50] > [UP-P60] > UP-P70 > UP-P80 > UP-P90 > UP-P99.
- **One bulk batch, several markets:** one BMR; one BPR per market-specific packaging order (part batch), each with its own artwork, codes, reconciliation and disposition (PR-56; production catalog section (b)).

### A.5 Cross-cutting modes
- **POT** (set from the product hazard class, IN-27): inserts PPE, containment-check and decontamination steps (K-03, K-05); restricts rooms to negative-cascade cubicles (IN-26) and equipment/parts to dedicated items (PR-27: punches and dies; FBD bags per IN-36(d)); isolated area for packing potent or beta-lactam uncoated tablets (Sched M VIII 7.2; IN-38(d)).
- **HYG:** product RH/T limits on every open-handling step (K-11) plus maximum open-exposure timers (K-15); bulk exposure timer on packaging lines.
- **Light-sensitive:** lighting checklist item (K-05) at each open-handling step.
- **Continuous manufacturing:** not specified (v1 scope open).

### A.6 The user's sample BMR as an instance (coverage check only; not a template)
Atorvastatin 40 mg film-coated tablets, 2,00,000 tablets, WG-HS + FC: UP-00; UP-10 with separate granulation and coating BOM sections and a salt-to-base potency calculation; UP-20; UP-30 with an IPA-based binder and an optional extra-IPA branch; UP-40 with the LOD 2.0-3.5 % loop ("redry if required and repeat"); UP-50; UP-60; a rework addition (at most 3 % of batch, source at most 3 months old) at the stage the MBR defines (TB-08); UP-70 on a double-sided press with left/right IPC streams; gate "approved / not approved for coating"; UP-80 with the coating parameter ranges; UP-90 inspection with rejects and destruction; UP-95 with gate "release for packing". Section F maps every element.

---
## B. Building-block catalog (Tablets edition)

### B.0 Conventions
- 50 blocks: 26 shared kernel blocks as used by the Tablets edition (K-01..K-26, with their tablet presets) and 24 edition blocks (TB-01..TB-24). Kernel blocks from _blocks-both.json were merged where they differ only in field type (e.g. choice, free text and attachment became K-05), and edition blocks from _blocks-tablets.json were merged where they share one control pattern (e.g. binder and coating solution preparation became TB-03; press reject gate, de-duster and metal detector became TB-17).
- Each entry gives: purpose; configurable options with default and allowed range; fields captured; engine-enforced rules (not configurable); controls implemented; sources.
- An MBR author can only compose blocks and set their declared options; enforcement logic cannot be changed from the MBR (guardrail 20).

**Kernel services applied to every block (always on, not separate blocks)**

| Service | Behaviour in every block | Controls |
|---|---|---|
| S-1 E-signatures | Every signature point is a full e-signature with meaning, printed name, role, date/time with offset, bound to a hash of the signed content; a later permitted change supersedes it | PR-14, IN-10, DI-35, DI-36, DI-37, DI-38 |
| S-2 Audit trail and corrections | Append-only trail of create/change/void/sign; corrections keep the original visible, need a reason and re-signature | PR-12, IN-06(d), DI-22, DI-23, DI-24 |
| S-3 Verification / witness | Any field or step can require a second person (concurrent witness or subsequent verification); the verifier must be a different authenticated person; mandatory where a rule requires it (dispensing, charge-in, yield, critical manual data); reduced to one checking person only for operations done by qualified automated equipment under 211.68 | PR-14, PR-20, PR-21, PR-31, DI-17, DI-30 |
| S-4 Exceptions and deviations | System-detected breaches (limit, time, status override, interface failure, late entry, missed IPC) always create exceptions; operators can raise one at any step; an in-line deviation is the only way around the defined flow | PR-08, PR-13, PR-49, PR-50, IN-20, DI-26 |
| S-5 Training and role check | Role, training currency and approved-technical-staff status checked at the moment of each action | PR-15, IN-04, DI-17, DI-21 |
| S-6 Trusted time and commit | Server time for every action; value committed before its limit evaluation is shown; late entries only through a flagged late-entry path | PR-11, DI-27, DI-28 |
| S-7 UoM and rounding | Units from a controlled catalogue with dimension checking; conversions only via the service; full precision stored; rounding only for display and limit comparison, using the rule attached to the limit | DI-02, DI-33 |
| S-8 Compendial rule-set service | Versioned master data per pharmacopoeia and edition (Section E); every evaluation stamps the rule-set ID and version | IN-33, IN-34, DI-10 |
| S-9 Genealogy | Every consumption, split, merge, recovery and packaging edge committed atomically with its business event | PR-57, IN-07(d), IN-29 |
| S-10 Market-profile resolution | Resolves the strictest value across India and the batch's markets and records the governing market | IN-52, PR-56 |
| S-11 Equipment cleaning and logbooks | Cleaning execution records and logbooks live in the equipment module; blocks read status and write use entries | PR-23, PR-24, IN-25 |

### B.1 Kernel blocks used by the Tablets edition

#### K-01 Batch record issuance and header
- **Purpose:** Create the executed BMR/BPR from an Effective master for one batch, fix its identity, market set, resolved rule sets and header data (the header is rendered on every page and printout).
- **Config:** batch-number format [D: site-product sequence; any format with uniqueness]; approved batch sizes [R: discrete sizes listed in the master; no free scaling, PR-01]; market set [R: India always + export markets]; header fields [D: product, strength, dosage form, batch no., batch size in units and kg, MBR ID/version/effective date, master-formula reference, manufacturing licence no. and form (plus loan-licence no. where applicable), marketed-by, storage statement, shelf-life rule, mfg and expiry dates, issued-by/received-by]; receipt acknowledgement by Production [D: ON]; batch purpose flag (commercial, PPQ, exhibit) [D: commercial]; expiry rule: shelf life from the product master, start-of-shelf-life event [P: QA-approved product rule, PR-43/F-9], optional cap "not later than the earliest expiry of input lots flagged as expiry-capping" (e.g. the API) [D: OFF; allowed ON], date format and end-of-month convention per market [P].
- **Captures:** header values; issuance e-signature ("issued, reproduction verified"); Production receipt signature; resolved rule table with governing market; allocation-register entry.
- **Engine rules:** only an Effective master valid for every market in the set can be issued; the instance hash is stored; batch numbers are unique and never reused, including after voiding; an allocation-register entry (date, product, batch size) is written at once (IN-18); expiry is computed, never typed (PR-43); if an expiry-capping input lot carries only a retest date, issuance of the expiry date is blocked until QA records how the retest date is treated; a change of market set before release re-resolves the rules and forces QA review (IN-52).
- **Implements:** PR-01, PR-04, PR-09, PR-10, PR-43, PR-56, IN-13(a), IN-18, IN-52, DI-04, DI-10, DI-42.
- **Sources:** 21 CFR 211.186(a), 211.188(a), 211.137; EU Ch.4 4.17, 4.20 lead-in; Sched M Part I 17.3.10.8-17.3.10.11 (P~).

#### K-02 Unit-procedure frame and stage summary (proposed kernel addition)
- **Purpose:** The container for each stage. It captures the stage header and produces the stage and batch summary from execution data, so nothing in the summary is typed. This element is not in _blocks-both.json; it is proposed as a kernel addition because both editions need it.
- **Config:** stage name and code; permitted rooms/lines and equipment classes; role of the person responsible for the stage [R: mandatory for India, IN-15]; yield checkpoint link; summary items shown.
- **Captures (automatic):** commencement and completion date/time (first and last step events); rooms and equipment used with the previous product and batch in each (from logbooks); person responsible (e-signature); stage yield and its limits; rework generated and rework added; exceptions and deviations raised in the stage; a derived status "completed per MBR" or "completed with deviations (list)".
- **Engine rules:** summary fields are derived and cannot be edited; "completed per MBR" is true only when every step is executed or system/authorised N/A and no exception in the stage is open or dispositioned as a deviation; "deviation sheet attached Y/N" is derived from the linked deviation list.
- **Implements:** PR-16, PR-24, IN-15, IN-07, DI-26; 211.188(b)(1)-(2); EU 4.20(b).

#### K-03 Instruction and acknowledgement
- **Purpose:** Show approved instructions, safety/PPE notes and SOP links, and capture read or performed acknowledgement.
- **Config:** rich text with bound parameter placeholders; media; acknowledgement type (read / confirm-performed); signature level; SOP link; translations; display conditions. Tablet presets: PPE and containment notes inserted automatically for POT products (IN-27); light-sensitive and HYG precautions; optional glossary link.
- **Captures:** acknowledgement with user and server time; SOP version effective at execution.
- **Engine rules:** text only from the approved master version; placeholders resolve from approved parameters; the SOP version in force is written into the record.
- **Implements:** PR-03 (item 19 special precautions), IN-27, DI-10.
- **Sources:** 211.186(b)(9); EU Ch.4 4.18(g).

#### K-04 Process parameter record
- **Purpose:** Record a measured process value with unit and evaluate it against tiered limits (e.g. impeller speed, inlet air temperature, pan speed, atomising air pressure, machine speed).
- **Config:** parameter code; unit from the UoM catalogue; precision; target; tiers (registered / internal action / alert) with inclusive or exclusive bounds [P]; criticality class [D: critical until classified, DI-07]; source (device / automation / manual); manual-entry accuracy check method (second person or validated device) for critical values; N/A allowed with reason [D: not allowed for CPPs].
- **Captures:** value, unit, source, device ID, time, performer, verifier if required.
- **Engine rules:** out-of-limit values are stored as acquired, flagged, and raise an exception; a breach of a registered or action limit halts the dependent next step until someone opens a deviation (PR-08 default); every mixing, blending and drying step must carry at least time and temperature parameters with limits, or the master cannot be approved (IN-13(c), Sched M VIII 2.3); units are dimension-checked: a breaking-force parameter only accepts force units (N, kp), so a "kg/cm²" label (a pressure) is rejected, while a coating air pressure accepts kgf/cm², bar or kPa.
- **Implements:** PR-04, PR-08, IN-13(c), IN-36(a), DI-07, DI-30.
- **Sources:** 211.186(b)(9), 211.110(b); EU Ch.4 4.18(d)-(e); Sched M VIII 2.3 (P).

#### K-05 Observation capture (choice, checklist, text, event time, attachment)
- **Purpose:** Categorical checks (pass/fail, yes/no, list), checklists, remarks, externally sourced event times and attached evidence (balance or tester printouts, photos).
- **Config:** value sets and expected answers; per-item photo/comment on unexpected answer; verification per item or per list; free-text length; plausibility window for event times; attachment types and metadata. A standalone witness step (e.g. destruction witness) is a K-05 step with the verification option.
- **Captures:** each answer individually; event times as separate data fields; attachments with hash.
- **Engine rules:** no pre-filled answers; an answer other than the expected one creates an exception and, where configured, blocks the dependent steps; user-entered times never replace the server time; attachments are immutable and appear in review; paper printouts that are originals are true-copied promptly (DI-41); the designer warns when free text is used where a limit-checked field exists.
- **Implements:** PR-11, DI-28, DI-32, DI-41.

#### K-06 Automated equipment phase / Level-2 data exchange
- **Purpose:** Download setpoints and collect actuals, totals, trends and alarms from RMG, FBD/FBP, blender, tablet press, coater, blister/bottle lines and testers.
- **Config:** equipment class and recipe/phase ID; tag mapping; collected values (actuals, min/max over window, end-of-phase report); sampling interval; acceptance limits; alarm classes needing review; manual fallback path.
- **Captures:** values with provenance (system, tag, device, source time); recipe version actually used; alarms with raise/acknowledge times and comments.
- **Engine rules:** setpoints only from approved values, read back before start; interface loss, stale data or recipe mismatch raises an exception; fallback to manual only via the MBR path and flagged; one person confirms correct automated performance; GMP-critical alarms (e.g. compression-force excursions, checkweigher reject bursts) need an acknowledgement comment and appear in review.
- **Implements:** PR-14, DI-04, DI-31, DI-32, DI-49; 211.68(a)-(c).

#### K-07 Weighing and dispensing (gravimetric and volumetric)
- **Purpose:** Dispense each component into labelled containers for this batch within tolerance, and dispense liquids (purified water, IPA, ethanol) by mass or by volume with density conversion.
- **Config:** target source (formula line after scaling/potency adjustment, TB-01); tolerance [P: mandatory, no default; the designer warns when wider than ±0.5 % for actives or ±1.0 % for excipients, industry practice only (s)]; method (net with tare, weigh-by-difference, multi-container, whole-container issue); balance class and minimum-weight rule [D: ON]; lot proposal [R/D: oldest approved first; FEFO allowed with SOP rationale, PR-18]; density source for liquids (specification, lot CoA, measured); booth environment prerequisites; label template; verification mode [R: manual = second person; automated = at least one human verifier, PR-20].
- **Captures:** per container: lot, AR number, status, retest/expiry, gross, tare, net, balance ID, time, dispenser, verifier; totals vs target; remnant returns.
- **Engine rules:** lot must be released, within expiry and retest date, and the exact item/grade; identity by scan; quarantined, rejected, expired or retest-overdue lots are hard-blocked (PR-18, IN-23); for a batch with US or EU in the market set, an excipient lot without an identity-test result is blocked (IN-24(c)); balance must be calibrated, have a passed daily/pre-use check and suit the target (target at or above minimum weight) (IN-25(b)); weights come from the balance interface, manual keying is a flagged fallback needing verification; out-of-tolerance weights cannot be confirmed without an exception; each container label carries the four 211.101(b) items (component name/code, receiving/control number, quantity, destination batch with product name, strength and lot) plus a unique container ID; volume-to-mass conversion only by the engine.
- **Implements:** PR-18, PR-19, PR-20, PR-21, IN-23, IN-24, IN-25, DI-20, DI-30, DI-32.
- **Sources:** 211.101(b)-(c), 211.68; EU Ch.5 5.37-5.39; Sched M Part I 14.14, 14.18 (P).

#### K-08 Material identification and charge-in
- **Purpose:** Charge dispensed components or intermediates into the correct equipment, in MBR sequence, once each.
- **Config:** charge list; sequence (strict order / free within group); target equipment; partial charges; addition time constraints (via K-15); verification rule.
- **Captures:** container scans, time, performer, verifier.
- **Engine rules:** each container must belong to this batch and step and not be consumed; status re-checked at use; the step stays open until all required containers have been charged; manual charge-in needs a different verifier (automated addition: one verifier); at the press, hopper/container labels are scanned against batch and stage (IN-26(c), Sched M VIII 3.2).
- **Implements:** PR-21, IN-26(c), DI-30.
- **Sources:** 211.101(d); EU Ch.4 4.18(d); Ch.5 5.39.

#### K-09 Equipment identification and status check
- **Purpose:** Bind specific units (RMG, FBD, blender, press, coater, packaging line, balances, testers, moisture analyser, metal detector) to the step and prove fitness for use.
- **Config:** required class and capacity; permitted units; checks (qualification, calibration, preventive maintenance, cleaning level per changeover matrix, clean-hold expiry); dedication flags (product-contact parts, PR-27); cleaning-status verification by one or two persons [D: two, as in the sample "checked by / re-checked by"]; balance daily check requirement [R: ON, IN-25(b)].
- **Captures:** unit IDs, previous product and batch (from logbook), cleaning record reference, status snapshot.
- **Engine rules:** wrong class, overdue calibration/PM, "to be cleaned" or expired clean-hold blocks the step (IN-21, IN-25); unit in use by another batch cannot be bound; use entries are written to the logbook automatically; end of use sets "dirty" and starts the dirty-hold clock; a failed as-found calibration lists affected batches.
- **Implements:** PR-22, PR-23, PR-24, PR-27, IN-21, IN-25, DI-20.
- **Sources:** 211.67, 211.68(a), 211.105(b), 211.182; EU Ch.4 4.31.

#### K-10 Room/line status and line clearance
- **Purpose:** Before (and for packaging, after) each operation, confirm the room/line is free of previous product, materials and documents and in the right status.
- **Config:** checklist template per room/line type [R: checklist mandatory for packaging (PR-34); for processing a check is mandatory and the checklist format is D: ON]; photo evidence [D: OFF]; second verifier [D: ON; may be switched OFF only where the customer has not designated clearance a significant step (PR-26, PR-34; production catalog C-4, F-13); never OFF for the blister/strip/counting-equipment check, which TB-21 enforces]; optional QA verification (sample: "re-checked by QA", "QA approval to start stage"); start/end/changeover triggers.
- **Captures:** previous product/batch (system-filled), each item, performer, verifier, QA signature if configured.
- **Engine rules:** steps in the room/line cannot start until clearance is recorded and, when the verifier option is ON, verified by a different person; a failed item prevents the start; packaging orders cannot close without the post-use inspection (211.188(b)(6)); a line runs only one active order and displays product and batch (PR-35); each press needs its own cubicle unless every press in that room runs the same product or the press provides its own enclosed, air-controlled environment (IN-26(c), Sched M VIII 3.1); POT products only in negative-cascade rooms (IN-26, VIII 1.10).
- **Implements:** PR-25, PR-26, PR-34, PR-35, IN-21, IN-26.
- **Sources:** 211.130(e), 211.188(b)(6); EU Ch.4 4.18(c), Ch.5 5.40, 5.50-5.51; Sched M Part I 18.4.1-18.4.2, 18.5.2-18.5.3 (P).

#### K-11 Environmental condition check
- **Purpose:** Capture room temperature, RH and differential pressure at step start and during long steps (e.g. compression, coating, packaging of hygroscopic products).
- **Config:** parameters and limits from the room master, tightened by product limits (HYG mode) [P]; source (EMS/BMS or manual); timing (start, periodic, whole step window); action on excursion (block, or exception only).
- **Captures:** readings with instrument ID and source time; excursion log for the step window.
- **Engine rules:** manual readings are flagged and verified; an excursion always creates an exception and notifies Production and QA immediately (Sched M VIII 1.5); the room master validator rejects overlapping ΔP ranges for adjacent rooms (e.g. 5-15 Pa next to 15-30 Pa, Sched M VIII 1.14).
- **Implements:** PR-25, IN-39, DI-49.
- **Sources:** 211.42, 211.46; EU Ch.5 5.43; Sched M VIII 1.5, 1.14 (P); VIII 4.1 (coating area T/RH control).

#### K-12 Sampling
- **Purpose:** Take QC, IPC, blend-uniformity, reserve and stability samples with unique IDs, labels and LIMS requests ("intimate QA to draw sample" becomes a sample request event).
- **Config:** sample type; quantity and containers; sampling point (location, time, start/middle/end, per container); plan reference; label template; LIMS mapping; hand-over confirmation. Tablet presets: bulk/core QC sample; coated-tablet QC sample; finished-pack reserve sample [R: at least twice the quantity needed for all tests on the batch, final pack; retention = maximum over markets, IN-32/PR-44]; stability pull.
- **Captures:** sample ID, source container, quantity, sampler, time, receipt by QC.
- **Engine rules:** system-generated IDs; labels carry material name, batch, container number, sample number, sampler and date (IN-20(d)); sample quantities flow into yield and reconciliation; sampled units are never returned to the line (EU 5.59); missing or late samples are exceptions.
- **Implements:** PR-29, PR-37, PR-44, IN-20(d), IN-32.
- **Sources:** 211.110(b)-(c), 211.170; EU Ch.5 5.59; Sched M Part I 19.3(g), 19.6.6 (P).

#### K-13 IPC test with repeated readings and statistics
- **Purpose:** Generic IPC container (n readings per time point, grouped by stream) that TB-12..TB-15 and other tests (LOD, blend LOD, bulk density) specialise.
- **Config:** test and method reference; n per sample; grouping (time point, side, station, layer, track); limits absolute or relative to the computed mean; statistics; acceptance rule type (mean inside limits; every individual inside limits; no more than k beyond tier 1 and zero beyond tier 2); instrument link; reference to the approved retest rule.
- **Engine rules:** statistics computed at full precision; every reading retained; excluding a reading needs a documented invalidation linked to an investigation (DI-29); a retest is added, never substituted; a new attempt after a failing result is flagged; instrument ID and calibration stored; the rule-set version is stamped (DI-10).
- **Implements:** PR-29, IN-35, DI-10, DI-29, DI-32; 211.110(a)-(b).

#### K-14 Calculation
- **Purpose:** Derive values (potency-adjusted quantities, yields, counts, weight gain, statistics) with the sandboxed expression library (Section C).
- **Config:** expression; output unit and precision; limits on the result; formula display [D: shown]; verification [R: second person for manual yield calculations; one verifier for automated, 211.103].
- **Engine rules:** deterministic, unit-checked at design time; full precision for intermediates; no manual override; correcting an input recomputes, keeps the old result and flags dependent steps for re-verification; the trace (inputs, versions, result) is stored.
- **Implements:** PR-31, DI-33; 211.68(b), 211.103.

#### K-15 Timer, hold time and transfer
- **Purpose:** Enforce minimum/maximum durations inside steps (e.g. "mix 10 min at slow speed" = minimum and maximum mixing time; "add binder within 4 min" = maximum addition time) and hold times between stages; record material transfers (issued by / received by), including issue from stores against a requisition.
- **Config:** start/stop events; minimum, maximum, alert threshold; scope (within step, across UPs, across batches); behaviour at maximum (exception, or exception plus block); hold-time values per intermediate [R: mandatory for every intermediate and in-process material for India, IN-13(b); values P: from hold-time studies]; standard tablet holds: dispensed materials, binder solution, wet mass, dried granules, lubricated blend, cores, coating suspension, coated bulk, bulk before packaging, bulk exposure on the packaging line (HYG).
- **Captures:** event times (server), elapsed durations, hold start/stop per intermediate, transfer signatures.
- **Engine rules:** durations are computed from server timestamps, never typed; a step guarded by a minimum duration cannot be closed before it has elapsed; overrunning a maximum always produces an exception; use of an intermediate after its hold expiry is blocked unless QA dispositions; timers survive client and server restarts; each time limit references its validation source.
- **Implements:** PR-30, IN-13(b), IN-15, DI-27.
- **Sources:** 211.111; EU Ch.5 5.41; Sched M Part I 17.3.6, 17.3.8 (P).

#### K-16 QA hold point / stage gate
- **Purpose:** Hold the process until the quality unit has reviewed the evidence and approved or rejected an intermediate. Tablet presets: "Line clearance approved to start stage" [D: OFF]; "Blend approved for compression" [D: OFF]; "Cores approved for coating" (sample: approved / not approved for coating) [D: ON for coated products]; "Printed tablets approved by QC" [R: ON whenever UP-85 exists, Sched M VIII 6.2]; "Bulk released for packing" (sample) [D: ON].
- **Config:** position; evidence panel (IPC summaries per stream, LIMS results, yields, open exceptions, hold timers); authorised role and number of signatures (IPQA/QA, or QC for the printing gate); dispositions (approved, approved with conditions, not approved, hold).
- **Engine rules:** downstream steps locked until an authorised disposition is signed; approval is impossible while a required result is absent or failing, unless QA has documented a decision on that exception; "not approved" sets the intermediate to rejected and blocks its use in any batch.
- **Implements:** PR-29, PR-45, IN-37; 211.110(c), 211.22(a); Sched M VIII 6.2 (P).

#### K-17 Flow control: conditional branch, parallel branches, sub-procedure call, repeat-until loop
- **Purpose:** Express run-time decisions ("if necessary add extra IPA and record the weight"), concurrent work (binder preparation during dry mixing), reusable library elements (screen integrity check, LOD test, tooling inspection) and bounded loops (dry until LOD in range; spray until weight gain reached; sugar-coat applications).
- **Config:** branch conditions or operator-choice branches (allowed roles, mandatory reason); parallel join rule; library element and version; loop body, exit condition, maximum iterations and/or maximum elapsed time, action at maximum (exception + QA gate).
- **Engine rules:** branch conditions must be exhaustive and non-overlapping at design time; the branch taken and its data are recorded; untaken branches are marked N/A by the system; library versions are frozen at MBR approval; every loop iteration is retained in order and cannot overwrite another; exceeding the maximum always raises an exception; a loop may only exit on a parameter classed as a process endpoint (LOD, weight gain, endpoint power); the designer refuses any loop that exits on a release or acceptance test, so "re-blend until blend uniformity passes" cannot be modelled as a loop (a failing BU goes to investigation; re-blending is reprocessing under K-24).
- **Implements:** PR-13, DI-29, DI-34.
- **Sources:** 211.100(b), 211.115, 211.192; 21 CFR 11.10(f).

#### K-18 Yield and reconciliation
- **Purpose:** Compute actual yield vs theoretical at each checkpoint and reconcile inputs against good output, samples, rejects, reusable residue, losses and returns (Section D).
- **Config:** checkpoint; theoretical basis (formula total, actual charged, previous stage output) and "as-is" or "dry" basis; categories counted; expected (standard) yield % shown with its limits (EU 4.17(d); the sample's "standard 99.5 %") [P]; minimum and maximum % [P: mandatory]; reconciliation tolerance; yield definition (which categories count as actual yield); action on breach for the next step [D: continue once a deviation is raised and acknowledged; allowed: block until QA disposition].
- **Captures:** all quantities (pulled from other steps, not re-typed), theoretical, actual, %, unaccounted quantity, verifier.
- **Engine rules:** an MBR cannot be approved if a yield checkpoint lacks minimum and maximum limits; the engine computes (users cannot type a %) and one person verifies (two-person when manual, 211.103); a result below the minimum or above the maximum creates an exception requiring investigation and blocks release; if the MBR counts reusable residue ("rework generated") in yield, as the sample does, the engine shows both the good-output yield and the yield including residue (DESIGN-CHOICE, so losses are not masked).
- **Implements:** PR-31, PR-39, IN-17, DI-33.
- **Sources:** 211.103, 211.186(b)(6)-(7), 211.188(b)(7), 211.192; EU Ch.4 4.17(d), 4.20(g), Ch.5 5.44; Sched M Part I 18.2.3, 18.4.6, 18.5.10 (P).

#### K-19 Printed packaging material issuance and reconciliation
- **Purpose:** Issue printed lidding/strip foil, cartons, leaflets, labels and shipper labels under strict control and reconcile them.
- **Config:** items and artwork version per market; issue quantity rule (batch need + allowance [P]); counting method (roll counter, weigh-count, manual count with verification, foil by length or mass); reconciliation limits per item [P: narrow, preset, based on historical data]; specimen capture (physical specimen default for EU packs; image allowed).
- **Captures:** issued, used, set-up waste, damaged, batch-coded destroyed, uncoded returned, specimens; discrepancy.
- **Engine rules:** issue is limited to released lots carrying the artwork version the master names for that market (scan-checked); the balance must close within limits or an exception requiring investigation opens and release is blocked; batch-coded surplus is destroyed (K-23), never returned; the 211.125(c) roll/cut-label waiver is never offered, because India is always in the market set and Schedule M has no waiver (IN-17 stricter than PR-39 default); a packaging master cannot be approved without reconciliation limits.
- **Implements:** PR-32 (boundary), PR-33, PR-39, PR-40, IN-14, IN-16, IN-17, IN-24(d).
- **Sources:** 211.122, 211.125, 211.186(b)(8), 211.188(b)(8); EU Ch.4 4.21(f),(h), Ch.5 5.61-5.62.

#### K-20 Online printing, code verification and inspection-device challenges
- **Purpose:** Transfer variable data (batch, mfg date, expiry, MRP for India-domestic packs, GTIN/NDC) from the record to printers/coders, verify prints, and challenge code readers, vision systems, checkweighers and missing-leaflet detectors.
- **Config:** field mapping and date formats per destination [R: India-domestic packs show mfg and expiry dates in plain uncoded form, IN-31]; devices; first-print approval role (IPQA); check frequency (start, interval, reel/format change, end; hand printing at a shorter interval, IN-22(a)); challenge types and triggers (start, after stoppage > site-defined duration, periodic, end).
- **Captures:** printed specimens/images at start and intervals (IN-16), challenge results per device and time, device events.
- **Engine rules:** no manual keying at the device; changing batch data after set-up voids the print job; a failed or missed challenge stops the dependent step, raises an exception and holds everything produced since the last successful challenge (IN-22(b)); a packaging master using cut labels cannot be approved without one of the four 211.122(g) controls.
- **Implements:** PR-36, PR-37, IN-16, IN-22, IN-31, DI-20.
- **Sources:** 211.122(g)-(h), 211.130; EU Ch.5 5.55-5.59; Sched M Part I 17.3.1, 18.5.4-18.5.9 (P).

#### K-21 Serialisation, aggregation and market codes
- **Purpose:** Apply and verify market-specific identifiers per packaging order.
- **Config (market profiles):** EU FMD: unique identifier (product code, serial number, batch, expiry; national reimbursement number where required) in a 2D DataMatrix, plus anti-tampering device (Reg. (EU) 2016/161 (s)); US DSCSA: product identifier (NDC, serial of up to 20 characters, lot, expiry) in a 2D DataMatrix on packages, linear or 2D on homogeneous cases (s); India Schedule H2: batch-level QR/barcode on the primary pack (secondary pack if space is insufficient) carrying batch number, mfg and expiry dates, manufacturing licence number, the unique product identification code, the brand name, the proper and generic name, and the manufacturer's name and address (S); scope: 300 listed brands from 1 Aug 2023; vaccines, NDPS and anticancer drugs from 1 Jul 2027; antimicrobials from 1 Jul 2028 (S; 2026 data elements U, India G-6); aggregation hierarchy; decommission reasons.
- **Captures:** serial pool request, commissioned/decommissioned (by reason)/aggregated counts, code grading, verification results, upload/hand-off confirmation; for H2, the generated payload and reader results.
- **Engine rules:** serials only from the authorised pool, each ending in a defined state; serial reconciliation closes with zero unexplained before packaging completion; release blocked if serial events are missing; code content is generated from batch data, never typed; encoded lot/expiry must equal the record values.
- **Implements:** PR-42, IN-31, India C.2 fields.
- **Sources:** secondary only for DSCSA, EU 2016/161 and Schedule H2 (see catalogs).

#### K-22 Output container registration, weighing and status labelling
- **Purpose:** Create uniquely identified containers of granules, blend, cores, coated tablets, reusable residue and bulk, with gross/tare/net, quarantine status and labels; convert bulk weight to tablet count.
- **Config:** container types and tare source [D: weighed tare; nominal tare only for validated container types]; numbering (container n of N); label template per stage; initial status [R: quarantine]; count-by-weight method (average weight source: e.g. mean of 20 or 100 tablets from the lot, or the run IPC average; recorded); bulk pack (e.g. double LDPE bags in HDPE drum, desiccant) per MBR; seal/tie number.
- **Captures:** per container: gross, tare, net, balance ID, container open and close time, stream (L/R side), label, status; totals in kg and calculated tablets.
- **Engine rules:** net = gross - tare computed by the engine; each container has a system-unique ID and a label printed from system data; quarantined containers cannot be consumed unless the MBR allows use pending results under QA-approved conditions; container open/close times are mandatory on compression and coating outputs because the IPC hold-back (TB-11) is container-level; filled but unlabelled containers are identified with name, strength, quantity and lot (211.130(b)).
- **Implements:** PR-22, PR-29, PR-38, PR-45; 211.105(a), 211.130(b); Sched M VIII 3.6.

#### K-23 Material return, waste and destruction
- **Purpose:** Record returns to stores, waste, rejects and destruction.
- **Config:** return reasons; waste/reject categories (set-up rejects, weight-control rejects, metal-detector rejects, dust and fines, IPC destructive samples, inspection rejects for destruction, packaging rejects, batch-coded leftovers); witness requirement [D: one witness from QA; the sample's "Production + QA" is allowed; witnessing is a design choice beyond 211.125(d)/EU 5.62, production catalog C-23]; destruction method.
- **Captures:** quantities (weight and count), container IDs, method, date, performer, witness(es).
- **Engine rules:** rejected or discarded tablets are held in identified containers with quantity recorded (Sched M VIII 3.7); returned material comes back with its own label and status; quantities feed reconciliation automatically; batch-coded packaging leftovers can only be destroyed; reusable residue is not a destruction category (it becomes a quarantined container for TB-08).
- **Implements:** PR-40, PR-46, IN-22(g), IN-35(f).
- **Sources:** 211.110(d), 211.125(d); EU Ch.5 5.62, 5.66; Sched M VIII 3.7 (P), Part I 14.31.

#### K-24 Reprocessing / rework gate (batch or lot level)
- **Purpose:** Allow a non-conforming batch, lot or intermediate to be reprocessed or reworked (e.g. 100% re-sorting after AQL failure, re-coating, re-milling and re-compression, re-packaging) only through an approved procedure. Addition of earlier material into a new batch is TB-08.
- **Config:** library of approved reprocessing sub-procedures; entry conditions (linked investigation/deviation, risk evaluation); additional testing plan; product-level disable (registration forbids).
- **Captures:** QA/QCU authorisation (before execution), procedure version, execution record, testing plan and results, genealogy.
- **Engine rules:** no entry without QCU authorisation referencing an investigation (211.115(b)) and a risk evaluation (EU 5.67; Sched M 14.32); the sub-procedure must be an approved master; the reworked output gets a new batch number linked to the parent(s) (Sched M 14.32; IN-18, IN-19(a)); a QC decision on additional testing is mandatory before release (EU 5.69; Sched M 14.34; PR-47); reprocessed material must meet specifications (211.165(f)).
- **Implements:** PR-47, IN-18, IN-19.
- **Sources:** 211.115; EU Ch.5 5.67, 5.69; Sched M Part I 14.32, 14.34 (P).

#### K-25 Sub-batch split and merge
- **Purpose:** Split a batch into granulation sub-lots or packaging part-batches and merge sub-lots, keeping genealogy.
- **Config:** allowed split/merge points; maximum sub-lots [P]; naming rule; merge conditions.
- **Engine rules:** each sub-lot has its own ID, record section and quantities; a merge is refused when a sub-lot has an open exception, a failed IPC or an expired hold, unless QA dispositions it; sub-lot quantities must add up to the parent.
- **Implements:** PR-57, IN-16; EU Ch.4 4.21 (part batch).

#### K-26 Production sign-off, batch review and disposition
- **Purpose:** Close stages and records with responsible-person approval, then quality review and per-market disposition.
- **Config:** sign-off points (each UP; processing record; packaging record); reviewer roles; review-by-exception use [D: full review until the confidence criterion is met, DI-26]; release interfaces.
- **Engine rules:** sign-off only when all steps are complete and exceptions acknowledged; a later correction invalidates the sign-off; the production-record review precedes QA review (IN-04(c)); a batch audit-trail review by someone who executed or verified no step of the batch is signed before disposition (DI-25); India: release only by the authorised person or named delegate, with head-of-QC approval (IN-05); US: QCU disposition, including a release-rate result for each active of a controlled-release tablet (PR-54 [T]); EU: external QP certification reference recorded (PR-55); disposition held per market (PR-56); release blocked while deviations, investigations, reconciliation discrepancies, the post-change evaluation (IN-03) or the QC decision on additional testing for rework/recovered batches are open (PR-47; PR-53 default). PR-53 allows a QCU/QP e-signed justification to release with an investigation still open, but never for reconciliation discrepancies or registered-specification failures; for India every deviation must at least be formally assessed (IN-05(c)).
- **Implements:** PR-16, PR-52, PR-53, PR-54, PR-55, PR-56, IN-03, IN-04, IN-05, IN-07, DI-25, DI-26, DI-39.
- **Sources:** 211.22, 211.192; EU Ch.4 4.20(i), 4.21(i); Sched M Part I 11.3.6-11.3.10, 18.2.2 (P).

### B.2 Tablets edition blocks

#### TB-01 Potency/assay/LOD-adjusted dispensing set with compensating excipient
- **Purpose:** Compute the batch-specific quantity of each active from the lot's approved assay, water/LOD, salt-to-base factor and any registered overage; compute the compensating excipient that keeps core weight constant; allocate across lots; then dispense through K-07. Specialises the kernel "formula scaling and quantity adjustment" block.
- **Config:**
  - Assay basis per active [P: mandatory, no default]: as-is; anhydrous + water (KF); dried + LOD; anhydrous and solvent-free + water + residual solvents. It must match the reporting basis of the CoA/LIMS result field.
  - Chemical form and salt-to-base factor [P: mandatory when the label claim is stated as base]: declared form (e.g. anhydrous salt, trihydrate), molar masses with their source, and the number of base moieties per formula unit; stored as a versioned constant (C-02).
  - Standard-quantity basis [P: mandatory], e.g. "salt, anhydrous, at 100.0 % as-is".
  - Registered overage % [D: 0; >0 only with a registration reference, PR-04, and the 211.186(b)(5) statement].
  - Compensating excipient [P: one q.s. item and its allowed range; or "no compensation", allowed only if the registered formula lets core weight vary].
  - Multi-lot allocation [D: allowed, up to 3 lots; allocation order follows the K-07 lot proposal].
  - Target rounding [D: active rounded up to the balance readability, so the target never falls below the calculated quantity; compensating excipient rounded to nearest readability].
  - Adjustment cap [D: none; if set, an adjusted quantity beyond it raises an exception].
  - Calculation verification [R: independent verification; D: Production verifier, plus QA as optional second verifier as in the sample].
- **Captures:** per lot: lot and AR number, status, retest/expiry, CoA assay and basis, water/LOD/solvents, factor chain, allocated base-equivalent, adjusted quantity; compensating excipient standard and adjusted quantity; totals; verification signatures; then K-07 dispensing data.
- **Engine rules:**
  - Lot values are pulled from approved LIMS/CoA result fields; typed values are impossible; a missing value blocks the calculation (PR-19).
  - Basis consistency check: the molar mass used must belong to the form in which the assay is expressed; a hydrate molar mass combined with a water-corrected (as-is) assay is rejected at design time because it counts water twice (see C-06).
  - The adjusted quantity can never deliver less than 100 % of the labelled active (211.101(a); PR-19); rounding never reduces the active target.
  - The compensating excipient cannot go negative or outside its approved range; total batch mass is re-checked against the standard (within rounding); composition must stay within the registered formula (PR-04).
  - The calculation trace (inputs, versions, result) is stored; a corrected input recalculates and keeps the earlier result visible (DI-33).
- **Implements:** PR-04, PR-18, PR-19, PR-20, IN-23, IN-24, DI-30, DI-33.
- **Sources:** 211.101(a)-(c), 211.186(b)(2),(4),(5), 211.68(b); EU Ch.4 4.17(c); Ch.5 5.37-5.38; Sched M Part I 14.14, 14.18 (P).

#### TB-02 Sifting, screening and milling with screen integrity before and after use
- **Purpose:** Sift or size-reduce materials (vibro-sifter, co-mill, multimill, oscillating granulator, cone mill) and prove the screen or sieve was intact before and after each use.
- **Config:** equipment class; screen ID and aperture (mesh number or µm) per material [P]; mill speed, blade orientation and feed rate; pre/post integrity check method (visual, D; photo, D: OFF); oversize/residue examination frequency [D: every material; Sched M VIII 2.2 requires periodic examination]; magnet/grate check where fitted; sifting requirement [R: all dry ingredients sifted unless the MBR records that input quality is assured, Sched M VIII 1.4; IN-36(g)]; dust control check [R: dust extractor fitted or a dedicated area, unless the equipment is a closed system, VIII 2.1].
- **Captures:** screen ID and aperture, pre-use result and verifier, material/lot/quantity in, quantity out, oversize and its handling, foreign matter Y/N with description, post-use result and verifier, times.
- **Engine rules:** the screen ID is scanned and must have the approved aperture; the pre-use check precedes the first material; the post-use check is mandatory before the step can close (IN-36 test); a failed post-use check raises an exception, holds all material processed since the last intact check and opens a deviation; a damaged screen is set to "damaged" and cannot be bound again; screen use is logged in the screen's own logbook.
- **Implements:** IN-36(b),(c),(g), PR-23, PR-29, DI-29.
- **Sources:** Sched M VIII 1.3, 1.4, 2.1, 2.2 (P); 211.65, 211.67.

#### TB-03 Solution and suspension preparation with use-by (binder, film coat, sugar syrup)
- **Purpose:** Prepare binder solutions/pastes, film-coating dispersions (aqueous or organic), enteric dispersions and sugar syrups, and control solids, mixing and use-by time.
- **Config:** type; solvent (purified water with water-system point-of-use and release status; organic solvent with flameproof-area check); target solids % and quantity [P] with the allowance model (excess % or coating efficiency, C-16); mixing speed/time, temperature (pastes), sieving mesh, de-aeration; continuous stirring during use (Y/N); maximum hold from preparation completion to end of use [P: mandatory, from hold-time data]; appearance criterion.
- **Captures:** vessel/stirrer IDs, materials and quantities (K-07), solvent quantity (mass or volume with density), temperature, times, appearance, final weight, viscosity if specified, completion and use-by times, stirring confirmations, quantity used vs prepared, disposal of remainder.
- **Engine rules:** the use-by timer starts at preparation completion; use after the limit is blocked unless QA dispositions (IN-37); quantities computed by K-14; each preparation is bound to one batch and cannot be carried over to another (DESIGN-CHOICE implementing "made afresh", Sched M VIII 4.2); prepared, sprayed and discarded quantities reconcile.
- **Implements:** IN-36(f), IN-37, PR-28 [T], PR-30.
- **Sources:** Sched M VIII 2.5, 4.2 (P); 211.111, 211.113(a).

#### TB-04 Wet granulation (high shear or fluid bed) with endpoint
- **Purpose:** Run granulation to a defined endpoint and record binder addition, massing and endpoint evidence.
- **Config:** granulator class; dry-mix impeller/chopper speeds and time [P]; binder addition mode (pour, pump, spray), rate and maximum addition time (sample: within 4 min) [P]; total binder quantity range [P]; extra granulating fluid permitted Y/N with maximum quantity and authorising role [D: not permitted]; wet-massing speeds and time [P]; endpoint criterion (time, power/amperage, torque, total liquid, or a combination) [P]; fluid-bed mode: inlet air temperature, air volume, spray rate, atomisation pressure, product temperature, filter shaking [P]; wet-milling screen (TB-02).
- **Captures:** parameters (device or manual), times, binder quantity from load cell/flow meter or weigh-by-difference, extra fluid quantity with reason and authoriser, endpoint value and product temperature, discharge time, optional wet weight.
- **Engine rules:** mixing time and temperature are recorded (IN-13(c)); binder within its use-by (TB-03); liquid quantity compared with the approved range; endpoint taken from the equipment where interfaced, a manual endpoint call needs a reason and verification; extra fluid only through the conditional branch, within the MBR maximum and by the authorised role; beyond it, a deviation; a parameter outside its proven acceptable range creates an exception.
- **Implements:** IN-13(c), IN-36(a), PR-08, PR-29, DI-31, DI-49.
- **Sources:** 211.100, 211.110(a), 211.186(b)(9); EU Ch.4 4.18(d); Sched M VIII 2.3 (P).

#### TB-05 Drying with LOD endpoint loop (FBD or tray) and filter-bag control
- **Purpose:** Dry granules and repeat drying and LOD testing until the moisture endpoint is met, recording every iteration.
- **Config:** dryer class; inlet air temperature set/actual, maximum product temperature, exhaust temperature, air volume/damper %, minimum and maximum drying time [P]; LOD method (moisture analyser class, temperature, endpoint criterion, sample mass, correlation reference to USP <731>/Ph. Eur. 2.2.32) [P]; LOD limits [P: upper mandatory; lower mandatory when the MBR states a range, e.g. the sample's 2.0-3.5 %]; sampling locations or composite; maximum iterations [D: 5; allowed 1-10] and maximum total drying time [P]; action at maximum [R: exception (kernel loop rule); D: plus QA gate]; FBD filter bag: ID, product assignment, integrity check before and after use; tray dryer: tray count, raking/rotation.
- **Captures:** per iteration: added drying time, parameters, sampling time, analyser ID, sample mass, LOD %; final LOD; bag ID, wash record reference, integrity results; output via K-22.
- **Engine rules:** iterations are kept in order and cannot overwrite one another; exit only when LOD is within limits; LOD below the lower limit (over-drying) is an exception, and re-humidification is possible only through an approved procedure; analyser calibration/performance check verified before use; a bag last used for another product is refused unless its wash is recorded, and products flagged highly potent or sensitising accept only product-dedicated bags (IN-36(d)); a failed post-use bag check raises a deviation; air entering the drier must be filtered (checklist item, VIII 2.4).
- **Implements:** IN-13(c), IN-36(a),(d), PR-27, PR-29, DI-29.
- **Sources:** Sched M VIII 2.3, 2.4 (P); 211.110(a); EU Ch.4 4.18(d).

#### TB-06 Dry granulation (roller compaction or slugging)
- **Purpose:** Record and control compaction, ribbon checks, milling and fines recycle.
- **Config:** roll force/pressure, roll gap, roll speed, feed-screw speeds, deaeration vacuum [P]; ribbon checks (thickness, density or solid fraction) and their interval [P: no default; typical 30-60 min is industry practice only (s)]; integrated mill screen and speed; fines recycle allowed Y/N and maximum % [P].
- **Captures:** parameters, ribbon results, recycled fines quantity, granule and fines weights, yield.
- **Engine rules:** ribbon checks are scheduled by TB-11 (overdue and failure handled with hold-back); recycled fines are recorded and kept within the limit and enter the yield; parameter excursions raise exceptions.
- **Implements:** PR-08, PR-29, IN-36(a).
- **Sources:** 211.110(a), 211.186(b)(9).

#### TB-07 Blending, lubrication and blend-uniformity sampling
- **Purpose:** Blend and lubricate to the approved endpoint and sample for blend uniformity (thief sampling or PAT) where the control strategy requires it.
- **Config:** blender class, working capacity and fill-level range [P]; speed; blending time or revolutions (minimum and maximum) [P]; lubrication time (minimum and maximum) [P]; order of addition; lubricant sieve mesh (TB-02); temperature parameter [R: time and temperature must be specified for every blending step, Sched M VIII 2.3; room temperature from K-11 is acceptable where product temperature is not a CPP]; BU plan: number and positions of locations (sampling map), replicates, sample size [D: 1-3 times the unit dose weight, larger only with justification, following the FDA CGMP Q&A (guidance, (s))], thief type; PAT option (model ID/version, endpoint criterion); proportional extragranular adjustment [D: not allowed; see C-25].
- **Captures:** blender ID and occupancy, speed, time/revolutions from equipment or timer, lubricant quantity, BU sample IDs with location and mass, LIMS results (individuals, mean, SD, RSD, min, max), blend physical tests if specified, output containers.
- **Engine rules:** blending time/revolutions are measured, not typed, and minimum/maximum are enforced; exceeding the maximum lubrication time is an exception; missing BU locations are flagged; a sample outside the 1-3x unit-dose range needs a recorded justification; a failing BU result is not handled by a loop: it opens an OOS/deviation and any re-blending goes through K-24 (211.115); physical sampling still applies after a PAT endpoint unless the approved control strategy removes it.
- **Implements:** PR-29, IN-13(c), IN-36(a), DI-29; 211.110(a)(3).
- **Sources:** 211.110(a)(3), 211.160; Sched M VIII 2.1, 2.3 (P).

#### TB-08 Rework / recovered-material addition (cross-batch)
- **Purpose:** Add material from earlier batch(es) of the same product at an MBR-defined stage (e.g. milled compression rejects or leftover granules added at blending), with cross-batch checks, prior authorisation and genealogy. Whole-batch reprocessing uses K-24.
- **Config (per MBR step):**
  - Class [P: mandatory]: (a) recovery of conforming material (EU 5.68; Sched M 14.33) or (b) reprocessing of rejected in-process material (211.115; EU 5.67; Sched M 14.32). Compression set-up or weight-control rejects are rejected material, so they fall under (b).
  - Permitted source material types and the pre-treatment sub-procedure (e.g. milling through a checked screen, TB-02) [P].
  - Maximum quantity per receiving batch as % of the standard batch mass [P: mandatory; the sample uses 3 %].
  - Maximum age of the source material and its reference date (source batch manufacture date or date the rework was generated) [P: mandatory; the sample uses 3 months].
  - Maximum number of source batches [D: 3].
  - Required source status [D: quarantined "reserved for rework" container created by TB-20/K-23 in a batch record, or released conforming material].
  - Chained recovery (source that itself contains recovered material) [D: blocked].
  - Expiry impact [D: receiving batch expiry no later than the earliest expiry among recovered inputs, with QA confirmation, IN-19(b)].
  - Per-use QA authorisation [R: ENFORCED for class (b); D: ON for class (a); OFF allowed only when the approved MBR step itself carries the prior authorisation and risk-evaluation reference].
- **Captures:** source batch number(s), product and master version, source mfg/expiry dates, source container IDs, material type, generation date, age at use, gross/tare/net added, % of batch, authorisation (who, when, investigation/risk-evaluation reference), pre-treatment record.
- **Engine rules:**
  - Source must be the same product (product code, strength and formula version family) (EU 5.68; Sched M 14.33); status, age and cumulative % are checked and violations block the addition (not a warning).
  - Only containers created in an executed batch record can be sources; ad-hoc material cannot be introduced.
  - Class (b) requires an approved written reprocessing procedure and QCU approval before execution (211.115(a)-(b)) and a risk evaluation (EU 5.67; Sched M 14.32); class (a) requires prior authorisation and a risk evaluation that addresses shelf-life effect (EU 5.68; Sched M 14.33).
  - The batch number and quantity of any recovered or reprocessed material added are written into the BMR (EU 4.20(d); Sched M 17.3.8(f); 211.188(b)(3)-(4)).
  - The receiving checkpoint's theoretical yield increases by the net quantity added (C-07); the source container is consumed in its own reconciliation.
  - The receiving batch is flagged "contains recovered/reprocessed material": a QC decision on additional testing is mandatory before release (EU 5.69; Sched M 14.34; PR-47) and the batch is flagged for PQR (PR-58).
  - Genealogy edges are committed with the addition (PR-57), so a forward trace from the source finds the receiving batch (IN-29).
  - The receiving batch keeps its own new batch number; a reworked whole batch always gets a new number (Sched M 14.32; IN-18) via K-24.
- **Implements:** PR-47, PR-57, PR-58, IN-18, IN-19, IN-29, DI-33.
- **Sources:** 211.115, 211.188(b)(3)-(4); EU Ch.4 4.20(d); Ch.5 5.67-5.69; Sched M Part I 14.32-14.34, 17.3.8 (P).

#### TB-09 Tooling (punch and die) custody and inspection before and after use
- **Purpose:** Control punch and die sets as product-identity-bearing tooling: issue, inspection before and after each use, usage count and return.
- **Config:** tooling master per set: type (e.g. B/D), shape, dimensions, upper/lower embossing or debossing, score, tip type (single/multi-tip), number of upper punches, lower punches and dies, product assignment or dedication (PR-27) [P]; inspection checklist (tip damage, chipping, wear, embossing legibility, corrosion, cleanliness; optional dimensional checks such as working length and cup depth with gauge ID and tolerance) [P]; usage limit (cumulative compressions) and inspection interval [P]; custody roles.
- **Captures:** set ID scan, quantities issued and returned, pre-use inspection result and inspector, cleanliness of punches (sample item), post-use inspection result, press count for the run, damage found and disposition (repair, polish, retire).
- **Engine rules:** the set must match the product's approved tooling specification (shape, embossing, score) or start is blocked; a set with a failed or overdue inspection or beyond its usage limit cannot be bound; the pre-use check precedes press start and the post-use check is mandatory before the compression step can close (Sched M VIII 1.3; IN-36(b)); a failed post-use check raises an exception and a deviation covering tablets compressed since the last intact check, which TB-11 holds; returned count must equal issued count, otherwise a deviation (DESIGN-CHOICE: fragment risk); the tooling logbook and usage counter are updated from press counts.
- **Implements:** IN-36(b), PR-22, PR-23, PR-27.
- **Sources:** Sched M VIII 1.3 (P); 211.63, 211.67, 211.105(b), 211.188(b)(2).

#### TB-10 Compression set-up and first-off approval
- **Purpose:** Set up the rotary press (single- or double-sided), bind press and tooling, load approved settings, complete pre-use checks and approve first tablets before routine compression.
- **Config:** press class, number of stations, single or double-sided output (L/R) [P]; settings template with approved ranges: turret speed or output rate, pre-compression and main compression force (kN), fill depth, feeder speed, ejection-force monitoring [P]; weight-control settings (TB-17); set-up reject quantity handling; first-off approval role [D: IPQA]; pre-use checklist [R: dust extraction working (VIII 3.1), nozzles clean and no lubricant leaking into product (VIII 1.6), calibrated balance available (VIII 3.3); D: lubricant level, hopper and feed frame clean].
- **Captures:** press ID, tooling set (TB-09), operator, start time, settings (download/read-back or manual with verification), pre-use checklist, set-up rejects (to K-23), first-off results (TB-11 start event), approval signature; setting changes during the run with time, user and reason.
- **Engine rules:** tooling bound and matching; settings outside approved ranges raise an exception; a setting change during the run triggers the "after setting change" IPC event in TB-11; routine compression is released only after the station-wise start check passes and first-off is approved; hopper/container scan must match the batch and stage (IN-26(c)); calibrated balance status is checked at step start (IN-35(a)).
- **Implements:** IN-26(c), IN-35(a),(b), PR-08, PR-23, DI-31.
- **Sources:** Sched M VIII 1.6, 3.1-3.4 (P); 211.63, 211.67, 211.110(a).

#### TB-11 Periodic IPC scheduler with multi-channel streams and bracketing hold
- **Purpose:** Schedule start, periodic, event-driven and end-of-run IPCs separately for each stream (press side L/R, station set, layer, coating pan, packaging track), remind operators, flag overdue checks, and hold output produced since the last passing check at container level.
- **Config:**
  - Streams [P]: per side of a double-sided press, per layer, per track or pan.
  - Test plan per stream [P, with QRM reference, PR-07/PR-29]: test, sample size and interval by time or count. Compression ceiling [R: ENFORCED for every India-made batch: each sample checked against the in-process specification no more than 30 min after the previous one (Sched M VIII 3.8; IN-35(c)); the other named parameters (appearance, weight variation, disintegration, hardness, friability, thickness, lubricant-oil contamination) at an MBR-defined periodic frequency]. A template plan is offered, labelled industry-typical and not regulatory: group weight every 15-30 min; thickness and hardness every 30 min; uniformity of weight, disintegration and friability every 1-2 h (the sample BMR uses 15 min / 30 min / 2 h).
  - Start-of-run station sweep [R: ENFORCED for compression: at least one tablet from every compression station or point, per output side, examined for the pharmacopoeial parameters the MBR lists; repeated at fixed MBR intervals on multi-point presses (Sched M VIII 3.4; IN-35(b))]. The sample's "35 individual readings L and R" is this sweep on a 35-station double-sided press.
  - Event triggers [D: start, restart after a stoppage longer than 15 min (allowed 0-60), after any setting or tooling change, end of run; container change optional].
  - Reminder lead time [D: 5 min before due].
  - Due and overdue: due = last check + interval; overdue at due + grace; for compression the configuration is refused if interval + grace exceeds 30 min.
  - Action-limit failure: stop press [D: stop] or continue after adjustment for alert-limit failures.
- **Captures:** per check: stream, scheduled time, actual sampling time, performer, results (TB-12..TB-15, K-04), pass/fail, containers filled in the interval.
- **Engine rules:**
  - A missed check (overdue) raises an alarm then an exception, and output since the last passing check is put on hold (PR-29 [T]; guardrail 33). This is stricter than the block JSON wording ("flagged for evaluation"); the catalog wins.
  - A failed check puts on hold every container whose fill interval overlaps the period from the last passing check to the failure; per stream where streams feed separate containers, otherwise all streams.
  - Held containers are released only by a QA disposition (e.g. 100% weight sorting or inspection under an approved procedure, K-24, or rejection); the disposition is recorded.
  - The station sweep cannot be signed until every station has a result (IN-35 test).
  - Results are tied to their stream and time window; the sampling time is a separate field from the entry time; late entries are flagged (DI-28); samples feed reconciliation.
- **Implements:** PR-07, PR-29, IN-35, DI-28, DI-29; guardrail 33.
- **Sources:** 211.110(a)-(b); EU Ch.5 5.43; Sched M VIII 3.4, 3.8 (P).

#### TB-12 Tablet weight IPC: group weight, uniformity of weight/mass, weight-variation content, subdivision
- **Purpose:** Weigh tablets per check and evaluate them by the mode the MBR selects, with pharmacopoeia-specific acceptance from the resolved rule set (Section E).
- **Modes:**
  - (a) Group/average weight: n tablets (sample: 20) weighed together or individually, mean vs target ± in-house % (sample: ±2 %) (C-11).
  - (b) Uniformity of weight/mass per compendial rule set: 20 tablets weighed individually; band p chosen from the measured average; not more than 2 outside ±p of the average and none outside ±2p (Ph. Eur. 2.9.5 / IP) (C-12). The sample's "limit ±7.5 % of average" is this mode.
  - (c) In-house individual limits relative to target weight (absolute or %), tighter than (b).
  - (d) USP <905> weight variation: estimated content of 10 (then 30) units from individual weights and a representative assay result from LIMS, evaluated by acceptance value (C-14) (release/QC use).
  - (e) Scored-tablet subdivision (Ph. Eur. 0478; Medium confidence, Section E).
- **Config:** mode(s); n; limits [P for (a),(c); R rule set for (b),(d),(e)]; balance class, readability and minimum weight suited to tablet mass; statistics displayed; control chart (mean and range) [D: ON].
- **Captures:** individual or group weights from the balance, mean, SD, RSD, min, max, % deviation of min and max from mean, counts outside p and 2p, limits applied with rule-set ID and version, result, stream.
- **Engine rules:** weights come from the balance interface (manual entry flagged and verified); mean-relative limits use the computed mean at full precision; the band is chosen from the computed mean with exact boundaries (Section E); comparisons use the rule set's rounding; for multi-market batches the tightest band applies and the 130/324 mg table (IN-34 "legacy USP") can never loosen the IP/Ph. Eur. band; mode (b) is refused where the resolved rule set excludes the tablet type (e.g. sugar-coated tablets are outside the Ph. Eur. 2.9.5 tablet row, Medium confidence); failure holds output since the last passing check (TB-11).
- **Implements:** IN-33, IN-34, IN-35, PR-29, DI-10, DI-29, DI-32; 211.110(a)(1).
- **Sources:** 211.110(a)(1), (b); Sched M VIII 3.3-3.4, 3.8 (P); pharmacopoeias per Section E.

#### TB-13 Tablet physical IPC: breaking force, thickness, diameter, appearance
- **Purpose:** Capture per-tablet multi-parameter results from an automatic tester or manual gauges, plus appearance defects.
- **Config:** parameters and n per stream (sample: 3 tablets for hardness and thickness); units [D: N; kp allowed, converted with 1 kp = 9.80665 N; pressure units such as kg/cm² are rejected for breaking force]; limits for mean and individuals [P] (sample: hardness "NLT 6 kg/cm²", to be re-labelled kp once QA confirms the tester reads kgf; thickness 3.4 ± 0.2 mm); tester integration; appearance defect list (capping, lamination, sticking, picking, chipping, embossing legibility, black specks, lubricant-oil contamination per Sched M VIII 3.8).
- **Captures:** per tablet: weight, thickness, diameter/length, breaking force; tester ID; defects observed.
- **Engine rules:** readings from one tablet stay linked; conversions only via S-7; tester calibration stored; manual gauge values need verification when classed critical; failures raise exceptions and hold output since the last passing check.
- **Implements:** IN-35(b)-(d), PR-29, DI-32.
- **Sources:** 211.110(a); Sched M VIII 3.4, 3.8 (P); USP <1217> / Ph. Eur. 2.9.8 as method references (Section E).

#### TB-14 Friability
- **Purpose:** Perform the friability test and compute % loss with the compendial repeat logic.
- **Config:** rule set [R: harmonised USP <1216> / Ph. Eur. 2.9.7; IP per Section E]; sample rule computed from the average tablet weight [R: unit mass 650 mg or less: whole tablets totalling as near as possible to 6.5 g; above 650 mg: 10 tablets]; 100 drum rotations at 25 ± 1 rpm [R]; limit [R as compendial guidance: a mean loss of at most 1.0 % is acceptable for most products, binding once the product specification adopts it; product may set tighter; P for a justified chewable/effervescent limit]; repeat rule [R: when the result is doubtful or above the limit, run twice more and use the mean of three].
- **Captures:** number of tablets, dedusted initial mass, final mass, % loss, cracked/cleaved/broken tablets present (mandatory Y/N), friabilator ID, revolutions and rate (device or verified).
- **Engine rules:** % loss computed by the engine (C-15) and compared after rounding to one decimal place; every run is kept and the mean of three is used when the repeat is triggered (the first run is never discarded); any cracked, cleaved or broken tablet fails the test; failure raises an exception and holds output.
- **Implements:** IN-35, PR-29, DI-29.
- **Sources:** Sched M VIII 3.4, 3.8 (P); USP <1216> / Ph. Eur. 2.9.7 (Section E).

#### TB-15 Disintegration (including gastro-resistant stages)
- **Purpose:** Run and record in-process disintegration for the tablet type.
- **Config:** rule set and tablet type (uncoated, film-coated, other coated, gastro-resistant, effervescent, soluble, dispersible, orodispersible, chewable) selecting medium, temperature, discs, time limit and staging (Section E); apparatus class; 6 units [R]; retest staging per rule set; gastro-resistant: acid stage then buffer stage; MBR time limit may be tighter than the compendial one (sample: uncoated cores NMT 15 min).
- **Captures:** apparatus ID, bath temperature check, start time, per-unit disintegration time or status per stage, result.
- **Engine rules:** bath temperature and instrument status verified before start; time measured by the engine or instrument, not typed; per-unit results kept; staging (e.g. 1-2 failures lead to 12 more, pass if at least 16 of 18) applied exactly as the rule set defines; all results retained; failure raises an exception and holds output.
- **Implements:** IN-35, PR-29, DI-29; 211.110(a)(2).
- **Sources:** 211.110(a)(2); Sched M VIII 3.4, 3.8 (P); USP <701> / Ph. Eur. 2.9.1 and monograph Tablets (Section E).

#### TB-16 Bilayer / multilayer compression
- **Purpose:** Control tablets built from two or more layers, each with its own blend, fill and weight.
- **Config:** layers and their blends and order; first-layer tamping force and final force [P]; layer weight checks (first-layer-only samples) and total weight checks with separate limits [P]; layer-specific IPC frequencies (TB-11 streams); layer separation/delamination check.
- **Engine rules:** each layer's hopper is bound to the right blend container by scan and swapping is blocked; layer-only samples are tagged and never mixed into full-tablet statistics; layer and total weights are evaluated against their own limits.
- **Implements:** PR-21, PR-29, IN-26(c), IN-35.
- **Sources:** 211.101(d), 211.110(a); Sched M VIII 3.2 (P).

#### TB-17 Compression-line reject and detection devices (weight-control reject gate, de-duster, metal detector)
- **Purpose:** Record force-based automatic weight-control settings and reject counts, de-dusting, and metal-detector challenges, with hold-back on failure.
- **Config:** weight-control mode and limits (individual reject limits, mean control limits) downloaded from approved values [P]; start-up reject quantity; reject-gate challenge method and frequency [P]; de-duster ID; metal detector test pieces (ferrous, non-ferrous, stainless, sizes) [P: product/site-specific, no default; published sizes are industry examples only (s)]; challenge timing [D: start, after stoppage, every 2 h, end; allowed shorter]; handling and inspection of metal-detector rejects.
- **Captures:** settings read-back, challenge results with test-piece IDs and certificate validity, reject counts by device, de-duster in use, force-excursion alarms.
- **Engine rules:** limits are downloaded and read back; rejected tablets cannot be returned to the good stream; a failed challenge holds output since the last passing challenge and raises an exception; test pieces must be within certification; reject counts feed reconciliation; tablets are de-dusted and monitored for foreign material and defects (Sched M VIII 3.5); metal-detector challenge records are kept where a detector is fitted (IN-36(e); a detector is recommended, not mandatory, VIII 1.3).
- **Implements:** IN-35(e),(f), IN-36(e), PR-29, DI-49; 211.68(a).
- **Sources:** Sched M VIII 1.3, 3.5, 3.7 (P); 211.68(a); EU Annex 11 §5.

#### TB-18 Coating process and weight gain (film, functional film, sugar)
- **Purpose:** Run pan coating, log process parameters, and reach the weight-gain endpoint; for sugar coating, record each application of each phase.
- **Config:** coating type (FC, FC-F, SC); pan class and load range (kg cores) [P]; core average weight sample size [D: 100 tablets; allowed 20-200]; guns, nozzle, gun-to-bed distance; parameter ranges logged per interval [P; D interval: 15 min]: inlet, exhaust and bed temperature, air volume/damper %, pan speed, spray rate or pump rpm, atomising and pattern air pressure, pan pressure (the sample's ranges: dampers 80-100 %, inlet 50-55 °C, outlet 30-35 °C, pan 1-5 rpm, air pressure 2-4 kg/cm², pump 15-35 rpm); filtered pan air and room T/RH checks [R: Sched M VIII 4.1]; weight-gain target and limits [P; minimum mandatory for FC-F]; weight-gain check interval near the end [D: 15 min]; endpoint rule (weight gain reached, theoretical suspension sprayed, or both); maximum suspension; drying/cooling; SC phases (seal, sub-coat, smoothing, colour, polish) with applications per phase and drying between applications; functional IPC link (TB-15 gastro-resistant mode, or dissolution via LIMS); curing where applicable.
- **Captures:** core mean weight, periodic parameters, cumulative suspension sprayed, each weight-gain check (coated mean weight, % gain), endpoint, final coated weight, suspension used vs prepared, output containers, rejects (twins, chipped), yield.
- **Engine rules:** weight gain computed at full precision (C-16); the endpoint cannot be declared before the minimum weight gain (FC-F) or minimum suspension quantity; exceeding the maximum weight gain raises an exception for QA assessment; each weight-gain check and each sugar-coat application is a retained loop iteration (K-17); the suspension must be within use-by (TB-03); parameters imported with timestamps, manual readings flagged.
- **Implements:** IN-37, PR-08, PR-29, DI-29, DI-49.
- **Sources:** 211.110(a); Sched M VIII 4.1-4.2 (P).

#### TB-19 Tablet printing / laser marking and post-printing QC approval
- **Purpose:** Verify imprint or laser-mark content and legibility, and gate printed tablets until QC approves them.
- **Config:** marking content from product master; ink/colour lot (edible grade, Sched M VIII 6.1); check frequency and sample size [P]; defect categories (smudged, missing, misregistered); vision integration.
- **Engine rules:** content comes from master data, never typed; defect counts feed reconciliation and AQL; a failed check holds output since the last good check; printing different products or batches at the same time needs a segregation record (VIII 6.1); printed tablets cannot enter packaging or sale until the QC approval gate (K-16) is signed (VIII 6.2; IN-37).
- **Implements:** IN-37, PR-29.
- **Sources:** Sched M VIII 6.1-6.2 (P); 211.130.

#### TB-20 Visual inspection, sorting, AQL and reject categorisation
- **Purpose:** Remove defective or foreign tablets by 100% sorting (manual belt or vision sorter) and confirm by AQL sampling; categorise rejects as reusable residue or for destruction.
- **Config:** mode and vision recipe; defect catalogue with classes (critical, major, minor); AQL plan (ISO 2859-1 / ANSI/ASQ Z1.4 level and AQL values) [P: company values, no regulatory numbers]; acceptance numbers; reject categories [D: "reusable residue (rework-eligible)" and "for destruction"; the reusable category exists only if the MBR has a matching TB-08 step]; inspection time recording.
- **Captures:** inspectors, from/to times, quantity inspected (kg and count), defects by class, rejects by category (kg and count), accepted quantity, AQL results.
- **Engine rules:** acceptance evaluated by the engine; a foreign or other-product tablet is critical: exception plus an investigation that extends to other batches (211.192); a failed AQL leads to re-inspection only through an approved procedure (K-24); rejects feed reconciliation; reusable residue goes to a quarantined K-22 container usable only through TB-08; destruction via K-23.
- **Implements:** PR-46, PR-47, PR-50, IN-35(f).
- **Sources:** 211.110(d), 211.192; EU Ch.5 5.66; Sched M VIII 3.5, 3.7 (P).

#### TB-21 Blister/strip line set-up, independent line check and sealing control
- **Purpose:** Set up a thermoform, cold-form or strip line for a pack format, perform the independent equipment check, and control forming/sealing.
- **Config:** pack format (tablets per blister/strip, blisters per carton) and change-part set [P]; forming film, lidding foil or strip foil items and artwork versions; forming temperature, sealing temperature, pressure and dwell/speed ranges [P]; feeder and empty-pocket detection; reel-change procedure; defect check frequency for misprint, foil cuts, missing tablets and improper sealing [P] (Sched M VIII 7.3); independent recorded equipment check before a new batch (removal of rogue tablets, capsules and foils) [R: ENFORCED, performer and a different verifier, VIII 7.1; IN-38(a)]; line eligibility for uncoated, potent or beta-lactam products [R: IN-38(d)].
- **Captures:** machine ID, materials and reel lots, parameters (read-back or manual verified), independent check signatures, first-off, periodic defect checks, reel changes with time and new reel verification, vision rejects, set-up waste, good blister count, stoppages.
- **Engine rules:** change parts and materials are scanned against the pack format; printed foil follows K-19; sealing parameters outside validated ranges raise exceptions and hold affected output; empty or broken pocket rejects feed reconciliation; the same user cannot sign both performed and verified for the independent check (IN-38 test); potent and beta-lactam uncoated tablets are packed only on lines flagged as isolated (VIII 7.2).
- **Implements:** IN-38, PR-33, PR-34, PR-35, PR-37.
- **Sources:** 211.122, 211.130; EU Ch.5 5.50-5.52; Sched M VIII 7.1-7.3 (P).

#### TB-22 Blister/strip leak test
- **Purpose:** Periodic vacuum leak test of pockets as an IPC (dye ingress or vacuum decay).
- **Config:** method and instrument class; vacuum level and hold time [P: from the site's validated method; secondary sources cite about -0.6 to -0.8 bar for 30-60 s, not regulatory (s)]; blisters/strips per test and per track [P]; frequency [R: periodic tests are mandatory, Sched M VIII 7.4; P interval; D triggers: start, after stoppage, after reel change or adjustment, end]; re-test rule after correction [P].
- **Captures:** time, track, number tested, applied vacuum and hold time (from tester or verified), leaking pockets, result.
- **Engine rules:** any leaking pocket fails the test, raises an exception and holds output since the last passing test; applied parameters are captured or second-person verified; a missed scheduled test flags the record (IN-38(c)); records kept (VIII 7.4).
- **Implements:** IN-38(c), PR-29, PR-37.
- **Sources:** Sched M VIII 7.4 (P); USP <1207> by analogy only (s).

#### TB-23 Bottle line: count, desiccant, closure torque, induction seal
- **Purpose:** Control bottle filling: count verification, desiccant/coil insertion, cap torque, induction seal integrity and labelling.
- **Config:** count per bottle and counter type; desiccant type and verification method; application torque target/limits and removal torque limits [P]; induction sealer power and conveyor speed [P]; seal check method and frequency; counter and detector challenges; label roll and coding (K-20); OTC US retail tamper-evident checks where flagged (PR-41).
- **Captures:** count checks, checkweigher results, desiccant presence, torque readings with tester ID, seal results, label/coding checks, rejects by type, good bottles.
- **Engine rules:** checks are scheduled (TB-11 streams); a failure holds output since the last good check; torque tester calibration verified; missing desiccant or seal detections are rejected and counted; a failed detector challenge stops the step; roll-label reconciliation is never waived (IN-17); filled unlabelled bottles are identified sufficiently for name, strength, quantity and lot, and consumed at labelling only by scan-matched batch (PR-38).
- **Implements:** PR-37, PR-38, PR-41, IN-17, IN-22.
- **Sources:** 211.94, 211.130(b), 211.132; EU Ch.5 5.53-5.54.

#### TB-24 Secondary/tertiary packaging and finished-pack examination
- **Purpose:** Cartoning with leaflets and overprint, checkweighing, anti-tampering device, shippers and pallets; label examination during finishing and at the end of the run; unusual events.
- **Config:** cartonator; carton and leaflet items and versions (pharma codes); checkweigher set-points and challenges; ATD check (EU packs); shipper label content (GS1-128/SSCC), cartons per shipper, part-shipper rule [D: one marked part shipper per batch]; end-of-run representative sample size [P: SOP; AQL optional].
- **Captures:** cartons made, rejects, set-up waste, challenge results, ATD checks, shipper counts and labels, pallet IDs, examination results, unusual-event set-aside counts.
- **Engine rules:** packages are examined for correct labelling during finishing and a representative sample is examined at completion, both recorded, before the order can close (211.134; PR-37); samples removed from the line cannot return to good output (EU 5.59); units from an unusual event re-enter only after special inspection, investigation and authorised approval, with a detailed record (EU 5.60; IN-22(e)); set-aside quantities feed reconciliation; ATD verified where the market requires it (K-21).
- **Implements:** PR-37, PR-41, PR-42, IN-22.
- **Sources:** 211.134; EU Ch.5 5.57-5.60; Sched M Part I 18.5.4-18.5.9 (P).

---
## C. Calculations (engine formula library for the Tablets edition)

### C.0 Conventions for every formula
- Units: batch quantities in kg, sample masses in g, tablet masses in mg, percentages as % w/w unless stated. Exact conversions: 1 kg = 10^3 g = 10^6 mg; 1 kp (kgf) = 9.80665 N (exact, by the definition of standard gravity); 1 kgf/cm² = 98.0665 kPa = 0.980665 bar.
- Every formula is dimension-checked at design time (K-14, S-7). The checks are written next to each formula below.
- Intermediates are kept at full precision. Rounding happens only for display and for comparison with a limit.
- Compendial comparisons use the rounding rule attached to the rule set. For USP the General Notices rounding rule (round the observed or calculated value to the number of decimal places in the limit, looking only at the next digit, and rounding up at 5) is used [Medium: recalled as USP General Notices 7.20; verify]. For Ph. Eur. and IP the rule set carries the rounding convention from their General Notices [Medium; verify].
- Design defaults (not regulatory): dispensing targets for actives are rounded UP to the balance readability (so the ≥100 % intent of 211.101(a) is never lost by rounding); other dispensing targets are rounded to the nearest readability step; tablet counts are shown as whole tablets (nearest) while the full-precision value is used in yield.
- Every result stores inputs, formula version, units and verifier (DI-33).

### C-01 As-is assay of an active
| Assay basis on CoA | Formula |
|---|---|
| As-is | A_asis = A_CoA |
| Anhydrous basis, water by KF | A_asis = A_anh × (100 - W) / 100 |
| Dried basis, LOD | A_asis = A_dried × (100 - LOD) / 100 |
| Anhydrous and solvent-free basis | A_asis = A_anh,sf × (100 - W - S) / 100 |

Inputs: A (% w/w, from the approved lot result), W = water % w/w, LOD % w/w, S = total residual solvents % w/w (only when the specification defines the basis that way). Output: % w/w. Dimension: % × dimensionless = %.

### C-02 Salt-to-base (form) factor
f_sb = MW_form / (ν × MW_base)

MW_form = molar mass (g/mol) of the chemical form in which the assay is expressed (e.g. anhydrous salt); MW_base = molar mass of the moiety in which the label claim is expressed; ν = moles of base moiety per mole of form (ν = 2 for a hemi-calcium salt such as atorvastatin calcium, (C33H34FN2O5)2Ca). Dimensionless (g/mol ÷ g/mol).

### C-03 Potency-adjusted quantity of an active
- Base quantity: Q_base (kg) = LC (mg/tablet) × N_std (tablets) × 10^-6 (kg/mg)
- Standard quantity of the form at 100 %: Q_std (kg) = Q_base × f_sb × (1 + OV/100), where OV = registered overage % (0 unless registered)
- Adjusted quantity: Q_act (kg) = Q_std × 100 / A_asis

This is algebraically the sample's formula: quantity = LC × (100/assay) × (batch size/10^6) × (MW salt/MW base), with the assay taken as-is and ν folded into "MW base" (the sample's 1117.28 is 2 × the free-acid molar mass). Dimension: mg/tablet × tablets × kg/mg = kg.

Multiple lots i: each lot supplies a base-equivalent b_i (kg of base) = Q_act,i × A_asis,i / (100 × f_sb); the engine requires Σ b_i = Q_base × (1 + OV/100) (within rounding) and Q_act,i = b_i × f_sb × 100 / A_asis,i.

### C-04 Compensating excipient
Q_dil,act (kg) = Q_dil,std - (Σ_i Q_act,i - Q_std)

Keeps the total core mass equal to the standard. Q_std must be defined on the declared basis (TB-01). Blocked if the result is negative or outside the diluent's approved range. When the as-is assay is above 100.0 %, Q_act is below Q_std and the diluent increases.

### C-05 Excipient or intermediate specified on a dry basis
Q_asis (kg) = Q_dry (kg) × 100 / (100 - LOD)

Only when the MBR specifies a dry-basis quantity. LOD in % w/w from the lot result.

### C-06 Worked example with the sample BMR's numbers, and a molar-mass check
**Given (sample):** label claim 40 mg atorvastatin per tablet; batch 2,00,000 tablets (= 200,000); "MW salt / MW base" = 1155.36 / 1117.28 (the sample labels 1155.36 as atorvastatin calcium trihydrate).

**Illustrative lot values (not in the sample, which gives no CoA figures):** assay 99.2 % on the anhydrous basis; water (KF) 4.6 %.

| Step | Calculation | Result |
|---|---|---|
| Base quantity | 40 mg × 200,000 × 10^-6 kg/mg | 8.000 kg atorvastatin |
| Form factor | 1155.36 / 1117.28 | 1.034083 |
| Standard quantity (100 % as-is) | 8.000 × 1.034083 | 8.2727 kg |
| As-is assay | 99.2 × (100 - 4.6) / 100 | 94.6368 % |
| Adjusted quantity | 8.2727 × 100 / 94.6368 | 8.7415 kg (8.741486 full precision); dispensing target rounded up to a 0.001 kg readability: 8.742 kg |
| Compensating excipient change | 8.741486 - 8.272662 | diluent reduced by 0.4688 kg (0.469 kg at 0.001 kg readability) |

**Molar-mass check** (computed with IUPAC standard atomic weights C 12.011, H 1.008, F 18.998, N 14.007, O 15.999, Ca 40.078):
- Atorvastatin free acid C33H35FN2O5: 558.65 g/mol (literature commonly 558.64). Twice this is 1117.3; the sample's 1117.28 = 2 × 558.64. Consistent.
- Atorvastatin calcium, anhydrous, (C33H34FN2O5)2Ca = C66H68CaF2N4O10: 1155.36 g/mol (literature values about 1155.3-1155.4). The sample's 1155.36 matches the **anhydrous** salt.
- Atorvastatin calcium trihydrate (anhydrous salt + 3 H2O): 1209.41 g/mol (literature about 1209.4). Theoretical water content of the trihydrate: 4.47 % w/w.
- **Conclusion:** the sample's pair is internally inconsistent in its label: 1155.36 is the anhydrous salt, not the trihydrate. The ratio 1.0341 is correct only when the assay used is the water-corrected (as-is) assay of the anhydrous salt, or equivalently the anhydrous-basis assay combined with a separate water correction (C-01).
- **Why it matters (same illustrative lot):**
  - Using the anhydrous ratio with the anhydrous-basis assay and no water correction: 8.2727 × 100 / 99.2 = 8.3394 kg, i.e. 4.6 % less active than required (the water content). The batch would be formulated below 100 % of label claim, contrary to 211.101(a).
  - Using the trihydrate ratio (1209.41 / 1117.30 = 1.0824) together with the water-corrected assay: 8.000 × 1.0824 × 100 / 94.6368 = 9.1503 kg, i.e. 4.7 % too much (water counted twice).
  - Either error is of the same order as common assay acceptance ranges, so the engine enforces the basis-consistency rule in TB-01 and requires the declared chemical form, molar masses and their source in master data.

### C-07 Theoretical mass at a stage (including rework/recovered material)
T_stage (kg) = Σ_j m_j + Σ_k r_k - Σ_l s_l
- m_j = non-volatile components actually charged up to the stage (as dispensed; the basis, as-is or dry, is declared per checkpoint and used for actual output too); granulating fluids (water, IPA) are excluded because they evaporate;
- r_k = net rework/recovered material added (TB-08); this is the sample's "theoretical = standard + rework added";
- s_l = planned removals deducted by SOP (e.g. BU samples), if the SOP deducts them.
- Coated stage: T_coated = M_cores,charged × (1 + WG_target/100), or the cores plus the theoretical coating solids.

Note: residual moisture after drying (e.g. LOD 2.0-3.5 %) makes dry-stage yields read slightly high or low relative to an as-is basis; the yield limits must be set on the same basis.

### C-08 Theoretical number of tablets
N_theo (tablets) = T_blend (kg) × 10^6 (mg/kg) / W_core,theo (mg/tablet)

Example: 51.200 kg / 250.0 mg = 204,800 tablets. Dimension: kg × mg/kg ÷ mg/tablet = tablets. When rework is added, N_theo rises accordingly. For coated products the coated count equals the cores consumed.

### C-09 Yield and reconciliation
- Stage yield (%) = O_stage / I_stage × 100 (I = quantity actually charged into the stage)
- Cumulative yield (%) = O_stage / T_stage × 100
- Good-output yield (%) = A / T × 100, with A = actual good output
- Sample's reconciliation yield (%) = (A + B) / T × 100, with B = rework generated (reusable residue kept in quarantine). K-18 shows both this and the good-output yield (DESIGN-CHOICE).
- Accountability (mass balance, %) = (good output + IPC destructive samples + QC and reserve samples + rejects of all categories + reusable residue + documented losses such as dust-collector fines and set-up waste + returns) / total input × 100; Unaccounted (kg) = input - Σ accounted.
- Numerator and denominator must have the same unit (kg/kg or tablets/tablets); mixing is a design-time error.
- Example: T = 50.000 kg standard + 1.200 kg rework added = 51.200 kg; A = 50.300 kg; B = 0.350 kg. Good-output yield = 98.24 %; (A + B)/T = 98.93 %.
- Rounding: to the number of decimals in the MBR limit for comparison (e.g. limits 99.0-100.0 % compare at one decimal).

### C-10 Tablet count from weight
N (tablets) = M_net (kg) × 10^6 / W̄ (mg/tablet)

W̄ = mean individual tablet weight from a defined sample (e.g. 20 or 100 tablets from the same lot/container) or the run IPC mean; the method is recorded. Example: 50.000 kg / 250.0 mg = 200,000 tablets. Display to whole tablets; full precision kept for yield.

### C-11 In-house group and average weight limits
- Group of n tablets: target G = n × W_t; limits G × (1 ± g/100)
- Average weight: W_t × (1 ± a/100)
Example (sample: 20 tablets ± 2 %): W_t = 250.0 mg gives G = 5,000.0 mg (5.0000 g), limits 4,900.0-5,100.0 mg. g and a are in-house [P], tighter than compendial limits and derived from process data (211.110(b)).

### C-12 Uniformity of weight/mass evaluation (Ph. Eur. 2.9.5 / IP)
- W̄ = (Σ w_i) / 20
- p = 10 % if W̄ ≤ 80 mg; 7.5 % if 80 mg < W̄ < 250 mg; 5 % if W̄ ≥ 250 mg (uncoated and film-coated tablets; Section E)
- Tier-1 limits: W̄ × (1 - p/100) to W̄ × (1 + p/100); tier-2 limits: W̄ × (1 - 2p/100) to W̄ × (1 + 2p/100)
- Pass: at most 2 of 20 outside tier 1 and none outside tier 2.
Example: W̄ = 200.0 mg: p = 7.5 %; tier 1 185.0-215.0 mg; tier 2 170.0-230.0 mg. Note the band is chosen from the measured average, and the limits are relative to it, not to the target.

### C-13 Weight-variation statistics
Mean x̄ = Σ x_i / n; SD s = √(Σ (x_i - x̄)² / (n - 1)); RSD (%) = s / x̄ × 100; min, max; % deviation of each unit d_i = (x_i - x̄) / x̄ × 100; count outside each tier. Units: mg (RSD dimensionless %).

### C-14 USP <905> / Ph. Eur. 2.9.40 acceptance value [Medium-High; verify against current texts]
- Content per unit x_i in % of label claim. For weight variation: x_i = w_i × A / W̄, where A = assay (% of label claim) of a representative sample, w_i = individual weight, W̄ = mean weight of the units tested.
- AV = |M - X̄| + k × s, with X̄ = mean content, s = SD, k = 2.4 (n = 10) or 2.0 (n = 30).
- Reference value M when T ≤ 101.5: M = X̄ if 98.5 ≤ X̄ ≤ 101.5; M = 98.5 if X̄ < 98.5; M = 101.5 if X̄ > 101.5.
- When T > 101.5: M = X̄ if 98.5 ≤ X̄ ≤ T; M = 98.5 if X̄ < 98.5; M = T if X̄ > T. (T = target content at manufacture, % of label claim; 100.0 unless the monograph states otherwise.)
- Stage 1 (n = 10): pass if AV ≤ L1 = 15.0. Otherwise stage 2 (20 more, n = 30): pass if AV ≤ 15.0 and no unit is below (1 - 0.25) × M or above (1 + 0.25) × M (L2 = 25.0).
- Applicability of weight variation instead of content uniformity: uncoated or film-coated tablets containing at least 25 mg of the active that makes up at least 25 % of the tablet mass (Section E).

### C-15 Friability
F (%) = (W_1 - W_2) / W_1 × 100, with W_1 = dedusted initial mass (g), W_2 = dedusted mass after 100 rotations (g). If the repeat rule applies, F = mean of three runs. Compare after rounding to one decimal with the 1.0 % limit. Example: 6.512 g to 6.470 g gives 0.645 %, reported 0.6 %.

### C-16 Coating weight gain and suspension requirement
- WG (%) = (W̄_coated - W̄_core) / W̄_core × 100 (same number of tablets weighed each time, or means of n)
- Target coated weight: W_t,coated = W̄_core × (1 + WG_target/100)
- Coating solids needed: M_solids (kg) = M_cores (kg) × WG_target / 100
- Suspension needed at solids content S (% w/w): M_susp = M_solids × 100 / S
- Allowance, one model declared in the MBR (they give different numbers):
  - excess allowance e %: M_prep = M_susp × (1 + e/100)
  - coating efficiency η %: M_prep = M_susp × 100 / η
- Example: cores 250.0 mg to coated 257.5 mg: WG = 3.0 %. Cores 60.000 kg at WG 3.0 % need 1.800 kg solids; at S = 12.0 % that is 15.000 kg suspension; with e = 20 % prepare 18.000 kg; with η = 80 % prepare 18.750 kg.
- Sugar coating: cumulative gain after phase j = (W̄_j - W̄_core) / W̄_core × 100.

### C-17 Breaking force units and tensile strength
- F (N) = F (kp) × 9.80665. Pressure units are not valid for breaking force (the sample's "kg/cm²" must be re-labelled kp after QA confirms the tester reads kgf).
- Tensile strength of flat-faced round tablets (optional): σ (MPa = N/mm²) = 2F / (π × D × t), F in N, D and t in mm [Medium-High; USP <1217> concept; valid only for flat-faced cylinders].

### C-18 Blend uniformity statistics
Mean, SD (n - 1), RSD % as in C-13, per location and overall; acceptance only per the validated plan (no default criteria are shipped; the FDA 2003 draft criteria were withdrawn in 2013 (s)).

### C-19 Packaging theoretical quantities
- Blisters_theo = N_issued / (tablets per blister); Cartons_theo = Blisters_theo / (blisters per carton); Shippers_theo = Cartons_theo / (cartons per shipper).
- Bottles_theo = N_issued / (count per bottle).
- Partial units are rounded down (whole packs only); the remainder is a reconciliation item.

### C-20 Bulk tablet reconciliation in packaging
Recon (%) = [good packs × tablets per pack + tablets in rejected packs + tablets in IPC destructive samples (leak test, count checks) + QC, reserve and stability samples (tablets) + loose rejected tablets + returned bulk (tablets)] / tablets issued × 100. Tablets issued and returned are counted by C-10 when weighed.

### C-21 Printed packaging material reconciliation
- Used = packs produced × components per pack (or machine counter)
- Recon (%) = (used + set-up waste + damaged/rejected + batch-coded destroyed + uncoded returned + specimens) / issued × 100; Discrepancy = issued - Σ
- Count by weight: N = net mass / unit mass (unit mass = mean of a defined count, e.g. 100)
- Foil by length: L (m) = machine indexes × index pitch (m); by mass: L = Δm (g) / linear mass (g/m)

### C-22 Serial-number reconciliation
Unaccounted = commissioned - (aggregated/shipped + decommissioned by reason + retained); must equal 0 before packaging completion.

### C-23 Hold-time compliance
Elapsed = t_use,start - t_completion,previous (server times); compliant if Elapsed ≤ Max_hold. Clean-hold elapsed = t_use,start - t_cleaning,end; dirty-hold elapsed = t_cleaning,start - t_use,end.

### C-24 Expiry date
Exp = D_start + shelf life (months), per the market's date convention (e.g. end of month [P]); if the expiry cap is ON (K-01): Exp = min(that date, earliest expiry of the capping input lots). The sample's rule "36 months or API expiry, whichever is less" is this cap. An EU start-of-shelf-life option (release-date based when release is within 30 days of production) exists only as a QA-approved product rule; its source is secondary (CPMP/QWP/072/96 (s)) and must be verified before use.

### C-25 Proportional extragranular adjustment (only if the MBR allows it)
Q_extra,act = Q_extra,std × (M_granules,actual / M_granules,theo)

Holds lubricant and disintegrant proportions fixed. Because the theoretical tablet count changes, the engine recomputes the downstream theoretical yields and flags the step for QA review; the result must stay within the registered formula.

---
## D. Yield and reconciliation rules

### D.1 Rules that apply at every checkpoint (ENFORCED unless stated)
1. **Limits exist before use.** Each yield checkpoint in the MBR has a theoretical basis, a formula (C-07, C-09), a rounding rule and both a minimum and a maximum % of theoretical; the MBR cannot be approved otherwise (211.186(b)(6)-(7); PR-03, PR-31; IN-13(b) expected final yield with limits and pertinent intermediate yields). Minimum and maximum at every intermediate checkpoint is the kernel's US-driven interpretation (production catalog D-9, open question F-12).
2. **Computed, not typed.** Yields are computed from quantities captured in other steps (outputs, samples, rejects, residue, waste, returns). A % cannot be typed (PR-31; IN-17).
3. **Verified.** Automated calculation: one person independently verifies; manual calculation: a second person verifies (211.103; PR-31; DI-33).
4. **Two-sided.** A result above the maximum (e.g. above 100 % on a dry basis) is a discrepancy as much as one below the minimum (weighing error, wrong count conversion, moisture pick-up, material from another batch).
5. **Mass balance is separate from yield.** Unaccounted material beyond the reconciliation tolerance is investigated even when the yield passes (C-09).
6. **Out of limits.** The engine raises an exception and a deviation; an investigation per 211.192 is required and must extend to associated batches of this product and to other products possibly involved; release is blocked until it is concluded (PR-31, PR-50, PR-53 default; IN-17; EU 5.44), or, for a processing-yield investigation only, until the QCU/QP records the e-signed PR-53 justification that the investigation is advanced enough (India additionally requires the deviation to be formally assessed, IN-05(c)). For reconciliation discrepancies (packaging bulk and printed materials) the "release with a justified open investigation" option of PR-53 is never available (EU 5.61).
7. **Next step.** Blocking the next processing step on an out-of-limit intermediate yield is not required by the texts (production catalog C-24). CONFIGURABLE: default = the next step may start once the deviation is raised and acknowledged by the supervisor and a mandatory explanation is recorded (IN-15); allowed = block until QA disposition.
8. **Rework in and out.** Rework or recovered material added raises the theoretical quantity of the receiving checkpoint (C-07); reusable residue generated is a reconciliation category of the generating batch and becomes a quarantined container (K-22); neither can be entered as free text.
9. **Rejected in-process material** is identified and quarantined so that it cannot be used (211.110(d)); rejected or discarded tablets are kept in identified containers with the quantity recorded in the BMR (Sched M VIII 3.7).
10. **Trending.** Yields and reconciliation results are stored as typed data for PQR and trending (PR-58; IN-01).

### D.2 Checkpoints by stage
Limits are always product-specific [P], set from validation and historical data. The illustrative values below come from tablets.json and are industry examples only (s), never shipped as defaults; the sample BMR's granulation limit is shown as an example of a customer value.

| Stage (UP) | Theoretical basis | Actual (captured by) | Reconciliation categories | Illustrative limit (not a default) |
|---|---|---|---|---|
| Dispensing (UP-10) | Target quantity per line after TB-01 | Dispensed net per container (K-07) | Remnants returned; weighing waste | Tolerance per line, not a yield % |
| Sifting (UP-20) | Input charged | Sifted output (K-22) | Oversize/residue (reused or rejected), dust | ≥ 99.0 % (s) |
| Granulation + drying (UP-30/35/40) | Non-volatile solids charged (declared as-is or dry basis) | Dried granules (K-22) | LOD samples, fines in bags/collector, residue | ≥ 97.0 % (s); sample BMR: standard 99.5 %, permissible 99.0-100.0 % |
| Dry granulation (UP-36) | Pre-blend charged | Granules + fines | Recycled fines (within limit), samples | Product-specific |
| Sizing (UP-50) | Granules charged | Sized granules | Oversize, dust | ≥ 98.5 % (s) |
| Blending/lubrication (UP-60) | Granules + extragranular + rework added (C-07) | Lubricated blend | BU and other samples | ≥ 98.5 % (s) |
| Compression (UP-70) | Blend charged, as tablets (C-08) or kg | Good tablets (kg and C-10 count) | Set-up rejects, weight-control rejects, metal-detector rejects, IPC destructive samples, QC samples, dust, reusable residue | 97.0-100.5 % (s) |
| Coating (UP-80/81) | Cores charged × (1 + WG target/100) | Coated tablets | Twins/defects, samples, residue in pan | 97.5-100.5 % on coated-weight basis (s) |
| Inspection (UP-90) | Input to inspection | Accepted tablets | Rejects by category, AQL samples | ≥ 98.0 % (s) |
| Overall manufacture (UP-95) | Standard batch + rework added | Bulk (kg and tablets) | All of the above | ≥ 95.0 % (s); illustrative 95-100.5 % (s) |
| Packaging: bulk tablets (UP-P90) | Tablets issued (C-10) | Good packs × count (C-20) | Rejected packs, IPC samples, QC/reserve/stability samples, loose rejects, returned bulk | 99.0-100.5 % (s) |
| Packaging: printed materials (UP-P90) | Quantity issued | Used (C-21) | Set-up waste, damaged, coded destroyed, uncoded returned, specimens | Narrow preset limits from historical data (211.125(c)); many firms use 100 % accountability for counted items (s) |
| Packaging: serials (UP-P90) | Commissioned | Aggregated/shipped | Decommissioned by reason, retained | Zero unexplained (PR-39, PR-42) |

### D.3 Packaging-specific rules
- **No labelling-reconciliation waiver.** Because India is always in the market set and Schedule M offers no waiver, the 211.125(c) roll/cut-label waiver and the EU 4.21(h) omission are not offered (IN-17 stricter than PR-39's configurable waiver; production catalog D-6).
- **Batch-coded leftovers** are destroyed and the destruction recorded; uncoded printed materials go back to stock only through a counted, documented return (211.125(d); EU 5.62; IN-22(g); K-23).
- **Discrepancy workflow** (from tablets.json, adopted): stop BPR closure and block release; physically recount returns and rejects; search the line, adjacent lines, waste and reject bins; check machine-counter validity and set-up waste records; check whether printed material could have reached another batch packed on the same line or time window and extend the investigation to it; raise a deviation with root cause and CAPA; QA decides (release, reject, recall assessment if already distributed).
- **Before release:** any significant or unusual discrepancy between bulk, printed materials and units produced must be investigated and explained (EU 5.61); the batch stays blocked until then (PR-53 exception not allowed).

---
## E. Pharmacopoeia differences as master-data rule sets

### E.1 Rule-set model (S-8)
- A rule set is versioned master data: ID; pharmacopoeia (IP, Ph. Eur., USP-NF, BP, in-house); edition/supplement and official-from/official-to dates; test; applicability conditions (tablet type, coating, unit mass, active content); sample size and stages; acceptance logic; rounding convention; **confidence**; source reference; **customer verification record** (QA signature, document reference to the official text).
- A rule set cannot be made Effective for GMP use until QA has recorded verification against the official pharmacopoeia text, whatever its confidence below (DESIGN-CHOICE; pharmacopoeia texts were not in primary/).
- Every evaluation stamps the rule-set ID and version into the record (DI-10). A new edition (e.g. IP 2026, effective 1 Jul 2026 (S)) lists every MBR citing the previous edition and opens change control (IN-33).
- An MBR limit may be tighter than the resolved rule set, never looser (checked at MBR approval).
- Market resolution: India is always in the set, so the IP rule set is always bound for in-process tests (IN-34, IN-52). For a multi-market batch the stricter criterion per test wins and the governing market is recorded. Whether State regulators expect IP in-process bands for export-only batches registered to USP or Ph. Eur. is open (India G-8); the default follows IN-34/IN-52 (IP applies).
- Release tests follow each market's registered specification; when one test result serves two markets, it must meet the tighter limit (production catalog section (b), item 2).

### E.2 Uniformity of weight / mass (in-process, TB-12 mode (b))

| Rule set | Applies to | n | Deviation bands (from the measured average W̄) | Acceptance | Confidence | Source |
|---|---|---|---|---|---|---|
| Ph. Eur. 2.9.5 | Uncoated and film-coated tablets (sugar-coated not covered) | 20 | W̄ ≤ 80 mg: 10 %; 80 mg < W̄ < 250 mg: 7.5 %; W̄ ≥ 250 mg: 5 % | At most 2 outside the band, none outside twice the band | High (bands and acceptance); Medium (exclusion of sugar-coated tablets) | tablets.json (Ph. Eur. 2.9.5 via EP7 copy); IN-34 |
| IP (IP 2026) uniformity of weight | Uncoated and film-coated tablets | 20 | Same bands as Ph. Eur. | Same | Medium (IN-34 status U; IP 2026 not seen; consistent with the sample BMR's ±7.5 %) | IN-34; India G-8 |
| USP-NF (drug tablets) | Drug tablets | n/a | No compendial band test for drug tablets; uniformity is judged by <905> (E.3) | In-process limits are in-house, derived from process data (211.110(b)) | High | tablets.json; 21 CFR 211.110(b) |
| USP <2091> | Dietary supplements only; never for drug tablets | 20 | 130 mg or less: 10 %; about 130-324 mg: 7.5 %; above 324 mg: 5 % (inclusivity at 324 mg not verified) | At most 2 outside, none outside double | Medium | tablets.json |
| In-house "legacy" table (IN-34) | Optional in-house IPC table | 20 | Same values as <2091> | Same | n/a (in-house) | IN-34 (U). It is not a current USP requirement for drug tablets. IP/Ph. Eur. is equal or tighter at every weight (tighter for 80-130 mg and 250-324 mg), so this table can never loosen the resolved band |

### E.3 Uniformity of dosage units / content uniformity (release; optional IPC via TB-12 mode (d))

| Rule set | Content | Confidence | Source |
|---|---|---|---|
| USP <905> = Ph. Eur. 2.9.40 (harmonised, also JP) | Acceptance value per C-14: L1 = 15.0, L2 = 25.0; k = 2.4 (n = 10) and 2.0 (n = 30); M rules for T ≤ 101.5 and T > 101.5 | L1/L2 High (research search of the USP harmonised text); k and M rules Medium-High (recollection matching tablets.json) | tablets.json; USP Stage 4 official 1 Aug 2023 (s) |
| Same, applicability | Weight variation may replace content uniformity for uncoated or film-coated tablets with at least 25 mg of active making up at least 25 % of the tablet mass; otherwise content uniformity; sugar-coated and other coated tablets: content uniformity | Medium-High | tablets.json ("from memory, not fully verified") |
| Same, alternative | Below the 25 mg / 25 % threshold, weight variation may be used when the concentration RSD in the final units is not more than 2 % on validation/development data and the regulator has approved the change | Medium (recollection only) | not in research inputs; verify |
| Ph. Eur. 2.9.6 (uniformity of content, test A for tablets) | Where justified and authorised: 10 units, each within 85-115 % of the average; if one is outside 85-115 % but within 75-125 %, test 20 more: pass if at most 1 of 30 is outside 85-115 % and none outside 75-125 % | Medium | recollection; verify |
| IP | Uniformity of content per IP; adoption of the harmonised UDU chapter in IP 2026 not confirmed (draft circulated Oct 2024 (S)); the IP threshold for when content uniformity replaces uniformity of weight is not verified | Low | India catalog section E and G-8 |

### E.4 Friability (TB-14)

| Rule set | Content | Confidence | Source |
|---|---|---|---|
| USP <1216> = Ph. Eur. 2.9.7 (harmonised) | Unit mass 650 mg or less: whole tablets as near as possible to 6.5 g; above 650 mg: 10 tablets; dedust and weigh; 100 rotations at 25 ± 1 rpm; one test normally; repeat twice more and average three when results are doubtful or the loss exceeds the target; a mean loss of at most 1.0 % (single run, or mean of three) is regarded as acceptable for most products; any obviously cracked, cleaved or broken tablet fails the sample; tilting the drum (about 10°) is allowed when tablet size/shape causes irregular tumbling | High (procedure, 6.5 g/650 mg/10 tablets, 100 rotations, 25 ± 1 rpm, 1.0 %); Medium (tilt detail) | tablets.json (USP Stage 4 official 1 Aug 2023 (s)) |
| Note | USP <1216> is an informational chapter (numbered above 1000), so 1.0 % binds only when the product specification adopts it | Medium-High | recollection |
| IP | Same procedure and 1.0 % guidance expected | Medium-Low (IP 2026 not seen) | India G-8 |

### E.5 Disintegration (TB-15)

| Rule set / tablet type | Medium, conditions | Time limit | Confidence |
|---|---|---|---|
| USP <701> (harmonised apparatus; all types) | Basket-rack, 6 units, water or the specified medium at 37 ± 2 °C; discs if the monograph specifies | Time per monograph; staging: if 1-2 units fail, test 12 more; pass if at least 16 of 18 disintegrate | High (staging, temperature); many USP monographs specify dissolution instead of disintegration |
| Ph. Eur. uncoated tablets (2.9.1 test A; monograph Tablets 0478) | Water, discs | 15 min | High |
| Ph. Eur. film-coated tablets | Water, discs | 30 min | Medium (not verified in research) |
| Ph. Eur. coated tablets other than film-coated | Water, discs; if a tablet fails, repeat on 6 more in 0.1 M HCl | 60 min | 60 min Medium-High; HCl repeat Medium-Low |
| Ph. Eur. gastro-resistant tablets | 0.1 M HCl without discs, 2 h or as authorised: no disintegration or cracks allowing escape of contents; then phosphate buffer pH 6.8 with discs | Buffer stage 60 min | Medium-Low (recollection) |
| Ph. Eur. effervescent tablets | One tablet in 200 mL water at 15-25 °C; 6 tablets | Each within 5 min | Medium |
| Ph. Eur. soluble / dispersible tablets | Water at 15-25 °C (dispersible also fineness of dispersion) | 3 min | Medium |
| Ph. Eur. orodispersible tablets | 2.9.1 test A | 3 min | Medium |
| Ph. Eur. retest staging | 1-2 failures: 12 more, at least 16 of 18 (harmonised wording) | n/a | Medium (verify Ph. Eur. wording) |
| IP | Expected to follow the same limits (uncoated 15, film-coated 30, other coated 60 min, gastro-resistant acid then buffer, dispersible/soluble 3, effervescent 5 min); the sample's cores NMT 15 min is consistent | as left | Low-Medium (IP 2026 not seen) |

### E.6 Other tablet tests

| Test | Rule | Confidence | Source |
|---|---|---|---|
| Breaking force (hardness) | No compendial limit; methods USP <1217> / Ph. Eur. 2.9.8; report in N (kp accepted with 1 kp = 9.80665 N); mean, min, max; limits in-house | High (unit conversion exact); Medium (chapter references) | tablets.json |
| Subdivision of scored tablets | Ph. Eur. 0478: 30 tablets broken by hand, one part of each weighed; at most 1 part outside 85-115 % of the mean part mass and none outside 75-125 % | Medium | tablets.json (secondary source) |
| Scored tablets, US | USP <705> (quality attributes of functionally scored tablets) and FDA Tablet Scoring guidance (2013) set the criteria | Low (USP <705> recalled only); guidance (s) | tablets.json for the guidance |
| Dissolution (release, via LIMS) | USP <711> immediate release: S1 each of 6 ≥ Q + 5 %; S2 mean of 12 ≥ Q and none < Q - 15 %; S3 mean of 24 ≥ Q, at most 2 < Q - 15 %, none < Q - 25 % | High | tablets.json |
| Loss on drying | Reference methods USP <731> / Ph. Eur. 2.2.32; in-process analysers need a documented correlation | Medium | tablets.json |
| Sugar-coated tablets | Uniformity of mass (2.9.5 tablet row) not applicable; content uniformity used | Medium | recollection; verify |

---
## F. Coverage test against the sample BMR

The sample is an example only. Each element in sample-bmr-analysis.md is mapped to the block(s) that express it with configuration alone. Status: **Covered** = expressible with the blocks as specified; **Covered (proposed)** = needs the proposed kernel element K-02 or a K-01 option added in this spec; **Partial** = expressible by composition, but a dedicated function would be cleaner; **Data issue** = the sample's content is inaccurate and the engine will reject or flag it.

### F.1 Document level

| Sample element | Blocks / mechanism | Status |
|---|---|---|
| Header repeated on each page (record and MFR numbers with revisions, product, batch number, size in units and kg, label claim, mfg/exp dates, issue and receipt signatures, change history fields, licence number, material code, storage, marketer) | K-01 header binding and rendering; MBR version metadata (PR-05, PR-06); India fields (India catalog C.1) | Covered |
| "Serial no." on the header | Issued-instance number and "page x of y" (DI-42, DI-43) | Covered (meaning in the sample is ambiguous; confirm with the user) |
| Shelf-life rule "36 months or API expiry, whichever is less" | K-01 expiry rule with the expiry-cap option; C-24 | Covered (proposed K-01 option). If the API lot carries a retest date instead of an expiry date, QA must define the rule; issuance of the expiry is blocked until then |
| MBR approval block (QA prepares, Production checks, Production head reviews, QA and QC heads approve) | MBR designer approval route: minimum preparer + independent checker + QU approval, extra signers allowed (PR-02; IN-06(c)) | Covered |
| History of change table | Master version history, change record and diff report (PR-05, PR-06, IN-03) | Covered |
| Abbreviations | K-03 instruction/glossary link | Partial (no controlled glossary master data; nice-to-have) |

### F.2 Batch summary

| Sample element | Blocks / mechanism | Status |
|---|---|---|
| Per stage: commencement and completion dates, area used, previous product and batch, checked by | K-02 stage frame (from step events and logbooks, K-09, K-10) | Covered (proposed K-02) |
| "Completed / not completed according to MFR", "deviation sheet attached Y/N" | K-02 derived status from executed steps and exception list (S-4) | Covered (proposed K-02); never typed |
| Actual yield, rework generated, total yield % | K-18, C-09; K-02 summary | Covered |

### F.3 The 28 building-block elements

| # | Sample element | Blocks | Status |
|---|---|---|---|
| 1 | Instructions, safety precautions, PPE, SOP references | K-03 (SOP version stamped) | Covered |
| 2 | Equipment cleaning-status table (equipment, ID, capacity, prior product and batch, cleaning date, checker and re-checker) | K-09 reading the equipment logbook (S-11), two-person verification option | Covered |
| 3 | BOM and weighing (qty per unit, qty per batch, AR no. and date, balance no., gross/tare/net, weighed/checked by; QC-approved and within retest) | K-07, TB-01, K-14 | Covered |
| 3a | Potency formula with salt-to-base ratio and as-is assay | TB-01, C-01..C-03, C-06 | Covered; **Data issue**: the sample labels 1155.36 as the trihydrate, but it is the anhydrous salt (C-06) |
| 3b | "Calculation checked by Production and QA" | TB-01 verification option (second verifier QA) | Covered |
| 3c | Compensating excipient (GAP-RISK in the analysis) | TB-01, C-04 | Covered |
| 3d | Requisition / issue workflow (requested by, stores supervisor, issued on) | K-05 requisition step + K-15 transfer (issued by / received by) + ERP interface | Partial |
| 4 | Stage-wise BOM sections (e.g. granulation and coating) | Formula sections per UP; UP-10 dispensing per section | Covered |
| 5 | Area/line clearance checklist, previous product/batch, Production check and QA re-check, satisfactory/not, T & RH | K-10 (QA verification option), K-11, optional K-16 gate "line clearance approved" | Covered |
| 6 | Process step with SOP reference, from/to time, done by, checked by | K-03, step timestamps (S-6), S-3 verification | Covered |
| 7 | Parameter entry with ranges (dampers 80-100 %, inlet 50-55 °C, outlet 30-35 °C, pan 1-5 rpm, air pressure 2-4 kg/cm², pump 15-35 rpm) | K-04, K-06, TB-18 periodic parameter log | Covered (air pressure in kgf/cm² is a valid pressure unit) |
| 8 | Timed steps (slow-speed mixing for 10 min; solution added within 4 min) | K-15 (minimum and maximum durations), TB-04 | Covered |
| 9 | Conditional entry ("if necessary add extra IPA, record weight") | K-17 operator-choice branch, K-07 liquid dispensing, TB-04 extra-fluid limit and authoriser | Covered |
| 10 | Loop until endpoint ("dry until LOD 2.0-3.5 %; redry and repeat") with every iteration recorded (GAP-RISK) | TB-05, K-17 loop | Covered |
| 11 | Sieve/screen integrity before and after use | TB-02 | Covered |
| 12 | Rework addition (source batch no., mfg/exp dates, quantity; ≤ 3 % of batch; ≤ 3 months old; increases theoretical yield) (GAP-RISK) | TB-08 (cross-batch checks, class, authorisation), K-24 for whole-batch rework, C-07 | Covered. **Data issue / regulatory gap in the paper form:** the sample does not say what the rework material is; if it is rejected material (e.g. compression or inspection rejects, which the sample's reconciliation calls "rework generated"), the addition is reprocessing and needs an approved procedure and QCU approval before use (211.115; Sched M 14.32); if it is conforming material, it is recovery and needs prior authorisation and a risk evaluation (EU 5.68; Sched M 14.33). The sample shows no approval step, and its "3 months old" has no stated reference date |
| 13 | Container-wise output weighing (gross/tare/net, totals, balance ID) | K-22 | Covered |
| 14 | Stage yield with standard and permissible range (std 99.5 %, permissible 99.0-100.0 %) | K-18 (expected yield plus min/max) | Covered |
| 15 | Press set-up record (machine, operator, tooling description and cleanliness, balance check, lubricant level, start time) | TB-10, TB-09, K-09 balance daily check | Covered |
| 16 | IPC on a double-sided press, separate left and right channels (hardness NLT 6 kg/cm², group weight of 20 within ±2 %, thickness 3.4 ± 0.2 mm, DT NMT 15 min, friability NMT 1 %, machine speed, temperature, RH) (GAP-RISK) | TB-11 streams L/R; TB-12 mode (a); TB-13; TB-15; TB-14; K-04; K-11 | Covered. **Data issue:** "kg/cm²" is a pressure unit; breaking force must be recorded in N or kp (C-17); the engine rejects the unit until the MBR is corrected |
| 17 | Start-of-run checks: 35 single-tablet readings per side (appearance, weight, thickness) | TB-11 start-of-run station sweep (one per station per side), TB-12, TB-13 | Covered (matches Sched M VIII 3.4) |
| 18 | Periodic IPC schedule (weight of 20 every 15 min; hardness and thickness of 3 every 30 min; DT of 6, weight variation, friability every 2 h) with reminders and overdue flags (GAP-RISK) | TB-11 | Covered; the sample schedule respects the 30-min ceiling (IN-35) |
| 19 | Weight variation: 20 single weights with mean, allowed vs actual max/min, limit ±7.5 % of mean | TB-12 mode (b), C-12, C-13, rule set E.2 | Covered |
| 20 | Friability: weight before, after 100 rotations, % loss | TB-14, C-15 | Covered |
| 21 | Number of tablets = net weight / average weight | K-22, C-10 | Covered |
| 22 | Inspection and rejection (reusable residue vs rejects for destruction, weights and counts, inspection time from/to, inspected by) | TB-20, K-23, K-22 (residue container) | Covered |
| 23 | Destruction record with witness (Production + QA) | K-23 (witness option) | Covered |
| 24 | "Intimate QA to draw sample"; LIMS hand-off; result gate | K-12, K-16 | Covered |
| 25 | QA hold points (coating approval yes/no; release for packing) with a QA summary of results | K-16 presets with evidence panel | Covered |
| 26 | Batch reconciliation (standard size, rework added, theoretical and actual quantity, %, variance; yield % = (A + B)/T) | K-18, C-07, C-09 (both yields shown) | Covered |
| 27 | Yield statement across stages (input, actual, %, standard, permissible lower/upper) | K-02 summary with K-18 results | Covered (proposed K-02) |
| 28 | Environmental conditions at stage start | K-11 | Covered |

### F.4 Weaknesses of the paper format and how the blocks remove them

| Paper weakness | Remedy |
|---|---|
| Manual calculations and transcription (potency, yields, counts) | TB-01, K-14, K-18, C-xx: engine computes, shows the formula, a verifier confirms (DI-33) |
| Free-text "has/has not", "Y/N" | K-02 derived statements (S-4 exceptions) |
| Ranges printed but not enforced | K-04 tiers with exceptions and deviation triggers (PR-08) |
| Loops, extra additions and rework recorded ad hoc | K-17 loop/branch, TB-05, TB-04, TB-08 |
| Header repeated per page; signatures without meaning or time | K-01 rendering; S-1 signature manifestation (DI-36) |
| IP references hard-coded | S-8 rule sets per pharmacopoeia and edition (Section E; IN-33) |

### F.5 Gaps found
1. **Stage frame and summary (K-02)** is not in the supplied kernel block list. It is needed for the sample's batch summary (per-stage dates, area, previous product, "completed per MFR") and for IN-15 (person responsible per stage). Proposed as a kernel addition for both editions.
2. **Expiry cap from input-lot expiry** is not in the supplied kernel K-01. Added here as a K-01 option. Open point: treatment of API lots that carry only a retest date.
3. **Material requisition approval** (requested by / stores supervisor / issued on) has no dedicated block; it is composed from K-05, K-15 and the ERP interface. Acceptable; a dedicated requisition block is optional.
4. **Glossary/abbreviations**: no controlled glossary master data; handled as instruction content. Nice-to-have.
5. **Sample data issues the engine will reject or flag** (not block gaps, but they must be fixed when this MBR is built): the trihydrate label on the anhydrous molar mass (C-06); hardness in kg/cm² (C-17); rework addition with no visible approval step, no stated material class and no defined age reference (TB-08); yield formula (A + B)/T that includes rework generated (K-18 shows both yields).
6. **Header "serial no."**: meaning in the sample is unclear (page serial or document serial); mapped to the issued-instance number and page numbering pending confirmation.

No other element of the sample needed product-specific code.

---

## G. Uncertain values, verification status and open questions

### G.1 Uncertain values (flagged, not asserted)
- **Pharmacopoeial values not re-read in an official text (all of Section E).** Highest-risk items: Ph. Eur. film-coated disintegration 30 min; other-coated 0.1 M HCl repeat; gastro-resistant acid and buffer stages; effervescent (5 min), soluble/dispersible/orodispersible (3 min) conditions; Ph. Eur. wording of the 16-of-18 staging; every IP 2026 value (uniformity-of-weight bands, disintegration times, friability, content-uniformity threshold and whether the harmonised UDU chapter is adopted); USP <905> k values and M rules (research flagged them as recalled) and the 2 % RSD alternative; Ph. Eur. 2.9.6 test A details; USP <2091> band boundary at 324 mg; USP <705>; exclusion of sugar-coated tablets from 2.9.5; friability drum tilt; the numbering of the USP General Notices rounding rule.
- **Secondary-only regulatory items:** Schedule H2 data elements and dates, including the 2026 expansion (S/U); DSCSA and EU 2016/161 details (s); EU start-of-shelf-life rule (CPMP/QWP/072/96 (s)); FDA Q&A on BU sample size 1-3x unit dose (s).
- **Industry numbers shown only as illustrations (s), never defaults:** dispensing tolerances (±0.5 % / ±1 %); stage yield limits in D.2; blister leak-test vacuum and hold time; metal-detector test-piece sizes; ribbon-check interval; IPC template frequencies (the 30-min compression ceiling itself is verified, Sched M VIII 3.8).
- **Molar masses** in C-06 are computed from IUPAC standard atomic weights; literature values differ in the second decimal place (e.g. 558.64 vs 558.65), which does not change any conclusion.

### G.2 Verified in primary texts during this digest
- 21 CFR 211.101, 211.103, 211.110, 211.111, 211.115, 211.122(g)-(h), 211.125, 211.130, 211.134, 211.137, 211.186, 211.188, 211.192.
- EU GMP Ch.4 4.17-4.21 (incl. 4.20(d) recovered/reprocessed material and 4.21(h)); Ch.5 5.37-5.44, 5.57-5.69.
- Revised Schedule M: Part I 14.14, 14.15, 14.31-14.34 (rework, recovery, new batch number, additional testing), 17.3.8 (recovered material in BMR); Part VIII 1.3-1.10, 1.14, 2.1-2.5, 3.1-3.8 (incl. the 30-min sampling ceiling and station-wise start check), 4.1-4.2, 6.1-6.2, 7.1-7.4.

### G.3 Open questions
1. **IP bands for export-only batches** (India G-8): default applies IP in-process bands to every India-made batch; confirm with Indian QA/regulatory practice.
2. **Parameter set at the 30-min interval** (India G-4): Schedule M applies the 30-min limit to sampling against the in-process specification and leaves the six named parameters to periodic checks; confirm which parameters inspectors expect every 30 min (default template: weight/appearance at ≤30 min).
3. **"Same product" for recovery/rework (TB-08):** is the check product code only, or also strength and formula version? Default: all three.
4. **Per-use QA authorisation for conforming recovery (TB-08 class (a)):** default ON; confirm whether customers may rely on the MBR-level prior authorisation.
5. **Hold scope on double-sided presses with merged chutes:** default holds all streams when containers are shared; confirm whether any customer has side-segregated collection that allows per-side hold.
6. **Intermediate yield limits** (production catalog F-12): minimum and maximum required at every configured checkpoint; confirm the customer's position.
7. **Automated dispensing and single-person verification** (production catalog F-1; DI open question 3): default keeps a second human for US-market products.
8. **Continuous manufacturing (ICH Q13)** scope for v1 of the Tablets edition.
9. **Retest-dated APIs in the expiry cap** (F.5 item 2).
10. **Sample "serial no."** meaning (F.5 item 6).
