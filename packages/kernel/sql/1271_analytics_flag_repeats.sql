-- Phase 6A slice 6A-3: a flag raised again by a later run is shown once while it is open (ADR 0020 point 4; draft
-- controls DI-52, DI-53; PR-52; lead item of slice 6A-3, D-6A-3-9).
--
-- Handbook: modules/analytics.md
--
-- Each run assesses its whole input again, so a nightly run raises an open rule hit again until QA dispositions it,
-- and analytics.open_flag_v1 (kernel 1243) listed every raise. The runs keep recording every flag (the audit trail and
-- each run's output hash stay whole; analytics.flag_v1 still lists every raise). The views group the raises instead:
--   A flag's signal is its method, version, subject (kind and reference), rule, severity and reasons, its evidence
--   included. Raises with the same signal are repeats of one hit; a raise whose reasons differ in anything (another
--   batch in the hit, another value) is another signal and is shown on its own, never folded into an earlier one.
--   analytics.open_flag_v1      replaced: one row per open signal, the latest raise of it, with raised_count (its
--                               raises) and first_raised_at added at the end. A signal is open while no raise of it has
--                               a disposition: QA's disposition on any raise covers the same hit raised again later.
--   analytics.method_monitor_rows_v1  replaced: a raise counts as dispositioned, with that verdict, when its signal has a
--                               current disposition (the latest one recorded), so repeats do not dilute the
--                               dispositioned share or the false-alarm rate.
-- Restricted flags (about a person or an account, DI-53) stay out of open_flag_v1 as before.

set local role ebmr_owner;

create or replace view analytics.open_flag_v1 as
  with raised as (
    select f.id, f.run, f.output, r.method, r.version, f.subject_kind, f.subject_ref, f.rule, f.severity, f.reasons, f.raised_at, r.inputs, e.ended_at,
           exists (select 1 from analytics.flag_disposition d where d.flag = f.id) as dispositioned
      from analytics.flag f
      join analytics.run r on r.id = f.run
      join analytics.run_end e on e.run = r.id and e.status = 'DONE'
     where not f.restricted),
  signal as (
    select x.*,
           count(*) over w as raised_count,
           min(x.raised_at) over w as first_raised_at,
           bool_or(x.dispositioned) over w as covered,
           row_number() over (partition by x.method, x.version, x.subject_kind, x.subject_ref, x.rule, x.severity, x.reasons
                              order by x.raised_at desc, x.id desc) as latest
      from raised x
    window w as (partition by x.method, x.version, x.subject_kind, x.subject_ref, x.rule, x.severity, x.reasons))
  select s.id as flag_id, s.run as run_id, s.output as output_id, s.method, s.version, s.subject_kind, s.subject_ref, s.rule,
         s.severity, s.reasons, s.raised_at,
         (select min((x ->> 'data_as_of')::timestamptz) from jsonb_array_elements(s.inputs) x) as data_as_of,
         s.ended_at as finished_at, true as advisory,
         s.raised_count::integer as raised_count, s.first_raised_at
    from signal s
   where s.latest = 1 and not s.covered;

create or replace function analytics.method_monitor_rows_v1()
returns table (method text, version integer, month date, runs integer, failures integer, flags integer,
               dispositioned_share double precision, false_alarm_rate double precision)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with z as (select coalesce(kernel.site_zone(), 'UTC') as zone),
  runs as (
    select r.id, r.method, r.version, (date_trunc('month', r.started_at at time zone (select zone from z)))::date as month, e.status,
           r.started_at
      from analytics.run r left join analytics.run_end e on e.run = r.id),
  done as (
    select f.id, f.run, r.method, r.version, f.subject_kind, f.subject_ref, f.rule, f.severity, f.reasons, f.restricted
      from analytics.flag f join analytics.run r on r.id = f.run join analytics.run_end e on e.run = f.run and e.status = 'DONE'),
  -- The signal's verdict: the latest current disposition of any raise of it.
  verdicts as (
    select distinct on (g.method, g.version, g.subject_kind, g.subject_ref, g.rule, g.severity, g.reasons, g.restricted)
           g.method, g.version, g.subject_kind, g.subject_ref, g.rule, g.severity, g.reasons, g.restricted, d.verdict
      from done g
      join analytics.flag_disposition d on d.flag = g.id
     where not exists (select 1 from analytics.flag_disposition s where s.supersedes = d.id)
     order by g.method, g.version, g.subject_kind, g.subject_ref, g.rule, g.severity, g.reasons, g.restricted, d.recorded_at desc, d.id desc),
  flags as (
    select f.id, f.run, v.verdict
      from done f
      left join verdicts v on v.method = f.method and v.version = f.version and v.subject_kind = f.subject_kind and v.subject_ref = f.subject_ref
                          and v.rule = f.rule and v.severity = f.severity and v.reasons = f.reasons and v.restricted = f.restricted)
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
