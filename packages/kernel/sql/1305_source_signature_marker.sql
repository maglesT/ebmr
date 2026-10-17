-- Phase 7 slice 7a (6jc-R9; controls DI-31, DI-20): the edition-neutral marker of a signed inbound source, and the
-- transport peer of each pulled message (interfaces slice-7-0-interfaces.md sections 2 and 3; default D-P7-0-2).
--
-- Handbook: modules/integrations.md
--
-- Before: the database took an OPC UA feed envelope from whoever held the OPCUA adapter's identity. The gateway signed
-- nothing on that feed, so anyone who reached the adapter's credentials (or the application role's, ADR 0012) could
-- write series, alarms, equipment events and endpoint sessions "from the gateway".
--
-- Now:
--   platform.signing_source               insert-only list of the sources whose envelopes must carry their source's
--                                         signature, each with the edition function that verifies it. OPCUA (the
--                                         Tablets verifier tab.accept_gateway_envelope, tablets 1405). An Injectables
--                                         gateway joins with a row of its own (D-P7-0-3).
--   platform.source_requires_signature    true for a source listed there.
--   platform.record_source_verification   (SECURITY DEFINER, granted to nobody: only owner-level edition verifiers call
--                                         it) marks one envelope verified in the current transaction.
--   platform.accept_inbound_detail        (re-created from kernel 1180, every check kept) refuses an envelope of a
--                                         signing source unless this transaction holds its verification, which it uses
--                                         up (EBMR-INT-030); it keeps the verification's text and the transport peer
--                                         with the message. Every receiving command (plant.receive_*, the LMS, CMMS,
--                                         QMS, LIMS, ERP/WMS and L3 ones) calls it before it writes, so a direct call
--                                         of any of them, or of accept_inbound itself, is refused for an OPCUA
--                                         envelope without the gateway's verification.
--   platform.inbound_envelope_problem     (re-created) admits the optional gatewaySignature field in its shape.
--   platform.inbound_message              gains transport_peer (the SHA-256 fingerprint of the TLS peer certificate of
--                                         the page the server pulled the message in, as the server reports it in the
--                                         transaction setting ebmr.transport_peer; null over loopback) and
--                                         source_verification (what verified a signed message). Both additive, null for
--                                         every earlier row.
--
-- The verification table holds a row only inside the transaction that verifies: accept_inbound_detail deletes the row
-- it uses, and a transaction that rolls back leaves none.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Signing sources
-- ---------------------------------------------------------------------------------------------------------------

create table platform.signing_source (
  source_system  text primary key check (source_system in ('ERP_WMS', 'QMS', 'LIMS', 'LMS', 'CMMS', 'EMS', 'OPCUA', 'L3')),
  verifier       text not null check (verifier ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  basis          text not null check (btrim(basis) <> ''),
  recorded_at    timestamptz not null default clock_timestamp()
);
revoke all on platform.signing_source from public;
select platform.make_insert_only('platform.signing_source');
comment on table platform.signing_source is 'Inbound sources whose envelopes carry their source''s signature, and the edition function that verifies it (DI-31, slice 7a). Insert-only.';

insert into platform.signing_source (source_system, verifier, basis)
values ('OPCUA', 'tab.accept_gateway_envelope', 'Phase 7 slice 7a (6jc-R9): the site gateway signs its OPC UA feed with its enrolled Ed25519 key');

create function platform.source_requires_signature(p_source_system text) returns boolean
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select exists (select 1 from platform.signing_source s where s.source_system = p_source_system)
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. The verification of one envelope in this transaction
-- ---------------------------------------------------------------------------------------------------------------

create table platform.source_verification (
  xact          xid8 not null default pg_current_xact_id(),
  envelope_key  text not null check (envelope_key ~ '^[0-9a-f]{64}$'),
  verifier      text not null check (btrim(verifier) <> '' and length(verifier) <= 500),
  recorded_at   timestamptz not null default clock_timestamp()
);
revoke all on platform.source_verification from public;
create index source_verification_xact on platform.source_verification (xact, envelope_key);
comment on table platform.source_verification is 'Transaction-local marks of verified inbound envelopes (slice 7a): written by an edition verifier, used up by accept_inbound_detail in the same transaction.';

-- What identifies one envelope for its verification: every field, and the payload as the database holds it.
create function platform.inbound_envelope_key(p_envelope jsonb) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to(concat_ws(E'\n', 'ebmr-inbound-envelope-v1',
    p_envelope ->> 'sourceSystem', p_envelope ->> 'messageType', p_envelope ->> 'schemaVersion', p_envelope ->> 'sourceRecordId',
    p_envelope ->> 'sourceTimestamp', p_envelope ->> 'sequenceNo', p_envelope ->> 'idempotencyKey', p_envelope ->> 'payloadHash',
    coalesce((p_envelope -> 'payload')::text, 'null'), coalesce((p_envelope -> 'gatewaySignature')::text, 'null')), 'UTF8')), 'hex')
$$;

-- Marks the envelope whose key is p_envelope_key as verified by p_verifier in this transaction. Granted to nobody: the
-- owner's edition verifiers call it after their check.
create function platform.record_source_verification(p_envelope_key text, p_verifier text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
begin
  if p_envelope_key is null or p_envelope_key !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'EBMR-INT-030 a source verification names its envelope by its key (lowercase hex SHA-256)';
  end if;
  if coalesce(btrim(p_verifier), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-INT-030 a source verification names what verified the envelope';
  end if;
  insert into platform.source_verification (envelope_key, verifier) values (p_envelope_key, left(p_verifier, 500));
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. The inbound record gains the transport peer and the verification
-- ---------------------------------------------------------------------------------------------------------------

alter table platform.inbound_message
  add column transport_peer text null check (transport_peer ~ '^[0-9a-f]{64}$'),
  add column source_verification text null check (source_verification is null or btrim(source_verification) <> '');
comment on column platform.inbound_message.transport_peer is 'SHA-256 fingerprint (lowercase hex) of the TLS peer certificate of the page this message was pulled in, as the server reports it (slice 7a); null over loopback without TLS.';
comment on column platform.inbound_message.source_verification is 'What verified the source''s signature of this message (a signing source, slice 7a); null for a source that does not sign.';

-- ---------------------------------------------------------------------------------------------------------------
-- 4. The envelope check admits the gateway signature (re-created from kernel 1180)
-- ---------------------------------------------------------------------------------------------------------------

-- NULL when the envelope has exactly the nine fields in their shapes (as InboundEnvelope of the SDK), plus at most the
-- optional gatewaySignature in its shape (slice 7a), else why not.
create or replace function platform.inbound_envelope_problem(p_envelope jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_keys  text[];
  v_want  text[] := array['idempotencyKey', 'messageType', 'payload', 'payloadHash', 'schemaVersion', 'sequenceNo',
                          'sourceRecordId', 'sourceSystem', 'sourceTimestamp'];
  v_field text;
  v_rx    text;
  v_sig   jsonb;
  v_skeys text[];
begin
  if p_envelope is null or jsonb_typeof(p_envelope) <> 'object' then
    return 'the envelope is not a JSON object';
  end if;
  select array_agg(k order by k collate "C") into v_keys from jsonb_object_keys(p_envelope) k where k <> 'gatewaySignature';
  if v_keys is distinct from v_want then
    return format('the envelope has the fields %s; it needs exactly %s (and may carry gatewaySignature)', v_keys, v_want);
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
  -- Slice 7a: the gateway's signature (GatewaySignature of the SDK), when present.
  if p_envelope ? 'gatewaySignature' then
    v_sig := p_envelope -> 'gatewaySignature';
    if jsonb_typeof(v_sig) <> 'object' then
      return 'gatewaySignature must be an object';
    end if;
    select array_agg(k order by k collate "C") into v_skeys from jsonb_object_keys(v_sig) k;
    if v_skeys is distinct from array['alg', 'gatewayCode', 'keyId', 'sig'] then
      return format('gatewaySignature has the fields %s; it needs exactly {alg,gatewayCode,keyId,sig}', v_skeys);
    end if;
    for v_field, v_rx in select f, r from (values
      ('alg', '^Ed25519$'),
      ('gatewayCode', '^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$'),
      ('keyId', '^[0-9a-f]{64}$'),
      ('sig', '^[A-Za-z0-9+/]{86}==$')) v (f, r)
    loop
      if jsonb_typeof(v_sig -> v_field) <> 'string' or (v_sig ->> v_field) !~ v_rx then
        return format('gatewaySignature.%s must be text matching %s', v_field, v_rx);
      end if;
    end loop;
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 5. The receiving half refuses an unverified envelope of a signing source (re-created from kernel 1180)
-- ---------------------------------------------------------------------------------------------------------------

-- The receiving half of every inbound path (DI-31). Returns {messageId, outcome ACCEPTED|DUPLICATE, sequenceStatus,
-- alarmId}; refuses with EBMR-INT-001 to -006, and EBMR-INT-030 for an envelope of a signing source that was not
-- verified in this transaction (slice 7a). The caller applies the payload in the same transaction only when the
-- outcome is ACCEPTED.
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

revoke all on function platform.source_requires_signature(text), platform.inbound_envelope_key(jsonb),
                       platform.record_source_verification(text, text) from public;
grant select on platform.signing_source to ebmr_app;
grant execute on function platform.source_requires_signature(text) to ebmr_app;

reset role;
