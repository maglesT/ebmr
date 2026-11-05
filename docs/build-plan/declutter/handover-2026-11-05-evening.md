# Tablets/CI session handover, 5 November 2026 (evening)

From session_01PybpFrPxcxm8jkjX4NfT5E (context limit). The lead is session_01PybpFuUgimTwCNtTsK7cf1. Report to the lead with
send_message after each merge. The owner ended the merge queue, so merge your own PRs on green. Each PR still gets a lead
audit before its merge: ping the lead when it is green.

## Merged today (this session)
- #121 D2 (1262f3a): the home and links show only what works.
- #125 Ubicloud CI (4139aca). With CI_RUNNER=ubicloud: the E2E groups run on ubicloud-standard-4, golden on standard-8,
  and the gate jobs (changes, e2e-plan) on standard-2. Static checks, shards and the light jobs run on GitHub-hosted. A
  [meta] test (tools/register/test/ci-runners.test.ts) pins this map. A docs-only PR (Markdown outside test folders)
  skips E2E (tools/ci/changes.sh). Proof run 3: E2E on 4 vCPU was as fast as on 8, about 2,200 Ubicloud vCPU-min, about
  $1.40 standard per full run (run 1 was 4,696 and $2.94). The owner is to set CI_RUNNER=ubicloud.

## Open PRs (all mine)
| PR | Branch / head | State | Next |
|---|---|---|---|
| #126 generated-file conflicts | ci/generated-files 52884e5c | main merged in; CI was running | Merge on green (lead cleared earlier). It untracks the handbook's generated pages (CI uploads `handbook-generated`) and sorts control tests lists (`register:sort-tests`; validate refuses unsorted). On a conflict: take main's control yaml, `pnpm register:sort-tests`, keep the 4 pages untracked. |
| #128 D3 | declutter/d3 da5d045a | lead cleared; CI re-running after the handbook regeneration | Merge on green. The home is the work cards plus an "All screens" link; the step is one form page; one DISCONNECTED list derived from the contract. 12 E2E spec helpers got one click on `home-all-screens`. Watch `not-enrolled.test.tsx` (one unexplained failure in a local full run; rerun once if it fails, then root-cause). |
| #136 D4 | declutter/d4 f1816e20 | lead audit OK; merge on green AFTER #128 | 6 deviation routes disconnected at route level. Kept: deviations list, deviationRelease, raise/link, startInvestigation and recordFinding (D4-R5 option A). Residuals D4-R1..R5 in plan §7. Two review minors left by decision. |

## In flight
- D4b (agent, branch declutter/d4b from declutter/d4): the deviation page is reachable from the lot page ONLY for that
  lot's OOS/lab-error record, with only the investigation, finding and QA conclusion parts; no list and no new screens. When
  it reports: one review pass, open the PR (base main after #136 merges), lead audit, merge on green.
- E2E set-up gating (agent, branch ci/e2e-setup-gating; may not have reported). Goal: per-group gating of
  gmpReviewBatch/gmpPackaging in tools/e2e/global-setup.ts (about 13.5 min set-up in every E2E group). Lead approved it as
  a small separate PR; report the set-up minutes and wall time before and after.
- Leftover branches: ci/ubicloud-gate (delete failed through the proxy) and declutter/d3-screens (screenshots only). Both
  are harmless; delete them on GitHub.

## Next after these
- The demo-server update block (lead).
- Tablets flakes: shard 1 (drills, DI-48) and shard 8 (record-lock); root-cause in a test-only PR, no skipping.

## Facts worth keeping
- While #126 is unmerged, every branch must run `pnpm -s handbook` and commit the generated pages, or the handbook
  [meta] test fails in CI. Once #126 merges, never commit them.
- New package.json scripts and tools/ci scripts must be listed in apps/tablets-web/test/meta/commands-have-screens.test.ts.
- `runs-on` cannot read github.job; give each job a literal label.
- GitHub-hosted queue: many PRs at once leave jobs queued for 30–60 min. Cancel stale runs.
- Local PostgreSQL stops on a container restart: `sudo pg_ctlcluster 16 main start`; role ebmr_dev/ebmr_dev superuser.
- eslint over large file sets may need `node --max-old-space-size=8192`.
