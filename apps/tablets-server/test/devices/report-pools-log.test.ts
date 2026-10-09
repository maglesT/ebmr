/**
 * Review finding P50, follow-up round 3 (decision X32; controls DI-30, PR-20): what the gateway's report pools lose is
 * logged, never silent.
 *
 * The devices runtime keeps pools for the gateway's reports apart from the browser routes' (tablets 0350; decision X30;
 * since follow-up round 4 the receipts pool logs in with the listener's own role, X36). Two of their failures were
 * swallowed with no trace: a kept connection that failed while idle (the pools' error listener did nothing), and an
 * answer of the gateway's API to the server's probe that could not be recorded (DevicesRuntime.recordApiAnswer caught
 * everything). A lost answer let a report that the API cannot be reached count as unanswered, and so open the manual
 * path beside a working scale, until a later probe's answer was recorded (since follow-up round 4 the listener's tick
 * says it was lost and the gate refuses instead: X37, scale-readiness.test.ts); a pool that lost its connection must
 * open another, which fails while no connection of the database is free to it (X21, X38). Both are logged at warn,
 * with the gateway code.
 *
 * The answer's statement is held past the receipts pool's 2 s limit by a superuser's lock on tab.gateway_api_answer:
 * no role of the application can take that lock, it stands in here for a database too loaded to end the statement in
 * time. The idle connections are ended by a superuser (pg_terminate_backend), as the database's own shutdown of a
 * backend, or a network fault, would end them.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GatewayHealth } from '@ebmr/integration-sdk/scale';
import { openServiceSession } from '@ebmr/test-kit';
import { API_ANSWER_NOT_RECORDED_LOG, IDLE_CONNECTION_LOST_LOG, RECEIPT_STATEMENT_TIMEOUT_MS, runtimeOf } from '../../src/features/devices/runtime.ts';
import { withActorCommand } from '../../src/platform/db/commands.ts';
import { logCollector, startServer, type TestServer } from '../support/harness.ts';
import { RECORD_CONTACT_SQL } from './room-scales-support.ts';
import { enrol, fakeGateway, GW, type FakeGateway } from './support.ts';

const log = logCollector();
let server: TestServer;
let gw: FakeGateway;
let api: Server;
const probes: string[] = [];

/** The gateway's API as the server probes it: GET /v1/health answered for TEST-GW-01 with this server's API token. */
async function startFakeApi(): Promise<string> {
  api = createServer((req, res) => {
    probes.push(`${req.method ?? ''} ${req.url ?? ''}`);
    if (req.headers.authorization !== `Bearer ${gw.apiToken}` || req.method !== 'GET' || req.url !== '/v1/health') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"code":"NOT_AUTHORISED","message":"no","relogin":false}}');
      return;
    }
    const health: GatewayHealth = {
      gatewayCode: GW,
      loggedIn: true,
      chainId: gw.login.chainId,
      journal: { lastSeq: '0', ackedSeq: '0' },
      devices: [{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001', notReady: null }],
    };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(health));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  const a = api.address();
  return `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
}

beforeAll(async () => {
  server = await startServer('SANDBOX', { logStream: log.stream, env: { EBMR_GATEWAY_URL: await startFakeApi() } });
  await enrol(server);
  gw = await fakeGateway(server);
}, 180_000);

afterAll(async () => {
  await gw?.close();
  await server?.close();
  api?.closeAllConnections();
  await new Promise<void>((r) => api?.close(() => r()));
});

interface LogLine {
  level?: number;
  msg?: string;
  gatewayCode?: string;
  gatewayCodes?: string[];
  pool?: string;
  err?: string;
  code?: string;
}

const lines = (msg: string): LogLine[] =>
  log
    .lines()
    .map((l) => JSON.parse(l) as LogLine)
    .filter((l) => l.msg === msg);

/** Polls `check` every 50 ms until it holds, at most `tries` times. */
async function eventually(check: () => boolean | Promise<boolean>, tries = 200): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function heartbeat(): Promise<void> {
  const r = await gw.heartbeat([{ deviceCode: 'TEST-BAL-01', state: 'ONLINE', serial: 'SIM-0001' }]);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** The answers of the gateway's API the server recorded (tab.gateway_api_answer, tablets 0350). */
async function answers(): Promise<number> {
  return (await server.db.admin.query<{ n: number }>('select count(*)::int as n from tab.gateway_api_answer')).rows[0]?.n ?? 0;
}

describe("review P50, follow-up round 3: what the gateway's report pools lose is logged, never silent (decision X32)", () => {
  it("[DI-30][PR-20] an answer of the gateway's API that the server cannot record within the receipts pool's limits is logged at warn with the gateway code (a report that the API cannot be reached then counts as unanswered); the next heartbeat's probe records its answer, and an answer for a gateway with no ACTIVE key is logged too", async () => {
    await heartbeat();
    // The monitor reports the API unreachable: every heartbeat received from now on has the server probe it.
    const monitor = await openServiceSession(server.db, server.seed, 'monitor');
    const written = await withActorCommand(server.db.app, { ...monitor, correlationId: randomUUID() }, async (c) => (await c.query<{ written: boolean }>(RECORD_CONTACT_SQL, [false, 'test: the API did not answer'])).rows[0]?.written);
    expect(written).toBe(true);
    const recorded = await answers();
    const warned = lines(API_ANSWER_NOT_RECORDED_LOG).length;

    const holder = await server.db.admin.connect();
    try {
      await holder.query('begin');
      await holder.query('lock table tab.gateway_api_answer in access exclusive mode');
      const probed = probes.length;
      await heartbeat();
      expect(await eventually(() => probes.length > probed)).toBe(true);
      // The answer's statement ends at the receipts pool's limit: lost, and said so.
      expect(await eventually(() => lines(API_ANSWER_NOT_RECORDED_LOG).length > warned, Math.ceil((RECEIPT_STATEMENT_TIMEOUT_MS + 6000) / 50))).toBe(true);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    expect(lines(API_ANSWER_NOT_RECORDED_LOG).slice(warned).map((l) => [l.level, l.gatewayCode, l.code])).toEqual([[40, GW, '57014']]);
    expect(await answers()).toBe(recorded);

    // Released, the next heartbeat's probe records the answer, and nothing more is logged.
    await heartbeat();
    expect(await eventually(async () => (await answers()) > recorded)).toBe(true);
    expect(lines(API_ANSWER_NOT_RECORDED_LOG)).toHaveLength(warned + 1);

    // tab.record_gateway_api_answer records nothing for a gateway without an ACTIVE key: logged as well.
    await runtimeOf(server.built.ctx).recordApiAnswer('TEST-GW-NONE', 'GET /v1/health answered for this server');
    expect(lines(API_ANSWER_NOT_RECORDED_LOG).slice(warned + 1).map((l) => [l.level, l.gatewayCode, l.err])).toEqual([[40, 'TEST-GW-NONE', 'tab.record_gateway_api_answer found no ACTIVE key of the gateway']]);
  }, 60_000);

  it("[DI-30][PR-20] a kept connection of the receipts pool or of the reports pool that fails while idle is logged at warn with the pool and the gateways it carries, and the pool opens another for the next report", async () => {
    const runtime = runtimeOf(server.built.ctx);
    for (const [name, pool] of [
      ['receipts', runtime.receipts()],
      ['reports', runtime.reports()],
    ] as const) {
      const before = lines(IDLE_CONNECTION_LOST_LOG).length;
      const { rows } = await pool.query<{ pid: number }>('select pg_backend_pid() as pid');
      const pid = rows[0]?.pid;
      expect(pid).toBeTypeOf('number');
      // The connection is back in the pool, idle; the database ends it.
      const ended = await server.db.admin.query<{ ok: boolean }>('select pg_terminate_backend($1) as ok', [pid]);
      expect(ended.rows[0]?.ok).toBe(true);
      expect(await eventually(() => lines(IDLE_CONNECTION_LOST_LOG).length > before)).toBe(true);
      expect(lines(IDLE_CONNECTION_LOST_LOG).slice(before).map((l) => [l.level, l.pool, l.gatewayCodes, l.code])).toEqual([[40, name, [GW], '57P01']]);
      const again = await pool.query<{ pid: number }>('select pg_backend_pid() as pid');
      expect(again.rows[0]?.pid).not.toBe(pid);
    }
    // The gateway's heartbeats are received and recorded on the new connections.
    await heartbeat();
  }, 60_000);
});
