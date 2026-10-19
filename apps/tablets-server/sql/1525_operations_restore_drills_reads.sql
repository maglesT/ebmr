-- Tablets: the restore procedure, the drills and the installation hardening checks read on the operations screens, and
-- the second person's approval of a restore signed through the ceremony (Phase 7 slice 7g, work package 2; decision
-- 0025; controls DI-45, DI-18, DI-37).
--
-- Handbook: modules/tablets-server.md
--
-- Tablets 0450 hides the restore events from the application role (GOVERNANCE class: the chains a restore affected may
-- be a data-integrity investigation's). The restore screen reads them here, for the session behind the request, only in a
-- role that operates or approves a restore.
--
--   tab.restore_overview(token)    this database's incarnation and whether its identifiers are secured, every restore
--                                  event with its approvers, approvals, anchor comparison and completion, and the persons
--                                  who may be named as approvers (a live grant of a role holding CONTINUITY.RESTORE_APPROVE);
--                                  for a role holding CONTINUITY.RESTORE_OPERATE or CONTINUITY.RESTORE_APPROVE (EBMR-OPS-050)
--   tab.drill_overview(token)      the restore and upgrade drill records, the drill requests and the hardening checks; for a
--                                  role holding CONTINUITY.BACKUP_READ (kernel 1376) or PLATFORM.OPERATE (EBMR-OPS-051)
--   * tab.kernel_signing_meanings: CREATE OR REPLACE from its latest definition with restore_event (RESTORE_APPROVED,
--     kernel 0720: the named approver's own signature of the recorded restore, state RECORDED). Tablets 1491 (WP1), 1493
--     (WP3) and 1496 (WP4) each re-created it from 1479 too; as the highest of the four, this definition carries the
--     union of their additions (validation_summary, evaluation_pack, record_type_version, record_disposal,
--     di_investigation; market_policy_version, market_site_loosening; MATERIAL_DESTRUCTION_WITNESSED on material_lot),
--     so none is lost (signing-meanings-7g.test.ts). A later migration that re-creates it starts from this definition.
--
-- Messages: EBMR-OPS-050, EBMR-OPS-051.

set local role ebmr_owner;

create function tab.restore_overview(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, continuity, iam, pg_temp as $$
declare
  r tab.reader := tab.reader_of(p_token_hash);
begin
  if not tab.role_may(r.role_code, array['CONTINUITY.RESTORE_OPERATE', 'CONTINUITY.RESTORE_APPROVE']) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-OPS-050 %s neither operates nor approves a restore: the restore procedure is read by the system administrator and the approvers'' role (DI-45)', r.role_code);
  end if;
  return jsonb_build_object(
    'incarnation', continuity.current_incarnation(),
    'identifiersSecured', continuity.identifiers_secured(),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
        'restoreEventId', e.id, 'eventKind', e.event_kind, 'backupId', e.backup_id,
        'backupTakenAtUs', case when e.backup_taken_at is null then null else (extract(epoch from e.backup_taken_at) * 1000000)::bigint::text end,
        'restorePointUs', case when e.restore_point is null then null else (extract(epoch from e.restore_point) * 1000000)::bigint::text end,
        'performedAtUs', (extract(epoch from e.performed_at) * 1000000)::bigint::text,
        'reason', e.reason, 'changeReference', e.change_reference, 'operatorPersonId', e.operator_person_id,
        'operator', coalesce((select p.legal_name from iam.person p where p.id = e.operator_person_id), '(unknown)'),
        'approvers', (select coalesce(jsonb_agg(jsonb_build_object(
                         'personId', x.pid,
                         'legalName', coalesce((select p.legal_name from iam.person p where p.id = x.pid), '(unknown)'),
                         'approvedAtUs', (select (extract(epoch from a.recorded_at) * 1000000)::bigint::text from continuity.restore_event_approval a
                                           where a.restore_event_id = e.id and a.approver_person_id = x.pid)) order by x.ord), '[]'::jsonb)
                        from unnest(e.approver_person_ids) with ordinality as x (pid, ord)),
        'status', case when exists (select 1 from continuity.restore_completion c where c.restore_event_id = e.id) then 'COMPLETED'
                       when continuity.restore_event_is_approved(e.id) then 'APPROVED' else 'RECORDED' end,
        'contentHash', encode(e.content_hash, 'hex'),
        'discardedAnchorIds', (select coalesce(jsonb_agg(d::text order by d), '[]'::jsonb) from unnest(e.discarded_anchor_ids) d),
        'affectedChainKeys', to_jsonb(e.affected_chain_keys),
        'anchorComparison', (select coalesce(jsonb_agg(jsonb_build_object('anchorId', coalesce(c ->> 'anchor_id', '(none)'), 'status', c ->> 'status',
                                                                           'problems', coalesce(c -> 'problems', '[]'::jsonb))), '[]'::jsonb)
                               from jsonb_array_elements(e.anchor_comparison) c),
        'recordedAtUs', (extract(epoch from e.recorded_at) * 1000000)::bigint::text,
        'completedAtUs', (select (extract(epoch from c.recorded_at) * 1000000)::bigint::text from continuity.restore_completion c where c.restore_event_id = e.id),
        'moves', (select coalesce(jsonb_agg(jsonb_build_object('sequenceKey', b.sequence_key, 'sourceKind', b.source_kind, 'valueBefore', b.value_before::text,
                                                                'externalValue', b.external_value::text, 'valueAfter', b.value_after::text)
                                             order by b.sequence_key, b.id), '[]'::jsonb)
                    from continuity.sequence_bump b where b.restore_event_id = e.id))
        order by e.recorded_at desc, e.id)
      from (select * from continuity.restore_event order by recorded_at desc, id limit 50) e), '[]'::jsonb),
    'approverCandidates', coalesce((select jsonb_agg(jsonb_build_object('personId', q.id, 'legalName', q.legal_name) order by q.legal_name, q.id)
      from (select distinct p.id, p.legal_name
              from iam.role_grant g join iam.account a on a.id = g.account_id join iam.person p on p.id = a.person_id
             where p.status = 'ACTIVE' and a.status = 'ACTIVE' and a.kind = 'HUMAN'
               and iam.grant_held_at(g.status, g.decided_at, g.valid_from, g.valid_to, g.revoked_at, clock_timestamp())
               and tab.role_may(g.role_code, array['CONTINUITY.RESTORE_APPROVE'])) q), '[]'::jsonb));
end
$$;
revoke all on function tab.restore_overview(text) from public;
grant execute on function tab.restore_overview(text) to ebmr_app;

create function tab.drill_overview(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, tab, continuity, iam, pg_temp as $$
declare
  r tab.reader := tab.reader_of(p_token_hash);
begin
  if not tab.role_may(r.role_code, array['CONTINUITY.BACKUP_READ', 'PLATFORM.OPERATE']) then
    raise exception using errcode = 'P0001',
      message = format('EBMR-OPS-051 %s lacks CONTINUITY.BACKUP_READ: the drill records and hardening checks are read by the system administrator, the process owner and QA (DI-45)', r.role_code);
  end if;
  return jsonb_build_object(
    'restoreDrills', coalesce((select jsonb_agg(jsonb_build_object(
        'drillId', d.drill_id, 'sourceDatabase', d.source_database, 'restoredDatabase', d.restored_database, 'backupSha256', d.backup_sha256,
        'result', d.result, 'failures', d.failures, 'tablesCompared', d.tables_compared::text, 'tablesMatching', d.tables_matching::text,
        'chainsVerified', d.chains_verified::text, 'reportSha256', d.report_sha256, 'reportUri', d.report_uri,
        'startedAtUs', (extract(epoch from d.started_at) * 1000000)::bigint::text,
        'finishedAtUs', (extract(epoch from d.finished_at) * 1000000)::bigint::text,
        'recordedAtUs', (extract(epoch from d.recorded_at) * 1000000)::bigint::text) order by d.recorded_at desc, d.id)
      from (select * from continuity.restore_drill order by recorded_at desc, id limit 50) d), '[]'::jsonb),
    'upgradeDrills', coalesce((select jsonb_agg(jsonb_build_object(
        'drillId', u.drill_id, 'requestId', u.request_id, 'sourceDatabase', u.source_database, 'fromRelease', u.from_release, 'result', u.result,
        'failures', u.failures, 'tablesCompared', u.tables_compared::text, 'tablesChanged', u.tables_changed::text,
        'chainsVerified', u.chains_verified::text, 'migrationsApplied', u.migrations_applied::text, 'reportSha256', u.report_sha256,
        'reportUri', u.report_uri, 'recordedAtUs', (extract(epoch from u.recorded_at) * 1000000)::bigint::text) order by u.recorded_at desc, u.id)
      from (select * from continuity.upgrade_drill order by recorded_at desc, id limit 50) u), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object(
        'requestId', q.id, 'kind', q.kind, 'reason', q.reason, 'sourceDatabase', q.source_database,
        'by', coalesce((select p.legal_name from iam.person p where p.id = q.person_id), '(unknown)'),
        'recordedAtUs', (extract(epoch from q.recorded_at) * 1000000)::bigint::text) order by q.recorded_at desc, q.id)
      from (select * from continuity.drill_request order by recorded_at desc, id limit 50) q), '[]'::jsonb),
    'hardeningChecks', coalesce((select jsonb_agg(jsonb_build_object(
        'checkRunId', h.id, 'result', h.result, 'checks', h.checks, 'reportSha256', h.report_sha256, 'reason', h.reason,
        'by', coalesce((select p.legal_name from iam.person p where p.id = h.person_id), '(unknown)'),
        'recordedAtUs', (extract(epoch from h.recorded_at) * 1000000)::bigint::text) order by h.recorded_at desc, h.id)
      from (select * from continuity.hardening_check order by recorded_at desc, id limit 20) h), '[]'::jsonb));
end
$$;
revoke all on function tab.drill_overview(text) from public;
grant execute on function tab.drill_overview(text) to ebmr_app;

create or replace function tab.kernel_signing_meanings(p_aggregate_type text) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_aggregate_type
           when 'esig_stub' then array['PERFORMED', 'VERIFIED', 'WITNESSED', 'LOGBOOK_PERFORMED', 'LOGBOOK_DOUBLE_CHECKED', 'PREPARED', 'CHECKED', 'APPROVED']
           when 'batch_issue' then array['ISSUED']
           when 'batch_act' then array['VOID_AUTHORISED']
           when 'deviation' then array['DEVIATION_IMPACT_ASSESSED', 'DEVIATION_CONCLUDED', 'DEVIATION_CLOSED']
           when 'lot_test_result' then array['QC_RESULT_APPROVED']
           when 'qc_extra_testing' then array['QC_EXTRA_TESTING_DECIDED']
           -- Phase 7 slice 7g (WP4, tablets 1496): the witness of a recorded lot destruction signs the lot (site services
           -- 0712; IN-24 (a)) through the ceremony (LOT_DESTRUCTION_WITNESS); the performer's destroy then names the signature.
           when 'material_lot' then array['MATERIAL_LOT_RELEASED', 'MATERIAL_LOT_REJECTED', 'MATERIAL_LOT_STATUS_DECIDED', 'MATERIAL_DESTRUCTION_WITNESSED']
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
           -- Phase 7 slice 7g WP3 (kernel 0350, 0360): the approver's signature of a market policy or site-value loosening,
           -- signed before the change is made: market_policy_version <policy>@<n>@<position>, market_site_loosening; state PROPOSED.
           when 'market_policy_version' then array['POLICY_LOOSENING_APPROVED']
           when 'market_site_loosening' then array['SITE_VALUE_LOOSENING_APPROVED']
           -- Phase 7 slice 7g, work package 2 (kernel 0600, 0720; DI-45, DI-37): a named approver approves a recorded restore
           -- with their own RESTORE_APPROVED signature, restore_event <id>, state RECORDED (GOVERNANCE class).
           when 'restore_event' then array['RESTORE_APPROVED']
           else '{}'::text[]
         end
$$;


reset role;
