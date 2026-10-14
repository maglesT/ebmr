-- Phase 6 slice 6a-0: the inbound adapter framework (DI-31, DI-20, DI-14; INV-26, INV-38; D-P6a-1, D-P6a-3, D-P6a-5).
--
-- Fixed signatures (docs/build-plan/phase-6/slice-6a-0-interfaces.md; the TypeScript side is
-- @ebmr/integration-sdk/adapter). Builders A and B add to these in their own migration ranges; a signature here
-- changes only through the lead.
--
-- Handbook: modules/integrations.md
--
--  * Integration identities (DI-20, DI-14). An adapter instance is an INTEGRATION account (a SYSTEM person, a
--    SERVICE_KEY credential, a two-person role grant: kernel 0110 to 0160) bound to the SERVER device it runs on,
--    registered in iam.integration_adapter by whoever registers devices (IAM.DEVICE_MANAGE) for exactly one source
--    system. Such an account can never sign or acknowledge: the identity module refuses SIGN and ACKNOWLEDGE roles and
--    permissions for SERVICE and INTEGRATION accounts and SIGNATURE authentication by a service key (0120, 0130, 0160).
--    Only an ACTIVE registered adapter, acting from its own device with source INTEGRATION, gets past
--    iam.current_integration_adapter(); anything else is EBMR-INT-002.
--  * platform.accept_inbound(envelope) / accept_inbound_detail(envelope): validates the envelope (EBMR-INT-001), its
--    source system against the adapter's (EBMR-INT-003) and its message type and schema version against
--    platform.inbound_schema (EBMR-INT-004); de-duplicates by idempotency key (same payload hash: DUPLICATE, the first
--    message's id, nothing applied twice; another hash: EBMR-INT-005); refuses a sequence number already taken
--    (EBMR-INT-006); accepts a gap or a late number with an integration alarm in the same transaction. The message
--    row and the domain command that applies its payload share one transaction, so a message is applied whole or not
--    at all. The function is called by the receiving domain command (builders' functions), or directly.
--  * Refusals that must leave an alarm are recorded by the adapter in their own command with
--    platform.record_inbound_refusal (the refused transaction rolled back): the same pattern as kernel 0950. A refusal
--    the adapter fails to record shows as a reconciliation mismatch (platform.record_reconciliation).
--  * Mirrors (INV-26, INV-38): platform.mirror_data_class lists the data classes GMP guards read from other systems;
--    platform settings integration.mode.<class> (STAND_IN or MIRROR, D-P6a-5) and integration.mirror_max_age_s.<class>
--    (D-P6a-3) hold the per-site mode and bound (one installation is one site); platform.mirror_sync holds the last
--    successful synchronisation (operational, not audited, as iam.mirror_heartbeat in 0130).
--    platform.mirror_freshness(class) reports; platform.mirror_fresh_or_raise(class) fails closed with EBMR-INT-010
--    for a stale blocking MIRROR class and passes in STAND_IN.
--  * Integration alarms are their own insert-only log (platform.integration_alarm, acknowledged in
--    platform.integration_alarm_ack under ALARM.ACKNOWLEDGE), not platform.alarm: that table is the time monitor's
--    (its kinds, its time_node audit chain and its review windows are time-fault semantics; D-P6a-0-3).

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Integration identities
-- ---------------------------------------------------------------------------------------------------------------

create table iam.integration_adapter (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique check (code ~ '^[A-Z][A-Z0-9_-]{1,63}$'),
  source_system         text not null check (source_system in ('ERP_WMS', 'QMS', 'LIMS', 'LMS', 'CMMS', 'EMS', 'OPCUA', 'L3')),
  account_id            uuid not null references iam.account (id),
  device_id             uuid not null references iam.device (id),
  status                text not null default 'ACTIVE' check (status in ('ACTIVE', 'BLOCKED', 'DECOMMISSIONED')),
  description           text not null check (btrim(description) <> ''),
  registered_by_person  uuid not null,
  registered_at         timestamptz not null default clock_timestamp(),
  status_changed_at     timestamptz not null default clock_timestamp(),
  status_reason         text
);
revoke all on iam.integration_adapter from public;
-- One live registration per account: an adapter's identity is never shared.
create unique index integration_adapter_one_per_account on iam.integration_adapter (account_id) where status <> 'DECOMMISSIONED';
comment on table iam.integration_adapter is 'Integration adapter instances (DI-20): an INTEGRATION account bound to its SERVER device and one source system. Status changes only; decommissioned is final.';

create function iam.integration_adapter_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'ACTIVE' then
      raise exception using errcode = 'P0001', message = 'EBMR-INT-016 an integration adapter is registered ACTIVE';
    end if;
    new.status_changed_at := clock_timestamp();
    return new;
  end if;
  if new.id <> old.id or new.code <> old.code or new.source_system <> old.source_system or new.account_id <> old.account_id
     or new.device_id <> old.device_id or new.registered_by_person <> old.registered_by_person or new.registered_at <> old.registered_at
     or new.description <> old.description then
    raise exception using errcode = 'P0001',
      message = 'EBMR-INT-016 an integration adapter''s code, system, account, device and description never change; register a new adapter instead';
  end if;
  if old.status = 'DECOMMISSIONED' then
    raise exception using errcode = 'P0001', message = 'EBMR-INT-016 a decommissioned integration adapter never changes again';
  end if;
  new.status_changed_at := case when new.status is distinct from old.status then clock_timestamp() else old.status_changed_at end;
  return new;
end
$$;
create trigger aa_integration_adapter_guard before insert or update on iam.integration_adapter
  for each row execute function iam.integration_adapter_guard();

-- Registers an adapter instance: an INTEGRATION account that is not disabled, on an ACTIVE SERVER device.
create function iam.register_integration_adapter(p_code text, p_source_system text, p_account uuid, p_device uuid, p_description text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  v_acc   iam.account%rowtype;
  v_dev   iam.device%rowtype;
  v_id    uuid;
begin
  select * into v_acc from iam.account where id = p_account;
  if not found or v_acc.kind <> 'INTEGRATION' or v_acc.status = 'DISABLED' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-012 an integration adapter runs under an INTEGRATION account that is not disabled; %s is %s',
                       p_account, coalesce(v_acc.kind || ' ' || v_acc.status, 'unknown'));
  end if;
  select * into v_dev from iam.device where id = p_device;
  if not found or v_dev.device_class <> 'SERVER' or v_dev.status <> 'ACTIVE' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-012 an integration adapter runs on an ACTIVE registered SERVER device; %s is %s',
                       p_device, coalesce(v_dev.device_class || ' ' || v_dev.status, 'unknown'));
  end if;
  insert into iam.integration_adapter (code, source_system, account_id, device_id, description, registered_by_person)
  values (p_code, p_source_system, p_account, p_device, p_description, (v_actor ->> 'person_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function iam.set_integration_adapter_status(p_adapter uuid, p_status text, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
begin
  perform iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  if coalesce(btrim(p_reason), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-004 a reason is required';
  end if;
  update iam.integration_adapter set status = p_status, status_reason = p_reason where id = p_adapter;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-INT-016 unknown integration adapter %s', p_adapter);
  end if;
end
$$;

-- The adapter the validated actor acts as: source INTEGRATION, an INTEGRATION account registered ACTIVE, acting
-- from the adapter's own device. Anything else is refused (DI-20). Owner only.
create function iam.current_integration_adapter() returns iam.integration_adapter
language plpgsql stable security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_ctx jsonb := kernel.current_actor();
  v_ad  iam.integration_adapter%rowtype;
begin
  if v_ctx is not null and v_ctx ->> 'source' = 'INTEGRATION' then
    select a.* into v_ad
    from iam.integration_adapter a
    join iam.account acc on acc.id = a.account_id
    join iam.session s on s.id = nullif(v_ctx ->> 'session_id', '')::uuid
    where a.account_id = nullif(v_ctx ->> 'account_id', '')::uuid and a.status = 'ACTIVE'
      and acc.kind = 'INTEGRATION' and acc.status = 'ACTIVE' and s.device_id = a.device_id;
  end if;
  if v_ad.id is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-002 only a registered, active integration adapter acting from its own device may hand over inbound data; %s (source %s) is not one',
                       coalesce(v_ctx ->> 'account_id', 'no actor'), coalesce(v_ctx ->> 'source', '?'));
  end if;
  return v_ad;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Message schemas, messages, refusals and alarms
-- ---------------------------------------------------------------------------------------------------------------

-- The (system, message type, schema version) triples the eBMR accepts. Insert-only; slices add rows in their
-- migrations (the system contracts of @ebmr/integration-sdk/adapter list the same).
create table platform.inbound_schema (
  source_system   text not null check (source_system in ('ERP_WMS', 'QMS', 'LIMS', 'LMS', 'CMMS', 'EMS', 'OPCUA', 'L3')),
  message_type    text not null check (message_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$'),
  schema_version  integer not null check (schema_version between 1 and 9999),
  description     text not null check (btrim(description) <> ''),
  recorded_at     timestamptz not null default clock_timestamp(),
  primary key (source_system, message_type, schema_version)
);
revoke all on platform.inbound_schema from public;

create table platform.inbound_message (
  id                uuid primary key default gen_random_uuid(),
  adapter_id        uuid not null references iam.integration_adapter (id),
  adapter_code      text not null,
  source_system     text not null,
  message_type      text not null,
  source_record_id  text not null,
  source_timestamp  timestamptz not null,
  sequence_no       bigint not null check (sequence_no > 0),
  idempotency_key   text not null,
  schema_version    integer not null,
  payload_hash      text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  payload           jsonb not null check (jsonb_typeof(payload) = 'object'),
  sequence_status   text not null check (sequence_status in ('FIRST', 'IN_ORDER', 'GAP', 'LATE')),
  received_by_person uuid not null,
  correlation_id    uuid not null,
  received_at       timestamptz not null default clock_timestamp(),
  unique (adapter_id, idempotency_key),
  unique (adapter_id, sequence_no),
  foreign key (source_system, message_type, schema_version) references platform.inbound_schema (source_system, message_type, schema_version)
);
revoke all on platform.inbound_message from public;
create index inbound_message_source on platform.inbound_message (adapter_id, source_timestamp);
comment on table platform.inbound_message is 'Every accepted inbound message with its envelope and raw payload (DI-31). Insert-only.';

create table platform.integration_alarm (
  id             uuid primary key default gen_random_uuid(),
  adapter_id     uuid not null references iam.integration_adapter (id),
  adapter_code   text not null,
  kind           text not null check (kind in ('SEQUENCE_GAP', 'OUT_OF_ORDER', 'MALFORMED', 'DUPLICATE', 'WRONG_IDENTITY', 'OUT_OF_RANGE',
                                               'STALE', 'PARTIAL', 'TRANSPORT', 'RECONCILIATION_MISMATCH')),
  severity       text not null check (severity in ('MINOR', 'MAJOR', 'CRITICAL')),
  message_id     uuid references platform.inbound_message (id),
  details        jsonb not null default '{}'::jsonb,
  raised_at      timestamptz not null default clock_timestamp()
);
revoke all on platform.integration_alarm from public;
create index integration_alarm_adapter on platform.integration_alarm (adapter_id, raised_at);

create table platform.integration_alarm_ack (
  alarm_id         uuid primary key references platform.integration_alarm (id),
  adapter_code     text not null,
  note             text not null check (btrim(note) <> ''),
  acknowledged_by  uuid not null,
  acknowledged_role text not null,
  acknowledged_at  timestamptz not null default clock_timestamp()
);
revoke all on platform.integration_alarm_ack from public;

-- Receipts that did not become a message: REFUSED (recorded by the adapter after the refused transaction rolled back)
-- and DEDUPLICATED (a same-key same-hash resend, recorded by accept_inbound_detail).
create table platform.inbound_exception (
  id               uuid primary key default gen_random_uuid(),
  adapter_id       uuid not null references iam.integration_adapter (id),
  adapter_code     text not null,
  kind             text not null check (kind in ('REFUSED', 'DEDUPLICATED')),
  error_class      text check (error_class in ('MALFORMED', 'DUPLICATE', 'OUT_OF_ORDER', 'WRONG_IDENTITY', 'OUT_OF_RANGE', 'STALE', 'PARTIAL')),
  idempotency_key  text,
  payload_hash     text check (payload_hash ~ '^[0-9a-f]{64}$'),
  sequence_no      bigint,
  source_timestamp timestamptz,
  message_id       uuid references platform.inbound_message (id),
  alarm_id         uuid references platform.integration_alarm (id),
  envelope_text    text not null,
  detail           text not null check (btrim(detail) <> ''),
  recorded_at      timestamptz not null default clock_timestamp(),
  check ((kind = 'REFUSED') = (error_class is not null and alarm_id is not null)),
  check (kind = 'REFUSED' or message_id is not null)
);
revoke all on platform.inbound_exception from public;
create index inbound_exception_adapter on platform.inbound_exception (adapter_id, recorded_at);

create table platform.reconciliation_report (
  id                 uuid primary key default gen_random_uuid(),
  adapter_id         uuid not null references iam.integration_adapter (id),
  adapter_code       text not null,
  period_from        timestamptz not null,
  period_to          timestamptz not null,
  source_count       bigint not null check (source_count >= 0),
  source_checksum    text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  received_count     bigint not null,
  received_checksum  text not null,
  accepted_count     bigint not null,
  refused_count      bigint not null,
  matched            boolean not null,
  alarm_id           uuid references platform.integration_alarm (id),
  recorded_at        timestamptz not null default clock_timestamp(),
  check (period_from < period_to),
  check (matched = (alarm_id is null))
);
revoke all on platform.reconciliation_report from public;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Mirrors
-- ---------------------------------------------------------------------------------------------------------------

create table platform.mirror_data_class (
  code           text primary key check (code ~ '^[A-Z][A-Z0-9_]*$'),
  source_system  text not null check (source_system in ('ERP_WMS', 'QMS', 'LIMS', 'LMS', 'CMMS', 'EMS', 'OPCUA', 'L3')),
  blocking       boolean not null,
  description    text not null check (btrim(description) <> ''),
  recorded_at    timestamptz not null default clock_timestamp()
);
revoke all on platform.mirror_data_class from public;

-- Last successful synchronisation per data class (operational; not GMP data, not audited: kernel 0130's heartbeat).
-- Written only by platform.record_mirror_sync with the database clock (the application has no write grant).
create table platform.mirror_sync (
  data_class      text primary key references platform.mirror_data_class (code),
  adapter_id      uuid not null references iam.integration_adapter (id),
  last_synced_at  timestamptz not null
);
revoke all on platform.mirror_sync from public;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Functions
-- ---------------------------------------------------------------------------------------------------------------

-- NULL when the envelope has exactly the nine fields in their shapes (as InboundEnvelope of the SDK), else why not.
create function platform.inbound_envelope_problem(p_envelope jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_keys  text[];
  v_want  text[] := array['idempotencyKey', 'messageType', 'payload', 'payloadHash', 'schemaVersion', 'sequenceNo',
                          'sourceRecordId', 'sourceSystem', 'sourceTimestamp'];
  v_field text;
  v_rx    text;
begin
  if p_envelope is null or jsonb_typeof(p_envelope) <> 'object' then
    return 'the envelope is not a JSON object';
  end if;
  select array_agg(k order by k collate "C") into v_keys from jsonb_object_keys(p_envelope) k;
  if v_keys is distinct from v_want then
    return format('the envelope has the fields %s; it needs exactly %s', v_keys, v_want);
  end if;
  for v_field, v_rx in select f, r from (values
    ('sourceSystem', '^(ERP_WMS|QMS|LIMS|LMS|CMMS|EMS|OPCUA|L3)$'),
    ('messageType', '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$'),
    ('sourceRecordId', '^[\x20-\x7E]{1,128}$'),
    ('sourceTimestamp', '^(0|[1-9][0-9]{0,17})$'),
    ('sequenceNo', '^[1-9][0-9]{0,17}$'),
    ('idempotencyKey', '^[\x21-\x7E]{1,128}$'),
    ('schemaVersion', '^[1-9][0-9]{0,3}$'),
    ('payloadHash', '^[0-9a-f]{64}$')) v (f, r)
  loop
    if jsonb_typeof(p_envelope -> v_field) <> 'string' or (p_envelope ->> v_field) !~ v_rx then
      return format('%s must be text matching %s', v_field, v_rx);
    end if;
  end loop;
  if btrim(p_envelope ->> 'sourceRecordId') <> (p_envelope ->> 'sourceRecordId') then
    return 'sourceRecordId has leading or trailing blanks';
  end if;
  if (p_envelope ->> 'sourceTimestamp')::numeric > 253402300799999999 then
    return 'sourceTimestamp lies after the year 9999';
  end if;
  if jsonb_typeof(p_envelope -> 'payload') <> 'object' then
    return 'payload must be a JSON object';
  end if;
  if octet_length((p_envelope -> 'payload')::text) > 1048576 then
    return 'the payload exceeds 1048576 bytes';
  end if;
  return null;
end
$$;

create function platform.epoch_us_to_timestamptz(p_us text) returns timestamptz
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select 'epoch'::timestamptz + make_interval(secs => p_us::numeric / 1000000)
$$;

create function platform.timestamptz_to_epoch_us(p_at timestamptz) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select (extract(epoch from p_at) * 1000000)::bigint::text
$$;

create function platform.raise_integration_alarm(p_adapter iam.integration_adapter, p_kind text, p_severity text, p_message uuid, p_details jsonb)
returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v_id uuid;
begin
  insert into platform.integration_alarm (adapter_id, adapter_code, kind, severity, message_id, details)
  values (p_adapter.id, p_adapter.code, p_kind, p_severity, p_message, coalesce(p_details, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end
$$;

-- The receiving half of every inbound path (DI-31). Returns {messageId, outcome ACCEPTED|DUPLICATE, sequenceStatus,
-- alarmId}; refuses with EBMR-INT-001 to -006. The caller applies the payload in the same transaction only when the
-- outcome is ACCEPTED.
create function platform.accept_inbound_detail(p_envelope jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, kernel, pg_temp as $$
declare
  v_ctx     jsonb := platform.require_actor();
  v_ad      iam.integration_adapter;
  v_problem text;
  v_prev    platform.inbound_message%rowtype;
  v_seq     bigint;
  v_max     bigint;
  v_status  text;
  v_id      uuid;
  v_alarm   uuid;
begin
  v_ad := iam.current_integration_adapter();
  perform platform.authorize('interface.write', 'integration_adapter', v_ad.code);
  v_problem := platform.inbound_envelope_problem(p_envelope);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-INT-001 malformed inbound envelope: %s', v_problem);
  end if;
  if p_envelope ->> 'sourceSystem' <> v_ad.source_system then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-003 adapter %s speaks for %s, not for %s', v_ad.code, v_ad.source_system, p_envelope ->> 'sourceSystem');
  end if;
  if not exists (select 1 from platform.inbound_schema s
                 where s.source_system = v_ad.source_system and s.message_type = p_envelope ->> 'messageType'
                   and s.schema_version = (p_envelope ->> 'schemaVersion')::integer) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-004 %s message type %s version %s is not accepted by this installation', v_ad.source_system,
                       p_envelope ->> 'messageType', p_envelope ->> 'schemaVersion');
  end if;
  -- One adapter's messages are taken one at a time, so the sequence check sees every committed predecessor.
  perform pg_advisory_xact_lock(hashtextextended('inbound:' || v_ad.id::text, 0));
  select * into v_prev from platform.inbound_message where adapter_id = v_ad.id and idempotency_key = p_envelope ->> 'idempotencyKey';
  if found then
    if v_prev.payload_hash <> p_envelope ->> 'payloadHash' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-INT-005 idempotency key %s of adapter %s was accepted before with other content (message %s)',
                         p_envelope ->> 'idempotencyKey', v_ad.code, v_prev.id);
    end if;
    insert into platform.inbound_exception (adapter_id, adapter_code, kind, idempotency_key, payload_hash, sequence_no, source_timestamp,
                                            message_id, envelope_text, detail)
    values (v_ad.id, v_ad.code, 'DEDUPLICATED', p_envelope ->> 'idempotencyKey', p_envelope ->> 'payloadHash',
            (p_envelope ->> 'sequenceNo')::bigint, platform.epoch_us_to_timestamptz(p_envelope ->> 'sourceTimestamp'), v_prev.id,
            left(p_envelope::text, 65536), 'resent message de-duplicated by its idempotency key and payload hash');
    return jsonb_build_object('messageId', v_prev.id, 'outcome', 'DUPLICATE', 'sequenceStatus', v_prev.sequence_status, 'alarmId', null);
  end if;
  v_seq := (p_envelope ->> 'sequenceNo')::bigint;
  if exists (select 1 from platform.inbound_message where adapter_id = v_ad.id and sequence_no = v_seq) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-006 sequence number %s of adapter %s is already taken by another message', v_seq, v_ad.code);
  end if;
  select max(sequence_no) into v_max from platform.inbound_message where adapter_id = v_ad.id;
  v_status := case when v_max is null then 'FIRST' when v_seq = v_max + 1 then 'IN_ORDER' when v_seq > v_max then 'GAP' else 'LATE' end;
  insert into platform.inbound_message (adapter_id, adapter_code, source_system, message_type, source_record_id, source_timestamp, sequence_no,
                                        idempotency_key, schema_version, payload_hash, payload, sequence_status, received_by_person, correlation_id)
  values (v_ad.id, v_ad.code, v_ad.source_system, p_envelope ->> 'messageType', p_envelope ->> 'sourceRecordId',
          platform.epoch_us_to_timestamptz(p_envelope ->> 'sourceTimestamp'), v_seq, p_envelope ->> 'idempotencyKey',
          (p_envelope ->> 'schemaVersion')::integer, p_envelope ->> 'payloadHash', p_envelope -> 'payload', v_status,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'correlation_id')::uuid)
  returning id into v_id;
  if v_status = 'GAP' then
    v_alarm := platform.raise_integration_alarm(v_ad, 'SEQUENCE_GAP', 'MAJOR', v_id,
      jsonb_build_object('expected', (v_max + 1)::text, 'received', v_seq::text, 'missingFrom', (v_max + 1)::text, 'missingTo', (v_seq - 1)::text));
  elsif v_status = 'LATE' then
    v_alarm := platform.raise_integration_alarm(v_ad, 'OUT_OF_ORDER', 'MAJOR', v_id,
      jsonb_build_object('highestBefore', v_max::text, 'received', v_seq::text));
  end if;
  return jsonb_build_object('messageId', v_id, 'outcome', 'ACCEPTED', 'sequenceStatus', v_status, 'alarmId', v_alarm);
end
$$;

create function platform.accept_inbound(p_envelope jsonb) returns uuid
language sql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
  select (platform.accept_inbound_detail(p_envelope) ->> 'messageId')::uuid
$$;

-- Records a refusal the adapter received from a receiving transaction that rolled back, with its alarm (DI-31: no
-- silent loss). Called in its own command; the envelope is kept as text (it may be malformed).
create function platform.record_inbound_refusal(p_envelope jsonb, p_error_class text, p_detail text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, kernel, pg_temp as $$
declare
  v_ad    iam.integration_adapter;
  v_key   text;
  v_hash  text;
  v_seq   bigint;
  v_ts    timestamptz;
  v_alarm uuid;
  v_id    uuid;
begin
  perform platform.require_actor();
  v_ad := iam.current_integration_adapter();
  perform platform.authorize('interface.write', 'integration_adapter', v_ad.code);
  if p_error_class is null or p_error_class not in ('MALFORMED', 'DUPLICATE', 'OUT_OF_ORDER', 'WRONG_IDENTITY', 'OUT_OF_RANGE', 'STALE', 'PARTIAL') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-014 %s is not a refusal class (TRANSPORT failures are retried, not recorded)', coalesce(p_error_class, 'null'));
  end if;
  if coalesce(btrim(p_detail), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-INT-014 a refusal is recorded with the refusal''s text';
  end if;
  if jsonb_typeof(p_envelope) = 'object' then
    v_key := case when (p_envelope ->> 'idempotencyKey') ~ '^[\x21-\x7E]{1,128}$' then p_envelope ->> 'idempotencyKey' end;
    v_hash := case when (p_envelope ->> 'payloadHash') ~ '^[0-9a-f]{64}$' then p_envelope ->> 'payloadHash' end;
    v_seq := case when (p_envelope ->> 'sequenceNo') ~ '^[1-9][0-9]{0,17}$' then (p_envelope ->> 'sequenceNo')::bigint end;
    v_ts := case when (p_envelope ->> 'sourceTimestamp') ~ '^(0|[1-9][0-9]{0,17})$'
                  and (p_envelope ->> 'sourceTimestamp')::numeric <= 253402300799999999
                 then platform.epoch_us_to_timestamptz(p_envelope ->> 'sourceTimestamp') end;
  end if;
  v_alarm := platform.raise_integration_alarm(v_ad, p_error_class, 'MAJOR', null,
    jsonb_build_object('idempotencyKey', v_key, 'sequenceNo', v_seq::text, 'detail', left(p_detail, 2000)));
  insert into platform.inbound_exception (adapter_id, adapter_code, kind, error_class, idempotency_key, payload_hash, sequence_no,
                                          source_timestamp, alarm_id, envelope_text, detail)
  values (v_ad.id, v_ad.code, 'REFUSED', p_error_class, v_key, v_hash, v_seq, v_ts, v_alarm,
          left(coalesce(p_envelope::text, 'null'), 65536), left(p_detail, 2000))
  returning id into v_id;
  return v_id;
end
$$;

-- The operator's acknowledgment of an integration alarm (ALARM.ACKNOWLEDGE: people only, never an integration
-- identity, DI-14). Once per alarm.
create function platform.acknowledge_integration_alarm(p_alarm uuid, p_note text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx   jsonb := platform.require_actor();
  v_alarm platform.integration_alarm%rowtype;
begin
  select * into v_alarm from platform.integration_alarm where id = p_alarm;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-INT-007 unknown integration alarm %s', p_alarm);
  end if;
  perform platform.authorize('alarm.acknowledge', 'integration_adapter', v_alarm.adapter_code);
  if coalesce(btrim(p_note), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-INT-008 acknowledging an integration alarm needs a note';
  end if;
  if exists (select 1 from platform.integration_alarm_ack where alarm_id = p_alarm) then
    raise exception using errcode = 'P0001', message = format('EBMR-INT-007 integration alarm %s is already acknowledged', p_alarm);
  end if;
  insert into platform.integration_alarm_ack (alarm_id, adapter_code, note, acknowledged_by, acknowledged_role)
  values (p_alarm, v_alarm.adapter_code, p_note, (v_ctx ->> 'person_id')::uuid, v_ctx ->> 'role_code');
end
$$;

-- Reconciliation of one period of source time: the source's count and checksum against what the eBMR received
-- (accepted messages and recorded refusals that carried a key and a hash; the accepted hash wins). A mismatch raises
-- a RECONCILIATION_MISMATCH alarm. The checksum is reconciliationChecksum of the SDK.
create function platform.record_reconciliation(p_report jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, kernel, pg_temp as $$
declare
  v_ad       iam.integration_adapter;
  v_from     timestamptz;
  v_to       timestamptz;
  v_count    bigint;
  v_sum      text;
  v_accepted bigint;
  v_refused  bigint;
  v_alarm    uuid;
  v_id       uuid;
begin
  perform platform.require_actor();
  v_ad := iam.current_integration_adapter();
  perform platform.authorize('interface.write', 'integration_adapter', v_ad.code);
  if jsonb_typeof(p_report) <> 'object'
     or (select array_agg(k order by k collate "C") from jsonb_object_keys(p_report) k) is distinct from array['periodFrom', 'periodTo', 'sourceChecksum', 'sourceCount']
     or coalesce(p_report ->> 'periodFrom', '') !~ '^(0|[1-9][0-9]{0,17})$' or coalesce(p_report ->> 'periodTo', '') !~ '^(0|[1-9][0-9]{0,17})$'
     or coalesce(p_report ->> 'sourceCount', '') !~ '^(0|[1-9][0-9]{0,17})$' or coalesce(p_report ->> 'sourceChecksum', '') !~ '^[0-9a-f]{64}$'
     or (p_report ->> 'periodFrom')::numeric >= (p_report ->> 'periodTo')::numeric
     or (p_report ->> 'periodTo')::numeric > 253402300799999999 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-INT-015 a reconciliation report has exactly periodFrom < periodTo (epoch microseconds), sourceCount and sourceChecksum (SHA-256 hex)';
  end if;
  v_from := platform.epoch_us_to_timestamptz(p_report ->> 'periodFrom');
  v_to := platform.epoch_us_to_timestamptz(p_report ->> 'periodTo');
  with received as (
    select distinct on (k) k, h from (
      select m.idempotency_key as k, m.payload_hash as h, 0 as pri, m.received_at as at
      from platform.inbound_message m where m.adapter_id = v_ad.id and m.source_timestamp >= v_from and m.source_timestamp < v_to
      union all
      select e.idempotency_key, e.payload_hash, 1, e.recorded_at
      from platform.inbound_exception e
      where e.adapter_id = v_ad.id and e.kind = 'REFUSED' and e.idempotency_key is not null and e.payload_hash is not null
        and e.source_timestamp >= v_from and e.source_timestamp < v_to
    ) x order by k, pri, at
  )
  select count(*), encode(sha256(convert_to(coalesce(string_agg(k || '|' || h, E'\n' order by k collate "C"), ''), 'UTF8')), 'hex')
    into v_count, v_sum from received;
  select count(*) into v_accepted from platform.inbound_message m
    where m.adapter_id = v_ad.id and m.source_timestamp >= v_from and m.source_timestamp < v_to;
  select count(distinct e.idempotency_key) into v_refused from platform.inbound_exception e
    where e.adapter_id = v_ad.id and e.kind = 'REFUSED' and e.source_timestamp >= v_from and e.source_timestamp < v_to;
  if v_count <> (p_report ->> 'sourceCount')::bigint or v_sum <> p_report ->> 'sourceChecksum' then
    v_alarm := platform.raise_integration_alarm(v_ad, 'RECONCILIATION_MISMATCH', 'MAJOR', null,
      jsonb_build_object('periodFrom', p_report ->> 'periodFrom', 'periodTo', p_report ->> 'periodTo', 'sourceCount', p_report ->> 'sourceCount',
                         'receivedCount', v_count::text));
  end if;
  insert into platform.reconciliation_report (adapter_id, adapter_code, period_from, period_to, source_count, source_checksum, received_count,
                                              received_checksum, accepted_count, refused_count, matched, alarm_id)
  values (v_ad.id, v_ad.code, v_from, v_to, (p_report ->> 'sourceCount')::bigint, p_report ->> 'sourceChecksum', v_count, v_sum,
          v_accepted, v_refused, v_alarm is null, v_alarm)
  returning id into v_id;
  return v_id;
end
$$;

-- A successful synchronisation (or heartbeat) of a mirror data class, by an adapter of that class's system.
create function platform.record_mirror_sync(p_data_class text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, kernel, pg_temp as $$
declare
  v_ad  iam.integration_adapter;
  v_cls platform.mirror_data_class%rowtype;
begin
  perform platform.require_actor();
  v_ad := iam.current_integration_adapter();
  perform platform.authorize('interface.write', 'integration_adapter', v_ad.code);
  select * into v_cls from platform.mirror_data_class where code = p_data_class;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-INT-011 unknown mirror data class %s', coalesce(p_data_class, 'null'));
  end if;
  if v_cls.source_system <> v_ad.source_system then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-013 adapter %s (%s) cannot synchronise %s, which mirrors %s', v_ad.code, v_ad.source_system, v_cls.code, v_cls.source_system);
  end if;
  insert into platform.mirror_sync (data_class, adapter_id, last_synced_at) values (v_cls.code, v_ad.id, clock_timestamp())
  on conflict (data_class) do update set adapter_id = excluded.adapter_id, last_synced_at = excluded.last_synced_at;
end
$$;

-- {dataClass, sourceSystem, mode, blocking, asOfUs, ageSeconds, boundSeconds, stale} (MirrorFreshness of the SDK).
create function platform.mirror_freshness(p_data_class text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v_cls   platform.mirror_data_class%rowtype;
  v_mode  text;
  v_bound bigint;
  v_last  timestamptz;
  v_age   bigint;
begin
  select * into v_cls from platform.mirror_data_class where code = p_data_class;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-INT-011 unknown mirror data class %s', coalesce(p_data_class, 'null'));
  end if;
  v_mode := platform.setting_text('integration.mode.' || lower(v_cls.code));
  if v_mode = 'STAND_IN' then
    return jsonb_build_object('dataClass', v_cls.code, 'sourceSystem', v_cls.source_system, 'mode', v_mode, 'blocking', v_cls.blocking,
                              'asOfUs', null, 'ageSeconds', null, 'boundSeconds', null, 'stale', false);
  end if;
  v_bound := platform.setting_numeric('integration.mirror_max_age_s.' || lower(v_cls.code))::bigint;
  select last_synced_at into v_last from platform.mirror_sync where data_class = v_cls.code;
  v_age := case when v_last is null then null else greatest(0, floor(extract(epoch from clock_timestamp() - v_last)))::bigint end;
  return jsonb_build_object('dataClass', v_cls.code, 'sourceSystem', v_cls.source_system, 'mode', v_mode, 'blocking', v_cls.blocking,
                            'asOfUs', case when v_last is null then null else platform.timestamptz_to_epoch_us(v_last) end,
                            'ageSeconds', v_age::text, 'boundSeconds', v_bound::text,
                            'stale', v_last is null or clock_timestamp() - v_last > make_interval(secs => v_bound));
end
$$;

-- The fail-closed guard GMP functions call before they rely on mirrored data (INV-26, INV-38). Returns the freshness
-- when the class may be used (a stale non-blocking class is returned flagged); raises EBMR-INT-010 naming the mirror,
-- its age and its bound when a blocking MIRROR class is stale. STAND_IN has no bound and always passes.
create function platform.mirror_fresh_or_raise(p_data_class text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  f jsonb := platform.mirror_freshness(p_data_class);
begin
  if f ->> 'mode' = 'MIRROR' and (f ->> 'blocking')::boolean and (f ->> 'stale')::boolean then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-010 the %s mirror %s is stale: %s, more than its bound of %s s; data from it cannot be used until the %s adapter synchronises again (call the %s system owner)',
                       f ->> 'sourceSystem', f ->> 'dataClass',
                       case when f ->> 'asOfUs' is null then 'it has never synchronised' else format('last synchronised %s s ago', f ->> 'ageSeconds') end,
                       f ->> 'boundSeconds', f ->> 'sourceSystem', f ->> 'sourceSystem'),
      detail = f::text;
  end if;
  return f;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Seed rows (software release identity, as 0700) and settings
-- ---------------------------------------------------------------------------------------------------------------

select platform.enforce_db_time('iam.integration_adapter', array['registered_at']);
select platform.enforce_db_time('platform.inbound_schema', array['recorded_at']);
select platform.enforce_db_time('platform.inbound_message', array['received_at']);
select platform.enforce_db_time('platform.integration_alarm', array['raised_at']);
select platform.enforce_db_time('platform.integration_alarm_ack', array['acknowledged_at']);
select platform.enforce_db_time('platform.inbound_exception', array['recorded_at']);
select platform.enforce_db_time('platform.reconciliation_report', array['recorded_at']);
select platform.enforce_db_time('platform.mirror_data_class', array['recorded_at']);
select kernel.register_audited_table('iam.integration_adapter', 'integration_adapter', 'code', false);
select kernel.register_audited_table('platform.inbound_schema', 'inbound_schema', 'source_system', true);
select kernel.register_audited_table('platform.inbound_message', 'integration_adapter', 'adapter_code', true);
select kernel.register_audited_table('platform.integration_alarm', 'integration_adapter', 'adapter_code', true);
select kernel.register_audited_table('platform.integration_alarm_ack', 'integration_adapter', 'adapter_code', true);
select kernel.register_audited_table('platform.inbound_exception', 'integration_adapter', 'adapter_code', true);
select kernel.register_audited_table('platform.reconciliation_report', 'integration_adapter', 'adapter_code', true);
select kernel.register_audited_table('platform.mirror_data_class', 'mirror_data_class', 'code', true);

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1180_inbound_adapter_framework)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'inbound message schemas and mirror data classes of the adapter framework (DI-31, Phase 6 slice 6a-0)'));

-- The message types of the system contracts (@ebmr/integration-sdk/adapter, systems/*.ts), version 1.
insert into platform.inbound_schema (source_system, message_type, schema_version, description) values
  ('ERP_WMS', 'erp.production_order', 1, 'A production order with its BOM'),
  ('ERP_WMS', 'erp.material_master', 1, 'A material master'),
  ('ERP_WMS', 'erp.product_master', 1, 'A product master'),
  ('ERP_WMS', 'wms.goods_receipt', 1, 'A delivery with its supplier batches (PR-17)'),
  ('ERP_WMS', 'wms.stock_move', 1, 'A stock move between locations (PR-46)'),
  ('ERP_WMS', 'wms.lot_status', 1, 'The WMS status of a lot'),
  ('ERP_WMS', 'erp.shipment', 1, 'A shipment of a finished lot to a consignee'),
  ('QMS', 'qms.deviation_status', 1, 'The QMS status of a deviation'),
  ('QMS', 'qms.capa', 1, 'A CAPA and its effectiveness-check due date'),
  ('QMS', 'qms.change_control', 1, 'The status of a change control'),
  ('LIMS', 'lims.sample_result', 1, 'A sample result with its raw value and unit'),
  ('LMS', 'lms.qualification', 1, 'A person''s qualification'),
  ('CMMS', 'cmms.calibration', 1, 'A calibration with its result and next due date'),
  ('CMMS', 'cmms.maintenance', 1, 'A maintenance work order and its due date');

insert into platform.mirror_data_class (code, source_system, blocking, description) values
  ('LMS_QUALIFICATION', 'LMS', true, 'Qualifications and training read at signing (outline 4.6)'),
  ('CMMS_CALIBRATION', 'CMMS', true, 'Calibration due dates and results read at equipment use'),
  ('CMMS_MAINTENANCE', 'CMMS', true, 'Maintenance due dates read at equipment use'),
  ('QMS_STATUS', 'QMS', true, 'Deviation and CAPA status read at release (fetched with a version token inside the signing transaction)'),
  ('ERP_LOT_STATUS', 'ERP_WMS', true, 'Lot status in the edition mirror read at reservation and issue'),
  ('ERP_ITEM_MASTER', 'ERP_WMS', false, 'Item master: flagged when old, never blocking'),
  ('WMS_STOCK', 'ERP_WMS', false, 'Quantity on hand: flagged when old, never blocking');

select kernel.set_actor_context(null);

insert into platform.setting_definition (key, value_type, default_value, min_value, max_value, allowed_values, max_scale, unit, description, basis)
select 'integration.mode.' || lower(c.code), 'TEXT', 'STAND_IN', null::numeric, null::numeric, array['STAND_IN', 'MIRROR'], null::integer, null::text,
       format('Whether %s is held by the built-in register (STAND_IN) or mirrored from the %s by its adapter (MIRROR)', c.code, c.source_system),
       'D-P6a-5: one mode per data class and site; switching is a configuration change (DI-09 change record from slice 6f)'
from platform.mirror_data_class c
union all
select 'integration.mirror_max_age_s.' || lower(c.code), 'INTEGER',
       case when c.code = 'QMS_STATUS' then '60' when c.blocking then '3600' else '86400' end, 60::numeric, 604800::numeric, null::text[], null::integer, 's',
       format('Age of the last successful %s synchronisation of %s above which the mirror is stale (%s)', c.source_system, c.code,
              case when c.blocking then 'fails closed' else 'flagged' end),
       'D-P6a-3: LMS and CMMS 60 min, QMS fetched at signing, item master and stock 24 h flagged; owner question 8'
from platform.mirror_data_class c;

grant select on iam.integration_adapter, platform.inbound_schema, platform.inbound_message, platform.integration_alarm,
                platform.integration_alarm_ack, platform.inbound_exception, platform.reconciliation_report, platform.mirror_data_class,
                platform.mirror_sync to ebmr_app;
grant execute on function iam.register_integration_adapter(text, text, uuid, uuid, text), iam.set_integration_adapter_status(uuid, text, text),
                          platform.accept_inbound(jsonb), platform.accept_inbound_detail(jsonb), platform.record_inbound_refusal(jsonb, text, text),
                          platform.acknowledge_integration_alarm(uuid, text), platform.record_reconciliation(jsonb),
                          platform.record_mirror_sync(text), platform.mirror_freshness(text), platform.mirror_fresh_or_raise(text),
                          platform.inbound_envelope_problem(jsonb)
  to ebmr_app;

reset role;
