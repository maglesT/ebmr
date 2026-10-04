/**
 * What the SQL mutation run covers: the database-enforced guards, grouped with the test files that must detect a change
 * to them. Build outline 9.1 asks for at least 90 % on guards, signature invalidation, limits, rounding, flow validation
 * and release gating.
 *
 * The first nine groups are the Phase 1 kernel's. The others are Phase 2's: the guards of recipe-core (MBR life cycle,
 * market authorisation and issue, the execution store) and of the tablets server (devices, the evidence listener, read
 * gates, sessions, the designer), plus the kernel and site-services functions added or redefined since the Phase 1 exit
 * (kernel 0800-1020, site-services 0600-0700). The last five groups are the Phase 2 exit follow-ups' new guards
 * (recipe-core 0326-0337, tablets 0500-0590); a follow-up that redefined a function already in a group (recipe-core
 * 0327, 0329, 0331, 0333; tablets 0500, 0510, 0530, 0550, 0560) left it there, with the test file of the new definition
 * added where the group's tests did not reach it (execution-state-binding, evidence-source-and-entries, signed-content),
 * and a follow-up's new function that belongs to an existing group's subject joined it (kernel 1020 to signing, tablets
 * 0530 and 0560 to read-authorisation).
 * Each group names the narrowest test files that test its functions at database level; a file under
 * apps/tablets-server/test runs in the Vitest `server` project, any other in `db`. Functions that only read or format
 * (no refusal, check or decision) are left out: recipe.json_pick and recipe.checklist_answers of recipe-core 0330 too.
 */
export interface Target {
  group: string;
  /** Functions to mutate (their last definition across all migrations is used). */
  functions: string[];
  /** Test files (relative to the repository root) that must detect each mutant. */
  tests: string[];
  /** Score the group must reach (per cent). */
  threshold: number;
}

const k = (f: string) => `packages/kernel/test/${f}`;
const r = (f: string) => `packages/recipe-core/test/${f}`;
const s = (f: string) => `apps/tablets-server/test/${f}`;
const site = (f: string) => `packages/site-services/test/${f}`;

export const TARGETS: Target[] = [
  {
    group: 'audit-trail',
    functions: ['kernel.begin_command', 'kernel.set_actor_context', 'kernel.actor_context_validated', 'kernel.current_actor',
                'kernel.append_audit_event', 'kernel.audit_row_change', 'kernel.reject_mutation', 'kernel.audit_triggers_ok',
                'kernel.verify_chain', 'kernel.verify_all_chains', 'kernel.is_blank'],
    tests: [k('audit/audit-trail.test.ts'), k('audit/actor-context.test.ts'), k('audit/verification.test.ts'), k('identity/attribution.test.ts'),
            k('security/definer-hardening.test.ts'), k('records/true-copy.test.ts'), k('audit/visible-reason.test.ts')],
    threshold: 90,
  },
  {
    group: 'actor-validation',
    functions: ['kernel.validate_actor_context'],
    tests: [k('identity/attribution.test.ts'), k('identity/devices-sessions.test.ts'), k('identity/generic.test.ts'), k('identity/access.test.ts')],
    threshold: 90,
  },
  {
    group: 'signing',
    functions: ['esig.required_components', 'esig.component_problem', 'esig.check_independence', 'esig.check_witness',
                'esig.create_challenge', 'esig.sign', 'esig.signature_problem', 'esig.assert_signature', 'esig.aggregate_id_problem',
                'esig.signature_state_problem', 'platform.transition_signature_check',
                // Kernel 1020 (F37): the per-record signing lock, taken only in READ COMMITTED (EBMR-ESIG-015).
                'esig.aggregate_lock'],
    tests: [k('esig/signing.test.ts'), k('esig/sessions.test.ts'), k('esig/independence.test.ts'), k('esig/catalogue.test.ts'),
            k('esig/platform-hook.test.ts'), k('esig/invalidation.test.ts'), k('integration/wiring.test.ts'), k('esig/isolation.test.ts')],
    threshold: 90,
  },
  {
    group: 'signature-invalidation',
    functions: ['esig.content_changed', 'esig.on_signed_content_change', 'esig.signature_guard', 'esig.signature_sealed_check', 'esig.challenge_guard'],
    tests: [k('esig/invalidation.test.ts'), k('esig/integrity.test.ts'), k('esig/signing.test.ts')],
    threshold: 90,
  },
  {
    group: 'segregation-and-grants',
    functions: ['iam.check_static_segregation', 'iam.role_grant_guard', 'iam.role_permission_guard', 'iam.request_role_grant', 'iam.decide_role_grant',
                'iam.check_role_permission_addition', 'iam.decide_role_permission'],
    tests: [k('identity/access.test.ts'), k('identity/accounts.test.ts'), k('identity/generic.test.ts'), k('integration/authorization.test.ts')],
    threshold: 90,
  },
  {
    group: 'authentication-events',
    functions: ['iam.consume_auth_event', 'iam.use_auth_event_for_command', 'iam.auth_event_guard', 'iam.session_guard', 'iam.open_session',
                'iam.lock_auth_event'],
    tests: [k('identity/attribution.test.ts'), k('identity/devices-sessions.test.ts'), k('identity/credentials.test.ts'), k('esig/sessions.test.ts')],
    threshold: 90,
  },
  {
    group: 'retention-and-purge',
    functions: ['records.approve_purge', 'records.purge', 'records.disposal_refusals', 'records.insert_only_trigger',
                'records.create_retention_schedule'],
    tests: [k('records/retention-purge.test.ts')],
    threshold: 90,
  },
  {
    group: 'site-values-and-policies',
    functions: ['market.assess_site_value', 'market.set_site_value', 'market.policy_pin_guard', 'market.policy_version_guard',
                'market.pin_policies_for_batch', 'market.apply_policy_tightening', 'market.at_least_as_strict', 'market.criteria_cover',
                'market.loosening_basis', 'market.same_value'],
    tests: [k('market/site-values.test.ts'), k('market/policy.test.ts'), k('market/engine.test.ts'), k('market/rule-tables.test.ts')],
    threshold: 90,
  },
  {
    group: 'protected-numbers',
    functions: ['continuity.next_counter_value', 'continuity.reserve_counter_ceiling', 'continuity.after_restore',
                'continuity.approve_restore_event', 'continuity.restore_event_is_approved', 'continuity.plan_sequence_moves',
                'continuity.secure_identifiers', 'continuity.prepare_counter_reservation', 'continuity.counter_scope',
                'continuity.guard_identifiers_secured', 'continuity.compare_external_anchors', 'continuity.verify_external_anchors'],
    tests: [k('continuity/numbers.test.ts'), k('continuity/restore.test.ts'), k('continuity/anchors.test.ts'),
            'packages/site-services/test/batch-number-register.test.ts'],
    threshold: 90,
  },

  // ---- Phase 2: recipe-core, MBR life cycle (sql 0100-0150, 0290, 0301) -------------------------------------------
  {
    group: 'mbr-lifecycle',
    functions: ['recipe.require_actor', 'recipe.canonical_batch_sizes', 'recipe.content_family_problem', 'recipe.assert_draft',
                'recipe.mbr_version_guard', 'recipe.mbr_content_guard', 'recipe.mbr_draft_entry_guard', 'recipe.mbr_risk_link_guard',
                'recipe.validator_problems', 'recipe.mbr_evidence_guard', 'recipe.mbr_content_after', 'recipe.current_evidence',
                'recipe.evidence_status', 'recipe.version_was_approved', 'recipe.editors_since_draft', 'recipe.mbr_version_content',
                'recipe.baseline_versions', 'recipe.registered_ranges', 'recipe.registered_changes', 'recipe.process_impact',
                'recipe.payload_signer', 'recipe.guard_content_present', 'recipe.guard_validator_passed', 'recipe.guard_evidence_complete',
                'recipe.guard_change_record_linked', 'recipe.guard_critical_elements_risk_assessed', 'recipe.guard_prepared_by_author',
                'recipe.guard_signed_in_state', 'recipe.guard_checker_independent', 'recipe.checker_may_approve',
                'recipe.guard_approver_independent', 'recipe.guard_regulatory_confirmed', 'recipe.guard_effective_date_set',
                'recipe.guard_review_due_set', 'recipe.guard_change_control_complete', 'recipe.guard_registered_ranges_kept',
                'recipe.guard_draft_entry_recorded', 'recipe.guard_never_authorised', 'recipe.create_version', 'recipe.derive_version',
                'recipe.save_content', 'recipe.set_draft_attributes', 'recipe.link_risk_assessment', 'recipe.unlink_risk_assessment',
                'recipe.record_evidence', 'recipe.return_to_draft', 'recipe.record_change_record', 'recipe.inv04_violations',
                'recipe.approved_content_violations'],
    tests: [r('lifecycle/approval.test.ts'), r('lifecycle/change-control.test.ts'), r('lifecycle/audit-reason.test.ts'),
            r('lifecycle/machine.test.ts'), r('lifecycle/authorization.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: recipe-core, market authorisation, batch issue, periodic review (sql 0160-0180, 0250, 0290) --------
  {
    group: 'market-authorisation-and-issue',
    functions: ['recipe.market_authorisation_content', 'recipe.canonical_cells', 'recipe.authorisation_cell_insert_guard',
                'recipe.authorisation_cell_update_guard', 'recipe.propose_market_authorisation', 'recipe.require_own_reason',
                'recipe.end_open_cells', 'recipe.activate_market_authorisation', 'recipe.withdraw_market_authorisation',
                'recipe.retire_version', 'recipe.guard_no_open_authorisation', 'recipe.guard_in_flight_dispositioned',
                'recipe.version_state_at', 'recipe.valid_cells', 'recipe.select_version_for_issue', 'recipe.stub_batch_guard',
                'recipe.batch_mbr_pin_guard', 'recipe.build_control_recipe', 'recipe.control_recipe_guard',
                'recipe.in_flight_disposition_guard', 'recipe.create_stub_batch', 'recipe.issue_stub_batch', 'recipe.set_stub_batch_status',
                'recipe.record_in_flight_disposition', 'recipe.verify_control_recipe', 'recipe.record_periodic_review', 'recipe.review_due',
                'recipe.overdue_reviews', 'recipe.inv01_violations', 'recipe.inv02_violations', 'recipe.inv17_violations'],
    tests: [r('lifecycle/market.test.ts'), r('lifecycle/issue.test.ts'), r('lifecycle/selection.property.test.ts'),
            r('lifecycle/review-inventory.test.ts'), r('lifecycle/audit-reason.test.ts'), r('lifecycle/concurrency.test.ts'),
            r('lifecycle/authorization.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: recipe-core, execution store: the commands (sql 0210, 0240, 0270, 0295, 0298, 0299) ----------------
  {
    group: 'execution-commands',
    functions: ['recipe.execution_actor', 'recipe.require_command_permission', 'recipe.execution_marker', 'recipe.assert_marker',
                'recipe.lock_execution', 'recipe.check_state', 'recipe.check_issued_state', 'recipe.append_execution',
                'recipe.issue_execution', 'recipe.check_engine_roles', 'recipe.role_evaluation_problem',
                'recipe.execution_attribution_check', 'recipe.insert_contents', 'tab.engine_roles'],
    tests: [s('execution/store.test.ts'), s('execution/db-guards-roles.test.ts'), s('execution/db-guards-issuer.test.ts'),
            s('execution/db-guards-values.test.ts'), r('execution/sql-guards.test.ts'), r('lifecycle/authorization.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: recipe-core, execution store: what a row's state may hold (sql 0300, 0303; recipe.row_step_key's
  //      overload of 0327, which the exception-source check reads, tested by exception-source-sql.test.ts) ------------
  {
    group: 'execution-state-binding',
    functions: ['recipe.execution_state_binding_check', 'recipe.new_instance_problem', 'recipe.signature_change_problem',
                'recipe.row_step_key', 'recipe.execution_recorded_state_check', 'recipe.sweep_state_problem',
                'recipe.kept_records_problem', 'recipe.members_changed'],
    tests: [r('execution/kept-records-sql.test.ts'), s('execution/evidence-source.test.ts'), r('execution/exception-source-sql.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: evidence source, room, entries and identifiers (recipe-core 0300, 0313, 0317; tablets 0300-0390;
  //      tab.device_entry_readings_check as tablets 0500 and 0510 redefined it: a stale weighing's named readings,
  //      tested past the server in db-guards-stale-row.test.ts) ---------------------------------------------------------
  {
    group: 'evidence-source-and-entries',
    functions: ['recipe.execution_source_room_check', 'recipe.step_room_problem', 'recipe.execution_entry_data_check',
                'recipe.entry_data_problem', 'recipe.execution_container_entry_check', 'recipe.new_container_problem',
                'tab.device_entry_readings_check', 'tab.entry_identifier_problem', 'tab.entry_identifiers_check',
                'tab.state_entry_identifier_problem', 'tab.state_container_identifier_problem', 'tab.state_entry_identifiers_check'],
    tests: [r('execution/entry-data-sql.test.ts'), s('execution/evidence-source.test.ts'), s('execution/evidence-source-room.test.ts'),
            s('execution/db-guards-entry-identifiers.test.ts'), s('execution/db-guards-stale-row.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: recipe-core, execution store: step order, acts, status, own node events (sql 0307, 0308, 0311, 0312,
  //      0316, 0320) ------------------------------------------------------------------------------------------------
  {
    group: 'execution-steps-and-order',
    functions: ['recipe.execution_step_order_check', 'recipe.step_order_problem', 'recipe.flow_left_problem', 'recipe.frames_fit',
                'recipe.step_once_finished', 'recipe.completion_mark_problem', 'recipe.stage_sign_off_problem', 'recipe.flow_tree_visit',
                'recipe.flow_within', 'recipe.execution_step_acts_check', 'recipe.minimum_duration_problem', 'recipe.flow_reaches',
                'recipe.same_sub_lots', 'recipe.blocking_exceptions_problem', 'recipe.hold_release_problem', 'recipe.shared_constructs',
                'recipe.execution_step_status_check', 'recipe.step_status_problem', 'recipe.execution_own_node_events_check',
                'recipe.own_node_event_problem', 'recipe.flow_node_left', 'recipe.flow_content_left', 'recipe.flow_body',
                'recipe.execution_stage_summary_check', 'recipe.stage_sign_off_shape_problem'],
    tests: [r('execution/step-order-sql.test.ts'), r('execution/step-acts-sql.test.ts'), r('execution/step-status-sql.test.ts'),
            r('execution/own-node-events-sql.test.ts'), r('execution/stage-summary-sql.test.ts'), s('execution/db-guards-step-order.test.ts'),
            s('execution/db-guards-step-acts.test.ts'), s('execution/db-guards-stage-sign-off.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: recipe-core, execution store: the system's own facts and time (sql 0280, 0299, 0304) ---------------
  {
    group: 'system-facts-and-time',
    functions: ['recipe.execution_system_fact_check', 'recipe.time_fact_problem', 'recipe.node_event_problem', 'recipe.time_constraint_of',
                'recipe.time_ends', 'recipe.time_start_us', 'recipe.time_blocked_steps', 'recipe.flow_anchor', 'recipe.flow_node_of',
                'recipe.duration_us', 'recipe.clock_regression_record', 'recipe.created_by_system', 'recipe.is_system_fact'],
    tests: [r('execution/system-facts-sql.test.ts'), s('execution/system-facts.test.ts'), s('execution/system-facts-bookkeeping.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: recipe-core, exceptions, dispositions and hold-point decisions (sql 0270, 0295, 0298, 0305, 0306,
  //      0309) ------------------------------------------------------------------------------------------------------
  {
    group: 'exceptions-and-dispositions',
    functions: ['recipe.check_exception_changes', 'recipe.operator_exception_record', 'recipe.check_disposition_proposal',
                'recipe.check_hold_point_decision', 'recipe.check_hold_point_changes', 'recipe.check_disposition_state',
                'recipe.propose_disposition', 'recipe.propose_hold_point_decision', 'recipe.correction_needs_approval'],
    tests: [r('execution/sql-guards.test.ts'), s('execution/db-guards-dispositions.test.ts'), s('execution/db-guards-values.test.ts'),
            s('execution/db-guards-proposal-race.test.ts'), s('execution/signed-content-hold-point.test.ts'),
            s('execution/db-guards-corrections.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: recipe-core, limit verdicts and the limit exceptions they raise (sql 0305) --------------------------
  {
    group: 'limit-exceptions',
    functions: ['recipe.limit_bound_check', 'recipe.limit_reading', 'recipe.limit_value', 'recipe.limit_value_type_problem',
                'recipe.limit_exception_record', 'recipe.limit_instance', 'recipe.limit_mark_problem', 'recipe.limit_verdicts',
                'recipe.limit_exceptions_problem', 'recipe.loop_endpoint_waiting', 'recipe.loop_exit_candidates', 'recipe.written_decimals',
                'recipe.decimal_exponent', 'recipe.mbr_member', 'recipe.frames_head'],
    tests: [r('execution/sql-guards.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: who may verify, disposition or witness: involvement and independence (recipe-core 0210, 0306, 0310,
  //      0315) ------------------------------------------------------------------------------------------------------
  {
    group: 'involvement-and-independence',
    functions: ['recipe.check_verifier', 'recipe.step_involvement', 'recipe.recorded_involvement', 'recipe.exception_raising_steps',
                'recipe.command_step_key', 'recipe.execution_disposition_involvement_check', 'recipe.execution_rule_violations',
                'recipe.execution_violations', 'recipe.next_step_started'],
    tests: [s('execution/db-guards-disposition-involvement.test.ts'), s('execution/store.test.ts'), s('execution/signing.test.ts'),
            r('execution/sql-guards.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: recipe-core, weighing net, label, total and counted item (sql 0321-0323) ----------------------------
  {
    group: 'weighing',
    functions: ['recipe.weighing_net_problem', 'recipe.execution_weighing_net_check', 'recipe.weighing_label_problem',
                'recipe.block_total_problem', 'recipe.weighing_totals_problem', 'recipe.execution_weighing_record_check',
                'recipe.mass_unit_class', 'recipe.phase_records', 'recipe.weighing_item_problem', 'recipe.execution_weighing_item_check'],
    tests: [s('execution/db-guards-weighing-net.test.ts'), s('execution/db-guards-weighing-record.test.ts'), r('execution/weighing-item-sql.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: what a signature covers: the signed-content providers and the signatures a row needs (recipe-core
  //      0270, 0295-0297, 0304, 0319; recipe.step_check_meanings as 0333 redefined it, the witness only while one is
  //      possible, tested through the store in witness-without-printout.test.ts) --------------------------------------
  {
    group: 'signed-content',
    functions: ['recipe.execution_content_of', 'recipe.stage_summary_of', 'recipe.canonical_stage_summary', 'recipe.stage_summary_content',
                'recipe.stage_frames_within', 'recipe.hold_point_content_of', 'recipe.exception_content_of', 'recipe.content_frames',
                'recipe.current_proposal', 'recipe.current_decision', 'recipe.step_signature_meanings', 'recipe.step_check_meanings',
                'recipe.check_signatures', 'recipe.step_instance_of', 'recipe.step_instance_number', 'recipe.flow_numbering_visit'],
    tests: [s('execution/signed-content.test.ts'), s('execution/signed-content-meanings.test.ts'), s('execution/signed-content-hold-point.test.ts'),
            s('execution/signed-content-stage-summary.test.ts'), s('execution/db-guards-signatures.test.ts'),
            s('execution/db-guards-signature-freshness.test.ts'), s('execution/db-guards-corrections.test.ts'),
            s('execution/db-guards-stage-summary.test.ts'), r('execution/stage-summary-sql.test.ts'), r('execution/system-facts-sql.test.ts'),
            s('execution/witness-without-printout.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: sandbox installation, TEST- labels, test packages and test batches (kernel 0800, 0810, 1000;
  //      recipe-core 0210, 0240, 0318; tablets 0001, 0150, 0200) ----------------------------------------------------
  {
    group: 'sandbox-and-import',
    functions: ['sandbox.guard_installation', 'kernel.installation_kind', 'sandbox.assert_gmp_installation', 'sandbox.assert_sandbox_installation',
                'sandbox.identifier_problem_for', 'sandbox.assert_identifier_allowed', 'sandbox.guard_identifier', 'sandbox.batch_issue_problem_for',
                'sandbox.assert_batch_issue_allowed', 'sandbox.watermark', 'iam.bootstrap_installation', 'recipe.import_test_package',
                'recipe.package_header_problem', 'recipe.test_package_header_check', 'recipe.begin_issue', 'tab.register_sandbox_lot',
                'tab.mbr_test_package_export_guard', 'tab.record_test_package_export', 'tab.mark_demo_installation', 'tab.is_demo_installation'],
    tests: [k('sandbox/installation.test.ts'), k('sandbox/identifiers.test.ts'), k('sandbox/bypass.test.ts'), k('sandbox/bootstrap.test.ts'),
            k('sandbox/provision.test.ts'), k('sandbox/watermark.test.ts'), s('execution/import-db-guard.test.ts'),
            s('execution/db-guards-package-header.test.ts'), s('execution/store.test.ts'), s('execution/commands.test.ts'),
            s('designer/package-publish.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: tablets, gateway keys, instruments and readings: ingest, proof, age, claim (sql 0250-0330, 0360) ----
  {
    group: 'device-readings',
    functions: ['tab.gateway_key_guard', 'tab.gateway_instrument_guard', 'tab.enrol_gateway_key', 'tab.revoke_gateway_key',
                'tab.bind_instrument', 'tab.end_instrument_binding', 'tab.with_reason_context', 'tab.bind_gateway_session',
                'tab.resolve_gateway_session', 'tab.actor_gateway_key', 'tab.record_gateway_refusal', 'tab.ed25519_pow',
                'tab.ed25519_decode', 'tab.ed25519_verify', 'tab.reading_signature_valid', 'tab.upload_wait_signature_valid',
                'tab.reading_canonical_text', 'tab.raw_weight_interpretation', 'tab.device_reading_problem', 'tab.device_reading_proof',
                'tab.ingest_reading', 'tab.claim_readings', 'tab.alert_claim_refusal', 'tab.alert_refused_claim'],
    tests: [s('devices/ingest.test.ts'), s('devices/reading-proof.test.ts'), s('devices/reading-age.test.ts'),
            s('devices/reading-age-policy.test.ts'), s('devices/claim.test.ts'), s('devices/claim-room.test.ts'),
            s('devices/gateway-role.test.ts'), s('devices/refused-weighing-readings.test.ts'), s('devices/stale-weighing-readings.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: tablets, the evidence listener's runs and ticks and what they vouch for (sql 0350) -------------------
  {
    group: 'evidence-listener',
    functions: ['tab.begin_listener_run', 'tab.end_listener_run', 'tab.record_listener_tick', 'tab.listener_attested_from'],
    tests: [s('devices/listener-watch.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: tablets, gateway contact, heartbeats, scale readiness and the manual-weighing gate (sql 0310-0350).
  //      devices/manual-weighing-interference.test.ts also tests these, but takes about 330 s alone: too slow to run
  //      for each mutant; its cases are the model for kill tests that need no real waiting. ----------------------------
  {
    group: 'manual-weighing-gate',
    functions: ['tab.record_gateway_api_contact', 'tab.record_gateway_api_answer', 'tab.record_heartbeat', 'tab.record_heartbeat_receipt',
                'tab.note_contact_seen', 'tab.lock_scale_rooms', 'tab.lock_gateway_rooms', 'tab.chain_refusal_held',
                'tab.scale_offline_reason_at', 'tab.scale_status', 'tab.manual_path_verdict', 'tab.manual_weighing_scales',
                'tab.manual_weighing_check'],
    tests: [s('devices/manual-weighing-gate.test.ts'), s('devices/scale-readiness.test.ts'), s('devices/room-scales.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: tablets, read gates on signing content, signatures and the audit trail (sql 0410-0490; 0530 and 0560:
  //      the person an investigation is about, the chain verification, the entries counted for that person) ----------
  {
    group: 'read-authorisation',
    functions: ['tab.reader_of', 'tab.role_may', 'tab.record_read_problem', 'tab.signing_preview_problem_for', 'tab.content_for_signing',
                'tab.record_content_for_signing', 'tab.record_signatures', 'tab.signatures_of', 'tab.audit_chain_class',
                'tab.audit_registry_value', 'tab.mbr_content_saved_role', 'tab.aggregate_ref_read_class', 'tab.withheld_from',
                'tab.chain_is_about', 'tab.entry_withheld', 'tab.chain_listed', 'tab.chain_read_problem', 'tab.audit_chains',
                'tab.audit_events', 'tab.audit_registry_chains', 'tab.audit_headless_chains', 'tab.audit_chain_length',
                'tab.record_withheld', 'tab.registry_chains_of', 'tab.audit_verify_chain', 'tab.partly_withheld_chains'],
    tests: [s('audit/read-authorisation.test.ts'), s('esig/read-authorisation.test.ts'), s('audit/view-integrity.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: tablets, sessions, roles bound to them and attribution (sql 0001, 0100, 0400, 0480) ------------------
  {
    group: 'tablets-sessions',
    functions: ['tab.set_session_role', 'tab.unbind_session', 'tab.consume_device_nonce', 'tab.set_attribution_method',
                'tab.session_role_withdrawn', 'tab.resolve_session', 'tab.end_withdrawn_session', 'tab.session_to_extend', 'tab.bind_session'],
    tests: [s('session/login.test.ts'), s('session/no-role-binding.test.ts'), s('session/role-withdrawn.test.ts'),
            s('session/device-nonce-limit.test.ts'), s('access/attribution.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: the designer's records: references, justifications, market set, content roles (tablets 0150, 0280;
  //      recipe-core 0324) ------------------------------------------------------------------------------------------
  {
    group: 'designer-guards',
    functions: ['tab.designer_actor', 'tab.reference_document_guard', 'tab.reference_document_retirement_guard', 'tab.record_reference_document',
                'tab.retire_reference_document', 'tab.designer_justification_guard', 'tab.record_designer_justification',
                'tab.mbr_content_market_guard', 'tab.validator_justification_guard', 'recipe.content_nodes', 'recipe.hold_point_release_roles',
                'recipe.content_role_problem', 'recipe.content_roles_check'],
    tests: [s('designer/references.test.ts'), s('designer/justification-binding.test.ts'), s('designer/market-set.test.ts'),
            s('designer/roles.test.ts'), s('execution/db-guards-content-roles.test.ts')],
    threshold: 90,
  },
  // ---- Kernel and site services since the Phase 1 exit: the site zone (kernel 0940, site-services 0700) -------------
  {
    group: 'site-zone',
    functions: ['iam.is_valid_site_zone', 'iam.assert_site_zone', 'iam.set_policy', 'site.site_zone_row_guard'],
    tests: [k('identity/site-zone-policy.test.ts'), k('identity/access.test.ts'), k('identity/credentials.test.ts'),
            site('batch-number-register.test.ts')],
    threshold: 90,
  },
  // ---- Kernel since the Phase 1 exit: a refused signing's own command, visible reason text, the shared terminal's
  //      secret change window (kernel 0950, 0960, 0990) -------------------------------------------------------------
  {
    group: 'signing-failure-and-reasons',
    functions: ['esig.signing_misuse', 'platform.guard_reason_given', 'iam.change_event_check'],
    tests: [k('esig/signing-failure-own-command.test.ts'), k('audit/visible-reason.test.ts'), k('platform/state-machine.test.ts'),
            k('identity/credentials.test.ts')],
    threshold: 90,
  },
  // ---- Kernel since the Phase 1 exit: who may signal backends, the listener login roles and their share (kernel 0970,
  //      0980) ------------------------------------------------------------------------------------------------------
  {
    group: 'connection-roles',
    functions: ['kernel.backend_signals_restricted', 'sandbox.apply_connect_policy', 'sandbox.mirror_application_privileges',
                'sandbox.segregation_problems', 'sandbox.direct_privileges', 'kernel.apply_listener_share'],
    tests: [k('security/backend-signals.test.ts'), k('security/listener-roles.test.ts'), k('sandbox/bypass.test.ts')],
    threshold: 90,
  },
  // ---- Site services: the batch-number register (sql 0600; not in the Phase 1 run) ---------------------------------
  {
    group: 'batch-number-register',
    functions: ['site.require_actor', 'site.render_batch_number', 'site.define_batch_number_rule', 'site.rule_in_force',
                'site.allocate_batch_number', 'site.register_external_batch_number', 'site.void_batch_number', 'site.batch_number_pattern',
                'site.recover_batch_number', 'site.batch_number_invariant_violations'],
    tests: [site('batch-number-register.test.ts')],
    threshold: 90,
  },

  // ---- Phase 2 exit follow-ups: a command from a stale screen is the refusal ENG-STALE, changes nothing and uses no
  //      scale reading; the readings a weighing names or uses are the stored ones (recipe-core 0326, EBMR-EXE-140;
  //      tablets 0510, 0520, 0590, EBMR-EXE-124; tab.device_entry_readings_check stays in evidence-source-and-entries) --
  {
    group: 'stale-commands-and-readings',
    functions: ['recipe.stale_command_problem', 'recipe.execution_stale_command_check', 'recipe.execution_stale_refusal_check',
                'tab.peek_weighing_readings', 'tab.stale_row_claims_check', 'tab.reading_use_stale_row_check',
                'tab.stale_named_readings_check', 'tab.used_readings_check'],
    tests: [s('execution/db-guards-stale-row.test.ts'), s('execution/db-guards-stale-row-commit.test.ts'),
            s('execution/db-guards-used-readings.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2 exit follow-ups: an exception a row raises is recorded at the step the engine raises it at (recipe-core
  //      0327, EBMR-EXE-044; its exception_raising_steps and execution_rule_violations stay in
  //      involvement-and-independence, row_step_key in execution-state-binding) -------------------------------------
  {
    group: 'exception-source',
    functions: ['recipe.exception_at_construct', 'recipe.exception_at_step', 'recipe.source_names_instance', 'recipe.provenance_names_any',
                'recipe.step_computes', 'recipe.change_reaches_step', 'recipe.exception_source_problem',
                'recipe.execution_exception_source_check'],
    tests: [r('execution/exception-source-sql.test.ts'), s('execution/db-guards-disposition-involvement.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2 exit follow-ups: an entry names only what its step's MBR node names, holds what its block builds and
  //      accepts, and meets its block version's data schema (recipe-core 0328, 0330, 0332; EBMR-EXE-126) --------------
  {
    group: 'entry-references-and-schema',
    functions: ['recipe.node_names', 'recipe.entry_reference_problem', 'recipe.execution_entry_references_check',
                'recipe.status_check_ids', 'recipe.clearance_items', 'recipe.checklist_answer_problem', 'recipe.lot_usability_problem',
                'recipe.entry_block_problem', 'recipe.execution_entry_block_check', 'recipe.block_schema_problem',
                'recipe.block_data_schema_of', 'recipe.block_schema_unknown_member', 'recipe.entry_schema_problem',
                'recipe.execution_entry_schema_check'],
    tests: [r('execution/entry-data-sql.test.ts'), s('execution/db-guards-entry-identifiers.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2 exit follow-ups: once a witness is no longer possible, the later review and its WITNESS_LATE; the
  //      times and the witness window that decides it are the record's (recipe-core 0333, 0334; EBMR-EXE-141 to 146;
  //      recipe.step_check_meanings stays in signed-content) ---------------------------------------------------------
  {
    group: 'late-witness-and-step-times',
    functions: ['recipe.witness_possible', 'recipe.late_check_record', 'recipe.execution_late_check', 'recipe.step_time_problem',
                'recipe.execution_step_times_check', 'recipe.witness_window_problem', 'recipe.execution_witness_window_check'],
    tests: [r('execution/late-witness-sql.test.ts'), r('execution/step-times-sql.test.ts'), s('execution/witness-without-printout.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2 exit follow-ups: a row records its command, evidence and refusal as the engine and the server build
  //      them; a test batch pins exactly the engine policy and is issued only with a request its MBR accepts
  //      (recipe-core 0335, 0336, 0337; EBMR-EXE-126) ---------------------------------------------------------------
  {
    group: 'execution-row-shape',
    functions: ['recipe.command_shape', 'recipe.block_schema_container_problem', 'recipe.command_member_problem',
                'recipe.row_evidence_problem', 'recipe.execution_row_problem', 'recipe.execution_row_shape_check',
                'recipe.engine_policy_problem', 'recipe.execution_policy_shape_check', 'recipe.refusal_problem',
                'recipe.execution_row_refusal_check', 'recipe.issue_request_problem', 'recipe.execution_issue_request_check'],
    tests: [r('execution/entry-data-sql.test.ts'), s('execution/db-guards-row-shape.test.ts')],
    threshold: 90,
  },
];
