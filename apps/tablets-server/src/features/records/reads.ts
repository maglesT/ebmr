/**
 * The reads of record locking (Phase 4 slice 5b; contract ns/records-lock.ts): a record's lock and amendments, the bulk
 * reconciliation of a processing batch, the locked records, the bright-stock maximum holds. Every value is the
 * database's (recipe-core 0870 to 0873).
 */
import type pg from 'pg';
import type {
  AmendmentView,
  BrightStockHoldView,
  BulkContainerView,
  BulkOrderView,
  BulkQuantity,
  BulkReconciliationView,
  LockCause,
  LockedRecordKind,
  MarketImpactTaskView,
  RecordLockState,
  RecordLockSummaryView,
  RecordLockView,
} from '@ebmr/api-contract';
import type { AppContext } from '../../platform/context.ts';
import { refusal } from '../../platform/http/refusal.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';

type Db = Pick<pg.Pool, 'query'>;

function noBatch(batchId: string): Error {
  return refusal(404, { code: 'EBMR-LCK-030', kind: 'INVALID_INPUT', whatHappened: 'There is no GMP batch record with this id.', why: `Batch ${batchId} is no GMP batch.`, whatYouCanDo: ['Open the batch from its list.'] });
}

interface BatchRow {
  batch_number: string;
  kind: LockedRecordKind;
  state: RecordLockState;
}

async function batchOf(db: Db, batchId: string): Promise<BatchRow> {
  const { rows } = await db.query<BatchRow>(
    "select b.batch_number, recipe.batch_family_kind(b.id) as kind, recipe.record_lock_state(b.id) as state from recipe.batch_execution b where b.id = $1 and b.purpose = 'GMP_BATCH'",
    [batchId],
  );
  const r = rows[0];
  if (!r) throw noBatch(batchId);
  return r;
}

interface AmendmentRow {
  id: string;
  number: number;
  basis_kind: 'DEVIATION' | 'CHANGE_RECORD';
  basis_id: string;
  basis_ref: string;
  reason_text: string;
  person_id: string;
  role_code: string | null;
  opened_us: string;
  signature_id: string;
  suspended: { lot_id: string; lot_code: string }[];
  close: { person_id: string; role_code: string | null; us: string; signature_id: string; statement: string } | null;
  entries: { id: string; seq: number; kind: AmendmentView['entries'][number]['kind']; target: string; body: string; value: string | null; reason: string; person_id: string; role_code: string | null; us: string }[];
  tasks: { id: string; lot_id: string; lot_code: string; market: 'IN' | 'US' | 'EU'; now: string | null; us: string }[];
}

async function amendmentsOf(app: AppContext, db: Db, batchId: string, number?: number): Promise<AmendmentView[]> {
  const { rows } = await db.query<AmendmentRow>(
    `select a.id, a.number, a.basis_kind, coalesce(a.deviation_id, a.change_record_id) as basis_id,
            coalesce((select d.ref from site.deviation d where d.id = a.deviation_id), (select c.number from recipe.change_record c where c.id = a.change_record_id)) as basis_ref,
            a.reason_text, a.person_id, a.role_code, ${usOf('a.opened_at')} as opened_us, a.signature_id,
            coalesce((select jsonb_agg(jsonb_build_object('lot_id', l, 'lot_code', (select m.lot_code from site.material_lot m where m.id = l)) order by l)
                        from unnest(a.suspended_lots) l), '[]'::jsonb) as suspended,
            (select jsonb_build_object('person_id', x.person_id, 'role_code', x.role_code, 'us', ${usOf('x.closed_at')}, 'signature_id', x.signature_id, 'statement', x.statement)
               from recipe.record_amendment_close x where x.amendment_id = a.id) as close,
            coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'seq', e.seq, 'kind', e.kind, 'target', e.target, 'body', e.body, 'value', e.value, 'reason', e.reason,
                                                          'person_id', e.person_id, 'role_code', e.role_code, 'us', ${usOf('e.recorded_at')}) order by e.seq)
                        from recipe.record_amendment_entry e where e.amendment_id = a.id), '[]'::jsonb) as entries,
            coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'lot_id', t.lot_id, 'lot_code', (select m.lot_code from site.material_lot m where m.id = t.lot_id),
                                                          'market', t.market,
                                                          'now', case t.market when 'IN' then recipe.manufacturer_release_state(t.lot_id) else recipe.disposition_state(t.lot_id, t.market) end,
                                                          'us', ${usOf('t.opened_at')}) order by t.lot_id, t.market)
                        from recipe.amendment_market_task t where t.amendment_id = a.id), '[]'::jsonb) as tasks
       from recipe.record_amendment a
      where a.batch_id = $1 and ($2::int is null or a.number = $2::int)
      order by a.number`,
    [batchId, number ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.person_id, r.close?.person_id, ...r.entries.map((e) => e.person_id)]));
  return rows.map((r): AmendmentView => {
    const open = r.close === null;
    return {
      amendmentId: r.id,
      number: r.number,
      batchId,
      state: open ? 'OPEN' : 'CLOSED',
      basis: { kind: r.basis_kind, id: r.basis_id, ref: r.basis_ref },
      reason: r.reason_text,
      openedBy: personRef(people, r.person_id, r.role_code ?? 'QA'),
      openedAt: app.formatInstant(r.opened_us),
      openSignatureId: r.signature_id,
      closedBy: r.close ? personRef(people, r.close.person_id, r.close.role_code ?? 'QA') : null,
      closedAt: r.close ? app.formatInstant(r.close.us) : null,
      closeSignatureId: r.close?.signature_id ?? null,
      closingStatement: r.close?.statement ?? null,
      entries: r.entries.map((e) => ({
        entryId: e.id,
        seq: e.seq,
        kind: e.kind,
        target: e.target,
        text: e.body,
        value: e.value,
        reason: e.reason,
        by: personRef(people, e.person_id, e.role_code ?? 'OPERATOR'),
        at: app.formatInstant(e.us),
      })),
      suspendedLots: r.suspended.map((l) => ({ lotId: l.lot_id, lotCode: l.lot_code })),
      tasks: r.tasks.map((t): MarketImpactTaskView => ({
        taskId: t.id,
        lotId: t.lot_id,
        lotCode: t.lot_code,
        market: t.market,
        ownerRole: 'AUTHORISED_PERSON',
        state: open || t.now === 'RELEASE_SUSPENDED' ? 'OPEN' : 'DONE',
        dispositionNow: t.now,
        openedAt: app.formatInstant(t.us),
      })),
    };
  });
}

/** One amendment of the record by its number (after an entry is appended). */
export async function amendmentView(app: AppContext, db: Db, batchId: string, number: number): Promise<AmendmentView> {
  await batchOf(db, batchId);
  const [a] = await amendmentsOf(app, db, batchId, number);
  if (!a) throw refusal(404, { code: 'EBMR-LCK-040', kind: 'INVALID_INPUT', whatHappened: 'There is no such amendment of the record.', why: `Amendment ${number} of batch ${batchId} does not exist.`, whatYouCanDo: ['Reload the record.'] });
  return a;
}

export async function lockView(app: AppContext, db: Db, batchId: string): Promise<RecordLockView> {
  const b = await batchOf(db, batchId);
  const { rows } = await db.query<{ cause: LockCause | null; us: string | null; lots: { lot_id: string; lot_code: string }[] }>(
    `select (select e.cause from recipe.record_lock_event e where e.batch_id = $1 and e.event = 'LOCKED') as cause,
            (select ${usOf('e.recorded_at')} from recipe.record_lock_event e where e.batch_id = $1 and e.event = 'LOCKED') as us,
            recipe.record_released_lots($1) as lots`,
    [batchId],
  );
  const r = rows[0]!;
  const amendments = await amendmentsOf(app, db, batchId);
  const open = amendments.find((a) => a.state === 'OPEN');
  return {
    batchId,
    batchNumber: b.batch_number,
    recordKind: b.kind,
    state: b.state,
    lockedAt: r.us ? app.formatInstant(r.us) : null,
    cause: r.cause,
    amendments,
    nextAmendmentNumber: amendments.length + 1,
    openAmendmentNumber: open?.number ?? null,
    releasedLots: r.lots.map((l) => ({ lotId: l.lot_id, lotCode: l.lot_code })),
  };
}

export async function lockList(app: AppContext, db: Db, state: 'LOCKED' | 'UNDER_AMENDMENT' | undefined): Promise<RecordLockSummaryView[]> {
  const { rows } = await db.query<{ batch_id: string; batch_number: string; kind: LockedRecordKind; state: 'LOCKED' | 'UNDER_AMENDMENT'; cause: LockCause; us: string; open: number | null }>(
    `select e.batch_id, b.batch_number, recipe.batch_family_kind(b.id) as kind, recipe.record_lock_state(b.id) as state, e.cause, ${usOf('e.recorded_at')} as us,
            (select max(a.number) from recipe.record_amendment a where a.batch_id = b.id
                and not exists (select 1 from recipe.record_amendment_close x where x.amendment_id = a.id)) as open
       from recipe.record_lock_event e join recipe.batch_execution b on b.id = e.batch_id
      where e.event = 'LOCKED' and ($1::text is null or recipe.record_lock_state(b.id) = $1::text)
      order by e.recorded_at desc, b.batch_number
      limit 500`,
    [state ?? null],
  );
  return rows.map((r) => ({ batchId: r.batch_id, batchNumber: r.batch_number, recordKind: r.kind, state: r.state, lockedAt: app.formatInstant(r.us), cause: r.cause, openAmendmentNumber: r.open }));
}

interface HoldRow {
  product_code: string;
  strength: string;
  max_hold_hours: number;
  reason: string;
  person_id: string;
  role_code: string | null;
  us: string;
}

async function holdViews(app: AppContext, db: Db, where: string, params: unknown[]): Promise<BrightStockHoldView[]> {
  const { rows } = await db.query<HoldRow>(
    `select distinct on (h.product_code, h.strength) h.product_code, h.strength, h.max_hold_hours, h.reason, h.person_id, h.role_code, ${usOf('h.recorded_at')} as us
       from recipe.bright_stock_max_hold h where ${where}
      order by h.product_code, h.strength, h.recorded_at desc, h.id desc`,
    params,
  );
  const people = await peopleOf(db, rows.map((r) => r.person_id));
  return rows.map((r) => ({
    productCode: r.product_code,
    strength: r.strength,
    maxHoldHours: String(r.max_hold_hours),
    reason: r.reason,
    setBy: personRef(people, r.person_id, r.role_code ?? 'MASTER_DATA_STEWARD'),
    setAt: app.formatInstant(r.us),
  }));
}

export const holdList = (app: AppContext, db: Db): Promise<BrightStockHoldView[]> => holdViews(app, db, 'true', []);

export async function holdOf(app: AppContext, db: Db, productCode: string, strength: string): Promise<BrightStockHoldView | null> {
  return (await holdViews(app, db, 'h.product_code = $1 and h.strength = $2', [productCode, strength]))[0] ?? null;
}

interface ContainerRow {
  id: string;
  label: string;
  quantity: string | null;
  unit: BulkContainerView['unit'];
  state: string | null;
  closed_us: string | null;
  disposition: BulkContainerView['disposition'];
  order_id: string | null;
  order_number: string | null;
  hours: string | null;
  past: boolean;
}

export async function bulkView(app: AppContext, db: Db, batchId: string): Promise<BulkReconciliationView> {
  const b = await batchOf(db, batchId);
  const { rows: containers } = await db.query<ContainerRow>(
    `select c.id, c.label_code as label, x.net_quantity::text as quantity, c.quantity_unit as unit, plant.container_state(c.id) as state,
            case when x.closed_at is null then null else ${usOf('x.closed_at')} end as closed_us,
            recipe.bulk_container_disposition(c.id) as disposition, i.order_batch_id as order_id, o.batch_number as order_number,
            case when x.closed_at is null then null else floor(extract(epoch from clock_timestamp() - x.closed_at) / 3600)::bigint::text end as hours,
            recipe.bright_stock_container_problem(c.id, i.order_batch_id) is not null as past
       from plant.output_container c
       left join plant.container_close x on x.container_id = c.id
       left join recipe.packaging_bulk_issue i on i.container_id = c.id
       left join recipe.batch_execution o on o.id = i.order_batch_id
      where c.batch_id = $1
      order by c.label_code`,
    [batchId],
  );
  const { rows: orders } = await db.query<{ id: string; batch_number: string; status: string | null; issued: BulkQuantity[]; n: number; hold: string | null }>(
    `select o as id, s.batch_number, recipe.order_status(o) as status,
            coalesce((select jsonb_agg(jsonb_build_object('quantity', t.q::text, 'unit', t.u) order by t.u)
                        from (select i.unit as u, sum(i.quantity) as q from recipe.packaging_bulk_issue i where i.order_batch_id = o group by i.unit) t), '[]'::jsonb) as issued,
            (select count(*)::int from recipe.packaging_bulk_issue i where i.order_batch_id = o) as n,
            recipe.bright_stock_hold_problem(o) as hold
       from unnest(recipe.packaging_children_of($1)) o join recipe.stub_batch s on s.id = o
      order by s.batch_number`,
    [batchId],
  );
  const { rows: facts } = await db.query<{
    problems: string[];
    produced: BulkQuantity[];
    issued: BulkQuantity[];
    remaining: BulkQuantity[];
    closure: { person_id: string; role_code: string | null; us: string; reason: string | null } | null;
    product: string | null;
    strength: string | null;
  }>(
    `select recipe.bulk_close_problems($1) as problems,
            coalesce(r.produced, recipe.bulk_totals($1, array['ISSUED', 'CHARGED', 'REJECTED', 'LEFT'])) as produced,
            coalesce(r.issued, recipe.bulk_totals($1, array['ISSUED'])) as issued,
            coalesce(r.remaining, recipe.bulk_totals($1, array['LEFT'])) as remaining,
            case when r.id is null then null
                 else jsonb_build_object('person_id', r.person_id, 'role_code', r.role_code, 'us', ${usOf('r.recorded_at')}, 'reason', r.remaining_held_reason) end as closure,
            recipe.batch_product($1) ->> 'code' as product, recipe.batch_product($1) ->> 'strength' as strength
       from (select 1) one left join recipe.bulk_reconciliation r on r.batch_id = $1`,
    [batchId],
  );
  const f = facts[0]!;
  const people = await peopleOf(db, [f.closure?.person_id]);
  const closed = (s: string | null): boolean => s === 'EXECUTION_COMPLETE' || s === 'ABORTED' || s === 'CANCELLED';
  return {
    batchId,
    batchNumber: b.batch_number,
    recordKind: b.kind,
    produced: f.produced,
    issued: f.issued,
    remaining: f.remaining,
    orders: orders.map((o): BulkOrderView => ({ orderBatchId: o.id, batchNumber: o.batch_number, status: o.status ?? 'PLANNED', closed: closed(o.status), issued: o.issued, containers: o.n, holdProblem: o.hold })),
    containers: containers.map((c): BulkContainerView => ({
      containerId: c.id,
      label: c.label,
      quantity: c.quantity,
      unit: c.unit,
      state: c.state ?? 'OPEN',
      closedAt: c.closed_us ? app.formatInstant(c.closed_us) : null,
      disposition: c.disposition,
      orderBatchId: c.order_id,
      orderBatchNumber: c.order_number,
      heldHours: c.hours,
      pastMaxHold: c.past,
    })),
    maxHold: f.product && f.strength ? await holdOf(app, db, f.product, f.strength) : null,
    closeProblems: f.problems,
    closure: f.closure
      ? { closedBy: personRef(people, f.closure.person_id, f.closure.role_code ?? 'HEAD_OF_PRODUCTION'), closedAt: app.formatInstant(f.closure.us), remainingHeldReason: f.closure.reason }
      : null,
    lockState: b.state,
  };
}
