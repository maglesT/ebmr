/**
 * Capsules edition C4 (docs/build-plan/capsules/plan.md): multiparticulates. A delayed-release pellet capsule built from
 * the ready-made catalogue (drug layering on inert cores, a seal coat and an enteric coat in the fluid bed, each from its
 * own suspension, multi-station filling and the fill weight test) passes the formulation checks and runs to completion on
 * the engine. The enteric coat's material is a per-batch formula line; the shells are the per-unit line (C2).
 */
import { describe, expect, it } from 'vitest';
import type { MbrContent, PhaseNode } from '../../src/flow/model.ts';
import { checkBlockUse, libraryBlockType, libraryBlockVersion, nominalEntries, TIMER_STOP } from '../../src/library/index.ts';
import type { BlockUse } from '../../src/library/model.ts';
import { SEED_CATALOGUE, type SeedItem } from '../../src/library/seed/index.ts';
import { define, OP1, Run, T0, testRegistry } from '../engine/support.ts';
import { expr, mbrWith, phase } from '../flow/support.ts';

const item = (code: string): SeedItem => {
  const s = SEED_CATALOGUE.find((x) => x.definition.code === code);
  if (!s) throw new Error(`${code} is not in the catalogue`);
  return s;
};

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

const useOf = (s: Step): BlockUse => {
  const ex = item(s.code).exampleUse;
  return { block: { code: s.code, version: 1 }, ...ex, ...(s.bomLines ? { bomLines: s.bomLines } : {}), ...(s.counts ? { counts: { ...ex.counts, ...s.counts } } : {}) };
};
const configOf = (use: BlockUse): Record<string, unknown> => Object.fromEntries(Object.entries(use).filter(([k]) => k !== 'block'));

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

/** Runs one library step with its nominal entries (as the catalogue's own nominal run, seed.test.ts). */
function runStep(run: Run, mbr: MbrContent, s: Step): void {
  const def = item(s.code).definition;
  const use = useOf(s);
  run.start(s.id);
  const entries = nominalEntries(def, configOf(use) as never, mbr);
  const rounds = entries.filter((e) => def.sections.some((x) => x.id === e.kind && x.repeat?.kind === 'PER_INTERVAL'));
  for (const e of entries) {
    if (e.kind === TIMER_STOP) {
      for (let i = 0; i < 6; i++) {
        run.minutes(10 - rounds.length);
        for (const r of rounds) {
          run.entry(s.id, r);
          run.minutes(1);
        }
      }
    }
    run.entry(s.id, e);
    run.minutes(1);
  }
  run.perform(s.id);
  if (run.status(s.id) === 'AWAITING_VERIFICATION') run.verify(s.id);
}

describe('multiparticulates in hard capsules (Capsules C4)', () => {
  it('[PR-03][PR-18][IN-36][IN-37] a delayed-release pellet capsule from the catalogue (drug layering on inert cores, seal and enteric coats in the fluid bed from their own suspensions, two-station filling, the fill weight test) passes the formulation checks and runs to completion with no exception', () => {
    const { mbr, registry } = master();
    for (const s of STEPS) expect(checkBlockUse(item(s.code).definition, useOf(s), expr, BOM), s.id).toEqual([]);
    const run = Run.issue(define(mbr, { registry }), {}, T0);
    for (const s of STEPS) {
      runStep(run, mbr, s);
      expect(run.status(s.id), s.id).toBe('COMPLETED');
    }
    expect(run.exceptions().map((x) => x.type)).toEqual([]);
    // The enteric coat's material is a per-batch COATING line its own suspension step reads; the shells are the filling's.
    const lots = (id: string): string[] => Object.values(run.state.entries).filter((e) => e.stepKey.startsWith(`${id}@`)).flatMap((e) => Object.keys(e.data).filter((k) => k.endsWith('Lot')));
    expect(lots('p-ent-susp')).toContain('coatingLot');
    expect(lots('p-fill')).toContain('shellLot');
  });

  it('[PR-08][IN-36] fluid-bed pellet work records product-dedicated filter bags, critical spray parameters at each round, a weight gain checked until it passes (with a maximum of checks) and a timed cure; extrusion-spheronisation records the screen and critical speeds and time', () => {
    const coat = item('COAT-PELLET-FB').definition;
    const fields = new Map(coat.sections.flatMap((x) => x.fields.map((f) => [f.id, f] as const)));
    expect(fields.get('filterBags')).toMatchObject({ type: 'YES_NO', expected: true });
    expect(fields.get('layer')).toMatchObject({ type: 'CHOICE', options: ['Seal coat', 'Delayed-release (enteric) coat', 'Sustained-release coat', 'Top coat'] });
    expect(coat.sections.find((x) => x.id === 'gainCheck')?.repeat).toEqual({ kind: 'UNTIL_PASS', untilField: 'weightGain', maxRepeatsSlot: 'maxGainChecks' });
    expect(fields.get('weightGain')).toMatchObject({ type: 'CALC', critical: true, limitSlot: 'weightGain' });
    expect(fields.get('curing')).toMatchObject({ type: 'TIMER', critical: true });
    for (const id of ['inletTemp', 'productTemp', 'sprayRate', 'atomisingAir']) expect(fields.get(id), id).toMatchObject({ critical: true });
    expect(item('PROC-PELLET-LAYER').definition.sections[0]?.fields.find((f) => f.id === 'coresLot')).toMatchObject({ type: 'MATERIAL_LOT', bomLineSlot: 'coresLine' });
    const ext = new Map(item('PROC-EXTRUDE-SPHERONISE').definition.sections.flatMap((x) => x.fields.map((f) => [f.id, f] as const)));
    for (const id of ['extruderSpeed', 'plateSpeed', 'spheronising']) expect(ext.get(id), id).toMatchObject({ critical: true });
  });

  it('[PR-08][PR-03] multi-station filling: one to four stations, each with its input and set fill; a station filling outside its set fill raises an exception and the step cannot complete; a set fill of zero is refused', () => {
    const fill = item('PROC-CAPS-FILL-MULTI');
    expect(fill.definition.sections.find((x) => x.id === 'station')?.repeat).toEqual({ kind: 'COUNT', countSlot: 'stations' });
    const round = fill.definition.sections.find((x) => x.id === 'round');
    expect(round?.fields.find((f) => f.id === 'fillRatio')).toMatchObject({ type: 'CALC', critical: true, limitSlot: 'fillRatio' });
    const s: Step = { id: 'p-fill', code: 'PROC-CAPS-FILL-MULTI', bomLines: { shellLine: 'BOM-SHELL' }, counts: { stations: '1' } };
    const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [phase('p-fill', { block: { type: libraryBlockType(s.code), version: '1' }, config: configOf(useOf(s)) as never }), phase('after')] }, { bom: BOM });
    const run = Run.issue(define(mbr, { registry: testRegistry().extend(libraryBlockVersion(fill.definition, expr)) }), {}, T0);
    run.start('p-fill');
    for (const e of nominalEntries(fill.definition, configOf(useOf(s)) as never, mbr)) {
      // A station 10 % light: 90 % of its set fill, outside 95-105 %.
      run.entry('p-fill', e.kind === 'round' ? { ...e, stationSet: '150.0', stationFill: '135.0' } : e);
      run.minutes(1);
    }
    expect(run.exceptions().map((x) => x.type)).toContain('LIB_LIMIT_BREACH');
    expect(() => run.perform('p-fill')).toThrow(/outside its registered limit/);
    // A set fill of zero is refused, never turned into a percentage.
    const zero = run.exec({ type: 'RECORD_ENTRY', actor: OP1, step: 'p-fill', context: [], entry: { kind: 'round', stationNo: '1', stationSet: '0.0', stationFill: '135.0', counted: true, locked: true } });
    expect(zero.accepted).toBe(false);
    expect(zero.refusal?.code).toBe('LIB-CALC-FAILED');
  });
});
