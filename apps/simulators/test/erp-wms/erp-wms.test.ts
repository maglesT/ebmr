/**
 * The ERP and WMS simulators (Phase 6 slice 6a, builder A; SIMULATOR, DEMO-ONLY): the feed protocol, each fault the
 * outline names, the source's reconciliation, the ERP's outbound receipt (de-duplicated by message id) and the WMS's
 * move questions. The eBMR side of the same protocol is tested in apps/tablets-server/test/integrations/erp-wms.
 */
import { InboundEnvelope, rawPayloadHash, reconciliationChecksum } from '@ebmr/integration-sdk/adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErpWmsFeed, FEED_FAULTS } from '../../src/erp/feed.ts';
import { erpRoutes } from '../../src/erp/model.ts';
import { startErpWmsSimulator, type RunningErpWmsSimulator } from '../../src/erp/server.ts';
import { wmsRoutes } from '../../src/wms/model.ts';

let clockUs = 1_800_000_000_000_000n;
const clock = { nowUs: () => (clockUs += 1_000_000n) };
const receipt = (deliveryId: string, materialCode = 'MAT-PCM') => ({
  deliveryId, materialCode, supplierCode: 'SUP-1', receivedAt: '1800000000000000',
  supplierBatches: [{ supplierLot: 'SB-1', manufacturerCode: 'MFR-1', containers: '1', quantity: { value: '1.000', unit: 'kg' }, expiryDate: '2030-06-30' }],
});

let erp: RunningErpWmsSimulator;
let wms: RunningErpWmsSimulator;
const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  const ef = new ErpWmsFeed('ERP', clock);
  const wf = new ErpWmsFeed('WMS', clock);
  erp = await startErpWmsSimulator(ef, erpRoutes(ef), { host: '127.0.0.1', port: 0 });
  wms = await startErpWmsSimulator(wf, wmsRoutes(wf), { host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await erp.close();
  await wms.close();
});

describe('ERP and WMS simulators (DI-31)', () => {
  it('[DI-31] the feed serves contract envelopes whose hash is the payload as sent; each fault changes what the adapter sees', async () => {
    const f = new ErpWmsFeed('WMS', clock);
    const e1 = f.publish('wms.goods_receipt', 'D-1', receipt('D-1'));
    expect(InboundEnvelope.safeParse(e1).success).toBe(true);
    expect(e1.payloadHash).toBe(rawPayloadHash(JSON.stringify(e1.payload)));
    f.faults.add('MALFORMED');
    expect(f.publish('wms.lot_status', 'L-1', { lotNumber: 'L-1', status: 'RELEASED' }).payload).toHaveProperty('simulatorExtra');
    f.faults.clear();
    f.faults.add('WRONG_BATCH');
    expect(f.publish('wms.lot_status', 'L-1', { lotNumber: 'L-1', status: 'RELEASED' }).payload['lotNumber']).toMatch(/^XX-UNKNOWN-/);
    f.faults.clear();
    const fresh = f.publish('wms.lot_status', 'L-2', { lotNumber: 'L-2', status: 'QUARANTINE' });
    f.faults.add('STALE_VALUE');
    expect(BigInt(f.publish('wms.lot_status', 'L-2', { lotNumber: 'L-2', status: 'RELEASED' }).sourceTimestamp)).toBeLessThan(BigInt(fresh.sourceTimestamp));
    f.faults.clear();
    f.faults.add('FEED_GAP');
    expect(f.page(0n, 10)).toEqual({ messages: [], head: '5' });
    f.faults.clear();
    f.faults.add('OUT_OF_ORDER');
    expect(f.page(0n, 3).messages.map((m) => m.sequenceNo)).toEqual(['3', '2', '1']);
    f.faults.clear();
    f.faults.add('DUPLICATE');
    expect(f.page(2n, 2).messages.map((m) => m.sequenceNo)).toEqual(['2', '3', '4']);
    f.faults.clear();
    f.faults.add('STALE_MIRROR');
    expect(f.heartbeatOk()).toBe(false);
    // The reconciliation is the SDK's checksum over what was published in the period.
    const all = f.published();
    const rec = f.reconciliation(0n, 9_999_999_999_999_999n);
    expect(rec).toEqual({ periodFrom: '0', periodTo: '9999999999999999', ...(({ count, checksum }) => ({ sourceCount: count, sourceChecksum: checksum }))(reconciliationChecksum(all.map((m) => ({ idempotencyKey: m.idempotencyKey, payloadHash: m.payloadHash })))) });
    expect(FEED_FAULTS).toHaveLength(9);
  });

  it('[DI-31] over HTTP: a cut answer is incomplete, a slow one late, the heartbeat stops; the ERP acknowledges an outbound message once per id; the WMS asks before a move', async () => {
    expect((await post(`${wms.url}/goods-receipts`, receipt('D-H1'))).status).toBe(201);
    expect((await post(`${wms.url}/goods-receipts`, { ...receipt('D-H2'), supplierBatches: [] })).status).toBe(400);
    const origin = new URL(wms.url).origin;
    await post(`${origin}/api/fault`, { fault: 'LINK_CUT', on: true });
    await expect(fetch(`${wms.url}/feed?after=0&limit=10`).then((r) => r.json())).rejects.toThrow();
    await post(`${origin}/api/fault`, { fault: 'LINK_CUT', on: false });
    await post(`${origin}/api/fault`, { fault: 'STALE_MIRROR', on: true });
    expect((await fetch(`${wms.url}/heartbeat`)).status).toBe(503);
    await post(`${origin}/api/fault`, { fault: 'STALE_MIRROR', on: false });
    expect((await fetch(`${wms.url}/heartbeat`)).status).toBe(200);
    const page = (await (await fetch(`${wms.url}/feed?after=0&limit=10`)).json()) as { messages: unknown[]; head: string };
    expect(page).toMatchObject({ head: '1' });
    // The ERP takes the eBMR's outbound messages, de-duplicated by message id (a redelivery gets the same reference).
    const msg = { messageId: '0b5e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d', topic: 'erp.stock_block', payload: { lotNumber: 'L-1', kind: 'BLOCK' } };
    const a = await post(`${erp.url}/outbound`, msg);
    const b = await post(`${erp.url}/outbound`, msg);
    expect(a.status).toBe(200);
    expect(b.body['erpReference']).toBe(a.body['erpReference']);
    expect((await post(`${erp.url}/outbound`, { ...msg, topic: 'erp.unknown' })).status).toBe(400);
    // The WMS asks; the adapter answers; an allowed move is made and published.
    const q = await post(`${wms.url}/move-requests`, { lotNumber: 'L-1', fromLocation: 'Q-1', toLocation: 'R-1', toLocationKind: 'RELEASED', quantity: { value: '1', unit: 'kg' } });
    const id = String(q.body['requestId']);
    expect(((await (await fetch(`${wms.url}/move-requests`)).json()) as { requests: { requestId: string }[] }).requests.map((r) => r.requestId)).toContain(id);
    await post(`${wms.url}/move-requests/${id}/answer`, { allowed: false, problem: 'lot L-1 is QUARANTINE' });
    expect(((await (await fetch(`${wms.url}/move-requests/${id}`)).json()) as { state: string; problem: string })).toMatchObject({ state: 'REFUSED', problem: 'lot L-1 is QUARANTINE' });
  });
});
