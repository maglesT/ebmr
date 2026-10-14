---
name: local-ci
description: Run this repository's CI and end-to-end tests locally the way GitHub runs them, including parallel runs on spare PostgreSQL clusters, and diagnose failures. Use before any push, when CI is red, or when tests need a database.
---

# Local CI and E2E

## Before running

- PostgreSQL 16 must be up: `pg_lsclusters`; start it with `sudo pg_ctlcluster 16 main start` (a new or
  restarted container comes up with it stopped).
- `pnpm install` after switching to a branch whose lockfile differs.

## CI

On a machine with 8 or more cores (`nproc`), this is the default:

```bash
bash tools/dev-env/runpod-setup.sh ci      # static checks, then the tests in 4 shards, then the trace
bash tools/dev-env/runpod-setup.sh test    # the tests only, in 4 shards
```

It runs the same steps as `pnpm run ci`, but the tests run as GitHub runs them: four shards (`vitest --shard=i/4`),
each on its own PostgreSQL cluster (main 5432, ci 5433, ci2 5434, ci3 5436) with `SHARD_WORKERS` workers (default
4). The shard reports are merged into `.reports/vitest.json` for the trace; each shard's output is in
`.reports/shard-<i>.log`. The setup script creates the four clusters. Running the whole suite on one cluster with a
worker per core overloads that cluster: tests time out at 30 s, a role runs out of connections, and review/f55's
restored cluster recovers too slowly. Those failures are load, not code. The golden cluster (5435, libfaketime) is
never a shard. The GitHub workflow is not changed by any of this.

On a smaller machine:

```bash
NODE_OPTIONS=--max-old-space-size=2048 pnpm run ci
```

The 2 GB heap is what the GitHub runner gives typed linting; running with it locally shows what CI will see.
CI is typecheck, lint, dependency boundaries, pins, the control register, all tests (with a JSON report) and the
traceability check: a control due by the current phase without a passing, tagged test fails it.

**Do not edit files while CI runs.** It reads files at different moments; a half-written file gives errors that
are not real.

## End-to-end tests (Playwright)

```bash
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers flock /tmp/ebmr-e2e.lock -c 'CI=true pnpm --filter @ebmr/e2e test'
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers flock /tmp/ebmr-e2e.lock -c 'CI=true pnpm --filter @ebmr/e2e test specs/<area>'
```

The lock keeps parallel agents from starting two E2E stacks on the same ports. Never run `playwright install`;
the browser is pre-installed.

## Parallel runs on spare clusters

Tests read the admin connection from `EBMR_PG_ADMIN_URL` (default
`postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres`). To run a second suite or a mutation run at the same time,
use a spare cluster:

```bash
pg_lsclusters                              # ci (5433), ci2 (5434) and ci3 (5436) exist after the setup script; they are also the sharded run's clusters
sudo pg_createcluster 16 ci --port 5433 --locale C.UTF-8   # only if missing
sudo pg_ctlcluster 16 ci start
sudo -u postgres psql -p 5433 -c "create role ebmr_dev superuser login password 'ebmr_dev'"   # only if missing
EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5433/postgres pnpm vitest run <paths>
```

Ask before stopping or dropping a cluster or database you did not create.

## When something fails

- Find the root cause. "Flaky" is not a root cause: a test that fails under load is racing something; fix the
  race (wait for the condition, not for time) and say what it was.
- Reproduce a CI-only failure locally with the same heap and `CI=true` before changing code.
- Never skip, disable or loosen a test, and never lower a threshold, to get green.
