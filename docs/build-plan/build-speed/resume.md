# Build speed (session 19): resume notes

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

## Numbers to keep

- **Before:** median 4.2 h from first push to merge; a full run takes about 94 min and 960 runner-minutes, 85 % of it E2E.
- **Setup:** 828 s locally with the packaging option, which every library and route group needs (the review batch adds
  only about 16 s); 66 s without it. A seed restores in 15 s (24 MB), and a restored seed equals a fresh build.
- **Waits:** 131 of 490 E2E test-minutes are deliberate (badge pace 79, process timers 38, rate limit 13). The long
  own-p3 and own-demotab kiosk tests are UI work, not waiting.
- **Gate selection:** on the last 12 PRs, 10 still select all 24 groups, because they touch shared code. The speed
  comes from the seed, Ubicloud and fewer runner-minutes (the account's concurrent-job limit is the queue).

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
