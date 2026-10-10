/**
 * The process equipment side of the site gateway (Phase 3 slice 3a, G-06): the ebmr.sim-process.v1 driver against
 * the press and coater simulators (child processes), and the process uplink against the fake server listener: the
 * exact wire shape, store and forward across an outage and a restart, STALE quality, alarms, setpoint downloads with
 * read-back and acknowledgement, and the shared gateway session.
 */
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { processReadingsProblems, type ProcessReading, type ProcessReadingsRequest, type SetpointAckRequest, type SetpointDownload } from '@ebmr/integration-sdk/process';
import type { GatewayClock } from '../src/clock.ts';
import { parseGatewayConfig, type GatewayConfig } from '../src/config.ts';
import { ProcessSimDriver } from '../src/drivers/process-sim.ts';
import { SiteGateway } from '../src/gateway.ts';
import { FakeServer, gatewayKeys, startSimulator, tempDir, until, type SimProcess } from './support.ts';

const PROCESS_MAIN = 'apps/simulators/src/process/main.ts';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A gateway clock the test moves: wall and monotonic time advance together, by hand only. */
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

/** The server's side of the process uplink, recorded (behind FakeServer's login and sessions). */
class ProcessListener {
  readonly bodies: ProcessReadingsRequest[] = [];
  readonly bearers: string[] = [];
  readonly acks: { id: string; body: SetpointAckRequest; afterReadings: number }[] = [];
  downloads: SetpointDownload[] = [];
  readingsDown = false;
  acksDown = false;

  install(server: FakeServer): void {
    server.extra = (method, path, body, live, req) => {
      if (!path.startsWith('/gw/v1/process-readings') && !path.startsWith('/gw/v1/setpoint-downloads')) return null;
      if (!live) return { status: 401, body: { error: { code: 'SESSION', message: 'log in', relogin: true } } };
      if (method === 'POST' && path === '/gw/v1/process-readings') {
        if (this.readingsDown) return { status: 503, body: { error: { code: 'DOWN', message: 'down', relogin: false } } };
        const problems = processReadingsProblems(body);
        if (problems) return { status: 400, body: { error: { code: 'SCHEMA', message: JSON.stringify(problems), relogin: false } } };
        this.bodies.push(body as ProcessReadingsRequest);
        this.bearers.push(createHash('sha256').update((req.headers.authorization ?? '').replace(/^Bearer /, '')).digest('hex'));
        return { status: 200, body: { accepted: (body as ProcessReadingsRequest).readings.length } };
      }
      if (method === 'GET' && path === '/gw/v1/setpoint-downloads') return { status: 200, body: { downloads: this.downloads } };
      const ack = /^\/gw\/v1\/setpoint-downloads\/([^/]+)\/ack$/.exec(path);
      if (method === 'POST' && ack) {
        if (this.acksDown) return { status: 500, body: { error: { code: 'INTERNAL', message: 'down', relogin: false } } };
        const id = decodeURIComponent(ack[1] ?? '');
        this.acks.push({ id, body: body as SetpointAckRequest, afterReadings: this.readings().length });
        this.downloads = this.downloads.filter((d) => d.id !== id);
        return { status: 200, body: {} };
      }
      return null;
    };
  }

  readings(): ProcessReading[] {
    return this.bodies.flatMap((b) => b.readings);
  }
}

function processConfig(opts: { server: FakeServer; journalDir: string; keys: ReturnType<typeof gatewayKeys>; press: number; coater?: number; staleAfterMs?: number }): GatewayConfig {
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
      processDevices: [
        { code: 'TEST-PRESS-01', driver: 'process-sim', equipment: 'PRESS', host: '127.0.0.1', port: opts.press, expectedSerial: 'PRESS-0001' },
        ...(opts.coater ? [{ code: 'TEST-COATER-01', driver: 'process-sim' as const, equipment: 'COATER' as const, host: '127.0.0.1', port: opts.coater, expectedSerial: 'COATER-0001' }] : []),
      ],
      processStaleAfterMs: opts.staleAfterMs ?? 5000,
      heartbeatMs: 500,
    },
    JSON.stringify(opts.keys),
    JSON.stringify({ services: [{ terminal: 'TEST-GW-01', loginName: 'test-gw', serviceKey: 'gw-secret' }] }),
  );
}

const fastDriver = { commandTimeoutMs: 1000, backoffInitialMs: 50, backoffMaxMs: 200, connectTimeoutMs: 1000 };

describe('process driver against the press simulator (ebmr.sim-process.v1)', () => {
  let sim: SimProcess;
  beforeAll(async () => {
    sim = await startSimulator({ EBMR_SIM_EQUIPMENT: 'PRESS', EBMR_SIM_SERIAL: 'PRESS-0001', EBMR_SIM_RUNNING: '1' }, PROCESS_MAIN);
  });
  afterAll(async () => {
    await sim.stop();
  });
  afterEach(async () => {
    await sim.control('reset');
  });

  const driverFor = (expectedSerial = 'PRESS-0001', equipment: 'PRESS' | 'COATER' = 'PRESS') =>
    new ProcessSimDriver({ code: 'TEST-PRESS-01', equipment, host: '127.0.0.1', port: sim.tcpPort, expectedSerial, clock: new TestClock(), requestTimeoutMs: 1000, backoffInitialMs: 50, backoffMaxMs: 200 });

  it('[DI-32] verifies the serial at connect, reads every press tag as decimal text in its unit, writes a setpoint and reads it back', async () => {
    const d = driverFor();
    d.start();
    await until(() => d.state === 'ONLINE', 5000, 'online');
    expect(d.serial).toBe('PRESS-0001');
    const r = await d.read();
    if (!r.ok) throw new Error(r.message);
    expect(r.serial).toBe('PRESS-0001');
    expect(r.sample.values.map((v) => `${v.tag} ${v.unit}`)).toEqual(['turret.speed_rpm rpm', 'force.main_kN kN', 'force.pre_kN kN', 'fill.depth_mm mm', 'tablet.count count', 'reject.count count', 'stroke.count count']);
    for (const v of r.sample.values) expect(v.value).toMatch(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
    expect(await d.write('force.main_kN', '14.25')).toEqual({ ok: true });
    const back = await d.read();
    expect(back.ok && back.sample.setpoints.find((s) => s.tag === 'force.main_kN')?.value).toBe('14.25');
    const refused = await d.write('force.main_kN', '99.00');
    expect(refused).toMatchObject({ ok: false, error: 'REFUSED' });
    await d.stop();
  });

  it('refuses a device that reports another serial or another kind of equipment (SERIAL_MISMATCH, alarmed)', async () => {
    for (const d of [driverFor('PRESS-9999'), driverFor('PRESS-0001', 'COATER')]) {
      const alarms: string[] = [];
      d.on('alarm', (a: { kind: string }) => alarms.push(a.kind));
      d.start();
      await until(() => d.state === 'SERIAL_MISMATCH', 5000, 'serial mismatch');
      expect(alarms).toContain('SERIAL_MISMATCH');
      expect(await d.read()).toMatchObject({ ok: false, error: 'SERIAL_MISMATCH' });
      await d.stop();
    }
  });

  it('a garbled answer is never read: PROTOCOL, alarmed, and the next read runs on a fresh connection', async () => {
    const d = driverFor();
    const alarms: string[] = [];
    d.on('alarm', (a: { kind: string }) => alarms.push(a.kind));
    d.start();
    await until(() => d.state === 'ONLINE', 5000, 'online');
    await sim.control('fault', { fault: 'GARBLED', on: true });
    expect(await d.read()).toMatchObject({ ok: false, error: 'PROTOCOL' });
    expect(alarms).toContain('PROTOCOL_ERROR');
    await sim.control('fault', { fault: 'GARBLED', on: false });
    await until(async () => (await d.read()).ok, 5000, 'reads again');
    await d.stop();
  });

  it('OFFLINE: the connection drops, reads answer OFFLINE, and the driver reconnects when the device is back', async () => {
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

describe('process uplink (POST /gw/v1/process-readings, setpoint downloads) under the gateway session', () => {
  let press: SimProcess;
  let coater: SimProcess;
  const keys = gatewayKeys();
  beforeAll(async () => {
    press = await startSimulator({ EBMR_SIM_EQUIPMENT: 'PRESS', EBMR_SIM_SERIAL: 'PRESS-0001', EBMR_SIM_RUNNING: '1' }, PROCESS_MAIN);
    coater = await startSimulator({ EBMR_SIM_EQUIPMENT: 'COATER', EBMR_SIM_SERIAL: 'COATER-0001', EBMR_SIM_RUNNING: '1' }, PROCESS_MAIN);
  });
  afterAll(async () => {
    await press.stop();
    await coater.stop();
  });
  afterEach(async () => {
    await press.control('reset');
    await press.control('start');
    await coater.control('reset');
    await coater.control('start');
  });

  async function setUp(opts: { journalDir?: string; staleAfterMs?: number; coater?: boolean; server?: FakeServer; listener?: ProcessListener } = {}) {
    const server = opts.server ?? new FakeServer(keys.publicKeySpki);
    if (!opts.server) await server.start();
    const listener = opts.listener ?? new ProcessListener();
    listener.install(server);
    const journalDir = opts.journalDir ?? tempDir();
    const clock = new TestClock();
    const config = processConfig({ server, journalDir, keys, press: press.tcpPort, ...(opts.coater ? { coater: coater.tcpPort } : {}), ...(opts.staleAfterMs ? { staleAfterMs: opts.staleAfterMs } : {}) });
    const gw = await SiteGateway.start(config, { clock, manualUplink: true, driver: fastDriver });
    const pg = gw.process;
    if (!pg) throw new Error('no process gateway');
    for (const d of pg.devices.values()) await until(() => d.driver.state === 'ONLINE', 5000, `${d.config.code} online`);
    return { server, listener, journalDir, clock, gw, pg };
  }

  it('[DI-31] sends each value with its provenance in the exact wire shape: device serial, tag, decimal value, unit, quality, source time, per-device sequence, kind', async () => {
    const { server, listener, gw, pg } = await setUp({ coater: true });
    await pg.pollOnce();
    expect(listener.bodies).toHaveLength(1);
    const body = listener.bodies[0];
    if (!body) throw new Error('nothing sent');
    expect(Object.keys(body).sort()).toEqual(['readings', 'sessionId']);
    expect(body.sessionId).toMatch(UUID);
    expect(body.sessionId).toBe(pg.sessionId);
    for (const r of body.readings) {
      expect(Object.keys(r).sort()).toEqual(['deviceSerial', 'kind', 'quality', 'sequence', 'sourceTime', 'tag', 'unit', 'value']);
      expect(typeof r.value).toBe('string');
      expect(r.quality).toBe('GOOD');
      expect(r.sourceTime).toBe(gw.clock.wallUs().toString());
    }
    const pressReadings = body.readings.filter((r) => r.deviceSerial === 'PRESS-0001');
    expect(pressReadings.map((r) => `${r.kind} ${r.tag} ${r.unit}`)).toEqual([
      'ACTUAL turret.speed_rpm rpm',
      'ACTUAL force.main_kN kN',
      'ACTUAL force.pre_kN kN',
      'ACTUAL fill.depth_mm mm',
      'ACTUAL tablet.count count',
      'ACTUAL reject.count count',
      'ACTUAL stroke.count count',
      'SETPOINT_READBACK turret.speed_rpm rpm',
      'SETPOINT_READBACK force.main_kN kN',
      'SETPOINT_READBACK force.pre_kN kN',
      'SETPOINT_READBACK fill.depth_mm mm',
    ]);
    expect(pressReadings.map((r) => r.sequence)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']);
    const coaterReadings = body.readings.filter((r) => r.deviceSerial === 'COATER-0001');
    expect(coaterReadings.map((r) => r.tag).slice(0, 7)).toEqual(['pan.speed_rpm', 'inlet.temp_C', 'exhaust.temp_C', 'bed.temp_C', 'spray.rate_g_min', 'atomisation.bar', 'airflow.m3_h']);
    expect(coaterReadings[0]?.sequence).toBe('1');
    // A second poll: actual values only (read-backs unchanged), each device's sequence goes on without a gap.
    await pg.pollOnce();
    const second = listener.bodies[1]?.readings.filter((r) => r.deviceSerial === 'PRESS-0001') ?? [];
    expect(second.map((r) => r.kind)).toEqual(Array(7).fill('ACTUAL'));
    expect(second.map((r) => r.sequence)).toEqual(['12', '13', '14', '15', '16', '17', '18']);
    // The same session as the scale uplink: the bearer token is the one the gateway's login was given.
    expect(listener.bearers.every((b) => b === listener.bearers[0])).toBe(true);
    expect(gw.uplink.login).not.toBeNull();
    await gw.stop();
    await server.stop();
  });

  it('[DI-31] stores and forwards: an outage loses nothing, the readings follow in order once the server is back, and across a gateway restart', async () => {
    const { server, listener, journalDir, gw, pg } = await setUp();
    await pg.pollOnce();
    const alarms = () => gw.alarms.map((a) => a.kind);
    listener.readingsDown = true;
    await pg.pollOnce();
    await pg.pollOnce();
    expect(alarms().filter((k) => k === 'UPLINK_FAILED')).toHaveLength(1);
    expect(pg.journal.undelivered()).toHaveLength(14);
    expect(listener.readings()).toHaveLength(11);
    listener.readingsDown = false;
    await pg.flush();
    expect(alarms()).toContain('UPLINK_RESTORED');
    expect(listener.readings().map((r) => r.sequence)).toEqual(Array.from({ length: 25 }, (_, i) => String(i + 1)));
    // Down again, then the gateway stops with readings undelivered: the next start sends them, in their own session.
    listener.readingsDown = true;
    await pg.pollOnce();
    const firstSession = pg.sessionId;
    await gw.stop();
    listener.readingsDown = false;
    const again = await setUp({ journalDir, server, listener });
    expect(again.pg.journal.undelivered()).toHaveLength(7);
    await again.pg.pollOnce();
    const sessions = listener.bodies.slice(-2).map((b) => b.sessionId);
    expect(sessions).toEqual([firstSession, again.pg.sessionId]);
    expect(again.pg.sessionId).not.toBe(firstSession);
    const seqs = listener.readings().map((r) => Number(r.sequence));
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect(again.pg.journal.undelivered()).toHaveLength(0);
    await again.gw.stop();
    await server.stop();
  });

  it('a session the server ended is logged in again and the readings go under the new token', async () => {
    const { server, listener, gw, pg } = await setUp();
    await pg.pollOnce();
    server.endSessions();
    await pg.pollOnce();
    await until(() => gw.uplink.token !== null, 5000, 'logged in again');
    await pg.flush();
    expect(listener.readings().map((r) => r.sequence).slice(-7)).toEqual(['12', '13', '14', '15', '16', '17', '18']);
    expect(new Set(listener.bearers).size).toBe(2);
    await gw.stop();
    await server.stop();
  });

  it('reports STALE quality once the scan counter has not moved for the stale time, and GOOD again when it moves', async () => {
    const { server, listener, gw, pg, clock } = await setUp({ staleAfterMs: 2000 });
    await pg.pollOnce();
    await press.control('fault', { fault: 'STALE', on: true });
    await pg.pollOnce();
    clock.advanceMs(1500);
    await pg.pollOnce();
    expect(listener.bodies.at(-1)?.readings.every((r) => r.quality === 'GOOD')).toBe(true);
    clock.advanceMs(600);
    await pg.pollOnce();
    expect(listener.bodies.at(-1)?.readings.map((r) => r.quality)).toEqual(Array(7).fill('STALE'));
    expect(gw.alarms.map((a) => a.kind)).toContain('DEVICE_STALE');
    await press.control('fault', { fault: 'STALE', on: false });
    await until(async () => {
      await pg.pollOnce();
      return listener.bodies.at(-1)?.readings[0]?.quality === 'GOOD';
    }, 5000, 'fresh again');
    expect(gw.alarms.map((a) => a.kind)).toContain('DEVICE_FRESH');
    await gw.stop();
    await server.stop();
  });

  it('forwards an alarm on the main force as ALARM with the value then, and ALARM_CLEARED when it ends', async () => {
    const { server, listener, gw, pg } = await setUp();
    await pg.pollOnce();
    await press.control('fault', { fault: 'ALARM', on: true });
    await pg.pollOnce();
    await pg.pollOnce();
    await press.control('fault', { fault: 'ALARM', on: false });
    await pg.pollOnce();
    const alarms = listener.readings().filter((r) => r.kind === 'ALARM' || r.kind === 'ALARM_CLEARED');
    expect(alarms.map((r) => `${r.kind} ${r.tag}`)).toEqual(['ALARM force.main_kN', 'ALARM_CLEARED force.main_kN']);
    expect(alarms[0]).toMatchObject({ value: '86.40', unit: 'kN', deviceSerial: 'PRESS-0001', quality: 'GOOD' });
    await gw.stop();
    await server.stop();
  });

  it('downloads a setpoint, reads it back, forwards the read-back before the acknowledgement: APPLIED, MISMATCH, FAILED', async () => {
    const { server, listener, gw, pg } = await setUp();
    await pg.pollOnce();
    listener.downloads = [{ id: 'dl-1', deviceSerial: 'PRESS-0001', tag: 'force.main_kN', value: '14.0', unit: 'kN' }];
    await pg.pollSetpoints();
    const applied = listener.acks.find((a) => a.id === 'dl-1');
    expect(applied?.body).toMatchObject({ sessionId: pg.sessionId, outcome: 'APPLIED', message: null, readback: { value: '14.00', unit: 'kN' } });
    const readback = listener.readings().find((r) => r.kind === 'SETPOINT_READBACK' && r.sequence === applied?.body.readback?.sequence);
    expect(readback).toMatchObject({ tag: 'force.main_kN', value: '14.00', deviceSerial: 'PRESS-0001' });
    expect(listener.readings().indexOf(readback as ProcessReading)).toBeLessThan(applied?.afterReadings ?? 0);
    // The next poll does not report the same read-back again.
    await pg.pollOnce();
    expect(listener.readings().filter((r) => r.kind === 'SETPOINT_READBACK' && r.tag === 'force.main_kN')).toHaveLength(2);

    await press.control('fault', { fault: 'SETPOINT_MISMATCH', on: true });
    listener.downloads = [{ id: 'dl-2', deviceSerial: 'PRESS-0001', tag: 'force.main_kN', value: '15.00', unit: 'kN' }];
    await pg.pollSetpoints();
    expect(listener.acks.find((a) => a.id === 'dl-2')?.body).toMatchObject({ outcome: 'MISMATCH', readback: { value: '15.10' } });
    expect(gw.alarms.map((a) => a.kind)).toContain('SETPOINT_MISMATCH');

    listener.downloads = [
      { id: 'dl-3', deviceSerial: 'PRESS-7777', tag: 'force.main_kN', value: '15.00', unit: 'kN' },
      { id: 'dl-4', deviceSerial: 'PRESS-0001', tag: 'inlet.temp_C', value: '60.0', unit: 'degC' },
      { id: 'dl-5', deviceSerial: 'PRESS-0001', tag: 'force.main_kN', value: '15.00', unit: 'N' },
      { id: 'dl-6', deviceSerial: 'PRESS-0001', tag: 'force.main_kN', value: '95.00', unit: 'kN' },
    ];
    await pg.pollSetpoints();
    expect(listener.acks.slice(-4).map((a) => [a.id, a.body.outcome, a.body.readback])).toEqual([
      ['dl-3', 'FAILED', null],
      ['dl-4', 'FAILED', null],
      ['dl-5', 'FAILED', null],
      ['dl-6', 'FAILED', null],
    ]);
    await gw.stop();
    await server.stop();
  });

  it('an acknowledgement that does not reach the server is sent again without writing the device again', async () => {
    const { server, listener, gw, pg } = await setUp();
    listener.acksDown = true;
    listener.downloads = [{ id: 'dl-9', deviceSerial: 'PRESS-0001', tag: 'fill.depth_mm', value: '9.50', unit: 'mm' }];
    await pg.pollSetpoints();
    expect(listener.acks).toHaveLength(0);
    expect(gw.alarms.map((a) => a.kind)).toContain('ACK_FAILED');
    // Someone changes the setpoint at the machine meanwhile: a second write of the download would undo it.
    await press.control('setpoint', { tag: 'fill.depth_mm', value: '9.00' });
    listener.acksDown = false;
    await pg.pollSetpoints();
    expect(listener.acks.map((a) => [a.id, a.body.outcome, a.body.readback?.value])).toEqual([['dl-9', 'APPLIED', '9.50']]);
    const state = (await press.control('setpoint', { tag: 'turret.speed_rpm', value: '30.0' })) as { setpoints: { tag: string; value: string }[] };
    expect(state.setpoints.find((s) => s.tag === 'fill.depth_mm')?.value).toBe('9.00');
    await gw.stop();
    await server.stop();
  });
});
