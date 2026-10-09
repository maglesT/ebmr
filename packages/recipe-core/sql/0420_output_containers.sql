-- Plant, output containers (Phase 3 slice 1, part C): the containers a stage discharges into, their
-- identification, the in-process-check results that bracket them and the holds those checks raise
-- (build outline 5.2.9 "Output containers", L-30; TB-11; IN-21 identification; IN-26 (c) charge scan).
--
--   plant.press_discharge    per press, versioned: whether its streams discharge into separate
--                            containers (then a failed check holds only that stream's containers)
--   plant.output_container   one container: label code (generated, unique), batch, product and
--                            strength taken from the batch, stage, press and stream, unit; opened_at at
--                            insert, database time; insert-only (its identification never changes)
--   plant.container_close    the close: net quantity, closing person, closed_at (database time); once
--   plant.ipc_check          PASS, FAIL or MISSED per batch, press and stream, database time; the "last
--                            passing check" of the hold rule is derived from these rows, never passed in
--   plant.container_hold     why a container is held: the failing or missed check, and the container
--                            it reached through a merge when the hold was propagated
--   plant.container_merge    a closed, usable container poured into an open one of the same batch/stage
--   plant.container_charge   a container charged (consumed) into a stage, or packed, by label scan
--
-- Every table is written only through the SECURITY DEFINER commands of 0422; the application role
-- reads. State follows machine output_container (0421, kernel state engine):
--   OPEN -CLOSE-> CLOSED -HOLD-> HELD -SORT-> SORTED; HELD or SORTED -REJECT-> REJECTED;
--   HELD or SORTED -RELEASE [Sig OUTPUT_CONTAINER_RELEASED]-> RELEASED_BY_QA; RELEASED_BY_QA -HOLD-> HELD.
-- The guards below bind CLOSE to a recorded close and HOLD to a hold row of this transaction (or one
-- recorded while the container was still open), so platform.transition called directly cannot close or
-- hold a container the records do not support.
--
-- Messages: plain language, then the rule and the code EBMR-CNT-NNN (output containers).

-- The equipment migrations (0400-0419) create the same schema; whichever runs first creates it.
create schema if not exists plant authorization ebmr_owner;
revoke all on schema plant from public;
grant usage on schema plant to ebmr_app;

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Signature type: QA release of a held container (vendor minimum type, insert-only catalogue)
-- ---------------------------------------------------------------------------------------------

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (recipe-core migration 0420_output_containers)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'signature type of the quality-unit release of a held output container (L-30, TB-11)'));

insert into esig.meaning_type (code, version, origin, is_minimum, status, category, role_class, title, meaning_text, permissions,
                               independent_of, excludes_performers, excludes_involved, witness, reauth, delegable, sources)
values ('OUTPUT_CONTAINER_RELEASED', 1, 'VENDOR', true, 'ACTIVE', 'EXCEPTION', 'AUTHORISER', 'Held output container released',
        'Quality-unit release: I assessed the hold of this output container and release its content for further use.',
        array['QA.FLOOR_APPROVE'], '{}', true, false, false, 'ALL_COMPONENTS', false,
        'Outline 5.2.9 output containers (L-30); TB-11 bracketing hold');

select kernel.set_actor_context(null);

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table plant.press_discharge (
  press_code         text not null check (press_code ~ '^[A-Za-z0-9][A-Za-z0-9/._-]{0,39}$'),
  version            integer not null check (version >= 1),
  separate_streams   boolean not null,
  person_id          uuid not null,
  account_id         uuid not null,
  recorded_at        timestamptz not null default clock_timestamp(),
  primary key (press_code, version)
);
revoke all on plant.press_discharge from public;

create table plant.output_container (
  id                 uuid primary key default gen_random_uuid(),
  label_code         text not null unique check (label_code ~ '^OC-[A-Za-z0-9][A-Za-z0-9/._-]{0,39}-[0-9]{4,}$'),
  batch_id           uuid not null references recipe.batch_execution (id),
  batch_number       text not null check (btrim(batch_number) <> ''),
  product_code       text not null check (btrim(product_code) <> ''),
  strength           text not null check (btrim(strength) <> ''),
  stage              text not null check (stage ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  press_code         text check (press_code ~ '^[A-Za-z0-9][A-Za-z0-9/._-]{0,39}$'),
  stream             text check (stream ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
  quantity_unit      text not null check (quantity_unit in ('kg', 'g', 'units')),
  opened_at          timestamptz not null default clock_timestamp(),
  opened_by_person   uuid not null,
  opened_by_account  uuid not null,
  check (stream is null or press_code is not null)
);
revoke all on plant.output_container from public;
create index output_container_press on plant.output_container (batch_id, press_code, opened_at);

create table plant.container_close (
  container_id       uuid primary key references plant.output_container (id),
  net_quantity       numeric not null check (net_quantity > 0),
  person_id          uuid not null,
  account_id         uuid not null,
  closed_at          timestamptz not null default clock_timestamp()
);
revoke all on plant.container_close from public;

create table plant.ipc_check (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null references recipe.batch_execution (id),
  press_code         text not null check (press_code ~ '^[A-Za-z0-9][A-Za-z0-9/._-]{0,39}$'),
  stream             text check (stream ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$'),
  result             text not null check (result in ('PASS', 'FAIL', 'MISSED')),
  reference          text not null check (btrim(reference) <> ''),
  person_id          uuid not null,
  account_id         uuid not null,
  recorded_at        timestamptz not null default clock_timestamp()
);
revoke all on plant.ipc_check from public;
create index ipc_check_press on plant.ipc_check (batch_id, press_code, recorded_at);

create table plant.container_hold (
  id                 uuid primary key default gen_random_uuid(),
  container_id       uuid not null references plant.output_container (id),
  ipc_check_id       uuid not null references plant.ipc_check (id),
  via_container_id   uuid references plant.output_container (id),
  xact_id            xid8 not null default pg_current_xact_id(),
  person_id          uuid not null,
  account_id         uuid not null,
  recorded_at        timestamptz not null default clock_timestamp(),
  unique (container_id, ipc_check_id),
  check (via_container_id is distinct from container_id)
);
revoke all on plant.container_hold from public;

create table plant.container_merge (
  id                 uuid primary key default gen_random_uuid(),
  source_id          uuid not null unique references plant.output_container (id),
  target_id          uuid not null references plant.output_container (id),
  person_id          uuid not null,
  account_id         uuid not null,
  recorded_at        timestamptz not null default clock_timestamp(),
  check (source_id <> target_id)
);
revoke all on plant.container_merge from public;
create index container_merge_target on plant.container_merge (target_id);

create table plant.container_charge (
  id                 uuid primary key default gen_random_uuid(),
  container_id       uuid not null unique references plant.output_container (id),
  batch_id           uuid not null references recipe.batch_execution (id),
  stage              text not null check (stage ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  purpose            text not null check (purpose in ('CHARGE', 'PACK')),
  scanned_label      text not null,
  person_id          uuid not null,
  account_id         uuid not null,
  recorded_at        timestamptz not null default clock_timestamp()
);
revoke all on plant.container_charge from public;

select platform.enforce_db_time('plant.press_discharge', array['recorded_at']);
select platform.enforce_db_time('plant.output_container', array['opened_at']);
select platform.enforce_db_time('plant.container_close', array['closed_at']);
select platform.enforce_db_time('plant.ipc_check', array['recorded_at']);
select platform.enforce_db_time('plant.container_hold', array['recorded_at']);
select platform.enforce_db_time('plant.container_merge', array['recorded_at']);
select platform.enforce_db_time('plant.container_charge', array['recorded_at']);

select kernel.register_audited_table('plant.press_discharge', 'press_discharge', 'press_code', true);
select kernel.register_audited_table('plant.output_container', 'output_container', 'id', true);
select kernel.register_audited_table('plant.container_close', 'output_container', 'container_id', true);
select kernel.register_audited_table('plant.ipc_check', 'output_container_ipc', 'id', true);
select kernel.register_audited_table('plant.container_hold', 'output_container', 'container_id', true);
select kernel.register_audited_table('plant.container_merge', 'output_container', 'target_id', true);
select kernel.register_audited_table('plant.container_charge', 'output_container', 'container_id', true);

grant select on plant.press_discharge, plant.output_container, plant.container_close, plant.ipc_check, plant.container_hold, plant.container_merge,
                plant.container_charge to ebmr_app;

-- ---------------------------------------------------------------------------------------------
-- Derived facts
-- ---------------------------------------------------------------------------------------------

create function plant.container_state(p_container uuid) returns text
language sql stable security definer set search_path = pg_catalog, platform, pg_temp as $$
  select s.state from platform.aggregate_state s where s.aggregate_type = 'output_container' and s.aggregate_id = p_container
$$;

create function plant.container_closed_at(p_container uuid) returns timestamptz
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select x.closed_at from plant.container_close x where x.container_id = p_container
$$;

-- Whether the press's streams discharge into separate containers (newest configuration; false when
-- the press was never configured: then a failed check holds the whole press output, the stricter rule).
create function plant.press_streams_separate(p_press text) returns boolean
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select coalesce((select d.separate_streams from plant.press_discharge d where d.press_code = p_press order by d.version desc limit 1), false)
$$;

-- TB-11 bracketing: a closed container of a press is vouched for only once, for its own stream and every
-- check series (stream) recorded for its batch and press, a passing check of that series (or of the whole
-- press) was recorded at or after its close. Before that, a later failure could still hold it. Returns the
-- reason it is not bracketed, or NULL. Containers without a press are not under periodic IPC.
create function plant.bracketing_problem(c plant.output_container, p_closed_at timestamptz) returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  with series as (
    select distinct k.stream from plant.ipc_check k
    where k.batch_id = c.batch_id and k.press_code = c.press_code
      and (not plant.press_streams_separate(c.press_code) or c.stream is null or k.stream is null or k.stream = c.stream)
    union
    select c.stream where c.stream is not null
  )
  select case
    when c.press_code is null or p_closed_at is null then null
    when not exists (select 1 from plant.ipc_check k where k.batch_id = c.batch_id and k.press_code = c.press_code and k.result = 'PASS'
                       and k.recorded_at >= p_closed_at
                       and (not plant.press_streams_separate(c.press_code) or c.stream is null or k.stream is null or k.stream = c.stream))
      then format('no passing in-process check of press %s was recorded after container %s was closed', c.press_code, c.label_code)
    else (select format('stream %s of press %s has no passing in-process check recorded after container %s was closed',
                        coalesce(s.stream, '(whole press)'), c.press_code, c.label_code)
          from series s
          where not exists (select 1 from plant.ipc_check k
                            where k.batch_id = c.batch_id and k.press_code = c.press_code and k.result = 'PASS' and k.recorded_at >= p_closed_at
                              and (k.stream is null or k.stream = s.stream))
          order by s.stream nulls first limit 1)
  end
$$;

-- Why the container cannot be merged, charged or packed now, or NULL when it can (L-30, TB-11).
-- Usable: CLOSED and bracketed by passing checks, or RELEASED_BY_QA; never held (nor holding a hold
-- that will apply at its close), never already charged or merged away.
create function plant.container_usable_problem(p_container uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  c       plant.output_container;
  v_state text := plant.container_state(p_container);
begin
  select * into c from plant.output_container where id = p_container;
  if not found then
    return 'the container does not exist';
  end if;
  if v_state in ('HELD', 'SORTED') then
    return format('container %s is %s: held containers are never merged, charged or packed until QA releases them', c.label_code, v_state);
  end if;
  if v_state = 'REJECTED' then
    return format('container %s is REJECTED', c.label_code);
  end if;
  if exists (select 1 from plant.container_hold h where h.container_id = c.id) and v_state <> 'RELEASED_BY_QA' then
    return format('container %s is under a hold that applies when it is closed', c.label_code);
  end if;
  if v_state = 'OPEN' then
    return format('container %s is still open', c.label_code);
  end if;
  if exists (select 1 from plant.container_charge g where g.container_id = c.id) then
    return format('container %s was already charged or packed', c.label_code);
  end if;
  if exists (select 1 from plant.container_merge m where m.source_id = c.id) then
    return format('container %s was already merged into another container', c.label_code);
  end if;
  if v_state = 'CLOSED' then
    return plant.bracketing_problem(c, plant.container_closed_at(c.id));
  end if;
  if v_state = 'RELEASED_BY_QA' then
    return null;
  end if;
  return format('container %s is in state %s', c.label_code, coalesce(v_state, '(none)'));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- State-engine guards (they run inside platform.transition with the state row locked)
-- ---------------------------------------------------------------------------------------------

create function plant.guard_container_closed(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language sql stable set search_path = pg_catalog, plant, pg_temp as $$
  select case when c.id is null then 'the output container does not exist'
              when x.container_id is null then 'the close (net quantity, closing person) is not recorded; close it with plant.close_container' end
  from (select 1) d left join plant.output_container c on c.id = p_aggregate_id left join plant.container_close x on x.container_id = c.id
$$;
select platform.register_guard('output_container.closed', 'plant.guard_container_closed(text, uuid, jsonb, jsonb, jsonb)',
                               'The output container''s close (net quantity, person, database time) is recorded');

-- A hold transition needs a hold row recorded in this transaction (a failing or missed check, or a
-- merge propagation), or, at the close, a hold recorded while the container was open.
create function plant.guard_hold_recorded(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language sql stable set search_path = pg_catalog, plant, pg_temp as $$
  select case when not exists (
    select 1 from plant.container_hold h left join plant.container_close x on x.container_id = h.container_id
    where h.container_id = p_aggregate_id
      and (h.xact_id = pg_current_xact_id() or (p_transition ->> 'from' = 'CLOSED' and x.closed_at is not null and h.recorded_at <= x.closed_at)))
  then 'no failing or missed in-process check holds this container (record it with plant.record_ipc_check)' end
$$;
select platform.register_guard('output_container.hold_recorded', 'plant.guard_hold_recorded(text, uuid, jsonb, jsonb, jsonb)',
                               'A failing or missed in-process check recorded the hold of this output container');

-- ---------------------------------------------------------------------------------------------
-- E-signature content provider: what QA signs when releasing a held container
-- ---------------------------------------------------------------------------------------------

create function plant.output_container_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  c       plant.output_container;
  x       plant.container_close;
  v_holds jsonb;
  v_by    jsonb;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into c from plant.output_container where id = p_id::uuid;
  if not found then
    return '{"exists": false}'::jsonb;
  end if;
  select * into x from plant.container_close where container_id = c.id;
  select coalesce(jsonb_agg(jsonb_build_object('ipc_check_id', k.id, 'result', k.result, 'press', k.press_code, 'stream', k.stream,
                                               'reference', k.reference, 'recorded_at', k.recorded_at, 'via_container_id', h.via_container_id)
                            order by h.recorded_at, h.id), '[]'::jsonb)
    into v_holds
    from plant.container_hold h join plant.ipc_check k on k.id = h.ipc_check_id where h.container_id = c.id;
  select coalesce(jsonb_agg(distinct p), '[]'::jsonb) into v_by
    from (select c.opened_by_person as p union all select x.person_id
          union all select k.person_id from plant.container_hold h join plant.ipc_check k on k.id = h.ipc_check_id where h.container_id = c.id) x
   where p is not null;
  return jsonb_build_object(
    'exists', true,
    'content_version', 1 + (case when x.container_id is null then 0 else 1 end) + jsonb_array_length(v_holds),
    'content', jsonb_build_object('label_code', c.label_code, 'batch_id', c.batch_id, 'batch_number', c.batch_number,
                                  'product_code', c.product_code, 'strength', c.strength, 'stage', c.stage, 'press_code', c.press_code,
                                  'stream', c.stream, 'net_quantity', x.net_quantity::text, 'quantity_unit', c.quantity_unit,
                                  'opened_at', c.opened_at, 'closed_at', x.closed_at, 'holds', v_holds),
    'state', plant.container_state(c.id),
    'scope', jsonb_build_object('product', c.product_code),
    'entered_by', v_by);
end
$$;

select esig.register_content_provider('output_container', 'plant.output_container_content(text)',
                                      'output container (label, batch, stage, press, net quantity and its holds)');

grant execute on function plant.container_state(uuid), plant.container_closed_at(uuid), plant.press_streams_separate(text), plant.container_usable_problem(uuid) to ebmr_app;

reset role;
