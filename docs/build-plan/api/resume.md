# API edition (substance): resume notes (7 November 2026, 05:30 UTC)

Read with: `plan.md`, `handover-a0.md` (sections "A1a done", "A1b paused", "A2 part 1", "A2 part 2"), CLAUDE.md and
`docs/build-plan/capsules/plan.md` section 8 (rules learnt). Lead: session_01PybpFuUgimTwCNtTsK7cf1. Report each merge
in 2 lines; lead audit before each merge; squash-merge on green.

## State at 7 November 2026, 05:30 UTC (session_01PybpFtk8NDMMd6ZHTNovoe)

This session cannot merge (permission refused): send the lead "#N green" and the lead squash-merges with plain trailers.
Commit trailers carry no model name: `Co-Authored-By: Claude <noreply@anthropic.com>` plus the Claude-Session line.

| # | Branch | What | State |
|---|---|---|---|
| #154 | `ci-pod-playwright` | pod E2E uses the preinstalled chromium | MERGED 6 Nov 21:10 (0da4f74) |
| #143 | `api-a1b-r` | A1b catalogue | cleared; 26 pass, 2 queued; merges FIRST (lead order) |
| #153 | `fix-whole-lot-weighing` | whole-lot guard, now tablets 1903 | cleared; E2E route-s died in the 01:25 pod event |
| #144 | `api-a2-r` | A2 part 1 + main merged + fixes (05c2a2b) | cleared: sorted lists, DI-14/DI-20 list + site.intermediate_lot, O-T13-1 entry, RunHeaderView.postsIntermediateLot (server-computed, false once posted) + "Post the intermediate lot" on RunOverview for STORES |
| #145 | `api-a3-r` | A3 CoA, tablets 1904 (fee31ac) | cleared: telephone history in site.licence_holder_telephone (own aggregate licence_holder_telephone, RECORD class in 1904; insert-only; latest wins; signed licence content keeps the telephone recorded with it), route india.recordLicenceTelephone + field on the licence card, matrix rows for release.coa/prepareCoa/recordLicenceTelephone approved |
| #150 | `kernel-retention-api-r` (base api-a1b-r) | kernel 1405 retention rows | cleared; 2 E2E died in the 01:25 pod event; retarget to main after #143 |
| — | `api-a2b` | A2 part 2 (whole-lot test done, fdd7c93) | open its PR after #144 merges |
| — | `api-genealogy-intermediate` | recipe-core 1876 | open with/after A2 part 2 |

## Blockers right now

- **Pod down since about 01:50 UTC 7 Nov**: no job runs on any PR; at 01:25 three E2E jobs died at once with no logs
  (#153 route-s pod-5, #150 route-s pod-8 and own-demotab pod-3). Lead told; owner to check runners pod-1..8.
- **#156** (lead): moves every job but E2E and golden to GitHub-hosted. When it merges, merge origin/main into each branch
  above (merge commit, no other change; update #150 on its base) and push, then "#N green" in order, #143 first.
- Re-run once the 01:25 E2E failures when their runs finish (unless the main merge restarts them).
- The sudo fix for f55 is in (owner, 18:25 6 Nov).

## To do after the merges

1. DONE (api-a2b fdd7c93): A2 part 2 test uses the whole lot (A 50 kg, B 42.5 kg; consumptions end at 0). Needs #153 in the base to pass.
2. After #143 merges: on #145 add `compliance/controls/AS-17.yaml` (SM XII 11.3.1-11.3.4; Q7 11.40-11.43), add AS-17 to
   `recipe.engine_name` in 5002, tag the CoA tests [AS-17]; the DI-05/DI-30 test in substance-edition.test.ts checks the
   names equal the files. Add the AS test names that A2 part 2 and genealogy listed (AS-03, AS-04, AS-16) to their AS files.
3. A1b E2E on #147 (own Playwright group; drives the generic library-step form only; AS-14 via G-21 label specimen).
4. Then the plan's next slices (A4 recovery/rework, ...), small, one PR each.

## Numbers in use

substance 5000-5003; site-services 1732, 1733; tablets 1903 (#153), 1904 (#145) (lead, 16:00; main already has tablets 1902); recipe-core 1876; kernel 1405. Ask the lead for every
new shared number; substance numbers 5004+ are ours.

## Lead rulings of 6 November (in force, beyond plan.md)

- Intermediate release: the existing lot-machine event RELEASE_FOR_FURTHER_PROCESSING, exposed in the contract (no DB
  change). COA_APPROVED meaning approved. No `report.coa_v1`, no production-release delegation.
- Catalogue: a clause line per field; `critical` only on time limits (Q7 8.20), IPC results (8.30) and yield (8.14); no
  YES_NO, limit slot or CHOICE without a clause; one isolation block per type (API-FILTER, API-CENTRIFUGE).
- AS-14 specimen = G-21 label specimen (EBMR-LBL-060). Retention: IN and EU rows only (no US: Q7 is guidance there).
