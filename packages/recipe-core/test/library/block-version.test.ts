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
import { checkBlockUse, definitionHash } from '../../src/library/index.ts';
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

  it('[PR-03] R-flow item 3: an optional event section is recorded only when its event happens; the step ends without it, a required section still blocks the end', () => {
    const alarm = { id: 'alarm', title: 'Alarm acknowledgement', when: 'Only if the drum alarm sounds', fields: [{ id: 'alarmNote', label: 'What the alarm showed', type: 'TEXT' as const }] };
    const run = (required: boolean | undefined): Run => {
      const def = friability();
      def.sections.push({ ...alarm, ...(required === undefined ? {} : { required }) });
      const r = runFor(def, friabilityUse());
      r.entry('p', { kind: 'run', drum: 'F1', equipment: { drum: { code: 'F1', classCode: 'FRIABILATOR', fitness: 'QUALIFIED' } }, w0: '6.500', w1: '6.480', cracked: false });
      return r;
    };
    const ends = (r: Run): string => {
      r.perform('p');
      if (r.status('p') === 'AWAITING_VERIFICATION') r.verify('p');
      return r.status('p');
    };
    expect(ends(run(false))).toBe('COMPLETED');
    const happened = run(false);
    happened.entry('p', { kind: 'alarm', alarmNote: 'Door open, closed and restarted' });
    expect(ends(happened)).toBe('COMPLETED');
    expect(() => run(undefined).perform('p')).toThrow(/Alarm acknowledgement is not recorded yet \(LIB-PERFORM-SECTION/);
  });

  it('[INV-25] a calculated field cannot be typed', () => {
    const run = runFor(friability(), friabilityUse());
    run.refused(entryCmd(run, { kind: 'run', drum: 'F1', equipment: { drum: { code: 'F1', classCode: 'FRIABILATOR', fitness: 'QUALIFIED' } }, w0: '6.500', w1: '6.480', cracked: false, loss: '0.1' }), 'ENG-ENTRY-SCHEMA');
  });

  it('[DI-33] the server computes a calculated field and stores it with its evaluation record (O-9 b)', () => {
    const run = runFor(friability(), friabilityUse());
    run.entry('p', { kind: 'run', drum: 'F1', equipment: { drum: { code: 'F1', classCode: 'FRIABILATOR', fitness: 'QUALIFIED' } }, w0: '6.500', w1: '6.480', cracked: false });
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
    run.entry('p', { kind: 'run', drum: 'F1', equipment: { drum: { code: 'F1', classCode: 'FRIABILATOR', fitness: 'QUALIFIED' } }, w0: '6.500', w1: '6.400', cracked: false });
    expect(types(run)).toEqual(['LIB_LIMIT_BREACH']);
    expect(run.exceptions()[0]?.severity).toBe('CRITICAL');
  });

  it('[PR-29] an unexpected yes/no answer raises an exception', () => {
    const run = runFor(friability(), friabilityUse());
    run.entry('p', { kind: 'run', drum: 'F1', equipment: { drum: { code: 'F1', classCode: 'FRIABILATOR', fitness: 'QUALIFIED' } }, w0: '6.500', w1: '6.490', cracked: true });
    expect(types(run)).toEqual(['LIB_UNEXPECTED_ANSWER']);
  });

  it('[PR-03] a required field must be given, and a section recorded once cannot be recorded again', () => {
    const run = runFor(friability(), friabilityUse());
    run.refused(entryCmd(run, { kind: 'run', drum: 'F1', equipment: { drum: { code: 'F1', classCode: 'FRIABILATOR', fitness: 'QUALIFIED' } }, w0: '6.500', cracked: false }), 'LIB-ENTRY-REQUIRED');
    run.entry('p', { kind: 'run', drum: 'F1', equipment: { drum: { code: 'F1', classCode: 'FRIABILATOR', fitness: 'QUALIFIED' } }, w0: '6.500', w1: '6.490', cracked: false });
    run.refused(entryCmd(run, { kind: 'run', drum: 'F1', equipment: { drum: { code: 'F1', classCode: 'FRIABILATOR', fitness: 'QUALIFIED' } }, w0: '6.500', w1: '6.490', cracked: false }), 'LIB-SECTION-ONCE');
  });

  it('[INV-20] an LOD loop repeats until the value passes; the step cannot be performed before, nor repeated after', () => {
    const run = runFor(fluidBedDrying(), fluidBedDryingUse());
    run.entry('p', { kind: TIMER_START, field: 'drying' });
    run.entry('p', { kind: 'setup', dryer: 'FBD-1', equipment: { dryer: { code: 'FBD-1', classCode: 'FBD', fitness: 'QUALIFIED' } }, inletTemp: '60' });
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

  it('[INV-20][PR-08] reaching the maximum number of repeats without a pass raises the loop\'s exhaustion for QA and judges the last value against its tier', () => {
    const use = { ...fluidBedDryingUse(), counts: { maxLodChecks: '2', lodSampleUnits: '1' } };
    const run = runFor(fluidBedDrying(), use);
    run.entry('p', { kind: TIMER_START, field: 'drying' });
    run.entry('p', { kind: 'setup', dryer: 'FBD-1', equipment: { dryer: { code: 'FBD-1', classCode: 'FBD', fitness: 'QUALIFIED' } }, inletTemp: '60' });
    run.minutes(30);
    run.entry('p', { kind: TIMER_STOP, field: 'drying' });
    run.entry('p', { kind: 'lodLoop', sample: 1, lod: '3.4' });
    run.entry('p', { kind: 'lodLoop', sample: 1, lod: '3.0' });
    run.refused(entryCmd(run, { kind: 'lodLoop', sample: 1, lod: '2.0' }), 'LIB-SECTION-MAX');
    run.entry('p', { kind: 'out', container: 'C1', net: '50' });
    // R3-ENG-1: the last value (3.0 %, outside the registered 1.5-2.5 %) is judged at the exhaustion, and the exhaustion
    // has an MBR loop's consequences: the steps after it wait for QA's disposition, release is blocked.
    expect(types(run)).toEqual(['LIB_LIMIT_BREACH', 'LIB_REPEAT_LIMIT_REACHED']);
    const exhausted = run.exceptions().find((e) => e.type === 'LIB_REPEAT_LIMIT_REACHED');
    expect([exhausted?.block?.until, exhausted?.block?.steps, exhausted?.qaOnly, exhausted?.releaseBlocking, exhausted?.deviationRequired]).toEqual(['DISPOSITION', [], true, true, true]);
    expect(run.exceptions().find((e) => e.type === 'LIB_LIMIT_BREACH')?.severity).toBe('CRITICAL');
    // The registered-tier breach holds this step until a deviation is linked, as any registered breach does.
    expect(() => run.perform('p')).toThrow(/ENG-BLOCKED/);
  });

  it('[PR-29][PR-30] R3-ENG-4: in a batch, an IPC interval runs from the step\'s start on trusted time: a first round later than the interval is late', () => {
    const ipc: BlockDefinition = {
      code: 'IPC-R3', version: 1, title: 'Rounds', category: 'TEST_IPC',
      sections: [{ id: 'round', title: 'Round', repeat: { kind: 'PER_INTERVAL', intervalSlot: 'every' }, fields: [{ id: 'v', label: 'V', type: 'NUMBER', unit: 'g' }] }],
      signatures: [{ meaning: 'PERFORMED', role: 'OPERATOR' }],
    };
    const use: BlockUse = { block: { code: 'IPC-R3', version: 1 }, intervals: { every: { value: '30', unit: 'min' } } };
    const onTime = runFor(ipc, use);
    onTime.minutes(30);
    onTime.entry('p', { kind: 'round', v: '1' });
    expect(types(onTime)).toEqual([]);
    const late = runFor(ipc, use);
    late.minutes(31);
    late.entry('p', { kind: 'round', v: '1' });
    expect(types(late)).toEqual(['LIB_IPC_INTERVAL_MISSED']);
  });

  it('[PR-30] a timer runs on trusted time: its duration is checked against its limit when it is stopped', () => {
    const run = runFor(fluidBedDrying(), fluidBedDryingUse());
    run.refused(entryCmd(run, { kind: TIMER_STOP, field: 'drying' }), 'LIB-TIMER-NOT-STARTED');
    run.entry('p', { kind: TIMER_START, field: 'drying' });
    run.entry('p', { kind: 'setup', dryer: 'FBD-1', equipment: { dryer: { code: 'FBD-1', classCode: 'FBD', fitness: 'QUALIFIED' } }, inletTemp: '60' });
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
    run.refused(entryCmd(run, { kind: 'run', apparatus: 'D1', equipment: { apparatus: { code: 'D1', classCode: 'USP-2', fitness: 'QUALIFIED' } }, released: { h1: six('30').slice(0, 5), h4: six('55'), h8: six('90') } }), 'LIB-ENTRY-REPLICATES');
    run.refused(entryCmd(run, { kind: 'run', apparatus: 'D1', equipment: { apparatus: { code: 'D1', classCode: 'USP-2', fitness: 'QUALIFIED' } }, released: { h1: six('30'), h8: six('90') } }), 'LIB-ENTRY-POINTS');
    run.entry('p', { kind: 'run', apparatus: 'D1', equipment: { apparatus: { code: 'D1', classCode: 'USP-2', fitness: 'QUALIFIED' } }, released: { h1: six('30'), h4: six('70'), h8: six('90') } });
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
    const extra: Partial<MbrContent> = { bom: [{ id: 'BOM-API', material: 'API', role: 'ACTIVE', quantity: { value: '10', unit: 'kg' } }], inputs: Object.entries(inputs).map(([id, v]) => ({ id, name: id, source: 'MASTER_DATA' as const, valueType: 'DECIMAL' as const, unit: (v as { unit: string }).unit })) };
    const run = runFor(def, use, { extra, reads: Object.keys(inputs), inputs });
    run.refused(entryCmd(run, { kind: 'weigh', lot: 'L1', lots: { lot: { id: 'L1', material: 'API', status: 'RELEASED', identityTested: true } }, net: '10.4', rework: false, reworkQty: '1' }), 'LIB-ENTRY-HIDDEN');
    run.refused(entryCmd(run, { kind: 'weigh', lot: 'L1', lots: { lot: { id: 'L1', material: 'API', status: 'RELEASED', identityTested: true } }, net: '10.4', rework: true, reworkQty: '1' }), 'LIB-ENTRY-REQUIRED');
    run.entry('p', { kind: 'weigh', lot: 'L1', lots: { lot: { id: 'L1', material: 'API', status: 'RELEASED', identityTested: true } }, net: '10.4', rework: true, reworkRef: 'RW-1', reworkQty: '1' });
    const e = Object.values(run.state.entries).find((x) => x.kind === 'weigh');
    const required = (e?.data['computed'] as Record<string, { value: string; inputs: Record<string, unknown> }>)['required'];
    // 10 kg / 0.98 / 0.98 = 10.412... kg
    expect(required?.value.startsWith('10.412')).toBe(true);
    expect(Object.keys(required?.inputs ?? {}).sort()).toEqual(['assay', 'labelQty', 'lodLot']);
  });

  it('[DI-33] a calculation whose earlier-step input names no step of the master is refused when the batch is defined, not at the entry', () => {
    const def = potencyDispensing();
    const bom = { bom: [{ id: 'BOM-API', material: 'API', role: 'ACTIVE' as const, quantity: { value: '10', unit: 'kg' } }] };
    const use: BlockUse = { block: { code: def.code, version: 1 }, bomLines: { activeLine: 'BOM-API' }, stepValues: { lodSource: { step: 'lod', field: 'lod' } } };
    expect(() => runFor(def, use, { extra: bom })).toThrow('ENG-DEF-STEP-VALUE');
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
    const run = s['run']?.({ drum: 'F1', equipment: { drum: { code: 'F1', classCode: 'FRIABILATOR', fitness: 'QUALIFIED' } }, w0: '6.500', w1: '6.480', cracked: false, computed: { loss: { value: '0.3077', unit: '%' } } }, undefined as never);
    expect(run).toBe('Run: Friabilator: F1; Weight before 6.500 g; Weight after 6.480 g; Weight loss 0.3077 % (calculated); Any tablet cracked or broken: no');
    const t = libraryBlockVersion(fluidBedDrying(), expr).entrySummaries ?? {};
    expect(t[TIMER_STOP]?.({ field: 'drying', duration: { value: '45', unit: 'min' } }, undefined as never)).toBe('Drying time stopped after 45 min');
  });
});

describe('smart fields (S6): lots, equipment and hand-keyed weighings', () => {
  const dispense = (): BlockDefinition => ({
    code: 'PROC-DISP',
    version: 1,
    title: 'Dispensing',
    category: 'PROCESS',
    sections: [
      {
        id: 'weigh',
        title: 'Weigh',
        repeat: { kind: 'PER_CONTAINER' },
        fields: [
          { id: 'balance', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'balanceClass' },
          { id: 'lot', label: 'Lot', type: 'MATERIAL_LOT', bomLineSlot: 'line' },
          { id: 'net', label: 'Net weight', type: 'WEIGHING', unit: 'kg' },
        ],
      },
    ],
    signatures: [
      { meaning: 'PERFORMED', role: 'DISPENSER' },
      { meaning: 'VERIFIED', role: 'DISPENSER' },
    ],
  });
  const use: BlockUse = { block: { code: 'PROC-DISP', version: 1 }, equipmentClasses: { balanceClass: 'BAL-150' }, bomLines: { line: 'BOM-API' } };
  const extra: Partial<MbrContent> = { bom: [{ id: 'BOM-API', material: 'MAT-API', role: 'ACTIVE', quantity: { value: '10', unit: 'kg' } }] };
  const lot = (over: Record<string, unknown> = {}) => ({ id: 'L1', material: 'MAT-API', status: 'RELEASED', identityTested: true, ...over });
  const bal = (over: Record<string, unknown> = {}) => ({ code: 'BAL-1', classCode: 'BAL-150', fitness: 'QUALIFIED', ...over });
  const entry = (l = lot(), b = bal()) => ({ kind: 'weigh', balance: 'BAL-1', lot: 'L1', net: '10.0', lots: { lot: l }, equipment: { balance: b } });

  it('[PR-18][IN-23] only a released, unexpired lot of the formulation line\'s material is used, with no operator override', () => {
    const run = runFor(dispense(), use, { extra });
    run.refused(entryCmd(run, entry(lot({ status: 'QUARANTINE' }))), 'G07-LOT-STATUS');
    run.refused(entryCmd(run, entry(lot({ material: 'MAT-OTHER' }))), 'G07-WRONG-MATERIAL');
    run.refused(entryCmd(run, entry(lot({ expiresAtUs: '1' }))), 'G07-LOT-EXPIRED');
    run.refused(entryCmd(run, { ...entry(), lots: { lot: lot({ id: 'L2' }) } }), 'LIB-LOT-FACTS');
    run.entry('p', entry());
  });

  it('[PR-19][IN-11] equipment must be of the class the formulation names and fit for use', () => {
    const run = runFor(dispense(), use, { extra });
    run.refused(entryCmd(run, entry(lot(), bal({ classCode: 'BAL-5' }))), 'LIB-EQUIPMENT-CLASS');
    run.refused(entryCmd(run, entry(lot(), bal({ fitness: 'CALIBRATION_OVERDUE' }))), 'LIB-EQUIPMENT-FITNESS');
    run.entry('p', entry(lot(), bal({ fitness: 'CALIBRATION_DUE_SOON' })));
  });

  it('[DI-30][PR-14] a hand-keyed weighing makes two-person verification mandatory for the step', () => {
    const run = runFor(dispense(), use, { extra });
    run.entry('p', entry());
    expect(run.inst('p')?.verificationRequired).toBe(true);
    run.perform('p');
    expect(run.status('p')).toBe('AWAITING_VERIFICATION');
  });

  it('[PR-03] a lot field may name the BOM line the formulation fills; the browser never sends the register\'s facts', () => {
    expect(checkBlockUse(dispense(), { ...use, bomLines: {} }, expr).map((p) => p.code)).toEqual(['LIB-USE-BOM-LINE']);
    const v = libraryBlockVersion(dispense(), expr);
    const schema = v.dataSchema?.entries['weigh'];
    expect((schema?.fields['lots'] as { serverFilled?: boolean } | undefined)?.serverFilled).toBe(true);
    expect((schema?.fields['equipment'] as { serverFilled?: boolean } | undefined)?.serverFilled).toBe(true);
  });

  it('[PR-18][IN-23][INV-25] R3-ENG-3: a formulation line that names no line of the master\'s bill of materials refuses the batch definition', () => {
    const typo: BlockUse = { ...use, bomLines: { line: 'BOM-TYPO' } };
    expect(checkBlockUse(dispense(), typo, expr, extra.bom).map((p) => p.code)).toEqual(['LIB-USE-BOM-LINE']);
    expect(checkBlockUse(dispense(), use, expr, extra.bom)).toEqual([]);
    const registry = testRegistry().extend(libraryBlockVersion(dispense(), expr));
    expect(() => define(mbrFor(dispense(), typo, extra), { registry })).toThrow(/LIB-USE-BOM-LINE/);
    // A FORMULA_LINE input reads the same way: a line removed from the BOM leaves the calculation nothing to read.
    const potency = potencyDispensing();
    const gone: BlockUse = { block: { code: potency.code, version: 1 }, bomLines: { activeLine: 'BOM-GONE' }, stepValues: { lodSource: { step: 'lod', field: 'lod' } } };
    expect(checkBlockUse(potency, gone, expr, extra.bom).map((p) => `${p.code} ${p.path}`)).toEqual(['LIB-USE-BOM-LINE bomLines.activeLine']);
    const potencyRegistry = testRegistry().extend(libraryBlockVersion(potency, expr));
    expect(() => define(mbrFor(potency, gone, extra), { registry: potencyRegistry })).toThrow(/LIB-USE-BOM-LINE/);
  });

  it('[PR-18][IN-23][INV-25] R3-ENG-3: at run time a lot whose formulation line is not in the bill of materials is refused, never left unchecked', () => {
    const v = libraryBlockVersion(dispense(), expr);
    const view = (bomLines: Record<string, string>) => ({
      phase: { id: 'p' },
      config: configOf({ ...use, bomLines }),
      nowUs: T0,
      batch: { batchId: 'B', batchNumber: 'B1', productCode: 'P', marketSet: ['IN'] },
      mbr: mbrFor(dispense(), use, extra),
      entries: () => [],
    }) as never;
    const accept = (bomLines: Record<string, string>, e: ReturnType<typeof entry>) => v.handler!.acceptEntry!(view(bomLines), e);
    const codesOf = (r: ReturnType<typeof accept>): string[] => (r.ok ? [] : r.problems.map((p) => p.code));
    // A lot of any material: with the line missing, nothing may say the material is right.
    expect(codesOf(accept({ line: 'BOM-TYPO' }, entry(lot({ material: 'MAT-OTHER' }))))).toEqual(['LIB-LOT-BOM-LINE']);
    expect(codesOf(accept({}, entry(lot())))).toEqual(['LIB-LOT-BOM-LINE']);
    expect(codesOf(accept({ line: 'BOM-API' }, entry(lot({ material: 'MAT-OTHER' }))))).toEqual(['G07-WRONG-MATERIAL']);
    expect(accept({ line: 'BOM-API' }, entry()).ok).toBe(true);
  });
});

describe('timer durations in any time unit (S7 catalogue finding)', () => {
  it('[PR-30] 64 minutes in an hours timer is 1.0666... h, never 3840 h, and is judged as such', () => {
    const def: BlockDefinition = {
      code: 'PROC-TIMED',
      version: 1,
      title: 'Timed step',
      category: 'PROCESS',
      sections: [{ id: 'run', title: 'Run', fields: [{ id: 'hold', label: 'Hold', type: 'TIMER', durationUnit: 'h', limitSlot: 'hold', critical: true }] }],
      signatures: [{ meaning: 'PERFORMED', role: 'OPERATOR' }],
    };
    const run = runFor(def, { block: { code: 'PROC-TIMED', version: 1 }, limits: { hold: range('h', '1', '2') } });
    run.entry('p', { kind: TIMER_START, field: 'hold' });
    run.minutes(64);
    run.entry('p', { kind: TIMER_STOP, field: 'hold' });
    const stop = Object.values(run.state.entries).find((e) => e.kind === TIMER_STOP);
    const d = stop?.data['duration'] as { value: string; unit: string };
    expect(d.unit).toBe('h');
    expect(d.value.startsWith('1.0666')).toBe(true);
    expect(run.exceptions()).toEqual([]);
  });

  it('[PR-30][PR-08] S11a finding: a timer outside its limit is recorded and judged exactly, and its exception shows the duration to three decimals', () => {
    const def: BlockDefinition = {
      code: 'PROC-TIMED',
      version: 1,
      title: 'Timed step',
      category: 'PROCESS',
      sections: [{ id: 'run', title: 'Run', fields: [{ id: 'hold', label: 'Hold', type: 'TIMER', durationUnit: 'h', limitSlot: 'hold', critical: true }] }],
      signatures: [{ meaning: 'PERFORMED', role: 'OPERATOR' }],
    };
    const run = runFor(def, { block: { code: 'PROC-TIMED', version: 1 }, limits: { hold: range('h', '2', '3') } });
    run.entry('p', { kind: TIMER_START, field: 'hold' });
    run.minutes(64);
    run.entry('p', { kind: TIMER_STOP, field: 'hold' });
    const stop = Object.values(run.state.entries).find((e) => e.kind === TIMER_STOP);
    expect((stop?.data['duration'] as { value: string }).value.startsWith('1.06666666')).toBe(true);
    const ex = run.exceptions().find((e) => e.type === 'LIB_LIMIT_BREACH');
    expect(ex?.title).toContain('Timed step: Hold 1.067 h');
    expect(ex?.title).not.toContain('1.06666');
  });
});
