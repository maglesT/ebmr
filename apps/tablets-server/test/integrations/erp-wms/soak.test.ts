/**
 * Soak test of the ERP/WMS adapter (Phase 6 slice 6a, builder A; DI-31 "no silent loss"): for each of the two feeds,
 * every fault of the outline is switched on in turn while the source keeps publishing, the worker keeps cycling, then
 * the fault goes off and the worker catches up. At the end the source's reconciliation of the whole period matches what
 * the eBMR holds (every message accepted once or recorded as refused with its alarm), and the counts agree.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_FAULTS, approvedManufacturer, count, drain, erpWmsRig, goodsReceipt, type ErpWmsRig, type SimProcess } from './support.ts';
import type { AdapterWorker } from '../../../src/features/integrations/adapters/framework.ts';

let rig: ErpWmsRig;
const MATERIAL = `MAT-SOAK-${randomUUID().slice(0, 6).toUpperCase()}`;
let lotCode = '';

beforeAll(async () => {
  rig = await erpWmsRig();
  await rig.erp.sim.publish('/materials', { materialCode: MATERIAL, name: 'Soak API', baseUnit: 'kg', materialKind: 'API' });
  await drain(rig.erp.worker, rig.erp.sim);
  const c = await rig.server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query("insert into site.erp_master_effect (master_kind, master_key, version_id, basis, person_id, account_id) select 'MATERIAL', material_code, id, 'RELEASE_BASELINE', gen_random_uuid(), gen_random_uuid() from site.erp_material where material_code = $1", [MATERIAL]);
    await c.query('commit');
  } finally {
    c.release();
  }
  await approvedManufacturer(rig.server, MATERIAL, 'MFR-SOAK');
  const delivery = `DEL-${randomUUID().slice(0, 8)}`;
  await rig.wms.sim.publish('/goods-receipts', goodsReceipt(delivery, MATERIAL, [['SB-SOAK', 'MFR-SOAK', '1', '100.000']]));
  await drain(rig.wms.worker, rig.wms.sim);
  lotCode = (await rig.server.db.app.query<{ c: string }>('select l.lot_code as c from site.lot_receipt r join site.material_lot l on l.id = r.lot_id where r.delivery_id = $1', [delivery])).rows[0]?.c ?? '';
}, 300_000);
afterAll(async () => {
  await rig?.close();
});

let n = 0;
const next = (): string => `${(n += 1).toString().padStart(4, '0')}${randomUUID().slice(0, 4).toUpperCase()}`;

/** Three messages of the feed's kinds. */
async function publishSome(feed: 'ERP' | 'WMS', sim: SimProcess): Promise<void> {
  if (feed === 'ERP') {
    const k = next();
    await sim.publish('/materials', { materialCode: `MAT-S-${k}`, name: `Soak material ${k}`, baseUnit: 'kg', materialKind: 'EXCIPIENT' });
    await sim.publish('/production-orders', { orderNumber: `PO-S-${k}`, productCode: 'PCM500', strength: '500 mg', plannedQuantity: { value: '60.000', unit: 'kg' }, bom: [{ materialCode: MATERIAL, quantity: { value: '50.000', unit: 'kg' } }], plannedStart: '1800000000000000' });
    await sim.publish('/shipments', { shipmentId: `SH-${k}`, lotNumber: lotCode, consigneeCode: 'C-1', consigneeName: 'Consignee', consigneeAddress: 'Mumbai', quantity: { value: '1.000', unit: 'kg' }, shippedAt: '1800000000000000' });
  } else {
    await sim.publish('/goods-receipts', goodsReceipt(`DEL-S-${next()}`, MATERIAL, [['SB-1', 'MFR-SOAK', '1', '1.000'], ['SB-2', 'MFR-SOAK', '1', '2.000']]));
    await sim.publish('/lot-statuses', { lotNumber: lotCode, status: 'QUARANTINE' });
    await sim.publish('/stock-moves', { lotNumber: lotCode, fromLocation: 'WH-Q-1', toLocation: 'WH-Q-2', toLocationKind: 'QUARANTINE', quantity: { value: '1.000', unit: 'kg' }, movedAt: '1800000000000000' });
  }
}

async function soak(feed: 'ERP' | 'WMS', sim: SimProcess, worker: AdapterWorker, adapter: string): Promise<void> {
  // The period starts now (the set-up's messages are older); the simulator's clock is this machine's.
  await new Promise((r) => setTimeout(r, 20));
  const fromUs = BigInt(Date.now()) * 1000n;
  for (const fault of ALL_FAULTS) {
    await sim.fault(fault, true, fault === 'SLOW' ? 600 : undefined);
    await publishSome(feed, sim);
    for (let i = 0; i < 3; i += 1) await worker.cycle();
    await publishSome(feed, sim);
    await sim.fault(fault, false);
    await drain(worker, sim);
  }
  await new Promise((r) => setTimeout(r, 20));
  const toUs = BigInt(Date.now() + 1000) * 1000n;
  const state = await sim.state<unknown>();
  expect(BigInt(worker.health().cursor)).toBe(BigInt(state.head));
  const { matched } = await worker.reconcile(fromUs, toUs);
  expect(matched).toBe(true);
  // The counts agree: the source's messages of the period are the accepted ones plus the refused ones (distinct keys).
  const r = await rig.server.db.app.query<{ source_count: string; received_count: string; accepted_count: string; refused_count: string }>(
    'select source_count::text, received_count::text, accepted_count::text, refused_count::text from platform.reconciliation_report where adapter_code = $1 order by recorded_at desc limit 1',
    [adapter],
  );
  const row = r.rows[0];
  expect(row?.source_count).toBe(row?.received_count);
  expect(Number(row?.accepted_count) + Number(row?.refused_count)).toBe(Number(row?.source_count));
  expect(Number(row?.source_count)).toBe(ALL_FAULTS.length * 6);
  // Every refusal has its alarm.
  expect(await count(rig.server, "select count(*) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED' and alarm_id is null", [adapter])).toBe(0);
}

describe('soak: every fault in turn, no silent loss (DI-31)', () => {
  it('[DI-31] ERP feed: with each fault switched on in turn the counts reconcile and nothing is lost', async () => {
    await soak('ERP', rig.erp.sim, rig.erp.worker, rig.erp.id.code);
  }, 120_000);

  it('[DI-31] WMS feed: with each fault switched on in turn the counts reconcile and nothing is lost', async () => {
    await soak('WMS', rig.wms.sim, rig.wms.worker, rig.wms.id.code);
  }, 120_000);
});
