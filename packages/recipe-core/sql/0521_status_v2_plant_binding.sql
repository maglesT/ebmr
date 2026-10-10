-- Recipe core, Phase 3 slice 3a: the equipment and area status of G-09@2 and G-10@2 come from the plant schema of slice
-- 1, never from a person's word (INV-12, INV-15, IN-21, IN-25, PR-23, PR-34, DI-05; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
-- G-09@2 records the unit a step uses (EQUIPMENT_USE {equipmentRef, equipmentCode, useId}) and G-10@2 the room or line
-- the batch occupies (AREA_OCCUPANCY {areaCode, occupancyId}). The status checks themselves are the plant's: a use
-- starts only on a fit, clean, calibrated unit inside its campaign (plant.start_equipment_use, 0403: INV-12, IN-25,
-- PR-23), an occupancy only on a passed clearance verified by a second person (plant.record_clearance,
-- verify_clearance, start_area_occupancy, 0404: IN-21, PR-34, INV-15). This migration binds the entry to them: a row
-- trigger on recipe.execution_command (ad_plant_status_entry, before insert) refuses a person's accepted RECORD_ENTRY
-- of kind EQUIPMENT_USE unless its useId names an open use (no use end) of this batch, of the unit equipmentCode,
-- started by the row's person, of the plant class the MBR binds for equipmentRef in the step's stage, and one no other
-- entry of the batch names; and one of kind AREA_OCCUPANCY unless its
-- occupancyId names an open occupancy of this batch, of the room or line areaCode, started by the row's person, whose
-- clearance passed, and one no other entry of the batch names. EBMR-EXE-210.
--
-- A refused row adds no entry and is not read here. The trigger function is SECURITY DEFINER, owned by ebmr_owner, with
-- pg_temp last (ADR 0016); nobody executes it directly. Applied as a new migration because applied migrations are
-- checksummed and never edited.

set local role ebmr_owner;

-- INV-12, INV-15, IN-21, IN-25, PR-23, PR-34: why entry p_entry of an accepted RECORD_ENTRY at step p_step of batch
-- p_batch by person p_person does not stand on the open plant use or occupancy it names (header); NULL when it does or is of another kind.
create function recipe.plant_status_entry_problem(p_batch uuid, p_person uuid, p_step text, p_entry jsonb) returns text
language plpgsql stable security definer set search_path = pg_catalog, recipe, plant, pg_temp as $$
declare
  v_entry   jsonb := case when jsonb_typeof(p_entry) = 'object' then p_entry end;
  v_kind    text := v_entry ->> 'kind';
  v_uuid    constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  u         plant.equipment_use_status;
  o         plant.area_occupancy_status;
  v_code    text;
  v_result  text;
  v_member  text;
  v_content jsonb;
  v_class   jsonb;
  v_ref     text;
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
    select e.code into v_code from plant.equipment e where e.id = u.equipment_id;
    v_member := case
      when u.id is null then format('use %s does not exist in site services', v_entry ->> 'useId')
      when u.batch_id is distinct from p_batch then format('use %s is of batch %s, not of this batch', u.id, u.batch_ref)
      when v_code is distinct from v_entry ->> 'equipmentCode' then format('use %s is of unit %s, not of %s', u.id, v_code, coalesce(v_entry ->> 'equipmentCode', '(none)'))
      when u.ended_at is not null then format('use %s of %s has ended', u.id, v_code)
      when u.started_by is distinct from p_person then format('use %s was started by another person', u.id)
    end;
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
    if v_ref is distinct from (select e.class_code from plant.equipment e where e.id = u.equipment_id) then
      return format('unit %s is of class %s, not of class %s that the MBR binds for %s', v_code,
                    (select e.class_code from plant.equipment e where e.id = u.equipment_id), coalesce(v_ref, '(none)'), v_entry ->> 'equipmentRef');
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

-- The row trigger (header). EBMR-EXE-210.
create function recipe.plant_status_entry_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, recipe, pg_temp as $$
declare
  v_kind    text := case when jsonb_typeof(new.command -> 'entry') = 'object' then new.command -> 'entry' ->> 'kind' end;
  v_problem text;
begin
  if new.kind <> 'COMMAND' or new.accepted is not true or new.command_type <> 'RECORD_ENTRY' or v_kind is null
     or v_kind not in ('EQUIPMENT_USE', 'AREA_OCCUPANCY') then
    return new;
  end if;
  v_problem := recipe.plant_status_entry_problem(new.batch_id, new.actor_person, new.command ->> 'step', new.command -> 'entry');
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('A %s entry stands on the open %s of this batch that site services started for the person recording it: %s (INV-12, INV-15, IN-21, IN-25, PR-23, PR-34). [EBMR-EXE-210]',
                       v_kind, case v_kind when 'EQUIPMENT_USE' then 'equipment use' else 'room or line occupancy' end, v_problem);
  end if;
  return new;
end
$$;

create trigger ad_plant_status_entry before insert on recipe.execution_command
  for each row execute function recipe.plant_status_entry_check();

revoke all on function recipe.plant_status_entry_problem(uuid, uuid, text, jsonb), recipe.plant_status_entry_check() from public;

reset role;
