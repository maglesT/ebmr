/**
 * Global set-up of the Phase 6 exit demo (`pnpm demo:phase6-exit`; playwright.demo.config.ts): the E2E stack of the
 * browser suite (global-setup.ts: unique databases, the SPA built once, both servers, the gateway and the scale) plus the
 * connected site the demo list needs, all real processes:
 *  - GMP (the integrations feature, and so the adapters, run on GMP only): the ERP, QMS, LMS and CMMS simulators and
 *    their adapters, started by the GMP server itself (its service-keys file names each adapter's terminal and feed;
 *    ERP_ITEM_MASTER, QMS_STATUS, LMS_QUALIFICATION, CMMS_MAINTENANCE and WMS_STOCK run as MIRROR under the E2E change
 *    record); the OPC UA press simulator, a second site gateway (GMP) holding the press's OPC UA endpoint and serving its
 *    OPC UA feed, the endpoint registered and enrolled for PRESS-01, and the OPCUA adapter started by the GMP server; the L3 simulator as the GMP
 *    server's L3 system (EBMR_L3_URL) for the serial query.
 * The returned teardown stops every process and drops the databases. State: EBMR_E2E_STATE, with a `demo` section.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { buildWeb, REPO_ROOT, setupStack, startStack, WEB_DIST } from '@ebmr/demo';
import { identity } from '@ebmr/kernel';
import { dropDatabase, openDatabase, type SiteSeed } from '@ebmr/test-kit';
import { readFileSync } from 'node:fs';
import { administration, because, endSessions } from '../specs/phase6/support.ts';
import type { E2eState } from '../fixtures/state.ts';
import { addServiceEntry, adapterIdentity, setMirrorMode, startFeedSim, startProcess, type SimProcess } from './connected.ts';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** What the demo specs read besides the E2E state. */
export interface DemoState {
  sims: Record<'ERP' | 'QMS' | 'LMS' | 'CMMS' | 'L3', string>;
  /** The GMP adapters' codes by system. */
  adapters: Record<'ERP' | 'QMS' | 'LMS' | 'CMMS', string>;
  opcua: { simConsole: string; endpointCode: string; adapterCode: string; press: string; room: string; feed: string };
}

export const OPCUA_ENDPOINT = 'OPC-COMP-1';
const PRESS = 'PRESS-01';
const ROOM = 'COMP-1';

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const hex = randomBytes(5).toString('hex');
  const databases = { GMP: `ebmr_tablets_e2e_${hex}`, SANDBOX: `ebmr_sandbox_tablets_e2e_${hex}` };
  const root = join(REPO_ROOT, 'var', 'e2e', hex);
  const keysDir = join(root, 'keys');
  const exchangeDir = join(root, 'exchange');
  mkdirSync(keysDir, { recursive: true });
  const workers = config.workers;
  const echo = process.env['EBMR_E2E_ECHO'] === '1';
  const procs: SimProcess[] = [];
  let stack: Awaited<ReturnType<typeof startStack>> | null = null;
  const stopAll = async (): Promise<void> => {
    await stack?.stop();
    for (const p of [...procs].reverse()) await p.proc.stop();
  };
  try {
    await setupStack({ databases, keysDir, exchangeDir, personaSets: workers + 1, echo, gmpReviewBatch: true, gmpPackaging: true });
    await buildWeb(echo);

    // The simulators (each its own process on a free loopback port).
    const started = await Promise.all((['ERP', 'QMS', 'LMS', 'CMMS', 'L3'] as const).map(async (k) => [k, await startFeedSim(k)] as const));
    for (const [, s] of started) procs.push(s.sim);
    const sims = Object.fromEntries(started.map(([k, s]) => [k, s.origin])) as DemoState['sims'];
    const pki = join(root, 'opcua-sim-pki');
    const opcSim = await startProcess('sim-opcua', 'simulators/src/opcua/main.ts', { EBMR_SIM_OPCUA_PORT: '0', EBMR_SIM_HTTP: '127.0.0.1:0', EBMR_SIM_PKI: pki, EBMR_SIM_LOCATION: ROOM, EBMR_SIM_SEED: '42' },
      /OPC UA simulator: (opc\.tcp:\/\/\S+) \(SignAndEncrypt\), certificate SHA-256 ([0-9a-f]{64}), console on http port (\d+)/);
    procs.push(opcSim);
    const [, opcUrl = '', thumbprint = '', opcHttp = ''] = opcSim.match;

    // GMP: the OPC UA endpoint registered and enrolled for the press, the OPCUA adapter in its service-keys file, the
    // gateway's OPC UA feed as its endpoint.
    const gmpKeys = join(keysDir, 'gmp-service-keys.json');
    const feedPort = await freePort();
    let opcuaAdapter = '';
    const adapters = {} as DemoState['adapters'];
    {
      const seed = JSON.parse(readFileSync(join(keysDir, 'gmp-seed.json'), 'utf8')) as SiteSeed;
      const db = openDatabase(databases.GMP, 'GMP');
      try {
        const adm = await administration(db, seed);
        await identity.withGuardedCommand(db.app, because(adm.admin, 'Demo set-up: the OPC UA endpoint of the compression press'), async (c) => {
          await c.query("select iam.register_device($1, 'INSTRUMENT', $2, $3, null, $4, 'OPC UA endpoint of the compression press (demo)')", [OPCUA_ENDPOINT, seed.siteCode, ROOM, thumbprint]);
          await c.query("select plant.enrol_opcua_endpoint($1, $2, 'Basic256Sha256', $3, 'Commissioned with the press (demo)')", [OPCUA_ENDPOINT, opcUrl, [PRESS]]);
        });
        const a = await adapterIdentity(db, seed, adm, 'OPCUA', 'OPCUA', 'SERVICE_ACCOUNT');
        addServiceEntry(gmpKeys, 'SRV-OPCUA-ADAPTER-01', a, `http://127.0.0.1:${String(feedPort)}/opcua/v1`);
        opcuaAdapter = a.code;
        const slots = [
          { name: 'ERP', system: 'ERP_WMS', role: 'ERP_WMS_INTERFACE', terminal: 'SRV-ERP-ADAPTER-01', endpoint: `${sims.ERP}/erp/v1` },
          { name: 'QMS', system: 'QMS', role: 'SERVICE_ACCOUNT', terminal: 'SRV-QMS-ADAPTER-01', endpoint: `${sims.QMS}/qms/v1` },
          { name: 'LMS', system: 'LMS', role: 'SERVICE_ACCOUNT', terminal: 'SRV-LMS-ADAPTER-01', endpoint: `${sims.LMS}/lms/v1` },
          { name: 'CMMS', system: 'CMMS', role: 'SERVICE_ACCOUNT', terminal: 'SRV-CMMS-ADAPTER-01', endpoint: `${sims.CMMS}/cmms/v1` },
        ] as const;
        for (const sl of slots) {
          const x = await adapterIdentity(db, seed, adm, sl.name, sl.system, sl.role);
          addServiceEntry(gmpKeys, sl.terminal, x, sl.endpoint);
          adapters[sl.name] = x.code;
        }
        for (const cls of ['WMS_STOCK', 'ERP_ITEM_MASTER', 'QMS_STATUS', 'LMS_QUALIFICATION', 'CMMS_MAINTENANCE']) await setMirrorMode(db, adm, cls, 'MIRROR');
        await endSessions(db, adm.admin, adm.owner);
      } finally {
        await db.close();
      }
    }
    // The GMP site gateway: the press's endpoint and its OPC UA feed; no scale or uplink in use (as GB-T-03's gateway).
    {
      const dir = join(root, 'gateway-gmp');
      mkdirSync(dir, { recursive: true });
      const pair = generateKeyPairSync('ed25519');
      writeFileSync(join(dir, 'key.json'), JSON.stringify({ privateKeyPkcs8: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), publicKeySpki: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }));
      writeFileSync(join(dir, 'service-keys.json'), JSON.stringify({ services: [{ terminal: 'GW-DEMO-GMP-01', loginName: 'gateway.demo.unused', serviceKey: 'never-used-no-uplink-in-the-demo' }] }));
      const cfg = {
        label: 'DEMO-ONLY site gateway of the GMP installation (OPC UA press)',
        gatewayCode: 'GW-DEMO-GMP-01', installation: 'GMP', listen: '127.0.0.1:0', uplink: 'http://127.0.0.1:9', keyFile: join(dir, 'key.json'), serviceKeysFile: join(dir, 'service-keys.json'),
        journalDir: join(dir, 'journal'),
        devices: [{ code: 'GW-DEMO-BAL', driver: 'mt-sics', host: '127.0.0.1', port: 9, expectedSerial: 'NONE-0001', resolution: '0.001', unit: 'kg', room: ROOM }],
        opcuaEndpoints: [{
          code: OPCUA_ENDPOINT,
          endpoint: { endpointUrl: opcUrl, securityMode: 'SignAndEncrypt', securityPolicy: 'Basic256Sha256', certificateThumbprint: thumbprint, equipmentCodes: [PRESS], areaCode: ROOM },
          units: [{ code: 'GW-DEMO-PRESS', equipmentCode: PRESS, equipment: 'PRESS' }],
        }],
        opcuaFeedListen: `127.0.0.1:${String(feedPort)}`,
      };
      writeFileSync(join(dir, 'gateway.json'), JSON.stringify(cfg, null, 2));
      procs.push(await startProcess('gw-gmp', 'site-gateway/src/main.ts', { EBMR_GW_CONFIG: join(dir, 'gateway.json') }, /site gateway \S+ \(GMP\): API on/));
    }

    const ports = { gmp: await freePort(), sandbox: await freePort(), gatewayListener: await freePort(), gateway: await freePort(), simulatorTcp: await freePort(), simulatorHttp: await freePort() };
    stack = await startStack({ databases, keysDir, exchangeDir, ports, webDist: WEB_DIST, host: 'localhost', echo, logLevel: 'warn', env: { EBMR_L3_URL: sims.L3 } });
    const demo: DemoState = {
      sims, adapters,
      opcua: { simConsole: `http://127.0.0.1:${opcHttp}`, endpointCode: OPCUA_ENDPOINT, adapterCode: opcuaAdapter, press: PRESS, room: ROOM, feed: `http://127.0.0.1:${String(feedPort)}/opcua/v1` },
    };
    const state: E2eState & { demo: DemoState } = { databases, keysDir, exchangeDir, urls: stack.urls, ports, workers, demo };
    const stateFile = join(root, 'state.json');
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
    process.env['EBMR_E2E_STATE'] = stateFile;
  } catch (e) {
    await stopAll();
    throw e;
  }
  return async () => {
    await stopAll();
    await dropDatabase(databases.GMP);
    await dropDatabase(databases.SANDBOX);
    if (process.env['EBMR_E2E_KEEP'] !== '1') rmSync(root, { recursive: true, force: true });
  };
}
