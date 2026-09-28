-- Platform services, part 1: schema, shared helpers, enforcement hooks, policy values and
-- per-aggregate event counters (build outline 5.6, 5.7; ADR 0006, 0012; invariant INV-16).
--
-- Conventions used by every platform table:
--   * Event times (recorded_at and similar) come from the database clock. Each such column has
--     default clock_timestamp() and is registered with platform.enforce_db_time, whose trigger
--     overwrites any supplied value on insert and keeps the stored value on update (INV-16).
--   * Error messages start with EBMR-PLAT-NNN.

create schema if not exists platform authorization ebmr_owner;
revoke all on schema platform from public;
grant usage on schema platform to ebmr_app;

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------------------------

-- The actor context of the current command, or an error when no command was declared.
create function platform.require_actor() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx jsonb := kernel.current_actor();
begin
  if v_ctx is null then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-001 no actor context: call kernel.begin_command first';
  end if;
  return v_ctx;
end
$$;

-- Trigger function for platform tables that are insert-only but not audited row by row.
create function platform.reject_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  raise exception using errcode = 'P0001',
    message = format('EBMR-PLAT-002 %s is insert-only; %s is refused', tg_relid::regclass, lower(tg_op));
end
$$;

create function platform.make_insert_only(p_table regclass) returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_suffix text := replace(replace(p_table::text, '.', '_'), '"', '');
begin
  execute format('create trigger %I before update or delete on %s for each row execute function platform.reject_change()',
                 'aa_insert_only_' || v_suffix, p_table);
  execute format('create trigger %I before truncate on %s for each statement execute function platform.reject_change()',
                 'aa_no_truncate_' || v_suffix, p_table);
end
$$;

-- Schema-qualified, quoted name of a function, for dynamic calls of registered functions.
create function platform.function_call_name(p_function regprocedure) returns text
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select quote_ident(n.nspname) || '.' || quote_ident(p.proname)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.oid = p_function
$$;

-- ---------------------------------------------------------------------------------------------
-- Database time for event columns (INV-16)
-- ---------------------------------------------------------------------------------------------

create table platform.db_time_column (
  table_name     regclass not null,
  column_name    text not null,
  registered_at  timestamptz not null default clock_timestamp(),
  primary key (table_name, column_name)
);

-- BEFORE INSERT OR UPDATE trigger. Arguments: the event-time columns of the table. On insert each
-- is set to clock_timestamp(), whatever the statement supplied; on update each keeps its stored
-- value. The application therefore cannot choose an event time, and nor can owner-level code.
create function platform.force_db_time() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v_now  timestamptz := clock_timestamp();
  v_old  jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else null end;
  v_set  jsonb := '{}'::jsonb;
  v_col  text;
begin
  foreach v_col in array tg_argv loop
    if tg_op = 'INSERT' then
      v_set := v_set || jsonb_build_object(v_col, v_now);
    else
      v_set := v_set || jsonb_build_object(v_col, v_old -> v_col);
    end if;
  end loop;
  return jsonb_populate_record(new, v_set);
end
$$;

create function platform.db_time_trigger_name(p_table regclass) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select 'a0_db_time_' || replace(replace(p_table::text, '.', '_'), '"', '')
$$;

-- Registers the event-time columns of a table and installs the forcing trigger. Called from
-- migrations (owner only).
create function platform.enforce_db_time(p_table regclass, p_columns text[]) returns void
language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_col text;
begin
  if p_columns is null or cardinality(p_columns) = 0 then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-003 at least one event-time column is required';
  end if;
  foreach v_col in array p_columns loop
    if not exists (select 1 from pg_attribute a
                   where a.attrelid = p_table and a.attname = v_col and not a.attisdropped
                     and a.atttypid = 'timestamptz'::regtype) then
      raise exception using errcode = 'P0001', message = format('EBMR-PLAT-003 %s.%s is not a timestamptz column', p_table, v_col);
    end if;
    insert into platform.db_time_column (table_name, column_name) values (p_table, v_col);
  end loop;
  execute format('create trigger %I before insert or update on %s for each row execute function platform.force_db_time(%s)',
                 platform.db_time_trigger_name(p_table), p_table,
                 (select string_agg(quote_literal(c), ', ') from unnest(p_columns) c));
end
$$;

-- Invariant query for INV-16: must return no rows. It reports registered event-time columns whose
-- forcing trigger is missing or disabled, whose default is not the database clock, or that the
-- application role could write. For every other audited table with a recorded_at column (tables of
-- modules built before the platform, whose own definer code or stamp trigger sets the time), it
-- reports the column when the application role could write it or when its default is not the
-- database clock: then the application could choose the time of an event. Registering such a column
-- with platform.enforce_db_time goes further and forces it even against owner-level code.
create function platform.time_model_violations()
returns table (table_name text, column_name text, problem text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select c.table_name::text, c.column_name, 'forcing trigger missing or disabled'
  from platform.db_time_column c
  where not exists (select 1 from pg_trigger t
                    where t.tgrelid = c.table_name and t.tgname = platform.db_time_trigger_name(c.table_name)
                      and t.tgenabled in ('O', 'A'))
  union all
  select c.table_name::text, c.column_name, 'default is not clock_timestamp()'
  from platform.db_time_column c
  where coalesce((select pg_get_expr(d.adbin, d.adrelid)
                  from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                  where a.attrelid = c.table_name and a.attname = c.column_name), '') <> 'clock_timestamp()'
  union all
  select c.table_name::text, c.column_name, 'the application role may write this column'
  from platform.db_time_column c
  where has_column_privilege('ebmr_app', c.table_name, c.column_name, 'INSERT')
     or has_column_privilege('ebmr_app', c.table_name, c.column_name, 'UPDATE')
  union all
  select a.table_name::text, 'recorded_at', 'audited table has a recorded_at column that the application role may write'
  from kernel.audited_table a
  where exists (select 1 from pg_attribute x where x.attrelid = a.table_name and x.attname = 'recorded_at' and not x.attisdropped)
    and not exists (select 1 from platform.db_time_column c where c.table_name = a.table_name and c.column_name = 'recorded_at')
    and (has_column_privilege('ebmr_app', a.table_name, 'recorded_at', 'INSERT')
         or has_column_privilege('ebmr_app', a.table_name, 'recorded_at', 'UPDATE'))
  union all
  select a.table_name::text, 'recorded_at', 'audited table has a recorded_at column whose default is not the database clock'
  from kernel.audited_table a
  join pg_attribute x on x.attrelid = a.table_name and x.attname = 'recorded_at' and not x.attisdropped
  join pg_attrdef d on d.adrelid = x.attrelid and d.adnum = x.attnum
  where not exists (select 1 from platform.db_time_column c where c.table_name = a.table_name and c.column_name = 'recorded_at')
    and pg_get_expr(d.adbin, d.adrelid) <> 'clock_timestamp()'
$$;

-- ---------------------------------------------------------------------------------------------
-- Enforcement hooks (authority and signature checks provided by other kernel modules)
-- ---------------------------------------------------------------------------------------------
-- The identity module (permissions) and the e-signature module (signature validity) are built
-- separately. They plug in here. Without a registered provider every check that needs one is
-- refused (fail closed).
--   AUTHORITY: fn(permission text, actor jsonb, aggregate_type text, aggregate_id text) returns text
--   SIGNATURE: fn(signature_id uuid, meaning text, aggregate_type text, aggregate_id text, actor jsonb) returns text
-- Each returns NULL when the check passes, otherwise the reason it failed.

create table platform.hook (
  name           text primary key check (name in ('AUTHORITY', 'SIGNATURE')),
  function_oid   regprocedure not null,
  registered_at  timestamptz not null default clock_timestamp()
);

create function platform.register_hook(p_name text, p_function regprocedure) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v_expected text;
begin
  v_expected := case p_name
    when 'AUTHORITY' then 'text, jsonb, text, text'
    when 'SIGNATURE' then 'uuid, text, text, text, jsonb'
  end;
  if v_expected is null then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-004 unknown hook %s', p_name);
  end if;
  if not exists (select 1 from pg_proc p where p.oid = p_function and oidvectortypes(p.proargtypes) = v_expected and p.prorettype = 'text'::regtype) then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-004 %s does not have the %s hook signature', p_function, p_name);
  end if;
  insert into platform.hook (name, function_oid) values (p_name, p_function)
  on conflict (name) do update set function_oid = excluded.function_oid, registered_at = clock_timestamp();
end
$$;

-- Refuses unless the current actor holds the permission (via the AUTHORITY provider).
create function platform.authorize(p_permission text, p_aggregate_type text, p_aggregate_id text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx    jsonb := platform.require_actor();
  v_fn     regprocedure;
  v_reason text;
begin
  select function_oid into v_fn from platform.hook where name = 'AUTHORITY';
  if v_fn is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-005 no authority provider is registered; permission %s cannot be evaluated', p_permission);
  end if;
  execute format('select %s($1, $2, $3, $4)', platform.function_call_name(v_fn))
    into v_reason using p_permission, v_ctx, p_aggregate_type, p_aggregate_id;
  if v_reason is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-006 permission %s denied: %s', p_permission, v_reason);
  end if;
end
$$;

-- Refuses unless p_signature_id is a valid signature with the meaning for the record (via the
-- SIGNATURE provider).
create function platform.verify_signature(p_signature_id uuid, p_meaning text, p_aggregate_type text, p_aggregate_id text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx    jsonb := platform.require_actor();
  v_fn     regprocedure;
  v_reason text;
begin
  if p_signature_id is null then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-008 a signature with meaning %s is required', p_meaning);
  end if;
  select function_oid into v_fn from platform.hook where name = 'SIGNATURE';
  if v_fn is null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-007 no signature verifier is registered; a signature with meaning %s cannot be verified', p_meaning);
  end if;
  execute format('select %s($1, $2, $3, $4, $5)', platform.function_call_name(v_fn))
    into v_reason using p_signature_id, p_meaning, p_aggregate_type, p_aggregate_id, v_ctx;
  if v_reason is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-008 signature %s is not a valid %s signature for %s:%s: %s', p_signature_id, p_meaning, p_aggregate_type, p_aggregate_id, v_reason);
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Policy values
-- ---------------------------------------------------------------------------------------------
-- Interim store for the platform's configurable values until the policy-versioning engine
-- (market module) takes them over as rule keys. Definitions are seeded by migrations; a value
-- change is a new insert-only, audited row that needs a reason and the permission
-- platform.settings.change. The newest row wins; without a row the default applies.

create table platform.setting_definition (
  key            text primary key check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  value_type     text not null check (value_type in ('DECIMAL', 'INTEGER', 'TEXT')),
  default_value  text not null,
  min_value      numeric,
  max_value      numeric,
  allowed_values text[],
  max_scale      integer check (max_scale >= 0),   -- DECIMAL: most decimals a value may have
  unit           text,
  description    text not null,
  basis          text not null
);

create table platform.setting_value (
  id             bigint generated always as identity primary key,
  key            text not null references platform.setting_definition (key),
  value          text not null,
  set_by_person  text not null,
  reason_code    text not null,
  reason_text    text,
  recorded_at    timestamptz not null default clock_timestamp()
);
create index setting_value_key on platform.setting_value (key, id desc);

create function platform.check_setting_value(p_key text, p_value text) returns void
language plpgsql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  d platform.setting_definition%rowtype;
  v numeric;
begin
  select * into d from platform.setting_definition where key = p_key;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-020 unknown setting %s', p_key);
  end if;
  if p_value is null then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-021 setting %s needs a value', p_key);
  end if;
  if d.value_type in ('DECIMAL', 'INTEGER') then
    if (d.value_type = 'DECIMAL' and p_value !~ '^-?[0-9]+(\.[0-9]+)?$') or (d.value_type = 'INTEGER' and p_value !~ '^-?[0-9]+$') then
      raise exception using errcode = 'P0001', message = format('EBMR-PLAT-021 setting %s must be a %s, not %s', p_key, lower(d.value_type), p_value);
    end if;
    v := p_value::numeric;
    if d.value_type = 'DECIMAL' and d.max_scale is not null and scale(v) > d.max_scale then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PLAT-021 setting %s allows at most %s decimals; %s is refused', p_key, d.max_scale, p_value);
    end if;
    if (d.min_value is not null and v < d.min_value) or (d.max_value is not null and v > d.max_value) then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PLAT-021 setting %s must lie between %s and %s %s; %s is refused', p_key, d.min_value, d.max_value, coalesce(d.unit, ''), p_value);
    end if;
  end if;
  if d.allowed_values is not null and not (p_value = any (d.allowed_values)) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-021 setting %s must be one of %s; %s is refused', p_key, array_to_string(d.allowed_values, ', '), p_value);
  end if;
end
$$;

create function platform.setting_text(p_key text) returns text
language plpgsql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v text;
begin
  select value into v from platform.setting_value where key = p_key order by id desc limit 1;
  if v is null then
    select default_value into v from platform.setting_definition where key = p_key;
    if v is null then
      raise exception using errcode = 'P0001', message = format('EBMR-PLAT-020 unknown setting %s', p_key);
    end if;
  end if;
  return v;
end
$$;

create function platform.setting_numeric(p_key text) returns numeric
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select platform.setting_text(p_key)::numeric
$$;

create function platform.set_setting(p_key text, p_value text) returns bigint
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel, pg_temp as $$
declare
  v_ctx jsonb := platform.require_actor();
  v_id  bigint;
begin
  if coalesce(v_ctx ->> 'reason_code', '') = '' then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-022 a reason is required to change setting %s', p_key);
  end if;
  perform platform.check_setting_value(p_key, p_value);
  perform platform.authorize('platform.settings.change', 'platform_setting', p_key);
  insert into platform.setting_value (key, value, set_by_person, reason_code, reason_text)
  values (p_key, p_value, v_ctx ->> 'person_id', v_ctx ->> 'reason_code', v_ctx ->> 'reason_text')
  returning id into v_id;
  return v_id;
end
$$;

insert into platform.setting_definition (key, value_type, default_value, min_value, max_value, allowed_values, max_scale, unit, description, basis) values
  -- Three decimals: the precision drift samples store the threshold with (platform.drift_sample).
  ('time.drift_alarm_threshold_s', 'DECIMAL', '1', 0.1, 5, null, 3, 's',
   'Offset of a database node from a time reference above which an alarm and a data-integrity incident are raised',
   'DI-27 design choice: default 1 s, allowed 0.1-5 s; no regulation sets a clock tolerance (outline 5.6)'),
  ('time.min_references', 'INTEGER', '2', 2, 5, null, null, null,
   'Number of reachable independent time references below which a degraded-reference alarm is raised',
   'Outline 5.6: each database node is checked against at least two independent references'),
  ('time.drift_check_max_age_s', 'INTEGER', '300', 60, 86400, null, null, 's',
   'Age of the newest drift check of a database node beyond which platform.time_monitor_violations() reports that the monitor is not recording',
   'DI-27 design choice: a monitor that cannot record must itself be detected; default 5 min pending expert review'),
  ('time.late_entry_window_mode', 'TEXT', 'PLANNED_STEP_END', null, null, array['PLANNED_STEP_END', 'FIXED_INTERVAL'], null, null,
   'How the late-entry window ends: at the end of the planned step window, or a fixed number of minutes after the event',
   'Outline 5.6: kernel default is the end of the planned step window; editions may choose a fixed interval'),
  ('time.late_entry_window_min', 'INTEGER', '15', 0, 1440, null, null, 'min',
   'Late-entry window in minutes after the event, used in FIXED_INTERVAL mode and for steps without a planned end',
   'Outline 5.6: injectables default 15 min; the 0-1440 bounds are a design choice pending expert review');

-- ---------------------------------------------------------------------------------------------
-- Per-aggregate event counters and clock monotonicity (outline 5.6, L-14)
-- ---------------------------------------------------------------------------------------------
-- Each business event of an aggregate gets the next number of the aggregate's counter, which
-- gives an order that does not depend on the clock. An event whose recorded_at is earlier than
-- the aggregate's latest recorded_at (the database clock stepped back, e.g. after a failover) is
-- flagged in platform.time_anomaly and returned as regressed.

create table platform.aggregate_clock (
  aggregate_type    text not null,
  aggregate_id      text not null,
  last_seq          bigint not null check (last_seq >= 1),
  last_recorded_at  timestamptz not null,
  prev_recorded_at  timestamptz,
  primary key (aggregate_type, aggregate_id)
);

create table platform.time_anomaly (
  id                    bigint generated always as identity primary key,
  kind                  text not null check (kind in ('CLOCK_REGRESSION')),
  aggregate_type        text not null,
  aggregate_id          text not null,
  aggregate_seq         bigint not null,
  event_recorded_at     timestamptz not null,
  previous_recorded_at  timestamptz not null,
  recorded_at           timestamptz not null default clock_timestamp()
);

create function platform.next_aggregate_seq(p_aggregate_type text, p_aggregate_id text, p_recorded_at timestamptz,
                                            out seq bigint, out regressed boolean)
language plpgsql volatile security definer set search_path = pg_catalog, platform, pg_temp as $$
declare
  v_prev timestamptz;
begin
  insert into platform.aggregate_clock as c (aggregate_type, aggregate_id, last_seq, last_recorded_at, prev_recorded_at)
  values (p_aggregate_type, p_aggregate_id, 1, p_recorded_at, null)
  on conflict (aggregate_type, aggregate_id) do update
    set last_seq = c.last_seq + 1,
        prev_recorded_at = c.last_recorded_at,
        last_recorded_at = greatest(c.last_recorded_at, excluded.last_recorded_at)
  returning c.last_seq, c.prev_recorded_at into seq, v_prev;
  regressed := v_prev is not null and p_recorded_at < v_prev;
  if regressed then
    insert into platform.time_anomaly (kind, aggregate_type, aggregate_id, aggregate_seq, event_recorded_at, previous_recorded_at)
    values ('CLOCK_REGRESSION', p_aggregate_type, p_aggregate_id, seq, p_recorded_at, v_prev);
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Registration and privileges
-- ---------------------------------------------------------------------------------------------

select platform.enforce_db_time('platform.setting_value', array['recorded_at']);
select platform.enforce_db_time('platform.time_anomaly', array['recorded_at']);
select kernel.register_audited_table('platform.setting_value', 'platform_setting', 'key', true);
select kernel.register_audited_table('platform.time_anomaly', 'time_anomaly', 'aggregate_id', true);

grant select on platform.setting_definition, platform.setting_value, platform.time_anomaly, platform.db_time_column,
                platform.hook to ebmr_app;
grant execute on function platform.require_actor(), platform.time_model_violations(), platform.setting_text(text),
                          platform.setting_numeric(text), platform.set_setting(text, text),
                          platform.check_setting_value(text, text) to ebmr_app;
-- enforce_db_time, make_insert_only, register_hook, authorize, verify_signature and
-- next_aggregate_seq stay private to the owner (called from migrations and platform functions).

reset role;
