/**
 * TB-07@1 blending, lubrication and blend uniformity (IN-36, IN-13, PR-29, DI-29) at its edges, through its handler on a
 * minimal view: blend and lubrication times measured between entries against their windows (boundaries inside), the
 * lubricant after the main blend, the BU samples of the plan with the 1 to 3 unit-dose rule, PERFORMED, the missing
 * locations, the computed time items and every definition check. Written for the Phase 3 exit mutation run (decision
 * 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { buPlanOf, TB07 } from '../../../src/blocks/tb-07.ts';
import { blockMbr, fixturePhase } from './support.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint; recordedSeq: number };
const T = 1_800_000_000_000_000n;
const MIN = 60_000_000n;
const PHASE = fixturePhase(TB07);
const CFG = PHASE.config as Json;
const mg = (value: string) => ({ value, unit: 'mg' });

class World {
  entries: E[] = [];
  now = T;
  constructor(readonly config: Json = CFG) {}
  view(): blocks.HandlerView {
    return {
      phase: { ...PHASE, id: 'p' },
      config: this.config,
      stepKey: 'p@',
      nowUs: this.now,
      entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind),
      actor: { id: 'OP1' },
      parameter: () => undefined,
    } as unknown as blocks.HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[] } {
    const accept = TB07.handler?.acceptEntry as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[] };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: this.now, recordedSeq: this.entries.length + 1 });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}) };
  }
  at(minutes: bigint, us = 0n): this {
    this.now = T + minutes * MIN + us;
    return this;
  }
}
/** Blended (10 min) and lubricated (3 min): ready for samples. */
const blended = (cfg: Json = CFG): World => {
  const w = new World(cfg);
  w.rec({ kind: 'BLEND_START' });
  w.at(10n).rec({ kind: 'BLEND_END' });
  if (cfg['lubrication'] !== undefined) {
    w.rec({ kind: 'LUBRICANT_ADDED', quantity: { value: '0.25', unit: 'kg' } });
    w.at(13n).rec({ kind: 'LUBRICATION_END' });
  }
  return w;
};
const sample = (location: string, replicate: unknown, mass: unknown, extra: Json = {}) => ({ kind: 'BU_SAMPLE', location, replicate, mass, ...extra });

describe('TB-07 times', () => {
  it('[IN-36][IN-13] the main blend: started once, ended once, never short of its minimum, beyond its maximum a deviation (boundaries inside)', () => {
    const w = new World();
    expect(w.rec({ kind: 'BLEND_END' }).refused).toBe('p@ has no blend start yet (TB07-NOT-STARTED; IN-36)');
    expect(w.rec({ kind: 'BLEND_START' }).data).toStrictEqual({ startedBy: 'OP1' });
    expect(w.rec({ kind: 'BLEND_START' }).refused).toBe('p@ already started blending (TB07-TWICE; IN-36)');
    expect(w.at(8n, -1n).rec({ kind: 'BLEND_END' }).refused).toBe("The main blend of p@ (479.999999 s) has not reached the MBR's minimum (TB07-BLEND-SHORT; IN-36, IN-13)");
    expect(w.at(8n).rec({ kind: 'BLEND_END' }).data).toStrictEqual({ seconds: '480.000000', withinLimits: true, recordedBy: 'OP1' });
    expect(w.rec({ kind: 'BLEND_END' }).refused).toBe('p@ already records BLEND_END (TB07-TWICE; IN-36, DI-29)');
    const top = new World();
    top.rec({ kind: 'BLEND_START' });
    expect(top.at(15n).rec({ kind: 'BLEND_END' }).exceptions).toBeUndefined();
    const over = new World();
    over.rec({ kind: 'BLEND_START' });
    const late = over.at(15n, 1n).rec({ kind: 'BLEND_END' });
    expect(late.data?.['withinLimits']).toBe(false);
    expect(late.exceptions).toEqual([
      { type: 'BLEND_TIME_EXCEEDED', title: "The main blend of p@ took 900.000001 s, beyond the MBR's maximum: the steps after it wait for a deviation", controls: ['IN-36', 'IN-13', 'PR-29'], severity: 'ACTION', category: 'TIME_LIMIT', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true },
    ]);
    const open = new World({ ...CFG, blendTime: { item: 'blendTime' } });
    open.rec({ kind: 'BLEND_START' });
    expect(open.rec({ kind: 'BLEND_END' }).data).toStrictEqual({ seconds: '0.000000', withinLimits: true, recordedBy: 'OP1' });
    const none = new World({ ...CFG, blendTime: undefined });
    none.rec({ kind: 'BLEND_START' });
    expect(none.at(999n).rec({ kind: 'BLEND_END' }).data?.['withinLimits']).toBe(true);
    expect(w.rec({ kind: 'OTHER' }).refused).toBe('OTHER is not an entry of a blending step (TB07-ENTRY; IN-36)');
  });

  it('[IN-36][IN-13] the lubricant after the main blend, once; lubrication timed from it in its window', () => {
    const w = new World();
    expect(new World({ ...CFG, lubrication: undefined }).rec({ kind: 'LUBRICANT_ADDED' }).refused).toBe('p has no lubrication in its MBR (TB07-NO-LUBRICATION; IN-36)');
    expect(w.rec({ kind: 'LUBRICATION_END' }).refused).toBe('p@ has no lubricant added yet (TB07-NO-LUBRICANT; IN-36)');
    w.rec({ kind: 'BLEND_START' });
    expect(w.rec({ kind: 'LUBRICANT_ADDED' }).refused).toBe('The lubricant of p@ is added only after the main blend time (TB07-LUBRICANT-EARLY; IN-36, IN-13)');
    w.at(10n).rec({ kind: 'BLEND_END' });
    expect(w.rec({ kind: 'LUBRICANT_ADDED', quantity: { value: '0.25', unit: 'kg' }, lot: 'L-9' }).data).toStrictEqual({ quantity: { value: '0.25', unit: 'kg' }, lot: 'L-9', addedBy: 'OP1' });
    expect(w.rec({ kind: 'LUBRICANT_ADDED' }).refused).toBe('p@ already records its lubricant (TB07-TWICE; IN-36)');
    expect(new World({ ...CFG }).rec({ kind: 'LUBRICANT_ADDED' }).refused).toMatch(/TB07-LUBRICANT-EARLY/);
    const noLot = blended({ ...CFG, lubrication: { max: { value: '5', unit: 'min' } } });
    expect(noLot.entries.find((e) => e.kind === 'LUBRICANT_ADDED')?.data).toStrictEqual({ quantity: { value: '0.25', unit: 'kg' }, addedBy: 'OP1' });
    const n = new World();
    n.rec({ kind: 'BLEND_START' });
    n.at(10n).rec({ kind: 'BLEND_END' });
    n.rec({ kind: 'LUBRICANT_ADDED', lot: 7 });
    expect(n.entries.at(-1)?.data).toStrictEqual({ quantity: undefined, addedBy: 'OP1' });
    expect(n.at(12n, -1n).rec({ kind: 'LUBRICATION_END' }).refused).toBe("The lubrication of p@ (119.999999 s) has not reached the MBR's minimum (TB07-LUBRICATION-SHORT; IN-36, IN-13)");
    const over = n.at(15n, 1n).rec({ kind: 'LUBRICATION_END' });
    expect(over.exceptions?.map((x) => [x['type'], x['title']])).toEqual([['LUBRICATION_TIME_EXCEEDED', "The lubrication of p@ took 300.000001 s, beyond the MBR's maximum: the steps after it wait for a deviation"]]);
    expect(w.at(12n).rec({ kind: 'LUBRICATION_END' }).data).toStrictEqual({ seconds: '120.000000', withinLimits: true, recordedBy: 'OP1' });
    expect(w.rec({ kind: 'LUBRICATION_END' }).refused).toBe('p@ already records LUBRICATION_END (TB07-TWICE; IN-36, DI-29)');
  });

  it('[INV-25][PR-08] the time items are computed from the end entries, never typed', () => {
    const items = (w: World) => (TB07.handler?.computeItems as (v: blocks.HandlerView) => Json[])(w.view());
    expect(TB07.handler?.computedItems?.(PHASE)).toEqual(['blendTime', 'lubeTime']);
    expect(items(new World())).toEqual([]);
    const w = blended();
    const ends = w.entries.filter((e) => e.kind.endsWith('_END')).map((e) => e.id);
    expect(items(w)).toEqual([
      { item: 'blendTime', value: { kind: 'DECIMAL', value: '600.000000', unit: 's' }, entries: [ends[0]] },
      { item: 'lubeTime', value: { kind: 'DECIMAL', value: '180.000000', unit: 's' }, entries: [ends[1]] },
    ]);
    expect(TB07.handler?.computedItems?.({ ...PHASE, config: { blendTime: { max: { value: '1', unit: 's' } } } } as never)).toEqual([]);
  });
});

describe('TB-07 blend uniformity', () => {
  it('[PR-29][DI-29] samples of the plan after blending is finished, each once, in the dose unit, 1 to 3 doses or justified', () => {
    expect(new World({ ...CFG, bu: undefined }).rec(sample('L1', 1, mg('500'))).refused).toBe('p has no blend-uniformity plan (TB07-NO-BU-PLAN; PR-29)');
    const early = new World();
    early.rec({ kind: 'BLEND_START' });
    early.at(10n).rec({ kind: 'BLEND_END' });
    expect(early.rec(sample('L1', 1, mg('500'))).refused).toBe('Blend-uniformity samples of p@ are taken when blending is finished (TB07-BU-EARLY; PR-29, IN-36)');
    const noLube = new World({ ...CFG, lubrication: undefined });
    expect(noLube.rec(sample('L1', 1, mg('500'))).refused).toMatch(/TB07-BU-EARLY/);
    noLube.rec({ kind: 'BLEND_START' });
    noLube.at(10n).rec({ kind: 'BLEND_END' });
    expect(noLube.rec(sample('L1', 1, mg('500'))).refused).toBeUndefined();
    const w = blended();
    expect(w.rec(sample('L9', 1, mg('500'))).refused).toBe('Location L9, replicate 1 is not in the sampling plan of p (TB07-NOT-PLANNED; PR-29)');
    expect(w.rec(sample('L1', 2, mg('500'))).refused).toBe('Location L1, replicate 2 is not in the sampling plan of p (TB07-NOT-PLANNED; PR-29)');
    expect(w.rec(sample('L1', '1', mg('500'))).refused).toMatch(/TB07-NOT-PLANNED/);
    expect(w.rec(sample('L1', 1, { value: '0.5', unit: 'g' })).refused).toBe('The sample mass is in the unit of the unit dose (mg) (TB07-SAMPLE-UNIT; PR-29)');
    expect(w.rec(sample('L1', 1, undefined)).refused).toMatch(/TB07-SAMPLE-UNIT/);
    expect(w.rec(sample('L1', 1, mg('249.9'))).refused).toBe('A sample of 249.9 mg is outside 1 to 3 times the unit dose (250 mg); record why (TB07-SAMPLE-SIZE; PR-29)');
    expect(w.rec(sample('L1', 1, mg('750.1'))).refused).toMatch(/TB07-SAMPLE-SIZE/);
    expect(w.rec(sample('L1', 1, mg('750.1'), { justification: '  ' })).refused).toMatch(/TB07-SAMPLE-SIZE/);
    expect(w.rec(sample('L1', 1, mg('250'))).data).toStrictEqual({ location: 'L1', replicate: 1, mass: mg('250'), withinDoseRange: true, sampledBy: 'OP1' });
    expect(w.rec(sample('L1', 1, mg('500'))).refused).toBe('Location L1, replicate 1 is already sampled (TB07-SAMPLE-TWICE; PR-29, DI-29)');
    expect(w.rec(sample('L2', 1, mg('750'))).data?.['withinDoseRange']).toBe(true);
    expect(w.rec(sample('L3', 1, mg('1100'), { justification: 'Larger thief' })).data).toStrictEqual({ location: 'L3', replicate: 1, mass: mg('1100'), withinDoseRange: false, justification: 'Larger thief', sampledBy: 'OP1' });
    expect(w.rec(sample('L4', 1, mg('300'), { justification: 'note' })).data?.['justification']).toBe('note');
  });

  it('[PR-29][DI-29] the plan as read; PERFORMED lists every planned sample not taken, replicates included', () => {
    expect(buPlanOf(CFG)).toEqual({ locations: ['L1', 'L2', 'L3', 'L4'], replicates: 1, unitDose: mg('250') });
    expect(buPlanOf({ bu: { unitDose: mg('1'), replicates: '2', resultsItem: 'BU' } })).toEqual({ locations: [], replicates: 1, unitDose: mg('1'), resultsItem: 'BU' });
    expect(buPlanOf({ bu: { locations: ['A'] } })).toBeUndefined();
    expect(buPlanOf({ bu: 'x' })).toBeUndefined();
    const perform = (w: World) => (TB07.handler?.onPerform as (v: blocks.HandlerView) => { exceptions?: Json[] })(w.view());
    const cfg = { ...CFG, bu: { locations: ['A', 'B'], replicates: 2, unitDose: mg('250') } };
    const w = blended(cfg);
    w.rec(sample('A', 1, mg('300')));
    w.rec(sample('B', 2, mg('300')));
    expect(perform(w)).toEqual({
      exceptions: [{ type: 'BU_LOCATION_MISSING', title: 'Blend-uniformity samples of p@ missing from the plan: A replicate 2, B replicate 1', controls: ['PR-29', 'DI-29'], severity: 'ALERT', category: 'FORCED_SKIPPED_NA', blocks: 'NONE' }],
    });
    w.rec(sample('A', 2, mg('300')));
    w.rec(sample('B', 1, mg('300')));
    expect(perform(w)).toEqual({});
    expect(perform(new World({ ...CFG, bu: undefined }))).toEqual({});
  });

  it('[IN-36] PERFORMED needs the main blend and, when the MBR lubricates, the lubrication finished', () => {
    const before = (w: World) => (TB07.handler?.beforePerform as (v: blocks.HandlerView) => { code: string; message: string }[])(w.view()).filter((p) => p.code.startsWith('TB07')).map((p) => p.message);
    const w = new World();
    expect(before(w)).toEqual(['p@ has not finished its main blend (TB07-NOT-BLENDED; IN-36)', 'p@ has not finished its lubrication (TB07-NOT-LUBRICATED; IN-36)']);
    w.rec({ kind: 'BLEND_START' });
    w.at(10n).rec({ kind: 'BLEND_END' });
    expect(before(w)).toEqual(['p@ has not finished its lubrication (TB07-NOT-LUBRICATED; IN-36)']);
    expect(before(blended())).toEqual([]);
    const plain = new World({ ...CFG, lubrication: undefined });
    plain.rec({ kind: 'BLEND_START' });
    plain.at(10n).rec({ kind: 'BLEND_END' });
    expect(before(plain)).toEqual([]);
  });
});

describe('TB-07 definition', () => {
  const P = (config: Json, extra: { records?: string[]; parameters?: Json[] } = {}) => {
    const phase = fixturePhase(TB07, { config: config as never, ...(extra.records ? { records: extra.records } : {}) });
    const mbr = blockMbr(TB07, phase, extra.parameters ? { parameters: extra.parameters as never } : {});
    return (TB07.checkConfig as (p: flow.PhaseNode, c: Json, m: unknown) => { code: string; message: string }[])(phase, config, mbr)
      .filter((x) => x.code.startsWith('TB07'))
      .map((x) => `${x.code}: ${x.message}`);
  };
  const PARAMS = (TB07.goldenFixture?.parameters ?? []) as unknown as Json[];

  it('[IN-36][IN-13] each time window has a maximum and runs from less to more (equal allowed)', () => {
    expect(P(CFG)).toEqual([]);
    expect(P({ ...CFG, blendTime: { min: { value: '8', unit: 'min' } } })).toEqual(['TB07-TIME: The blend time of p has no maximum (a whole number of microseconds)']);
    expect(P({ ...CFG, lubrication: { min: { value: '2', unit: 'min' }, item: 'lubeTime' } })).toEqual(['TB07-TIME: The lubrication time of p has no maximum (a whole number of microseconds)']);
    expect(P({ ...CFG, blendTime: { min: { value: '901', unit: 's' }, max: { value: '15', unit: 'min' }, item: 'blendTime' } })).toEqual(['TB07-TIME: The blendTime of p runs from more to less']);
    expect(P({ ...CFG, lubrication: { min: { value: '6', unit: 'min' }, max: { value: '5', unit: 'min' }, item: 'lubeTime' } })).toEqual(['TB07-TIME: The lubrication of p runs from more to less']);
    expect(P({ ...CFG, blendTime: { min: { value: '900', unit: 's' }, max: { value: '15', unit: 'min' }, item: 'blendTime' } })).toEqual([]);
    expect(P({ ...CFG, blendTime: { max: { value: '15', unit: 'min' }, item: 'blendTime' } })).toEqual([]);
  });

  it('[IN-36][INV-25] a computed time item is a single decimal in s that the step records', () => {
    const item = 'TB07-TIME-ITEM: The time item blendTime of p is a single decimal in s that the step records';
    const blend = PARAMS.find((p) => p['id'] === 'blendTime') as Json;
    const others = PARAMS.filter((p) => p['id'] !== 'blendTime');
    expect(P(CFG, { parameters: others })).toEqual([item]);
    expect(P(CFG, { records: ['lubeTime'] })).toEqual([item]);
    expect(P(CFG, { parameters: [...others, { ...blend, valueType: 'INTEGER' }] })).toEqual([item]);
    expect(P(CFG, { parameters: [...others, { ...blend, unit: 'min' }] })).toEqual([item]);
    expect(P(CFG, { parameters: [...others, { ...blend, readings: 2 }] })).toEqual([item]);
    expect(P(CFG, { parameters: [...others, { ...blend, readings: 1 }] })).toEqual([]);
  });

  it('[PR-29] the sampling map lists each location once; its results parameter records one decimal reading per planned sample, with limits', () => {
    expect(P({ ...CFG, bu: { locations: ['L1', 'L1'], replicates: 1, unitDose: mg('250') } })).toEqual(['TB07-BU-PLAN: The sampling map of p lists a location twice']);
    const bu = { locations: ['L1', 'L2'], replicates: 2, unitDose: mg('250'), resultsItem: 'BU' };
    const limits = { unit: '%', ranges: [{ tier: 'INTERNAL_ACTION', low: { value: '90', inclusive: true }, high: { value: '110', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] };
    const good = { id: 'BU', name: 'BU', valueType: 'DECIMAL', unit: '%', role: 'QUALITY_ATTRIBUTE', criticality: 'CRITICAL', riskClass: 'HIGH', capture: 'MANUAL', readings: 4, limits };
    const records = ['blendTime', 'lubeTime', 'BU'];
    const msg = 'TB07-BU-RESULTS: The blend-uniformity results of p are a decimal parameter the step records with limits, one reading per planned sample (4)';
    expect(P({ ...CFG, bu }, { records, parameters: [...PARAMS, good] })).toEqual([]);
    expect(P({ ...CFG, bu }, { records, parameters: PARAMS })).toEqual([msg]);
    expect(P({ ...CFG, bu }, { parameters: [...PARAMS, good] })).toEqual([msg]);
    expect(P({ ...CFG, bu }, { records, parameters: [...PARAMS, { ...good, valueType: 'INTEGER' }] })).toEqual([msg]);
    expect(P({ ...CFG, bu }, { records, parameters: [...PARAMS, { ...good, readings: 3 }] })).toEqual([msg]);
    expect(P({ ...CFG, bu }, { records, parameters: [...PARAMS, { ...good, readings: undefined }] })).toEqual([msg]);
    expect(P({ ...CFG, bu }, { records, parameters: [...PARAMS, { ...good, limits: undefined }] })).toEqual([msg]);
    expect(P({ ...CFG, bu: { ...bu, locations: ['L1'], replicates: 1 } }, { records, parameters: [...PARAMS, { ...good, readings: undefined }] })).toEqual([]);
  });
});
