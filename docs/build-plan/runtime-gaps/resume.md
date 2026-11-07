# Runtime gaps: resume notes (7 November 2026)

Session report: owner's MGL-SR-BL demo report, gaps G1 to G12 (`plan.md`). Lead: session_01PybpFuUgimTwCNtTsK7cf1.
CI runs on GitHub by hand (`gh workflow run ci.yml --ref <branch> -f runner=github`), then cancel the PR's own
`pull_request` run. Commit trailers name no model.

## Done (PRs)

| PR | Gaps | State | Notes |
|---|---|---|---|
| #170 | G1 (items 1, 18) and plan.md | cleared by lead | The signature stays offered when only its own finalisation blocks it (`engine/actions.ts` signRefusal); the refused signing stores the exception and says plainly what to do (`signable.ts` recordedByAttempt). |
| #171 | G2 (item 2) | cleared by lead | Deviation-lite list, page and `quality.deviation` connected with EBMR_DISCONNECT=1; reclassify and cancel stay off and are hidden. Inline "Raise and link to this batch" in the floor link dialog. |
| #172 | G3 (item 4) | cleared by lead | tablets 1905: `recipe.refusal_problem` takes ENG, LIB, Gnn, TBnn; meta test over every emitted code. |
| #174 | G4 (items 14, 15) | cleared by lead | `execution.plannedBatch` read; planned batches on the order card open the issue form; IN-30 (`recipe.india_issue_problem`) runs at planning. recipe-core 1883 unused. |
| #175 | G5, G6, G9 (items 20, 22-25) | cleared by lead | Central 23514/23505/23502 mapping; equipment reference label; spec form hints; CALC display rounding (`decimals`, default 4); tablets 1906 drops the material-name guard (reverses F12 round 10 for that column, flagged). recipe-core 1884 and site-services 1736 unused. |
| #176 | G11, G12 (items 11, 16) | cleared by lead | G11 text: QA may propose and authorise; the regulatory signer is the other person (DB rule 0160/0290, ADR 0014). G12: guide 09 prerequisites table. |

The fresh session watches the manual CI runs of #170 to #176 and sends "#N green" to the lead when each is green (the lead merges or asks you to). #172 and #175 both edit line 1115 of
`docs/handbook/modules.yaml` (migration claims): the second to merge takes both entries.

## Left

- **G7 (items 26, 27)**, smallest fix agreed with the lead: a library CONTAINER field with `action: 'CONSUME'` consumes the
  container the master names through G-08's checks (`packages/recipe-core/src/blocks/generic/material.ts` CHARGE_CONTAINER,
  about lines 323-333: the container is this batch's, holds what the phase uses, is not consumed; return
  `consumeContainers: [id]`), and `REGISTER` registers the phase's product (`registerContainers`, holds
  `view.phase.produces[0]`, INTERMEDIATE). Today the field is free text (`library/block-version.ts`, about 410-431). No new
  registration steps; no new container model. Seeds that ask: `seed/coating.ts:47` (panCoat suspension container),
  `seed/process.ts:758, 815` (PROC-COMPRESS-BILAYER layer blends). Check the DB guards for library entries that register or
  consume containers (recipe-core 0317 `new_container_problem`, tablets 0844) before relying on them.
- **G8 (item 19)**, recipe-core 1885: G-10 v2 (`blocks/generic/status.ts` about 468-513) refuses a second AREA_OCCUPANCY
  (G10-TWICE). Refuse only a second one for the same `areaCode`; PERFORMED needs one per room of the stage's
  `binding.rooms` (at least one when empty). Replace the SQL guard (`sql/0623_g24v2_start.sql` about 296-300, latest of
  0520/0580/0623) per area in 1885. Web: drop AREA_OCCUPANCY from the single kinds (`tablets-web/src/features/floor/repeatable.ts:10`).
  Quote the Schedule M line-clearance clause after checking it (plan.md basis column).
- **Lead rulings of 7 November (evening)**: one batch per ERP order stays a server rule (recipe.erp_order_problem); #175's
  integrity refusals log the raw error at warn; G10 needs no lock-screen code. Recipe-core 1883 stays reserved for this
  work; 1884 and site-services 1736 are released.
- **Draft kept across a lock (lead, with G7 + G8)**: an unsent entry must survive the kiosk lock and be there after the
  same person's badge unlock; drop it only when a different person unlocks. LOCK is in `DISCARDING`
  (`apps/tablets-web/src/features/floor/session.tsx:34`); that is what lost the blend end in item 1. Test it in the floor
  session tests (same person keeps the draft, another person does not).
- **G10 (item 17)**, no code (lead accepted): timers are server-timestamped (library TIMER_START/STOP entries), so the lock does not stop a blend;
  a badge unlock by the same person keeps the route (controller.tsx). Ask the lead whether that closes it, or add the
  running timers to `packages/ui-kit/src/identity/LockOverlay.tsx` (prop from `tablets-web/src/features/access/controller.tsx:504`).
  Side effect to mention: LOCK is in `DISCARDING` (`floor/session.tsx:34`), so an unsent entry is dropped at the lock.

## Local set-up

`sudo pg_ctlcluster 16 main start`; `sudo -u postgres psql -c "create role ebmr_dev superuser login password 'ebmr_dev'"`;
`export EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres`; run vitest from the repository root (the
jsdom project needs the root config). `pnpm register:sync-tests` after a JSON run; remove stale titles by hand.
