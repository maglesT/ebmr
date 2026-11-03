# Handover: Phase B, slice 1 done → slice 2 next

Written 3 Nov 2026 by the Phase B session (`session_01PybpFvp8nGx4RzAUJdZUcX`) for a fresh session. Lead:
`session_01PybpFurhHU4ktqworXhVvF`. Report to the lead after each merge and for decisions, with the claude-code-remote
`send_message` tool. Owner rules: CLAUDE.md, no model name in commit trailers, squash-merge, one review pass, CI green.
The owner said "merge yourself things" (3 Nov), so merge your own PRs once CI is green and the review pass is done.

## Read first

All in this folder:

- `platform-move-plan.md`: the approved plan, with decision 3 revised to TLS.
- `slice-2-design.md`: approved by the lead on 3 Nov, with the note "keep the mirroring code small and fully covered
  by control-ID tests".
- `permission-list.md`
- `owner-note-access.md`

## State

- **Slice 1, Batchwright side:** PR #88 (`phase-b/s1-wiring`). It adds the one-shot migrator
  `apps/tablets-server/src/cli/platform-migrate.ts`, `platformEnv` in `config.ts` (verified TLS), `ops/Dockerfile` and
  `ops/entrypoint.sh`, and the test `apps/tablets-server/test/medhanta/platform-wiring.test.ts`. If it is not merged
  yet, merge it once CI is green.
- **Slice 1, platform side:** databsee branch `b-ebmr-1`, with these changes:
  - `apps/ebmr/manifest.json`: 140 codes, 10 published views, `"migrate": "own"`, `logins`;
  - `deploy/apply.ts`: `Runtime.migrateOwn`; licence off switches the extra logins off;
  - `deploy/config.ts`, `deploy/bundle.sh`;
  - `deploy/compose.yml`: the `ebmr` service, and TLS on the db with a self-signed certificate for `db`, whose
    certificate goes into the `pgca` volume;
  - `deploy/compose.external.yml` (port 8109), the customer templates, `test/apply.test.ts`.

  Before the PR, set `source.commit` in the manifest to #88's squash commit on ebmr main (it is all zeros now). Rebase
  on databsee main, run its tests (local PG 16 cluster `medhanta` on port 55432:
  `PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres PGPASSWORD=postgres npx vitest run`, plus `npx tsc --noEmit` and
  `python3 scripts/check-traceability.py`), open the PR, merge once green, then tell the lead.
- **Smoke test (done):** Docker in this container works after `dockerd &`. The image builds with the proxy CA passed
  as a BuildKit secret (local only; see the scratch `Dockerfile.local` approach). postgres 17.11 with the platform's
  entrypoint, plus `cluster.sql`/`database.sql`: migrate applied 640, then 0; the server became healthy in production
  mode over verify-full.
- **Views (decision 7):**
  - Operations reads `batch_fact_v1`, `step_use_v1`, `cpp_value_v1`, `process_actual_v1` and `ipc_result_v1`, all
    among the 10. It hashes every column except `read_at`, so add columns only.
  - The provider database is `ebmr`, so Operations and Deviations use `reads: {ebmr: [...]}`; the lead knows.
  - Slice 4 adds `read_at`/`data_as_of` and `security_barrier`.

## Slice 2: what to build

Branch `phase-b/s2-signon`, which holds only the design. Rebase it on main after #88 merges. The design's sections:

1. **Kernel migrations (new files only; never edit released ones).** Choose the namespace by where the function lives:
   - the platform flag (`kernel.platform_identity()` or a settings row) that the platform migrator sets at its end;
   - `iam.platform_identity` (the id map);
   - auth_event method `PLATFORM` (change the check constraint);
   - `iam.platform_auth_event(...)`, authn login only;
   - `iam.platform_sync_grants(...)`: mirror roles `P:<login>:WORK` and `P:<login>:ADMIN`, insert-only, with a
     removed code revoked.
2. **Server:**
   - OIDC routes `/cb` and `/sign`, after Deviations' `server/signon.ts`, `server/routes/auth.ts` and
     `server/signatures.ts` (repo `maglesT/dev-mang-modu`, cloned at `/home/user/dev-mang-modu`);
   - `POST /api/session/login` with `method: 'PLATFORM'`;
   - the esig sign route taking a proof;
   - the admin and credential routes answering "Managed in the platform" when the flag is set.

   Key files:
   - `apps/tablets-server/src/features/session/index.ts:114` (login), `:218` (role)
   - `features/esig/index.ts:361`, `:435`
   - `platform/http/bind.ts`
   - kernel `0160:410` authn_finish, `0160:581` consume_auth_event, `0230:439` esig.sign, `0130:165`
     evaluate_authority, `1375:99` first_run_setup
   - `tablets 0480:22` bind_session, `1460:26` resolve_session
3. **Web:** sign-in through core, and the sign dialog opening a core popup.
4. **Tests by control ID** on a platform-flagged database:
   - token → roles sync, and a removed code revoked;
   - the work mode (DI-18);
   - the signing proof bound to the challenge, the person, the code and the nonce;
   - `auth_time` after the challenge;
   - DI-35 and EBMR-LIB-007 with core re-authentication;
   - the local password path off (DI-19).

   The 118 standalone test files stay as they are.

## Later slices

- 3: master data (`md.master_fact`, `md.require_active`).
- 4: views.
- 5: demo codes.
- 6: move script.
- 7: runbook.

## Environment notes

- Local PG 16 `main` on 5432 holds the role `ebmr_dev`/`ebmr_dev` superuser (created this session; a new container
  starts it stopped: `pg_ctlcluster 16 main start`).
- Force-push is refused by the permission checker: merge the remote tip instead.
