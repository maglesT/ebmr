# Testing and debugging

**Draft.** This page explains how this project is tested and how to find the cause when something fails: the test
layers and how to run each one, the CI jobs, mutation testing, how to write a test that proves a control, how to debug
a guard that refuses (or fails to refuse), and how to read a red CI run, with the real cases this project has had.
Read it before you write your first test. The database practice it builds on (migrations, guards, test databases,
clusters) is in [Database reference](05-database.md); the history of defects is in [Defects and lessons](08-defect-log.md).

Why so much testing: this is regulated software. A rule of Good Manufacturing Practice (GMP) that the software claims to
enforce must be shown to work, and the evidence is the tests. Every **control** (a rule in `compliance/controls/`, such
as [DI-22](../../compliance/controls/DI-22.yaml), audit trail content) needs a passing test that names it, or CI fails.
See the [glossary](02-glossary.md#control-id-families) for control IDs and
[invariants](02-glossary.md#invariants-inv-01-to-inv-48) (INV-xx: properties that must always hold).

## Where the code is

| What | Where |
|---|---|
| Vitest projects | [vitest.config.ts](../../vitest.config.ts) |
| Test databases for the `db` project | [packages/kernel/test/support/](../../packages/kernel/test/support/) |
| Server test harness | [apps/tablets-server/test/support/harness.ts](../../apps/tablets-server/test/support/harness.ts) |
| Shared test kit (templates, personas, keys, seeds) | [packages/test-kit/src/](../../packages/test-kit/src/) |
| Golden batches | [apps/tablets-server/test/golden/](../../apps/tablets-server/test/golden/) |
| Browser suite (Playwright) | [tools/e2e/](../../tools/e2e/) |
| Boundary and clock-ban tests | [tools/boundaries/test/](../../tools/boundaries/test/) |
| Control register and trace | [tools/register/src/](../../tools/register/src/), [compliance/controls/](../../compliance/controls/), [compliance/phase.yaml](../../compliance/phase.yaml) |
| Stryker (TypeScript mutation) | [stryker.config.mjs](../../stryker.config.mjs), [vitest.mutation.config.ts](../../vitest.mutation.config.ts) |
| SQL mutation harness | [tools/sql-mutation/](../../tools/sql-mutation/) |
| CI | [.github/workflows/ci.yml](../../.github/workflows/ci.yml), weekly mutation: [.github/workflows/mutation.yml](../../.github/workflows/mutation.yml) |
| Skills with the exact commands | [local-ci](../../.claude/skills/local-ci/SKILL.md), [mutation-check](../../.claude/skills/mutation-check/SKILL.md), [postgres-oracle](../../.claude/skills/postgres-oracle/SKILL.md) |

## The test layers

About 6,000 Vitest tests, 31 golden-batch tests and 42 browser tests passed in the last full Phase 4 run (PROGRESS.md).
They are arranged in layers. A rule is usually proved at the lowest layer that holds it (most rules: the database), and
again at the layer the user meets.

```mermaid
flowchart TB
  E2E["Browser suite (Playwright, tools/e2e)\nreal server, real browser, demo personas"]
  GOLD["Golden batches GB-T-01, GB-T-02, GB-T-03\nwhole batches over HTTP, database under the golden clock"]
  SRV["server project: apps/tablets-server/test\nroutes through app.inject + database guards as the app role"]
  DOM["dom project: ui-kit and tablets-web components\nhappy-dom, no database"]
  DB["db project: packages/*, tools/*, gateway, simulators\nSQL guards, kernel, recipe-core, site-services"]
  META["Tooling checks: boundaries, register and trace, [meta] tests"]
  E2E --> GOLD --> SRV --> DB
  SRV --> DOM
  DB --> META
```

### Vitest projects

[vitest.config.ts](../../vitest.config.ts) defines three projects:

| Project | Includes | Database | Global set-up |
|---|---|---|---|
| `db` | `packages/*/test`, `tools/*/test`, `apps/site-gateway/test`, `apps/simulators/test`, `apps/injectables-*/test` (not ui-kit) | one template per run, a copy per test file | [packages/kernel/test/support/global-setup.ts](../../packages/kernel/test/support/global-setup.ts) |
| `server` | `apps/tablets-server/test` | a GMP and a sandbox template, seeded with personas | [apps/tablets-server/test/support/global-setup.ts](../../apps/tablets-server/test/support/global-setup.ts) |
| `dom` | `packages/ui-kit/test`, `apps/tablets-web/test` (`.ts`, `.tsx`) | none; happy-dom | set-up file [setup-dom.ts](../../packages/ui-kit/test/setup-dom.ts) |

Default timeouts: 30 s per test, 60 s per hook. How the template databases are built, copied and dropped is in
[Database reference, Test databases](05-database.md#test-databases).

### SQL-level tests (`db` project)

These prove the rules the database holds. A test file gets its own copy of the template with
[createTestDatabase](../../packages/kernel/test/support/db.ts#sym=createTestDatabase): an `admin` pool (superuser, for
set-up and for "detected" attacks) and an `app` pool (the `ebmr_app` role, what the product uses). The important habit:
**attack through the application role.** ADR [0012](../adr/0012-privilege-separation-security-definer-transitions.md)
item 8 asks for a bypass test for every invariant: raw SQL as `ebmr_app` tries to break the rule and must be refused.

A real example from [audit-trail.test.ts](../../packages/kernel/test/audit/audit-trail.test.ts):

```ts
it('[INV-07] a GMP write without a declared actor is refused', async () => {
  await expect(db.app.query('insert into testgmp.sample (batch_id, value) values ($1, 1)', [randomUUID()]))
    .rejects.toThrow('EBMR-AUDIT-001');
});
```

Note what it checks: the exact code `EBMR-AUDIT-001`, not just "some error". Tests that accept any failure have been
green for the wrong reason ([defect log, tests that proved too little](08-defect-log.md#tests-that-proved-too-little-phase-2-exit-f13-to-f29-and-e2e-claims)).

Other kinds you will find in this project:

- **Review reproducers**: [packages/kernel/test/review/](../../packages/kernel/test/review/) holds one file per Phase 1
  exit finding (`f26.test.ts`, `f44.test.ts`, ...), each showing the defect is gone.
- **Mutation kill tests**: `packages/*/test/mutation/<group>.test.ts`, written to kill surviving mutants of a SQL
  mutation group; the harness picks them up by name.
- **Race tests**: two connections interleaved by hand (for example
  [db-guards-proposal-race.test.ts](../../apps/tablets-server/test/execution/db-guards-proposal-race.test.ts) for the
  signing and proposal race of P2-F37).
- **Property tests** with fast-check, for example the engine agreement test
  ([agreement.test.ts](../../packages/recipe-core/test/engine/agreement.test.ts)) and the retention rules.

### Server tests (`server` project)

These drive the real Fastify app through `app.inject` with the typed client of `@ebmr/api-contract`.
[startServer](../../apps/tablets-server/test/support/harness.ts#sym=startServer) copies the GMP or sandbox template,
builds the app and gives you a server; `server.asPersona('operator1')` opens a session as a seeded demo persona (with
its DEMO-ONLY credentials and terminal key from test-kit) and returns a client that carries the cookie:

```ts
const server = await startServer('SANDBOX');
const op = await server.asPersona('operator1');   // kiosk session on TEST-KIOSK-DISP-1
const res = await op.call(routes.session.get);
await server.close();
```

The server project also has **database guard files**, `db-guards*.test.ts` (46 of them). They prove that a rule holds
in the database even when the server is bypassed: an honest act the engine builds is stored, and the same act sent
through a tampered handler (a forged engine that skips a rule) is refused by the database alone. Example:
[blocks/ipc/db-guards.test.ts](../../apps/tablets-server/test/blocks/ipc/db-guards.test.ts).

### Component tests (`dom` project)

React components and hooks of [packages/ui-kit](../../packages/ui-kit/test/) and
[apps/tablets-web](../../apps/tablets-web/test/), rendered in happy-dom with Testing Library. No database and no
server: the API answers from fixtures (`createFixtureFetch` in
[fixture-fetch.ts](../../apps/tablets-web/src/api/fixture-fetch.ts)), and the badge tap and signing ceremony are fakes
(`fakeTap`, `fakeCeremony` in [floor/support.tsx](../../apps/tablets-web/test/floor/support.tsx)). They check what the
screen shows and what it sends, for example that a dialog never carries one person's words to the next person
([dialogs-start-empty.test.tsx](../../apps/tablets-web/test/floor/dialogs-start-empty.test.tsx)) or that an entry stays
NOT SAVED until the server answers for its idempotency key
([resend-not-settled.test.tsx](../../apps/tablets-web/test/floor/resend-not-settled.test.tsx)).

### Golden batches

A **golden batch** is a complete batch run end to end whose every output is known in advance. Three exist:

- **GB-T-01**: wet granulation, blisters, India. A happy variant and an exception-rich variant, then the release of
  two blister orders. [gb-t-01/README.md](../../apps/tablets-server/test/golden/gb-t-01/README.md).
- **GB-T-02**: direct compression, bottles, US added after vendor history INELIGIBLE.
  [gb-t-02/README.md](../../apps/tablets-server/test/golden/gb-t-02/README.md).
- **GB-T-03 "connected"**: GB-T-02's product at a site whose ERP/WMS, LMS, CMMS and serialisation L3/L4 systems feed
  the eBMR as mirrors, with an OPC UA press behind the site gateway; serialised for the US, released for India and the
  US, then a mock recall from its API lot. The simulators and the gateway run as their own processes.
  [gb-t-03/README.md](../../apps/tablets-server/test/golden/gb-t-03/README.md).

The driver acts over HTTP as the seeded personas. Each batch's outputs must equal `expected.json` exactly: the
quantities and yields of a hand-made worksheet (never changed to make a run pass), and the states, exceptions,
genealogy, signature count and the SHA-256 of the normalised **true copy** (the exported batch record) from the first
reviewed run.

A batch takes many hours of process time (blending, drying, holds). The golden PostgreSQL runs under the **golden clock
library**, so the test moves the database's clock instead of waiting
([Database reference, golden clock](05-database.md#the-golden-clock-for-the-golden-batches)). GB-T-01 freezes the clock and
ticks one second before each act, so every run gives the same times and the same hash. Without `EBMR_FAKETIME_FILE`
the golden tests do not run (`describe.runIf(goldenClockAvailable)`), so the ordinary suite skips them.

Run them on the `golden` cluster, one file at a time:

```bash
EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5435/postgres \
EBMR_FAKETIME_FILE=/var/lib/postgresql/faketime-golden/offset \
EBMR_GOLDEN_CLOCK_LIB=/usr/local/lib/ebmr/golden-clock.so \
pnpm vitest run apps/tablets-server/test/golden --no-file-parallelism
```

GB-T-03 runs only with `EBMR_GOLDEN_CLOCK_LIB` (the library its simulators and the gateway preload). GB-T-01 takes
about 15 to 20 minutes, GB-T-02 about 4, GB-T-03 about 6. Useful variables: `EBMR_GOLDEN_DUMP=<file>` writes the run's outputs for review;
`EBMR_GOLDEN_LATER_DAYS=<n>` starts the clock n days later, to show the hashes do not depend on the day (keep n under
about 45: the personas' passwords age out after 90 days, DI-19).

### Browser suite (Playwright)

[tools/e2e](../../tools/e2e/) runs the real stack (server, web app, a GMP and a sandbox database) in Chromium.
[global-setup.ts](../../tools/e2e/global-setup.ts) creates `ebmr_tablets_e2e_<hex>` and `ebmr_sandbox_tablets_e2e_<hex>`,
seeds one persona set per worker, builds the web app, starts the stack on free ports and drops everything at the end.
[playwright.config.ts](../../tools/e2e/playwright.config.ts): 2 workers; specs tagged `@office` (1440x900, one at a
time) or `@kiosk` (1280x800). Specs are in [tools/e2e/specs/](../../tools/e2e/specs/) by area (access, audit, esig,
floor, release, review, security, ...). Titles carry control IDs like any test:
`[DI-22][DI-23] GMP: who, when, why and what changed, and the chain verifies`.

Reports: `.reports/playwright.json` (read by the trace) and `.reports/e2e-evidence.json`, written by the
[evidence reporter](../../tools/e2e/reporters/evidence-reporter.ts): per test, its controls, its steps with expected
and actual results, and screenshots, for the validation pack. A step that measured nothing says "not checked", never
"as expected".

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers flock /tmp/ebmr-e2e.lock -c 'CI=true pnpm --filter @ebmr/e2e test'
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers flock /tmp/ebmr-e2e.lock -c 'CI=true pnpm --filter @ebmr/e2e test specs/<area>'
```

The lock stops two agents from starting two stacks at once. Never run `playwright install` on the pod; the browser is
already in `/opt/pw-browsers`. `pnpm e2e` is a shortcut with the same lock.

### Security sweeps (Phase 7 slice 7d)

[apps/tablets-server/test/security/](../../apps/tablets-server/test/security/) checks the whole route table at once,
from the contract (`allRoutes(routes)`), so a new route is covered the day it is added:

- [route-matrix.test.ts](../../apps/tablets-server/test/security/route-matrix.test.ts): every route without a session
  (401), and in a session of every role (one person per role: the seed's personas, the rest granted through the kernel's
  access workflow). The answers are compared with the reviewed matrix in
  [fixtures/route-role-matrix.json](../../apps/tablets-server/test/security/fixtures/route-role-matrix.json) (a cell per
  route and role: S done, A refused about the record, F refused for want of a right, ...). A change of rights fails the
  test until the matrix is written again with `EBMR_WRITE_MATRIX=1` and the diff is reviewed in the pull request.
- [route-fuzz.test.ts](../../apps/tablets-server/test/security/route-fuzz.test.ts): fast-check makes malformed requests
  for every route (and schema-valid ones by several seeds); no answer may be a 500 or show a stack, a path or a database
  message. `EBMR_FUZZ_RUNS` and `EBMR_FUZZ_SEED` widen or replay it.
- [samples.ts](../../apps/tablets-server/test/security/samples.ts) samples a valid input from each route's zod schema
  (through its JSON Schema, with fast-check for patterns), so requests reach the session and permission gates.
- [session-and-headers.test.ts](../../apps/tablets-server/test/security/session-and-headers.test.ts),
  [tls.test.ts](../../apps/tablets-server/test/security/tls.test.ts) and
  [production-baseline.test.ts](../../apps/tablets-server/test/security/production-baseline.test.ts): headers and the CSP
  on every page of the SPA, `__Host-` cookies, fixation, timeouts, rate limits, the adapters' TLS floor and the
  production start's TLS checks.

The checklist that names these tests item by item is [pentest-checklist.md](../security/pentest-checklist.md).

### Load, soak and the release drills (Phase 7 slice 7d)

- **Load and soak** ([tools/load](../../tools/load/)): a TypeScript driver of the reference site (D-P7-4) over the
  real HTTP API of a server process and the adapter feeds of the simulators. It builds its own database (LOAD-ONLY:
  DEMO-ONLY keys and personas), a year of generated history (batches planned and issued through the routes with the
  issuer's e-signature), one running batch per shop-floor session (each on its own kiosk and its own loopback address,
  so the per-terminal limits are real) and a review batch, then measures for the given minutes and writes a JSON
  record and a summary. It runs in Vitest with its own config (not part of `pnpm test`):
  `pnpm load smoke` (the cloud smoke), `pnpm load reference` and `pnpm load soak` (on the pod); options in
  [options.ts](../../tools/load/src/options.ts), the SLOs in [report.ts](../../tools/load/src/report.ts). The record
  is [load-and-soak.md](../validation/v1.0-rc/load-and-soak.md).
- **Release drills** ([tools/drills](../../tools/drills/)): the upgrade drill and migration dry run (a copy of a database
  at an earlier release, upgraded with this tree's migrations, every table's rows compared over the columns it had, the
  chains, renders and spot checks) and the restore drill with its record (the kernel drill, then the records rendered
  from the restored copy, the signed restore event, a batch exported and restored in an isolated process).
  [drills.test.ts](../../tools/drills/test/drills.test.ts) runs both on a database built from the Phase 6A exit's
  migrations ([release-6a-migrations.json](../../tools/drills/fixtures/release-6a-migrations.json)); the commands
  are in [the runbooks](10-runbooks.md#release-drills-load-and-security-verification-phase-7-slice-7d).

### The accessibility audit (Phase 7 slice 7d)

[accessibility.spec.ts](../../tools/e2e/specs/accessibility/accessibility.spec.ts) runs axe (WCAG 2.0 to 2.2, A and
AA rules) on every page of the SPA's route tree (read from the web features' route files, an example id in each
parameter), on the sandbox's pages and on the kiosk's floor screens; it measures every target on the floor screens
(44 x 44 CSS px), checks that every state chip has an icon and a word, and walks the office sign-in and a list with
the keyboard alone, the focus visible at each stop. A serious or critical axe finding fails it. Run it alone with
`flock /tmp/ebmr-e2e.lock pnpm --filter @ebmr/e2e exec playwright test -c playwright.config.ts specs/accessibility`.
What a script cannot judge (screen reader, zoom, reflow) is listed per criterion in
[accessibility-audit.md](../validation/accessibility-audit.md).

### Boundary tests

[tools/boundaries/test/](../../tools/boundaries/test/):

- [boundaries.test.ts](../../tools/boundaries/test/boundaries.test.ts) runs the rules of `.dependency-cruiser.cjs`
  against fixtures, so each rule is shown to catch what it should: apps never import each other, packages never import
  apps, `kernel` and `expr` import nothing internal, `recipe-core` imports only `kernel` and `expr`, product code never
  imports `tools/`. `pnpm deps:check` runs the same rules on the real code.
- [clock-ban.test.ts](../../tools/boundaries/test/clock-ban.test.ts) proves the lint rule that bans reading the process
  clock (`Date.now()`, `new Date()` without arguments and every other form) in domain code catches each form once.

### Register and trace: control IDs in test names

The **control register** is data: one YAML file per control in [compliance/controls/](../../compliance/controls/) (246
controls: DI, PR, IN, ST families). [compliance/phase.yaml](../../compliance/phase.yaml) says the current phase (4) and
the editions the gate covers (tablets). A control is **due** when its `target_phase` is at or before the current phase.
The tooling ([tools/register](../../tools/register/src/)) ties tests to controls:

- **Test names carry IDs in square brackets**: `it('[DI-22][INV-07] a GMP insert writes an audit event ...')`. Put
  every control and invariant the test proves. A test about the tooling itself is named `[meta]`, never with a control
  ID.
- **Each control lists its tests** in its YAML (`tests:`), as `<file> > <describe> > ... > <title>`, and maps its
  catalog test, clause by clause, to the tests that prove each clause (`clauses:`), or defers a clause to a later phase
  with a reason. See [DI-22.yaml](../../compliance/controls/DI-22.yaml).
- `pnpm register:validate` refuses a listed test that its file does not declare.
- `pnpm trace` reads `.reports/vitest.json` (written by `pnpm test:json`), the golden report and the Playwright report.
  It fails when a due control has no passing listed test, when a test cites an unknown control, when a clause has no
  passing test and no deferral, when a deferral's phase has started, when a listed test did not run (a skipped test
  proves nothing), and when a passing tagged test is not in its control's list.
- `pnpm register:sync-tests` adds the passing tagged tests a list lacks (run `pnpm test:json` first; for browser tests,
  the E2E run first).
- `pnpm pins:check` checks the exact `workspace:<version>` pins of internal packages.

Some folders also keep a README that names every test file of the folder, checked by a `[meta]` test (for example
[readme.test.ts](../../packages/recipe-core/test/execution/readme.test.ts) for the execution store's README). Adding a
test file there means adding it to the README.

## How to run each layer

PostgreSQL must be up: `pg_lsclusters`; `sudo pg_ctlcluster 16 main start` if it is stopped. Keep output short (the
`dot` reporter, `| tail -n 20`).

| What | Command |
|---|---|
| Everything CI runs, in one go | `pnpm run ci` (plain `pnpm ci` is a pnpm command, not ours) |
| Static checks | `pnpm typecheck`, `pnpm lint`, `pnpm deps:check`, `pnpm pins:check`, `pnpm register:validate`, `pnpm build:web` |
| All Vitest tests | `pnpm test`, or `pnpm test:json` to write `.reports/vitest.json` for the trace |
| One project, one folder | `pnpm vitest run --project server apps/tablets-server/test/session` |
| SQL tests of one package | `pnpm vitest run --project db packages/kernel/test/audit` |
| Component tests | `pnpm vitest run --project dom` |
| One test by name | `pnpm vitest run <file> -t "DI-22"` |
| A module's migrations only (fast, while developing) | `EBMR_MIGRATIONS='^0(0|1)' pnpm vitest run --project db packages/kernel/test/<area>` |
| On a spare cluster, in parallel with another run | `EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5433/postgres pnpm vitest run <paths>` |
| Golden batches | see [Golden batches](#golden-batches) |
| Browser suite | see [Browser suite](#browser-suite-playwright) |
| Trace | `pnpm trace` after `pnpm test:json` |
| Handbook links and generated pages | `pnpm handbook:check` |

On a 4-CPU pod, run only the directories you changed; the whole suite takes long and competes with other agents. Do
not edit files while CI runs locally: it reads them at different moments, and a half-written file gives false errors.

## The CI jobs

[.github/workflows/ci.yml](../../.github/workflows/ci.yml) runs on every push:

| Job | What it does | Limit |
|---|---|---|
| `checks` | typecheck, lint, `deps:check`, `pins:check`, `register:validate`, web build | 20 min |
| `tests` (4 shards) | `pnpm vitest run --shard=i/4` with blob reports, each shard with its own PostgreSQL 16 on 5432. The suite took 55 minutes on one 2-core runner at the end of Phase 2, so it was split. | 45 min |
| `golden` | a PostgreSQL 16 cluster under the golden clock library (built in the job) on 5433; `pnpm vitest run apps/tablets-server/test/golden --no-file-parallelism` with a JSON report | 45 min |
| `report` | needs `checks`, `tests`, `golden`. Merges the shard blobs into `.reports/vitest.json`, prints a failed-test summary, then `pnpm trace --require-golden` and `pnpm openapi`. Runs even when a shard failed, so you see the summary. | |
| `e2e` | Playwright in Chromium (`pnpm --filter @ebmr/e2e test`); uploads reports, evidence and traces | 45 min |
| `traceability` | needs `checks`, `report`, `e2e`. `pnpm trace:e2e`: the trace with the Vitest, golden and Playwright reports all required | |

The weekly [mutation.yml](../../.github/workflows/mutation.yml) (Sundays) runs Stryker (`pnpm mutation:ts`) and one job
per SQL mutation group (`pnpm mutation:sql --group <g> --workers 2 --own-cluster`).

## Mutation testing

A test suite can be green and still miss a bug. **Mutation testing** changes the code on purpose, one small change
(a **mutant**) at a time, and runs the tests. If a test fails, the mutant is **killed**: the tests notice that line.
If all tests pass, it **survived**: no test checks that line, or the change makes no difference (an **equivalent**
mutant). Targets (build outline 9.1): at least 90 % on guards, signature invalidation, limits, rounding, flow validation
and release gating; 80 % elsewhere. Decision 0008 places validation-grade mutation work at deployment; during the build
it runs on changed guard code (skill `mutation-check`).

### TypeScript: Stryker

[stryker.config.mjs](../../stryker.config.mjs) mutates the kernel's pure TypeScript logic (market resolution, retention
rules, true copy, time, canonical signing text, ...) with the tests of
[vitest.mutation.config.ts](../../vitest.mutation.config.ts) (one node project with the kernel template; `ignoreStatic`
on). The full run (`pnpm mutation:ts`) takes hours. For a change, run Stryker on the changed line ranges only, with two
temporary configs that are never committed; the [mutation-check skill](../../.claude/skills/mutation-check/SKILL.md)
gives them.

### SQL: the mutation harness

[tools/sql-mutation](../../tools/sql-mutation/) mutates database functions (operators, groups and how a mutant runs:
[Database reference, SQL mutation harness](05-database.md#the-sql-mutation-harness)).

```bash
pnpm mutation:sql --count                              # mutants per group, no database
pnpm mutation:sql --group audit-trail --workers 3      # one group
EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5434/postgres pnpm mutation:sql --group <g> --own-cluster
```

Results land in `.reports/sql-mutation/report.json` and `summary.md` (`--out <dir>` to change). `--own-cluster` lets
the harness drop leftovers, so use it only on a cluster that is the run's alone.

For each survivor: write a test that kills it (in `packages/<pkg>/test/mutation/<group>.test.ts`, named with control
IDs), or record it in [equivalent.json](../../tools/sql-mutation/equivalent.json) with the reasoning (which line, why
no input can tell the difference). Never delete or loosen a test or narrow the mutated range to raise a score. A new
guard function goes into a group in [targets.ts](../../tools/sql-mutation/src/targets.ts) in the same change.

### Results so far

[docs/build-plan/phase-4/mutation-results.md](../build-plan/phase-4/mutation-results.md) holds the Phase 4 focused run
(decision 0012): scope C groups all at 100 % after the re-run; scopes A and B have survivors aimed at by new tests and
not yet re-confirmed, deferred to deployment validation. Real defects the mutation runs found: G6.VALIDATION_BASIS
(recipe-core 0932), the export permission reason text (site services 0903), and the D-series of Phase 2
([defect log](08-defect-log.md#d-series-sql-mutation-guards-that-could-not-fire)).

## How to write a test that proves a control

1. **Read the control's YAML**: `behaviour`, `catalog_test` and `clauses`. The test must show the behaviour the clause
   describes, not something near it.
2. **Prove it where it is enforced.** If the database holds the rule, test it as the application role (`db.app` in the
   `db` project, or a `db-guards` file in the `server` project). Add a server or browser test for what the user sees.
3. **Assert the exact refusal**: the `EBMR-...` code, and that nothing was written (no row, no audit event). Then
   assert the allowed case too, so the test cannot pass by refusing everything.
4. **Name it with every ID it proves**: `it('[DI-22][DI-24] a change after first entry needs a reason and records old
   and new values', ...)`. Add `[INV-xx]` for invariants.
5. **Show it can fail.** Remove or break the guard for a moment (or run the mutation harness on its function) and see
   the test go red. Many Phase 2 tests looked right but passed for the wrong reason: a refusal checked as "some failure",
   a rule reached only through a TypeScript pre-check, a rule shown through another rule that fires first, made-up ids
   that never reach the branch ([defect log](08-defect-log.md#tests-that-proved-too-little-phase-2-exit-f13-to-f29-and-e2e-claims)).
6. **Concurrency**: if the rule must hold under concurrent requests, write the race with two connections and interleave
   them by hand; do not rely on timing.
7. **Register it**: `pnpm test:json`, then `pnpm register:sync-tests` adds the test to the control's `tests:` list; map
   it to its clause in `clauses:` by hand. Run `pnpm register:validate` and `pnpm trace`.
8. If the folder's README lists its test files, add yours.

Never weaken a control in `compliance/controls/` to make a test pass. If a control seems wrong, write it up for the owner.

## How to debug a failing guard

"A guard fails" means either it refuses something it should allow, or a test shows it allows something it should
refuse. Step by step:

1. **Get the code.** The refusal envelope (or the test's error) carries the `EBMR-<AREA>-<NNN>` code and the
   correlation id. A 500 INTERNAL has no code: look in the server log for the correlation id; the stack and the
   PostgreSQL error are there.
2. **Find the raising function.**

   ```bash
   grep -rn "EBMR-ESIG-015" packages/*/sql apps/*/sql
   ```

   or look it up in [Error codes](reference/error-codes.md). If the code is not in SQL, search the TypeScript
   (`packages/*/src`, `apps/*/src`); some codes come from the server's own checks.
3. **Check the version in force.** The same function may be defined in several migrations; only the last in run order
   counts ([Database reference](05-database.md#create-or-replace-finding-the-version-in-force)). Read that version and its
   migration header, which says why the rule exists and what earlier versions got wrong.
4. **Find the callers**: the trigger that runs it, the function that calls it, or the state engine
   (`platform.register_guard`). Note the locks it takes and the isolation level it expects
   ([Database reference, How to read a guard](05-database.md#how-to-read-a-guard)).
5. **Reproduce it alone on a spare cluster**, so your run does not compete with others:

   ```bash
   EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5433/postgres \
     pnpm vitest run <the test file> -t "<part of the title>"
   ```

   A failure that shows only under load is a race; reproduce it with the same load (skill `local-ci`), not with a retry.
6. **Look inside with psql.** For a database you can keep, build one with the set-up CLI on the spare cluster (DEMO-ONLY
   seeds, never for production), then connect:

   ```bash
   EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5433/postgres \
     node --import tsx apps/tablets-server/src/cli/setup.ts --installation GMP --database ebmr_debug_tablets_demo \
     --keys-dir <scratch>/keys --exchange-dir <scratch>/exchange
   psql postgres://ebmr_dev:ebmr_dev@localhost:5433/ebmr_debug_tablets_demo
   ```

   In psql, `\sf <function>` prints the version in force; `set role ebmr_app;` lets you try a statement with the
   application's rights. Any GMP write needs a validated actor context (`kernel.begin_command`) with real ids, so for
   writes it is usually quicker to write a scratch test with the test helpers than to build a context by hand. For a
   question about PostgreSQL itself (a lock order, a time zone), use a scratch database (skill `postgres-oracle`). Drop
   your debug database afterwards; never touch the demo databases or another run's cluster.
7. **Read the audit trail.** Committed acts before the refusal are in `kernel.audit_event`. Find them by correlation id
   (the server uses the request id as the command's correlation id) or by record:

   ```sql
   select chain_key, seq, action, table_name, record_id, recorded_at, payload -> 'actor' ->> 'legal_name' as who
   from kernel.audit_event where correlation_id = '<uuid>' order by id;
   select * from kernel.verify_chain('<chain key>');   -- no rows: the chain is intact
   ```

   The refused command itself left nothing: its transaction rolled back. Some refusals are recorded on purpose in
   their own command (signing failures, gateway refusals); the module guides say which.
8. **Fix it the project's way**: reproduce first, then the database guard, in a **new migration** (skill
   `fix-finding`); a test named with the control IDs that fails before the fix; the defect log updated.

## CI failure diagnosis: real cases

General rules (skill `local-ci`): find the root cause. "Flaky" is not a root cause: a test that fails under load is
racing something. Reproduce a CI-only failure locally with the same heap and `CI=true` before changing code. Never
skip, disable or loosen a test, and never lower a threshold, to get green.

### Lint ran out of memory

- **Symptom:** `pnpm lint` crashed with a JavaScript heap out-of-memory error, on the runner or locally inside
  `pnpm run ci`.
- **Cause:** typed linting keeps the root, ui-kit, web and E2E TypeScript programs in memory together (about 2.2 GB in
  Phase 2), more than node's default heap.
- **Fix:** the lint script sets the heap itself, first 4 GB (commit 2cdde1ac), then 8 GB when the codebase grew
  (commit d158c601, `node --max-old-space-size=8192` in [package.json](../../package.json)). Locally, the chained
  `pnpm run ci` can still hit the limit: run `pnpm lint` on its own and the rest of the chain separately (PROGRESS.md).

### CI-only: the server did not answer on localhost

- **Symptom:** the health check timed out on GitHub but passed locally.
- **Cause:** the server listened on `localhost` through a custom server factory, and Fastify then skips its extra
  bindings; on the runners `localhost` resolves to `::1` first, so `127.0.0.1` never answered.
- **Fix:** commit 2cdde1ac; the test resolves `localhost` to 127.0.0.2 first and fails on the old code
  ([defect log, CI](08-defect-log.md#ci)).

### Failures that looked flaky and were real races

From the [defect log's flakiness table](08-defect-log.md#test-flakiness-and-races):

- **Teardown errors (FATAL 57P01).** `pg-pool`'s `end()` returns before the sockets close, so the forced drop of the
  test database killed backends still closing. Fixed in test-kit: pools are opened with `openPool` and ended with
  `endPool`, which waits for every socket.
- **The gateway reported `uplinked:false` once under load.** The upload pass waited for a slow disk write (open, fsync,
  rename) before telling its waiters, racing a 5 s limit. A real race in the gateway, not in the test: waiters are now
  told first.
- **Signing during a proposal (P2-F37).** Under REPEATABLE READ a signing waited for a change and then signed the old
  content. A real product defect, found by a reviewer, not by chance; now refused in any isolation level but READ
  COMMITTED ([Database reference, Locks and isolation](05-database.md#locks-and-isolation)).
- **Browser specs failed in parallel.** Specs shared one device rate limit per terminal, and review and release specs
  acted on the same demo batch. Specs now use separate office terminals and office specs run one at a time; the rate
  limit itself was not raised.
- **Still open:** `db-guards-free-text-shown` failed once under load and passed alone; the root cause is not found yet.

The lesson: a retry is not a fix. Two of these were in the product.

### A test that could not fail in CI

The listener share test read only what the global set-up had declared before it (a share of 40), so it would pass even
if the migration no longer set the share. It now has two checks that fail without the migration. If a test passes on a
fresh CI cluster for a reason other than the code under test, it proves nothing.

### Golden hashes changed

- **By the day of the run (PR #19, 12 October 2026).** The GB-T-01 true-copy hash changed from one day to the next:
  seeded lot dates were normalised as run instants, and a deviation number held the year. Fix in test code only: lot
  dates stay as seeded, the year is a placeholder; hashes re-recorded and shown equal on runs started on different days
  (`EBMR_GOLDEN_LATER_DAYS`).
- **By a new act in the driver (Phase 4 slice 1).** A second person now verifies typed container nets and a second QA
  person concludes the deviation. The extra one-second ticks moved some instants across a minute boundary. The hashes
  were re-recorded, and the README records exactly what changed (instants one minute later; no key added or removed;
  signature counts 131 and 136 unchanged).

The rule for a golden hash change: find out exactly which values changed and why (`EBMR_GOLDEN_DUMP`), write it in
the batch's README, and re-record only when the change is understood and intended. The worksheet's quantities and
yields are never changed to make a run pass.

### `[meta]` failures after merging mutation scopes

After merging the three Phase 4 mutation scopes, the final run had 2 `[meta]` failures (PROGRESS.md):

- **A function in two SQL mutation groups.** [harness.test.ts](../../tools/sql-mutation/test/harness.test.ts) requires
  each target function to be in one group only (its mutants would be run and counted twice). Fixed by keeping one group
  per function (commit 79a0e582).
- **41 tagged tests not in their controls' lists.** The new kill tests carried control IDs, but the controls' `tests:`
  lists did not name them; [listed-tests-and-clauses.test.ts](../../tools/register/test/listed-tests-and-clauses.test.ts)
  and the trace refuse that. Fixed with `pnpm register:sync-tests`.

After any merge that brings in tests, run `pnpm test:json`, `pnpm register:sync-tests` and `pnpm trace`.

### Two branches, one migration number

Two branches picked the same migration number; one was renumbered before the merge (commits 5685be5b, 0b4de0b7,
27b1efe2). A migration's file name is part of its identity in `schema_migration`, so renumber before the file runs
anywhere shared, never after.

### Timeouts

The E2E job limit was raised to 45 minutes when the set-up started building the release path through real signed acts.
The golden job runs one file at a time; GB-T-01 takes about 20 minutes. A single test over 30 minutes is not allowed
([defect log, CI](08-defect-log.md#ci)).

## Related pages

- [Database reference](05-database.md): migrations, guards, locks, test databases, clusters, the SQL mutation harness.
- [Defects and lessons](08-defect-log.md): every case above, with the guarding tests.
- [Architecture](03-architecture.md): the packages and the request path the tests drive.
- [How to add a feature safely](07-adding-a-feature.md): the worked example, tests included.
- [Control-to-code map](reference/control-map.md) (generated): each control with its code and tests.
