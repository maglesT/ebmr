# Making an antibiotic safely: dedicated rooms and the refusals

Beta-lactam antibiotics (penicillins, cephalosporins and inhibitors such as clavulanic acid) can sensitise people at
very low levels. Schedule M and the US FDA rules ask that they are made in dedicated, segregated rooms with their own air
handling, and clavulanate-type actives also need low humidity. Batchwright holds these rules in the database, so a
wrong room is refused whoever tries it and from whatever screen.

This page is the demo part for that. It uses demo route B: the invented product "Cefexemplone proxetil and
clavexemplate potassium tablets 325 mg" (`CXC-325`), film coated, made by direct compression and packed in alu-alu
cold-form blisters from a laminate with a desiccant layer. The browser tests `tools/e2e/specs/phase7/route-b.spec.ts`
(the full batch) and `tools/e2e/specs/phase7/route-b-refusals.spec.ts` (the refusals) follow the same steps.

## What the demo installation already has

After `pnpm demo:setup --with-gmp-samples` (or a demo reset with the samples):

| What | Where |
|---|---|
| SITE-1 is a penicillin facility: proposed by the master-data steward, approved by QA | **Plant rules** |
| The beta-lactam suite: dispensing booth `BL-DISP`, blending room `BL-BLEND`, compression room `BL-COMP`, coating room `BL-COAT` and the alu-alu line `BL-PL`; each dedicated to `BETA_LACTAM` by the QA MBR approver and approved by a second QA person | **India, Product rules** (areas) |
| The suite's kiosks `KIOSK-BL-DISP`, `KIOSK-BL-BLEND`, `KIOSK-BL-COMP`, `KIOSK-BL-COAT`, `KIOSK-BL-PACK`, with a Tap button for every demo floor person | The device picker |
| The suite's balances, blender `BLD-BL-01`, press `PRESS-BL-01` (tooling `TS-RTB-01`), coater `COATER-BL-01`, cold-form machine `CFORM-BL-01` and cartoner `CTN-BL-01`, qualified and (the balances) calibrated | **Plant** |
| The route B masters, approved and authorised for India, the US and the EU; ample lots `RTB-*`; open ERP orders `PO-RTB-0001` to `0003` and `PO-RTBPK-0001` to `0004` | **Planning**, **Quality, Material lots** |

The product's own beta-lactam classification is not seeded: you make it on screen (step 1).

## 1. Classify the product (steward, then QA)

Sign in as the master-data steward and open **Plant rules**. Under **Propose a beta-lactam classification** choose
**Product**, type `CXC-325`, choose **is beta-lactam**, give the reason and press **Propose the classification**. Do the
same for the two actives (**Material**, `MAT-CXP-PX` and `MAT-CLX-K`). A beta-lactam classification tightens the rules,
so it is in force at once and waits for QA.

Sign in as QA (the QA MBR approver) and approve each one with **Approve version 1 of ...**: the classification is
approved by a person other than the steward (PR-27). The steward's own approval is refused.

## 2. Make the batch in the suite

Plan and issue the batch from its ERP order (**Planning**), reserve the lots, have the technicians clean the suite
(**Plant**), then work on the suite's kiosks:

- `KIOSK-BL-DISP`: the clearance of `BL-DISP`, the balance, then **the room's humidity** (G-11): type the hygrometer
  reading, for example 22 %. The suite's limit is 30 %. Then both actives are dispensed potency-adjusted (TB-01, each
  with its compensating excipient), the other materials, the reconciliation.
- `KIOSK-BL-BLEND`: blending and lubrication (TB-07).
- `KIOSK-BL-COMP`: tooling, press set-up, the run with each side's weight checks; QA approves the cores (H-COAT).
- `KIOSK-BL-COAT`: the film suspension, then the cores step checks the coating room against the same 30 % limit
  (TB-18), the film to its weight gain; QA releases the bulk for packing (H-PACK).
- `KIOSK-BL-PACK`: the packaging order on `BL-PL`: the desiccant laminate weighed, the line check and sealing run (TB-21
  cold form), the leak tests (TB-22), cartons and shippers (TB-24).

QC records and approves the lot's results, both records are reviewed, and the authorised person releases the lot.

## 3. Show the refusals

| Try this | What happens |
|---|---|
| On `KIOSK-DISP-1`, **Plant**, record a clearance of `DISP-1` for a route B batch | Refused: the batch is beta-lactam and `DISP-1` is not a room dedicated to beta-lactam products (EBMR-PLANT-177). No clearance is recorded. |
| On `KIOSK-BL-DISP`, **Plant**, record a clearance of `BL-DISP` for a GB-T-02 batch | Refused: `BL-DISP` is dedicated to beta-lactam products and GB-T-02 is not one (EBMR-PLANT-178). |
| In a route B batch, type 45 % at the dispensing room's humidity step | The step raises an environmental excursion: production and QA are notified and the steps after it wait for a deviation. In the coating room, a humidity above 30 % at the cores step does the same. |

The same rules hold for the start of a room's use, not only for its clearance, and for any writer: they are database
rules (recipe-core 1600), not checks of the screen. A room's dedication counts only once a second QA person has
approved it; a withdrawal of the dedication counts at once.
