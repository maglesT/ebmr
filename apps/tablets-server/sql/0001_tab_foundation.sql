-- Tablets server, part 1 (C0 spine; Phase 2 apps plan sections 2, 3 and 5): schema tab, the demo-installation
-- marker, the opaque session-cookie binding and the device-proof nonces.
--
-- Applied after the kernel, site-services and recipe-core migrations (namespace `tablets`). Ranges: C0 0001-0099,
-- C1 0100-0149, C2 0150-0199, C3 0200-0249, C5 0250-0299.
--
-- Privileges: the application role (ebmr_app; in a sandbox the mirrored ebmr_sandbox) holds no privilege on the
-- tables here. It may only EXECUTE the SECURITY DEFINER functions, which list pg_temp last (ADR 0016).

create schema tab authorization ebmr_owner;
revoke all on schema tab from public;
grant usage on schema tab to ebmr_app;

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Demo installation marker (decision D6). The demo device picker exists only when the server runs with
-- EBMR_DEMO=1 AND the database carries this marker. Set-up writes it only for databases named *_demo or
-- *_e2e_*; a copy or restore under another name does not count as a demo database.

create table tab.demo_installation (
  singleton      boolean primary key default true check (singleton),
  database_name  text not null,
  marked_at      timestamptz not null default clock_timestamp(),
  note           text not null
);
revoke all on tab.demo_installation from public;

create function tab.is_demo_database_name(p_name text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_name ~ '(_demo$|_e2e_[a-z0-9]+$)'
$$;

-- Owner or superuser only (the set-up CLI): marks this database as a demo database, once.
create function tab.mark_demo_installation(p_note text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
begin
  if not tab.is_demo_database_name(current_database()) then
    raise exception using errcode = 'P0001',
      message = format('Database %s is not a demo database (names end in _demo or contain _e2e_); the demo device picker stays off (decision D6). [EBMR-TAB-001]', current_database());
  end if;
  insert into tab.demo_installation (database_name, note) values (current_database(), p_note) on conflict (singleton) do nothing;
end
$$;
revoke all on function tab.mark_demo_installation(text) from public;

-- True only when the marker exists and names this very database.
create function tab.is_demo_installation() returns boolean
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select exists (select 1 from tab.demo_installation d where d.database_name = current_database())
         and tab.is_demo_database_name(current_database())
$$;
revoke all on function tab.is_demo_installation() from public;
grant execute on function tab.is_demo_installation() to ebmr_app;

-- ---------------------------------------------------------------------------------------------
-- Session binding (fix for the cookie collision, J1-1/J2-1). The browser's cookie holds an opaque random
-- token; the server stores only its SHA-256 here, bound once to a kernel session opened at most 10 s earlier.
-- The kernel session id never reaches the browser (it appears in audit payloads).

create table tab.session_binding (
  token_hash   text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  session_id   uuid not null unique references iam.session (id),
  role_code    text,
  bound_at     timestamptz not null default clock_timestamp(),
  role_set_at  timestamptz,
  unbound_at   timestamptz
);
revoke all on tab.session_binding from public;

create function tab.bind_session(p_session uuid, p_token_hash text, p_role text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  v_opened timestamptz;
begin
  select opened_at into v_opened from iam.session where id = p_session and ended_at is null;
  if v_opened is null then
    raise exception using errcode = 'P0001', message = 'The session does not exist or has ended; it cannot be bound. [EBMR-TAB-010]';
  end if;
  if clock_timestamp() - v_opened > interval '10 seconds' then
    raise exception using errcode = 'P0001', message = 'Only a session opened in the last 10 seconds can be bound to a cookie. [EBMR-TAB-011]';
  end if;
  -- Only a person's session on a terminal becomes a browser session (DI-31): never a service, integration or
  -- display account, and never a session on a SERVER or INSTRUMENT device (e.g. the gateway's service session).
  if exists (select 1 from iam.session s join iam.account a on a.id = s.account_id
              where s.id = p_session and (a.kind <> 'HUMAN' or s.device_class in ('SERVER', 'INSTRUMENT'))) then
    raise exception using errcode = 'P0001',
      message = 'Only a person''s session on a terminal can be bound to a browser cookie (DI-31). [EBMR-TAB-016]';
  end if;
  if exists (select 1 from tab.session_binding where session_id = p_session) then
    raise exception using errcode = 'P0001', message = 'The session is already bound to a cookie; a session is bound once only. [EBMR-TAB-012]';
  end if;
  if p_role is not null and not exists (
    select 1 from iam.role_grant g join iam.session s on s.account_id = g.account_id
     where s.id = p_session and g.role_code = p_role and g.status = 'APPROVED' and g.revoked_at is null
       and g.valid_from <= clock_timestamp() and (g.valid_to is null or g.valid_to > clock_timestamp())) then
    raise exception using errcode = 'P0001', message = format('The account does not hold the role %s now. [EBMR-TAB-013]', p_role);
  end if;
  insert into tab.session_binding (token_hash, session_id, role_code, role_set_at)
  values (p_token_hash, p_session, p_role, case when p_role is null then null else clock_timestamp() end);
end
$$;

-- The declared role, set once when the account holds several roles.
create function tab.set_session_role(p_token_hash text, p_role text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  b tab.session_binding;
begin
  select * into b from tab.session_binding where token_hash = p_token_hash and unbound_at is null for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'No session is bound to this cookie. [EBMR-TAB-014]';
  end if;
  if b.role_code is not null then
    raise exception using errcode = 'P0001', message = 'The role of this session is already declared; log in again to act in another role. [EBMR-TAB-015]';
  end if;
  if not exists (
    select 1 from iam.role_grant g join iam.session s on s.account_id = g.account_id
     where s.id = b.session_id and g.role_code = p_role and g.status = 'APPROVED' and g.revoked_at is null
       and g.valid_from <= clock_timestamp() and (g.valid_to is null or g.valid_to > clock_timestamp())) then
    raise exception using errcode = 'P0001', message = format('The account does not hold the role %s now. [EBMR-TAB-013]', p_role);
  end if;
  update tab.session_binding set role_code = p_role, role_set_at = clock_timestamp() where token_hash = p_token_hash;
end
$$;

-- Everything a request needs about its session, in one call. Null when the token is unknown or unbound.
create function tab.resolve_session(p_token_hash text) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
  select jsonb_build_object(
           'session_id', s.id, 'person_id', s.person_id, 'account_id', s.account_id, 'device_id', s.device_id,
           'device_code', d.code, 'device_class', s.device_class, 'site_code', s.site_code, 'room_code', s.room_code,
           'line_code', d.line_code, 'role_code', b.role_code, 'state', iam.session_state(s.id),
           'legal_name', p.legal_name, 'login_name', a.login_name, 'idle_timeout_seconds', s.idle_timeout_seconds,
           'roles', coalesce((select jsonb_agg(distinct g.role_code order by g.role_code) from iam.role_grant g
                               where g.account_id = s.account_id and g.status = 'APPROVED' and g.revoked_at is null
                                 and g.valid_from <= clock_timestamp() and (g.valid_to is null or g.valid_to > clock_timestamp())), '[]'::jsonb))
    from tab.session_binding b
    join iam.session s on s.id = b.session_id
    join iam.device d on d.id = s.device_id
    join iam.person p on p.id = s.person_id
    join iam.account a on a.id = s.account_id
   where b.token_hash = p_token_hash and b.unbound_at is null
$$;

create function tab.unbind_session(p_token_hash text) returns uuid
language sql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
  update tab.session_binding set unbound_at = clock_timestamp()
   where token_hash = p_token_hash and unbound_at is null
  returning session_id
$$;

revoke all on function tab.bind_session(uuid, text, text), tab.set_session_role(text, text), tab.resolve_session(text), tab.unbind_session(text) from public;
grant execute on function tab.bind_session(uuid, text, text), tab.set_session_role(text, text), tab.resolve_session(text), tab.unbind_session(text) to ebmr_app;

-- ---------------------------------------------------------------------------------------------
-- Device-proof nonces (DI-20; plan section 5). The server mints a random nonce, stores only its HMAC, and a
-- proof must use it within 60 s, once.

create table tab.device_nonce (
  nonce_hmac   text primary key check (nonce_hmac ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz not null default clock_timestamp(),
  expires_at   timestamptz not null,
  used_at      timestamptz
);
revoke all on tab.device_nonce from public;

create function tab.mint_device_nonce(p_hmac text, p_ttl_seconds integer) returns timestamptz
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_expires timestamptz := clock_timestamp() + make_interval(secs => least(greatest(p_ttl_seconds, 1), 300));
begin
  delete from tab.device_nonce where expires_at < clock_timestamp() - interval '1 hour';
  insert into tab.device_nonce (nonce_hmac, expires_at) values (p_hmac, v_expires);
  return v_expires;
end
$$;

-- True when the nonce was minted here, is unused and unexpired; it is used up either way.
create function tab.consume_device_nonce(p_hmac text) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_ok boolean;
begin
  update tab.device_nonce set used_at = clock_timestamp()
   where nonce_hmac = p_hmac and used_at is null
  returning expires_at >= clock_timestamp() into v_ok;
  return coalesce(v_ok, false);
end
$$;

revoke all on function tab.mint_device_nonce(text, integer), tab.consume_device_nonce(text) from public;
grant execute on function tab.mint_device_nonce(text, integer), tab.consume_device_nonce(text) to ebmr_app;

-- Database clock for the server (GMP time always comes from the database).
create function tab.now_micros() returns text
language sql stable set search_path = pg_catalog, pg_temp as $$
  select (extract(epoch from clock_timestamp()) * 1000000)::bigint::text
$$;
grant execute on function tab.now_micros() to ebmr_app;

reset role;
