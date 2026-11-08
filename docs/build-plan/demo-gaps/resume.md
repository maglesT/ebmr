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
