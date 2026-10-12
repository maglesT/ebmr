/**
 * Assembly of the EU QP batch package of a finished lot (Phase 4 slice 4b; outline 5.2.6; kernel 1160; DI-41).
 *
 * True copies (kernel true-copy bundles, one REPEATABLE READ snapshot each): the processing record and the packaging
 * record (`batch:<id>`), the review chains of both batches (`batch_review:<id>`, the audit-trail review acts), the
 * manufacturer release with its stored checklist (`manufacturer_release:<lot>`) and every deviation linked to the lot
 * or its batches (`deviation:<id>`). Documents written here (D-4b-4): the audit-trail review summary (review state and
 * the review chains copied), the post-entry change list (every audit event that changed a recorded row of the batch
 * chains after its entry, with its reason), the deviations with their per-market assessments for IN and EU
 * (site.deviation_release_items) and the CoA (the lot's current test results with their limits and states).
 *
 * The bundles are built outside the command (each in its own read-only snapshot); the command registers the true
 * copies and the package, and the database checks the hash and every section (records.register_qp_package).
 */
import { records } from '@ebmr/kernel';
import type pg from 'pg';

type Db = Pick<pg.Pool, 'query'>;

export interface LotFacts {
  lotId: string;
  lotCode: string;
  productCode: string;
  strength: string;
  markets: string[];
  manufacturerState: string | null;
  batches: string[];
}

export async function lotFacts(db: Db | pg.PoolClient, lotId: string): Promise<LotFacts | null> {
  const { rows } = await db.query<{ lot_code: string; product_code: string; strength: string; markets: string[] | null; mfr: string | null; batches: string[] | null }>(
    `select l.lot_code, f.product_code, f.strength, recipe.market_set('LOT', f.lot_id) as markets, recipe.manufacturer_release_state(f.lot_id) as mfr,
            recipe.release_batches(f.lot_id)::text[] as batches
       from site.finished_lot f join site.material_lot l on l.id = f.lot_id where f.lot_id = $1`,
    [lotId],
  );
  const r = rows[0];
  if (!r) return null;
  return { lotId, lotCode: r.lot_code, productCode: r.product_code, strength: r.strength, markets: r.markets ?? [], manufacturerState: r.mfr, batches: r.batches ?? [] };
}

/** Why a package of the lot cannot be assembled now (the screen shows them; assembly refuses). */
export function assembleProblems(f: LotFacts): string[] {
  const out: string[] = [];
  if (!f.markets.includes('EU')) out.push(`EU is not in the market set of lot ${f.lotCode}: no QP batch package is needed`);
  if (f.manufacturerState !== 'RELEASED') out.push(`the manufacturer release of lot ${f.lotCode} is ${f.manufacturerState ?? 'none'}: the package follows the AP's release`);
  if (f.batches.length < 2) out.push(`lot ${f.lotCode} has no processing record behind its packaging record`);
  return out;
}

export interface BuiltPackageParts {
  bundles: { name: string; role: records.QpSectionRole; title: string; bundle: records.TrueCopyBundle }[];
  documents: records.QpDocumentInput[];
  generatedAt: string;
  label: string;
}

const json = (v: unknown): string => JSON.stringify(v, null, 2);

/** The changes of recorded rows after their entry (UPDATE events) in a bundle's audit trail, with the reason given. */
function changesIn(bundle: records.TrueCopyBundle): Record<string, unknown>[] {
  const chain = JSON.parse(bundle.parts['audit-chain.json'] ?? '{"events": []}') as records.AuditChainPart;
  return chain.events
    .filter((e) => e.action === 'UPDATE')
    .map((e) => {
      const p = JSON.parse(e.payload) as { reason_code?: string | null; reason_text?: string | null; actor?: { legal_name?: string } };
      return { chainKey: chain.chainKey, seq: e.seq, recordedAt: e.recordedAt, table: e.tableName, recordId: e.recordId, by: p.actor?.legal_name ?? null,
               reasonCode: p.reason_code ?? null, reasonText: p.reason_text ?? null };
    });
}

/**
 * Builds every part of the package from the lot's records, inside the assembling person's command (the true copies come
 * from records.true_copy_snapshot, RECORD.TRUE_COPY_REGISTER; an empty chain has nothing to copy).
 */
export async function buildPackageParts(client: pg.PoolClient, f: LotFacts): Promise<BuiltPackageParts> {
  const [packaging, processing] = f.batches as [string, string];
  const bundles: BuiltPackageParts['bundles'] = [];
  const copy = async (name: string, role: records.QpSectionRole, title: string, chainKey: string, required: boolean): Promise<void> => {
    const bundle = await records.trueCopyBundleFromSnapshot(client, chainKey);
    if ((JSON.parse(bundle.manifest) as records.Manifest).head === null) {
      if (required) throw new Error(`EBMR-REC-083 ${chainKey} has no audit chain to copy`);
      return;
    }
    bundles.push({ name, role, title, bundle });
  };
  await copy('processing-record', 'PROCESSING_RECORD', 'Processing record', `batch:${processing}`, true);
  await copy('packaging-record', 'PACKAGING_RECORD', 'Packaging record', `batch:${packaging}`, true);
  await copy('processing-review', 'AUDIT_TRAIL_REVIEW', 'Review and audit-trail review of the processing record', `batch_review:${processing}`, false);
  await copy('packaging-review', 'AUDIT_TRAIL_REVIEW', 'Review and audit-trail review of the packaging record', `batch_review:${packaging}`, false);
  await copy('release', 'RELEASE', 'Manufacturer release and its stored checklist', `manufacturer_release:${f.lotId}`, true);
  const deviations = (await client.query<{ d: string[] | null }>('select recipe.release_deviations($1)::text[] as d', [f.lotId])).rows[0]?.d ?? [];
  for (const d of deviations) await copy(`deviation-${d}`, 'DEVIATIONS', 'Deviation record', `deviation:${d}`, false);

  const pool = client;
  const review = (
    await pool.query<{ batch_id: string; state: string | null }>('select b as batch_id, recipe.batch_review_state(b) as state from unnest($1::uuid[]) b', [[processing, packaging]])
  ).rows;
  const changes = bundles.filter((b) => b.role === 'PROCESSING_RECORD' || b.role === 'PACKAGING_RECORD').flatMap((b) => changesIn(b.bundle));
  const assessments: Record<string, unknown> = {};
  for (const m of ['IN', 'EU']) {
    const items = (
      await pool.query<{ kind: string; id: string; items: unknown }>(
        `select 'LOT' as kind, $1::uuid as id, site.deviation_release_items('LOT', $1, $3) as items
         union all select 'BATCH', b, site.deviation_release_items('BATCH', b, $3) from unnest($2::uuid[]) b`,
        [f.lotId, [processing, packaging], m],
      )
    ).rows;
    assessments[m] = items;
  }
  const coa = (
    await pool.query<{ test_code: string; purpose: string; value: string | null; unit: string | null; lower: string | null; upper: string | null; verdict: string | null; state: string | null }>(
      `select r.test_code, r.purpose, r.result_value::text as value, r.unit, r.lower_limit::text as lower, r.upper_limit::text as upper, r.verdict, site.lot_test_state(r.id) as state
         from site.lot_test_result r where r.lot_id = $1 order by r.test_code, r.recorded_at, r.id`,
      [f.lotId],
    )
  ).rows;
  const generatedAt = (await pool.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`)).rows[0]?.t ?? '';
  const label = `Lot ${f.lotCode}, ${f.productCode} ${f.strength}`;
  const lot = { lotId: f.lotId, lotCode: f.lotCode, product: f.productCode, strength: f.strength };
  const documents: records.QpDocumentInput[] = [
    { name: 'audit-trail-review', role: 'AUDIT_TRAIL_REVIEW', title: 'Audit-trail review', mediaType: 'application/json',
      text: json({ lot, batches: review.map((r) => ({ batchId: r.batch_id, reviewState: r.state, reviewChainCopied: bundles.some((b) => b.name === (r.batch_id === processing ? 'processing-review' : 'packaging-review')) })) }) },
    { name: 'post-entry-changes', role: 'POST_ENTRY_CHANGES', title: 'Post-entry changes to recorded data', mediaType: 'application/json',
      text: json({ lot, note: 'Every change of a recorded row of the processing and packaging records after its entry, with the reason given', changes }) },
    { name: 'deviations', role: 'DEVIATIONS', title: 'Deviations and their per-market assessments', mediaType: 'application/json', text: json({ lot, assessments }) },
    { name: 'coa', role: 'COA', title: 'Certificate of analysis (current results)', mediaType: 'application/json', text: json({ lot, results: coa }) },
  ];
  return { bundles, documents, generatedAt, label };
}

/** Registers the true copies and the package inside the caller's command; returns the package id. */
export async function registerPackage(client: pg.PoolClient, f: LotFacts, parts: BuiltPackageParts): Promise<{ packageId: string; packageSha256: string }> {
  for (const b of parts.bundles) await records.registerTrueCopy(client, b.bundle, `EU QP batch package of lot ${f.lotCode}`);
  const pkg = records.assembleQpPackage({ subject: { type: 'material_lot', id: f.lotId, label: parts.label }, generatedAt: parts.generatedAt, bundles: parts.bundles, documents: parts.documents });
  const packageId = await records.registerQpPackage(client, pkg);
  return { packageId, packageSha256: pkg.packageSha256 };
}
