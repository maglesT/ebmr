/**
 * Distribution quantiles (ADR 0020 point 7: the @stdlib distribution packages, Apache-2.0, pinned in slice 6A-1 per
 * D-6A-23). The methods of 6A-2 (control limits, capability intervals, slope tests), 6A-3 (T-squared and Q limits) and
 * 6A-4 (baselines) take their quantiles from here, never from an in-house approximation. Each function refuses a
 * probability outside (0, 1) or a non-positive parameter, instead of returning NaN into a statistic.
 */
import betaQuantileOf from '@stdlib/stats-base-dists-beta-quantile';
import chiSquareQuantileOf from '@stdlib/stats-base-dists-chisquare-quantile';
import fQuantileOf from '@stdlib/stats-base-dists-f-quantile';
import normalQuantileOf from '@stdlib/stats-base-dists-normal-quantile';
import tQuantileOf from '@stdlib/stats-base-dists-t-quantile';
import { AnalyticsInputError } from '../errors.ts';

function probability(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) throw new AnalyticsInputError(`a quantile needs a probability strictly between 0 and 1, not ${String(p)}`, p);
  return p;
}

function positive(name: string, v: number): number {
  if (!Number.isFinite(v) || v <= 0) throw new AnalyticsInputError(`${name} must be a positive finite number, not ${String(v)}`, v);
  return v;
}

function finite(result: number, what: string): number {
  if (!Number.isFinite(result)) throw new AnalyticsInputError(`the ${what} quantile is not finite`, result);
  return result;
}

/** The standard normal quantile (mean 0, standard deviation 1). */
export function normalQuantile(p: number): number {
  return finite(normalQuantileOf(probability(p), 0, 1), 'normal');
}

/** Student's t quantile with `df` degrees of freedom. */
export function tQuantile(p: number, df: number): number {
  return finite(tQuantileOf(probability(p), positive('degrees of freedom', df)), 't');
}

/** The chi-square quantile with `k` degrees of freedom. */
export function chiSquareQuantile(p: number, k: number): number {
  return finite(chiSquareQuantileOf(probability(p), positive('degrees of freedom', k)), 'chi-square');
}

/** The F quantile with `d1` and `d2` degrees of freedom. */
export function fQuantile(p: number, d1: number, d2: number): number {
  return finite(fQuantileOf(probability(p), positive('numerator degrees of freedom', d1), positive('denominator degrees of freedom', d2)), 'F');
}

/** The beta quantile with shape parameters `a` and `b`. */
export function betaQuantile(p: number, a: number, b: number): number {
  return finite(betaQuantileOf(probability(p), positive('shape a', a), positive('shape b', b)), 'beta');
}
