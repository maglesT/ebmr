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
 * The Phase 3 exit (decision 0009) added 22 groups, by area: every function added or replaced since dd66b59 in
 * kernel, site-services, recipe-core and tablets that is a guard, a limit, a signature or state check, a writer of GMP
 * data, or a helper whose result one of those decides on (recipe.planning_orders, a planning view, is left out). A
 * Phase 3 redefinition of a function already in a Phase 2 group left it there, with the Phase 3 test files that reach
 * the new definition added to the group.
 * The Phase 6 exit (decision 0019, part 1) added the last 14 groups, one or more per slice area of that decision
 * (adapters and mirrors: inbound-adapters-and-mirrors, erp-wms-receipt-and-stock, qms-capa-lims-cmms; equipment,
 * alarms and plant rules: equipment-data-and-alarms, plant-rules; packaging and serialisation:
 * packaging-labels-and-line-completion, serialisation-l3; genealogy and recall: genealogy-and-recall; the
 * controlled-substance mode: controlled-substance-mode; governance, change control and the India DSC:
 * governance-change-control, governance-support-and-contract-giver, india-dsc; reporting and training mode:
 * reporting-and-training; inter-site transfer and federation: transfer-and-federation). An area is split where one
 * group would pass about 500 mutants, so that a group's run fits in one sitting and the groups spread over clusters.
 * They hold every function the migrations of 1fec042..8331e94 and slice 6j-c (site services 0990, kernel 1230) add or re-create
 * that the rule above admits; a function re-created by a later Phase 6 migration sits in the group of the slice that
 * created it, with the later definition's test files added (site.erp_wms_receive, site.apply_wms_stock_move,
 * recipe.genealogy*, recipe.run_mock_recall). Phase 6 re-created eleven functions of earlier groups; they stay there,
 * with the Phase 6 test files added (plant.fitness_problems and plant.record_calibration in plant-equipment-and-areas,
 * recipe.grel_evaluate in release-gate, tab.grel_recon_serial in tablets-release-items, tab.record_read_problem in
 * read-authorisation, sandbox.apply_connect_policy and sandbox.segregation_problems in connection-roles,
 * recipe.guard_critical_elements_risk_assessed in mbr-lifecycle, recipe.genealogy_downstream_lots in
 * after-release-suspension, recipe.pqr_run_query in pqr-extract, site.lot_available in lots-and-lims). Functions of
 * Phase 1 to 5 that Phase 6 re-created and no group held join the Phase 6 group of their slice (iam.qualification_source_fresh,
 * iam.session_state, iam.authn_resolve, esig.set_policy, recipe.review_gate_problems, tab.kernel_signing_meanings,
 * tab.aggregate_read_class). The reads that only list, look up or format for a screen are left out; they are named in
 * LEFT_OUT below, which tools/sql-mutation/test/harness.test.ts checks against the migrations (every function since the
 * Phase 6 start is in a group or there). The report views and recipe.change_impact are in: two views carry controls
 * (PR-05, DI-49) and each answer is exported with its hash.
 * Every Phase 6 group targets 90 %, as every earlier group does: the rule above admits only guards, limits, signature
 * and state checks, GMP writers and the helpers they decide on, which is the 90 % zone of build outline 9.1; the 80 %
 * zone of decision 0019 (display, formatting, logging, simulators, retry timing) is TypeScript and is measured by
 * Stryker (stryker.phase6.config.mjs).
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

/**
 * Functions since the Phase 6 start (kernel 1180, site services 0910, recipe-core 0940, tablets 1210) that no group
 * mutates, with the reason: reads that only list, look up or format for a screen (no refusal, check or decision).
 */
const READS_FOR_A_SCREEN = 'a read for a screen or an export list; no refusal, check or decision';
export const LEFT_OUT: Record<string, string> = Object.fromEntries(
  ['plant.batch_alarms', 'plant.series_in_context', 'plant.status_board', 'plant.line_station', 'plant.room_conditions',
      'site.lot_current_location', 'site.lims_lot_results', 'site.transfer_hold_remaining', 'tab.packaging_completion_view', 'tab.session_end_notice',
      'tab.batch_pools_view', 'recipe.genealogy_lookup', 'recipe.genealogy_supply_chain', 'recipe.genealogy_lot_deviations',
      'recipe.last_federated_excerpt', 'recipe.contract_giver_accesses', 'recipe.mbr_edition_review',
      'recipe.mbr_edition_citations', 'recipe.rbe_rules_as_of', 'iam.support_grants', 'esig.policy_values',
      'esig.dsc_configuration', 'esig.dsc_of', 'esig.dsc_enrolments_of', 'platform.config_as_of', 'platform.config_diff',
      'report.catalog_rows_v1', 'analytics.method_monitor_rows_v1', 'iam.setup_state', 'tab.installation_contents',
      'recipe.packaging_order_bulk'].map((f): [string, string] => [f, READS_FOR_A_SCREEN]),
);

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
            s('master-data/formula.test.ts'),
            // Phase 6 exit: the files that test this group's functions as Phase 6 re-created them.
            r('review/rbe-rules.test.ts')],
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
                'recipe.execution_attribution_check', 'recipe.insert_contents', 'tab.engine_roles',
                // 6jc-R16 (recipe-core 1100, tablets 1320): the batch's product joins the command and engine-role checks.
                'recipe.batch_scope_members', 'recipe.with_batch_scope', 'recipe.batch_step_content', 'recipe.batch_stage_content',
                'recipe.batch_exception_content', 'recipe.batch_point_content'],
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
                'tab.state_entry_identifier_problem', 'tab.state_container_identifier_problem', 'tab.state_entry_identifiers_check',
                // Slice 7o (tablets 1700): a test run's disposal or sample names the batch's own output container; (recipe-core
                // 1745) a test run's own container labels are bound words of its record.
                'tab.own_output_container', 'recipe.run_bound_words'],
    tests: [r('execution/entry-data-sql.test.ts'), s('execution/evidence-source.test.ts'), s('execution/evidence-source-room.test.ts'),
            s('execution/db-guards-entry-identifiers.test.ts'), s('execution/db-guards-stale-row.test.ts'), s('execution/sandbox-own-containers.test.ts'),
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
            s('execution/gmp-batch.test.ts'), r('review/batch-scope.test.ts')],
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
                'tab.record_withheld', 'tab.registry_chains_of', 'tab.audit_verify_chain', 'tab.partly_withheld_chains', 'tab.reader_is_contract_giver', 'tab.contract_giver_refusal'],
    tests: [s('audit/read-authorisation.test.ts'), s('esig/read-authorisation.test.ts'), s('audit/view-integrity.test.ts'),
            // Phase 3 exit: the files that test this group's functions as Phase 3 redefined them.
            s('master-data/formula.test.ts'),
            // Phase 6 exit: the files that test this group's functions as Phase 6 re-created them.
            s('controlled/controlled-routes.test.ts'), s('governance/governance-routes.test.ts'), s('controlled/controlled-read.test.ts')],
    threshold: 90,
  },
  // ---- Phase 2: tablets, sessions, roles bound to them and attribution (sql 0001, 0100, 0400, 0480) ------------------
  {
    group: 'tablets-sessions',
    functions: ['tab.set_session_role', 'tab.unbind_session', 'tab.consume_device_nonce', 'tab.set_attribution_method',
                'tab.session_role_withdrawn', 'tab.resolve_session', 'tab.end_withdrawn_session', 'tab.session_to_extend', 'tab.bind_session'],
    tests: [s('session/login.test.ts'), s('session/no-role-binding.test.ts'), s('session/role-withdrawn.test.ts'),
            s('session/device-nonce-limit.test.ts'), s('access/attribution.test.ts'),
            // Slice 7d: the file that tests tab.resolve_session as tablets 1460 re-created it (the idle-lock seconds).
            s('access/session.test.ts')],
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
    tests: [k('security/backend-signals.test.ts'), k('security/listener-roles.test.ts'), k('sandbox/bypass.test.ts'),
            // Phase 6 exit: the files that test this group's functions as Phase 6 re-created them.
            k('sandbox/reporting-and-training.test.ts')],
    threshold: 90,
  },
  // ---- Decision 0026 slice S3: the library of block definitions (recipe-core 1800) -------------------------------------
  {
    group: 'library-blocks',
    functions: ['recipe.library_block_guard', 'recipe.library_block_state', 'recipe.library_block_content', 'recipe.draft_library_block',
                'recipe.approve_library_block', 'recipe.retire_library_block',
                // Decision 0026 slice S4 (recipe-core 1810): library entries, limits and snapshots in batches and masters.
                'recipe.library_definition', 'recipe.library_field_schema', 'recipe.library_entry_schema', 'recipe.entry_schema_of',
                'recipe.library_limits_problem', 'recipe.library_limits_check', 'recipe.library_snapshot_problem',
                'recipe.library_at_approval_check', 'recipe.library_at_issue_check',
                // Decision 0026 slice S6 (tablets 1803): lots, equipment and hand-keyed weighings of library entries.
                'tab.library_smart_problem', 'tab.library_smart_fields_check',
                // Decision 0026 slice S7 (recipe-core 1820): the catalogue load's author check.
                'recipe.require_library_author',
                // Release review R3 (recipe-core 1862): the exceptions' facts, test results, timers, calculated fields, loops.
                'recipe.library_breach_record', 'recipe.library_statistic', 'recipe.library_timer_duration', 'recipe.library_loop_pass',
                // Injectables plan I-0 (recipe-core 1871): the edition of a block and its check at draft and at QA approval.
                'recipe.library_editions', 'recipe.library_block_edition', 'recipe.library_block_edition_check',
                'recipe.library_edition_problem', 'recipe.library_edition_at_approval_check',
                // API edition plan A0 (kernel 1403, recipe-core 1872): the one list of editions, and the rule tables an
                // edition's master binds (the API edition the kernel table only).
                'kernel.editions', 'kernel.edition_codes', 'recipe.rule_table_versions'],
    tests: [s('library/library-routes.test.ts'), s('library/library-batch-gmp.test.ts'), s('mutation/library-blocks.test.ts'),
            s('library/library-edition.test.ts'), s('library/substance-edition.test.ts')],
    threshold: 90,
  },
  // ---- Site services: the batch-number register (sql 0600; not in the Phase 1 run) ---------------------------------
  {
    group: 'batch-number-register',
    functions: ['site.require_actor', 'site.render_batch_number', 'site.define_batch_number_rule', 'site.rule_in_force',
                'site.allocate_batch_number', 'site.register_external_batch_number', 'site.void_batch_number', 'site.batch_number_pattern',
                'site.recover_batch_number', 'site.batch_number_invariant_violations',
                // recipe-core 1790: {SEQ:n} of a packaging number counted per parent batch (owner report #19).
                'site.counts_per_parent', 'site.next_parent_serial'],
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
            s('blocks/reprocessing/db-guards.test.ts'), s('blocks/packaging/db-guards.test.ts'), s('blocks/granulation/db-guards.test.ts'),
            // Decision 0026 slice S4: entry_schema_problem as recipe-core 1810 re-created it (library entries).
            s('library/library-batch-gmp.test.ts')],
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
            s('execution/db-guards-hand-over.test.ts'), s('execution/db-guards-change-paths.test.ts'), s('execution/block-entries.test.ts'),
            // Phase 7 slice 7m (P7L-1, recipe-core 1650): the inferred balance of a manual weighing.
            r('mutation/execution-row-shape.test.ts')],
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
    tests: [r('plant/equipment.test.ts'), r('plant/area.test.ts'), r('plant/machine.test.ts'), r('plant/status-blocks.test.ts'),
            // Phase 6 exit: the files that test this group's functions as Phase 6 re-created them.
            r('integrations/cmms-qms-release.test.ts')],
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
                'plant.press_unit_problem', 'plant.charge_container',
                // The in-process check record and its hold selection (recipe-core 0541), proven by the containers tests.
                'plant.record_ipc_check', 'plant.ipc_check_record', 'plant.record_missed_ipc_check'],
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
    tests: [s('execution/db-guards-change-paths.test.ts'), s('execution/db-guards-exception-register.test.ts'), s('execution/db-guards-hand-over.test.ts'), r('lifecycle/gmp-references.test.ts'), s('blocks/compression/db-guards.test.ts'),
            s('mutation/exception-register-sync.test.ts'), r('review/batch-scope.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: GMP batch issue and its record: allocation, ERP order link, packaging parent, product scope,
  //     deviation references (recipe-core 0500-0504, 0582, 0601, 0603) ----
  {
    group: 'gmp-batch-issue',
    // Slice 7c (recipe-core 1250) re-creates recipe.gmp_issue_problem for the validation-summary interlock (DI-03); its
    // test is lifecycle/gmp-issue.test.ts, already listed. Slice 7g-5 (recipe-core 1260) re-creates it again for the US
    // e-signature certification (DI-15).
    functions: ['recipe.batch_record_identity_guard', 'recipe.execution_mbr_content', 'recipe.batch_mbr_content',
                'recipe.content_for_mbr_hash', 'recipe.sandbox_only_blocks_in', 'recipe.batch_allocation_link_guard',
                'recipe.control_recipe_sandbox_only_guard', 'recipe.batch_issue_content', 'recipe.gmp_batch_problem',
                'recipe.batch_execution_origin_check', 'recipe.gmp_issue_problem', 'recipe.begin_gmp_issue',
                'recipe.issue_gmp_execution', 'recipe.execution_content_version_check',
                'recipe.execution_row_context_check', 'recipe.execution_state_records_check',
                'recipe.execution_status_equipment_check', 'plant.batch_facts', 'plant.batch_scope',
                'recipe.batch_product', 'recipe.packaging_parent_problem', 'recipe.packaging_link_guard',
                'recipe.gmp_reference_problem', 'recipe.allocation_problem', 'recipe.prepare_gmp_issue',
                // Phase 3 exit fixes (site services 0800-0802, recipe-core 0700-0701, tablets 1100-1102).
                'recipe.release_for_packing_problem', 'recipe.issue_packaging_bulk', 'recipe.packaging_bulk_charged', 'tab.packaging_run_problem', 'tab.packaging_run_check',
                // Phase 7 slice 7g-5 (recipe-core 1260): the US e-signature certification at issue (DI-15).
                'recipe.us_esig_issue_entity', 'recipe.batch_execution_us_esig_gate'],
    tests: [r('lifecycle/us-esig-certification.test.ts'), s('execution/us-esig-certification-issue.test.ts'), r('lifecycle/record-lock.test.ts'), s('blocks/packaging/bulk-gate-gmp.test.ts'), r('lifecycle/gmp-issue.test.ts'), r('lifecycle/gmp-references.test.ts'), r('lifecycle/packaging-issue.test.ts'), s('execution/gmp-batch.test.ts'), s('execution/gmp-batch-routes.test.ts'), s('blocks/packaging/bulk-gate-gmp.test.ts'),
            // The row checks 0502 replaced (recipe-core 0338, 0339, 0345): their Phase 2 tests.
            s('execution/db-guards-row-context.test.ts'), s('execution/db-guards-entry-identifiers.test.ts'), s('execution/db-guards-row-shape.test.ts'), s('execution/signed-content-hold-point.test.ts'), r('review/batch-scope.test.ts')],
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
                'site.lot_lims_release_problem', 'site.record_signed_lot_retest', 'site.lot_retest_content',
                // Phase 3 exit fixes (site services 0800-0802, recipe-core 0700-0701, tablets 1100-1102).
                'site.lot_signed_decision', 'site.lot_event_meaning', 'site.propose_lot_decision', 'site.revoke_batch_reservations', 'recipe.claim_consumption', 'recipe.consumption_entries_record', 'recipe.consumption_named_check', 'recipe.batch_end_reservations', 'tab.g07_consumption_pairs'],
    tests: [site('mutation/lots-and-lims.test.ts'), site('lots/lots.test.ts'), site('lots/machine.test.ts'), site('quality/lims.test.ts'), s('blocks/dispensing/tb-01-gmp.test.ts'), site('lots/exit-review.test.ts'), s('blocks/dispensing/tb-01-db.test.ts'),
            // Phase 4 slice 7c: the G-07 pairing and the lot-material entry check (not twins of an engine check).
            s('mutation/lots-and-lims-g07.test.ts'),
            // Phase 6 exit: the files that test this group's functions as Phase 6 re-created them.
            site('transfer/transfer.test.ts'), site('lots/consumption-batch-scope.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: deviations: raise, link, investigate, conclude, close; QA signature; evidence documents;
  //     extra-testing decision (site-services 0730, 0731, 0733, 0753, 0820 to 0823; recipe-core 0600) ----
  {
    group: 'deviations',
    functions: ['recipe.site_subject_identity', 'site.register_subject_resolver', 'site.subject_identity',
                'site.deviation_state', 'site.deviation_latest_finding', 'site.deviation_content', 'site.lock_deviation',
                'site.raise_deviation', 'site.link_deviation', 'site.start_deviation_investigation',
                'site.record_deviation_finding', 'site.conclude_deviation', 'site.close_deviation',
                'site.cancel_deviation', 'site.register_evidence_document', 'site.evidence_document_problem',
                'site.qc_test_codes', 'site.qc_extra_testing_content', 'site.record_qc_extra_testing_decision',
                'site.qc_extra_testing_decision_of', 'site.assert_deviation_qa_signature', 'site.deviation_ref_problem',
                // Phase 4 slice 2a: the full deviation stand-in and the document service (site-services 0820 to 0823).
                'site.deviation_latest_classification', 'site.deviation_latest_closure_basis', 'site.deviation_owner',
                'site.deviation_latest_impact', 'site.deviation_impact_current', 'site.deviation_epoch_hook',
                'site.deviation_classification_input', 'site.insert_deviation_classification', 'site.reclassify_deviation',
                'site.record_deviation_impact', 'site.assess_deviation_impact', 'site.record_deviation_closure_basis',
                'site.deviation_release_items', 'site.deviation_release_problem', 'site.deviation_open_for',
                'site.guard_release_deviations', 'site.store_evidence_document', 'site.evidence_document_bytes',
                'site.evidence_document_verified'],
    tests: [site('mutation/deviations.test.ts'), site('quality/interfaces.test.ts'), site('quality/deviation.test.ts'), site('quality/deviation-full.test.ts'), site('quality/lims.test.ts'), r('lifecycle/gmp-references.test.ts')],
    threshold: 90,
  },
  // ---- Phase 3: ERP masters and production orders as received (site-services 0732, 0750, 0751; recipe-core 0602)
  //     ----
  {
    group: 'erp-interfaces',
    functions: ['recipe.erp_order_problem', 'recipe.open_erp_order_for', 'site.erp_receive_product',
                'site.product_master_of', 'site.receive_lot', 'site.erp_receive_material', 'site.erp_material_current',
                'site.material_master_of', 'site.erp_receive_order', 'site.erp_order_of',
                // Phase 3 exit fixes (site services 0800-0802, recipe-core 0700-0701, tablets 1100-1102).
                'site.erp_effect_if_unchanged', 'site.erp_master_state', 'site.erp_master_content', 'site.confirm_erp_master', 'site.erp_product_effective'],
    tests: [site('mutation/erp-interfaces.test.ts'), site('quality/interfaces.test.ts'), site('lots/lots.test.ts'), r('lifecycle/gmp-references.test.ts'), r('lifecycle/gmp-issue.test.ts'), site('lots/exit-review.test.ts'), site('quality/reprocessing.test.ts')],
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
                'recipe.source_batch_expiry', 'recipe.batch_contains_recovered',
                'recipe.batch_reprocessing_basis', 'recipe.reprocessing_request_content',
                'recipe.propose_reprocessing_request', 'recipe.authorise_reprocessing_request',
                'recipe.prepare_reprocessing_issue', 'recipe.reprocessing_parents_check', 'recipe.recovered_expiry_cap',
                'recipe.batches_receiving_from', 'recipe.g24v2_check', 'recipe.source_container_charge_check',
                'recipe.reprocessing_request_problem', 'recipe.reprocessing_start_take'],
    tests: [site('mutation/reprocessing.test.ts'), site('quality/reprocessing.test.ts'), s('blocks/reprocessing/db-guards.test.ts'), s('mutation/reprocessing-g24v2.test.ts'),
            // Recipe-core 0893 redefined recipe.source_batch_expiry (the shelf life in effect at issue): its edge tests.
            r('mutation/india-expiry.test.ts')],
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
                'recipe.formula_bom_line_on_base', 'recipe.formula_line_overage_json', 'recipe.bom_overage_matches',
                'recipe.formula_withdraw'],
    // Slice 7q (recipe-core 1740): the overage with its reason, re-created writers and the BOM's overage statement.
    tests: [s('master-data/formula.test.ts'), s('master-data/formula-base.test.ts'), s('execution/gmp-batch-routes.test.ts'), s('designer/from-formula.test.ts')],
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
    tests: [s('devices/process-readings.test.ts'), s('blocks/granulation/db-guards.test.ts'), s('blocks/compression/db-guards.test.ts'), r('plant/status-blocks.test.ts'),
            s('mutation/process-devices-gateway.test.ts')],
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
    tests: [s('blocks/granulation/db-guards.test.ts'), s('mutation/due-times-and-holds.test.ts')],
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
    tests: [s('blocks/compression/db-guards.test.ts'), s('mutation/tablets-compression-registers.test.ts')],
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
                'tab.ipc_batch_has', 'tab.ipc_state_check', 'tab.ipc_overdue_at', 'tab.record_ipc_overdue'],
    tests: [s('blocks/ipc/db-guards.test.ts'), s('mutation/due-times-and-holds.test.ts')],
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
    tests: [s('blocks/packaging/db-guards.test.ts'), s('blocks/packaging/completion.test.ts'), s('mutation/packaging-print-serial-gateway.test.ts')],
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
                'tab.blister_state_check', 'tab.g21_pass_ok', 'tab.blister_isolation_problem',
                // Slice 7t (tablets 1760, R10 #3): a late entry after the run's end with its reason and QA's exception.
                'tab.blister_late_problem', 'tab.blister_late_check'],
    tests: [s('blocks/blister/db-guards.test.ts'), s('mutation/due-times-and-holds.test.ts')],
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
                'tab.packline_line_check', 'tab.packline_overdue',
                // Slice 7r (tablets 1701, D-7r-5): the unit a packaging step configures, read as the sandbox's TEST- unit on a
                // SANDBOX installation only.
                'tab.configured_unit', 'tab.packline_unit'],
    tests: [s('blocks/bottle/db-guards.test.ts'), s('mutation/due-times-and-holds.test.ts'), s('plant/sandbox-configured-unit.test.ts')],
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
  // ---- Phase 4 (decision 0012, focused mutation A): the release gate G-REL and its items, the manufacturer release and
  //     rejection, the market dispositions (US QCU, EU QP certification and message intake), market add and removal
  //     (recipe-core 0780-0826, 0841, 0892; tablets 1162, 1163, 1180). Reads that only list or format are left out
  //     (recipe.release_lots, recipe.release_lot_facts, recipe.grel_acknowledged, recipe.lot_market_changes,
  //     recipe.lot_qp_certifications). ----
  {
    group: 'release-gate',
    functions: ['recipe.grel_evaluate', 'recipe.grel_core_items', 'recipe.grel_item', 'recipe.grel_items_well_formed',
                'recipe.grel_edition_items', 'recipe.grel_versions', 'recipe.release_gate_problems', 'recipe.release_batches', 'recipe.release_deviations', 'recipe.release_scope',
                'recipe.batch_purpose', 'recipe.batch_master_version', 'recipe.investigation_unjustifiable',
                'recipe.investigation_unjustifiable_for', 'recipe.manufacturer_release_state', 'recipe.release_involvement'],
    tests: [r('release/release.test.ts'), s('release/grel-interfaces.test.ts'), s('release/grel-tablets-items.test.ts'),
            // Phase 6 exit: the files that test this group's functions as Phase 6 re-created them.
            r('integrations/cmms-qms-release.test.ts')],
    threshold: 90,
  },
  {
    group: 'release-gate-market-items',
    functions: ['recipe.grel_market_items', 'recipe.grel_licence_item'],
    tests: [r('release/dispositions.test.ts'), r('release/india.test.ts'), r('mutation/release-gate.test.ts')],
    threshold: 90,
  },
  {
    group: 'manufacturer-release',
    functions: ['recipe.record_manufacturer_release', 'recipe.manufacturer_decision', 'recipe.manufacturer_decision_in_xact',
                'recipe.assert_release_signature', 'recipe.acknowledge_release_item', 'recipe.release_review_time',
                'recipe.manufacturer_release_content', 'recipe.epoch_on_release_evidence', 'recipe.justify_open_investigation',
                'recipe.investigation_justification_content', 'recipe.investigation_justification_of',
                'recipe.record_post_change_evaluation', 'recipe.post_change_evaluation_content', 'recipe.post_change_record',
                'recipe.record_ppq_outcome', 'recipe.ppq_outcome_content', 'recipe.ppq_statement_hash'],
    tests: [r('release/release.test.ts'), r('release/dispositions.test.ts'), r('mutation/release-gate.test.ts')],
    threshold: 90,
  },
  {
    group: 'tablets-release-items',
    functions: ['tab.grel_edition_items', 'tab.grel_batch_ev', 'tab.grel_container_ev', 'tab.grel_container_release',
                'tab.grel_entries', 'tab.grel_held_containers', 'tab.grel_item_of', 'tab.grel_pack_examination',
                'tab.grel_posted_quantity', 'tab.grel_printed_tablets', 'tab.grel_problem', 'tab.grel_recon_packs',
                'tab.grel_recon_printed', 'tab.grel_recon_serial', 'tab.grel_recon_yield', 'tab.grel_rule_sets',
                'tab.grel_steps', 'tab.grel_unresolved', 'tab.grel_whole_batch_parents', 'tab.grel_changed_since',
                'tab.grel_master_blocks', 'tab.grel_next_hold'],
    tests: [s('release/grel-tablets-items.test.ts'), s('release/grel-interfaces.test.ts'),
            // Phase 6 exit: the files that test this group's functions as Phase 6 re-created them.
            s('integrations/l3-adapter.test.ts')],
    threshold: 90,
  },
  // ---- API plan A1a: the API edition's release items (editions/substance/sql 5000) and the market guard of kernel 1404 --
  {
    group: 'api-release-items',
    functions: ['substance.grel_edition_items', 'substance.grel_pack_examination', 'market.evaluate_stub_scope'],
    tests: [s('substance/api-chain.test.ts'), k('market/in52.test.ts')],
    threshold: 90,
  },
  {
    group: 'us-disposition',
    functions: ['recipe.disposition_state', 'recipe.check_us_disposition', 'recipe.us_disposition_gate_problems',
                'recipe.record_us_disposition', 'recipe.insert_us_disposition', 'recipe.record_release_with_us_disposition',
                'recipe.us_decision', 'recipe.us_disposition_content', 'recipe.cascade_market_dispositions',
                'recipe.market_act_problem', 'recipe.market_added', 'recipe.market_ineligible_by', 'recipe.market_rejections',
                'recipe.controlled_release_actives', 'recipe.eu_outcome', 'recipe.lock_release_evidence',
                'recipe.epoch_on_market_decision', 'recipe.eu_importer_of'],
    tests: [r('release/dispositions.test.ts'), r('release/after-release.test.ts'), s('release/disposition-interfaces.test.ts')],
    threshold: 90,
  },
  {
    group: 'qp-certification',
    functions: ['recipe.epoch_on_qp_outcome', 'recipe.eu_certification_gate_problems', 'recipe.eu_importer_canonical',
                'recipe.eu_importer_content', 'recipe.eu_outcome_problem', 'recipe.lot_importer', 'recipe.parse_certified_at',
                'recipe.qp_certification_content', 'recipe.qp_details_sha256', 'recipe.qp_effective', 'recipe.qp_register_content',
                'recipe.qp_registration', 'recipe.qp_transcription_check_content', 'recipe.qp_transcription_content',
                'recipe.record_qp_certification', 'recipe.record_qp_transcription', 'recipe.register_eu_importer',
                'recipe.register_qp', 'recipe.take_qp_message', 'recipe.verify_qp_transcription',
                'recipe.eu_pending_transcription_problem', 'tab.take_qp_certification_message'],
    tests: [r('release/dispositions.test.ts'), s('release/market-routes.test.ts'), s('release/qp-shipping-routes.test.ts')],
    threshold: 90,
  },
  {
    group: 'market-changes',
    functions: ['recipe.market_add_evaluate', 'recipe.market_set', 'recipe.market_base_set', 'recipe.market_change_content',
                'recipe.market_change_next_id', 'recipe.market_change_ref', 'recipe.market_change_scope', 'recipe.market_failed',
                'recipe.market_subject_batches', 'recipe.lots_of_batch', 'recipe.packaging_children_of',
                'recipe.packaging_order_markets_check', 'recipe.record_market_change'],
    // recipe.market_removal_after_release_check is mutated in after-release-suspension (one group per function).
    tests: [r('release/dispositions.test.ts'), r('release/after-release.test.ts'), s('release/disposition-interfaces.test.ts')],
    threshold: 90,
  },
  // ---- Phase 4 (decision 0012, part 2): after release and record integrity. Suspension and its cause triggers,
  //     re-confirmation, recall, rejection after release and disposal (recipe-core 0840, 0841, 0874, 0875; site services
  //     0880 with the ERP stock-block outbox), the shipping interlock (site services 0870, 0871), record locking and
  //     amendment (recipe-core 0870, 0872 to 0874), the bulk reconciliation and bright-stock hold (recipe-core 0871) and
  //     the EXECUTION_COMPLETE contingency-form gate (recipe-core 0911). recipe.manufacturer_release_state and
  //     recipe.disposition_state (re-created by 0840) stay in the release groups; recipe.issue_packaging_bulk (0871) and
  //     tab.packaging_run_problem (tablets 1190) stay in their Phase 3 group, with the Phase 4 test files added there. ----
  {
    group: 'after-release-suspension',
    functions: ['recipe.genealogy_downstream_lots', 'recipe.market_decided_released', 'recipe.open_suspensions',
                'recipe.after_release_state', 'recipe.suspension_cause_problem', 'recipe.suspend_lot', 'recipe.suspension_cause', 'recipe.suspend_release',
                'recipe.suspend_affected', 'recipe.suspend_on_deviation_link', 'recipe.suspend_on_kernel_link',
                'recipe.suspend_on_revised_result', 'recipe.suspend_on_calibration_failure', 'recipe.release_suspension_next_id',
                'recipe.market_removal_after_release_check'],
    tests: [r('release/after-release.test.ts'), r('release/record-amendment.test.ts'), s('release/disposition-interfaces.test.ts'),
            r('release/dispositions.test.ts'),
            // Phase 6 exit: the files that test this group's functions as Phase 6 re-created them.
            site('genealogy/genealogy.test.ts')],
    threshold: 90,
  },
  {
    group: 'after-release-decisions',
    functions: ['recipe.market_state_now', 'recipe.after_release_problems', 'recipe.release_suspension_content',
                'recipe.after_release_settle', 'recipe.record_after_release_decision', 'recipe.after_release_lot_event_in_xact',
                'recipe.disposal_details_sha256', 'recipe.disposal_problem', 'recipe.disposal_content', 'recipe.record_disposal',
                'recipe.witness_disposal', 'recipe.disposal_lot_event_in_xact', 'site.guard_after_release_decision',
                'site.guard_disposal_recorded', 'site.request_erp_stock_block', 'site.erp_stub_apply_stock_block',
                'site.erp_stub_deliver_stock_blocks', 'site.erp_stock_state'],
    tests: [r('release/after-release.test.ts'), r('release/record-amendment.test.ts'), site('lots/machine.test.ts')],
    threshold: 90,
  },
  {
    group: 'shipping-interlock',
    functions: ['site.release_model_text', 'site.shipment_problems', 'site.erp_shipment_interlock', 'site.erp_record_shipment',
                'site.qp_package_subject'],
    tests: [site('shipping/erp-shipping.test.ts'), r('release/after-release.test.ts'), k('records/qp-package.test.ts'), s('release/qp-shipping-routes.test.ts')],
    threshold: 90,
  },
  {
    group: 'record-lock-and-amendment',
    functions: ['recipe.record_lock_state', 'recipe.record_lock_append', 'recipe.assert_record_writable',
                'recipe.refuse_locked_write', 'recipe.refuse_order_of_locked_record', 'recipe.lock_at_first_disposition',
                'recipe.record_lock_ref', 'recipe.record_released_lots', 'recipe.record_lock_content', 'recipe.record_lock_next_id',
                'recipe.open_record_amendment', 'recipe.append_amendment_entry', 'recipe.close_record_amendment',
                'recipe.record_lock_actor_role'],
    tests: [r('lifecycle/record-lock.test.ts'), r('release/record-amendment.test.ts'), s('records/records-routes.test.ts'), r('release/after-release.test.ts')],
    threshold: 90,
  },
  {
    group: 'bulk-and-bright-stock',
    functions: ['recipe.batch_family_kind', 'recipe.order_status', 'recipe.bulk_container_disposition', 'recipe.bulk_totals',
                'recipe.bulk_close_problems', 'recipe.close_bulk_reconciliation', 'recipe.bulk_issue_within_produced',
                'recipe.set_bright_stock_hold', 'recipe.bright_stock_max_hold_of', 'recipe.bright_stock_deviation_covers',
                'recipe.bright_stock_container_problem', 'recipe.bright_stock_hold_problem',
                // Slice 7t (tablets 1770, 1772; R10 #4, #5): only the final stage's non-reject containers are bulk; the
                // reconciliation closes at the end of QA's review when all bulk is packed.
                'recipe.packaging_reject_problem', 'recipe.packaging_bulk_problem', 'recipe.bulk_reconciliation_close_after_review',
                'recipe.close_bulk_after_review', 'recipe.close_bulk_after_packing'],
    tests: [r('lifecycle/record-lock.test.ts'), r('lifecycle/packaging-issue.test.ts'), s('blocks/packaging/bulk-gate-gmp.test.ts'), s('execution/packaging-planning-routes.test.ts')],
    threshold: 90,
  },
  {
    group: 'execution-complete-forms',
    functions: ['recipe.refuse_unreconciled_completion'],
    tests: [r('lifecycle/execution-complete-forms.test.ts'), k('records/contingency-forms.test.ts')],
    threshold: 90,
  },
  // ---- Phase 4 (decision 0012, scope C): the India gate, expiry, records and signature binding. The licences, export
  //     permissions and stability basis (site-services 0885, 0886); the India issue gate with hazard dedication and the
  //     licence basis written at issue (recipe-core 0890, 0891, 0912; gmp_issue_problem's India part is a bare call of
  //     recipe.india_issue_problem, which this group mutates); expiry (recipe-core 0893, tablets 1201; 0893's
  //     recipe.source_batch_expiry stays in the reprocessing group, with this group's kill tests added there); the H2 payload
  //     and the allocation register (recipe-core 0894, 0895, 0913); the evidence export and contingency forms (kernel
  //     1170, 1171, 1174; recipe-core 0911); the PQR extract (recipe-core 0910). The record content functions are the
  //     signed content, so a change there is a change of what a signature binds. ----
  {
    group: 'india-licences',
    functions: ['site.india_record_immutable', 'site.licence_state', 'site.licence_current', 'site.licence_basis',
                'site.licence_problem', 'site.export_permission_state', 'site.export_permission_current',
                'site.export_permission_problem', 'site.manufacturing_licence_content', 'site.export_permission_content',
                'site.india_instant', 'site.record_manufacturing_licence', 'site.approve_manufacturing_licence',
                'site.suspend_manufacturing_licence', 'site.record_export_permission', 'site.approve_export_permission',
                'site.suspend_export_permission', 'site.erp_product_effective_at', 'site.shelf_life_basis_of',
                'site.shelf_life_change_check', 'site.record_shelf_life_basis'],
    tests: [site('india/licences.test.ts'), r('release/india.test.ts'), site('mutation/india-licences.test.ts')],
    threshold: 90,
  },
  {
    group: 'india-issue-gate',
    functions: ['recipe.india_issue_problem', 'recipe.record_batch_licence_basis', 'plant.record_product_hazard',
                'plant.record_area_dedication', 'plant.product_hazard_approved', 'plant.product_hazard_class',
                'plant.product_hazard_classes', 'plant.area_dedicated', 'plant.hazard_area_problem',
                'plant.hazard_record_state', 'plant.dedication_record_state', 'plant.hazard_classification_content',
                'plant.area_dedication_content', 'plant.assert_hazard_approval', 'plant.approve_product_hazard',
                'plant.approve_area_dedication'],
    tests: [r('release/india.test.ts')],
    threshold: 90,
  },
  {
    group: 'india-expiry',
    functions: ['recipe.expiry_month_end', 'recipe.batch_shelf_life', 'recipe.batch_expiry',
                'tab.post_finished_lot', 'tab.batch_data_expiry_check'],
    tests: [r('release/india.test.ts'), s('india/india-routes.test.ts'), s('blocks/packaging/db-guards.test.ts')],
    threshold: 90,
  },
  {
    group: 'india-h2-and-allocation',
    functions: ['recipe.india_label_particulars', 'recipe.h2_layout', 'recipe.h2_payload', 'recipe.issue_h2_payload',
                'recipe.h2_payload_problem', 'recipe.allocation_register'],
    tests: [r('release/india.test.ts')],
    threshold: 90,
  },
  {
    group: 'records-evidence-export',
    functions: ['records.evidence_export_state', 'records.evidence_export_content', 'records.register_evidence_export',
                'records.certify_evidence_export', 'records.read_evidence_export', 'records.batch_status',
                'records.true_copy_content_text', 'records.true_copy_bundle_problem'],
    tests: [k('records/evidence-export.test.ts'), k('records/true-copy.test.ts')],
    threshold: 90,
  },
  {
    group: 'records-contingency-forms',
    functions: ['records.contingency_form_state', 'records.contingency_forms_of', 'records.unreconciled_forms',
                'records.form_reconciliation_state', 'records.form_reconciliation_problem',
                'records.form_reconciliation_content', 'records.issue_contingency_pack',
                'records.record_contingency_form_event', 'records.sign_form_reconciliation'],
    // recipe.refuse_unreconciled_completion is mutated in execution-complete-forms (one group per function).
    tests: [k('records/contingency-forms.test.ts'), r('lifecycle/execution-complete-forms.test.ts')],
    threshold: 90,
  },
  {
    group: 'pqr-extract',
    functions: ['recipe.pqr_extract_v1', 'recipe.pqr_register_view', 'recipe.pqr_reconciliation', 'recipe.pqr_query_problem',
                'recipe.pqr_result_sha256', 'recipe.pqr_current_version', 'recipe.pqr_run_query', 'recipe.pqr_reproduces',
                'recipe.pqr_involvement', 'recipe.run_pqr_extract', 'recipe.pqr_extract_content', 'recipe.sign_off_pqr'],
    tests: [r('release/pqr-extract.test.ts')],
    threshold: 90,
  },
  // ---- Phase 6 (decision 0019, part 1): every function added or re-created by the Phase 6 migrations (1fec042 to
  //     8331e94, and site services 0990 of slice 6j-c) that the inclusion rule above admits, one group or more per slice
  //     area of decision 0019. The header lists what is left out, what stayed in an earlier group and why every group
  //     targets 90 %. ----
  // ---- 6a, adapters and mirrors: the inbound adapter framework, overrides, mirror sync and the LMS feed (kernel
  //      1180-1186) ----
  {
    group: 'inbound-adapters-and-mirrors',
    functions: ['iam.integration_adapter_guard', 'iam.register_integration_adapter', 'iam.set_integration_adapter_status',
                'iam.current_integration_adapter', 'platform.inbound_envelope_problem', 'platform.epoch_us_to_timestamptz',
                'platform.timestamptz_to_epoch_us', 'platform.raise_integration_alarm', 'platform.accept_inbound_detail',
                'platform.accept_inbound', 'platform.record_inbound_refusal', 'platform.acknowledge_integration_alarm',
                'platform.record_reconciliation', 'platform.record_mirror_sync', 'platform.mirror_freshness',
                'platform.mirror_fresh_or_raise', 'platform.record_inbound_override', 'iam.qualification_source_fresh',
                'iam.lms_mirror_problem', 'iam.lms_qualification_payload_problem', 'iam.receive_lms_qualification', 'platform.gap_needs_owner_or_qa', 'iam.stale_qualification_source_problem'],
    // Slice 7c (kernel 1350) re-creates platform.accept_inbound_detail and record_inbound_refusal for the interface drift
    // interlock (DI-06); they stay here with the drift test file.
    tests: [k('inbound/inbound.test.ts'), k('inbound/overrides-and-lms-mirror.test.ts'), k('integrations/lms-inbound.test.ts'), k('inbound/interface-drift.test.ts'),
            k('integration/authorization.test.ts'), k('inbound/source-verification.test.ts'), s('equipment-data/feed-signature.test.ts'), k('inbound/inbound.test.ts'), s('execution/gmp-batch.test.ts')],
    threshold: 90,
  },
  // ---- 6a, adapters and mirrors: receipt, approved manufacturers, stock locations, the ERP lot status mirror and
  //      outbound queue, the ERP/WMS inbound and the issue gate (site services 0910-0916); 6j-c's refusal of a person's
  //      material acts to a non-HUMAN account (0990). site.erp_wms_receive (re-created by 0961) and
  //      site.apply_wms_stock_move (re-created by 0970) stay here, with the test files of those definitions. ----
  {
    group: 'erp-wms-receipt-and-stock',
    functions: ['site.manufacturer_approved', 'site.approved_manufacturer_state', 'site.instant_text_pattern', 'site.lot_is_purchased',
                'site.lot_receipt_effective', 'site.receipt_problem', 'site.manufacturer_problem',
                'site.propose_approved_manufacturer', 'site.approved_manufacturer_content', 'site.approve_manufacturer',
                'site.withdraw_manufacturer_approval', 'site.receive_supplier_batches', 'site.receive_delivery',
                'site.record_lot_receipt', 'site.record_receipt_examination', 'site.lot_release_manufacturer_check',
                'site.lot_open_location_exception', 'site.location_move_problem', 'site.apply_wms_stock_move',
                'site.resolve_lot_location_exception', 'site.lot_release_location_check', 'site.erp_lot_status_latest',
                'site.apply_wms_lot_status', 'site.erp_lot_status_problem', 'site.enqueue_erp_outbound',
                'site.erp_outbound_from_fact', 'site.require_erp_wms_adapter', 'site.erp_outbound_pending',
                'site.erp_outbound_delivered', 'site.erp_outbound_failed', 'site.erp_source_value_ok', 'site.calendar_date_ok',
                'site.erp_payload_problem', 'site.site_date_start', 'site.erp_wms_receive', 'site.correct_lot_receipt_value',
                'site.issue_gate_problem', 'site.issue_gate', 'site.issue_by_person', 'site.wms_location_question',
                'site.material_act_by_person'],
    tests: [site('erp-wms/receipt.test.ts'), site('erp-wms/locations.test.ts'), site('erp-wms/inbound.test.ts'),
            r('lifecycle/erp-adapter-order.test.ts'), site('controlled/controlled.test.ts'),
            site('genealogy/recovery-distribution.test.ts'), s('integrations/erp-wms/contract.test.ts'),
            s('quality/receipt-routes.test.ts')],
    threshold: 90,
  },
  // ---- 6a, adapters and mirrors: CAPA and the QMS mirror, LIMS results, the QMS state at release, the CMMS mirror at
  //      equipment use (site services 0925-0927; recipe-core 0950-0952). plant.fitness_problems and
  //      plant.record_calibration (0950) stay in plant-equipment-and-areas, recipe.grel_evaluate (0951) in release-gate,
  //      each with cmms-qms-release.test.ts added. ----
  {
    group: 'qms-capa-lims-cmms',
    functions: ['site.register_capa_master_resolver', 'site.capa_master_version_facts', 'site.site_today', 'site.qms_mode',
                'site.capa_latest_qms_state', 'site.capa_state', 'site.capa_check_status', 'site.capa_view', 'site.capa_content',
                'site.require_capa_stand_in', 'site.lock_capa', 'site.raise_capa', 'site.link_capa_deviation',
                'site.link_capa_master_version', 'site.record_capa_implemented', 'site.schedule_capa_effectiveness_check',
                'site.record_capa_effectiveness', 'site.capa_close_problem', 'site.close_capa', 'site.cancel_capa',
                'site.qms_accept', 'site.qms_payload_problem', 'site.qms_assert_newest', 'site.receive_qms_deviation_status',
                'site.receive_qms_capa', 'site.receive_qms_change_control', 'site.qms_lot_deviations',
                'site.record_qms_release_fetch', 'site.qms_release_problem', 'site.receive_lims_sample_result',
                'plant.cmms_accept', 'plant.site_day_start', 'plant.receive_cmms_calibration', 'plant.receive_cmms_maintenance',
                'plant.cmms_maintenance_problems', 'recipe.grel_qms_item', 'recipe.qms_release_guard',
                'recipe.capa_master_version_facts'],
    tests: [site('integrations/capa-qms.test.ts'), site('integrations/lims-inbound.test.ts'),
            r('integrations/cmms-qms-release.test.ts'), s('capa/capa-routes.test.ts')],
    threshold: 90,
  },
  // ---- 6b, equipment, alarms and plant rules: equipment alarms, events and series, OPC UA endpoints and readings, the
  //      plant alarm bridge (recipe-core 0960, 0961, 0976; tablets 1210, 1218) ----
  {
    group: 'equipment-data-and-alarms',
    functions: ['plant.raw_states_value', 'plant.batch_context_at', 'plant.series_chunk_hash', 'plant.payload_subject',
                'plant.source_time_or_raise', 'plant.define_alarm_code', 'plant.bind_step_equipment', 'plant.raise_alarm',
                'plant.receive_equipment_alarm', 'plant.acknowledge_alarm', 'plant.alarm_problem', 'plant.receive_equipment_event',
                'plant.receive_series_chunk', 'plant.record_device_original', 'plant.device_area', 'plant.enrol_opcua_endpoint',
                'plant.retire_opcua_endpoint', 'plant.receive_opcua_endpoint_session', 'plant.opcua_unit_problem',
                'plant.opcua_data_guard', 'tab.status_quality', 'tab.process_device_endpoint', 'tab.ingest_opcua_readings',
                'tab.process_reading_native_required', 'tab.bridge_process_alarm', 'tab.bridge_process_alarm_ack',
                'tab.bridge_device_alarm', 'tab.bridge_step_device', 'plant.opcua_session_start_us', 'plant.receive_series_gap', 'plant.opcua_session_start_guard'],
    tests: [r('integrations/plant-alarms-series.test.ts'), r('equipment-data/opcua-endpoint-identity.test.ts'),
            r('plant/equipment.test.ts'), s('equipment-data/opcua-readings.test.ts'), s('equipment-data/opcua-adapter.test.ts'),
            s('alarms/alarm-bridge.test.ts'), r('plant-rules/alarm-ack-batch-scope.test.ts'), s('equipment-data/feed-signature.test.ts')],
    threshold: 90,
  },
  // ---- 6b, equipment, alarms and plant rules: area authorisation, reagent lots, room, adjacency and beta-lactam rules,
  //      step rules and the alarm review at batch review (kernel 1190; site services 0940; recipe-core 0973, 0974),
  //      the beta-lactam suite's rooms (recipe-core 1655, slice 7n) ----
  {
    group: 'plant-rules',
    functions: ['iam.area_authorisation_code', 'iam.create_area_authorisation_type', 'iam.person_area_authorised',
                'iam.area_authorisation_problem', 'site.record_reagent_lot', 'site.withdraw_reagent_lot', 'site.reagent_lot_problem',
                'plant.set_area_rule', 'plant.area_last_cleaned', 'plant.record_spill', 'plant.room_start_problem',
                'plant.define_area_adjacency', 'plant.adjacency_problem', 'plant.set_facility_rule', 'plant.classify_beta_lactam',
                'plant.classified_beta_lactam', 'plant.batch_beta_lactam', 'plant.penicillin_problem',
                'plant.area_occupancy_rules_check', 'plant.clearance_room_rules_check', 'plant.material_lot_penicillin_check',
                'plant.step_rules_problem', 'plant.step_rules_check', 'plant.record_reagent_use', 'plant.batch_alarm_review_problems',
                'recipe.review_gate_problems', 'plant.beta_lactam_room_problem', 'plant.beta_lactam_clearance_check', 'plant.beta_lactam_occupancy_check', 'plant.beta_lactam_equipment_check'],
    tests: [k('identity/area-authorisation.test.ts'), r('plant-rules/room-rules.test.ts'), site('plant-rules/materials.test.ts'),
            r('review/review.test.ts'), s('alarms/area-authorisation-matrix.test.ts'), s('alarms/area-authorisation-signature.test.ts'),
            s('alarms/alarm-bridge.test.ts'), r('plant-rules/rule-approval.test.ts'), r('plant-rules/beta-lactam-rooms.test.ts')],
    threshold: 90,
  },
  // ---- 6c, packaging and serialisation: the label store, label templates and the labelling a packaging master
  //      declares, G-21 specimens, post-use inspection, line stops, the reconciliation waiver and packaging completion
  //      (site services 0950; recipe-core 0990; tablets 1230) ----
  {
    group: 'packaging-labels-and-line-completion',
    functions: ['site.label_store_balance', 'site.open_label_store_transaction', 'recipe.label_template_status',
                'recipe.label_template_ref', 'recipe.label_layout_fields', 'recipe.create_label_template',
                'recipe.label_template_approval_problem', 'recipe.approve_label_template', 'recipe.labelling_rows',
                'recipe.packaging_labelling_problem', 'recipe.master_labelling', 'recipe.declare_packaging_labelling',
                'recipe.batch_labelling', 'recipe.labelling_at_approval_check', 'tab.live_specimens', 'tab.g21_coding_applies',
                'tab.g21_item_ids', 'tab.g21_expected_coding', 'tab.g21_specimen_step', 'tab.record_coding_specimen',
                'tab.record_label_specimen', 'tab.void_packaging_specimen', 'tab.g21_specimen_problem', 'tab.g21_steps_of',
                'tab.record_post_use_inspection', 'tab.verify_post_use_inspection', 'tab.open_line_stop', 'tab.vision_line_stop',
                'tab.resolve_line_stop', 'tab.enable_reconciliation_waiver', 'tab.packaging_completion_problem',
                'tab.g21_specimen_close_check', 'tab.refuse_incomplete_packaging', 'tab.print_job_rules'],
    tests: [site('lots/label-store.test.ts'), r('labels/label-templates.test.ts'), s('blocks/packaging/line-completion.test.ts'),
            s('blocks/packaging/completion.test.ts'), s('labels/labels-routes.test.ts')],
    threshold: 90,
  },
  // ---- 6c, packaging and serialisation: serialisation L3/L4 messages, pool rejection, the serial query (PR-42) and the
  //      L3 release item (tablets 1231). tab.grel_recon_serial (re-created) stays in tablets-release-items. ----
  {
    group: 'serialisation-l3',
    functions: ['tab.l3_tasks_of', 'tab.l3_shipper_packs', 'tab.receive_l3_message', 'tab.assert_pool_rejection',
                'tab.record_pool_rejection', 'tab.serial_lookup', 'tab.l3_release_problem'],
    tests: [s('integrations/l3-adapter.test.ts')],
    threshold: 90,
  },
  // ---- 6d, genealogy and recall: the genealogy (as 1090 re-created it across sites), chemical recovery, distribution
  //      records, the mock recall (as 1091 re-created it) and the deviation impact and recurrence answers (site services
  //      0960, 0961; recipe-core 1010-1013, 1090, 1091). recipe.genealogy_downstream_lots (1011) stays in
  //      after-release-suspension, with genealogy.test.ts added. ----
  {
    group: 'genealogy-and-recall',
    functions: ['site.record_chemical_recovery', 'site.lot_dosage_form', 'site.erp_shipment_distribution_fields',
                'site.erp_apply_shipment', 'recipe.genealogy_step', 'recipe.genealogy_node_exists', 'recipe.genealogy',
                'recipe.genealogy_node_views', 'recipe.lot_dosage_form', 'recipe.genealogy_batch_number', 'recipe.mock_recall_starts',
                'recipe.genealogy_forward_set', 'recipe.mock_recall_result_v1', 'recipe.mock_recall_sha256',
                'recipe.mock_recall_run_query', 'recipe.mock_recall_reproduces', 'recipe.run_mock_recall',
                'recipe.mock_recall_content', 'recipe.sign_off_mock_recall', 'recipe.deviation_impact_batches',
                'recipe.deviation_latest_category', 'recipe.deviation_of_product', 'recipe.deviation_recurrence', 'recipe.mock_recall_destinations'],
    tests: [site('genealogy/genealogy.test.ts'), site('genealogy/recall.test.ts'), site('genealogy/recovery-distribution.test.ts'),
            site('transfer/transfer.test.ts'), s('genealogy/genealogy-routes.test.ts'), s('transfers/transfer-routes.test.ts')],
    threshold: 90,
  },
  // ---- 6e, the controlled-substance mode: controlled products, dual custody, checkpoints, the register and the batch
  //      end (recipe-core 1031-1035; tablets 1250). tab.record_read_problem (1290) stays in read-authorisation and
  //      site.apply_wms_stock_move (0970) in erp-wms-receipt-and-stock, with controlled tests added. ----
  {
    group: 'controlled-substance-mode',
    functions: ['plant.controlled_product_approved', 'plant.controlled_materials', 'plant.material_is_controlled',
                'plant.controlled_record_state', 'plant.controlled_product_state', 'plant.controlled_product_content',
                'plant.record_controlled_product', 'plant.approve_controlled_product', 'recipe.controlled_custody_state',
                'recipe.controlled_custodians', 'recipe.batch_controlled_materials', 'recipe.controlled_custody_content',
                'recipe.propose_controlled_custody', 'recipe.sign_controlled_custody', 'recipe.controlled_consumption_guard',
                'recipe.controlled_transfer_for', 'recipe.controlled_balance', 'recipe.controlled_moved_materials',
                'recipe.controlled_checkpoint_state', 'recipe.controlled_checkpoint_current', 'recipe.controlled_checkpoint_problem',
                'recipe.controlled_checkpoint_content', 'recipe.record_controlled_checkpoint', 'recipe.sign_controlled_checkpoint',
                'recipe.controlled_sign_off_guard', 'recipe.controlled_register_v1', 'recipe.controlled_register_sha256',
                'recipe.run_controlled_register', 'recipe.controlled_register_reproduces', 'recipe.controlled_batch_end_problem',
                'recipe.controlled_batch_end_guard', 'tab.controlled_pair_ok', 'tab.controlled_preview',
                'tab.controlled_signing_content'],
    tests: [site('controlled/controlled.test.ts'), s('controlled/controlled-routes.test.ts'), s('controlled/controlled-read.test.ts')],
    threshold: 90,
  },
  // ---- 6f, governance: configuration change control, review-by-exception rules, excursion notifications and the PQR
  //      extract v2 with CPPs (kernel 1195, 1196; recipe-core 1050, 1051, 1062). recipe.guard_critical_elements_risk_assessed
  //      (1050) stays in mbr-lifecycle and recipe.pqr_run_query (1062) in pqr-extract, with their Phase 6 tests. ----
  {
    group: 'governance-change-control',
    functions: ['platform.change_record_state', 'platform.is_release_actor', 'platform.require_change_record',
                'platform.config_item_key', 'platform.config_item_value', 'platform.config_change_guard',
                'platform.config_version_log', 'platform.register_config_area', 'platform.raise_change_record',
                'platform.approve_change_record', 'platform.close_change_record', 'platform.change_record_content',
                'recipe.rbe_rule_guard', 'recipe.severity_rank', 'recipe.set_rbe_rule', 'recipe.rbe_reduction_problems',
                'recipe.notify_departments_of_excursion', 'recipe.pqr_cpp_of', 'recipe.pqr_extract_v2'],
    tests: [k('config/change-control.test.ts'), r('review/rbe-rules.test.ts'), r('release/pqr-extract.test.ts'),
            s('config/config-routes.test.ts'), s('notifications/excursion-notifications.test.ts')],
    threshold: 90,
  },
  // ---- 6f, governance: vendor support grants and the sessions they open (kernel 1202, re-creating iam.session_state and
  //      iam.authn_resolve; tablets 1275), the contract giver's reviewer role and batch access (kernel 1204; recipe-core
  //      1060) ----
  {
    group: 'governance-support-and-contract-giver',
    functions: ['iam.is_support_account', 'iam.support_grant_open_at', 'iam.support_grant_open', 'iam.support_grant_state',
                'iam.support_grant_content', 'iam.request_support_grant', 'iam.approve_support_grant', 'iam.revoke_support_grant',
                'iam.support_session_guard', 'iam.support_session_record', 'iam.support_auth_alert', 'iam.session_state',
                'iam.authn_resolve', 'tab.support_grant_preview', 'tab.support_grant_signing_content',
                'iam.contract_giver_role_permission_guard', 'recipe.contract_giver_access_live',
                'recipe.grant_contract_giver_access', 'recipe.revoke_contract_giver_access', 'recipe.contract_giver_batches',
                'recipe.read_contract_giver_batch'],
    // identity/access, identity/accounts and mutation/authentication-events test the refusals of iam.authn_resolve
    // (re-created here from 0160): added by the slice 6j triage, which found its survivors were only out of this list.
    tests: [k('identity/support-grant.test.ts'), k('identity/credentials.test.ts'), k('identity/devices-sessions.test.ts'),
            k('identity/generic.test.ts'), k('esig/sessions.test.ts'), r('release/india.test.ts'),
            s('governance/governance-routes.test.ts'), k('identity/access.test.ts'), k('identity/accounts.test.ts'),
            k('mutation/authentication-events.test.ts')],
    threshold: 90,
  },
  // ---- 6f, governance: the India digital signature certificate (DSC): policy, trust anchors, meanings, enrolment and
  //      the DSC a signature carries (kernel 1203, re-creating esig.set_policy, and 1206) ----
  {
    group: 'india-dsc',
    functions: ['esig.policy_allowed_values', 'esig.set_policy', 'esig.dsc_mode', 'esig.dsc_live_anchor',
                'esig.dsc_meaning_required', 'esig.dsc_required', 'esig.dsc_statement', 'esig.dsc_requirement',
                'esig.dsc_verification_input', 'esig.register_dsc_anchor', 'esig.set_dsc_meaning', 'esig.dsc_policy_guard',
                'esig.record_dsc_signature', 'esig.dsc_present_check', 'esig.dsc_enrolment_statement', 'esig.dsc_live_enrolment',
                'esig.dsc_enrolment_input', 'esig.enrol_dsc_certificate', 'esig.end_dsc_enrolment'],
    tests: [k('esig/dsc.test.ts'), k('config/change-control.test.ts'), s('governance/governance-routes.test.ts'), k('integration/authorization.test.ts')],
    threshold: 90,
  },
  // ---- 6g, reporting and training mode: the report views a dashboard reads (two carry controls: PR-05 overdue review,
  //      DI-49 alarm trend), the change impact answer and the training attempts kept in the sandbox (kernel 1210, 1211;
  //      recipe-core 1070, 1071). sandbox.apply_connect_policy and sandbox.segregation_problems (re-created by 1210 for
  //      the reporting role) stay in connection-roles, with reporting-and-training.test.ts added. ----
  {
    group: 'reporting-and-training',
    functions: ['report.data_as_of', 'report.batch_version', 'report.us_at', 'report.batch_outcome_rows_v1',
                'report.exception_rows_v1', 'report.deviation_ageing_rows_v1', 'report.hold_time_risk_rows_v1',
                'report.overdue_review_rows_v1', 'report.press_counter_rows_v1', 'report.alarm_rows_v1',
                'recipe.change_impact', 'sandbox.training_sandbox_only', 'sandbox.start_training',
                'sandbox.complete_training_step'],
    tests: [k('sandbox/reporting-and-training.test.ts'), site('reporting/reporting-views.test.ts'),
            site('reporting/change-impact.test.ts'), s('dashboards/dashboards-routes.test.ts')],
    threshold: 90,
  },
  // ---- 6i, inter-site transfer and federation: installation keys and seals (Ed25519 in SQL), peer installations,
  //      installation alarms, federated genealogy and the mock recall across sites, transfer packages and receipts
  //      (kernel 1220, 1221, and 1230 of slice 6j-c refusing small-order keys, 6jc-R8; site services 0980, 0981; recipe-core 1090-1093; tablets 1300, 1301 re-creating the signing
  //      meanings and read classes). site.lot_available (0980) stays in lots-and-lims, with transfer.test.ts added. ----
  {
    group: 'transfer-and-federation',
    functions: ['platform.ed25519_le_integer', 'platform.ed25519_pow', 'platform.ed25519_add', 'platform.ed25519_double',
                'platform.ed25519_decode', 'platform.ed25519_verify', 'platform.ed25519_small_order', 'platform.seal_message', 'platform.seal_valid',
                'platform.current_installation', 'platform.trusted_peer', 'platform.own_seal_valid', 'platform.peer_seal_valid',
                'platform.raw_public_key', 'platform.set_installation_identity', 'platform.propose_peer_installation',
                'platform.peer_installation_state', 'platform.peer_installation_content', 'platform.approve_peer_installation',
                'platform.revoke_peer_installation', 'platform.raise_installation_alarm', 'platform.acknowledge_installation_alarm',
                'platform.accept_federation_request', 'platform.refuse_federation_query', 'site.lot_transferred_out',
                'site.transfer_rule_tables', 'site.transfer_rule_resolutions', 'site.us_text', 'site.prepare_transfer_package',
                'site.seal_transfer_package', 'site.us_instant', 'site.transfer_receipt_state', 'site.transfer_receipt_content',
                'site.resolve_carried_rules', 'site.refuse_transfer_package', 'site.import_transfer_package',
                'site.decide_transfer_receipt', 'site.transfer_use_problem', 'site.transfer_release_check',
                'site.transfer_reservation_check', 'recipe.answer_federated_genealogy', 'recipe.issue_federated_request',
                'recipe.record_federation_failure', 'recipe.record_federated_excerpt', 'recipe.mock_recall_result_v2',
                'recipe.mock_recall_federation', 'recipe.record_mock_recall_remote', 'tab.kernel_signing_meanings',
                'tab.aggregate_read_class'],
    tests: [site('transfer/transfer.test.ts'), s('transfers/transfer-routes.test.ts'),
            // Phase 7 slice 7g-2: tablets 1479 re-created both tab.* functions for the labelling specimen approval.
            s('designer/master-records.test.ts'),
            // Phase 7 slice 7g-3 (WP1): tablets 1491 re-created tab.kernel_signing_meanings for the validation and records acts.
            s('validation/validation-routes.test.ts'), s('validation/records-register-routes.test.ts'),
            // Phase 7 slice 7g WP3: tablets 1493 re-created both again (market loosenings, QP register, rule-set verification).
            s('market/market-config-routes.test.ts'),
            // Phase 7 slice 7g (WP4): tablets 1496 re-created tab.kernel_signing_meanings for the lot destruction's witness.
            s('quality/lot-handling-routes.test.ts')],
    threshold: 90,
  },
  // ---- 6A-0, analytics interfaces (kernel 1240-1244; ADR 0020): the runner's run lifecycle and output recording, the QA
  //      disposition, the person-flag restriction (DI-53), the change-controlled methods and reference sets (DI-52) and
  //      the role and segregation checks that keep ebmr_analytics from any GMP write (DI-51). ----
  {
    group: 'analytics-foundation',
    functions: ['analytics.runner_actor', 'analytics.enter_runner', 'analytics.open_run', 'analytics.begin_run', 'analytics.finish_run',
                'analytics.fail_run', 'analytics.record_output', 'analytics.record_flag', 'analytics.reasons_ok',
                'analytics.record_disposition', 'analytics.person_flags', 'analytics.register_input', 'analytics.role_problems',
                'analytics.effective_methods', 'analytics.effective_reference_sets', 'analytics.reference_model_check'],
    // 6A-7: kernel 1280 replaces analytics.record_disposition (the flag's group is the unit of the verdict).
    tests: [k('analytics/analytics.test.ts'), k('analytics/exit-review.test.ts')],
    threshold: 90,
  },
  // ---- 6A-1, analytics foundation (kernel 1245; recipe-core 1115; ADR 0020): method versions and reference sets that
  //      never change and are written by ANALYTICS.METHOD under an approved change record (DI-52, DI-09), the restricted
  //      dispositions of person flags (DI-53), and the input views' values, limits, steps and lots (DI-51). ----
  {
    group: 'analytics-method-change',
    functions: ['analytics.method_version_rules', 'analytics.reference_set_rules', 'analytics.set_method_version', 'analytics.set_reference_set',
                'analytics.person_flag_dispositions'],
    // 6A-7: kernel 1280 replaces analytics.person_flag_dispositions (the dispositions of the flag's group).
    tests: [k('analytics/method-change.test.ts'), k('analytics/exit-review.test.ts')],
    threshold: 90,
  },
  {
    group: 'analytics-inputs',
    functions: ['report.engine_instant', 'report.outer_limits', 'report.cpp_values_of', 'report.batch_fact_rows_v1', 'report.cpp_value_rows_v1',
                'report.step_use_rows_v1'],
    tests: [r('analytics/input-views.test.ts')],
    threshold: 90,
  },
  // ---- 6A-4, audit-trail anomaly detection (kernel 1260, 1261; recipe-core 1150, 1151; decision 0016 item 8): the
  //      audit and authentication facts that export no value (DI-51, DI-53), and the flag readers restricted to
  //      ANALYTICS.DI_REVIEW, one row per key with the key's current disposition (DI-53, DI-25). ----
  {
    group: 'analytics-audit',
    functions: ['report.auth_fact_rows_v1', 'report.execution_command_events', 'report.execution_points', 'report.audit_facts',
                'report.audit_fact_rows_v1', 'report.manual_digit_rows_v1', 'analytics.flag_key', 'analytics.audit_flags',
                'analytics.audit_flag_entries', 'analytics.audit_flagged_entries'],
    tests: [r('analytics/audit-inputs.test.ts'), s('analytics/audit.test.ts')],
    threshold: 90,
  },
  // ---- 6A-2, deviation-rate inputs (recipe-core 1130): the shift boundaries and the deviation and step-shift facts. ----
  {
    group: 'analytics-rate-inputs',
    functions: ['report.shift_boundaries_problem', 'report.check_shift_boundaries', 'report.shift_of', 'report.deviation_fact_rows_v1', 'report.step_shift_rows_v1'],
    tests: [r('analytics/rate-inputs.test.ts')],
    threshold: 90,
  },
  // ---- 6A-5, review priority (recipe-core 1160; decision 0016 item 9): the review facts the score is computed from,
  //      over the records in the review queue (PR-61, DI-51). ----
  {
    group: 'analytics-review-inputs',
    functions: ['report.review_ended_at', 'report.review_fact_batches', 'report.review_novelty', 'report.review_fact_rows_v1'],
    tests: [r('analytics/review-inputs.test.ts')],
    threshold: 90,
  },
  // ---- 6A-6, golden batch profile inputs (recipe-core 1170): each GMP batch step's native series on its unit within
  //      its binding window, the window's samples exactly as received with their quality (DI-32), and the reference
  //      sets in force from the configuration store (DI-51, DI-52). ----
  {
    group: 'analytics-profile-inputs',
    functions: ['report.step_windows_v1', 'report.series_ref_rows_v1', 'report.series_samples_v1', 'report.analytics_reference_rows_v1'],
    tests: [r('analytics/series-inputs.test.ts')],
    threshold: 90,
  },
  // ---- 6A-3, multivariate monitoring's lead items (kernel 1270, 1271): a reference set carries its candidate's own
  //      model and batches (DI-52); the monitor counts a repeated flag with its signal's disposition (kernel 1271 replaces
  //      analytics.method_monitor_rows_v1, which stays in LEFT_OUT as a screen's read). ----
  {
    group: 'analytics-mspc-reference',
    functions: ['analytics.reference_candidate_check'],
    tests: [k('analytics/repeats-and-candidates.test.ts')],
    threshold: 90,
  },
  // ---- 6A-7, the Phase 6A exit review (kernel 1280, 1281): a flag's group, the unit QA's verdict applies to (DI-52,
  //      P6A7-1); whether the reader holds ANALYTICS.DI_REVIEW, and the review priority's audit-trail term left out of
  //      the views for anyone else (DI-53, P6A7-2). Kernel 1282 adds a view only. ----
  {
    group: 'analytics-exit',
    functions: ['analytics.flag_group', 'analytics.viewer_holds_di_review', 'analytics.audit_term_points', 'analytics.reasons_without_audit_term'],
    tests: [k('analytics/exit-review.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7-0 (kernel 1300): the release identity, the validation-summary approval and the system description.
  {
    group: 'release-identity',
    functions: [
      'platform.schema_release', 'platform.validation_summary_content', 'platform.approve_validation_summary',
      'platform.validation_summary_problem', 'platform.describe_interface', 'platform.system_description', 'platform.interface_described',
    ],
    tests: [k('config/release-identity.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7a (decision 0022): the gateway feed signature checked in the database (6jc-R9, DI-31, DI-20; kernel
  // 1305, tablets 1405). The re-created platform.accept_inbound_detail and inbound_envelope_problem stay in their group.
  {
    group: 'gateway-feed-signature',
    functions: [
      'platform.source_requires_signature', 'platform.inbound_envelope_key', 'platform.record_source_verification',
      'tab.accept_gateway_envelope', 'tab.feed_signature_message', 'tab.bind_gateway_feed', 'tab.gateway_feed_binding_guard',
    ],
    tests: [k('inbound/source-verification.test.ts'), s('equipment-data/feed-signature.test.ts'), s('equipment-data/opcua-adapter.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7a (decision 0022): QA approval of the plant rules (6jc-R10, PR-27; recipe-core 1210).
  {
    group: 'plant-rule-approval',
    functions: [
      'plant.approve_facility_rule', 'plant.approve_beta_lactam_class', 'plant.assert_plant_rule_approval',
      'plant.facility_rule_state', 'plant.beta_lactam_class_state', 'plant.facility_rule_content',
      'plant.beta_lactam_class_content', 'plant.penicillin_facility', 'plant.facility_rule_approved',
      'plant.beta_lactam_class_approved',
    ],
    tests: [r('plant-rules/rule-approval.test.ts'), s('alarms/plant-rule-approval.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7a: the controlled-substance reads gated by CONTROLLED.READ in scope (6jc-R2, draft IN-53; tablets
  // 1413, 1414).
  {
    group: 'controlled-reads',
    functions: [
      'tab.controlled_reader_problem', 'tab.controlled_reader_refusal', 'tab.reader_site', 'tab.controlled_batch_scope',
      'tab.controlled_products', 'tab.controlled_custody', 'tab.controlled_checkpoint_rows', 'tab.controlled_checkpoints',
      'tab.controlled_balance', 'tab.controlled_register_extracts', 'tab.controlled_record_scope',
      'tab.controlled_aggregate_problem', 'tab.controlled_entry_hidden',
    ],
    tests: [s('controlled/controlled-read.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7a: the batch issue's permission in the order's product scope (rest of 6jc-R16, IN-04; recipe-core
  // 1218). The acts re-created in 1217, 1218 and site-services 1103 stay in their groups, which gain the new tests.
  {
    group: 'batch-scope-remaining',
    functions: ['recipe.require_issue_permission'],
    // Phase B slice 3 (tablets 1900): the latest definition adds the product's master check on the platform build.
    tests: [r('review/batch-scope.test.ts'), s('medhanta/platform-master-data.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7b-2: the full export of the closed records (DI-08 clause 2; kernel 1335, recipe-core 1240).
  {
    group: 'full-export',
    functions: [
      'records.closed_di_investigation_records', 'records.closed_incident_records',
      'records.full_export_snapshot', 'records.register_full_export', 'records.register_export_restricted_table',
      'records.require_export_permissions', 'records.closed_record_chains', 'records.export_chain_parts',
      'records.open_export_run', 'records.begin_full_export', 'records.full_export_records', 'records.readability_snapshot',
      'report.closed_batch_records', 'report.closed_record_rows_v1', 'report.readability_sample_rows_v1',
      'report.register_closed_record_source',
    ],
    tests: [k('records/full-export.test.ts'), k('records/records-cli.test.ts'), r('records/closed-batch-records.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7b-2: the periodic evaluation pack and its QA sign-off bound to its hash (DI-11 clause 1, DI-44
  // clause 1; kernel 1336, site-services 1120, recipe-core 1240).
  {
    group: 'evaluation-pack',
    functions: [
      'records.store_evaluation_pack', 'records.evaluation_pack_content', 'records.approve_evaluation_pack',
      'report.register_evaluation_source', 'report.evaluation_entry_rows_v1', 'report.evaluation_period_rows_v1',
      'report.evaluation_topic_rows_v1', 'report.evaluation_access_recertifications', 'report.evaluation_audit_reviews',
      'report.evaluation_backups', 'report.evaluation_change_records', 'report.evaluation_config_changes',
      'report.evaluation_deviations', 'report.evaluation_incidents', 'report.evaluation_integration_alarms',
      'report.evaluation_integrity_checks', 'report.evaluation_open_di_investigations', 'report.evaluation_recipe_changes',
      'report.evaluation_restore_drills', 'report.evaluation_time_events',
    ],
    tests: [k('records/evaluation-pack.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7c: an inbound interface not in the approved system description is refused and alarmed (DI-06; kernel
  // 1350). The re-created platform.accept_inbound_detail and record_inbound_refusal stay in their group.
  {
    group: 'interface-drift',
    functions: ['platform.interface_drift_problem', 'platform.check_adapter_start', 'iam.integration_adapter_drift_alarm'],
    tests: [k('inbound/interface-drift.test.ts'), s('integrations/adapter-startup.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7c: a GMP batch is refused without an approved validation summary (DI-03; recipe-core 1250). The
  // re-created recipe.gmp_issue_problem stays in its group.
  {
    group: 'validation-summary-gate',
    functions: ['recipe.batch_execution_validation_gate'],
    tests: [r('lifecycle/gmp-issue.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7g-2 (decision 0025): QA's approval of a labelling specimen, its state and its signed content (DI-35;
  // tablets 1479). The re-created tab.aggregate_read_class and tab.kernel_signing_meanings stay in their group.
  {
    group: 'specimen-approval',
    functions: ['tab.approve_labelling_specimen', 'tab.labelling_specimen_state', 'tab.labelling_specimen_content'],
    tests: [s('designer/master-records.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7g-4: the browser's first-run set-up of a new installation with the installer's one-time token
  // (decision 0025 point 2; kernel 1375).
  {
    group: 'first-run-setup',
    functions: ['iam.is_bootstrapped', 'iam.issue_setup_token', 'iam.first_run_setup'],
    tests: [s('operations/setup.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7g-4: the operations acts of a person (worker start and stop, a backup now, a copy of a stored backup),
  // recorded and attributed (DI-17, DI-18, DI-45; kernel 1376).
  {
    group: 'operations-acts',
    functions: ['platform.record_operations_act', 'continuity.request_backup', 'continuity.record_backup_download'],
    tests: [s('operations/workers-and-backups.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7g-4: the demo conveniences refused on a GMP installation that is not a demo one, and the backup
  // catalogue read by permission (tablets 1485).
  {
    group: 'operations-demo-backups',
    functions: ['tab.demo_conveniences_problem', 'tab.record_demo_act', 'tab.backup_overview'],
    tests: [s('operations/demo-and-simulators.test.ts'), s('operations/workers-and-backups.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7g-3 (WP1): the IQ record run from the web app, stored with the SHA-256 of its text and held to its
  // checks (DI-03; kernel 1381).
  {
    group: 'iq-record',
    functions: ['platform.record_iq'],
    tests: [s('validation/validation-routes.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7g-3 (WP1): the records screens' reads behind the session's read rule (tablets 1491): the investigations,
  // a record's retention and blockers and the legal holds, never what an investigation about the reader withholds (DI-50);
  // and the id of the disposal a signature covers.
  {
    group: 'validation-records-reads',
    functions: ['tab.di_investigation_overview', 'tab.records_reader_problem', 'tab.record_retention', 'tab.legal_hold_overview', 'tab.disposal_aggregate_id'],
    tests: [s('validation/records-register-routes.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7g, work package 2: drill requests and records, hardening checks (kernel 1395), and the restore and
  // drill reads by permission (tablets 1525).
  {
    group: 'operations-drills-restore',
    functions: ['continuity.request_drill', 'continuity.record_upgrade_drill', 'continuity.record_hardening_check', 'tab.restore_overview', 'tab.drill_overview'],
    tests: [s('operations/drills.test.ts'), s('operations/restore-and-alarms.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7j (R4): products and materials entered on screen and confirmed by QA (site-services 1530), and a
  // formula version's target unit mass and batch sizes (recipe-core 1535).
  {
    group: 'own-product-masters',
    functions: ['site.master_entry_problem', 'site.enter_material_master', 'site.enter_product_master', 'site.erp_master_version', 'site.master_entry_of',
                'recipe.formula_set_target', 'recipe.formula_target_of'],
    tests: [s('master-data/master-entry.test.ts'), s('master-data/formula-target.test.ts'), s('designer/from-formula.test.ts')],
    threshold: 90,
  },
  // Phase 7 slice 7p (R4 third check, R8 C4): multi-point and two-stage specification profiles, their results per point
  // from QC and LIMS (site services 1720) and the profile item of the release checklist (recipe-core 1725).
  {
    group: 'specification-profiles',
    functions: ['site.point_minutes', 'site.specification_point_guard', 'site.specification_profile_points_check', 'site.lot_test_label', 'site.profile_points_json',
                'site.lot_profile_status', 'site.specification_content', 'site.lot_test_result_spec_check', 'site.draft_specification',
                'recipe.grel_profile_items', 'recipe.grel_lims_profile_evidence'],
    tests: [site('quality/profiles.test.ts'), site('quality/specifications.test.ts'), r('release/release.test.ts')],
    threshold: 90,
  },
  // Slice S16 (ADR 0022): the report views an external Deviations and CAPA system reads as ebmr_report (tablets 1800,
  // 1801): reference documents and the documents a batch cites, unit uses, in-process results, process values and
  // exception detail, with their one-batch functions.
  {
    group: 'deviations-reader-views',
    functions: ['report.reference_document_rows_v1', 'report.batch_reference_rows_v1', 'report.phase_of', 'report.equipment_use_v1_for',
                'report.ipc_result_v1_for', 'report.process_actual_v1_for', 'report.exception_detail_v1_for', 'report.equipment_use_rows_v1',
                'report.ipc_result_rows_v1', 'report.process_actual_rows_v1', 'report.exception_detail_rows_v1'],
    tests: [s('contract/report-views-deviations.test.ts'), s('contract/report-views-investigation.test.ts'), s('medhanta/platform-published-views.test.ts')],
    threshold: 90,
  },
  {
    // Phase B slice 2 (kernel 1400): sign-on, grants and re-authentication through the platform's core, and the DI-09 path
    // of the mirror roles (decision 0028).
    group: 'platform-identity',
    functions: ['iam.enable_platform_build', 'iam.platform_build', 'iam.platform_code_to_permission', 'iam.platform_mirror_role',
                'iam.platform_sync_grants', 'iam.platform_auth_event', 'platform.is_platform_register_write', 'iam.platform_map_existing',
                'iam.platform_register_terminal'],
    tests: [s('medhanta/platform-signon.test.ts'), 'tools/platform/test/move.test.ts', s('medhanta/platform-first-terminal.test.ts')],
    threshold: 90,
  },
  // Phase B slice 3: master data through the platform's views, the write-time active-item check (PL-08; tablets 1900).
  {
    group: 'platform-master-facts',
    functions: ['md.record_fact', 'md.require_active', 'md.require_active_row', 'md.require_active_entry'],
    tests: [s('medhanta/platform-master-data.test.ts')],
    threshold: 90,
  },
];
