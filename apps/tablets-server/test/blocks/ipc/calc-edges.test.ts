/**
 * The IPC calculations (tablets spec C-11 to C-15, E.2 to E.5) at their edges, function by function: one-sided limits,
 * the tiers' counts, the second stage of the acceptance value, subdivision of scored tablets, the friability sample
 * rule for heavy units, and the disintegration limits merged across several rule sets. The database computes the same
 * (tablets 0891, 0892); these pin the server's side. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import {
  acceptanceValue,
  bandOf,
  dec,
  disintegrationLimits,
  fixed,
  friabilityLimit,
  friabilitySampleProblem,
  groupEvaluation,
  individualEvaluation,
  judge,
  referenceValue,
  statistics,
  subdivisionCriteria,
  tightestBand,
  uniformityCriteria,
} from '../../../src/blocks/ipc/calc.ts';
import type { DisintegrationParams, FriabilityParams, RuleParams, RuleSet, RuleTest, SubdivisionParams, UniformityParams, WeightVariationParams } from '../../../src/blocks/ipc/rule-sets.ts';

const rs = (code: string, test: RuleTest, params: RuleParams): RuleSet => ({
  code,
  version: 1,
  test,
  pharmacopoeia: 'IN_HOUSE',
  markets: [],
  tabletTypes: ['UNCOATED'],
  params,
  confidence: 'HIGH',
  source: 'test',
  effectiveFrom: '2020-01-01',
});
const ds = (...vs: string[]) => vs.map(dec);
const WV: WeightVariationParams = { firstUnits: 10, totalUnits: 30, firstK: '2.4', secondK: '2.0', acceptanceLimit: '15.0', unitLimitPercent: '25.0', referenceLow: '98.5', referenceHigh: '101.5', avDecimals: 1 };
const FRI: FriabilityParams = { maxLossPercent: '1.0', rotations: 100, rpmMin: '24', rpmMax: '26', targetSampleGrams: '6.5', heavyUnitMg: '650', heavyUnitCount: 10, repeatRuns: 3, lossDecimals: 1 };
const STAGING = { failMin: 1, failMax: 2, retestUnits: 12, passMin: 16 };
const dt = (code: string, types: DisintegrationParams['types'], units = 6) => rs(code, 'DISINTEGRATION', { units, staging: STAGING, types });

describe('IPC limits and verdicts', () => {
  it('[IN-35][PR-29] a value shown with decimals is rounded half away from zero, as PostgreSQL round() does', () => {
    expect(fixed(dec('0.125'), 2)).toBe('0.13');
    expect(fixed(dec('-0.125'), 2)).toBe('-0.13');
    expect(fixed(dec('2.5'), 0)).toBe('3');
  });

  it('[IN-35][PR-08] one-sided limits judge only the side they state; the alert tier warns inside the action tier', () => {
    expect(judge(dec('5'), { action: { max: '10' } })).toBe('PASS');
    expect(judge(dec('11'), { action: { max: '10' } })).toBe('FAIL');
    expect(judge(dec('5'), { action: { min: '1' } })).toBe('PASS');
    expect(judge(dec('0.9'), { action: { min: '1' } })).toBe('FAIL');
    expect(judge(dec('9'), { action: { max: '10' }, alert: { max: '8' } })).toBe('ALERT');
  });

  it('[IN-35] a single value has no standard deviation; two on have SD and RSD', () => {
    const one = statistics(ds('100'));
    expect(one).toEqual({ n: 1, sum: '100', mean: '100.0000', min: '100', max: '100', minDeviation: '0.00', maxDeviation: '0.00' });
    const two = statistics(ds('99', '101'));
    expect([two.sd, two.rsd, two.minDeviation, two.maxDeviation]).toEqual(['1.4142', '1.41', '-1.00', '1.00']);
  });

  it('[IN-34][PR-29] (a) the group check names its mode and judges the total against n x target', () => {
    const g = groupEvaluation(dec('2010'), 10, dec('200'), { action: '1' });
    expect(g.evaluation).toMatchObject({ mode: 'GROUP', n: 10, total: '2010', mean: '201.0000', target: '2000', limits: { action: { min: '1980', max: '2020' } } });
    expect(g.verdict).toBe('PASS');
    expect(groupEvaluation(dec('2021'), 10, dec('200'), { action: '1' }).verdict).toBe('FAIL');
  });
});

describe('IPC weight modes (b) to (e)', () => {
  const uow = (maxOutside: number, maxOutsideDouble: number): UniformityParams => ({ units: 4, bands: [{ upToMg: '80', inclusive: true, percent: '10' }, { percent: '5' }], maxOutside, maxOutsideDouble });

  it('[IN-34][PR-29] (b) a unit outside twice the band fails even when the count outside the band is allowed; a closed band list above its last bound is refused', () => {
    // Average 100 mg: band 5 %; every unit is outside it, only 120 outside 10 % (twice the band).
    const ws = ds('94', '93', '93', '120');
    const r = uniformityCriteria(ws, [rs('U', 'UNIFORMITY_OF_WEIGHT', uow(4, 0))]);
    expect(r.criteria[0]).toMatchObject({ ruleSet: 'U', percent: '5', outside: 4, outsideDouble: 1, pass: false });
    expect(r.verdict).toBe('FAIL');
    const ok = uniformityCriteria(ws, [rs('U', 'UNIFORMITY_OF_WEIGHT', uow(4, 1))]);
    expect([ok.criteria[0]?.['pass'], ok.verdict]).toEqual([true, 'PASS']);
    expect(() => bandOf({ ...uow(2, 0), bands: [{ upToMg: '80', inclusive: true, percent: '10' }] }, dec('400'), 4)).toThrow('a uniformity rule set ends with an open band');
  });

  it('[IN-34][PR-29] (c) the tightest band of several rule sets is the smallest, whatever their order', () => {
    const loose = rs('L', 'UNIFORMITY_OF_WEIGHT', { units: 20, bands: [{ percent: '7.5' }], maxOutside: 2, maxOutsideDouble: 0 });
    const tight = rs('T', 'UNIFORMITY_OF_WEIGHT', { units: 20, bands: [{ percent: '5' }], maxOutside: 2, maxOutsideDouble: 0 });
    expect(tightestBand([tight, loose], dec('100'))?.toString()).toBe('5');
    expect(tightestBand([loose, tight], dec('100'))?.toString()).toBe('5');
    expect(tightestBand([], dec('100'))).toBeUndefined();
  });

  it('[IN-34][PR-08] (c) in-house individual limits count the units outside the action limits and those outside the alert limits', () => {
    const r = individualEvaluation(ds('100', '103', '106', '94'), dec('100'), { action: '5', alert: '2' });
    expect(r.evaluation).toMatchObject({ mode: 'INDIVIDUAL', target: '100', outside: 2, outsideAlert: 3 });
    expect(r.verdict).toBe('FAIL');
    const alert = individualEvaluation(ds('100', '103'), dec('100'), { action: '5', alert: '2' });
    expect([alert.evaluation['outside'], alert.evaluation['outsideAlert'], alert.verdict]).toEqual([0, 1, 'ALERT']);
  });

  it('[IN-34][PR-29] (d) the reference value M: the low end below it, the assay inside, the high end (or the target above it) as the cap', () => {
    expect(referenceValue(WV, dec('97'), dec('100')).toString()).toBe('98.5');
    expect(referenceValue(WV, dec('98.5'), dec('100')).toString()).toBe('98.5');
    expect(referenceValue(WV, dec('100'), dec('100')).toString()).toBe('100');
    expect(referenceValue(WV, dec('103'), dec('100')).toString()).toBe('101.5');
    expect(referenceValue(WV, dec('103'), dec('102')).toString()).toBe('102');
    expect(referenceValue(WV, dec('101'), dec('102')).toString()).toBe('101');
  });

  it('[IN-34][PR-29] (d) at the second stage no unit may lie outside M x (1 +/- unit limit %), even when the acceptance value passes', () => {
    const r = rs('W', 'WEIGHT_VARIATION', WV);
    const ws = ds('100', '100', '100', '100', '100', '100', '100', '100', '100', '100', '100', '100', '100', '100', '100', '100', '100', '100', '100', '140');
    const first = acceptanceValue(ws, dec('100'), dec('100'), r, false);
    expect(first).not.toHaveProperty('outsideUnitLimit');
    const second = acceptanceValue(ws, dec('100'), dec('100'), { ...r, params: { ...WV, acceptanceLimit: '99' } }, true);
    expect(second).toMatchObject({ k: '2.0', outsideUnitLimit: 1, pass: false });
    const low = acceptanceValue([...ws.slice(0, 19), dec('60')], dec('100'), dec('100'), { ...r, params: { ...WV, acceptanceLimit: '99' } }, true);
    expect(low).toMatchObject({ outsideUnitLimit: 1, pass: false });
    const inside = acceptanceValue([...ws.slice(0, 19), dec('101')], dec('100'), dec('100'), r, true);
    expect(inside).toMatchObject({ outsideUnitLimit: 0, pass: true });
  });

  it('[IN-34][PR-29] (e) subdivision: parts against the average +/- inner and outer percent, each count against its maximum', () => {
    const p: SubdivisionParams = { units: 30, innerPercent: '15', outerPercent: '25', maxOutsideInner: 1, maxOutsideOuter: 0 };
    const sets = [rs('S', 'SUBDIVISION', p)];
    // Average 100: 118 is outside 15 %, inside 25 %.
    const one = subdivisionCriteria(ds('94', '94', '94', '118'), sets);
    expect(one).toEqual({ criteria: [{ ruleSet: 'S', version: 1, outsideInner: 1, outsideOuter: 0, pass: true }], verdict: 'PASS' });
    const two = subdivisionCriteria(ds('84', '116', '100', '100'), sets);
    expect(two.criteria[0]).toMatchObject({ outsideInner: 2, outsideOuter: 0, pass: false });
    expect(two.verdict).toBe('FAIL');
    // Average 100: 130 is outside 25 %.
    const outer = subdivisionCriteria(ds('90', '90', '90', '130'), [rs('S', 'SUBDIVISION', { ...p, maxOutsideInner: 3 })]);
    expect(outer.criteria[0]).toMatchObject({ outsideInner: 1, outsideOuter: 1, pass: false });
    expect(outer.verdict).toBe('FAIL');
    const exact = subdivisionCriteria(ds('85', '115'), [rs('S', 'SUBDIVISION', { ...p, maxOutsideInner: 0 })]);
    expect(exact.criteria[0]).toMatchObject({ outsideInner: 0, pass: true });
    // Two rule sets: one passing does not pass the check.
    expect(subdivisionCriteria(ds('94', '94', '94', '118'), [...sets, rs('S2', 'SUBDIVISION', { ...p, maxOutsideInner: 0 })]).verdict).toBe('FAIL');
  });
});

describe('TB-14 friability and TB-15 disintegration limits', () => {
  it('[IN-35][PR-29] the friability limit is the smallest of the rule sets and the MBR (an MBR limit never loosens it)', () => {
    const sets = [rs('F', 'FRIABILITY', FRI)];
    expect(friabilityLimit(sets, '0.8')?.toString()).toBe('0.8');
    expect(friabilityLimit(sets, '1.5')?.toString()).toBe('1');
    expect(friabilityLimit([rs('F2', 'FRIABILITY', { ...FRI, maxLossPercent: '0.5' }), ...sets], undefined)?.toString()).toBe('0.5');
    expect(friabilityLimit([], undefined)).toBeUndefined();
  });

  it('[IN-35][PR-29] tablets above the heavy-unit mass are tested ten at a time; lighter ones as near as possible to 6.5 g', () => {
    expect(friabilitySampleProblem(FRI, 10, dec('7.0'))).toBeUndefined();
    expect(friabilitySampleProblem(FRI, 9, dec('6.3'))).toBe('tablets above 650 mg are tested 10 at a time, not 9');
    // Exactly 650 mg each is not above the heavy-unit mass: the 6.5 g rule applies.
    expect(friabilitySampleProblem(FRI, 10, dec('6.5'))).toBeUndefined();
    expect(friabilitySampleProblem(FRI, 26, dec('6.5'))).toBeUndefined();
    expect(friabilitySampleProblem(FRI, 20, dec('5.0'))).toBe('20 tablets weighing 5 g are not the whole number of tablets nearest to 6.5 g');
  });

  it('[IN-35][PR-29] disintegration limits from several rule sets: the shortest time, the longest acid stage, the narrowest bath; an MBR time only tightens', () => {
    const a = dt('A', { UNCOATED: { minutes: '15', tempMin: '35', tempMax: '39' }, GASTRO_RESISTANT: { minutes: '60', acidMinutes: '60', tempMin: '35', tempMax: '39' } });
    const b = dt('B', { UNCOATED: { minutes: '30', tempMin: '36', tempMax: '38' }, GASTRO_RESISTANT: { minutes: '30', acidMinutes: '120', tempMin: '36', tempMax: '38' } }, 12);
    const c = dt('C', { FILM_COATED: { minutes: '30', tempMin: '35', tempMax: '39' } });
    expect(disintegrationLimits([b, c, a], 'UNCOATED', undefined, undefined)).toEqual({ seconds: '900', tempMin: '36', tempMax: '38', units: 12, staging: STAGING });
    expect(disintegrationLimits([a, b], 'UNCOATED', undefined, undefined)).toMatchObject({ seconds: '900', tempMin: '36', tempMax: '38', units: 6 });
    expect(disintegrationLimits([a, b], 'GASTRO_RESISTANT', undefined, undefined)).toMatchObject({ seconds: '1800', acidSeconds: '7200' });
    expect(disintegrationLimits([b, a], 'GASTRO_RESISTANT', undefined, undefined)).toMatchObject({ seconds: '1800', acidSeconds: '7200' });
    expect(disintegrationLimits([a], 'UNCOATED', '600', undefined)?.seconds).toBe('600');
    expect(disintegrationLimits([a], 'UNCOATED', '1200', undefined)?.seconds).toBe('900');
    expect(disintegrationLimits([a], 'GASTRO_RESISTANT', undefined, '5400')?.acidSeconds).toBe('5400');
    expect(disintegrationLimits([a], 'UNCOATED', undefined, undefined)).not.toHaveProperty('acidSeconds');
  });

  it('[IN-35][PR-29] without a rule set for the tablet type there are no limits; a rule set without a time gives none unless the MBR states one', () => {
    const usp = dt('USP', { UNCOATED: { tempMin: '35', tempMax: '39' } });
    expect(disintegrationLimits([], 'UNCOATED', '600', undefined)).toBeUndefined();
    expect(disintegrationLimits([dt('C', { FILM_COATED: { minutes: '30', tempMin: '35', tempMax: '39' } })], 'UNCOATED', undefined, undefined)).toBeUndefined();
    expect(disintegrationLimits([usp], 'UNCOATED', undefined, undefined)).toEqual({ tempMin: '35', tempMax: '39', units: 6, staging: STAGING });
    expect(disintegrationLimits([usp], 'UNCOATED', '600', undefined)?.seconds).toBe('600');
  });
});
