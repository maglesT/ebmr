-- Phase 6 slice 6b-0 (lead): the equipment-data interfaces fixed for builders A and B (plan "Slice 6b", "Interfaces
-- fixed up front"; docs/build-plan/phase-6/slice-6b-0-interfaces.md). Controls DI-49 (alarms and equipment events in the
-- batch context), DI-32 (original device records, native dynamic data), DI-31 (each row from an inbound message traces
-- to it); D-P6b-3 (one generic alarm log for both editions), D-P6a-0-3 (plant alarms stay apart from the integration
-- alarms of kernel 1180 and the time monitor's platform.alarm).
--
-- Handbook: modules/recipe-core.md
--
--   platform.inbound_schema rows   opcua.series_chunk, opcua.alarm, opcua.equipment_event; ems.series_chunk, ems.alarm
--                                  (version 1; @ebmr/integration-sdk/adapter systems/opcua.ts and ems.ts)
--   plant.series_tag               the tags a series may carry: every released process tag (integration-sdk
--                                  process/tags.ts, EQUIPMENT) and the EMS room tags (AREA); insert-only, audited
--   plant.alarm_code               controlled alarm configuration per (source, code), versioned: GMP-critical flag and
--                                  whether a deviation must be cited; an unconfigured code counts as GMP-critical
--                                  (fail safe). MASTERDATA.CHANGE; the DI-09 change record arrives with slice 6f
--   plant.step_equipment           which unit a step of a batch runs on, from a time on (STEP.EXECUTE; the unit's open
--                                  use must be this batch's); the binding the alarm log, the events and the series read
--   plant.alarm                    insert-only, audited: one alarm occurrence (source EBMR, OPCUA or EMS and the
--                                  source's occurrence id; equipment or room; code and its configuration version;
--                                  GMP-critical and deviation-required flags taken from the configuration at the raise;
--                                  tag, value, limit; time raised at the source and received)
--   plant.alarm_batch              the batches and steps the occurrence is bound to, computed at the raise from the
--                                  equipment use and step binding (equipment) or the room occupancies (room)
--   plant.alarm_transition         CLEARED or SOURCE_ACKNOWLEDGED as the source reported it, once each
--   plant.alarm_ack                the eBMR acknowledgment, the alarm's disposition (DI-49): a person, the action taken,
--                                  a comment (required for GMP-critical), a deviation reference (where required); once
--   plant.alarm_status (view)      each occurrence with its transitions and acknowledgment
--   plant.batch_alarm_log (view)   the same per bound batch, with the step (the batch's alarm log)
--   plant.equipment_state_event    insert-only, audited: equipment events in the batch context (state changes, recipe
--                                  loaded or mismatched, phases, operator actions, faults); apart from plant.equipment_event,
--                                  which keeps the fitness history (qualification, maintenance, service)
--   plant.series                   insert-only, audited: native samples per chunk (subject, tag, unit, chunk number,
--                                  source time range, the samples as received with raw values as text, the SHA-256 the
--                                  source sent and this database recomputed). Batch and step by the binding windows
--                                  (plant.series_in_context), not stored per chunk (D-P6b-0-6)
--   plant.device_original          insert-only, audited (DI-32): the original record of a simple device kept with the
--                                  value the eBMR shows: TRANSMITTED (raw output, device timestamp; the raw output must
--                                  state the shown value exactly) or PRINTED_TICKET (the ticket's SHA-256 and true-copy
--                                  reference), linked to the batch, step and entry
--
-- Commands (SECURITY DEFINER, never an administrator, pg_temp last):
--   plant.define_alarm_code(source, code, gmp_critical, deviation_required, description) returns integer (version)
--   plant.bind_step_equipment(batch, step, equipment_code)
--   plant.receive_equipment_alarm(envelope) returns jsonb   INTERFACE.WRITE, the OPCUA or EMS adapter's command
--   plant.receive_equipment_event(envelope) returns jsonb   INTERFACE.WRITE, the OPCUA adapter's command
--   plant.receive_series_chunk(envelope) returns jsonb      INTERFACE.WRITE, the OPCUA or EMS adapter's command
--   plant.acknowledge_alarm(alarm, action_taken, comment, deviation_ref)   ALARM.ACKNOWLEDGE in the batch's scope, a person
--   plant.record_device_original(record jsonb) returns uuid  STEP.EXECUTE in the batch's scope (a person) or
--                                                            INTERFACE.WRITE (an integration identity)
-- Owner-level (no grant to the application; the tablets bridge of builder B calls it from its own migration):
--   plant.raise_alarm(alarm jsonb) returns uuid
-- Reads (granted): plant.batch_context_at(subject_kind, equipment, area, at), plant.alarm_problem(batch, step),
--   plant.batch_alarms(batch), plant.series_in_context(batch, step, tag), plant.series_chunk_hash(...)
--
-- Messages: EBMR-ALM-001 to 005 (receiving, error classes MALFORMED, WRONG_IDENTITY, OUT_OF_RANGE, DUPLICATE,
-- OUT_OF_ORDER as systems/opcua.ts lists them), EBMR-ALM-010 to 019 (acknowledgment), EBMR-ALM-020 (an unacknowledged
-- GMP-critical alarm), EBMR-ALM-030 to 039 (configuration and binding); EBMR-EQD-001 to 005 (series and events,
-- same classes), EBMR-EQD-010 to 019 (original records).

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0960_plant_alarms_series_interfaces)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'OPC UA and EMS message schemas and the series tags of the equipment-data interfaces (DI-31, DI-32, Phase 6 slice 6b-0)'));

insert into platform.inbound_schema (source_system, message_type, schema_version, description) values
  ('OPCUA', 'opcua.series_chunk', 1, 'Native samples of one tag of one unit (DI-32)'),
  ('OPCUA', 'opcua.alarm', 1, 'An alarm occurrence of a unit raised, cleared or acknowledged at the source (DI-49)'),
  ('OPCUA', 'opcua.equipment_event', 1, 'An equipment event: state change, recipe, phase, operator action, fault'),
  ('EMS', 'ems.series_chunk', 1, 'Native temperature or humidity samples of one room (DI-32)'),
  ('EMS', 'ems.alarm', 1, 'A room alarm raised, cleared or acknowledged at the EMS (DI-49)');

-- ---------------------------------------------------------------------------------------------
-- Configuration: series tags and alarm codes
-- ---------------------------------------------------------------------------------------------

create table plant.series_tag (
  tag             text primary key check (tag ~ '^[a-z][a-z0-9_]*(\.[a-zA-Z0-9_]+)+$'),
  subject_kind    text not null check (subject_kind in ('EQUIPMENT', 'AREA')),
  equipment_type  text check (equipment_type is null or equipment_type ~ '^[A-Z][A-Z_]{0,31}$'),
  unit            text not null check (unit ~ '^[!-~]{1,16}$'),
  scale           integer not null check (scale between 0 and 6),
  recorded_at     timestamptz not null default clock_timestamp(),
  check ((subject_kind = 'EQUIPMENT') = (equipment_type is not null))
);
revoke all on plant.series_tag from public;
select platform.enforce_db_time('plant.series_tag', array['recorded_at']);
select kernel.register_audited_table('plant.series_tag', 'plant_series_tag', 'tag', true);
insert into plant.series_tag (tag, subject_kind, equipment_type, unit, scale) values
  ('turret.speed_rpm', 'EQUIPMENT', 'PRESS', 'rpm', 1),
  ('force.main_kN', 'EQUIPMENT', 'PRESS', 'kN', 2),
  ('force.pre_kN', 'EQUIPMENT', 'PRESS', 'kN', 2),
  ('fill.depth_mm', 'EQUIPMENT', 'PRESS', 'mm', 2),
  ('tablet.count', 'EQUIPMENT', 'PRESS', 'count', 0),
  ('reject.count', 'EQUIPMENT', 'PRESS', 'count', 0),
  ('stroke.count', 'EQUIPMENT', 'PRESS', 'count', 0),
  ('pan.speed_rpm', 'EQUIPMENT', 'COATER', 'rpm', 1),
  ('inlet.temp_C', 'EQUIPMENT', 'COATER', 'degC', 1),
  ('exhaust.temp_C', 'EQUIPMENT', 'COATER', 'degC', 1),
  ('bed.temp_C', 'EQUIPMENT', 'COATER', 'degC', 1),
  ('spray.rate_g_min', 'EQUIPMENT', 'COATER', 'g/min', 1),
  ('atomisation.bar', 'EQUIPMENT', 'COATER', 'bar', 2),
  ('airflow.m3_h', 'EQUIPMENT', 'COATER', 'm3/h', 0),
  ('granulator.impeller_rpm', 'EQUIPMENT', 'GRANULATOR', 'rpm', 0),
  ('granulator.chopper_rpm', 'EQUIPMENT', 'GRANULATOR', 'rpm', 0),
  ('granulator.power_kW', 'EQUIPMENT', 'GRANULATOR', 'kW', 2),
  ('granulator.torque_Nm', 'EQUIPMENT', 'GRANULATOR', 'N.m', 1),
  ('granulator.product_temp_C', 'EQUIPMENT', 'GRANULATOR', 'degC', 1),
  ('granulator.binder_kg', 'EQUIPMENT', 'GRANULATOR', 'kg', 3),
  ('dryer.inlet_temp_C', 'EQUIPMENT', 'DRYER', 'degC', 1),
  ('dryer.bed_temp_C', 'EQUIPMENT', 'DRYER', 'degC', 1),
  ('dryer.exhaust_temp_C', 'EQUIPMENT', 'DRYER', 'degC', 1),
  ('dryer.airflow_m3_h', 'EQUIPMENT', 'DRYER', 'm3/h', 0),
  ('blender.speed_rpm', 'EQUIPMENT', 'BLENDER', 'rpm', 1),
  ('blender.revolutions', 'EQUIPMENT', 'BLENDER', 'count', 0),
  ('roller.force_kN', 'EQUIPMENT', 'ROLLER_COMPACTOR', 'kN', 2),
  ('roller.gap_mm', 'EQUIPMENT', 'ROLLER_COMPACTOR', 'mm', 2),
  ('roller.speed_rpm', 'EQUIPMENT', 'ROLLER_COMPACTOR', 'rpm', 1),
  ('roller.feed_screw_rpm', 'EQUIPMENT', 'ROLLER_COMPACTOR', 'rpm', 1),
  ('roller.vacuum_mbar', 'EQUIPMENT', 'ROLLER_COMPACTOR', 'mbar', 0),
  ('roller.mill_rpm', 'EQUIPMENT', 'ROLLER_COMPACTOR', 'rpm', 0),
  ('layer1.fill_depth_mm', 'EQUIPMENT', 'PRESS', 'mm', 2),
  ('layer1.tamp_kN', 'EQUIPMENT', 'PRESS', 'kN', 2),
  ('layer2.fill_depth_mm', 'EQUIPMENT', 'PRESS', 'mm', 2),
  ('layer2.tamp_kN', 'EQUIPMENT', 'PRESS', 'kN', 2),
  ('blister.form_temp_C', 'EQUIPMENT', 'BLISTER_MACHINE', 'degC', 1),
  ('blister.seal_temp_C', 'EQUIPMENT', 'BLISTER_MACHINE', 'degC', 1),
  ('blister.seal_pressure_bar', 'EQUIPMENT', 'BLISTER_MACHINE', 'bar', 2),
  ('blister.seal_dwell_s', 'EQUIPMENT', 'BLISTER_MACHINE', 's', 2),
  ('blister.speed_cpm', 'EQUIPMENT', 'BLISTER_MACHINE', '/min', 0),
  ('blister.cycles', 'EQUIPMENT', 'BLISTER_MACHINE', 'count', 0),
  ('bottle.speed_bpm', 'EQUIPMENT', 'BOTTLE_LINE', '/min', 0),
  ('bottle.induction_power_pct', 'EQUIPMENT', 'BOTTLE_LINE', '%', 1),
  ('bottle.count', 'EQUIPMENT', 'BOTTLE_LINE', 'count', 0),
  ('bottle.reject_count', 'EQUIPMENT', 'BOTTLE_LINE', 'count', 0),
  ('cartoner.speed_cpm', 'EQUIPMENT', 'CARTONER', '/min', 0),
  ('cartoner.count', 'EQUIPMENT', 'CARTONER', 'count', 0),
  ('cartoner.reject_count', 'EQUIPMENT', 'CARTONER', 'count', 0),
  ('room.temp_C', 'AREA', null, 'degC', 1),
  ('room.rh_pct', 'AREA', null, '%RH', 1);
select kernel.set_actor_context(null);

create table plant.alarm_code (
  source              text not null check (source in ('EBMR', 'OPCUA', 'EMS')),
  code                text not null check (code ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
  version             integer not null check (version >= 1),
  gmp_critical        boolean not null,
  deviation_required  boolean not null,
  description         text not null check (btrim(description) <> ''),
  recorded_by_person  uuid not null,
  recorded_by_account uuid not null,
  correlation_id      uuid not null,
  recorded_at         timestamptz not null default clock_timestamp(),
  primary key (source, code, version)
);
revoke all on plant.alarm_code from public;
select platform.enforce_db_time('plant.alarm_code', array['recorded_at']);
select kernel.register_audited_table('plant.alarm_code', 'plant_alarm_code', 'code', true);

-- ---------------------------------------------------------------------------------------------
-- The step binding
-- ---------------------------------------------------------------------------------------------

create table plant.step_equipment (
  batch_id        uuid not null references recipe.batch_execution (id),
  step            text not null check (btrim(step) <> '' and length(step) <= 200),
  equipment_id    uuid not null references plant.equipment (id),
  use_id          uuid not null references plant.equipment_use (id),
  person_id       uuid not null,
  account_id      uuid not null,
  correlation_id  uuid not null,
  bound_at        timestamptz not null default clock_timestamp(),
  primary key (batch_id, step, equipment_id)
);
create index step_equipment_by_unit on plant.step_equipment (equipment_id, bound_at);
revoke all on plant.step_equipment from public;
select platform.enforce_db_time('plant.step_equipment', array['bound_at']);
select kernel.register_audited_table('plant.step_equipment', 'plant_equipment', 'equipment_id', true);

-- ---------------------------------------------------------------------------------------------
-- The alarm log (DI-49)
-- ---------------------------------------------------------------------------------------------

create table plant.alarm (
  id                  uuid primary key default gen_random_uuid(),
  source              text not null check (source in ('EBMR', 'OPCUA', 'EMS')),
  occurrence_id       text not null check (occurrence_id ~ '^[\x21-\x7E]{1,128}$'),
  subject_kind        text not null check (subject_kind in ('EQUIPMENT', 'AREA')),
  equipment_id        uuid references plant.equipment (id),
  area_id             uuid references plant.area (id),
  alarm_code          text not null check (alarm_code ~ '^[A-Z][A-Z0-9_.-]{0,63}$'),
  -- The configuration that applied at the raise (null: the code was not configured, counted GMP-critical).
  code_version        integer,
  gmp_critical        boolean not null,
  deviation_required  boolean not null,
  severity            integer not null check (severity between 1 and 1000),
  tag                 text,
  value               text check (value is null or value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'),
  value_unit          text,
  limit_value         text check (limit_value is null or limit_value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'),
  limit_unit          text,
  limit_kind          text check (limit_kind is null or limit_kind in ('HIGH_HIGH', 'HIGH', 'LOW', 'LOW_LOW', 'DEVIATION', 'RATE', 'STATE')),
  message             text not null check (btrim(message) <> '' and length(message) <= 500),
  raised_source_us    bigint not null check (raised_source_us >= 0),
  inbound_message_id  uuid references platform.inbound_message (id),
  raised_by_person    uuid not null,
  raised_by_account   uuid not null,
  correlation_id      uuid not null,
  received_at         timestamptz not null default clock_timestamp(),
  unique (source, occurrence_id),
  check ((subject_kind = 'EQUIPMENT') = (equipment_id is not null and area_id is null)),
  check ((subject_kind = 'AREA') = (area_id is not null and equipment_id is null)),
  check ((value is null) = (value_unit is null)),
  check ((limit_value is null) = (limit_unit is null)),
  check (source <> 'EBMR' or inbound_message_id is null)
);
create index alarm_by_equipment on plant.alarm (equipment_id, received_at);
create index alarm_by_area on plant.alarm (area_id, received_at);
revoke all on plant.alarm from public;
select platform.enforce_db_time('plant.alarm', array['received_at']);
select kernel.register_audited_table('plant.alarm', 'plant_alarm', 'id', true);

create table plant.alarm_batch (
  alarm_id   uuid not null references plant.alarm (id),
  batch_id   uuid not null references recipe.batch_execution (id),
  step       text,
  bound_at   timestamptz not null default clock_timestamp(),
  primary key (alarm_id, batch_id)
);
create index alarm_batch_by_batch on plant.alarm_batch (batch_id, step);
revoke all on plant.alarm_batch from public;
select platform.enforce_db_time('plant.alarm_batch', array['bound_at']);
select kernel.register_audited_table('plant.alarm_batch', 'plant_alarm', 'alarm_id', true);

create table plant.alarm_transition (
  alarm_id            uuid not null references plant.alarm (id),
  transition          text not null check (transition in ('CLEARED', 'SOURCE_ACKNOWLEDGED')),
  source_us           bigint not null check (source_us >= 0),
  inbound_message_id  uuid references platform.inbound_message (id),
  recorded_at         timestamptz not null default clock_timestamp(),
  primary key (alarm_id, transition)
);
revoke all on plant.alarm_transition from public;
select platform.enforce_db_time('plant.alarm_transition', array['recorded_at']);
select kernel.register_audited_table('plant.alarm_transition', 'plant_alarm', 'alarm_id', true);

create table plant.alarm_ack (
  alarm_id        uuid primary key references plant.alarm (id),
  action_taken    text not null check (btrim(action_taken) <> '' and length(action_taken) <= 2000),
  comment         text check (comment is null or (btrim(comment) <> '' and length(comment) <= 2000)),
  deviation_ref   text check (deviation_ref is null or btrim(deviation_ref) <> ''),
  person_id       uuid not null,
  account_id      uuid not null,
  session_id      uuid not null,
  role_code       text,
  correlation_id  uuid not null,
  acked_at        timestamptz not null default clock_timestamp()
);
revoke all on plant.alarm_ack from public;
select platform.enforce_db_time('plant.alarm_ack', array['acked_at']);
select kernel.register_audited_table('plant.alarm_ack', 'plant_alarm', 'alarm_id', true);

create view plant.alarm_status as
  select a.*,
         c.source_us as cleared_source_us, c.recorded_at as cleared_at,
         s.source_us as source_acked_us, s.recorded_at as source_acked_at,
         k.action_taken, k.comment as ack_comment, k.deviation_ref, k.person_id as acked_by_person, k.role_code as acked_by_role, k.acked_at
  from plant.alarm a
  left join plant.alarm_transition c on c.alarm_id = a.id and c.transition = 'CLEARED'
  left join plant.alarm_transition s on s.alarm_id = a.id and s.transition = 'SOURCE_ACKNOWLEDGED'
  left join plant.alarm_ack k on k.alarm_id = a.id;

-- ---------------------------------------------------------------------------------------------
-- Equipment events in the batch context
-- ---------------------------------------------------------------------------------------------

create table plant.equipment_state_event (
  id                  uuid primary key default gen_random_uuid(),
  source              text not null check (source in ('EBMR', 'OPCUA')),
  event_id            text not null check (event_id ~ '^[\x21-\x7E]{1,128}$'),
  equipment_id        uuid not null references plant.equipment (id),
  kind                text not null check (kind in ('STATE_CHANGED', 'RECIPE_LOADED', 'RECIPE_MISMATCH', 'PHASE_STARTED', 'PHASE_ENDED', 'OPERATOR_ACTION', 'FAULT')),
  state               text check (state is null or state in ('IDLE', 'RUNNING', 'HELD', 'STOPPED', 'FAULTED', 'MAINTENANCE')),
  recipe_version      text,
  message             text not null check (btrim(message) <> '' and length(message) <= 500),
  occurred_source_us  bigint not null check (occurred_source_us >= 0),
  batch_id            uuid references recipe.batch_execution (id),
  step                text,
  inbound_message_id  uuid references platform.inbound_message (id),
  recorded_by_account uuid not null,
  correlation_id      uuid not null,
  received_at         timestamptz not null default clock_timestamp(),
  unique (source, event_id),
  check ((kind = 'STATE_CHANGED') = (state is not null)),
  check (kind not in ('RECIPE_LOADED', 'RECIPE_MISMATCH') or recipe_version is not null),
  check (step is null or batch_id is not null)
);
create index equipment_state_event_by_unit on plant.equipment_state_event (equipment_id, occurred_source_us);
create index equipment_state_event_by_batch on plant.equipment_state_event (batch_id, step);
revoke all on plant.equipment_state_event from public;
select platform.enforce_db_time('plant.equipment_state_event', array['received_at']);
select kernel.register_audited_table('plant.equipment_state_event', 'plant_equipment', 'equipment_id', true);

-- ---------------------------------------------------------------------------------------------
-- Native series (DI-32; the input of the analytics work's golden-batch profile and SPC)
-- ---------------------------------------------------------------------------------------------

create table plant.series (
  id                  uuid primary key default gen_random_uuid(),
  source              text not null check (source in ('OPCUA', 'EMS')),
  subject_kind        text not null check (subject_kind in ('EQUIPMENT', 'AREA')),
  equipment_id        uuid references plant.equipment (id),
  area_id             uuid references plant.area (id),
  tag                 text not null references plant.series_tag (tag),
  unit                text not null,
  chunk_no            bigint not null check (chunk_no >= 1),
  from_us             bigint not null check (from_us >= 0),
  to_us               bigint not null,
  sample_count        integer not null check (sample_count between 1 and 2000),
  -- The samples as received: [{sourceTime, serverTime, raw, value, status}, ...], raw values as text.
  samples             jsonb not null check (jsonb_typeof(samples) = 'array'),
  chunk_hash          text not null check (chunk_hash ~ '^[0-9a-f]{64}$'),
  inbound_message_id  uuid not null unique references platform.inbound_message (id),
  received_at         timestamptz not null default clock_timestamp(),
  check (to_us >= from_us),
  check ((subject_kind = 'EQUIPMENT') = (equipment_id is not null and area_id is null)),
  check ((subject_kind = 'AREA') = (area_id is not null and equipment_id is null))
);
create unique index series_chunk_no on plant.series (subject_kind, coalesce(equipment_id, area_id), tag, chunk_no);
create index series_by_time on plant.series (coalesce(equipment_id, area_id), tag, from_us);
revoke all on plant.series from public;
select platform.enforce_db_time('plant.series', array['received_at']);
select kernel.register_audited_table('plant.series', 'plant_series', 'id', true);

-- ---------------------------------------------------------------------------------------------
-- Original records of simple devices (DI-32)
-- ---------------------------------------------------------------------------------------------

create table plant.device_original (
  id               uuid primary key default gen_random_uuid(),
  equipment_id     uuid not null references plant.equipment (id),
  capture          text not null check (capture in ('TRANSMITTED', 'PRINTED_TICKET')),
  device_ref       text check (device_ref is null or device_ref ~ '^[\x21-\x7E]{1,128}$'),
  raw_output       text check (raw_output is null or length(raw_output) <= 4000),
  value            text not null check (value ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'),
  unit             text not null check (unit ~ '^[!-~]{1,16}$'),
  device_time_us   bigint check (device_time_us is null or device_time_us >= 0),
  ticket_sha256    text check (ticket_sha256 is null or ticket_sha256 ~ '^[0-9a-f]{64}$'),
  ticket_ref       text check (ticket_ref is null or btrim(ticket_ref) <> ''),
  batch_id         uuid not null references recipe.batch_execution (id),
  step             text not null check (btrim(step) <> ''),
  entry_ref        text check (entry_ref is null or btrim(entry_ref) <> ''),
  person_id        uuid not null,
  account_id       uuid not null,
  role_code        text,
  correlation_id   uuid not null,
  recorded_at      timestamptz not null default clock_timestamp(),
  -- TRANSMITTED: the raw output and the device's timestamp; the raw output states the shown value exactly.
  check (capture <> 'TRANSMITTED' or (raw_output is not null and device_time_us is not null and ticket_sha256 is null)),
  -- PRINTED_TICKET: the ticket (or its true copy) by hash and reference, linked to its entry.
  check (capture <> 'PRINTED_TICKET' or (ticket_sha256 is not null and ticket_ref is not null and entry_ref is not null))
);
create index device_original_by_batch on plant.device_original (batch_id, step);
revoke all on plant.device_original from public;
select platform.enforce_db_time('plant.device_original', array['recorded_at']);
select kernel.register_audited_table('plant.device_original', 'plant_equipment', 'equipment_id', true);

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

-- Whether raw text (decimal or exponent notation) states exactly the shown decimal (DI-32: never a rounding).
create function plant.raw_states_value(p_raw text, p_value text) returns boolean
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if p_raw is null or p_value is null or p_raw !~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]{1,3})?$'
     or p_value !~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$' then
    return false;
  end if;
  return p_raw::numeric = p_value::numeric;
end
$$;

-- The batches (and the step) a subject serves at instant p_at: for a unit, the batch of its use open at p_at and the
-- step the batch last bound to the unit at or before p_at; for a room or line, every batch occupying it at p_at (no step).
create function plant.batch_context_at(p_subject_kind text, p_equipment uuid, p_area uuid, p_at timestamptz)
returns table (batch_id uuid, step text)
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select u.batch_id,
         (select s.step from plant.step_equipment s
           where s.batch_id = u.batch_id and s.equipment_id = u.equipment_id and s.use_id = u.id and s.bound_at <= p_at
           order by s.bound_at desc limit 1)
  from plant.equipment_use_status u
  where p_subject_kind = 'EQUIPMENT' and u.equipment_id = p_equipment and u.started_at <= p_at and (u.ended_at is null or u.ended_at > p_at)
  union all
  select o.batch_id, null::text
  from plant.area_occupancy o left join plant.area_occupancy_end e on e.occupancy_id = o.id
  where p_subject_kind = 'AREA' and o.area_id = p_area and o.started_at <= p_at and (e.ended_at is null or e.ended_at > p_at)
$$;

create function plant.series_chunk_hash(p_kind text, p_code text, p_tag text, p_unit text, p_chunk_no text, p_samples jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to(concat_ws(E'\n', concat_ws('|', p_kind, p_code, p_tag, p_unit, p_chunk_no),
           (select string_agg(concat_ws('|', s ->> 'sourceTime', coalesce(s ->> 'serverTime', ''), s ->> 'raw', coalesce(s ->> 'value', ''), s ->> 'status'), E'\n' order by n)
              from jsonb_array_elements(p_samples) with ordinality x(s, n))), 'UTF8')), 'hex')
$$;

-- The subject a payload names: (kind, equipment id, area id); refuses an unknown code or a kind the system does not send.
create function plant.payload_subject(p jsonb, p_family text, p_system text) returns table (kind text, equipment_id uuid, area_id uuid)
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_kind text := p ->> 'subjectKind';
  v_id   uuid;
begin
  if (p_system = 'OPCUA' and v_kind is distinct from 'EQUIPMENT') or (p_system = 'EMS' and v_kind is distinct from 'AREA') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-%s-002 the %s sends data of %s, not of %s (wrong source)', p_family, p_system, case p_system when 'EMS' then 'rooms (AREA)' else 'units (EQUIPMENT)' end, coalesce(v_kind, 'nothing'));
  end if;
  if v_kind = 'EQUIPMENT' then
    select e.id into v_id from plant.equipment e where e.code = p ->> 'subjectCode';
  else
    select a.id into v_id from plant.area a where a.code = p ->> 'subjectCode';
  end if;
  if v_id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-%s-002 %s %s is not known to this installation (wrong unit or room)', p_family, lower(v_kind), coalesce(p ->> 'subjectCode', 'NULL'));
  end if;
  return query select v_kind, case when v_kind = 'EQUIPMENT' then v_id end, case when v_kind = 'AREA' then v_id end;
end
$$;

-- Refuses a source time later than the database's clock plus five minutes (a source clock running ahead).
create function plant.source_time_or_raise(p_us text, p_family text) returns bigint
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
begin
  if coalesce(p_us, '') !~ '^(0|[1-9][0-9]{0,15})$' then
    raise exception using errcode = 'P0001', message = format('EBMR-%s-001 malformed source time %s: epoch microseconds as text', p_family, coalesce(p_us, 'NULL'));
  end if;
  if p_us::bigint > (extract(epoch from clock_timestamp()) * 1000000)::bigint + 300000000 then
    raise exception using errcode = 'P0001', message = format('EBMR-%s-003 source time %s is more than five minutes ahead of the database clock', p_family, p_us);
  end if;
  return p_us::bigint;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Configuration and binding commands
-- ---------------------------------------------------------------------------------------------

create function plant.define_alarm_code(p_source text, p_code text, p_gmp_critical boolean, p_deviation_required boolean, p_description text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_ver   integer;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  if coalesce(p_source, '') not in ('EBMR', 'OPCUA', 'EMS') or coalesce(p_code, '') !~ '^[A-Z][A-Z0-9_.-]{0,63}$'
     or p_gmp_critical is null or p_deviation_required is null or coalesce(btrim(p_description), '') = '' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-ALM-030 an alarm code names its source (EBMR, OPCUA, EMS), a code, whether it is GMP-critical, whether a deviation must be cited, and a description (DI-49, DI-09)';
  end if;
  if p_deviation_required and not p_gmp_critical then
    raise exception using errcode = 'P0001', message = 'EBMR-ALM-031 an alarm that needs a deviation is GMP-critical (DI-49)';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('plant.alarm_code:' || p_source || ':' || p_code, 0));
  select coalesce(max(version), 0) + 1 into v_ver from plant.alarm_code where source = p_source and code = p_code;
  insert into plant.alarm_code (source, code, version, gmp_critical, deviation_required, description, recorded_by_person, recorded_by_account, correlation_id)
  values (p_source, p_code, v_ver, p_gmp_critical, p_deviation_required, p_description, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid,
          (v_actor ->> 'correlation_id')::uuid);
  return v_ver;
end
$$;

create function plant.bind_step_equipment(p_batch uuid, p_step text, p_equipment_code text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_actor jsonb;
  e       plant.equipment;
  u       plant.equipment_use_status;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  if coalesce(btrim(p_step), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-ALM-032 a step binding names the step';
  end if;
  select * into e from plant.equipment where code = p_equipment_code;
  select * into u from plant.equipment_use_status s where s.equipment_id = e.id and s.ended_at is null order by s.started_at desc limit 1;
  if e.id is null or u.id is null or u.batch_id <> p_batch then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ALM-033 unit %s is not in use by this batch: start its use first (DI-49)', coalesce(p_equipment_code, 'NULL'));
  end if;
  if exists (select 1 from plant.step_equipment where batch_id = p_batch and step = p_step and equipment_id = e.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-ALM-034 step %s is already bound to unit %s', p_step, e.code);
  end if;
  insert into plant.step_equipment (batch_id, step, equipment_id, use_id, person_id, account_id, correlation_id)
  values (p_batch, p_step, e.id, u.id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Raising alarms (owner-level core) and receiving them from OPC UA or the EMS
-- ---------------------------------------------------------------------------------------------

-- p: {source, occurrenceId, subjectKind, equipmentId | areaId, alarmCode, severity (text), tag, value, valueUnit,
--     limit, limitUnit, limitKind, message, raisedSourceUs (text), inboundMessageId}
-- Takes the code's configuration at the raise (an unconfigured code is GMP-critical) and binds the occurrence to the
-- batches the subject serves at the source time. Called by the receiving command below and by the bridge of the
-- tablets process alarms (builder B); never granted to the application.
create function plant.raise_alarm(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  v_actor jsonb := platform.require_actor();
  c       plant.alarm_code;
  v_id    uuid;
  v_us    bigint := (p ->> 'raisedSourceUs')::bigint;
begin
  if exists (select 1 from plant.alarm where source = p ->> 'source' and occurrence_id = p ->> 'occurrenceId') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ALM-004 alarm occurrence %s of the %s is already raised', p ->> 'occurrenceId', p ->> 'source');
  end if;
  select * into c from plant.alarm_code k where k.source = p ->> 'source' and k.code = p ->> 'alarmCode' order by k.version desc limit 1;
  insert into plant.alarm (source, occurrence_id, subject_kind, equipment_id, area_id, alarm_code, code_version, gmp_critical, deviation_required, severity,
                           tag, value, value_unit, limit_value, limit_unit, limit_kind, message, raised_source_us, inbound_message_id,
                           raised_by_person, raised_by_account, correlation_id)
  values (p ->> 'source', p ->> 'occurrenceId', p ->> 'subjectKind', (p ->> 'equipmentId')::uuid, (p ->> 'areaId')::uuid, p ->> 'alarmCode', c.version,
          coalesce(c.gmp_critical, true), coalesce(c.deviation_required, false), coalesce((p ->> 'severity')::integer, 500),
          p ->> 'tag', p ->> 'value', p ->> 'valueUnit', p ->> 'limit', p ->> 'limitUnit', p ->> 'limitKind', p ->> 'message', v_us,
          (p ->> 'inboundMessageId')::uuid, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  insert into plant.alarm_batch (alarm_id, batch_id, step)
  select v_id, x.batch_id, x.step
  from plant.batch_context_at(p ->> 'subjectKind', (p ->> 'equipmentId')::uuid, (p ->> 'areaId')::uuid, platform.epoch_us_to_timestamptz(v_us::text)) x;
  return v_id;
end
$$;

create function plant.receive_equipment_alarm(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, platform, iam, pg_temp as $$
declare
  v_out   jsonb;
  m       platform.inbound_message;
  p       jsonb;
  k       text;
  v_sys   text;
  s       record;
  v_us    bigint;
  v_alarm uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  if p_envelope ->> 'messageType' not in ('opcua.alarm', 'ems.alarm') then
    raise exception using errcode = 'P0001', message = format('EBMR-ALM-001 this command receives opcua.alarm and ems.alarm, not %s', coalesce(p_envelope ->> 'messageType', 'none'));
  end if;
  v_out := platform.accept_inbound_detail(p_envelope);
  if v_out ->> 'outcome' <> 'ACCEPTED' then
    return jsonb_build_object('outcome', 'DUPLICATE', 'messageId', v_out ->> 'messageId', 'applied', 'NOTHING (duplicate)');
  end if;
  select * into m from platform.inbound_message where id = (v_out ->> 'messageId')::uuid;
  v_sys := m.source_system;
  p := m.payload;
  for k in select jsonb_object_keys(p) loop
    if k not in ('subjectKind', 'subjectCode', 'occurrenceId', 'transition', 'alarmCode', 'severity', 'tag', 'value', 'limit', 'limitKind', 'message', 'occurredAt') then
      raise exception using errcode = 'P0001', message = format('EBMR-ALM-001 malformed alarm payload: unknown field %s', k);
    end if;
  end loop;
  if coalesce(p ->> 'occurrenceId', '') !~ '^[\x21-\x7E]{1,128}$' or coalesce(p ->> 'transition', '') not in ('RAISED', 'CLEARED', 'SOURCE_ACKNOWLEDGED')
     or coalesce(p ->> 'alarmCode', '') !~ '^[A-Z][A-Z0-9_.-]{0,63}$' or coalesce(p ->> 'severity', '') !~ '^([1-9][0-9]{0,2}|1000)$'
     or coalesce(btrim(p ->> 'message'), '') = '' or length(p ->> 'message') > 500
     or (jsonb_typeof(p -> 'value') = 'object' and coalesce(p -> 'value' ->> 'value', '') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$')
     or (jsonb_typeof(p -> 'limit') = 'object' and coalesce(p -> 'limit' ->> 'value', '') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$')
     or coalesce(p ->> 'limitKind', 'STATE') not in ('HIGH_HIGH', 'HIGH', 'LOW', 'LOW_LOW', 'DEVIATION', 'RATE', 'STATE')
     or ((p ->> 'limit') is null) <> (coalesce(p ->> 'limitKind', 'STATE') = 'STATE') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-ALM-001 malformed alarm payload: occurrenceId, transition RAISED|CLEARED|SOURCE_ACKNOWLEDGED, alarmCode, severity 1 to 1000, message, decimal value and limit, a limit exactly with a limit kind other than STATE';
  end if;
  v_us := plant.source_time_or_raise(p ->> 'occurredAt', 'ALM');
  select * into s from plant.payload_subject(p, 'ALM', v_sys);
  if p ->> 'transition' = 'RAISED' then
    v_alarm := plant.raise_alarm(jsonb_build_object(
      'source', v_sys, 'occurrenceId', p ->> 'occurrenceId', 'subjectKind', s.kind, 'equipmentId', s.equipment_id, 'areaId', s.area_id,
      'alarmCode', p ->> 'alarmCode', 'severity', p ->> 'severity', 'tag', p ->> 'tag', 'value', p -> 'value' ->> 'value', 'valueUnit', p -> 'value' ->> 'unit',
      'limit', p -> 'limit' ->> 'value', 'limitUnit', p -> 'limit' ->> 'unit', 'limitKind', p ->> 'limitKind', 'message', p ->> 'message',
      'raisedSourceUs', v_us::text, 'inboundMessageId', m.id));
    return jsonb_build_object('outcome', 'ACCEPTED', 'messageId', m.id, 'applied', 'RAISED', 'alarmId', v_alarm);
  end if;
  select a.id into v_alarm from plant.alarm a where a.source = v_sys and a.occurrence_id = p ->> 'occurrenceId'
     and coalesce(a.equipment_id, a.area_id) = coalesce(s.equipment_id, s.area_id);
  if v_alarm is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-ALM-005 %s of alarm occurrence %s, which was never raised here: the raise is missing or comes later', p ->> 'transition', p ->> 'occurrenceId');
  end if;
  if exists (select 1 from plant.alarm_transition where alarm_id = v_alarm and transition = p ->> 'transition') then
    raise exception using errcode = 'P0001', message = format('EBMR-ALM-004 alarm occurrence %s is already %s', p ->> 'occurrenceId', p ->> 'transition');
  end if;
  insert into plant.alarm_transition (alarm_id, transition, source_us, inbound_message_id) values (v_alarm, p ->> 'transition', v_us, m.id);
  return jsonb_build_object('outcome', 'ACCEPTED', 'messageId', m.id, 'applied', p ->> 'transition', 'alarmId', v_alarm);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The acknowledgment (DI-49: the disposition of an alarm)
-- ---------------------------------------------------------------------------------------------

create function plant.acknowledge_alarm(p_alarm uuid, p_action_taken text, p_comment text, p_deviation_ref text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, site, pg_temp as $$
declare
  v_actor jsonb;
  a       plant.alarm;
  v_batch uuid;
  b       record;
  v_why   text;
begin
  perform iam.assert_not_administrator();
  select * into a from plant.alarm where id = p_alarm for update;
  if a.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-ALM-011 there is no plant alarm %s', coalesce(p_alarm::text, 'NULL'));
  end if;
  select ab.batch_id into v_batch from plant.alarm_batch ab where ab.alarm_id = a.id order by ab.batch_id limit 1;
  v_actor := iam.require_permission('ALARM.ACKNOWLEDGE', case when v_batch is null then '{}'::jsonb else plant.batch_scope(v_batch) end);
  if v_actor ->> 'source' not in ('UI', 'API') then
    raise exception using errcode = 'P0001', message = 'EBMR-ALM-010 DI-49: an alarm is acknowledged by a person';
  end if;
  if exists (select 1 from plant.alarm_ack where alarm_id = a.id) then
    raise exception using errcode = 'P0001', message = format('EBMR-ALM-016 DI-49: alarm %s is already acknowledged', a.id);
  end if;
  if coalesce(btrim(p_action_taken), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-ALM-012 DI-49: an alarm is acknowledged with the action taken';
  end if;
  if a.gmp_critical and coalesce(btrim(p_comment), '') = '' then
    raise exception using errcode = 'P0001', message = format('EBMR-ALM-013 DI-49: alarm %s is GMP-critical; it is acknowledged only with a comment', a.alarm_code);
  end if;
  if a.deviation_required then
    if coalesce(btrim(p_deviation_ref), '') = '' then
      raise exception using errcode = 'P0001', message = format('EBMR-ALM-014 DI-49: alarm %s needs a deviation; cite its reference', a.alarm_code);
    end if;
    for b in select ab.batch_id from plant.alarm_batch ab where ab.alarm_id = a.id loop
      v_why := site.deviation_ref_problem(p_deviation_ref, 'LINK', b.batch_id);
      if v_why is not null then
        raise exception using errcode = 'P0001', message = format('EBMR-ALM-015 DI-49: the deviation %s', v_why);
      end if;
    end loop;
    if not exists (select 1 from plant.alarm_batch where alarm_id = a.id) and not exists (select 1 from site.deviation where ref = btrim(p_deviation_ref)) then
      raise exception using errcode = 'P0001', message = format('EBMR-ALM-015 DI-49: %s is not a deviation record of this installation', btrim(p_deviation_ref));
    end if;
  end if;
  insert into plant.alarm_ack (alarm_id, action_taken, comment, deviation_ref, person_id, account_id, session_id, role_code, correlation_id)
  values (a.id, btrim(p_action_taken), nullif(btrim(coalesce(p_comment, '')), ''), nullif(btrim(coalesce(p_deviation_ref, '')), ''),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid, v_actor ->> 'role_code',
          (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- Null when no GMP-critical alarm bound to the batch (and to the step, when given) awaits its acknowledgment; else why
-- (EBMR-ALM-020). Builder B calls it at the step signature and in review (as G-06 does for its own alarms).
create function plant.alarm_problem(p_batch uuid, p_step text) returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select 'EBMR-ALM-020 DI-49: GMP-critical alarm(s) await acknowledgment: ' || string_agg(a.alarm_code || ' (' || a.occurrence_id || ')', ', ' order by a.received_at)
  from plant.alarm a join plant.alarm_batch ab on ab.alarm_id = a.id
  where ab.batch_id = p_batch and (p_step is null or ab.step = p_step) and a.gmp_critical
    and not exists (select 1 from plant.alarm_ack k where k.alarm_id = a.id)
  having count(*) > 0
$$;

-- The batch's alarm log: each occurrence bound to a batch with the step it was bound to (review, DI-26).
create view plant.batch_alarm_log as
  select ab.batch_id, ab.step, s.* from plant.alarm_batch ab join plant.alarm_status s on s.id = ab.alarm_id;

-- Every alarm bound to a batch, oldest first by source time.
create function plant.batch_alarms(p_batch uuid) returns setof plant.batch_alarm_log
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select * from plant.batch_alarm_log where batch_id = p_batch order by raised_source_us, id
$$;

-- ---------------------------------------------------------------------------------------------
-- Equipment events and series
-- ---------------------------------------------------------------------------------------------

create function plant.receive_equipment_event(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, platform, iam, pg_temp as $$
declare
  v_out jsonb;
  m     platform.inbound_message;
  p     jsonb;
  k     text;
  e     plant.equipment;
  v_us  bigint;
  x     record;
  v_id  uuid;
  v_ctx jsonb := platform.require_actor();
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  if p_envelope ->> 'messageType' is distinct from 'opcua.equipment_event' then
    raise exception using errcode = 'P0001', message = format('EBMR-EQD-001 this command receives opcua.equipment_event, not %s', coalesce(p_envelope ->> 'messageType', 'none'));
  end if;
  v_out := platform.accept_inbound_detail(p_envelope);
  if v_out ->> 'outcome' <> 'ACCEPTED' then
    return jsonb_build_object('outcome', 'DUPLICATE', 'messageId', v_out ->> 'messageId', 'applied', 'NOTHING (duplicate)');
  end if;
  select * into m from platform.inbound_message where id = (v_out ->> 'messageId')::uuid;
  p := m.payload;
  for k in select jsonb_object_keys(p) loop
    if k not in ('equipmentCode', 'eventId', 'kind', 'state', 'recipeVersion', 'message', 'occurredAt') then
      raise exception using errcode = 'P0001', message = format('EBMR-EQD-001 malformed equipment event: unknown field %s', k);
    end if;
  end loop;
  if coalesce(p ->> 'eventId', '') !~ '^[\x21-\x7E]{1,128}$'
     or coalesce(p ->> 'kind', '') not in ('STATE_CHANGED', 'RECIPE_LOADED', 'RECIPE_MISMATCH', 'PHASE_STARTED', 'PHASE_ENDED', 'OPERATOR_ACTION', 'FAULT')
     or ((p ->> 'kind' = 'STATE_CHANGED') <> (p ->> 'state' is not null))
     or coalesce(p ->> 'state', 'IDLE') not in ('IDLE', 'RUNNING', 'HELD', 'STOPPED', 'FAULTED', 'MAINTENANCE')
     or (p ->> 'kind' in ('RECIPE_LOADED', 'RECIPE_MISMATCH') and coalesce(p ->> 'recipeVersion', '') !~ '^[\x21-\x7E]{1,64}$')
     or coalesce(btrim(p ->> 'message'), '') = '' or length(p ->> 'message') > 500 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-EQD-001 malformed equipment event: eventId, kind, a state exactly with STATE_CHANGED, a recipe version with a recipe event, and a message';
  end if;
  v_us := plant.source_time_or_raise(p ->> 'occurredAt', 'EQD');
  select * into e from plant.equipment where code = p ->> 'equipmentCode';
  if e.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-EQD-002 unit %s is not known to this installation (wrong unit)', coalesce(p ->> 'equipmentCode', 'NULL'));
  end if;
  if exists (select 1 from plant.equipment_state_event where source = 'OPCUA' and event_id = p ->> 'eventId') then
    raise exception using errcode = 'P0001', message = format('EBMR-EQD-004 equipment event %s is already recorded', p ->> 'eventId');
  end if;
  select * into x from plant.batch_context_at('EQUIPMENT', e.id, null, platform.epoch_us_to_timestamptz(v_us::text)) limit 1;
  insert into plant.equipment_state_event (source, event_id, equipment_id, kind, state, recipe_version, message, occurred_source_us, batch_id, step,
                                           inbound_message_id, recorded_by_account, correlation_id)
  values ('OPCUA', p ->> 'eventId', e.id, p ->> 'kind', p ->> 'state', p ->> 'recipeVersion', p ->> 'message', v_us, x.batch_id, x.step, m.id,
          (v_ctx ->> 'account_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  return jsonb_build_object('outcome', 'ACCEPTED', 'messageId', m.id, 'applied', 'RECORDED', 'eventId', v_id, 'batchId', x.batch_id, 'step', x.step);
end
$$;

create function plant.receive_series_chunk(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, platform, iam, pg_temp as $$
declare
  v_out   jsonb;
  m       platform.inbound_message;
  p       jsonb;
  k       text;
  s       record;
  t       plant.series_tag;
  smp     jsonb;
  v_prev  bigint := -1;
  v_from  bigint;
  v_to    bigint;
  v_n     integer;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  if p_envelope ->> 'messageType' not in ('opcua.series_chunk', 'ems.series_chunk') then
    raise exception using errcode = 'P0001', message = format('EBMR-EQD-001 this command receives opcua.series_chunk and ems.series_chunk, not %s', coalesce(p_envelope ->> 'messageType', 'none'));
  end if;
  v_out := platform.accept_inbound_detail(p_envelope);
  if v_out ->> 'outcome' <> 'ACCEPTED' then
    return jsonb_build_object('outcome', 'DUPLICATE', 'messageId', v_out ->> 'messageId', 'applied', 'NOTHING (duplicate)');
  end if;
  select * into m from platform.inbound_message where id = (v_out ->> 'messageId')::uuid;
  p := m.payload;
  for k in select jsonb_object_keys(p) loop
    if k not in ('subjectKind', 'subjectCode', 'tag', 'unit', 'chunkNo', 'samples', 'chunkHash') then
      raise exception using errcode = 'P0001', message = format('EBMR-EQD-001 malformed series chunk: unknown field %s', k);
    end if;
  end loop;
  if coalesce(p ->> 'chunkNo', '') !~ '^[1-9][0-9]{0,17}$' or jsonb_typeof(p -> 'samples') is distinct from 'array'
     or jsonb_array_length(p -> 'samples') not between 1 and 2000 or coalesce(p ->> 'chunkHash', '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-EQD-001 malformed series chunk: chunkNo, 1 to 2000 samples and the chunk''s SHA-256 are required';
  end if;
  select * into s from plant.payload_subject(p, 'EQD', m.source_system);
  select * into t from plant.series_tag where tag = p ->> 'tag';
  if t.tag is null or t.subject_kind <> s.kind or t.unit is distinct from p ->> 'unit' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-EQD-002 %s in %s is not a series tag of a %s in its unit (wrong tag)', coalesce(p ->> 'tag', 'NULL'), coalesce(p ->> 'unit', 'NULL'), lower(s.kind));
  end if;
  for smp in select x from jsonb_array_elements(p -> 'samples') x loop
    if jsonb_typeof(smp) <> 'object' or (select count(*) from jsonb_object_keys(smp) j where j not in ('sourceTime', 'serverTime', 'raw', 'value', 'status')) > 0
       or coalesce(smp ->> 'sourceTime', '') !~ '^(0|[1-9][0-9]{0,15})$' or coalesce(smp ->> 'serverTime', '0') !~ '^(0|[1-9][0-9]{0,15})$'
       or coalesce(smp ->> 'raw', '') = '' or length(smp ->> 'raw') > 64 or coalesce(smp ->> 'status', '') !~ '^0x[0-9A-F]{8}$' then
      raise exception using errcode = 'P0001', message = 'EBMR-EQD-001 malformed sample: sourceTime, serverTime or null, raw text, value or null, status 0xXXXXXXXX';
    end if;
    if (smp ->> 'sourceTime')::bigint <= v_prev then
      raise exception using errcode = 'P0001', message = 'EBMR-EQD-001 malformed series chunk: source times increase within a chunk';
    end if;
    v_prev := (smp ->> 'sourceTime')::bigint;
    -- DI-32: a shown value is exactly what the device sent; a BAD sample shows none.
    if smp ->> 'value' is not null and (substr(smp ->> 'status', 3, 1) in ('8', '9', 'A', 'B', 'C', 'D', 'E', 'F') or not plant.raw_states_value(smp ->> 'raw', smp ->> 'value')) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-EQD-001 DI-32: the shown value %s is not the raw value %s the device sent (or the sample is BAD)', smp ->> 'value', smp ->> 'raw');
    end if;
  end loop;
  if plant.series_chunk_hash(s.kind, p ->> 'subjectCode', p ->> 'tag', p ->> 'unit', p ->> 'chunkNo', p -> 'samples') <> p ->> 'chunkHash' then
    raise exception using errcode = 'P0001', message = 'EBMR-EQD-001 DI-32: the chunk hash does not match its samples';
  end if;
  v_from := (p -> 'samples' -> 0 ->> 'sourceTime')::bigint;
  v_to := v_prev;
  v_n := jsonb_array_length(p -> 'samples');
  perform plant.source_time_or_raise(v_to::text, 'EQD');
  perform pg_advisory_xact_lock(hashtextextended('plant.series:' || coalesce(s.equipment_id, s.area_id)::text || ':' || (p ->> 'tag'), 0));
  if exists (select 1 from plant.series x where coalesce(x.equipment_id, x.area_id) = coalesce(s.equipment_id, s.area_id) and x.tag = p ->> 'tag'
                and x.chunk_no = (p ->> 'chunkNo')::bigint) then
    raise exception using errcode = 'P0001', message = format('EBMR-EQD-004 chunk %s of %s on %s is already recorded', p ->> 'chunkNo', p ->> 'tag', p ->> 'subjectCode');
  end if;
  if exists (select 1 from plant.series x where coalesce(x.equipment_id, x.area_id) = coalesce(s.equipment_id, s.area_id) and x.tag = p ->> 'tag'
                and x.from_us <= v_to and x.to_us >= v_from) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-EQD-005 chunk %s of %s on %s overlaps a recorded chunk in source time', p ->> 'chunkNo', p ->> 'tag', p ->> 'subjectCode');
  end if;
  insert into plant.series (source, subject_kind, equipment_id, area_id, tag, unit, chunk_no, from_us, to_us, sample_count, samples, chunk_hash, inbound_message_id)
  values (m.source_system, s.kind, s.equipment_id, s.area_id, p ->> 'tag', p ->> 'unit', (p ->> 'chunkNo')::bigint, v_from, v_to, v_n, p -> 'samples',
          p ->> 'chunkHash', m.id)
  returning id into v_id;
  return jsonb_build_object('outcome', 'ACCEPTED', 'messageId', m.id, 'applied', 'RECORDED', 'seriesId', v_id, 'samples', v_n::text);
end
$$;

-- The chunks of `p_tag` recorded while the batch (and the step, when given) held the unit, or while it occupied the
-- room: by the binding windows, so every sample is in the context it was taken in (D-P6b-0-6).
create function plant.series_in_context(p_batch uuid, p_step text, p_tag text) returns setof plant.series
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  with w as (
    select u.equipment_id as subject_id, coalesce(sb.bound_at, u.started_at) as w_from,
           least(coalesce(u.ended_at, 'infinity'::timestamptz),
                 coalesce((select min(n.bound_at) from plant.step_equipment n where n.use_id = u.id and n.bound_at > sb.bound_at), 'infinity'::timestamptz)) as w_to
    from plant.equipment_use_status u
    left join plant.step_equipment sb on sb.use_id = u.id and sb.step = p_step
    where u.batch_id = p_batch and (p_step is null or sb.step is not null)
    union all
    select o.area_id, o.started_at, coalesce(e.ended_at, 'infinity'::timestamptz)
    from plant.area_occupancy o left join plant.area_occupancy_end e on e.occupancy_id = o.id
    where o.batch_id = p_batch and p_step is null
  )
  select distinct x.* from plant.series x join w on coalesce(x.equipment_id, x.area_id) = w.subject_id
  where x.tag = p_tag
    and platform.epoch_us_to_timestamptz(x.to_us::text) >= w.w_from and platform.epoch_us_to_timestamptz(x.from_us::text) < w.w_to
  order by x.from_us
$$;

-- ---------------------------------------------------------------------------------------------
-- Original records of simple devices (DI-32)
-- ---------------------------------------------------------------------------------------------

-- r: {equipmentCode, capture TRANSMITTED|PRINTED_TICKET, deviceRef, rawOutput, value, unit, deviceTimeUs, ticketSha256,
--     ticketRef, batchId, step, entryRef}
create function plant.record_device_original(r jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, platform, pg_temp as $$
declare
  v_actor jsonb := platform.require_actor();
  e       plant.equipment;
  v_batch uuid;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  if jsonb_typeof(r) is distinct from 'object' or coalesce(r ->> 'batchId', '') !~ '^[0-9a-f-]{36}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-EQD-010 DI-32: an original record names its batch';
  end if;
  v_batch := (r ->> 'batchId')::uuid;
  if v_actor ->> 'source' = 'INTEGRATION' then
    perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  else
    perform iam.require_permission('STEP.EXECUTE', plant.batch_scope(v_batch));
  end if;
  select * into e from plant.equipment where code = r ->> 'equipmentCode';
  if e.id is null or not exists (select 1 from recipe.batch_execution where id = v_batch) then
    raise exception using errcode = 'P0001', message = format('EBMR-EQD-011 DI-32: device %s or batch %s is not known to this installation', coalesce(r ->> 'equipmentCode', 'NULL'), v_batch);
  end if;
  if coalesce(r ->> 'capture', '') not in ('TRANSMITTED', 'PRINTED_TICKET') or coalesce(btrim(r ->> 'step'), '') = ''
     or coalesce(r ->> 'value', '') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$' or coalesce(r ->> 'unit', '') !~ '^[!-~]{1,16}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-EQD-012 DI-32: an original record states its capture (TRANSMITTED or PRINTED_TICKET), step, decimal value and unit';
  end if;
  if r ->> 'capture' = 'TRANSMITTED' then
    if r ->> 'rawOutput' is null or coalesce(r ->> 'deviceTimeUs', '') !~ '^(0|[1-9][0-9]{0,15})$' then
      raise exception using errcode = 'P0001', message = 'EBMR-EQD-013 DI-32: a transmitted value keeps the raw device output and the device timestamp';
    end if;
    if not plant.raw_states_value(btrim(r ->> 'rawOutput'), r ->> 'value') then
      raise exception using errcode = 'P0001',
        message = format('EBMR-EQD-014 DI-32: the raw output %s does not state the shown value %s exactly', r ->> 'rawOutput', r ->> 'value');
    end if;
  elsif coalesce(r ->> 'ticketSha256', '') !~ '^[0-9a-f]{64}$' or coalesce(btrim(r ->> 'ticketRef'), '') = '' or coalesce(btrim(r ->> 'entryRef'), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-EQD-015 DI-32: a printed ticket is kept (its SHA-256 and true-copy reference) and linked to its entry';
  end if;
  insert into plant.device_original (equipment_id, capture, device_ref, raw_output, value, unit, device_time_us, ticket_sha256, ticket_ref, batch_id, step, entry_ref,
                                     person_id, account_id, role_code, correlation_id)
  values (e.id, r ->> 'capture', r ->> 'deviceRef', r ->> 'rawOutput', r ->> 'value', r ->> 'unit', (r ->> 'deviceTimeUs')::bigint,
          case when r ->> 'capture' = 'PRINTED_TICKET' then r ->> 'ticketSha256' end, case when r ->> 'capture' = 'PRINTED_TICKET' then r ->> 'ticketRef' end,
          v_batch, r ->> 'step', r ->> 'entryRef', (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, v_actor ->> 'role_code',
          (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: the application reads the tables and runs the commands; it never writes a row directly.
-- ---------------------------------------------------------------------------------------------

revoke all on function plant.raise_alarm(jsonb), plant.payload_subject(jsonb, text, text), plant.source_time_or_raise(text, text)
  from public;
revoke all on function plant.raw_states_value(text, text), plant.batch_context_at(text, uuid, uuid, timestamptz),
  plant.series_chunk_hash(text, text, text, text, text, jsonb), plant.define_alarm_code(text, text, boolean, boolean, text),
  plant.bind_step_equipment(uuid, text, text), plant.receive_equipment_alarm(jsonb), plant.acknowledge_alarm(uuid, text, text, text),
  plant.alarm_problem(uuid, text), plant.batch_alarms(uuid), plant.receive_equipment_event(jsonb), plant.receive_series_chunk(jsonb),
  plant.series_in_context(uuid, text, text), plant.record_device_original(jsonb) from public;
grant select on plant.series_tag, plant.alarm_code, plant.step_equipment, plant.alarm, plant.alarm_batch, plant.alarm_transition, plant.alarm_ack,
  plant.alarm_status, plant.batch_alarm_log, plant.equipment_state_event, plant.series, plant.device_original to ebmr_app;
grant execute on function plant.raw_states_value(text, text), plant.batch_context_at(text, uuid, uuid, timestamptz),
  plant.series_chunk_hash(text, text, text, text, text, jsonb), plant.define_alarm_code(text, text, boolean, boolean, text),
  plant.bind_step_equipment(uuid, text, text), plant.receive_equipment_alarm(jsonb), plant.acknowledge_alarm(uuid, text, text, text),
  plant.alarm_problem(uuid, text), plant.batch_alarms(uuid), plant.receive_equipment_event(jsonb), plant.receive_series_chunk(jsonb),
  plant.series_in_context(uuid, text, text), plant.record_device_original(jsonb) to ebmr_app;

reset role;
