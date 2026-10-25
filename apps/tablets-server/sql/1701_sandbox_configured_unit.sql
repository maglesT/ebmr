-- Tablets edition, module C3 (Phase 7 slice 7r, D-7r-5; found by the R4 browser run of a company's own product): the
-- unit a packaging master configures is the sandbox's own unit in a test run (DI-04, DI-05, PR-22, PR-37).
--
-- Handbook: modules/tablets-server.md
-- A bottle line (TB-23) or a secondary packaging step (TB-24) names its plant unit in the master's configuration (config
-- `unit`, e.g. the cartoner CTN-03): its checks, challenges and holds are recorded on that unit (plant.record_ipc_check),
-- its line clearance is read from it. The sandbox's DEMO-ONLY plant labels every unit TEST- (DI-05; sandbox-plant.ts), and
-- a test run runs the GMP master itself (its content hash is the evidence), so the configured CTN-03 is no unit of the
-- sandbox: the first checkweigher challenge of a cold-form master's sandbox test run was refused (EBMR-CNT-023) and no
-- packaging master with TB-23 or TB-24 could complete the run its SANDBOX_RUN evidence needs (DI-04).
--
-- What changes. On the SANDBOX installation only, a configured unit code that is no unit of the sandbox's plant reads as
-- the sandbox's TEST- unit of the same code, when one exists (tab.configured_unit); everywhere else, and always on GMP,
-- the configured code is used as it is. Every check keeps its rule: the unit must be a unit of the plant (EBMR-CNT-023),
-- on the order's cleared line (TB21-LINE), and a passing check is recorded only from a passing entry of the step that
-- configures that unit, once (EBMR-TAB-382).
--   * tab.configured_unit(p_code), tab.packline_unit(p_node): the unit a configured code names on this installation;
--   * tab.packline_apply_holds (0987), tab.packline_pass_check (0987), tab.packline_line_problem (0988),
--     tab.record_ipc_overdue (0989) and tab.ipc_pass_check (0972), CREATE OR REPLACE: the configured unit read through it.
--
-- The functions are SECURITY DEFINER, owned by ebmr_owner, private to the owner, and pin their search_path with pg_temp
-- last. Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

create function tab.configured_unit(p_code text) returns text
language sql stable security definer set search_path = pg_catalog, plant, kernel, pg_temp as $$
  select case
           when p_code is not null and kernel.installation_kind() = 'SANDBOX'
            and not exists (select 1 from plant.equipment q where q.code = p_code)
            and exists (select 1 from plant.equipment q where q.code = 'TEST-' || p_code)
           then 'TEST-' || p_code
           else p_code
         end
$$;

create function tab.packline_unit(p_node jsonb) returns text
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select tab.configured_unit(p_node -> 'config' ->> 'unit')
$$;

create or replace function tab.packline_apply_holds(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  e0       jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  k        text;
  e        jsonb;
  d        jsonb;
  v_node   jsonb;
  v_unit   text;
  v_stream text;
  v_ref    text;
begin
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step');
    continue when v_node -> 'block' ->> 'type' is null or v_node -> 'block' ->> 'type' not in ('TB-23', 'TB-24');
    d := case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end;
    v_stream := case when e ->> 'kind' = 'CHALLENGE' then 'D.' || (d ->> 'device') else d ->> 'stream' end;
    v_unit := tab.packline_unit(v_node);
    continue when v_stream is null or v_unit is null or d ->> 'result' not in ('PASS', 'FAIL');
    v_ref := format('%s:%s:%s', replace(v_node -> 'block' ->> 'type', '-', ''), e ->> 'stepKey', k);
    if (d -> 'missed') = 'true'::jsonb then
      perform plant.record_ipc_check(p_batch, v_unit, v_stream, 'MISSED', v_ref || ':MISSED');
    end if;
    perform plant.record_ipc_check(p_batch, v_unit, v_stream, d ->> 'result', v_ref);
  end loop;
end
$$;

create or replace function tab.packline_pass_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  v_content jsonb;
  v_state   jsonb;
  v_m       text[];
  e         jsonb;
  v_node    jsonb;
  v_stream  text;
begin
  if new.result is distinct from 'PASS' then
    return new;
  end if;
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not exists (select 1 from tab.packline_nodes(v_content) x where tab.packline_unit(x) = new.press_code) then
    return new;
  end if;
  v_m := regexp_match(new.reference, '^(TB23|TB24):(.+):(EN-[1-9][0-9]{0,8})$');
  select s.state into v_state from recipe.execution_state s where s.batch_id = new.batch_id;
  e := v_state -> 'entries' -> v_m[3];
  v_node := recipe.step_node(v_content, v_state -> 'steps' -> v_m[2] ->> 'step');
  v_stream := case when e ->> 'kind' = 'CHALLENGE' then 'D.' || (e -> 'data' ->> 'device') else e -> 'data' ->> 'stream' end;
  if v_m is null or e is null or e ->> 'stepKey' is distinct from v_m[2] or v_node -> 'block' ->> 'type' is distinct from 'TB-' || substr(v_m[1], 3)
     or tab.packline_unit(v_node) is distinct from new.press_code or e -> 'data' ->> 'result' is distinct from 'PASS'
     or new.stream is distinct from v_stream
     or exists (select 1 from plant.ipc_check k where k.batch_id = new.batch_id and k.reference = new.reference) then
    raise exception using errcode = 'P0001',
      message = 'A passing check of the unit of a bottle line or secondary packaging step is recorded only from a passing check or challenge entry of that step, for its stream, once: packs are vouched for only by a recorded passing result (PR-37, IN-22). [EBMR-TAB-382]';
  end if;
  return new;
end
$$;

create or replace function tab.packline_line_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  e0       jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  k        text;
  e        jsonb;
  v_node   jsonb;
  v_type   text;
  v_code   text;
  v_unit   text;
  v_set    text;
  v_p      text;
begin
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    continue when v_type is null or v_type not in ('TB-23', 'TB-24');
    v_code := replace(v_type, '-', '');
    v_unit := tab.packline_unit(v_node);
    v_set := tab.packline_artwork_set(tab.packline_g21(p_content, v_node -> 'config' ->> case when v_type = 'TB-23' then 'labelStep' else 'printedStep' end),
                                      p_new -> 'header' -> 'marketSet');
    v_p := tab.blister_line_problem(p_batch, v_unit, coalesce(v_set, '(no single artwork set)'));
    if v_p is not null then
      return format('stores entry %s (%s) of step %s, but %s', k, e ->> 'kind', e ->> 'stepKey', replace(v_p, 'TB21-LINE', v_code || '-LINE'));
    end if;
    if tab.blister_isolation_problem(p_batch, jsonb_build_object('product', jsonb_build_object('uncoated', true,
                                       'betaLactam', coalesce((p_content -> 'header' -> 'predicates' -> 'betaLactam') = 'true'::jsonb, false))), v_unit) is not null then
      return format('stores entry %s (%s) of step %s, but the product is potent or beta-lactam and the line of unit %s is not flagged isolated (%s-ISOLATION; IN-38)',
                    k, e ->> 'kind', e ->> 'stepKey', left(coalesce(v_unit, '(none)'), 64), v_code);
    end if;
  end loop;
  return null;
end
$$;

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
        v_press := case when v_code in ('TB23', 'TB24') then tab.packline_unit(recipe.step_node(v_content, v_state -> 'steps' -> (m ->> 'stepKey') ->> 'step'))
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

create or replace function tab.ipc_pass_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  v_content jsonb;
  v_state   jsonb;
  v_m       text[];
  e         jsonb;
  v_press   text;
  v_type    text;
  v_ok      boolean;
begin
  if new.result is distinct from 'PASS' then
    return new;
  end if;
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not exists (select 1 from jsonb_path_query(coalesce(v_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
                  where p -> 'block' ->> 'type' in ('TB-11', 'TB-06', 'TB-16', 'TB-21', 'TB-22')) then
    return new;
  end if;
  -- Slice 3d (builder A): a passing print check of a printer of the batch's TB-19 steps is held by tablets 0912
  -- (tab.coat_print_pass, trigger aa_tab_coat_pass); such a check is not refused here.
  if new.reference ~ '^TB19:' and (tab.coat_print_pass(new.batch_id, new.press_code, new.stream, new.reference) -> 'printer') = 'true'::jsonb
     and tab.coat_print_pass(new.batch_id, new.press_code, new.stream, new.reference) ->> 'problem' is null then
    return new;
  end if;
  -- Lead (slice 4b): a reference another trigger holds, for a unit a step of its block names, is that trigger's.
  if exists (select 1 from tab.ipc_pass_delegate g
              where new.reference like g.prefix || ':%'
                and exists (select 1 from jsonb_path_query(coalesce(v_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
                             where p -> 'block' ->> 'type' = any (g.block_types) and tab.configured_unit(p -> 'config' ->> 'unit') = new.press_code)) then
    return new;
  end if;
  select s.state into v_state from recipe.execution_state s where s.batch_id = new.batch_id;
  if new.reference like 'G21:%' and tab.g21_pass_ok(new, v_content, v_state) then
    return new;
  end if;
  v_m := regexp_match(new.reference, '^(TB11|TB06|TB16|TB21|TB22):(.+):(EN-[1-9][0-9]{0,8})$');
  e := v_state -> 'entries' -> v_m[3];
  if e is not null then
    if v_m[1] in ('TB21', 'TB22') then
      v_press := tab.blister_machine(v_state, v_m[2]);
    else
      select tab.ipc_d(x) ->> 'press' into v_press from jsonb_array_elements(tab.gran_prior(v_state, v_m[2], 'Infinity'::numeric, 'RUN_START')) x limit 1;
    end if;
    v_type := recipe.step_node(v_content, v_state -> 'steps' -> v_m[2] ->> 'step') -> 'block' ->> 'type';
  end if;
  v_ok := v_m is not null and e is not null and e ->> 'stepKey' = v_m[2] and v_type = 'TB-' || substr(v_m[1], 3)
          and v_press is not distinct from new.press_code
          and not exists (select 1 from plant.ipc_check k where k.batch_id = new.batch_id and k.reference = new.reference)
          and case when v_m[1] = 'TB06'
                   then (e ->> 'kind' = 'RIBBON_CHECK' and tab.ipc_d(e) ->> 'result' in ('PASS', 'ALERT') and new.stream is not distinct from 'RIBBON')
                        or (e ->> 'kind' = 'SCREEN_CHECK' and tab.ipc_d(e) ->> 'result' = 'INTACT' and new.stream is not distinct from 'MILL')
                   when v_m[1] = 'TB21'
                   then e ->> 'kind' = 'DEFECT_CHECK' and tab.ipc_d(e) ->> 'result' = 'PASS' and new.stream is not distinct from 'LINE'
                   when v_m[1] = 'TB22'
                   then e ->> 'kind' = 'LEAK_TEST' and tab.ipc_d(e) ->> 'result' = 'PASS' and new.stream is not distinct from tab.ipc_d(e) ->> 'track'
                   else e ->> 'kind' in ('WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE', 'PHYSICAL_CHECK', 'FRIABILITY_RUN', 'DT_END', 'STATION_SWEEP')
                        and tab.ipc_d(e) ->> 'result' in ('PASS', 'ALERT') and tab.ipc_d(e) ->> 'stream' is not distinct from new.stream end;
  if v_ok is not true then
    raise exception using errcode = 'P0001',
      message = 'A passing in-process check of a batch whose MBR runs a TB-11 IPC scheduler, a roller compaction (TB-06), a bilayer run (TB-16), a blister run (TB-21) or a leak test (TB-22) is recorded only from a passing check entry of such a step, for its unit and stream, once: a container is vouched for only by a recorded passing result (PR-29, IN-35, IN-38). [EBMR-TAB-302]';
  end if;
  return new;
end
$$;

revoke all on function tab.configured_unit(text), tab.packline_unit(jsonb) from public;

reset role;
