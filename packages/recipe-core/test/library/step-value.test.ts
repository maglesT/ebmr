/**
 * Earlier-step values (decision 0026 STEP_VALUE; injectables I-1 finding, lead 5 November 2026). A library block's
 * calculation reads a value recorded by an earlier step of the master (e.g. the LOD of the lot for potency-adjusted
 * dispensing): from the one completed instance of that step, in the input's unit. The master check refuses a step value
 * that names no earlier step, or a value that step does not record once, so QA never approves a master that fails on
 * the floor. A phase that reads the input from the master keeps doing so.
 */
import { describe, expect, it } from 'vitest';
import type { DataValue } from '../../src/engine/types.ts';
import type { FlowNode, MbrContent } from '../../src/flow/model.ts';
import { libraryBlockType, libraryBlockVersion, nominalEntries } from '../../src/library/index.ts';
import { SEED_CATALOGUE } from '../../src/library/seed/index.ts';
import type { BlockDefinition, BlockUse } from '../../src/library/model.ts';
import { define, Run, T0, testRegistry } from '../engine/support.ts';
import { expr, mbrWith, phase } from '../flow/support.ts';
import { potencyDispensing } from './examples.ts';

/** A use's configuration as a phase carries it (the block reference left out). */
function configOf(use: BlockUse): Record<string, unknown> {
  return Object.fromEntries(Object.entries(use).filter(([k]) => k !== 'block'));
}

/** An LOD test recorded once, in % (or in another unit, to see the conversion). */
const lodTest = (unit = '%'): BlockDefinition => ({
  code: 'IPC-LOD',
  version: 1,
  title: 'Loss on drying',
  category: 'TEST_IPC',
  sections: [
    { id: 'test', title: 'Test', fields: [{ id: 'lod', label: 'LOD', type: 'NUMBER', unit }] },
    { id: 'repeat', title: 'Repeat', repeat: { kind: 'COUNT', countSlot: 'n' }, fields: [{ id: 'again', label: 'Again', type: 'NUMBER', unit }] },
  ],
  signatures: [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }],
});

const MASTER_INPUTS: Record<string, DataValue> = {
  labelQty: { kind: 'DECIMAL', value: '10', unit: 'kg' },
  assay: { kind: 'DECIMAL', value: '98', unit: '%' },
  batchSize: { kind: 'DECIMAL', value: '100', unit: 'kg' },
};

/** A master: the LOD test and the dispensing in the given order, the dispensing reading lodTest.<field>. */
function master(order: 'LOD_FIRST' | 'DISPENSE_FIRST' | 'LOD_IN_REPLICATE' | 'DISPENSE_IN_REPLICATE', source: { step: string; field: string }, lodUnit = '%'): { mbr: MbrContent; registry: ReturnType<typeof testRegistry> } {
  const disp = potencyDispensing();
  const use: BlockUse = { block: { code: disp.code, version: 1 }, bomLines: { activeLine: 'BOM-API' }, stepValues: { lodSource: source } };
  const lodUse: BlockUse = { block: { code: 'IPC-LOD', version: 1 }, counts: { n: '1' } };
  const lodStep = phase('lodTest', { block: { type: libraryBlockType('IPC-LOD'), version: '1' }, config: configOf(lodUse) as never });
  const p = phase('p', { block: { type: libraryBlockType(disp.code), version: '1' }, config: configOf(use) as never, reads: Object.keys(MASTER_INPUTS) });
  const rep = (body: FlowNode): FlowNode => ({ kind: 'replicate', id: 'R', name: 'Sub-lots', count: { mode: 'RUNTIME', min: 1, max: 3, reasonRequired: true }, instances: 'SEQUENTIAL', subLotPrefix: 'SL', body });
  const children: FlowNode[] =
    order === 'LOD_FIRST' ? [lodStep, p, phase('after')]
    : order === 'DISPENSE_FIRST' ? [p, lodStep, phase('after')]
    : order === 'LOD_IN_REPLICATE' ? [rep(lodStep), p, phase('after')]
    : [lodStep, rep(p), phase('after')];
  const mbr = mbrWith({ kind: 'sequence', id: 'ops', children }, {
    bom: [{ id: 'BOM-API', material: 'API', role: 'ACTIVE', quantity: { value: '10', unit: 'kg' } }],
    inputs: Object.entries(MASTER_INPUTS).map(([id, v]) => ({ id, name: id, source: 'MASTER_DATA' as const, valueType: 'DECIMAL' as const, unit: (v as { unit: string }).unit })),
  });
  return { mbr, registry: testRegistry().extend(libraryBlockVersion(disp, expr), libraryBlockVersion(lodTest(lodUnit), expr)) };
}

const issue = (m: ReturnType<typeof master>): Run =>
  Run.issue(define(m.mbr, { registry: m.registry }), { inputs: Object.fromEntries(Object.entries(MASTER_INPUTS).map(([k, v]) => [k, { value: v, source: 'test' }])) }, T0);

const weigh = { kind: 'weigh', lot: 'L1', lots: { lot: { id: 'L1', material: 'API', status: 'RELEASED', identityTested: true } }, net: '10.4', rework: false };

function completeLod(run: Run, lod: string): void {
  run.start('lodTest');
  run.entry('lodTest', { kind: 'test', lod });
  run.entry('lodTest', { kind: 'repeat', again: lod });
  run.perform('lodTest');
  if (run.status('lodTest') === 'AWAITING_VERIFICATION') run.verify('lodTest');
  expect(run.status('lodTest')).toBe('COMPLETED');
}

const required = (run: Run): { value: string; inputs: Record<string, { value?: string; unit?: string }> } | undefined => {
  const e = Object.values(run.state.entries).find((x) => x.kind === 'weigh');
  return (e?.data['computed'] as Record<string, { value: string; inputs: Record<string, { value?: string; unit?: string }> }> | undefined)?.['required'];
};

describe('earlier-step values of library blocks', () => {
  it('[DI-33][PR-19] potency-adjusted dispensing reads the LOD recorded by the completed earlier step: 10 kg / 98 % / (100 % - 2 %)', () => {
    const run = issue(master('LOD_FIRST', { step: 'lodTest', field: 'lod' }));
    completeLod(run, '2');
    run.start('p');
    run.entry('p', weigh);
    const r = required(run);
    expect(r?.value.startsWith('10.412')).toBe(true);
    expect(r?.inputs['lodLot']).toMatchObject({ value: '2', unit: '%' });
    // Where the value came from is in the calculation's record: the step instance, its entry, the figure as recorded.
    const lodEntry = Object.values(run.state.entries).find((x) => x.kind === 'test');
    expect((r as unknown as { stepValues: Record<string, unknown> }).stepValues['lodLot']).toEqual({ step: 'lodTest', field: 'lod', stepKey: lodEntry?.stepKey, entryId: lodEntry?.id, recorded: { value: '2', unit: '%' } });
  });

  it('[DI-33][PR-19] the value is converted exactly to the input\'s unit (an LOD recorded as a fraction, 0.02, reads as 2 %)', () => {
    const run = issue(master('LOD_FIRST', { step: 'lodTest', field: 'lod' }, '1'));
    completeLod(run, '0.02');
    run.start('p');
    run.entry('p', weigh);
    expect(required(run)?.value.startsWith('10.412')).toBe(true);
  });

  it('[DI-33][PR-03] the master check refuses a step value that names no step, a step that comes later or may not run exactly once, a value the step does not record once, or a unit that does not convert', () => {
    const refusal = (m: ReturnType<typeof master>): string => {
      try {
        define(m.mbr, { registry: m.registry });
        return 'defined';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    expect(refusal(master('LOD_FIRST', { step: 'lodTest', field: 'lod' }))).toBe('defined');
    expect(refusal(master('LOD_FIRST', { step: 'nowhere', field: 'lod' }))).toContain('there is no step nowhere (ENG-DEF-STEP-VALUE');
    expect(refusal(master('DISPENSE_FIRST', { step: 'lodTest', field: 'lod' }))).toContain('step lodTest does not come before p in the flow (ENG-DEF-STEP-VALUE');
    // A repeated section's field has several values: which one would be ambiguous.
    expect(refusal(master('LOD_FIRST', { step: 'lodTest', field: 'again' }))).toContain('step lodTest records no single value again (ENG-DEF-STEP-VALUE');
    // A unit that does not convert to the input's (a mass for a percentage).
    expect(refusal(master('LOD_FIRST', { step: 'lodTest', field: 'lod' }, 'kg'))).toContain('which does not convert to % (ENG-DEF-STEP-VALUE');
    // A step that may run more than once (a loop, a replicate) or not at all (an alternative branch) has no one value.
    expect(refusal(master('LOD_IN_REPLICATE', { step: 'lodTest', field: 'lod' }))).toContain('runs inside a loop, a replicate or an alternative branch (ENG-DEF-STEP-VALUE'.replace(' (ENG', ', so it does not run exactly once in every batch (ENG'));
    // A reader inside a replicate reads the one value of a step before it.
    expect(refusal(master('DISPENSE_IN_REPLICATE', { step: 'lodTest', field: 'lod' }))).toBe('defined');
  });

  it('[DI-33] a value the earlier step has not recorded is never a silent zero: the calculation is refused', () => {
    const m = master('LOD_FIRST', { step: 'lodTest', field: 'lod' });
    const disp = potencyDispensing();
    const view = libraryBlockVersion(disp, expr);
    // The block reads nothing from a step instance with no entry for the field.
    expect(view.readValue?.([], 'lod')).toBeUndefined();
    const lod = libraryBlockVersion(lodTest(), expr);
    expect(lod.readableValues).toEqual({ lod: '%' });
    expect(lod.readValue?.([], 'lod')).toBeUndefined();
    expect(m.mbr.inputs.map((i) => i.id)).not.toContain('lodLot');
  });

  it('[DI-33][PR-19] the catalogue\'s potency-adjusted dispensing (PROC-DISP-POTENCY) runs after the catalogue\'s LOD test (IPC-LOD) with no master input for the LOD: it reads the LOD the test recorded', () => {
    const seed = (code: string) => {
      const item = SEED_CATALOGUE.find((x) => x.definition.code === code);
      if (!item) throw new Error(code);
      return item;
    };
    const lod = seed('IPC-LOD');
    const disp = seed('PROC-DISP-POTENCY');
    const stepValues = disp.exampleUse.stepValues ?? {};
    expect(Object.values(stepValues)).toEqual([{ step: 'lodTest', field: 'lod' }]);
    // Every other external input stays where the example puts it: the master (the assay) or the bill of materials.
    const ex = Object.entries(disp.exampleInputs ?? {}).filter(([id]) => id !== 'lodLot');
    const lines = disp.definition.inputs?.filter((i) => i.kind === 'FORMULA_LINE').map((i) => i.id) ?? [];
    const masterInputs = ex.filter(([id]) => !lines.includes(id));
    const bom = Object.values(disp.exampleUse.bomLines ?? {}).map((id) => ({ id, material: `MAT-${id}`, role: 'ACTIVE' as const, quantity: (disp.exampleInputs ?? {})[lines[0] ?? ''] ?? { value: '10', unit: 'kg' } }));
    const lodStep = phase('lodTest', { block: { type: libraryBlockType('IPC-LOD'), version: '1' }, config: lod.exampleUse as never });
    const p = phase('p', { block: { type: libraryBlockType(disp.definition.code), version: '1' }, config: disp.exampleUse as never, reads: masterInputs.map(([id]) => id) });
    const mbr = mbrWith({ kind: 'sequence', id: 'ops', children: [lodStep, p, phase('after')] }, {
      bom,
      inputs: masterInputs.map(([id, v]) => ({ id, name: id, source: 'MASTER_DATA' as const, valueType: 'DECIMAL' as const, unit: v.unit })),
    });
    const d = define(mbr, { registry: testRegistry().extend(libraryBlockVersion(lod.definition, expr), libraryBlockVersion(disp.definition, expr)) });
    const run = Run.issue(d, { inputs: Object.fromEntries(masterInputs.map(([k, v]) => [k, { value: { kind: 'DECIMAL' as const, value: v.value, unit: v.unit }, source: 'seed example' }])) }, T0);
    run.start('lodTest');
    for (const e of nominalEntries(lod.definition, lod.exampleUse as never, mbr)) {
      run.entry('lodTest', e);
      run.minutes(1);
    }
    run.perform('lodTest');
    if (run.status('lodTest') === 'AWAITING_VERIFICATION') run.verify('lodTest');
    run.start('p');
    for (const e of nominalEntries(disp.definition, disp.exampleUse as never, mbr)) {
      run.entry('p', e);
      run.minutes(1);
    }
    const weighed = Object.values(run.state.entries).find((x) => x.stepKey.startsWith('p@') || x.stepKey === 'p');
    const computed = Object.values(run.state.entries).flatMap((x) => (x.stepKey.startsWith('p') ? Object.values((x.data['computed'] ?? {}) as Record<string, { inputs: Record<string, { value?: string }> }>) : []));
    expect(weighed).toBeDefined();
    const lodRead = computed.find((c) => c.inputs['lodLot'] !== undefined)?.inputs['lodLot'];
    const recorded = Object.values(run.state.entries).find((x) => x.stepKey.startsWith('lodTest'))?.data['lod'];
    expect(typeof recorded).toBe('string');
    expect(lodRead?.value).toBe(recorded);
  });
});

