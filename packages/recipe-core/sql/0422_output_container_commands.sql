-- Plant, output containers, part 3: the commands (build outline 5.2.9 "Output containers", L-30; TB-11; IN-21;
-- IN-26 (c)). Every function is SECURITY DEFINER, refuses administrators (DI-18) and checks its permission (DI-17)
-- in the product scope of the batch; state changes go through platform.transition on machine output_container
-- (0421), whose guards (0420) bind each change to the rows recorded here.
--
--   configure_press_discharge  MASTERDATA.CHANGE  whether a press's streams discharge into separate containers
--   open_container             STEP.EXECUTE       a new container of a batch and stage; label generated, product
--                                                 and strength taken from the batch (IN-21)
--   close_container            STEP.EXECUTE       net quantity, database close time; HELD at once when a check
--                                                 failed while it was open
--   record_ipc_check           STEP.EXECUTE       PASS, FAIL or MISSED; a FAIL or MISSED holds every container of
--                                                 the batch and press whose open interval overlaps (last passing
--                                                 check before it, the check], per stream only when the press's
--                                                 streams discharge separately; holds reach merge targets
--   sort_container             STEP.EXECUTE       HELD -> SORTED (reason)
--   reject_container           QA.FLOOR_APPROVE   HELD/SORTED -> REJECTED (reason)
--   release_container          QA.FLOOR_APPROVE   HELD/SORTED -> RELEASED_BY_QA (signature OUTPUT_CONTAINER_RELEASED)
--   charge_container           STEP.EXECUTE       scan at charging or packing: refused for a label of another batch
--                                                 (IN-26 (c)) and for a container that is not usable (TB-11)
--   merge_container            STEP.EXECUTE       a usable container poured into an open one of the same batch and stage
--
-- Times are the database's: an IPC check, a hold, a close is stamped when it is recorded. A check's sample time is
-- not taken from the caller; the window therefore runs from the recording of the last passing check to the recording
-- of the failing one, which can only be wider than the sampling interval.

set local role ebmr_owner;

create function plant.batch_scope(p_batch uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, recipe, pg_temp as $$
  select jsonb_build_object('product', p.product ->> 'code')
  from recipe.batch_execution b join recipe.test_package p on p.package_hash = b.package_hash where b.id = p_batch
$$;

-- ---------------------------------------------------------------------------------------------
-- Press configuration
-- ---------------------------------------------------------------------------------------------

create function plant.configure_press_discharge(p_press text, p_separate_streams boolean) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, kernel, pg_temp as $$
declare
  v_actor   jsonb;
  v_version integer;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('MASTERDATA.CHANGE', '{}'::jsonb);
  if p_separate_streams is null then
    raise exception using errcode = 'P0001', message = 'State whether the press''s streams discharge into separate containers (EBMR-CNT-010)';
  end if;
  perform pg_advisory_xact_lock(hashtext('plant.press_discharge:' || coalesce(p_press, '')));
  v_version := coalesce((select max(version) from plant.press_discharge where press_code = p_press), 0) + 1;
  insert into plant.press_discharge (press_code, version, separate_streams, person_id, account_id)
  values (p_press, v_version, p_separate_streams, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  return jsonb_build_object('press_code', p_press, 'version', v_version, 'separate_streams', p_separate_streams);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Open and close
-- ---------------------------------------------------------------------------------------------

create function plant.open_container(p_batch uuid, p_stage text, p_unit text, p_press text default null, p_stream text default null)
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, recipe, iam, kernel, platform, pg_temp as $$
declare
  v_actor  jsonb;
  b        recipe.batch_execution;
  v_prod   jsonb;
  v_id     uuid := gen_random_uuid();
  v_label  text;
  v_n      integer;
  v_state  jsonb;
begin
  perform iam.assert_not_administrator();
  select * into b from recipe.batch_execution where id = p_batch;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-CNT-020)', p_batch);
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  select p.product into v_prod from recipe.test_package p where p.package_hash = b.package_hash;
  if coalesce(btrim(v_prod ->> 'code'), '') = '' or coalesce(btrim(v_prod ->> 'strength'), '') = '' then
    raise exception using errcode = 'P0001',
      message = format('Batch %s names no product code and strength; a container carries both (IN-21; EBMR-CNT-021)', b.batch_number);
  end if;
  if p_stream is not null and p_press is null then
    raise exception using errcode = 'P0001', message = 'A stream belongs to a press: name the press (EBMR-CNT-022)';
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

-- Applies the HOLD transition where the state allows it; OPEN containers keep the hold row and are held at their
-- close; HELD, SORTED and REJECTED ones already are out of use.
create function plant.apply_hold(p_container uuid) returns text
language plpgsql volatile security definer set search_path = pg_catalog, plant, platform, pg_temp as $$
declare
  s platform.aggregate_state;
begin
  select * into s from platform.aggregate_state where aggregate_type = 'output_container' and aggregate_id = p_container;
  if s.state in ('CLOSED', 'RELEASED_BY_QA') then
    perform platform.transition('output_container', 'output_container', p_container, 'HOLD', s.version, '{}'::jsonb);
    return 'HELD';
  end if;
  return s.state;
end
$$;

create function plant.close_container(p_container uuid, p_net_quantity numeric, p_expected_version bigint) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, kernel, platform, pg_temp as $$
declare
  v_actor jsonb;
  c       plant.output_container;
  v_r     jsonb;
  v_state text;
begin
  perform iam.assert_not_administrator();
  select * into c from plant.output_container where id = p_container for update;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown output container %s (EBMR-CNT-030)', p_container);
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', c.product_code));
  if p_net_quantity is null or p_net_quantity <= 0 then
    raise exception using errcode = 'P0001', message = format('Container %s is closed with its net quantity, above zero (L-30; EBMR-CNT-031)', c.label_code);
  end if;
  if exists (select 1 from plant.container_close where container_id = p_container) then
    raise exception using errcode = 'P0001', message = format('Container %s is closed already; it is closed once (L-30; EBMR-CNT-032)', c.label_code);
  end if;
  insert into plant.container_close (container_id, net_quantity, person_id, account_id)
  values (p_container, p_net_quantity, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  -- In any state but OPEN the engine refuses the event (EBMR-PLAT-066/067) and the close above rolls back with it.
  v_r := platform.transition('output_container', 'output_container', p_container, 'CLOSE', p_expected_version, '{}'::jsonb);
  v_state := v_r ->> 'to';
  if exists (select 1 from plant.container_hold h where h.container_id = p_container) then
    v_state := plant.apply_hold(p_container);
  end if;
  return jsonb_build_object('container_id', p_container, 'label_code', c.label_code, 'state', v_state,
                            'version', (select s.version from platform.aggregate_state s where s.aggregate_type = 'output_container' and s.aggregate_id = p_container));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- In-process checks and the hold
-- ---------------------------------------------------------------------------------------------

create function plant.record_ipc_check(p_batch uuid, p_press text, p_stream text, p_result text, p_reference text) returns jsonb
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
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.batch_execution where id = p_batch) then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-CNT-020)', p_batch);
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  -- Checks of one batch and press are recorded one at a time, so "the last passing check before this one" is exact.
  perform pg_advisory_xact_lock(hashtext('plant.ipc_check:' || p_batch::text || ':' || coalesce(p_press, '')));
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

-- ---------------------------------------------------------------------------------------------
-- Dispositions of a held container
-- ---------------------------------------------------------------------------------------------

create function plant.container_scope(p_container uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select jsonb_build_object('product', c.product_code) from plant.output_container c where c.id = p_container
$$;

create function plant.dispose_container(p_container uuid, p_event text, p_permission text, p_expected_version bigint, p_payload jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, kernel, platform, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from plant.output_container where id = p_container) then
    raise exception using errcode = 'P0001', message = format('Unknown output container %s (EBMR-CNT-030)', p_container);
  end if;
  perform iam.require_permission(p_permission, plant.container_scope(p_container));
  return platform.transition('output_container', 'output_container', p_container, p_event, p_expected_version, p_payload);
end
$$;

create function plant.sort_container(p_container uuid, p_expected_version bigint) returns jsonb
language sql volatile security definer set search_path = pg_catalog, plant, pg_temp as $$
  select plant.dispose_container(p_container, 'SORT', 'STEP.EXECUTE', p_expected_version, '{}'::jsonb)
$$;

create function plant.reject_container(p_container uuid, p_expected_version bigint) returns jsonb
language sql volatile security definer set search_path = pg_catalog, plant, pg_temp as $$
  select plant.dispose_container(p_container, 'REJECT', 'QA.FLOOR_APPROVE', p_expected_version, '{}'::jsonb)
$$;

create function plant.release_container(p_container uuid, p_expected_version bigint, p_signature_id uuid) returns jsonb
language sql volatile security definer set search_path = pg_catalog, plant, pg_temp as $$
  select plant.dispose_container(p_container, 'RELEASE', 'QA.FLOOR_APPROVE', p_expected_version,
                                 jsonb_build_object('signature_id', p_signature_id))
$$;

-- ---------------------------------------------------------------------------------------------
-- Charge scan and merge
-- ---------------------------------------------------------------------------------------------

-- The label scanned at charging (or packing) must name a container of the batch being charged (IN-26 (c)), and the
-- container must be usable: never held, sorted, rejected, open, unbracketed, already charged or merged away (TB-11).
create function plant.charge_container(p_batch uuid, p_stage text, p_scanned_label text, p_purpose text default 'CHARGE') returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, recipe, iam, kernel, platform, pg_temp as $$
declare
  v_actor   jsonb;
  b         recipe.batch_execution;
  c         plant.output_container;
  v_problem text;
  v_id      uuid;
begin
  perform iam.assert_not_administrator();
  select * into b from recipe.batch_execution where id = p_batch;
  if not found then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-CNT-020)', p_batch);
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  select * into c from plant.output_container where label_code = p_scanned_label for update;
  if not found then
    raise exception using errcode = 'P0001',
      message = format('The scanned label %s names no output container; scan refused (IN-26 (c); EBMR-CNT-040)', coalesce(p_scanned_label, '(none)'));
  end if;
  if c.batch_id <> p_batch then
    raise exception using errcode = 'P0001',
      message = format('Container %s is labelled for batch %s, not batch %s; scan refused (IN-26 (c); EBMR-CNT-041)', c.label_code, c.batch_number,
                       b.batch_number);
  end if;
  -- The state row is locked so a hold recorded concurrently is either seen here or waits for this charge.
  perform 1 from platform.aggregate_state s where s.aggregate_type = 'output_container' and s.aggregate_id = c.id for update;
  v_problem := plant.container_usable_problem(c.id);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('Container %s cannot be %s: %s (L-30, TB-11; EBMR-CNT-042)', c.label_code,
                                                              case p_purpose when 'PACK' then 'packed' else 'charged' end, v_problem);
  end if;
  insert into plant.container_charge (container_id, batch_id, stage, purpose, scanned_label, person_id, account_id)
  values (c.id, p_batch, p_stage, p_purpose, p_scanned_label, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return jsonb_build_object('charge_id', v_id, 'container_id', c.id, 'label_code', c.label_code,
                            'net_quantity', (select x.net_quantity::text from plant.container_close x where x.container_id = c.id),
                            'quantity_unit', c.quantity_unit);
end
$$;

create function plant.merge_container(p_source_label text, p_target_label text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, kernel, platform, pg_temp as $$
declare
  v_actor   jsonb;
  s         plant.output_container;
  t         plant.output_container;
  v_problem text;
  v_id      uuid;
begin
  perform iam.assert_not_administrator();
  select * into s from plant.output_container where label_code = p_source_label;
  select * into t from plant.output_container where label_code = p_target_label;
  if s.id is null or t.id is null then
    raise exception using errcode = 'P0001', message = 'A scanned label names no output container; merge refused (IN-26 (c); EBMR-CNT-040)';
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', t.product_code));
  -- Lock both containers' state rows in a fixed order (holds and charges lock the same rows).
  perform 1 from platform.aggregate_state x where x.aggregate_type = 'output_container' and x.aggregate_id in (s.id, t.id)
    order by x.aggregate_id for update;
  if s.batch_id <> t.batch_id or s.stage <> t.stage or s.quantity_unit <> t.quantity_unit then
    raise exception using errcode = 'P0001',
      message = format('Containers %s and %s differ in batch, stage or unit; merge refused (IN-26 (c); EBMR-CNT-043)', s.label_code, t.label_code);
  end if;
  v_problem := plant.container_usable_problem(s.id);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('Container %s cannot be merged: %s (L-30, TB-11; EBMR-CNT-044)', s.label_code, v_problem);
  end if;
  if plant.container_state(t.id) <> 'OPEN' or exists (select 1 from plant.container_hold h where h.container_id = t.id) then
    raise exception using errcode = 'P0001',
      message = format('Container %s is not open or is under a hold; a merge pours only into an open container that is not held (L-30; EBMR-CNT-045)',
                       t.label_code);
  end if;
  insert into plant.container_merge (source_id, target_id, person_id, account_id)
  values (s.id, t.id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
  returning id into v_id;
  return jsonb_build_object('merge_id', v_id, 'source_id', s.id, 'target_id', t.id);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Read view (status on screen, IN-21 identification; screens arrive in slice 6)
-- ---------------------------------------------------------------------------------------------

create view plant.output_container_status with (security_barrier) as
  select c.id, c.label_code, c.batch_id, c.batch_number, c.product_code, c.strength, c.stage, c.press_code, c.stream,
         x.net_quantity, c.quantity_unit, c.opened_at, x.closed_at, s.state, s.version,
         plant.container_usable_problem(c.id) as usable_problem
  from plant.output_container c
  left join plant.container_close x on x.container_id = c.id
  join platform.aggregate_state s on s.aggregate_type = 'output_container' and s.aggregate_id = c.id;
revoke all on plant.output_container_status from public;
grant select on plant.output_container_status to ebmr_app;

grant execute on function
  plant.configure_press_discharge(text, boolean),
  plant.open_container(uuid, text, text, text, text),
  plant.close_container(uuid, numeric, bigint),
  plant.record_ipc_check(uuid, text, text, text, text),
  plant.sort_container(uuid, bigint),
  plant.reject_container(uuid, bigint),
  plant.release_container(uuid, bigint, uuid),
  plant.charge_container(uuid, text, text, text),
  plant.merge_container(text, text)
to ebmr_app;

reset role;
