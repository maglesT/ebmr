# Create your own product

This page walks through making a tablet product of your own, without a built-in template: its materials and the
product, its formula, a master batch record from the formula, a sandbox test run and the approvals. The browser test
`tools/e2e/specs/phase7/own-product.spec.ts` follows the same steps with the invented product "Demotab 400 mg, wet
granulation, film coated, alu-alu".

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

## 1. Materials and the product

Your ERP normally sends the item master. For a product the ERP does not know yet, open **Master data**, then
**Products and materials**, and fill in:

- **Enter a material**: material code (capitals, digits and `/ . _ -`), name, kind (API, excipient, packaging),
  stock unit, grade, pharmacopoeia (IP, BP, Ph. Eur., USP, JP, in-house or none), the maximum retest interval and the
  reason for the entry. Press **Enter the material**.
- **Enter a product**: product code, strength, name, dosage form, shelf life in months, whether it is a beta-lactam and
  whether the registration permits reprocessing, and the reason. Press **Enter the product**.

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

## 7. Test lots and the sandbox test run

On the sandbox, the steward opens **Test lots** and registers a TEST- lot of each new material. The author sends the
version to the sandbox (**Send to sandbox…**); the issuer imports the package and issues a test batch, and the floor runs
it on the kiosks as for any test run. The issuer exports the test-run result for GMP from the run page.

## 8. Evidence, signatures and the market authorisation

The author starts the verification and imports the sandbox run's result as evidence; then the author signs
*Prepared*, the checker *Independently checked*, the regulatory signer confirms the registration references and QA
approves. QA proposes the market authorisation, the regulatory signer confirms its registration and QA authorises it.

A GMP batch needs the plant the master names (rooms, equipment and their kiosks) registered and qualified; with the
skeleton's sandbox clearance and status steps (G-10 and G-09 version 1) the validator reports that a GMP batch refuses
them: insert their database-backed versions from the palette once the plant is in place.
