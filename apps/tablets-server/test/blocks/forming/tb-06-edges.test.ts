/**
 * TB-06@1 roller compaction (PR-08, PR-29, IN-36, DI-31) at its edges, through its handler on a minimal view: the
 * ribbon schedule (due, overdue beyond the grace, the end of the run), the ribbon verdicts, the mill screens before and
 * after use with what a damaged screen holds, feed units, fines recycle limits, the exact yield against its limits,
 * PERFORMED and every definition check. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks, flow } from '@ebmr/recipe-core/pure';
import { ribbonDue, ribbonOverdue, ribbonParameters, TB06 } from '../../../src/blocks/tb-06.ts';
import { blockMbr, fixturePhase } from './support.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint; recordedSeq: number };
const T = 1_800_000_000_000_000n;
const MIN = 60_000_000n;
const PHASE = fixturePhase(TB06);
const CFG = PHASE.config as Json;
const kg = (value: string) => ({ value, unit: 'kg' });
const AP = { value: '1.5', unit: 'mm' };

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
    const accept = TB06.handler?.acceptEntry as (v: blocks.HandlerView, x: Json & { kind: string }) => { ok: boolean; data?: Json; problems?: { message: string }[]; exceptions?: Json[] };
    const r = accept(this.view(), entry);
    if (!r.ok) return { refused: (r.problems ?? []).map((p) => p.message).join(' | ') };
    this.entries.push({ id: `E${this.entries.length + 1}`, kind: entry.kind, data: r.data ?? {}, recordedAt: this.now, recordedSeq: this.entries.length + 1 });
    return { data: r.data ?? {}, ...(r.exceptions ? { exceptions: r.exceptions } : {}) };
  }
  before(): string[] {
    return (TB06.handler?.beforePerform as (v: blocks.HandlerView) => { code: string }[])(this.view()).map((p) => p.code);
  }
}
const screen = (when: string, result = 'INTACT', extra: Json = {}) => ({ kind: 'SCREEN_CHECK', screen: 'RS-15', aperture: AP, when, result, ...extra });
const ribbon = (thickness = '3.00', solidFraction = '68', appearance = 'COMPLIES') => ({ kind: 'RIBBON_CHECK', thickness, solidFraction, appearance });
const started = (cfg: Json = CFG): World => {
  const w = new World(cfg);
  w.rec({ kind: 'RUN_START', press: 'RC-1' });
  return w;
};
const types = (r: { exceptions?: Json[] }) => (r.exceptions ?? []).map((x) => x['type']);

describe('TB-06 ribbon schedule', () => {
  it('[PR-29][IN-36] due one interval after the start or the last check or missed marking, at the latest at the run end; nothing after an end-of-run check', () => {
    const e = (kind: string, at: bigint, data: Json = {}) => ({ id: kind, kind, data, recordedAt: at, recordedSeq: 0 }) as never;
    expect(ribbonDue([], CFG)).toBeUndefined();
    expect(ribbonDue([e('RUN_START', T)], { ...CFG, ribbon: { ...(CFG['ribbon'] as Json), every: undefined } })).toBeUndefined();
    expect(ribbonDue([e('RUN_START', T)], { ...CFG, ribbon: undefined })).toBeUndefined();
    expect(ribbonDue([e('RUN_START', T)], CFG)).toBe(T + 30n * MIN);
    expect(ribbonDue([e('RUN_START', T), e('RIBBON_CHECK', T + 10n * MIN)], CFG)).toBe(T + 40n * MIN);
    expect(ribbonDue([e('RUN_START', T), e('RIBBON_CHECK', T - MIN)], CFG)).toBe(T + 30n * MIN);
    expect(ribbonDue([e('RUN_START', T), e('FEED', T + 12n * MIN, { missed: [{ stream: 'RIBBON' }] })], CFG)).toBe(T + 42n * MIN);
    expect(ribbonDue([e('RUN_START', T), e('FEED', T + 12n * MIN, { missed: [{ stream: 'MILL' }] })], CFG)).toBe(T + 30n * MIN);
    expect(ribbonDue([e('RUN_START', T), e('FEED', T + 12n * MIN, { missed: 'RIBBON' })], CFG)).toBe(T + 30n * MIN);
    expect(ribbonDue([e('RUN_START', T), e('RUN_END', T + 10n * MIN)], CFG)).toBe(T + 10n * MIN);
    expect(ribbonDue([e('RUN_START', T), e('RUN_END', T + 30n * MIN)], CFG)).toBe(T + 30n * MIN);
    expect(ribbonDue([e('RUN_START', T), e('RUN_END', T + 40n * MIN)], CFG)).toBe(T + 30n * MIN);
    expect(ribbonDue([e('RUN_START', T), e('RUN_END', T + 10n * MIN), e('RIBBON_CHECK', T + 10n * MIN)], CFG)).toBeUndefined();
    const start = [e('RUN_START', T)];
    expect(ribbonOverdue(start, CFG, T + 35n * MIN)).toEqual([]);
    expect(ribbonOverdue(start, CFG, T + 35n * MIN + 1n)).toEqual([{ stream: 'RIBBON', test: 'RIBBON', by: 'TIME', dueUs: (T + 30n * MIN).toString() }]);
    const noGrace = { ...CFG, ribbon: { ...(CFG['ribbon'] as Json), grace: undefined } };
    expect(ribbonOverdue(start, noGrace, T + 30n * MIN)).toEqual([]);
    expect(ribbonOverdue(start, noGrace, T + 30n * MIN + 1n)).toHaveLength(1);
    expect(ribbonOverdue([], CFG, T + 999n * MIN)).toEqual([]);
    expect(ribbonParameters(CFG)).toEqual(['thickness', 'solidFraction']);
    expect(ribbonParameters({})).toEqual([]);
  });

  it('[PR-29][IN-36] a missed check is listed on the next entry with RIBBON_CHECK_MISSED; a check restarts the clock', () => {
    const w = started();
    w.rec({ kind: 'FEED', quantity: kg('50') });
    w.now = T + 35n * MIN + 1n;
    const late = w.rec(screen('BEFORE'));
    expect(late.data?.['missed']).toEqual([{ stream: 'RIBBON', test: 'RIBBON', by: 'TIME', dueUs: (T + 30n * MIN).toString() }]);
    expect(late.exceptions?.[0]).toEqual({
      type: 'RIBBON_CHECK_MISSED',
      title: 'A ribbon check was missed; the compactor output since the last passing check is held at p@: the steps after it wait for a deviation',
      controls: ['PR-29', 'IN-36'],
      severity: 'ACTION',
      category: 'TIME_LIMIT',
      blocks: 'DOWNSTREAM',
      until: 'DEVIATION',
      deviationRequired: true,
      item: 'RIBBON',
    });
    const next = w.rec({ kind: 'FEED', quantity: kg('1') });
    expect(next.data?.['missed']).toBeUndefined();
    expect(next.exceptions).toBeUndefined();
    const pre = new World();
    pre.now = T + 999n * MIN;
    expect(pre.rec(screen('BEFORE')).data?.['missed']).toBeUndefined();
  });

  it('[PR-29] a ribbon check gives exactly the parameters examined; verdicts PASS, ALERT and FAIL; appearance fails alone', () => {
    const w = started();
    expect(w.rec({ kind: 'RIBBON_CHECK', thickness: '3', appearance: 'COMPLIES' }).refused).toBe('A ribbon check gives exactly the parameters the MBR examines (thickness, solidFraction) (TB06-RIBBON-PARAMETERS; PR-29, IN-36)');
    expect(w.rec({ ...ribbon(), density: '1.2' }).refused).toMatch(/TB06-RIBBON-PARAMETERS/);
    expect(started({ ...CFG, ribbon: undefined }).rec(ribbon()).refused).toBe('p has no ribbon checks in its MBR (TB06-NO-RIBBON; PR-29)');
    const pass = w.rec(ribbon());
    expect(pass.data).toStrictEqual({ thickness: '3.00', solidFraction: '68', appearance: 'COMPLIES', evaluation: { thickness: 'PASS', solidFraction: 'PASS', appearance: 'PASS' }, result: 'PASS', recordedBy: 'OP1' });
    expect(pass.exceptions).toBeUndefined();
    const alert = w.rec(ribbon('2.60'));
    expect(alert.data?.['result']).toBe('ALERT');
    expect(alert.exceptions).toEqual([{ type: 'RIBBON_CHECK_ALERT', title: 'A ribbon check at p@ is inside its action limits but outside its alert limits', controls: ['PR-29'], severity: 'ALERT', category: 'OUT_OF_LIMIT', blocks: 'NONE', item: 'RIBBON' }]);
    const fail = w.rec(ribbon('3.60'));
    expect(fail.data?.['result']).toBe('FAIL');
    expect(types(fail)).toEqual(['RIBBON_CHECK_FAILED']);
    expect(fail.exceptions?.[0]?.['title']).toBe('A ribbon check failed its limits; the compactor output since the last passing check is held at p@: the steps after it wait for a deviation');
    expect(fail.exceptions?.[0]?.['category']).toBe('OUT_OF_LIMIT');
    const look = w.rec(ribbon('3.00', '68', 'DOES_NOT_COMPLY'));
    expect([look.data?.['result'], (look.data?.['evaluation'] as Json)['appearance']]).toEqual(['FAIL', 'FAIL']);
    expect(types(w.rec(ribbon('3.00', '59.9')))).toEqual(['RIBBON_CHECK_FAILED']);
  });
});

describe('TB-06 entries', () => {
  it('[PR-29] once started, its own kinds only; a screen check may come before the start; nothing fed or ended after the end; nothing discharged after the yield', () => {
    const w = new World();
    expect(w.rec({ kind: 'FEED', quantity: kg('1') }).refused).toBe('p@ has not started its run (TB06-NOT-STARTED; PR-29)');
    expect(w.rec({ kind: 'OTHER' }).refused).toBe('OTHER is not an entry of a roller compaction step (TB06-ENTRY; PR-29)');
    expect(w.rec(screen('BEFORE')).refused).toBeUndefined();
    expect(w.rec({ kind: 'RUN_START', press: 'RC-1' }).data).toStrictEqual({ press: 'RC-1', recordedBy: 'OP1' });
    expect(w.rec({ kind: 'RUN_START', press: 'RC-1' }).refused).toBe('p@ has started its run already; a new run is a new step (TB06-TWICE; PR-29)');
    expect(w.rec({ kind: 'YIELD' }).refused).toBe('The run of p@ has not ended: the yield comes after it (TB06-RUNNING; PR-29)');
    expect(w.rec({ kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: kg('1'), fines: kg('0') }).refused).toBe('p@ has fed no pre-blend (TB06-NO-FEED; PR-29)');
    expect(w.rec({ kind: 'FEED', quantity: kg('50') }).data).toStrictEqual({ quantity: kg('50'), recordedBy: 'OP1' });
    expect(w.rec({ kind: 'FEED', quantity: { value: '1', unit: 'g' } }).refused).toBe("The step's quantities are in kg (TB06-UNIT; PR-29, DI-29)");
    expect(w.rec({ kind: 'FEED' }).refused).toMatch(/TB06-UNIT/);
    expect(new World().rec({ kind: 'RUN_START' }).refused).toBeUndefined();
    const fresh = started();
    expect(fresh.rec({ kind: 'FEED' }).refused).toBe("The step's quantities are in one unit (TB06-UNIT; PR-29, DI-29)");
    expect(fresh.rec({ kind: 'RUN_END' }).data).toStrictEqual({ recordedBy: 'OP1' });
    expect(fresh.rec({ kind: 'YIELD' }).refused).toBe('p@ has fed no pre-blend (TB06-NO-FEED; PR-29)');
    for (const kind of ['FEED', 'FINES_RECYCLED', 'RUN_END']) expect(fresh.rec({ kind, quantity: kg('1') }).refused).toBe('The run of p@ has ended (TB06-ENDED; PR-29)');
    w.rec({ kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: kg('49'), fines: kg('1') });
    w.rec({ kind: 'RUN_END' });
    expect(w.rec(ribbon()).refused).toBeUndefined();
    expect(w.rec({ kind: 'YIELD' }).refused).toBeUndefined();
    expect(w.rec({ kind: 'YIELD' }).refused).toBe('The yield of p@ is recorded: nothing more is discharged (TB06-AFTER-YIELD; PR-29, DI-29)');
    expect(w.rec({ kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: kg('1'), fines: kg('0') }).refused).toMatch(/TB06-AFTER-YIELD/);
    expect(w.rec(screen('AFTER')).refused).toBeUndefined();
  });

  it('[IN-36][INV-24] granules go through a screen checked intact before use, in the feed unit', () => {
    const w = started();
    w.rec({ kind: 'FEED', quantity: kg('50') });
    const out = (g: unknown, f: unknown = kg('0')) => w.rec({ kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: g, fines: f });
    expect(out(kg('1')).refused).toBe('Mill screen RS-15 has no intact check before this use; check it first (TB06-NO-PRE-CHECK; IN-36, INV-24)');
    w.rec(screen('BEFORE'));
    expect(out({ value: '1', unit: 'g' }).refused).toBe("The step's quantities are in kg (TB06-UNIT; PR-29, DI-29)");
    expect(out(kg('1'), { value: '1', unit: 'g' }).refused).toMatch(/TB06-UNIT/);
    expect(out(undefined).refused).toMatch(/TB06-UNIT/);
    expect(out(kg('1'), null).refused).toMatch(/TB06-UNIT/);
    expect(out(kg('1'), kg('0.5')).data).toStrictEqual({ screen: 'RS-15', granules: kg('1'), fines: kg('0.5'), recordedBy: 'OP1' });
  });

  it('[IN-36][PR-23] mill screens: listed, the approved aperture, checked before then after, a damaged one never again; damaged after use holds what went through it since its last intact check', () => {
    const w = started();
    w.rec({ kind: 'FEED', quantity: kg('50') });
    expect(w.rec(screen('BEFORE', 'INTACT', { screen: 'RS-99' })).refused).toBe('RS-99 is not a mill screen the MBR lists for p (TB06-SCREEN; IN-36, PR-23)');
    expect(w.rec(screen('BEFORE', 'INTACT', { aperture: { value: '1.6', unit: 'mm' } })).refused).toBe('Screen RS-15 reads 1.6 mm; the MBR approves 1.5 mm (TB06-APERTURE; IN-36, PR-23)');
    expect(w.rec(screen('BEFORE', 'INTACT', { aperture: { value: '1.5', unit: 'um' } })).refused).toMatch(/TB06-APERTURE/);
    expect(w.rec(screen('BEFORE', 'INTACT', { aperture: { value: 'x', unit: 'mm' } })).refused).toMatch(/TB06-APERTURE/);
    expect(w.rec(screen('BEFORE', 'INTACT', { aperture: undefined })).refused).toBe('Screen RS-15 reads  ; the MBR approves 1.5 mm (TB06-APERTURE; IN-36, PR-23)');
    expect(w.rec(screen('AFTER')).refused).toBe('Screen RS-15 was not checked before use (TB06-CHECK-ORDER; IN-36)');
    const ok = w.rec(screen('BEFORE', 'INTACT', { aperture: { value: '1.50', unit: 'mm' } }));
    expect(ok.data).toStrictEqual({ screen: 'RS-15', aperture: { value: '1.50', unit: 'mm' }, when: 'BEFORE', result: 'INTACT', checkedBy: 'OP1' });
    expect(ok.exceptions).toEqual([]);
    expect(w.rec(screen('BEFORE')).refused).toBe('Screen RS-15 is in use; check it after use first (TB06-CHECK-ORDER; IN-36)');
    expect(w.before()).toEqual(expect.arrayContaining(['TB06-RUNNING']));
    w.rec({ kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: kg('10'), fines: kg('1') });
    w.rec(screen('AFTER'));
    w.rec(screen('BEFORE'));
    w.rec({ kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: kg('10'), fines: kg('1') });
    w.rec({ kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: kg('10'), fines: kg('1') });
    const bad = w.rec(screen('AFTER', 'DAMAGED'));
    const ids = w.entries.filter((e) => e.kind === 'GRANULE_OUTPUT').map((e) => e.id).slice(1);
    expect(bad.data?.['held']).toEqual(ids);
    expect(bad.exceptions).toEqual([
      {
        type: 'SCREEN_INTEGRITY_FAILED',
        title: `Mill screen RS-15 was found damaged after use; the granules milled through it since its last intact check (${ids.join(', ')}) are held at p@: the steps after it wait for a deviation`,
        controls: ['PR-29', 'IN-36'],
        severity: 'ACTION',
        category: 'DEVIATION_OR_OVERRIDE',
        blocks: 'DOWNSTREAM',
        until: 'DEVIATION',
        deviationRequired: true,
        item: 'RS-15',
      },
    ]);
    expect(w.rec(screen('BEFORE')).refused).toBe('Screen RS-15 was found damaged and is never used again (TB06-SCREEN-DAMAGED; IN-36, PR-23)');
    const none = started();
    none.rec(screen('BEFORE'));
    expect(none.rec(screen('AFTER', 'DAMAGED')).exceptions?.[0]?.['title']).toMatch(/since its last intact check \(none\) are held/);
    const early = started().rec(screen('BEFORE', 'DAMAGED'));
    expect(early.exceptions).toEqual([{ type: 'SCREEN_DAMAGED', title: 'Mill screen RS-15 of p@ was found damaged before use: it is not used', controls: ['IN-36', 'PR-23'], severity: 'ALERT', category: 'DEVIATION_OR_OVERRIDE', blocks: 'NONE', item: 'RS-15' }]);
    expect(early.data?.['held']).toBeUndefined();
  });

  it('[PR-29][IN-36] fines recycle: allowed by the MBR, in the feed unit, never more than discharged nor above the limit of the feed (equal allowed)', () => {
    const w = started();
    const fines = (value: string) => w.rec({ kind: 'FINES_RECYCLED', quantity: kg(value) });
    expect(fines('1').refused).toBe("The step's quantities are in the unit of its feed (TB06-UNIT; PR-29, DI-29)");
    w.rec({ kind: 'FEED', quantity: kg('50') });
    w.rec(screen('BEFORE'));
    w.rec({ kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: kg('40'), fines: kg('6') });
    expect(w.rec({ kind: 'FINES_RECYCLED', quantity: { value: '1', unit: 'g' } }).refused).toBe("The step's quantities are in kg (TB06-UNIT; PR-29, DI-29)");
    expect(w.rec({ kind: 'FINES_RECYCLED' }).refused).toMatch(/TB06-UNIT/);
    expect(fines('6.001').refused).toBe('More fines would be recycled than were discharged (TB06-FINES-QUANTITY; PR-29, DI-29)');
    expect(fines('5.001').refused).toBe("The fines recycled would come to more than the MBR's 10 % of the pre-blend fed (TB06-FINES-LIMIT; PR-29, IN-36)");
    expect(fines('2').data).toStrictEqual({ quantity: kg('2'), recycledPercent: '4.00', recordedBy: 'OP1' });
    expect(fines('3.001').refused).toMatch(/TB06-FINES-LIMIT/);
    expect(fines('3').data?.['recycledPercent']).toBe('10.00');
    const tight = started({ ...CFG, finesRecycle: { maxPercent: '50' } });
    tight.rec({ kind: 'FEED', quantity: kg('10') });
    tight.rec(screen('BEFORE'));
    tight.rec({ kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: kg('5'), fines: kg('2') });
    expect(tight.rec({ kind: 'FINES_RECYCLED', quantity: kg('2') }).refused).toBeUndefined();
    expect(tight.rec({ kind: 'FINES_RECYCLED', quantity: kg('0.001') }).refused).toMatch(/TB06-FINES-QUANTITY/);
    for (const finesRecycle of [undefined, {}, { maxPercent: 10 }]) {
      expect(started({ ...CFG, finesRecycle }).rec({ kind: 'FINES_RECYCLED', quantity: kg('1') }).refused).toBe('The MBR allows no fines recycle at p (TB06-RECYCLE-NOT-ALLOWED; PR-29, IN-36)');
    }
  });

  it('[PR-29][DI-29] the yield: exact net (granules + fines - recycled) x 100 against limit x feed; boundaries inside; the rounded display never decides', () => {
    const yieldOf = (granules: string, fines: string, recycled: string | undefined, cfg: Json = CFG, feed = '50') => {
      const w = started(cfg);
      w.rec({ kind: 'FEED', quantity: kg(feed) });
      w.rec(screen('BEFORE'));
      w.rec({ kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: kg(granules), fines: kg(fines) });
      if (recycled !== undefined) w.rec({ kind: 'FINES_RECYCLED', quantity: kg(recycled) });
      w.rec({ kind: 'RUN_END' });
      return w.rec({ kind: 'YIELD' });
    };
    const ok = yieldOf('48', '1.8', '1');
    expect(ok.data).toStrictEqual({ unit: 'kg', feed: '50', granules: '48', fines: '1.8', recycled: '1', net: '48.8', yieldPercent: '97.60', recordedBy: 'OP1', withinLimits: true });
    expect(ok.exceptions).toBeUndefined();
    expect(yieldOf('47.5', '0', undefined).data?.['withinLimits']).toBe(true);
    const low = yieldOf('47.4975', '0', undefined);
    expect([low.data?.['yieldPercent'], low.data?.['withinLimits']]).toEqual(['95.00', false]);
    expect(low.exceptions).toEqual([
      { type: 'COMPACTION_YIELD_OUT_OF_RANGE', title: "The stage yield of 95.00 % is outside the MBR's limits at p@: the steps after it wait for a deviation", controls: ['PR-29', 'IN-36'], severity: 'ACTION', category: 'OUT_OF_LIMIT', blocks: 'DOWNSTREAM', until: 'DEVIATION', deviationRequired: true },
    ]);
    expect(yieldOf('50', '0', undefined).data?.['withinLimits']).toBe(true);
    const high = yieldOf('50.0025', '0', undefined);
    expect([high.data?.['yieldPercent'], high.data?.['withinLimits']]).toEqual(['100.01', false]);
    expect(yieldOf('49', '1.5', '0.5').data?.['net']).toBe('50');
    expect(yieldOf('10', '0', undefined, { ...CFG, yield: undefined }).data?.['withinLimits']).toBeUndefined();
    expect(yieldOf('10', '0', undefined, { ...CFG, yield: { max: '100' } }).data?.['withinLimits']).toBe(true);
    expect(yieldOf('60', '0', undefined, { ...CFG, yield: { min: '95' } }).data?.['withinLimits']).toBe(true);
    expect(yieldOf('10', '0', undefined, { ...CFG, yield: { min: 95, max: '100' } }).data?.['withinLimits']).toBe(true);
    expect(yieldOf('60', '0', undefined, { ...CFG, yield: { min: '95', max: 100 } }).data?.['withinLimits']).toBe(true);
    const zero = yieldOf('0', '0', undefined, CFG, '0');
    expect([zero.data?.['yieldPercent'], zero.data?.['withinLimits']]).toEqual(['0.00', false]);
  });
});

describe('TB-06 PERFORMED and definition', () => {
  it('[PR-29][IN-36] PERFORMED needs the run ended, an end-of-run ribbon check, every screen checked after use, a discharge and the yield', () => {
    const w = started();
    expect(w.before()).toContain('TB06-RUNNING');
    w.rec({ kind: 'FEED', quantity: kg('50') });
    w.now = T + MIN;
    w.rec(ribbon());
    w.now = T + 2n * MIN;
    w.rec({ kind: 'RUN_END' });
    const ended = w.before();
    expect(ended).toEqual(expect.arrayContaining(['TB06-END-CHECK', 'TB06-NOTHING-DISCHARGED', 'TB06-NO-YIELD']));
    expect(ended).not.toContain('TB06-RUNNING');
    expect(ended).not.toContain('TB06-AFTER-CHECK-MISSING');
    w.rec(ribbon());
    expect(w.before()).not.toContain('TB06-END-CHECK');
    const done = started();
    done.rec({ kind: 'FEED', quantity: kg('50') });
    done.rec(screen('BEFORE'));
    done.rec({ kind: 'GRANULE_OUTPUT', screen: 'RS-15', granules: kg('49'), fines: kg('0') });
    done.rec({ kind: 'RUN_END' });
    done.rec(ribbon());
    done.rec({ kind: 'YIELD' });
    expect(done.before().filter((c) => c.startsWith('TB06'))).toEqual(['TB06-AFTER-CHECK-MISSING']);
    done.rec(screen('AFTER'));
    expect(done.before().filter((c) => c.startsWith('TB06'))).toEqual([]);
  });

  it('[PR-29][PR-07][IN-36] the definition: a compactor used, a ribbon interval and grace above zero with its risk assessment and parameters, screens once, a recycle limit up to 100, ordered yield limits', () => {
    const P = (config: Json, equipment: Json[] = [{ ref: 'COMPACTOR', use: 'USE' }]) => {
      const phase = fixturePhase(TB06, { config: config as never, equipment: equipment as never });
      return (TB06.checkConfig as (p: flow.PhaseNode, c: Json, m: unknown) => { code: string; message: string }[])(phase, config, blockMbr(TB06, phase))
        .filter((x) => x.code.startsWith('TB06'))
        .map((x) => `${x.code}: ${x.message}`);
    };
    const r = CFG['ribbon'] as Json;
    const W = 'Roller compaction step';
    expect(P(CFG)).toEqual([]);
    expect(P(CFG, [{ ref: 'COMPACTOR', use: 'CLEAN' }])).toEqual([expect.stringMatching(/^TB06-NO-EQUIPMENT: .* names no roller compactor it uses$/)]);
    const noInterval = /^TB06-RIBBON: .* has no ribbon check interval and grace above zero$/;
    expect(P({ ...CFG, ribbon: undefined })).toEqual([expect.stringMatching(noInterval)]);
    for (const bad of [{ every: undefined }, { every: { value: '0', unit: 'min' } }, { grace: undefined }, { grace: { value: '0', unit: 'min' } }]) {
      expect(P({ ...CFG, ribbon: { ...r, ...bad } })).toEqual([expect.stringMatching(noInterval)]);
    }
    expect(P({ ...CFG, ribbon: { ...r, every: { value: '0.000001', unit: 's' }, grace: { value: '0.000001', unit: 's' } } })).toEqual([]);
    expect(P({ ...CFG, ribbon: { ...r, qrmRef: undefined } })).toEqual([expect.stringMatching(/^TB06-QRM: .* names no risk assessment for its ribbon check frequency$/)]);
    expect(P({ ...CFG, ribbon: { every: r['every'], grace: r['grace'], qrmRef: 'Q' } })).toEqual([expect.stringMatching(/^TB06-RIBBON: .* examines no ribbon thickness, density or solid fraction$/)]);
    expect(P({ ...CFG, ribbon: { ...r, thickness: { action: { min: '4', max: '3' } } } }).some((x) => x.startsWith('TB06-RIBBON: ') && x.includes(`${W} p ribbon thickness`))).toBe(true);
    expect(P({ ...CFG, screens: [{ id: 'A', aperture: AP }, { id: 'A', aperture: AP }] })).toEqual([expect.stringMatching(/^TB06-DUPLICATE-SCREEN: .* lists a mill screen twice$/)]);
    const recycle = /^TB06-RECYCLE: .*: the fines recycle limit is a percentage above zero and at most 100$/;
    for (const maxPercent of [10, 'x', '100.01']) expect(P({ ...CFG, finesRecycle: { maxPercent } })).toEqual([expect.stringMatching(recycle)]);
    expect(P({ ...CFG, finesRecycle: { maxPercent: '100' } })).toEqual([]);
    expect(P({ ...CFG, finesRecycle: undefined })).toEqual([]);
    expect(P({ ...CFG, yield: { min: '100.01', max: '100' } })).toEqual([`TB06-YIELD: ${W} p: the yield limits run from 100.01 to 100`]);
    expect(P({ ...CFG, yield: { min: '100', max: '100' } })).toEqual([]);
    expect(P({ ...CFG, yield: { min: '100.01' } })).toEqual([]);
    expect(P({ ...CFG, yield: { max: '1', min: 2 } })).toEqual([]);
  });

  it('[PR-29] the nominal script takes the middle of each action range and both screen checks', () => {
    const nominal = TB06.simulatorModel?.nominalEntries?.({ phase: PHASE, config: CFG, mbr: blockMbr(TB06, PHASE), frames: [], containers: [], target: () => undefined, nowUs: 1n } as never) as Json[];
    const checks = nominal.filter((e) => e['kind'] === 'RIBBON_CHECK');
    expect(checks).toEqual([
      { kind: 'RIBBON_CHECK', thickness: '3', solidFraction: '67.5', appearance: 'COMPLIES' },
      { kind: 'RIBBON_CHECK', thickness: '3', solidFraction: '67.5', appearance: 'COMPLIES' },
    ]);
    expect(nominal.filter((e) => e['kind'] === 'SCREEN_CHECK').map((e) => e['when'])).toEqual(['BEFORE', 'AFTER']);
    const half = { ...CFG, ribbon: { ...(CFG['ribbon'] as Json), thickness: { action: { min: '2' } }, solidFraction: { action: { max: '70' } } }, screens: [] };
    const n2 = TB06.simulatorModel?.nominalEntries?.({ phase: PHASE, config: half, mbr: blockMbr(TB06, PHASE), frames: [], containers: [], target: () => undefined, nowUs: 1n } as never) as Json[];
    expect(n2.find((e) => e['kind'] === 'RIBBON_CHECK')).toEqual({ kind: 'RIBBON_CHECK', thickness: '2', solidFraction: '70', appearance: 'COMPLIES' });
    expect(n2.some((e) => e['kind'] === 'SCREEN_CHECK' || e['kind'] === 'GRANULE_OUTPUT')).toBe(false);
  });
});
