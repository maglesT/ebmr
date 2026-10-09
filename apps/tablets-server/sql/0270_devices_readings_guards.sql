-- Tablets server, module C5: the database itself proves every scale reading it stores, takes the room of a claim
-- from the actor's session, and counts the time an upload waited at the server in the reading's age
-- (review findings P48, P49 and P53; controls DI-20, DI-22, DI-28, DI-31, DI-32, INV-40).
--
-- P48. tab.ingest_reading recomputed the hash but stored the Ed25519 signature as it came and never compared the raw
-- instrument line with the value: both checks lived only in the Node listener. Whoever held the application role's
-- credentials could open a command as the gateway's live session (a SERVER device needs no authentication event)
-- and store any value, with a raw line saying something else and a junk signature, as an original DEVICE record.
-- PostgreSQL 16 has no Ed25519 in core or in any extension installed here, so the verification is written below in
-- PL/pgSQL over exact numeric arithmetic (RFC 8032, section 5.1.7, cofactorless like OpenSSL: S must be below L, and
-- the encoding of [S]B - [k]A must equal R byte for byte); SHA-512 is the core sha512(). A row trigger on
-- tab.device_reading (a2_reading_proof, so no writer and no owner-level code can skip it) refuses a row unless
--   EBMR-DEV-045  its hash is SHA-256 of the canonical text of the row's own stored columns (not of the request);
--   EBMR-DEV-061  its signature is a valid Ed25519 signature of "ebmr.scale-reading.v1|<hash>" (the canonical
--                 standard base64 of 64 bytes: unused bits of the last character zero, so one signature has one
--                 text) under the public key enrolled for its chain (tab.gateway_key.public_key_spki, whose
--                 SHA-256 is the registered fingerprint of the gateway's SERVER device);
--   EBMR-DEV-062  its raw line, read with the MT-SICS grammar of the SDK's interpretWeightLine
--                 (tab.raw_weight_interpretation), states exactly its value, unit, stability and status.
-- So the database proves that each stored reading was signed by the holder of the enrolled gateway key with exactly
-- the stored content, and that its value is what its raw line says. It cannot prove that the instrument produced the
-- line (that trust rests on the gateway key and the I4 serial the gateway read). tab.claim_readings checks the stored
-- proof again before a reading is used (EBMR-DEV-110), so a row that reached the table any other way (a restore, or a
-- superuser with triggers off) is never used as a weight.
--
-- P49. tab.claim_readings compared the instrument's room with p_room, a plain argument, never with the room of the
-- validated actor's session. The room is now the session's (iam.actor_location_scope: the room of the enrolled
-- terminal when the session opened); p_room must name that same room, else EBMR-DEV-103, also when the session has
-- no room. The use row and its audit record the session's room. tab.alert_claim_refusal (0250) is unchanged: it
-- takes no session from its caller, so nothing the caller says becomes a fact. After a refused claim's rollback the
-- database holds no evidence of which session made it, so a durable alert cannot name one; the refusal itself is
-- what the database enforces. In the product flow the named room is the session's own (C3 claims for
-- roomOfStep, the room of the session's terminal), so a balance of another room differs from the named room and
-- the three-argument form alerts it.
--
-- P53. The age of a reading at claim time is now - recorded + uplink_delay_us, recorded being the database clock at
-- the insert. uplink_delay_us held only the gateway's wait; the time the upload then spent at the server was counted
-- nowhere. The stored wait is now p_delay_us plus the database's own wait from the start of the ingesting
-- transaction to the insert (clock_timestamp() - transaction_timestamp(): the command's validation, anything the
-- caller did or slept on inside the transaction before the ingest statement, the chain lock). p_delay_us is what
-- the listener reports: the gateway's wait plus its own, from the request's arrival to the ingest statement (the
-- stretch between BEGIN and that statement is so counted twice, on the stricter side). A negative wait is refused
-- (EBMR-DEV-051); an unknown wait (null) stays unknown, so the reading is never claimable.
-- What the database proves: the wait inside the ingesting transaction. What it cannot prove: p_delay_us, the wait
-- before the transaction began, which is neither signed by the gateway nor measured by the database; a holder of
-- the application role's credentials can hold back a genuinely signed reading before opening the transaction and
-- report a smaller wait. Until the gateway signs its upload wait against a database-issued challenge, the DI-28
-- freshness of that part rests on the application's credentials.
--
-- Owner, SECURITY DEFINER, search_path and grants of the replaced functions are kept (CREATE OR REPLACE by the same
-- owner). The new helpers are not granted to the application role, and no new function is.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Ed25519 verification (RFC 8032). Field elements and scalars are little-endian; the curve is
-- -x^2 + y^2 = 1 + d x^2 y^2 over GF(q), q = 2^255 - 19; points are extended coordinates {X, Y, Z, T} with
-- x = X/Z, y = Y/Z, x*y = T/Z. Only public data is handled, so timing does not matter.

-- The unsigned little-endian integer of a byte string.
create function tab.le_integer(p bytea) returns numeric
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
create function tab.ed25519_pow(p_base numeric, p_exp numeric) returns numeric
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
create function tab.ed25519_add(p numeric[], r numeric[]) returns numeric[]
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
create function tab.ed25519_double(p numeric[]) returns numeric[]
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
create function tab.ed25519_decode(p bytea) returns numeric[]
language plpgsql immutable strict set search_path = pg_catalog, tab, pg_temp as $$
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
  y := tab.le_integer(set_byte(p, 31, get_byte(p, 31) & 127));
  if y >= q then
    return null;
  end if;
  u := mod(y * y - 1 + q, q);
  v := mod(d * mod(y * y, q) + 1, q);
  v3 := mod(v * v * v, q);
  -- x = u v^3 (u v^7)^((q - 5) / 8)
  x := mod(u * v3 * tab.ed25519_pow(mod(u * v3 * v3 * v, q), 7237005577332262213973186563042994240829374041602535252466099000494570602493), q);
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
create function tab.ed25519_verify(p_key bytea, p_message bytea, p_signature bytea) returns boolean
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
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
  s := tab.le_integer(substring(p_signature from 33 for 32));
  if s >= l then
    return false;
  end if;
  v_a := tab.ed25519_decode(p_key);
  if v_a is null then
    return false;
  end if;
  k := mod(tab.le_integer(sha512(substring(p_signature from 1 for 32) || p_key || p_message)), l);
  v_nega := array[mod(q - v_a[1], q), v_a[2], v_a[3], mod(q - v_a[4], q)];
  v_both := tab.ed25519_add(v_base, v_nega);
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
      v_acc := tab.ed25519_double(v_acc);
    end if;
    if v_sb[i] = 1 and v_kb[i] = 1 then
      v_acc := tab.ed25519_add(v_acc, v_both);
    elsif v_sb[i] = 1 then
      v_acc := tab.ed25519_add(v_acc, v_base);
    elsif v_kb[i] = 1 then
      v_acc := tab.ed25519_add(v_acc, v_nega);
    end if;
  end loop;
  zi := tab.ed25519_pow(v_acc[3], q - 2);
  return mod(v_acc[2] * zi, q) + mod(mod(v_acc[1] * zi, q), 2) * top = tab.le_integer(substring(p_signature from 1 for 32));
end
$$;

-- True when p_signature (standard base64 of 64 bytes) is the Ed25519 signature of a reading hash under an enrolled
-- gateway key (base64 SPKI DER of an Ed25519 key), over the text the SDK signs: "ebmr.scale-reading.v1|<hash>".
-- The base64 must be canonical: 64 bytes fill 85 characters and 2 bits of the 86th, whose 4 unused bits must be
-- zero (A, Q, g or w), so a stored signature has exactly one text.
create function tab.reading_signature_valid(p_spki text, p_hash text, p_signature text) returns boolean
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
  return tab.ed25519_verify(substring(v_spki from 13 for 32), convert_to('ebmr.scale-reading.v1|' || p_hash, 'UTF8'), decode(p_signature, 'base64'));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The raw MT-SICS line (DI-32): what a weight-request response states, as the SDK's interpretWeightLine reads it.
-- {value, unit, stable, status}, or null for a line that is not a well-formed response (a garbled line is never a
-- value): "S S <v> <u>" OK, "S D <v> <u>" UNSTABLE, "S +" OVERLOAD, "S -" UNDERLOAD, any other response ERROR.

create function tab.raw_weight_interpretation(p_raw text) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_error constant jsonb := jsonb_build_object('value', null, 'unit', null, 'stable', false, 'status', 'ERROR');
  m text[];
begin
  if p_raw is null or p_raw !~ '^[ -~]{1,128}$' then
    return null;
  end if;
  m := regexp_match(p_raw, '^(S|T) (S|D) +(-?[0-9]+(?:\.[0-9]+)?) ([A-Za-z]{1,5})$');
  if m is not null then
    if not tab.is_decimal_text(m[3]) then
      return null;
    end if;
    if m[1] = 'T' then
      return v_error;
    end if;
    return jsonb_build_object('value', m[3], 'unit', m[4], 'stable', m[2] = 'S', 'status', case m[2] when 'S' then 'OK' else 'UNSTABLE' end);
  end if;
  if p_raw ~ '^I4 A "[!#-~]{1,32}"$' then
    return v_error;
  end if;
  m := regexp_match(p_raw, '^(S|T|Z|I4) (A|I|\+|-)$');
  if m is not null then
    if m[1] = 'I4' and m[2] <> 'I' then
      return null;
    end if;
    if m[1] = 'S' and m[2] = '+' then
      return jsonb_build_object('value', null, 'unit', null, 'stable', false, 'status', 'OVERLOAD');
    end if;
    if m[1] = 'S' and m[2] = '-' then
      return jsonb_build_object('value', null, 'unit', null, 'stable', false, 'status', 'UNDERLOAD');
    end if;
    return v_error;
  end if;
  if p_raw ~ '^(ES|ET|EL)$' then
    return v_error;
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The proof of a stored reading (P48): null when sound, otherwise {code, message}.

create function tab.device_reading_problem(r tab.device_reading) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_spki text;
  v_seen jsonb;
begin
  if encode(sha256(convert_to(tab.reading_canonical_text(jsonb_build_object(
       'format', 'ebmr.scale-reading.v1', 'readingId', r.id::text, 'chainId', r.chain_id::text, 'gatewayCode', r.gateway_code,
       'deviceCode', r.device_code, 'serial', r.serial, 'seq', r.seq::text, 'value', r.value, 'unit', r.unit, 'stable', r.stable,
       'status', r.status, 'raw', r.raw, 'sourceTimeUs', r.source_time_us::text, 'trust', r.trust, 'installation', r.installation,
       'purpose', r.purpose, 'prevHash', r.prev_hash)), 'UTF8')), 'hex') is distinct from r.hash then
    return jsonb_build_object('code', 'EBMR-DEV-045', 'message', 'DI-31: the reading hash does not match its stored content');
  end if;
  select k.public_key_spki into v_spki from tab.gateway_key k where k.id = r.chain_id;
  if not coalesce(tab.reading_signature_valid(v_spki, r.hash, r.signature), false) then
    return jsonb_build_object('code', 'EBMR-DEV-061',
      'message', format('DI-31: the signature of reading %s does not verify with the gateway key enrolled for its chain', r.id));
  end if;
  v_seen := tab.raw_weight_interpretation(r.raw);
  if v_seen is null or (v_seen ->> 'value') is distinct from r.value or (v_seen ->> 'unit') is distinct from r.unit
     or (v_seen ->> 'stable')::boolean is distinct from r.stable or (v_seen ->> 'status') is distinct from r.status then
    return jsonb_build_object('code', 'EBMR-DEV-062',
      'message', format('DI-32: the raw line "%s" states %s, not %s %s (%s)', r.raw,
                        case when v_seen is null then 'no readable response'
                             else coalesce((v_seen ->> 'value') || ' ' || (v_seen ->> 'unit'), 'no value') || ' (' || (v_seen ->> 'status') || ')' end,
                        coalesce(r.value, 'no value'), coalesce(r.unit, ''), r.status));
  end if;
  return null;
end
$$;

-- An AFTER INSERT row trigger: it checks the row exactly as stored, once every BEFORE trigger has run (the forced
-- recorded_at and the derived recorded_us, which it leaves alone), and its refusal aborts the inserting statement, so
-- nothing of the row remains. AFTER triggers fire in name order, so a2_ runs before the kernel's zz_ audit trigger.
create function tab.device_reading_proof() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_problem jsonb := tab.device_reading_problem(new);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = (v_problem ->> 'code') || ' ' || (v_problem ->> 'message');
  end if;
  return null;
end
$$;
create trigger a2_reading_proof after insert on tab.device_reading for each row execute function tab.device_reading_proof();

revoke all on function tab.le_integer(bytea), tab.ed25519_pow(numeric, numeric), tab.ed25519_add(numeric[], numeric[]),
  tab.ed25519_double(numeric[]), tab.ed25519_decode(bytea), tab.ed25519_verify(bytea, bytea, bytea),
  tab.reading_signature_valid(text, text, text), tab.raw_weight_interpretation(text), tab.device_reading_problem(tab.device_reading),
  tab.device_reading_proof() from public;

-- ---------------------------------------------------------------------------------------------
-- Ingestion as in 0260, except (P53) that the stored wait is p_delay_us, the wait the application reports, plus the
-- database's own wait from the start of this transaction until the insert; a negative wait is refused. The proof
-- of the row is checked by the a2_reading_proof trigger at the insert (P48).

create or replace function tab.ingest_reading(p_reading jsonb, p_delay_us bigint) returns jsonb
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
  v_db_wait  bigint;
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

  -- DI-28: the wait inside the database, from the start of this transaction to the insert: the command's validation,
  -- whatever the caller did or waited on in the transaction before this statement, and the chain lock.
  v_db_wait := greatest(platform.epoch_micros(clock_timestamp()) - platform.epoch_micros(transaction_timestamp()), 0);
  insert into tab.device_reading (id, chain_id, seq, gateway_device_id, gateway_code, instrument_device_id, device_code, serial, value, unit,
                                  stable, status, raw, source_time_us, trust, installation, purpose, prev_hash, hash, signature,
                                  uplink_delay_us, ingest_session_id, correlation_id)
  values (v_id, v_key.id, v_seq, v_key.gateway_device_id, v_key.gateway_code, v_dev.id, v_dev.code, p_reading ->> 'serial',
          p_reading ->> 'value', p_reading ->> 'unit', (p_reading ->> 'stable')::boolean, p_reading ->> 'status', p_reading ->> 'raw',
          (p_reading ->> 'sourceTimeUs')::bigint, p_reading ->> 'trust', p_reading ->> 'installation', p_reading ->> 'purpose',
          p_reading ->> 'prevHash', v_hash, p_reading ->> 'signature', p_delay_us + v_db_wait,
          (v_actor ->> 'session_id')::uuid, (v_actor ->> 'correlation_id')::uuid)
  returning recorded_us into v_recorded_us;
  perform kernel.audit_business_event('device_reading:' || v_id,
    format('Scale reading %s from %s via gateway %s: %s (%s), raw "%s"', v_seq, v_dev.code, v_key.gateway_code,
           coalesce((p_reading ->> 'value') || ' ' || (p_reading ->> 'unit'), 'no value'), p_reading ->> 'status', p_reading ->> 'raw'),
    jsonb_build_object('chain_id', v_key.id, 'seq', v_seq, 'hash', v_hash, 'purpose', p_reading ->> 'purpose',
                       'reported_wait_us', p_delay_us, 'database_wait_us', v_db_wait));
  return jsonb_build_object('outcome', 'INGESTED', 'readingId', v_id, 'seq', v_seq::text, 'head', tab.chain_head(v_key.id),
                            'recordedUs', v_recorded_us::text);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Claims as in 0250, except that the room is the validated actor's session's (P49) and that the stored proof of
-- each reading is checked again before it is used (P48).

create or replace function tab.claim_readings(p_ids uuid[], p_room text, p_max_age_us bigint, p_purpose text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, kernel, pg_temp as $$
declare
  v_actor   jsonb := iam.assert_validated_actor();
  v_scope   jsonb;
  v_room    text;
  v_eval    jsonb;
  v_r       tab.device_reading%rowtype;
  v_loc     jsonb;
  v_problem jsonb;
  v_now     bigint := platform.epoch_micros(clock_timestamp());
  v_age     bigint;
  v_out     jsonb := '[]'::jsonb;
  v_id      uuid;
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
  -- DI-20: the room is the one of the actor's session (its enrolled terminal's room when the session opened), never
  -- the caller's word; the room the caller names must be that same room.
  v_room := v_scope ->> 'area';
  if v_room is null or p_room is null or btrim(p_room) = '' then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-103 DI-20: a scale reading can be used only on a terminal registered to a room';
  end if;
  if p_room <> v_room then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-103 DI-20: the claim names room %s, but the terminal of this session is in room %s', p_room, v_room);
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
    -- DI-31, DI-32: the stored reading still carries its proof (hash, gateway signature, raw line).
    v_problem := tab.device_reading_problem(v_r);
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-110 DI-31: reading %s cannot be used: %s', v_id, v_problem ->> 'message');
    end if;
    if v_r.status <> 'OK' or not v_r.stable or v_r.value is null then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-102 DI-32: reading %s is %s, not a stable weight', v_id, v_r.status);
    end if;
    if v_r.installation <> kernel.installation_kind() then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-043 DI-20: reading %s is from a %s installation', v_id, v_r.installation);
    end if;
    v_loc := iam.check_device_location(v_r.instrument_device_id, v_room, null);
    if not (v_loc ->> 'accepted')::boolean then
      raise exception using errcode = 'P0001',
        message = format('EBMR-DEV-103 DI-20: reading %s comes from %s (%s), which is not an active instrument of room %s',
                         v_id, v_r.device_code, coalesce(v_loc ->> 'reason', 'refused'), v_room);
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
      values (v_id, p_purpose, v_room, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid,
              (v_actor ->> 'correlation_id')::uuid);
    exception when unique_violation then
      raise exception using errcode = 'P0001', message = format('EBMR-DEV-105 DI-32: reading %s has already been used', v_id);
    end;
    perform kernel.audit_business_event('device_reading:' || v_id,
      format('Scale reading %s %s from %s used as %s in room %s', v_r.value, v_r.unit, v_r.device_code, p_purpose, v_room),
      jsonb_build_object('purpose', p_purpose, 'room', v_room));
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'readingId', v_id, 'value', v_r.value, 'unit', v_r.unit, 'raw', v_r.raw, 'deviceCode', v_r.device_code,
      'sourceTimeUs', v_r.source_time_us::text, 'trust', v_r.trust));
  end loop;
  return v_out;
end
$$;

reset role;
