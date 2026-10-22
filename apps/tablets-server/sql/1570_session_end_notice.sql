-- Tablets: why a session ended, for the page that held it (Phase 7 slice 7k; requirement R3.11 of the hosted-demo trials).
--
-- Handbook: modules/tablets-server.md
--
-- A kiosk whose person signed in on another kiosk went back to "Tap your badge" without a word: kernel 0160 ends a
-- person's open shop-floor session (SUPERSEDED) when they open another, and the page only learnt that it had none. The
-- server now answers the page's next request with why (NO_SESSION with the reason), read here for the token the page
-- still holds:
--
--   tab.session_end_notice(token)  for a bound session that has ended: the end reason (kernel 0160's), the person's
--                                  legal name and, when it was SUPERSEDED, the terminal code of the session that replaced
--                                  it (the person's first shop-floor session opened at or after the end); null for an
--                                  unknown token or a session still open
--
-- It names only the session's own person and the terminal they moved to: what anyone at the old terminal could see on
-- its identity banner a moment before. No GMP record is read or written.

set local role ebmr_owner;

create function tab.session_end_notice(p_token_hash text) returns jsonb
language sql stable security definer set search_path = pg_catalog, tab, iam, pg_temp as $$
  select jsonb_build_object(
           'reason', s.end_reason,
           'legal_name', p.legal_name,
           'terminal', case when s.end_reason = 'SUPERSEDED' then
             (select d.code from iam.session n join iam.device d on d.id = n.device_id
               where n.person_id = s.person_id and n.id <> s.id and n.shop_floor and n.opened_at >= s.ended_at
               order by n.opened_at limit 1) end)
    from tab.session_binding b
    join iam.session s on s.id = b.session_id
    join iam.person p on p.id = s.person_id
   where b.token_hash = p_token_hash and s.ended_at is not null
   limit 1
$$;
revoke all on function tab.session_end_notice(text) from public;
grant execute on function tab.session_end_notice(text) to ebmr_app;

reset role;
