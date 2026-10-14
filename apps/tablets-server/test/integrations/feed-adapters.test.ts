/**
 * The QMS, LIMS, LMS and CMMS adapters against their simulators (Phase 6 slice 6a, builder B; DI-31, DI-14, DI-20):
 * a contract test per adapter (every message type of its contract reaches its receiving command and lands), and a soak
 * per adapter with every fault switched on in turn (feed gap, stale value, malformed, duplicate, out-of-order, wrong
 * batch, link cut mid-transfer, slow answer, stale mirror) that proves no silent loss: every published message is
 * accepted or refused with an alarm, and the source's count and checksum reconcile with what the eBMR received.
 * The workers run as registered INTEGRATION identities against a copy of the GMP template.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { plant } from '@ebmr/recipe-core';
import { cmmsSimulator } from '../../../simulators/src/cmms/model.ts';
import { limsSimulator } from '../../../simulators/src/lims/model.ts';
import { lmsSimulator } from '../../../simulators/src/lms/model.ts';
import { qmsSimulator } from '../../../simulators/src/qms/model.ts';
import { FEED_FAULTS, type FeedFault } from '../../../simulators/src/system-feed/feed.ts';
import { startFeedSimulator, type RunningFeedSimulator } from '../../../simulators/src/system-feed/server.ts';
import { passwordActor, terminalOf } from '@ebmr/test-kit';
import { withReason } from '../../../../packages/kernel/test/identity/seed.ts';
import { count, ctxOf, registerAdapter, setMirrorMode, type Administration, type TestAdapter } from '../../../../packages/kernel/test/integrations/support.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { CMMS_ADAPTER } from '../../src/features/integrations/adapters/cmms/index.ts';
import { FeedPullWorker, type CycleReport, type FeedAdapterSpec } from '../../src/features/integrations/adapters/feed-pull/worker.ts';
import { LIMS_ADAPTER } from '../../src/features/integrations/adapters/lims/index.ts';
import { LMS_ADAPTER } from '../../src/features/integrations/adapters/lms/index.ts';
import { QMS_ADAPTER } from '../../src/features/integrations/adapters/qms/index.ts';
import { actorOf } from '../support/gmp-world.ts';
import { grantedPerson } from '../support/granted-person.ts';
import { startServer, type TestServer } from '../support/harness.ts';

let server: TestServer;
let db: TestDatabase;
let adm: Administration;
let personId: string;
let lotCode: string;
let equipmentCode: string;
const personNumber = `EMP-${randomBytes(3).toString('hex').toUpperCase()}`;
const QUALS = Array.from({ length: 40 }, (_, i) => `SOP-F${i.toString().padStart(2, '0')}`);
const sims: RunningFeedSimulator[] = [];

beforeAll(async () => {
  server = await startServer('GMP');
  db = server.db as unknown as TestDatabase;
  const b = server.seed.bootstrap;
  adm = {
    admin: await passwordActor(server.db, b.admin, b.admin.fingerprint),
    owner: await passwordActor(server.db, b.owner, b.owner.fingerprint),
    authn: server.db.authn,
  };
  const fp = terminalOf(server.seed, 'PC-QA-01').fingerprint;
  const coordinator = await grantedPerson(server, 'TRAINING_COORDINATOR', 'Tara Coordinator');
  const tc = await passwordActor(server.db, coordinator, fp);
  const steward = await actorOf(server, 'steward');
  personId = (await actorOf(server, 'operator1')).personId;
  await withCommand(db.admin, withReason(adm.admin), (c) => c.query('update iam.person set employee_ref = $1 where id = $2', [personNumber, personId]));
  await withCommand(db.app, withReason(tc), async (c) => {
    for (const q of QUALS) await c.query("select iam.create_qualification_type($1, 'Feed SOP', 'feed test SOP')", [q]);
  });
  const classCode = `CL-${randomBytes(3).toString('hex').toUpperCase()}`;
  equipmentCode = `EQ-${randomBytes(3).toString('hex').toUpperCase()}`;
  await withCommand(db.app, withReason(steward), async (c) => {
    await plant.defineEquipmentClass(c, { code: classCode, description: 'feed test class', kind: 'PROCESS', cleanHold: '72 hours', dirtyHold: '48 hours', calibrationRequired: true });
    await plant.defineEquipment(c, { code: equipmentCode, name: 'Feed test press', classCode });
  });
  lotCode = `L-${randomBytes(3).toString('hex').toUpperCase()}`;
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at,
                                      received_by_person, received_by_account, correlation_id)
       values ($1, 'SITE-1', $2, 'M-FEED', 'Feed material', 'EXCIPIENT', 10, 'kg', '2030-01-01T00:00:00Z', $3, $3, $3)`,
      [randomUUID(), lotCode, randomUUID()],
    );
    await c.query('commit');
  } finally {
    c.release();
  }
  for (const cls of ['LMS_QUALIFICATION', 'QMS_STATUS', 'CMMS_CALIBRATION', 'CMMS_MAINTENANCE']) await setMirrorMode(db, cls, 'MIRROR', adm);
}, 600_000);
afterAll(async () => {
  await Promise.all(sims.map((s) => s.close()));
  await server?.close();
});

interface Rig {
  sim: RunningFeedSimulator;
  adapter: TestAdapter;
  worker: FeedPullWorker;
  post(path: string, body: unknown): Promise<number>;
  fault(f: FeedFault, on: boolean, slowMs?: number): Promise<void>;
}

async function rig(spec: FeedAdapterSpec, made: { feed: RunningFeedSimulator['feed']; plugin: Parameters<typeof startFeedSimulator>[1] }): Promise<Rig> {
  const sim = await startFeedSimulator(made.feed, made.plugin, { host: '127.0.0.1', port: 0 });
  sims.push(sim);
  const adapter = await registerAdapter(db, spec.system, adm);
  const base = `http://127.0.0.1:${sim.port.toString()}`;
  const worker = new FeedPullWorker(spec, { pool: db.app, baseUrl: base, timeoutMs: 400, openSession: () => Promise.resolve({ actor: ctxOf(adapter.actor), close: () => Promise.resolve() }) });
  return {
    sim, adapter, worker,
    post: async (path, body) => (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status,
    fault: async (fault, on, slowMs) => {
      await fetch(`${base}/api/fault`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fault, on, ...(slowMs ? { slowMs } : {}) }) });
    },
  };
}

const alarms = (r: Rig, kind: string) => count(db, 'select count(*) as n from platform.integration_alarm where adapter_code = $1 and kind = $2', [r.adapter.code, kind]);
const refused = (r: Rig, cls: string) => count(db, "select count(*) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED' and error_class = $2", [r.adapter.code, cls]);

/** Cycles until the worker is caught up with nothing stopped (at most `n` cycles). */
async function settle(r: Rig, n = 6): Promise<CycleReport> {
  let last: CycleReport | undefined;
  for (let i = 0; i < n; i++) {
    last = await r.worker.cycle();
    if (last.caughtUp && last.stopped === null) return last;
  }
  return last as CycleReport;
}

/**
 * The soak: three clean messages, then each fault on in turn with two more messages (one of them a newer state of the
 * first record, so STALE_VALUE has an older state to send), the fault off and the worker settled; at the end the whole
 * period reconciles and the number of distinct keys published equals what was accepted plus what was refused.
 */
async function soak(r: Rig, publish: (i: number, record: number) => Promise<number>, mirrored: boolean): Promise<void> {
  const from = BigInt(Date.now() - 5000) * 1000n;
  let i = 0;
  for (; i < 3; i++) expect(await publish(i, i)).toBe(201);
  const clean = await settle(r);
  expect(clean).toMatchObject({ accepted: 3, stopped: null, caughtUp: true, synced: mirrored });
  for (const f of FEED_FAULTS) {
    const before = { stale: await refused(r, 'STALE'), malformed: await refused(r, 'MALFORMED'), wrong: await refused(r, 'WRONG_IDENTITY'), ooo: await alarms(r, 'OUT_OF_ORDER') };
    await r.fault(f, true, f === 'SLOW' ? 900 : undefined);
    expect(await publish(i, f === 'STALE_VALUE' ? 0 : i)).toBe(201);
    i += 1;
    expect(await publish(i, i)).toBe(201);
    i += 1;
    const during = await r.worker.cycle();
    switch (f) {
      case 'FEED_GAP':
        expect(during, f).toMatchObject({ fetched: 0, caughtUp: false, synced: false });
        break;
      case 'LINK_CUT':
      case 'SLOW':
        expect(during.stopped, f).not.toBeNull();
        expect(during.synced, f).toBe(false);
        break;
      case 'STALE_MIRROR':
        expect(during, f).toMatchObject({ caughtUp: true, synced: false });
        break;
      case 'DUPLICATE':
        expect(during.duplicates, f).toBeGreaterThan(0);
        break;
      default:
        break;
    }
    await r.fault(f, false);
    const after = await settle(r);
    expect(after, f).toMatchObject({ stopped: null, caughtUp: true, synced: mirrored });
    if (f === 'STALE_VALUE') expect(await refused(r, 'STALE'), f).toBe(before.stale + 1);
    if (f === 'MALFORMED') expect(await refused(r, 'MALFORMED'), f).toBe(before.malformed + 2);
    if (f === 'WRONG_BATCH') expect(await refused(r, 'WRONG_IDENTITY'), f).toBe(before.wrong + 2);
    if (f === 'OUT_OF_ORDER') expect(await alarms(r, 'OUT_OF_ORDER'), f).toBeGreaterThan(before.ooo);
  }
  // No silent loss: the source's count and checksum match what the eBMR accepted plus what it refused with an alarm.
  const rec = await r.worker.reconcile(from, BigInt(Date.now() + 5000) * 1000n);
  expect(rec.matched).toBe(true);
  const published = new Set(r.sim.feed.published().map((m) => m.idempotencyKey)).size;
  const received = (await count(db, 'select count(*) as n from platform.inbound_message where adapter_code = $1', [r.adapter.code]))
    + (await count(db, "select count(distinct idempotency_key) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED'", [r.adapter.code]));
  expect(received).toBe(published);
  // Every refusal left an alarm.
  expect(await count(db, "select count(*) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED' and alarm_id is null", [r.adapter.code])).toBe(0);
}

describe('the feed adapters against their simulators (DI-31)', () => {
  it('[DI-31] LMS: the contract reaches iam.receive_lms_qualification; the soak with every fault in turn reconciles (no silent loss)', async () => {
    const r = await rig(LMS_ADAPTER, lmsSimulator());
    const publish = (i: number, record: number) =>
      r.post('/lms/v1/qualifications', { personNumber, qualificationCode: QUALS[record], status: i % 3 === 2 ? 'REVOKED' : 'QUALIFIED', validFrom: '1700000000000000', validTo: null });
    await soak(r, publish, true);
    expect(await count(db, "select count(*) as n from iam.person_qualification where person_id = $1 and source_code = 'LMS'", [personId])).toBeGreaterThan(0);
  });

  it('[DI-31] QMS: deviation status, CAPA and change control reach the mirror; the soak with every fault in turn reconciles', async () => {
    const r = await rig(QMS_ADAPTER, qmsSimulator());
    expect(await r.post('/qms/v1/capas', { capaRef: 'QC-CONTRACT', title: 'Contract CAPA', status: 'OPEN', needsMasterChange: false, effectivenessDueDate: null })).toBe(201);
    expect(await r.post('/qms/v1/change-controls', { changeRef: 'CC-CONTRACT', status: 'APPROVED' })).toBe(201);
    const publish = (i: number, record: number) => r.post('/qms/v1/deviations', { deviationRef: `QD-${record.toString()}`, status: i % 2 === 0 ? 'OPEN' : 'CLOSED', lotNumbers: [lotCode] });
    const tail = await settle(r);
    expect(tail).toMatchObject({ accepted: 2, synced: true });
    await soak(r, publish, true);
    expect(await count(db, "select count(*) as n from site.capa where qms_ref = 'QC-CONTRACT'")).toBe(1);
    expect(await count(db, "select count(*) as n from site.qms_change_control where change_ref = 'CC-CONTRACT'")).toBe(1);
  });

  it('[DI-31] LIMS: results keep the raw value and unit; the soak with every fault in turn reconciles', async () => {
    const r = await rig(LIMS_ADAPTER, limsSimulator());
    const publish = (i: number, record: number) =>
      r.post('/lims/v1/results', { sampleId: `S-${record.toString()}`, lotNumber: lotCode, testCode: 'ASSAY', specificationRef: 'SP-1', result: { value: `99.${i.toString()}0`, unit: '%' },
                                   conformance: 'CONFORMS', state: 'APPROVED', recordedAt: '1790000000000000' });
    await soak(r, publish, false);
    expect((await db.app.query("select raw_value from site.lims_sample_result where sample_id = 'S-1' order by source_timestamp desc limit 1")).rows).toEqual([{ raw_value: '99.10' }]);
  });

  it('[DI-31] CMMS: calibrations and work orders reach the equipment guard; the soak with every fault in turn reconciles', async () => {
    const r = await rig(CMMS_ADAPTER, cmmsSimulator());
    expect(await r.post('/cmms/v1/calibrations', { equipmentCode, calibrationRef: 'CAL-CONTRACT', performedAt: (BigInt(Date.now()) * 1000n).toString(), result: 'PASS', dueOn: '2099-12-31' })).toBe(201);
    expect(await settle(r)).toMatchObject({ accepted: 1, synced: true });
    expect(await count(db, "select count(*) as n from plant.calibration where reference = 'CAL-CONTRACT'")).toBe(1);
    const publish = (i: number, record: number) =>
      r.post('/cmms/v1/work-orders', { equipmentCode, workOrder: `WO-${record.toString()}`, kind: 'PREVENTIVE', status: i % 2 === 0 ? 'OPEN' : 'COMPLETED', dueOn: '2099-12-31' });
    await soak(r, publish, true);
  });
});
