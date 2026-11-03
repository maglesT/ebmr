/**
 * The generic handler's run-time judgement, case by case (decision 0026; focused mutation run of decision 0027 V3): each
 * kind of limited field raises its breach, a one-sided or boolean loop exits on the right value, counts, points and
 * intervals are held at their boundary, timers are kept apart, and the stored record holds what was judged. The handler
 * is driven directly through a small view, so every draft, problem and stored value is visible.
 */
import { describe, expect, it } from 'vitest';
import type { EntryResult, HandlerProblem, HandlerView } from '../../src/blocks/contract.ts';
import type { DataValue, EntryRecord } from '../../src/engine/types.ts';
import type { MbrContent } from '../../src/flow/model.ts';
import { libraryBlockVersion, statistic, TIMER_START, TIMER_STOP, type BlockDefinition, type BlockUse, type FieldDef, type SectionDef } from '../../src/library/index.ts';
import { expr, mbrWith, phase } from '../flow/support.ts';
import { range } from './examples.ts';

const MIN = 60_000_000n;
type Config = Omit<BlockUse, 'block'>;
type Ok = Extract<EntryResult, { ok: true }>;

/** One step instance of a library block: entries are judged by the handler and, when accepted, recorded. */
class Bench {
  readonly records: EntryRecord[] = [];
  nowUs = 1_000_000_000n;
  /** The step instance started when the bench was set up (trusted time). */
  readonly startedAtUs = this.nowUs;
  private readonly handler;
  constructor(
    def: BlockDefinition,
    private readonly config: Config,
    private readonly targets: Record<string, DataValue> = {},
    private readonly mbr: MbrContent = mbrWith(phase('p')),
  ) {
    const h = libraryBlockVersion(def, expr).handler;
    if (!h) throw new Error('a library block has a handler');
    this.handler = h;
  }
  view(): HandlerView {
    return {
      phase: phase('p'),
      config: this.config as never,
      stepKey: 'p',
      frames: [],
      subLot: undefined,
      nowUs: this.nowUs,
      startedAtUs: this.startedAtUs,
      actor: { kind: 'PERSON', id: 'OP1', roles: ['OPERATOR'] },
      batch: { batchId: 'B1', batchNumber: 'B1', productCode: 'P1', marketSet: ['IN'] },
      mbr: this.mbr,
      expr,
      entries: (kind?: string) => this.records.filter((r) => kind === undefined || r.kind === kind),
      points: () => [],
      effective: () => undefined,
      target: (id: string) => this.targets[id],
      containers: () => [],
      parameter: () => undefined,
    } as unknown as HandlerView;
  }
  minutes(n: number): this {
    this.nowUs += BigInt(n) * MIN;
    return this;
  }
  try(kind: string, fields: Record<string, unknown> = {}): EntryResult {
    const r = this.handler.acceptEntry?.(this.view(), { kind, ...fields });
    if (!r) throw new Error('a library handler accepts entries');
    if (r.ok) this.records.push({ id: `e${this.records.length}`, stepKey: 'p', kind, data: r.data, enteredBy: 'OP1', recordedAt: this.nowUs, recordedSeq: this.records.length });
    return r;
  }
  ok(kind: string, fields: Record<string, unknown> = {}): Ok {
    const r = this.try(kind, fields);
    if (!r.ok) throw new Error(`refused: ${r.problems.map((p) => p.code).join(', ')}`);
    return r;
  }
  refused(kind: string, fields: Record<string, unknown> = {}): string[] {
    const r = this.try(kind, fields);
    if (r.ok) throw new Error('accepted');
    return r.problems.map((p) => p.code);
  }
  /** The exceptions the step's PERFORMED transition raises now. */
  onPerform(): string[] {
    return (this.handler.onPerform?.(this.view()).exceptions ?? []).map((e) => e.type);
  }
  beforePerform(): string[] {
    return (this.handler.beforePerform?.(this.view()) ?? []).map((p: HandlerProblem) => p.code);
  }
}

const block = (sections: SectionDef[], extra: Partial<BlockDefinition> = {}): BlockDefinition => ({ code: 'K', version: 1, title: 'Kill', category: 'PROCESS', sections, signatures: [{ meaning: 'PERFORMED', role: 'OPERATOR' }], ...extra });
const once = (id: string, fields: FieldDef[], repeat?: SectionDef['repeat']): SectionDef => ({ id, title: id, fields, ...(repeat ? { repeat } : {}) });
const types = (r: Ok): string[] => (r.exceptions ?? []).map((e) => e.type);

describe('statistics at their edges', () => {
  it('[PR-29] no readings give no statistic, two readings give a sample RSD, and individual results are a copy', () => {
    for (const st of ['MEAN', 'MIN', 'MAX', 'RANGE', 'RSD'] as const) expect(statistic(st, [])).toEqual([]);
    expect(statistic('RSD', ['99', '101'])[0]?.startsWith('1.41421356')).toBe(true);
    const r = ['1', '2'];
    const copy = statistic('INDIVIDUAL', r);
    expect(copy).toEqual(r);
    expect(copy).not.toBe(r);
  });
});

describe('every limited field kind raises its breach (PR-08)', () => {
  const def = block([
    once('rec', [
      { id: 'temp', label: 'Temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'temp', critical: true },
      { id: 'mass', label: 'Mass', type: 'WEIGHING', unit: 'kg', limitSlot: 'mass' },
      { id: 'opt', label: 'Optional', type: 'NUMBER', unit: 'g', limitSlot: 'opt', required: false },
      { id: 'free', label: 'Unlimited', type: 'NUMBER', unit: 'g', limitSlot: 'free' },
      { id: 'ref', label: 'Reference', type: 'TEXT', required: true },
      { id: 'look', label: 'Appearance', type: 'CHOICE', options: ['GOOD', 'DAMAGED'], notAllowed: ['DAMAGED'] },
      { id: 'clean', label: 'Clean', type: 'YES_NO', expected: true },
    ]),
  ]);
  const use: Config = { limits: { temp: range('Cel', '55', '65'), mass: range('kg', '9.9', '10.1', 'INTERNAL_ACTION'), opt: range('g', '1', '2') } };
  const good = { temp: '60', mass: '10.0', opt: '1.5', free: '1000', ref: 'R-1', look: 'GOOD', clean: true };
  const run = (over: Record<string, unknown>, drop: string[] = []): EntryResult => {
    const e: Record<string, unknown> = { ...good, ...over };
    for (const k of drop) delete e[k];
    return new Bench(def, use).try('rec', e);
  };

  it('[PR-08][PR-29] a number, a weighing, a not-allowed choice and an unexpected answer each raise their exception, with the tier and a deviation; values inside raise none', () => {
    const inside = run({}) as Ok;
    expect(types(inside)).toEqual([]);
    const hot = run({ temp: '70' }) as Ok;
    expect(types(hot)).toEqual(['LIB_LIMIT_BREACH']);
    expect(hot.exceptions?.[0]?.item).toBe('p.temp');
    expect(hot.exceptions?.[0]?.title).toContain('[registered tier]');
    const heavy = run({ mass: '10.5' }) as Ok;
    expect(types(heavy)).toEqual(['LIB_LIMIT_BREACH']);
    expect(heavy.exceptions?.[0]?.item).toBe('p.mass');
    expect(heavy.exceptions?.[0]?.title).toContain('[internal action tier]');
    const damaged = run({ look: 'DAMAGED' }) as Ok;
    expect(damaged.exceptions?.map((e) => [e.type, e.item, e.deviationRequired, e.blocks])).toEqual([['LIB_NOT_ALLOWED_CHOICE', 'p.look', true, 'STEP']]);
    const dirty = run({ clean: false }) as Ok;
    expect(dirty.exceptions?.map((e) => [e.type, e.item, e.deviationRequired, e.blocks])).toEqual([['LIB_UNEXPECTED_ANSWER', 'p.clean', true, 'STEP']]);
  });

  it('[PR-08][PR-03] an optional value left empty is not judged, a slot the formulation left without limits judges nothing, and a field marked required must be given', () => {
    const r = run({}, ['opt']);
    expect(r.ok && types(r)).toEqual([]);
    expect(r.ok && 'opt' in r.data).toBe(false);
    expect(types(run({ opt: '5' }) as Ok)).toEqual(['LIB_LIMIT_BREACH']);
    const noLimits = new Bench(def, {}).ok('rec', { ...good, temp: '1000' });
    expect(types(noLimits)).toEqual([]);
    const r2 = run({}, ['ref']);
    expect(!r2.ok && r2.problems.map((p) => p.code)).toEqual(['LIB-ENTRY-REQUIRED']);
  });

  it('[PR-08][DI-30] a section with no weighing, lot, equipment or calculation stores only its values and needs no second person', () => {
    const r = run({}) as Ok;
    expect(r.verificationRequired).toBe(true);
    const plain = block([once('rec', [{ id: 'x', label: 'X', type: 'NUMBER', unit: 'g' }])]);
    const p = new Bench(plain, {}).ok('rec', { x: '1' });
    expect(p.data).toEqual({ x: '1' });
    expect(p.verificationRequired).toBeUndefined();
    const onlyWeighing = block([once('rec', [{ id: 'w', label: 'W', type: 'WEIGHING', unit: 'kg' }])]);
    expect(new Bench(onlyWeighing, {}).ok('rec', { w: '1' }).verificationRequired).toBe(true);
  });

  it('[INV-25][DI-33] a calculated field hidden by its condition is neither computed nor judged', () => {
    const def2 = block([
      once('rec', [
        { id: 'yn', label: 'Applies', type: 'YES_NO' },
        { id: 'x', label: 'X', type: 'NUMBER', unit: 'g', showWhen: { field: 'yn', equals: true } },
        { id: 'c', label: 'C', type: 'CALC', expression: 'x * 2', unit: 'g', limitSlot: 'c', showWhen: { field: 'yn', equals: true } },
      ]),
    ]);
    const use2: Config = { limits: { c: range('g', '1', '2') } };
    const hidden = new Bench(def2, use2).ok('rec', { yn: false });
    expect(types(hidden)).toEqual([]);
    expect(hidden.data).toEqual({ yn: false });
    expect(types(new Bench(def2, use2).ok('rec', { yn: true, x: '5' }))).toEqual(['LIB_LIMIT_BREACH']);
  });
});

describe('calculations read other sections and the batch', () => {
  it('[DI-33] a calculation reads an earlier section\'s calculated value, a repeating section as a series of the values given, and a count the batch provides', () => {
    const def = block(
      [
        once('a', [
          { id: 'w', label: 'W', type: 'NUMBER', unit: 'g' },
          { id: 'c', label: 'C', type: 'CALC', expression: 'w * n', unit: 'g' },
        ]),
        once('loop', [{ id: 'y', label: 'Y', type: 'NUMBER', unit: 'g', required: false }], { kind: 'COUNT', countSlot: 'reps' }),
        once('z', [{ id: 'd', label: 'D', type: 'CALC', expression: 'c + max(y)', unit: 'g' }]),
      ],
      { inputs: [{ id: 'n', label: 'Units', kind: 'STEP_VALUE', unit: '1', slot: 'src' }] },
    );
    const b = new Bench(def, { counts: { reps: '2' }, stepValues: { src: { step: 's', field: 'f' } } }, { n: { kind: 'COUNT', value: '3' } });
    const value = (r: Ok, id: string): string | undefined => (r.data['computed'] as Record<string, { value: string }> | undefined)?.[id]?.value;
    expect(value(b.ok('a', { w: '2' }), 'c')).toBe('6');
    b.ok('loop', { y: '5' });
    b.ok('loop', {});
    expect(Number(value(b.ok('z', {}), 'd'))).toBe(11);
  });
});

describe('repeats: counts and loops (INV-20)', () => {
  it('[PR-03] a counted section is recorded exactly its count, once when the formulation gives none', () => {
    const def = block([once('shot', [{ id: 'x', label: 'X', type: 'NUMBER', unit: '1' }], { kind: 'COUNT', countSlot: 'shots' })]);
    const b = new Bench(def, { counts: { shots: '2' } });
    b.ok('shot', { x: '1' });
    b.ok('shot', { x: '1' });
    expect(b.refused('shot', { x: '1' })).toEqual(['LIB-SECTION-COUNT']);
    const one = new Bench(def, {});
    one.ok('shot', { x: '1' });
    expect(one.refused('shot', { x: '1' })).toEqual(['LIB-SECTION-COUNT']);
  });

  it('[INV-20][PR-29] a loop on a yes/no exits on the expected answer, or on any answer when none is expected', () => {
    const loop = (expected?: boolean) => block([once('chk', [{ id: 'ok', label: 'OK', type: 'YES_NO', ...(expected === undefined ? {} : { expected }) }], { kind: 'UNTIL_PASS', untilField: 'ok' })]);
    const b = new Bench(loop(true), {});
    expect(types(b.ok('chk', { ok: false }))).toEqual([]);
    expect(b.beforePerform()).toEqual(['LIB-PERFORM-NOT-PASSED']);
    b.ok('chk', { ok: true });
    expect(b.beforePerform()).toEqual([]);
    expect(b.refused('chk', { ok: true })).toEqual(['LIB-SECTION-PASSED']);
    const any = new Bench(loop(), {});
    any.ok('chk', { ok: false });
    expect(any.refused('chk', { ok: true })).toEqual(['LIB-SECTION-PASSED']);
  });

  it('[INV-20][PR-08] a loop exits on a calculated value within limits; a loop field left empty has not passed; a loop field with no limit passes', () => {
    const calc = block([
      once('chk', [
        { id: 'w', label: 'W', type: 'NUMBER', unit: '%' },
        { id: 'c', label: 'C', type: 'CALC', expression: 'w * 2', unit: '%', limitSlot: 'c', critical: true },
      ], { kind: 'UNTIL_PASS', untilField: 'c' }),
    ]);
    const b = new Bench(calc, { limits: { c: range('%', '1', '2') } });
    b.ok('chk', { w: '2' });
    b.ok('chk', { w: '0.6' });
    expect(b.refused('chk', { w: '0.6' })).toEqual(['LIB-SECTION-PASSED']);

    const optional = block([once('chk', [{ id: 'v', label: 'V', type: 'NUMBER', unit: '%', limitSlot: 'v', required: false }], { kind: 'UNTIL_PASS', untilField: 'v' })]);
    const e = new Bench(optional, { limits: { v: range('%', '1', '2') } });
    e.ok('chk', {});
    expect(e.beforePerform()).toEqual(['LIB-PERFORM-NOT-PASSED']);
    e.ok('chk', { v: '1.5' });
    expect(e.beforePerform()).toEqual([]);

    for (const config of [{}, { limits: {} }] as Config[]) {
      const u = new Bench(optional, config);
      u.ok('chk', { v: '99' });
      expect(u.refused('chk', { v: '99' })).toEqual(['LIB-SECTION-PASSED']);
    }
    const unlimited = block([once('chk', [{ id: 'v', label: 'V', type: 'NUMBER', unit: '%' }], { kind: 'UNTIL_PASS', untilField: 'v' })]);
    const n = new Bench(unlimited, {});
    n.ok('chk', { v: '99' });
    expect(n.refused('chk', { v: '99' })).toEqual(['LIB-SECTION-PASSED']);
  });

  it('[INV-20][PR-08] in a loop the other limited fields are judged; a pass on the last allowed repeat raises nothing, a failure there needs a deviation', () => {
    const def = block([
      once('lod', [
        { id: 'lod', label: 'LOD', type: 'NUMBER', unit: '%', limitSlot: 'lod', critical: true },
        { id: 'temp', label: 'Temperature', type: 'NUMBER', unit: 'Cel', limitSlot: 'temp' },
      ], { kind: 'UNTIL_PASS', untilField: 'lod', maxRepeatsSlot: 'max' }),
    ]);
    const use: Config = { limits: { lod: range('%', '1.5', '2.5'), temp: range('Cel', '55', '65') }, counts: { max: '2' } };
    const pass = new Bench(def, use);
    expect(types(pass.ok('lod', { lod: '3', temp: '70' }))).toEqual(['LIB_LIMIT_BREACH']);
    expect(types(pass.ok('lod', { lod: '2', temp: '60' }))).toEqual([]);
    const fail = new Bench(def, use);
    expect(types(fail.ok('lod', { lod: '3', temp: '60' }))).toEqual([]);
    const last = fail.ok('lod', { lod: '3', temp: '60' });
    expect(last.exceptions?.map((e) => [e.type, e.item, e.blocks, e.deviationRequired])).toEqual([['LIB_REPEAT_LIMIT_REACHED', 'p.lod', 'DOWNSTREAM', true]]);
    expect(fail.refused('lod', { lod: '2', temp: '60' })).toEqual(['LIB-SECTION-MAX']);
  });
});

describe('test results: replicates, points and statistics (PR-29)', () => {
  const ipc = block([once('round', [{ id: 'wt', label: 'Weights', type: 'TEST_RESULT', unit: 'mg', replicatesSlot: 'n', statistics: [{ statistic: 'MEAN', limitSlot: 'mean' }] }], { kind: 'PER_INTERVAL', intervalSlot: 'every' })]);
  const ipcUse: Config = { limits: { mean: range('mg', '237.5', '262.5') }, counts: { n: '3' }, intervals: { every: { value: '30', unit: 'min' } } };

  it('[PR-29][PR-08] a test result that is not a profile is judged on its statistics; with no count given any number of readings is taken', () => {
    expect(types(new Bench(ipc, ipcUse).ok('round', { wt: ['300', '300', '300'] }))).toEqual(['LIB_LIMIT_BREACH']);
    expect(types(new Bench(ipc, ipcUse).ok('round', { wt: ['250', '250', '250'] }))).toEqual([]);
    expect(types(new Bench(ipc, {}).ok('round', { wt: ['300', '300'] }))).toEqual([]);
  });

  it('[PR-29] a profile needs readings for exactly its points: an extra point, or points the formulation does not give, are refused', () => {
    const profile = block([once('run', [{ id: 'rel', label: 'Released', type: 'TEST_RESULT', unit: '%', replicatesSlot: 'v', statistics: [{ statistic: 'MEAN', limitSlot: 'mean' }], perPoint: true }])]);
    const use: Config = { counts: { v: '2' }, points: { rel: [{ id: 'h1', label: '1 h', limits: range('%', '20', '40') }] } };
    expect(types(new Bench(profile, use).ok('run', { rel: { h1: ['30', '30'] } }))).toEqual([]);
    expect(new Bench(profile, use).refused('run', { rel: { h1: ['30', '30'], h9: ['30', '30'] } })).toEqual(['LIB-ENTRY-POINTS']);
    expect(new Bench(profile, { counts: { v: '2' } }).refused('run', { rel: { h1: ['30', '30'] } })).toEqual(['LIB-ENTRY-POINTS']);
  });

  it('[PR-29][PR-30] an IPC round exactly at its interval is on time; one later is late, and the exception names the round and the interval', () => {
    const b = new Bench(ipc, ipcUse);
    const wt = ['250', '250', '250'];
    b.ok('round', { wt });
    expect(types(b.minutes(30).ok('round', { wt }))).toEqual([]);
    const late = b.minutes(31).ok('round', { wt });
    expect(late.exceptions?.map((e) => [e.type, e.title])).toEqual([['LIB_IPC_INTERVAL_MISSED', 'Kill, round: check 3 came later than every 30 min']]);
  });
});

describe('lots and equipment (S6)', () => {
  const def = block([
    once('weigh', [
      { id: 'bal', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'cls' },
      { id: 'lot', label: 'Lot', type: 'MATERIAL_LOT', required: false },
      { id: 'net', label: 'Net', type: 'WEIGHING', unit: 'kg' },
    ]),
  ]);
  const use: Config = { equipmentClasses: { cls: 'BAL-150' } };
  const bal = { code: 'BAL-1', classCode: 'BAL-150', fitness: 'QUALIFIED' };
  const lot = { id: 'L1', material: 'M', status: 'RELEASED', identityTested: true };

  it('[PR-19][PR-18] equipment needs the register\'s facts for that very code; an optional lot left empty is not looked up; the facts read are stored with the entry', () => {
    expect(new Bench(def, use).refused('weigh', { bal: 'BAL-1', net: '1' })).toEqual(['LIB-EQUIPMENT-FACTS']);
    expect(new Bench(def, use).refused('weigh', { bal: 'BAL-1', net: '1', equipment: { bal: { ...bal, code: 'BAL-2' } } })).toEqual(['LIB-EQUIPMENT-FACTS']);
    const noLot = new Bench(def, use).ok('weigh', { bal: 'BAL-1', net: '1', equipment: { bal } });
    expect(noLot.data).toEqual({ bal: 'BAL-1', net: '1', lots: {}, equipment: { bal } });
    const withLot = new Bench(def, use).ok('weigh', { bal: 'BAL-1', lot: 'L1', net: '1', equipment: { bal }, lots: { lot } });
    expect(withLot.data['lots']).toEqual({ lot });
    const equipmentOnly = block([once('use', [{ id: 'bal', label: 'Balance', type: 'EQUIPMENT', kind: 'BALANCE', classSlot: 'cls' }])]);
    const e = new Bench(equipmentOnly, use).ok('use', { bal: 'BAL-1', equipment: { bal } });
    expect(e.data).toEqual({ bal: 'BAL-1', equipment: { bal } });
    expect(e.verificationRequired).toBeUndefined();
  });
});

describe('timers on trusted time (PR-30)', () => {
  const def = block([
    once('run', [
      { id: 'a', label: 'A', type: 'TIMER' },
      { id: 'b', label: 'B', type: 'TIMER', durationUnit: 'min', limitSlot: 'b' },
    ]),
  ]);
  const use: Config = { limits: { b: range('min', '20', '35') } };

  it('[PR-30][PR-08] two timers are kept apart: each starts and stops once, and each duration runs from its own start', () => {
    const b = new Bench(def, use);
    expect(b.refused(TIMER_STOP, { field: 'b' })).toEqual(['LIB-TIMER-NOT-STARTED']);
    b.ok(TIMER_START, { field: 'a' });
    expect(b.refused(TIMER_STOP, { field: 'b' })).toEqual(['LIB-TIMER-NOT-STARTED']);
    b.minutes(10).ok(TIMER_START, { field: 'b' });
    expect(b.refused(TIMER_START, { field: 'b' })).toEqual(['LIB-TIMER-STARTED']);
    const stop = b.minutes(30).ok(TIMER_STOP, { field: 'b' });
    expect(stop.data).toEqual({ field: 'b', duration: { value: '30', unit: 'min' } });
    expect(types(stop)).toEqual([]);
    expect(b.refused(TIMER_STOP, { field: 'b' })).toEqual(['LIB-TIMER-STOPPED']);
    expect(b.ok(TIMER_STOP, { field: 'a' }).data).toEqual({ field: 'a', duration: { value: '40', unit: 'min' } });
  });

  it('[PR-30][PR-08] a timer whose limit the formulation leaves empty is not judged; a timer in a unit that is no time is refused', () => {
    const b = new Bench(def, {});
    b.ok(TIMER_START, { field: 'b' });
    expect(types(b.minutes(500).ok(TIMER_STOP, { field: 'b' }))).toEqual([]);
    const kg = new Bench(block([once('run', [{ id: 't', label: 'T', type: 'TIMER', durationUnit: 'kg' }])]), {});
    kg.ok(TIMER_START, { field: 't' });
    expect(kg.minutes(5).refused(TIMER_STOP, { field: 't' })).toEqual(['LIB-TIMER-UNIT']);
  });
});

describe('release review R3: the run-time judgement of library limits (decision 0026)', () => {
  type Tier = 'REGISTERED' | 'INTERNAL_ACTION' | 'ALERT';
  /** Limits of several tiers in one unit. */
  const tiered = (unit: string, ranges: [string, string, Tier][]): NonNullable<Config['limits']>[string] => ({ unit, ranges: ranges.flatMap(([lo, hi, tier]) => range(unit, lo, hi, tier).ranges) });

  it('[PR-08][PR-29] R3-ENG-2: individual results are all judged; the exception is that of the most severe tier any reading breaches (the first reading at that tier), not of the first reading outside a limit', () => {
    const def = block([once('chk', [{ id: 'wt', label: 'Weights', type: 'TEST_RESULT', unit: 'mg', replicatesSlot: 'n', statistics: [{ statistic: 'INDIVIDUAL', limitSlot: 'ind' }] }])]);
    const use: Config = { counts: { n: '3' }, limits: { ind: tiered('mg', [['90', '110', 'REGISTERED'], ['95', '105', 'ALERT']]) } };
    const worst = new Bench(def, use).ok('chk', { wt: ['104', '106', '150'] });
    expect(worst.exceptions?.map((e) => [e.type, e.severity, e.deviationRequired, e.qaOnly])).toEqual([['LIB_LIMIT_BREACH', 'CRITICAL', true, true]]);
    expect(worst.exceptions?.[0]?.title).toContain(' 150 mg ');
    expect(worst.exceptions?.[0]?.title).toMatch(/\[registered tier\]$/);
    // Two readings at the same most severe tier: the first of them is named.
    const two = new Bench(def, use).ok('chk', { wt: ['80', '106', '150'] });
    expect(two.exceptions?.map((e) => [e.severity, e.title.includes(' 80 mg ')])).toEqual([['CRITICAL', true]]);
    // Only alert-tier readings: one ALERT, named by the first.
    const alert = new Bench(def, use).ok('chk', { wt: ['100', '106', '107'] });
    expect(alert.exceptions?.map((e) => [e.severity, e.title.includes(' 106 mg ')])).toEqual([['ALERT', true]]);
    expect(types(new Bench(def, use).ok('chk', { wt: ['100', '101', '99'] }))).toEqual([]);
  });
});
