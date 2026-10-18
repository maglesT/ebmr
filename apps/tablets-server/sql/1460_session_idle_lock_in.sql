-- Phase 7 slice 7d, accessibility audit finding A11Y-1 (outline 7.4; WCAG 2.2 success criterion 2.2.1; DI-14, DI-38):
-- the screens warn before the inactivity lock and before the session's absolute end.
--
-- Handbook: modules/tablets-server.md
--
-- What was wrong. The kernel locks a session once its idle time has passed since its last command, and ends it at its
-- absolute lifetime, but nothing told the page when either would happen: the page learnt of the lock from its 15-second
-- session poll, after the fact, and a person reading a screen or filling a long form lost the moment with no warning and
-- no chance to stay (outline 7.4 asks for a warning before the inactivity lock, extended with a tap on a personal device
-- and a badge tap on a shared one; the server's keep-alive existed, the page never offered it).
--
-- Now tab.resolve_session (CREATE OR REPLACE, otherwise as tablets 0550) also answers, by the database's own clock:
--   idle_lock_in_seconds  whole seconds (rounded up) until iam.session_state turns IDLE_LOCKED, for an ACTIVE session
--                         (last activity + the session's idle timeout); null when the session is not ACTIVE;
--   ends_in_seconds       whole seconds (rounded up) until the absolute timeout (opened + the absolute timeout); null once
--                         the session is ENDED or EXPIRED.
-- Both are read-only facts for the page's warning: the lock and the end are still decided by iam.session_state alone,
-- and a keep-alive still goes through tab.keep_session_alive (a badge tap on the shop floor).
--
-- The function is SECURITY DEFINER, owned by ebmr_owner, keeps 0001's grant and pins its search_path with pg_temp last.
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- DI-14, DI-38 (A11Y-1): everything a request needs about its session, how long until it locks or ends included.
create or replace function tab.resolve_session(p_token_hash text) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
  select jsonb_build_object(
           'session_id', s.id, 'person_id', s.person_id, 'account_id', s.account_id, 'device_id', s.device_id,
           'device_code', d.code, 'device_class', s.device_class, 'site_code', s.site_code, 'room_code', s.room_code,
           'line_code', d.line_code, 'device_fingerprint', d.key_fingerprint,
           'role_code', case when w.withdrawn then null else b.role_code end,
           'declared_role', b.role_code,
           'state', case when w.withdrawn and st.state in ('ACTIVE', 'LOCKED', 'IDLE_LOCKED') then 'ROLE_WITHDRAWN'
                         else st.state end,
           'legal_name', p.legal_name, 'login_name', a.login_name, 'idle_timeout_seconds', s.idle_timeout_seconds,
           'idle_lock_in_seconds',
             case when st.state = 'ACTIVE' and not w.withdrawn and act.last_activity_at is not null
                  then greatest(0, ceil(extract(epoch from act.last_activity_at + make_interval(secs => s.idle_timeout_seconds) - st.at)))::integer end,
           'ends_in_seconds',
             case when st.state in ('ACTIVE', 'LOCKED', 'IDLE_LOCKED')
                  then greatest(0, ceil(extract(epoch from s.opened_at + make_interval(secs => s.absolute_timeout_seconds) - st.at)))::integer end,
           'roles', coalesce((select jsonb_agg(distinct g.role_code order by g.role_code) from iam.role_grant g
                               where g.account_id = s.account_id and g.status = 'APPROVED' and g.revoked_at is null
                                 and g.valid_from <= clock_timestamp() and (g.valid_to is null or g.valid_to > clock_timestamp())), '[]'::jsonb))
    from tab.session_binding b
    join iam.session s on s.id = b.session_id
    join iam.device d on d.id = s.device_id
    join iam.person p on p.id = s.person_id
    join iam.account a on a.id = s.account_id
    left join iam.session_activity act on act.session_id = s.id
    cross join lateral (select clock_timestamp() as at) now_
    cross join lateral (select iam.session_state(s.id, now_.at) as state, now_.at) st
    cross join lateral (select tab.session_role_withdrawn(s.id, b.role_code) as withdrawn) w
   where b.token_hash = p_token_hash and b.unbound_at is null
$$;

reset role;
