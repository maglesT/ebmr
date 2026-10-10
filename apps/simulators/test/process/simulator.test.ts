import { connect, type Socket } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JsonLineFramer, SIM_PROCESS_PROTOCOL, SimProtocolError, encodeSimLine, parseSimAnswer, type SimRequest } from '@ebmr/integration-sdk/process';
import { MISMATCH_STEPS, ManualClock, ProcessModel, type ProcessSample } from '../../src/process/model.ts';
import { consoleHtml } from '../../src/process/console.ts';
import { startProcessSimulator, type RunningProcessSimulator } from '../../src/process/server.ts';

const value = (s: ProcessSample, tag: string): string => s.values.find((v) => v.tag === tag)?.value ?? 'missing';
const setpoint = (s: ProcessSample, tag: string): string => s.setpoints.find((v) => v.tag === tag)?.value ?? 'missing';

function script(seed: number, equipment: 'PRESS' | 'COATER'): string[] {
  const clock = new ManualClock();
  const m = new ProcessModel({ equipment, serial: 'SIM-P-1', seed, clock, running: true });
  const out: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    clock.advance(250);
    out.push(JSON.stringify(m.sample()));
  }
  return out;
}

describe('process simulator models', () => {
  it('are deterministic under a seed and an injected clock', () => {
    for (const kind of ['PRESS', 'COATER'] as const) {
      expect(script(42, kind)).toEqual(script(42, kind));
      expect(script(42, kind)).not.toEqual(script(43, kind));
    }
  });

  it('press: produces every press tag as decimal text in its unit, counts strokes from turret speed and stations', () => {
    const clock = new ManualClock();
    const m = new ProcessModel({ equipment: 'PRESS', serial: 'PRESS-0001', seed: 1, clock });
    let s = m.sample();
    expect(s.values.map((v) => v.tag)).toEqual(['turret.speed_rpm', 'force.main_kN', 'force.pre_kN', 'fill.depth_mm', 'tablet.count', 'reject.count', 'stroke.count']);
    expect(s.values.map((v) => v.unit)).toEqual(['rpm', 'kN', 'kN', 'mm', 'count', 'count', 'count']);
    // Stopped: no speed, no force, no strokes; the fill depth holds.
    expect([value(s, 'turret.speed_rpm'), value(s, 'force.main_kN'), value(s, 'fill.depth_mm'), value(s, 'stroke.count')]).toEqual(['0.0', '0.00', '8.00', '0']);
    m.start();
    clock.advance(60_000); // one minute at 30.0 rpm on 36 stations
    s = m.sample();
    expect(value(s, 'stroke.count')).toBe('1080');
    expect(value(s, 'reject.count')).toBe('2');
    expect(value(s, 'tablet.count')).toBe('1078');
    expect(value(s, 'force.main_kN')).toMatch(/^\d+\.\d{2}$/);
    // Noise stays within 15 steps of the setpoint.
    const main = BigInt(value(s, 'force.main_kN').replace('.', ''));
    expect(main >= 1185n && main <= 1215n).toBe(true);
    m.stop();
    clock.advance(60_000);
    expect(value(m.sample(), 'stroke.count')).toBe('1080');
  });

  it('coater: produces every coater tag, temperatures below the inlet when running', () => {
    const clock = new ManualClock();
    const m = new ProcessModel({ equipment: 'COATER', serial: 'COATER-0001', seed: 5, clock, running: true });
    const s = m.sample();
    expect(s.values.map((v) => `${v.tag} ${v.unit}`)).toEqual([
      'pan.speed_rpm rpm',
      'inlet.temp_C degC',
      'exhaust.temp_C degC',
      'bed.temp_C degC',
      'spray.rate_g_min g/min',
      'atomisation.bar bar',
      'airflow.m3_h m3/h',
    ]);
    expect(Number(value(s, 'exhaust.temp_C'))).toBeLessThan(Number(value(s, 'inlet.temp_C')));
    expect(setpoint(s, 'airflow.m3_h')).toBe('1200');
  });

  it('accepts a setpoint download within range and reads it back; refuses others without changing anything', () => {
    const m = new ProcessModel({ equipment: 'PRESS', serial: 'PRESS-0001', seed: 1, clock: new ManualClock() });
    expect(m.write('force.main_kN', '14.50')).toEqual({ ok: true });
    expect(setpoint(m.sample(), 'force.main_kN')).toBe('14.50');
    expect(m.write('force.main_kN', '14.505')).toMatchObject({ ok: false, error: 'TOO_MANY_DECIMALS' });
    expect(m.write('force.main_kN', '80.01')).toMatchObject({ ok: false, error: 'OUT_OF_RANGE' });
    expect(m.write('stroke.count', '0')).toMatchObject({ ok: false, error: 'NOT_A_SETPOINT' });
    expect(m.write('inlet.temp_C', '60.0')).toMatchObject({ ok: false, error: 'UNKNOWN_TAG' });
    expect(setpoint(m.sample(), 'force.main_kN')).toBe('14.50');
  });

  it('fault STALE freezes values, read-backs and the scan counter; production goes on behind it', () => {
    const clock = new ManualClock();
    const m = new ProcessModel({ equipment: 'PRESS', serial: 'PRESS-0001', seed: 2, clock, running: true });
    clock.advance(1000);
    m.setFault('STALE', true);
    const frozen = JSON.stringify(m.sample());
    clock.advance(10_000);
    expect(m.write('force.main_kN', '20.00')).toEqual({ ok: true });
    expect(JSON.stringify(m.sample())).toBe(frozen);
    m.setFault('STALE', false);
    const after = m.sample();
    expect(BigInt(after.scan)).toBeGreaterThan(BigInt((JSON.parse(frozen) as ProcessSample).scan));
    expect(value(after, 'stroke.count')).toBe('198'); // 11 s at 30 rpm x 36
    expect(setpoint(after, 'force.main_kN')).toBe('20.00');
  });

  it('fault DRIFT moves actual values away from their setpoints with time', () => {
    const clock = new ManualClock();
    const m = new ProcessModel({ equipment: 'PRESS', serial: 'PRESS-0001', seed: 2, clock, running: true });
    expect(m.write('fill.depth_mm', '8.00')).toEqual({ ok: true });
    m.setFault('DRIFT', true);
    clock.advance(10_000);
    // Fill depth has no noise: 10 s x 5 steps of 0.01 mm.
    expect(value(m.sample(), 'fill.depth_mm')).toBe('8.50');
    expect(setpoint(m.sample(), 'fill.depth_mm')).toBe('8.00');
  });

  it('fault ALARM drives the main force past its alarm limit and raises MAIN_FORCE_OVERLOAD, cleared with the fault', () => {
    const m = new ProcessModel({ equipment: 'PRESS', serial: 'PRESS-0001', seed: 2, clock: new ManualClock(), running: true });
    expect(m.sample().alarms).toEqual([]);
    m.setFault('ALARM', true);
    const s = m.sample();
    expect(value(s, 'force.main_kN')).toBe('86.40');
    expect(s.alarms).toEqual([{ code: 'MAIN_FORCE_OVERLOAD', tag: 'force.main_kN' }]);
    m.setFault('ALARM', false);
    expect(m.sample().alarms).toEqual([]);
    const c = new ProcessModel({ equipment: 'COATER', serial: 'COATER-0001', seed: 2, clock: new ManualClock(), running: true });
    c.setFault('ALARM', true);
    expect(c.sample().alarms).toEqual([{ code: 'INLET_TEMP_HIGH', tag: 'inlet.temp_C' }]);
  });

  it('fault SETPOINT_MISMATCH: a setpoint written under it reads back other than the download', () => {
    const m = new ProcessModel({ equipment: 'COATER', serial: 'COATER-0001', seed: 2, clock: new ManualClock() });
    m.setFault('SETPOINT_MISMATCH', true);
    expect(m.write('inlet.temp_C', '65.0')).toEqual({ ok: true });
    expect(MISMATCH_STEPS).toBe(10n);
    expect(setpoint(m.sample(), 'inlet.temp_C')).toBe('66.0');
    m.setFault('SETPOINT_MISMATCH', false);
    expect(m.write('inlet.temp_C', '65.0')).toEqual({ ok: true });
    expect(setpoint(m.sample(), 'inlet.temp_C')).toBe('65.0');
  });

  it('fault GARBLED gives a line that is never a valid answer', () => {
    const m = new ProcessModel({ equipment: 'PRESS', serial: 'PRESS-0001', seed: 9, clock: new ManualClock() });
    const request: SimRequest = { id: '1', op: 'read' };
    const line = encodeSimLine({ id: '1', ok: true, ...m.sample() }).trimEnd();
    expect(() => parseSimAnswer(request, line)).not.toThrow();
    for (let i = 0; i < 20; i += 1) {
      expect(() => parseSimAnswer(request, m.garble(line))).toThrow(SimProtocolError);
    }
  });

  it('reset returns to power-on: initial setpoints, counters zero, no faults', () => {
    const clock = new ManualClock();
    const m = new ProcessModel({ equipment: 'PRESS', serial: 'PRESS-0001', seed: 2, clock, running: true });
    m.write('force.main_kN', '30.00');
    m.setFault('DRIFT', true);
    clock.advance(5000);
    m.reset();
    const s = m.state();
    expect(s.faults).toEqual([]);
    expect(setpoint(s, 'force.main_kN')).toBe('12.00');
    expect(value(s, 'stroke.count')).toBe('0');
    expect(consoleHtml(s)).toContain('SIMULATOR (DEMO-ONLY)');
  });
});

describe('process simulator server (ebmr.sim-process.v1 over TCP, control API)', () => {
  let sim: RunningProcessSimulator;
  let n = 0;

  beforeAll(async () => {
    sim = await startProcessSimulator({ equipment: 'PRESS', serial: 'PRESS-0001', seed: 42, tcp: { host: '127.0.0.1', port: 0 }, http: { host: '127.0.0.1', port: 0 } });
  });
  afterAll(async () => {
    await sim.close();
  });
  beforeEach(() => sim.model.reset());

  async function session(): Promise<{ ask: (r: Omit<SimRequest, 'id'>) => Promise<string>; socket: Socket }> {
    const socket = connect(sim.tcpPort, '127.0.0.1');
    await new Promise<void>((r, j) => {
      socket.once('connect', () => r());
      socket.once('error', j);
    });
    const lines: string[] = [];
    const waiters: ((l: string) => void)[] = [];
    const framer = new JsonLineFramer((l) => {
      const w = waiters.shift();
      if (w) w(l);
      else lines.push(l);
    });
    socket.on('data', (c) => framer.push(c));
    const ask = (r: Omit<SimRequest, 'id'>) => {
      n += 1;
      socket.write(encodeSimLine({ id: String(n), ...r }));
      return new Promise<string>((resolve) => {
        const l = lines.shift();
        if (l !== undefined) resolve(l);
        else waiters.push(resolve);
      });
    };
    return { ask, socket };
  }

  const control = async (action: string, body: Record<string, unknown> = {}) =>
    (await fetch(`http://127.0.0.1:${String(sim.httpPort)}/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

  it('answers hello with its serial and equipment, read with a sample, write with ok or a refusal', async () => {
    const { ask, socket } = await session();
    const hello = parseSimAnswer({ id: String(n + 1), op: 'hello' }, await ask({ op: 'hello' }));
    expect(hello).toMatchObject({ ok: true, protocol: SIM_PROCESS_PROTOCOL, serial: 'PRESS-0001', equipment: 'PRESS' });
    expect(parseSimAnswer({ id: String(n + 1), op: 'write', tag: 'force.main_kN', value: '15.00' }, await ask({ op: 'write', tag: 'force.main_kN', value: '15.00' } as never))).toMatchObject({ ok: true });
    const read = parseSimAnswer({ id: String(n + 1), op: 'read' }, await ask({ op: 'read' }));
    expect(read).toMatchObject({ ok: true });
    if ('setpoints' in read) expect(read.setpoints.find((s) => s.tag === 'force.main_kN')?.value).toBe('15.00');
    const refused = JSON.parse(await ask({ op: 'write', tag: 'force.main_kN', value: '99.00' } as never)) as Record<string, unknown>;
    expect(refused).toMatchObject({ ok: false, error: 'OUT_OF_RANGE' });
    const bad = JSON.parse(await ask({ op: 'nonsense' } as never)) as Record<string, unknown>;
    expect(bad).toMatchObject({ ok: false, error: 'BAD_REQUEST' });
    socket.destroy();
  });

  it('OFFLINE drops and refuses connections; GARBLED corrupts answers; the control API switches faults and setpoints', async () => {
    const { ask, socket } = await session();
    await control('fault', { fault: 'GARBLED', on: true });
    expect(() => parseSimAnswer({ id: String(n + 1), op: 'read' }, '')).toThrow();
    const garbled = await ask({ op: 'read' });
    expect(() => parseSimAnswer({ id: String(n), op: 'read' }, garbled)).toThrow(SimProtocolError);
    await control('clear-faults');
    const closed = new Promise<void>((r) => socket.once('close', () => r()));
    await control('fault', { fault: 'OFFLINE', on: true });
    await closed;
    const refused = connect(sim.tcpPort, '127.0.0.1');
    await new Promise<void>((r) => refused.once('close', () => r()));
    await control('clear-faults');
    const state = (await control('setpoint', { tag: 'fill.depth_mm', value: '9.25' })) as { setpoints: { tag: string; value: string }[] };
    expect(state.setpoints.find((s) => s.tag === 'fill.depth_mm')?.value).toBe('9.25');
    const html = await (await fetch(`http://127.0.0.1:${String(sim.httpPort)}/`)).text();
    expect(html).toContain('Tablet press simulator PRESS-0001');
  });
});
