-- Tablets server: the signed acts on an output container over HTTP (Phase 4 slice 1b; signable action CONTAINER_ACT;
-- recipe-core 0740 and 0741; controls DI-30, DI-35, DI-37, L-30).
--
--   * tab.kernel_signing_meanings: CREATE OR REPLACE from its latest definition (1101) with one change: an output_container
--     is signed VERIFIED (the second person's check of a typed net, DI-30) and OUTPUT_CONTAINER_RELEASED (QA's release of a
--     held container) through the kernel's content, besides RESIDUE_RESERVED. output_container is already a RECORD-class
--     record (tab.aggregate_read_class, 1101), so the signer previews what they sign with RECORD.READ.
-- Nothing else changes; CREATE OR REPLACE keeps the owner, the grants and the policies that call it. Applied as a new
-- migration because applied migrations are checksummed and never edited.

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
           when 'material_lot' then array['MATERIAL_LOT_RELEASED', 'MATERIAL_LOT_REJECTED', 'MATERIAL_LOT_STATUS_DECIDED']
           when 'lot_retest' then array['LOT_RETEST_APPROVED']
           -- Phase 4 slice 1b: the typed net's second person (VERIFIED) and QA's release (OUTPUT_CONTAINER_RELEASED).
           when 'output_container' then array['RESIDUE_RESERVED', 'VERIFIED', 'OUTPUT_CONTAINER_RELEASED']
           when 'reprocessing_authorisation' then array['REPROCESSING_AUTHORISED']
           when 'reprocessing_request' then array['REPROCESSING_AUTHORISED']
           when 'formula_version' then array['FORMULA_APPROVED']
           when 'plant_cleaning' then array['LOGBOOK_DOUBLE_CHECKED']
           when 'plant_clearance' then array['VERIFIED']
           when 'plant_equipment_repair' then array['LOGBOOK_DOUBLE_CHECKED']
           -- Phase 3 slice 6d: the MBR life cycle (MBR_TRANSITION).
           when 'mbr_version' then array['PREPARED', 'CHECKED', 'APPROVED', 'REGULATORY_CONFIRMED']
           -- Exit review HIGH-1: QA's confirmation of a received ERP master version (site-services 0802).
           when 'erp_master' then array['ERP_MASTER_CONFIRMED']
           else '{}'::text[]
         end
$$;

reset role;
