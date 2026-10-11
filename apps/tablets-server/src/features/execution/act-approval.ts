/**
 * ACT_APPROVAL (Phase 3 slice 6, GMP; DI-24, DI-29): the approval of an act proposed on a batch (recipe.propose_act,
 * aggregate batch_act), signed with the act's meaning: VOID_AUTHORISED for a void (S28). The signature alone is the
 * approval: the person who proposed the act then sends it as a command naming the act, and the engine and the database
 * check the approver (another person, QA) and that the act is the one approved (EBMR-EXE-051, 052, 171, ESIG-070).
 */
import type { SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { SignableActionHandler } from '../../platform/ports.ts';
import { recordContentForSigning } from '../esig/content.ts';
import { dbActHandler, refusedOutcome } from '../esig/db-acts.ts';

type ActApproval = Extract<SignableAction, { kind: 'ACT_APPROVAL' }>;

/** The meaning that approves each act type (recipe-core 0450: the approval part of each signed command type). */
export const ACT_MEANINGS: Readonly<Record<string, string>> = { VOID_ATTEMPT: 'VOID_AUTHORISED' };

export function actApprovalHandler(app: AppContext): SignableActionHandler<ActApproval> {
  return dbActHandler<ActApproval>(app, {
    kind: 'ACT_APPROVAL',
    aggregateTypes: ['batch_act'],
    target: (a) => ({ aggregateType: 'batch_act', aggregateId: a.actId, meaning: 'VOID_AUTHORISED' }),
    async precheck(client, ctx, a) {
      if (!a.actId.startsWith(`${a.batchId}:act@`)) {
        return refusedOutcome(422, 'EBMR-API-ACT-OTHER-BATCH', 'This act belongs to another batch. Nothing was signed.', `Act ${a.actId} was not proposed on batch ${a.batchId}.`, ['DI-24'], ['Reload the batch.']);
      }
      const c = await recordContentForSigning(client, 'batch_act', a.actId);
      if (!c.exists || !c.canonical) return null;
      const content = (JSON.parse(c.canonical) as { content?: { act?: { type?: string; requestedBy?: string } } }).content;
      const type = content?.act?.type ?? '';
      if (ACT_MEANINGS[type] === undefined) {
        return refusedOutcome(422, 'EBMR-API-ACT-TYPE', 'This act is not approved through this screen. Nothing was signed.', `A ${type} is approved elsewhere.`, ['DI-24'], ['Use the screen of that act.']);
      }
      if (content?.act?.requestedBy === ctx.actor.personId) {
        return refusedOutcome(422, 'EBMR-EXE-052', 'A void is approved by another person than the one who asks for it. Nothing was signed.', 'The approver may not be the requester (DI-29).', ['DI-29', 'DI-24'], ['Ask QA to approve it.']);
      }
      return null;
    },
    apply: (_client, _ctx, a) => Promise.resolve({ actId: a.actId }),
  });
}
