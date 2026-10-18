-- Phase 7 slice 7b-2: the periodic evaluation pack of the eBMR itself and its readability report (DI-11 clause 1,
-- DI-44 clause 1; plan phase-7-plan.md "Slice 7b-2"). Core: the pack is stored with its SHA-256 and QA signs it off with
-- a signature bound to that hash; the database checks the pack's entries against the source logs.
--
-- Handbook: modules/kernel.md
--
-- The entries (read through the reporting path, ebmr_report):
--   report.evaluation_source               insert-only registry: per topic and source log, a STABLE row function of the
--                                          owning module returning (source_row text, occurred_at timestamptz,
--                                          ended_at timestamptz, summary jsonb), and how a period selects its rows:
--                                          IN_PERIOD (occurred in [from, to)) or OPEN_AT_END (occurred before `to` and not
--                                          ended before it: an open issue). Times are database-clock times, so a past
--                                          period's entries never change. The kernel registers changes, configuration
--                                          changes, incidents, access recertifications, backups, restore drills,
--                                          integration alarms, time-sync events, integrity checks and open issues;
--                                          site-services 1120 adds deviations; recipe-core 1240 adds the audit-trail
--                                          reviews and the recipe change records.
--   report.evaluation_topic_v1             the registered topics and their source logs.
--   report.evaluation_entry_v1             every entry of every source (view over report.evaluation_entry_rows_v1()).
--   report.evaluation_period_rows_v1(from, to)
--                                          the entries of one period, as the pack lists them and as its store checks them.
--
-- The pack:
--   records.evaluation_pack                insert-only: the pack text (JSON, format ebmr.periodic-evaluation/1), its
--                                          SHA-256, the period, the counts and who generated it.
--   records.store_evaluation_pack(p, sha)  VALIDATION.MANAGE. Recomputes the SHA-256; requires a period that has ended,
--                                          every registered topic, exactly the period's entries (each named by its source
--                                          log and row) and exactly the seeded readability sample of the records closed
--                                          before the period's end (report.readability_sample_rows_v1, kernel 1335), each
--                                          with its result and, when readable, its render SHA-256.
--   records.evaluation_pack_approval       insert-only: QA's sign-off, one per pack.
--   records.approve_evaluation_pack(id, s) VALIDATION.APPROVE_EVALUATION and the approver's own signature with meaning
--                                          PERIODIC_EVALUATION_APPROVED over the signed content of the pack (aggregate
--                                          evaluation_pack): its SHA-256, period and counts. The person who generated the
--                                          pack never signs it off (INV-03, excludes performers).
--
-- Permissions: VALIDATION.APPROVE_EVALUATION (GMP, SIGN): QA_REVIEWER and QA_MBR_APPROVER (the quality unit; held by kernel
-- roles, as kernel 1300 grants VALIDATION.APPROVE_SUMMARY). Generating uses VALIDATION.MANAGE (CSV_DI_LEAD); reading the
-- sampled records for the readability report uses RECORD.EXPORT (kernel 1335).
--
-- Messages: EBMR-REC-150 to EBMR-REC-159 (and EBMR-REC-141 of the readability sample, kernel 1335).

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1336_periodic_evaluation_pack)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the periodic evaluation pack of the system and its readability report (DI-11, DI-44)'));

insert into iam.permission (code, domain, effect, description) values
  ('VALIDATION.APPROVE_EVALUATION', 'GMP', 'SIGN', 'Sign off the periodic evaluation pack of the system (DI-11)');
insert into iam.role_permission (role_code, permission_code) values
  ('QA_REVIEWER', 'VALIDATION.APPROVE_EVALUATION'),
  ('QA_MBR_APPROVER', 'VALIDATION.APPROVE_EVALUATION');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values ('PERIODIC_EVALUATION_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'RECORDS', 'APPROVER', 'Periodic evaluation approved',
        'As a quality-unit approver, I have reviewed this periodic evaluation of the system and its readability report and approve it.',
        array['VALIDATION.APPROVE_EVALUATION'], '{}', true, false, false, 'ALL_COMPONENTS', false,
        'DI-11 (periodic evaluation of the computerised system, records kept); DI-44 (readability checks); EU Annex 11 section 11; 21 CFR 211.68(a)');

-- ---------------------------------------------------------------------------------------------
-- The entries
-- ---------------------------------------------------------------------------------------------

create table report.evaluation_source (
  topic         text not null check (topic ~ '^[A-Z][A-Z_]*$'),
  source_log    text not null check (source_log ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  row_function  regprocedure not null,
  selection     text not null check (selection in ('IN_PERIOD', 'OPEN_AT_END')),
  description   text not null check (btrim(description) <> ''),
  recorded_at   timestamptz not null default clock_timestamp(),
  primary key (topic, source_log)
);
revoke all on report.evaluation_source from public;
create trigger aa_insert_only before update or delete on report.evaluation_source for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on report.evaluation_source for each statement execute function kernel.reject_mutation();

-- Registers one source of a topic (migrations only: the owner).
create function report.register_evaluation_source(p_topic text, p_source_log text, p_function regprocedure, p_selection text, p_description text)
returns void
language plpgsql volatile security definer set search_path = pg_catalog, report, pg_temp as $$
declare
  v_cols text;
begin
  select pg_catalog.string_agg(a.name || ' ' || a.type, ', ' order by a.n) into v_cols
    from pg_catalog.pg_proc p
    cross join lateral rows from (pg_catalog.unnest(p.proargnames), pg_catalog.unnest(p.proallargtypes::regtype[]::text[]),
                                 pg_catalog.unnest(p.proargmodes::text[])) with ordinality as a(name, type, mode, n)
   where p.oid = p_function and a.mode = 't';
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = p_function and p.pronargs = 0 and p.provolatile <> 'v' and p.proretset)
     or v_cols is distinct from 'source_row text, occurred_at timestamp with time zone, ended_at timestamp with time zone, summary jsonb'
     or pg_catalog.to_regclass(p_source_log) is null then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-REC-150 %s is no evaluation source of %s: a STABLE function without arguments returning table (source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb) over an existing source log (DI-11)',
      p_function, p_source_log);
  end if;
  insert into report.evaluation_source (topic, source_log, row_function, selection, description)
  values (p_topic, p_source_log, p_function, p_selection, btrim(p_description));
end
$$;
revoke all on function report.register_evaluation_source(text, text, regprocedure, text, text) from public;

create function report.evaluation_entry_rows_v1()
returns table (topic text, source_log text, source_row text, occurred_at timestamptz, ended_at timestamptz, selection text, summary jsonb,
               read_at timestamptz, data_as_of timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, report, pg_temp as $$
declare
  s record;
begin
  for s in select e.topic, e.source_log, e.row_function, e.selection from report.evaluation_source e
            order by e.topic collate "C", e.source_log collate "C" loop
    return query execute format(
      'select %L::text, %L::text, x.source_row, x.occurred_at, x.ended_at, %L::text, x.summary, pg_catalog.statement_timestamp(), report.data_as_of() from %s x',
      s.topic, s.source_log, s.selection, s.row_function::text);
  end loop;
end
$$;

create function report.evaluation_period_rows_v1(p_from timestamptz, p_to timestamptz)
returns table (topic text, source_log text, source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb)
language plpgsql stable security definer set search_path = pg_catalog, report, pg_temp as $$
begin
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-151 an evaluation period has a start before its end (DI-11)';
  end if;
  return query
    select e.topic, e.source_log, e.source_row, e.occurred_at, e.ended_at, e.summary
      from report.evaluation_entry_rows_v1() e
     where (e.selection = 'IN_PERIOD' and e.occurred_at >= p_from and e.occurred_at < p_to)
        or (e.selection = 'OPEN_AT_END' and e.occurred_at < p_to and (e.ended_at is null or e.ended_at >= p_to))
     order by e.topic collate "C", e.source_log collate "C", e.occurred_at, e.source_row collate "C";
end
$$;

create function report.evaluation_topic_rows_v1()
returns table (topic text, source_log text, selection text, description text, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, report, pg_temp as $$
  select e.topic, e.source_log, e.selection, e.description, pg_catalog.statement_timestamp(), report.data_as_of()
    from report.evaluation_source e
   order by e.topic collate "C", e.source_log collate "C"
$$;

-- The kernel's sources. Each names its row by the source log's key and summarises it without free text a person typed
-- beyond titles.
create function report.evaluation_change_records()
returns table (source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb)
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select c.id::text, c.raised_at, null::timestamptz,
         jsonb_build_object('number', c.number, 'title', c.title, 'areas', to_jsonb(c.areas),
                            'events', coalesce((select jsonb_agg(e.event order by e.recorded_at, e.id) from platform.change_record_event e where e.change_record_id = c.id), '[]'::jsonb))
    from platform.change_record c
$$;
create function report.evaluation_config_changes()
returns table (source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb)
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select v.id::text, v.recorded_at, null::timestamptz,
         jsonb_build_object('area', v.area, 'item', v.item_key, 'basis', v.basis, 'changeRecordId', v.change_record_id)
    from platform.config_version v
$$;
create function report.evaluation_incidents()
returns table (source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb)
language sql stable security definer set search_path = pg_catalog, records, pg_temp as $$
  select i.id::text, i.recorded_at, i.closed_at,
         jsonb_build_object('reference', i.reference, 'type', i.incident_type, 'source', i.source, 'severity', i.severity,
                            'status', i.status, 'title', i.title)
    from records.incident_current i
$$;
create function report.evaluation_open_di_investigations()
returns table (source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb)
language sql stable security definer set search_path = pg_catalog, records, pg_temp as $$
  select d.id::text, d.recorded_at, c.recorded_at,
         jsonb_build_object('number', d.investigation_no, 'closed', c.investigation_id is not null)
    from records.di_investigation d left join records.di_investigation_closure c on c.investigation_id = d.id
$$;
create function report.evaluation_access_recertifications()
returns table (source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb)
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select r.id::text, r.recorded_at, null::timestamptz,
         jsonb_build_object('accountId', r.account_id, 'outcome', r.outcome, 'grantsReviewed', coalesce(cardinality(r.grants_reviewed), 0),
                            'nextDueAt', r.next_due_at)
    from iam.access_recertification r
$$;
create function report.evaluation_backups()
returns table (source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb)
language sql stable security definer set search_path = pg_catalog, continuity, pg_temp as $$
  select b.id::text, b.recorded_at, null::timestamptz,
         jsonb_build_object('job', b.job_name, 'tier', b.tier, 'status', b.status, 'backupId', b.backup_id, 'reportSha256', b.report_sha256)
    from continuity.backup_job_run b
$$;
create function report.evaluation_restore_drills()
returns table (source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb)
language sql stable security definer set search_path = pg_catalog, continuity, pg_temp as $$
  select d.id::text, d.recorded_at, null::timestamptz,
         jsonb_build_object('drill', d.drill_id, 'result', d.result, 'tablesCompared', d.tables_compared, 'tablesMatching', d.tables_matching,
                            'chainsVerified', d.chains_verified, 'reportSha256', d.report_sha256)
    from continuity.restore_drill d
$$;
create function report.evaluation_integration_alarms()
returns table (source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb)
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select a.id::text, a.raised_at, null::timestamptz,
         jsonb_build_object('adapter', a.adapter_code, 'kind', a.kind, 'severity', a.severity)
    from platform.integration_alarm a
$$;
create function report.evaluation_time_events()
returns table (source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb)
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select t.id::text, t.recorded_at, null::timestamptz,
         jsonb_build_object('kind', t.kind, 'aggregate', t.aggregate_type || ':' || t.aggregate_id, 'seq', t.aggregate_seq)
    from platform.time_anomaly t
$$;
create function report.evaluation_integrity_checks()
returns table (source_row text, occurred_at timestamptz, ended_at timestamptz, summary jsonb)
language sql stable security definer set search_path = pg_catalog, kernel, pg_temp as $$
  select r.id::text, r.started_at, null::timestamptz,
         jsonb_build_object('chainsChecked', r.chains_checked, 'problems', r.problem_count, 'alarm', r.alarm_severity, 'finishedAt', r.finished_at)
    from kernel.audit_verification_run r
$$;
revoke all on function report.evaluation_change_records(), report.evaluation_config_changes(), report.evaluation_incidents(),
                       report.evaluation_open_di_investigations(), report.evaluation_access_recertifications(), report.evaluation_backups(),
                       report.evaluation_restore_drills(), report.evaluation_integration_alarms(), report.evaluation_time_events(),
                       report.evaluation_integrity_checks() from public;

select report.register_evaluation_source('CHANGE_RECORD', 'platform.change_record', 'report.evaluation_change_records()', 'IN_PERIOD',
  'Change records of the system and its configuration raised in the period, with their approval and closure (DI-09)');
select report.register_evaluation_source('CONFIG_CHANGE', 'platform.config_version', 'report.evaluation_config_changes()', 'IN_PERIOD',
  'Configuration versions recorded in the period, each with its basis and change record (DI-09)');
select report.register_evaluation_source('INCIDENT', 'records.incident', 'report.evaluation_incidents()', 'IN_PERIOD',
  'Incidents of the system raised in the period: interface failures, security and data-integrity events (DI-12)');
select report.register_evaluation_source('ACCESS_RECERTIFICATION', 'iam.access_recertification', 'report.evaluation_access_recertifications()', 'IN_PERIOD',
  'Access recertifications done in the period (DI-16)');
select report.register_evaluation_source('BACKUP', 'continuity.backup_job_run', 'report.evaluation_backups()', 'IN_PERIOD',
  'Backup job runs recorded in the period, succeeded or failed (DI-45)');
select report.register_evaluation_source('RESTORE_DRILL', 'continuity.restore_drill', 'report.evaluation_restore_drills()', 'IN_PERIOD',
  'Restore drills recorded in the period with their result (DI-45)');
select report.register_evaluation_source('INTEGRATION_ALARM', 'platform.integration_alarm', 'report.evaluation_integration_alarms()', 'IN_PERIOD',
  'Alarms of the integrations raised in the period (DI-31)');
select report.register_evaluation_source('TIME_SYNC', 'platform.time_anomaly', 'report.evaluation_time_events()', 'IN_PERIOD',
  'Time anomalies of the database clock recorded in the period');
select report.register_evaluation_source('INTEGRITY_CHECK', 'kernel.audit_verification_run', 'report.evaluation_integrity_checks()', 'IN_PERIOD',
  'Runs of the audit-trail verification job started in the period, with their findings (DI-23, DI-44)');
select report.register_evaluation_source('OPEN_ISSUE', 'records.incident', 'report.evaluation_incidents()', 'OPEN_AT_END',
  'Incidents still open at the end of the period (known issues)');
select report.register_evaluation_source('OPEN_ISSUE', 'records.di_investigation', 'report.evaluation_open_di_investigations()', 'OPEN_AT_END',
  'Data-integrity investigations still open at the end of the period (known issues)');

create view report.evaluation_entry_v1 as select * from report.evaluation_entry_rows_v1();
create view report.evaluation_topic_v1 as select * from report.evaluation_topic_rows_v1();
revoke all on function report.evaluation_entry_rows_v1(), report.evaluation_period_rows_v1(timestamptz, timestamptz), report.evaluation_topic_rows_v1() from public;
grant execute on function report.evaluation_entry_rows_v1(), report.evaluation_period_rows_v1(timestamptz, timestamptz), report.evaluation_topic_rows_v1()
  to ebmr_app, ebmr_report;
revoke all on report.evaluation_entry_v1, report.evaluation_topic_v1 from public;
grant select on report.evaluation_entry_v1, report.evaluation_topic_v1 to ebmr_app, ebmr_report;
insert into report.view_registry (view_name, version, grain, description) values
  ('evaluation_entry_v1', 1, 'source-log row', 'Every entry of the periodic evaluation of the system: its topic, source log and row, when it occurred and ended'),
  ('evaluation_topic_v1', 1, 'evaluation topic and source log', 'The topics of the periodic evaluation, their source logs and how a period selects their rows');

-- ---------------------------------------------------------------------------------------------
-- The pack and its sign-off
-- ---------------------------------------------------------------------------------------------

create table records.evaluation_pack (
  id                   uuid primary key default gen_random_uuid(),
  pack_sha256          text not null unique check (pack_sha256 ~ '^[0-9a-f]{64}$'),
  pack                 text not null,
  period_from          timestamptz not null,
  period_to            timestamptz not null,
  entry_count          integer not null check (entry_count >= 0),
  sample_count         integer not null check (sample_count >= 0),
  unreadable_count     integer not null check (unreadable_count >= 0 and unreadable_count <= sample_count),
  generated_by_person  uuid not null,
  generated_by_account uuid not null,
  recorded_at          timestamptz not null default clock_timestamp(),
  check (period_from < period_to and period_to <= recorded_at)
);
revoke all on records.evaluation_pack from public;
grant select on records.evaluation_pack to ebmr_app;
select platform.enforce_db_time('records.evaluation_pack', array['recorded_at']);
select kernel.register_audited_table('records.evaluation_pack', 'evaluation_pack', 'id', true);

create table records.evaluation_pack_approval (
  pack_id             uuid primary key references records.evaluation_pack (id),
  approved_signature  uuid not null unique,
  approved_by_person  uuid not null,
  approved_by_account uuid not null,
  recorded_at         timestamptz not null default clock_timestamp()
);
revoke all on records.evaluation_pack_approval from public;
grant select on records.evaluation_pack_approval to ebmr_app;
select platform.enforce_db_time('records.evaluation_pack_approval', array['recorded_at']);
select kernel.register_audited_table('records.evaluation_pack_approval', 'evaluation_pack', 'pack_id', true);

create function records.store_evaluation_pack(p_pack text, p_pack_sha256 text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, records, kernel, report, iam, pg_temp as $$
declare
  v_actor    jsonb;
  v_m        jsonb;
  v_from     timestamptz;
  v_to       timestamptz;
  v_given    text[];
  v_expected text[];
  v_missing  integer;
  v_extra    integer;
  v_seed     text;
  v_size     integer;
  v_unread   integer;
  v_entries  integer;
  v_id       uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('VALIDATION.MANAGE', '{}'::jsonb);
  if p_pack is null or coalesce(p_pack_sha256, '') !~ '^[0-9a-f]{64}$'
     or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_pack, 'UTF8')), 'hex') <> p_pack_sha256 then
    raise exception using errcode = 'P0001', message =
      'EBMR-REC-152 an evaluation pack is stored with its text and the text''s SHA-256 (64 lowercase hex characters), which must match (DI-11)';
  end if;
  begin
    v_m := p_pack::jsonb;
    v_from := (v_m #>> '{period,from}')::timestamptz;
    v_to := (v_m #>> '{period,to}')::timestamptz;
    v_seed := v_m #>> '{readability,seed}';
    v_size := (v_m #>> '{readability,sampleSize}')::integer;
  exception when others then
    v_m := null;
  end;
  if v_m is null or jsonb_typeof(v_m) <> 'object' or v_m ->> 'format' is distinct from 'ebmr.periodic-evaluation/1'
     or v_from is null or v_to is null or jsonb_typeof(v_m -> 'topics') is distinct from 'array'
     or jsonb_typeof(v_m #> '{readability,records}') is distinct from 'array' or v_seed is null or v_size is null then
    raise exception using errcode = 'P0001', message =
      'EBMR-REC-152 the pack is no ebmr.periodic-evaluation/1 pack with its period, topics and readability report (DI-11)';
  end if;
  if v_from >= v_to or v_to > pg_catalog.clock_timestamp() then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-REC-153 the period %s to %s has not ended: a pack is stored for a period that is over (DI-11)', v_from, v_to);
  end if;
  -- Every registered topic, each once.
  select coalesce(pg_catalog.array_agg(t ->> 'topic' order by t ->> 'topic' collate "C"), '{}') into v_given from jsonb_array_elements(v_m -> 'topics') t;
  select coalesce(pg_catalog.array_agg(d.topic order by d.topic collate "C"), '{}') into v_expected
    from (select distinct e.topic from report.evaluation_source e) d;
  if v_given is distinct from v_expected then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-REC-154 the pack covers the topics %s, but the evaluation has the topics %s (DI-11)', v_given, v_expected);
  end if;
  -- Exactly the period's entries, each named by its topic, source log and row.
  select coalesce(pg_catalog.array_agg(x order by x collate "C"), '{}') into v_given
    from (select (t ->> 'topic') || '|' || (e ->> 'sourceLog') || '|' || (e ->> 'sourceRow') as x
            from jsonb_array_elements(v_m -> 'topics') t
            cross join lateral jsonb_array_elements(case when jsonb_typeof(t -> 'entries') = 'array' then t -> 'entries' else '[]'::jsonb end) e) g;
  select coalesce(pg_catalog.array_agg(x order by x collate "C"), '{}') into v_expected
    from (select p.topic || '|' || p.source_log || '|' || p.source_row as x from report.evaluation_period_rows_v1(v_from, v_to) p) g;
  if v_given is distinct from v_expected then
    select count(*) into v_missing from (select pg_catalog.unnest(v_expected) except all select pg_catalog.unnest(v_given)) m;
    select count(*) into v_extra from (select pg_catalog.unnest(v_given) except all select pg_catalog.unnest(v_expected)) m;
    raise exception using errcode = 'P0001', message = format(
      'EBMR-REC-155 the pack''s entries are not the source logs'' entries of the period: %s missing, %s not in the source logs or listed twice (DI-11)',
      v_missing, v_extra);
  end if;
  v_entries := cardinality(v_expected);
  -- Exactly the seeded readability sample of the records closed before the period's end, in rank order.
  select coalesce(pg_catalog.array_agg((r ->> 'rank') || '|' || (r ->> 'recordType') || ':' || (r ->> 'recordId') order by o), '{}') into v_given
    from jsonb_array_elements(v_m #> '{readability,records}') with ordinality a(r, o);
  if v_size < 1 or v_size > 1000 or btrim(v_seed) = '' or length(v_seed) > 200 then
    raise exception using errcode = 'P0001', message =
      'EBMR-REC-141 a readability sample names a seed (1 to 200 characters), the time its records closed before and a size of 1 to 1000 (DI-44)';
  end if;
  select coalesce(pg_catalog.array_agg(s.rank::text || '|' || s.record_type || ':' || s.record_id order by s.rank), '{}') into v_expected
    from report.readability_sample_rows_v1(v_seed, v_to, v_size) s;
  if v_given is distinct from v_expected
     or (v_m #>> '{readability,closedBefore}')::timestamptz is distinct from v_to then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-REC-156 the readability report lists %s records, not the %s records of the seeded sample of records closed before the period''s end (DI-44)',
      cardinality(v_given), cardinality(v_expected));
  end if;
  if exists (select 1 from jsonb_array_elements(v_m #> '{readability,records}') r
              where coalesce(r ->> 'result', '') not in ('READABLE', 'UNREADABLE')
                 or (r ->> 'result' = 'READABLE' and coalesce(r ->> 'renderSha256', '') !~ '^[0-9a-f]{64}$')) then
    raise exception using errcode = 'P0001', message =
      'EBMR-REC-157 every sampled record has its result, READABLE with its render SHA-256 or UNREADABLE (DI-44)';
  end if;
  select count(*) into v_unread from jsonb_array_elements(v_m #> '{readability,records}') r where r ->> 'result' = 'UNREADABLE';
  insert into records.evaluation_pack (pack_sha256, pack, period_from, period_to, entry_count, sample_count, unreadable_count,
                                       generated_by_person, generated_by_account)
  values (p_pack_sha256, p_pack, v_from, v_to, v_entries,
          jsonb_array_length(v_m #> '{readability,records}'), v_unread,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- Signed content of a pack (aggregate evaluation_pack, id the pack's id): its SHA-256, period and counts; the person who
-- generated it is its performer. STORED until it is signed off.
create function records.evaluation_pack_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, records, pg_temp as $$
declare
  v records.evaluation_pack%rowtype;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into v from records.evaluation_pack p where p.id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1,
    'content', jsonb_build_object('pack_sha256', v.pack_sha256,
                                  'period_from', pg_catalog.to_char(v.period_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                                  'period_to', pg_catalog.to_char(v.period_to at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                                  'entry_count', v.entry_count::text, 'sample_count', v.sample_count::text, 'unreadable_count', v.unreadable_count::text),
    'state', case when exists (select 1 from records.evaluation_pack_approval a where a.pack_id = v.id) then 'APPROVED' else 'STORED' end,
    'entered_by', jsonb_build_array(v.generated_by_person));
end
$$;
select esig.register_content_provider('evaluation_pack', 'records.evaluation_pack_content(text)',
  'Periodic evaluation pack of the system (DI-11): its SHA-256, period and counts');

create function records.approve_evaluation_pack(p_pack uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, records, iam, esig, kernel, pg_temp as $$
declare
  v_actor  jsonb;
  v_signer uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('VALIDATION.APPROVE_EVALUATION', '{}'::jsonb);
  perform 1 from records.evaluation_pack p where p.id = p_pack for key share;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-158 %s is no stored evaluation pack (DI-11)', coalesce(p_pack::text, 'NULL'));
  end if;
  if exists (select 1 from records.evaluation_pack_approval a where a.pack_id = p_pack) then
    raise exception using errcode = 'P0001', message = format('EBMR-REC-158 evaluation pack %s is already signed off (DI-11)', p_pack);
  end if;
  if p_signature is null then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-159 the sign-off of an evaluation pack is an e-signature (DI-11)';
  end if;
  v_signer := (esig.assert_signature(p_signature, 'PERIODIC_EVALUATION_APPROVED', 'evaluation_pack', p_pack::text) ->> 'signer_person')::uuid;
  if v_signer is distinct from (v_actor ->> 'person_id')::uuid then
    raise exception using errcode = 'P0001', message = 'EBMR-REC-159 the approver records their own signature of the evaluation pack (DI-11)';
  end if;
  insert into records.evaluation_pack_approval (pack_id, approved_signature, approved_by_person, approved_by_account)
  values (p_pack, p_signature, v_signer, (v_actor ->> 'account_id')::uuid);
end
$$;

select kernel.set_actor_context(null);

revoke all on function records.store_evaluation_pack(text, text), records.evaluation_pack_content(text), records.approve_evaluation_pack(uuid, uuid) from public;
grant execute on function records.store_evaluation_pack(text, text), records.evaluation_pack_content(text), records.approve_evaluation_pack(uuid, uuid) to ebmr_app;

reset role;
