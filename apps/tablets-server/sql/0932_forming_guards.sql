-- Tablets server, Phase 3 slice 3d (builder B): the rules of the forming blocks TB-06 (roller compaction) and TB-16
-- (bilayer compression) held by the database, and their holds on the slice 1 output containers (tablets spec B.2 TB-06,
-- TB-16; controls IN-26, IN-35, IN-36, PR-08, PR-21, PR-29, DI-28, DI-31, DI-32; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
-- A row trigger on recipe.execution_state (zzg_tab_forming, after update; every row of a batch whose MBR has a TB-06 or a
-- TB-16 step) refuses a row unless:
--   1. every new entry of a TB-06 or TB-16 step holds exactly what its block builds (0931, the twins of tb-06.ts and
--      tb-16.ts) from what was entered, the batch's MBR and markets, the step's earlier entries, the person and the row's
--      database time, and only what the block accepts (EBMR-TAB-340); and with it:
--        * the exceptions its block raises, in the same row: for a value of G-06 outside its acceptance limits
--          PROCESS_VALUE_OUT_OF_LIMITS (the steps after it wait for a deviation; PR-08) and for a read-back that does not
--          match SETPOINT_MISMATCH (G-06's data itself is recipe-core 0520's and tablets 0820's); TB-06's
--          RIBBON_CHECK_FAILED, RIBBON_CHECK_MISSED, SCREEN_INTEGRITY_FAILED and COMPACTION_YIELD_OUT_OF_RANGE (severity ACTION, a
--          deviation required, the steps after it blocked until one is linked), RIBBON_CHECK_ALERT and SCREEN_DAMAGED;
--          TB-16's as TB-11's (tablets 0893): IPC_CHECK_FAILED, IPC_CHECK_MISSED, IPC_CHECK_ALERT, IPC_MANUAL_ENTRY with
--          the step's second person, IPC_LATE_ENTRY; a mill screen check and a hopper charge leave the step needing its
--          second person (IN-36, PR-21);
--        * a TB-06 run starts on a plant PROCESS unit with a use for this batch open now (TB06-PRESS), and a TB-16 run on
--          a press so, after its first-off (a completed TB-10 set-up of that press), on tooling that may still compress,
--          with every layer charged and the MBR's layers and plans within the bilayer rules (tab.bilayer_plan_problem:
--          the 30-min ceiling on every layer, IN-35 (c)); neither unit discharges its streams into separate containers
--          (TB06-DISCHARGE, TB16-DISCHARGE, checked at the start and at every check: a hold on the unit's check series must
--          reach every container of it);
--        * a TB-16 hopper charge names a charge scan of this batch by this person that no other entry names, of a
--          container whose stage is the layer's blend (TB16-CHARGE, TB16-WRONG-BLEND; IN-26 (c), PR-21);
--        * a TB-16 test entry is made on a plant instrument with a use for this batch open now (TB16-INSTRUMENT), and a
--          value captured from it stands on a reading claimed for it in this command (tab.ipc_readings_problem,
--          TB16-DEVICE; DI-31, DI-32);
--        * a mill screen found damaged at a TB-06 step is never checked again at a TB-02 step of the batch either
--          (TB02-SCREEN-DAMAGED; the TB-02 guard of tablets 0851 reads only TB-02 steps);
--   2. a TB-06 or TB-16 step closes (IN_PROGRESS to AWAITING_VERIFICATION or COMPLETED) only complete (EBMR-TAB-341):
--      TB-06 after RUN_END with an end-of-run ribbon check, no mill screen left unchecked after use (IN-36 (b)), granules
--      discharged and the yield recorded; TB-16 with every layer charged, after RUN_END with the sweep of the full tablets,
--      an end-of-run check of every planned test of every layer, and no compendial stage pending (INV-41);
-- and then, for every new entry, records the container hold through the slice 1 container command
-- (plant.record_ipc_check, recipe-core 0541; never a copy) for the unit of the step's run: TB-06 on stream RIBBON
-- (MISSED for a missed ribbon check, then PASS or FAIL for a ribbon check) and on stream MILL (PASS for a screen found
-- intact, FAIL for one found damaged after use: the containers since its last intact check are held, IN-36 (b)); TB-16 on
-- the layer's stream (MISSED for each layer a check finds missed, then PASS or FAIL for a final result). The layers feed
-- the same containers and the unit discharges together, so a layer's failure holds every container of the press filled
-- since that layer's last passing check.
--
-- Replaced from their definitions in tablets 0893 (nothing else of them changes):
--   * tab.ipc_pass_check: a PASS for a batch whose MBR has a TB-11, TB-06 or TB-16 step is the record of a passing entry
--     of such a step, once: TB11 as before; TB16 a passing test entry for its layer's stream and the run's press; TB06 a
--     passing ribbon check (stream RIBBON) or a screen found intact (stream MILL) for the run's compactor (EBMR-TAB-302);
--   * tab.ipc_overdue_at and tab.record_ipc_overdue: the overdue checks of the running TB-16 steps (every layer) and the
--     ribbon checks of the running TB-06 steps are listed and alarmed with TB-11's, and recorded MISSED for the stream of
--     the run's unit at that moment, with the step's block in the reference (EBMR-TAB-303).
--
-- New functions are owned by ebmr_owner; the trigger functions and the alarm functions are SECURITY DEFINER; every
-- function pins its search_path with pg_temp last (ADR 0016). Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- The press (or compactor) of the run of step p_key in state p_state: its RUN_START's press.
create function tab.forming_press(p_state jsonb, p_key text) returns text
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select tab.ipc_d(x) ->> 'press' from jsonb_array_elements(tab.gran_prior(p_state, p_key, 'Infinity'::numeric, 'RUN_START')) x limit 1
$$;

-- Why unit p_press cannot run step p_key's run of batch p_batch (code prefix p_code): no plant PROCESS unit with a use for
-- the batch open now, or one that discharges its streams into separate containers; NULL when it can.
create function tab.forming_unit_problem(p_batch uuid, p_press text, p_code text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, plant, pg_temp as $$
begin
  if not exists (select 1 from plant.equipment q join plant.equipment_use u on u.equipment_id = q.id
                  where q.code = p_press and q.kind = 'PROCESS' and u.batch_id = p_batch
                    and not exists (select 1 from plant.equipment_use_end x where x.use_id = u.id)) then
    return format('%s is no plant PROCESS unit in use for this batch (%s-PRESS; PR-23)', left(coalesce(p_press, '(none)'), 64), p_code);
  end if;
  if plant.press_streams_separate(p_press) then
    return format('%s discharges its streams into separate containers: a hold on its check series would not reach every container (%s-DISCHARGE; PR-29)',
                  left(p_press, 64), p_code);
  end if;
  return null;
end
$$;

-- IN-26, IN-35, IN-36, PR-08, PR-21, PR-29, DI-28, DI-31, DI-32: why a new entry of a forming step in row p_new (after
-- p_old, command row r, MBR p_content, batch p_batch) is not what its block builds or accepts (header item 1); NULL when
-- every one is.
create function tab.forming_entry_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb, r recipe.execution_command) returns text
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
  v_by      jsonb;
  v_prior   jsonb;
  v_what    text;
  v_res     jsonb;
  v_want    jsonb;
  v_member  text;
  v_layer   jsonb;
  v_t       text;
  v_instr   text;
  v_problem text;
  v_press   text;
  g         plant.container_charge;
  v_stage   text;
begin
  for k, e in select x.key, x.value from jsonb_each(e1) x where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_kind := e ->> 'kind';
    v_key := e ->> 'stepKey';
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> v_key ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    v_what := format('entry %s (%s) of step %s', k, coalesce(v_kind, 'unnamed'), coalesce(v_key, '(none)'));
    c := case when jsonb_typeof(r.command -> 'entry') = 'object' then r.command -> 'entry' else '{}'::jsonb end;
    d := case when jsonb_typeof(e -> 'data') = 'object' then e -> 'data' else '{}'::jsonb end;
    -- A mill screen found damaged at a TB-06 step is never checked again at a TB-02 step either.
    if v_type = 'TB-02' and v_kind = 'SCREEN_CHECK' then
      if exists (select 1 from jsonb_array_elements(tab.gran_batch_entries(p_content, p_old, 'SCREEN_CHECK', 'TB-06')) s
                  where tab.ipc_d(s) ->> 'screen' = c ->> 'screen' and tab.ipc_d(s) ->> 'result' = 'DAMAGED') then
        return format('stores %s for screen %s, which was found damaged at a roller compaction step of this batch and is never used again (TB02-SCREEN-DAMAGED)', v_what, c ->> 'screen');
      end if;
      continue;
    end if;
    if v_type is null or v_type not in ('TB-06', 'TB-16') then
      continue;
    end if;
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    v_now := recipe.micros_of(e -> 'recordedAt');
    v_seq := (e ->> 'recordedSeq')::numeric;
    v_by := e -> 'enteredBy';
    v_prior := tab.gran_prior(p_new, v_key, v_seq, null);
    -- G-06's values (their data are recipe-core 0520's and tablets 0820's): the exceptions their block raises (PR-08).
    if v_kind in ('SETPOINT_READBACK', 'ACTUAL', 'ALARM', 'ALARM_ACK', 'INTERFACE_LOSS', 'RECIPE_CHECK') then
      if v_kind = 'ACTUAL' and (d -> 'withinLimits') = 'false'::jsonb and not tab.gran_held(p_old, p_new, v_key, 'PROCESS_VALUE_OUT_OF_LIMITS') then
        return format('stores %s, a value outside its acceptance limits, without the PROCESS_VALUE_OUT_OF_LIMITS exception, holding the steps after it until a deviation is linked (%s-PROCESS-LIMITS; PR-08)',
                      v_what, replace(v_type, '-', ''));
      end if;
      if v_kind = 'SETPOINT_READBACK' and (d -> 'matches') = 'false'::jsonb and not tab.ipc_raised(p_old, p_new, v_key, 'SETPOINT_MISMATCH', 'ACTION') then
        return format('stores %s, a read-back that does not match its setpoint, without the SETPOINT_MISMATCH exception (%s-PROCESS-LIMITS; PR-08)', v_what, replace(v_type, '-', ''));
      end if;
      continue;
    end if;
    -- ------------------------------------------------------------------------------------------- TB-06
    if v_type = 'TB-06' then
      v_res := tab.compaction_entry(v_kind, v_cfg, v_prior, c, v_now, v_by,
                                    tab.gran_batch_entries(p_content, p_old, 'SCREEN_CHECK', 'TB-02') || tab.gran_batch_entries(p_content, p_old, 'SCREEN_CHECK', 'TB-06'));
      if v_res ? 'problem' then
        return format('stores %s, which its block refuses: %s', v_what, v_res ->> 'problem');
      end if;
      v_want := v_res -> 'data';
      if d is distinct from v_want then
        select m into v_member from (select jsonb_object_keys(d) m union select jsonb_object_keys(v_want)) u where (d -> m) is distinct from (v_want -> m) order by m limit 1;
        return format('stores %s with %s %s, where its block writes %s', v_what, v_member, left(coalesce((d -> v_member)::text, '(no such member)'), 300),
                      left(coalesce((v_want -> v_member)::text, '(no such member)'), 300));
      end if;
      for v_t in select jsonb_array_elements_text(v_res -> 'raise') loop
        if not tab.gran_held(p_old, p_new, v_key, v_t) then
          return format('stores %s without the %s exception its block raises with it, holding the steps after it until a deviation is linked', v_what, v_t);
        end if;
      end loop;
      for v_t in select jsonb_array_elements_text(v_res -> 'alerts') loop
        if not tab.ipc_raised(p_old, p_new, v_key, v_t, 'ALERT') then
          return format('stores %s without the %s exception its block raises with it', v_what, v_t);
        end if;
      end loop;
      if (v_res -> 'verify') = 'true'::jsonb and (p_new -> 'steps' -> v_key -> 'verificationRequired') is distinct from 'true'::jsonb then
        return format('stores %s, which needs a second person''s check of its step, and the step does not require it (PR-14)', v_what);
      end if;
      v_press := case when v_kind = 'RUN_START' then d ->> 'press' else tab.forming_press(p_new, v_key) end;
      if v_kind in ('RUN_START', 'RIBBON_CHECK') or (v_kind = 'SCREEN_CHECK' and v_press is not null) then
        v_problem := tab.forming_unit_problem(p_batch, v_press, 'TB06');
        if v_problem is not null then
          return format('stores %s, but %s', v_what, v_problem);
        end if;
      end if;
      continue;
    end if;
    -- ------------------------------------------------------------------------------------------- TB-16
    if v_kind = 'HOPPER_CHARGE' then
      if exists (select 1 from jsonb_array_elements(v_prior) x where x ->> 'kind' = 'RUN_END') then
        return format('stores %s after the run ended (TB16-ENDED)', v_what);
      end if;
      select l into v_layer from jsonb_array_elements(tab.bilayer_layers(v_cfg)) l where l -> 'id' = c -> 'layer' limit 1;
      if v_layer is null then
        return format('stores %s for a layer its MBR does not name (TB16-LAYER)', v_what);
      end if;
      if (c -> 'hopper') is distinct from (v_layer -> 'hopper') then
        return format('stores %s into hopper %s; layer %s is fed from hopper %s only: the hoppers are never swapped (TB16-HOPPER; IN-26 (c))', v_what,
                      left(coalesce(c ->> 'hopper', '(none)'), 32), v_layer ->> 'id', v_layer ->> 'hopper');
      end if;
      if (c -> 'blend') is distinct from (v_layer -> 'stage') then
        return format('stores %s of a container stated to hold another blend than layer %s takes (TB16-WRONG-BLEND; PR-21)', v_what, v_layer ->> 'id');
      end if;
      select * into g from plant.container_charge where id = tab.comp_uuid(c ->> 'chargeId');
      if g.id is null or g.batch_id <> p_batch or g.purpose <> 'CHARGE' or g.person_id::text is distinct from v_by #>> '{}'
         or tab.comp_named(p_old, 'HOPPER_CHARGE', 'chargeId', g.id::text) then
        return format('stores %s, which names no charge scan of this batch by this person that no other entry names (TB16-CHARGE; IN-26 (c))', v_what);
      end if;
      select o.stage into v_stage from plant.output_container o where o.id = g.container_id;
      if v_stage is distinct from v_layer ->> 'stage' then
        return format('stores %s: the container scanned holds %s, and layer %s takes %s only (TB16-WRONG-BLEND; PR-21, IN-26 (c))', v_what, coalesce(v_stage, '(none)'),
                      v_layer ->> 'id', v_layer ->> 'stage');
      end if;
      v_want := jsonb_build_object('layer', v_layer -> 'id', 'hopper', v_layer -> 'hopper', 'blend', v_layer -> 'stage', 'chargeId', c -> 'chargeId', 'chargedBy', v_by);
      if d is distinct from v_want then
        select m into v_member from (select jsonb_object_keys(d) m union select jsonb_object_keys(v_want)) u where (d -> m) is distinct from (v_want -> m) order by m limit 1;
        return format('stores %s with %s %s, where its block writes %s', v_what, v_member, left(coalesce((d -> v_member)::text, '(no such member)'), 300),
                      left(coalesce((v_want -> v_member)::text, '(no such member)'), 300));
      end if;
      if (p_new -> 'steps' -> v_key -> 'verificationRequired') is distinct from 'true'::jsonb then
        return format('stores %s, a charge that needs a second person''s check of its step, and the step does not require it (PR-21)', v_what);
      end if;
      continue;
    end if;
    v_res := tab.bilayer_entry(v_kind, v_cfg, v_prior, c, v_markets, (timestamp 'epoch' + v_now * interval '1 microsecond')::date, v_now, v_by);
    if v_res ? 'problem' then
      return format('stores %s, which its block refuses: %s', v_what, v_res ->> 'problem');
    end if;
    v_want := v_res -> 'data';
    if d is distinct from v_want then
      select m into v_member from (select jsonb_object_keys(d) m union select jsonb_object_keys(v_want)) u where (d -> m) is distinct from (v_want -> m) order by m limit 1;
      return format('stores %s with %s %s, where its block writes %s', v_what, v_member, left(coalesce((d -> v_member)::text, '(no such member)'), 300),
                    left(coalesce((v_want -> v_member)::text, '(no such member)'), 300));
    end if;
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
      return format('stores %s, which finds a missed check, without the IPC_CHECK_MISSED exception, holding the steps after it until a deviation is linked (IN-35)', v_what);
    end if;
    v_instr := tab.ipc_str(d -> 'instrument');
    if v_kind <> 'DT_END' and d ? 'instrument'
       and not exists (select 1 from plant.instrument_use u join plant.equipment q on q.id = u.equipment_id
                        where q.code = v_instr and u.batch_id = p_batch and u.planned_end > clock_timestamp()) then
      return format('stores %s on instrument %s, which has no instrument use for this batch open now: a tester or balance is used only once calibrated with its check passed (TB16-INSTRUMENT; IN-25, DI-32)',
                    v_what, left(coalesce(v_instr, '(none)'), 64));
    end if;
    if d ->> 'capture' = 'DEVICE' then
      v_problem := tab.ipc_readings_problem(r, d -> 'readings', tab.ipc_values(v_kind, tab.bilayer_layer_cfg(v_cfg, (v_res ->> 'layer')::integer), true, c), v_instr);
      if v_problem is not null then
        return format('stores %s as captured from the instrument, but %s (TB16-DEVICE; DI-31, DI-32)', v_what, v_problem);
      end if;
    end if;
    v_press := case when v_kind = 'RUN_START' then d ->> 'press' else tab.forming_press(p_new, v_key) end;
    if v_kind = 'RUN_START' then
      v_problem := coalesce(tab.forming_unit_problem(p_batch, v_press, 'TB16'), tab.ipc_first_off_problem(p_content, p_new, '{"process": "COMPRESSION"}'::jsonb, v_press),
                            tab.press_tooling_problem(p_content, p_new, v_press), tab.bilayer_plan_problem(v_cfg));
      if v_problem is null then
        select format('layer stream %s of %s is also a stream of IPC scheduler step %s: a passing check of one would vouch for the other (TB16-STREAM-CLASH; PR-29)', l ->> 'id', v_key, p ->> 'id')
          into v_problem
          from jsonb_array_elements(tab.bilayer_layers(v_cfg)) l,
               jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
         where p -> 'block' ->> 'type' = 'TB-11'
           and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p -> 'config' -> 'streams') = 'array' then p -> 'config' -> 'streams' else '[]'::jsonb end) s
                        where s -> 'id' = l -> 'id')
         limit 1;
      end if;
      if v_problem is not null then
        return format('starts the run of %s, but %s', v_key, v_problem);
      end if;
    elsif v_kind in ('STATION_SWEEP', 'WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE', 'PHYSICAL_CHECK', 'FRIABILITY_RUN', 'DT_START', 'DT_END') then
      v_problem := tab.forming_unit_problem(p_batch, v_press, 'TB16');
      if v_problem is not null and v_problem like '%TB16-DISCHARGE%' then
        return format('stores %s, but %s', v_what, v_problem);
      end if;
    end if;
  end loop;
  return null;
end
$$;

-- PR-29, IN-35, IN-36, PR-21, INV-41: why a forming step that row p_new closes is not complete (header item 2); NULL
-- when every one is.
create function tab.forming_close_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
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
  v_n    integer;
begin
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) x
               where x.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED') and p_old -> 'steps' -> x.key ->> 'status' = 'IN_PROGRESS' order by x.key loop
    v_node := recipe.step_node(p_content, s ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    if v_type is null or v_type not in ('TB-06', 'TB-16') then
      continue;
    end if;
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    v_all := tab.gran_prior(p_new, k, 'Infinity'::numeric, null);
    select recipe.micros_of(x -> 'recordedAt') into v_end from jsonb_array_elements(v_all) with ordinality y (x, i) where x ->> 'kind' = 'RUN_END' order by i limit 1;
    v_text := null;
    if v_type = 'TB-06' then
      v_text := case
        when v_end is null then 'its run has not ended (TB06-RUNNING)'
        when not exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'RIBBON_CHECK' and recipe.micros_of(x -> 'recordedAt') >= v_end)
          then 'it has no end-of-run ribbon check (TB06-END-CHECK)'
        when exists (select 1 from (select distinct on (tab.ipc_d(x) ->> 'screen') x from jsonb_array_elements(v_all) with ordinality y (x, i)
                                     where x ->> 'kind' = 'SCREEN_CHECK' order by tab.ipc_d(x) ->> 'screen', i desc) z
                      where tab.ipc_d(z.x) ->> 'when' = 'BEFORE' and tab.ipc_d(z.x) ->> 'result' = 'INTACT')
          then 'a mill screen was not checked after use (TB06-AFTER-CHECK-MISSING; IN-36)'
        when not exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'GRANULE_OUTPUT') then 'it has discharged no granules (TB06-NOTHING-DISCHARGED)'
        when not exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'YIELD') then 'it has no yield (TB06-NO-YIELD)'
      end;
    else
      v_n := jsonb_array_length(tab.bilayer_layers(v_cfg));
      v_text := case
        when exists (select 1 from jsonb_array_elements(tab.bilayer_layers(v_cfg)) l
                      where not exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'HOPPER_CHARGE' and tab.ipc_d(x) -> 'layer' = l -> 'id'))
          then 'a layer was never charged (TB16-LAYER-UNCHARGED; PR-21)'
        when v_end is null then 'its run has not ended (TB11-RUNNING)'
        when jsonb_typeof(tab.bilayer_layers(v_cfg) -> (v_n - 1) -> 'sweep') = 'object'
             and not exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'STATION_SWEEP' and tab.ipc_d(x) -> 'stream' = tab.bilayer_layers(v_cfg) -> (v_n - 1) -> 'id')
          then 'the full tablets have no station sweep (TB11-NO-SWEEP)'
        when exists (select 1 from jsonb_array_elements(tab.bilayer_layers(v_cfg)) l,
                                   jsonb_array_elements(case when jsonb_typeof(l -> 'plan') = 'array' then l -> 'plan' else '[]'::jsonb end) p
                      where not exists (select 1 from jsonb_array_elements(v_all) x
                                         where tab.ipc_check_test(x ->> 'kind', tab.ipc_d(x)) = p ->> 'test' and tab.ipc_d(x) -> 'stream' = l -> 'id'
                                           and recipe.micros_of(x -> 'recordedAt') >= v_end))
          then 'a layer has no end-of-run check of a planned test (TB11-END-CHECK)'
        when jsonb_array_length(tab.ipc_pending_first(v_all)) > 0 or jsonb_array_length(tab.ipc_pending_friability(v_all)) > 0
             or jsonb_array_length(tab.ipc_open_starts(v_all)) > 0 or jsonb_array_length(tab.ipc_pending_dt(v_all, 'RETEST')) > 0
             or jsonb_array_length(tab.ipc_pending_dt(v_all, 'BUFFER')) > 0
          then 'a compendial stage is still pending (TB11-PENDING)'
      end;
    end if;
    if v_text is not null then
      return format('closes step %s, but %s', k, v_text);
    end if;
  end loop;
  return null;
end
$$;

-- The container holds of the new entries of row p_new (header): TB-06 on streams RIBBON and MILL of the compactor, TB-16
-- on the layer's stream of the press; MISSED first, then PASS or FAIL.
create function tab.forming_apply_holds(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  e0       jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  k        text;
  e        jsonb;
  d        jsonb;
  v_key    text;
  v_type   text;
  v_code   text;
  v_press  text;
  v_stream text;
begin
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_key := e ->> 'stepKey';
    v_type := recipe.step_node(p_content, p_new -> 'steps' -> v_key ->> 'step') -> 'block' ->> 'type';
    if v_type is null or v_type not in ('TB-06', 'TB-16') then
      continue;
    end if;
    v_press := tab.forming_press(p_new, v_key);
    if v_press is null then
      continue;
    end if;
    v_code := replace(v_type, '-', '');
    d := tab.ipc_d(e);
    for v_stream in select m.v ->> 'stream' from jsonb_array_elements(case when jsonb_typeof(d -> 'missed') = 'array' then d -> 'missed' else '[]'::jsonb end) with ordinality m (v, i)
                     group by m.v ->> 'stream' order by min(m.i) loop
      perform plant.record_ipc_check(p_batch, v_press, v_stream, 'MISSED', format('%s:%s:%s:MISSED', v_code, v_key, k));
    end loop;
    if v_type = 'TB-06' then
      if e ->> 'kind' = 'RIBBON_CHECK' then
        perform plant.record_ipc_check(p_batch, v_press, 'RIBBON', case when d ->> 'result' = 'FAIL' then 'FAIL' else 'PASS' end, format('TB06:%s:%s', v_key, k));
      elsif e ->> 'kind' = 'SCREEN_CHECK' and d ->> 'result' = 'INTACT' then
        perform plant.record_ipc_check(p_batch, v_press, 'MILL', 'PASS', format('TB06:%s:%s', v_key, k));
      elsif e ->> 'kind' = 'SCREEN_CHECK' and d ->> 'when' = 'AFTER' then
        perform plant.record_ipc_check(p_batch, v_press, 'MILL', 'FAIL', format('TB06:%s:%s', v_key, k));
      end if;
    elsif e ->> 'kind' in ('WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE', 'PHYSICAL_CHECK', 'FRIABILITY_RUN', 'DT_END', 'STATION_SWEEP') and d ->> 'result' in ('PASS', 'ALERT', 'FAIL') then
      perform plant.record_ipc_check(p_batch, v_press, d ->> 'stream', case when d ->> 'result' = 'FAIL' then 'FAIL' else 'PASS' end, format('TB16:%s:%s', v_key, k));
    end if;
  end loop;
end
$$;

-- The row trigger (header).
create function tab.forming_state_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
  v_code    text;
begin
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not exists (select 1 from jsonb_path_query(coalesce(v_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
                  where p -> 'block' ->> 'type' in ('TB-06', 'TB-16')) then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_problem := tab.forming_entry_problem(new.batch_id, v_content, old.state, new.state, r);
  v_code := 'EBMR-TAB-340';
  if v_problem is null then
    v_problem := tab.forming_close_problem(v_content, old.state, new.state);
    v_code := 'EBMR-TAB-341';
  end if;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: a roller compaction or bilayer step records what its block builds, on its unit and its checked instruments, and closes only complete (IN-26, IN-35, IN-36, PR-08, PR-21, PR-29, DI-31). [%s]',
                       case when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem, v_code);
  end if;
  perform tab.forming_apply_holds(new.batch_id, v_content, old.state, new.state);
  return null;
end
$$;

create trigger zzg_tab_forming after update on recipe.execution_state
  for each row execute function tab.forming_state_check();

-- ---------------------------------------------------------------------------------------------
-- Replaced from tablets 0893 (header)

-- As 0893, with the passing entries of TB-06 and TB-16 steps beside TB-11's, and a passing print check of a TB-19 printer
-- (tablets 0912) accepted.
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
                  where p -> 'block' ->> 'type' in ('TB-11', 'TB-06', 'TB-16')) then
    return new;
  end if;
  -- Slice 3d (builder A): a passing print check of a printer of the batch's TB-19 steps is held by tablets 0912
  -- (tab.coat_print_pass, trigger aa_tab_coat_pass); such a check is not refused here.
  if new.reference ~ '^TB19:' and (tab.coat_print_pass(new.batch_id, new.press_code, new.stream, new.reference) -> 'printer') = 'true'::jsonb
     and tab.coat_print_pass(new.batch_id, new.press_code, new.stream, new.reference) ->> 'problem' is null then
    return new;
  end if;
  v_m := regexp_match(new.reference, '^(TB11|TB06|TB16):(.+):(EN-[1-9][0-9]{0,8})$');
  select s.state into v_state from recipe.execution_state s where s.batch_id = new.batch_id;
  e := v_state -> 'entries' -> v_m[3];
  if e is not null then
    select tab.ipc_d(x) ->> 'press' into v_press from jsonb_array_elements(tab.gran_prior(v_state, v_m[2], 'Infinity'::numeric, 'RUN_START')) x limit 1;
    v_type := recipe.step_node(v_content, v_state -> 'steps' -> v_m[2] ->> 'step') -> 'block' ->> 'type';
  end if;
  v_ok := v_m is not null and e is not null and e ->> 'stepKey' = v_m[2] and v_type = 'TB-' || substr(v_m[1], 3)
          and v_press is not distinct from new.press_code
          and not exists (select 1 from plant.ipc_check k where k.batch_id = new.batch_id and k.reference = new.reference)
          and case when v_m[1] = 'TB06'
                   then (e ->> 'kind' = 'RIBBON_CHECK' and tab.ipc_d(e) ->> 'result' in ('PASS', 'ALERT') and new.stream is not distinct from 'RIBBON')
                        or (e ->> 'kind' = 'SCREEN_CHECK' and tab.ipc_d(e) ->> 'result' = 'INTACT' and new.stream is not distinct from 'MILL')
                   else e ->> 'kind' in ('WEIGHT_CHECK', 'WEIGHT_SECOND_STAGE', 'PHYSICAL_CHECK', 'FRIABILITY_RUN', 'DT_END', 'STATION_SWEEP')
                        and tab.ipc_d(e) ->> 'result' in ('PASS', 'ALERT') and tab.ipc_d(e) ->> 'stream' is not distinct from new.stream end;
  if v_ok is not true then
    raise exception using errcode = 'P0001',
      message = 'A passing in-process check of a batch whose MBR runs a TB-11 IPC scheduler, a roller compaction (TB-06) or a bilayer run (TB-16) is recorded only from a passing check entry of such a step, for its unit and stream, once: a container is vouched for only by a recorded passing result (PR-29, IN-35). [EBMR-TAB-302]';
  end if;
  return new;
end
$$;

-- As 0893, with the running TB-16 steps (every layer, as tab.bilayer_missed) and TB-06 steps (the ribbon check) beside
-- the TB-11 steps.
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
    end;
    if v_items is null then
      continue;
    end if;
    v_out := v_out || coalesce((select jsonb_agg(jsonb_build_object('stepKey', k) || m order by i) from jsonb_array_elements(v_items) with ordinality y (m, i)), '[]'::jsonb);
  end loop;
  return v_out;
end
$$;

-- As 0893, with the reference naming the step's block (TB11, TB16, TB06) and the press of the step's run (a TB-06
-- compactor too).
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
      v_press := tab.forming_press(v_state, m ->> 'stepKey');
      v_code := replace(recipe.step_node(v_content, v_state -> 'steps' -> (m ->> 'stepKey') ->> 'step') -> 'block' ->> 'type', '-', '');
      if v_exec then
        perform plant.record_ipc_check(p_batch, v_press, m ->> 'stream', 'MISSED', format('%s:%s:OVERDUE:%s', v_code, m ->> 'stepKey', m ->> 'dueUs'));
      else
        perform plant.record_missed_ipc_check(p_batch, v_press, m ->> 'stream', format('%s:%s:OVERDUE:%s', v_code, m ->> 'stepKey', m ->> 'dueUs'));
      end if;
      v_out := v_out || (m || jsonb_build_object('held', true));
    end if;
    v_id := null;
  end loop;
  return v_out;
end
$$;

revoke all on function tab.forming_press(jsonb, text), tab.forming_unit_problem(uuid, text, text),
  tab.forming_entry_problem(uuid, jsonb, jsonb, jsonb, recipe.execution_command), tab.forming_close_problem(jsonb, jsonb, jsonb),
  tab.forming_apply_holds(uuid, jsonb, jsonb, jsonb), tab.forming_state_check() from public;

reset role;
