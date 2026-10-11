/**
 * TB-22@1 blister or strip leak test (IN-38, PR-29) at its edges: when a track's test falls due (the run's start, its
 * own tests and missed markings, the trigger events, the run's end), when it is missed (beyond the grace, strictly),
 * the run's entries, the validated method's ranges at their ends, leaking units, the machine counter and the test by
 * count, PERFORMED and the definition checks. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { leakDue, leakOverdue, SINGLE_TRACK, TB22, tracksOf } from '../../../src/blocks/tb-22.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint };
const T = 1_800_000_000_000_000n;
const MIN = 60_000_000n;
const CFG = (TB22.goldenFixture as blocks.BlockGoldenFixture).phase.config as Json;
const e = (kind: string, atMin: bigint, data: Json = {}, plus = 0n): E => ({ id: `${kind}${atMin}`, kind, data, recordedAt: T + atMin * MIN + plus });
const due = (entries: E[], track = 'T1', cfg: Json = CFG) => {
  const d = leakDue(entries, cfg, track);
  return d === undefined ? 'none' : `${String((d - T) / MIN)}m${(d - T) % MIN === 0n ? '' : `+${String((d - T) % MIN)}`}`;
};
const START = e('RUN_START', 0n);

describe('TB-22 when a leak test falls due', () => {
  it('[IN-38][PR-29] at the run\'s start, then one interval after the track\'s own latest test or missed marking; never before the start', () => {
    expect(due([])).toBe('none');
    expect(due([START], 'T1', { ...CFG, every: undefined })).toBe('none');
    expect(due([START])).toBe('0m');
    expect(due([START, e('LEAK_TEST', 2n, { track: 'T1' })])).toBe('32m');
    expect(due([START, e('LEAK_TEST', 2n, { track: 'T2' })])).toBe('0m');
    expect(due([START, e('LEAK_TEST', 5n, { track: 'T1' }), e('LEAK_TEST', 3n, { track: 'T1' })])).toBe('35m');
    expect(due([START, e('EVENT', 40n, { missed: [{ stream: 'T1', test: 'LEAK', by: 'TIME' }] })])).toBe('70m');
    expect(due([START, e('EVENT', 40n, { missed: [{ stream: 'T2', test: 'LEAK', by: 'TIME' }] })])).toBe('0m');
  });

  it('[IN-38][PR-29] a trigger event after the last test makes it due at once (only the MBR\'s triggers, D all); the run\'s end makes it due, and an end-of-run test closes the track', () => {
    const tested = [START, e('LEAK_TEST', 1n, { track: 'T1' })];
    expect(due([...tested, e('EVENT', 10n, { event: 'REEL_CHANGE' })])).toBe('10m');
    expect(due([...tested, e('EVENT', 40n, { event: 'REEL_CHANGE' })])).toBe('31m');
    expect(due([START, e('EVENT', 0n, { event: 'RESTART' }), e('LEAK_TEST', 1n, { track: 'T1' })])).toBe('31m');
    expect(due([...tested, e('EVENT', 10n, { event: 'ADJUSTMENT' })], 'T1', { ...CFG, triggers: ['RESTART'] })).toBe('31m');
    expect(due([...tested, e('EVENT', 10n, { event: 'RESTART' })], 'T1', { ...CFG, triggers: ['RESTART'] })).toBe('10m');
    expect(due([...tested, e('RUN_END', 20n)])).toBe('20m');
    expect(due([...tested, e('RUN_END', 40n)])).toBe('31m');
    expect(due([...tested, e('RUN_END', 20n), e('LEAK_TEST', 21n, { track: 'T1' })])).toBe('none');
    expect(due([...tested, e('RUN_END', 20n), e('LEAK_TEST', 20n, { track: 'T1' })])).toBe('none');
    expect(due([...tested, e('RUN_END', 20n)], 'T2')).toBe('0m');
  });

  it('[IN-38][PR-29] a test is missed strictly beyond its due time plus the grace, track by track', () => {
    expect(leakOverdue([START], CFG, T + 5n * MIN)).toEqual([]);
    expect(leakOverdue([START], CFG, T + 5n * MIN + 1n)).toEqual([
      { stream: 'T1', test: 'LEAK', by: 'TIME', dueUs: T.toString() },
      { stream: 'T2', test: 'LEAK', by: 'TIME', dueUs: T.toString() },
    ]);
    expect(leakOverdue([START], { ...CFG, grace: undefined }, T + 1n).map((m) => m.stream)).toEqual(['T1', 'T2']);
    expect(tracksOf({})).toEqual([SINGLE_TRACK]);
    expect(tracksOf({ tracks: ['A', 3, 'B'] })).toEqual(['A', 'B']);
  });
});

class World {
  entries: E[] = [];
  now = T;
  constructor(readonly config: Json = CFG) {}
  view(): blocks.HandlerView {
    return { config: this.config, stepKey: 'p@', nowUs: this.now, entries: (kind?: string) => this.entries.filter((x) => kind === undefined || x.kind === kind), actor: { id: 'OP1' } } as unknown as blocks.HandlerView;
  }
  rec(entry: Json & { kind: string }): { refused?: string; data?: Json; exceptions?: Json[]; verificationRequired?: boolean } {
    const accept = TB22.handler?.acceptEntry as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[]; verificationRequired?: boolean };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: this.now });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}), ...(r.verificationRequired ? { verificationRequired: true } : {}) };
  }
  before(): string[] {
    return (TB22.handler?.beforePerform as (v: blocks.HandlerView) => { message: string }[])(this.view()).map((p) => p.message);
  }
}
const test = (track: string, extra: Json = {}) => ({ kind: 'LEAK_TEST', track, tested: '10', vacuum: '70', holdSeconds: '45', leaking: '0', ...extra });

describe('TB-22 entries', () => {
  it('[PR-29] the run starts once (with its counter), only its entries, nothing before the start, only end-of-run tests after the end', () => {
    const w = new World();
    expect(w.rec({ kind: 'OTHER' }).refused).toBe('OTHER is not an entry of a leak-test step (TB22-ENTRY; PR-29)');
    expect(w.rec(test('T1')).refused).toBe('p@ has not started its run (TB22-NOT-STARTED; PR-29)');
    expect(w.rec({ kind: 'RUN_START', machine: 'M', counter: 5 }).data).toStrictEqual({ machine: 'M', counter: 5, startedBy: 'OP1' });
    expect(w.rec({ kind: 'RUN_START', machine: 'M' }).refused).toBe('p@ has started its run already; a new run is a new step (TB22-TWICE; PR-29)');
    expect(w.rec({ kind: 'EVENT', event: 'RESTART', counter: 4 }).refused).toBe('The machine counter reads 4, below the 5 already recorded (TB22-COUNTER-BACK; PR-29)');
    expect(w.rec({ kind: 'EVENT', event: 'RESTART', counter: 5 }).data).toStrictEqual({ event: 'RESTART', counter: 5, recordedBy: 'OP1' });
    expect(w.rec({ kind: 'EVENT', event: 'RESTART' }).data).toStrictEqual({ event: 'RESTART', recordedBy: 'OP1' });
    expect(w.rec({ kind: 'RUN_END' }).data).toStrictEqual({ endedBy: 'OP1' });
    expect(w.rec({ kind: 'EVENT', event: 'RESTART' }).refused).toBe('The run of p@ has ended (TB22-ENDED; PR-29)');
    expect(w.rec({ kind: 'RUN_END' }).refused).toBe('The run of p@ has ended (TB22-ENDED; PR-29)');
    expect(w.rec(test('T1')).data).toMatchObject({ track: 'T1', result: 'PASS' });
    expect(new World().rec({ kind: 'RUN_START', machine: 'M' }).data).toStrictEqual({ machine: 'M', startedBy: 'OP1' });
  });

  it('[PR-29][IN-38] a test is of a machine track, of the MBR\'s units, within the method\'s vacuum and hold ranges (ends allowed); leaking units fail and hold; it needs a second person', () => {
    const w = new World();
    w.rec({ kind: 'RUN_START', machine: 'M' });
    expect(w.rec(test('T3')).refused).toBe('T3 is not a track of the machine (T1, T2) (TB22-TRACK; PR-29)');
    expect(w.rec(test('T1', { tested: '9' })).refused).toBe('A leak test takes the 10 units per track the MBR sets, not 9 (TB22-SAMPLE; PR-29)');
    expect(w.rec(test('T1', { leaking: '11' })).refused).toBe('More leaking units (11) than tested (10) (TB22-LEAKING; PR-29)');
    const out = "The test ran at 59.9 kPa for 45 s, outside the validated method's vacuum and hold-time ranges: it is no test (TB22-PARAMETERS; PR-29, IN-38)";
    expect(w.rec(test('T1', { vacuum: '59.9' })).refused).toBe(out);
    expect(w.rec(test('T1', { vacuum: '80.1' })).refused).toMatch(/TB22-PARAMETERS/);
    expect(w.rec(test('T1', { holdSeconds: '29' })).refused).toMatch(/TB22-PARAMETERS/);
    expect(w.rec(test('T1', { holdSeconds: '61' })).refused).toMatch(/TB22-PARAMETERS/);
    expect(w.rec(test('T1', { vacuum: '60', holdSeconds: '30' }))).toStrictEqual({ data: { track: 'T1', tested: '10', vacuum: '60', holdSeconds: '30', leaking: '0', result: 'PASS', testedBy: 'OP1' }, verificationRequired: true });
    expect(w.rec(test('T2', { vacuum: '80', holdSeconds: '60', leaking: '10' })).exceptions?.map((x) => [x['type'], x['title'], x['category']])).toEqual([
      ['LEAK_TEST_FAILED', "A leak test of track T2 found 10 leaking units; the machine's output since the track's last passing test is held at p@: the steps after it wait for a deviation", 'OUT_OF_LIMIT'],
    ]);
    const open = new World({ ...CFG, vacuum: { min: '60' }, hold: {} });
    open.rec({ kind: 'RUN_START', machine: 'M' });
    expect(open.rec(test('T1', { vacuum: '999', holdSeconds: '1' })).data?.['result']).toBe('PASS');
  });

  it('[IN-38][PR-29] a missed test is listed with its track and held (by time, and by count where the interval is by count too)', () => {
    const w = new World({ ...CFG, everyCount: '1000' });
    w.rec({ kind: 'RUN_START', machine: 'M', counter: 0 });
    expect(w.rec(test('T1')).refused).toBe('The leak test gives the machine counter (its interval is by count too) (TB22-COUNTER; PR-29)');
    expect(w.rec(test('T1', { counter: 0 })).data).toMatchObject({ counter: 0 });
    expect(w.rec(test('T2', { counter: 1000 })).data).not.toHaveProperty('missed');
    const r = w.rec(test('T1', { counter: 1001 }));
    expect(r.data?.['missed']).toEqual([{ stream: 'T1', test: 'LEAK', by: 'COUNT' }]);
    expect(r.exceptions?.map((x) => [x['type'], x['title'], x['category']])).toEqual([
      ['LEAK_TEST_MISSED', "A scheduled leak test was missed (track T1 by count); the machine's output since the track's last passing test is held at p@: the steps after it wait for a deviation", 'TIME_LIMIT'],
    ]);
    w.now = T + 40n * MIN;
    const late = w.rec({ kind: 'EVENT', event: 'ADJUSTMENT' });
    expect(late.data?.['missed']).toEqual([
      { stream: 'T1', test: 'LEAK', by: 'TIME', dueUs: (T + 30n * MIN).toString() },
      { stream: 'T2', test: 'LEAK', by: 'TIME', dueUs: (T + 30n * MIN).toString() },
    ]);
    expect(late.exceptions?.[0]?.['title']).toBe("A scheduled leak test was missed (track T1, track T2); the machine's output since the track's last passing test is held at p@: the steps after it wait for a deviation");
    // A failed test that is also late: the missed one first.
    w.now = T + 80n * MIN;
    expect(w.rec(test('T1', { counter: 1500, leaking: '1' })).exceptions?.map((x) => x['type'])).toEqual(['LEAK_TEST_MISSED', 'LEAK_TEST_FAILED']);
  });

  it('[PR-29][IN-38] PERFORMED needs the run ended and an end-of-run test of every track (at the end allowed)', () => {
    const w = new World();
    w.rec({ kind: 'RUN_START', machine: 'M' });
    expect(w.before()).toEqual(['The run of p@ has not ended (TB22-RUNNING; PR-29)']);
    w.rec(test('T1'));
    w.now += MIN;
    w.rec({ kind: 'RUN_END' });
    expect(w.before()).toEqual(['Track T1 of p@ has no end-of-run leak test (TB22-END-TEST; PR-29, IN-38)', 'Track T2 of p@ has no end-of-run leak test (TB22-END-TEST; PR-29, IN-38)']);
    w.rec(test('T1'));
    w.rec(test('T2'));
    expect(w.before()).toEqual([]);
  });
});

describe('TB-22 definition checks', () => {
  const P = (config: Json): string[] => {
    const check = TB22.checkConfig as (p: flow.PhaseNode, c: Json, m: flow.MbrContent) => { code: string; message: string; controls: readonly string[] }[];
    return check({ id: 'p' } as flow.PhaseNode, config, {} as flow.MbrContent).map((x) => `${x.code} [${x.controls.join(',')}] ${x.message}`);
  };
  it('[PR-29][IN-38][PR-07] a positive interval and grace, a QRM reference, ordered method ranges with both ends, each track once and none LINE', () => {
    expect(P(CFG)).toEqual([]);
    const schedule = 'TB22-SCHEDULE [PR-29,IN-38] Leak-test step p has no test interval and grace above zero';
    expect(P({ ...CFG, every: undefined })).toEqual([schedule]);
    expect(P({ ...CFG, every: { value: '0', unit: 'min' } })).toEqual([schedule]);
    expect(P({ ...CFG, grace: undefined })).toEqual([schedule]);
    expect(P({ ...CFG, grace: { value: '0', unit: 'min' } })).toEqual([schedule]);
    expect(P({ ...CFG, qrmRef: undefined })).toEqual(['TB22-QRM [PR-07] Leak-test step p names no risk assessment for its test frequency']);
    expect(P({ ...CFG, vacuum: { min: '80', max: '60' } })).toEqual(['TB22-METHOD [PR-29] Leak-test step p: the validated vacuum range has a lower and an upper limit, in order']);
    expect(P({ ...CFG, vacuum: { min: '60', max: '60' } })).toEqual([]);
    expect(P({ ...CFG, hold: { max: '60' } })).toEqual(['TB22-METHOD [PR-29] Leak-test step p: the validated hold range has a lower and an upper limit, in order']);
    expect(P({ ...CFG, hold: { min: '60' } })).toEqual(['TB22-METHOD [PR-29] Leak-test step p: the validated hold range has a lower and an upper limit, in order']);
    expect(P({ ...CFG, tracks: ['T1', 'T1'] })).toEqual(["TB22-TRACKS [PR-29] Leak-test step p names each track once, and none LINE (the blister run's series)"]);
    expect(P({ ...CFG, tracks: ['LINE'] })).toEqual(["TB22-TRACKS [PR-29] Leak-test step p names each track once, and none LINE (the blister run's series)"]);
    expect(P({ ...CFG, tracks: undefined })).toEqual([]);
  });
});

describe('TB-22 schedule details (mutation follow-up)', () => {
  it('[IN-38][PR-29] the run start is found wherever it stands; only the track\'s own tests count; a trigger at the instant of the test does not make it due', () => {
    expect(due([e('EVENT', 0n, { event: 'X' }), e('RUN_START', 5n)])).toBe('5m');
    expect(due([START, e('EVENT', 2n, { track: 'T1', event: 'X' })])).toBe('0m');
    expect(due([START, e('LEAK_TEST', 2n, { track: 'T2', event: 'REEL_CHANGE' }), e('LEAK_TEST', 1n, { track: 'T1' })])).toBe('31m');
    expect(due([START, e('LEAK_TEST', 1n, { track: 'T1' }), e('EVENT', 1n, { event: 'REEL_CHANGE' })])).toBe('31m');
  });

  it('[IN-38][PR-29] by count: from the track\'s latest test with a counter (else the run start), a difference not a sum, once per track even when also late; a start without counter starts the count at the first test', () => {
    const w = new World({ ...CFG, everyCount: '1000' });
    w.rec({ kind: 'RUN_START', machine: 'M', counter: 0 });
    expect(w.rec(test('T1', { counter: 400 })).data).not.toHaveProperty('missed');
    expect(w.rec(test('T1', { counter: 900 })).data).not.toHaveProperty('missed');
    expect(w.rec(test('T1', { counter: 1850 })).data).not.toHaveProperty('missed');
    expect(w.rec(test('T2', { counter: 1850 })).data?.['missed']).toEqual([{ stream: 'T2', test: 'LEAK', by: 'COUNT' }]);
    w.now = T + 40n * MIN;
    const late = w.rec(test('T1', { counter: 5000 }));
    expect(late.data?.['missed']).toEqual([
      { stream: 'T1', test: 'LEAK', by: 'TIME', dueUs: (T + 30n * MIN).toString() },
      { stream: 'T2', test: 'LEAK', by: 'TIME', dueUs: (T + 30n * MIN).toString() },
    ]);
    const bare = new World({ ...CFG, everyCount: '1000' });
    bare.rec({ kind: 'RUN_START', machine: 'M' });
    expect(bare.rec(test('T1', { counter: 5000 })).data).not.toHaveProperty('missed');
    const timeOnly = new World();
    timeOnly.rec({ kind: 'RUN_START', machine: 'M', counter: 0 });
    timeOnly.rec(test('T1', { counter: 10 }));
    expect(timeOnly.rec(test('T1', { counter: 99_999 })).data).not.toHaveProperty('missed');
  });

  it('[IN-38][PR-29] method ranges read only decimal text; PERFORMED names the very track without an end-of-run test', () => {
    const w = new World({ ...CFG, vacuum: { min: 60, max: '80' } });
    w.rec({ kind: 'RUN_START', machine: 'M' });
    expect(w.rec(test('T1', { vacuum: '50' })).data?.['result']).toBe('PASS');
    const h = new World({ ...CFG, hold: { min: '30', max: 60 } });
    h.rec({ kind: 'RUN_START', machine: 'M' });
    expect(h.rec(test('T1', { holdSeconds: '600' })).data?.['result']).toBe('PASS');
    const p = new World();
    p.rec({ kind: 'RUN_START', machine: 'M' });
    p.rec({ kind: 'RUN_END' });
    p.rec(test('T1'));
    expect(p.before()).toEqual(['Track T2 of p@ has no end-of-run leak test (TB22-END-TEST; PR-29, IN-38)']);
  });
});
