/**
 * CAP.INDEX (slice 6A-2; D-6A-8): process capability of a critical item per product and MBR family, against the
 * master's specification limits (echoed as its decimal text). Shown, never flagged.
 *
 *   Ppk = min(USL - mean, mean - LSL) / (3 s), with s the overall sample standard deviation;
 *   Cpk = the same with the within sigma: the mean moving range over d2 (2 / sqrt(pi)), batches in completion order.
 * With one limit only, the index is that side's. Each comes with Bissell's approximate interval,
 *   k +- z sqrt(1 / (9 n) + k^2 / (2 (n - 1))), z the normal quantile of (1 + confidence) / 2.
 * Normality: the Anderson-Darling statistic with the small-sample adjustment A*2 = A2 (1 + 0.75 / n + 2.25 / n^2) and
 * the p-value of D'Agostino and Stephens (1986, table 4.9); the note says whether the data depart from normality at the
 * 5 % level. No transformation of non-normal data in v1 (D-6A-8).
 * Below `minBatches` batches, or without a specification limit, the output says NOT_SHOWN with the reason and gives no
 * index (D-6A-8: capability is shown from 25 batches).
 */
import type { Method, MethodResult, Parameters, ReferenceModel } from '../../method.ts';
import { statOf } from '../../numeric/from-decimal.ts';
import { normalQuantile } from '../../numeric/quantiles.ts';
import type { OutputDraft } from '../../types.ts';
import { seriesRef, specificationValues, type BatchValueInput } from '../spc/input.ts';
import { D2_TWO, logNormalCdf, mean, movingRanges, sampleSd } from '../spc/stats.ts';

export interface CapabilityParameters extends Parameters {
  readonly minBatches: number;
  readonly confidence: number;
}

/** The capability index of one side or both (null when no limit is given). */
export function capabilityIndex(m: number, sigma: number, lower: number | null, upper: number | null): number | null {
  const sides: number[] = [];
  if (upper !== null) sides.push((upper - m) / (3 * sigma));
  if (lower !== null) sides.push((m - lower) / (3 * sigma));
  return sides.length === 0 ? null : Math.min(...sides);
}

/** Bissell's interval of a capability index from n values. */
export function bissellInterval(k: number, n: number, confidence: number): { lower: number; upper: number } {
  const z = normalQuantile((1 + confidence) / 2);
  const se = Math.sqrt(1 / (9 * n) + (k * k) / (2 * (n - 1)));
  return { lower: k - z * se, upper: k + z * se };
}

/** The Anderson-Darling normality test with estimated mean and sd: the adjusted statistic A*2 and its p-value. */
export function andersonDarling(xs: readonly number[]): { statistic: number; adjusted: number; pValue: number } {
  const n = xs.length;
  const m = mean(xs);
  const s = sampleSd(xs);
  const y = [...xs].sort((a, b) => a - b).map((v) => (v - m) / s);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (2 * i + 1) * (logNormalCdf(y[i]!) + logNormalCdf(-y[n - 1 - i]!));
  const a2 = -n - sum / n;
  const a = a2 * (1 + 0.75 / n + 2.25 / (n * n));
  let p: number;
  if (a >= 0.6) p = Math.exp(1.2937 - 5.709 * a + 0.0186 * a * a);
  else if (a >= 0.34) p = Math.exp(0.9177 - 4.279 * a - 1.38 * a * a);
  else if (a >= 0.2) p = 1 - Math.exp(-8.318 + 42.796 * a - 59.938 * a * a);
  else p = 1 - Math.exp(-13.436 + 101.14 * a - 223.73 * a * a);
  return { statistic: a2, adjusted: a, pValue: Math.min(1, Math.max(0, p)) };
}

export function runCapability(input: BatchValueInput, params: CapabilityParameters, _ref: ReferenceModel | null): MethodResult {
  const outputs: OutputDraft[] = [];
  for (const s of input.series) {
    const subjectRef = seriesRef(s);
    const n = s.points.length;
    const lower = s.specification.lower === null ? null : statOf(s.specification.lower);
    const upper = s.specification.upper === null ? null : statOf(s.specification.upper);
    const base = { product: s.product, family: s.family, item: s.item, batches: n, ...specificationValues(s.specification) };
    const notShown = (reason: string): OutputDraft => ({
      subjectKind: 'PRODUCT_ITEM', subjectRef, kind: 'CAPABILITY', values: { ...base, status: 'NOT_SHOWN', notShownReason: reason }, reasons: [{ code: 'NOT_SHOWN', text: reason }],
    });
    if (n < params.minBatches) {
      outputs.push(notShown(`Capability is shown from ${params.minBatches.toString()} completed batches; there are ${n.toString()}`));
      continue;
    }
    if (lower === null && upper === null) {
      outputs.push(notShown('The master states no specification limit for this item'));
      continue;
    }
    const x = s.points.map((p) => statOf(p.value));
    const m = mean(x);
    const overall = sampleSd(x);
    const within = mean(movingRanges(x)) / D2_TWO;
    if (!(overall > 0) || !(within > 0)) {
      outputs.push(notShown('The values show no variation, so no capability index can be computed'));
      continue;
    }
    const ppk = capabilityIndex(m, overall, lower, upper)!;
    const cpk = capabilityIndex(m, within, lower, upper)!;
    const ppkI = bissellInterval(ppk, n, params.confidence);
    const cpkI = bissellInterval(cpk, n, params.confidence);
    const ad = andersonDarling(x);
    const normal = ad.pValue >= 0.05;
    const note = normal
      ? 'No evidence against normality at the 5 % level (Anderson-Darling); the indices assume normal data'
      : `The values depart from normality (Anderson-Darling p = ${ad.pValue.toPrecision(2)}); read the indices with care, no transformation is applied`;
    outputs.push({
      subjectKind: 'PRODUCT_ITEM',
      subjectRef,
      kind: 'CAPABILITY',
      values: {
        ...base, status: 'SHOWN', mean: m, sigmaOverall: overall, sigmaWithin: within, confidence: params.confidence,
        ppk, ppkLower: ppkI.lower, ppkUpper: ppkI.upper, cpk, cpkLower: cpkI.lower, cpkUpper: cpkI.upper,
        andersonDarling: ad.adjusted, andersonDarlingP: ad.pValue, normalityNote: note,
      },
      reasons: [
        { code: 'CAPABILITY', text: `Cpk (within sigma from the mean moving range) and Ppk (overall sigma) of ${n.toString()} batches with Bissell ${(params.confidence * 100).toPrecision(3)} % intervals` },
        { code: normal ? 'NORMALITY_OK' : 'NORMALITY_DEPARTS', text: note },
      ],
    });
  }
  return { outputs, flags: [], skipped: [] };
}

export const CAP_INDEX: Method<BatchValueInput, CapabilityParameters> = { id: 'CAP.INDEX', versions: [1], run: runCapability };
