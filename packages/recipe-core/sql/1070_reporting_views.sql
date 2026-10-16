-- Phase 6 slice 6g: the reporting views (outline 7.3 dashboards; decisions 0015, 0016 "left ready for the analytics
-- work"; PR-05 overdue reviews, DI-49 alarm trend; D-P6g-0-1 to 7).
--
-- Handbook: modules/recipe-core.md
--
-- Versioned, read-only views in the schema report (kernel 1210). Each view report.<name>_v1 selects from its row
-- function report.<name>_rows_v1(): SQL, STABLE, SECURITY DEFINER, owned by ebmr_owner, so the reporting role
-- ebmr_report and the application role (the dashboards) read the rows without any right on the recipe, site or plant
-- tables and functions behind them. Every row carries read_at (the statement time of the read) and data_as_of
-- (report.data_as_of(): the transaction time on a primary, the last replayed commit on a replica).
--
--   batch_outcome_v1      one row per batch record: status, completion, QA review, review cycles, exceptions in the
--                         register, deviations linked, right first time (D-P6g-0-4)
--   exception_v1          one row per register exception (the exception Pareto)
--   deviation_ageing_v1   one row per deviation: state, closure and age in whole days (D-P6g-0-5)
--   hold_time_risk_v1     one row per closed output container: its disposition, the bright-stock maximum hold and the
--                         hours held, as decimal text (D-P6g-0-5)
--   overdue_review_v1     recipe.overdue_reviews(): APPROVED MBR versions past their periodic review (PR-05)
--   press_counter_v1      one row per press (equipment with a tablet.count series) and batch: the window of its state
--                         events, the RUNNING seconds, and the
--                         tablet.count and reject.count deltas from the native series (D-P6g-0-6)
--   alarm_v1              one row per plant alarm: code, source time, acknowledgment and the batches bound (DI-49)
--
-- The views write nothing and decide nothing: dashboards are never used for GMP decisions (outline 7.3).

set local role ebmr_owner;

-- The version of a batch record's MBR: its control recipe (GMP issue), else its pin.
create function report.batch_version(p_batch uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select coalesce((select cr.version_id from recipe.batch_execution b join recipe.control_recipe cr on cr.id = b.control_recipe_id where b.id = p_batch),
                  (select p.version_id from recipe.batch_mbr_pin p where p.batch_id = p_batch order by p.recorded_at desc limit 1))
$$;
revoke all on function report.batch_version(uuid) from public;

-- Microseconds since the epoch as a timestamptz.
create function report.us_at(p_us bigint) returns timestamptz
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select pg_catalog.to_timestamp(p_us::numeric / 1000000)
$$;
revoke all on function report.us_at(bigint) from public;

create function report.batch_outcome_rows_v1()
returns table (batch_id uuid, batch_number text, product_code text, strength text, record_kind text, status text, issued_at timestamptz,
               completed_at timestamptz, qa_reviewed_at timestamptz, review_cycles integer, exception_count integer, deviation_count integer,
               right_first_time boolean, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, site, report, pg_temp as $$
  with b as (
    select x.id, x.batch_number, x.issued_at, recipe.batch_product(x.id) as product, recipe.batch_record_kind(x.id) as record_kind,
           recipe.batch_review_state(x.id) as status,
           (select report.us_at(min(c.now_us)) from recipe.execution_event e join recipe.execution_command c on c.batch_id = e.batch_id and c.seq = e.row_seq
             where e.batch_id = x.id and e.event_type = 'BATCH_STATUS_CHANGED' and e.event ->> 'to' = 'EXECUTION_COMPLETE') as completed_at,
           (select max(a.recorded_at) from recipe.batch_review_act a where a.batch_id = x.id and a.act = 'QA_REVIEWED') as qa_reviewed_at,
           coalesce((select max(a.cycle) from recipe.batch_review_act a where a.batch_id = x.id), 0) as review_cycles,
           exists (select 1 from recipe.batch_review_act a where a.batch_id = x.id and a.act = 'REOPENED') as reopened,
           (select count(*) from recipe.exception_register r where r.batch_id = x.id)::integer as exception_count,
           (select count(distinct k.deviation_id) from site.deviation_link k where k.batch_id = x.id)::integer as deviation_count
      from recipe.batch_execution x
  )
  select b.id, b.batch_number, b.product ->> 'code', b.product ->> 'strength', b.record_kind, b.status, b.issued_at, b.completed_at,
         b.qa_reviewed_at, b.review_cycles, b.exception_count, b.deviation_count,
         b.status = 'QA_REVIEWED' and not b.reopened and b.exception_count = 0 and b.deviation_count = 0,
         pg_catalog.statement_timestamp(), report.data_as_of()
    from b
   order by b.issued_at, b.batch_number
$$;

create function report.exception_rows_v1()
returns table (batch_id uuid, batch_number text, exception_id text, exception_type text, category text, severity text, raised_at timestamptz,
               read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, report, pg_temp as $$
  select r.batch_id, b.batch_number, r.exception_id, r.exception_type, r.category, r.severity, r.raised_at,
         pg_catalog.statement_timestamp(), report.data_as_of()
    from recipe.exception_register r join recipe.batch_execution b on b.id = r.batch_id
   order by r.raised_at, r.batch_id, r.exception_id
$$;

create function report.deviation_ageing_rows_v1()
returns table (deviation_id uuid, ref text, kind text, classification text, state text, raised_at timestamptz, closed_at timestamptz,
               age_days integer, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, site, report, pg_temp as $$
  select d.id, d.ref, d.kind, d.classification, site.deviation_state(d.id), d.raised_at, x.closed_at,
         floor(extract(epoch from coalesce(x.closed_at, pg_catalog.statement_timestamp()) - d.raised_at) / 86400)::integer,
         pg_catalog.statement_timestamp(), report.data_as_of()
    from site.deviation d
    left join lateral (select min(e.recorded_at) as closed_at from site.deviation_event e
                        where e.deviation_id = d.id and e.event in ('CLOSED', 'CANCELLED')) x on true
   order by d.raised_at, d.ref
$$;

create function report.hold_time_risk_rows_v1()
returns table (container_id uuid, label_code text, batch_id uuid, batch_number text, product_code text, strength text, disposition text,
               closed_at timestamptz, max_hold_hours integer, held_hours text, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, plant, report, pg_temp as $$
  select c.id, c.label_code, c.batch_id, c.batch_number, c.product_code, c.strength, recipe.bulk_container_disposition(c.id), x.closed_at,
         recipe.bright_stock_max_hold_of(c.product_code, c.strength),
         round(extract(epoch from pg_catalog.statement_timestamp() - x.closed_at) / 3600, 2)::text,
         pg_catalog.statement_timestamp(), report.data_as_of()
    from plant.output_container c
    cross join lateral (select plant.container_closed_at(c.id) as closed_at) x
   where x.closed_at is not null
   order by x.closed_at, c.label_code
$$;

create function report.overdue_review_rows_v1()
returns table (version_id uuid, family_code text, version_number integer, document_id text, review_due date, days_overdue integer,
               last_review_at timestamptz, in_use boolean, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, report, pg_temp as $$
  select o.version_id, o.family_code, o.version_number, o.document_id, o.review_due, o.days_overdue, o.last_review_at, o.in_use,
         pg_catalog.statement_timestamp(), report.data_as_of()
    from recipe.overdue_reviews(null) o
$$;

create function report.press_counter_rows_v1()
returns table (equipment_id uuid, equipment_code text, batch_id uuid, batch_number text, first_event_at timestamptz, last_event_at timestamptz,
               running_seconds text, observed_seconds text, tablets text, rejects text, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, plant, recipe, report, pg_temp as $$
  with ev as (
    select e.equipment_id, e.batch_id, e.occurred_source_us as us, e.state,
           lead(e.occurred_source_us) over (partition by e.equipment_id, e.batch_id order by e.occurred_source_us, e.id) as next_us
      from plant.equipment_state_event e
     where e.kind = 'STATE_CHANGED' and e.batch_id is not null
       and exists (select 1 from plant.series x where x.equipment_id = e.equipment_id and x.tag = 'tablet.count')
  ), w as (
    select ev.equipment_id, ev.batch_id, min(ev.us) as first_us, max(ev.us) as last_us,
           sum(case when ev.state = 'RUNNING' and ev.next_us is not null then ev.next_us - ev.us else 0 end) as running_us
      from ev group by ev.equipment_id, ev.batch_id
  )
  select w.equipment_id, q.code, w.batch_id, b.batch_number, report.us_at(w.first_us), report.us_at(w.last_us),
         round(w.running_us::numeric / 1000000, 3)::text, round((w.last_us - w.first_us)::numeric / 1000000, 3)::text,
         (select (max((s ->> 'value')::numeric) - min((s ->> 'value')::numeric))::text
            from plant.series x cross join lateral jsonb_array_elements(x.samples) s
           where x.equipment_id = w.equipment_id and x.tag = 'tablet.count' and s ->> 'value' is not null
             and (s ->> 'sourceTime')::bigint between w.first_us and w.last_us),
         (select (max((s ->> 'value')::numeric) - min((s ->> 'value')::numeric))::text
            from plant.series x cross join lateral jsonb_array_elements(x.samples) s
           where x.equipment_id = w.equipment_id and x.tag = 'reject.count' and s ->> 'value' is not null
             and (s ->> 'sourceTime')::bigint between w.first_us and w.last_us),
         pg_catalog.statement_timestamp(), report.data_as_of()
    from w join plant.equipment q on q.id = w.equipment_id join recipe.batch_execution b on b.id = w.batch_id
   order by w.first_us, q.code
$$;

create function report.alarm_rows_v1()
returns table (alarm_id uuid, source text, alarm_code text, gmp_critical boolean, subject_kind text, subject_code text, raised_at timestamptz,
               received_at timestamptz, acked_at timestamptz, batch_count integer, batch_numbers text[], read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, plant, recipe, report, pg_temp as $$
  select a.id, a.source, a.alarm_code, a.gmp_critical, a.subject_kind,
         coalesce((select q.code from plant.equipment q where q.id = a.equipment_id), (select r.code from plant.area r where r.id = a.area_id)),
         report.us_at(a.raised_source_us), a.received_at, k.acked_at,
         (select count(*) from plant.alarm_batch ab where ab.alarm_id = a.id)::integer,
         coalesce((select array_agg(b.batch_number order by b.batch_number) from plant.alarm_batch ab join recipe.batch_execution b on b.id = ab.batch_id
                    where ab.alarm_id = a.id), '{}'),
         pg_catalog.statement_timestamp(), report.data_as_of()
    from plant.alarm a left join plant.alarm_ack k on k.alarm_id = a.id
   order by a.raised_source_us, a.id
$$;

revoke all on function report.batch_outcome_rows_v1(), report.exception_rows_v1(), report.deviation_ageing_rows_v1(), report.hold_time_risk_rows_v1(),
                       report.overdue_review_rows_v1(), report.press_counter_rows_v1(), report.alarm_rows_v1() from public;
grant execute on function report.batch_outcome_rows_v1(), report.exception_rows_v1(), report.deviation_ageing_rows_v1(), report.hold_time_risk_rows_v1(),
                          report.overdue_review_rows_v1(), report.press_counter_rows_v1(), report.alarm_rows_v1() to ebmr_app, ebmr_report;

create view report.batch_outcome_v1 as select * from report.batch_outcome_rows_v1();
create view report.exception_v1 as select * from report.exception_rows_v1();
create view report.deviation_ageing_v1 as select * from report.deviation_ageing_rows_v1();
create view report.hold_time_risk_v1 as select * from report.hold_time_risk_rows_v1();
create view report.overdue_review_v1 as select * from report.overdue_review_rows_v1();
create view report.press_counter_v1 as select * from report.press_counter_rows_v1();
create view report.alarm_v1 as select * from report.alarm_rows_v1();
revoke all on report.batch_outcome_v1, report.exception_v1, report.deviation_ageing_v1, report.hold_time_risk_v1, report.overdue_review_v1,
              report.press_counter_v1, report.alarm_v1 from public;
grant select on report.batch_outcome_v1, report.exception_v1, report.deviation_ageing_v1, report.hold_time_risk_v1, report.overdue_review_v1,
                report.press_counter_v1, report.alarm_v1 to ebmr_app, ebmr_report;

insert into report.view_registry (view_name, version, grain, description) values
  ('batch_outcome_v1', 1, 'batch record', 'Status, completion, QA review, review cycles, register exceptions, linked deviations and right first time of each batch record'),
  ('exception_v1', 1, 'register exception', 'Every exception in the batch exception register, with its type, category, severity and time'),
  ('deviation_ageing_v1', 1, 'deviation', 'Every deviation with its state, closure and age in whole days'),
  ('hold_time_risk_v1', 1, 'closed output container', 'Closed output containers with their disposition, bright-stock maximum hold and hours held'),
  ('overdue_review_v1', 1, 'MBR version', 'Approved MBR versions past their periodic review date (PR-05)'),
  ('press_counter_v1', 1, 'press and batch', 'RUNNING time and tablet and reject counter deltas of each press per batch, from its state events and native series'),
  ('alarm_v1', 1, 'plant alarm', 'Every plant alarm with its code, source time, acknowledgment and the batches it is bound to (DI-49)');

reset role;
