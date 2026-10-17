/**
 * The golden batch profile, method GBP.DTW_BAND (slice 6A-6; D-6A-16, D-6A-6-1 to D-6A-6-8): the curve arithmetic
 * against hand-worked examples and the offline reference values (test/reference/profile-dtw.json and its script), then
 * the method on known answers: a curve inside the band, one outside it, a time-shifted good curve, missing samples and
 * BAD or UNCERTAIN status, and the synthetic history's seeded abnormal press curve (test-kit analyticsHistory).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyticsHistory, HISTORY_PRODUCT, HISTORY_SEEDS } from '../../test-kit/src/analytics-history.ts';
import {
  AnalyticsInputError,
  GBP_DTW_BAND,
  alignAlong,
  bandRadius,
  canonicalText,
  defaultParameters,
  distanceLimitOf,
  dtw,
  medoidIndex,
  outsidePoints,
  percentile,
  pointwiseBand,
  prepareCurve,
  profileModelOf,
  profileModelSha256,
  resample,
  sha256Hex,
  tQuantile,
  type GbpParameters,
  type OutputDraft,
  type ProfileCurve,
  type ProfileModel,
  type ReferenceModel,
} from '../src/index.ts';

const P = defaultParameters('GBP.DTW_BAND') as GbpParameters;

describe('the curve arithmetic (methods/profile/curves.ts)', () => {
  it('DTW and band against hand-worked examples', () => {
    // a = 0 0 1 2 is b = 0 1 2 2 delayed by one point: DTW with a band of 1 matches it exactly, the diagonal does not.
    const a = [0, 0, 1, 2];
    const b = [0, 1, 2, 2];
    const warped = dtw(a, b, 1);
    expect(warped.distance).toBe(0);
    expect(warped.path).toEqual([[0, 0], [1, 0], [2, 1], [3, 2], [3, 3]]);
    expect(alignAlong(a, warped.path, b.length)).toEqual(b);
    expect(dtw(a, b, 0).distance).toBeCloseTo(Math.SQRT2, 12);
    // 1 2 3 onto 1 3 3: least cumulative squared cost 1 (worked by hand: D(2,2) = 0 + min(1, 2, 1)).
    expect(dtw([1, 2, 3], [1, 3, 3], 1)).toEqual({ distance: 1, path: [[0, 0], [1, 1], [2, 2]] });
    // Percentiles by Hyndman and Fan type 7: 5th and 95th of 1..5 are 1.2 and 4.8.
    expect(percentile([5, 1, 4, 2, 3], 5)).toBeCloseTo(1.2, 12);
    expect(percentile([5, 1, 4, 2, 3], 95)).toBeCloseTo(4.8, 12);
    expect(percentile([7], 50)).toBe(7);
    // The band of three aligned curves, without and with a tolerance of one point.
    const curves = [[0, 10, 0], [1, 11, 1], [2, 12, 2]];
    expect(pointwiseBand(curves, 0, 100, 0)).toEqual({ low: [0, 10, 0], high: [2, 12, 2] });
    expect(pointwiseBand(curves, 0, 100, 1)).toEqual({ low: [0, 0, 0], high: [12, 12, 12] });
    expect(pointwiseBand(curves, 50, 100, 0)).toEqual({ low: [1, 11, 1], high: [2, 12, 2] });
    expect(outsidePoints([0.5, 13, 1], { low: [1, 11, 1], high: [2, 12, 2] })).toEqual([0, 1]);
    // Resampling: linear interpolation over normalised time; the medoid; the band radius of 10 % of 200 points.
    expect(resample({ t: [0, 1, 3], v: [0, 10, 30] }, 4)).toEqual([0, 10, 20, 30]);
    expect(resample({ t: [100, 200], v: [5, 7] }, 3)).toEqual([5, 6, 7]);
    expect(medoidIndex([[0, 1, 4], [1, 0, 2], [4, 2, 0]])).toBe(1);
    expect(medoidIndex([[0, 1], [1, 0]])).toBe(0);
    expect(bandRadius(200, 0.1)).toBe(20);
    // The distance limit: a log-normal prediction limit, exp(m + t(0.99, n - 1) s sqrt(1 + 1/n)), over the positive
    // distances (logs 0, 1, 2: m 1, s 1, n 3, t 6.964557 from the published table).
    expect(distanceLimitOf([0, 1, Math.E, Math.E ** 2], 99)).toBeCloseTo(Math.exp(1 + 6.964557 * Math.sqrt(4 / 3)), 2);
    expect(tQuantile(0.99, 2)).toBeCloseTo(6.964557, 5);
    expect(distanceLimitOf([0, 2, 3], 99)).toBe(3);
    // Refusals instead of a NaN statistic.
    expect(() => resample({ t: [0, 0], v: [1, 2] }, 4)).toThrow(AnalyticsInputError);
    expect(() => resample({ t: [0], v: [1] }, 4)).toThrow(AnalyticsInputError);
    expect(() => dtw([], [1], 1)).toThrow(AnalyticsInputError);
    expect(() => percentile([], 5)).toThrow(AnalyticsInputError);
  });

  it('DTW, alignment and band agree with the offline reference values (test/reference/profile-dtw.json)', () => {
    const ref = JSON.parse(readFileSync(new URL('./reference/profile-dtw.json', import.meta.url), 'utf8')) as {
      radius: number; curves: number[][]; distances: number[][]; medoid: number; aligned: number[][]; low: number[]; high: number[];
    };
    const d = ref.curves.map((x) => ref.curves.map((y) => dtw(x, y, ref.radius).distance));
    d.forEach((row, i) => row.forEach((v, k) => expect(v, `${i},${k}`).toBeCloseTo(ref.distances[i]![k]!, 9)));
    expect(medoidIndex(d)).toBe(ref.medoid);
    const medoid = ref.curves[ref.medoid]!;
    const aligned = ref.curves.map((c) => alignAlong(c, dtw(c, medoid, ref.radius).path, medoid.length));
    aligned.forEach((c, i) => c.forEach((v, j) => expect(v, `${i},${j}`).toBeCloseTo(ref.aligned[i]![j]!, 9)));
    const band = pointwiseBand(aligned, 5, 95, 0);
    band.low.forEach((v, j) => expect(v).toBeCloseTo(ref.low[j]!, 9));
    band.high.forEach((v, j) => expect(v).toBeCloseTo(ref.high[j]!, 9));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The method on known answers
// ---------------------------------------------------------------------------------------------------------------

/** mulberry32, as the synthetic history uses it. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = 1_780_000_000_000_000n;
const scope = { productCode: 'EXZ-250', familyCode: 'GB-T-01', equipmentType: 'TABLET_PRESS', step: 'compression', tag: 'force.main_kN' } as const;
const id = (n: number): string => `6a060000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/**
 * A press curve: ramp up over the first tenth, a plateau with a slow wave, ramp down over the last tenth; `warp`
 * moves the features later by that share of the step (the ends stay), `sag` lowers the middle third by that share.
 */
function pressCurve(n: number, opts: { warp?: number; sag?: number; noise?: number; count?: number; status?: (i: number) => 'GOOD' | 'UNCERTAIN' | 'BAD'; ended?: boolean; notReference?: string | null } = {}): ProfileCurve {
  const rand = prng(1000 + n);
  const count = opts.count ?? 120;
  const samples = [];
  for (let i = 0; i < count; i++) {
    const x0 = i / (count - 1);
    // A smooth monotone warp of time with fixed ends: x + w sin(pi x) moves the middle later by up to w.
    const x = Math.min(1, Math.max(0, x0 - (opts.warp ?? 0) * Math.sin(Math.PI * x0)));
    const ramp = x < 0.1 ? x / 0.1 : x > 0.9 ? (1 - x) / 0.1 : 1;
    const sag = opts.sag && x > 0.35 && x < 0.65 ? 1 - opts.sag : 1;
    const force = 12 * ramp * sag + 0.6 * Math.sin(6 * Math.PI * x) * ramp + (rand() - 0.5) * 2 * (opts.noise ?? 0.08);
    const status = opts.status?.(i) ?? 'GOOD';
    samples.push({ sourceUs: (T0 + BigInt(n) * 86_400_000_000n + BigInt(i) * 1_000_000n).toString(), value: status === 'BAD' ? null : Math.max(force, 0).toFixed(2), status });
  }
  return { ...scope, batchId: id(n), batchNumber: `EXZ-${String(n).padStart(3, '0')}`, equipmentCode: 'PRESS-01', unit: 'kN', ended: opts.ended ?? true, notReference: opts.notReference ?? null, samples };
}

/** The reference batches: each with its own small timing difference, within 3 % of the step either way. */
const referenceCurves = Array.from({ length: 20 }, (_, i) => pressCurve(i + 1, { warp: (prng(i + 1)() - 0.5) * 0.06 }));

function candidate(curves: readonly ProfileCurve[]): { model: ProfileModel; output: OutputDraft } {
  const r = GBP_DTW_BAND.run({ curves }, P, null);
  expect(r.outputs).toHaveLength(1);
  const output = r.outputs[0]!;
  return { model: output.values['model'] as unknown as ProfileModel, output };
}

const asReference = (model: ProfileModel, refId = 'e6000000-0000-4000-8000-000000000006'): ReferenceModel => ({
  id: refId, method: 'GBP.DTW_BAND', model: JSON.parse(JSON.stringify(model)) as Record<string, unknown>, modelSha256: profileModelSha256(model),
});

describe('method GBP.DTW_BAND (methods/profile/gbp.ts)', () => {
  const { model, output } = candidate(referenceCurves);

  it('fits a model candidate on the batches that may be reference batches, with its SHA-256 and the batches it left out', () => {
    expect(output).toMatchObject({ subjectKind: 'EQUIPMENT_STEP_TAG', subjectRef: 'EXZ-250|GB-T-01|TABLET_PRESS|compression|force.main_kN', kind: 'MODEL_CANDIDATE' });
    expect(output.values['modelSha256']).toBe(sha256Hex(canonicalText(model)));
    expect(model.batchIds).toEqual(referenceCurves.map((c) => c.batchId).sort());
    expect(model.batchIds).toContain(model.medoidBatchId);
    expect([model.reference.length, model.low.length, model.high.length]).toEqual([200, 200, 200]);
    expect(model.fit).toEqual({ points: 200, sakoeChiba: 0.1, radius: 20, bandLowPercentile: 5, bandHighPercentile: 95, bandTolerancePoints: 1, distancePercentile: 99 });
    expect(model.low.every((l, j) => l <= model.high[j]!)).toBe(true);
    // A re-fit on the same curves, in another order, is the same model.
    expect(profileModelSha256(candidate([...referenceCurves].reverse()).model)).toBe(profileModelSha256(model));
    // Batches that may not be references, curves not assessed, and too few batches.
    const excluded = [...referenceCurves, pressCurve(30, { notReference: 'not released' }), pressCurve(31, { ended: false })];
    const r = GBP_DTW_BAND.run({ curves: excluded }, P, null);
    expect(r.outputs[0]!.values['batches']).toBe(20);
    expect(r.outputs[0]!.reasons.map((x) => [x.code, x.text])).toEqual([
      ['CANDIDATE', expect.stringMatching(/^fitted on 20 batches/)],
      ['NOT_REFERENCE', 'EXZ-030 (PRESS-01): not released'],
      ['NOT_ASSESSED', 'EXZ-031 (PRESS-01): the step has not ended on the unit, so its curve is not complete'],
    ]);
    const few = GBP_DTW_BAND.run({ curves: referenceCurves.slice(0, 9) }, P, null);
    expect(few).toEqual({ outputs: [], flags: [], skipped: [{ subject: 'EXZ-250|GB-T-01|TABLET_PRESS|compression|force.main_kN', reason: '9 batches may be reference batches; a profile needs at least 10' }] });
  });

  it('a curve inside the band is not flagged; one outside it is flagged OUT_OF_BAND and DTW_DISTANCE with its reasons', () => {
    const inside = pressCurve(40);
    const outside = pressCurve(41, { sag: 0.18 });
    const r = GBP_DTW_BAND.run({ curves: [inside, outside] }, P, asReference(model));
    const byBatch = new Map(r.outputs.map((o) => [o.subjectRef, o.values]));
    expect(byBatch.get(inside.batchId)).toMatchObject({ status: 'PROFILED', points: 200, used: 120, droppedBad: 0, uncertain: 0, referenceSet: 'e6000000-0000-4000-8000-000000000006' });
    expect(byBatch.get(inside.batchId)!['outsideShare']).toBeLessThanOrEqual(0.1);
    expect(byBatch.get(inside.batchId)!['distance']).toBeLessThanOrEqual(model.distanceLimit);
    expect(byBatch.get(outside.batchId)!['outsideShare']).toBeGreaterThan(0.25);
    expect(r.flags.map((f) => [f.subjectRef, f.rule, f.severity])).toEqual([[outside.batchId, 'OUT_OF_BAND', 'ATTENTION'], [outside.batchId, 'DTW_DISTANCE', 'ATTENTION']]);
    expect(r.flags[0]!.reasons[0]!.text).toMatch(/^\d+(\.\d)? % of the 200 points of force.main_kN in compression fall outside the band of 20 reference batches \(flagged above 10 %\)$/);
    expect(r.flags[0]!.reasons[0]!.evidence).toEqual([{ kind: 'BATCH', ref: outside.batchId }, { kind: 'REFERENCE_SET', ref: 'e6000000-0000-4000-8000-000000000006' }]);
    expect(r.flags[1]!.reasons[0]!.text).toMatch(/^the DTW distance to the reference curve is [\d.]+ kN, against the references' 99th percentile of [\d.]+$/);
  });

  it('a time-shifted but good curve is aligned by DTW and not flagged; compared point by point it would be', () => {
    const shifted = pressCurve(50, { warp: 0.03 });
    const r = GBP_DTW_BAND.run({ curves: [shifted] }, P, asReference(model));
    expect(r.flags).toEqual([]);
    expect(r.outputs[0]!.values['outsideShare']).toBeLessThanOrEqual(0.1);
    // Without warping the same curve leaves the band.
    const prep = prepareCurve(shifted, P);
    if (!prep.ok) throw new Error(prep.why);
    expect(outsidePoints(prep.prepared.values, { low: [...model.low], high: [...model.high] }).length / 200).toBeGreaterThan(0.1);
  });

  it('BAD samples are dropped and counted, UNCERTAIN ones used and counted; missing samples or an open step give no profile, with the reason', () => {
    const someBad = pressCurve(60, { status: (i) => (i === 40 || i === 41 ? 'BAD' : i === 70 ? 'UNCERTAIN' : 'GOOD') });
    const gap = pressCurve(61, { status: (i) => (i >= 50 && i < 60 ? 'BAD' : 'GOOD') });
    const fewSamples = pressCurve(62, { count: 15 });
    const open = pressCurve(63, { ended: false });
    const r = GBP_DTW_BAND.run({ curves: [someBad, gap, fewSamples, open] }, P, asReference(model));
    const v = new Map(r.outputs.map((o) => [o.subjectRef, o.values]));
    expect(v.get(someBad.batchId)).toMatchObject({ status: 'PROFILED', used: 118, droppedBad: 2, uncertain: 1 });
    expect(v.get(gap.batchId)).toMatchObject({ status: 'NOT_ASSESSED', used: 110, droppedBad: 10, why: 'missing samples: a gap of 9.2 % of the curve\'s time between usable samples (at most 5 %)' });
    expect(v.get(fewSamples.batchId)).toMatchObject({ status: 'NOT_ASSESSED', why: '15 usable samples (0 BAD dropped); a curve needs at least 20' });
    expect(v.get(open.batchId)).toMatchObject({ status: 'NOT_ASSESSED', why: 'the step has not ended on the unit, so its curve is not complete' });
    expect(r.flags).toEqual([]);
    expect(r.skipped.map((s) => s.subject)).toEqual([gap.batchId, fewSamples.batchId, open.batchId]);
    // A curve of another scope is not scored by this reference set; a step without a series gives no profile.
    const other = { ...pressCurve(64), tag: 'force.pre_kN' };
    expect(GBP_DTW_BAND.run({ curves: [other] }, P, asReference(model))).toEqual({ outputs: [], flags: [], skipped: [] });
    expect(GBP_DTW_BAND.run({ curves: [] }, P, null)).toEqual({ outputs: [], flags: [], skipped: [] });
  });

  it('a reference set is scored only as fitted: other parameters skip it, a malformed model fails the run', () => {
    const wider = { ...P, sakoeChiba: 0.2 };
    const r = GBP_DTW_BAND.run({ curves: [pressCurve(70)] }, wider, asReference(model));
    expect(r.outputs).toEqual([]);
    expect(r.skipped[0]!.reason).toMatch(/was fitted with other parameters than this method version's/);
    expect(() => GBP_DTW_BAND.run({ curves: [pressCurve(70)] }, P, { ...asReference(model), model: { ...model, low: [1, 2] } })).toThrow(AnalyticsInputError);
    expect(() => profileModelOf({ method: 'MSPC.PCA' })).toThrow(/does not hold a GBP.DTW_BAND model/);
    expect(profileModelOf(asReference(model).model)).toEqual(JSON.parse(JSON.stringify(model)));
  });

  it('[DI-52] the seeded abnormal press curve is flagged and the 20 normal ones are not', () => {
    const h = analyticsHistory();
    const curves: ProfileCurve[] = h.pressCurves.map((c) => ({
      productCode: HISTORY_PRODUCT.code, familyCode: HISTORY_PRODUCT.family, equipmentType: c.equipment_type, step: c.step, tag: c.tag, batchId: c.batch_id,
      batchNumber: c.batch_id.slice(-4), equipmentCode: c.equipment_code, unit: c.unit, ended: true, notReference: null,
      samples: c.samples.map((s) => ({ sourceUs: (BigInt(Date.parse(s.source_time)) * 1000n).toString(), value: s.status === 'BAD' ? null : s.raw_text, status: s.status })),
    }));
    expect(curves).toHaveLength(HISTORY_SEEDS.curves);
    const abnormal = h.pressCurves.find((c) => c.abnormal)!.batch_id;
    // QA's reference set: the candidate on every curve, the abnormal one included (the percentile band and the
    // log-normal limit are robust to it), and the candidate on the 20 normal ones.
    for (const refs of [curves, curves.filter((c) => c.batchId !== abnormal)]) {
      const fitted = candidate(refs).model;
      const r = GBP_DTW_BAND.run({ curves }, P, asReference(fitted));
      expect(r.outputs).toHaveLength(21);
      expect(r.outputs.every((o) => o.values['status'] === 'PROFILED')).toBe(true);
      expect([...new Set(r.flags.map((f) => f.subjectRef))]).toEqual([abnormal]);
      expect(r.flags.map((f) => f.rule)).toEqual(['OUT_OF_BAND', 'DTW_DISTANCE']);
      expect(h.expected).toContainEqual(expect.objectContaining({ method: 'GBP.DTW_BAND', rule: 'OUT_OF_BAND', subjectRef: abnormal }));
      // The BAD samples of batch 3 are dropped and counted.
      expect(r.outputs.find((o) => o.subjectRef === curves[2]!.batchId)!.values).toMatchObject({ droppedBad: 2, used: 118 });
    }
  });
});
