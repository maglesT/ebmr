/**
 * The reads of feature `controlled` (Phase 6 slice 6e; draft IN-53): the flags, custody records, batch accounts and
 * register exports as the database holds them (recipe-core 1031 to 1034). Quantities stay decimal text throughout.
 *
 * Phase 7 slice 7a (6jc-R2): every read goes through the gated definers of tablets 1413 for the session behind the
 * request (its token hash), which need CONTROLLED.READ in the record's {site, product} scope; no route reads the tables
 * directly (the application role keeps SELECT only for true copies and archives, recipe-core 1215). A refusal is the
 * database's (EBMR-CSM-060 or 061, 403).
 */
import {
  CONTROLLED_DRAFT_BANNER,
  type CheckpointView,
  type ControlledBalanceView,
  type ControlledProductView,
  type CustodyView,
  type RegisterExtractView,
} from '@ebmr/api-contract';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { peopleOf, personRef } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

export const BANNER = CONTROLLED_DRAFT_BANNER;

/** The rows a gated definer of tablets 1413 answers (a JSON array) for the session of `tokenHash`. */
async function gated<T>(db: Db, sql: string, params: unknown[]): Promise<T[]> {
  return (await db.query<{ r: T[] | null }>(sql, params)).rows[0]?.r ?? [];
}

interface ProductRow {
  id: string;
  product_code: string;
  controlled: boolean;
  material_codes: string[];
  basis_ref: string;
  recorded_by_person: string;
  recorded_us: string;
  state: 'RECORDED' | 'APPROVED' | 'SUPERSEDED';
  approved_by_person: string | null;
  approved_us: string | null;
  in_effect: string[];
}

export async function productViews(app: AppContext, db: Db, tokenHash: string, product?: string): Promise<ControlledProductView[]> {
  const rows = await gated<ProductRow>(db, 'select tab.controlled_products($1, $2) as r', [tokenHash, product ?? null]);
  const people = await peopleOf(db, rows.flatMap((r) => [r.recorded_by_person, r.approved_by_person]));
  const out = new Map<string, ControlledProductView>();
  for (const r of rows) {
    const v = out.get(r.product_code) ?? { productCode: r.product_code, materialsInEffect: r.in_effect, records: [] };
    v.records.push({
      recordId: r.id,
      controlled: r.controlled,
      materialCodes: r.material_codes,
      basisRef: r.basis_ref,
      recordedBy: personRef(people, r.recorded_by_person, 'QA_MBR_APPROVER'),
      recordedAt: app.formatInstant(r.recorded_us),
      state: r.state,
      approvedBy: r.approved_by_person ? personRef(people, r.approved_by_person, 'QA') : null,
      approvedAt: r.approved_us ? app.formatInstant(r.approved_us) : null,
    });
    out.set(r.product_code, v);
  }
  return [...out.values()];
}

interface CustodyRow {
  id: string;
  kind: CustodyView['kind'];
  lot_id: string;
  lot_code: string;
  material_code: string;
  quantity: string;
  unit: string;
  batch_id: string | null;
  batch_number: string | null;
  from_location: string | null;
  to_location: string | null;
  note: string | null;
  proposed_by_person: string;
  proposed_us: string;
  state: CustodyView['state'];
  signatures: { position: 'FIRST' | 'SECOND'; person: string; us: string }[];
  used: boolean;
}

export async function custodyViews(app: AppContext, db: Db, tokenHash: string, filter: { lotId?: string | undefined; batchId?: string | undefined; custodyId?: string }): Promise<CustodyView[]> {
  const rows = await gated<CustodyRow>(db, 'select tab.controlled_custody($1, $2, $3, $4) as r', [tokenHash, filter.lotId ?? null, filter.batchId ?? null, filter.custodyId ?? null]);
  const people = await peopleOf(db, rows.flatMap((r) => [r.proposed_by_person, ...r.signatures.map((s) => s.person)]));
  return rows.map((r) => ({
    custodyId: r.id,
    kind: r.kind,
    lotId: r.lot_id,
    lotCode: r.lot_code,
    materialCode: r.material_code,
    quantity: r.quantity,
    unit: r.unit,
    batchId: r.batch_id,
    batchNumber: r.batch_number,
    fromLocation: r.from_location,
    toLocation: r.to_location,
    note: r.note,
    proposedBy: personRef(people, r.proposed_by_person, 'CUSTODIAN'),
    proposedAt: app.formatInstant(r.proposed_us),
    state: r.state,
    custodians: r.signatures.map((s) => ({ position: s.position, person: personRef(people, s.person, 'CUSTODIAN'), at: app.formatInstant(s.us) })),
    used: r.used,
  }));
}

interface CheckpointRow {
  id: string;
  stage_key: string;
  material_code: string;
  unit: string;
  dispensed: string;
  consumed: string;
  in_process: string;
  returned: string;
  destroyed: string;
  difference: string;
  explanation: string | null;
  deviation_id: string | null;
  deviation_ref: string | null;
  recorded_by_person: string;
  recorded_us: string;
  state: CheckpointView['state'];
  current: boolean;
}

export async function checkpointViews(app: AppContext, db: Db, tokenHash: string, filter: { batchId?: string; checkpointId?: string }): Promise<CheckpointView[]> {
  return checkpointsOf(app, db, await gated<CheckpointRow>(db, 'select tab.controlled_checkpoints($1, $2, $3) as r', [tokenHash, filter.batchId ?? null, filter.checkpointId ?? null]));
}

async function checkpointsOf(app: AppContext, db: Db, rows: CheckpointRow[]): Promise<CheckpointView[]> {
  const people = await peopleOf(db, rows.map((r) => r.recorded_by_person));
  return rows.map((r) => ({
    checkpointId: r.id,
    stageKey: r.stage_key,
    materialCode: r.material_code,
    unit: r.unit,
    dispensed: r.dispensed,
    consumed: r.consumed,
    inProcess: r.in_process,
    returned: r.returned,
    destroyed: r.destroyed,
    difference: r.difference,
    explanation: r.explanation,
    deviationId: r.deviation_id,
    deviationRef: r.deviation_ref,
    recordedBy: personRef(people, r.recorded_by_person, 'SHIFT_SUPERVISOR'),
    recordedAt: app.formatInstant(r.recorded_us),
    state: r.state,
    current: r.current,
  }));
}

interface BalanceRow {
  batch_number: string;
  product: string | null;
  materials: { material_code: string; balance: { unit: string | null; dispensed: string; returned: string; destroyed: string } | null }[];
  checkpoints: CheckpointRow[];
}

export async function balanceView(app: AppContext, db: Db, tokenHash: string, batchId: string): Promise<ControlledBalanceView | null> {
  const b = (await db.query<{ r: BalanceRow | null }>('select tab.controlled_balance($1, $2) as r', [tokenHash, batchId])).rows[0]?.r;
  if (!b) return null;
  const checkpoints = await checkpointsOf(app, db, b.checkpoints);
  const materials: ControlledBalanceView['materials'] = b.materials.map(({ material_code: m, balance: bal }) => ({
    materialCode: m,
    unit: bal?.unit ?? null,
    dispensed: bal?.dispensed ?? '0',
    returned: bal?.returned ?? '0',
    destroyed: bal?.destroyed ?? '0',
    checkpoints: checkpoints.filter((k) => k.materialCode === m),
  }));
  return { batchId, batchNumber: b.batch_number, productCode: b.product, banner: BANNER, materials };
}

interface ExtractRow {
  id: string;
  material_code: string;
  period_from: string;
  period_to: string;
  result_sha256: string;
  run_by_person: string;
  role_code: string;
  run_us: string;
  rows: number;
  result?: RegisterExtractView['result'];
  reproduces?: boolean;
}

export async function extractViews(app: AppContext, db: Db, tokenHash: string, extractId?: string): Promise<{ summaries: Omit<RegisterExtractView, 'banner' | 'reproduces' | 'result'>[]; full: RegisterExtractView | null }> {
  const rows = await gated<ExtractRow>(db, 'select tab.controlled_register_extracts($1, $2) as r', [tokenHash, extractId ?? null]);
  const people = await peopleOf(db, rows.map((r) => r.run_by_person));
  const summaries = rows.map((r) => ({
    extractId: r.id,
    materialCode: r.material_code,
    from: r.period_from,
    to: r.period_to,
    resultSha256: r.result_sha256,
    runBy: personRef(people, r.run_by_person, r.role_code),
    runAt: app.formatInstant(r.run_us),
    rows: r.rows,
  }));
  const first = rows[0];
  const full = extractId && first && summaries[0] && first.result ? { ...summaries[0], banner: BANNER, reproduces: first.reproduces === true, result: first.result } : null;
  return { summaries, full };
}
