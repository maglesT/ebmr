---
name: postgres-oracle
description: Settle what PostgreSQL actually does (SQL semantics, timestamptz and time zones, postgresql.conf parsing, lock and isolation behaviour) by running the real server instead of reasoning from memory or documentation. Use before relying on, or writing a test that encodes, any assumption about PostgreSQL behaviour.
---

# PostgreSQL as the oracle

PostgreSQL 16 is the enforcement point of this system, so code that imitates it (the postgresql.conf reader, the
time parser, a TypeScript check that mirrors a constraint) must agree with it exactly. Do not reason about edge
cases from memory: ask the server, and make the test's expected values come from what it printed.

## SQL behaviour

Use a scratch database, never a demo or test template database:

```bash
sudo -u postgres createdb ebmr_oracle_scratch
sudo -u postgres psql -d ebmr_oracle_scratch -v ON_ERROR_STOP=1 -c "select '2026-03-29 02:30 Europe/London'::timestamptz"
sudo -u postgres dropdb ebmr_oracle_scratch
```

- Compare timestamps as `timestamptz`, not as text, and set the session `TimeZone` explicitly when the result
  depends on it.
- For locking and isolation, open two `psql` sessions (or two `pg` clients in a script) and interleave them by
  hand; record the order of statements with the result.
- For a migration's behaviour, migrate a fresh database with the kernel's `migrate` the way
  `packages/kernel/test/support/global-setup.ts` does, then query it.

## postgresql.conf parsing

The server's own parser answers how a setting is read. Run it against a throwaway data directory with
`postgres -C`, which prints the value it parsed and exits:

```bash
D=$(sudo -u postgres mktemp -d /tmp/ebmr-pgconf-XXXXXX)
printf "ebmr.x = 'a''b'\n" | sudo -u postgres tee "$D/postgresql.conf" >/dev/null
sudo -u postgres /usr/lib/postgresql/16/bin/postgres -D "$D" -C ebmr.x
sudo -u postgres rm -rf "$D"
```

A refused file exits non-zero with the parse error on stderr. Loop over many inputs from a small script and keep
the printed table as the test's expected values. Compare bytes (hex), not only text, for escapes.

## Rules

- Use scratch databases and temporary directories, and remove them afterwards. Never touch the demo databases
  (`ebmr_tablets_demo`, `ebmr_sandbox_tablets_demo`) or another session's clusters.
- Write down the exact statements and outputs in your report or the test's comment, so a reviewer can repeat
  them.
