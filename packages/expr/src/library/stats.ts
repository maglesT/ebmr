/**
 * Statistics over recorded series: sum, count, mean, sd (sample), rsd.
 *
 * Computed from exact sums (S1 = sum x, S2 = sum x^2) so the result does not depend on the order of
 * the recorded values, and rounded once: mean = S1/n; sd = sqrt((n S2 - S1^2) / (n (n-1)));
 * rsd = sd / mean x 100 % (one correctly rounded square root). Tablets spec C-13 and C-18.
 */
import { Dec } from '../decimal/dec.ts';
import { exactSum, fromRational, rAdd, rational, rDiv, rMul, rSub, sqrtRational, toRational, type Rational } from '../decimal/exact.ts';
import { parseUnit } from '../units/unit.ts';
import type { LibraryFunction } from './contract.ts';
import { asSeries, R100 } from './runtime.ts';
import { arity, DIMENSIONLESS, PERCENT_UNIT, seriesArg } from './typing.ts';

const KELVIN = parseUnit('K');

function sums(values: readonly Dec[]): { n: bigint; s1: Rational; s2: Rational } {
  const s1 = exactSum(values);
  let s2 = rational(0n);
  for (const v of values) {
    const r = toRational(v);
    s2 = rAdd(s2, rMul(r, r));
  }
  return { n: BigInt(values.length), s1, s2 };
}

function variance(n: bigint, s1: Rational, s2: Rational): Rational {
  // (n S2 - S1^2) / (n (n - 1)), exact.
  return rDiv(rSub(rMul(rational(n), s2), rMul(s1, s1)), rational(n * (n - 1n)));
}

export const sum: LibraryFunction = {
  name: 'sum',
  signature: 'sum(series) -> same unit and tag',
  summary: 'The sum of the values of a recorded series (exact, independent of their order).',
  reference: 'brief A1 item 3; tablets spec C-07 (sum of charged components), C-09 (reconciliation categories)',
  check(args) {
    arity(args, 1, 1, this.signature);
    return seriesArg(args, 0, 'sum', { what: 'the recorded values' }).element;
  },
  cost: (args) => 2 * (args[0]?.type.kind === 'series' ? args[0].type.maxLength : 1),
  evaluate(args, ctx) {
    const s = asSeries(args[0]);
    if (s.values.length === 0) ctx.emptySeries(0);
    return ctx.result(exactSum(s.values), s.unit, s.tag);
  },
};

export const count: LibraryFunction = {
  name: 'count',
  signature: 'count(series) -> count',
  summary: 'The number of recorded values in a series.',
  reference: 'brief A1 item 3; tablets spec C-12 (n = 20 units)',
  check(args) {
    arity(args, 1, 1, this.signature);
    seriesArg(args, 0, 'count', { what: 'the recorded values', absoluteTemperature: true });
    return { kind: 'quantity', unit: DIMENSIONLESS, tag: 'count' };
  },
  cost: () => 1,
  evaluate(args) {
    const s = asSeries(args[0]);
    return { kind: 'quantity', value: Dec.fromInteger(s.values.length), unit: DIMENSIONLESS, tag: 'count' };
  },
};

export const mean: LibraryFunction = {
  name: 'mean',
  signature: 'mean(series) -> same unit and tag',
  summary: 'The arithmetic mean of a recorded series (at least one value).',
  reference: 'tablets spec C-12, C-13 (mean weight)',
  check(args) {
    arity(args, 1, 1, this.signature);
    return seriesArg(args, 0, 'mean', { what: 'the recorded values', absoluteTemperature: true }).element;
  },
  cost: (args) => 3 * (args[0]?.type.kind === 'series' ? args[0].type.maxLength : 1),
  evaluate(args, ctx) {
    const s = asSeries(args[0]);
    if (s.values.length === 0) ctx.emptySeries(0);
    const { n, s1 } = sums(s.values);
    return ctx.result(rDiv(s1, rational(n)), s.unit, s.tag);
  },
};

export const sd: LibraryFunction = {
  name: 'sd',
  signature: 'sd(series) -> same unit and tag (K for absolute temperatures)',
  summary: 'The sample standard deviation (n - 1 in the denominator) of a recorded series of at least two values.',
  reference: 'tablets spec C-13: s = sqrt(sum (x - mean)^2 / (n - 1))',
  check(args) {
    arity(args, 1, 1, this.signature);
    const e = seriesArg(args, 0, 'sd', { what: 'the recorded values', absoluteTemperature: true }).element;
    return e.unit.scale === 'ABSOLUTE_TEMPERATURE' ? { kind: 'quantity', unit: KELVIN, tag: e.tag } : e;
  },
  cost: (args) => 6 * (args[0]?.type.kind === 'series' ? args[0].type.maxLength : 1) + 50,
  evaluate(args, ctx) {
    const s = asSeries(args[0]);
    if (s.values.length < 2) ctx.domain(`sd needs at least 2 values; the series has ${String(s.values.length)}`, 0);
    const { n, s1, s2 } = sums(s.values);
    let v = variance(n, s1, s2);
    let unit = s.unit;
    if (unit.scale === 'ABSOLUTE_TEMPERATURE') {
      // A spread of temperatures is a temperature difference: scale the degree size to kelvin.
      v = rMul(v, rMul(unit.factor, unit.factor));
      unit = KELVIN;
    }
    return { kind: 'quantity', value: sqrtRational(v).value, unit, tag: s.tag };
  },
};

export const rsd: LibraryFunction = {
  name: 'rsd',
  signature: 'rsd(series) -> % RSD',
  summary: 'The relative standard deviation, sd / mean x 100 %, of a recorded series of at least two values with a positive mean.',
  reference: 'tablets spec C-13: RSD (%) = s / mean x 100',
  check(args) {
    arity(args, 1, 1, this.signature);
    seriesArg(args, 0, 'rsd', { what: 'the recorded values' });
    return { kind: 'quantity', unit: PERCENT_UNIT, tag: 'rsd' };
  },
  cost: (args) => 6 * (args[0]?.type.kind === 'series' ? args[0].type.maxLength : 1) + 60,
  evaluate(args, ctx) {
    const s = asSeries(args[0]);
    if (s.values.length < 2) ctx.domain(`rsd needs at least 2 values; the series has ${String(s.values.length)}`, 0);
    const { n, s1, s2 } = sums(s.values);
    const m = rDiv(s1, rational(n));
    if (m.num <= 0n) ctx.domain(`rsd needs a positive mean; the mean is ${fromRational(m).value.toString()} ${s.unit.code}`, 0);
    // rsd = sqrt(var) / m x 100 = sqrt(var x 100^2 / m^2): one correctly rounded square root.
    const r = sqrtRational(rDiv(rMul(variance(n, s1, s2), rMul(R100, R100)), rMul(m, m)));
    return { kind: 'quantity', value: r.value, unit: PERCENT_UNIT, tag: 'rsd' };
  },
};
