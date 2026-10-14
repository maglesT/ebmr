/**
 * Receipt routes of the quality namespace (Phase 6 slice 6a, builder A; contract ns/receipt.ts; site services 0910 to
 * 0915; PR-17, DI-31): the approved-manufacturer register, a delivery received with its supplier batches, the receipt
 * record of a lot with its examination and corrections, and the database's issue gate. Every rule is the database's;
 * these handlers carry the person's own command and read the result back. QA's approval of a manufacturer is the
 * signable action MATERIAL_SOURCE_ACT (registered by the integrations feature, beside the ERP/WMS adapter).
 */
import type { ApprovedManufacturerView, LotReceiptView, routes, SignableAction } from '@ebmr/api-contract';
import type { ActorContext, commands } from '@ebmr/kernel';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import type { Handlers } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler } from '../../platform/ports.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { dbActHandler } from '../esig/db-acts.ts';

type Db = Pick<pg.Pool, 'query'>;
type MaterialSourceAct = Extract<SignableAction, { kind: 'MATERIAL_SOURCE_ACT' }>;

const notFound = (what: string) =>
  refusal(404, { code: 'EBMR-API-NOT-FOUND', kind: 'STALE', whatHappened: `The ${what} was not found.`, why: `No such ${what}.`, whatYouCanDo: ['Reload the list.'] });

export async function approvedManufacturers(app: AppContext, db: Db, where: { id?: string; materialCode?: string }): Promise<ApprovedManufacturerView[]> {
  const { rows } = await db.query<{
    id: string; material_code: string; manufacturer_code: string; manufacturer_name: string; manufacturing_site: string | null; basis: string; state: 'PROPOSED' | 'APPROVED' | 'WITHDRAWN';
    proposed_by: string; proposed_us: string; approved_by: string | null; approved_us: string | null; withdrawn_by: string | null; withdrawn_us: string | null; reason: string | null;
  }>(
    `select m.id, m.material_code, m.manufacturer_code, m.manufacturer_name, m.manufacturing_site, m.basis, site.approved_manufacturer_state(m.id) as state,
            m.proposed_by_person as proposed_by, ${usOf('m.proposed_at')} as proposed_us,
            a.approved_by_person as approved_by, case when a.approved_at is null then null else ${usOf('a.approved_at')} end as approved_us,
            w.withdrawn_by_person as withdrawn_by, case when w.withdrawn_at is null then null else ${usOf('w.withdrawn_at')} end as withdrawn_us, w.reason
       from site.approved_manufacturer m
       left join site.approved_manufacturer_approval a on a.approved_manufacturer_id = m.id
       left join site.approved_manufacturer_withdrawal w on w.approved_manufacturer_id = m.id
      where ($1::uuid is null or m.id = $1) and ($2::text is null or m.material_code = $2)
      order by m.material_code, m.manufacturer_code, m.proposed_at desc`,
    [where.id ?? null, where.materialCode ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.proposed_by, r.approved_by, r.withdrawn_by]));
  return rows.map((r) => ({
    approvedManufacturerId: r.id, materialCode: r.material_code, manufacturerCode: r.manufacturer_code, manufacturerName: r.manufacturer_name,
    manufacturingSite: r.manufacturing_site, basis: r.basis, state: r.state,
    proposedBy: personRef(people, r.proposed_by, 'QA'), proposedAt: app.formatInstant(r.proposed_us),
    approvedBy: r.approved_by ? personRef(people, r.approved_by, 'QA') : null, approvedAt: r.approved_us ? app.formatInstant(r.approved_us) : null,
    withdrawal: r.withdrawn_by && r.withdrawn_us && r.reason ? { reason: r.reason, by: personRef(people, r.withdrawn_by, 'QA'), at: app.formatInstant(r.withdrawn_us) } : null,
  }));
}

async function approvedManufacturer(app: AppContext, db: Db, id: string): Promise<ApprovedManufacturerView> {
  const v = (await approvedManufacturers(app, db, { id }))[0];
  if (!v) throw notFound('approved-manufacturer row');
  return v;
}

interface EffectiveReceipt {
  deliveryId: string; deliveryNoteName: string | null; supplierCode: string; supplierLot: string; manufacturerCode: string; containers: string;
  receivedValue: string; receivedUnit: string; source: 'MANUAL' | 'INTERFACE'; inboundMessageId: string | null; manufacturerApprovedAtReceipt: boolean;
  corrections: { field: string; originalValue: string | null; correctedValue: string; reason: string; correctedBy: string; correctedAtUs: string }[];
}

export async function lotReceipt(app: AppContext, db: Db, lotId: string): Promise<LotReceiptView> {
  const { rows } = await db.query<{
    lot_code: string; material_code: string; r: EffectiveReceipt | null; approved: boolean | null; location: { location: string; kind: string } | null;
    containers_examined: number | null; outcome: 'ACCEPTABLE' | 'DEFECTS_FOUND' | null; remarks: string | null; examined_by: string | null; examined_us: string | null;
  }>(
    `select l.lot_code, l.material_code, site.lot_receipt_effective(l.id) as r,
            site.manufacturer_approved(l.site_code, l.material_code, site.lot_receipt_effective(l.id) ->> 'manufacturerCode') as approved,
            site.lot_current_location(l.id) as location,
            e.containers_examined, e.outcome, e.remarks, e.examined_by_person as examined_by, case when e.examined_at is null then null else ${usOf('e.examined_at')} end as examined_us
       from site.material_lot l left join site.lot_receipt_examination e on e.lot_id = l.id where l.id = $1`,
    [lotId],
  );
  const row = rows[0];
  if (!row) throw notFound('lot');
  const r = row.r;
  if (!r) throw refusal(404, { code: 'NO_RECEIPT_RECORD', kind: 'INVALID_INPUT', whatHappened: `Lot ${row.lot_code} has no receipt record yet.`, whatYouCanDo: ['Record the receipt (delivery, supplier, supplier batch, manufacturer, containers).'] });
  // The issue gate as the database decides it; a stale mirror answers by its refusal (EBMR-INT-010), shown as the problem.
  let problem: string | null;
  try {
    problem = (await db.query<{ p: string | null }>('select site.issue_gate_problem($1) as p', [lotId])).rows[0]?.p ?? null;
  } catch (e) {
    if (!(e instanceof Error) || !/EBMR-INT-010/.test(e.message)) throw e;
    problem = e.message;
  }
  const people = await peopleOf(db, [row.examined_by, ...r.corrections.map((c) => c.correctedBy)]);
  return {
    lotId, lotCode: row.lot_code, materialCode: row.material_code, deliveryId: r.deliveryId, deliveryNoteName: r.deliveryNoteName, supplierCode: r.supplierCode,
    supplierLot: r.supplierLot, manufacturerCode: r.manufacturerCode, containers: r.containers, received: { value: r.receivedValue, unit: r.receivedUnit },
    source: r.source, inboundMessageId: r.inboundMessageId, manufacturerApprovedAtReceipt: r.manufacturerApprovedAtReceipt, manufacturerApprovedNow: row.approved === true,
    examination: row.outcome && row.examined_by && row.examined_us
      ? { containersExamined: String(row.containers_examined), outcome: row.outcome, remarks: row.remarks, by: personRef(people, row.examined_by, 'WAREHOUSE'), at: app.formatInstant(row.examined_us) }
      : null,
    corrections: r.corrections.map((c) => ({ field: c.field, originalValue: c.originalValue, correctedValue: c.correctedValue, reason: c.reason, by: personRef(people, c.correctedBy, 'WAREHOUSE'), at: app.formatInstant(c.correctedAtUs) })),
    location: row.location ? { location: row.location.location, kind: row.location.kind } : null,
    issueProblem: problem,
  };
}

type ReceiptRoutes = Pick<typeof routes.quality, 'approvedManufacturers' | 'proposeApprovedManufacturer' | 'withdrawManufacturerApproval' | 'receiveDelivery' | 'lotReceipt' | 'recordLotReceipt' | 'examineLotReceipt' | 'correctLotReceipt'>;

/** The body without its attribution member (the database command takes the person's data only). */
const dataOf = <B extends object>(body: B): Omit<B, 'attribution'> => {
  const { attribution: _a, ...rest } = body as B & { attribution?: unknown };
  void _a;
  return rest;
};

/** The route handlers spread into the quality namespace's binding (features/quality/index.ts). */
export function receiptHandlers(app: AppContext, pool: pg.Pool): Handlers<ReceiptRoutes> {
  const command = async (actor: ActorContext, key: string | null | undefined, hash: string, sql: string, params: unknown[]): Promise<unknown> =>
    (await withIdempotentActorCommand(pool, actor, key ?? '', hash, async (c) => ((await c.query<{ r: commands.JsonValue }>(sql, params)).rows[0]?.r ?? null))).result;
  return {
    approvedManufacturers: async ({ query, requireSession }) => {
      requireSession();
      return { manufacturers: await approvedManufacturers(app, pool, query.materialCode ? { materialCode: query.materialCode } : {}) };
    },
    proposeApprovedManufacturer: async ({ body, actor, idempotencyKey, requestHash }) => {
      const id = await command(actor(), idempotencyKey, requestHash, 'select site.propose_approved_manufacturer($1::jsonb) as r', [JSON.stringify(dataOf(body))]);
      return approvedManufacturer(app, pool, String(id));
    },
    withdrawManufacturerApproval: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await command(actor(), idempotencyKey, requestHash, 'select site.withdraw_manufacturer_approval($1, $2) as r', [params.approvedManufacturerId, body.reason]);
      return approvedManufacturer(app, pool, params.approvedManufacturerId);
    },
    receiveDelivery: async ({ body, actor, idempotencyKey, requestHash }) => {
      const r = (await command(actor(), idempotencyKey, requestHash, 'select site.receive_delivery($1::jsonb) as r', [JSON.stringify(dataOf(body))])) as {
        deliveryId: string; lots: { lotId: string; lotCode: string; supplierLot: string; manufacturerCode: string; manufacturerApproved: boolean }[];
      };
      return { deliveryId: r.deliveryId, lots: r.lots.map((l) => ({ lotId: l.lotId, lotCode: l.lotCode, supplierLot: l.supplierLot, manufacturerCode: l.manufacturerCode, manufacturerApproved: l.manufacturerApproved })) };
    },
    lotReceipt: async ({ params, requireSession }) => {
      requireSession();
      return lotReceipt(app, pool, params.lotId);
    },
    recordLotReceipt: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await command(actor(), idempotencyKey, requestHash, 'select site.record_lot_receipt($1, $2::jsonb) as r', [params.lotId, JSON.stringify(dataOf(body))]);
      return lotReceipt(app, pool, params.lotId);
    },
    examineLotReceipt: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await command(actor(), idempotencyKey, requestHash, 'select site.record_receipt_examination($1, $2::jsonb) as r', [params.lotId, JSON.stringify(dataOf(body))]);
      return lotReceipt(app, pool, params.lotId);
    },
    correctLotReceipt: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await command(actor(), idempotencyKey, requestHash, 'select site.correct_lot_receipt_value($1, $2, $3, $4) as r', [params.lotId, body.field, body.value, body.reason]);
      return lotReceipt(app, pool, params.lotId);
    },
  };
}

/** MATERIAL_SOURCE_ACT: QA's MANUFACTURER_APPROVED signature and site.approve_manufacturer in the same command. */
export function materialSourceActHandler(app: AppContext): SignableActionHandler<MaterialSourceAct> {
  return dbActHandler<MaterialSourceAct>(app, {
    kind: 'MATERIAL_SOURCE_ACT',
    aggregateTypes: ['approved_manufacturer'],
    target: (a) => ({ aggregateType: 'approved_manufacturer', aggregateId: a.approvedManufacturerId, meaning: 'MANUFACTURER_APPROVED' }),
    async apply(client, _ctx, a, signatureId) {
      await client.query('select site.approve_manufacturer($1, $2)', [a.approvedManufacturerId, signatureId]);
      return { act: a.act, approvedManufacturerId: a.approvedManufacturerId };
    },
  });
}
