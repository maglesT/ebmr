-- Phase 6A slice 6A-0: the analytics read views (ADR 0020 point 4; draft controls DI-51, DI-52, DI-53, PR-61;
-- interfaces slice-6A-0-interfaces.md section 2; D-6A-0-3).
--
-- Handbook: modules/analytics.md
--
-- The screens read only these views (SELECT to ebmr_app); the application role reads no analytics table. Every view
-- counts a run's outputs only after finish_run: outputs and flags of a FAILED or unended run are not shown.
--   analytics.output_v1            outputs of DONE runs with method, version, data_as_of and advisory = true. Outputs
--                                  about a PERSON or an ACCOUNT are not shown here (restricted; DI-53).
--   analytics.open_flag_v1         unrestricted flags of DONE runs that have no disposition yet.
--   analytics.review_priority_v1   per batch, the latest REVIEW_PRIORITY output with its score, reasons, method version and
--                                  scored_at (slice 6A-5 fills it; PR-61: nothing in a review, register or release
--                                  function reads it).
--   analytics.method_monitor_v1    per method version and site-zone month: runs, failures (a FAILED run, or one unended
--                                  an hour after it started; D-6A-0-3), flags, the dispositioned share and the false-alarm
--                                  rate (of the current dispositions).
--   analytics.input_catalog_v1     name, kind, version, owner slice and grain of every input the analytics role may read
--                                  (also SELECT to ebmr_analytics).
-- data_as_of of a run is the earliest data_as_of of its inputs (one snapshot in v1, D-6A-5). Statistics are double
-- precision here, in the analytics schema only (ADR 0020 point 5).

set local role ebmr_owner;

create view analytics.input_catalog_v1 as
  select i.name, i.kind, i.version, i.owner_slice, i.grain, i.description, i.registered_at
    from analytics.input_registry i;

create view analytics.output_v1 as
  select o.id as output_id, o.run as run_id, r.method, r.version, r.reference_set, o.subject_kind, o.subject_ref, o.kind,
         o."values", o.reasons, o.recorded_at,
         (select min((x ->> 'data_as_of')::timestamptz) from jsonb_array_elements(r.inputs) x) as data_as_of,
         e.ended_at as finished_at, true as advisory
    from analytics.output o
    join analytics.run r on r.id = o.run
    join analytics.run_end e on e.run = r.id and e.status = 'DONE'
   where o.subject_kind not in ('PERSON', 'ACCOUNT');

create view analytics.open_flag_v1 as
  select f.id as flag_id, f.run as run_id, f.output as output_id, r.method, r.version, f.subject_kind, f.subject_ref, f.rule,
         f.severity, f.reasons, f.raised_at,
         (select min((x ->> 'data_as_of')::timestamptz) from jsonb_array_elements(r.inputs) x) as data_as_of,
         e.ended_at as finished_at, true as advisory
    from analytics.flag f
    join analytics.run r on r.id = f.run
    join analytics.run_end e on e.run = r.id and e.status = 'DONE'
   where not f.restricted
     and not exists (select 1 from analytics.flag_disposition d where d.flag = f.id);

create view analytics.review_priority_v1 as
  select distinct on (o.subject_ref)
         o.subject_ref as batch_ref, o.id as output_id, o.run as run_id, r.method, r.version,
         case when jsonb_typeof(o."values" -> 'score') = 'number' then (o."values" ->> 'score')::double precision end as score,
         o.reasons, o.recorded_at as scored_at, e.ended_at as finished_at, true as advisory
    from analytics.output o
    join analytics.run r on r.id = o.run
    join analytics.run_end e on e.run = r.id and e.status = 'DONE'
   where o.kind = 'REVIEW_PRIORITY' and o.subject_kind = 'BATCH'
   order by o.subject_ref, o.recorded_at desc, o.id desc;

-- The monitor's rows (a definer row function, so the view's month is the site zone's, as the 6g report views do).
create function analytics.method_monitor_rows_v1()
returns table (method text, version integer, month date, runs integer, failures integer, flags integer,
               dispositioned_share double precision, false_alarm_rate double precision)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with z as (select coalesce(kernel.site_zone(), 'UTC') as zone),
  runs as (
    select r.id, r.method, r.version, (date_trunc('month', r.started_at at time zone (select zone from z)))::date as month, e.status,
           r.started_at
      from analytics.run r left join analytics.run_end e on e.run = r.id),
  flags as (
    select f.id, f.run,
           (select d.verdict from analytics.flag_disposition d
             where d.flag = f.id and not exists (select 1 from analytics.flag_disposition s where s.supersedes = d.id)) as verdict
      from analytics.flag f join analytics.run_end e on e.run = f.run and e.status = 'DONE')
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
revoke all on function analytics.method_monitor_rows_v1() from public;
grant execute on function analytics.method_monitor_rows_v1() to ebmr_app;

create view analytics.method_monitor_v1 as select * from analytics.method_monitor_rows_v1();

revoke all on analytics.input_catalog_v1, analytics.output_v1, analytics.open_flag_v1, analytics.review_priority_v1,
              analytics.method_monitor_v1 from public;
grant select on analytics.input_catalog_v1, analytics.output_v1, analytics.open_flag_v1, analytics.review_priority_v1,
                analytics.method_monitor_v1 to ebmr_app;
grant select on analytics.input_catalog_v1 to ebmr_analytics;

reset role;
