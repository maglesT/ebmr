# Demo gaps: resume notes (7 November 2026)

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
| R-rest Part A, the validator rows (`r-rest.md`) | #180 | in review: 5 E2E groups on GitHub plus the local `pnpm run ci`, golden batches and trace (the lead's split) |
| D-4 demo catalogue approved, badge names the replacement (`d4-catalogue.md`) | #181 | in review: E2E library-dc on GitHub plus the local `pnpm run ci` |
| D-8 own calculations, names, yield, limit sources (`d8-calcs.md`) | this PR (branch `designer/d8-calcs`) | built on #180's head; rebase onto main after #180 merges (`git rebase --onto origin/main <#180 head> designer/d8-calcs`) |
| R-rest Part B (SQL rows; recipe-core 1880) | not started | plan in `r-rest.md` |
| D-5 to D-7 | not started | D-5 copied names (with item 13), D-6 equipment class from the plant, D-7 findings panel at 1400 px |

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

1. Retarget the D-8 PR to main once #180 merges (the lead does it), then rebase.
2. R-rest Part B (recipe-core 1880; ask the lead for a second number).
3. Plan D-5 to D-7 and send each plan to the lead before building.

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
