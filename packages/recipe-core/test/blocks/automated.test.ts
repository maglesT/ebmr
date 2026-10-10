/**
 * G-06@1 automated equipment phase (tablets spec K-06; Phase 3 slice 3a): setpoints read back against the MBR,
 * collected values with provenance and limits, stale or bad device data, the flagged manual fallback that only the
 * MBR can allow, GMP-critical alarms acknowledged with a comment, interface loss and recipe mismatch. The database
 * holds the same rules (recipe-core 0520, tablets 0820; their own tests).
 */
import { describe, expect, it } from 'vitest';
import { G06 } from '../../src/blocks/generic/automated.ts';
import { genericBlockRegistry } from '../../src/blocks/generic/index.ts';
import { defineBatch, EngineDefinitionError } from '../../src/engine/definition.ts';
import { expr, mbrWith, phase } from '../flow/support.ts';
import { define, OP1, OP2, Run, T0, VER1 } from '../engine/support.ts';

const SYSTEM = { kind: 'PLC' as const, ref: 'SYS-PRS', recipe: 'RCP-COMP', recipeVersion: '5' };
const CONFIG = {
  setpoints: [{ tag: 'force.main_kN', value: '12.50', unit: 'kN', tolerance: '0.05' }],
  actuals: [{ tag: 'turret.speed_rpm', unit: 'rpm', min: '20.0', max: '60.0' }],
  criticalAlarms: ['force.main_kN'],
};

function press(config: Record<string, unknown> = CONFIG, system: typeof SYSTEM | null = SYSTEM) {
  return mbrWith({
    kind: 'sequence',
    id: 'ops',
    children: [phase('cmp', { block: { type: 'G-06', version: '1' }, config: config as never, ...(system ? { system } : {}), signatures: { check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } } }), phase('after')],
  });
}

let readingN = 0;
/** A DEVICE value entry received `ageS` seconds before `run`'s now. */
function device(run: Run, kind: string, tag: string, value: string, unit: string, opts: { quality?: string; ageS?: number } = {}) {
  readingN += 1;
  return {
    kind,
    tag,
    value,
    unit,
    source: 'EQUIPMENT',
    readingId: `00000000-0000-4000-8000-${readingN.toString(16).padStart(12, '0')}`,
    quality: opts.quality ?? 'GOOD',
    receivedAtUs: (run.nowUs - BigInt(opts.ageS ?? 1) * 1_000_000n).toString(),
  };
}

function started(config: Record<string, unknown> = CONFIG): Run {
  const run = Run.issue(define(press(config)), {}, T0);
  run.start('cmp');
  run.minutes(1);
  return run;
}

function nominal(run: Run): void {
  run.entry('cmp', { kind: 'RECIPE_CHECK', recipe: 'RCP-COMP', recipeVersion: '5' });
  run.entry('cmp', device(run, 'SETPOINT_READBACK', 'force.main_kN', '12.48', 'kN'));
  run.entry('cmp', device(run, 'ACTUAL', 'turret.speed_rpm', '45.0', 'rpm'));
}

const types = (run: Run): string[] => run.exceptions().map((e) => e.type).sort();

describe('G-06@1 automated equipment phase (K-06)', () => {
  it('[PR-14][DI-31] the nominal path: recipe checked, the setpoint read back within tolerance and the value collected from the device; performed by one person and confirmed by another, no exception', () => {
    const run = started();
    nominal(run);
    const readback = Object.values(run.state.entries).find((e) => e.kind === 'SETPOINT_READBACK');
    expect(readback?.data).toMatchObject({ setpoint: { value: '12.50', unit: 'kN' }, matches: true, usable: true, manualFallback: false, source: 'EQUIPMENT' });
    run.perform('cmp');
    run.verify('cmp', [], VER1);
    expect(run.status('cmp')).toBe('COMPLETED');
    expect(types(run)).toEqual([]);
  });

  it('[DI-31][PR-14] a setpoint read back outside its tolerance raises SETPOINT_MISMATCH, which stops the step until QA decides; a setpoint the MBR does not name is refused', () => {
    const run = started();
    run.entry('cmp', { kind: 'RECIPE_CHECK', recipe: 'RCP-COMP', recipeVersion: '5' });
    run.entry('cmp', device(run, 'SETPOINT_READBACK', 'force.main_kN', '12.60', 'kN'));
    run.entry('cmp', device(run, 'ACTUAL', 'turret.speed_rpm', '45.0', 'rpm'));
    expect(types(run)).toEqual(['SETPOINT_MISMATCH']);
    expect(run.exceptions('SETPOINT_MISMATCH')[0]).toMatchObject({ severity: 'ACTION' });
    expect(run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'cmp', signature: { id: 'S', meaning: 'PERFORMED', signer: OP1.id } }).code).toMatch(/ENG-BLOCKED|G06-READBACK-MISSING/);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'cmp', entry: device(run, 'SETPOINT_READBACK', 'force.pre_kN', '2.00', 'kN') }).message).toMatch(/G06-NOT-A-SETPOINT/);
  });

  it('[DI-31][DI-32] a device value of quality STALE or BAD, or received longer ago than the configured age (database time), is flagged unusable, raises PROCESS_DATA_UNUSABLE and does not satisfy the step', () => {
    const run = started({ ...CONFIG, maxAgeSeconds: 30 });
    run.entry('cmp', { kind: 'RECIPE_CHECK', recipe: 'RCP-COMP', recipeVersion: '5' });
    run.entry('cmp', device(run, 'SETPOINT_READBACK', 'force.main_kN', '12.50', 'kN'));
    run.entry('cmp', device(run, 'ACTUAL', 'turret.speed_rpm', '45.0', 'rpm', { quality: 'STALE' }));
    run.entry('cmp', device(run, 'ACTUAL', 'turret.speed_rpm', '45.0', 'rpm', { quality: 'BAD' }));
    run.entry('cmp', device(run, 'ACTUAL', 'turret.speed_rpm', '45.0', 'rpm', { ageS: 31 }));
    expect(run.exceptions('PROCESS_DATA_UNUSABLE')).toHaveLength(3);
    expect(Object.values(run.state.entries).filter((e) => e.kind === 'ACTUAL').map((e) => e.data['usable'])).toEqual([false, false, false]);
    expect(run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'cmp', signature: { id: 'S', meaning: 'PERFORMED', signer: OP1.id } }).message).toMatch(/G06-ACTUAL-MISSING/);
    run.entry('cmp', device(run, 'ACTUAL', 'turret.speed_rpm', '45.0', 'rpm', { ageS: 30 }));
    run.perform('cmp');
  });

  it('[DI-32][PR-14] a value keyed by hand is refused unless the MBR allows the fallback; allowed, it is flagged, raises PROCESS_MANUAL_FALLBACK and the step needs a second person', () => {
    const strict = started();
    expect(strict.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'cmp', entry: { kind: 'ACTUAL', tag: 'turret.speed_rpm', value: '45.0', unit: 'rpm', source: 'MANUAL' } }).message).toMatch(/G06-MANUAL-NOT-ALLOWED/);
    const run = started({ ...CONFIG, manualFallback: true });
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'cmp', entry: { kind: 'ACTUAL', tag: 'turret.speed_rpm', value: '45.0', unit: 'rpm', source: 'MANUAL', quality: 'GOOD' } }).message).toMatch(/G06-PROVENANCE/);
    run.entry('cmp', { kind: 'INTERFACE_LOSS', reason: 'Gateway link down' });
    run.entry('cmp', { kind: 'RECIPE_CHECK', recipe: 'RCP-COMP', recipeVersion: '5' });
    run.entry('cmp', { kind: 'SETPOINT_READBACK', tag: 'force.main_kN', value: '12.50', unit: 'kN', source: 'MANUAL' });
    run.entry('cmp', { kind: 'ACTUAL', tag: 'turret.speed_rpm', value: '45.0', unit: 'rpm', source: 'MANUAL' });
    expect(Object.values(run.state.entries).filter((e) => e.kind === 'ACTUAL').map((e) => e.data['manualFallback'])).toEqual([true]);
    expect(types(run)).toEqual(['INTERFACE_LOSS', 'PROCESS_MANUAL_FALLBACK', 'PROCESS_MANUAL_FALLBACK']);
    expect(run.inst('cmp')?.verificationRequired).toBe(true);
    run.perform('cmp');
    expect(run.status('cmp')).toBe('AWAITING_VERIFICATION');
    // The performer cannot confirm it; a second, different person does.
    expect(run.exec({ type: 'VERIFY', actor: { ...OP1, roles: [...OP1.roles, 'PRODUCTION_VERIFIER'] }, step: 'cmp', signature: { id: 'V', meaning: 'VERIFIED', signer: OP1.id } }).accepted).toBe(false);
    run.verify('cmp', [], VER1);
    expect(run.status('cmp')).toBe('COMPLETED');
  });

  it('[DI-49] a GMP-critical alarm raises GMP_CRITICAL_ALARM; it is acknowledged only with a comment, once, and the step cannot be signed performed while any alarm is unacknowledged', () => {
    const run = started();
    nominal(run);
    run.entry('cmp', device(run, 'ALARM', 'force.main_kN', '14.10', 'kN'));
    run.entry('cmp', device(run, 'ALARM', 'turret.speed_rpm', '61.0', 'rpm'));
    const [critical, plain] = Object.values(run.state.entries).filter((e) => e.kind === 'ALARM');
    expect([critical?.data['critical'], plain?.data['critical']]).toEqual([true, false]);
    expect(types(run)).toEqual(['GMP_CRITICAL_ALARM']);
    expect(run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'cmp', signature: { id: 'S', meaning: 'PERFORMED', signer: OP1.id } }).message).toMatch(/G06-ALARM-UNACKNOWLEDGED/);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP2, step: 'cmp', entry: { kind: 'ALARM_ACK', alarm: critical?.id ?? '' } }).message).toMatch(/G06-ACK-COMMENT/);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP2, step: 'cmp', entry: { kind: 'ALARM_ACK', alarm: critical?.id ?? '', comment: '   ' } }).message).toMatch(/G06-ACK-COMMENT/);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP2, step: 'cmp', entry: { kind: 'ALARM_ACK', alarm: 'EN-999', comment: 'x' } }).message).toMatch(/G06-ACK-UNKNOWN/);
    run.entry('cmp', { kind: 'ALARM_ACK', alarm: critical?.id ?? '', comment: 'Force spike on one station; tooling inspected' }, [], OP2);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP2, step: 'cmp', entry: { kind: 'ALARM_ACK', alarm: critical?.id ?? '', comment: 'again' } }).message).toMatch(/G06-ACK-TWICE/);
    run.entry('cmp', { kind: 'ALARM_ACK', alarm: plain?.id ?? '' }, [], OP2);
    const ack = Object.values(run.state.entries).find((e) => e.kind === 'ALARM_ACK');
    expect(ack?.data).toEqual({ alarm: critical?.id, comment: 'Force spike on one station; tooling inspected', acknowledgedBy: OP2.id });
    run.perform('cmp');
  });

  it('[DI-04][PR-14] the equipment running another recipe or version than the MBR names raises RECIPE_MISMATCH, which stops the step until QA decides; a configured step cannot be performed before the recipe is checked', () => {
    const run = started();
    run.entry('cmp', device(run, 'SETPOINT_READBACK', 'force.main_kN', '12.50', 'kN'));
    run.entry('cmp', device(run, 'ACTUAL', 'turret.speed_rpm', '45.0', 'rpm'));
    expect(run.refused({ type: 'SIGN_PERFORMED', actor: OP1, step: 'cmp', signature: { id: 'S', meaning: 'PERFORMED', signer: OP1.id } }).message).toMatch(/G06-RECIPE-UNCHECKED/);
    run.entry('cmp', { kind: 'RECIPE_CHECK', recipe: 'RCP-COMP', recipeVersion: '4' });
    expect(types(run)).toEqual(['RECIPE_MISMATCH']);
    expect(run.exceptions('RECIPE_MISMATCH')[0]).toMatchObject({ severity: 'ACTION' });
  });

  it('[DI-31] a collected value outside its acceptance limits raises PROCESS_VALUE_OUT_OF_LIMITS; a tag the step does not collect, or in another unit, is refused', () => {
    const run = started();
    nominal(run);
    run.entry('cmp', device(run, 'ACTUAL', 'turret.speed_rpm', '60.1', 'rpm'));
    expect(types(run)).toEqual(['PROCESS_VALUE_OUT_OF_LIMITS']);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'cmp', entry: device(run, 'ACTUAL', 'fill.depth_mm', '9.00', 'mm') }).message).toMatch(/G06-NOT-COLLECTED/);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'cmp', entry: device(run, 'ACTUAL', 'turret.speed_rpm', '45.0', 'rph') }).message).toMatch(/G06-UNIT/);
    expect(run.refused({ type: 'RECORD_ENTRY', actor: OP1, step: 'cmp', entry: { kind: 'ACTUAL', tag: 'turret.speed_rpm', value: '45.0', unit: 'rpm', source: 'EQUIPMENT' } }).message).toMatch(/G06-PROVENANCE/);
  });

  it('[DI-31][DI-04] the configuration: duplicate tags, inverted limits and a configured step without an equipment recipe are errors; config {} defines as before', () => {
    const problems = (config: Record<string, unknown>, system: typeof SYSTEM | null) => {
      try {
        defineBatch(press(config, system), { registry: genericBlockRegistry(), expressions: expr, installation: 'SANDBOX' });
        return [];
      } catch (e) {
        if (e instanceof EngineDefinitionError) return e.problems.map((p) => p.message.match(/G06-[A-Z-]+/)?.[0] ?? p.code);
        throw e;
      }
    };
    expect(problems({ actuals: [{ tag: 'turret.speed_rpm', unit: 'rpm' }, { tag: 'turret.speed_rpm', unit: 'rpm' }] }, SYSTEM)).toEqual(['G06-DUPLICATE-TAG']);
    expect(problems({ actuals: [{ tag: 'turret.speed_rpm', unit: 'rpm', min: '60', max: '20' }] }, SYSTEM)).toEqual(['G06-LIMITS']);
    expect(problems({ actuals: [{ tag: 'turret.speed_rpm', unit: 'rpm' }] }, null)).toContain('G06-NO-RECIPE');
    expect(problems({}, SYSTEM)).toEqual([]);
    const p = phase('x', { block: { type: 'G-06', version: '1' }, config: CONFIG, system: SYSTEM });
    const input = { phase: p, mbr: press(), frames: [], containers: [], target: () => undefined };
    expect(G06.simulatorModel?.nominalEntries({ ...input, config: {}, nowUs: T0 })).toEqual([]);
    expect(G06.simulatorModel?.nominalEntries({ ...input, config: CONFIG, nowUs: T0 }).map((e) => e.kind)).toEqual(['RECIPE_CHECK', 'SETPOINT_READBACK', 'ACTUAL']);
  });
});
