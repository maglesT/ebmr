import { connect, type Socket } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LineFramer, MtSicsProtocolError, parseResponse } from '@ebmr/integration-sdk/scale';
import { ManualClock, ScaleModel } from '../../src/scale/model.ts';
import { startScaleSimulator, type RunningSimulator } from '../../src/scale/server.ts';

const base = { serial: 'SIM-0001', resolution: '0.001', unit: 'kg', capacity: '60.000' } as const;

function script(seed: number): string[] {
  const clock = new ManualClock();
  const m = new ScaleModel({ ...base, seed, clock, settleMs: 1000 });
  const out: string[] = [];
  m.add('1.250');
  for (let i = 0; i < 8; i += 1) {
    clock.advance(150);
    out.push(JSON.stringify(m.read()));
  }
  m.add('0.500');
  for (let i = 0; i < 8; i += 1) {
    clock.advance(150);
    out.push(JSON.stringify(m.read()));
  }
  return out;
}

describe('scale load model', () => {
  it('is deterministic under a seed and an injected clock', () => {
    expect(script(42)).toEqual(script(42));
    expect(script(42)).not.toEqual(script(43));
  });

  it('settles to the exact mass, with noise at the resolution only while settling', () => {
    const clock = new ManualClock();
    const m = new ScaleModel({ ...base, seed: 7, clock, settleMs: 1000 });
    m.add('12.345');
    clock.advance(100);
    const settling = m.read();
    expect(settling).toMatchObject({ kind: 'WEIGHT', stable: false });
    if (settling.kind === 'WEIGHT') expect(settling.value).toMatch(/^-?\d+\.\d{3}$/);
    clock.advance(1000);
    expect(m.read()).toEqual({ kind: 'WEIGHT', stable: true, value: '12.345' });
    expect(m.read()).toEqual({ kind: 'WEIGHT', stable: true, value: '12.345' });
  });

  it('tares and zeroes only when stable, and reports net of tare', () => {
    const clock = new ManualClock();
    const m = new ScaleModel({ ...base, seed: 1, clock, settleMs: 500 });
    m.add('1.250');
    expect(m.tareNow()).toEqual({ status: 'I' });
    clock.advance(600);
    expect(m.tareNow()).toEqual({ status: 'S', value: '1.250' });
    m.add('5.005');
    clock.advance(600);
    expect(m.read()).toEqual({ kind: 'WEIGHT', stable: true, value: '5.005' });
    expect(m.zeroNow()).toBe('A');
    expect(m.read()).toEqual({ kind: 'WEIGHT', stable: true, value: '0.000' });
  });

  it('reports overload above capacity and underload below the zero range', () => {
    const clock = new ManualClock();
    const m = new ScaleModel({ ...base, seed: 1, clock, settleMs: 0 });
    m.set('60.010');
    expect(m.read()).toEqual({ kind: 'OVERLOAD' });
    m.set('5.000');
    m.zeroNow();
    m.removeAll();
    expect(m.read()).toEqual({ kind: 'UNDERLOAD' });
  });

  it('faults: UNSTABLE never settles, DRIFT creeps while stable, SERIAL_MISMATCH reports another serial, OVERLOAD forces +', () => {
    const clock = new ManualClock();
    const m = new ScaleModel({ ...base, seed: 3, clock, settleMs: 100 });
    m.add('2.000');
    m.setFault('UNSTABLE', true);
    clock.advance(10_000);
    expect(m.read()).toMatchObject({ kind: 'WEIGHT', stable: false });
    m.setFault('UNSTABLE', false);
    m.setFault('DRIFT', true);
    const a = m.read();
    clock.advance(3000);
    const b = m.read();
    expect(a).toMatchObject({ stable: true });
    expect(b).toMatchObject({ stable: true });
    expect(a).not.toEqual(b);
    m.setFault('SERIAL_MISMATCH', true);
    expect(m.serial).toBe('SIM-9999');
    m.setFault('OVERLOAD', true);
    expect(m.read()).toEqual({ kind: 'OVERLOAD' });
  });
});

describe('MT-SICS over TCP and the control API', () => {
  let sim: RunningSimulator;
  let control: string;

  beforeAll(async () => {
    sim = await startScaleSimulator({ ...base, seed: 42, settleMs: 300, stabilityTimeoutMs: 800, slowMs: 400, tcp: { host: '127.0.0.1', port: 0 }, http: { host: '127.0.0.1', port: 0 } });
    control = `http://127.0.0.1:${String(sim.httpPort)}`;
  });
  afterAll(async () => {
    await sim?.close();
  });
  beforeEach(async () => {
    await post('/api/reset', {});
  });

  async function post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${control}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }

  function client(): Promise<{ socket: Socket; ask(cmd: string, timeoutMs?: number): Promise<string> }> {
    return new Promise((resolve, reject) => {
      const socket = connect(sim.tcpPort, '127.0.0.1');
      const waiting: ((line: string) => void)[] = [];
      const framer = new LineFramer((line) => waiting.shift()?.(line));
      socket.on('data', (c) => framer.push(c));
      socket.once('error', reject);
      socket.once('connect', () =>
        resolve({
          socket,
          ask: (cmd, timeoutMs = 3000) =>
            new Promise((res, rej) => {
              const t = setTimeout(() => rej(new Error(`no answer to ${cmd}`)), timeoutMs);
              waiting.push((line) => {
                clearTimeout(t);
                res(line);
              });
              socket.write(`${cmd}\r\n`);
            }),
        }),
      );
    });
  }

  it('answers S, SI, T, Z, I4, @ and unknown commands in MT-SICS form', async () => {
    const c = await client();
    try {
      expect(await c.ask('I4')).toBe('I4 A "SIM-0001"');
      expect(await c.ask('@')).toBe('I4 A "SIM-0001"');
      expect(await c.ask('XYZ')).toBe('ES');
      await post('/api/place', { mass: '1.250' });
      expect(parseResponse(await c.ask('SI'))).toMatchObject({ kind: 'WEIGHT', command: 'S', stability: 'D' });
      expect(await c.ask('S')).toBe('S S      1.250 kg');
      expect(await c.ask('T')).toBe('T S      1.250 kg');
      await post('/api/add', { mass: '0.500' });
      expect(await c.ask('S')).toBe('S S      0.500 kg');
      expect(await c.ask('Z')).toBe('Z A');
      expect(await c.ask('SI')).toBe('S S      0.000 kg');
    } finally {
      c.socket.destroy();
    }
  });

  it('S answers "not executable" when the load does not settle, and + on overload', async () => {
    const c = await client();
    try {
      await post('/api/place', { mass: '2.000' });
      await post('/api/fault', { fault: 'UNSTABLE', on: true });
      expect(await c.ask('S')).toBe('S I');
      await post('/api/fault', { fault: 'OVERLOAD', on: true });
      expect(await c.ask('SI')).toBe('S +');
    } finally {
      c.socket.destroy();
    }
  });

  it('OFFLINE drops the connections and refuses new ones until cleared', async () => {
    const c = await client();
    const closed = new Promise<void>((r) => c.socket.once('close', () => r()));
    await post('/api/fault', { fault: 'OFFLINE', on: true });
    await closed;
    const refused = await new Promise<boolean>((resolve) => {
      const s = connect(sim.tcpPort, '127.0.0.1');
      s.once('close', () => resolve(true));
      s.once('data', () => resolve(false));
      s.write('I4\r\n');
    });
    expect(refused).toBe(true);
    await post('/api/fault', { fault: 'OFFLINE', on: false });
    const again = await client();
    expect(await again.ask('I4')).toBe('I4 A "SIM-0001"');
    again.socket.destroy();
  });

  it('GARBLED answers never parse as a weight; SLOW answers arrive late', async () => {
    const c = await client();
    try {
      await post('/api/fault', { fault: 'GARBLED', on: true });
      for (let i = 0; i < 5; i += 1) {
        const line = await c.ask('SI');
        expect(() => parseResponse(line)).toThrow(MtSicsProtocolError);
      }
      await post('/api/fault', { fault: 'GARBLED', on: false });
      await post('/api/fault', { fault: 'SLOW', on: true });
      await expect(c.ask('I4', 200)).rejects.toThrow(/no answer/);
    } finally {
      c.socket.destroy();
    }
  });

  it('serves the plain-HTML console and its form actions', async () => {
    const html = await (await fetch(`${control}/`)).text();
    expect(html).toContain('SIMULATOR (DEMO-ONLY)');
    expect(html).toContain('Place container');
    const res = await fetch(`${control}/console/add`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'mass=0.005', redirect: 'manual' });
    expect(res.status).toBe(303);
    const state = (await (await fetch(`${control}/api/state`)).json()) as { load: string };
    expect(state.load).toBe('0.005');
  });
});
