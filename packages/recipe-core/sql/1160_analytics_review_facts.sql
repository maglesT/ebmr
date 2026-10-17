-- Phase 6A slice 6A-5: the review facts the review-priority method reads (decision 0016 item 9; draft controls PR-61,
-- DI-51; interfaces slice-6A-0-interfaces.md section 3; D-6A-13, D-6A-14, D-6A-5-1 to D-6A-5-6).
--
-- Handbook: modules/analytics.md
--
-- One view in the schema report, selecting from its STABLE SECURITY DEFINER row function as recipe-core 1070, 1115 and
-- 1130 build them. Every row carries read_at and data_as_of. The view writes nothing and decides nothing, and it does not
-- read the analytics schema (DI-51): the score is computed by the method REVIEW.PRIORITY in the analytics runner from
-- this view and the other catalogued inputs, and recorded as an advisory output.
--
--   report.review_fact_v1   one row per GMP batch record in the review queue (execution status EXECUTION_COMPLETE or
--                           ABORTED) that still awaits its QA review, or whose QA review of the current cycle was signed
--                           within the last 30 days (so its outcome is stored with a last score; D-6A-5-2):
--                             batch, number, product code and strength, MBR family, record kind, execution status,
--                             review state and cycle, ended_at (when it reached EXECUTION_COMPLETE or ABORTED);
--                             exceptions_critical, _major, _minor: its exception register rows by severity, CRITICAL,
--                               ACTION and ALERT (D-6A-5-1);
--                             corrections: its accepted CORRECT_ENTRY, VOID_ATTEMPT and INVALIDATE_RESULT commands (the
--                               post-entry corrections, as D-6A-4-1 counts them);
--                             deviations: the deviations linked to it, cancelled ones left out (as recipe-core 1130);
--                             new_operator, new_operators: a person who performed, entered or corrected a step of this
--                               record has no step on an earlier GMP record of the same product (D-6A-5-3);
--                             new_equipment, new_equipment_codes: a unit it ran on has no earlier GMP use, or was
--                               qualified, had maintenance ended, was repaired, or had a CMMS work order completed in
--                               the 7 days before its use here (D-6A-5-3);
--                             review_findings, review_reopenings: the review outcome so far, the exceptions QA queried
--                               or escalated and the reopens of the review (kept for learned weights later; D-6A-20).
--                           No person is named: the operator term is a count, and the equipment codes are units.
--
-- It is registered on the analytics role's allow-list (kernel 1242 analytics.register_input) and in the report
-- catalogue (report.view_registry) with SELECT to the reporting and application roles, as the 6A-1 views are (D-6A-1-5).

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1160_analytics_review_facts)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the analytics review facts v1: what the review priority reads (PR-61, DI-51)'));

-- When a GMP batch record reached EXECUTION_COMPLETE or ABORTED (the first such status change), or null.
create function report.review_ended_at(p_batch uuid) returns timestamptz
language sql stable security definer set search_path = pg_catalog, recipe, report, pg_temp as $$
  select report.us_at(min(c.now_us))
    from recipe.execution_event e
    join recipe.execution_command c on c.batch_id = e.batch_id and c.seq = e.row_seq
   where e.batch_id = p_batch and e.event_type = 'BATCH_STATUS_CHANGED' and e.event ->> 'to' in ('EXECUTION_COMPLETE', 'ABORTED')
$$;
revoke all on function report.review_ended_at(uuid) from public;

-- The batch records the review facts cover: in the queue, awaiting QA review, or QA reviewed in the last 30 days.
create function report.review_fact_batches() returns table (batch_id uuid, review_state text, cycle integer)
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select x.id, recipe.batch_review_state(x.id), recipe.batch_review_cycle(x.id)
    from recipe.batch_execution x
    join recipe.execution_state s on s.batch_id = x.id
   where x.installation = 'GMP' and x.purpose = 'GMP_BATCH' and s.status in ('EXECUTION_COMPLETE', 'ABORTED')
     and (recipe.batch_review_state(x.id) <> 'QA_REVIEWED'
          or exists (select 1 from recipe.batch_review_act a
                      where a.batch_id = x.id and a.cycle = recipe.batch_review_cycle(x.id) and a.act = 'QA_REVIEWED'
                        and a.recorded_at >= pg_catalog.statement_timestamp() - interval '30 days'))
$$;
revoke all on function report.review_fact_batches() from public;

-- The persons new to a product and the units new or recently maintained, per batch record (D-6A-5-3).
create function report.review_novelty() returns table (batch_id uuid, new_operators integer, new_equipment_codes text[])
language sql stable security definer set search_path = pg_catalog, recipe, plant, report, pg_temp as $$
  with u as (
    select r.batch_id, recipe.batch_product(r.batch_id) ->> 'code' as product, r.started_at, r.equipment_code, r.person_ids
      from report.step_use_rows_v1() r),
  pf as (
    -- Each person's first step on each product, and the record it was in.
    select distinct on (u.product, p.person) u.product, p.person, u.batch_id
      from u cross join lateral pg_catalog.unnest(u.person_ids) p(person)
     where u.product is not null
     order by u.product, p.person, u.started_at, u.batch_id),
  ef as (
    -- Each unit's first use in a GMP record.
    select distinct on (u.equipment_code) u.equipment_code, u.batch_id
      from u where u.equipment_code is not null
     order by u.equipment_code, u.started_at, u.batch_id),
  maintained as (
    -- A unit qualified, maintained, repaired or with a CMMS work order completed in the 7 days before its use here.
    select distinct u.batch_id, u.equipment_code
      from u join plant.equipment e on e.code = u.equipment_code
     where exists (select 1 from plant.equipment_event v
                    where v.equipment_id = e.id and v.kind in ('QUALIFIED', 'MAINTENANCE_ENDED', 'REPAIRED')
                      and v.recorded_at <= u.started_at and v.recorded_at > u.started_at - interval '7 days')
        or exists (select 1 from plant.cmms_work_order w
                    where w.equipment_id = e.id and w.status = 'COMPLETED'
                      and w.source_timestamp <= u.started_at and w.source_timestamp > u.started_at - interval '7 days')),
  eq as (
    select ef.batch_id, ef.equipment_code from ef
    union
    select m.batch_id, m.equipment_code from maintained m)
  select b.batch_id,
         (select count(*)::integer from pf where pf.batch_id = b.batch_id),
         coalesce((select array_agg(eq.equipment_code order by eq.equipment_code) from eq where eq.batch_id = b.batch_id), '{}'::text[])
    from report.review_fact_batches() b
$$;
revoke all on function report.review_novelty() from public;

create function report.review_fact_rows_v1()
returns table (batch_id uuid, batch_number text, product_code text, strength text, family_code text, record_kind text, status text, review_state text,
               cycle integer, ended_at timestamptz, exceptions_critical integer, exceptions_major integer, exceptions_minor integer, corrections integer,
               deviations integer, new_operator boolean, new_operators integer, new_equipment boolean, new_equipment_codes text[], review_findings integer,
               review_reopenings integer, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, site, report, pg_temp as $$
  with b as (select * from report.review_fact_batches()),
  n as (select * from report.review_novelty())
  select x.id, x.batch_number, recipe.batch_product(x.id) ->> 'code', recipe.batch_product(x.id) ->> 'strength', f.code, recipe.batch_record_kind(x.id),
         s.status, b.review_state, b.cycle, report.review_ended_at(x.id),
         (select count(*)::integer from recipe.exception_register r where r.batch_id = x.id and r.severity = 'CRITICAL'),
         (select count(*)::integer from recipe.exception_register r where r.batch_id = x.id and r.severity = 'ACTION'),
         (select count(*)::integer from recipe.exception_register r where r.batch_id = x.id and r.severity = 'ALERT'),
         (select count(*)::integer from recipe.execution_command c
           where c.batch_id = x.id and c.accepted and c.command_type in ('CORRECT_ENTRY', 'VOID_ATTEMPT', 'INVALIDATE_RESULT')),
         (select count(distinct d.id)::integer from site.deviation d join site.deviation_link k on k.deviation_id = d.id
           where k.batch_id = x.id and not exists (select 1 from site.deviation_event e where e.deviation_id = d.id and e.event = 'CANCELLED')),
         coalesce(n.new_operators, 0) > 0, coalesce(n.new_operators, 0),
         pg_catalog.cardinality(coalesce(n.new_equipment_codes, '{}'::text[])) > 0, coalesce(n.new_equipment_codes, '{}'::text[]),
         (select count(distinct a.exception_id)::integer from recipe.exception_register_act a where a.batch_id = x.id and a.act in ('QUERIED', 'ESCALATED')),
         (select count(*)::integer from recipe.batch_review_act a where a.batch_id = x.id and a.act = 'REOPENED'),
         pg_catalog.statement_timestamp(), report.data_as_of()
    from b
    join recipe.batch_execution x on x.id = b.batch_id
    join recipe.execution_state s on s.batch_id = x.id
    left join n on n.batch_id = x.id
    left join recipe.mbr_version v on v.id = report.batch_version(x.id)
    left join recipe.mbr_family f on f.id = v.family_id
   order by report.review_ended_at(x.id) nulls last, x.batch_number
$$;
revoke all on function report.review_fact_rows_v1() from public;

create view report.review_fact_v1 as select * from report.review_fact_rows_v1();
revoke all on report.review_fact_v1 from public;
-- A report view like the 6A-1 ones: the reporting role and the dashboards' documented export read it too (D-6A-1-5).
grant execute on function report.review_fact_rows_v1() to ebmr_app, ebmr_report;
grant select on report.review_fact_v1 to ebmr_app, ebmr_report;
insert into report.view_registry (view_name, version, grain, description) values
  ('review_fact_v1', 1, 'GMP batch record in review', 'Exceptions by severity, corrections, linked deviations, new operators and units, and the review outcome of each GMP batch record awaiting or just past QA review (analytics input)');

-- The analytics role's allow-list (kernel 1242): SELECT on the view and EXECUTE on the row function behind it.
select analytics.register_input('VIEW', 'report.review_fact_v1', 1, '6A-5', 'GMP batch record in review',
  'Exceptions by severity, corrections, linked deviations, new operators and units, and the review outcome of each GMP batch record in the review queue');

select kernel.set_actor_context(null);

reset role;
