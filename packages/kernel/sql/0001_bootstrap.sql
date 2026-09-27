-- Kernel bootstrap: roles and schema (ADR 0012).
--
-- ebmr_owner  NOLOGIN. Owns every table and every SECURITY DEFINER function.
-- ebmr_app    LOGIN role the application uses. It can read, call kernel functions and write only
--             through the paths the kernel grants. It can never write audit rows, signatures or
--             change table definitions.
-- Roles are cluster-wide, so creation is idempotent.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ebmr_owner') then
    create role ebmr_owner nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ebmr_app') then
    create role ebmr_app login password 'ebmr_app';
  end if;
end
$$;

create schema if not exists kernel authorization ebmr_owner;
revoke all on schema kernel from public;
grant usage on schema kernel to ebmr_app;

-- Functions are not executable by PUBLIC by default in this database; each kernel function
-- grants EXECUTE explicitly to ebmr_app.
alter default privileges for role ebmr_owner revoke execute on functions from public;
alter default privileges for role ebmr_owner in schema kernel grant select on tables to ebmr_app;

-- No temporary objects for anyone but superusers. A session that can create temp tables can shadow
-- unqualified table names inside functions whose search_path omits pg_temp; every kernel function also
-- lists pg_temp last, so this revoke is defence in depth.
do $$
begin
  execute format('revoke temporary on database %I from public', current_database());
end
$$;
