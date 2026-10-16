import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { L3_POOLS_PATH, PoolReport, PoolResponse, l3PoolEventsPath, l3PoolReportPath, reportReconciles, type PoolRequest, type SerialEvent } from '@ebmr/integration-sdk/serialisation';
import { L3Refusal, L3Stub, SERIAL_LENGTH, type L3Clock } from '../../src/serialisation/model.ts';
import { startL3Stub, type RunningL3Stub } from '../../src/serialisation/server.ts';

const EU_GTIN = '08901234567890';
const US_GTIN = '00312345678906';
const clock: L3Clock = { nowUs: () => 1_790_584_618_000_000n };
const request = (over: Partial<PoolRequest> = {}): PoolRequest => ({ packagingOrder: 'PO-1', market: 'EU_FMD', gtin: EU_GTIN, quantity: '5', ...over });
const at = '1790584618000001';

describe('serialisation L3 stub model', () => {
  it('issues a pool of unique serials, deterministic under the seed; the same request again answers the same pool', () => {
    const a = new L3Stub({ seed: 42, clock });
    const pool = a.issue(request());
    expect(PoolResponse.safeParse(pool).success).toBe(true);
    expect(pool.poolId).toBe('POOL-000001');
    expect(pool.issuedAt).toBe('1790584618000000');
    expect(pool.serials).toHaveLength(5);
    expect(new Set(pool.serials).size).toBe(5);
    for (const s of pool.serials) expect(s).toMatch(new RegExp(`^[0-9A-HJ-NP-Z]{${SERIAL_LENGTH}}$`));
    expect(new L3Stub({ seed: 42, clock }).issue(request())).toEqual(pool);
    expect(new L3Stub({ seed: 43, clock }).issue(request()).serials).not.toEqual(pool.serials);
    expect(a.issue(request())).toEqual(pool);
    const second = a.issue(request({ quantity: '3' }));
    expect(second.poolId).toBe('POOL-000002');
    expect(second.serials.some((s) => pool.serials.includes(s))).toBe(false);
  });

  it('applies the market pool rules: no pool for the batch-level India H2 code, a US GTIN must carry the NDC', () => {
    const l3 = new L3Stub({ seed: 1, clock });
    expect(() => l3.issue(request({ market: 'IN_H2' }))).toThrow(L3Refusal);
    expect(() => l3.issue(request({ market: 'US_DSCSA' }))).toThrow(/NDC/);
    expect(l3.issue(request({ market: 'US_DSCSA', gtin: US_GTIN })).serials).toHaveLength(5);
  });

  it('[PR-42] reports zero unexplained only when every serial has a final state; the report hash is stable and moves with a state', () => {
    const l3 = new L3Stub({ seed: 42, clock });
    const { poolId, serials } = l3.issue(request());
    const [s0, s1, s2, s3, s4] = serials as [string, string, string, string, string];
    const fresh = l3.report(poolId);
    expect(fresh).toMatchObject({ counts: { issued: '5', COMMISSIONED: '0' }, unexplained: '5' });
    l3.applyEvents(poolId, [
      { serial: s0, state: 'COMMISSIONED', at },
      { serial: s1, state: 'COMMISSIONED', at },
      { serial: s1, state: 'SAMPLE', at },
      { serial: s2, state: 'COMMISSIONED', at },
      { serial: s2, state: 'DECOMMISSIONED', at },
      { serial: s2, state: 'DESTROYED', at },
      { serial: s3, state: 'UNUSED_RETURNED', at },
    ]);
    const partial = l3.report(poolId);
    expect(partial.unexplained).toBe('1');
    expect(reportReconciles(partial)).toBe(false);
    expect(l3.report(poolId)).toEqual(partial); // nothing changed: the same hash
    l3.applyEvents(poolId, [{ serial: s4, state: 'DESTROYED', at }]);
    const closed = l3.report(poolId);
    expect(PoolReport.safeParse(closed).success).toBe(true);
    expect(closed).toMatchObject({ counts: { issued: '5', COMMISSIONED: '1', DECOMMISSIONED: '0', DESTROYED: '2', SAMPLE: '1', UNUSED_RETURNED: '1' }, unexplained: '0' });
    expect(reportReconciles(closed)).toBe(true);
    expect(closed.reportHash).not.toBe(partial.reportHash);
    // The same pool in the same states on another run gives the same hash.
    const other = new L3Stub({ seed: 42, clock });
    other.issue(request());
    other.applyEvents(poolId, [
      { serial: s4, state: 'DESTROYED', at: '1' },
      { serial: s3, state: 'UNUSED_RETURNED', at: '2' },
      { serial: s2, state: 'COMMISSIONED', at: '3' },
      { serial: s2, state: 'DECOMMISSIONED', at: '3' },
      { serial: s2, state: 'DESTROYED', at: '3' },
      { serial: s1, state: 'COMMISSIONED', at: '4' },
      { serial: s1, state: 'SAMPLE', at: '4' },
      { serial: s0, state: 'COMMISSIONED', at: '5' },
    ]);
    expect(other.report(poolId).reportHash).toBe(closed.reportHash);
  });

  it('takes an events request whole or refuses it whole: an unknown serial or a forbidden change leaves every state as it was; a repeat is a no-op', () => {
    const l3 = new L3Stub({ seed: 42, clock });
    const { poolId, serials } = l3.issue(request());
    const [s0, s1] = serials as [string, string];
    const before = l3.report(poolId);
    expect(() => l3.applyEvents(poolId, [{ serial: s0, state: 'COMMISSIONED', at }, { serial: 'NOT-OURS', state: 'COMMISSIONED', at }])).toThrow(/not a serial/);
    expect(() => l3.applyEvents(poolId, [{ serial: s0, state: 'COMMISSIONED', at }, { serial: s1, state: 'SAMPLE', at }])).toThrow(/cannot go from ISSUED to SAMPLE/);
    expect(l3.report(poolId)).toEqual(before);
    l3.applyEvents(poolId, [{ serial: s0, state: 'COMMISSIONED', at }]);
    l3.applyEvents(poolId, [{ serial: s0, state: 'COMMISSIONED', at }]);
    expect(l3.report(poolId).counts.COMMISSIONED).toBe('1');
    expect(() => l3.applyEvents('POOL-999999', [{ serial: s0, state: 'COMMISSIONED', at }])).toThrow(/no pool/);
  });

  it('D-S4-3: rejecting a lot opens one decommissioning task for its commissioned serials', () => {
    const l3 = new L3Stub({ seed: 42, clock });
    const { poolId, serials } = l3.issue(request());
    const [s0, s1, s2] = serials as [string, string, string];
    l3.applyEvents(poolId, [{ serial: s0, state: 'COMMISSIONED', at }, { serial: s1, state: 'COMMISSIONED', at }, { serial: s1, state: 'SAMPLE', at }, { serial: s2, state: 'COMMISSIONED', at }]);
    const task = l3.reject(poolId, 'lot rejected at QA disposition');
    expect(task).toMatchObject({ taskId: 'DT-000001', poolId, packagingOrder: 'PO-1', state: 'OPEN', serials: [s0, s2].sort((a, b) => serials.indexOf(a) - serials.indexOf(b)) });
    expect(l3.reject(poolId, 'again')).toEqual(task);
    expect(l3.decommissionTasks()).toEqual([task]);
  });
});

describe('serialisation L3 stub over HTTP', () => {
  let l3: RunningL3Stub;
  let base: string;
  beforeAll(async () => {
    l3 = await startL3Stub({ seed: 42, clock, http: { host: '127.0.0.1', port: 0 } });
    base = `http://127.0.0.1:${l3.port}`;
  });
  afterAll(async () => {
    await l3.close();
  });
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('serves pools, events and reports in the contract shapes; refusals carry a code; state lasts for the run', async () => {
    const issued = await post(L3_POOLS_PATH, request({ packagingOrder: 'PO-HTTP', quantity: '2' }));
    expect(issued.status).toBe(201);
    const pool = PoolResponse.parse(issued.body);
    expect((await post(L3_POOLS_PATH, request({ packagingOrder: 'PO-HTTP', quantity: '2' }))).status).toBe(200);
    expect((await post(L3_POOLS_PATH, { ...request(), quantity: 2 })).body).toMatchObject({ error: { code: 'SCHEMA' } });
    expect(await post(L3_POOLS_PATH, request({ market: 'IN_H2' }))).toMatchObject({ status: 422, body: { error: { code: 'NOT_SERIALISED' } } });
    const events: SerialEvent[] = pool.serials.map((serial) => ({ serial, state: 'COMMISSIONED', at }));
    expect(await post(l3PoolEventsPath(pool.poolId), { events: [{ serial: pool.serials[0], state: 'SAMPLE', at }] })).toMatchObject({ status: 409, body: { error: { code: 'BAD_TRANSITION' } } });
    expect(await post(l3PoolEventsPath(pool.poolId), { events })).toEqual({ status: 200, body: { accepted: '2' } });
    const res = await fetch(`${base}${l3PoolReportPath(pool.poolId)}`);
    const report = PoolReport.parse(await res.json());
    expect(Object.keys(report).sort()).toEqual(['counts', 'poolId', 'reportHash', 'unexplained']);
    expect(report).toMatchObject({ poolId: pool.poolId, counts: { issued: '2', COMMISSIONED: '2' }, unexplained: '0' });
    expect(report.reportHash).toBe(l3.stub.report(pool.poolId).reportHash);
    expect((await fetch(`${base}${l3PoolReportPath('POOL-404')}`)).status).toBe(404);
    expect(await post(`${L3_POOLS_PATH}/${pool.poolId}/reject`, { reason: 'rejected' })).toMatchObject({ status: 201, body: { serials: pool.serials } });
    expect(((await (await fetch(`${base}/l3/v1/decommission-tasks`)).json()) as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it('UNAVAILABLE answers 503 on every L3 route until cleared', async () => {
    await post('/api/fault', { fault: 'UNAVAILABLE', on: true });
    expect(await post(L3_POOLS_PATH, request({ packagingOrder: 'PO-DOWN' }))).toMatchObject({ status: 503, body: { error: { code: 'UNAVAILABLE' } } });
    await post('/api/fault', { fault: 'UNAVAILABLE', on: false });
    expect((await post(L3_POOLS_PATH, request({ packagingOrder: 'PO-DOWN' }))).status).toBe(201);
    expect(await (await fetch(`${base}/`)).text()).toContain('SIMULATOR (DEMO-ONLY)');
  });
});

describe('the L3/L4 simulator (Phase 6 slice 6c)', () => {
  it('[PR-42] publishes decommissioning tasks and aggregations on its feed, answers a serial query with its pool, state and profile, and its faults each break one thing (missing events, duplicate serial, stale report, aggregation mismatch)', () => {
    const l3 = new L3Stub({ seed: 5, clock });
    const { poolId, serials } = l3.issue(request({ packagingOrder: 'PO-L4', quantity: '3' }));
    const [s0] = serials as [string];
    expect(l3.query(s0)).toEqual({ serial: s0, poolId, gtin: EU_GTIN, packagingOrder: 'PO-L4', state: null });
    l3.applyEvents(poolId, serials.map((serial) => ({ serial, state: 'COMMISSIONED', at })));
    l3.setProfile(poolId, { lot: 'PO-L4', expiry: '2028-09' });
    expect(l3.query(s0)).toMatchObject({ state: 'COMMISSIONED', lot: 'PO-L4', expiry: '2028-09' });
    expect(() => l3.query('NOPE')).toThrow(/no pool holds/);
    // An aggregation, and the same with one pack more under AGGREGATION_MISMATCH.
    l3.aggregate({ poolId, parentId: '089012340000000017', childCount: '3' });
    l3.setFault('AGGREGATION_MISMATCH', true);
    l3.aggregate({ poolId, parentId: '089012340000000024', childCount: '3' });
    l3.setFault('AGGREGATION_MISMATCH', false);
    // A rejection opens a task (published), completing it decommissions its serials (published DONE).
    const task = l3.reject(poolId, 'lot rejected');
    expect(task).toMatchObject({ state: 'OPEN', serials });
    // MISSING_EVENTS: the feed delivers nothing while the task is done; then everything, in order.
    l3.setFault('MISSING_EVENTS', true);
    expect(l3.completeTask(task.taskId).state).toBe('DONE');
    expect(l3.feed.page(0n, 100).messages).toEqual([]);
    l3.setFault('MISSING_EVENTS', false);
    const page = l3.feed.page(0n, 100).messages;
    expect(page.map((m) => `${m.messageType}:${String(m.payload['childCount'] ?? m.payload['state'])}`)).toEqual(['l3.aggregation:3', 'l3.aggregation:4', 'l3.decommission_task:OPEN', 'l3.decommission_task:DONE']);
    expect(page.every((m) => m.sourceSystem === 'L3')).toBe(true);
    expect(l3.report(poolId).counts).toMatchObject({ DECOMMISSIONED: '3' });
    // STALE_REPORT: the heartbeat stops and the report stays as it was.
    const second = l3.issue(request({ packagingOrder: 'PO-L4B', quantity: '2' }));
    l3.setFault('STALE_REPORT', true);
    l3.applyEvents(second.poolId, second.serials.map((serial) => ({ serial, state: 'COMMISSIONED', at })));
    expect(l3.feed.heartbeatOk()).toBe(false);
    expect(l3.report(second.poolId).counts.COMMISSIONED).toBe('0');
    l3.setFault('STALE_REPORT', false);
    expect(l3.report(second.poolId).counts.COMMISSIONED).toBe('2');
    // DUPLICATE_SERIAL: a pool of three carries two distinct serials.
    l3.setFault('DUPLICATE_SERIAL', true);
    expect(new Set(l3.issue(request({ packagingOrder: 'PO-DUP', quantity: '3' })).serials).size).toBe(2);
  });
});
