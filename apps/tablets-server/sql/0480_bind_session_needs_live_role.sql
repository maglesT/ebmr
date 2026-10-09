-- Tablets edition, module C0: a session whose account holds no role that is valid now is never bound to a browser
-- cookie (Phase 2 exit review F10; DI-16, DI-38; ADR 0012: the rule holds when the application's own database
-- credentials are used directly).
--
-- tab.bind_session (0001) checked a role only when the server named one: a login of an account with no APPROVED,
-- unrevoked grant inside valid_from and valid_to (a new user whose grant still waits for approval, a user whose grants
-- expired or were revoked) was bound with no role, and the web showed "Choose the role you are working in" with nothing
-- to choose. The server refuses such a login (403 NO_ROLE, F36), and tablets 0400 ends such a session at its next
-- request (ROLE_WITHDRAWN); the binding itself still let it through.
--
-- Now tab.bind_session (CREATE OR REPLACE, same checks in the same order) also refuses, when no role is named, a session
-- whose account holds no live grant at all (tab.session_role_withdrawn of 0400): EBMR-TAB-021. The server's NO_ROLE
-- refusal comes first and says who can help; this is the database's own floor under it.
--
-- The function is SECURITY DEFINER, owned by ebmr_owner, keeps 0001's grant and pins its search_path with pg_temp last.
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-16, DI-38 (F10): bind a kernel session opened in the last 10 seconds to a cookie token, once; a person's session
-- on a terminal only; the role named must be granted now, and with no role named the account must hold one.
create or replace function tab.bind_session(p_session uuid, p_token_hash text, p_role text) returns void
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
  -- F10: an account that holds no role now opens no browser session (a grant waiting for approval, expired or revoked).
  if p_role is null and tab.session_role_withdrawn(p_session, null) then
    raise exception using errcode = 'P0001',
      message = 'The account holds no role that is valid now, so no session is opened for it; the system administrator handles role grants. [EBMR-TAB-021]';
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

reset role;
