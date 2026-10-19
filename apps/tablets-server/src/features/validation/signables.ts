/**
 * The signed acts of the validation and records screens (Phase 7 slice 7g-3). Each signs the record the database act
 * works on and runs that act with the signature in the same transaction; the database decides and a refusal signs
 * nothing (esig/db-acts.ts).
 *
 *   VALIDATION_SUMMARY_APPROVE  validation_summary <release>@<summary sha256>  VALIDATION_SUMMARY_APPROVED  platform.approve_validation_summary
 *   EVALUATION_PACK_APPROVE     evaluation_pack <pack id>                      PERIODIC_EVALUATION_APPROVED records.approve_evaluation_pack
 *   RECORDS_ACT RECORD_TYPE_APPROVE     record_type_version <code>:<version>   RECORD_TYPE_APPROVED      records.approve_record_type
 *               DISPOSAL_APPROVE        record_disposal <key>@<retain until>[@<true copy>]  RECORD_DISPOSAL_APPROVED  records.approve_purge
 *               DI_INVESTIGATION_CLOSE  di_investigation <id>                  DI_INVESTIGATION_CLOSED   records.close_di_investigation
 * The retain-until date of a disposal is the database's (tab.disposal_aggregate_id, tablets 1491), read when the act is described and again
 * when it is signed.
 *
 * Every record here but a record type version is of the GOVERNANCE read class (tablets 0410, 1491): its content is read
 * only by a session that may read it, never by the application role alone (tab.record_content_for_signing refuses it).
 * So the challenge and the dry run read the content as the signing session does (tab.content_for_signing with the
 * session's token: the reader's rule and, for an investigation, its withholding from the person investigated, DI-50).
 */
import type pg from 'pg';
import type { SignableAction } from '@ebmr/api-contract';
import { records as kernelRecords } from '@ebmr/kernel';
import type { AppContext } from '../../platform/context.ts';
import type { DryRunOutcome, SignableActionHandler, SignableContext } from '../../platform/ports.ts';
import { contentOf, type EsigSignableContext } from '../esig/content.ts';
import { dbActHandler, refusedOutcome, type ActTarget } from '../esig/db-acts.ts';

type SummaryAct = Extract<SignableAction, { kind: 'VALIDATION_SUMMARY_APPROVE' }>;
type PackAct = Extract<SignableAction, { kind: 'EVALUATION_PACK_APPROVE' }>;
type RecordsAct = Extract<SignableAction, { kind: 'RECORDS_ACT' }>;

/** The content of the record signed, as the signing session reads it (tab.content_for_signing). */
async function sessionContent(client: pg.PoolClient, ctx: SignableContext, t: ActTarget) {
  const token = (ctx as Partial<EsigSignableContext>).tokenHash ?? '';
  const { rows } = await client.query<{ r: Record<string, unknown> }>('select tab.content_for_signing($1, $2, $3, $4) as r', [token, t.aggregateType, t.aggregateId, t.meaning]);
  return contentOf(t.aggregateType, t.aggregateId, rows[0]?.r ?? {});
}

/** A database act whose record the session reads: the challenge and the dry run read its content as the session does. */
function sessionRead<A extends SignableAction>(h: SignableActionHandler<A>, targetOf: (db: pg.PoolClient, a: A) => Promise<ActTarget>, precheck?: (a: A) => DryRunOutcome | null): SignableActionHandler<A> {
  return {
    ...h,
    async prepareForChallenge(client, ctx, a) {
      const c = await sessionContent(client, ctx, await targetOf(client, a));
      return { contentVersion: c.contentVersion ?? '0', contentHash: c.contentHash ?? '', changed: false };
    },
    async dryRun(client, ctx, a) {
      const pre = precheck ? precheck(a) : null;
      if (pre) return pre;
      const t = await targetOf(client, a);
      const c = await sessionContent(client, ctx, t);
      if (!c.exists || !c.contentHash || !c.contentVersion) {
        return refusedOutcome(404, 'EBMR-API-NO-RECORD', 'The record to be signed was not found. Nothing was signed.', `${t.aggregateType} ${t.aggregateId} does not exist.`, ['DI-37'], ['Reload the screen.']);
      }
      return { accepted: true, contentHash: c.contentHash, contentVersion: c.contentVersion };
    },
  };
}

const summaryTarget = (a: SummaryAct): ActTarget => ({ aggregateType: 'validation_summary', aggregateId: `${a.schemaRelease}@${a.summarySha256}`, meaning: 'VALIDATION_SUMMARY_APPROVED', expectedState: 'PROPOSED' });

export function validationSummaryHandler(app: AppContext): SignableActionHandler<SummaryAct> {
  return sessionRead(dbActHandler<SummaryAct>(app, {
    kind: 'VALIDATION_SUMMARY_APPROVE',
    aggregateTypes: ['validation_summary'],
    target: summaryTarget,
    async apply(client, _ctx, a, signatureId) {
      const { rows } = await client.query<{ id: string }>('select platform.approve_validation_summary($1, $2, $3, $4)::text as id', [a.schemaRelease, a.summarySha256, a.title, signatureId]);
      return { schemaRelease: a.schemaRelease, summarySha256: a.summarySha256, approvalId: rows[0]?.id ?? null };
    },
  }), (_db, a) => Promise.resolve(summaryTarget(a)));
}

const packTarget = (a: PackAct): ActTarget => ({ aggregateType: 'evaluation_pack', aggregateId: a.packId, meaning: 'PERIODIC_EVALUATION_APPROVED', expectedState: 'STORED' });

export function evaluationPackHandler(app: AppContext): SignableActionHandler<PackAct> {
  return sessionRead(dbActHandler<PackAct>(app, {
    kind: 'EVALUATION_PACK_APPROVE',
    aggregateTypes: ['evaluation_pack'],
    target: packTarget,
    async apply(client, _ctx, a, signatureId) {
      await kernelRecords.approveEvaluationPack(client, a.packId, signatureId);
      return { packId: a.packId };
    },
  }), (_db, a) => Promise.resolve(packTarget(a)));
}

const MEANING: Record<RecordsAct['act'], string> = {
  RECORD_TYPE_APPROVE: 'RECORD_TYPE_APPROVED',
  DISPOSAL_APPROVE: 'RECORD_DISPOSAL_APPROVED',
  DI_INVESTIGATION_CLOSE: 'DI_INVESTIGATION_CLOSED',
};

/** The disposal record signed: the record key at the retain-until date the database computes now (with the true copy). */
async function disposalTarget(db: pg.Pool | pg.PoolClient, a: RecordsAct): Promise<ActTarget> {
  const key = a.input.recordKey ?? '';
  const { rows } = await db.query<{ id: string | null }>('select tab.disposal_aggregate_id($1, $2) as id', [key, a.input.trueCopyId ?? null]);
  // No schedule or no date yet: an id no disposal has, so the dry run answers "no record" (404).
  return { aggregateType: 'record_disposal', aggregateId: rows[0]?.id ?? `${key}@0000-00-00`, meaning: MEANING.DISPOSAL_APPROVE, expectedState: 'DISPOSABLE' };
}

function staticTarget(a: RecordsAct): ActTarget {
  const i = a.input;
  if (a.act === 'RECORD_TYPE_APPROVE') return { aggregateType: 'record_type_version', aggregateId: `${i.code ?? ''}:${i.version ?? ''}`, meaning: MEANING[a.act], expectedState: 'DEFINED' };
  if (a.act === 'DI_INVESTIGATION_CLOSE') return { aggregateType: 'di_investigation', aggregateId: i.investigationId ?? '', meaning: MEANING[a.act], expectedState: 'OPEN' };
  return { aggregateType: 'record_disposal', aggregateId: `${i.recordKey ?? ''}@?`, meaning: MEANING[a.act], expectedState: 'DISPOSABLE' };
}

/** Exactly the members the act uses (DI-37: an act missing what it needs, or carrying another act's, queries nothing). */
function inputRefusal(a: RecordsAct): DryRunOutcome | null {
  const i = a.input;
  const has = (k: keyof typeof i) => i[k] !== undefined;
  const allowed: Record<RecordsAct['act'], (keyof typeof i)[]> = {
    RECORD_TYPE_APPROVE: ['code', 'version'],
    DISPOSAL_APPROVE: ['recordKey', 'reason', 'trueCopyId'],
    DI_INVESTIGATION_CLOSE: ['investigationId', 'conclusion', 'remediation'],
  };
  const required: Record<RecordsAct['act'], (keyof typeof i)[]> = {
    RECORD_TYPE_APPROVE: ['code', 'version'],
    DISPOSAL_APPROVE: ['recordKey', 'reason'],
    DI_INVESTIGATION_CLOSE: ['investigationId', 'conclusion', 'remediation'],
  };
  const extra = (Object.keys(i) as (keyof typeof i)[]).filter((k) => has(k) && !allowed[a.act].includes(k));
  const missing = required[a.act].filter((k) => !has(k));
  if (extra.length === 0 && missing.length === 0) return null;
  return refusedOutcome(422, 'EBMR-API-ACT-INPUT', 'The act does not carry what it needs. Nothing was signed.',
    `${a.act} needs ${required[a.act].join(', ')}${missing.length ? ` (missing: ${missing.join(', ')})` : ''}${extra.length ? `; it does not take ${extra.join(', ')}` : ''}.`,
    ['DI-37'], ['Reload the screen and sign again.']);
}

const recordsTarget = (db: pg.Pool | pg.PoolClient, a: RecordsAct): Promise<ActTarget> => (a.act === 'DISPOSAL_APPROVE' ? disposalTarget(db, a) : Promise.resolve(staticTarget(a)));

export function recordsActHandler(app: AppContext): SignableActionHandler<RecordsAct> {
  return sessionRead(dbActHandler<RecordsAct>(app, {
    kind: 'RECORDS_ACT',
    aggregateTypes: ['record_type_version', 'record_disposal', 'di_investigation'],
    target: staticTarget,
    targetNow: recordsTarget,
    reasonOf: (a) => (a.act === 'DISPOSAL_APPROVE' && a.input.reason ? { reasonCode: 'RECORD_DISPOSAL', reasonText: a.input.reason } : undefined),
    precheck: (_client, _ctx, a) => Promise.resolve(inputRefusal(a)),
    async apply(client, _ctx, a, signatureId) {
      const i = a.input;
      if (a.act === 'RECORD_TYPE_APPROVE') {
        await client.query('select records.approve_record_type($1, $2::integer, $3)', [i.code, i.version, signatureId]);
        return { act: a.act, code: i.code ?? '', version: i.version ?? '' };
      }
      if (a.act === 'DISPOSAL_APPROVE') {
        const approvalId = await kernelRecords.approvePurge(client, i.recordKey ?? '', signatureId, i.reason ?? '', i.trueCopyId);
        return { act: a.act, recordKey: i.recordKey ?? '', approvalId };
      }
      await client.query('select records.close_di_investigation($1, $2, $3, $4)', [i.investigationId, i.conclusion, i.remediation, signatureId]);
      return { act: a.act, investigationId: i.investigationId ?? '' };
    },
  }), recordsTarget, inputRefusal);
}
