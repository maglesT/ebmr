/**
 * The signed acts of the release (Phase 4 slices 3a and 4a; signable actions RELEASE_ACT and BATCH_MARKET_ACT). Each signs
 * the record the database act works on and runs that act with the signature in the same transaction; the database
 * decides (recipe-core 0781, 0821 to 0824) and a refusal signs nothing (esig/db-acts.ts).
 *
 *   MANUFACTURER_RELEASE   manufacturer_release <lot>/RELEASE        MANUFACTURER_RELEASE   recipe.record_manufacturer_release
 *                          (expectedEpoch; a named delegate cites delegationId, checked by the kernel and again by the act)
 *                          with usExpectedEpoch (D-P4-5): two rows in one ceremony, the companion us_disposition <lot>/RELEASE
 *                          US_DISPOSITION; recipe.record_release_with_us_disposition
 *   MANUFACTURER_REJECT    manufacturer_release <lot>/REJECT         MANUFACTURER_RELEASE   the same act, with the reason
 *   POST_CHANGE_EVALUATE   post_change_evaluation <batch>/<sha256 of the text>      POST_CHANGE_EVALUATED
 *   PPQ_OUTCOME            ppq_outcome <batch>/<outcome>/<sha256 of protocol, LF, text>  VALIDATION_OUTCOME_RECORDED
 *   INVESTIGATION_JUSTIFY  investigation_justification <lot>/IN/<deviation>/<sha256 of the text>  OPEN_INVESTIGATION_JUSTIFIED
 *   US_DISPOSE             us_disposition <lot>/<RELEASE|REJECT>     US_DISPOSITION (QCU)   recipe.record_us_disposition
 *   QP_INTAKE              qp_transcription <lot>/<sha256 of the details>  QP_CERTIFICATION_RECORDED  recipe.record_qp_transcription
 *   QP_INTAKE_VERIFY       qp_transcription_check <intake>           QP_CERTIFICATION_VERIFIED  recipe.verify_qp_transcription
 *   QP_CERTIFY             qp_certification <lot>/<outcome>          QP_CERTIFIED or QP_REJECTED (registered QP, switch on)  recipe.record_qp_certification
 *   MARKET_ADD, MARKET_REMOVE  market_change LOT/<lot>/<ADD|REMOVE>/<market>/<n>   MARKET_ADDED, MARKET_REMOVED  recipe.record_market_change
 *   BATCH_MARKET_ACT       market_change BATCH/<batch>/<ADD|REMOVE>/<market>/<n>  the same, for an issued batch
 * The recall and disposal acts arrive with slice 5 (501 until then).
 */
import { createHash } from 'node:crypto';
import type { ReleaseActInput, SignableAction } from '@ebmr/api-contract';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import type { DryRunOutcome, SignableActionHandler } from '../../platform/ports.ts';
import { dbActHandler, refusedOutcome, type ActTarget } from '../esig/db-acts.ts';

type ReleaseAct = Extract<SignableAction, { kind: 'RELEASE_ACT' }>;
type BuiltAct =
  | 'MANUFACTURER_RELEASE'
  | 'MANUFACTURER_REJECT'
  | 'POST_CHANGE_EVALUATE'
  | 'PPQ_OUTCOME'
  | 'INVESTIGATION_JUSTIFY'
  | 'US_DISPOSE'
  | 'QP_INTAKE'
  | 'QP_INTAKE_VERIFY'
  | 'QP_CERTIFY'
  | 'MARKET_ADD'
  | 'MARKET_REMOVE';

/** The members each built act uses; any other is refused (422). */
const USES: Readonly<Record<BuiltAct, { needs: readonly (keyof ReleaseActInput)[]; may: readonly (keyof ReleaseActInput)[] }>> = {
  MANUFACTURER_RELEASE: { needs: ['expectedEpoch'], may: ['delegationId', 'usExpectedEpoch'] },
  MANUFACTURER_REJECT: { needs: ['expectedEpoch', 'reason'], may: ['delegationId'] },
  POST_CHANGE_EVALUATE: { needs: ['batchId', 'text'], may: [] },
  PPQ_OUTCOME: { needs: ['batchId', 'outcome', 'protocolRef', 'text'], may: [] },
  INVESTIGATION_JUSTIFY: { needs: ['deviationId', 'text'], may: [] },
  US_DISPOSE: { needs: ['usDecision', 'expectedEpoch'], may: ['reason', 'deviationId'] },
  QP_INTAKE: { needs: ['qpOutcome', 'certification'], may: ['reason'] },
  QP_INTAKE_VERIFY: { needs: ['intakeId'], may: [] },
  QP_CERTIFY: { needs: ['qpOutcome', 'expectedEpoch'], may: ['reason'] },
  MARKET_ADD: { needs: ['market', 'changeRecordId'], may: [] },
  MARKET_REMOVE: { needs: ['market', 'deviationId'], may: [] },
};

const isBuilt = (act: ReleaseAct['act']): act is BuiltAct => act in USES;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** As recipe.qp_details_sha256 computes it: the details as entered, trimmed, one per line. */
export function qpDetailsSha256(i: ReleaseActInput): string {
  const c = i.certification;
  return sha256([i.qpOutcome ?? '', c?.certifier ?? '', c?.miaNumber ?? '', c?.certifiedAt ?? '', c?.reference ?? '', i.reason?.text ?? ''].map((x) => x.trim()).join('\n'));
}

/** As the database computes them (recipe-core 0781, 0822, 0824): the aggregate ids of the release acts. */
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
    case 'US_DISPOSE':
      return `${a.lotId}/${i.usDecision ?? ''}`;
    case 'QP_INTAKE':
      return `${a.lotId}/${qpDetailsSha256(i)}`;
    case 'QP_INTAKE_VERIFY':
      return i.intakeId ?? '';
    case 'QP_CERTIFY':
      return `${a.lotId}/${i.qpOutcome ?? ''}`;
    case 'MARKET_ADD':
    case 'MARKET_REMOVE':
      // The sequence is the database's (recipe.market_change_next_id); targetNow reads it.
      return `LOT/${a.lotId}/${a.act === 'MARKET_ADD' ? 'ADD' : 'REMOVE'}/${i.market ?? ''}`;
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
    case 'US_DISPOSE':
      return { aggregateType: 'us_disposition', aggregateId: id, meaning: 'US_DISPOSITION' };
    case 'QP_INTAKE':
      return { aggregateType: 'qp_transcription', aggregateId: id, meaning: 'QP_CERTIFICATION_RECORDED' };
    case 'QP_INTAKE_VERIFY':
      return { aggregateType: 'qp_transcription_check', aggregateId: id, meaning: 'QP_CERTIFICATION_VERIFIED', expectedState: 'TRANSCRIBED' };
    case 'QP_CERTIFY':
      return { aggregateType: 'qp_certification', aggregateId: id, meaning: a.input.qpOutcome === 'REJECTED_BY_QP' ? 'QP_REJECTED' : 'QP_CERTIFIED' };
    case 'MARKET_ADD':
    case 'MARKET_REMOVE':
      return { aggregateType: 'market_change', aggregateId: id, meaning: a.act === 'MARKET_ADD' ? 'MARKET_ADDED' : 'MARKET_REMOVED' };
    default:
      return { aggregateType: 'manufacturer_release', aggregateId: `${a.lotId}/${a.act}`, meaning: '' };
  }
}

/** A market change's record, with the subject's next sequence number read now. */
async function marketChangeTarget(db: pg.Pool | pg.PoolClient, kind: 'LOT' | 'BATCH', id: string, change: 'ADD' | 'REMOVE', market: string): Promise<ActTarget> {
  const { rows } = await db.query<{ a: string; s: string }>(
    "select recipe.market_change_next_id($1, $2, $3, $4) as a, case when $4 = any (coalesce(recipe.market_set($1, $2), '{}')) then 'IN_SET' else 'NOT_IN_SET' end as s",
    [kind, id, change, market],
  );
  return { aggregateType: 'market_change', aggregateId: rows[0]!.a, meaning: change === 'ADD' ? 'MARKET_ADDED' : 'MARKET_REMOVED', expectedState: rows[0]!.s };
}

function inputRefusal(a: ReleaseAct): DryRunOutcome | null {
  if (!isBuilt(a.act)) {
    return refusedOutcome(501, 'NOT_IMPLEMENTED', 'This release act is not available yet. Nothing was signed.', `${a.act} arrives with Phase 4 slice 5.`, ['IN-05'], ['Use another path for now.']);
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
    aggregateTypes: ['manufacturer_release', 'post_change_evaluation', 'ppq_outcome', 'investigation_justification', 'us_disposition', 'qp_transcription',
                     'qp_transcription_check', 'qp_certification', 'market_change'],
    target,
    targetNow: (db, a) =>
      a.act === 'MARKET_ADD' || a.act === 'MARKET_REMOVE'
        ? marketChangeTarget(db, 'LOT', a.lotId, a.act === 'MARKET_ADD' ? 'ADD' : 'REMOVE', a.input.market ?? '')
        : Promise.resolve(target(a)),
    // D-P4-5: the AP who also holds the QCU permission releases for the US in the same ceremony.
    companionOf: (a) =>
      a.act === 'MANUFACTURER_RELEASE' && a.input.usExpectedEpoch !== undefined
        ? { aggregateType: 'us_disposition', aggregateId: `${a.lotId}/RELEASE`, meaning: 'US_DISPOSITION' }
        : undefined,
    reasonOf: (a) =>
      (a.act === 'MANUFACTURER_REJECT' || a.act === 'US_DISPOSE' || a.act === 'QP_INTAKE' || a.act === 'QP_CERTIFY') && a.input.reason
        ? { reasonCode: a.input.reason.code, reasonText: a.input.reason.text }
        : undefined,
    delegationOf: (a) => (a.act === 'MANUFACTURER_RELEASE' || a.act === 'MANUFACTURER_REJECT' ? a.input.delegationId : undefined),
    precheck: (_client, _ctx, a) => Promise.resolve(inputRefusal(a)),
    async apply(client, _ctx, a, signatureId, companionSignatureId) {
      const i = a.input;
      switch (a.act) {
        case 'MANUFACTURER_RELEASE':
          if (i.usExpectedEpoch !== undefined) {
            if (!companionSignatureId) throw new Error('a two-row release needs its US_DISPOSITION signature');
            await client.query('select recipe.record_release_with_us_disposition($1, $2, $3, $4, $5)', [a.lotId, signatureId, companionSignatureId, i.expectedEpoch, i.usExpectedEpoch]);
            break;
          }
          await client.query("select recipe.record_manufacturer_release($1, 'RELEASE', $2, $3, null)", [a.lotId, signatureId, i.expectedEpoch]);
          break;
        case 'MANUFACTURER_REJECT':
          await client.query("select recipe.record_manufacturer_release($1, 'REJECT', $2, $3, $4)", [a.lotId, signatureId, i.expectedEpoch, i.reason?.text ?? null]);
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
        case 'US_DISPOSE':
          await client.query('select recipe.record_us_disposition($1, $2, $3, $4, $5, $6)', [a.lotId, i.usDecision, signatureId, i.expectedEpoch, i.reason?.text ?? null, i.deviationId ?? null]);
          break;
        case 'QP_INTAKE': {
          const c = i.certification;
          const { rows } = await client.query<{ id: string }>('select recipe.record_qp_transcription($1, $2, $3, $4, $5, $6, $7, $8) as id', [
            a.lotId, i.qpOutcome, c?.certifier, c?.miaNumber, c?.certifiedAt, c?.reference, i.reason?.text ?? null, signatureId,
          ]);
          return { act: a.act, lotId: a.lotId, intakeId: rows[0]?.id ?? null };
        }
        case 'QP_INTAKE_VERIFY':
          await client.query('select recipe.verify_qp_transcription($1, $2)', [i.intakeId, signatureId]);
          break;
        case 'QP_CERTIFY':
          await client.query('select recipe.record_qp_certification($1, $2, $3, $4, $5)', [a.lotId, i.qpOutcome, signatureId, i.expectedEpoch, i.reason?.text ?? null]);
          break;
        case 'MARKET_ADD':
        case 'MARKET_REMOVE':
          await client.query("select recipe.record_market_change('LOT', $1, $2, $3, $4, $5)", [
            a.lotId, a.act === 'MARKET_ADD' ? 'ADD' : 'REMOVE', i.market, a.act === 'MARKET_ADD' ? i.changeRecordId : i.deviationId, signatureId,
          ]);
          break;
        default:
          throw new Error(`release act ${a.act} is not built`);
      }
      return { act: a.act, lotId: a.lotId };
    },
  });
}

type BatchMarketAct = Extract<SignableAction, { kind: 'BATCH_MARKET_ACT' }>;

/** BATCH_MARKET_ACT: market_change BATCH/<batch>/<ADD|REMOVE>/<market>/<n> (3.3.3; recipe-core 0821). */
export function batchMarketActHandler(app: AppContext): SignableActionHandler<BatchMarketAct> {
  const change = (a: BatchMarketAct): 'ADD' | 'REMOVE' => (a.act === 'MARKET_ADD' ? 'ADD' : 'REMOVE');
  return dbActHandler<BatchMarketAct>(app, {
    kind: 'BATCH_MARKET_ACT',
    aggregateTypes: ['market_change'],
    target: (a) => ({ aggregateType: 'market_change', aggregateId: `BATCH/${a.batchId}/${change(a)}/${a.input.market}`, meaning: a.act === 'MARKET_ADD' ? 'MARKET_ADDED' : 'MARKET_REMOVED' }),
    targetNow: (db, a) => marketChangeTarget(db, 'BATCH', a.batchId, change(a), a.input.market),
    precheck: (_client, _ctx, a) => {
      const ref = a.act === 'MARKET_ADD' ? a.input.changeRecordId : a.input.deviationId;
      const other = a.act === 'MARKET_ADD' ? a.input.deviationId : a.input.changeRecordId;
      if (ref !== undefined && other === undefined) return Promise.resolve(null);
      return Promise.resolve(
        refusedOutcome(422, 'EBMR-API-ACT-INPUT', 'The act does not carry what it needs. Nothing was signed.',
          a.act === 'MARKET_ADD' ? 'A market is added under a change record (changeRecordId), never a deviation.' : 'A market is removed with a linked deviation (deviationId), never a change record.',
          ['DI-37'], ['Reload the screen and sign again.']),
      );
    },
    async apply(client, _ctx, a, signatureId) {
      await client.query('select recipe.record_market_change($1, $2, $3, $4, $5, $6)', [
        'BATCH', a.batchId, change(a), a.input.market, a.act === 'MARKET_ADD' ? a.input.changeRecordId : a.input.deviationId, signatureId,
      ]);
      return { act: a.act, batchId: a.batchId };
    },
  });
}
