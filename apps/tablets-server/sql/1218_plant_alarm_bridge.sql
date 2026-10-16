-- Phase 6 slice 6b (builder B): the Tablets edition's own alarms reach the generic plant alarm log (recipe-core 0960;
-- DI-49; D-P6b-0-2: one occurrence, one path; D-P6b-3). The process readings of 0820 stay as they are (G-06 entries
-- stand on them unchanged); these triggers copy what they say into plant.alarm in the same transaction, so every
-- alarm during a batch is in the batch's alarm log, bound at its source time to the batch, the step and the unit.
--
-- Handbook: modules/tablets-server.md
--
--   tab.bridge_process_alarm (after insert on tab.process_reading)
--       ALARM          plant.raise_alarm, source EBMR, occurrence PR-<reading id>, on the plant unit the process device
--                      is linked to (tablets 0870), code TAG.<TAG> (the released tag name upper-cased), the value and
--                      unit, the source time; the code's configuration (plant.alarm_code, source EBMR) decides whether
--                      it is GMP-critical, an unconfigured code is (D-P6b-0-3). A device linked to no unit serves no
--                      batch step (tablets 0870 refuses such a binding) and its alarm stays in the device's readings.
--       ALARM_CLEARED  the CLEARED transition of the device unit's latest uncleared EBMR occurrence of that tag
--   tab.bridge_process_alarm_ack (after insert on tab.process_alarm_ack): the G-06 acknowledgment of an ALARM reading
--       is the eBMR acknowledgment of its plant occurrence (the same person, session and time; its comment states the
--       action taken and is both); not when the occurrence needs a deviation (that one is acknowledged on the alarm
--       list with its deviation reference), nor when it is already acknowledged there (D-P6b-B-4)
--   tab.bridge_device_alarm (after insert on tab.device_alarm): a device alarm naming a plant unit (by its code, or a
--       process device linked to one), raised in a command, is raised on that unit (occurrence DA-<id>, code
--       DEVICE.<kind>); the gateway's interface faults that name no unit stay in the device alarm log (D-P6b-0-9,
--       D-P6b-B-5)
--   tab.bridge_step_device (after insert on tab.step_device): the unit of the step's device is bound to the step in
--       plant.step_equipment (the binding the alarm log, events and series read), with the step binding's person

set local role ebmr_owner;

create function tab.bridge_process_alarm() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, plant, pg_temp as $$
declare
  v_unit  uuid;
  v_alarm uuid;
begin
  if new.kind not in ('ALARM', 'ALARM_CLEARED') then
    return null;
  end if;
  select u.equipment_id into v_unit from tab.process_device_unit u where u.process_device_id = new.process_device_id;
  if v_unit is null then
    return null;
  end if;
  if new.kind = 'ALARM' then
    perform plant.raise_alarm(jsonb_build_object(
      'source', 'EBMR', 'occurrenceId', 'PR-' || new.id, 'subjectKind', 'EQUIPMENT', 'equipmentId', v_unit,
      'alarmCode', left('TAG.' || upper(new.tag), 64), 'severity', '700', 'tag', new.tag, 'value', new.value, 'valueUnit', new.unit,
      'message', format('%s alarm from %s: %s %s (quality %s)', new.tag, new.device_code, new.value, new.unit, new.quality),
      'raisedSourceUs', new.source_time_us::text));
  else
    select a.id into v_alarm from plant.alarm a
     where a.source = 'EBMR' and a.equipment_id = v_unit and a.tag = new.tag and a.occurrence_id like 'PR-%'
       and not exists (select 1 from plant.alarm_transition t where t.alarm_id = a.id and t.transition = 'CLEARED')
     order by a.raised_source_us desc, a.received_at desc limit 1;
    if v_alarm is not null then
      insert into plant.alarm_transition (alarm_id, transition, source_us) values (v_alarm, 'CLEARED', new.source_time_us);
    end if;
  end if;
  return null;
end
$$;
create trigger zb_plant_alarm_bridge after insert on tab.process_reading for each row execute function tab.bridge_process_alarm();

create function tab.bridge_process_alarm_ack() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, plant, platform, pg_temp as $$
declare
  a       plant.alarm;
  v_actor jsonb := platform.require_actor();
begin
  select * into a from plant.alarm where source = 'EBMR' and occurrence_id = 'PR-' || new.reading_id;
  if a.id is null or a.deviation_required or exists (select 1 from plant.alarm_ack k where k.alarm_id = a.id) then
    return null;
  end if;
  insert into plant.alarm_ack (alarm_id, action_taken, comment, deviation_ref, person_id, account_id, session_id, role_code, correlation_id, acked_at)
  values (a.id, btrim(new.comment), btrim(new.comment), null, new.person_id, new.account_id, new.session_id, v_actor ->> 'role_code', new.correlation_id,
          clock_timestamp());
  return null;
end
$$;
create trigger zb_plant_alarm_ack_bridge after insert on tab.process_alarm_ack for each row execute function tab.bridge_process_alarm_ack();

create function tab.bridge_device_alarm() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, plant, kernel, pg_temp as $$
declare
  v_unit uuid;
begin
  if new.device_code is null or kernel.current_actor() is null then
    return null;
  end if;
  select e.id into v_unit from plant.equipment e where e.code = new.device_code;
  if v_unit is null then
    select u.equipment_id into v_unit from tab.process_device d join tab.process_device_unit u on u.process_device_id = d.id
     where d.device_code = new.device_code and d.ended_at is null;
  end if;
  if v_unit is null then
    return null;
  end if;
  perform plant.raise_alarm(jsonb_build_object(
    'source', 'EBMR', 'occurrenceId', 'DA-' || new.id, 'subjectKind', 'EQUIPMENT', 'equipmentId', v_unit,
    'alarmCode', left('DEVICE.' || new.kind, 64), 'severity', '600', 'message', left(format('%s (%s): %s', new.kind, new.code, new.message), 500),
    'raisedSourceUs', floor(extract(epoch from new.raised_at) * 1000000)::bigint::text));
  return null;
end
$$;
create trigger zb_plant_device_alarm_bridge after insert on tab.device_alarm for each row execute function tab.bridge_device_alarm();

create function tab.bridge_step_device() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, plant, pg_temp as $$
declare
  v_unit uuid;
  v_use  uuid;
begin
  select u.equipment_id into v_unit from tab.process_device_unit u where u.process_device_id = new.process_device_id;
  select s.id into v_use from plant.equipment_use_status s where s.equipment_id = v_unit and s.batch_id = new.batch_id and s.ended_at is null
   order by s.started_at desc limit 1;
  if v_unit is null or v_use is null or exists (select 1 from plant.step_equipment where batch_id = new.batch_id and step = new.step and equipment_id = v_unit) then
    return null;
  end if;
  insert into plant.step_equipment (batch_id, step, equipment_id, use_id, person_id, account_id, correlation_id)
  values (new.batch_id, new.step, v_unit, v_use, new.person_id, new.account_id, new.correlation_id);
  return null;
end
$$;
create trigger zb_plant_step_equipment_bridge after insert on tab.step_device for each row execute function tab.bridge_step_device();

revoke all on function tab.bridge_process_alarm(), tab.bridge_process_alarm_ack(), tab.bridge_device_alarm(), tab.bridge_step_device() from public;

reset role;
