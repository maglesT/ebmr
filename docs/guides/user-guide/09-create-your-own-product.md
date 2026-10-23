# Create your own product

This page walks through making a tablet product of your own, without a built-in template: its materials and the
product, its formula, a master batch record from the formula, a sandbox test run and the approvals, its packaging master
and the first GMP batch. Two invented products are worked through:

- **Demotab 400 mg, wet granulation, film coated, alu-alu**: a master copied from the approved wet-granulation master and
  edited to the product (a plain film coat instead of the enteric one). The browser tests
  `tools/e2e/specs/phase7/own-product.spec.ts` and `own-product-gmp.spec.ts` follow these steps.
- **Rabeprazole sodium 20 mg gastro-resistant tablets**: the same start, then three coating layers stacked in the
  designer: a seal coat, the enteric coat and a top coat (section 6a).

| Step | Who | Screen |
|---|---|---|
| 1. Materials and product | Master-data steward (`MASTER_DATA_STEWARD`) | Master data, Products and materials |
| 2. Confirm them | QA MBR approver (`QA_MBR_APPROVER`) | Quality, ERP import status |
| 3. Formula | Master-data steward | Master data, Formulas |
| 4. Approve the formula | QA MBR approver | Master data, Formulas, the formula |
| 5. Master from the formula | MBR author (`MBR_AUTHOR`) | Master records, New master record |
| 6. Build the stages | MBR author | The designer |
| 7. Test lots and test run | Sandbox steward, sandbox issuer and floor | Sandbox: Test lots, Test-run packages, kiosks |
| 8. Evidence and signatures | Author, checker, regulatory signer, QA | The designer's evidence and signing screens |
| 9. Packaging master | MBR author, then the same reviews | Master records, New master record |
| 10. GMP batch | Planner, floor, QC, QA | Orders, kiosks, QC, review and release |

## 1. Materials and the product

Your ERP normally sends the item master. For a product the ERP does not know yet, open **Master data**, then
**Products and materials**, and fill in:

- **Enter a material**: material code (capitals, digits and `/ . _ -`), name, kind (API, excipient, packaging),
  stock unit, grade, pharmacopoeia (IP, BP, Ph. Eur., USP, JP, in-house or none), the maximum retest interval and the
  reason for the entry. Press **Enter the material**.
- **Enter a product**: product code, strength, name, dosage form, shelf life in months, whether it is a beta-lactam and
  whether the registration permits reprocessing, and the reason. Press **Enter the product**.

On the demo installation the walk-through's materials are there after every demo reset: `DMT-API` (Demotab active),
`DMT-LAC` (lactose monohydrate) and `DMT-MGS` (magnesium stearate), each with a sandbox test lot (`TEST-L26-0201` to
`0203`). To repeat the walk-through, enter only the product and go on from step 3; to show the material entry as well,
enter new codes.

Each entry is listed under "Waiting for QA confirmation": nothing uses it until QA confirms it. The approved
manufacturers of each material are shown beside it and kept by QA on **Quality, Approved manufacturers**.

## 2. QA confirms the masters

QA opens **Quality, ERP import status**. Each version entered on screen is listed with the values it brings. Press
**Confirm** and sign (meaning *ERP master change confirmed*). The person who entered a version cannot confirm it.

## 3. The formula

The steward opens **Master data, Formulas**, records the formula (product code, strength, batch size in tablets) and
opens it. Under **Write a new version**, add one line per material:

- line id, material code, role (active, excipient, coating, processing aid);
- basis: per unit (mg in one tablet) or per batch (kg, for a processing aid such as a granulating solvent);
- quantity, and for an active its overage and salt factor if any;
- **Potency adjusted at dispensing** for an active whose quantity follows the lot's assay and LOD (TB-01), with exactly
  one **Compensating excipient** that takes up the difference.

Add the **target tablet weight** and any **further batch sizes** (in tablets), the reason, and press **Write the draft
version**. The batch quantities are computed by the system, never typed.

## 4. QA approves the formula

On the formula's page QA presses **Approve version 1** and signs (meaning *Formula version approved*). The author of
the version cannot approve it.

## 5. A master batch record from the formula

The author opens **Master records**, then **New master record (from a template or a formula)**, and chooses how the
master starts:

- **From the formula, with the required skeleton**: a dispensing stage (room clearance, balance status, SOP, dispensing
  quantities, weighing of the actives and of the other components, reconciliation) and a blending stage (clearance,
  equipment status, charge, blending and lubrication with TB-07, QA hold point, discharge, yield);
- **From the formula, blank**: only the dispensing stage's clearance and balance status;
- **From the formula, as a copy of an approved master**: another approved master's procedure with this product's bill
  of materials.

Under **Choose a product**, name the product, strength and batch size and press **Choose this product**: the bill of
materials is shown with the computed quantities. Give the family code and press **Create the family and its draft**.
The header, the approved batch sizes and the bill of materials come from the formula.

## 6. Build the stages in the designer

In section 5 of the designer, **Add a stage** (name and room; it starts with its room clearance and equipment status),
rename it, set its rooms, add equipment by equipment class, move stages up or down and remove them. In the procedure
(section 8), insert steps after any step: every tablet block TB-01 to TB-24 and every generic block is offered, each with
its configuration form. The validator and the simulation check the result; the toolbar says whether it passes.

## 6a. Stack coating layers

A coating stage copied from an approved master has one layer: a suspension (TB-03), the cores' weight before the coat
(TB-18, cores part) and the coating loop (TB-18, coating part) that ends when the weight gain is within its limits. To add
a layer, select the suspension, cores or coating step of the stage in the procedure and open **Add a coating layer**:

| Field | Rabeprazole seal coat | Rabeprazole top coat |
|---|---|---|
| Layer name | Seal | Top |
| Coating type | Film coat (FC) | Film coat (FC) |
| Suspension | Film-coating suspension | Film-coating suspension |
| Target weight gain (%) | 2 | 3 |
| Minimum weight gain (%, a functional film) | empty | empty |
| Maximum weight gain (%) | 3 | 4 |
| Lowest / Highest mean tablet weight before the coat (mg) | the core weight limits | the enteric-coated weight limits |
| Coating iterations allowed (1 to 20) | 5 | 5 |
| Where | Before (the enteric suspension) | After (the enteric coating loop) |

Press **Add the coating layer**. The designer adds the layer's own suspension step, its cores step and its coating loop,
and the parameters `core<Name>` and `gain<Name>` with the limits typed; the spray settings are copied from the layer
selected. Each layer's gain is computed against the mean weight recorded at the start of that layer, so the seal coat's
gain is measured on the bare cores, the enteric coat's on the sealed tablets and the top coat's on the enteric-coated
tablets. Keep the enteric layer's coating type "Functional film, e.g. enteric (FC_F)" with its minimum gain: a functional film needs a lower limit. The
undo button removes the whole layer in one step. Then fix the BOM lines and limits the validator names and save the
revision.

For a gastro-resistant tablet, keep the disintegration step's acid stage (TB-15, gastro-resistant). The two-stage
dissolution release requirement (acid then buffer) comes with the dissolution profile release work; until then, release
uses the disintegration result and the existing release tests.

## 7. Test lots and the sandbox test run

On the sandbox, the steward opens **Test lots** and registers a TEST- lot of each new material; under **Assay and
artwork of a test lot** the steward types the active's assay and water (the potency calculation reads them) and, for
printed foil and cartons, the artwork version. The sandbox has its own plant (**Plant master data** and **Plant**):
rooms, equipment, tooling sets and cleaning are recorded there as on GMP, against the sandbox database only, and every
screen keeps the TEST, NOT GMP band. Define the product's tooling set on the sandbox before the test run. The author sends the
version to the sandbox (**Send to sandbox…**); the issuer imports the package and issues a test batch, and the floor runs
it on the kiosks as for any test run. The issuer exports the test-run result for GMP from the run page.

## 8. Evidence, signatures and the market authorisation

The author starts the verification and imports the sandbox run's result as evidence; then the author signs
*Prepared*, the checker *Independently checked*, the regulatory signer confirms the registration references and QA
approves. QA proposes the market authorisation, the regulatory signer confirms its registration and QA authorises it.

## 9. The packaging master

Under **New master record**, choose **A packaging master for a product, as a copy of an approved packaging master**.
Pick the approved packaging master to copy (for example the cold-form alu-alu master), give the packaging product's code
and strength, and for each printed item of the source (foil, carton, leaflet) the product's own printed material and
its artwork version. The copy replaces the printed items everywhere they occur (specimens, line set-up, forming webs); a
printed item left out is refused. The copy then goes through the same checks, sandbox packaging test run (with printed
lots carrying the artwork version), signatures and authorisation as the processing master.

## 10. The GMP batch

On GMP, QC records each received lot's results on the lot page: the identity test (**Identity test**) and the assay,
water and other results picked from approved PASS results; QA releases the lot. The batch comes from its ERP order; the
floor runs it on the kiosks stage by stage (clearance, equipment status, the steps, the stage sign-off), then packing,
QC, the production and QA reviews and the release.

A GMP batch needs the plant the master names (rooms, equipment and their kiosks) registered and qualified; with the
skeleton's sandbox clearance and status steps (G-10 and G-09 version 1) the validator reports that a GMP batch refuses
them: insert their database-backed versions from the palette once the plant is in place.
