/**
 * Capsules edition C6 (docs/build-plan/capsules/plan.md, section 3.3): soft gels I. A soft gelatin capsule built from the
 * ready-made catalogue (gel mass, its hold as the master's PROC-HOLD step, rotary die encapsulation, the fill and shell
 * weight and seal thickness tests, drying to the hardness end point, the hardness test and visual inspection) passes the
 * formulation checks and runs to completion on the engine. Fill preparation (PROC-FILL-PREP) is C5's and not on this base.
 */
import { describe, expect, it } from 'vitest';
import type { MbrContent, PhaseNode } from '../../src/flow/model.ts';
import { checkBlockUse, libraryBlockType, libraryBlockVersion } from '../../src/library/index.ts';
import { CAPSULE_CATALOGUE, SEED_GROUPS } from '../../src/library/seed/index.ts';
import { define, Run, T0, testRegistry } from '../engine/support.ts';
import { expr, mbrWith, phase } from '../flow/support.ts';
import { byCode as item, configOf, fieldOf, judgedRun, nominalRun, runNominalStep, useOf } from './seed-support.ts';

interface Step {
  id: string;
  code: string;
  bomLines?: Record<string, string>;
}

const STEPS: readonly Step[] = [
  { id: 'p-gel', code: 'SG-GEL-MASS', bomLines: { gelatinLine: 'BOM-GELATIN' } },
  { id: 'p-gel-hold', code: 'PROC-HOLD' },
  { id: 'p-encap', code: 'SG-ENCAP-ROTARY' },
  { id: 'p-fill-shell', code: 'IPC-SG-FILL-SHELL' },
  { id: 'p-seal', code: 'IPC-SG-SEAL-THICKNESS' },
  { id: 'p-dry', code: 'SG-DRY' },
  { id: 'p-hardness', code: 'IPC-SG-HARDNESS' },
  { id: 'p-inspect', code: 'PROC-CAPS-INSPECT' },
];

const SOFTGEL_CODES = ['SG-GEL-MASS', 'SG-ENCAP-ROTARY', 'SG-ENCAP-SEAMLESS', 'SG-DRY', 'IPC-SG-FILL-SHELL', 'IPC-SG-SEAL-THICKNESS', 'IPC-SG-HARDNESS'];


/** The soft gel: the BOM at the reference size (the gelatin is the gel mass's per-batch excipient line). */
const BOM: MbrContent['bom'] = [
  { id: 'BOM-API', material: 'MAT-API', role: 'ACTIVE', quantity: { value: '5', unit: 'kg' } },
  { id: 'BOM-OIL', material: 'MAT-SOYBEAN-OIL', role: 'EXCIPIENT', quantity: { value: '45', unit: 'kg' } },
  { id: 'BOM-GELATIN', material: 'MAT-GELATIN-BOVINE', role: 'EXCIPIENT', quantity: { value: '30', unit: 'kg' } },
  { id: 'BOM-GLYCERIN', material: 'MAT-GLYCERIN', role: 'EXCIPIENT', quantity: { value: '12', unit: 'kg' } },
];

function master(): { mbr: MbrContent; registry: ReturnType<typeof testRegistry> } {
  const phases: PhaseNode[] = STEPS.map((s) => phase(s.id, { name: item(s.code).definition.title, block: { type: libraryBlockType(s.code), version: '1' }, config: configOf(useOf(s)) as never }));
  const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [...phases, phase('after')] }, { bom: BOM });
  const defs = [...new Set(STEPS.map((s) => s.code))].map((c) => libraryBlockVersion(item(c).definition, expr));
  return { mbr: { ...mbr, header: { ...mbr.header, product: { ...mbr.header.product, dosageForm: 'Soft gelatin capsule' } } }, registry: testRegistry().extend(...defs) };
}

describe('soft gels I (Capsules C6)', () => {
  it('[PR-03][PR-18][IN-36][IN-37] a soft gelatin capsule from the catalogue (gel mass, its hold step, rotary die encapsulation, fill and shell weight, seal thickness, drying to the end point, hardness, inspection) passes the formulation checks and runs to completion with no exception', () => {
    const { mbr, registry } = master();
    expect(mbr.header.product.dosageForm).toBe('Soft gelatin capsule');
    for (const s of STEPS) expect(checkBlockUse(item(s.code).definition, useOf(s), expr, BOM), s.id).toEqual([]);
    const run = Run.issue(define(mbr, { registry }), {}, T0);
    for (const s of STEPS) {
      runNominalStep(run, s.id, item(s.code).definition, configOf(useOf(s)), mbr);
      expect(run.status(s.id), s.id).toBe('COMPLETED');
    }
    expect(run.exceptions().map((x) => x.type)).toEqual([]);
    // The gelatin lot is named in the gel mass step against its formula line.
    const keys = Object.values(run.state.entries).filter((e) => e.stepKey.startsWith('p-gel@')).flatMap((e) => Object.keys(e.data));
    expect(keys).toContain('gelatinLot');
  });

  it('[PR-05] the soft gel blocks are their own catalogue group and part of the capsule catalogue; no washing block (no binding clause maps to it, D-C6-1)', () => {
    expect(SEED_GROUPS['soft gels']?.map((s) => s.definition.code)).toEqual(SOFTGEL_CODES);
    const capsules = CAPSULE_CATALOGUE.map((s) => s.definition.code);
    for (const c of SOFTGEL_CODES) expect(capsules, c).toContain(c);
    expect(capsules).not.toContain('SG-WASH');
  });

  it('[PR-08][PR-18][IN-36] gel mass: the gelatin lot is a formula line; mixing temperature and time are critical values (Schedule M Part VIII 2.3); deaeration vacuum and time and the viscosity are recorded against limits, not critical; no in-step holding timer (D-C3-6)', () => {
    const gel = item('SG-GEL-MASS');
    expect(fieldOf(gel, 'gelatinLot')).toMatchObject({ type: 'MATERIAL_LOT', bomLineSlot: 'gelatinLine' });
    for (const id of ['meltTemp', 'mixing']) expect(fieldOf(gel, id), id).toMatchObject({ critical: true });
    for (const id of ['vacuum', 'deaeration', 'viscosity']) expect(fieldOf(gel, id), id).not.toHaveProperty('critical');
    const timers = gel.definition.sections.flatMap((x) => x.fields).filter((f) => f.type === 'TIMER').map((f) => f.id);
    expect(timers).toEqual(['mixing', 'deaeration']);
    expect(nominalRun(gel)).toEqual({ exceptions: [], status: 'COMPLETED' });
  });

  it('[PR-08][IN-37] rotary die encapsulation: the encapsulator, die rolls, gel mass and fill inputs, the lines-connected check (EU GMP 5.14) and, at each round, ribbon thickness and wedge temperature against their limits (not critical; fill and shell weight are IPC-SG-FILL-SHELL\'s); signed by operator and verifier; a thin ribbon raises an exception', () => {
    const enc = item('SG-ENCAP-ROTARY');
    expect(fieldOf(enc, 'encapsulator')).toMatchObject({ type: 'EQUIPMENT', classSlot: 'encapsulatorClass' });
    expect([fieldOf(enc, 'gelMassIn'), fieldOf(enc, 'fillIn')]).toEqual([expect.objectContaining({ type: 'CONTAINER', action: 'CONSUME' }), expect.objectContaining({ type: 'CONTAINER', action: 'CONSUME' })]);
    expect(fieldOf(enc, 'linesConnected')).toMatchObject({ type: 'YES_NO', expected: true });
    const round = enc.definition.sections.find((x) => x.id === 'round');
    expect(round?.repeat).toEqual({ kind: 'PER_INTERVAL', intervalSlot: 'roundInterval' });
    expect(round?.fields.map((f) => [f.id, (f as { critical?: boolean }).critical])).toEqual([['ribbonThickness', undefined], ['wedgeTemp', undefined]]);
    expect(enc.definition.signatures.map((x) => x.meaning)).toEqual(['PERFORMED', 'VERIFIED']);
    // The only YES_NO of the soft gel blocks is the lines-connected check (rotary and seamless, C7).
    const yesNo = SOFTGEL_CODES.flatMap((c) => item(c).definition.sections.flatMap((x) => x.fields).filter((f) => f.type === 'YES_NO').map((f) => `${c}.${f.id}`));
    expect(yesNo).toEqual(['SG-ENCAP-ROTARY.linesConnected', 'SG-ENCAP-SEAMLESS.linesConnected']);
    // Breach: a ribbon thinner than its registered limit raises an exception and the step cannot complete with it open.
    expect(judgedRun(enc, { round: { ribbonThickness: '0.70' } })).toEqual({ exceptions: ['LIB_LIMIT_BREACH'], status: 'IN_PROGRESS' });
  });

  it('[PR-08][IN-36] drying: a timed tumble at a critical air temperature, then tray drying checked for room temperature, humidity (not critical) and hardness until the end point, and the drying time timed as a critical value', () => {
    const dry = item('SG-DRY');
    for (const id of ['airTemp', 'tumbling', 'roomTemp', 'hardness', 'dryingTime']) expect(fieldOf(dry, id), id).toMatchObject({ critical: true });
    expect(fieldOf(dry, 'roomRh')).not.toHaveProperty('critical');
    expect(dry.definition.sections.find((x) => x.id === 'endPoint')?.repeat).toEqual({ kind: 'UNTIL_PASS', untilField: 'hardness', maxRepeatsSlot: 'maxEndPointChecks' });
    expect(fieldOf(dry, 'dryingTime')).toMatchObject({ type: 'TIMER', durationUnit: 'h', limitSlot: 'dryingTime' });
    expect(fieldOf(dry, 'tunnel')).toMatchObject({ type: 'EQUIPMENT', kind: 'ROOM' });
    expect(nominalRun(dry)).toEqual({ exceptions: [], status: 'COMPLETED' });
  });

  it('[PR-03][IN-37] in-process tests: fill weight per capsule is gross less shell with the mean judged after, a light capsule breaching it; seal thickness has a minimum; hardness has mean and individual limits', () => {
    const fs = item('IPC-SG-FILL-SHELL');
    expect(fs.definition.sections.find((x) => x.id === 'capsule')?.repeat).toEqual({ kind: 'COUNT', countSlot: 'capsules' });
    expect(fieldOf(fs, 'fill')).toMatchObject({ type: 'CALC', expression: 'gross - shell', limitSlot: 'individualFill', critical: true });
    expect(fieldOf(fs, 'shell')).toMatchObject({ limitSlot: 'shellWeight', critical: true });
    expect(fieldOf(fs, 'meanFill')).toMatchObject({ type: 'CALC', expression: 'mean(fill)', limitSlot: 'meanFill', critical: true });
    expect(nominalRun(fs)).toEqual({ exceptions: [], status: 'COMPLETED' });
    // A capsule 60 mg light (gross 750 mg, shell 310 mg: fill 440 mg, below 475 mg) breaches the individual fill limit.
    expect(judgedRun(fs, { capsule: { gross: '750.0' } }).exceptions).toContain('LIB_LIMIT_BREACH');
    expect(fieldOf(item('IPC-SG-SEAL-THICKNESS'), 'seal')).toMatchObject({ type: 'TEST_RESULT', unit: 'mm', statistics: [{ statistic: 'MIN', limitSlot: 'minSeal' }] });
    expect(fieldOf(item('IPC-SG-HARDNESS'), 'hardness')).toMatchObject({ type: 'TEST_RESULT', unit: 'N', statistics: [{ statistic: 'MEAN', limitSlot: 'meanHardness' }, { statistic: 'INDIVIDUAL', limitSlot: 'individualHardness' }] });
    for (const c of ['IPC-SG-SEAL-THICKNESS', 'IPC-SG-HARDNESS']) expect(nominalRun(item(c)), c).toEqual({ exceptions: [], status: 'COMPLETED' });
  });
});
