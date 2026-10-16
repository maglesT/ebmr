/**
 * Chemical recovery and distribution records in the database (Phase 6 slice 6d; site services 0960, 0961; IN-29,
 * PR-57, PR-48; defaults D-P6d-0-4 to D-P6d-0-7). Every act runs as the application role inside a validated command;
 * each rule is also tried around (the application role writing the tables, the superuser writing them with the
 * triggers on).
 *
 * Fixtures, not proofs: the finished lot is posted as the edition's definer posts it; its manufacturer release is
 * arranged as the release act leaves it (its decision row, the lot RELEASED) with the triggers off, as in
 * shipping/erp-shipping.test.ts. The returned goods, QC's signed assessment, the recovery and the ERP/WMS adapter's
 * shipments run for real.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import type { SeededActor } from '../../../kernel/test/identity/seed.ts';
import { createTestDatabase, signerActor, signFor, type TestDatabase } from '../helpers.ts';
import { ErpWorld } from '../erp-wms/support.ts';
import { refusal, unique } from '../lots/support.ts';

let db: TestDatabase;
let w: ErpWorld;
let operator: SeededActor;

beforeAll(async () => {
  db = await createTestDatabase();
  w = await ErpWorld.create(db);
  operator = await signerActor(db, 'OPERATOR');
}, 300_000);
afterAll(async () => {
  await db?.drop();
});

async function fixture(sql: string, params: unknown[]): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(sql, params);
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}

const as = <T>(actor: SeededActor, sql: string, params: unknown[] = []): Promise<T> =>
  withCommand(db.app, { ...actor, correlationId: randomUUID(), reasonCode: 'TEST', reasonText: 'recovery and distribution test' }, async (c) =>
    (await c.query<{ r: T }>(sql, params)).rows[0]?.r as T);

/** A finished lot in quarantine (as the edition's definer posts it), optionally released (fixture). */
async function finishedLot(markets = ['IN'], released = true): Promise<{ id: string; code: string }> {
  const code = unique('FB');
  const id = await withCommand(db.admin, { ...w.cast.warehouse, correlationId: randomUUID() }, async (c) =>
    (await c.query<{ id: string }>('select site.create_finished_lot($1::jsonb) as id', [
      JSON.stringify({ batchId: randomUUID(), batchNumber: code, edition: 'TABLETS', siteCode: 'SITE-1', productCode: 'DIST-500', productName: 'Distribution tablets 500 mg',
                       strength: '500 mg', markets, quantity: '1000', unit: 'units', expiresAt: '2029-06-30T23:59:59Z' }),
    ])).rows[0]!.id,
  );
  if (released) {
    await fixture(
      `insert into recipe.manufacturer_release_decision (lot_id, decision, signature_id, epoch, checklist, checklist_hash, content_hash, person_id, account_id, role_code, correlation_id)
       values ($1, 'RELEASED', gen_random_uuid(), repeat('0', 64), '{}', repeat('0', 64), 'fixture', $2, $3, 'AUTHORISED_PERSON', gen_random_uuid())`,
      [id, w.cast.qa.personId, w.cast.qa.accountId],
    );
    await fixture("update platform.aggregate_state set state = 'RELEASED' where aggregate_type = 'material_lot' and aggregate_id = $1", [id]);
  }
  return { id, code };
}

/** Returned goods of `lotId`, with QC's assessment of `disposition`, signed unless `sign` is false. */
async function returned(lotId: string, disposition = 'CHEMICAL_RECOVERY', sign = true, quantity = '100'): Promise<{ lotId: string; lotCode: string }> {
  const g = await as<{ lotId: string; lotCode: string }>(w.cast.warehouse, 'select site.receive_returned_goods($1::jsonb) as r', [
    JSON.stringify({ originalLotId: lotId, quantity, reason: 'Returned by the distributor', returnedFrom: 'Distributor Pune' }),
  ]);
  const a = await as<string>(w.cast.qcHead, 'select site.record_returned_goods_assessment($1, $2::jsonb)::text as r', [
    g.lotId, JSON.stringify({ nature: 'Tablets', storage: 'Below 25 C', conditionHistory: 'Intact', timeSinceIssue: '1 month', doubt: false, implicatesOtherBatches: false, disposition }),
  ]);
  if (sign) {
    const sig = await signFor(db, w.cast.qcHead, { type: 'returned_goods', id: g.lotId }, 'RETURNED_GOODS_ASSESSED', a);
    await as(w.cast.qcHead, 'select site.sign_returned_goods_assessment($1, $2)', [g.lotId, sig]);
  }
  return g;
}

const RECOVERY = { materialCode: 'API-REC', materialName: 'Recovered API', quantity: '40.5', unit: 'kg', expiresAt: '2029-01-01T00:00:00Z', processReference: 'SOP-REC-01 run 3' };
const recover = (lot: string, p: Record<string, unknown> = RECOVERY, by: SeededActor = w.cast.warehouse) =>
  as<{ lotId: string; lotCode: string }>(by, 'select site.record_chemical_recovery($1, $2::jsonb) as r', [lot, JSON.stringify(p)]);

describe('chemical recovery (site services 0960; IN-29, PR-48; D-P6d-0-4, D-P6d-0-5)', () => {
  it('[IN-29][PR-48] returned goods become recovered material only after QC signed a chemical-recovery assessment, once, with the genealogy link in the same transaction', async () => {
    const f = await finishedLot();
    expect(await refusal(recover(f.id))).toMatch(/EBMR-SITE-960 lot .* is no returned goods/);
    const unsigned = await returned(f.id, 'CHEMICAL_RECOVERY', false);
    expect(await refusal(recover(unsigned.lotId))).toMatch(/EBMR-SITE-961 .*signed disposition is none/);
    const destroy = await returned(f.id, 'DESTROY');
    expect(await refusal(recover(destroy.lotId))).toMatch(/EBMR-SITE-961 .*signed disposition is DESTROY/);
    const g = await returned(f.id);
    expect(await refusal(recover(g.lotId, RECOVERY, operator))).toMatch(/MATERIAL\.HANDLE|EBMR-IAM|permission/i);
    expect(await refusal(recover(g.lotId, { ...RECOVERY, processReference: ' ' }))).toMatch(/EBMR-SITE-964/);
    expect(await refusal(recover(g.lotId, { ...RECOVERY, quantity: 40.5 }))).toMatch(/EBMR-SITE-964/);
    expect(await refusal(recover(g.lotId, { ...RECOVERY, expiresAt: '2020-01-01T00:00:00Z' }))).toMatch(/EBMR-SITE-964 the recovered material expires in the future/);
    expect(await refusal(recover(g.lotId, { ...RECOVERY, returnedQuantity: '100.5' }))).toMatch(/EBMR-SITE-965/);
    const r = await recover(g.lotId);
    expect(r.lotCode).toBe(`${g.lotCode}-CR`);
    const { rows: lot } = await db.app.query('select material_kind, material_code, received_quantity::text as q, unit from site.material_lot where id = $1', [r.lotId]);
    expect(lot).toEqual([{ material_kind: 'INTERMEDIATE', material_code: 'API-REC', q: '40.5', unit: 'kg' }]);
    expect((await db.admin.query<{ s: string }>('select site.lot_state($1) as s', [r.lotId])).rows[0]!.s).toBe('QUARANTINE');
    const { rows: link } = await db.app.query<{ returned_quantity: string; process_reference: string; assessment_disposition: string }>(
      `select x.returned_quantity::text, x.process_reference, a.disposition as assessment_disposition
         from site.chemical_recovery x join site.returned_goods_assessment a on a.id = x.assessment_id where x.returned_lot_id = $1 and x.recovered_lot_id = $2`,
      [g.lotId, r.lotId],
    );
    expect(link).toEqual([{ returned_quantity: '100', process_reference: 'SOP-REC-01 run 3', assessment_disposition: 'CHEMICAL_RECOVERY' }]);
    expect(await refusal(recover(g.lotId))).toMatch(/EBMR-SITE-963/);
    // The link is the database's: the application role cannot write it; nobody changes it.
    expect(await refusal(db.app.query("insert into site.chemical_recovery (returned_lot_id, recovered_lot_id, assessment_id, returned_quantity, returned_unit, process_reference, recorded_by_person, recorded_by_account, correlation_id) values ($1, $2, gen_random_uuid(), 1, 'units', 'x', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [destroy.lotId, f.id]))).toMatch(/permission denied/);
    expect(await refusal(db.admin.query("update site.chemical_recovery set process_reference = 'changed' where returned_lot_id = $1", [g.lotId]))).toMatch(/EBMR|insert-only|not allowed|reject/i);
  });
});

describe('distribution records (site services 0961; PR-57; D-P6d-0-6, D-P6d-0-7)', () => {
  const shipment = (lotNumber: string, over: Record<string, unknown> = {}) => ({
    shipmentId: unique('SH'), lotNumber, consigneeCode: 'CUST-7', consigneeName: 'Mumbai Pharma Distributors', consigneeAddress: '4 Dock Road, Mumbai 400001',
    quantity: { value: '120', unit: 'units' }, shippedAt: '1790000000000000', ...over,
  });
  const record = (id: string) =>
    db.app.query('select shipment_no, lot_code, product_name, strength, consignee_code, consignee_name, consignee_address, quantity::text, unit, market, quarantine, inbound_message_id is not null as from_adapter, to_char(shipped_at at time zone \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS"Z"\') as shipped_at from site.erp_shipment where id = $1', [id]);

  it('[PR-57] a shipment from the ERP/WMS adapter becomes a distribution record with product name and strength, consignee name and address, date, quantity and lot, in the receiving command', async () => {
    const f = await finishedLot();
    const p = shipment(f.code);
    const r = await w.inbound(w.envelope('erp.shipment', p));
    expect(r.outcome).toBe('ACCEPTED');
    const applied = r.applied as { shipmentId: string; market: string };
    expect(applied.market).toBe('IN');
    expect((await record(applied.shipmentId)).rows).toEqual([{
      shipment_no: p.shipmentId, lot_code: f.code, product_name: 'Distribution tablets 500 mg', strength: '500 mg', consignee_code: 'CUST-7',
      consignee_name: 'Mumbai Pharma Distributors', consignee_address: '4 Dock Road, Mumbai 400001', quantity: '120', unit: 'units', market: 'IN', quarantine: false,
      from_adapter: true, shipped_at: '2026-09-21T14:13:20Z',
    }]);
    // A resend is a duplicate: nothing applied twice.
    const env = w.envelope('erp.shipment', shipment(f.code));
    await w.inbound(env);
    expect(await w.inbound(env)).toMatchObject({ outcome: 'DUPLICATE', applied: null });
  });

  it('[PR-57] an incomplete, unknown, future or repeated shipment is refused and recorded as a refusal; a lot not released never ships (INV-42); nothing is lost', async () => {
    const f = await finishedLot();
    const count = async () => Number((await db.admin.query<{ n: string }>('select count(*) as n from site.erp_shipment where lot_id = $1', [f.id])).rows[0]!.n);
    const { consigneeAddress: _drop, ...noAddress } = shipment(f.code);
    expect(await w.deliver(w.envelope('erp.shipment', noAddress), 'MALFORMED')).toMatchObject({ ok: false, code: 'EBMR-ERP-020' });
    expect(await w.deliver(w.envelope('erp.shipment', shipment('NO-SUCH-LOT')), 'WRONG_IDENTITY')).toMatchObject({ ok: false, code: 'EBMR-ERP-021' });
    expect(await w.deliver(w.envelope('erp.shipment', shipment(f.code, { shippedAt: '4000000000000000' })), 'OUT_OF_RANGE')).toMatchObject({ ok: false, code: 'EBMR-ERP-022' });
    const multi = await finishedLot(['IN', 'US']);
    expect(await w.deliver(w.envelope('erp.shipment', shipment(multi.code)), 'MALFORMED')).toMatchObject({ ok: false, code: 'EBMR-ERP-020' });
    const first = shipment(f.code);
    await w.inbound(w.envelope('erp.shipment', first));
    expect(await w.deliver(w.envelope('erp.shipment', { ...first, consigneeCode: 'CUST-8' }), 'DUPLICATE')).toMatchObject({ ok: false, code: 'EBMR-SHP-003' });
    const quarantined = await finishedLot(['IN'], false);
    expect(await w.deliver(w.envelope('erp.shipment', shipment(quarantined.code)), 'OUT_OF_RANGE')).toMatchObject({ ok: false, code: 'EBMR-SHP-002' });
    expect(await count()).toBe(1);
    // Each refusal is on record with its alarm.
    expect(await w.count("select count(*) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED' and alarm_id is not null", [w.adapterCode])).toBeGreaterThanOrEqual(6);
  });

  it('[PR-57] the product fields are the lot\'s, whoever writes the row; a row from the adapter must carry the address; the stub route\'s record without one shows as incomplete', async () => {
    const f = await finishedLot();
    // The superuser with the triggers on: the product fields are taken from the lot, not from the writer.
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await expect(c.query(
        `insert into site.erp_shipment (shipment_no, lot_id, market, consignee_code, consignee_name, quantity, unit, quarantine, manufacturer_state, disposition_state, erp_reference,
                                        recorded_by_person, recorded_by_account, correlation_id, inbound_message_id)
         values ($1, $2, 'IN', 'CUST-1', 'C', 1, 'units', false, 'PENDING', 'PENDING', 'R', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                 (select id from platform.inbound_message limit 1))`,
        [unique('SH'), f.id],
      )).rejects.toThrow(/erp_shipment_distribution_complete/);
    } finally {
      await c.query('rollback');
      c.release();
    }
    const id = await as<string>(w.cast.erp, 'select site.erp_record_shipment($1::jsonb)::text as r', [
      JSON.stringify({ shipmentNo: unique('SHS'), lotId: f.id, market: 'IN', consigneeCode: 'CUST-9', consigneeName: 'Stub consignee', quantity: '5', unit: 'units', quarantine: false, erpReference: 'DN-1' }),
    ]);
    const { rows } = await db.app.query<{ product_name: string; strength: string; lot_code: string; consignee_address: string | null; dated: boolean }>(
      'select product_name, strength, lot_code, consignee_address, shipped_at is not null and shipped_at <= recorded_at + interval \'1 second\' as dated from site.erp_shipment where id = $1', [id]);
    expect(rows).toEqual([{ product_name: 'Distribution tablets 500 mg', strength: '500 mg', lot_code: f.code, consignee_address: null, dated: true }]);
    expect(await refusal(db.app.query("update site.erp_shipment set consignee_address = 'x' where id = $1", [id]))).toMatch(/permission denied/);
  });
});
