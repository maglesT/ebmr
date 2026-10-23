# Slice 7m: demo routes D and S (requirement R1, continued)

Slice 7l showed route W end to end (`slice-7l-routes.md`). This slice does the same for the two remaining routes, so
every tablet block and every coating and pack type is demonstrable on the screens: the plant and invented masters in the
demo set-up's `--with-gmp-samples` (`apps/tablets-server/src/cli/demo-routes.ts`, masters in
`demo-route-masters-ds.ts`) and one presenter-style browser test per route, from the ERP order to the released lot.

## What is built

- **Route D** (dry route, bilayer, printed, strip): Exemplazine bilayer printed tablets 250 mg (EXZ-BL-250, invented).
  GB-T-01's dispensing (TB-01, G-07) without the solvent and the film coat; the active layer's solids roller-compacted
  with the integrated mill (TB-06) and sized through a checked screen (TB-02); the active layer blended and lubricated
  and the lactose layer blended (TB-07, two steps; containers of stages BLEND_L1 and BLEND_L2); the bilayer press set up
  (TB-09, TB-10) and run (TB-16: each layer's hopper charged on the run step, layer-only and full-tablet checks) beside
  the metal detector and de-duster (TB-17, a parallel branch); ink printing (TB-19) behind QA's gate H-PRINT; packed in
  aluminium strips on line PL-3 (TB-21 STRIP, TB-22, TB-24). Plant: rooms RC-1, COMP-2, PRINT-1 and line PL-3, each with
  its kiosk (KIOSK-RC-1, KIOSK-COMP-2, KIOSK-PRINT-1, KIOSK-PACK-3); roller compactor RC-01, mill MILL-02, bilayer press
  BLPRESS-01, hardness tester HT-02, de-duster DD-01, metal detector MD-01 with three certified test pieces, printer
  PRINTER-01, strip machine STRIP-01, cartoner CTN-04, leak tester LT-01, a balance per room, tooling set TS-RTD-01.
- **Route S** (sugar coating, thermoform): Exemplazine sugar-coated tablets 250 mg (EXZ-SC-250, invented). Route W's wet
  route and compression (without its in-process test steps) for the cores; TB-03 sugar syrup; TB-18 SC in its loop, one
  application an iteration (seal, sub-coat, smoothing, colour, polish) to a 40 to 60 % weight gain; TB-20 inspection;
  packed in PVC/aluminium thermoform blisters on PL-2 (TB-21 THERMOFORM with the forming temperature, TB-22, TB-24) on the
  new thermoform machine BLISTER-02. Tooling set TS-RTS-01.
- Each route: its product, new materials, three processing and four packaging ERP orders, ample lots (ten batches), the
  licence entry and export permissions, the finished-product specification; both masters approved and authorised for
  IN, US and EU.
- **Browser tests** `tools/e2e/specs/phase7/route-d.spec.ts` and `route-s.spec.ts`, serial, presenter-style (Tap
  buttons, clicks; no database arrangement), control IDs in the test names. The helpers the route specs share moved to
  `route-support.ts` (weighing, hold points, typed containers).

## Product defects found and fixed (each with its test)

| # | Found on | Defect | Fix |
|---|---|---|---|
| 7M-1 | TB-16 | A layer's hopper could not be charged on the bilayer step: only TB-10's set-up step offered the charge | the step plant view lists the step's layers (`layers`, `chargedStages`); a charge panel per layer offers only that layer's blend and fills HOPPER_CHARGE with layer, hopper, blend and charge (`step-plant-acts.test.tsx`) |
| 7M-2 | TB-17 | The CHALLENGE entry needed the challenge's id typed from the panel's message | the recorded challenge opens the CHALLENGE entry with its id, device, timing and result (`step-floor-acts.test.tsx`); the floor acts sit inside the step's choices |
| P7L-1 | 7l review | A manual weighing's balance inferred from the room's one booked instrument was not marked | `evidence.manual.balanceInferred` (recipe-core 1650 refuses it beside a declared balance); the entry summary says the balance was not named (`tb-01-gmp.test.ts`, `execution-row-shape.test.ts`) |

## Decisions

- **D-7m-1** (route D bilayer feed): the first-off at TB-10 charges one container of the active layer's blend; the run's
  hopper charges (TB-16) take a second container of it and the lactose layer's container, since a container is charged
  once (least strict reading of TB-10's "a charge before the first-off").
- **D-7m-2** (route D detection): TB-17 runs in a parallel branch beside TB-16 so the start challenge precedes the run's
  end; the branch binds no unit (a unit is used by one branch at a time, DATA-PARALLEL) and the challenge names the press.
- **D-7m-3** (route D strip): a plain aluminium strip foil issued by weight (the ERP order's BOM line) and printed cartons
  through G-21; TB-21 STRIP takes the strip foil only.
- **D-7m-4** (route S cores): route W's wet route and compression without the IPC test steps (TB-12 to TB-15 are route
  W's to show); the sugar coat's validated weight gain 40 to 60 %, loop of at most six iterations.
- Machine readings: D-7l-1 (keyed by hand on the manual fallback) for TB-06, TB-18 and TB-21.
