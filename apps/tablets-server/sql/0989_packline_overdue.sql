-- Tablets server, Phase 3 slice 4b review (builder B): the server sweeper records the missed periodic line checks and
-- device challenges of a running bottle line (TB-23) or cartoning (TB-24) step at database time, with the MISSED hold of
-- the line unit's containers, without waiting for the next entry (controls PR-37, IN-22; ADR 0012).
--
--   * tab.packline_overdue: what is overdue at a step at an instant, as the blocks read it (tb-23.ts, tb-24.ts and
--     bottle/common.ts missedNow; G-21's challenge interval): each scheduled stream with a check whose interval since its
--     last check has run out (TB-23: COUNT, DESICCANT when the MBR names one, TORQUE, SEAL; TB-24: ATD when configured,
--     EXAM until the end-of-run examination), test LINE_CHECK; each device with an interval whose last passing challenge is
--     older than it, until its END challenge, stream D.<device>, test CHALLENGE. Due at the last check (or pass) plus the
--     interval; none before the first one (as the blocks).
--   * tab.ipc_overdue_alarm: its test list widened with LINE_CHECK and CHALLENGE from what it holds when this runs.
--   * tab.ipc_overdue_at and tab.record_ipc_overdue, replaced from their latest definitions (tablets 0972) with only the
--     TB-23 and TB-24 branch added: the overdue items are listed with the others, and each new alarm records the MISSED
--     check of the step's unit through the slice 1 container command (plant.record_ipc_check with the step-execution
--     right, else plant.record_missed_ipc_check for the sweeper's EXECUTION.SWEEP), unchanged. The step's next check or
--     challenge raises LINE_CHECK_MISSED or CHALLENGE_MISSED as before (tablets 0986, 0987).
--
-- Every function keeps its owner (ebmr_owner) and pins its search_path with pg_temp last (ADR 0016). Applied as a new
-- migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

do $$
declare
  v_vals text[];
begin
  v_vals := array(select distinct x from unnest(tab.forming_constraint_values('tab.ipc_overdue_alarm'::regclass, 'ipc_overdue_alarm_test_check', 'test')
                                                || array['LINE_CHECK', 'CHALLENGE']) x order by x);
  alter table tab.ipc_overdue_alarm drop constraint ipc_overdue_alarm_test_check;
  execute format('alter table tab.ipc_overdue_alarm add constraint ipc_overdue_alarm_test_check check (test = any (%L::text[]))', v_vals);
end
$$;

-- PR-37, IN-22 (header): the overdue line checks and challenges of a TB-23 or TB-24 step (block p_type, configuration
-- p_cfg, entries p_prior) at p_now: [{stream, test, by: TIME, dueUs}], streams first, in the blocks' order.
create function tab.packline_overdue(p_prior jsonb, p_cfg jsonb, p_type text, p_now numeric) returns jsonb
language sql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
  with s (stream, every, n) as (
    select v.stream, v.every, v.n from (values
      ('COUNT', recipe.duration_us(p_cfg -> 'checkEvery'), 1, p_type = 'TB-23'),
      ('DESICCANT', recipe.duration_us(p_cfg -> 'checkEvery'), 2, p_type = 'TB-23' and jsonb_typeof(p_cfg -> 'desiccant') = 'object'),
      ('TORQUE', recipe.duration_us(p_cfg -> 'checkEvery'), 3, p_type = 'TB-23'),
      ('SEAL', recipe.duration_us(p_cfg -> 'checkEvery'), 4, p_type = 'TB-23'),
      ('ATD', recipe.duration_us(p_cfg -> 'atd' -> 'every'), 5, p_type = 'TB-24' and jsonb_typeof(p_cfg -> 'atd') = 'object'),
      ('EXAM', recipe.duration_us(p_cfg -> 'examination' -> 'every'), 6, p_type = 'TB-24'
               and not exists (select 1 from jsonb_array_elements(p_prior) e where e ->> 'kind' = 'EXAMINATION' and e -> 'data' ->> 'timing' = 'END'))) v (stream, every, n, wanted)
     where wanted),
  checks as (
    select s.stream, 'LINE_CHECK' as test, recipe.micros_of(tab.packline_last_check(p_prior, s.stream) -> 'recordedAt') + s.every as due, s.n as n
      from s where s.every is not null),
  devices as (
    select 'D.' || (d.x ->> 'id') as stream, 'CHALLENGE' as test,
           (select max(recipe.g21_challenge_time(e)) from jsonb_array_elements(p_prior) e
             where e ->> 'kind' = 'CHALLENGE' and e -> 'data' -> 'device' = d.x -> 'id' and e -> 'data' ->> 'result' = 'PASS') + recipe.duration_us(d.x -> 'every') as due,
           100 + d.i as n
      from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'devices') = 'array' then p_cfg -> 'devices' else '[]'::jsonb end) with ordinality d (x, i)
     where recipe.duration_us(d.x -> 'every') is not null
       and not exists (select 1 from jsonb_array_elements(p_prior) e where e ->> 'kind' = 'CHALLENGE' and e -> 'data' -> 'device' = d.x -> 'id' and e -> 'data' ->> 'trigger' = 'END'))
  select coalesce(jsonb_agg(jsonb_build_object('stream', a.stream, 'test', a.test, 'by', 'TIME', 'dueUs', a.due::text) order by a.n), '[]'::jsonb)
    from (select * from checks union all select * from devices) a
   where a.due is not null and p_now > a.due
$$;

-- As 0972, with the running TB-23 and TB-24 steps (tab.packline_overdue) beside the others.
create or replace function tab.ipc_overdue_at(p_batch uuid, p_at timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, platform, pg_temp as $$
declare
  v_content jsonb := recipe.batch_mbr_content(p_batch);
  v_state   jsonb;
  k         text;
  s         jsonb;
  v_node    jsonb;
  v_prior   jsonb;
  v_items   jsonb;
  v_out     jsonb := '[]'::jsonb;
begin
  if p_at is null then
    raise exception using errcode = 'P0001', message = 'Name the instant the overdue checks are read at (EBMR-TAB-303)';
  end if;
  select st.state into v_state from recipe.execution_state st where st.batch_id = p_batch;
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(v_state -> 'steps') = 'object' then v_state -> 'steps' else '{}'::jsonb end) x
               where x.value ->> 'status' = 'IN_PROGRESS' order by x.key loop
    v_node := recipe.step_node(v_content, s ->> 'step');
    v_prior := tab.gran_prior(v_state, k, 'Infinity'::numeric, null);
    v_items := case v_node -> 'block' ->> 'type'
      when 'TB-11' then tab.ipc_overdue(v_prior, v_node -> 'config', platform.epoch_micros(p_at))
      when 'TB-16' then tab.bilayer_missed(v_prior, v_node -> 'config', platform.epoch_micros(p_at))
      when 'TB-06' then tab.forming_ribbon_overdue(v_prior, v_node -> 'config', platform.epoch_micros(p_at))
      when 'TB-22' then tab.leak_overdue(v_prior, v_node -> 'config', platform.epoch_micros(p_at))
      when 'TB-23' then tab.packline_overdue(v_prior, v_node -> 'config', 'TB-23', platform.epoch_micros(p_at))
      when 'TB-24' then tab.packline_overdue(v_prior, v_node -> 'config', 'TB-24', platform.epoch_micros(p_at))
    end;
    if v_items is null then
      continue;
    end if;
    v_out := v_out || coalesce((select jsonb_agg(jsonb_build_object('stepKey', k) || m order by i) from jsonb_array_elements(v_items) with ordinality y (m, i)), '[]'::jsonb);
  end loop;
  return v_out;
end
$$;

-- As 0972, with the MISSED check of a TB-23 or TB-24 step recorded on the step's unit.
create or replace function tab.record_ipc_overdue(p_batch uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, plant, pg_temp as $$
declare
  v_actor   jsonb := iam.assert_validated_actor();
  v_eval    jsonb;
  m         jsonb;
  v_out     jsonb := '[]'::jsonb;
  v_id      uuid;
  v_exec    boolean;
  v_state   jsonb;
  v_press   text;
  v_content jsonb := recipe.batch_mbr_content(p_batch);
  v_code    text;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.batch_execution where id = p_batch) then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-TAB-303)', p_batch);
  end if;
  v_exec := (iam.evaluate_authority((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, 'STEP.EXECUTE', plant.batch_scope(p_batch), clock_timestamp(),
                                    v_actor ->> 'role_code') ->> 'allowed')::boolean;
  v_eval := iam.evaluate_authority((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, 'EXECUTION.SWEEP', '{}'::jsonb, clock_timestamp(), v_actor ->> 'role_code');
  if not v_exec and not (v_eval ->> 'allowed')::boolean then
    perform iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  end if;
  select st.state into v_state from recipe.execution_state st where st.batch_id = p_batch;
  for m in select x from jsonb_array_elements(tab.ipc_overdue_at(p_batch, clock_timestamp())) x loop
    insert into tab.ipc_overdue_alarm (batch_id, step_key, stream, test, due_us, held, person_id, account_id)
    values (p_batch, m ->> 'stepKey', m ->> 'stream', m ->> 'test', (m ->> 'dueUs')::bigint, true, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
    on conflict (batch_id, step_key, stream, test, due_us) do nothing
    returning id into v_id;
    if v_id is not null then
      -- Review 3c finding 4: the MISSED hold at the moment of the alarm, through the slice 1 container command.
      v_code := replace(recipe.step_node(v_content, v_state -> 'steps' -> (m ->> 'stepKey') ->> 'step') -> 'block' ->> 'type', '-', '');
      if v_code = 'TB22' then
        v_press := tab.blister_machine(v_state, m ->> 'stepKey');
        perform tab.blister_hold(p_batch, v_press, m ->> 'stream', 'MISSED', format('%s:%s:OVERDUE:%s', v_code, m ->> 'stepKey', m ->> 'dueUs'), v_exec);
      else
        v_press := case when v_code in ('TB23', 'TB24') then recipe.step_node(v_content, v_state -> 'steps' -> (m ->> 'stepKey') ->> 'step') -> 'config' ->> 'unit'
                        else tab.forming_press(v_state, m ->> 'stepKey') end;
        if v_exec then
          perform plant.record_ipc_check(p_batch, v_press, m ->> 'stream', 'MISSED', format('%s:%s:OVERDUE:%s', v_code, m ->> 'stepKey', m ->> 'dueUs'));
        else
          perform plant.record_missed_ipc_check(p_batch, v_press, m ->> 'stream', format('%s:%s:OVERDUE:%s', v_code, m ->> 'stepKey', m ->> 'dueUs'));
        end if;
      end if;
      v_out := v_out || (m || jsonb_build_object('held', true));
    end if;
    v_id := null;
  end loop;
  return v_out;
end
$$;

revoke all on function tab.packline_overdue(jsonb, jsonb, text, numeric) from public;

reset role;
