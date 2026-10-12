/**
 * The signed acts of quality, lots and reprocessing over HTTP (Phase 3 slice 6a; signable actions QUALITY_ACT,
 * LOT_DECISION, REPROCESSING_ACT). Each signs the record the database command acts on with the existing meaning, and
 * runs that command with the signature; the database decides (who may sign, the second person, the record's state) and a
 * refusal signs nothing (esig/db-acts.ts).
 *
 *   QUALITY_ACT  DEVIATION_IMPACT_ASSESS  deviation <id>          DEVIATION_IMPACT_ASSESSED  site.assess_deviation_impact
 *                DEVIATION_CONCLUDE   deviation <id>              DEVIATION_CONCLUDED      site.conclude_deviation
 *                DEVIATION_CLOSE      deviation <id>              DEVIATION_CLOSED         site.close_deviation
 *                LOT_RESULT_APPROVE   lot_test_result <id>        QC_RESULT_APPROVED       site.approve_lot_test_result
 *                QC_EXTRA_TESTING_DECISION  qc_extra_testing <batch>/<decision>/<tests>   QC_EXTRA_TESTING_DECIDED
 *                                                                                           site.record_qc_extra_testing_decision
 *                LOT_RETEST           lot_retest <lot>/<instant>/<results>   LOT_RETEST_APPROVED
 *                                                                                           site.record_signed_lot_retest
 *                                     (site-services 0762: the signed content binds the new instant and the results)
 *   LOT_DECISION RELEASE              material_lot <id>           MATERIAL_LOT_RELEASED    site.change_lot_status
 *                REJECT               material_lot <id>           MATERIAL_LOT_REJECTED from every state (the lot's machine)
 *                HOLD, UNHOLD, RETURN, RECALL  material_lot <id>  MATERIAL_LOT_STATUS_DECIDED over the proposed decision
 *                                     (site-services 0800; proposed first over HTTP, specifications.proposeLotDecision)
 *   REPROCESSING_ACT RESERVE_RESIDUE  output_container <id>       RESIDUE_RESERVED         recipe.reserve_residue
 *                AUTHORISE_ADDITION   reprocessing_authorisation  REPROCESSING_AUTHORISED  recipe.authorise_reprocessing
 *                AUTHORISE_REQUEST    reprocessing_request        REPROCESSING_AUTHORISED  recipe.authorise_reprocessing_request
 */
import type pg from 'pg';
import type { SignableAction } from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import type { DryRunOutcome, SignableActionHandler } from '../../platform/ports.ts';
import { dbActHandler, refusedOutcome, type ActTarget } from '../esig/db-acts.ts';

type QualityAct = Extract<SignableAction, { kind: 'QUALITY_ACT' }>;
type LotDecision = Extract<SignableAction, { kind: 'LOT_DECISION' }>;
type ReprocessingAct = Extract<SignableAction, { kind: 'REPROCESSING_ACT' }>;

/** As site.qc_test_codes and site.qc_extra_testing_aggregate_id (0733): the tests distinct and sorted, joined by '+'. */
export function extraTestingAggregateId(batchId: string, decision: string, tests: readonly string[]): string {
  const codes = [...new Set(tests)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `${batchId}/${decision}/${codes.join('+')}`;
}

const QUALITY: Readonly<Record<QualityAct['act'], { aggregateType: string; meaning: string; uses: readonly (keyof QualityAct['input'])[] }>> = {
  DEVIATION_IMPACT_ASSESS: { aggregateType: 'deviation', meaning: 'DEVIATION_IMPACT_ASSESSED', uses: [] },
  DEVIATION_CONCLUDE: { aggregateType: 'deviation', meaning: 'DEVIATION_CONCLUDED', uses: [] },
  DEVIATION_CLOSE: { aggregateType: 'deviation', meaning: 'DEVIATION_CLOSED', uses: [] },
  LOT_RESULT_APPROVE: { aggregateType: 'lot_test_result', meaning: 'QC_RESULT_APPROVED', uses: [] },
  QC_EXTRA_TESTING_DECISION: { aggregateType: 'qc_extra_testing', meaning: 'QC_EXTRA_TESTING_DECIDED', uses: ['decision', 'tests'] },
  LOT_RETEST: { aggregateType: 'lot_retest', meaning: 'LOT_RETEST_APPROVED', uses: ['retestAt', 'results'] },
};

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The instant as site.utc_text (0700) writes it: UTC, microseconds. */
function utcMicro(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

/** As site.lot_retest_aggregate_id (0762): the lot, the new retest instant, the result ids distinct and sorted joined by '+'. */
export function lotRetestAggregateId(lotId: string, retestAt: string, results: readonly string[]): string {
  const ids = [...new Set(results.map((r) => r.toLowerCase()))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `${lotId}/${utcMicro(retestAt)}/${ids.join('+')}`;
}

function qualityTarget(a: QualityAct): ActTarget {
  const q = QUALITY[a.act];
  const id =
    a.act === 'QC_EXTRA_TESTING_DECISION'
      ? extraTestingAggregateId(a.subjectId, a.input.decision ?? '', a.input.tests ?? [])
      : a.act === 'LOT_RETEST'
        ? lotRetestAggregateId(a.subjectId, a.input.retestAt ?? '', a.input.results ?? [])
        : a.subjectId;
  return { aggregateType: q.aggregateType, aggregateId: id, meaning: q.meaning };
}

function inputRefusal(a: QualityAct): DryRunOutcome | null {
  const uses = QUALITY[a.act].uses;
  const extra = Object.keys(a.input).filter((k) => !uses.includes(k as keyof QualityAct['input']));
  const missing = a.act === 'QC_EXTRA_TESTING_DECISION' ? (a.input.decision === undefined ? ['decision'] : []) : a.act === 'LOT_RETEST' ? ['retestAt', 'results'].filter((k) => !(k in a.input)) : [];
  if (extra.length === 0 && missing.length === 0) return null;
  return refusedOutcome(
    422,
    'EBMR-API-ACT-INPUT',
    'The act does not carry what it needs. Nothing was signed.',
    `${a.act} ${missing.length > 0 ? `needs ${missing.join(', ')}` : ''}${missing.length > 0 && extra.length > 0 ? ' and ' : ''}${extra.length > 0 ? `takes no ${extra.join(', ')}` : ''}.`,
    ['DI-37'],
    ['Reload the screen and sign again.'],
  );
}

export function qualityActHandler(app: AppContext): SignableActionHandler<QualityAct> {
  return dbActHandler<QualityAct>(app, {
    kind: 'QUALITY_ACT',
    aggregateTypes: ['deviation', 'lot_test_result', 'qc_extra_testing', 'lot_retest'],
    target: qualityTarget,
    async targetNow(db, a) {
      if (a.act === 'LOT_RETEST') {
        // The database names the aggregate (its instant text and id order); a malformed input is refused by precheck or apply.
        const { rows } = await db
          .query<{ id: string | null }>('select site.lot_retest_aggregate_id($1::uuid, $2::timestamptz, $3::uuid[]) as id', [a.subjectId, a.input.retestAt ?? null, a.input.results ?? []])
          .catch(() => ({ rows: [] as { id: string | null }[] }));
        return { ...qualityTarget(a), aggregateId: rows[0]?.id ?? qualityTarget(a).aggregateId };
      }
      if (a.act !== 'QC_EXTRA_TESTING_DECISION') return qualityTarget(a);
      const { rows } = await db.query<{ id: string | null }>('select site.qc_extra_testing_aggregate_id($1, $2, $3::text[]) as id', [a.subjectId, a.input.decision ?? '', a.input.tests ?? []]);
      return { ...qualityTarget(a), aggregateId: rows[0]?.id ?? qualityTarget(a).aggregateId };
    },
    async precheck(client, _ctx, a) {
      const refusal = inputRefusal(a);
      if (refusal || a.act !== 'LOT_RETEST') return refusal;
      // The signed aggregate names the instant and the results exactly as the database does (0762), or nothing is signed.
      const at = a.input.retestAt ?? '';
      const ids = a.input.results ?? [];
      const wellFormed = ISO_INSTANT.test(at) && UUID.test(a.subjectId) && ids.every((r) => UUID.test(r));
      const rows = wellFormed
        ? (await client.query<{ id: string }>('select site.lot_retest_aggregate_id($1::uuid, $2::timestamptz, $3::uuid[]) as id', [a.subjectId, at, ids])).rows
        : [];
      if (rows[0]?.id === lotRetestAggregateId(a.subjectId, at, ids)) return null;
      return refusedOutcome(
        422,
        'EBMR-API-ACT-INPUT',
        'The retest does not name its instant and results plainly. Nothing was signed.',
        'The new retest date is an instant with its zone (for example 2027-06-30T00:00:00Z) and each result is the id of a lot test result.',
        ['DI-37'],
        ['Reload the screen and sign again.'],
      );
    },
    async apply(client, _ctx, a, signatureId) {
      switch (a.act) {
        case 'DEVIATION_IMPACT_ASSESS':
          await client.query('select site.assess_deviation_impact($1, $2)', [a.subjectId, signatureId]);
          break;
        case 'DEVIATION_CONCLUDE':
          await client.query('select site.conclude_deviation($1, $2)', [a.subjectId, signatureId]);
          break;
        case 'DEVIATION_CLOSE':
          await client.query('select site.close_deviation($1, $2)', [a.subjectId, signatureId]);
          break;
        case 'LOT_RESULT_APPROVE':
          await client.query('select site.approve_lot_test_result($1, $2)', [a.subjectId, signatureId]);
          break;
        case 'QC_EXTRA_TESTING_DECISION':
          await client.query('select site.record_qc_extra_testing_decision($1, $2, $3::text[], $4)', [a.subjectId, a.input.decision, a.input.tests ?? [], signatureId]);
          break;
        case 'LOT_RETEST':
          await client.query('select site.record_signed_lot_retest($1, $2::timestamptz, $3::uuid[], $4)', [a.subjectId, a.input.retestAt, a.input.results ?? [], signatureId]);
          break;
      }
      return { act: a.act, subjectId: a.subjectId };
    },
  });
}

async function lotState(db: pg.Pool | pg.PoolClient, lotId: string): Promise<{ state: string; version: string } | null> {
  const { rows } = await db.query<{ state: string; version: string }>(
    "select s.state, s.version::text as version from platform.aggregate_state s where s.aggregate_type = 'material_lot' and s.aggregate_id = $1",
    [lotId],
  );
  return rows[0] ?? null;
}

/**
 * The lot's machine (site-services 0711): a release is MATERIAL_LOT_RELEASED, a rejection MATERIAL_LOT_REJECTED from every
 * state; HOLD, UNHOLD, RETURN and RECALL are MATERIAL_LOT_STATUS_DECIDED over the decision QA proposed (0800; D-P4-3).
 */
const lotMeaning = (a: LotDecision): string =>
  a.decision === 'RELEASE' ? 'MATERIAL_LOT_RELEASED' : a.decision === 'REJECT' ? 'MATERIAL_LOT_REJECTED' : 'MATERIAL_LOT_STATUS_DECIDED';

export function lotDecisionHandler(app: AppContext): SignableActionHandler<LotDecision> {
  return dbActHandler<LotDecision>(app, {
    kind: 'LOT_DECISION',
    aggregateTypes: ['material_lot'],
    reasonOf: (a) => (a.reason ? { reasonCode: a.reason.code, reasonText: a.reason.text } : undefined),
    target: (a) => ({ aggregateType: 'material_lot', aggregateId: a.lotId, meaning: lotMeaning(a) }),
    async targetNow(db, a) {
      const s = await lotState(db, a.lotId);
      return { aggregateType: 'material_lot', aggregateId: a.lotId, meaning: lotMeaning(a), ...(s ? { expectedState: s.state } : {}) };
    },
    async precheck(client, ctx, a) {
      if ((a.decision === 'RELEASE') !== (a.route !== undefined)) {
        return refusedOutcome(422, 'EBMR-SITE-111', 'A release names its route, and only a release does. Nothing was signed.', 'IDENTITY_TESTED or VENDOR_HISTORY (IN-24 (c)).', ['IN-24'], ['Choose the release route.']);
      }
      const s = await lotState(client, a.lotId);
      const meaning = (ctx as { meaning?: string }).meaning;
      if (s && meaning !== undefined && meaning !== '' && meaning !== lotMeaning(a)) {
        return refusedOutcome(422, 'EBMR-API-LOT-MEANING', `This decision is signed ${lotMeaning(a)}, not ${meaning}. Nothing was signed.`, `The lot is ${s.state}.`, ['DI-35'], ['Reload the lot and sign again.']);
      }
      return null;
    },
    async apply(client, _ctx, a, signatureId) {
      const s = await lotState(client, a.lotId);
      const { rows } = await client.query<{ r: Record<string, unknown> }>('select site.change_lot_status($1, $2, $3::bigint, $4, $5) as r', [
        a.lotId,
        a.decision,
        s?.version ?? '0',
        signatureId,
        a.route ?? null,
      ]);
      return rows[0]?.r ?? null;
    },
  });
}

const REPROCESSING: Readonly<Record<ReprocessingAct['act'], { aggregateType: string; sql: string }>> = {
  RESERVE_RESIDUE: { aggregateType: 'output_container', sql: 'select recipe.reserve_residue($1, $2)' },
  AUTHORISE_ADDITION: { aggregateType: 'reprocessing_authorisation', sql: 'select recipe.authorise_reprocessing($1, $2)' },
  AUTHORISE_REQUEST: { aggregateType: 'reprocessing_request', sql: 'select recipe.authorise_reprocessing_request($1, $2)' },
};

export function reprocessingActHandler(app: AppContext): SignableActionHandler<ReprocessingAct> {
  return dbActHandler<ReprocessingAct>(app, {
    kind: 'REPROCESSING_ACT',
    aggregateTypes: ['output_container', 'reprocessing_authorisation', 'reprocessing_request'],
    target: (a) => ({ aggregateType: REPROCESSING[a.act].aggregateType, aggregateId: a.subjectId, meaning: a.act === 'RESERVE_RESIDUE' ? 'RESIDUE_RESERVED' : 'REPROCESSING_AUTHORISED' }),
    async apply(client, _ctx, a, signatureId) {
      await client.query(REPROCESSING[a.act].sql, [a.subjectId, signatureId]);
      return { act: a.act, subjectId: a.subjectId };
    },
  });
}
