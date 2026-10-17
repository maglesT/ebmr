/**
 * The curve arithmetic of the golden batch profile (method GBP.DTW_BAND, slice 6A-6; D-6A-16, D-6A-6-3, D-6A-6-4):
 * resampling to normalised step time, dynamic time warping with a Sakoe-Chiba band, alignment to a reference curve,
 * the medoid, pointwise percentiles and the band with its timing tolerance. Pure functions of their arguments: no clock,
 * no randomness, no I/O. Every tie is broken by a fixed rule, so a re-run on the same curves gives the same result.
 */
import { AnalyticsInputError } from '../../errors.ts';

/** A curve as time and value pairs (times strictly increasing; both are statistics, never GMP values). */
export interface TimedCurve {
  readonly t: readonly number[];
  readonly v: readonly number[];
}

/**
 * The curve resampled to `points` equally spaced instants of normalised time, from its first instant (0) to its last
 * (1), by linear interpolation between the neighbouring samples.
 */
export function resample(curve: TimedCurve, points: number): number[] {
  const { t, v } = curve;
  if (t.length !== v.length) throw new AnalyticsInputError('a curve has as many times as values', curve);
  if (t.length < 2) throw new AnalyticsInputError('a curve needs at least two samples to resample', curve);
  if (!Number.isInteger(points) || points < 2) throw new AnalyticsInputError(`a curve is resampled to at least 2 points, not ${String(points)}`, points);
  for (let i = 1; i < t.length; i++) if (!(t[i]! > t[i - 1]!)) throw new AnalyticsInputError('the times of a curve increase strictly', curve);
  const t0 = t[0]!;
  const span = t[t.length - 1]! - t0;
  const out: number[] = [];
  let s = 0;
  for (let k = 0; k < points; k++) {
    const x = k === points - 1 ? t[t.length - 1]! : t0 + (span * k) / (points - 1);
    while (s < t.length - 2 && t[s + 1]! < x) s++;
    const a = t[s]!;
    const b = t[s + 1]!;
    const w = Math.min(1, Math.max(0, (x - a) / (b - a)));
    out.push(v[s]! + (v[s + 1]! - v[s]!) * w);
  }
  return out;
}

/** The Sakoe-Chiba radius in points: the band's share of the curve length, rounded to the nearest point. */
export function bandRadius(points: number, share: number): number {
  return Math.round(points * share);
}

export interface Warp {
  /** The square root of the least sum of squared differences along a warping path inside the band. */
  readonly distance: number;
  /** The warping path from (0, 0) to (n - 1, m - 1) as [index in a, index in b] pairs. */
  readonly path: readonly (readonly [number, number])[];
}

/**
 * Dynamic time warping of `a` onto `b` within a Sakoe-Chiba band of `radius` points (|i - j| <= radius for curves of
 * equal length; the band follows the diagonal for unequal ones). The step pattern is the symmetric one (match,
 * insertion, deletion), the local cost the squared difference. The path is traced back preferring the diagonal, then a
 * step in `a`, then a step in `b`.
 */
export function dtw(a: readonly number[], b: readonly number[], radius: number): Warp {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) throw new AnalyticsInputError('dynamic time warping needs two non-empty curves', { n, m });
  if (!Number.isInteger(radius) || radius < 0) throw new AnalyticsInputError(`the band radius is a whole number of points, not ${String(radius)}`, radius);
  // The band around the diagonal, widened so that a path from corner to corner exists for unequal lengths.
  const r = Math.max(radius, Math.abs(n - m));
  const centre = (i: number): number => (n === 1 ? 0 : (i * (m - 1)) / (n - 1));
  const lo = (i: number): number => Math.max(0, Math.ceil(centre(i) - r));
  const hi = (i: number): number => Math.min(m - 1, Math.floor(centre(i) + r));
  const cost: Float64Array[] = [];
  for (let i = 0; i < n; i++) {
    const row = new Float64Array(m).fill(Number.POSITIVE_INFINITY);
    for (let j = lo(i); j <= hi(i); j++) {
      const d = (a[i]! - b[j]!) ** 2;
      if (i === 0 && j === 0) {
        row[j] = d;
        continue;
      }
      const diag = i > 0 && j > 0 ? cost[i - 1]![j - 1]! : Number.POSITIVE_INFINITY;
      const up = i > 0 ? cost[i - 1]![j]! : Number.POSITIVE_INFINITY;
      const left = j > 0 ? row[j - 1]! : Number.POSITIVE_INFINITY;
      row[j] = d + Math.min(diag, up, left);
    }
    cost.push(row);
  }
  const total = cost[n - 1]![m - 1]!;
  if (!Number.isFinite(total)) throw new AnalyticsInputError('no warping path inside the band', { n, m, radius });
  const path: [number, number][] = [[n - 1, m - 1]];
  let i = n - 1;
  let j = m - 1;
  while (i > 0 || j > 0) {
    const diag = i > 0 && j > 0 ? cost[i - 1]![j - 1]! : Number.POSITIVE_INFINITY;
    const up = i > 0 ? cost[i - 1]![j]! : Number.POSITIVE_INFINITY;
    const left = j > 0 ? cost[i]![j - 1]! : Number.POSITIVE_INFINITY;
    if (diag <= up && diag <= left) {
      i -= 1;
      j -= 1;
    } else if (up <= left) {
      i -= 1;
    } else {
      j -= 1;
    }
    path.push([i, j]);
  }
  path.reverse();
  return { distance: Math.sqrt(total), path };
}

/**
 * `curve` aligned to the reference of length `length` along a warping path of `curve` onto it: each reference point
 * takes the mean of the curve's points the path pairs with it.
 */
export function alignAlong(curve: readonly number[], path: Warp['path'], length: number): number[] {
  const sum = new Float64Array(length);
  const count = new Float64Array(length);
  for (const [i, j] of path) {
    sum[j] = sum[j]! + curve[i]!;
    count[j] = count[j]! + 1;
  }
  return Array.from(sum, (s, j) => {
    if (count[j] === 0) throw new AnalyticsInputError('a warping path covers every reference point', j);
    return s / count[j]!;
  });
}

/**
 * The medoid of curves: the index of the one with the least sum of DTW distances to the others (ties: the lowest
 * index, so the order the caller gives decides). `distances[i][k]` is DTW(curve i, curve k).
 */
export function medoidIndex(distances: readonly (readonly number[])[]): number {
  let best = 0;
  let bestSum = Number.POSITIVE_INFINITY;
  distances.forEach((row, i) => {
    const s = row.reduce((acc, d, k) => (k === i ? acc : acc + d), 0);
    if (s < bestSum) {
      bestSum = s;
      best = i;
    }
  });
  return best;
}

/** The `p`th percentile (0 to 100) of `xs` by linear interpolation between order statistics (Hyndman and Fan type 7). */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) throw new AnalyticsInputError('a percentile of no values', xs);
  if (!(p >= 0 && p <= 100)) throw new AnalyticsInputError(`a percentile is between 0 and 100, not ${String(p)}`, p);
  const s = [...xs].sort((x, y) => x - y);
  const h = ((s.length - 1) * p) / 100;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
}

export interface Band {
  readonly low: number[];
  readonly high: number[];
}

/**
 * The pointwise band of aligned curves: at each point the `lowP`th and `highP`th percentile of the curves there, then
 * widened by a timing tolerance of `tolerance` points: the band at point j runs from the lowest low to the highest high
 * within j - tolerance to j + tolerance (D-6A-6-3).
 */
export function pointwiseBand(aligned: readonly (readonly number[])[], lowP: number, highP: number, tolerance: number): Band {
  if (aligned.length === 0) throw new AnalyticsInputError('a band of no curves', aligned);
  const length = aligned[0]!.length;
  if (aligned.some((c) => c.length !== length)) throw new AnalyticsInputError('the curves of a band have one length', aligned.map((c) => c.length));
  if (!(lowP < highP)) throw new AnalyticsInputError('the low percentile of a band is below its high one', { lowP, highP });
  const low0: number[] = [];
  const high0: number[] = [];
  for (let j = 0; j < length; j++) {
    const at = aligned.map((c) => c[j]!);
    low0.push(percentile(at, lowP));
    high0.push(percentile(at, highP));
  }
  const low: number[] = [];
  const high: number[] = [];
  for (let j = 0; j < length; j++) {
    let l = Number.POSITIVE_INFINITY;
    let h = Number.NEGATIVE_INFINITY;
    for (let k = Math.max(0, j - tolerance); k <= Math.min(length - 1, j + tolerance); k++) {
      l = Math.min(l, low0[k]!);
      h = Math.max(h, high0[k]!);
    }
    low.push(l);
    high.push(h);
  }
  return { low, high };
}

/** The points of `curve` strictly outside the band (the indices, in order). */
export function outsidePoints(curve: readonly number[], band: Band): number[] {
  const out: number[] = [];
  curve.forEach((x, j) => {
    if (x < band.low[j]! || x > band.high[j]!) out.push(j);
  });
  return out;
}

/** The mean and the sample standard deviation (n - 1) of `xs`. */
export function meanSd(xs: readonly number[]): { mean: number; sd: number } {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = xs.length < 2 ? 0 : Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
  return { mean, sd };
}
