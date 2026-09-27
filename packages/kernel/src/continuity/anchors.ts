/**
 * External anchors (build outline 5.4; ADR 0007 decisions 4 and 6; INV-08).
 *
 * The anchor job creates an anchor in the database (kernel.create_anchor) and copies it, with the
 * high-water marks of every protected identifier source, to the external ledger. Verification compares
 * every external copy with the live chains: MATCH, COVERED (the difference lies in history an approved
 * restore event discarded) or PROBLEM (tampering, or a restore nobody recorded).
 */
import { ledgerAnchors, type ExternalAnchor, type ExternalLedger } from './ledger.ts';
import { readHighWater, type Db } from './numbers.ts';

export interface AnchorVerification {
  anchorId: string;
  status: 'MATCH' | 'COVERED' | 'PROBLEM';
  problem: string | null;
  restoreEventId: string | null;
}

/** Create an anchor now and copy it, with the protected high-water marks, to the external ledger. */
export async function exportAnchor(db: Db, ledger: ExternalLedger): Promise<ExternalAnchor> {
  const created = await db.query<{ id: string }>('select kernel.create_anchor()::text as id');
  const id = created.rows[0]?.id;
  if (id === undefined) throw new Error('kernel.create_anchor returned no anchor');
  const { rows } = await db.query<{ anchor: ExternalAnchor }>(
    `select jsonb_build_object('anchor_id', a.id::text, 'created_at', continuity.utc_text(a.created_at),
                               'merkle_root_hex', encode(a.merkle_root, 'hex'), 'head_count', a.head_count, 'heads', a.heads) as anchor
       from kernel.audit_anchor a where a.id = $1`,
    [id],
  );
  const anchor = rows[0]?.anchor;
  if (!anchor) throw new Error(`anchor ${id} not found after creation`);
  // Read after the anchor exists, so the marks include the anchor's own id.
  const highWater = await readHighWater(db);
  await ledger.append({ type: 'ANCHOR', database: ledger.database, anchor, highWater });
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
