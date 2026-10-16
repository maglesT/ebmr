-- Tablets: local QA's decision on a received lot-transfer package and QA's approval of a peer installation (Phase 6 slice
-- 6i; site services 0981, kernel 1220; L-41, DI-39, DI-31) are previewed and signed through the ceremony (signable actions
-- TRANSFER_RECEIPT_DECIDE and PEER_INSTALLATION_APPROVE).
--
-- Handbook: modules/tablets-server.md
--
--   * tab.kernel_signing_meanings: CREATE OR REPLACE from its latest definition (tablets 1280) with TRANSFER_RECEIPT_ACCEPTED
--     and TRANSFER_RECEIPT_REFUSED on transfer_receipt and PEER_INSTALLATION_APPROVED on peer_installation.
--   * tab.aggregate_read_class: CREATE OR REPLACE from 1280: a transfer receipt is a RECORD-class record (a peer
--     installation stays GOVERNANCE).
-- Slice 6i's tablets range is 1300 to 1309 (D-P6i-0-1; 6e has 1290 to 1299, 6g 1310 to 1319). The latest definition
-- on main is 1280; a slice that merges after this one re-creates these functions from this definition (or this one from
-- theirs) so that no slice's entries are lost. Nothing else changes.

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
                                        -- Phase 4 slice 2: specifications and returned goods (2b), deviation impact (2a)
                                        'specification', 'returned_goods',
                                        -- exit review HIGH-1
                                        'erp_master',
                                        -- Phase 4 slice 3a: the manufacturer release and its release-side acts
                                        'manufacturer_release', 'post_change_evaluation', 'ppq_outcome', 'investigation_justification',
                                        -- Phase 4 slice 4a: the market dispositions, certifications and market changes
                                        'us_disposition', 'market_change', 'qp_transcription', 'qp_transcription_check', 'qp_certification',
                                        -- Phase 4 slice 4b: the EU QP batch package (a signed true-copy bundle; kernel 1160)
                                        'qp_package',
                                        -- Phase 4 slice 5: suspension, recall and rejection after release, disposal (5a); the
                                        -- record lock, its amendments and the bulk reconciliation (5b)
                                        'release_suspension', 'disposal', 'record_lock',
                                        -- Phase 4 slice 6: the India licence and export-permission records (6a), the certified
                                        -- evidence export and the contingency-form reconciliation (6b), the PQR extract (6c)
                                        'manufacturing_licence', 'export_permission', 'evidence_export', 'form_reconciliation', 'pqr_extract',
                                        -- Phase 4 slice 6 quick review (recipe-core 0912): the second person's approval of a
                                        -- hazard classification and of an area dedication (IN-27)
                                        'hazard_classification', 'area_dedication',
                                        -- Phase 6 slice 6a (site services 0925): QA's closure of a CAPA (IN-01, PR-51)
                                        'capa',
                                        -- Phase 6 slice 6a builder A (site services 0910): QA's approval of a manufacturer (PR-17)
                                        'approved_manufacturer',
                                        -- Phase 6 slice 6f builder A (kernel 1195; DI-09): a configuration change record
                                        'config_change_record',
                                        -- Phase 6 slice 6d (recipe-core 1012; IN-29): the AP's sign-off of a mock recall
                                        'mock_recall',
                                        -- Phase 6 slice 6i (site services 0981; L-41, DI-39): local QA's decision on a received lot
                                        'transfer_receipt')
              then 'RECORD' else 'GOVERNANCE' end
$$;

create or replace function tab.kernel_signing_meanings(p_aggregate_type text) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_aggregate_type
           when 'esig_stub' then array['PERFORMED', 'VERIFIED', 'WITNESSED', 'LOGBOOK_PERFORMED', 'LOGBOOK_DOUBLE_CHECKED', 'PREPARED', 'CHECKED', 'APPROVED']
           when 'batch_issue' then array['ISSUED']
           when 'batch_act' then array['VOID_AUTHORISED']
           when 'deviation' then array['DEVIATION_IMPACT_ASSESSED', 'DEVIATION_CONCLUDED', 'DEVIATION_CLOSED']
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
           -- Phase 4 slice 2b: an approved specification and a returned-goods assessment (site services 084x).
           when 'specification' then array['SPECIFICATION_APPROVED']
           when 'returned_goods' then array['RETURNED_GOODS_ASSESSED']
           -- Phase 4 slice 3a: the manufacturer release (release or rejection, one meaning) and its release-side acts.
           when 'manufacturer_release' then array['MANUFACTURER_RELEASE']
           when 'post_change_evaluation' then array['POST_CHANGE_EVALUATED']
           when 'ppq_outcome' then array['VALIDATION_OUTCOME_RECORDED']
           when 'investigation_justification' then array['OPEN_INVESTIGATION_JUSTIFIED']
           -- Phase 4 slice 3b: QA's verification record of a compendial rule set (TB-12; GOVERNANCE class).
           when 'compendial_rule_set' then array['COMPENDIAL_RULE_SET_VERIFIED']
           -- Phase 4 slice 4a: market dispositions, certification intake, market changes, importers and the QP register.
           when 'us_disposition' then array['US_DISPOSITION']
           when 'market_change' then array['MARKET_ADDED', 'MARKET_REMOVED']
           when 'qp_transcription' then array['QP_CERTIFICATION_RECORDED']
           when 'qp_transcription_check' then array['QP_CERTIFICATION_VERIFIED']
           when 'qp_certification' then array['QP_CERTIFIED', 'QP_REJECTED']
           when 'eu_importer' then array['EU_IMPORTER_APPROVED']
           when 'qp_register' then array['QP_REGISTERED']
           -- Phase 4 slice 4b: the EU QP batch package, qp_package <package id>, expected state ASSEMBLED (kernel 1160).
           when 'qp_package' then array['TRUE_COPY_VERIFIED']
           -- Phase 4 slice 5a: after release (recipe-core 0840 to 0869): the AP's re-confirmation, recall or rejection of a
           -- suspended market, and the disposal of a rejected lot (witnessed destruction: performer and witness).
           when 'release_suspension' then array['RELEASE_RECONFIRMED', 'RECALLED', 'REJECTED_AFTER_RELEASE']
           when 'disposal' then array['DISPOSAL_RECORDED', 'DESTRUCTION_WITNESSED']
           -- Phase 4 slice 5b: QA opens and closes the amendment of a locked record (recipe-core 0872),
           -- record_lock <batch>/<n>/OPEN/<DEVIATION|CHANGE_RECORD>/<id> and <batch>/<n>/CLOSE.
           when 'record_lock' then array['AMENDMENT_OPENED', 'AMENDMENT_CLOSED']
           -- Phase 4 slice 6a (site services 0870 to 0889, recipe-core 0890 to 0909): QA's approval of a manufacturing or loan
           -- licence record and of an export permission per product, strength and destination (IN-30; D-6-1, D-6-2).
           when 'manufacturing_licence' then array['LICENCE_APPROVED']
           when 'export_permission' then array['EXPORT_PERMISSION_APPROVED']
           -- Phase 4 slice 6b (kernel 1170 to 1199): the certified evidence export (IN-11) and the reconciliation of the
           -- contingency forms before EXECUTION_COMPLETE (DI-43, PR-16; D-6-6).
           when 'evidence_export' then array['EVIDENCE_EXPORT_CERTIFIED']
           when 'form_reconciliation' then array['FORMS_RECONCILED']
           -- Phase 4 slice 6c: the AP's sign-off of a PQR extract, pqr_extract <extract id>, expected state EXTRACTED
           -- (recipe-core 0910; IN-01 (b), PR-58).
           when 'pqr_extract' then array['PQR_SIGNED_OFF']
           -- Phase 4 slice 6 quick review (recipe-core 0912; IN-27): a hazard classification and an area dedication take effect
           -- only on a second person's approval, hazard_classification <record id> and area_dedication <record id>, state RECORDED.
           when 'hazard_classification' then array['HAZARD_CLASSIFICATION_APPROVED']
           when 'area_dedication' then array['AREA_DEDICATION_APPROVED']
           -- Phase 6 slice 6a (site services 0925; IN-01 (d), PR-51): QA closes a CAPA, capa <capa id>, state IMPLEMENTED.
           when 'capa' then array['CAPA_CLOSED']
           -- Phase 6 slice 6a builder A (site services 0910; PR-17): QA approves a manufacturer of a material,
           -- approved_manufacturer <row id>, state PROPOSED.
           when 'approved_manufacturer' then array['MANUFACTURER_APPROVED']
           -- Phase 6 slice 6f builder A (kernel 1195; DI-09): the quality unit approves a configuration change record,
           -- config_change_record <number>, state OPEN.
           when 'config_change_record' then array['CONFIG_CHANGE_APPROVED']
           -- Phase 6 slice 6d (recipe-core 1012; IN-29, D-P6d-2): the AP signs off a mock recall, mock_recall <id>, state RUN.
           when 'mock_recall' then array['MOCK_RECALL_SIGNED_OFF']
           -- Phase 6 slice 6i (site services 0981, kernel 1220; L-41, DI-39, DI-31): local QA accepts or refuses a received
           -- lot-transfer package, transfer_receipt <id>, state RECEIVED; QA approves a peer installation's key,
           -- peer_installation <id>, state PROPOSED (GOVERNANCE class).
           when 'transfer_receipt' then array['TRANSFER_RECEIPT_ACCEPTED', 'TRANSFER_RECEIPT_REFUSED']
           when 'peer_installation' then array['PEER_INSTALLATION_APPROVED']
           else '{}'::text[]
         end
$$;

reset role;
