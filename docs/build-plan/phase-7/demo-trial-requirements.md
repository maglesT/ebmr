# Batchwright Tablets: requirements from the hosted-demo trials (October 2026)

Source: the owner's trials of the hosted demo (187.126.126.5) on main 79e09be8 (slice 7i, PR #64), including a full
GB-T-02 batch done live by a first-time presenter on 22 October 2026, and a scripted full batch on the live demo.

Owner's goal: every block must be demonstrable; nothing a person needs may be unreachable from the site; the demo must
not fail on things a presenter meets; a company must be able to create its own tablet formulation, load it and make
batches from it, without the built-in templates. CLAUDE.md rules apply.

## R1. Every tablet block demonstrable on screen (all 24, every coating and pack type)
Only 6 of 24 tablet blocks have been completed by a person on the kiosks (TB-07, 09, 10, 11, 23, 24, in GB-T-02).
- Demo plant (--with-gmp-samples): register, qualify and calibrate the equipment and rooms every block needs:
  rapid-mixer granulator, fluid-bed dryer (filter bags), sifter/mill with screens, roller compactor, bilayer press,
  reject and detection devices, pan coater, tablet printer, inspection station, thermoform, cold-form (alu-alu) and
  strip packing lines with leak testers. Each production room gets its kiosk.
- Demo products and masters, approved and authorised, invented, ample lots and several open ERP orders each (R5):
  - Wet route, film coated, alu-alu: TB-01, 02, 03, 04, 05, 07, 08, 10, 11, 12-15, 18 (functional film, e.g. enteric),
    20, 21 (COLD_FORM), 22, 24.
  - Dry route, bilayer, printed, strip: TB-06, 02, 07, 16, 17, 19, 21 (STRIP), 22, 24.
  - Sugar-coated, thermoform: TB-18 (SC: seal, sub-coat, smoothing, colour, polish), 21 (THERMOFORM), 22.
  - GB-T-02 (direct compression, bottles) stays.
- Machine readings on GMP (TB-04, 05, 06 take EQUIPMENT readings with a gateway readingId): a GMP gateway with
  simulated granulator, dryer, compactor and coater (preferred), or a proven manual path (second person, exception).
- One browser test per route (like phase7/gmp-kiosk-batch.spec.ts), ERP order to released lot, screens only, no
  database arrangement, control IDs in names. Fix whatever those runs find, each with its test.

## R2. Nothing a person needs may be unreachable from the site
Unlinked pages: /labels/packaging/$batchId (packaging completion), /serialisation/batches/$batchId (serial pools),
/analytics/mspc/batches/$batchId (MSPC drill-down). Link each from where the person is. Meta test: every web route is
reachable by navigation from the home screen or listed as an exception with its reason.
Suspected accessibility defect: getByRole('button') cannot find enabled visible buttons ("Issue set ... to PRESS-01";
"Record the post-use inspection") while locator('button', {hasText}) can: likely an aria-hidden ancestor (leftover
modal layer, badge prompt). Reproduce, fix, add the axe check to these screens.

## R3. The demo must not trip a presenter
Each fix gets a presenter-style browser test (Tap buttons, clicks only, no typed URLs).
1. Batch size in tablets mistyped (10000 for 100000) accepted at issue; dispensing reconciliation later 1000 %. Pre-fill
   from the master (batch size / target tablet weight); refuse or confirm with a reason beyond a tolerance, at issue.
2. After Save, entry forms reopen empty. Show the saved entry and close; "Add another" only where several are expected.
3. "Start using room" then "Record ... in this step" and "Save": make it one action (with the badge tap); same for
   equipment booking.
4. Book pressed twice is refused. Hide or disable Book once booked; show "Booked until ...".
5. Weighing form keeps the previous Quantity/Material; next lot refused G07-WRONG-MATERIAL. Clear after save, or derive
   from the scanned lot and ask only when ambiguous.
6. Lot field needs Enter. Accept on blur and Enter; say "Press Enter to check the lot".
7. Lot with a space not known. Trim and normalise spaces before lookup.
8. Show the remaining quantity per BOM line ("still to weigh: 7.400 kg") on the weighing step.
9. Units not freed at stage end. At stage sign-off list units and rooms still in use and offer to end their use.
10. Cleanings started one by one. On the plant screen, for a batch, list rooms and units its next stages need with
    their cleaning state, and start the needed cleanings from that list.
11. Kiosk silently returns to "Tap your badge". Say why: "<person> signed in on <kiosk>; this session ended."
12. Servers crashed when PostgreSQL restarted (57P01, unhandled error event in pg); site down until manual restart.
    Pools and listeners handle connection errors and reconnect; the demo runner exits non-zero when a child dies so
    systemd restarts it; a test kills the backends and expects recovery.
13. Demo completeness test: every role a screen needs has a seeded persona on the credential card; every kiosk offers a
    Tap button for every kiosk persona; every office persona can sign in at a listed PC. Print the credential card on
    the Operations screen (DEMO-ONLY), including the admin passwords set at each set-up.
14. User guide steps regenerated from the browser tests' evidence (screens and labels) so the guide cannot drift.

## R4. Create a tablet formulation, load it and make batches from it (no template)
- Materials and products on screen (code, name, grade, units, pharmacopoeia, approved-manufacturer link, product and
  strength, shelf life, dosage form); ERP stays the normal source; change control and QA approval as other master data.
- Formula editor: version for a product and strength; ingredient lines (material, role, quantity per unit or batch,
  unit, potency/LOD adjustment flag for TB-01 with its compensating excipient), batch sizes, tablet target weight;
  second-person QA approval; opened from the designer's "Choose a product".
- New master from an approved formula: blank, with the required skeleton, or a copy of an approved master; BOM from
  the formula.
- Designer: add, remove, reorder stages; insert every TB block and G-block with its configuration form; room and
  equipment class per stage; validator and simulation as now.
- Optional: save an approved master as a template.
- Browser test end to end through screens only: materials, an invented product ("Demotab 400 mg, wet granulation,
  film coated, alu-alu"), its formula, its master with TB stages, sandbox run and returned evidence, four signatures,
  market authorisation, ERP order, GMP batch on the kiosks through packing, QC, review and release.
- Demo reset leaves the materials needed to repeat it; the guide gets a "create your own product" part.
- Second check product (owner, 23 October 2026): an invented rabeprazole sodium 20 mg enteric-coated tablet built the
  same way from scratch, with three coating steps in a row (seal coat, enteric coat, top coat), each its own TB-18
  stage with its own core sample, suspension (TB-03) and target weight gain, and the acid and buffer disintegration test
  (TB-15). Browser test through the screens from the formula to the released lot. This proves a multi-layer coated
  product end to end; a single enteric coat is already proven by route W.
- Third check (owner, 23 October 2026): a multi-point dissolution profile as one release requirement, as sustained-
  release products need: several time points (e.g. 1 h, 4 h, 8 h), each with its own limits, defined in the product's
  specification as one test, its results entered (or received from LIMS) per time point, and shown on the release
  checklist as one requirement that passes only when every point is within its limits. Proven with an invented
  sustained-release tablet created through the screens, through its QC results to release, plus the refusal when one
  time point is out of limits.

## R5. Demo data for continuous and parallel production
Several open ERP orders per demo product (processing and packaging), lots for several batches; a "Send a production
order" action on the Operations screen's simulators (replaces /home/batchwright/post-demo-order.mjs); the reset leaves
exactly these orders and lots.

## R7. A beta-lactam product in a dedicated suite (cephalosporin + clavulanic acid, film coated, alu-alu)

Why: Indian customers make cephalosporin + clavulanic-acid tablets (the owner's example: a "CV" combination,
325 mg). Beta-lactams must be made in dedicated, segregated facilities with their own air handling (Schedule M;
US FDA 21 CFR 211.42(d) and 211.46(d)), and clavulanate needs low humidity. Batchwright already has the rules (the
penicillin facility and beta-lactam classification proposed by the steward and approved by a different QA person,
PR-27; hazard classes with dedicated rooms, /india/product-rules; room conditions in TB-18 and G-11), but the demo
shows none of it.

Required:

- Demo plant: a dedicated beta-lactam suite (dispensing, granulation or compaction, compression, coating, alu-alu
  packing rooms, their kiosks and equipment) classified for beta-lactams, with low-RH room-condition limits.
- Demo product (invented, generic-style name, never a brand): a cephalosporin + clavulanic acid film-coated tablet,
  dry granulation or direct compression, potency-adjusted dispensing for both actives (TB-01), film coating (TB-18),
  alu-alu blister (TB-21 COLD_FORM, TB-22) with desiccant; its beta-lactam classification proposed and QA-approved
  on screen.
- Browser tests: (a) the full batch in the suite from order to release, through the screens; (b) the refusals: the
  beta-lactam batch in a non-dedicated room is refused, a non-beta-lactam batch (GB-T-02) in the beta-lactam suite
  is refused, and a room-humidity reading above the limit raises the exception. Control IDs in names.
- Guide: a demo part "Making an antibiotic safely: dedicated rooms and the refusals".

## R8. Complex formulations: a test set of realistic Indian tablet products

Goal (owner, 23 October 2026): prove that a company can load and make its real, complex tablet products with the
existing blocks only (no new blocks), from formula to released lot, through the screens. Alongside R4 and slices
7k to 7p.

Rules for every test product:

- Invented names and formulas only: a generic-style description (e.g. "Multivitamin and multimineral tablets"),
  never a brand, and invented quantities, never a copied registered formula (decision 0006).
- Built on screen: materials, product, formula (QA-approved), the MBR in the designer (stages, branches and blocks
  from the palette, R4), sandbox test run, four signatures, market authorisation, licence endorsement.
- Run on screen: an ERP order, a GMP batch on the kiosks (Tap buttons, no typed URLs), packing, QC results, both
  reviews and release, in a browser test with control IDs in its name and no database arrangement.
- Demo: each product, its equipment and enough lots and orders are in --with-gmp-samples (R1, R5); the guide gets a
  part for it.
- Where a capability below is missing, build it (screen, route, database rule, test) before closing the product.

The test set (priority order):

| # | Test product (invented) | What it proves | Route and blocks |
|---|---|---|---|
| P1 | Multivitamin + multimineral tablet, film coated, strip | Wet + dry granulation + direct addition in one product; overages; three branches merging into one blend | Minerals: TB-03 → TB-04 → TB-05 → TB-02 · Vitamin C and moisture-sensitive B vitamins: TB-06 → TB-02 · Beadlets (A, D, E, B12) and micro-doses (folic acid, biotin) weighed and added directly · Final blend TB-07 with uniformity samples → TB-09/10/11–15 → TB-18 (FC) → TB-21 (STRIP)/TB-22 → TB-24 |
| P2 | Metformin SR 500 mg + glimepiride 2 mg bilayer, film coated, alu-alu | Two routes in two layers; bilayer; SR dissolution profile (7p) plus immediate-release test; low-dose uniformity | Metformin layer: TB-04/05/02 with release polymer · Glimepiride layer: direct blend TB-07 (uniformity) · TB-16 (layer weights) → TB-13–15 → TB-18 → TB-21 (COLD_FORM)/22 |
| P3 | Pantoprazole 40 mg (or rabeprazole 20 mg) delayed-release | Three coating steps in a row, each to its own weight gain; two-stage dissolution (acid then buffer) | Core TB-04/05/02 → TB-07 → compression → TB-18 (FC seal) → TB-18 (FC_F enteric) → TB-18 (FC top) → TB-20 → TB-21 (COLD_FORM)/22 |
| P4 | Levothyroxine 50 mcg | Microgram dose; potency adjustment; geometric dilution in staged blends; content uniformity at release | TB-01 → TB-07 ×3 (dilution, uniformity samples) → TB-11/12 frequent weight checks → TB-21 (THERMOFORM)/22 |
| P5 | Paracetamol 500 mg, high volume | Split granulation in sub-lots combined; rework of approved fines | TB-04/05 ×3 sub-lots → TB-08 rework (QA approval) → TB-07 → compression → TB-21 (STRIP) |
| P6 | Iron (ferrous fumarate) + folic acid, sugar coated, printed | Sugar coating in five phases; tablet printing with QC approval; inspection/AQL | TB-04/05/02 → TB-07 → compression → TB-18 (SC: seal, sub-coat, smoothing, colour, polish) → TB-19 → TB-20 → TB-21 (STRIP)/22 |
| P7 | Fungal diastase + papain + activated charcoal | Enzyme activity units (U/mg) in potency adjustment; overages; dry route only; cleaning after a black, dusty powder; microbial limits | TB-01 (activity units) → TB-06 → TB-02 → TB-07 → compression → TB-18 → TB-21 (STRIP)/22 · plant cleaning verified before the next product |
| P8 | Ondansetron 4 mg orally disintegrating tablet | Soft compression; disintegration in seconds; friability; peel-off blister | TB-01 → TB-07 → compression with low hardness limits (TB-13), TB-14, TB-15 (short limit) → TB-21 (COLD_FORM, peel-off)/22 |
| P9 | Ofloxacin 200 mg + ornidazole 500 mg, film coated | Two actives, salt adjustment, standard wet route | TB-01 → TB-03/04/05/02 → TB-07 → compression → TB-18 → TB-21/22 |
| P10 | Montelukast 10 mg + levocetirizine 5 mg | Salt-to-base adjustment; low dose; light/moisture protection | TB-01 → TB-07 (uniformity) → compression → TB-18 → TB-21 (COLD_FORM)/22 |
| P11 | Metformin SR 500 mg (single active) | Matrix SR; hardness control; dissolution profile (7p) | TB-04/05/02 → TB-07 → compression (TB-13 tight) → TB-21/22 |
| P12 | Ciprofloxacin 500 mg | Non-beta-lactam antibiotic in normal rooms with cleaning; high dose | TB-01 → TB-04/05/02 → TB-07 → compression → TB-18 → TB-21/22 |

(The beta-lactam product, cephalosporin + clavulanate in a dedicated suite, is R7, slice 7n.)

Capabilities to confirm or build:

| # | Capability | Needed by | Status as far as known |
|---|---|---|---|
| C1 | Overages in the formula (deliberate excess per material, with reason; label claim unaffected) | P1, P7 | Not known to exist; build in the R4 formula editor |
| C2 | Potency adjustment in enzyme activity units (U/mg), not only % assay | P7 | TB-01 handles assay and base equivalents; activity units to confirm |
| C3 | Several coating steps in a row, each with its own weight-gain target | P3 | Proven in slice 7o (sandbox) and 7r (GMP batch, released) |
| C4 | Two-stage dissolution (acid stage must not release, buffer stage must) as one release requirement | P3 | Built in 7p (a profile with a stage on each point); P3's GMP lot released on it in 7r |
| C5 | Dissolution profile as one release requirement | P2, P11 | Being built in 7p |
| C6 | Staged acceptance L1/L2/L3 (USP/IP) for SR dissolution | P2, P11 for export | Follow-up after 7p |
| C7 | Content uniformity as a release requirement for low doses | P2, P4, P10 | To confirm in specifications and G-REL |
| C8 | Peel-off blister pack format | P8 | TB-21 has THERMOFORM/COLD_FORM/STRIP; peel-off to confirm |
| C9 | Trilayer tablets (TB-16 with three layers) | Optional | TB-16 is bilayer; if it does not generalise, record as a custom-block item, not part of R8 |
| C10 | Branches merging into one blend (granulates from separate stages plus direct-added materials into one blender, each traced in genealogy) | P1, P2 | MBR format has branches and sub-lots; prove it in P1 |

Definition of done for R8: P1–P8 built and run on screen, each with its browser test green; C1–C5, C7, C8 and C10
built or confirmed with tests; C6 and C9 recorded as follow-ups; P9–P12 at least built and test-run in the sandbox.
Guides updated, the hosted demo updated, and a live rehearsal of P1 and P2.

## Definition of done
Every requirement has a click-by-click browser test (Tap buttons, no typed URLs) with control IDs; full browser suite,
golden batches and pnpm run ci green; docs/guides and hosted-demo.md updated; known-issues regenerated; the hosted demo
updated and a live rehearsal of every R1 route and the R4 flow passes.
