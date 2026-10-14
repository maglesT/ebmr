# Operations runbooks

**Draft.**

Short, step-by-step procedures for the jobs a developer does on a development machine: setting it up, running the
demo, running CI, the browser suite, the golden batches and mutation runs, and getting out of the failures that happen
most often. The last section lists what the product itself offers for backup, restore and continuity, and where its
operating procedures are. Each runbook links to the page that explains the background; read those once, then use this
page as a checklist.

## Where the code is

| What | Where |
|---|---|
| Machine set-up | [tools/dev-env/runpod-setup.sh](../../tools/dev-env/runpod-setup.sh) |
| Demo | [tools/demo/src/cli.ts](../../tools/demo/src/cli.ts), [paths.ts](../../tools/demo/src/paths.ts), [docs/demo/phase-2-first-clickable.md](../demo/phase-2-first-clickable.md) |
| Scripts | [package.json](../../package.json) (`ci`, `demo`, `e2e`, `handbook`, `mutation:*`, `register:*`) |
| CI as GitHub runs it | [.github/workflows/ci.yml](../../.github/workflows/ci.yml), skill [local-ci](../../.claude/skills/local-ci/SKILL.md) |
| Mutation runs | [.github/workflows/mutation.yml](../../.github/workflows/mutation.yml), skill [mutation-check](../../.claude/skills/mutation-check/SKILL.md), [tools/sql-mutation](../../tools/sql-mutation/) |
| Browser suite | [tools/e2e](../../tools/e2e/) ([playwright.config.ts](../../tools/e2e/playwright.config.ts), [global-setup.ts](../../tools/e2e/global-setup.ts)) |
| Backup and restore in the product | [packages/kernel/src/continuity](../../packages/kernel/src/continuity/README.md), [ops/backup](../../ops/backup/), [docs/operations](../operations/) |

Background pages: [Database reference, Test databases](05-database.md#test-databases) and
[The clusters](05-database.md#the-clusters); [Testing and debugging, How to run each layer](06-testing-and-debugging.md#how-to-run-each-layer)
and [CI failure diagnosis](06-testing-and-debugging.md#ci-failure-diagnosis-real-cases).

## 1. Set up a machine

The development pods run Ubuntu 22.04 as root, without systemd. **The pod's disk is erased when it stops**, so set it
up after every start, and commit and push your work often.

```bash
cd /workspace/ebmr
bash tools/dev-env/runpod-setup.sh               # everything
SKIP_BROWSER=1 bash tools/dev-env/runpod-setup.sh   # without Playwright's Chromium
```

The script is safe to run again: every step checks what is already there. It installs:

- Node 22 and pnpm at the version in `packageManager` of [package.json](../../package.json) (through corepack);
- PostgreSQL 16 from the PostgreSQL apt repository, with four clusters (below), each with the superuser role
  `ebmr_dev` (password `ebmr_dev`) and locale `C.UTF-8`;
- `libfaketime`, and the `golden` cluster preloaded with it;
- the dependencies (`pnpm install --frozen-lockfile`);
- Playwright's Chromium in `/opt/pw-browsers`, and `PLAYWRIGHT_BROWSERS_PATH` in `/root/.bashrc`.

The four clusters:

| Cluster | Port | Use |
|---|---|---|
| `main` | 5432 | the default `EBMR_PG_ADMIN_URL`; everyday tests and the demo databases |
| `ci` | 5433 | spare: a second test run, or a mutation run, in parallel |
| `ci2` | 5434 | spare, as above |
| `golden` | 5435 | runs under libfaketime; golden batches only (CI's golden job uses 5433 on its own runner) |

Check:

```bash
pg_lsclusters          # all four "online"
node -v && pnpm -v     # v22.x and the pinned pnpm
```

### After a pod restart

- **Disk erased** (the pod stopped and started again): run the set-up script again, then `git fetch` and check out your
  branch. Anything not pushed is gone.
- **Disk kept, processes gone** (the container restarted): the clusters come up **stopped**. Start them:

  ```bash
  pg_lsclusters
  for c in main ci ci2 golden; do pg_ctlcluster 16 "$c" start; done   # prefix with sudo when not root
  ```

  Running the set-up script again does the same and also repairs anything missing.
- `pnpm install` again after switching to a branch whose lockfile differs.

### Known environment difference: time zone names

On Ubuntu 22.04 the system time-zone data also holds the `posix/` copy of every zone, so PostgreSQL lists 1,198 names
in `pg_timezone_names` here against about 600 on the GitHub Ubuntu 24.04 runner. The test "[DI-27] over every zone name
the database knows, iam.is_valid_site_zone is the site rule ..." in
[site-zone-policy.test.ts](../../packages/kernel/test/identity/site-zone-policy.test.ts) walks every name, so here it
takes about 65 s and times out at the 30 s test limit; on CI it passes in under 17 s. This is an environment
difference, not a defect: do not raise its timeout or change the test. To check it locally, run that file alone with a
longer limit on the command line (`--testTimeout=120000`), and rely on CI for the verdict.

## 2. Run the demo

The demo runs the whole Tablets stack on your machine with DEMO-ONLY keys and personas. The walkthrough for a person
giving the demo is [docs/demo/phase-2-first-clickable.md](../demo/phase-2-first-clickable.md) (credential card,
the scripted path, "If something goes wrong").

```bash
pnpm demo:setup   # create the two demo databases, DEMO-ONLY keys and personas; build the web app
pnpm demo         # start every server; prints the addresses and the credential card
pnpm dev          # the same servers without the built web app, plus Vite with hot reload
```

What each command does ([cli.ts](../../tools/demo/src/cli.ts)):

| Command | Effect |
|---|---|
| `pnpm demo:setup` | Drops and re-creates `ebmr_tablets_demo` (GMP) and `ebmr_sandbox_tablets_demo` (sandbox) on the `main` cluster, writes fresh keys to `var/demo/keys` (git-ignored), seeds one persona set, builds the web app. Safe to re-run; it wipes the demo data. |
| `pnpm demo` | Starts the GMP server on :3001, the sandbox server on :3011 (gateway listener :3012), the site gateway on :3021, the scale simulator (TCP :4001, console :4002) and the demo devices (press, coater, printer, bottle line, cartoner on ports 4011 to 4052). Builds the web app first if it is missing. Ctrl+C stops everything. |
| `pnpm dev` | As `pnpm demo`, plus Vite dev servers on :5173 (GMP) and :5174 (sandbox). |

Common problems:

- "the demo is not set up": run `pnpm demo:setup`.
- A port is busy: another demo or an E2E stack is still running. Stop it (Ctrl+C) and start again; `lsof -i :3001`
  shows who holds a port.
- After a new `pnpm demo:setup` the browser says the terminal cannot prove which device it is: the keys changed. Clear
  the site data for `localhost:3001` and `localhost:3011` and pick the terminal again.
- Never drop the demo databases from a test or a clean-up script; `pnpm demo:setup` is the only way to reset them.

### The ERP and WMS simulators (Phase 6 slice 6a)

Two long-running processes, DEMO-ONLY, loopback by default:

```bash
EBMR_SIM_HTTP=127.0.0.1:4310 node --import tsx apps/simulators/src/erp/serve.ts   # ERP feed and outbound, /erp/v1
EBMR_SIM_HTTP=127.0.0.1:4320 node --import tsx apps/simulators/src/wms/main.ts    # WMS feed and move questions, /wms/v1
```

- Publish data: POST a contract body to `/erp/v1/production-orders`, `/materials`, `/products`, `/shipments` or
  `/wms/v1/goods-receipts`, `/stock-moves`, `/lot-statuses`; ask a move with `/wms/v1/move-requests`.
- Inject a fault: the console at `http://127.0.0.1:4310/` has a button per fault, or
  `curl -X POST localhost:4310/api/fault -d '{"fault":"LINK_CUT","on":true}'` (FEED_GAP, STALE_VALUE, MALFORMED,
  DUPLICATE, OUT_OF_ORDER, WRONG_BATCH, LINK_CUT, SLOW with `slowMs`, STALE_MIRROR). `GET /api/state` shows the model.
- Connect the server: register an INTEGRATION account in role ERP_WMS_INTERFACE on its SERVER terminal as an ERP_WMS
  adapter (`iam.register_integration_adapter`), and give its entry in the service-keys file (`EBMR_SERVICE_KEYS_FILE`)
  the terminal `SRV-ERP-ADAPTER-01` or `SRV-WMS-ADAPTER-01` and an `endpoint` (`http://127.0.0.1:4310/erp/v1`). The
  server starts the worker at start-up; the integration health page (`/integrations`) shows its messages and alarms.

## 3. Run CI locally

Before every push ([CLAUDE.md](../../CLAUDE.md)). The skill [local-ci](../../.claude/skills/local-ci/SKILL.md) is the
full procedure.

```bash
NODE_OPTIONS=--max-old-space-size=2048 pnpm run ci
```

`pnpm run ci` (not `pnpm ci`, which is a pnpm command) runs typecheck, lint, dependency boundaries, exact pins, the
control register, the web build, all Vitest tests with a JSON report, and the trace. GitHub runs the same in a static
job plus four test shards ([The CI jobs](06-testing-and-debugging.md#the-ci-jobs)).

- Do not edit files while it runs: it reads them at different moments, and a half-written file gives false errors.
- On a pod shared with other agents, prefer running only the directories you changed
  (`pnpm vitest run --project server apps/tablets-server/test/<area> --reporter=dot`) and let GitHub run the whole
  suite.
- Keep output short: `--reporter=dot`, `| tail -n 20`.

## 4. Run the browser suite (E2E)

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers flock /tmp/ebmr-e2e.lock -c 'CI=true pnpm --filter @ebmr/e2e test'
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers flock /tmp/ebmr-e2e.lock -c 'CI=true pnpm --filter @ebmr/e2e test specs/<area>'
```

`pnpm e2e` is a shortcut with the same lock. The global set-up creates `ebmr_tablets_e2e_<hex>` and
`ebmr_sandbox_tablets_e2e_<hex>`, builds the web app, starts the stack on free ports and drops it all at the end. The
lock makes a second run wait instead of starting a second stack. Never run `playwright install` on the pod; the browser
is in `/opt/pw-browsers`. Reports: `.reports/playwright.json` (read by the trace and by `pnpm register:sync-tests`) and
`.reports/e2e-evidence.json`. Details: [Browser suite](06-testing-and-debugging.md#browser-suite-playwright).

## 5. Run the golden batches

The golden batches GB-T-01 and GB-T-02 must give their expected outputs exactly
([Golden batches](06-testing-and-debugging.md#golden-batches)). They need the database clock under libfaketime, so they
run on the `golden` cluster only, one file at a time:

```bash
EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5435/postgres \
EBMR_FAKETIME_FILE=/var/lib/postgresql/faketime-golden/offset \
pnpm vitest run apps/tablets-server/test/golden --no-file-parallelism
```

- Without `EBMR_FAKETIME_FILE` the golden tests are skipped, not failed; check the summary says they ran.
- GB-T-01 takes about 20 minutes. Run one golden suite at a time: both files move the same clock.
- `EBMR_GOLDEN_DUMP=<file>` writes the run's outputs for review; `EBMR_GOLDEN_LATER_DAYS=<n>` (n under about 45) starts
  the clock later, to show the hashes do not depend on the day.
- If the offset file is missing or not writable (`ls -l /var/lib/postgresql/faketime-golden/offset`), run the set-up
  script again; it writes `+0s` and makes the file writable.
- Never change `expected.json` to make a run pass. A changed hash needs a reason and a review
  ([Golden hashes changed](06-testing-and-debugging.md#golden-hashes-changed)).

## 6. Run a mutation check

Decision [0008](../decisions/0008-faster-delivery-testing-cadence-and-depth.md) moved the mutation targets to the
deployment validation; during the build a mutation run is done where a change touches a high-risk guard and the run is
cheap, and at the points the owner set (decisions [0009](../decisions/0009-phase-3-exit-mutation-and-full-testing.md),
[0012](../decisions/0012-phase-4-focused-mutation.md)). The skill
[mutation-check](../../.claude/skills/mutation-check/SKILL.md) is the procedure; background in
[Mutation testing](06-testing-and-debugging.md#mutation-testing).

```bash
# SQL: the database functions of one group (groups in tools/sql-mutation/src/targets.ts)
pnpm mutation:sql --count
EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5433/postgres pnpm mutation:sql --group <name> --workers 3

# TypeScript: Stryker on the changed lines only, with temporary configs (see the skill); never the full run casually
pnpm exec stryker run stryker.focus.tmp.config.mjs
```

Run mutation on a spare cluster (5433 or 5434) so CI and other agents keep `main`. SQL results land in
`.reports/sql-mutation/` (`report.json`, `summary.md`). An equivalent mutant is recorded, with its reasoning, in
[tools/sql-mutation/equivalent.json](../../tools/sql-mutation/equivalent.json). Delete the temporary Stryker configs
afterwards; never commit them.

## 7. Recover from common failures

First rule (skill [local-ci](../../.claude/skills/local-ci/SKILL.md)): find the root cause. "Flaky" is not a cause.
Never skip, disable or loosen a test, and never lower a threshold, to get green. Ask before stopping a cluster or
dropping a database you did not create.

### A cluster is stopped

- **Symptom:** `ECONNREFUSED 127.0.0.1:5432` (or 5433 to 5435) in every database test, or `pg_isready` fails.
- **Cause:** the container restarted; the clusters do not start by themselves.
- **Fix:** `pg_lsclusters`, then `pg_ctlcluster 16 <name> start` for each one shown as `down`. If a cluster is missing,
  run [runpod-setup.sh](../../tools/dev-env/runpod-setup.sh). The server log is in
  `/var/log/postgresql/postgresql-16-<name>.log`.

### Lint runs out of memory

- **Symptom:** `JavaScript heap out of memory` during `pnpm lint`, usually inside the chained `pnpm run ci`.
- **Cause:** typed linting keeps four TypeScript programs in memory together. The `lint` script sets an 8 GB heap
  itself ([package.json](../../package.json)), but the whole chain can still hit the limit on a busy pod.
- **Fix:** run `pnpm lint` on its own, then the rest of the chain (`pnpm typecheck && pnpm deps:check && pnpm pins:check
  && pnpm register:validate && pnpm build:web && pnpm test:json && pnpm trace`). Background:
  [Lint ran out of memory](06-testing-and-debugging.md#lint-ran-out-of-memory).

### Leftover test databases

- **Symptom:** the cluster's disk fills, or `pg_database` lists many `ebmr_t_*`, `ebmr_tpl*`, `ebmr_stpl*`,
  `ebmr_sandbox_t*`, `ebmr_mut_*` or `ebmr_*_e2e_*` databases after cancelled runs.
- **Cause:** a cancelled test file or run cannot drop its copy or template
  ([Test databases](05-database.md#test-databases)).
- **Fix:** on your own spare cluster, when no run is using it, list the leftovers that have no connection, check the
  list, then drop them one by one:

  ```bash
  URL=postgres://ebmr_dev:ebmr_dev@localhost:5433/postgres
  psql "$URL" -Atc "select d.datname from pg_database d
                    where d.datname like 'ebmr\_%' and d.datname not like 'ebmr\_%demo'
                      and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)"
  psql "$URL" -c 'drop database "<name>" with (force)'
  ```

  Never drop the demo databases (`ebmr_tablets_demo`, `ebmr_sandbox_tablets_demo`), and never drop on a cluster another
  agent's run is using: a database with no connection at this instant may still be a template another run is about to
  copy.

### The E2E run waits forever (stale lock)

- **Symptom:** `flock /tmp/ebmr-e2e.lock ...` never starts.
- **Cause:** `flock` holds the lock only while its process lives, so the lock file left on disk is harmless; a wait
  means a process still holds it: another agent's E2E run, or an orphaned run of yours (a terminal that was closed).
- **Fix:** see who holds it: `lsof /tmp/ebmr-e2e.lock`. If it is another agent's run, wait. If it is your own orphaned
  run, stop that process (and its server children, `pgrep -af tablets-server`), then start again. Do not delete the
  lock file while a run holds it: the next run would take a new lock and start a second stack on top of the first.

### Tests time out under load

- **Symptom:** `Test timed out in 30000ms` or `Hook timed out in 60000ms` ([vitest.config.ts](../../vitest.config.ts)),
  in tests that pass when run alone.
- **Cause:** the pod is shared; several agents or a mutation run compete for CPU and the same cluster. Sometimes it is
  a real race that load only exposes ([Failures that looked flaky and were real races](06-testing-and-debugging.md#failures-that-looked-flaky-and-were-real-races)).
- **Fix:** run the file alone (`pnpm vitest run <file>`); run on a spare cluster (`EBMR_PG_ADMIN_URL=...:5433/...`);
  lower parallelism (`--maxWorkers=2`). If it still times out alone, treat it as a defect and find the race. Do not raise
  a timeout in the code to get green. The DI-27 zone test above is the known exception caused by this OS.

### "too many connections for role"

- **Symptom:** `FATAL: too many connections for role "ebmr_app"` (or `"ebmr_sandbox"`, `"ebmr_listener"`), SQLSTATE
  53300.
- **Cause:** database roles belong to the whole cluster, not to one database. Kernel
  [0980_listener_login_roles.sql](../../packages/kernel/sql/0980_listener_login_roles.sql)
  ([kernel.apply_listener_share](../../packages/kernel/sql/0980_listener_login_roles.sql#sym=kernel.apply_listener_share))
  gives each application role a `CONNECTION LIMIT` of the cluster's ordinary slots less the gateway listener's share,
  and each listener role the share itself (8 by default; the server tests declare 40). Many test runs on one cluster,
  or connections a cancelled run left open, use up the role's slots. The limit is a control (DI-30, PR-20: the listener
  must always be able to record its evidence), not a bug.
- **Fix:** see who holds the connections:

  ```bash
  psql "$URL" -c "select usename, datname, count(*) from pg_stat_activity group by 1, 2 order by 3 desc limit 15"
  ```

  Wait for, or stop, your own leftover run; move one run to a spare cluster; lower `--maxWorkers`. Do not raise or drop
  the role's connection limit.

## 8. Backup, restore and continuity in the product

These are features of the eBMR itself, for the sites that run it, not for the development pods. They are built and
tested; installing streaming replication, WAL archiving and write-once storage is per customer, at installation and
qualification (Phase 7). Owner decisions [0003](../decisions/0003-testing-scope-logic-and-execution.md) and [0004](../decisions/0004-defaults-for-open-questions.md) leave RPO, RTO, the
backup schedule and the storage product to the deployment design.

### The continuity module (`packages/kernel/src/continuity`)

The kernel's `continuity` schema keeps identifiers unique across a restore and records backups, restores and drills
(control [DI-45](../../compliance/controls/DI-45.yaml); invariants INV-27 and INV-08). Read the area
[README](../../packages/kernel/src/continuity/README.md) and the [kernel guide, Continuity](modules/kernel.md#continuity).

| File | What it holds |
|---|---|
| [numbers.ts](../../packages/kernel/src/continuity/numbers.ts) | Protected counters for numbers people see (batch, form, signature numbers): a ceiling is written to the external ledger before the database may issue up to it; a restored or copied database issues nothing until secured |
| [ledger.ts](../../packages/kernel/src/continuity/ledger.ts) | The external, write-once ledger the ceilings, sequence high-water marks and login names are copied to |
| [anchors.ts](../../packages/kernel/src/continuity/anchors.ts) | External anchors of the audit chains, and their verification after a restore |
| [restore.ts](../../packages/kernel/src/continuity/restore.ts) | The restore procedure: record the restore event (secures identifiers first), approval by other named persons, completion |
| [backup-drill.ts](../../packages/kernel/src/continuity/backup-drill.ts), [drill-cli.ts](../../packages/kernel/src/continuity/drill-cli.ts) | Backup jobs (encrypted dump, SHA-256 fixity, catalogue, failure alarm) and restore drills (restore into an isolated database, verify chains and anchors, compare every table) |
| [hardening.ts](../../packages/kernel/src/continuity/hardening.ts) | Hardening attestations of shared and Grade A/B shop-floor devices |
| [security-baseline.ts](../../packages/kernel/src/continuity/security-baseline.ts) | The production security baseline check (TLS and the rest of DI-13) |

Their migrations are kernel 0600 (`0600_continuity_core.sql`), 0610 (`0610_continuity_backup.sql`) and 0620
(`0620_continuity_device_hardening.sql`); tests are in [packages/kernel/test/continuity](../../packages/kernel/test/continuity/).

### The operating scripts (`ops/`)

- [ops/backup/backup.sh](../../ops/backup/backup.sh): one backup job. `pg_dump` in custom format, AES-256-GCM
  encryption, SHA-256 fixity and manifest, a JSON and Markdown report, and with `--record-url` a record in the backup
  catalogue. A failed run exits 1 and raises the `BACKUP_JOB_FAILED` alarm.
- [ops/backup/drill.sh](../../ops/backup/drill.sh): one restore drill. Dumps the source under a snapshot, restores it
  into a new isolated database, verifies the audit chains and anchors on both, compares tables, sequences and a sample
  of records with their audit trail. Exit 0 PASS, 1 FAIL, 2 usage, 3 not recorded.
- `ops/postgres/`: templates for `pg_hba.conf` and the TLS settings of a production cluster.

Both scripts run [drill-cli.ts](../../packages/kernel/src/continuity/drill-cli.ts). Put passwords in `PGPASSWORD` or a
password file, never in the URLs.

### The procedures (`docs/operations/`)

| Document | Summary |
|---|---|
| [ha-and-restore.md](../operations/ha-and-restore.md) | High availability, backup and restore: principles, topology per site, RPO and RTO proposals for the owner, backup tiers and what each job does, write-once storage, how a restore is detected, the restore and failover steps, restore drills, and the status table of what is built and tested |
| [restore-drill-report-template.md](../operations/restore-drill-report-template.md) | The report a restore drill fills in: backup used, restore, audit-trail verification, content comparison, sample records, findings, reviewer assessment and sign-off |
| [test-package-exchange.md](../operations/test-package-exchange.md) | What an administrator does when a test package exported from the GMP installation does not reach the sandbox inbox (`TEST_PACKAGE_INBOX_BEHIND`), and how to check every recorded export has its file (DI-05, DI-04) |

Security documents beside them: [docs/security/](../security/) (threat model, ASVS level 2 review, security baseline).

## Related pages

- [Testing and debugging](06-testing-and-debugging.md): what each test layer proves, and CI failures with real cases.
- [Database reference](05-database.md): test databases, clusters, libfaketime.
- [How to add a feature safely](07-adding-a-feature.md): the steps these runbooks support.
- [Defects and lessons, Test flakiness and races](08-defect-log.md#test-flakiness-and-races).
