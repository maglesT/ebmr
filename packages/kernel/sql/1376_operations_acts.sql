-- Phase 7 slice 7g-4 (decision 0025 point 2): the operations a person does from the web app instead of a command line,
-- recorded and attributed where the kernel records its other IT functions (controls DI-17, DI-18, DI-45).
--
-- Handbook: modules/kernel.md
--
--   platform.operations_act               insert-only, audited: a person's start, stop or restart of one of the server's
--                                         background workers (an integration adapter's worker, the analytics runner),
--                                         with the reason given and the outcome (DONE, or REFUSED with why: an adapter
--                                         refused at start on its transport, EBMR-INT-034, is recorded REFUSED).
--   platform.record_operations_act(act, target, reason, outcome, detail)
--                                         needs PLATFORM.OPERATE (EBMR-OPS-001 to 003 for a malformed record).
--   continuity.backup_request             insert-only, audited: a person's request for a backup now, with the reason; the
--                                         server's backup job then runs under the backup service identity and records
--                                         its run in continuity.backup_job_run (kernel 0610: SYSTEM source,
--                                         CONTINUITY.BACKUP_RECORD) under the job name request-<request id>.
--   continuity.request_backup(reason, tier)  needs CONTINUITY.BACKUP_RUN (EBMR-OPS-020 for a malformed request).
--   continuity.backup_download            insert-only, audited: who took a copy of which stored backup artefact.
--   continuity.record_backup_download(backup id)  needs CONTINUITY.BACKUP_RUN; an unknown backup is EBMR-OPS-021.
--
-- Permissions (kernel roles; administrators hold the IT functions, DI-18):
--   PLATFORM.OPERATE         ADMINISTRATION ADMINISTER  the background workers; on demo and sandbox installations the
--                                                       demo data and the simulators (tablets 1485): SYSTEM_ADMINISTRATOR
--   CONTINUITY.BACKUP_RUN    ADMINISTRATION ADMINISTER  a backup now, and a copy of a stored one: SYSTEM_ADMINISTRATOR
--   CONTINUITY.BACKUP_READ   READ_ONLY      READ        the backup catalogue and job runs: SYSTEM_ADMINISTRATOR,
--                                                       PROCESS_OWNER and QA_REVIEWER
--
-- Messages: EBMR-OPS-001 to EBMR-OPS-003, EBMR-OPS-020, EBMR-OPS-021.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1376_operations_acts)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'operations from the web app: background workers, backups on request (decision 0025)'));

insert into iam.permission (code, domain, effect, description) values
  ('PLATFORM.OPERATE', 'ADMINISTRATION', 'ADMINISTER', 'Start, stop and restart the server''s background workers; on demo and sandbox installations load or reset the demo data and drive the simulators'),
  ('CONTINUITY.BACKUP_RUN', 'ADMINISTRATION', 'ADMINISTER', 'Ask for a backup of the installation now, and take a copy of a stored backup artefact (DI-45)'),
  ('CONTINUITY.BACKUP_READ', 'READ_ONLY', 'READ', 'Read the backup catalogue and the backup job runs (DI-45)');
insert into iam.role_permission (role_code, permission_code) values
  ('SYSTEM_ADMINISTRATOR', 'PLATFORM.OPERATE'),
  ('SYSTEM_ADMINISTRATOR', 'CONTINUITY.BACKUP_RUN'),
  ('SYSTEM_ADMINISTRATOR', 'CONTINUITY.BACKUP_READ'),
  ('PROCESS_OWNER', 'CONTINUITY.BACKUP_READ'),
  ('QA_REVIEWER', 'CONTINUITY.BACKUP_READ');

select kernel.set_actor_context(null);

create table platform.operations_act (
  id              uuid primary key default gen_random_uuid(),
  act             text not null check (act in ('ADAPTER_START', 'ADAPTER_STOP', 'ADAPTER_RESTART', 'ANALYTICS_START', 'ANALYTICS_STOP', 'ANALYTICS_RESTART')),
  target          text not null check (target ~ '^[A-Z][A-Z0-9_-]{1,63}$'),
  reason          text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  outcome         text not null check (outcome in ('DONE', 'REFUSED')),
  detail          text check (detail is null or length(detail) <= 2000),
  person_id       uuid not null,
  account_id      uuid not null,
  session_id      uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  correlation_id  uuid not null,
  check (outcome = 'DONE' or btrim(coalesce(detail, '')) <> '')
);
revoke all on platform.operations_act from public;
grant select on platform.operations_act to ebmr_app;
select kernel.register_audited_table('platform.operations_act', 'operations_act', 'target', true);
select platform.enforce_db_time('platform.operations_act', array['recorded_at']);

create function platform.record_operations_act(p_act text, p_target text, p_reason text, p_outcome text, p_detail text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('PLATFORM.OPERATE', '{}'::jsonb);
  v_id    uuid;
begin
  if p_act is null or p_act not in ('ADAPTER_START', 'ADAPTER_STOP', 'ADAPTER_RESTART', 'ANALYTICS_START', 'ANALYTICS_STOP', 'ANALYTICS_RESTART') then
    raise exception using errcode = 'P0001', message = format('EBMR-OPS-001 %s is not an operation of a background worker', coalesce(p_act, '(none)'));
  end if;
  if btrim(coalesce(p_reason, '')) = '' or length(p_reason) > 1000 then
    raise exception using errcode = 'P0001', message = 'EBMR-OPS-002 an operation of a background worker needs the reason, up to 1000 characters';
  end if;
  begin
    insert into platform.operations_act (act, target, reason, outcome, detail, person_id, account_id, session_id, correlation_id)
    values (p_act, p_target, btrim(p_reason), coalesce(p_outcome, 'DONE'), nullif(btrim(coalesce(p_detail, '')), ''),
            (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception using errcode = 'P0001', message = format('EBMR-OPS-003 invalid operations record: %s', sqlerrm);
  end;
  return v_id;
end
$$;
revoke all on function platform.record_operations_act(text, text, text, text, text) from public;
grant execute on function platform.record_operations_act(text, text, text, text, text) to ebmr_app;

create table continuity.backup_request (
  id              uuid primary key default gen_random_uuid(),
  tier            text not null check (tier in ('RETENTION_GRADE', 'OPERATIONAL')),
  reason          text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  person_id       uuid not null,
  account_id      uuid not null,
  session_id      uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  correlation_id  uuid not null
);
revoke all on continuity.backup_request from public;
grant select on continuity.backup_request to ebmr_app;
select kernel.register_audited_table('continuity.backup_request', 'backup_request', 'id', true);
select platform.enforce_db_time('continuity.backup_request', array['recorded_at']);

create function continuity.request_backup(p_reason text, p_tier text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, continuity, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('CONTINUITY.BACKUP_RUN', '{}'::jsonb);
  v_id    uuid;
begin
  if btrim(coalesce(p_reason, '')) = '' or length(p_reason) > 1000 or coalesce(p_tier, '') not in ('RETENTION_GRADE', 'OPERATIONAL') then
    raise exception using errcode = 'P0001', message = 'EBMR-OPS-020 a backup request names its tier (RETENTION_GRADE or OPERATIONAL) and the reason, up to 1000 characters';
  end if;
  insert into continuity.backup_request (tier, reason, person_id, account_id, session_id, correlation_id)
  values (p_tier, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid,
          (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;
revoke all on function continuity.request_backup(text, text) from public;
grant execute on function continuity.request_backup(text, text) to ebmr_app;

create table continuity.backup_download (
  id              uuid primary key default gen_random_uuid(),
  backup_id       text not null references continuity.backup_catalogue (backup_id),
  person_id       uuid not null,
  account_id      uuid not null,
  session_id      uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  correlation_id  uuid not null
);
revoke all on continuity.backup_download from public;
grant select on continuity.backup_download to ebmr_app;
select kernel.register_audited_table('continuity.backup_download', 'backup_download', 'backup_id', true);
select platform.enforce_db_time('continuity.backup_download', array['recorded_at']);

create function continuity.record_backup_download(p_backup_id text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, continuity, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('CONTINUITY.BACKUP_RUN', '{}'::jsonb);
  v_id    uuid;
begin
  if not exists (select 1 from continuity.backup_catalogue c where c.backup_id = p_backup_id) then
    raise exception using errcode = 'P0001', message = format('EBMR-OPS-021 no backup %s is in the catalogue', coalesce(p_backup_id, '(none)'));
  end if;
  insert into continuity.backup_download (backup_id, person_id, account_id, session_id, correlation_id)
  values (p_backup_id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid,
          (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;
revoke all on function continuity.record_backup_download(text) from public;
grant execute on function continuity.record_backup_download(text) to ebmr_app;

reset role;
