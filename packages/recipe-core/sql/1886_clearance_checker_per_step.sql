-- Recipe core, injectables I-1c2 P3b (lead ruling A5, 9 November 2026): a line clearance needs a second person only
-- where the master's clearance step names a checker.
-- Handbook: modules/recipe-core.md
--
-- 211.130(e) and EU GMP 5.50 ask for the packaging and labelling facilities to be inspected before use, with the
-- inspection documented in the batch record; they do not name a second person. Revised Schedule M Part VIII 7.1 does, for
-- tablets and capsules packaging, and the G-10@2 block still requires a checker there (validator G10-NO-CHECKER). PR-34
-- makes the verifier configurable (default on). Until now site services occupied a room or line only on a clearance
-- verified by a second person, whatever the step said, so a master whose clearance step has no checker could not run.
-- The rule is now keyed on the step:
--
--   * recipe.clearance_checked (new): whether the G-10 step of a stage (or the named G-10 step) in a master names a
--     checker; true where no G-10 step is found, so an unknown stage keeps the verified rule (fails closed);
--   * plant.guard_clearance_recorded_passed (new guard plant.clearance_recorded_passed): an unused PASSED clearance of
--     the area recorded after its last occupancy, verified or not; the guard of CLEAR_UNCHECKED in area_status version 2
--     (1887, generated from plant/machine.ts; the guard is registered here, before the machine that names it);
--   * plant.start_area_occupancy (CREATE OR REPLACE from 0404): where the stage's clearance step has no checker, a passed
--     clearance that is not verified also counts, and a CLEAN area is cleared at the start by CLEAR_UNCHECKED
--     (step.execute); otherwise unchanged (INV-15, IN-21, PR-26, PR-34). An area created before 1887 is on version 1,
--     which has no CLEAR_UNCHECKED, so it keeps the verified rule until the owner decides (no aggregate is migrated);
--   * plant.area_occupancy: its clearance_id now references plant.clearance, not plant.clearance_verification, and a row
--     guard (a0_clearance_verified, EBMR-PLANT-131) holds the same rule for whoever writes;
--   * recipe.plant_status_entry_problem (CREATE OR REPLACE from 0691, the latest): an AREA_OCCUPANCY entry of a step with
--     no checker stands on a passed clearance that is not verified; otherwise unchanged (EBMR-EXE-210).
--
-- A verifier can still verify such a clearance (plant.verify_clearance is unchanged). CREATE OR REPLACE keeps the owner
-- (ebmr_owner) and the privileges. Applied as a new migration because applied migrations are checksummed and never
-- edited.

set local role ebmr_owner;

-- Whether a clearance needs a second person's verification: the G-10 step p_step, or else the G-10 steps of stage
-- p_stage, of master content p_content name a checker. True where none is found (header).
create function recipe.clearance_checked(p_content jsonb, p_stage text, p_step text) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(bool_or(coalesce(jsonb_typeof(ph -> 'signatures' -> 'check') = 'object', false)), true)
  from jsonb_path_query(coalesce(p_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "stage")') st,
       jsonb_path_query(st, 'strict $.** ? (@.kind == "phase" && @.block.type == "G-10")') ph
  where case when p_step is not null then ph ->> 'id' = p_step else st ->> 'id' = p_stage end
$$;

revoke all on function recipe.clearance_checked(jsonb, text, text) from public;

-- The guard of CLEAR_UNCHECKED (header): as plant.guard_clearance_passed (0400) without the verification.
create function plant.guard_clearance_recorded_passed(p_aggregate_type text, p_aggregate_id uuid, p_transition jsonb, p_payload jsonb, p_actor jsonb)
returns text
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select case when not exists (
    select 1 from plant.clearance_status c
    where c.area_id = p_aggregate_id and c.recorded_result = 'PASSED'
      and not exists (select 1 from plant.area_occupancy o where o.clearance_id = c.id)
      and c.performed_at > coalesce(plant.area_last_occupancy_event(p_aggregate_id), '-infinity'::timestamptz))
    then 'no passed clearance has been recorded since the last occupancy or cleaning (INV-15)' end
$$;

revoke all on function plant.guard_clearance_recorded_passed(text, uuid, jsonb, jsonb, jsonb) from public;

select platform.register_guard('plant.clearance_recorded_passed', 'plant.guard_clearance_recorded_passed(text, uuid, jsonb, jsonb, jsonb)',
                               'An unused, passed clearance of the area was recorded after its last occupancy, verified or not (INV-15)');

-- The rule holds whoever writes (ADR 0012): an occupancy referenced a verification row (0400, the foreign key to
-- plant.clearance_verification); it now references the clearance, and this row guard refuses an unverified clearance
-- unless it passed, the stage's clearance step names no checker and the area is on area_status version 2 (header).
alter table plant.area_occupancy drop constraint area_occupancy_clearance_id_fkey;
alter table plant.area_occupancy add constraint area_occupancy_clearance_id_fkey foreign key (clearance_id) references plant.clearance (id);

create function plant.area_occupancy_clearance_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  c plant.clearance_status;
begin
  select * into c from plant.clearance_status where id = new.clearance_id;
  if c.verified_at is not null then
    return new;
  end if;
  if c.recorded_result is distinct from 'PASSED'
     or recipe.clearance_checked(recipe.batch_mbr_content(new.batch_id), new.stage, null)
     or (select s.machine_version from platform.aggregate_state s where s.aggregate_type = 'plant_area' and s.aggregate_id = new.area_id) < 2 then
    perform plant.fail(format('Occupancy of stage %s needs a passed clearance verified by a second person: its clearance step names a checker, or the area predates unchecked clearances (PR-34, INV-15; EBMR-PLANT-131)', new.stage));
  end if;
  return new;
end
$$;

revoke all on function plant.area_occupancy_clearance_guard() from public;

create trigger a0_clearance_verified before insert on plant.area_occupancy for each row execute function plant.area_occupancy_clearance_guard();

-- As 0404, keyed on the stage's clearance step (header).
create or replace function plant.start_area_occupancy(p_area_code text, p_batch uuid, p_stage text,
                                           p_order text default null, p_artwork_set text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  v_b         jsonb;
  v_batch_ref text;
  v_product   text;
  a        plant.area;
  p        plant.product;
  v_state  text;
  v_other  plant.area_occupancy_status;
  v_prev   plant.area_occupancy;
  v_req    jsonb;
  v_after  timestamptz;
  c        plant.clearance_status;
  v_clean  plant.cleaning_status;
  v_id     uuid;
  v_checked boolean;
begin
  perform iam.assert_not_administrator();
  -- The batch number and product come from the batch record, never from the caller (IN-26 (c) rests on the product).
  v_b := plant.batch_facts(p_batch);
  v_batch_ref := v_b ->> 'batch_number';
  v_product := v_b ->> 'product';
  perform iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', v_product));
  a := plant.area_by_code(p_area_code, true);
  p := plant.require_product(v_product);
  if plant.is_blank(v_batch_ref) or plant.is_blank(p_stage) then
    perform plant.fail('A start in a room or line names the batch and the stage (EBMR-PLANT-120)');
  end if;
  if a.kind = 'LINE' and (plant.is_blank(p_order) or plant.is_blank(p_artwork_set)) then
    perform plant.fail('A start on a line names the packaging order and its artwork set (L-29; EBMR-PLANT-121)');
  end if;
  if a.kind = 'ROOM' and (p_order is not null or p_artwork_set is not null) then
    perform plant.fail('Packaging orders run on lines (EBMR-PLANT-121)');
  end if;
  -- IN-26 (c): a highly potent product only in a room with a negative pressure cascade.
  if p.highly_potent and not a.negative_pressure then
    perform plant.fail(format('%s is highly potent: it is processed only in a room with a negative pressure cascade, and %s is not one (IN-26 (c); EBMR-PLANT-122)',
                              p.code, a.code));
  end if;
  -- 1886: the clearance needs a second person's verification only where the stage's G-10 step has a checker.
  v_checked := recipe.clearance_checked(recipe.batch_mbr_content(p_batch), p_stage, null);
  -- An area created before area_status version 2 (1887) has no CLEAR_UNCHECKED: it keeps the verified rule (header).
  if not v_checked and (select s.machine_version from platform.aggregate_state s where s.aggregate_type = 'plant_area' and s.aggregate_id = a.id) < 2 then
    v_checked := true;
  end if;
  v_state := plant.state_of('plant_area', a.id);
  if v_state = 'IN_USE' then
    select * into v_other from plant.area_occupancy_status where area_id = a.id and ended_at is null order by started_at limit 1;
    if a.kind = 'LINE' then
      perform plant.fail(format('%s already runs packaging order %s: one active packaging order per line (PR-35; EBMR-PLANT-123)', a.code, v_other.packaging_order));
    end if;
    if not a.segregated then
      if exists (select 1 from plant.area_occupancy_status where area_id = a.id and ended_at is null and product_code <> v_product) then
        perform plant.fail(format('%s holds open batch %s of %s: a second batch of another product is allowed only in a segregated room (IN-26 (b), PR-25; EBMR-PLANT-124)',
                                  a.code, v_other.batch_ref, v_other.product_code));
      end if;
      perform plant.fail(format('%s is in use by batch %s: release, clean and clear it first (INV-15; EBMR-PLANT-125)', a.code, v_other.batch_ref));
    end if;
  elsif v_state <> 'CLEARED_FOR_BATCH' and not (v_state = 'CLEAN' and not v_checked) then
    perform plant.fail(format('%s is %s%s: a batch starts only in a room or line cleared for it (IN-21, INV-15; EBMR-PLANT-126)', a.code, v_state,
                              case v_state when 'DIRTY' then ' (to be cleaned)' when 'CLEANING' then ' (cleaning not verified)'
                                           when 'CLEAN' then ' (no passed clearance)' else '' end));
  end if;
  v_req := plant.required_clearance(a.id, v_product);
  v_after := coalesce(plant.area_last_occupancy_event(a.id), '-infinity'::timestamptz);
  select * into c from plant.clearance_status x
  where x.area_id = a.id and x.performed_at > v_after
    and (x.result = 'PASSED' or (not v_checked and x.verified_at is null and x.recorded_result = 'PASSED'))
    and not exists (select 1 from plant.area_occupancy o where o.clearance_id = x.id)
    and x.next_batch_id = p_batch and x.next_product = v_product
    and x.next_order is not distinct from nullif(btrim(p_order), '') and x.next_artwork_set is not distinct from nullif(btrim(p_artwork_set), '')
    and (x.clearance_type = v_req ->> 'type' or (v_req ->> 'type' = 'CAMPAIGN' and x.clearance_type = 'PRODUCT_CHANGE'))
  order by x.verified_at desc nulls last, x.performed_at desc, x.id desc limit 1;
  if c.id is null then
    perform plant.fail(format('%s has no passed %s clearance for batch %s of %s%s recorded%s since its last occupancy or cleaning (%s) (INV-15, PR-26, PR-34; EBMR-PLANT-127)',
                              a.code, v_req ->> 'type', v_batch_ref, v_product,
                              case when p_order is not null then format(', order %s, artwork set %s', p_order, p_artwork_set) else '' end,
                              case when v_checked then ' and verified' else '' end, v_req ->> 'reason'));
  end if;
  -- A passed clearance with no checker clears a CLEAN area at the start (a verified one did at its verification).
  if v_state = 'CLEAN' then
    perform plant.move('area_status', 'plant_area', a.id, 'CLEAR_UNCHECKED');
    v_state := 'CLEARED_FOR_BATCH';
  end if;
  -- A product change in a room follows a MAJOR cleaning (full clearance and cleaning, outline 5.2.8).
  if v_state = 'CLEARED_FOR_BATCH' and v_req ->> 'type' = 'PRODUCT_CHANGE' then
    select * into v_clean from plant.cleaning_status where area_id = a.id and verified_at is not null order by verified_at desc, id desc limit 1;
    if v_clean.level is distinct from 'MAJOR' then
      perform plant.fail(format('%s: a product change needs a MAJOR cleaning of the area; the last one was %s (IN-26 (a); EBMR-PLANT-128)',
                                a.code, coalesce(v_clean.level, 'none')));
    end if;
  end if;
  v_prev := plant.latest_occupancy(a.id);
  insert into plant.area_occupancy (area_id, exclusive, previous_occupancy_id, batch_id, batch_ref, product_code, stage, packaging_order, artwork_set,
                                    clearance_id, started_by)
  values (a.id, not a.segregated, case when not a.segregated then v_prev.id end,
          p_batch, v_batch_ref, v_product, p_stage, nullif(btrim(p_order), ''), nullif(btrim(p_artwork_set), ''), c.id, plant.actor_person())
  returning id into v_id;
  if v_state = 'CLEARED_FOR_BATCH' then
    perform plant.move('area_status', 'plant_area', a.id, 'START');
  end if;
  return v_id;
end
$$;

-- As 0691, keyed on the step's checker (header).
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
  -- 1886: a passed clearance with no verification stands where the step has no checker (its stage's G-10 step).
  select case when c.result is not null then c.result
              when c.recorded_result = 'PASSED' and not recipe.clearance_checked(recipe.batch_mbr_content(p_batch), null, p_step) then 'PASSED' end
    into v_result from plant.clearance_status c where c.id = o.clearance_id;
  return case
    when o.id is null then format('occupancy %s does not exist in site services', v_entry ->> 'occupancyId')
    when o.batch_id is distinct from p_batch then format('occupancy %s is of batch %s, not of this batch', o.id, o.batch_ref)
    when v_code is distinct from v_entry ->> 'areaCode' then format('occupancy %s is of %s, not of %s', o.id, v_code, coalesce(v_entry ->> 'areaCode', '(none)'))
    when o.ended_at is not null then format('occupancy %s of %s has ended', o.id, v_code)
    when o.started_by is distinct from p_person then format('occupancy %s was started by another person', o.id)
    when v_result is distinct from 'PASSED' then format('the clearance of occupancy %s is %s, not a passed clearance (verified where the step has a checker)', o.id, coalesce(v_result, 'unverified'))
  end;
end
$$;

reset role;
