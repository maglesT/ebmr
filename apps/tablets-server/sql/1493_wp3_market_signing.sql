-- Tablets: the market loosenings, the EU qualified-person register and the compendial rule-set verification are signed
-- through the ceremony (Phase 7 slice 7g, work package WP3; decision 0025: every act has a screen).
--
-- Handbook: modules/tablets-server.md
--
--   * tab.kernel_signing_meanings: CREATE OR REPLACE from its latest definition (1479) with market_policy_version
--     (POLICY_LOOSENING_APPROVED) and market_site_loosening (SITE_VALUE_LOOSENING_APPROVED): the approver's signature of
--     a loosening before it is made (kernel 0360), signable MARKET_LOOSENING. compendial_rule_set and qp_register keep the
--     meanings they had.
--   * tab.record_read_problem: CREATE OR REPLACE from its latest definition (1425) with the signer's own read of a
--     compendial rule set and of a qualified person's registration. Both stay GOVERNANCE class (tablets 1161; decision
--     D-P7R-6: no reclassification to RECORD, which would let every RECORD.READ role read them): a session reads one
--     only in a role that may sign its meaning (COMPENDIAL_RULE_SET_VERIFIED, QP_REGISTERED: the meaning type's current
--     permissions), or in a governance role as before. The signable handlers read the content to be signed through
--     tab.content_for_signing for the signer's session (as RESTORE_APPROVE does for a restore event), never through
--     tab.record_content_for_signing (RECORD class only). DI-17, DI-37.
-- Nothing else changes; a later migration that re-creates either function starts from this definition (tablets 1525
-- re-creates tab.kernel_signing_meanings with the union of the slice 7g work packages' meanings).

set local role ebmr_owner;

create or replace function tab.record_read_problem(p_reader tab.reader, p_aggregate_type text, p_aggregate_id text) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
declare
  v_product text;
  v_scope   jsonb;
begin
  -- Phase 7 slice 7b-1 (tablets 1425, 6jc-R3, IN-30): the contract giver's reviewer reads its loan licence's batches
  -- through its own logged reads (recipe-core 1060) only; no record is read here in that role or by such an account.
  if p_reader.role_code = 'CONTRACT_GIVER_REVIEWER'
     or exists (select 1 from iam.role_grant g
                 where g.account_id = p_reader.account_id and g.role_code = 'CONTRACT_GIVER_REVIEWER'
                   and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, clock_timestamp())) then
    return format('the contract giver''s reviewer reads only the batches of its loan licence, through its own logged reads (IN-30); %s %s is not read here',
                  p_aggregate_type, coalesce(p_aggregate_id, '(none)'));
  end if;
  -- Phase 6 slice 6e (tablets 1290, IN-53): a controlled-substance record is read by the roles that record or sign that
  -- kind (and, as every GOVERNANCE record, by the roles that review audit trails, data integrity or access, or audit).
  if p_aggregate_type in ('controlled_product', 'controlled_custody', 'controlled_checkpoint') then
    if not tab.role_may(p_reader.role_code, case p_aggregate_type
                                              when 'controlled_product' then array['CONTROLLED.RECORD', 'CONTROLLED.APPROVE']
                                              when 'controlled_custody' then array['CONTROLLED.CUSTODY']
                                              else array['CONTROLLED.BALANCE'] end)
       and not tab.role_may(p_reader.role_code, tab.governance_read_permissions()) then
      return format('%s records are read only by the roles that record or sign them (IN-53); the role %s does not', p_aggregate_type, p_reader.role_code);
    end if;
    -- Phase 7 slice 7a (tablets 1414, 6jc-R2, IN-53): and only with CONTROLLED.READ in the record's scope.
    v_scope := tab.controlled_record_scope(p_aggregate_type, p_aggregate_id);
    return regexp_replace(tab.controlled_reader_problem(p_reader, coalesce(v_scope ->> 'site', tab.reader_site(p_reader)), v_scope ->> 'product', v_scope is null),
                          '^EBMR-[A-Z]+-[0-9]{3} ', '');
  end if;
  -- Phase 7 slice 7g WP3 (decision D-P7R-6; DI-17, DI-37): a compendial rule set and a qualified person's registration
  -- stay GOVERNANCE class (tablets 1161); the person who signs one reads it in their own session: a role that may sign
  -- its meaning (the meaning type's current permissions), or, as every GOVERNANCE record, a governance or audit role.
  if p_aggregate_type in ('compendial_rule_set', 'qp_register') then
    if not tab.role_may(p_reader.role_code, (esig.current_meaning(case p_aggregate_type when 'compendial_rule_set' then 'COMPENDIAL_RULE_SET_VERIFIED'
                                                                                        else 'QP_REGISTERED' end)).permissions)
       and not tab.role_may(p_reader.role_code, tab.governance_read_permissions()) then
      return format('%s records are read only by the roles that sign them or review audit trails, data integrity or access, or audit; the role %s does not (D-P7R-6)',
                    p_aggregate_type, p_reader.role_code);
    end if;
    return null;
  end if;
  -- Phase 6 slice 6f (tablets 1276, DI-08): a vendor support grant is read by those who request or approve one.
  if p_aggregate_type = 'support_grant' then
    if not tab.role_may(p_reader.role_code, array['SUPPORT.GRANT_REQUEST', 'SUPPORT.APPROVE_QA', 'SUPPORT.APPROVE_IT']) then
      return format('support grants are read only by the roles that request or approve them; the role %s does not', p_reader.role_code);
    end if;
    return null;
  end if;
  if tab.aggregate_read_class(p_aggregate_type) = 'RECORD' then
    if not tab.role_may(p_reader.role_code, array['RECORD.READ']) then
      return format('the role %s does not hold RECORD.READ', p_reader.role_code);
    end if;
    -- DI-13 (slice 6 review): a composition from the formulation library is read only with FORMULA.READ.
    v_product := tab.composition_product(p_aggregate_type, p_aggregate_id);
    if v_product is not null and not tab.formula_reader_may(p_reader, v_product) then
      return format('%s %s carries a composition of the formulation library, read only with FORMULA.READ; the role %s does not hold it for product %s (DI-13)',
                    p_aggregate_type, p_aggregate_id, p_reader.role_code, v_product);
    end if;
    return null;
  end if;
  if not tab.role_may(p_reader.role_code, tab.governance_read_permissions()) then
    return format('%s records are read only in a role that reviews audit trails, data integrity or access, or audits (one holding %s); the role %s holds none of these',
                  p_aggregate_type, array_to_string(tab.governance_read_permissions(), ', '), p_reader.role_code);
  end if;
  return null;
end
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
           -- Phase 7 slice 7g-2: the market authorisation's QA and regulatory signatures (recipe-core 0160, ADR 0014) and QA's
           -- approval of a labelling specimen (tablets 1479), signed through the ceremony (MBR_MARKET_ACT, SPECIMEN_ACT).
           when 'mbr_market_authorisation' then array['MBR_MARKET_AUTHORISED', 'REGULATORY_CONFIRMED']
           when 'labelling_specimen' then array['SPECIMEN_APPROVED']
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
           -- Phase 7 slice 7a (recipe-core 1210; PR-27, 6jc-R10): a penicillin facility rule and a beta-lactam classification
           -- take effect only on QA's approval, facility_rule <id> and beta_lactam_class <id>, state PROPOSED.
           when 'facility_rule' then array['QA_APPROVED']
           when 'beta_lactam_class' then array['QA_APPROVED']
           -- Phase 7 slice 7g WP3 (kernel 0350, 0360): the approver's signature of a market policy or site-value loosening,
           -- signed before the change is made: market_policy_version <policy>@<n>@<position>, market_site_loosening; state PROPOSED.
           when 'market_policy_version' then array['POLICY_LOOSENING_APPROVED']
           when 'market_site_loosening' then array['SITE_VALUE_LOOSENING_APPROVED']
           else '{}'::text[]
         end
$$;

reset role;
