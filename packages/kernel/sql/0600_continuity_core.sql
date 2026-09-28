-- Continuity core (build outline 4.2 "High availability and restore", 5.3, 5.4; ADR 0007 decision 6;
-- controls DI-45, DI-13; invariants INV-27 and the restore-event part of INV-08).
--
-- 1. Protected identifier sources. Every identifier that must never be reused (batch numbers,
--    contingency-form numbers, signature and user numbers, audit event and anchor ids) is registered
--    in continuity.protected_sequence, either as a PostgreSQL sequence or as a protected COUNTER.
--    * COUNTER (strict): transactional. Before the database may issue values up to a ceiling, that
--      ceiling is written to an external ledger outside the database (write-ahead; see
--      src/continuity/numbers.ts). The ceiling is bound to the database incarnation (cluster system
--      identifier, WAL timeline, database OID, counter table OID), so a database restored into a new
--      database or cluster, restored to a point in time, copied or failed over refuses to issue
--      numbers until the restore procedure has run. It is also bound to the start of the server: a
--      physical copy started by crash recovery (a base backup started without recovery.signal, a
--      storage or VM snapshot rolled back) keeps every part of the incarnation, so after any server
--      start the rest of the block in force is retired (it may have been issued before a rollback)
--      and issue continues from a new block above everything the ledger holds.
--    * PG_SEQUENCE (surrogate ids): high-water marks are exported with every external anchor; after a
--      restore the sequence moves past max(external mark, current value) plus a registered margin.
-- 2. The database is bound to the external ledger by its first anchor (database_incarnation).
--    A copy of a bound database (another incarnation) writes nothing to the audit trail until its
--    identifiers are secured (continuity.secure_identifiers: every protected sequence moves past the
--    ledger, the login names the ledger holds are reserved), so no identifier the original issued
--    after the backup is handed out again, not even by the restore procedure's own records.
-- 3. Restore events. A restore or failover is recorded by the operator (the database itself compares
--    the external anchors with the restored chains), approved by every named second person, and
--    completed by continuity.after_restore, which moves every protected source past the highest
--    value in the external ledger and re-enables number issue.
-- 4. External anchors that no longer match after a restore are reported as covered only when an
--    approved restore event names that anchor and that chain, and only for history the restored
--    chain no longer has (continuity.verify_external_anchors). A chain purged under its retention is
--    checked against its tombstone (records.tombstone).
--
-- Error codes: EBMR-CONT-0xx.

create schema if not exists continuity authorization ebmr_owner;
revoke all on schema continuity from public;
grant usage on schema continuity to ebmr_app;

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Protected identifier registry and counters
-- ---------------------------------------------------------------------------------------------

create table continuity.protected_sequence (
  sequence_key     text primary key
                   check (sequence_key ~ '^[a-z][a-z0-9_.]*(:[A-Za-z0-9_.-]+)?$' and length(sequence_key) <= 200),
  source_kind      text not null check (source_kind in ('PG_SEQUENCE', 'COUNTER')),
  pg_sequence      regclass unique,
  identifier_kind  text not null check (identifier_kind in ('BATCH_NUMBER', 'CONTINGENCY_FORM_NUMBER', 'SIGNATURE_ID',
                                                            'USER_ID', 'AUDIT_EVENT_ID', 'AUDIT_ANCHOR_ID', 'OTHER')),
  owner_module     text not null check (owner_module ~ '^[a-z][a-z0-9-]*$'),
  description      text not null check (length(trim(description)) > 0),
  -- PG_SEQUENCE: values that may have been issued after the last exported high-water mark.
  restore_margin   bigint not null default 0 check (restore_margin >= 0),
  -- COUNTER: how many values one write-ahead reservation covers.
  block_size       bigint check (block_size between 1 and 100000),
  -- COUNTER: the scope the counter belongs to ({site}), when the owning module registered one; its
  -- ceilings are reserved only by a grant covering that scope (DI-17). Without it: the actor's location.
  owner_scope      jsonb check (owner_scope is null or (jsonb_typeof(owner_scope) = 'object' and owner_scope <> '{}'::jsonb)),
  registered_at    timestamptz not null default clock_timestamp(),
  check ((source_kind = 'PG_SEQUENCE') = (pg_sequence is not null)),
  check ((source_kind = 'COUNTER') = (block_size is not null)),
  check (source_kind = 'COUNTER' or restore_margin > 0),
  check (source_kind = 'COUNTER' or owner_scope is null)
);

create table continuity.counter (
  sequence_key        text primary key references continuity.protected_sequence (sequence_key),
  last_value          bigint not null default 0 check (last_value >= 0),
  reserved_ceiling    bigint not null default 0,
  ceiling_incarnation text,
  ceiling_started_at  timestamptz,   -- server start under which the block in force was reserved
  check (reserved_ceiling >= last_value)
);

-- The database incarnations bound to the external ledger. The first anchor export binds the
-- database; a restored, copied or failed-over copy (another incarnation) is added only when its
-- identifiers have been secured. Rows are permanent.
create table continuity.database_incarnation (
  incarnation    text primary key,
  bound_by       text not null check (bound_by in ('ANCHOR_EXPORT', 'IDENTIFIERS_SECURED', 'RESTORE_COMPLETED')),
  recorded_at    timestamptz not null default clock_timestamp(),
  correlation_id uuid
);

-- Registrations are permanent; counters never move backwards and are never removed, even by the
-- table owner. (A superuser who disables these triggers is recorded in kernel.ddl_log.)
create function continuity.guard_registry() returns trigger
language plpgsql security definer set search_path = pg_catalog, continuity, pg_temp as $$
begin
  if tg_table_name = 'counter' and tg_op = 'UPDATE' then
    if new.sequence_key <> old.sequence_key or new.last_value < old.last_value or new.reserved_ceiling < old.reserved_ceiling then
      raise exception using errcode = 'P0001', message = 'EBMR-CONT-016 a protected counter never moves backwards';
    end if;
    return new;
  end if;
  raise exception using errcode = 'P0001',
    message = format('EBMR-CONT-016 %s rows are permanent; %s is refused', tg_table_name, lower(tg_op));
end
$$;

create trigger aa_guard_protected_sequence before update or delete on continuity.protected_sequence
  for each row execute function continuity.guard_registry();
create trigger aa_guard_protected_sequence_truncate before truncate on continuity.protected_sequence
  for each statement execute function continuity.guard_registry();
create trigger aa_guard_counter before update or delete on continuity.counter
  for each row execute function continuity.guard_registry();
create trigger aa_guard_counter_truncate before truncate on continuity.counter
  for each statement execute function continuity.guard_registry();
create trigger aa_guard_database_incarnation before update or delete on continuity.database_incarnation
  for each row execute function continuity.guard_registry();
create trigger aa_guard_database_incarnation_truncate before truncate on continuity.database_incarnation
  for each statement execute function continuity.guard_registry();

-- Write-ahead reservations: the ceiling was stored in the external ledger before this row.
create table continuity.ceiling_reservation (
  id               uuid primary key default gen_random_uuid(),
  sequence_key     text not null references continuity.protected_sequence (sequence_key),
  previous_ceiling bigint not null,
  new_ceiling      bigint not null,
  external_floor   bigint not null,
  ledger_receipt   text not null check (length(ledger_receipt) between 1 and 200),
  incarnation      text not null,
  server_started_at timestamptz not null,
  recorded_at      timestamptz not null default clock_timestamp(),
  correlation_id   uuid not null,
  check (new_ceiling > previous_ceiling)
);

-- ---------------------------------------------------------------------------------------------
-- Restore events
-- ---------------------------------------------------------------------------------------------

create table continuity.restore_event (
  id                   uuid primary key,
  event_kind           text not null check (event_kind in ('FULL_RESTORE', 'POINT_IN_TIME_RESTORE', 'FAILOVER', 'CLUSTER_MIGRATION')),
  backup_id            text,          -- not a foreign key: the restored catalogue predates this backup's own entry
  backup_taken_at      timestamptz,   -- claimed, from the backup manifest
  restore_point        timestamptz,   -- claimed: recovery target, or the backup snapshot time
  performed_at         timestamptz not null,  -- claimed: when the operator performed the restore or failover
  reason               text not null check (length(trim(reason)) > 0),
  change_reference     text not null check (length(trim(change_reference)) > 0),
  operator_person_id   uuid not null,
  operator_account_id  uuid not null,
  operator_role_code   text not null,
  approver_person_ids  uuid[] not null check (cardinality(approver_person_ids) >= 1),
  new_incarnation      text not null,
  anchor_comparison    jsonb not null,
  discarded_anchor_ids bigint[] not null,
  affected_chains      jsonb not null,  -- [{chain_key, restored_seq, external_seq}]
  affected_chain_keys  text[] not null,
  content_hash         bytea not null,
  recorded_at          timestamptz not null,
  correlation_id       uuid not null,
  check (not (operator_person_id = any (approver_person_ids))),
  check (event_kind in ('FAILOVER', 'CLUSTER_MIGRATION') or (backup_id is not null and backup_taken_at is not null))
);

create table continuity.restore_event_approval (
  id                    uuid primary key default gen_random_uuid(),
  restore_event_id      uuid not null references continuity.restore_event (id),
  approver_person_id    uuid not null,
  approver_account_id   uuid not null,
  approver_role_code    text not null,
  approved_content_hash bytea not null,
  signature_id          uuid,   -- electronic signature (e-signature module) once wired by the lead
  recorded_at           timestamptz not null default clock_timestamp(),
  correlation_id        uuid not null,
  unique (restore_event_id, approver_person_id)
);

create table continuity.restore_completion (
  restore_event_id      uuid primary key references continuity.restore_event (id),
  completed_by_person_id  uuid not null,
  completed_by_account_id uuid not null,
  incarnation           text not null,
  bumps                 jsonb not null,
  recorded_at           timestamptz not null default clock_timestamp(),
  correlation_id        uuid not null
);

-- Every move of a protected source past values that may have been issued elsewhere:
--   RESTORE_EVENT        completion of an approved restore event;
--   LEDGER_AHEAD         a reservation found the external ledger ahead of the database;
--   SERVER_RESTART       the rest of a counter block reserved before the server started was retired;
--   IDENTIFIERS_SECURED  a copy of the database secured its identifiers before its first write.
create table continuity.sequence_bump (
  id                uuid primary key default gen_random_uuid(),
  sequence_key      text not null,   -- a registered key, or 'unregistered:<sequence>'
  source_kind       text not null check (source_kind in ('PG_SEQUENCE', 'COUNTER')),
  reason            text not null check (reason in ('RESTORE_EVENT', 'LEDGER_AHEAD', 'SERVER_RESTART', 'IDENTIFIERS_SECURED')),
  restore_event_id  uuid references continuity.restore_event (id),
  value_before      bigint not null,
  external_value    bigint,
  value_after       bigint not null,
  recorded_at       timestamptz not null default clock_timestamp(),
  correlation_id    uuid not null,
  check (value_after >= value_before),
  check ((reason = 'RESTORE_EVENT') = (restore_event_id is not null))
);

-- ---------------------------------------------------------------------------------------------
-- Alarms (backup failures, failed drills, ledger ahead of the database, broken audit chains). The
-- lead may route these to the platform alarm table and the incident register during integration.
-- ---------------------------------------------------------------------------------------------

create table continuity.alarm (
  id             uuid primary key default gen_random_uuid(),
  alarm_code     text not null check (alarm_code ~ '^[A-Z][A-Z0-9_]*$'),
  severity       text not null check (severity in ('CRITICAL', 'HIGH', 'WARNING')),
  subject        text not null check (length(trim(subject)) > 0),
  details        jsonb not null default '{}'::jsonb,
  recorded_at    timestamptz not null default clock_timestamp(),
  correlation_id uuid not null
);

create table continuity.alarm_acknowledgement (
  alarm_id                   uuid primary key references continuity.alarm (id),
  acknowledged_by_person_id  uuid not null,
  acknowledged_by_account_id uuid not null,
  comment                    text not null check (length(trim(comment)) > 0),
  recorded_at                timestamptz not null default clock_timestamp(),
  correlation_id             uuid not null
);

select kernel.register_audited_table('continuity.ceiling_reservation', 'number_sequence', 'sequence_key', true);
select kernel.register_audited_table('continuity.sequence_bump', 'number_sequence', 'sequence_key', true);
select kernel.register_audited_table('continuity.restore_event', 'restore_event', 'id', true);
select kernel.register_audited_table('continuity.restore_event_approval', 'restore_event', 'restore_event_id', true);
select kernel.register_audited_table('continuity.restore_completion', 'restore_event', 'restore_event_id', true);
select kernel.register_audited_table('continuity.alarm', 'continuity_alarm', 'id', true);
select kernel.register_audited_table('continuity.alarm_acknowledgement', 'continuity_alarm', 'alarm_id', true);

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

create function continuity.require_actor() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx jsonb := kernel.current_actor();
begin
  if v_ctx is null then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-001 no actor context: call kernel.begin_command first';
  end if;
  return v_ctx;
end
$$;

create function continuity.utc_text(p_at timestamptz) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

-- Identity of this physical database: changes on a restore into a new database or cluster, on a
-- point-in-time restore or failover (new WAL timeline), and when the continuity schema is dropped and
-- recreated by a restore into the same database. It does NOT change when a physical copy of the
-- cluster (a base backup, a storage or VM snapshot) is started by crash recovery on the same timeline:
-- counters are therefore also bound to the server start (pg_postmaster_start_time), see
-- next_counter_value and reserve_counter_ceiling.
create function continuity.current_incarnation() returns text
language plpgsql stable security definer set search_path = pg_catalog, continuity, pg_temp as $$
declare
  v_timeline text;
begin
  begin
    v_timeline := substr(pg_catalog.pg_walfile_name(pg_catalog.pg_current_wal_lsn()), 1, 8);
  exception when others then
    v_timeline := 'recovery';
  end;
  return (select system_identifier::text from pg_catalog.pg_control_system()) || ':' || v_timeline || ':'
      || (select d.oid::text from pg_catalog.pg_database d where d.datname = current_database()) || ':'
      || 'continuity.counter'::regclass::oid::text;
end
$$;

-- INV-27: may this database write to the audit trail and hand out identifiers? Yes when it was never
-- bound to the external ledger, or when this incarnation is bound (the original) or was secured.
create function continuity.identifiers_secured() returns boolean
language plpgsql stable security definer set search_path = pg_catalog, continuity, pg_temp as $$
begin
  if not exists (select 1 from continuity.database_incarnation) then
    return true;
  end if;
  return exists (select 1 from continuity.database_incarnation d where d.incarnation = continuity.current_incarnation());
end
$$;

-- The gate: a copy of a bound database (restored, copied or failed over) writes no audit event and
-- no anchor before its identifiers are secured, so nothing written there takes an audit event id,
-- an anchor id or any protected number that the original may already have issued (INV-27). The first
-- anchor binds the database: anchors are what the anchor job copies to the external ledger, with the
-- high-water marks of every protected source.
create function continuity.guard_identifiers_secured() returns trigger
language plpgsql security definer set search_path = pg_catalog, continuity, pg_temp as $$
begin
  if tg_table_name = 'audit_anchor' and not exists (select 1 from continuity.database_incarnation) then
    insert into continuity.database_incarnation (incarnation, bound_by) values (continuity.current_incarnation(), 'ANCHOR_EXPORT')
    on conflict (incarnation) do nothing;
  end if;
  if not continuity.identifiers_secured() then
    raise exception using errcode = 'P0001',
      message = format('EBMR-CONT-017 this database is a restored, copied or failed-over copy (incarnation %s) whose identifiers are not secured yet; start the restore procedure (secure the identifiers, then record the restore event) before any other write',
                       continuity.current_incarnation());
  end if;
  return null;
end
$$;

create trigger aa_continuity_identifiers_secured before insert on kernel.audit_event
  for each statement execute function continuity.guard_identifiers_secured();
create trigger aa_continuity_identifiers_secured before insert on kernel.audit_anchor
  for each statement execute function continuity.guard_identifiers_secured();

create function continuity.raise_alarm(p_code text, p_severity text, p_subject text, p_details jsonb default '{}'::jsonb)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx jsonb := continuity.require_actor();
  v_id uuid;
begin
  insert into continuity.alarm (alarm_code, severity, subject, details, correlation_id)
  values (p_code, p_severity, p_subject, coalesce(p_details, '{}'::jsonb), (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function continuity.acknowledge_alarm(p_alarm_id uuid, p_comment text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx jsonb := continuity.require_actor();
begin
  -- DI-17 installation-wide (infrastructure alarms, not GMP data: no DI-18 guard, see README).
  perform iam.require_permission('CONTINUITY.ALARM_ACKNOWLEDGE', '{}'::jsonb);
  if not exists (select 1 from continuity.alarm a where a.id = p_alarm_id) then
    raise exception using errcode = 'P0001', message = format('EBMR-CONT-032 alarm %s does not exist', p_alarm_id);
  end if;
  if coalesce(trim(p_comment), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-032 an acknowledgement needs a comment';
  end if;
  if exists (select 1 from continuity.alarm_acknowledgement k where k.alarm_id = p_alarm_id) then
    raise exception using errcode = 'P0001', message = format('EBMR-CONT-032 alarm %s is already acknowledged', p_alarm_id);
  end if;
  insert into continuity.alarm_acknowledgement (alarm_id, acknowledged_by_person_id, acknowledged_by_account_id, comment, correlation_id)
  values (p_alarm_id, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, p_comment, (v_ctx ->> 'correlation_id')::uuid);
end
$$;

create view continuity.open_alarm as
  select a.* from continuity.alarm a
  where not exists (select 1 from continuity.alarm_acknowledgement k where k.alarm_id = a.id);

-- DI-23: a scheduled chain verification that finds a break (kernel.run_chain_verification, a CRITICAL
-- run) becomes a CRITICAL continuity alarm, acknowledged like every continuity alarm. One alarm per
-- run; runs already alarmed are skipped. Returns how many alarms were raised.
create function continuity.raise_integrity_alarms() returns integer
language plpgsql volatile security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx jsonb := continuity.require_actor();
  r     kernel.audit_verification_run%rowtype;
  v_n   integer := 0;
begin
  if v_ctx ->> 'source' <> 'SYSTEM' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-033 integrity alarms are raised only by a system service account (source SYSTEM)';
  end if;
  -- DI-17 installation-wide (continuity job results: no DI-18 guard, see README).
  perform iam.require_permission('CONTINUITY.BACKUP_RECORD', '{}'::jsonb);
  -- One caller at a time, so a run is never alarmed twice.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('continuity.raise_integrity_alarms', 0));
  for r in
    select * from kernel.audit_verification_run v
    where v.alarm_severity = 'CRITICAL'
      and not exists (select 1 from continuity.alarm a
                      where a.alarm_code = 'AUDIT_CHAIN_BROKEN' and a.details ->> 'verification_run_id' = v.id::text)
    order by v.id
  loop
    perform continuity.raise_alarm('AUDIT_CHAIN_BROKEN', 'CRITICAL',
      format('Audit chain verification run %s found %s problem(s); first: chain %s at seq %s: %s', r.id, r.problem_count,
             r.problems -> 0 ->> 'chain_key', r.problems -> 0 ->> 'seq', r.problems -> 0 ->> 'problem'),
      jsonb_build_object('verification_run_id', r.id::text, 'problem_count', r.problem_count, 'problems', r.problems,
                         'finished_at', continuity.utc_text(r.finished_at)));
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Registration (called from migrations, running as ebmr_owner; not granted to the application)
-- ---------------------------------------------------------------------------------------------

create function continuity.register_protected_sequence(
  p_key text, p_sequence regclass, p_identifier_kind text, p_owner_module text, p_description text, p_restore_margin bigint
) returns void
language plpgsql volatile security definer set search_path = pg_catalog, continuity, pg_temp as $$
declare
  v_class pg_catalog.pg_class%rowtype;
begin
  select * into v_class from pg_catalog.pg_class c where c.oid = p_sequence;
  if not found or v_class.relkind <> 'S' then
    raise exception using errcode = 'P0001', message = format('EBMR-CONT-015 %s is not a sequence', p_sequence);
  end if;
  if pg_catalog.pg_get_userbyid(v_class.relowner) <> 'ebmr_owner' then
    raise exception using errcode = 'P0001', message = format('EBMR-CONT-015 protected sequence %s must be owned by ebmr_owner', p_sequence);
  end if;
  insert into continuity.protected_sequence (sequence_key, source_kind, pg_sequence, identifier_kind, owner_module, description, restore_margin)
  values (p_key, 'PG_SEQUENCE', p_sequence, p_identifier_kind, p_owner_module, p_description, p_restore_margin);
end
$$;

-- p_owner_scope: the scope the counter belongs to (for example {"site": "PLANT1"} for a site's
-- numbering rule); its ceilings are then reserved only under a grant covering that scope.
create function continuity.register_protected_counter(
  p_key text, p_identifier_kind text, p_owner_module text, p_description text, p_block_size bigint default 50,
  p_owner_scope jsonb default null
) returns void
language plpgsql volatile security definer set search_path = pg_catalog, continuity, pg_temp as $$
begin
  insert into continuity.protected_sequence (sequence_key, source_kind, identifier_kind, owner_module, description, block_size, owner_scope)
  values (p_key, 'COUNTER', p_identifier_kind, p_owner_module, p_description, p_block_size, p_owner_scope);
  insert into continuity.counter (sequence_key) values (p_key);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Counters: issue and write-ahead reservation
-- ---------------------------------------------------------------------------------------------

-- Next value of a protected counter. Only SECURITY DEFINER functions of the owning module call this
-- (it is not granted to the application), so every value issued is recorded by that module.
create function continuity.next_counter_value(p_key text) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, continuity, pg_temp as $$
declare
  c continuity.counter%rowtype;
begin
  select * into c from continuity.counter k where k.sequence_key = p_key for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-CONT-010 %s is not a protected counter', p_key);
  end if;
  if c.ceiling_incarnation is not null and c.ceiling_incarnation <> continuity.current_incarnation() then
    raise exception using errcode = 'P0001', detail = p_key,
      message = format('EBMR-CONT-012 the database incarnation changed since the ceiling of %s was reserved (restore, copy or failover); run the restore procedure before issuing numbers', p_key);
  end if;
  -- A block reserved before the server started may already have been issued by the database this
  -- one was copied from (a physical copy started by crash recovery keeps the incarnation): its rest
  -- is never issued; a new block is reserved (and the rest retired) by reserve_counter_ceiling.
  if c.ceiling_incarnation is not null and c.ceiling_started_at is distinct from pg_catalog.pg_postmaster_start_time() then
    raise exception using errcode = 'P0001', detail = p_key,
      message = format('EBMR-CONT-011 the server started after the block of %s was reserved; the rest of that block is retired and a new block must be reserved in the external ledger first', p_key);
  end if;
  if c.ceiling_incarnation is null or c.last_value + 1 > c.reserved_ceiling then
    raise exception using errcode = 'P0001', detail = p_key,
      message = format('EBMR-CONT-011 no reserved ceiling left for %s; reserve a block in the external ledger first', p_key);
  end if;
  update continuity.counter k set last_value = c.last_value + 1 where k.sequence_key = p_key;
  return c.last_value + 1;
end
$$;

-- The scope in which CONTINUITY.COUNTER_RESERVE is checked for a counter (DI-17): the counter's own
-- scope when its owning module registered one (a site's numbering rule), else the actor's location.
create function continuity.counter_scope(p_key text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, continuity, pg_temp as $$
declare
  v_scope jsonb;
begin
  select s.owner_scope into v_scope from continuity.protected_sequence s where s.sequence_key = p_key;
  return coalesce(v_scope, iam.actor_location_scope());
end
$$;

-- First step of a reservation, before anything is written outside the database (F58): the actor is
-- authorised (DI-18, DI-17), the counter is locked for this transaction and must be issuable under
-- this incarnation. Returns what the ledger write needs. The caller then writes the ceiling to the
-- external ledger and acknowledges it with reserve_counter_ceiling in the same transaction.
create function continuity.prepare_counter_reservation(p_key text)
returns table (last_value bigint, reserved_ceiling bigint, block_size bigint)
language plpgsql volatile security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx jsonb := continuity.require_actor();
  c     continuity.counter%rowtype;
  v_block bigint;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('CONTINUITY.COUNTER_RESERVE', continuity.counter_scope(p_key));
  select * into c from continuity.counter k where k.sequence_key = p_key for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-CONT-010 %s is not a protected counter', p_key);
  end if;
  if c.ceiling_incarnation is not null and c.ceiling_incarnation <> continuity.current_incarnation() then
    raise exception using errcode = 'P0001', detail = p_key,
      message = format('EBMR-CONT-012 the database incarnation changed since the ceiling of %s was reserved; run the restore procedure first', p_key);
  end if;
  select s.block_size into v_block from continuity.protected_sequence s where s.sequence_key = p_key;
  last_value := c.last_value; reserved_ceiling := c.reserved_ceiling; block_size := v_block;
  return next;
end
$$;

-- Record a ceiling that has already been written to the external ledger. p_external_floor is the
-- highest ceiling the ledger held for this key before this reservation was written. If the ledger is
-- ahead of the database (a reservation whose acknowledgement was lost, or a restore that was not
-- recorded) the counter first skips to that floor and an alarm is raised. If the ledger is behind the
-- database, the write-ahead rule was broken and the reservation is refused. A block reserved before
-- the server started is retired first (SERVER_RESTART): its values may have been issued already.
create function continuity.reserve_counter_ceiling(p_key text, p_external_floor bigint, p_new_ceiling bigint, p_ledger_receipt text)
returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx jsonb := continuity.require_actor();
  c continuity.counter%rowtype;
  p continuity.protected_sequence%rowtype;
  v_incarnation text := continuity.current_incarnation();
  v_started timestamptz := pg_catalog.pg_postmaster_start_time();
  v_restarted boolean;
  v_base bigint;
  v_last bigint;
begin
  -- DI-18, then DI-17 in the counter's scope (its site), or where the actor works.
  perform iam.assert_not_administrator();
  perform iam.require_permission('CONTINUITY.COUNTER_RESERVE', continuity.counter_scope(p_key));
  select * into c from continuity.counter k where k.sequence_key = p_key for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-CONT-010 %s is not a protected counter', p_key);
  end if;
  select * into p from continuity.protected_sequence s where s.sequence_key = p_key;
  if c.ceiling_incarnation is not null and c.ceiling_incarnation <> v_incarnation then
    raise exception using errcode = 'P0001', detail = p_key,
      message = format('EBMR-CONT-012 the database incarnation changed since the ceiling of %s was reserved; run the restore procedure first', p_key);
  end if;
  if p_external_floor is null or p_external_floor < 0 or p_new_ceiling is null or coalesce(trim(p_ledger_receipt), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-014 a reservation needs the external floor, the new ceiling and the ledger receipt';
  end if;
  v_restarted := c.ceiling_incarnation is not null and c.ceiling_started_at is distinct from v_started;
  if p_new_ceiling <= c.reserved_ceiling and c.ceiling_incarnation = v_incarnation and not v_restarted then
    return c.reserved_ceiling;   -- another reservation already covers it (idempotent)
  end if;
  if p_external_floor < c.reserved_ceiling then
    raise exception using errcode = 'P0001', detail = p_key,
      message = format('EBMR-CONT-013 the external ledger (%s) is behind the database ceiling (%s) for %s; the write-ahead record is missing', p_external_floor, c.reserved_ceiling, p_key);
  end if;
  v_last := c.last_value;
  if v_restarted and c.reserved_ceiling > c.last_value then
    insert into continuity.sequence_bump (sequence_key, source_kind, reason, value_before, external_value, value_after, correlation_id)
    values (p_key, 'COUNTER', 'SERVER_RESTART', c.last_value, p_external_floor, c.reserved_ceiling, (v_ctx ->> 'correlation_id')::uuid);
    v_last := c.reserved_ceiling;
  end if;
  if p_external_floor > greatest(v_last, c.reserved_ceiling) then
    insert into continuity.sequence_bump (sequence_key, source_kind, reason, value_before, external_value, value_after, correlation_id)
    values (p_key, 'COUNTER', 'LEDGER_AHEAD', v_last, p_external_floor, p_external_floor, (v_ctx ->> 'correlation_id')::uuid);
    perform continuity.raise_alarm('LEDGER_AHEAD', 'CRITICAL',
      format('External ledger ceiling for %s is ahead of the database; values up to %s are skipped', p_key, p_external_floor),
      jsonb_build_object('sequence_key', p_key, 'database_last_value', c.last_value, 'database_ceiling', c.reserved_ceiling,
                         'external_floor', p_external_floor));
    v_last := p_external_floor;
  end if;
  v_base := greatest(v_last, c.reserved_ceiling, p_external_floor);
  if p_new_ceiling <= v_base or p_new_ceiling > v_base + p.block_size then
    raise exception using errcode = 'P0001', detail = p_key,
      message = format('EBMR-CONT-014 new ceiling %s for %s must lie in (%s, %s]', p_new_ceiling, p_key, v_base, v_base + p.block_size);
  end if;
  insert into continuity.ceiling_reservation (sequence_key, previous_ceiling, new_ceiling, external_floor, ledger_receipt, incarnation,
                                              server_started_at, correlation_id)
  values (p_key, c.reserved_ceiling, p_new_ceiling, p_external_floor, p_ledger_receipt, v_incarnation, v_started,
          (v_ctx ->> 'correlation_id')::uuid);
  update continuity.counter k
     set last_value = v_last, reserved_ceiling = p_new_ceiling, ceiling_incarnation = v_incarnation, ceiling_started_at = v_started
   where k.sequence_key = p_key;
  return p_new_ceiling;
end
$$;

-- High-water marks of every protected source, exported with each external anchor.
create function continuity.sequence_high_water()
returns table (sequence_key text, source_kind text, last_value bigint, reserved_ceiling bigint)
language sql stable security definer set search_path = pg_catalog, continuity, pg_temp as $$
  select p.sequence_key, p.source_kind,
         case when p.source_kind = 'COUNTER' then c.last_value else coalesce(pg_catalog.pg_sequence_last_value(p.pg_sequence), 0) end,
         c.reserved_ceiling
  from continuity.protected_sequence p
  left join continuity.counter c on c.sequence_key = p.sequence_key
  order by p.sequence_key
$$;

-- Invariant query (INV-27): sequences in the database that no module has registered as protected.
-- In production it must return zero rows; after_restore still moves them forward as a safety net.
create function continuity.unprotected_sequences() returns table (sequence_name text, owner_name text)
language sql stable security definer set search_path = pg_catalog, continuity, pg_temp as $$
  select c.oid::regclass::text, pg_catalog.pg_get_userbyid(c.relowner)::text
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'S'
    and n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp%'
    and not exists (select 1 from continuity.protected_sequence p where p.pg_sequence = c.oid)
  order by 1
$$;

-- Invariant query (INV-27): counters in an impossible state.
create function continuity.number_invariant_violations() returns table (sequence_key text, problem text)
language sql stable security definer set search_path = pg_catalog, continuity, pg_temp as $$
  select c.sequence_key, 'counter is below a value it already moved past'
  from continuity.counter c
  where c.last_value < coalesce((select max(b.value_after) from continuity.sequence_bump b where b.sequence_key = c.sequence_key), 0)
  union all
  select c.sequence_key, 'reserved ceiling is below a ceiling that was acknowledged'
  from continuity.counter c
  where c.reserved_ceiling < coalesce((select max(r.new_ceiling) from continuity.ceiling_reservation r where r.sequence_key = c.sequence_key), 0)
  union all
  select p.sequence_key, 'registered counter has no counter row'
  from continuity.protected_sequence p
  where p.source_kind = 'COUNTER' and not exists (select 1 from continuity.counter c where c.sequence_key = p.sequence_key)
$$;

-- The kernel's own identifiers that appear outside the database (anchor ids in write-once storage,
-- audit event ids in review high-water marks and exports) are protected too.
select continuity.register_protected_sequence('kernel.audit_event.id', pg_get_serial_sequence('kernel.audit_event', 'id')::regclass,
  'AUDIT_EVENT_ID', 'kernel', 'Audit event ids (referenced by review high-water marks and exports)', 100000000);
select continuity.register_protected_sequence('kernel.audit_anchor.id', pg_get_serial_sequence('kernel.audit_anchor', 'id')::regclass,
  'AUDIT_ANCHOR_ID', 'kernel', 'Audit anchor ids (copied to write-once storage)', 100000);
select continuity.register_protected_sequence('kernel.audit_checkpoint.id', pg_get_serial_sequence('kernel.audit_checkpoint', 'id')::regclass,
  'OTHER', 'kernel', 'Audit chain checkpoint ids', 1000000);
select continuity.register_protected_sequence('kernel.ddl_log.id', pg_get_serial_sequence('kernel.ddl_log', 'id')::regclass,
  'OTHER', 'kernel', 'DDL log ids', 1000000);

-- ---------------------------------------------------------------------------------------------
-- Moving protected sources forward (shared by secure_identifiers and after_restore)
-- ---------------------------------------------------------------------------------------------

-- The value an external high-water mark gives for a key (marks may be JSON strings or numbers).
create function continuity.external_mark(p_external_high_water jsonb, p_key text) returns bigint
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v bigint;
begin
  begin
    select max((x ->> 'value')::bigint) into v from jsonb_array_elements(p_external_high_water) x where x ->> 'sequence_key' = p_key;
  exception when others then
    raise exception using errcode = 'P0001', message = format('EBMR-CONT-026 the external high-water mark of %s is not a whole number', p_key);
  end;
  return v;
end
$$;

-- Plans the move of every PG sequence (registered, then unregistered ones owned by ebmr_owner) and
-- checks every planned value against the sequence's maximum BEFORE anything moves: setval is not
-- transactional, so a refusal must come before the first move, or sequences would be left moved with
-- no record of why. p_secured: the incarnation's identifiers were already secured, so the values
-- above the restored ones were issued here and only the ledger's marks plus the margin must be passed.
create function continuity.plan_sequence_moves(p_external_high_water jsonb, p_unregistered_margin bigint, p_secured boolean)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, continuity, pg_temp as $$
declare
  p      continuity.protected_sequence%rowtype;
  s      record;
  v_ext  bigint;
  v_before bigint;
  v_after bigint;
  v_max  bigint;
  v_plan jsonb := '[]'::jsonb;
begin
  for p in select * from continuity.protected_sequence ps where ps.source_kind = 'PG_SEQUENCE' order by ps.sequence_key loop
    v_ext := continuity.external_mark(p_external_high_water, p.sequence_key);
    v_before := coalesce(pg_catalog.pg_sequence_last_value(p.pg_sequence), 0);
    v_after := case when p_secured then greatest(v_before, coalesce(v_ext, 0) + p.restore_margin)
                    else greatest(v_before, coalesce(v_ext, 0)) + p.restore_margin end;
    select sq.max_value into v_max from pg_catalog.pg_sequences sq
     where format('%I.%I', sq.schemaname, sq.sequencename)::regclass = p.pg_sequence;
    if v_after > v_max then
      raise exception using errcode = 'P0001', message = format('EBMR-CONT-024 moving %s to %s would exceed its maximum %s', p.pg_sequence, v_after, v_max);
    end if;
    v_plan := v_plan || jsonb_build_object('sequence_key', p.sequence_key, 'sequence', p.pg_sequence::oid, 'value_before', v_before,
                                           'external_value', v_ext, 'value_after', v_after);
  end loop;
  -- Safety net: sequences owned by ebmr_owner that no module registered move forward by a margin.
  for s in
    select u.sequence_name, u.sequence_name::regclass as seq
    from continuity.unprotected_sequences() u where u.owner_name = 'ebmr_owner'
  loop
    v_before := coalesce(pg_catalog.pg_sequence_last_value(s.seq), 0);
    v_after := v_before + p_unregistered_margin;
    select sq.max_value into v_max from pg_catalog.pg_sequences sq
     where format('%I.%I', sq.schemaname, sq.sequencename)::regclass = s.seq;
    if v_after > v_max then
      raise exception using errcode = 'P0001', message = format('EBMR-CONT-024 moving %s to %s would exceed its maximum %s', s.seq, v_after, v_max);
    end if;
    v_plan := v_plan || jsonb_build_object('sequence_key', 'unregistered:' || s.sequence_name, 'sequence', s.seq::oid, 'value_before', v_before,
                                           'external_value', null, 'value_after', v_after);
  end loop;
  return v_plan;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- External anchors versus the live chains
-- ---------------------------------------------------------------------------------------------

-- The hash the live database holds for a chain at a sequence number: the live event, or, for a
-- chain purged under its retention (DI-47), the event hash its tombstone keeps. A chain written
-- again after its purge starts over from genesis under the same key, so both are candidates.
create function continuity.chain_hash_matches(p_chain_key text, p_seq bigint, p_hash_hex text) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
begin
  if exists (select 1 from kernel.audit_event e
             where e.chain_key = p_chain_key and e.seq = p_seq and encode(e.hash, 'hex') = lower(p_hash_hex)) then
    return true;
  end if;
  return exists (select 1 from records.tombstone t
                 where t.chain_key = p_chain_key and p_seq between 1 and t.chain_event_count
                   and encode(t.chain_event_hashes[p_seq], 'hex') = lower(p_hash_hex));
end
$$;

-- p_anchor: {anchor_id, merkle_root_hex, heads: [{chain_key, seq, hash_hex}], created_at, incarnation?, server_started_at?}
create function continuity.external_anchor_problems(p_anchor jsonb) returns table (chain_key text, problem text)
language plpgsql stable security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_id    bigint;
  v_heads jsonb := p_anchor -> 'heads';
  v_root  text := lower(p_anchor ->> 'merkle_root_hex');
  v_db    kernel.audit_anchor%rowtype;
  h       jsonb;
begin
  begin
    v_id := (p_anchor ->> 'anchor_id')::bigint;
  exception when others then
    v_id := null;
  end;
  if v_id is null or v_heads is null or jsonb_typeof(v_heads) <> 'array' or v_root is null then
    chain_key := null; problem := 'external anchor record is malformed'; return next;
    return;
  end if;
  if encode(kernel.merkle_root(v_heads), 'hex') <> v_root then
    chain_key := null; problem := format('external anchor %s: root does not match its heads', v_id); return next;
  end if;
  select * into v_db from kernel.audit_anchor a where a.id = v_id;
  if found and encode(v_db.merkle_root, 'hex') <> v_root then
    chain_key := null; problem := format('external anchor %s differs from the database copy of that anchor', v_id); return next;
  end if;
  for h in select x from jsonb_array_elements(v_heads) x loop
    if not (case when coalesce(pg_catalog.pg_input_is_valid(h ->> 'seq', 'bigint'), false)
                 then continuity.chain_hash_matches(h ->> 'chain_key', (h ->> 'seq')::bigint, coalesce(h ->> 'hash_hex', ''))
                 else false end) then
      chain_key := h ->> 'chain_key';
      problem := format('chain %s at seq %s differs from external anchor %s', h ->> 'chain_key', h ->> 'seq', v_id);
      return next;
    end if;
  end loop;
end
$$;

-- Classification used when a restore event is recorded:
--   MATCH        every anchored head is present with the same hash;
--   DISCARDABLE  history after the restore point, which a restore event may cover: the anchor is absent
--                from the restored database, only chain heads differ, and for every chain that differs
--                the restored chain ends before the anchored sequence number (history lost, not
--                changed). When a restore point is given, the anchor was created after it. An anchor
--                exported by this very server (same incarnation, same server start) is never
--                discardable: nothing it anchored can have been lost by a restore;
--   UNEXPLAINED  anything else (the anchor existed at the restore point, the anchored history is still
--                there with another hash, or the record itself is inconsistent): never covered.
create function continuity.compare_external_anchors(p_anchors jsonb, p_restore_point timestamptz default null)
returns table (anchor_id bigint, in_database boolean, status text, problem_chains text[], problems text[])
language plpgsql stable security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  a jsonb;
  v_chains text[];
  v_problems text[];
  v_anchor_level boolean;
  v_lost boolean;
  v_after_point boolean;
  v_this_server boolean;
  v_incarnation text := continuity.current_incarnation();
  v_started text := continuity.utc_text(pg_catalog.pg_postmaster_start_time());
begin
  if p_anchors is null or jsonb_typeof(p_anchors) <> 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-002 external anchors must be a JSON array';
  end if;
  for a in select x from jsonb_array_elements(p_anchors) x loop
    select coalesce(array_agg(distinct p.chain_key) filter (where p.chain_key is not null), '{}'),
           coalesce(array_agg(p.problem order by p.problem), '{}'),
           coalesce(bool_or(p.chain_key is null), false)
      into v_chains, v_problems, v_anchor_level
    from continuity.external_anchor_problems(a) p;
    begin
      anchor_id := (a ->> 'anchor_id')::bigint;
    exception when others then
      anchor_id := null;
    end;
    in_database := anchor_id is not null and exists (select 1 from kernel.audit_anchor k where k.id = anchor_id);
    problem_chains := v_chains;
    problems := v_problems;
    -- Lost, not changed: every differing chain ends (in this database) before the anchored seq.
    select coalesce(bool_and(case when coalesce(pg_catalog.pg_input_is_valid(h ->> 'seq', 'bigint'), false)
                                  then (h ->> 'seq')::bigint > coalesce((select hd.last_seq from kernel.audit_chain_head hd
                                                                         where hd.chain_key = h ->> 'chain_key'), 0)
                                  else false end), false)
      into v_lost
    from jsonb_array_elements(case when jsonb_typeof(a -> 'heads') = 'array' then a -> 'heads' else '[]'::jsonb end) h
    where h ->> 'chain_key' = any (v_chains);
    v_after_point := case when p_restore_point is null then true
                          when coalesce(pg_catalog.pg_input_is_valid(a ->> 'created_at', 'timestamptz'), false)
                            then (a ->> 'created_at')::timestamptz > p_restore_point
                          else false end;
    v_this_server := a ->> 'incarnation' = v_incarnation and a ->> 'server_started_at' = v_started;
    status := case
      when cardinality(v_problems) = 0 then 'MATCH'
      when not in_database and not v_anchor_level and cardinality(v_chains) > 0 and v_lost and v_after_point
           and not coalesce(v_this_server, false) then 'DISCARDABLE'
      else 'UNEXPLAINED' end;
    return next;
  end loop;
end
$$;

-- Canonical content of a restore event (timestamps rendered in UTC, so the hash does not depend on the
-- session time zone). The content hash is sha256 over this JSON text.
create function continuity.restore_event_content(e continuity.restore_event) returns jsonb
language sql stable set search_path = pg_catalog, continuity, pg_temp as $$
  select jsonb_build_object(
    'id', e.id,
    'event_kind', e.event_kind,
    'backup_id', e.backup_id,
    'backup_taken_at', continuity.utc_text(e.backup_taken_at),
    'restore_point', continuity.utc_text(e.restore_point),
    'performed_at', continuity.utc_text(e.performed_at),
    'reason', e.reason,
    'change_reference', e.change_reference,
    'operator_person_id', e.operator_person_id,
    'operator_account_id', e.operator_account_id,
    'operator_role_code', e.operator_role_code,
    'approver_person_ids', (select jsonb_agg(x::text order by x::text) from unnest(e.approver_person_ids) x),
    'new_incarnation', e.new_incarnation,
    'anchor_comparison', e.anchor_comparison,
    'discarded_anchor_ids', to_jsonb(e.discarded_anchor_ids),
    'affected_chains', e.affected_chains,
    'affected_chain_keys', to_jsonb(e.affected_chain_keys),
    'recorded_at', continuity.utc_text(e.recorded_at),
    'correlation_id', e.correlation_id)
$$;

create function continuity.restore_event_hash_ok(p_event_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, continuity, pg_temp as $$
  select coalesce((select e.content_hash = sha256(convert_to(continuity.restore_event_content(e)::text, 'UTF8'))
                   from continuity.restore_event e where e.id = p_event_id), false)
$$;

-- Approved: the stored content still hashes to content_hash, every named approver approved that hash,
-- and the operator is not among the approvers (two different persons).
create function continuity.restore_event_is_approved(p_event_id uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, continuity, pg_temp as $$
  select coalesce((
    select continuity.restore_event_hash_ok(e.id)
       and not exists (select 1 from unnest(e.approver_person_ids) ap
                       where not exists (select 1 from continuity.restore_event_approval a
                                         where a.restore_event_id = e.id and a.approver_person_id = ap
                                           and a.approved_content_hash = e.content_hash))
       and not exists (select 1 from continuity.restore_event_approval a
                       where a.restore_event_id = e.id and a.approver_person_id = e.operator_person_id)
    from continuity.restore_event e where e.id = p_event_id), false)
$$;

create view continuity.restore_event_status as
  select e.id, e.event_kind, e.backup_id, e.restore_point, e.recorded_at, e.operator_person_id, e.approver_person_ids,
         e.discarded_anchor_ids, e.affected_chain_keys,
         (select count(*) from continuity.restore_event_approval a where a.restore_event_id = e.id) as approvals,
         case
           when exists (select 1 from continuity.restore_completion c where c.restore_event_id = e.id) then 'COMPLETED'
           when continuity.restore_event_is_approved(e.id) then 'APPROVED'
           else 'RECORDED' end as status
  from continuity.restore_event e;

-- ---------------------------------------------------------------------------------------------
-- Securing, recording, approving and completing a restore
-- ---------------------------------------------------------------------------------------------

-- First step in a restored, copied or failed-over database, before any other write (INV-27): every
-- protected PG sequence moves past the external ledger (max(current, ledger mark) + its margin), every
-- unregistered one owned by ebmr_owner by p_unregistered_margin, and the login names the ledger holds
-- that this database no longer knows are reserved (never issued again). Moving forward needs no
-- approval; the moves are recorded (IDENTIFIERS_SECURED) and the incarnation is marked secured, which
-- opens the audit trail again. Counters stay closed until the restore is completed. Does nothing when
-- this incarnation is already bound or secured. p_external_high_water: [{sequence_key, value}].
create function continuity.secure_identifiers(p_external_high_water jsonb, p_login_names jsonb default '[]'::jsonb,
                                              p_unregistered_margin bigint default 1000000)
returns table (sequence_key text, source_kind text, value_before bigint, external_value bigint, value_after bigint)
language plpgsql volatile security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx   jsonb := continuity.require_actor();
  v_corr  uuid := (v_ctx ->> 'correlation_id')::uuid;
  v_incarnation text := continuity.current_incarnation();
  v_plan  jsonb;
  x       jsonb;
begin
  -- DI-17 installation-wide (part of the restore procedure, an IT operation: no DI-18 guard, see README).
  perform iam.require_permission('CONTINUITY.RESTORE_OPERATE', '{}'::jsonb);
  if p_external_high_water is null or jsonb_typeof(p_external_high_water) <> 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-026 external high-water marks must be a JSON array';
  end if;
  if p_login_names is null or jsonb_typeof(p_login_names) <> 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-026 the login names from the external ledger must be a JSON array';
  end if;
  if p_unregistered_margin is null or p_unregistered_margin < 1 then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-026 the margin for unregistered sequences must be positive';
  end if;
  -- One securing per incarnation; concurrent callers wait here.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('continuity.secure_identifiers', 0));
  if exists (select 1 from continuity.database_incarnation d where d.incarnation = v_incarnation) then
    return;
  end if;
  v_plan := continuity.plan_sequence_moves(p_external_high_water, p_unregistered_margin, false);
  -- Move first (nothing below writes an audit event before every sequence is past the ledger), then
  -- open the audit trail for this incarnation, then record every move.
  for x in select y from jsonb_array_elements(v_plan) y loop
    perform pg_catalog.setval((x ->> 'sequence')::oid::regclass, (x ->> 'value_after')::bigint, true);
  end loop;
  insert into continuity.database_incarnation (incarnation, bound_by, correlation_id) values (v_incarnation, 'IDENTIFIERS_SECURED', v_corr);
  for x in select y from jsonb_array_elements(v_plan) y loop
    insert into continuity.sequence_bump (sequence_key, source_kind, reason, value_before, external_value, value_after, correlation_id)
    values (x ->> 'sequence_key', 'PG_SEQUENCE', 'IDENTIFIERS_SECURED', (x ->> 'value_before')::bigint, (x ->> 'external_value')::bigint,
            (x ->> 'value_after')::bigint, v_corr);
    sequence_key := x ->> 'sequence_key'; source_kind := 'PG_SEQUENCE'; value_before := (x ->> 'value_before')::bigint;
    external_value := (x ->> 'external_value')::bigint; value_after := (x ->> 'value_after')::bigint;
    return next;
  end loop;
  perform iam.reserve_identifiers(p_login_names, 'issued before the database was restored, copied or failed over (external continuity ledger)', null);
end
$$;

-- p_event: {event_kind, backup_id, backup_taken_at, restore_point, performed_at, reason, change_reference,
--           approver_person_ids: [uuid]}. p_external_anchors: every anchor from the external ledger.
-- The database compares the anchors itself; the caller cannot choose what is discarded.
create function continuity.record_restore_event(p_event jsonb, p_external_anchors jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx       jsonb := continuity.require_actor();
  r           continuity.restore_event%rowtype;
  v_approvers uuid[];
  v_cmp       jsonb;
begin
  -- DI-17 installation-wide (the restore itself is an IT operation; its GMP approval is approve_restore_event: no DI-18 guard, see README).
  perform iam.require_permission('CONTINUITY.RESTORE_OPERATE', '{}'::jsonb);
  if not continuity.identifiers_secured() then
    raise exception using errcode = 'P0001',
      message = 'EBMR-CONT-017 the identifiers of this restored, copied or failed-over database are not secured yet; run continuity.secure_identifiers first';
  end if;
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-020 restore event details are required';
  end if;
  begin
    v_approvers := array(select x::uuid from jsonb_array_elements_text(p_event -> 'approver_person_ids') x);
    r.backup_taken_at := (p_event ->> 'backup_taken_at')::timestamptz;
    r.restore_point := (p_event ->> 'restore_point')::timestamptz;
    r.performed_at := (p_event ->> 'performed_at')::timestamptz;
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-020 approver ids must be UUIDs and times must be timestamps';
  end;
  if coalesce(cardinality(v_approvers), 0) < 1 then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-020 a restore needs at least one named approver besides the operator';
  end if;
  if (select count(distinct x) from unnest(v_approvers) x) <> cardinality(v_approvers) then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-020 approvers must be different persons';
  end if;
  if (v_ctx ->> 'person_id')::uuid = any (v_approvers) then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-020 the operator cannot be an approver of the same restore';
  end if;
  if coalesce(p_event ->> 'event_kind', '') not in ('FULL_RESTORE', 'POINT_IN_TIME_RESTORE', 'FAILOVER', 'CLUSTER_MIGRATION') then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-020 event_kind must be FULL_RESTORE, POINT_IN_TIME_RESTORE, FAILOVER or CLUSTER_MIGRATION';
  end if;
  if r.performed_at is null or coalesce(trim(p_event ->> 'reason'), '') = '' or coalesce(trim(p_event ->> 'change_reference'), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-020 performed_at, reason and change_reference are required';
  end if;
  if p_event ->> 'event_kind' in ('FULL_RESTORE', 'POINT_IN_TIME_RESTORE')
     and (coalesce(trim(p_event ->> 'backup_id'), '') = '' or r.backup_taken_at is null) then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-020 a restore names the backup it restored from and when that backup was taken';
  end if;
  if p_external_anchors is null or jsonb_typeof(p_external_anchors) <> 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-020 the external anchors must be supplied (a JSON array, possibly empty)';
  end if;

  -- History after the restore point (or, without one, after the backup) is what a restore may discard.
  select coalesce(jsonb_agg(jsonb_build_object('anchor_id', c.anchor_id, 'in_database', c.in_database, 'status', c.status,
                                               'problem_chains', to_jsonb(c.problem_chains), 'problems', to_jsonb(c.problems))
                            order by c.anchor_id), '[]'::jsonb)
    into v_cmp
  from continuity.compare_external_anchors(p_external_anchors, coalesce(r.restore_point, r.backup_taken_at)) c;

  r.id := gen_random_uuid();
  r.event_kind := p_event ->> 'event_kind';
  r.backup_id := nullif(trim(p_event ->> 'backup_id'), '');
  r.reason := p_event ->> 'reason';
  r.change_reference := p_event ->> 'change_reference';
  r.operator_person_id := (v_ctx ->> 'person_id')::uuid;
  r.operator_account_id := (v_ctx ->> 'account_id')::uuid;
  r.operator_role_code := v_ctx ->> 'role_code';
  r.approver_person_ids := v_approvers;
  r.new_incarnation := continuity.current_incarnation();
  r.anchor_comparison := v_cmp;
  r.discarded_anchor_ids := array(select (x ->> 'anchor_id')::bigint from jsonb_array_elements(v_cmp) x
                                  where x ->> 'status' = 'DISCARDABLE' order by 1);
  with ext as (
    select h ->> 'chain_key' as chain_key, max((h ->> 'seq')::bigint) as external_seq
    from jsonb_array_elements(p_external_anchors) a, jsonb_array_elements(a -> 'heads') h
    where (a ->> 'anchor_id')::bigint = any (r.discarded_anchor_ids)
    group by 1
  ), prob as (
    select distinct pc as chain_key
    from jsonb_array_elements(v_cmp) x, jsonb_array_elements_text(x -> 'problem_chains') pc
    where x ->> 'status' = 'DISCARDABLE'
  )
  select coalesce(jsonb_agg(jsonb_build_object('chain_key', prob.chain_key, 'restored_seq', coalesce(hd.last_seq, 0),
                                               'external_seq', ext.external_seq) order by prob.chain_key), '[]'::jsonb),
         coalesce(array_agg(prob.chain_key order by prob.chain_key), '{}')
    into r.affected_chains, r.affected_chain_keys
  from prob
  left join ext on ext.chain_key = prob.chain_key
  left join kernel.audit_chain_head hd on hd.chain_key = prob.chain_key;
  r.recorded_at := clock_timestamp();
  r.correlation_id := (v_ctx ->> 'correlation_id')::uuid;
  r.content_hash := sha256(convert_to(continuity.restore_event_content(r)::text, 'UTF8'));

  insert into continuity.restore_event select r.*;
  perform kernel.audit_business_event('restore_event:' || r.id,
    format('%s recorded from backup %s; %s external anchor(s) discarded, %s chain(s) affected',
           r.event_kind, coalesce(r.backup_id, '(none)'), cardinality(r.discarded_anchor_ids), cardinality(r.affected_chain_keys)),
    jsonb_build_object('change_reference', r.change_reference));
  return r.id;
end
$$;

create function continuity.approve_restore_event(p_event_id uuid, p_signature_id uuid default null) returns void
language plpgsql volatile security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx    jsonb := continuity.require_actor();
  v_person uuid := (v_ctx ->> 'person_id')::uuid;
  e        continuity.restore_event%rowtype;
begin
  -- DI-18, then DI-17 installation-wide.
  perform iam.assert_not_administrator();
  perform iam.require_permission('CONTINUITY.RESTORE_APPROVE', '{}'::jsonb);
  select * into e from continuity.restore_event x where x.id = p_event_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-CONT-021 restore event %s does not exist', p_event_id);
  end if;
  if exists (select 1 from continuity.restore_completion c where c.restore_event_id = p_event_id) then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-021 the restore event is already completed';
  end if;
  if v_person = e.operator_person_id then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-021 the operator cannot approve their own restore (two persons are required)';
  end if;
  if not (v_person = any (e.approver_person_ids)) then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-021 only a person named as approver when the restore was recorded can approve it';
  end if;
  if not continuity.restore_event_hash_ok(p_event_id) then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-021 the restore event no longer matches its content hash';
  end if;
  if exists (select 1 from continuity.restore_event_approval a where a.restore_event_id = p_event_id and a.approver_person_id = v_person) then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-021 this person has already approved the restore event';
  end if;
  -- DI-37: the approval is the approver's own valid RESTORE_APPROVED signature of this event (0720).
  if p_signature_id is null then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-025 approving a restore needs the approver''s RESTORE_APPROVED signature';
  end if;
  if (esig.assert_signature(p_signature_id, 'RESTORE_APPROVED', 'restore_event', p_event_id::text) ->> 'signer_person')::uuid
     is distinct from v_person then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-025 the restore-approval signature was made by another person';
  end if;
  insert into continuity.restore_event_approval (restore_event_id, approver_person_id, approver_account_id, approver_role_code,
                                                 approved_content_hash, signature_id, correlation_id)
  values (p_event_id, v_person, (v_ctx ->> 'account_id')::uuid, v_ctx ->> 'role_code', e.content_hash, p_signature_id,
          (v_ctx ->> 'correlation_id')::uuid);
end
$$;

-- Complete an approved restore: move every protected source past the highest value the external
-- ledger holds, record each move, reserve the login names the ledger holds, and re-enable number issue
-- under the new incarnation. Every check (counters against the ledger, every sequence against its
-- maximum) runs before the first move, so a refused completion moves nothing.
-- p_external_high_water: [{sequence_key, value}] with the maximum ceiling (counters) or high-water mark
-- (sequences) found in the external ledger. Values may be JSON strings or numbers.
-- p_login_names: every login name the external ledger holds (JSON array of text).
create function continuity.after_restore(p_restore_event_id uuid, p_external_high_water jsonb, p_unregistered_margin bigint default 1000000,
                                         p_login_names jsonb default '[]'::jsonb)
returns table (sequence_key text, source_kind text, value_before bigint, external_value bigint, value_after bigint)
language plpgsql volatile security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx   jsonb := continuity.require_actor();
  v_corr  uuid := (v_ctx ->> 'correlation_id')::uuid;
  v_incarnation text := continuity.current_incarnation();
  e       continuity.restore_event%rowtype;
  p       continuity.protected_sequence%rowtype;
  c       continuity.counter%rowtype;
  v_ext   bigint;
  v_after bigint;
  v_counters jsonb := '[]'::jsonb;
  v_sequences jsonb;
  v_bumps jsonb := '[]'::jsonb;
  x       jsonb;
begin
  -- DI-17 installation-wide (completes the approved restore procedure: no DI-18 guard, see README).
  perform iam.require_permission('CONTINUITY.RESTORE_OPERATE', '{}'::jsonb);
  select * into e from continuity.restore_event r where r.id = p_restore_event_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-CONT-022 restore event %s does not exist', p_restore_event_id);
  end if;
  if exists (select 1 from continuity.restore_completion k where k.restore_event_id = p_restore_event_id) then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-022 the restore event is already completed';
  end if;
  if not continuity.restore_event_is_approved(p_restore_event_id) then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-022 the restore event is not approved by every named approver';
  end if;
  if e.new_incarnation <> v_incarnation then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-022 the database incarnation changed after the restore event was recorded; record a new event';
  end if;
  if p_external_high_water is null or jsonb_typeof(p_external_high_water) <> 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-022 external high-water marks must be a JSON array';
  end if;
  if p_unregistered_margin is null or p_unregistered_margin < 1 then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-022 the margin for unregistered sequences must be positive';
  end if;
  if p_login_names is null or jsonb_typeof(p_login_names) <> 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-022 the login names from the external ledger must be a JSON array';
  end if;

  -- 1. Plan and check everything (nothing moves yet).
  for p in select * from continuity.protected_sequence ps where ps.source_kind = 'COUNTER' order by ps.sequence_key loop
    v_ext := continuity.external_mark(p_external_high_water, p.sequence_key);
    select * into c from continuity.counter k where k.sequence_key = p.sequence_key for update;
    if v_ext is null and (c.last_value > 0 or c.reserved_ceiling > 0) then
      raise exception using errcode = 'P0001', detail = p.sequence_key,
        message = format('EBMR-CONT-023 the external ledger has no ceiling for counter %s, which has issued values; the ledger is incomplete', p.sequence_key);
    end if;
    if coalesce(v_ext, 0) < c.reserved_ceiling then
      raise exception using errcode = 'P0001', detail = p.sequence_key,
        message = format('EBMR-CONT-013 the external ledger (%s) is behind the restored ceiling (%s) for %s; the write-ahead record is missing', v_ext, c.reserved_ceiling, p.sequence_key);
    end if;
    v_after := greatest(c.last_value, c.reserved_ceiling, coalesce(v_ext, 0));
    v_counters := v_counters || jsonb_build_object('sequence_key', p.sequence_key, 'value_before', c.last_value, 'external_value', v_ext,
                                                   'value_after', v_after);
  end loop;
  v_sequences := continuity.plan_sequence_moves(p_external_high_water, p_unregistered_margin,
    exists (select 1 from continuity.database_incarnation d where d.incarnation = v_incarnation and d.bound_by = 'IDENTIFIERS_SECURED'));

  -- 2. Move.
  for x in select y from jsonb_array_elements(v_counters) y loop
    update continuity.counter k set last_value = (x ->> 'value_after')::bigint, reserved_ceiling = (x ->> 'value_after')::bigint,
                                    ceiling_incarnation = null, ceiling_started_at = null
     where k.sequence_key = x ->> 'sequence_key';
  end loop;
  for x in select y from jsonb_array_elements(v_sequences) y loop
    perform pg_catalog.setval((x ->> 'sequence')::oid::regclass, (x ->> 'value_after')::bigint, true);
  end loop;
  insert into continuity.database_incarnation (incarnation, bound_by, correlation_id) values (v_incarnation, 'RESTORE_COMPLETED', v_corr)
  on conflict (incarnation) do nothing;

  -- 3. Record every move, in key order: counters and registered sequences, then the safety net.
  for x in
    select y from (select y, 0 as grp from jsonb_array_elements(v_counters) y
                   union all
                   select y, case when y ->> 'sequence_key' like 'unregistered:%' then 1 else 0 end from jsonb_array_elements(v_sequences) y) z
    order by grp, y ->> 'sequence_key'
  loop
    source_kind := case when x ? 'sequence' then 'PG_SEQUENCE' else 'COUNTER' end;
    insert into continuity.sequence_bump (sequence_key, source_kind, reason, restore_event_id, value_before, external_value, value_after, correlation_id)
    values (x ->> 'sequence_key', source_kind, 'RESTORE_EVENT', p_restore_event_id, (x ->> 'value_before')::bigint,
            (x ->> 'external_value')::bigint, (x ->> 'value_after')::bigint, v_corr);
    v_bumps := v_bumps || jsonb_build_object('sequence_key', x ->> 'sequence_key', 'value_before', (x ->> 'value_before')::bigint,
                                             'external_value', (x ->> 'external_value')::bigint, 'value_after', (x ->> 'value_after')::bigint);
    sequence_key := x ->> 'sequence_key'; value_before := (x ->> 'value_before')::bigint;
    external_value := (x ->> 'external_value')::bigint; value_after := (x ->> 'value_after')::bigint;
    return next;
  end loop;

  -- INV-27: login names issued in the lost window are never issued again (identity module, F59/F81).
  perform iam.reserve_identifiers(p_login_names, format('issued before restore event %s (external continuity ledger)', p_restore_event_id),
                                  p_restore_event_id);

  insert into continuity.restore_completion (restore_event_id, completed_by_person_id, completed_by_account_id, incarnation, bumps, correlation_id)
  values (p_restore_event_id, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, v_incarnation, v_bumps, v_corr);
  perform kernel.audit_business_event('restore_event:' || p_restore_event_id,
    format('restore completed; %s identifier source(s) moved past the external high-water marks', jsonb_array_length(v_bumps)));
end
$$;

-- Lost window of a restore: the chains whose history after the restore point was discarded, with the
-- sequence range known to be lost (for the lost-window incident and re-entry through the late-entry or
-- paper path).
create function continuity.lost_window(p_restore_event_id uuid)
returns table (chain_key text, aggregate_type text, aggregate_id text, restored_seq bigint, external_seq bigint)
language sql stable security definer set search_path = pg_catalog, continuity, pg_temp as $$
  select x ->> 'chain_key', split_part(x ->> 'chain_key', ':', 1), substr(x ->> 'chain_key', strpos(x ->> 'chain_key', ':') + 1),
         (x ->> 'restored_seq')::bigint, (x ->> 'external_seq')::bigint
  from continuity.restore_event e, jsonb_array_elements(e.affected_chains) x
  where e.id = p_restore_event_id
  order by 1
$$;

-- INV-08 (restore part): verify external anchor copies against the live chains. A difference is
-- COVERED only when an approved restore event names that anchor as discarded and that chain as
-- affected, the anchored sequence number lies beyond where that event found the restored chain ending
-- (history lost by the restore, never history the restore kept), and the anchor id has not been reused
-- in this database; otherwise it is a PROBLEM.
create function continuity.verify_external_anchors(p_anchors jsonb)
returns table (anchor_id bigint, status text, problem text, restore_event_id uuid)
language plpgsql stable security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  a      jsonb;
  pr     record;
  v_any  boolean;
  v_cover uuid;
  v_seq  bigint;
begin
  if p_anchors is null or jsonb_typeof(p_anchors) <> 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-002 external anchors must be a JSON array';
  end if;
  for a in select x from jsonb_array_elements(p_anchors) x loop
    begin
      anchor_id := (a ->> 'anchor_id')::bigint;
    exception when others then
      anchor_id := null;
    end;
    v_any := false;
    for pr in select * from continuity.external_anchor_problems(a) loop
      v_any := true;
      v_cover := null;
      if pr.chain_key is not null and anchor_id is not null
         and not exists (select 1 from kernel.audit_anchor k where k.id = anchor_id) then
        select min((h ->> 'seq')::bigint) into v_seq
        from jsonb_array_elements(a -> 'heads') h
        where h ->> 'chain_key' = pr.chain_key and coalesce(pg_catalog.pg_input_is_valid(h ->> 'seq', 'bigint'), false);
        select e.id into v_cover
        from continuity.restore_event e
        where anchor_id = any (e.discarded_anchor_ids)
          and pr.chain_key = any (e.affected_chain_keys)
          and v_seq is not null
          and exists (select 1 from jsonb_array_elements(e.affected_chains) ac
                      where ac ->> 'chain_key' = pr.chain_key and (ac ->> 'restored_seq')::bigint < v_seq)
          and continuity.restore_event_is_approved(e.id)
        order by e.recorded_at
        limit 1;
      end if;
      status := case when v_cover is null then 'PROBLEM' else 'COVERED' end;
      problem := pr.problem;
      restore_event_id := v_cover;
      return next;
    end loop;
    if not v_any then
      status := 'MATCH'; problem := null; restore_event_id := null;
      return next;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on all tables in schema continuity from ebmr_app;
grant select on continuity.protected_sequence, continuity.counter, continuity.ceiling_reservation, continuity.restore_event,
                continuity.restore_event_approval, continuity.restore_completion, continuity.sequence_bump, continuity.alarm,
                continuity.alarm_acknowledgement, continuity.open_alarm, continuity.restore_event_status,
                continuity.database_incarnation to ebmr_app;
grant execute on function
  continuity.current_incarnation(),
  continuity.identifiers_secured(),
  continuity.acknowledge_alarm(uuid, text),
  continuity.raise_integrity_alarms(),
  continuity.prepare_counter_reservation(text),
  continuity.reserve_counter_ceiling(text, bigint, bigint, text),
  continuity.sequence_high_water(),
  continuity.unprotected_sequences(),
  continuity.number_invariant_violations(),
  continuity.external_anchor_problems(jsonb),
  continuity.compare_external_anchors(jsonb, timestamptz),
  continuity.restore_event_hash_ok(uuid),
  continuity.restore_event_is_approved(uuid),
  continuity.secure_identifiers(jsonb, jsonb, bigint),
  continuity.record_restore_event(jsonb, jsonb),
  continuity.approve_restore_event(uuid, uuid),
  continuity.after_restore(uuid, jsonb, bigint, jsonb),
  continuity.lost_window(uuid),
  continuity.verify_external_anchors(jsonb),
  continuity.utc_text(timestamptz)
to ebmr_app;
-- Not granted: register_protected_sequence, register_protected_counter (migrations only),
-- next_counter_value (only the owning module's SECURITY DEFINER functions), raise_alarm (internal),
-- require_actor, guard_registry, guard_identifiers_secured, restore_event_content, counter_scope,
-- external_mark, plan_sequence_moves, chain_hash_matches.

reset role;
