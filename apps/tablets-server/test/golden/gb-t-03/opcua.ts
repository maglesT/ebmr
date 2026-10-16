/**
 * The OPC UA press of GB-T-03 (Phase 6 slice 6j-b; D-P6-7; D-P6j-b-2, D-P6j-b-3): PRESS-01 served by the OPC UA
 * equipment simulator (apps/simulators/src/opcua), read by the site gateway's OPC UA driver and feed
 * (apps/site-gateway, its own process: apps never import each other), and pulled by the server's OPCUA adapter worker
 * (adapters/opcua on the 6a framework) as the registered OPCUA INTEGRATION identity (DI-20).
 *
 * Set-up (connectPress): the simulator starts, its endpoint is registered as an INSTRUMENT of the compression room with
 * its certificate's SHA-256 and enrolled for PRESS-01 (plant.enrol_opcua_endpoint, IAM.DEVICE_MANAGE), and the
 * adapter's identity is made.
 *
 * During the compression run (PressRig.run): the series need increasing source times, so the golden clock runs on at
 * real speed from where it stood (runFromFrozen) while the gateway runs; the simulator and the gateway preload the
 * golden clock library on the same file, so the times they stamp are the database's and fall in the batch's use of the
 * press. The adapter's worker is cycled by the driver (as connected.ts does for the feeds) until the endpoint's session
 * is accepted, the press's REJECT_BURST occurrence (the simulator's fault) is raised and cleared, and a native chunk of
 * every press tag has landed; the gateway then stops and the clock is frozen again at a fixed instant after the one it
 * stood at (RUN_WINDOW_S), so every later act happens at the same instant on each run. operator1 acknowledges the
 * occurrence in the batch's alarm log with the action taken and a comment (DI-49), as the step's signature requires.
 *
 * What the run compares (PressFacts) leaves out what depends on the machine's speed (sample and chunk counts, source
 * times): the accepted sessions' endpoint, security and location, the batch's alarm log, the press tags with native
 * chunks in the batch's context and whether every sample keeps its raw value, and what the adapter refused or alarmed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes } from '@ebmr/api-contract';
import { tagsOf } from '@ebmr/integration-sdk/process';
import { identity } from '@ebmr/kernel';
import { personaOf } from '@ebmr/test-kit';
import { OPCUA_ADAPTER } from '../../../src/features/integrations/adapters/opcua/index.ts';
import { feedWorker, type AdapterWorker } from '../../../src/features/integrations/adapters/framework.ts';
import { adminActor } from '../../devices/support.ts';
import { tapFor } from '../../esig/support.ts';
import { adapterActor, adapterIdentity, type AdapterIdentity } from '../../integrations/erp-wms/support.ts';
import { FAKETIME_FILE, freezeAt, runFromFrozen } from '../clock.ts';
import { ok, tapAdvance, type GoldenBatch } from '../gb-t-01/driver.ts';
import { UNITS } from '../gb-t-01/plant.ts';
import type { GoldenWorld } from '../gb-t-01/world.ts';
import { GOLDEN_CLOCK_LIB } from './connected.ts';

type Json = Record<string, unknown>;

/** The press and its room (GB-T-01's plant). */
const PRESS = UNITS.PRESS.code;
const ROOM = UNITS.PRESS.room;
/** The endpoint's code in the device registry and the gateway's process device of the press. */
export const ENDPOINT = 'OPC-COMP-1';
const GATEWAY = 'GW-GBT03-01';
/**
 * How long the clock may run during the press part before it is frozen again (seconds of the database clock; whole
 * minutes, taken from the 20 minutes before the run's first weight check, which comes every 25 minutes).
 */
export const RUN_WINDOW_S = 600n;
/** The longest the driver waits for one condition of the press part (real time). */
const WAIT_MS = 180_000;
/** What operator1 records when acknowledging the occurrence. */
export const ACK = {
  actionTaken: 'Checked the checkweigher reject bin and the press discharge; the rejects were set aside and the run continued.',
  comment: 'Reject burst of the press during the compression run; no tablet out of limits reached the containers.',
} as const;

const REPO_APPS = fileURLToPath(new URL('../../../../', import.meta.url));
const clockEnv = (): Record<string, string> => (GOLDEN_CLOCK_LIB !== '' ? { LD_PRELOAD: GOLDEN_CLOCK_LIB, FAKETIME_TIMESTAMP_FILE: FAKETIME_FILE } : {});

interface Child {
  out: () => string;
  stop(): Promise<void>;
}

/** Starts `entry` (a path under apps/) under the golden clock; resolves with the first match of `ready` in its output. */
function startChild(entry: string, env: Record<string, string>, ready: RegExp, what: string): Promise<{ child: Child; match: RegExpExecArray }> {
  const proc: ChildProcess = spawn(process.execPath, ['--import', 'tsx', join(REPO_APPS, entry)], { env: { ...process.env, ...clockEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const child: Child = {
    out: () => out,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolve();
          return;
        }
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000).unref();
      }),
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the ${what} did not start: ${out.slice(-2000)}`)), 60_000);
    const onData = (d: Buffer): void => {
      out += d.toString('utf8');
      const m = ready.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ child, match: m });
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the ${what} exited (${String(code)}): ${out.slice(-2000)}`));
    });
  });
}

/** A free loopback port (the gateway's feed listens on the port its configuration names). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** Repeats `step` until `done` answers true (a condition, never a fixed time); throws after WAIT_MS. */
async function until(what: string, step: () => Promise<void>, done: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    await step();
    if (await done()) return;
    if (Date.now() > deadline) throw new Error(`the press part waited too long for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export interface PressFacts {
  /** The accepted sessions of the endpoint: endpoint, security mode and policy, reported room, units, certificate as enrolled. */
  sessions: string[];
  /** Sessions refused. */
  refusedSessions: number;
  /** The batch's alarm log: source, code, severity, GMP-critical, step, cleared, acknowledged by, the action and comment. */
  alarmLog: string[];
  /** The press tags with native chunks taken while the batch held the press. */
  seriesTags: string[];
  /** Every sample of those chunks keeps its raw value as received (DI-32). */
  rawKept: boolean;
  /** What the adapter refused and alarmed. */
  refused: number;
  integrationAlarms: number;
}

export interface PressRig {
  /** The press part of the compression run (see the module's comment); returns the minutes of the clock it used. */
  run(g: GoldenBatch): Promise<number>;
  facts(batchId: string): Promise<PressFacts>;
  close(): Promise<void>;
}

/** The simulator started, its endpoint registered and enrolled for the press, and the OPCUA adapter's identity. */
export async function connectPress(w: GoldenWorld): Promise<PressRig> {
  const server = w.server;
  const pki = mkdtempSync(join(tmpdir(), 'gbt03-opcua-sim-'));
  const sim = await startChild(
    'simulators/src/opcua/main.ts',
    { EBMR_SIM_OPCUA_PORT: '0', EBMR_SIM_HTTP: '127.0.0.1:0', EBMR_SIM_PKI: pki, EBMR_SIM_LOCATION: ROOM, EBMR_SIM_SEED: '42' },
    /OPC UA simulator: (opc\.tcp:\/\/\S+) \(SignAndEncrypt\), certificate SHA-256 ([0-9a-f]{64}), console on http port (\d+)/,
    'OPC UA simulator',
  );
  const [, url = '', thumbprint = '', httpPort = ''] = sim.match;
  const fault = async (name: string, on: boolean): Promise<void> => {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/fault`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fault: name, on }) });
    if (!res.ok) throw new Error(`the OPC UA simulator refused fault ${name}: ${await res.text()}`);
  };
  let id: AdapterIdentity;
  try {
    // The endpoint in the device registry (its certificate's SHA-256, the compression room) and enrolled for the press.
    await identity.withGuardedCommand(server.db.app, await adminActor(server, 'GB-T-03: the OPC UA endpoint of the compression press'), async (c) => {
      await c.query("select iam.register_device($1, 'INSTRUMENT', 'SITE-1', $2, null, $3, 'OPC UA endpoint of the compression press (GB-T-03)')", [ENDPOINT, ROOM, thumbprint]);
      await c.query("select plant.enrol_opcua_endpoint($1, $2, 'Basic256Sha256', $3, 'Commissioned with the press (GB-T-03)')", [ENDPOINT, url, [PRESS]]);
    });
    id = await adapterIdentity(server, 'OPCUA', 'OPCUA', 'SERVICE_ACCOUNT');
  } catch (e) {
    await sim.child.stop();
    throw e;
  }
  let gateway: Child | null = null;
  let worker: AdapterWorker | null = null;
  const one = async <T>(sql: string, p: unknown[]): Promise<T> => (await server.db.admin.query<{ r: T }>(sql, p)).rows[0]?.r as T;
  const adapterId = (): Promise<string> => one<string>('select id::text as r from iam.integration_adapter where code = $1', [id.code]);

  return {
    async run(g) {
      const stood = runFromFrozen();
      // The gateway: one endpoint with the press as its unit, its OPC UA feed on a loopback port; no scale or uplink in
      // use (its scale is unplugged and its uplink unreachable: the batch's readings are the driver's own entries).
      const dir = mkdtempSync(join(tmpdir(), 'gbt03-gateway-'));
      const pair = generateKeyPairSync('ed25519');
      writeFileSync(join(dir, 'key.json'), JSON.stringify({ privateKeyPkcs8: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), publicKeySpki: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }));
      // A service identity for the gateway's own terminal, as its configuration requires; it is never used (no uplink).
      writeFileSync(join(dir, 'service-keys.json'), JSON.stringify({ services: [{ terminal: GATEWAY, loginName: 'gateway.gbt03.unused', serviceKey: 'never-used-no-uplink-in-gb-t-03' }] }));
      const feedPort = await freePort();
      const config = {
        gatewayCode: GATEWAY, installation: 'GMP', listen: '127.0.0.1:0', uplink: 'http://127.0.0.1:9', keyFile: join(dir, 'key.json'), serviceKeysFile: join(dir, 'service-keys.json'),
        journalDir: join(dir, 'journal'),
        devices: [{ code: 'GW-GBT03-BAL', driver: 'mt-sics', host: '127.0.0.1', port: 9, expectedSerial: 'NONE-0001', resolution: '0.001', unit: 'kg', room: ROOM }],
        opcuaEndpoints: [{
          code: ENDPOINT,
          endpoint: { endpointUrl: url, securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256', certificateThumbprint: thumbprint, equipmentCodes: [PRESS], areaCode: ROOM },
          units: [{ code: 'GW-GBT03-PRESS', equipmentCode: PRESS, equipment: 'PRESS' }],
        }],
        opcuaFeedListen: `127.0.0.1:${String(feedPort)}`,
      };
      writeFileSync(join(dir, 'gateway.json'), JSON.stringify(config));
      gateway = (await startChild('site-gateway/src/main.ts', { EBMR_GW_CONFIG: join(dir, 'gateway.json') }, /site gateway \S+ \(GMP\): API on/, 'site gateway')).child;
      worker = feedWorker(server.db.app, id.code, OPCUA_ADAPTER, () => adapterActor(server, id, 'SERVICE_ACCOUNT'), { endpoint: `http://127.0.0.1:${String(feedPort)}/opcua/v1`, timeoutMs: 5000 });
      const w0 = worker;
      const cycle = async (): Promise<void> => {
        await w0.cycle();
      };
      const aid = await adapterId();
      await until('the endpoint session', cycle, async () => (await one<number>("select count(*)::int as r from plant.opcua_endpoint_session where adapter_id = $1 and verdict = 'VALID'", [aid])) > 0);
      const burst = (): Promise<string | null> =>
        one<string | null>(
          "select bool_or(a.cleared_source_us is not null)::text as r from plant.alarm_status a join plant.equipment e on e.id = a.equipment_id where a.source = 'OPCUA' and a.alarm_code = 'REJECT_BURST' and e.code = $1",
          [PRESS],
        );
      await fault('REJECT_BURST', true);
      await until('the reject-burst occurrence', cycle, async () => (await burst()) !== null);
      await fault('REJECT_BURST', false);
      await until('the reject burst cleared', cycle, async () => (await burst()) === 'true');
      const tags = tagsOf('PRESS').map((t) => t.tag);
      await until('a native chunk of every press tag', cycle, async () => (await one<number>(
        'select count(distinct s.tag)::int as r from plant.series s join plant.equipment e on e.id = s.equipment_id where e.code = $1 and s.tag = any ($2)', [PRESS, tags])) === tags.length);
      await gateway.stop();
      gateway = null;
      freezeAt(stood + RUN_WINDOW_S);
      // The kiosk sessions idled out meanwhile on the database's clock: the floor signs in again (as GoldenBatch.wait does).
      await g.floor(ROOM);

      // operator1 acknowledges the occurrence in the batch's alarm log (DI-49): the action taken and a comment.
      const op = g.b('operator1');
      const log = ok(await op.call(routes.alarms.batchLog, { params: { batchId: g.batchId }, query: {} }), 'the batch alarm log');
      for (const a of log.alarms.filter((x) => x.source === 'OPCUA' && x.acknowledgement === null)) {
        tapAdvance();
        const body = { actionTaken: ACK.actionTaken, comment: ACK.comment };
        const path = `/api/alarms/${a.alarmId}/acknowledge`;
        ok(await op.call(routes.alarms.acknowledge, { params: { alarmId: a.alarmId }, body: { ...body, attribution: await tapFor(op, personaOf(w.seed, 'operator1'), 'POST', path, body) } }), 'the acknowledgment');
      }
      return Number(RUN_WINDOW_S / 60n);
    },

    async facts(batchId) {
      const aid = await adapterId();
      const sessions = await one<string[]>(
        `select coalesce(jsonb_agg(distinct concat_ws(' ', s.endpoint_code, s.security_mode, s.security_policy, s.reported_location, array_to_string(s.equipment_codes, ','),
                case when s.certificate_thumbprint = d.key_fingerprint then 'enrolled-certificate' else 'other-certificate' end)), '[]'::jsonb) as r
           from plant.opcua_endpoint_session s join iam.device d on d.id = s.device_id where s.adapter_id = $1 and s.verdict = 'VALID'`,
        [aid],
      );
      const qa = await w.server.asPersona('qa1');
      const log = ok(await qa.call(routes.alarms.batchLog, { params: { batchId }, query: {} }), 'the batch alarm log');
      const alarmLog = log.alarms.map((a) =>
        [a.source, a.subject.code, a.alarmCode, a.severity, a.gmpCritical ? 'GMP-critical' : 'not GMP-critical', a.batches.find((b) => b.batchId === batchId)?.step ?? 'no step',
          a.clearedAtSource === null ? 'active' : 'cleared', a.acknowledgement ? `acknowledged: ${a.acknowledgement.actionTaken} / ${a.acknowledgement.comment ?? ''}` : 'unacknowledged'].join(' | '));
      const tags = tagsOf('PRESS').map((t) => t.tag);
      const series = await one<Json>(
        `select jsonb_build_object('tags', coalesce(jsonb_agg(distinct s.tag), '[]'::jsonb),
                'rawKept', coalesce(bool_and(not exists (select 1 from jsonb_array_elements(s.samples) x where coalesce(x ->> 'raw', '') = '')), false)) as r
           from plant.series s join plant.equipment e on e.id = s.equipment_id
          where e.code = $1 and s.tag = any ($2) and s.source = 'OPCUA'
            and exists (select 1 from plant.series_in_context($3, null, s.tag) c where c.id = s.id)`,
        [PRESS, tags, batchId],
      );
      return {
        sessions: [...sessions].sort(),
        refusedSessions: await one<number>("select count(*)::int as r from plant.opcua_endpoint_session where adapter_id = $1 and verdict = 'REFUSED'", [aid]),
        alarmLog,
        seriesTags: [...((series['tags'] as string[] | undefined) ?? [])].sort(),
        rawKept: series['rawKept'] === true,
        refused: await one<number>("select count(*)::int as r from platform.inbound_exception where adapter_code = $1 and kind = 'REFUSED'", [id.code]),
        integrationAlarms: await one<number>('select count(*)::int as r from platform.integration_alarm where adapter_code = $1', [id.code]),
      };
    },

    async close() {
      await worker?.stop();
      await gateway?.stop();
      await sim.child.stop();
    },
  };
}
