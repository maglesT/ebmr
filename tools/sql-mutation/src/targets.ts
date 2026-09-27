/**
 * What the SQL mutation run covers: the database-enforced guards of the Phase 1 kernel, grouped
 * with the test files that must detect a change to them. Build outline 9.1 asks for at least 90 %
 * on guards, signature invalidation, limits, rounding, flow validation and release gating.
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

export const TARGETS: Target[] = [
  {
    group: 'audit-trail',
    functions: ['kernel.begin_command', 'kernel.set_actor_context', 'kernel.actor_context_validated', 'kernel.current_actor',
                'kernel.append_audit_event', 'kernel.audit_row_change', 'kernel.reject_mutation', 'kernel.audit_triggers_ok',
                'kernel.verify_chain'],
    tests: [k('audit/audit-trail.test.ts'), k('identity/attribution.test.ts'), k('security/definer-hardening.test.ts'), k('records/true-copy.test.ts')],
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
                'esig.create_challenge', 'esig.sign', 'esig.signature_problem', 'esig.assert_signature'],
    tests: [k('esig/signing.test.ts'), k('esig/sessions.test.ts'), k('esig/independence.test.ts'), k('esig/catalogue.test.ts'),
            k('esig/platform-hook.test.ts'), k('esig/invalidation.test.ts')],
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
    functions: ['iam.check_static_segregation', 'iam.role_grant_guard', 'iam.role_permission_guard', 'iam.request_role_grant', 'iam.decide_role_grant'],
    tests: [k('identity/access.test.ts'), k('identity/accounts.test.ts'), k('identity/generic.test.ts'), k('integration/authorization.test.ts')],
    threshold: 90,
  },
  {
    group: 'authentication-events',
    functions: ['iam.consume_auth_event', 'iam.use_auth_event_for_command', 'iam.auth_event_guard', 'iam.session_guard', 'iam.open_session'],
    tests: [k('identity/attribution.test.ts'), k('identity/devices-sessions.test.ts'), k('identity/credentials.test.ts'), k('esig/sessions.test.ts')],
    threshold: 90,
  },
  {
    group: 'retention-and-purge',
    functions: ['records.approve_purge', 'records.purge', 'records.disposal_refusals', 'records.insert_only_trigger'],
    tests: [k('records/retention-purge.test.ts')],
    threshold: 90,
  },
  {
    group: 'site-values-and-policies',
    functions: ['market.assess_site_value', 'market.set_site_value', 'market.policy_pin_guard', 'market.policy_version_guard',
                'market.pin_policies_for_batch', 'market.apply_policy_tightening'],
    tests: [k('market/site-values.test.ts'), k('market/policy.test.ts')],
    threshold: 90,
  },
  {
    group: 'protected-numbers',
    functions: ['continuity.next_counter_value', 'continuity.reserve_counter_ceiling', 'continuity.after_restore',
                'continuity.approve_restore_event', 'continuity.restore_event_is_approved'],
    tests: [k('continuity/numbers.test.ts'), k('continuity/restore.test.ts'), 'packages/site-services/test/batch-number-register.test.ts'],
    threshold: 90,
  },
];
