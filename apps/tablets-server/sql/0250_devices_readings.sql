-- Tablets server, module C5 (Phase 2 apps plan section 10): scale readings from the site gateway.
-- Controls DI-20 (device and location checks), DI-28 (buffered capture: no gap, no duplicate), DI-31 (interface
-- integrity: signed, hash-chained, sequence-checked, alarmed refusals) and DI-32 (the raw instrument line is kept
-- with the value; a reading is claimed once, by id, by the committing entry).
--
--   tab.gateway_key         enrolled gateway keys (Ed25519 SPKI whose SHA-256 is the SERVER device fingerprint);
--                           the enrolment id is the chain id of the gateway's readings on this installation
--   tab.gateway_instrument  instruments a gateway serves, with the expected serial (I4), unit and resolution
--   tab.gateway_session     opaque bearer tokens of gateway sessions (never usable as a browser cookie)
--   tab.device_reading      insert-only, audited readings; per-chain sequence and hash chain (hash recomputed here)
--   tab.reading_use         insert-only, audited: a reading is used at most once (unique reading id)
--   tab.instrument_heartbeat  operational status for the step screen (not GMP data; not audited)
--   tab.device_alarm        insert-only log of refused transfers, serial mismatches and refused claims
--
-- Privileges: the application role may only EXECUTE the SECURITY DEFINER functions (which list pg_temp last)
-- and SELECT the reading tables; it can never insert, update or delete a row here directly.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Helpers

-- JSON text of a string or null, exactly as JavaScript JSON.stringify writes it for printable ASCII.
create function tab.json_text(p text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(to_json(p)::text, 'null')
$$;

create function tab.is_decimal_text(p text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
$$;

-- The canonical text of a reading (integration-sdk scale/reading.ts canonicalReadingText): a JSON array of the
-- fields in a fixed order, no spaces. The server recomputes the hash here, independent of the TypeScript code.
create function tab.reading_canonical_text(p jsonb) returns text
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select '[' || concat_ws(',',
    tab.json_text(p ->> 'format'),
    tab.json_text(p ->> 'readingId'),
    tab.json_text(p ->> 'chainId'),
    tab.json_text(p ->> 'gatewayCode'),
    tab.json_text(p ->> 'deviceCode'),
    tab.json_text(p ->> 'serial'),
    tab.json_text(p ->> 'seq'),
    tab.json_text(p ->> 'value'),
    tab.json_text(p ->> 'unit'),
    case jsonb_typeof(p -> 'stable') when 'boolean' then (p ->> 'stable') else 'invalid' end,
    tab.json_text(p ->> 'status'),
    tab.json_text(p ->> 'raw'),
    tab.json_text(p ->> 'sourceTimeUs'),
    tab.json_text(p ->> 'trust'),
    tab.json_text(p ->> 'installation'),
    tab.json_text(p ->> 'purpose'),
    tab.json_text(p ->> 'prevHash')) || ']'
$$;

create function tab.reading_genesis_hash(p_chain uuid) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to('ebmr.scale-reading.v1.genesis|' || p_chain::text, 'UTF8')), 'hex')
$$;

-- An UPDATE of an audited row carries a non-blank reason code and reason text in the actor context. Functions that
-- take the reason as arguments install it for the change and restore the saved context afterwards
-- (kernel.set_actor_context; never set_config).
create function tab.with_reason_context(p_code text, p_text text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, kernel, pg_temp as $$
declare
  v_saved jsonb := iam.assert_validated_actor();
begin
  if coalesce(btrim(p_code), '') = '' or coalesce(btrim(p_text), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-009 a reason code and a reason text are required for this change';
  end if;
  perform kernel.set_actor_context(v_saved || jsonb_build_object('reason_code', p_code, 'reason_text', p_text));
  return v_saved;
end
$$;
revoke all on function tab.with_reason_context(text, text) from public;

-- ---------------------------------------------------------------------------------------------
-- Gateway enrolment (configuration; IAM.DEVICE_MANAGE)

create table tab.gateway_key (
  id                  uuid primary key default gen_random_uuid(),
  gateway_device_id   uuid not null references iam.device (id),
  gateway_code        text not null,
  account_id          uuid not null references iam.account (id),
  public_key_spki     text not null check (public_key_spki ~ '^[A-Za-z0-9+/]+={0,2}$'),
  key_fingerprint     text not null check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  status              text not null default 'ACTIVE' check (status in ('ACTIVE', 'REVOKED')),
  enrolled_by_person  uuid not null,
  enrolled_at         timestamptz not null default clock_timestamp(),
  revoked_at          timestamptz,
  revoked_reason      text,
  check ((status = 'REVOKED') = (revoked_at is not null))
);
create unique index gateway_key_one_active on tab.gateway_key (gateway_device_id) where status = 'ACTIVE';

create function tab.gateway_key_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'ACTIVE' then
      raise exception using errcode = 'P0001', message = 'EBMR-DEV-001 a gateway key is enrolled ACTIVE';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.gateway_device_id <> old.gateway_device_id or new.gateway_code <> old.gateway_code
     or new.account_id <> old.account_id or new.public_key_spki <> old.public_key_spki or new.key_fingerprint <> old.key_fingerprint
     or new.enrolled_by_person <> old.enrolled_by_person or new.enrolled_at <> old.enrolled_at then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-002 an enrolled gateway key never changes; revoke it and enrol a new one';
  end if;
  if old.status = 'REVOKED' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-003 a revoked gateway key stays revoked';
  end if;
  return new;
end
$$;
create trigger aa_gateway_key_guard before insert or update on tab.gateway_key for each row execute function tab.gateway_key_guard();
create trigger aa_gateway_key_no_delete before delete or truncate on tab.gateway_key for each statement execute function kernel.reject_mutation();
select kernel.register_audited_table('tab.gateway_key', 'gateway_key', 'id', false);

create table tab.gateway_instrument (
  id                    uuid primary key default gen_random_uuid(),
  gateway_key_id        uuid not null references tab.gateway_key (id),
  instrument_device_id  uuid not null references iam.device (id),
  device_code           text not null,
  expected_serial       text not null check (expected_serial ~ '^[!#-~]{1,32}$'),
  unit                  text not null check (unit ~ '^[A-Za-z]{1,5}$'),
  resolution            text not null check (tab.is_decimal_text(resolution) and resolution::numeric > 0),
  bound_by_person       uuid not null,
  bound_at              timestamptz not null default clock_timestamp(),
  ended_at              timestamptz,
  ended_reason          text
);
create unique index gateway_instrument_one_active on tab.gateway_instrument (instrument_device_id) where ended_at is null;

create function tab.gateway_instrument_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.ended_at is not null then
      raise exception using errcode = 'P0001', message = 'EBMR-DEV-004 an instrument binding starts active';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.gateway_key_id <> old.gateway_key_id or new.instrument_device_id <> old.instrument_device_id
     or new.device_code <> old.device_code or new.expected_serial <> old.expected_serial or new.unit <> old.unit
     or new.resolution <> old.resolution or new.bound_by_person <> old.bound_by_person or new.bound_at <> old.bound_at
     or old.ended_at is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-005 an instrument binding never changes; end it and bind again';
  end if;
  return new;
end
$$;
create trigger aa_gateway_instrument_guard before insert or update on tab.gateway_instrument for each row execute function tab.gateway_instrument_guard();
create trigger aa_gateway_instrument_no_delete before delete or truncate on tab.gateway_instrument for each statement execute function kernel.reject_mutation();
select kernel.register_audited_table('tab.gateway_instrument', 'gateway_key', 'gateway_key_id', false);

-- Enrols the Ed25519 key of a gateway: the SERVER device's registered fingerprint must be SHA-256 of this SPKI,
-- and only the named INTEGRATION account may log in with it. Returns the enrolment (= chain) id.
create function tab.enrol_gateway_key(p_gateway_code text, p_spki text, p_login_name text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  v_dev   iam.device%rowtype;
  v_acc   iam.account%rowtype;
  v_fp    text;
  v_id    uuid;
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

create function tab.revoke_gateway_key(p_id uuid, p_reason_code text, p_reason_text text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_saved jsonb;
begin
  perform iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  v_saved := tab.with_reason_context(p_reason_code, p_reason_text);
  update tab.gateway_key set status = 'REVOKED', revoked_at = clock_timestamp(), revoked_reason = p_reason_text
   where id = p_id and status = 'ACTIVE';
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-013 no active gateway key with this id';
  end if;
  -- The key's instrument bindings end with it (an instrument is bound again under a new enrolment).
  update tab.gateway_instrument set ended_at = clock_timestamp(), ended_reason = 'gateway key revoked: ' || p_reason_text
   where gateway_key_id = p_id and ended_at is null;
  update tab.gateway_session set unbound_at = clock_timestamp() where gateway_key_id = p_id and unbound_at is null;
  perform kernel.set_actor_context(v_saved);
end
$$;

-- Binds an INSTRUMENT (balance) to a gateway enrolment with the serial the gateway must read with I4.
create function tab.bind_instrument(p_gateway_key uuid, p_instrument_code text, p_serial text, p_unit text, p_resolution text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  v_dev   iam.device%rowtype;
  v_id    uuid;
begin
  if not exists (select 1 from tab.gateway_key where id = p_gateway_key and status = 'ACTIVE') then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-013 no active gateway key with this id';
  end if;
  select * into v_dev from iam.device where code = p_instrument_code;
  if not found or v_dev.device_class <> 'INSTRUMENT' or v_dev.status <> 'ACTIVE' then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-014 %s is not an active INSTRUMENT in the registry', p_instrument_code);
  end if;
  insert into tab.gateway_instrument (gateway_key_id, instrument_device_id, device_code, expected_serial, unit, resolution, bound_by_person)
  values (p_gateway_key, v_dev.id, v_dev.code, p_serial, p_unit, p_resolution, (v_actor ->> 'person_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function tab.end_instrument_binding(p_binding uuid, p_reason_code text, p_reason_text text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_saved jsonb;
begin
  perform iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  v_saved := tab.with_reason_context(p_reason_code, p_reason_text);
  update tab.gateway_instrument set ended_at = clock_timestamp(), ended_reason = p_reason_text where id = p_binding and ended_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-015 no active instrument binding with this id';
  end if;
  perform kernel.set_actor_context(v_saved);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Readings

create table tab.device_reading (
  id                    uuid primary key,
  chain_id              uuid not null references tab.gateway_key (id),
  seq                   bigint not null check (seq >= 1),
  gateway_device_id     uuid not null references iam.device (id),
  gateway_code          text not null,
  instrument_device_id  uuid not null references iam.device (id),
  device_code           text not null,
  serial                text not null,
  value                 text check (value is null or tab.is_decimal_text(value)),
  unit                  text check (unit is null or unit ~ '^[A-Za-z]{1,5}$'),
  stable                boolean not null,
  status                text not null check (status in ('OK', 'UNSTABLE', 'OVERLOAD', 'UNDERLOAD', 'OFFLINE', 'ERROR')),
  raw                   text not null check (raw ~ '^[ -~]{1,128}$'),
  source_time_us        bigint not null,
  trust                 text not null check (trust in ('DEVICE_SYNCED', 'DEVICE_UNSYNCED')),
  installation          text not null check (installation in ('GMP', 'SANDBOX')),
  purpose               text check (purpose in ('TARE', 'GROSS', 'CHECK')),
  prev_hash             text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash                  text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  signature             text not null,
  -- How long the reading waited at the gateway before its upload (null: unknown, sent after a gateway restart).
  uplink_delay_us       bigint check (uplink_delay_us is null or uplink_delay_us >= 0),
  recorded_at           timestamptz not null default clock_timestamp(),
  recorded_us           bigint not null,
  ingest_session_id     uuid not null,
  correlation_id        uuid not null,
  unique (chain_id, seq),
  check ((status = 'OK') = stable),
  check (status <> 'OK' or (value is not null and unit is not null))
);
select kernel.register_audited_table('tab.device_reading', 'device_reading', 'id', true);

create table tab.reading_use (
  reading_id      uuid primary key references tab.device_reading (id),
  purpose         text not null check (btrim(purpose) <> ''),
  room_code       text not null,
  person_id       uuid not null,
  account_id      uuid not null,
  session_id      uuid not null,
  correlation_id  uuid not null,
  claimed_at      timestamptz not null default clock_timestamp()
);
select kernel.register_audited_table('tab.reading_use', 'device_reading', 'reading_id', true);

create table tab.instrument_heartbeat (
  instrument_device_id  uuid primary key references iam.device (id),
  gateway_key_id        uuid not null references tab.gateway_key (id),
  state                 text not null check (state in ('CONNECTING', 'ONLINE', 'OFFLINE', 'SERIAL_MISMATCH')),
  serial                text,
  reported_at           timestamptz not null
);

create table tab.device_alarm (
  id                    bigint generated always as identity primary key,
  raised_at             timestamptz not null default clock_timestamp(),
  kind                  text not null check (kind in ('READING_REFUSED', 'SERIAL_MISMATCH', 'CLAIM_REFUSED', 'GATEWAY_LOGIN_REFUSED',
                                                      'UNKNOWN_INSTRUMENT', 'GATEWAY_ALARM')),
  code                  text not null,
  gateway_code          text,
  device_code           text,
  reading_id            text,
  session_id            uuid,
  message               text not null,
  details               jsonb not null default '{}'::jsonb
);
create trigger aa_device_alarm_insert_only before update or delete on tab.device_alarm for each row execute function kernel.reject_mutation();
create trigger aa_device_alarm_no_truncate before truncate on tab.device_alarm for each statement execute function kernel.reject_mutation();

create table tab.gateway_session (
  token_hash      text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  session_id      uuid not null unique references iam.session (id),
  gateway_key_id  uuid not null references tab.gateway_key (id),
  bound_at        timestamptz not null default clock_timestamp(),
  unbound_at      timestamptz
);

-- The head of a chain: the last reading, or the genesis link.
create function tab.chain_head(p_chain uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce(
    (select jsonb_build_object('seq', r.seq::text, 'hash', r.hash) from tab.device_reading r where r.chain_id = p_chain order by r.seq desc limit 1),
    jsonb_build_object('seq', '0', 'hash', tab.reading_genesis_hash(p_chain)))
$$;

create function tab.raise_device_alarm(p_kind text, p_code text, p_gateway text, p_device text, p_reading text, p_session uuid, p_message text,
                                       p_details jsonb) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_id bigint;
begin
  insert into tab.device_alarm (kind, code, gateway_code, device_code, reading_id, session_id, message, details)
  values (p_kind, p_code, p_gateway, p_device, p_reading, p_session, p_message, coalesce(p_details, '{}'::jsonb))
  returning id into v_id;
  perform pg_notify('ebmr_device_alarm', jsonb_build_object('alarm_id', v_id, 'kind', p_kind, 'code', p_code, 'gateway', p_gateway,
                                                            'device', p_device)::text);
  return v_id;
end
$$;
revoke all on function tab.raise_device_alarm(text, text, text, text, text, uuid, text, jsonb) from public;

-- ---------------------------------------------------------------------------------------------
-- Gateway sessions (the listener). The gateway authenticated with SERVICE_KEY on its SERVER device (kernel) and
-- proved possession of the enrolled Ed25519 key (listener); this binds the session to an opaque bearer token.

create function tab.bind_gateway_session(p_session uuid, p_token_hash text, p_spki text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_s    iam.session%rowtype;
  v_acc  iam.account%rowtype;
  v_key  tab.gateway_key%rowtype;
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

-- The session behind a bearer token; null when unknown, unbound, or its key was revoked.
create function tab.resolve_gateway_session(p_token_hash text) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
  select jsonb_build_object(
           'session_id', s.id, 'person_id', s.person_id, 'account_id', s.account_id, 'device_id', s.device_id,
           'legal_name', p.legal_name, 'login_name', a.login_name, 'state', iam.session_state(s.id),
           'chain_id', k.id, 'gateway_code', k.gateway_code, 'public_key_spki', k.public_key_spki,
           'roles', coalesce((select jsonb_agg(distinct g.role_code order by g.role_code) from iam.role_grant g
                               where g.account_id = s.account_id and g.status = 'APPROVED' and g.revoked_at is null
                                 and g.valid_from <= clock_timestamp() and (g.valid_to is null or g.valid_to > clock_timestamp())), '[]'::jsonb))
    from tab.gateway_session b
    join iam.session s on s.id = b.session_id
    join tab.gateway_key k on k.id = b.gateway_key_id and k.status = 'ACTIVE'
    join iam.person p on p.id = s.person_id
    join iam.account a on a.id = s.account_id
   where b.token_hash = p_token_hash and b.unbound_at is null
$$;

create function tab.unbind_gateway_session(p_token_hash text) returns uuid
language sql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
  update tab.gateway_session set unbound_at = clock_timestamp()
   where token_hash = p_token_hash and unbound_at is null
  returning session_id
$$;

-- The enrolment behind the validated actor's gateway session (inside an INTEGRATION command).
create function tab.actor_gateway_key() returns tab.gateway_key
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_key   tab.gateway_key%rowtype;
begin
  if v_actor ->> 'source' <> 'INTEGRATION' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-030 DI-31: readings and heartbeats come only from an INTEGRATION identity';
  end if;
  select k.* into v_key from tab.gateway_session b join tab.gateway_key k on k.id = b.gateway_key_id
   where b.session_id = (v_actor ->> 'session_id')::uuid and b.unbound_at is null and k.status = 'ACTIVE';
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-031 the session is not a bound gateway session with an active key';
  end if;
  return v_key;
end
$$;
revoke all on function tab.actor_gateway_key() from public;

-- ---------------------------------------------------------------------------------------------
-- Ingestion (INTEGRATION command, INTERFACE.WRITE). The listener has verified the Ed25519 signature against
-- the enrolled key and that the raw line states exactly the value, unit and stability; here the database checks
-- the chain, the sequence, the instrument binding and serial, the installation kind, and recomputes the hash.

create function tab.ingest_reading(p_reading jsonb, p_delay_us bigint) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor    jsonb := iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key      tab.gateway_key%rowtype;
  v_bind     tab.gateway_instrument%rowtype;
  v_dev      iam.device%rowtype;
  v_existing tab.device_reading%rowtype;
  v_id       uuid;
  v_seq      bigint;
  v_head     jsonb;
  v_hash     text;
  v_now      timestamptz := clock_timestamp();
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

  insert into tab.device_reading (id, chain_id, seq, gateway_device_id, gateway_code, instrument_device_id, device_code, serial, value, unit,
                                  stable, status, raw, source_time_us, trust, installation, purpose, prev_hash, hash, signature,
                                  uplink_delay_us, recorded_at, recorded_us, ingest_session_id, correlation_id)
  values (v_id, v_key.id, v_seq, v_key.gateway_device_id, v_key.gateway_code, v_dev.id, v_dev.code, p_reading ->> 'serial',
          p_reading ->> 'value', p_reading ->> 'unit', (p_reading ->> 'stable')::boolean, p_reading ->> 'status', p_reading ->> 'raw',
          (p_reading ->> 'sourceTimeUs')::bigint, p_reading ->> 'trust', p_reading ->> 'installation', p_reading ->> 'purpose',
          p_reading ->> 'prevHash', v_hash, p_reading ->> 'signature', p_delay_us, v_now, platform.epoch_micros(v_now),
          (v_actor ->> 'session_id')::uuid, (v_actor ->> 'correlation_id')::uuid);
  perform kernel.audit_business_event('device_reading:' || v_id,
    format('Scale reading %s from %s via gateway %s: %s (%s), raw "%s"', v_seq, v_dev.code, v_key.gateway_code,
           coalesce((p_reading ->> 'value') || ' ' || (p_reading ->> 'unit'), 'no value'), p_reading ->> 'status', p_reading ->> 'raw'),
    jsonb_build_object('chain_id', v_key.id, 'seq', v_seq, 'hash', v_hash, 'purpose', p_reading ->> 'purpose'));
  return jsonb_build_object('outcome', 'INGESTED', 'readingId', v_id, 'seq', v_seq::text, 'head', tab.chain_head(v_key.id),
                            'recordedUs', platform.epoch_micros(v_now)::text);
end
$$;

-- Heartbeat (INTEGRATION command, INTERFACE.WRITE): the instruments' connection states. A serial that is not the
-- registered one counts as SERIAL_MISMATCH whatever the gateway says, and raises an alert once per occurrence.
create function tab.record_heartbeat(p_heartbeat jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('INTERFACE.WRITE', '{}'::jsonb);
  v_key   tab.gateway_key%rowtype;
  v_bind  tab.gateway_instrument%rowtype;
  v_prev  text;
  v_state text;
  d       jsonb;
begin
  perform iam.assert_not_administrator();
  v_key := tab.actor_gateway_key();
  for d in select * from jsonb_array_elements(coalesce(p_heartbeat -> 'devices', '[]'::jsonb)) loop
    select * into v_bind from tab.gateway_instrument where gateway_key_id = v_key.id and device_code = d ->> 'deviceCode' and ended_at is null;
    if not found then
      perform tab.raise_device_alarm('UNKNOWN_INSTRUMENT', 'EBMR-DEV-046', v_key.gateway_code, d ->> 'deviceCode', null,
                                     (v_actor ->> 'session_id')::uuid, 'The gateway reports an instrument that is not bound to it', d);
      continue;
    end if;
    v_state := d ->> 'state';
    if v_state not in ('CONNECTING', 'ONLINE', 'OFFLINE', 'SERIAL_MISMATCH') then
      v_state := 'OFFLINE';
    end if;
    if v_state = 'ONLINE' and (d ->> 'serial') is distinct from v_bind.expected_serial then
      v_state := 'SERIAL_MISMATCH';
    end if;
    select state into v_prev from tab.instrument_heartbeat where instrument_device_id = v_bind.instrument_device_id;
    if v_state = 'SERIAL_MISMATCH' and v_prev is distinct from 'SERIAL_MISMATCH' then
      perform tab.raise_device_alarm('SERIAL_MISMATCH', 'EBMR-DEV-048', v_key.gateway_code, v_bind.device_code, null,
        (v_actor ->> 'session_id')::uuid,
        format('DI-20: %s answers with serial %s, not the registered %s; it is refused until the registry or the instrument is corrected',
               v_bind.device_code, coalesce(d ->> 'serial', '(none)'), v_bind.expected_serial), d);
      perform iam.raise_alert('UNREGISTERED_DEVICE', 'HIGH', null, null, v_bind.instrument_device_id, null, (v_actor ->> 'session_id')::uuid,
        jsonb_build_object('reason', 'SERIAL_MISMATCH', 'device_code', v_bind.device_code, 'expected_serial', v_bind.expected_serial,
                           'reported_serial', d ->> 'serial', 'gateway', v_key.gateway_code));
    end if;
    insert into tab.instrument_heartbeat (instrument_device_id, gateway_key_id, state, serial, reported_at)
    values (v_bind.instrument_device_id, v_key.id, v_state, d ->> 'serial', clock_timestamp())
    on conflict (instrument_device_id) do update
      set gateway_key_id = excluded.gateway_key_id, state = excluded.state, serial = excluded.serial, reported_at = excluded.reported_at;
  end loop;
  return jsonb_build_object('serverTimeUs', platform.epoch_micros(clock_timestamp())::text, 'head', tab.chain_head(v_key.id));
end
$$;

-- Scales (instruments bound to an active gateway key) of a room, or of every room when p_room is null. ONLINE only
-- when the last heartbeat, at database time, is at most 10 s old, reported the instrument connected with its
-- registered serial, and the instrument is ACTIVE; UNKNOWN before the first heartbeat; OFFLINE otherwise.
create function tab.scale_status(p_room text) returns jsonb
language sql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
  select coalesce(jsonb_agg(x order by x ->> 'deviceCode'), '[]'::jsonb) from (
    select jsonb_build_object(
             'deviceCode', b.device_code,
             'roomCode', d.room_code,
             'status', case
                         when h.instrument_device_id is null then 'UNKNOWN'
                         when h.state = 'ONLINE' and h.serial = b.expected_serial and d.status = 'ACTIVE'
                              and clock_timestamp() - h.reported_at <= interval '10 seconds' then 'ONLINE'
                         else 'OFFLINE' end,
             'lastHeartbeatUs', case when h.reported_at is null then null else platform.epoch_micros(h.reported_at)::text end,
             'gatewayCode', k.gateway_code,
             'resolution', b.resolution,
             'unit', b.unit) as x
      from tab.gateway_instrument b
      join tab.gateway_key k on k.id = b.gateway_key_id and k.status = 'ACTIVE'
      join iam.device d on d.id = b.instrument_device_id
      left join tab.instrument_heartbeat h on h.instrument_device_id = b.instrument_device_id and h.gateway_key_id = k.id
     where b.ended_at is null and (p_room is null or d.room_code = p_room)) s
$$;

-- ---------------------------------------------------------------------------------------------
-- Claims (inside the committing entry's command; module C3 calls it through the DeviceReadingPort)
--
-- Each reading must exist; be stable with status OK and a value; come from an ACTIVE INSTRUMENT registered to the
-- kiosk's room (DI-20) and still bound to an active gateway key; belong to this installation kind; be at most
-- p_max_age_us old at database time, counting the time it waited at the gateway (unknown wait = too old); match
-- the purpose it was captured for (TARE, GROSS, CHECK); and not have been used. A use row is inserted in the
-- caller's transaction (unique reading id: two concurrent claims give exactly one success).

create function tab.claim_readings(p_ids uuid[], p_room text, p_max_age_us bigint, p_purpose text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor  jsonb := iam.assert_validated_actor();
  v_scope  jsonb;
  v_eval   jsonb;
  v_r      tab.device_reading%rowtype;
  v_loc    jsonb;
  v_now    bigint := platform.epoch_micros(clock_timestamp());
  v_age    bigint;
  v_out    jsonb := '[]'::jsonb;
  v_id     uuid;
begin
  perform iam.assert_not_administrator();
  if v_actor ->> 'source' not in ('UI', 'API') then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-100 DI-31: only a person''s entry can use a scale reading';
  end if;
  -- The person must be able to execute steps (or dispense) where they are.
  v_scope := iam.actor_location_scope();
  v_eval := iam.evaluate_authority((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, 'DISPENSE.EXECUTE', v_scope,
                                   clock_timestamp(), v_actor ->> 'role_code');
  if not (v_eval ->> 'allowed')::boolean then
    perform iam.require_permission('STEP.EXECUTE', v_scope);
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-101 no reading ids to claim';
  end if;
  if (select count(distinct x) from unnest(p_ids) x) <> cardinality(p_ids) or array_position(p_ids, null) is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-107 DI-32: a reading can be used only once, and each id only once per entry';
  end if;
  if p_room is null or btrim(p_room) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-103 DI-20: a scale reading can be used only on a terminal registered to a room';
  end if;
  if p_max_age_us is null or p_max_age_us <= 0 or p_max_age_us > 3600000000 then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-108 the maximum reading age must be between 1 microsecond and 1 hour';
  end if;
  if coalesce(btrim(p_purpose), '') = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-106 a claim names its purpose';
  end if;

  foreach v_id in array p_ids loop
    select * into v_r from tab.device_reading where id = v_id;
    if not found then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-101 DI-32: reading %s does not exist', v_id);
    end if;
    if v_r.status <> 'OK' or not v_r.stable or v_r.value is null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-102 DI-32: reading %s is %s, not a stable weight', v_id, v_r.status);
    end if;
    if v_r.installation <> kernel.installation_kind() then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-043 DI-20: reading %s is from a %s installation', v_id, v_r.installation);
    end if;
    v_loc := iam.check_device_location(v_r.instrument_device_id, p_room, null);
    if not (v_loc ->> 'accepted')::boolean then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-103 DI-20: reading %s comes from %s (%s), which is not an active instrument of room %s',
                         v_id, v_r.device_code, coalesce(v_loc ->> 'reason', 'refused'), p_room);
    end if;
    if not exists (select 1 from iam.device where id = v_r.instrument_device_id and device_class = 'INSTRUMENT') then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-103 DI-20: %s is not an instrument', v_r.device_code);
    end if;
    if not exists (select 1 from tab.gateway_key k join tab.gateway_instrument b on b.gateway_key_id = k.id
                    where k.id = v_r.chain_id and k.status = 'ACTIVE' and b.instrument_device_id = v_r.instrument_device_id
                      and b.ended_at is null) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-109 DI-31: reading %s came through a gateway key or instrument binding that is no longer active', v_id);
    end if;
    v_age := case when v_r.uplink_delay_us is null then null else v_now - v_r.recorded_us + v_r.uplink_delay_us end;
    if v_age is null or v_age > p_max_age_us then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-104 DI-28: reading %s is too old to use (older than %s s, or its capture time is not known); take a new reading',
                         v_id, round(p_max_age_us / 1000000.0, 1));
    end if;
    if p_purpose in ('TARE', 'GROSS', 'CHECK') and v_r.purpose is not null and v_r.purpose <> p_purpose then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-106 DI-32: reading %s was taken as %s and cannot be used as %s', v_id, v_r.purpose, p_purpose);
    end if;
    begin
      insert into tab.reading_use (reading_id, purpose, room_code, person_id, account_id, session_id, correlation_id)
      values (v_id, p_purpose, p_room, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid,
              (v_actor ->> 'correlation_id')::uuid);
    exception when unique_violation then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-105 DI-32: reading %s has already been used', v_id);
    end;
    perform kernel.audit_business_event('device_reading:' || v_id,
      format('Scale reading %s %s from %s used as %s in room %s', v_r.value, v_r.unit, v_r.device_code, p_purpose, p_room),
      jsonb_build_object('purpose', p_purpose, 'room', p_room));
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'readingId', v_id, 'value', v_r.value, 'unit', v_r.unit, 'raw', v_r.raw, 'deviceCode', v_r.device_code,
      'sourceTimeUs', v_r.source_time_us::text, 'trust', v_r.trust));
  end loop;
  return v_out;
end
$$;

-- After a claim was refused (the caller's transaction rolled back), records the DI-20 alert durably. The facts
-- are re-derived here from the readings and the room, so nothing the caller says is recorded as a fact.
create function tab.alert_claim_refusal(p_ids uuid[], p_room text, p_code text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  v_r   tab.device_reading%rowtype;
  v_dev iam.device%rowtype;
  n     integer := 0;
begin
  for v_r in select * from tab.device_reading where id = any(coalesce(p_ids, '{}')) loop
    select * into v_dev from iam.device where id = v_r.instrument_device_id;
    if v_dev.status <> 'ACTIVE' or p_room is null or v_dev.room_code is distinct from p_room then
      perform iam.raise_alert(case when v_dev.status <> 'ACTIVE' then 'BLOCKED_DEVICE_USE' else 'DEVICE_LOCATION_MISMATCH' end, 'HIGH',
        null, null, v_dev.id, null, null,
        jsonb_build_object('reading_id', v_r.id, 'registered_room', v_dev.room_code, 'requested_room', p_room, 'status', v_dev.status));
      perform tab.raise_device_alarm('CLAIM_REFUSED', coalesce(p_code, 'EBMR-DEV-103'), v_r.gateway_code, v_r.device_code, v_r.id::text, null,
        format('DI-20: reading of %s (room %s) refused for room %s', v_r.device_code, coalesce(v_dev.room_code, '-'), coalesce(p_room, '-')),
        jsonb_build_object('status', v_dev.status));
      n := n + 1;
    end if;
  end loop;
  return n;
end
$$;

-- A refused transfer (listener): recorded against the gateway of a live bearer token, or of a claimed gateway code
-- at login. Alarms are a log, never GMP data.
create function tab.record_gateway_refusal(p_token_hash text, p_gateway_code text, p_kind text, p_code text, p_reading_id text,
                                           p_message text, p_details jsonb) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_gw      text := null;
  v_session uuid := null;
begin
  if p_kind not in ('READING_REFUSED', 'GATEWAY_LOGIN_REFUSED', 'GATEWAY_ALARM') then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-060 unknown alarm kind';
  end if;
  if p_token_hash is not null then
    select k.gateway_code, b.session_id into v_gw, v_session from tab.gateway_session b join tab.gateway_key k on k.id = b.gateway_key_id
     where b.token_hash = p_token_hash;
  end if;
  return tab.raise_device_alarm(p_kind, left(coalesce(p_code, 'UNKNOWN'), 64),
    coalesce(v_gw, left(p_gateway_code, 64)), null, left(p_reading_id, 64), v_session, left(coalesce(p_message, ''), 2000),
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object('authenticated', v_gw is not null));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges

revoke all on function tab.enrol_gateway_key(text, text, text), tab.revoke_gateway_key(uuid, text, text),
  tab.bind_instrument(uuid, text, text, text, text), tab.end_instrument_binding(uuid, text, text),
  tab.bind_gateway_session(uuid, text, text), tab.resolve_gateway_session(text), tab.unbind_gateway_session(text),
  tab.ingest_reading(jsonb, bigint), tab.record_heartbeat(jsonb), tab.scale_status(text), tab.chain_head(uuid),
  tab.claim_readings(uuid[], text, bigint, text), tab.alert_claim_refusal(uuid[], text, text),
  tab.record_gateway_refusal(text, text, text, text, text, text, jsonb) from public;
grant execute on function tab.enrol_gateway_key(text, text, text), tab.revoke_gateway_key(uuid, text, text),
  tab.bind_instrument(uuid, text, text, text, text), tab.end_instrument_binding(uuid, text, text),
  tab.bind_gateway_session(uuid, text, text), tab.resolve_gateway_session(text), tab.unbind_gateway_session(text),
  tab.ingest_reading(jsonb, bigint), tab.record_heartbeat(jsonb), tab.scale_status(text), tab.chain_head(uuid),
  tab.claim_readings(uuid[], text, bigint, text), tab.alert_claim_refusal(uuid[], text, text),
  tab.record_gateway_refusal(text, text, text, text, text, text, jsonb) to ebmr_app;
revoke all on tab.gateway_key, tab.gateway_instrument, tab.device_reading, tab.reading_use, tab.instrument_heartbeat, tab.device_alarm,
  tab.gateway_session from public;
grant select on tab.gateway_key, tab.gateway_instrument, tab.device_reading, tab.reading_use, tab.instrument_heartbeat, tab.device_alarm to ebmr_app;

reset role;
