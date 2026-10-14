# Database reference

**Draft.** This page explains how the database of the eBMR is built and how to work in it safely: where the
migrations live and in which order they run, the security conventions every function and table follows, the audit
trail, how errors are raised and reach the screen, the state engine, locks and isolation, time, and the test databases
and clusters. Read it before you write or change SQL. It goes deep on database practice; the request path from screen to
database is in [Architecture](03-architecture.md), and terms such as GMP, audit trail, e-signature and invariant are in
the [glossary](02-glossary.md).

Most rules of this system live in PostgreSQL 16, not in TypeScript. The reason is a pharma one: a rule that only the
server checks can be skipped by anyone who holds the application's database password. A rule the database enforces
holds even then (ADR [0012](../adr/0012-privilege-separation-security-definer-transitions.md): "the rules hold when the
application's own database credentials are used directly"). So when you look for "where is this rule", look in the SQL
first.

## Where the code is

| What | Where |
|---|---|
| Migration runner | [migrate.ts](../../packages/kernel/src/db/migrate.ts#sym=migrate) |
| Kernel migrations | [packages/kernel/sql/](../../packages/kernel/sql/) |
| Site-services migrations | [packages/site-services/sql/](../../packages/site-services/sql/) |
| Recipe-core migrations | [packages/recipe-core/sql/](../../packages/recipe-core/sql/) |
| Tablets edition migrations | [apps/tablets-server/sql/](../../apps/tablets-server/sql/) |
| Order of the sources for an edition database | [editionMigrationSources](../../packages/test-kit/src/db.ts#sym=editionMigrationSources) |
| The command wrapper (who is acting) | [withCommand](../../packages/kernel/src/db/command.ts#sym=withCommand) |
| How the server turns a database error into an answer | [mapError](../../apps/tablets-server/src/platform/http/errors.ts#sym=mapError) |
| Every function and trigger, where defined and replaced (generated) | [Database catalogue](reference/db-catalogue.md) |
| Every `EBMR-...` error code and where it is raised (generated) | [Error codes](reference/error-codes.md) |
| Architecture decisions behind this page | ADR [0007](../adr/0007-hash-chained-audit-trail-checkpoints-anchors-restore-events.md) (audit trail), [0011](../adr/0011-recipe-core-shared-between-editions.md) (recipe-core in every edition), [0012](../adr/0012-privilege-separation-security-definer-transitions.md) (privileges), [0016](../adr/0016-validated-actor-context-and-definer-hardening.md) (actor context, definer hardening), [0018](../adr/0018-platform-scope-hook.md) (scope hook) |

## Migrations

A **migration** is a numbered SQL file that changes the database schema: it creates tables, functions, triggers and
grants. The database of an edition is the result of running every migration once, in order.

### The four sources and their namespaces

There are four folders of migrations. Each has a **namespace**, a short name the runner stores with each applied file,
so two folders may use the same file number without clashing.

| Order | Namespace | Folder | Numbers (today) | What it holds |
|---|---|---|---|---|
| 1 | `kernel` | [packages/kernel/sql](../../packages/kernel/sql/) | 0001 to 1174 (85 files) | Roles, audit trail, identity and access (`iam`), e-signatures (`esig`), market rules (`market`), records, platform services (time, outbox, state engine), continuity, sandbox |
| 2 | `site-services` | [packages/site-services/sql](../../packages/site-services/sql/) | 0600 to 0903 (46 files) | Data shared by both editions at one site (schema `site`): batch numbers, material lots, deviations, specifications, LIMS-lite, ERP masters, India licences |
| 3 | `recipe-core` | [packages/recipe-core/sql](../../packages/recipe-core/sql/) | 0100 to 0932 (195 files) | The shared process logic (schemas `recipe`, `plant`): master records, execution store, exceptions, review, release, record lock |
| 4 | `tablets` | [apps/tablets-server/sql](../../apps/tablets-server/sql/) | 0001 to 1209 (128 files) | The Tablets edition (schema `tab`): devices, readings, the tablet blocks (dispensing, granulation, compression, coating, packaging), Tablets release items |

The counts are of 14 October 2026; the [database catalogue](reference/db-catalogue.md) is always current.

The order is fixed by
[editionMigrationSources](../../packages/test-kit/src/db.ts#sym=editionMigrationSources): kernel first, then site
services, then recipe-core (ADR [0011](../adr/0011-recipe-core-shared-between-editions.md): recipe-core is applied to
every edition database after the kernel), then the edition's own folder, which the Tablets server passes in
([setup.ts](../../apps/tablets-server/src/cli/setup.ts) uses the namespace `tablets`). The kernel's test template adds a
fifth source, `test-fixtures`
([fixtures.sql](../../packages/kernel/test/support/fixtures.sql), for example the `testgmp.sample` table the audit
tests write to), built by [templateSources](../../packages/kernel/test/support/global-setup.ts#sym=templateSources).

Two things follow from this order:

- **The runner finishes one folder before it starts the next.** All kernel files run before any site-services file,
  whatever their numbers. So kernel 1174 runs before site-services 0600. On an upgrade, a new kernel file runs before a
  new recipe-core file of the same release.
- **A lower layer never names a higher layer's tables at create time.** The kernel cannot know about recipe-core
  (ADR 0011: the kernel holds no process logic). When the kernel needs domain knowledge, it defines a **hook**: a
  function the domain module registers later. Examples:
  [platform.register_hook](../../packages/kernel/sql/1150_platform_scope_hook.sql#sym=platform.register_hook) (the
  AUTHORITY, SIGNATURE and SCOPE hooks of the state engine, ADR [0018](../adr/0018-platform-scope-hook.md)) and
  `kernel.validate_actor_context`, which the identity module replaces in
  [0190_iam_actor_context.sql](../../packages/kernel/sql/0190_iam_actor_context.sql#sym=kernel.validate_actor_context).

Within one folder, a file may need a table that a later file of the same folder creates. That is rare and must be
explicit: recipe-core 0719 names a table that 0740 creates, so it sets `check_function_bodies = off`
([defect log](08-defect-log.md#p4-recipe-core-0719-check_function_bodies--off)).

### How the runner works

[migrate](../../packages/kernel/src/db/migrate.ts#sym=migrate) does this for each source, in the order above:

1. It creates `public.schema_migration` if it is missing. The table holds one row per applied file: namespace, file
   name, SHA-256 checksum of the file's text, and when it was applied.
2. It lists the folder's `.sql` files and sorts them by name. File names start with a four-digit number, so name
   order is number order.
3. For a file already applied, it compares the stored checksum with the file's checksum now. If they differ, it stops
   with `migration <namespace>/<file> changed after it was applied`.
4. For a new file, it opens a transaction, takes a lock on the role catalogue (`lock table pg_catalog.pg_authid in
   share row exclusive mode`), runs the file, records its checksum and commits. If anything fails, the whole file is
   rolled back and the run stops with `migration <namespace>/<file> failed: ...`.

The lock in step 4 is there because database roles are shared by every database of a PostgreSQL cluster. Two
databases migrated at the same time (the test set-ups on a fresh cluster, or a GMP and a sandbox installation upgraded
together) could both find a role missing and both try to create it. The lock makes migration transactions on one
cluster run one at a time. The test is
[migrate-concurrency.test.ts](../../packages/kernel/test/db/migrate-concurrency.test.ts).

### Never edit a released migration: add a new one

Once a migration has run anywhere that matters (a test template other people use, the demo, a CI run on `main`, a
customer site), its text is frozen. The checksum makes this a hard rule: the runner refuses a database whose applied
file has changed. To change a function, a table or a grant, write a **new** migration with the next free number in the
same folder.

- Phase 1 findings were fixed before any deployment, partly by editing Phase 1 files. From Phase 2 on, every fix is a
  new migration ([defect log, How to read an entry](08-defect-log.md#how-to-read-an-entry)).
- When two branches pick the same number, one of them is renumbered before the merge (for example commits 5685be5b,
  0b4de0b7 and 27b1efe2; see the [CI section of the defect log](08-defect-log.md#ci)).
- A new migration also corrects the comments of old ones. Old headers cannot be edited, so a later header says what was
  wrong. Example: [0331_proposal_read_committed.sql](../../packages/recipe-core/sql/0331_proposal_read_committed.sql)
  begins with "Corrections of earlier headers, stated here because applied migrations are never edited".
- Machine migrations (`*_machine_*_vN.sql`) are generated from TypeScript and say `GENERATED ... Do not edit` in their
  first line. To change a machine, publish a new version in a new migration (see [The state engine](#the-state-engine)).

### "create or replace": finding the version in force

Most fixes replace a function with `create or replace function` in a new migration. The name stays, the body changes.
So a function name can appear in several files, and **the last one in run order is the version in force**. Examples:

| Function | Defined in | Version in force |
|---|---|---|
| `esig.aggregate_lock` | kernel 0220, 1020 | [1020_esig_lock_read_committed.sql](../../packages/kernel/sql/1020_esig_lock_read_committed.sql#sym=esig.aggregate_lock) |
| `platform.guard_state_row` | kernel 0550, 1110 | [1110_state_rows_follow_published_machine.sql](../../packages/kernel/sql/1110_state_rows_follow_published_machine.sql#sym=platform.guard_state_row) |
| `sandbox.apply_connect_policy` | kernel 0800, 0970, 0980, 1111 | [1111_connect_policy_unknown_grantee.sql](../../packages/kernel/sql/1111_connect_policy_unknown_grantee.sql#sym=sandbox.apply_connect_policy) |
| `iam.platform_authority` | kernel 0710, 1150 | [1150_platform_scope_hook.sql](../../packages/kernel/sql/1150_platform_scope_hook.sql#sym=iam.platform_authority) |

Three ways to find the version in force, from quickest to most certain:

1. Look it up in the [database catalogue](reference/db-catalogue.md), which lists every file that defines a function.
2. Search the folders in run order. Remember that the folders run one after another (kernel, site-services,
   recipe-core, tablets), so a recipe-core file replaces a kernel file whatever the numbers:

   ```bash
   for d in packages/kernel/sql packages/site-services/sql packages/recipe-core/sql apps/tablets-server/sql; do
     grep -liE "create (or replace )?function esig\.aggregate_lock\b" $d/*.sql
   done | tail -n 1
   ```

3. Ask a migrated database. This is the ground truth:
   `select pg_get_functiondef('esig.aggregate_lock'::regproc);` (in `psql`, `\sf esig.aggregate_lock`).

`create or replace` keeps the owner, the grants, `SECURITY DEFINER` and the `SET search_path` only if the new text says
the same. A replacement must repeat them exactly, and a header usually says so ("same name, arguments, owner, SECURITY
DEFINER, search_path and privileges"). If you change a function's arguments, it is a new function: drop the old one
and grant the new one.

### Shape of a migration file

Look at any recent file, for example
[0730_deviation_lite.sql](../../packages/site-services/sql/0730_deviation_lite.sql). Each one has:

1. **A header comment**: what the file does, why (the review finding, the decision), and the controls and invariants
   it serves (`DI-17`, `INV-09`). Paraphrase regulations; never paste them.
2. `set local role ebmr_owner;` so every object it creates belongs to the owner role (below).
3. Tables, with `revoke all on <table> from public;` right after each one.
4. For each event-time column, `select platform.enforce_db_time('<table>', array['<column>']);`
   ([time](#time-in-the-database)).
5. For each GMP table, `select kernel.register_audited_table('<table>', '<aggregate type>', '<aggregate column>',
   <insert only>);` ([audit trail](#the-audit-trail)).
6. Functions, each `security definer set search_path = pg_catalog, <its schema>, pg_temp`.
7. Grants at the end: `select` on what the application may read, `execute` on the functions it may call.
8. `reset role;`

## Security conventions

### Database roles

These are PostgreSQL login roles, not the people's roles in the plant (operator, QA, QP), which are rows in
`iam.role` ([0120_iam_roles_grants.sql](../../packages/kernel/sql/0120_iam_roles_grants.sql#sym=iam.role)). Roles are
cluster-wide, so every migration creates them only if they are missing.

| Role | Created in | Login | What it is for |
|---|---|---|---|
| `ebmr_owner` | [0001_bootstrap.sql](../../packages/kernel/sql/0001_bootstrap.sql) | no | Owns every schema, table and `SECURITY DEFINER` function. Nobody logs in as it. |
| `ebmr_app` | [0001_bootstrap.sql](../../packages/kernel/sql/0001_bootstrap.sql) | yes | The application server of a GMP database. Reads what it is granted and calls granted functions. It cannot write audit rows or signatures or change table definitions, and it has no INSERT, UPDATE or DELETE on IAM tables. |
| `ebmr_authn` | [0100_iam_foundation.sql](../../packages/kernel/sql/0100_iam_foundation.sql) | yes, `noinherit` | The authentication service: the only role that can read secret verifiers (password hashes) and create authentication events. |
| `ebmr_sandbox` | [0800_sandbox_installation.sql](../../packages/kernel/sql/0800_sandbox_installation.sql) | yes | The application inside a sandbox (training and test) database. It holds there exactly the privileges of `ebmr_app` and `ebmr_authn`, copied by `sandbox.mirror_application_privileges`, never a membership. It cannot connect to a GMP database (INV-18). |
| `ebmr_listener`, `ebmr_sandbox_listener` | [0980_listener_login_roles.sql](../../packages/kernel/sql/0980_listener_login_roles.sql) | yes, `noinherit`, member of nothing | The gateway listener that records what the site gateway sends. Limited to the listener's share of connections (8 per listener); the application roles get the rest. |

Development passwords equal the role name (see [db.ts](../../packages/test-kit/src/db.ts#sym=APP_LOGIN)); production
keeps them in a vault. The tests and tools connect as a superuser, `ebmr_dev`, through `EBMR_PG_ADMIN_URL`.

Database-level rules set at bootstrap and re-applied on every copy of a template (privileges on a database are not
copied by `CREATE DATABASE ... TEMPLATE`):

- `revoke temporary on database ... from public`: nobody but a superuser can create temporary tables. A temporary table
  could shadow a table name inside a function whose `search_path` looked in `pg_temp` first.
- `sandbox.apply_connect_policy()`: CONNECT only for the roles of the database's kind (GMP or SANDBOX), and since kernel
  0970 no `pg_cancel_backend` or `pg_terminate_backend` for anyone but superusers.
  [copyDatabase](../../packages/test-kit/src/db.ts#sym=copyDatabase) re-applies both.
- `sandbox.segregation_problems()` reports a role membership that would let one role act as another (version in force:
  [1100_segregation_problems_missing_roles.sql](../../packages/kernel/sql/1100_segregation_problems_missing_roles.sql#sym=sandbox.segregation_problems)).

### SECURITY DEFINER functions with a fixed search_path

The application role has almost no direct write rights. It changes data by calling functions that run with the
owner's rights. Such a function is declared `security definer`: inside it, PostgreSQL acts as the function's owner
(`ebmr_owner`), not as the caller. The rules of ADR [0012](../adr/0012-privilege-separation-security-definer-transitions.md)
item 4 and ADR [0016](../adr/0016-validated-actor-context-and-definer-hardening.md) item 4:

- **Owned by a role that cannot log in** (`ebmr_owner`).
- **Fixed `search_path`, with `pg_temp` last**: `set search_path = pg_catalog, <its schema>, pg_temp`. Without it, a
  caller could create an object with the same name in a schema it controls and make the function use that object
  instead. `pg_catalog` first means built-in functions cannot be shadowed either.
- **No EXECUTE for PUBLIC.** The bootstrap sets `alter default privileges for role ebmr_owner revoke execute on
  functions from public`, so every new function starts callable by nobody. Each migration then grants `execute` to the
  roles that need it, by name.
- **Schemas closed by default**: `revoke all on schema <s> from public; grant usage on schema <s> to ebmr_app;`.

A small, real example, the signing lock in force today:

```sql
create or replace function esig.aggregate_lock(p_aggregate_type text, p_aggregate_id text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, esig, pg_temp as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'P0001', message = format('EBMR-ESIG-015 ...', ...);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('esig:' || p_aggregate_type || ':' || p_aggregate_id, 0));
end
$$;
```

([1020_esig_lock_read_committed.sql](../../packages/kernel/sql/1020_esig_lock_read_committed.sql#sym=esig.aggregate_lock).)

### Grants: what the application may do

The pattern is "revoke everything, grant the minimum":

- Tables: `revoke all ... from public`, then `grant select` to `ebmr_app` on what it may read. Writes go through
  functions. Some tables are not even readable; the application reads them through a function that checks who asks
  (for example the data-integrity investigation tables, read only through their content function since tablets 0410).
- Functions: `grant execute on function <name>(<argument types>) to ebmr_app`. A function the server must not call
  directly is revoked from it (tablets 0410 revokes `esig.content_for_signing` from the application and grants a
  checking wrapper instead).
- Columns: for tables the application may insert into, the grant can leave out the event-time columns, so supplying a
  time is refused outright (see the [time module's README](../../packages/kernel/src/time/README.md)).
- Inside a sandbox, `ebmr_sandbox` gets the same object privileges as `ebmr_app` (mirrored after every migration run).
  A new grant to `ebmr_app` is therefore mirrored; you do not write a second grant.

ADR 0012 item 8 says every invariant has a **bypass test**: raw SQL as the application role tries to break the rule and
must be refused. Most test files that prove a database guard have such tests; see
[Testing and debugging](06-testing-and-debugging.md).

### Row-level security

Row-level security (a policy that filters which rows a role sees) is used in a few places only, for reads by the
application roles. Since tablets 0410 and 0430, `ebmr_app` and `ebmr_sandbox` see only the RECORD-class rows of the
signature tables (`esig.signature`, `esig.challenge`, `esig.signature_seal`, `esig.content_change`,
`esig.signature_invalidation`); the owner's functions see every row. The policy is `app_reads_record_class` in
[0410_signing_content_read.sql](../../apps/tablets-server/sql/0410_signing_content_read.sql) and
[0430_governance_read_doors.sql](../../apps/tablets-server/sql/0430_governance_read_doors.sql). Everything else is
controlled by grants and by checking functions.

### Insert-only tables and triggers that refuse changes

Many GMP tables are **insert-only**: a row, once written, is never updated or deleted. A correction is a new row that
refers to the old one. This is how paper GMP works too: you do not erase an entry, you cross it out and write the
correction beside it, signed and dated.

`kernel.register_audited_table(table, aggregate type, aggregate column, insert_only)` installs the triggers by one naming
rule ([kernel.required_triggers](../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.required_triggers)):

| Trigger name | When | Calls | Purpose |
|---|---|---|---|
| `zz_audit_<schema>_<table>` | after insert, update or delete, each row | `kernel.audit_row_change()` | writes the audit event |
| `aa_insert_only_<schema>_<table>` (insert-only tables) | before update or delete, each row | `kernel.reject_mutation()` | refuses with `EBMR-AUDIT-004` |
| `aa_no_truncate_<schema>_<table>` (insert-only tables) | before truncate | `kernel.reject_mutation()` | refuses with `EBMR-AUDIT-004` |

PostgreSQL fires triggers of the same kind in name order. The prefixes use this: `aa_` guards run first, `zz_audit_`
runs last, after every other trigger has shaped the row. Other modules follow the same idea: the time trigger is
`a0_db_time_*`, and tablets 0260 adds an `a1_` trigger that must run after it.

[kernel.audit_triggers_ok](../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.audit_triggers_ok) checks that
every required trigger exists, is enabled and calls the kernel's function. `kernel.begin_command` refuses every GMP
write while one is missing (`EBMR-AUDIT-005`; DI-23, INV-06). DDL (table changes, dropped or disabled triggers) is
recorded in `kernel.ddl_log` by the event triggers `ebmr_log_ddl` and `ebmr_log_ddl_drop`, so a superuser change is at
least visible afterwards.

Other tables that are not insert-only still refuse changes in some states (a signed record, a closed step, a locked
batch). Those guards are triggers or checks inside the writing functions, specific to their module; the module guides
(for example [recipe-core](modules/recipe-core.md) and [tablets-server](modules/tablets-server.md)) list them.

## The audit trail

> **Why this exists**
> - **Pharma reason:** every creation, change and deletion of GMP data must leave a secure, computer-generated,
>   time-stamped record of who did what, when and why, that the user cannot change or switch off (21 CFR 11.10(e),
>   EU GMP Annex 11 section 9).
> - **Control:** [DI-22](../../compliance/controls/DI-22.yaml), [DI-23](../../compliance/controls/DI-23.yaml),
>   [DI-24](../../compliance/controls/DI-24.yaml); invariants INV-06, INV-07, INV-08, INV-16.
> - **Code:** [kernel.audit_row_change](../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.audit_row_change),
>   [kernel.append_audit_event](../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.append_audit_event),
>   [kernel.begin_command](../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.begin_command).
> - **Tests:** [audit-trail.test.ts](../../packages/kernel/test/audit/audit-trail.test.ts), tests named `[DI-22]`,
>   `[INV-07]`.
> - **Error:** `EBMR-AUDIT-001` (no actor), `EBMR-AUDIT-002` (no reason), `EBMR-AUDIT-004` (insert-only).

### The command: who is acting

Every GMP write runs inside a **command**: one transaction that first declares who is acting.
[withCommand](../../packages/kernel/src/db/command.ts#sym=withCommand) opens the transaction and calls
`kernel.begin_command(<actor context>)`. The actor context is a JSON object: person, account, role, session, source
(`UI`, `API`, `INTEGRATION`, `SYSTEM`), site time zone, correlation id, and, for a change, a reason code and reason
text. `begin_command` validates it (the identity module checks that the account, session and device are real and
active, `kernel.validate_actor_context` in
[0190_iam_actor_context.sql](../../packages/kernel/sql/0190_iam_actor_context.sql#sym=kernel.validate_actor_context))
and installs it as the transaction's one validated context.

Why the context cannot be faked: it is stored in a transaction-local setting, which any session could write with
`set_config`. So the kernel also keeps a marker, per connection, in a table only `ebmr_owner` can write: the
transaction and the hash of the context it installed. `kernel.current_actor()` returns the context only when the marker
matches. A context written with `set_config` alone is ignored, and the audit trigger refuses the write
(`EBMR-AUDIT-009`). This was a critical Phase 1 finding
([defect log, P1-F1](08-defect-log.md#p1-f1-f68-f74-f12-critical-a-co-signers-context-could-be-reinstalled)); ADR 0016
records the design. Code that must act as another actor inside a command (an internal actor, a co-signer) switches
through `kernel.set_actor_context` and switches back the same way, never with `set_config`.

### What the trigger writes

`kernel.audit_row_change` runs after each insert, update or delete on a registered table:

1. It looks up the table's registration. A table that is not registered is refused (`EBMR-AUDIT-003`).
2. It reads the validated actor. None: `EBMR-AUDIT-001` ("call kernel.begin_command first").
3. For an UPDATE or DELETE, it requires both a reason code and a reason text that is not blank (`EBMR-AUDIT-002`). A
   first entry needs no reason.
4. It renders the row as canonical JSON with
   [kernel.row_json](../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.row_json), which pins the session
   settings that change how times, intervals, bytes and floats print, so the same row always gives the same text.
5. It builds the body: for an insert-only table, the SHA-256 of the row; for an update, only the changed fields, old and
   new; for an insert or delete, the whole row.
6. It appends the event to the **chain** of the row's aggregate. The chain key is `<aggregate type>:<aggregate id>`,
   for example `deviation:<uuid>`. When an update moves a row to another aggregate, both chains get the event.

[kernel.append_audit_event](../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.append_audit_event) is the only
writer of `kernel.audit_event`. Each event stores the chain key, its sequence number in the chain, the previous event's
hash and its own hash, where hash = SHA-256(previous hash ‖ canonical payload). The first event of a chain hashes from
`genesis:<chain key>`. The head of each chain is kept in `kernel.audit_chain_head`. The payload carries the actor's
user ID, printed name and role at the time, the server's UTC time and the site zone, the action, the record and the
correlation id. The application role cannot insert, update or delete audit rows.

### Plain-language entries, verification, checkpoints and anchors

- `kernel.audit_business_event(chain key, message, details)` writes a plain-language entry ("batch released for
  packing") with the same correlation id as the row entries of the same command, so a reviewer reads one story.
- [kernel.verify_chain](../../packages/kernel/sql/0010_audit_trail.sql#sym=kernel.verify_chain) recomputes a chain and
  reports gaps, a broken link or an altered payload. A superuser who rewrites rows inside the database is caught here
  (a "detected" bypass in ADR 0012's terms).
- Checkpoints (`kernel.audit_checkpoint`) seal a chain's state; anchors (`kernel.audit_anchor`) are periodic Merkle
  roots over all chain heads, copied to write-once storage outside the database (ADR
  [0007](../adr/0007-hash-chained-audit-trail-checkpoints-anchors-restore-events.md)).

### Adding a GMP table

1. Create it under `set local role ebmr_owner`, `revoke all ... from public`.
2. Register its event-time columns with `platform.enforce_db_time`.
3. Register it with `kernel.register_audited_table`, choosing the aggregate (the record a reviewer reads its trail by,
   for example the deviation, not the deviation's link row) and whether it is insert-only.
4. Grant `select` if the application may read it; write through a `SECURITY DEFINER` function.
5. Write a test that a write without a command is refused and that the audit event appears (see
   [Testing and debugging](06-testing-and-debugging.md)).

Forgetting step 3 has happened: [defect log, tables that were not audited](08-defect-log.md#p2-f01-round-2-and-p4-slice-1-tables-that-were-not-audited).

## How errors are raised

### In SQL

A guard that refuses raises an exception with SQLSTATE `P0001` (PostgreSQL's code for a plain `raise exception`) and a
message that **starts with a stable code**:

```sql
raise exception using errcode = 'P0001',
  message = format('EBMR-AUDIT-002 a reason is required to %s %s: give a reason code and a reason text', lower(tg_op), tg_relid::regclass);
```

The code has the form `EBMR-<AREA>-<NNN>`: an area (`AUDIT`, `IAM`, `ESIG`, `PLAT`, `MKT`, `REC`, `SBX`, `SITE`, `EXE`,
`RCP`, `REV`, `REL`, `DSP`, `DEV`, `TAB`, `IND`, `LCK`, ...) and a three-digit number. Callers branch on the code, never
on the wording; the wording is for people and may be improved. Rules:

- One code means one refusal. Do not reuse a number for a different reason.
- The message says what was refused and why in plain words. The server shows it to the user as "why".
- When the caller needs structured data (which reasons, which person), put JSON in `detail`, as `EBMR-IAM-054` does.
- Setup checks inside a migration may use a plain `raise exception 'SETUP: ...'`: they stop a migration, never a user.
- A few functions raise a private SQLSTATE to undo a block on purpose (`EBMRP` in tablets 0500: a "peek" runs a claim and
  rolls it back). That error never leaves the function.

Every code and the file that raises it is listed in [Error codes](reference/error-codes.md).

### In the server

The server never parses wording. The chain is:

1. A route handler runs a command; PostgreSQL raises; `pg` throws an error whose `message` holds the code and whose
   `code` holds the SQLSTATE.
2. [mapError](../../apps/tablets-server/src/platform/http/errors.ts#sym=mapError) finds the code with
   [errorCode](../../packages/kernel/src/commands/errors.ts#sym=errorCode) (the regular expression
   `\bEBMR-[A-Z]+-\d{3}\b`) or [ebmrCode](../../packages/kernel/src/identity/errors.ts#sym=ebmrCode).
3. It looks the code up in the **guidance catalogue**
   ([GuidanceCatalogue](../../apps/tablets-server/src/platform/http/guidance.ts#sym=GuidanceCatalogue)): first the exact
   code, then the family (`EBMR-IAM-*`). Each feature registers its entries in `features/<name>/index.ts`. An entry
   gives the HTTP status, the kind of refusal, "what happened", "what you can do" and "who can help".
4. The answer is a refusal envelope: the code, the guidance, the database's own message without its code as "why",
   and the correlation id. A code with no entry is answered as 422 NOT_ALLOWED with the database's message.
5. Some SQLSTATEs are mapped without a code: text no record can hold (`22P05`, `22021`, `22P02` with a surrogate)
   becomes 400 INVALID_INPUT ([unstorableTextSqlState](../../apps/tablets-server/src/platform/http/errors.ts#sym=unstorableTextSqlState);
   [defect log, P2-F30 to F33](08-defect-log.md#p2-f30-to-f33-nul-characters-and-lone-surrogates-in-free-text)).
6. Anything else is 500 INTERNAL and is logged with the correlation id. Nothing was saved, because the command's
   transaction rolled back.

## The state engine

Many records move through states: a master record version goes DRAFT, IN_REVIEW, APPROVED, EFFECTIVE; a material lot
goes QUARANTINE, RELEASED, REJECTED. These life cycles are **state machines**, and the database holds them so that no
code path can jump a state.

### Tables

All in [0550_platform_state_engine.sql](../../packages/kernel/sql/0550_platform_state_engine.sql):

| Table | Holds |
|---|---|
| [platform.machine](../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.machine), [platform.machine_version](../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.machine_version) | each machine and its published versions (immutable once published) |
| [platform.machine_transition](../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.machine_transition) | the allowed transitions of a version: from state, event, to state, its guard codes, the signature meaning it needs (if any) and its permission |
| [platform.state_guard](../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.state_guard) | registered guard functions, by code |
| [platform.aggregate_state](../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.aggregate_state) | the current state and version of each aggregate, with the machine version it was created with (pinned) |
| [platform.state_history](../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.state_history) | one row per transition |

The application role reads these tables but cannot write them. A trigger,
[platform.guard_state_row](../../packages/kernel/sql/1110_state_rows_follow_published_machine.sql#sym=platform.guard_state_row)
(version in force: kernel 1110), refuses any state row that is not a published transition, whoever writes it.

### How a transition runs

[platform.transition](../../packages/kernel/sql/0550_platform_state_engine.sql#sym=platform.transition) is the only way to
change a state. In one transaction it refuses an administrator (DI-18), locks the state row `FOR UPDATE`, checks the
optimistic version the caller saw, finds the transition in the pinned machine version, asks the AUTHORITY hook for the
permission, the SIGNATURE hook for the signature if one is required, and runs every guard of the transition. Then it
updates the state and version, writes a history row, a plain-language audit entry and an outbox message.

A **guard** is a SQL function `fn(aggregate_type, aggregate_id, transition, payload, actor) returns text`. It returns
NULL to allow, or the reason to refuse. It runs with the state row locked, reads the database clock for anything
time-based and must not write.

### Published machines

Machines are written once in TypeScript (XState 5) and published by **generated** migrations; a test proves the
TypeScript and the published rows describe the same transitions
([machine-consistency.test.ts](../../packages/kernel/test/platform/machine-consistency.test.ts)). Published today:

| Machine | Version(s) | Migration | Source |
|---|---|---|---|
| `sample_record` | 1 | kernel 0552 | [sample-record.ts](../../packages/kernel/src/state/machines/sample-record.ts) |
| `mbr_version` | 1 | recipe-core 0140 | [lifecycle/machine.ts](../../packages/recipe-core/src/lifecycle/machine.ts) |
| `equipment_cleanliness`, `area_status` | 1 | recipe-core 0401, 0402 | [plant/machine.ts](../../packages/recipe-core/src/plant/machine.ts) |
| `output_container` | 1 | recipe-core 0421 | [containers/machine.ts](../../packages/recipe-core/src/containers/machine.ts) |
| `material_lot` | 1, 2, 3 | site-services 0711, 0861, 0881 | [lots/machine.ts](../../packages/site-services/src/lots/machine.ts) |

To change a machine: edit the TypeScript, run the module's `write-seeds.ts` to generate a new `*_machine_*_vN.sql`, and
let existing aggregates keep their pinned version. The batch execution itself (steps, entries, hold points) is not one
of these machines: it is the recipe-core execution store, with its own guards (see the
[recipe-core module guide](modules/recipe-core.md)).

## Locks and isolation

### The default: READ COMMITTED

The server runs its commands in READ COMMITTED, PostgreSQL's default: each statement sees what was committed before it
started. Many guards depend on this. A lock taken by statement 2 makes statement 3 see whatever the other transaction
committed while statement 2 waited.

Under REPEATABLE READ or SERIALIZABLE the whole transaction reads one snapshot, taken at its first statement, before
any wait. A real defect came from this: a signing that waited for a change and then re-hashed the record as its old
snapshot showed it signed content the record no longer had
([defect log, P2-F37 and F37.R](08-defect-log.md#p2-f37-and-f37r-a-proposal-during-a-signing-landed-on-the-signed-version)).
SERIALIZABLE's conflict detection did not help, because it only sees other SERIALIZABLE transactions. So now:

- `esig.aggregate_lock` refuses any isolation level but READ COMMITTED (`EBMR-ESIG-015`, kernel 1020), and with it
  every signing and every change of signed content;
- the recipe proposal functions refuse it too (`EBMR-EXE-084`, recipe-core 0331).

REPEATABLE READ is used only for **read-only** work that needs one consistent picture: the archive's true copy and the
QP package (`begin isolation level repeatable read` in
[archive/index.ts](../../apps/tablets-server/src/features/archive/index.ts) and
[qp-package/index.ts](../../apps/tablets-server/src/features/qp-package/index.ts)). They take no signing lock.

### Which locks

| Lock | Used for | Example |
|---|---|---|
| `pg_advisory_xact_lock(hashtextextended('<area>:<type>:<id>', 0))` | one lock per logical record that has no single row to lock, held until commit | `esig.aggregate_lock`: every signing and every change of a signed record take it before reading the record |
| `select ... for update` | the row a command will change; the state engine locks the state row | `platform.transition` |
| `select ... for share` | a trigger or function that allows a change only in some states reads the state row this way, so it waits for a transition in flight | the rule in the header of kernel 0550, example `platform.stub_record_edit_guard` (0551) |
| `lock table pg_catalog.pg_authid` | the migration runner, to create roles one database at a time | [migrate](../../packages/kernel/src/db/migrate.ts#sym=migrate) |
| `for update skip locked`, `nowait` | workers that must not wait for a row another worker holds | the outbox workers ([0510_platform_outbox.sql](../../packages/kernel/sql/0510_platform_outbox.sql)) claim pending messages this way |

Rules that came out of real defects:

- **Lock first, then read, then decide.** Two concurrent policy tightenings left a batch on a looser policy (P1-F26);
  edit and submit read each other without locks (P1-F44). Both are in the
  [concurrency section of the defect log](08-defect-log.md#concurrency-and-locking).
- **Walk every lock order.** The container close and hold race (P3 slice 3c) was fixed by one order: container lock
  first, then hold.
- **One lock per thing that must not happen twice.** A source container could be charged twice at once until a charge
  waited for the take lock (P3 slice 5); the AQL severity switched under concurrent batches until a per-product lock.
- **No function with a side effect in a `WHERE` clause**, a view's select list or an index: PostgreSQL may call it
  more than once or not at all (P4 review register).
- **Anything hashed or signed must sort with `collate "C"`**, or a database with another collation changes the order
  ([defect log, collation](08-defect-log.md#p3-exit-medium-collation-changed-signing-order)).

Before you rely on a locking or isolation behaviour, check it on the real server with two `psql` sessions (skill
`postgres-oracle`, [.claude/skills/postgres-oracle/SKILL.md](../../.claude/skills/postgres-oracle/SKILL.md)) and write
down the statements and results.

## How to read a guard

A **guard** is any database code that refuses something: a check constraint, a trigger, a check inside a function, a
state-engine guard, a missing grant. To understand one:

1. **Start from the error code.** Search the SQL for it:
   `grep -rn "EBMR-ESIG-015" packages/*/sql apps/*/sql`. The [error codes page](reference/error-codes.md) lists the same.
2. **Find the version in force** of the function that raises it ([above](#create-or-replace-finding-the-version-in-force)).
   An older file may still contain the code with different logic.
3. **Read the header of that migration.** Headers explain the pharma reason, the finding that led to the change, and
   what earlier headers got wrong. They are long on purpose.
4. **Find who calls the function.** A guard function is called from a trigger (`create trigger ... execute function`),
   from a writing function, or registered as a state guard (`platform.register_guard`). Search for its name across all
   four folders. The code map's graph does not see calls inside SQL bodies; `grep` does.
5. **Note the locks it takes** before reading, and in which isolation level it is meant to run.
6. **Find the tests**: search the test folders for the error code and for the control IDs in the header. A guard with
   no test that names its code is a gap.

## Time in the database

GMP times come from the database clock, never from the application or the browser (INV-16, DI-27). The rules:

- **`clock_timestamp()`**, the actual time of the statement, is used for recorded times (about 790 uses). `now()` is
  the start of the transaction and is used only where that is the point (two uses, as a lower bound).
  `transaction_timestamp()` appears where a check must compare with the start of the transaction.
- **Forced columns.** Every event-time column has `default clock_timestamp()` and is registered with
  [platform.enforce_db_time](../../packages/kernel/sql/0500_platform_base.sql#sym=platform.enforce_db_time). Its trigger
  `a0_db_time_<table>` ([platform.force_db_time](../../packages/kernel/sql/0500_platform_base.sql#sym=platform.force_db_time))
  overwrites any value given on insert and keeps the stored value on update, even against owner-level code.
  [platform.time_model_violations](../../packages/kernel/sql/0500_platform_base.sql#sym=platform.time_model_violations)
  is the invariant query: it must return no rows.
- **Two times per event.** `recorded_at` is the database's; `occurred_at` is an optional claimed time with a trust
  level (`DEVICE_SYNCED`, `DEVICE_UNSYNCED`, `USER_CLAIMED`, `PAPER`). A person may claim only `USER_CLAIMED` or
  `PAPER`, which makes the entry a late entry with a reason
  ([0530_platform_time_model.sql](../../packages/kernel/sql/0530_platform_time_model.sql)).
- **Exact ages without JavaScript numbers.** Where the server needs microseconds it reads them from the database as
  `bigint` ([dbNowUs](../../apps/tablets-server/src/platform/db/commands.ts#sym=dbNowUs)). The server's own clock
  module ([clock.ts](../../apps/tablets-server/src/platform/clock.ts)) serves only in-memory ticket lifetimes, never a
  record.
- **Site time.** Entries store UTC plus the site's zone (policy `site.zone`). "Today" is computed in the site's zone,
  not in a zone the client names ([defect log, P1-F27](08-defect-log.md#p1-f27-today-taken-in-a-zone-the-client-named)).

### libfaketime for the golden batches

The golden batches GB-T-01 and GB-T-02 run a whole batch, many hours of process time, in minutes. Their PostgreSQL runs
under **libfaketime**, a library preloaded into the server process that changes what the operating system tells it the
time is. The test writes the time into a file (`FAKETIME_TIMESTAMP_FILE`, read again on every call because
`FAKETIME_NO_CACHE=1`); the database reads the faked time through `clock_timestamp()` as usual. Nothing in the GMP code
knows about a test clock.

- The file holds either an offset (`+<seconds>s`) or a frozen instant (`YYYY-MM-DD HH:MM:SS`, UTC). GB-T-01 freezes the
  clock and ticks one second before each act, so every run produces the same times and the same true-copy hash.
- [clock.ts](../../apps/tablets-server/test/golden/clock.ts) only moves the clock forward
  ([freezeAt](../../apps/tablets-server/test/golden/clock.ts#sym=freezeAt),
  [advanceSeconds](../../apps/tablets-server/test/golden/clock.ts#sym=advanceSeconds)).
- It runs on its own cluster (`golden`, port 5435 on a development pod; in CI the golden job's own cluster on 5433),
  because libfaketime applies to the whole server process.

How to run them is in [Testing and debugging](06-testing-and-debugging.md#golden-batches).

## Test databases

Tests never share a database. The pattern is **build a template once, copy it per test file**:

1. A **global set-up** file runs once per test run and builds a template database with every migration applied, under
   a unique name, so parallel runs never collide:
   - `db` project: [packages/kernel/test/support/global-setup.ts](../../packages/kernel/test/support/global-setup.ts)
     builds `ebmr_tpl_<hex>` (kernel, site-services, recipe-core, test fixtures)
     ([buildTemplate](../../packages/kernel/test/support/global-setup.ts#sym=buildTemplate)).
   - `server` project: [apps/tablets-server/test/support/global-setup.ts](../../apps/tablets-server/test/support/global-setup.ts)
     builds a GMP template and a sandbox template (`ebmr_sandbox_tpl<hex>`), with the tablets SQL, bootstrapped and
     seeded with the demo personas through test-kit.
   - Browser suite: [tools/e2e/global-setup.ts](../../tools/e2e/global-setup.ts) creates `ebmr_tablets_e2e_<hex>` and
     `ebmr_sandbox_tablets_e2e_<hex>` and starts the stack.
2. Each test file copies the template (`create database <name> template <template>`, a fast file copy):
   [createTestDatabase](../../packages/kernel/test/support/db.ts#sym=createTestDatabase) gives `ebmr_t_<hex>` with an
   admin pool and an application-role pool; the server harness
   ([startServer](../../apps/tablets-server/test/support/harness.ts#sym=startServer)) copies the GMP or sandbox template.
   The copy re-applies the database-level privileges (no TEMPORARY, the connect policy), which a template copy loses.
3. At the end, each file drops its copy (`drop database ... with (force)`) and the global set-up drops the template.

Variables:

| Variable | Effect |
|---|---|
| `EBMR_PG_ADMIN_URL` | superuser connection for tests and tools (default `postgres://ebmr_dev:ebmr_dev@localhost:5432/postgres`) |
| `EBMR_MIGRATIONS` | regular expression limiting which kernel, site-services and recipe-core files the `db` template gets, for example `^0(0|1)` while developing one module. The full suite always applies everything. |
| `EBMR_TEMPLATE_DB` | use an already migrated template instead of building one (the SQL mutation harness sets it) |
| `EBMR_SERVER_TEMPLATES` | JSON file naming prepared GMP and sandbox templates for the `server` project (the SQL mutation harness sets it) |
| `EBMR_FAKETIME_FILE` | the libfaketime file; without it the golden tests do not run |

Pools in test-kit are opened with `openPool` and ended with `endPool`, which waits until every socket has closed.
`pg-pool`'s own `end()` returns earlier, and a forced drop right after it killed backends still closing (FATAL 57P01;
[defect log, test flakiness](08-defect-log.md#test-flakiness-and-races)).

A test file that is cancelled can leave its copy behind. Leftover `ebmr_t_*` and `ebmr_tpl_*` databases on your own
spare cluster can be dropped; never drop databases on a cluster another run is using, and never the demo databases
(`ebmr_tablets_demo`, `ebmr_sandbox_tablets_demo`).

## The clusters

A PostgreSQL **cluster** is one server process with its own port and data directory. The development pod has four,
created by [tools/dev-env/runpod-setup.sh](../../tools/dev-env/runpod-setup.sh):

| Cluster | Port | Use |
|---|---|---|
| `main` | 5432 | default `EBMR_PG_ADMIN_URL`; everyday tests, the demo databases |
| `ci` | 5433 | spare, for a second test run or a mutation run in parallel |
| `ci2` | 5434 | spare, as above |
| `golden` | 5435 | runs under libfaketime, for the golden batches only |

Point any test or tool at another cluster with
`EBMR_PG_ADMIN_URL=postgres://ebmr_dev:ebmr_dev@localhost:5433/postgres`. Check what is up with `pg_lsclusters`;
start one with `sudo pg_ctlcluster 16 main start` (a restarted pod comes up with the clusters stopped). Ask before
stopping a cluster or dropping a database you did not create. Details: skill `local-ci`
([.claude/skills/local-ci/SKILL.md](../../.claude/skills/local-ci/SKILL.md)).

## The SQL mutation harness

Mutation testing changes the code on purpose (a **mutant**) and runs the tests: if no test fails, the tests do not
really check that line. [tools/sql-mutation](../../tools/sql-mutation/) does this for database functions; Stryker does
it for TypeScript ([Testing and debugging](06-testing-and-debugging.md#mutation-testing)).

- **Operators** ([mutators.ts](../../tools/sql-mutation/src/mutators.ts#sym=mutantsOf)): `GUARD_REMOVED` (a
  `raise exception` becomes `null;`), `RELATIONAL` (`<` to `<=` and so on), `LOGICAL` (`and` to `or`), `NOT_REMOVED`,
  `BOOLEAN`.
- **Groups** ([TARGETS](../../tools/sql-mutation/src/targets.ts#sym=TARGETS), 80 groups): each lists functions, the
  test files that must detect their mutants, and a threshold (90 %). A function belongs to one group only.
- **How a mutant runs**: the harness builds the same templates the test set-ups build, copies them per mutant, applies
  the mutated function with `create or replace` as its owner (so owner, grants, `SECURITY DEFINER` and `search_path`
  stay), and runs the group's tests with `EBMR_TEMPLATE_DB` or `EBMR_SERVER_TEMPLATES`. A mutant is KILLED when a
  test fails, SURVIVED when all pass, TIMEOUT (counted as detected) or INVALID (PostgreSQL rejected it; not counted).
- It mutates **the version in force** of each function (the last definition across all migrations).
- Equivalent mutants (no input can tell them apart) are recorded with the reasoning in
  [equivalent.json](../../tools/sql-mutation/equivalent.json). "Hard to test" is not equivalence.

How to run it and act on survivors: skill `mutation-check`
([.claude/skills/mutation-check/SKILL.md](../../.claude/skills/mutation-check/SKILL.md)) and
[Testing and debugging](06-testing-and-debugging.md#mutation-testing). The harness has found real defects, guards that
could not fire ([defect log, D-series](08-defect-log.md#d-series-sql-mutation-guards-that-could-not-fire)).

## Pitfalls

- Editing an applied migration: the runner refuses the database. Add a new file.
- Replacing a function without repeating `security definer` and its `set search_path`: the replacement silently runs
  as the caller. Compare with the previous definition line by line.
- Changing a function's argument list with `create or replace`: PostgreSQL creates a second function; the old one stays
  callable with its old grants.
- Granting to `ebmr_app` a function that writes without checking the actor or the permission: the application role is
  not trusted; every definer function checks who acts.
- Reading a guard in an old file: always find the version in force.
- Relying on REPEATABLE READ or SERIALIZABLE for a write: signings refuse it, and snapshots taken before a lock wait
  hide what committed meanwhile.
- `now()` where you meant the time of the statement: use `clock_timestamp()`.
- Sorting hashed or signed content without `collate "C"`.
- A function with side effects in `WHERE`.
- Testing a guard only through the server: a TypeScript pre-check can hide that the database guard is broken. Test the
  database guard as the application role (see [Testing and debugging](06-testing-and-debugging.md)).

## Related pages

- [Architecture](03-architecture.md): packages, boundaries and the request path.
- [Testing and debugging](06-testing-and-debugging.md): test layers, CI, debugging a failing guard.
- [Defects and lessons](08-defect-log.md): the real cases behind the rules on this page.
- [Database catalogue](reference/db-catalogue.md) and [Error codes](reference/error-codes.md) (generated).
- Module guides: [kernel](modules/kernel.md), [site-services](modules/site-services.md),
  [recipe-core](modules/recipe-core.md), [tablets-server](modules/tablets-server.md).
