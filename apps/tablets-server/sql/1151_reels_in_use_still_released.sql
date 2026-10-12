-- Tablets server, Phase 4 slice 2b: a reel quarantined, held, recalled or expired mid-run is caught at the run's next
-- entry (Phase 3 slice 4 review backlog: "reel release and expiry are checked at entry only"; controls PR-33, PR-45).
--
-- TB-21 checks each reel at its LINE_SETUP and REEL_CHANGE only (tablets 0972, tab.blister_lot_problem), so a reel lot
-- that QA put ON_HOLD (or RETURNED, RECALLED, REJECTED) after the set-up, or that expired since, stayed on the machine.
--
--   tab.reels_in_use(content, state, run key)  the reels on the run's machine now: those of the latest
--       LINE_SETUP of a TB-21 line-check step on the machine of the run's RUN_START, each role replaced by the run's
--       later REEL_CHANGEs in order.
--   tab.reel_in_use_problem(batch, content, state, run key, now)  the first reel whose lot is not RELEASED and
--       unexpired in the register now (tab.lot_facts, 0801/1000: RELEASED only while the lot's state is usable), or NULL.
--   trigger zzi_tab_reels_in_use on recipe.execution_state (after update; a batch whose MBR has a TB-21 step): every new
--       person's entry of a TB-21 RUN step while the run is on (RUN_START up to and including RUN_END: RUN_START,
--       RECIPE_CHECK, REEL_CHANGE, DEFECT_CHECK, REJECTS, RUN_END) is refused while a reel in use fails that test
--       (EBMR-TAB-853, TB21-REEL-NOT-RELEASED). A REEL_CHANGE is judged on the reels after it, so replacing the reel is the
--       way on. Device readings, alarms and their acknowledgement are never refused (they record what happened), and
--       entries after RUN_END (the count, the end-of-run check) record a run that is over.
-- Applied as a new migration; the existing triggers are unchanged.

set local role ebmr_owner;

create function tab.reels_in_use(p_content jsonb, p_state jsonb, p_run_key text) returns jsonb
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_machine text;
  v_reels   jsonb;
  x         jsonb;
  d         jsonb;
begin
  select tab.ipc_d(y) ->> 'machine' into v_machine
    from jsonb_array_elements(tab.gran_prior(p_state, p_run_key, 'Infinity'::numeric, 'RUN_START')) y limit 1;
  if v_machine is null then
    return '[]'::jsonb;
  end if;
  select tab.ipc_d(e.value) -> 'reels' into v_reels
    from jsonb_each(case when jsonb_typeof(p_state -> 'entries') = 'object' then p_state -> 'entries' else '{}'::jsonb end) e
    cross join lateral (select recipe.step_node(p_content, p_state -> 'steps' -> (e.value ->> 'stepKey') ->> 'step') as n) z
   where e.value ->> 'kind' = 'LINE_SETUP' and z.n -> 'block' ->> 'type' = 'TB-21' and tab.ipc_d(e.value) ->> 'machine' = v_machine
   order by (e.value ->> 'recordedSeq')::numeric desc limit 1;
  if jsonb_typeof(v_reels) is distinct from 'array' then
    v_reels := '[]'::jsonb;
  end if;
  for x in select y from jsonb_array_elements(tab.gran_prior(p_state, p_run_key, 'Infinity'::numeric, 'REEL_CHANGE')) y loop
    d := tab.ipc_d(x) - 'changedBy';
    v_reels := coalesce((select jsonb_agg(r) from jsonb_array_elements(v_reels) r where r -> 'role' is distinct from d -> 'role'), '[]'::jsonb) || jsonb_build_array(d);
  end loop;
  return v_reels;
end
$$;

create function tab.reel_in_use_problem(p_batch uuid, p_content jsonb, p_state jsonb, p_run_key text, p_now numeric) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r       jsonb;
  v_facts jsonb;
begin
  for r in select y from jsonb_array_elements(tab.reels_in_use(p_content, p_state, p_run_key)) y loop
    v_facts := tab.lot_facts(r ->> 'lot', p_batch);
    if v_facts is null or v_facts ->> 'status' is distinct from 'RELEASED'
       or (v_facts ->> 'expiresAtUs' is not null and (v_facts ->> 'expiresAtUs')::numeric <= p_now) then
      return format('the %s reel on the machine, lot %s, is %s in the register now; replace the reel (REEL_CHANGE) or stop the run (TB21-REEL-NOT-RELEASED; PR-33, PR-45)',
                    coalesce(r ->> 'role', 'unnamed'), left(coalesce(r ->> 'lot', '(none)'), 64),
                    case when v_facts is null then 'unknown'
                         when v_facts ->> 'status' is distinct from 'RELEASED' then coalesce(v_facts ->> 'status', 'not released')
                         else 'expired' end);
    end if;
  end loop;
  return null;
end
$$;

create function tab.reels_in_use_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_content jsonb;
  e0        jsonb := case when jsonb_typeof(old.state -> 'entries') = 'object' then old.state -> 'entries' else '{}'::jsonb end;
  k         text;
  e         jsonb;
  v_node    jsonb;
  v_key     text;
  v_prior   jsonb;
  v_problem text;
begin
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not exists (select 1 from jsonb_path_query(coalesce(v_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
                  where p -> 'block' ->> 'type' = 'TB-21') then
    return null;
  end if;
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    if e ->> 'kind' is null or e ->> 'kind' not in ('RUN_START', 'RECIPE_CHECK', 'REEL_CHANGE', 'DEFECT_CHECK', 'REJECTS', 'RUN_END') then
      continue;
    end if;
    v_key := e ->> 'stepKey';
    v_node := recipe.step_node(v_content, new.state -> 'steps' -> v_key ->> 'step');
    if v_node -> 'block' ->> 'type' is distinct from 'TB-21' or coalesce(v_node -> 'config' ->> 'part', 'LINE_CHECK') <> 'RUN' then
      continue;
    end if;
    v_prior := tab.gran_prior(new.state, v_key, (e ->> 'recordedSeq')::numeric, null);
    if e ->> 'kind' <> 'RUN_START' and exists (select 1 from jsonb_array_elements(v_prior) x where x ->> 'kind' = 'RUN_END') then
      continue;
    end if;
    v_problem := tab.reel_in_use_problem(new.batch_id, v_content, new.state, v_key, recipe.micros_of(e -> 'recordedAt'));
    if v_problem is not null then
      raise exception using errcode = 'P0001',
        message = format('This row stores entry %s (%s) of step %s, but %s. [EBMR-TAB-853]', k, e ->> 'kind', v_key, v_problem);
    end if;
  end loop;
  return null;
end
$$;

create trigger zzi_tab_reels_in_use after update on recipe.execution_state
  for each row execute function tab.reels_in_use_check();

revoke all on function tab.reels_in_use(jsonb, jsonb, text), tab.reel_in_use_problem(uuid, jsonb, jsonb, text, numeric), tab.reels_in_use_check() from public;

reset role;
