/**
 * Controlled-document inventory of MBR versions (PR-05; EU Ch.4 4.32 paraphrased: keep an inventory
 * of the documents in the quality system) and its reconciliation with the site's document list.
 *
 * Every version appears with its document ID (MBR-<family>-v<n>, PR-02), state, content hash,
 * effective date, review due date, last review, approval and end dates, change record and its
 * market authorisations. The export is CSV (RFC 4180 quoting) or JSON; reconcile compares it with a
 * list kept outside the system (document ID, version, status) and reports what is missing, extra or
 * different.
 */
import type pg from 'pg';
import type { InventoryRow } from './types.ts';

export async function documentInventory(db: pg.Pool | pg.PoolClient): Promise<InventoryRow[]> {
  const { rows } = await db.query<{
    document_id: string;
    family_code: string;
    title: string;
    edition: string;
    record_kind: string;
    product_code: string;
    product_name: string;
    strength: string;
    dosage_form: string;
    version_id: string;
    version_number: number;
    state: string;
    content_hash: string;
    content_revision: number;
    effective_from: string | null;
    review_due: string | null;
    last_review_at: string | null;
    approved_at: string | null;
    ended_at: string | null;
    change_record_number: string | null;
    market_authorisations: InventoryRow['marketAuthorisations'];
  }>(`
    select document_id, family_code, title, edition, record_kind, product_code, product_name, strength, dosage_form, version_id,
           version_number, state, content_hash, content_revision, recipe.utc_text(effective_from) as effective_from,
           to_char(review_due, 'YYYY-MM-DD') as review_due, recipe.utc_text(last_review_at) as last_review_at,
           recipe.utc_text(approved_at) as approved_at, recipe.utc_text(ended_at) as ended_at, change_record_number, market_authorisations
    from recipe.document_inventory order by family_code, version_number`);
  return rows.map((r) => ({
    documentId: r.document_id,
    familyCode: r.family_code,
    title: r.title,
    edition: r.edition,
    recordKind: r.record_kind,
    productCode: r.product_code,
    productName: r.product_name,
    strength: r.strength,
    dosageForm: r.dosage_form,
    versionId: r.version_id,
    versionNumber: r.version_number,
    state: r.state,
    contentHash: r.content_hash,
    contentRevision: r.content_revision,
    effectiveFrom: r.effective_from,
    reviewDue: r.review_due,
    lastReviewAt: r.last_review_at,
    approvedAt: r.approved_at,
    endedAt: r.ended_at,
    changeRecordNumber: r.change_record_number,
    marketAuthorisations: r.market_authorisations,
  }));
}

export const INVENTORY_COLUMNS = [
  'document_id',
  'family_code',
  'version_number',
  'state',
  'title',
  'product_code',
  'strength',
  'dosage_form',
  'edition',
  'effective_from',
  'review_due',
  'last_review_at',
  'approved_at',
  'ended_at',
  'change_record_number',
  'content_hash',
  'current_markets',
] as const;

const quote = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Markets where a version is CURRENT or BRIDGING now (from its authorisation cells). */
export function currentMarkets(row: InventoryRow): string {
  const open = row.marketAuthorisations.filter((m) => m.status === 'CURRENT' || m.status === 'BRIDGING').map((m) => `${m.market}:${m.status}`);
  return [...new Set(open)].sort().join(' ');
}

export function inventoryCsv(rows: readonly InventoryRow[]): string {
  const lines = [INVENTORY_COLUMNS.join(',')];
  for (const r of rows) {
    const values: Record<(typeof INVENTORY_COLUMNS)[number], string> = {
      document_id: r.documentId,
      family_code: r.familyCode,
      version_number: String(r.versionNumber),
      state: r.state,
      title: r.title,
      product_code: r.productCode,
      strength: r.strength,
      dosage_form: r.dosageForm,
      edition: r.edition,
      effective_from: r.effectiveFrom ?? '',
      review_due: r.reviewDue ?? '',
      last_review_at: r.lastReviewAt ?? '',
      approved_at: r.approvedAt ?? '',
      ended_at: r.endedAt ?? '',
      change_record_number: r.changeRecordNumber ?? '',
      content_hash: r.contentHash,
      current_markets: currentMarkets(r),
    };
    lines.push(INVENTORY_COLUMNS.map((c) => quote(values[c])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** One entry of the site's own document list. */
export interface SiteDocument {
  documentId: string;
  versionNumber: number;
  state: string;
}

export interface Reconciliation {
  reconciled: boolean;
  /** In the system, not on the site list. */
  missingFromSiteList: string[];
  /** On the site list, not in the system. */
  unknownToSystem: string[];
  /** On both, with a different version or state. */
  mismatched: { documentId: string; system: { versionNumber: number; state: string }; site: { versionNumber: number; state: string } }[];
}

/** Reconciles the export with the site document list (PR-05 catalog test). */
export function reconcileInventory(rows: readonly InventoryRow[], site: readonly SiteDocument[]): Reconciliation {
  const sys = new Map(rows.map((r) => [r.documentId, r]));
  const lst = new Map(site.map((s) => [s.documentId, s]));
  const missingFromSiteList = [...sys.keys()].filter((k) => !lst.has(k)).sort();
  const unknownToSystem = [...lst.keys()].filter((k) => !sys.has(k)).sort();
  const mismatched: Reconciliation['mismatched'] = [];
  for (const [k, s] of lst) {
    const r = sys.get(k);
    if (r && (r.versionNumber !== s.versionNumber || r.state !== s.state)) {
      mismatched.push({ documentId: k, system: { versionNumber: r.versionNumber, state: r.state }, site: { versionNumber: s.versionNumber, state: s.state } });
    }
  }
  mismatched.sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0));
  return { reconciled: missingFromSiteList.length === 0 && unknownToSystem.length === 0 && mismatched.length === 0, missingFromSiteList, unknownToSystem, mismatched };
}
