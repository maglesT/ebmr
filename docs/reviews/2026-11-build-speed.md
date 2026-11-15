# Build speed review (November 2026)

Session 19, 14 November 2026, for the owner's question: "a batch record is also a digital form; other products take
2-3 hours for a major change, this takes days or weeks. There may be a fundamental design problem."

Short answer: yes, there are two design problems (every GMP rule is written twice, and library blocks are edited in
place at version 1) and one process problem (every pull request pays for the whole 94-minute suite, often more than
once). The regulated parts (signatures, append-only records, database enforcement of the regulation-required core) cost
something, but they are not the main cost.

## How it was measured

- CI: the GitHub Actions API, the last 20 merged pull requests (#239 to #259, 12 to 14 November), every `ci.yml` run on
  their branches before the merge, and the job timings of 4 successful runs (#241, #244, #247, #257). Raw data was kept
  in the session scratchpad and is not committed.
- Code: `git` over the whole history of `main` (it starts on 27 September 2026, so "the last two months" is all of it:
  250 merges).

## Numbers

### The merge loop (20 PRs)

| Measure | Median | Total | Worst |
|---|---|---|---|
| First push to merge | 4.2 h | 119 h | 19.8 h (#249) |
| CI runs started | 2.5 | 53 | 5 |
| Full runs (ran to the end) | 1 | 29 | 3 |
| Cancelled runs (a new push or a merge of main) | 1 | 24 | 4 |
| Re-runs because main moved (strict count) | 0 | 4 | 1 |
| Re-runs for a flake | 0 | 3 (all green on attempt 2) | 1 |
| Failed full runs (real defects, then a fix commit) | 0 | 4 | 2 |

- 45 % of runs were cancelled. Several merges of main cancelled a run 30 to 100 minutes in (#255, #258), so the strict
  "main moved" count of 4 understates the cost of the rule "a full run whose head contains main".
- No flaky failures in the window; three re-runs passed at once. Flakes are not the problem this week.

### One full run

- Wall clock: about 94 minutes (88 to 99). Runner time: about 960 minutes (16 runner-hours) per run.
- End-to-end: about 800 of those 960 minutes (85 %), 24 groups, all of them on every pull request whatever it changes.
- Critical path: `own-p3` 65 min, `own-demotab` 58 min, then `route-w` 44, `library-inj-aseptic` 42, `library-inj-routes`
  42, `route-s` 41, `library-softgel` 41, `p3-demo` 40, `rest` 38; the other 15 groups 20 to 37 min.
- Golden batches 30 min. Unit/DB test shards 6 to 10 min, except shard 7 at 24 min (unbalanced). Static checks 8 min.

### Rules written twice

| Measure | Count |
|---|---|
| SQL migrations | 700 files, 153,800 lines |
| Migrations whose header says they reproduce a TypeScript rule (name a `.ts` file, "as the engine", "the validator", "the server's") | 247 files (35 %), 65,700 lines (43 % of all SQL) |
| Merges that change SQL and product TypeScript together | 89 of 250 (36 %) |
| Merges that change SQL only | 14 |
| Database functions redefined after their first version (`CREATE OR REPLACE` in a later migration) | 451 functions, 696 redefinitions |

- Every change to a guard repeats the whole function in a new migration (never edit a migration), so a one-line rule
  change is a few hundred lines of copied SQL. Example: `recipe-core 1862` (420 lines) exists to make the database judge a
  library block's limits "as the generic handler does (library/block-version.ts)": a second implementation of the
  limits, statistics, timer durations and loop exits that the engine already had.
- The most redefined functions are the shared lookups and the execution guards (`tab.kernel_signing_meanings` 26 times,
  `tab.aggregate_read_class` 22, `recipe.execution_content_of`, `recipe.execution_rule_violations`,
  `recipe.check_signatures`, `recipe.propose_disposition` 7 to 8 each, `recipe.entry_block_problem` 5).
- Drift between the two copies shows up as review findings and demo bugs (for example R3-SQL-1 to 5 in 1862, the
  hidden-field and expected-answer work in flight now, "a database refusal ... is a refusal" in #210). Not every one is
  tagged in the commit text, so the exact number of drift PRs cannot be read from `git`; the 89 joint SQL+TS merges are
  the upper bound and the 247 mirror migrations the size.

### Other structural costs

| Cost | Numbers | Effect |
|---|---|---|
| Library blocks edited in place at version 1 | 164 blocks, every one `version: 1`; the seed changed in 30 merges, 9 of them with SQL too | A block change reaches every master, golden batch and E2E flow built on it, so it is never a local change; and a signed master's block can change under it. |
| Migration numbers | 13 renumbers, mostly when merging main | Minutes each, but each forces another CI run. |
| Test suite size | 962 test files, 240,000 lines (more than the 219,000 lines of product TypeScript); 12,100 control-ID citations; 74 E2E specs | Expected for regulated software. Only the E2E part sits on the critical path. |
| Docs | 116,000 lines in `docs/` (287 Markdown files); 411 of 2,059 commits are docs, handovers or progress; long migration headers (1862: 40 lines) | Moderate. Rarely on the critical path, but read cost in every session. |

## Causes, ranked

1. **Every pull request runs all 24 E2E groups, 94 minutes, often twice.** 4.2 h median to merge with about 1 full run
   and 1 cancelled run per PR. Avoidable: a gate that runs what the change can affect (Stage B), shorter groups (Stage C).
2. **Every GMP rule is written twice, in TypeScript and in PL/pgSQL, by hand.** 43 % of the SQL; 36 % of merges change
   both. A change is designed twice, tested twice and reviewed for agreement, and the copies drift. The database
   enforcement itself is **unavoidable** (decision 0008 section 2); writing it twice by hand is not (Stage D: one
   declarative definition, both generated).
3. **Guard changes copy the whole function.** 696 redefinitions. Append-only migrations are **unavoidable** (auditable
   history); the copy is cheap once the SQL is generated (cause 2).
4. **Library blocks change in place at version 1.** Turns a block fix into a change across masters, golden batches and
   E2E. Avoidable: versioned blocks (v2 beside v1, masters pinned to the version they were approved with).
5. **Merging main re-runs the full suite.** 24 cancelled runs and 4 strict re-runs in 20 PRs, worse with stacked PRs.
   Avoidable: re-run only the gate after a merge of main; full runs on main after every merge.
6. **Migration renumbering on merge** (13 times). Small; avoidable with a number reserved per branch or a timestamp
   scheme, decided with Stage D.
7. **Docs and handover overhead.** Moderate; partly the price of sessions that do not share memory.
8. **Test shard 7 at 24 min** against 6 to 10 for the others. Small; rebalance.

Unavoidable and kept: e-signatures and their re-authentication, append-only audit and records, database enforcement of
the regulation-required core, never editing a migration, a control-ID test for every control due, and a full green run
for phase exits and releases. They are not what makes a change take days: causes 1, 2, 4 and 5 are.

## What follows

- Stage B: decision 0032 and the PR gate (target 20 to 30 minutes per PR; full runs on main).
- Stage C: the renderer freeze and the two long `own-*` groups.
- Stage D: an ADR for one rule definition generating both the engine check and the database guard, with library v2
  versioning; first family: expected answers, hidden fields and limits.
