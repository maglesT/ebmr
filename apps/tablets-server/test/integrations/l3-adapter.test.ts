/**
 * Phase 6 slice 6c (tablets 1231; PR-42, DI-31; defaults D-P6c-1, D-P6c-12 to D-P6c-15): serialisation L3/L4 against the
 * stateful L3/L4 simulator (apps/simulators serialisation, its own process). A packaging order's pool comes from the
 * simulator through the Phase 3 pool path; its serials are commissioned there; the L3 adapter (a registered INTEGRATION
 * identity on the 6a worker framework) pulls the simulator's feed into tab.receive_l3_message. Proven as the application
 * role on a GMP server whose L3 is the simulator (EBMR_L3_URL): the serial query answers the record's lot and expiry;
 * aggregations and decommissioning tasks land or are refused with their class and alarm (no silent loss, the period
 * reconciles); an OPEN task and, in MIRROR mode, a stale L3 mirror keep the release item E.RECONCILIATION_SERIAL red
 * (fails closed, outline 4.6); the serialisation routes. The order's pool row (as the Phase 3 pool path records it,
 * proven in blocks/packaging) and its shipper (a TB-24 SHIPPER entry with its SSCC) are arranged as test set-up on an
 * issued GMP batch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand, type ActorContext } from '@ebmr/kernel';
import { passwordActor } from '@ebmr/test-kit';
import { SerialQueryAnswer, type PoolResponse } from '@ebmr/integration-sdk/serialisation';
import { ageMirror, count, ctxOf, envelopeFor, receive, registerAdapter, setMirrorMode, type Administration, type TestAdapter } from '../../../../packages/kernel/test/integrations/support.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { L3_ADAPTER } from '../../src/features/integrations/adapters/l3/index.ts';
import { feedWorker, type AdapterWorker, type CycleReport } from '../../src/features/integrations/adapters/framework.ts';
import { routes } from '@ebmr/api-contract';
import { actorOfBrowser, personaIn, refusalOf, tapFor, valueOf } from '../esig/support.ts';
import type { TestBrowser } from '../support/harness.ts';
import type { ExecServer } from '../execution/support.ts';
import { productMaster } from '../blocks/packaging/db-support.ts';
import { gmpContent, startGmpBatchWorld, type GmpBatchWorld } from '../support/gmp-world.ts';
import { spawnFeedSimulator, type FeedSimProcess } from './feed-simulator.ts';

type Json = Record<string, unknown>;
const US_GTIN = '00312345678906';
const SSCC = '003123450000000017';
let sbx: ExecServer;
let db: TestDatabase;
let adm: Administration;
let sim: FeedSimProcess;
let adapter: TestAdapter;
let worker: AdapterWorker;
let runId: string;
let batchNumber: string;
let pool: PoolResponse;
const from = BigInt(Date.now() - 60_000) * 1000n;

const sql = async <T,>(text: string, params: unknown[] = []): Promise<T | null> => (await sbx.db.admin.query<{ r: T | null }>(text, params)).rows[0]?.r ?? null;
const simJson = async <T,>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const res = await fetch(`${sim.base}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json()) as T };
};
/** The EBMR code a promise is refused with (L3 codes carry a digit), or 'ok'. */
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return /\bEBMR-[A-Z0-9]+-\d{3}\b/.exec(m)?.[0] ?? m;
  }
};
const refused = (cls: string) => count(db, "select count(*) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED' and error_class = $2", [adapter.code, cls]);
/** Cycles until caught up with nothing stopped (at most n cycles). */
async function settle(n = 6): Promise<CycleReport> {
  let last: CycleReport | undefined;
  for (let i = 0; i < n; i++) {
    last = await worker.cycle();
    if (last.caughtUp && last.stopped === null) return last;
  }
  return last as CycleReport;
}

let as: (p: string) => Promise<ActorContext>;
let w: GmpBatchWorld;

beforeAll(async () => {
  sim = await spawnFeedSimulator('L3');
  w = await startGmpBatchWorld(gmpContent(), { EBMR_L3_URL: sim.base });
  sbx = w.gmp;
  db = sbx.db as unknown as TestDatabase;
  const b = sbx.seed.bootstrap;
  adm = { admin: await passwordActor(sbx.db, b.admin, b.admin.fingerprint), owner: await passwordActor(sbx.db, b.owner, b.owner.fingerprint), authn: sbx.db.authn };
  runId = await w.issued(await sbx.asPersona('issuer'));
  batchNumber = (await sql<string>('select batch_number as r from recipe.batch_execution where id = $1', [runId])) ?? '';
  await productMaster(sbx, runId, 24);
  const browsers = new Map<string, Awaited<ReturnType<ExecServer['asPersona']>>>();
  as = async (persona) => {
    if (!browsers.has(persona)) browsers.set(persona, await sbx.asPersona(persona));
    return actorOfBrowser(sbx, browsers.get(persona) as Awaited<ReturnType<ExecServer['asPersona']>>, persona);
  };
  pool = (await simJson<PoolResponse>('POST', '/l3/v1/pools', { packagingOrder: batchNumber, market: 'US_DSCSA', gtin: US_GTIN, quantity: '4' })).body;
  expect((await simJson('POST', `/l3/v1/pools/${pool.poolId}/events`, { events: pool.serials.map((serial) => ({ serial, state: 'COMMISSIONED', at: '1790584618000000' })) })).status).toBe(200);
  // Arranged: the order's pool as tab.record_serial_pool records it, and its shipper of 4 packs under SSCC.
  const c = await sbx.db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    await c.query(`insert into tab.serial_pool (pool_id, batch_id, step_key, step, market, l3_market, gtin, quantity, issued_at_us, requested_by_person, requested_by_account, correlation_id)
                   values ($1, $2, 'p-g21@', 'p-g21', 'US', 'US_DSCSA', $3, 4, 1790584618000000, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`, [pool.poolId, runId, US_GTIN]);
    const updated = await c.query("update recipe.execution_state set state = jsonb_set(state, '{entries,TEST-SHIPPER-1}', $2::jsonb) where batch_id = $1",
      [runId, JSON.stringify({ id: 'TEST-SHIPPER-1', kind: 'SHIPPER', stepKey: 'p-tb24@', data: { sscc: SSCC, packs: '4', part: false } })]);
    expect(updated.rowCount).toBe(1);
    await c.query('commit');
  } finally {
    c.release();
  }
  adapter = await registerAdapter(db, 'L3', adm);
  worker = feedWorker(db.app, adapter.code, L3_ADAPTER, () => Promise.resolve(ctxOf(adapter.actor)), { endpoint: `${sim.base}/l3/v1`, timeoutMs: 1_000 });
}, 600_000);
afterAll(async () => {
  await sim?.close();
  await w?.close();
});

describe('serialisation L3/L4 (tablets 1231) against the L3/L4 simulator', () => {
  it('[PR-42] a query on a commissioned serial returns its lot, expiry and status: the record\'s lot and expiry for the serial\'s pool; an L3 lot or expiry that differs is a problem, never the answer', async () => {
    const lookup = async (serial: string): Promise<Json> => {
      const answer = SerialQueryAnswer.parse((await simJson('GET', `/l3/v1/serials/${serial}`)).body);
      return (await sbx.db.app.query<{ r: Json }>('select tab.serial_lookup($1::jsonb) as r', [JSON.stringify(answer)])).rows[0]?.r ?? {};
    };
    const expiry = (await sql<Json>('select recipe.batch_expiry($1) as r', [runId]))?.['expiryMonth'];
    expect(expiry).toMatch(/^\d{4}-\d{2}$/);
    const serial = pool.serials[0] ?? '';
    expect(await lookup(serial)).toEqual({
      serial, poolId: pool.poolId, gtin: US_GTIN, market: 'US', batchId: runId, lot: batchNumber, expiry, status: 'COMMISSIONED',
      l3: { lot: null, expiry: null, packagingOrder: batchNumber }, problems: [],
    });
    expect((await simJson('POST', `/l3/v1/pools/${pool.poolId}/profile`, { lot: 'OTHER-LOT', expiry: '2099-01' })).status).toBe(200);
    expect(await lookup(serial)).toMatchObject({
      lot: batchNumber, expiry, l3: { lot: 'OTHER-LOT', expiry: '2099-01' },
      problems: [`the L3 holds lot OTHER-LOT, the record ${batchNumber}`, `the L3 holds expiry 2099-01, the record ${String(expiry)}`],
    });
    await simJson('POST', `/l3/v1/pools/${pool.poolId}/profile`, { lot: batchNumber, expiry });
    expect((await lookup(serial))['problems']).toEqual([]);
    // A pool no record holds, and an answer outside the contract, are refused.
    const ask = (a: Json) => codeOf(sbx.db.app.query('select tab.serial_lookup($1::jsonb)', [JSON.stringify(a)]));
    expect(await ask({ serial, poolId: 'POOL-NOT-OURS', gtin: US_GTIN, packagingOrder: batchNumber, state: 'COMMISSIONED' })).toBe('EBMR-L3-110');
    expect(await ask({ serial, poolId: pool.poolId, gtin: 'x', packagingOrder: batchNumber, state: 'COMMISSIONED' })).toBe('EBMR-L3-109');
  });

  it('[PR-42][DI-31] the L3 adapter lands aggregations and decommissioning tasks; an aggregation mismatch, a parent that is no shipper of the order, a missing-events gap and a duplicate delivery each end accepted or refused with an alarm, and the period reconciles; an OPEN task keeps release red until the L3 reports it DONE', async () => {
    // STAND_IN (the default): an L3 message is refused, never applied.
    expect(await codeOf(receive(db, adapter, 'tab.receive_l3_message', envelopeFor(adapter, 'l3.aggregation', { eventId: 'A-0', action: 'ADD', poolId: pool.poolId, parentId: SSCC, childCount: '4', eventTime: '1790584618000000' })))).toBe('EBMR-L3-103');
    await setMirrorMode(db, 'L3_SERIAL_STATUS', 'MIRROR', adm);
    expect((await simJson('POST', '/l3/v1/aggregations', { poolId: pool.poolId, parentId: SSCC, childCount: '4' })).status).toBe(201);
    await sim.fault('AGGREGATION_MISMATCH', true);
    await simJson('POST', '/l3/v1/aggregations', { poolId: pool.poolId, parentId: SSCC, childCount: '4' });
    await sim.fault('AGGREGATION_MISMATCH', false);
    await simJson('POST', '/l3/v1/aggregations', { poolId: pool.poolId, parentId: '003123450000000024', childCount: '4' });
    // The L3 rejects the pool on QA's request: its OPEN task arrives on the feed while MISSING_EVENTS is on.
    await sim.fault('MISSING_EVENTS', true);
    const task = (await simJson<{ taskId: string }>('POST', `/l3/v1/pools/${pool.poolId}/reject`, { reason: 'lot rejected at QA review' })).body;
    expect((await worker.cycle()).received).toBe(0);
    await sim.fault('MISSING_EVENTS', false);
    await sim.fault('DUPLICATE', true);
    const r1 = await settle();
    await sim.fault('DUPLICATE', false);
    expect(r1).toMatchObject({ stopped: null, caughtUp: true, synced: true });
    expect(await refused('OUT_OF_RANGE')).toBe(1);
    expect(await refused('WRONG_IDENTITY')).toBe(1);
    expect(await sql<Json[]>("select jsonb_agg(jsonb_build_object('parent', parent_sscc, 'count', child_count::text)) as r from tab.l3_aggregation where pool_id = $1", [pool.poolId])).toEqual([{ parent: SSCC, count: '4' }]);
    expect(await sql<string>('select tab.l3_release_problem($1) as r', [runId])).toMatch(new RegExp(`serial pool ${pool.poolId} has the open decommissioning task ${task.taskId} \\(4 serials\\)`));
    const item = await sql<Json>('select tab.grel_recon_serial($1) as r', [runId]);
    expect(JSON.stringify(item)).toContain('open decommissioning task');
    // The task is done in the L3: the DONE state arrives and the L3 problem clears.
    expect((await simJson('POST', `/l3/v1/decommission-tasks/${task.taskId}/done`)).status).toBe(200);
    expect(await settle()).toMatchObject({ stopped: null, accepted: 1 });
    expect(await sql<string>('select tab.l3_release_problem($1) as r', [runId])).toBeNull();
    // No silent loss: the source's count and checksum match what was accepted plus what was refused with an alarm.
    expect((await worker.reconcile(from, BigInt(Date.now() + 60_000) * 1000n)).matched).toBe(true);
    const received = (await count(db, 'select count(*) as n from platform.inbound_message where adapter_code = $1', [adapter.code]))
      + (await count(db, "select count(distinct idempotency_key) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED'", [adapter.code]));
    expect(received).toBe(await sim.head());
    expect(await count(db, "select count(*) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED' and alarm_id is null", [adapter.code])).toBe(0);
  });

  it('[PR-42] a stale L3 report refuses release: with the L3 heartbeat stopped the mirror ages past its bound and E.RECONCILIATION_SERIAL fails closed naming the stale mirror; a fresh synchronisation clears it', async () => {
    expect(await sql<string>('select tab.l3_release_problem($1) as r', [runId])).toBeNull();
    await sim.fault('STALE_REPORT', true);
    expect((await worker.cycle()).heartbeat).toBe(false);
    await ageMirror(db, 'L3_SERIAL_STATUS', 4_000);
    expect(await sql<string>('select tab.l3_release_problem($1) as r', [runId])).toMatch(/the L3 mirror L3_SERIAL_STATUS is stale \(last synchronised \d+ s ago, bound 3600 s\)/);
    const item = await sql<{ problems: { problem: string }[] } & Json>('select tab.grel_recon_serial($1) as r', [runId]);
    expect(JSON.stringify(item)).toContain('L3_SERIAL_STATUS is stale');
    expect((await sql<Json>('select tab.batch_pools_view($1) as r', [runId]))?.['mirror']).toMatchObject({ mode: 'MIRROR', stale: true, boundSeconds: 3600 });
    // The heartbeat answers again: the next cycle synchronises and the release item no longer names the mirror.
    await sim.fault('STALE_REPORT', false);
    expect(await settle()).toMatchObject({ heartbeat: true, synced: true });
    expect(await sql<string>('select tab.l3_release_problem($1) as r', [runId])).toBeNull();
    expect(JSON.stringify(await sql<Json>('select tab.grel_recon_serial($1) as r', [runId]))).not.toContain('L3_SERIAL_STATUS is stale');
  });

  it('[PR-42][DI-31] malformed and stale L3 messages are refused by the receiving command; a QA rejection records the L3 system\'s OPEN task, and nobody else records one', async () => {
    // Direct messages take sequence numbers past the feed's (the feed's own are the worker's).
    let n = 9_000;
    const send = (type: string, payload: Json) => codeOf(receive(db, adapter, 'tab.receive_l3_message', envelopeFor(adapter, type, payload, { sequenceNo: String((n += 1)) })));
    expect(await send('l3.aggregation', { eventId: 'A-1', action: 'MOVE', poolId: pool.poolId, parentId: SSCC, childCount: '4', eventTime: '1790584618000000' })).toBe('EBMR-L3-101');
    expect(await send('l3.aggregation', { eventId: 'A-2', action: 'ADD', poolId: pool.poolId, parentId: SSCC, childCount: '4', eventTime: '1000' })).toBe('EBMR-L3-104');
    expect(await send('l3.decommission_task', { taskId: 'DT-X', poolId: pool.poolId, packagingOrder: 'NOT-OURS', serialCount: '1', reason: 'x', state: 'OPEN', changedAt: '1790584618000000' })).toBe('EBMR-L3-103');
    expect(await send('l3.decommission_task', { taskId: 'DT-X', poolId: pool.poolId, packagingOrder: batchNumber, serialCount: '9', reason: 'x', state: 'OPEN', changedAt: '1790584618000000' })).toBe('EBMR-L3-105');
    // QA's rejection through the server records the L3's OPEN task; others may not.
    const reject = async (persona: string, task: Json) => codeOf(withCommand(sbx.db.app, await as(persona), (c) => c.query('select tab.record_pool_rejection($1, $2, $3::jsonb)', [pool.poolId, 'recall assessment', JSON.stringify(task)])));
    const answer = { taskId: 'DT-QA-1', poolId: pool.poolId, packagingOrder: batchNumber, reason: 'recall assessment', createdAt: '1790584619000000', state: 'OPEN', serials: [pool.serials[0]] };
    expect(await reject('operator1', answer)).toBe('EBMR-IAM-040');
    expect(await reject('qa1', { ...answer, packagingOrder: 'OTHER' })).toBe('EBMR-L3-108');
    expect(await reject('qa1', answer)).toBe('ok');
    expect(await sql<string>('select tab.l3_release_problem($1) as r', [runId])).toMatch(/open decommissioning task DT-QA-1/);
    await expect(sbx.db.app.query("insert into tab.l3_decommission_task (task_id, pool_id, batch_id, serial_count, reason, state, changed_at, source, recorded_by, correlation_id) values ('X', $1, $2, 0, 'x', 'DONE', now(), 'REJECTION', gen_random_uuid(), gen_random_uuid())", [pool.poolId, runId])).rejects.toThrow(/permission denied/);
  });

  it('[PR-42] the serialisation routes: a serial query through the server answers the record\'s lot, expiry and status; the pools of the order show the release problem; QA rejects a pool through the L3 and nobody else may', async () => {
    const qa = await sbx.asPersona('qa1');
    const op = await sbx.asPersona('operator1');
    const serial = pool.serials[1] ?? '';
    const lookup = valueOf(await qa.call(routes.serialisation.serial, { params: { serial } }));
    // Its serials were decommissioned when the L3 closed the first task (above): the status is the L3's now.
    expect(lookup).toMatchObject({ serial, poolId: pool.poolId, lot: batchNumber, status: 'DECOMMISSIONED', problems: [], mirror: { mode: 'MIRROR' } });
    expect(refusalOf(await qa.call(routes.serialisation.serial, { params: { serial: 'NOSUCHSERIAL1' } }))).toMatchObject({ code: 'L3-UNKNOWN' });
    const pools = valueOf(await op.call(routes.serialisation.batchPools, { params: { batchId: runId } }));
    expect(pools).toMatchObject({ batchId: runId, batchNumber, pools: [{ poolId: pool.poolId, market: 'US', quantity: '4', aggregations: [{ parentId: SSCC, action: 'ADD', childCount: '4' }] }] });
    expect(pools.releaseProblem).toMatch(/serial|L3/);
    const path = `/api/serialisation/pools/${encodeURIComponent(pool.poolId)}/rejection`;
    const tapped = async (b: TestBrowser, persona: string, body: { reason: string }) => ({ params: { poolId: pool.poolId }, body, attribution: await tapFor(b, personaIn(sbx, persona), 'POST', path, body) });
    expect(refusalOf(await op.call(routes.serialisation.rejectPool, await tapped(op, 'operator1', { reason: 'operator tries' })))).toMatchObject({ code: 'EBMR-IAM-040', why: (expect.stringMatching(/lacks permission QA\.FLOOR_APPROVE/) as string) });
    const rejected = valueOf(await qa.call(routes.serialisation.rejectPool, await tapped(qa, 'qa1', { reason: 'counterfeit suspicion' })));
    const open = rejected.pools[0]?.decommissionTasks.filter((t) => t.state === 'OPEN') ?? [];
    // DT-QA-1 (recorded above) and the task the L3 opened now.
    expect(open.map((t) => t.taskId)).toEqual(expect.arrayContaining(['DT-QA-1']));
    expect(open).toHaveLength(2);
    expect(rejected.releaseProblem).toMatch(/serial|decommissioning/);
    // The L3 answers the same open task for a repeat (D-S4-3): nothing new is opened or recorded.
    const tasksBefore = (await simJson<{ tasks: unknown[] }>('GET', '/l3/v1/decommission-tasks')).body.tasks.length;
    const again = valueOf(await qa.call(routes.serialisation.rejectPool, await tapped(qa, 'qa1', { reason: 'counterfeit suspicion' })));
    expect(again.pools[0]?.decommissionTasks.filter((t) => t.state === 'OPEN')).toEqual(open);
    expect((await simJson<{ tasks: unknown[] }>('GET', '/l3/v1/decommission-tasks')).body.tasks.length).toBe(tasksBefore);
    await sim.fault('UNAVAILABLE', true);
    expect(refusalOf(await qa.call(routes.serialisation.serial, { params: { serial } }))).toMatchObject({ code: 'L3-UNAVAILABLE' });
    await sim.fault('UNAVAILABLE', false);
  });
});
