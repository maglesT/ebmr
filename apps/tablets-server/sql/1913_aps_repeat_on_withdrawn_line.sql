-- ST-29, ST-33 (lead ruling, 13 November 2026): the repeat media fills run on the line whose qualification was withdrawn
-- for them. Until now the library fitness guard refused a NOT_QUALIFIED unit in every batch, so a line withdrawn after a
-- failed APS (tablets 1911, 1912) or for an APS a change requires (tablets 1910) could never run the APS that brings it
-- back. EU GMP Annex 1 9.46 and 9.38, paraphrased: the repeat simulations are run on the line before it returns to routine
-- use; revised Schedule M Part II 5.5 likewise asks for the simulation after a significant change.
--
-- Handbook: modules/tablets-server.md
--
--   plant.aps_repeat_use(unit, batch)
--                             true only when both hold: the batch is a process simulation (recipe.process_simulation_batch,
--                             recipe-core 1896), and the unit's sole fitness problem is a withdrawal pending an APS: it
--                             is NOT_QUALIFIED (so not retired, out of service, failed or in maintenance; plant 0403), its
--                             latest qualification event is an ST-33 withdrawal (plant.aps_failure_withdrawal, 1912) or an
--                             ST-29 one (the change record named the unit, plant.aps_required_line, and the event is that
--                             change's withdrawal, 1910), and, when the class requires calibration, its latest calibration
--                             passed and is not overdue. Any other withdrawal, a calibration overdue or out of tolerance,
--                             or a product batch: false.
--   tab.library_smart_problem CREATE OR REPLACE of 1806, otherwise unchanged: an EQUIPMENT field's unit is refused unless its
--                             fitness is QUALIFIED or CALIBRATION_DUE_SOON or plant.aps_repeat_use holds for the batch.
--                             The entry's server-filled facts stay {code, classCode, fitness} and are compared as before
--                             (plant.equipment_fitness is unchanged, so the unit reads NOT_QUALIFIED everywhere else and in
--                             the facts); the exemption is decided here only. The engine lets NOT_QUALIFIED through in a
--                             process-simulation master only (library/block-version equipmentUsable), and this guard
--                             refuses the entry when the withdrawal or the unit's state does not qualify (EBMR-TAB-480).

set local role ebmr_owner;

create function plant.aps_repeat_use(p_equipment uuid, p_batch uuid) returns boolean
language plpgsql stable security definer set search_path = pg_catalog, plant, recipe, platform, pg_temp as $$
declare
  v_last plant.equipment_event;
  v_req  boolean;
  v_cal  plant.calibration;
begin
  if p_equipment is null or p_batch is null or not recipe.process_simulation_batch(p_batch) then
    return false;
  end if;
  if plant.equipment_fitness(p_equipment) is distinct from 'NOT_QUALIFIED' then
    return false;
  end if;
  select * into v_last from plant.equipment_event q
   where q.equipment_id = p_equipment and q.kind in ('QUALIFIED', 'QUALIFICATION_WITHDRAWN')
   order by q.recorded_at desc, q.id desc limit 1;
  if v_last.kind is distinct from 'QUALIFICATION_WITHDRAWN' then
    return false;
  end if;
  if not exists (select 1 from plant.aps_failure_withdrawal w where w.event_id = v_last.id)
     and not exists (select 1 from plant.aps_required_line a join platform.change_record c on c.id = a.change_record_id
                      where a.equipment_id = p_equipment and c.number = v_last.reference
                        and v_last.detail = format('APS required by change %s', c.number)) then
    return false;
  end if;
  select k.calibration_required into v_req from plant.equipment e join plant.equipment_class k on k.code = e.class_code where e.id = p_equipment;
  if v_req then
    v_cal := plant.latest_calibration(p_equipment);
    if v_cal.id is null or v_cal.as_left = 'FAIL' or v_cal.due_at <= clock_timestamp() then
      return false;
    end if;
  end if;
  return true;
end
$$;

-- As 1806, with the repeat-APS use of a withdrawn unit.
create or replace function tab.library_smart_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, plant, pg_temp as $$
declare
  e0      jsonb := case when jsonb_typeof(p_old -> 'entries') = 'object' then p_old -> 'entries' else '{}'::jsonb end;
  e1      jsonb := case when jsonb_typeof(p_new -> 'entries') = 'object' then p_new -> 'entries' else '{}'::jsonb end;
  v_now   numeric := recipe.micros_of(p_new -> 'lastRecordedUs');
  k       text;
  e       jsonb;
  v_step  text;
  v_node  jsonb;
  d       jsonb;
  s       jsonb;
  f       jsonb;
  v_code  text;
  v_facts jsonb;
  v_lot   jsonb;
  v_prob  text;
  q       plant.equipment;
  v_fit   text;
  v_class text;
  v_line  jsonb;
begin
  for k, e in select x.key, x.value from jsonb_each(e1) x where not (e0 ? x.key) order by x.key loop
    v_step := p_new -> 'steps' -> (e ->> 'stepKey') ->> 'step';
    v_node := recipe.step_node(p_content, v_step);
    if coalesce(v_node -> 'block' ->> 'type', '') not like 'LIB-%' then
      continue;
    end if;
    d := recipe.library_definition(p_content, v_node -> 'block');
    select x into s from jsonb_array_elements(coalesce(d -> 'sections', '[]'::jsonb)) x where x ->> 'id' = e ->> 'kind' limit 1;
    if s is null then
      continue;
    end if;
    for f in select x from jsonb_array_elements(s -> 'fields') x loop
      v_code := e -> 'data' ->> (f ->> 'id');
      if v_code is null then
        continue;
      end if;
      if f ->> 'type' = 'MATERIAL_LOT' then
        -- R3-ENG-3: a lot field that reads a formulation line needs that line in the master's BOM; a line that is not
        -- there (a typo, a line since removed) is a refusal, never a lot of any material accepted unchecked.
        if f ? 'bomLineSlot' then
          v_line := v_node -> 'config' -> 'bomLines' -> (f ->> 'bomLineSlot');
          if not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_content -> 'bom') = 'array' then p_content -> 'bom' else '[]'::jsonb end) b
                          where b -> 'id' = v_line) then
            return format('stores entry %s naming lot %s for the formulation line %s, which is not a line of the master''s bill of materials (LIB-LOT-BOM-LINE)',
                          k, v_code, coalesce(v_line #>> '{}', '(none)'));
          end if;
        end if;
        v_facts := tab.lot_facts(v_code, p_batch);
        if v_facts is null then
          return format('stores entry %s naming lot %s, which the lot register does not hold', k, v_code);
        end if;
        v_lot := jsonb_strip_nulls(jsonb_build_object('id', v_facts -> 'lotCode', 'material', v_facts -> 'materialCode', 'status', v_facts -> 'status',
                                                      'expiresAtUs', v_facts -> 'expiresAtUs', 'retestAtUs', v_facts -> 'retestAtUs',
                                                      'identityTested', v_facts -> 'identityTested'));
        if (e -> 'data' -> 'lots' -> (f ->> 'id')) is distinct from v_lot then
          return format('stores entry %s with facts of lot %s other than the lot register holds', k, v_code);
        end if;
        v_prob := recipe.lot_usability_problem(p_content, case when f ? 'bomLineSlot' then v_node -> 'config' -> 'bomLines' -> (f ->> 'bomLineSlot') end,
                                               v_lot, v_now, p_new -> 'header' -> 'marketSet');
        if v_prob is not null then
          return format('stores entry %s with %s', k, v_prob);
        end if;
      elsif f ->> 'type' = 'EQUIPMENT' then
        select * into q from plant.equipment x where x.code = v_code;
        if q.id is null then
          return format('stores entry %s naming equipment %s, which the plant register does not hold', k, v_code);
        end if;
        v_fit := plant.equipment_fitness(q.id);
        v_class := v_node -> 'config' -> 'equipmentClasses' ->> (f ->> 'classSlot');
        if (e -> 'data' -> 'equipment' -> (f ->> 'id')) is distinct from jsonb_build_object('code', q.code, 'classCode', q.class_code, 'fitness', v_fit) then
          return format('stores entry %s with facts of equipment %s other than the plant register holds', k, v_code);
        end if;
        if v_class is not null and q.class_code is distinct from v_class then
          return format('stores entry %s naming %s of class %s, where the formulation requires %s', k, v_code, q.class_code, v_class);
        end if;
        -- 1913: a process simulation runs its repeat APS on a unit withdrawn only for that APS (ST-29, ST-33).
        if v_fit not in ('QUALIFIED', 'CALIBRATION_DUE_SOON') and not plant.aps_repeat_use(q.id, p_batch) then
          return format('stores entry %s naming %s, which is %s', k, v_code, lower(replace(v_fit, '_', ' ')));
        end if;
      elsif f ->> 'type' = 'WEIGHING' then
        if (p_new -> 'steps' -> (e ->> 'stepKey') -> 'verificationRequired') is distinct from 'true'::jsonb then
          return format('stores the hand-keyed weighing %s at step %s without two-person verification', k, v_step);
        end if;
      end if;
    end loop;
  end loop;
  return null;
end
$$;

revoke all on function plant.aps_repeat_use(uuid, uuid) from public;

reset role;
