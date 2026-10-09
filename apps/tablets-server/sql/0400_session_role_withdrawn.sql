-- Tablets edition, module C0: a session whose role is withdrawn reads nothing more and cannot be kept open (Phase 2 exit
-- review F36; DI-16, DI-17, DI-38; ADR 0012: the rule holds when the application's own database credentials are used
-- directly).
--
-- tab.session_binding keeps the role a session declared at login (C0-4). tab.resolve_session (0001) returned it as the
-- session's role for as long as the session lived, beside the account's live grants: after an administrator revoked
-- the grant (iam.revoke_role_grant), or a time-limited grant passed its valid_to, the session went on reading in that
-- role (MBR families and drafts, the audit trail, signing content, runs), and iam.keep_session_alive and
-- iam.unlock_session, which check only the session, person and device, kept it open up to the absolute timeout. The
-- kernel says a revocation takes effect at once (DI-16); commands and signatures were refused (authority is evaluated
-- at commit), reads were not.
--
-- A session's role is withdrawn (tab.session_role_withdrawn) when the role it declared is no longer granted to its
-- account now (APPROVED, not revoked, inside valid_from and valid_to at clock_timestamp()), or, before a role is
-- declared, when the account holds no live grant at all. Then:
--  - tab.resolve_session (CREATE OR REPLACE) answers state ROLE_WITHDRAWN and no role (role_code null), and names the
--    declared role apart (declared_role), so the server can say why;
--  - tab.end_withdrawn_session ends such a session (kernel end reason ADMIN_TERMINATED: the role was ended by the
--    grant's administration) and unbinds its cookie token; the server calls it on the first request that finds the
--    role withdrawn, and the person signs in again in a role they hold (default F36.1);
--  - tab.keep_session_alive and tab.unlock_session refuse it (EBMR-TAB-017) before they call the kernel's functions,
--    and the application role loses EXECUTE on iam.keep_session_alive and iam.unlock_session, so the session cannot be
--    extended or unlocked around this rule.
--
-- The functions are SECURITY DEFINER, owned by ebmr_owner, and pin their search_path with pg_temp last. CREATE OR
-- REPLACE keeps the owner, the privileges and the search_path of tab.resolve_session of 0001. Applied as a new
-- migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-16 (F36): whether session p_session has lost the role it works in: its declared role p_role is no longer granted
-- to its account now, or (p_role null, no role declared yet) its account holds no live grant at all.
create function tab.session_role_withdrawn(p_session uuid, p_role text) returns boolean
language sql stable security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
  select not exists (
    select 1 from iam.role_grant g join iam.session s on s.account_id = g.account_id
     where s.id = p_session and (p_role is null or g.role_code = p_role)
       and g.status = 'APPROVED' and g.revoked_at is null
       and g.valid_from <= clock_timestamp() and (g.valid_to is null or g.valid_to > clock_timestamp()))
$$;

-- Everything a request needs about its session, in one call. Null when the token is unknown or unbound. A session whose
-- role is withdrawn has state ROLE_WITHDRAWN and no role (F36).
create or replace function tab.resolve_session(p_token_hash text) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
  select jsonb_build_object(
           'session_id', s.id, 'person_id', s.person_id, 'account_id', s.account_id, 'device_id', s.device_id,
           'device_code', d.code, 'device_class', s.device_class, 'site_code', s.site_code, 'room_code', s.room_code,
           'line_code', d.line_code,
           'role_code', case when w.withdrawn then null else b.role_code end,
           'declared_role', b.role_code,
           'state', case when w.withdrawn and iam.session_state(s.id) in ('ACTIVE', 'LOCKED', 'IDLE_LOCKED') then 'ROLE_WITHDRAWN'
                         else iam.session_state(s.id) end,
           'legal_name', p.legal_name, 'login_name', a.login_name, 'idle_timeout_seconds', s.idle_timeout_seconds,
           'roles', coalesce((select jsonb_agg(distinct g.role_code order by g.role_code) from iam.role_grant g
                               where g.account_id = s.account_id and g.status = 'APPROVED' and g.revoked_at is null
                                 and g.valid_from <= clock_timestamp() and (g.valid_to is null or g.valid_to > clock_timestamp())), '[]'::jsonb))
    from tab.session_binding b
    join iam.session s on s.id = b.session_id
    join iam.device d on d.id = s.device_id
    join iam.person p on p.id = s.person_id
    join iam.account a on a.id = s.account_id
    cross join lateral (select tab.session_role_withdrawn(s.id, b.role_code) as withdrawn) w
   where b.token_hash = p_token_hash and b.unbound_at is null
$$;

-- DI-16, DI-38 (F36): ends the session bound to p_token_hash if its role is withdrawn (kernel end reason
-- ADMIN_TERMINATED) and unbinds its cookie token. True when it ended it; false when the role is still held, or the
-- token is unknown or unbound.
create function tab.end_withdrawn_session(p_token_hash text) returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  b tab.session_binding;
begin
  select * into b from tab.session_binding where token_hash = p_token_hash and unbound_at is null for update;
  if not found or not tab.session_role_withdrawn(b.session_id, b.role_code) then
    return false;
  end if;
  update tab.session_binding set unbound_at = clock_timestamp() where token_hash = p_token_hash;
  perform iam.end_session_internal(b.session_id, 'ADMIN_TERMINATED');
  return true;
end
$$;

-- The session bound to p_token_hash, for an extension or an unlock: refused when the token is unbound (EBMR-TAB-014) or
-- the session's role is withdrawn (EBMR-TAB-017).
create function tab.session_to_extend(p_token_hash text) returns uuid
language plpgsql stable security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
declare
  b tab.session_binding;
begin
  select * into b from tab.session_binding where token_hash = p_token_hash and unbound_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'No session is bound to this cookie. [EBMR-TAB-014]';
  end if;
  if tab.session_role_withdrawn(b.session_id, b.role_code) then
    raise exception using errcode = 'P0001', message = format(
      'The role %s this session works in is no longer granted to the account; the session cannot be kept open or unlocked. [EBMR-TAB-017]',
      coalesce(b.role_code, '(none chosen; the account holds no role)'));
  end if;
  return b.session_id;
end
$$;

-- DI-38 (F36): iam.keep_session_alive for the session bound to p_token_hash, whose role must still be granted.
create function tab.keep_session_alive(p_token_hash text, p_auth_event uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
begin
  perform iam.keep_session_alive(tab.session_to_extend(p_token_hash), p_auth_event);
end
$$;

-- DI-38 (F36): iam.unlock_session for the session bound to p_token_hash, whose role must still be granted.
create function tab.unlock_session(p_token_hash text, p_auth_event uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
begin
  perform iam.unlock_session(tab.session_to_extend(p_token_hash), p_auth_event);
end
$$;

revoke all on function tab.session_role_withdrawn(uuid, text), tab.end_withdrawn_session(text), tab.session_to_extend(text),
                       tab.keep_session_alive(text, uuid), tab.unlock_session(text, uuid) from public;
grant execute on function tab.end_withdrawn_session(text), tab.keep_session_alive(text, uuid), tab.unlock_session(text, uuid) to ebmr_app;

-- The application extends and unlocks a session only through the functions above.
revoke execute on function iam.keep_session_alive(uuid, uuid), iam.unlock_session(uuid, uuid) from ebmr_app;

reset role;
