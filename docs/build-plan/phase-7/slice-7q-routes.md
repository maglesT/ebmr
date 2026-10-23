# Slice 7q: formula and process capabilities for R8

Requirement R8 of `demo-trial-requirements.md` (complex formulations with the existing blocks only): the capabilities
C1, C2, C8, C9 and C10 that the test products P1 to P12 need. Slices 7o (C3, the R4 browser helpers) and 7p (C4, C5, C7)
own the others; the products themselves come in later slices. Branch `phase-7/slice-7q` (from `phase-7/r7-requirements`).
Migrations: recipe-core 1660; tablets 1661, 1662. No new EBMR-EXE codes (1662 reuses EBMR-EXE-242 and -606); formula
codes EBMR-FRM-060 and -061.

## Status per capability

| # | Capability | Status | Where |
|---|---|---|---|
| C1 | Overages in the formula | built | recipe-core 1660; formula editor; master's bill of materials |
| C2 | Potency adjustment in enzyme activity units (U/mg) | built (TB-01@2) | tablets 1662; `blocks/tb-01.ts`, `blocks/dispensing/potency.ts` |
| C8 | Peel-off blister | built (configuration option) | `blocks/tb-21.ts` `packFormat.opening`; tablets 1661 |
| C9 | Trilayer tablets | exists (TB-16 takes two or three layers) | `blocks/tb-16.ts`; test added |
| C10 | Branches merging into one blend | exists (proven) | recipe-core engine test; designer validator and simulation test |

## What is built

- **C1 overages** (recipe-core 1660). A formula line states an overage on any role, in percent or as a quantity in the
  line's unit (mg per unit, kg per batch for a processing aid), never both, always with its reason (EBMR-FRM-060, -061;
  the table refuses a new line with an overage and no reason, `formula_line_overage_reason`, NOT VALID so lines written
  before keep their reasonless percent overage). The label claim stays the quantity; the computed batch quantity, the
  theoretical batch mass, the BOM of a master taken from the formula and so every dispensing target (G-07, TB-01) include
  it. The approver signs it: the signed content carries `overageQuantity` and `overageReason` on a line that has them,
  and is unchanged for every line without them (no signature of an earlier version moves). The MBR content's BOM line may
  state the overage it includes (`bom[].overage`, recipe-core flow model and parser); a master from the formula writes it,
  and `recipe.formula_mbr_problem` (re-created from 0690) refuses a bill whose statement differs from the formula line or
  drops a reasoned overage. Screens: the formula editor (two new line fields, the composition column shows the overage
  and its reason) and the designer's document view (bill of materials: "includes an overage of ...: reason").
- **C2 activity units** (tablets 1662). TB-01@2 = TB-01@1 plus the basis ACTIVITY: the lot's approved result is its
  activity in U/mg (on GMP a current, QC-approved, passing LIMS result of test ACTIVITY in U/mg; in the sandbox a test
  lot's value), the MBR states `active.declaredActivity` (U/mg, FORM standard, a mass unit), a lot of activity A takes
  standard x declared / A (rounded UP: never fewer units than the label claim), the compensating excipient as before.
  The calculation stores each lot's activity, its relative activity (percent, six decimals) and the batch's label claim
  in units (standard with overage x mg per unit x declared), exactly, with BigInt rationals in TypeScript and numeric in
  the database, which recomputes and compares (`tab.tb01_calculation`). The lot register takes the ACTIVITY basis with no
  200 % cap (a percent assay keeps it). The TB-01 configuration form in the designer is generated from the v2 schema, and
  the floor renderer shows the potency form for both versions.
- **C8 peel-off** (tablets 1661). TB-21's pack format takes `opening`: PUSH_THROUGH (the default), PEEL_OFF or
  PEEL_PUSH; a strip pack has no lidding foil to peel (TB21-OPENING). The designer's TB-21 form shows it from the schema.
- **C9 trilayer**: TB-16 already accepts two or three layers, each with its own hopper, blend and plan; a run test with
  three layers charged (and refused while one is uncharged) is added. No custom block is needed.
- **C10 merging branches**: an engine test (recipe-core `test/blocks/material.test.ts`) runs a parallel wet and dry
  branch whose granule containers and a directly weighed container are charged into one step, each container traced
  from the step that made it to the step it went into, the blend waiting for both branches; a server test
  (`designer/merging-branches.test.ts`) builds route W's master with a parallel wet branch (TB-03, TB-04, TB-05, TB-02,
  G-22) and dry branch (TB-06, TB-02, G-22) blended in one TB-07, which the validator, the execution definition and the
  simulation accept with every step reached. The validator's DATA-PARALLEL rule refused the first draft because both
  branches used the same mill: correct (two branches at the same time cannot share a machine), so the dry branch got its
  own mill; no product defect. The DEMO-ONLY reference catalogue gained the roller compactor's class, system and ribbon
  risk assessment (EQC-RC, SYS-RC, QRM-RC-01) that P1 needs. The browser proof comes with P1.

## Decisions (owner rule: functionality first, least strict option within the hard rules)

- D-7q-1: an overage may stand on any formula line (not only a per-unit active), in percent or as a quantity in the
  line's unit, always with a reason; lines written before 1660 keep a percent overage without a reason (the new check is
  NOT VALID), and their signed content does not change.
- D-7q-2: the overage is shown on the master's bill of materials (the record the batch is issued on) as an optional
  `overage` statement of the BOM line, checked against the formula by the database; the executed batch shows the
  dispensing targets that include it. No separate batch-record field.
- D-7q-3: peel-off is a property of the pack format (`packFormat.opening`, optional, absent = push-through) of TB-21@1,
  not a new version: no data schema changes and every existing master keeps its meaning.
- D-7q-4: activity units are a new version of the existing block (TB-01@2), because TB-01@1's entry schema is held by
  the database and a released version never changes (ADR 0010, as TB-20@2); TB-01@1 stays for its masters and batches.
  Units: U/mg only; no upper bound on a lot's activity (the 200 % cap applies to percent assays).
- D-7q-5: C9 needs no follow-up: TB-16 generalises to three layers.
- D-7q-6: C10 is proven in the engine and the designer (validator, definition, simulation); the database genealogy edges
  (lot consumption at dispensing, output containers) are block-independent and need no change.

## Follow-ups

- Recording a lot's approved assay or activity result (`tab.record_lot_assay`) has no route or screen: the demo seed
  records them. P4, P7 and every potency-adjusted product need it on screen (review-backlog 7q-1).
- Browser proofs: C1 and C2 with P7 and P1, C8 with P8, C10 with P1.
