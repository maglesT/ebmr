-- Tablets: the validation and records acts that had no screen are signed through the ceremony (Phase 7 slice 7g-3,
-- work package WP1; decision 0025).
--
-- Handbook: modules/tablets-server.md
--
--   * tab.kernel_signing_meanings: CREATE OR REPLACE from its latest definition (1479) with validation_summary
--     (VALIDATION_SUMMARY_APPROVED, kernel 1300), evaluation_pack (PERIODIC_EVALUATION_APPROVED, kernel 1336),
--     record_type_version (RECORD_TYPE_APPROVED), record_disposal (RECORD_DISPOSAL_APPROVED) and di_investigation
--     (DI_INVESTIGATION_CLOSED; kernel 0720). The database functions of the acts (platform.approve_validation_summary,
--     records.approve_evaluation_pack, records.approve_record_type, records.approve_purge, records.close_di_investigation)
--     check the right, the signer and the signature; this only lets the ceremony show their kernel content. Their read
--     class is unchanged (tab.aggregate_read_class: record_type_version RECORD, the others GOVERNANCE). Nothing else
--     changes; a later migration that re-creates the function starts from this definition.
--   * tab.di_investigation_overview(token hash): the data-integrity investigations the session may read, for the
--     investigations screen. The application role reads none of the investigation tables (0410); this applies the rule of
--     their content (tab.record_read_problem: a governance reader, EBMR-TAB-020) and withholds every investigation about
--     the session's own person (tab.record_withheld, DI-50, F34), as tab.content_for_signing does for one record.
--   * tab.records_reader_problem(reader): who reads a record's retention and its holds on the retention screen: a
--     governance reader (tab.record_read_problem of a GOVERNANCE type) or a role that places holds, manages retention or
--     approves disposal (RECORD.LEGAL_HOLD, RECORD.RETENTION_MANAGE, RECORD.DISPOSAL_APPROVE); EBMR-TAB-020 otherwise.
--   * tab.record_retention(token hash, type, id): one record's retention as records.retention_of and records.open_blockers
--     give it (both run for the owner only since 0460), for such a reader; what an investigation about the reader's own
--     person withholds from them (its blockers, its holds, the refusals naming it; tab.withheld_from, DI-50) is left out.
--   * tab.legal_hold_overview(token hash): the legal holds in force, for such a reader (records.retention_hold is the
--     owner's since 0430; an investigation's own holds are not legal holds and are not listed).
--   * tab.disposal_aggregate_id(token, record key, true copy): the id of the disposal a RECORD_DISPOSAL_APPROVED signature
--     covers (records.approve_purge): the record key at its retain-until date (and the cited true copy), or null when the
--     record has no schedule or no date yet. Only the date: nothing of a hold or an investigation.
--     For the session behind the request only, a records reader as for tab.record_retention (EBMR-TAB-018, EBMR-TAB-020;
--     review P7G-5).

set local role ebmr_owner;

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
           -- Phase 7 slice 7g-3 (decision 0025; kernel 1300, 1336, 0720): the validation summary of the running release, the
           -- periodic evaluation pack, a record type version, the disposal of a record and the closure of a data-integrity
           -- investigation, each signed through the ceremony (VALIDATION_SUMMARY_APPROVE, EVALUATION_PACK_APPROVE, RECORDS_ACT).
           when 'validation_summary' then array['VALIDATION_SUMMARY_APPROVED']
           when 'evaluation_pack' then array['PERIODIC_EVALUATION_APPROVED']
           when 'record_type_version' then array['RECORD_TYPE_APPROVED']
           when 'record_disposal' then array['RECORD_DISPOSAL_APPROVED']
           when 'di_investigation' then array['DI_INVESTIGATION_CLOSED']
           else '{}'::text[]
         end
$$;

create function tab.di_investigation_overview(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, records, iam, pg_temp as $$
declare
  v_reader  tab.reader := tab.reader_of(p_token_hash);
  v_problem text := tab.record_read_problem(v_reader, 'di_investigation', null);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This session may not read di_investigation records: %s. [EBMR-TAB-020]', v_problem);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', d.id, 'reference', d.reference, 'status', d.status,
             'subject', coalesce((select p.legal_name from iam.person p where p.id = d.subject_person_id), '(unknown)'),
             'investigator', coalesce((select p.legal_name from iam.person p where p.id = d.investigator_person), '(unknown)'),
             'openedBy', coalesce((select p.legal_name from iam.person p where p.id = d.opened_by_person), '(unknown)'),
             'fromUs', ((extract(epoch from d.window_from) * 1000000)::bigint)::text,
             'toUs', ((extract(epoch from d.window_to) * 1000000)::bigint)::text,
             'concern', d.concern, 'qmsReference', d.qms_reference, 'conclusion', d.conclusion, 'remediation', d.remediation,
             'approvedBy', (select p.legal_name from iam.person p where p.id = d.approved_by_person),
             'links', coalesce((select jsonb_agg(jsonb_build_object('recordKey', l.record_key, 'source', l.link_source, 'note', l.note) order by l.record_key collate "C")
                                  from records.di_investigation_link l where l.investigation_id = d.id), '[]'::jsonb))
           order by d.investigation_no desc)
      from records.di_investigation_current d
     where not tab.record_withheld(v_reader, 'di_investigation', d.id::text)), '[]'::jsonb);
end
$$;

create function tab.records_reader_problem(p_reader tab.reader) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, pg_temp as $$
begin
  if tab.record_read_problem(p_reader, 'record_hold', null) is null
     or tab.role_may(p_reader.role_code, array['RECORD.LEGAL_HOLD', 'RECORD.RETENTION_MANAGE', 'RECORD.DISPOSAL_APPROVE']) then
    return null;
  end if;
  return format('the retention and holds of records are read by a governance reader or a role that places holds, manages retention or approves disposal; the role %s is none of these',
                p_reader.role_code);
end
$$;

create function tab.record_retention(p_token_hash text, p_aggregate_type text, p_aggregate_id text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, records, pg_temp as $$
declare
  v_reader   tab.reader := tab.reader_of(p_token_hash);
  v_problem  text := tab.records_reader_problem(v_reader);
  v_key      text := p_aggregate_type || ':' || p_aggregate_id;
  w          tab.withheld := tab.withheld_from(v_reader.person_id);
  v_refs     text[];
  v_ret      jsonb;
  v_blockers jsonb;
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This session may not read the retention of %s: %s. [EBMR-TAB-020]', v_key, v_problem);
  end if;
  v_refs := coalesce((select array_agg(d.reference) from records.di_investigation_current d where d.id::text = any (w.investigations)), '{}');
  v_blockers := coalesce((
    select jsonb_agg(jsonb_build_object('kind', b.blocker_kind, 'id', b.blocker_id, 'reference', b.reference, 'status', b.status, 'detail', b.detail,
                                        'blocksDisposal', b.blocks_disposal) order by b.since, b.blocker_id)
      from records.open_blockers(p_aggregate_type, p_aggregate_id) b
     where not (b.blocker_kind = 'DI_INVESTIGATION' and b.blocker_id::text = any (w.investigations))
       and not (b.blocker_kind = 'HOLD' and b.blocker_id::text = any (w.holds))), '[]'::jsonb);
  if not exists (select 1 from records.retention_schedule s where s.record_key = v_key) then
    return jsonb_build_object('recordKey', v_key, 'scheduled', false, 'retainUntil', null, 'status', null, 'purged', false, 'refusals', '[]'::jsonb,
                              'onHold', exists (select 1 from jsonb_array_elements(v_blockers) x where x ->> 'kind' = 'HOLD'), 'blockers', v_blockers);
  end if;
  v_ret := records.retention_of(p_aggregate_type, p_aggregate_id);
  return jsonb_build_object(
    'recordKey', v_key, 'scheduled', true, 'retainUntil', v_ret #>> '{effective,retainUntil}', 'status', v_ret #>> '{effective,status}',
    'purged', (v_ret ->> 'purged')::boolean,
    'onHold', exists (select 1 from jsonb_array_elements(v_blockers) x where x ->> 'kind' = 'HOLD'),
    'refusals', coalesce((select jsonb_agg(r) from jsonb_array_elements(v_ret -> 'refusals') r
                           where not exists (select 1 from unnest(v_refs) ref where strpos(r ->> 'detail', ref) > 0)), '[]'::jsonb),
    'blockers', v_blockers);
end
$$;

create function tab.legal_hold_overview(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, records, iam, pg_temp as $$
declare
  v_reader  tab.reader := tab.reader_of(p_token_hash);
  v_problem text := tab.records_reader_problem(v_reader);
begin
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This session may not read the legal holds: %s. [EBMR-TAB-020]', v_problem);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', h.id, 'recordKey', h.record_key, 'kind', h.kind, 'reason', h.reason, 'reference', h.reference,
                                        'placedBy', coalesce((select p.legal_name from iam.person p where p.id = h.placed_by_person), '(unknown)'),
                                        'us', ((extract(epoch from h.recorded_at) * 1000000)::bigint)::text)
                     order by h.recorded_at desc, h.id)
      from records.retention_hold h
     where h.kind = 'LEGAL' and not exists (select 1 from records.retention_hold_release r where r.hold_id = h.id)), '[]'::jsonb);
end
$$;

create function tab.disposal_aggregate_id(p_token_hash text, p_record_key text, p_true_copy uuid) returns text
language plpgsql stable security definer set search_path = pg_catalog, tab, records, pg_temp as $$
declare
  v_reader  tab.reader := tab.reader_of(p_token_hash);
  v_problem text := tab.records_reader_problem(v_reader);
  v_sched   records.retention_schedule%rowtype;
  v_until   text;
begin
  -- For the session behind the request only (P7G-5), as the other retention reads of this migration.
  if v_problem is not null then
    raise exception using errcode = 'P0001', message = format('This session may not read the retention of records: %s. [EBMR-TAB-020]', v_problem);
  end if;
  select * into v_sched from records.retention_schedule s where s.record_key = p_record_key;
  if not found then
    return null;
  end if;
  v_until := records.compute_effective_retention(v_sched.id) ->> 'retainUntil';
  return case when v_until is null then null else p_record_key || '@' || v_until || coalesce('@' || p_true_copy::text, '') end;
end
$$;

revoke all on function tab.di_investigation_overview(text), tab.records_reader_problem(tab.reader), tab.record_retention(text, text, text),
                       tab.legal_hold_overview(text), tab.disposal_aggregate_id(text, text, uuid) from public;
grant execute on function tab.di_investigation_overview(text), tab.record_retention(text, text, text), tab.legal_hold_overview(text),
                          tab.disposal_aggregate_id(text, text, uuid) to ebmr_app;

reset role;
