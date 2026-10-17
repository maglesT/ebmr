-- Phase 6A slice 6A-4: the audit-trail facts the audit-trail methods read (decision 0016 item 8; draft controls DI-53,
-- DI-51; interfaces slice-6A-0-interfaces.md section 3; D-6A-0-1, D-6A-0-8, D-6A-4-1, D-6A-4-2, D-6A-4-8).
--
-- Handbook: modules/analytics.md
--
-- Two views in the schema report, each selecting from its STABLE SECURITY DEFINER row function (as recipe-core 1070 and
-- 1115 build them), over the last 26 weeks (182 days). They are in recipe-core, not the kernel, because a batch
-- record's entries (their item, step, attempt, claimed time) live in the execution store (D-6A-0-1).
--
--   report.audit_fact_v1     one row per kernel audit event of a person (the nil person of the release and the system
--                            identities is left out) that is not about a batch record outside GMP production:
--                            event_id and chain_key (as the audit-trail screens name the entry), recorded_at and
--                            recorded_local (the site's wall clock, YYYY-MM-DDTHH:MI:SS), the person, account, role and
--                            terminal (device code), the action, the table, and whether it is a correction with its
--                            reason code. For an execution command (an insert into recipe.execution_command) also the
--                            command type and the data point it recorded or changed: its item (field), step instance,
--                            attempt, whether it failed, and the time it claims (occurredAt: a late entry's claimed time
--                            or a device's source time) as claimed_at; a correction is CORRECT_ENTRY, VOID_ATTEMPT or
--                            INVALIDATE_RESULT. For another update the field is the list of changed column names. Then
--                            the batch (from the command or from a batch chain), whether a deviation is linked to it, and
--                            the configuration area of the changed table (platform.config_area), if any.
--                            Old and new values are never exported, only which fields changed (DI-53; the entry carries
--                            no value, no payload body and no reason text).
--   report.manual_digit_v1   one row per value keyed by hand (source MANUAL, a DECIMAL or COUNT value) in a GMP batch
--                            record: the person, the audit entry of its command, the batch, step and item, when it was
--                            recorded, and only the last digit of the value as keyed (terminal_digit), the input of the
--                            terminal-digit test (D-6A-0-8, D-6A-4-8). The value itself is not exported.
--
-- Both are on the analytics role's allow-list only (kernel 1242 analytics.register_input). They describe persons, so
-- they are not in the report catalogue, and neither the reporting role, the dashboards' export nor the application role
-- reads them (D-6A-4-2). They write nothing and decide nothing; they do not read the analytics schema (DI-51).

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1150_analytics_audit_inputs)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the analytics input views of audit facts and manual-entry digits for the audit-trail methods (DI-53)'));

-- The audit event of each execution command row recorded since p_since: the insert into recipe.execution_command of
-- the same batch and correlation, paired in order when one correlation wrote several rows. With p_ids, only the
-- correlations of those audit events (the pairing is the same: it numbers whole correlations).
create function report.execution_command_events(p_since timestamptz, p_ids bigint[])
returns table (event_id bigint, batch_id uuid, seq bigint)
language sql stable set search_path = pg_catalog, pg_temp as $$
  with corr as (select distinct e.correlation_id from kernel.audit_event e where p_ids is not null and e.id = any (p_ids)),
  ae as (
    select e.id, e.record_id::uuid as batch_id, e.correlation_id,
           pg_catalog.row_number() over (partition by e.record_id, e.correlation_id order by e.id) as n
      from kernel.audit_event e
     where e.table_name = 'recipe.execution_command' and e.action = 'INSERT' and e.recorded_at >= p_since
       and e.record_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and (p_ids is null or e.correlation_id in (select correlation_id from corr))),
  cm as (
    select c.batch_id, c.seq, c.correlation_id,
           pg_catalog.row_number() over (partition by c.batch_id, c.correlation_id order by c.seq) as n
      from recipe.execution_command c
     where c.recorded_at >= p_since - interval '1 hour'
       and (p_ids is null or c.correlation_id in (select correlation_id from corr)))
  select ae.id, cm.batch_id, cm.seq
    from ae join cm on cm.batch_id = ae.batch_id and cm.correlation_id = ae.correlation_id and cm.n = ae.n
$$;
revoke all on function report.execution_command_events(timestamptz, bigint[]) from public;

-- The data points of the GMP batch records (all, or those of p_batches), with the command row that recorded them.
create function report.execution_points(p_batches uuid[])
returns table (batch_id uuid, point_id text, recorded_seq bigint, point jsonb)
language sql stable set search_path = pg_catalog, pg_temp as $$
  select s.batch_id, p.key, (p.value ->> 'recordedSeq')::bigint, p.value
    from recipe.execution_state s
    join recipe.batch_execution x on x.id = s.batch_id and x.installation = 'GMP' and x.purpose = 'GMP_BATCH'
    cross join lateral pg_catalog.jsonb_each(case when pg_catalog.jsonb_typeof(s.state -> 'points') = 'object' then s.state -> 'points' else '{}'::jsonb end) p
   where (p.value ->> 'recordedSeq') ~ '^[0-9]{1,18}$'
     and (p_batches is null or s.batch_id = any (p_batches))
$$;
revoke all on function report.execution_points(uuid[]) from public;

-- The audit facts of the audit events of persons recorded since p_since (all of them, or those of p_ids): see the
-- header. The view report.audit_fact_v1 gives those of the last 26 weeks; the data-integrity review's entry list
-- (recipe-core 1151) those a flag names.
create function report.audit_facts(p_since timestamptz, p_ids bigint[])
returns table (event_id text, chain_key text, recorded_at timestamptz, recorded_local text, claimed_at timestamptz, person_id uuid, account_id uuid,
               role text, terminal text, action text, command_type text, table_name text, field text, is_correction boolean, reason_code text,
               batch_id uuid, step text, attempt integer, failed boolean, deviation_linked boolean, config_area text)
language sql stable set search_path = pg_catalog, recipe, site, report, pg_temp as $$
  with z as (select coalesce(kernel.site_zone(), 'UTC') as zone),
  ev as (
    select e.id, e.chain_key, e.recorded_at, e.action, e.table_name, e.payload,
           (e.payload -> 'actor' ->> 'person_id') as person_text,
           case when e.chain_key ~ '^batch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then pg_catalog.substr(e.chain_key, 7)::uuid end as chain_batch
      from kernel.audit_event e
     where e.recorded_at >= p_since
       and (p_ids is null or e.id = any (p_ids))
       and e.action in ('INSERT', 'UPDATE', 'DELETE', 'BUSINESS')
       and (e.payload -> 'actor' ->> 'person_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and (e.payload -> 'actor' ->> 'person_id') <> '00000000-0000-0000-0000-000000000000'),
  ce as (select * from report.execution_command_events(p_since, p_ids)),
  pts as materialized (
    select * from report.execution_points(case when p_ids is null then null else (select pg_catalog.array_agg(distinct x.batch_id) from ce x) end)),
  by_seq as (select distinct on (p.batch_id, p.recorded_seq) p.batch_id, p.recorded_seq, p.point from pts p order by p.batch_id, p.recorded_seq, p.point_id),
  joined as (
    select ev.*, c.command_type, coalesce(c.batch_id, ev.chain_batch) as batch, coalesce(s.point, t.point) as point
      from ev
      left join ce on ce.event_id = ev.id
      left join recipe.execution_command c on c.batch_id = ce.batch_id and c.seq = ce.seq
      left join by_seq s on s.batch_id = c.batch_id and s.recorded_seq = c.seq
      left join pts t on t.batch_id = c.batch_id and t.point_id = c.command ->> 'point')
  select j.id::text, j.chain_key, j.recorded_at, pg_catalog.to_char(j.recorded_at at time zone (select zone from z), 'YYYY-MM-DD"T"HH24:MI:SS'),
         report.engine_instant(j.point -> 'occurredAt' -> 'us'),
         j.person_text::uuid,
         case when (j.payload -> 'actor' ->> 'account_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (j.payload -> 'actor' ->> 'account_id')::uuid end,
         j.payload -> 'actor' ->> 'role_code',
         (select d.code from iam.device d where d.id::text = j.payload -> 'actor' ->> 'device_id'),
         j.action, j.command_type, j.table_name,
         case when j.command_type is not null then j.point ->> 'item'
              when j.action = 'UPDATE' and pg_catalog.jsonb_typeof(j.payload -> 'body' -> 'new') = 'object'
                then (select pg_catalog.string_agg(k, ', ' order by k) from pg_catalog.jsonb_object_keys(j.payload -> 'body' -> 'new') k) end,
         case when j.command_type is not null then j.command_type in ('CORRECT_ENTRY', 'VOID_ATTEMPT', 'INVALIDATE_RESULT') else j.action in ('UPDATE', 'DELETE') end,
         j.payload ->> 'reason_code',
         j.batch,
         j.point ->> 'stepKey',
         case when j.point ->> 'attempt' ~ '^[0-9]{1,9}$' then (j.point ->> 'attempt')::integer end,
         case when j.point ->> 'kind' = 'VALUE' and pg_catalog.jsonb_typeof(j.point -> 'failed') = 'boolean' then (j.point ->> 'failed')::boolean end,
         j.batch is not null and exists (select 1 from site.deviation_link l where l.batch_id = j.batch),
         (select a.code from platform.config_area a where a.table_name::text = j.table_name)
    from joined j
   where j.batch is null
      or exists (select 1 from recipe.batch_execution x where x.id = j.batch and x.installation = 'GMP' and x.purpose = 'GMP_BATCH')
$$;
revoke all on function report.audit_facts(timestamptz, bigint[]) from public;

create function report.audit_fact_rows_v1()
returns table (event_id text, chain_key text, recorded_at timestamptz, recorded_local text, claimed_at timestamptz, person_id uuid, account_id uuid,
               role text, terminal text, action text, command_type text, table_name text, field text, is_correction boolean, reason_code text,
               batch_id uuid, step text, attempt integer, failed boolean, deviation_linked boolean, config_area text,
               read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, report, pg_temp as $$
  select f.*, pg_catalog.statement_timestamp(), report.data_as_of()
    from report.audit_facts(pg_catalog.statement_timestamp() - interval '182 days', null) f
   order by f.recorded_at, f.event_id::bigint
$$;
revoke all on function report.audit_fact_rows_v1() from public;

create function report.manual_digit_rows_v1()
returns table (event_id text, chain_key text, person_id uuid, batch_id uuid, step text, item text, recorded_at timestamptz, recorded_local text,
               terminal_digit integer, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, report, pg_temp as $$
  with z as (select coalesce(kernel.site_zone(), 'UTC') as zone, pg_catalog.statement_timestamp() - interval '182 days' as since),
  m as (
    select p.batch_id, p.recorded_seq, p.point, p.point -> 'value' ->> 'value' as text, report.engine_instant(p.point -> 'recordedAt') as at
      from report.execution_points(null) p
     where p.point -> 'source' ->> 'mode' = 'MANUAL' and p.point -> 'value' ->> 'kind' in ('DECIMAL', 'COUNT')
       and (p.point -> 'value' ->> 'value') ~ '^-?[0-9]+(\.[0-9]+)?$')
  select ce.event_id::text, 'batch:' || m.batch_id::text, c.actor_person, m.batch_id, m.point ->> 'stepKey', m.point ->> 'item', m.at,
         pg_catalog.to_char(m.at at time zone (select zone from z), 'YYYY-MM-DD"T"HH24:MI:SS'),
         pg_catalog.ascii(pg_catalog.right(m.text, 1)) - 48,
         pg_catalog.statement_timestamp(), report.data_as_of()
    from m
    join recipe.execution_command c on c.batch_id = m.batch_id and c.seq = m.recorded_seq
    join report.execution_command_events((select since from z), null) ce on ce.batch_id = c.batch_id and ce.seq = c.seq
   where m.at >= (select since from z)
     and c.actor_person <> '00000000-0000-0000-0000-000000000000'
   order by m.at, ce.event_id
$$;
revoke all on function report.manual_digit_rows_v1() from public;

create view report.audit_fact_v1 as select * from report.audit_fact_rows_v1();
create view report.manual_digit_v1 as select * from report.manual_digit_rows_v1();
revoke all on report.audit_fact_v1, report.manual_digit_v1 from public;

-- The analytics role's allow-list (kernel 1242): SELECT on each view and EXECUTE on the row function behind it.
select analytics.register_input('VIEW', 'report.audit_fact_v1', 1, '6A-4', 'audit event of a person (26 weeks)',
  'Who did what, where and when in the audit trail, corrections and reason codes, a data entry''s item, step, attempt, failure and claimed time; no old or new values');
select analytics.register_input('VIEW', 'report.manual_digit_v1', 1, '6A-4', 'manual entry (26 weeks)',
  'The person, audit entry, batch, step and item of each value keyed by hand, and only the last digit of the value');

select kernel.set_actor_context(null);

reset role;
