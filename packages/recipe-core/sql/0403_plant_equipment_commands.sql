-- Plant, part 4: master data, equipment fitness, instruments, utilities, campaigns, cleaning and the PROCESS equipment
-- use guard (outline 5.2.8; Phase 3 slice 1 plan item 2).
--
-- Controls: INV-12 and IN-25 (b)(c)(d), PR-23 (use only clean at the required level within the clean-hold, qualified,
-- calibration valid for the planned interval, idle; instruments: calibration and a passing check, no occupancy;
-- utilities: latest feed status OK; a failure signalled from a step removes the unit from use until repaired);
-- IN-26 (a), PR-27 (a MINOR cleaning is enough only for the same product inside an open campaign within its maximum
-- batches and days, with a validation reference); S22 (manual cleaning: performer and a different verifier who signs;
-- validated CIP: one verifier). Default D-S1-5: crossing the clean-hold or the calibration due instant during a use is
-- recorded on the use row when it ends.
--
-- Every app-callable writer is SECURITY DEFINER, refuses administrators (DI-18) and then checks a catalogued
-- permission (DI-17):
--   define_product, define_equipment_class, define_area, define_equipment, open_campaign, close_campaign
--                                                           MASTERDATA.CHANGE
--   record_equipment_event  QUALIFIED / QUALIFICATION_WITHDRAWN / RETIRED: MASTERDATA.CHANGE;
--                           FAILURE_SIGNALLED: STEP.EXECUTE; the others: LOGBOOK.ENTRY
--   record_calibration                                      LOGBOOK.ENTRY
--   record_instrument_check, record_instrument_use          STEP.EXECUTE
--   record_utility_reading                                  INTERFACE.WRITE (the feed's service account)
--   start_cleaning, complete_cleaning, abandon_cleaning     LOGBOOK.ENTRY (abandon: with the person's own reason)
--   verify_cleaning                                         LOGBOOK.SIGN (+ signature LOGBOOK_DOUBLE_CHECKED)
--   start_equipment_use, end_equipment_use                  STEP.EXECUTE

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------------------------

create function plant.fail(p_message text) returns void
language plpgsql volatile set search_path = pg_catalog, pg_temp as $$
begin
  raise exception using errcode = 'P0001', message = p_message;
end
$$;

-- A transition of a plant aggregate at its current version, from a plant command.
create function plant.move(p_machine text, p_aggregate_type text, p_id uuid, p_event text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  v_version bigint;
begin
  select version into v_version from platform.aggregate_state where aggregate_type = p_aggregate_type and aggregate_id = p_id;
  return platform.transition(p_machine, p_aggregate_type, p_id, p_event, v_version, '{}'::jsonb);
end
$$;

create function plant.state_of(p_aggregate_type text, p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select state from platform.aggregate_state where aggregate_type = p_aggregate_type and aggregate_id = p_id
$$;

-- When the aggregate last entered its current state (state history, database clock).
create function plant.state_since(p_aggregate_type text, p_id uuid) returns timestamptz
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select h.recorded_at from platform.state_history h join platform.aggregate_state s
    on s.aggregate_type = h.aggregate_type and s.aggregate_id = h.aggregate_id and s.version = h.to_version
  where h.aggregate_type = p_aggregate_type and h.aggregate_id = p_id
$$;

create function plant.equipment_by_code(p_code text, p_lock boolean default false) returns plant.equipment
language plpgsql volatile security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  e plant.equipment;
begin
  if p_lock then
    select * into e from plant.equipment where code = p_code for update;
  else
    select * into e from plant.equipment where code = p_code;
  end if;
  if not found then
    perform plant.fail(format('Unknown equipment %s (EBMR-PLANT-010)', coalesce(p_code, 'NULL')));
  end if;
  return e;
end
$$;

create function plant.area_by_code(p_code text, p_lock boolean default false) returns plant.area
language plpgsql volatile security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  a plant.area;
begin
  if p_lock then
    select * into a from plant.area where code = p_code for update;
  else
    select * into a from plant.area where code = p_code;
  end if;
  if not found then
    perform plant.fail(format('Unknown room or line %s (EBMR-PLANT-011)', coalesce(p_code, 'NULL')));
  end if;
  return a;
end
$$;

create function plant.require_product(p_code text) returns plant.product
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  p plant.product;
begin
  select * into p from plant.product where code = p_code;
  if not found then
    perform plant.fail(format('Unknown product %s: define it in the plant product list first (EBMR-PLANT-012)', coalesce(p_code, 'NULL')));
  end if;
  return p;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Master data (MASTERDATA.CHANGE)
-- ---------------------------------------------------------------------------------------------

-- p_def: {code, name, highlyPotent}
create function plant.define_product(p_def jsonb) returns text
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MASTERDATA.CHANGE', jsonb_build_object('product', p_def ->> 'code'));
  if jsonb_typeof(p_def -> 'highlyPotent') is distinct from 'boolean' then
    perform plant.fail('A product states whether it is highly potent (IN-26 (c); EBMR-PLANT-001)');
  end if;
  insert into plant.product (code, name, highly_potent, recorded_by)
  values (p_def ->> 'code', p_def ->> 'name', (p_def ->> 'highlyPotent')::boolean, plant.actor_person());
  return p_def ->> 'code';
end
$$;

-- p_def: {code, kind, description, cleanHold, dirtyHold (interval text, PROCESS), calibrationRequired, checkRegime (INSTRUMENT)}
create function plant.define_equipment_class(p_def jsonb) returns text
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  insert into plant.equipment_class (code, kind, description, clean_hold, dirty_hold, calibration_required, check_regime, recorded_by)
  values (p_def ->> 'code', p_def ->> 'kind', p_def ->> 'description', (p_def ->> 'cleanHold')::interval, (p_def ->> 'dirtyHold')::interval,
          coalesce((p_def ->> 'calibrationRequired')::boolean, p_def ->> 'kind' = 'INSTRUMENT'), p_def ->> 'checkRegime', plant.actor_person());
  return p_def ->> 'code';
end
$$;

-- p_def: {code, kind ROOM|LINE, name, segregated, segregationJustification, negativePressure}
create function plant.define_area(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, platform, pg_temp as $$
declare
  v_id uuid := gen_random_uuid();
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  if coalesce((p_def ->> 'segregated')::boolean, false) and plant.is_blank(p_def ->> 'segregationJustification') then
    perform plant.fail('A segregated room needs its recorded risk justification (IN-26 (b); EBMR-PLANT-003)');
  end if;
  insert into plant.area (id, code, kind, name, segregated, segregation_justification, negative_pressure, recorded_by)
  values (v_id, p_def ->> 'code', p_def ->> 'kind', p_def ->> 'name', coalesce((p_def ->> 'segregated')::boolean, false),
          nullif(btrim(p_def ->> 'segregationJustification'), ''), coalesce((p_def ->> 'negativePressure')::boolean, false), plant.actor_person());
  perform platform.create_aggregate_state('area_status', 'plant_area', v_id);
  return v_id;
end
$$;

-- p_def: {code, name, classCode, areaCode}. PROCESS equipment starts DIRTY (cleaned and verified before first use).
create function plant.define_equipment(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, platform, pg_temp as $$
declare
  v_id   uuid := gen_random_uuid();
  v_kind text;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  select kind into v_kind from plant.equipment_class where code = p_def ->> 'classCode';
  if v_kind is null then
    perform plant.fail(format('Unknown equipment class %s (EBMR-PLANT-013)', coalesce(p_def ->> 'classCode', 'NULL')));
  end if;
  insert into plant.equipment (id, code, name, class_code, kind, area_id, recorded_by)
  values (v_id, p_def ->> 'code', p_def ->> 'name', p_def ->> 'classCode', v_kind,
          case when p_def ->> 'areaCode' is not null then (plant.area_by_code(p_def ->> 'areaCode')).id end, plant.actor_person());
  if v_kind = 'PROCESS' then
    perform platform.create_aggregate_state('equipment_cleanliness', 'plant_equipment', v_id);
  end if;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Fitness (computed): RETIRED, OUT_OF_SERVICE, MAINTENANCE, NOT_QUALIFIED, OUT_OF_TOLERANCE, CALIBRATION_OVERDUE,
-- CALIBRATION_DUE_SOON, QUALIFIED. Only the last two allow a use.
-- ---------------------------------------------------------------------------------------------

create function plant.latest_event_of(p_equipment uuid, p_kinds text[]) returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select kind from plant.equipment_event where equipment_id = p_equipment and kind = any (p_kinds)
  order by recorded_at desc, id desc limit 1
$$;

create function plant.latest_calibration(p_equipment uuid) returns plant.calibration
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select * from plant.calibration where equipment_id = p_equipment order by recorded_at desc, id desc limit 1
$$;

-- The instant until which the unit is calibrated: the due instant of its latest calibration when that one left it in
-- tolerance; NULL when it has none or was left out of tolerance.
create function plant.calibration_valid_until(p_equipment uuid) returns timestamptz
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select case when c.as_left = 'PASS' then c.due_at end from plant.latest_calibration(p_equipment) c
$$;

create function plant.equipment_fitness(p_equipment uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_cal   plant.calibration;
  v_req   boolean;
begin
  select k.calibration_required into v_req from plant.equipment e join plant.equipment_class k on k.code = e.class_code where e.id = p_equipment;
  if v_req is null then
    return null;
  end if;
  if plant.latest_event_of(p_equipment, array['RETIRED']) is not null then
    return 'RETIRED';
  end if;
  if plant.latest_event_of(p_equipment, array['TAKEN_OUT_OF_SERVICE', 'RETURNED_TO_SERVICE']) = 'TAKEN_OUT_OF_SERVICE'
     or plant.latest_event_of(p_equipment, array['FAILURE_SIGNALLED', 'REPAIRED']) = 'FAILURE_SIGNALLED' then
    return 'OUT_OF_SERVICE';
  end if;
  if plant.latest_event_of(p_equipment, array['MAINTENANCE_STARTED', 'MAINTENANCE_ENDED']) = 'MAINTENANCE_STARTED' then
    return 'MAINTENANCE';
  end if;
  if plant.latest_event_of(p_equipment, array['QUALIFIED', 'QUALIFICATION_WITHDRAWN']) is distinct from 'QUALIFIED' then
    return 'NOT_QUALIFIED';
  end if;
  if v_req then
    v_cal := plant.latest_calibration(p_equipment);
    if v_cal.id is null then
      return 'CALIBRATION_OVERDUE';
    elsif v_cal.as_left = 'FAIL' then
      return 'OUT_OF_TOLERANCE';
    elsif v_cal.due_at <= clock_timestamp() then
      return 'CALIBRATION_OVERDUE';
    elsif v_cal.due_at <= clock_timestamp() + interval '7 days' then
      return 'CALIBRATION_DUE_SOON';
    end if;
  end if;
  return 'QUALIFIED';
end
$$;

-- The problems that stop any use of the unit until p_planned_end: fitness and calibration cover (IN-25 (b)(d)).
create function plant.fitness_problems(p_equipment uuid, p_planned_end timestamptz) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_fit   text := plant.equipment_fitness(p_equipment);
  v_req   boolean;
  v_until timestamptz;
  v_out   text[] := '{}';
begin
  if v_fit not in ('QUALIFIED', 'CALIBRATION_DUE_SOON') then
    v_out := v_out || format('the unit is %s', v_fit);
  end if;
  select k.calibration_required into v_req from plant.equipment e join plant.equipment_class k on k.code = e.class_code where e.id = p_equipment;
  if v_req and v_fit not in ('OUT_OF_TOLERANCE', 'CALIBRATION_OVERDUE') then
    v_until := plant.calibration_valid_until(p_equipment);
    if v_until is null or v_until <= p_planned_end then
      v_out := v_out || format('its calibration is due at %s, before the planned end %s', recipe.utc_text(v_until), recipe.utc_text(p_planned_end));
    end if;
  end if;
  return v_out;
end
$$;

-- p_kind: QUALIFIED, QUALIFICATION_WITHDRAWN, MAINTENANCE_STARTED, MAINTENANCE_ENDED, TAKEN_OUT_OF_SERVICE,
-- RETURNED_TO_SERVICE, FAILURE_SIGNALLED (from a step, with the batch), REPAIRED, RETIRED.
create function plant.record_equipment_event(p_equipment_code text, p_kind text, p_detail text, p_reference text default null,
                                             p_batch_ref text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  e    plant.equipment;
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission(case when p_kind in ('QUALIFIED', 'QUALIFICATION_WITHDRAWN', 'RETIRED') then 'MASTERDATA.CHANGE'
                                      when p_kind = 'FAILURE_SIGNALLED' then 'STEP.EXECUTE'
                                      else 'LOGBOOK.ENTRY' end, '{}'::jsonb);
  e := plant.equipment_by_code(p_equipment_code, true);
  if plant.latest_event_of(e.id, array['RETIRED']) is not null then
    perform plant.fail(format('%s is retired; nothing more is recorded on it (EBMR-PLANT-020)', e.code));
  end if;
  if p_kind = 'REPAIRED' and plant.latest_event_of(e.id, array['FAILURE_SIGNALLED', 'REPAIRED']) is distinct from 'FAILURE_SIGNALLED' then
    perform plant.fail(format('%s has no open failure to repair (EBMR-PLANT-021)', e.code));
  end if;
  if p_kind = 'RETURNED_TO_SERVICE' and plant.latest_event_of(e.id, array['TAKEN_OUT_OF_SERVICE', 'RETURNED_TO_SERVICE']) is distinct from 'TAKEN_OUT_OF_SERVICE' then
    perform plant.fail(format('%s is not out of service (EBMR-PLANT-021)', e.code));
  end if;
  if p_kind = 'MAINTENANCE_ENDED' and plant.latest_event_of(e.id, array['MAINTENANCE_STARTED', 'MAINTENANCE_ENDED']) is distinct from 'MAINTENANCE_STARTED' then
    perform plant.fail(format('%s is not in maintenance (EBMR-PLANT-021)', e.code));
  end if;
  if p_kind = 'FAILURE_SIGNALLED' and plant.is_blank(p_batch_ref) then
    perform plant.fail('A failure signalled from a step names its batch (IN-25 (d); EBMR-PLANT-022)');
  end if;
  insert into plant.equipment_event (equipment_id, kind, reference, batch_ref, detail, person_id, account_id)
  values (e.id, p_kind, nullif(btrim(p_reference), ''), nullif(btrim(p_batch_ref), ''), p_detail, plant.actor_person(), plant.actor_account())
  returning id into v_id;
  return v_id;
end
$$;

create function plant.record_calibration(p_equipment_code text, p_due_at timestamptz, p_as_found text, p_as_left text, p_reference text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  e    plant.equipment;
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('LOGBOOK.ENTRY', '{}'::jsonb);
  e := plant.equipment_by_code(p_equipment_code, true);
  if not (select calibration_required from plant.equipment_class where code = e.class_code) then
    perform plant.fail(format('%s is of a class without calibration (EBMR-PLANT-023)', e.code));
  end if;
  if p_due_at is null or p_due_at <= clock_timestamp() then
    perform plant.fail('A calibration states a due instant in the future (EBMR-PLANT-024)');
  end if;
  insert into plant.calibration (equipment_id, due_at, as_found, as_left, reference, person_id, account_id)
  values (e.id, p_due_at, p_as_found, p_as_left, p_reference, plant.actor_person(), plant.actor_account())
  returning id into v_id;
  return v_id;
end
$$;

-- PR-23: an as-found failure lists every batch that used the unit since its last calibration found in tolerance.
create function plant.calibration_affected_batches(p_calibration uuid)
returns table (batch_ref text, product_code text, used_at timestamptz, use_kind text)
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  with c as (select * from plant.calibration where id = p_calibration and as_found = 'FAIL'),
  since as (select coalesce((select max(p.recorded_at) from plant.calibration p, c
                             where p.equipment_id = c.equipment_id and p.recorded_at < c.recorded_at and p.as_found = 'PASS'),
                            '-infinity'::timestamptz) as t)
  select u.batch_ref, u.product_code, u.started_at, 'PROCESS_USE' from plant.equipment_use u, c, since
  where u.equipment_id = c.equipment_id and u.started_at >= since.t and u.started_at < c.recorded_at
  union all
  select i.batch_ref, i.product_code, i.recorded_at, 'INSTRUMENT_USE' from plant.instrument_use i, c, since
  where i.equipment_id = c.equipment_id and i.recorded_at >= since.t and i.recorded_at < c.recorded_at
  order by 3, 1
$$;

-- ---------------------------------------------------------------------------------------------
-- Instruments: calibration plus a passing check; no occupancy (one tester serves two presses)
-- ---------------------------------------------------------------------------------------------

create function plant.record_instrument_check(p_equipment_code text, p_result text, p_reference text, p_batch_ref text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  e        plant.equipment;
  v_regime text;
  v_id     uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('STEP.EXECUTE', '{}'::jsonb);
  e := plant.equipment_by_code(p_equipment_code, true);
  if e.kind <> 'INSTRUMENT' then
    perform plant.fail(format('%s is %s equipment; checks are recorded for instruments (EBMR-PLANT-025)', e.code, e.kind));
  end if;
  select check_regime into v_regime from plant.equipment_class where code = e.class_code;
  insert into plant.instrument_check (equipment_id, regime, result, batch_ref, reference, person_id, account_id)
  values (e.id, v_regime, p_result, nullif(btrim(p_batch_ref), ''), p_reference, plant.actor_person(), plant.actor_account())
  returning id into v_id;
  return v_id;
end
$$;

-- What a use of the instrument for the batch until p_planned_end would rest on: {problems[], check_id, regime}.
create function plant.instrument_use_assessment(p_equipment uuid, p_batch_ref text, p_planned_end timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  v_regime   text;
  v_problems text[] := plant.fitness_problems(p_equipment, p_planned_end);
  v_last     plant.instrument_check;
  v_check    plant.instrument_check;
begin
  select k.check_regime into v_regime from plant.equipment e join plant.equipment_class k on k.code = e.class_code where e.id = p_equipment;
  select * into v_last from plant.instrument_check where equipment_id = p_equipment order by recorded_at desc, id desc limit 1;
  if v_last.id is not null and v_last.result = 'FAIL' then
    v_problems := v_problems || format('its latest check (%s) failed', v_last.reference);
  end if;
  if v_regime = 'DAILY' then
    select * into v_check from plant.instrument_check
    where equipment_id = p_equipment and regime = 'DAILY'
      and (recorded_at at time zone iam.policy_text('site.zone'))::date = recipe.site_today()
    order by recorded_at desc, id desc limit 1;
    if v_check.id is null or v_check.result <> 'PASS' then
      v_problems := v_problems || 'it has no passing daily check today'::text;
    end if;
  else
    select * into v_check from plant.instrument_check c
    where c.equipment_id = p_equipment and c.regime = 'PER_USE' and c.batch_ref = p_batch_ref
      and not exists (select 1 from plant.instrument_use u where u.check_id = c.id)
    order by c.recorded_at desc, c.id desc limit 1;
    if v_check.id is null or v_check.result <> 'PASS' then
      v_problems := v_problems || format('it has no unused passing check for batch %s', p_batch_ref);
    end if;
  end if;
  return jsonb_build_object('problems', to_jsonb(v_problems), 'regime', v_regime,
                            'check_id', case when v_check.result = 'PASS' then v_check.id end);
end
$$;

create function plant.record_instrument_use(p_equipment_code text, p_batch_ref text, p_product text, p_planned_end timestamptz) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  e    plant.equipment;
  v_a  jsonb;
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', p_product));
  e := plant.equipment_by_code(p_equipment_code, true);
  if e.kind <> 'INSTRUMENT' then
    perform plant.fail(format('%s is %s equipment, not an instrument (EBMR-PLANT-025)', e.code, e.kind));
  end if;
  perform plant.require_product(p_product);
  if p_planned_end is null or p_planned_end <= clock_timestamp() then
    perform plant.fail('A use states its planned end, in the future (EBMR-PLANT-060)');
  end if;
  v_a := plant.instrument_use_assessment(e.id, p_batch_ref, p_planned_end);
  if jsonb_array_length(v_a -> 'problems') > 0 then
    perform plant.fail(format('%s cannot be used for batch %s: %s (IN-25 (b), PR-23; EBMR-PLANT-061)', e.code, p_batch_ref,
                              (select string_agg(x, '; ') from jsonb_array_elements_text(v_a -> 'problems') x)));
  end if;
  insert into plant.instrument_use (equipment_id, batch_ref, product_code, regime, check_id, planned_end, person_id, account_id)
  values (e.id, p_batch_ref, p_product, v_a ->> 'regime', (v_a ->> 'check_id')::uuid, p_planned_end, plant.actor_person(), plant.actor_account())
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Utilities: status from the external feed; usable only while the latest feed status is OK
-- ---------------------------------------------------------------------------------------------

create function plant.record_utility_reading(p_equipment_code text, p_status text, p_source text, p_observed_at timestamptz) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  e    plant.equipment;
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  e := plant.equipment_by_code(p_equipment_code, true);
  if e.kind <> 'UTILITY' then
    perform plant.fail(format('%s is %s equipment; feed readings are recorded for utilities (EBMR-PLANT-026)', e.code, e.kind));
  end if;
  insert into plant.utility_reading (equipment_id, status, source, observed_at, person_id, account_id)
  values (e.id, p_status, p_source, p_observed_at, plant.actor_person(), plant.actor_account())
  returning id into v_id;
  return v_id;
end
$$;

create function plant.utility_problem(p_equipment_code text) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  e        plant.equipment;
  v_status text;
  v_fit    text;
begin
  select * into e from plant.equipment where code = p_equipment_code;
  if e.id is null or e.kind <> 'UTILITY' then
    return format('%s is not a utility', coalesce(p_equipment_code, 'NULL'));
  end if;
  v_fit := plant.equipment_fitness(e.id);
  if v_fit <> 'QUALIFIED' then
    return format('%s is %s', e.code, v_fit);
  end if;
  select status into v_status from plant.utility_reading where equipment_id = e.id order by recorded_at desc, id desc limit 1;
  if v_status is distinct from 'OK' then
    return format('the latest feed status of %s is %s', e.code, coalesce(v_status, 'missing'));
  end if;
  return null;
end
$$;

create function plant.assert_utility_usable(p_equipment_code text) returns void
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v text := plant.utility_problem(p_equipment_code);
begin
  if v is not null then
    perform plant.fail(format('The utility cannot be used: %s (IN-25 (b); EBMR-PLANT-027)', v));
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Campaigns (MASTERDATA.CHANGE): same product, minor cleaning between batches within max batches and max days
-- ---------------------------------------------------------------------------------------------

-- p_def: {equipmentCode | areaCode, product, maxBatches, maxDays, validationRef}
create function plant.open_campaign(p_def jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_eq   uuid;
  v_area uuid;
  v_id   uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MASTERDATA.CHANGE', jsonb_build_object('product', p_def ->> 'product'));
  if (p_def ? 'equipmentCode') = (p_def ? 'areaCode') then
    perform plant.fail('A campaign is opened on one PROCESS unit or one room (EBMR-PLANT-080)');
  end if;
  if p_def ? 'equipmentCode' then
    select id into v_eq from plant.equipment where code = p_def ->> 'equipmentCode' and kind = 'PROCESS' for update;
    if v_eq is null then
      perform plant.fail(format('%s is not PROCESS equipment (EBMR-PLANT-080)', p_def ->> 'equipmentCode'));
    end if;
  else
    v_area := (plant.area_by_code(p_def ->> 'areaCode', true)).id;
  end if;
  perform plant.require_product(p_def ->> 'product');
  if exists (select 1 from plant.campaign_status where closed_at is null and (equipment_id = v_eq or area_id = v_area)) then
    perform plant.fail('A unit or room has one open campaign at a time: close the open one first (EBMR-PLANT-080)');
  end if;
  if plant.is_blank(p_def ->> 'validationRef') then
    perform plant.fail('A campaign cites the validation of its cleaning interval (IN-26 (a), PR-27; EBMR-PLANT-081)');
  end if;
  insert into plant.campaign (equipment_id, area_id, product_code, max_batches, max_days, validation_ref, opened_by)
  values (v_eq, v_area, p_def ->> 'product', (p_def ->> 'maxBatches')::integer, (p_def ->> 'maxDays')::integer, p_def ->> 'validationRef',
          plant.actor_person())
  returning id into v_id;
  return v_id;
end
$$;

create function plant.close_campaign(p_campaign uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  if plant.is_blank(p_reason) then
    perform plant.fail('Closing a campaign states why (EBMR-PLANT-082)');
  end if;
  if not exists (select 1 from plant.campaign_status where id = p_campaign and closed_at is null) then
    perform plant.fail(format('Campaign %s is not open (EBMR-PLANT-082)', p_campaign));
  end if;
  insert into plant.campaign_closure (campaign_id, reason, closed_by) values (p_campaign, p_reason, plant.actor_person());
end
$$;

-- Whether one more batch of p_product on the unit or room may follow a MINOR cleaning: an open campaign of that
-- product, opened before the run began, and the run (batches since the last verified MAJOR cleaning) within the
-- campaign's maximum batches and days (counted from the run's first batch to p_planned_end). {ok, campaign_id, reason}.
create function plant.campaign_check(p_equipment uuid, p_area uuid, p_product text, p_planned_end timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  c        plant.campaign_status;
  v_major  timestamptz;
  v_n      bigint;
  v_first  timestamptz;
begin
  select * into c from plant.campaign_status
  where closed_at is null and product_code = p_product
    and ((p_equipment is not null and equipment_id = p_equipment) or (p_area is not null and area_id = p_area));
  if c.id is null then
    return jsonb_build_object('ok', false, 'reason', format('no campaign of %s is open', p_product));
  end if;
  select max(verified_at) into v_major from plant.cleaning_status
  where level = 'MAJOR' and verified_at is not null
    and ((p_equipment is not null and equipment_id = p_equipment) or (p_area is not null and area_id = p_area));
  if v_major is null then
    return jsonb_build_object('ok', false, 'reason', 'no MAJOR cleaning starts the run');
  end if;
  if p_equipment is not null then
    select count(*), min(started_at) into v_n, v_first from plant.equipment_use where equipment_id = p_equipment and started_at > v_major;
  else
    select count(*), min(started_at) into v_n, v_first from plant.area_occupancy where area_id = p_area and started_at > v_major;
  end if;
  if coalesce(v_first, clock_timestamp()) < c.opened_at then
    return jsonb_build_object('ok', false, 'reason', 'the run began before the campaign was opened');
  end if;
  if v_n + 1 > c.max_batches then
    return jsonb_build_object('ok', false, 'reason',
      format('the campaign allows %s batches between MAJOR cleanings; this would be batch %s', c.max_batches, v_n + 1));
  end if;
  if coalesce(p_planned_end, clock_timestamp()) > coalesce(v_first, clock_timestamp()) + make_interval(days => c.max_days) then
    return jsonb_build_object('ok', false, 'reason',
      format('the campaign allows %s days from its first batch at %s', c.max_days, recipe.utc_text(coalesce(v_first, clock_timestamp()))));
  end if;
  return jsonb_build_object('ok', true, 'campaign_id', c.id, 'batch_number', v_n + 1);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Cleaning of PROCESS equipment and of rooms and lines (S22)
-- ---------------------------------------------------------------------------------------------

-- Locks the unit or area a cleaning belongs to, so acts on one cleaning (and the transitions they make) serialise.
create function plant.lock_cleaning_target(p_cleaning uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  c plant.cleaning;
begin
  select * into c from plant.cleaning where id = p_cleaning;
  if c.equipment_id is not null then
    perform 1 from plant.equipment where id = c.equipment_id for update;
  elsif c.area_id is not null then
    perform 1 from plant.area where id = c.area_id for update;
  end if;
end
$$;

-- p_target: 'EQUIPMENT' or 'AREA'; p_method MANUAL or CIP (validated CIP, equipment only).
create function plant.start_cleaning(p_target text, p_code text, p_level text, p_method text default 'MANUAL') returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  e        plant.equipment;
  a        plant.area;
  v_state  text;
  v_hold   interval;
  v_since  timestamptz;
  v_over   boolean := false;
  v_id     uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('LOGBOOK.ENTRY', '{}'::jsonb);
  if p_level not in ('MINOR', 'MAJOR') or p_method not in ('MANUAL', 'CIP') or p_target not in ('EQUIPMENT', 'AREA') then
    perform plant.fail('A cleaning names its target (EQUIPMENT or AREA), level (MINOR or MAJOR) and method (MANUAL or CIP) (EBMR-PLANT-040)');
  end if;
  if p_target = 'EQUIPMENT' then
    e := plant.equipment_by_code(p_code, true);
    if e.kind <> 'PROCESS' then
      perform plant.fail(format('%s is %s equipment, which has no cleanliness state (L-27; EBMR-PLANT-041)', e.code, e.kind));
    end if;
    v_state := plant.state_of('plant_equipment', e.id);
    if v_state not in ('DIRTY', 'CLEAN') then
      perform plant.fail(format('%s is %s; a cleaning starts from DIRTY or CLEAN (EBMR-PLANT-042)', e.code, v_state));
    end if;
    -- The dirty-hold clock runs from the moment the unit became DIRTY; past it only a MAJOR cleaning is accepted.
    if v_state = 'DIRTY' then
      select dirty_hold into v_hold from plant.equipment_class where code = e.class_code;
      v_since := plant.state_since('plant_equipment', e.id);
      v_over := clock_timestamp() > v_since + v_hold;
      if v_over and p_level <> 'MAJOR' then
        perform plant.fail(format('%s has been DIRTY since %s, past its dirty-hold of %s: only a MAJOR cleaning is accepted (IN-25 (c); EBMR-PLANT-043)',
                                  e.code, recipe.utc_text(v_since), v_hold));
      end if;
    end if;
    insert into plant.cleaning (equipment_id, level, method, dirty_hold_exceeded, started_by)
    values (e.id, p_level, p_method, v_over, plant.actor_person()) returning id into v_id;
    perform plant.move('equipment_cleanliness', 'plant_equipment', e.id, 'START_CLEANING');
  else
    a := plant.area_by_code(p_code, true);
    if p_method <> 'MANUAL' then
      perform plant.fail('Rooms and lines are cleaned manually (EBMR-PLANT-040)');
    end if;
    v_state := plant.state_of('plant_area', a.id);
    if v_state not in ('DIRTY', 'CLEAN') then
      perform plant.fail(format('%s is %s; a cleaning starts from DIRTY or CLEAN (EBMR-PLANT-042)', a.code, v_state));
    end if;
    insert into plant.cleaning (area_id, level, method, dirty_hold_exceeded, started_by)
    values (a.id, p_level, 'MANUAL', false, plant.actor_person()) returning id into v_id;
    perform plant.move('area_status', 'plant_area', a.id, 'START_CLEANING');
  end if;
  return v_id;
end
$$;

-- The performer records the end of the cleaning (MANUAL: the performer; CIP: the cycle reference of the validated
-- cycle is required).
create function plant.complete_cleaning(p_cleaning uuid, p_cycle_reference text default null) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  c     plant.cleaning_status;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('LOGBOOK.ENTRY', '{}'::jsonb);
  perform plant.lock_cleaning_target(p_cleaning);
  select * into c from plant.cleaning_status where id = p_cleaning;
  if c.id is null or c.completed_at is not null or c.abandoned_at is not null then
    perform plant.fail(format('Cleaning %s is not in progress (EBMR-PLANT-044)', p_cleaning));
  end if;
  if c.method = 'CIP' and plant.is_blank(p_cycle_reference) then
    perform plant.fail('A CIP cleaning cites the cycle record of the validated CIP program (S22; EBMR-PLANT-045)');
  end if;
  insert into plant.cleaning_completion (cleaning_id, completed_by, cycle_reference)
  values (p_cleaning, plant.actor_person(), nullif(btrim(p_cycle_reference), ''));
end
$$;

-- The verifier signs LOGBOOK_DOUBLE_CHECKED on the completed cleaning (aggregate plant_cleaning) and records it here
-- in their own command. Manual cleaning: the verifier is neither who started nor who performed it (S22). The clean-hold
-- clock starts now.
create function plant.verify_cleaning(p_cleaning uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, platform, pg_temp as $$
declare
  c        plant.cleaning_status;
  v_person uuid;
  v_signer uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('LOGBOOK.SIGN', '{}'::jsonb);
  v_person := plant.actor_person();
  perform plant.lock_cleaning_target(p_cleaning);
  select * into c from plant.cleaning_status where id = p_cleaning;
  if c.id is null or c.completed_at is null or c.verified_at is not null or c.abandoned_at is not null then
    perform plant.fail(format('Cleaning %s is not awaiting verification (it must be completed and neither verified nor abandoned) (EBMR-PLANT-046)', p_cleaning));
  end if;
  if c.method = 'MANUAL' and v_person in (c.started_by, c.completed_by) then
    perform plant.fail('A manual cleaning is verified by a person other than the one who performed it (S22; EBMR-PLANT-047)');
  end if;
  perform platform.verify_signature(p_signature, 'LOGBOOK_DOUBLE_CHECKED', 'plant_cleaning', p_cleaning::text);
  select signer_person into v_signer from esig.signature where id = p_signature;
  if v_signer is distinct from v_person then
    perform plant.fail('The verification signature is the verifier''s own (EBMR-PLANT-048)');
  end if;
  insert into plant.cleaning_verification (cleaning_id, verified_by, signature_id) values (p_cleaning, v_person, p_signature);
  if c.equipment_id is not null then
    perform plant.move('equipment_cleanliness', 'plant_equipment', c.equipment_id, 'VERIFY_CLEANING');
  else
    perform plant.move('area_status', 'plant_area', c.area_id, 'VERIFY_CLEANING');
  end if;
end
$$;

-- Abandoning a cleaning is the person's decision: the command carries their own reason, code and text (DI-22; the
-- ABANDON_CLEANING transition's platform.reason_given guard requires the same), and the text is kept on the row.
create function plant.abandon_cleaning(p_cleaning uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  c     plant.cleaning_status;
  v_ctx jsonb;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('LOGBOOK.ENTRY', '{}'::jsonb);
  v_ctx := recipe.require_actor();
  if recipe.reason_is_blank(v_ctx ->> 'reason_code') or recipe.reason_is_blank(v_ctx ->> 'reason_text') then
    perform plant.fail('Abandoning a cleaning carries the reason code and reason text of the person who abandons it (DI-22; EBMR-PLANT-049)');
  end if;
  perform plant.lock_cleaning_target(p_cleaning);
  select * into c from plant.cleaning_status where id = p_cleaning;
  if c.id is null or c.verified_at is not null or c.abandoned_at is not null then
    perform plant.fail(format('Cleaning %s is closed (EBMR-PLANT-049)', p_cleaning));
  end if;
  insert into plant.cleaning_abandonment (cleaning_id, reason, abandoned_by) values (p_cleaning, v_ctx ->> 'reason_text', plant.actor_person());
  if c.equipment_id is not null then
    perform plant.move('equipment_cleanliness', 'plant_equipment', c.equipment_id, 'ABANDON_CLEANING');
  else
    perform plant.move('area_status', 'plant_area', c.area_id, 'ABANDON_CLEANING');
  end if;
end
$$;

-- Canonical signable content of a cleaning (esig content-provider contract, kernel 0200).
create function plant.cleaning_content(p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
  select coalesce((
    select jsonb_build_object(
      'exists', true,
      'aggregate_id', c.id::text,
      'content_version', 1 + (c.completed_at is not null)::int,
      'content', jsonb_build_object(
        'target', coalesce((select 'equipment:' || e.code from plant.equipment e where e.id = c.equipment_id),
                           (select 'area:' || a.code from plant.area a where a.id = c.area_id)),
        'level', c.level, 'method', c.method, 'dirty_hold_exceeded', c.dirty_hold_exceeded,
        'started_by', c.started_by, 'started_at', recipe.utc_text(c.started_at),
        'performed_by', c.completed_by, 'completed_at', recipe.utc_text(c.completed_at), 'cycle_reference', c.cycle_reference),
      'state', case when c.abandoned_at is not null then 'ABANDONED' when c.verified_at is not null then 'VERIFIED'
                    when c.completed_at is not null then 'COMPLETED' else 'STARTED' end,
      'entered_by', case when c.method = 'MANUAL' then to_jsonb(array_remove(array[c.started_by, c.completed_by], null)) else '[]'::jsonb end)
    from plant.cleaning_status c where c.id::text = p_id), '{"exists": false}'::jsonb)
$$;

select esig.register_content_provider('plant_cleaning', 'plant.cleaning_content(text)',
  'A cleaning of PROCESS equipment or of a room or line: target, level, method, performer, completion (outline 5.2.8; S22)');
select esig.register_signed_table('plant.cleaning', 'plant_cleaning', 'id');
select esig.register_signed_table('plant.cleaning_completion', 'plant_cleaning', 'cleaning_id');

-- ---------------------------------------------------------------------------------------------
-- PROCESS equipment use guard (INV-12, IN-25 (b)(c), IN-26 (a), PR-23, PR-27)
-- ---------------------------------------------------------------------------------------------

-- Everything a use of the unit by p_product until p_planned_end rests on:
-- {problems[], state, cleaning_id, clean_hold_until, required_level, level_reason, campaign_id}.
create function plant.equipment_use_assessment(p_equipment uuid, p_product text, p_planned_end timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  e          plant.equipment;
  k          plant.equipment_class;
  v_state    text;
  v_problems text[];
  c          plant.cleaning_status;
  v_until    timestamptz;
  v_prev     plant.equipment_use;
  v_open     plant.equipment_use_status;
  v_camp     jsonb;
  v_required text := 'MAJOR';
  v_why      text;
begin
  select * into e from plant.equipment where id = p_equipment;
  select * into k from plant.equipment_class where code = e.class_code;
  v_problems := plant.fitness_problems(p_equipment, p_planned_end);
  v_state := plant.state_of('plant_equipment', p_equipment);
  if v_state = 'IN_PRODUCT' then
    select * into v_open from plant.equipment_use_status where equipment_id = p_equipment and ended_at is null;
    v_problems := v_problems || format('it is in use by batch %s (INV-12)', v_open.batch_ref);
  elsif v_state = 'DIRTY' then
    v_problems := v_problems || 'it is DIRTY: to be cleaned'::text;
  elsif v_state = 'CLEANING' then
    v_problems := v_problems || 'its cleaning is not verified'::text;
  end if;
  if v_state = 'CLEAN' then
    select * into c from plant.cleaning_status where equipment_id = p_equipment and verified_at is not null order by verified_at desc, id desc limit 1;
    v_until := c.verified_at + k.clean_hold;
    if v_until <= clock_timestamp() then
      v_problems := v_problems || format('its clean-hold expired at %s: clean it again', recipe.utc_text(v_until));
    end if;
  end if;
  select * into v_prev from plant.equipment_use where equipment_id = p_equipment order by started_at desc, id desc limit 1;
  v_camp := plant.campaign_check(p_equipment, null, p_product, p_planned_end);
  if v_prev.id is null then
    v_why := 'first use';
  elsif v_prev.product_code <> p_product then
    v_why := format('product change from %s', v_prev.product_code);
  elsif not (v_camp ->> 'ok')::boolean then
    v_why := v_camp ->> 'reason';
  else
    v_required := 'MINOR';
    v_why := format('batch %s of the open campaign', v_camp ->> 'batch_number');
  end if;
  if c.id is not null and c.level = 'MINOR' and v_required = 'MAJOR' then
    v_problems := v_problems || format('a MAJOR cleaning is required (%s) but the last cleaning was MINOR (IN-26 (a))', v_why);
  end if;
  return jsonb_build_object('problems', to_jsonb(v_problems), 'state', v_state, 'cleaning_id', c.id, 'previous_use_id', v_prev.id, 'clean_hold_until', recipe.utc_text(v_until),
                            'required_level', v_required, 'level_reason', v_why,
                            'campaign_id', case when (v_camp ->> 'ok')::boolean then v_camp ->> 'campaign_id' end);
end
$$;

-- Starts the use of a PROCESS unit by a batch; refused with every problem found. The unit then is IN_PRODUCT.
create function plant.start_equipment_use(p_equipment_code text, p_batch_ref text, p_product text, p_planned_end timestamptz) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  e    plant.equipment;
  v_a  jsonb;
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', p_product));
  e := plant.equipment_by_code(p_equipment_code, true);
  if e.kind <> 'PROCESS' then
    perform plant.fail(format('%s is %s equipment, which has no occupancy; record its use with the instrument or utility check (L-27; EBMR-PLANT-062)',
                              e.code, e.kind));
  end if;
  perform plant.require_product(p_product);
  if plant.is_blank(p_batch_ref) then
    perform plant.fail('A use names its batch (EBMR-PLANT-060)');
  end if;
  if p_planned_end is null or p_planned_end <= clock_timestamp() then
    perform plant.fail('A use states its planned end, in the future (EBMR-PLANT-060)');
  end if;
  v_a := plant.equipment_use_assessment(e.id, p_product, p_planned_end);
  if jsonb_array_length(v_a -> 'problems') > 0 then
    perform plant.fail(format('%s cannot be used for batch %s: %s (INV-12, IN-25, PR-23; EBMR-PLANT-061)', e.code, p_batch_ref,
                              (select string_agg(x, '; ') from jsonb_array_elements_text(v_a -> 'problems') x)));
  end if;
  insert into plant.equipment_use (equipment_id, previous_use_id, batch_ref, product_code, planned_end, cleaning_id, campaign_id, started_by)
  values (e.id, (v_a ->> 'previous_use_id')::uuid, p_batch_ref, p_product, p_planned_end, (v_a ->> 'cleaning_id')::uuid,
          (v_a ->> 'campaign_id')::uuid, plant.actor_person())
  returning id into v_id;
  perform plant.move('equipment_cleanliness', 'plant_equipment', e.id, 'START_USE');
  return v_id;
end
$$;

-- Ends a use: the unit becomes DIRTY (its dirty-hold clock starts) and the row records whether the clean-hold or the
-- calibration due instant passed during the use (D-S1-5; raised as an exception from slice 2).
create function plant.end_equipment_use(p_use uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  u        plant.equipment_use_status;
  v_hold   timestamptz;
  v_cal    timestamptz;
  v_now    timestamptz := clock_timestamp();
  v_ch     boolean;
  v_cc     boolean;
begin
  perform iam.assert_not_administrator();
  select * into u from plant.equipment_use_status where id = p_use;
  if u.id is null then
    perform plant.fail(format('Unknown use %s (EBMR-PLANT-063)', p_use));
  end if;
  perform iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', u.product_code));
  perform 1 from plant.equipment where id = u.equipment_id for update;
  select * into u from plant.equipment_use_status where id = p_use;
  if u.ended_at is not null then
    perform plant.fail(format('Use %s is not open (EBMR-PLANT-063)', p_use));
  end if;
  select c.verified_at + k.clean_hold into v_hold
  from plant.cleaning_status c join plant.equipment e on e.id = c.equipment_id join plant.equipment_class k on k.code = e.class_code
  where c.id = u.cleaning_id;
  select case when c.as_left = 'PASS' then c.due_at end into v_cal from plant.calibration c
  where c.equipment_id = u.equipment_id and c.recorded_at <= u.started_at order by c.recorded_at desc, c.id desc limit 1;
  v_ch := v_hold is not null and v_hold <= v_now;
  v_cc := v_cal is not null and v_cal <= v_now;
  insert into plant.equipment_use_end (use_id, equipment_id, started_at, ended_by, ended_at, clean_hold_crossed, calibration_crossed)
  values (p_use, u.equipment_id, u.started_at, plant.actor_person(), v_now, v_ch, v_cc);
  perform plant.move('equipment_cleanliness', 'plant_equipment', u.equipment_id, 'END_USE');
  return jsonb_build_object('use_id', p_use, 'clean_hold_crossed', v_ch, 'calibration_crossed', v_cc);
end
$$;

grant execute on function
  plant.define_product(jsonb), plant.define_equipment_class(jsonb), plant.define_area(jsonb), plant.define_equipment(jsonb),
  plant.record_equipment_event(text, text, text, text, text), plant.record_calibration(text, timestamptz, text, text, text),
  plant.record_instrument_check(text, text, text, text), plant.record_instrument_use(text, text, text, timestamptz),
  plant.record_utility_reading(text, text, text, timestamptz), plant.open_campaign(jsonb), plant.close_campaign(uuid, text),
  plant.start_cleaning(text, text, text, text), plant.complete_cleaning(uuid, text), plant.verify_cleaning(uuid, uuid),
  plant.abandon_cleaning(uuid), plant.start_equipment_use(text, text, text, timestamptz), plant.end_equipment_use(uuid),
  -- readers
  plant.equipment_fitness(uuid), plant.calibration_valid_until(uuid), plant.calibration_affected_batches(uuid),
  plant.utility_problem(text), plant.assert_utility_usable(text), plant.equipment_use_assessment(uuid, text, timestamptz),
  plant.instrument_use_assessment(uuid, text, timestamptz), plant.campaign_check(uuid, uuid, text, timestamptz), plant.state_of(text, uuid)
to ebmr_app;

reset role;
