/**
 * Restore procedure (build outline 4.2 "High availability and restore"; ADR 0007 decision 6; INV-08,
 * INV-27; control DI-45).
 *
 *   1. checkAgainstLedger: start-up and post-failover check; a restored database is detected here.
 *   2. secureIdentifiers (operator, first write in a restored, copied or failed-over database; also
 *      run by recordRestoreEvent): every protected sequence moves past the ledger's high-water marks
 *      and the login names the ledger holds are reserved. Until then the database writes nothing to
 *      the audit trail (EBMR-CONT-017), so nothing written after the restore reuses an identifier.
 *   3. recordRestoreEvent (operator): the database compares the ledger's anchors with the restored
 *      chains and records which anchors were discarded and which chains lost history.
 *   4. approveRestoreEvent (every named approver, a different person from the operator).
 *   5. completeRestore: every protected identifier source moves past the ledger's high-water marks;
 *      number issue resumes under the new database incarnation.
 * The restore event and its completion are copied to the external ledger as well.
 */
import type pg from 'pg';
import { withCommand, type ActorContext } from '../db/command.ts';
import { verifyExternalAnchors, type AnchorVerification } from './anchors.ts';
import {
  ledgerAnchors,
  ledgerCounterLastValues,
  ledgerHighWater,
  ledgerLoginNames,
  ledgerMaxCeiling,
  type ExternalLedger,
  type SequenceBump,
} from './ledger.ts';
import type { Db } from './numbers.ts';

export type RestoreEventKind = 'FULL_RESTORE' | 'POINT_IN_TIME_RESTORE' | 'FAILOVER' | 'CLUSTER_MIGRATION';

export interface RestoreEventInput {
  eventKind: RestoreEventKind;
  /** Backup restored from (required for FULL_RESTORE and POINT_IN_TIME_RESTORE). */
  backupId?: string;
  /** When that backup was taken, from its manifest (ISO 8601). */
  backupTakenAt?: string;
  /** Recovery target or backup snapshot time (ISO 8601). */
  restorePoint?: string;
  /** When the operator performed the restore or failover (ISO 8601, claimed). */
  performedAt: string;
  reason: string;
  /** Incident or change-control record that authorised the restore. */
  changeReference: string;
  /** Persons who must approve; none may be the operator. */
  approverPersonIds: string[];
}

export interface AnchorComparison {
  anchor_id: string | number | null;
  in_database: boolean;
  status: 'MATCH' | 'DISCARDABLE' | 'UNEXPLAINED';
  problem_chains: string[];
  problems: string[];
}

export interface RecordedRestoreEvent {
  restoreEventId: string;
  contentHashHex: string;
  comparison: AnchorComparison[];
  discardedAnchorIds: string[];
  affectedChainKeys: string[];
}

/** Everything the external ledger holds against which identifiers are moved or reserved. */
async function externalMarks(ledger: ExternalLedger): Promise<{ highWater: { sequence_key: string; value: string }[]; loginNames: string[] }> {
  const marks = await ledgerHighWater(ledger);
  return {
    highWater: [...marks.entries()].map(([sequence_key, value]) => ({ sequence_key, value: value.toString() })),
    loginNames: await ledgerLoginNames(ledger),
  };
}

export interface SecureIdentifiersOptions {
  /** How far to move sequences no module registered (default 1,000,000). */
  unregisteredMargin?: bigint;
}

/**
 * First step in a restored, copied or failed-over database (continuity.secure_identifiers): every
 * protected sequence moves past the external ledger's high-water marks (plus its margin) and every
 * login name the ledger holds is reserved, before anything else is written. Runs in its own
 * transaction (the moves are not transactional and are recorded at once). Moves nothing, and returns
 * no moves, when this database incarnation is already bound to the ledger or secured; the login names
 * are reserved either way.
 */
export async function secureIdentifiers(pool: pg.Pool, ctx: ActorContext, ledger: ExternalLedger, options: SecureIdentifiersOptions = {}): Promise<SequenceBump[]> {
  const { highWater, loginNames } = await externalMarks(ledger);
  return withCommand(pool, ctx, async (c) => {
    const { rows } = await c.query<{ sequence_key: string; source_kind: 'PG_SEQUENCE' | 'COUNTER'; value_before: string; external_value: string | null; value_after: string }>(
      `select sequence_key, source_kind, value_before::text, external_value::text, value_after::text
         from continuity.secure_identifiers($1::jsonb, $2::jsonb, $3)`,
      [JSON.stringify(highWater), JSON.stringify(loginNames), (options.unregisteredMargin ?? 1_000_000n).toString()],
    );
    return rows.map((r) => ({ sequenceKey: r.sequence_key, sourceKind: r.source_kind, valueBefore: r.value_before, externalValue: r.external_value, valueAfter: r.value_after }));
  });
}

/**
 * Record a restore or failover. The identifiers are secured first (secureIdentifiers; nothing when they
 * already are), so the restore event, its signatures and everything after them take fresh identifiers.
 */
export async function recordRestoreEvent(pool: pg.Pool, ctx: ActorContext, ledger: ExternalLedger, input: RestoreEventInput): Promise<RecordedRestoreEvent> {
  await secureIdentifiers(pool, ctx, ledger);
  const anchors = await ledgerAnchors(ledger);
  const event = {
    event_kind: input.eventKind,
    backup_id: input.backupId ?? null,
    backup_taken_at: input.backupTakenAt ?? null,
    restore_point: input.restorePoint ?? null,
    performed_at: input.performedAt,
    reason: input.reason,
    change_reference: input.changeReference,
    approver_person_ids: input.approverPersonIds,
  };
  const recorded = await withCommand(pool, ctx, async (c) => {
    const { rows } = await c.query<{ id: string }>('select continuity.record_restore_event($1::jsonb, $2::jsonb)::text as id', [
      JSON.stringify(event),
      JSON.stringify(anchors),
    ]);
    const id = rows[0]?.id ?? '';
    const detail = await c.query<{ content_hash_hex: string; anchor_comparison: AnchorComparison[]; discarded: string[]; affected: string[] }>(
      `select encode(content_hash, 'hex') as content_hash_hex, anchor_comparison,
              array(select x::text from unnest(discarded_anchor_ids) x) as discarded, affected_chain_keys as affected
         from continuity.restore_event where id = $1`,
      [id],
    );
    const d = detail.rows[0];
    if (!d) throw new Error(`restore event ${id} not found after recording`);
    return { restoreEventId: id, contentHashHex: d.content_hash_hex, comparison: d.anchor_comparison, discardedAnchorIds: d.discarded, affectedChainKeys: d.affected };
  });
  await ledger.append({
    type: 'RESTORE_EVENT',
    database: ledger.database,
    restoreEventId: recorded.restoreEventId,
    eventKind: input.eventKind,
    contentHashHex: recorded.contentHashHex,
    discardedAnchorIds: recorded.discardedAnchorIds,
  });
  return recorded;
}

export async function approveRestoreEvent(pool: pg.Pool, ctx: ActorContext, restoreEventId: string, signatureId?: string): Promise<void> {
  await withCommand(pool, ctx, (c) => c.query('select continuity.approve_restore_event($1, $2)', [restoreEventId, signatureId ?? null]));
}

export interface CompleteRestoreOptions {
  /** How far to move sequences no module registered (default 1,000,000). */
  unregisteredMargin?: bigint;
}

/**
 * Move every protected source past the external high-water marks, reserve every login name the ledger
 * holds (user IDs issued in the lost window are never issued again, INV-27) and re-enable number issue.
 */
export async function completeRestore(
  pool: pg.Pool,
  ctx: ActorContext,
  ledger: ExternalLedger,
  restoreEventId: string,
  options: CompleteRestoreOptions = {},
): Promise<SequenceBump[]> {
  const { highWater, loginNames } = await externalMarks(ledger);
  const bumps = await withCommand(pool, ctx, async (c) => {
    const { rows } = await c.query<{ sequence_key: string; source_kind: 'PG_SEQUENCE' | 'COUNTER'; value_before: string; external_value: string | null; value_after: string }>(
      `select sequence_key, source_kind, value_before::text, external_value::text, value_after::text
         from continuity.after_restore($1, $2::jsonb, $3, $4::jsonb)`,
      [restoreEventId, JSON.stringify(highWater), (options.unregisteredMargin ?? 1_000_000n).toString(), JSON.stringify(loginNames)],
    );
    return rows.map((r) => ({ sequenceKey: r.sequence_key, sourceKind: r.source_kind, valueBefore: r.value_before, externalValue: r.external_value, valueAfter: r.value_after }));
  });
  await ledger.append({ type: 'RESTORE_COMPLETED', database: ledger.database, restoreEventId, bumps });
  return bumps;
}

export interface LostWindowChain {
  chainKey: string;
  aggregateType: string;
  aggregateId: string;
  restoredSeq: string;
  externalSeq: string | null;
}

/** Chains whose history after the restore point was lost (input to the lost-window incident). */
export async function lostWindow(db: Db, restoreEventId: string): Promise<LostWindowChain[]> {
  const { rows } = await db.query<{ chain_key: string; aggregate_type: string; aggregate_id: string; restored_seq: string; external_seq: string | null }>(
    'select chain_key, aggregate_type, aggregate_id, restored_seq::text, external_seq::text from continuity.lost_window($1)',
    [restoreEventId],
  );
  return rows.map((r) => ({ chainKey: r.chain_key, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id, restoredSeq: r.restored_seq, externalSeq: r.external_seq }));
}

export interface ContinuityFinding {
  code:
    | 'ANCHOR_MISMATCH'
    | 'ANCHOR_NOT_EXPORTED'
    | 'COUNTER_INCARNATION_CHANGED'
    | 'COUNTER_BEHIND_LEDGER'
    | 'LEDGER_BEHIND_COUNTER'
    | 'SEQUENCE_BEHIND_LEDGER'
    | 'IDENTIFIERS_NOT_SECURED'
    | 'RESTORE_IN_PROGRESS';
  severity: 'ERROR' | 'WARNING';
  subject: string;
  message: string;
}

export interface ContinuityCheck {
  ok: boolean;
  findings: ContinuityFinding[];
  anchors: AnchorVerification[];
}

/**
 * Start-up and post-failover check against the external ledger. Any ERROR means the database may have
 * been restored (or tampered with) without the restore procedure: GMP operation must not start until
 * the restore procedure has run or the finding is resolved.
 */
export async function checkAgainstLedger(db: Db, ledger: ExternalLedger): Promise<ContinuityCheck> {
  const findings: ContinuityFinding[] = [];
  const secured = await db.query<{ ok: boolean; incarnation: string }>('select continuity.identifiers_secured() as ok, continuity.current_incarnation() as incarnation');
  if (!secured.rows[0]?.ok) {
    findings.push({
      code: 'IDENTIFIERS_NOT_SECURED',
      severity: 'ERROR',
      subject: `incarnation ${secured.rows[0]?.incarnation ?? '?'}`,
      message: 'this database is a restored, copied or failed-over copy whose identifiers are not secured; start the restore procedure',
    });
  }
  const anchors = await verifyExternalAnchors(db, ledger);
  for (const a of anchors.filter((x) => x.status === 'PROBLEM')) {
    findings.push({ code: 'ANCHOR_MISMATCH', severity: 'ERROR', subject: `anchor ${a.anchorId}`, message: a.problem ?? 'differs from the live chains' });
  }

  const exported = new Set((await ledgerAnchors(ledger)).map((a) => a.anchor_id));
  const inDb = await db.query<{ id: string }>('select id::text as id from kernel.audit_anchor order by id');
  for (const { id } of inDb.rows) {
    if (!exported.has(id)) {
      findings.push({ code: 'ANCHOR_NOT_EXPORTED', severity: 'WARNING', subject: `anchor ${id}`, message: 'this anchor has no copy in the external ledger' });
    }
  }

  const counters = await db.query<{ sequence_key: string; last_value: string; reserved_ceiling: string; ceiling_incarnation: string | null; current_incarnation: string }>(
    `select sequence_key, last_value::text, reserved_ceiling::text, ceiling_incarnation, continuity.current_incarnation() as current_incarnation
       from continuity.counter order by sequence_key`,
  );
  const issued = await ledgerCounterLastValues(ledger);
  for (const c of counters.rows) {
    if (c.ceiling_incarnation !== null && c.ceiling_incarnation !== c.current_incarnation) {
      findings.push({
        code: 'COUNTER_INCARNATION_CHANGED',
        severity: 'ERROR',
        subject: c.sequence_key,
        message: 'the database was restored, copied or failed over since this counter was reserved; run the restore procedure',
      });
    }
    const external = await ledgerMaxCeiling(ledger, c.sequence_key);
    const reserved = BigInt(c.reserved_ceiling);
    if (external !== null && external > reserved) {
      findings.push({
        code: 'COUNTER_BEHIND_LEDGER',
        severity: 'ERROR',
        subject: c.sequence_key,
        message: `the ledger holds ceiling ${external} but the database only ${reserved}: a restore without the restore procedure is suspected`,
      });
    }
    // Values the anchors saw issued: a counter below them was rolled back inside its block (a physical
    // copy or a snapshot started by crash recovery keeps the incarnation).
    const seen = issued.get(c.sequence_key);
    if (seen !== undefined && seen > BigInt(c.last_value)) {
      findings.push({
        code: 'COUNTER_BEHIND_LEDGER',
        severity: 'ERROR',
        subject: c.sequence_key,
        message: `the ledger saw value ${seen} issued but the counter is at ${c.last_value}: a restore without the restore procedure is suspected`,
      });
    }
    if (reserved > 0n && (external === null || external < reserved)) {
      findings.push({
        code: 'LEDGER_BEHIND_COUNTER',
        severity: 'ERROR',
        subject: c.sequence_key,
        message: `the database ceiling ${reserved} is not in the ledger (${external ?? 'none'}): the write-ahead record is missing`,
      });
    }
  }

  const marks = await ledgerHighWater(ledger);
  const sequences = await db.query<{ sequence_key: string; last_value: string }>(
    "select sequence_key, last_value::text from continuity.sequence_high_water() where source_kind = 'PG_SEQUENCE'",
  );
  for (const s of sequences.rows) {
    const external = marks.get(s.sequence_key);
    if (external !== undefined && external > BigInt(s.last_value)) {
      findings.push({
        code: 'SEQUENCE_BEHIND_LEDGER',
        severity: 'ERROR',
        subject: s.sequence_key,
        message: `the ledger has seen value ${external} but the sequence is at ${s.last_value}: a restore without the restore procedure is suspected`,
      });
    }
  }

  const pending = await db.query<{ id: string; status: string }>("select id::text, status from continuity.restore_event_status where status <> 'COMPLETED'");
  for (const p of pending.rows) {
    findings.push({ code: 'RESTORE_IN_PROGRESS', severity: 'ERROR', subject: `restore event ${p.id}`, message: `restore event is ${p.status}, not completed` });
  }

  return { ok: findings.every((f) => f.severity !== 'ERROR'), findings, anchors };
}
