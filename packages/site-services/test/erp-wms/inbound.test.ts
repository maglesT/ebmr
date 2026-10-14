/**
 * The ERP/WMS adapter's database side (DI-31, DI-20, DI-14, INV-26; site services 0912 to 0914, kernel 1180): faults
 * refused or de-duplicated with an alarm, whole-message commit, provenance of every received value, the fail-closed
 * lot-status mirror, masters and orders only through the domain commands, and the outbound queue that never drops a
 * message. As the application role through real identities, with bypass attempts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../../kernel/src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';
import { refusal, unique } from '../lots/support.ts';
import { ErpWorld, goodsReceipt, integrationActor, registerAdapter, sha } from './support.ts';

let db: TestDatabase;
let w: ErpWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  w = await ErpWorld.create(db);
}, 300_000);
afterAll(async () => {
  await db.drop();
});

async function approvedMaterial(): Promise<string> {
  const code = unique('MAPI');
  await w.material(code, `Material ${code}`, 'API', 'kg');
  await w.approveManufacturer(code, 'MFR-A');
  return code;
}

const lotsOf = (materialCode: string): Promise<number> => w.count('select count(*) as n from site.material_lot where material_code = $1', [materialCode]);

describe('faults at the receiving command (DI-31)', () => {
  it('[DI-31] a malformed, a duplicate, an out-of-order and a wrong-batch ERP message are each refused or de-duplicated with an alarm', async () => {
    const code = await approvedMaterial();
    // Malformed: a supplier batch without its expiry date. Refused; the refusal is recorded with its alarm.
    const malformed = await w.deliver(w.envelope('wms.goods_receipt', goodsReceipt(unique('DEL'), code, [['SB-1', 'MFR-A', '1', '1.000']], {
      supplierBatches: [{ supplierLot: 'SB-1', manufacturerCode: 'MFR-A', containers: '1', quantity: { value: '1.000', unit: 'kg' }, expiryDate: null }],
    })), 'MALFORMED');
    expect(malformed).toMatchObject({ ok: false, code: 'EBMR-ERP-001' });
    expect(await w.alarms('MALFORMED')).toBe(1);
    // Duplicate: the same message again is de-duplicated (no second lot, no alarm); the same key with other content is refused.
    const env = w.envelope('wms.goods_receipt', goodsReceipt(unique('DEL'), code, [['SB-2', 'MFR-A', '1', '1.000']]));
    const first = await w.inbound(env);
    const resend = await w.inbound(env);
    expect(resend).toMatchObject({ messageId: first.messageId, outcome: 'DUPLICATE', applied: null });
    expect(await lotsOf(code)).toBe(1);
    const reused = await w.deliver({ ...env, payloadHash: sha('other content'), sequenceNo: '9000' }, 'DUPLICATE');
    expect(reused).toMatchObject({ ok: false, code: 'EBMR-INT-005' });
    expect(await w.alarms('DUPLICATE')).toBe(1);
    // Out of order: a gap and a late message are accepted with an alarm; a sequence number already taken is refused.
    w.skip(3);
    const gap = await w.inbound(w.envelope('wms.lot_status', { lotNumber: (await w.receive('API')).lotCode, status: 'QUARANTINE' }));
    expect(gap.sequenceStatus).toBe('GAP');
    const late = await w.deliver(w.envelope('erp.shipment', { shipmentId: 'SH-1', lotNumber: 'X', consigneeCode: 'C1', consigneeName: 'C', consigneeAddress: 'A', quantity: { value: '1', unit: 'kg' }, shippedAt: '1800000000000000' }, { sequenceNo: '4' }), 'OUT_OF_ORDER');
    expect(late).toMatchObject({ ok: true, result: { sequenceStatus: 'LATE', applied: { kept: true } } });
    const taken = await w.deliver(w.envelope('erp.shipment', { shipmentId: 'SH-2', lotNumber: 'X', quantity: { value: '1', unit: 'kg' } }, { sequenceNo: '4' }), 'OUT_OF_ORDER');
    expect(taken).toMatchObject({ ok: false, code: 'EBMR-INT-006' });
    expect([await w.alarms('SEQUENCE_GAP'), await w.alarms('OUT_OF_ORDER')]).toEqual([1, 2]);
    // Wrong batch: a move or a status of a lot this site does not hold is refused as WRONG_IDENTITY, with an alarm.
    const wrong = await w.deliver(w.envelope('wms.stock_move', { lotNumber: 'NO-SUCH-LOT', fromLocation: 'A', toLocation: 'B', toLocationKind: 'RELEASED', quantity: { value: '1', unit: 'kg' }, movedAt: '1800000000000000' }), 'WRONG_IDENTITY');
    expect(wrong).toMatchObject({ ok: false, code: 'EBMR-ERP-002' });
    const wrongStatus = await w.deliver(w.envelope('wms.lot_status', { lotNumber: 'NO-SUCH-LOT', status: 'RELEASED' }), 'WRONG_IDENTITY');
    expect(wrongStatus).toMatchObject({ ok: false, code: 'EBMR-ERP-002' });
    expect(await w.alarms('WRONG_IDENTITY')).toBe(2);
    // Every refusal is on record (none silently lost): one exception row per refused message, each with its alarm.
    expect(await w.count("select count(*) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED' and alarm_id is not null", [w.adapterCode])).toBe(5);
  });

  it('[DI-31] a link cut mid-transfer leaves no partial value', async () => {
    const code = await approvedMaterial();
    const messages = await w.messages();
    // The third supplier batch arrives in grams: the whole delivery is refused, none of its lots exists.
    const env = w.envelope('wms.goods_receipt', goodsReceipt(unique('DEL'), code, [['SB-1', 'MFR-A', '1', '1.000'], ['SB-2', 'MFR-A', '1', '2.000']], {}));
    (env['payload'] as { supplierBatches: { quantity: { unit: string } }[] }).supplierBatches.push({ supplierLot: 'SB-3', manufacturerCode: 'MFR-A', containers: '1', quantity: { value: '500', unit: 'g' }, expiryDate: '2030-06-30' } as never);
    env['payloadHash'] = sha(JSON.stringify(env['payload']));
    expect(await refusal(w.inbound(env))).toMatch(/EBMR-SITE-915 supplier batch SB-3 is in g/);
    expect([await lotsOf(code), await w.messages()]).toEqual([0, messages]);
    // The connection drops after the message and two lots were written: the transaction never commits, nothing stays.
    const cut = w.envelope('wms.goods_receipt', goodsReceipt(unique('DEL'), code, [['SB-4', 'MFR-A', '1', '1.000'], ['SB-5', 'MFR-A', '1', '1.000']]));
    await expect(withCommand(db.app, { ...w.adapter, correlationId: randomUUID() }, async (c) => {
      await c.query('select site.erp_wms_receive($1::jsonb)', [JSON.stringify(cut)]);
      throw new Error('link cut mid-transfer');
    })).rejects.toThrow(/link cut/);
    expect([await lotsOf(code), await w.messages()]).toEqual([0, messages]);
    // The adapter retries the same envelope: received once, whole.
    expect((await w.inbound(cut)).outcome).toBe('ACCEPTED');
    expect(await lotsOf(code)).toBe(2);
  });

  it('[DI-31] every accepted value keeps source system, record id, timestamp, raw value and unit', async () => {
    const code = await approvedMaterial();
    const env = w.envelope('wms.goods_receipt', goodsReceipt(unique('DEL'), code, [['SB-P', 'MFR-A', '3', '12.0500']]));
    const r = await w.inbound(env);
    const { rows } = await db.app.query(
      `select m.source_system, m.source_record_id, (extract(epoch from m.source_timestamp) * 1000000)::bigint::text as ts, m.payload_hash,
              r.received_value, r.received_unit, l.received_quantity::text as stored
         from site.lot_receipt r join platform.inbound_message m on m.id = r.inbound_message_id join site.material_lot l on l.id = r.lot_id
        where m.id = $1`, [r.messageId]);
    expect(rows).toEqual([{ source_system: 'ERP_WMS', source_record_id: env['sourceRecordId'], ts: env['sourceTimestamp'], payload_hash: env['payloadHash'],
                            received_value: '12.0500', received_unit: 'kg', stored: '12.0500' }]);
  });
});

describe('the lot-status mirror fails closed (DI-31, INV-26)', () => {
  it('[DI-31] stale ERP lot-status mirror: a reservation is refused and names the mirror; a WMS block or a missing status refuses issue; a late status is STALE', async () => {
    const lot = await w.releasedLot('API');
    const batch = await w.batch(['IN']);
    await w.setting('integration.mode.erp_lot_status', 'MIRROR');
    try {
      expect(await refusal(w.reserve(lot.lotId, batch, '1'))).toMatch(/EBMR-INT-010 the ERP_WMS mirror ERP_LOT_STATUS is stale: it has never synchronised/);
      await w.sync('ERP_LOT_STATUS');
      expect(await refusal(w.reserve(lot.lotId, batch, '1'))).toMatch(/EBMR-SITE-922 the WMS has not reported a status for lot/);
      const status = (s: string, ts: string) => w.envelope('wms.lot_status', { lotNumber: lot.lotCode, status: s }, { sourceTimestamp: ts });
      await w.inbound(status('BLOCKED', '1800000100000000'));
      expect(await refusal(w.reserve(lot.lotId, batch, '1'))).toMatch(/EBMR-SITE-922 the WMS holds lot .* as BLOCKED/);
      await w.inbound(status('RELEASED', '1800000200000000'));
      const reservation = await w.reserve(lot.lotId, batch, '2');
      // A status older than the one held never overwrites it.
      const late = await w.deliver(status('BLOCKED', '1800000150000000'), 'STALE');
      expect(late).toMatchObject({ ok: false, code: 'EBMR-ERP-004' });
      expect(await w.alarms('STALE')).toBe(1);
      // The heartbeat stops while the data stays: after the bound, consumption fails closed too.
      await db.admin.query("update platform.mirror_sync set last_synced_at = last_synced_at - interval '2 hours' where data_class = 'ERP_LOT_STATUS'");
      expect(await refusal(w.consume(batch, reservation, lot.materialCode, '1'))).toMatch(/EBMR-INT-010 the ERP_WMS mirror ERP_LOT_STATUS is stale: last synchronised 720\d s ago/);
      await w.sync('ERP_LOT_STATUS');
      await w.consume(batch, reservation, lot.materialCode, '1').catch((e: unknown) => {
        // consumption needs a batch entry naming it (recipe-core 0700); the mirror no longer stops it
        expect(String(e)).not.toMatch(/EBMR-INT-010|EBMR-SITE-922/);
      });
    } finally {
      await w.setting('integration.mode.erp_lot_status', 'STAND_IN');
    }
    // In STAND_IN the eBMR's own status is authoritative: no mirror is read.
    expect(await w.reserve(lot.lotId, batch, '1')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('masters and orders through the domain commands (DI-31, PR-17)', () => {
  it('[DI-31][PR-17] ERP masters and production orders reach the eBMR only through the domain commands, with their checks', async () => {
    const code = unique('MEXC');
    const mat = await w.inbound(w.envelope('erp.material_master', { materialCode: code, name: 'Lactose monohydrate', baseUnit: 'kg', materialKind: 'EXCIPIENT', maxRetestMonths: '36' }));
    const versionId = (mat.applied as { versionId: string }).versionId;
    // A new material takes effect only once QA confirms it (site services 0802).
    expect((await db.app.query<{ s: string }>("select site.erp_master_state('MATERIAL', $1) as s", [versionId])).rows[0]?.s).toBe('PENDING');
    const order = await w.inbound(w.envelope('erp.production_order', {
      orderNumber: unique('PO'), productCode: 'PCM500', strength: '500 mg', plannedQuantity: { value: '60.000', unit: 'kg' },
      bom: [{ materialCode: code, quantity: { value: '9.400', unit: 'kg' } }], plannedStart: '1800000000000000',
    }));
    const { rows } = await db.app.query('select site_code, batch_size::text as size, batch_size_unit, bom, erp_reference from site.erp_production_order where id = $1', [(order.applied as { orderId: string }).orderId]);
    expect(rows).toEqual([{ site_code: 'SITE-1', size: '60.000', batch_size_unit: 'kg', bom: [{ materialCode: code, quantity: '9.400', unit: 'kg' }], erp_reference: expect.stringMatching(/^REC-/) }]);
    // An order without its strength is malformed; a product master with a shelf life that is not whole months too.
    expect(await refusal(w.inbound(w.envelope('erp.production_order', { orderNumber: unique('PO'), productCode: 'PCM500', plannedQuantity: { value: '60', unit: 'kg' }, bom: [{ materialCode: code, quantity: { value: '1', unit: 'kg' } }], plannedStart: '1' }))))
      .toMatch(/EBMR-ERP-001 malformed erp.production_order payload/);
    expect(await refusal(w.inbound(w.envelope('erp.product_master', { productCode: 'P9', name: 'X', strength: '5 mg', betaLactam: false, shelfLifeMonths: '2.5' })))).toMatch(/EBMR-ERP-001/);
    // An adapter registered for the ERP/WMS whose account lacks the ERP role posts no master (DI-17).
    const plain = await integrationActor(db, 'ERP adapter without the role');
    await registerAdapter(db, plain, 'ERP_WMS', 'ERPPLAIN');
    expect(await refusal(w.inbound(w.envelope('erp.material_master', { materialCode: unique('M'), name: 'X', baseUnit: 'kg', materialKind: 'API' }), plain))).toMatch(/EBMR-(IAM|PLAT)-\d{3}/);
  });
});

describe('integration identities (DI-20, DI-14)', () => {
  it('[DI-20][DI-14] only the registered ERP_WMS adapter receives and delivers ERP/WMS messages, and it never issues stock', async () => {
    const stranger = await integrationActor(db, 'Unregistered ERP', 'ERP_WMS_INTERFACE');
    expect(await refusal(w.inbound(w.envelope('wms.lot_status', { lotNumber: 'X', status: 'RELEASED' }), stranger))).toMatch(/EBMR-INT-002/);
    expect(await refusal(withCommand(db.app, { ...stranger, correlationId: randomUUID() }, (c) => c.query('select site.erp_outbound_pending(10)')))).toMatch(/EBMR-INT-002/);
    const qms = await integrationActor(db, 'QMS adapter');
    await registerAdapter(db, qms, 'QMS', 'QMS');
    expect(await refusal(withCommand(db.app, { ...qms, correlationId: randomUUID() }, (c) => c.query('select site.erp_outbound_pending(10)')))).toMatch(/EBMR-ERP-010/);
    expect(await refusal(w.inbound(w.envelope('wms.lot_status', { lotNumber: 'X', status: 'RELEASED' }), qms))).toMatch(/EBMR-INT-003/);
    // The adapter holds MATERIAL.HANDLE to receive, but a reservation is a person's act.
    const lot = await w.releasedLot('API');
    const batch = await w.batch(['IN']);
    const at = await w.isoIn(3600);
    expect(await refusal(withCommand(db.app, { ...w.adapter, correlationId: randomUUID() }, (c) =>
      c.query("select site.reserve_lot($1, $2, $3, 'TABLETS', 1, 'kg', $4)", [lot.lotId, batch.id, batch.number, at])))).toMatch(/EBMR-SITE-924 material is reserved and issued by a person; a INTEGRATION account never issues stock/);
  });
});

describe('the outbound queue to the ERP (DI-31)', () => {
  it('[DI-31] a stock block reaches the ERP through the adapter; a failed delivery raises an alarm and stays pending, never dropped; a second acknowledgment changes nothing', async () => {
    const lot = await w.releasedLot('API');
    const pending = async (): Promise<{ messageId: string; topic: string; payload: Record<string, unknown>; attempts: string }[]> =>
      withCommand(db.app, { ...w.adapter, correlationId: randomUUID() }, async (c) => (await c.query<{ r: never[] }>('select site.erp_outbound_pending(1000) as r')).rows[0]?.r ?? []);
    // The lot's release was announced (erp.lot_status), in the transaction of the release.
    expect((await pending()).filter((m) => m.topic === 'erp.lot_status' && m.payload['lotNumber'] === lot.lotCode).map((m) => m.payload['status'])).toEqual(['RELEASED']);
    // A stock block request (written by the after-release acts, owner code) joins the queue.
    const c = await db.admin.connect();
    let request = '';
    try {
      await c.query('begin');
      await c.query(`select kernel.set_actor_context(jsonb_build_object('person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
        'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM', 'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
        'legal_name', 'Test fixture (after-release act)', 'reason_code', 'TEST', 'reason_text', 'a stock block as the suspension writes it'))`);
      request = (await c.query<{ id: string }>("select site.request_erp_stock_block($1, 'BLOCK', $2, '{}'::jsonb) as id", [lot.lotId, `SUSPENSION/${randomUUID()}`])).rows[0]?.id ?? '';
      await c.query('commit');
    } finally {
      c.release();
    }
    const block = (await pending()).find((m) => m.topic === 'erp.stock_block' && m.payload['requestId'] === request);
    if (!block) throw new Error('the stock block is not pending');
    const run = <T>(sql: string, params: unknown[]) =>
      withCommand(db.app, { ...w.adapter, correlationId: randomUUID() }, async (x) => (await x.query<{ r: T }>(sql, params)).rows[0]?.r as T);
    const alarms = await w.alarms('TRANSPORT');
    expect(await run<number>('select site.erp_outbound_failed($1, $2) as r', [block.messageId, 'connect ECONNREFUSED'])).toBe(1);
    expect(await run<number>('select site.erp_outbound_failed($1, $2) as r', [block.messageId, 'timeout'])).toBe(2);
    expect(await w.alarms('TRANSPORT')).toBe(alarms + 1);
    expect((await pending()).find((m) => m.messageId === block.messageId)?.attempts).toBe('2');
    expect(await run<boolean>('select site.erp_outbound_delivered($1, $2) as r', [block.messageId, 'ERP-ACK-1'])).toBe(true);
    expect(await run<boolean>('select site.erp_outbound_delivered($1, $2) as r', [block.messageId, 'ERP-ACK-1'])).toBe(false);
    expect((await pending()).some((m) => m.messageId === block.messageId)).toBe(false);
    expect((await db.app.query('select site.erp_stock_state($1) as s', [lot.lotId])).rows[0]).toEqual({ s: 'BLOCKED' });
    expect(await run<number>('select site.erp_outbound_failed($1, $2) as r', [block.messageId, 'late'])).toBe(0);
    // Neither the queue nor its deliveries are written by the application directly.
    expect(await refusal(db.app.query("insert into site.erp_outbound_delivery (message_id) values ($1)", [block.messageId]))).toMatch(/permission denied/);
    expect(await refusal(db.app.query('delete from site.erp_outbound_message'))).toMatch(/permission denied/);
    expect(await refusal(run('select site.erp_outbound_pending($1) as r', [0]))).toMatch(/EBMR-ERP-011/);
  });
});
