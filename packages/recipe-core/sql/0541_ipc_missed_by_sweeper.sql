-- Recipe core, Phase 3 slice 3c (builder B, quick review finding 4; lead decision): the execution sweeper records a missed
-- in-process check, and its hold, at the moment its alarm finds the check overdue, without the step-execution right
-- (controls IN-35 (c), PR-29, DI-17, DI-18; ADR 0012).
--
-- The sweeper's service identity holds EXECUTION.SWEEP only (recipe-core 0260, least privilege); plant.record_ipc_check
-- needs STEP.EXECUTE. Instead of widening the sweeper:
--   * plant.ipc_check_record (internal, granted to nobody): the body of plant.record_ipc_check from its latest definition
--     (0540) after its permission check, unchanged (press check, the two locks, the check row, the last passing check, the
--     hold window, merge targets, the hold rows), taking the actor the caller checked; with p_transition false it does not
--     move a container's state (the state engine's HOLD transition needs STEP.EXECUTE), so the hold rows alone keep the
--     container out of use (plant.container_usable_problem) until a person's next check moves it to HELD;
--   * plant.record_ipc_check, replaced from 0540: refuses administrators, checks STEP.EXECUTE, then the internal function
--     (its behaviour is unchanged);
--   * plant.record_missed_ipc_check: refuses administrators, checks EXECUTION.SWEEP, and records a MISSED check only,
--     through the same internal function; granted to the application role. Called by tab.record_ipc_overdue (tablets
--     0893) for the sweeper's alarm.
--
-- Every function keeps its owner (ebmr_owner) and pg_temp last (ADR 0016). Applied as a new migration because applied
-- migrations are checksummed and never edited.

set local role ebmr_owner;

create function plant.ipc_check_record(p_batch uuid, p_press text, p_stream text, p_result text, p_reference text, v_actor jsonb, p_transition boolean)
returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, recipe, iam, kernel, platform, pg_temp as $$
declare
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
    -- The state engine's HOLD needs STEP.EXECUTE: without it (p_transition false) the hold row alone keeps the
    -- container out of use (plant.container_usable_problem) until a person's next check moves it to HELD.
    v_state := case when p_transition then plant.apply_hold(r.id) else plant.container_state(r.id) end;
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
revoke all on function plant.ipc_check_record(uuid, text, text, text, text, jsonb, boolean) from public;

-- As 0540, its body moved into plant.ipc_check_record.
create or replace function plant.record_ipc_check(p_batch uuid, p_press text, p_stream text, p_result text, p_reference text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, recipe, iam, kernel, platform, pg_temp as $$
declare
  v_actor jsonb;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.batch_execution where id = p_batch) then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-CNT-020)', p_batch);
  end if;
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  return plant.ipc_check_record(p_batch, p_press, p_stream, p_result, p_reference, v_actor, true);
end
$$;

-- IN-35 (c): the sweeper's MISSED check (header).
create function plant.record_missed_ipc_check(p_batch uuid, p_press text, p_stream text, p_reference text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, recipe, iam, kernel, platform, pg_temp as $$
declare
  v_actor jsonb;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.batch_execution where id = p_batch) then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-CNT-020)', p_batch);
  end if;
  v_actor := iam.require_permission('EXECUTION.SWEEP', '{}'::jsonb);
  return plant.ipc_check_record(p_batch, p_press, p_stream, 'MISSED', p_reference, v_actor, false);
end
$$;
revoke all on function plant.record_missed_ipc_check(uuid, text, text, text) from public;
grant execute on function plant.record_missed_ipc_check(uuid, text, text, text) to ebmr_app;

reset role;
