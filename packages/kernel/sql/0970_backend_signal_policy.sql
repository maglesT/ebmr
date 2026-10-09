-- Kernel, installation hardening: no connection but a superuser's may cancel or end the work of another connection
-- (review finding P50, round-4 verification; controls DI-17, DI-30, PR-20; ADR 0012).
--
-- PostgreSQL lets every role run pg_cancel_backend and pg_terminate_backend on the backends of its own role, and both
-- functions are executable by PUBLIC out of the box. Every process of an installation that logs in with the same role
-- (the server's application pool, the gateway listener, the gateway API monitor, the sweeper, and on the sandbox the
-- authentication service too) could therefore be interrupted by anyone who holds that role's credentials. The tablets
-- edition showed the effect: a holder of the application role's credentials cancelled the gateway listener's
-- heartbeat queries, a working scale read OFFLINE for want of heartbeats, and a hand-keyed weighing was accepted
-- beside it. Stopping another session's work is the job of the database's operator (a superuser); no application
-- process needs it.
--
-- From this migration on:
--   * sandbox.apply_connect_policy() (0800), the database-level policy that provisioning, the test harness and the
--     restore procedure apply to a new copy or a restore, also takes EXECUTE on every pg_catalog.pg_cancel_backend and
--     pg_catalog.pg_terminate_backend away from PUBLIC and from every role that is not a superuser. Function
--     privileges live in the database's own catalogue, so a copy made with CREATE DATABASE ... TEMPLATE keeps them;
--     applying the policy again changes nothing there and repairs a restore that lost them. PostgreSQL only warns
--     when a role that may not revoke them (not a superuser) runs it, so nothing relies on the revoke having run:
--   * kernel.backend_signals_restricted() answers whether the installation holds the policy now: in this database no
--     role but a superuser may execute either function (PUBLIC included), and no login role that is not a superuser
--     is a member of pg_signal_backend (a cluster-wide membership, which the policy reports but cannot change).
--     Database code that decides on the absence of a report (the tablets manual-weighing gate, tablets 0350) refuses
--     to act on it while this answers false.
--   * This migration applies the policy and fails if it did not take effect (a migration is run by a superuser).
--
-- Privileges: apply_connect_policy keeps its owner (ebmr_owner), search_path and privileges (executable by no one
-- but its owner and superusers; the invoker's rights apply). kernel.backend_signals_restricted() is owned by
-- ebmr_owner, not SECURITY DEFINER (it reads catalogues every role can read), pg_temp last, and granted to nobody.

set local role ebmr_owner;

-- The database-level policy (0800), with the backend signals added first. Same signature, language, owner and
-- search_path as 0800; still not SECURITY DEFINER.
create or replace function sandbox.apply_connect_policy() returns void
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  v_db text := pg_catalog.current_database();
  g    record;
begin
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
    execute format('revoke all on database %I from ebmr_app, ebmr_authn', v_db);
    execute format('grant connect on database %I to ebmr_sandbox', v_db);
  else
    execute format('revoke all on database %I from ebmr_sandbox', v_db);
    execute format('grant connect on database %I to ebmr_app, ebmr_authn', v_db);
  end if;
end
$$;

-- True while no connection but a superuser's can cancel or end another backend's work in this database: neither
-- PUBLIC nor any role that is not a superuser may execute pg_cancel_backend or pg_terminate_backend here, and no login
-- role that is not a superuser is a member of pg_signal_backend.
create function kernel.backend_signals_restricted() returns boolean
language sql stable set search_path = pg_catalog, pg_temp as $$
  select not exists (
           select 1
             from pg_catalog.pg_proc p
             cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
             left join pg_catalog.pg_roles r on r.oid = a.grantee
            where p.pronamespace = 'pg_catalog'::pg_catalog.regnamespace
              and p.proname in ('pg_cancel_backend', 'pg_terminate_backend')
              and a.privilege_type = 'EXECUTE'
              and (a.grantee = 0 or not coalesce(r.rolsuper, false)))
     and not exists (
           select 1 from pg_catalog.pg_roles r
            where r.rolcanlogin and not r.rolsuper
              and pg_catalog.pg_has_role(r.oid, 'pg_signal_backend', 'MEMBER'))
$$;

revoke all on function kernel.backend_signals_restricted() from public;

reset role;

select sandbox.apply_connect_policy();

do $$
begin
  if not kernel.backend_signals_restricted() then
    raise exception using errcode = 'P0001',
      message = 'Roles other than superusers can still cancel or end other connections (pg_cancel_backend, pg_terminate_backend, pg_signal_backend): run this migration as a superuser and take pg_signal_backend from every login role that is not one (DI-17, DI-30). [EBMR-SBX-035]';
  end if;
end
$$;
