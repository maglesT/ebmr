-- Slice S16 (second part): four report views of what an investigation of a batch event needs and the existing report
-- views do not give, for the external Deviations and CAPA system that reads as the reporting role (ADR 0022, D-S16-1,
-- D-S16-2, D-S16-6; tablets 1800, kernel 1210, recipe-core 1070 and 1115).
-- Handbook: modules/tablets-server.md
--
-- Why. Checked on the hosted demo's failing batch: cpp_value_v1 gives only the critical MBR parameters and calculations,
-- so the block entries of the in-process checks (TB-11 to TB-13) and the process values collected from equipment
-- (ACTUAL entries of G-06 and the Tablets process blocks) are not in it; step_use_v1 takes a step's unit from
-- plant.step_equipment, which only a gateway binding or a person's explicit binding fills, so most steps show no unit;
-- exception_v1 has no step, text or disposition. These views read the record as the engine stored it (the execution
-- state, its master content, the exception register and the plant's use records), and evaluate nothing themselves:
-- every result and limit flag is the one Batchwright stored with the entry.
--
--   report.equipment_use_v1       one row per use of a unit by a batch record and step that names it: plant.equipment_use
--                                 (with its end) and plant.instrument_use (an instrument use has no recorded end: ended_at
--                                 null); the steps are the step keys bound to the use (plant.step_equipment) and those whose
--                                 EQUIPMENT_USE entry names it; a use no step names gives one row with step null
--   report.ipc_result_v1          one row per value of an in-process check entry: PHYSICAL_CHECK (each tablet's thickness,
--                                 diameter and breaking force, then the mean of each, then the appearance), WEIGHT_CHECK
--                                 (each weight, then the group total or the mean), and one row for any other test entry
--                                 (friability, disintegration, ...) with its stored result. Limits are the step's
--                                 configuration in the record's master (individual or mean, action and alert); breaking
--                                 force read in kp is given in N (1 kp = 9.80665 N exactly), as the limits are and as the
--                                 block evaluates it. result is the stored evaluation of that parameter (PASS, ALERT,
--                                 FAIL), or of the entry where the block stores only one; it is not a verdict per reading
--   report.process_actual_v1      one row per ACTUAL entry: tag, value and unit as recorded, the step configuration's
--                                 acceptance limits for the tag, and the stored withinLimits flag
--   report.exception_detail_v1    one row per register exception: step key and the master's title of the step, the
--                                 exception's text, and its status and disposition in the record (the engine's
--                                 DISPOSITION_EXCEPTION: outcome, the person's legal name, the time)
-- Batch records: every record of the database. A GMP database holds GMP records only (recipe-core 0500, DI-05) and the
-- reporting role never connects to a sandbox (kernel 1210 connect policy), so the reader sees GMP records only.
--
-- Built as the 6g, 6A and 1800 report views: a STABLE SECURITY DEFINER row function per view owned by ebmr_owner with
-- its search_path pinned, read_at and data_as_of on every row, SELECT and EXECUTE to ebmr_app and ebmr_report only, in
-- report.view_registry. The helper report.phase_of is IMMUTABLE and private (no EXECUTE for anyone). The segregation
-- check (sandbox.segregation_problems) allows exactly these grants, so it does not change.

set local role ebmr_owner;

-- The phase node `p_phase` of MBR content (null when absent).
create function report.phase_of(p_content jsonb, p_phase text) returns jsonb
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select pg_catalog.jsonb_path_query_first(p_content -> 'procedure', '$.** ? (@.kind == "phase" && @.id == $id)', pg_catalog.jsonb_build_object('id', p_phase))
$$;
revoke all on function report.phase_of(jsonb, text) from public;

create function report.equipment_use_rows_v1()
returns table (batch_number text, equipment_code text, equipment_type text, room_code text, step text, started_at timestamptz, ended_at timestamptz,
               read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, plant, recipe, report, pg_temp as $$
  with uses as (
    select u.id, u.batch_id, u.equipment_id, u.started_at, e.ended_at
      from plant.equipment_use u left join plant.equipment_use_end e on e.use_id = u.id
    union all
    select i.id, i.batch_id, i.equipment_id, i.recorded_at, null::timestamptz from plant.instrument_use i
  ), named as (
    select se.use_id, k.key as step
      from plant.step_equipment se
      join recipe.execution_state s on s.batch_id = se.batch_id
      cross join lateral pg_catalog.jsonb_each(coalesce(s.state -> 'steps', '{}'::jsonb)) k
     where k.value ->> 'step' = se.step
    union
    select (en.value -> 'data' ->> 'useId')::uuid, en.value ->> 'stepKey'
      from recipe.execution_state s
      cross join lateral pg_catalog.jsonb_each(coalesce(s.state -> 'entries', '{}'::jsonb)) en
     where en.value ->> 'kind' = 'EQUIPMENT_USE'
       and en.value -> 'data' ->> 'useId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
  select x.batch_number, q.code, q.class_code, a.code, n.step, u.started_at, u.ended_at, pg_catalog.statement_timestamp(), report.data_as_of()
    from uses u
    join recipe.batch_execution x on x.id = u.batch_id
    join plant.equipment q on q.id = u.equipment_id
    left join plant.area a on a.id = q.area_id
    left join named n on n.use_id = u.id
   order by x.issued_at, x.batch_number, u.started_at, q.code, n.step
$$;

create function report.ipc_result_rows_v1()
returns table (batch_number text, step text, step_title text, check_kind text, item text, instrument_code text, reading integer, value_text text, unit text,
               lower_text text, upper_text text, aggregate text, alert_lower_text text, alert_upper_text text, result text, recorded_at timestamptz,
               read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, report, pg_temp as $$
  with en as (
    select x.issued_at, x.batch_number, e.value as v, e.value -> 'data' as d, e.value ->> 'kind' as kind, e.value ->> 'stepKey' as step_key,
           (e.value ->> 'recordedSeq') as seq,
           report.phase_of(m.content, s.state -> 'steps' -> (e.value ->> 'stepKey') ->> 'step') as phase
      from recipe.batch_execution x
      join recipe.execution_state s on s.batch_id = x.id
      cross join lateral (select recipe.batch_mbr_content(x.id) as content) m
      cross join lateral pg_catalog.jsonb_each(coalesce(s.state -> 'entries', '{}'::jsonb)) e
     where e.value ->> 'kind' = 'PHYSICAL_CHECK' or e.value ->> 'kind' = 'WEIGHT_CHECK'
        or (pg_catalog.jsonb_typeof(e.value -> 'data') = 'object' and e.value -> 'data' ? 'instrument' and e.value -> 'data' ? 'result')
  ), rows as (
    -- PHYSICAL_CHECK: each tablet's value of each parameter the step examines (breaking force in N)
    select en.*, p.param as item, t.n::integer as reading,
           case when p.param = 'hardness' and cfg.c -> 'hardness' ->> 'unit' = 'kp' then ((t.tab ->> p.param)::numeric * 9.80665)::text else t.tab ->> p.param end as value_text,
           case when p.param = 'hardness' then 'N' else 'mm' end as unit,
           cfg.c -> p.param -> 'individual' as tiers, null::text as aggregate, en.d -> 'evaluation' -> p.param ->> 'result' as result, 1 as part
      from en
      cross join lateral (select coalesce(en.phase -> 'config' -> 'physical', en.phase -> 'config') as c) cfg
      cross join lateral unnest(array['thickness', 'diameter', 'hardness']) with ordinality p(param, o)
      cross join lateral pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(en.d -> 'tablets') = 'array' then en.d -> 'tablets' else '[]'::jsonb end) with ordinality t(tab, n)
     where en.kind = 'PHYSICAL_CHECK' and t.tab ? p.param
    union all
    -- PHYSICAL_CHECK: the mean of each parameter, as the block evaluated it, against the mean limits
    select en.*, p.param, null, en.d -> 'evaluation' -> p.param ->> 'mean', coalesce(en.d -> 'evaluation' -> p.param ->> 'unit', case when p.param = 'hardness' then 'N' else 'mm' end),
           cfg.c -> p.param -> 'mean', 'mean', en.d -> 'evaluation' -> p.param ->> 'result', 2
      from en
      cross join lateral (select coalesce(en.phase -> 'config' -> 'physical', en.phase -> 'config') as c) cfg
      cross join lateral unnest(array['thickness', 'diameter', 'hardness']) p(param)
     where en.kind = 'PHYSICAL_CHECK' and pg_catalog.jsonb_typeof(en.d -> 'evaluation' -> p.param) = 'object'
    union all
    -- PHYSICAL_CHECK: the appearance (the defects observed)
    select en.*, 'appearance', null, coalesce(nullif(pg_catalog.array_to_string(array(select pg_catalog.jsonb_array_elements_text(en.d -> 'evaluation' -> 'appearance' -> 'defects')), ', '), ''), 'none'),
           null, null, 'defects', en.d -> 'evaluation' -> 'appearance' ->> 'result', 3
      from en
     where en.kind = 'PHYSICAL_CHECK' and pg_catalog.jsonb_typeof(en.d -> 'evaluation' -> 'appearance') = 'object'
    union all
    -- WEIGHT_CHECK: each weight (mg), against the individual limits of an INDIVIDUAL check
    select en.*, 'weight', w.n::integer, w.val, 'mg', case when en.d -> 'evaluation' ->> 'mode' = 'INDIVIDUAL' then en.d -> 'evaluation' -> 'limits' end, null, en.d ->> 'result', 1
      from en
      cross join lateral pg_catalog.jsonb_array_elements_text(case when pg_catalog.jsonb_typeof(en.d -> 'weights') = 'array' then en.d -> 'weights' else '[]'::jsonb end) with ordinality w(val, n)
     where en.kind = 'WEIGHT_CHECK'
    union all
    -- WEIGHT_CHECK: the group total against its limits (GROUP), else the mean of the weights
    select en.*, 'weight', null,
           case when en.d -> 'evaluation' ->> 'mode' = 'GROUP' then en.d -> 'evaluation' ->> 'total' else en.d -> 'evaluation' ->> 'mean' end, 'mg',
           case when en.d -> 'evaluation' ->> 'mode' = 'GROUP' then en.d -> 'evaluation' -> 'limits' end,
           case when en.d -> 'evaluation' ->> 'mode' = 'GROUP' then 'group_total' else 'mean' end, en.d ->> 'result', 2
      from en
     where en.kind = 'WEIGHT_CHECK' and pg_catalog.jsonb_typeof(en.d -> 'evaluation') = 'object'
    union all
    -- Any other test entry (friability, disintegration, ...): its stored result
    select en.*, null, null, null, null, null, 'result', en.d ->> 'result', 1
      from en
     where en.kind not in ('PHYSICAL_CHECK', 'WEIGHT_CHECK')
  )
  select r.batch_number, r.step_key, r.phase ->> 'name', r.kind, r.item, r.d ->> 'instrument', r.reading, r.value_text, r.unit,
         r.tiers -> 'action' ->> 'min', r.tiers -> 'action' ->> 'max', r.aggregate, r.tiers -> 'alert' ->> 'min', r.tiers -> 'alert' ->> 'max', r.result,
         report.engine_instant(r.v -> 'recordedAt'), pg_catalog.statement_timestamp(), report.data_as_of()
    from rows r
   order by r.issued_at, r.batch_number, report.engine_instant(r.v -> 'recordedAt'), r.seq, r.item nulls first, r.part, r.reading nulls last
$$;

create function report.process_actual_rows_v1()
returns table (batch_number text, step text, tag text, value_text text, unit text, lower_text text, upper_text text, within_limits boolean, recorded_at timestamptz,
               read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, report, pg_temp as $$
  select x.batch_number, e.value ->> 'stepKey', e.value -> 'data' ->> 'tag', e.value -> 'data' ->> 'value', e.value -> 'data' ->> 'unit',
         lim.a ->> 'min', lim.a ->> 'max',
         case when pg_catalog.jsonb_typeof(e.value -> 'data' -> 'withinLimits') = 'boolean' then (e.value -> 'data' ->> 'withinLimits')::boolean end,
         report.engine_instant(e.value -> 'recordedAt'), pg_catalog.statement_timestamp(), report.data_as_of()
    from recipe.batch_execution x
    join recipe.execution_state s on s.batch_id = x.id
    cross join lateral (select recipe.batch_mbr_content(x.id) as content) m
    cross join lateral pg_catalog.jsonb_each(coalesce(s.state -> 'entries', '{}'::jsonb)) e
    cross join lateral (select pg_catalog.jsonb_path_query_first(
                                 report.phase_of(m.content, s.state -> 'steps' -> (e.value ->> 'stepKey') ->> 'step') -> 'config',
                                 '$.**.actuals[*] ? (@.tag == $t)', pg_catalog.jsonb_build_object('t', e.value -> 'data' ->> 'tag')) as a) lim
   where e.value ->> 'kind' = 'ACTUAL'
   order by x.issued_at, x.batch_number, report.engine_instant(e.value -> 'recordedAt'), (e.value ->> 'recordedSeq')
$$;

create function report.exception_detail_rows_v1()
returns table (batch_number text, exception_id text, exception_type text, category text, severity text, step text, step_title text, description text,
               status text, disposition text, disposed_by text, disposed_at timestamptz, raised_at timestamptz, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, iam, report, pg_temp as $$
  select x.batch_number, r.exception_id, r.exception_type, r.category, r.severity, r.raising_step_key,
         report.phase_of(recipe.batch_mbr_content(x.id), r.raising_step) ->> 'name', r.title,
         coalesce(ex.v ->> 'status', 'OPEN'), ex.v -> 'disposition' ->> 'outcome',
         coalesce((select p.legal_name from iam.person p where p.id::text = ex.v -> 'disposition' ->> 'by'), ex.v -> 'disposition' ->> 'by'),
         report.engine_instant(ex.v -> 'disposition' -> 'at'), r.raised_at, pg_catalog.statement_timestamp(), report.data_as_of()
    from recipe.exception_register r
    join recipe.batch_execution x on x.id = r.batch_id
    left join recipe.execution_state s on s.batch_id = r.batch_id
    left join lateral (select s.state -> 'exceptions' -> r.exception_id as v) ex on true
   order by r.raised_at, x.batch_number, r.exception_id
$$;

revoke all on function report.equipment_use_rows_v1(), report.ipc_result_rows_v1(), report.process_actual_rows_v1(), report.exception_detail_rows_v1() from public;
grant execute on function report.equipment_use_rows_v1(), report.ipc_result_rows_v1(), report.process_actual_rows_v1(), report.exception_detail_rows_v1() to ebmr_app, ebmr_report;

create view report.equipment_use_v1 as select * from report.equipment_use_rows_v1();
create view report.ipc_result_v1 as select * from report.ipc_result_rows_v1();
create view report.process_actual_v1 as select * from report.process_actual_rows_v1();
create view report.exception_detail_v1 as select * from report.exception_detail_rows_v1();
revoke all on report.equipment_use_v1, report.ipc_result_v1, report.process_actual_v1, report.exception_detail_v1 from public;
grant select on report.equipment_use_v1, report.ipc_result_v1, report.process_actual_v1, report.exception_detail_v1 to ebmr_app, ebmr_report;

insert into report.view_registry (view_name, version, grain, description) values
  ('equipment_use_v1', 1, 'unit use and step', 'Each use of a plant unit or instrument by a batch record, with its class, room, the steps that name it, start and end'),
  ('ipc_result_v1', 1, 'in-process check value', 'Each value of an in-process check (readings, means, group totals, appearance) with its instrument, the step''s action and alert limits and the stored result'),
  ('process_actual_v1', 1, 'collected process value', 'Each process value collected from equipment (ACTUAL), with the step''s acceptance limits for its tag and the stored within-limits flag'),
  ('exception_detail_v1', 1, 'register exception', 'Each register exception with its step and step title, its text, status and disposition (outcome, by whom, when)');

reset role;
