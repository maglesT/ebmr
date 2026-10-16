/**
 * The reads of feature `controlled` (Phase 6 slice 6e; draft IN-53): the flags, custody records, batch accounts and
 * register exports as the database holds them (recipe-core 1031 to 1034). Quantities stay decimal text throughout.
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
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

export const BANNER = CONTROLLED_DRAFT_BANNER;

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

export async function productViews(app: AppContext, db: Db, product?: string): Promise<ControlledProductView[]> {
  const { rows } = await db.query<ProductRow>(
    `select r.id, r.product_code, r.controlled, r.material_codes, r.basis_ref, r.recorded_by_person, ${usOf('r.recorded_at')} as recorded_us,
            plant.controlled_record_state(r.id) as state, a.approved_by_person,
            case when a.record_id is null then null else ${usOf('a.approved_at')} end as approved_us,
            plant.controlled_materials(r.product_code) as in_effect
       from plant.controlled_product r left join plant.controlled_product_approval a on a.record_id = r.id
      where ($1::text is null or r.product_code = $1)
      order by r.product_code, r.recorded_at desc, r.id desc
      limit 2000`,
    [product ?? null],
  );
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

export async function custodyViews(app: AppContext, db: Db, filter: { lotId?: string | undefined; batchId?: string | undefined; custodyId?: string }): Promise<CustodyView[]> {
  const { rows } = await db.query<CustodyRow>(
    `select c.id, c.kind, c.lot_id, l.lot_code, c.material_code, c.quantity::text as quantity, c.unit, c.batch_id, b.batch_number, c.from_location, c.to_location,
            c.note, c.proposed_by_person, ${usOf('c.recorded_at')} as proposed_us, recipe.controlled_custody_state(c.id) as state,
            coalesce((select jsonb_agg(jsonb_build_object('position', s.position, 'person', s.person_id, 'us', ${usOf('s.recorded_at')}) order by s.position)
                        from recipe.controlled_custody_signature s where s.custody_id = c.id), '[]'::jsonb) as signatures,
            exists (select 1 from recipe.controlled_custody_use u where u.custody_id = c.id) as used
       from recipe.controlled_custody c join site.material_lot l on l.id = c.lot_id left join recipe.batch_execution b on b.id = c.batch_id
      where ($1::uuid is null or c.lot_id = $1) and ($2::uuid is null or c.batch_id = $2) and ($3::uuid is null or c.id = $3)
      order by c.recorded_at desc, c.id
      limit 500`,
    [filter.lotId ?? null, filter.batchId ?? null, filter.custodyId ?? null],
  );
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

export async function checkpointViews(app: AppContext, db: Db, filter: { batchId?: string; checkpointId?: string }): Promise<CheckpointView[]> {
  const { rows } = await db.query<CheckpointRow>(
    `select k.id, k.stage_key, k.material_code, k.unit, k.dispensed::text as dispensed, k.consumed::text as consumed, k.in_process::text as in_process,
            k.returned::text as returned, k.destroyed::text as destroyed, k.difference::text as difference, k.explanation, k.deviation_id,
            (select d.ref from site.deviation d where d.id = k.deviation_id) as deviation_ref, k.recorded_by_person, ${usOf('k.recorded_at')} as recorded_us,
            recipe.controlled_checkpoint_state(k.id) as state, recipe.controlled_checkpoint_current(k.id) as current
       from recipe.controlled_checkpoint k
      where ($1::uuid is null or k.batch_id = $1) and ($2::uuid is null or k.id = $2)
      order by k.recorded_at desc, k.id
      limit 500`,
    [filter.batchId ?? null, filter.checkpointId ?? null],
  );
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

export async function balanceView(app: AppContext, db: Db, batchId: string): Promise<ControlledBalanceView | null> {
  const { rows } = await db.query<{ batch_number: string; product: string | null; materials: string[] }>(
    `select b.batch_number, recipe.batch_product(b.id) ->> 'code' as product,
            (select coalesce(array_agg(distinct m order by m), '{}') from (
               select unnest(recipe.batch_controlled_materials(b.id)) as m
               union select k.material_code from recipe.controlled_checkpoint k where k.batch_id = b.id) x) as materials
       from recipe.batch_execution b where b.id = $1`,
    [batchId],
  );
  const b = rows[0];
  if (!b) return null;
  const checkpoints = await checkpointViews(app, db, { batchId });
  const materials: ControlledBalanceView['materials'] = [];
  for (const m of b.materials) {
    const bal = (await db.query<{ r: { unit: string | null; dispensed: string; returned: string; destroyed: string } }>('select recipe.controlled_balance($1, $2) as r', [batchId, m])).rows[0]?.r;
    materials.push({
      materialCode: m,
      unit: bal?.unit ?? null,
      dispensed: bal?.dispensed ?? '0',
      returned: bal?.returned ?? '0',
      destroyed: bal?.destroyed ?? '0',
      checkpoints: checkpoints.filter((k) => k.materialCode === m),
    });
  }
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

export async function extractViews(app: AppContext, db: Db, extractId?: string): Promise<{ summaries: Omit<RegisterExtractView, 'banner' | 'reproduces' | 'result'>[]; full: RegisterExtractView | null }> {
  const { rows } = await db.query<ExtractRow>(
    `select x.id, x.material_code, x.period_from::text as period_from, x.period_to::text as period_to, x.result_sha256, x.run_by_person, x.role_code,
            ${usOf('x.recorded_at')} as run_us, jsonb_array_length(x.result -> 'rows') as rows
            ${extractId ? ', x.result, recipe.controlled_register_reproduces(x.id) as reproduces' : ''}
       from recipe.controlled_register_extract x
      where ($1::uuid is null or x.id = $1)
      order by x.recorded_at desc, x.id
      limit 200`,
    [extractId ?? null],
  );
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
