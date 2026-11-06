/**
 * Capsules edition C4 (docs/build-plan/capsules/plan.md): multiparticulates. A delayed-release pellet capsule built from
 * the ready-made catalogue (drug layering on inert cores, a seal coat and an enteric coat in the fluid bed, each from its
 * own suspension, multi-station filling and the fill weight test) passes the formulation checks and runs to completion on
 * the engine. The enteric coat's material is a per-batch formula line; the shells are the per-unit line (C2).
 */
import { describe, expect, it } from 'vitest';
import type { MbrContent, PhaseNode } from '../../src/flow/model.ts';
import { checkBlockUse, libraryBlockType, libraryBlockVersion } from '../../src/library/index.ts';
import { define, Run, T0, testRegistry } from '../engine/support.ts';
import { expr, mbrWith, phase } from '../flow/support.ts';
import { byCode as item, configOf, runNominalStep, useOf } from './seed-support.ts';

/** A step of the master: the catalogue block with its example values, its formula lines and counts as given. */
interface Step {
  id: string;
  code: string;
  bomLines?: Record<string, string>;
  counts?: Record<string, string>;
}

const STEPS: readonly Step[] = [
  { id: 'p-layer', code: 'PROC-PELLET-LAYER', bomLines: { coresLine: 'BOM-CORES' } },
  { id: 'p-seal-susp', code: 'COAT-SUSPENSION-PREP', bomLines: { coatingLine: 'BOM-SEAL' } },
  { id: 'p-seal', code: 'COAT-PELLET-FB' },
  { id: 'p-ent-susp', code: 'COAT-SUSPENSION-PREP', bomLines: { coatingLine: 'BOM-ENTERIC' } },
  { id: 'p-enteric', code: 'COAT-PELLET-FB' },
  { id: 'p-fill', code: 'PROC-CAPS-FILL-MULTI', bomLines: { shellLine: 'BOM-SHELL' }, counts: { stations: '2' } },
  { id: 'p-fill-weight', code: 'IPC-CAPS-FILL-WEIGHT' },
];


/** The delayed-release pellet capsule: the BOM at the reference size; the coats' materials are per-batch excipient lines, the shells the line of role OTHER (C2). */
const BOM: MbrContent['bom'] = [
  { id: 'BOM-CORES', material: 'MAT-SUGAR-SPHERES', role: 'EXCIPIENT', quantity: { value: '20', unit: 'kg' } },
  { id: 'BOM-SEAL', material: 'MAT-HPMC-SEAL', role: 'EXCIPIENT', quantity: { value: '6', unit: 'kg' } },
  { id: 'BOM-ENTERIC', material: 'MAT-METHACRYLIC-COPOLYMER', role: 'EXCIPIENT', quantity: { value: '6', unit: 'kg' } },
  { id: 'BOM-SHELL', material: 'MAT-SHELLS-SIZE-1', role: 'OTHER', quantity: { value: '4', unit: 'kg' } },
];

function master(): { mbr: MbrContent; registry: ReturnType<typeof testRegistry> } {
  const phases: PhaseNode[] = STEPS.map((s) => phase(s.id, { name: item(s.code).definition.title, block: { type: libraryBlockType(s.code), version: '1' }, config: configOf(useOf(s)) as never }));
  const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [...phases, phase('after')] }, { bom: BOM });
  const defs = [...new Set(STEPS.map((s) => s.code))].map((c) => libraryBlockVersion(item(c).definition, expr));
  return { mbr: { ...mbr, header: { ...mbr.header, product: { ...mbr.header.product, dosageForm: 'Delayed-release hard capsule (pellets)' } } }, registry: testRegistry().extend(...defs) };
}

describe('multiparticulates in hard capsules (Capsules C4)', () => {
  it('[PR-03][PR-18][IN-36][IN-37] a delayed-release pellet capsule from the catalogue (drug layering on inert cores, seal and enteric coats in the fluid bed from their own suspensions, two-station filling, the fill weight test) passes the formulation checks and runs to completion with no exception', () => {
    const { mbr, registry } = master();
    for (const s of STEPS) expect(checkBlockUse(item(s.code).definition, useOf(s), expr, BOM), s.id).toEqual([]);
    const run = Run.issue(define(mbr, { registry }), {}, T0);
    for (const s of STEPS) {
      runNominalStep(run, s.id, item(s.code).definition, configOf(useOf(s)), mbr);
      expect(run.status(s.id), s.id).toBe('COMPLETED');
    }
    expect(run.exceptions().map((x) => x.type)).toEqual([]);
    // The enteric coat's material is a per-batch COATING line its own suspension step reads; the shells are the filling's.
    const lots = (id: string): string[] => Object.values(run.state.entries).filter((e) => e.stepKey.startsWith(`${id}@`)).flatMap((e) => Object.keys(e.data).filter((k) => k.endsWith('Lot')));
    expect(lots('p-ent-susp')).toContain('coatingLot');
    expect(lots('p-fill')).toContain('shellLot');
  });

  it('[PR-08][IN-36] fluid-bed pellet work records product-dedicated filter bags, temperatures (critical) and spray rate and atomising air (against limits, not critical) at each round, a weight gain checked until it passes (with a maximum of checks) and a timed cure; extrusion-spheronisation records speeds and time against limits (not critical; no clause names them)', () => {
    const coat = item('COAT-PELLET-FB').definition;
    const fields = new Map(coat.sections.flatMap((x) => x.fields.map((f) => [f.id, f] as const)));
    expect(fields.get('filterBags')).toMatchObject({ type: 'YES_NO', expected: true });
    expect(fields.get('layer')).toMatchObject({ type: 'CHOICE', options: ['Seal coat', 'Delayed-release (enteric) coat', 'Sustained-release coat'] });
    expect(coat.sections.find((x) => x.id === 'gainCheck')?.repeat).toEqual({ kind: 'UNTIL_PASS', untilField: 'weightGain', maxRepeatsSlot: 'maxGainChecks' });
    expect(fields.get('weightGain')).toMatchObject({ type: 'CALC', limitSlot: 'weightGain' });
    expect(fields.get('weightGain')).not.toHaveProperty('critical');
    expect(fields.get('curing')).toMatchObject({ type: 'TIMER', critical: true });
    for (const id of ['inletTemp', 'productTemp']) expect(fields.get(id), id).toMatchObject({ critical: true });
    for (const id of ['sprayRate', 'atomisingAir']) expect(fields.get(id), id).toMatchObject({ limitSlot: id });
    for (const id of ['sprayRate', 'atomisingAir']) expect(fields.get(id), id).not.toHaveProperty('critical');
    expect(item('PROC-PELLET-LAYER').definition.sections[0]?.fields.find((f) => f.id === 'coresLot')).toMatchObject({ type: 'MATERIAL_LOT', bomLineSlot: 'coresLine' });
    const ext = new Map(item('PROC-EXTRUDE-SPHERONISE').definition.sections.flatMap((x) => x.fields.map((f) => [f.id, f] as const)));
    for (const id of ['extruderSpeed', 'plateSpeed', 'spheronising']) expect(ext.get(id), id).not.toHaveProperty('critical');
  });

  it('[PR-03][PR-18] multi-station filling: one to four stations, each recording what it doses and its input; the shells are the per-unit formula line; the capsule\'s fill weight is the fill weight test\'s', () => {
    const fill = item('PROC-CAPS-FILL-MULTI').definition;
    const station = fill.sections.find((x) => x.id === 'station');
    expect(station?.repeat).toEqual({ kind: 'COUNT', countSlot: 'stations' });
    expect(station?.fields.map((f) => f.id)).toEqual(['content', 'stationIn']);
    expect(fill.sections.flatMap((x) => x.fields).find((f) => f.id === 'shellLot')).toMatchObject({ type: 'MATERIAL_LOT', bomLineSlot: 'shellLine' });
    expect(STEPS.map((s) => s.code)).toContain('IPC-CAPS-FILL-WEIGHT');
    // Four stations at most: a fifth is not a count the station section takes in this block's example.
    expect(Number(item('PROC-CAPS-FILL-MULTI').exampleUse.counts?.['stations'])).toBeLessThanOrEqual(4);
  });
});
