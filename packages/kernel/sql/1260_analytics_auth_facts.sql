-- Phase 6A slice 6A-4: the authentication facts the audit-trail methods read (decision 0016 item 8; draft controls
-- DI-53, DI-51; interfaces slice-6A-0-interfaces.md section 3; D-6A-0-1, D-6A-4-1, D-6A-4-2).
--
-- Handbook: modules/analytics.md
--
-- report.auth_fact_v1: one row per authentication event of a human account in the last 26 weeks (182 days):
--   LOGIN    a successful login (iam.auth_event, purpose LOGIN);
--   FAILED   a failed login or session unlock (iam.authn_attempt, outcome FAILURE, for a known account);
--   LOCKOUT  an account locked (iam.account_lock_event LOCKED).
-- Columns: event_ref (auth_event:<id>, authn_attempt:<id> or account_lock_event:<id>), account_id, person_id, terminal
-- (the device code; null for a lockout), kind, at, at_local (the instant on the site's wall clock, YYYY-MM-DDTHH:MI:SS,
-- so the methods need no time-zone table), read_at and data_as_of. No secret, hash, credential or reason text is exported.
--
-- The view is built as the other report views are (kernel 1210, recipe-core 1070, 1115): it selects from its STABLE
-- SECURITY DEFINER row function report.auth_fact_rows_v1(), so its reader needs no right on the iam tables. It is on the
-- analytics role's allow-list only (analytics.register_input): it describes persons, so it is not in the report
-- catalogue, the reporting role and the dashboards' export do not read it, and the application role has no right on
-- it (D-6A-4-2). It writes nothing and decides nothing; it does not read the analytics schema (DI-51).

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (kernel migration 1260_analytics_auth_facts)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the analytics input view of authentication facts for the audit-trail methods (DI-53)'));

create function report.auth_fact_rows_v1()
returns table (event_ref text, account_id uuid, person_id uuid, terminal text, kind text, at timestamptz, at_local text,
               read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, iam, report, pg_temp as $$
  with z as (select coalesce(kernel.site_zone(), 'UTC') as zone, pg_catalog.statement_timestamp() - interval '182 days' as since),
  ev as (
    select 'auth_event:' || a.id::text as event_ref, a.account_id, a.person_id, d.code as terminal, 'LOGIN' as kind, a.recorded_at as at
      from iam.auth_event a
      join iam.account c on c.id = a.account_id and c.kind = 'HUMAN'
      left join iam.device d on d.id = a.device_id
     where a.purpose = 'LOGIN' and a.recorded_at >= (select since from z)
    union all
    select 'authn_attempt:' || t.id::text, t.account_id, c.person_id, d.code, 'FAILED', t.attempted_at
      from iam.authn_attempt t
      join iam.account c on c.id = t.account_id and c.kind = 'HUMAN'
      left join iam.device d on d.id = t.device_id
     where t.outcome = 'FAILURE' and t.purpose in ('LOGIN', 'SESSION_UNLOCK') and t.attempted_at >= (select since from z)
    union all
    select 'account_lock_event:' || l.id::text, l.account_id, c.person_id, null, 'LOCKOUT', l.recorded_at
      from iam.account_lock_event l
      join iam.account c on c.id = l.account_id and c.kind = 'HUMAN'
     where l.event = 'LOCKED' and l.recorded_at >= (select since from z))
  select ev.event_ref, ev.account_id, ev.person_id, ev.terminal, ev.kind, ev.at,
         pg_catalog.to_char(ev.at at time zone (select zone from z), 'YYYY-MM-DD"T"HH24:MI:SS'),
         pg_catalog.statement_timestamp(), report.data_as_of()
    from ev
   order by ev.at, ev.event_ref
$$;
revoke all on function report.auth_fact_rows_v1() from public;

create view report.auth_fact_v1 as select * from report.auth_fact_rows_v1();
revoke all on report.auth_fact_v1 from public;

select analytics.register_input('VIEW', 'report.auth_fact_v1', 1, '6A-4', 'authentication event (26 weeks)',
  'Logins, failed logins and lockouts of human accounts with terminal, instant and site wall-clock time (no secrets)');

select kernel.set_actor_context(null);

reset role;
