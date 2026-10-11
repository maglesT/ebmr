-- Tablets server, Phase 3 slice 4b (builder A): the rules of the blister blocks TB-21 (line set-up, independent check
-- and sealing) and TB-22 (leak test) held by the database, the line they run on, and their holds on the slice 1 output
-- containers (tablets spec B.2 TB-21, TB-22; controls IN-38, PR-29, PR-33, PR-34, PR-35, PR-37; ADR 0012: the rules hold
-- when the application's own database credentials are used directly).
--
-- A row trigger on recipe.execution_state (zzh_tab_blister, after update; every row of a batch whose MBR has a TB-21 or
-- a TB-22 step) refuses a row unless:
--   1. every new entry of a TB-21 or TB-22 step holds exactly what its block builds (0971, the twins of tb-21.ts and
--      tb-22.ts) from what was entered, the step's configuration and earlier entries, the person and the row's database
--      time, and only what the block accepts (EBMR-TAB-370); with the exceptions its block raises in the same row
--      (DEFECT_CHECK_FAILED, BLISTER_COUNT_UNEXPLAINED, LEAK_TEST_FAILED, LEAK_TEST_MISSED: severity ACTION, a deviation
--      required, the steps after it held until one is linked; those of G-06's values are tablets 0913's) and the step's
--      second person where the block needs one (the equipment check, a reel change, a leak test); and with it:
--        * a TB-21 line set-up names a plant PROCESS unit in use for this batch that does not discharge its streams into
--          separate containers (TB21-PRESS, TB21-DISCHARGE: tab.forming_unit_problem, 0932), whose area is a packaging
--          line occupied now by this batch for its packaging order, on a passed and verified PACKAGING_ORDER clearance
--          for that order and the artwork set scanned (TB21-LINE; L-29, PR-34, PR-35);
--        * a potent or beta-lactam uncoated product (the MBR's product flags, or the plant product list's highly-potent
--          flag) is set up and run only on a line flagged isolated (tab.line_isolated, 0970; TB21-ISOLATION, IN-38 (d));
--        * every reel scanned at the set-up or a reel change is a lot of the register of the web's material, released
--          and unexpired at the row's time (TB21-LOT, PR-33); a printed web's reel is a lot issued for that item at the
--          MBR's G-21 step of this batch (TB21-FOIL-NOT-ISSUED: G-21's issue, recipe-core 0580 and tablets 0950, never a
--          copy);
--        * a TB-21 run and a TB-22 run start on such a unit, on the line still occupied by the order, only after a TB-21
--          line check of this batch on the same machine, completed (performed and verified by two persons: the engine and
--          recipe-core refuse a verifier who performed it, INV-03) with a passing equipment check (TB21-NO-LINE-CHECK,
--          TB22-NO-LINE-CHECK; IN-38 (a));
--   2. a TB-21 or TB-22 step closes (IN_PROGRESS to AWAITING_VERIFICATION or COMPLETED) only complete (EBMR-TAB-371): the
--      line check with its set-up and a passing equipment check; the run after RUN_END with its count and a last defect
--      check that passes; the leak test after RUN_END with an end-of-run test of every track;
-- and then, for every new entry, records the container hold through the slice 1 container command
-- (plant.record_ipc_check, recipe-core 0541; never a copy) for the machine of the step's run (tab.blister_hold): TB-21 on
-- stream LINE (FAIL for a G-06 value outside its validated range and for a failing defect check, PASS for a passing
-- one); TB-22 on the track's stream (MISSED for each track an entry finds missed, then PASS or FAIL for a leak test). A
-- FAIL or MISSED holds besides every container of the machine since the last passing check of its own series: the
-- slice 1 window also ends at a whole-unit pass (a G-21 first print or challenge on the same unit), which says nothing
-- about sealing or leaks.
--
-- Replaced from their definitions in tablets 0932 (nothing else of them changes):
--   * tab.ipc_pass_check: a PASS for a batch whose MBR has a TB-21 or TB-22 step besides TB-11, TB-06 and TB-16 is also
--     the record of a passing defect check (stream LINE) or a passing leak test (its track's stream) of such a step, for
--     the machine of its run, once (EBMR-TAB-302); a passing G-21 entry's check (first print, challenge; tab.g21_pass_ok)
--     is accepted, and a reference whose own trigger holds it (tab.ipc_pass_delegate: TB-23, TB-24 of tablets 0987)
--     is left to that trigger for a unit a step of its block names (lead, slice 4b: a blister and cartoning order
--     records the PASS checks of every block);
--   * tab.ipc_overdue_at and tab.record_ipc_overdue: the overdue leak tests of the running TB-22 steps are listed and
--     alarmed with the others (test LEAK), and recorded MISSED for the machine of the run at that moment, with the hold
--     of the track's own series (EBMR-TAB-303).
--
-- New functions are owned by ebmr_owner; the trigger functions and the alarm functions are SECURITY DEFINER; every
-- function pins its search_path with pg_temp last (ADR 0016). Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- The machine of step p_key in state p_state: its RUN_START's machine, else its LINE_SETUP's.
create function tab.blister_machine(p_state jsonb, p_key text) returns text
language sql immutable set search_path = pg_catalog, tab, pg_temp as $$
  select coalesce((select tab.ipc_d(x) ->> 'machine' from jsonb_array_elements(tab.gran_prior(p_state, p_key, 'Infinity'::numeric, 'RUN_START')) x limit 1),
                  (select tab.ipc_d(x) ->> 'machine' from jsonb_array_elements(tab.gran_prior(p_state, p_key, 'Infinity'::numeric, 'LINE_SETUP')) x limit 1))
$$;

-- L-29, PR-34, PR-35: why machine p_machine is not on a line that runs batch p_batch's packaging order now, cleared for it
-- (and for artwork set p_artwork when given); NULL when it is.
create function tab.blister_line_problem(p_batch uuid, p_machine text, p_artwork text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, plant, recipe, pg_temp as $$
declare
  v_order text := (select b.batch_number from recipe.batch_execution b where b.id = p_batch);
  o       record;
begin
  select x.*, c.clearance_type, c.next_order, c.next_artwork_set, c.recorded_result into o
    from plant.equipment q
    join plant.area a on a.id = q.area_id and a.kind = 'LINE'
    join plant.area_occupancy_status x on x.area_id = a.id and x.ended_at is null
    left join plant.clearance c on c.id = x.clearance_id
   where q.code = p_machine
   order by x.started_at desc limit 1;
  if o.id is null or o.batch_id <> p_batch or o.packaging_order is distinct from v_order then
    return format('machine %s is on no packaging line occupied now by packaging order %s (TB21-LINE; PR-35)', left(coalesce(p_machine, '(none)'), 64), coalesce(v_order, '(none)'));
  end if;
  if o.clearance_type is distinct from 'PACKAGING_ORDER' or o.recorded_result is distinct from 'PASSED' or o.next_order is distinct from v_order
     or o.next_artwork_set is distinct from o.artwork_set
     or not exists (select 1 from plant.clearance_verification v where v.clearance_id = o.clearance_id) then
    return format('the line of machine %s is not occupied on a passed and verified clearance for packaging order %s and its artwork set (TB21-LINE; PR-34)', left(p_machine, 64), v_order);
  end if;
  if p_artwork is not null and o.artwork_set is distinct from p_artwork then
    return format('the line of machine %s was cleared for artwork set %s, not %s (TB21-LINE; PR-34)', left(p_machine, 64), o.artwork_set, left(p_artwork, 128));
  end if;
  return null;
end
$$;

-- IN-38 (d): why the product of batch p_batch (TB-21 configuration p_cfg) may not be packed on machine p_machine's line;
-- NULL when it may.
create function tab.blister_isolation_problem(p_batch uuid, p_cfg jsonb, p_machine text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, plant, recipe, pg_temp as $$
declare
  v_potent boolean := (p_cfg -> 'product' -> 'potent') = 'true'::jsonb
                      or exists (select 1 from plant.product p where p.code = recipe.batch_product(p_batch) ->> 'code' and p.highly_potent);
  v_area   uuid := (select q.area_id from plant.equipment q where q.code = p_machine);
begin
  if (p_cfg -> 'product' -> 'uncoated') = 'true'::jsonb and (v_potent or (p_cfg -> 'product' -> 'betaLactam') = 'true'::jsonb)
     and (v_area is null or not tab.line_isolated(v_area)) then
    return format('the product is an uncoated %s product and the line of machine %s is not flagged isolated (TB21-ISOLATION; IN-38)',
                  case when v_potent then 'potent' else 'beta-lactam' end, left(coalesce(p_machine, '(none)'), 64));
  end if;
  return null;
end
$$;

-- PR-33: why reel p_reel ({role, material, lot, item?}) cannot be used at batch p_batch at instant p_now (TB-21
-- configuration p_cfg, state p_state, MBR p_content); NULL when it can.
create function tab.blister_lot_problem(p_batch uuid, p_content jsonb, p_state jsonb, p_cfg jsonb, p_reel jsonb, p_now numeric) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_facts jsonb := tab.lot_facts(p_reel ->> 'lot', p_batch);
begin
  if v_facts is null or v_facts ->> 'materialCode' is distinct from p_reel ->> 'material' or v_facts ->> 'status' is distinct from 'RELEASED'
     or (v_facts ->> 'expiresAtUs' is not null and (v_facts ->> 'expiresAtUs')::numeric <= p_now) then
    return format('reel lot %s is no released, unexpired lot of material %s in the register (TB21-LOT; PR-33)', left(coalesce(p_reel ->> 'lot', '(none)'), 64), p_reel ->> 'material');
  end if;
  if p_reel ? 'item' and not exists (
       select 1 from jsonb_each(case when jsonb_typeof(p_state -> 'entries') = 'object' then p_state -> 'entries' else '{}'::jsonb end) x
        where x.value ->> 'kind' = 'ISSUE'
          and p_state -> 'steps' -> (x.value ->> 'stepKey') ->> 'step' = p_cfg ->> 'printedStep'
          and recipe.step_node(p_content, p_cfg ->> 'printedStep') -> 'block' ->> 'type' = 'G-21'
          and tab.ipc_d(x.value) -> 'item' = p_reel -> 'item' and tab.ipc_d(x.value) -> 'lot' -> 'id' = p_reel -> 'lot') then
    return format('reel lot %s of printed item %s was not issued at the G-21 step %s of this batch (TB21-FOIL-NOT-ISSUED; PR-33)', left(p_reel ->> 'lot', 64), p_reel ->> 'item',
                  coalesce(p_cfg ->> 'printedStep', '(none)'));
  end if;
  return null;
end
$$;

-- IN-38 (a): why machine p_machine has no completed independent line check in state p_state (MBR p_content); NULL when
-- it has. p_code: the rule code to name.
create function tab.blister_line_check_problem(p_content jsonb, p_state jsonb, p_machine text, p_code text) returns text
language sql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
  select case when not exists (
    select 1 from jsonb_each(case when jsonb_typeof(p_state -> 'steps') = 'object' then p_state -> 'steps' else '{}'::jsonb end) s
     cross join lateral (select recipe.step_node(p_content, s.value ->> 'step') as n) z
     where s.value ->> 'status' = 'COMPLETED' and z.n -> 'block' ->> 'type' = 'TB-21' and coalesce(z.n -> 'config' ->> 'part', 'LINE_CHECK') <> 'RUN'
       and jsonb_typeof(z.n -> 'signatures' -> 'check') = 'object'
       and exists (select 1 from jsonb_array_elements(tab.gran_prior(p_state, s.key, 'Infinity'::numeric, 'LINE_SETUP')) x where tab.ipc_d(x) ->> 'machine' = p_machine)
       and (select tab.ipc_d(x) ->> 'result' from jsonb_array_elements(tab.gran_prior(p_state, s.key, 'Infinity'::numeric, 'EQUIPMENT_CHECK')) with ordinality y (x, i) order by i desc limit 1) = 'PASS')
  then format('machine %s has no completed independent line check in this batch (performed and verified by two persons, with a passing equipment check) (%s; IN-38)',
              left(coalesce(p_machine, '(none)'), 64), p_code) end
$$;

-- Records check p_result of machine p_machine's series p_stream for batch p_batch through the slice 1 container command
-- (p_transition: as a person who executes steps, plant.record_ipc_check; else as the sweeper, plant.record_missed_ipc_check)
-- and, for a FAIL or MISSED, holds besides every container of the machine whose open interval reaches into (the last
-- PASS of the same series, the check] (header).
create function tab.blister_hold(p_batch uuid, p_machine text, p_stream text, p_result text, p_reference text, p_transition boolean) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, plant, iam, platform, pg_temp as $$
declare
  v_actor jsonb;
  v_check jsonb;
  k       plant.ipc_check;
  v_lp    timestamptz;
  r       record;
begin
  if p_transition then
    v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
    v_check := plant.record_ipc_check(p_batch, p_machine, p_stream, p_result, p_reference);
  else
    v_actor := iam.require_permission('EXECUTION.SWEEP', '{}'::jsonb);
    v_check := plant.record_missed_ipc_check(p_batch, p_machine, p_stream, p_reference);
  end if;
  if p_result = 'PASS' then
    return;
  end if;
  select * into k from plant.ipc_check where id = (v_check ->> 'ipc_check_id')::uuid;
  select max(x.recorded_at) into v_lp from plant.ipc_check x
   where x.batch_id = p_batch and x.press_code = p_machine and x.result = 'PASS' and x.stream = p_stream and x.recorded_at < k.recorded_at;
  for r in
    with recursive direct as (
      select c.id from plant.output_container c left join plant.container_close x on x.container_id = c.id
       where c.batch_id = p_batch and c.press_code = p_machine and c.opened_at <= k.recorded_at
         and coalesce(x.closed_at, 'infinity'::timestamptz) > coalesce(v_lp, '-infinity'::timestamptz)),
    reach (id, via) as (
      select d.id, null::uuid from direct d
      union
      select m.target_id, coalesce(rr.via, rr.id) from plant.container_merge m join reach rr on m.source_id = rr.id
    )
    select distinct on (x.id) x.id, x.via from reach x order by x.id, x.via nulls first
  loop
    insert into plant.container_hold (container_id, ipc_check_id, via_container_id, person_id, account_id)
    values (r.id, k.id, r.via, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid)
    on conflict (container_id, ipc_check_id) do nothing;
    if p_transition then
      perform plant.apply_hold(r.id);
    end if;
  end loop;
end
$$;

-- IN-38, PR-29, PR-33, PR-34, PR-35, PR-37: why a new entry of a blister step in row p_new (after p_old, MBR p_content,
-- batch p_batch, command row r) is not what its block builds or accepts (header item 1); NULL when every one is.
create function tab.blister_entry_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb, r recipe.execution_command) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1        jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
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
  v_by      jsonb;
  v_prior   jsonb;
  v_what    text;
  v_res     jsonb;
  v_want    jsonb;
  v_member  text;
  v_t       text;
  v_reel    jsonb;
  v_machine text;
  v_problem text;
  v_code    text;
begin
  for k, e in select x.key, x.value from jsonb_each(e1) x where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_kind := e ->> 'kind';
    v_key := e ->> 'stepKey';
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> v_key ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    if v_type is null or v_type not in ('TB-21', 'TB-22') then
      continue;
    end if;
    v_what := format('entry %s (%s) of step %s', k, coalesce(v_kind, 'unnamed'), coalesce(v_key, '(none)'));
    c := case when jsonb_typeof(r.command -> 'entry') = 'object' then r.command -> 'entry' else '{}'::jsonb end;
    d := tab.ipc_d(e);
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    v_now := recipe.micros_of(e -> 'recordedAt');
    v_by := e -> 'enteredBy';
    v_prior := tab.gran_prior(p_new, v_key, (e ->> 'recordedSeq')::numeric, null);
    v_code := replace(v_type, '-', '');
    if v_type = 'TB-22' then
      v_res := tab.leak_entry(v_kind, v_cfg, v_prior, c, v_now, v_by);
    elsif coalesce(v_cfg ->> 'part', 'LINE_CHECK') = 'RUN' then
      v_res := tab.blister_run_entry(v_kind, v_cfg, v_prior, c, v_by);
    else
      v_res := tab.blister_check_entry(v_kind, v_cfg, v_prior, c, v_by);
    end if;
    if v_res ? 'problem' then
      return format('stores %s, which its block refuses: %s', v_what, v_res ->> 'problem');
    end if;
    -- G-06's values at a run (their data are recipe-core 0520's, their exceptions tablets 0913's).
    if v_res ? 'g06' then
      continue;
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
    if (v_res -> 'verify') = 'true'::jsonb and (p_new -> 'steps' -> v_key -> 'verificationRequired') is distinct from 'true'::jsonb then
      return format('stores %s, which needs a second person''s check of its step, and the step does not require it (IN-38, PR-14)', v_what);
    end if;
    -- What the register and the plant hold (header).
    v_problem := null;
    if v_kind = 'LINE_SETUP' then
      v_machine := d ->> 'machine';
      v_problem := coalesce(tab.forming_unit_problem(p_batch, v_machine, v_code), tab.blister_line_problem(p_batch, v_machine, d ->> 'artworkSet'),
                            tab.blister_isolation_problem(p_batch, v_cfg, v_machine));
      if v_problem is null then
        for v_reel in select x from jsonb_array_elements(case when jsonb_typeof(d -> 'reels') = 'array' then d -> 'reels' else '[]'::jsonb end) x loop
          v_problem := tab.blister_lot_problem(p_batch, p_content, p_old, v_cfg, v_reel, v_now);
          exit when v_problem is not null;
        end loop;
      end if;
    elsif v_kind = 'REEL_CHANGE' then
      v_problem := tab.blister_lot_problem(p_batch, p_content, p_old, v_cfg, d - 'changedBy', v_now);
    elsif v_kind = 'RUN_START' then
      v_machine := d ->> 'machine';
      v_problem := coalesce(tab.forming_unit_problem(p_batch, v_machine, v_code), tab.blister_line_problem(p_batch, v_machine, null),
                            tab.blister_line_check_problem(p_content, p_old, v_machine, v_code || '-NO-LINE-CHECK'));
      if v_problem is null and v_type = 'TB-21' then
        v_problem := tab.blister_isolation_problem(p_batch, v_cfg, v_machine);
      end if;
    end if;
    if v_problem is not null then
      return format('stores %s, but %s', v_what, v_problem);
    end if;
  end loop;
  return null;
end
$$;

-- IN-38, PR-29, PR-37: why a blister step that row p_new closes is not complete (header item 2); NULL when every one is.
create function tab.blister_close_problem(p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql immutable set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  k      text;
  s      jsonb;
  v_node jsonb;
  v_type text;
  v_cfg  jsonb;
  v_all  jsonb;
  v_end  numeric;
  v_last jsonb;
  v_text text;
begin
  for k, s in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'steps') = 'object' then p_new -> 'steps' else '{}'::jsonb end) x
               where x.value ->> 'status' in ('AWAITING_VERIFICATION', 'COMPLETED') and p_old -> 'steps' -> x.key ->> 'status' = 'IN_PROGRESS' order by x.key loop
    v_node := recipe.step_node(p_content, s ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    if v_type is null or v_type not in ('TB-21', 'TB-22') then
      continue;
    end if;
    v_cfg := case when jsonb_typeof(v_node -> 'config') = 'object' then v_node -> 'config' else '{}'::jsonb end;
    v_all := tab.gran_prior(p_new, k, 'Infinity'::numeric, null);
    select recipe.micros_of(x -> 'recordedAt') into v_end from jsonb_array_elements(v_all) with ordinality y (x, i) where x ->> 'kind' = 'RUN_END' order by i limit 1;
    if v_type = 'TB-22' then
      v_text := case
        when v_end is null then 'its run has not ended (TB22-RUNNING)'
        when exists (select 1 from jsonb_array_elements(tab.leak_tracks(v_cfg)) t
                      where not exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'LEAK_TEST' and tab.ipc_d(x) -> 'track' = t
                                                                                    and recipe.micros_of(x -> 'recordedAt') >= v_end))
          then 'a track has no end-of-run leak test (TB22-END-TEST)'
      end;
    elsif coalesce(v_cfg ->> 'part', 'LINE_CHECK') = 'RUN' then
      select x into v_last from jsonb_array_elements(v_all) with ordinality y (x, i) where x ->> 'kind' = 'DEFECT_CHECK' order by i desc limit 1;
      v_text := case
        when v_end is null then 'its run has not ended (TB21-RUNNING)'
        when not exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'COUNT') then 'it has no count (TB21-NO-COUNT)'
        when v_last is null then 'it has no defect check (TB21-NO-CHECK)'
        when tab.ipc_d(v_last) ->> 'result' is distinct from 'PASS' then 'its last defect check failed (TB21-LAST-CHECK)'
      end;
    else
      select x into v_last from jsonb_array_elements(v_all) with ordinality y (x, i) where x ->> 'kind' = 'EQUIPMENT_CHECK' order by i desc limit 1;
      v_text := case
        when not exists (select 1 from jsonb_array_elements(v_all) x where x ->> 'kind' = 'LINE_SETUP') then 'it has no line set-up (TB21-NO-SETUP)'
        when tab.ipc_d(v_last) ->> 'result' is distinct from 'PASS' then 'it has no passing independent equipment check (TB21-CHECK)'
      end;
    end if;
    if v_text is not null then
      return format('closes step %s, but %s', k, v_text);
    end if;
  end loop;
  return null;
end
$$;

-- The container holds of the new entries of row p_new (header).
create function tab.blister_apply_holds(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  e0        jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  k         text;
  e         jsonb;
  d         jsonb;
  v_key     text;
  v_node    jsonb;
  v_type    text;
  v_machine text;
  v_stream  text;
begin
  for k, e in select x.key, x.value from jsonb_each(case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end) x
               where not (e0 ? x.key) order by (x.value ->> 'recordedSeq')::numeric, x.key loop
    v_key := e ->> 'stepKey';
    v_node := recipe.step_node(p_content, p_new -> 'steps' -> v_key ->> 'step');
    v_type := v_node -> 'block' ->> 'type';
    if v_type is null or v_type not in ('TB-21', 'TB-22') or (v_type = 'TB-21' and v_node -> 'config' ->> 'part' is distinct from 'RUN') then
      continue;
    end if;
    v_machine := tab.blister_machine(p_new, v_key);
    if v_machine is null then
      continue;
    end if;
    d := tab.ipc_d(e);
    if v_type = 'TB-21' then
      if e ->> 'kind' = 'ACTUAL' and (d -> 'withinLimits') = 'false'::jsonb then
        perform tab.blister_hold(p_batch, v_machine, 'LINE', 'FAIL', format('TB21:%s:%s', v_key, k), true);
      elsif e ->> 'kind' = 'DEFECT_CHECK' then
        perform tab.blister_hold(p_batch, v_machine, 'LINE', case when d ->> 'result' = 'PASS' then 'PASS' else 'FAIL' end, format('TB21:%s:%s', v_key, k), true);
      end if;
      continue;
    end if;
    for v_stream in select m.v ->> 'stream' from jsonb_array_elements(case when jsonb_typeof(d -> 'missed') = 'array' then d -> 'missed' else '[]'::jsonb end) with ordinality m (v, i)
                     group by m.v ->> 'stream' order by min(m.i) loop
      perform tab.blister_hold(p_batch, v_machine, v_stream, 'MISSED', format('TB22:%s:%s:MISSED', v_key, k), true);
    end loop;
    if e ->> 'kind' = 'LEAK_TEST' then
      perform tab.blister_hold(p_batch, v_machine, d ->> 'track', case when d ->> 'result' = 'PASS' then 'PASS' else 'FAIL' end, format('TB22:%s:%s', v_key, k), true);
    end if;
  end loop;
end
$$;

-- The row trigger (header).
create function tab.blister_state_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  r         recipe.execution_command;
  v_content jsonb;
  v_problem text;
  v_code    text;
begin
  v_content := recipe.batch_mbr_content(new.batch_id);
  if not exists (select 1 from jsonb_path_query(coalesce(v_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "phase")') p
                  where p -> 'block' ->> 'type' in ('TB-21', 'TB-22')) then
    return null;
  end if;
  select * into r from recipe.execution_command c where c.batch_id = new.batch_id and c.seq = new.last_seq;
  v_problem := tab.blister_entry_problem(new.batch_id, v_content, old.state, new.state, r);
  v_code := 'EBMR-TAB-370';
  if v_problem is null then
    v_problem := tab.blister_close_problem(v_content, old.state, new.state);
    v_code := 'EBMR-TAB-371';
  end if;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This %s %s row %s: a blister line set-up, run or leak test records what its block builds, on its cleared line and released reels, and closes only complete (IN-38, PR-29, PR-33, PR-34, PR-35, PR-37). [%s]',
                       case when r.kind = 'COMMAND' and r.accepted then 'accepted' when r.kind = 'COMMAND' then 'refused' else lower(coalesce(r.kind, 'unknown')) end,
                       coalesce(r.command_type, r.kind, 'unknown'), v_problem, v_code);
  end if;
  perform tab.blister_apply_holds(new.batch_id, v_content, old.state, new.state);
  return null;
end
$$;

create trigger zzh_tab_blister after update on recipe.execution_state
  for each row execute function tab.blister_state_check();

-- ---------------------------------------------------------------------------------------------
-- Replaced from tablets 0932 (header)

-- The PASS references whose own trigger on plant.ipc_check holds them (lead, slice 4b): a reference starting
-- '<prefix>:' for a unit that a step of one of block_types names as its `unit` in the batch's MBR is left to that
-- trigger here. A unit no such step names gets no exemption, so a forged reference with a delegated prefix is still
-- refused. Insert-only; configuration shipped by migrations.
create table tab.ipc_pass_delegate (
  prefix       text primary key check (prefix ~ '^[A-Z][A-Z0-9]{1,15}$'),
  block_types  text[] not null check (cardinality(block_types) > 0),
  guarded_by   text not null check (btrim(guarded_by) <> '')
);
revoke all on tab.ipc_pass_delegate from public;
create trigger aa_ipc_pass_delegate_insert_only before update or delete on tab.ipc_pass_delegate for each row execute function kernel.reject_mutation();
create trigger aa_ipc_pass_delegate_no_truncate before truncate on tab.ipc_pass_delegate for each statement execute function kernel.reject_mutation();
insert into tab.ipc_pass_delegate (prefix, block_types, guarded_by) values
  ('TB23', '{TB-23}', 'tab.packline_pass_check, trigger aa_tab_packline_pass (tablets 0987)'),
  ('TB24', '{TB-24}', 'tab.packline_pass_check, trigger aa_tab_packline_pass (tablets 0987)');

-- PR-37, IN-22: whether PASS check p_check is the record of a passing G-21 entry (recipe-core 0581 recipe.g21_record:
-- an approved FIRST_PRINT or a passing CHALLENGE, reference G21:<step>:<entry>:<device>) of a G-21 step of its batch
-- whose `unit` is the check's unit, on no stream, once. G-21 records its checks from its own guard; nothing else holds
-- the reference, so it is read here.
create function tab.g21_pass_ok(p_check plant.ipc_check, p_content jsonb, p_state jsonb) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  v_m  text[] := regexp_match(p_check.reference, '^G21:(.+):(EN-[1-9][0-9]{0,8}):(.*)$');
  e    jsonb;
  v_n  jsonb;
begin
  if v_m is null then
    return false;
  end if;
  e := p_state -> 'entries' -> v_m[2];
  v_n := recipe.step_node(p_content, p_state -> 'steps' -> v_m[1] ->> 'step');
  return e is not null and e ->> 'stepKey' = v_m[1] and v_n -> 'block' ->> 'type' = 'G-21'
         and recipe.g21_cfg(v_n) ->> 'unit' is not distinct from p_check.press_code and p_check.stream is null
         and e -> 'data' ->> 'device' is not distinct from v_m[3]
         and ((e ->> 'kind' = 'FIRST_PRINT' and (e -> 'data' -> 'approved') = 'true'::jsonb) or (e ->> 'kind' = 'CHALLENGE' and e -> 'data' ->> 'result' = 'PASS'))
         and not exists (select 1 from plant.ipc_check k where k.batch_id = p_check.batch_id and k.reference = p_check.reference);
end
$$;

-- As 0932, with the passing entries of TB-21 and TB-22 steps beside those of TB-11, TB-06 and TB-16, a passing G-21 entry
-- (tab.g21_pass_ok), and the references of tab.ipc_pass_delegate left to their own trigger.
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
                             where p -> 'block' ->> 'type' = any (g.block_types) and p -> 'config' ->> 'unit' = new.press_code)) then
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

-- As 0932, with the running TB-22 steps (every track, as tab.leak_overdue) beside the others.
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
    end;
    if v_items is null then
      continue;
    end if;
    v_out := v_out || coalesce((select jsonb_agg(jsonb_build_object('stepKey', k) || m order by i) from jsonb_array_elements(v_items) with ordinality y (m, i)), '[]'::jsonb);
  end loop;
  return v_out;
end
$$;

-- As 0932, with the machine of a TB-22 run (tab.blister_machine) and the hold of the track's own series (tab.blister_hold).
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
        v_press := tab.forming_press(v_state, m ->> 'stepKey');
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

revoke all on function tab.blister_machine(jsonb, text), tab.blister_line_problem(uuid, text, text), tab.blister_isolation_problem(uuid, jsonb, text),
  tab.blister_lot_problem(uuid, jsonb, jsonb, jsonb, jsonb, numeric), tab.blister_line_check_problem(jsonb, jsonb, text, text),
  tab.blister_hold(uuid, text, text, text, text, boolean), tab.blister_entry_problem(uuid, jsonb, jsonb, jsonb, recipe.execution_command),
  tab.blister_close_problem(jsonb, jsonb, jsonb), tab.blister_apply_holds(uuid, jsonb, jsonb, jsonb), tab.blister_state_check(),
  tab.g21_pass_ok(plant.ipc_check, jsonb, jsonb) from public;

reset role;
