/**
 * The connected installation of GB-T-03 (Phase 6 slice 6j-b; D-P6-7): the site's external systems as their simulators,
 * each its own process (apps never import each other: the contract is the HTTP protocol), and the server's adapters on
 * them. The ERP and WMS (ERP_WMS), the LMS, the CMMS and the serialisation L3/L4 system feed the eBMR through the 6a
 * worker framework, each as a registered INTEGRATION identity (DI-20) of its own system; their data classes run as
 * MIRROR, so a stale mirror refuses what depends on it (fails closed, EBMR-INT-010).
 *
 * The adapters run on the server's worker code (adapters/framework.ts, erp-wms, the LMS, CMMS and L3 definitions), but
 * the driver runs each worker's cycle at fixed points of the scenario (`sync`) instead of on the server's 5 s timer: the
 * golden clock stands still between the driver's ticks, and a timer would make the number and the order of the
 * synchronisations depend on the speed of the machine. What a cycle does is the worker's own.
 *
 * The feed simulators run under the golden clock library (EBMR_GOLDEN_CLOCK_LIB, the preload the golden cluster runs
 * with, on the same timestamp file): the times they stamp (feed messages, the L3 pool's issue) are the database's.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ActorContext } from '@ebmr/kernel';
import { CMMS_ADAPTER } from '../../../src/features/integrations/adapters/cmms/index.ts';
import { erpWmsWorker } from '../../../src/features/integrations/adapters/erp-wms/index.ts';
import { feedWorker, type AdapterWorker, type CycleReport } from '../../../src/features/integrations/adapters/framework.ts';
import { L3_ADAPTER } from '../../../src/features/integrations/adapters/l3/index.ts';
import { LMS_ADAPTER } from '../../../src/features/integrations/adapters/lms/index.ts';
import { FEED_ADAPTER_ROLE } from '../../../src/features/integrations/adapters/start.ts';
import { setMirrorMode } from '../../../../../packages/kernel/test/integrations/support.ts';
import type { TestDatabase } from '../../../../../packages/kernel/test/support/db.ts';
import { adapterActor, adapterIdentity, type AdapterIdentity } from '../../integrations/erp-wms/support.ts';
import { FAKETIME_FILE } from '../clock.ts';
import type { GoldenWorld } from '../gb-t-01/world.ts';

type Json = Record<string, unknown>;

/** The preload library of the golden cluster (tools/dev-env/golden-clock), for the simulators' clocks. */
export const GOLDEN_CLOCK_LIB = process.env['EBMR_GOLDEN_CLOCK_LIB'] ?? '';

export type SimKind = 'ERP' | 'WMS' | 'LMS' | 'CMMS' | 'L3';

const SIM: Record<SimKind, { entry: string; listen: string; started: RegExp; prefix: string }> = {
  ERP: { entry: 'erp/serve.ts', listen: 'EBMR_SIM_HTTP', started: / on (http:\/\/[^ ]+) /, prefix: '' },
  WMS: { entry: 'wms/main.ts', listen: 'EBMR_SIM_HTTP', started: / on (http:\/\/[^ ]+) /, prefix: '' },
  LMS: { entry: 'lms/main.ts', listen: 'EBMR_LMS_HTTP', started: /http port (\d+)/, prefix: '/lms/v1' },
  CMMS: { entry: 'cmms/main.ts', listen: 'EBMR_CMMS_HTTP', started: /http port (\d+)/, prefix: '/cmms/v1' },
  L3: { entry: 'serialisation/main.ts', listen: 'EBMR_L3_HTTP', started: /http port (\d+)/, prefix: '/l3/v1' },
};

export interface Sim {
  kind: SimKind;
  /** The simulator's origin. */
  origin: string;
  /** The feed's base URL (the adapter's endpoint). */
  feed: string;
  /** A request to the simulator under its feed prefix (`path` starts with '/'). */
  call<T = Json>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

/** Starts simulator `kind` on a free loopback port, its clock the golden clock when the library is given. */
export async function spawnSim(kind: SimKind): Promise<Sim> {
  const s = SIM[kind];
  const entry = fileURLToPath(new URL(`../../../../simulators/src/${s.entry}`, import.meta.url));
  const clock = GOLDEN_CLOCK_LIB !== '' ? { LD_PRELOAD: GOLDEN_CLOCK_LIB, FAKETIME_TIMESTAMP_FILE: FAKETIME_FILE } : {};
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', entry], { env: { ...process.env, ...clock, [s.listen]: '127.0.0.1:0', EBMR_SIM_SEED: '42' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const origin = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the ${kind} simulator did not start: ${out}`)), 60_000);
    const onData = (d: Buffer): void => {
      out += d.toString('utf8');
      const m = s.started.exec(out);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(/^\d+$/.test(m[1]) ? `http://127.0.0.1:${m[1]}` : new URL(m[1]).origin);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the ${kind} simulator exited (${String(code)}): ${out}`));
    });
  });
  const feed = kind === 'ERP' ? `${origin}/erp/v1` : kind === 'WMS' ? `${origin}/wms/v1` : `${origin}${s.prefix}`;
  return {
    kind,
    origin,
    feed,
    async call<T = Json>(method: 'GET' | 'POST', path: string, body?: unknown) {
      const res = await fetch(`${feed}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
      const text = await res.text();
      return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as T };
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }),
  };
}

/** The mirror data classes GB-T-03 runs as MIRROR (each one's system feeds it). */
export const MIRRORED_CLASSES = ['ERP_ITEM_MASTER', 'ERP_LOT_STATUS', 'WMS_STOCK', 'LMS_QUALIFICATION', 'CMMS_CALIBRATION', 'CMMS_MAINTENANCE', 'L3_SERIAL_STATUS'] as const;

export interface Adapter {
  name: 'ERP' | 'WMS' | 'LMS' | 'CMMS' | 'L3';
  id: AdapterIdentity;
  worker: AdapterWorker;
  sim: Sim;
}

export interface Connected {
  adapters: Record<Adapter['name'], Adapter>;
  sim(kind: SimKind): Sim;
  /**
   * One cycle of every adapter, in a fixed order (ERP, WMS, LMS, CMMS, L3), until each is caught up with nothing stopped
   * (at most four cycles each); throws when one is not. Returns what each accepted and refused.
   */
  sync(): Promise<Record<string, { accepted: number; refused: number; synced: boolean }>>;
  close(): Promise<void>;
}

/** Cycles `w` until caught up with nothing stopped (at most `n` cycles). */
export async function settle(w: AdapterWorker, n = 4): Promise<CycleReport> {
  let last: CycleReport | undefined;
  for (let i = 0; i < n; i++) {
    last = await w.cycle();
    if (last.caughtUp && last.stopped === null) return last;
  }
  throw new Error(`adapter ${w.def.code} did not catch up: ${JSON.stringify(last)}`);
}

/**
 * The simulators, the adapter identities and their workers, and the mirror data classes switched to MIRROR (a
 * configuration change of the site's owner under its change record, as kernel/test/integrations/support.ts makes it).
 */
export async function connect(w: GoldenWorld): Promise<Connected> {
  const server = w.server;
  const sims = await Promise.all((['ERP', 'WMS', 'LMS', 'CMMS', 'L3'] as const).map((k) => spawnSim(k)));
  const simOf = (k: SimKind): Sim => {
    const s = sims.find((x) => x.kind === k);
    if (!s) throw new Error(`no ${k} simulator`);
    return s;
  };
  const adapters = {} as Record<Adapter['name'], Adapter>;
  try {
    for (const name of ['ERP', 'WMS'] as const) {
      const id = await adapterIdentity(server, name);
      const worker = erpWmsWorker(server.db.app, id.code, name, () => adapterActor(server, id), { endpoint: simOf(name).feed, timeoutMs: 5000 });
      adapters[name] = { name, id, worker, sim: simOf(name) };
    }
    for (const [name, spec] of [['LMS', LMS_ADAPTER], ['CMMS', CMMS_ADAPTER], ['L3', L3_ADAPTER]] as const) {
      const id = await adapterIdentity(server, name, name, FEED_ADAPTER_ROLE);
      const open = (): Promise<ActorContext> => adapterActor(server, id, FEED_ADAPTER_ROLE);
      const worker = feedWorker(server.db.app, id.code, spec, open, { endpoint: simOf(name).feed, timeoutMs: 5000 });
      adapters[name] = { name, id, worker, sim: simOf(name) };
    }
    const db = server.db as unknown as TestDatabase;
    for (const cls of MIRRORED_CLASSES) await setMirrorMode(db, cls, 'MIRROR');
  } catch (e) {
    await Promise.all(sims.map((s) => s.close()));
    throw e;
  }
  return {
    adapters,
    sim: simOf,
    async sync() {
      const out: Record<string, { accepted: number; refused: number; synced: boolean }> = {};
      for (const name of ['ERP', 'WMS', 'LMS', 'CMMS', 'L3'] as const) {
        const r = await settle(adapters[name].worker);
        out[name] = { accepted: r.accepted, refused: Object.values(r.refused).reduce((a, b) => a + (b ?? 0), 0), synced: r.synced };
      }
      return out;
    },
    async close() {
      for (const a of Object.values(adapters)) await a.worker.stop();
      await Promise.all(sims.map((s) => s.close()));
    },
  };
}
