# API edition (substance): resume notes (7 November 2026, 15:20 UTC)

Read with: `plan.md`, `handover-a0.md` (sections "A1a done", "A1b paused", "A2 part 1", "A2 part 2"), CLAUDE.md and
`docs/build-plan/capsules/plan.md` section 8 (rules learnt). Lead: session_01PybpFuUgimTwCNtTsK7cf1. Report each merge
in 2 lines; lead audit before each merge; squash-merge on green.

## State at 7 November 2026, 15:20 UTC (handover from session_01PybpFtk8NDMMd6ZHTNovoe)

MERGED this round (squash, by the lead): #154 (pod E2E chromium), #143 (A1b catalogue), #153 (whole-lot guard, tablets
1903), #144 (A2 part 1: intermediate lot, substance 5004, `RunHeaderView.postsIntermediateLot` + "Post the intermediate
lot" on RunOverview), #158 (site-services 1734: several intermediate lots per batch, codes `<batch>`, `-2`, `-3`, next
free, never reused), #150 (kernel 1405 retention RET-2026.2), #145 (A3 CoA, substance 5005, tablets 1904; licence holder
telephone history site-services 1735 in its own aggregate `licence_holder_telephone`, route `india.recordLicenceTelephone`).

OPEN: **#163** (`e2e-wait-real-signals`, lead CLEARED): route-w 10 waits for `finished-lot-posted` before navigating;
`useCommand.run` gets optional `onCommitted` (called on an OK answer before the reread) and `DefineForm` empties its
fields there; registerTestLots waits for the emptied Lot code box; web test [DI-28] in
`apps/tablets-web/test/app/define-form.test.tsx`. Send the lead "#163 green" when dispatch run 42377574705 passes.

## How CI runs now (pod is dead; owner: go on without it)

- Pushes start a `pull_request` run whose E2E goes to the dead pod. After every push: dispatch
  `gh workflow run ci.yml --ref <branch> -f runner=github`, then cancel that push's pull_request run
  (`gh api -X POST repos/maglesT/ebmr/actions/runs/<id>/cancel`) and any superseded dispatch run.
- This session cannot merge (permission refused) or PATCH a PR from the shell: send the lead "#N green"; retarget a PR's
  base with the GitHub MCP tool `update_pull_request`. Commit trailers carry no model name:
  `Co-Authored-By: Claude <noreply@anthropic.com>` and the Claude-Session line.
- After each squash-merge, check the other open PRs' mergeability; on a conflict merge main in (merge commit, never
  rebase), list-only resolutions: union the control test lists, then drop the names `register:validate` reports as not
  existing (renamed on main), `register:sort-tests`; a file identical on main to the stacked base's head takes ours.

## Next (in order)

1. **#163** green → lead merges. Then the stale-comment nit the lead found goes into the NEXT PR (not #163):
   `tools/e2e/specs/phase7/own-product-flow.ts` ~line 545 says DefineForm empties "only after the lists are read again",
   no longer true after #163; reword (it waits for the emptied form as a belt-and-braces check).
2. **A2 part 2** (`api-a2b`): branch is stacked on the OLD api-a2-r; merge origin/main in (A2 part 1 is now squashed on
   main; expect conflicts in intermediate-lots.test.ts, IN-05/PR-45 lists, README rows), keep its own delta only, then
   open the PR. Its whole-lot test (A 50 kg, B 42.5 kg) needs #153 (merged). Note #158: several lots per batch, codes
   `<batch>-N`; `site.intermediate_lot_of` returns the LATEST lot, `site.intermediate_lots_of` all.
3. **Genealogy** (`api-genealogy-intermediate`, stacked on api-a2b): recipe-core migration currently 1876; main has 1875
   and #160/#161 take 1877/1878: the lead assigned **recipe-core 1879** (15:14); renumber 1876 → 1879, merge, PR.
4. **AS-17 / AS test lists**: add `compliance/controls/AS-17.yaml` (SM XII 11.3.1-11.3.4; Q7 11.40-11.43) and AS-17 to
   `recipe.engine_name` (substance 5003 holds the engine names, kept equal to the AS files; check the DI-05/DI-30 test in
   substance-edition.test.ts), tag the CoA tests [AS-17]; add the AS test names A2 part 2 and genealogy carry (AS-03,
   AS-04, AS-16) to their AS files.
5. A1b E2E on #147 (own Playwright group; generic library-step form; AS-14 via G-21 label specimen), then A4
   (recovery/rework) and the plan's next slices, small, one PR each.

## Rules learnt this round (owner and lead)

- Owner (7 Nov): as much flexibility as possible within compliance: add no refusal (validator rule, SQL check, unique
  index, error code) without a quoted binding clause or a real engine or record-integrity need, and say which in a
  comment. Lead audits check it.
- A table added to an existing audited aggregate changes the true copy of every existing record (empty tables are listed);
  give new tables their own aggregate type unless they must be in the record. Never add a column to an insert-only
  audited table (the stored row hash covers the whole row).
- Screens show only what works (server-computed flags, not a button the DB refuses). Every person's DB act needs a route
  and screen (decision 0025; exemption lists stay empty); new routes need O-T13-1 listing, a contract example and a
  route-role-matrix row (lead reviews the row).
- Every function a migration since Phase 6 defines is in a sql-mutation group, and each group is in mutation.yml.
- Migration numbers: renumber when main overtakes; within substance 5004+ is ours, shared packages ask the lead.

## Numbers in use

substance 5000, 5003 (main), 5004 (A2), 5005 (A3); site-services 1732 (A2), 1734 (#158), 1735 (A3 telephone); tablets
1903 (#153), 1904 (#145); kernel 1405 (#150); recipe-core 1879 (genealogy, assigned 7 Nov; branch still says 1876). Substance
5006+ are ours; ask the lead for every shared number.

## Lead rulings of 6 November (in force, beyond plan.md)

- Intermediate release: the existing lot-machine event RELEASE_FOR_FURTHER_PROCESSING, exposed in the contract (no DB
  change). COA_APPROVED meaning approved. No `report.coa_v1`, no production-release delegation.
- Catalogue: a clause line per field; `critical` only on time limits (Q7 8.20), IPC results (8.30) and yield (8.14); no
  YES_NO, limit slot or CHOICE without a clause; one isolation block per type (API-FILTER, API-CENTRIFUGE).
- AS-14 specimen = G-21 label specimen (EBMR-LBL-060). Retention: IN and EU rows only (no US: Q7 is guidance there).
