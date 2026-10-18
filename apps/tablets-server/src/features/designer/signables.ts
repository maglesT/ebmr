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
import { signaturesOf } from '../esig/views.ts';

/** A signature id that names no signature: the database refuses it as it refuses any invalid one. */
const NO_SIGNATURE = '00000000-0000-0000-0000-000000000000';

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

type MbrMarketAct = Extract<SignableAction, { kind: 'MBR_MARKET_ACT' }>;
type SpecimenAct = Extract<SignableAction, { kind: 'SPECIMEN_ACT' }>;

/**
 * Phase 7 slice 7g-2 (decision 0025; recipe-core 0160, 0290; ADR 0014): the two signatures of a market authorisation.
 *   act                 meaning                 expected state   command
 *   REGULATORY_CONFIRM  REGULATORY_CONFIRMED    PROPOSED         none: the signature on the record is the confirmation
 *   AUTHORISE           MBR_MARKET_AUTHORISED   PROPOSED         recipe.activate_market_authorisation with the record's
 *                                                                latest valid regulatory confirmation and QA's own reason
 * The database refuses an activation without a valid confirmation, by another person than the QA signer, or by the same
 * person as the regulatory signer (EBMR-RCP-083 to 087): the whole command rolls back and nothing is signed.
 */
export function mbrMarketActHandler(app: AppContext): SignableActionHandler<MbrMarketAct> {
  return dbActHandler<MbrMarketAct>(app, {
    kind: 'MBR_MARKET_ACT',
    aggregateTypes: [lifecycle.MARKET_AUTHORISATION_AGGREGATE],
    target: (a) => ({
      aggregateType: lifecycle.MARKET_AUTHORISATION_AGGREGATE, aggregateId: a.authorisationId,
      meaning: a.act === 'AUTHORISE' ? 'MBR_MARKET_AUTHORISED' : 'REGULATORY_CONFIRMED', expectedState: 'PROPOSED',
    }),
    reasonOf: (a) => (a.act === 'AUTHORISE' && a.reason ? { reasonCode: a.reason.code, reasonText: a.reason.text } : undefined),
    async precheck(client, _ctx, a) {
      if (a.act === 'AUTHORISE' && !a.reason) {
        return refusedOutcome(422, 'EBMR-AUDIT-002', 'The authorisation needs your own reason. Nothing was signed.', 'Activating a market authorisation records why, in your words (DI-22).', ['DI-22'], ['Give the reason code and text, then sign again.']);
      }
      if (a.act === 'REGULATORY_CONFIRM' && a.reason) {
        return refusedOutcome(422, 'SCHEMA', 'A regulatory confirmation carries no reason. Nothing was signed.', 'Only the QA authorisation activates the record and records a reason.', ['DI-22'], ['Sign again without a reason.']);
      }
      // The order of the two signatures, said before anything is signed (the database checks both again at activation).
      if (a.act === 'AUTHORISE' && !(await signaturesOf(client, lifecycle.MARKET_AUTHORISATION_AGGREGATE, a.authorisationId)).some((s) => s.valid && s.meaning === 'REGULATORY_CONFIRMED')) {
        return refusedOutcome(409, 'EBMR-RCP-085', 'The registration of this market is not confirmed yet. Nothing was signed.', 'QA authorises a market only after the regulatory-conformity signer has confirmed its registration (ADR 0014).', ['PR-04'], ['Ask the regulatory-conformity signer to confirm the registration, then authorise.']);
      }
      return null;
    },
    async apply(client, _ctx, a, signatureId) {
      if (a.act === 'REGULATORY_CONFIRM') return { authorisationId: a.authorisationId, signed: 'REGULATORY_CONFIRMED' };
      // The record's latest valid regulatory confirmation; without one the database refuses the activation (no
      // signature to assert) and nothing is signed.
      const reg = (await signaturesOf(client, lifecycle.MARKET_AUTHORISATION_AGGREGATE, a.authorisationId)).filter((s) => s.valid && s.meaning === 'REGULATORY_CONFIRMED').at(-1);
      const r = await lifecycle.activateMarketAuthorisation(client, a.authorisationId, signatureId, reg?.signatureId ?? NO_SIGNATURE);
      return { authorisationId: r.authorisationId, market: r.market, effectiveFrom: r.effectiveFrom };
    },
  });
}

/** Phase 7 slice 7g-2 (tablets 1479; DI-35): QA's SPECIMEN_APPROVED on a labelling specimen; tab.approve_labelling_specimen decides. */
export function specimenActHandler(app: AppContext): SignableActionHandler<SpecimenAct> {
  return dbActHandler<SpecimenAct>(app, {
    kind: 'SPECIMEN_ACT',
    aggregateTypes: ['labelling_specimen'],
    target: (a) => ({ aggregateType: 'labelling_specimen', aggregateId: a.documentId, meaning: 'SPECIMEN_APPROVED', expectedState: 'RECORDED' }),
    async apply(client, _ctx, a, signatureId) {
      await client.query('select tab.approve_labelling_specimen($1, $2)', [a.documentId, signatureId]);
      return { documentId: a.documentId, state: 'APPROVED' };
    },
  });
}

export function registerSignableActions(registry: SignableActionRegistry, app: AppContext): void {
  if (app.installation !== 'GMP') return;
  registry.register(mbrTransitionHandler(app));
  registry.register(mbrMarketActHandler(app));
  registry.register(specimenActHandler(app));
}
