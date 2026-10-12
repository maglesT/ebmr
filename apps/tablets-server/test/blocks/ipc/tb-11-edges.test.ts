/**
 * TB-11@1 periodic IPC scheduler (tablets spec IN-35) at its edges: when each slot falls due (the run's start, its own
 * checks per stream, a missed marking, a change, a stoppage covering the due time or longer than the restart threshold,
 * a running stoppage, the run's end, the sweep), when it is overdue (the grace, strictly), the press counter, the station
 * sweep, the run's entries and the definition checks. Pure: dueOf and overdue on entry lists, the handler on a minimal
 * view. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { checkTest, DEFAULT_RESTART_US, dueOf, overdue, slotsOf, TB11 } from '../../../src/blocks/tb-11.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint; stepKey: string; enteredBy: string; recordedSeq: number };
const T = 1_800_000_000_000_000n;
const MIN = 60_000_000n;
const at = (m: bigint, extra = 0n) => T + m * MIN + extra;
const e = (kind: string, atUs: bigint, data: Json = {}): E => ({ id: `${kind}@${atUs}`, kind, data, recordedAt: atUs, stepKey: 'p@', enteredBy: 'OP1', recordedSeq: 0 });
const cfg: Json = {
  streams: [{ id: 'L' }, { id: 'R' }],
  plan: [
    { test: 'WEIGHT', every: { value: '25', unit: 'min' }, qrmRef: 'Q' },
    { test: 'FRIABILITY', every: { value: '60', unit: 'min' }, qrmRef: 'Q' },
  ],
  grace: { value: '5', unit: 'min' },
};
const due = (entries: E[], test = 'WEIGHT', stream = 'L', config: Json = cfg) => {
  const d = dueOf(entries, config, stream, test as never);
  return d.dueUs === undefined ? (d.suspended ? 'suspended, none' : 'none') : `${String((d.dueUs - T) / MIN)}m${(d.dueUs - T) % MIN === 0n ? '' : `+${String((d.dueUs - T) % MIN)}us`}${d.suspended ? ' suspended' : ''}`;
};
const START = e('RUN_START', T);

describe('TB-11 when a slot falls due', () => {
  it('[IN-35][PR-29] from the run\'s start, then from the slot\'s own latest check or missed marking; never before the start, never for an unplanned test', () => {
    expect(dueOf([], cfg, 'L', 'WEIGHT')).toStrictEqual({ suspended: false });
    expect(dueOf([START], cfg, 'L', 'PHYSICAL')).toStrictEqual({ suspended: false });
    expect(due([START])).toBe('25m');
    expect(due([START, e('WEIGHT_CHECK', at(10n), { stream: 'L' })])).toBe('35m');
    expect(due([START, e('WEIGHT_CHECK', at(10n), { stream: 'R' })])).toBe('25m');
    expect(due([START, e('PHYSICAL_CHECK', at(10n), { stream: 'L' })])).toBe('25m');
    expect(due([START, e('WEIGHT_CHECK', at(12n), { stream: 'L' }), e('WEIGHT_CHECK', at(10n), { stream: 'L' })])).toBe('37m');
    expect(due([START, e('CHANGE', at(30n), { missed: [{ stream: 'L', test: 'WEIGHT', by: 'TIME' }] })])).toBe('55m');
    expect(due([START, e('CHANGE', at(30n), { missed: [{ stream: 'R', test: 'WEIGHT', by: 'TIME' }, { stream: 'L', test: 'FRIABILITY', by: 'TIME' }] })])).toBe('25m');
    // A repeat run and a retest or buffer stage are part of their first run: they do not count as the slot's check.
    expect(due([START, e('FRIABILITY_RUN', at(10n), { stream: 'L', repeatOf: 'x' })], 'FRIABILITY')).toBe('60m');
    expect(due([START, e('FRIABILITY_RUN', at(10n), { stream: 'L' })], 'FRIABILITY')).toBe('70m');
  });

  it('[IN-35][PR-29] a change makes the slot due at once (not the sweep); the run\'s end makes it due at the end at the latest', () => {
    expect(due([START, e('CHANGE', at(5n))])).toBe('5m');
    expect(due([START, e('CHANGE', at(40n))])).toBe('25m');
    expect(due([START, e('RUN_END', at(10n))])).toBe('10m');
    expect(due([START, e('RUN_END', at(40n))])).toBe('25m');
    // Events before the slot's last check do not move it.
    expect(due([START, e('CHANGE', at(5n)), e('WEIGHT_CHECK', at(6n), { stream: 'L' })])).toBe('31m');
  });

  it('[IN-35][PR-29] a stoppage that covers the due time moves it to the restart (ends included); a stoppage longer than the restart threshold makes the slot due at the restart; a short one does not', () => {
    expect(due([START, e('STOPPAGE_START', at(20n)), e('STOPPAGE_END', at(40n))])).toBe('40m');
    expect(due([START, e('STOPPAGE_START', at(25n)), e('STOPPAGE_END', at(26n))])).toBe('26m');
    expect(due([START, e('STOPPAGE_START', at(24n)), e('STOPPAGE_END', at(25n))])).toBe('25m');
    expect(due([START, e('STOPPAGE_START', at(26n)), e('STOPPAGE_END', at(28n))])).toBe('25m');
    // Default threshold 15 min: 16 min is long, exactly 15 min is not.
    expect(DEFAULT_RESTART_US).toBe(15n * MIN);
    expect(due([START, e('STOPPAGE_START', at(1n)), e('STOPPAGE_END', at(17n))])).toBe('17m');
    expect(due([START, e('STOPPAGE_START', at(1n)), e('STOPPAGE_END', at(16n))])).toBe('25m');
    expect(due([START, e('STOPPAGE_START', at(1n)), e('STOPPAGE_END', at(16n, 1n))])).toBe('16m+1us');
    expect(due([START, e('STOPPAGE_START', at(1n)), e('STOPPAGE_END', at(4n))], 'WEIGHT', 'L', { ...cfg, restartAfter: { value: '2', unit: 'min' } })).toBe('4m');
    // A stoppage before the slot's last check is over: it neither moves nor suspends the slot.
    expect(due([START, e('STOPPAGE_START', at(1n)), e('STOPPAGE_END', at(17n)), e('WEIGHT_CHECK', at(18n), { stream: 'L' })])).toBe('43m');
    expect(due([START, e('STOPPAGE_START', at(1n)), e('STOPPAGE_END', at(2n)), e('WEIGHT_CHECK', at(3n), { stream: 'L' })])).toBe('28m');
  });

  it('[IN-35][PR-29][DI-28] a running stoppage suspends a slot due at or after its start, not one due before it', () => {
    expect(due([START, e('STOPPAGE_START', at(20n))])).toBe('25m suspended');
    expect(due([START, e('STOPPAGE_START', at(25n))])).toBe('25m suspended');
    expect(due([START, e('STOPPAGE_START', at(26n))])).toBe('25m');
    expect(due([START, e('STOPPAGE_START', at(1n)), e('STOPPAGE_END', at(2n))])).toBe('25m');
    expect(overdue([START, e('STOPPAGE_START', at(20n))], { ...cfg, streams: [{ id: 'L' }] }, at(120n))).toEqual([]);
  });

  it('[IN-35] the station sweep falls due at the start, then at its repeat interval (on multi-point presses), never after the run ended; a change or a long stoppage does not move it', () => {
    const sw = { ...cfg, sweep: { stations: 4, weight: {}, every: { value: '60', unit: 'min' } } };
    const once = { ...cfg, sweep: { stations: 4, weight: {} } };
    expect(due([START], 'SWEEP', 'L', sw)).toBe('0m');
    expect(due([START, e('STATION_SWEEP', at(2n), { stream: 'L' })], 'SWEEP', 'L', sw)).toBe('62m');
    expect(due([START, e('STATION_SWEEP', at(2n), { stream: 'L' })], 'SWEEP', 'L', once)).toBe('none');
    expect(due([START, e('STATION_SWEEP', at(2n), { stream: 'L' }), e('CHANGE', at(5n))], 'SWEEP', 'L', sw)).toBe('62m');
    expect(due([START, e('STATION_SWEEP', at(2n), { stream: 'L' }), e('STOPPAGE_START', at(3n)), e('STOPPAGE_END', at(30n))], 'SWEEP', 'L', sw)).toBe('62m');
    expect(due([START, e('STATION_SWEEP', at(2n), { stream: 'L' }), e('RUN_END', at(30n))], 'SWEEP', 'L', sw)).toBe('none');
    expect(due([START, e('STATION_SWEEP', at(2n), { stream: 'L' }), e('RUN_END', at(62n))], 'SWEEP', 'L', sw)).toBe('none');
    expect(due([START, e('STATION_SWEEP', at(2n), { stream: 'L' }), e('RUN_END', at(63n))], 'SWEEP', 'L', sw)).toBe('62m');
    expect(slotsOf(sw).map((s) => `${s.stream}:${s.test}`)).toEqual(['L:WEIGHT', 'L:FRIABILITY', 'L:SWEEP', 'R:WEIGHT', 'R:FRIABILITY', 'R:SWEEP']);
    expect(slotsOf({ streams: [{ id: 'L' }, 'x'], plan: [{ test: 'WEIGHT' }, 'y'] }).map((s) => `${s.stream}:${s.test}`)).toEqual(['L:WEIGHT']);
  });

  it('[IN-35][PR-29] a start sweep marked missed is dealt with at the marking: not due again without a repeat interval, due one interval after the marking with one (tablets 1110)', () => {
    const sw = { ...cfg, sweep: { stations: 4, weight: {}, every: { value: '60', unit: 'min' } } };
    const once = { ...cfg, sweep: { stations: 4, weight: {} } };
    const marked = e('WEIGHT_CHECK', at(10n), { stream: 'L', missed: [{ stream: 'L', test: 'SWEEP', by: 'TIME' }] });
    expect(due([START, marked], 'SWEEP', 'L', once)).toBe('none');
    expect(due([START, marked], 'SWEEP', 'L', sw)).toBe('70m');
    // Only the marked stream: R's start sweep is still due from the start.
    expect(due([START, marked], 'SWEEP', 'R', once)).toBe('0m');
    expect(overdue([START, marked], once, at(30n)).filter((m) => m.test === 'SWEEP').map((m) => m.stream)).toEqual(['R']);
  });

  it('[IN-35][PR-29] a slot is overdue strictly after its due time plus the grace, in stream and test order', () => {
    expect(overdue([START], cfg, at(30n))).toEqual([]);
    expect(overdue([START], cfg, at(30n, 1n))).toEqual([
      { stream: 'L', test: 'WEIGHT', by: 'TIME', dueUs: at(25n).toString() },
      { stream: 'R', test: 'WEIGHT', by: 'TIME', dueUs: at(25n).toString() },
    ]);
    expect(overdue([START], { ...cfg, grace: undefined }, at(25n, 1n)).map((m) => m.stream)).toEqual(['L', 'R']);
    expect(overdue([START], cfg, at(65n, 1n)).map((m) => `${m.stream}:${m.test}`)).toEqual(['L:WEIGHT', 'L:FRIABILITY', 'R:WEIGHT', 'R:FRIABILITY']);
  });

  it('[IN-35] the checks that count for the schedule: first stages and first runs, never repeats, retests or buffer stages', () => {
    const k = (kind: string, data: Json = {}) => checkTest({ kind, data });
    expect([k('WEIGHT_CHECK'), k('PHYSICAL_CHECK'), k('FRIABILITY_RUN'), k('DT_START'), k('STATION_SWEEP')]).toEqual(['WEIGHT', 'PHYSICAL', 'FRIABILITY', 'DISINTEGRATION', 'SWEEP']);
    expect([k('FRIABILITY_RUN', { repeatOf: 'x' }), k('DT_START', { retestOf: 'x' }), k('DT_START', { stage: 'BUFFER' }), k('DT_START', { stage: 'ACID' }), k('WEIGHT_SECOND_STAGE'), k('DT_END')]).toEqual([
      undefined,
      undefined,
      undefined,
      'DISINTEGRATION',
      undefined,
      undefined,
    ]);
  });
});

class World {
  entries: E[] = [];
  now = T;
  constructor(readonly config: Json) {}
  view(): blocks.HandlerView {
    return {
      phase: { block: { type: 'TB-11', version: '1' } },
      config: this.config,
      stepKey: 'p@',
      nowUs: this.now,
      entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind),
      batch: { marketSet: ['IN'] },
      actor: { id: 'OP1' },
    } as unknown as blocks.HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: { type: string; title: string; item?: string }[] } {
    const accept = TB11.handler?.acceptEntry?.bind(TB11.handler) as unknown as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: { type: string; title: string; item?: string }[] };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: this.now, stepKey: 'p@', enteredBy: 'OP1', recordedSeq: this.entries.length + 1 });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}) };
  }
}
const sweepCfg = {
  stations: 4,
  weight: { individual: { action: { min: '240', max: '260' }, alert: { min: '245', max: '255' } } },
  hardness: { unit: 'kp', individual: { action: { min: '40' } } },
};
const runCfg: Json = {
  streams: [{ id: 'L' }, { id: 'R' }],
  plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' }, everyCount: 1000, qrmRef: 'Q' }],
  grace: { value: '5', unit: 'min' },
  sweep: sweepCfg,
  weight: { mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '250.0', n: 20, weighing: 'GROUP', tolerance: { action: '2' } },
};
const R1 = '00000000-0000-4000-8000-000000000001';
const group = (stream: string, counter?: number): Json & { kind: string } => ({ kind: 'WEIGHT_CHECK', instrument: 'BAL', capture: 'DEVICE', readings: [R1], stream, groupWeight: '5000.0', ...(counter !== undefined ? { counter } : {}) });
const station = (n: number, w: string, h: string) => ({ station: n, weight: w, hardness: h });
const sweep = (stream: string, stations: Json[]): Json & { kind: string } => ({ kind: 'STATION_SWEEP', instrument: 'BAL', capture: 'DEVICE', stream, readings: Array.from({ length: stations.length * 2 }, () => R1), stations });

describe('TB-11 entries', () => {
  it('[PR-29][IN-35] the run starts once with its press and counter; nothing is recorded before it; after its end only end-of-run checks; a stoppage is ended before sampling, before another stoppage and before the end', () => {
    const w = new World(runCfg);
    expect(w.rec(group('L', 1)).refused).toBe('p@ has not started its run (TB11-NOT-STARTED; PR-29, IN-35)');
    expect(w.rec({ kind: 'RUN_START', press: 'P-1', counter: 0 }).data).toStrictEqual({ press: 'P-1', counter: 0, recordedBy: 'OP1' });
    expect(w.rec({ kind: 'RUN_START', press: 'P-1' }).refused).toBe('p@ has started its run already; a new run is a new step (TB11-TWICE; PR-29)');
    expect(w.rec({ kind: 'STOPPAGE_END' }).refused).toBe('The press of p@ is not stopped (TB11-NOT-STOPPED; PR-29)');
    w.now = at(1n);
    expect(w.rec({ kind: 'STOPPAGE_START' }).data).toStrictEqual({ recordedBy: 'OP1' });
    expect(w.rec({ kind: 'STOPPAGE_START' }).refused).toBe('The press of p@ is stopped already (TB11-STOPPED; PR-29)');
    expect(w.rec(group('L', 5)).refused).toBe('The press of p@ is stopped: end the stoppage before sampling (TB11-STOPPED; PR-29, DI-28)');
    expect(w.rec({ kind: 'RUN_END' }).refused).toBe('End the stoppage of p@ before the run ends (TB11-STOPPED; PR-29)');
    w.now = at(16n);
    expect(w.rec({ kind: 'STOPPAGE_END' }).data).toMatchObject({ start: 'E2', seconds: '900.000000', long: false, recordedBy: 'OP1' });
    w.rec({ kind: 'STOPPAGE_START' });
    w.now = at(31n, 1n);
    expect(w.rec({ kind: 'STOPPAGE_END' }).data).toMatchObject({ start: 'E4', long: true });
    expect(w.rec({ kind: 'CHANGE', change: 'TOOLING' }).data).toMatchObject({ change: 'TOOLING', recordedBy: 'OP1' });
    expect(w.rec({ kind: 'RUN_END' }).data).toMatchObject({ recordedBy: 'OP1' });
    expect(w.rec({ kind: 'CHANGE', change: 'SETTING' }).refused).toBe('The run of p@ has ended: only its end-of-run checks remain (TB11-ENDED; PR-29)');
    expect(w.rec(group('L', 50)).data).toMatchObject({ stream: 'L', result: 'PASS' });
  });

  it('[PR-29][PR-07][DI-28] a check is of a planned test, gives the press counter when its interval is by count, and the counter never goes back (equal allowed)', () => {
    const w = new World(runCfg);
    w.rec({ kind: 'RUN_START', press: 'P-1', counter: 100 });
    expect(w.rec({ kind: 'PHYSICAL_CHECK', stream: 'L', capture: 'MANUAL' }).refused).toBe('physical is not in the test plan of p@ (TB11-NOT-PLANNED; PR-29, PR-07)');
    expect(w.rec(group('L')).refused).toBe('The weight check gives the press counter (its interval is by count too) (TB11-COUNTER; PR-29)');
    expect(w.rec(group('L', 99)).refused).toBe('The press counter reads 99, below the 100 already recorded (TB11-COUNTER-BACK; DI-28, PR-29)');
    expect(w.rec(group('L', 100)).data).toMatchObject({ counter: 100 });
    expect(w.rec(group('R', 1100)).data).not.toHaveProperty('missed');
    // R's last check is at 1100: 2101 is 1001 tablets later; L's last check is at 100: 1100 later is missed by count.
    expect(w.rec(group('R', 2101)).data).toMatchObject({ missed: [{ stream: 'R', test: 'WEIGHT', by: 'COUNT' }] });
    const r = w.rec(group('L', 2101));
    expect(r.data?.['missed']).toEqual([{ stream: 'L', test: 'WEIGHT', by: 'COUNT' }]);
    expect(r.exceptions?.map((x) => [x.type, x.title, x.item])).toEqual([
      ['IPC_CHECK_MISSED', 'Missed in-process check at p@: weight of stream L (by press count); the output since the last passing check is held and the steps after it wait for a deviation', 'L'],
    ]);
    // Exactly the interval by count is not missed.
    expect(w.rec(group('L', 3101)).data).not.toHaveProperty('missed');
  });

  it('[IN-35][PR-29] missed by time and by count in one entry are listed once each, with the time slot first and its title', () => {
    const w = new World({ ...runCfg, streams: [{ id: 'L' }] });
    w.rec({ kind: 'RUN_START', press: 'P-1', counter: 0 });
    w.now = at(31n);
    const r = w.rec(group('L', 5000));
    // The weight slot by time (not again by count), and the start sweep never made.
    expect(r.data?.['missed']).toEqual([
      { stream: 'L', test: 'WEIGHT', by: 'TIME', dueUs: at(25n).toString() },
      { stream: 'L', test: 'SWEEP', by: 'TIME', dueUs: T.toString() },
    ]);
    expect(r.exceptions?.filter((x) => x.type === 'IPC_CHECK_MISSED').map((x) => [x.title, x.item])).toEqual([
      ['Missed in-process check at p@: weight of stream L, sweep of stream L; the output since the last passing check is held and the steps after it wait for a deviation', 'L'],
    ]);
  });

  it('[IN-35][DI-32] the station sweep: every station once (1 to n), exactly the swept parameters, each judged against its limits (kp read as N); the worst decides', () => {
    const w = new World(runCfg);
    expect(new World({ ...runCfg, sweep: undefined }).rec({ kind: 'RUN_START', press: 'P' }).data).toBeDefined();
    w.rec({ kind: 'RUN_START', press: 'P-1', counter: 0 });
    const ok = [station(1, '250', '5'), station(2, '250', '5'), station(3, '250', '5'), station(4, '250', '5')];
    expect(w.rec(sweep('L', ok.slice(0, 3))).refused).toBe('The station sweep gives each of the 4 stations exactly one result (3 given); it cannot be recorded incomplete (TB11-SWEEP-INCOMPLETE; IN-35)');
    expect(w.rec(sweep('L', [...ok.slice(0, 3), station(5, '250', '5')])).refused).toMatch(/TB11-SWEEP-INCOMPLETE/);
    expect(w.rec(sweep('L', [...ok.slice(0, 3), station(0, '250', '5')])).refused).toMatch(/TB11-SWEEP-INCOMPLETE/);
    expect(w.rec(sweep('L', [...ok.slice(0, 3), station(1.5, '250', '5')])).refused).toMatch(/TB11-SWEEP-INCOMPLETE/);
    expect(w.rec(sweep('L', [...ok.slice(0, 3), { station: 4, weight: '250' }])).refused).toBe('Each station gives exactly the parameters the MBR sweeps (weight, hardness) (TB11-SWEEP-PARAMETERS; IN-35, DI-32)');
    expect(w.rec(sweep('L', [...ok.slice(0, 3), { station: 4, weight: '250', hardness: '5', thickness: '3' }])).refused).toMatch(/TB11-SWEEP-PARAMETERS/);
    expect(w.rec({ ...sweep('L', ok), readings: [R1] }).refused).toMatch(/one claimed reading per value \(8\)/);
    // 4 kp = 39.2266 N, below 40 N: FAIL; 5 kp = 49.03 N passes. Weight 256 is outside the alert band.
    const r = w.rec(sweep('L', [station(1, '250', '5'), station(2, '256', '5'), station(3, '250', '4'), station(4, '244', '5')]));
    expect(r.data?.['evaluation']).toEqual({
      weight: { min: '244', max: '256', outside: 0, outsideAlert: 2, result: 'ALERT' },
      hardness: { min: '39.2266', max: '49.03325', outside: 1, outsideAlert: 1, result: 'FAIL' },
    });
    expect(r.data?.['result']).toBe('FAIL');
    expect(r.exceptions?.map((x) => [x.type, x.item])).toEqual([['IPC_CHECK_FAILED', 'L']]);
    const n = new World({ ...runCfg, sweep: { stations: 2, hardness: { unit: 'N', individual: { action: { min: '40' } } } } });
    n.rec({ kind: 'RUN_START', press: 'P-1', counter: 0 });
    expect(n.rec({ kind: 'STATION_SWEEP', instrument: 'BAL', capture: 'DEVICE', stream: 'L', readings: [R1, R1], stations: [{ station: 2, hardness: '45' }, { station: 1, hardness: '41' }] }).data).toMatchObject({
      evaluation: { hardness: { min: '41', max: '45', outside: 0, outsideAlert: 0, result: 'PASS' } },
      result: 'PASS',
    });
    const none = new World({ ...runCfg, sweep: undefined });
    none.rec({ kind: 'RUN_START', press: 'P-1' });
    expect(none.rec(sweep('L', ok)).refused).toBe('p@ has no station sweep in its MBR (TB11-NO-SWEEP; IN-35)');
  });

  it('[IN-35][PR-29] by count: from the slot\'s latest check with a counter (else the run start); a slot missed by time elsewhere does not hide it; entries other than checks carry the missed exception (mutation follow-up)', () => {
    const w = new World({ ...runCfg, streams: [{ id: 'L' }] });
    w.rec({ kind: 'RUN_START', press: 'P-1', counter: 0 });
    expect(w.rec(group('L', 600)).data).not.toHaveProperty('missed');
    expect(w.rec(group('L', 1500)).data).not.toHaveProperty('missed');
    w.now = at(6n);
    const r = w.rec(group('L', 2600));
    expect(r.data?.['missed']).toEqual([
      { stream: 'L', test: 'SWEEP', by: 'TIME', dueUs: T.toString() },
      { stream: 'L', test: 'WEIGHT', by: 'COUNT' },
    ]);
    const c = new World({ ...runCfg, streams: [{ id: 'L' }], sweep: undefined, process: 'OTHER' });
    c.rec({ kind: 'RUN_START', press: 'P-1', counter: 0 });
    expect(c.rec({ kind: 'CHANGE', change: 'TOOLING' })).toStrictEqual({ data: { change: 'TOOLING', recordedBy: 'OP1' } });
    c.now = at(31n);
    const late = c.rec({ kind: 'CHANGE', change: 'SETTING' });
    expect(late.data?.['missed']).toHaveLength(1);
    expect(late.exceptions?.map((x) => x.type)).toEqual(['IPC_CHECK_MISSED']);
  });

  it('[INV-41][PR-29] PERFORMED waits while a disintegration run of the step is still running (mutation follow-up)', () => {
    const before = TB11.handler?.beforePerform?.bind(TB11.handler) as unknown as (v: blocks.HandlerView) => { code: string }[];
    const w = new World({ streams: [{ id: 'L' }], process: 'OTHER', plan: [{ test: 'DISINTEGRATION', every: { value: '60', unit: 'min' }, qrmRef: 'Q' }], grace: { value: '5', unit: 'min' }, disintegration: { tabletType: 'UNCOATED' } });
    w.rec({ kind: 'RUN_START', press: 'P-1' });
    w.rec({ kind: 'RUN_END' });
    const s = w.rec({ kind: 'DT_START', instrument: 'DT-1', capture: 'MANUAL', bathTemperature: '37.0', stage: 'MAIN', stream: 'L' });
    expect(s.refused).toBeUndefined();
    expect(before(w.view()).map((p) => p.code)).toEqual(['TB11-PENDING']);
    w.now = at(1n);
    w.rec({ kind: 'DT_END', capture: 'MANUAL', units: Array.from({ length: 6 }, () => ({ disintegrated: true })) });
    expect(before(w.view())).toEqual([]);
  });

  it('[PR-29][IN-35][INV-41] PERFORMED waits for the run\'s end, each stream\'s sweep, an end-of-run check of every planned slot, and every compendial stage', () => {
    const before = TB11.handler?.beforePerform?.bind(TB11.handler) as unknown as (v: blocks.HandlerView) => { message: string }[];
    const w = new World({ ...runCfg, plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' }, qrmRef: 'Q' }] });
    w.rec({ kind: 'RUN_START', press: 'P-1' });
    expect(before(w.view()).map((p) => p.message)).toEqual(['The run of p@ has not ended (TB11-RUNNING; PR-29, IN-35)']);
    w.now = at(1n);
    w.rec(group('L'));
    w.now = at(2n);
    w.rec({ kind: 'RUN_END' });
    expect(before(w.view()).map((p) => p.message)).toEqual([
      'Stream L, R of p@ has no station sweep (TB11-NO-SWEEP; IN-35)',
      'p@ has no end-of-run check of weight (stream L), weight (stream R) (TB11-END-CHECK; PR-29, IN-35)',
    ]);
    w.rec(group('L'));
    expect(before(w.view()).map((p) => p.message)).toContain('p@ has no end-of-run check of weight (stream R) (TB11-END-CHECK; PR-29, IN-35)');
    // A run that is not compression has no sweep to wait for.
    const other = new World({ ...runCfg, process: 'OTHER', plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' }, qrmRef: 'Q' }] });
    other.rec({ kind: 'RUN_START', press: 'P-1' });
    other.rec({ kind: 'RUN_END' });
    other.rec(group('L'));
    other.rec(group('R'));
    expect(before(other.view())).toEqual([]);
  });
});

describe('TB-11 definition checks', () => {
  const P = (config: Json): string[] => {
    const check = TB11.checkConfig?.bind(TB11) as unknown as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string; controls: readonly string[] }[];
    return check({ id: 'p' } as flow.PhaseNode, config, { header: { marketSet: ['IN'] } } as flow.MbrContent).map((p) => `${p.code} [${p.controls.join(',')}] ${p.message}`);
  };
  const ok: Json = { ...runCfg, plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' }, qrmRef: 'Q' }] };

  it('[IN-35][PR-29][PR-07] streams and tests once each, a grace and intervals above zero, a QRM reference and a configuration per planned test', () => {
    expect(P(ok)).toEqual([]);
    expect(P({ ...ok, streams: [{ id: 'L' }, { id: 'L' }] })).toEqual(['TB11-STREAMS [PR-29] IPC scheduler p lists a stream twice']);
    expect(P({ ...ok, plan: [...(ok['plan'] as Json[]), { test: 'WEIGHT', every: { value: '25', unit: 'min' }, qrmRef: 'Q' }] })).toEqual(['TB11-PLAN [PR-29] IPC scheduler p plans a test twice']);
    expect(P({ ...ok, grace: { value: '0', unit: 'min' } })).toEqual(['TB11-GRACE [IN-35,PR-29] IPC scheduler p has no grace time above zero']);
    expect(P({ ...ok, grace: undefined })).toEqual([
      'TB11-GRACE [IN-35,PR-29] IPC scheduler p has no grace time above zero',
      'TB11-CEILING [IN-35] IPC scheduler p: in compression a sample is checked no more than 30 min after the previous one; the most frequent test plus the grace must not exceed it (IN-35 (c))',
    ]);
    expect(P({ ...ok, plan: [{ test: 'WEIGHT', every: { value: '0', unit: 'min' }, qrmRef: 'Q' }] })).toEqual(['TB11-PLAN [PR-29] IPC scheduler p: WEIGHT has no interval above zero']);
    expect(P({ ...ok, plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' } }] })).toEqual(['TB11-QRM [PR-07] IPC scheduler p: WEIGHT names no risk assessment for its frequency']);
    expect(P({ ...ok, weight: undefined })).toEqual(['TB11-TEST-CONFIG [PR-29] IPC scheduler p plans WEIGHT without its configuration (weight)']);
    expect(P({ ...ok, weight: { mode: 'GROUP', tabletType: 'UNCOATED' } })[0]).toBe('TB12-CONFIG [PR-29,IN-34] IPC scheduler p weight: mode GROUP needs targetWeightMg');
  });

  it('[IN-35] the restart threshold is 0 to 60 min; in compression the most frequent test plus the grace is at most 30 min (equal allowed) and the run has a station sweep examining a parameter within ordered limits', () => {
    expect(P({ ...ok, restartAfter: { value: '60', unit: 'min' } })).toEqual([]);
    expect(P({ ...ok, restartAfter: { value: '0', unit: 'min' } })).toEqual([]);
    expect(P({ ...ok, restartAfter: { value: '61', unit: 'min' } })).toEqual(['TB11-RESTART [IN-35] IPC scheduler p: the restart threshold is 0 to 60 min']);
    expect(P({ ...ok, grace: { value: '5', unit: 'min' }, plan: [{ test: 'WEIGHT', every: { value: '25', unit: 'min' }, qrmRef: 'Q' }, { test: 'FRIABILITY', every: { value: '120', unit: 'min' }, qrmRef: 'Q' }], friability: { tabletType: 'UNCOATED' } })).toEqual([]);
    expect(P({ ...ok, grace: { value: '5', unit: 'min', extra: 1 }, plan: [{ test: 'WEIGHT', every: { value: '25.000001', unit: 'min' }, qrmRef: 'Q' }] })[0]).toMatch(/^TB11-CEILING/);
    expect(P({ ...ok, sweep: undefined })).toEqual(['TB11-NO-SWEEP [IN-35] IPC scheduler p: a compression run starts with a station sweep of every stream (IN-35 (b))']);
    expect(P({ ...ok, process: 'OTHER', sweep: undefined, grace: { value: '60', unit: 'min' } })).toEqual([]);
    expect(P({ ...ok, sweep: { stations: 4 } })).toEqual(['TB11-SWEEP-PARAMETERS [IN-35] IPC scheduler p: the station sweep examines no parameter']);
    expect(P({ ...ok, sweep: { stations: 4, weight: { individual: { action: { min: '260', max: '240' } } } } })).toEqual(['TB11-SWEEP-PARAMETERS [IN-35] IPC scheduler p sweep weight has a lower limit above its upper limit']);
  });
});
