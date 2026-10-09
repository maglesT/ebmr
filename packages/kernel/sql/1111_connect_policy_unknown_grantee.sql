-- Sandbox and installation hardening: the connect policy refuses, with a coded reason and before it applies anything,
-- a backend-signal grant to a role the cluster does not know (Phase 2 exit, SQL mutation kill work, group
-- connection-roles, defect D15; controls DI-17, DI-30; ADR 0012).
--
-- Why. sandbox.apply_connect_policy() (0800, 0970, 0980) takes EXECUTE on pg_catalog.pg_cancel_backend and
-- pg_catalog.pg_terminate_backend away from PUBLIC and from every role that is not a superuser. It names each grantee by
-- joining the function's privileges (aclexplode) to pg_roles. An entry whose grantee oid names no role (PostgreSQL
-- removes a role's entries when the role is dropped, so only a direct write into pg_proc by a superuser leaves one)
-- gave a NULL name, format() turned it into nothing, and the policy ran 'revoke execute on function ... from ' and
-- failed with a syntax error (42601). That failed closed (the statement rolled back, kernel.backend_signals_restricted()
-- still answered false, the tablets gate kept refusing hand-keyed weights), but the operator was told nothing of why.
-- Found by the kill agent of the connection-roles group; its kill test asserted only that the policy does not
-- complete and changes nothing.
--
-- Now the policy first looks for such entries and, when there is one, refuses (EBMR-SBX-038) naming each function and
-- each unknown grantee oid, before it revokes or grants anything. No REVOKE can name an oid that is no role, so the
-- entry can only be removed the way it was made (a superuser's write into pg_proc.proacl); then the policy is applied
-- again. kernel.backend_signals_restricted() is unchanged: it counts such a grant as one that may signal, so the
-- installation is reported as not holding the policy.
--
-- The other statements the kernel builds from role names were checked for the same fault: the rest of this policy and
-- sandbox.mirror_application_privileges() name fixed roles or rows read by role name, never a grantee read from a
-- catalogue, and sandbox.segregation_problems() reads roles from the catalogue since kernel 1100.
--
-- Same signature, language, owner (ebmr_owner) and search_path as 0980; still not SECURITY DEFINER and executable by no
-- one but its owner and superusers (CREATE OR REPLACE keeps the privileges). Applied as a new migration because applied
-- migrations are checksummed and never edited.

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
    execute format('grant connect on database %I to ebmr_sandbox, ebmr_sandbox_listener', v_db);
  else
    execute format('revoke all on database %I from ebmr_sandbox, ebmr_sandbox_listener', v_db);
    execute format('grant connect on database %I to ebmr_app, ebmr_authn, ebmr_listener', v_db);
  end if;
end
$$;

reset role;
