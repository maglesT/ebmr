-- Tablets server, module C5: the wait of a reading before the transaction that ingests it is proven to the database,
-- through a challenge the database issues and the gateway signs together with its own wait (review finding P53,
-- round-2 verification; controls DI-28, DI-31, DI-32).
--
-- P53 residual. The age of a reading at claim time is the database time minus recorded_us (the insert) plus
-- uplink_delay_us, the time it had waited before the insert. 0270 made the database count its own part, from the
-- start of the ingesting transaction to the insert; 0320 bounded a DEVICE_SYNCED reading by its signed capture time.
-- The wait before the ingesting transaction began was still p_delay_us, the application's word: a holder of the
-- application role's credentials could keep back a genuinely signed DEVICE_UNSYNCED reading for any time, ingest it
-- reporting no wait, and have it claimed as fresh. The proof below closes that; the interim alternative (refusing
-- every DEVICE_UNSYNCED reading at claim) is not needed.
--
-- The protocol (one challenge per upload):
--   1. The gateway asks for a challenge (POST /gw/v1/challenge). tab.issue_ingest_challenge, inside the gateway
--      session's INTEGRATION command (INTERFACE.WRITE, role SITE_GATEWAY, as for ingestion), stores a random id
--      (gen_random_uuid) with the database clock (clock_timestamp()) and the enrolment of the session's key, in
--      tab.ingest_challenge, which only the owner can read or write. The application cannot choose, predict or
--      back-date a challenge.
--   2. Only after the answer arrives, the gateway measures each reading's wait on its monotonic clock (capture to
--      now) and signs, with its enrolled Ed25519 key, "ebmr.upload-wait.v1|<challenge>|<reading id>|<wait>"
--      (the SDK's uploadWaitMessage; ids as lower-case text, the wait in plain decimal microseconds).
--   3. tab.ingest_reading(p_reading, p_delay_us, p_challenge, p_wait_signature) verifies that signature under the
--      key enrolled for the reading's chain (tab.ed25519_verify, 0270) and stores as the wait p_delay_us plus the
--      database time from the challenge's issue to the insert.
-- Why that bounds the age: the gateway could sign only after the challenge existed, so everything after the signing
-- (the way back to the server, any queue, pool, transaction or lock at the server, and any time an application holds
-- the upload back) lies inside "challenge issued to insert", and everything before the signing inside the signed
-- wait. The stored wait is therefore never less than the time since capture; it errs on the stricter side by the
-- time between the issue and the signing (a round trip). The database's own wait inside the transaction (0270) is
-- part of it, so it is no longer added separately.
--
-- Refusals (the reading is not stored; the listener records the refusal and the gateway sends the reading again with
-- a fresh challenge):
--   EBMR-DEV-053  a wait is given without a challenge or without the gateway's signature over it;
--   EBMR-DEV-054  the challenge is unknown (never issued, or removed a day after its issue) or was issued to another
--                 enrolment than the reading's chain (another gateway, or a key since revoked);
--   EBMR-DEV-055  the signature over challenge, reading id and wait does not verify with the enrolled key (a changed
--                 wait, a signature made for another challenge or reading, or a forged one).
-- EBMR-DEV-051 (negative) and EBMR-DEV-052 (above 100 years) are kept. An unknown wait (null, sent after a gateway
-- restart) needs no proof and stays unknown, so the reading is kept but never claimable (EBMR-DEV-104).
--
-- The two-argument tab.ingest_reading(jsonb, bigint) is dropped, so no caller can store a wait the database has not
-- proven. What the database still cannot prove: that the gateway measured its own wait truthfully; that trust rests
-- on the gateway key, as the reading's content does (0270).
--
-- Challenges are operational state, not GMP data (like tab.device_nonce): tab.issue_ingest_challenge removes those
-- issued more than a day before, which can bound no usable reading (the maximum age of a claim is at most one hour,
-- EBMR-DEV-108). The audit entry of an ingested reading records the challenge, the gateway's signed wait and the
-- database's wait since the challenge.
--
-- Privileges: every function is owned by ebmr_owner, pg_temp last in search_path (ADR 0016); the new
-- tab.ingest_reading keeps the owner, SECURITY DEFINER, search_path and grants of the dropped one (EXECUTE for
-- ebmr_app, none for PUBLIC). ebmr_app gains EXECUTE on tab.issue_ingest_challenge only; the table and the
-- signature helper are not granted.

set local role ebmr_owner;

create table tab.ingest_challenge (
  id              uuid primary key default gen_random_uuid(),
  -- The enrolment (tab.gateway_key.id) of the session's key. No foreign key: its row lock would make an issue wait
  -- for every ingestion of the chain in flight (they hold that row FOR UPDATE); the id comes from the database.
  gateway_key_id  uuid not null,
  -- The gateway session that asked (traceability; the proof is bound to the enrolment, not to the session).
  session_id      uuid not null,
  issued_at       timestamptz not null default clock_timestamp()
);
create index ingest_challenge_issued_at on tab.ingest_challenge (issued_at);
revoke all on tab.ingest_challenge from public;

-- Inside an INTEGRATION command of a bound gateway session in the role SITE_GATEWAY (as tab.ingest_reading): a new
-- challenge for one upload of that session's enrolment, {challengeId, issuedUs}. The issue time is the database
-- clock when the row is written, before the id is known to anyone.
create function tab.issue_ingest_challenge() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key   tab.gateway_key%rowtype;
  v_id    uuid;
  v_at    timestamptz;
begin
  perform iam.assert_not_administrator();
  v_key := tab.actor_gateway_key();
  delete from tab.ingest_challenge where issued_at < clock_timestamp() - interval '1 day';
  insert into tab.ingest_challenge (gateway_key_id, session_id)
  values (v_key.id, (v_actor ->> 'session_id')::uuid)
  returning id, issued_at into v_id, v_at;
  return jsonb_build_object('challengeId', v_id, 'issuedUs', platform.epoch_micros(v_at)::text);
end
$$;

-- True when p_signature (the canonical standard base64 of 64 bytes, as for a reading's signature in 0270) is the
-- Ed25519 signature, under the gateway key p_spki (base64 SPKI DER of an Ed25519 key), of the text the SDK's
-- uploadWaitMessage builds: "ebmr.upload-wait.v1|<challenge>|<reading id>|<wait>".
create function tab.upload_wait_signature_valid(p_spki text, p_challenge uuid, p_reading_id uuid, p_delay_us bigint, p_signature text)
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
  return tab.ed25519_verify(substring(v_spki from 13 for 32),
    convert_to('ebmr.upload-wait.v1|' || p_challenge::text || '|' || p_reading_id::text || '|' || p_delay_us::text, 'UTF8'),
    decode(p_signature, 'base64'));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Ingestion as in 0320, except that a known wait must carry the gateway's signature over a challenge the database
-- issued, and the stored wait is the signed wait plus the database time since that challenge.
-- ---------------------------------------------------------------------------------------------

drop function tab.ingest_reading(jsonb, bigint);

create function tab.ingest_reading(p_reading jsonb, p_delay_us bigint, p_challenge uuid, p_wait_signature text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor     jsonb := iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key       tab.gateway_key%rowtype;
  v_bind      tab.gateway_instrument%rowtype;
  v_dev       iam.device%rowtype;
  v_existing  tab.device_reading%rowtype;
  v_challenge tab.ingest_challenge%rowtype;
  v_id        uuid;
  v_seq       bigint;
  v_head      jsonb;
  v_hash      text;
  v_since     bigint;
  v_recorded_us bigint;
begin
  perform iam.assert_not_administrator();
  v_key := tab.actor_gateway_key();
  begin
    v_id := (p_reading ->> 'readingId')::uuid;
    v_seq := (p_reading ->> 'seq')::bigint;
  exception when others then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-040 DI-31: the reading id or sequence number is malformed';
  end;
  if v_id is null or v_seq is null or v_seq < 1 then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-040 DI-31: the reading id or sequence number is missing';
  end if;
  if p_reading ->> 'format' is distinct from 'ebmr.scale-reading.v1' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-040 DI-31: unknown reading format';
  end if;
  if p_delay_us < 0 then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-051 DI-28: the time a reading waited before it was received cannot be negative (%s microseconds)', p_delay_us);
  end if;
  -- DI-28: no gateway measures a wait of more than 100 years; such a value is not a wait (and would overflow below).
  if p_delay_us > 3155760000000000 then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-052 DI-28: a reported wait of %s microseconds is longer than 100 years, so it is not a measured wait', p_delay_us);
  end if;
  -- DI-28 (P53): a known wait is the gateway's, signed over a challenge this database issued to the reading's
  -- enrolment; the time since that challenge is counted below. An unknown wait needs no proof (never claimable).
  if p_delay_us is not null then
    if p_challenge is null or p_wait_signature is null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-053 DI-28: the wait of reading %s comes without the gateway''s signature over a challenge from the database, so it is not proven', v_id);
    end if;
    select * into v_challenge from tab.ingest_challenge where id = p_challenge;
    if not found or v_challenge.gateway_key_id <> v_key.id then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-054 DI-28: challenge %s was not issued to the enrolment of gateway %s (unknown, expired, or another enrolment''s); send the reading again with a new challenge',
                         p_challenge, v_key.gateway_code);
    end if;
    if not coalesce(tab.upload_wait_signature_valid(v_key.public_key_spki, p_challenge, v_id, p_delay_us, p_wait_signature), false) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-055 DI-28: the signature over the wait of reading %s (%s microseconds, challenge %s) does not verify with the enrolled gateway key',
                         v_id, p_delay_us, p_challenge);
    end if;
  end if;

  -- Serialise ingestion per chain; the head is read under this lock.
  perform 1 from tab.gateway_key where id = v_key.id for update;

  -- Idempotent by reading id: the same reading again is a duplicate; different content under the same id is refused.
  select * into v_existing from tab.device_reading where id = v_id;
  if found then
    if v_existing.hash = p_reading ->> 'hash' and v_existing.chain_id = v_key.id then
      return jsonb_build_object('outcome', 'DUPLICATE', 'readingId', v_id, 'seq', v_existing.seq::text, 'head', tab.chain_head(v_key.id));
    end if;
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-041 DI-31: reading %s was already received with different content', v_id);
  end if;

  -- PR-20, DI-30 (P51): while a refusal holds the gateway's scales OFFLINE, this reading ends the hold and turns them
  -- ONLINE; serialised with hand-keyed weighings of their rooms (0310).
  if tab.chain_refusal_pending(v_key.id) then
    perform tab.lock_gateway_rooms(v_key.id);
  end if;

  if (p_reading ->> 'chainId') is distinct from v_key.id::text or (p_reading ->> 'gatewayCode') is distinct from v_key.gateway_code then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-042 DI-31: the reading belongs to chain %s of %s, not to this gateway''s enrolment', p_reading ->> 'chainId', p_reading ->> 'gatewayCode');
  end if;
  if (p_reading ->> 'installation') is distinct from kernel.installation_kind() then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-043 DI-20: a %s reading cannot enter a %s installation', p_reading ->> 'installation', kernel.installation_kind());
  end if;

  v_head := tab.chain_head(v_key.id);
  if v_seq <> (v_head ->> 'seq')::bigint + 1 or (p_reading ->> 'prevHash') is distinct from (v_head ->> 'hash') then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-044 DI-31: sequence break: the server holds up to %s, the reading is %s', v_head ->> 'seq', v_seq);
  end if;
  v_hash := encode(sha256(convert_to(tab.reading_canonical_text(p_reading), 'UTF8')), 'hex');
  if v_hash is distinct from p_reading ->> 'hash' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-045 DI-31: the reading hash does not match its content';
  end if;

  select * into v_bind from tab.gateway_instrument
   where gateway_key_id = v_key.id and device_code = p_reading ->> 'deviceCode' and ended_at is null;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-046 DI-20: %s is not an instrument of gateway %s', p_reading ->> 'deviceCode', v_key.gateway_code);
  end if;
  select * into v_dev from iam.device where id = v_bind.instrument_device_id;
  if v_dev.status <> 'ACTIVE' or v_dev.device_class <> 'INSTRUMENT' then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-047 DI-20: instrument %s is %s', v_dev.code, v_dev.status);
  end if;
  if (p_reading ->> 'serial') is distinct from v_bind.expected_serial then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-048 DI-20: serial %s is not the registered serial of %s', p_reading ->> 'serial', v_dev.code);
  end if;
  if (p_reading ->> 'unit') is not null and (p_reading ->> 'unit') <> v_bind.unit then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-049 DI-31: unit %s is not the configured unit %s of %s', p_reading ->> 'unit', v_bind.unit, v_dev.code);
  end if;
  if (p_reading ->> 'value') is not null
     and (not tab.is_decimal_text(p_reading ->> 'value') or mod((p_reading ->> 'value')::numeric, v_bind.resolution::numeric) <> 0) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-050 DI-31: value %s is not a multiple of the resolution %s', p_reading ->> 'value', v_bind.resolution);
  end if;

  -- DI-28 (P53): the database time from the challenge's issue to this insert: everything after the gateway signed
  -- its wait (the way to the server, queues, the pool, this transaction and the chain lock, and any hold-back).
  if p_delay_us is not null then
    v_since := greatest(platform.epoch_micros(clock_timestamp()) - platform.epoch_micros(v_challenge.issued_at), 0);
  end if;
  insert into tab.device_reading (id, chain_id, seq, gateway_device_id, gateway_code, instrument_device_id, device_code, serial, value, unit,
                                  stable, status, raw, source_time_us, trust, installation, purpose, prev_hash, hash, signature,
                                  uplink_delay_us, ingest_session_id, correlation_id)
  values (v_id, v_key.id, v_seq, v_key.gateway_device_id, v_key.gateway_code, v_dev.id, v_dev.code, p_reading ->> 'serial',
          p_reading ->> 'value', p_reading ->> 'unit', (p_reading ->> 'stable')::boolean, p_reading ->> 'status', p_reading ->> 'raw',
          (p_reading ->> 'sourceTimeUs')::bigint, p_reading ->> 'trust', p_reading ->> 'installation', p_reading ->> 'purpose',
          p_reading ->> 'prevHash', v_hash, p_reading ->> 'signature', p_delay_us + v_since,
          (v_actor ->> 'session_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning recorded_us into v_recorded_us;
  perform kernel.audit_business_event('device_reading:' || v_id,
    format('Scale reading %s from %s via gateway %s: %s (%s), raw "%s"', v_seq, v_dev.code, v_key.gateway_code,
           coalesce((p_reading ->> 'value') || ' ' || (p_reading ->> 'unit'), 'no value'), p_reading ->> 'status', p_reading ->> 'raw'),
    jsonb_build_object('chain_id', v_key.id, 'seq', v_seq, 'hash', v_hash, 'purpose', p_reading ->> 'purpose',
                       'gateway_wait_us', p_delay_us, 'wait_challenge_id', case when p_delay_us is null then null else p_challenge end,
                       'wait_since_challenge_us', v_since));
  return jsonb_build_object('outcome', 'INGESTED', 'readingId', v_id, 'seq', v_seq::text, 'head', tab.chain_head(v_key.id),
                            'recordedUs', v_recorded_us::text);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on function tab.issue_ingest_challenge(), tab.upload_wait_signature_valid(text, uuid, uuid, bigint, text),
  tab.ingest_reading(jsonb, bigint, uuid, text) from public;
grant execute on function tab.issue_ingest_challenge(), tab.ingest_reading(jsonb, bigint, uuid, text) to ebmr_app;

reset role;
