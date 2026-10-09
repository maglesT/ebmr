/**
 * Yield and reconciliation (tablets spec C-09, D.1; injectables spec C-07, C-08 generic forms),
 * plus relative change (friability C-15, coating weight gain C-16).
 *
 * Numerator and denominator must measure the same thing (kg/kg or tablets/tablets); mixing is a
 * design-time error. A yield is computed, never typed (INV-25), and is tagged % yield so it cannot
 * be added to, say, a % LOD.
 */
import { rAdd, rDiv, rMul, rSub, type Rational } from '../decimal/exact.ts';
import type { QuantityType } from '../lang/types.ts';
import type { RuntimeValue } from '../lang/values.ts';
import type { Unit } from '../units/unit.ts';
import type { ArgInfo, EvalContext, LibraryFunction } from './contract.ts';
import { asQuantity, R0, R100, sign, valuesOf } from './runtime.ts';
import { arity, commensurable, fail, maxLengthOf, PERCENT_UNIT, quantityArg, scalarOrSeriesArg } from './typing.ts';

export const yieldFn: LibraryFunction = {
  name: 'yield',
  signature: 'yield(actual, theoretical) -> % yield',
  summary: 'Actual output as a percentage of the theoretical quantity: actual / theoretical x 100 %.',
  reference: 'tablets spec C-09 (stage, cumulative and good-output yield), D.1 rules 1-4; injectables spec C-07',
  check(args) {
    arity(args, 2, 2, this.signature);
    const a = quantityArg(args, 0, 'yield', { what: 'the actual output', tags: ['none', 'count'] });
    const t = quantityArg(args, 1, 'yield', { what: 'the theoretical quantity', tags: ['none', 'count'] });
    commensurable(
      [
        { t: a, i: 0 },
        { t, i: 1 },
      ],
      'yield',
      'the actual and theoretical quantities',
    );
    return { kind: 'quantity', unit: PERCENT_UNIT, tag: 'yield' };
  },
  cost: () => 6,
  evaluate(args, ctx) {
    const actual = asQuantity(args[0]);
    const theoretical = asQuantity(args[1]);
    const t = ctx.exact(theoretical, theoretical.unit);
    if (sign(t) === 0) ctx.divisionByZero('yield: the theoretical quantity is zero', 1);
    if (sign(t) < 0) ctx.domain('yield: the theoretical quantity is negative', 1);
    const a = ctx.exact(actual, theoretical.unit);
    if (sign(a) < 0) ctx.domain('yield: the actual output is negative', 0);
    return ctx.result(rMul(rDiv(a, t), R100), PERCENT_UNIT, 'yield');
  },
};

function partsTotal(args: readonly RuntimeValue[], from: number, target: Unit, ctx: EvalContext, fn: string): Rational {
  let total = R0;
  for (let i = from; i < args.length; i += 1) {
    const values = valuesOf(args[i]);
    if (args[i]?.kind === 'series' && values.length === 0) ctx.emptySeries(i);
    for (const v of values) {
      const r = ctx.exact(v, target);
      if (sign(r) < 0) ctx.domain(`${fn}: a reconciliation quantity cannot be negative (${v.value.toString()} ${v.unit.code})`, i);
      total = rAdd(total, r);
    }
  }
  return total;
}

function checkReconciliation(args: readonly ArgInfo[], fn: string, signature: string): QuantityType {
  arity(args, 2, 32, signature);
  const input = quantityArg(args, 0, fn, { what: 'the input quantity', tags: ['none', 'count'] });
  const parts = args.slice(1).map((_, k) => ({ t: scalarOrSeriesArg(args, k + 1, fn, { what: 'an accounted quantity', tags: ['none', 'count'] }), i: k + 1 }));
  commensurable([{ t: input, i: 0 }, ...parts], fn, 'the input and the accounted quantities');
  return input;
}

export const accountability: LibraryFunction = {
  name: 'accountability',
  signature: 'accountability(input, accounted1, accounted2, ...) -> %',
  summary:
    'Mass (or count) balance: the sum of every accounted category (good output, samples, rejects, residue, documented losses, returns; single values or recorded series) as a percentage of the input.',
  reference: 'tablets spec C-09 (accountability), C-20, C-21; injectables spec C-08, C-09',
  check(args) {
    checkReconciliation(args, 'accountability', this.signature);
    return { kind: 'quantity', unit: PERCENT_UNIT, tag: 'none' };
  },
  cost: (args) => 4 * args.reduce((n, a) => n + maxLengthOf(a), 0),
  evaluate(args, ctx) {
    const input = asQuantity(args[0]);
    const i = ctx.exact(input, input.unit);
    if (sign(i) === 0) ctx.divisionByZero('accountability: the input quantity is zero', 0);
    if (sign(i) < 0) ctx.domain('accountability: the input quantity is negative', 0);
    const total = partsTotal(args, 1, input.unit, ctx, 'accountability');
    return ctx.result(rMul(rDiv(total, i), R100), PERCENT_UNIT, 'none');
  },
};

export const unaccounted: LibraryFunction = {
  name: 'unaccounted',
  signature: 'unaccounted(input, accounted1, accounted2, ...) -> same unit as input',
  summary: 'Input minus the sum of every accounted category; positive = missing, negative = over-accounted (both are discrepancies).',
  reference: 'tablets spec C-09 (unaccounted), C-21 (discrepancy); injectables spec C-08, C-09',
  check(args) {
    const input = checkReconciliation(args, 'unaccounted', this.signature);
    return { kind: 'quantity', unit: input.unit, tag: input.tag };
  },
  cost: (args) => 4 * args.reduce((n, a) => n + maxLengthOf(a), 0),
  evaluate(args, ctx) {
    const input = asQuantity(args[0]);
    const i = ctx.exact(input, input.unit);
    if (sign(i) < 0) ctx.domain('unaccounted: the input quantity is negative', 0);
    const total = partsTotal(args, 1, input.unit, ctx, 'unaccounted');
    return ctx.result(rSub(i, total), input.unit, input.tag);
  },
};

function relativeChange(name: 'percent_gain' | 'percent_loss'): LibraryFunction {
  const gain = name === 'percent_gain';
  return {
    name,
    signature: `${name}(before, after) -> %`,
    summary: gain
      ? 'Relative increase from before to after: (after - before) / before x 100 %, e.g. coating weight gain.'
      : 'Relative loss from before to after: (before - after) / before x 100 %, e.g. friability.',
    reference: gain ? 'tablets spec C-16 (coating weight gain WG)' : 'tablets spec C-15 (friability F = (W1 - W2) / W1 x 100)',
    check(args) {
      arity(args, 2, 2, this.signature);
      const b = quantityArg(args, 0, name, { what: 'the value before' });
      const a = quantityArg(args, 1, name, { what: 'the value after' });
      commensurable(
        [
          { t: b, i: 0 },
          { t: a, i: 1 },
        ],
        name,
        'the values before and after',
      );
      if (b.unit.dimensionKey === '' && !b.unit.bareNumber) fail('EXPR-FN-004', `${name} compares amounts, not percentages`, 0);
      return { kind: 'quantity', unit: PERCENT_UNIT, tag: 'none' };
    },
    cost: () => 6,
    evaluate(args, ctx) {
      const before = asQuantity(args[0]);
      const after = asQuantity(args[1]);
      const b = ctx.exact(before, before.unit);
      if (sign(b) === 0) ctx.divisionByZero(`${name}: the value before is zero`, 0);
      if (sign(b) < 0) ctx.domain(`${name}: the value before is negative`, 0);
      const a = ctx.exact(after, before.unit);
      if (sign(a) < 0) ctx.domain(`${name}: the value after is negative`, 1);
      const diff = gain ? rSub(a, b) : rSub(b, a);
      return ctx.result(rMul(rDiv(diff, b), R100), PERCENT_UNIT, 'none');
    },
  };
}

export const percentGain = relativeChange('percent_gain');
export const percentLoss = relativeChange('percent_loss');
