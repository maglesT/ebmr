# Runtime gaps: resume notes (8 November 2026, handover)

Session report: owner's MGL-SR-BL demo report, gaps G1 to G12 (`plan.md`). Lead: session_01PybpFuUgimTwCNtTsK7cf1.
Handover from session_01PybpFtHYDSJ117SYh9j8ay (context limit). CI: dispatch `ci.yml` with `runner=github` (and
`e2e_groups` for a focused run), then cancel the PR's own `pull_request` run and, after a merge, main's `push` run.
Commit trailers: `Co-Authored-By: Claude <noreply@anthropic.com>` and the Claude-Session line, no model name.

## Merged

| PR | Gaps | Notes |
|---|---|---|
| #170 | G1 (items 1, 18) | merged before this session |
| #171 | G2 (item 2) | owner's batch-only ruling (below) |
| #174 | G4 (items 14, 15) | planned batches issued from any session; IN-30 at planning |
| #175 | G5, G6, G9 (items 20, 22-25) | tablets 1906 |
| #176 | G11, G12 (items 11, 16) | docs |
| #185, #186 | flakes | equipment.test.ts IN-25 timing tests: 6 s and 4 s margins |

## Merged after the handover (8 November, by the demo-gaps session)

| PR | Gaps | Notes |
|---|---|---|
| #172 | G3 | 3c4b72b, focused run library-caps and own-p3 green |
| #183 | G7, G8, draft | 7b31deb, focused run library-caps and library-softgel green |
| #184 | PDF button | 4b8142d; the permission checked first, the matrix and READ_REFUSED record it, the E2E saves as QA; the authorised person's true-copy read is an owner option |

## Open at the run-time handover (now merged, kept for the record)

| PR | Branch | State at handover (8 November, 14:50) |
|---|---|---|
| #172 | runtime-gaps/g3-lib-refusal | G3, tablets 1905. Head cbc8ad82 (main merged, modules.yaml has 1905 and 1906). Earlier full run: only the equipment flake and a library-caps radio timeout (judged flaky). Focused dispatch 42486376954 (`library-caps,own-p3`) running: merge when green. |
| #183 | runtime-gaps/g7-g8-draft | G7 (option 1), G8 (recipe-core 1885), draft kept across a lock, useRefresh; audited. Full run 42474455810 green but for the equipment flake; then conflicted with #175 in `library/block-version.ts` and `index.ts` (both helpers kept, 769d9e01, library tests 359/359 local). Focused dispatch 42489123136 (`library-caps,library-softgel`) running: merge when green. |
| #184 | batch-record-pdf | "Batch record (PDF)" button. **Needs a decision (not a small fix).** The release-flow E2E signs in as `qcuAuthoriser` (AUTHORISED_PERSON): archive.pdf refuses it with EBMR-IAM-040, "lacks permission RECORD.TRUE_COPY_REGISTER" (reproduced locally; QA_REVIEWER/qaInvestigator is served). The route-role matrix marks that cell allowed ("A"), so `readOffered` shows the button and the server refuses it. Choose: grant the authorised person the true-copy read (21 CFR 211.180(c): records available for review; the AP reviews the batch record before release), or record the refusal in the matrix fixture / BUTTON_READS so the button is hidden from that role and the E2E step uses the QA persona. The other fixes on the branch (EMBEDDED list, the step reads the route's answer) are in; shards, static and golden passed in the earlier full run. |

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
