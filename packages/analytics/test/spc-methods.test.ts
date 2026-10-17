/**
 * The methods of slice 6A-2 (SPC.IMR, SPC.XBAR_S, CAP.INDEX, DRIFT.TREND, RATE.DEVIATION; D-6A-7 to D-6A-10, D-6A-2-*)
 * against known answers: limits checked by hand, published worked examples (Newcombe 1998 for Wilson, the tea-tasting
 * table for Fisher, Benjamini and Hochberg 1995's fifteen p-values, the c4 and d2 table values) and the offline
 * reference values of test/reference/spc-reference.json, computed with SciPy by the script stored beside them.
 */
import { describe, expect, it } from 'vitest';
import {
  andersonDarling,
  CAP_INDEX,
  DRIFT_TREND,
  RATE_DEVIATION,
  benjaminiHochberg,
  bissellInterval,
  c4,
  canonicalText,
  D2_TWO,
  D4_TWO,
  decimalText,
  defaultParameters,
  ewma,
  fisherOneSided,
  garwoodInterval,
  leastSquares,
  logNormalCdf,
  nelsonHits,
  normalCdf,
  outputHash,
  parameterProblems,
  runImr,
  runXbarS,
  sha256Hex,
  tTwoSidedP,
  wilsonInterval,
  type BatchValueInput,
  type CapabilityParameters,
  type DriftParameters,
  type RateInput,
  type RateParameters,
  type SpcParameters,
  type Specification,
  type SubgroupInput,
  type XbarSParameters,
} from '../src/index.ts';
import ref from './reference/spc-reference.json' with { type: 'json' };

const close = (actual: number, expected: number, rel = 1e-9): void => {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(expected)));
};
const SPEC: Specification = { lower: null, upper: null, target: null, unit: 'A' };
const dt = decimalText;
const batch = (k: number) => ({ batchId: `00000000-0000-4000-8000-${k.toString().padStart(12, '0')}`, batchNumber: `B-${k.toString().padStart(3, '0')}`, completedAt: `2026-06-${(k % 28 + 1).toString().padStart(2, '0')} 04:30:00+00` });
const series = (values: readonly string[], spec: Partial<Specification> = {}): BatchValueInput => ({
  series: [{ product: 'P', family: 'F', item: 'x', specification: { ...SPEC, ...spec }, points: values.map((v, k) => ({ ...batch(k + 1), value: dt(v) })) }],
});
const spc = defaultParameters('SPC.IMR') as SpcParameters;

describe('statistics helpers', () => {
  it('c4, d2 and D4 equal their table values; c4 matches the gamma form', () => {
    for (const [n, v] of Object.entries(ref.c4)) close(c4(Number(n)), v, 1e-12);
    expect(c4(5).toFixed(4)).toBe('0.9400');
    expect(D2_TWO.toFixed(3)).toBe('1.128');
    expect(D4_TWO.toFixed(3)).toBe('3.267');
    expect(() => c4(1)).toThrow();
  });

  it('the normal and t distribution functions agree with SciPy, deep into the tails', () => {
    for (const [z, p] of Object.entries(ref.normalCdf)) close(normalCdf(Number(z)), p, 1e-9);
    for (const [z, lp] of Object.entries(ref.logNormalCdf)) close(logNormalCdf(Number(z)), lp, 1e-9);
    for (const [k, p] of Object.entries(ref.tTwoSided)) {
      const [t, df] = k.split('|').map(Number) as [number, number];
      close(tTwoSidedP(t, df), p, 1e-8);
    }
  });

  it('the least-squares slope, its t statistic and two-sided p-value agree with scipy.stats.linregress', () => {
    const fit = leastSquares(ref.drift.values.map(Number));
    close(fit.slope, ref.drift.slope, 1e-12);
    close(fit.intercept, ref.drift.intercept, 1e-12);
    close(fit.t, ref.drift.t, 1e-10);
    close(fit.p, ref.drift.p, 1e-7);
    expect(leastSquares([1, 2, 3, 4]).p).toBe(0);
    expect(leastSquares([2, 2, 2, 2]).p).toBe(1);
  });
});

describe('Nelson rules 1, 2, 3 and 5', () => {
  const rules = ['NELSON_1', 'NELSON_2', 'NELSON_3', 'NELSON_5'];
  it('rule 1 marks each point beyond 3 sigma; rule 2 a run of nine on one side, once, as its full extent', () => {
    const z = [0.1, 3.2, -0.2, 0.5, 0.4, 0.3, 0.2, 0.6, 0.7, 0.1, 0.9, 0.2, -3.5];
    const hits = nelsonHits(z, rules);
    expect(hits.filter((h) => h.rule === 'NELSON_1').map((h) => [h.points, h.direction])).toEqual([[[1], 1], [[12], -1]]);
    expect(hits.filter((h) => h.rule === 'NELSON_2').map((h) => h.points)).toEqual([[3, 4, 5, 6, 7, 8, 9, 10, 11]]);
    // Eight in a row is not a hit; a point exactly on the centre line breaks a run.
    expect(nelsonHits([1, 1, 1, 1, 1, 1, 1, 1, -1], ['NELSON_2'])).toEqual([]);
    expect(nelsonHits([1, 1, 1, 1, 0, 1, 1, 1, 1, 1], ['NELSON_2'])).toEqual([]);
  });

  it('rule 3 marks six points steadily rising or falling; a tie breaks the run', () => {
    expect(nelsonHits([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.2], ['NELSON_3'])).toEqual([{ rule: 'NELSON_3', points: [0, 1, 2, 3, 4, 5], direction: 1 }]);
    expect(nelsonHits([1, 0.8, 0.6, 0.4, 0.2, 0, -0.2], ['NELSON_3'])).toEqual([{ rule: 'NELSON_3', points: [0, 1, 2, 3, 4, 5, 6], direction: -1 }]);
    expect(nelsonHits([0, 0.1, 0.2, 0.2, 0.3, 0.4, 0.5], ['NELSON_3'])).toEqual([]);
    expect(nelsonHits([0, 0.1, 0.2, 0.3, 0.4], ['NELSON_3'])).toEqual([]);
  });

  it('rule 5 marks two of three beyond 2 sigma on the same side; overlapping windows are one hit; opposite sides are not', () => {
    expect(nelsonHits([0, 2.1, 0.5, 2.3, 0, 0, 0], ['NELSON_5'])).toEqual([{ rule: 'NELSON_5', points: [1, 3], direction: 1 }]);
    expect(nelsonHits([0, 2.1, -2.2, 0, 0], ['NELSON_5'])).toEqual([]);
    expect(nelsonHits([-2.5, 0, -2.1, 0, 0, 0, 0, -2.2, -2.3], ['NELSON_5']).map((h) => h.points)).toEqual([[0, 2], [7, 8]]);
    // Only the chosen rules run.
    expect(nelsonHits([5, 5, 5], ['NELSON_2'])).toEqual([]);
  });
});

describe('SPC.IMR', () => {
  it('hand-checked limits: centre 11, sigma = mean moving range (16 / 9) over d2, limits centre +- 3 sigma, MR limit D4 times the mean', () => {
    const values = ['10', '12', '11', '13', '9', '10', '11', '12', '10', '12', '11', '11'];
    const r = runImr(series(values), { ...spc, phaseOneBatches: 10 }, null);
    const v = r.outputs[0]!.values;
    close(v['centre'] as number, 11, 1e-15);
    close(v['sigma'] as number, 16 / 9 / D2_TWO, 1e-15);
    close(v['upperControl'] as number, 11 + (3 * 16) / 9 / D2_TWO, 1e-15);
    close(v['movingRangeUpper'] as number, (3.267 * 16) / 9, 1e-3);
    expect(v).toMatchObject({ chart: 'IMR', limitsSource: 'PHASE_I', phaseOneBatches: 10, valueTexts: values.join(',') });
    expect((v['plotted'] as number[]).length).toBe(12);
    expect((v['spread'] as number[]).slice(0, 3)).toEqual([2, 1, 2]);
    expect(r.outputs[0]!.reasons[0]!.code).toBe('LIMITS_PHASE_I');
  });

  it('agrees with the offline reference: Phase I limits of 20 batches, and the shift from the 25th flagged with its batches', () => {
    const r = runImr(series(ref.imr.values), spc, null);
    const v = r.outputs[0]!.values;
    close(v['centre'] as number, ref.imr.centre);
    close(v['sigma'] as number, ref.imr.sigma);
    close(v['upperControl'] as number, ref.imr.upper);
    close(v['lowerControl'] as number, ref.imr.lower);
    close(v['movingRangeUpper'] as number, ref.imr.mrUpper);
    const z = (v['plotted'] as number[]).map((x) => (x - ref.imr.centre) / ref.imr.sigma);
    z.forEach((x, k) => close(x, ref.imr.z[k]!, 1e-9));
    // The flags are those of the rules on the reference z values, each reason naming the batches of its hit.
    const expected = nelsonHits(ref.imr.z, spc.rules);
    expect(r.flags.map((f) => f.rule).sort()).toEqual([...new Set(expected.map((h) => h.rule))].sort());
    for (const f of r.flags) {
      expect(f).toMatchObject({ subjectKind: 'PRODUCT_ITEM', subjectRef: 'P|F|x', severity: 'ATTENTION' });
      for (const reason of f.reasons) expect(reason.evidence!.length).toBeGreaterThan(0);
    }
  });

  it('a series shorter than Phase I, or without variation, is skipped with the reason; a matching reference model gives REFERENCE_SET limits', () => {
    expect(runImr(series(['1', '2', '3']), spc, null)).toMatchObject({ outputs: [], skipped: [{ subject: 'P|F|x', reason: expect.stringMatching(/needs 20 completed batches/) as unknown }] });
    expect(runImr(series(Array.from({ length: 20 }, () => '5.0')), spc, null).skipped[0]!.reason).toMatch(/no variation/);
    const model = { id: 'RS-1', method: 'SPC.IMR' as const, modelSha256: 'a'.repeat(64), model: { subjectRef: 'P|F|x', chart: 'IMR', centre: 2, sigma: 0.5 } };
    const r = runImr(series(['1', '2', '3', '5']), spc, model);
    expect(r.outputs[0]!.values).toMatchObject({ limitsSource: 'REFERENCE_SET', centre: 2, sigma: 0.5, upperControl: 3.5 });
    expect(r.outputs[0]!.reasons[0]).toMatchObject({ code: 'LIMITS_REFERENCE_SET', text: expect.stringContaining('RS-1') as unknown });
    expect(r.flags.map((f) => f.rule)).toEqual(['NELSON_1']);
    // A model for another subject is not used.
    expect(runImr(series(['1', '2', '3', '5']), spc, { ...model, model: { ...model.model, subjectRef: 'P|F|y' } }).outputs).toEqual([]);
  });

  it('echoes the master\'s limits as decimal text and refuses a value that is not decimal text', () => {
    const r = runImr(series(ref.imr.values, { lower: dt('7.00'), upper: dt('13.50'), target: dt('10.0') }), spc, null);
    expect(r.outputs[0]!.values).toMatchObject({ specLower: '7.00', specUpper: '13.50', specTarget: '10.0', unit: 'A' });
    expect(() => runImr({ series: [{ ...series(['1']).series[0]!, points: [{ ...batch(1), value: '1e3' as ReturnType<typeof dt> }] }] }, spc, null)).toThrow(/not decimal text/);
  });

  it('a re-run on the same input reproduces the outputs and flags exactly (D-6A-22)', () => {
    const a = runImr(series(ref.imr.values), spc, null);
    const b = runImr(series(ref.imr.values), spc, null);
    expect(outputHash(b.outputs, b.flags)).toBe(outputHash(a.outputs, a.flags));
  });
});

describe('SPC reference sets in runs (slice 6A-3, D-6A-3-7)', () => {
  it('a run without a reference set gives the Phase I limits as a model candidate, and leaves a series a set covers to that set\'s run', () => {
    const r = runImr(series(ref.imr.values), spc, null);
    expect(r.outputs.map((o) => o.kind)).toEqual(['CONTROL_CHART', 'MODEL_CANDIDATE']);
    const cand = r.outputs[1]!;
    const model = cand.values['model'] as Record<string, unknown>;
    expect(model).toMatchObject({ subjectRef: 'P|F|x', chart: 'IMR', phaseOneBatches: 20 });
    close(model['centre'] as number, ref.imr.centre);
    close(model['sigma'] as number, ref.imr.sigma);
    expect(model['batchIds']).toHaveLength(20);
    expect(cand.values['modelSha256']).toBe(sha256Hex(canonicalText(model)));
    // Fewer batches than Phase I needs: no chart, no candidate.
    expect(runImr(series(ref.imr.values.slice(0, 19)), spc, null).outputs).toEqual([]);
    // A series a reference set in force covers is not charted by the run without one.
    const covered = runImr({ ...series(ref.imr.values), covered: ['P|F|x'] }, spc, null);
    expect(covered.outputs).toEqual([]);
    expect(covered.flags).toEqual([]);
    expect(covered.skipped[0]!.reason).toMatch(/a reference set in force covers this chart/);
    // With the candidate as its reference set, the chart says REFERENCE_SET, keeps the same limits and gives no candidate.
    const withSet = runImr(series(ref.imr.values), spc, { id: 'RS-IMR', method: 'SPC.IMR', model, modelSha256: cand.values['modelSha256'] as string });
    expect(withSet.outputs.map((o) => [o.kind, o.values['limitsSource']])).toEqual([['CONTROL_CHART', 'REFERENCE_SET']]);
    close(withSet.outputs[0]!.values['upperControl'] as number, ref.imr.upper);
    expect(withSet.flags.map((f) => f.rule)).toEqual(r.flags.map((f) => f.rule));
    // A set of another chart kind or a malformed model charts nothing, with the reason.
    expect(runImr(series(ref.imr.values), spc, { id: 'RS-X', method: 'SPC.IMR', model: { ...model, chart: 'XBAR_S' }, modelSha256: 'a'.repeat(64) }).skipped[0]!.reason)
      .toMatch(/outside reference set RS-X's scope/);
    expect(runImr(series(ref.imr.values), spc, { id: 'RS-Y', method: 'SPC.IMR', model: { ...model, sigma: 0 }, modelSha256: 'a'.repeat(64) }).skipped[0]!.reason)
      .toMatch(/does not hold a centre and a positive sigma/);
  });
});

describe('SPC.XBAR_S', () => {
  const params = defaultParameters('SPC.XBAR_S') as XbarSParameters;
  const input = (groups: readonly (readonly string[])[]): SubgroupInput => ({
    series: [{ product: 'P', family: 'F', item: 'w', specification: SPEC, points: groups.map((g, k) => ({ ...batch(k + 1), values: g.map(dt) })) }],
  });

  it('agrees with the offline reference: centre, sigma (mean s / c4), mean and S chart limits for subgroups of five', () => {
    const r = runXbarS(input(ref.xbarS.groups), params, null);
    const v = r.outputs[0]!.values;
    close(v['centre'] as number, ref.xbarS.centre);
    close(v['sigma'] as number, ref.xbarS.sigma);
    close(v['upperControl'] as number, ref.xbarS.upper);
    close(v['lowerControl'] as number, ref.xbarS.lower);
    close(v['sUpper'] as number, ref.xbarS.sUpper);
    close(v['sLower'] as number, ref.xbarS.sLower);
    expect(v).toMatchObject({ chart: 'XBAR_S', subgroupSize: 5 });
    (v['plotted'] as number[]).forEach((m, k) => close(m, ref.xbarS.means[k]!, 1e-12));
    (v['spread'] as number[]).forEach((s, k) => close(s, ref.xbarS.sds[k]!, 1e-12));
  });

  it('a batch with fewer readings than the minimum is left out and named; too few subgroups skip the chart', () => {
    const groups = ref.xbarS.groups.map((g, k) => (k === 3 ? g.slice(0, 1) : g));
    const r = runXbarS(input(groups), params, null);
    expect(r.skipped).toEqual([{ subject: 'P|F|w|B-004', reason: expect.stringMatching(/fewer than 2 readings/) as unknown }]);
    expect((r.outputs[0]!.values['batchIds'] as string).split(',')).toHaveLength(24);
    expect(runXbarS(input(ref.xbarS.groups.slice(0, 5)), params, null).outputs).toEqual([]);
  });

  it('gives its Phase I limits as a model candidate; with that candidate as its reference set the chart says REFERENCE_SET (D-6A-3-7)', () => {
    const r = runXbarS(input(ref.xbarS.groups), params, null);
    const cand = r.outputs.find((o) => o.kind === 'MODEL_CANDIDATE')!;
    const model = cand.values['model'] as Record<string, unknown>;
    expect(model).toMatchObject({ subjectRef: 'P|F|w', chart: 'XBAR_S' });
    close(model['sigma'] as number, ref.xbarS.sigma);
    const withSet = runXbarS(input(ref.xbarS.groups), params, { id: 'RS-XS', method: 'SPC.XBAR_S', model, modelSha256: cand.values['modelSha256'] as string });
    expect(withSet.outputs.map((o) => [o.kind, o.values['limitsSource']])).toEqual([['CONTROL_CHART', 'REFERENCE_SET']]);
    expect(runXbarS({ ...input(ref.xbarS.groups), covered: ['P|F|w'] }, params, null).outputs).toEqual([]);
  });
});

describe('CAP.INDEX', () => {
  const params = defaultParameters('CAP.INDEX') as CapabilityParameters;

  it('agrees with the offline reference: Ppk, Cpk, Bissell intervals and the Anderson-Darling statistic and p-value', () => {
    const r = CAP_INDEX.run(series(ref.capability.values, { lower: dt('7'), upper: dt('13') }), params, null);
    const v = r.outputs[0]!.values;
    expect(v).toMatchObject({ status: 'SHOWN', batches: 40, specLower: '7', specUpper: '13' });
    close(v['mean'] as number, ref.capability.mean);
    close(v['sigmaOverall'] as number, ref.capability.sigmaOverall);
    close(v['sigmaWithin'] as number, ref.capability.sigmaWithin);
    close(v['ppk'] as number, ref.capability.ppk);
    close(v['cpk'] as number, ref.capability.cpk);
    close(v['ppkLower'] as number, ref.capability.ppkInterval[0]!);
    close(v['ppkUpper'] as number, ref.capability.ppkInterval[1]!);
    close(v['cpkLower'] as number, ref.capability.cpkInterval[0]!);
    close(v['cpkUpper'] as number, ref.capability.cpkInterval[1]!);
    close(v['andersonDarling'] as number, ref.capability.andersonDarlingAdjusted, 1e-8);
    close(v['andersonDarlingP'] as number, ref.capability.andersonDarlingP, 1e-7);
    expect(v['normalityNote']).toMatch(/No evidence against normality/);
    // SciPy's own Anderson-Darling statistic (unadjusted) is the same.
    close(andersonDarling(ref.capability.values.map(Number)).statistic, ref.capability.andersonDarlingScipy, 1e-8);
    expect(r.flags).toEqual([]);
  });

  it('a skewed set departs from normality: the note says so and no transformation is applied', () => {
    const ad = andersonDarling(ref.skewed.values.map(Number));
    close(ad.statistic, ref.skewed.andersonDarlingScipy, 1e-8);
    expect(ad.pValue).toBeLessThan(0.05);
    const r = CAP_INDEX.run(series(ref.skewed.values, { upper: dt('12') }), params, null);
    expect(r.outputs[0]!.values['normalityNote']).toMatch(/depart from normality/);
    expect(r.outputs[0]!.reasons.map((x) => x.code)).toContain('NORMALITY_DEPARTS');
  });

  it('[DI-52] capability is not shown below 25 batches', () => {
    const r = CAP_INDEX.run(series(ref.capability.values.slice(0, 24), { lower: dt('7'), upper: dt('13') }), params, null);
    expect(r.outputs).toHaveLength(1);
    const v = r.outputs[0]!.values;
    expect(v).toMatchObject({ status: 'NOT_SHOWN', batches: 24, notShownReason: 'Capability is shown from 25 completed batches; there are 24' });
    expect(v).not.toHaveProperty('cpk');
    expect(v).not.toHaveProperty('ppk');
    expect(CAP_INDEX.run(series(ref.capability.values.slice(0, 25), { lower: dt('7'), upper: dt('13') }), params, null).outputs[0]!.values['status']).toBe('SHOWN');
    // Without a specification limit there is nothing to compare with.
    expect(CAP_INDEX.run(series(ref.capability.values), params, null).outputs[0]!.values['status']).toBe('NOT_SHOWN');
  });

  it('one-sided: only the stated limit counts; Bissell at n = 50 and k = 1.33 by hand', () => {
    const r = CAP_INDEX.run(series(ref.capability.values, { upper: dt('13') }), params, null);
    const v = r.outputs[0]!.values;
    close(v['ppk'] as number, (13 - ref.capability.mean) / (3 * ref.capability.sigmaOverall));
    const b = bissellInterval(1.33, 50, 0.95);
    const se = Math.sqrt(1 / 450 + (1.33 * 1.33) / 98);
    close(b.lower, 1.33 - 1.959963984540054 * se, 1e-12);
  });
});

describe('DRIFT.TREND', () => {
  const params = defaultParameters('DRIFT.TREND') as DriftParameters;

  it('a significant rising slope projected past the upper limit within 5 batches raises DRIFT_SLOPE naming the window', () => {
    const r = DRIFT_TREND.run(series(ref.drift.values, { lower: dt('7.0'), upper: dt('8.1'), target: dt('7.5') }), params, null);
    const v = r.outputs[0]!.values;
    close(v['slope'] as number, ref.drift.slope, 1e-12);
    close(v['slopeP'] as number, ref.drift.p, 1e-7);
    const fitNow = ref.drift.intercept + ref.drift.slope * 9;
    close(v['batchesToCross'] as number, (8.1 - fitNow) / ref.drift.slope, 1e-10);
    expect(v['slopeSignal']).toBe('YES');
    const flag = r.flags.find((f) => f.rule === 'DRIFT_SLOPE')!;
    expect(flag).toMatchObject({ severity: 'ATTENTION', subjectKind: 'PRODUCT_ITEM' });
    expect(flag.reasons[0].text).toMatch(/The last 10 batches \(B-001 to B-010\) of x trend up/);
    expect(flag.reasons[0].evidence).toHaveLength(10);
    // The same trend with a far limit is not a drift alert.
    expect(DRIFT_TREND.run(series(ref.drift.values, { upper: dt('20') }), params, null).flags.filter((f) => f.rule === 'DRIFT_SLOPE')).toEqual([]);
  });

  it('the EWMA agrees with the reference recursion, and signals when the newest point lies beyond its limit', () => {
    const e = ewma(ref.ewma.values.map(Number), 7.5, 0.1, 0.2, 2.7);
    e.z.forEach((z, k) => close(z, ref.ewma.z[k]!, 1e-12));
    close(e.halfWidth[0]!, 2.7 * 0.1 * Math.sqrt((0.2 / 1.8) * (1 - 0.64)), 1e-12);
    const flat = Array.from({ length: 15 }, (_, k) => (k % 2 === 0 ? '7.4' : '7.6'));
    const shifted = [...flat, '7.9', '8.0', '7.9', '8.0', '7.9'];
    const r = DRIFT_TREND.run(series(shifted, { target: dt('7.5'), lower: dt('6'), upper: dt('9') }), params, null);
    expect(r.flags.map((f) => f.rule)).toContain('DRIFT_EWMA');
    expect(DRIFT_TREND.run(series(flat, { target: dt('7.5') }), params, null).flags).toEqual([]);
    expect(DRIFT_TREND.run(series(flat.slice(0, 9)), params, null).skipped[0]!.reason).toMatch(/last 10 batches/);
  });
});

describe('RATE.DEVIATION', () => {
  const params = defaultParameters('RATE.DEVIATION') as RateParameters;

  it('Wilson, Garwood, one-sided Fisher and Benjamini-Hochberg agree with the published examples and SciPy', () => {
    // Newcombe (1998): 81 of 263 gives 0.2553 to 0.3662; 15 of 148 gives 0.0624 to 0.1605.
    const w = wilsonInterval(81, 263, 0.95);
    expect([w.lower.toFixed(4), w.upper.toFixed(4)]).toEqual(['0.2553', '0.3662']);
    expect(Object.values(wilsonInterval(15, 148, 0.95)).map((x) => x.toFixed(4))).toEqual(['0.0624', '0.1605']);
    for (const [k, [lo, hi]] of Object.entries(ref.wilson)) {
      const [a, n] = k.split('/').map(Number) as [number, number];
      const x = wilsonInterval(a, n, 0.95);
      close(x.lower, lo!, 1e-12);
      close(x.upper, hi!, 1e-12);
    }
    // Garwood: 0 events gives 0 to 3.689; 1 event 0.0253 to 5.572.
    expect(garwoodInterval(0, 0.95).upper.toFixed(3)).toBe('3.689');
    for (const [k, [lo, hi]] of Object.entries(ref.garwood)) {
      const g = garwoodInterval(Number(k), 0.95);
      close(g.lower, lo!, 1e-9);
      close(g.upper, hi!, 1e-9);
    }
    // The tea-tasting table: P = 17 / 70.
    close(fisherOneSided(3, 1, 1, 3), 17 / 70, 1e-12);
    for (const [k, p] of Object.entries(ref.fisher)) {
      const [a, b, c, d] = k.split(',').map(Number) as [number, number, number, number];
      close(fisherOneSided(a, b, c, d), p, 1e-10);
    }
    // Benjamini and Hochberg (1995): of 15 p-values, 4 are rejected at 0.05.
    const q = benjaminiHochberg(ref.benjaminiHochberg.p);
    q.forEach((x, k) => close(x, ref.benjaminiHochberg.q[k]!, 1e-12));
    expect(q.filter((x) => x <= 0.05)).toHaveLength(4);
  });

  const rateInput = (): RateInput => {
    const batches = Array.from({ length: 30 }, (_, k) => ({ ...batch(k + 1), groups: { ROOM: [k < 10 ? 'R-2' : k < 20 ? 'R-1' : 'R-3'], STEP: ['press'], SHIFT: [k % 2 === 0 ? 'A' : 'B'] } }));
    const dev = (k: number, room: string | null) => ({ deviationId: `d-${k.toString()}`, batchId: batches[k]!.batchId, groups: room ? { ROOM: [room], STEP: ['press'], SHIFT: ['A'] } : { SHIFT: ['A'] } });
    // R-2: 9 of 10 batches; R-1 and R-3: 3 of 10 each; one more deviation linked to batch 25 only (unattributed).
    const deviations = [...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => dev(k, 'R-2')), ...[11, 14, 17].map((k) => dev(k, 'R-1')), ...[21, 24, 27].map((k) => dev(k, 'R-3')), dev(25, null)];
    return { products: [{ product: 'P', batches, deviations }] };
  };

  it('finds the room with three times the rate, keeps the others within limits and counts a batch-only deviation as unattributed', () => {
    const r = RATE_DEVIATION.run(rateInput(), params, null);
    const room = r.outputs.filter((o) => o.values['grouping'] === 'ROOM');
    expect(room.map((o) => o.subjectRef)).toEqual(['P|ROOM:R-1', 'P|ROOM:R-2', 'P|ROOM:R-3']);
    const r2 = room.find((o) => o.values['group'] === 'R-2')!.values;
    expect(r2).toMatchObject({ status: 'COMPARED', batches: 10, withDeviation: 9, deviations: 9, restBatches: 20, restWithDeviation: 6, above: 'YES', unattributedDeviations: 1, overallWithDeviation: 15 });
    close(r2['pValue'] as number, ref.fisher['9,1,6,14'], 1e-10);
    const w = wilsonInterval(9, 10, 0.95);
    close(r2['shareLower'] as number, w.lower, 1e-15);
    close(r2['per100Upper'] as number, (100 * garwoodInterval(9, 0.95).upper) / 10, 1e-12);
    close(r2['funnelUpper'] as number, 0.5 + 1.959963984540054 * Math.sqrt(0.25 / 10), 1e-9);
    for (const g of ['R-1', 'R-3']) expect(room.find((o) => o.values['group'] === g)!.values['above'], g).toBe('NO');
    expect(r.flags.map((f) => [f.rule, f.subjectRef])).toEqual([['RATE_ABOVE', 'P|ROOM:R-2']]);
    expect(r.flags[0]!.reasons[0].evidence).toHaveLength(9);
    expect(r.flags[0]!.reasons[0].text).toMatch(/Room R-2: a deviation on 9 of 10 batches/);
    // STEP: one step on every batch, nothing to compare it with. SHIFT: the unattributed deviation counts there.
    expect(r.outputs.find((o) => o.subjectRef === 'P|STEP:press')!.values).toMatchObject({ status: 'NO_REST' });
    expect(r.outputs.find((o) => o.subjectRef === 'P|SHIFT:A')!.values).toMatchObject({ withDeviation: 7, unattributedDeviations: 0 });
  });

  it('a group below the minimum batches is reported, not compared; the q-values are BH over the compared groups', () => {
    const input = rateInput();
    const p = input.products[0]!;
    const batches = p.batches.map((b, k) => (k === 29 ? { ...b, groups: { ...b.groups, ROOM: ['R-9'] } } : b));
    const r = RATE_DEVIATION.run({ products: [{ ...p, batches }] }, params, null);
    expect(r.outputs.find((o) => o.subjectRef === 'P|ROOM:R-9')!.values).toMatchObject({ status: 'TOO_FEW_BATCHES', batches: 1, notComparedReason: 'fewer than 5 batches (1)' });
    const compared = r.outputs.filter((o) => o.values['grouping'] === 'ROOM' && o.values['status'] === 'COMPARED');
    const q = benjaminiHochberg(compared.map((o) => o.values['pValue'] as number));
    compared.forEach((o, k) => close(o.values['qValue'] as number, q[k]!, 1e-15));
  });

  it('the plan\'s default parameters fit the registry schema', () => {
    for (const id of ['SPC.IMR', 'SPC.XBAR_S', 'CAP.INDEX', 'DRIFT.TREND', 'RATE.DEVIATION'] as const) expect(parameterProblems(id, defaultParameters(id)), id).toEqual([]);
  });
});
