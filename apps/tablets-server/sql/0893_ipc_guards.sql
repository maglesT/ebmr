-- Tablets server, Phase 3 slice 3c (builder B): the rules of the IPC blocks TB-11 to TB-15 held by the database, and the
-- bracketing hold of TB-11 on the slice 1 output containers (tablets spec B.2 TB-11 to TB-15; controls IN-34, IN-35,
-- PR-07, PR-29, DI-28, DI-29, DI-32, INV-41; ADR 0012: the rules hold when the application's own database credentials
-- are used directly).
--
-- A row trigger on recipe.execution_state (zzf_tab_ipc, after update; after the entry schema check of recipe-core 0332)
-- refuses a row unless:
--   1. every new entry of a TB-11..TB-15 step holds exactly what its block builds (0892, the twins of src/blocks/tb-1x.ts)
--      from what was entered, the batch's MBR and markets, the compendial rule sets (0890), the step's earlier entries,
--      the person and the row's database time, and only what the block accepts (EBMR-TAB-300); and with it:
--        * the exceptions its block raises, in the same row: IPC_CHECK_FAILED for a failing result and IPC_CHECK_MISSED
--          for a missed check (severity ACTION, a deviation required, the steps after it blocked until one is linked),
--          IPC_CHECK_ALERT for an alert-limit breach, IPC_MANUAL_ENTRY for a value keyed by hand and IPC_LATE_ENTRY for
--          a late one; a value keyed by hand leaves the step needing its second person (DI-32, DI-28);
--        * the instrument a test names is a plant instrument with a use for this batch open at the row's time
--          (plant.record_instrument_use, recipe-core 0403: calibrated, its per-use or daily check passed);
--        * a value captured from the instrument stands on a reading claimed for it (purpose IPC) in this command by the
--          row's person and session, from that instrument, of exactly that value in the value's unit (masses converted
--          between kg, g and mg), each reading once (DI-31, DI-32);
--        * TB-11's RUN_START names a press that is a plant PROCESS unit with a use for this batch open now; a compression
--          run starts only after the first-off approval of that press (a COMPLETED TB-10 step of the batch set up on it:
--          production IPC scheduling starts there, TB11-FIRST-OFF); and the MBR's
--          compression plan keeps the ceiling of tab.ipc_rule (the most frequent test plus the grace, IN-35 (c)), names
--          a risk assessment for every test (PR-07) and has its station sweep (IN-35 (b));
--   2. an IPC step closes (IN_PROGRESS to AWAITING_VERIFICATION or COMPLETED) only complete: a test block with a final
--      result and no compendial stage pending (INV-41); TB-11 after RUN_END with an end-of-run check of every stream and
--      planned test, the sweeps done and no stage pending (EBMR-TAB-301);
-- and then, for every new entry of a TB-11 step (the bracketing hold, TB-11; PR-29, IN-35 (c)), calls the slice 1
-- container commands (plant.record_ipc_check, recipe-core 0422 as replaced by 0540; never a copy): MISSED for each
-- stream the entry finds missed (holding every container of the press and stream filled since its last passing check),
-- then FAIL for a failing final result (the same hold) or PASS for a passing one. A trigger on plant.ipc_check
-- (aa_tab_ipc_pass, before insert) refuses a PASS for a batch whose MBR has a TB-11 step unless it is the record of a
-- passing TB-11 entry of that batch, stream and press, made once (EBMR-TAB-302): a container of such a run is vouched for
-- only by a recorded passing check. FAIL and MISSED can be recorded by anyone who executes steps (stricter).
--
-- The missed-check timer at database time between entries: tab.ipc_overdue_at(batch, at) lists the overdue checks of the
-- batch's running TB-11 steps at an instant, and tab.record_ipc_overdue(batch) records each newly overdue check once as an
-- alarm (tab.ipc_overdue_alarm) at the database's clock, for the screens and a server job (EBMR-TAB-303). The hold and the
-- exception follow with the step's next entry, which must list the missed check; a container filled meanwhile is not
-- vouched for until a passing check is recorded after it, and that entry records the MISSED first.
--
-- New functions are owned by ebmr_owner; the trigger functions and the alarm functions are SECURITY DEFINER; every
-- function pins its search_path with pg_temp last (ADR 0016). Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- Whether row p_new raised (newly against p_old) an exception of type p_type and severity p_severity at step p_key.
create function tab.ipc_raised(p_old jsonb, p_new jsonb, p_key text, p_type text, p_severity text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1 from jsonb_each(case when jsonb_typeof(p_new -> 'exceptions') = 'object' then p_new -> 'exceptions' else '{}'::jsonb end) x
     where not coalesce((p_old -> 'exceptions') ? x.key, false) and x.value ->> 'type' = p_type and x.value -> 'source' ->> 'stepKey' = p_key
       and x.value ->> 'severity' = p_severity)
$$;

-- The values a DEVICE entry's readings stand for, in order (the order tb-1x.ts counts them), each with the unit it is in:
-- [{v, u}]. Weights are in mg, friability masses in g, dimensions in mm, breaking force in the tester's unit (N or kp),
-- the bath in degC, disintegration times in s.
create function tab.ipc_values(p_kind text, p_cfg jsonb, p_sched boolean, c jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_cfg jsonb;
begin
  case p_kind
    when 'WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE' then
      return case when jsonb_typeof(c -> 'weights') = 'array'
                  then (select coalesce(jsonb_agg(jsonb_build_object('v', x, 'u', 'mg') order by i), '[]'::jsonb) from jsonb_array_elements_text(c -> 'weights') with ordinality y (x, i))
                  else jsonb_build_array(jsonb_build_object('v', c ->> 'groupWeight', 'u', 'mg')) end;
    when 'PHYSICAL_CHECK' then
      v_cfg := tab.ipc_tcfg(p_cfg, p_sched, 'physical');
      return (select coalesce(jsonb_agg(jsonb_build_object('v', t.v ->> k, 'u', case when k = 'hardness' then v_cfg -> 'hardness' ->> 'unit' else 'mm' end) order by t.i, u.j), '[]'::jsonb)
                from jsonb_array_elements(c -> 'tablets') with ordinality t (v, i), unnest(array['thickness', 'diameter', 'hardness']) with ordinality u (k, j)
               where jsonb_typeof(v_cfg -> k) = 'object');
    when 'FRIABILITY_RUN' then
      return jsonb_build_array(jsonb_build_object('v', c ->> 'initialMass', 'u', 'g'), jsonb_build_object('v', c ->> 'finalMass', 'u', 'g'));
    when 'DT_START' then
      return jsonb_build_array(jsonb_build_object('v', c ->> 'bathTemperature', 'u', 'degC'));
    when 'DT_END' then
      return (select coalesce(jsonb_agg(jsonb_build_object('v', u.v ->> 'seconds', 'u', 's') order by u.i), '[]'::jsonb) from jsonb_array_elements(c -> 'units') with ordinality u (v, i));
    when 'STATION_SWEEP' then
      return (select coalesce(jsonb_agg(jsonb_build_object('v', s.v ->> k, 'u', case k when 'weight' then 'mg' when 'thickness' then 'mm' else p_cfg -> 'sweep' -> 'hardness' ->> 'unit' end) order by s.i, u.j), '[]'::jsonb)
                from jsonb_array_elements(c -> 'stations') with ordinality s (v, i), unnest(array['weight', 'thickness', 'hardness']) with ordinality u (k, j)
               where jsonb_typeof(p_cfg -> 'sweep' -> k) = 'object');
    else
      return '[]'::jsonb;
  end case;
end
$$;

-- A reading's value p_value in unit p_unit expressed in unit p_want (masses converted between kg, g and mg; every other
-- unit only as it is); NULL when it cannot be.
create function tab.ipc_in_unit(p_value numeric, p_unit text, p_want text) returns numeric
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when p_unit = p_want then p_value
    when p_unit in ('kg', 'g', 'mg') and p_want in ('kg', 'g', 'mg') then
      p_value * (case p_unit when 'kg' then 1000000 when 'g' then 1000 else 1 end) / (case p_want when 'kg' then 1000000 when 'g' then 1000 else 1 end)
  end
$$;

-- Why the readings of a DEVICE entry do not stand for its values (header item 1), or NULL.
create function tab.ipc_readings_problem(r recipe.execution_command, p_readings jsonb, p_values jsonb, p_instrument text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_id  text;
  v_i   integer := 0;
  v     jsonb;
  u     tab.reading_use%rowtype;
  d     tab.device_reading%rowtype;
begin
  if jsonb_typeof(p_readings) is distinct from 'array' or jsonb_array_length(p_readings) <> jsonb_array_length(p_values)
     or (select count(distinct x) from jsonb_array_elements_text(p_readings) x) <> jsonb_array_length(p_readings) then
    return 'it names no distinct reading for each value';
  end if;
  for v_id in select x from jsonb_array_elements_text(p_readings) with ordinality y (x, i) order by i loop
    v := p_values -> v_i;
    v_i := v_i + 1;
    u := null;
    d := null;
    select * into u from tab.reading_use where reading_id = v_id::uuid;
    select * into d from tab.device_reading where id = v_id::uuid;
    if u.reading_id is null or d.id is null or u.purpose is distinct from 'IPC' or u.person_id is distinct from r.actor_person or u.account_id is distinct from r.actor_account
       or u.session_id is distinct from r.session_id or u.correlation_id is distinct from r.correlation_id or u.claimed_at < transaction_timestamp() then
      return format('reading %s was not claimed for an IPC value by this person''s session in this command', v_i);
    end if;
    if d.device_code is distinct from p_instrument or d.value is null
       or tab.ipc_in_unit(d.value::numeric, d.unit, v ->> 'u') is distinct from (v ->> 'v')::numeric then
      return format('reading %s is not the value %s %s from instrument %s', v_i, coalesce(v ->> 'v', '?'), coalesce(v ->> 'u', '?'), coalesce(p_instrument, '?'));
    end if;
  end loop;
  return null;
end
$$;

-- IN-35, PR-07: why the MBR's TB-11 configuration p_cfg breaks the compression rules (ceiling, QRM, sweep), or NULL.
create function tab.ipc_plan_problem(p_cfg jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_ceiling numeric;
  v_fast    numeric;
begin
  if exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'plan') = 'array' then p_cfg -> 'plan' else '[]'::jsonb end) p
              where jsonb_typeof(p -> 'qrmRef') is distinct from 'string') then
    return 'a test of its plan names no risk assessment for its frequency (TB11-QRM; PR-07)';
  end if;
  if coalesce(p_cfg ->> 'process', 'COMPRESSION') <> 'COMPRESSION' then
    return null;
  end if;
  select value::numeric * 60000000 into v_ceiling from tab.ipc_rule where key = 'tablets.compression.ipcSampleMaxInterval';
  select min(recipe.duration_us(p -> 'every')) into v_fast
    from jsonb_array_elements(case when jsonb_typeof(p_cfg -> 'plan') = 'array' then p_cfg -> 'plan' else '[]'::jsonb end) p;
  if v_fast is null or recipe.duration_us(p_cfg -> 'grace') is null or v_fast + recipe.duration_us(p_cfg -> 'grace') > v_ceiling then
    return format('its most frequent test plus the grace exceeds the %s min between compression samples (TB11-CEILING; IN-35 (c))', trim_scale(v_ceiling / 60000000));
  end if;
  if jsonb_typeof(p_cfg -> 'sweep') is distinct from 'object' then
    return 'a compression run starts with a station sweep of every stream (TB11-NO-SWEEP; IN-35 (b))';
  end if;
  return null;
end
$$;

-- IN-35, PR-23: why a compression run of press p_press cannot start in state p_state: production IPC scheduling starts
-- only at the first-off approval of that press, i.e. a TB-10 step of the batch set up on the press (PRESS_SETUP) and
-- COMPLETED (its check signature is the first-off approval, tablets 0873). NULL when it can, or when the run is not
-- compression.
create function tab.ipc_first_off_problem(p_content jsonb, p_state jsonb, p_cfg jsonb, p_press text) returns text
language sql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
  select case when coalesce(p_cfg ->> 'process', 'COMPRESSION') = 'COMPRESSION'
                   and not exists (select 1 from jsonb_each(case when jsonb_typeof(p_state -> 'steps') = 'object' then p_state -> 'steps' else '{}'::jsonb end) s
                                    where s.value ->> 'status' = 'COMPLETED'
                                      and recipe.step_node(p_content, s.value ->> 'step') -> 'block' ->> 'type' = 'TB-10'
                                      and exists (select 1 from jsonb_array_elements(tab.gran_prior(p_state, s.key, 'Infinity'::numeric, 'PRESS_SETUP')) x
                                                   where tab.ipc_d(x) ->> 'press' = p_press))
              then format('press %s has no approved first-off in this batch: a TB-10 set-up of that press, completed with its first-off approval, comes first (TB11-FIRST-OFF; IN-35, PR-23)', coalesce(p_press, '(none)')) end
$$;

-- IN-34, IN-35, PR-29, DI-28, DI-29, DI-32: why a new entry of an IPC step in row p_new (after p_old, command row r, MBR
-- p_content, batch p_batch) is not what its block builds or accepts (header item 1); NULL when every one is.
create function tab.ipc_entry_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb, r recipe.execution_command) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1        jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  v_markets jsonb := p_new -> 'header' -> 'marketSet';
  k         text;
  e         jsonb;
  d         jsonb;
  c         jsonb;
  v_kind    text;
  v_key     text;
  v_node    jsonb;
  v_type    text;
  v_cfg     jsonb;
  v_now     numeric;
  v_seq     numeric;
  v_what    text;
  v_res     jsonb;
  v_want    jsonb;
  v_member  text;
  v_code    text;
  v_instr   text;
  v_problem text;
begin
  for k, e in select x.key, x.value from jsonb_each(e1) x where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_kind := e ->> 'kind';
    v_key := e ->> 'stepKey';
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> v_key ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    if v_type is null or v_type not in ('TB-11', 'TB-12', 'TB-13', 'TB-14', 'TB-15') then
      continue;
    end if;
    v_code := replace(v_type, '-', '');
    v_what := format('entry %s (%s) of step %s', k, coalesce(v_kind, 'unnamed'), coalesce(v_key, '(none)'));
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    d := case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end;
    c := case when jsonb_typeof(r.command -> 'entry') = 'object' then r.command -> 'entry' else '{}'::jsonb end;
    v_now := recipe.micros_of(e -> 'recordedAt');
    v_seq := (e ->> 'recordedSeq')::numeric;
    v_res := tab.ipc_entry(v_type, v_kind, v_cfg, tab.gran_prior(p_new, v_key, v_seq, null), c, v_markets,
                           (timestamp 'epoch' + v_now * interval '1 microsecond')::date, v_now, e -> 'enteredBy');
    if v_res ? 'problem' then
      return format('stores %s, which its block refuses: %s', v_what, v_res ->> 'problem');
    end if;
    v_want := v_res -> 'data';
    if d is distinct from v_want then
      select m into v_member from (select jsonb_object_keys(d) m union select jsonb_object_keys(v_want)) u where (d -> m) is distinct from (v_want -> m) order by m limit 1;
      return format('stores %s with %s %s, where its block writes %s', v_what, v_member, left(coalesce((d -> v_member)::text, '(no such member)'), 300),
                    left(coalesce((v_want -> v_member)::text, '(no such member)'), 300));
    end if;
    -- The exceptions the block raises with it, and the second person a hand-keyed value needs.
    if (v_res -> 'manual') = 'true'::jsonb then
      if not tab.ipc_raised(p_old, p_new, v_key, 'IPC_MANUAL_ENTRY', 'ALERT') then
        return format('stores %s, keyed by hand, without the IPC_MANUAL_ENTRY exception its block raises', v_what);
      end if;
      if (p_new -> 'steps' -> v_key -> 'verificationRequired') is distinct from 'true'::jsonb then
        return format('stores %s, keyed by hand, and its step does not require a second person''s check (DI-32)', v_what);
      end if;
    end if;
    if (v_res -> 'late') = 'true'::jsonb and not tab.ipc_raised(p_old, p_new, v_key, 'IPC_LATE_ENTRY', 'ALERT') then
      return format('stores %s, recorded late after its sampling, without the IPC_LATE_ENTRY exception (DI-28)', v_what);
    end if;
    if v_res ->> 'outcome' = 'FAIL' and not tab.gran_held(p_old, p_new, v_key, 'IPC_CHECK_FAILED') then
      return format('stores %s, a failing result, without the IPC_CHECK_FAILED exception its block raises, holding the steps after it until a deviation is linked', v_what);
    end if;
    if v_res ->> 'outcome' = 'ALERT' and not tab.ipc_raised(p_old, p_new, v_key, 'IPC_CHECK_ALERT', 'ALERT') then
      return format('stores %s, outside its alert limits, without the IPC_CHECK_ALERT exception', v_what);
    end if;
    if jsonb_array_length(coalesce(v_res -> 'missed', '[]'::jsonb)) > 0 and not tab.gran_held(p_old, p_new, v_key, 'IPC_CHECK_MISSED') then
      return format('stores %s, which finds a missed check, without the IPC_CHECK_MISSED exception, holding the steps after it until a deviation is linked (TB11-MISSED; IN-35)', v_what);
    end if;
    -- The instrument (IN-25 (b)) and the readings of a value captured from it (DI-31, DI-32).
    v_instr := coalesce(tab.ipc_str(d -> 'instrument'), tab.ipc_str(v_res -> 'instrument'));
    if v_kind <> 'DT_END' and d ? 'instrument'
       and not exists (select 1 from plant.instrument_use u join plant.equipment q on q.id = u.equipment_id
                        where q.code = v_instr and u.batch_id = p_batch and u.planned_end > clock_timestamp()) then
      return format('stores %s on instrument %s, which has no instrument use for this batch open now: a tester or balance is used only once calibrated with its check passed (%s-INSTRUMENT; IN-25, DI-32)',
                    v_what, left(coalesce(v_instr, '(none)'), 64), v_code);
    end if;
    if d ->> 'capture' = 'DEVICE' then
      v_problem := tab.ipc_readings_problem(r, d -> 'readings', tab.ipc_values(v_kind, v_cfg, v_type = 'TB-11', c), v_instr);
      if v_problem is not null then
        return format('stores %s as captured from the instrument, but %s (%s-DEVICE; DI-31, DI-32)', v_what, v_problem, v_code);
      end if;
    end if;
    -- TB-11: the press of the run and the MBR's plan (IN-35, PR-07).
    if v_kind = 'RUN_START' then
      if not exists (select 1 from plant.equipment q join plant.equipment_use u on u.equipment_id = q.id
                      where q.code = d ->> 'press' and q.kind = 'PROCESS' and u.batch_id = p_batch
                        and not exists (select 1 from plant.equipment_use_end x where x.use_id = u.id)) then
        return format('starts the run of %s on press %s, which is no plant PROCESS unit in use for this batch (TB11-PRESS; IN-35, PR-23)', v_key, left(coalesce(d ->> 'press', '(none)'), 64));
      end if;
      v_problem := tab.ipc_first_off_problem(p_content, p_new, v_cfg, d ->> 'press');
      if v_problem is not null then
        return format('starts the run of %s, but %s', v_key, v_problem);
      end if;
      v_problem := tab.ipc_plan_problem(v_cfg);
      if v_problem is not null then
        return format('starts the run of %s, but %s', v_key, v_problem);
      end if;
    end if;
  end loop;
  return null;
end
$$;

-- PR-29, IN-35, INV-41: why an IPC step that row p_new closes is not complete (header item 2); NULL when every one is.
create function tab.ipc_close_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  k      text;
  s      jsonb;
  v_node jsonb;
  v_type text;
  v_cfg  jsonb;
  v_all  jsonb;
  v_end  numeric;
  v_text text;
begin
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) x
               where x.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED') and p_old -> 'steps' -> x.key ->> 'status' = 'IN_PROGRESS' order by x.key loop
    v_node := recipe.step_node(p_content, s ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    if v_type is null or v_type not in ('TB-11', 'TB-12', 'TB-13', 'TB-14', 'TB-15') then
      continue;
    end if;
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    v_all := tab.gran_prior(p_new, k, 'Infinity'::numeric, null);
    v_text := null;
    case v_type
      when 'TB-12' then
        v_text := case when jsonb_array_length(tab.ipc_of(v_all, 'WEIGHT_CHECK')) = 0 then 'it has no weight check (TB12-NO-CHECK)'
                       when jsonb_array_length(tab.ipc_pending_first(v_all)) > 0 then 'its weight variation waits for its second stage (TB12-SECOND-STAGE-PENDING)' end;
      when 'TB-13' then
        v_text := case when jsonb_array_length(tab.ipc_of(v_all, 'PHYSICAL_CHECK')) = 0 then 'it has no physical check (TB13-NO-CHECK)' end;
      when 'TB-14' then
        v_text := case when jsonb_array_length(tab.ipc_of(v_all, 'FRIABILITY_RUN')) = 0 then 'it has no friability run (TB14-NO-RUN)'
                       when jsonb_array_length(tab.ipc_pending_friability(v_all)) > 0 then 'its friability test waits for its repeat runs (TB14-REPEAT-PENDING)' end;
      when 'TB-15' then
        v_text := case when jsonb_array_length(tab.ipc_of(v_all, 'DT_END')) = 0 then 'it has no disintegration run (TB15-NO-RUN)'
                       when jsonb_array_length(tab.ipc_open_starts(v_all)) > 0 or jsonb_array_length(tab.ipc_pending_dt(v_all, 'RETEST')) > 0
                            or jsonb_array_length(tab.ipc_pending_dt(v_all, 'BUFFER')) > 0 then 'a disintegration run is running, or a retest or buffer stage is due (TB15-PENDING)' end;
      else
        select recipe.micros_of(x -> 'recordedAt') into v_end from jsonb_array_elements(v_all) x where x ->> 'kind' = 'RUN_END' limit 1;
        if v_end is null then
          v_text := 'its run has not ended (TB11-RUNNING)';
        elsif coalesce(v_cfg ->> 'process', 'COMPRESSION') = 'COMPRESSION' and jsonb_typeof(v_cfg -> 'sweep') = 'object'
              and exists (select 1 from jsonb_array_elements(v_cfg -> 'streams') st
                           where not exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'STATION_SWEEP' and tab.ipc_d(x) ->> 'stream' = st ->> 'id')) then
          v_text := 'a stream has no station sweep (TB11-NO-SWEEP)';
        elsif exists (select 1 from jsonb_array_elements(v_cfg -> 'streams') st, jsonb_array_elements(v_cfg -> 'plan') p
                       where not exists (select 1 from jsonb_array_elements(v_all) x
                                          where tab.ipc_check_test(x ->> 'kind', tab.ipc_d(x)) = p ->> 'test' and tab.ipc_d(x) ->> 'stream' = st ->> 'id'
                                            and recipe.micros_of(x -> 'recordedAt') >= v_end)) then
          v_text := 'a stream has no end-of-run check of a planned test (TB11-END-CHECK)';
        elsif jsonb_array_length(tab.ipc_pending_first(v_all)) > 0 or jsonb_array_length(tab.ipc_pending_friability(v_all)) > 0
              or jsonb_array_length(tab.ipc_open_starts(v_all)) > 0 or jsonb_array_length(tab.ipc_pending_dt(v_all, 'RETEST')) > 0
              or jsonb_array_length(tab.ipc_pending_dt(v_all, 'BUFFER')) > 0 then
          v_text := 'a compendial stage is still pending (TB11-PENDING)';
        end if;
    end case;
    if v_text is not null then
      return format('closes step %s, but %s', k, v_text);
    end if;
  end loop;
  return null;
end
$$;

-- TB-11's bracketing hold for the new entries of row p_new (header): MISSED per missed stream, then FAIL or PASS.
create function tab.ipc_apply_holds(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  e0       jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  k        text;
  e        jsonb;
  d        jsonb;
  v_key    text;
  v_press  text;
  v_stream text;
begin
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_key := e ->> 'stepKey';
    if recipe.step_node(p_content, p_new -> 'steps' -> v_key ->> 'step') -> 'block' ->> 'type' is distinct from 'TB-11' then
      continue;
    end if;
    d := tab.ipc_d(e);
    select tab.ipc_d(x) ->> 'press' into v_press from jsonb_array_elements(tab.gran_prior(p_new, v_key, 'Infinity'::numeric, 'RUN_START')) x limit 1;
    for v_stream in select m.v ->> 'stream' from jsonb_array_elements(case when jsonb_typeof(d -> 'missed') = 'array' then d -> 'missed' else '[]'::jsonb end) with ordinality m (v, i)
                     group by m.v ->> 'stream' order by min(m.i) loop
      perform plant.record_ipc_check(p_batch, v_press, v_stream, 'MISSED', format('TB11:%s:%s:MISSED', v_key, k));
    end loop;
    if e ->> 'kind' in ('WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE', 'PHYSICAL_CHECK', 'FRIABILITY_RUN', 'DT_END', 'STATION_SWEEP') and d ->> 'result' in ('PASS', 'ALERT', 'FAIL') then
      perform plant.record_ipc_check(p_batch, v_press, d ->> 'stream', case when d ->> 'result' = 'FAIL' then 'FAIL' else 'PASS' end, format('TB11:%s:%s', v_key, k));
    end if;
  end loop;
end
$$;

-- Whether the batch's MBR has a step of an IPC block (TB-11 only when p_scheduler).
create function tab.ipc_batch_has(p_content jsonb, p_scheduler boolean) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
                  where p -> 'block' ->> 'type' = any (case when p_scheduler then array['TB-11'] else array['TB-11', 'TB-12', 'TB-13', 'TB-14', 'TB-15'] end))
$$;

-- The row trigger (header).
create function tab.ipc_state_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
  v_code    text;
begin
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not tab.ipc_batch_has(v_content, false) then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_problem := tab.ipc_entry_problem(new.batch_id, v_content, old.state, new.state, r);
  v_code := 'EBMR-TAB-300';
  if v_problem is null then
    v_problem := tab.ipc_close_problem(v_content, old.state, new.state);
    v_code := 'EBMR-TAB-301';
  end if;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: an IPC step records what its block builds and evaluates, on a checked instrument, and closes only complete (IN-34, IN-35, PR-29, DI-28, DI-29, DI-32, INV-41). [%s]',
                       case when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem, v_code);
  end if;
  if tab.ipc_batch_has(v_content, true) then
    perform tab.ipc_apply_holds(new.batch_id, v_content, old.state, new.state);
  end if;
  return null;
end
$$;

create trigger zzf_tab_ipc after update on recipe.execution_state
  for each row execute function tab.ipc_state_check();

-- PR-29, IN-35 (c): a PASS check of a batch with a TB-11 step is the record of a passing TB-11 entry (header).
create function tab.ipc_pass_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  v_content jsonb;
  v_state   jsonb;
  v_m       text[];
  e         jsonb;
  v_press   text;
begin
  if new.result is distinct from 'PASS' then
    return new;
  end if;
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not tab.ipc_batch_has(v_content, true) then
    return new;
  end if;
  v_m := regexp_match(new.reference, '^TB11:(.+):(EN-[1-9][0-9]{0,8})$');
  select s.state into v_state from recipe.execution_state s where s.batch_id = new.batch_id;
  e := v_state -> 'entries' -> v_m[2];
  if e is not null then
    select tab.ipc_d(x) ->> 'press' into v_press from jsonb_array_elements(tab.gran_prior(v_state, v_m[1], 'Infinity'::numeric, 'RUN_START')) x limit 1;
  end if;
  if v_m is null or e is null or e ->> 'stepKey' is distinct from v_m[1]
     or recipe.step_node(v_content, v_state -> 'steps' -> v_m[1] ->> 'step') -> 'block' ->> 'type' is distinct from 'TB-11'
     or e ->> 'kind' not in ('WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE', 'PHYSICAL_CHECK', 'FRIABILITY_RUN', 'DT_END', 'STATION_SWEEP')
     or tab.ipc_d(e) ->> 'result' not in ('PASS', 'ALERT') or tab.ipc_d(e) ->> 'stream' is distinct from new.stream or v_press is distinct from new.press_code
     or exists (select 1 from plant.ipc_check k where k.batch_id = new.batch_id and k.reference = new.reference) then
    raise exception using errcode = 'P0001',
      message = 'A passing in-process check of a batch whose MBR runs a TB-11 IPC scheduler is recorded only from a passing check entry of that scheduler, for its press and stream, once: a container is vouched for only by a recorded passing result (PR-29, IN-35). [EBMR-TAB-302]';
  end if;
  return new;
end
$$;

create trigger aa_tab_ipc_pass before insert on plant.ipc_check
  for each row execute function tab.ipc_pass_check();

-- ---------------------------------------------------------------------------------------------
-- The missed-check timer at database time (header)

create table tab.ipc_overdue_alarm (
  id           uuid primary key default gen_random_uuid(),
  batch_id     uuid not null references recipe.batch_execution (id),
  step_key     text not null check (btrim(step_key) <> ''),
  stream       text not null,
  test         text not null check (test in ('WEIGHT', 'PHYSICAL', 'FRIABILITY', 'DISINTEGRATION', 'SWEEP')),
  due_us       bigint not null,
  person_id    uuid not null,
  account_id   uuid not null,
  detected_at  timestamptz not null default clock_timestamp(),
  unique (batch_id, step_key, stream, test, due_us)
);
revoke all on tab.ipc_overdue_alarm from public;
create trigger aa_ipc_overdue_alarm_insert_only before update or delete on tab.ipc_overdue_alarm for each row execute function kernel.reject_mutation();
create trigger aa_ipc_overdue_alarm_no_truncate before truncate on tab.ipc_overdue_alarm for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('tab.ipc_overdue_alarm', array['detected_at']);
select kernel.register_audited_table('tab.ipc_overdue_alarm', 'ipc_overdue_alarm', 'id', true);
grant select on tab.ipc_overdue_alarm to ebmr_app;

-- The overdue checks of the running TB-11 steps of batch p_batch at instant p_at: [{stepKey, stream, test, by, dueUs}].
create function tab.ipc_overdue_at(p_batch uuid, p_at timestamptz) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, platform, pg_temp as $$
declare
  v_content jsonb := recipe.batch_mbr_content(p_batch);
  v_state   jsonb;
  k         text;
  s         jsonb;
  v_node    jsonb;
  v_out     jsonb := '[]'::jsonb;
begin
  if p_at is null then
    raise exception using errcode = 'P0001', message = 'Name the instant the overdue checks are read at (EBMR-TAB-303)';
  end if;
  select st.state into v_state from recipe.execution_state st where st.batch_id = p_batch;
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(v_state -> 'steps') = 'object' then v_state -> 'steps' else '{}'::jsonb end) x
               where x.value ->> 'status' = 'IN_PROGRESS' order by x.key loop
    v_node := recipe.step_node(v_content, s ->> 'step');
    if v_node -> 'block' ->> 'type' is distinct from 'TB-11' then
      continue;
    end if;
    v_out := v_out || coalesce((select jsonb_agg(jsonb_build_object('stepKey', k) || m order by i)
                                  from jsonb_array_elements(tab.ipc_overdue(tab.gran_prior(v_state, k, 'Infinity'::numeric, null), v_node -> 'config', platform.epoch_micros(p_at)))
                                       with ordinality y (m, i)), '[]'::jsonb);
  end loop;
  return v_out;
end
$$;

-- IN-35 (c): records, at the database's clock, every check of batch p_batch's running TB-11 steps that is overdue and not
-- yet alarmed; returns the new alarms. For a person who executes steps or the execution sweeper.
create function tab.record_ipc_overdue(p_batch uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, iam, plant, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_eval  jsonb;
  m       jsonb;
  v_out   jsonb := '[]'::jsonb;
  v_id    uuid;
begin
  perform iam.assert_not_administrator();
  if not exists (select 1 from recipe.batch_execution where id = p_batch) then
    raise exception using errcode = 'P0001', message = format('Unknown batch %s (EBMR-TAB-303)', p_batch);
  end if;
  v_eval := iam.evaluate_authority((v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, 'EXECUTION.SWEEP', '{}'::jsonb, clock_timestamp(), v_actor ->> 'role_code');
  if not (v_eval ->> 'allowed')::boolean then
    perform iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  end if;
  for m in select x from jsonb_array_elements(tab.ipc_overdue_at(p_batch, clock_timestamp())) x loop
    insert into tab.ipc_overdue_alarm (batch_id, step_key, stream, test, due_us, person_id, account_id)
    values (p_batch, m ->> 'stepKey', m ->> 'stream', m ->> 'test', (m ->> 'dueUs')::bigint, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
    on conflict (batch_id, step_key, stream, test, due_us) do nothing
    returning id into v_id;
    if v_id is not null then
      v_out := v_out || m;
    end if;
    v_id := null;
  end loop;
  return v_out;
end
$$;

revoke all on function tab.ipc_raised(jsonb, jsonb, text, text, text), tab.ipc_values(text, jsonb, boolean, jsonb), tab.ipc_in_unit(numeric, text, text),
  tab.ipc_readings_problem(recipe.execution_command, jsonb, jsonb, text), tab.ipc_plan_problem(jsonb), tab.ipc_first_off_problem(jsonb, jsonb, jsonb, text),
  tab.ipc_entry_problem(uuid, jsonb, jsonb, jsonb, recipe.execution_command), tab.ipc_close_problem(jsonb, jsonb, jsonb),
  tab.ipc_apply_holds(uuid, jsonb, jsonb, jsonb), tab.ipc_batch_has(jsonb, boolean), tab.ipc_state_check(), tab.ipc_pass_check(),
  tab.ipc_overdue_at(uuid, timestamptz), tab.record_ipc_overdue(uuid) from public;
grant execute on function tab.ipc_overdue_at(uuid, timestamptz), tab.record_ipc_overdue(uuid) to ebmr_app;

reset role;
