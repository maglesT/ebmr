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
 * The Phase 3 exit (decision 0009) added the last 22 groups, by area: every function added or replaced since dd66b59 in
 * kernel, site-services, recipe-core and tablets that is a guard, a limit, a signature or state check, a writer of GMP
 * data, or a helper whose result one of those decides on (recipe.planning_orders, a planning view, is left out). A
 * Phase 3 redefinition of a function already in a Phase 2 group left it there, with the Phase 3 test files that reach
 * the new definition added to the group.
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
            r('lifecycle/machine.test.ts'), r('lifecycle/authorization.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('master-data/formula.test.ts')],
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
                'recipe.overdue_reviews', 'recipe.inv01_violations', 'recipe.inv02_violations', 'recipe.inv17_violations',
                // recipe-core 0383 (defect D10): the activation and its cells only as the activation command writes them.
                'recipe.market_authorisation_activation_guard', 'recipe.authorisation_cell_activation_guard',
                'recipe.authorisation_cell_supersession_guard'],
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
            s('execution/db-guards-values.test.ts'), r('execution/sql-guards.test.ts'), r('lifecycle/authorization.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('execution/gmp-batch.test.ts'), r('lifecycle/gmp-issue.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: recipe-core, execution store: what a row's state may hold (sql 0300, 0303; recipe.row_step_key's
  //      overload of 0327, which the exception-source check reads, tested by exception-source-sql.test.ts) ------------
  {
    group: 'execution-state-binding',
    functions: ['recipe.execution_state_binding_check', 'recipe.new_instance_problem', 'recipe.signature_change_problem',
                'recipe.row_step_key', 'recipe.execution_recorded_state_check', 'recipe.sweep_state_problem',
                'recipe.kept_records_problem', 'recipe.members_changed',
                // recipe-core 0382 (defect D9): a recorded signature made invalid only where the engine does.
                'recipe.step_facts_changed', 'recipe.signature_invalidation_problem', 'recipe.execution_signature_invalidation_check'],
    tests: [r('execution/kept-records-sql.test.ts'), s('execution/evidence-source.test.ts'), r('execution/exception-source-sql.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('execution/db-guards-change-paths.test.ts'), s('execution/db-guards-hand-over.test.ts'), s('execution/gmp-batch.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: evidence source, room, entries and identifiers (recipe-core 0300, 0313, 0317; tablets 0300-0390;
  //      tab.device_entry_readings_check as tablets 0500 and 0510 redefined it: a stale weighing's named readings,
  //      tested past the server in db-guards-stale-row.test.ts) ---------------------------------------------------------
  {
    group: 'evidence-source-and-entries',
    functions: ['recipe.execution_source_room_check', 'recipe.step_room_problem', 'recipe.execution_entry_data_check',
                'recipe.entry_data_problem', 'recipe.execution_container_entry_check',
                'tab.device_entry_readings_check', 'tab.entry_identifier_problem', 'tab.entry_identifiers_check',
                'tab.state_entry_identifier_problem', 'tab.state_container_identifier_problem', 'tab.state_entry_identifiers_check'],
    tests: [r('execution/entry-data-sql.test.ts'), s('execution/evidence-source.test.ts'), s('execution/evidence-source-room.test.ts'),
            s('execution/db-guards-entry-identifiers.test.ts'), s('execution/db-guards-stale-row.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('blocks/dispensing/tb-01-gmp.test.ts'), s('execution/block-entries.test.ts')],
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
            s('execution/db-guards-step-acts.test.ts'), s('execution/db-guards-stage-sign-off.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('execution/db-guards-hand-over.test.ts'), s('execution/gmp-batch.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: recipe-core, execution store: the system's own facts and time (sql 0280, 0299, 0304) ---------------
  {
    group: 'system-facts-and-time',
    functions: ['recipe.execution_system_fact_check', 'recipe.time_fact_problem', 'recipe.node_event_problem', 'recipe.time_constraint_of',
                'recipe.time_ends', 'recipe.time_start_us', 'recipe.time_blocked_steps', 'recipe.flow_anchor', 'recipe.flow_node_of',
                'recipe.duration_us', 'recipe.clock_regression_record', 'recipe.created_by_system', 'recipe.is_system_fact'],
    tests: [r('execution/system-facts-sql.test.ts'), s('execution/system-facts.test.ts'), s('execution/system-facts-bookkeeping.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('execution/gmp-batch.test.ts')],
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
            s('execution/db-guards-corrections.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('execution/gmp-batch.test.ts')],
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
            r('execution/sql-guards.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('execution/db-guards-hand-over.test.ts'), s('execution/gmp-batch.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: recipe-core, weighing net, label, total and counted item (sql 0321-0323) ----------------------------
  {
    group: 'weighing',
    functions: ['recipe.weighing_net_problem', 'recipe.execution_weighing_net_check', 'recipe.weighing_label_problem',
                'recipe.block_total_problem', 'recipe.execution_weighing_record_check',
                'recipe.mass_unit_class', 'recipe.phase_records', 'recipe.execution_weighing_item_check'],
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
            s('execution/witness-without-printout.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('execution/db-guards-change-paths.test.ts'), s('execution/db-guards-hand-over.test.ts'), s('execution/gmp-batch.test.ts')],
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
                'tab.mbr_test_package_export_guard', 'tab.record_test_package_export', 'tab.mark_demo_installation', 'tab.is_demo_installation',
                // recipe-core 0384 (defect D14): how a refusal of package_header_problem names a JSON value.
                'recipe.json_value_described'],
    tests: [k('sandbox/installation.test.ts'), k('sandbox/identifiers.test.ts'), k('sandbox/bypass.test.ts'), k('sandbox/bootstrap.test.ts'),
            k('sandbox/provision.test.ts'), k('sandbox/watermark.test.ts'), s('execution/import-db-guard.test.ts'),
            s('execution/db-guards-package-header.test.ts'), s('execution/store.test.ts'), s('execution/commands.test.ts'),
            s('designer/package-publish.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            r('lifecycle/gmp-issue.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: tablets, gateway keys, instruments and readings: ingest, proof, age, claim (sql 0250-0330, 0360; 0702:
  //      a gateway key of small order is neither enrolled nor trusted, D16) ----------------------------------------------
  {
    group: 'device-readings',
    functions: ['tab.gateway_key_guard', 'tab.gateway_instrument_guard', 'tab.enrol_gateway_key', 'tab.revoke_gateway_key',
                'tab.bind_instrument', 'tab.end_instrument_binding', 'tab.with_reason_context', 'tab.bind_gateway_session',
                'tab.resolve_gateway_session', 'tab.actor_gateway_key', 'tab.record_gateway_refusal', 'tab.ed25519_pow',
                'tab.ed25519_decode', 'tab.ed25519_verify', 'tab.ed25519_small_order', 'tab.gateway_key_problem',
                'tab.reading_signature_valid', 'tab.upload_wait_signature_valid',
                'tab.reading_canonical_text', 'tab.raw_weight_interpretation', 'tab.device_reading_problem', 'tab.device_reading_proof',
                'tab.ingest_reading', 'tab.claim_readings', 'tab.alert_claim_refusal', 'tab.alert_refused_claim'],
    tests: [s('devices/ingest.test.ts'), s('devices/reading-proof.test.ts'), s('devices/reading-age.test.ts'),
            s('devices/reading-age-policy.test.ts'), s('devices/claim.test.ts'), s('devices/claim-room.test.ts'),
            s('devices/gateway-role.test.ts'), s('devices/refused-weighing-readings.test.ts'), s('devices/stale-weighing-readings.test.ts'),
            s('devices/gateway-key-order.test.ts')],
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
    tests: [s('audit/read-authorisation.test.ts'), s('esig/read-authorisation.test.ts'), s('audit/view-integrity.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('master-data/formula.test.ts')],
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
    tests: [r('execution/exception-source-sql.test.ts'), s('execution/db-guards-disposition-involvement.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('execution/gmp-batch.test.ts')],
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
    tests: [r('execution/entry-data-sql.test.ts'), s('execution/db-guards-entry-identifiers.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('blocks/reprocessing/db-guards.test.ts'), s('blocks/packaging/db-guards.test.ts'), s('blocks/granulation/db-guards.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2 exit follow-ups: once a witness is no longer possible, the later review and its WITNESS_LATE; the
  //      times and the witness window that decides it are the record's (recipe-core 0333, 0334; EBMR-EXE-141 to 146;
  //      recipe.step_check_meanings stays in signed-content) ---------------------------------------------------------
  {
    group: 'late-witness-and-step-times',
    functions: ['recipe.witness_possible', 'recipe.late_check_record', 'recipe.execution_late_check', 'recipe.step_time_problem',
                'recipe.execution_step_times_check', 'recipe.witness_window_problem', 'recipe.execution_witness_window_check'],
    tests: [r('execution/late-witness-sql.test.ts'), r('execution/step-times-sql.test.ts'), s('execution/witness-without-printout.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('execution/gmp-batch.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2 exit follow-ups: a row records its command, evidence and refusal as the engine and the server build
  //      them; a test batch pins exactly the engine policy and is issued only with a request its MBR accepts
  //      (recipe-core 0335, 0336, 0337; EBMR-EXE-126) ---------------------------------------------------------------
  {
    group: 'execution-row-shape',
    functions: ['recipe.command_shape', 'recipe.block_schema_container_problem', 'recipe.command_member_problem',
                'recipe.row_evidence_problem', 'recipe.execution_row_problem', 'recipe.execution_row_shape_check',
                'recipe.engine_policy_problem', 'recipe.execution_policy_shape_check',
                'recipe.execution_row_refusal_check', 'recipe.issue_request_problem', 'recipe.execution_issue_request_check'],
    tests: [r('execution/entry-data-sql.test.ts'), s('execution/db-guards-row-shape.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('execution/db-guards-hand-over.test.ts'), s('execution/db-guards-change-paths.test.ts'), s('execution/block-entries.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2 exit, SQL mutation defects (D11): the state engine's rows, whoever writes them: a history row is a
  //      published transition its state row records, and a state row commits only with its history row (kernel 0550,
  //      1110; EBMR-PLAT-072, 077, 078). Not in the Phase 1 run. -----------------------------------------------------
  {
    group: 'state-engine-rows',
    functions: ['platform.guard_state_row', 'platform.state_row_history_check'],
    tests: [k('platform/state-machine.test.ts')],
    threshold: 90,
  },

  // ---- Phase 3: plant equipment and areas: cleaning, calibration, instrument checks and use, utilities, campaigns,
  //     repair, area clearance and occupancy (recipe-core 0400, 0403, 0404, 0460, 0522) ----
  {
    group: 'plant-equipment-and-areas',
    functions: ['plant.is_blank', 'plant.cleaning_verification_guard', 'plant.cleaning_abandonment_guard',
                'plant.cleaning_method_guard', 'plant.clearance_verification_guard', 'plant.equipment_use_chain_guard',
                'plant.equipment_use_end_guard', 'plant.area_occupancy_chain_guard', 'plant.latest_cleaning',
                'plant.guard_cleaning_open', 'plant.guard_cleaning_verified', 'plant.guard_cleaning_abandoned',
                'plant.guard_equipment_use_open', 'plant.guard_equipment_no_use_open', 'plant.area_last_occupancy_event',
                'plant.guard_clearance_passed', 'plant.guard_area_occupancy_open', 'plant.guard_area_no_occupancy_open',
                'plant.fail', 'plant.move', 'plant.state_of', 'plant.equipment_by_code', 'plant.area_by_code',
                'plant.require_product', 'plant.dirty_since', 'plant.define_equipment_class', 'plant.define_area',
                'plant.define_equipment', 'plant.latest_event_of', 'plant.latest_calibration',
                'plant.calibration_valid_until', 'plant.equipment_fitness', 'plant.fitness_problems',
                'plant.record_calibration', 'plant.calibration_affected_batches', 'plant.record_instrument_check',
                'plant.instrument_use_assessment', 'plant.record_instrument_use', 'plant.record_utility_reading',
                'plant.assert_utility_usable', 'plant.open_campaign', 'plant.close_campaign', 'plant.campaign_check',
                'plant.lock_cleaning_target', 'plant.start_cleaning', 'plant.complete_cleaning', 'plant.verify_cleaning',
                'plant.abandon_cleaning', 'plant.cleaning_content', 'plant.equipment_use_assessment',
                'plant.start_equipment_use', 'plant.end_equipment_use', 'plant.latest_occupancy',
                'plant.required_clearance', 'plant.record_clearance', 'plant.verify_clearance',
                'plant.clearance_content', 'plant.start_area_occupancy', 'plant.end_area_occupancy',
                'plant.record_equipment_event', 'plant.repair_verification_guard', 'plant.repaired_event_verified_guard',
                'plant.open_failure', 'plant.record_repair', 'plant.verify_repair', 'plant.repair_content',
                'plant.utility_problem', 'plant.set_utility_feed_age', 'plant.utility_feed_max_age'],
    tests: [r('plant/equipment.test.ts'), r('plant/area.test.ts'), r('plant/machine.test.ts'), r('plant/status-blocks.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: output containers: closing, holds, bracketing, disposal, merge and the press discharge codes
  //     (recipe-core 0420, 0422, 0540; plant.charge_container of 0624) ----
  {
    group: 'output-containers',
    functions: ['plant.container_state', 'plant.container_closed_at', 'plant.press_streams_separate',
                'plant.bracketing_problem', 'plant.container_usable_problem', 'plant.guard_container_closed',
                'plant.guard_hold_recorded', 'plant.output_container_content', 'plant.close_container',
                'plant.container_scope', 'plant.dispose_container', 'plant.merge_container',
                'plant.configure_press_discharge', 'plant.open_container', 'plant.apply_hold',
                'plant.press_unit_problem', 'plant.charge_container'],
    tests: [r('containers/containers.test.ts'), r('plant/equipment.test.ts'), s('blocks/compression/db-guards.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: change paths, the exception register, hand-over and approved acts (recipe-core 0440-0480;
  //     recipe.hand_over_problem of 0502; recipe.review_exception and recipe.execution_change_path_check of 0601;
  //     recipe.skip_problem as tablets 0874 redefined it) ----
  {
    group: 'change-paths-and-hand-over',
    functions: ['recipe.exception_qa_only', 'recipe.json_text', 'recipe.register_exception',
                'recipe.exception_register_sync', 'recipe.batch_record_content', 'recipe.approval_refs',
                'recipe.signer_engine_roles', 'recipe.member_blank',
                'recipe.check_approver_roles', 'recipe.is_person_id', 'recipe.execution_hand_over_check',
                'recipe.propose_act', 'recipe.batch_act_content', 'recipe.change_path_problem',
                'recipe.hand_over_persons', 'recipe.person_engine_roles', 'recipe.hand_over_involvement',
                'recipe.hand_over_problem', 'recipe.review_exception', 'recipe.execution_change_path_check'],
    tests: [s('execution/db-guards-change-paths.test.ts'), s('execution/db-guards-exception-register.test.ts'), s('execution/db-guards-hand-over.test.ts'), r('lifecycle/gmp-references.test.ts'), s('blocks/compression/db-guards.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: GMP batch issue and its record: allocation, ERP order link, packaging parent, product scope,
  //     deviation references (recipe-core 0500-0504, 0582, 0601, 0603) ----
  {
    group: 'gmp-batch-issue',
    functions: ['recipe.batch_record_identity_guard', 'recipe.execution_mbr_content', 'recipe.batch_mbr_content',
                'recipe.content_for_mbr_hash', 'recipe.sandbox_only_blocks_in', 'recipe.batch_allocation_link_guard',
                'recipe.control_recipe_sandbox_only_guard', 'recipe.batch_issue_content', 'recipe.gmp_batch_problem',
                'recipe.batch_execution_origin_check', 'recipe.gmp_issue_problem', 'recipe.begin_gmp_issue',
                'recipe.issue_gmp_execution', 'recipe.execution_content_version_check',
                'recipe.execution_row_context_check', 'recipe.execution_state_records_check',
                'recipe.execution_status_equipment_check', 'plant.batch_facts', 'plant.batch_scope',
                'recipe.batch_product', 'recipe.packaging_parent_problem', 'recipe.packaging_link_guard',
                'recipe.gmp_reference_problem', 'recipe.allocation_problem', 'recipe.prepare_gmp_issue'],
    tests: [r('lifecycle/gmp-issue.test.ts'), r('lifecycle/gmp-references.test.ts'), r('lifecycle/packaging-issue.test.ts'), s('execution/gmp-batch.test.ts'), s('execution/gmp-batch-routes.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: material lots and LIMS: status, release route, reservation and consumption, identity, destruction,
  //     test results, retest, assay, the lot a GMP entry uses (site-services 0710-0762; recipe-core 0430; tablets
  //     0801, 1001, 1093) ----
  {
    group: 'lots-and-lims',
    functions: ['tab.entry_lot_material_problem', 'tab.record_lot_assay', 'tab.lot_assay_of',
                'tab.g07_consumption_problem', 'tab.g07_consumption_check', 'recipe.consume_lot', 'site.actor_site',
                'site.lot_quantity', 'site.lot_release_route', 'site.lot_consumption_stamp', 'site.lot_state',
                'site.reservation_remaining', 'site.reservation_is_open', 'site.lot_available',
                'site.vendor_route_enabled', 'site.identity_rule_problem', 'site.vendor_route_content',
                'site.guard_command_recorded', 'site.guard_not_finished', 'site.guard_not_intermediate',
                'site.guard_within_dates', 'site.guard_signer_is_actor', 'site.guard_quantity_zero', 'site.lock_lot',
                'site.revoke_open_reservations', 'site.record_identity_result', 'site.propose_vendor_route',
                'site.enable_vendor_route', 'site.disable_vendor_route', 'site.lot_transition', 'site.change_lot_status',
                'site.record_lot_destruction', 'site.destroy_lot', 'site.cancel_reservation', 'site.consume_reservation',
                'site.lot_signed_release_route', 'site.material_lot_content', 'site.guard_destruction_witnessed',
                'site.guard_intermediate_only', 'site.guard_release_route_satisfied', 'site.lot_test_is_current',
                'site.lot_test_state', 'site.lot_test_result_content', 'site.record_lot_test_result',
                'site.approve_lot_test_result', 'site.link_lot_test_oos', 'site.lot_dates_problem', 'site.reserve_lot',
                'site.lot_retest_at', 'site.record_lot_retest', 'site.lot_test_failure_resolved',
                'site.lot_lims_release_problem', 'site.record_signed_lot_retest', 'site.lot_retest_content'],
    tests: [site('lots/lots.test.ts'), site('lots/machine.test.ts'), site('quality/lims.test.ts'), s('blocks/dispensing/tb-01-gmp.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: deviations: raise, link, investigate, conclude, close; QA signature; evidence documents;
  //     extra-testing decision (site-services 0730, 0731, 0733, 0753; recipe-core 0600) ----
  {
    group: 'deviations',
    functions: ['recipe.site_subject_identity', 'site.register_subject_resolver', 'site.subject_identity',
                'site.deviation_state', 'site.deviation_latest_finding', 'site.deviation_content', 'site.lock_deviation',
                'site.raise_deviation', 'site.link_deviation', 'site.start_deviation_investigation',
                'site.record_deviation_finding', 'site.conclude_deviation', 'site.close_deviation',
                'site.cancel_deviation', 'site.register_evidence_document', 'site.evidence_document_problem',
                'site.qc_test_codes', 'site.qc_extra_testing_content', 'site.record_qc_extra_testing_decision',
                'site.qc_extra_testing_decision_of', 'site.assert_deviation_qa_signature', 'site.deviation_ref_problem'],
    tests: [site('quality/deviation.test.ts'), site('quality/lims.test.ts'), r('lifecycle/gmp-references.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: ERP masters and production orders as received (site-services 0732, 0750, 0751; recipe-core 0602)
  //     ----
  {
    group: 'erp-interfaces',
    functions: ['recipe.erp_order_problem', 'recipe.open_erp_order_for', 'site.erp_receive_product',
                'site.product_master_of', 'site.receive_lot', 'site.erp_receive_material', 'site.erp_material_current',
                'site.material_master_of', 'site.erp_receive_order', 'site.erp_order_of'],
    tests: [site('quality/interfaces.test.ts'), site('lots/lots.test.ts'), r('lifecycle/gmp-references.test.ts'), r('lifecycle/gmp-issue.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: reprocessing: residue sources, authorisation, source additions, whole-batch requests, recovered
  //     expiry (recipe-core 0620-0625; tab.residue_source_problem of tablets 1021) ----
  {
    group: 'reprocessing',
    functions: ['tab.tb08_entry_problem', 'tab.tb08_computed_problem', 'tab.tb08_state_check',
                'recipe.g24_v1_gmp_problem', 'recipe.g24_v1_gmp_check',
                'recipe.container_remaining', 'recipe.source_container_facts', 'recipe.reprocessing_authorisation_facts',
                'recipe.source_addition_remaining_check', 'recipe.reprocessing_authorisation_content',
                'recipe.reserve_residue', 'recipe.propose_reprocessing_authorisation', 'recipe.authorise_reprocessing',
                'recipe.rpr_mass', 'recipe.addition_problem', 'recipe.record_source_addition',
                'recipe.reprocessing_start_problem', 'recipe.source_batch_expiry', 'recipe.batch_contains_recovered',
                'recipe.batch_reprocessing_basis', 'recipe.reprocessing_request_content',
                'recipe.propose_reprocessing_request', 'recipe.authorise_reprocessing_request',
                'recipe.prepare_reprocessing_issue', 'recipe.reprocessing_parents_check', 'recipe.recovered_expiry_cap',
                'recipe.batches_receiving_from', 'recipe.g24v2_check', 'recipe.source_container_charge_check',
                'recipe.reprocessing_request_problem', 'recipe.reprocessing_start_take'],
    tests: [site('quality/reprocessing.test.ts'), s('blocks/reprocessing/db-guards.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: the formulation library: versions, approval, MBR pin, base standard, who reads a composition
  //     (recipe-core 0640, 0642, 0690; tablets 1042) ----
  {
    group: 'formulas',
    functions: ['tab.formula_read', 'tab.formula_reader_refusal', 'tab.mbr_composition_check', 'tab.formula_reader_may',
                'tab.composition_product', 'tab.planning_orders', 'recipe.formula_fail', 'recipe.formula_version_state',
                'recipe.formula_reader', 'recipe.formula_lines_json', 'recipe.formula_batch_mass',
                'recipe.formula_create', 'recipe.formula_add_version', 'recipe.formula_approve',
                'recipe.formula_version_content', 'recipe.formula_read', 'recipe.formula_choice',
                'recipe.formula_version_for_mbr', 'recipe.formula_pin_mbr', 'recipe.mbr_formula_of',
                'recipe.formula_listing', 'recipe.formula_choice_of', 'recipe.formula_mbr_problem',
                'recipe.formula_bom_line_on_base'],
    tests: [s('master-data/formula.test.ts'), s('master-data/formula-base.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: process devices, readings, setpoint downloads, alarms, device units, G-06 values and exceptions,
  //     status blocks v2 (tablets 0820, 0870, 0894, 0913; recipe-core 0520, 0521, 0691) ----
  {
    group: 'process-devices-and-status',
    functions: ['tab.process_device_guard', 'tab.bind_process_device', 'tab.end_process_device', 'tab.process_head',
                'tab.ingest_process_readings', 'tab.step_link_status', 'tab.request_setpoint_download',
                'tab.pending_setpoint_downloads', 'tab.ack_setpoint_download', 'tab.reading_in_step',
                'tab.acknowledge_process_alarm', 'tab.process_alarm_ack_entry_check', 'tab.claim_process_reading',
                'tab.process_entry_problem', 'tab.process_entry_readings_check', 'tab.g06_step_node',
                'tab.bind_step_device', 'tab.link_process_device_unit', 'tab.step_unit_problem',
                'tab.record_interface_losses', 'tab.reading_use_purpose_check', 'tab.g06_exception_problem',
                'tab.g06_exception_check', 'recipe.g06_max_age_us', 'recipe.g06_value_data',
                'recipe.plant_status_entry_check', 'recipe.plant_status_entry_problem'],
    tests: [s('devices/process-readings.test.ts'), s('blocks/granulation/db-guards.test.ts'), s('blocks/compression/db-guards.test.ts'), r('plant/status-blocks.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: TB-01 dispensing: the potency calculation, the entry and close guards, first-expiring lot (tablets
  //     0842, 0843, 1000) ----
  {
    group: 'tablets-dispensing',
    functions: ['tab.tb01_round', 'tab.tb01_as_is', 'tab.tb01_calculation', 'tab.tb01_raised', 'tab.tb01_close_problem',
                'tab.tb01_entry_problem', 'tab.tb01_reservation_for', 'tab.tb01_entry_check', 'tab.lot_facts',
                'tab.tb01_first_expiring'],
    tests: [s('blocks/dispensing/tb-01-db.test.ts'), s('blocks/dispensing/tb-01-gmp.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: granulation and TB-08 (tablets 0851, 1021) ----
  {
    group: 'tablets-granulation',
    functions: ['tab.gran_qty', 'tab.gran_prior', 'tab.gran_held', 'tab.gran_raised', 'tab.gran_sum',
                'tab.gran_batch_entries', 'tab.granulation_entry_problem', 'tab.granulation_computed_problem',
                'tab.granulation_close_problem', 'tab.granulation_loop_problem', 'tab.granulation_state_check',
                'recipe.granulation_block_item'],
    tests: [s('blocks/granulation/db-guards.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: compression, tooling and detector challenges (tablets 0871, 0872, 0874, 1040) ----
  {
    group: 'tablets-compression',
    functions: ['tab.hold_press_output', 'tab.press_counter_baseline', 'tab.issue_strokes', 'tab.tooling_cumulative',
                'tab.tooling_fit_problem', 'tab.tooling_issue_problem', 'tab.tooling_use_problem',
                'tab.define_tooling_set', 'tab.tooling_set_by_code', 'tab.inspect_tooling', 'tab.issue_tooling',
                'tab.return_tooling', 'tab.define_test_piece', 'tab.record_detector_challenge', 'tab.comp_raised_new',
                'tab.comp_named', 'tab.comp_checklist', 'tab.comp_device', 'tab.compression_entry_problem',
                'tab.compression_close_problem', 'tab.interface_loss_close_problem', 'tab.press_tooling_problem',
                'tab.compression_state_check', 'tab.define_detector'],
    tests: [s('blocks/compression/db-guards.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: in-process checks: calculations, entry rules, scheduler and guards (tablets 0891-0893, 0989;
  //     recipe-core 0541) ----
  {
    group: 'tablets-ipc',
    functions: ['tab.ipc_nums', 'tab.ipc_stats', 'tab.ipc_relative_tiers', 'tab.ipc_beyond', 'tab.ipc_worst',
                'tab.ipc_tiers', 'tab.ipc_rule_sets', 'tab.ipc_uncovered', 'tab.ipc_rule_set_problem',
                'tab.ipc_recorded', 'tab.ipc_band', 'tab.ipc_outside', 'tab.ipc_uniformity', 'tab.ipc_reference',
                'tab.ipc_av', 'tab.ipc_subdivision', 'tab.ipc_friability_sample_problem', 'tab.ipc_dt_limits',
                'tab.ipc_str', 'tab.ipc_d', 'tab.ipc_tcfg', 'tab.ipc_common', 'tab.ipc_of', 'tab.ipc_pending_first',
                'tab.ipc_weight_check', 'tab.ipc_second_stage', 'tab.ipc_physical_check', 'tab.ipc_pending_friability',
                'tab.ipc_friability_run', 'tab.ipc_start_sets', 'tab.ipc_dt_limits_of', 'tab.ipc_open_starts',
                'tab.ipc_pending_dt', 'tab.ipc_dt_start', 'tab.ipc_dt_end', 'tab.ipc_check_test', 'tab.ipc_due',
                'tab.ipc_overdue', 'tab.ipc_sweep', 'tab.ipc_scheduler_entry', 'tab.ipc_entry', 'tab.ipc_raised',
                'tab.ipc_values', 'tab.ipc_in_unit', 'tab.ipc_readings_problem', 'tab.ipc_plan_problem',
                'tab.ipc_first_off_problem', 'tab.ipc_entry_problem', 'tab.ipc_close_problem', 'tab.ipc_apply_holds',
                'tab.ipc_batch_has', 'tab.ipc_state_check', 'tab.ipc_overdue_at', 'tab.record_ipc_overdue',
                'plant.record_ipc_check', 'plant.ipc_check_record', 'plant.record_missed_ipc_check'],
    tests: [s('blocks/ipc/db-guards.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: coating, AQL sorting and held cores (tablets 0911, 0912, 1021, 1092) ----
  {
    group: 'tablets-coating',
    functions: ['tab.coat_sample', 'tab.aql_letter_for', 'tab.aql_evaluate', 'tab.aql_severity', 'tab.coat_raised',
                'tab.coat_cfg', 'tab.coat_point', 'tab.coat_log_gaps', 'tab.coat_used', 'tab.coat_rejects',
                'tab.coating_entry_problem', 'tab.coat_sort_problem', 'tab.coat_sort_data',
                'tab.coating_computed_problem', 'tab.coating_close_problem', 'tab.coating_loop_problem',
                'tab.coat_next_node', 'tab.coat_later_in_sequence', 'tab.coating_record', 'tab.coating_state_check',
                'tab.coat_container_problem', 'tab.coat_charge_check', 'tab.coat_print_pass', 'tab.coat_pass_check',
                'tab.coating_mbr_problem', 'tab.held_compression_containers', 'tab.held_cores_check'],
    tests: [s('blocks/coating/db-guards.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: roller compaction and bilayer forming (tablets 0930-0932) ----
  {
    group: 'tablets-forming',
    functions: ['tab.forming_constraint_values', 'tab.forming_ribbon_due', 'tab.forming_ribbon_overdue',
                'tab.forming_total', 'tab.compaction_entry', 'tab.bilayer_layer_cfg', 'tab.bilayer_layers',
                'tab.bilayer_entry', 'tab.bilayer_plan_problem', 'tab.forming_unit_problem', 'tab.forming_entry_problem',
                'tab.forming_close_problem', 'tab.forming_apply_holds', 'tab.forming_state_check'],
    tests: [s('blocks/forming/db-guards.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: G-21 printed material and coding rules (recipe-core 0580, 0581) ----
  {
    group: 'packaging-g21-rules',
    functions: ['recipe.g21_dec', 'recipe.g21_challenge_time', 'recipe.g21_cfg_member', 'recipe.g21_entry_data',
                'recipe.g21_cfg', 'recipe.g21_nodes', 'recipe.g21_step_entries', 'recipe.g21_raised',
                'recipe.g21_mbr_problem', 'recipe.g21_exception_problem', 'recipe.g21_counted',
                'recipe.g21_close_problem', 'recipe.g21_skip_problem', 'recipe.g21_return_problem', 'recipe.g21_record',
                'recipe.g21_state_check'],
    tests: [s('blocks/packaging/db-guards.test.ts'), s('blocks/packaging/completion.test.ts'), r('execution/g21-sql.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: printed lots, print jobs and serialisation; packaging batch data (tablets 0950-0952, 1022) ----
  {
    group: 'packaging-printing-and-serialisation',
    functions: ['tab.record_lot_artwork', 'tab.printed_lot_facts', 'tab.g21_command_node', 'tab.g21_issue_lot_check',
                'tab.print_device_guard', 'tab.bind_print_device', 'tab.end_print_device', 'tab.g21_open_step',
                'tab.g21_job_market', 'tab.current_batch_data', 'tab.check_packaging_batch_data',
                'tab.release_print_job', 'tab.print_job_state', 'tab.pending_print_jobs', 'tab.ack_print_job',
                'tab.ingest_print_events', 'tab.g21_printed', 'tab.g21_printed_count_problem',
                'tab.g21_print_entry_problem', 'tab.g21_print_entry_check', 'tab.g21_unrecorded_fail_check',
                'tab.g21_job_pool', 'tab.latest_serial_report', 'tab.serialised_market', 'tab.serial_pool_request',
                'tab.record_serial_pool', 'tab.acting_pool', 'tab.record_serial_events', 'tab.serial_states_of',
                'tab.record_serial_report', 'tab.serial_entry_of', 'tab.serialisation_release_problem',
                'tab.g21_serial_entry_problem', 'tab.g21_serial_entry_check', 'tab.serial_completion_check',
                'tab.record_packaging_batch_data'],
    tests: [s('blocks/packaging/db-guards.test.ts'), s('blocks/packaging/completion.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: blister lines (tablets 0970-0972, 1002) ----
  {
    group: 'packaging-blister',
    functions: ['tab.record_line_isolation', 'tab.line_isolated', 'tab.blister_n', 'tab.blister_reel',
                'tab.blister_check_entry', 'tab.blister_run_entry', 'tab.leak_tracks', 'tab.leak_due',
                'tab.leak_overdue', 'tab.leak_entry', 'tab.ipc_pass_check', 'tab.blister_line_problem',
                'tab.blister_lot_problem', 'tab.blister_line_check_problem', 'tab.blister_hold',
                'tab.blister_entry_problem', 'tab.blister_close_problem', 'tab.blister_apply_holds',
                'tab.blister_state_check', 'tab.g21_pass_ok', 'tab.blister_isolation_problem'],
    tests: [s('blocks/blister/db-guards.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: bottle lines, SSCC, line clearance and overdue checks (tablets 0985-0989) ----
  {
    group: 'packaging-bottle',
    functions: ['tab.gs1_check_ok', 'tab.issue_sscc', 'tab.packline_n', 'tab.packline_dec', 'tab.packline_last_check',
                'tab.packline_missed', 'tab.packline_stopped', 'tab.packline_check', 'tab.packline_challenge',
                'tab.packline_within', 'tab.packline_sum', 'tab.bottle_entry', 'tab.pack_balance', 'tab.pack_entry',
                'tab.packline_g21', 'tab.packline_mbr_problem', 'tab.packline_raised', 'tab.packline_entry_problem',
                'tab.packline_close_problem', 'tab.packline_apply_holds', 'tab.packline_state_check',
                'tab.packline_pass_check', 'tab.packline_artwork_set', 'tab.packline_line_problem',
                'tab.packline_line_check', 'tab.packline_overdue'],
    tests: [s('blocks/bottle/db-guards.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: the platform scope hook: who may run a transition in which scope (kernel 1150; recipe-core 0523)
  //     ----
  {
    group: 'platform-scope',
    functions: ['platform.register_hook', 'platform.scope_of', 'iam.platform_authority', 'plant.transition_scope'],
    tests: [k('platform/scope-hook.test.ts'), k('platform/state-machine.test.ts'), k('esig/platform-hook.test.ts'), k('integration/authorization.test.ts'), r('plant/equipment.test.ts'), r('containers/containers.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: recipe-core checks the Tablets edition redefines (tablets 0843, 0844, 0845, 0852, 0874, 1021): the
  //     refusal codes and the dispensed container of the Tablets blocks, the TB-01 weighing item, the granulation
  //     totals, the steps never skipped, the reusable residue of TB-20. Their live definition exists only in the server
  //     set-up's databases, so the group runs server tests alone (the db project's copies hold recipe-core's own). ----
  {
    group: 'tablets-core-checks',
    functions: ['recipe.refusal_problem', 'recipe.new_container_problem', 'recipe.weighing_item_problem',
                'recipe.weighing_totals_problem', 'recipe.skip_problem', 'recipe.residue_source_problem'],
    tests: [s('execution/db-guards-row-shape.test.ts'), s('execution/evidence-source.test.ts'),
            s('execution/db-guards-entry-identifiers.test.ts'), s('execution/db-guards-weighing-record.test.ts'),
            s('mutation/weighing.test.ts'), s('mutation/evidence-source-and-entries.test.ts'),
            s('blocks/dispensing/tb-01-db.test.ts'), s('blocks/granulation/db-guards.test.ts'),
            s('execution/db-guards-change-paths.test.ts'), s('blocks/compression/db-guards.test.ts'),
            s('blocks/reprocessing/db-guards.test.ts'), s('blocks/coating/db-guards.test.ts')],
    threshold: 90,
  },
];
