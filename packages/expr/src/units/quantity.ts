/**
 * Exact conversion and comparison of values between units.
 *
 * - Linear units: value_to = value_from x (factor_from / factor_to), computed on exact rationals
 *   with ONE rounding to 34 significant digits at the end (exact whenever the result terminates
 *   within 34 digits, which is the case for every metric-to-metric conversion).
 * - Absolute temperatures (Cel, [degF]) are handled separately and explicitly:
 *   kelvin = (value + offset) x factor, then back to the target scale, again with one rounding.
 * - Comparisons between units never round: both sides are compared as exact rationals.
 * Every conversion returns a record (units, exact factor, offsets, exactness) for the evidence.
 */
import type { Dec } from '../decimal/dec.ts';
import { fromRational, rAdd, rCmp, rDiv, rMul, rSub, toRational, type Rational } from '../decimal/exact.ts';
import { factorText, linearFactor, sameDimension, sameMagnitude, UnitError, type Unit } from './unit.ts';

export interface ConversionRecord {
  readonly from: string;
  readonly to: string;
  /** Exact factor (terminating decimal, or "num/den"). */
  readonly factor: string;
  /** Absolute temperatures: offsets of the two scales (kelvin = (v + offset) x factor). */
  readonly fromOffset?: string;
  readonly toOffset?: string;
  /** False when the converted value had to be rounded to 34 significant digits. */
  readonly exact: boolean;
}

/** The exact value of `value` expressed in kelvin-or-base units (for exact comparisons). */
export function toBaseRational(value: Dec, unit: Unit): Rational {
  const v = toRational(value);
  if (unit.scale === 'ABSOLUTE_TEMPERATURE') return rMul(rAdd(v, unit.offset ?? { num: 0n, den: 1n }), unit.factor);
  return rMul(v, unit.factor);
}

/** Converts exactly between commensurable units; returns null as the record when no conversion was needed. */
export function convertValue(value: Dec, from: Unit, to: Unit): { value: Dec; conversion: ConversionRecord | null } {
  if (!sameDimension(from, to)) {
    throw new UnitError('UNIT_INCOMPATIBLE', `${from.code} cannot be converted to ${to.code}: they measure different things`);
  }
  if (sameMagnitude(from, to)) return { value, conversion: null };
  if (from.scale === 'ABSOLUTE_TEMPERATURE') {
    const kelvin = toBaseRational(value, from);
    const target = rSub(rDiv(kelvin, to.factor), to.offset ?? { num: 0n, den: 1n });
    const r = fromRational(target);
    return {
      value: r.value,
      conversion: {
        from: from.code,
        to: to.code,
        factor: factorText(rDiv(from.factor, to.factor)),
        fromOffset: factorText(from.offset ?? { num: 0n, den: 1n }),
        toOffset: factorText(to.offset ?? { num: 0n, den: 1n }),
        exact: r.exact,
      },
    };
  }
  const factor = linearFactor(from, to);
  const r = fromRational(rMul(toRational(value), factor));
  return { value: r.value, conversion: { from: from.code, to: to.code, factor: factorText(factor), exact: r.exact } };
}

/** Exact comparison of two values in commensurable units (no rounding). */
export function compareValues(a: Dec, aUnit: Unit, b: Dec, bUnit: Unit): -1 | 0 | 1 {
  if (!sameDimension(aUnit, bUnit)) throw new UnitError('UNIT_INCOMPATIBLE', `${aUnit.code} and ${bUnit.code} measure different things`);
  return rCmp(toBaseRational(a, aUnit), toBaseRational(b, bUnit));
}
