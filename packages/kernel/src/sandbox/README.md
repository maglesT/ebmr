# Sandbox, training and simulation store (kernel module, schema `sandbox`)

Keeps test, training and simulation data out of GMP databases and makes it impossible to mistake for
GMP records. Build outline 4.4 (Databases), 6.5 (sandbox test runs), 5.3 (INV-18); ADR 0001 item 2,
ADR 0012 items 1 and 8. Design note: `docs/design/sandbox.md`.

**Control:** DI-05 (segregation of non-GMP functions). **Invariant:** INV-18 (test, simulation and
training data live in a separate database; GMP batches only from CURRENT or BRIDGING versions).

## What it provides

| Piece | Where | What it does |
|---|---|---|
| Installation marker | `sql/0800`, `kernel.installation_kind()` | Every database migrated with the kernel is marked `GMP` or `SANDBOX` once, when it is provisioned. The marker can never be updated, deleted, truncated or re-inserted, by any role. A sandbox must be named `ebmr_sandbox_<edition>` and no GMP database may use that prefix; a copy or restore under the wrong name reports no kind at all (`EBMR-SBX-004`). |
| Sandbox login role | `sql/0800`, `sql/0820` | `ebmr_sandbox` (LOGIN, NOINHERIT, member of nothing). CONNECT on sandbox databases only; in a GMP database CONNECT is revoked from PUBLIC and granted to `ebmr_app` and `ebmr_authn`. Inside a sandbox the role holds exactly the object privileges of `ebmr_app` and `ebmr_authn` (mirrored after every migration run), never a role membership, since memberships are cluster-wide. |
| Reserved identifiers | `sql/0810`, `identifiers.ts` | Sandbox batch numbers, lot numbers and person and device labels start with `TEST-`. A GMP database refuses any identifier whose NFKC form starts with `TEST-` in any letter case (`EBMR-SBX-021`); the sandbox refuses anything else (`EBMR-SBX-022`), so a real batch or lot number is never reused. Patterns are rows of `sandbox.reserved_identifier_pattern`. |
| Batch source rule | `sql/0810`, `batchIssueProblem` | GMP: every market state of the pinned version is CURRENT or BRIDGING (`EBMR-SBX-012`). Sandbox: any version may be test-run. |
| Watermark | `watermark.ts`, `sandbox.watermark()` | `TEST, NOT GMP` on every output of a sandbox and of every non-GMP function (simulation, training, analytics). |
| Provisioning | `provision.ts` | Creates, migrates, marks, closes and checks a sandbox; upgrades re-level its privileges. |
| Backend signals | `sql/0970`, `kernel.backend_signals_restricted()` | No role but a superuser may cancel or end another connection's work: `sandbox.apply_connect_policy()` takes `pg_cancel_backend` and `pg_terminate_backend` away from PUBLIC and every role that is not a superuser (function privileges live in the database, so a template copy keeps them; applying the policy again repairs a restore that lost them). `kernel.backend_signals_restricted()` reports whether the database holds the policy (also that no login role other than a superuser is in `pg_signal_backend`); the tablets manual-weighing gate refuses while it does not (tablets 0350, review P50 round 4). |
| Listener login roles | `sql/0980`, `sandbox.role_mirror_differences(role, roles[])` | `ebmr_listener` (GMP) and `ebmr_sandbox_listener` (sandbox): an edition's evidence listener logs in with a role of its own (LOGIN, NOINHERIT, member of nothing, no members), CONNECT only on databases of its kind; inside a sandbox the sandbox one holds exactly the GMP one's object privileges (mirrored with the others). Migrations grant the GMP one only what the listener records (tablets 0350 item 6). The application roles `ebmr_app` and `ebmr_sandbox` get CONNECTION LIMIT = the cluster's slots for ordinary roles less 8, the listener's share, computed when a database is migrated (EBMR-SBX-036 when the cluster has no room for it; set it again after changing max_connections). Review P50 follow-up round 4, decisions X36, X38. |
| Invariant query | `sandbox.segregation_problems()` | Must return no rows. GMP: any way in for the sandbox role or the sandbox listener (CONNECT, an object privilege, a default privilege, a membership, an elevated attribute). Sandbox: GMP roles (the GMP listener among them) or PUBLIC able to connect, privileges different from the mirror. Both: a listener role with an elevated attribute, a membership, or a member (kernel 0980). |

## Public API (`import { sandbox } from '@ebmr/kernel'` once exported)

TypeScript (`src/sandbox/`):

- `readInstallationKind(db)`, `assertInstallationKind(db, 'GMP' | 'SANDBOX')`: start-up guard for every
  server, job and adapter (`EBMR-SBX-007` on a mismatch).
- `readInstallationStamp(db)` returns `{ installationKind, watermark }` for exports and true-copy bundles;
  `assertGmpOrigin(stamp, what)` refuses anything not from a GMP installation (`EBMR-SBX-013`).
- `watermarkFor(subject)` where subject is `'GMP' | 'SANDBOX' | 'SANDBOX_TEST_RUN' | 'TRAINING' | 'SIMULATION' | 'ANALYTICS'`
  (null only for `GMP`); `stampText(text, w)`, `stampJson(value, w)`, `isStamped(text)`.
- `identifierProblem(installation, kind, value)`, `assertIdentifierAllowed(...)`, `isReservedTestIdentifier(value)`,
  `testIdentifier(kind, body)` (builds `TEST-<body>`), `RESERVED_PATTERNS`, `batchIssueProblem(installation, marketStates)`.
- `provisionSandboxDatabase({ adminUrl, database, sources })`, `upgradeSandboxDatabase(...)`,
  `sandboxDatabaseName(edition)`, `applyConnectPolicy(db)`, `segregationProblems(db)`.

SQL (granted to `ebmr_app`; mirrored to `ebmr_sandbox` in a sandbox):

- `kernel.installation_kind()`; `sandbox.assert_gmp_installation(action)` (`EBMR-SBX-010`);
  `sandbox.assert_sandbox_installation(action)` (`EBMR-SBX-011`); `sandbox.watermark()`.
- `sandbox.identifier_problem(kind, value)`, `sandbox.identifier_problem_for(installation, kind, value)`,
  `sandbox.assert_identifier_allowed(kind, value)`; trigger function `sandbox.guard_identifier(kind, column [, column ...])`.
- `sandbox.batch_issue_problem_for(installation, market_states)`, `sandbox.assert_batch_issue_allowed(market_states)`.
- `sandbox.segregation_problems()`, `sandbox.direct_privileges(role)`, `sandbox.mirror_differences()`, `sandbox.role_mirror_differences(role, roles[])` (0980).
- Superuser only: `sandbox.apply_connect_policy()` (connect policy, since kernel 0980 with the listener role of the
  database's kind, and, since kernel 0970, backend signals), `sandbox.mirror_application_privileges()` (since kernel
  0980 also `ebmr_sandbox_listener`).
- Owner only (called by database code): `kernel.backend_signals_restricted()`.

## How other modules use it

- **GMP-issuing paths** (release and market dispositions, real lot status and inventory, equipment status,
  true copies registered as GMP records, outbound messages to real ERP/LIMS/QMS): call
  `perform sandbox.assert_gmp_installation('<what>')` first. Sandbox-only features (test runs of
  unapproved versions, seeded review-by-exception challenges, training scenarios) call
  `sandbox.assert_sandbox_installation('<what>')`.
- **Tables holding identifiers**, in the owning module's migration:
  `create trigger zz_reserved_identifiers before insert or update on <table> for each row execute function sandbox.guard_identifier('BATCH_NUMBER', 'batch_number');`
  Kernel migrations below 0800 and the site-services and recipe-core migrations run on their own, so these
  triggers are added in an integration migration (list in section 6 of the design note).
- **Batch issue** (Phase 3): after the MBR life cycle's selection function, call
  `sandbox.assert_batch_issue_allowed(<market states of the pinned version>)` and check the batch number.
- **Renderers and exports:** `watermarkFor(stamp.installationKind)`, or `watermarkFor('SIMULATION')` for the
  designer's automated simulation, then `stampText` / `stampJson` (PDF and screen banners in Phase 3-4 use
  the same `Watermark`).
- **True copies:** include `await readInstallationStamp(client)` in the bundle manifest (inside the builder's
  snapshot transaction); an importer into GMP calls `assertGmpOrigin(manifest.installation, 'True-copy bundle')`.
- **Operations:** provision with `provisionSandboxDatabase`, upgrade only with `upgradeSandboxDatabase`
  (never plain `migrate`, which would not re-level the sandbox role). After a restore or a
  `CREATE DATABASE ... TEMPLATE`, run `select sandbox.apply_connect_policy()` as a superuser: database
  privileges are not copied, and only a superuser can take the backend signals away (run by the database owner,
  PostgreSQL only warns, and `kernel.backend_signals_restricted()` then answers false). Other login roles that must
  reach a GMP database (backup, monitoring) need an explicit `grant connect`; none may be a member of
  `pg_signal_backend`. Run `sandbox.segregation_problems()` with the other invariant queries.

## Error codes

`EBMR-SBX-001` no marker, `-002` marker is permanent, `-003` marker already set, `-004` marker and database
name disagree, `-005` bad provisioning setting, `-006` bad sandbox name, `-007` process connected to the
wrong kind, `-010` GMP-only action in a sandbox, `-011` sandbox-only action in GMP, `-012` batch source not
allowed, `-013` non-GMP origin, `-014` watermark misuse, `-020` unknown kind, `-021` reserved test
identifier in GMP, `-022` non-test identifier in the sandbox, `-023` misconfigured guard trigger, `-030`
mirror outside a sandbox, `-031`..`-034` provisioning (exists, missing, not a sandbox, segregation check failed), `-035`
backend signals still open to roles other than superusers after the policy was applied (kernel 0970), `-036` no room
in the cluster's connections for the listener's share (kernel 0980).
Messages give the reason first, then the control, then the code.

## Tests (`packages/kernel/test/sandbox/`)

`identifiers.test.ts` (rules, disjointness property, TypeScript and SQL agree on random input incl. NFKC
look-alikes), `watermark.test.ts`, `installation.test.ts` (GMP marker, identifier guard, connect policy,
copy under a sandbox name), `bypass.test.ts` (INV-18 bypass attempts through the sandbox role; DI-05 catalog
test), `provision.test.ts` (provisioning, upgrade re-levelling, no half-built sandbox, kind/name mismatch);
`test/security/listener-roles.test.ts` (the listener roles, their segregation and mirror, the application roles'
connection limits).
`helpers.ts#openSandbox` gives a test sandbox's pools; its `drop()` ends them with `endPool` (`test/harness/pools.ts`),
which waits until the socket of every connection has closed, before the forced drop (checked in
`test/harness/teardown.test.ts`).
