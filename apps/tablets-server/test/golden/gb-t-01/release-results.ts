/**
 * The outputs of a packaging order and of its finished lot (Phase 4 slice 7b; D-S6-7), read back from the database for
 * the comparison with expected-release.json (GB-T-01) and expected.json (GB-T-02): the bulk issued to the order (the
 * genealogy edge to its processing batch), the printed-material reconciliations, the packs put in shippers, the line
 * clearance the order started on; the lot's state, its market dispositions, G-REL's items, its release results and
 * reserve samples. Batch numbers are written as placeholders (<batch-n>), so the outputs do not depend on the day.
 */
import { routes } from '@ebmr/api-contract';
import { records } from '@ebmr/kernel';
import type { TestBrowser } from '../../support/harness.ts';
import type { GoldenWorld } from './world.ts';

type Json = Record<string, unknown>;

async function one<T>(w: GoldenWorld, sql: string, params: unknown[]): Promise<T> {
  const { rows } = await w.server.db.admin.query<{ r: T }>(sql, params);
  return rows[0]?.r as T;
}

export interface OrderFacts {
  parent: string;
  bulkIssued: string[];
  reconciliations: Json[];
  shipperPacks: string;
  shippers: number;
  clearance: string;
}

export async function orderFacts(w: GoldenWorld, orderId: string): Promise<OrderFacts> {
  const parent = await one<string>(w, 'select b.batch_number as r from recipe.batch_execution b where b.id = recipe.packaging_parent_of($1)', [orderId]);
  const bulkIssued = await one<string[]>(
    w,
    "select coalesce(jsonb_agg(c.stage || '/' || coalesce(c.stream, '-') || ' ' || trim_scale(i.quantity)::text || ' ' || i.unit order by c.opened_at, c.id), '[]'::jsonb) as r from recipe.packaging_bulk_issue i join plant.output_container c on c.id = i.container_id where i.order_batch_id = $1",
    [orderId],
  );
  const state = await one<Json>(w, 'select state as r from recipe.execution_state where batch_id = $1', [orderId]);
  const entries = Object.values((state['entries'] ?? {}) as Record<string, Json>);
  const reconciliations = entries
    .filter((e) => e['stepKey'] === 'p-g21@' && e['kind'] === 'RECONCILIATION')
    // The reconciling person is an id of this run's seed: left out (D-S6-7 compares the counts).
    .map((e) => Object.fromEntries(Object.entries(e['data'] as Json).filter(([k]) => k !== 'reconciledBy')))
    .sort((a, b) => String(a['item']).localeCompare(String(b['item'])));
  const shippers = entries.filter((e) => e['stepKey'] === 'p-tb24@' && e['kind'] === 'SHIPPER').map((e) => (e['data'] as Json)['packs'] as string);
  const shipperPacks = shippers.reduce((n, p) => n + BigInt(p), 0n).toString();
  const clearance = await one<string>(
    w,
    "select x.clearance_type || ' ' || x.recorded_result || case when v.clearance_id is not null then ' VERIFIED' else '' end as r from plant.clearance x left join plant.clearance_verification v on v.clearance_id = x.id where x.next_batch_id = $1 order by x.performed_at desc limit 1",
    [orderId],
  );
  return { parent, bulkIssued, reconciliations, shipperPacks, shippers: shippers.length, clearance };
}

export interface LotFacts {
  state: string;
  quantity: string;
  markets: string[];
  dispositions: Record<string, string | null>;
  results: string[];
  samples: string[];
  grel: Record<string, string[]>;
}

export async function lotFacts(w: GoldenWorld, lotId: string, batchNumbers: readonly string[]): Promise<LotFacts> {
  const placeholders = (s: string): string => batchNumbers.reduce((t, b, i) => t.split(b).join(`<batch-${String(i + 1)}>`), s);
  const lot = await one<Json>(w, "select jsonb_build_object('state', site.lot_state(l.id), 'quantity', trim_scale(l.received_quantity)::text || ' ' || l.unit) as r from site.material_lot l where l.id = $1", [lotId]);
  const markets = await one<string[]>(w, "select to_jsonb(recipe.market_set('LOT', $1)) as r", [lotId]);
  const dispositions: Record<string, string | null> = {};
  for (const m of ['IN', 'US', 'EU']) dispositions[m] = await one<string | null>(w, 'select recipe.disposition_state($1, $2) as r', [lotId, m]);
  const results = await one<string[]>(
    w,
    "select coalesce(jsonb_agg(r.test_code || ' ' || r.result_value || ' ' || r.unit || ' ' || r.verdict || case when exists (select 1 from site.lot_test_approval a where a.result_id = r.id) then ' APPROVED' else '' end order by r.test_code), '[]'::jsonb) as r from site.lot_test_result r where r.lot_id = $1",
    [lotId],
  );
  const samples = await one<string[]>(w, "select coalesce(jsonb_agg(s.kind || ' ' || trim_scale(s.quantity)::text || ' ' || s.unit order by s.pulled_at), '[]'::jsonb) as r from site.lot_sample s where s.lot_id = $1", [lotId]);
  const grel: Record<string, string[]> = {};
  for (const m of markets) {
    const g = await one<Json>(w, 'select recipe.grel_evaluate($1, $2) as r', [lotId, m]);
    grel[m] = ((g['items'] as Json[] | undefined) ?? []).map((i) => placeholders(`${String(i['id'])} ${String(i['status'])}`));
  }
  return { state: String(lot['state']), quantity: String(lot['quantity']), markets, dispositions, results, samples, grel };
}

/** The unit codes of `codes` the PDF/A-3 true copy of batch `batchId` names (its associated record files), as QA reads it. */
export async function reportNames(b: TestBrowser, batchId: string, codes: readonly string[]): Promise<string[]> {
  const pdf = await b.call(routes.archive.pdf, { params: { batchId } });
  if (!pdf.ok) throw new Error(`the true copy of ${batchId} was refused: ${JSON.stringify(pdf.error)}`);
  const contents = await records.readPdfA3(new Uint8Array(Buffer.from(pdf.value.pdfBase64, 'base64')));
  const text = [...contents.attachments.values()].join('\n');
  return codes.filter((c) => text.includes(`"${c}"`));
}
