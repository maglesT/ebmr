-- Tablets server, Phase 3 slice 3c (builder A): a process device is the plant unit of its step's equipment use, the
-- interface-loss record written by a server job, and the block types that run on a process device (tablets spec K-06,
-- K-09; slice 3a review backlog #5 and #7; controls DI-31, PR-14, PR-22, PR-23, INV-12; ADR 0012: the rules hold when the
-- application's own database credentials are used directly).
--
--   tab.process_block_type   the block types whose steps run on a process device (they carry G-06's configuration):
--                            G-06, TB-04, TB-05, TB-07 (3b), TB-10 and TB-17 (3c); a later slice adds its own rows.
--                            tab.g06_step_node (CREATE OR REPLACE from 0850) reads it instead of a fixed list.
--   tab.process_device_unit  which plant.equipment unit (a PROCESS unit) a process device binding is (IAM.DEVICE_MANAGE,
--                            once per binding; one active device per unit); insert-only
--   tab.bind_step_device     (CREATE OR REPLACE from 0820, backlog #5): the device bound to a step is linked to a plant
--                            unit, that unit has an open use (plant.equipment_use, slice 1: started only on a fit, clean,
--                            idle unit, INV-12, PR-23) of this batch, and when the step names the equipment it uses, the
--                            unit is of the class the MBR binds for one of those references (EBMR-DEV-134)
--   tab.interface_loss       a loss of the link to a step's device found by the server's job (DI-31, PR-14): the device
--                            sent nothing for longer than the step's stale age at database time while the step was in
--                            progress; written only by tab.record_interface_losses as the service identity holding
--                            EXECUTION.SWEEP (the execution sweeper), once per loss (a new loss only after the device
--                            sent again). A step on a process device closes only when every loss recorded for it is
--                            answered by an INTERFACE_LOSS entry of the step made after it (tablets 0874), so the G-06
--                            exception and two-person mode follow every loss the job finds.
--
-- Messages: EBMR-DEV-13N (step binding), EBMR-DEV-15N (unit link, interface loss). Every function is SECURITY DEFINER,
-- owned by ebmr_owner, pg_temp last (ADR 0016). Applied as a new migration because applied migrations are checksummed and
-- never edited.

set local role ebmr_owner;

-- ---------------------------------------------------------------------------------------------
-- Block types on a process device

create table tab.process_block_type (
  block_type  text primary key check (block_type ~ '^(G|TB)-[0-9]{2}$')
);
create trigger aa_process_block_type_insert_only before update or delete on tab.process_block_type for each row execute function kernel.reject_mutation();
create trigger aa_process_block_type_no_truncate before truncate on tab.process_block_type for each statement execute function kernel.reject_mutation();
insert into tab.process_block_type (block_type) values ('G-06'), ('TB-04'), ('TB-05'), ('TB-07'), ('TB-10'), ('TB-17');
revoke all on tab.process_block_type from public;
grant select on tab.process_block_type to ebmr_app;

-- As 0850: the phase p_step of batch p_batch's MBR that runs on a process device (its block type in
-- tab.process_block_type); refuses anything else.
create or replace function tab.g06_step_node(p_batch uuid, p_step text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, recipe, pg_temp as $$
declare
  v_node jsonb := recipe.step_node(recipe.batch_mbr_content(p_batch), p_step);
begin
  if v_node is null or not exists (select 1 from tab.process_block_type t where t.block_type = v_node -> 'block' ->> 'type') then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-130 %s is not an automated equipment step (G-06, or a Tablets block that carries G-06''s configuration) of this batch', coalesce(p_step, 'NULL'));
  end if;
  return v_node;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- The plant unit of a process device

create table tab.process_device_unit (
  process_device_id  uuid primary key references tab.process_device (id),
  equipment_id       uuid not null references plant.equipment (id),
  person_id          uuid not null,
  account_id         uuid not null,
  linked_at          timestamptz not null default clock_timestamp()
);
create index process_device_unit_by_equipment on tab.process_device_unit (equipment_id);
select platform.enforce_db_time('tab.process_device_unit', array['linked_at']);
select kernel.register_audited_table('tab.process_device_unit', 'gateway_key', 'process_device_id', true);
revoke all on tab.process_device_unit from public;
grant select on tab.process_device_unit to ebmr_app;

-- IAM.DEVICE_MANAGE: links active process device binding p_binding to the PROCESS unit p_equipment_code of the plant;
-- once per binding, one active device per unit (PR-22).
create function tab.link_process_device_unit(p_binding uuid, p_equipment_code text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, plant, iam, pg_temp as $$
declare
  v_actor   jsonb;
  d         tab.process_device;
  e         plant.equipment;
  v_problem text;
begin
  v_actor := iam.require_permission('IAM.DEVICE_MANAGE', '{}'::jsonb);
  select * into d from tab.process_device where id = p_binding and ended_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'EBMR-DEV-150 no active process device binding with this id';
  end if;
  v_problem := plant.press_unit_problem(p_equipment_code);
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-151 a process device is a PROCESS unit of the plant: %s (PR-22)', v_problem);
  end if;
  select * into e from plant.equipment where code = p_equipment_code for update;
  if exists (select 1 from tab.process_device_unit u where u.process_device_id = p_binding) then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-152 device %s is linked to a unit already; end the binding and bind again', d.device_code);
  end if;
  if exists (select 1 from tab.process_device_unit u join tab.process_device x on x.id = u.process_device_id
              where u.equipment_id = e.id and x.ended_at is null) then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-153 unit %s has an active process device already (PR-22)', e.code);
  end if;
  insert into tab.process_device_unit (process_device_id, equipment_id, person_id, account_id)
  values (p_binding, e.id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
end
$$;

-- PR-23, INV-12: why plant unit p_equipment cannot be the unit step p_step of batch p_batch runs on, or NULL: it has an
-- open use of this batch, and when the step names the equipment it uses (phase equipment, use USE), its class is the
-- class the MBR binds for one of those references in the step's stage (as recipe-core 0521 for G-09@2).
create function tab.step_unit_problem(p_batch uuid, p_step text, p_equipment uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, plant, recipe, pg_temp as $$
declare
  e         plant.equipment;
  v_content jsonb := recipe.batch_mbr_content(p_batch);
  v_node    jsonb := recipe.step_node(v_content, p_step);
  v_refs    text[];
  v_classes text[];
begin
  select * into e from plant.equipment where id = p_equipment;
  if e.id is null then
    return 'the unit does not exist';
  end if;
  if not exists (select 1 from plant.equipment_use_status u where u.equipment_id = e.id and u.batch_id = p_batch and u.ended_at is null) then
    return format('unit %s has no open use of this batch (start its use first: its status is checked there, PR-23)', e.code);
  end if;
  v_refs := array(select q ->> 'ref' from jsonb_array_elements(case when jsonb_typeof(v_node -> 'equipment') = 'array' then v_node -> 'equipment' else '[]'::jsonb end) q
                   where q ->> 'use' = 'USE');
  if cardinality(v_refs) = 0 then
    return null;
  end if;
  v_classes := array(
    select r ->> 'code'
      from jsonb_path_query(coalesce(v_content -> 'procedure', '{}'::jsonb), 'strict $.** ? (@.kind == "stage")') st,
           jsonb_array_elements(case when jsonb_typeof(st -> 'binding' -> 'equipment') = 'array' then st -> 'binding' -> 'equipment' else '[]'::jsonb end) b,
           jsonb_array_elements(case when jsonb_typeof(v_content -> 'references') = 'array' then v_content -> 'references' else '[]'::jsonb end) r
     where jsonb_path_exists(st, 'strict $.** ? (@.id == $id)', jsonb_build_object('id', p_step)) and b ->> 'ref' = any (v_refs)
       and r ->> 'id' = b ->> 'equipmentClass');
  if e.class_code <> all (v_classes) then
    return format('unit %s is of class %s, not of a class the MBR binds for the equipment step %s uses (%s)', e.code, e.class_code, p_step, array_to_string(v_refs, ', '));
  end if;
  return null;
end
$$;

-- As 0820 (STEP.EXECUTE in the batch's scope; once per step), and backlog #5: the device is the plant unit of the
-- step's equipment use (header). EBMR-DEV-134.
create or replace function tab.bind_step_device(p_batch uuid, p_step text, p_device_code text) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, recipe, plant, pg_temp as $$
declare
  v_actor   jsonb;
  v_dev     tab.process_device%rowtype;
  v_unit    uuid;
  v_problem text;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('STEP.EXECUTE', plant.batch_scope(p_batch));
  perform tab.g06_step_node(p_batch, p_step);
  select * into v_dev from tab.process_device where device_code = p_device_code and ended_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-131 %s is no active process device', coalesce(p_device_code, 'NULL'));
  end if;
  if exists (select 1 from tab.step_device where batch_id = p_batch and step = p_step) then
    raise exception using errcode = 'P0001', message = format('EBMR-DEV-131 step %s of this batch is already bound to a process device', p_step);
  end if;
  select u.equipment_id into v_unit from tab.process_device_unit u where u.process_device_id = v_dev.id;
  v_problem := case when v_unit is null then format('device %s is linked to no plant unit', v_dev.device_code)
                    else tab.step_unit_problem(p_batch, p_step, v_unit) end;
  if v_problem is not null then
    raise exception using errcode = 'P0001',
      message = format('EBMR-DEV-134 a step runs on the process device of the unit of its equipment use: %s (PR-23, INV-12)', v_problem);
  end if;
  insert into tab.step_device (batch_id, step, process_device_id, person_id, account_id, session_id, correlation_id)
  values (p_batch, p_step, v_dev.id, (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid, (v_actor ->> 'session_id')::uuid,
          (v_actor ->> 'correlation_id')::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Interface loss (backlog #7)

create table tab.interface_loss (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null references recipe.batch_execution (id),
  step               text not null,
  process_device_id  uuid not null references tab.process_device (id),
  last_received_us   bigint,
  max_age_us         numeric not null,
  detected_us        bigint not null,
  person_id          uuid not null,
  account_id         uuid not null,
  detected_at        timestamptz not null default clock_timestamp()
);
create index interface_loss_by_step on tab.interface_loss (batch_id, step, detected_at);
select platform.enforce_db_time('tab.interface_loss', array['detected_at']);
select kernel.register_audited_table('tab.interface_loss', 'process_reading', 'batch_id', true);
revoke all on tab.interface_loss from public;
grant select on tab.interface_loss to ebmr_app;

-- EXECUTION.SWEEP (the sweeper's service identity): records a loss for every step bound to a process device whose
-- instance is in progress in a running batch and whose device has sent nothing for longer than the step's stale age, at
-- database time (tab.step_link_status), once per loss: not again while no reading arrived after the loss already
-- recorded. Returns {recorded: [{batchId, step, lastReceivedUs}]}.
create function tab.record_interface_losses() returns jsonb
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, recipe, pg_temp as $$
declare
  v_actor  jsonb;
  b        record;
  v_link   jsonb;
  v_last   tab.interface_loss;
  v_out    jsonb := '[]'::jsonb;
begin
  perform iam.assert_not_administrator();
  v_actor := iam.require_permission('EXECUTION.SWEEP', '{}'::jsonb);
  for b in
    select d.batch_id, d.step, d.process_device_id from tab.step_device d join recipe.execution_state s on s.batch_id = d.batch_id
     where s.status in ('IN_PROGRESS', 'ON_HOLD')
       and exists (select 1 from jsonb_each(case when jsonb_typeof(s.state -> 'steps') = 'object' then s.state -> 'steps' else '{}'::jsonb end) x
                    where x.value ->> 'step' = d.step and x.value ->> 'status' = 'IN_PROGRESS')
     order by d.batch_id, d.step
  loop
    v_link := tab.step_link_status(b.batch_id, b.step);
    if not coalesce((v_link ->> 'lost')::boolean, false) then
      continue;
    end if;
    select * into v_last from tab.interface_loss l where l.batch_id = b.batch_id and l.step = b.step order by l.detected_at desc, l.id desc limit 1;
    if v_last.id is not null and v_last.last_received_us is not distinct from (v_link ->> 'lastReceivedUs')::bigint then
      continue;
    end if;
    insert into tab.interface_loss (batch_id, step, process_device_id, last_received_us, max_age_us, detected_us, person_id, account_id)
    values (b.batch_id, b.step, b.process_device_id, (v_link ->> 'lastReceivedUs')::bigint, (v_link ->> 'maxAgeUs')::numeric, (v_link ->> 'nowUs')::bigint,
            (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
    v_out := v_out || jsonb_build_object('batchId', b.batch_id, 'step', b.step, 'lastReceivedUs', v_link ->> 'lastReceivedUs');
  end loop;
  return jsonb_build_object('recorded', v_out);
end
$$;

revoke all on function tab.link_process_device_unit(uuid, text), tab.step_unit_problem(uuid, text, uuid), tab.record_interface_losses() from public;
grant execute on function tab.link_process_device_unit(uuid, text), tab.record_interface_losses() to ebmr_app;

reset role;
