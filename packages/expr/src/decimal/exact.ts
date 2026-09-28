/**
 * Exact integer arithmetic behind the places where one rounding must happen at most once:
 * unit conversion by an exact rational factor, sums over recorded series (order-independent), the
 * sample standard deviation and floors of exact quotients. Everything here is BigInt; no JavaScript
 * number ever holds a value.
 */
import { Dec, DEC_SIGNIFICANT_DIGITS, DecError, type RoundingMode } from './dec.ts';

/** An exact rational number num/den, den > 0, reduced. */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

export function rational(num: bigint, den: bigint = 1n): Rational {
  if (den === 0n) throw new DecError('DEC_DIVISION_BY_ZERO', 'rational with a zero denominator');
  if (num === 0n) return { num: 0n, den: 1n };
  const sign = den < 0n ? -1n : 1n;
  const g = gcd(num, den);
  return { num: (sign * num) / g, den: (sign * den) / g };
}

export const R_ONE: Rational = { num: 1n, den: 1n };

export function rMul(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den);
}

export function rDiv(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new DecError('DEC_DIVISION_BY_ZERO', 'division by zero');
  return rational(a.num * b.den, a.den * b.num);
}

export function rAdd(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function rSub(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function rPow(a: Rational, exponent: number): Rational {
  if (!Number.isSafeInteger(exponent)) throw new DecError('DEC_DOMAIN', 'exponent must be an integer');
  if (exponent === 0) return R_ONE;
  const e = BigInt(Math.abs(exponent));
  const r = rational(a.num ** e, a.den ** e);
  return exponent > 0 ? r : rDiv(R_ONE, r);
}

export function rEq(a: Rational, b: Rational): boolean {
  return a.num === b.num && a.den === b.den;
}

export function rCmp(a: Rational, b: Rational): -1 | 0 | 1 {
  const l = a.num * b.den;
  const r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** The exact rational value of a Dec. */
export function toRational(d: Dec): Rational {
  const { coefficient, exponent } = d.toScaled();
  return exponent >= 0 ? rational(coefficient * 10n ** BigInt(exponent)) : rational(coefficient, 10n ** BigInt(-exponent));
}

/** Parses "a", "a/b" (integers or exact decimals on each side) into an exact rational. */
export function parseRational(text: string): Rational {
  const parts = text.split('/');
  if (parts.length > 2) throw new DecError('DEC_SYNTAX', `"${text}" is not a rational`);
  const num = toRational(Dec.parse(parts[0] ?? ''));
  return parts.length === 2 ? rDiv(num, toRational(Dec.parse(parts[1] ?? ''))) : num;
}

/** "num/den", or the plain integer when den = 1. */
export function formatRational(r: Rational): string {
  return r.den === 1n ? r.num.toString() : `${r.num.toString()}/${r.den.toString()}`;
}

/** The terminating decimal text of a rational, or undefined when its expansion does not terminate. */
export function terminatingDecimal(r: Rational): string | undefined {
  let den = r.den;
  let twos = 0;
  let fives = 0;
  while (den % 2n === 0n) {
    den /= 2n;
    twos += 1;
  }
  while (den % 5n === 0n) {
    den /= 5n;
    fives += 1;
  }
  if (den !== 1n) return undefined;
  const k = Math.max(twos, fives);
  const scaled = (r.num * 10n ** BigInt(k)) / r.den;
  const negative = scaled < 0n;
  let digits = (negative ? -scaled : scaled).toString();
  if (k > 0) {
    digits = digits.padStart(k + 1, '0');
    digits = `${digits.slice(0, digits.length - k)}.${digits.slice(digits.length - k)}`.replace(/\.?0+$/, '');
  }
  return (negative ? '-' : '') + digits;
}

function digitCount(n: bigint): number {
  return n === 0n ? 1 : n.toString().length;
}

function roundUpWanted(q: bigint, twiceRemainder: bigint, divisor: bigint, mode: RoundingMode, negative: boolean): boolean {
  if (twiceRemainder === 0n) return false;
  const cmp = twiceRemainder < divisor ? -1 : twiceRemainder > divisor ? 1 : 0;
  switch (mode) {
    case 'HALF_EVEN':
      return cmp > 0 || (cmp === 0 && q % 2n === 1n);
    case 'HALF_UP':
      return cmp >= 0;
    case 'UP':
      return true;
    case 'DOWN':
      return false;
    case 'CEILING':
      return !negative;
    case 'FLOOR':
      return negative;
  }
}

/**
 * num/den correctly rounded to `digits` significant digits (default 34, half-even), and whether the
 * result is exact. The magnitude is rounded; the sign is applied afterwards (so HALF_UP rounds half
 * away from zero, CEILING/FLOOR honour the sign).
 */
export function fromRational(r: Rational, mode: RoundingMode = 'HALF_EVEN', digits: number = DEC_SIGNIFICANT_DIGITS): { value: Dec; exact: boolean } {
  if (r.num === 0n) return { value: Dec.ZERO, exact: true };
  const negative = r.num < 0n;
  const n = negative ? -r.num : r.num;
  const d = r.den;
  // Choose k so that q = floor(n * 10^k / d) has exactly `digits` digits.
  let k = digits - (digitCount(n) - digitCount(d)) - 1;
  for (;;) {
    const top = k >= 0 ? n * 10n ** BigInt(k) : n;
    const bottom = k >= 0 ? d : d * 10n ** BigInt(-k);
    const q = top / bottom;
    const qd = digitCount(q);
    if (qd < digits) {
      k += digits - qd;
      continue;
    }
    if (qd > digits) {
      k -= qd - digits;
      continue;
    }
    const rem = top - q * bottom;
    let coefficient = q;
    if (roundUpWanted(q, 2n * rem, bottom, mode, negative)) coefficient += 1n;
    let exponent = -k;
    if (digitCount(coefficient) > digits) {
      coefficient /= 10n;
      exponent += 1;
    }
    return { value: Dec.fromScaled(negative ? -coefficient : coefficient, exponent), exact: rem === 0n };
  }
}

/** value x factor, one rounding (exact when the product terminates within 34 digits). */
export function scaleByRational(value: Dec, factor: Rational): { value: Dec; exact: boolean } {
  return fromRational(rMul(toRational(value), factor));
}

/** Exact sum of Decs (independent of order), rounded once to 34 significant digits. */
export function exactSum(values: readonly Dec[]): Rational {
  let acc: Rational = { num: 0n, den: 1n };
  for (const v of values) acc = rAdd(acc, toRational(v));
  return acc;
}

/** floor(r) exactly. */
export function rFloor(r: Rational): bigint {
  const q = r.num / r.den;
  return r.num < 0n && q * r.den !== r.num ? q - 1n : q;
}

/** ceil(r) exactly. */
export function rCeil(r: Rational): bigint {
  return -rFloor({ num: -r.num, den: r.den });
}

/** Integer square root (floor) of n >= 0. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new DecError('DEC_DOMAIN', 'square root of a negative value');
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) / 2n;
    if (y >= x) break;
    x = y;
  }
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x;
}

/** sqrt(r) for r >= 0, correctly rounded (half-even) to 34 significant digits. */
export function sqrtRational(r: Rational): { value: Dec; exact: boolean } {
  if (r.num < 0n) throw new DecError('DEC_DOMAIN', 'square root of a negative value');
  if (r.num === 0n) return { value: Dec.ZERO, exact: true };
  const digits = DEC_SIGNIFICANT_DIGITS;
  // sqrt(n/d) * 10^k = sqrt(n * 10^(2k) / d); choose k so the integer part has `digits` digits.
  let k = Math.ceil((2 * digits - (digitCount(r.num) - digitCount(r.den))) / 2);
  for (;;) {
    const top = k >= 0 ? r.num * 10n ** BigInt(2 * k) : r.num;
    const bottom = k >= 0 ? r.den : r.den * 10n ** BigInt(-2 * k);
    const q = isqrt(top / bottom);
    const qd = digitCount(q);
    if (qd < digits) {
      k += digits - qd;
      continue;
    }
    if (qd > digits) {
      k -= qd - digits;
      continue;
    }
    // Compare sqrt(top/bottom) with q + 1/2:  4*top  vs  (2q+1)^2 * bottom.
    const lhs = 4n * top;
    const rhs = (2n * q + 1n) ** 2n * bottom;
    const exact = q * q * bottom === top;
    let coefficient = q;
    if (lhs > rhs || (lhs === rhs && q % 2n === 1n)) coefficient += 1n;
    let exponent = -k;
    if (digitCount(coefficient) > digits) {
      coefficient /= 10n;
      exponent += 1;
    }
    return { value: Dec.fromScaled(coefficient, exponent), exact };
  }
}
