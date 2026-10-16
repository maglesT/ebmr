-- Kernel: installation keys, peer installations, seals, installation alarms and the site-to-site request log (Phase 6
-- slice 6i; outline L-41 "v1 topology"; controls DI-31, DI-13; defaults D-P6i-0-1 to D-P6i-0-10 in
-- docs/build-plan/phase-6/slice-6i-0-interfaces.md).
--
-- Handbook: modules/kernel.md
--
-- One installation per site per edition (L-41). Each installation holds an Ed25519 key pair: the server keeps the private
-- key (D-P6i-0-8), the database the public keys, and every seal is verified here, never only in Node.
--   platform.installation_identity   insert-only versions: this installation's code, site, edition and public key (raw 32
--                                    bytes) with its SHA-256 fingerprint; the latest version is current (a key rotation is
--                                    a new version); the code never changes. platform.set_installation_identity:
--                                    SYSTEM.CONFIGURE (EBMR-XFR-001 to -003).
--   platform.peer_installation       another installation this one trusts: proposed by SYSTEM.CONFIGURE (code, site,
--                                    edition, base URL, public key), trusted only once QA signed PEER_INSTALLATION_APPROVED
--                                    on peer_installation <id> (TRANSFER.PEER_APPROVE: QA reviewer, AP) and while not
--                                    revoked (EBMR-XFR-004 to -008). One trusted entry per code.
--   platform.seal_message(purpose, payload) bytea   what a seal signs: 'ebmr.<purpose>.v1|' and the SHA-256 hex of the
--                                    payload's UTF-8 text. Purposes transfer-package, federation-request, federation-answer:
--                                    a seal of one purpose never verifies as another.
--   platform.ed25519_verify          RFC 8032 verification in PL/pgSQL, the kernel twin of tablets 0270 (which the kernel
--                                    cannot call; PostgreSQL 16 has no Ed25519 in core). The code is that file's, renamed.
--   platform.own_seal_valid / peer_seal_valid   a seal is the canonical standard base64 of 64 bytes (one text per seal).
--   platform.installation_alarm      alarms of the transfer and federation paths (DI-31: a refused transfer is never
--                                    silent); acknowledged once under ALARM.ACKNOWLEDGE by a person.
--   platform.federation_request      every site-to-site request this installation answered or refused, with its nonce
--                                    (once per sender), the sender and the reason of a refusal (D-P6i-0-9).
--   platform.accept_federation_request(request, seal) jsonb (owner only; called by recipe.answer_federated_genealogy):
--                                    the request is JSON of format ebmr.federation-request.v1 from a trusted peer, sealed by
--                                    its key, addressed to this installation, issued within 300 seconds, its nonce unused.
--
-- Messages: EBMR-XFR-001 to EBMR-XFR-009, EBMR-FED-001 to EBMR-FED-009.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1220_installation_keys)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'installation keys, peer installations and their approval (L-41, DI-31)'));

insert into iam.permission (code, domain, effect, description) values
  ('TRANSFER.PEER_APPROVE', 'GMP', 'SIGN', 'Approve or revoke the trust in another site installation whose packages and answers this site accepts (L-41, DI-31)');
insert into iam.role_permission (role_code, permission_code) values
  ('QA_REVIEWER', 'TRANSFER.PEER_APPROVE'), ('AUTHORISED_PERSON', 'TRANSFER.PEER_APPROVE');

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values
  ('PEER_INSTALLATION_APPROVED', 1, 'VENDOR', true, 'ACTIVE', 'RELEASE', 'APPROVER', 'Peer installation approved',
   'Quality-unit decision: lot-transfer packages and genealogy answers sealed by this installation''s key may be taken in at this site.',
   array['TRANSFER.PEER_APPROVE'], '{}', false, false, false, 'ALL_COMPONENTS', false, 'L-41; DI-31; D-P6i-0-8');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table platform.installation_identity (
  version            integer primary key check (version >= 1),
  installation_code  text not null check (installation_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
  site_code          text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  edition            text not null check (edition in ('TABLETS', 'INJECTABLES')),
  public_key         bytea not null check (length(public_key) = 32),
  key_fingerprint    text not null check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  set_by_person      uuid not null,
  set_by_account     uuid not null,
  set_at             timestamptz not null default clock_timestamp()
);
revoke all on platform.installation_identity from public;
grant select on platform.installation_identity to ebmr_app;
select platform.enforce_db_time('platform.installation_identity', array['set_at']);
select kernel.register_audited_table('platform.installation_identity', 'installation_identity', 'installation_code', true);

create table platform.peer_installation (
  id                  uuid primary key default gen_random_uuid(),
  installation_code   text not null check (installation_code ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
  site_code           text not null check (site_code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  edition             text not null check (edition in ('TABLETS', 'INJECTABLES')),
  base_url            text not null check (base_url ~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[!-~]*)?$' and length(base_url) <= 200),
  public_key          bytea not null check (length(public_key) = 32),
  key_fingerprint     text not null check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  proposed_by_person  uuid not null,
  proposed_by_account uuid not null,
  proposed_at         timestamptz not null default clock_timestamp()
);
create index peer_installation_code on platform.peer_installation (installation_code);
revoke all on platform.peer_installation from public;

create table platform.peer_installation_approval (
  peer_id             uuid primary key references platform.peer_installation (id),
  signature_id        uuid not null unique,
  approved_by_person  uuid not null,
  approved_by_account uuid not null,
  approved_at         timestamptz not null default clock_timestamp()
);
revoke all on platform.peer_installation_approval from public;

create table platform.peer_installation_revocation (
  peer_id             uuid primary key references platform.peer_installation (id),
  reason              text not null check (length(btrim(reason)) >= 10),
  revoked_by_person   uuid not null,
  revoked_by_account  uuid not null,
  revoked_at          timestamptz not null default clock_timestamp()
);
revoke all on platform.peer_installation_revocation from public;

grant select on platform.peer_installation, platform.peer_installation_approval, platform.peer_installation_revocation to ebmr_app;
select platform.enforce_db_time('platform.peer_installation', array['proposed_at']);
select platform.enforce_db_time('platform.peer_installation_approval', array['approved_at']);
select platform.enforce_db_time('platform.peer_installation_revocation', array['revoked_at']);
select kernel.register_audited_table('platform.peer_installation', 'peer_installation', 'id', true);
select kernel.register_audited_table('platform.peer_installation_approval', 'peer_installation', 'peer_id', true);
select kernel.register_audited_table('platform.peer_installation_revocation', 'peer_installation', 'peer_id', true);

-- Alarms are raised also where no person acts (a request from another site), so the log is insert-only, not audited row
-- by row (as platform.integration_alarm, kernel 1180).
create table platform.installation_alarm (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('MALFORMED', 'UNKNOWN_PEER', 'TAMPERED', 'WRONG_DESTINATION', 'DUPLICATE', 'REPLAYED',
                                              'UNREACHABLE', 'WRONG_ANSWER')),
  severity      text not null check (severity in ('MINOR', 'MAJOR', 'CRITICAL')),
  path          text not null check (path in ('TRANSFER_IMPORT', 'FEDERATION_ANSWER', 'FEDERATION_QUERY')),
  peer_code     text,
  details       jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  raised_at     timestamptz not null default clock_timestamp()
);
create index installation_alarm_raised on platform.installation_alarm (raised_at);
revoke all on platform.installation_alarm from public;
grant select on platform.installation_alarm to ebmr_app;
select platform.make_insert_only('platform.installation_alarm');
select platform.enforce_db_time('platform.installation_alarm', array['raised_at']);

create table platform.installation_alarm_ack (
  alarm_id          uuid primary key references platform.installation_alarm (id),
  note              text not null check (btrim(note) <> '' and length(note) <= 1000),
  acknowledged_by   uuid not null,
  acknowledged_role text not null,
  acknowledged_at   timestamptz not null default clock_timestamp()
);
revoke all on platform.installation_alarm_ack from public;
grant select on platform.installation_alarm_ack to ebmr_app;
select platform.enforce_db_time('platform.installation_alarm_ack', array['acknowledged_at']);
select kernel.register_audited_table('platform.installation_alarm_ack', 'installation_alarm', 'alarm_id', true);

create table platform.federation_request (
  id              uuid primary key default gen_random_uuid(),
  requester_code  text,
  nonce           uuid,
  request_sha256  text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  query           jsonb,
  outcome         text not null check (outcome in ('ANSWERED', 'REFUSED')),
  reason          text,
  alarm_id        uuid references platform.installation_alarm (id),
  received_at     timestamptz not null default clock_timestamp(),
  check ((outcome = 'REFUSED') = (reason is not null and alarm_id is not null))
);
-- A nonce is answered once per sender; refused requests do not use it up (an attacker cannot block a nonce).
create unique index federation_request_nonce on platform.federation_request (requester_code, nonce) where outcome = 'ANSWERED';
create index federation_request_received on platform.federation_request (received_at);
revoke all on platform.federation_request from public;
grant select on platform.federation_request to ebmr_app;
select platform.make_insert_only('platform.federation_request');
select platform.enforce_db_time('platform.federation_request', array['received_at']);

-- ---------------------------------------------------------------------------------------------
-- ---------------------------------------------------------------------------------------------
-- Ed25519 verification (RFC 8032). Field elements and scalars are little-endian; the curve is
-- -x^2 + y^2 = 1 + d x^2 y^2 over GF(q), q = 2^255 - 19; points are extended coordinates {X, Y, Z, T} with
-- x = X/Z, y = Y/Z, x*y = T/Z. Only public data is handled, so timing does not matter.

-- The unsigned little-endian integer of a byte string.
create function platform.ed25519_le_integer(p bytea) returns numeric
language plpgsql immutable strict set search_path = pg_catalog, pg_temp as $$
declare
  v numeric := 0;
begin
  for i in reverse length(p) - 1 .. 0 loop
    v := v * 256 + get_byte(p, i);
  end loop;
  return v;
end
$$;

-- p_base ^ p_exp mod q (square and multiply; p_base >= 0, p_exp >= 0).
create function platform.ed25519_pow(p_base numeric, p_exp numeric) returns numeric
language plpgsql immutable strict set search_path = pg_catalog, pg_temp as $$
declare
  q constant numeric := 57896044618658097711785492504343953926634992332820282019728792003956564819949;
  r numeric := 1;
  b numeric := mod(p_base, q);
  e numeric := p_exp;
begin
  while e > 0 loop
    if mod(e, 2) = 1 then
      r := mod(r * b, q);
    end if;
    b := mod(b * b, q);
    e := div(e, 2);
  end loop;
  return r;
end
$$;

-- Point addition (RFC 8032 section 5.1.4; complete on this curve, so it also doubles and adds the neutral point).
create function platform.ed25519_add(p numeric[], r numeric[]) returns numeric[]
language plpgsql immutable strict set search_path = pg_catalog, pg_temp as $$
declare
  q  constant numeric := 57896044618658097711785492504343953926634992332820282019728792003956564819949;
  d2 constant numeric := 16295367250680780974490674513165176452449235426866156013048779062215315747161;
  a  numeric := mod((p[2] - p[1] + q) * (r[2] - r[1] + q), q);
  b  numeric := mod((p[2] + p[1]) * (r[2] + r[1]), q);
  c  numeric := mod(mod(p[4] * d2, q) * r[4], q);
  dd numeric := mod(2 * p[3] * r[3], q);
  e  numeric := b - a + q;
  f  numeric := dd - c + q;
  g  numeric := dd + c;
  h  numeric := b + a;
begin
  return array[mod(e * f, q), mod(g * h, q), mod(f * g, q), mod(e * h, q)];
end
$$;

-- Point doubling (RFC 8032 section 5.1.4).
create function platform.ed25519_double(p numeric[]) returns numeric[]
language plpgsql immutable strict set search_path = pg_catalog, pg_temp as $$
declare
  q constant numeric := 57896044618658097711785492504343953926634992332820282019728792003956564819949;
  a numeric := mod(p[1] * p[1], q);
  b numeric := mod(p[2] * p[2], q);
  c numeric := mod(2 * p[3] * p[3], q);
  h numeric := a + b;
  e numeric := mod(h - mod((p[1] + p[2]) * (p[1] + p[2]), q) + q, q);
  g numeric := mod(a - b + q, q);
  f numeric := c + g;
begin
  return array[mod(e * f, q), mod(g * h, q), mod(f * g, q), mod(e * h, q)];
end
$$;

-- Decodes a 32-byte point (RFC 8032 section 5.1.3); null when it is not the canonical encoding of a curve point.
create function platform.ed25519_decode(p bytea) returns numeric[]
language plpgsql immutable strict set search_path = pg_catalog, platform, pg_temp as $$
declare
  q      constant numeric := 57896044618658097711785492504343953926634992332820282019728792003956564819949;
  d      constant numeric := 37095705934669439343138083508754565189542113879843219016388785533085940283555;
  sqrtm1 constant numeric := 19681161376707505956807079304988542015446066515923890162744021073123829784752;
  v_sign integer;
  y      numeric;
  u      numeric;
  v      numeric;
  v3     numeric;
  x      numeric;
  vx2    numeric;
begin
  if length(p) <> 32 then
    return null;
  end if;
  v_sign := get_byte(p, 31) >> 7;
  y := platform.ed25519_le_integer(set_byte(p, 31, get_byte(p, 31) & 127));
  if y >= q then
    return null;
  end if;
  u := mod(y * y - 1 + q, q);
  v := mod(d * mod(y * y, q) + 1, q);
  v3 := mod(v * v * v, q);
  -- x = u v^3 (u v^7)^((q - 5) / 8)
  x := mod(u * v3 * platform.ed25519_pow(mod(u * v3 * v3 * v, q), 7237005577332262213973186563042994240829374041602535252466099000494570602493), q);
  vx2 := mod(v * x * x, q);
  if vx2 = u then
    null;
  elsif vx2 = mod(q - u, q) then
    x := mod(x * sqrtm1, q);
  else
    return null;
  end if;
  if x = 0 and v_sign = 1 then
    return null;
  end if;
  if mod(x, 2) <> v_sign then
    x := q - x;
  end if;
  return array[x, y, 1, mod(x * y, q)];
end
$$;

-- True when p_signature (64 bytes: R, S) is a valid Ed25519 signature of p_message under the 32-byte public key
-- p_key: S < L and the encoding of [S]B - [k]A, k = SHA-512(R || A || M) mod L, is R.
create function platform.ed25519_verify(p_key bytea, p_message bytea, p_signature bytea) returns boolean
language plpgsql immutable set search_path = pg_catalog, platform, pg_temp as $$
declare
  q      constant numeric := 57896044618658097711785492504343953926634992332820282019728792003956564819949;
  l      constant numeric := 7237005577332262213973186563042994240857116359379907606001950938285454250989;
  top    constant numeric := 57896044618658097711785492504343953926634992332820282019728792003956564819968;  -- 2^255
  v_base constant numeric[] := array[15112221349535400772501151409588531511454012693041857206046113283949847762202,
                                     46316835694926478169428394003475163141307993866256225615783033603165251855960, 1,
                                     46827403850823179245072216630277197565144205554125654976674165829533817101731];
  v_a    numeric[];
  v_nega numeric[];
  v_both numeric[];
  v_acc  numeric[] := array[0, 1, 1, 0];
  s      numeric;
  k      numeric;
  v_sb   integer[] := array[]::integer[];
  v_kb   integer[] := array[]::integer[];
  e      numeric;
  v_top  integer := 0;
  zi     numeric;
begin
  if p_key is null or p_message is null or p_signature is null or length(p_key) <> 32 or length(p_signature) <> 64 then
    return false;
  end if;
  s := platform.ed25519_le_integer(substring(p_signature from 33 for 32));
  if s >= l then
    return false;
  end if;
  v_a := platform.ed25519_decode(p_key);
  if v_a is null then
    return false;
  end if;
  k := mod(platform.ed25519_le_integer(sha512(substring(p_signature from 1 for 32) || p_key || p_message)), l);
  v_nega := array[mod(q - v_a[1], q), v_a[2], v_a[3], mod(q - v_a[4], q)];
  v_both := platform.ed25519_add(v_base, v_nega);
  -- Bits of S and k, least significant first; both are below L < 2^253.
  e := s;
  for i in 1 .. 253 loop
    v_sb[i] := mod(e, 2)::integer;
    e := div(e, 2);
  end loop;
  e := k;
  for i in 1 .. 253 loop
    v_kb[i] := mod(e, 2)::integer;
    e := div(e, 2);
    if v_sb[i] = 1 or v_kb[i] = 1 then
      v_top := i;
    end if;
  end loop;
  -- [S]B + [k](-A), both scalars at once (Straus-Shamir), from the highest set bit down.
  for i in reverse v_top .. 1 loop
    if i < v_top then
      v_acc := platform.ed25519_double(v_acc);
    end if;
    if v_sb[i] = 1 and v_kb[i] = 1 then
      v_acc := platform.ed25519_add(v_acc, v_both);
    elsif v_sb[i] = 1 then
      v_acc := platform.ed25519_add(v_acc, v_base);
    elsif v_kb[i] = 1 then
      v_acc := platform.ed25519_add(v_acc, v_nega);
    end if;
  end loop;
  zi := platform.ed25519_pow(v_acc[3], q - 2);
  return mod(v_acc[2] * zi, q) + mod(mod(v_acc[1] * zi, q), 2) * top = platform.ed25519_le_integer(substring(p_signature from 1 for 32));
end
$$;


-- ---------------------------------------------------------------------------------------------
-- Seals
-- ---------------------------------------------------------------------------------------------

-- The bytes a seal signs: the purpose (domain separation) and the SHA-256 of the payload's UTF-8 text.
create function platform.seal_message(p_purpose text, p_payload text) returns bytea
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select convert_to('ebmr.' || p_purpose || '.v1|' || encode(sha256(convert_to(p_payload, 'UTF8')), 'hex'), 'UTF8')
$$;

-- True when p_seal (canonical standard base64 of 64 bytes) is the Ed25519 signature of the purpose and payload under p_key.
create function platform.seal_valid(p_key bytea, p_purpose text, p_payload text, p_seal text) returns boolean
language plpgsql immutable set search_path = pg_catalog, platform, pg_temp as $$
begin
  if p_key is null or p_payload is null or p_seal is null or p_purpose is null
     or p_purpose not in ('transfer-package', 'federation-request', 'federation-answer')
     or p_seal !~ '^[A-Za-z0-9+/]{85}[AQgw]==$' then
    return false;
  end if;
  return coalesce(platform.ed25519_verify(p_key, platform.seal_message(p_purpose, p_payload), decode(p_seal, 'base64')), false);
end
$$;

create function platform.current_installation() returns platform.installation_identity
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select * from platform.installation_identity order by version desc limit 1
$$;

-- The trusted entry of a peer: approved and not revoked (NULL when none).
create function platform.trusted_peer(p_code text) returns platform.peer_installation
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select p.* from platform.peer_installation p
   where p.installation_code = p_code
     and exists (select 1 from platform.peer_installation_approval a where a.peer_id = p.id)
     and not exists (select 1 from platform.peer_installation_revocation r where r.peer_id = p.id)
   order by p.proposed_at desc limit 1
$$;

create function platform.own_seal_valid(p_purpose text, p_payload text, p_seal text) returns boolean
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select coalesce(platform.seal_valid((platform.current_installation()).public_key, p_purpose, p_payload, p_seal), false)
$$;

create function platform.peer_seal_valid(p_code text, p_purpose text, p_payload text, p_seal text) returns boolean
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select coalesce(platform.seal_valid((platform.trusted_peer(p_code)).public_key, p_purpose, p_payload, p_seal), false)
$$;

-- The raw 32-byte key of a base64 text (NULL when it is not one).
create function platform.raw_public_key(p text) returns bytea
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v bytea;
begin
  if p is null or p !~ '^[A-Za-z0-9+/]{43}=$' then
    return null;
  end if;
  v := decode(p, 'base64');
  return case when length(v) = 32 and platform.ed25519_decode(v) is not null then v end;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- This installation and its peers
-- ---------------------------------------------------------------------------------------------

create function platform.set_installation_identity(p_code text, p_site text, p_edition text, p_public_key text) returns integer
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('SYSTEM.CONFIGURE', '{}'::jsonb);
  cur     platform.installation_identity := platform.current_installation();
  v_key   bytea := platform.raw_public_key(p_public_key);
  v_ver   integer;
begin
  if coalesce(p_code, '') !~ '^[A-Z0-9][A-Z0-9-]{1,31}$' or coalesce(p_site, '') !~ '^[A-Z0-9][A-Z0-9-]{0,15}$'
     or p_edition is null or p_edition not in ('TABLETS', 'INJECTABLES') then
    raise exception using errcode = 'P0001',
      message = 'EBMR-XFR-001 an installation identity names its code, its site and its edition (TABLETS or INJECTABLES) (L-41)';
  end if;
  if v_key is null then
    raise exception using errcode = 'P0001', message = 'EBMR-XFR-002 the installation key is the standard base64 of a 32-byte Ed25519 public key (D-P6i-0-8)';
  end if;
  perform 1 from platform.installation_identity for update;
  cur := platform.current_installation();
  if cur.version is not null and (cur.installation_code <> p_code or cur.site_code <> p_site or cur.edition <> p_edition) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-XFR-003 this installation is %s (site %s, %s); its code, site and edition never change, only its key (L-41)',
                       cur.installation_code, cur.site_code, cur.edition);
  end if;
  if cur.version is not null and cur.public_key = v_key then
    return cur.version;
  end if;
  v_ver := coalesce(cur.version, 0) + 1;
  insert into platform.installation_identity (version, installation_code, site_code, edition, public_key, key_fingerprint, set_by_person, set_by_account)
  values (v_ver, p_code, p_site, p_edition, v_key, encode(sha256(v_key), 'hex'), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  return v_ver;
end
$$;

create function platform.propose_peer_installation(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, pg_temp as $$
declare
  v_actor jsonb := iam.require_permission('SYSTEM.CONFIGURE', '{}'::jsonb);
  v_key   bytea;
  v_id    uuid;
begin
  if p is null or jsonb_typeof(p) <> 'object'
     or coalesce(p ->> 'installationCode', '') !~ '^[A-Z0-9][A-Z0-9-]{1,31}$' or coalesce(p ->> 'siteCode', '') !~ '^[A-Z0-9][A-Z0-9-]{0,15}$'
     or coalesce(p ->> 'edition', '') not in ('TABLETS', 'INJECTABLES')
     or coalesce(p ->> 'baseUrl', '') !~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[!-~]*)?$' or length(p ->> 'baseUrl') > 200 then
    raise exception using errcode = 'P0001',
      message = 'EBMR-XFR-004 a peer installation names its code, site, edition, base URL (http or https) and Ed25519 public key';
  end if;
  v_key := platform.raw_public_key(p ->> 'publicKey');
  if v_key is null then
    raise exception using errcode = 'P0001', message = 'EBMR-XFR-002 the installation key is the standard base64 of a 32-byte Ed25519 public key (D-P6i-0-8)';
  end if;
  if (platform.current_installation()).installation_code = p ->> 'installationCode' or (platform.current_installation()).public_key = v_key then
    raise exception using errcode = 'P0001', message = 'EBMR-XFR-005 an installation is never its own peer';
  end if;
  insert into platform.peer_installation (installation_code, site_code, edition, base_url, public_key, key_fingerprint, proposed_by_person, proposed_by_account)
  values (p ->> 'installationCode', p ->> 'siteCode', p ->> 'edition', p ->> 'baseUrl', v_key, encode(sha256(v_key), 'hex'),
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return v_id;
end
$$;

create function platform.peer_installation_state(p_id uuid) returns text
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select case when exists (select 1 from platform.peer_installation_revocation r where r.peer_id = p_id) then 'REVOKED'
              when exists (select 1 from platform.peer_installation_approval a where a.peer_id = p_id) then 'APPROVED'
              when exists (select 1 from platform.peer_installation p where p.id = p_id) then 'PROPOSED' end
$$;

create function platform.peer_installation_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  p platform.peer_installation;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into p from platform.peer_installation where id = p_id::uuid;
  if p.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object('exists', true, 'content_version', 1, 'state', platform.peer_installation_state(p.id),
    'content', jsonb_build_object('installation_code', p.installation_code, 'site_code', p.site_code, 'edition', p.edition, 'base_url', p.base_url,
                                  'key_fingerprint', p.key_fingerprint, 'proposed_by', p.proposed_by_person),
    'scope', '{}'::jsonb);
end
$$;

select esig.register_content_provider('peer_installation', 'platform.peer_installation_content(text)',
  'Another site installation whose sealed lot-transfer packages and genealogy answers this site accepts (L-41, DI-31)');

create function platform.approve_peer_installation(p_id uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, esig, pg_temp as $$
declare
  v_actor jsonb;
  p       platform.peer_installation;
  v_prob  text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('TRANSFER.PEER_APPROVE', '{}'::jsonb);
  select * into p from platform.peer_installation where id = p_id for update;
  if p.id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-XFR-006 there is no proposed peer installation %s', coalesce(p_id::text, 'NULL'));
  end if;
  if platform.peer_installation_state(p.id) <> 'PROPOSED' then
    raise exception using errcode = 'P0001', message = format('EBMR-XFR-006 peer installation %s is %s; only a proposed one is approved', p.installation_code, platform.peer_installation_state(p.id));
  end if;
  perform 1 from platform.peer_installation x where x.installation_code = p.installation_code for update;
  if (platform.trusted_peer(p.installation_code)).id is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-XFR-007 installation %s is trusted already; revoke that entry before approving another key', p.installation_code);
  end if;
  perform esig.assert_signature(p_signature, 'PEER_INSTALLATION_APPROVED', 'peer_installation', p.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'EBMR-XFR-008 ' || v_prob;
  end if;
  if (select s.signer_person from esig.signature s where s.id = p_signature)::text is distinct from v_actor ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'EBMR-XFR-008 the peer installation is approved by the QA person who signed the approval';
  end if;
  insert into platform.peer_installation_approval (peer_id, signature_id, approved_by_person, approved_by_account)
  values (p.id, p_signature, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
end
$$;

create function platform.revoke_peer_installation(p_id uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, pg_temp as $$
declare
  v_actor jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('TRANSFER.PEER_APPROVE', '{}'::jsonb);
  perform 1 from platform.peer_installation where id = p_id for update;
  if coalesce(platform.peer_installation_state(p_id), 'NONE') <> 'APPROVED' then
    raise exception using errcode = 'P0001', message = 'EBMR-XFR-006 only an approved peer installation is revoked';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception using errcode = 'P0001', message = 'EBMR-XFR-009 a revocation states its reason (at least 10 characters)';
  end if;
  insert into platform.peer_installation_revocation (peer_id, reason, revoked_by_person, revoked_by_account)
  values (p_id, btrim(p_reason), (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Alarms
-- ---------------------------------------------------------------------------------------------

create function platform.raise_installation_alarm(p_kind text, p_severity text, p_path text, p_peer text, p_details jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v_id uuid;
begin
  insert into platform.installation_alarm (kind, severity, path, peer_code, details)
  values (p_kind, p_severity, p_path, left(p_peer, 64), coalesce(p_details, '{}'::jsonb))
  returning id into v_id;
  perform pg_notify('ebmr_installation_alarm', jsonb_build_object('alarm_id', v_id, 'kind', p_kind, 'path', p_path)::text);
  return v_id;
end
$$;

create function platform.acknowledge_installation_alarm(p_alarm uuid, p_note text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, iam, pg_temp as $$
declare
  v_actor jsonb;
begin
  v_actor := iam.require_permission('ALARM.ACKNOWLEDGE', '{}'::jsonb);
  if not exists (select 1 from platform.installation_alarm a where a.id = p_alarm) then
    raise exception using errcode = 'P0001', message = format('EBMR-FED-009 there is no installation alarm %s', coalesce(p_alarm::text, 'NULL'));
  end if;
  if btrim(coalesce(p_note, '')) = '' or length(p_note) > 1000 then
    raise exception using errcode = 'P0001', message = 'EBMR-FED-009 an acknowledgment carries a note (at most 1000 characters)';
  end if;
  perform 1 from platform.installation_alarm where id = p_alarm for update;
  if exists (select 1 from platform.installation_alarm_ack k where k.alarm_id = p_alarm) then
    raise exception using errcode = 'P0001', message = 'EBMR-FED-009 this alarm is acknowledged already';
  end if;
  insert into platform.installation_alarm_ack (alarm_id, note, acknowledged_by, acknowledged_role)
  values (p_alarm, btrim(p_note), (v_actor ->> 'person_id')::uuid, v_actor ->> 'role_code');
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The answering side of a site-to-site request (D-P6i-0-9)
-- ---------------------------------------------------------------------------------------------

-- {ok: true, requestId, request} or {ok: false, reason, alarmId}; never raises for a bad request, so the refusal and its
-- alarm commit (DI-31: a refused transfer is never silent).
create function platform.accept_federation_request(p_request text, p_seal text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  m        jsonb;
  v_from   text;
  v_nonce  uuid;
  v_kind   text;
  v_reason text;
  v_alarm  uuid;
  v_id     uuid;
  v_issued numeric;
  v_now    numeric := floor(extract(epoch from clock_timestamp()) * 1000000);
  me       platform.installation_identity := platform.current_installation();
begin
  begin
    m := p_request::jsonb;
  exception when others then
    m := null;
  end;
  if jsonb_typeof(m) = 'object' then
    v_from := case when (m ->> 'from') ~ '^[A-Z0-9][A-Z0-9-]{1,31}$' then m ->> 'from' end;
    v_nonce := case when (m ->> 'nonce') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (m ->> 'nonce')::uuid end;
  end if;
  if me.version is null then
    v_kind := 'WRONG_DESTINATION'; v_reason := 'EBMR-FED-001 this installation has no identity yet; it answers no site-to-site request';
  elsif jsonb_typeof(m) is distinct from 'object' or m ->> 'format' is distinct from 'ebmr.federation-request.v1' or v_from is null or v_nonce is null
        or coalesce(m ->> 'issuedAtUs', '') !~ '^[1-9][0-9]{0,17}$' or jsonb_typeof(m -> 'query') is distinct from 'object' then
    v_kind := 'MALFORMED'; v_reason := 'EBMR-FED-002 the request is not a federation request (format ebmr.federation-request.v1 with from, to, nonce, issuedAtUs and query)';
  elsif (platform.trusted_peer(v_from)).id is null then
    v_kind := 'UNKNOWN_PEER'; v_reason := format('EBMR-FED-003 installation %s is not a trusted peer of this site', v_from);
  elsif not platform.peer_seal_valid(v_from, 'federation-request', p_request, p_seal) then
    v_kind := 'TAMPERED'; v_reason := format('EBMR-FED-004 the seal of the request does not verify under the key of installation %s', v_from);
  elsif m ->> 'to' is distinct from me.installation_code then
    v_kind := 'WRONG_DESTINATION'; v_reason := format('EBMR-FED-005 the request is addressed to %s, not to this installation %s', coalesce(m ->> 'to', 'nobody'), me.installation_code);
  else
    v_issued := (m ->> 'issuedAtUs')::numeric;
    if abs(v_now - v_issued) > 300000000 then
      v_kind := 'REPLAYED'; v_reason := 'EBMR-FED-006 the request was issued more than 300 seconds from now; ask again (D-P6i-0-9)';
    elsif exists (select 1 from platform.federation_request r where r.requester_code = v_from and r.nonce = v_nonce and r.outcome = 'ANSWERED') then
      v_kind := 'REPLAYED'; v_reason := 'EBMR-FED-006 this request was answered already (its nonce is used once; D-P6i-0-9)';
    end if;
  end if;
  if v_reason is not null then
    v_alarm := platform.raise_installation_alarm(v_kind, case when v_kind in ('TAMPERED', 'REPLAYED') then 'MAJOR' else 'MINOR' end, 'FEDERATION_ANSWER', v_from,
                                                 jsonb_build_object('reason', v_reason, 'nonce', v_nonce));
    insert into platform.federation_request (requester_code, nonce, request_sha256, query, outcome, reason, alarm_id)
    values (v_from, v_nonce, encode(sha256(convert_to(coalesce(p_request, ''), 'UTF8')), 'hex'), case when jsonb_typeof(m -> 'query') = 'object' then m -> 'query' end,
            'REFUSED', v_reason, v_alarm);
    return jsonb_build_object('ok', false, 'reason', v_reason, 'alarmId', v_alarm);
  end if;
  insert into platform.federation_request (requester_code, nonce, request_sha256, query, outcome)
  values (v_from, v_nonce, encode(sha256(convert_to(p_request, 'UTF8')), 'hex'), m -> 'query', 'ANSWERED')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'requestId', v_id, 'request', m);
end
$$;

-- A refusal after the request was accepted (the query itself is refused): the log row stays ANSWERED-free.
create function platform.refuse_federation_query(p_request uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  r       platform.federation_request;
  v_alarm uuid;
begin
  select * into r from platform.federation_request where id = p_request;
  v_alarm := platform.raise_installation_alarm('WRONG_ANSWER', 'MINOR', 'FEDERATION_ANSWER', r.requester_code, jsonb_build_object('reason', p_reason, 'nonce', r.nonce));
  insert into platform.federation_request (requester_code, nonce, request_sha256, query, outcome, reason, alarm_id)
  values (r.requester_code, r.nonce, r.request_sha256, r.query, 'REFUSED', p_reason, v_alarm);
  return jsonb_build_object('ok', false, 'reason', p_reason, 'alarmId', v_alarm);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------

revoke all on function platform.ed25519_le_integer(bytea), platform.ed25519_pow(numeric, numeric), platform.ed25519_add(numeric[], numeric[]),
  platform.ed25519_double(numeric[]), platform.ed25519_decode(bytea), platform.ed25519_verify(bytea, bytea, bytea),
  platform.seal_message(text, text), platform.seal_valid(bytea, text, text, text), platform.current_installation(), platform.trusted_peer(text),
  platform.own_seal_valid(text, text, text), platform.peer_seal_valid(text, text, text, text), platform.raw_public_key(text),
  platform.set_installation_identity(text, text, text, text), platform.propose_peer_installation(jsonb), platform.peer_installation_state(uuid),
  platform.peer_installation_content(text), platform.approve_peer_installation(uuid, uuid), platform.revoke_peer_installation(uuid, text),
  platform.raise_installation_alarm(text, text, text, text, jsonb), platform.acknowledge_installation_alarm(uuid, text),
  platform.accept_federation_request(text, text), platform.refuse_federation_query(uuid, text) from public;
grant execute on function platform.seal_message(text, text), platform.current_installation(), platform.own_seal_valid(text, text, text),
  platform.peer_seal_valid(text, text, text, text), platform.set_installation_identity(text, text, text, text),
  platform.propose_peer_installation(jsonb), platform.peer_installation_state(uuid), platform.approve_peer_installation(uuid, uuid),
  platform.revoke_peer_installation(uuid, text), platform.acknowledge_installation_alarm(uuid, text) to ebmr_app;

reset role;
