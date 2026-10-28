-- Tablets server, Phase 7 slice 7t (owner requirement R10 #3, the rabeprazole demo): a check the blister run needs that
-- was not recorded before RUN_END no longer traps the step. Before, TB-21 refused every G-06 entry after the run's end
-- (tablets 0971, TB21-ENDED) while G-06's completeness still asked for it at PERFORMED (G06-RECIPE-UNCHECKED and the
-- others), so the step could never be signed and the packaging order never completed. Controls DI-28, PR-11, PR-37.
-- Handbook: modules/tablets-server.md
--
--   * recipe.block_data_schema: TB-21@1 takes one more entry kind, LATE_REASON {reason}, as blocks/tb-21.ts declares it
--     (an addition: every entry the version took before is taken and judged as before).
--   * recipe.engine_name: its rule code TB21-LATE-REASON.
--   * tab.blister_run_entry (replaced, same signature): after RUN_END a LATE_REASON with a reason that is not blank is
--     stored as {reason, recordedBy}; each lets exactly one G-06 entry the step needs at PERFORMED follow (SETPOINT_READBACK,
--     ACTUAL, ALARM_ACK, RECIPE_CHECK; G-06's own rules still judge it, recipe-core 0520 and tablets 0913); a second
--     reason waits for the first one's entry. Alarms, interface losses, reels, rejects and the end stay refused after the
--     end; everything else is as 0971 had it.
--   * tab.blister_late_problem and the trigger zzj_tab_blister_late_entry on recipe.execution_state: a new LATE_REASON
--     of a TB-21 run is stored only with the RUN_ENTRY_LATE exception the block raises with it at that step (open, ALERT,
--     review category LATE_ENTRY, QA only, its title naming the reason), so QA reviews every late entry
--     (EBMR-TAB-370, as the other blister entry rules).
--
-- Applied as a new migration because applied migrations are checksummed and never edited.

set local role ebmr_owner;

select kernel.set_actor_context(jsonb_build_object(
  'person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
  'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM',
  'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
  'legal_name', 'Software release (tablets migration 1760_tb21_late_run_entry)',
  'reason_code', 'SOFTWARE_RELEASE',
  'reason_text', 'the TB-21 late-entry reason of requirement R10 #3 in the registers every entry is checked against (DI-28, PR-11, PR-37)'));

insert into recipe.block_data_schema (block_type, block_version, part, entry_kind, schema) values
  ('TB-21', '1', 'ENTRY', 'LATE_REASON', '{"type":"object","fields":{"reason":{"type":"string"}}}');

insert into recipe.engine_name (name, kind) values ('TB21-LATE-REASON', 'RULE_CODE');

select kernel.set_actor_context(null);

-- What a TB-21 run entry of the block's own kind p_kind holds (tb-21.ts acceptRun, G-06's kinds apart): {data, raise,
-- alerts, verify}, {g06} or {problem}. As 0971, with the late entry after the run's end (header).
create or replace function tab.blister_run_entry(p_kind text, p_cfg jsonb, p_prior jsonb, c jsonb, p_by jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_started boolean := exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'RUN_START');
  v_ended   boolean := exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'RUN_END');
  v_counted boolean := exists (select 1 from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'COUNT');
  v_end_i   bigint;
  v_open    boolean := false;
  v_r       jsonb;
  v_n       text;
  v_counts  jsonb;
  v_total   numeric;
  v_max     numeric;
  v_rej     numeric;
  v_unexp   numeric;
  v_per     numeric;
  k         text;
begin
  if p_kind = 'RUN_START' then
    if v_started then
      return tab.ipc_p('TB21-TWICE', 'the step has started its run already; a new run is a new step');
    end if;
    return jsonb_build_object('data', jsonb_build_object('machine', c -> 'machine', 'startedBy', p_by), 'raise', '[]'::jsonb, 'alerts', '[]'::jsonb, 'verify', false);
  end if;
  if p_kind not in ('SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK', 'REEL_CHANGE', 'DEFECT_CHECK', 'REJECTS', 'RUN_END', 'COUNT', 'LATE_REASON') then
    return tab.ipc_p('TB21-ENTRY', format('%s is not an entry of a blister run', coalesce(p_kind, '(none)')));
  end if;
  if not v_started then
    return tab.ipc_p('TB21-NOT-STARTED', 'the step has not started its run');
  end if;
  if v_ended then
    -- A late entry: the reasons given after the end against the G-06 entries that followed them (tb-21.ts lateOpen).
    select min(i) into v_end_i from jsonb_array_elements(p_prior) with ordinality y (x, i) where x ->> 'kind' = 'RUN_END';
    select count(*) filter (where x ->> 'kind' = 'LATE_REASON') > count(*) filter (where x ->> 'kind' in ('SETPOINT_READBACK', 'ACTUAL', 'ALARM_ACK', 'RECIPE_CHECK'))
      into v_open from jsonb_array_elements(p_prior) with ordinality y (x, i) where i > v_end_i;
  end if;
  if p_kind = 'LATE_REASON' then
    if not v_ended then
      return tab.ipc_p('TB21-RUNNING', 'the run has not ended: record the entry itself while it runs');
    end if;
    if jsonb_typeof(c -> 'reason') is distinct from 'string' or (c ->> 'reason') !~ '\S' then
      return tab.ipc_p('TB21-LATE-REASON', 'a late entry needs the reason it was not recorded during the run');
    end if;
    if v_open then
      return tab.ipc_p('TB21-LATE-REASON', 'the late entry of the reason given last is not recorded yet');
    end if;
    return jsonb_build_object('data', jsonb_build_object('reason', c -> 'reason', 'recordedBy', p_by), 'raise', '[]'::jsonb, 'alerts', '[]'::jsonb, 'verify', false);
  end if;
  if v_ended and p_kind not in ('COUNT', 'DEFECT_CHECK')
     and not (v_open and p_kind in ('SETPOINT_READBACK', 'ACTUAL', 'ALARM_ACK', 'RECIPE_CHECK')) then
    return tab.ipc_p('TB21-ENDED', 'the run has ended');
  end if;
  case p_kind
    when 'SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK' then
      -- G-06's own: its data are recipe-core 0520's, its exceptions tablets 0913's.
      return jsonb_build_object('g06', true);
    when 'REEL_CHANGE' then
      v_r := tab.blister_reel(p_cfg, c);
      if v_r ? 'problem' then
        return v_r;
      end if;
      return jsonb_build_object('data', (v_r -> 'reel') || jsonb_build_object('changedBy', p_by), 'raise', '[]'::jsonb, 'alerts', '[]'::jsonb, 'verify', true);
    when 'DEFECT_CHECK' then
      v_n := c ->> 'examined';
      if v_n is distinct from p_cfg -> 'defectCheck' ->> 'examined' then
        return tab.ipc_p('TB21-SAMPLE', format('a defect check examines the %s blisters the MBR sets, not %s', coalesce(p_cfg -> 'defectCheck' ->> 'examined', '-'), coalesce(v_n, '(none)')));
      end if;
      v_counts := '{}'::jsonb;
      v_total := 0;
      foreach k in array array['MISPRINT', 'FOIL_CUT', 'MISSING_TABLET', 'IMPROPER_SEAL'] loop
        v_counts := v_counts || jsonb_build_object(k, case when jsonb_typeof(c -> 'defects' -> k) = 'string' then c -> 'defects' -> k else '"0"'::jsonb end);
        v_total := v_total + tab.blister_n(c -> 'defects' -> k);
      end loop;
      if v_total > v_n::numeric then
        return tab.ipc_p('TB21-DEFECTS', format('more defects (%s) than blisters examined (%s)', v_total, v_n));
      end if;
      v_max := coalesce(case when (p_cfg -> 'defectCheck' ->> 'maxDefects') ~ '^[0-9]{1,18}$' then (p_cfg -> 'defectCheck' ->> 'maxDefects')::numeric end, 0);
      return jsonb_build_object('data', jsonb_build_object('examined', v_n, 'defectCounts', v_counts, 'defectTotal', v_total::text,
                                                           'result', case when v_total <= v_max then 'PASS' else 'FAIL' end, 'checkedBy', p_by),
                                'raise', case when v_total <= v_max then '[]'::jsonb else '["DEFECT_CHECK_FAILED"]'::jsonb end, 'alerts', '[]'::jsonb, 'verify', false);
    when 'REJECTS' then
      if v_counted then
        return tab.ipc_p('TB21-COUNTED', 'the count of the step is recorded');
      end if;
      v_counts := '{}'::jsonb;
      v_total := 0;
      foreach k in array array['emptyPocket', 'brokenPocket', 'vision'] loop
        v_counts := v_counts || jsonb_build_object(k, case when jsonb_typeof(c -> k) = 'string' then c -> k else '"0"'::jsonb end);
        v_total := v_total + tab.blister_n(c -> k);
      end loop;
      return jsonb_build_object('data', v_counts || jsonb_build_object('total', v_total::text, 'recordedBy', p_by), 'raise', '[]'::jsonb, 'alerts', '[]'::jsonb, 'verify', false);
    when 'RUN_END' then
      return jsonb_build_object('data', jsonb_build_object('endedBy', p_by), 'raise', '[]'::jsonb, 'alerts', '[]'::jsonb, 'verify', false);
    else
      if not v_ended then
        return tab.ipc_p('TB21-RUNNING', 'the run has not ended: the count comes after it');
      end if;
      if v_counted then
        return tab.ipc_p('TB21-COUNT-TWICE', 'the step already records its count');
      end if;
      select coalesce(sum(tab.blister_n(tab.ipc_d(x) -> 'total')), 0) into v_rej from jsonb_array_elements(p_prior) x where x ->> 'kind' = 'REJECTS';
      v_unexp := tab.blister_n(c -> 'formed') - (v_rej + tab.blister_n(c -> 'good') + tab.blister_n(c -> 'setupWaste') + tab.blister_n(c -> 'samples'));
      v_per := coalesce(case when (p_cfg -> 'packFormat' ->> 'unitsPerBlister') ~ '^[1-9][0-9]{0,17}$' then (p_cfg -> 'packFormat' ->> 'unitsPerBlister')::numeric end, 1);
      return jsonb_build_object('data', jsonb_build_object('formed', c -> 'formed', 'good', c -> 'good', 'rejects', v_rej::text, 'setupWaste', c -> 'setupWaste',
                                                           'samples', c -> 'samples', 'unexplained', v_unexp::text, 'goodUnits', (tab.blister_n(c -> 'good') * v_per)::text, 'recordedBy', p_by),
                                'raise', case when v_unexp = 0 then '[]'::jsonb else '["BLISTER_COUNT_UNEXPLAINED"]'::jsonb end, 'alerts', '[]'::jsonb, 'verify', false);
  end case;
end
$$;

-- DI-28, PR-11, PR-37: why a new LATE_REASON entry of a TB-21 run in row p_new (after p_old) lacks the RUN_ENTRY_LATE
-- exception its block raises with it (header); NULL when every one has it.
create function tab.blister_late_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql stable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  e0     jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  k      text;
  e      jsonb;
  v_key  text;
  v_node jsonb;
begin
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) and x.value ->> 'kind' = 'LATE_REASON' order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_key := e ->> 'stepKey';
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> v_key ->> 'step');
    if v_node -> 'block' ->> 'type' is distinct from 'TB-21' then
      continue;
    end if;
    if not exists (
      select 1 from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) x
       where not coalesce((p_old -> 'exceptions') ? x.key, false) and x.value ->> 'type' = 'RUN_ENTRY_LATE' and x.value -> 'source' ->> 'stepKey' = v_key
         and x.value ->> 'severity' = 'ALERT' and x.value ->> 'category' = 'LATE_ENTRY' and (x.value -> 'qaOnly') = 'true'::jsonb
         and x.value ->> 'status' = 'OPEN' and strpos(x.value ->> 'title', tab.ipc_d(e) ->> 'reason') > 0) then
      return format('stores entry %s (LATE_REASON) of step %s without the open RUN_ENTRY_LATE exception for QA, naming its reason, that its block raises with it (DI-28, PR-11)', k, coalesce(v_key, '(none)'));
    end if;
  end loop;
  return null;
end
$$;

create function tab.blister_late_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_problem text;
begin
  if not exists (select 1 from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) x
                  where x.value ->> 'kind' = 'LATE_REASON' and not coalesce((old.state -> 'entries') ? x.key, false)) then
    return null;
  end if;
  v_problem := tab.blister_late_problem(recipe.batch_mbr_content(new.batch_id), old.state, new.state);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This row %s: an entry a blister run needed, recorded after its end, is reviewed by QA (DI-28, PR-11, PR-37). [EBMR-TAB-370]', v_problem);
  end if;
  return null;
end
$$;

create trigger zzj_tab_blister_late_entry after update on recipe.execution_state
  for each row execute function tab.blister_late_check();

revoke all on function tab.blister_run_entry(text, jsonb, jsonb, jsonb, jsonb), tab.blister_late_problem(jsonb, jsonb, jsonb), tab.blister_late_check() from public;

reset role;
