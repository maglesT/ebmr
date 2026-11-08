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

- **Lead's #163 question (E2E library-softgel, run 42428248639): not #163.** The trace holds one GET of
  `/api/test-lots`, the page's first read (05.004, 295 ms), and the POST ran inside it (05.201 to 05.288); no read
  followed. TanStack Query 5.104 (`query-core/build/modern/query.js:298`) cancels a read on its way at invalidation only
  when the query has data; on a first read it joins it, so the list kept the answer from before the commit. Fix:
  `useRefresh` (`apps/tablets-web/src/app/acts.tsx`) cancels the reads on their way, then invalidates. Test:
  `apps/tablets-web/test/app/define-form.test.tsx` (`[DI-28] a command that commits while the list is still on its
  first read ...`, fails without the fix). It affects every page whose list is on its first read when a command commits.

## G7 (items 26, 27): done, lead's ruling of 8 November 2026 (option 1)

No migration (recipe-core 1883 released). Genealogy is recorded through the existing guarded G-22 output and G-08 charge
steps of the master. A library CONTAINER field records an identifier only, and says so on the step screen and in the
record (`library.containerFieldLabel`, `block-version.ts` valueText; `renderers/Library.tsx`); documented in
`packages/recipe-core/src/library/README.md`. No new refusal. Tests: `block-version.test.ts` and
`library-renderer.test.tsx` (`[PR-21][DI-33] ... (G7)`); the library E2E fills the field by its new label.

## Session notes

- This session could not cancel GitHub runs or message the lead (the permission classifier refused both). The lead
  needs to cancel the queued `pull_request` run 42407207241 of #175. At handover, all six PRs' manual runs were queued.
- Local DB: see `resume.md` (Local set-up). `NODE_OPTIONS=--max-old-space-size=8192` for eslint on many files.
