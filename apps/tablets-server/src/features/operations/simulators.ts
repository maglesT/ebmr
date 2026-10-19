/**
 * The simulators' test console (Phase 7 slice 7g-4; decision 0025 point 2): each simulator of apps/simulators runs as a
 * child process of the server (an app never imports another, .dependency-cruiser.cjs), on a free loopback port, and is
 * driven over its own control API: GET /api/state (the faults on), POST /api/fault {fault, on}. SIMULATOR, DEMO-ONLY:
 * the routes refuse it on a GMP installation that is not a demo one (tablets 1485, EBMR-OPS-010) before anything starts.
 *
 * The fault names repeat the simulators' own lists (FEED_FAULTS of system-feed/feed.ts and erp/feed.ts, L3_FAULTS of
 * serialisation/model.ts with its UNAVAILABLE, OPCUA_FAULTS of opcua/server.ts); a simulator refuses a name it does not
 * know, and the screen shows that refusal.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { SimulatorCode, SimulatorView } from '@ebmr/api-contract';

const SIMULATORS_DIR = new URL('../../../../simulators/', import.meta.url).pathname;

const FEED_FAULTS = ['FEED_GAP', 'STALE_VALUE', 'MALFORMED', 'DUPLICATE', 'OUT_OF_ORDER', 'WRONG_BATCH', 'LINK_CUT', 'SLOW', 'STALE_MIRROR'] as const;
const L3_FAULTS = ['UNAVAILABLE', 'MISSING_EVENTS', 'DUPLICATE_SERIAL', 'STALE_REPORT', 'AGGREGATION_MISMATCH', 'DUPLICATE', 'OUT_OF_ORDER', 'MALFORMED', 'WRONG_BATCH', 'STALE_VALUE'] as const;
const OPCUA_FAULTS = ['FEED_GAP', 'STALE_VALUE', 'OUT_OF_ORDER', 'LINK_CUT', 'WRONG_BATCH', 'RECIPE_MISMATCH', 'DRIFT', 'EXCURSION', 'REJECT_BURST', 'RELOCATED', 'CERTIFICATE_CHANGE'] as const;

export interface SimulatorSpec {
  code: SimulatorCode;
  title: string;
  /** The entry, relative to apps/simulators/src. */
  entry: string;
  /** The variable naming its HTTP address (host:port). */
  httpEnv: string;
  /** The adapter's base path on the HTTP port (feed simulators), or null (the OPC UA endpoint is its own). */
  basePath: string | null;
  faults: readonly string[];
  /** The OPC UA simulator also needs an OPC UA port and a PKI directory. */
  opcua?: true;
}

export const SIMULATORS: readonly SimulatorSpec[] = [
  { code: 'ERP', title: 'ERP (ERP/WMS)', entry: 'erp/serve.ts', httpEnv: 'EBMR_SIM_HTTP', basePath: '/erp/v1', faults: FEED_FAULTS },
  { code: 'WMS', title: 'WMS (ERP/WMS)', entry: 'wms/main.ts', httpEnv: 'EBMR_SIM_HTTP', basePath: '/wms/v1', faults: FEED_FAULTS },
  { code: 'QMS', title: 'QMS', entry: 'qms/main.ts', httpEnv: 'EBMR_QMS_HTTP', basePath: '/qms/v1', faults: FEED_FAULTS },
  { code: 'LIMS', title: 'LIMS', entry: 'lims/main.ts', httpEnv: 'EBMR_LIMS_HTTP', basePath: '/lims/v1', faults: FEED_FAULTS },
  { code: 'LMS', title: 'LMS (training)', entry: 'lms/main.ts', httpEnv: 'EBMR_LMS_HTTP', basePath: '/lms/v1', faults: FEED_FAULTS },
  { code: 'CMMS', title: 'CMMS (maintenance and calibration)', entry: 'cmms/main.ts', httpEnv: 'EBMR_CMMS_HTTP', basePath: '/cmms/v1', faults: FEED_FAULTS },
  { code: 'EMS', title: 'EMS (room environment)', entry: 'ems/main.ts', httpEnv: 'EBMR_EMS_HTTP', basePath: '/ems/v1', faults: FEED_FAULTS },
  { code: 'L3', title: 'L3 serialisation system', entry: 'serialisation/main.ts', httpEnv: 'EBMR_L3_HTTP', basePath: '/l3/v1', faults: L3_FAULTS },
  { code: 'OPCUA', title: 'OPC UA equipment (press and the line)', entry: 'opcua/main.ts', httpEnv: 'EBMR_SIM_HTTP', basePath: null, faults: OPCUA_FAULTS, opcua: true },
];

interface Running {
  child: ChildProcess;
  port: number;
  opcuaPort: number | null;
  /** The last lines it printed (why it stopped, when it did). */
  tail: string[];
  exited: boolean;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SimulatorRefusal extends Error {}

/** The simulators this server runs (header). */
export class SimulatorManager {
  readonly #running = new Map<SimulatorCode, Running>();
  readonly #stopped = new Map<SimulatorCode, string>();

  /** @param workDir where the OPC UA simulator keeps its PKI (a directory of the server's own) */
  constructor(private readonly workDir: string) {}

  spec(code: SimulatorCode): SimulatorSpec {
    const s = SIMULATORS.find((x) => x.code === code);
    if (!s) throw new SimulatorRefusal(`no simulator ${code}`);
    return s;
  }

  async view(code: SimulatorCode): Promise<SimulatorView> {
    const spec = this.spec(code);
    const r = this.#running.get(code);
    if (r && r.exited) {
      this.#running.delete(code);
      this.#stopped.set(code, r.tail.at(-1) ?? 'the simulator stopped by itself');
    }
    const live = this.#running.get(code);
    if (!live) {
      return { code, title: spec.title, running: false, url: null, endpoint: null, faults: [], available: [...spec.faults], problem: this.#stopped.get(code) ?? null };
    }
    const url = `http://127.0.0.1:${String(live.port)}`;
    let faults: string[] = [];
    let problem: string | null = null;
    try {
      const res = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(3000) });
      const body = (await res.json()) as { faults?: unknown };
      faults = Array.isArray(body.faults) ? body.faults.filter((f): f is string => typeof f === 'string') : [];
    } catch (e) {
      problem = `the simulator does not answer its control API: ${e instanceof Error ? e.message : String(e)}`;
    }
    const endpoint = spec.opcua ? `opc.tcp://127.0.0.1:${String(live.opcuaPort)}` : `${url}${spec.basePath ?? ''}`;
    return { code, title: spec.title, running: true, url, endpoint, faults, available: [...spec.faults], problem };
  }

  async list(): Promise<SimulatorView[]> {
    return Promise.all(SIMULATORS.map((s) => this.view(s.code)));
  }

  async start(code: SimulatorCode): Promise<SimulatorView> {
    const spec = this.spec(code);
    if (this.#running.has(code) && !this.#running.get(code)?.exited) return this.view(code);
    const port = await freePort();
    const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', [spec.httpEnv]: `127.0.0.1:${String(port)}`, EBMR_SIM_SEED: '42' };
    let opcuaPort: number | null = null;
    if (spec.opcua) {
      opcuaPort = await freePort();
      const pki = join(this.workDir, 'opcua-pki');
      mkdirSync(pki, { recursive: true });
      Object.assign(env, { EBMR_SIM_OPCUA_PORT: String(opcuaPort), EBMR_SIM_PKI: pki, EBMR_SIM_HOST: '127.0.0.1' });
    }
    const child = spawn(process.execPath, ['--import', 'tsx', join('src', spec.entry)], { cwd: SIMULATORS_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const running: Running = { child, port, opcuaPort, tail: [], exited: false };
    const keep = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim() !== '') running.tail.push(line.trim().slice(0, 300));
      running.tail.splice(0, Math.max(0, running.tail.length - 20));
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.once('exit', () => {
      running.exited = true;
    });
    this.#running.set(code, running);
    this.#stopped.delete(code);
    const deadline = performance.now() + (spec.opcua ? 90_000 : 30_000);
    for (;;) {
      if (running.exited) {
        this.#running.delete(code);
        const why = running.tail.at(-1) ?? 'the simulator exited at start';
        this.#stopped.set(code, why);
        throw new SimulatorRefusal(`the ${spec.title} simulator did not start: ${why}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${String(port)}/api/state`, { signal: AbortSignal.timeout(1000) });
        if (res.status === 200) break;
      } catch {
        // not listening yet
      }
      if (performance.now() > deadline) {
        await this.stop(code);
        throw new SimulatorRefusal(`the ${spec.title} simulator did not answer within its start time`);
      }
      await sleep(200);
    }
    return this.view(code);
  }

  async stop(code: SimulatorCode): Promise<SimulatorView> {
    const r = this.#running.get(code);
    this.#running.delete(code);
    if (r && !r.exited) {
      const exited = new Promise<void>((resolve) => r.child.once('exit', () => resolve()));
      r.child.kill('SIGTERM');
      const timer = setTimeout(() => r.child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    this.#stopped.delete(code);
    return this.view(code);
  }

  async setFault(code: SimulatorCode, fault: string, on: boolean): Promise<SimulatorView> {
    const spec = this.spec(code);
    const r = this.#running.get(code);
    if (!r || r.exited) throw new SimulatorRefusal(`the ${spec.title} simulator is not running: start it first`);
    if (!spec.faults.includes(fault)) throw new SimulatorRefusal(`the ${spec.title} simulator has no fault ${fault}; it knows ${spec.faults.join(', ')}`);
    const res = await fetch(`http://127.0.0.1:${String(r.port)}/api/fault`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fault, on }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) throw new SimulatorRefusal(`the ${spec.title} simulator refused the fault ${fault}: ${(await res.text()).slice(0, 300)}`);
    return this.view(code);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#running.keys()].map((c) => this.stop(c)));
  }
}
