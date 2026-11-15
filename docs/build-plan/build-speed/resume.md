# Build speed (sessions 19 and 20): resume notes

The lead (session_01PybpFrP72XuwyG8S3H3NJS) runs this work and audits every PR. Report to it with `send_message`.
Squash-merge only after its audit PASS. Commit trailers: `Co-Authored-By: Claude <noreply@anthropic.com>` and this
session's `Claude-Session` line.

## Done and where it is (14 November 2026, evening)

| PR | Branch | What | State |
|---|---|---|---|
| #262 | build-speed/review | `docs/reviews/2026-11-build-speed.md`: measured causes, ranked | docs; waiting for the lead |
| #263 | build-speed/merge-loop | Decision 0032: the PR gate (`tools/ci/src/select.ts`, `e2e-map.json`), `register trace --partial`, full runs on main and nightly, `main-green.yml` (`fixes-main` label), SQL mutation gate on new survivors (`tools/sql-mutation/src/new-survivors.ts`), runs by hand cancel older ones | CI on af57d19c and a run by hand there; send "ready for audit" when both are green (the old rule needs a full run) |
| #264 | build-speed/e2e-speed (base #263) | `records` E2E group (review batch and SR profile only there), `fixtures/waits.ts` wait annotations | audit PASS, conditional on #263: after #263 merges, rebase on main and squash-merge (no new full run if the rebase is clean) |
| #265 | build-speed/e2e-seed (base #264) | the E2E set-up built once per run (`tools/e2e/seed.ts`, `seed-cli.ts`, `e2e-seed` and `seed-check` jobs); `E2E_RUNNER=ubicloud` (owner) | CI running; not yet audited |
| #266 | build-speed/adr-rules | ADR 0023 (accepted by the lead, with additions 9 to 12); these notes | docs; the squash message must carry this session's Claude-Session line (commit b16e8fea has the lead's by mistake) |

## Session 19 handover (15 November 2026)

Session 19 is done. Final states:
- **Merged:** #263 (0f7341b), #264 (aa4e439), #266 (f88b88b), #267 (6de00cd, by the lead); #272 (this note and the
  0032 item 3 wording) once green.
- **Lead's PR:** #270 fixed my gate's shallow-fetch bug (PR gates ran everything, and the SQL mutation gate was
  skipped, until it merged).
- **Closed:** #265, replaced by #268, which session 20 owns: the physical cluster snapshot, see the finding below.
- **Still open:** #262 (the review) is waiting for the lead.
- **Main's first full run under 0032:** 43633589463, green; it contains #263 and #264.
- **Still open from the plan:**
  - the Ubicloud run by hand, once the owner sets `E2E_RUNNER`;
  - `packages/rules` PR 2 onward (session 20);
  - rebalancing test shard 7.

## Session 20 handover (15 November 2026)

Session 20 (session_01PybpFvK34ypWZV83eSdnDU) did ADR 0023 PR 2 and the physical seed.

- **#269, merged as adbd1ba (lead audit PASS).** It added:
  - the SQL generator: `packages/rules/src/generate/` and `src/catalog.ts`;
  - `pnpm rules:generate` and `rules:check`, which is in the static checks;
  - recipe-core `1930_rules_generated.sql`: `recipe.rules_key`, `rules_member` and `rules_decimal`, plus
    `recipe.rule_library_field_shown` and `rule_library_unexpected_answer`. No guard calls them yet;
  - the conformance suite against PostgreSQL 16 (`packages/rules/test/conformance.test.ts`), with zero differences;
  - Stryker on the package: no survivor, CI job `rules-mutation`, selected by `plan.rulesMutation` in `select.ts`;
  - SQL mutation group `rules-generated`: 0 survivors, 2 recorded equivalents.

  Read `docs/handbook/modules/rules.md` first.
- **#268 (branch build-speed/e2e-seed-main), session 20 owns it.**
  - The E2E seed is now a physical snapshot: `tools/ci/start-postgres.sh` `snapshot`, `start --from-seed` and
    `check-seed`; `tools/e2e/seed.ts` `attachSeed`.
  - On e2d33f9 the whole gate was green: `rest` attached the seed, and `[IN-53]` and all 58 tests passed. The
    `[DI-45]` test is `tools/e2e/test/seed-snapshot.test.ts`.
  - Lead ruling (14 November): seed-check runs on the seed job's runner. `ci-runners.test.ts` records this.
  - Head 92644e5 contains main adbd1ba and its gate is running. Send the lead "#268 ready for audit" when it is green.
- **Next: family 6.1 (showWhen), after recipe-core 1928 merges (#271).**
  - Base it on this branch, `rules/family-6-1-showwhen`, from main.
  - The work:
    - the engine's `shown` (`recipe-core/src/library/block-version.ts:208`) calls `holds(FIELD_SHOWN.body, ...)`;
    - a new migration makes the hand-written guard's visibility (1862 `library_limits_problem` and 1928's
      hidden-field guard) call `recipe.rule_library_field_shown`;
    - the differential harness compares the old and new results, with zero differences on the full seeded corpus
      and the bypass tests;
    - the control-ID tests stay unchanged;
    - the SQL mutation score is met or beaten.
  - Start with the lead's advisory. GMP decimals must reach the rules as strings: `interpret.ts` reads a JSON number
    through `Dec.parse(String(n))` after JSON.parse has already rounded it.
    - Finding (session 20): families 6.1 and 6.2 compare only with `same`, on yes/no and choice values.
      `checkShowWhen` admits no other kind of field, so no number reaches a decimal ordering before 6.3 (limits).
    - Proposed now: a catalogue test that fails while any catalogued definition uses `lt`/`lte`/`gt`/`gte` and the
      decimal input policy is not settled.
    - At 6.3, decide between refusing a JSON number in a decimal position on both backends, and flagging it, for
      example with an `isDecimal` node that the rule requires.
- **Local machine:** the container restarts often, and PostgreSQL then comes up stopped. Run
  `sudo pg_ctlcluster 16 main start` and, if needed, `sudo -u postgres psql -c "create role ebmr_dev superuser login
  password 'ebmr_dev'"`.

## Session 22 handover (15 November 2026): family 6.1

Session 22 (session_01PybpFuPWAkrnUh4Tdhqquq) owns **#275** (branch rules/family-6-1-showwhen, draft).
- **Done (commit 5084a51):**
  - the engine's `shown` calls `holds(FIELD_SHOWN.body, ...)`;
  - the differential harness `packages/recipe-core/test/library/field-shown-differential.ts` (+ `.test.ts`, and
    `storedDifferences` in `library-batch-gmp.test.ts`): zero differences;
  - `packages/rules/src/policy.ts` and `test/policy.test.ts`: the decimal-input guard;
  - Stryker on rules: 100 %.
- **Lead:** session_01PybpFvF4SWgYSyQDHAVFb6 since 15 November (the old lead has stopped). Send it the PR number,
  the 40-character head sha and the gate result.
- **Numbers (lead):** #261 is now recipe-core 1931 and #271 is 1932; 1933 is session 21's INV-23 (c). **This guard is
  1934.**
- **Lead rulings:**
  - move all three copies, 1931's included;
  - add a control-ID test that pins the three copies as one shared function;
  - both pinned differences are accepted (a numeric key hides the field; `showWhen: null` is no condition); note them
    in the PR body;
  - keep #275 a draft until #271 merges.
- **Left:** the guard migration, after #261 (1931) and #271 (1932) merge.
  - Use 1934 (the lead's number), and check it again before pushing.
  - CREATE OR REPLACE from the latest text: `library_limits_problem` (1931's), `library_answer_records` (1931) and
    `library_hidden_problem` (1932). In each, the visibility clause becomes `recipe.rule_library_field_shown(f, data)`.
  - 1931's copy uses `=` (it hides a condition that has no `equals`); add it to the harness as a legacy clause.
  - Add the harness and the bypass tests to the SQL mutation group `rules-generated`, and fix its comment "No guard calls
    them yet". Compare its score with the old groups: no new survivor.
  - Then run `pnpm run ci`, mark #275 ready and send the lead "ready for audit".

## Numbers to keep

- **Before:** median 4.2 h from first push to merge; a full run takes about 94 min and 960 runner-minutes, 85 % of it E2E.
- **Setup:** 828 s locally with the packaging option, which every library and route group needs (the review batch adds
  only about 16 s); 66 s without it. A seed restores in 15 s (24 MB), and a restored seed equals a fresh build.
- **Waits:** 131 of 490 E2E test-minutes are deliberate (badge pace 79, process timers 38, rate limit 13). The long
  own-p3 and own-demotab kiosk tests are UI work, not waiting.
- **Gate selection:** on the last 12 PRs, 10 still select all 24 groups, because they touch shared code. The speed
  comes from the seed, Ubicloud and fewer runner-minutes (the account's concurrent-job limit is the queue).

## Open finding on the seed (#268, replaces #265)

A logical seed (`pg_dump`/`pg_restore`) changes the database incarnation (`continuity.current_incarnation()`, kernel
0600: system identifier, WAL timeline, database and table oids). The continuity control (DI-45/INV-27) then refuses
numbers from any numbering rule whose ceiling was reserved during set-up: rest's `[IN-53]` was refused while planning a
GB-T-01 batch. This is correct behaviour. The restore procedure is not run in the groups, and the incarnation is not
faked. The fix is a physical snapshot of the cluster (its data directory, plus keys and exchange), unpacked in place by
`tools/ci/start-postgres.sh --from-seed`, on the same runner image. The lead is assigning it.

## Rulings to keep

- Keep every E2E group for shared code: option (a) in decision 0032; (b), a core subset, is the owner's to choose.
- No E2E test is dropped. Dropping control-ID tests or repointing control test lists is the owner's call (lead,
  14 November).
- Keep every wait and the DI-19 tap limit.

## Next

1. **When the owner sets `E2E_RUNNER=ubicloud`:** one run by hand on Ubicloud (Playwright and PostgreSQL 16 on
   ubuntu-2404).
2. **`packages/rules` (ADR 0023), in small PRs:**
   1. the vocabulary and the TypeScript interpreter, with Stryker;
   2. the SQL generator (deterministic) and `rules:check`;
   3. the conformance suite against PostgreSQL 16;
   4. the differential harness;
   5. then family 6.2, expected answers. That builds on #261, which adds the database requirement of
      `LIB_UNEXPECTED_ANSWER`.

   Family 6.1, visibility, waits for recipe-core 1928 (session 18).
3. **Test shard 7:** rebalance it (24 min against 6 to 10 for the others).
