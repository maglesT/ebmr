-- Tablets: the master-record acts that had no screen get one (Phase 7 slice 7g-2, decision 0025): the market
-- authorisation's two signatures and QA's approval of a labelling specimen are signed through the ceremony.
--
-- Handbook: modules/tablets-server.md
--
--   * Labelling specimens (SPECIMEN_APPROVED, kernel 0210; EU Ch.4 packaging instructions, DI-35): a SPECIMEN reference
--     document (tab.reference_document, the DMS stand-in, recorded by the master-data steward) is approved by a holder of
--     MBR.APPROVE who did not record it. tab.labelling_specimen_approval is insert-only and audited on the document's
--     chain; one approval per document version; a retired or withdrawn version is never approved.
--       tab.labelling_specimen_state(id)     RECORDED, APPROVED, RETIRED or WITHDRAWN; null for any other document
--       tab.labelling_specimen_content(id)   the esig content of aggregate labelling_specimen (the document as recorded)
--       tab.approve_labelling_specimen(id, signature)   never an administrator, then MBR.APPROVE; the signer's own valid
--                                            SPECIMEN_APPROVED signature on the version in state RECORDED; never the recorder.
--   * tab.aggregate_read_class: CREATE OR REPLACE from its latest definition (1410) with labelling_specimen (RECORD).
--   * tab.kernel_signing_meanings: CREATE OR REPLACE from its latest definition (1410) with mbr_market_authorisation
--     (MBR_MARKET_AUTHORISED, REGULATORY_CONFIRMED: recipe-core 0160 asks for both on the record before activation) and
--     labelling_specimen (SPECIMEN_APPROVED). Nothing else changes; a later migration that re-creates either function
--     starts from this definition.
-- Messages: EBMR-TAB-470 to 474.

set local role ebmr_owner;

create table tab.labelling_specimen_approval (
  document_id          uuid primary key references tab.reference_document (id),
  signature_id         uuid not null unique,
  approved_by_person   uuid not null,
  approved_by_account  uuid not null,
  approved_at          timestamptz not null default clock_timestamp()
);
revoke all on tab.labelling_specimen_approval from public;
grant select on tab.labelling_specimen_approval to ebmr_app;
select platform.enforce_db_time('tab.labelling_specimen_approval', array['approved_at']);
select kernel.register_audited_table('tab.labelling_specimen_approval', 'reference_document', 'document_id', true);

-- The state of a SPECIMEN document version (null: no such document, or not a specimen).
create function tab.labelling_specimen_state(p_document uuid) returns text
language sql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
  select case when exists (select 1 from tab.labelling_specimen_approval a where a.document_id = d.id) then 'APPROVED'
              else coalesce((select r.status from tab.reference_document_retirement r where r.document_id = d.id), 'RECORDED') end
    from tab.reference_document d where d.id = p_document and d.kind = 'SPECIMEN'
$$;

-- What the approver signs: the specimen as recorded (its code, version, title, hash of its body and the date it takes
-- effect) and who recorded it. Fixed once recorded (the register is insert-only), so the signed content never changes.
create function tab.labelling_specimen_content(p_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, site, pg_temp as $$
declare
  d tab.reference_document;
begin
  if coalesce(p_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return '{"exists": false}'::jsonb;
  end if;
  select * into d from tab.reference_document where id = p_id::uuid and kind = 'SPECIMEN';
  if d.id is null then
    return '{"exists": false}'::jsonb;
  end if;
  return jsonb_build_object('exists', true, 'content_version', 1,
    'content', jsonb_build_object('code', d.code, 'version', d.version, 'title', d.title, 'content_hash', d.content_hash,
                                  'effective_from', to_char(d.effective_from, 'YYYY-MM-DD'), 'summary', d.content ->> 'summary',
                                  'recorded_by', d.recorded_by_person, 'recorded_at', site.utc_text(d.recorded_at)),
    'state', tab.labelling_specimen_state(d.id),
    'scope', '{}'::jsonb,
    'entered_by', jsonb_build_array(d.recorded_by_person));
end
$$;

select esig.register_content_provider('labelling_specimen', 'tab.labelling_specimen_content(text)',
  'A labelling or printed packaging specimen (a SPECIMEN reference document) as recorded, approved by QA (SPECIMEN_APPROVED)');

create function tab.approve_labelling_specimen(p_document uuid, p_signature uuid) returns void
language plpgsql volatile security definer set search_path = pg_catalog, tab, iam, esig, pg_temp as $$
declare
  v_ctx  jsonb;
  d      tab.reference_document;
  v_prob text;
begin
  perform iam.assert_not_administrator();
  v_ctx := iam.require_permission('MBR.APPROVE', '{}'::jsonb);
  select * into d from tab.reference_document where id = p_document and kind = 'SPECIMEN' for update;
  if d.id is null then
    raise exception using errcode = 'P0001', message = format('There is no labelling specimen %s in the reference documents. [EBMR-TAB-470]', coalesce(p_document::text, 'NULL'));
  end if;
  if tab.labelling_specimen_state(d.id) <> 'RECORDED' then
    raise exception using errcode = 'P0001', message = format('Specimen %s version %s is %s; only a recorded specimen that is neither approved nor retired is approved, once (DI-35). [EBMR-TAB-471]',
                                                              d.code, d.version, tab.labelling_specimen_state(d.id));
  end if;
  if d.recorded_by_person::text = v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'A labelling specimen is approved by another person than the one who recorded it (DI-35). [EBMR-TAB-472]';
  end if;
  perform esig.assert_signature(p_signature, 'SPECIMEN_APPROVED', 'labelling_specimen', d.id::text);
  v_prob := esig.signature_state_problem(p_signature);
  if v_prob is not null then
    raise exception using errcode = 'P0001', message = 'The specimen approval signature is not valid: ' || v_prob || ' [EBMR-TAB-473]';
  end if;
  if (select g.signer_person from esig.signature g where g.id = p_signature)::text is distinct from v_ctx ->> 'person_id' then
    raise exception using errcode = 'P0001', message = 'The specimen approval is recorded by the person who signed it (DI-35). [EBMR-TAB-474]';
  end if;
  insert into tab.labelling_specimen_approval (document_id, signature_id, approved_by_person, approved_by_account)
  values (d.id, p_signature, (v_ctx ->> 'person_id')::uuid, (v_ctx ->> 'account_id')::uuid);
end
$$;

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
                                        'transfer_receipt', 'peer_installation',
                                        -- Phase 7 slice 7a (recipe-core 1210; PR-27, 6jc-R10): QA's approval of a penicillin
                                        -- facility rule and of a beta-lactam classification
                                        'facility_rule', 'beta_lactam_class',
                                        -- Phase 7 slice 7g-2 (tablets 1479; DI-35): QA's approval of a labelling specimen
                                        'labelling_specimen')
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
           else '{}'::text[]
         end
$$;

revoke all on function tab.labelling_specimen_state(uuid), tab.labelling_specimen_content(text), tab.approve_labelling_specimen(uuid, uuid) from public;
grant execute on function tab.labelling_specimen_state(uuid), tab.approve_labelling_specimen(uuid, uuid) to ebmr_app;

reset role;
