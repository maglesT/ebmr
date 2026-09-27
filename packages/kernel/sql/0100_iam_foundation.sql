-- Identity and access (module B1), part 1: schema, authentication-service role, policy values,
-- security alerts, the validated-command log and the actor helpers every IAM function uses.
--
-- Build outline 4.7, 5.5, 7.1, 7.2; ADR 0006, 0012; controls DI-14..DI-21; invariants INV-11,
-- INV-26, INV-27 (user IDs), INV-40.
--
-- Roles
--   ebmr_owner  owns every object (NOLOGIN, bootstrap migration).
--   ebmr_app    the application: reads non-secret IAM tables and calls the IAM functions granted to it.
--               It has no INSERT, UPDATE or DELETE right on any IAM table and can never read a
--               secret verifier.
--   ebmr_authn  the authentication service (ADR 0012 decision 1): the only role that can read
--               verifiers for verification and the only role that can create authentication events.
--               It holds EXECUTE on the iam.authn_* functions and nothing else.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ebmr_authn') then
    begin
      create role ebmr_authn login password 'ebmr_authn' noinherit;
    exception when duplicate_object then
      null; -- created concurrently by another migration run on the same cluster
    end;
  end if;
end
$$;

create schema if not exists iam authorization ebmr_owner;
revoke all on schema iam from public;
grant usage on schema iam to ebmr_app;
grant usage on schema iam to ebmr_authn;

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------------------------

-- Refuses DELETE and TRUNCATE on IAM tables whose rows must survive for attribution (accounts,
-- persons, grants, logs). Applies to every role, including the table owner.
create function iam.forbid_removal() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  raise exception using errcode = 'P0001',
    message = format('EBMR-IAM-005 rows of %s are never deleted (%s refused)', tg_relid::regclass, lower(tg_op));
end
$$;

-- Insert-only protection for protected logs that are not part of the audit trail (the kernel's
-- reject_mutation covers registered insert-only tables).
create function iam.forbid_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  raise exception using errcode = 'P0001',
    message = format('EBMR-IAM-006 %s is an insert-only log (%s refused)', tg_relid::regclass, lower(tg_op));
end
$$;

create function iam.protect_log(p_table regclass) returns void
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_name text := replace(replace(p_table::text, '.', '_'), '"', '');
begin
  execute format('create trigger %I before update or delete on %s for each row execute function iam.forbid_change()', 'ab_log_' || v_name, p_table);
  execute format('create trigger %I before truncate on %s for each statement execute function iam.forbid_change()', 'ab_log_trunc_' || v_name, p_table);
end
$$;

create function iam.protect_rows(p_table regclass) returns void
language plpgsql security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_name text := replace(replace(p_table::text, '.', '_'), '"', '');
begin
  execute format('create trigger %I before delete on %s for each row execute function iam.forbid_removal()', 'ab_keep_' || v_name, p_table);
  execute format('create trigger %I before truncate on %s for each statement execute function iam.forbid_removal()', 'ab_keep_trunc_' || v_name, p_table);
end
$$;

-- Scopes are jsonb objects with the optional keys site, area and product (text values). A grant
-- or requirement scope column that is null covers every value of that dimension; a request that
-- leaves a dimension empty is covered only by a grant that leaves it empty too.
create function iam.check_scope(p_scope jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, iam, pg_temp as $$
declare
  k text;
begin
  if p_scope is null then
    return '{}'::jsonb;
  end if;
  if jsonb_typeof(p_scope) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-004 a scope must be a JSON object with keys site, area, product';
  end if;
  for k in select jsonb_object_keys(p_scope) loop
    if k not in ('site', 'area', 'product') then
      raise exception using errcode = 'P0001', message = format('EBMR-IAM-004 unknown scope dimension %s', k);
    end if;
    if jsonb_typeof(p_scope -> k) not in ('string', 'null') then
      raise exception using errcode = 'P0001', message = format('EBMR-IAM-004 scope dimension %s must be text', k);
    end if;
  end loop;
  if nullif(p_scope ->> 'area', '') is not null and nullif(p_scope ->> 'site', '') is null then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-004 an area scope needs its site';
  end if;
  return jsonb_strip_nulls(p_scope);
end
$$;

create function iam.scope_covers(p_site text, p_area text, p_product text, p_request jsonb) returns boolean
language sql immutable set search_path = pg_catalog, iam, pg_temp as $$
  select coalesce(
           (p_site is null or p_site = nullif(p_request ->> 'site', ''))
       and (p_area is null or p_area = nullif(p_request ->> 'area', ''))
       and (p_product is null or p_product = nullif(p_request ->> 'product', '')),
         false)
$$;

-- ---------------------------------------------------------------------------------------------
-- Policy values (design defaults with allowed ranges; no regulation sets these numbers, DI-19)
-- ---------------------------------------------------------------------------------------------

create table iam.policy_key (
  key            text primary key check (key ~ '^[a-z][a-z0-9_]*(\.[a-zA-Z0-9_]+)+$'),
  value_type     text not null check (value_type in ('INTEGER', 'BOOLEAN', 'TEXT')),
  default_value  text not null,
  min_value      bigint,
  max_value      bigint,
  allowed_values text[],
  unit           text,
  description    text not null,
  basis          text not null
);

create table iam.policy_value (
  id              bigint generated always as identity primary key,
  key             text not null references iam.policy_key (key),
  value           text not null,
  set_by_person   uuid not null,
  set_by_account  uuid not null,
  reason          text not null check (btrim(reason) <> ''),
  recorded_at     timestamptz not null default clock_timestamp()
);
create index policy_value_key on iam.policy_value (key, id desc);

insert into iam.policy_key (key, value_type, default_value, min_value, max_value, allowed_values, unit, description, basis) values
  ('authn.lockout_threshold', 'INTEGER', '5', 3, 5, null, 'attempts', 'Consecutive failed login or signing attempts that lock the account', 'DI-19 design default 5, allowed 3-5'),
  ('authn.event_max_age_seconds', 'INTEGER', '120', 10, 600, null, 's', 'Maximum age of an authentication event used to open a session, unlock, change a secret or sign', 'Outline 5.5 challenge validity 120 s'),
  ('attribution.freshness_seconds.SHARED', 'INTEGER', '60', 1, 300, null, 's', 'Freshness window of the authentication event every command on a SHARED device carries', 'Outline 5.5, ADR 0006 item 8: default 60 s per device class'),
  ('attribution.freshness_seconds.GRADE_A_B', 'INTEGER', '60', 1, 300, null, 's', 'Freshness window of the authentication event every command on a GRADE_A_B device carries', 'Outline 5.5, ADR 0006 item 8: default 60 s per device class'),
  ('session.idle_timeout_seconds.SHARED', 'INTEGER', '300', 60, 900, null, 's', 'Kiosk lock after inactivity on shared terminals', 'Outline 4.7 and DI-38: default 5 min, allowed 1-15 min'),
  ('session.idle_timeout_seconds.GRADE_A_B', 'INTEGER', '300', 60, 900, null, 's', 'Kiosk lock after inactivity on Grade A/B terminals', 'Outline 4.7 and DI-38: default 5 min, allowed 1-15 min'),
  ('session.idle_timeout_seconds.PERSONAL', 'INTEGER', '900', 60, 3600, null, 's', 'Lock after inactivity on personal (office) devices', 'Design default; no regulation sets it'),
  ('session.idle_timeout_seconds.SERVER', 'INTEGER', '3600', 60, 86400, null, 's', 'Idle timeout of service sessions on SERVER devices', 'Design default; no regulation sets it'),
  ('session.absolute_timeout_seconds', 'INTEGER', '43200', 3600, 86400, null, 's', 'Absolute session lifetime regardless of activity', 'Outline 4.7 absolute timeout; design default 12 h'),
  ('credential.password_min_length', 'INTEGER', '12', 8, 128, null, 'characters', 'Minimum password length (checked by the authentication service before hashing)', 'Design default; no regulation sets it (DI-19 type_detail)'),
  ('credential.password_max_age_days', 'INTEGER', '90', 0, 365, null, 'days', 'Password aging; 0 turns aging off, which needs compromised-password screening', 'DI-19 design default 90 days'),
  ('credential.compromised_screening', 'BOOLEAN', 'false', null, null, null, null, 'Compromised-password screening as the risk-based equivalent of aging', 'DI-19: aging or a documented equivalent must be active'),
  ('credential.password_history', 'INTEGER', '5', 0, 24, null, 'passwords', 'Number of previous passwords that cannot be reused', 'Design default'),
  ('credential.pin_length', 'INTEGER', '6', 4, 12, null, 'digits', 'Minimum PIN length', 'Design default'),
  ('credential.initial_secret_valid_hours', 'INTEGER', '72', 1, 720, null, 'h', 'An unused initial or admin-reset secret expires after this time', 'Design default supporting 11.300 (paraphrased)'),
  ('badge.test_interval_days', 'INTEGER', '365', 30, 730, null, 'days', 'Periodic badge test interval', 'DI-19: badges tested at issue and periodically'),
  ('recertification.interval_months', 'INTEGER', '6', 3, 12, null, 'months', 'Access recertification interval', 'DI-16 design default 6 months, allowed 3-12'),
  ('alert.ack_deadline_seconds', 'INTEGER', '900', 1, 86400, null, 's', 'Security alerts not acknowledged within this time escalate', 'DI-19: unanswered alerts escalate; design default'),
  ('breakglass.max_window_minutes', 'INTEGER', '60', 5, 240, null, 'min', 'Longest break-glass window a second person may approve', 'DI-18: break-glass is time-limited; design default'),
  ('qualification.mirror_max_staleness_seconds', 'INTEGER', '86400', 60, 604800, null, 's', 'Mirrored qualification data older than this is stale and fails closed', 'INV-26, INV-38 freshness bound (stub for the LMS mirror)'),
  ('esig.us_certification_mode', 'TEXT', 'BLOCK', null, null, array['BLOCK', 'FLAG'], null, 'Missing 21 CFR 11.100(c) certification: BLOCK refuses US-market batch issue, FLAG only reports it', 'DI-15 catalog FLAG; outline 5.5 proposed_modify BLOCK (expert decision pending)'),
  ('site.zone', 'TEXT', 'Asia/Kolkata', null, null, null, null, 'IANA zone recorded with actor contexts the identity module creates itself', 'Outline 5.6');

create function iam.policy_text(p_key text) returns text
language plpgsql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v text;
begin
  select v2.value into v from iam.policy_value v2 where v2.key = p_key order by v2.id desc limit 1;
  if v is null then
    select k.default_value into v from iam.policy_key k where k.key = p_key;
    if v is null then
      raise exception using errcode = 'P0001', message = format('EBMR-IAM-110 unknown policy key %s', p_key);
    end if;
  end if;
  return v;
end
$$;

create function iam.policy_int(p_key text) returns bigint
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select iam.policy_text(p_key)::bigint
$$;

create function iam.policy_bool(p_key text) returns boolean
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select iam.policy_text(p_key)::boolean
$$;

create function iam.policy_values() returns table (key text, value text, value_type text, min_value bigint, max_value bigint,
                                                     allowed_values text[], unit text, description text, basis text, is_default boolean)
language sql stable security definer set search_path = pg_catalog, iam, pg_temp as $$
  select k.key, iam.policy_text(k.key), k.value_type, k.min_value, k.max_value, k.allowed_values, k.unit, k.description, k.basis,
         not exists (select 1 from iam.policy_value v where v.key = k.key)
  from iam.policy_key k
  order by k.key
$$;

-- ---------------------------------------------------------------------------------------------
-- Security alerts (DI-19 misuse detection). Raised by the system (often before anyone is
-- authenticated), so the alert rows are a protected insert-only log; acknowledgement and
-- escalation are attributed actions in iam.security_alert_action, which is audited.
-- ---------------------------------------------------------------------------------------------

create table iam.security_alert (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in (
                'AUTHENTICATION_FAILED', 'SIGNING_FAILED', 'ACCOUNT_LOCKED', 'LOCKED_ACCOUNT_USE', 'DISABLED_ACCOUNT_USE',
                'UNKNOWN_IDENTIFIER', 'BADGE_NOT_ACTIVE', 'INITIAL_SECRET_REUSE', 'EXPIRED_SECRET_USE', 'UNREGISTERED_DEVICE',
                'BLOCKED_DEVICE_USE', 'DEVICE_LOCATION_MISMATCH', 'DEVICE_CLASS_MISUSE', 'BREAK_GLASS_USED', 'BREAK_GLASS_REFUSED',
                'SERVICE_ACCOUNT_INTERACTIVE_USE', 'NON_INTERACTIVE_METHOD_MISUSE')),
  severity    text not null check (severity in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  account_id  uuid,
  person_id   uuid,
  device_id   uuid,
  badge_id    uuid,
  session_id  uuid,
  details     jsonb not null default '{}'::jsonb,
  raised_at   timestamptz not null default clock_timestamp(),
  ack_due_at  timestamptz not null
);
create index security_alert_account on iam.security_alert (account_id, raised_at);
create index security_alert_raised on iam.security_alert (raised_at);
select iam.protect_log('iam.security_alert');

create table iam.security_alert_action (
  id          uuid primary key default gen_random_uuid(),
  alert_id    uuid not null references iam.security_alert (id),
  action      text not null check (action in ('ACKNOWLEDGED', 'ESCALATED')),
  by_person   uuid not null,
  by_account  uuid not null,
  comment     text,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (alert_id, action)
);

-- Raise an alert: insert it and notify listeners (LISTEN ebmr_security_alert) on commit, so the
-- security unit and QA see it in real time.
create function iam.raise_alert(p_kind text, p_severity text, p_account uuid, p_person uuid, p_device uuid, p_badge uuid,
                                p_session uuid, p_details jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
declare
  v_id uuid;
  v_at timestamptz := clock_timestamp();
begin
  insert into iam.security_alert (kind, severity, account_id, person_id, device_id, badge_id, session_id, details, raised_at, ack_due_at)
  values (p_kind, p_severity, p_account, p_person, p_device, p_badge, p_session, coalesce(p_details, '{}'::jsonb), v_at,
          v_at + make_interval(secs => iam.policy_int('alert.ack_deadline_seconds')))
  returning id into v_id;
  perform pg_notify('ebmr_security_alert', jsonb_build_object('alert_id', v_id, 'kind', p_kind, 'severity', p_severity,
                                                              'account_id', p_account, 'raised_at', v_at)::text);
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Validated-command log. kernel.validate_actor_context (replaced in 0190) writes one row per
-- validated command, keyed by transaction and a hash of the exact context. iam.actor() refuses a
-- context that was set without passing validation (for example with set_config directly).
-- ---------------------------------------------------------------------------------------------

create table iam.command_log (
  xact_id         xid8 not null,
  ctx_hash        bytea not null,
  backend_pid     integer not null,
  correlation_id  uuid not null,
  account_id      uuid not null,
  session_id      uuid not null,
  auth_event_id   uuid,
  validated_at    timestamptz not null default clock_timestamp(),
  primary key (xact_id, ctx_hash)
);
create index command_log_correlation on iam.command_log (correlation_id);
select iam.protect_log('iam.command_log');

create function iam.context_hash(p_ctx jsonb) returns bytea
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select sha256(convert_to(p_ctx::text, 'UTF8'))
$$;

-- True when the current actor context was established by kernel.begin_command in this transaction.
create function iam.actor_is_validated() returns boolean
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_ctx jsonb := kernel.current_actor();
begin
  if v_ctx is null then
    return false;
  end if;
  return exists (
    select 1 from iam.command_log c
    where c.xact_id = pg_current_xact_id() and c.backend_pid = pg_backend_pid() and c.ctx_hash = iam.context_hash(v_ctx));
end
$$;

-- Raises unless the current actor context was validated. Other modules (and the audit writer,
-- once the lead wires it in) can call this to refuse forged contexts.
create function iam.assert_validated_actor() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, iam, kernel, pg_temp as $$
declare
  v_ctx jsonb := kernel.current_actor();
begin
  if v_ctx is null then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-001 no actor context: call kernel.begin_command first';
  end if;
  if not iam.actor_is_validated() then
    raise exception using errcode = 'P0001', message = 'EBMR-IAM-002 the actor context was not established by kernel.begin_command in this transaction';
  end if;
  return v_ctx;
end
$$;

-- The validated actor as typed values.
create function iam.actor_person() returns uuid
language sql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
  select (iam.assert_validated_actor() ->> 'person_id')::uuid
$$;

-- Internal: set an actor context from inside an IAM function, for self-service writes that happen
-- before a session exists (changing an initial secret). Only SECURITY DEFINER code owned by
-- ebmr_owner can call it; the context is registered as validated for this transaction.
create function iam.set_internal_actor(p_ctx jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, iam, pg_temp as $$
begin
  insert into iam.command_log (xact_id, ctx_hash, backend_pid, correlation_id, account_id, session_id, auth_event_id)
  values (pg_current_xact_id(), iam.context_hash(p_ctx), pg_backend_pid(), (p_ctx ->> 'correlation_id')::uuid,
          (p_ctx ->> 'account_id')::uuid, (p_ctx ->> 'session_id')::uuid, nullif(p_ctx ->> 'auth_event_id', '')::uuid)
  on conflict do nothing;
  perform set_config('ebmr.ctx', p_ctx::text, true);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Audit registration. Seeded catalogue rows are covered by this migration's checksum; every later
-- change is audited.
-- ---------------------------------------------------------------------------------------------

select kernel.register_audited_table('iam.policy_value', 'iam_policy', 'key', true);
select kernel.register_audited_table('iam.security_alert_action', 'security_alert', 'alert_id', true);
select iam.protect_rows('iam.policy_key');

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

revoke all on all tables in schema iam from ebmr_app, ebmr_authn;
grant select on iam.policy_key, iam.policy_value, iam.security_alert, iam.security_alert_action to ebmr_app;
grant execute on function iam.check_scope(jsonb), iam.scope_covers(text, text, text, jsonb), iam.policy_text(text),
                          iam.policy_int(text), iam.policy_bool(text), iam.policy_values(), iam.actor_is_validated(),
                          iam.assert_validated_actor() to ebmr_app;

reset role;
