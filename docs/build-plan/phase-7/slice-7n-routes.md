# Slice 7n: a beta-lactam product in a dedicated suite (requirement R7)

Requirement R7 of `demo-trial-requirements.md`: a cephalosporin + clavulanic-acid type tablet made in a dedicated
beta-lactam suite, with the refusals shown on screen. Branch `phase-7/slice-7n`; migration recipe-core 1600.

## What is built

- **Database rule** (`packages/recipe-core/sql/1600_beta_lactam_rooms.sql`, PR-27): a room or line may be dedicated to
  `BETA_LACTAM` (plant.area_dedication, recorded by QA and approved by a second QA person as the hazard dedications are).
  At the clearance of a room or line and at the start of its use, a beta-lactam batch is refused a room not dedicated to
  beta-lactam products (EBMR-PLANT-177) and any other batch is refused a dedicated one (EBMR-PLANT-178), whoever writes
  the row. Server test `packages/recipe-core/test/plant-rules/beta-lactam-rooms.test.ts`.
- **Screens**: the India product rules screen lists and records `BETA_LACTAM` dedications (contract `DedicationClass`).
- **Demo suite and product** (`apps/tablets-server/src/cli/demo-route-beta-lactam.ts`, `demo-route-masters-b.ts`, one
  line in `cli/installation.ts` after the demo routes): SITE-1 a penicillin facility (steward, QA), rooms BL-DISP,
  BL-BLEND, BL-COMP, BL-COAT and the line BL-PL, dedicated; their units qualified and calibrated; kiosks KIOSK-BL-*
  (`packages/test-kit/src/personas.ts`); product CXC-325 (invented) with its materials, ample lots, three processing and
  four packaging ERP orders, licence and export permissions, the finished-product specification; both masters approved
  and authorised for IN, US, EU. References in `features/designer/reference-catalogue-bl.ts`.
- **Browser tests**: `tools/e2e/specs/phase7/route-b.spec.ts` (10 serial tests: the classification proposed and
  approved on screen, ERP order to released lot in the suite) and `route-b-refusals.spec.ts` (the two room refusals and
  the humidity excursion).
- **Guide**: `docs/guides/user-guide/10-antibiotic-dedicated-suite.md`; `docs/operations/hosted-demo.md` lists the suite.

## Decisions

- D-7n-1: the suite and product are seeded by a module of their own in `src/cli` (it needs the in-process demo server
  for the masters, as the demo routes do), called by one line of the set-up after the demo routes, not from the feature
  seed `seed-gmp.ts` (features do not import the CLI).
- D-7n-2: the room rule reuses the area dedications of IN-27 (0890, 0912) with a fourth class `BETA_LACTAM` rather than a
  new register: the same QA recording, second-person approval, screen and audit. A dedication counts once approved; a
  withdrawal counts at once (0912 `plant.area_dedicated`, unchanged).
- D-7n-3: the rule checks rooms and lines (clearance and occupancy) and, since review P7N-1, each unit's use by the
  room or line the unit stands in (a unit's use needs no room occupancy). The site-wide penicillin rule (0973, 1210) is
  unchanged and still asked first at the room start.
- D-7n-4: the ERP product master flags CXC-325 beta-lactam (truthful data, confirmed by QA as every new master); the
  plant's own classification of the product and its two actives is not seeded and is proposed and approved on screen in
  the browser test, as R7 asks.
- D-7n-5: the suite's dedications and SITE-1's penicillin facility rule are seeded through the real commands and
  signatures (steward or QA MBR approver records, another QA person approves): they describe the plant, not the product.
- D-7n-6: TB-21 has no desiccant member; "alu-alu with desiccant" is a cold-form forming laminate with a desiccant layer
  (`MAT-ALU-CFD`), its own material, specification, lot and reservation, named in the TB-21 line set-up.
- D-7n-7: direct compression (no granulation); the cephalosporin is compensated with microcrystalline cellulose PH 102
  and the inhibitor with spray-dried mannitol, materials no other TB-01 step compensates with, so the route's lots are
  first-expiring for its TB-01 steps without changing other routes' stock rotation (PR-18).
- D-7n-8: the suite's low-humidity limit is 30 % RH, held in the master: G-11 in the dispensing room (an excursion blocks
  the steps after it until a deviation) and the TB-18 cores step's room limits in the coating room.
- D-7n-10 (least strict): a unit with no room or line recorded is not checked at its use (the plant list need not place
  portable or bench units); its batch is still checked at its room's clearance and occupancy.
- D-7n-9: the long batch test reuses the shared kiosk helpers of the route specs (which open screens by address, as
  route W does); the refusals spec likewise until the home link of slice 7k is on main.
