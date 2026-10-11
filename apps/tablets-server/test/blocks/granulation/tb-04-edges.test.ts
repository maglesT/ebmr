/**
 * TB-04@1 wet granulation with its end point (IN-36, IN-13, PR-08, PR-29, DI-31) at its edges, through its handler on a
 * minimal view: the end point once, on a usable collected value of its tag (keyed by hand only with a reason and a
 * second person) or on the massing time (minimum refused, maximum held; ends allowed), the binder in its unit and its
 * total against its range at PERFORMED, extra fluid by the authorised roles up to its maximum, and every definition
 * check. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { endPointOf, extraFluidOf, TB04 } from '../../../src/blocks/tb-04.ts';
import { blockMbr, fixturePhase } from './support.ts';
import { mbrWithChildren, phase } from '../coating/support.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint };
const T = 1_800_000_000_000_000n;
const MIN = 60_000_000n;
const CFG = fixturePhase(TB04).config as Json;
const TIME: Json = { ...CFG, endPoint: { criterion: 'TIME', minTime: { value: '5', unit: 'min' }, maxTime: { value: '8', unit: 'min' } } };
const kg = (value: string) => ({ value, unit: 'kg' });

class World {
  entries: E[] = [];
  now = T;
  constructor(
    readonly config: Json = CFG,
    readonly roles: string[] = ['PRODUCTION_OPERATOR'],
  ) {}
  view(): blocks.HandlerView {
    return {
      phase: { id: 'p', system: undefined, block: { type: 'TB-04', version: '1' } },
      config: this.config,
      stepKey: 'p@',
      nowUs: this.now,
      entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind),
      actor: { id: 'OP1', roles: this.roles },
      parameter: () => undefined,
    } as unknown as blocks.HandlerView;
  }
  actual(tag: string, value: string, extra: Json = {}): string {
    const id = `A${this.entries.length + 1}`;
    this.entries.push({ id, kind: 'ACTUAL', data: { tag, value, unit: 'kW', usable: true, source: 'EQUIPMENT', ...extra }, recordedAt: this.now });
    return id;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[]; verificationRequired?: boolean } {
    const accept = TB04.handler?.acceptEntry as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[]; verificationRequired?: boolean };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: this.now });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}), ...(r.verificationRequired ? { verificationRequired: true } : {}) };
  }
}

describe('TB-04 end point on a collected value', () => {
  it('[IN-36][DI-31][PR-08] the end point names a usable value of its tag; within the range (ends allowed) it passes, outside it holds with its title; once', () => {
    const w = new World();
    const at = (value: string, extra: Json = {}) => {
      const x = new World();
      return x.rec({ kind: 'END_POINT', actual: x.actual('granulator.power_kW', value, extra) });
    };
    expect(w.rec({ kind: 'END_POINT' }).refused).toBe('The power end point of p@ names a usable collected value of granulator.power_kW of this step (TB04-ENDPOINT-VALUE; IN-36, DI-31)');
    expect(w.rec({ kind: 'END_POINT', actual: w.actual('granulator.product_temp_C', '30') }).refused).toMatch(/TB04-ENDPOINT-VALUE/);
    expect(w.rec({ kind: 'END_POINT', actual: w.actual('granulator.power_kW', '4', { usable: false }) }).refused).toMatch(/TB04-ENDPOINT-VALUE/);
    expect(at('3.80')).toStrictEqual({ data: { criterion: 'POWER', actual: 'A1', value: '3.80', unit: 'kW', withinRange: true, recordedBy: 'OP1' } });
    expect(at('4.60').data?.['withinRange']).toBe(true);
    expect(at('3.79').exceptions).toEqual([
      { type: 'ENDPOINT_OUT_OF_RANGE', title: "The granulation end point of p@ (3.79 kW) is outside the MBR's range: the steps after it wait for a deviation", controls: ['IN-36', 'PR-08', 'PR-29'], severity: 'ACTION', category: 'OUT_OF_LIMIT', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true },
    ]);
    expect(at('4.61').data?.['withinRange']).toBe(false);
    const once = new World();
    once.rec({ kind: 'END_POINT', actual: once.actual('granulator.power_kW', '4.2') });
    expect(once.rec({ kind: 'END_POINT', actual: once.actual('granulator.power_kW', '4.2') }).refused).toBe('p@ already records its end point (TB04-ENDPOINT-TWICE; IN-36, DI-29)');
    expect(new World({ ...CFG, endPoint: undefined }).rec({ kind: 'END_POINT', actual: 'x' }).refused).toBe('p has no end point in its MBR (TB04-NO-ENDPOINT; IN-36)');
    const minOnly = new World({ ...CFG, endPoint: { criterion: 'TORQUE', tag: 'granulator.power_kW', min: '1' } });
    expect(minOnly.rec({ kind: 'END_POINT', actual: minOnly.actual('granulator.power_kW', '99') }).data).toMatchObject({ criterion: 'TORQUE', withinRange: true });
  });

  it('[IN-36][DI-32] an end point on a value keyed by hand needs a reason and a second person', () => {
    const w = new World();
    const id = w.actual('granulator.power_kW', '4.2', { source: 'MANUAL' });
    expect(w.rec({ kind: 'END_POINT', actual: id }).refused).toBe('An end point called on a value keyed by hand needs a reason (and a second person) (TB04-MANUAL-ENDPOINT; IN-36, DI-32)');
    expect(w.rec({ kind: 'END_POINT', actual: id, reason: '  ' }).refused).toMatch(/TB04-MANUAL-ENDPOINT/);
    expect(w.rec({ kind: 'END_POINT', actual: id, reason: 'link down' })).toStrictEqual({ data: { criterion: 'POWER', actual: id, value: '4.2', unit: 'kW', withinRange: true, reason: 'link down', recordedBy: 'OP1' }, verificationRequired: true });
  });
});

describe('TB-04 end point on time', () => {
  it('[IN-36][IN-13] after the massing start, the massing time at least the minimum (refused below) and at most the maximum (held above); no value named', () => {
    const w = new World(TIME);
    expect(w.rec({ kind: 'END_POINT' }).refused).toBe('Start the wet massing of p@ first (TB04-NO-MASSING-START; IN-36, IN-13)');
    expect(w.rec({ kind: 'MASSING_START' }).data).toStrictEqual({ startedBy: 'OP1' });
    expect(w.rec({ kind: 'MASSING_START' }).refused).toBe('p@ already started its wet massing (TB04-MASSING-TWICE; IN-36)');
    w.now = T + 5n * MIN - 1n;
    expect(w.rec({ kind: 'END_POINT' }).refused).toBe("The massing time of p@ (299.999999 s) is below the MBR's minimum (TB04-ENDPOINT-EARLY; IN-36, IN-13)");
    expect(w.rec({ kind: 'END_POINT', actual: 'A1' }).refused).toBe('A time end point names no collected value (TB04-ENDPOINT-VALUE; IN-36)');
    const at = (mins: bigint, plus = 0n) => {
      const x = new World(TIME);
      x.rec({ kind: 'MASSING_START' });
      x.now = T + mins * MIN + plus;
      return x.rec({ kind: 'END_POINT', reason: 'r' });
    };
    expect(at(5n)).toStrictEqual({ data: { criterion: 'TIME', value: '300.000000', unit: 's', withinRange: true, reason: 'r', recordedBy: 'OP1' } });
    expect(at(8n).data?.['withinRange']).toBe(true);
    expect(at(8n, 1n).exceptions?.map((x) => x['title'])).toEqual(["The granulation end point of p@ (480.000001 s of massing) is outside the MBR's range: the steps after it wait for a deviation"]);
    const open = new World({ ...CFG, endPoint: { criterion: 'TIME' } });
    open.rec({ kind: 'MASSING_START' });
    open.now = T + 999n * MIN;
    expect(open.rec({ kind: 'END_POINT' }).data?.['withinRange']).toBe(true);
  });
});

describe('TB-04 binder and extra fluid', () => {
  it('[IN-36][PR-08][PR-29] binder in the range\'s unit; its total at PERFORMED within the range (ends allowed), else held with its title', () => {
    const cfg = { ...CFG, binder: { min: '10', max: '12', unit: 'kg' } };
    const w = new World(cfg);
    expect(w.rec({ kind: 'BINDER_ADDITION', preparation: 'EN-1', quantity: { value: '1', unit: 'g' } }).refused).toBe('Binder is added in kg (TB04-BINDER-UNIT; IN-36, PR-29)');
    expect(new World().rec({ kind: 'BINDER_ADDITION', preparation: 'EN-1' }).refused).toBe('Binder is added in one unit (TB04-BINDER-UNIT; IN-36, PR-29)');
    expect(new World().rec({ kind: 'BINDER_ADDITION', preparation: 'EN-1', quantity: { value: '1', unit: 'L' } }).data).toStrictEqual({ preparation: 'EN-1', quantity: { value: '1', unit: 'L' }, addedBy: 'OP1' });
    const onPerform = (x: World) => (TB04.handler?.onPerform as (v: blocks.HandlerView) => { exceptions?: Json[] })(x.view());
    expect(onPerform(w).exceptions?.map((x) => x['title'])).toEqual(["The binder added at p@ totals 0 kg, outside the MBR's range of 10 to 12 kg: the steps after it wait for a deviation"]);
    w.rec({ kind: 'BINDER_ADDITION', preparation: 'EN-1', quantity: kg('6') });
    w.rec({ kind: 'BINDER_ADDITION', preparation: 'EN-1', quantity: kg('4') });
    expect(onPerform(w)).toEqual({});
    w.rec({ kind: 'BINDER_ADDITION', preparation: 'EN-1', quantity: kg('2') });
    expect(onPerform(w)).toEqual({});
    w.rec({ kind: 'BINDER_ADDITION', preparation: 'EN-1', quantity: kg('0.001') });
    expect(onPerform(w).exceptions?.map((x) => [x['type'], x['title']])).toEqual([
      ['BINDER_QUANTITY_OUT_OF_RANGE', "The binder added at p@ totals 12.001 kg, outside the MBR's range of 10 to 12 kg: the steps after it wait for a deviation"],
    ]);
    expect(onPerform(new World())).toEqual({});
  });

  it('[IN-36][PR-29] extra fluid only where the MBR allows it, by its roles, in its unit; the total above the maximum holds (equal allowed)', () => {
    const cfg = { ...CFG, extraFluid: { max: { value: '2', unit: 'L' }, roles: ['SUPERVISOR', 'QA'] } };
    expect(new World().rec({ kind: 'EXTRA_FLUID', quantity: { value: '1', unit: 'L' } }).refused).toBe('p is not a step where the MBR allows extra granulating fluid (TB04-EXTRA-NOT-ALLOWED; IN-36, PR-29)');
    expect(new World(cfg).rec({ kind: 'EXTRA_FLUID', quantity: { value: '1', unit: 'L' } }).refused).toBe('Extra granulating fluid is added only by SUPERVISOR or QA (TB04-EXTRA-ROLE; IN-36, PR-29)');
    const w = new World(cfg, ['QA']);
    expect(w.rec({ kind: 'EXTRA_FLUID', quantity: { value: '1', unit: 'kg' } }).refused).toBe('Extra fluid is recorded in L (TB04-EXTRA-UNIT; IN-36)');
    expect(w.rec({ kind: 'EXTRA_FLUID', quantity: { value: '1.5', unit: 'L' }, reason: 'dry mass' }).data).toStrictEqual({ quantity: { value: '1.5', unit: 'L' }, reason: 'dry mass', withinMaximum: true, addedBy: 'OP1' });
    expect(w.rec({ kind: 'EXTRA_FLUID', quantity: { value: '0.5', unit: 'L' } }).data?.['withinMaximum']).toBe(true);
    expect(w.rec({ kind: 'EXTRA_FLUID', quantity: { value: '0.1', unit: 'L' } }).exceptions?.map((x) => [x['type'], x['title']])).toEqual([
      ['EXTRA_FLUID_OVER_MAXIMUM', "Extra granulating fluid at p@ totals 2.1 L, above the MBR's maximum of 2 L: the steps after it wait for a deviation"],
    ]);
    expect(extraFluidOf({ extraFluid: { max: 'x' } })).toBeUndefined();
    expect(extraFluidOf({ extraFluid: { max: { value: '1', unit: 'L' } } })).toEqual({ max: { value: '1', unit: 'L' }, roles: [] });
    expect(new World().rec({ kind: 'OTHER' }).refused).toBe('OTHER is not an entry of a granulation step (TB04-ENTRY; IN-36)');
  });

  it('[IN-36][INV-25] PERFORMED needs the end point and the extra fluid of an extra-fluid branch; the end-point item is computed from it', () => {
    const before = (x: World) => (TB04.handler?.beforePerform as (v: blocks.HandlerView) => { message: string }[])(x.view()).map((p) => p.message).filter((m) => m.includes('TB04-'));
    const w = new World({ ...CFG, extraFluid: { max: { value: '2', unit: 'L' }, roles: ['QA'] } }, ['QA']);
    expect(before(w)).toEqual(['Record the end point of p@ first (TB04-NO-ENDPOINT; IN-36, PR-29)', 'p@ is the extra-fluid branch and records no extra fluid (TB04-NO-EXTRA; IN-36)']);
    w.rec({ kind: 'END_POINT', actual: w.actual('granulator.power_kW', '4.2') });
    w.rec({ kind: 'EXTRA_FLUID', quantity: { value: '1', unit: 'L' } });
    expect(before(w)).toEqual([]);
    const compute = TB04.handler?.computeItems as (v: blocks.HandlerView) => Json[];
    expect(compute(w.view())).toEqual([{ item: 'endPower', value: { kind: 'DECIMAL', value: '4.2', unit: 'kW' }, entries: ['E2'] }]);
    expect(compute(new World().view())).toEqual([]);
    expect(compute(new World({ ...CFG, endPoint: { ...(CFG['endPoint'] as Json), item: undefined } }).view())).toEqual([]);
    expect((TB04.handler?.computedItems as (p: flow.PhaseNode) => string[])(fixturePhase(TB04))).toEqual(['endPower']);
    expect((TB04.handler?.computedItems as (p: flow.PhaseNode) => string[])(fixturePhase(TB04, { config: { endPoint: { criterion: 'TIME' } } as never }))).toEqual([]);
  });
});

describe('TB-04 definition checks', () => {
  const P = (config: Json, extra: Partial<flow.PhaseNode> = {}, mbrOf?: (p: flow.PhaseNode) => flow.MbrContent) => {
    const p = fixturePhase(TB04, { ...extra, config: config as never });
    const m = mbrOf ? mbrOf(p) : blockMbr(TB04, p);
    const chk = TB04.checkConfig as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string; controls: readonly string[] }[];
    return chk(p, p.config as Json, m).filter((x) => x.code.startsWith('TB04')).map((x) => `${x.code} [${x.controls.join(',')}] ${x.message}`);
  };
  it('[IN-36][DI-31][INV-25] an end point or extra fluid; a value end point on a collected tag with an ordered range and no time; a time end point with a time and no tag or range; its item a single decimal in its unit', () => {
    expect(P(CFG)).toEqual([]);
    expect(P({ ...CFG, endPoint: undefined })).toEqual(['TB04-NOTHING [IN-36] Granulation step p names neither an end point nor an extra-fluid addition']);
    const time = (ep: Json) => P({ ...CFG, endPoint: { criterion: 'TIME', ...ep } }, { records: [] });
    const t = 'TB04-ENDPOINT [IN-36] The time end point of p has a minimum or maximum massing time and no tag or value range';
    expect(time({ maxTime: { value: '8', unit: 'min' } })).toEqual([]);
    expect(time({ minTime: { value: '8', unit: 'min' } })).toEqual([]);
    expect(time({})).toEqual([t]);
    expect(time({ maxTime: { value: '8', unit: 'min' }, tag: 'x' })).toEqual([t]);
    expect(time({ maxTime: { value: '8', unit: 'min' }, min: '1' })).toEqual([t]);
    expect(time({ maxTime: { value: '8', unit: 'min' }, max: '1' })).toEqual([t]);
    expect(time({ minTime: { value: '9', unit: 'min' }, maxTime: { value: '8', unit: 'min' } })).toEqual(['TB04-ENDPOINT [IN-36] The massing time of p runs from more to less']);
    expect(time({ minTime: { value: '8', unit: 'min' }, maxTime: { value: '8', unit: 'min' } })).toEqual([]);
    const value = (ep: Json) => P({ ...CFG, endPoint: { criterion: 'POWER', tag: 'granulator.power_kW', min: '3.8', max: '4.6', ...ep } }, { records: [] });
    expect(value({ tag: 'x.y' })).toEqual(['TB04-ENDPOINT-TAG [IN-36,DI-31] The power end point of p reads x.y, which the step does not collect']);
    expect(value({ tag: undefined })).toEqual(['TB04-ENDPOINT-TAG [IN-36,DI-31] The power end point of p reads no tag, which the step does not collect']);
    const v = 'TB04-ENDPOINT [IN-36] The end point of p has a value range and no massing time';
    expect(value({ minTime: { value: '1', unit: 'min' } })).toEqual([v]);
    expect(value({ maxTime: { value: '1', unit: 'min' } })).toEqual([v]);
    expect(value({ min: undefined, max: undefined })).toEqual([v]);
    expect(value({ min: undefined })).toEqual([]);
    expect(value({ min: '4.7' })).toEqual(['TB04-ENDPOINT [IN-36] The end point range of p runs from 4.7 to 4.6']);
    expect(value({ min: '4.6' })).toEqual([]);
    const item = (over: Json, ep: Json = {}, records = ['endPower']) => {
      const p = fixturePhase(TB04, { records, config: { ...CFG, endPoint: { ...(CFG['endPoint'] as Json), ...ep } } as never });
      const m = blockMbr(TB04, p);
      const mm = { ...m, parameters: m.parameters.map((x) => (x.id === 'endPower' ? ({ ...x, ...over } as typeof x) : x)) };
      const chk = TB04.checkConfig as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string }[];
      return chk(p, p.config as Json, mm).filter((x) => x.code === 'TB04-ENDPOINT-ITEM').map((x) => x.message);
    };
    expect(item({})).toEqual([]);
    expect(item({ unit: 'W' })).toEqual(['The end-point item endPower of p is a single decimal the step records, in kW']);
    expect(item({ valueType: 'INTEGER' })).toHaveLength(1);
    expect(item({ readings: 2 })).toHaveLength(1);
    expect(item({}, {}, [])).toHaveLength(1);
    expect(item({}, { item: 'nope' })).toEqual(['The end-point item nope of p is a single decimal the step records, in kW']);
    expect(item({ unit: 's' }, { criterion: 'TIME', tag: undefined, min: undefined, max: undefined, maxTime: { value: '1', unit: 'min' } })).toEqual([]);
    expect(item({}, { tag: 'x.y' })).toEqual(['The end-point item endPower of p is a single decimal the step records, in the tag unit']);
  });

  it('[IN-36][DI-34] extra fluid only in an operator-choice branch, with its roles; the binder range ordered', () => {
    const x = { ...CFG, endPoint: undefined, extraFluid: { max: { value: '2', unit: 'L' }, roles: ['QA'] } };
    expect(P(x)).toEqual(['TB04-EXTRA-NOT-IN-BRANCH [IN-36,DI-34] Extra granulating fluid at p is allowed only inside an operator-choice branch']);
    const inBranch = (mode: string) => (p: flow.PhaseNode) => mbrWithChildren([{ kind: 'alternative', id: 'alt', name: 'A', decision: { mode, role: 'SUPERVISOR' }, branches: [{ id: 'b1', body: p }, { id: 'b2', body: phase('q') }] } as never]);
    expect(P(x, {}, inBranch('OPERATOR_CHOICE'))).toEqual([]);
    expect(P(x, {}, inBranch('CONDITION'))).toEqual(['TB04-EXTRA-NOT-IN-BRANCH [IN-36,DI-34] Extra granulating fluid at p is allowed only inside an operator-choice branch']);
    expect(P({ ...x, extraFluid: { max: { value: '2', unit: 'L' } } }, {}, inBranch('OPERATOR_CHOICE'))).toEqual(['TB04-EXTRA-ROLE [IN-36] Extra granulating fluid at p names no authorised role']);
    expect(P({ ...CFG, binder: { min: '12.1', max: '12', unit: 'kg' } })).toEqual(['TB04-BINDER-RANGE [IN-36] The binder range of p runs from 12.1 to 12']);
    expect(P({ ...CFG, binder: { min: '12', max: '12', unit: 'kg' } })).toEqual([]);
    expect(endPointOf({ endPoint: 'x' })).toBeUndefined();
    expect(endPointOf({ endPoint: { criterion: 'TIME', tag: 1, min: 2, max: 3, item: 4 } })).toEqual({ criterion: 'TIME' });
  });
});
