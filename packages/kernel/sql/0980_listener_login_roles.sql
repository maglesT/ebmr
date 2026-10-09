-- Kernel, installation hardening: a login role of its own for an edition's evidence listener, limited to its share of
-- the cluster's connections, and a connection limit on the application roles that keeps that share free for it (review
-- finding P50, follow-up item p50-gate-vs-app-role and its final verification, listener-credential-bound; controls
-- DI-17, DI-30, PR-20; ADR 0012).
--
-- Why. The tablets gateway listener puts on record what the site gateway sends before anything can hold it up
-- (tablets 0350), and the manual-weighing gate decides from those records whether a scale fell silent. The listener
-- logged in with the application role, so the gate could not tell the listener's own records from anything a holder of
-- that role's credentials writes, and that holder could take the database's free connections (no role had a
-- connection limit) so the listener could not open the connections its records needed. The gate now counts a scale
-- silent only on the listener's own record that everything it received was put on record (tablets 0350,
-- tab.listener_tick), which only the listener's login may write, and the application roles can no longer take every
-- connection the listener may need.
--
-- Roles (cluster-wide, created once; development passwords here, production sets credentials held in a vault):
--   ebmr_listener          LOGIN, NOINHERIT, member of nothing: the evidence listener of a GMP database. CONNECT on GMP
--                          databases only (sandbox.apply_connect_policy).
--   ebmr_sandbox_listener  LOGIN, NOINHERIT, member of nothing: the evidence listener of a sandbox database (INV-18).
--                          CONNECT on sandbox databases only; inside a sandbox it holds exactly the object privileges of
--                          ebmr_listener there (sandbox.mirror_application_privileges, run after every migration run), as
--                          ebmr_sandbox holds those of ebmr_app and ebmr_authn, and never a membership.
-- Migrations grant object privileges to ebmr_listener only, and only what the listener does (tablets 0350). No role may
-- be a member of either listener role, and neither may be a member of any role but pg_use_reserved_connections (an
-- operator's choice, below): sandbox.segregation_problems() reports each, since a member could act as the listener.
--
-- Connection limits: the listener's share of the cluster's connection slots (decisions X38, X41). One listener's share
-- is 8: the 5 connections it keeps open (its receipts pool of 4 and its watch's connection) and 3 spare, with which it
-- can replace up to 3 lost connections while the database still counts their old backends. The limit is hard, and
-- where the listener cannot open its 5 within it, it fails closed (X41), never open: backends left half-open by a
-- network fault count against the share until the database ends them, so past the 3 spare a lost connection is not
-- opened again (REWARM_FAILED at warn), a receipt or tick that needs one fails and the database vouches for no window
-- over it; and in a rolling deploy whose old and new servers overlap (5 + 5 > 8) the new server refuses to start until
-- the old one's listener has closed. A cluster that deploys with overlap declares the share of two listeners, 16
-- (kernel.apply_listener_share(16)). Each listener role gets CONNECTION LIMIT equal to the share, so a holder of the
-- listener's credentials can open no more than that (3 beside a running listener) to load the database or to take the
-- slots the listener needs; and the application role of the same kind (ebmr_app for ebmr_listener, ebmr_sandbox for
-- ebmr_sandbox_listener) gets the cluster's connection slots for ordinary roles (max_connections less
-- superuser_reserved_connections and reserved_connections) less the share, so no holder of an application role's
-- credentials can take every slot the listener could need. kernel.apply_listener_share(p_share) sets both pairs:
-- p_share declares the share (at least 8, else EBMR-SBX-037; a cluster whose databases run k listeners of a kind at
-- once, counting both servers of an overlapping deploy, declares 8k), null keeps the share each listener role already
-- holds (its connection limit, or 8 when it has none or a smaller one). This migration runs it with null; the operator
-- runs it again after a change of max_connections or of the number of listeners. The authentication service's
-- role is not limited (another credential). Role attributes are cluster-wide. A cluster with no room for the share
-- refuses (EBMR-SBX-036). Changes made from two databases at once are serialised on pg_authid, so neither changes a role
-- the other is changing. The share is held against one application role at a time: the sum of all roles' limits, or
-- PostgreSQL's reserved_connections with the listener roles in pg_use_reserved_connections, is an operations matter
-- (X38).
--
-- Also: sandbox.apply_connect_policy() (0970) grants CONNECT to the listener role of the database's kind and takes it
-- from the other; sandbox.mirror_application_privileges() (0820) also levels ebmr_sandbox_listener with ebmr_listener;
-- sandbox.segregation_problems() (0820) also checks the listener roles. Same signatures, languages, owners and
-- search_paths as before, none SECURITY DEFINER. New: sandbox.role_mirror_differences(name, name[]) (language sql,
-- owned by ebmr_owner, pg_temp last; EXECUTE for ebmr_app, as sandbox.mirror_differences()) and
-- kernel.apply_listener_share(integer) (plpgsql, owned by ebmr_owner, not SECURITY DEFINER, pg_temp last, granted to
-- nobody: it alters roles, which only a superuser may do here).

do $$
begin
  -- Serialises role changes across the cluster until this migration commits (two databases migrated at once).
  lock table pg_catalog.pg_authid in share row exclusive mode;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_listener') then
    -- Development password; production sets a vault-held credential.
    create role ebmr_listener login password 'ebmr_listener'
      noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_sandbox_listener') then
    create role ebmr_sandbox_listener login password 'ebmr_sandbox_listener'
      noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end
$$;

set local role ebmr_owner;

-- Who may connect: as 0970, with the listener role of the database's kind.
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
    execute format('revoke all on database %I from ebmr_app, ebmr_authn, ebmr_listener', v_db);
    execute format('grant connect on database %I to ebmr_sandbox, ebmr_sandbox_listener', v_db);
  else
    execute format('revoke all on database %I from ebmr_sandbox, ebmr_sandbox_listener', v_db);
    execute format('grant connect on database %I to ebmr_app, ebmr_authn, ebmr_listener', v_db);
  end if;
end
$$;

-- Privileges of the GMP roles p_gmp_roles that the sandbox role p_sandbox_role lacks (GRANT) or holds beyond them
-- (REVOKE), as sandbox.mirror_differences() answers them for ebmr_sandbox.
create function sandbox.role_mirror_differences(p_sandbox_role name, p_gmp_roles name[])
returns table (direction text, object_kind text, object_name text, column_name text, privilege text)
language sql stable set search_path = pg_catalog, pg_temp as $$
  with gmp as (
    select d.* from unnest(p_gmp_roles) g(rolname) cross join lateral sandbox.direct_privileges(g.rolname) d
  ), sbx as (
    select * from sandbox.direct_privileges(p_sandbox_role)
  )
  select 'GRANT', * from (select * from gmp except select * from sbx) g
  union all
  select 'REVOKE', * from (select * from sbx except select * from gmp) x
$$;

-- As 0820, for both sandbox login roles: ebmr_sandbox levelled with ebmr_app and ebmr_authn, ebmr_sandbox_listener with
-- ebmr_listener. Returns the number of grants and revokes it issued.
create or replace function sandbox.mirror_application_privileges() returns integer
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  r record;
  n integer := 0;
begin
  if kernel.installation_kind() <> 'SANDBOX' then
    raise exception using errcode = 'P0001',
      message = 'Privileges are copied to the sandbox role only inside a sandbox database; this is a GMP database, where the sandbox role holds nothing (DI-05, INV-18). [EBMR-SBX-030]';
  end if;
  for r in
    select 'ebmr_sandbox'::text as rolname, d.* from sandbox.mirror_differences() d
    union all
    select 'ebmr_sandbox_listener'::text, d.* from sandbox.role_mirror_differences('ebmr_sandbox_listener', array['ebmr_listener']::name[]) d
    order by 1, 2, 3, 4, 5, 6
  loop
    execute format('%s %s on %s %s %I',
      lower(r.direction),
      case when r.object_kind = 'COLUMN' then format('%s (%s)', r.privilege, r.column_name) else r.privilege end,
      case r.object_kind when 'COLUMN' then 'table ' || r.object_name else lower(r.object_kind) || ' ' || r.object_name end,
      case r.direction when 'GRANT' then 'to' else 'from' end,
      r.rolname);
    n := n + 1;
  end loop;
  return n;
end
$$;

-- The invariant query (ADR 0012 item 8): as 0820, and the listener roles: neither has an elevated attribute, is a
-- member of a role or has a member; in a GMP database the sandbox listener can neither connect nor hold anything; in a
-- sandbox the GMP listener cannot connect and the sandbox listener holds exactly the GMP listener's privileges.
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
    for r in select x.rolname from unnest(array['ebmr_app', 'ebmr_authn', 'ebmr_listener']) x(rolname)
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

-- The listener's share of the cluster's connection slots (decisions X38, X41): each listener role gets CONNECTION LIMIT
-- equal to the share, and the application role of its kind the slots for roles that are not superusers less the share.
-- p_share: the share to declare (at least 8); null keeps the share each listener role holds (its connection limit when
-- that is at least 8, else 8). Alters cluster-wide role attributes: run by a superuser (this migration, the operator).
create function kernel.apply_listener_share(p_share integer default null) returns void
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  v_least constant integer := 8;
  v_slots integer := pg_catalog.current_setting('max_connections')::integer
                     - pg_catalog.current_setting('superuser_reserved_connections')::integer
                     - coalesce(pg_catalog.current_setting('reserved_connections', true), '0')::integer;
  v_share integer;
  r record;
begin
  if p_share is not null and p_share < v_least then
    raise exception using errcode = 'P0001',
      message = format('The evidence listener''s share of the cluster''s connections is at least %s (the 5 connections it keeps open and 3 spare to replace lost ones), so %s is too few (DI-30, PR-20). [EBMR-SBX-037]', v_least, p_share);
  end if;
  -- Serialises role changes across the cluster until the caller's transaction ends (two databases migrated at once).
  lock table pg_catalog.pg_authid in share row exclusive mode;
  for r in
    select x.app, x.listener, a.rolconnlimit as app_limit, l.rolconnlimit as listener_limit
      from (values ('ebmr_app'::name, 'ebmr_listener'::name), ('ebmr_sandbox'::name, 'ebmr_sandbox_listener'::name)) x(app, listener)
      join pg_catalog.pg_roles a on a.rolname = x.app
      join pg_catalog.pg_roles l on l.rolname = x.listener
     order by x.app
  loop
    v_share := coalesce(p_share, greatest(r.listener_limit, v_least));
    if v_slots - v_share < 1 then
      raise exception using errcode = 'P0001',
        message = format('This cluster has %s connection slots for roles that are not superusers, too few to keep %s free for the evidence listener: raise max_connections (DI-30, PR-20). [EBMR-SBX-036]', v_slots, v_share);
    end if;
    if r.listener_limit is distinct from v_share then
      execute format('alter role %I connection limit %s', r.listener, v_share);
    end if;
    if r.app_limit is distinct from v_slots - v_share then
      execute format('alter role %I connection limit %s', r.app, v_slots - v_share);
    end if;
  end loop;
end
$$;

revoke all on function sandbox.role_mirror_differences(name, name[]) from public;
grant execute on function sandbox.role_mirror_differences(name, name[]) to ebmr_app;
revoke all on function kernel.apply_listener_share(integer) from public;

reset role;

select kernel.apply_listener_share();
select sandbox.apply_connect_policy();

do $$
begin
  if not kernel.backend_signals_restricted() then
    raise exception using errcode = 'P0001',
      message = 'Roles other than superusers can still cancel or end other connections (pg_cancel_backend, pg_terminate_backend, pg_signal_backend): run this migration as a superuser and take pg_signal_backend from every login role that is not one (DI-17, DI-30). [EBMR-SBX-035]';
  end if;
end
$$;
