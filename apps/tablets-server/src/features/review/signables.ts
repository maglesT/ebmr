/**
 * The signed acts of the review (Phase 4 slice 1a; signable actions REVIEW_ACT and CORRECTION_APPROVAL). Each signs the
 * record the database act works on and runs that act with the signature in the same transaction; the database decides
 * (recipe-core 0712 to 0716) and a refusal signs nothing (esig/db-acts.ts).
 *
 *   REVIEW_ACT  PRODUCTION_APPROVE  batch_review <batch>                PRODUCTION_APPROVED or PACKAGING_RECORD_APPROVED
 *                                                                       recipe.record_production_approval
 *               QA_REVIEW           batch_review <batch>                QA_REVIEWED    recipe.record_qa_review (expectedEpoch)
 *               AUDIT_TRAIL_REVIEW  batch_audit_review <reviewId>       AUDIT_TRAIL_REVIEWED         recipe.record_audit_trail_review
 *               DELTA_REVIEW        batch_audit_review <reviewId>       DELTA_AUDIT_TRAIL_REVIEWED   recipe.record_audit_trail_review
 *               REOPEN              batch_review_reopen <batch>/<cycle> REVIEW_REOPENED  recipe.reopen_review (the person's reason)
 *               DISPOSE_ITEM        review_items <batch>/<disp>/<sha>/<ids>  REVIEW_ITEMS_DISPOSITIONED  recipe.dispose_review_items
 *   CORRECTION_APPROVAL             batch_point <batch>:<point>         CORRECTION_APPROVED (the signature is the approval;
 *                                                                       the corrector's CORRECT_ENTRY names it)
 */
import { createHash } from 'node:crypto';
import type { ReviewActInput, SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { DryRunOutcome, SignableActionHandler } from '../../platform/ports.ts';
import { dbActHandler, refusedOutcome, type ActTarget } from '../esig/db-acts.ts';

type ReviewAct = Extract<SignableAction, { kind: 'REVIEW_ACT' }>;
type CorrectionApproval = Extract<SignableAction, { kind: 'CORRECTION_APPROVAL' }>;

/** The members each act uses; any other is refused (422). */
const USES: Readonly<Record<ReviewAct['act'], { needs: readonly (keyof ReviewActInput)[]; may: readonly (keyof ReviewActInput)[] }>> = {
  PRODUCTION_APPROVE: { needs: [], may: [] },
  QA_REVIEW: { needs: ['expectedEpoch'], may: [] },
  AUDIT_TRAIL_REVIEW: { needs: ['reviewId'], may: [] },
  DELTA_REVIEW: { needs: ['reviewId'], may: [] },
  REOPEN: { needs: ['reason', 'cycle'], may: [] },
  DISPOSE_ITEM: { needs: ['items', 'disposition'], may: ['justification', 'deviationRef'] },
};

/** As recipe.review_items_aggregate_id (recipe-core 0712): the ids distinct, in code-point order, joined by '+'. */
export function reviewItemsAggregateId(batchId: string, disposition: string, items: readonly string[], justification?: string, deviationRef?: string): string {
  const text = createHash('sha256').update(`${justification ?? ''}\n${deviationRef ?? ''}`, 'utf8').digest('hex');
  const ids = [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `${batchId}/${disposition}/${text}/${ids.join('+')}`;
}

function target(a: ReviewAct): ActTarget {
  const i = a.input;
  switch (a.act) {
    case 'PRODUCTION_APPROVE':
      return { aggregateType: 'batch_review', aggregateId: a.batchId, meaning: '' };
    case 'QA_REVIEW':
      return { aggregateType: 'batch_review', aggregateId: a.batchId, meaning: 'QA_REVIEWED', expectedState: 'PRODUCTION_APPROVED' };
    case 'AUDIT_TRAIL_REVIEW':
      return { aggregateType: 'batch_audit_review', aggregateId: i.reviewId ?? '', meaning: 'AUDIT_TRAIL_REVIEWED' };
    case 'DELTA_REVIEW':
      return { aggregateType: 'batch_audit_review', aggregateId: i.reviewId ?? '', meaning: 'DELTA_AUDIT_TRAIL_REVIEWED' };
    case 'REOPEN':
      return { aggregateType: 'batch_review_reopen', aggregateId: `${a.batchId}/${String(i.cycle ?? 0)}`, meaning: 'REVIEW_REOPENED' };
    case 'DISPOSE_ITEM':
      return {
        aggregateType: 'review_items',
        aggregateId: reviewItemsAggregateId(a.batchId, i.disposition ?? '', i.items ?? [], i.justification, i.deviationRef),
        meaning: 'REVIEW_ITEMS_DISPOSITIONED',
        expectedState: 'PRODUCTION_APPROVED',
      };
  }
}

function inputRefusal(a: ReviewAct): DryRunOutcome | null {
  const u = USES[a.act];
  const given = Object.keys(a.input) as (keyof ReviewActInput)[];
  const extra = given.filter((k) => !u.needs.includes(k) && !u.may.includes(k));
  const missing = u.needs.filter((k) => a.input[k] === undefined);
  const wrongBatch = a.input.reviewId !== undefined && !a.input.reviewId.startsWith(`${a.batchId}/`);
  if (extra.length === 0 && missing.length === 0 && !wrongBatch) return null;
  const why = [missing.length > 0 ? `needs ${missing.join(', ')}` : '', extra.length > 0 ? `takes no ${extra.join(', ')}` : '', wrongBatch ? 'names a review of another batch' : '']
    .filter((x) => x !== '')
    .join(' and ');
  return refusedOutcome(422, 'EBMR-API-ACT-INPUT', 'The act does not carry what it needs. Nothing was signed.', `${a.act} ${why}.`, ['DI-37'], ['Reload the screen and sign again.']);
}

export function reviewActHandler(app: AppContext): SignableActionHandler<ReviewAct> {
  return dbActHandler<ReviewAct>(app, {
    kind: 'REVIEW_ACT',
    aggregateTypes: ['batch_review', 'batch_audit_review', 'batch_review_reopen', 'review_items'],
    target,
    reasonOf: (a) => (a.act === 'REOPEN' && a.input.reason ? { reasonCode: a.input.reason.code, reasonText: a.input.reason.text } : undefined),
    async targetNow(db, a) {
      const t = target(a);
      if (a.act !== 'PRODUCTION_APPROVE') return t;
      // The meaning follows the record's kind (a packaging order's record is PACKAGING_RECORD_APPROVED).
      const { rows } = await db.query<{ k: string | null }>('select recipe.batch_record_kind($1) as k', [a.batchId]);
      return { ...t, meaning: rows[0]?.k === 'PACKAGING' ? 'PACKAGING_RECORD_APPROVED' : 'PRODUCTION_APPROVED' };
    },
    precheck: (_client, _ctx, a) => Promise.resolve(inputRefusal(a)),
    async apply(client, _ctx, a, signatureId) {
      const i = a.input;
      switch (a.act) {
        case 'PRODUCTION_APPROVE':
          await client.query('select recipe.record_production_approval($1, $2)', [a.batchId, signatureId]);
          break;
        case 'QA_REVIEW':
          await client.query('select recipe.record_qa_review($1, $2, $3::bigint)', [a.batchId, signatureId, i.expectedEpoch]);
          break;
        case 'AUDIT_TRAIL_REVIEW':
        case 'DELTA_REVIEW':
          await client.query('select recipe.record_audit_trail_review($1, $2)', [i.reviewId, signatureId]);
          break;
        case 'REOPEN':
          await client.query('select recipe.reopen_review($1, $2, $3)', [a.batchId, signatureId, i.reason?.text ?? '']);
          break;
        case 'DISPOSE_ITEM':
          await client.query('select recipe.dispose_review_items($1, $2::text[], $3, $4, $5, $6)', [
            a.batchId,
            i.items ?? [],
            i.disposition,
            i.justification ?? null,
            i.deviationRef ?? null,
            signatureId,
          ]);
          break;
      }
      return { act: a.act, batchId: a.batchId };
    },
  });
}

export function correctionApprovalHandler(app: AppContext): SignableActionHandler<CorrectionApproval> {
  return dbActHandler<CorrectionApproval>(app, {
    kind: 'CORRECTION_APPROVAL',
    aggregateTypes: ['batch_point'],
    target: (a) => ({ aggregateType: 'batch_point', aggregateId: `${a.batchId}:${a.point}`, meaning: 'CORRECTION_APPROVED', expectedState: 'VALID' }),
    // The signature alone is the approval: the corrector's CORRECT_ENTRY names it, and the engine and the database check
    // that the approver is another person with the authority the correction needs (S25; QA for fail to pass and for a
    // loop reading that missed its endpoint).
    apply: (_client, _ctx, a) => Promise.resolve({ batchId: a.batchId, point: a.point }),
  });
}
