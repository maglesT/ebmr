# Decision record 0032: the faster merge loop

- **Date:** 14 November 2026
- **Decided by:** the owner, approved by the owner (relayed by the lead). In the lead session
  (https://claude.ai/code/session_01PybpFrP72XuwyG8S3H3NJS), 14 November 2026, about 15:30 UTC, the lead proposed:
  "Shorten the merge loop. Run only the tests a change touches on each PR, and run the full suite once on the merged
  result or nightly. This changes your merge rule, so it's your call." The owner replied: "yes do it and implement the
  three you said". The lead shows the owner this text, and the owner may veto it. Prepared by build session 19.
- **Amends:** the lead's merge rule "a full run whose head contains main", and decision 0008 on when control-ID tests
  run (decision 0008 says only an owner decision sets that; this is that decision). Nothing else in 0008 changes.
- **Evidence:** `docs/reviews/2026-11-build-speed.md`. Over 20 PRs, the median from first push to merge was 4.2 h. One
  full run takes about 94 minutes, and 45 % of runs were cancelled, often by a merge of main.

## The rule

1. **A pull request merges on its gate.** Its gate must be green on a head that contains main. The gate always runs:
   - the static checks (typecheck, lint, boundaries, pins, `register:validate`, the handbook, the web build) and the
     supply-chain job;
   - the Vitest tests of every package the change touches, of every package that depends on one of them, and of every
     package whose files name a changed path (`tools/ci/src/select.ts`). A SQL change therefore runs every database test
     of its package and of its dependents;
   - the SQL mutation harness on the guard functions a changed migration defines, at their group's threshold;
   - the golden batches whenever the tablets server's tests are selected (the engine, recipe-core, edition SQL or
     anything they depend on changed);
   - the end-to-end groups that `tools/ci/e2e-map.json` maps the changed paths to. A changed path no rule maps runs
     every group, never none;
   - the trace gate on what the gate ran (`register trace --partial`). A failing test, an unknown control, an unlisted
     passing test, and a listed test that its file no longer reports all fail the gate, as in a full run.

   Any doubt selects more: a root configuration file, a path in no package that no package names, or a diff that cannot
   be read runs every test.
2. **After merging main into a pull request, only its gate runs again.** The selection diffs the pull request against
   its merge base with main, so the merge itself adds nothing to it.
3. **A full run on main after every merge, plus a nightly full run.** A newer merge no longer cancels the full run of
   an earlier one.
4. **A red main stops every merge** until it is fixed or reverted. The workflow `main-green.yml` fails a pull request
   while the newest finished full run on main failed. The pull request that fixes or reverts main carries the label
   `fixes-main`. It still needs its own gate green.
5. **Phase exits and releases still need a full green run.** That is a run by hand of `ci.yml` on the branch, with no
   `e2e_groups`.
6. **The evidence is unchanged.** Every control-ID test runs on every full run on main. The trace gate's matrix and
   the validation evidence come from those full runs, never from a gate.
7. **No test is skipped, quarantined or weakened.** The gate chooses which tests run before the merge. Main's full run
   runs all of them.

## What it is expected to save, and what it does not

- **Cancelled runs and re-runs after merging main:** about one per PR. A re-run now costs only the gate.
- **Docs, register, unit-test, tools, single-spec and injectables-only PRs:** a much smaller gate (no golden batches,
  few or no end-to-end groups).
- **Changes to shared code** (the tablets server, its SQL, the web app, the kernel, recipe-core) still run every
  end-to-end group, because the map does not narrow them. Measured on the last 12 merged PRs, 10 would still have run
  all 24 groups. For those PRs, the time comes down only when the long groups do (the next step: own-p3 65 minutes,
  own-demotab 58, route-w 44).
- **The alternative** the owner may choose instead: map shared code to a fixed core subset of groups, and leave the
  product journeys (own-*, p3-demo, the other library groups) to main's full run. It is faster now, but core changes
  get less browser coverage before they merge. Not chosen: the rule above keeps every group for shared code.

## Open

- How long the SQL mutation job takes on a real SQL change has not been measured yet. It will be measured on the first
  one. If it takes longer than the end-to-end groups, the lead decides whether it moves to main's full run.
