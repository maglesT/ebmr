/**
 * Basic functions: abs, min, max, convert, plus_percent, minus_percent.
 */
import { rAdd, rCmp, rSub, rMul, toRational } from '../decimal/exact.ts';
import type { QuantityType } from '../lang/types.ts';
import { toBaseRational } from '../units/quantity.ts';
import type { LibraryFunction } from './contract.ts';
import { asQuantity, fractionOf, R1, sign, valuesOf } from './runtime.ts';
import { arity, checkQuantity, commensurable, DIM, fail, maxLengthOf, quantityArg } from './typing.ts';

export const abs: LibraryFunction = {
  name: 'abs',
  signature: 'abs(x) -> same as x',
  summary: 'The absolute value of a quantity.',
  reference: 'brief A1 item 3 (arithmetic)',
  check(args) {
    arity(args, 1, 1, this.signature);
    return quantityArg(args, 0, 'abs', { what: 'the value' });
  },
  cost: () => 1,
  evaluate(args) {
    const x = asQuantity(args[0]);
    return { ...x, value: x.value.abs() };
  },
};

function extreme(name: 'min' | 'max'): LibraryFunction {
  const pick = name === 'min' ? -1 : 1;
  return {
    name,
    signature: `${name}(a, b, ...) or ${name}(series) -> same as the arguments`,
    summary: `The ${name === 'min' ? 'smallest' : 'largest'} of two or more values, or of a recorded series.`,
    reference: 'brief A1 item 3; tablets spec C-13 (min, max of weights)',
    check(args) {
      if (args.length === 1) {
        const a = args[0];
        if (a?.type.kind !== 'series') fail('EXPR-FN-002', `${name}() needs two or more values, or one recorded series`);
        checkQuantity(a.type.element, 0, name, { what: 'the series', absoluteTemperature: true });
        return a.type.element;
      }
      arity(args, 2, 32, this.signature);
      const types = args.map((_, i) => ({ t: quantityArg(args, i, name, { what: 'a value', absoluteTemperature: true }), i }));
      const tag = commensurable(types, name, 'the values');
      const first = types[0]?.t as QuantityType;
      return { kind: 'quantity', unit: first.unit, tag };
    },
    cost: (args) => 2 * args.reduce((n, a) => n + maxLengthOf(a), 0),
    evaluate(args, ctx) {
      const values = args.flatMap((a) => valuesOf(a));
      const firstArg = args[0];
      if (values.length === 0) ctx.emptySeries(0);
      const target = firstArg !== undefined && firstArg.kind === 'series' ? firstArg.unit : asQuantity(firstArg).unit;
      let best = values[0];
      for (const v of values.slice(1)) {
        if (best === undefined || rCmp(toBaseRational(v.value, v.unit), toBaseRational(best.value, best.unit)) === pick) best = v;
      }
      if (best === undefined) return ctx.emptySeries(0);
      const tag = args.map((a) => (a.kind === 'quantity' || a.kind === 'series' ? a.tag : null)).find((t) => t !== null) ?? null;
      const converted = ctx.convert(best, target);
      return { ...converted, tag };
    },
  };
}

export const min = extreme('min');
export const max = extreme('max');

export const convert: LibraryFunction = {
  name: 'convert',
  signature: 'convert(x, [unit]) -> x in unit',
  summary: 'Expresses a quantity in another unit of the same kind, exactly (absolute temperatures with their offsets).',
  reference: 'brief A1 item 2 (exact conversion factors)',
  check(args) {
    arity(args, 2, 2, this.signature);
    const x = quantityArg(args, 0, 'convert', { what: 'the value', absoluteTemperature: true });
    const target = args[1];
    if (target === undefined || target.node.type !== 'Unit' || target.type.kind !== 'unit') {
      fail('EXPR-FN-006', 'The second argument of convert must be a unit in brackets, e.g. convert(t, [min])', 1);
    }
    const unit = target.type.unit;
    if (unit.dimensionKey !== x.unit.dimensionKey || unit.scale !== x.unit.scale) {
      fail('EXPR-UNIT-010', `convert: ${x.unit.code} cannot be expressed in ${unit.code}; they measure different things`, 1);
    }
    return { kind: 'quantity', unit, tag: x.tag };
  },
  cost: () => 2,
  evaluate(args, ctx) {
    const x = asQuantity(args[0]);
    const target = args[1];
    if (target === undefined || target.kind !== 'unit') throw new Error('internal: convert target');
    return ctx.convert(x, target.unit);
  },
};

function percentBand(name: 'plus_percent' | 'minus_percent'): LibraryFunction {
  const up = name === 'plus_percent';
  return {
    name,
    signature: `${name}(x, percent) -> same as x`,
    summary: `x ${up ? 'increased' : 'reduced'} by a percentage of itself: x x (1 ${up ? '+' : '-'} percent/100), e.g. the ${up ? 'upper' : 'lower'} end of a +/- band.`,
    reference: 'tablets spec C-11 (group and average weight limits G x (1 +/- g/100)); C-16 (target coated weight)',
    check(args) {
      arity(args, 2, 2, this.signature);
      const x = quantityArg(args, 0, name, { what: 'the value' });
      quantityArg(args, 1, name, { what: 'the percentage', dimension: DIM.NUMBER, dimensionLabel: 'a percentage', tags: ['none'] });
      return x;
    },
    cost: () => 4,
    evaluate(args, ctx) {
      const x = asQuantity(args[0]);
      const p = asQuantity(args[1]);
      const f = fractionOf(p);
      if (sign(f) < 0) ctx.domain(`${name}: the percentage cannot be negative (${p.value.toString()} ${p.unit.code})`, 1);
      const factor = up ? rAdd(R1, f) : rSub(R1, f);
      return ctx.result(rMul(toRational(x.value), factor), x.unit, x.tag);
    },
  };
}

export const plusPercent = percentBand('plus_percent');
export const minusPercent = percentBand('minus_percent');
