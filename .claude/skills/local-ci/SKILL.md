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
pg_lsclusters                              # ci (5433) and ci2 (5434) may already exist
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
