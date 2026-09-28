# Phase 1 exit: fix brief (common to all fix agents)

Work ONLY in /home/user/ebmr (branch `phase-1/mutation-testing`). Never touch /home/user/ebmr-p2 (Phase 2 is being
built there) or /home/user/ebmr-review. Several fix agents work in this checkout at the same time, one per module.

Inputs:
- `docs/build-plan/phase-1-exit/review-results-2026-09-28.json`: the adversarial review. `confirmed` findings were
  reproduced with a failing test; `plausible` ones survived a skeptic but were not reproduced; `critic.new_findings`
  come from the completeness critic. Each has file, line, function, description, failure_scenario, suggested_fix.
- `docs/build-plan/phase-1-exit/sql-mutation-kill-results-2026-09-28.json`: defects found while writing mutation kill
  tests (field `defects` per group).
- `packages/kernel/test/review/<id>.test.ts`: the reproducer of each confirmed finding. It FAILS today and must PASS
  after your fix. You may correct a reproducer's setup if it is wrong (say so), never weaken what it asserts. Rename the
  test titles to carry the control/invariant IDs in brackets if they do not already. Keep them in test/review.

Rules:
- Fix the root cause in the module you own. The Phase 1 migrations are on no persistent database yet, so edit the
  migration where the defect lives (do not add a patch migration), keeping every existing test green.
- Never weaken a control, an invariant or an existing test to make a fix easier. If a finding is wrong or a fix would
  change a decided behaviour, do not fix it: explain it in your final message.
- Plausible and critic findings in your list: decide. Fix it if it is real (add a test that fails before and passes
  after); otherwise explain why not.
- Keep the existing conventions (SECURITY DEFINER with `pg_temp` last in search_path; iam.assert_not_administrator and
  iam.require_permission on writers; error codes EBMR-<AREA>-NNN; plain-language messages; paraphrase regulations).
- Do not commit, push, stash, reset, switch branches or install packages. Stay inside your module's files plus its
  tests; if a fix needs a change in another module, describe it in your final message (another agent owns that file).
- Test before finishing: your module's tests, your review reproducers, and the SQL mutation kill tests of your module's
  groups (`packages/kernel/test/mutation/<group>.test.ts`; if a fix legitimately changes behaviour a kill test pinned,
  update that kill test and say why). Then typecheck (`npx tsc -p tsconfig.json`) and lint your files. The machine has
  4 CPUs and other agents are testing too: run targeted test files, not the whole suite; the lead runs the full suite.
- Final message: for each finding id: FIXED (what and where; which test proves it), NOT A DEFECT (why), or NEEDS
  ANOTHER MODULE (what); files changed; tests run and results.
