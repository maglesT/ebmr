# Runtime gaps G7, G8 and the draft kept across a lock: resume notes (7 November 2026)

Branch `runtime-gaps/g7-g8-draft`, from `main`. The other gaps and the PR table are in `resume.md` and `plan.md` on the
open runtime-gaps PR branches (#170 to #176).

## Done on this branch

- **Draft kept across a lock** (G10 side effect, item 1). `useSessionChange(cb, { keepOnLock: true })`
  (`apps/tablets-web/src/features/floor/session.tsx`) skips a LOCK naming the person signed in. The step entry forms
  use it (`renderers/parts.tsx` ManualFieldEntry and the library section form, `renderers/block-entry.tsx`). An unlock
  naming another person, a SWITCH, ENDED or a change of the boot person still drop the draft. The pending-call machine
  (`usePendingCall.ts`) and the dialogs still react to LOCK as before: an entry already sent keeps its "may be in the
  record" handling, and dialogs (signatures included) still empty at a lock. Tests: `apps/tablets-web/test/floor/
  step-screen.test.tsx` (`[INV-40] an unsent draft survives a lock ...`, `[INV-40] an unsent draft is dropped when the
  session is switched ...`).
- **G8 (item 19)**, recipe-core 1885. G-10@2 (`packages/recipe-core/src/blocks/generic/status.ts`) refuses only a second
  AREA_OCCUPANCY for the same area (G10-TWICE). PERFORMED needs one for each room of the stage's `binding.rooms`, and at
  least one when the stage binds none or the phase is in no stage (G10-INCOMPLETE). The simulator records one per room.
  `recipe.entry_block_problem` is replaced from 0623 with the per-area rule (`sql/1885_g10_clearance_per_room.sql`). The
  web no longer counts AREA_OCCUPANCY as a single kind (`floor/repeatable.ts`); StepPlantActs already lists every room
  of the stage. Basis: revised Schedule M (GSR 922(E)) Part I 18.4.1 and 18.5.2, checked against the gazette text.
  Tests: `packages/recipe-core/test/blocks/status-v2-edges.test.ts`, `packages/recipe-core/test/mutation/
  entry-references-and-schema.test.ts` (`recipe-core 1885 ...`, which fails without 1885).

## Not done: G7 (items 26, 27), waiting for the lead's ruling

The agreed route (a library CONTAINER `CONSUME` field goes through G-08's checks and consumes; `REGISTER` registers the
phase's product) is refused by the database as it stands:
- `recipe.new_container_problem` (recipe-core 0317; the latest is tablets 0844) accepts a new container only from a
  G-07/TB-01 CONTAINER_WEIGHING or a G-22 OUTPUT_CONTAINER entry, one per row;
- `recipe.entry_reference_problem` (0328) lets a row mark a container consumed only when a CHARGE_CONTAINER entry of the
  row names it.
Option 1 (recommended, no migration): add a REGISTER "Suspension container" field to COAT-SUSPENSION-PREP (new library
version), and follow each TB-07 layer blend with a G-22 output step in the masters that run PROC-COMPRESS-BILAYER and the
multilayer press, so the containers exist in the record with genealogy before the press asks for them. Option 2: a
recipe-core migration replacing both functions for library CONTAINER fields, plus a tablets migration after it that
keeps 0844's TB-01 rule (two numbers from the lead). It would change about 90 library CONTAINER fields across every
edition, and some sections have two REGISTER fields while the database allows one container per row.

## Session notes

- This session could not cancel GitHub runs or message the lead (the permission classifier refused both). The lead
  needs to cancel the queued `pull_request` run 42407207241 of #175. At handover, all six PRs' manual runs were queued.
- Local DB: see `resume.md` (Local set-up). `NODE_OPTIONS=--max-old-space-size=8192` for eslint on many files.
