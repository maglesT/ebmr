-- Phase 6A slice 6A-1: the analytics input views v1 (ADR 0020 point 3; draft controls DI-51, DI-52; interfaces
-- slice-6A-0-interfaces.md section 3; D-6A-0-1, D-6A-0-2, D-6A-1-2 to D-6A-1-5).
--
-- Handbook: modules/analytics.md
--
-- Versioned, read-only views in the schema report, built as the 6g report views are (recipe-core 1070): each view
-- report.<name>_v1 selects from its row function report.<name>_rows_v1() (SQL, STABLE, SECURITY DEFINER, owned by
-- ebmr_owner), so a reader needs no right on the recipe, site or plant tables behind it. Every row carries read_at
-- (the statement time) and data_as_of (report.data_as_of()). GMP values stay the source's exact decimal text.
--
--   report.batch_fact_v1   one row per GMP batch record: batch number, product code and strength, the MBR version
--                          and family it ran on, record kind, review status, issue and completion times, and whether
--                          its finished lot is released by the manufacturer.
--   report.cpp_value_v1    one row per critical value of a GMP batch record: what recipe.pqr_cpp_of (recipe-core 1062)
--                          exports for the batch (VALID data points of CRITICAL parameters whose role is
--                          PROCESS_PARAMETER, IPC or PROCESS_ENDPOINT, and CURRENT derived values of CRITICAL
--                          calculations), with the parameter's role, the value as decimal text (one row per reading of
--                          a SERIES), its unit, the limits and target of the issued master and the time it was
--                          recorded. Only numeric values appear: DECIMAL, COUNT and SERIES (D-6A-1-3). The limits are
--                          those of the outermost tier the master gives, in the order REGISTERED, VALIDATED,
--                          INTERNAL_ACTION, ALERT, and the view names that tier (limit_tier; D-6A-1-2).
--   report.step_use_v1     one row per executed step of a GMP batch record and unit it ran on (a step without a unit
--                          binding gives one row with no unit): the step key and phase id, the unit's code and class,
--                          the room (the unit's room, else the room the batch occupied when the step started, else the
--                          batch's own room), start and end, the persons who performed, entered or corrected it, and
--                          the material lots consumed by its entries (lot code and supplier pairs; D-6A-1-4).
--
-- Each is registered on the analytics role's allow-list (kernel 1242 analytics.register_input), together with the
-- 6g view report.batch_outcome_v1 that the runner polls for newly completed batches, and in the report catalogue
-- (report.view_registry) with SELECT to the reporting and application roles, as the 6g views are (D-6A-1-5). The views write
-- nothing and decide nothing; nothing outside the analytics schema reads analytics (DI-51), and these views do not
-- read it either.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1115_analytics_input_views)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the analytics input views v1: batch facts, critical values, step use (DI-51, DI-52)'));

-- An engine instant ({"$u": "<microseconds>"}) as a timestamptz; null when absent.
create function report.engine_instant(p_value jsonb) returns timestamptz
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select case when pg_catalog.jsonb_typeof(p_value -> '$u') = 'string' and (p_value ->> '$u') ~ '^-?[0-9]{1,18}$'
              then pg_catalog.to_timestamp((p_value ->> '$u')::numeric / 1000000) end
$$;
revoke all on function report.engine_instant(jsonb) from public;

-- The limits a value is compared with: the outermost tier of a LimitSpec in the order REGISTERED, VALIDATED,
-- INTERNAL_ACTION, ALERT, as {tier, lower, upper} (decimal text, null for an open side); null without limits.
create function report.outer_limits(p_limits jsonb) returns jsonb
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select pg_catalog.jsonb_build_object('tier', r ->> 'tier', 'lower', r -> 'low' ->> 'value', 'upper', r -> 'high' ->> 'value')
    from pg_catalog.jsonb_array_elements(case when pg_catalog.jsonb_typeof(p_limits -> 'ranges') = 'array' then p_limits -> 'ranges' else '[]'::jsonb end) r
   order by pg_catalog.array_position(array['REGISTERED', 'VALIDATED', 'INTERNAL_ACTION', 'ALERT'], r ->> 'tier') nulls last
   limit 1
$$;
revoke all on function report.outer_limits(jsonb) from public;

-- The critical numeric values of one record (its batch number, master content and state), as rows: pure, so the same
-- record gives the same rows. Built on recipe.pqr_cpp_of: the same values the PQR extract exports.
create function report.cpp_values_of(p_batch_number text, p_content jsonb, p_state jsonb)
returns table (kind text, item text, step text, attempt integer, reading integer, role text, value_text text, unit text, lower_text text,
               upper_text text, target_text text, limit_tier text, failed boolean, recorded_at timestamptz, ref text)
language sql immutable set search_path = pg_catalog, pg_temp as $$
  with c as (
    select x.v, x.n from pg_catalog.jsonb_array_elements(recipe.pqr_cpp_of(p_batch_number, p_content, p_state)) with ordinality x(v, n)),
  d as (
    select c.n, c.v ->> 'kind' as kind, c.v ->> 'id' as item, c.v ->> 'step' as step, (c.v ->> 'attempt')::integer as attempt, c.v -> 'value' as value,
           c.v ->> 'unit' as master_unit, (c.v ->> 'failed')::boolean as failed, c.v ->> 'ref' as ref,
           case c.v ->> 'kind'
             when 'PARAMETER' then (select p from pg_catalog.jsonb_array_elements(coalesce(p_content -> 'parameters', '[]'::jsonb)) p where p ->> 'id' = c.v ->> 'id' limit 1)
             else (select k from pg_catalog.jsonb_array_elements(coalesce(p_content -> 'calculations', '[]'::jsonb)) k where k ->> 'id' = c.v ->> 'id' limit 1)
           end as def,
           case c.v ->> 'kind'
             when 'PARAMETER' then report.engine_instant(p_state -> 'points' -> (c.v ->> 'ref') -> 'recordedAt')
             else report.engine_instant(p_state -> 'derived' -> (c.v ->> 'ref') -> 'computedAt')
           end as recorded_at
      from c),
  r as (
    select d.*, t.reading, t.text
      from d
      cross join lateral (
        select null::integer as reading, d.value ->> 'value' as text where d.value ->> 'kind' in ('DECIMAL', 'COUNT')
        union all
        select s.n::integer, s.v
          from pg_catalog.jsonb_array_elements_text(case when d.value ->> 'kind' = 'SERIES' and pg_catalog.jsonb_typeof(d.value -> 'values') = 'array'
                                                         then d.value -> 'values' else '[]'::jsonb end) with ordinality s(v, n)) t
     where t.text ~ '^-?[0-9]+(\.[0-9]+)?$')
  select r.kind, r.item, r.step, r.attempt, r.reading,
         case when r.kind = 'PARAMETER' then r.def ->> 'role' end,
         r.text, coalesce(r.value ->> 'unit', r.master_unit),
         report.outer_limits(r.def -> 'limits') ->> 'lower', report.outer_limits(r.def -> 'limits') ->> 'upper',
         r.def ->> 'target', report.outer_limits(r.def -> 'limits') ->> 'tier', r.failed, r.recorded_at, r.ref
    from r
   order by r.n, r.reading nulls first
$$;
revoke all on function report.cpp_values_of(text, jsonb, jsonb) from public;

-- GMP batch records (the analytics inputs read GMP batches only; the sandbox and training mode run no analytics).
create function report.batch_fact_rows_v1()
returns table (batch_id uuid, batch_number text, product_code text, strength text, mbr_version_id uuid, family_code text, record_kind text,
               status text, issued_at timestamptz, completed_at timestamptz, released boolean, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, site, report, pg_temp as $$
  select x.id, x.batch_number, recipe.batch_product(x.id) ->> 'code', recipe.batch_product(x.id) ->> 'strength', v.id, f.code,
         recipe.batch_record_kind(x.id), recipe.batch_review_state(x.id), x.issued_at,
         (select report.us_at(min(c.now_us)) from recipe.execution_event e join recipe.execution_command c on c.batch_id = e.batch_id and c.seq = e.row_seq
           where e.batch_id = x.id and e.event_type = 'BATCH_STATUS_CHANGED' and e.event ->> 'to' = 'EXECUTION_COMPLETE'),
         exists (select 1 from site.finished_lot l join recipe.manufacturer_release_decision d on d.lot_id = l.lot_id and d.decision = 'RELEASED'
                  where l.batch_id = x.id),
         pg_catalog.statement_timestamp(), report.data_as_of()
    from recipe.batch_execution x
    left join recipe.mbr_version v on v.id = report.batch_version(x.id)
    left join recipe.mbr_family f on f.id = v.family_id
   where x.installation = 'GMP' and x.purpose = 'GMP_BATCH'
   order by x.issued_at, x.batch_number
$$;

create function report.cpp_value_rows_v1()
returns table (batch_id uuid, batch_number text, kind text, item text, step text, attempt integer, reading integer, role text, value_text text, unit text,
               lower_text text, upper_text text, target_text text, limit_tier text, failed boolean, recorded_at timestamptz, ref text,
               read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, report, pg_temp as $$
  select x.id, x.batch_number, v.kind, v.item, v.step, v.attempt, v.reading, v.role, v.value_text, v.unit, v.lower_text, v.upper_text, v.target_text,
         v.limit_tier, v.failed, v.recorded_at, v.ref, pg_catalog.statement_timestamp(), report.data_as_of()
    from recipe.batch_execution x
    join recipe.execution_state s on s.batch_id = x.id
    cross join lateral report.cpp_values_of(x.batch_number, recipe.batch_mbr_content(x.id), s.state) v
   where x.installation = 'GMP' and x.purpose = 'GMP_BATCH'
   order by x.issued_at, x.batch_number, v.kind, v.item, v.step, v.attempt, v.ref, v.reading nulls first
$$;

create function report.step_use_rows_v1()
returns table (batch_id uuid, batch_number text, step text, step_id text, equipment_code text, equipment_type text, room_code text,
               started_at timestamptz, ended_at timestamptz, person_ids uuid[], material_lots jsonb, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, site, plant, report, pg_temp as $$
  with st as (
    select x.id as batch_id, x.batch_number, x.issued_at, x.room_code as batch_room, s.state, k.key as step, k.value as si,
           report.engine_instant(k.value -> 'startedAt') as started_at,
           coalesce(report.engine_instant(k.value -> 'endedAt'), report.engine_instant(k.value -> 'completedAt')) as ended_at
      from recipe.batch_execution x
      join recipe.execution_state s on s.batch_id = x.id
      cross join lateral pg_catalog.jsonb_each(coalesce(s.state -> 'steps', '{}'::jsonb)) k
     where x.installation = 'GMP' and x.purpose = 'GMP_BATCH' and report.engine_instant(k.value -> 'startedAt') is not null)
  select st.batch_id, st.batch_number, st.step, st.si ->> 'step', e.code, e.class_code,
         coalesce(ea.code,
                  (select a.code from plant.area_occupancy o join plant.area a on a.id = o.area_id and a.kind = 'ROOM'
                     left join plant.area_occupancy_end oe on oe.occupancy_id = o.id
                    where o.batch_id = st.batch_id and o.started_at <= st.started_at and (oe.ended_at is null or oe.ended_at > st.started_at)
                    order by o.started_at desc, o.id limit 1),
                  st.batch_room),
         st.started_at, st.ended_at,
         coalesce((select array_agg(distinct p.v::uuid order by p.v::uuid)
                     from (select jsonb_array_elements_text(coalesce(st.si -> 'performers', '[]'::jsonb))
                           union all select jsonb_array_elements_text(coalesce(st.si -> 'dataEnterers', '[]'::jsonb))
                           union all select jsonb_array_elements_text(coalesce(st.si -> 'correctors', '[]'::jsonb))) p(v)
                    where p.v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), '{}'::uuid[]),
         coalesce((select jsonb_agg(distinct jsonb_build_object('lot', m.lot_code, 'supplier', m.supplier))
                     from recipe.consumption_entry ce
                     join site.lot_consumption lc on lc.id = ce.consumption_id
                     join site.material_lot m on m.id = lc.lot_id
                    where ce.batch_id = st.batch_id and st.state -> 'entries' -> ce.entry_key ->> 'stepKey' = st.step), '[]'::jsonb),
         pg_catalog.statement_timestamp(), report.data_as_of()
    from st
    left join plant.step_equipment se on se.batch_id = st.batch_id and se.step in (st.step, st.si ->> 'step')
    left join plant.equipment e on e.id = se.equipment_id
    left join plant.area ea on ea.id = e.area_id and ea.kind = 'ROOM'
   order by st.issued_at, st.batch_number, st.started_at, st.step, e.code nulls first
$$;

revoke all on function report.batch_fact_rows_v1(), report.cpp_value_rows_v1(), report.step_use_rows_v1() from public;

create view report.batch_fact_v1 as select * from report.batch_fact_rows_v1();
create view report.cpp_value_v1 as select * from report.cpp_value_rows_v1();
create view report.step_use_v1 as select * from report.step_use_rows_v1();
revoke all on report.batch_fact_v1, report.cpp_value_v1, report.step_use_v1 from public;
-- Report views like the 6g ones: the reporting role and the dashboards' documented export read them too (D-6A-1-5).
grant execute on function report.batch_fact_rows_v1(), report.cpp_value_rows_v1(), report.step_use_rows_v1() to ebmr_app, ebmr_report;
grant select on report.batch_fact_v1, report.cpp_value_v1, report.step_use_v1 to ebmr_app, ebmr_report;
insert into report.view_registry (view_name, version, grain, description) values
  ('batch_fact_v1', 1, 'GMP batch record', 'Product and strength, MBR version and family, record kind, review status, issue and completion times and release of each GMP batch record (analytics input)'),
  ('cpp_value_v1', 1, 'critical value (one per reading)', 'Critical process parameters, IPC results, endpoints and critical calculations as decimal text with the master''s outermost limits and target (analytics input)'),
  ('step_use_v1', 1, 'executed step and unit', 'Step key and phase, unit and class, room, start and end, persons and consumed material lots of each executed step (analytics input)');

-- The analytics role's allow-list (kernel 1242): SELECT on each view and EXECUTE on the row function behind it.
select analytics.register_input('VIEW', 'report.batch_outcome_v1', 1, '6A-1', 'batch record',
  'The 6g batch outcomes: the runner polls their completion times for newly completed batches');
select analytics.register_input('VIEW', 'report.batch_fact_v1', 1, '6A-1', 'GMP batch record',
  'Batch number, product and strength, MBR version and family, record kind, review status, issue and completion times, released');
select analytics.register_input('VIEW', 'report.cpp_value_v1', 1, '6A-1', 'critical value (one per reading)',
  'Critical process parameters, IPC results, endpoints and critical calculations as decimal text, with the master''s outermost limits and target');
select analytics.register_input('VIEW', 'report.step_use_v1', 1, '6A-1', 'executed step and unit',
  'Step key and phase, unit and its class, room, start and end, persons, and the material lots its entries consumed');

select kernel.set_actor_context(null);

reset role;
