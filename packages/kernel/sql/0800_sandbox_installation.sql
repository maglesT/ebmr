-- Sandbox, training and simulation store (module A4), part 1: the installation marker, the sandbox
-- login role and database-level segregation. Build outline 4.4 (Databases), 6.5 (sandbox test runs),
-- 5.3 (INV-18); ADR 0001 item 2, ADR 0012 items 1 and 8; control DI-05; invariant INV-18.
--
-- Installation marker. Every database migrated with the kernel records once, when it is provisioned,
-- what kind of installation it is: GMP (edition and site databases) or SANDBOX (ebmr_sandbox_<edition>,
-- the one store shared by sandbox test runs, training and simulation mode). This migration writes the
-- marker; afterwards it can never change, not even for the table owner.
--   * The provisioning tool (src/sandbox/provision.ts) sets the session setting
--     ebmr.installation_kind = 'SANDBOX' before it runs the migrations. A database whose name starts
--     with ebmr_sandbox_ is a sandbox even without the setting.
--   * Every other database is GMP, including existing databases upgraded to this migration.
-- The kind and the database name must agree (SANDBOX if and only if the name starts with
-- ebmr_sandbox_). This is checked when the marker is written and every time it is read, so a GMP
-- database copied under a sandbox name, or a sandbox restored under another name, reports no kind at
-- all and every GMP-issuing path refuses it.
--
-- Roles. ebmr_sandbox (LOGIN, NOINHERIT, member of nothing) is the only login role that may connect to
-- a sandbox database. In a GMP database CONNECT is revoked from PUBLIC and granted only to the GMP
-- login roles (ebmr_app, ebmr_authn), so the sandbox role cannot open a session there. Inside a sandbox
-- database the sandbox role receives the application's and the authentication service's object
-- privileges (0820). Database-level privileges are not copied by CREATE DATABASE ... TEMPLATE or by a
-- data-only restore: sandbox.apply_connect_policy() re-applies them (restore procedure, test harness).
--
-- Error codes: EBMR-SBX-0xx. Messages give the plain-language reason first, then the control, then
-- the code in brackets.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'ebmr_sandbox') then
    begin
      -- Development password; production sets a vault-held credential.
      create role ebmr_sandbox login password 'ebmr_sandbox'
        noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    exception when duplicate_object or unique_violation then
      null; -- created concurrently by another migration run on the same cluster
    end;
  end if;
end
$$;

create schema if not exists sandbox authorization ebmr_owner;
revoke all on schema sandbox from public;
grant usage on schema sandbox to ebmr_app;

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- The marker
-- ---------------------------------------------------------------------------------------------

-- True when a database name is in the sandbox namespace (any letter case).
create function sandbox.is_sandbox_database_name(p_name text) returns boolean
language sql immutable parallel safe set search_path = pg_catalog, pg_temp as $$
  select lower(coalesce(p_name, '')) like 'ebmr\_sandbox\_%'
$$;

create table sandbox.installation (
  singleton      boolean primary key default true check (singleton),
  kind           text not null check (kind in ('GMP', 'SANDBOX')),
  database_name  text not null,
  marked_at      timestamptz not null default clock_timestamp(),
  marked_by      text not null default session_user
);
revoke all on sandbox.installation from public;
grant select on sandbox.installation to ebmr_app;

-- Written once; never updated, deleted or truncated, by any role (a superuser who disables the
-- trigger is recorded in kernel.ddl_log).
create function sandbox.guard_installation() returns trigger
language plpgsql security definer set search_path = pg_catalog, sandbox, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from sandbox.installation) then
      raise exception using errcode = 'P0001',
        message = 'The installation kind is already set: it is set once, when the database is provisioned (DI-05, INV-18). [EBMR-SBX-003]';
    end if;
    if (new.kind = 'SANDBOX') <> sandbox.is_sandbox_database_name(pg_catalog.current_database()) then
      raise exception using errcode = 'P0001',
        message = format('Database %s cannot be marked %s: a sandbox database must be named ebmr_sandbox_<edition>, and no GMP database may use that name (DI-05, INV-18). [EBMR-SBX-004]',
                         pg_catalog.current_database(), new.kind);
    end if;
    new.database_name := pg_catalog.current_database();
    return new;
  end if;
  raise exception using errcode = 'P0001',
    message = format('The installation kind is permanent (%s refused): a sandbox never becomes a GMP database and a GMP database never becomes a sandbox (DI-05, INV-18). [EBMR-SBX-002]',
                     lower(tg_op));
end
$$;

create trigger aa_guard_installation before insert or update or delete on sandbox.installation
  for each row execute function sandbox.guard_installation();
create trigger aa_guard_installation_statement before truncate on sandbox.installation
  for each statement execute function sandbox.guard_installation();

-- The installation kind every GMP-issuing path checks: 'GMP' or 'SANDBOX'. Refuses when the marker is
-- missing or disagrees with the database name.
create function kernel.installation_kind() returns text
language plpgsql stable security definer set search_path = pg_catalog, sandbox, pg_temp as $$
declare
  v_kind text;
begin
  select i.kind into v_kind from sandbox.installation i;
  if v_kind is null then
    raise exception using errcode = 'P0001',
      message = 'This database has no installation marker, so it is neither a GMP nor a sandbox installation; provision it before use (DI-05, INV-18). [EBMR-SBX-001]';
  end if;
  if (v_kind = 'SANDBOX') <> sandbox.is_sandbox_database_name(pg_catalog.current_database()) then
    raise exception using errcode = 'P0001',
      message = format('Database %s is marked %s but its name says otherwise (a copy or restore under the wrong name); it is refused as both GMP and sandbox (DI-05, INV-18). [EBMR-SBX-004]',
                       pg_catalog.current_database(), v_kind);
  end if;
  return v_kind;
end
$$;

-- Every path that creates or changes a GMP record of lasting status (release and dispositions, real
-- inventory and equipment status, true copies registered as GMP records, messages to real external
-- systems) calls this first.
create function sandbox.assert_gmp_installation(p_action text) returns void
language plpgsql stable security definer set search_path = pg_catalog, sandbox, pg_temp as $$
begin
  if kernel.installation_kind() <> 'GMP' then
    raise exception using errcode = 'P0001',
      message = format('%s is refused: this is a sandbox installation (TEST, NOT GMP), and test, training and simulation work never creates GMP records (DI-05, INV-18). [EBMR-SBX-010]',
                       coalesce(nullif(btrim(p_action), ''), 'This action'));
  end if;
end
$$;

-- Sandbox-only features (test runs of unapproved versions, seeded review-by-exception challenges,
-- training scenarios) call this first.
create function sandbox.assert_sandbox_installation(p_action text) returns void
language plpgsql stable security definer set search_path = pg_catalog, sandbox, pg_temp as $$
begin
  if kernel.installation_kind() <> 'SANDBOX' then
    raise exception using errcode = 'P0001',
      message = format('%s is allowed only in the sandbox (the test, training and simulation store); this is a GMP database (DI-05, INV-18). [EBMR-SBX-011]',
                       coalesce(nullif(btrim(p_action), ''), 'This action'));
  end if;
end
$$;

-- The watermark every rendering and export of this installation carries: 'TEST, NOT GMP' in a
-- sandbox, null in a GMP database. Same text as watermarkFor() in src/sandbox/watermark.ts.
create function sandbox.watermark() returns text
language plpgsql stable security definer set search_path = pg_catalog, sandbox, pg_temp as $$
begin
  if kernel.installation_kind() = 'SANDBOX' then
    return 'TEST, NOT GMP';
  end if;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Who may connect (run by the database owner or a superuser: migration, provisioning, restore)
-- ---------------------------------------------------------------------------------------------

create function sandbox.apply_connect_policy() returns void
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  v_db text := pg_catalog.current_database();
begin
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

grant execute on function kernel.installation_kind(), sandbox.assert_gmp_installation(text),
                          sandbox.assert_sandbox_installation(text), sandbox.watermark(),
                          sandbox.is_sandbox_database_name(text) to ebmr_app;

-- ---------------------------------------------------------------------------------------------
-- Mark this database (once) and apply the connect policy
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_intent text := nullif(btrim(coalesce(current_setting('ebmr.installation_kind', true), '')), '');
begin
  if v_intent is not null and v_intent not in ('GMP', 'SANDBOX') then
    raise exception using errcode = 'P0001',
      message = format('The provisioning setting ebmr.installation_kind must be GMP or SANDBOX, not %s (DI-05). [EBMR-SBX-005]', v_intent);
  end if;
  insert into sandbox.installation (kind, database_name)
  values (coalesce(v_intent, case when sandbox.is_sandbox_database_name(current_database()) then 'SANDBOX' else 'GMP' end),
          current_database());
end
$$;

reset role;

select sandbox.apply_connect_policy();
