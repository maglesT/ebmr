/**
 * Receipt routes of the quality namespace (Phase 6 slice 6a, builder A; contract ns/receipt.ts; site services 0910 to
 * 0915; PR-17, DI-31): the approved-manufacturer register, a delivery received with its supplier batches, the receipt
 * record of a lot with its examination and corrections, and the database's issue gate. Every rule is the database's;
 * these handlers carry the person's own command and read the result back. QA's approval of a manufacturer is the
 * signable action MATERIAL_SOURCE_ACT (registered by the integrations feature, beside the ERP/WMS adapter).
 */
import type { ApprovedManufacturerView, LotHandlingView, LotReceiptView, routes, SignableAction, VendorRouteView } from '@ebmr/api-contract';
import type { ActorContext, commands } from '@ebmr/kernel';
import type pg from 'pg';
import type { AppContext } from '../../platform/context.ts';
import { withIdempotentActorCommand } from '../../platform/db/commands.ts';
import type { Handlers } from '../../platform/http/bind.ts';
import { refusal } from '../../platform/http/refusal.ts';
import type { SignableActionHandler } from '../../platform/ports.ts';
import { peopleOf, personRef, usOf } from '../common/people.ts';
import { dbActHandler, refusedOutcome } from '../esig/db-acts.ts';
import { reprocessingProposalHandlers } from './reprocessing.ts';

type Db = Pick<pg.Pool, 'query'>;
type MaterialSourceAct = Extract<SignableAction, { kind: 'MATERIAL_SOURCE_ACT' }>;
type LotDestructionWitness = Extract<SignableAction, { kind: 'LOT_DESTRUCTION_WITNESS' }>;

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

type ReceiptRoutes = Pick<
  typeof routes.quality,
  | 'approvedManufacturers' | 'proposeApprovedManufacturer' | 'withdrawManufacturerApproval' | 'receiveDelivery' | 'lotReceipt' | 'recordLotReceipt' | 'examineLotReceipt' | 'correctLotReceipt'
  // Phase 7 slice 7g (WP4): lot handling and the reprocessing proposals (ns/receipt.ts lotHandlingRoutes).
  | 'lotHandling' | 'recordLotDestruction' | 'destroyLot' | 'reserveLot' | 'cancelReservation' | 'resolveLotLocationException' | 'linkLotTestOos' | 'vendorRoutes' | 'disableVendorRoute'
  | 'proposeReprocessingAuthorisation' | 'proposeReprocessingRequest'
>;

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
    // Phase 7 slice 7g (WP4, decision 0025): lot handling. Every rule and right is the database's (site services 0712,
    // 0740, 0911); the handlers carry the person's own command and read the lot back.
    lotHandling: async ({ params, requireSession }) => {
      requireSession();
      return lotHandling(app, pool, params.lotId);
    },
    recordLotDestruction: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await command(actor(), idempotencyKey, requestHash, 'select site.record_lot_destruction($1, $2, $3) as r', [params.lotId, body.method, body.reason]);
      return lotHandling(app, pool, params.lotId);
    },
    destroyLot: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await command(actor(), idempotencyKey, requestHash, 'select site.destroy_lot($1, $2::bigint, $3) as r', [params.lotId, body.expectedVersion, body.witnessSignatureId]);
      return lotHandling(app, pool, params.lotId);
    },
    // Phase 7 slice 7h (WP-A, A1): the batch is named by its number and read from the batch record; the lot's own unit
    // and the edition (the batch's register allocation since API plan A1a, no longer a literal) are the database's; the expiry defaults to 30 days, or the lot's retest or expiry when sooner. The
    // database decides the rest (a released lot, its dates, the quantity available; INV-13, PR-18).
    reserveLot: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      const batch = (await pool.query<{ id: string; n: string }>('select id, batch_number as n from recipe.batch_execution where batch_number = $1', [body.batchNumber])).rows[0];
      if (!batch) {
        throw refusal(422, { code: 'EBMR-API-NO-BATCH', kind: 'INVALID_INPUT', whatHappened: 'No batch has this number. Nothing was reserved.', why: `No GMP batch is numbered ${body.batchNumber}.`, whatYouCanDo: ['Check the batch number on the batch record and try again.'] });
      }
      await command(
        actor(),
        idempotencyKey,
        requestHash,
        `select site.reserve_lot(l.id, $2, $3, (select a.edition from recipe.batch_allocation_link k join site.batch_number_allocation a on a.id = k.allocation_id where k.batch_id = $2), $4::numeric, l.unit,
                case when $5::date is null then least(clock_timestamp() + interval '30 days', l.expires_at, coalesce(site.lot_retest_at(l.id), l.expires_at))
                     else (($5::date + 1)::timestamp at time zone $6) end) as r
           from site.material_lot l where l.id = $1`,
        [params.lotId, batch.id, batch.n, body.quantity, body.expiresOn ?? null, app.siteZone.current()],
      );
      return lotHandling(app, pool, params.lotId);
    },
    cancelReservation: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await command(actor(), idempotencyKey, requestHash, 'select site.cancel_reservation($1, $2) as r', [params.reservationId, body.reason]);
      return lotHandling(app, pool, await lotOf(pool, 'select lot_id as l from site.lot_reservation where id = $1', params.reservationId));
    },
    resolveLotLocationException: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await command(actor(), idempotencyKey, requestHash, 'select site.resolve_lot_location_exception($1, $2, $3) as r', [params.exceptionId, body.deviationId, body.note]);
      return lotHandling(app, pool, await lotOf(pool, 'select lot_id as l from site.lot_location_exception where id = $1', params.exceptionId));
    },
    linkLotTestOos: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await command(actor(), idempotencyKey, requestHash, 'select site.link_lot_test_oos($1, $2) as r', [params.resultId, body.deviationId]);
      return { resultId: params.resultId, deviationId: body.deviationId };
    },
    vendorRoutes: async ({ requireSession }) => {
      requireSession();
      return { routes: await vendorRoutes(app, pool) };
    },
    disableVendorRoute: async ({ params, body, actor, idempotencyKey, requestHash }) => {
      await command(actor(), idempotencyKey, requestHash, 'select site.disable_vendor_route($1, $2) as r', [params.routeId, body.reason]);
      const v = (await vendorRoutes(app, pool, params.routeId))[0];
      if (!v) throw notFound('vendor-history route');
      return v;
    },
    ...reprocessingProposalHandlers(pool),
  };
}

/** The lot a reservation or exception belongs to (404 when there is none). */
async function lotOf(db: Db, sql: string, id: string): Promise<string> {
  const { rows } = await db.query<{ l: string }>(sql, [id]);
  const l = rows[0]?.l;
  if (!l) throw notFound('lot');
  return l;
}

/** A lot's destruction and its witness's valid signature, its reservations and its stock-location exceptions. */
export async function lotHandling(app: AppContext, db: Db, lotId: string): Promise<LotHandlingView> {
  const lot = await db.query<{ id: string }>('select id from site.material_lot where id = $1', [lotId]);
  if (!lot.rows[0]) throw notFound('lot');
  const [destruction, witness, reservations, exceptions] = await Promise.all([
    db.query<{ id: string; method: string; reason: string; quantity: string; unit: string; performed_by_person: string; us: string }>(
      `select d.id, d.method, d.reason, d.quantity::text as quantity, d.unit, d.performed_by_person, ${usOf('d.recorded_at')} as us from site.lot_destruction d where d.lot_id = $1`,
      [lotId],
    ),
    // The lot's signatures (RECORD class, tablets 0410); a witnessing signed before the record existed is superseded by it.
    db.query<{ signature_id: string; signer_person: string }>(
      "select signature_id, signer_person from tab.signatures_of('material_lot', $1::text) where meaning_code = 'MATERIAL_DESTRUCTION_WITNESSED' and valid",
      [lotId],
    ),
    db.query<{
      id: string; batch_number: string; quantity: string; unit: string; expires_us: string; reserved_by_person: string; reserved_us: string;
      kind: string | null; reason_text: string | null; revoked_by_person: string | null; revoked_us: string | null;
    }>(
      `select r.id, r.batch_number, r.quantity::text as quantity, r.unit, ${usOf('r.expires_at')} as expires_us, r.reserved_by_person, ${usOf('r.reserved_at')} as reserved_us,
              x.kind, x.reason_text, x.revoked_by_person, case when x.id is null then null else ${usOf('x.revoked_at')} end as revoked_us
         from site.lot_reservation r left join site.lot_reservation_revocation x on x.reservation_id = r.id where r.lot_id = $1 order by r.reserved_at, r.id`,
      [lotId],
    ),
    db.query<{ id: string; problem: string; raised_us: string; deviation_id: string | null; note: string | null; resolved_by_person: string | null; resolved_us: string | null }>(
      `select e.id, e.problem, ${usOf('e.raised_at')} as raised_us, z.deviation_id, z.note, z.resolved_by_person,
              case when z.exception_id is null then null else ${usOf('z.resolved_at')} end as resolved_us
         from site.lot_location_exception e left join site.lot_location_exception_resolution z on z.exception_id = e.id where e.lot_id = $1 order by e.raised_at, e.id`,
      [lotId],
    ),
  ]);
  const d = destruction.rows[0];
  const w = witness.rows.at(-1);
  const people = await peopleOf(db, [
    d?.performed_by_person,
    w?.signer_person,
    ...reservations.rows.flatMap((r) => [r.reserved_by_person, r.revoked_by_person]),
    ...exceptions.rows.map((e) => e.resolved_by_person),
  ]);
  return {
    lotId,
    destruction: d
      ? { destructionId: d.id, method: d.method, reason: d.reason, quantity: d.quantity, unit: d.unit, performedBy: personRef(people, d.performed_by_person, 'WAREHOUSE'), recordedAt: app.formatInstant(d.us) }
      : null,
    witness: w ? { signatureId: w.signature_id, signedBy: personRef(people, w.signer_person, 'WITNESS') } : null,
    reservations: reservations.rows.map((r) => ({
      reservationId: r.id,
      batchNumber: r.batch_number,
      quantity: r.quantity,
      unit: r.unit,
      expiresAt: app.formatInstant(r.expires_us),
      reservedBy: personRef(people, r.reserved_by_person, 'WAREHOUSE'),
      reservedAt: app.formatInstant(r.reserved_us),
      revoked:
        r.kind && r.revoked_by_person && r.revoked_us ? { kind: r.kind, reason: r.reason_text, by: personRef(people, r.revoked_by_person, 'WAREHOUSE'), at: app.formatInstant(r.revoked_us) } : null,
    })),
    locationExceptions: exceptions.rows.map((e) => ({
      exceptionId: e.id,
      problem: e.problem,
      raisedAt: app.formatInstant(e.raised_us),
      resolved:
        e.deviation_id && e.note && e.resolved_by_person && e.resolved_us
          ? { deviationId: e.deviation_id, note: e.note, by: personRef(people, e.resolved_by_person, 'QA'), at: app.formatInstant(e.resolved_us) }
          : null,
    })),
  };
}

/** The vendor-history routes (all, or the one route `id`), newest first. */
export async function vendorRoutes(app: AppContext, db: Db, id?: string): Promise<VendorRouteView[]> {
  const { rows } = await db.query<{
    id: string; site_code: string; material_code: string; justification: string; statistical_reference: string; proposed_by_person: string; proposed_us: string;
    enabled_by_person: string | null; enabled_us: string | null; reason: string | null; disabled_by_person: string | null; disabled_us: string | null;
  }>(
    `select v.id, v.site_code, v.material_code, v.justification, v.statistical_reference, v.proposed_by_person, ${usOf('v.proposed_at')} as proposed_us,
            e.enabled_by_person, case when e.route_id is null then null else ${usOf('e.enabled_at')} end as enabled_us,
            x.reason, x.disabled_by_person, case when x.route_id is null then null else ${usOf('x.disabled_at')} end as disabled_us
       from site.vendor_route v left join site.vendor_route_enablement e on e.route_id = v.id left join site.vendor_route_disablement x on x.route_id = v.id
      where ($1::uuid is null or v.id = $1) order by v.proposed_at desc, v.id`,
    [id ?? null],
  );
  const people = await peopleOf(db, rows.flatMap((r) => [r.proposed_by_person, r.enabled_by_person, r.disabled_by_person]));
  return rows.map((r) => ({
    routeId: r.id,
    siteCode: r.site_code,
    materialCode: r.material_code,
    justification: r.justification,
    statisticalReference: r.statistical_reference,
    proposedBy: personRef(people, r.proposed_by_person, 'QA'),
    proposedAt: app.formatInstant(r.proposed_us),
    enabled: r.enabled_by_person && r.enabled_us ? { by: personRef(people, r.enabled_by_person, 'QA'), at: app.formatInstant(r.enabled_us) } : null,
    disabled: r.reason && r.disabled_by_person && r.disabled_us ? { reason: r.reason, by: personRef(people, r.disabled_by_person, 'QA'), at: app.formatInstant(r.disabled_us) } : null,
  }));
}

/**
 * LOT_DESTRUCTION_WITNESS (slice 7g, WP4; IN-24 (a)): the witness's MATERIAL_DESTRUCTION_WITNESSED signature on a lot
 * whose destruction is recorded. Nothing else happens in the signing command: the performer's destroy names the
 * signature (site.destroy_lot), and the database refuses a witness who is the performer or consumed from the lot, and a
 * witnessing that the record has since superseded.
 */
export function lotDestructionWitnessHandler(app: AppContext): SignableActionHandler<LotDestructionWitness> {
  return dbActHandler<LotDestructionWitness>(app, {
    kind: 'LOT_DESTRUCTION_WITNESS',
    aggregateTypes: ['material_lot'],
    target: (a) => ({ aggregateType: 'material_lot', aggregateId: a.lotId, meaning: 'MATERIAL_DESTRUCTION_WITNESSED' }),
    async precheck(client, ctx, a) {
      const { rows } = await client.query<{ performer: string }>('select performed_by_person::text as performer from site.lot_destruction where lot_id = $1', [a.lotId]);
      const r = rows[0];
      if (!r) {
        return refusedOutcome(
          409,
          'EBMR-API-NO-DESTRUCTION',
          'The destruction of this lot is not recorded yet. Nothing was signed.',
          'A witness signs the recorded destruction of the lot; a witnessing signed before the record would be superseded by it.',
          ['IN-24'],
          ['Ask the performer to record the destruction first.'],
        );
      }
      if (r.performer === ctx.actor.personId) {
        return refusedOutcome(
          403,
          'EBMR-API-WITNESS-PERFORMER',
          'You recorded this destruction, so you cannot witness it. Nothing was signed.',
          'The witness of a destruction is a person other than its performer.',
          ['IN-24'],
          ['Ask another person to witness the destruction.'],
        );
      }
      return null;
    },
    apply(_client, _ctx, a, signatureId) {
      return Promise.resolve({ lotId: a.lotId, witnessSignatureId: signatureId });
    },
  });
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
