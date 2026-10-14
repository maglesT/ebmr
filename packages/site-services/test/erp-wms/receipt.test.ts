/**
 * Receipt (PR-17 clauses 2 to 4; site services 0910, 0913): one lot per supplier batch, the approved-manufacturer
 * register, the complete receipt record that issue needs, and corrections of WMS-captured receipt values (DI-31, DI-26).
 * Every rule is proven as the application role through real identities, with bypass attempts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeLotStatus } from '../../src/index.ts';
import { createTestDatabase, signFor, type TestDatabase } from '../helpers.ts';
import { refusal, unique } from '../lots/support.ts';
import { ErpWorld, goodsReceipt } from './support.ts';

let db: TestDatabase;
let w: ErpWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  w = await ErpWorld.create(db);
}, 300_000);
afterAll(async () => {
  await db.drop();
});

/** A purchased material in the master with its approved specification. */
async function material(kind: 'API' | 'EXCIPIENT' = 'API'): Promise<string> {
  const code = unique(`M${kind.slice(0, 3)}`);
  await w.material(code, `Material ${code}`, kind, 'kg');
  await w.specification(code);
  return code;
}

/** Passing result, identity result and the head of QC's release on the identity-tested route. */
async function release(lotId: string): Promise<void> {
  await w.passingResult(lotId);
  await w.identity(lotId);
  const sig = await w.sign(w.cast.qcHead, lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
  await w.run(w.cast.qcHead, async (c) => changeLotStatus(c, lotId, 'RELEASE', await w.version(lotId), sig, 'IDENTITY_TESTED'));
}

const examine = (lotId: string, containers = '2', outcome = 'ACCEPTABLE', remarks?: string) =>
  w.run(w.cast.warehouse, (c) => c.query('select site.record_receipt_examination($1, $2::jsonb)', [lotId, JSON.stringify({ containersExamined: containers, outcome, ...(remarks ? { remarks } : {}) })]));

interface ReceivedLots {
  lots: { lotId: string; lotCode: string; supplierLot: string; manufacturerCode: string; manufacturerApproved: boolean }[];
}

describe('one lot per supplier batch (PR-17 clause 2)', () => {
  it('[PR-17][DI-31] one delivery with three supplier batches creates three lots', async () => {
    const code = await material();
    await w.approveManufacturer(code, 'MFR-A');
    const r = await w.inbound(w.envelope('wms.goods_receipt', goodsReceipt(unique('DEL'), code, [['SB-1', 'MFR-A', '4', '25.000'], ['SB-2', 'MFR-A', '2', '12.500'], ['SB-3', 'MFR-A', '1', '3.125']])));
    expect(r.outcome).toBe('ACCEPTED');
    const lots = (r.applied as unknown as ReceivedLots).lots;
    expect(lots).toHaveLength(3);
    expect(new Set(lots.map((l) => l.lotCode)).size).toBe(3);
    const { rows } = await db.app.query<{ supplier_lot: string; containers: number; received_value: string; received_unit: string; state: string; source: string; msg: string }>(
      `select r.supplier_lot, r.containers, r.received_value, r.received_unit, s.state, r.source, r.inbound_message_id::text as msg
         from site.lot_receipt r join platform.aggregate_state s on s.aggregate_type = 'material_lot' and s.aggregate_id = r.lot_id
        where r.lot_id = any($1) order by r.supplier_lot`,
      [lots.map((l) => l.lotId)],
    );
    expect(rows).toEqual([
      { supplier_lot: 'SB-1', containers: 4, received_value: '25.000', received_unit: 'kg', state: 'QUARANTINE', source: 'INTERFACE', msg: r.messageId },
      { supplier_lot: 'SB-2', containers: 2, received_value: '12.500', received_unit: 'kg', state: 'QUARANTINE', source: 'INTERFACE', msg: r.messageId },
      { supplier_lot: 'SB-3', containers: 1, received_value: '3.125', received_unit: 'kg', state: 'QUARANTINE', source: 'INTERFACE', msg: r.messageId },
    ]);
    // The same supplier batch in another delivery is another lot with its own code (211.80(d)).
    const again = await w.inbound(w.envelope('wms.goods_receipt', goodsReceipt(unique('DEL'), code, [['SB-1', 'MFR-A', '1', '5.000']])));
    const next = (again.applied as unknown as ReceivedLots).lots[0];
    expect(next?.lotCode).not.toBe(lots[0]?.lotCode);
    // Stores receive a delivery by hand the same way; a supplier batch named twice in one delivery is refused.
    const manual = (body: Record<string, unknown>) => w.run(w.cast.warehouse, async (c) => (await c.query<{ r: ReceivedLots }>('select site.receive_delivery($1::jsonb) as r', [JSON.stringify(body)])).rows[0]?.r);
    const batch = (supplierLot: string) => ({ supplierLot, manufacturerCode: 'MFR-A', containers: '1', quantity: { value: '1.000', unit: 'kg' }, expiresAt: '2030-01-01T00:00:00Z' });
    const two = await manual({ deliveryId: unique('DEL'), materialCode: code, supplierCode: 'SUP-1', deliveryNoteName: 'Paracetamol IP', supplierBatches: [batch('SB-7'), batch('SB-8')] });
    expect(two?.lots).toHaveLength(2);
    expect(await refusal(manual({ deliveryId: unique('DEL'), materialCode: code, supplierCode: 'SUP-1', supplierBatches: [batch('SB-9'), batch('SB-9')] }))).toMatch(/EBMR-SITE-914 each supplier batch appears once/);
    expect(await refusal(manual({ deliveryId: unique('DEL'), materialCode: code, supplierCode: 'SUP-1', supplierBatches: [{ ...batch('SB-10'), quantity: { value: '1', unit: 'g' } }] }))).toMatch(/EBMR-SITE-915/);
    // Only stores receive: the operator and the QA reviewer are refused, and the application writes no receipt row itself.
    expect(await refusal(w.run(w.cast.operator, (c) => c.query('select site.receive_delivery($1::jsonb)', [JSON.stringify({ deliveryId: unique('DEL'), materialCode: code, supplierCode: 'S', supplierBatches: [batch('SB-11')] })])))).toMatch(/EBMR-IAM-\d{3}/);
    expect(await refusal(db.app.query("insert into site.lot_receipt (lot_id) values ($1)", [lots[0]?.lotId]))).toMatch(/permission denied/);
  });
});

describe('the approved-manufacturer register (PR-17 clause 3)', () => {
  it('[PR-17] an unapproved manufacturer blocks the lot', async () => {
    const code = await material();
    const r = await w.inbound(w.envelope('wms.goods_receipt', goodsReceipt(unique('DEL'), code, [['SB-X', 'MFR-X', '2', '10.000']])));
    const lot = (r.applied as unknown as ReceivedLots).lots[0];
    if (!lot) throw new Error('no lot');
    expect(lot.manufacturerApproved).toBe(false);
    await examine(lot.lotId);
    // Not released while the label names an unapproved manufacturer: the lot stays with QC.
    expect(await refusal(release(lot.lotId))).toMatch(/EBMR-SITE-918 lot .* names manufacturer MFR-X, which is not on the approved-manufacturer register/);
    expect(await w.state(lot.lotId)).toBe('QUARANTINE');
    // QA approves the manufacturer with its signature: the lot is released and issued.
    const approval = await w.approveManufacturer(code, 'MFR-X');
    await release(lot.lotId);
    const batch = await w.batch(['IN']);
    const reservation = await w.reserve(lot.lotId, batch, '2');
    // The approval is withdrawn: the check is repeated at dispensing, so the lot is no longer issued.
    await w.run(w.cast.qa, (c) => c.query('select site.withdraw_manufacturer_approval($1, $2)', [approval, 'audit found GMP non-compliance at the manufacturing site']));
    expect(await refusal(w.reserve(lot.lotId, batch, '1'))).toMatch(/EBMR-SITE-918/);
    expect(await refusal(w.consume(batch, reservation, code, '1'))).toMatch(/EBMR-SITE-918/);
  });

  it('[PR-17][DI-17] the register is QA\'s signed decision: proposed and approved by QA with its own signature, once, withdrawn with a reason', async () => {
    const code = await material();
    const propose = (actor = w.cast.qa, p: Record<string, unknown> = {}) =>
      w.run(actor, async (c) => (await c.query<{ id: string }>('select site.propose_approved_manufacturer($1::jsonb) as id', [
        JSON.stringify({ materialCode: code, manufacturerCode: 'MFR-Q', manufacturerName: 'Q Pharma Ltd', basis: 'Audit report AR-2026-07, questionnaire', ...p }),
      ])).rows[0]?.id ?? '');
    expect(await refusal(propose(w.cast.operator))).toMatch(/EBMR-IAM-\d{3}/);
    expect(await refusal(propose(w.cast.warehouse))).toMatch(/EBMR-IAM-\d{3}/);
    expect(await refusal(propose(w.cast.qa, { basis: 'short' }))).toMatch(/EBMR-SITE-910/);
    expect(await refusal(propose(w.cast.qa, { materialCode: 'NO-SUCH-MATERIAL' }))).toMatch(/EBMR-SITE-910 material NO-SUCH-MATERIAL is not in the ERP material master/);
    const id = await propose();
    const approve = (actor = w.cast.qa, sig: string) => w.run(actor, (c) => c.query('select site.approve_manufacturer($1, $2)', [id, sig]));
    // Another QA person's signature does not approve it for the one who records it.
    const qa2Sig = await signFor(db, w.cast.qcHead, { type: 'approved_manufacturer', id }, 'MANUFACTURER_APPROVED', 'PROPOSED').catch((e: unknown) => String(e));
    expect(qa2Sig).toMatch(/EBMR-(ESIG|IAM)-\d{3}/);
    const sig = await signFor(db, w.cast.qa, { type: 'approved_manufacturer', id }, 'MANUFACTURER_APPROVED', 'PROPOSED');
    expect(await refusal(approve(w.cast.qcHead, sig))).toMatch(/EBMR-(IAM|SITE)-\d{3}/);
    await approve(w.cast.qa, sig);
    expect(await refusal(approve(w.cast.qa, sig))).toMatch(/EBMR-SITE-911/);
    expect((await db.app.query("select site.manufacturer_approved('SITE-1', $1, 'MFR-Q') as ok", [code])).rows[0]).toEqual({ ok: true });
    // A second approval of the same manufacturer while one stands is refused.
    const dup = await propose();
    const dupSig = await signFor(db, w.cast.qa, { type: 'approved_manufacturer', id: dup }, 'MANUFACTURER_APPROVED', 'PROPOSED');
    expect(await refusal(w.run(w.cast.qa, (c) => c.query('select site.approve_manufacturer($1, $2)', [dup, dupSig])))).toMatch(/EBMR-SITE-911 manufacturer MFR-Q is already approved/);
    expect(await refusal(w.run(w.cast.qa, (c) => c.query('select site.withdraw_manufacturer_approval($1, $2)', [id, ' '])))).toMatch(/EBMR-SITE-913/);
    await w.run(w.cast.qa, (c) => c.query('select site.withdraw_manufacturer_approval($1, $2)', [id, 'supplier change notified']));
    expect((await db.app.query("select site.approved_manufacturer_state($1) as s", [id])).rows[0]).toEqual({ s: 'WITHDRAWN' });
    // The application role writes none of the register's tables.
    for (const sql of [
      "insert into site.approved_manufacturer (site_code) values ('SITE-1')",
      'insert into site.approved_manufacturer_approval (approved_manufacturer_id) values (gen_random_uuid())',
      'delete from site.approved_manufacturer_withdrawal',
    ]) {
      expect(await refusal(db.app.query(sql))).toMatch(/permission denied/);
    }
  });
});

describe('a complete receipt record before issue (PR-17 clause 4)', () => {
  it('[PR-17] a lot without a complete receipt record cannot be issued', async () => {
    const batch = await w.batch(['IN']);
    // Received with site.receive_lot, which records no receipt: released, but never reserved.
    const bare = await w.receive('API', {}, true, false);
    await w.identity(bare.lotId);
    const sig = await w.sign(w.cast.qcHead, bare.lotId, 'MATERIAL_LOT_RELEASED', 'QUARANTINE');
    await w.run(w.cast.qcHead, async (c) => changeLotStatus(c, bare.lotId, 'RELEASE', await w.version(bare.lotId), sig, 'IDENTITY_TESTED'));
    expect(await refusal(w.reserve(bare.lotId, batch, '1'))).toMatch(/EBMR-SITE-917 lot .* has no receipt record/);
    await w.approveManufacturer(bare.materialCode);
    await w.run(w.cast.warehouse, (c) => c.query('select site.record_lot_receipt($1, $2::jsonb)', [bare.lotId, JSON.stringify({ deliveryId: unique('DEL'), supplierCode: 'SUP-1', supplierLot: 'SB-B', manufacturerCode: 'MFR-1', containers: '2' })]));
    expect(await refusal(w.reserve(bare.lotId, batch, '1'))).toMatch(/EBMR-SITE-917 the 2 containers of lot .* were not examined at receipt/);
    // The examiner is a person: the ERP's identity cannot record the examination (DI-14).
    expect(await refusal(w.run(w.adapter, (c) => c.query('select site.record_receipt_examination($1, $2::jsonb)', [bare.lotId, JSON.stringify({ containersExamined: '2', outcome: 'ACCEPTABLE' })])))).toMatch(/EBMR-(IAM|SITE)-\d{3}/);
    expect(await refusal(examine(bare.lotId, '2', 'DEFECTS_FOUND'))).toMatch(/EBMR-SITE-916/);
    await examine(bare.lotId, '1');
    expect(await refusal(w.reserve(bare.lotId, batch, '1'))).toMatch(/EBMR-SITE-917 the receipt examination of lot .* covers 1 of its 2 containers/);
    expect(await refusal(examine(bare.lotId))).toMatch(/EBMR-SITE-916 the containers of lot .* were already examined/);
    // Defects found at receipt block the lot.
    const damaged = await w.receive('API', {}, true, false);
    await w.approveManufacturer(damaged.materialCode);
    await w.run(w.cast.warehouse, (c) => c.query('select site.record_lot_receipt($1, $2::jsonb)', [damaged.lotId, JSON.stringify({ deliveryId: unique('DEL'), supplierCode: 'SUP-1', supplierLot: 'SB-D', manufacturerCode: 'MFR-1', containers: '2' })]));
    await examine(damaged.lotId, '2', 'DEFECTS_FOUND', 'seal of container 2 broken');
    expect(await w.count('select count(*) as n from site.lot_receipt_examination where lot_id = $1', [damaged.lotId])).toBe(1);
    // Complete: reserved.
    const complete = await w.releasedLot('API');
    expect(await w.reserve(complete.lotId, batch, '1')).toMatch(/^[0-9a-f-]{36}$/);
    // Bypass attempts: the application role writes neither the record nor a reservation; owner-level code that inserts a
    // reservation for the bare lot directly is refused by the gate.
    expect(await refusal(db.app.query('insert into site.lot_receipt_examination (lot_id) values ($1)', [bare.lotId]))).toMatch(/permission denied/);
    expect(await refusal(db.app.query('insert into site.lot_reservation (lot_id) values ($1)', [bare.lotId]))).toMatch(/permission denied/);
    expect(await refusal(db.admin.query(
      `insert into site.lot_reservation (lot_id, batch_id, batch_number, edition, quantity, unit, expires_at, lot_state_version, reserved_by_person, reserved_by_account)
       values ($1, $2, $3, 'TABLETS', 1, 'kg', clock_timestamp() + interval '1 hour', 2, $4, $5)`,
      [bare.lotId, batch.id, batch.number, w.cast.warehouse.personId, w.cast.warehouse.accountId],
    ))).toMatch(/EBMR-SITE-917/);
  });
});

describe('corrections of WMS-captured receipt values (DI-31, DI-26)', () => {
  it('[DI-31][DI-26] an interface-captured value changes only by an audit-trailed correction with a reason; the original stays and the override is registered', async () => {
    const code = await material();
    await w.approveManufacturer(code, 'MFR-A');
    const r = await w.inbound(w.envelope('wms.goods_receipt', goodsReceipt(unique('DEL'), code, [['SB-C', 'MFR-A', '2', '10.000']])));
    const lot = (r.applied as unknown as ReceivedLots).lots[0];
    if (!lot) throw new Error('no lot');
    const correct = (actor: typeof w.cast.warehouse, field: string, value: string, reason: string) =>
      w.run(actor, async (c) => (await c.query<{ id: string }>('select site.correct_lot_receipt_value($1, $2, $3, $4) as id', [lot.lotId, field, value, reason])).rows[0]?.id ?? '');
    expect(await refusal(correct(w.cast.warehouse, 'containers', '3', ''))).toMatch(/EBMR-INT-021/);
    expect(await refusal(correct(w.cast.warehouse, 'containers', '2', 'same'))).toMatch(/EBMR-INT-023/);
    expect(await refusal(correct(w.cast.warehouse, 'receivedValue', '11', 'try the quantity'))).toMatch(/EBMR-SITE-923/);
    expect(await refusal(correct(w.adapter, 'containers', '3', 'the ERP corrects itself'))).toMatch(/EBMR-INT-020/);
    const id = await correct(w.cast.warehouse, 'containers', '3', 'delivery note shows three drums; the WMS booked two');
    const eff = (await db.app.query<{ e: { containers: string; corrections: { field: string; originalValue: string; correctedValue: string; reason: string }[] } }>(
      'select site.lot_receipt_effective($1) as e', [lot.lotId])).rows[0]?.e;
    expect(eff?.containers).toBe('3');
    expect(eff?.corrections).toEqual([expect.objectContaining({ id, field: 'containers', originalValue: '2', correctedValue: '3', reason: 'delivery note shows three drums; the WMS booked two' })]);
    // The stored receipt keeps the value as received; the override names its message and is on the adapter's audit chain.
    const { rows } = await db.app.query('select o.message_id::text as m, o.original_value, o.corrected_value, r.containers from platform.inbound_override o join site.lot_receipt r on r.lot_id = o.record_id where o.id = $1', [id]);
    expect(rows).toEqual([{ m: r.messageId, original_value: '2', corrected_value: '3', containers: 2 }]);
    expect(await w.count('select count(*) as n from kernel.audit_event where chain_key = $1 and record_id = $2', [`integration_adapter:${w.adapterCode}`, id])).toBe(1);
    // An examination of two containers no longer covers the corrected three.
    await examine(lot.lotId, '2');
    expect(await w.count("select count(*) as n from site.lot_receipt_examination where lot_id = $1", [lot.lotId])).toBe(1);
    expect((await db.app.query<{ p: string }>('select site.receipt_problem($1) as p', [lot.lotId])).rows[0]?.p).toMatch(/covers 2 of its 3 containers/);
    // Neither the receipt row nor the override can be changed in place, even by owner-level code.
    expect(await refusal(db.app.query('update site.lot_receipt set containers = 5 where lot_id = $1', [lot.lotId]))).toMatch(/permission denied/);
    expect(await refusal(db.admin.query('update site.lot_receipt set containers = 5 where lot_id = $1', [lot.lotId]))).toMatch(/EBMR-AUDIT-004/);
    expect(await refusal(db.admin.query("update platform.inbound_override set reason = 'x' where id = $1", [id]))).toMatch(/EBMR-AUDIT-004/);
    // A receipt stores entered by hand is not interface-captured: it is not corrected here.
    const manual = await w.releasedLot('API');
    expect(await refusal(w.run(w.cast.warehouse, (c) => c.query("select site.correct_lot_receipt_value($1, 'containers', '3', 'x')", [manual.lotId])))).toMatch(/EBMR-SITE-923/);
  });
});
