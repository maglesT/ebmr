/**
 * The adapter feeds of the reference site (slice 7d; D-P7-4): the LMS, QMS, LIMS, CMMS and EMS simulators, each its
 * own process (apps/simulators), published to as the source system publishes (the load driver plays the source), and
 * read by the server's own adapter workers (the 6a framework, feedWorker) as registered INTEGRATION identities, every
 * `pollEverySec`. The data points of the batches (the OPC UA tags at 1 Hz) go through the EMS feed into the series store
 * the OPC UA feed writes too (plant.series), one chunk per tag and poll (see the record's notes). At the end every
 * worker is settled and the period reconciled: the source's count and checksum against what the eBMR accepted plus what
 * it refused with an alarm (SLO-4).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { withCommand } from '@ebmr/kernel';
import { plant } from '@ebmr/recipe-core';
import { passwordActor } from '@ebmr/test-kit';
import { withReason } from '../../../packages/kernel/test/identity/seed.ts';
import { ctxOf, registerAdapter, setMirrorMode, type Administration, type TestAdapter } from '../../../packages/kernel/test/integrations/support.ts';
import type { TestDatabase } from '../../../packages/kernel/test/support/db.ts';
import { CMMS_ADAPTER } from '../../../apps/tablets-server/src/features/integrations/adapters/cmms/index.ts';
import { EMS_ADAPTER } from '../../../apps/tablets-server/src/features/integrations/adapters/ems/index.ts';
import { feedWorker, type AdapterWorker, type FeedAdapterSpec } from '../../../apps/tablets-server/src/features/integrations/adapters/framework.ts';
import { LIMS_ADAPTER } from '../../../apps/tablets-server/src/features/integrations/adapters/lims/index.ts';
import { LMS_ADAPTER } from '../../../apps/tablets-server/src/features/integrations/adapters/lms/index.ts';
import { QMS_ADAPTER } from '../../../apps/tablets-server/src/features/integrations/adapters/qms/index.ts';
import { spawnFeedSimulator, type FeedSimProcess } from '../../../apps/tablets-server/test/integrations/feed-simulator.ts';
import { actorOf } from '../../../apps/tablets-server/test/support/gmp-world.ts';
import { grantedPerson } from '../../../apps/tablets-server/test/support/granted-person.ts';
import type { TestServer } from '../../../apps/tablets-server/test/support/harness.ts';
import type { FeedResult } from './report.ts';
import type { Site } from './site.ts';

type FeedName = 'LMS' | 'QMS' | 'LIMS' | 'CMMS' | 'EMS';
const SPECS: Record<FeedName, FeedAdapterSpec> = { LMS: LMS_ADAPTER, QMS: QMS_ADAPTER, LIMS: LIMS_ADAPTER, CMMS: CMMS_ADAPTER, EMS: EMS_ADAPTER };

export interface Feed {
  system: FeedName;
  sim: FeedSimProcess;
  adapter: TestAdapter;
  worker: AdapterWorker;
  published: number;
  duplicates: number;
  /** One publication of this feed's kind (the EMS: one chunk per room tag). */
  publish(): Promise<void>;
}

export interface Feeds {
  feeds: Feed[];
  fromUs: bigint;
  /** Runs one cycle of every worker (errors counted, never thrown: a transport stop is retried by the next cycle). */
  cycle(): Promise<void>;
  /** Settles every worker, reconciles the period and counts what the eBMR holds (SLO-4). */
  finish(): Promise<FeedResult[]>;
  close(): Promise<void>;
}

const count = async (db: TestDatabase, sql: string, params: unknown[] = []) => Number((await db.app.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);

export async function startFeeds(site: Site, systems: readonly FeedName[], opts: { emsTags: number; samplesPerChunk: number }): Promise<Feeds> {
  const db = site.db as unknown as TestDatabase;
  const server = { kind: 'GMP', database: site.database, db: site.db, seed: site.seed } as unknown as TestServer;
  const b = site.seed.bootstrap;
  const adm: Administration = { admin: await passwordActor(site.db, b.admin, b.admin.fingerprint), owner: await passwordActor(site.db, b.owner, b.owner.fingerprint), authn: site.db.authn };
  const steward = await actorOf(server, 'steward');
  // What the feeds' messages name: a person with an employee number, qualification types, a lot, a press, EMS rooms.
  const personNumber = `EMP-${randomBytes(3).toString('hex').toUpperCase()}`;
  const personId = (await actorOf(server, 'operator1')).personId;
  await withCommand(site.db.admin, withReason(adm.admin), (c) => c.query('update iam.person set employee_ref = $1 where id = $2', [personNumber, personId]));
  const quals = Array.from({ length: 20 }, (_, i) => `SOP-L${String(i).padStart(2, '0')}`);
  const coordinator = await grantedPerson(server, 'TRAINING_COORDINATOR', 'Tara Load Coordinator');
  const qualActor = await passwordActor(site.db, coordinator, site.seed.terminals.find((t) => t.code === 'PC-QA-01')?.fingerprint ?? '');
  await withCommand(site.db.app, withReason(qualActor), async (c) => {
    for (const q of quals) await c.query("select iam.create_qualification_type($1, 'Load SOP', 'load run SOP')", [q]);
  });
  const classCode = `CL-${randomBytes(3).toString('hex').toUpperCase()}`;
  const equipmentCode = `EQ-${randomBytes(3).toString('hex').toUpperCase()}`;
  const rooms: string[] = [];
  await withCommand(site.db.app, withReason(steward), async (c) => {
    await plant.defineEquipmentClass(c, { code: classCode, description: 'load class', kind: 'PROCESS', cleanHold: '72 hours', dirtyHold: '48 hours', calibrationRequired: true });
    await plant.defineEquipment(c, { code: equipmentCode, name: 'Load press', classCode });
    for (let i = 0; i < Math.max(1, Math.ceil(opts.emsTags / 2)); i += 1) {
      const code = `RM-LOAD-${String(i + 1).padStart(2, '0')}-${randomBytes(2).toString('hex').toUpperCase()}`;
      await plant.defineArea(c, { code, kind: 'ROOM', name: `Load room ${String(i + 1)}` });
      rooms.push(code);
    }
  });
  const lotCode = `L-${randomBytes(3).toString('hex').toUpperCase()}`;
  const c = await site.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query(
      `insert into site.material_lot (id, site_code, lot_code, material_code, material_name, material_kind, received_quantity, unit, expires_at, received_by_person, received_by_account, correlation_id)
       values ($1, 'SITE-1', $2, 'M-LOAD', 'Load material', 'EXCIPIENT', 10, 'kg', '2030-01-01T00:00:00Z', $3, $3, $3)`,
      [randomUUID(), lotCode, randomUUID()],
    );
    await c.query('commit');
  } finally {
    c.release();
  }
  for (const cls of ['LMS_QUALIFICATION', 'QMS_STATUS', 'CMMS_CALIBRATION', 'CMMS_MAINTENANCE']) await setMirrorMode(db, cls, 'MIRROR', adm);
  const fromUs = BigInt((await site.db.app.query<{ us: string }>("select (extract(epoch from clock_timestamp()) * 1000000)::bigint::text as us")).rows[0]?.us ?? '0') - 5_000_000n;
  const feeds: Feed[] = [];
  let seq = 0;
  for (const system of systems) {
    const sim = await spawnFeedSimulator(system);
    const adapter = await registerAdapter(db, system, adm);
    const worker = feedWorker(site.db.app, adapter.code, SPECS[system], () => Promise.resolve(ctxOf(adapter.actor)), { endpoint: `${sim.base}/${SPECS[system].prefix}/v1`, timeoutMs: 5000, pageSize: 500 });
    const post = async (path: string, body: unknown) => {
      const s = await sim.post(path, body);
      if (s !== 201) throw new Error(`${system} ${path}: ${String(s)}`);
      f.published += 1;
    };
    const f: Feed = {
      system, sim, adapter, worker, published: 0, duplicates: 0,
      async publish() {
        seq += 1;
        const i = seq;
        switch (system) {
          case 'LMS':
            return post('/lms/v1/qualifications', { personNumber, qualificationCode: quals[i % quals.length], status: i % 5 === 4 ? 'REVOKED' : 'QUALIFIED', validFrom: '1700000000000000', validTo: null });
          case 'QMS':
            return post('/qms/v1/deviations', { deviationRef: `QD-L${String(i)}`, status: i % 2 === 0 ? 'OPEN' : 'CLOSED', lotNumbers: [lotCode] });
          case 'LIMS':
            return post('/lims/v1/results', { sampleId: `S-L${String(i)}`, lotNumber: lotCode, testCode: 'ASSAY', specificationRef: 'SP-1', result: { value: `99.${String(i % 10)}0`, unit: '%' }, conformance: 'CONFORMS', state: 'APPROVED', recordedAt: '1790000000000000' });
          case 'CMMS':
            return post('/cmms/v1/work-orders', { equipmentCode, workOrder: `WO-L${String(i)}`, kind: 'PREVENTIVE', status: i % 2 === 0 ? 'OPEN' : 'COMPLETED', dueOn: '2099-12-31' });
          case 'EMS':
            for (const room of rooms) {
              for (const tag of ['room.temp_C', 'room.rh_pct']) {
                const samples = Array.from({ length: opts.samplesPerChunk }, (_, k) => ({ raw: tag === 'room.temp_C' ? `2${String((i + k) % 10)}.${String(k % 10)}` : `4${String((i + k) % 10)}.0` }));
                await post('/ems/v1/samples', { roomCode: room, tag, samples });
              }
            }
            return;
        }
      },
    };
    feeds.push(f);
  }
  return {
    feeds,
    fromUs,
    async cycle() {
      await Promise.all(feeds.map(async (f) => {
        try {
          const r = await f.worker.cycle();
          f.duplicates += r.duplicates;
        } catch {
          // A transport stop: the next cycle takes it up again.
        }
      }));
    },
    async finish() {
      const out: FeedResult[] = [];
      for (const f of feeds) {
        let caught = false;
        for (let i = 0; i < 40 && !caught; i += 1) {
          const r = await f.worker.cycle();
          f.duplicates += r.duplicates;
          caught = r.caughtUp && r.stopped === null;
        }
        const toUs = BigInt((await site.db.app.query<{ us: string }>("select (extract(epoch from clock_timestamp()) * 1000000)::bigint::text as us")).rows[0]?.us ?? '0') + 5_000_000n;
        const rec = await f.worker.reconcile(fromUs, toUs);
        const head = await f.sim.head();
        const accepted = await count(db, 'select count(*) as n from platform.inbound_message where adapter_code = $1', [f.adapter.code]);
        const refused = await count(db, "select count(distinct idempotency_key) as n from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED'", [f.adapter.code]);
        out.push({ system: f.system, published: head, received: accepted + refused, refused, duplicates: f.duplicates, reconciled: rec.matched && caught });
      }
      return out;
    },
    async close() {
      for (const f of feeds) {
        await f.worker.stop().catch(() => undefined);
        await f.sim.close();
      }
    },
  };
}
