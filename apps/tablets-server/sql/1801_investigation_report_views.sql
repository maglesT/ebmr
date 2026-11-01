-- Slice S16 (second part): four report views of what an investigation of a batch event needs and the existing report
-- views do not give, for the external Deviations and CAPA system that reads as the reporting role (ADR 0022, D-S16-1,
-- D-S16-2, D-S16-3 to D-S16-5; tablets 1800, kernel 1210, recipe-core 1070 and 1115).
-- Handbook: modules/tablets-server.md
--
-- Why. Checked on the hosted demo's failing batch: cpp_value_v1 gives only the critical MBR parameters and calculations,
-- so the block entries of the in-process checks (TB-11 to TB-13) and the process values collected from equipment
-- (ACTUAL entries of G-06 and the Tablets process blocks) are not in it; step_use_v1 takes a step's unit from
-- plant.step_equipment, which only a gateway binding or a person's explicit binding fills, so most steps show no unit;
-- exception_v1 has no step, text or disposition. These views read the record as the engine stored it (the execution
-- state, its master content, the exception register and the plant's use records), and evaluate nothing themselves:
-- every result and limit flag is the one the engine stored with the entry.
--
--   report.equipment_use_v1       one row per use of a unit by a GMP batch record and step that names it:
--                                 plant.equipment_use (with its end) and plant.instrument_use (an instrument use has no
--                                 recorded end: ended_at null). The steps: a binding (plant.step_equipment) gives its step
--                                 key, or, where it names the phase, the one step instance of that phase that had started
--                                 when the binding was made (as step_use_v1 matches a binding by key or phase); and each
--                                 step whose EQUIPMENT_USE entry names the use. A use no step names gives one row with step
--                                 null.
--   report.ipc_result_v1          one row per value of an in-process check entry:
--                                   PHYSICAL_CHECK (TB-13, and TB-11 checks): each tablet's thickness, diameter and breaking
--                                     force (reading 1..n), then the mean of each (aggregate 'mean'), then the appearance
--                                     (aggregate 'defects');
--                                   STATION_SWEEP (TB-11): each station's weight, thickness and breaking force (reading =
--                                     station number) against the sweep's individual limits;
--                                   WEIGHT_CHECK (TB-11, TB-12): each weight, then the group total (aggregate
--                                     'group_total', against its limits) or the mean of the weights (aggregate 'mean');
--                                   any other test entry (friability, disintegration, ...): one row, aggregate 'result'.
--                                 Limits are the step's configuration in the record's master (individual or mean, action and
--                                 alert). Breaking force read in kp is given in N (1 kp = 9.80665 N exactly), as the limits
--                                 are and as the block evaluates it. result is what the block stored: PASS, ALERT (outside
--                                 alert limits only) or FAIL (and PENDING or SECOND_STAGE for a weight check awaiting its
--                                 second stage). The blocks store one verdict per parameter of an entry, not per reading: a
--                                 PHYSICAL_CHECK's verdict combines the individual and the mean limits, so its reading rows
--                                 and its mean row carry that combined verdict; a STATION_SWEEP's verdict is its individual
--                                 limits'; a WEIGHT_CHECK's is the entry's.
--   report.process_actual_v1      one row per ACTUAL entry: tag, value and unit as recorded, the step configuration's
--                                 acceptance limits for the tag, and the stored withinLimits flag
--   report.exception_detail_v1    one row per register exception: step key and the master's title of the step, the
--                                 exception's text, and its status and disposition in the record (the engine's
--                                 DISPOSITION_EXCEPTION: outcome, the person by pseudonymous person id, the time; D-S16-4:
--                                 no names on the reporting path, as step_use_v1 gives person ids)
-- Batch records: GMP batch records only (installation GMP, purpose GMP_BATCH), as batch_fact_v1 (D-S16-3).
--
-- Each view has a sibling report.<name>_for(batch_numbers text[]) with the same columns that reads only the batches named
-- (D-S16-5): a view behind a definer function cannot take a reader's "where batch_number = ..." into the jsonb work, so a
-- reader that investigates one batch calls the function. EXECUTE on the _for functions to ebmr_report only.
--
-- Built as the 6g, 6A and 1800 report views: STABLE SECURITY DEFINER functions owned by ebmr_owner with their
-- search_path pinned, read_at and data_as_of on every row, SELECT on the views and EXECUTE on their row functions to
-- ebmr_app and ebmr_report, in report.view_registry. The helper report.phase_of is IMMUTABLE and private (no EXECUTE
-- for anyone). The segregation check (sandbox.segregation_problems) allows exactly these grants, so it does not change.

set local role ebmr_owner;

-- The phase node `p_phase` of MBR content (null when absent).
create function report.phase_of(p_content jsonb, p_phase text) returns jsonb
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select pg_catalog.jsonb_path_query_first(p_content -> 'procedure', '$.** ? (@.kind == "phase" && @.id == $id)', pg_catalog.jsonb_build_object('id', p_phase))
$$;
revoke all on function report.phase_of(jsonb, text) from public;

create function report.equipment_use_v1_for(p_batches text[])
returns table (batch_number text, equipment_code text, equipment_type text, room_code text, step text, started_at timestamptz, ended_at timestamptz,
               read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, plant, recipe, report, pg_temp as $$
  with b as (
    select x.id, x.batch_number, x.issued_at from recipe.batch_execution x
     where x.installation = 'GMP' and x.purpose = 'GMP_BATCH' and (p_batches is null or x.batch_number = any(p_batches))
  ), uses as (
    select u.id, u.batch_id, u.equipment_id, u.started_at, e.ended_at
      from plant.equipment_use u join b on b.id = u.batch_id left join plant.equipment_use_end e on e.use_id = u.id
    union all
    select i.id, i.batch_id, i.equipment_id, i.recorded_at, null::timestamptz from plant.instrument_use i join b on b.id = i.batch_id
  ), named as (
    -- A binding names its step key, or its phase: then the one instance of the phase that had started when it was bound.
    select se.use_id,
           coalesce(case when s.state -> 'steps' ? se.step then se.step end,
                    (select k.key from pg_catalog.jsonb_each(coalesce(s.state -> 'steps', '{}'::jsonb)) k
                      where k.value ->> 'step' = se.step
                      order by (report.engine_instant(k.value -> 'startedAt') <= se.bound_at) desc nulls last, report.engine_instant(k.value -> 'startedAt') desc nulls last, k.key
                      limit 1)) as step
      from plant.step_equipment se
      join b on b.id = se.batch_id
      join recipe.execution_state s on s.batch_id = se.batch_id
    union
    select (en.value -> 'data' ->> 'useId')::uuid, en.value ->> 'stepKey'
      from b
      join recipe.execution_state s on s.batch_id = b.id
      cross join lateral pg_catalog.jsonb_each(coalesce(s.state -> 'entries', '{}'::jsonb)) en
     where en.value ->> 'kind' = 'EQUIPMENT_USE'
       and en.value -> 'data' ->> 'useId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
  select b.batch_number, q.code, q.class_code, a.code, n.step, u.started_at, u.ended_at, pg_catalog.statement_timestamp(), report.data_as_of()
    from uses u
    join b on b.id = u.batch_id
    join plant.equipment q on q.id = u.equipment_id
    left join plant.area a on a.id = q.area_id
    left join named n on n.use_id = u.id
   order by b.issued_at, b.batch_number, u.started_at, q.code, n.step
$$;

create function report.ipc_result_v1_for(p_batches text[])
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
     where x.installation = 'GMP' and x.purpose = 'GMP_BATCH' and (p_batches is null or x.batch_number = any(p_batches))
       and (e.value ->> 'kind' in ('PHYSICAL_CHECK', 'WEIGHT_CHECK', 'STATION_SWEEP')
            or (pg_catalog.jsonb_typeof(e.value -> 'data') = 'object' and e.value -> 'data' ? 'instrument' and e.value -> 'data' ? 'result'))
  ), rows as (
    -- PHYSICAL_CHECK: each tablet's value of each parameter the step examines (breaking force in N)
    select en.*, p.param as item, t.n::integer as reading,
           case when p.param = 'hardness' and cfg.c -> 'hardness' ->> 'unit' = 'kp' then ((t.tab ->> p.param)::numeric * 9.80665)::text else t.tab ->> p.param end as value_text,
           case when p.param = 'hardness' then 'N' else 'mm' end as unit,
           cfg.c -> p.param -> 'individual' as tiers, null::text as aggregate, en.d -> 'evaluation' -> p.param ->> 'result' as result, p.o::integer as po, 1 as part
      from en
      cross join lateral (select coalesce(en.phase -> 'config' -> 'physical', en.phase -> 'config') as c) cfg
      cross join lateral unnest(array['thickness', 'diameter', 'hardness']) with ordinality p(param, o)
      cross join lateral pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(en.d -> 'tablets') = 'array' then en.d -> 'tablets' else '[]'::jsonb end) with ordinality t(tab, n)
     where en.kind = 'PHYSICAL_CHECK' and t.tab ? p.param
    union all
    -- PHYSICAL_CHECK: the mean of each parameter, as the block evaluated it, against the mean limits
    select en.*, p.param, null, en.d -> 'evaluation' -> p.param ->> 'mean', coalesce(en.d -> 'evaluation' -> p.param ->> 'unit', case when p.param = 'hardness' then 'N' else 'mm' end),
           cfg.c -> p.param -> 'mean', 'mean', en.d -> 'evaluation' -> p.param ->> 'result', p.o::integer, 2
      from en
      cross join lateral (select coalesce(en.phase -> 'config' -> 'physical', en.phase -> 'config') as c) cfg
      cross join lateral unnest(array['thickness', 'diameter', 'hardness']) with ordinality p(param, o)
     where en.kind = 'PHYSICAL_CHECK' and pg_catalog.jsonb_typeof(en.d -> 'evaluation' -> p.param) = 'object'
    union all
    -- PHYSICAL_CHECK: the appearance (the defects observed)
    select en.*, 'appearance', null, coalesce(nullif(pg_catalog.array_to_string(array(select pg_catalog.jsonb_array_elements_text(en.d -> 'evaluation' -> 'appearance' -> 'defects')), ', '), ''), 'none'),
           null, null, 'defects', en.d -> 'evaluation' -> 'appearance' ->> 'result', 4, 3
      from en
     where en.kind = 'PHYSICAL_CHECK' and pg_catalog.jsonb_typeof(en.d -> 'evaluation' -> 'appearance') = 'object'
    union all
    -- STATION_SWEEP: each station's value of each swept parameter (breaking force in N), against the sweep's individual limits
    select en.*, p.param, (st.v ->> 'station')::integer,
           case when p.param = 'hardness' and en.phase -> 'config' -> 'sweep' -> 'hardness' ->> 'unit' = 'kp' then ((st.v ->> p.param)::numeric * 9.80665)::text else st.v ->> p.param end,
           case p.param when 'weight' then 'mg' when 'hardness' then 'N' else 'mm' end,
           en.phase -> 'config' -> 'sweep' -> p.param -> 'individual', null, en.d -> 'evaluation' -> p.param ->> 'result', p.o::integer, 1
      from en
      cross join lateral unnest(array['weight', 'thickness', 'hardness']) with ordinality p(param, o)
      cross join lateral pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(en.d -> 'stations') = 'array' then en.d -> 'stations' else '[]'::jsonb end) st(v)
     where en.kind = 'STATION_SWEEP' and st.v ? p.param
    union all
    -- WEIGHT_CHECK: each weight (mg), against the individual limits of an INDIVIDUAL check
    select en.*, 'weight', w.n::integer, w.val, 'mg', case when en.d -> 'evaluation' ->> 'mode' = 'INDIVIDUAL' then en.d -> 'evaluation' -> 'limits' end, null, en.d ->> 'result', 1, 1
      from en
      cross join lateral pg_catalog.jsonb_array_elements_text(case when pg_catalog.jsonb_typeof(en.d -> 'weights') = 'array' then en.d -> 'weights' else '[]'::jsonb end) with ordinality w(val, n)
     where en.kind = 'WEIGHT_CHECK'
    union all
    -- WEIGHT_CHECK: the group total against its limits (GROUP), else the mean of the weights
    select en.*, 'weight', null,
           case when en.d -> 'evaluation' ->> 'mode' = 'GROUP' then en.d -> 'evaluation' ->> 'total' else en.d -> 'evaluation' ->> 'mean' end, 'mg',
           case when en.d -> 'evaluation' ->> 'mode' = 'GROUP' then en.d -> 'evaluation' -> 'limits' end,
           case when en.d -> 'evaluation' ->> 'mode' = 'GROUP' then 'group_total' else 'mean' end, en.d ->> 'result', 1, 2
      from en
     where en.kind = 'WEIGHT_CHECK' and pg_catalog.jsonb_typeof(en.d -> 'evaluation') = 'object'
    union all
    -- Any other test entry (friability, disintegration, ...): its stored result
    select en.*, null, null, null, null, null, 'result', en.d ->> 'result', 1, 1
      from en
     where en.kind not in ('PHYSICAL_CHECK', 'WEIGHT_CHECK', 'STATION_SWEEP')
  )
  select r.batch_number, r.step_key, r.phase ->> 'name', r.kind, r.item, r.d ->> 'instrument', r.reading, r.value_text, r.unit,
         r.tiers -> 'action' ->> 'min', r.tiers -> 'action' ->> 'max', r.aggregate, r.tiers -> 'alert' ->> 'min', r.tiers -> 'alert' ->> 'max', r.result,
         report.engine_instant(r.v -> 'recordedAt'), pg_catalog.statement_timestamp(), report.data_as_of()
    from rows r
   order by r.issued_at, r.batch_number, report.engine_instant(r.v -> 'recordedAt'), r.seq, r.po, r.part, r.reading nulls last
$$;

create function report.process_actual_v1_for(p_batches text[])
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
   where x.installation = 'GMP' and x.purpose = 'GMP_BATCH' and (p_batches is null or x.batch_number = any(p_batches))
     and e.value ->> 'kind' = 'ACTUAL'
   order by x.issued_at, x.batch_number, report.engine_instant(e.value -> 'recordedAt'), (e.value ->> 'recordedSeq')
$$;

create function report.exception_detail_v1_for(p_batches text[])
returns table (batch_number text, exception_id text, exception_type text, category text, severity text, step text, step_title text, description text,
               status text, disposition text, disposed_by text, disposed_at timestamptz, raised_at timestamptz, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, report, pg_temp as $$
  with x as materialized (
    select b.id, b.batch_number, recipe.batch_mbr_content(b.id) as content from recipe.batch_execution b
     where b.installation = 'GMP' and b.purpose = 'GMP_BATCH' and (p_batches is null or b.batch_number = any(p_batches))
  ), t as materialized (
    -- The master's title of each raising step, once per batch and step.
    select x.id, st.step, report.phase_of(x.content, st.step) ->> 'name' as title
      from x cross join lateral (select distinct r.raising_step as step from recipe.exception_register r where r.batch_id = x.id and r.raising_step is not null) st
  )
  select x.batch_number, r.exception_id, r.exception_type, r.category, r.severity, r.raising_step_key, t.title, r.title,
         coalesce(ex.v ->> 'status', 'OPEN'), ex.v -> 'disposition' ->> 'outcome',
         -- D-S16-4: the pseudonymous person id, never a name; null without a person.
         case when ex.v -> 'disposition' ->> 'by' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then ex.v -> 'disposition' ->> 'by' end,
         report.engine_instant(ex.v -> 'disposition' -> 'at'), r.raised_at, pg_catalog.statement_timestamp(), report.data_as_of()
    from recipe.exception_register r
    join x on x.id = r.batch_id
    left join t on t.id = r.batch_id and t.step = r.raising_step
    left join recipe.execution_state s on s.batch_id = r.batch_id
    left join lateral (select s.state -> 'exceptions' -> r.exception_id as v) ex on true
   order by r.raised_at, x.batch_number, r.exception_id
$$;

create function report.equipment_use_rows_v1()
returns table (batch_number text, equipment_code text, equipment_type text, room_code text, step text, started_at timestamptz, ended_at timestamptz,
               read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, report, pg_temp as $$ select * from report.equipment_use_v1_for(null) $$;
create function report.ipc_result_rows_v1()
returns table (batch_number text, step text, step_title text, check_kind text, item text, instrument_code text, reading integer, value_text text, unit text,
               lower_text text, upper_text text, aggregate text, alert_lower_text text, alert_upper_text text, result text, recorded_at timestamptz,
               read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, report, pg_temp as $$ select * from report.ipc_result_v1_for(null) $$;
create function report.process_actual_rows_v1()
returns table (batch_number text, step text, tag text, value_text text, unit text, lower_text text, upper_text text, within_limits boolean, recorded_at timestamptz,
               read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, report, pg_temp as $$ select * from report.process_actual_v1_for(null) $$;
create function report.exception_detail_rows_v1()
returns table (batch_number text, exception_id text, exception_type text, category text, severity text, step text, step_title text, description text,
               status text, disposition text, disposed_by text, disposed_at timestamptz, raised_at timestamptz, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, report, pg_temp as $$ select * from report.exception_detail_v1_for(null) $$;

revoke all on function report.equipment_use_v1_for(text[]), report.ipc_result_v1_for(text[]), report.process_actual_v1_for(text[]), report.exception_detail_v1_for(text[]),
                       report.equipment_use_rows_v1(), report.ipc_result_rows_v1(), report.process_actual_rows_v1(), report.exception_detail_rows_v1() from public;
grant execute on function report.equipment_use_v1_for(text[]), report.ipc_result_v1_for(text[]), report.process_actual_v1_for(text[]), report.exception_detail_v1_for(text[]) to ebmr_report;
grant execute on function report.equipment_use_rows_v1(), report.ipc_result_rows_v1(), report.process_actual_rows_v1(), report.exception_detail_rows_v1() to ebmr_app, ebmr_report;

create view report.equipment_use_v1 as select * from report.equipment_use_rows_v1();
create view report.ipc_result_v1 as select * from report.ipc_result_rows_v1();
create view report.process_actual_v1 as select * from report.process_actual_rows_v1();
create view report.exception_detail_v1 as select * from report.exception_detail_rows_v1();
revoke all on report.equipment_use_v1, report.ipc_result_v1, report.process_actual_v1, report.exception_detail_v1 from public;
grant select on report.equipment_use_v1, report.ipc_result_v1, report.process_actual_v1, report.exception_detail_v1 to ebmr_app, ebmr_report;

insert into report.view_registry (view_name, version, grain, description) values
  ('equipment_use_v1', 1, 'unit use and step', 'Each use of a plant unit or instrument by a GMP batch record, with its class, room, the steps that name it, start and end; report.equipment_use_v1_for(batch numbers) for chosen batches'),
  ('ipc_result_v1', 1, 'in-process check value', 'Each value of an in-process check (readings, sweep stations, means, group totals, appearance) with its instrument, the step''s action and alert limits and the stored result (PASS, ALERT, FAIL); report.ipc_result_v1_for(batch numbers) for chosen batches'),
  ('process_actual_v1', 1, 'collected process value', 'Each process value collected from equipment (ACTUAL), with the step''s acceptance limits for its tag and the stored within-limits flag; report.process_actual_v1_for(batch numbers) for chosen batches'),
  ('exception_detail_v1', 1, 'register exception', 'Each register exception with its step and step title, its text, status and disposition (outcome, person id, time); report.exception_detail_v1_for(batch numbers) for chosen batches');

reset role;
