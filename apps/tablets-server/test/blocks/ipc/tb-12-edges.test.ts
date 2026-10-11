/**
 * TB-12@1 tablet weight at its edges, through its exported handlers with a minimal view: every definition check of a
 * weight configuration with its message, each weighing mode's refusals and stored data, subdivision (e) and the
 * second stage of a weight variation (d). Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import type { blocks } from '@ebmr/recipe-core/pure';
import { acceptSecondStage, acceptWeightCheck, pendingFirstStages, resultOf, weightConfigProblems, weightNominal } from '../../../src/blocks/tb-12.ts';

type Json = Record<string, unknown>;
type E = { id: string; kind: string; data: Json; recordedAt: bigint };
const NOW = 1_800_000_000_000_000n;
const uuid = (i: number) => `00000000-0000-4000-8000-${(i + 1).toString().padStart(12, '0')}`;
const uuids = (n: number) => Array.from({ length: n }, (_, i) => uuid(i));
const view = (config: Json, o: { type?: string; markets?: string[]; entries?: E[] } = {}): blocks.HandlerView =>
  ({
    phase: { block: { type: o.type ?? 'TB-12', version: '1' } },
    config,
    stepKey: 'p@',
    nowUs: NOW,
    entries: (kind?: string) => (o.entries ?? []).filter((e) => kind === undefined || e.kind === kind),
    batch: { marketSet: o.markets ?? ['IN'] },
    actor: { id: 'OP1' },
  }) as unknown as blocks.HandlerView;
const weigh = (weights: string[], extra: Json = {}): Json & { kind: string } => ({ kind: 'WEIGHT_CHECK', instrument: 'BAL', capture: 'DEVICE', readings: uuids(weights.length), weights, ...extra });
const refused = (r: ReturnType<typeof acceptWeightCheck>) => (r.ok ? 'ok' : r.problems.map((p) => p.message).join(' | '));
const data = (r: ReturnType<typeof acceptWeightCheck>): Json => {
  if (!r.ok) throw new Error(r.problems.map((p) => p.message).join(' | '));
  return r.t.data;
};
const n = (k: number, w = '250.0') => Array.from({ length: k }, () => w);

describe('TB-12 weight configuration checks', () => {
  const P = (cfg: Json, markets: string[] = ['IN']) => weightConfigProblems('W', cfg, markets).map((p) => `${p.code} [${p.controls.join(',')}] ${p.message}`);

  it('[IN-34][PR-29] each mode names the members it needs and takes none of another mode', () => {
    expect(P({ mode: 'GROUP', tabletType: 'UNCOATED' })).toEqual([
      'TB12-CONFIG [PR-29,IN-34] W: mode GROUP needs targetWeightMg',
      'TB12-CONFIG [PR-29,IN-34] W: mode GROUP needs n',
      'TB12-CONFIG [PR-29,IN-34] W: mode GROUP needs weighing',
      'TB12-CONFIG [PR-29,IN-34] W: mode GROUP needs tolerance',
    ]);
    expect(P({ mode: 'INDIVIDUAL', tabletType: 'UNCOATED', weighing: 'GROUP', tolerance: { action: '1' }, legacyTable: true, targetContent: '100' })).toEqual([
      'TB12-CONFIG [PR-29,IN-34] W: mode INDIVIDUAL needs targetWeightMg',
      'TB12-CONFIG [PR-29,IN-34] W: mode INDIVIDUAL needs n',
      'TB12-CONFIG [PR-29,IN-34] W: mode INDIVIDUAL needs individual',
      'TB12-CONFIG [PR-29] W: mode INDIVIDUAL takes no weighing',
      'TB12-CONFIG [PR-29] W: mode INDIVIDUAL takes no tolerance',
      'TB12-CONFIG [PR-29] W: mode INDIVIDUAL takes no legacyTable',
      'TB12-CONFIG [PR-29] W: mode INDIVIDUAL takes no targetContent',
    ]);
    expect(P({ mode: 'UNIFORMITY', tabletType: 'UNCOATED', individual: { action: '5' }, targetWeightMg: '250', n: 20, legacyTable: false })).toEqual([
      'TB12-CONFIG [PR-29] W: mode UNIFORMITY takes no individual',
      'TB12-CONFIG [PR-29] W: mode UNIFORMITY takes no targetWeightMg',
      'TB12-CONFIG [PR-29] W: mode UNIFORMITY takes no n',
    ]);
    expect(P({ mode: 'CONTENT', tabletType: 'UNCOATED', targetContent: '100' }, ['IN', 'US'])).toEqual([]);
    expect(P({ mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '250', n: 20, weighing: 'GROUP', tolerance: { action: '2', alert: '3' } })).toEqual([
      'TB12-CONFIG [PR-29] W tolerance has an alert tolerance wider than its action tolerance',
    ]);
    expect(P({ mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '250', n: 20, weighing: 'GROUP', tolerance: { action: '2' } })).toEqual([]);
  });

  it('[IN-34][DI-10] a compendial mode needs a rule set for every market; in-house individual limits are never looser than the band at the target (equal allowed)', () => {
    expect(P({ mode: 'SUBDIVISION', tabletType: 'UNCOATED' }, ['EU'])).toEqual(['TB12-NO-RULE-SET [IN-34,DI-10] W: no compendial rule set for this mode covers UNCOATED tablets for the markets EU, IN']);
    expect(P({ mode: 'UNIFORMITY', tabletType: 'UNCOATED' }, ['IN', 'EU'])).toEqual([]);
    expect(P({ mode: 'UNIFORMITY', tabletType: 'SUGAR_COATED', legacyTable: true }, ['IN'])[0]).toMatch(/^TB12-NO-RULE-SET/);
    // 300 mg: the IP band is 5 %.
    expect(P({ mode: 'INDIVIDUAL', tabletType: 'UNCOATED', targetWeightMg: '300.0', n: 10, individual: { action: '5' } })).toEqual([]);
    expect(P({ mode: 'INDIVIDUAL', tabletType: 'UNCOATED', targetWeightMg: '300.0', n: 10, individual: { action: '5.1' } })).toEqual([
      'TB12-LOOSER [IN-34] W: the in-house individual limit of 5.1 % is looser than the compendial band of 5 % at 300.0 mg (IN-34: never looser)',
    ]);
    expect(P({ mode: 'INDIVIDUAL', tabletType: 'UNCOATED', targetWeightMg: '200.0', n: 10, individual: { action: '7.5', alert: '8' } })).toEqual([
      'TB12-CONFIG [PR-29] W individual limits has an alert tolerance wider than its action tolerance',
    ]);
  });
});

describe('TB-12 weight checks', () => {
  it('[PR-29][DI-29] group weighing takes the group weight only, one-by-one weighing the weights only; only a weight variation takes an assay', () => {
    const grp = view({ mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '250.0', n: 4, weighing: 'GROUP', tolerance: { action: '1' } });
    expect(refused(acceptWeightCheck(grp, weigh(n(4))))).toBe('This check weighs its tablets together: give the group weight only (TB12-WEIGHTS; PR-29, DI-29)');
    expect(refused(acceptWeightCheck(grp, { kind: 'WEIGHT_CHECK', capture: 'DEVICE', readings: uuids(1) }))).toBe('This check weighs its tablets together: give the group weight only (TB12-WEIGHTS; PR-29, DI-29)');
    const g = data(acceptWeightCheck(grp, { kind: 'WEIGHT_CHECK', instrument: 'BAL', capture: 'DEVICE', readings: uuids(1), groupWeight: '1010.0' }));
    expect(g).toMatchObject({ groupWeight: '1010.0', mode: 'GROUP', result: 'PASS', evaluation: { mode: 'GROUP', n: 4, total: '1010', target: '1000' } });
    expect(g).not.toHaveProperty('weights');
    expect(g).not.toHaveProperty('ruleSets');
    expect(g).not.toHaveProperty('assay');
    expect(data(acceptWeightCheck(grp, { kind: 'WEIGHT_CHECK', instrument: 'BAL', capture: 'DEVICE', readings: uuids(1), groupWeight: '1010.1' }))['result']).toBe('FAIL');
    const one = view({ mode: 'INDIVIDUAL', tabletType: 'UNCOATED', targetWeightMg: '250.0', n: 2, individual: { action: '4' } });
    expect(refused(acceptWeightCheck(one, { kind: 'WEIGHT_CHECK', capture: 'DEVICE', readings: uuids(1), groupWeight: '500' }))).toBe('This check weighs its tablets one by one: give the individual weights only (TB12-WEIGHTS; PR-29, DI-29)');
    expect(refused(acceptWeightCheck(one, { ...weigh(n(2)), groupWeight: '500' }))).toMatch(/give the individual weights only/);
    expect(refused(acceptWeightCheck(one, weigh(n(2), { assay: '99' })))).toBe('Only a weight variation (CONTENT) takes an assay (TB12-ASSAY; PR-29)');
    expect(refused(acceptWeightCheck(one, weigh(n(2), { assayRef: 'L' })))).toBe('Only a weight variation (CONTENT) takes an assay (TB12-ASSAY; PR-29)');
    expect(refused(acceptWeightCheck(one, weigh(n(3))))).toBe('This check weighs 2 tablets one by one, not 3 (TB12-COUNT; PR-29, IN-35)');
    const i = data(acceptWeightCheck(one, weigh(['250.0', '261.0'])));
    expect(i).toMatchObject({ weights: ['250.0', '261.0'], mode: 'INDIVIDUAL', result: 'FAIL', evaluation: { mode: 'INDIVIDUAL', n: 2, outside: 1 } });
    expect(i).not.toHaveProperty('groupWeight');
    // Group mode weighed one by one: the statistics and the group evaluation both.
    const grp1 = view({ mode: 'GROUP', tabletType: 'UNCOATED', targetWeightMg: '250.0', n: 2, weighing: 'INDIVIDUAL', tolerance: { action: '1' } });
    expect(data(acceptWeightCheck(grp1, weigh(['250.0', '252.0'])))['evaluation']).toMatchObject({ mode: 'GROUP', n: 2, total: '502', sd: '1.4142', mean: '251.0000' });
  });

  it('[IN-34][PR-29] uniformity stores the rule sets it was judged against; the legacy table only when the MBR opts in', () => {
    const u = data(acceptWeightCheck(view({ mode: 'UNIFORMITY', tabletType: 'UNCOATED' }), weigh(n(20))));
    expect(u).toMatchObject({ mode: 'UNIFORMITY', ruleSets: [{ code: 'IP-UOW', version: 1 }], result: 'PASS', evaluation: { mode: 'UNIFORMITY', n: 20 } });
    const legacy = data(acceptWeightCheck(view({ mode: 'UNIFORMITY', tabletType: 'UNCOATED', legacyTable: true }), weigh(n(20))));
    expect((legacy['ruleSets'] as Json[]).map((r) => r['code'])).toContain('LEGACY-UOW');
    expect(refused(acceptWeightCheck(view({ mode: 'UNIFORMITY', tabletType: 'SUGAR_COATED' }), weigh(n(20))))).toMatch(/^No compendial rule set covers SUGAR_COATED tablets/);
  });

  it('[IN-34][PR-29] a weight variation needs the assay and its laboratory reference, stores both, and asks for a second stage only when the first fails', () => {
    const v = view({ mode: 'CONTENT', tabletType: 'UNCOATED' }, { markets: ['IN', 'US'] });
    expect(refused(acceptWeightCheck(v, weigh(n(10), { assay: '99.0' })))).toBe('A weight variation needs the assay of a representative sample and its laboratory reference (TB12-ASSAY; PR-29, DI-10)');
    expect(refused(acceptWeightCheck(v, weigh(n(10), { assayRef: 'LIMS-1' })))).toMatch(/needs the assay of a representative sample/);
    const ok = data(acceptWeightCheck(v, weigh(n(10), { assay: '99.0', assayRef: 'LIMS-1' })));
    expect(ok).toMatchObject({ assay: '99.0', assayRef: 'LIMS-1', result: 'PASS', evaluation: { stage: 'FIRST', assay: '99', targetContent: '100' } });
    // One rule set passing is not enough: every bound set passes, or the second stage is asked for.
    const spread = ['210.0', '290.0', '220.0', '280.0', '230.0', '270.0', '240.0', '260.0', '250.0', '250.0'];
    expect(data(acceptWeightCheck(v, weigh(spread, { assay: '99.0', assayRef: 'LIMS-1' })))['result']).toBe('SECOND_STAGE');
  });

  it('[IN-34][DI-10] subdivision (e) is refused for every batch while India (in every market set) has neither a rule set nor a not-applicable record for it', () => {
    for (const markets of [['IN'], ['IN', 'EU'], ['EU']]) {
      expect(refused(acceptWeightCheck(view({ mode: 'SUBDIVISION', tabletType: 'UNCOATED' }, { markets }), weigh(n(30, '100.0')))), markets.join()).toBe(
        'No compendial rule set covers UNCOATED tablets for market IN of this batch, and no record says none applies (TB12-NO-RULE-SET; IN-34, DI-10)',
      );
    }
  });
});

describe('TB-12 the second stage of a weight variation', () => {
  const cfg = { mode: 'CONTENT', tabletType: 'UNCOATED' };
  const spread = ['210.0', '290.0', '220.0', '280.0', '230.0', '270.0', '240.0', '260.0', '250.0', '250.0'];
  const firstOf = (stream?: string): E => {
    const r = acceptWeightCheck(view(cfg, { markets: ['IN', 'US'] }), weigh(spread, { assay: '99.0', assayRef: 'LIMS-1' }));
    return { id: 'E1', kind: 'WEIGHT_CHECK', data: { ...data(r), ...(stream !== undefined ? { stream } : {}) }, recordedAt: NOW - 10n };
  };
  const second = (k: number, extra: Json = {}) => ({ kind: 'WEIGHT_SECOND_STAGE', check: 'E1', instrument: 'BAL', capture: 'DEVICE', readings: uuids(k), weights: n(k), ...extra });

  it('[INV-41][PR-29] it names a first stage that asks for it, once, from the same stream, with the remaining units', () => {
    const first = firstOf();
    const v = view(cfg, { markets: ['IN', 'US'], entries: [first] });
    expect(pendingFirstStages(v).map((p) => p.id)).toEqual(['E1']);
    expect(refused(acceptSecondStage(v, second(20, { check: 'E9' })))).toBe('E9 is not a first-stage weight variation of p@ that asks for a second stage (TB12-NO-FIRST-STAGE; PR-29, INV-41)');
    const passed = { ...first, data: { ...first.data, result: 'PASS' } };
    expect(refused(acceptSecondStage(view(cfg, { entries: [passed] }), second(20)))).toMatch(/^E1 is not a first-stage weight variation/);
    expect(refused(acceptSecondStage(v, second(20, { stream: 'S2' })))).toBe('The second stage of E1 comes from the same stream (TB12-SECOND-STAGE-STREAM; PR-29)');
    expect(refused(acceptSecondStage(v, second(19)))).toBe('The second stage weighs 20 more tablets one by one, not 19 (TB12-COUNT; PR-29, INV-41)');
    expect(refused(acceptSecondStage(v, second(21)))).toBe('The second stage weighs 20 more tablets one by one, not 21 (TB12-COUNT; PR-29, INV-41)');
    const noSets = { ...first, data: { ...first.data, ruleSets: [{ code: 'IP-UDU', version: 99 }] } };
    expect(refused(acceptSecondStage(view(cfg, { entries: [noSets] }), second(20)))).toBe('The second stage weighs ? more tablets one by one, not 20 (TB12-COUNT; PR-29, INV-41)');
    const twice = view(cfg, { entries: [first, { id: 'E2', kind: 'WEIGHT_SECOND_STAGE', data: { check: 'E1' }, recordedAt: NOW - 5n }] });
    expect(refused(acceptSecondStage(twice, second(20)))).toBe('The second stage of E1 is recorded already; a stage is never repeated (TB12-SECOND-STAGE-TWICE; INV-41, DI-29)');
    expect(pendingFirstStages(twice)).toEqual([]);
  });

  it('[INV-41][IN-34][PR-29] it is judged on all units with the first stage\'s assay: one unit beyond the unit limit fails it, and the record keeps the first stage\'s rule sets', () => {
    const v = view(cfg, { markets: ['IN', 'US'], entries: [firstOf()] });
    const pass = acceptSecondStage(v, second(20));
    expect(data(pass)).toMatchObject({ check: 'E1', ruleSets: [{ code: 'IP-UDU', version: 1 }, { code: 'USP-UDU', version: 1 }], result: 'PASS', evaluation: { mode: 'CONTENT', stage: 'SECOND', n: 30, assay: '99', targetContent: '100' } });
    const fail = acceptSecondStage(v, second(20, { weights: [...n(19), '400.0'] }));
    expect(data(fail)['result']).toBe('FAIL');
  });

  it('[INV-41][DI-29] a pending first stage blocks a new first stage of its own stream only (TB-11 streams)', () => {
    const t11 = (entries: E[]) => view({ streams: [{ id: 'S1' }, { id: 'S2' }], weight: cfg }, { type: 'TB-11', markets: ['IN', 'US'], entries });
    const first = firstOf('S1');
    expect(refused(acceptWeightCheck(t11([first]), weigh(n(10), { assay: '99.0', assayRef: 'L', stream: 'S1' })))).toBe(
      'p@ waits for the second stage of its weight variation; a new first stage never replaces it (TB12-SECOND-STAGE-PENDING; INV-41, DI-29)',
    );
    expect(refused(acceptWeightCheck(t11([first]), weigh(n(10), { assay: '99.0', assayRef: 'L', stream: 'S2' })))).toBe('ok');
  });
});

describe('TB-12 entry results and the nominal path', () => {
  it('[PR-29][DI-32] a result raises exceptions only when there are some, and asks for a second person only for a keyed result', () => {
    const v = view({});
    const t = { data: { stream: 'S1' }, outcome: 'PASS' as const, manual: false, late: false, what: 'W' };
    expect(resultOf(v, t)).toStrictEqual({ ok: true, data: { stream: 'S1' } });
    expect(resultOf(v, { ...t, outcome: 'SECOND_STAGE' })).toStrictEqual({ ok: true, data: { stream: 'S1' } });
    const failed = resultOf(v, { ...t, outcome: 'FAIL', manual: true }, { data: { extra: 1 } });
    expect(failed).toMatchObject({ ok: true, data: { stream: 'S1', extra: 1 }, verificationRequired: true });
    expect((failed as { exceptions: { type: string; item?: string }[] }).exceptions.map((e) => [e.type, e.item])).toEqual([['IPC_MANUAL_ENTRY', undefined], ['IPC_CHECK_FAILED', 'S1']]);
  });

  it('[DI-34] the nominal entries of each mode weigh as many tablets as the mode asks for', () => {
    const len = (cfg: Json, markets = ['IN']) => (weightNominal(cfg, undefined, markets)[0]?.['weights'] as unknown[] | undefined)?.length;
    expect(len({ mode: 'GROUP', n: 7, weighing: 'INDIVIDUAL', targetWeightMg: '100' })).toBe(7);
    expect(len({ mode: 'INDIVIDUAL', n: 5 })).toBe(5);
    expect(len({ mode: 'UNIFORMITY', tabletType: 'UNCOATED' })).toBe(20);
    expect(len({ mode: 'CONTENT', tabletType: 'UNCOATED' }, ['IN', 'US'])).toBe(10);
    expect(len({ mode: 'SUBDIVISION', tabletType: 'UNCOATED' })).toBe(30);
    expect(weightNominal({ mode: 'GROUP', n: 4, weighing: 'GROUP', targetWeightMg: '100.5' }, 'S1', ['IN'])).toEqual([
      { kind: 'WEIGHT_CHECK', instrument: 'TEST-BAL-01', capture: 'DEVICE', stream: 'S1', readings: [uuid(0)], groupWeight: '402' },
    ]);
    expect(weightNominal({ mode: 'CONTENT', tabletType: 'UNCOATED' }, undefined, ['IN', 'US'])[0]).toMatchObject({ assay: '100.0', assayRef: 'TEST-LIMS-01' });
    expect(weightNominal({ mode: 'UNIFORMITY', tabletType: 'UNCOATED' }, undefined, ['IN'])[0]).not.toHaveProperty('assay');
  });
});
