-- Platform services, part 6: state-machine engine (build outline 5.2 introduction, 4.4
-- "Privileges"; ADR 0012 decision 2; ADR 0010 pinning).
--
-- Machines are defined once in TypeScript (XState 5, packages/kernel/src/state/machines) and
-- published into the tables below by generated migrations (platform.publish_machine_version);
-- a test proves the XState definition and these rows describe exactly the same transitions.
-- A published machine version is immutable; each aggregate pins the version it was created with.
--
-- platform.transition is the only way to change an aggregate's state. In one transaction it
-- locks the state row, checks the optimistic version, finds the transition for the pinned
-- machine version, checks the permission (AUTHORITY hook), the required signature (SIGNATURE
-- hook) and every registered guard, updates state and version, writes a history row, a
-- plain-language audit entry on the aggregate's chain and an outbox message. The application
-- role has no write privilege on state or history rows; a trigger additionally refuses any
-- state change that is not a published transition or does not come through the engine.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------------------------
-- A guard is a SQL function
--   fn(aggregate_type text, aggregate_id uuid, transition jsonb, payload jsonb, actor jsonb) returns text
-- returning NULL when the guard passes, otherwise the reason it fails. Guards run inside the
-- transition's transaction with the state row locked and read the database clock for any
-- time-based validity (outline 5.2, L-12). They must not write.

create table platform.state_guard (
  code           text primary key check (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  function_oid   regprocedure not null,
  description    text not null check (description <> ''),
  registered_at  timestamptz not null default clock_timestamp()
);

create function platform.register_guard(p_code text, p_function regprocedure, p_description text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, platform as $$
begin
  if not exists (select 1 from pg_proc p where p.oid = p_function
                 and oidvectortypes(p.proargtypes) = 'text, uuid, jsonb, jsonb, jsonb' and p.prorettype = 'text'::regtype) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-071 guard %s must have the signature (text, uuid, jsonb, jsonb, jsonb) returns text', p_function);
  end if;
  insert into platform.state_guard (code, function_oid, description) values (p_code, p_function, p_description)
  on conflict (code) do update set function_oid = excluded.function_oid, description = excluded.description, registered_at = clock_timestamp();
end
$$;

-- Built-in guard: the command carries a reason (actor context reason_code).
create function platform.guard_reason_given(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language sql stable set search_path = pg_catalog as $$
  select case when coalesce(trim(p_actor ->> 'reason_code'), '') = '' then 'a reason is required for this transition' end
$$;
select platform.register_guard('platform.reason_given', 'platform.guard_reason_given(text, uuid, jsonb, jsonb, jsonb)',
                               'The command states a reason (reason code, optional text)');

create function platform.run_guard(p_code text, p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language plpgsql volatile security definer set search_path = pg_catalog, platform as $$
declare
  v_fn     regprocedure;
  v_reason text;
begin
  select function_oid into v_fn from platform.state_guard where code = p_code;
  if v_fn is null then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-071 guard %s is not registered', p_code);
  end if;
  execute format('select %s($1, $2, $3, $4, $5)', platform.function_call_name(v_fn))
    into v_reason using p_aggregate_type, p_aggregate_id, p_transition, p_payload, p_actor;
  return v_reason;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Machine definitions
-- ---------------------------------------------------------------------------------------------

create table platform.machine (
  code            text primary key check (code ~ '^[a-z][a-z0-9_]*$'),
  aggregate_type  text not null check (aggregate_type ~ '^[a-z][a-z0-9_]*$'),
  description     text not null,
  registered_at   timestamptz not null default clock_timestamp()
);

create table platform.machine_version (
  machine_code     text not null references platform.machine (code),
  version          integer not null check (version >= 1),
  initial_state    text not null,
  states           text[] not null,
  final_states     text[] not null,
  definition_hash  text check (definition_hash ~ '^[0-9a-f]{64}$'),   -- NULL only while being published
  published_at     timestamptz not null default clock_timestamp(),
  first_used_at    timestamptz,
  primary key (machine_code, version)
);

create table platform.machine_transition (
  machine_code       text not null,
  machine_version    integer not null,
  from_state         text not null,
  event              text not null check (event ~ '^[A-Z][A-Z0-9_]*$'),
  to_state           text not null,
  guard_codes        text[] not null default '{}',
  signature_meaning  text check (signature_meaning ~ '^[A-Z][A-Z0-9_]*$'),
  permission_code    text check (permission_code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  primary key (machine_code, machine_version, from_state, event),
  foreign key (machine_code, machine_version) references platform.machine_version (machine_code, version)
);

create function platform.protect_machine_definition() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform as $$
begin
  if tg_table_name = 'machine_transition' then
    if tg_op = 'INSERT' and exists (select 1 from platform.machine_version v
                                    where v.machine_code = new.machine_code and v.version = new.machine_version
                                      and v.definition_hash is null) then
      return new;
    end if;
  elsif tg_table_name = 'machine_version' and tg_op = 'UPDATE' then
    if new.machine_code = old.machine_code and new.version = old.version and new.initial_state = old.initial_state
       and new.states = old.states and new.final_states = old.final_states and new.published_at = old.published_at
       and (new.definition_hash is not distinct from old.definition_hash or old.definition_hash is null)
       and (new.first_used_at is not distinct from old.first_used_at or old.first_used_at is null) then
      return new;
    end if;
  end if;
  raise exception using errcode = 'P0001',
    message = format('EBMR-PLAT-061 published machine definitions are immutable (%s on %s refused); publish a new version instead', lower(tg_op), tg_table_name);
end
$$;

create trigger aa_protect before insert or update or delete on platform.machine_transition
  for each row execute function platform.protect_machine_definition();
create trigger aa_protect before update or delete on platform.machine_version
  for each row execute function platform.protect_machine_definition();
create trigger aa_protect before update or delete on platform.machine
  for each row execute function platform.protect_machine_definition();
create trigger aa_protect_truncate before truncate on platform.machine_transition
  for each statement execute function platform.reject_change();
create trigger aa_protect_truncate before truncate on platform.machine_version
  for each statement execute function platform.reject_change();
create trigger aa_protect_truncate before truncate on platform.machine
  for each statement execute function platform.reject_change();

-- Canonical text of a published version; identical to canonicalText() in src/state/extract.ts.
create function platform.machine_canonical_text(p_machine text, p_version integer) returns text
language sql stable security definer set search_path = pg_catalog, platform as $$
  select concat_ws(E'\n',
    'machine=' || m.code,
    'version=' || v.version,
    'aggregate_type=' || m.aggregate_type,
    'initial=' || v.initial_state,
    'states=' || array_to_string(array(select s from unnest(v.states) s order by s collate "C"), ','),
    'final=' || array_to_string(array(select s from unnest(v.final_states) s order by s collate "C"), ','),
    (select string_agg('transition=' || t.from_state || '|' || t.event || '|' || t.to_state || '|' || array_to_string(t.guard_codes, ',')
                       || '|' || coalesce(t.signature_meaning, '') || '|' || coalesce(t.permission_code, ''), E'\n'
                       order by t.from_state collate "C", t.event collate "C")
     from platform.machine_transition t where t.machine_code = v.machine_code and t.machine_version = v.version))
  from platform.machine m join platform.machine_version v on v.machine_code = m.code
  where m.code = p_machine and v.version = p_version
$$;

create function platform.machine_definition_hash(p_machine text, p_version integer) returns text
language sql stable security definer set search_path = pg_catalog, platform as $$
  select encode(sha256(convert_to(platform.machine_canonical_text(p_machine, p_version), 'UTF8')), 'hex')
$$;

-- Publishes one machine version from its JSON definition (generated from XState). Owner only:
-- called from migrations. Validates the definition, stores it, and seals it with its hash; the
-- hash computed by the generator must match the one computed here.
create function platform.publish_machine_version(p_definition jsonb) returns text
language plpgsql volatile security definer set search_path = pg_catalog, platform as $$
declare
  v_code     text := p_definition ->> 'machine';
  v_version  integer := (p_definition ->> 'version')::integer;
  v_agg      text := p_definition ->> 'aggregate_type';
  v_initial  text := p_definition ->> 'initial';
  v_states   text[] := array(select jsonb_array_elements_text(p_definition -> 'states'));
  v_finals   text[] := array(select jsonb_array_elements_text(coalesce(p_definition -> 'final_states', '[]'::jsonb)));
  v_t        jsonb;
  v_guard    text;
  v_hash     text;
  v_bad      text;
begin
  if v_code is null or v_code !~ '^[a-z][a-z0-9_]*$' or v_agg is null or v_version is null then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-062 a machine definition needs machine, version and aggregate_type';
  end if;
  if exists (select 1 from platform.machine where code = v_code and aggregate_type <> v_agg) then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-062 machine %s already governs another aggregate type', v_code);
  end if;
  if v_version <> coalesce((select max(version) from platform.machine_version where machine_code = v_code), 0) + 1 then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-062 machine %s: versions are published in sequence; %s is not next', v_code, v_version);
  end if;
  if cardinality(v_states) = 0 or cardinality(v_states) <> (select count(distinct s) from unnest(v_states) s)
     or exists (select 1 from unnest(v_states) s where s !~ '^[A-Z][A-Z0-9_]*$') then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-062 machine %s: states must be unique UPPER_SNAKE names', v_code);
  end if;
  if not (v_initial = any (v_states)) or not (v_finals <@ v_states) or v_initial = any (v_finals) then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-062 machine %s: initial and final states must be states, and the initial state not final', v_code);
  end if;

  insert into platform.machine (code, aggregate_type, description)
  values (v_code, v_agg, coalesce(p_definition ->> 'description', v_code))
  on conflict (code) do nothing;
  insert into platform.machine_version (machine_code, version, initial_state, states, final_states)
  values (v_code, v_version, v_initial, v_states, v_finals);

  for v_t in select * from jsonb_array_elements(coalesce(p_definition -> 'transitions', '[]'::jsonb)) loop
    if not ((v_t ->> 'from') = any (v_states)) or not ((v_t ->> 'to') = any (v_states)) then
      raise exception using errcode = 'P0001', message = format('EBMR-PLAT-062 machine %s: transition %s uses an unknown state', v_code, v_t);
    end if;
    if (v_t ->> 'from') = any (v_finals) then
      raise exception using errcode = 'P0001', message = format('EBMR-PLAT-062 machine %s: final state %s cannot have transitions', v_code, v_t ->> 'from');
    end if;
    for v_guard in select jsonb_array_elements_text(coalesce(v_t -> 'guards', '[]'::jsonb)) loop
      if not exists (select 1 from platform.state_guard where code = v_guard) then
        raise exception using errcode = 'P0001', message = format('EBMR-PLAT-071 machine %s: guard %s is not registered', v_code, v_guard);
      end if;
    end loop;
    if exists (select 1 from platform.machine_transition where machine_code = v_code and machine_version = v_version
               and from_state = v_t ->> 'from' and event = v_t ->> 'event') then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PLAT-062 machine %s: more than one transition for %s in %s', v_code, v_t ->> 'event', v_t ->> 'from');
    end if;
    insert into platform.machine_transition (machine_code, machine_version, from_state, event, to_state, guard_codes, signature_meaning, permission_code)
    values (v_code, v_version, v_t ->> 'from', v_t ->> 'event', v_t ->> 'to',
            array(select jsonb_array_elements_text(coalesce(v_t -> 'guards', '[]'::jsonb))),
            nullif(v_t ->> 'signature', ''), nullif(v_t ->> 'permission', ''));
  end loop;

  -- Soundness: every state reachable from the initial state; every non-final state can move on.
  with recursive reach(s) as (
    select v_initial
    union
    select t.to_state from platform.machine_transition t join reach r on r.s = t.from_state
    where t.machine_code = v_code and t.machine_version = v_version
  )
  select string_agg(s, ', ') into v_bad from unnest(v_states) s where s not in (select s from reach);
  if v_bad is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-062 machine %s: unreachable states %s', v_code, v_bad);
  end if;
  select string_agg(s, ', ') into v_bad from unnest(v_states) s
  where not (s = any (v_finals))
    and not exists (select 1 from platform.machine_transition t where t.machine_code = v_code and t.machine_version = v_version and t.from_state = s);
  if v_bad is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-062 machine %s: non-final states without transitions %s', v_code, v_bad);
  end if;

  v_hash := platform.machine_definition_hash(v_code, v_version);
  if p_definition ? 'definition_hash' and p_definition ->> 'definition_hash' <> v_hash then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-062 machine %s v%s: generator hash %s differs from database hash %s', v_code, v_version, p_definition ->> 'definition_hash', v_hash);
  end if;
  update platform.machine_version set definition_hash = v_hash where machine_code = v_code and version = v_version;
  return v_hash;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Aggregate state and history
-- ---------------------------------------------------------------------------------------------

create table platform.aggregate_state (
  aggregate_type   text not null check (aggregate_type ~ '^[a-z][a-z0-9_]*$'),
  aggregate_id     uuid not null,
  machine_code     text not null,
  machine_version  integer not null,
  state            text not null,
  version          bigint not null check (version >= 1),
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default clock_timestamp(),
  primary key (aggregate_type, aggregate_id),
  foreign key (machine_code, machine_version) references platform.machine_version (machine_code, version)
);

create table platform.state_history (
  id                 bigint generated always as identity primary key,
  aggregate_type     text not null,
  aggregate_id       uuid not null,
  machine_code       text not null,
  machine_version    integer not null,
  from_state         text,
  event              text,
  to_state           text not null,
  from_version       bigint,
  to_version         bigint not null,
  guard_results      jsonb not null default '[]'::jsonb,
  permission_code    text,
  signature_meaning  text,
  signature_id       uuid,
  payload            jsonb not null default '{}'::jsonb,
  person_id          text not null,
  account_id         text not null,
  role_code          text not null,
  correlation_id     uuid not null,
  reason_code        text,
  reason_text        text,
  aggregate_seq      bigint not null default 0,
  clock_regressed    boolean not null default false,
  recorded_at        timestamptz not null default clock_timestamp(),
  unique (aggregate_type, aggregate_id, to_version),
  check ((from_state is null) = (event is null) and (from_state is null) = (from_version is null)),
  check (from_version is null or to_version = from_version + 1)
);
create index state_history_aggregate on platform.state_history (aggregate_type, aggregate_id, to_version);

-- Only the engine writes state rows, and only along published transitions. The application
-- role has no privilege at all; this trigger stops owner-level code (other kernel functions)
-- from bypassing the engine.
create function platform.guard_state_row() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform as $$
declare
  v_version platform.machine_version%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-072 aggregate state rows are never deleted';
  end if;
  if coalesce(current_setting('platform.state_engine', true), '') <> 'on' then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-072 %s rows change only through platform.transition', tg_table_name);
  end if;
  if tg_table_name = 'aggregate_state' then
    if tg_op = 'INSERT' then
      select * into v_version from platform.machine_version where machine_code = new.machine_code and version = new.machine_version;
      if v_version.definition_hash is null or new.version <> 1 or new.state <> v_version.initial_state then
        raise exception using errcode = 'P0001', message = 'EBMR-PLAT-072 a new aggregate starts at version 1 in the initial state of a published machine version';
      end if;
    else
      if new.aggregate_type <> old.aggregate_type or new.aggregate_id <> old.aggregate_id or new.machine_code <> old.machine_code
         or new.machine_version <> old.machine_version or new.version <> old.version + 1
         or not exists (select 1 from platform.machine_transition t
                        where t.machine_code = old.machine_code and t.machine_version = old.machine_version
                          and t.from_state = old.state and t.to_state = new.state) then
        raise exception using errcode = 'P0001',
          message = format('EBMR-PLAT-072 %s -> %s is not a published transition of %s v%s', old.state, new.state, old.machine_code, old.machine_version);
      end if;
      new.updated_at := clock_timestamp();
    end if;
  end if;
  return new;
end
$$;

create trigger a1_guard_state_row before insert or update or delete on platform.aggregate_state
  for each row execute function platform.guard_state_row();
create trigger a1_guard_state_row before insert or update or delete on platform.state_history
  for each row execute function platform.guard_state_row();
create trigger aa_no_truncate before truncate on platform.aggregate_state
  for each statement execute function platform.reject_change();

-- Per-aggregate event counter for history rows (runs after a0_db_time set recorded_at).
create function platform.state_history_seq() returns trigger
language plpgsql security definer set search_path = pg_catalog, platform as $$
declare
  v record;
begin
  select * into v from platform.next_aggregate_seq(new.aggregate_type, new.aggregate_id::text, new.recorded_at);
  new.aggregate_seq := v.seq;
  new.clock_regressed := v.regressed;
  return new;
end
$$;
create trigger a2_state_history_seq before insert on platform.state_history
  for each row execute function platform.state_history_seq();

select platform.enforce_db_time('platform.aggregate_state', array['created_at']);
select platform.enforce_db_time('platform.state_history', array['recorded_at']);
select kernel.register_audited_table('platform.aggregate_state', 'state', 'aggregate_id', false);
select kernel.register_audited_table('platform.state_history', 'state', 'aggregate_id', true);

-- The engine flag lets platform.guard_state_row accept a write; only engine functions set it.
create function platform.engine_flag(p_on boolean) returns void
language plpgsql volatile security definer set search_path = pg_catalog as $$
begin
  perform set_config('platform.state_engine', case when p_on then 'on' else 'off' end, true);
end
$$;

-- The audit trigger requires a reason for every UPDATE. A transition is a new event, not a
-- correction of recorded data, so when the command stated no reason the state-row update is
-- audited with reason STATE_TRANSITION and the event as text. With p_reason_text NULL the
-- command's own context is restored.
create function platform.engine_reason(p_ctx jsonb, p_reason_text text) returns void
language plpgsql volatile security definer set search_path = pg_catalog as $$
begin
  if p_reason_text is not null and coalesce(p_ctx ->> 'reason_code', '') = '' then
    perform set_config('ebmr.ctx', (p_ctx || jsonb_build_object('reason_code', 'STATE_TRANSITION', 'reason_text', p_reason_text))::text, true);
  else
    perform set_config('ebmr.ctx', p_ctx::text, true);
  end if;
end
$$;

-- Creates the state row of a new aggregate at the initial state of the machine's newest
-- published version (or the version given), pinning that version for the aggregate's life.
create function platform.create_aggregate_state(p_machine text, p_aggregate_type text, p_aggregate_id uuid,
                                                p_machine_version integer default null) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel as $$
declare
  v_ctx      jsonb := platform.require_actor();
  v_machine  platform.machine%rowtype;
  v_version  platform.machine_version%rowtype;
  v_hist     bigint;
  v_msg      uuid;
begin
  select * into v_machine from platform.machine where code = p_machine;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-060 unknown machine %s', p_machine);
  end if;
  if v_machine.aggregate_type <> p_aggregate_type then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-065 machine %s governs %s aggregates, not %s', p_machine, v_machine.aggregate_type, p_aggregate_type);
  end if;
  select * into v_version from platform.machine_version
  where machine_code = p_machine and definition_hash is not null and (p_machine_version is null or version = p_machine_version)
  order by version desc limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-060 machine %s has no published version %s', p_machine, coalesce(p_machine_version::text, ''));
  end if;
  if exists (select 1 from platform.aggregate_state where aggregate_type = p_aggregate_type and aggregate_id = p_aggregate_id) then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-063 %s:%s already has a state', p_aggregate_type, p_aggregate_id);
  end if;

  perform platform.engine_flag(true);
  insert into platform.aggregate_state (aggregate_type, aggregate_id, machine_code, machine_version, state, version)
  values (p_aggregate_type, p_aggregate_id, p_machine, v_version.version, v_version.initial_state, 1);
  insert into platform.state_history (aggregate_type, aggregate_id, machine_code, machine_version, to_state, to_version,
                                      person_id, account_id, role_code, correlation_id, reason_code, reason_text)
  values (p_aggregate_type, p_aggregate_id, p_machine, v_version.version, v_version.initial_state, 1,
          v_ctx ->> 'person_id', v_ctx ->> 'account_id', v_ctx ->> 'role_code', (v_ctx ->> 'correlation_id')::uuid,
          v_ctx ->> 'reason_code', v_ctx ->> 'reason_text')
  returning id into v_hist;
  perform platform.engine_flag(false);
  if v_version.first_used_at is null then
    update platform.machine_version set first_used_at = clock_timestamp()
    where machine_code = p_machine and version = v_version.version and first_used_at is null;
  end if;

  perform kernel.audit_business_event(p_aggregate_type || ':' || p_aggregate_id,
    format('created in state %s (machine %s v%s)', v_version.initial_state, p_machine, v_version.version),
    jsonb_build_object('machine', p_machine, 'machine_version', v_version.version, 'state', v_version.initial_state, 'history_id', v_hist));
  v_msg := platform.enqueue('state.created', p_aggregate_type || ':' || p_aggregate_id, jsonb_build_object(
    'machine', p_machine, 'machine_version', v_version.version, 'aggregate_type', p_aggregate_type,
    'aggregate_id', p_aggregate_id, 'state', v_version.initial_state, 'version', 1));
  return jsonb_build_object('aggregate_type', p_aggregate_type, 'aggregate_id', p_aggregate_id, 'machine', p_machine,
                            'machine_version', v_version.version, 'state', v_version.initial_state, 'version', 1,
                            'history_id', v_hist, 'message_id', v_msg);
end
$$;

create function platform.transition(p_machine text, p_aggregate_type text, p_aggregate_id uuid, p_event text,
                                    p_expected_version bigint, p_payload jsonb default '{}'::jsonb) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, platform, kernel as $$
declare
  v_ctx        jsonb := platform.require_actor();
  v_payload    jsonb := coalesce(p_payload, '{}'::jsonb);
  v_state      platform.aggregate_state%rowtype;
  v_t          platform.machine_transition%rowtype;
  v_info       jsonb;
  v_code       text;
  v_reason     text;
  v_results    jsonb := '[]'::jsonb;
  v_failures   text[] := '{}';
  v_sig        uuid;
  v_hist       bigint;
  v_msg        uuid;
begin
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception using errcode = 'P0001', message = 'EBMR-PLAT-073 a transition payload must be a JSON object';
  end if;
  select * into v_state from platform.aggregate_state
  where aggregate_type = p_aggregate_type and aggregate_id = p_aggregate_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-PLAT-064 %s:%s has no state', p_aggregate_type, p_aggregate_id);
  end if;
  if v_state.machine_code <> p_machine then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-065 %s:%s follows machine %s, not %s', p_aggregate_type, p_aggregate_id, v_state.machine_code, p_machine);
  end if;
  if p_expected_version is null or p_expected_version <> v_state.version then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-066 stale command: expected version %s, but %s:%s is at version %s in state %s',
                       coalesce(p_expected_version::text, 'NULL'), p_aggregate_type, p_aggregate_id, v_state.version, v_state.state);
  end if;
  select * into v_t from platform.machine_transition
  where machine_code = v_state.machine_code and machine_version = v_state.machine_version
    and from_state = v_state.state and event = p_event;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-067 event %s is not allowed in state %s (machine %s v%s)', coalesce(p_event, 'NULL'), v_state.state,
                       v_state.machine_code, v_state.machine_version);
  end if;
  v_info := jsonb_build_object('machine', v_state.machine_code, 'machine_version', v_state.machine_version, 'from', v_state.state,
                               'event', p_event, 'to', v_t.to_state, 'version', v_state.version);

  if v_t.permission_code is not null then
    perform platform.authorize(v_t.permission_code, p_aggregate_type, p_aggregate_id::text);
  end if;
  if v_t.signature_meaning is not null then
    if coalesce(v_payload ->> 'signature_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception using errcode = 'P0001',
        message = format('EBMR-PLAT-008 event %s needs a signature with meaning %s (payload.signature_id)', p_event, v_t.signature_meaning);
    end if;
    v_sig := (v_payload ->> 'signature_id')::uuid;
    perform platform.verify_signature(v_sig, v_t.signature_meaning, p_aggregate_type, p_aggregate_id::text);
  end if;
  foreach v_code in array v_t.guard_codes loop
    v_reason := platform.run_guard(v_code, p_aggregate_type, p_aggregate_id, v_info, v_payload, v_ctx);
    v_results := v_results || jsonb_build_object('guard', v_code, 'passed', v_reason is null, 'reason', v_reason);
    if v_reason is not null then
      v_failures := v_failures || format('%s: %s', v_code, v_reason);
    end if;
  end loop;
  if cardinality(v_failures) > 0 then
    raise exception using errcode = 'P0001',
      message = format('EBMR-PLAT-068 %s refused in state %s: %s', p_event, v_state.state, array_to_string(v_failures, '; '));
  end if;

  perform platform.engine_flag(true);
  perform platform.engine_reason(v_ctx, format('%s: %s -> %s', p_event, v_state.state, v_t.to_state));
  update platform.aggregate_state set state = v_t.to_state, version = v_state.version + 1
  where aggregate_type = p_aggregate_type and aggregate_id = p_aggregate_id;
  perform platform.engine_reason(v_ctx, null);
  insert into platform.state_history (aggregate_type, aggregate_id, machine_code, machine_version, from_state, event, to_state,
                                      from_version, to_version, guard_results, permission_code, signature_meaning, signature_id,
                                      payload, person_id, account_id, role_code, correlation_id, reason_code, reason_text)
  values (p_aggregate_type, p_aggregate_id, v_state.machine_code, v_state.machine_version, v_state.state, p_event, v_t.to_state,
          v_state.version, v_state.version + 1, v_results, v_t.permission_code, v_t.signature_meaning, v_sig,
          v_payload, v_ctx ->> 'person_id', v_ctx ->> 'account_id', v_ctx ->> 'role_code', (v_ctx ->> 'correlation_id')::uuid,
          v_ctx ->> 'reason_code', v_ctx ->> 'reason_text')
  returning id into v_hist;
  perform platform.engine_flag(false);

  perform kernel.audit_business_event(p_aggregate_type || ':' || p_aggregate_id,
    format('%s: state %s -> %s (machine %s v%s)', p_event, v_state.state, v_t.to_state, v_state.machine_code, v_state.machine_version),
    v_info || jsonb_build_object('history_id', v_hist, 'signature_id', v_sig, 'guard_results', v_results));
  v_msg := platform.enqueue('state.transitioned', p_aggregate_type || ':' || p_aggregate_id,
    v_info || jsonb_build_object('aggregate_type', p_aggregate_type, 'aggregate_id', p_aggregate_id, 'new_version', v_state.version + 1));
  return v_info || jsonb_build_object('aggregate_type', p_aggregate_type, 'aggregate_id', p_aggregate_id,
                                      'new_version', v_state.version + 1, 'history_id', v_hist, 'message_id', v_msg,
                                      'guard_results', v_results);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Invariant queries (must return no rows)
-- ---------------------------------------------------------------------------------------------

-- A state row always equals its latest history row; histories have no gaps and follow published
-- transitions; states belong to the pinned version.
create function platform.state_violations()
returns table (aggregate_type text, aggregate_id uuid, problem text)
language sql stable security definer set search_path = pg_catalog, platform as $$
  select s.aggregate_type, s.aggregate_id,
         format('state row (%s, version %s) differs from the latest history row (%s, version %s)', s.state, s.version, h.to_state, h.to_version)
  from platform.aggregate_state s
  left join lateral (select x.to_state, x.to_version from platform.state_history x
                     where x.aggregate_type = s.aggregate_type and x.aggregate_id = s.aggregate_id
                     order by x.to_version desc limit 1) h on true
  where h.to_state is distinct from s.state or h.to_version is distinct from s.version
  union all
  select s.aggregate_type, s.aggregate_id, format('state %s is not a state of %s v%s', s.state, s.machine_code, s.machine_version)
  from platform.aggregate_state s join platform.machine_version v on v.machine_code = s.machine_code and v.version = s.machine_version
  where not (s.state = any (v.states))
  union all
  select h.aggregate_type, h.aggregate_id, format('history version %s has no predecessor', h.to_version)
  from platform.state_history h
  where h.to_version > 1 and not exists (select 1 from platform.state_history p
                                         where p.aggregate_type = h.aggregate_type and p.aggregate_id = h.aggregate_id and p.to_version = h.to_version - 1)
  union all
  select h.aggregate_type, h.aggregate_id, format('history version %s (%s -%s-> %s) is not a published transition', h.to_version, h.from_state, h.event, h.to_state)
  from platform.state_history h
  where h.from_state is not null
    and not exists (select 1 from platform.machine_transition t
                    where t.machine_code = h.machine_code and t.machine_version = h.machine_version
                      and t.from_state = h.from_state and t.event = h.event and t.to_state = h.to_state)
$$;

-- Published definitions still hash to their sealed value (detects a superuser rewrite).
create function platform.machine_integrity_violations()
returns table (machine_code text, version integer, problem text)
language sql stable security definer set search_path = pg_catalog, platform as $$
  select v.machine_code, v.version,
         case when v.definition_hash is null then 'version was never sealed'
              else 'transition rows no longer match the sealed definition hash' end
  from platform.machine_version v
  where v.definition_hash is null or v.definition_hash <> platform.machine_definition_hash(v.machine_code, v.version)
$$;

grant select on platform.state_guard, platform.machine, platform.machine_version, platform.machine_transition,
                platform.aggregate_state, platform.state_history to ebmr_app;
grant execute on function platform.create_aggregate_state(text, text, uuid, integer),
                          platform.transition(text, text, uuid, text, bigint, jsonb),
                          platform.state_violations(), platform.machine_integrity_violations(),
                          platform.machine_canonical_text(text, integer), platform.machine_definition_hash(text, integer) to ebmr_app;
-- publish_machine_version, register_guard, run_guard, engine_flag and engine_reason stay private
-- to the owner.

reset role;
