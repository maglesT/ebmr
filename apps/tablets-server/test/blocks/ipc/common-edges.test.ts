/**
 * The members every IPC test shares (tablets spec C-11 to C-15, E.2 to E.5), function by function: limits read from a
 * configuration and their definition checks, the rule-set refusals, the stream, sampling time, readings and lateness
 * of a test entry, and the exceptions of its capture and verdict. Written for the Phase 3 exit mutation run
 * (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks } from '@ebmr/recipe-core/pure';
import {
  boundsOf,
  captureExceptions,
  commonOf,
  decimals,
  DEFAULT_LATE_ENTRY_US,
  isFinal,
  percentTierProblems,
  percentTiersOf,
  ruleSetRefusal,
  testConfig,
  tierProblems,
  tiersOf,
  verdictExceptions,
} from '../../../src/blocks/ipc/common.ts';
import type { RuleSet } from '../../../src/blocks/ipc/rule-sets.ts';

const NOW = 1_800_000_000_000_000n;
const view = (o: { type?: string; config?: Record<string, unknown>; entries?: { recordedAt: bigint }[]; markets?: string[]; nowUs?: bigint } = {}): blocks.HandlerView =>
  ({
    phase: { block: { type: o.type ?? 'TB-12', version: '1' } },
    config: o.config ?? {},
    stepKey: 'p@',
    nowUs: o.nowUs ?? NOW,
    entries: () => o.entries ?? [],
    batch: { marketSet: o.markets ?? ['IN'] },
    actor: { id: 'OP1' },
  }) as unknown as blocks.HandlerView;
const messages = (r: { ok: false; problems: { code: string; message: string; controls: readonly string[] }[] } | { ok: true } | undefined) =>
  r && !r.ok ? r.problems.map((p) => [p.code, p.message, p.controls]) : r;

describe('IPC limits read from a configuration', () => {
  it('[IN-35][PR-08] bounds keep only text ends; tiers need action bounds; percent tiers need an action percentage', () => {
    expect(boundsOf({ min: '1', max: 2 })).toStrictEqual({ min: '1' });
    expect(boundsOf({ max: '2', min: null })).toStrictEqual({ max: '2' });
    expect(boundsOf('x')).toBeUndefined();
    expect(tiersOf({ action: { min: '1' }, alert: { min: '2' } })).toStrictEqual({ action: { min: '1' }, alert: { min: '2' } });
    expect(tiersOf({ action: { max: '9' } })).toStrictEqual({ action: { max: '9' } });
    expect(tiersOf({ alert: { min: '2' } })).toBeUndefined();
    expect(tiersOf(null)).toBeUndefined();
    expect(percentTiersOf({ action: '5', alert: '2' })).toStrictEqual({ action: '5', alert: '2' });
    expect(percentTiersOf({ action: '5', alert: 2 })).toStrictEqual({ action: '5' });
    expect(percentTiersOf({ action: 5 })).toBeUndefined();
    expect(percentTiersOf([])).toBeUndefined();
  });

  it('[IN-35][PR-08] tier definition checks: an action band with an end, each band ordered, the alert band inside the action band on each side (equal ends allowed)', () => {
    const p = (t: Parameters<typeof tierProblems>[1]) => tierProblems('w', t, 'C', ['PR-08']).map((x) => x.message);
    expect(p(undefined)).toEqual([]);
    expect(p({ action: {} })).toEqual(['w has action limits without a lower or upper limit']);
    expect(p({ action: { max: '5' } })).toEqual([]);
    expect(p({ action: { min: '5' } })).toEqual([]);
    expect(p({ action: { min: '5', max: '4' } })).toEqual(['w has a lower limit above its upper limit']);
    expect(p({ action: { min: '1', max: '9' }, alert: { min: '3', max: '2' } })).toEqual(['w has a lower limit above its upper limit']);
    expect(p({ action: { min: '1', max: '9' }, alert: { min: '1', max: '9' } })).toEqual([]);
    expect(p({ action: { min: '4', max: '4' } })).toEqual([]);
    expect(p({ action: { min: '1', max: '9' }, alert: { min: '0.9', max: '5' } })).toEqual(['w has alert limits outside its action limits']);
    expect(p({ action: { min: '1', max: '9' }, alert: { min: '2', max: '9.1' } })).toEqual(['w has alert limits outside its action limits']);
    expect(p({ action: { min: '1', max: '9' }, alert: { max: '5' } })).toEqual(['w has alert limits outside its action limits']);
    expect(p({ action: { min: '1', max: '9' }, alert: { min: '5' } })).toEqual(['w has alert limits outside its action limits']);
    expect(p({ action: { min: '1' }, alert: { min: '2', max: '50' } })).toEqual([]);
    expect(p({ action: { max: '9' }, alert: { min: '-50', max: '8' } })).toEqual([]);
    expect(tierProblems('w', { action: {} }, 'C', ['PR-08'])).toEqual([{ code: 'C', severity: 'ERROR', message: 'w has action limits without a lower or upper limit', controls: ['PR-08'] }]);
    expect(percentTierProblems('w', { action: '5', alert: '6' }, 'C', ['X'])).toEqual([{ code: 'C', severity: 'ERROR', message: 'w has an alert tolerance wider than its action tolerance', controls: ['X'] }]);
    expect(percentTierProblems('w', { action: '5', alert: '5' }, 'C', ['X'])).toEqual([]);
    expect(percentTierProblems('w', { action: '5' }, 'C', ['X'])).toEqual([]);
    expect(percentTierProblems('w', undefined, 'C', ['X'])).toEqual([]);
  });

  it('[IN-35] decimals and final outcomes', () => {
    expect(decimals(['1.5', '2'])?.map((d) => d.toString())).toEqual(['1.5', '2']);
    expect(decimals(['1', 2])).toBeUndefined();
    expect(decimals('1')).toBeUndefined();
    expect(['PASS', 'ALERT', 'FAIL', 'SECOND_STAGE', 'REPEAT', undefined].map(isFinal)).toEqual([true, true, true, false, false, false]);
  });
});

describe('IPC rule-set refusals', () => {
  const uow = (code: string, units: number): RuleSet => ({ code, version: 1, test: 'UNIFORMITY_OF_WEIGHT', pharmacopoeia: 'IP', markets: ['IN'], tabletTypes: ['UNCOATED'], params: { units, bands: [{ percent: '5' }], maxOutside: 2, maxOutsideDouble: 0 }, confidence: 'HIGH', source: 's', effectiveFrom: '2020-01-01' });

  it('[IN-34][DI-10] no set, or a batch market no set covers, is refused naming the market; sets with different procedures are refused naming the members', () => {
    expect(messages(ruleSetRefusal(view(), 'UNIFORMITY_OF_WEIGHT', 'UNCOATED', [], 'TB12'))).toEqual([
      ['TB12-NO-RULE-SET', 'No compendial rule set covers UNCOATED tablets for market IN of this batch, and no record says none applies (TB12-NO-RULE-SET; IN-34, DI-10)', ['IN-34', 'DI-10']],
    ]);
    expect(messages(ruleSetRefusal(view({ markets: ['IN', 'EU'] }), 'SUBDIVISION', 'UNCOATED', [uow('A', 20)], 'TB12'))?.[0]?.[1]).toBe(
      'No compendial rule set covers UNCOATED tablets for market IN of this batch, and no record says none applies (TB12-NO-RULE-SET; IN-34, DI-10)',
    );
    expect(messages(ruleSetRefusal(view(), 'UNIFORMITY_OF_WEIGHT', 'UNCOATED', [uow('A', 20), uow('B', 10)], 'TB12'))).toEqual([
      ['TB12-RULE-SETS-DIFFER', 'The rule sets bound for this check give different procedures (units) (TB12-RULE-SETS-DIFFER; IN-34, DI-10)', ['IN-34', 'DI-10']],
    ]);
    expect(ruleSetRefusal(view(), 'UNIFORMITY_OF_WEIGHT', 'UNCOATED', [uow('A', 20), uow('B', 20)], 'TB12')).toBeUndefined();
  });
});

describe('IPC test entries', () => {
  const scheduler = (o: Parameters<typeof view>[0] = {}) => view({ type: 'TB-11', config: { streams: [{ id: 'S1' }, { id: 'S2' }, 'bad'] }, ...o });

  it('[PR-29][IN-35] a TB-11 entry names one of its streams; a test block entry names no stream or counter', () => {
    expect(messages(commonOf(scheduler(), { capture: 'MANUAL' }, 1, 'TB12'))).toEqual([['TB12-STREAM', 'A check at p@ names one of its streams (S1, S2, ) (TB12-STREAM; PR-29, IN-35)', ['PR-29', 'IN-35']]]);
    expect(messages(commonOf(scheduler(), { capture: 'MANUAL', stream: 'S3' }, 1, 'TB12'))?.[0]?.[0]).toBe('TB12-STREAM');
    expect(messages(commonOf(view({ type: 'TB-11', config: {} }), { capture: 'MANUAL', stream: 'S1' }, 1, 'TB12'))?.[0]?.[1]).toBe('A check at p@ names one of its streams () (TB12-STREAM; PR-29, IN-35)');
    const ok = commonOf(scheduler(), { capture: 'MANUAL', stream: 'S2', counter: '7', instrument: 'I-1' }, 1, 'TB12');
    expect(ok).toStrictEqual({ ok: true, common: { base: { instrument: 'I-1', capture: 'MANUAL', sampledAtUs: NOW.toString(), stream: 'S2', counter: '7', late: false, recordedBy: 'OP1' }, manual: true, late: false } });
    expect(messages(commonOf(view(), { capture: 'MANUAL', stream: 'S1' }, 1, 'TB12'))).toEqual([['TB12-STREAM', 'p@ is not a TB-11 scheduler step: its checks name no stream or counter (TB12-STREAM; PR-29)', ['PR-29']]]);
    expect(messages(commonOf(view(), { capture: 'MANUAL', counter: '1' }, 1, 'TB12'))?.[0]?.[0]).toBe('TB12-STREAM');
    expect(testConfig(scheduler({ config: { weight: { mode: 'GROUP' } } }), 'weight')).toEqual({ mode: 'GROUP' });
    expect(testConfig(scheduler({ config: { weight: 'x' } }), 'weight')).toEqual({});
    expect(testConfig(view({ config: { mode: 'GROUP' } }), 'weight')).toEqual({ mode: 'GROUP' });
  });

  it('[DI-28] the sample is taken neither after it is recorded nor before the step\'s first entry (equal instants allowed); lateness counts from the sampling, beyond the late-entry time', () => {
    const v = view({ entries: [{ recordedAt: NOW - 100n }] });
    expect(messages(commonOf(v, { capture: 'MANUAL', sampledAtUs: (NOW + 1n).toString() }, 1, 'TB12'))).toEqual([['TB12-SAMPLED-LATER', 'The sample of p@ cannot be taken after it is recorded (TB12-SAMPLED-LATER; DI-28)', ['DI-28']]]);
    expect(messages(commonOf(v, { capture: 'MANUAL', sampledAtUs: (NOW - 101n).toString() }, 1, 'TB12'))).toEqual([['TB12-SAMPLED-EARLY', "The sample of p@ cannot be taken before the step's first entry (TB12-SAMPLED-EARLY; DI-28)", ['DI-28']]]);
    expect(commonOf(v, { capture: 'MANUAL', sampledAtUs: (NOW - 100n).toString() }, 1, 'TB12').ok).toBe(true);
    expect(commonOf(v, { capture: 'MANUAL', sampledAtUs: NOW.toString() }, 1, 'TB12').ok).toBe(true);
    // Before any entry, an earlier sample is the step's first fact (not refused).
    expect(commonOf(view(), { capture: 'MANUAL', sampledAtUs: (NOW - 5n).toString() }, 1, 'TB12').ok).toBe(true);
    const late = (sampled: bigint, config: Record<string, unknown> = {}) => {
      const r = commonOf(view({ config }), { capture: 'MANUAL', sampledAtUs: sampled.toString() }, 1, 'TB12');
      return r.ok ? r.common.late : undefined;
    };
    expect(late(NOW - DEFAULT_LATE_ENTRY_US)).toBe(false);
    expect(late(NOW - DEFAULT_LATE_ENTRY_US - 1n)).toBe(true);
    expect(late(NOW - 60_000_000n, { lateEntry: { value: '1', unit: 'min' } })).toBe(false);
    expect(late(NOW - 60_000_001n, { lateEntry: { value: '1', unit: 'min' } })).toBe(true);
  });

  it('[DI-32][DI-31] an instrument entry names exactly one reading per value, in order; a keyed entry names none', () => {
    expect(messages(commonOf(view(), { capture: 'DEVICE', readings: ['a'] }, 2, 'TB12'))).toEqual([['TB12-READINGS', 'A check captured from the instrument names one claimed reading per value (2), in order (TB12-READINGS; DI-32, DI-31)', ['DI-32', 'DI-31']]]);
    expect(messages(commonOf(view(), { capture: 'DEVICE' }, 1, 'TB12'))?.[0]?.[0]).toBe('TB12-READINGS');
    expect(messages(commonOf(view(), { capture: 'MANUAL', readings: [] }, 1, 'TB12'))).toEqual([['TB12-READINGS', 'A check keyed by hand names no instrument readings (TB12-READINGS; DI-32)', ['DI-32']]]);
    const ok = commonOf(view(), { capture: 'DEVICE', readings: ['a', 'b'], instrument: 'I' }, 2, 'TB12');
    expect(ok).toStrictEqual({ ok: true, common: { base: { instrument: 'I', capture: 'DEVICE', readings: ['a', 'b'], sampledAtUs: NOW.toString(), late: false, recordedBy: 'OP1' }, manual: false, late: false } });
  });

  it('[DI-32][DI-28][PR-29][IN-35] capture and verdict exceptions: keyed by hand, late, failed (holding output, waiting for a deviation) and alert, each naming its stream', () => {
    const v = view();
    expect(captureExceptions(v, { base: {}, manual: true, late: true }, 'The weight check')).toEqual([
      { type: 'IPC_MANUAL_ENTRY', title: 'The weight check at p@ was keyed by hand instead of taken from the instrument interface; the step now needs a second person', controls: ['DI-32', 'PR-29'], severity: 'ALERT', category: 'MANUAL_ENTRY', blocks: 'NONE' },
      { type: 'IPC_LATE_ENTRY', title: 'The weight check at p@ was recorded later than the late-entry time after its sampling', controls: ['DI-28'], severity: 'ALERT', category: 'LATE_ENTRY', blocks: 'NONE' },
    ]);
    expect(captureExceptions(v, { base: {}, manual: false, late: false }, 'x')).toEqual([]);
    expect(verdictExceptions(v, 'FAIL', 'The weight check', 'S1')).toEqual([
      {
        type: 'IPC_CHECK_FAILED',
        title: 'The weight check at p@ (stream S1) failed its limits: output since the last passing check is held and the steps after it wait for a deviation',
        controls: ['PR-29', 'IN-35'],
        severity: 'ACTION',
        category: 'OUT_OF_LIMIT',
        blocks: 'DOWNSTREAM',
        until: 'DEVIATION',
        deviationRequired: true,
        item: 'S1',
      },
    ]);
    expect(verdictExceptions(v, 'FAIL', 'X', undefined)[0]).not.toHaveProperty('item');
    expect(verdictExceptions(v, 'FAIL', 'X', undefined)[0]?.title).toBe('X at p@ failed its limits: output since the last passing check is held and the steps after it wait for a deviation');
    expect(verdictExceptions(v, 'ALERT', 'X', 'S2')).toEqual([
      { type: 'IPC_CHECK_ALERT', title: 'X at p@ (stream S2) is inside its action limits but outside its alert limits', controls: ['PR-29'], severity: 'ALERT', category: 'OUT_OF_LIMIT', blocks: 'NONE', item: 'S2' },
    ]);
    expect(verdictExceptions(v, 'ALERT', 'X', undefined)[0]).not.toHaveProperty('item');
    expect(verdictExceptions(v, 'PASS', 'X', 'S1')).toEqual([]);
    expect(verdictExceptions(v, 'PENDING', 'X', 'S1')).toEqual([]);
  });
});
