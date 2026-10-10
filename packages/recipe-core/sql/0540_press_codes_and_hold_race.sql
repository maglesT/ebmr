-- Recipe core, Phase 3 slice 3c (builder A): press codes of the output containers are plant equipment, the close and
-- IPC hold race (slice 1 review backlog #8), and the transition scope of a unit (slice 3a review backlog #6).
-- Controls: IN-21, IN-26 (c), INV-12, PR-22, PR-23, DI-17; ADR 0012 (the rules hold when the application's own
-- database credentials are used directly).
--
--   * Press codes (open items of slice 1: "container press codes are not checked against plant.equipment"): the press a
--     container is opened on, an in-process check is recorded for and a discharge configuration names is a unit of
--     plant.equipment of kind PROCESS that is not retired (plant.press_unit_problem; EBMR-CNT-023). A free-text press
--     code could split one press's output into two check series and escape its hold. plant.open_container (from 0504),
--     plant.record_ipc_check and plant.configure_press_discharge (from 0422) are replaced from their latest definitions
--     with that check added; nothing else of them changes except the lock below.
--   * Backlog #8 (close and IPC hold race): plant.apply_hold (from 0422) reads the container's state row FOR UPDATE, so
--     the state it acts on and the version it hands to the state engine are the ones it holds; and plant.record_ipc_check
--     takes the batch's container lock (the advisory lock plant.open_container takes) before it records the check, so a
--     container being opened while a failing check is recorded is either committed before the check (and seen, and held)
--     or opened after it (outside its window). Previously a container opened in that instant could miss the hold.
--   * Backlog #6 (slice 3a review): plant.transition_scope (from 0523) evaluated a step.execute transition on a unit with
--     the product of the unit's latest use, so a transition other than START_USE or END_USE on a unit last used for
--     another product was checked against that other product. It now takes the product of the use this transaction
--     starts or ends (the use START_USE starts is inserted before the move; the end row END_USE writes, too), and no
--     product otherwise: a grant without a product limit matches as before, a product-limited grant is refused for a
--     transition that belongs to no use (fails closed, as before, but never against an unrelated product).
--
-- Every function keeps its owner (ebmr_owner), its grants and pg_temp last (ADR 0016). Applied as a new migration because
-- applied migrations are checksummed and never edited.

set local role ebmr_owner;

-- Why p_press is not a press a container, an in-process check or a discharge configuration may name; NULL when it is a
-- PROCESS unit of plant.equipment that is not retired.
create function plant.press_unit_problem(p_press text) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  e plant.equipment;
begin
  select * into e from plant.equipment where code = p_press;
  if not found then
    return format('%s is no unit of the plant equipment list', coalesce(p_press, '(none)'));
  end if;
  if e.kind <> 'PROCESS' then
    return format('%s is %s equipment, not a press (a PROCESS unit)', e.code, e.kind);
  end if;
  if plant.equipment_fitness(e.id) = 'RETIRED' then
    return format('%s is retired', e.code);
  end if;
  return null;
end
$$;
revoke all on function plant.press_unit_problem(text) from public;
grant execute on function plant.press_unit_problem(text) to ebmr_app;

-- As 0422, with the press checked against plant.equipment.
create or replace function plant.configure_press_discharge(p_press text, p_separate_streams boolean) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, kernel, pg_temp as $$
declare
  v_actor   jsonb;
  v_version integer;
  v_problem text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  if p_separate_streams is null then
    raise exception using errcode = 'P0001', message = 'State whether the press''s streams discharge into separate containers (EBMR-CNT-010)';
  end if;
  v_problem := plant.press_unit_problem(p_press);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('A discharge configuration names a press of the plant: %s (PR-22; EBMR-CNT-023)', v_problem);
  end if;
  perform pg_advisory_xact_lock(hashtext('plant.press_discharge:' || coalesce(p_press, '')));
  v_version := coalesce((select max(version) from plant.press_discharge where press_code = p_press), 0) + 1;
  insert into plant.press_discharge (press_code, version, separate_streams, person_id, account_id)
  values (p_press, v_version, p_separate_streams, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  return jsonb_build_object('press_code', p_press, 'version', v_version, 'separate_streams', p_separate_streams);
end
$$;

-- As 0504, with the press checked against plant.equipment.
create or replace function plant.open_container(p_batch uuid, p_stage text, p_unit text, p_press text default null, p_stream text default null)
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, recipe, iam, kernel, platform, pg_temp as $$
declare
  v_actor   jsonb;
  b         recipe.batch_execution;
  v_prod    jsonb;
  v_id      uuid := gen_random_uuid();
  v_label   text;
  v_n       integer;
  v_state   jsonb;
  v_problem text;
begin
  perform iam.assert_not_administrator();
  select * into b from recipe.batch_execution where id = p_batch;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-CNT-020)', p_batch);
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  v_prod := recipe.batch_product(p_batch);
  if coalesce(btrim(v_prod ->> 'code'), '') = '' or coalesce(btrim(v_prod ->> 'strength'), '') = '' then
    raise exception using errcode = 'P0001',
      message = format('Batch %s names no product code and strength; a container carries both (IN-21; EBMR-CNT-021)', b.batch_number);
  end if;
  if p_stream is not null and p_press is null then
    raise exception using errcode = 'P0001', message = 'A stream belongs to a press: name the press (EBMR-CNT-022)';
  end if;
  if p_press is not null then
    v_problem := plant.press_unit_problem(p_press);
    if v_problem is not null then
      raise exception using errcode = 'P0001', message = format('A container is opened on a press of the plant: %s (PR-22, IN-21; EBMR-CNT-023)', v_problem);
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtext('plant.output_container:' || p_batch::text));
  v_n := (select count(*) from plant.output_container where batch_id = p_batch) + 1;
  v_label := format('OC-%s-%s', b.batch_number, lpad(v_n::text, 4, '0'));
  insert into plant.output_container (id, label_code, batch_id, batch_number, product_code, strength, stage, press_code, stream, quantity_unit,
                                      opened_by_person, opened_by_account)
  values (v_id, v_label, p_batch, b.batch_number, v_prod ->> 'code', v_prod ->> 'strength', p_stage, p_press, p_stream, p_unit,
          (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  v_state := platform.create_aggregate_state('output_container', 'output_container', v_id);
  return jsonb_build_object('container_id', v_id, 'label_code', v_label, 'state', v_state ->> 'state', 'version', (v_state ->> 'version')::bigint);
end
$$;

-- As 0422, with the state row locked (backlog #8).
create or replace function plant.apply_hold(p_container uuid) returns text
language plpgsql volatile security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  s platform.aggregate_state;
begin
  select * into s from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = p_container for update;
  if s.state in ('CLOSED', 'RELEASED_BY_QA') then
    perform platform.transition('output_container', 'output_container', p_container, 'HOLD', s.version, '{}'::jsonb);
    return 'HELD';
  end if;
  return s.state;
end
$$;

-- As 0422, with the press checked against plant.equipment and the batch's container lock taken before the check is
-- recorded (backlog #8).
create or replace function plant.record_ipc_check(p_batch uuid, p_press text, p_stream text, p_result text, p_reference text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, recipe, iam, kernel, platform, pg_temp as $$
declare
  v_actor    jsonb;
  k          plant.ipc_check;
  v_lp       timestamptz;
  v_sep      boolean;
  v_direct   uuid[];
  v_held     jsonb := '[]'::jsonb;
  v_pending  jsonb := '[]'::jsonb;
  v_charged  jsonb := '[]'::jsonb;
  r          record;
  v_state    text;
  v_problem  text;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.batch_execution where id = p_batch) then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-CNT-020)', p_batch);
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  v_problem := plant.press_unit_problem(p_press);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('An in-process check is recorded for a press of the plant: %s (PR-22; EBMR-CNT-023)', v_problem);
  end if;
  -- Checks of one batch and press are recorded one at a time, so "the last passing check before this one" is exact.
  perform pg_advisory_xact_lock(hashtext('plant.ipc_check:' || p_batch::text || ':' || coalesce(p_press, '')));
  -- Backlog #8: no container of the batch is being opened while the check is recorded (plant.open_container's lock).
  perform pg_advisory_xact_lock(hashtext('plant.output_container:' || p_batch::text));
  insert into plant.ipc_check (batch_id, press_code, stream, result, reference, person_id, account_id)
  values (p_batch, p_press, p_stream, p_result, p_reference, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning * into k;
  if k.result = 'PASS' then
    return jsonb_build_object('ipc_check_id', k.id, 'result', k.result, 'held', v_held, 'pending', v_pending, 'already_charged', v_charged);
  end if;

  -- The last passing check of the same series (stream) or of the whole press, recorded strictly before this one; a
  -- whole-press failure counts only whole-press passes. None: the interval runs from the first container.
  select max(x.recorded_at) into v_lp from plant.ipc_check x
  where x.batch_id = p_batch and x.press_code = p_press and x.result = 'PASS' and x.recorded_at < k.recorded_at
    and (x.stream is null or x.stream = p_stream);
  v_sep := plant.press_streams_separate(p_press);

  -- Containers whose open interval [opened_at, closed_at or still open] overlaps (last pass, this check].
  select coalesce(array_agg(c.id order by c.opened_at, c.id), '{}') into v_direct
  from plant.output_container c left join plant.container_close x on x.container_id = c.id
  where c.batch_id = p_batch and c.press_code = p_press
    and c.opened_at <= k.recorded_at
    and coalesce(x.closed_at, 'infinity'::timestamptz) > coalesce(v_lp, '-infinity'::timestamptz)
    and (not v_sep or p_stream is null or c.stream is null or c.stream = p_stream);

  -- Merge targets carry the content of a held source: the hold reaches every container it was poured into.
  for r in
    with recursive reach (id, via) as (
      select d, null::uuid from unnest(v_direct) d
      union
      select m.target_id, coalesce(rr.via, rr.id) from plant.container_merge m join reach rr on m.source_id = rr.id
    )
    select distinct on (x.id) x.id, x.via, c.label_code from reach x join plant.output_container c on c.id = x.id order by x.id, x.via nulls first
  loop
    insert into plant.container_hold (container_id, ipc_check_id, via_container_id, person_id, account_id)
    values (r.id, k.id, r.via, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
    on conflict (container_id, ipc_check_id) do nothing;
    v_state := plant.apply_hold(r.id);
    if v_state = 'OPEN' then
      v_pending := v_pending || to_jsonb(r.label_code);
    else
      v_held := v_held || to_jsonb(r.label_code);
    end if;
    if exists (select 1 from plant.container_charge g where g.container_id = r.id) then
      v_charged := v_charged || to_jsonb(r.label_code);
    end if;
  end loop;
  return jsonb_build_object('ipc_check_id', k.id, 'result', k.result, 'last_passing_check_at', v_lp, 'held', v_held, 'pending', v_pending,
                            'already_charged', v_charged);
end
$$;

-- As 0523, with the product of the use this transaction starts or ends (backlog #6, header).
create or replace function plant.transition_scope(p_permission text, p_aggregate_type text, p_aggregate_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_product text;
begin
  if lower(coalesce(p_permission, '')) <> 'step.execute' or p_aggregate_id is null
     or p_aggregate_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{}'::jsonb;
  end if;
  if p_aggregate_type = 'plant_equipment' then
    -- The use started in this transaction (START_USE), else the use whose end this transaction recorded (END_USE).
    select u.product_code into v_product from plant.equipment_use u
     where u.equipment_id = p_aggregate_id::uuid and u.started_at >= transaction_timestamp()
     order by u.started_at desc, u.id desc limit 1;
    if v_product is null then
      select u.product_code into v_product from plant.equipment_use u join plant.equipment_use_end x on x.use_id = u.id
       where u.equipment_id = p_aggregate_id::uuid and x.ended_at >= transaction_timestamp()
       order by x.ended_at desc, u.id desc limit 1;
    end if;
  elsif p_aggregate_type = 'output_container' then
    select c.product_code into v_product from plant.output_container c where c.id = p_aggregate_id::uuid;
  end if;
  return case when v_product is null then '{}'::jsonb else jsonb_build_object('product', v_product) end;
end
$$;

reset role;
