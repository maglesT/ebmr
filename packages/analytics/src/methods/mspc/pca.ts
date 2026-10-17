/**
 * The arithmetic of MSPC.PCA (slice 6A-3; D-6A-11, D-6A-3-*): autoscaling, PCA by singular value decomposition
 * (ml-matrix through numeric/linalg.ts), Hotelling's T-squared and Q (SPE) with their limits, and each variable's
 * contribution to both. Pure functions of numbers; the method (index.ts) turns decimal text into these numbers through
 * statOf. The definitions are the textbook ones, checked against NumPy and SciPy in test/reference/mspc_reference.py:
 *   - autoscaling centres each variable on its mean and divides it by its sample standard deviation (n - 1);
 *   - eigenvalue j is s_j^2 / (n - 1) of the autoscaled matrix's singular values; a loading vector is signed so that its
 *     element of largest magnitude is positive (the first such element on a tie), so the scores are reproducible;
 *   - the components kept are the fewest that reach the cumulative variance target, at most the maximum and at most
 *     p - 1 (so a residual, and Q, remain);
 *   - T-squared limit of a reference batch: (n - 1)^2 / n times the beta quantile with shapes k / 2 and (n - k - 1) / 2;
 *     of a new batch: k (n - 1)(n + 1) / (n (n - k)) times the F quantile with k and n - k degrees of freedom;
 *   - Q limit: Jackson and Mudholkar from the residual eigenvalues (theta 1 to 3 and h0); when h0 or the bracket is not
 *     positive (widely spread residual eigenvalues) Box's approximation g chi-square(h), g = theta2 / theta1,
 *     h = theta1^2 / theta2, and the model says which;
 *   - contributions: to T-squared, variable j gives z_j times the sum over components of t_a p_ja / lambda_a; to Q, its
 *     squared residual. Each set sums to its statistic.
 */
import { AnalyticsInputError } from '../../errors.ts';
import { Matrix, SingularValueDecomposition } from '../../numeric/linalg.ts';
import { betaQuantile, chiSquareQuantile, fQuantile, normalQuantile } from '../../numeric/quantiles.ts';

export type QLimitMethod = 'JACKSON_MUDHOLKAR' | 'BOX';

export interface QLimit {
  readonly limit: number;
  readonly method: QLimitMethod;
}

/** A fitted PCA model: what scoring a batch needs (the method adds its scope, batches and fit parameters). */
export interface PcaFit {
  readonly n: number;
  readonly mean: readonly number[];
  readonly sd: readonly number[];
  /** All p eigenvalues, largest first. */
  readonly eigenvalues: readonly number[];
  /** Each eigenvalue's share of the total variance. */
  readonly explained: readonly number[];
  readonly components: number;
  /** p rows of k loadings. */
  readonly loadings: readonly (readonly number[])[];
  readonly t2Reference: number;
  readonly t2New: number;
  readonly q: number;
  readonly qMethod: QLimitMethod;
}

export interface PcaScore {
  readonly scores: number[];
  readonly t2: number;
  readonly q: number;
  readonly t2Contributions: number[];
  readonly qContributions: number[];
}

const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);

/** Each column's mean and sample standard deviation (n - 1). */
export function columnMoments(rows: readonly (readonly number[])[]): { mean: number[]; sd: number[] } {
  const n = rows.length;
  const p = rows[0]?.length ?? 0;
  const mean = Array.from({ length: p }, (_, j) => sum(rows.map((r) => r[j]!)) / n);
  const sd = Array.from({ length: p }, (_, j) => Math.sqrt(sum(rows.map((r) => (r[j]! - mean[j]!) ** 2)) / (n - 1)));
  return { mean, sd };
}

/** The T-squared limit of a reference batch (beta; Phase I). */
export function t2ReferenceLimit(n: number, k: number, confidence: number): number {
  return ((n - 1) ** 2 / n) * betaQuantile(confidence, k / 2, (n - k - 1) / 2);
}

/** The T-squared limit of a new batch (F; Phase II). */
export function t2NewLimit(n: number, k: number, confidence: number): number {
  return ((k * (n - 1) * (n + 1)) / (n * (n - k))) * fQuantile(confidence, k, n - k);
}

/** The Q limit from the residual eigenvalues (Jackson and Mudholkar, else Box). */
export function qLimit(residual: readonly number[], confidence: number): QLimit {
  const [t1, t2, t3] = [1, 2, 3].map((i) => sum(residual.map((l) => l ** i))) as [number, number, number];
  if (!(t1 > 0) || !(t2 > 0)) throw new AnalyticsInputError('Q has no limit: the residual shows no variation', residual);
  const h0 = 1 - (2 * t1 * t3) / (3 * t2 * t2);
  if (h0 > 0) {
    const c = normalQuantile(confidence);
    const inner = (c * Math.sqrt(2 * t2 * h0 * h0)) / t1 + 1 + (t2 * h0 * (h0 - 1)) / (t1 * t1);
    if (inner > 0) return { limit: t1 * inner ** (1 / h0), method: 'JACKSON_MUDHOLKAR' };
  }
  return { limit: (t2 / t1) * chiSquareQuantile(confidence, (t1 * t1) / t2), method: 'BOX' };
}

export interface PcaOptions {
  readonly varianceTarget: number;
  readonly maxComponents: number;
  readonly limitConfidence: number;
}

/**
 * Fits the model on the reference rows (n rows of p values, n > p + 1, p >= 2, no constant column; the method checks
 * these first and says why when they fail).
 */
export function fitPca(rows: readonly (readonly number[])[], o: PcaOptions): PcaFit {
  const n = rows.length;
  const p = rows[0]?.length ?? 0;
  if (p < 2 || n <= p + 1) throw new AnalyticsInputError(`a PCA model needs two or more variables and more batches than variables plus one (n ${n}, p ${p})`, { n, p });
  const { mean, sd } = columnMoments(rows);
  if (sd.some((s) => !(s > 0))) throw new AnalyticsInputError('a variable without variation cannot be autoscaled', sd);
  const z = new Matrix(rows.map((r) => r.map((x, j) => (x - mean[j]!) / sd[j]!)));
  const svd = new SingularValueDecomposition(z, { computeLeftSingularVectors: false, computeRightSingularVectors: true, autoTranspose: false });
  const singular = svd.diagonal;
  const v = svd.rightSingularVectors;
  // Largest first (the decomposition sorts them; the order is checked, not assumed).
  const order = Array.from({ length: p }, (_, j) => j).sort((a, b) => (singular[b] ?? 0) - (singular[a] ?? 0) || a - b);
  const eigenvalues = order.map((j) => (singular[j] ?? 0) ** 2 / (n - 1));
  const total = sum(eigenvalues);
  const explained = eigenvalues.map((l) => l / total);
  let k = 1;
  let cumulative = explained[0]!;
  while (cumulative < o.varianceTarget - 1e-12 && k < p) cumulative += explained[k++]!;
  k = Math.max(1, Math.min(k, o.maxComponents, p - 1));
  const loadings: number[][] = Array.from({ length: p }, () => []);
  for (let a = 0; a < k; a++) {
    const col = order[a]!;
    const vec = Array.from({ length: p }, (_, j) => v.get(j, col));
    let big = 0;
    for (let j = 1; j < p; j++) if (Math.abs(vec[j]!) > Math.abs(vec[big]!)) big = j;
    const sign = vec[big]! < 0 ? -1 : 1;
    vec.forEach((x, j) => loadings[j]!.push(sign * x));
  }
  const q = qLimit(eigenvalues.slice(k), o.limitConfidence);
  return {
    n, mean, sd, eigenvalues, explained, components: k, loadings,
    t2Reference: t2ReferenceLimit(n, k, o.limitConfidence), t2New: t2NewLimit(n, k, o.limitConfidence), q: q.limit, qMethod: q.method,
  };
}

/** One batch vector (the model's variables, in its order) scored against a model. */
export function scorePca(model: Pick<PcaFit, 'mean' | 'sd' | 'eigenvalues' | 'components' | 'loadings'>, x: readonly number[]): PcaScore {
  const p = model.mean.length;
  const k = model.components;
  if (x.length !== p) throw new AnalyticsInputError(`a batch vector has ${p} values, not ${x.length}`, x);
  const z = x.map((v, j) => (v - model.mean[j]!) / model.sd[j]!);
  const scores = Array.from({ length: k }, (_, a) => sum(z.map((zj, j) => zj * model.loadings[j]![a]!)));
  const lambda = model.eigenvalues.slice(0, k);
  const t2 = sum(scores.map((t, a) => (t * t) / lambda[a]!));
  const residual = z.map((zj, j) => zj - sum(scores.map((t, a) => t * model.loadings[j]![a]!)));
  const qContributions = residual.map((e) => e * e);
  const t2Contributions = z.map((zj, j) => zj * sum(scores.map((t, a) => (t * model.loadings[j]![a]!) / lambda[a]!)));
  return { scores, t2, q: sum(qContributions), t2Contributions, qContributions };
}
