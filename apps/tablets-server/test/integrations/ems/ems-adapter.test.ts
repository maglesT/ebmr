/**
 * The EMS adapter against its simulator process (Phase 6 slice 6b, builder B; DI-31, DI-32, DI-49; D-P6b-6): room
 * temperature and humidity chunks land in plant.series as the EMS sent them and the room conditions show the latest
 * sample; a feed gap is seen by the worker (nothing fetched, not caught up) and caught up afterwards, and the EMS's own
 * FEED_GAP occurrence lands on the plant alarm log against the room; the soak with every fault in turn reconciles (no
 * silent loss). The worker runs as a registered INTEGRATION identity of system EMS against a copy of the GMP template.
 * The EMS has no mirror data class (D-P6b-B-8): a cycle never reports `synced`.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '@ebmr/kernel';
import { plant } from '@ebmr/recipe-core';
import { passwordActor } from '@ebmr/test-kit';
import { withReason } from '../../../../../packages/kernel/test/identity/seed.ts';
import { count, ctxOf, registerAdapter, type Administration, type TestAdapter } from '../../../../../packages/kernel/test/integrations/support.ts';
import type { TestDatabase } from '../../../../../packages/kernel/test/support/db.ts';
import { EMS_ADAPTER } from '../../../src/features/integrations/adapters/ems/index.ts';
import { feedWorker, type AdapterWorker, type CycleReport } from '../../../src/features/integrations/adapters/framework.ts';
import { actorOf } from '../../support/gmp-world.ts';
import { startServer, type TestServer } from '../../support/harness.ts';
import { spawnFeedSimulator, type FeedSimProcess } from '../feed-simulator.ts';

/** The simulators' faults (apps/simulators/src/system-feed/feed.ts FEED_FAULTS), switched on in turn. */
const FEED_FAULTS = ['FEED_GAP', 'STALE_VALUE', 'MALFORMED', 'DUPLICATE', 'OUT_OF_ORDER', 'WRONG_BATCH', 'LINK_CUT', 'SLOW', 'STALE_MIRROR'] as const;
type FeedFault = (typeof FEED_FAULTS)[number];
const TAGS = ['room.temp_C', 'room.rh_pct'] as const;

let server: TestServer;
let db: TestDatabase;
let adm: Administration;
const rooms: { code: string; id: string }[] = [];
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
  const steward = await actorOf(server, 'steward');
  await withCommand(db.app, withReason(steward), async (c) => {
    for (let i = 0; i < 4; i++) {
      const code = `RM-EMS-${randomBytes(3).toString('hex').toUpperCase()}`;
      rooms.push({ code, id: await plant.defineArea(c, { code, kind: 'ROOM', name: `EMS test room ${i.toString()}` }) });
    }
  });
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

async function rig(): Promise<Rig> {
  const sim = await spawnFeedSimulator('EMS');
  sims.push(sim);
  const adapter = await registerAdapter(db, 'EMS', adm);
  const worker = feedWorker(db.app, adapter.code, EMS_ADAPTER, () => Promise.resolve(ctxOf(adapter.actor)), { endpoint: `${sim.base}/ems/v1`, timeoutMs: 400 });
  return { sim, adapter, worker, post: (path, body) => sim.post(path, body), fault: (fault, on, slowMs) => sim.fault(fault, on, slowMs) };
}

/** Rooms 0 and 1 for the first two tests, 2 and 3 for the soak (a new simulator numbers a room's chunks from 1 again,
 *  which the database refuses for a room that already holds those chunks, EBMR-EQD-004). */
const room = (n: number) => rooms[n] as { code: string; id: string };
const soakRoom = (n: number) => rooms[2 + (n % 2)] as { code: string; id: string };
const samples = (roomCode: string, tag: string, ...raw: string[]) => ({ roomCode, tag, samples: raw.map((r) => ({ raw: r })) });
const alarms = (r: Rig, kind: string) => count(db, 'select count(*) as n from platform.integration_alarm where adapter_code = $1 and kind = $2', [r.adapter.code, kind]);
const refused = (r: Rig, cls: string) => count(db, "select count(*) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED' and error_class = $2", [r.adapter.code, cls]);
const conditions = async (code: string) =>
  (await db.app.query<{ r: { tags: { tag: string; unit: string; sample: { raw: string; value: string | null } | null }[]; openAlarms: { source: string; alarmCode: string }[] } }>(
    'select plant.room_conditions($1) as r', [code])).rows[0]?.r;

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
 * The soak of feed-adapters.test.ts for the EMS (no mirror: never synced): three clean chunks, then each fault on in
 * turn with two more chunks (the first a newer chunk of the first room and tag under STALE_VALUE), the fault off and the
 * worker settled; at the end the whole period reconciles and every published key was accepted or refused with an alarm.
 * STALE_VALUE here only ages the envelope's source time: a series chunk carries its own sample times (the database
 * refuses a chunk that overlaps a recorded one, EBMR-EQD-005), so the chunk is received, not refused as STALE.
 */
async function soak(r: Rig, publish: (i: number, record: number) => Promise<number>): Promise<void> {
  const from = BigInt(Date.now() - 5000) * 1000n;
  let i = 0;
  for (; i < 3; i++) expect(await publish(i, i)).toBe(201);
  expect(await settle(r)).toMatchObject({ accepted: 3, stopped: null, caughtUp: true, synced: false });
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
        break;
      case 'STALE_MIRROR':
        expect(during, f).toMatchObject({ heartbeat: false, caughtUp: true, synced: false });
        break;
      case 'DUPLICATE':
        expect(during.duplicates, f).toBeGreaterThan(0);
        break;
      default:
        break;
    }
    await r.fault(f, false);
    expect(await settle(r), f).toMatchObject({ stopped: null, caughtUp: true, synced: false });
    if (f === 'STALE_VALUE') expect(await refused(r, 'STALE'), f).toBe(before.stale);
    if (f === 'MALFORMED') expect(await refused(r, 'MALFORMED'), f).toBe(before.malformed + 2);
    if (f === 'WRONG_BATCH') expect(await refused(r, 'WRONG_IDENTITY'), f).toBe(before.wrong + 2);
    if (f === 'OUT_OF_ORDER') expect(await alarms(r, 'OUT_OF_ORDER'), f).toBeGreaterThan(before.ooo);
  }
  const rec = await r.worker.reconcile(from, BigInt(Date.now() + 5000) * 1000n);
  expect(rec.matched).toBe(true);
  const published = await r.sim.head();
  const received = (await count(db, 'select count(*) as n from platform.inbound_message where adapter_code = $1', [r.adapter.code]))
    + (await count(db, "select count(distinct idempotency_key) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED'", [r.adapter.code]));
  expect(received).toBe(published);
  expect(await count(db, "select count(*) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED' and alarm_id is null", [r.adapter.code])).toBe(0);
}

describe('the EMS adapter against its simulator (DI-31, DI-32, DI-49)', () => {
  it('[DI-31][DI-32] EMS: room temperature and humidity chunks land in plant.series as received; the room conditions show the latest sample', async () => {
    const r = await rig();
    const rm = room(0);
    expect(await r.post('/ems/v1/samples', samples(rm.code, 'room.temp_C', '21.50', '2.18E1'))).toBe(201);
    expect(await r.post('/ems/v1/samples', samples(rm.code, 'room.rh_pct', '45.0'))).toBe(201);
    expect(await r.post('/ems/v1/samples', samples(rm.code, 'room.temp_C', '22.3'))).toBe(201);
    expect(await settle(r)).toMatchObject({ accepted: 3, refused: {}, stopped: null, caughtUp: true, synced: false });
    const { rows } = await db.admin.query<{ source: string; subject_kind: string; tag: string; unit: string; chunk_no: string; sample_count: number; samples: { raw: string; value: string | null; status: string }[] }>(
      'select source, subject_kind, tag, unit, chunk_no::text, sample_count, samples from plant.series where area_id = $1 order by tag, chunk_no', [rm.id]);
    expect(rows.map((x) => [x.source, x.subject_kind, x.tag, x.unit, x.chunk_no, x.sample_count])).toEqual([
      ['EMS', 'AREA', 'room.rh_pct', '%RH', '1', 1],
      ['EMS', 'AREA', 'room.temp_C', 'degC', '1', 2],
      ['EMS', 'AREA', 'room.temp_C', 'degC', '2', 1],
    ]);
    // DI-32: the raw text as the sensor wrote it, the shown value exactly that value.
    expect(rows[1]?.samples.map((s) => [s.raw, s.value, s.status])).toEqual([['21.50', '21.5', '0x00000000'], ['2.18E1', '21.8', '0x00000000']]);
    const cond = await conditions(rm.code);
    expect(cond?.tags.map((t) => [t.tag, t.unit, t.sample?.raw, t.sample?.value])).toEqual(
      expect.arrayContaining([['room.temp_C', 'degC', '22.3', '22.3'], ['room.rh_pct', '%RH', '45.0', '45']]),
    );
  });

  it('[DI-31] EMS feed gap alarms', async () => {
    const r = await rig();
    const rm = room(1);
    expect(await r.post('/ems/v1/samples', samples(rm.code, 'room.temp_C', '20.0'))).toBe(201);
    expect(await settle(r)).toMatchObject({ accepted: 1, caughtUp: true });
    // The feed delivers nothing while the room keeps reporting and its humidity sensor stops (the EMS's FEED_GAP).
    await r.fault('FEED_GAP', true);
    expect(await r.post('/ems/v1/samples', samples(rm.code, 'room.temp_C', '20.1'))).toBe(201);
    expect(await r.post('/ems/v1/sensor-gap', { roomCode: rm.code, tag: 'room.rh_pct', on: true })).toBe(201);
    expect(await r.post('/ems/v1/samples', samples(rm.code, 'room.temp_C', '20.2'))).toBe(201);
    for (let k = 0; k < 2; k++) expect(await r.worker.cycle()).toMatchObject({ fetched: 0, caughtUp: false, synced: false, stopped: null });
    expect(r.worker.health()).toMatchObject({ head: '4', cursor: '1' });
    await r.fault('FEED_GAP', false);
    expect(await settle(r)).toMatchObject({ fetched: 3, accepted: 3, caughtUp: true, stopped: null });
    const gap = (await db.admin.query<{ source: string; subject_kind: string; area_id: string; tag: string; limit_kind: string; limit_value: string | null }>(
      "select source, subject_kind, area_id, tag, limit_kind, limit_value from plant.alarm where alarm_code = 'FEED_GAP' and area_id = $1", [rm.id])).rows;
    expect(gap).toEqual([{ source: 'EMS', subject_kind: 'AREA', area_id: rm.id, tag: 'room.rh_pct', limit_kind: 'STATE', limit_value: null }]);
    expect((await conditions(rm.code))?.openAlarms).toEqual([expect.objectContaining({ source: 'EMS', alarmCode: 'FEED_GAP' })]);
    // Delivered late but complete and in order: the database sees no sequence gap from the feed gap itself.
    expect(await alarms(r, 'SEQUENCE_GAP')).toBe(0);
    // A message refused in the stream leaves a hole among the accepted sequence numbers: the next accepted one raises
    // the framework's SEQUENCE_GAP integration alarm next to the refusal's own alarm.
    await r.fault('MALFORMED', true);
    expect(await r.post('/ems/v1/samples', samples(rm.code, 'room.temp_C', '20.3'))).toBe(201);
    await r.fault('MALFORMED', false);
    expect(await r.post('/ems/v1/samples', samples(rm.code, 'room.temp_C', '20.4'))).toBe(201);
    expect(await settle(r)).toMatchObject({ accepted: 1, refused: { MALFORMED: 1 }, caughtUp: true });
    expect(await alarms(r, 'MALFORMED')).toBe(1);
    expect(await alarms(r, 'SEQUENCE_GAP')).toBe(1);
    // The sensor reports again: the occurrence is cleared at the source (it stays open in the eBMR until a person acknowledges it, DI-49).
    expect(await r.post('/ems/v1/sensor-gap', { roomCode: rm.code, tag: 'room.rh_pct', on: false })).toBe(201);
    expect(await settle(r)).toMatchObject({ accepted: 1, caughtUp: true });
    expect(await count(db, "select count(*) as n from plant.alarm_transition t join plant.alarm a on a.id = t.alarm_id where a.area_id = $1 and a.alarm_code = 'FEED_GAP' and t.transition = 'CLEARED'", [rm.id])).toBe(1);
  });

  it('[DI-31] EMS: the soak with every fault in turn reconciles (no silent loss)', async () => {
    const r = await rig();
    // Record n is one sensor stream: the rooms in turn, then the tags.
    const publish = (i: number, record: number) =>
      r.post('/ems/v1/samples', samples(soakRoom(record).code, TAGS[Math.floor(record / 2) % TAGS.length] ?? 'room.temp_C', `${(20 + (i % 5)).toString()}.${(i % 10).toString()}`));
    await soak(r, publish);
    expect(await count(db, "select count(*) as n from plant.series where source = 'EMS' and area_id = any($1::uuid[])", [[soakRoom(0).id, soakRoom(1).id]])).toBeGreaterThan(3);
  });
});
