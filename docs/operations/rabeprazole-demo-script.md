# Rabeprazole demo: presenter script

Hosted demo (DEMO-ONLY, invented data): GMP https://187-126-126-5.sslip.io, sandbox https://sandbox.187-126-126-5.sslip.io.
Product: **Rabeprazole sodium 20 mg gastro-resistant tablets, RAB-GR-20.** It's loaded ready: licence, approved
specifications (including the two-stage dissolution), QC-released lots, and an approved processing master
**RAB-WG-DEMO** (seal, enteric and top coats) and packaging master **RAB-CF-DEMO**, both authorised for India.
You start at the ERP order. This exact path is the `p3-demo` browser test, which passed on the deployed code.

## Before the demo
1. In every browser you will use, clear the site data for **both** host names (padlock → Site settings → Delete
   data). Otherwise the demo terminals won't sign in after a reset.
2. Open the GMP site and pick demo terminals. You need office PCs (**PC-PLAN-04** planning, **PC-QC-01** QC,
   **PC-QA-01** and **PC-QA-09** QA) and kiosks (**KIOSK-DISP-1**, **-GRAN-1**, **-BLEND-1**, **-COMP-1**, **-COAT-1**,
   **-INSP-1**, **-PACK-2**). Two windows side by side work well: office left, kiosk right.
3. The credential card is under Operations → "Credential card (DEMO-ONLY)". On kiosks, people sign in with the demo
   badge reader's **Tap** buttons.
4. A full run takes about 60–90 minutes. For a 30-minute slot, do Parts 1, 2 (dispensing and one coat), 4 and 5.
5. Rehearse once end to end. Then reset (`/usr/local/bin/batchwright-demo-reset` on the server, about 20 minutes)
   so the real demo starts clean.

## Part 1 — order, plan, issue (office, about 5 min)
- **Say:** "The ERP sends a production order. The batch is planned from an approved, market-authorised master, and
  only released lots can be used."
1. Operations → Simulators → **Send a production order**: the rabeprazole processing order.
2. Planning (PC-PLAN-04): open the order, **plan the batch** on master RAB-WG-DEMO, then **Issue batch** with an
   e-signature. The batch number comes from the rule RAB{YY}{SEQ:3}.
3. Stores reserve the lots. Active RAB-API-0001: **3.100 kg**. Cellulose: **5.000 kg**. Lactose 9.000, PVP 0.900,
   IPA 0.900, croscarmellose 0.900, silica 0.150, magnesium stearate 0.300, coating mix 2.800 kg.

## Part 2 — processing on the kiosks
On each kiosk the order is the same: **line clearance** (operator, then verifier), **equipment status**, the steps,
**yield**, stage sign-off. Each value is recorded by the person who tapped, and a second person verifies.
1. **Dispensing (KIOSK-DISP-1):** the dispenser weighs, the verifier verifies.
   - **Say:** "The active's quantity is adjusted for this lot's assay; the cellulose absorbs the difference."
   - Active **3.037 kg** (potency adjusted: assay 99.40 %, water 0.60 %), cellulose **4.464 kg**, the others as
     reserved.
2. **Granulation (KIOSK-GRAN-1):**
   - Binder **1.800 kg**.
   - Wet massing, drying in its loop with the filter bag.
   - Milling through a checked screen: **17.300 kg in, 17.250 kg out, 0.050 kg oversize**.
3. **Blending (KIOSK-BLEND-1):** lubricant **0.300 kg**, blend net **18.500 kg**. Blend times are checked against the
   master's validated range.
4. **Compression (KIOSK-COMP-1):** tooling set **TS-RAB-DEMO**.
   - Weight checks **124.8, 125.4, 125.9, 124.6 mg** (target 125 mg).
   - Thickness and hardness: 5.10 / 95, 5.12 / 98, 5.08 / 92.
   - Friability: 52 tablets, 6.510 → 6.495 g.
   - Strokes 148 500. Yield: good **18.400 kg**, residue 0.100, rejects 0.050.
   - **Say:** "A value outside its limit stops the step until it's handled."
5. **Coating (KIOSK-COAT-1): three coats in a row**, each with its own suspension and its own weight gain.
   - **Say:** "This is the delayed-release part: the enteric coat stops the tablet dissolving in the stomach."
   - Pan load **18.400 kg**.
   - **Seal coat** 2.0 %: suspension 2.500 kg, 2.300 used, mean core mass 2.5000 → 2.5500.
   - **Enteric coat** 9.0 %: 9.000 kg, 8.500 used, 2.5500 → 2.7795.
   - **Top coat** 3.0 %: 3.500 kg, 3.200 used, 2.7795 → 2.8629.
   - Coated net **21.070 kg**; disintegration: gastro-resistant.
6. **Inspection (KIOSK-INSP-1):**
   - 147 100 inspected, **146 300 accepted**.
   - Defects: 500 chipped, 300 colour spot.
   - 300 destroyed, 500 residue. Bulk units 1000.
   - QA then **releases the bulk for packing** (hold point, signed).

## Part 3 — packing (KIOSK-PACK-2, line PL-2)
1. Send the packaging order (Simulators), plan it from the batch released for packing on master **RAB-CF-DEMO**, and
   issue it.
2. On KIOSK-PACK-2: line clearance and units booked; the dispenser weighs the laminate.
   - **Say:** "Printed foil RAB-FOIL-0001 and cartons RAB-CTN-0001 are issued from their own lots, with their
     approved artwork."
3. Then: coding checks, the tablets packed, yield, stage sign-off.

## Part 4 — QC (PC-QC-01, then the head of QC)
1. The finished lot is posted in **quarantine**.
2. QC records the **assay** and the **dissolution profile**:
   - **acid stage**: at most 10 % at 2 h;
   - **buffer stage**: at least 75 % at 45 min;
   - then pulls the **reserve sample** (1 pack per test).
3. **Say:** "Two stages, one requirement: the database judges each point against the approved specification."
4. The **head of QC approves** the results.

## Part 5 — review and release (QA)
1. **Production review**, then **QA review** of the batch records.
2. Open the lot's **release checklist**. Every item is green, and the two-stage dissolution shows as **one green line**
   (G3.PROFILE_DISSOLUTION).
3. **Say:** "If one dissolution point were out of limits, this line would be red and the release refused."
4. The authorised person **releases** the lot (e-signature). The lot leaves quarantine.

## Questions you may get
- *Can I build my own product like this?* Yes: product, formula, a master from the formula (copy an approved master
  and edit it), a sandbox test run, approval, authorisation. Rabeprazole itself was first built that way on screen.
- *Is any of this arranged behind the scenes?* No. The data was loaded by the same acts a user performs, and every
  step in the demo is a real act with its audit trail and signatures.
