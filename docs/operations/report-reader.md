# Connecting an external reader to the report views (ebmr_report)

For an administrator connecting a reporting tool or the owner's Deviations and CAPA system (ADR 0022) to a Batchwright
GMP database. The reader gets the reporting role `ebmr_report` (kernel 1210) and nothing else: SELECT on the `report`
views, CONNECT on GMP databases only, at most 4 connections, member of no role. It can write nothing.

## On the database server

1. **Password.** The migration creates `ebmr_report` with the development password `ebmr_report`. On a site, set the
   vault credential once, as a superuser:
   `alter role ebmr_report password '<vault credential>';` (SCRAM; `password_encryption = scram-sha-256`).
2. **pg_hba.conf.** One line for the reader's host, TLS and SCRAM only (the template `ops/postgres/pg_hba.conf.template`
   has it; replace the address):

   ```
   hostssl  ebmr_tablets  ebmr_report  <reader host>/32  scram-sha-256
   ```

   Put it above the final `reject` lines, then `select pg_reload_conf();`. Point it at a streaming replica instead of
   the primary where there is one: `data_as_of` then shows the replica's last replayed commit.
3. **Check.** `select * from sandbox.segregation_problems();` on the GMP database must return no rows after any grant
   change. `select view_name, version, columns from report.catalog_v1;` lists the views the role may read.

## On the reader's side

Connection setting (libpq URL; the password from the reader's own secret store):

```
postgresql://ebmr_report:<credential>@<db host>:5432/ebmr_tablets?sslmode=verify-full&sslrootcert=<site CA>&application_name=deviations-reader&options=-c%20default_transaction_read_only%3Don%20-c%20statement_timeout%3D60000
```

- Keep the pool at 4 connections or fewer (the role's connection limit; a fifth is refused).
- Read only the views (ADR 0022): `batch_fact_v1`, `step_use_v1`, `cpp_value_v1`, `exception_v1`, `alarm_v1`,
  `reference_document_v1`, `batch_reference_v1`, `equipment_use_v1`, `ipc_result_v1`, `process_actual_v1`,
  `exception_detail_v1`. Every row has `read_at` (the statement time) and `data_as_of`.
- Times are `timestamptz`; render them in the site's zone (Asia/Kolkata for an Indian site).
- A column change arrives as a new `_v2` view; the `_v1` view stays until the reader moves
  (`apps/tablets-server/test/contract/report-views-deviations.test.ts` pins the columns).

## Development and the demo

On a development cluster (`localhost:5432`, no TLS) the reader connects with
`postgresql://ebmr_report:ebmr_report@localhost:5432/ebmr_tablets_demo`; a local `pg_hba.conf` that allows `host ... md5` or
`scram-sha-256` for localhost is enough. The demo's hosted installation is reached the same way through its own host
rules.
