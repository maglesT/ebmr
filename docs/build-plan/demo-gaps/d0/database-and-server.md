# D0: refusals an author meets when building a formula, an MBR family/version, or a packaging master

Read-only inventory, repo `/home/user/ebmr` as of 7 Nov 2026. Each function is quoted from its **latest** definition
(highest migration of its source; tablets-server `sql/` runs after the platform sources). Constraints are given as they
stand after every `alter table`. The regulatory text available is only the repo's paraphrases
(`compliance/controls/*.yaml` `sources`, `compliance/requirements/requirements.jsonl`). So every (a) means **per repo
sources**: the official texts were not checked.

Basis classes: **(a)** a binding clause supports this refusal. **(b)** a real technical need of record integrity or of
the engine. **(c)** neither: an internal decision only, or stricter than any clause. Every (c) row carries a proposal.

Clause paraphrases used below (from `requirements.jsonl`):
- 211.186(a): one master per product and batch size, prepared/dated/signed by one person and independently checked by a
  second.
- 211.186(b): name/strength/form; each active's quantity per unit and the total unit weight; a *complete list of
  components*; an accurate amount for each component in one weight system, with "reasonable variations" only where
  justified; any calculated excess stated; theoretical weights and yields; packaging and labelling.
- 211.100(a): written, QU-approved procedures; changes are drafted, reviewed and approved too.
- EU Ch.4, lead-in to 4.17 and 4.17(a)-(d): an approved formula for each product and batch size, listing each starting
  material with its amount. 4.19: a packaging instruction for each product, pack size and type.
- Part 11 11.10(e) / Annex 11 §9: an audit trail, and a reason for each change.
- Part 11 11.50/11.70: a signature shows its meaning and is linked to its record.

---

## 1. Formula library (`formulary.*`, `recipe.formula_*`)

| # | Code / constraint | File:line (latest) | Refuses | Cites | Class | Basis / proposal |
|---|---|---|---|---|---|---|
| F1 | EBMR-FRM-001 | recipe-core/sql/0640_formulation_library.sql:223 | formula request not an object, or batch size not a whole number of units (1–12 digits) | D-S6-3 | b | The engine scales from per-unit × units (INV-25). The size bound is a sanity limit. |
| F2 | EBMR-FRM-002 | 0640:227 | product/strength not in the ERP product master | D-S6-3 | b | Master-data integrity: the formula is keyed to a known product (211.186(b)(1) needs the name and strength). |
| F3 | `formula` unique (product_code, strength, batch_size_units) (raw 23505, no FRM code) | 0640:82 | a second formula for the same product, strength and batch size | (D-S6-3) | b | `recipe.formula_choice` picks the formula by this key. It also matches 211.186(a) / EU 4.17 lead-in (one master formula per product and batch size); alternatives go through versions. UX note: it surfaces as a bare unique violation. |
| F4 | `formula` checks: product_code/strength non-blank ≤64; batch_size_units integer 1..10^12 | 0640:75-77 | blank or oversize keys | — | b | Field integrity. |
| F5 | EBMR-FRM-003 | 1875_formula_capsule_batch_excipient.sql:38; 0640:329, 408, 448 | unknown formula / version | — | b | Reference integrity. |
| F6 | EBMR-FRM-004 / `formula_version.change_reason` check (non-blank, ≤2000) | 1875:42; 0640:89 | a version without its author's reason | DI-22 | a | Part 11 11.10(e) and Annex 11 §9 (reason for a change), per repo sources. The 2000-character cap is (b). |
| F7 | EBMR-FRM-005 (lower bound) | 1875:45 | a version with 0 lines | D-S6-3 | a | 211.186(b) needs a complete component list, so an empty formula is no formula. |
| F8 | EBMR-FRM-005 (upper bound: **more than 60 lines**) | 1875:45 | a 61st line | D-S6-3 (which says nothing about 60) | **c** | No clause sets a maximum. Multivitamin/mineral products can reach 40–60+ components. **Proposal: relax to 200, or drop it and keep only a payload size limit.** |
| F9 | EBMR-FRM-006 | 1875:49 | a new version while the latest version is still DRAFT | DI-35, INV-25 (test name) | **c** (as combined) | One open draft at a time is a fair (b) rule by itself. But **nothing can discard or reject a formula draft**: `formula_version_state` has only DRAFT/APPROVED/SUPERSEDED, there is no withdraw function, and the lines are insert-only. A draft with a mistake can only be approved (signing a known-wrong composition) or left to block the formula forever. **Proposal: add `formula_withdraw_draft(version, reason)` (insert-only withdrawal row, audited, DRAFT only, state WITHDRAWN) and let FRM-006 ignore withdrawn drafts. Alternative: let a new version supersede an unapproved draft, with a reason.** |
| F10 | EBMR-FRM-007 | 1875:62 | a line not an object; quantities not decimal text; bad basis; flags not boolean | INV-25 | b | Exact decimals, never JS number (CLAUDE.md rule). |
| F11 | EBMR-FRM-008 | 1875:66 | material not in the ERP material master | — | b | Master-data integrity. 211.186(b) asks for names or codes specific enough, which the master supplies. |
| F12 | EBMR-FRM-009 | 1875:76 | a PER_BATCH line other than a processing aid (or, for a capsule, a shell excipient) | INV-25 | b (with a defect) | The engine computes the unit mass and batch quantities from per-unit amounts, so per-unit is engine design: 211.186(b) / EU 4.17(b) accept either basis. **Defect:** a COATING line given per batch is refused even for a capsule, yet `from-formula.ts:122` tells the author "a coat on the capsules is given per batch". A coated capsule therefore cannot be written except as a PROCESSING_AID, which leaves the coat out of the unit mass (wrong). **Proposal: allow COATING PER_BATCH (at least for CAPSULE, like the shell excipient), or reword the designer message.** |
| F13 | EBMR-FRM-060 / `formula_line_one_overage` | 1875:79; 1740_formula_overage_reason.sql:38 | overage given both in percent and as a quantity | D-7q-1 | b | Prevents a double-counted excess (INV-25). |
| F14 | EBMR-FRM-061 / `formula_line_overage_reason` (NOT VALID) | 1875:82; 1740:39 | an overage with no reason, or a reason with no overage | D-7q-1, PR-04 | a | 211.186(b) asks for a statement of any calculated excess. A justification of the excess is the dossier's (per repo, US-211-101A: "overages allowed only when declared and justified in the MPCR"). The reverse half (no reason without an overage) is (b). |
| F15 | EBMR-FRM-010, member "a line id once" = PK (version_id, line_id) | 1875:95; 0640:111 | a duplicate line id | D-S6-3 | b | Lines are referenced by id (BOM id `BOM-<lineId>`, the formula_mbr_problem bookkeeping). Note: the PK is case-sensitive but `from-formula.ts:52` upper-cases (`mcc` and `MCC` both pass the DB, then collide as `BOM-MCC`). Make it case-insensitive. |
| F16 | **EBMR-FRM-010, member "a material once" = unique (version_id, material_code)** | 1875:95; 0640:112 | **the same material on two lines** | D-S6-3 only (D-S6-3 says nothing on it) | **c** | 211.186(b) needs a complete list of components with an accurate amount for each; it does not ask for one line per material. Real formulas split a material (intra- and extra-granular MCC or croscarmellose; starch as binder paste and as disintegrant). **Downstream dependence found (it must change with the constraint):** (1) `recipe.formula_mbr_problem` (1740:220) matches each BOM line to its formula line by **material code** (`select … where material_code = v_code`, ambiguous with duplicates); (2) `from-formula.ts` `materialRefs` (l.101) makes one reference per line keyed by material (duplicate reference ids), and `copy()` (l.336, 368) matches by material code. Execution does **not** depend on it: dispensing, lot checks and TB-01 work per BOM line id (`recipe.lot_usability_problem` 0372:36; TB-01 `bomLine`), and the parser/validator does not require one BOM line per material. **Proposal: drop the unique; match formula↔BOM by line id (`BOM-<lineId>`, already deterministic) in formula_mbr_problem and from-formula; give one material reference per distinct material.** |
| F17 | EBMR-FRM-010 / `formula_line_salt_on_active` | 1875:95; 1740:37 | a salt factor on anything but a per-unit ACTIVE | D-S6-3 | b | The salt-to-base conversion is an active's (TB-01 BASE standard). Hydrate/anhydrous factors on excipients are rare and can be stated in the quantity. |
| F18 | EBMR-FRM-010 / `formula_line_check1` (potency only on ACTIVE), `formula_line_check2` (compensating only on EXCIPIENT) | 1875:95; 0640:114-115 | potency adjustment on a non-active; compensation on a non-excipient | D-S6-3 | b | The C-03/C-04 calculations are defined that way (PR-19). |
| F19 | EBMR-FRM-010 / column checks: line_id `^[A-Za-z][A-Za-z0-9_-]{0,31}$`, material_code pattern, role ∈ {ACTIVE, EXCIPIENT, COATING, PROCESSING_AID}, basis, quantity>0, overage % in [0,100), salt factor in [1,10), overage_quantity>0, reason ≤500, batch_quantity_kg>0 | 0640:99-110; 1740:32-33 | out-of-range values | INV-25 | b | Field integrity and sanity bounds. |
| F20 | **EBMR-FRM-011 (first): at most one compensating excipient** | 1875:99 | a second line flagged `compensating` | TB-01 | **c** | 211.186(b) allows justified reasonable variations; it sets no count. **Nothing downstream reads the formula's `compensating` or `potency_adjusted` flags**: they are stored and shown only (0640:199; no TS/SQL consumer outside the demos and tests). TB-01 names its compensating excipient **per step** (`config.compensation.bomLine`, tb-01.ts:262; tab.tb01_calculation 0842:193), and `compensating_excipient()` already takes several actives. A fixed-dose combination with two adjusted actives, each in its own TB-01 step with its own diluent, is valid for the engine and refused only here. **Proposal: remove the count. Optionally check at MBR validation that each TB-01 compensation line is a formula line flagged compensating.** |
| F21 | EBMR-FRM-011 (second): a potency-adjusted active needs a compensating excipient | 1875:103 | an adjusted active with no compensating line | TB-01 | **c** | TB-01 accepts compensation mode NONE where the registration lets the core weight vary (tb-01.ts:271, TB01-NO-COMPENSATION). The formula rule contradicts it. **Proposal: drop this direction.** |
| F22 | EBMR-FRM-011 (third): a compensating excipient needs an adjusted active | 1875:103 | a compensating line with no adjusted active | TB-01 | b | A coherence check: q.s. without an adjustment means nothing. Keep. |
| F23 | `formula_version` unique (formula_id, version_number), version_number ≥1 | 0640:94 | — (set by the function) | — | b | Version identity. |
| F24 | insert-only triggers on all formulary tables (`kernel.reject_mutation`) | 0640:140-146; 1535:31 | an update or delete | DI-22 | a | Part 11 11.10(e): records are not overwritten. **But see F9: insert-only with no withdraw row means a draft is permanent.** |
| F25 | EBMR-FRM-012 | 0640:335 | approval by someone other than the FORMULA_APPROVED signer | DI-35 | a | Part 11 11.50/11.70: the signature is linked to its signer and record. |
| F26 | EBMR-FRM-013 | 0640:338 | approval by the version's author | DI-35 | a | 211.186(a): independent check by a second person. |
| F27 | EBMR-FRM-014 (twice) | 0640:341, 344 | approving an approved version again, or a version that is not the latest | — | b | Single approval and no out-of-order approval. |
| F28 | `formula_approval` PK version_id; signature_id unique | 0640:119-120 | a second approval row; reused signature | DI-35 | b | One signature per act. |
| F29 | EBMR-FRM-050 | 1535_formula_unit_target.sql:48 | target on an unknown version | — | b | |
| F30 | EBMR-FRM-051 / `formula_version_target` PK | 1535:53; 1535:22 | a target on a non-DRAFT version, **or a second target on the same draft** | PR-01 | **c** (second half) | Writing the target only in DRAFT is (b): the approver signs it. "Once" is stricter than needed and, with F9, a mistyped target cannot be corrected at all. **Proposal: allow re-setting while DRAFT (insert-only rows, latest stands, audited), as for packaging labelling.** |
| F31 | EBMR-FRM-052 (format, each size once, not the reference size) | 1535:57, 61 | a non-positive mass, a non-integer size, duplicates | PR-01 | b | Discrete approved sizes (211.186(a) per batch size). |
| F32 | EBMR-FRM-052 "at most nine further batch sizes" / check `cardinality(other_batch_sizes) <= 9` | 1535:66; 1535:24 | a 10th further size | PR-01 (sets no number) | **c** | No clause limits how many sizes a master lists. **Proposal: relax to e.g. 50, or drop it.** |
| F33 | `formula_version_target` target_unit_mass_mg in (0, 100000) | 1535:23 | out of range | — | b | Sanity bound. |
| F34 | EBMR-FRM-015 | 0642_formula_readers_by_flag.sql:47 (also 0640:426) | no formula for product/strength/units | — | b | |
| F35 | EBMR-FRM-016 (formula choice) | 0642:51 | the formula has no approved version | D-S6-3 | a | An MBR's formula is an approved master formula (211.186(a); EU 4.17 lead-in "approved"). |
| F36 | EBMR-FRM-016 (pin time) | 0640:453 | **pinning a formula version that is still DRAFT** to a DRAFT MBR | D-S6-3 | **c** (mild) | The approval requirement is enforced again at MBR approval (FRM-020), and draft lines are insert-only, so pinning a draft is safe and lets the MBR be drafted in parallel. **Proposal: allow a DRAFT formula at pin time; keep FRM-020 at approval.** (Low priority.) |

## 2. MBR pinning to a formula and the composition check

| # | Code / constraint | File:line | Refuses | Cites | Class | Basis / proposal |
|---|---|---|---|---|---|---|
| P1 | EBMR-FRM-017 | 0640:534 | pinning while the MBR version is not DRAFT | PR-06 | a | 211.100(a): changes to approved procedures are drafted, reviewed and approved (change control). |
| P2 | **EBMR-FRM-018** / `mbr_formula_pin` PK mbr_version_id | 0640:537; 0640:128 | **re-pinning another formula version on the same DRAFT MBR** | PR-06 | **c** (mild) | While the MBR is DRAFT its content changes freely, and FRM-020 checks the pin again at approval. "Once" forces withdrawing the MBR version, and the designer exposes no withdraw route (see M10). **Proposal: allow re-pin while DRAFT (insert-only, latest stands, audited); keep "never after DRAFT".** |
| P3 | EBMR-FRM-019 via `recipe.formula_mbr_problem` | 0640:541; problem fn 1740:186-256 | the MBR's product/strength ≠ formula's; reference batch size (first size, in kg or g) ≠ theoretical batch mass; a BOM line of role ACTIVE/EXCIPIENT/PROCESSING_AID not in the formula; a BOM quantity ≠ computed; BOM overage ≠ formula's; a formula line missing from the BOM | INV-25, D-7q-2 | a + b | 211.186(b) (complete list, accurate amount, calculated excess stated) and INV-25 (computed, never typed). The kg/g reference unit and "first size is the reference" are engine design (b). The material-code matching is the dependency in F16. |
| P4 | EBMR-FRM-020 (guard `mbr_version.registered_ranges_kept`, APPROVE) | 0640:587, 591 | approving an MBR whose pinned formula is not APPROVED, or whose content no longer carries the composition | D-S6-3, PR-06, INV-25 | a | 211.186(a) / EU 4.17: the approved master carries the approved formula. |

## 3. MBR family and version (recipe-core 0110/0150/0250/0760, guards 0130 and later)

| # | Code / constraint | File:line | Refuses | Cites | Class | Basis / proposal |
|---|---|---|---|---|---|---|
| M1 | `mbr_family.code` unique + pattern `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (designer DESIGNER_FAMILY_CODE, DESIGNER_FAMILY_EXISTS on 23505) | 0110:93; family.ts:84; designer/index.ts:332 | a duplicate or malformed family code | PR-01 | b | Identification. |
| M2 | **`mbr_family_identity`** unique (edition, record_kind, product_code, strength, dosage_form, batch_sizes) **where record_kind <> 'PACKAGING'** | 0760_packaging_family_pack_type.sql:63 (re-created; the 0110:109 original was dropped) | a second processing/reprocessing family with the same identity | INV-17 (one CURRENT per family/market/scope), PR-01 | b (index), **c (missing discard path)** | The index itself is sound: 211.186(a) / EU 4.17 lead-in ask for one master per product and batch size, and a twin family would sidestep INV-17. Two corrections to the lead's reading: (1) **the DB can discard a draft**: DRAFT→WITHDRAWN (author, reason; 0140:101), and `recipe.create_version` then accepts a new version in the same family (it refuses only once an approved version exists, RCP-025). (2) **The app cannot**: the designer has no WITHDRAW route and no "new draft in an existing family" route (it always calls `defineFamily` + `createVersion`, index.ts:543/592/703), so an abandoned family blocks the author with DESIGNER_FAMILY_EXISTS. The family row is insert-only and permanent (code, title, product name cannot be corrected). Also: `batch_sizes` is compared as a whole JSON set, so {100 kg} and {100 kg, 200 kg} are different identities, and two families can both list 100 kg (the index is weaker than its comment claims). **Proposal: keep the index; expose DRAFT→WITHDRAWN and "start a new draft in this family" (`recipe.create_version`) in the designer, and when the identity exists offer the existing family instead of refusing. Owner question: should identity be per batch size rather than per size set?** |
| M3 | `mbr_family` checks: title non-blank; edition ∈ `kernel.editions()`; record_kind ∈ {PROCESSING, PACKAGING, REPROCESSING}; product fields non-blank; batch_sizes a non-empty array | 0110:94-102; 1872_edition_checks.sql:16; 0624:41 | malformed family | PR-01 | b | |
| M4 | EBMR-RCP-011 (`recipe.canonical_batch_sizes`) | 0110:252, 260, 264 | no batch size; a size not {id, quantity:{value>0, unit}}; duplicate size ids | PR-01 | a | 211.186(a) / EU 4.17: per batch size, so at least one discrete size. |
| M5 | DESIGNER_BATCH_SIZE (5 sites) | family.ts:107, 112, 115, 117, 121 | no size; not a positive decimal; **unit other than kg or g**; a size listed twice | PR-01 | b | Mass units because the engine scales the BOM by mass and FRM-019 compares in kg/g. A size in tablet count is entered on the formula instead (formula_set_target). |
| M6 | EBMR-PLN-001 / 002 / 003; `mbr_family_pack_identity` unique (… , pack_type); pack_type pattern | 0760:73, 99, 125, 129; 0760:60 | a pack row on a non-packaging family; a packaging family without a pack type; a pack type on a processing family; a malformed pack type; a twin packaging family | D-P4-13, PR-01 | a | EU 4.19: a packaging instruction for each product, pack size and type. |
| M7 | EBMR-RCP-010 / RCP-020 | 0150:83; 0150:105, 128, 181, 197, 217; 0250:49; 0110:438 | unknown family / version | — | b | |
| M8 | EBMR-RCP-025 | 0150:87 | `create_version` in a family that already has an approved version | PR-06 | a | 211.100(a) and change control: a change to an approved master is a new version compared with its baseline (derive). |
| M9 | EBMR-RCP-027 (twice) | 0150:109, 112 | deriving without a reason, or from a version that is not APPROVED/RETIRED | PR-06 | a | Part 11 11.10(e) / Annex 11 §9 (reason); change control from the approved baseline. |
| M10 | EBMR-RCP-021 (`recipe.assert_draft`; content, attributes) | 0110:359 | editing content or draft attributes outside DRAFT | PR-06 | a | 211.100(a) and 211.186(a): the approved master is not changed in place. |
| M11 | "A version under creation has exactly one initial content revision" (RCP-020) | 0110:441 | a second initial revision | — | b | |
| M12 | EBMR-RCP-022 | 0110:445 | content whose hash ≠ the DB's canonical hash | DI-04 | b | Record integrity (what is signed is what is stored). |
| M13 | EBMR-RCP-023 via `recipe.content_family_problem` | 0110:453; fn 0760:149-205 | wrong format/version; header family, edition, kind, product, strength, form or batch sizes ≠ family; packType ≠ family's; market set not distinct two-letter codes; **India not in the market set** | INV-28, PR-01 | a / b | Header = family is (b). India always in the set is (a): Revised Schedule M applies to every batch made under an Indian licence (per repo, IN-52; project rule). |
| M14 | EBMR-RCP-024 | 0110:396 | changing a version's identity (family, number, author, predecessor) | PR-05 | b | Audit integrity. |
| M15 | `mbr_version` unique (family_id, version_number), derived_from ≠ id; `mbr_content` unique (version_id, revision), hash pattern; `mbr_draft_entry` unique (version_id, cycle), first-cycle check; no delete/truncate on `mbr_version` | 0110:114-152, 420-421 | — | PR-05, DI-22 | b | |
| M16 | EBMR-RCP-026 | 0110:474 | a return to DRAFT without its from-state | — | b | |
| M17 | EBMR-RCP-028 | 0250:54 | an unknown draft attribute key | — | b | |
| M18 | EBMR-RCP-060 (twice) | 0250:60; 0150:263 | an unknown change record; a change record without the process-impact flag | PR-06 | a | EU Ch.4 4.29 / Ch.5 5.24-5.26 change control, per repo. |
| M19 | EBMR-RCP-061 (three) | 0110:505; 0150:185, 201 | risk subjects not ids; unknown assessment; unlinking an unlinked one | PR-07 | b | |
| M20 | EBMR-RCP-040 / 041 | 0120:103-174 | evidence outside DRAFT/IN_VERIFICATION; unknown evidence kind or mode; a sandbox run without a run id | DI-04 | b | |
| M21 | EBMR-RCP-123 (`recipe.content_roles_check`) | 0324_mbr_content_roles.sql:112 | content naming a role no person can carry, or a QA hold point not released by the quality unit | PR-45, INV-26 | a | 211.22 (QU responsibilities), per repo. |
| M22 | EBMR-TAB-165 (`tab.mbr_content_market_guard`) | apps/tablets-server/sql/0280_designer_guards.sql:43, 50 | content without a market set, or one the market engine refuses | IN-52, INV-34 | b | The content minima must resolve. |
| M23 | EBMR-TAB-155 / 156 | 0280:79, 83, 90; tablets 0150:200 | a justification for a version with no content, or for an older revision/hash | IN-02, DI-04 | b | |
| M24 | `tab.validator_justification_guard` (turns VALIDATOR evidence into FAIL) | 0280:97-128 | justifications not bound to this revision and hash | IN-02, DI-04 | b | |

### Life-cycle guards an author or reviewer meets (mbr_version machine, 0140; functions latest as named)

| # | Guard / code | File:line | Refuses | Cites | Class | Basis / proposal |
|---|---|---|---|---|---|---|
| G1 | content_present | 0130:247 | START_VERIFICATION with no content | DI-04 | b | |
| G2 | validator_passed | 0130:262, 265 | START_VERIFICATION without a passing VALIDATOR record on this exact content | PR-02, DI-04, outline 6.3 | b | The TS validator's own rules (PR-03 minima etc.) are out of scope here (not DB). |
| G3 | evidence_complete (`recipe.evidence_status`) | 0130:279; status fn 1830:16 | SUBMIT/APPROVE without passing VALIDATOR, VERIFICATION and TEST_VECTORS (a sandbox run is optional, decision 0026 O-2) | DI-04 | b | Owner decision 0026 already relaxed it; DI-04 sources 211.100(a), 211.186(a), Annex 11 §4.1. |
| G4 | change_record_linked; change_control_complete | 0130:284, 422, 428 | SUBMIT/APPROVE with no change record; a process-affecting change without a validation link | PR-06 | a (b for a first version) | Change control (211.100(a); EU 4.29 / 5.24-5.26), per repo. For version 1 of a new product, "every new master needs a change record" is a company convention more than a clause; harmless. Keep. |
| G5 | critical_elements_risk_assessed (+ EBMR-RBE-005) | 1050_rbe_rules.sql:158-174 | SUBMIT with CRITICAL parameters/calculations not covered by a linked risk assessment; RBE without change control and validation reference | PR-07, PR-52 | a (EU) | PR-07: US none binding; EU Annex 11 §6, Ch.5 5.20-5.21 per repo. Stricter rule wins. |
| G6 | prepared_by_author | 0130:306 | PREPARED signed by someone other than the author | PR-02 | a | 211.186(a). |
| G7 | signed_in_state | 0130:314 | a signature applied before the from-state was entered | PR-02, INV-04 | b | Signature/record sequence (Part 11 11.70 linking). |
| G8 | checker_independent | 0130:333-339 | the author checking; a checker who edited since DRAFT | INV-04, PR-02 | a | 211.186(a) independent check. |
| G9 | approver_independent | 0130:364-377 | the author approving; an approver who edited; checker = approver unless policy S4 | INV-04, PR-02 | a | 211.186(a) plus QU approval 211.100(a)/211.22(c). The three-person default is configurable (S4), so it is not (c). |
| G10 | regulatory_confirmed | 0130:387 | APPROVE without REGULATORY_CONFIRMED | PR-04 | a | Per repo sources (211.100(a), 211.186(b)(9); EU Ch.5 principle). |
| G11 | effective_date_set | 0130:395 | APPROVE without an effective date | PR-02 | b | |
| G12 | review_due_set | 0130:401 | APPROVE without a review-due date after the effective date | PR-05 | a | EU Ch.4 4.5 (documents kept up to date), per repo. |
| G13 | registered_ranges_kept (incl. FRM-020) | 0640:568-613 | registered elements changed without the regulatory action | PR-04 | a | |
| G14 | in_flight_dispositioned | 0130:487 | approval while batches of an earlier version run with no disposition | PR-05, ADR 0014 | b | |
| G15 | draft_entry_recorded / never_authorised / no_open_authorisation (EBMR-AUDIT-002) | 0301:53, 65-69; 0290:299-303 | RETURN/WITHDRAW/RETIRE without a reason; withdrawing a version that was authorised; retiring a CURRENT one | DI-22, PR-05 | a | 11.10(e) / Annex 11 §9 (reason). |
| G16 | EBMR-LIB-021 / LIB-024 (triggers on platform.state_history) | 1810_library_execution.sql:374; 1871:73 | approving a master that calls a library element not in force, or one of another edition | PR-05, decision 0026 | b | |

## 4. Packaging master

| # | Code / constraint | File:line | Refuses | Cites | Class | Basis / proposal |
|---|---|---|---|---|---|---|
| K1 | EBMR-LBL-010 / 012 / 013 / 014 (`declare_packaging_labelling`) | 0990_label_templates.sql:332-350 | declaring on a non-DRAFT version; a step/item that is not a G-21 printed item; a bad form; a 211.122(g) option on a non-cut label; an unknown template | PR-36, D-P6c-8 | a | 211.122(g) (cut-label controls), per repo. |
| K2 | `packaging_labelling` checks (step/item patterns, form list, option list, option only on CUT_LABEL); insert-only | 0990:258-271 | malformed declarations | PR-36 | b | |
| K3 | EBMR-LBL-011 (`labelling_at_approval_check` → `packaging_labelling_problem`) | 0990:373; problem 0990:284-309 | APPROVE while a declared item is no longer in the procedure, a cut label has no 211.122(g) option, or a template is not APPROVED | PR-36, IN-31 | a | 211.122(g); Schedule M Part I 17.3.1 (label particulars), per repo. |
| K4 | `recipe.packaging_master_problem` (met at **packaging-order planning**, 1218:115, not at save) | 0800_packaging_master_every_path.sql:76-94 | a packaging master with no completion block of its edition, or one that can complete without it (optional branch, zero-instance replicate, **library element**) | PR-37, IN-16, D-3b-1 | a, **c for the library-element member** | 211.134 / EU 4.19(i) (finished-pack examination at the end), per repo. A completion block inside a library element is refused unread ("stricter, default D-3b-1"). **Proposal: read the library snapshot's body (as LIB-021 already resolves it) instead of refusing every library call.** The author also meets this only at order time; the designer should report it at save. |
| K5 | DESIGNER_COPY_PACKAGING / DESIGNER_PRINTED_ITEMS (11 sites) | packaging-copy.ts:68-134 | copying a non-packaging master; a copy for the **same** product/strength; a printed item left unreplaced, unknown, the source's own print or another item's print; a non-printed material; a bad artwork string or shelf life | PR-01, PR-06, PR-32, IN-38, PR-43 | a | 211.122 / 211.130 and Schedule M Part VIII 7.1-7.4 (no other product's print), per repo. A same-product copy would be a twin family (the request carries no new pack type or size, M6), so (b) there. |

## 5. Designer server refusals (apps/tablets-server/src/features/designer)

| # | Code | File:line | Refuses | Cites | Class | Basis / proposal |
|---|---|---|---|---|---|---|
| D1 | DESIGNER_PRODUCT | family.ts:91 | blank, untrimmed or >200-char product fields | PR-01 | b | |
| D2 | DESIGNER_MARKETS (duplicates, unknown, IN missing) | family.ts:95-99; from-formula.ts:66-70; packaging-copy.ts:74; index.ts:732 | a bad market set | IN-52, INV-28 | a / b | Same as M13. |
| D3 | DESIGNER_CONTENT / DESIGNER_COPY | family.ts:139; from-formula.ts:134, 438 | content that does not parse; no source named | PR-03, PR-01 | b | |
| D4 | DESIGNER_MATERIAL | from-formula.ts:104 | a formula material not in effect in the material master | PR-17 | b | |
| D5 | DESIGNER_FORMULA (capsule shells) | from-formula.ts:122 | a capsule formula with more than one per-unit COATING line | PR-01, PR-03 | b (heuristic) + **defect** | The engine identifies the shell line by role+basis. The message's advice ("a coat on the capsules is given per batch") is refused by FRM-009 (F12), so a coated capsule has no valid expression. Fix together with F12. |
| D6 | DESIGNER_FORMULA (no active) | from-formula.ts:154 | a formula with no per-unit active | PR-01 | b | 211.186(b)(1) quantity of each active per unit; also the skeleton dispenses actives. |
| D7 | DESIGNER_FORMULA_TEMPLATE | formula-choice.ts:17 | a template whose materials are not the formula's | INV-25, PR-01 | b | |
| D8 | DESIGNER_FORMULA_REQUIRED | index.ts:448 | a tablets master started without a template and without an approved formula | (decision 0006 part 1) | c (owner) | Owner decision 0006: composition comes from the library. No clause requires it. **Keep; it is the owner's to change, not a defect.** |
| D9 | DESIGNER_EDITION_START (twice) | index.ts:463, 643 | injectables/API masters started from a skeleton, template or packaging copy | PR-01 | b | Templates are tablet procedures. |
| D10 | DESIGNER_PRODUCT_MASTER (twice) | index.ts:501, 575 | no product master in effect, or a dosage form that does not fit the edition | PR-01 | b | |
| D11 | DESIGNER_NO_CONTAINED_AREA (twice) | index.ts:535, 694 | a hazard-classed product with no dedicated, QA-approved contained room/line | IN-27 | a | Schedule M Part III (containment), per repo. |
| D12 | DESIGNER_COPY_NOT_APPROVED | index.ts:605 | copying a master that is not APPROVED/EFFECTIVE | PR-06 | c (mild) | The copy is a new draft that goes through full verification, check and approval anyway, so no clause forbids starting from an unapproved draft. **Proposal: optional; allow copying any version the author can read, with the source recorded. Low priority.** |
| D13 | DESIGNER_TEMPLATE_UNKNOWN | index.ts:657 | an unknown template | — | b | |
| D14 | DESIGNER_NO_CHANGE | index.ts:743 | saving an identical revision | DI-04 | b | Avoids needlessly voiding evidence. |
| D15 | DESIGNER_STALE | index.ts:194, 212; signables.ts | a save or sign on a stale revision | — | b | Concurrency. |
| D16 | DESIGNER_GATE_FAILED | index.ts:243 | start verification/submit while the analysis has errors or unjustified warnings | PR-03, IN-02, DI-04 | a / b | 211.186(b) completeness (PR-03 sources). |
| D17 | DESIGNER_FAMILY_EXISTS | index.ts:332 | see M1/M2 | INV-17 | b | See the M2 proposal (offer the existing family). |
| D18 | Master-data formula routes | master-data/index.ts; api-contract ns/master-data.ts:23, 208 | no refusals of their own beyond the DB's: the zod schema mirrors line_id and material patterns and 1–60 lines | — | — | If F8 changes, change `max(60)` in the contract too. |

---

## Summary counts

The tables hold 103 rows. A row with a split class counts as (c) when part of it is (c), and otherwise under its first
class. **(a): 33. (b): 56. (c): 13.** One row (D18) has no class. Of the 13 (c) rows, 9 are firm, 3 are mild (F36, P2,
D12) and 1 is an owner decision (D8).

### (c) rows and proposals
1. **F16 FRM-010 "a material once"** (unique (version_id, material_code)): drop it. Match formula and BOM by line id in
   `formula_mbr_problem` and `from-formula.ts`, with one reference per distinct material. Execution is keyed by BOM line
   and does not depend on it.
2. **F20 FRM-011 "at most one compensating excipient"**: remove the count. The flag is read by nothing downstream, and
   TB-01 picks the compensating line per step.
3. **F21 FRM-011 "adjusted active needs a compensating excipient"**: drop this direction. It contradicts TB-01 mode NONE.
4. **F9 FRM-006 with no way to discard a formula draft**: add a reasoned, audited WITHDRAW for a DRAFT formula version.
5. **F30 FRM-051 target "once"**: allow re-setting while DRAFT, the latest row standing.
6. **F8 FRM-005 max 60 lines**: relax to about 200, and change the API contract with it.
7. **F32 FRM-052 / check "≤ 9 further batch sizes"**: relax to about 50, or drop it.
8. **M2 mbr_family_identity with no discard path**: keep the index. Expose DRAFT→WITHDRAWN and a new draft in an existing
   family in the designer, which the DB already allows. Note the batch-size-set loophole.
9. **K4 packaging completion inside a library element refused unread**: read the library snapshot. Also report the
   problem at save, not only at planning.
10. **P2 FRM-018 pin once**: allow re-pin while DRAFT, the latest pin standing.
11. (mild) **F36 FRM-016 at pin time**: allow pinning a DRAFT formula, since FRM-020 checks again at approval.
12. (mild) **D12 DESIGNER_COPY_NOT_APPROVED**: optionally allow copying any readable version.
13. (owner) **D8 DESIGNER_FORMULA_REQUIRED**: keep, as decision 0006.

### Defects found on the way
- F12/D5: COATING given per batch is refused, while the designer tells capsule authors to give a coat per batch.
- F15: the line-id PK is case-sensitive, but the designer upper-cases it into the BOM id, so `mcc` and `MCC` collide.
- F3: a duplicate formula surfaces as a bare unique violation, with no EBMR-FRM code.
