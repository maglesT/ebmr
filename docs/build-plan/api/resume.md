# API edition (substance): resume notes (7 November 2026, 16:40 UTC)

Read with: `plan.md`, `handover-a0.md` (sections "A1a done", "A1b paused", "A2 part 1", "A2 part 2"), CLAUDE.md and
`docs/build-plan/capsules/plan.md` section 8 (rules learnt). Lead: session_01PybpFuUgimTwCNtTsK7cf1. Report each merge
in 2 lines; lead audit before each merge; squash-merge on green.

## State at 7 November 2026, 16:40 UTC (session_01PybpFuSsa3ub9XoAUuXKzv)

OPEN, in merge order (all lead-audited unless said):
- **#163** (`e2e-wait-real-signals`, lead's own): dispatch 42377574705, E2E own-p3 ran over an hour; send "#163 green"
  when it passes. After it merges: the stale-comment nit in `tools/e2e/specs/phase7/own-product-flow.ts` (~line 545, "only
  after the lists are read again"; reword: it waits for the emptied form as a check) goes into the next PR.
- **#164** (`api-a2b`, A2 part 2, CLEARED): dispatch 42386401699; send "#164 green".
- **#165** (`api-genealogy-intermediate`, base api-a2b, recipe-core 1879, CLEARED): after #164 merges, retarget it to main
  (MCP `update_pull_request`), dispatch, send "#165 green". Mutation: recipe.genealogy_step 138 of 139 killed + 1
  equivalent (#139, re-keyed from #131 in `tools/sql-mutation/equivalent.json`); the mutation world in
  `packages/site-services/test/mutation/genealogy-and-recall.test.ts` holds an intermediate lot. Last dispatch 42389615163.
- **#166** (`api-as17`, AS-17 + substance 5006, CLEARED): AS-17 cites ICH Q7 11.40-11.43 (official ICH PDF); dispatch
  42387727005; send "#166 green".
- **#167** (`api-a4`, base api-a2b; plan section 11 + A4a tests, AS-19/AS-20, substance 5007): sent for audit; dispatch
  42389996600. Retarget to main after #164. Register count: #166 makes 262, #167 263; the second to merge takes 264.

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

1. Send the "#N green" messages above as runs pass; retarget #165 and #167 after #164; on each merge check the other open
   PRs (conflict recipe below in "How CI runs now").
2. **A4b** (AS-21; plan section 11 rows Q7 14.40 to 14.43, lead-approved, tests only): second crop as a second
   intermediate lot of the same batch (#158); mother liquor carried into the next batch as a held container released by
   QA and added at G-24 RECOVERY (recipe-core 0622); a recovery master whose product is the recovered solvent, its
   output posted as an intermediate lot, tested, released for further processing, weighed at G-07 (fresh + recovered =
   two weighings). New `substance/recovery.test.ts` on `support.ts`; AS-21 file; its engine name needs a substance
   number: 5008 is ours (tell the lead).
3. **A1b E2E** after #155 merges (lead: wait; #155 moves acceptance.ts into library-support.ts): own Playwright group,
   generic library-step form, AS-14 via the G-21 label specimen.
4. The plan's next slices, small, one PR each.

Owner open item (in plan section 11): the Schedule M extract lacks Part XII 11.3 and 14.2.2 to 14.4; ICH Q7 (official
PDF, database.ich.org, Step 4 of 10 November 2000) is the checked source until the owner supplies them. CLAUDE.md allows
only short quoted phrases of regulation text: quote the key phrase, paraphrase the rest.

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

substance 5000, 5003, 5004 (A2), 5005 (A3), 5006 (AS-17, #166), 5007 (AS-19/AS-20, #167); site-services 1732, 1734, 1735;
tablets 1903, 1904; kernel 1405; recipe-core 1879 (genealogy, #165). Substance 5008+ are ours (tell the lead); ask the
lead for every shared number.

## Lead rulings of 6 November (in force, beyond plan.md)

- Intermediate release: the existing lot-machine event RELEASE_FOR_FURTHER_PROCESSING, exposed in the contract (no DB
  change). COA_APPROVED meaning approved. No `report.coa_v1`, no production-release delegation.
- Catalogue: a clause line per field; `critical` only on time limits (Q7 8.20), IPC results (8.30) and yield (8.14); no
  YES_NO, limit slot or CHOICE without a clause; one isolation block per type (API-FILTER, API-CENTRIFUGE).
- AS-14 specimen = G-21 label specimen (EBMR-LBL-060). Retention: IN and EU rows only (no US: Q7 is guidance there).
