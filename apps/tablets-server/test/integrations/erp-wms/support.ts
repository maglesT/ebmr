/**
 * The ERP/WMS adapter against its simulators (Phase 6 slice 6a, builder A): a GMP server copy, two integration identities
 * created through the kernel's own access workflow (an INTEGRATION account in ERP_WMS_INTERFACE on its own SERVER
 * terminal, registered as an ERP_WMS adapter, DI-20), the ERP and WMS simulators as their own processes on free ports
 * (apps never import each other: the contract is the HTTP protocol), and a worker per feed. Fixtures that the receipt
 * tests prove elsewhere (an approved manufacturer) are arranged by the superuser.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { passwordActor } from '@ebmr/test-kit';
import { erpWmsWorker, ERP_WMS_ROLE, type ErpWmsFeed as FeedName } from '../../../src/features/integrations/adapters/erp-wms/index.ts';
import type { AdapterWorker } from '../../../src/features/integrations/adapters/framework.ts';
import type { TestDatabase } from '../../../../../packages/kernel/test/support/db.ts';
import { describeTestInterfaces, testInterface } from '../../../../../packages/kernel/test/support/validation.ts';
import { startServer, type TestServer } from '../../support/harness.ts';

const reason = <T extends ActorContext>(ctx: T): T => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: 'ERP/WMS adapter test set-up', correlationId: randomUUID() });

export interface AdapterIdentity {
  code: string;
  loginName: string;
  serviceKey: string;
  fingerprint: string;
  accountId: string;
}

/** An INTEGRATION account in `roleCode` on its own SERVER terminal, registered as an adapter of `system` (DI-20). */
export async function adapterIdentity(server: TestServer, name: string, system = 'ERP_WMS', roleCode = ERP_WMS_ROLE): Promise<AdapterIdentity> {
  const admin = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint);
  const owner = await passwordActor(server.db, server.seed.bootstrap.owner, server.seed.bootstrap.owner.fingerprint);
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const loginName = `adapter.${name.toLowerCase()}.${tag.toLowerCase()}`;
  const fingerprint = randomBytes(32).toString('hex');
  const created = await withCommand(server.db.app, reason(admin), async (c) => {
    const personId = await identity.createPerson(c, 'SYSTEM', `${name} adapter ${tag}`);
    const accountId = await identity.createAccount(c, { personId, loginName, kind: 'INTEGRATION' });
    const { secret } = await identity.issueInitialSecret(c, accountId, 'SERVICE_KEY');
    await identity.activateAccount(c, accountId);
    const grantId = await identity.requestRoleGrant(c, { accountId, roleCode, reason: `test set-up: ${name} adapter` });
    await identity.registerDevice(c, { code: `SRV-${name}-${tag}`, deviceClass: 'SERVER', site: 'SITE-1', fingerprint, description: `${name} adapter host (test)` });
    return { personId, accountId, secret, grantId };
  });
  await withCommand(server.db.app, reason(owner), (c) => identity.decideRoleGrant(c, created.grantId, true, `test set-up: ${name} adapter`));
  const code = `${name}-${tag}`;
  const ev = await identity.authenticate(server.db.authn, { method: 'SERVICE_KEY', identifier: loginName, secret: created.secret, deviceFingerprint: fingerprint, purpose: 'LOGIN' });
  const s = await identity.openSession(server.db.app, ev.authEventId, fingerprint);
  // Slice 7c (DI-06, kernel 1350): a GMP installation exchanges messages only with a described interface.
  if (server.kind === 'GMP') await describeTestInterfaces(server.db as unknown as TestDatabase, [testInterface(code, system as Parameters<typeof testInterface>[1])], owner);
  await withCommand(server.db.app, reason(admin), (c) =>
    c.query('select iam.register_integration_adapter($1, $2, $3, $4, $5)', [code, system, created.accountId, s.deviceId, `${name} feed (test)`]));
  await identity.endSession(server.db.app, s.sessionId);
  return { code, loginName, serviceKey: created.secret, fingerprint, accountId: created.accountId };
}

/** Opens the adapter's SERVICE_KEY session as its INTEGRATION actor in `roleCode`. */
export async function adapterActor(server: TestServer, a: AdapterIdentity, roleCode = ERP_WMS_ROLE): Promise<ActorContext> {
  const ev = await identity.authenticate(server.db.authn, { method: 'SERVICE_KEY', identifier: a.loginName, secret: a.serviceKey, deviceFingerprint: a.fingerprint, purpose: 'LOGIN' });
  const s = await identity.openSession(server.db.app, ev.authEventId, a.fingerprint);
  const { rows } = await server.db.app.query<{ person_id: string; legal_name: string }>(
    'select p.id as person_id, p.legal_name from iam.account a join iam.person p on p.id = a.person_id where a.id = $1', [a.accountId]);
  return {
    personId: rows[0]?.person_id ?? '', accountId: a.accountId, roleCode, sessionId: s.sessionId, deviceId: s.deviceId, source: 'INTEGRATION',
    siteZone: server.built.ctx.siteZone.current(), legalName: rows[0]?.legal_name ?? '',
  };
}

const FAULTS = ['FEED_GAP', 'STALE_VALUE', 'MALFORMED', 'DUPLICATE', 'OUT_OF_ORDER', 'WRONG_BATCH', 'LINK_CUT', 'SLOW', 'STALE_MIRROR'] as const;
export type Fault = (typeof FAULTS)[number];
export const ALL_FAULTS: readonly Fault[] = FAULTS;

/** A simulator process (apps/simulators/src/erp/serve.ts or wms/main.ts) and its HTTP control. */
export interface SimProcess {
  /** The feed's base URL (…/erp/v1 or …/wms/v1). */
  url: string;
  publish(path: string, body: unknown): Promise<{ status: number; body: unknown }>;
  fault(fault: Fault, on: boolean, slowMs?: number): Promise<void>;
  state<T>(): Promise<{ head: string; faults: string[]; model: T }>;
  close(): Promise<void>;
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) };
}

const SIM_ENTRY = { ERP: '../../../../simulators/src/erp/serve.ts', WMS: '../../../../simulators/src/wms/main.ts' } as const;

export async function spawnSimulator(kind: 'ERP' | 'WMS'): Promise<SimProcess> {
  const entry = fileURLToPath(new URL(SIM_ENTRY[kind], import.meta.url));
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', entry], { env: { ...process.env, EBMR_SIM_HTTP: '127.0.0.1:0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the ${kind} simulator did not start: ${out}`)), 30_000);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      const m = / on (http:\/\/[^ ]+) /.exec(out);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the ${kind} simulator exited (${String(code)}): ${out}`));
    });
  });
  const origin = new URL(url).origin;
  return {
    url,
    publish: (path, body) => postJson(`${url}${path}`, body),
    async fault(fault, on, slowMs) {
      const r = await postJson(`${origin}/api/fault`, { fault, on, ...(slowMs === undefined ? {} : { slowMs }) });
      if (r.status !== 200) throw new Error(`fault ${fault}: ${JSON.stringify(r.body)}`);
    },
    async state<T>() {
      return (await (await fetch(`${origin}/api/state`)).json()) as { head: string; faults: string[]; model: T };
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

export interface ErpWmsRig {
  server: TestServer;
  erp: { sim: SimProcess; worker: AdapterWorker; id: AdapterIdentity };
  wms: { sim: SimProcess; worker: AdapterWorker; id: AdapterIdentity };
  close(): Promise<void>;
}

/** The GMP server, both simulators (a SLOW answer takes 600 ms) and both workers (timeout 300 ms). */
export async function erpWmsRig(): Promise<ErpWmsRig> {
  const server = await startServer('GMP');
  const erpId = await adapterIdentity(server, 'ERP');
  const wmsId = await adapterIdentity(server, 'WMS');
  const [erpSim, wmsSim] = await Promise.all([spawnSimulator('ERP'), spawnSimulator('WMS')]);
  const worker = (feed: FeedName, id: AdapterIdentity, url: string) => erpWmsWorker(server.db.app, id.code, feed, () => adapterActor(server, id), { endpoint: url, timeoutMs: 300 });
  const erpWorker = worker('ERP', erpId, erpSim.url);
  const wmsWorker = worker('WMS', wmsId, wmsSim.url);
  return {
    server,
    erp: { sim: erpSim, worker: erpWorker, id: erpId },
    wms: { sim: wmsSim, worker: wmsWorker, id: wmsId },
    async close() {
      await erpWorker.stop();
      await wmsWorker.stop();
      await erpSim.close();
      await wmsSim.close();
      await server.close();
    },
  };
}

/** Superuser fixture (the register itself is proven in site-services): `manufacturer` approved for `material` at SITE-1. */
export async function approvedManufacturer(server: TestServer, material: string, manufacturer: string): Promise<void> {
  const c = await server.db.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    const { rows } = await c.query<{ id: string }>(
      `insert into site.approved_manufacturer (site_code, material_code, manufacturer_code, manufacturer_name, basis, proposed_by_person, proposed_by_account)
       select 'SITE-1', $1, $2, 'Fixture manufacturer', 'TEST FIXTURE: approved for the test', gen_random_uuid(), gen_random_uuid()
        where not site.manufacturer_approved('SITE-1', $1, $2) returning id`,
      [material, manufacturer],
    );
    if (rows[0]) {
      await c.query('insert into site.approved_manufacturer_approval (approved_manufacturer_id, signature_id, approved_by_person, approved_by_account) values ($1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())', [rows[0].id]);
    }
    await c.query('commit');
  } finally {
    c.release();
  }
}

/** Cycles the worker until it has handled the feed's head (or `max` cycles); returns every outcome. */
export async function drain(worker: AdapterWorker, sim: SimProcess, max = 20): Promise<{ result: string; errorClass?: string; code?: string }[]> {
  const outcomes: { result: string; errorClass?: string; code?: string }[] = [];
  for (let i = 0; i < max; i += 1) {
    const r = await worker.cycle();
    outcomes.push(...r.outcomes);
    if (!r.stoppedBy && BigInt(worker.health().cursor) >= BigInt((await sim.state()).head)) break;
  }
  return outcomes;
}

export const count = async (server: TestServer, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await server.db.admin.query<{ n: string }>(sql, params)).rows[0]?.n ?? -1);

export const goodsReceipt = (deliveryId: string, materialCode: string, batches: [string, string, string, string][]) => ({
  deliveryId, materialCode, supplierCode: 'SUP-1', receivedAt: '1800000000000000',
  supplierBatches: batches.map(([supplierLot, manufacturerCode, containers, kg]) => ({ supplierLot, manufacturerCode, containers, quantity: { value: kg, unit: 'kg' }, expiryDate: '2030-06-30' })),
});
