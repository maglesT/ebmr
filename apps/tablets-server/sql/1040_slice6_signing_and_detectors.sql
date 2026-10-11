-- Tablets server, Phase 3 slice 6a: the signed acts of quality, lots, reprocessing, master data and plant over HTTP, and the
-- detector register of the plant master-data screens (controls DI-17, DI-35, DI-37; ADR 0012).
--
--   * tab.aggregate_read_class (latest: 0800) adds the records these acts sign as RECORD-class records, so a person in a
--     role holding RECORD.READ previews the content they sign through the ceremony and reads the signatures (the
--     row-level security of esig.signature and esig.challenge follows): an act proposed on a batch for approval
--     (batch_act), a deviation-lite record, a lot test result, a QC extra-testing decision, a material lot, an output
--     container, a reprocessing authorisation and request, a formula version, a cleaning, a clearance and a repair.
--     Nothing else changes; CREATE OR REPLACE keeps the owner, the grants and the policies that call it.
--   * tab.kernel_signing_meanings (latest: 0800) adds each of these with exactly the meanings its database command takes.
--   * tab.detector_unit       insert-only, audited: which unit of the plant register is a metal detector or a reject gate
--     (TB-17's devices), written with the unit by tab.define_detector (MASTERDATA.CHANGE, through plant.define_equipment).
-- Messages: EBMR-TAB-1040.

set local role ebmr_owner;

create or replace function tab.aggregate_read_class(p_aggregate_type text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p_aggregate_type in ('batch_step', 'batch_stage', 'batch_exception', 'batch_point', 'batch_issue', 'mbr_version', 'mbr_market_authorisation',
                                        'market_rule_correction', 'market_site_loosening', 'market_policy_version', 'record_type_version',
                                        'esig_stub', 'sample_record',
                                        -- Phase 3 slice 6a: the signed acts over HTTP.
                                        'batch_act', 'deviation', 'lot_test_result', 'qc_extra_testing', 'material_lot', 'output_container',
                                        'reprocessing_authorisation', 'reprocessing_request', 'formula_version',
                                        'plant_cleaning', 'plant_clearance', 'plant_equipment_repair')
              then 'RECORD' else 'GOVERNANCE' end
$$;

-- The pairs of aggregate type and meaning this installation signs through the kernel's content (latest: 0800), the
-- slice 6a acts added with exactly their meanings (the database command of each still checks the meaning it needs).
create or replace function tab.kernel_signing_meanings(p_aggregate_type text) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_aggregate_type
           when 'esig_stub' then array['PERFORMED', 'VERIFIED', 'WITNESSED', 'LOGBOOK_PERFORMED', 'LOGBOOK_DOUBLE_CHECKED', 'PREPARED', 'CHECKED', 'APPROVED']
           when 'batch_issue' then array['ISSUED']
           when 'batch_act' then array['VOID_AUTHORISED']
           when 'deviation' then array['DEVIATION_CONCLUDED', 'DEVIATION_CLOSED']
           when 'lot_test_result' then array['QC_RESULT_APPROVED']
           when 'qc_extra_testing' then array['QC_EXTRA_TESTING_DECIDED']
           when 'material_lot' then array['MATERIAL_LOT_RELEASED', 'MATERIAL_LOT_REJECTED', 'MATERIAL_LOT_STATUS_DECIDED', 'LOT_RETEST_APPROVED']
           when 'output_container' then array['RESIDUE_RESERVED']
           when 'reprocessing_authorisation' then array['REPROCESSING_AUTHORISED']
           when 'reprocessing_request' then array['REPROCESSING_AUTHORISED']
           when 'formula_version' then array['FORMULA_APPROVED']
           when 'plant_cleaning' then array['LOGBOOK_DOUBLE_CHECKED']
           when 'plant_clearance' then array['VERIFIED']
           when 'plant_equipment_repair' then array['LOGBOOK_DOUBLE_CHECKED']
           else '{}'::text[]
         end
$$;

create table tab.detector_unit (
  equipment_id   uuid primary key references plant.equipment (id),
  device         text not null check (device in ('METAL_DETECTOR', 'REJECT_GATE')),
  person_id      uuid not null,
  account_id     uuid not null,
  recorded_at    timestamptz not null default clock_timestamp()
);
revoke all on tab.detector_unit from public;
create trigger aa_insert_only before update or delete on tab.detector_unit for each row execute function kernel.reject_mutation();
create trigger aa_no_truncate before truncate on tab.detector_unit for each statement execute function kernel.reject_mutation();
select platform.enforce_db_time('tab.detector_unit', array['recorded_at']);
select kernel.register_audited_table('tab.detector_unit', 'plant_equipment', 'equipment_id', true);
grant select on tab.detector_unit to ebmr_app;

-- p: {code, name, classCode, areaCode?, device}. The unit through plant.define_equipment (its permission and checks), then
-- its device type.
create function tab.define_detector(p jsonb) returns uuid
language plpgsql volatile security definer set search_path = pg_catalog, tab, plant, iam, pg_temp as $$
declare
  v_actor jsonb := iam.assert_validated_actor();
  v_id    uuid;
begin
  if coalesce(p ->> 'device', '') not in ('METAL_DETECTOR', 'REJECT_GATE') then
    raise exception using errcode = 'P0001', message = 'EBMR-TAB-1040 a detector is a METAL_DETECTOR or a REJECT_GATE (TB-17)';
  end if;
  perform plant.define_equipment(p - 'device');
  select e.id into v_id from plant.equipment e where e.code = p ->> 'code';
  insert into tab.detector_unit (equipment_id, device, person_id, account_id)
  values (v_id, p ->> 'device', (v_actor ->> 'person_id')::uuid, (v_actor ->> 'account_id')::uuid);
  return v_id;
end
$$;

revoke all on function tab.define_detector(jsonb) from public;
grant execute on function tab.define_detector(jsonb) to ebmr_app;

reset role;
