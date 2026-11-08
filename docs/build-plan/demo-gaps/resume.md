# Demo gaps: resume notes (8 November 2026, handover)

The lead session (session_01PybpFuUgimTwCNtTsK7cf1) coordinates. A fresh session starts from this file, `plan.md`
and `d0/README.md`, and reports to the lead with the Claude Code Remote `send_message` tool.

## How the work runs (the owner's and the lead's rules)

- Minimum compliance: only binding clauses, cited and checked against the official text. No over-engineering. A
  clean, simple digital-form UI that shows only what works.
- Every fix works in all editions (tablets, capsules, injectables, API), with no edition-specific copies, and is
  tested against another edition's master.
- Write a short plan section in docs first. Use small PRs. Tests carry the control IDs they prove. CI must be green.
  The lead audits, then the PR is squash-merged.
- Before a PR, run the fast checks on what changed: `pnpm -s typecheck`, eslint on the changed files,
  `pnpm -s deps:check`, `pnpm -s register:validate`, `pnpm -s handbook:check`, and the related suites. Then send the
  lead "#N ready for audit" with a two-line summary.
- CI: the RunPod pod is down. After each push, run `gh workflow run ci.yml --ref <branch> -f runner=github`, and
  cancel the run the PR itself starts (event `pull_request`).
- Commit trailers name no model: `Co-Authored-By: Claude <noreply@anthropic.com>` and the session's `Claude-Session`
  line.
- Shared migration numbers: ask the lead before taking one. recipe-core 1876 is reserved for the API genealogy
  edge. D-2 used 1877 and D-3 used 1878.

## State

| Item | PR | State |
|---|---|---|
| D-0 restriction sweep | #157 | merged |
| D-1 new stage passes the validator | #159 | merged |
| D-2 formula lines, formula draft withdrawal (recipe-core 1877) | #160 | merged |
| D-3 discard a draft, restart the family (recipe-core 1878) | #161 | merged |
| R-flow (`r-flow.md`) | #162 | merged (8a159db) |
| R-rest Part A, the validator rows (`r-rest.md`) | #180 | merged (af7cfff) |
| D-4 demo catalogue approved, badge names the replacement (`d4-catalogue.md`) | #181 | merged (83f0cbf) |
| D-8 own calculations, names, yield, limit sources (`d8-calcs.md`) | #182 | merged (4d74809) |
| R-rest Part B (SQL rows; recipe-core 1880) | not started | plan in `r-rest.md` |
| D-5 copied names, intermediate names (`d5-copied-names.md`) | #187 | E2E own-p3, gmp-batches, own-demotab, rest green (on fabebd0, before main merged in); local `pnpm run ci`, golden, trace were running at handover (logs in the old session's scratchpad): re-run them on the head, post the counts, merge |
| D-6 library equipment class from the plant's classes (`d6-plant-classes.md`) | #188 | lead's option A; the 7 library groups green in one run (42492831639); local `pnpm run ci`, golden, trace still to run |
| D-7 findings panel at 1400 px (`d7-findings-panel.md`) | #189 | reproduced (fails without the CSS); E2E rest on the fix commit was running (42497427114); main merged in after (52d0790, list-only); local `pnpm run ci`, golden, trace still to run |

## The lead's rulings in force (7 and 8 November 2026)

- A1 FLOW-CONSTRUCTS: a parallel with one branch stays refused, for an engine need (GRAPH-MATCHED: the AND split and
  join need two edges each).
- A3 DATA-PARALLEL: option (b), kept. Since D-2, the portions of one material are two BOM lines.
- A5 line-clearance second person, by edition:
  - The tablets edition (tablets and capsules) keeps it on a packaging clearance. The basis is Revised Schedule M
    Part VIII 7.1, "There shall be an independent recorded check of the equipment before a new batch of tablets or
    capsules is handled", checked in the notified G.S.R. 922(E) text.
  - Injectables and API follow 211.130(e) and EU GMP 5.50: one person, unless the step is marked significant.
- A10 GMP-REPROCESSING: maxPercent stays required, because G-24 and recipe-core 0622 judge the addition against it.
- A11 GMP-RISK: an MBR-level criticality assessment (`header.criticalityAssessment`) covers the non-critical items.
- D-4: demo:setup approves the seed catalogue through the real signed act. Each approval carries the reason "Demo
  set-up: seed catalogue approved by the demo QA persona (demo:setup)". It runs on demo databases only.
- D-5: pairing by role only, 1:1 in formula order, no rename for an unpaired line; the copy's first revision note
  names the renames for the author to check.
- D-6: option A. A WARNING (GMP-EQUIPMENT-CLASS-PLANT), not an error; a saved non-plant class is shown marked; free
  text only when the class list cannot be read; the E2E flows define plant classes before the master (order only).
  Residual: the stage-binding picker still lists the document-management EQUIPMENT_CLASS records.
- #184 (PDF button): nobody's rights widened; archive.pdf checks RECORD.TRUE_COPY_REGISTER first, the matrix and
  READ_REFUSED record it; granting the authorised person the true-copy read is an owner option.
- D-8 conditions:
  1. The five ops work on DRAFT only; tested refused on an approved master.
  2. The limit source is a recorded reference, not a gate (21 CFR 211.160(b)). The model already needs a source on
     every range, so an empty source cannot occur.
  3. A broken formula is caught by the existing DATA check, with no new refusal.
  4. The plan ships in the PR.
- Re-set rules for Part B (FRM-051 target, FRM-018 pin): insert-only, the latest row stands. Part B takes recipe-core 1880.

## How CI runs now (8 November 2026)

- GitHub-hosted runners: the repo is public, so Actions are free, and the RunPod pod is down. Dispatch with
  `gh workflow run ci.yml --ref <branch> -f runner=github -f e2e_groups=<the groups the change touches>`, then cancel
  the push's own pull_request run.
- A dispatch with `e2e_groups` skips the static checks, the test shards, the golden batches and the trace. So run
  those locally on the PR head: `pnpm run ci`, then the golden batches and the trace (below). Post the counts in the PR
  and send the lead "#N green".
- A test that times out only on GitHub's runners (release-gate.test.ts:575, fixed by #179) counts as green when it is
  the only failure.

## Next for the new session

1. #187 (D-5), #188 (D-6), #189 (D-7): run `pnpm run ci`, the golden batches and the trace locally on each head (the
   lead's split), post the counts, and squash-merge each when green. Merge main in first where it moved (list-only
   resolutions in `compliance/controls/*.yaml`, then `pnpm register:sort-tests`).
2. R-rest Part B (recipe-core 1880; ask the lead for a second number).
3. The run-time gaps are done but for the notes in `docs/build-plan/runtime-gaps/resume.md` (G1 to G9, G11, G12 merged;
   #172, #183, #184 merged on 8 November).

## Learned on the way

- The approver persona has a signing limit (DI-19, 429 RATE_LIMITED). A test file that approves many formulas runs
  into it. Give a heavy set-up its own file and server.
- A two-connection race test needs two different actors. The same actor's command lock serialises them, so the test
  would pass without the fix.
- `refusalOf` keeps code, kind, why and status, not `whatYouCanDo`. To assert a hint, match the raw result.
- The route-wide test `gmp-batch-routes.test.ts` builds every path from a `sample` map. A new path parameter name
  needs an entry there.
- There is no real injectables or API master fixture. Those editions' masters start blank from a formula
  (`apps/tablets-server/test/designer/discard-draft-editions.test.ts` has a small set-up).
- A seed block's definition changes reach a library that already holds the code only through `loadCatalogue`'s
  rule: a held latest version equal to the seed apart from version and edition gets the seed as the next version.
- The database keeps `EBMR-LIB-001` (at least one section); a fieldless block therefore has one text section.
- A dispatch of ci.yml with `e2e_groups` runs only those E2E groups; the static checks, test shards, golden batches and
  trace are skipped. With the lead's agreement, a PR then gets the touched E2E groups on GitHub plus the local
  `pnpm run ci`, the golden batches and the trace, with the counts posted in the PR.
- Local golden batches as root: `RUNNER_ENVIRONMENT=github-hosted RUNNER_TEMP=<scratch> bash tools/ci/start-postgres.sh
  start --golden` makes the clock-preloaded cluster `golden` on 5433 (its private path refuses root). Source its export
  lines, run `pnpm vitest run apps/tablets-server/test/golden --no-file-parallelism ... --outputFile.json=.reports/vitest-golden.json`,
  then the trace with `--playwright` pointing at a missing file (one group's Playwright report misleads the trace).
- Local E2E with Playwright 1.56.1: give PLAYWRIGHT_BROWSERS_PATH a scratch directory holding
  `chromium_headless_shell-1194/chrome-linux/headless_shell` and `chromium-1194/chrome-linux`, linked to the installed
  1243 builds (`chrome-headless-shell-linux64/chrome-headless-shell` and `chrome-linux64`).
- A yield outside its limits raises YIELD_OUT_OF_LIMITS (not LIMIT_BREACH), and the run waits on it.
- A route that looks up its record before it checks the permission reads "A" (404) in the route-by-role matrix for a
  role the server refuses on a real record (#184). Check the permission first, then re-record the matrix
  (`EBMR_WRITE_MATRIX=1`) and regenerate READ_REFUSED from its F cells (home-tiles.test.tsx).
- A layout E2E check must probe the case that fails: the first form of the D-7 check passed without the fix. Measure
  first (page.evaluate with bounding boxes), then assert on the measured case.
- Local E2E of one spec: about 23 minutes on 4 cores (global set-up of both servers dominates).
