-- Phase 7 slice 7g-4 (decision 0025 point 2): the demo and sandbox conveniences of the web app's operations screens,
-- refused on a GMP installation here in the database, and the backup catalogue read by session.
--
-- Handbook: modules/tablets-server.md
--
-- A demo installation (decision D6, D-P7g4-1) is a database the set-up marked tab.demo_installation, which only a demo
-- or E2E database name can carry (0001: names ending in _demo or with _e2e_<hex>); it may be of either kind, so that the
-- GMP flows can be shown. The conveniences (loading the demo data, resetting the installation, the simulators' test
-- console and their faults) run on a SANDBOX installation or a demo installation, never on any other GMP one.
--
--   tab.demo_conveniences_problem()        NULL where the conveniences run, else why not (EBMR-OPS-010)
--   tab.demo_act                           insert-only, audited: each convenience a person used, with the reason
--   tab.record_demo_act(act, target, reason)  refuses on a GMP installation that is not a demo one (EBMR-OPS-010), then
--                                          needs PLATFORM.OPERATE (kernel 1376); EBMR-OPS-011 for a malformed record.
--                                          The server calls it before it acts, so a refused convenience does nothing.
--   tab.installation_contents()            what a reset or a demo load would remove (counts), for its confirmation
--   tab.backup_overview(token)             the backup catalogue, the job runs and the requests, for the session behind
--                                          the request (tab.reader_of, 0410) when its role holds CONTINUITY.BACKUP_READ
--                                          (kernel 1376; EBMR-OPS-030 otherwise)
--
-- Messages: EBMR-OPS-010, EBMR-OPS-011, EBMR-OPS-030.

set local role ebmr_owner;

create function tab.demo_conveniences_problem() returns text
language sql stable security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
  select case
    when kernel.installation_kind() = 'SANDBOX' or tab.is_demo_installation() then null
    else format('EBMR-OPS-010 %s is a GMP installation, not a demo one: demo data, resets and simulators are refused here (decision 0025; DI-05)',
                pg_catalog.current_database())
  end
$$;
revoke all on function tab.demo_conveniences_problem() from public;
grant execute on function tab.demo_conveniences_problem() to ebmr_app;

create table tab.demo_act (
  id              uuid primary key default gen_random_uuid(),
  act             text not null check (act in ('DEMO_LOAD', 'DEMO_RESET', 'SIMULATOR_START', 'SIMULATOR_STOP', 'SIMULATOR_FAULT_ON', 'SIMULATOR_FAULT_OFF')),
  target          text not null check (target ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  reason          text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  person_id       uuid not null,
  account_id      uuid not null,
  session_id      uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  correlation_id  uuid not null
);
revoke all on tab.demo_act from public;
grant select on tab.demo_act to ebmr_app;
select kernel.register_audited_table('tab.demo_act', 'demo_act', 'target', true);
select platform.enforce_db_time('tab.demo_act', array['recorded_at']);

create function tab.record_demo_act(p_act text, p_target text, p_reason text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_problem text := tab.demo_conveniences_problem();
  v_actor   jsonb;
  v_id      uuid;
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = v_problem;
  end if;
  v_actor := iam.require_permission('PLATFORM.OPERATE', '{}'::jsonb);
  begin
    insert into tab.demo_act (act, target, reason, person_id, account_id, session_id, correlation_id)
    values (p_act, p_target, btrim(coalesce(p_reason, '')), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid,
            (v_actor ->> 'session_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception using errcode = 'P0001',
      message = format('EBMR-OPS-011 a demo or simulator act names a known act, its target and the reason (up to 1000 characters): %s', sqlerrm);
  end;
  return v_id;
end
$$;
revoke all on function tab.record_demo_act(text, text, text) from public;
grant execute on function tab.record_demo_act(text, text, text) to ebmr_app;

create function tab.installation_contents() returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, iam, esig, kernel, recipe, pg_temp as $$
  select jsonb_build_object(
    'persons', (select count(*) from iam.person p where p.kind = 'NATURAL')::text,
    'accounts', (select count(*) from iam.account)::text,
    'devices', (select count(*) from iam.device)::text,
    'batches', (select count(*) from recipe.batch_execution)::text,
    'signatures', (select count(*) from esig.signature)::text,
    'auditEntries', (select count(*) from kernel.audit_event)::text)
$$;
revoke all on function tab.installation_contents() from public;
grant execute on function tab.installation_contents() to ebmr_app;

create function tab.backup_overview(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, continuity, iam, pg_temp as $$
declare
  r tab.reader := tab.reader_of(p_token_hash);
begin
  if not tab.role_may(r.role_code, array['CONTINUITY.BACKUP_READ']) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-OPS-030 %s lacks CONTINUITY.BACKUP_READ: the backup catalogue is read by the system administrator, the process owner and QA (DI-45)', r.role_code);
  end if;
  return jsonb_build_object(
    'backups', coalesce((select jsonb_agg(jsonb_build_object(
        'backupId', c.backup_id, 'tier', c.tier, 'method', c.method, 'databaseName', c.database_name, 'sha256', c.artefact_sha256,
        'sizeBytes', c.size_bytes::text, 'storageUri', c.storage_uri, 'immutableUntil', c.immutable_until::text,
        'encryptionKeyRef', c.encryption_key_ref, 'toolVersion', c.tool_version,
        'snapshotTakenAtUs', (extract(epoch from c.snapshot_taken_at) * 1000000)::bigint::text,
        'recordedAtUs', (extract(epoch from c.recorded_at) * 1000000)::bigint::text) order by c.recorded_at desc, c.backup_id)
      from (select * from continuity.backup_catalogue order by recorded_at desc, backup_id limit 50) c), '[]'::jsonb),
    'runs', coalesce((select jsonb_agg(jsonb_build_object(
        'jobRunId', j.id, 'jobName', j.job_name, 'tier', j.tier, 'status', j.status, 'backupId', j.backup_id, 'error', j.error_text,
        'startedAtUs', (extract(epoch from j.started_at) * 1000000)::bigint::text,
        'finishedAtUs', (extract(epoch from j.finished_at) * 1000000)::bigint::text) order by j.recorded_at desc, j.id)
      from (select * from continuity.backup_job_run order by recorded_at desc, id limit 50) j), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object(
        'requestId', q.id, 'tier', q.tier, 'reason', q.reason, 'personId', q.person_id,
        'by', coalesce((select p.legal_name from iam.person p where p.id = q.person_id), '(unknown)'),
        'recordedAtUs', (extract(epoch from q.recorded_at) * 1000000)::bigint::text) order by q.recorded_at desc, q.id)
      from (select * from continuity.backup_request order by recorded_at desc, id limit 50) q), '[]'::jsonb));
end
$$;
revoke all on function tab.backup_overview(text) from public;
grant execute on function tab.backup_overview(text) to ebmr_app;

reset role;
