-- Backups and restore drills (control DI-45; build outline 4.2; ADR 0007).
--
-- Every backup job run is recorded, success or failure, by a system service account only; a failure
-- raises an alarm. Successful backups
-- enter the backup catalogue. The catalogue is insert-only: neither the application role nor the table
-- owner can delete or change an entry, and every entry names immutable (write-once) storage for
-- retention-grade copies. Deleting the stored artefact itself is prevented at the storage layer
-- (object lock in compliance mode; docs/operations/ha-and-restore.md). Every restore drill is recorded
-- with the hash of its report; a failed drill raises an alarm.
--
-- Error codes: EBMR-CONT-03x.

set local role ebmr_owner;

create table continuity.backup_job_run (
  id              uuid primary key default gen_random_uuid(),
  job_name        text not null check (job_name ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  tier            text not null check (tier in ('RETENTION_GRADE', 'OPERATIONAL')),
  status          text not null check (status in ('SUCCEEDED', 'FAILED')),
  backup_id       text,
  started_at      timestamptz not null,   -- claimed by the job host
  finished_at     timestamptz not null,   -- claimed by the job host
  error_text      text,
  report_sha256   text check (report_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by_person_id  uuid not null,
  recorded_by_account_id uuid not null,
  recorded_at     timestamptz not null default clock_timestamp(),
  correlation_id  uuid not null,
  check ((status = 'SUCCEEDED') = (backup_id is not null)),
  check (status = 'SUCCEEDED' or length(trim(coalesce(error_text, ''))) > 0),
  check (finished_at >= started_at)
);

create table continuity.backup_catalogue (
  backup_id          text primary key check (backup_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
  job_run_id         uuid not null unique references continuity.backup_job_run (id),
  tier               text not null check (tier in ('RETENTION_GRADE', 'OPERATIONAL')),
  method             text not null check (method in ('PG_DUMP_CUSTOM', 'BASE_BACKUP_WITH_WAL')),
  database_name      text not null,
  artefact_sha256    text not null check (artefact_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes         bigint not null check (size_bytes > 0),
  storage_uri        text not null check (length(storage_uri) > 0),
  immutable_until    date,          -- write-once retention lock on the stored artefact
  encryption_key_ref text not null check (length(encryption_key_ref) > 0),   -- backups are always encrypted
  tool_version       text not null,
  snapshot_taken_at  timestamptz not null,   -- claimed: the consistent point the backup represents
  recorded_at        timestamptz not null default clock_timestamp(),
  correlation_id     uuid not null,
  -- A retention-grade copy is the FDA 211.68(b) backup: kept for the retention period on write-once storage.
  check (tier <> 'RETENTION_GRADE' or immutable_until is not null)
);

create table continuity.restore_drill (
  id                uuid primary key default gen_random_uuid(),
  drill_id          text not null unique check (drill_id ~ '^[A-Za-z0-9._:-]{8,128}$'),
  source_database   text not null,
  restored_database text not null,
  backup_sha256     text check (backup_sha256 ~ '^[0-9a-f]{64}$'),
  result            text not null check (result in ('PASS', 'FAIL')),
  failures          jsonb not null default '[]'::jsonb check (jsonb_typeof(failures) = 'array'),
  tables_compared   integer not null check (tables_compared >= 0),
  tables_matching   integer not null check (tables_matching >= 0),
  chains_verified   integer not null check (chains_verified >= 0),
  report_sha256     text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),
  report_uri        text not null check (length(report_uri) > 0),
  started_at        timestamptz not null,
  finished_at       timestamptz not null,
  recorded_by_person_id  uuid not null,
  recorded_by_account_id uuid not null,
  recorded_at       timestamptz not null default clock_timestamp(),
  correlation_id    uuid not null,
  check (result = 'FAIL' or (jsonb_array_length(failures) = 0 and tables_matching = tables_compared)),
  check (result = 'PASS' or jsonb_array_length(failures) > 0)
);

select kernel.register_audited_table('continuity.backup_job_run', 'backup_job', 'job_name', true);
select kernel.register_audited_table('continuity.backup_catalogue', 'backup', 'backup_id', true);
select kernel.register_audited_table('continuity.restore_drill', 'restore_drill', 'drill_id', true);

-- p_run: {job_name, tier, status, started_at, finished_at, error_text?, report_sha256?,
--         backup?: {backup_id, method, database_name, artefact_sha256, size_bytes, storage_uri, immutable_until,
--                   encryption_key_ref, tool_version, snapshot_taken_at}}
create function continuity.record_backup_job(p_run jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx  jsonb := continuity.require_actor();
  v_corr uuid := (v_ctx ->> 'correlation_id')::uuid;
  v_id   uuid;
  v_b    jsonb := p_run -> 'backup';
  v_status text := p_run ->> 'status';
begin
  if p_run is null or jsonb_typeof(p_run) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-030 a backup job record is required';
  end if;
  if v_ctx ->> 'source' <> 'SYSTEM' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-030 backup jobs are recorded only by a system service account (source SYSTEM)';
  end if;
  if v_status = 'SUCCEEDED' and (v_b is null or jsonb_typeof(v_b) <> 'object') then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-030 a successful backup job must describe the backup it produced';
  end if;
  if v_status = 'FAILED' and v_b is not null and jsonb_typeof(v_b) <> 'null' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-030 a failed backup job cannot enter a backup into the catalogue';
  end if;
  begin
    insert into continuity.backup_job_run (job_name, tier, status, backup_id, started_at, finished_at, error_text, report_sha256,
                                           recorded_by_person_id, recorded_by_account_id, correlation_id)
    values (p_run ->> 'job_name', p_run ->> 'tier', v_status, v_b ->> 'backup_id',
            (p_run ->> 'started_at')::timestamptz, (p_run ->> 'finished_at')::timestamptz, p_run ->> 'error_text', p_run ->> 'report_sha256',
            (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, v_corr)
    returning id into v_id;
    if v_status = 'SUCCEEDED' then
      insert into continuity.backup_catalogue (backup_id, job_run_id, tier, method, database_name, artefact_sha256, size_bytes, storage_uri,
                                               immutable_until, encryption_key_ref, tool_version, snapshot_taken_at, correlation_id)
      values (v_b ->> 'backup_id', v_id, p_run ->> 'tier', v_b ->> 'method', v_b ->> 'database_name', v_b ->> 'artefact_sha256',
              (v_b ->> 'size_bytes')::bigint, v_b ->> 'storage_uri', (v_b ->> 'immutable_until')::date, v_b ->> 'encryption_key_ref',
              v_b ->> 'tool_version', (v_b ->> 'snapshot_taken_at')::timestamptz, v_corr);
    end if;
  exception
    when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow
         or numeric_value_out_of_range or unique_violation then
      raise exception using errcode = 'P0001', message = format('EBMR-CONT-030 invalid backup job record: %s', sqlerrm);
  end;
  if v_status = 'FAILED' then
    perform continuity.raise_alarm('BACKUP_JOB_FAILED', 'HIGH',
      format('Backup job %s (%s) failed', p_run ->> 'job_name', p_run ->> 'tier'),
      jsonb_build_object('job_run_id', v_id, 'error', p_run ->> 'error_text'));
  end if;
  return v_id;
end
$$;

-- p_drill: {drill_id, source_database, restored_database, backup_sha256?, result, failures: [text],
--           tables_compared, tables_matching, chains_verified, report_sha256, report_uri, started_at, finished_at}
create function continuity.record_restore_drill(p_drill jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, continuity, kernel, pg_temp as $$
declare
  v_ctx  jsonb := continuity.require_actor();
  v_id   uuid;
begin
  if p_drill is null or jsonb_typeof(p_drill) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-031 a restore drill record is required';
  end if;
  if v_ctx ->> 'source' <> 'SYSTEM' then
    raise exception using errcode = 'P0001', message = 'EBMR-CONT-031 restore drills are recorded only by a system service account (source SYSTEM)';
  end if;
  begin
    insert into continuity.restore_drill (drill_id, source_database, restored_database, backup_sha256, result, failures, tables_compared,
                                          tables_matching, chains_verified, report_sha256, report_uri, started_at, finished_at,
                                          recorded_by_person_id, recorded_by_account_id, correlation_id)
    values (p_drill ->> 'drill_id', p_drill ->> 'source_database', p_drill ->> 'restored_database', p_drill ->> 'backup_sha256',
            p_drill ->> 'result', coalesce(p_drill -> 'failures', '[]'::jsonb), (p_drill ->> 'tables_compared')::integer,
            (p_drill ->> 'tables_matching')::integer, (p_drill ->> 'chains_verified')::integer, p_drill ->> 'report_sha256',
            p_drill ->> 'report_uri', (p_drill ->> 'started_at')::timestamptz, (p_drill ->> 'finished_at')::timestamptz,
            (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
    returning id into v_id;
  exception
    when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format or datetime_field_overflow
         or numeric_value_out_of_range or unique_violation then
      raise exception using errcode = 'P0001', message = format('EBMR-CONT-031 invalid restore drill record: %s', sqlerrm);
  end;
  if p_drill ->> 'result' = 'FAIL' then
    perform continuity.raise_alarm('RESTORE_DRILL_FAILED', 'HIGH',
      format('Restore drill %s failed', p_drill ->> 'drill_id'),
      jsonb_build_object('restore_drill_id', v_id, 'failures', p_drill -> 'failures', 'report_uri', p_drill ->> 'report_uri'));
  end if;
  return v_id;
end
$$;

revoke all on continuity.backup_job_run, continuity.backup_catalogue, continuity.restore_drill from ebmr_app;
grant select on continuity.backup_job_run, continuity.backup_catalogue, continuity.restore_drill to ebmr_app;
grant execute on function continuity.record_backup_job(jsonb), continuity.record_restore_drill(jsonb) to ebmr_app;

reset role;
