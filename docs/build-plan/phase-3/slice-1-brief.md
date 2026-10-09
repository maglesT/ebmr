# Slice 1 builder brief (common to agents A, B, C)

Repository /home/user/ebmr, branch phase-3/slice-1. Read CLAUDE.md (hard rules) and
docs/build-plan/phase-3/slice-1-plan.md (scope, core/other classes, defaults) first. Search the big docs
(docs/outline/build-outline.md sections 5.2.8, 5.2.9, 5.3; docs/design/architecture.md) for what you need; never read them whole.

Patterns to copy (verified):
- Small GMP table + guard + audit + grants: packages/kernel/sql/0551_platform_sample_record.sql.
- State machines: XState definition in TS + generated seed migration via kernel `state.machineSeedSql`
  (packages/recipe-core/src/lifecycle/machine.ts + lifecycle/write-seeds.ts -> recipe-core/sql/0140_machine_mbr_version_v1.sql).
  Transitions through `platform.transition(...)` (kernel 0550:509) wrapped by a SECURITY DEFINER domain function like
  `recipe.return_to_draft` (recipe-core 0150_mbr_commands.sql:232); creation like `recipe.insert_version` (:54).
  Guards: `platform.register_guard`; signatures: transition `signature: <meaning>` verified by the engine.
- Audit: `kernel.register_audited_table(...)`; db time: `platform.enforce_db_time(...)`.
- Every migration: `set local role ebmr_owner;` ... `reset role;`, `revoke all ... from public`, writes only through
  definer functions (no direct insert/update grants on core tables to ebmr_app), definers hardened with
  `set search_path = pg_catalog, <schema>, pg_temp` (ADR 0012, 0016; kernel test security/definer-hardening).
- Permissions/roles: insert into iam.permission / iam.role_permission as recipe-core 0100_recipe_foundation.sql:115 does.
  Signature meanings: find how recipe-core adds esig meanings (grep esig.meaning) and do the same.
- Tests: `db` vitest project, helpers in packages/site-services/test/helpers.ts (createTestDatabase, testActor,
  scopedTestActor, signerActor, signFor, dbTime), writes via withCommand (packages/kernel/src/db/command.ts).
  Imitate packages/site-services/test/authorization.test.ts. Recipe-core tests: look at packages/recipe-core/test for
  the equivalent helpers.

Rules:
- Never edit an existing migration; only add new files in YOUR number range. Don't touch other agents' files.
- No `Date.now()`/`new Date()` in domain code; GMP quantities use numeric in SQL and the expr decimal type in TS, never number.
- Core rules (plan table) are enforced in the database and proven by tests that call as ebmr_app, including a bypass
  attempt (direct insert/update refused). Test names carry control ids, e.g. `it('[IN-25][INV-12] ...')`.
  Tag only with controls whose catalog test or behaviour the test really proves.
- Microsecond edge tests only where a rule depends on the exact instant (decision 0008 2.5).
- Run only your own tests and `pnpm typecheck` + `pnpm lint` on your files, against your assigned PostgreSQL cluster:
  `EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:<port>/postgres pnpm vitest run --project db <paths> --reporter=dot | tail -n 30`.
  Do not run `pnpm run ci`. Keep command output short.
- Do not commit, do not edit compliance/controls YAML, PROGRESS.md or the plan; do not delete databases or branches.
- If something is genuinely ambiguous, take the default that is stricter and note it.
- Final report (max 25 lines): files added, machines/functions, the rules enforced, tests (count, pass), defaults taken,
  anything left open.
