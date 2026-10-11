/**
 * TB-15@1 disintegration (tablets spec E.5) at its edges, through its exported handlers with a minimal view: the
 * stages by tablet type, the bath temperature at its ends, the runs per stream, the units and readings of an end, the
 * time limit at its boundary, retest staging (fail counts and the pass total at their ends) and the gastro-resistant
 * acid and buffer stages. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks } from '@ebmr/recipe-core/pure';
import { acceptDtEnd, acceptDtStart, dtConfigProblems, dtNominal, dtPending, pendingBuffers, pendingRetests, TB15 } from '../../../src/blocks/tb-15.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint };
const T0 = 1_800_000_000_000_000n;
const S = 1_000_000n;
const READING = '00000000-0000-4000-8000-000000000401';

class World {
  entries: E[] = [];
  now = T0;
  constructor(
    readonly config: Json = { tabletType: 'UNCOATED' },
    readonly type = 'TB-15',
  ) {}
  view(): blocks.HandlerView {
    return {
      phase: { block: { type: this.type, version: '1' } },
      config: this.config,
      stepKey: 'p@',
      nowUs: this.now,
      entries: (kind?: string) => this.entries.filter((e) => kind === undefined || e.kind === kind),
      batch: { marketSet: ['IN'] },
      actor: { id: 'OP1' },
    } as unknown as blocks.HandlerView;
  }
  /** Accepts `entry` (start or end) and records it, or returns the refusal text. */
  rec(entry: Json & { kind: string }): string | Json {
    const r = entry.kind === 'DT_START' ? acceptDtStart(this.view(), entry) : acceptDtEnd(this.view(), entry);
    if (!r.ok) return r.problems.map((p) => p.message).join(' | ');
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.t.data, recordedAt: this.now });
    return r.t.data;
  }
  last(): E {
    return this.entries.at(-1) as E;
  }
}
const start = (extra: Json = {}): Json & { kind: string } => ({ kind: 'DT_START', instrument: 'DT-1', capture: 'DEVICE', readings: [READING], bathTemperature: '37.0', stage: 'MAIN', ...extra });
const unitsOf = (flags: boolean[], seconds?: string[]) => flags.map((d, i) => ({ disintegrated: d, ...(seconds ? { seconds: seconds[i] } : {}) }));
const end = (flags: boolean[], extra: Json = {}): Json & { kind: string } => ({ kind: 'DT_END', capture: 'MANUAL', units: unitsOf(flags), ...extra });
const all = (k: number, v = true) => Array.from({ length: k }, () => v);

describe('TB-15 starting a run', () => {
  it('[PR-29][IN-35] the stages follow the tablet type; the bath is within the rule set\'s temperatures (ends allowed); the start records its limits', () => {
    const w = new World();
    expect(w.rec(start({ stage: 'ACID' }))).toBe('Only gastro-resistant tablets run acid and buffer stages (TB15-STAGE; PR-29)');
    expect(new World({ tabletType: 'GASTRO_RESISTANT' }).rec(start())).toBe('Gastro-resistant tablets run an acid stage and then a buffer stage (TB15-STAGE; PR-29)');
    expect(w.rec(start({ bathTemperature: '34.9' }))).toBe('The bath is at 34.9 degC; the run starts only between 35 and 39 degC (TB15-BATH-TEMP; PR-29, IN-35)');
    expect(w.rec(start({ bathTemperature: '39.1' }))).toBe('The bath is at 39.1 degC; the run starts only between 35 and 39 degC (TB15-BATH-TEMP; PR-29, IN-35)');
    expect(new World().rec(start({ bathTemperature: '35' }))).toMatchObject({ stage: 'MAIN' });
    expect(w.rec(start({ bathTemperature: '39' }))).toStrictEqual({
      instrument: 'DT-1', capture: 'DEVICE', readings: [READING], sampledAtUs: T0.toString(), late: false, recordedBy: 'OP1',
      bathTemperature: '39', stage: 'MAIN', ruleSets: [{ code: 'IP-DISINTEGRATION', version: 1 }], limitSeconds: '900', temperature: { min: '35', max: '39' }, units: 6,
    });
    expect(w.rec(start())).toBe('A disintegration run of this stream is still running; end it first (TB15-RUNNING; PR-29, DI-29)');
    expect(new World({ tabletType: 'UNCOATED', timeLimit: { value: '10', unit: 'min' } }).rec(start())).toMatchObject({ limitSeconds: '600' });
  });

  it('[PR-29][DI-10] no rule set for the tablet type, or no time limit for the stage, refuses the start', () => {
    expect(new World({ tabletType: 'CHEWABLE' }).rec(start())).toMatch(/^No compendial rule set covers CHEWABLE tablets/);
  });
});

describe('TB-15 ending a run', () => {
  it('[PR-29][DI-32] an end names its run when several run; it tests the started units; instrument ends carry times and readings, hand ends neither', () => {
    const t11 = new World({ streams: [{ id: 'S1' }, { id: 'S2' }], disintegration: { tabletType: 'UNCOATED' } }, 'TB-11');
    t11.rec(start({ stream: 'S1' }));
    t11.rec(start({ stream: 'S2' }));
    expect(t11.rec(end(all(6)))).toBe('p@ has 2 runs running: name the one that ends (TB15-WHICH-START; PR-29)');
    expect(t11.rec(end(all(6), { start: 'E9' }))).toBe('E9 is not a running disintegration of p@ (TB15-NOT-STARTED; PR-29)');
    expect(t11.rec(end(all(6), { start: 'E2' }))).toMatchObject({ start: 'E2', stream: 'S2', result: 'PASS' });
    expect(t11.rec(end(all(6)))).toMatchObject({ start: 'E1', stream: 'S1' });
    const w = new World();
    expect(w.rec(end(all(6)))).toBe('No run is not a running disintegration of p@ (TB15-NOT-STARTED; PR-29)');
    w.rec(start());
    expect(w.rec(end(all(5)))).toBe('This run tests 6 units, not 5 (TB15-UNITS; PR-29, IN-35)');
    expect(w.rec(end(all(6), { capture: 'DEVICE', readings: [READING] }))).toBe('A run read from the instrument gives each unit its time and one claimed reading per unit (TB15-READINGS; DI-32)');
    const timed = { capture: 'DEVICE', units: unitsOf(all(6), ['1', '2', '3', '4', '5', '6']) };
    expect(w.rec(end(all(6), { ...timed, readings: [READING] }))).toMatch(/TB15-READINGS/);
    expect(w.rec(end(all(6), { capture: 'DEVICE', readings: all(6).map(() => READING) }))).toMatch(/TB15-READINGS/);
    expect(w.rec(end(all(6), { readings: [] }))).toBe('Units observed by hand carry no times or readings (TB15-READINGS; DI-32)');
    expect(w.rec(end(all(6), { units: unitsOf(all(6), ['1', '1', '1', '1', '1', '1']) }))).toBe('Units observed by hand carry no times or readings (TB15-READINGS; DI-32)');
    w.now = T0 + 5n * S;
    expect(w.rec(end(all(6), { ...timed, units: unitsOf(all(6), ['1', '2', '3', '4', '5', '5.000001']), readings: all(6).map(() => READING) }))).toBe('A unit cannot disintegrate after its run ended (TB15-TIME; DI-28, PR-29)');
    expect(w.rec(end(all(6), { ...timed, units: unitsOf(all(6), ['1', '2', '3', '4', '5', '5']), readings: all(6).map(() => READING) }))).toMatchObject({ capture: 'DEVICE', elapsedSeconds: '5.000000', passed: 6, result: 'PASS' });
  });

  it('[IN-35][PR-29] a unit passes within the time limit (equal passes); one or two failures ask for a retest of 12, three fail; the retest passes with 16 of 18 (fewer fail)', () => {
    const at = (secs: bigint, flags: boolean[]) => {
      const w = new World();
      w.rec(start());
      w.now = T0 + secs * S;
      return w.rec(end(flags));
    };
    expect(at(900n, all(6))).toMatchObject({ passed: 6, result: 'PASS', elapsedSeconds: '900.000000' });
    expect(at(901n, all(6))).toMatchObject({ passed: 0, result: 'FAIL' });
    expect(at(60n, [...all(5), false])).toMatchObject({ passed: 5, result: 'RETEST' });
    expect(at(60n, [...all(4), false, false])).toMatchObject({ passed: 4, result: 'RETEST' });
    expect(at(60n, [...all(3), false, false, false])).toMatchObject({ passed: 3, result: 'FAIL' });
    const device = new World();
    device.rec(start());
    device.now = T0 + 1000n * S;
    expect(device.rec(end(all(6), { capture: 'DEVICE', readings: all(6).map(() => READING), units: unitsOf(all(6), ['900', '899', '1', '1', '1', '900.000001']) }))).toMatchObject({ passed: 5, result: 'RETEST' });
    const retest = (firstPassed: number, retestPassed: number) => {
      const w = new World();
      w.rec(start());
      w.now = T0 + 60n * S;
      w.rec(end([...all(firstPassed), ...all(6 - firstPassed, false)]));
      const first = w.last().id;
      expect(pendingRetests(w.view()).map((e) => e.id)).toEqual([first]);
      expect(w.rec(start())).toBe('p@ waits for the retest of its disintegration run; a new first run never replaces it (TB15-RETEST-PENDING; INV-41, DI-29)');
      expect(w.rec(start({ retestOf: 'E9' }))).toBe('E9 is not a run of this stage and stream that asks for a retest (TB15-NOT-RETESTED; PR-29, INV-41)');
      expect(w.rec(start({ retestOf: first }))).toMatchObject({ retestOf: first, units: 12 });
      expect(pendingRetests(w.view())).toEqual([]);
      w.now += 60n * S;
      return w.rec(end([...all(retestPassed), ...all(12 - retestPassed, false)]));
    };
    expect(retest(5, 11)).toMatchObject({ passed: 11, passedInAll: 16, result: 'PASS' });
    expect(retest(4, 12)).toMatchObject({ passedInAll: 16, result: 'PASS' });
    expect(retest(5, 10)).toMatchObject({ passedInAll: 15, result: 'FAIL' });
  });

  it('[PR-29][INV-41] gastro-resistant: the acid stage runs its full time with every unit intact, then the buffer stage of the same stream follows it', () => {
    const w = new World({ tabletType: 'GASTRO_RESISTANT' });
    expect(w.rec(start({ stage: 'BUFFER' }))).toBe('The buffer stage follows an acid stage that passed (TB15-NO-ACID; PR-29)');
    expect(w.rec(start({ stage: 'ACID' }))).toMatchObject({ stage: 'ACID', limitSeconds: '7200' });
    w.now = T0 + 7199n * S;
    expect(w.rec(end(all(6, false)))).toBe('The acid stage runs its full 7200 s (TB15-ACID-SHORT; PR-29)');
    w.now = T0 + 7200n * S;
    expect(w.rec(end(all(6, false)))).toMatchObject({ stage: 'ACID', passed: 6, result: 'BUFFER' });
    const acidEnd = w.last().id;
    expect(pendingBuffers(w.view()).map((e) => e.id)).toEqual([acidEnd]);
    expect(dtPending(w.view())).toBe(true);
    expect(w.rec(start({ stage: 'ACID' }))).toBe('The acid stage passed: the buffer stage comes next (TB15-BUFFER-PENDING; PR-29, INV-41)');
    expect(w.rec(start({ stage: 'BUFFER' }))).toMatchObject({ stage: 'BUFFER', afterAcid: acidEnd, limitSeconds: '3600', ruleSets: [{ code: 'IP-DISINTEGRATION', version: 1 }] });
    expect(pendingBuffers(w.view())).toEqual([]);
    w.now += 60n * S;
    expect(w.rec(end(all(6)))).toMatchObject({ stage: 'BUFFER', result: 'PASS' });
    expect(dtPending(w.view())).toBe(false);
    const cracked = new World({ tabletType: 'GASTRO_RESISTANT' });
    cracked.rec(start({ stage: 'ACID' }));
    cracked.now = T0 + 7200n * S;
    expect(cracked.rec(end([...all(5, false), true]))).toMatchObject({ passed: 5, result: 'FAIL' });
  });
});

describe('TB-15 the step and its definition', () => {
  it('[IN-35][PR-29][INV-41] an entry of another kind is refused; PERFORMED needs a run and nothing pending', () => {
    const accept = TB15.handler?.acceptEntry as (v: blocks.HandlerView, e: Json & { kind: string }) => { problems?: { message: string }[] };
    expect(accept(new World().view(), { kind: 'OTHER' }).problems?.map((p) => p.message)).toEqual(['OTHER is not an entry of a disintegration step (TB15-ENTRY; PR-29)']);
    const before = TB15.handler?.beforePerform as (v: blocks.HandlerView) => { message: string }[];
    const w = new World();
    expect(before(w.view()).map((p) => p.message)).toEqual(['p@ has no disintegration run (TB15-NO-RUN; PR-29, IN-35)']);
    w.rec(start());
    expect(before(w.view()).map((p) => p.message)).toEqual([
      'p@ has no disintegration run (TB15-NO-RUN; PR-29, IN-35)',
      'p@ has a disintegration run running, or a retest or buffer stage still due (TB15-PENDING; INV-41, PR-29)',
    ]);
    w.rec(end(all(6)));
    expect(before(w.view())).toEqual([]);
  });

  it('[PR-29][DI-10] definition checks: a covering rule set, a time limit for the stage, an acid stage only for gastro-resistant tablets, a time limit in whole microseconds', () => {
    const P = (cfg: Json, markets = ['IN']) => dtConfigProblems('D', cfg, markets).map((p) => `${p.code} [${p.controls.join(',')}] ${p.message}`);
    expect(P({ tabletType: 'UNCOATED' })).toEqual([]);
    expect(P({ tabletType: 'CHEWABLE' })).toEqual(['TB15-NO-RULE-SET [PR-29,DI-10] D: no disintegration rule set covers CHEWABLE tablets']);
    expect(P({ tabletType: 'UNCOATED' }, ['IN', 'XX'])).toEqual(['TB15-NO-RULE-SET [PR-29,DI-10] D: no disintegration rule set covers UNCOATED tablets']);
    expect(P({ tabletType: 'UNCOATED', acidTime: { value: '60', unit: 'min' } })).toEqual(['TB15-STAGE [PR-29] D: only gastro-resistant tablets have an acid stage']);
    expect(P({ tabletType: 'GASTRO_RESISTANT', acidTime: { value: '60', unit: 'min' } })).toEqual([]);
    expect(P({ tabletType: 'UNCOATED', timeLimit: { value: '0.0000001', unit: 's' } })).toEqual(['TB15-NO-LIMIT [PR-29] D: the time limit is not a whole number of microseconds']);
  });

  it('[DI-34] the nominal path: one main run for most types; the gastro-resistant run starts with its acid stage', () => {
    const kinds = (cfg: Json, stream?: string) => dtNominal(cfg, stream).map((e) => `${e.kind}${e['stage'] ? `:${String(e['stage'])}` : ''}${e['stream'] ? `@${String(e['stream'])}` : ''}`);
    expect(kinds({ tabletType: 'UNCOATED' })).toEqual(['DT_START:MAIN', 'DT_END']);
    expect(kinds({ tabletType: 'GASTRO_RESISTANT' })).toEqual(['DT_START:ACID']);
    expect(kinds({ tabletType: 'UNCOATED' }, 'S1')).toEqual(['DT_START:MAIN@S1', 'DT_END']);
  });
});
