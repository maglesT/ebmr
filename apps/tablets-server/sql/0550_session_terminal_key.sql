-- Tablets edition, module C0: a request's session names the key of the terminal it was opened on, so the server can
-- refuse a session that is not the one the page holds (Phase 2 exit follow-up F41, round 4, the residuals of the
-- duplicated cookie; DI-13, DI-14, DI-38; decision F41.1, docs/decisions/phase-2-open-questions.md; ADR 0017 item 4).
--
-- Cookies ignore ports, so a page on another port of the host can set this installation's session cookie. Tablets'
-- server refuses a request that carries the cookie twice (F41), but when the browser holds no session cookie of this
-- installation a page on another port can set one at Path=/, the value of another person's live session (an insider's
-- own, copied from their own browser), and the person's page then worked in that session. Now the page names the key
-- of its own terminal (the fingerprint of the public key it signs device proofs with, X-Ebmr-Terminal-Key) and the
-- person its session started with (X-Ebmr-Page-Person) on every request, and the server serves as nobody a session
-- opened on another terminal (SESSION_OTHER_TERMINAL) or of another person (SESSION_CHANGED). This check is the
-- server's, as are the Origin, CSRF and duplicated-cookie checks: the database never sees the page. The database
-- supplies the fact it rests on: tab.resolve_session (CREATE OR REPLACE, otherwise as tablets 0400) also answers
-- device_fingerprint, the key fingerprint of the terminal the session was opened on (iam.device.key_fingerprint, the
-- SHA-256 of the key's SPKI, as the kernel registers it).
--
-- The function is SECURITY DEFINER, owned by ebmr_owner, keeps 0001's grant and pins its search_path with pg_temp last.
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-13, DI-14, DI-38 (F41): everything a request needs about its session, the key of its terminal included.
create or replace function tab.resolve_session(p_token_hash text) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
  select jsonb_build_object(
           'session_id', s.id, 'person_id', s.person_id, 'account_id', s.account_id, 'device_id', s.device_id,
           'device_code', d.code, 'device_class', s.device_class, 'site_code', s.site_code, 'room_code', s.room_code,
           'line_code', d.line_code, 'device_fingerprint', d.key_fingerprint,
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

reset role;
