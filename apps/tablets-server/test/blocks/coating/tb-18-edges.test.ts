/**
 * TB-18@1 coating to weight gain (IN-37, PR-08, C-16) at its edges, through its handler on a minimal view: the room
 * limits and pan load at their ends, the cores part's entries once each, spraying and its log gaps at the interval, the
 * weight gain against its minimum and maximum (equal allowed), the stored entries and exceptions with their titles,
 * PERFORMED per part, the computed items and every definition check. Written for the Phase 3 exit mutation run
 * (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { DEFAULT_LOG_INTERVAL_US, gainLoopOf, logGaps, logIntervalUs, TB18 } from '../../../src/blocks/tb-18.ts';
import { blockMbr, COATER_ACTUALS, coatingConfig, coatingMbr, fixturePhase } from './support.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint };
const T = 1_800_000_000_000_000n;
const MIN = 60_000_000n;
const CORES = (TB18.goldenFixture as blocks.BlockGoldenFixture).phase.config as Json;

class World {
  entries: E[] = [];
  now = T;
  constructor(
    readonly config: Json,
    readonly core: string | null = '250.060000',
  ) {}
  view(): blocks.HandlerView {
    return {
      phase: { id: 'p', block: { type: 'TB-18', version: '1' } },
      config: this.config,
      stepKey: 'p@',
      nowUs: this.now,
      entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind),
      target: (item: string) => (item === 'coreMean' && this.core !== null ? { kind: 'DECIMAL', value: this.core, unit: 'mg' } : item === 'coreG' ? { kind: 'DECIMAL', value: '0.25', unit: 'g' } : undefined),
      batch: { marketSet: ['IN'] },
      actor: { id: 'OP1' },
    } as unknown as blocks.HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: { type: string; title: string; until?: string; qaOnly?: boolean }[]; verificationRequired?: boolean } {
    const accept = TB18.handler?.acceptEntry as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: never[]; verificationRequired?: boolean };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: this.now });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}), ...(r.verificationRequired ? { verificationRequired: true } : {}) };
  }
  before(): string[] {
    return ((TB18.handler?.beforePerform as (v: blocks.HandlerView) => { message: string }[])(this.view())).map((p) => p.message);
  }
}
const room = (t: string, h: string) => ({ kind: 'ROOM_CHECK', filteredAir: true, temperature: t, humidity: h });
const load = (value: string, unit = 'kg') => ({ kind: 'PAN_LOAD', quantity: { value, unit } });
const coated = (total: string, extra: Json = {}) => ({ kind: 'WEIGHT_CHECK', instrument: 'BAL-01', weighing: 'GROUP', count: '20', total, unit: 'mg', ...extra });

describe('TB-18 cores', () => {
  it('[IN-37][PR-25] the room is judged against each limit the MBR sets (ends allowed), with filtered air, once', () => {
    const at = (t: string, h: string, r: Json = CORES['room'] as Json) => new World({ ...CORES, room: r }).rec(room(t, h));
    expect(at('20', '60').data).toStrictEqual({ filteredAir: true, temperature: '20', humidity: '60', withinLimits: true, checkedBy: 'OP1' });
    expect(at('25', '0').data?.['withinLimits']).toBe(true);
    expect(at('19.9', '45').exceptions?.map((x) => [x.type, x.title])).toEqual([
      ['ROOM_CONDITIONS_OUT_OF_LIMITS', "The coating room of p@ is at 19.9 degC and 45 % RH, outside the MBR's limits: the steps after it wait for a deviation"],
    ]);
    expect(at('25.1', '45').data?.['withinLimits']).toBe(false);
    expect(at('24', '60.1').data?.['withinLimits']).toBe(false);
    expect(at('99', '99', {}).data?.['withinLimits']).toBe(true);
    expect(at('99', '45', { temperatureMin: '20' }).data?.['withinLimits']).toBe(true);
    expect(at('1', '45', { temperatureMax: '25' }).data?.['withinLimits']).toBe(true);
    expect(at('20', '45', 'x' as never).data?.['withinLimits']).toBe(true);
    const w = new World(CORES);
    expect(w.rec({ ...room('24', '45'), filteredAir: false }).refused).toBe('The air of the coating pan is filtered before coating starts (TB18-AIR; IN-37)');
    w.rec(room('24', '45'));
    expect(w.rec(room('24', '45')).refused).toBe('p@ already checked its coating room (TB18-ROOM-TWICE; IN-37)');
  });

  it('[IN-37][PR-08] the pan load is in the load range\'s unit and judged against it (ends allowed), once; the core sample once, the MBR\'s count (D 100), and checked by a second person', () => {
    const at = (value: string, unit = 'kg', cfg: Json = CORES) => new World(cfg).rec(load(value, unit));
    expect(at('40').data).toStrictEqual({ quantity: { value: '40', unit: 'kg' }, withinRange: true, recordedBy: 'OP1' });
    expect(at('80').data?.['withinRange']).toBe(true);
    expect(at('39.999').exceptions?.map((x) => [x.type, x.title])).toEqual([['LOAD_OUT_OF_RANGE', "The core load of p@ (39.999 kg) is outside the pan's load range: the steps after it wait for a deviation"]]);
    expect(at('80.001').data?.['withinRange']).toBe(false);
    expect(at('60', 'g').refused).toBe("The pan load is in kg, the unit of the MBR's load range (TB18-LOAD-UNIT; IN-37)");
    expect(at('5', 'g', { ...CORES, loadRange: undefined }).data?.['withinRange']).toBe(true);
    expect(new World(CORES).rec({ kind: 'PAN_LOAD', quantity: 'x' }).refused).toBe("The pan load is in kg, the unit of the MBR's load range (TB18-LOAD-UNIT; IN-37)");
    const w = new World(CORES);
    w.rec(load('60'));
    expect(w.rec(load('60')).refused).toBe('p@ already records its pan load (TB18-LOAD-TWICE; IN-37)');
    expect(w.rec({ kind: 'CORE_SAMPLE', instrument: 'B', weighing: 'GROUP', count: '10', total: '2500', unit: 'mg' }).refused).toBe('The sample is 20 tablets as the MBR sets it, not 10 (TB18-SAMPLE; PR-29, DI-29)');
    const s = w.rec({ kind: 'CORE_SAMPLE', instrument: 'B', weighing: 'GROUP', count: '20', total: '5000', unit: 'mg' });
    expect(s).toMatchObject({ data: { meanMg: '250.000000', recordedBy: 'OP1' }, verificationRequired: true });
    expect(w.rec({ kind: 'CORE_SAMPLE', instrument: 'B', weighing: 'GROUP', count: '20', total: '5000', unit: 'mg' }).refused).toBe('p@ already records its core sample (TB18-SAMPLE-TWICE; DI-29)');
    expect(new World({ ...CORES, sampleSize: undefined }).rec({ kind: 'CORE_SAMPLE', instrument: 'B', weighing: 'GROUP', count: '20', total: '5000', unit: 'mg' }).refused).toBe('The sample is 100 tablets as the MBR sets it, not 20 (TB18-SAMPLE; PR-29, DI-29)');
    expect(w.rec({ kind: 'SPRAY_START' }).refused).toBe('SPRAY_START is not an entry of the cores part of a coating step (TB18-PART; IN-37)');
  });

  it('[IN-37][PR-29] PERFORMED of the cores part needs the room check, the load and the sample; the core mean is computed from the sample', () => {
    const w = new World(CORES);
    expect(w.before()).toEqual([
      'p@ has not checked its coating room and pan air (TB18-NO-ROOM-CHECK; IN-37)',
      'p@ has no pan load (TB18-NO-LOAD; IN-37)',
      'p@ has no core sample (TB18-NO-SAMPLE; IN-37, PR-29)',
    ]);
    w.rec(room('24', '45'));
    w.rec(load('60'));
    w.rec({ kind: 'CORE_SAMPLE', instrument: 'B', weighing: 'GROUP', count: '20', total: '5000', unit: 'mg' });
    expect(w.before()).toEqual([]);
    const compute = TB18.handler?.computeItems as (v: blocks.HandlerView) => { item: string; value: Json; entries: string[] }[];
    expect(compute(w.view())).toEqual([{ item: 'coreMean', value: { kind: 'DECIMAL', value: '250.000000', unit: 'mg' }, entries: ['E3'] }]);
    expect(compute(new World(CORES).view())).toEqual([]);
    expect(compute(new World({ ...CORES, coreItem: undefined }).view())).toEqual([]);
    const items = TB18.handler?.computedItems as (p: flow.PhaseNode) => string[];
    expect(items(fixturePhase(TB18))).toEqual(['coreMean']);
    expect(items(fixturePhase(TB18, { config: { coreItem: undefined } as never }))).toEqual([]);
    expect(items(fixturePhase(TB18, { config: coatingConfig() as never }))).toEqual(['gain']);
    expect(items(fixturePhase(TB18, { config: { ...coatingConfig(), gainItem: undefined } as never }))).toEqual([]);
  });
});

describe('TB-18 coating', () => {
  const COAT = coatingConfig({ minGain: '2.5' });
  const sprayed = (cfg: Json = COAT) => {
    const w = new World(cfg);
    w.rec({ kind: 'SPRAY_START' });
    w.now += 10n * MIN;
    w.rec({ kind: 'SPRAY_END' });
    return w;
  };

  it('[IN-37][PR-29] spraying starts once against a core mean in mg and ends once; the suspension and applications belong to spraying', () => {
    expect(new World(COAT, null).rec({ kind: 'SPRAY_START' }).refused).toBe('p@ has no core mean weight to coat against (the cores part comes first) (TB18-NO-CORES; IN-37, PR-29)');
    expect(new World({ ...COAT, coreItem: 'coreG' }).rec({ kind: 'SPRAY_START' }).refused).toMatch(/TB18-NO-CORES/);
    const w = new World(COAT);
    expect(w.rec({ kind: 'SPRAY_END' }).refused).toBe('p@ has not started spraying (TB18-NOT-SPRAYING; IN-37)');
    expect(w.rec({ kind: 'SUSPENSION_USED', preparation: 'EN-1', quantity: { value: '1', unit: 'kg' } }).refused).toBe('The suspension of p@ is used while spraying (TB18-NOT-SPRAYING; IN-37)');
    expect(w.rec({ kind: 'SPRAY_START' }).data).toStrictEqual({ startedBy: 'OP1' });
    expect(w.rec({ kind: 'SPRAY_START' }).refused).toBe('p@ already started spraying (TB18-SPRAY-TWICE; IN-37)');
    expect(w.rec({ kind: 'SUSPENSION_USED', preparation: 'EN-1', quantity: { value: '1', unit: 'kg' } }).data).toStrictEqual({ preparation: 'EN-1', quantity: { value: '1', unit: 'kg' }, usedBy: 'OP1' });
    w.now += 15n * MIN;
    expect(w.rec({ kind: 'SPRAY_END' }).data).toMatchObject({ sprayingSeconds: '900.000000', endedBy: 'OP1' });
    expect(w.rec({ kind: 'SPRAY_END' }).refused).toBe('p@ already ended spraying (TB18-SPRAY-TWICE; IN-37)');
    const sc = new World({ ...COAT, coatingType: 'SC' });
    expect(sc.rec({ kind: 'APPLICATION', phase: 'SEAL' }).refused).toBe('p@ has not started its application (TB18-NOT-SPRAYING; IN-37)');
    sc.rec({ kind: 'SPRAY_START' });
    expect(sc.rec({ kind: 'APPLICATION', phase: 'SEAL' }).data).toStrictEqual({ phase: 'SEAL', appliedBy: 'OP1' });
    expect(sc.rec({ kind: 'APPLICATION', phase: 'SUBCOAT' }).refused).toBe("p@ already records its application; the next iteration takes the next (TB18-APPLICATION-TWICE; DI-29)");
    expect(new World(COAT).rec({ kind: 'APPLICATION', phase: 'SEAL' }).refused).toBe('Applications by phase are recorded for sugar coating only (TB18-NOT-SUGAR; IN-37)');
    expect(new World(COAT).rec({ kind: 'ROOM_CHECK' }).refused).toBe('ROOM_CHECK is not an entry of the coating part of a coating step (TB18-PART; IN-37)');
  });

  it('[IN-37][PR-29][DI-29] each collected tag is logged at most one interval apart while spraying (the interval itself allowed); unusable values do not count', () => {
    const view = (actuals: { tag: string; at: bigint; usable?: boolean }[], cfg: Json = COAT) => {
      const w = new World(cfg);
      w.entries = actuals.map((a, i) => ({ id: `A${i}`, kind: 'ACTUAL', data: { tag: a.tag, usable: a.usable ?? true }, recordedAt: a.at }));
      return w.view();
    };
    const tags = ['inlet.temp_C', 'exhaust.temp_C', 'bed.temp_C', 'spray.rate_g_min', 'pan.speed_rpm'];
    const every = (at: bigint) => tags.map((tag) => ({ tag, at }));
    expect(logIntervalUs({})).toBe(DEFAULT_LOG_INTERVAL_US);
    expect(DEFAULT_LOG_INTERVAL_US).toBe(15n * MIN);
    expect(logGaps(view([...every(T + 15n * MIN)]), T, T + 30n * MIN)).toEqual([]);
    expect(logGaps(view([...every(T + 15n * MIN)]), T, T + 30n * MIN + 1n)).toEqual(tags);
    expect(logGaps(view([...every(T + 15n * MIN + 1n)]), T, T + 20n * MIN)).toEqual(tags);
    expect(logGaps(view([...every(T + 10n * MIN), { tag: 'inlet.temp_C', at: T + 20n * MIN, usable: false }]), T, T + 26n * MIN)).toEqual(tags);
    // A value after the window never opens a gap inside it (mutation follow-up).
    expect(logGaps(view([...every(T + 10n * MIN), ...every(T + 40n * MIN)]), T, T + 20n * MIN)).toEqual([]);
    expect(logGaps(view([...every(T - 20n * MIN), ...every(T + 10n * MIN)]), T, T + 20n * MIN)).toEqual([]);
    // Values outside the spraying window do not count.
    expect(logGaps(view([...every(T - MIN), ...every(T + 40n * MIN)]), T, T + 20n * MIN)).toEqual(tags);
    expect(logGaps(view([], { ...COAT, actuals: undefined }), T, T + 99n * MIN)).toEqual([]);
    expect(logGaps(view([...every(T + 4n * MIN), ...every(T + 8n * MIN)], { ...COAT, logInterval: { value: '5', unit: 'min' } }), T, T + 13n * MIN)).toEqual([]);
    const w = new World(COAT);
    w.rec({ kind: 'SPRAY_START' });
    w.now += 16n * MIN;
    expect(w.rec({ kind: 'SPRAY_END' }).exceptions?.map((x) => [x.type, x.title, x.until])).toEqual([
      ['PARAMETER_LOG_GAP', 'The coating parameters inlet.temp_C, exhaust.temp_C, bed.temp_C, spray.rate_g_min, pan.speed_rpm of p@ were not logged at every interval while spraying: the steps after it wait for a deviation', 'DEVIATION'],
    ]);
  });

  it('[IN-37][PR-08][PR-29] the weight gain is checked once, after spraying, against the core mean: at the minimum and the maximum it passes; above the maximum QA decides', () => {
    expect(new World(COAT).rec(coated('5150')).refused).toBe('The weight-gain check of p@ is made after spraying (TB18-CHECK-EARLY; IN-37, PR-29)');
    // Core mean 250.060000: 2.5 % is 256.311500 mg each (5126.23 mg for 20); 3.5 % is 258.812100 mg (5176.242).
    const at = (total: string) => sprayed().rec(coated(total));
    expect(at('5126.23').data).toStrictEqual({ instrument: 'BAL-01', weighing: 'GROUP', count: '20', unit: 'mg', total: '5126.23', totalMg: '5126.23', meanMg: '256.311500', coreMeanMg: '250.060000', weightGain: '2.5000', belowMinimum: false, aboveMaximum: false, recordedBy: 'OP1' });
    expect(at('5126.229').data).toMatchObject({ weightGain: '2.5000', belowMinimum: true });
    expect(at('5176.242')).toMatchObject({ data: { weightGain: '3.5000', aboveMaximum: false }, verificationRequired: true });
    const above = at('5176.243');
    expect(above.data).toMatchObject({ weightGain: '3.5000', aboveMaximum: true });
    expect(above.exceptions?.map((x) => [x.type, x.title, x.until, x.qaOnly])).toEqual([
      ['WEIGHT_GAIN_ABOVE_MAXIMUM', "The weight gain of p@ is 3.5000 %, above the MBR's maximum of 3.5 %: QA assesses the coated tablets before anything after it runs", 'DISPOSITION', true],
    ]);
    expect(sprayed({ ...COAT, minGain: undefined, maxGain: undefined }).rec(coated('9000')).data).toMatchObject({ belowMinimum: false, aboveMaximum: false });
    const w = sprayed();
    w.rec(coated('5150'));
    expect(w.rec(coated('5150')).refused).toBe("p@ already records its weight-gain check; continued coating is the loop's next iteration (TB18-CHECK-TWICE; DI-29)");
    expect(sprayed(COAT).rec(coated('5150', { count: '19' })).refused).toBe('The sample is 20 tablets as the MBR sets it, not 19 (TB18-SAMPLE; PR-29, DI-29)');
    const noCore = new World(COAT, null);
    noCore.entries.push({ id: 'S', kind: 'SPRAY_START', data: {}, recordedAt: T }, { id: 'X', kind: 'SPRAY_END', data: {}, recordedAt: T });
    expect(noCore.rec(coated('5150')).refused).toBe('p@ has no core mean weight to coat against (TB18-NO-CORES; IN-37, PR-29)');
  });

  it('[IN-37][PR-29] PERFORMED of the coating part: spraying ended, a suspension, an application for sugar coating, and the check', () => {
    const w = new World({ ...COAT, coatingType: 'SC' });
    const own = (msgs: string[]) => msgs.filter((m) => m.includes('TB18-'));
    expect(own(w.before())).toEqual([
      'p@ has not finished spraying (TB18-NOT-SPRAYED; IN-37)',
      'p@ records no suspension used (TB18-NO-SUSPENSION; IN-37)',
      'p@ records no sugar-coating application (TB18-NO-APPLICATION; IN-37)',
      'p@ has no weight-gain check (TB18-NO-CHECK; IN-37, PR-29)',
    ]);
    w.rec({ kind: 'SPRAY_START' });
    w.rec({ kind: 'APPLICATION', phase: 'SEAL' });
    w.rec({ kind: 'SUSPENSION_USED', preparation: 'EN-1', quantity: { value: '1', unit: 'kg' } });
    w.rec({ kind: 'SPRAY_END' });
    w.rec(coated('5150'));
    expect(own(w.before())).toEqual([]);
    expect(own(new World(COAT).before())).not.toContain('p@ records no sugar-coating application (TB18-NO-APPLICATION; IN-37)');
  });
});

describe('TB-18 definition checks', () => {
  const P = (mbr: flow.MbrContent, id = 'p'): string[] => {
    const check = TB18.checkConfig as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string }[];
    const find = (n: flow.FlowNode): flow.PhaseNode | undefined =>
      n.kind === 'phase' ? (n.id === id ? n : undefined) : n.kind === 'loop' ? find(n.body) : 'children' in n ? n.children.map(find).find(Boolean) : 'body' in n ? find(n.body as flow.FlowNode) : undefined;
    const p = find(mbr.procedure.body) as flow.PhaseNode;
    return check(p, p.config as Json, mbr).filter((x) => x.code.startsWith('TB18')).map((x) => `${x.code}: ${x.message}`);
  };

  it('[IN-37][INV-25][PR-29] cores: the sample 20 to 200, the core item a single mg decimal of 6 decimals the step records, the room limits, no coating members', () => {
    expect(P(blockMbr(TB18))).toEqual([]);
    const cores = (config: Json) => blockMbr(TB18, fixturePhase(TB18, { config: config as never }));
    expect(P(cores({ sampleSize: '19' }))).toEqual(['TB18-SAMPLE-SIZE: The sample of p is 20 to 200 tablets']);
    expect(P(cores({ sampleSize: '201' }))).toEqual(['TB18-SAMPLE-SIZE: The sample of p is 20 to 200 tablets']);
    expect(P(cores({ sampleSize: '200' }))).toEqual([]);
    const coreItem = 'TB18-CORE-ITEM: The cores step p records the core mean weight as a single decimal in mg (coreItem, 6 decimals or more)';
    expect(P(cores({ coreItem: undefined }))).toEqual([coreItem]);
    expect(P(blockMbr(TB18, fixturePhase(TB18, { records: [] })))).toEqual([coreItem]);
    const withParam = (over: Json) => {
      const m = blockMbr(TB18);
      return P({ ...m, parameters: m.parameters.map((x) => ({ ...x, ...over }) as typeof x) });
    };
    expect(withParam({ precision: { kind: 'DECIMALS', digits: 5 } })).toEqual([coreItem]);
    expect(withParam({ precision: { kind: 'SIGNIFICANT', digits: 6 } })).toEqual([coreItem]);
    expect(withParam({ precision: undefined })).toEqual([]);
    expect(withParam({ unit: 'g' })).toEqual([coreItem]);
    expect(withParam({ readings: 3 })).toEqual([coreItem]);
    expect(withParam({ valueType: 'INTEGER' })).toEqual([coreItem]);
    const roomMsg = "TB18-ROOM: The cores step p sets the coating room's temperature and humidity limits (Sched M VIII 4.1)";
    expect(P(cores({ room: { humidityMax: '60' } }))).toEqual([roomMsg]);
    expect(P(cores({ room: { temperatureMax: '25' } }))).toEqual([roomMsg]);
    expect(P(cores({ room: { temperatureMin: '20', humidityMax: '60' } }))).toEqual([]);
    expect(P(cores({ room: { temperatureMax: '25', humidityMax: '60' } }))).toEqual([]);
    expect(P(cores({ setpoints: [], logInterval: { value: '1', unit: 'min' } }))).toEqual([
      'TB18-PART: setpoints belongs to the coating part, not the cores part of p',
      'TB18-PART: logInterval belongs to the coating part, not the cores part of p',
    ]);
  });

  it('[IN-37][PR-08][DI-34] coating: the core item read, the coater tags with both limits, the gain item a % end point with an upper limit (and a lower one for a functional film), gain limits ordered, a positive log interval, a bounded loop on the gain, no cores members', () => {
    expect(P(coatingMbr())).toEqual([]);
    expect(P(coatingMbr({ config: { coreItem: 'other' } }))).toEqual(['TB18-CORE-ITEM: Coating step p reads the core mean weight (coreItem) the cores step records']);
    expect(P(coatingMbr({ config: { actuals: [{ tag: 'inlet.temp_C', unit: 'degC', min: '50.0' }] } }))).toEqual([
      'TB18-PARAMETERS: Coating step p collects inlet.temp_C, exhaust.temp_C, bed.temp_C, spray.rate_g_min, pan.speed_rpm with lower and upper limits',
    ]);
    expect(P(coatingMbr({ config: { gainItem: 'nope' } }))).toContain('TB18-GAIN-ITEM: Coating step p records the weight gain as a decimal process end point in % (gainItem, 4 decimals or more)');
    const gainMbr = (over: Json, config: Json = {}) => {
      const m = coatingMbr({ config: config as never });
      return P({ ...m, parameters: m.parameters.map((x) => (x.id === 'gain' ? ({ ...x, ...over } as typeof x) : x)) });
    };
    expect(gainMbr({ role: 'PROCESS_PARAMETER' })).toEqual(['TB18-GAIN-ITEM: Coating step p records the weight gain as a decimal process end point in % (gainItem, 4 decimals or more)']);
    const lowOnly = { limits: { unit: '%', ranges: [{ tier: 'VALIDATED', low: { value: '2.5', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] } };
    const highOnly = { limits: { unit: '%', ranges: [{ tier: 'VALIDATED', high: { value: '3.5', inclusive: true }, rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } }] } };
    expect(gainMbr(lowOnly)).toEqual(['TB18-GAIN-LIMITS: The weight gain of p has an upper limit']);
    expect(gainMbr(highOnly)).toEqual([]);
    expect(gainMbr(highOnly, { coatingType: 'FC_F', minGain: '2.5' })).toEqual(['TB18-GAIN-LIMITS: The weight gain of p has an upper limit and, for a functional film, a lower limit']);
    expect(P(coatingMbr({ config: { coatingType: 'FC_F' } }))).toEqual(['TB18-MIN-GAIN: A functional film (p) sets the minimum weight gain']);
    expect(P(coatingMbr({ without: ['maxGain'] }))).toEqual(['TB18-MAX-GAIN: Coating step p sets the maximum weight gain']);
    expect(P(coatingMbr({ config: { minGain: '3.6' } }))).toEqual(['TB18-MAX-GAIN: The minimum weight gain of p is above its maximum']);
    expect(P(coatingMbr({ config: { minGain: '3.5' } }))).toEqual([]);
    expect(P(coatingMbr({ config: { logInterval: { value: '0', unit: 'min' } } }))).toEqual(['TB18-LOG-INTERVAL: The parameter log interval of p is a positive whole number of microseconds']);
    expect(P(coatingMbr({ without: ['logInterval'] }))).toEqual([]);
    expect(P(coatingMbr({ maxIterations: 21 }))).toEqual(['TB18-ITERATIONS: The coating loop of p allows 21 iterations; the block allows 1 to 20']);
    expect(P(coatingMbr({ maxIterations: 20 }))).toEqual([]);
    expect(P(coatingMbr({ maxIterations: 0 }))).toContain('TB18-ITERATIONS: The coating loop of p allows 0 iterations; the block allows 1 to 20');
    expect(P(coatingMbr({ config: { room: {}, loadRange: {} } }))).toEqual([
      'TB18-PART: room belongs to the cores part, not the coating part of p',
      'TB18-PART: loadRange belongs to the cores part, not the coating part of p',
    ]);
    // Mutation follow-up: the step itself must read the core item and record the gain item; every tag with both
    // limits as text; any range with an upper (and for FC_F a lower) limit; the maximum gain as text; a log interval in
    // a unit; G-06's own problems are passed on.
    const patch = (over: Partial<flow.PhaseNode>, config: Json = {}): flow.MbrContent => {
      const m = coatingMbr({ config: config as never });
      const map = (n: flow.FlowNode): flow.FlowNode =>
        n.kind === 'phase' ? (n.id === 'p' ? { ...n, ...over } : n) : n.kind === 'loop' ? { ...n, body: map(n.body) } : 'children' in n ? ({ ...n, children: n.children.map(map) } as flow.FlowNode) : 'body' in n ? ({ ...n, body: map(n.body as flow.FlowNode) } as flow.FlowNode) : n;
      return { ...m, procedure: { ...m.procedure, body: map(m.procedure.body) } };
    };
    expect(P(patch({ reads: [] }))).toEqual(['TB18-CORE-ITEM: Coating step p reads the core mean weight (coreItem) the cores step records']);
    expect(P(patch({ records: [] }))).toEqual(['TB18-GAIN-ITEM: Coating step p records the weight gain as a decimal process end point in % (gainItem, 4 decimals or more)']);
    const acts = (f: (a: Json) => Json) => P(coatingMbr({ config: { actuals: COATER_ACTUALS.map((a) => f(a)) as never } }));
    expect(acts((a) => (a['tag'] === 'pan.speed_rpm' ? { ...a, min: 1 } : a))).toEqual(['TB18-PARAMETERS: Coating step p collects pan.speed_rpm with lower and upper limits']);
    expect(acts((a) => (a['tag'] === 'bed.temp_C' ? { ...a, max: 44 } : a))).toEqual(['TB18-PARAMETERS: Coating step p collects bed.temp_C with lower and upper limits']);
    const range = (low?: string, high?: string) => ({ tier: 'VALIDATED', ...(low ? { low: { value: low, inclusive: true } } : {}), ...(high ? { high: { value: high, inclusive: true } } : {}), rounding: 'USP_HALF_UP_AT_LIMIT_DECIMALS', source: { kind: 'VALIDATION_REPORT', ref: 'VR' } });
    expect(gainMbr({ limits: { unit: '%', ranges: [range('2.5'), range(undefined, '3.5')] } })).toEqual([]);
    expect(gainMbr({ limits: { unit: '%', ranges: [range(undefined, '3.6'), range('2.5', '3.5')] } }, { coatingType: 'FC_F', minGain: '2.5' })).toEqual([]);
    expect(P(coatingMbr({ config: { maxGain: 3.5 as never } }))).toEqual(['TB18-MAX-GAIN: Coating step p sets the maximum weight gain']);
    expect(P(coatingMbr({ config: { logInterval: { value: '5' } as never } }))).toEqual(['TB18-LOG-INTERVAL: The parameter log interval of p is a positive whole number of microseconds']);
    const dup = coatingMbr({ config: { actuals: [...COATER_ACTUALS, COATER_ACTUALS[0]] as never } });
    const findP = (n: flow.FlowNode): flow.PhaseNode | undefined =>
      n.kind === 'phase' ? (n.id === 'p' ? n : undefined) : 'children' in n ? n.children.map(findP).find(Boolean) : 'body' in n ? findP(n.body as flow.FlowNode) : undefined;
    const p = findP(dup.procedure.body) as flow.PhaseNode;
    expect((TB18.checkConfig as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string }[])(p, p.config as Json, dup).map((x) => x.code)).toContain('G06-DUPLICATE-TAG');
    const m = coatingMbr();
    expect(gainLoopOf(m, 'p', 'gain')?.id).toBe('L-COAT');
    expect(gainLoopOf(m, 'p', 'other')).toBeUndefined();
  });
});
