/**
 * The MBR life-cycle signatures over HTTP (signable action MBR_TRANSITION; Phase 2 apps plan section 6, A2; registered in
 * Phase 3 slice 6d, where GB-T-01 approves its master through the routes): the author's PREPARED with the submission,
 * the checker's CHECKED, the regulatory sign-off (REGULATORY_CONFIRMED, PR-04) and the QA approver's APPROVED. Each runs
 * the existing life-cycle command with the signature in the signing command; the database stays the decider (roles,
 * the four-eyes rules, the evidence bound to the content hash, the pinned formula): when it refuses, nothing is signed.
 *
 *   transition          meaning                expected state   command
 *   SUBMIT              PREPARED               IN_VERIFICATION  lifecycle.submitVersion
 *   CHECK               CHECKED                SUBMITTED        lifecycle.checkVersion
 *   REGULATORY_CONFIRM  REGULATORY_CONFIRMED   (current)        none: the signature on the version is the sign-off
 *   APPROVE             APPROVED               CHECKED          lifecycle.approveVersion
 *
 * baseRevision is the content revision the person reviewed: a later revision answers 409 before anything is signed.
 */
import type { SignableAction } from '@ebmr/api-contract';
import { lifecycle } from '@ebmr/recipe-core';
import type { AppContext } from '../../platform/context.ts';
import type { SignableActionHandler, SignableActionRegistry } from '../../platform/ports.ts';
import { dbActHandler, refusedOutcome } from '../esig/db-acts.ts';

type MbrTransition = Extract<SignableAction, { kind: 'MBR_TRANSITION' }>;

const STEPS: Record<MbrTransition['transition'], { meaning: string; expectedState?: string }> = {
  SUBMIT: { meaning: 'PREPARED', expectedState: 'IN_VERIFICATION' },
  CHECK: { meaning: 'CHECKED', expectedState: 'SUBMITTED' },
  REGULATORY_CONFIRM: { meaning: 'REGULATORY_CONFIRMED' },
  APPROVE: { meaning: 'APPROVED', expectedState: 'CHECKED' },
};

export function mbrTransitionHandler(app: AppContext): SignableActionHandler<MbrTransition> {
  return dbActHandler<MbrTransition>(app, {
    kind: 'MBR_TRANSITION',
    aggregateTypes: ['mbr_version'],
    target: (a) => ({ aggregateType: 'mbr_version', aggregateId: a.versionId, ...STEPS[a.transition] }),
    async precheck(client, _ctx, a) {
      const { revision } = await lifecycle.loadContent(client, a.versionId);
      if (revision !== a.baseRevision) {
        return refusedOutcome(409, 'DESIGNER_STALE', 'The master changed since it was shown. Nothing was signed.', `You reviewed revision ${String(a.baseRevision)}; the latest is revision ${String(revision)}.`, ['DI-04', 'DI-37'], ['Reload the master and review it again.']);
      }
      return null;
    },
    async apply(client, _ctx, a, signatureId) {
      if (a.transition === 'REGULATORY_CONFIRM') return { versionId: a.versionId, signed: 'REGULATORY_CONFIRMED' };
      const s = await lifecycle.versionState(client, a.versionId);
      if (!s) throw new Error(`MBR version ${a.versionId} has no state`);
      const run = { SUBMIT: lifecycle.submitVersion, CHECK: lifecycle.checkVersion, APPROVE: lifecycle.approveVersion }[a.transition];
      await run(client, a.versionId, s.version, signatureId);
      return { versionId: a.versionId, state: (await lifecycle.versionState(client, a.versionId))?.state ?? null };
    },
  });
}

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation === 'GMP') registry.register(mbrTransitionHandler(app));
}
