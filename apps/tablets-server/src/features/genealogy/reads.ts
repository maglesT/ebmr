/**
 * The reads of the genealogy and recall namespaces (Phase 6 slice 6d; contract ns/genealogy.ts and ns/recall.ts;
 * recipe-core 1010 to 1013, site services 0960, 0961). Every value is the database's: the trace is recipe.genealogy,
 * the node details recipe.genealogy_node_views, the lookup, deviations and supply chain their definers, the distribution
 * records site.erp_shipment, the mock recall its stored row, result and sign-off.
 */
import type pg from 'pg';
import type {
  MockRecallFederationView,
  ComplaintLookupView,
  DeviationImpactView,
  DistributionRecordView,
  GenealogyDirection,
  GenealogyEdgeView,
  GenealogyNodeKind,
  GenealogyNodeView,
  GenealogyTraceView,
  MockRecallSummaryView,
  MockRecallView,
  RecurrenceView,
  SupplyChainView,
} from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

/** SQL: epoch microseconds text ($n) as an exact timestamptz. */
export const tsOf = (param: string): string => `(timestamptz 'epoch' + (${param}::bigint * interval '1 microsecond'))`;

/** The as-of point: the one asked, or the database's now (read once, so the reply states the instant used). */
async function asOfUs(db: Db, asked: string | undefined): Promise<string> {
  if (asked !== undefined) return asked;
  return (await db.query<{ us: string }>(`select ${usOf('clock_timestamp()')} as us`)).rows[0]!.us;
}

interface NodeRow {
  kind: GenealogyNodeKind;
  id: string;
  label: string;
  code: string | null;
  name: string | null;
  sub_kind: string | null;
  state: string | null;
}
const nodeView = (n: NodeRow): GenealogyNodeView => ({ kind: n.kind, id: n.id, label: n.label, code: n.code, name: n.name, subKind: n.sub_kind, state: n.state });

export async function nodeViews(db: Db, refs: readonly { kind: string; id: string }[]): Promise<GenealogyNodeView[]> {
  if (refs.length === 0) return [];
  const { rows } = await db.query<{ v: NodeRow[] }>('select recipe.genealogy_node_views($1::text[], $2::uuid[]) as v', [refs.map((r) => r.kind), refs.map((r) => r.id)]);
  return (rows[0]?.v ?? []).map(nodeView);
}

interface TraceRow {
  node_kind: GenealogyNodeKind;
  node_id: string;
  parent_kind: GenealogyNodeKind | null;
  parent_id: string | null;
  edge_kind: GenealogyEdgeView['edgeKind'];
  depth: number;
}

async function traceRows(db: Db, kind: string, id: string, direction: GenealogyDirection, us: string): Promise<TraceRow[]> {
  return (await db.query<TraceRow>(`select * from recipe.genealogy($1, $2, $3, ${tsOf('$4')})`, [kind, id, direction, us])).rows;
}

export async function trace(app: AppContext, db: Db, kind: GenealogyNodeKind, id: string, direction: GenealogyDirection, asked: string | undefined): Promise<GenealogyTraceView> {
  const us = await asOfUs(db, asked);
  const rows = await traceRows(db, kind, id, direction, us);
  const distinct = new Map<string, { kind: string; id: string }>();
  for (const r of rows) distinct.set(`${r.node_kind}:${r.node_id}`, { kind: r.node_kind, id: r.node_id });
  const nodes = await nodeViews(db, [...distinct.values()]);
  const start = nodes.find((n) => n.kind === kind && n.id === id);
  if (!start) throw refusal(404, { code: 'EBMR-GEN-002', kind: 'INVALID_INPUT', whatHappened: 'There is no such node at the time asked.', whatYouCanDo: ['Check the number.'] });
  const count = (k: GenealogyNodeKind) => nodes.filter((n) => n.kind === k).length;
  return {
    start,
    direction,
    asOf: app.formatInstant(us),
    nodes,
    edges: rows.map((r) => ({
      node: { kind: r.node_kind, id: r.node_id },
      parent: r.parent_kind && r.parent_id ? { kind: r.parent_kind, id: r.parent_id } : null,
      edgeKind: r.edge_kind,
      depth: r.depth,
    })),
    counts: { lots: count('LOT'), batches: count('BATCH'), containers: count('CONTAINER'), shipments: count('SHIPMENT'), ...(count('TRANSFER') ? { transfers: count('TRANSFER') } : {}) },
  };
}

interface ShipmentRow {
  id: string;
  shipment_no: string;
  lot_id: string;
  lot_code: string;
  product_name: string | null;
  strength: string | null;
  dosage_form: string | null;
  market: DistributionRecordView['market'];
  consignee_code: string;
  consignee_name: string;
  consignee_address: string | null;
  quantity: string;
  unit: string;
  shipped_us: string;
}

export async function distributionRecords(app: AppContext, db: Db, lotIds: readonly string[]): Promise<DistributionRecordView[]> {
  if (lotIds.length === 0) return [];
  const { rows } = await db.query<ShipmentRow>(
    `select s.id, s.shipment_no, s.lot_id, coalesce(s.lot_code, l.lot_code) as lot_code, coalesce(s.product_name, l.material_name) as product_name, s.strength, s.dosage_form,
            s.market, s.consignee_code, s.consignee_name, s.consignee_address, s.quantity::text as quantity, s.unit, ${usOf('coalesce(s.shipped_at, s.recorded_at)')} as shipped_us
       from site.erp_shipment s join site.material_lot l on l.id = s.lot_id where s.lot_id = any ($1::uuid[]) order by s.shipment_no`,
    [lotIds],
  );
  return rows.map((r) => ({
    shipmentId: r.id,
    shipmentNo: r.shipment_no,
    lotId: r.lot_id,
    lotCode: r.lot_code,
    productName: r.product_name,
    strength: r.strength,
    dosageForm: r.dosage_form,
    market: r.market,
    consigneeCode: r.consignee_code,
    consigneeName: r.consignee_name,
    consigneeAddress: r.consignee_address,
    quantity: r.quantity,
    unit: r.unit,
    shippedAt: app.formatInstant(r.shipped_us),
    complete: r.consignee_address !== null,
  }));
}

export async function lookup(app: AppContext, db: Db, code: string): Promise<ComplaintLookupView> {
  const lotId = (await db.query<{ id: string | null }>('select recipe.genealogy_lookup($1)::text as id', [code])).rows[0]?.id ?? null;
  if (!lotId) {
    throw refusal(404, {
      code: 'EBMR-GEN-010',
      kind: 'INVALID_INPUT',
      whatHappened: 'No lot, finished batch or shipment has this number.',
      why: `Nothing is recorded under ${code}.`,
      whatYouCanDo: ['Check the number on the complaint (lot or batch number, or the shipment number).'],
      whoCanHelp: ['QA'],
      controls: ['PR-57'],
    });
  }
  const us = await asOfUs(db, undefined);
  const [lot] = await nodeViews(db, [{ kind: 'LOT', id: lotId }]);
  const batchIds = (await db.query<{ b: string[] | null }>('select recipe.release_batches($1)::text[] as b', [lotId])).rows[0]?.b ?? [];
  const deviations = (await db.query<{ d: { deviation_id: string; ref: string; kind: string; title: string; classification: string; state: string }[] }>('select recipe.genealogy_lot_deviations($1) as d', [lotId])).rows[0]?.d ?? [];
  const up = await traceRows(db, 'LOT', lotId, 'BACKWARD', us);
  const down = await traceRows(db, 'LOT', lotId, 'FORWARD', us);
  const lotsOf = (rows: TraceRow[]) => [...new Set(rows.filter((r) => r.node_kind === 'LOT' && r.depth > 0).map((r) => r.node_id))].map((id) => ({ kind: 'LOT', id }));
  return {
    query: code,
    lot: lot!,
    batches: await nodeViews(db, batchIds.map((id) => ({ kind: 'BATCH', id }))),
    deviations: deviations.map((d) => ({ deviationId: d.deviation_id, ref: d.ref, kind: d.kind, title: d.title, classification: d.classification, state: d.state })),
    shipments: await distributionRecords(app, db, [lotId]),
    upstreamLots: await nodeViews(db, lotsOf(up)),
    downstreamLots: await nodeViews(db, lotsOf(down)),
  };
}

export async function supplyChain(app: AppContext, db: Db, lotId: string, asked: string | undefined): Promise<SupplyChainView> {
  const us = await asOfUs(db, asked);
  const [lot] = await nodeViews(db, [{ kind: 'LOT', id: lotId }]);
  if (!lot) throw refusal(404, { code: 'EBMR-GEN-002', kind: 'INVALID_INPUT', whatHappened: 'There is no such lot.', whatYouCanDo: ['Open the lot from the release queue or the lookup.'] });
  const lines = (await db.query<{ l: { lot_id: string; depth: number; supplier: string | null; supplier_lot: string | null; manufacturer_code: string | null; consumed_by: string[] }[] }>(
    `select recipe.genealogy_supply_chain($1, ${tsOf('$2')}) as l`, [lotId, us])).rows[0]?.l ?? [];
  const views = new Map((await nodeViews(db, lines.map((l) => ({ kind: 'LOT', id: l.lot_id })))).map((v) => [v.id, v]));
  return {
    lot,
    asOf: app.formatInstant(us),
    lines: lines.map((l) => ({ lot: views.get(l.lot_id)!, depth: l.depth, supplier: l.supplier, supplierLot: l.supplier_lot, manufacturerCode: l.manufacturer_code, consumedBy: l.consumed_by.sort() })),
  };
}

export async function deviationImpact(app: AppContext, db: Db, deviationId: string, asked: string | undefined): Promise<DeviationImpactView> {
  const us = await asOfUs(db, asked);
  const { rows } = await db.query<{ batch_id: string; batch_number: string | null; product_code: string | null; relation: 'LINKED' | 'DOWNSTREAM' | 'SHARED_LOT' }>(
    `select batch_id, batch_number, product_code, relation from recipe.deviation_impact_batches($1, ${tsOf('$2')})`, [deviationId, us]);
  const ref = (await db.query<{ ref: string }>('select ref from site.deviation where id = $1', [deviationId])).rows[0]?.ref ?? deviationId;
  return {
    deviationId,
    ref,
    asOf: app.formatInstant(us),
    batches: rows.map((r) => ({ batchId: r.batch_id, batchNumber: r.batch_number ?? r.batch_id, productCode: r.product_code, relation: r.relation })),
  };
}

export async function recurrence(app: AppContext, db: Db, lotId: string): Promise<RecurrenceView> {
  const { rows } = await db.query<{ r: { warning: boolean; threshold: number; window_days: number; items: { deviation_id: string; ref: string; title: string; root_cause_category: string | null; product_code: string; occurrences: number; warning: boolean; others: { deviation_id: string; ref: string; raised_us: string }[] }[] } | null; finished: boolean }>(
    'select recipe.deviation_recurrence($1) as r, exists (select 1 from site.finished_lot where lot_id = $1) as finished', [lotId]);
  const r = rows[0];
  if (!r?.finished || !r.r) {
    throw refusal(404, { code: 'EBMR-GEN-011', kind: 'INVALID_INPUT', whatHappened: 'This is no finished lot.', whatYouCanDo: ['Open the lot from the release queue.'], controls: ['PR-49'] });
  }
  return {
    lotId,
    threshold: r.r.threshold,
    windowDays: r.r.window_days,
    warning: r.r.warning,
    items: r.r.items.map((i) => ({
      deviationId: i.deviation_id,
      ref: i.ref,
      title: i.title,
      rootCauseCategory: i.root_cause_category,
      productCode: i.product_code,
      occurrences: i.occurrences,
      warning: i.warning,
      others: i.others.map((o) => ({ deviationId: o.deviation_id, ref: o.ref, raisedAt: app.formatInstant(o.raised_us) })),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Mock recalls
// ---------------------------------------------------------------------------------------------

interface RecallResult {
  batches: { batch_id: string; batch_number: string | null; product_code: string | null; depth: number }[];
  lots: { lot_id: string; lot_code: string; material_code: string; material_kind: string; depth: number; unit: string; delivered: string; returned: string; outstanding: string }[];
  consignees: { consignee_code: string; consignee_name: string; consignee_address: string | null; markets: string[]; shipments: { shipment_no: string; lot_code: string; quantity: string; unit: string; shipped_us: string }[] }[];
  incomplete: string[];
  counts: { batches: number; lots: number; consignees: number; shipments: number; incomplete_records: number };
}
interface RecallRow {
  id: string;
  subject_kind: 'LOT' | 'DEVIATION';
  subject_id: string;
  subject_ref: string;
  as_of_us: string;
  query_version: number;
  result_sha256: string;
  authority_informed: boolean;
  authority_reference: string | null;
  counts: RecallResult['counts'];
  person_id: string;
  role_code: string;
  ran_us: string;
  signoff: { person_id: string; role_code: string; us: string; signature_id: string } | null;
}

const SUMMARY = `select m.id, m.subject_kind, m.subject_id, m.subject_ref, ${usOf('m.as_of')} as as_of_us, m.query_version, m.result_sha256, m.authority_informed,
                        m.authority_reference, m.result -> 'counts' as counts, m.person_id, m.role_code, ${usOf('m.recorded_at')} as ran_us,
                        (select jsonb_build_object('person_id', s.person_id, 'role_code', s.role_code, 'us', ${usOf('s.recorded_at')}, 'signature_id', s.signature_id)
                           from recipe.mock_recall_signoff s where s.mock_recall_id = m.id) as signoff
                   from recipe.mock_recall m`;

async function summaries(app: AppContext, db: Db, rows: RecallRow[]): Promise<MockRecallSummaryView[]> {
  const people = await peopleOf(db, rows.flatMap((r) => [r.person_id, r.signoff?.person_id]));
  return rows.map((r) => ({
    mockRecallId: r.id,
    subjectKind: r.subject_kind,
    subjectId: r.subject_id,
    subjectRef: r.subject_ref,
    asOf: app.formatInstant(r.as_of_us),
    queryVersion: r.query_version,
    resultSha256: r.result_sha256,
    authorityInformed: r.authority_informed,
    authorityReference: r.authority_reference,
    counts: { batches: r.counts.batches, lots: r.counts.lots, consignees: r.counts.consignees, shipments: r.counts.shipments, incompleteRecords: r.counts.incomplete_records },
    ranBy: personRef(people, r.person_id, r.role_code),
    ranAt: app.formatInstant(r.ran_us),
    signOff: r.signoff ? { signedBy: personRef(people, r.signoff.person_id, r.signoff.role_code), signedAt: app.formatInstant(r.signoff.us), signatureId: r.signoff.signature_id } : null,
  }));
}

export async function mockRecallList(app: AppContext, db: Db): Promise<MockRecallSummaryView[]> {
  const { rows } = await db.query<RecallRow>(`${SUMMARY} order by m.recorded_at desc, m.id limit 200`);
  return summaries(app, db, rows);
}

export async function mockRecallView(app: AppContext, db: Db, id: string): Promise<MockRecallView> {
  const { rows } = await db.query<RecallRow & { result: RecallResult; reproduces: boolean }>(
    `select s.*, m.result, recipe.mock_recall_reproduces(m.id) as reproduces from (${SUMMARY} where m.id = $1) s join recipe.mock_recall m on m.id = s.id`, [id]);
  const r = rows[0];
  if (!r) {
    throw refusal(404, { code: 'EBMR-RCL-010', kind: 'INVALID_INPUT', whatHappened: 'There is no mock recall with this id.', why: `Mock recall ${id} was never run.`, whatYouCanDo: ['Open the mock recall from the list.'] });
  }
  const [summary] = await summaries(app, db, [r]);
  const res = r.result;
  const federation = r.query_version >= 2 ? await mockRecallFederation(app, db, id) : undefined;
  return {
    ...summary!,
    ...(federation ? { federation } : {}),
    reproduces: r.reproduces,
    batches: res.batches.map((b) => ({ batchId: b.batch_id, batchNumber: b.batch_number ?? b.batch_id, productCode: b.product_code, depth: b.depth })),
    lots: res.lots.map((l) => ({ lotId: l.lot_id, lotCode: l.lot_code, materialCode: l.material_code, materialKind: l.material_kind, depth: l.depth, unit: l.unit, delivered: l.delivered, returned: l.returned, outstanding: l.outstanding })),
    consignees: res.consignees.map((c) => ({
      consigneeCode: c.consignee_code,
      consigneeName: c.consignee_name,
      consigneeAddress: c.consignee_address,
      markets: c.markets,
      shipments: c.shipments.map((s) => ({ shipmentNo: s.shipment_no, lotCode: s.lot_code, quantity: s.quantity, unit: s.unit, shippedAt: app.formatInstant(s.shipped_us) })),
    })),
    incomplete: res.incomplete,
  };
}

interface FederationRow {
  complete: boolean;
  beyond_one_hop: { transfer_id: string; package_no: string; destination: string }[];
  transfers: { transfer_id: string; package_no: string; destination: string; depth: number; status: MockRecallFederationView['transfers'][number]['status']; excerpt_id: string | null; excerpt_as_of_us: string | null; detail: string | null }[];
}

/**
 * Phase 6 slice 6i (recipe-core 1091): per outbound transfer the run reached, what its destination answered (the
 * database's recipe.mock_recall_federation), with the lots, batches and shipments of the excerpt shown.
 */
export async function mockRecallFederation(app: AppContext, db: Db, id: string): Promise<MockRecallFederationView> {
  const f = (await db.query<{ f: FederationRow }>('select recipe.mock_recall_federation($1) as f', [id])).rows[0]!.f;
  const ids = f.transfers.map((t) => t.excerpt_id).filter((x): x is string => x !== null);
  const payloads = new Map((await db.query<{ id: string; payload: string }>('select id::text, payload from recipe.federated_excerpt where id = any ($1::uuid[])', [ids])).rows.map((r) => [r.id, r.payload]));
  return {
    complete: f.complete,
    beyondOneHop: f.beyond_one_hop.map((b) => ({ transferId: b.transfer_id, packageNo: b.package_no, destination: b.destination })),
    transfers: f.transfers.map((t) => {
      const nodes = t.excerpt_id ? ((JSON.parse(payloads.get(t.excerpt_id) ?? '{"nodes":[]}') as { nodes: NodeRow[] }).nodes) : [];
      return {
        transferId: t.transfer_id,
        packageNo: t.package_no,
        destination: t.destination,
        depth: t.depth,
        status: t.status,
        excerptAsOf: t.excerpt_as_of_us ? app.formatInstant(t.excerpt_as_of_us) : null,
        detail: t.detail,
        lots: nodes.filter((n) => n.kind === 'LOT').map((n) => ({ lotId: n.id, lotCode: n.label, materialCode: n.code, state: n.state })),
        batches: nodes.filter((n) => n.kind === 'BATCH').map((n) => ({ batchId: n.id, batchNumber: n.label })),
        shipments: nodes.filter((n) => n.kind === 'SHIPMENT').map((n) => ({ shipmentId: n.id, shipmentNo: n.label, consigneeCode: n.state, market: n.sub_kind })),
      };
    }),
  };
}
