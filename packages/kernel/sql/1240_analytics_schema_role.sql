-- Phase 6A slice 6A-0: the analytics schema and the analytics role (ADR 0020 points 3 and 4; decisions 0015, 0023;
-- draft control DI-51; interfaces slice-6A-0-interfaces.md section 2; D-6A-4).
--
-- Handbook: modules/analytics.md
--
-- Why. Analytics reads GMP data and writes its own advisory outputs, but must never write GMP data (decision 0015 items
-- 1 and 2; draft DI-51). It gets a login role of its own, never ebmr_report (which must stay unable to write anything):
--   ebmr_analytics  LOGIN, NOINHERIT, member of nothing, CONNECTION LIMIT 4 (development password here; production a
--                   vault credential). CONNECT on GMP databases only; USAGE on schemas report and analytics; SELECT on
--                   the report views listed in analytics.input_catalog_v1 (and on that catalogue); EXECUTE on the row
--                   functions behind those views, on the parameterised inputs listed there, and on the six runner
--                   functions of kernel 1242 (begin_run, record_output, record_flag, finish_run, fail_run,
--                   effective_methods). Nothing else: no GMP table, no command, no default privilege.
--   schema analytics owned by ebmr_owner (non-GMP, insert-only and audited; kernel 1241); USAGE to ebmr_app (the
--                   screens read the analytics.*_v1 views only) and ebmr_analytics.
--
-- sandbox.apply_connect_policy() (latest 1210) grants ebmr_analytics CONNECT on a GMP database and takes it away in a
-- sandbox (the sandbox and training mode run no analytics; D-6A-6). sandbox.segregation_problems() (latest 1210)
-- reports, in a GMP database, everything analytics.role_problems() (kernel 1242) finds: the role missing, elevated, a
-- member of a role (or with members), a privilege beyond the list above, a default privilege to it, and a volatile
-- function it could execute other than the five runner writers; in a sandbox, that it can connect. Both are replaced
-- whole from their latest definitions (apply_connect_policy here, segregation_problems in kernel 1242, after the
-- function it calls); only the lines marked 1240 are new. Messages EBMR-ANA-001 and up (kernel 1242).

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_analytics') then
    begin
      -- Development password; production sets a vault-held credential.
      create role ebmr_analytics login password 'ebmr_analytics' connection limit 4
        noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    exception when duplicate_object or unique_violation then
      null; -- created concurrently by another migration run on the same cluster
    end;
  end if;
end
$$;

create schema if not exists analytics authorization ebmr_owner;
revoke all on schema analytics from public;
grant usage on schema analytics to ebmr_app, ebmr_analytics;
-- The runner reads the report views it is given (kernel 1242 analytics.register_input), never the schemas behind them.
grant usage on schema report to ebmr_analytics;

set local role ebmr_owner;

create or replace function sandbox.apply_connect_policy() returns void
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  v_db      text := pg_catalog.current_database();
  v_unknown text;
  g         record;
begin
  -- 1111: a grant to a role the cluster does not know cannot be revoked by name; refuse before anything is applied.
  select string_agg(format('EXECUTE on %s is granted to role oid %s', u.fn, u.grantee), ', ' order by u.fn, u.grantee)
    into v_unknown
    from (select distinct p.oid::pg_catalog.regprocedure::text as fn, a.grantee
            from pg_catalog.pg_proc p
            cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
           where p.pronamespace = 'pg_catalog'::pg_catalog.regnamespace
             and p.proname in ('pg_cancel_backend', 'pg_terminate_backend')
             and a.privilege_type = 'EXECUTE'
             and a.grantee <> 0
             and not exists (select 1 from pg_catalog.pg_roles r where r.oid = a.grantee)) u;
  if v_unknown is not null then
    raise exception using errcode = 'P0001',
      message = format('Backend signals cannot be taken away from a role the cluster does not know: %s (an entry written into the catalogue directly, which no REVOKE can name). Nothing was applied: a superuser removes those entries from the functions'' privileges and applies the policy again (DI-17, DI-30). [EBMR-SBX-038]',
                       v_unknown);
  end if;

  -- 0970: no role but a superuser cancels or ends another backend's work (every overload of both functions).
  for g in
    select distinct p.oid::pg_catalog.regprocedure::text as fn,
           case when a.grantee = 0 then 'public' else pg_catalog.quote_ident(r.rolname) end as grantee
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      left join pg_catalog.pg_roles r on r.oid = a.grantee
     where p.pronamespace = 'pg_catalog'::pg_catalog.regnamespace
       and p.proname in ('pg_cancel_backend', 'pg_terminate_backend')
       and a.privilege_type = 'EXECUTE'
       and (a.grantee = 0 or not coalesce(r.rolsuper, false))
  loop
    execute format('revoke execute on function %s from %s', g.fn, g.grantee);
  end loop;
  execute format('revoke connect, temporary on database %I from public', v_db);
  if kernel.installation_kind() = 'SANDBOX' then
    execute format('revoke all on database %I from ebmr_app, ebmr_authn, ebmr_listener', v_db);
    -- 1210: the reporting role never opens a sandbox.
    execute format('revoke all on database %I from ebmr_report', v_db);
    -- 1240: nor does the analytics role (the sandbox and training mode run no analytics; D-6A-6).
    execute format('revoke all on database %I from ebmr_analytics', v_db);
    execute format('grant connect on database %I to ebmr_sandbox, ebmr_sandbox_listener', v_db);
  else
    execute format('revoke all on database %I from ebmr_sandbox, ebmr_sandbox_listener', v_db);
    execute format('grant connect on database %I to ebmr_app, ebmr_authn, ebmr_listener', v_db);
    -- 1210: the reporting role connects to GMP databases (and reads only the report views).
    execute format('revoke all on database %I from ebmr_report', v_db);
    execute format('grant connect on database %I to ebmr_report', v_db);
    -- 1240: the analytics role connects to GMP databases (and reads only its catalogued inputs).
    execute format('revoke all on database %I from ebmr_analytics', v_db);
    execute format('grant connect on database %I to ebmr_analytics', v_db);
  end if;
end
$$;

reset role;
