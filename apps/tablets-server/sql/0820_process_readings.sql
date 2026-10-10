-- Tablets server, Phase 3 slice 3a (D-S3-1; G-06, tablets spec K-06): process equipment behind the site gateway. Its
-- values, setpoint downloads and alarms, and how a G-06 step's entries stand on them (controls DI-31, DI-32, DI-49,
-- PR-14; ADR 0012: the rules hold when the application's own database credentials are used directly).
--
--   tab.process_tag              the tags of the press and the coater (integration-sdk process/tags.ts: unit, fraction
--                                digits, counter, setpoint), shipped by this migration; insert-only
--   tab.process_device           a press or coater (an INSTRUMENT of the device registry) a gateway enrolment serves,
--                                with its serial and kind (IAM.DEVICE_MANAGE; ended with a reason, never changed)
--   tab.process_reading          insert-only, audited: one value as the gateway read it (tag, decimal text and unit,
--                                quality, kind ACTUAL | SETPOINT_READBACK | ALARM | ALARM_CLEARED, source time, the
--                                gateway's per-device sequence and capture session), with the database time it was
--                                received; the gateway role writes it only through tab.ingest_process_readings
--   tab.step_device              which process device a G-06 step of a batch runs on (STEP.EXECUTE, once per step)
--   tab.setpoint_download        a setpoint a step asks to download: its value and unit come from the batch's MBR (the
--                                approved G-06 configuration), never from the caller (STEP.EXECUTE)
--   tab.setpoint_download_pickup the first time the gateway fetched a download
--   tab.setpoint_download_ack    the gateway's acknowledgement: APPLIED (read back equal), MISMATCH (read back other) or
--                                FAILED (not written, with why); a read-back names the SETPOINT_READBACK reading it sent,
--                                received after the gateway fetched the download, and confirms that download only
--   tab.process_alarm_ack        a person's acknowledgement of an ALARM reading of a step, with a comment, written with the
--                                step's ALARM_ACK entry in the same command (DI-49)
--   tab.process_reading_use      a reading is used by one entry at most, claimed in the command that records it
--
-- Ingestion (DI-31): a request is taken whole or refused whole (one INTEGRATION command, SITE_GATEWAY only). Each
-- reading names an active process device of the gateway's enrolment by serial, a tag of the device's kind in the tag's
-- unit with at most its fraction digits (a counter whole and never negative), a read-back only for a setpoint tag, and
-- the next sequence of that device on this gateway: the same sequence again with the same content is a duplicate
-- (taken, not stored again), with other content refused, a gap or a step back refused. A refusal rolls the request
-- back; the listener records it as a device alarm (tab.record_gateway_refusal). Nothing is dropped silently.
--
-- A G-06 entry captured from the equipment stands on its reading (trigger ac_tab_process_entry_readings on
-- recipe.execution_command, before insert, accepted and refused rows alike, as tablets 0300 for weighings): a
-- SETPOINT_READBACK, ACTUAL or ALARM entry with source EQUIPMENT names a reading that
--   * was claimed for it in this command (tab.claim_process_reading: by the row's person, account and session, under
--     the row's correlation id, since this transaction began, for this batch and step);
--   * is a reading of the device the step is bound to (tab.step_device), of the entry's kind;
--   * states exactly the entry's tag, value, unit and quality, received at the entry's receivedAtUs;
--   * for a read-back: is the read-back the gateway acknowledged for a download this step asked for.
-- An ALARM_ACK entry of an alarm captured from the equipment stands on the acknowledgement of that alarm's reading made
-- in this command by the row's person, with the entry's comment. EBMR-EXE-211. Whether the entry may be keyed by hand
-- (the MBR's fallback path) and what the block writes is recipe-core 0520's.
--
-- Privileges: the application role may only EXECUTE the SECURITY DEFINER functions (pg_temp last, ADR 0016) and SELECT
-- the tables; it never inserts, updates or deletes a row here directly.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Tags (shipped configuration)

create table tab.process_tag (
  tag             text primary key check (tag ~ '^[a-z][a-z0-9_]*(\.[a-zA-Z0-9_]+)+$'),
  equipment_kind  text not null check (equipment_kind in ('PRESS', 'COATER')),
  unit            text not null check (unit ~ '^[!-~]{1,16}$'),
  scale           integer not null check (scale between 0 and 6),
  counter         boolean not null,
  setpoint        boolean not null
);
create trigger aa_process_tag_insert_only before update or delete on tab.process_tag for each row execute function kernel.reject_mutation();
create trigger aa_process_tag_no_truncate before truncate on tab.process_tag for each statement execute function kernel.reject_mutation();

insert into tab.process_tag (tag, equipment_kind, unit, scale, counter, setpoint) values
  ('turret.speed_rpm', 'PRESS', 'rpm', 1, false, true),
  ('force.main_kN', 'PRESS', 'kN', 2, false, true),
  ('force.pre_kN', 'PRESS', 'kN', 2, false, true),
  ('fill.depth_mm', 'PRESS', 'mm', 2, false, true),
  ('tablet.count', 'PRESS', 'count', 0, true, false),
  ('reject.count', 'PRESS', 'count', 0, true, false),
  ('stroke.count', 'PRESS', 'count', 0, true, false),
  ('pan.speed_rpm', 'COATER', 'rpm', 1, false, true),
  ('inlet.temp_C', 'COATER', 'degC', 1, false, true),
  ('exhaust.temp_C', 'COATER', 'degC', 1, false, false),
  ('bed.temp_C', 'COATER', 'degC', 1, false, false),
  ('spray.rate_g_min', 'COATER', 'g/min', 1, false, true),
  ('atomisation.bar', 'COATER', 'bar', 2, false, true),
  ('airflow.m3_h', 'COATER', 'm3/h', 0, false, true);

-- ---------------------------------------------------------------------------------------------
-- Devices

create table tab.process_device (
  id                    uuid primary key default gen_random_uuid(),
  gateway_key_id        uuid not null references tab.gateway_key (id),
  instrument_device_id  uuid not null references iam.device (id),
  device_code           text not null,
  serial                text not null check (serial ~ '^[!#-~]{1,32}$'),
  equipment_kind        text not null check (equipment_kind in ('PRESS', 'COATER')),
  bound_by_person       uuid not null,
  bound_at              timestamptz not null default clock_timestamp(),
  ended_at              timestamptz,
  ended_reason          text
);
create unique index process_device_one_active on tab.process_device (instrument_device_id) where ended_at is null;
create unique index process_device_serial_active on tab.process_device (gateway_key_id, serial) where ended_at is null;

create function tab.process_device_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.ended_at is not null then
      raise exception using errcode = 'P0001', message = 'EBMR-DEV-120 a process device binding starts active';
    end if;
    return new;
  end if;
  if (new.id, new.gateway_key_id, new.instrument_device_id, new.device_code, new.serial, new.equipment_kind, new.bound_by_person, new.bound_at)
       is distinct from (old.id, old.gateway_key_id, old.instrument_device_id, old.device_code, old.serial, old.equipment_kind, old.bound_by_person, old.bound_at)
     or old.ended_at is not null or new.ended_at is null then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-120 a process device binding never changes; end it and bind again';
  end if;
  return new;
end
$$;
create trigger aa_process_device_guard before insert or update on tab.process_device for each row execute function tab.process_device_guard();
create trigger aa_process_device_no_delete before delete or truncate on tab.process_device for each statement execute function kernel.reject_mutation();
select kernel.register_audited_table('tab.process_device', 'gateway_key', 'gateway_key_id', false);

-- IAM.DEVICE_MANAGE: binds a press or coater (an active INSTRUMENT) to a gateway enrolment with the serial it reports.
create function tab.bind_process_device(p_gateway_key uuid, p_device_code text, p_serial text, p_kind text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor jsonb;
  v_dev   iam.device%rowtype;
  v_id    uuid;
begin
  -- Device configuration is the system administrator's (as tab.bind_instrument, 0250); no GMP record is written.
  v_actor := iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  if not exists (select 1 from tab.gateway_key where id = p_gateway_key and status = 'ACTIVE') then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-013 no active gateway key with this id';
  end if;
  select * into v_dev from iam.device where code = p_device_code;
  if not found or v_dev.device_class <> 'INSTRUMENT' or v_dev.status <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-014 %s is not an active INSTRUMENT in the registry', p_device_code);
  end if;
  insert into tab.process_device (gateway_key_id, instrument_device_id, device_code, serial, equipment_kind, bound_by_person)
  values (p_gateway_key, v_dev.id, v_dev.code, p_serial, p_kind, (v_actor ->> 'person_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function tab.end_process_device(p_binding uuid, p_reason_code text, p_reason_text text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_saved jsonb;
begin
  perform iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  v_saved := tab.with_reason_context(p_reason_code, p_reason_text);
  update tab.process_device set ended_at = clock_timestamp(), ended_reason = p_reason_text where id = p_binding and ended_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-120 no active process device binding with this id';
  end if;
  perform kernel.set_actor_context(v_saved);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Readings

create table tab.process_reading (
  id                  uuid primary key default gen_random_uuid(),
  process_device_id   uuid not null references tab.process_device (id),
  gateway_key_id      uuid not null references tab.gateway_key (id),
  device_code         text not null,
  serial              text not null,
  tag                 text not null references tab.process_tag (tag),
  kind                text not null check (kind in ('ACTUAL', 'SETPOINT_READBACK', 'ALARM', 'ALARM_CLEARED')),
  value               text not null check (tab.is_decimal_text(value)),
  unit                text not null,
  quality             text not null check (quality in ('GOOD', 'UNCERTAIN', 'BAD', 'STALE')),
  source_time_us      bigint not null check (source_time_us >= 0),
  seq                 bigint not null check (seq >= 1),
  gateway_run_id      uuid not null,
  received_at         timestamptz not null default clock_timestamp(),
  received_us         bigint not null,
  ingest_session_id   uuid not null,
  correlation_id      uuid not null,
  unique (gateway_key_id, serial, seq)
);
create index process_reading_by_device on tab.process_reading (process_device_id, received_at);
select kernel.register_audited_table('tab.process_reading', 'process_reading', 'id', true);

-- The last sequence the server holds for a device serial on a gateway enrolment (0 when none).
create function tab.process_head(p_gateway_key uuid, p_serial text) returns bigint
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(max(seq), 0) from tab.process_reading where gateway_key_id = p_gateway_key and serial = p_serial
$$;

-- DI-31 (INTEGRATION command, SITE_GATEWAY, INTERFACE.WRITE): a process-readings request (integration-sdk
-- ProcessReadingsRequest), taken whole or refused whole (header).
create function tab.ingest_process_readings(p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor    jsonb;
  v_key      tab.gateway_key%rowtype;
  v_dev      tab.process_device%rowtype;
  v_inst     iam.device%rowtype;
  v_tag      tab.process_tag%rowtype;
  v_old      tab.process_reading%rowtype;
  v_run      uuid;
  r          jsonb;
  n          bigint;
  v_seq      bigint;
  v_src      bigint;
  v_head     bigint;
  v_id       uuid;
  v_now      timestamptz := clock_timestamp();
  v_out      jsonb := '[]'::jsonb;
  v_where    text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key := tab.actor_gateway_key();
  if jsonb_typeof(p_body) is distinct from 'object' or (p_body ->> 'sessionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(p_body -> 'readings') is distinct from 'array' or jsonb_array_length(p_body -> 'readings') not between 1 and 200
     or exists (select 1 from jsonb_object_keys(p_body) k where k not in ('sessionId', 'readings')) then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-121 DI-31: the process readings are not in the expected form (sessionId and 1 to 200 readings)';
  end if;
  v_run := (p_body ->> 'sessionId')::uuid;
  -- Serialise ingestion per gateway enrolment: the heads are read under this lock.
  perform 1 from tab.gateway_key where id = v_key.id for update;
  for r, n in select x.v, x.i from jsonb_array_elements(p_body -> 'readings') with ordinality x (v, i) order by x.i loop
    v_where := format('reading %s', n - 1);
    if jsonb_typeof(r) is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(r) k where k not in ('deviceSerial', 'tag', 'value', 'unit', 'quality', 'sourceTime', 'sequence', 'kind'))
       or jsonb_typeof(r -> 'deviceSerial') is distinct from 'string' or jsonb_typeof(r -> 'tag') is distinct from 'string'
       or jsonb_typeof(r -> 'value') is distinct from 'string' or not tab.is_decimal_text(r ->> 'value')
       or jsonb_typeof(r -> 'unit') is distinct from 'string'
       or (r ->> 'quality') is null or (r ->> 'quality') not in ('GOOD', 'UNCERTAIN', 'BAD', 'STALE')
       or (r ->> 'kind') is null or (r ->> 'kind') not in ('ACTUAL', 'SETPOINT_READBACK', 'ALARM', 'ALARM_CLEARED')
       or (r ->> 'sourceTime') !~ '^(0|[1-9][0-9]{0,17})$' or (r ->> 'sequence') !~ '^[1-9][0-9]{0,17}$' then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-121 DI-31: %s is not a process reading in the expected form', v_where);
    end if;
    v_seq := (r ->> 'sequence')::bigint;
    v_src := (r ->> 'sourceTime')::bigint;
    select * into v_dev from tab.process_device where gateway_key_id = v_key.id and serial = r ->> 'deviceSerial' and ended_at is null;
    if not found then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-122 DI-20: %s names serial %s, which is no process device of gateway %s', v_where, r ->> 'deviceSerial', v_key.gateway_code);
    end if;
    select * into v_inst from iam.device where id = v_dev.instrument_device_id;
    if v_inst.status <> 'ACTIVE' or v_inst.device_class <> 'INSTRUMENT' then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-123 DI-20: process device %s is %s', v_dev.device_code, v_inst.status);
    end if;
    select * into v_tag from tab.process_tag where tag = r ->> 'tag';
    if not found or v_tag.equipment_kind <> v_dev.equipment_kind then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-124 DI-31: %s names tag %s, which is no tag of a %s', v_where, left(r ->> 'tag', 64), lower(v_dev.equipment_kind));
    end if;
    if (r ->> 'unit') is distinct from v_tag.unit then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-125 DI-31: %s states %s in %s; the tag is in %s', v_where, v_tag.tag, left(r ->> 'unit', 16), v_tag.unit);
    end if;
    if scale((r ->> 'value')::numeric) > v_tag.scale or (v_tag.counter and ((r ->> 'value')::numeric < 0 or scale((r ->> 'value')::numeric) > 0)) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-126 DI-31: %s states %s = %s, more than its %s fraction digits%s', v_where, v_tag.tag, r ->> 'value', v_tag.scale,
                         case when v_tag.counter then ' or not a whole count' else '' end);
    end if;
    if r ->> 'kind' = 'SETPOINT_READBACK' and not v_tag.setpoint then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-127 DI-31: %s reads back %s, which takes no setpoint', v_where, v_tag.tag);
    end if;
    select * into v_old from tab.process_reading where gateway_key_id = v_key.id and serial = v_dev.serial and seq = v_seq;
    if found then
      if (v_old.tag, v_old.kind, v_old.value, v_old.unit, v_old.quality, v_old.source_time_us, v_old.gateway_run_id)
           is distinct from (r ->> 'tag', r ->> 'kind', r ->> 'value', r ->> 'unit', r ->> 'quality', v_src, v_run) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-DEV-128 DI-31: sequence %s of %s was already received with other content', v_seq, v_dev.serial);
      end if;
      v_out := v_out || jsonb_build_object('deviceSerial', v_dev.serial, 'sequence', v_seq::text, 'outcome', 'DUPLICATE', 'readingId', v_old.id);
      continue;
    end if;
    v_head := tab.process_head(v_key.id, v_dev.serial);
    if v_head > 0 and v_seq <> v_head + 1 then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-129 DI-31: sequence break for %s: the server holds up to %s, the reading is %s', v_dev.serial, v_head, v_seq);
    end if;
    insert into tab.process_reading (process_device_id, gateway_key_id, device_code, serial, tag, kind, value, unit, quality, source_time_us, seq,
                                     gateway_run_id, received_at, received_us, ingest_session_id, correlation_id)
    values (v_dev.id, v_key.id, v_dev.device_code, v_dev.serial, v_tag.tag, r ->> 'kind', r ->> 'value', r ->> 'unit', r ->> 'quality', v_src, v_seq,
            v_run, v_now, platform.epoch_micros(v_now), (v_actor ->> 'session_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
    returning id into v_id;
    v_out := v_out || jsonb_build_object('deviceSerial', v_dev.serial, 'sequence', v_seq::text, 'outcome', 'INGESTED', 'readingId', v_id);
  end loop;
  perform kernel.audit_business_event('gateway_key:' || v_key.id,
    format('Process readings from gateway %s: %s received', v_key.gateway_code, jsonb_array_length(v_out)),
    jsonb_build_object('gateway_run_id', v_run, 'readings', v_out));
  return jsonb_build_object('receivedUs', platform.epoch_micros(v_now)::text, 'readings', v_out);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The device a G-06 step runs on

create table tab.step_device (
  batch_id           uuid not null references recipe.batch_execution (id),
  step               text not null check (btrim(step) <> ''),
  process_device_id  uuid not null references tab.process_device (id),
  person_id          uuid not null,
  account_id         uuid not null,
  session_id         uuid not null,
  correlation_id     uuid not null,
  bound_at           timestamptz not null default clock_timestamp(),
  primary key (batch_id, step)
);
select kernel.register_audited_table('tab.step_device', 'process_reading', 'batch_id', true);

-- The G-06 phase p_step of batch p_batch's MBR; refuses anything else.
create function tab.g06_step_node(p_batch uuid, p_step text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_node jsonb := recipe.step_node(recipe.batch_mbr_content(p_batch), p_step);
begin
  if v_node is null or v_node -> 'block' ->> 'type' is distinct from 'G-06' then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-130 %s is not an automated equipment step (G-06) of this batch', coalesce(p_step, 'NULL'));
  end if;
  return v_node;
end
$$;

-- STEP.EXECUTE (the batch's product and site): the process device step p_step of batch p_batch runs on; once per step.
create function tab.bind_step_device(p_batch uuid, p_step text, p_device_code text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, recipe, plant, pg_temp as $$
declare
  v_actor jsonb;
  v_dev   tab.process_device%rowtype;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  perform tab.g06_step_node(p_batch, p_step);
  select * into v_dev from tab.process_device where device_code = p_device_code and ended_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-131 %s is no active process device', coalesce(p_device_code, 'NULL'));
  end if;
  if exists (select 1 from tab.step_device where batch_id = p_batch and step = p_step) then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-131 step %s of this batch is already bound to a process device', p_step);
  end if;
  insert into tab.step_device (batch_id, step, process_device_id, person_id, account_id, session_id, correlation_id)
  values (p_batch, p_step, v_dev.id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid,
          (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- DI-31, PR-14: whether the link to the device step p_step of batch p_batch runs on is lost. Process devices are not
-- in the gateway's heartbeat and an offline device sends nothing, so the loss is read from readings that stop
-- arriving: lost when the device has sent no reading for longer than the step's stale age (the G-06 configuration's
-- maxAgeSeconds, default 60 s), at database time. The server records INTERFACE_LOSS on the step from this answer.
create function tab.step_link_status(p_batch uuid, p_step text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_node  jsonb := tab.g06_step_node(p_batch, p_step);
  v_bind  tab.step_device%rowtype;
  v_last  bigint;
  v_now   bigint := platform.epoch_micros(clock_timestamp());
  v_max   numeric := recipe.g06_max_age_us(coalesce(v_node -> 'config', '{}'::jsonb));
begin
  select * into v_bind from tab.step_device where batch_id = p_batch and step = p_step;
  if not found then
    return jsonb_build_object('bound', false, 'lost', true);
  end if;
  select max(received_us) into v_last from tab.process_reading where process_device_id = v_bind.process_device_id;
  return jsonb_build_object('bound', true, 'deviceCode', (select device_code from tab.process_device where id = v_bind.process_device_id),
                            'lastReceivedUs', v_last::text, 'maxAgeUs', v_max::text, 'nowUs', v_now::text,
                            'lost', v_last is null or v_now - v_last > v_max);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Setpoint downloads

create table tab.setpoint_download (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null references recipe.batch_execution (id),
  step               text not null,
  process_device_id  uuid not null references tab.process_device (id),
  tag                text not null references tab.process_tag (tag),
  value              text not null check (tab.is_decimal_text(value)),
  unit               text not null,
  person_id          uuid not null,
  account_id         uuid not null,
  session_id         uuid not null,
  correlation_id     uuid not null,
  requested_at       timestamptz not null default clock_timestamp()
);
select kernel.register_audited_table('tab.setpoint_download', 'process_reading', 'id', true);

create table tab.setpoint_download_pickup (
  download_id        uuid primary key references tab.setpoint_download (id),
  ingest_session_id  uuid not null,
  picked_up_at       timestamptz not null default clock_timestamp()
);
select kernel.register_audited_table('tab.setpoint_download_pickup', 'process_reading', 'download_id', true);

create table tab.setpoint_download_ack (
  download_id        uuid primary key references tab.setpoint_download (id),
  outcome            text not null check (outcome in ('APPLIED', 'MISMATCH', 'FAILED')),
  readback_reading   uuid unique references tab.process_reading (id),
  message            text check (message is null or btrim(message) <> ''),
  gateway_run_id     uuid not null,
  ingest_session_id  uuid not null,
  correlation_id     uuid not null,
  acked_at           timestamptz not null default clock_timestamp(),
  check ((outcome = 'FAILED') = (readback_reading is null)),
  check (outcome <> 'FAILED' or message is not null)
);
select kernel.register_audited_table('tab.setpoint_download_ack', 'process_reading', 'download_id', true);

-- STEP.EXECUTE: step p_step of batch p_batch asks for its setpoint p_tag to be downloaded to the step's device. The value
-- and unit are the MBR's (the approved G-06 configuration); one download of a tag waits at a time.
create function tab.request_setpoint_download(p_batch uuid, p_step text, p_tag text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, recipe, plant, pg_temp as $$
declare
  v_actor jsonb;
  v_node  jsonb;
  v_sp    jsonb;
  v_bind  tab.step_device%rowtype;
  v_tag   tab.process_tag%rowtype;
  v_dev   tab.process_device%rowtype;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  v_node := tab.g06_step_node(p_batch, p_step);
  select s.v into v_sp from jsonb_array_elements(case when jsonb_typeof(v_node -> 'config' -> 'setpoints') = 'array' then v_node -> 'config' -> 'setpoints' else '[]'::jsonb end) with ordinality s (v, i)
   where s.v ->> 'tag' = p_tag order by s.i limit 1;
  if v_sp is null then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-132 PR-14: %s is not a setpoint the MBR approves for step %s', coalesce(p_tag, 'NULL'), p_step);
  end if;
  select * into v_bind from tab.step_device where batch_id = p_batch and step = p_step;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-133 step %s of this batch is bound to no process device', p_step);
  end if;
  select * into v_dev from tab.process_device where id = v_bind.process_device_id;
  select * into v_tag from tab.process_tag where tag = p_tag;
  if v_dev.ended_at is not null or v_tag.tag is null or not v_tag.setpoint or v_tag.equipment_kind <> v_dev.equipment_kind or v_tag.unit is distinct from v_sp ->> 'unit' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-132 DI-31: %s in %s is no setpoint the bound %s %s takes', p_tag, coalesce(v_sp ->> 'unit', '?'), lower(v_dev.equipment_kind), v_dev.device_code);
  end if;
  if exists (select 1 from tab.setpoint_download d where d.process_device_id = v_dev.id and d.tag = p_tag
                and not exists (select 1 from tab.setpoint_download_ack a where a.download_id = d.id)) then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-134 a download of %s to %s is still waiting for the gateway', p_tag, v_dev.device_code);
  end if;
  insert into tab.setpoint_download (batch_id, step, process_device_id, tag, value, unit, person_id, account_id, session_id, correlation_id)
  values (p_batch, p_step, v_dev.id, p_tag, v_sp ->> 'value', v_sp ->> 'unit', (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid,
          (v_actor ->> 'session_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

-- INTEGRATION command (SITE_GATEWAY, INTERFACE.WRITE): the downloads waiting for the gateway's devices; the first fetch
-- of each is recorded.
create function tab.pending_setpoint_downloads() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  v_actor jsonb;
  v_key   tab.gateway_key%rowtype;
  v_out   jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key := tab.actor_gateway_key();
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'deviceSerial', p.serial, 'tag', d.tag, 'value', d.value, 'unit', d.unit) order by d.requested_at, d.id), '[]'::jsonb)
    into v_out
    from tab.setpoint_download d join tab.process_device p on p.id = d.process_device_id
   where p.gateway_key_id = v_key.id and p.ended_at is null and not exists (select 1 from tab.setpoint_download_ack a where a.download_id = d.id);
  insert into tab.setpoint_download_pickup (download_id, ingest_session_id)
  select (x ->> 'id')::uuid, (v_actor ->> 'session_id')::uuid from jsonb_array_elements(v_out) x
  on conflict (download_id) do nothing;
  return jsonb_build_object('downloads', v_out);
end
$$;

-- INTEGRATION command (SITE_GATEWAY, INTERFACE.WRITE): the gateway's acknowledgement of download p_id (integration-sdk
-- SetpointAckRequest). A read-back names the SETPOINT_READBACK reading the gateway sent for it (device, tag, sequence,
-- value, unit, source time); APPLIED only when it equals the download, MISMATCH only when it does not, FAILED with a
-- message and no read-back. The same acknowledgement again is taken; another one is refused.
create function tab.ack_setpoint_download(p_id uuid, p_ack jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  v_actor  jsonb;
  v_key    tab.gateway_key%rowtype;
  d        tab.setpoint_download%rowtype;
  v_dev    tab.process_device%rowtype;
  v_rb     tab.process_reading%rowtype;
  v_old    tab.setpoint_download_ack%rowtype;
  v_out    text := p_ack ->> 'outcome';
  v_msg    text := case when jsonb_typeof(p_ack -> 'message') = 'string' then p_ack ->> 'message' end;
  v_rbj    jsonb := case when jsonb_typeof(p_ack -> 'readback') = 'object' then p_ack -> 'readback' end;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key := tab.actor_gateway_key();
  select * into d from tab.setpoint_download where id = p_id;
  select * into v_dev from tab.process_device where id = d.process_device_id;
  if d.id is null or v_dev.gateway_key_id is distinct from v_key.id then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-135 DI-31: %s is no setpoint download of gateway %s', coalesce(p_id::text, 'NULL'), v_key.gateway_code);
  end if;
  if jsonb_typeof(p_ack) is distinct from 'object' or (p_ack ->> 'sessionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or v_out is null or v_out not in ('APPLIED', 'MISMATCH', 'FAILED')
     or (v_out = 'FAILED') <> (v_rbj is null) or (v_out = 'FAILED' and coalesce(btrim(v_msg), '') = '') then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-136 DI-31: the acknowledgement is not in the expected form (an outcome; a read-back unless FAILED; a message when FAILED)';
  end if;
  if v_rbj is not null then
    select * into v_rb from tab.process_reading
     where gateway_key_id = v_key.id and serial = v_dev.serial and seq::text = v_rbj ->> 'sequence';
    if v_rb.id is null or v_rb.kind <> 'SETPOINT_READBACK' or v_rb.tag <> d.tag or v_rb.value <> v_rbj ->> 'value' or v_rb.unit <> v_rbj ->> 'unit'
       or v_rb.source_time_us::text <> v_rbj ->> 'sourceTime' or v_rb.process_device_id <> d.process_device_id then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-137 DI-31: the read-back of download %s is not a SETPOINT_READBACK of %s on %s the server holds as stated (send the readings first)', p_id, d.tag, v_dev.device_code);
    end if;
    -- Review 3a finding 2: the read-back was received after the gateway fetched this download, and confirms no other.
    if v_rb.received_at < coalesce((select k.picked_up_at from tab.setpoint_download_pickup k where k.download_id = p_id), 'infinity'::timestamptz) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-146 DI-31: the read-back of download %s was received before the gateway fetched the download, so it does not show the download was written', p_id);
    end if;
    if exists (select 1 from tab.setpoint_download_ack k where k.readback_reading = v_rb.id and k.download_id <> p_id) then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-147 DI-31: the read-back of download %s already confirms another download', p_id);
    end if;
    if (v_out = 'APPLIED') <> (v_rb.unit = d.unit and v_rb.value::numeric = d.value::numeric) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-138 DI-31: download %s of %s %s read back %s %s, which is %s, not %s', p_id, d.value, d.unit, v_rb.value, v_rb.unit,
                         case when v_out = 'APPLIED' then 'a mismatch' else 'equal' end, lower(v_out));
    end if;
  end if;
  select * into v_old from tab.setpoint_download_ack where download_id = p_id;
  if found then
    if v_old.outcome = v_out and v_old.readback_reading is not distinct from v_rb.id and v_old.message is not distinct from v_msg then
      return jsonb_build_object('outcome', 'DUPLICATE', 'downloadId', p_id);
    end if;
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-139 DI-31: download %s was already acknowledged as %s', p_id, v_old.outcome);
  end if;
  insert into tab.setpoint_download_ack (download_id, outcome, readback_reading, message, gateway_run_id, ingest_session_id, correlation_id)
  values (p_id, v_out, v_rb.id, v_msg, (p_ack ->> 'sessionId')::uuid, (v_actor ->> 'session_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return jsonb_build_object('outcome', 'ACKNOWLEDGED', 'downloadId', p_id);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Alarm acknowledgements and the use of readings by entries

create table tab.process_alarm_ack (
  reading_id      uuid primary key references tab.process_reading (id),
  batch_id        uuid not null references recipe.batch_execution (id),
  step            text not null,
  comment         text not null check (btrim(comment) <> ''),
  person_id       uuid not null,
  account_id      uuid not null,
  session_id      uuid not null,
  correlation_id  uuid not null,
  acked_at        timestamptz not null default clock_timestamp()
);
select kernel.register_audited_table('tab.process_alarm_ack', 'process_reading', 'reading_id', true);

-- Whether reading r was received while binding b held its device for its step: at or after the binding, and before any
-- later binding of the device by another batch (review 3a finding 3: a step never takes another batch's readings).
create function tab.reading_in_step(r tab.process_reading, b tab.step_device) returns boolean
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select r.id is not null and b.batch_id is not null and r.process_device_id = b.process_device_id and r.received_at >= b.bound_at
     and not exists (select 1 from tab.step_device s where s.process_device_id = b.process_device_id and s.batch_id <> b.batch_id
                        and s.bound_at > b.bound_at and s.bound_at <= r.received_at)
$$;

-- DI-49 (STEP.EXECUTE in the batch's scope, a person's command): acknowledges ALARM reading p_reading of step p_step of
-- batch p_batch once, with a comment and the action taken. The reading is an alarm of the step's device in the step's
-- window that an ALARM entry of the step recorded, and the acknowledgement is written with the step's ALARM_ACK entry in
-- the same command (deferred check below), so nobody acknowledges an alarm outside its batch record or ahead of it.
create function tab.acknowledge_process_alarm(p_reading uuid, p_batch uuid, p_step text, p_comment text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, plant, recipe, pg_temp as $$
declare
  v_actor jsonb;
  r       tab.process_reading%rowtype;
  v_bind  tab.step_device%rowtype;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  if v_actor ->> 'source' not in ('UI', 'API') then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-140 DI-49: an alarm is acknowledged by a person';
  end if;
  select * into r from tab.process_reading where id = p_reading;
  select * into v_bind from tab.step_device where batch_id = p_batch and step = p_step;
  if r.id is null or r.kind <> 'ALARM' or not tab.reading_in_step(r, v_bind)
     or not exists (select 1 from recipe.execution_command c
                     where c.batch_id = p_batch and c.kind = 'COMMAND' and c.accepted and c.command_type = 'RECORD_ENTRY' and c.command ->> 'step' = p_step
                       and c.command -> 'entry' ->> 'kind' = 'ALARM' and c.command -> 'entry' ->> 'readingId' = p_reading::text) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-141 DI-49: %s is no alarm of the device of step %s that an ALARM entry of the step recorded', coalesce(p_reading::text, 'NULL'), coalesce(p_step, 'NULL'));
  end if;
  if coalesce(btrim(p_comment), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-142 DI-49: an alarm is acknowledged with a comment and the action taken';
  end if;
  if exists (select 1 from tab.process_alarm_ack where reading_id = p_reading) then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-143 DI-49: alarm %s is already acknowledged', p_reading);
  end if;
  insert into tab.process_alarm_ack (reading_id, batch_id, step, comment, person_id, account_id, session_id, correlation_id)
  values (p_reading, p_batch, p_step, p_comment, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid,
          (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- DI-49: at commit, an acknowledgement stands with the accepted ALARM_ACK entry of its step in the same command.
create function tab.process_alarm_ack_entry_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
begin
  if not exists (select 1 from recipe.execution_command c
                  where c.batch_id = new.batch_id and c.correlation_id = new.correlation_id and c.kind = 'COMMAND' and c.accepted
                    and c.command_type = 'RECORD_ENTRY' and c.command ->> 'step' = new.step and c.command -> 'entry' ->> 'kind' = 'ALARM_ACK') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-148 DI-49: alarm %s is acknowledged only with the ALARM_ACK entry of step %s in the same command', new.reading_id, new.step);
  end if;
  return null;
end
$$;
create constraint trigger zz_process_alarm_ack_entry after insert on tab.process_alarm_ack deferrable initially deferred
  for each row execute function tab.process_alarm_ack_entry_check();

create table tab.process_reading_use (
  reading_id      uuid primary key references tab.process_reading (id),
  batch_id        uuid not null,
  step            text not null,
  person_id       uuid not null,
  account_id      uuid not null,
  session_id      uuid not null,
  correlation_id  uuid not null,
  claimed_at      timestamptz not null default clock_timestamp()
);
select kernel.register_audited_table('tab.process_reading_use', 'process_reading', 'reading_id', true);

-- DI-31, DI-32 (STEP.EXECUTE, a person's command): claims reading p_reading for an entry of step p_step of batch
-- p_batch: a reading the device sent while bound to the step (tab.reading_in_step), used by no other entry. Returns the facts the entry states.
create function tab.claim_process_reading(p_reading uuid, p_batch uuid, p_step text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, plant, pg_temp as $$
declare
  v_actor jsonb;
  r       tab.process_reading%rowtype;
  v_bind  tab.step_device%rowtype;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  select * into r from tab.process_reading where id = p_reading;
  select * into v_bind from tab.step_device where batch_id = p_batch and step = p_step;
  if not coalesce(tab.reading_in_step(r, v_bind), false) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-144 DI-32: %s is no reading the process device of step %s of this batch sent while bound to it', coalesce(p_reading::text, 'NULL'), p_step);
  end if;
  begin
    insert into tab.process_reading_use (reading_id, batch_id, step, person_id, account_id, session_id, correlation_id)
    values (p_reading, p_batch, p_step, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid,
            (v_actor ->> 'correlation_id')::uuid);
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-145 DI-32: reading %s is already used by an entry', p_reading);
  end;
  return jsonb_build_object('readingId', r.id, 'kind', r.kind, 'tag', r.tag, 'value', r.value, 'unit', r.unit, 'quality', r.quality,
                            'receivedAtUs', r.received_us::text, 'sourceTimeUs', r.source_time_us::text, 'deviceCode', r.device_code);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The binding of G-06 entries (header). EBMR-EXE-211.

create function tab.process_entry_problem(p_row recipe.execution_command) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_entry  jsonb := case when jsonb_typeof(p_row.command -> 'entry') = 'object' then p_row.command -> 'entry' end;
  v_kind   text := v_entry ->> 'kind';
  v_step   text := p_row.command ->> 'step';
  v_id     uuid;
  r        tab.process_reading%rowtype;
  u        tab.process_reading_use%rowtype;
  v_bind   tab.step_device%rowtype;
  v_alarm  jsonb;
  a        tab.process_alarm_ack%rowtype;
begin
  if v_kind = 'ALARM_ACK' then
    select s.state -> 'entries' -> (v_entry ->> 'alarm') into v_alarm from recipe.execution_state s where s.batch_id = p_row.batch_id;
    if v_alarm -> 'data' ->> 'source' is distinct from 'EQUIPMENT' then
      return null;
    end if;
    select * into a from tab.process_alarm_ack where reading_id::text = v_alarm -> 'data' ->> 'readingId';
    if a.reading_id is null or a.correlation_id <> p_row.correlation_id or a.person_id <> p_row.actor_person or a.acked_at < transaction_timestamp()
       or a.batch_id <> p_row.batch_id or a.step <> v_step then
      return format('the alarm reading %s was not acknowledged by this person in this command', coalesce(v_alarm -> 'data' ->> 'readingId', '(none)'));
    end if;
    if (v_entry ->> 'comment') is distinct from a.comment then
      return format('its comment is not the one the acknowledgement of alarm reading %s records', a.reading_id);
    end if;
    return null;
  end if;
  if v_kind is null or v_kind not in ('SETPOINT_READBACK', 'ACTUAL', 'ALARM') or v_entry ->> 'source' is distinct from 'EQUIPMENT' then
    return null;
  end if;
  if (v_entry ->> 'readingId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return 'it names no process reading';
  end if;
  v_id := (v_entry ->> 'readingId')::uuid;
  select * into r from tab.process_reading where id = v_id;
  select * into u from tab.process_reading_use where reading_id = v_id;
  select * into v_bind from tab.step_device where batch_id = p_row.batch_id and step = v_step;
  return case
    when r.id is null then format('reading %s does not exist', v_id)
    when u.reading_id is null or u.batch_id <> p_row.batch_id or u.step <> v_step or u.person_id <> p_row.actor_person or u.account_id <> p_row.actor_account
         or u.session_id <> p_row.session_id or u.correlation_id <> p_row.correlation_id or u.claimed_at < transaction_timestamp()
      then format('reading %s was not claimed for step %s by this person''s session in this command', v_id, coalesce(v_step, '(none)'))
    when not coalesce(tab.reading_in_step(r, v_bind), false)
      then format('reading %s is not one the process device of step %s sent while bound to it', v_id, coalesce(v_step, '(none)'))
    when r.kind <> v_kind then format('reading %s is %s, not %s', v_id, r.kind, v_kind)
    when (r.tag, r.value, r.unit, r.quality, r.received_us::text)
         is distinct from (v_entry ->> 'tag', v_entry ->> 'value', v_entry ->> 'unit', v_entry ->> 'quality', v_entry ->> 'receivedAtUs')
      then format('reading %s is %s = %s %s (%s, received at %s), not what the entry states', v_id, r.tag, r.value, r.unit, r.quality, r.received_us)
    when v_kind = 'SETPOINT_READBACK'
         and not exists (select 1 from tab.setpoint_download_ack k join tab.setpoint_download d on d.id = k.download_id
                          where k.readback_reading = v_id and d.batch_id = p_row.batch_id and d.step = v_step)
      then format('reading %s is no read-back the gateway acknowledged for a download this step asked for', v_id)
  end;
end
$$;

create function tab.process_entry_readings_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_problem text;
begin
  if new.kind <> 'COMMAND' or new.source not in ('UI', 'API') or new.command_type <> 'RECORD_ENTRY' then
    return new;
  end if;
  v_problem := tab.process_entry_problem(new);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('A value of an automated step recorded as captured from the equipment stands on the process reading claimed for it, of the step''s device, exactly as received: %s (DI-31, DI-32, DI-49). [EBMR-EXE-211]', v_problem);
  end if;
  return new;
end
$$;

create trigger ac_tab_process_entry_readings before insert on recipe.execution_command
  for each row execute function tab.process_entry_readings_check();

-- ---------------------------------------------------------------------------------------------
-- Privileges

revoke all on function tab.process_device_guard(), tab.bind_process_device(uuid, text, text, text), tab.end_process_device(uuid, text, text),
  tab.process_head(uuid, text), tab.ingest_process_readings(jsonb), tab.g06_step_node(uuid, text), tab.bind_step_device(uuid, text, text),
  tab.request_setpoint_download(uuid, text, text), tab.pending_setpoint_downloads(), tab.ack_setpoint_download(uuid, jsonb),
  tab.acknowledge_process_alarm(uuid, uuid, text, text), tab.claim_process_reading(uuid, uuid, text), tab.process_entry_problem(recipe.execution_command), tab.step_link_status(uuid, text),
  tab.process_entry_readings_check(), tab.reading_in_step(tab.process_reading, tab.step_device), tab.process_alarm_ack_entry_check() from public;
grant execute on function tab.bind_process_device(uuid, text, text, text), tab.end_process_device(uuid, text, text), tab.process_head(uuid, text),
  tab.ingest_process_readings(jsonb), tab.bind_step_device(uuid, text, text), tab.request_setpoint_download(uuid, text, text),
  tab.pending_setpoint_downloads(), tab.ack_setpoint_download(uuid, jsonb), tab.acknowledge_process_alarm(uuid, uuid, text, text),
  tab.claim_process_reading(uuid, uuid, text), tab.step_link_status(uuid, text) to ebmr_app;
revoke all on tab.process_tag, tab.process_device, tab.process_reading, tab.step_device, tab.setpoint_download, tab.setpoint_download_pickup,
  tab.setpoint_download_ack, tab.process_alarm_ack, tab.process_reading_use from public;
grant select on tab.process_tag, tab.process_device, tab.process_reading, tab.step_device, tab.setpoint_download, tab.setpoint_download_pickup,
  tab.setpoint_download_ack, tab.process_alarm_ack, tab.process_reading_use to ebmr_app;

reset role;
