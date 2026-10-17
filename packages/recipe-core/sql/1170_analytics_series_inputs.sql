-- Phase 6A slice 6A-6: the golden batch profile's inputs (ADR 0020 point 3; draft controls DI-51, DI-52; DI-32;
-- interfaces slice-6A-0-interfaces.md section 3; D-6A-16, D-6A-6-1, D-6A-6-2, D-6A-6-7).
--
-- Handbook: modules/analytics.md
--
-- Read-only inputs in the schema report, built as the 6A-1 input views are (recipe-core 1115): SQL, STABLE, SECURITY
-- DEFINER row functions owned by ebmr_owner, so a reader needs no right on the plant, recipe or site tables behind them.
-- Each row carries read_at (the statement time) and data_as_of (report.data_as_of()). The samples stay the native
-- series of slice 6b exactly as received (plant.series; DI-32): source time, raw text, the shown decimal and the status
-- code. Connected equipment only: a step without a series has no row, so it has no profile.
--
--   report.series_ref_v1               one row per GMP batch record, step bound to a unit (plant.step_equipment) and
--                                      series tag that unit sent during the step's binding window (the window of
--                                      plant.series_in_context, recipe-core 0960): batch number, product and family,
--                                      completion and release, the step, the unit's code and class (equipment_type, as
--                                      report.step_use_v1 names it), the tag and unit, the window (window_to null and
--                                      ended false while it is open), the chunk ids in the window, the deviations
--                                      linked to the batch and the alarms bound to the batch on that step or on no
--                                      step (D-6A-6-2).
--   report.series_samples_v1(batch, step, tag)
--                                      the samples of that window, oldest first: source time (epoch microseconds and as
--                                      an instant), the raw text, the shown decimal (null when BAD or not a number), the
--                                      status code and its quality GOOD, UNCERTAIN or BAD (the two severity bits, as
--                                      integration-sdk qualityOfStatus), the chunk; GMP batch records only.
--   report.analytics_reference_v1      the analytics reference sets EFFECTIVE now, as the configuration store holds them
--                                      (platform.config_version, area ANALYTICS_REFERENCE; kernel 1195, 1241): set id,
--                                      method, scope, batches, model candidate, model and its SHA-256, valid from, the
--                                      change record. The runner reads a profile's reference model here: the analytics
--                                      role may not execute the owner-only reader of kernel 1242, and slice 6A-6 has no
--                                      kernel range (D-6A-6-7). It reads the configuration store, not the analytics
--                                      schema, so the dependency proof of DI-51 stays as it is.
--
-- Both views are in the report catalogue with SELECT to the reporting and application roles (D-6A-1-5; every report
-- view is catalogued) and on the analytics role's allow-list; the samples function is EXECUTE to the analytics role
-- (its allow-list) and the application role (the profile overlay shows the raw values the profile read, DI-32).
-- Nothing here writes, and nothing changes plant.series or a record's dynamic data references (DI-51).

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1170_analytics_series_inputs)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the golden batch profile inputs: series references, native samples, effective reference sets (DI-51, DI-52, DI-32)'));

-- The binding windows of the GMP batch records' steps on their units, as plant.series_in_context computes them: from
-- the step's binding (or the use's start) to the use's end or the next binding of the same use.
create function report.step_windows_v1()
returns table (batch_id uuid, step text, equipment_id uuid, w_from timestamptz, w_to timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
  select x.id, sb.step, u.equipment_id, coalesce(sb.bound_at, u.started_at),
         least(coalesce(u.ended_at, 'infinity'::timestamptz),
               coalesce((select min(n.bound_at) from plant.step_equipment n where n.use_id = u.id and n.bound_at > sb.bound_at), 'infinity'::timestamptz))
    from recipe.batch_execution x
    join plant.step_equipment sb on sb.batch_id = x.id
    join plant.equipment_use_status u on u.id = sb.use_id and u.batch_id = x.id
   where x.installation = 'GMP' and x.purpose = 'GMP_BATCH'
$$;
revoke all on function report.step_windows_v1() from public;

create function report.series_ref_rows_v1()
returns table (batch_id uuid, batch_number text, product_code text, family_code text, completed_at timestamptz, released boolean, step text,
               equipment_code text, equipment_type text, tag text, unit text, window_from timestamptz, window_to timestamptz, ended boolean,
               chunk_ids uuid[], deviations integer, alarms integer, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, site, plant, platform, report, pg_temp as $$
  select w.batch_id, f.batch_number, f.product_code, f.family_code, f.completed_at, f.released, w.step, e.code, e.class_code, c.tag, c.unit,
         w.w_from, case when w.w_to = 'infinity'::timestamptz then null else w.w_to end, w.w_to <> 'infinity'::timestamptz, c.chunk_ids,
         (select count(distinct l.deviation_id)::integer from site.deviation_link l where l.batch_id = w.batch_id),
         (select count(distinct ab.alarm_id)::integer from plant.alarm_batch ab where ab.batch_id = w.batch_id and (ab.step is null or ab.step = w.step)),
         pg_catalog.statement_timestamp(), report.data_as_of()
    from report.step_windows_v1() w
    join report.batch_fact_rows_v1() f on f.batch_id = w.batch_id
    join plant.equipment e on e.id = w.equipment_id
    cross join lateral (
      select x.tag, x.unit, array_agg(x.id order by x.from_us, x.chunk_no) as chunk_ids
        from plant.series x
       where x.equipment_id = w.equipment_id
         and platform.epoch_us_to_timestamptz(x.to_us::text) >= w.w_from and platform.epoch_us_to_timestamptz(x.from_us::text) < w.w_to
       group by x.tag, x.unit) c
   order by f.batch_number, w.step, e.code, c.tag, c.unit
$$;

-- The samples of one GMP batch's step and tag inside the step's binding windows, oldest first.
create function report.series_samples_v1(p_batch uuid, p_step text, p_tag text)
returns table (source_us text, source_time timestamptz, raw_text text, value_text text, status_code text, status text, chunk_id uuid, chunk_no bigint,
               read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, plant, platform, report, pg_temp as $$
  select s.v ->> 'sourceTime', platform.epoch_us_to_timestamptz(s.v ->> 'sourceTime'), s.v ->> 'raw', s.v ->> 'value', s.v ->> 'status',
         case when pg_catalog.substr(s.v ->> 'status', 3, 1) in ('0', '1', '2', '3') then 'GOOD'
              when pg_catalog.substr(s.v ->> 'status', 3, 1) in ('4', '5', '6', '7') then 'UNCERTAIN'
              else 'BAD' end,
         x.id, x.chunk_no, pg_catalog.statement_timestamp(), report.data_as_of()
    from report.step_windows_v1() w
    join plant.series x on x.equipment_id = w.equipment_id and x.tag = p_tag
    cross join lateral pg_catalog.jsonb_array_elements(x.samples) s(v)
   where w.batch_id = p_batch and w.step = p_step
     and platform.epoch_us_to_timestamptz(x.to_us::text) >= w.w_from and platform.epoch_us_to_timestamptz(x.from_us::text) < w.w_to
     and platform.epoch_us_to_timestamptz(s.v ->> 'sourceTime') >= w.w_from and platform.epoch_us_to_timestamptz(s.v ->> 'sourceTime') < w.w_to
   order by (s.v ->> 'sourceTime')::bigint, x.chunk_no
$$;

-- The reference sets EFFECTIVE at statement time, from the configuration store (D-6A-6-7).
create function report.analytics_reference_rows_v1()
returns table (reference_set_id uuid, method text, scope jsonb, batch_ids uuid[], candidate_output uuid, model jsonb, model_sha256 text,
               valid_from timestamptz, change_record text, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, platform, report, pg_temp as $$
  select (v.source_row ->> 'id')::uuid, v.source_row ->> 'method', v.source_row -> 'scope',
         array(select b::uuid from pg_catalog.jsonb_array_elements_text(v.source_row -> 'batch_ids') b order by b::uuid),
         (v.source_row ->> 'candidate_output')::uuid, v.source_row -> 'model', v.source_row ->> 'model_sha256', c.valid_from, c.change_record,
         pg_catalog.statement_timestamp(), report.data_as_of()
    from platform.config_as_of(pg_catalog.statement_timestamp()) c
    join platform.config_version v on v.id = c.version_id
   where c.area = 'ANALYTICS_REFERENCE' and v.source_row ->> 'status' = 'EFFECTIVE'
   order by c.valid_from, 1
$$;

revoke all on function report.series_ref_rows_v1(), report.series_samples_v1(uuid, text, text), report.analytics_reference_rows_v1() from public;

create view report.series_ref_v1 as select * from report.series_ref_rows_v1();
create view report.analytics_reference_v1 as select * from report.analytics_reference_rows_v1();
revoke all on report.series_ref_v1, report.analytics_reference_v1 from public;
grant execute on function report.series_ref_rows_v1(), report.analytics_reference_rows_v1() to ebmr_app, ebmr_report;
grant select on report.series_ref_v1, report.analytics_reference_v1 to ebmr_app, ebmr_report;
grant execute on function report.series_samples_v1(uuid, text, text) to ebmr_app;
insert into report.view_registry (view_name, version, grain, description) values
  ('series_ref_v1', 1, 'batch, step, unit and series tag',
   'The native equipment series of each GMP batch step on its unit: product and family, completion and release, unit and class, tag and unit, binding window, chunk ids, linked deviations and step alarms (analytics input)'),
  ('analytics_reference_v1', 1, 'analytics reference set in force',
   'The advisory analytics reference sets in force, from the configuration store: method, scope, reference batches, model candidate, model and its SHA-256, change record (analytics input)');

-- The analytics role's allow-list (kernel 1242): SELECT on each view with EXECUTE on its row function, EXECUTE on the
-- samples function.
select analytics.register_input('VIEW', 'report.series_ref_v1', 1, '6A-6', 'batch, step, unit and series tag',
  'The equipment series of each GMP batch step on its unit, with the chunks in the binding window, release, linked deviations and step alarms');
select analytics.register_input('FUNCTION', 'report.series_samples_v1(uuid,text,text)', 1, '6A-6', 'native sample',
  'The native samples of a batch step and tag inside its binding window: source time, raw text, shown decimal, status code and quality');
select analytics.register_input('VIEW', 'report.analytics_reference_v1', 1, '6A-6', 'reference set in force',
  'The analytics reference sets EFFECTIVE now, from the configuration store: method, scope, batches, model candidate, model and its SHA-256');

select kernel.set_actor_context(null);

reset role;
