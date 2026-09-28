/**
 * External anchors (build outline 5.4; ADR 0007 decisions 4 and 6; INV-08, INV-27; DI-23).
 *
 * The anchor job creates an anchor in the database (kernel.create_anchor) and copies it, with the
 * high-water marks of every protected identifier source and every login name issued, to the external
 * ledger. The first anchor binds the database to the ledger (continuity.database_incarnation): from
 * then on a restored or copied database writes nothing before its identifiers are secured. Verification
 * compares every external copy with the live chains (a chain purged under its retention against its
 * tombstone): MATCH, COVERED (the difference lies in history an approved restore event discarded) or
 * PROBLEM (tampering, or a restore nobody recorded).
 */
import type pg from 'pg';
import { withCommand, type ActorContext } from '../db/command.ts';
import { ledgerAnchors, type ExternalAnchor, type ExternalLedger } from './ledger.ts';
import { readHighWater, type Db } from './numbers.ts';

export interface AnchorVerification {
  anchorId: string;
  status: 'MATCH' | 'COVERED' | 'PROBLEM';
  problem: string | null;
  restoreEventId: string | null;
}

/**
 * Create an anchor now and copy it to the external ledger with the protected high-water marks and every
 * login name issued. Refused (EBMR-CONT-017) in a restored or copied database whose identifiers are not
 * secured yet: its anchor would reuse an anchor id the original already exported.
 */
export async function exportAnchor(db: Db, ledger: ExternalLedger): Promise<ExternalAnchor> {
  const created = await db.query<{ id: string }>('select kernel.create_anchor()::text as id');
  const id = created.rows[0]?.id;
  if (id === undefined) throw new Error('kernel.create_anchor returned no anchor');
  const { rows } = await db.query<{ anchor: ExternalAnchor }>(
    `select jsonb_build_object('anchor_id', a.id::text, 'created_at', continuity.utc_text(a.created_at),
                               'merkle_root_hex', encode(a.merkle_root, 'hex'), 'head_count', a.head_count, 'heads', a.heads,
                               'incarnation', continuity.current_incarnation(),
                               'server_started_at', continuity.utc_text(pg_postmaster_start_time())) as anchor
       from kernel.audit_anchor a where a.id = $1`,
    [id],
  );
  const anchor = rows[0]?.anchor;
  if (!anchor) throw new Error(`anchor ${id} not found after creation`);
  // Read after the anchor exists, so the marks include the anchor's own id.
  const highWater = await readHighWater(db);
  const names = await db.query<{ identifier: string }>('select identifier from iam.issued_login_names()');
  await ledger.append({ type: 'ANCHOR', database: ledger.database, anchor, highWater, loginNames: names.rows.map((r) => r.identifier) });
  return anchor;
}

/** Verify external anchor copies against the live chains (continuity.verify_external_anchors). */
export async function verifyAnchorCopies(db: Db, anchors: ExternalAnchor[]): Promise<AnchorVerification[]> {
  const { rows } = await db.query<{ anchor_id: string | null; status: AnchorVerification['status']; problem: string | null; restore_event_id: string | null }>(
    'select anchor_id::text, status, problem, restore_event_id::text from continuity.verify_external_anchors($1::jsonb)',
    [JSON.stringify(anchors)],
  );
  return rows.map((r) => ({ anchorId: r.anchor_id ?? '?', status: r.status, problem: r.problem, restoreEventId: r.restore_event_id }));
}

/** Verify every anchor the external ledger holds for this database. */
export async function verifyExternalAnchors(db: Db, ledger: ExternalLedger): Promise<AnchorVerification[]> {
  return verifyAnchorCopies(db, await ledgerAnchors(ledger));
}

export interface IntegrityVerification {
  /** kernel.audit_verification_run id of this run. */
  runId: string;
  problemCount: number;
  /** CRITICAL continuity alarms raised (this run and any earlier CRITICAL run not alarmed yet). */
  alarmsRaised: number;
}

/**
 * Scheduled chain verification (DI-23): verify every chain (kernel.run_chain_verification, which keeps
 * the run and announces a break on ebmr_integrity_alarm) and turn every CRITICAL run into a CRITICAL
 * continuity alarm (AUDIT_CHAIN_BROKEN), acknowledged like the other continuity alarms. Run by a system
 * service account; the run and its alarm commit together.
 */
export async function runIntegrityVerification(pool: pg.Pool, ctx: ActorContext): Promise<IntegrityVerification> {
  return withCommand(pool, ctx, async (c) => {
    const started = await c.query<{ id: string }>('select kernel.run_chain_verification()::text as id');
    const runId = started.rows[0]?.id ?? '';
    const run = await c.query<{ problem_count: number }>('select problem_count from kernel.audit_verification_run where id = $1', [runId]);
    const alarms = await c.query<{ n: number }>('select continuity.raise_integrity_alarms() as n');
    return { runId, problemCount: run.rows[0]?.problem_count ?? 0, alarmsRaised: alarms.rows[0]?.n ?? 0 };
  });
}
