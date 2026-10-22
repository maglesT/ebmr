# Slice 7l: the demo routes (requirement R1)

Requirement R1 of `demo-trial-requirements.md`: every tablet block demonstrable on the screens. This slice builds the
demo plant and masters the routes need (`--with-gmp-samples`, i.e. the set-up's packaging option) and one browser test
per route, from the ERP order to the released lot, presenter-style; every block a route could not complete on the screens
is fixed as a product defect, with its test.

## What is built

- **Demo plant** (`apps/tablets-server/src/cli/demo-routes.ts`): rooms GRAN-1, COAT-1, INSP-1 and the blister line PL-2
  with its kiosk KIOSK-PACK-2 (`packages/test-kit/src/personas.ts`); equipment classes and units: rapid-mixer granulator
  RMG-01, fluid-bed dryer FBD-01 (filter bags), co-mill MILL-01 (screens), coater COATER-01, cold-form machine CFORM-01,
  cartoner CTN-03, balances of each room and of PL-2, hardness tester HT-01, friabilator FRB-01, disintegration tester
  DT-01; each defined, qualified, the instruments calibrated and in the device registry; tooling set TS-RTW-01; every
  process unit and room cleaned and verified. The units of GB-T-02 (blender, press, bottle line) stay those of the release
  path.
- **Route W** (`apps/tablets-server/src/cli/demo-route-masters.ts`): Exemplazine gastro-resistant tablets 250 mg
  (EXZ-GR-250, invented): GB-T-01's wet route in one sub-lot with milling (TB-02), the core tests in steps of their own
  (TB-12, TB-13, TB-14), an enteric functional film (TB-18 FC_F) and the acid and buffer disintegration test (TB-15
  gastro-resistant), inspection (TB-20); packed in alu-alu cold-form blisters (TB-21 COLD_FORM, TB-22, TB-24). The
  product, its new materials, three processing and four packaging ERP orders, ample lots (ten batches), the manufacturing
  licence and export permissions, the finished-product specification; both masters approved and authorised for IN, US, EU.
- **Browser test** `tools/e2e/specs/phase7/route-w.spec.ts` (11 serial tests): ERP order, plan and issue, reservations,
  cleaning, dispensing with TB-01, granulation, blending, compression with the IPC steps, enteric coating, inspection, the
  packaging order on PL-2, QC, both record reviews and the release.

## Product defects found and fixed (each with its test)

| # | Found on | Defect | Fix |
|---|---|---|---|
| 7L-1 | TB-01 | The potency calculation had no form: TB-01 could not be done on the screens | `PotencyCalculation` on the TB-01 step (lots scanned; POTENCY_CALCULATION) |
| 7L-2 | TB-01 | A weighing keyed by hand recorded balance MANUAL; TB-01's database gate asks for the balance booked for the batch | the server records the room's one instrument booked for the batch (`intents.ts bookedInstrument`) |
| 7L-3 | alternatives | No screen chose the branch of an alternative (A-IPA, A-RPR) | the step view's `alternative`; "Branch of the process" on the step screen (CHOOSE_ALTERNATIVE) |
| 7L-4 | loops | No screen ended a loop iteration (TB-05 LOD loop, TB-18 coating loop) | the step view's `loop`; "End iteration n" on the step screen (COMPLETE_LOOP_ITERATION) |
| 7L-5 | TB-04, TB-18 | The preparation a binder addition or a coating uses had to be typed as an entry id | the step view's `citable` entries (filtered by solution type); a picker in the entry form |
| 7L-6 | TB-20 | A reject container had to be typed as a database id | a container picker (the batch's containers) in the entry form |
| 7L-7 | TB-13 | An optional list could not be sent empty ("no defect observed") | "None: <list>" sends an empty list |
| 7L-8 | TB-08 none branch | A value configured for automation could not be keyed at a step no equipment feeds | the manual fallback (flagged, second person) |
| 7L-9 | all forms | A form was cleared only after the views were read again, wiping an entry begun meanwhile | the form is cleared when the entry is saved |

Found and worked around in the test, for the floor usability work (slice 7k): a Save pressed right after another entry
was saved sometimes asked for no badge (the test presses it again); a lock layer briefly shows a second, disabled
"Switch user".

## Decisions

- **D-7l-1** (R1 item 2, machine readings of TB-04, TB-05, TB-06 on GMP): the proven manual path. Route W's granulator
  and dryer values are G-06 actuals keyed by hand on the manual fallback (PROCESS_MANUAL_FALLBACK, a second person); no
  GMP gateway with simulated process equipment is built in this slice (least strict option; the sandbox keeps its
  gateway and simulators).
- **D-7l-2**: route specs open screens by their address, as the GB-T-02 kiosk-batch spec does; within each screen every act
  is a click and a Tap button. A home link on every screen is R2's (unlinked pages), not this slice's.
- **D-7l-3**: the route products reuse GB-T-01's materials (and its formula for route W); each route has its own product,
  lots, licence entry, specification and masters, so no route interferes with GB-T-01 or GB-T-02 data or specs.
- **D-7l-4**: DEMO-ONLY short times a presenter waits for on the real clock (massing 30 s, blending 60 s, lubrication 30 s,
  acid stage 1 min), as GB-T-02's demo variant has.
- **D-7l-5**: route W's first batch takes the "no rework" branch; TB-08 (an addition of reserved residue) needs an earlier
  batch of the same product. The route W test keeps a reusable-residue container at inspection, so a second route W
  batch can show TB-08 (not yet in a test).

## Remaining (for the lead)

- Route D (dry, bilayer, printed, strip: TB-06, TB-16, TB-17, TB-19, TB-21 STRIP) and route S (sugar coating, thermoform:
  TB-18 SC) masters, plant (roller compactor, bilayer press, metal detector and de-duster, tablet printer, strip line,
  sugar pan) and their browser tests; TB-16's hopper charges need the charge act on the TB-16 step (today only TB-10's
  set-up step offers it).
- TB-08 on a second route W batch (D-7l-5).
