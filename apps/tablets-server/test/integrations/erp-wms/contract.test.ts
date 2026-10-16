/**
 * Contract tests of the ERP/WMS adapter against its simulators (Phase 6 slice 6a, builder A; DI-31, PR-17, PR-46,
 * INV-26): the simulators run as their own processes and speak the feed protocol; the workers receive through the
 * database's receiving command under their integration identities. Every fault of the outline is injected at the
 * source; the database's answer (accepted, de-duplicated, refused with an alarm, nothing applied) is read back.
 */
import { randomUUID } from 'node:crypto';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { openPersonaSession, passwordActor } from '@ebmr/test-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withChangeRecord } from '../../../../../packages/kernel/test/support/change-record.ts';
import { approvedManufacturer, count, drain, erpWmsRig, goodsReceipt, type ErpWmsRig } from './support.ts';

/** Asymmetric matchers, typed for the object literals they sit in. */
const matching = (re: RegExp): string => expect.stringMatching(re) as string;

let rig: ErpWmsRig;
const MATERIAL = `MAT-SIM-${randomUUID().slice(0, 6).toUpperCase()}`;

beforeAll(async () => {
  rig = await erpWmsRig();
  // The ERP posts the material through its feed; the QA confirmation of a new master is proven in site services, so the
  // version is put in effect here by the superuser (fixture), with the manufacturer approved.
  expect((await rig.erp.sim.publish('/materials', { materialCode: MATERIAL, name: 'Simulated API', baseUnit: 'kg', materialKind: 'API', maxRetestMonths: '24' })).status).toBe(201);
  await drain(rig.erp.worker, rig.erp.sim);
  const c = await rig.server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(
      "insert into site.erp_master_effect (master_kind, master_key, version_id, basis, person_id, account_id) select 'MATERIAL', material_code, id, 'RELEASE_BASELINE', gen_random_uuid(), gen_random_uuid() from site.erp_material where material_code = $1",
      [MATERIAL],
    );
    await c.query('commit');
  } finally {
    c.release();
  }
  await approvedManufacturer(rig.server, MATERIAL, 'MFR-SIM');
}, 300_000);
afterAll(async () => {
  await rig?.close();
});

const alarms = (adapter: string, kind: string): Promise<number> =>
  count(rig.server, 'select count(*) as n from platform.integration_alarm where adapter_code = $1 and kind = $2', [adapter, kind]);
const lotsOfDelivery = (delivery: string): Promise<number> => count(rig.server, 'select count(*) as n from site.lot_receipt where delivery_id = $1', [delivery]);
async function receiveLot(supplierLot = `SB-${randomUUID().slice(0, 6)}`): Promise<string> {
  const delivery = `DEL-${randomUUID().slice(0, 8)}`;
  await rig.wms.sim.publish('/goods-receipts', goodsReceipt(delivery, MATERIAL, [[supplierLot, 'MFR-SIM', '1', '5.000']]));
  await drain(rig.wms.worker, rig.wms.sim);
  const { rows } = await rig.server.db.app.query<{ lot_code: string }>('select l.lot_code from site.lot_receipt r join site.material_lot l on l.id = r.lot_id where r.delivery_id = $1', [delivery]);
  return rows[0]?.lot_code ?? '';
}

describe('the ERP/WMS adapter against its simulators (DI-31)', () => {
  it('[DI-31][PR-17] contract: a WMS goods receipt with three supplier batches becomes three lots; ERP masters and orders reach the domain commands; the source refuses a body its contract does not allow', async () => {
    const delivery = `DEL-${randomUUID().slice(0, 8)}`;
    expect((await rig.wms.sim.publish('/goods-receipts', goodsReceipt(delivery, MATERIAL, [['SB-1', 'MFR-SIM', '2', '10.000'], ['SB-2', 'MFR-SIM', '2', '10.000'], ['SB-3', 'MFR-SIM', '1', '4.500']]))).status).toBe(201);
    const outcomes = await drain(rig.wms.worker, rig.wms.sim);
    expect(outcomes.map((o) => o.result)).toContain('ACCEPTED');
    expect(await lotsOfDelivery(delivery)).toBe(3);
    const order = `PO-SIM-${randomUUID().slice(0, 6).toUpperCase()}`;
    expect((await rig.erp.sim.publish('/production-orders', { orderNumber: order, productCode: 'PCM500', strength: '500 mg', plannedQuantity: { value: '60.000', unit: 'kg' }, bom: [{ materialCode: MATERIAL, quantity: { value: '50.000', unit: 'kg' } }], plannedStart: '1800000000000000' })).status).toBe(201);
    await drain(rig.erp.worker, rig.erp.sim);
    expect(await count(rig.server, 'select count(*) as n from site.erp_production_order where order_no = $1 and site_code = $2', [order, 'SITE-1'])).toBe(1);
    // The simulator checks its own bodies with the same contract (a value as a JSON number is refused at the source).
    expect((await rig.erp.sim.publish('/production-orders', { orderNumber: 'X', productCode: 'P', strength: '1 mg', plannedQuantity: { value: 60, unit: 'kg' }, bom: [], plannedStart: '1' })).status).toBe(400);
    expect(rig.wms.worker.health()).toMatchObject({ state: 'IDLE', lastError: null });
  });

  it('[DI-31] a malformed, a duplicate, an out-of-order and a wrong-batch ERP message are each refused or de-duplicated with an alarm', async () => {
    const code = rig.wms.id.code;
    const lot = await receiveLot();
    const status = (s: string) => rig.wms.sim.publish('/lot-statuses', { lotNumber: lot, status: s });
    // Malformed: the payload carries a field the contract does not know.
    const malformedBefore = await alarms(code, 'MALFORMED');
    await rig.wms.sim.fault('MALFORMED', true);
    await status('QUARANTINE');
    await rig.wms.sim.fault('MALFORMED', false);
    expect((await drain(rig.wms.worker, rig.wms.sim)).filter((o) => o.result === 'REFUSED').map((o) => o.errorClass)).toEqual(['MALFORMED']);
    expect(await alarms(code, 'MALFORMED')).toBe(malformedBefore + 1);
    // Duplicate: every page repeats the last message handled: de-duplicated, no second row, no alarm.
    const messages = await count(rig.server, 'select count(*) as n from platform.inbound_message where adapter_code = $1', [code]);
    await rig.wms.sim.fault('DUPLICATE', true);
    await status('QUARANTINE');
    const dup = await drain(rig.wms.worker, rig.wms.sim);
    await rig.wms.sim.fault('DUPLICATE', false);
    expect(dup.map((o) => o.result)).toEqual(['DUPLICATE', 'ACCEPTED']);
    expect(await count(rig.server, 'select count(*) as n from platform.inbound_message where adapter_code = $1', [code])).toBe(messages + 1);
    // Stale value: a status older than the one held is refused, never applied over the newer one.
    const staleBefore = await alarms(code, 'STALE');
    await rig.wms.sim.fault('STALE_VALUE', true);
    await status('RELEASED');
    await rig.wms.sim.fault('STALE_VALUE', false);
    expect((await drain(rig.wms.worker, rig.wms.sim)).filter((o) => o.result === 'REFUSED').map((o) => o.code)).toEqual(['EBMR-ERP-004']);
    expect(await alarms(code, 'STALE')).toBe(staleBefore + 1);
    // Out of order: a page arrives reversed: every message is accepted, the late ones with an alarm.
    const lateBefore = await alarms(code, 'OUT_OF_ORDER');
    await rig.wms.sim.fault('OUT_OF_ORDER', true);
    const deliveries = [1, 2, 3].map(() => `DEL-${randomUUID().slice(0, 8)}`);
    for (const d of deliveries) await rig.wms.sim.publish('/goods-receipts', goodsReceipt(d, MATERIAL, [['SB-O', 'MFR-SIM', '1', '1.000']]));
    await drain(rig.wms.worker, rig.wms.sim);
    await rig.wms.sim.fault('OUT_OF_ORDER', false);
    expect(await alarms(code, 'OUT_OF_ORDER')).toBe(lateBefore + 2);
    for (const d of deliveries) expect(await lotsOfDelivery(d)).toBe(1);
    // Wrong batch: the message names a lot the eBMR does not hold.
    const wrongBefore = await alarms(code, 'WRONG_IDENTITY');
    await rig.wms.sim.fault('WRONG_BATCH', true);
    await status('RELEASED');
    await rig.wms.sim.fault('WRONG_BATCH', false);
    expect((await drain(rig.wms.worker, rig.wms.sim)).filter((o) => o.result === 'REFUSED').map((o) => [o.errorClass, o.code])).toEqual([['WRONG_IDENTITY', 'EBMR-ERP-002']]);
    expect(await alarms(code, 'WRONG_IDENTITY')).toBe(wrongBefore + 1);
    const held = await rig.server.db.app.query<{ status: string }>('select (site.erp_lot_status_latest(l.id)).status from site.material_lot l where l.lot_code = $1', [lot]);
    expect(held.rows[0]?.status).toBe('QUARANTINE');
  });

  it('[DI-31] a link cut mid-transfer, a late answer and a feed gap leave no partial value; the message is delivered once when the link is back', async () => {
    const refusals = () => count(rig.server, "select count(*) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED'", [rig.wms.id.code]);
    const refusedBefore = await refusals();
    for (const fault of ['LINK_CUT', 'SLOW', 'FEED_GAP'] as const) {
      const delivery = `DEL-${randomUUID().slice(0, 8)}`;
      await rig.wms.sim.fault(fault, true, fault === 'SLOW' ? 600 : undefined);
      await rig.wms.sim.publish('/goods-receipts', goodsReceipt(delivery, MATERIAL, [['SB-A', 'MFR-SIM', '1', '1.000'], ['SB-B', 'MFR-SIM', '1', '1.000']]));
      const r = await rig.wms.worker.cycle();
      if (fault === 'FEED_GAP') expect(r).toMatchObject({ received: 0, stoppedBy: null });
      else expect(r.stoppedBy?.kind).toBe('TRANSPORT');
      expect(await lotsOfDelivery(delivery)).toBe(0);
      await rig.wms.sim.fault(fault, false);
      if (fault !== 'FEED_GAP') expect(rig.wms.worker.health().state).toBe('RETRYING');
      await drain(rig.wms.worker, rig.wms.sim);
      expect(await lotsOfDelivery(delivery)).toBe(2);
    }
    // The transport failures were retried, never recorded as refusals.
    expect(await refusals()).toBe(refusedBefore);
  });

  it('[DI-31] a feed gap keeps the mirror from looking fresh: the sync is recorded only when the worker is caught up with the source', async () => {
    const synced = async () => (await rig.server.db.admin.query<{ t: string | null }>("select last_synced_at::text as t from platform.mirror_sync where data_class = 'ERP_LOT_STATUS'")).rows[0]?.t ?? null;
    await drain(rig.wms.worker, rig.wms.sim);
    const before = await synced();
    await rig.wms.sim.fault('FEED_GAP', true);
    await rig.wms.sim.publish('/lot-statuses', { lotNumber: 'ANY', status: 'RELEASED' });
    const r = await rig.wms.worker.cycle();
    expect(r).toMatchObject({ heartbeat: true, caughtUp: false, received: 0 });
    expect(await synced()).toBe(before);
    await rig.wms.sim.fault('FEED_GAP', false);
    await drain(rig.wms.worker, rig.wms.sim);
    expect((await rig.wms.worker.cycle()).caughtUp).toBe(true);
    expect(await synced()).not.toBe(before);
  });

  it('[DI-31] stale mirror: the WMS heartbeat stops while its data still arrives; after the bound a reservation is refused and names the mirror', async () => {
    const server = rig.server;
    const owner = await passwordActor(server.db, server.seed.bootstrap.owner, server.seed.bootstrap.owner.fingerprint);
    const setMode = async (mode: string) => withCommand(server.db.app, await withChangeRecord(server.db, { ...owner, reasonCode: 'TEST', reasonText: 'mirror the lot status from the WMS', correlationId: randomUUID() }), (c) =>
      c.query("select platform.set_setting('integration.mode.erp_lot_status', $1)", [mode]));
    // A released lot of the material, complete receipt, the WMS holding it RELEASED.
    const lot = await receiveLot();
    const lotId = (await server.db.app.query<{ id: string }>('select id from site.material_lot where lot_code = $1', [lot])).rows[0]?.id ?? '';
    const c = await server.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query("update platform.aggregate_state set state = 'RELEASED', version = version + 1 where aggregate_type = 'material_lot' and aggregate_id = $1", [lotId]);
      await c.query("insert into site.lot_receipt_examination (lot_id, containers_examined, outcome, examined_by_person, examined_by_account) values ($1, 1, 'ACCEPTABLE', gen_random_uuid(), gen_random_uuid())", [lotId]);
      await c.query('commit');
    } finally {
      c.release();
    }
    await rig.wms.sim.publish('/lot-statuses', { lotNumber: lot, status: 'RELEASED' });
    await drain(rig.wms.worker, rig.wms.sim);
    const stores: ActorContext = await openPersonaSession(server.db, server.seed, 'stores');
    const reserve = () => withCommand(server.db.app, { ...stores, correlationId: randomUUID() }, (x) =>
      x.query("select site.reserve_lot($1, $2, 'B-SIM-0001', 'TABLETS', 1, 'kg', clock_timestamp() + interval '1 hour')", [lotId, randomUUID()]));
    await setMode('MIRROR');
    try {
      await reserve();
      // The heartbeat stops; data still flows (a status arrives), but the mirror ages past its bound.
      await rig.wms.sim.fault('STALE_MIRROR', true);
      await rig.wms.sim.publish('/lot-statuses', { lotNumber: lot, status: 'RELEASED' });
      const r = await rig.wms.worker.cycle();
      expect(r).toMatchObject({ heartbeat: false, stoppedBy: null });
      expect(r.outcomes.map((o) => o.result)).toEqual(['ACCEPTED']);
      await server.db.admin.query("update platform.mirror_sync set last_synced_at = last_synced_at - interval '2 hours' where data_class = 'ERP_LOT_STATUS'");
      await expect(reserve()).rejects.toThrow(/EBMR-INT-010 the ERP_WMS mirror ERP_LOT_STATUS is stale: last synchronised 720\d s ago/);
      // The heartbeat comes back: the mirror is fresh again.
      await rig.wms.sim.fault('STALE_MIRROR', false);
      expect((await rig.wms.worker.cycle()).heartbeat).toBe(true);
      await reserve();
    } finally {
      await setMode('STAND_IN');
    }
  });

  it('[DI-31] outbound: a stock block reaches the ERP once; a cut link raises a transport alarm and the message waits, never dropped', async () => {
    const server = rig.server;
    const lot = await receiveLot();
    const lotId = (await server.db.app.query<{ id: string }>('select id from site.material_lot where lot_code = $1', [lot])).rows[0]?.id ?? '';
    const c = await server.db.admin.connect();
    let request = '';
    try {
      await c.query('begin');
      await c.query(`select kernel.set_actor_context(jsonb_build_object('person_id', '00000000-0000-0000-0000-000000000000', 'account_id', '00000000-0000-0000-0000-000000000000',
        'role_code', 'SOFTWARE_RELEASE', 'session_id', '00000000-0000-0000-0000-000000000000', 'source', 'SYSTEM', 'site_zone', 'UTC', 'correlation_id', gen_random_uuid(),
        'legal_name', 'Test fixture (after-release act)', 'reason_code', 'TEST', 'reason_text', 'a stock block as the suspension writes it'))`);
      request = (await c.query<{ id: string }>("select site.request_erp_stock_block($1, 'BLOCK', $2, '{}'::jsonb) as id", [lotId, `SUSPENSION/${randomUUID()}`])).rows[0]?.id ?? '';
      await c.query('commit');
    } finally {
      c.release();
    }
    const transportBefore = await alarms(rig.erp.id.code, 'TRANSPORT');
    await rig.erp.sim.fault('LINK_CUT', true);
    await rig.erp.worker.cycle();
    await rig.erp.sim.fault('LINK_CUT', false);
    const pendingOf = () => count(server, `select count(*) as n from site.erp_outbound_message m where m.payload ->> 'requestId' = $1
                                                and not exists (select 1 from site.erp_outbound_delivery d where d.message_id = m.id)`, [request]);
    expect(await pendingOf()).toBe(1);
    expect(await alarms(rig.erp.id.code, 'TRANSPORT')).toBeGreaterThan(transportBefore);
    // After the back-off (1 s for the first attempt) the message goes again and is acknowledged once.
    await new Promise((r) => setTimeout(r, 1100));
    await rig.erp.worker.cycle();
    expect(await pendingOf()).toBe(0);
    const erp = await rig.erp.sim.state<{ outbound: { topic: string; payload: Record<string, unknown>; deliveries: number }[] }>();
    const blocks = erp.model.outbound.filter((o) => o.topic === 'erp.stock_block' && o.payload['requestId'] === request);
    expect(blocks).toHaveLength(1);
    expect((await server.db.app.query('select site.erp_stock_state($1) as s', [lotId])).rows[0]).toEqual({ s: 'BLOCKED' });
  });

  it('[PR-46] the WMS asks before a move: a quarantined lot is refused a released-stock location; a move made without asking raises the alarm and the exception', async () => {
    const server = rig.server;
    const lot = await receiveLot();
    const ask = async (lotNumber: string, kind: string) =>
      ((await rig.wms.sim.publish('/move-requests', { lotNumber, fromLocation: 'WH-QRT-01', toLocation: 'WH-RLS-01', toLocationKind: kind, quantity: { value: '5.000', unit: 'kg' } })).body as { requestId: string }).requestId;
    const refused = await ask(lot, 'RELEASED');
    const allowed = await ask(lot, 'REJECTED');
    await rig.wms.worker.cycle();
    const moves = (await rig.wms.sim.state<{ moves: { requestId: string; state: string; problem: string | null }[] }>()).model.moves;
    expect(moves.find((m) => m.requestId === refused)).toMatchObject({ state: 'REFUSED', problem: matching(/is QUARANTINE: it may go only to a QUARANTINE, REJECTED, RETURNS location, not to RELEASED \(PR-46\)/) });
    expect(moves.find((m) => m.requestId === allowed)?.state).toBe('MOVED');
    await drain(rig.wms.worker, rig.wms.sim);
    expect(await count(server, "select count(*) as n from site.lot_location_move m join site.material_lot l on l.id = m.lot_id where l.lot_code = $1 and m.to_kind = 'REJECTED' and m.problem is null", [lot])).toBe(1);
    // The WMS moves the lot to released stock without asking: recorded with the alarm and the exception linked to the lot.
    await rig.wms.sim.publish('/stock-moves', { lotNumber: lot, fromLocation: 'WH-REJ-01', toLocation: 'WH-RLS-02', toLocationKind: 'RELEASED', quantity: { value: '5.000', unit: 'kg' }, movedAt: '1800000000000000' });
    await drain(rig.wms.worker, rig.wms.sim);
    expect(await count(server, 'select count(*) as n from site.lot_location_exception e join site.material_lot l on l.id = e.lot_id where l.lot_code = $1', [lot])).toBe(1);
    expect(await count(server, "select count(*) as n from platform.integration_alarm where adapter_code = $1 and kind = 'OUT_OF_RANGE' and details ->> 'rule' = 'PR-46'", [rig.wms.id.code])).toBeGreaterThanOrEqual(1);
  });
});
