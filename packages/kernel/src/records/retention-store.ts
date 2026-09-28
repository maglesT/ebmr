/**
 * Database side of retention (DI-47, INV-22): schedules, dependencies, holds, disposal approval,
 * purge, disposition blockers and purge-aware verification. Thin wrappers over SECURITY DEFINER
 * functions; call them inside withCommand so the actor (and, for purge, the reason) is declared.
 */
import type pg from 'pg';
import type { EffectiveRetention, NormalizedRetentionInputs, OwnRetention, RetentionInputs } from './retention.ts';

type Db = pg.Pool | pg.PoolClient;

export interface RetentionStatus {
  recordKey: string;
  retentionKey: string;
  siteZone: string;
  siteDate: string;
  inputs: NormalizedRetentionInputs;
  own: OwnRetention;
  effective: EffectiveRetention;
  onHold: boolean;
  purged: boolean;
  /** Why the record may not be disposed of now; empty when it is eligible. */
  refusals: { code: string; detail: string }[];
}

export interface Blocker {
  kind: 'INCIDENT' | 'DI_INVESTIGATION' | 'HOLD';
  id: string;
  reference: string;
  status: string;
  severity: string | null;
  detail: string;
  since: Date;
  blocksDisposition: boolean;
  blocksDisposal: boolean;
}

export async function createRetentionSchedule(
  db: Db,
  aggregateType: string,
  aggregateId: string,
  recordTypeCode: string,
  inputs: RetentionInputs,
  siteZone?: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select records.create_retention_schedule($1, $2, $3, $4::jsonb, $5) as id', [
    aggregateType,
    aggregateId,
    recordTypeCode,
    JSON.stringify(inputs),
    siteZone ?? null,
  ]);
  return rows[0]?.id ?? '';
}

/** Changes only the given inputs (e.g. the EU certification date once received); returns the new effective retention. */
export async function updateRetentionInputs(db: Db, recordKey: string, changes: Partial<RetentionInputs>, reason: string): Promise<EffectiveRetention> {
  const { rows } = await db.query<{ e: EffectiveRetention }>('select records.update_retention_inputs($1, $2::jsonb, $3) as e', [
    recordKey,
    JSON.stringify(changes),
    reason,
  ]);
  return rows[0]?.e as EffectiveRetention;
}

/** The supporting record (component lot, logbook, MBR version, ...) inherits the dependant's retention. */
export async function linkRetentionDependency(db: Db, supportingRecordKey: string, dependantRecordKey: string, linkKind: string): Promise<void> {
  await db.query('select records.link_retention_dependency($1, $2, $3)', [supportingRecordKey, dependantRecordKey, linkKind]);
}

export async function retentionOf(db: Db, aggregateType: string, aggregateId: string): Promise<RetentionStatus> {
  const { rows } = await db.query<{ r: RetentionStatus }>('select records.retention_of($1, $2) as r', [aggregateType, aggregateId]);
  return rows[0]?.r as RetentionStatus;
}

export async function placeLegalHold(db: Db, aggregateType: string, aggregateId: string, reason: string, reference?: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select records.place_legal_hold($1, $2, $3, $4) as id', [aggregateType, aggregateId, reason, reference ?? null]);
  return rows[0]?.id ?? '';
}

export async function releaseLegalHold(db: Db, holdId: string, reason: string): Promise<void> {
  await db.query('select records.release_legal_hold($1, $2)', [holdId, reason]);
}

/** QA approval to dispose of a record whose retention has ended (refused otherwise). */
export async function approvePurge(db: Db, recordKey: string, approvalSignatureId: string, reason: string, trueCopyId?: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select records.approve_purge($1, $2, $3, $4) as id', [recordKey, approvalSignatureId, reason, trueCopyId ?? null]);
  return rows[0]?.id ?? '';
}

/** Purges an approved, eligible record; returns the tombstone id. The command must carry a reason code. */
export async function purge(db: Db, recordKey: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('select records.purge($1) as id', [recordKey]);
  return rows[0]?.id ?? '';
}

/** Open incidents, investigations and holds on a record, with what each one blocks. */
export async function openBlockers(db: Db, aggregateType: string, aggregateId: string): Promise<Blocker[]> {
  const { rows } = await db.query<{
    blocker_kind: Blocker['kind'];
    blocker_id: string;
    reference: string;
    status: string;
    severity: string | null;
    detail: string;
    since: Date;
    blocks_disposition: boolean;
    blocks_disposal: boolean;
  }>('select * from records.open_blockers($1, $2)', [aggregateType, aggregateId]);
  return rows.map((r) => ({
    kind: r.blocker_kind,
    id: r.blocker_id,
    reference: r.reference,
    status: r.status,
    severity: r.severity,
    detail: r.detail,
    since: r.since,
    blocksDisposition: r.blocks_disposition,
    blocksDisposal: r.blocks_disposal,
  }));
}

/**
 * Locks the record's blocker epoch inside the caller's transaction and returns it. The release module
 * evaluates openBlockers outside the signing transaction, then inside it calls this and refuses if the
 * epoch moved (outline 5.7). A DI-investigation blocker that appeared without a link (the person
 * investigated wrote to the record inside the window) is linked and held first, which moves the epoch.
 */
export async function lockBlockerEpoch(client: pg.PoolClient, aggregateType: string, aggregateId: string): Promise<bigint> {
  const { rows } = await client.query<{ v: string }>('select records.lock_blocker_epoch($1, $2)::text as v', [aggregateType, aggregateId]);
  return BigInt(rows[0]?.v ?? '0');
}

/** kernel.verify_chain that accepts a purged chain against its tombstone and checkpoint. */
export async function verifyChainPurgeAware(db: Db, chainKey: string): Promise<{ seq: string; problem: string }[]> {
  const { rows } = await db.query<{ seq: string; problem: string }>('select seq::text as seq, problem from records.verify_chain($1)', [chainKey]);
  return rows;
}

/** kernel.verify_anchor that matches anchored heads of purged chains against their tombstones. */
export async function verifyAnchorPurgeAware(db: Db, anchorId: string | number): Promise<string[]> {
  const { rows } = await db.query<{ problem: string }>('select problem from records.verify_anchor($1)', [anchorId]);
  return rows.map((r) => r.problem);
}

/** INV-22 invariant query; production runs it on a schedule and expects no rows. */
export async function inv22Violations(db: Db): Promise<{ check: string; detail: string }[]> {
  const { rows } = await db.query<{ check_name: string; detail: string }>('select check_name, detail from records.inv22_violations()');
  return rows.map((r) => ({ check: r.check_name, detail: r.detail }));
}
