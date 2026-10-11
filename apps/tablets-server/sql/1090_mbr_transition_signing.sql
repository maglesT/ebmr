-- Tablets server, Phase 3 slice 6d (GB-T-01 approves its master through the routes): the MBR life-cycle signatures of the
-- signable action MBR_TRANSITION (features/designer/signables.ts) are previewed and challenged through the kernel's
-- content like the other signed acts (controls DI-35, DI-37, PR-04).
--
--   * tab.kernel_signing_meanings (latest: 1040) adds mbr_version with exactly the meanings its life-cycle commands take:
--     PREPARED (submit), CHECKED (check), APPROVED (approve) and REGULATORY_CONFIRMED (the regulatory sign-off, PR-04).
--     mbr_version is a RECORD-class record already (tab.aggregate_read_class, 1040). The life-cycle commands still check
--     the meaning, the state, the roles and the four-eyes rules of each signature; nothing else changes.

set local role ebmr_owner;

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
           -- Phase 3 slice 6d: the MBR life cycle (MBR_TRANSITION).
           when 'mbr_version' then array['PREPARED', 'CHECKED', 'APPROVED', 'REGULATORY_CONFIRMED']
           else '{}'::text[]
         end
$$;

reset role;
