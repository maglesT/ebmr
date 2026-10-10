/**
 * Pure calculations of the coating and finishing blocks (Phase 3 slice 3d, builder A; tablets spec C-16, TB-18, TB-20).
 * Every GMP value is decimal text worked as an exact scaled integer (bigint); nothing here reads a clock or uses a
 * JavaScript number for a value. The database computes the same results (tablets 0911, tab.coat_* functions) and refuses
 * an entry whose stored result differs, so every rounding is explicit and decided on integers:
 *   * a sample mean is the exact total divided by the count, rounded half away from zero to 6 decimals (mg);
 *   * the weight gain (C-16) is (coated total - n x core mean) x 100 / (n x core mean), from the exact coated total and
 *     the stored core mean, rounded half away from zero to 4 decimals (%);
 *   * comparisons against the MBR's minimum and maximum weight gain are made on the exact ratio, never on the rounded
 *     value (cross-multiplied, no division).
 */

/** A decimal as an exact scaled integer: value = n / 10^s. */
export interface Scaled {
  n: bigint;
  s: number;
}

const DECIMAL = /^-?[0-9]+(?:\.[0-9]+)?$/;
const POW = (k: number): bigint => 10n ** BigInt(k);

export function scaled(text: string): Scaled {
  if (!DECIMAL.test(text)) throw new Error(`not a decimal: ${text}`);
  const neg = text.startsWith('-');
  const body = neg ? text.slice(1) : text;
  const [i = '0', f = ''] = body.split('.');
  const n = BigInt(i + f);
  return { n: neg ? -n : n, s: f.length };
}

function rescale(a: Scaled, s: number): bigint {
  return a.n * POW(s - a.s);
}

/** a and b on one scale. */
export function aligned(a: Scaled, b: Scaled): [bigint, bigint, number] {
  const s = Math.max(a.s, b.s);
  return [rescale(a, s), rescale(b, s), s];
}

/** num / den rounded half away from zero to an integer (den != 0). */
export function roundHalfAway(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error('division by zero');
  const neg = num < 0n !== den < 0n && num !== 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = (2n * a + b) / (2n * b);
  return neg ? -q : q;
}

/** q / 10^k written with exactly k decimals. */
export function fixedText(q: bigint, k: number): string {
  const neg = q < 0n;
  const digits = (neg ? -q : q).toString().padStart(k + 1, '0');
  const int = digits.slice(0, digits.length - k);
  const frac = digits.slice(digits.length - k);
  return `${neg ? '-' : ''}${int}${k > 0 ? `.${frac}` : ''}`;
}

export function sumText(values: readonly string[]): string {
  if (values.length === 0) return '0';
  const s = Math.max(...values.map((v) => scaled(v).s));
  const total = values.reduce((acc, v) => acc + rescale(scaled(v), s), 0n);
  return plainText({ n: total, s });
}

/** The canonical text of a scaled value (no trailing fractional zeros). */
export function plainText(v: Scaled): string {
  let { n, s } = v;
  while (s > 0 && n % 10n === 0n) {
    n /= 10n;
    s -= 1;
  }
  return fixedText(n, s);
}

/** A tablet mass in mg from a value in mg or g (exact). */
export function toMg(value: string, unit: string): string {
  if (unit === 'mg') return plainText(scaled(value));
  if (unit === 'g') {
    const v = scaled(value);
    return plainText({ n: v.n * 1000n, s: v.s });
  }
  throw new Error(`not a tablet mass unit: ${unit}`);
}

/** The mean of a sample of `count` tablets weighing `totalMg` in all, rounded half away from zero to 6 decimals (mg). */
export function meanMg(totalMg: string, count: bigint): string {
  const t = scaled(totalMg);
  return fixedText(roundHalfAway(t.n * POW(6), POW(t.s) * count), 6);
}

/**
 * C-16 weight gain in % of a coated sample (`count` tablets, `totalMg` in all) against the core mean `coreMeanMg`:
 * rounded half away from zero to 4 decimals.
 */
export function weightGain(totalMg: string, count: bigint, coreMeanMg: string): string {
  const [t, m] = aligned(scaled(totalMg), scaled(coreMeanMg));
  return fixedText(roundHalfAway((t - count * m) * 100n * POW(4), count * m), 4);
}

/** The sign of (exact weight gain - percent): -1, 0 or 1, without dividing (core mean > 0). */
export function compareGain(totalMg: string, count: bigint, coreMeanMg: string, percent: string): -1 | 0 | 1 {
  const t = scaled(totalMg);
  const m = scaled(coreMeanMg);
  const p = scaled(percent);
  const s = Math.max(t.s, m.s, p.s);
  // (t - n m) x 100 against p x n m, everything on scale s (the products carry scale 2s on both sides).
  const lhs = (rescale(t, s) - count * rescale(m, s)) * 100n * POW(s);
  const rhs = rescale(p, s) * count * rescale(m, s);
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

/** Exact comparison of two decimals. */
export function cmp(a: string, b: string): -1 | 0 | 1 {
  const [x, y] = aligned(scaled(a), scaled(b));
  return x < y ? -1 : x > y ? 1 : 0;
}
