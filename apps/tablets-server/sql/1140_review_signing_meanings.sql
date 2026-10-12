-- Tablets: the review aggregates are signed and previewed through the ceremony (Phase 4 slice 1a; recipe-core 0712).
--   * tab.kernel_signing_meanings: CREATE OR REPLACE from its latest definition (1112, builder 1b) with the review
--     aggregates added: batch_review (PRODUCTION_APPROVED, PACKAGING_RECORD_APPROVED, QA_REVIEWED), batch_audit_review
--     (AUDIT_TRAIL_REVIEWED, DELTA_AUDIT_TRAIL_REVIEWED), batch_review_reopen (REVIEW_REOPENED) and review_items
--     (REVIEW_ITEMS_DISPOSITIONED); and batch_point (CORRECTED, CORRECTION_APPROVED: the CORRECT_ENTRY route previews the
--     data point it corrects through the kernel's content, the engine's handler previewing only steps, stages and
--     exceptions).
--   * tab.aggregate_read_class: CREATE OR REPLACE from its latest definition (1101): the four are RECORD-class records, so
--     the reviewer previews what they sign with RECORD.READ.
-- Nothing else changes; CREATE OR REPLACE keeps the owner, the grants and the policies that call them.

set local role ebmr_owner;

create or replace function tab.aggregate_read_class(p_aggregate_type text) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p_aggregate_type in ('batch_step', 'batch_stage', 'batch_exception', 'batch_point', 'batch_issue', 'mbr_version', 'mbr_market_authorisation',
                                        'market_rule_correction', 'market_site_loosening', 'market_policy_version', 'record_type_version',
                                        'esig_stub', 'sample_record',
                                        'batch_act', 'batch_review', 'batch_audit_review', 'batch_review_reopen', 'review_items', 'deviation', 'lot_test_result', 'qc_extra_testing', 'material_lot', 'output_container',
                                        'reprocessing_authorisation', 'reprocessing_request', 'formula_version',
                                        'plant_cleaning', 'plant_clearance', 'plant_equipment_repair',
                                        'lot_retest',
                                        -- exit review HIGH-1
                                        'erp_master')
              then 'RECORD' else 'GOVERNANCE' end
$$;

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
           when 'batch_point' then array['CORRECTED', 'CORRECTION_APPROVED']
           when 'batch_review' then array['PRODUCTION_APPROVED', 'PACKAGING_RECORD_APPROVED', 'QA_REVIEWED']
           when 'batch_audit_review' then array['AUDIT_TRAIL_REVIEWED', 'DELTA_AUDIT_TRAIL_REVIEWED']
           when 'batch_review_reopen' then array['REVIEW_REOPENED']
           when 'review_items' then array['REVIEW_ITEMS_DISPOSITIONED']
           else '{}'::text[]
         end
$$;

reset role;
