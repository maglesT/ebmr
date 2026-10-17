-- Tablets: the database verifies the site gateway's signature of its OPC UA feed (Phase 7 slice 7a, 6jc-R9; controls
-- DI-31, DI-20; interfaces slice-7-0-interfaces.md section 2; kernel 1305).
--
-- Handbook: modules/integrations.md
--
-- The gateway signs every envelope of its OPC UA feed with its enrolled Ed25519 key (tab.gateway_key) over the message of
-- feedSignatureMessage (@ebmr/integration-sdk/adapter). The OPCUA adapter hands each envelope to
-- tab.accept_gateway_envelope, which verifies it and only then calls the receiving command of its message type; the
-- kernel (1305) refuses an OPCUA envelope that reaches any receiving command without that verification in the same
-- transaction (EBMR-INT-030), so the adapter's identity cannot go around the check.
--
--   tab.gateway_feed_binding       which gateway's feed each OPCUA adapter pulls (one live binding per adapter; ended,
--                                  never changed or deleted; audited). Set by the device administrator
--                                  (IAM.DEVICE_MANAGE) with tab.bind_gateway_feed.
--   tab.feed_signature_message     the SQL twin of feedSignatureMessage (tested against the SDK's committed vectors,
--                                  packages/integration-sdk/fixtures/feed-signature-v1.json).
--   tab.accept_gateway_envelope    SECURITY DEFINER, INTERFACE.WRITE of the calling OPCUA adapter. Takes the envelope as
--                                  json, not jsonb, so the payload's text as sent is kept: its SHA-256 must be the
--                                  payloadHash the gateway signed (jsonb would reorder the payload's keys and the
--                                  payload could be swapped under a valid signature). Refuses:
--     EBMR-INT-030  no gatewaySignature on the envelope;
--     EBMR-INT-031  the adapter is bound to no gateway, or gatewayCode has no ACTIVE key whose SHA-256 is keyId (unknown,
--                   revoked, or a key the database does not trust: tablets 0702);
--     EBMR-INT-032  the payload is not the one whose hash was signed, or the signature does not verify (a replay with a
--                   new sequence number, another type or another payload hash among them);
--     EBMR-INT-033  gatewayCode is not the gateway bound to the adapter, or keyId is the ACTIVE key of another gateway.
--   Each refusal raises, so the transaction leaves nothing; the adapter worker records it with its alarm in its own
--   command (platform.record_inbound_refusal, kernel 1180), the 6a pattern. An exact resend is verified again and
--   de-duplicated by its idempotency key as before.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. The gateway whose feed an OPCUA adapter pulls
-- ---------------------------------------------------------------------------------------------------------------

create table tab.gateway_feed_binding (
  id               uuid primary key default gen_random_uuid(),
  adapter_id       uuid not null references iam.integration_adapter (id),
  adapter_code     text not null,
  gateway_code     text not null check (gateway_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$'),
  bound_by_person  uuid not null,
  bound_at         timestamptz not null default clock_timestamp(),
  ended_at         timestamptz,
  ended_reason     text,
  check ((ended_at is null) = (ended_reason is null))
);
create unique index gateway_feed_binding_one_live on tab.gateway_feed_binding (adapter_id) where ended_at is null;

create function tab.gateway_feed_binding_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.ended_at is not null then
      raise exception using errcode = 'P0001', message = 'EBMR-DEV-177 a gateway feed binding starts live';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.adapter_id <> old.adapter_id or new.adapter_code <> old.adapter_code or new.gateway_code <> old.gateway_code
     or new.bound_by_person <> old.bound_by_person or new.bound_at <> old.bound_at or old.ended_at is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-177 a gateway feed binding never changes; end it and bind again';
  end if;
  return new;
end
$$;
create trigger aa_gateway_feed_binding_guard before insert or update on tab.gateway_feed_binding for each row execute function tab.gateway_feed_binding_guard();
create trigger aa_gateway_feed_binding_no_delete before delete or truncate on tab.gateway_feed_binding for each statement execute function kernel.reject_mutation();
select kernel.register_audited_table('tab.gateway_feed_binding', 'gateway_feed_binding', 'adapter_code', false);
comment on table tab.gateway_feed_binding is 'The site gateway whose signed OPC UA feed each OPCUA adapter pulls (slice 7a, DI-20, DI-31): one live binding per adapter.';

-- Binds the OPCUA adapter p_adapter_code to the feed of gateway p_gateway_code (which has an ACTIVE enrolled key); a
-- live binding of the adapter to another gateway ends with the reason given.
create function tab.bind_gateway_feed(p_adapter_code text, p_gateway_code text, p_reason_code text, p_reason_text text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, platform, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  v_ad    iam.integration_adapter%rowtype;
  v_live  tab.gateway_feed_binding%rowtype;
  v_saved jsonb;
  v_id    uuid;
begin
  select * into v_ad from iam.integration_adapter where code = p_adapter_code;
  if not found or v_ad.status <> 'ACTIVE' or not platform.source_requires_signature(v_ad.source_system) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-178 %s is not an active adapter of a signed gateway feed (OPCUA)', coalesce(p_adapter_code, 'null'));
  end if;
  if not exists (select 1 from tab.gateway_key k where k.gateway_code = p_gateway_code and k.status = 'ACTIVE') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-178 gateway %s has no active enrolled key; enrol its key first (tab.enrol_gateway_key)', coalesce(p_gateway_code, 'null'));
  end if;
  select * into v_live from tab.gateway_feed_binding where adapter_id = v_ad.id and ended_at is null;
  if found then
    if v_live.gateway_code = p_gateway_code then
      return v_live.id;
    end if;
    v_saved := tab.with_reason_context(p_reason_code, p_reason_text);
    update tab.gateway_feed_binding set ended_at = clock_timestamp(), ended_reason = p_reason_text where id = v_live.id;
    perform kernel.set_actor_context(v_saved);
  end if;
  insert into tab.gateway_feed_binding (adapter_id, adapter_code, gateway_code, bound_by_person)
  values (v_ad.id, v_ad.code, p_gateway_code, (v_actor ->> 'person_id')::uuid)
  returning id into v_id;
  perform kernel.audit_business_event('gateway_feed_binding:' || v_id,
    format('OPC UA adapter %s bound to the feed of gateway %s', v_ad.code, p_gateway_code),
    jsonb_build_object('adapter_code', v_ad.code, 'gateway_code', p_gateway_code));
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. The signed message (the SQL twin of feedSignatureMessage, SDK adapter/feed-signature.ts)
-- ---------------------------------------------------------------------------------------------------------------

-- The UTF-8 bytes of the eight lines joined by a line feed, no line feed at the end:
--   ebmr-gateway-feed-v1 / gatewayCode / sourceSystem / messageType@schemaVersion / sequenceNo / idempotencyKey /
--   payloadHash / keyId.
-- Null when a field is outside its envelope rule (none of those rules admits a line feed, so no field can forge a line).
create function tab.feed_signature_message(p_envelope jsonb, p_gateway_code text, p_key_id text) returns bytea
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v_field text;
  v_rx    text;
begin
  if p_envelope is null or jsonb_typeof(p_envelope) <> 'object'
     or p_gateway_code is null or p_gateway_code !~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$'
     or p_key_id is null or p_key_id !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  for v_field, v_rx in select f, r from (values
    ('sourceSystem', '^(ERP_WMS|QMS|LIMS|LMS|CMMS|EMS|OPCUA|L3)$'),
    ('messageType', '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$'),
    ('schemaVersion', '^[1-9][0-9]{0,3}$'),
    ('sequenceNo', '^[1-9][0-9]{0,17}$'),
    ('idempotencyKey', '^[\x21-\x7E]{1,128}$'),
    ('payloadHash', '^[0-9a-f]{64}$')) v (f, r)
  loop
    if jsonb_typeof(p_envelope -> v_field) is distinct from 'string' or (p_envelope ->> v_field) !~ v_rx then
      return null;
    end if;
  end loop;
  return convert_to(concat_ws(E'\n',
    'ebmr-gateway-feed-v1',
    p_gateway_code,
    p_envelope ->> 'sourceSystem',
    (p_envelope ->> 'messageType') || '@' || (p_envelope ->> 'schemaVersion'),
    p_envelope ->> 'sequenceNo',
    p_envelope ->> 'idempotencyKey',
    p_envelope ->> 'payloadHash',
    p_key_id), 'UTF8');
end
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. The verifier of the gateway feed
-- ---------------------------------------------------------------------------------------------------------------

create function tab.accept_gateway_envelope(p_envelope json) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, plant, platform, iam, kernel, pg_temp as $$
declare
  v_ad      iam.integration_adapter;
  v_env     jsonb;
  v_problem text;
  v_sig     jsonb;
  v_gw      text;
  v_kid     text;
  v_bound   text;
  v_key     tab.gateway_key%rowtype;
  v_owner   text;
  v_spki    bytea;
  v_msg     bytea;
  v_ok      boolean;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_ad := iam.current_integration_adapter();
  v_env := p_envelope::jsonb;
  v_problem := platform.inbound_envelope_problem(v_env);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-INT-001 malformed inbound envelope: %s', v_problem);
  end if;
  if v_env ->> 'sourceSystem' <> v_ad.source_system
     or not exists (select 1 from platform.signing_source s where s.source_system = v_ad.source_system and s.verifier = 'tab.accept_gateway_envelope') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-003 tab.accept_gateway_envelope verifies the gateway''s OPC UA feed; adapter %s of %s sent a %s envelope',
                       v_ad.code, v_ad.source_system, v_env ->> 'sourceSystem');
  end if;
  v_sig := v_env -> 'gatewaySignature';
  if v_sig is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-030 the OPC UA feed envelope %s (sequence %s) carries no gatewaySignature; the gateway signs every envelope of its feed',
                       v_env ->> 'idempotencyKey', v_env ->> 'sequenceNo');
  end if;
  v_gw := v_sig ->> 'gatewayCode';
  v_kid := v_sig ->> 'keyId';
  select b.gateway_code into v_bound from tab.gateway_feed_binding b where b.adapter_id = v_ad.id and b.ended_at is null;
  if v_bound is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-031 adapter %s is bound to no gateway feed (tab.bind_gateway_feed); envelope %s refused', v_ad.code, v_env ->> 'idempotencyKey');
  end if;
  if v_gw <> v_bound then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-033 envelope %s is signed as gateway %s; adapter %s pulls the feed of gateway %s', v_env ->> 'idempotencyKey', v_gw, v_ad.code, v_bound);
  end if;
  select * into v_key from tab.gateway_key k where k.gateway_code = v_gw and k.status = 'ACTIVE' and k.key_fingerprint = v_kid;
  if not found then
    select k.gateway_code into v_owner from tab.gateway_key k where k.status = 'ACTIVE' and k.key_fingerprint = v_kid and k.gateway_code <> v_gw limit 1;
    if v_owner is not null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-INT-033 envelope %s names key %s, the active key of gateway %s, not of gateway %s', v_env ->> 'idempotencyKey', v_kid, v_owner, v_gw);
    end if;
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-031 gateway %s has no active enrolled key %s; envelope %s refused', v_gw, v_kid, v_env ->> 'idempotencyKey');
  end if;
  -- Tablets 0702 (D16): a key the database does not trust (not an Ed25519 SPKI, not a point, small order) is never used.
  if tab.gateway_key_problem(v_key.public_key_spki) is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-031 the enrolled key %s of gateway %s is not trusted (%s); revoke it and enrol a new one', v_kid, v_gw,
                       tab.gateway_key_problem(v_key.public_key_spki) ->> 'code');
  end if;
  -- The payload as sent is the one whose hash the gateway signed.
  if encode(sha256(convert_to((p_envelope -> 'payload')::text, 'UTF8')), 'hex') <> v_env ->> 'payloadHash' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-032 the payload of envelope %s is not the one whose hash gateway %s signed', v_env ->> 'idempotencyKey', v_gw);
  end if;
  v_spki := decode(v_key.public_key_spki, 'base64');
  v_msg := tab.feed_signature_message(v_env, v_gw, v_kid);
  v_ok := v_msg is not null and tab.ed25519_verify(substring(v_spki from 13 for 32), v_msg, decode(v_sig ->> 'sig', 'base64'));
  if not coalesce(v_ok, false) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-INT-032 the signature of envelope %s (sequence %s) does not verify under the key %s of gateway %s',
                       v_env ->> 'idempotencyKey', v_env ->> 'sequenceNo', v_kid, v_gw);
  end if;
  perform platform.record_source_verification(platform.inbound_envelope_key(v_env),
    format('tab.accept_gateway_envelope: gateway %s key %s', v_gw, v_kid));
  case v_env ->> 'messageType'
    when 'opcua.series_chunk' then return plant.receive_series_chunk(v_env);
    when 'opcua.alarm' then return plant.receive_equipment_alarm(v_env);
    when 'opcua.equipment_event' then return plant.receive_equipment_event(v_env);
    when 'opcua.endpoint_session' then return plant.receive_opcua_endpoint_session(v_env);
    else
      raise exception using errcode = 'P0001',
        message = format('EBMR-INT-004 OPCUA message type %s has no receiving command', v_env ->> 'messageType');
  end case;
end
$$;

revoke all on tab.gateway_feed_binding from public;
grant select on tab.gateway_feed_binding to ebmr_app;
revoke all on function tab.gateway_feed_binding_guard(), tab.bind_gateway_feed(text, text, text, text), tab.feed_signature_message(jsonb, text, text),
                       tab.accept_gateway_envelope(json) from public;
grant execute on function tab.bind_gateway_feed(text, text, text, text), tab.accept_gateway_envelope(json) to ebmr_app;

reset role;
