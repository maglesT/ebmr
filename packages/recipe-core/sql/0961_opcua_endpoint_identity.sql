-- Phase 6 slice 6b, builder A: the identity of OPC UA endpoints (DI-20; plan "Slice 6b", "Device identity"; D-P6b-2;
-- docs/build-plan/phase-6/slice-6b-0-interfaces.md). Each OPC UA endpoint is a registered device: an INSTRUMENT of
-- the device registry (kernel iam.device) whose key fingerprint is the SHA-256 of the endpoint's server certificate and
-- whose room or line is where it is installed, enrolled here with its URL, its security policy (always SignAndEncrypt)
-- and the units it serves. Data from an unregistered, re-keyed or relocated endpoint are refused with an alarm.
--
-- Handbook: modules/recipe-core.md
--
--   platform.inbound_schema row     opcua.endpoint_session v1 (@ebmr/integration-sdk/adapter systems/opcua.ts)
--   plant.opcua_endpoint            insert-only, audited: one enrolment version of an endpoint (device, URL, policy,
--                                   the certificate thumbprint and room or line the registry held then; ENROLLED or
--                                   RETIRED). IAM.DEVICE_MANAGE (the registry's own permission, as iam.register_device)
--   plant.opcua_endpoint_unit       insert-only, audited: the units an enrolment version serves (each installed in the
--                                   endpoint's room or line; a unit on one enrolled endpoint at a time)
--   plant.opcua_endpoint_session    insert-only, audited: each session the gateway reported (opcua.endpoint_session),
--                                   judged VALID or REFUSED against the enrolment and the registry at receipt; a
--                                   refusal raises an integration alarm (WRONG_IDENTITY, CRITICAL) and a security alert
--
-- Commands (SECURITY DEFINER, pg_temp last):
--   plant.enrol_opcua_endpoint(device_code, endpoint_url, security_policy, equipment_codes[], reason) returns integer
--   plant.retire_opcua_endpoint(device_code, reason) returns integer
--   plant.receive_opcua_endpoint_session(envelope) returns jsonb    INTERFACE.WRITE, the OPCUA adapter's command
-- Reads (granted): plant.opcua_unit_problem(equipment, adapter, sequence) returns text, plant.opcua_endpoint_current
--   (view)
--
-- Guards (before insert, every role): a row of plant.series, plant.equipment_state_event or plant.alarm from the OPCUA
-- source stands on a VALID session of the unit's endpoint: the latest session that endpoint reported on the same
-- adapter before the message (by the adapter's sequence), judged under the enrolment in force, with the registry still
-- holding the same certificate and location and the device ACTIVE. Otherwise EBMR-EQD-002 (series, events) or
-- EBMR-ALM-002 (alarms), class WRONG_IDENTITY: the adapter worker records the refusal with its alarm (6a pattern).
--
-- Session verdicts (refusal reasons): UNREGISTERED (no device of that code, or not an INSTRUMENT), NOT_ENROLLED,
-- RETIRED, BLOCKED (device not ACTIVE), CERTIFICATE_CHANGED (the certificate presented is not the registered key),
-- INSECURE (not SignAndEncrypt, or another policy than the enrolled one), URL_CHANGED, RELOCATED (the location the server
-- reports, or a served unit's room or line, is not the registered one), UNIT_NOT_SERVED (a unit the endpoint offers is
-- not enrolled on it). A REFUSED session is kept (the message was received whole; its content is refused), so a later
-- data message of that endpoint is refused too: fail closed until a VALID session follows.
--
-- D-P6b-A-1 (storage of a series chunk, D-P6b-0-7 "held three times"): the audit trail of an insert-only table holds
-- only a SHA-256 of the row (kernel 0010, audit_row_change), not its samples. A chunk's samples are held twice: in the
-- inbound message as received (DI-31: the original record of what the source sent; the de-duplication compares its
-- payload hash; reconciliation counts it) and in plant.series (the native record the batch reads, its chunk hash
-- recomputed by this database at insert). Both are kept: the first is the original, the second the checked record that
-- the binding windows read; removing either would change a fixed interface (0960) for a storage saving that Phase 6
-- volumes do not need. Listed for the owner with D-P6b-0-7.
--
-- Messages: EBMR-EQD-002 (data of an endpoint without a valid session), EBMR-EQD-020 (malformed session),
-- EBMR-EQD-030 to 039 (enrolment).

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0961_opcua_endpoint_identity)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'OPC UA endpoint session message schema (DI-20, DI-31, Phase 6 slice 6b)'));

insert into platform.inbound_schema (source_system, message_type, schema_version, description) values
  ('OPCUA', 'opcua.endpoint_session', 1, 'A session the gateway opened to an enrolled OPC UA endpoint (DI-20)');

-- ---------------------------------------------------------------------------------------------
-- Enrolment
-- ---------------------------------------------------------------------------------------------

create table plant.opcua_endpoint (
  id                      uuid primary key default gen_random_uuid(),
  device_id               uuid not null references iam.device (id),
  device_code             text not null,
  version                 integer not null check (version >= 1),
  status                  text not null check (status in ('ENROLLED', 'RETIRED')),
  endpoint_url            text not null check (endpoint_url ~ '^opc\.tcp://[\x21-\x7E]{1,200}$'),
  security_mode           text not null default 'SignAndEncrypt' check (security_mode = 'SignAndEncrypt'),
  security_policy         text not null check (security_policy in ('Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss')),
  -- The registry's key fingerprint and location when this version was recorded.
  certificate_thumbprint  text not null check (certificate_thumbprint ~ '^[0-9a-f]{64}$'),
  area_id                 uuid not null references plant.area (id),
  reason                  text not null check (btrim(reason) <> ''),
  recorded_by_person      uuid not null,
  recorded_by_account     uuid not null,
  correlation_id          uuid not null,
  recorded_at             timestamptz not null default clock_timestamp(),
  unique (device_id, version)
);
revoke all on plant.opcua_endpoint from public;
select platform.enforce_db_time('plant.opcua_endpoint', array['recorded_at']);
select kernel.register_audited_table('plant.opcua_endpoint', 'opcua_endpoint', 'device_code', true);

create table plant.opcua_endpoint_unit (
  endpoint_id   uuid not null references plant.opcua_endpoint (id),
  equipment_id  uuid not null references plant.equipment (id),
  primary key (endpoint_id, equipment_id)
);
revoke all on plant.opcua_endpoint_unit from public;
select kernel.register_audited_table('plant.opcua_endpoint_unit', 'opcua_endpoint_unit', 'endpoint_id', true);

-- The enrolment in force per device: its latest version.
create view plant.opcua_endpoint_current as
  select distinct on (e.device_id) e.*
  from plant.opcua_endpoint e
  order by e.device_id, e.version desc;

-- The plant area of a registered device: its line when it has one, else its room; null when neither is a plant area.
create function plant.device_area(p_device iam.device) returns uuid
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select a.id from plant.area a
  where (p_device.line_code is not null and a.code = p_device.line_code and a.kind = 'LINE')
     or (p_device.line_code is null and p_device.room_code is not null and a.code = p_device.room_code and a.kind = 'ROOM')
$$;

create function plant.enrol_opcua_endpoint(p_device_code text, p_endpoint_url text, p_security_policy text, p_equipment_codes text[], p_reason text)
returns integer
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, platform, pg_temp as $$
declare
  v_actor  jsonb := iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  d        iam.device;
  v_area   uuid;
  v_ver    integer;
  v_id     uuid;
  v_code   text;
  u        plant.equipment;
  v_other  text;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-EQD-030 an endpoint enrolment states its reason';
  end if;
  select * into d from iam.device where code = p_device_code;
  if d.id is null or d.device_class <> 'INSTRUMENT' or d.status <> 'ACTIVE' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-EQD-031 DI-20: %s is no ACTIVE instrument of the device registry (register the endpoint with its certificate thumbprint first)', coalesce(p_device_code, 'NULL'));
  end if;
  v_area := plant.device_area(d);
  if v_area is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-EQD-032 DI-20: endpoint %s is registered in room %s, line %s, which is no room or line of the plant', d.code, coalesce(d.room_code, '-'), coalesce(d.line_code, '-'));
  end if;
  if coalesce(p_endpoint_url, '') !~ '^opc\.tcp://[\x21-\x7E]{1,200}$'
     or coalesce(p_security_policy, '') not in ('Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-EQD-033 D-P6b-2: an endpoint is enrolled with an opc.tcp URL and SignAndEncrypt under Basic256Sha256, Aes128_Sha256_RsaOaep or Aes256_Sha256_RsaPss';
  end if;
  if coalesce(cardinality(p_equipment_codes), 0) not between 1 and 64 or cardinality(p_equipment_codes) <> (select count(distinct x) from unnest(p_equipment_codes) x) then
    raise exception using errcode = 'P0001', message = 'EBMR-EQD-034 an endpoint serves 1 to 64 distinct units';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('plant.opcua_endpoint', 0));
  select coalesce(max(version), 0) + 1 into v_ver from plant.opcua_endpoint where device_id = d.id;
  insert into plant.opcua_endpoint (device_id, device_code, version, status, endpoint_url, security_policy, certificate_thumbprint, area_id, reason,
                                    recorded_by_person, recorded_by_account, correlation_id)
  values (d.id, d.code, v_ver, 'ENROLLED', p_endpoint_url, p_security_policy, d.key_fingerprint, v_area, p_reason,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning id into v_id;
  foreach v_code in array p_equipment_codes loop
    select * into u from plant.equipment where code = v_code;
    if u.id is null then
      raise exception using errcode = 'P0001', message = format('EBMR-EQD-035 unit %s is not known to this installation', v_code);
    end if;
    if u.area_id is not null and u.area_id <> v_area then
      raise exception using errcode = 'P0001',
        message = format('EBMR-EQD-036 DI-20: unit %s is installed in another room or line than endpoint %s', v_code, d.code);
    end if;
    select c.device_code into v_other
    from plant.opcua_endpoint_current c join plant.opcua_endpoint_unit eu on eu.endpoint_id = c.id
    where c.status = 'ENROLLED' and eu.equipment_id = u.id and c.device_id <> d.id;
    if v_other is not null then
      raise exception using errcode = 'P0001', message = format('EBMR-EQD-037 unit %s is served by endpoint %s; retire that enrolment first', v_code, v_other);
    end if;
    insert into plant.opcua_endpoint_unit (endpoint_id, equipment_id) values (v_id, u.id);
  end loop;
  return v_ver;
end
$$;

create function plant.retire_opcua_endpoint(p_device_code text, p_reason text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, platform, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  c       plant.opcua_endpoint;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-EQD-030 an endpoint retirement states its reason';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('plant.opcua_endpoint', 0));
  select x.* into c from plant.opcua_endpoint_current x where x.device_code = p_device_code;
  if c.id is null or c.status <> 'ENROLLED' then
    raise exception using errcode = 'P0001', message = format('EBMR-EQD-038 %s is no enrolled OPC UA endpoint', coalesce(p_device_code, 'NULL'));
  end if;
  insert into plant.opcua_endpoint (device_id, device_code, version, status, endpoint_url, security_policy, certificate_thumbprint, area_id, reason,
                                    recorded_by_person, recorded_by_account, correlation_id)
  values (c.device_id, c.device_code, c.version + 1, 'RETIRED', c.endpoint_url, c.security_policy, c.certificate_thumbprint, c.area_id, p_reason,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  return c.version + 1;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------------------------

create table plant.opcua_endpoint_session (
  id                      uuid primary key default gen_random_uuid(),
  inbound_message_id      uuid not null unique references platform.inbound_message (id),
  adapter_id              uuid not null references iam.integration_adapter (id),
  sequence_no             bigint not null,
  endpoint_code           text not null,
  device_id               uuid references iam.device (id),
  endpoint_id             uuid references plant.opcua_endpoint (id),
  verdict                 text not null check (verdict in ('VALID', 'REFUSED')),
  refusal                 text check (refusal in ('UNREGISTERED', 'NOT_ENROLLED', 'RETIRED', 'BLOCKED', 'CERTIFICATE_CHANGED', 'INSECURE',
                                                  'URL_CHANGED', 'RELOCATED', 'UNIT_NOT_SERVED')),
  detail                  text,
  endpoint_url            text not null,
  security_mode           text not null,
  security_policy         text not null,
  certificate_thumbprint  text not null,
  reported_location       text,
  equipment_codes         text[] not null,
  opened_source_us        bigint not null,
  integration_alarm_id    uuid references platform.integration_alarm (id),
  security_alert_id       uuid,
  received_at             timestamptz not null default clock_timestamp(),
  check ((verdict = 'REFUSED') = (refusal is not null and detail is not null and integration_alarm_id is not null)),
  check (verdict = 'REFUSED' or endpoint_id is not null)
);
create index opcua_endpoint_session_by_device on plant.opcua_endpoint_session (device_id, adapter_id, sequence_no);
revoke all on plant.opcua_endpoint_session from public;
select platform.enforce_db_time('plant.opcua_endpoint_session', array['received_at']);
select kernel.register_audited_table('plant.opcua_endpoint_session', 'opcua_endpoint', 'endpoint_code', true);

create function plant.receive_opcua_endpoint_session(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, platform, iam, pg_temp as $$
declare
  v_out     jsonb;
  m         platform.inbound_message;
  p         jsonb;
  k         text;
  d         iam.device;
  c         plant.opcua_endpoint;
  v_area    uuid;
  v_codes   text[];
  v_refusal text;
  v_detail  text;
  v_alarm   uuid;
  v_alert   uuid;
  v_id      uuid;
  v_kind    text;
  v_bad     text;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  if p_envelope ->> 'messageType' is distinct from 'opcua.endpoint_session' then
    raise exception using errcode = 'P0001', message = format('EBMR-EQD-020 this command receives opcua.endpoint_session, not %s', coalesce(p_envelope ->> 'messageType', 'none'));
  end if;
  v_out := platform.accept_inbound_detail(p_envelope);
  if v_out ->> 'outcome' <> 'ACCEPTED' then
    return jsonb_build_object('outcome', 'DUPLICATE', 'messageId', v_out ->> 'messageId', 'applied', 'NOTHING (duplicate)');
  end if;
  select * into m from platform.inbound_message where id = (v_out ->> 'messageId')::uuid;
  p := m.payload;
  for k in select jsonb_object_keys(p) loop
    if k not in ('endpointCode', 'endpointUrl', 'securityMode', 'securityPolicy', 'certificateThumbprint', 'reportedLocation', 'equipmentCodes', 'openedAt') then
      raise exception using errcode = 'P0001', message = format('EBMR-EQD-020 malformed endpoint session: unknown field %s', k);
    end if;
  end loop;
  if coalesce(p ->> 'endpointCode', '') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$' or coalesce(p ->> 'endpointUrl', '') !~ '^opc\.tcp://[\x21-\x7E]{1,200}$'
     or coalesce(p ->> 'securityMode', '') not in ('None', 'Sign', 'SignAndEncrypt') or coalesce(p ->> 'securityPolicy', '') !~ '^[A-Za-z0-9_]{1,64}$'
     or coalesce(p ->> 'certificateThumbprint', '') !~ '^[0-9a-f]{64}$'
     or (p -> 'reportedLocation' is not null and jsonb_typeof(p -> 'reportedLocation') <> 'null' and coalesce(p ->> 'reportedLocation', '') !~ '^[A-Z0-9][A-Z0-9_-]{0,63}$')
     or jsonb_typeof(p -> 'equipmentCodes') is distinct from 'array' or jsonb_array_length(p -> 'equipmentCodes') not between 1 and 64
     or exists (select 1 from jsonb_array_elements(p -> 'equipmentCodes') x where jsonb_typeof(x) <> 'string' or x #>> '{}' !~ '^[A-Z0-9][A-Z0-9_-]{0,63}$') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-EQD-020 malformed endpoint session: endpointCode, endpointUrl, securityMode, securityPolicy, certificateThumbprint, reportedLocation or null, 1 to 64 equipmentCodes, openedAt';
  end if;
  perform plant.source_time_or_raise(p ->> 'openedAt', 'EQD');
  select array_agg(x #>> '{}' order by x #>> '{}') into v_codes from jsonb_array_elements(p -> 'equipmentCodes') x;

  -- The verdict, first failing rule wins.
  select * into d from iam.device where code = p ->> 'endpointCode';
  if d.id is null or d.device_class <> 'INSTRUMENT' then
    v_refusal := 'UNREGISTERED';
    v_detail := format('endpoint %s is no instrument of the device registry', p ->> 'endpointCode');
  else
    select x.* into c from plant.opcua_endpoint_current x where x.device_id = d.id;
    v_area := plant.device_area(d);
    if c.id is null then
      v_refusal := 'NOT_ENROLLED';
      v_detail := format('endpoint %s is registered but not enrolled as an OPC UA endpoint', d.code);
    elsif c.status = 'RETIRED' then
      v_refusal := 'RETIRED';
      v_detail := format('the enrolment of endpoint %s is retired', d.code);
    elsif d.status <> 'ACTIVE' then
      v_refusal := 'BLOCKED';
      v_detail := format('endpoint %s is %s in the device registry', d.code, d.status);
    elsif p ->> 'certificateThumbprint' <> d.key_fingerprint or d.key_fingerprint <> c.certificate_thumbprint then
      v_refusal := 'CERTIFICATE_CHANGED';
      v_detail := format('endpoint %s presented certificate %s..., not the registered %s...', d.code, left(p ->> 'certificateThumbprint', 12), left(c.certificate_thumbprint, 12));
    elsif p ->> 'securityMode' <> 'SignAndEncrypt' or p ->> 'securityPolicy' <> c.security_policy then
      v_refusal := 'INSECURE';
      v_detail := format('endpoint %s was opened with %s/%s, not SignAndEncrypt/%s', d.code, p ->> 'securityMode', p ->> 'securityPolicy', c.security_policy);
    elsif p ->> 'endpointUrl' <> c.endpoint_url then
      v_refusal := 'URL_CHANGED';
      v_detail := format('endpoint %s was reached at %s, not the enrolled %s', d.code, left(p ->> 'endpointUrl', 120), c.endpoint_url);
    elsif v_area is distinct from c.area_id
          or (p ->> 'reportedLocation' is not null and p ->> 'reportedLocation' <> (select a.code from plant.area a where a.id = c.area_id))
          or exists (select 1 from plant.opcua_endpoint_unit eu join plant.equipment e on e.id = eu.equipment_id
                     where eu.endpoint_id = c.id and e.area_id is not null and e.area_id <> c.area_id) then
      v_refusal := 'RELOCATED';
      v_detail := format('endpoint %s reports location %s; it is enrolled in %s and registered in %s', d.code, coalesce(p ->> 'reportedLocation', '-'),
                         (select a.code from plant.area a where a.id = c.area_id), coalesce(d.line_code, d.room_code, '-'));
    else
      select string_agg(x, ', ' order by x) into v_bad from unnest(v_codes) x
      where not exists (select 1 from plant.opcua_endpoint_unit eu join plant.equipment e on e.id = eu.equipment_id where eu.endpoint_id = c.id and e.code = x);
      if v_bad is not null then
        v_refusal := 'UNIT_NOT_SERVED';
        v_detail := format('endpoint %s offers units %s, which are not enrolled on it', d.code, v_bad);
      end if;
    end if;
  end if;

  if v_refusal is not null then
    v_alarm := platform.raise_integration_alarm(iam.current_integration_adapter(), 'WRONG_IDENTITY', 'CRITICAL', m.id,
      jsonb_build_object('control', 'DI-20', 'endpoint', p ->> 'endpointCode', 'refusal', v_refusal, 'detail', v_detail));
    v_kind := case v_refusal when 'RELOCATED' then 'DEVICE_LOCATION_MISMATCH' when 'BLOCKED' then 'BLOCKED_DEVICE_USE'
                             when 'RETIRED' then 'BLOCKED_DEVICE_USE' else 'UNREGISTERED_DEVICE' end;
    v_alert := iam.raise_alert(v_kind, 'HIGH', null, null, d.id, null, null,
      jsonb_build_object('control', 'DI-20', 'endpoint', p ->> 'endpointCode', 'refusal', v_refusal, 'thumbprint', p ->> 'certificateThumbprint',
                         'reported_location', p ->> 'reportedLocation'));
  end if;
  insert into plant.opcua_endpoint_session (inbound_message_id, adapter_id, sequence_no, endpoint_code, device_id, endpoint_id, verdict, refusal, detail,
                                            endpoint_url, security_mode, security_policy, certificate_thumbprint, reported_location, equipment_codes,
                                            opened_source_us, integration_alarm_id, security_alert_id)
  values (m.id, m.adapter_id, m.sequence_no, p ->> 'endpointCode', d.id, c.id, case when v_refusal is null then 'VALID' else 'REFUSED' end, v_refusal, v_detail,
          p ->> 'endpointUrl', p ->> 'securityMode', p ->> 'securityPolicy', p ->> 'certificateThumbprint', p ->> 'reportedLocation', v_codes,
          (p ->> 'openedAt')::bigint, v_alarm, v_alert)
  returning id into v_id;
  return jsonb_build_object('outcome', 'ACCEPTED', 'messageId', m.id, 'applied', case when v_refusal is null then 'SESSION_VALID' else 'SESSION_REFUSED' end,
                            'sessionId', v_id, 'refusal', v_refusal, 'detail', v_detail, 'alarmId', v_alarm);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The guard on OPC UA data
-- ---------------------------------------------------------------------------------------------

-- Why data of unit p_equipment, received as message p_sequence of adapter p_adapter, must not be recorded, or null.
-- With p_adapter null (a process reading of the gateway path, tablets 1210) the endpoint's latest session on any adapter
-- counts.
create function plant.opcua_unit_problem(p_equipment uuid, p_adapter uuid, p_sequence bigint) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  u  plant.equipment;
  c  plant.opcua_endpoint;
  d  iam.device;
  s  plant.opcua_endpoint_session;
begin
  select * into u from plant.equipment where id = p_equipment;
  select x.* into c
  from plant.opcua_endpoint_current x join plant.opcua_endpoint_unit eu on eu.endpoint_id = x.id
  where eu.equipment_id = p_equipment and x.status = 'ENROLLED';
  if c.id is null then
    return format('DI-20: unit %s is served by no enrolled OPC UA endpoint (unregistered endpoint)', coalesce(u.code, p_equipment::text));
  end if;
  select * into d from iam.device where id = c.device_id;
  if d.status <> 'ACTIVE' then
    return format('DI-20: endpoint %s of unit %s is %s in the device registry', d.code, u.code, d.status);
  end if;
  if d.key_fingerprint <> c.certificate_thumbprint then
    return format('DI-20: the registered certificate of endpoint %s changed after its enrolment; enrol it again', d.code);
  end if;
  if plant.device_area(d) is distinct from c.area_id or (u.area_id is not null and u.area_id <> c.area_id) then
    return format('DI-20: endpoint %s of unit %s was relocated after its enrolment', d.code, u.code);
  end if;
  if p_adapter is null then
    select * into s from plant.opcua_endpoint_session x where x.device_id = d.id order by x.received_at desc, x.sequence_no desc limit 1;
  else
    select * into s from plant.opcua_endpoint_session x where x.device_id = d.id and x.adapter_id = p_adapter and x.sequence_no < p_sequence
    order by x.sequence_no desc limit 1;
  end if;
  if s.id is null then
    return format('DI-20: no session of endpoint %s precedes the data of unit %s', d.code, u.code);
  end if;
  if s.verdict <> 'VALID' then
    return format('DI-20: the session of endpoint %s was refused (%s): %s', d.code, s.refusal, s.detail);
  end if;
  if s.endpoint_id <> c.id then
    return format('DI-20: the session of endpoint %s predates its enrolment in force', d.code);
  end if;
  if not u.code = any (s.equipment_codes) then
    return format('DI-20: the session of endpoint %s did not offer unit %s', d.code, u.code);
  end if;
  return null;
end
$$;

create function plant.opcua_data_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  m         platform.inbound_message;
  v_problem text;
begin
  if new.source is distinct from 'OPCUA' then
    return new;
  end if;
  select * into m from platform.inbound_message where id = new.inbound_message_id;
  if m.id is null or new.equipment_id is null then
    v_problem := 'DI-20: OPC UA data name a unit and the inbound message they came in';
  else
    v_problem := plant.opcua_unit_problem(new.equipment_id, m.adapter_id, m.sequence_no);
  end if;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-%s-002 %s (wrong identity)', case when tg_table_name = 'alarm' then 'ALM' else 'EQD' end, v_problem);
  end if;
  return new;
end
$$;

create trigger ab_opcua_endpoint_guard before insert on plant.series for each row execute function plant.opcua_data_guard();
create trigger ab_opcua_endpoint_guard before insert on plant.equipment_state_event for each row execute function plant.opcua_data_guard();
create trigger ab_opcua_endpoint_guard before insert on plant.alarm for each row execute function plant.opcua_data_guard();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on function plant.device_area(iam.device), plant.opcua_data_guard() from public;
revoke all on function plant.enrol_opcua_endpoint(text, text, text, text[], text), plant.retire_opcua_endpoint(text, text),
  plant.receive_opcua_endpoint_session(jsonb), plant.opcua_unit_problem(uuid, uuid, bigint) from public;
grant select on plant.opcua_endpoint, plant.opcua_endpoint_unit, plant.opcua_endpoint_current, plant.opcua_endpoint_session to ebmr_app;
grant execute on function plant.enrol_opcua_endpoint(text, text, text, text[], text), plant.retire_opcua_endpoint(text, text),
  plant.receive_opcua_endpoint_session(jsonb), plant.opcua_unit_problem(uuid, uuid, bigint) to ebmr_app;

reset role;
