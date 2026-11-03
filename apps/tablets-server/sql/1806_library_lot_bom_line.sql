-- Tablets, release review finding R3-ENG-3: a library lot field whose formulation line is not in the BOM is refused.
--
-- Handbook: modules/tablets-server.md
--
-- What was wrong. tab.library_smart_problem (1803) passed the formulation's line of a MATERIAL_LOT field to
-- recipe.lot_usability_problem, which compares the lot's material only when it finds that line in the master's bill of
-- materials. A line that is not there (a typo, or a line since removed) found nothing, so a released lot of any material
-- was stored with no exception (PR-18, IN-23; INV-25).
--
-- What changed: tab.library_smart_problem (CREATE OR REPLACE, the body of 1803 otherwise unchanged) refuses an entry
-- whose MATERIAL_LOT field names a formulation line slot (bomLineSlot) when the step's config does not name a line of
-- the master's BOM for that slot (LIB-LOT-BOM-LINE). A field without a slot is unchanged. The trigger
-- zzh_tab_library_smart_fields (EBMR-TAB-480) and its grants stay as they are. recipe.lot_usability_problem, which the
-- route-master blocks (G-07, TB-01) use, is unchanged: their lines are tied to the step's consumes (recipe-core 0328)
-- and the master validator.

set local role ebmr_owner;

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

reset role;
