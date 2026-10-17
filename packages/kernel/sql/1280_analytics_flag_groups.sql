-- Phase 6A exit (slice 6A-7, review finding P6A7-1): one flag-grouping design (ADR 0020 point 4; draft controls
-- DI-52, DI-53; D-6A-4-5, D-6A-3-9, D-6A-7-R1).
--
-- Handbook: modules/analytics.md
--
-- Why. Each run assesses its whole input again, so a hit is raised again by every run until QA dispositions it. Two
-- slices grouped the raises in two ways: 6A-4 by key (kernel 1261: method, rule, subject and the first evidence of the
-- first reason; the audit-trail methods, whose reasons drift as the window moves) and 6A-3 by signal (kernel 1271:
-- method, version, subject, rule, severity and the whole reasons). Both said "a disposition on any raise closes the
-- group", but the disposition rules stayed per flag (kernel 1242): a later raise of a dispositioned group took a fresh
-- first disposition, so the group's verdict could be replaced without superseding it and without a reason (DI-52); the
-- flags list of a period, the flag detail and the restricted dispositions showed a later raise as undispositioned; and
-- the monitor grouped the audit-trail flags by signal, so a key's verdict did not count for its drifting raises.
--
-- One design, used by every reader and by the writer:
--   analytics.flag_group(method, version, subject_kind, subject_ref, rule, severity, reasons)   a flag's group (pure):
--                                6A-4's key (analytics.flag_key) for the audit-trail methods (ATA.*), 6A-3's signal for
--                                every other method (the reasons by their MD5, so the group is a short text).
--   analytics.flag_grouped       (owner only) every flag of a DONE run with its run's method, version, inputs, end and
--                                group.
--   analytics.flag_group_current (owner only) each group's current disposition: the latest disposition of any raise of
--                                the group that nothing supersedes.
--   analytics.record_disposition replaced: the group is the unit. A first disposition only when the group has none; a
--                                later one, on any raise of the group, supersedes the group's current one with a reason
--                                (EBMR-ANA-008, as before). Concurrent verdicts on one group are serialised by a
--                                transaction lock on the group. The rest is as kernel 1242 (administrators refused first,
--                                ANALYTICS.DISPOSITION, ANALYTICS.DI_REVIEW for a restricted flag).
--   analytics.open_flag_v1       replaced: one row per open group (no disposition on any raise), its latest raise, with
--                                raised_count and first_raised_at (same columns as kernel 1271).
--   analytics.flag_v1            replaced: every unrestricted raise, current_disposition its group's (same columns).
--   analytics.flag_group_disposition_v1   new (SELECT to ebmr_app): for each unrestricted raise of a DONE run, every
--                                disposition of its group (on whichever raise it was recorded: disposition_flag),
--                                marked current when nothing supersedes it. The screens read a flag's dispositions here.
--   analytics.person_flag_dispositions(flag)  replaced: the dispositions of the restricted flag's group (ANALYTICS.DI_REVIEW,
--                                administrators refused first; EBMR-ANA-007 as kernel 1245).
--   analytics.method_monitor_rows_v1  replaced: a raise counts with its group's current verdict.
-- analytics.audit_flags (kernel 1261) is unchanged: its key is the audit-trail methods' group. Restricted flags stay out
-- of every view the application role reads (DI-53). Dispositions recorded before this migration keep their rows; where
-- a group already has two current ones, the latest is the group's current verdict, as both earlier designs read it.
-- Nothing here writes GMP data; nothing outside the analytics schema reads these objects (DI-51).

set local role ebmr_owner;

create function analytics.flag_group(p_method text, p_version integer, p_subject_kind text, p_subject_ref text, p_rule text, p_severity text, p_reasons jsonb)
returns text
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select case when p_method like 'ATA.%' then analytics.flag_key(p_method, p_rule, p_subject_kind, p_subject_ref, p_reasons)
              else p_method || '|' || p_version::text || '|' || p_subject_kind || '|' || p_subject_ref || '|' || p_rule || '|' || p_severity || '|'
                   || pg_catalog.md5(p_reasons::text) end
$$;
revoke all on function analytics.flag_group(text, integer, text, text, text, text, jsonb) from public;
-- PostgreSQL checks a function called inside a view with the reader's own right: the application role reads the views
-- below, so it executes these two pure functions (they read nothing).
grant execute on function analytics.flag_group(text, integer, text, text, text, text, jsonb) to ebmr_app;
grant execute on function analytics.flag_key(text, text, text, text, jsonb) to ebmr_app;

create view analytics.flag_grouped as
  select f.id, f.run, f.output, f.subject_kind, f.subject_ref, f.rule, f.severity, f.reasons, f.restricted, f.raised_at,
         r.method, r.version, r.inputs, e.ended_at,
         analytics.flag_group(r.method, r.version, f.subject_kind, f.subject_ref, f.rule, f.severity, f.reasons) as flag_group
    from analytics.flag f
    join analytics.run r on r.id = f.run
    join analytics.run_end e on e.run = f.run and e.status = 'DONE';
revoke all on analytics.flag_grouped from public;

create view analytics.flag_group_current as
  select distinct on (g.flag_group) g.flag_group, g.restricted, d.id as disposition_id, d.flag as disposition_flag, d.verdict, d.recorded_at
    from analytics.flag_grouped g
    join analytics.flag_disposition d on d.flag = g.id
   where not exists (select 1 from analytics.flag_disposition s where s.supersedes = d.id)
   order by g.flag_group, d.recorded_at desc, d.id desc;
revoke all on analytics.flag_group_current from public;

create or replace function analytics.record_disposition(p_flag uuid, p_verdict text, p_cause text, p_deviation_ref text, p_supersedes uuid, p_reason text)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_actor   jsonb;
  f         analytics.flag;
  v_group   text;
  v_current uuid;
  v_id      uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('ANALYTICS.DISPOSITION', '{}'::jsonb);
  select * into f from analytics.flag g where g.id = p_flag for update;
  if f.id is null or not exists (select 1 from analytics.run_end e where e.run = f.run and e.status = 'DONE') then
    raise exception using errcode = 'P0001', message = format('EBMR-ANA-009 flag %s is not a flag of a completed run (DI-52)', coalesce(p_flag::text, 'NULL'));
  end if;
  if f.restricted then
    -- ANALYTICS.DI_REVIEW, refused as EBMR-ANA-007 (the guard's own refusal is EBMR-IAM-040).
    begin
      perform iam.require_permission('ANALYTICS.DI_REVIEW', '{}'::jsonb);
    exception when raise_exception then
      if sqlerrm like 'EBMR-IAM-040%' then
        raise exception using errcode = 'P0001', message = format(
          'EBMR-ANA-007 flag %s is about a %s: it is restricted to data-integrity review and needs ANALYTICS.DI_REVIEW (DI-53)', f.id, lower(f.subject_kind));
      end if;
      raise;
    end;
  end if;
  if coalesce(p_verdict, '') not in ('TRUE_SIGNAL', 'FALSE_ALARM', 'NOT_ASSESSABLE') or char_length(pg_catalog.btrim(coalesce(p_cause, ''))) < 10
     or (p_deviation_ref is not null and pg_catalog.btrim(p_deviation_ref) = '') then
    raise exception using errcode = 'P0001', message =
      'EBMR-ANA-009 a disposition is TRUE_SIGNAL, FALSE_ALARM or NOT_ASSESSABLE, with a cause of at least 10 characters and an optional deviation reference (DI-52)';
  end if;
  -- 1280: the flag's group is the unit of the verdict; one verdict at a time per group.
  select analytics.flag_group(r.method, r.version, f.subject_kind, f.subject_ref, f.rule, f.severity, f.reasons) into v_group
    from analytics.run r where r.id = f.run;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('analytics.flag_group:' || v_group, 0));
  select c.disposition_id into v_current from analytics.flag_group_current c where c.flag_group = v_group;
  if v_current is null and p_supersedes is not null then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-008 flag %s has no disposition yet: disposition %s cannot be superseded here (a disposition supersedes only the current one of the same flag or of a raise of the same hit; DI-52)', f.id, p_supersedes);
  end if;
  if v_current is not null and p_supersedes is distinct from v_current then
    raise exception using errcode = 'P0001', message = format(
      'EBMR-ANA-008 flag %s is dispositioned (%s, on this hit or an earlier raise of it): a later disposition supersedes that current one, with a reason (DI-52)', f.id, v_current);
  end if;
  if p_supersedes is not null and coalesce(pg_catalog.btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = format('EBMR-ANA-008 superseding disposition %s needs a reason (DI-52)', p_supersedes);
  end if;
  insert into analytics.flag_disposition (flag, verdict, cause, deviation_ref, supersedes, reason, person_id, account_id)
  values (f.id, p_verdict, p_cause, p_deviation_ref, p_supersedes, case when p_supersedes is not null then p_reason end,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create or replace view analytics.open_flag_v1 as
  with g as (
    select x.*,
           count(*) over w as raised_count,
           min(x.raised_at) over w as first_raised_at,
           row_number() over (partition by x.flag_group order by x.raised_at desc, x.id desc) as latest
      from analytics.flag_grouped x
     where not x.restricted
    window w as (partition by x.flag_group))
  select g.id as flag_id, g.run as run_id, g.output as output_id, g.method, g.version, g.subject_kind, g.subject_ref, g.rule,
         g.severity, g.reasons, g.raised_at,
         (select min((i ->> 'data_as_of')::timestamptz) from jsonb_array_elements(g.inputs) i) as data_as_of,
         g.ended_at as finished_at, true as advisory,
         g.raised_count::integer as raised_count, g.first_raised_at
    from g
    left join analytics.flag_group_current c on c.flag_group = g.flag_group
   where g.latest = 1 and c.flag_group is null;

create or replace view analytics.flag_v1 as
  select g.id as flag_id, g.run as run_id, g.output as output_id, g.method, g.version, g.subject_kind, g.subject_ref, g.rule, g.severity, g.reasons,
         g.raised_at,
         (select min((i ->> 'data_as_of')::timestamptz) from jsonb_array_elements(g.inputs) i) as data_as_of,
         g.ended_at as finished_at,
         c.disposition_id as current_disposition,
         true as advisory
    from analytics.flag_grouped g
    left join analytics.flag_group_current c on c.flag_group = g.flag_group
   where not g.restricted;

create view analytics.flag_group_disposition_v1 as
  select g.id as flag_id, d.id as disposition_id, d.flag as disposition_flag, d.verdict, d.cause, d.deviation_ref, d.supersedes, d.reason,
         d.person_id, d.account_id, d.recorded_at,
         not exists (select 1 from analytics.flag_disposition s where s.supersedes = d.id) as current
    from analytics.flag_grouped g
    join analytics.flag_grouped h on h.flag_group = g.flag_group
    join analytics.flag_disposition d on d.flag = h.id
   where not g.restricted;
revoke all on analytics.flag_group_disposition_v1 from public;
grant select on analytics.flag_group_disposition_v1 to ebmr_app;

create or replace function analytics.person_flag_dispositions(p_flag uuid) returns setof analytics.flag_disposition
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  begin
    perform iam.require_permission('ANALYTICS.DI_REVIEW', '{}'::jsonb);
  exception when raise_exception then
    if sqlerrm like 'EBMR-IAM-040%' then
      raise exception using errcode = 'P0001', message =
        'EBMR-ANA-007 flags about a person or an account are restricted to data-integrity review: they need ANALYTICS.DI_REVIEW (DI-53)';
    end if;
    raise;
  end;
  -- 1280: the dispositions of the flag's group (the same hit raised by other runs), not only of this raise.
  return query
    select d.* from analytics.flag_grouped g
      join analytics.flag_grouped h on h.flag_group = g.flag_group and h.restricted
      join analytics.flag_disposition d on d.flag = h.id
     where g.id = p_flag and g.restricted
     order by d.recorded_at, d.id;
end
$$;

create or replace function analytics.method_monitor_rows_v1()
returns table (method text, version integer, month date, runs integer, failures integer, flags integer,
               dispositioned_share double precision, false_alarm_rate double precision)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with z as (select coalesce(kernel.site_zone(), 'UTC') as zone),
  runs as (
    select r.id, r.method, r.version, (date_trunc('month', r.started_at at time zone (select zone from z)))::date as month, e.status,
           r.started_at
      from analytics.run r left join analytics.run_end e on e.run = r.id),
  -- 1280: each raise with its group's current verdict (the audit-trail methods' key, the other methods' signal).
  flags as (
    select g.id, g.run, c.verdict
      from analytics.flag_grouped g
      left join analytics.flag_group_current c on c.flag_group = g.flag_group)
  select u.method, u.version, u.month,
         count(distinct u.id)::integer,
         count(distinct u.id) filter (where u.status = 'FAILED'
                                         or (u.status is null and u.started_at < statement_timestamp() - interval '1 hour'))::integer,
         count(g.id)::integer,
         case when count(g.id) > 0 then (count(g.verdict)::double precision / count(g.id)) end,
         case when count(g.verdict) > 0 then (count(g.id) filter (where g.verdict = 'FALSE_ALARM'))::double precision / count(g.verdict) end
    from runs u left join flags g on g.run = u.id
   group by u.method, u.version, u.month
   order by u.method, u.version, u.month
$$;

reset role;
