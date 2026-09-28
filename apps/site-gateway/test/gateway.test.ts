/**
 * The site gateway against the MT-SICS simulator over localhost TCP, uploading to a fake server listener.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { interpretWeightLine, readingProblem, type LiveSample } from '@ebmr/integration-sdk/scale';
import { startGatewayApi } from '../src/api.ts';
import { SiteGateway } from '../src/gateway.ts';
import { FakeServer, configFor, gatewayKeys, startSimulator, tempDir, until, type SimProcess } from './support.ts';

let sim: SimProcess;
let server: FakeServer;
let gateway: SiteGateway;
const keys = gatewayKeys();

beforeAll(async () => {
  sim = await startSimulator();
  server = new FakeServer(keys.publicKeySpki);
  await server.start();
  const config = configFor({ simPort: sim.tcpPort, uplink: server.url, journalDir: tempDir(), keys, captureTimeoutMs: 2000 });
  gateway = await SiteGateway.start(config, { driver: { commandTimeoutMs: 1000, backoffInitialMs: 100, backoffMaxMs: 400 } });
  await until(() => gateway.uplink.login !== null && gateway.instruments.get('TEST-BAL-01')?.driver.state === 'ONLINE', 15_000, 'login and connection');
}, 60_000);

afterAll(async () => {
  await gateway?.stop();
  await server?.stop();
  await sim?.stop();
});

beforeEach(async () => {
  await sim.control('reset');
  await until(() => gateway.instruments.get('TEST-BAL-01')?.driver.state === 'ONLINE', 10_000, 'the balance online');
});

const driver = () => gateway.instruments.get('TEST-BAL-01')!.driver;

describe('site gateway with the MT-SICS simulator', () => {
  it('[DI-32][DI-31] a stable capture journals, signs and uploads the reading with its raw line; the server holds it', async () => {
    await sim.control('place', { mass: '1.250' });
    const r = await gateway.capture('TEST-BAL-01', 'TARE');
    expect(r.outcome).toBe('CAPTURED');
    if (r.outcome !== 'CAPTURED') return;
    expect(r.uplinked).toBe(true);
    expect(r.reading).toMatchObject({ deviceCode: 'TEST-BAL-01', serial: 'SIM-0001', value: '1.250', unit: 'kg', stable: true, status: 'OK', purpose: 'TARE', trust: 'DEVICE_UNSYNCED', installation: 'SANDBOX' });
    expect(r.reading.raw).toBe('S S      1.250 kg');
    expect(interpretWeightLine(r.reading.raw).value).toBe(r.reading.value);
    expect(readingProblem(r.reading, gateway.config.publicKey)).toBeNull();
    expect(server.readings.at(-1)?.readingId).toBe(r.reading.readingId);
    expect(gateway.journal.ackedSeq).toBe(BigInt(r.reading.seq));
  });

  it('[DI-32] an unstable weight is never captured as stable: the timeout answers NOT_STABLE and records it as UNSTABLE', async () => {
    await sim.control('place', { mass: '2.000' });
    await sim.control('fault', { fault: 'UNSTABLE', on: true });
    const r = await gateway.capture('TEST-BAL-01', 'GROSS', 1500);
    expect(r.outcome).toBe('FAILED');
    if (r.outcome !== 'FAILED') return;
    expect(r.error).toBe('NOT_STABLE_WITHIN_TIMEOUT');
    expect(r.reading).toMatchObject({ stable: false, status: 'UNSTABLE' });
    expect(r.reading?.raw).toMatch(/^S D /);
    expect(server.readings.filter((x) => x.status === 'OK' && x.readingId === r.reading?.readingId)).toEqual([]);
  });

  it('overload is refused and recorded as OVERLOAD, without a value', async () => {
    await sim.control('set', { mass: '75.000' });
    const r = await gateway.capture('TEST-BAL-01', 'GROSS');
    expect(r).toMatchObject({ outcome: 'FAILED', error: 'OVERLOAD' });
    if (r.outcome === 'FAILED') expect(r.reading).toMatchObject({ value: null, status: 'OVERLOAD', raw: 'S +' });
  });

  it('[DI-31] a garbled line is rejected: nothing is recorded and the connection is re-established and re-verified', async () => {
    await sim.control('place', { mass: '1.000' });
    await new Promise((r) => setTimeout(r, 400));
    const before = gateway.journal.lastSeq();
    await sim.control('fault', { fault: 'GARBLED', on: true });
    const r = await gateway.capture('TEST-BAL-01', 'GROSS');
    expect(r).toMatchObject({ outcome: 'FAILED', error: 'PROTOCOL_ERROR' });
    expect(gateway.journal.lastSeq()).toBe(before);
    expect(gateway.alarms.some((a) => a.kind === 'PROTOCOL_ERROR')).toBe(true);
    await sim.control('fault', { fault: 'GARBLED', on: false });
    await until(() => driver().state === 'ONLINE', 10_000, 'reconnect');
    expect((await gateway.capture('TEST-BAL-01', 'GROSS')).outcome).toBe('CAPTURED');
  });

  it('offline and reconnect: an offline balance answers DEVICE_OFFLINE; it reconnects with back-off when it comes back', async () => {
    await sim.control('fault', { fault: 'OFFLINE', on: true });
    await until(() => driver().state === 'OFFLINE', 5000, 'offline');
    expect(await gateway.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'FAILED', error: 'DEVICE_OFFLINE' });
    await until(() => server.heartbeats.at(-1)?.devices[0]?.state === 'OFFLINE', 5000, 'an OFFLINE heartbeat');
    await sim.control('fault', { fault: 'OFFLINE', on: false });
    await until(() => driver().state === 'ONLINE', 10_000, 'online again');
    await sim.control('place', { mass: '0.500' });
    expect((await gateway.capture('TEST-BAL-01', 'GROSS')).outcome).toBe('CAPTURED');
  });

  it('a slow balance times out; the late answer is never taken for a later command', async () => {
    await sim.control('place', { mass: '3.000' });
    await new Promise((r) => setTimeout(r, 400));
    await sim.control('fault', { fault: 'SLOW', on: true });
    const r = await gateway.capture('TEST-BAL-01', 'GROSS', 500);
    expect(r).toMatchObject({ outcome: 'FAILED', error: 'DEVICE_OFFLINE' });
    await sim.control('fault', { fault: 'SLOW', on: false });
    await sim.control('add', { mass: '0.005' });
    await until(() => driver().state === 'ONLINE', 10_000, 'reconnect');
    const ok = await gateway.capture('TEST-BAL-01', 'GROSS');
    expect(ok.outcome).toBe('CAPTURED');
    if (ok.outcome === 'CAPTURED') expect(ok.reading.value).toBe('3.005');
  });

  it('[DI-20] a serial mismatch is refused at connect and alarmed; the heartbeat reports it; it clears when the right balance returns', async () => {
    await sim.control('fault', { fault: 'SERIAL_MISMATCH', on: true });
    // A reconnect is needed for I4 to be asked again.
    await sim.control('fault', { fault: 'OFFLINE', on: true });
    await sim.control('fault', { fault: 'OFFLINE', on: false });
    await until(() => driver().state === 'SERIAL_MISMATCH', 10_000, 'serial mismatch');
    const r = await gateway.capture('TEST-BAL-01', 'GROSS');
    expect(r).toMatchObject({ outcome: 'FAILED', error: 'SERIAL_MISMATCH' });
    expect(gateway.alarms.some((a) => a.kind === 'SERIAL_MISMATCH' && a.details['reported'] === 'SIM-9999')).toBe(true);
    await until(() => server.heartbeats.at(-1)?.devices[0]?.state === 'SERIAL_MISMATCH', 5000, 'a SERIAL_MISMATCH heartbeat');
    expect(server.heartbeats.at(-1)?.devices[0]?.serial).toBe('SIM-9999');
    await sim.control('fault', { fault: 'SERIAL_MISMATCH', on: false });
    await until(() => driver().state === 'ONLINE', 10_000, 'the right balance again');
  });

  it('[DI-31] a unit other than the configured one is refused and alarmed, never converted; a configuration that differs from the server binding captures nothing', async () => {
    const gServer = new FakeServer(keys.publicKeySpki);
    gServer.instruments = [{ deviceCode: 'TEST-BAL-01', serial: 'SIM-0001', unit: 'g', resolution: '0.001', roomCode: 'DISP-1' }];
    await gServer.start();
    const inGrams = { ...gateway.config, uplink: gServer.url, journalDir: tempDir(), devices: [{ ...gateway.config.devices[0]!, unit: 'g' }] };
    const other = await SiteGateway.start(inGrams, { driver: { commandTimeoutMs: 1000 }, manualUplink: true });
    const mismatched = await SiteGateway.start({ ...inGrams, uplink: server.url, journalDir: tempDir() }, { driver: { commandTimeoutMs: 1000 }, manualUplink: true });
    try {
      await other.uplink.logIn();
      await until(() => other.instruments.get('TEST-BAL-01')?.driver.state === 'ONLINE', 10_000, 'online');
      await sim.control('place', { mass: '1.000' });
      const r = await other.capture('TEST-BAL-01', 'GROSS');
      expect(r).toMatchObject({ outcome: 'FAILED', error: 'UNIT_MISMATCH', reading: null });
      expect(other.journal.lastSeq()).toBe(0n);
      expect(other.alarms.some((a) => a.kind === 'UNIT_MISMATCH')).toBe(true);

      await mismatched.uplink.logIn();
      await until(() => mismatched.instruments.get('TEST-BAL-01')?.driver.state === 'ONLINE', 10_000, 'online');
      expect(await mismatched.capture('TEST-BAL-01', 'GROSS')).toMatchObject({ outcome: 'FAILED', error: 'NOT_READY' });
      expect(mismatched.alarms.some((a) => a.kind === 'ENROLMENT_MISMATCH')).toBe(true);
    } finally {
      await other.stop();
      await mismatched.stop();
      await gServer.stop();
    }
  });

  it('live display: samples at about 4 Hz as decimal text, stable flag and status; OFFLINE while the balance is away', async () => {
    await sim.control('place', { mass: '1.250' });
    const samples: LiveSample[] = [];
    const stop = gateway.subscribeLive('TEST-BAL-01', (s) => samples.push(s));
    await new Promise((r) => setTimeout(r, 1300));
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples.at(-1)).toMatchObject({ deviceCode: 'TEST-BAL-01', value: '1.250', unit: 'kg', stable: true, status: 'OK' });
    await sim.control('fault', { fault: 'OFFLINE', on: true });
    await until(() => samples.at(-1)?.status === 'OFFLINE', 5000, 'an OFFLINE sample');
    stop();
    await sim.control('fault', { fault: 'OFFLINE', on: false });
  });

  it('[DI-31] the API needs the token handed to the logged-in server; health shows no secret', async () => {
    const api = await startGatewayApi(gateway, { host: '127.0.0.1', port: 0 });
    try {
      const base = `http://127.0.0.1:${api.port}`;
      const health = (await (await fetch(`${base}/v1/health`)).json()) as { loggedIn: boolean };
      expect(health.loggedIn).toBe(true);
      expect(JSON.stringify(health)).not.toContain(gateway.apiToken);
      const denied = await fetch(`${base}/v1/devices/TEST-BAL-01/capture`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'GROSS' }) });
      expect(denied.status).toBe(401);
      expect(server.apiTokens).toContain(gateway.apiToken);
      await sim.control('place', { mass: '0.750' });
      const ok = await fetch(`${base}/v1/devices/TEST-BAL-01/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${gateway.apiToken}` },
        body: JSON.stringify({ purpose: 'GROSS' }),
      });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { outcome: string }).outcome).toBe('CAPTURED');
    } finally {
      await api.server.close();
    }
  });
});
