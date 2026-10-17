/**
 * DRIFT.TREND (slice 6A-2; D-6A-9, D-6A-2-5): a warning before a critical value drifts out of its specification, per
 * product, MBR family and item. Either signal raises an ATTENTION flag:
 *   DRIFT_SLOPE  the least-squares slope over the last `slopeWindow` batches is significant (two-sided t test,
 *                p < slopeAlpha) and the fitted line reaches a specification limit in its direction within
 *                `projectBatches` batches after the newest one (or is already beyond it);
 *   DRIFT_EWMA   the EWMA (lambda `ewmaLambda`) of the newest batch lies beyond centre +- L sigma_z, with
 *                sigma_z = sigma sqrt(lambda / (2 - lambda) (1 - (1 - lambda)^(2 i))). The centre is the master's target
 *                (else the mean of every batch) and sigma the mean moving range of every batch over d2.
 * The signals concern the newest batch, so a run flags a drift that is current, not one that has passed. A series with
 * fewer batches than the window is skipped with the reason.
 */
import type { Method, MethodResult, Parameters, ReferenceModel, Skipped } from '../../method.ts';
import { statOf } from '../../numeric/from-decimal.ts';
import type { FlagDraft, OutputDraft, Reason } from '../../types.ts';
import { seriesRef, specificationValues, type BatchValueInput } from '../spc/input.ts';
import { D2_TWO, leastSquares, mean, movingRanges } from '../spc/stats.ts';

export interface DriftParameters extends Parameters {
  readonly slopeWindow: number;
  readonly slopeAlpha: number;
  readonly projectBatches: number;
  readonly ewmaLambda: number;
  readonly ewmaL: number;
}

/** The EWMA of `x` from `centre`, with its limits half-widths per point. */
export function ewma(x: readonly number[], centre: number, sigma: number, lambda: number, L: number): { z: number[]; halfWidth: number[] } {
  const z: number[] = [];
  const halfWidth: number[] = [];
  let prev = centre;
  x.forEach((v, k) => {
    prev = lambda * v + (1 - lambda) * prev;
    z.push(prev);
    halfWidth.push(L * sigma * Math.sqrt((lambda / (2 - lambda)) * (1 - Math.pow(1 - lambda, 2 * (k + 1)))));
  });
  return { z, halfWidth };
}

/**
 * Batches after the newest until the fitted line reaches the limit it heads for (0 when it is already beyond), or null
 * when it heads for no stated limit.
 */
export function batchesToCross(fitNow: number, slope: number, lower: number | null, upper: number | null): number | null {
  if (slope > 0 && upper !== null) return fitNow >= upper ? 0 : (upper - fitNow) / slope;
  if (slope < 0 && lower !== null) return fitNow <= lower ? 0 : (lower - fitNow) / slope;
  return null;
}

export function runDrift(input: BatchValueInput, params: DriftParameters, _ref: ReferenceModel | null): MethodResult {
  const outputs: OutputDraft[] = [];
  const flags: FlagDraft[] = [];
  const skipped: Skipped[] = [];
  for (const s of input.series) {
    const subjectRef = seriesRef(s);
    const w = params.slopeWindow;
    if (s.points.length < w) {
      skipped.push({ subject: subjectRef, reason: `a drift check needs the last ${w.toString()} batches; there are ${s.points.length.toString()}` });
      continue;
    }
    const x = s.points.map((p) => statOf(p.value));
    const lower = s.specification.lower === null ? null : statOf(s.specification.lower);
    const upper = s.specification.upper === null ? null : statOf(s.specification.upper);
    const recent = x.slice(-w);
    const window = s.points.slice(-w);
    const fit = leastSquares(recent);
    const fitNow = fit.intercept + fit.slope * (w - 1);
    const toCross = batchesToCross(fitNow, fit.slope, lower, upper);
    const slopeSignal = fit.p < params.slopeAlpha && toCross !== null && toCross <= params.projectBatches;
    const centre = s.specification.target === null ? mean(x) : statOf(s.specification.target);
    const sigma = mean(movingRanges(x)) / D2_TWO;
    const e = sigma > 0 ? ewma(x, centre, sigma, params.ewmaLambda, params.ewmaL) : null;
    const last = x.length - 1;
    const ewmaSignal = e !== null && Math.abs(e.z[last]! - centre) > e.halfWidth[last]!;
    const newest = s.points[last]!;
    const values: OutputDraft['values'] = {
      product: s.product, family: s.family, item: s.item, ...specificationValues(s.specification),
      window: w, slope: fit.slope, slopeT: fit.t, slopeP: fit.p, fittedNewest: fitNow, projectedAt: fitNow + fit.slope * params.projectBatches,
      slopeSignal: slopeSignal ? 'YES' : 'NO', ewmaSignal: ewmaSignal ? 'YES' : 'NO', centre, sigma,
      batchIds: s.points.map((p) => p.batchId).join(','),
      ...(toCross === null ? {} : { batchesToCross: toCross }),
      ...(e === null ? {} : { ewma: e.z, ewmaUpper: e.z.map((_, k) => centre + e.halfWidth[k]!), ewmaLower: e.z.map((_, k) => centre - e.halfWidth[k]!) }),
    };
    const reasons: Reason[] = [{
      code: 'DRIFT_CHECK',
      text: `Slope over the last ${w.toString()} batches (p = ${fit.p.toPrecision(2)}) and EWMA (lambda ${params.ewmaLambda.toString()}, L ${params.ewmaL.toString()}) from ${s.specification.target === null ? 'the mean of every batch' : 'the master\'s target'}`,
    }];
    outputs.push({ subjectKind: 'PRODUCT_ITEM', subjectRef, kind: 'DRIFT', values, reasons });
    const evidence = window.map((p) => ({ kind: 'BATCH', ref: p.batchId }));
    if (slopeSignal) {
      const limit = fit.slope > 0 ? `upper limit ${s.specification.upper ?? ''}` : `lower limit ${s.specification.lower ?? ''}`;
      const when = toCross === 0 ? 'the fitted line is already beyond it' : `reached in about ${toCross!.toPrecision(2)} batches`;
      flags.push({
        subjectKind: 'PRODUCT_ITEM', subjectRef, rule: 'DRIFT_SLOPE', severity: 'ATTENTION',
        reasons: [{ code: 'DRIFT_SLOPE', text: `The last ${w.toString()} batches (${window[0]!.batchNumber} to ${newest.batchNumber}) of ${s.item} trend ${fit.slope > 0 ? 'up' : 'down'} (p = ${fit.p.toPrecision(2)}) toward the ${limit}: ${when}`, evidence }],
      });
    }
    if (ewmaSignal) {
      flags.push({
        subjectKind: 'PRODUCT_ITEM', subjectRef, rule: 'DRIFT_EWMA', severity: 'ATTENTION',
        reasons: [{ code: 'DRIFT_EWMA', text: `The EWMA of ${s.item} at batch ${newest.batchNumber} lies ${e!.z[last]! > centre ? 'above' : 'below'} its ${params.ewmaL.toString()} sigma limit around ${s.specification.target === null ? 'the mean' : 'the master\'s target'}`,
                    evidence: [{ kind: 'BATCH', ref: newest.batchId }] }],
      });
    }
  }
  return { outputs, flags, skipped };
}

export const DRIFT_TREND: Method<BatchValueInput, DriftParameters> = { id: 'DRIFT.TREND', versions: [1], run: runDrift };
