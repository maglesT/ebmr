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
import { routes } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { plant } from '@ebmr/recipe-core';
import { passwordActor, terminalOf } from '@ebmr/test-kit';
import { withReason } from '../../../../packages/kernel/test/identity/seed.ts';
import { count, ctxOf, registerAdapter, setMirrorMode, type Administration, type TestAdapter } from '../../../../packages/kernel/test/integrations/support.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { CMMS_ADAPTER } from '../../src/features/integrations/adapters/cmms/index.ts';
import { feedWorker, type AdapterWorker, type AdapterWorkerOptions, type CycleReport, type FeedAdapterSpec } from '../../src/features/integrations/adapters/framework.ts';
import { LIMS_ADAPTER } from '../../src/features/integrations/adapters/lims/index.ts';
import { LMS_ADAPTER } from '../../src/features/integrations/adapters/lms/index.ts';
import { QMS_ADAPTER } from '../../src/features/integrations/adapters/qms/index.ts';
import { actorOf } from '../support/gmp-world.ts';
import { grantedPerson } from '../support/granted-person.ts';
import { valueOf } from '../esig/support.ts';
import { startServer, type TestServer } from '../support/harness.ts';
import { spawnFeedSimulator, type FeedSimProcess } from './feed-simulator.ts';

/** The simulators' faults (apps/simulators/src/system-feed/feed.ts FEED_FAULTS), switched on in turn. */
const FEED_FAULTS = ['FEED_GAP', 'STALE_VALUE', 'MALFORMED', 'DUPLICATE', 'OUT_OF_ORDER', 'WRONG_BATCH', 'LINK_CUT', 'SLOW', 'STALE_MIRROR'] as const;
type FeedFault = (typeof FEED_FAULTS)[number];

let server: TestServer;
let db: TestDatabase;
let adm: Administration;
let personId: string;
let lotCode: string;
let equipmentCode: string;
const personNumber = `EMP-${randomBytes(3).toString('hex').toUpperCase()}`;
const QUALS = Array.from({ length: 40 }, (_, i) => `SOP-F${i.toString().padStart(2, '0')}`);
const sims: FeedSimProcess[] = [];

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
  sim: FeedSimProcess;
  adapter: TestAdapter;
  worker: AdapterWorker;
  post(path: string, body: unknown): Promise<number>;
  fault(f: FeedFault, on: boolean, slowMs?: number): Promise<void>;
}

async function rig(spec: FeedAdapterSpec, opts: Pick<AdapterWorkerOptions, 'nowUs' | 'reconcile'> = {}): Promise<Rig> {
  // The OPC UA feed is the gateway's, not a feed simulator's (equipment-data/opcua-adapter.test.ts).
  const sim = await spawnFeedSimulator(spec.system as Exclude<FeedAdapterSpec['system'], 'OPCUA'>);
  sims.push(sim);
  const adapter = await registerAdapter(db, spec.system, adm);
  const base = sim.base;
  const worker = feedWorker(db.app, adapter.code, spec, () => Promise.resolve(ctxOf(adapter.actor)), { endpoint: `${base}/${spec.prefix}/v1`, timeoutMs: 400, ...opts });
  return {
    sim, adapter, worker,
    post: (path, body) => sim.post(path, body),
    fault: (fault, on, slowMs) => sim.fault(fault, on, slowMs),
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
  // Each published message has its own key: the source's head is the number of distinct keys it sent.
  const published = await r.sim.head();
  const received = (await count(db, 'select count(*) as n from platform.inbound_message where adapter_code = $1', [r.adapter.code]))
    + (await count(db, "select count(distinct idempotency_key) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED'", [r.adapter.code]));
  expect(received).toBe(published);
  // Every refusal left an alarm.
  expect(await count(db, "select count(*) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED' and alarm_id is null", [r.adapter.code])).toBe(0);
}

describe('the feed adapters against their simulators (DI-31)', () => {
  it('[DI-31] LMS: the contract reaches iam.receive_lms_qualification; the soak with every fault in turn reconciles (no silent loss)', async () => {
    const r = await rig(LMS_ADAPTER);
    const publish = (i: number, record: number) =>
      r.post('/lms/v1/qualifications', { personNumber, qualificationCode: QUALS[record], status: i % 3 === 2 ? 'REVOKED' : 'QUALIFIED', validFrom: '1700000000000000', validTo: null });
    await soak(r, publish, true);
    expect(await count(db, "select count(*) as n from iam.person_qualification where person_id = $1 and source_code = 'LMS'", [personId])).toBeGreaterThan(0);
  });

  it('[DI-31] LMS: a withdrawal through the worker framework carries the source reason into the audit trail (defect P6a-I1)', async () => {
    const r = await rig(LMS_ADAPTER);
    const code = QUALS[39] ?? '';
    const post = (status: string) => r.post('/lms/v1/qualifications', { personNumber, qualificationCode: code, status, validFrom: '1700000000000000', validTo: null });
    expect(await post('QUALIFIED')).toBe(201);
    expect(await settle(r)).toMatchObject({ accepted: 1, stopped: null });
    // The withdrawal updates the live row: the audit trail refuses an update without a reason (EBMR-AUDIT-002).
    expect(await post('REVOKED')).toBe(201);
    expect(await settle(r)).toMatchObject({ accepted: 1, refused: {}, stopped: null, caughtUp: true });
    const rows = (withdrawn: boolean) =>
      count(db, `select count(*) as n from iam.person_qualification where person_id = $1 and qualification_code = $2 and source_code = 'LMS' and withdrawn_at is ${withdrawn ? 'not ' : ''}null`, [personId, code]);
    expect(await rows(false)).toBe(0);
    expect(await rows(true)).toBe(1);
    expect(await count(db, `select count(*) as n from kernel.audit_event where action = 'UPDATE' and table_name like '%person_qualification'
                              and payload ->> 'reason_code' = 'INBOUND_MESSAGE' and payload ->> 'reason_text' like 'lms.qualification % from the LMS'`)).toBeGreaterThan(0);
  });

  it('[DI-31] QMS: deviation status, CAPA and change control reach the mirror; the soak with every fault in turn reconciles', async () => {
    const r = await rig(QMS_ADAPTER);
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
    const r = await rig(LIMS_ADAPTER);
    const publish = (i: number, record: number) =>
      r.post('/lims/v1/results', { sampleId: `S-${record.toString()}`, lotNumber: lotCode, testCode: 'ASSAY', specificationRef: 'SP-1', result: { value: `99.${i.toString()}0`, unit: '%' },
                                   conformance: 'CONFORMS', state: 'APPROVED', recordedAt: '1790000000000000' });
    await soak(r, publish, false);
    expect((await db.app.query("select raw_value from site.lims_sample_result where sample_id = 'S-1' order by source_timestamp desc limit 1")).rows).toEqual([{ raw_value: '99.10' }]);
  });

  it('[DI-31] CMMS: calibrations and work orders reach the equipment guard; the soak with every fault in turn reconciles', async () => {
    const r = await rig(CMMS_ADAPTER);
    expect(await r.post('/cmms/v1/calibrations', { equipmentCode, calibrationRef: 'CAL-CONTRACT', performedAt: (BigInt(Date.now()) * 1000n).toString(), result: 'PASS', dueOn: '2099-12-31' })).toBe(201);
    expect(await settle(r)).toMatchObject({ accepted: 1, synced: true });
    expect(await count(db, "select count(*) as n from plant.calibration where reference = 'CAL-CONTRACT'")).toBe(1);
    const publish = (i: number, record: number) =>
      r.post('/cmms/v1/work-orders', { equipmentCode, workOrder: `WO-${record.toString()}`, kind: 'PREVENTIVE', status: i % 2 === 0 ? 'OPEN' : 'COMPLETED', dueOn: '2099-12-31' });
    await soak(r, publish, true);
  });

  it('[DI-31] O-T12-1: the worker reconciles every closed hour after its grace by itself; a message the source published and the eBMR never received raises RECONCILIATION_MISMATCH; the health page shows the last period', async () => {
    const HOUR = 3_600_000_000n;
    const GRACE = 600_000_000n;
    const dbNow = async () => BigInt((await db.app.query<{ us: string }>('select tab.now_micros() as us')).rows[0]?.us ?? '0');
    let now = await dbNow();
    const r = await rig(LIMS_ADAPTER, { nowUs: () => Promise.resolve(now), reconcile: { everyMs: 0 } });
    const publish = (i: number) =>
      r.post('/lims/v1/results', { sampleId: `S-REC-${i.toString()}`, lotNumber: lotCode, testCode: 'ASSAY', specificationRef: 'SP-1', result: { value: `98.${i.toString()}0`, unit: '%' },
                                   conformance: 'CONFORMS', state: 'APPROVED', recordedAt: '1790000000000000' });
    for (const i of [1, 2]) expect(await publish(i)).toBe(201);
    // The hour the messages are in is still open: nothing is reconciled yet.
    const first = await settle(r);
    expect(first).toMatchObject({ accepted: 2, caughtUp: true, stopped: null, reconciled: { periods: [], error: null } });
    // The source publishes a third message the feed never delivers (the head moves on, the page stays empty).
    await r.fault('FEED_GAP', true);
    expect(await publish(3)).toBe(201);
    // The clock passes the end of the hour plus the grace: the closed hour is reconciled by the cycle itself.
    const hourEnd = (now / HOUR) * HOUR + HOUR;
    now = hourEnd + GRACE + 1n;
    const during = await r.worker.cycle();
    expect(during).toMatchObject({ fetched: 0, caughtUp: false, stopped: null });
    const periods = during.reconciled?.periods ?? [];
    expect(periods.length).toBeGreaterThanOrEqual(1);
    expect(periods.at(-1)).toMatchObject({ from: (hourEnd - HOUR).toString(), to: hourEnd.toString(), matched: false });
    const mismatches = await db.app.query<{ details: Record<string, string> }>("select details from platform.integration_alarm where adapter_code = $1 and kind = 'RECONCILIATION_MISMATCH'", [r.adapter.code]);
    expect(mismatches.rows).toEqual([{ details: expect.objectContaining({ periodFrom: (hourEnd - HOUR).toString(), periodTo: hourEnd.toString(), sourceCount: '3', receivedCount: '2' }) as unknown }]);
    // A reconciled period is not submitted again; the next hour closes later.
    await r.fault('FEED_GAP', false);
    const again = await settle(r);
    expect(again).toMatchObject({ caughtUp: true, reconciled: { periods: [], error: null } });
    expect(await count(db, 'select count(*) as n from platform.reconciliation_report where adapter_code = $1 and period_to = platform.epoch_us_to_timestamptz($2)', [r.adapter.code, hourEnd.toString()])).toBe(1);
    // The next hour (nothing published in it) closes and matches.
    now = hourEnd + HOUR + GRACE;
    const next = await r.worker.cycle();
    expect(next.reconciled?.periods).toEqual([expect.objectContaining({ from: hourEnd.toString(), to: (hourEnd + HOUR).toString(), matched: true })]);
    // The health page shows the last reconciled period.
    const qa = await server.asPersona('qaInvestigator');
    const health = valueOf(await qa.call(routes.integrations.adapters)).adapters.find((a) => a.adapterCode === r.adapter.code);
    expect(health?.lastReconciliation).toMatchObject({ matched: true, sourceCount: '0', receivedCount: '0' });
    expect(health?.lastReconciliation?.periodTo.us).toBe((hourEnd + HOUR).toString());
  });
});
