-- Phase 7 slice 7c (DI-06 clause 1): an interface missing from the approved system description raises the
-- INTERFACE_DRIFT alarm and is refused (interfaces slice-7-0-interfaces.md section 4; kernel 1300 holds the description).
--
-- Handbook: modules/integrations.md
--
-- Before: kernel 1300 recorded the approved system description (configuration area SYSTEM_DESCRIPTION, one version per
-- adapter code) but nothing read it: an adapter registered and enabled on a GMP installation exchanged messages whether
-- or not the description named it.
--
-- Now, on a GMP installation (a sandbox is not validated and has no approved description: not gated, as DI-03's
-- interlock; D-P7c-1):
--   platform.interface_drift_problem(adapter)  EBMR-INT-035 with why when the adapter's interface is not DESCRIBED in the
--                                              version in force of the system description, else NULL. Owner only.
--   platform.accept_inbound_detail             (re-created from kernel 1305, every check kept, in the same order) refuses
--                                              the message of such an adapter right after its identity and permission
--                                              checks (EBMR-INT-035). Every receiving command calls it, so a direct call
--                                              of any of them is refused too.
--   platform.record_inbound_refusal            (re-created from kernel 1180, every check kept) raises the alarm of such an
--                                              adapter's refusal as INTERFACE_DRIFT (CRITICAL), whatever class the adapter
--                                              names: the database decides, from the description.
--   platform.check_adapter_start()             the adapter's start (the server calls it as the adapter before its first
--                                              cycle): NULL when the interface is described; else it raises the
--                                              INTERFACE_DRIFT alarm and returns why, and the server does not start it.
--   iam.integration_adapter trigger            enabling an adapter (registered ACTIVE, or set ACTIVE again) whose interface
--                                              is not described raises the INTERFACE_DRIFT alarm in the same transaction:
--                                              "enable an interface that is not in the approved description, the drift
--                                              alarm fires" (DI-06 catalog test).
--   platform.integration_alarm.kind            gains INTERFACE_DRIFT (re-created from kernel 1328: SERIES_GAP kept).
--
-- A refused message leaves nothing: the receiving transaction rolls back, and the alarm is written by the refusal's own
-- command (platform.record_inbound_refusal, ACK_RULE of the integration SDK), by the start check or by the enabling
-- transaction. Messages: EBMR-INT-035.

set local role ebmr_owner;

alter table platform.integration_alarm drop constraint integration_alarm_kind_check;
alter table platform.integration_alarm add constraint integration_alarm_kind_check check (kind in (
  'SEQUENCE_GAP', 'OUT_OF_ORDER', 'MALFORMED', 'DUPLICATE', 'WRONG_IDENTITY', 'OUT_OF_RANGE', 'STALE', 'PARTIAL', 'TRANSPORT',
  'RECONCILIATION_MISMATCH', 'SERIES_GAP', 'INTERFACE_DRIFT'));

-- NULL when adapter p_adapter may exchange messages under the approved system description, else EBMR-INT-035 with why.
create function platform.interface_drift_problem(p_adapter iam.integration_adapter) returns text
language plpgsql stable security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_status text;
begin
  if kernel.installation_kind() <> 'GMP' then
    return null;
  end if;
  if platform.interface_described(p_adapter.code) then
    return null;
  end if;
  select d.status into v_status from platform.system_description() d where d.adapter_code = p_adapter.code;
  return format('EBMR-INT-035 interface drift: adapter %s (%s) is %s the approved system description of this GMP installation; its messages and its start are refused until the system owner describes it under an approved change record (DI-06)',
                p_adapter.code, p_adapter.source_system, case when v_status = 'WITHDRAWN' then 'withdrawn from' else 'not in' end);
end
$$;

create or replace function platform.accept_inbound_detail(p_envelope jsonb) returns jsonb
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
  v_verified text;
  v_peer    text;
begin
  v_ad := iam.current_integration_adapter();
  perform platform.authorize('interface.write', 'integration_adapter', v_ad.code);
  -- Slice 7c (DI-06): on a GMP installation an interface missing from the approved system description is refused
  -- before anything of its message is read (EBMR-INT-035); the adapter records the refusal, which raises the
  -- INTERFACE_DRIFT alarm (platform.record_inbound_refusal).
  v_problem := platform.interface_drift_problem(v_ad);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = v_problem;
  end if;
  v_problem := platform.inbound_envelope_problem(p_envelope);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-INT-001 malformed inbound envelope: %s', v_problem);
  end if;
  if p_envelope ->> 'sourceSystem' <> v_ad.source_system then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-003 adapter %s speaks for %s, not for %s', v_ad.code, v_ad.source_system, p_envelope ->> 'sourceSystem');
  end if;
  -- Slice 7a (DI-31): an envelope of a signing source is taken only with its verification in this transaction, which it
  -- uses up (one verification, one envelope).
  if platform.source_requires_signature(v_ad.source_system) then
    with used as (
      delete from platform.source_verification v
       where v.xact = pg_current_xact_id() and v.envelope_key = platform.inbound_envelope_key(p_envelope)
      returning v.verifier
    )
    select min(u.verifier) into v_verified from used u;
    if v_verified is null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-INT-030 an envelope of %s is taken only with its source''s verified signature (%s); adapter %s sent %s %s without it',
                         v_ad.source_system, (select s.verifier from platform.signing_source s where s.source_system = v_ad.source_system),
                         v_ad.code, p_envelope ->> 'messageType', p_envelope ->> 'idempotencyKey');
    end if;
  end if;
  v_peer := nullif(current_setting('ebmr.transport_peer', true), '');
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
                                        idempotency_key, schema_version, payload_hash, payload, sequence_status, received_by_person, correlation_id,
                                        transport_peer, source_verification)
  values (v_ad.id, v_ad.code, v_ad.source_system, p_envelope ->> 'messageType', p_envelope ->> 'sourceRecordId',
          platform.epoch_us_to_timestamptz(p_envelope ->> 'sourceTimestamp'), v_seq, p_envelope ->> 'idempotencyKey',
          (p_envelope ->> 'schemaVersion')::integer, p_envelope ->> 'payloadHash', p_envelope -> 'payload', v_status,
          (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'correlation_id')::uuid, v_peer, v_verified)
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

create or replace function platform.record_inbound_refusal(p_envelope jsonb, p_error_class text, p_detail text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, kernel, pg_temp as $$
declare
  v_ad    iam.integration_adapter;
  v_key   text;
  v_hash  text;
  v_seq   bigint;
  v_ts    timestamptz;
  v_alarm uuid;
  v_id    uuid;
  v_drift text;
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
  -- Slice 7c (DI-06): the refusal of an interface missing from the approved system description raises the
  -- INTERFACE_DRIFT alarm, whatever class the adapter gives: the database, not the adapter, decides it.
  v_drift := platform.interface_drift_problem(v_ad);
  if v_drift is not null then
    v_alarm := platform.raise_integration_alarm(v_ad, 'INTERFACE_DRIFT', 'CRITICAL', null,
      jsonb_build_object('idempotencyKey', v_key, 'sequenceNo', v_seq::text, 'refusedAs', p_error_class, 'detail', left(v_drift, 2000)));
  else
    v_alarm := platform.raise_integration_alarm(v_ad, p_error_class, 'MAJOR', null,
      jsonb_build_object('idempotencyKey', v_key, 'sequenceNo', v_seq::text, 'detail', left(p_detail, 2000)));
  end if;
  insert into platform.inbound_exception (adapter_id, adapter_code, kind, error_class, idempotency_key, payload_hash, sequence_no,
                                          source_timestamp, alarm_id, envelope_text, detail)
  values (v_ad.id, v_ad.code, 'REFUSED', p_error_class, v_key, v_hash, v_seq, v_ts, v_alarm,
          left(coalesce(p_envelope::text, 'null'), 65536), left(p_detail, 2000))
  returning id into v_id;
  return v_id;
end
$$;

-- The adapter's start (header): called as the adapter. NULL when it may start; else the INTERFACE_DRIFT alarm is raised
-- (committed with this command) and the refusal returned.
create function platform.check_adapter_start() returns text
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, kernel, pg_temp as $$
declare
  v_ad      iam.integration_adapter;
  v_problem text;
begin
  perform platform.require_actor();
  v_ad := iam.current_integration_adapter();
  perform platform.authorize('interface.write', 'integration_adapter', v_ad.code);
  v_problem := platform.interface_drift_problem(v_ad);
  if v_problem is not null then
    perform platform.raise_integration_alarm(v_ad, 'INTERFACE_DRIFT', 'CRITICAL', null,
      jsonb_build_object('at', 'ADAPTER_START', 'detail', v_problem));
  end if;
  return v_problem;
end
$$;

-- Enabling an adapter whose interface is not described raises the drift alarm (header).
create function iam.integration_adapter_drift_alarm() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform, iam, pg_temp as $$
declare
  v_problem text;
begin
  if new.status <> 'ACTIVE' or (tg_op = 'UPDATE' and old.status = 'ACTIVE') then
    return null;
  end if;
  v_problem := platform.interface_drift_problem(new);
  if v_problem is not null then
    perform platform.raise_integration_alarm(new, 'INTERFACE_DRIFT', 'CRITICAL', null,
      jsonb_build_object('at', case when tg_op = 'INSERT' then 'REGISTERED' else 'ENABLED' end, 'detail', v_problem));
  end if;
  return null;
end
$$;
create trigger zz_integration_adapter_drift_alarm after insert or update of status on iam.integration_adapter
  for each row execute function iam.integration_adapter_drift_alarm();

revoke all on function platform.interface_drift_problem(iam.integration_adapter), platform.check_adapter_start(),
                       iam.integration_adapter_drift_alarm() from public;
grant execute on function platform.check_adapter_start() to ebmr_app;

reset role;
