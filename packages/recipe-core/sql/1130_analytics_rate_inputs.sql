-- Phase 6A slice 6A-2: the inputs of the deviation-rate comparison (method RATE.DEVIATION; ADR 0020 point 3; draft
-- controls DI-51, DI-52; interfaces slice-6A-0-interfaces.md section 3; D-6A-10, D-6A-2-6 to D-6A-2-9).
--
-- Handbook: modules/analytics.md
--
-- The site's shifts are a platform setting under change control (area PLATFORM_SETTING, kernel 1195):
--   site.shift_boundaries   the shift names and their start times in site time, 'A=06:00,B=14:00,C=22:00' by default
--                           (D-6A-10). A value is a list of NAME=HH:MM with distinct names and strictly rising starts;
--                           a shift runs from its start to the next one's, the last past midnight to the first
--                           (EBMR-ANA-020 refuses any other value, on every insert of a value). The plan named it
--                           analytics.shift_boundaries; the shift pattern is a site fact, and a routine outside the
--                           analytics schema that names "analytics." would fall foul of the DI-51 dependency proof
--                           (D-6A-2-7).
--   report.shift_of(t)      the shift an instant falls in (site zone: the policy site.zone).
--
-- Two report views, built as the 6A-1 views are (recipe-core 1115: a row function, SQL, STABLE, SECURITY DEFINER, owned
-- by ebmr_owner, so a reader needs no right on the tables behind it; read_at and data_as_of on every row):
--   report.deviation_fact_v1  one row per deviation linked to a GMP batch record (a BATCH link, or a CONTAINER link of the
--                             batch; not a cancelled deviation) and attribution: the step it is attributed to (the
--                             step at which an exception of the batch was raised that the deviation was linked or
--                             escalated to), that step's unit and room (report.step_use_v1) and each material lot the
--                             step consumed with its supplier, and the shift it falls in (the exception's time, else the
--                             deviation's). A deviation linked to the batch only has no step, unit, room or lot
--                             (unattributed for those groupings, D-6A-10); every row has its shift.
--   report.step_shift_v1      one row per executed step of a GMP batch record with the shift it started in (the batches a
--                             shift is exposed to).
-- Both are registered on the analytics role's allow-list (kernel 1242 analytics.register_input) and in the report
-- catalogue with SELECT to the reporting and application roles (D-6A-1-5). They write nothing and decide nothing;
-- nothing here reads the analytics schema (DI-51).

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 1130_analytics_rate_inputs)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the deviation-rate inputs of the analytics: deviation facts, step shifts and the site shifts setting (DI-51, DI-52)'));

-- ---------------------------------------------------------------------------------------------
-- The site's shifts
-- ---------------------------------------------------------------------------------------------

-- NULL when p_value is a valid shift list, else why not.
create function report.shift_boundaries_problem(p_value text) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_item  text;
  v_names text[] := '{}';
  v_prev  time;
  v_start time;
begin
  if p_value is null or p_value !~ '^[A-Z][A-Z0-9]{0,7}=([01][0-9]|2[0-3]):[0-5][0-9](,[A-Z][A-Z0-9]{0,7}=([01][0-9]|2[0-3]):[0-5][0-9]){0,7}$' then
    return 'a list of NAME=HH:MM separated by commas (one to eight shifts, names of capital letters and digits)';
  end if;
  foreach v_item in array pg_catalog.string_to_array(p_value, ',') loop
    v_start := pg_catalog.split_part(v_item, '=', 2)::time;
    if pg_catalog.split_part(v_item, '=', 1) = any (v_names) then
      return format('the shift %s is named twice', pg_catalog.split_part(v_item, '=', 1));
    end if;
    if v_prev is not null and v_start <= v_prev then
      return format('the starts must rise strictly through the day (%s after %s)', v_start, v_prev);
    end if;
    v_names := v_names || pg_catalog.split_part(v_item, '=', 1);
    v_prev := v_start;
  end loop;
  return null;
end
$$;
revoke all on function report.shift_boundaries_problem(text) from public;

insert into platform.setting_definition (key, value_type, default_value, min_value, max_value, allowed_values, max_scale, unit, description, basis) values
  ('site.shift_boundaries', 'TEXT', 'A=06:00,B=14:00,C=22:00', null, null, null, null, null,
   'The site''s shifts: each name with its start in site time (NAME=HH:MM, comma-separated, rising); a shift runs to the next start, the last past midnight',
   'Phase 6A D-6A-10: deviation rates by shift (advisory analytics); default three shifts A, B and C from 06:00, 14:00 and 22:00');

create function report.check_shift_boundaries() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  v_problem text;
begin
  if new.key = 'site.shift_boundaries' then
    v_problem := report.shift_boundaries_problem(new.value);
    if v_problem is not null then
      raise exception using errcode = 'P0001', message = format('EBMR-ANA-020 the setting site.shift_boundaries must be %s; %s is refused', v_problem, new.value);
    end if;
  end if;
  return new;
end
$$;
revoke all on function report.check_shift_boundaries() from public;
create trigger b20_shift_boundaries_check before insert on platform.setting_value for each row execute function report.check_shift_boundaries();

-- The shift an instant falls in, at the site's zone and its shift setting; NULL for NULL.
create function report.shift_of(p_at timestamptz) returns text
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with b as (
    select pg_catalog.split_part(x, '=', 1) as name, pg_catalog.split_part(x, '=', 2)::time as start
      from pg_catalog.unnest(pg_catalog.string_to_array(platform.setting_text('site.shift_boundaries'), ',')) x),
  t as (select (p_at at time zone iam.policy_text('site.zone'))::time as local)
  select coalesce((select b.name from b, t where b.start <= t.local order by b.start desc limit 1),
                  (select b.name from b order by b.start desc limit 1))
   where p_at is not null
$$;
revoke all on function report.shift_of(timestamptz) from public;

-- ---------------------------------------------------------------------------------------------
-- The views
-- ---------------------------------------------------------------------------------------------

create function report.deviation_fact_rows_v1()
returns table (deviation_id uuid, deviation_ref text, deviation_kind text, classification text, raised_at timestamptz, batch_id uuid, batch_number text,
               step text, equipment_code text, room_code text, material_lot text, supplier_code text, shift text, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, recipe, site, report, pg_temp as $$
  with l as (
    select distinct d.id, d.ref, d.kind, d.classification, d.raised_at, x.id as batch_id, x.batch_number
      from site.deviation d
      join site.deviation_link k on k.deviation_id = d.id
      join recipe.batch_execution x on x.id = k.batch_id
     where x.installation = 'GMP' and x.purpose = 'GMP_BATCH'
       and not exists (select 1 from site.deviation_event e where e.deviation_id = d.id and e.event = 'CANCELLED')),
  s as (
    select a.batch_id, a.deviation_ref, r.raising_step_key as step, min(r.raised_at) as at
      from recipe.exception_register_act a
      join recipe.exception_register r on r.batch_id = a.batch_id and r.exception_id = a.exception_id
     where a.act in ('DEVIATION_LINKED', 'ESCALATED') and r.raising_step_key is not null
     group by a.batch_id, a.deviation_ref, r.raising_step_key),
  u as (select * from report.step_use_rows_v1()),
  a as (select l.*, s.step, s.at from l left join s on s.batch_id = l.batch_id and s.deviation_ref = l.ref)
  select a.id, a.ref, a.kind, a.classification, a.raised_at, a.batch_id, a.batch_number, a.step, u.equipment_code, u.room_code,
         m ->> 'lot', m ->> 'supplier', report.shift_of(coalesce(a.at, a.raised_at)), pg_catalog.statement_timestamp(), report.data_as_of()
    from a
    left join u on u.batch_id = a.batch_id and u.step = a.step
    left join lateral pg_catalog.jsonb_array_elements(coalesce(u.material_lots, '[]'::jsonb)) m on true
   order by a.raised_at, a.ref, a.batch_number, a.step nulls first, u.equipment_code nulls first, m ->> 'lot' nulls first
$$;

create function report.step_shift_rows_v1()
returns table (batch_id uuid, batch_number text, step text, started_at timestamptz, shift text, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, report, pg_temp as $$
  select distinct on (u.batch_id, u.step) u.batch_id, u.batch_number, u.step, u.started_at, report.shift_of(u.started_at),
         pg_catalog.statement_timestamp(), report.data_as_of()
    from report.step_use_rows_v1() u
   order by u.batch_id, u.step, u.started_at
$$;

revoke all on function report.deviation_fact_rows_v1(), report.step_shift_rows_v1() from public;

create view report.deviation_fact_v1 as select * from report.deviation_fact_rows_v1();
create view report.step_shift_v1 as select * from report.step_shift_rows_v1();
revoke all on report.deviation_fact_v1, report.step_shift_v1 from public;
grant execute on function report.deviation_fact_rows_v1(), report.step_shift_rows_v1() to ebmr_app, ebmr_report;
grant select on report.deviation_fact_v1, report.step_shift_v1 to ebmr_app, ebmr_report;
insert into report.view_registry (view_name, version, grain, description) values
  ('deviation_fact_v1', 1, 'deviation link and attribution', 'Deviations linked to GMP batch records with the step, unit, room, material lot and supplier they are attributed to and the shift they fall in (analytics input)'),
  ('step_shift_v1', 1, 'executed step', 'The shift each executed step of a GMP batch record started in (analytics input)');

select analytics.register_input('VIEW', 'report.deviation_fact_v1', 1, '6A-2', 'deviation link and attribution',
  'Deviations linked to GMP batch records, attributed to step, unit, room, material lot and supplier, with their shift');
select analytics.register_input('VIEW', 'report.step_shift_v1', 1, '6A-2', 'executed step',
  'The shift each executed step of a GMP batch record started in');

select kernel.set_actor_context(null);

reset role;
