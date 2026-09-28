/**
 * Run-time helpers for library functions. Library formulas are computed on exact rationals and
 * rounded ONCE at the end (EvalContext.result), so a result is the exact mathematical value
 * correctly rounded to 34 significant digits, independent of the order of recorded values.
 */
import { rational, rMul, toRational, type Rational } from '../decimal/exact.ts';
import type { QuantityValue, RuntimeValue, SeriesValue } from '../lang/values.ts';

export const R0: Rational = rational(0n);
export const R1: Rational = rational(1n);
export const R100: Rational = rational(100n);

export function asQuantity(v: RuntimeValue | undefined): QuantityValue {
  if (v === undefined || v.kind !== 'quantity') throw new Error('internal: expected a quantity argument (checked at design time)');
  return v;
}

export function asSeries(v: RuntimeValue | undefined): SeriesValue {
  if (v === undefined || v.kind !== 'series') throw new Error('internal: expected a series argument (checked at design time)');
  return v;
}

/** A scalar as one value, a series as its values. */
export function valuesOf(v: RuntimeValue | undefined): QuantityValue[] {
  if (v !== undefined && v.kind === 'series') return v.values.map((value) => ({ kind: 'quantity', value, unit: v.unit, tag: v.tag }));
  return [asQuantity(v)];
}

/** The exact dimensionless value of a fraction (4.6 % -> 0.046). */
export function fractionOf(q: QuantityValue): Rational {
  return rMul(toRational(q.value), q.unit.factor);
}

export function sign(r: Rational): -1 | 0 | 1 {
  return r.num < 0n ? -1 : r.num > 0n ? 1 : 0;
}
