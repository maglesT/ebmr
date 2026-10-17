/**
 * Slice 6b builder-A gateway test support: the OPC UA equipment simulator as a child process (the gateway never imports
 * another app), and a driver with its feed on the real node-opcua transport.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpcuaEndpoint } from '@ebmr/integration-sdk/adapter';
import type { EquipmentKind } from '@ebmr/integration-sdk/process';
import { systemClock } from '../src/clock.ts';
import { OpcuaDriver, type OpcuaDriverAlarm } from '../src/drivers/opcua.ts';
import { NodeOpcuaTransport } from '../src/drivers/opcua-node.ts';
import { OpcuaFeed } from '../src/opcua-feed.ts';
import { TEST_FEED_KEY } from './support.ts';

const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** The default units of the simulator (apps/simulators/src/opcua/server.ts DEFAULT_UNITS). */
export const SIM_UNITS: Readonly<Record<string, EquipmentKind>> = {
  'PRESS-01': 'PRESS', 'COATER-01': 'COATER', 'GRAN-01': 'GRANULATOR', 'FBD-01': 'DRYER', 'BLEND-01': 'BLENDER', 'RC-01': 'ROLLER_COMPACTOR',
  'BLISTER-01': 'BLISTER_MACHINE', 'BOTTLE-01': 'BOTTLE_LINE', 'CARTON-01': 'CARTONER',
};

export interface OpcuaSimProcess {
  url: string;
  thumbprint: string;
  httpPort: number;
  fault(fault: string, on: boolean): Promise<{ certificateThumbprint: string }>;
  state(): Promise<{ certificateThumbprint: string; published: { samples: number; events: number; alarms: number } }>;
  stop(): Promise<void>;
}

/** Starts apps/simulators/src/opcua/main.ts on ephemeral loopback ports. */
export function startOpcuaSimulator(env: Record<string, string> = {}): Promise<OpcuaSimProcess> {
  const pki = mkdtempSync(join(tmpdir(), 'opcua-sim-'));
  return new Promise((resolvePromise, reject) => {
    const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', join(REPO, 'apps/simulators/src/opcua/main.ts')], {
      cwd: REPO,
      env: { ...process.env, EBMR_SIM_OPCUA_PORT: '0', EBMR_SIM_HTTP: '127.0.0.1:0', EBMR_SIM_PKI: pki, EBMR_SIM_LOCATION: 'RM-COMP-1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`the OPC UA simulator did not start: ${out}`)), 60_000);
    const onData = (c: Buffer) => {
      out += c.toString();
      const m = /OPC UA simulator: (opc\.tcp:\/\/\S+) \(SignAndEncrypt\), certificate SHA-256 ([0-9a-f]{64}), console on http port (\d+)/.exec(out);
      if (!m) return;
      clearTimeout(timer);
      const httpPort = Number(m[3]);
      const api = async (path: string, body?: unknown) => {
        const res = await fetch(`http://127.0.0.1:${httpPort.toString()}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return res.json() as Promise<{ certificateThumbprint: string; published: { samples: number; events: number; alarms: number } }>;
      };
      resolvePromise({
        url: m[1] ?? '', thumbprint: m[2] ?? '', httpPort,
        fault: (fault, on) => api('/api/fault', { fault, on }),
        state: () => api('/api/state'),
        stop: () =>
          new Promise<void>((done) => {
            child.once('exit', () => done());
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000).unref();
          }),
      });
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.once('exit', (code) => reject(new Error(`the OPC UA simulator exited (${String(code)}): ${out}`)));
  });
}

export interface LiveRig {
  driver: OpcuaDriver;
  feed: OpcuaFeed;
  alarms: OpcuaDriverAlarm[];
  endpoint: OpcuaEndpoint;
  stop(): Promise<void>;
}

/** A driver of the simulator's endpoint on node-opcua, writing to a feed in a temporary journal. */
export function liveDriver(sim: OpcuaSimProcess, opts: { thumbprint?: string; gapAfterMs?: number; chunkMaxSpanUs?: bigint } = {}): LiveRig {
  const dir = mkdtempSync(join(tmpdir(), 'opcua-gw-'));
  const endpoint: OpcuaEndpoint = {
    endpointUrl: sim.url, securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256', certificateThumbprint: opts.thumbprint ?? sim.thumbprint, equipmentCodes: Object.keys(SIM_UNITS), areaCode: 'RM-COMP-1',
  };
  const feed = OpcuaFeed.open({ dir: join(dir, 'feed'), gatewayCode: 'GW-TEST', signingKey: TEST_FEED_KEY, clock: systemClock });
  const driver = new OpcuaDriver({
    code: 'OPC-LINE-1', endpoint, equipment: SIM_UNITS, transport: new NodeOpcuaTransport({ pkiDir: join(dir, 'pki'), units: Object.keys(SIM_UNITS) }), clock: systemClock,
    sink: feed.sink(), nextChunkNo: (u, t) => feed.nextChunkNo(u, t), gapAfterMs: opts.gapAfterMs ?? 3000, backoffInitialMs: 200, backoffMaxMs: 1000, samplingIntervalMs: 100,
    chunkMaxSpanUs: opts.chunkMaxSpanUs ?? 2_000_000n,
  });
  const alarms: OpcuaDriverAlarm[] = [];
  driver.on('alarm', (a: OpcuaDriverAlarm) => alarms.push(a));
  driver.start();
  return {
    driver, feed, alarms, endpoint,
    stop: async () => {
      await driver.stop();
      await feed.close();
    },
  };
}
