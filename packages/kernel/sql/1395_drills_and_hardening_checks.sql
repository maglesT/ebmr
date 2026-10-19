-- Phase 7 slice 7g, work package 2 (decision 0025 point 3: every command an installation is operated with has a screen):
-- the restore and upgrade drills and the installation hardening check, run from the operations screens and recorded
-- with the person who asked and the reason (controls DI-45, DI-46, DI-48, DI-13, DI-17).
--
-- Handbook: modules/kernel.md
--
--   continuity.drill_request          insert-only, audited: a person's request for a drill, RESTORE (the kernel's restore
--                                     drill into an isolated database, recorded in continuity.restore_drill by the backup
--                                     service identity, kernel 0610) or UPGRADE (a copy of a database at an earlier release
--                                     upgraded with this release's migrations and compared), with the reason
--   continuity.request_drill(kind, reason, source_database)
--                                     needs CONTINUITY.BACKUP_RUN (kernel 1376); an UPGRADE drill names the database at the
--                                     earlier release and is refused on a GMP installation (EBMR-OPS-041; decision D-P7R-4:
--                                     it needs administration access to the database cluster and creates databases, so it
--                                     runs on a sandbox or staging installation only); EBMR-OPS-040 for a malformed request
--   continuity.upgrade_drill          insert-only, audited: the record of an upgrade drill run from the screen (result,
--                                     failures, tables compared and changed, chains verified, the report's SHA-256)
--   continuity.record_upgrade_drill(record)
--                                     a SYSTEM source holding CONTINUITY.BACKUP_RECORD (the backup service identity, as
--                                     continuity.record_restore_drill); it answers an UPGRADE request (EBMR-OPS-042); a FAIL
--                                     raises the UPGRADE_DRILL_FAILED continuity alarm
--   continuity.hardening_check        insert-only, audited: an installation hardening check run from the screen: every check
--                                     with its evidence, the result, the report's SHA-256, who ran it and why
--   continuity.record_hardening_check(report, reason)
--                                     needs PLATFORM.OPERATE (kernel 1376); EBMR-OPS-043 for a malformed report; a FAIL
--                                     raises the HARDENING_CHECK_FAILED continuity alarm
--
-- Messages: EBMR-OPS-040 to EBMR-OPS-043.

set local role ebmr_owner;

create table continuity.drill_request (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('RESTORE', 'UPGRADE')),
  reason           text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  source_database  text check (source_database is null or source_database ~ '^[a-z][a-z0-9_]{1,62}$'),
  person_id        uuid not null,
  account_id       uuid not null,
  session_id       uuid not null,
  recorded_at      timestamptz not null default clock_timestamp(),
  correlation_id   uuid not null,
  check ((kind = 'UPGRADE') = (source_database is not null))
);
revoke all on continuity.drill_request from public;
grant select on continuity.drill_request to ebmr_app;
select kernel.register_audited_table('continuity.drill_request', 'drill_request', 'id', true);
select platform.enforce_db_time('continuity.drill_request', array['recorded_at']);

create function continuity.request_drill(p_kind text, p_reason text, p_source_database text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, continuity, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('CONTINUITY.BACKUP_RUN', '{}'::jsonb);
  v_id    uuid;
begin
  if coalesce(p_kind, '') not in ('RESTORE', 'UPGRADE') or btrim(coalesce(p_reason, '')) = '' or length(p_reason) > 1000
     or (p_kind = 'UPGRADE') <> (p_source_database is not null)
     or (p_source_database is not null and p_source_database !~ '^[a-z][a-z0-9_]{1,62}$') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-OPS-040 a drill request names its kind (RESTORE or UPGRADE), the reason (up to 1000 characters) and, for an upgrade drill only, the database at the earlier release';
  end if;
  if p_kind = 'UPGRADE' and kernel.installation_kind() = 'GMP' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-OPS-041 the upgrade drill runs on a sandbox or staging installation only: it needs administration access to the database cluster and creates databases (D-P7R-4); a GMP installation shows the drill records';
  end if;
  insert into continuity.drill_request (kind, reason, source_database, person_id, account_id, session_id, correlation_id)
  values (p_kind, btrim(p_reason), p_source_database, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid,
          (v_actor ->> 'session_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;
revoke all on function continuity.request_drill(text, text, text) from public;
grant execute on function continuity.request_drill(text, text, text) to ebmr_app;

create table continuity.upgrade_drill (
  id                      uuid primary key default gen_random_uuid(),
  drill_id                text not null unique check (drill_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_id              uuid not null unique references continuity.drill_request (id),
  source_database         text not null check (source_database ~ '^[a-z][a-z0-9_]{1,62}$'),
  from_release            text not null check (btrim(from_release) <> '' and length(from_release) <= 200),
  result                  text not null check (result in ('PASS', 'FAIL')),
  failures                jsonb not null default '[]'::jsonb check (jsonb_typeof(failures) = 'array'),
  tables_compared         integer not null check (tables_compared >= 0),
  tables_changed          integer not null check (tables_changed >= 0),
  chains_verified         integer not null check (chains_verified >= 0),
  migrations_applied      integer not null check (migrations_applied >= 0),
  report_sha256           text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),
  report_uri              text not null check (length(report_uri) > 0),
  recorded_by_person_id   uuid not null,
  recorded_by_account_id  uuid not null,
  recorded_at             timestamptz not null default clock_timestamp(),
  correlation_id          uuid not null,
  check (tables_changed <= tables_compared),
  check (result = 'FAIL' or (jsonb_array_length(failures) = 0 and tables_changed = 0)),
  check (result = 'PASS' or jsonb_array_length(failures) > 0)
);
revoke all on continuity.upgrade_drill from public;
grant select on continuity.upgrade_drill to ebmr_app;
select kernel.register_audited_table('continuity.upgrade_drill', 'upgrade_drill', 'drill_id', true);
select platform.enforce_db_time('continuity.upgrade_drill', array['recorded_at']);

create function continuity.record_upgrade_drill(p_drill jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx jsonb := continuity.require_actor();
  v_id  uuid;
begin
  if p_drill is null or jsonb_typeof(p_drill) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-OPS-042 an upgrade drill record is required';
  end if;
  if v_ctx ->> 'source' <> 'SYSTEM' then
    raise exception using errcode = 'P0001', message = 'EBMR-OPS-042 upgrade drills are recorded only by a system service account (source SYSTEM)';
  end if;
  -- DI-17 installation-wide (drill evidence, as the restore drill: no DI-18 guard, see README).
  perform iam.require_permission('CONTINUITY.BACKUP_RECORD', '{}'::jsonb);
  if not exists (select 1 from continuity.drill_request r
                  where r.id = (case when coalesce(p_drill ->> 'request_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                     then (p_drill ->> 'request_id')::uuid end)
                    and r.kind = 'UPGRADE' and r.source_database = p_drill ->> 'source_database') then
    raise exception using errcode = 'P0001', message = 'EBMR-OPS-042 an upgrade drill record answers a person''s request for an upgrade drill of the same database';
  end if;
  begin
    insert into continuity.upgrade_drill (drill_id, request_id, source_database, from_release, result, failures, tables_compared, tables_changed,
                                          chains_verified, migrations_applied, report_sha256, report_uri, recorded_by_person_id,
                                          recorded_by_account_id, correlation_id)
    values (p_drill ->> 'drill_id', (p_drill ->> 'request_id')::uuid, p_drill ->> 'source_database', p_drill ->> 'from_release', p_drill ->> 'result',
            coalesce(p_drill -> 'failures', '[]'::jsonb), (p_drill ->> 'tables_compared')::integer, (p_drill ->> 'tables_changed')::integer,
            (p_drill ->> 'chains_verified')::integer, (p_drill ->> 'migrations_applied')::integer, p_drill ->> 'report_sha256',
            p_drill ->> 'report_uri', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
    returning id into v_id;
  exception
    when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range or unique_violation then
      raise exception using errcode = 'P0001', message = format('EBMR-OPS-042 invalid upgrade drill record: %s', sqlerrm);
  end;
  if p_drill ->> 'result' = 'FAIL' then
    perform continuity.raise_alarm('UPGRADE_DRILL_FAILED', 'HIGH', format('Upgrade drill %s failed', p_drill ->> 'drill_id'),
      jsonb_build_object('upgrade_drill_id', v_id, 'failures', p_drill -> 'failures', 'report_uri', p_drill ->> 'report_uri'));
  end if;
  return v_id;
end
$$;
revoke all on function continuity.record_upgrade_drill(jsonb) from public;
grant execute on function continuity.record_upgrade_drill(jsonb) to ebmr_app;

create table continuity.hardening_check (
  id              uuid primary key default gen_random_uuid(),
  result          text not null check (result in ('PASS', 'FAIL')),
  checks          jsonb not null check (jsonb_typeof(checks) = 'array' and jsonb_array_length(checks) > 0),
  report_sha256   text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),
  reason          text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  person_id       uuid not null,
  account_id      uuid not null,
  session_id      uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  correlation_id  uuid not null
);
revoke all on continuity.hardening_check from public;
grant select on continuity.hardening_check to ebmr_app;
select kernel.register_audited_table('continuity.hardening_check', 'hardening_check', 'id', true);
select platform.enforce_db_time('continuity.hardening_check', array['recorded_at']);

-- p_report: {result, checks: [{id, area, title, status, evidence}], report_sha256}. The result must be what the checks say:
-- FAIL when any check FAILs, PASS otherwise.
create function continuity.record_hardening_check(p_report jsonb, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, continuity, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('PLATFORM.OPERATE', '{}'::jsonb);
  v_fail  boolean;
  v_id    uuid;
begin
  if p_report is null or jsonb_typeof(p_report) <> 'object' or jsonb_typeof(p_report -> 'checks') <> 'array'
     or jsonb_array_length(p_report -> 'checks') = 0 or btrim(coalesce(p_reason, '')) = '' or length(p_reason) > 1000
     or exists (select 1 from jsonb_array_elements(p_report -> 'checks') x
                 where jsonb_typeof(x) <> 'object' or coalesce(x ->> 'id', '') = '' or coalesce(x ->> 'status', '') not in ('PASS', 'FAIL', 'WARN', 'NOT_APPLICABLE')) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-OPS-043 a hardening check names every check with its status (PASS, FAIL, WARN or NOT_APPLICABLE), and the reason (up to 1000 characters)';
  end if;
  v_fail := exists (select 1 from jsonb_array_elements(p_report -> 'checks') x where x ->> 'status' = 'FAIL');
  if p_report ->> 'result' is distinct from (case when v_fail then 'FAIL' else 'PASS' end) then
    raise exception using errcode = 'P0001', message = 'EBMR-OPS-043 the result of a hardening check is FAIL when a check fails and PASS otherwise';
  end if;
  begin
    insert into continuity.hardening_check (result, checks, report_sha256, reason, person_id, account_id, session_id, correlation_id)
    values (p_report ->> 'result', p_report -> 'checks', p_report ->> 'report_sha256', btrim(p_reason), (v_actor ->> 'person_id')::uuid,
            (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception using errcode = 'P0001', message = format('EBMR-OPS-043 invalid hardening check: %s', sqlerrm);
  end;
  if v_fail then
    perform continuity.raise_alarm('HARDENING_CHECK_FAILED', 'HIGH', 'The installation hardening check failed',
      jsonb_build_object('hardening_check_id', v_id,
                         'failed', (select jsonb_agg(x ->> 'id') from jsonb_array_elements(p_report -> 'checks') x where x ->> 'status' = 'FAIL')));
  end if;
  return v_id;
end
$$;
revoke all on function continuity.record_hardening_check(jsonb, text) from public;
grant execute on function continuity.record_hardening_check(jsonb, text) to ebmr_app;

reset role;
