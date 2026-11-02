/**
 * The generic handler, slice S2 (decision 0026): a library definition runs in the existing engine with no code of its
 * own. Limits raise the engine's LIB_LIMIT_BREACH (PR-08); calculated fields are computed by the server and stored with
 * their evaluation record (owner decision O-9 b, DI-33); repeats, timers, tests and conditional fields behave as the
 * definition says.
 */
import { describe, expect, it } from 'vitest';
import type { DataValue } from '../../src/engine/types.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import { libraryBlockType, libraryBlockVersion, nominalEntries, statistic, TIMER_START, TIMER_STOP, type BlockDefinition, type BlockUse } from '../../src/library/index.ts';
import { definitionHash } from '../../src/library/index.ts';
import { define, MIN, Run, T0, testRegistry } from '../engine/support.ts';
import { expr, mbrWith, phase } from '../flow/support.ts';
import { dissolutionProfile, dissolutionUse, fluidBedDrying, fluidBedDryingUse, friability, friabilityUse, potencyDispensing, range } from './examples.ts';

function configOf(use: BlockUse): Record<string, unknown> {
  const { block, ...rest } = use;
  return { ...rest, ...(block.hash !== undefined ? { hash: block.hash } : {}) };
}

function mbrFor(def: BlockDefinition, use: BlockUse, extra: Partial<MbrContent> = {}, reads: string[] = []): MbrContent {
  const p = phase('p', { block: { type: libraryBlockType(def.code), version: String(def.version) }, config: configOf(use) as never, reads });
  return mbrWith({ kind: 'sequence', id: 'ops', children: [p, phase('after')] }, extra);
}

function runFor(def: BlockDefinition, use: BlockUse, opts: { extra?: Partial<MbrContent>; reads?: string[]; inputs?: Record<string, DataValue> } = {}): Run {
  const registry = testRegistry().extend(libraryBlockVersion(def, expr));
  const d = define(mbrFor(def, use, opts.extra, opts.reads), { registry });
  const inputs = Object.fromEntries(Object.entries(opts.inputs ?? {}).map(([k, v]) => [k, { value: v, source: 'test' }]));
  const run = Run.issue(d, { inputs }, T0);
  run.start('p');
  return run;
}

const entryCmd = (run: Run, entry: Record<string, unknown> & { kind: string }) => ({ type: 'RECORD_ENTRY' as const, actor: { kind: 'PERSON' as const, id: 'OP1', roles: ['PRODUCTION_OPERATOR', 'OPERATOR'] }, step: 'p', context: [], entry });
const types = (run: Run): string[] => run.exceptions().map((e) => e.type).sort();

describe('the generic handler runs library blocks in the engine', () => {
  for (const [name, def, use] of [
    ['friability', friability(), friabilityUse()],
    ['fluid bed drying with an LOD loop', fluidBedDrying(), fluidBedDryingUse()],
    ['a dissolution profile', dissolutionProfile(), dissolutionUse()],
  ] as const) {
    it(`[DI-34][PR-03] golden: ${name} runs its nominal entries to COMPLETED with no exception`, () => {
      const run = runFor(def, use);
      // The simulator gives the entries; the driver gives the time (a timer runs for a nominal hour).
      for (const e of nominalEntries(def, configOf(use) as never)) {
        if (e.kind === TIMER_STOP) run.minutes(60);
        run.entry('p', e);
        run.minutes(1);
      }
      run.perform('p');
      if (run.status('p') === 'AWAITING_VERIFICATION') run.verify('p');
      expect(types(run)).toEqual([]);
      expect(run.status('p')).toBe('COMPLETED');
    });
  }

  it('[PR-03] a batch cannot be defined when the formulation leaves a required slot empty', () => {
    const use = fluidBedDryingUse();
    delete use.limits!['lod'];
    const registry = testRegistry().extend(libraryBlockVersion(fluidBedDrying(), expr));
    expect(() => define(mbrFor(fluidBedDrying(), use), { registry })).toThrow(/LIB-USE-LIMIT-MISSING|lod/);
  });

  it('[PR-05] a batch cannot be defined when the pinned content hash does not match the library version', () => {
    const def = friability();
    const registry = testRegistry().extend(libraryBlockVersion(def, expr));
    const ok = { ...friabilityUse(), block: { code: def.code, version: 1, hash: definitionHash(def) } };
    expect(() => define(mbrFor(def, ok), { registry })).not.toThrow();
    const stale = { ...ok, block: { ...ok.block, hash: definitionHash({ ...def, title: 'Changed' }) } };
    expect(() => define(mbrFor(def, stale), { registry })).toThrow(/LIB-USE-HASH|pinned/);
  });

  it('[INV-25] a calculated field cannot be typed', () => {
    const run = runFor(friability(), friabilityUse());
    run.refused(entryCmd(run, { kind: 'run', drum: 'F1', w0: '6.500', w1: '6.480', cracked: false, loss: '0.1' }), 'ENG-ENTRY-SCHEMA');
  });

  it('[DI-33] the server computes a calculated field and stores it with its evaluation record (O-9 b)', () => {
    const run = runFor(friability(), friabilityUse());
    run.entry('p', { kind: 'run', drum: 'F1', w0: '6.500', w1: '6.480', cracked: false });
    const e = Object.values(run.state.entries).find((x) => x.kind === 'run');
    const loss = (e?.data['computed'] as Record<string, { value: string; unit: string; expression: string; languageVersion: string; inputs: Record<string, unknown> }>)['loss'];
    expect(loss?.unit).toBe('%');
    expect(Number.isNaN(Number(loss?.value))).toBe(false);
    expect(loss?.value.startsWith('0.307')).toBe(true);
    expect(loss?.expression).toBe('(w0 - w1) / w0 * 100 [%]');
    expect(loss?.languageVersion).toBe(expr.languageVersion);
    expect(Object.keys(loss?.inputs ?? {}).sort()).toEqual(['w0', 'w1']);
  });

  it('[PR-08] a calculated value outside its limit raises LIB_LIMIT_BREACH with the consequences of its tier', () => {
    const run = runFor(friability(), friabilityUse());
    run.entry('p', { kind: 'run', drum: 'F1', w0: '6.500', w1: '6.400', cracked: false });
    expect(types(run)).toEqual(['LIB_LIMIT_BREACH']);
    expect(run.exceptions()[0]?.severity).toBe('CRITICAL');
  });

  it('[PR-29] an unexpected yes/no answer raises an exception', () => {
    const run = runFor(friability(), friabilityUse());
    run.entry('p', { kind: 'run', drum: 'F1', w0: '6.500', w1: '6.490', cracked: true });
    expect(types(run)).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[PR-03] a required field must be given, and a section recorded once cannot be recorded again', () => {
    const run = runFor(friability(), friabilityUse());
    run.refused(entryCmd(run, { kind: 'run', drum: 'F1', w0: '6.500', cracked: false }), 'LIB-ENTRY-REQUIRED');
    run.entry('p', { kind: 'run', drum: 'F1', w0: '6.500', w1: '6.490', cracked: false });
    run.refused(entryCmd(run, { kind: 'run', drum: 'F1', w0: '6.500', w1: '6.490', cracked: false }), 'LIB-SECTION-ONCE');
  });

  it('[INV-20] an LOD loop repeats until the value passes; the step cannot be performed before, nor repeated after', () => {
    const run = runFor(fluidBedDrying(), fluidBedDryingUse());
    run.entry('p', { kind: TIMER_START, field: 'drying' });
    run.entry('p', { kind: 'setup', dryer: 'FBD-1', inletTemp: '60' });
    run.minutes(45);
    run.entry('p', { kind: TIMER_STOP, field: 'drying' });
    run.entry('p', { kind: 'lodLoop', sample: 1, lod: '3.4' });
    run.entry('p', { kind: 'out', container: 'C1', net: '50' });
    expect(() => run.perform('p')).toThrow(/LIB-PERFORM-NOT-PASSED/);
    run.entry('p', { kind: 'lodLoop', sample: 1, lod: '2.1' });
    run.refused(entryCmd(run, { kind: 'lodLoop', sample: 1, lod: '2.0' }), 'LIB-SECTION-PASSED');
    // A loop iteration that does not pass is a repeat, not a breach: the loop's limit decides the exit.
    expect(types(run)).toEqual([]);
    run.perform('p');
    if (run.status('p') === 'AWAITING_VERIFICATION') run.verify('p');
    expect(run.status('p')).toBe('COMPLETED');
  });

  it('[INV-20] reaching the maximum number of repeats without a pass lets the step end with a deviation exception', () => {
    const use = { ...fluidBedDryingUse(), counts: { maxLodChecks: '2', lodSampleUnits: '1' } };
    const run = runFor(fluidBedDrying(), use);
    run.entry('p', { kind: TIMER_START, field: 'drying' });
    run.entry('p', { kind: 'setup', dryer: 'FBD-1', inletTemp: '60' });
    run.minutes(30);
    run.entry('p', { kind: TIMER_STOP, field: 'drying' });
    run.entry('p', { kind: 'lodLoop', sample: 1, lod: '3.4' });
    run.entry('p', { kind: 'lodLoop', sample: 1, lod: '3.0' });
    run.refused(entryCmd(run, { kind: 'lodLoop', sample: 1, lod: '2.0' }), 'LIB-SECTION-MAX');
    run.entry('p', { kind: 'out', container: 'C1', net: '50' });
    expect(types(run)).toEqual(['LIB_REPEAT_LIMIT_REACHED']);
    // It blocks the steps after it until a deviation is linked, not this step's own signature.
    run.perform('p');
  });

  it('[PR-30] a timer runs on trusted time: its duration is checked against its limit when it is stopped', () => {
    const run = runFor(fluidBedDrying(), fluidBedDryingUse());
    run.refused(entryCmd(run, { kind: TIMER_STOP, field: 'drying' }), 'LIB-TIMER-NOT-STARTED');
    run.entry('p', { kind: TIMER_START, field: 'drying' });
    run.entry('p', { kind: 'setup', dryer: 'FBD-1', inletTemp: '60' });
    run.advance(10n * MIN);
    run.entry('p', { kind: TIMER_STOP, field: 'drying' });
    expect(types(run)).toEqual(['LIB_LIMIT_BREACH']);
    expect(run.exceptions()[0]?.title).toMatch(/Drying time 10 min/);
    run.entry('p', { kind: 'lodLoop', sample: 1, lod: '2.0' });
    run.entry('p', { kind: 'out', container: 'C1', net: '50' });
    // An internal action breach holds the step until a deviation is linked (PR-08).
    expect(() => run.perform('p')).toThrow(/ENG-BLOCKED/);
  });

  it('[PR-29] a test result needs the planned number of readings and is judged per statistic and per point', () => {
    const run = runFor(dissolutionProfile(), dissolutionUse());
    const six = (v: string): string[] => Array.from({ length: 6 }, () => v);
    run.refused(entryCmd(run, { kind: 'run', apparatus: 'D1', released: { h1: six('30').slice(0, 5), h4: six('55'), h8: six('90') } }), 'LIB-ENTRY-REPLICATES');
    run.refused(entryCmd(run, { kind: 'run', apparatus: 'D1', released: { h1: six('30'), h8: six('90') } }), 'LIB-ENTRY-POINTS');
    run.entry('p', { kind: 'run', apparatus: 'D1', released: { h1: six('30'), h4: six('70'), h8: six('90') } });
    // The 4 h point fails on its individual results and on its mean: one exception per statistic.
    expect(types(run)).toEqual(['LIB_LIMIT_BREACH', 'LIB_LIMIT_BREACH']);
    for (const e of run.exceptions()) expect(e.title).toMatch(/at 4 h/);
  });

  it('[PR-29] statistics are exact decimals: mean, min, max, range and the sample RSD in %', () => {
    const r = ['99.0', '101.0', '100.0', '100.0'];
    expect(statistic('MEAN', r)).toEqual(['100']);
    expect(statistic('MIN', r)).toEqual(['99']);
    expect(statistic('MAX', r)).toEqual(['101']);
    expect(statistic('RANGE', r)).toEqual(['2']);
    expect(statistic('RSD', r)[0]?.startsWith('0.8164965')).toBe(true);
    expect(statistic('INDIVIDUAL', r)).toEqual(r);
    expect(statistic('RSD', ['5'])).toEqual([]);
  });

  it('[DI-33] conditional fields: a hidden field is refused, a shown one is required, and a calculation reads the formula line and the lot assay', () => {
    const def = potencyDispensing();
    const use: BlockUse = { block: { code: def.code, version: 1 }, bomLines: { activeLine: 'BOM-API' }, stepValues: { lodSource: { step: 'lod', field: 'lod' } } };
    const inputs: Record<string, DataValue> = {
      labelQty: { kind: 'DECIMAL', value: '10', unit: 'kg' },
      assay: { kind: 'DECIMAL', value: '98', unit: '%' },
      lodLot: { kind: 'DECIMAL', value: '2', unit: '%' },
      batchSize: { kind: 'DECIMAL', value: '100', unit: 'kg' },
    };
    const extra: Partial<MbrContent> = { inputs: Object.entries(inputs).map(([id, v]) => ({ id, name: id, source: 'MASTER_DATA' as const, valueType: 'DECIMAL' as const, unit: (v as { unit: string }).unit })) };
    const run = runFor(def, use, { extra, reads: Object.keys(inputs), inputs });
    run.refused(entryCmd(run, { kind: 'weigh', lot: 'L1', net: '10.4', rework: false, reworkQty: '1' }), 'LIB-ENTRY-HIDDEN');
    run.refused(entryCmd(run, { kind: 'weigh', lot: 'L1', net: '10.4', rework: true, reworkQty: '1' }), 'LIB-ENTRY-REQUIRED');
    run.entry('p', { kind: 'weigh', lot: 'L1', net: '10.4', rework: true, reworkRef: 'RW-1', reworkQty: '1' });
    const e = Object.values(run.state.entries).find((x) => x.kind === 'weigh');
    const required = (e?.data['computed'] as Record<string, { value: string; inputs: Record<string, unknown> }>)['required'];
    // 10 kg / 0.98 / 0.98 = 10.412... kg
    expect(required?.value.startsWith('10.412')).toBe(true);
    expect(Object.keys(required?.inputs ?? {}).sort()).toEqual(['assay', 'labelQty', 'lodLot']);
  });

  it('[DI-33] a calculation whose external input the batch does not provide refuses the entry', () => {
    const def = potencyDispensing();
    const use: BlockUse = { block: { code: def.code, version: 1 }, bomLines: { activeLine: 'BOM-API' }, stepValues: { lodSource: { step: 'lod', field: 'lod' } } };
    const run = runFor(def, use);
    run.refused(entryCmd(run, { kind: 'weigh', lot: 'L1', net: '10.4', rework: false }), 'LIB-CALC-FAILED');
  });

  it('[PR-29][PR-30] IPC rounds at an interval: a round later than the interval raises an exception', () => {
    const def: BlockDefinition = {
      code: 'IPC-WEIGHT',
      version: 1,
      title: 'Average weight',
      category: 'TEST_IPC',
      sections: [{ id: 'round', title: 'Round', repeat: { kind: 'PER_INTERVAL', intervalSlot: 'every' }, fields: [{ id: 'wt', label: 'Weights', type: 'TEST_RESULT', unit: 'mg', replicatesSlot: 'n', statistics: [{ statistic: 'MEAN', limitSlot: 'mean' }] }] }],
      signatures: [{ meaning: 'PERFORMED', role: 'IPC_OPERATOR' }],
    };
    const use: BlockUse = { block: { code: 'IPC-WEIGHT', version: 1 }, limits: { mean: range('mg', '237.5', '262.5') }, counts: { n: '3' }, intervals: { every: { value: '30', unit: 'min' } } };
    const run = runFor(def, use);
    run.entry('p', { kind: 'round', wt: ['250', '251', '249'] });
    run.minutes(25);
    run.entry('p', { kind: 'round', wt: ['250', '251', '249'] });
    run.minutes(40);
    run.entry('p', { kind: 'round', wt: ['250', '251', '249'] });
    run.perform('p');
    expect(types(run)).toEqual(['LIB_IPC_INTERVAL_MISSED']);
  });
});

describe('the sentences of library entries (S5: step screens, review and the printed record)', () => {
  it('[DI-33] a section entry reads as its fields with units, a calculated value says so, a timer stop says how long', () => {
    const s = libraryBlockVersion(friability(), expr).entrySummaries ?? {};
    const run = s['run']?.({ drum: 'F1', w0: '6.500', w1: '6.480', cracked: false, computed: { loss: { value: '0.3077', unit: '%' } } }, undefined as never);
    expect(run).toBe('Run: Friabilator: F1; Weight before 6.500 g; Weight after 6.480 g; Weight loss 0.3077 % (calculated); Any tablet cracked or broken: no');
    const t = libraryBlockVersion(fluidBedDrying(), expr).entrySummaries ?? {};
    expect(t[TIMER_STOP]?.({ field: 'drying', duration: { value: '45', unit: 'min' } }, undefined as never)).toBe('Drying time stopped after 45 min');
  });
});
