import { connect, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JsonLineFramer, encodeSimLine } from '@ebmr/integration-sdk/process';
import { SIM_EVENTS_MAX, SIM_PRINTER_PROTOCOL, parseSimPrinterAnswer, type PrintFields, type SimPrinterJob, type SimPrinterRequest } from '@ebmr/integration-sdk/printer';
import { ManualClock, PrinterModel } from '../../src/printer/model.ts';
import { printerConsoleHtml, startPrinterSimulator, type RunningPrinterSimulator } from '../../src/printer/server.ts';

const fields: PrintFields = { batch: 'B2610-001', mfgDate: '2026-10-01', expiryDate: '2028-09', mrp: '125.50' };
const job: SimPrinterJob = { jobId: 'J-1', layoutRef: 'CARTON-IN-v2', fields };

function run(seed: number): string {
  const clock = new ManualClock();
  const m = new PrinterModel({ serial: 'PRN-0001', seed, clock, running: true });
  m.load(job);
  m.setFault('MISPRINT', true);
  clock.advance(30_000);
  return JSON.stringify(m.events(0n).events.map((e) => e.value)) + JSON.stringify(m.status());
}

describe('printer simulator model', () => {
  it('is deterministic under a seed and an injected clock', () => {
    expect(run(42)).toBe(run(42));
    expect(run(42)).not.toBe(run(7));
  });

  it('echoes the job it holds, prints at its rate only while running with a job, and inspects every unit', () => {
    const clock = new ManualClock();
    const m = new PrinterModel({ serial: 'PRN-0001', seed: 1, clock });
    clock.advance(10_000);
    expect(m.status()).toEqual({ scan: '100', running: false, jobId: null, printed: '0' });
    m.start();
    clock.advance(10_000);
    expect(m.status().printed).toBe('0'); // no job: nothing printed
    expect(m.load(job)).toEqual(job);
    clock.advance(30_000); // 60 a minute
    expect(m.status()).toMatchObject({ running: true, jobId: 'J-1', printed: '30' });
    const { events, more } = m.events(0n);
    expect(events).toHaveLength(SIM_EVENTS_MAX);
    expect(more).toBe(true);
    expect(events.slice(0, 2)).toEqual([
      { no: '1', jobId: 'J-1', kind: 'READER_RESULT', value: 'PASS' },
      { no: '2', jobId: 'J-1', kind: 'VISION_RESULT', value: 'PASS' },
    ]);
    expect(m.events(40n).events.map((e) => e.no)).toEqual(Array.from({ length: 20 }, (_, i) => String(41 + i)));
    expect(m.events(60n)).toEqual({ events: [], more: false });
    m.stop();
    clock.advance(30_000);
    expect(m.status().printed).toBe('30');
    m.clear();
    expect(m.status()).toMatchObject({ jobId: null, printed: '0' });
  });

  it('challenges: PASS with a working reader and vision system; refused without a job', () => {
    const m = new PrinterModel({ serial: 'PRN-0001', seed: 1, clock: new ManualClock() });
    expect(m.challenge('READER')).toMatchObject({ ok: false, error: 'NO_JOB' });
    m.load(job);
    expect(m.challenge('READER')).toEqual({ ok: true, value: 'PASS' });
    expect(m.challenge('VISION')).toEqual({ ok: true, value: 'PASS' });
    expect(m.challenge('CHECKWEIGHER')).toMatchObject({ ok: false, error: 'BAD_TARGET' });
    expect(m.events(0n).events.map((e) => `${e.kind} ${e.value}`)).toEqual(['CHALLENGE_RESULT PASS', 'CHALLENGE_RESULT PASS']);
  });

  it('MISPRINT: some units fail vision (seeded), the reader still passes', () => {
    const clock = new ManualClock();
    const m = new PrinterModel({ serial: 'PRN-0001', seed: 3, clock, running: true });
    m.load(job);
    m.setFault('MISPRINT', true);
    clock.advance(20_000);
    const events = m.events(0n).events;
    const vision = events.filter((e) => e.kind === 'VISION_RESULT').map((e) => e.value);
    expect(vision).toHaveLength(20);
    expect(vision).toContain('FAIL');
    expect(vision).toContain('PASS');
    expect(events.filter((e) => e.kind === 'READER_RESULT').every((e) => e.value === 'PASS')).toBe(true);
  });

  it('READER_FAIL: the fault is logged, every reader result and a reader challenge FAIL, the vision challenge passes', () => {
    const clock = new ManualClock();
    const m = new PrinterModel({ serial: 'PRN-0001', seed: 3, clock, running: true });
    m.load(job);
    m.setFault('READER_FAIL', true);
    clock.advance(3000);
    expect(m.challenge('READER')).toEqual({ ok: true, value: 'FAIL' });
    expect(m.challenge('VISION')).toEqual({ ok: true, value: 'PASS' });
    m.setFault('READER_FAIL', false);
    expect(m.events(0n).events.map((e) => `${e.kind} ${e.value}`)).toEqual([
      'FAULT READER_FAIL',
      'READER_RESULT FAIL',
      'VISION_RESULT PASS',
      'READER_RESULT FAIL',
      'VISION_RESULT PASS',
      'READER_RESULT FAIL',
      'VISION_RESULT PASS',
      'CHALLENGE_RESULT FAIL',
      'CHALLENGE_RESULT PASS',
      'FAULT READER_FAIL_CLEARED',
    ]);
  });

  it('JOB_MISMATCH: the printer holds the job with another expiry, so its echo differs from what was sent', () => {
    const m = new PrinterModel({ serial: 'PRN-0001', seed: 1, clock: new ManualClock() });
    m.setFault('JOB_MISMATCH', true);
    expect(m.load(job).fields).toEqual({ ...fields, expiryDate: '2029-09' });
    expect(m.load({ ...job, fields: { ...fields, expiryDate: '2028-02-29' } }).fields.expiryDate).toBe('2029-02-28');
  });

  it('STALE: scan, count and events freeze, challenges are refused; printing resumes from the moment it clears', () => {
    const clock = new ManualClock();
    const m = new PrinterModel({ serial: 'PRN-0001', seed: 1, clock, running: true });
    m.load(job);
    clock.advance(5000);
    m.setFault('STALE', true);
    const frozen = m.status();
    clock.advance(10_000);
    expect(m.status()).toEqual(frozen);
    expect(m.events(10n).events).toEqual([]);
    expect(m.challenge('VISION')).toMatchObject({ ok: false, error: 'STALE' });
    m.setFault('STALE', false);
    clock.advance(2000);
    expect(m.status().printed).toBe('7');
    expect(BigInt(m.status().scan)).toBeGreaterThan(BigInt(frozen.scan));
  });

  it('a power cycle starts a new boot with no job and event numbers from 1', () => {
    const clock = new ManualClock();
    const m = new PrinterModel({ serial: 'PRN-0001', seed: 1, clock, running: true });
    m.load(job);
    clock.advance(2000);
    expect(m.boot).toBe('1');
    m.reset();
    expect(m.boot).toBe('2');
    expect(m.status()).toMatchObject({ jobId: null, printed: '0' });
    m.load(job);
    expect(m.challenge('VISION').ok).toBe(true);
    expect(m.events(0n).events[0]?.no).toBe('1');
  });

  it('the console marks itself a simulator and escapes what it shows', () => {
    const m = new PrinterModel({ serial: 'PRN-<1>', seed: 1, clock: new ManualClock() });
    const html = printerConsoleHtml(m.state(), '<b>x</b>');
    expect(html).toContain('SIMULATOR (DEMO-ONLY)');
    expect(html).toContain('PRN-&#60;1&#62;');
    expect(html).not.toContain('<b>x</b>');
  });
});

describe('printer simulator server (ebmr.sim-printer.v1)', () => {
  let sim: RunningPrinterSimulator;
  beforeAll(async () => {
    sim = await startPrinterSimulator({ serial: 'PRN-0001', seed: 42, clock: new ManualClock(), tcp: { host: '127.0.0.1', port: 0 }, http: { host: '127.0.0.1', port: 0 } });
  });
  afterAll(async () => {
    await sim.close();
  });

  function client(): Promise<{ ask(r: SimPrinterRequest): Promise<unknown>; raw(line: string): Promise<string>; socket: Socket }> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: sim.tcpPort });
      const waiting: ((line: string) => void)[] = [];
      const framer = new JsonLineFramer((line) => waiting.shift()?.(line));
      socket.on('data', (c) => framer.push(c));
      socket.once('error', reject);
      socket.once('connect', () =>
        resolve({
          socket,
          raw: (line) =>
            new Promise((r) => {
              waiting.push(r);
              socket.write(line);
            }),
          ask: (req) =>
            new Promise((r) => {
              waiting.push((line) => r(parseSimPrinterAnswer(req, line)));
              socket.write(encodeSimLine(req));
            }),
        }),
      );
    });
  }

  it('answers hello, load (with the echo), read, events and clear; refuses a line that is not a request', async () => {
    const c = await client();
    expect(await c.ask({ id: '1', op: 'hello' })).toEqual({ id: '1', ok: true, protocol: SIM_PRINTER_PROTOCOL, serial: 'PRN-0001', boot: '1' });
    expect(await c.ask({ id: '2', op: 'load', job })).toEqual({ id: '2', ok: true, echo: job });
    expect(await c.ask({ id: '3', op: 'read' })).toMatchObject({ id: '3', ok: true, jobId: 'J-1', printed: '0' });
    expect(await c.ask({ id: '4', op: 'events', after: '0' })).toEqual({ id: '4', ok: true, events: [], more: false });
    expect(await c.ask({ id: '5', op: 'clear' })).toEqual({ id: '5', ok: true });
    expect(JSON.parse(await c.raw('{"id":"6","op":"print"}\n'))).toMatchObject({ id: '6', ok: false, error: 'BAD_REQUEST' });
    c.socket.destroy();
  });

  it('OFFLINE drops the connection and refuses new ones until cleared; challenges come through the control API', async () => {
    const c = await client();
    const closed = new Promise<void>((r) => c.socket.once('close', () => r()));
    const res = await fetch(`http://127.0.0.1:${sim.httpPort ?? 0}/api/fault`, { method: 'POST', body: JSON.stringify({ fault: 'OFFLINE', on: true }) });
    expect(res.status).toBe(200);
    await closed;
    await fetch(`http://127.0.0.1:${sim.httpPort ?? 0}/api/fault`, { method: 'POST', body: JSON.stringify({ fault: 'OFFLINE', on: false }) });
    const again = await client();
    expect(await again.ask({ id: '1', op: 'load', job })).toMatchObject({ ok: true });
    const state = (await (await fetch(`http://127.0.0.1:${sim.httpPort ?? 0}/api/challenge`, { method: 'POST', body: JSON.stringify({ target: 'VISION' }) })).json()) as { recent: { kind: string; value: string }[] };
    expect(state.recent.at(-1)).toMatchObject({ kind: 'CHALLENGE_RESULT', value: 'PASS' });
    again.socket.destroy();
  });
});
