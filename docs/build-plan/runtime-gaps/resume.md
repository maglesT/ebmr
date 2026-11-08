# Runtime gaps: resume notes (8 November 2026, handover)

Session report: owner's MGL-SR-BL demo report, gaps G1 to G12 (`plan.md`). Lead: session_01PybpFuUgimTwCNtTsK7cf1.
Handover from session_01PybpFtHYDSJ117SYh9j8ay (context limit). CI: dispatch `ci.yml` with `runner=github` (and
`e2e_groups` for a focused run), then cancel the PR's own `pull_request` run and, after a merge, main's `push` run.
Commit trailers: `Co-Authored-By: Claude <noreply@anthropic.com>` and the Claude-Session line, no model name.

## Merged

| PR | Gaps | Notes |
|---|---|---|
| #170 | G1 (items 1, 18) | merged before this session |
| #174 | G4 (items 14, 15) | planned batches issued from any session; IN-30 at planning |
| #175 | G5, G6, G9 (items 20, 22-25) | tablets 1906; tests read the rounded CALC text and the "Reference (required…)" label |
| #176 | G11, G12 (items 11, 16) | docs |
| #185 | flake | equipment.test.ts IN-25 crossed-calibration test: 6 s margin |

## Open (all cleared or audited by the lead; merge when green)

| PR | Branch | What | CI state at handover |
|---|---|---|---|
| #171 | runtime-gaps/g2-deviation-link | G2, reworked to the owner's ruling (below) | main merged; fixed PR-49 list and the guides screen list; focused dispatch `e2e_groups=rest` |
| #172 | runtime-gaps/g3-lib-refusal | G3, tablets 1905; ENG-* headline edit reverted (the GMP catalogue already says "in the batch") | main merged (modules.yaml has 1905 and 1906); focused dispatch `library-caps,own-p3` (library-caps timed out once on the ERP send-order radio, judged flaky) |
| #183 | runtime-gaps/g7-g8-draft | G7 (option 1), G8 (recipe-core 1885), draft kept across a lock, useRefresh | audited; full run 42474455810: only the equipment flake so far, last E2E groups were running |
| #184 | batch-record-pdf | "Batch record (PDF)" button | main merged; EMBEDDED list names the archive button; the release-flow step checks the archive.pdf answer (the browser download event never came within 30 s); focused dispatch `e2e_groups=rest` |
| #186 | fix/equipment-clean-hold-margin | flake | clean-hold test hold 4 s; dispatch `e2e_groups=p3-demo` running |

## Rulings in force

- **G2 (owner)**: deviations exist only for batch records. `/quality/deviations` stays off; the record opens only at
  `/review/<batch>/deviations/<id>` and only when it is in that batch's list (`quality/BatchDeviation.tsx`); the review
  page lists the batch's deviations; release checklist, record lock and after-release link there. `quality.deviations`
  without `batchId` answers 410 DISCONNECTED with EBMR_DISCONNECT=1 or on the platform build. No CAPA, no
  reclassify or cancel (hidden).
- **G7 (lead, option 1)**: no migration; recipe-core 1883 released. Genealogy through the master's G-22 output and G-08
  charge steps. A library CONTAINER field reads as an identifier only (`library.containerFieldLabel`, step screen and
  record sentence; documented in `packages/recipe-core/src/library/README.md`). The block schema description is
  unchanged on purpose (pinned).
- **G8 (lead)**: one clearance per room of the stage (Schedule M Part I 18.4.1), recipe-core 1885.
- **PDF button (owner)**: on review and release pages only, shown by `readOffered` (`BUTTON_READS` in
  `app/tile-access.ts`, checked against the route-role matrix); `/archive` stays off. Basis checked against the official
  texts: 21 CFR 211.188, 211.180(c); EU GMP Annex 11 sections 8.1 and 8.2.

## Known flakes (a run failing only on these counts as green, lead)

- `packages/recipe-core/test/plant/equipment.test.ts` IN-25 timing tests (crossed calibration: fixed by #185; clean-hold:
  #186).
- `apps/tablets-server/test/designer/from-formula.test.ts` signing limit and `release-gate.test.ts:575` timeout on
  branches older than #161 / #179.

## Local set-up

`sudo pg_ctlcluster 16 main start` (restart it after a container restart; "Removed stale pid file" is normal);
`export EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres`; run vitest from the repository root.
`pnpm guides:lists` needs the database. Log triage: `get_workflow_run_logs_url` or `get_job_logs` URL, `curl`, then grep
` FAIL .* > ` and `✘`.
