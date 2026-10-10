/**
 * The printer side of the site gateway (Phase 3 slice 4a, G-21): the ebmr.sim-printer.v1 driver against the printer
 * simulator (a child process), and the printer uplink against the fake server listener: print jobs loaded and
 * acknowledged with the printer's echo (LOADED, MISMATCH, FAILED), the exact wire shapes, print events with their
 * per-printer sequence, store and forward across an outage and a restart, OFFLINE and STALE faults.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { printEventsProblems, printJobAckProblems, type PrintEvent, type PrintEventsRequest, type PrintFields, type PrintJob, type PrintJobAckRequest } from '@ebmr/integration-sdk/printer';
import type { GatewayClock } from '../src/clock.ts';
import { parseGatewayConfig, type GatewayConfig } from '../src/config.ts';
import { PrinterSimDriver } from '../src/drivers/printer-sim.ts';
import { SiteGateway } from '../src/gateway.ts';
import { FakeServer, gatewayKeys, startSimulator, tempDir, until, type SimProcess } from './support.ts';

const PRINTER_MAIN = 'apps/simulators/src/printer/main.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fields: PrintFields = { batch: 'B2610-001', mfgDate: '2026-10-01', expiryDate: '2028-09', gtin: '08901234567890', serialPoolId: 'POOL-000001' };
const jobFor = (id: string, over: Partial<PrintJob> = {}): PrintJob => ({ id, deviceSerial: 'PRN-0001', packagingOrder: 'PO-1', artworkSet: 'ART-EU-3', fields, layoutRef: 'CARTON-EU-v3', ...over });

class TestClock implements GatewayClock {
  mono = 1_000_000n;
  wallUs(): bigint {
    return 1_790_584_618_000_000n + this.mono;
  }
  monoUs(): bigint {
    return this.mono;
  }
  advanceMs(ms: number): void {
    this.mono += BigInt(ms) * 1000n;
  }
}

/** The server's side of the printer uplink, recorded (behind FakeServer's login and sessions). */
class PrintListener {
  readonly bodies: PrintEventsRequest[] = [];
  readonly bearers: string[] = [];
  readonly acks: { id: string; body: PrintJobAckRequest }[] = [];
  jobs: unknown[] = [];
  eventsDown = false;
  acksDown = false;

  install(server: FakeServer): void {
    server.extra = (method, path, body, live, req) => {
      if (!path.startsWith('/gw/v1/print-')) return null;
      if (!live) return { status: 401, body: { error: { code: 'SESSION', message: 'log in', relogin: true } } };
      if (method === 'POST' && path === '/gw/v1/print-events') {
        if (this.eventsDown) return { status: 503, body: { error: { code: 'DOWN', message: 'down', relogin: false } } };
        const problems = printEventsProblems(body);
        if (problems) return { status: 400, body: { error: { code: 'SCHEMA', message: JSON.stringify(problems), relogin: false } } };
        this.bodies.push(body as PrintEventsRequest);
        this.bearers.push(req.headers.authorization ?? '');
        return { status: 200, body: { accepted: (body as PrintEventsRequest).events.length } };
      }
      if (method === 'GET' && path === '/gw/v1/print-jobs') return { status: 200, body: { jobs: this.jobs } };
      const ack = /^\/gw\/v1\/print-jobs\/([^/]+)\/ack$/.exec(path);
      if (method === 'POST' && ack) {
        if (this.acksDown) return { status: 500, body: { error: { code: 'INTERNAL', message: 'down', relogin: false } } };
        const problems = printJobAckProblems(body);
        if (problems) return { status: 400, body: { error: { code: 'SCHEMA', message: JSON.stringify(problems), relogin: false } } };
        const id = decodeURIComponent(ack[1] ?? '');
        this.acks.push({ id, body: body as PrintJobAckRequest });
        this.jobs = this.jobs.filter((j) => (j as { id: string }).id !== id);
        return { status: 200, body: {} };
      }
      return null;
    };
  }

  events(): PrintEvent[] {
    return this.bodies.flatMap((b) => b.events);
  }
}

function printerConfig(opts: { server: FakeServer; journalDir: string; keys: ReturnType<typeof gatewayKeys>; port: number; staleAfterMs?: number }): GatewayConfig {
  return parseGatewayConfig(
    {
      gatewayCode: 'TEST-GW-01',
      installation: 'SANDBOX',
      listen: '127.0.0.1:0',
      uplink: opts.server.url,
      keyFile: 'unused',
      serviceKeysFile: 'unused',
      journalDir: opts.journalDir,
      // The scale is not under test here: nothing listens on its port.
      devices: [{ code: 'TEST-BAL-01', driver: 'mt-sics', host: '127.0.0.1', port: 9, expectedSerial: 'SIM-0001', resolution: '0.001', unit: 'kg', room: 'DISP-1' }],
      printers: [{ code: 'TEST-PRN-01', driver: 'printer-sim', host: '127.0.0.1', port: opts.port, expectedSerial: 'PRN-0001' }],
      printerStaleAfterMs: opts.staleAfterMs ?? 5000,
      heartbeatMs: 500,
    },
    JSON.stringify(opts.keys),
    JSON.stringify({ services: [{ terminal: 'TEST-GW-01', loginName: 'test-gw', serviceKey: 'gw-secret' }] }),
  );
}

const fastDriver = { commandTimeoutMs: 1000, backoffInitialMs: 50, backoffMaxMs: 200, connectTimeoutMs: 1000 };

let sim: SimProcess;
beforeAll(async () => {
  sim = await startSimulator({ EBMR_SIM_SERIAL: 'PRN-0001', EBMR_SIM_RATE_PER_MIN: '1200' }, PRINTER_MAIN);
});
afterAll(async () => {
  await sim.stop();
});
afterEach(async () => {
  await sim.control('reset');
});

describe('printer driver against the printer simulator (ebmr.sim-printer.v1)', () => {
  const driverFor = (expectedSerial = 'PRN-0001') =>
    new PrinterSimDriver({ code: 'TEST-PRN-01', host: '127.0.0.1', port: sim.tcpPort, expectedSerial, clock: new TestClock(), requestTimeoutMs: 1000, backoffInitialMs: 50, backoffMaxMs: 200 });

  it('[DI-32] verifies the serial at connect, loads a job and reads back the echo, the status with the count and the numbered events', async () => {
    const d = driverFor();
    d.start();
    await until(() => d.state === 'ONLINE', 5000, 'online');
    expect(d.serial).toBe('PRN-0001');
    const loaded = await d.load({ jobId: 'J-1', layoutRef: 'CARTON-EU-v3', fields });
    expect(loaded).toMatchObject({ ok: true, echo: { jobId: 'J-1', layoutRef: 'CARTON-EU-v3', fields } });
    await sim.control('challenge', { target: 'VISION' });
    const status = await d.read();
    expect(status).toMatchObject({ ok: true, serial: 'PRN-0001', status: { jobId: 'J-1', printed: '0', running: false } });
    const events = await d.events(0n);
    expect(events).toMatchObject({ ok: true, more: false, events: [{ no: '1', jobId: 'J-1', kind: 'CHALLENGE_RESULT', value: 'PASS' }] });
    expect(await d.clear()).toEqual({ ok: true });
    expect(await d.read()).toMatchObject({ ok: true, status: { jobId: null } });
    await d.stop();
  });

  it('[DI-20] refuses a printer that reports another serial (SERIAL_MISMATCH, alarmed), and reconnects after OFFLINE', async () => {
    const wrong = driverFor('PRN-9999');
    const alarms: string[] = [];
    wrong.on('alarm', (a: { kind: string }) => alarms.push(a.kind));
    wrong.start();
    await until(() => wrong.state === 'SERIAL_MISMATCH', 5000, 'serial mismatch');
    expect(alarms).toContain('SERIAL_MISMATCH');
    expect(await wrong.load({ jobId: 'J-1', layoutRef: 'L', fields })).toMatchObject({ ok: false, error: 'SERIAL_MISMATCH' });
    await wrong.stop();
    const d = driverFor();
    d.start();
    await until(() => d.state === 'ONLINE', 5000, 'online');
    await sim.control('fault', { fault: 'OFFLINE', on: true });
    await until(() => d.state === 'OFFLINE', 5000, 'offline');
    expect(await d.read()).toMatchObject({ ok: false, error: 'OFFLINE' });
    await sim.control('fault', { fault: 'OFFLINE', on: false });
    await until(() => d.state === 'ONLINE', 5000, 'online again');
    await d.stop();
  });
});

describe('printer uplink (print jobs, POST /gw/v1/print-events) under the gateway session', () => {
  const keys = gatewayKeys();

  async function setUp(opts: { journalDir?: string; staleAfterMs?: number; server?: FakeServer; listener?: PrintListener } = {}) {
    const server = opts.server ?? new FakeServer(keys.publicKeySpki);
    if (!opts.server) await server.start();
    const listener = opts.listener ?? new PrintListener();
    listener.install(server);
    const journalDir = opts.journalDir ?? tempDir();
    const clock = new TestClock();
    const config = printerConfig({ server, journalDir, keys, port: sim.tcpPort, ...(opts.staleAfterMs ? { staleAfterMs: opts.staleAfterMs } : {}) });
    const gw = await SiteGateway.start(config, { clock, manualUplink: true, driver: fastDriver });
    const pg = gw.printer;
    if (!pg) throw new Error('no printer gateway');
    for (const p of pg.printers.values()) await until(() => p.driver.state === 'ONLINE', 5000, `${p.config.code} online`);
    return { server, listener, journalDir, clock, gw, pg };
  }

  const simState = async () => (await (await fetch(`http://127.0.0.1:${sim.httpPort}/api/state`)).json()) as { job: { jobId: string; fields: PrintFields } | null; printed: string; boot: string };

  it('[PR-36] loads a released job exactly as the record gives it and acknowledges LOADED with the echo in the exact wire shape', async () => {
    const { server, listener, gw, pg } = await setUp();
    listener.jobs = [jobFor('J-1')];
    await pg.pollJobs();
    expect(listener.acks).toHaveLength(1);
    const ack = listener.acks[0];
    expect(ack?.id).toBe('J-1');
    expect(Object.keys(ack?.body ?? {}).sort()).toEqual(['echoedFields', 'message', 'outcome', 'sessionId', 'sourceTime']);
    expect(ack?.body).toEqual({ sessionId: pg.sessionId, outcome: 'LOADED', echoedFields: fields, sourceTime: gw.clock.wallUs().toString(), message: null });
    expect(ack?.body.sessionId).toMatch(UUID);
    expect((await simState()).job).toMatchObject({ jobId: 'J-1', fields });
    await gw.stop();
    await server.stop();
  });

  it('[PR-36] a printer that echoes another value is refused (MISMATCH) and cleared; a job it cannot take is acknowledged FAILED', async () => {
    const { server, listener, gw, pg } = await setUp();
    await sim.control('fault', { fault: 'JOB_MISMATCH', on: true });
    listener.jobs = [jobFor('J-2')];
    await pg.pollJobs();
    const mismatch = listener.acks.find((a) => a.id === 'J-2')?.body;
    expect(mismatch).toMatchObject({ outcome: 'MISMATCH', echoedFields: { ...fields, expiryDate: '2029-09' } });
    expect(mismatch?.message).toMatch(/expiryDate/);
    expect((await simState()).job).toBeNull();
    expect(gw.alarms.map((a) => a.kind)).toContain('JOB_MISMATCH');
    await sim.control('fault', { fault: 'JOB_MISMATCH', on: false });
    listener.jobs = [jobFor('J-3', { deviceSerial: 'PRN-7777' }), { ...jobFor('J-4'), fields: { ...fields, expiryDate: '28/09' } }];
    await pg.pollJobs();
    expect(listener.acks.slice(-2).map((a) => [a.id, a.body.outcome, a.body.echoedFields])).toEqual([
      ['J-3', 'FAILED', null],
      ['J-4', 'FAILED', null],
    ]);
    expect(listener.acks.at(-1)?.body.message).toMatch(/fields\.expiryDate/);
    await gw.stop();
    await server.stop();
  });

  it('an acknowledgement that does not reach the server is sent again without loading the printer again', async () => {
    const { server, listener, gw, pg } = await setUp();
    listener.acksDown = true;
    listener.jobs = [jobFor('J-5')];
    await pg.pollJobs();
    expect(listener.acks).toHaveLength(0);
    expect(gw.alarms.map((a) => a.kind)).toContain('ACK_FAILED');
    // A second load would now come back MISMATCH: the acknowledgement must be the first load's.
    await sim.control('fault', { fault: 'JOB_MISMATCH', on: true });
    listener.acksDown = false;
    await pg.pollJobs();
    expect(listener.acks.map((a) => [a.id, a.body.outcome])).toEqual([['J-5', 'LOADED']]);
    await gw.stop();
    await server.stop();
  });

  it('[DI-31] sends each print event with its provenance in the exact wire shape: serial, job, kind, value, source time, per-printer sequence', async () => {
    const { server, listener, gw, pg } = await setUp();
    listener.jobs = [jobFor('J-6')];
    await pg.pollJobs();
    await sim.control('challenge', { target: 'READER' });
    await sim.control('challenge', { target: 'VISION' });
    await pg.pollOnce();
    expect(listener.bodies).toHaveLength(1);
    const body = listener.bodies[0];
    expect(Object.keys(body ?? {}).sort()).toEqual(['events', 'sessionId']);
    expect(body?.sessionId).toBe(pg.sessionId);
    for (const e of body?.events ?? []) {
      expect(Object.keys(e).sort()).toEqual(['deviceSerial', 'jobId', 'kind', 'sequence', 'sourceTime', 'value']);
      expect(e).toMatchObject({ deviceSerial: 'PRN-0001', jobId: 'J-6', sourceTime: gw.clock.wallUs().toString() });
    }
    expect(body?.events.map((e) => `${e.sequence} ${e.kind} ${e.value}`)).toEqual(['1 CHALLENGE_RESULT PASS', '2 CHALLENGE_RESULT PASS', '3 PRINTED_COUNT 0']);
    // The line runs: every unit's reader and vision results, then the cumulative count; nothing taken twice.
    await sim.control('start');
    await until(async () => BigInt((await simState()).printed) >= 3n, 5000, 'printing');
    await sim.control('stop');
    const printed = (await simState()).printed;
    await pg.pollOnce();
    await pg.pollOnce();
    const events = listener.events();
    expect(events.map((e) => e.sequence)).toEqual(events.map((_, i) => String(i + 1)));
    const results = events.filter((e) => e.kind === 'READER_RESULT' || e.kind === 'VISION_RESULT');
    expect(results).toHaveLength(Number(printed) * 2);
    expect(results.every((e) => e.value === 'PASS')).toBe(true);
    expect(events.filter((e) => e.kind === 'PRINTED_COUNT').map((e) => e.value)).toEqual(['0', printed]);
    await gw.stop();
    await server.stop();
  });

  it('[DI-31] stores and forwards: an outage loses nothing, the events follow in order, and a restart neither loses nor repeats a printer event', async () => {
    const { server, listener, journalDir, gw, pg } = await setUp();
    listener.jobs = [jobFor('J-7')];
    await pg.pollJobs();
    listener.eventsDown = true;
    await sim.control('challenge', { target: 'VISION' });
    await pg.pollOnce();
    await sim.control('challenge', { target: 'READER' });
    await pg.pollOnce();
    expect(gw.alarms.filter((a) => a.kind === 'UPLINK_FAILED')).toHaveLength(1);
    expect(listener.events()).toHaveLength(0);
    expect(pg.journal.undelivered()).toHaveLength(3);
    listener.eventsDown = false;
    await pg.flush();
    expect(gw.alarms.map((a) => a.kind)).toContain('UPLINK_RESTORED');
    expect(listener.events().map((e) => `${e.sequence} ${e.kind}`)).toEqual(['1 CHALLENGE_RESULT', '2 PRINTED_COUNT', '3 CHALLENGE_RESULT']);
    // Down again, the gateway stops with an event undelivered; another challenge happens while it is stopped.
    listener.eventsDown = true;
    await sim.control('challenge', { target: 'VISION' });
    await pg.pollOnce();
    const firstSession = pg.sessionId;
    await gw.stop();
    await sim.control('challenge', { target: 'VISION' });
    listener.eventsDown = false;
    const again = await setUp({ journalDir, server, listener });
    expect(again.pg.journal.undelivered()).toHaveLength(1);
    await again.pg.pollOnce();
    expect(listener.bodies.slice(-2).map((b) => b.sessionId)).toEqual([firstSession, again.pg.sessionId]);
    const all = listener.events();
    expect(all.map((e) => e.sequence)).toEqual(all.map((_, i) => String(i + 1)));
    expect(all.filter((e) => e.kind === 'CHALLENGE_RESULT')).toHaveLength(4);
    expect(all.filter((e) => e.kind === 'PRINTED_COUNT')).toHaveLength(1); // the count did not move
    await again.gw.stop();
    await server.stop();
  });

  it('a session the server ended is logged in again and the events go under the new token', async () => {
    const { server, listener, gw, pg } = await setUp();
    listener.jobs = [jobFor('J-8')];
    await pg.pollJobs();
    await sim.control('challenge', { target: 'VISION' });
    await pg.pollOnce();
    server.endSessions();
    await sim.control('challenge', { target: 'VISION' });
    await pg.pollOnce();
    await until(() => gw.uplink.token !== null, 5000, 'logged in again');
    await pg.flush();
    expect(listener.events().map((e) => e.sequence)).toEqual(['1', '2', '3']);
    expect(new Set(listener.bearers).size).toBe(2);
    await gw.stop();
    await server.stop();
  });

  it('reports FAULT OFFLINE once when the printer is lost and OFFLINE_CLEARED when it is back; STALE once the scan stops for the stale time', async () => {
    const { server, listener, gw, pg, clock } = await setUp({ staleAfterMs: 2000 });
    listener.jobs = [jobFor('J-9')];
    await pg.pollJobs();
    await pg.pollOnce();
    await sim.control('fault', { fault: 'OFFLINE', on: true });
    const p = [...pg.printers.values()][0];
    await until(() => p?.driver.state === 'OFFLINE', 5000, 'offline');
    await pg.pollOnce();
    await pg.pollOnce();
    await sim.control('fault', { fault: 'OFFLINE', on: false });
    await until(() => p?.driver.state === 'ONLINE', 5000, 'online');
    await pg.pollOnce();
    const faults = () => listener.events().filter((e) => e.kind === 'FAULT').map((e) => `${e.value} ${e.jobId ?? 'none'}`);
    expect(faults()).toEqual(['OFFLINE J-9', 'OFFLINE_CLEARED J-9']);
    await sim.control('fault', { fault: 'STALE', on: true });
    await pg.pollOnce();
    clock.advanceMs(1500);
    await pg.pollOnce();
    expect(faults()).toHaveLength(2);
    clock.advanceMs(600);
    await pg.pollOnce();
    await pg.pollOnce();
    expect(faults()).toEqual(['OFFLINE J-9', 'OFFLINE_CLEARED J-9', 'STALE J-9']);
    expect(gw.alarms.map((a) => a.kind)).toContain('PRINTER_STALE');
    await sim.control('fault', { fault: 'STALE', on: false });
    await until(async () => {
      await pg.pollOnce();
      return faults().length === 4;
    }, 5000, 'fresh again');
    expect(faults().at(-1)).toBe('STALE_CLEARED J-9');
    await gw.stop();
    await server.stop();
  });
});
