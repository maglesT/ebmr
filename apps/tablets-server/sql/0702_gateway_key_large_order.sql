-- Tablets server, module C5: a gateway key of small order is neither enrolled nor trusted (SQL mutation kill results,
-- defect D16; controls DI-20, DI-30, DI-31, DI-32).
--
-- D16. The database verifies a reading's Ed25519 signature without the cofactor, as OpenSSL does (0270,
-- tab.ed25519_verify): S below L and the encoding of [S]B - [k]A equal to R. For a public key A of small order
-- ([8]A is the neutral point) that equation needs no private key: with A the neutral point, R = B and S = 1 verify for
-- every message, and for a key of order 2, 4 or 8 a forger tries a few values of S until k is a multiple of the order.
-- tab.enrol_gateway_key (0250) checked only that the key was base64 and that its SHA-256 was the fingerprint the
-- administrator registered for the gateway's SERVER device; it read neither the SubjectPublicKeyInfo's header nor its
-- length nor the point. So a key of small order could be enrolled (by mistake, or by an IAM.DEVICE_MANAGE holder on
-- purpose), and from then on anyone who reached ingestion (the listener, or the application role's credentials, ADR
-- 0012) could store readings "signed by the holder of the enrolled key" (EBMR-DEV-061), prove an upload wait
-- (EBMR-DEV-055) and pass the listener's login proof for that chain without any private key: the DEVICE record would
-- prove nothing about the instrument (DI-32), a forged reading would stand in for a weight that needs a second person
-- when keyed by hand (DI-30), and the interface check would be void (DI-31).
--
-- Now:
--   1. tab.gateway_key_problem(spki) says what is wrong with a gateway key, or null: not base64, or not exactly the
--      44-byte Ed25519 SubjectPublicKeyInfo of RFC 8410 (the fixed 12-byte header 302a300506032b6570032100 and 32
--      bytes) EBMR-DEV-016; not the canonical encoding of a curve point (tab.ed25519_decode) EBMR-DEV-017; a point of
--      small order EBMR-DEV-018 (tab.ed25519_small_order: [8]A has x = 0; the only point of the prime-order group
--      with x = 0 is the neutral point, since (0, -1) has order 2, and [8]A always lies in that group).
--   2. tab.enrol_gateway_key refuses such a key with that code, after the base64 check (EBMR-DEV-011) and before the
--      fingerprint is compared, so the administrator learns what is wrong with the key itself.
--   3. A key of small order enrolled before this migration is never trusted:
--      - tab.bind_gateway_session refuses to bind a session under an enrolled key with any of these problems
--        (EBMR-DEV-025), so the listener's login under it fails whatever its proof (the listener records the
--        refusal with the database's code);
--      - tab.reading_signature_valid and tab.upload_wait_signature_valid are false under a key of small order, so
--        ingestion refuses its readings (EBMR-DEV-061 from the a2_reading_proof trigger) and their waits
--        (EBMR-DEV-055), and a claim refuses a reading stored under it before (EBMR-DEV-110, the stored proof checked
--        again by tab.claim_readings).
--      Its administrator revokes it (tab.revoke_gateway_key, which ends its sessions and bindings) and enrols a new key.
--      A gateway session bound under it before this migration keeps resolving until then, but nothing it sends is
--      stored: its readings and their waits are refused as above.
--
-- tab.ed25519_verify itself is unchanged: it stays the plain RFC 8032 check (its tests reach S's own rules only through
-- a key of small order), and the refusal sits where a gateway key is enrolled or used. The other Ed25519 public keys
-- of the system need nothing here: the kernel's seal keys are verified against the verifier's own key ring, never a
-- key read from the database (kernel esig/keys.ts; esig.seal_key is an archive); browser terminals prove with ECDSA
-- P-256 keys (the server's device-proof check takes no other); a SERVICE_KEY is a secret, not a public key.
--
-- The replaced functions keep their bodies but for the lines marked D16, their owner (ebmr_owner), SECURITY DEFINER
-- or not, search_path and grants (CREATE OR REPLACE). The two new helpers are owned by ebmr_owner, list pg_temp last,
-- and are granted to nobody (only the owner's functions call them).

set local role ebmr_owner;

-- True when p_key (32 bytes) encodes a point A of small order: [8]A is the neutral point. False for a point of large
-- order (every honest key: A = [s]B); null when p_key is not the canonical encoding of a point.
create function tab.ed25519_small_order(p_key bytea) returns boolean
language sql immutable strict set search_path = pg_catalog, tab, pg_temp as $$
  select (tab.ed25519_double(tab.ed25519_double(tab.ed25519_double(tab.ed25519_decode(p_key)))))[1] = 0
$$;

-- What is wrong with a gateway key (base64 SPKI DER of an Ed25519 key): {code, problem, hint}, or null when it is the
-- 44-byte Ed25519 SubjectPublicKeyInfo of a curve point of large order.
create function tab.gateway_key_problem(p_spki text) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_form constant jsonb := jsonb_build_object('code', 'EBMR-DEV-016',
    'problem', 'the gateway public key is not an Ed25519 SubjectPublicKeyInfo (44 bytes: the RFC 8410 header and a 32-byte key)',
    'hint', 'export the gateway''s public key as SPKI DER in base64');
  v_spki bytea;
  v_key  bytea;
begin
  begin
    v_spki := decode(p_spki, 'base64');
  exception when others then
    return v_form;
  end;
  if v_spki is null or length(v_spki) <> 44 or substring(v_spki from 1 for 12) <> '\x302a300506032b6570032100'::bytea then
    return v_form;
  end if;
  v_key := substring(v_spki from 13 for 32);
  if tab.ed25519_decode(v_key) is null then
    return jsonb_build_object('code', 'EBMR-DEV-017',
      'problem', 'the gateway public key is not the encoding of a point of the Ed25519 curve',
      'hint', 'give the public key exactly as the gateway exported it');
  end if;
  if tab.ed25519_small_order(v_key) then
    return jsonb_build_object('code', 'EBMR-DEV-018',
      'problem', 'the gateway public key is of small order (eight times it is the neutral point), so a signature under it proves nothing',
      'hint', 'generate a new key pair on the gateway and register its fingerprint');
  end if;
  return null;
end
$$;

revoke all on function tab.ed25519_small_order(bytea), tab.gateway_key_problem(text) from public;

-- ---------------------------------------------------------------------------------------------
-- Enrolment (0250), refusing a key that is not the Ed25519 SPKI of a point of large order (D16).

create or replace function tab.enrol_gateway_key(p_gateway_code text, p_spki text, p_login_name text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor   jsonb := iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  v_dev     iam.device%rowtype;
  v_acc     iam.account%rowtype;
  v_fp      text;
  v_problem jsonb;
  v_id      uuid;
begin
  select * into v_dev from iam.device where code = p_gateway_code;
  if not found or v_dev.device_class <> 'SERVER' or v_dev.status <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-010 %s is not an active SERVER device in the registry', p_gateway_code);
  end if;
  begin
    v_fp := encode(sha256(decode(p_spki, 'base64')), 'hex');
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-011 the gateway public key is not base64 DER';
  end;
  -- D16: only the 44-byte Ed25519 SPKI of a curve point of large order (EBMR-DEV-016, 017, 018).
  v_problem := tab.gateway_key_problem(p_spki);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('%s DI-20: %s; %s', v_problem ->> 'code', v_problem ->> 'problem', v_problem ->> 'hint');
  end if;
  if v_fp <> v_dev.key_fingerprint then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-011 DI-20: the key''s fingerprint is not the one registered for %s', p_gateway_code);
  end if;
  select * into v_acc from iam.account where login_name = p_login_name;
  if not found or v_acc.kind <> 'INTEGRATION' then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-012 %s is not an INTEGRATION account', p_login_name);
  end if;
  insert into tab.gateway_key (gateway_device_id, gateway_code, account_id, public_key_spki, key_fingerprint, enrolled_by_person)
  values (v_dev.id, v_dev.code, v_acc.id, p_spki, v_fp, (v_actor ->> 'person_id')::uuid)
  returning id into v_id;
  perform kernel.audit_business_event('gateway_key:' || v_id,
    format('Gateway key of %s enrolled for account %s', v_dev.code, p_login_name),
    jsonb_build_object('gateway_code', v_dev.code, 'fingerprint', v_fp));
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Gateway sessions (0250): no session binds under an enrolled key enrolment would now refuse (D16).

create or replace function tab.bind_gateway_session(p_session uuid, p_token_hash text, p_spki text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_s       iam.session%rowtype;
  v_acc     iam.account%rowtype;
  v_key     tab.gateway_key%rowtype;
  v_problem jsonb;
begin
  select * into v_s from iam.session where id = p_session and ended_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-020 the gateway session does not exist or has ended';
  end if;
  if clock_timestamp() - v_s.opened_at > interval '10 seconds' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-021 only a session opened in the last 10 seconds can be bound';
  end if;
  if exists (select 1 from tab.gateway_session where session_id = p_session) or exists (select 1 from tab.session_binding where session_id = p_session) then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-022 the session is already bound';
  end if;
  select * into v_acc from iam.account where id = v_s.account_id;
  if v_acc.kind <> 'INTEGRATION' or v_s.device_class <> 'SERVER' then
    raise exception using errcode = 'P0001',
      message = 'EBMR-DEV-023 DI-31: only an INTEGRATION account on a SERVER device can open a gateway session';
  end if;
  select * into v_key from tab.gateway_key where gateway_device_id = v_s.device_id and status = 'ACTIVE';
  if not found or v_key.public_key_spki <> p_spki or v_key.account_id <> v_s.account_id then
    raise exception using errcode = 'P0001',
      message = 'EBMR-DEV-024 DI-20: no active gateway key enrolled for this device, key and account';
  end if;
  -- D16: a key enrolled before 0702 that is no Ed25519 key of large order proves nothing; no session binds under it.
  v_problem := tab.gateway_key_problem(v_key.public_key_spki);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-025 DI-20: the gateway key enrolled for %s cannot be trusted: %s; revoke it and enrol a new key',
                       v_key.gateway_code, v_problem ->> 'problem');
  end if;
  insert into tab.gateway_session (token_hash, session_id, gateway_key_id) values (p_token_hash, p_session, v_key.id);
  return jsonb_build_object(
    'chain_id', v_key.id,
    'gateway_code', v_key.gateway_code,
    'head', tab.chain_head(v_key.id),
    'installation', kernel.installation_kind(),
    'server_time_us', platform.epoch_micros(clock_timestamp())::text,
    'instruments', coalesce((
      select jsonb_agg(jsonb_build_object('deviceCode', b.device_code, 'serial', b.expected_serial, 'unit', b.unit,
                                          'resolution', b.resolution, 'roomCode', d.room_code) order by b.device_code)
        from tab.gateway_instrument b join iam.device d on d.id = b.instrument_device_id
       where b.gateway_key_id = v_key.id and b.ended_at is null), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The signature checks (0270, 0330): false under a key of small order, whatever the signature (D16).

create or replace function tab.reading_signature_valid(p_spki text, p_hash text, p_signature text) returns boolean
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_spki bytea;
begin
  if p_spki is null or p_hash is null or p_signature is null or p_hash !~ '^[0-9a-f]{64}$' or p_signature !~ '^[A-Za-z0-9+/]{85}[AQgw]==$' then
    return false;
  end if;
  begin
    v_spki := decode(p_spki, 'base64');
  exception when others then
    return false;
  end;
  if length(v_spki) <> 44 or substring(v_spki from 1 for 12) <> '\x302a300506032b6570032100'::bytea then
    return false;
  end if;
  -- D16: under a key of small order anyone can build a signature that verifies.
  if tab.ed25519_small_order(substring(v_spki from 13 for 32)) then
    return false;
  end if;
  return tab.ed25519_verify(substring(v_spki from 13 for 32), convert_to('ebmr.scale-reading.v1|' || p_hash, 'UTF8'), decode(p_signature, 'base64'));
end
$$;

create or replace function tab.upload_wait_signature_valid(p_spki text, p_challenge uuid, p_reading_id uuid, p_delay_us bigint, p_signature text)
returns boolean
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_spki bytea;
begin
  if p_spki is null or p_challenge is null or p_reading_id is null or p_delay_us is null or p_delay_us < 0
     or p_signature is null or p_signature !~ '^[A-Za-z0-9+/]{85}[AQgw]==$' then
    return false;
  end if;
  begin
    v_spki := decode(p_spki, 'base64');
  exception when others then
    return false;
  end;
  if length(v_spki) <> 44 or substring(v_spki from 1 for 12) <> '\x302a300506032b6570032100'::bytea then
    return false;
  end if;
  -- D16: under a key of small order anyone can build a signature that verifies.
  if tab.ed25519_small_order(substring(v_spki from 13 for 32)) then
    return false;
  end if;
  return tab.ed25519_verify(substring(v_spki from 13 for 32),
    convert_to('ebmr.upload-wait.v1|' || p_challenge::text || '|' || p_reading_id::text || '|' || p_delay_us::text, 'UTF8'),
    decode(p_signature, 'base64'));
end
$$;

reset role;
