-- Tablets server, Phase 6 slice 6b (builder A): process readings taken over OPC UA keep the device's original record
-- (DI-32) and stand on the identity of their endpoint (DI-20). Plan "Slice 6b", "Original device records and dynamic
-- data" (extended to OPC UA readings) and "Device identity"; docs/build-plan/phase-6/slice-6b-0-interfaces.md (D-P6b-0-1:
-- values of the released tags stay process readings on /gw/v1/process-readings, so G-06 entries stand on them as today).
--
-- Handbook: modules/tablets-server.md
--
--   tab.process_reading_native     insert-only, audited: the original record of a reading taken over OPC UA: the raw
--                                  value text as the server sent it, its status code, the source timestamp, the
--                                  endpoint and the session it came through. The reading's shown value states the raw
--                                  value exactly (never a rounding of it)
--   tab.ingest_opcua_readings(body) the gateway's command for a request whose readings carry `native`: each native
--                                  record is checked (DI-32 raw equals shown; the status agrees with the quality; the
--                                  endpoint named is the one enrolled for the device's unit and has a VALID session in
--                                  force, recipe-core 0961), then the readings go through tab.ingest_process_readings
--                                  (tablets 0820, unchanged rules) and the native records are kept with them
--   guard (deferred to commit)     a reading of a process device whose unit is served by an enrolled OPC UA endpoint has
--                                  its native record: such a reading cannot be sent the old way without one
--
-- Messages: EBMR-DEV-170 to 179. SECURITY DEFINER, owned by ebmr_owner, pg_temp last (ADR 0016); the application role
-- executes the command and reads the table, it never writes a row directly.

set local role ebmr_owner;

create table tab.process_reading_native (
  reading_id          uuid primary key references tab.process_reading (id),
  raw                 text not null check (raw ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]{1,3})?$' and length(raw) <= 40),
  status              text not null check (status ~ '^0x[0-9A-F]{8}$'),
  device_time_us      bigint not null check (device_time_us >= 0),
  endpoint_device_id  uuid not null references iam.device (id),
  endpoint_session_id uuid not null references plant.opcua_endpoint_session (id),
  recorded_at         timestamptz not null default clock_timestamp()
);
revoke all on tab.process_reading_native from public;
select platform.enforce_db_time('tab.process_reading_native', array['recorded_at']);
select kernel.register_audited_table('tab.process_reading_native', 'process_reading_native', 'reading_id', true);

-- The OPC UA quality of a status code: the two severity bits (GOOD 00, UNCERTAIN 01, BAD 1x).
create function tab.status_quality(p_status text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when substr(p_status, 3, 1) in ('0', '1', '2', '3') then 'GOOD' when substr(p_status, 3, 1) in ('4', '5', '6', '7') then 'UNCERTAIN' else 'BAD' end
$$;

-- The enrolled endpoint of the unit a process device is linked to, or null.
create function tab.process_device_endpoint(p_device uuid) returns plant.opcua_endpoint
language sql stable security definer set search_path = pg_catalog, tab, plant, pg_temp as $$
  select c.* from tab.process_device_unit du
  join plant.opcua_endpoint_unit eu on eu.equipment_id = du.equipment_id
  join plant.opcua_endpoint_current c on c.id = eu.endpoint_id and c.status = 'ENROLLED'
  where du.process_device_id = p_device
$$;

create function tab.ingest_opcua_readings(p_body jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, plant, iam, kernel, pg_temp as $$
declare
  v_key      tab.gateway_key%rowtype;
  r          jsonb;
  n          bigint;
  nat        jsonb;
  v_dev      tab.process_device%rowtype;
  v_ep       plant.opcua_endpoint;
  v_unit     uuid;
  v_problem  text;
  v_session  uuid;
  v_plain    jsonb := '[]'::jsonb;
  v_natives  jsonb := '[]'::jsonb;
  v_out      jsonb;
  o          jsonb;
  v_old      tab.process_reading_native%rowtype;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key := tab.actor_gateway_key();
  if jsonb_typeof(p_body) is distinct from 'object' or jsonb_typeof(p_body -> 'readings') is distinct from 'array' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-121 DI-31: the process readings are not in the expected form (sessionId and 1 to 200 readings)';
  end if;
  for r, n in select x.v, x.i from jsonb_array_elements(p_body -> 'readings') with ordinality x (v, i) order by x.i loop
    nat := r -> 'native';
    if nat is null then
      v_plain := v_plain || jsonb_build_array(r);
      v_natives := v_natives || jsonb_build_array(null::jsonb);
      continue;
    end if;
    if jsonb_typeof(nat) <> 'object' or exists (select 1 from jsonb_object_keys(nat) k where k not in ('raw', 'status', 'deviceTime', 'endpointCode'))
       or coalesce(nat ->> 'raw', '') !~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]{1,3})?$' or length(nat ->> 'raw') > 40
       or coalesce(nat ->> 'status', '') !~ '^0x[0-9A-F]{8}$' or coalesce(nat ->> 'deviceTime', '') !~ '^(0|[1-9][0-9]{0,17})$'
       or coalesce(nat ->> 'endpointCode', '') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$' then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-170 DI-32: reading %s carries no well-formed original record (raw, status, deviceTime, endpointCode)', n - 1);
    end if;
    -- DI-32: the shown value is what the device sent, exactly.
    if not tab.is_decimal_text(r ->> 'value') or not plant.raw_states_value(nat ->> 'raw', r ->> 'value') then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-172 DI-32: reading %s shows %s, which is not the raw value %s the device sent', n - 1, r ->> 'value', nat ->> 'raw');
    end if;
    if r ->> 'quality' is distinct from tab.status_quality(nat ->> 'status') and r ->> 'quality' is distinct from 'STALE' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-173 DI-32: reading %s is %s, but its status %s is %s', n - 1, r ->> 'quality', nat ->> 'status', tab.status_quality(nat ->> 'status'));
    end if;
    select * into v_dev from tab.process_device where gateway_key_id = v_key.id and serial = r ->> 'deviceSerial' and ended_at is null;
    if v_dev.id is not null then
      v_ep := tab.process_device_endpoint(v_dev.id);
      if v_ep.id is null or v_ep.device_code <> nat ->> 'endpointCode' then
        raise exception using errcode = 'P0001',
          message = format('EBMR-DEV-174 DI-20: reading %s names endpoint %s, which is not the enrolled endpoint of device %s', n - 1, nat ->> 'endpointCode', v_dev.device_code);
      end if;
      select equipment_id into v_unit from tab.process_device_unit where process_device_id = v_dev.id;
      v_problem := plant.opcua_unit_problem(v_unit, null, null);
      if v_problem is not null then
        raise exception using errcode = 'P0001', message = format('EBMR-DEV-175 %s (reading %s)', v_problem, n - 1);
      end if;
      select s.id into v_session from plant.opcua_endpoint_session s where s.device_id = v_ep.device_id order by s.received_at desc, s.sequence_no desc limit 1;
    end if;
    -- An unknown serial falls through to tablets 0820, which refuses it (EBMR-DEV-122).
    v_plain := v_plain || jsonb_build_array(r - 'native');
    v_natives := v_natives || jsonb_build_array(nat || jsonb_build_object('endpointDeviceId', v_ep.device_id, 'sessionId', v_session));
  end loop;
  v_out := tab.ingest_process_readings(jsonb_set(p_body, '{readings}', v_plain));
  for o, n in select x.v, x.i from jsonb_array_elements(v_out -> 'readings') with ordinality x (v, i) loop
    nat := v_natives -> (n - 1)::integer;
    if nat is null or jsonb_typeof(nat) = 'null' then
      continue;
    end if;
    if o ->> 'outcome' = 'DUPLICATE' then
      select * into v_old from tab.process_reading_native where reading_id = (o ->> 'readingId')::uuid;
      if v_old.reading_id is null or (v_old.raw, v_old.status, v_old.device_time_us) is distinct from (nat ->> 'raw', nat ->> 'status', (nat ->> 'deviceTime')::bigint) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-DEV-176 DI-31: sequence %s of %s was already received with another original record', o ->> 'sequence', o ->> 'deviceSerial');
      end if;
      continue;
    end if;
    insert into tab.process_reading_native (reading_id, raw, status, device_time_us, endpoint_device_id, endpoint_session_id)
    values ((o ->> 'readingId')::uuid, nat ->> 'raw', nat ->> 'status', (nat ->> 'deviceTime')::bigint, (nat ->> 'endpointDeviceId')::uuid, (nat ->> 'sessionId')::uuid);
  end loop;
  return v_out;
end
$$;

-- A reading of a device whose unit is served by an enrolled OPC UA endpoint keeps its original record (checked at
-- commit, after tab.ingest_opcua_readings has written it).
create function tab.process_reading_native_required() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, plant, pg_temp as $$
begin
  if (tab.process_device_endpoint(new.process_device_id)).id is not null
     and not exists (select 1 from tab.process_reading_native n where n.reading_id = new.id) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-171 DI-32: reading %s of %s is of a unit behind an OPC UA endpoint and came without its original record', new.seq, new.serial);
  end if;
  return null;
end
$$;
create constraint trigger ac_tab_process_reading_native after insert on tab.process_reading
  deferrable initially deferred for each row execute function tab.process_reading_native_required();

revoke all on function tab.status_quality(text), tab.process_device_endpoint(uuid), tab.process_reading_native_required() from public;
revoke all on function tab.ingest_opcua_readings(jsonb) from public;
grant select on tab.process_reading_native to ebmr_app;
grant execute on function tab.ingest_opcua_readings(jsonb), tab.status_quality(text) to ebmr_app;

reset role;
