-- Phase 6 slice 6a (builder B): the CMMS adapter's receiving commands and the stale-mirror guard at equipment use
-- (DI-31, IN-25 (b)(d), PR-23; INV-26, INV-38; D-P6a-3, D-P6a-5; plan "Slice 6a", "Stale mirrors fail closed").
--
-- Handbook: modules/recipe-core.md
--
--   plant.receive_cmms_calibration(envelope)   the CMMS adapter's command for cmms.calibration: platform.accept_inbound_detail
--       (kernel 1180), then, when ACCEPTED and CMMS_CALIBRATION is a MIRROR, a plant.calibration row in the same
--       transaction (so the use guards, the logbook and the after-release suspension of an as-found failure, recipe-core
--       0840, see it as any calibration). Result PASS: as found and as left PASS; FAIL: both FAIL; ADJUSTED_PASS: as found
--       FAIL, as left PASS (D-P6a-B-2: an adjustment means the unit was not left as found, so the batches since the last
--       good calibration are listed and released lots are suspended for assessment, PR-23). The due date (a calendar
--       date in the CMMS) becomes the start of that day in the site's zone (D-P6a-B-3: the unit is not used on its due
--       date). A FAIL whose due date is not in the future is kept with a due instant one second ahead (it is left out
--       of tolerance, so the instant is never used; the CMMS's date stays in the message, DI-31). Refusals:
--         EBMR-CMMS-001 WRONG_IDENTITY  the class is STAND_IN (the built-in logbook is authoritative; D-P6a-5)
--         EBMR-CMMS-002 MALFORMED       payload shape
--         EBMR-CMMS-003 WRONG_IDENTITY  unknown equipment code, or a class without calibration
--         EBMR-CMMS-004 STALE           older than a calibration of the unit already applied (by performedAt)
--         EBMR-CMMS-005 DUPLICATE       the calibration reference is already recorded for the unit
--         EBMR-CMMS-006 OUT_OF_RANGE    a passing calibration whose due date is not in the future
--   plant.receive_cmms_maintenance(envelope)   cmms.maintenance into plant.cmms_work_order (insert-only history, one row
--       per received state; STALE when older than the work order's state already applied; EBMR-CMMS-001 to 004).
--   plant.cmms_maintenance_problems(equipment)  in MIRROR, the unit's work orders that stop its use: one IN_PROGRESS
--       (the unit is under maintenance) or a PREVENTIVE one still OPEN after its due date (D-P6a-B-4).
--   plant.fitness_problems (CREATE OR REPLACE from 0403, same signature, owner, definer, search_path and grants): first
--       platform.mirror_fresh_or_raise('CMMS_MAINTENANCE') and, for a unit whose class needs calibration,
--       platform.mirror_fresh_or_raise('CMMS_CALIBRATION'): a stale MIRROR refuses the use with EBMR-INT-010, which
--       names the CMMS mirror, its age and its bound; STAND_IN passes as before. Then the CMMS work-order problems.
--   plant.record_calibration (CREATE OR REPLACE from 0403): refused while CMMS_CALIBRATION is a MIRROR (EBMR-PLANT-025;
--       the modes never mix for one data class, D-P6a-5); otherwise unchanged.

set local role ebmr_owner;

create table plant.cmms_work_order (
  id                uuid primary key default gen_random_uuid(),
  equipment_id      uuid not null references plant.equipment (id),
  work_order        text not null check (work_order ~ '^[\x21-\x7E]{1,64}$'),
  kind              text not null check (kind in ('PREVENTIVE', 'CORRECTIVE')),
  status            text not null check (status in ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  due_on            date,
  message_id        uuid not null unique references platform.inbound_message (id),
  source_timestamp  timestamptz not null,
  received_at       timestamptz not null default clock_timestamp()
);
create index cmms_work_order_by_equipment on plant.cmms_work_order (equipment_id, work_order, source_timestamp);
revoke all on plant.cmms_work_order from public;
select platform.enforce_db_time('plant.cmms_work_order', array['received_at']);
select kernel.register_audited_table('plant.cmms_work_order', 'plant_equipment', 'equipment_id', true);

-- The message ids of CMMS calibrations (DI-31: each row traces to its received envelope).
create table plant.cmms_calibration_message (
  calibration_id  uuid primary key references plant.calibration (id),
  message_id      uuid not null unique references platform.inbound_message (id),
  equipment_id    uuid not null references plant.equipment (id),
  calibration_ref text not null,
  performed_at    timestamptz not null,
  received_at     timestamptz not null default clock_timestamp(),
  unique (equipment_id, calibration_ref)
);
revoke all on plant.cmms_calibration_message from public;
select platform.enforce_db_time('plant.cmms_calibration_message', array['received_at']);
select kernel.register_audited_table('plant.cmms_calibration_message', 'plant_equipment', 'equipment_id', true);

create function plant.cmms_accept(p_envelope jsonb, p_type text, p_class text) returns platform.inbound_message
language plpgsql volatile security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  v_out jsonb;
  m     platform.inbound_message;
begin
  if p_envelope ->> 'messageType' is distinct from p_type then
    raise exception using errcode = 'P0001',
      message = format('EBMR-CMMS-002 this command receives %s messages, not %s', p_type, coalesce(p_envelope ->> 'messageType', 'none'));
  end if;
  v_out := platform.accept_inbound_detail(p_envelope);
  if v_out ->> 'outcome' <> 'ACCEPTED' then
    return null;
  end if;
  if platform.setting_text('integration.mode.' || lower(p_class)) <> 'MIRROR' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-CMMS-001 this site holds %s in the built-in logbook (STAND_IN); a CMMS message is not applied (D-P6a-5)', p_class);
  end if;
  select * into m from platform.inbound_message where id = (v_out ->> 'messageId')::uuid;
  return m;
end
$$;

-- The start of a calendar date in the site's zone.
create function plant.site_day_start(p_day date) returns timestamptz
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select p_day::timestamp at time zone iam.policy_text('site.zone')
$$;

create function plant.receive_cmms_calibration(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  v_ctx   jsonb := platform.require_actor();
  m       platform.inbound_message;
  p       jsonb;
  k       text;
  e       plant.equipment;
  v_req   boolean;
  v_perf  timestamptz;
  v_day   date;
  v_due   timestamptz;
  v_newer timestamptz;
  v_id    uuid;
begin
  m := plant.cmms_accept(p_envelope, 'cmms.calibration', 'CMMS_CALIBRATION');
  if m.id is null then
    return jsonb_build_object('outcome', 'DUPLICATE', 'applied', 'NOTHING (duplicate)');
  end if;
  p := m.payload;
  if jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-CMMS-002 malformed cmms.calibration payload: not an object';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('equipmentCode', 'calibrationRef', 'performedAt', 'result', 'dueOn') then
      raise exception using errcode = 'P0001', message = format('EBMR-CMMS-002 malformed cmms.calibration payload: unknown field %s', k);
    end if;
  end loop;
  if coalesce(p ->> 'equipmentCode', '') !~ '^[\x21-\x7E]{1,64}$' or coalesce(p ->> 'calibrationRef', '') !~ '^[\x21-\x7E]{1,64}$'
     or coalesce(p ->> 'performedAt', '') !~ '^(0|[1-9][0-9]{0,15})$' or coalesce(p ->> 'result', '') not in ('PASS', 'FAIL', 'ADJUSTED_PASS')
     or coalesce(p ->> 'dueOn', '') !~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-CMMS-002 malformed cmms.calibration payload: equipmentCode, calibrationRef, performedAt (epoch microseconds), result PASS|FAIL|ADJUSTED_PASS and dueOn (YYYY-MM-DD) are required';
  end if;
  begin
    v_day := (p ->> 'dueOn')::date;
  exception when others then
    raise exception using errcode = 'P0001', message = format('EBMR-CMMS-002 malformed cmms.calibration payload: %s is not a date', p ->> 'dueOn');
  end;
  select * into e from plant.equipment where code = p ->> 'equipmentCode' for update;
  if e.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CMMS-003 equipment %s is not known to this installation (wrong unit)', p ->> 'equipmentCode');
  end if;
  select k2.calibration_required into v_req from plant.equipment_class k2 where k2.code = e.class_code;
  if not v_req then
    raise exception using errcode = 'P0001', message = format('EBMR-CMMS-003 %s is of a class without calibration', e.code);
  end if;
  if exists (select 1 from plant.cmms_calibration_message x where x.equipment_id = e.id and x.calibration_ref = p ->> 'calibrationRef') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-CMMS-005 calibration %s of %s is already recorded; a changed calibration is a new one in the CMMS', p ->> 'calibrationRef', e.code);
  end if;
  v_perf := platform.epoch_us_to_timestamptz(p ->> 'performedAt');
  select max(x.performed_at) into v_newer from plant.cmms_calibration_message x where x.equipment_id = e.id;
  if v_newer is not null and v_newer >= v_perf then
    raise exception using errcode = 'P0001',
      message = format('EBMR-CMMS-004 calibration %s of %s (performed %s) is older than one already applied (%s); it is not applied',
                       p ->> 'calibrationRef', e.code, v_perf, v_newer);
  end if;
  v_due := plant.site_day_start(v_day);
  if v_due <= clock_timestamp() then
    if p ->> 'result' = 'FAIL' then
      v_due := clock_timestamp() + interval '1 second';
    else
      raise exception using errcode = 'P0001',
        message = format('EBMR-CMMS-006 calibration %s of %s passed with a due date %s that is not in the future', p ->> 'calibrationRef', e.code, v_day);
    end if;
  end if;
  insert into plant.calibration (equipment_id, due_at, as_found, as_left, reference, person_id, account_id)
  values (e.id, v_due, case when p ->> 'result' = 'PASS' then 'PASS' else 'FAIL' end, case when p ->> 'result' = 'FAIL' then 'FAIL' else 'PASS' end,
          p ->> 'calibrationRef', (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid)
  returning id into v_id;
  insert into plant.cmms_calibration_message (calibration_id, message_id, equipment_id, calibration_ref, performed_at)
  values (v_id, m.id, e.id, p ->> 'calibrationRef', v_perf);
  return jsonb_build_object('outcome', 'ACCEPTED', 'messageId', m.id, 'sequenceStatus', m.sequence_status, 'applied', 'RECORDED', 'calibrationId', v_id);
end
$$;

create function plant.receive_cmms_maintenance(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  m       platform.inbound_message;
  p       jsonb;
  k       text;
  e       plant.equipment;
  v_day   date;
  v_newer timestamptz;
begin
  m := plant.cmms_accept(p_envelope, 'cmms.maintenance', 'CMMS_MAINTENANCE');
  if m.id is null then
    return jsonb_build_object('outcome', 'DUPLICATE', 'applied', 'NOTHING (duplicate)');
  end if;
  p := m.payload;
  if jsonb_typeof(p) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-CMMS-002 malformed cmms.maintenance payload: not an object';
  end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('equipmentCode', 'workOrder', 'kind', 'status', 'dueOn') then
      raise exception using errcode = 'P0001', message = format('EBMR-CMMS-002 malformed cmms.maintenance payload: unknown field %s', k);
    end if;
  end loop;
  if coalesce(p ->> 'equipmentCode', '') !~ '^[\x21-\x7E]{1,64}$' or coalesce(p ->> 'workOrder', '') !~ '^[\x21-\x7E]{1,64}$'
     or coalesce(p ->> 'kind', '') not in ('PREVENTIVE', 'CORRECTIVE') or coalesce(p ->> 'status', '') not in ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')
     or not (p ? 'dueOn') or (jsonb_typeof(p -> 'dueOn') <> 'null' and coalesce(p ->> 'dueOn', '') !~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-CMMS-002 malformed cmms.maintenance payload: equipmentCode, workOrder, kind PREVENTIVE|CORRECTIVE, status OPEN|IN_PROGRESS|COMPLETED|CANCELLED and dueOn (YYYY-MM-DD or null) are required';
  end if;
  if jsonb_typeof(p -> 'dueOn') = 'string' then
    begin
      v_day := (p ->> 'dueOn')::date;
    exception when others then
      raise exception using errcode = 'P0001', message = format('EBMR-CMMS-002 malformed cmms.maintenance payload: %s is not a date', p ->> 'dueOn');
    end;
  end if;
  select * into e from plant.equipment where code = p ->> 'equipmentCode';
  if e.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-CMMS-003 equipment %s is not known to this installation (wrong unit)', p ->> 'equipmentCode');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cmms-wo:' || e.id::text || '/' || (p ->> 'workOrder'), 0));
  select max(w.source_timestamp) into v_newer from plant.cmms_work_order w where w.equipment_id = e.id and w.work_order = p ->> 'workOrder';
  if v_newer is not null and v_newer >= m.source_timestamp then
    raise exception using errcode = 'P0001',
      message = format('EBMR-CMMS-004 the CMMS state of work order %s at %s is older than the one already applied (%s); it is not applied',
                       p ->> 'workOrder', m.source_timestamp, v_newer);
  end if;
  insert into plant.cmms_work_order (equipment_id, work_order, kind, status, due_on, message_id, source_timestamp)
  values (e.id, p ->> 'workOrder', p ->> 'kind', p ->> 'status', v_day, m.id, m.source_timestamp);
  return jsonb_build_object('outcome', 'ACCEPTED', 'messageId', m.id, 'sequenceStatus', m.sequence_status, 'applied', 'RECORDED');
end
$$;

-- The CMMS work orders that stop the unit's use now (MIRROR only).
create function plant.cmms_maintenance_problems(p_equipment uuid) returns text[]
language sql stable security definer set search_path = pg_catalog, plant, platform, iam, pg_temp as $$
  select coalesce(array_agg(case when w.status = 'IN_PROGRESS'
                                 then format('it is under maintenance (CMMS work order %s)', w.work_order)
                                 else format('its preventive maintenance (CMMS work order %s) was due on %s and is not done', w.work_order, w.due_on) end
                            order by w.work_order), '{}')
  from (select distinct on (x.work_order) x.* from plant.cmms_work_order x where x.equipment_id = p_equipment
        order by x.work_order, x.source_timestamp desc, x.received_at desc) w
  where platform.setting_text('integration.mode.cmms_maintenance') = 'MIRROR'
    and (w.status = 'IN_PROGRESS'
         or (w.kind = 'PREVENTIVE' and w.status = 'OPEN' and w.due_on is not null
             and w.due_on < (clock_timestamp() at time zone iam.policy_text('site.zone'))::date))
$$;

-- The problems that stop any use of the unit until p_planned_end: the CMMS mirrors fresh (fail closed), fitness,
-- calibration cover (IN-25 (b)(d)) and the CMMS work orders.
create or replace function plant.fitness_problems(p_equipment uuid, p_planned_end timestamptz) returns text[]
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_fit   text;
  v_req   boolean;
  v_until timestamptz;
  v_out   text[] := '{}';
begin
  select k.calibration_required into v_req from plant.equipment e join plant.equipment_class k on k.code = e.class_code where e.id = p_equipment;
  perform platform.mirror_fresh_or_raise('CMMS_MAINTENANCE');
  if v_req then
    perform platform.mirror_fresh_or_raise('CMMS_CALIBRATION');
  end if;
  v_fit := plant.equipment_fitness(p_equipment);
  if v_fit not in ('QUALIFIED', 'CALIBRATION_DUE_SOON') then
    v_out := v_out || format('the unit is %s', v_fit);
  end if;
  if v_req and v_fit not in ('OUT_OF_TOLERANCE', 'CALIBRATION_OVERDUE') then
    v_until := plant.calibration_valid_until(p_equipment);
    if v_until is null or v_until <= p_planned_end then
      v_out := v_out || format('its calibration is due at %s, before the planned end %s', recipe.utc_text(v_until), recipe.utc_text(p_planned_end));
    end if;
  end if;
  return v_out || plant.cmms_maintenance_problems(p_equipment);
end
$$;

create or replace function plant.record_calibration(p_equipment_code text, p_due_at timestamptz, p_as_found text, p_as_left text, p_reference text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  e    plant.equipment;
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('LOGBOOK.ENTRY', '{}'::jsonb);
  if platform.setting_text('integration.mode.cmms_calibration') = 'MIRROR' then
    perform plant.fail('Calibrations come from the CMMS at this site (CMMS_CALIBRATION is MIRROR); record it in the CMMS (EBMR-PLANT-025; D-P6a-5)');
  end if;
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

revoke all on function plant.cmms_accept(jsonb, text, text), plant.site_day_start(date), plant.receive_cmms_calibration(jsonb),
  plant.receive_cmms_maintenance(jsonb), plant.cmms_maintenance_problems(uuid) from public;
grant select on plant.cmms_work_order, plant.cmms_calibration_message to ebmr_app;
grant execute on function plant.receive_cmms_calibration(jsonb), plant.receive_cmms_maintenance(jsonb), plant.cmms_maintenance_problems(uuid) to ebmr_app;

reset role;
