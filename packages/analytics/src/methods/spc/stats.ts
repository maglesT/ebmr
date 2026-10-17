/**
 * Statistics shared by the methods of slice 6A-2 (SPC, capability, drift, rates). Pure functions of numbers that came
 * through statOf; no clock, no randomness, no I/O. Distribution functions come from pinned libraries (D-6A-23), never
 * from an in-house approximation: the normal distribution function from @stdlib's erfc (0.2.5, pinned in 6A-2:
 * D-6A-2-10; the normal quantile loses its precision below 1e-16, too soon for the Anderson-Darling tails), the t
 * distribution function as the inverse of the pinned t quantile, found by bisection in log-probability.
 */
import erfc from '@stdlib/math-base-special-erfc';
import { AnalyticsInputError } from '../../errors.ts';
import { tQuantile } from '../../numeric/quantiles.ts';

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new AnalyticsInputError('the mean of no values', xs);
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** The sample standard deviation (n - 1 in the denominator). */
export function sampleSd(xs: readonly number[]): number {
  if (xs.length < 2) throw new AnalyticsInputError('a standard deviation needs two or more values', xs);
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (xs.length - 1));
}

/** The moving ranges |x[i] - x[i-1]| (one fewer than the values). */
export function movingRanges(xs: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i++) out.push(Math.abs(xs[i]! - xs[i - 1]!));
  return out;
}

/** d2 for a moving range of two: the mean range of two standard normal values, 2 / sqrt(pi). */
export const D2_TWO = 2 / Math.sqrt(Math.PI);
/** d3 for a moving range of two: the standard deviation of that range, sqrt(2 (1 - 2 / pi)). */
export const D3_TWO = Math.sqrt(2 * (1 - 2 / Math.PI));
/** D4 for a moving range of two (the MR chart's upper limit factor): 1 + 3 d3 / d2 (3.267). */
export const D4_TWO = 1 + (3 * D3_TWO) / D2_TWO;

/**
 * c4(n), the bias factor of the sample standard deviation of n normal values: sqrt(2 / (n - 1)) G(n) with
 * G(n) = Gamma(n / 2) / Gamma((n - 1) / 2). G follows the exact recurrence G(n + 1) = ((n - 1) / 2) / G(n) from
 * G(2) = 1 / sqrt(pi), so no gamma approximation is involved.
 */
export function c4(n: number): number {
  if (!Number.isInteger(n) || n < 2) throw new AnalyticsInputError(`c4 needs an integer subgroup size of at least 2, not ${String(n)}`, n);
  let g = 1 / Math.sqrt(Math.PI);
  for (let k = 2; k < n; k++) g = (k - 1) / 2 / g;
  return Math.sqrt(2 / (n - 1)) * g;
}

const LOG_FLOOR = Math.log(1e-300);

/**
 * The natural log of the lower-tail probability P(X <= x) of a distribution symmetric about 0 whose quantile is
 * `quantile`, for x <= 0 (so the probability is at most 0.5): bisection in log-probability.
 */
function logLowerTailSymmetric(quantile: (p: number) => number, x: number): number {
  if (x > 0) throw new AnalyticsInputError('logLowerTailSymmetric takes x <= 0', x);
  if (x === 0) return Math.log(0.5);
  let lo = LOG_FLOOR;
  let hi = Math.log(0.5);
  if (quantile(Math.exp(lo)) >= x) return lo;
  for (let i = 0; i < 200 && hi - lo > 1e-15 * Math.max(1, Math.abs(lo)); i++) {
    const mid = (lo + hi) / 2;
    if (quantile(Math.exp(mid)) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** P(Z <= z) for a standard normal Z: erfc(-z / sqrt 2) / 2. */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) throw new AnalyticsInputError('the normal distribution function of a non-finite value', z);
  return erfc(-z / Math.SQRT2) / 2;
}

/** ln P(Z <= z); beyond the double range of the probability (z below about -38) it is ln of the smallest double. */
export function logNormalCdf(z: number): number {
  const p = normalCdf(z);
  return z <= 0 ? Math.log(Math.max(p, Number.MIN_VALUE)) : Math.log1p(-normalCdf(-z));
}

/** The two-sided p-value of a t statistic with `df` degrees of freedom: 2 P(T >= |t|). */
export function tTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0;
  const lower = Math.exp(logLowerTailSymmetric((p) => tQuantile(p, df), -Math.abs(t)));
  return Math.min(1, 2 * lower);
}

/** The ordinary least-squares line through (0, y0), (1, y1), ...: slope, intercept, slope's t statistic and p-value. */
export function leastSquares(ys: readonly number[]): { slope: number; intercept: number; t: number; p: number; residualSd: number } {
  const n = ys.length;
  if (n < 3) throw new AnalyticsInputError('a slope test needs three or more values', ys);
  const xbar = (n - 1) / 2;
  const ybar = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (i - xbar) * (i - xbar);
    sxy += (i - xbar) * (ys[i]! - ybar);
  }
  const slope = sxy / sxx;
  const intercept = ybar - slope * xbar;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i]! - (intercept + slope * i);
    sse += r * r;
  }
  const residualSd = Math.sqrt(sse / (n - 2));
  // A perfect line: the slope is certain (t infinite, p 0) unless it is flat.
  if (residualSd === 0) return { slope, intercept, t: slope === 0 ? 0 : Math.sign(slope) * Number.MAX_VALUE, p: slope === 0 ? 1 : 0, residualSd };
  const t = slope / (residualSd / Math.sqrt(sxx));
  return { slope, intercept, t, p: tTwoSidedP(t, n - 2), residualSd };
}
