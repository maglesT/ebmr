-- Plant, repair of a signalled failure needs a second person (Phase 3 slice 1 quick review, backlog item 10; outline
-- 5.2.8; controls IN-25 (d), PR-23).
--
-- 0403 let one maintenance person clear a failure signalled from a step (record_equipment_event 'REPAIRED'): the unit
-- went back into use on that person's word alone. From this migration on a repair is two acts, as a manual cleaning
-- (verify_cleaning) and a clearance (verify_clearance) are:
--   plant.record_repair(code, detail, reference)  LOGBOOK.ENTRY   the repairer records what was done against the open
--                                                                 failure (plant.equipment_repair); the unit stays
--                                                                 OUT_OF_SERVICE.
--   plant.verify_repair(repair, signature)         LOGBOOK.SIGN    a second person signs LOGBOOK_DOUBLE_CHECKED on the
--                                                                 repair (aggregate plant_equipment_repair, whose
--                                                                 signed content shows the failure and the repair) and
--                                                                 records it in their own command; that writes the
--                                                                 REPAIRED equipment event, which ends the failure.
-- The verifier is neither the person who signalled the failure nor the repairer: refused in the command (EBMR-PLANT-032)
-- and, both being performers in the signed content, by the signature service (LOGBOOK_DOUBLE_CHECKED excludes
-- performers). record_equipment_event no longer accepts 'REPAIRED' (EBMR-PLANT-030); its body is otherwise that of
-- 0403 (CREATE OR REPLACE; 0403 is never edited).
--
-- Database enforcement (owner-level writes included): a verification row by the repairer or by the person who signalled
-- the failure is refused by its row guard, and a REPAIRED equipment event without its verification row in the same
-- transaction is refused at commit by a deferred constraint trigger.
-- Tables are insert-only, audited, read by ebmr_app and written only by these SECURITY DEFINER functions (ADR 0012).

set local role ebmr_owner;

create table plant.equipment_repair (
  id                uuid primary key default gen_random_uuid(),
  equipment_id      uuid not null references plant.equipment (id),
  failure_event_id  uuid not null references plant.equipment_event (id),
  detail            text not null check (btrim(detail) <> ''),
  reference         text not null check (btrim(reference) <> ''),
  repaired_by       uuid not null,
  repaired_account  uuid not null,
  recorded_at       timestamptz not null default clock_timestamp()
);
create index equipment_repair_by_failure on plant.equipment_repair (failure_event_id);

create table plant.equipment_repair_verification (
  repair_id         uuid primary key references plant.equipment_repair (id),
  repaired_event_id uuid not null unique references plant.equipment_event (id),
  verified_by       uuid not null,
  signature_id      uuid not null unique,
  verified_at       timestamptz not null default clock_timestamp()
);

revoke all on plant.equipment_repair, plant.equipment_repair_verification from public;
select platform.enforce_db_time('plant.equipment_repair', array['recorded_at']);
select platform.enforce_db_time('plant.equipment_repair_verification', array['verified_at']);
select kernel.register_audited_table('plant.equipment_repair', 'plant_equipment', 'equipment_id', true);
select kernel.register_audited_table('plant.equipment_repair_verification', 'plant_equipment_repair', 'repair_id', true);
grant select on plant.equipment_repair, plant.equipment_repair_verification to ebmr_app;

-- Row guards: the rules that hold whoever writes (owner-level code included).
-- A verification names a REPAIRED event of the repaired unit and is by a person other than the repairer and the person
-- who signalled the failure.
create function plant.repair_verification_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
declare
  r plant.equipment_repair;
  f plant.equipment_event;
  v plant.equipment_event;
begin
  select * into r from plant.equipment_repair where id = new.repair_id;
  select * into f from plant.equipment_event where id = r.failure_event_id;
  select * into v from plant.equipment_event where id = new.repaired_event_id;
  if v.id is null or v.kind <> 'REPAIRED' or v.equipment_id <> r.equipment_id then
    raise exception using errcode = 'P0001', message = 'A repair verification names the REPAIRED event of the repaired unit (EBMR-PLANT-033)';
  end if;
  if new.verified_by in (r.repaired_by, f.person_id) or v.person_id is distinct from new.verified_by then
    raise exception using errcode = 'P0001',
      message = 'A repair of a signalled failure is verified by a person other than the one who signalled the failure and the one who repaired it (IN-25 (d); EBMR-PLANT-032)';
  end if;
  return new;
end
$$;
create trigger a1_guard before insert on plant.equipment_repair_verification for each row execute function plant.repair_verification_guard();

-- A REPAIRED event stands only with its verification, written in the same transaction (checked at commit).
create function plant.repaired_event_verified_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, plant, pg_temp as $$
begin
  if new.kind = 'REPAIRED' and not exists (select 1 from plant.equipment_repair_verification v where v.repaired_event_id = new.id) then
    raise exception using errcode = 'P0001',
      message = 'A REPAIRED event is written only with a second person''s verification of the repair (plant.verify_repair) (IN-25 (d); EBMR-PLANT-030)';
  end if;
  return null;
end
$$;
create constraint trigger z1_repaired_verified after insert on plant.equipment_event deferrable initially deferred
  for each row when (new.kind = 'REPAIRED') execute function plant.repaired_event_verified_guard();

-- The open failure of a unit: its latest FAILURE_SIGNALLED event when no REPAIRED event followed it.
create function plant.open_failure(p_equipment uuid) returns plant.equipment_event
language sql stable security definer set search_path = pg_catalog, plant, pg_temp as $$
  select v.* from plant.equipment_event v
  where v.equipment_id = p_equipment and v.kind in ('FAILURE_SIGNALLED', 'REPAIRED')
  order by v.recorded_at desc, v.id desc limit 1
$$;

-- 0403's body, with REPAIRED refused here: a repair goes through record_repair and verify_repair.
create or replace function plant.record_equipment_event(p_equipment_code text, p_kind text, p_detail text, p_reference text default null,
                                                        p_batch_ref text default null) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  e    plant.equipment;
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission(case when p_kind in ('QUALIFIED', 'QUALIFICATION_WITHDRAWN', 'RETIRED') then 'MASTERDATA.CHANGE'
                                      when p_kind = 'FAILURE_SIGNALLED' then 'STEP.EXECUTE'
                                      else 'LOGBOOK.ENTRY' end, '{}'::jsonb);
  if p_kind = 'REPAIRED' then
    perform plant.fail('A repair of a signalled failure is recorded with plant.record_repair and becomes effective only once a second person verifies it with plant.verify_repair (IN-25 (d); EBMR-PLANT-030)');
  end if;
  e := plant.equipment_by_code(p_equipment_code, true);
  if plant.latest_event_of(e.id, array['RETIRED']) is not null then
    perform plant.fail(format('%s is retired; nothing more is recorded on it (EBMR-PLANT-020)', e.code));
  end if;
  if p_kind = 'RETURNED_TO_SERVICE' and plant.latest_event_of(e.id, array['TAKEN_OUT_OF_SERVICE', 'RETURNED_TO_SERVICE']) is distinct from 'TAKEN_OUT_OF_SERVICE' then
    perform plant.fail(format('%s is not out of service (EBMR-PLANT-021)', e.code));
  end if;
  if p_kind = 'MAINTENANCE_ENDED' and plant.latest_event_of(e.id, array['MAINTENANCE_STARTED', 'MAINTENANCE_ENDED']) is distinct from 'MAINTENANCE_STARTED' then
    perform plant.fail(format('%s is not in maintenance (EBMR-PLANT-021)', e.code));
  end if;
  if p_kind = 'FAILURE_SIGNALLED' and plant.is_blank(p_batch_ref) then
    perform plant.fail('A failure signalled from a step names its batch (IN-25 (d); EBMR-PLANT-022)');
  end if;
  insert into plant.equipment_event (equipment_id, kind, reference, batch_ref, detail, person_id, account_id)
  values (e.id, p_kind, nullif(btrim(p_reference), ''), nullif(btrim(p_batch_ref), ''), p_detail, plant.actor_person(), plant.actor_account())
  returning id into v_id;
  return v_id;
end
$$;

-- The repairer records the repair of the unit's open failure, with the work-order reference. The unit stays out of use.
create function plant.record_repair(p_equipment_code text, p_detail text, p_reference text) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, pg_temp as $$
declare
  e    plant.equipment;
  f    plant.equipment_event;
  v_id uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('LOGBOOK.ENTRY', '{}'::jsonb);
  e := plant.equipment_by_code(p_equipment_code, true);
  if plant.latest_event_of(e.id, array['RETIRED']) is not null then
    perform plant.fail(format('%s is retired; nothing more is recorded on it (EBMR-PLANT-020)', e.code));
  end if;
  f := plant.open_failure(e.id);
  if f.id is null or f.kind <> 'FAILURE_SIGNALLED' then
    perform plant.fail(format('%s has no open failure to repair (EBMR-PLANT-021)', e.code));
  end if;
  if plant.is_blank(p_detail) or plant.is_blank(p_reference) then
    perform plant.fail('A repair states what was done and cites its work order (EBMR-PLANT-031)');
  end if;
  insert into plant.equipment_repair (equipment_id, failure_event_id, detail, reference, repaired_by, repaired_account)
  values (e.id, f.id, btrim(p_detail), btrim(p_reference), plant.actor_person(), plant.actor_account())
  returning id into v_id;
  return v_id;
end
$$;

-- The second person verifies a recorded repair with their own LOGBOOK_DOUBLE_CHECKED signature on it. The repair must
-- still answer the unit's open failure; the verifier is neither who signalled the failure nor who repaired it. The
-- REPAIRED event (the verifier's command) ends the failure.
create function plant.verify_repair(p_repair uuid, p_signature uuid) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, plant, iam, platform, pg_temp as $$
declare
  r        plant.equipment_repair;
  f        plant.equipment_event;
  v_open   plant.equipment_event;
  v_person uuid;
  v_signer uuid;
  v_event  uuid;
begin
  perform iam.assert_not_administrator();
  perform iam.require_permission('LOGBOOK.SIGN', '{}'::jsonb);
  v_person := plant.actor_person();
  select * into r from plant.equipment_repair where id = p_repair;
  if r.id is null then
    perform plant.fail(format('Unknown repair %s (EBMR-PLANT-033)', p_repair));
  end if;
  perform 1 from plant.equipment where id = r.equipment_id for update;
  if plant.latest_event_of(r.equipment_id, array['RETIRED']) is not null then
    perform plant.fail('The unit is retired; nothing more is recorded on it (EBMR-PLANT-020)');
  end if;
  v_open := plant.open_failure(r.equipment_id);
  if v_open.id is distinct from r.failure_event_id or v_open.kind <> 'FAILURE_SIGNALLED' then
    perform plant.fail(format('Repair %s does not answer the unit''s open failure (already repaired, or another failure was signalled since) (EBMR-PLANT-033)', p_repair));
  end if;
  select * into f from plant.equipment_event where id = r.failure_event_id;
  if v_person in (r.repaired_by, f.person_id) then
    perform plant.fail('A repair of a signalled failure is verified by a person other than the one who signalled the failure and the one who repaired it (IN-25 (d); EBMR-PLANT-032)');
  end if;
  perform platform.verify_signature(p_signature, 'LOGBOOK_DOUBLE_CHECKED', 'plant_equipment_repair', p_repair::text);
  select signer_person into v_signer from esig.signature where id = p_signature;
  if v_signer is distinct from v_person then
    perform plant.fail('The verification signature is the verifier''s own (EBMR-PLANT-034)');
  end if;
  insert into plant.equipment_event (equipment_id, kind, reference, batch_ref, detail, person_id, account_id)
  values (r.equipment_id, 'REPAIRED', r.reference, f.batch_ref, r.detail, v_person, plant.actor_account())
  returning id into v_event;
  insert into plant.equipment_repair_verification (repair_id, repaired_event_id, verified_by, signature_id)
  values (p_repair, v_event, v_person, p_signature);
  return v_event;
end
$$;

-- Canonical signable content of a repair (esig content-provider contract, kernel 0200): the failure it answers and what
-- was done. Both the person who signalled the failure and the repairer are performers.
create function plant.repair_content(p_id text) returns jsonb
language sql stable security definer set search_path = pg_catalog, plant, recipe, pg_temp as $$
  select coalesce((
    select jsonb_build_object(
      'exists', true,
      'aggregate_id', r.id::text,
      'content_version', 1,
      'content', jsonb_build_object(
        'equipment', e.code,
        'failure', jsonb_build_object('id', f.id, 'detail', f.detail, 'batch', f.batch_ref, 'signalled_by', f.person_id,
                                      'signalled_at', recipe.utc_text(f.recorded_at)),
        'repair', jsonb_build_object('detail', r.detail, 'reference', r.reference, 'repaired_by', r.repaired_by,
                                     'recorded_at', recipe.utc_text(r.recorded_at))),
      'state', case when exists (select 1 from plant.equipment_repair_verification v where v.repair_id = r.id) then 'VERIFIED' else 'RECORDED' end,
      'entered_by', to_jsonb(array[r.repaired_by, f.person_id]))
    from plant.equipment_repair r join plant.equipment e on e.id = r.equipment_id join plant.equipment_event f on f.id = r.failure_event_id
    where r.id::text = p_id), '{"exists": false}'::jsonb)
$$;

select esig.register_content_provider('plant_equipment_repair', 'plant.repair_content(text)',
  'A repair of a failure signalled on a unit: the failure (detail, batch, who signalled it) and the repair (detail, work order, repairer) (outline 5.2.8; IN-25 (d))');
select esig.register_signed_table('plant.equipment_repair', 'plant_equipment_repair', 'id');

revoke all on function plant.open_failure(uuid), plant.record_repair(text, text, text), plant.verify_repair(uuid, uuid),
                       plant.repair_content(text) from public;
grant execute on function plant.record_repair(text, text, text), plant.verify_repair(uuid, uuid) to ebmr_app;

reset role;
