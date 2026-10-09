-- Sandbox, segregation invariant query: a GMP login role the cluster does not have is passed over in a sandbox, as the
-- query meant, instead of making the whole query fail (SQL mutation run, group connection-roles; controls DI-05, DI-17;
-- invariant INV-18; ADR 0012 item 8).
--
-- Why. In a sandbox database sandbox.segregation_problems() (0820, 0980) lists the GMP login roles able to connect:
--   select x.rolname from unnest(array['ebmr_app', 'ebmr_authn', 'ebmr_listener']) x(rolname)
--    where exists (select 1 from pg_catalog.pg_roles where rolname = x.rolname)
--      and has_database_privilege(x.rolname, v_db, 'CONNECT')
-- The EXISTS was there to pass over a role the cluster does not have, but SQL does not evaluate the conditions of a
-- WHERE clause in the order written: PostgreSQL 16 turns the EXISTS into a join with pg_authid and evaluates the cheap
-- has_database_privilege() first, as a filter on the role names (checked with EXPLAIN on PostgreSQL 16 before this
-- migration). A missing GMP role therefore made the invariant query fail with 'role "..." does not exist' (42704)
-- instead of answering: in a sandbox without ebmr_listener it never said 'the listener role ebmr_listener does not
-- exist', and provisioning reported that error rather than the problem. The rows also came out in the join's order,
-- not the list's.
--
-- Now the roles are read from pg_roles and the privilege is asked by the role's oid, so only roles that exist are asked
-- about, and the rows are ordered by role name. Nothing else changes: same signature, language, volatility, owner
-- (ebmr_owner), search_path, not SECURITY DEFINER, EXECUTE for ebmr_app (CREATE OR REPLACE keeps the privileges).
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- The invariant query (ADR 0012 item 8): as 0980, with the GMP roles that can connect to a sandbox taken from pg_roles.
create or replace function sandbox.segregation_problems() returns setof text
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  v_kind text;
  v_db text := pg_catalog.current_database();
  r record;
begin
  begin
    v_kind := kernel.installation_kind();
  exception when raise_exception then
    return next format('installation marker: %s', sqlerrm);
    return;
  end;

  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_sandbox') then
    return next 'the sandbox role ebmr_sandbox does not exist';
    return;
  end if;
  for r in select rolname from pg_catalog.pg_roles
            where rolname = 'ebmr_sandbox' and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit) loop
    return next 'ebmr_sandbox has an elevated role attribute (superuser, createdb, createrole, replication, bypassrls or inherit)';
  end loop;
  for r in select g.rolname from pg_catalog.pg_auth_members m
             join pg_catalog.pg_roles g on g.oid = m.roleid
             join pg_catalog.pg_roles s on s.oid = m.member
            where s.rolname = 'ebmr_sandbox' order by 1 loop
    return next format('ebmr_sandbox is a member of role %s', r.rolname);
  end loop;

  -- 0980: the listener roles.
  for r in select x.rolname from unnest(array['ebmr_listener', 'ebmr_sandbox_listener']) x(rolname)
            where not exists (select 1 from pg_catalog.pg_roles p where p.rolname = x.rolname) order by 1 loop
    return next format('the listener role %s does not exist', r.rolname);
  end loop;
  for r in select rolname from pg_catalog.pg_roles
            where rolname in ('ebmr_listener', 'ebmr_sandbox_listener')
              and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit) order by 1 loop
    return next format('%s has an elevated role attribute (superuser, createdb, createrole, replication, bypassrls or inherit)', r.rolname);
  end loop;
  for r in select s.rolname as member, g.rolname as of_role from pg_catalog.pg_auth_members m
             join pg_catalog.pg_roles g on g.oid = m.roleid
             join pg_catalog.pg_roles s on s.oid = m.member
            where (s.rolname in ('ebmr_listener', 'ebmr_sandbox_listener') and g.rolname <> 'pg_use_reserved_connections')
               or g.rolname in ('ebmr_listener', 'ebmr_sandbox_listener')
            order by 1, 2 loop
    return next format('%s is a member of role %s', r.member, r.of_role);
  end loop;

  if v_kind = 'GMP' then
    if has_database_privilege('ebmr_sandbox', v_db, 'CONNECT') then
      return next format('ebmr_sandbox can connect to the GMP database %s', v_db);
    end if;
    for r in select * from sandbox.direct_privileges('ebmr_sandbox') order by 1, 2, 3, 4 loop
      return next format('ebmr_sandbox holds %s on %s %s%s in a GMP database', r.privilege, lower(r.object_kind), r.object_name,
                         coalesce(' (' || r.column_name || ')', ''));
    end loop;
    for r in select d.defaclnamespace::regnamespace::text as ns from pg_catalog.pg_default_acl d
               cross join lateral pg_catalog.aclexplode(d.defaclacl) a
              where a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'ebmr_sandbox') loop
      return next format('a default privilege grants to ebmr_sandbox (schema %s) in a GMP database', r.ns);
    end loop;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_sandbox_listener') then
      if has_database_privilege('ebmr_sandbox_listener', v_db, 'CONNECT') then
        return next format('ebmr_sandbox_listener can connect to the GMP database %s', v_db);
      end if;
      for r in select * from sandbox.direct_privileges('ebmr_sandbox_listener') order by 1, 2, 3, 4 loop
        return next format('ebmr_sandbox_listener holds %s on %s %s%s in a GMP database', r.privilege, lower(r.object_kind), r.object_name,
                           coalesce(' (' || r.column_name || ')', ''));
      end loop;
      for r in select d.defaclnamespace::regnamespace::text as ns from pg_catalog.pg_default_acl d
                 cross join lateral pg_catalog.aclexplode(d.defaclacl) a
                where a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'ebmr_sandbox_listener') loop
        return next format('a default privilege grants to ebmr_sandbox_listener (schema %s) in a GMP database', r.ns);
      end loop;
    end if;
  else
    -- 1100: only roles the cluster has, asked about by oid (has_database_privilege by name fails for a missing role).
    for r in select p.rolname from pg_catalog.pg_roles p
              where p.rolname in ('ebmr_app', 'ebmr_authn', 'ebmr_listener')
                and has_database_privilege(p.oid, v_db, 'CONNECT')
              order by 1 loop
      return next format('the GMP role %s can connect to the sandbox database %s', r.rolname, v_db);
    end loop;
    if exists (select 1 from pg_catalog.pg_database d cross join lateral pg_catalog.aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
                where d.datname = v_db and a.grantee = 0 and a.privilege_type = 'CONNECT') then
      return next format('PUBLIC can connect to the sandbox database %s', v_db);
    end if;
    for r in select * from sandbox.mirror_differences() order by 1, 2, 3, 4, 5 loop
      return next format('ebmr_sandbox %s %s on %s %s%s', case r.direction when 'GRANT' then 'lacks' else 'holds beyond the application roles' end,
                         r.privilege, lower(r.object_kind), r.object_name, coalesce(' (' || r.column_name || ')', ''));
    end loop;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_sandbox_listener')
       and exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_listener') then
      for r in select * from sandbox.role_mirror_differences('ebmr_sandbox_listener', array['ebmr_listener']::name[]) order by 1, 2, 3, 4, 5 loop
        return next format('ebmr_sandbox_listener %s %s on %s %s%s', case r.direction when 'GRANT' then 'lacks' else 'holds beyond the listener role' end,
                           r.privilege, lower(r.object_kind), r.object_name, coalesce(' (' || r.column_name || ')', ''));
      end loop;
    end if;
  end if;
end
$$;

reset role;
