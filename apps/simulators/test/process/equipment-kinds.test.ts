/**
 * Phase 3 slice 6c (D-S6-8): a simulator for every kind of process equipment the server takes readings of: the same
 * controller as the press and the coater, speaking the kind's own tags (integration-sdk process tags), with its
 * temperatures, nominal values, counters and alarms, deterministic under a seed and a clock.
 */
import { describe, expect, it } from 'vitest';
import { EQUIPMENT_KINDS, PROCESS_EQUIPMENT_KINDS, parseSimAnswer, processTagsOf, tagsOf, type EquipmentKind } from '@ebmr/integration-sdk/process';
import { toCounts } from '@ebmr/integration-sdk/scale';
import { consoleHtml } from '../../src/process/console.ts';
import { ManualClock, PROFILES, ProcessModel, type ProcessSample } from '../../src/process/model.ts';
import { startProcessSimulator } from '../../src/process/server.ts';

const value = (s: ProcessSample, tag: string): string => s.values.find((v) => v.tag === tag)?.value ?? 'missing';

function model(equipment: EquipmentKind, seed = 7, running = false): { m: ProcessModel; clock: ManualClock } {
  const clock = new ManualClock();
  return { m: new ProcessModel({ equipment, serial: `${equipment.replace(/_/g, '-')}-0001`, seed, clock, running }), clock };
}

describe('process simulators of every equipment kind (slice 6c, D-S6-8)', () => {
  it('a simulator speaks every kind of process equipment the server takes, with exactly its tags in their units and decimals', () => {
    expect([...EQUIPMENT_KINDS]).toEqual([...PROCESS_EQUIPMENT_KINDS]);
    expect(Object.keys(PROFILES).sort()).toEqual([...PROCESS_EQUIPMENT_KINDS].sort());
    for (const kind of EQUIPMENT_KINDS) {
      const { m, clock } = model(kind, 7, true);
      clock.advance(1000);
      const s = m.sample();
      const tags = tagsOf(kind);
      expect(s.values.map((v) => `${v.tag} ${v.unit}`), kind).toEqual(tags.map((t) => `${t.tag} ${t.unit}`));
      for (const t of tags) {
        const v = value(s, t.tag);
        expect(v, `${kind} ${t.tag}`).toMatch(t.scale === 0 ? /^\d+$/ : new RegExp(`^\\d+\\.\\d{${String(t.scale)}}$`));
      }
      expect(s.setpoints.map((x) => x.tag), kind).toEqual(tags.filter((t) => t.setpoint).map((t) => t.tag));
      // Every setpoint a profile starts with is within the range it accepts.
      for (const [tag, v] of Object.entries(PROFILES[kind].initial)) {
        const limits = PROFILES[kind].limits[tag];
        const scale = tags.find((t) => t.tag === tag)?.scale ?? 0;
        expect(limits, `${kind} ${tag}`).toBeDefined();
        if (limits) expect(toCounts(v, scale) >= toCounts(limits.min, scale) && toCounts(v, scale) <= toCounts(limits.max, scale), `${kind} ${tag}`).toBe(true);
      }
      expect(consoleHtml(m.state())).toContain('SIMULATOR (DEMO-ONLY)');
    }
    // The press keeps the tags of slice 3a: the bilayer layer settings are not its simulator's.
    expect(tagsOf('PRESS').length).toBeLessThan(processTagsOf('PRESS').length);
  });

  it('every kind is deterministic under a seed and a clock', () => {
    const run = (kind: EquipmentKind, seed: number) => {
      const { m, clock } = model(kind, seed, true);
      return Array.from({ length: 8 }, () => {
        clock.advance(250);
        return JSON.stringify(m.sample());
      });
    };
    for (const kind of EQUIPMENT_KINDS) expect(run(kind, 42), kind).toEqual(run(kind, 42));
  });

  it('counters integrate the speed setpoint while running and hold when stopped; rejects are a share of the count', () => {
    const { m, clock } = model('BOTTLE_LINE');
    expect(value(m.sample(), 'bottle.count')).toBe('0');
    m.start();
    clock.advance(10 * 60_000); // ten minutes at 60 bottles a minute
    expect(value(m.sample(), 'bottle.count')).toBe('600');
    expect(value(m.sample(), 'bottle.reject_count')).toBe('1');
    m.stop();
    clock.advance(60_000);
    expect(value(m.sample(), 'bottle.count')).toBe('600');
    const blender = model('BLENDER');
    blender.m.start();
    blender.clock.advance(5 * 60_000); // five minutes at 12.0 rpm
    expect(value(blender.m.sample(), 'blender.revolutions')).toBe('60');
    const cartoner = model('CARTONER');
    cartoner.m.start();
    cartoner.clock.advance(5 * 60_000);
    expect(value(cartoner.m.sample(), 'cartoner.count')).toBe('400');
    expect(value(cartoner.m.sample(), 'cartoner.reject_count')).toBe('1');
  });

  it('the fluid-bed dryer: bed and exhaust temperatures below the inlet setpoint; the granulator: nominal values only while running', () => {
    const { m } = model('DRYER', 3, true);
    const s = m.sample();
    expect(toCounts(value(s, 'dryer.bed_temp_C'), 1) < toCounts(value(s, 'dryer.inlet_temp_C'), 1)).toBe(true);
    expect(toCounts(value(s, 'dryer.exhaust_temp_C'), 1) < toCounts(value(s, 'dryer.inlet_temp_C'), 1)).toBe(true);
    const g = model('GRANULATOR');
    expect(value(g.m.sample(), 'granulator.power_kW')).toBe('0.00');
    g.m.start();
    const power = toCounts(value(g.m.sample(), 'granulator.power_kW'), 2);
    expect(power >= 730n && power <= 770n).toBe(true);
    // The roller gap is mechanical: it holds while stopped.
    expect(value(model('ROLLER_COMPACTOR').m.sample(), 'roller.gap_mm')).toBe('2.50');
  });

  it('a setpoint outside the controller range is refused; the ALARM fault raises the kind\'s alarm', () => {
    const { m } = model('BLISTER_MACHINE', 9, true);
    expect(m.write('blister.seal_temp_C', '250.0')).toMatchObject({ ok: false, error: 'OUT_OF_RANGE' });
    expect(m.write('blister.cycles', '1')).toMatchObject({ ok: false, error: 'NOT_A_SETPOINT' });
    expect(m.write('blister.seal_temp_C', '200.0')).toEqual({ ok: true });
    m.setFault('ALARM', true);
    expect(m.sample().alarms).toEqual([{ code: 'SEAL_TEMP_HIGH', tag: 'blister.seal_temp_C' }]);
  });

  it('the server answers hello with the kind it simulates', async () => {
    const sim = await startProcessSimulator({ equipment: 'CARTONER', serial: 'CARTONER-0001', seed: 1, tcp: { host: '127.0.0.1', port: 0 }, http: { host: '127.0.0.1', port: 0 } });
    try {
      const { connect } = await import('node:net');
      const socket = connect(sim.tcpPort, '127.0.0.1');
      const line = await new Promise<string>((resolve, reject) => {
        let buf = '';
        socket.on('data', (c) => {
          buf += c.toString('utf8');
          const i = buf.indexOf('\n');
          if (i >= 0) resolve(buf.slice(0, i));
        });
        socket.once('error', reject);
        socket.once('connect', () => socket.write('{"id":"1","op":"hello"}\n'));
      });
      socket.destroy();
      expect(parseSimAnswer({ id: '1', op: 'hello' }, line)).toMatchObject({ ok: true, serial: 'CARTONER-0001', equipment: 'CARTONER' });
    } finally {
      await sim.close();
    }
  });
});
