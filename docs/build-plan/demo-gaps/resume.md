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
| D-2 formula lines, formula draft withdrawal (recipe-core 1877) | #160 | cleared by the lead; the lead squash-merges it on green |
| D-3 discard a draft, restart the family (recipe-core 1878) | #161 | cleared by the lead; squash-merge it on green after #160 (plain trailers) |
| R-flow | not started | plan in `r-flow.md` |
| D-3 follow-up: PROGRESS | this docs PR | the "Demo gaps" paragraph of `PROGRESS.md` names D-1 to D-3 |
| R-rest, then D-4 to D-8 | not started | D-8 is a plan only, sent to the lead before any building |

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
