-- Recipe core: the end of a unit's or room's use records the person's reason (owner decision of 13 November 2026 on
-- the demo report of that day, bug 4; DI-22, IN-25, IN-21, PR-34).
--
-- Handbook: modules/recipe-core.md
--
-- Numbered 1926 (first pushed as 1922, then renumbered above 1921, 1923, 1924 and 1925 of other branches merged to main,
-- so an upgraded installation applies it in order; the SQL is unchanged).
--
-- A use left open on the Plant screen for a batch whose master binds no step to the unit or room held it for every later
-- batch. The Plant screen now lists those uses and ends them; the owner ruled that such an end states why. Rule taken
-- here (the simplest safe one, documented in PROGRESS.md):
--   - plant.end_equipment_use(use, reason) and plant.end_area_occupancy(occupancy, reason) take a reason. A reason, when
--     given, is not blank and at most 500 characters (EBMR-PLANT-065). It is stored on the end row (insert-only and
--     audited, so its hash is in the trail) and written as a business entry of the same audit chain naming the unit or
--     room, the batch and the reason, attributed to the person.
--   - A use whose batch has finished (execution status EXECUTION_COMPLETE, ABORTED or CANCELLED) is ended only with a
--     reason (EBMR-PLANT-065): ending it is then no longer part of the batch's own run.
--   - The one-argument functions stay (the step screen's plant acts, the clearance and status steps, the demo loaders):
--     they end a running batch's use without a reason as before, and are refused like the two-argument call with a null
--     reason once the batch has finished. The Plant screen always sends a reason (the server's route requires none, so
--     the step screen keeps working; the screen asks for it).
-- Rights are unchanged: STEP.EXECUTE for the product, administrators refused (DI-17, DI-18).
--
-- New migration: 0400, 0403 and 0404 are applied and checksummed.

set local role ebmr_owner;

alter table plant.equipment_use_end add column reason text
  constraint equipment_use_end_reason check (reason is null or (btrim(reason) <> '' and char_length(reason) <= 500));
alter table plant.area_occupancy_end add column reason text
  constraint area_occupancy_end_reason check (reason is null or (btrim(reason) <> '' and char_length(reason) <= 500));

create or replace view plant.equipment_use_status as
  select u.*, e.ended_by, e.ended_at, e.clean_hold_crossed, e.calibration_crossed, e.campaign_crossed, e.overran_plan, e.reason as end_reason
  from plant.equipment_use u left join plant.equipment_use_end e on e.use_id = u.id;

create or replace view plant.area_occupancy_status as
  select o.*, e.ended_by, e.ended_at, e.reason as end_reason
  from plant.area_occupancy o left join plant.area_occupancy_end e on e.occupancy_id = o.id;

-- The reason an end states, checked: null stays null (a running batch's end from its step), anything else is trimmed and
-- must say something; a finished batch's use needs one.
create function plant.use_end_reason(p_reason text, p_batch uuid, p_batch_number text) returns text
language plpgsql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  v_status text;
  v_reason text := btrim(p_reason);
begin
  if p_reason is not null and (v_reason = '' or char_length(v_reason) > 500) then
    perform plant.fail('The reason for ending a use says why, in at most 500 characters (DI-22; EBMR-PLANT-065)');
  end if;
  select st.status into v_status from recipe.execution_state st where st.batch_id = p_batch;
  if v_reason is null and v_status in ('EXECUTION_COMPLETE', 'ABORTED', 'CANCELLED') then
    perform plant.fail(format('batch %s is %s: ending its use is no longer part of its run and needs the reason (DI-22; EBMR-PLANT-065)',
                              p_batch_number, v_status));
  end if;
  return v_reason;
end
$$;
revoke all on function plant.use_end_reason(text, uuid, text) from public;

create function plant.end_equipment_use(p_use uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  u        plant.equipment_use_status;
  v_code   text;
  v_reason text;
  v_hold   timestamptz;
  v_cal    timestamptz;
  v_now    timestamptz := clock_timestamp();
  v_ch     boolean;
  v_cc     boolean;
  v_kc     boolean;
  v_ov     boolean;
begin
  perform iam.assert_not_administrator();
  select * into u from plant.equipment_use_status where id = p_use;
  if u.id is null then
    perform plant.fail(format('Unknown use %s (EBMR-PLANT-063)', p_use));
  end if;
  perform iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', u.product_code));
  select code into v_code from plant.equipment where id = u.equipment_id for update;
  select * into u from plant.equipment_use_status where id = p_use;
  if u.ended_at is not null then
    perform plant.fail(format('Use %s is not open (EBMR-PLANT-063)', p_use));
  end if;
  v_reason := plant.use_end_reason(p_reason, u.batch_id, u.batch_ref);
  select c.verified_at + k.clean_hold into v_hold
  from plant.cleaning_status c join plant.equipment e on e.id = c.equipment_id join plant.equipment_class k on k.code = e.class_code
  where c.id = u.cleaning_id;
  select case when c.as_left = 'PASS' then c.due_at end into v_cal from plant.calibration c
  where c.equipment_id = u.equipment_id and c.recorded_at <= u.started_at order by c.recorded_at desc, c.id desc limit 1;
  v_ch := v_hold is not null and v_hold <= v_now;
  v_cc := v_cal is not null and v_cal <= v_now;
  v_kc := u.campaign_window_end is not null and u.campaign_window_end <= v_now;
  v_ov := u.planned_end < v_now;
  insert into plant.equipment_use_end (use_id, equipment_id, started_at, ended_by, ended_at, clean_hold_crossed, calibration_crossed,
                                       campaign_crossed, overran_plan, reason)
  values (p_use, u.equipment_id, u.started_at, plant.actor_person(), v_now, v_ch, v_cc, v_kc, v_ov, v_reason);
  if v_reason is not null then
    perform kernel.audit_business_event('plant_equipment:' || u.equipment_id::text,
      format('Use of %s by batch %s ended: %s', v_code, u.batch_ref, v_reason),
      jsonb_build_object('use_id', p_use, 'equipment_code', v_code, 'batch_number', u.batch_ref, 'reason', v_reason));
  end if;
  perform plant.move('equipment_cleanliness', 'plant_equipment', u.equipment_id, 'END_USE');
  return jsonb_build_object('use_id', p_use, 'clean_hold_crossed', v_ch, 'calibration_crossed', v_cc, 'campaign_crossed', v_kc,
                            'overran_plan', v_ov)
         || case when v_reason is null then '{}'::jsonb else jsonb_build_object('reason', v_reason) end;
end
$$;

-- The step screen's end (no reason): the same checks first, then the two-argument end with none.
create or replace function plant.end_equipment_use(p_use uuid) returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  if exists (select 1 from plant.equipment_use u where u.id = p_use) then  -- an unknown use is refused below (EBMR-PLANT-063)
    perform iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', (select u.product_code from plant.equipment_use u where u.id = p_use)));
  end if;
  return plant.end_equipment_use(p_use, null::text);
end
$$;

create function plant.end_area_occupancy(p_occupancy uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  o        plant.area_occupancy_status;
  v_code   text;
  v_reason text;
begin
  perform iam.assert_not_administrator();
  select * into o from plant.area_occupancy_status where id = p_occupancy;
  if o.id is null then
    perform plant.fail(format('Unknown occupancy %s (EBMR-PLANT-129)', p_occupancy));
  end if;
  perform iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', o.product_code));
  select code into v_code from plant.area where id = o.area_id for update;
  select * into o from plant.area_occupancy_status where id = p_occupancy;
  if o.ended_at is not null then
    perform plant.fail(format('Occupancy %s has ended (EBMR-PLANT-129)', p_occupancy));
  end if;
  v_reason := plant.use_end_reason(p_reason, o.batch_id, o.batch_ref);
  insert into plant.area_occupancy_end (occupancy_id, ended_by, reason) values (p_occupancy, plant.actor_person(), v_reason);
  if v_reason is not null then
    perform kernel.audit_business_event('plant_area:' || p_occupancy::text,
      format('Use of %s by batch %s (stage %s) ended: %s', v_code, o.batch_ref, o.stage, v_reason),
      jsonb_build_object('occupancy_id', p_occupancy, 'area_code', v_code, 'batch_number', o.batch_ref, 'stage', o.stage, 'reason', v_reason));
  end if;
  if not exists (select 1 from plant.area_occupancy_status where area_id = o.area_id and ended_at is null) then
    perform plant.move('area_status', 'plant_area', o.area_id, 'RELEASE');
  end if;
end
$$;

create or replace function plant.end_area_occupancy(p_occupancy uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
begin
  perform iam.assert_not_administrator();
  if exists (select 1 from plant.area_occupancy o where o.id = p_occupancy) then  -- an unknown one is refused below (EBMR-PLANT-129)
    perform iam.require_permission('STEP.EXECUTE', jsonb_build_object('product', (select o.product_code from plant.area_occupancy o where o.id = p_occupancy)));
  end if;
  perform plant.end_area_occupancy(p_occupancy, null::text);
end
$$;

revoke all on function plant.end_equipment_use(uuid, text), plant.end_area_occupancy(uuid, text) from public;
grant execute on function plant.end_equipment_use(uuid, text), plant.end_area_occupancy(uuid, text) to ebmr_app;

reset role;
