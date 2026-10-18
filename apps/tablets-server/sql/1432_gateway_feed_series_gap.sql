-- Tablets: the gateway's verifier of its OPC UA feed takes the series gap message (Phase 7 slice 7b-1, the T12
-- observation of the gateway, decision 0022; controls DI-32, DI-31).
--
-- Handbook: modules/integrations.md
--
-- tab.accept_gateway_envelope is re-created from tablets 1405, every check kept and in the same order (the envelope's
-- shape, the source, the signature's presence, the adapter's binding, the gateway's ACTIVE trusted key, the payload as
-- signed, the Ed25519 signature, the recorded verification); the dispatch by message type gains opcua.series_gap,
-- received by plant.receive_series_gap (recipe-core 1232), which raises the SERIES_GAP alarm (kernel 1328). Like every
-- other type it reaches its receiving command only after the signature is verified.

set local role ebmr_owner;

create or replace function tab.accept_gateway_envelope(p_envelope json) returns jsonb
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
    -- Slice 7b-1 (recipe-core 1232): a stretch of a series the gateway could not record.
    when 'opcua.series_gap' then return plant.receive_series_gap(v_env);
    else
      raise exception using errcode = 'P0001',
        message = format('EBMR-INT-004 OPCUA message type %s has no receiving command', v_env ->> 'messageType');
  end case;
end
$$;

reset role;
