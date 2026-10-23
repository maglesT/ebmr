-- Recipe core: rooms and lines dedicated to beta-lactam products (Phase 7 slice 7n, requirement R7; control PR-27;
-- decisions D-7n-2 and D-7n-3).
--
-- Handbook: modules/recipe-core.md
--
-- Until now the penicillin rule was site-wide only (0973, 1210): a beta-lactam product or material is refused at a
-- site that is not a penicillin facility. A site that is one could still run a beta-lactam batch in any room, and any
-- other product in the beta-lactam rooms. Schedule M and US FDA (21 CFR 211.42(d), 211.46(d)) ask for beta-lactam work
-- in dedicated, segregated facilities. Now:
--   * plant.area_dedication (0890) takes a fourth class, BETA_LACTAM: a room or line dedicated to beta-lactam products,
--     recorded by QA (HAZARD.RECORD) and approved by a second QA person (0912 plant.approve_area_dedication, unchanged).
--     A dedication counts once approved (plant.area_dedicated, 0912); a later withdrawal counts at once.
--   * plant.beta_lactam_room_problem(area, batch)   null, or why the batch may not work in the room or line: the batch
--     is beta-lactam (plant.batch_beta_lactam: the plant classification, the ERP product master or the MBR predicate)
--     and the area is not dedicated to beta-lactam products (EBMR-PLANT-177), or the batch is not beta-lactam and the
--     area is dedicated to them (EBMR-PLANT-178).
--   * Triggers (before insert, whoever writes): ac_plant_beta_lactam_room on plant.clearance (a room or line is not
--     cleared for such a batch, so the refusal comes at the clearance on the plant screen) and on plant.area_occupancy (the room's use is not started; after the
--     room rules of 0973), and ac_plant_beta_lactam_unit on plant.equipment_use (a unit's use, which needs no room
--     occupancy, is judged by the room or line the unit stands in; a unit with no room is not checked, D-7n-10).
-- Messages: EBMR-PLANT-177, EBMR-PLANT-178.

set local role ebmr_owner;

alter table plant.area_dedication drop constraint area_dedication_hazard_class_check;
alter table plant.area_dedication add constraint area_dedication_hazard_class_check
  check (hazard_class in ('SEX_HORMONE', 'STEROID', 'CYTOTOXIC', 'BETA_LACTAM'));

-- PR-27: null unless batch p_batch may not work in area p_area (see the header).
create function plant.beta_lactam_room_problem(p_area uuid, p_batch uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
declare
  v_code      text := (select a.code from plant.area a where a.id = p_area);
  v_beta      boolean := plant.batch_beta_lactam(p_batch);
  v_dedicated boolean := plant.area_dedicated(v_code, 'BETA_LACTAM');
  v_batch     text := coalesce((select b.batch_number from recipe.batch_execution b where b.id = p_batch), p_batch::text);
  v_product   text := coalesce(recipe.batch_product(p_batch) ->> 'code', '(unknown product)');
begin
  if v_beta and not v_dedicated then
    return format('EBMR-PLANT-177 batch %s of %s is beta-lactam and %s is not a room or line dedicated to beta-lactam products with a dedication approved by a second QA person: beta-lactam work stays in its dedicated suite (PR-27)',
                  v_batch, v_product, coalesce(v_code, 'NULL'));
  end if;
  if not v_beta and v_dedicated then
    return format('EBMR-PLANT-178 %s is dedicated to beta-lactam products and batch %s of %s is not beta-lactam: no other product works in the beta-lactam suite (PR-27)',
                  v_code, v_batch, v_product);
  end if;
  return null;
end
$$;

create function plant.beta_lactam_clearance_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_problem text := plant.beta_lactam_room_problem(new.area_id, new.next_batch_id);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = v_problem;
  end if;
  return new;
end
$$;
create function plant.beta_lactam_occupancy_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_problem text := plant.beta_lactam_room_problem(new.area_id, new.batch_id);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = v_problem;
  end if;
  return new;
end
$$;
-- A unit's use: judged by the room or line the unit stands in (none: not checked, D-7n-10); the message names the unit.
create function plant.beta_lactam_equipment_check() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  e         plant.equipment;
  v_problem text;
begin
  select * into e from plant.equipment where id = new.equipment_id;
  if e.area_id is not null then
    v_problem := plant.beta_lactam_room_problem(e.area_id, new.batch_id);
    if v_problem is not null then
      raise exception using errcode = 'P0001', message = format('%s (unit %s stands there)', v_problem, e.code);
    end if;
  end if;
  return new;
end
$$;
create trigger ac_plant_beta_lactam_room before insert on plant.clearance for each row execute function plant.beta_lactam_clearance_check();
create trigger ac_plant_beta_lactam_room before insert on plant.area_occupancy for each row execute function plant.beta_lactam_occupancy_check();
create trigger ac_plant_beta_lactam_unit before insert on plant.equipment_use for each row execute function plant.beta_lactam_equipment_check();

revoke all on function plant.beta_lactam_room_problem(uuid, uuid), plant.beta_lactam_clearance_check(), plant.beta_lactam_occupancy_check(), plant.beta_lactam_equipment_check() from public;
grant execute on function plant.beta_lactam_room_problem(uuid, uuid) to ebmr_app;

reset role;
