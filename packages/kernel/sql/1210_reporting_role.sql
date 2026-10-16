-- Phase 6 slice 6g: the read-only reporting path (decisions 0015, 0016; plan "Left ready for the analytics work";
-- D-P6g-0-1 to 3). The role ebmr_report, the schema report, the connect policy and the segregation check for the role.
--
-- Handbook: modules/kernel.md
--
-- Why. Dashboards and the later analytics module read GMP data but must never write it (outline 7.3: dashboards are
-- never used for GMP decisions; decision 0015 item 2: no model writes to a GMP table). They read versioned views in
-- the schema report, with a login role of their own that can read those views and nothing else:
--   ebmr_report   LOGIN, NOINHERIT, member of nothing, CONNECTION LIMIT 4 (development password here; production a
--                 vault credential). CONNECT on GMP databases only; USAGE on schema report; SELECT on the report views;
--                 EXECUTE on their non-volatile row functions (granted view by view, here and in recipe-core 1070).
--   schema report owned by ebmr_owner; USAGE to ebmr_app (the dashboards) and ebmr_report.
-- Each view selects from a STABLE SECURITY DEFINER row function in the same schema: PostgreSQL checks a function
-- called inside a view with the reader's own EXECUTE right, so the reader is given exactly the row function, never the
-- recipe or site functions behind it. A STABLE function cannot run INSERT, UPDATE or DELETE itself.
--
-- report.data_as_of(): when the data read was current. On a primary the read's transaction time; on a streaming
-- replica the last replayed commit (pg_last_xact_replay_timestamp), so read_at - data_as_of is the replica's lag.
--
-- sandbox.apply_connect_policy() (latest 1111) grants ebmr_report CONNECT on a GMP database and takes it away in a
-- sandbox. sandbox.segregation_problems() (latest 1100) reports, in a GMP database, the role missing, elevated, a
-- member of a role (or with members), any privilege beyond the three above, a default privilege to it, and any volatile
-- function it could execute; in a sandbox, that it can connect. Both are replaced whole from their latest definitions;
-- only the lines marked 1210 are new. No new error codes.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_report') then
    begin
      -- Development password; production sets a vault-held credential.
      create role ebmr_report login password 'ebmr_report' connection limit 4
        noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    exception when duplicate_object or unique_violation then
      null; -- created concurrently by another migration run on the same cluster
    end;
  end if;
end
$$;

create schema if not exists report authorization ebmr_owner;
revoke all on schema report from public;
grant usage on schema report to ebmr_app, ebmr_report;

set local role ebmr_owner;

-- When the data read was current (D-P6g-0-1).
create function report.data_as_of() returns timestamptz
language sql stable parallel safe set search_path = pg_catalog, pg_temp as $$
  select coalesce(pg_catalog.pg_last_xact_replay_timestamp(), pg_catalog.transaction_timestamp())
$$;
revoke all on function report.data_as_of() from public;
grant execute on function report.data_as_of() to ebmr_app, ebmr_report;

-- The registry of the report views (D-P6g-0-2): insert-only; a view's columns come from the system catalogue.
create table report.view_registry (
  view_name    text primary key check (view_name ~ '^[a-z][a-z0-9_]*_v[1-9][0-9]*$'),
  version      integer not null check (version >= 1),
  grain        text not null check (btrim(grain) <> ''),
  description  text not null check (btrim(description) <> ''),
  recorded_at  timestamptz not null default clock_timestamp()
);
revoke all on report.view_registry from public;
create trigger aa_insert_only before update or delete on report.view_registry for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on report.view_registry for each statement execute function kernel.reject_mutation();

create function report.catalog_rows_v1()
returns table (view_name text, version integer, grain text, description text, columns jsonb, read_at timestamptz, data_as_of timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select g.view_name, g.version, g.grain, g.description,
         coalesce((select jsonb_agg(jsonb_build_object('name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod)) order by a.attnum)
                     from pg_catalog.pg_attribute a
                    where a.attrelid = pg_catalog.to_regclass('report.' || g.view_name) and a.attnum > 0 and not a.attisdropped), '[]'::jsonb),
         pg_catalog.statement_timestamp(), report.data_as_of()
    from report.view_registry g
   order by g.view_name
$$;
revoke all on function report.catalog_rows_v1() from public;
grant execute on function report.catalog_rows_v1() to ebmr_app, ebmr_report;
create view report.catalog_v1 as select * from report.catalog_rows_v1();
revoke all on report.catalog_v1 from public;
grant select on report.catalog_v1 to ebmr_app, ebmr_report;
insert into report.view_registry (view_name, version, grain, description)
values ('catalog_v1', 1, 'report view', 'The report views, their versions, grains and columns');

reset role;
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
    execute format('grant connect on database %I to ebmr_sandbox, ebmr_sandbox_listener', v_db);
  else
    execute format('revoke all on database %I from ebmr_sandbox, ebmr_sandbox_listener', v_db);
    execute format('grant connect on database %I to ebmr_app, ebmr_authn, ebmr_listener', v_db);
    -- 1210: the reporting role connects to GMP databases (and reads only the report views).
    execute format('revoke all on database %I from ebmr_report', v_db);
    execute format('grant connect on database %I to ebmr_report', v_db);
  end if;
end
$$;

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
    -- 1210: the reporting role reads the report views and nothing else (D-P6g-0-1 to 3; decisions 0015, 0016).
    if not exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_report') then
      return next 'the reporting role ebmr_report does not exist';
    else
      for r in select rolname from pg_catalog.pg_roles
                where rolname = 'ebmr_report' and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls or rolinherit) loop
        return next 'ebmr_report has an elevated role attribute (superuser, createdb, createrole, replication, bypassrls or inherit)';
      end loop;
      for r in select s.rolname as member, g.rolname as of_role from pg_catalog.pg_auth_members m
                 join pg_catalog.pg_roles g on g.oid = m.roleid
                 join pg_catalog.pg_roles s on s.oid = m.member
                where s.rolname = 'ebmr_report' or g.rolname = 'ebmr_report'
                order by 1, 2 loop
        return next format('%s is a member of role %s', r.member, r.of_role);
      end loop;
      for r in select * from sandbox.direct_privileges('ebmr_report') d
                where not (d.object_kind = 'SCHEMA' and d.object_name = 'report' and d.privilege = 'USAGE')
                  and not (d.object_kind = 'TABLE' and d.column_name is null and d.privilege = 'SELECT'
                           and exists (select 1 from pg_catalog.pg_class c
                                        where c.oid = d.object_name::regclass and c.relnamespace = 'report'::regnamespace and c.relkind = 'v'))
                  and not (d.object_kind = 'ROUTINE' and d.privilege = 'EXECUTE'
                           and exists (select 1 from pg_catalog.pg_proc p
                                        where p.oid = d.object_name::regprocedure and p.pronamespace = 'report'::regnamespace and p.provolatile <> 'v'))
                order by 1, 2, 3, 4 loop
        return next format('ebmr_report holds %s on %s %s%s, beyond reading the report views', r.privilege, lower(r.object_kind), r.object_name,
                           coalesce(' (' || r.column_name || ')', ''));
      end loop;
      for r in select d.defaclnamespace::regnamespace::text as ns from pg_catalog.pg_default_acl d
                 cross join lateral pg_catalog.aclexplode(d.defaclacl) a
                where a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'ebmr_report') loop
        return next format('a default privilege grants to ebmr_report (schema %s)', r.ns);
      end loop;
      for r in select p.oid::regprocedure::text as fn from pg_catalog.pg_proc p
                where p.pronamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
                  and p.provolatile = 'v'
                  and has_function_privilege('ebmr_report', p.oid, 'EXECUTE')
                  and has_schema_privilege('ebmr_report', p.pronamespace, 'USAGE')
                order by 1 loop
        return next format('ebmr_report may execute the volatile function %s', r.fn);
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
    -- 1210: the reporting role never opens a sandbox.
    if exists (select 1 from pg_catalog.pg_roles p where p.rolname = 'ebmr_report' and has_database_privilege(p.oid, v_db, 'CONNECT')) then
      return next format('the reporting role ebmr_report can connect to the sandbox database %s', v_db);
    end if;
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
