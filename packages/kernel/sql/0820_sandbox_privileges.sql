-- Sandbox, training and simulation store (module A4), part 3: the sandbox role's object privileges and
-- the segregation invariant query (ADR 0012 items 1 and 8; control DI-05; invariant INV-18).
--
-- A sandbox database runs the same kernel, site-services and recipe migrations as a GMP database, and
-- those migrations grant object privileges to the GMP roles ebmr_app and ebmr_authn. Roles are
-- cluster-wide, so the sandbox role is never made a member of them (that would carry their grants into
-- every GMP database). Instead, inside a sandbox database only, sandbox.mirror_application_privileges()
-- gives ebmr_sandbox exactly the object privileges the two GMP roles hold there, and takes away any it
-- holds beyond them. The provisioning tool runs it after every migration run (src/sandbox/provision.ts).
--
-- sandbox.segregation_problems() is the invariant query: it must return no rows. In a GMP database it
-- reports any way for the sandbox role in (CONNECT, an object privilege, a role membership or an
-- elevated role attribute); in a sandbox database it reports GMP roles that can connect and privileges
-- that differ from the mirror.

set local role ebmr_owner;

-- Object privileges a role holds directly (not through PUBLIC), with the statement text that grants
-- each one. Covers schemas, tables, views, sequences, columns, routines and types.
create function sandbox.direct_privileges(p_role name)
returns table (object_kind text, object_name text, column_name text, privilege text)
language sql stable set search_path = pg_catalog, pg_temp as $$
  with r as (select oid from pg_catalog.pg_roles where rolname = p_role)
  select 'SCHEMA', quote_ident(n.nspname), null::text, a.privilege_type
    from pg_catalog.pg_namespace n cross join lateral pg_catalog.aclexplode(n.nspacl) a
   where a.grantee = (select oid from r)
  union
  select case when c.relkind = 'S' then 'SEQUENCE' else 'TABLE' end, c.oid::regclass::text, null, a.privilege_type
    from pg_catalog.pg_class c cross join lateral pg_catalog.aclexplode(c.relacl) a
   where a.grantee = (select oid from r)
  union
  select 'COLUMN', c.oid::regclass::text, quote_ident(att.attname), a.privilege_type
    from pg_catalog.pg_attribute att
    join pg_catalog.pg_class c on c.oid = att.attrelid
    cross join lateral pg_catalog.aclexplode(att.attacl) a
   where a.grantee = (select oid from r) and not att.attisdropped
  union
  select 'ROUTINE', p.oid::regprocedure::text, null, a.privilege_type
    from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(p.proacl) a
   where a.grantee = (select oid from r)
  union
  select 'TYPE', t.oid::regtype::text, null, a.privilege_type
    from pg_catalog.pg_type t cross join lateral pg_catalog.aclexplode(t.typacl) a
   where a.grantee = (select oid from r)
$$;

-- Privileges of the GMP login roles that the sandbox role lacks (DIRECTION = GRANT) or holds beyond
-- them (DIRECTION = REVOKE).
create function sandbox.mirror_differences()
returns table (direction text, object_kind text, object_name text, column_name text, privilege text)
language sql stable set search_path = pg_catalog, pg_temp as $$
  with gmp as (
    select * from sandbox.direct_privileges('ebmr_app')
    union
    select * from sandbox.direct_privileges('ebmr_authn')
  ), sbx as (
    select * from sandbox.direct_privileges('ebmr_sandbox')
  )
  select 'GRANT', * from (select * from gmp except select * from sbx) g
  union all
  select 'REVOKE', * from (select * from sbx except select * from gmp) x
$$;

-- Run by a superuser in a sandbox database after every migration run. Returns the number of grants
-- and revokes it issued.
create function sandbox.mirror_application_privileges() returns integer
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  r record;
  n integer := 0;
begin
  if kernel.installation_kind() <> 'SANDBOX' then
    raise exception using errcode = 'P0001',
      message = 'Privileges are copied to the sandbox role only inside a sandbox database; this is a GMP database, where the sandbox role holds nothing (DI-05, INV-18). [EBMR-SBX-030]';
  end if;
  for r in select * from sandbox.mirror_differences() order by direction, object_kind, object_name, column_name, privilege loop
    execute format('%s %s %s %s %s ebmr_sandbox',
      lower(r.direction),
      case when r.object_kind = 'COLUMN' then format('%s (%s)', r.privilege, r.column_name) else r.privilege end,
      'on',
      case r.object_kind when 'COLUMN' then 'table ' || r.object_name else lower(r.object_kind) || ' ' || r.object_name end,
      case r.direction when 'GRANT' then 'to' else 'from' end);
    n := n + 1;
  end loop;
  return n;
end
$$;

-- The invariant query (ADR 0012 item 8): no rows in a correctly provisioned database.
create function sandbox.segregation_problems() returns setof text
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
  else
    for r in select x.rolname from unnest(array['ebmr_app', 'ebmr_authn']) x(rolname)
              where exists (select 1 from pg_catalog.pg_roles where rolname = x.rolname)
                and has_database_privilege(x.rolname, v_db, 'CONNECT') loop
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
  end if;
end
$$;

grant execute on function sandbox.segregation_problems(), sandbox.direct_privileges(name), sandbox.mirror_differences() to ebmr_app;

reset role;
