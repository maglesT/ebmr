/**
 * The signed acts of the release (Phase 4 slice 3a; signable action RELEASE_ACT). Each signs the record the database act
 * works on and runs that act with the signature in the same transaction; the database decides (recipe-core 0781) and a
 * refusal signs nothing (esig/db-acts.ts).
 *
 *   MANUFACTURER_RELEASE   manufacturer_release <lot>/RELEASE        MANUFACTURER_RELEASE   recipe.record_manufacturer_release
 *                          (expectedEpoch; a named delegate cites delegationId, checked by the kernel and again by the act)
 *   MANUFACTURER_REJECT    manufacturer_release <lot>/REJECT         MANUFACTURER_RELEASE   the same act, with the reason
 *   POST_CHANGE_EVALUATE   post_change_evaluation <batch>/<sha256 of the text>      POST_CHANGE_EVALUATED
 *   PPQ_OUTCOME            ppq_outcome <batch>/<outcome>/<sha256 of protocol, LF, text>  VALIDATION_OUTCOME_RECORDED
 *   INVESTIGATION_JUSTIFY  investigation_justification <lot>/IN/<deviation>/<sha256 of the text>  OPEN_INVESTIGATION_JUSTIFIED
 * The market, recall and disposal acts arrive with slices 4 and 5 (501 until then).
 */
import { createHash } from 'node:crypto';
import type { ReleaseActInput, SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { DryRunOutcome, SignableActionHandler } from '../../platform/ports.ts';
import { dbActHandler, refusedOutcome, type ActTarget } from '../esig/db-acts.ts';

type ReleaseAct = Extract<SignableAction, { kind: 'RELEASE_ACT' }>;
type BuiltAct = 'MANUFACTURER_RELEASE' | 'MANUFACTURER_REJECT' | 'POST_CHANGE_EVALUATE' | 'PPQ_OUTCOME' | 'INVESTIGATION_JUSTIFY';

/** The members each built act uses; any other is refused (422). */
const USES: Readonly<Record<BuiltAct, { needs: readonly (keyof ReleaseActInput)[]; may: readonly (keyof ReleaseActInput)[] }>> = {
  MANUFACTURER_RELEASE: { needs: ['expectedEpoch'], may: ['delegationId'] },
  MANUFACTURER_REJECT: { needs: ['expectedEpoch', 'reason'], may: ['delegationId'] },
  POST_CHANGE_EVALUATE: { needs: ['batchId', 'text'], may: [] },
  PPQ_OUTCOME: { needs: ['batchId', 'outcome', 'protocolRef', 'text'], may: [] },
  INVESTIGATION_JUSTIFY: { needs: ['deviationId', 'text'], may: [] },
};

const isBuilt = (act: ReleaseAct['act']): act is BuiltAct => act in USES;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** As the database computes them (recipe-core 0781): the text hashes in the aggregate ids of the release-side acts. */
export function releaseActAggregateId(a: ReleaseAct): string {
  const i = a.input;
  switch (a.act) {
    case 'MANUFACTURER_RELEASE':
      return `${a.lotId}/RELEASE`;
    case 'MANUFACTURER_REJECT':
      return `${a.lotId}/REJECT`;
    case 'POST_CHANGE_EVALUATE':
      return `${i.batchId ?? ''}/${sha256((i.text ?? '').trim())}`;
    case 'PPQ_OUTCOME':
      return `${i.batchId ?? ''}/${i.outcome ?? ''}/${sha256(`${(i.protocolRef ?? '').trim()}\n${(i.text ?? '').trim()}`)}`;
    case 'INVESTIGATION_JUSTIFY':
      return `${a.lotId}/IN/${i.deviationId ?? ''}/${sha256((i.text ?? '').trim())}`;
    default:
      return a.lotId;
  }
}

function target(a: ReleaseAct): ActTarget {
  const id = releaseActAggregateId(a);
  switch (a.act) {
    case 'MANUFACTURER_RELEASE':
    case 'MANUFACTURER_REJECT':
      return { aggregateType: 'manufacturer_release', aggregateId: id, meaning: 'MANUFACTURER_RELEASE' };
    case 'POST_CHANGE_EVALUATE':
      return { aggregateType: 'post_change_evaluation', aggregateId: id, meaning: 'POST_CHANGE_EVALUATED' };
    case 'PPQ_OUTCOME':
      return { aggregateType: 'ppq_outcome', aggregateId: id, meaning: 'VALIDATION_OUTCOME_RECORDED' };
    case 'INVESTIGATION_JUSTIFY':
      return { aggregateType: 'investigation_justification', aggregateId: id, meaning: 'OPEN_INVESTIGATION_JUSTIFIED' };
    default:
      return { aggregateType: 'manufacturer_release', aggregateId: `${a.lotId}/${a.act}`, meaning: '' };
  }
}

function inputRefusal(a: ReleaseAct): DryRunOutcome | null {
  if (!isBuilt(a.act)) {
    return refusedOutcome(501, 'NOT_IMPLEMENTED', 'This release act is not available yet. Nothing was signed.', `${a.act} arrives with Phase 4 slice 4 or 5.`, ['IN-05'], ['Use another path for now.']);
  }
  const u = USES[a.act];
  const given = Object.keys(a.input) as (keyof ReleaseActInput)[];
  const extra = given.filter((k) => !u.needs.includes(k) && !u.may.includes(k));
  const missing = u.needs.filter((k) => a.input[k] === undefined);
  if (extra.length === 0 && missing.length === 0) return null;
  const why = [missing.length > 0 ? `needs ${missing.join(', ')}` : '', extra.length > 0 ? `takes no ${extra.join(', ')}` : ''].filter((x) => x !== '').join(' and ');
  return refusedOutcome(422, 'EBMR-API-ACT-INPUT', 'The act does not carry what it needs. Nothing was signed.', `${a.act} ${why}.`, ['DI-37'], ['Reload the screen and sign again.']);
}

export function releaseActHandler(app: AppContext): SignableActionHandler<ReleaseAct> {
  return dbActHandler<ReleaseAct>(app, {
    kind: 'RELEASE_ACT',
    aggregateTypes: ['manufacturer_release', 'post_change_evaluation', 'ppq_outcome', 'investigation_justification'],
    target,
    reasonOf: (a) => (a.act === 'MANUFACTURER_REJECT' && a.input.reason ? { reasonCode: a.input.reason.code, reasonText: a.input.reason.text } : undefined),
    delegationOf: (a) => (a.act === 'MANUFACTURER_RELEASE' || a.act === 'MANUFACTURER_REJECT' ? a.input.delegationId : undefined),
    precheck: (_client, _ctx, a) => Promise.resolve(inputRefusal(a)),
    async apply(client, _ctx, a, signatureId) {
      const i = a.input;
      switch (a.act) {
        case 'MANUFACTURER_RELEASE':
        case 'MANUFACTURER_REJECT':
          await client.query('select recipe.record_manufacturer_release($1, $2, $3, $4, $5)', [
            a.lotId,
            a.act === 'MANUFACTURER_RELEASE' ? 'RELEASE' : 'REJECT',
            signatureId,
            i.expectedEpoch,
            i.reason?.text ?? null,
          ]);
          break;
        case 'POST_CHANGE_EVALUATE':
          await client.query('select recipe.record_post_change_evaluation($1, $2, $3)', [i.batchId, i.text, signatureId]);
          break;
        case 'PPQ_OUTCOME':
          await client.query('select recipe.record_ppq_outcome($1, $2, $3, $4, $5)', [i.batchId, i.outcome, i.protocolRef, i.text, signatureId]);
          break;
        case 'INVESTIGATION_JUSTIFY':
          await client.query("select recipe.justify_open_investigation($1, 'IN', $2, $3, $4)", [a.lotId, i.deviationId, i.text, signatureId]);
          break;
        default:
          throw new Error(`release act ${a.act} is not built`);
      }
      return { act: a.act, lotId: a.lotId };
    },
  });
}

type BatchMarketAct = Extract<SignableAction, { kind: 'BATCH_MARKET_ACT' }>;

/** BATCH_MARKET_ACT (slice 4-0): market_change BATCH/<batch>/<ADD|REMOVE>/<market>; 501 until slice 4a builds it. */
export function batchMarketActHandler(app: AppContext): SignableActionHandler<BatchMarketAct> {
  return dbActHandler<BatchMarketAct>(app, {
    kind: 'BATCH_MARKET_ACT',
    aggregateTypes: ['market_change'],
    target: (a) => ({
      aggregateType: 'market_change',
      aggregateId: `BATCH/${a.batchId}/${a.act === 'MARKET_ADD' ? 'ADD' : 'REMOVE'}/${a.input.market}`,
      meaning: a.act === 'MARKET_ADD' ? 'MARKET_ADDED' : 'MARKET_REMOVED',
    }),
    precheck: () =>
      Promise.resolve(refusedOutcome(501, 'NOT_IMPLEMENTED', 'This market act is not available yet. Nothing was signed.', 'Market add and removal arrive with Phase 4 slice 4a.', ['INV-43'], ['Use another path for now.'])),
    apply: () => Promise.reject(new Error('BATCH_MARKET_ACT is not built yet')),
  });
}
