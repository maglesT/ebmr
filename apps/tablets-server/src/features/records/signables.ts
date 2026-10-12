/**
 * The signed acts of record locking (Phase 4 slice 5b; signable action RECORD_LOCK_ACT). Each signs the record the
 * database act works on and runs that act with the signature in the same transaction; the database decides
 * (recipe-core 0872) and a refusal signs nothing (esig/db-acts.ts).
 *
 *   AMENDMENT_OPEN   record_lock <batch>/<n>/OPEN/<DEVIATION|CHANGE_RECORD>/<basis>  AMENDMENT_OPENED (QA)  recipe.open_record_amendment
 *                    (exactly one of deviationId, changeRecordId; the person's own reason)
 *   AMENDMENT_CLOSE  record_lock <batch>/<n>/CLOSE                                 AMENDMENT_CLOSED (QA)  recipe.close_record_amendment
 *                    (the closing statement; n is the open amendment's number)
 */
import type { SignableAction } from '@ebmr/api-contract';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import type { DryRunOutcome, SignableActionHandler } from '../../platform/ports.ts';
import { dbActHandler, refusedOutcome, type ActTarget } from '../esig/db-acts.ts';

type RecordLockAct = Extract<SignableAction, { kind: 'RECORD_LOCK_ACT' }>;

const meaningOf = (a: RecordLockAct): string => (a.act === 'AMENDMENT_OPEN' ? 'AMENDMENT_OPENED' : 'AMENDMENT_CLOSED');
const basisOf = (a: RecordLockAct): { kind: 'DEVIATION' | 'CHANGE_RECORD'; id: string } | null =>
  a.input.deviationId !== undefined ? { kind: 'DEVIATION', id: a.input.deviationId } : a.input.changeRecordId !== undefined ? { kind: 'CHANGE_RECORD', id: a.input.changeRecordId } : null;

async function targetNow(db: pg.Pool | pg.PoolClient, a: RecordLockAct): Promise<ActTarget> {
  const b = basisOf(a);
  const { rows } = await db.query<{ a: string | null; s: string }>('select recipe.record_lock_next_id($1, $2, $3, $4) as a, recipe.record_lock_state($1) as s', [
    a.batchId, a.act === 'AMENDMENT_OPEN' ? 'OPEN' : 'CLOSE', b?.kind ?? null, b?.id ?? null,
  ]);
  // No open amendment to close: a number no amendment has, so the dry run answers "no record" (404). The state signed is
  // the record's (LOCKED to open, UNDER_AMENDMENT to close); the database checks it again.
  return { aggregateType: 'record_lock', aggregateId: rows[0]?.a ?? `${a.batchId}/0/CLOSE`, meaning: meaningOf(a), expectedState: rows[0]?.s ?? 'UNLOCKED' };
}

function inputRefusal(a: RecordLockAct): DryRunOutcome | null {
  const i = a.input;
  const ok =
    a.act === 'AMENDMENT_OPEN'
      ? (i.deviationId === undefined) !== (i.changeRecordId === undefined) && i.reason !== undefined && i.statement === undefined
      : i.statement !== undefined && i.deviationId === undefined && i.changeRecordId === undefined && i.reason === undefined;
  if (ok) return null;
  return refusedOutcome(422, 'EBMR-API-ACT-INPUT', 'The act does not carry what it needs. Nothing was signed.',
    a.act === 'AMENDMENT_OPEN'
      ? 'An amendment is opened under exactly one basis (deviationId or changeRecordId) with the person\'s own reason.'
      : 'An amendment is closed with a closing statement and nothing else.',
    ['DI-37', 'INV-21'], ['Reload the screen and sign again.']);
}

export function recordLockActHandler(app: AppContext): SignableActionHandler<RecordLockAct> {
  return dbActHandler<RecordLockAct>(app, {
    kind: 'RECORD_LOCK_ACT',
    aggregateTypes: ['record_lock'],
    target: (a) => {
      const b = basisOf(a);
      return { aggregateType: 'record_lock', aggregateId: a.act === 'AMENDMENT_OPEN' && b ? `${a.batchId}/?/OPEN/${b.kind}/${b.id}` : `${a.batchId}/?/CLOSE`, meaning: meaningOf(a) };
    },
    targetNow,
    reasonOf: (a) => (a.act === 'AMENDMENT_OPEN' && a.input.reason ? { reasonCode: a.input.reason.code, reasonText: a.input.reason.text } : undefined),
    precheck: (_client, _ctx, a) => Promise.resolve(inputRefusal(a)),
    async apply(client, _ctx, a, signatureId) {
      if (a.act === 'AMENDMENT_OPEN') {
        const b = basisOf(a)!;
        const { rows } = await client.query<{ id: string }>('select recipe.open_record_amendment($1, $2, $3, $4, $5, $6) as id', [
          a.batchId, b.kind, b.id, a.input.reason!.code, a.input.reason!.text, signatureId,
        ]);
        return { act: a.act, batchId: a.batchId, amendmentId: rows[0]!.id };
      }
      const t = await targetNow(client, a);
      const n = Number.parseInt(t.aggregateId.split('/')[1] ?? '0', 10);
      const { rows } = await client.query<{ id: string }>('select recipe.close_record_amendment($1, $2, $3, $4) as id', [a.batchId, n, a.input.statement, signatureId]);
      return { act: a.act, batchId: a.batchId, amendmentId: rows[0]!.id };
    },
  });
}
