-- Kernel: an installation or peer key of small order is refused, and no seal verifies under one (Phase 6 exit review,
-- finding 6jc-R8; DI-31; D-P6j-c-3; the kernel twin of tablets 0702).
--
-- Handbook: modules/kernel.md
--
-- Kernel 1220 accepted any 32-byte canonical encoding of a curve point as this installation's key
-- (platform.set_installation_identity) or as a peer's key (platform.propose_peer_installation), through
-- platform.raw_public_key. A point of small order (eight times it is the neutral point: the neutral point itself, the
-- point of order 2, and the points of order 4 and 8) makes the Ed25519 check vacuous: under the neutral point as the
-- key, R = B with S = 1 verifies for every payload, so anyone could seal a transfer package or a federation answer in
-- the name of that installation. The seal check meant nothing for such a key.
--
--   platform.ed25519_small_order(key)  true when [8]A is the neutral point (x = 0: the only point of the prime-order
--                                      group with x = 0 is the neutral point, and [8]A always lies in that group); null
--                                      when the key is not the canonical encoding of a point. As tab.ed25519_small_order.
--   platform.raw_public_key(text)      re-created: still NULL for text that is not the standard base64 of a canonical
--                                      32-byte point (platform.ed25519_decode already refuses y >= q and a negative
--                                      zero x, so a non-canonical encoding never passes); a key of small order now
--                                      raises EBMR-XFR-042, so both callers refuse it with a message that names the
--                                      problem, before anything is written.
--   platform.seal_valid(...)           re-created: false under a key of small order, so a key stored before this
--                                      migration (an installation identity or a trusted peer) never verifies a seal;
--                                      own_seal_valid and peer_seal_valid, and every package import, federation request
--                                      and answer that call them, inherit it. Its administrator sets a new key (or
--                                      revokes the peer and proposes its real key).
--
-- platform.ed25519_verify itself is unchanged: the plain RFC 8032 check, as tab.ed25519_verify after tablets 0702. Each
-- replaced function keeps its owner, volatility, search_path and grants (CREATE OR REPLACE); the new helper is owned by
-- ebmr_owner and granted to nobody.
-- Messages: EBMR-XFR-042.

set local role ebmr_owner;

create function platform.ed25519_small_order(p_key bytea) returns boolean
language sql immutable strict set search_path = pg_catalog, platform, pg_temp as $$
  select (platform.ed25519_double(platform.ed25519_double(platform.ed25519_double(platform.ed25519_decode(p_key)))))[1] = 0
$$;

-- The raw 32-byte key of a base64 text (NULL when it is not one); EBMR-XFR-042 for a key of small order.
create or replace function platform.raw_public_key(p text) returns bytea
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  v bytea;
begin
  if p is null or p !~ '^[A-Za-z0-9+/]{43}=$' then
    return null;
  end if;
  v := decode(p, 'base64');
  if length(v) <> 32 or platform.ed25519_decode(v) is null then
    return null;
  end if;
  if platform.ed25519_small_order(v) then
    raise exception using errcode = 'P0001',
      message = 'EBMR-XFR-042 the installation key is of small order (eight times it is the neutral point), so a seal under it proves nothing; generate a new Ed25519 key pair and give its public key (DI-31)';
  end if;
  return v;
end
$$;

-- True when p_seal (canonical standard base64 of 64 bytes) is the Ed25519 signature of the purpose and payload under
-- p_key, a key of large order.
create or replace function platform.seal_valid(p_key bytea, p_purpose text, p_payload text, p_seal text) returns boolean
language plpgsql immutable set search_path = pg_catalog, platform, pg_temp as $$
begin
  if p_key is null or p_payload is null or p_seal is null or p_purpose is null
     or p_purpose not in ('transfer-package', 'federation-request', 'federation-answer')
     or p_seal !~ '^[A-Za-z0-9+/]{85}[AQgw]==$' then
    return false;
  end if;
  -- 6jc-R8: under a key of small order (or one that is no point) every seal would verify; none does.
  if coalesce(platform.ed25519_small_order(p_key), true) then
    return false;
  end if;
  return coalesce(platform.ed25519_verify(p_key, platform.seal_message(p_purpose, p_payload), decode(p_seal, 'base64')), false);
end
$$;

revoke all on function platform.ed25519_small_order(bytea) from public;

reset role;
