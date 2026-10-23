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

## Definition of done
Every requirement has a click-by-click browser test (Tap buttons, no typed URLs) with control IDs; full browser suite,
golden batches and pnpm run ci green; docs/guides and hosted-demo.md updated; known-issues regenerated; the hosted demo
updated and a live rehearsal of every R1 route and the R4 flow passes.
