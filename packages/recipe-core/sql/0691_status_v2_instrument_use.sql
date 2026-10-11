-- Recipe core, Phase 3 slice 6d (GB-T-01): G-09@2 checks the status of an instrument as well as of a process unit. The
-- validator asks every stage to check the status of each unit it binds before a step uses it (GMP-EQUIPMENT-STATUS,
-- PR-03), balances included; but an instrument has no equipment use in site services (plant.start_equipment_use refuses
-- one: EBMR-PLANT-062): its status is its calibration and its per-use or daily check, and its use for a batch is the
-- instrument use recorded on them (plant.record_instrument_check and record_instrument_use, 0403: IN-25 (b), PR-23).
-- So no GMP master that binds a balance could both pass the validator and run: G-09@2's EQUIPMENT_USE entry for a
-- balance named no use the trigger of 0521 accepts.
--
-- recipe.plant_status_entry_problem (0521) is replaced from its latest definition with one change: an EQUIPMENT_USE
-- entry stands on an equipment use as before, or, when its useId names no equipment use, on an instrument use of this
-- batch, of the unit equipmentCode, recorded by the row's person, open at the row's time (its planned end after it; the
-- same open use the weighing guards read, tablets 0843), of the class the MBR binds for equipmentRef. Everything else is
-- unchanged. EBMR-EXE-210 (the trigger of 0521 calls this function).

set local role ebmr_owner;

create or replace function recipe.plant_status_entry_problem(p_batch uuid, p_person uuid, p_step text, p_entry jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  v_entry   jsonb := case when jsonb_typeof(p_entry) = 'object' then p_entry end;
  v_kind    text := v_entry ->> 'kind';
  v_uuid    constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  u         plant.equipment_use_status;
  i         plant.instrument_use;
  o         plant.area_occupancy_status;
  v_code    text;
  v_result  text;
  v_member  text;
  v_content jsonb;
  v_class   jsonb;
  v_ref     text;
  v_unit    uuid;
begin
  if v_kind is null or v_kind not in ('EQUIPMENT_USE', 'AREA_OCCUPANCY') then
    return null;
  end if;
  v_member := case v_kind when 'EQUIPMENT_USE' then 'useId' else 'occupancyId' end;
  if (v_entry ->> v_member) is null or (v_entry ->> v_member) !~ v_uuid then
    return format('it names no %s', v_member);
  end if;
  if exists (select 1 from recipe.execution_command c
              where c.batch_id = p_batch and c.kind = 'COMMAND' and c.accepted and c.command_type = 'RECORD_ENTRY'
                and c.command -> 'entry' ->> 'kind' = v_kind and c.command -> 'entry' ->> v_member = v_entry ->> v_member) then
    return format('%s %s already backs another entry of the batch', v_member, v_entry ->> v_member);
  end if;
  if v_kind = 'EQUIPMENT_USE' then
    select * into u from plant.equipment_use_status where id = (v_entry ->> 'useId')::uuid;
    if u.id is not null then
      v_unit := u.equipment_id;
      select e.code into v_code from plant.equipment e where e.id = u.equipment_id;
      v_member := case
        when u.batch_id is distinct from p_batch then format('use %s is of batch %s, not of this batch', u.id, u.batch_ref)
        when v_code is distinct from v_entry ->> 'equipmentCode' then format('use %s is of unit %s, not of %s', u.id, v_code, coalesce(v_entry ->> 'equipmentCode', '(none)'))
        when u.ended_at is not null then format('use %s of %s has ended', u.id, v_code)
        when u.started_by is distinct from p_person then format('use %s was started by another person', u.id)
      end;
    else
      -- An instrument's use (this migration): its calibration and check passed when it was recorded (0403).
      select * into i from plant.instrument_use where id = (v_entry ->> 'useId')::uuid;
      v_unit := i.equipment_id;
      select e.code into v_code from plant.equipment e where e.id = i.equipment_id;
      v_member := case
        when i.id is null then format('use %s does not exist in site services', v_entry ->> 'useId')
        when i.batch_id is distinct from p_batch then format('use %s is of batch %s, not of this batch', i.id, i.batch_ref)
        when v_code is distinct from v_entry ->> 'equipmentCode' then format('use %s is of unit %s, not of %s', i.id, v_code, coalesce(v_entry ->> 'equipmentCode', '(none)'))
        when i.planned_end <= clock_timestamp() then format('use %s of %s has ended (its planned end has passed)', i.id, v_code)
        when i.person_id is distinct from p_person then format('use %s was recorded by another person', i.id)
      end;
    end if;
    if v_member is not null then
      return v_member;
    end if;
    -- The unit is of the class the MBR binds for equipmentRef in the step's stage (the reference's code is the plant
    -- class code), so a balance's use is never recorded as the press's.
    v_content := recipe.batch_mbr_content(p_batch);
    select e into v_class
      from jsonb_path_query(coalesce(v_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "stage")') st,
           jsonb_array_elements(case when jsonb_typeof(st -> 'binding' -> 'equipment') = 'array' then st -> 'binding' -> 'equipment' else '[]'::jsonb end) e
     where jsonb_path_exists(st, 'strict $.** ? (@.id == $id)', jsonb_build_object('id', p_step)) and e ->> 'ref' = v_entry ->> 'equipmentRef'
     limit 1;
    select r ->> 'code' into v_ref from jsonb_array_elements(case when jsonb_typeof(v_content -> 'references') = 'array' then v_content -> 'references' else '[]'::jsonb end) r
     where r ->> 'id' = v_class ->> 'equipmentClass' limit 1;
    if v_class is null then
      return format('%s is not equipment the stage of step %s binds', coalesce(v_entry ->> 'equipmentRef', '(none)'), coalesce(p_step, '(none)'));
    end if;
    if v_ref is distinct from (select e.class_code from plant.equipment e where e.id = v_unit) then
      return format('unit %s is of class %s, not of class %s that the MBR binds for %s', v_code,
                    (select e.class_code from plant.equipment e where e.id = v_unit), coalesce(v_ref, '(none)'), v_entry ->> 'equipmentRef');
    end if;
    return null;
  end if;
  select * into o from plant.area_occupancy_status where id = (v_entry ->> 'occupancyId')::uuid;
  select a.code into v_code from plant.area a where a.id = o.area_id;
  select c.result into v_result from plant.clearance_status c where c.id = o.clearance_id;
  return case
    when o.id is null then format('occupancy %s does not exist in site services', v_entry ->> 'occupancyId')
    when o.batch_id is distinct from p_batch then format('occupancy %s is of batch %s, not of this batch', o.id, o.batch_ref)
    when v_code is distinct from v_entry ->> 'areaCode' then format('occupancy %s is of %s, not of %s', o.id, v_code, coalesce(v_entry ->> 'areaCode', '(none)'))
    when o.ended_at is not null then format('occupancy %s of %s has ended', o.id, v_code)
    when o.started_by is distinct from p_person then format('occupancy %s was started by another person', o.id)
    when v_result is distinct from 'PASSED' then format('the clearance of occupancy %s is %s, not a passed and verified clearance', o.id, coalesce(v_result, 'unverified'))
  end;
end
$$;

reset role;
