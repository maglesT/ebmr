-- Tablets: a peer installation is a RECORD-class record (Phase 6 slice 6i; kernel 1220; DI-31): QA, who signs its
-- approval (PEER_INSTALLATION_APPROVE), reads its content; tablets 1290 left it GOVERNANCE, which QA does not read.
--
-- Handbook: modules/tablets-server.md
--
--   * tab.aggregate_read_class: CREATE OR REPLACE from 1290 with peer_installation beside transfer_receipt. Nothing else
--     changes; a later migration that re-creates the function starts from this definition.

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
                                        -- Phase 6 slice 6i (site services 0981, kernel 1220; L-41, DI-39, DI-31): local QA's decision
                                        -- on a received lot, and QA's approval of a peer installation's key (QA signs it, so QA reads it)
                                        'transfer_receipt', 'peer_installation')
              then 'RECORD' else 'GOVERNANCE' end
$$;

reset role;
