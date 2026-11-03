-- Tablets, decision 0026 slice S6: the smart fields of library blocks (recipe-core library, sql 1810).
--
-- Handbook: modules/tablets-server.md
--
--   tab.library_smart_problem(batch, content, old, new)  every library entry a row adds:
--     * a MATERIAL_LOT field names a lot of this installation's lot register (tab.lot_facts at the batch's site), and the
--       entry's server-filled `lots` facts are the register's (no forged facts: EBMR-EXE-078's rule for G-07); the lot
--       is usable now for the formulation line it names (recipe.lot_usability_problem: material, released, expiry,
--       retest, identity for export markets; PR-18, IN-23, IN-24);
--     * an EQUIPMENT field names a unit of the plant register of the class the formulation requires, fit for use
--       (plant.equipment_fitness QUALIFIED or CALIBRATION_DUE_SOON; PR-19, IN-11), with the entry's `equipment` facts
--       as the register has them;
--     * a WEIGHING field (keyed by hand) leaves the step needing two-person verification (DI-30, PR-14).
--   Trigger zzh_tab_library_smart_fields on recipe.execution_state, EBMR-TAB-480.

set local role ebmr_owner;

create function tab.library_smart_problem(p_batch uuid, p_content jsonb, p_old jsonb, p_new jsonb) returns text
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
        if v_fit not in ('QUALIFIED', 'CALIBRATION_DUE_SOON') then
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

create function tab.library_smart_fields_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_problem text;
begin
  if not exists (select 1
                   from jsonb_object_keys(case when jsonb_typeof(new.state -> 'entries') = 'object' then new.state -> 'entries' else '{}'::jsonb end) k
                  where not coalesce((old.state -> 'entries') ? k, false)) then
    return null;
  end if;
  v_problem := tab.library_smart_problem(new.batch_id, recipe.batch_mbr_content(new.batch_id), old.state, new.state);
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('This row %s: a library entry''s lots and equipment are the registers'' and usable, and a hand-keyed weighing is verified by a second person (PR-18, PR-19, IN-23, DI-30, PR-14; decision 0026). [EBMR-TAB-480]', v_problem);
  end if;
  return null;
end
$$;

create trigger zzh_tab_library_smart_fields after update on recipe.execution_state for each row execute function tab.library_smart_fields_check();

revoke all on function tab.library_smart_problem(uuid, jsonb, jsonb, jsonb), tab.library_smart_fields_check() from public;

reset role;
