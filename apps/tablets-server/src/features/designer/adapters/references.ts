/**
 * ReferencePort over tab.reference_document (module C2; validator README "ReferencePort"; decision F2).
 *
 * The validator is synchronous, so the rows are read first and the port answers from them. The status of a pinned
 * reference at the validation date (site calendar):
 *  - UNKNOWN: no document with this kind, code and version is registered;
 *  - HASH_MISMATCH: the pinned hash is not the registered document's hash;
 *  - RETIRED / WITHDRAWN: a retirement or withdrawal took effect on or before the date;
 *  - NOT_YET_EFFECTIVE: the version takes effect after the date;
 *  - SUPERSEDED: a later version of the same document is in force on the date (a withdrawn later version does
 *    not supersede: it was never validly in force);
 *  - EFFECTIVE otherwise.
 * Dates are YYYY-MM-DD strings (they order as text); no JavaScript Date is involved.
 */
import type pg from 'pg';
import type { flow, validator } from '@ebmr/recipe-core/pure';

export interface ReferenceRow {
  id: string;
  kind: string;
  code: string;
  version: string;
  title: string;
  contentHash: string;
  /** YYYY-MM-DD. */
  effectiveFrom: string;
  retirement: { status: 'RETIRED' | 'WITHDRAWN'; effectiveFrom: string; reason: string } | null;
}

type Db = pg.Pool | pg.PoolClient;

/** Registered document versions (all, or those with the given codes). */
export async function loadReferenceRows(db: Db, codes?: readonly string[]): Promise<ReferenceRow[]> {
  const { rows } = await db.query<{
    id: string;
    kind: string;
    code: string;
    version: string;
    title: string;
    content_hash: string;
    effective_from: string;
    r_status: 'RETIRED' | 'WITHDRAWN' | null;
    r_from: string | null;
    r_reason: string | null;
  }>(
    `select d.id, d.kind, d.code, d.version, d.title, d.content_hash, to_char(d.effective_from, 'YYYY-MM-DD') as effective_from,
            r.status as r_status, to_char(r.effective_from, 'YYYY-MM-DD') as r_from, r.reason as r_reason
       from tab.reference_document d
       left join tab.reference_document_retirement r on r.document_id = d.id
      where $1::text[] is null or d.code = any($1::text[])
      order by d.kind, d.code, d.effective_from, d.version`,
    [codes ? [...codes] : null],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    code: r.code,
    version: r.version,
    title: r.title,
    contentHash: r.content_hash,
    effectiveFrom: r.effective_from,
    retirement: r.r_status && r.r_from ? { status: r.r_status, effectiveFrom: r.r_from, reason: r.r_reason ?? '' } : null,
  }));
}

const withdrawnBy = (row: ReferenceRow, asOf: string): boolean => row.retirement?.status === 'WITHDRAWN' && row.retirement.effectiveFrom <= asOf;

/** The status of one pinned reference on a date (pure; the rules in the file header). */
export function referenceStatus(ref: Pick<flow.Reference, 'kind' | 'code' | 'version' | 'hash'>, rows: readonly ReferenceRow[], asOf: string): validator.ReferenceStatus {
  const same = rows.filter((r) => r.kind === ref.kind && r.code === ref.code);
  const row = same.find((r) => r.version === ref.version);
  if (!row) return 'UNKNOWN';
  if (ref.hash !== undefined && ref.hash !== row.contentHash) return 'HASH_MISMATCH';
  if (row.retirement && row.retirement.effectiveFrom <= asOf) return row.retirement.status;
  if (row.effectiveFrom > asOf) return 'NOT_YET_EFFECTIVE';
  const later = same.some((r) => r.id !== row.id && r.effectiveFrom > row.effectiveFrom && r.effectiveFrom <= asOf && !withdrawnBy(r, asOf));
  return later ? 'SUPERSEDED' : 'EFFECTIVE';
}

/** The port the validator reads, over rows loaded for the MBR's references. */
export function referencePortFrom(rows: readonly ReferenceRow[], asOf: string): validator.ReferencePort {
  return { status: (ref) => referenceStatus(ref, rows, asOf) };
}

/** Loads the rows the references need and returns the port. */
export async function loadReferencePort(db: Db, references: readonly flow.Reference[], asOf: string): Promise<{ port: validator.ReferencePort; rows: ReferenceRow[] }> {
  const rows = references.length === 0 ? [] : await loadReferenceRows(db, [...new Set(references.map((r) => r.code))]);
  return { port: referencePortFrom(rows, asOf), rows };
}
