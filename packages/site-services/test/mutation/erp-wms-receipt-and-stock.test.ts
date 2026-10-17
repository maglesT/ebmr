/**
 * Kill tests of the erp-wms-receipt-and-stock mutation group (site services 0910 to 0916, 0970; decision 0019, Phase 6
 * exit campaign part 1): the ERP/WMS payload shapes, the receipt commands' refusals and limits, the approved-manufacturer
 * register, corrections of interface-captured values, the lot status mirror's staleness, the location rule's questions
 * and the outbound queue. As the application role through real identities and the registered ERP_WMS adapter.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { signerActor } from '../../../kernel/test/continuity/helpers.ts';
import { createTestDatabase, signFor, type TestDatabase } from '../helpers.ts';
import { refusal, unique } from '../lots/support.ts';
import { ErpWorld, goodsReceipt } from '../erp-wms/support.ts';

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
async function material(kind: 'API' | 'EXCIPIENT' | 'INTERMEDIATE' = 'API'): Promise<string> {
  const code = unique(`M${kind.slice(0, 3)}`);
  await w.material(code, `Material ${code}`, kind, 'kg');
  if (kind !== 'INTERMEDIATE') await w.specification(code);
  return code;
}

interface ReceivedLots {
  itemMasterStale: boolean;
  lots: { lotId: string; lotCode: string; supplierLot: string; manufacturerCode: string; manufacturerApproved: boolean }[];
}

const batch = (supplierLot: string, over: Record<string, unknown> = {}) => ({
  supplierLot, manufacturerCode: 'MFR-A', containers: '1', quantity: { value: '1.000', unit: 'kg' }, expiresAt: '2030-01-01T00:00:00Z', ...over,
});
const manual = (body: unknown) => w.run(w.cast.warehouse, async (c) => (await c.query<{ r: ReceivedLots }>('select site.receive_delivery($1::jsonb) as r', [JSON.stringify(body)])).rows[0]!.r);
const delivery = (materialCode: string, over: Record<string, unknown> = {}) => ({
  deliveryId: unique('DEL'), materialCode, supplierCode: 'SUP-1', supplierBatches: [batch(unique('SB-'))], ...over,
});

describe('payload shapes (DI-31; site services 0913)', () => {
  const problem = async (type: string, p: unknown) => (await db.admin.query<{ p: string | null }>('select site.erp_payload_problem($1, $2::jsonb) as p', [type, JSON.stringify(p)])).rows[0]!.p;
  const q = { value: '10.000', unit: 'kg' };

  it('[DI-31] each field of each ERP/WMS message type is checked on its own; a well-formed message has no problem', async () => {
    const shapes: Record<string, [Record<string, unknown>, Record<string, unknown>[]]> = {
      'erp.production_order': [
        { orderNumber: 'PO-1', productCode: 'P-1', strength: '500 mg', plannedQuantity: q, plannedStart: '1800000000000000', bom: [{ materialCode: 'M-1', quantity: q }] },
        [{ orderNumber: '' }, { productCode: '' }, { strength: ' ' }, { plannedQuantity: { value: 'x', unit: 'kg' } }, { plannedStart: '2027-01-01' }, { bom: {} }, { bom: [] },
          { bom: [5] }, { bom: [{ materialCode: '', quantity: q }] }, { bom: [{ materialCode: 'M-1', quantity: { value: '1' } }] }],
      ],
      'erp.material_master': [
        { materialCode: 'M-1', name: 'Paracetamol', baseUnit: 'kg', materialKind: 'API', maxRetestMonths: '24' },
        [{ materialCode: '' }, { name: ' ' }, { baseUnit: '' }, { materialKind: '' }, { maxRetestMonths: '0' }],
      ],
      'erp.product_master': [
        { productCode: 'P-1', name: 'Paracetamol tablets', strength: '500 mg', betaLactam: false, shelfLifeMonths: '36' },
        [{ productCode: '' }, { name: ' ' }, { strength: ' ' }, { betaLactam: 'no' }, { shelfLifeMonths: '0' }],
      ],
      'wms.goods_receipt': [
        { deliveryId: 'D-1', materialCode: 'M-1', supplierCode: 'S-1', receivedAt: '1800000000000000',
          supplierBatches: [{ supplierLot: 'SB-1', manufacturerCode: 'MF-1', containers: '2', quantity: q, expiryDate: '2030-06-30', retestDate: null }] },
        [{ deliveryId: '' }, { materialCode: '' }, { supplierCode: '' }, { receivedAt: 'now' }, { supplierBatches: {} }, { supplierBatches: [] },
          { supplierBatches: Array.from({ length: 101 }, () => ({ supplierLot: 'SB-1', manufacturerCode: 'MF-1', containers: '2', quantity: q, expiryDate: '2030-06-30' })) },
          ...[{ supplierLot: '' }, { manufacturerCode: '' }, { containers: '0' }, { quantity: { value: '1,5', unit: 'kg' } }, { expiryDate: '2030-02-30' },
            { retestDate: '2030-13-01' }].map((b) => ({ supplierBatches: [{ supplierLot: 'SB-1', manufacturerCode: 'MF-1', containers: '2', quantity: q, expiryDate: '2030-06-30', ...b }] })),
          { supplierBatches: ['SB-1'] }],
      ],
      'wms.stock_move': [
        { lotNumber: 'L-1', fromLocation: 'A', toLocation: 'B', toLocationKind: 'RELEASED', quantity: q, movedAt: '1800000000000000' },
        [{ lotNumber: '' }, { fromLocation: '' }, { toLocation: '' }, { toLocationKind: 'DOCK' }, { quantity: { value: '1' } }, { movedAt: '-1' }],
      ],
      'wms.lot_status': [{ lotNumber: 'L-1', status: 'RELEASED' }, [{ lotNumber: '' }, { status: 'OK' }]],
      'erp.shipment': [{ shipmentId: 'SH-1', lotNumber: 'L-1', quantity: q }, [{ shipmentId: '' }, { lotNumber: '' }, { quantity: { value: '1', unit: '' } }]],
    };
    for (const [type, [good, bads]] of Object.entries(shapes)) {
      expect(await problem(type, good), type).toBeNull();
      for (const bad of bads) expect(await problem(type, { ...good, ...bad }), `${type} ${JSON.stringify(bad).slice(0, 80)}`).not.toBeNull();
    }
    // A retest date given with a real date is accepted.
    const gr = shapes['wms.goods_receipt']![0];
    expect(await problem('wms.goods_receipt', { ...gr, supplierBatches: [{ ...(gr['supplierBatches'] as Record<string, unknown>[])[0], retestDate: '2029-06-30' }] })).toBeNull();
    expect(await problem('erp.material_master', { materialCode: 'M-1', name: 'Paracetamol', baseUnit: 'kg', materialKind: 'API' })).toBeNull();
  });

  it('[DI-31] a source value is exactly {value, unit} with a decimal value; a calendar date is a real one', async () => {
    const ok = async (v: unknown) => (await db.admin.query<{ ok: boolean }>('select site.erp_source_value_ok($1::jsonb) as ok', [JSON.stringify(v)])).rows[0]!.ok;
    expect(await ok({ value: '-1.5', unit: 'kg' })).toBe(true);
    for (const bad of ['1 kg', { value: '1' }, { value: '1', unit: 'kg', note: 'x' }, { value: '1.', unit: 'kg' }, { value: '1', unit: '' }, { value: 'x', unit: 'kg' }]) {
      expect(await ok(bad), JSON.stringify(bad)).toBe(false);
    }
    const date = async (d: string) => (await db.admin.query<{ ok: boolean }>('select site.calendar_date_ok($1) as ok', [d])).rows[0]!.ok;
    expect(await date('2028-02-29')).toBe(true);
    expect(await date('2027-02-29')).toBe(false);
    expect(await date('2027-02-30')).toBe(false);
  });
});

describe('receipt (PR-17, PR-18, INV-13; site services 0910)', () => {
  it('[PR-17][PR-18][INV-13] a delivery received by stores: each malformed part, an unknown or made-here material, a repeated delivery, a zero quantity and a retest after expiry are refused', async () => {
    const code = await material();
    await expectCode(manual({ ...delivery(code), supplierBatches: 'SB-1' }), /EBMR-SITE-914 a delivery names its id/);
    await expectCode(manual({ ...delivery(code), deliveryId: '' }), /EBMR-SITE-914 a delivery names its id/);
    await expectCode(manual({ ...delivery(code), supplierCode: ' ' }), /EBMR-SITE-914 a delivery names its id/);
    await expectCode(manual({ ...delivery(code), supplierBatches: [] }), /EBMR-SITE-914 a delivery names its id/);
    await expectCode(manual({ ...delivery(code), supplierBatches: Array.from({ length: 101 }, (_, i) => batch(`SB-${i.toString()}`)) }), /EBMR-SITE-914 a delivery names its id/);
    await expectCode(manual(delivery('NO-SUCH-MATERIAL')), /EBMR-SITE-171 material NO-SUCH-MATERIAL is not in the ERP material master/);
    await expectCode(manual(delivery(await material('INTERMEDIATE'))), /EBMR-SITE-172 material .* is INTERMEDIATE in the material master/);
    for (const over of [{ supplierLot: '' }, { manufacturerCode: ' ' }, { containers: '0' }, { quantity: { value: '1,5', unit: 'kg' } }, { expiresAt: '2030-01-01' },
      { retestAt: 'soon' }, { lotCode: 'lower-case' }]) {
      await expectCode(manual({ ...delivery(code), supplierBatches: [batch(unique('SB-'), over)] }), /EBMR-SITE-914 a supplier batch names its supplier batch number/);
    }
    await expectCode(manual({ ...delivery(code), supplierBatches: [batch(unique('SB-'), { quantity: { value: '0', unit: 'kg' } })] }), /EBMR-SITE-915 supplier batch .* has no quantity/);
    await expectCode(manual({ ...delivery(code), supplierBatches: [batch(unique('SB-'), { retestAt: '2030-01-01T00:00:01Z' })] }), /EBMR-SITE-914 supplier batch .* has its retest after its expiry/);
    await expectCode(manual({ ...delivery(code), supplierBatches: [batch(unique('SB-'), { expiresAt: '2001-01-01T00:00:00Z' })] }), /EBMR-SITE-104 supplier batch .* expiry instant in the future/);
    // The limits are inclusive: 100 batches, a retest on the expiry instant, a lot code given by stores.
    const lotCode = unique('LC-').toUpperCase();
    // (The given code is the last batch's: see the finding on generated codes after a given one in the campaign results.)
    const many = await manual({ ...delivery(code), supplierBatches: [...Array.from({ length: 99 }, () => batch(unique('SB-'))),
      batch(unique('SB-'), { retestAt: '2030-01-01T00:00:00Z', lotCode })] });
    expect(many.lots).toHaveLength(100);
    expect(many.lots[99]?.lotCode).toBe(lotCode);
    // The same delivery again is refused.
    const once = delivery(code);
    await manual(once);
    await expectCode(manual({ ...once, supplierBatches: [batch(unique('SB-'))] }), /EBMR-SITE-914 delivery .* was already received at site SITE-1/);
    // The stored receipt names its item-master freshness only when the master is stale.
    const fresh = await manual(delivery(code));
    expect(fresh.itemMasterStale).toBe(false);
    expect((await db.admin.query('select item_master_freshness from site.lot_receipt where lot_id = $1', [fresh.lots[0]?.lotId])).rows).toEqual([{ item_master_freshness: null }]);
  });

  it('[PR-17][DI-14] the receipt record of a lot received without one, and its examination: each refusal', async () => {
    const recordFor = (lotId: string, body: unknown) => w.run(w.cast.warehouse, (c) => c.query('select site.record_lot_receipt($1, $2::jsonb)', [lotId, JSON.stringify(body)]));
    const good = { deliveryId: unique('DEL'), supplierCode: 'SUP-1', supplierLot: 'SB-B', manufacturerCode: 'MFR-1', containers: '2' };
    const bare = await w.receive('API', {}, true, false);
    for (const over of [{ deliveryId: '' }, { supplierCode: '' }, { supplierLot: '' }, { manufacturerCode: '' }, { containers: '0' }]) {
      await expectCode(recordFor(bare.lotId, { ...good, ...over }), /EBMR-SITE-914 a receipt record names the delivery/);
    }
    const made = await w.receive('INTERMEDIATE', {}, true, false);
    await expectCode(recordFor(made.lotId, good), /EBMR-SITE-915 lot .* is INTERMEDIATE: it was made here and has no receipt record/);
    // Received with a supplier batch: the record names the same one.
    const named = await w.receive('API', { supplierLot: 'SB-NAMED' } as never, true, false);
    const lotRow = (await db.admin.query<{ s: string | null }>('select supplier_lot as s from site.material_lot where id = $1', [named.lotId])).rows[0]!.s;
    if (lotRow) await expectCode(recordFor(named.lotId, { ...good, supplierLot: `${lotRow}-X` }), /EBMR-SITE-915 lot .* was received as supplier batch/);
    // Examination: only of a lot with a receipt record, with a valid count and outcome, and remarks when defects were found.
    const examine = (lotId: string, body: unknown) => w.run(w.cast.warehouse, (c) => c.query('select site.record_receipt_examination($1, $2::jsonb)', [lotId, JSON.stringify(body)]));
    await expectCode(examine(bare.lotId, { containersExamined: '2', outcome: 'ACCEPTABLE' }), /EBMR-SITE-916 lot .* has no receipt record to examine against/);
    await recordFor(bare.lotId, good);
    await expectCode(recordFor(bare.lotId, good), /EBMR-SITE-915 lot .* already has its receipt record/);
    for (const body of [{ containersExamined: '0', outcome: 'ACCEPTABLE' }, { containersExamined: '2', outcome: 'FINE' }, { containersExamined: '2', outcome: 'DEFECTS_FOUND' }]) {
      await expectCode(examine(bare.lotId, body), /EBMR-SITE-916 an examination gives the number of containers examined/);
    }
    await examine(bare.lotId, { containersExamined: '2', outcome: 'ACCEPTABLE', remarks: 'drums intact' });
    // The receipt problem names its own lot; a lot made here has none.
    expect((await db.app.query<{ p: string | null }>('select site.receipt_problem($1) as p', [bare.lotId])).rows[0]!.p).toBeNull();
    const partial = await w.receive('API', {}, true, false);
    await recordFor(partial.lotId, { ...good, deliveryId: unique('DEL') });
    expect((await db.app.query<{ p: string | null }>('select site.receipt_problem($1) as p', [partial.lotId])).rows[0]!.p).toContain(partial.lotCode);
    expect((await db.app.query<{ p: string | null }>('select site.receipt_problem($1) as p', [made.lotId])).rows[0]!.p).toBeNull();
  });
});

async function expectCode(p: Promise<unknown>, re: RegExp): Promise<void> {
  expect(await refusal(p)).toMatch(re);
}

describe('the approved-manufacturer register (PR-17; site services 0910)', () => {
  const propose = (code: string, over: Record<string, unknown> = {}) => w.run(w.cast.qa, async (c) => (await c.query<{ id: string }>('select site.propose_approved_manufacturer($1::jsonb) as id', [
    JSON.stringify({ materialCode: code, manufacturerCode: unique('MFR-'), manufacturerName: 'Q Pharma Ltd', basis: 'Audit report AR-2026-07', ...over }),
  ])).rows[0]!.id);

  it('[PR-17][DI-17] proposal fields, the 10-character basis, unknown and unapproved rows, and the signer who records the approval', async () => {
    const code = await material();
    for (const over of [{ manufacturerCode: '' }, { manufacturerName: ' ' }, { basis: '123456789' }]) {
      await expectCode(propose(code, over), /EBMR-SITE-910 an approved manufacturer names the material/);
    }
    const id = await propose(code, { basis: '1234567890' });
    await expectCode(w.run(w.cast.qa, (c) => c.query('select site.approve_manufacturer($1, $2)', [randomUUID(), randomUUID()])), /EBMR-SITE-911 unknown approved-manufacturer proposal/);
    await expectCode(w.run(w.cast.qa, (c) => c.query('select site.withdraw_manufacturer_approval($1, $2)', [randomUUID(), 'x'])), /EBMR-SITE-911 unknown approved-manufacturer proposal/);
    await expectCode(w.run(w.cast.qa, (c) => c.query('select site.withdraw_manufacturer_approval($1, $2)', [id, 'not approved yet'])), /EBMR-SITE-913 manufacturer .* is not approved by this row/);
    // Another QA person presents the signer's signature: refused.
    const qa2 = await signerActor(db, 'QA_REVIEWER');
    const sig = await signFor(db, w.cast.qa, { type: 'approved_manufacturer', id }, 'MANUFACTURER_APPROVED', 'PROPOSED');
    await expectCode(w.run(qa2, (c) => c.query('select site.approve_manufacturer($1, $2)', [id, sig])), /EBMR-(SITE-912|ESIG-\d{3}|IAM-\d{3})/);
    await w.run(w.cast.qa, (c) => c.query('select site.approve_manufacturer($1, $2)', [id, sig]));
  });
});

describe('corrections of interface-captured receipt values (DI-31, DI-26; site services 0913)', () => {
  it('[DI-31][DI-26] each correctable field takes only its own valid values; a correction of one lot or one field never shows on another', async () => {
    const code = await material();
    await w.approveManufacturer(code, 'MFR-A');
    const r = await w.inbound(w.envelope('wms.goods_receipt', goodsReceipt(unique('DEL'), code, [['SB-C', 'MFR-A', '2', '10.000'], ['SB-D', 'MFR-A', '3', '5.000']], { deliveryNoteName: 'Paracetamol IP' })));
    const [a, b] = (r.applied as unknown as ReceivedLots).lots;
    if (!a || !b) throw new Error('no lots');
    const correct = (lotId: string, field: string, value: string) =>
      w.run(w.cast.warehouse, async (c) => (await c.query<{ id: string }>('select site.correct_lot_receipt_value($1, $2, $3, $4) as id', [lotId, field, value, 'delivery note differs from the WMS booking'])).rows[0]!.id);
    for (const [field, value] of [['containers', '0'], ['containers', 'two'], ['supplierLot', ''], ['supplierLot', 'S B'], ['manufacturerCode', ''], ['deliveryNoteName', ' '],
      ['deliveryNoteName', 'N'.repeat(501)], ['lotCode', 'X']] as const) {
      await expectCode(correct(a.lotId, field, value), /EBMR-SITE-923/);
    }
    const eff = async (lotId: string) => (await db.app.query<{ e: Record<string, unknown> }>('select site.lot_receipt_effective($1) as e', [lotId])).rows[0]!.e;
    await correct(a.lotId, 'containers', '4');
    expect(await eff(a.lotId)).toMatchObject({ containers: '4', supplierLot: 'SB-C', manufacturerCode: 'MFR-A' });
    expect(await eff(b.lotId)).toMatchObject({ containers: '3', supplierLot: 'SB-D', manufacturerCode: 'MFR-A', corrections: [] });
    await correct(a.lotId, 'supplierLot', 'SB-C2');
    await correct(a.lotId, 'manufacturerCode', 'MFR-A2');
    await correct(a.lotId, 'deliveryNoteName', 'N'.repeat(500));
    expect(await eff(a.lotId)).toMatchObject({ containers: '4', supplierLot: 'SB-C2', manufacturerCode: 'MFR-A2', deliveryNoteName: 'N'.repeat(500) });
    expect(await eff(b.lotId)).toMatchObject({ containers: '3', supplierLot: 'SB-D', manufacturerCode: 'MFR-A', deliveryNoteName: 'Paracetamol IP', corrections: [] });
  });
});

describe('the WMS mirrors at the lot (DI-31, PR-46, INV-26; site services 0911, 0912, 0916, 0970)', () => {
  const move = (lotCode: string, toLocationKind: string, over: Record<string, unknown> = {}) => ({
    lotNumber: lotCode, fromLocation: 'WH-QRT-01', toLocation: 'WH-QRT-02', toLocationKind, quantity: { value: '1.000', unit: 'kg' }, movedAt: '1800000000000000', ...over,
  });
  const asAdapter = <T>(sql: string, params: unknown[]) => withCommand(db.app, { ...w.adapter, correlationId: randomUUID() }, async (c) => (await c.query<{ r: T }>(sql, params)).rows[0]!.r);

  it('[DI-31] a WMS status as old as the one held is stale; a move in another unit is refused; the issue problem names the lot', async () => {
    const lot = await w.receive('API');
    const ts = '1800000005000000';
    expect((await w.inbound(w.envelope('wms.lot_status', { lotNumber: lot.lotCode, status: 'QUARANTINE' }, { sourceTimestamp: ts }))).outcome).toBe('ACCEPTED');
    const again = await w.deliver(w.envelope('wms.lot_status', { lotNumber: lot.lotCode, status: 'RELEASED' }, { sourceTimestamp: ts }), 'STALE');
    expect(again).toMatchObject({ ok: false, code: 'EBMR-ERP-004' });
    const grams = await w.deliver(w.envelope('wms.stock_move', move(lot.lotCode, 'QUARANTINE', { quantity: { value: '1000', unit: 'g' } })), 'MALFORMED');
    expect(grams).toMatchObject({ ok: false, code: 'EBMR-ERP-003' });
    // With the lot status mirrored, the issue problem names the lot it is about.
    await w.setting('integration.mode.erp_lot_status', 'MIRROR');
    try {
      await w.sync('ERP_LOT_STATUS');
      expect((await db.app.query<{ p: string }>('select site.erp_lot_status_problem($1) as p', [lot.lotId])).rows[0]!.p).toContain(`lot ${lot.lotCode} as QUARANTINE`);
    } finally {
      await w.setting('integration.mode.erp_lot_status', 'STAND_IN');
    }
  });

  it('[PR-46] the WMS asks about a move: an unknown lot and an unknown location kind are answered, not raised; a known lot gets the rule', async () => {
    const lot = await w.receive('API');
    expect(await asAdapter<string>('select site.wms_location_question($1, $2) as r', ['NO-SUCH-LOT', 'QUARANTINE'])).toMatch(/the eBMR holds no lot NO-SUCH-LOT at site SITE-1/);
    expect(await asAdapter<string>('select site.wms_location_question($1, $2) as r', [lot.lotCode, 'DOCK'])).toMatch(/DOCK is not a location kind the eBMR knows/);
    expect(await asAdapter<string | null>('select site.wms_location_question($1, $2) as r', [lot.lotCode, 'QUARANTINE'])).toBeNull();
    expect(await asAdapter<string>('select site.wms_location_question($1, $2) as r', [lot.lotCode, 'RELEASED'])).toMatch(new RegExp(`lot ${lot.lotCode} is QUARANTINE: it may go only to`));
  });

  it('[PR-46] a location exception closes only with a deviation linked to its own lot; an unknown exception is refused', async () => {
    const lot = await w.receive('API');
    const otherLot = await w.receive('API');
    const r = await w.inbound(w.envelope('wms.stock_move', move(lot.lotCode, 'RELEASED', { toLocation: 'WH-RLS-01' })));
    const exceptionId = (r.applied as { exceptionId: string }).exceptionId;
    const deviation = async (lotId: string) => {
      const id = await w.run(w.cast.qa, async (c) => (await c.query<{ r: { deviationId: string } }>('select site.raise_deviation($1::jsonb) as r', [
        JSON.stringify({ kind: 'DEVIATION', title: 'Lot moved against the location rule', classification: 'MAJOR', riskRationale: 'Unreleased material was available for picking' }),
      ])).rows[0]!.r.deviationId);
      await w.run(w.cast.qa, (c) => c.query("select site.link_deviation($1, 'LOT', $2)", [id, lotId]));
      return id;
    };
    await deviation(lot.lotId);
    const others = await deviation(otherLot.lotId);
    const close = (id: string, dev: string) => w.run(w.cast.qa, (c) => c.query('select site.resolve_lot_location_exception($1, $2, $3)', [id, dev, 'Pallet returned to quarantine']));
    await expectCode(close(randomUUID(), others), /EBMR-SITE-921 unknown location exception/);
    await expectCode(close(exceptionId, others), /EBMR-SITE-921 a location exception of lot .* is closed with a deviation linked to the lot/);
  });

  it('[DI-31] the outbound queue: the delivery limit takes 1, unknown messages and empty references or errors are refused, each message names its own lot', async () => {
    const lot = await w.releasedLot('API');
    expect(Array.isArray(await asAdapter<unknown[]>('select site.erp_outbound_pending(1) as r', []))).toBe(true);
    await expectCode(asAdapter('select site.erp_outbound_delivered($1, $2) as r', [randomUUID(), 'ACK']), /EBMR-ERP-011 there is no outbound message/);
    await expectCode(asAdapter('select site.erp_outbound_failed($1, $2) as r', [randomUUID(), 'timeout']), /EBMR-ERP-011 there is no outbound message/);
    // A stock block request (owner code, as the after-release acts write it) and a goods issue join the queue with the lot's own number.
    const c = await db.admin.connect();
    let request = '';
    try {
      await c.query('begin');
      await c.query(`select kernel.set_actor_context(jsonb_build_object('person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
        'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM', 'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
        'legal_name', 'Test fixture (after-release act)', 'reason_code', 'TEST', 'reason_text', 'a stock block as the suspension writes it'))`);
      request = (await c.query<{ id: string }>("select site.request_erp_stock_block($1, 'BLOCK', $2, '{}'::jsonb) as id", [lot.lotId, `SUSPENSION/${randomUUID()}`])).rows[0]!.id;
      await c.query('commit');
    } finally {
      c.release();
    }
    const batchRow = await w.batch(['IN']);
    const reservation = await w.reserve(lot.lotId, batchRow, '1');
    await w.consume(batchRow, reservation, lot.materialCode, '1');
    const pending = await asAdapter<{ messageId: string; topic: string; lotId: string; payload: Record<string, unknown> }[]>('select site.erp_outbound_pending(1000) as r', []);
    const block = pending.find((m) => m.topic === 'erp.stock_block' && m.payload['requestId'] === request);
    expect(block).toMatchObject({ lotId: lot.lotId, payload: { lotNumber: lot.lotCode } });
    expect(pending.filter((m) => m.topic === 'erp.goods_issue' && m.lotId === lot.lotId).map((m) => m.payload['lotNumber'])).toEqual([lot.lotCode]);
    await expectCode(asAdapter('select site.erp_outbound_delivered($1, $2) as r', [block!.messageId, '']), /EBMR-ERP-011 a delivery names the ERP's reference/);
    await expectCode(asAdapter('select site.erp_outbound_failed($1, $2) as r', [block!.messageId, ' ']), /EBMR-ERP-011 a failed delivery is recorded with its error/);
  });
});
