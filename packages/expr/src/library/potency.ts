/**
 * Potency-, assay- and LOD-adjusted quantities with a compensating excipient (tablets spec C-01 to
 * C-05, TB-01), and mass/volume conversion by density (injectables spec C-01, generic).
 *
 * Every formula is computed on exact rationals and rounded once. Percentages are used as fractions
 * (99.2 % -> 0.992), so the unit of a percentage argument never matters. Domain errors (a negative
 * LOD, water of 100 % or more, a zero assay, a negative compensating excipient) are explicit.
 *
 * The rounding UP of an active's dispensing target to the balance readability (TB-01) is a
 * display/target rounding done with rounding.roundToIncrement, never inside these functions.
 */
import { rAdd, rDiv, rMul, rSub, toRational, type Rational } from '../decimal/exact.ts';
import type { QuantityType } from '../lang/types.ts';
import type { QuantityValue } from '../lang/values.ts';
import { divideUnits, multiplyUnits } from '../units/unit.ts';
import type { EvalContext, LibraryFunction } from './contract.ts';
import { asQuantity, fractionOf, R0, R1, sign, valuesOf } from './runtime.ts';
import { arity, commensurable, DIM, DIMENSIONLESS, fail, maxLengthOf, quantityArg, scalarOrSeriesArg } from './typing.ts';

const MASS = { dimension: DIM.MASS, dimensionLabel: 'a mass' } as const;
const FRACTION = { dimension: DIM.NUMBER, dimensionLabel: 'a percentage' } as const;

function positive(ctx: EvalContext, r: Rational, i: number, what: string): void {
  if (sign(r) === 0) ctx.domain(`${ctx.callee}: ${what} must be greater than zero`, i);
  if (sign(r) < 0) ctx.domain(`${ctx.callee}: ${what} cannot be negative`, i);
}

function nonNegative(ctx: EvalContext, r: Rational, i: number, what: string): void {
  if (sign(r) < 0) ctx.domain(`${ctx.callee}: ${what} cannot be negative`, i);
}

/** A fraction strictly below 1 (100 %). */
function belowWhole(ctx: EvalContext, r: Rational, i: number, what: string): void {
  if (!(r.num < r.den)) ctx.domain(`${ctx.callee}: ${what} must be less than 100 %`, i);
}

function text(q: QuantityValue): string {
  return `${q.value.toString()} ${q.unit.code}`;
}

// ---------------------------------------------------------------- C-01 as-is assay

function asIs(name: string, basis: string, parts: readonly { what: string; tag: 'w/w' | 'lod' }[], formula: string): LibraryFunction {
  const signature = `${name}(assay: % w/w, ${parts.map((p) => `${p.what}: ${p.tag === 'lod' ? '% LOD' : '% w/w'}`).join(', ')}) -> % w/w`;
  return {
    name,
    signature,
    summary: `The as-is assay of an active from a CoA assay on the ${basis}: ${formula}.`,
    reference: 'tablets spec C-01 (as-is assay of an active); injectables spec C-02 (A_asis)',
    check(args) {
      arity(args, parts.length + 1, parts.length + 1, signature);
      const assay = quantityArg(args, 0, name, { what: 'the assay', ...FRACTION, tag: 'w/w' });
      parts.forEach((p, k) => quantityArg(args, k + 1, name, { what: p.what, ...FRACTION, tag: p.tag }));
      return { kind: 'quantity', unit: assay.unit, tag: 'w/w' };
    },
    cost: () => 8,
    evaluate(args, ctx) {
      const assay = asQuantity(args[0]);
      const a = toRational(assay.value);
      positive(ctx, a, 0, 'the assay');
      let removed = R0;
      parts.forEach((p, k) => {
        const f = fractionOf(asQuantity(args[k + 1]));
        nonNegative(ctx, f, k + 1, p.what);
        belowWhole(ctx, f, k + 1, p.what);
        removed = rAdd(removed, f);
      });
      if (parts.length > 1) belowWhole(ctx, removed, 1, `${parts.map((p) => p.what).join(' plus ')}`);
      return ctx.result(rMul(a, rSub(R1, removed)), assay.unit, 'w/w');
    },
  };
}

export const assayAsIsAnhydrous = asIs('assay_as_is_anhydrous', 'anhydrous basis (water by KF)', [{ what: 'the water content', tag: 'w/w' }], 'A x (100 - W) / 100');
export const assayAsIsDried = asIs('assay_as_is_dried', 'dried basis (loss on drying)', [{ what: 'the LOD', tag: 'lod' }], 'A x (100 - LOD) / 100');
export const assayAsIsAnhydrousSolventFree = asIs(
  'assay_as_is_anhydrous_solvent_free',
  'anhydrous and solvent-free basis',
  [
    { what: 'the water content', tag: 'w/w' },
    { what: 'the residual solvents', tag: 'w/w' },
  ],
  'A x (100 - W - S) / 100',
);

// ---------------------------------------------------------------- C-02 salt-to-base factor

export const saltFactor: LibraryFunction = {
  name: 'salt_factor',
  signature: 'salt_factor(mw_form: molar mass, mw_base: molar mass, moieties: count) -> number',
  summary: 'The salt-to-base (form) factor MW_form / (moieties x MW_base), e.g. 2 base moieties per hemi-calcium salt.',
  reference: 'tablets spec C-02 (f_sb); C-06 worked example (1155.36 / 1117.28)',
  check(args) {
    arity(args, 3, 3, this.signature);
    const form = quantityArg(args, 0, 'salt_factor', { what: 'the molar mass of the form', dimension: DIM.MOLAR_MASS, dimensionLabel: 'a molar mass (e.g. g/mol)' });
    const base = quantityArg(args, 1, 'salt_factor', { what: 'the molar mass of the base', dimension: DIM.MOLAR_MASS, dimensionLabel: 'a molar mass (e.g. g/mol)' });
    commensurable(
      [
        { t: form, i: 0 },
        { t: base, i: 1 },
      ],
      'salt_factor',
      'the two molar masses',
    );
    const n = quantityArg(args, 2, 'salt_factor', { what: 'the number of base moieties', dimension: DIM.NUMBER, dimensionLabel: 'a whole number', tags: ['count', 'none'] });
    if (!n.unit.bareNumber) fail('EXPR-FN-004', 'salt_factor: the number of base moieties is a plain whole number, not a percentage', 2);
    return { kind: 'quantity', unit: DIMENSIONLESS, tag: 'none' };
  },
  cost: () => 6,
  evaluate(args, ctx) {
    const form = asQuantity(args[0]);
    const base = asQuantity(args[1]);
    const n = asQuantity(args[2]);
    const f = ctx.exact(form, form.unit);
    const b = ctx.exact(base, form.unit);
    positive(ctx, f, 0, 'the molar mass of the form');
    positive(ctx, b, 1, 'the molar mass of the base');
    if (!n.value.isInteger() || !n.value.isPositive()) ctx.domain(`salt_factor: the number of base moieties must be a whole number of at least 1, not ${n.value.toString()}`, 2);
    return ctx.result(rDiv(f, rMul(toRational(n.value), b)), DIMENSIONLESS, 'none');
  },
};

// ---------------------------------------------------------------- C-03 standard and adjusted quantity

function checkFactorAndOverage(args: Parameters<LibraryFunction['check']>[0], fn: string, factorAt: number, overageAt: number): void {
  quantityArg(args, factorAt, fn, { what: 'the salt-to-base factor', ...FRACTION, dimensionLabel: 'a plain number', tags: ['none'] });
  quantityArg(args, overageAt, fn, { what: 'the registered overage', ...FRACTION, tags: ['none'] });
}

function standard(ctx: EvalContext, base: QuantityValue, factor: QuantityValue, overage: QuantityValue, baseAt: number, factorAt: number, overageAt: number): Rational {
  const q = toRational(base.value);
  positive(ctx, q, baseAt, 'the base quantity');
  const f = fractionOf(factor);
  positive(ctx, f, factorAt, 'the salt-to-base factor');
  const ov = fractionOf(overage);
  nonNegative(ctx, ov, overageAt, 'the registered overage');
  return rMul(rMul(q, f), rAdd(R1, ov));
}

function adjust(ctx: EvalContext, standardQuantity: Rational, assay: QuantityValue, assayAt: number): Rational {
  const a = fractionOf(assay);
  positive(ctx, a, assayAt, 'the as-is assay');
  return rDiv(standardQuantity, a);
}

export const standardQuantity: LibraryFunction = {
  name: 'standard_quantity',
  signature: 'standard_quantity(base_quantity: mass, factor: number, overage: %) -> mass',
  summary: 'Quantity of the dispensed form at 100 % as-is: Q_base x f_sb x (1 + OV/100).',
  reference: 'tablets spec C-03 (Q_std); injectables spec C-02 (same factors)',
  check(args) {
    arity(args, 3, 3, this.signature);
    const base = quantityArg(args, 0, 'standard_quantity', { what: 'the base quantity', ...MASS });
    checkFactorAndOverage(args, 'standard_quantity', 1, 2);
    return { kind: 'quantity', unit: base.unit, tag: 'none' };
  },
  cost: () => 8,
  evaluate(args, ctx) {
    const base = asQuantity(args[0]);
    return ctx.result(standard(ctx, base, asQuantity(args[1]), asQuantity(args[2]), 0, 1, 2), base.unit, 'none');
  },
};

export const adjustedQuantity: LibraryFunction = {
  name: 'adjusted_quantity',
  signature: 'adjusted_quantity(standard_quantity: mass, assay_as_is: % w/w) -> mass',
  summary: 'Quantity to dispense for a lot: Q_std x 100 / A_asis (never less than the standard for an assay at or below 100 %).',
  reference: 'tablets spec C-03 (Q_act)',
  check(args) {
    arity(args, 2, 2, this.signature);
    const q = quantityArg(args, 0, 'adjusted_quantity', { what: 'the standard quantity', ...MASS });
    quantityArg(args, 1, 'adjusted_quantity', { what: 'the as-is assay', ...FRACTION, tag: 'w/w' });
    return { kind: 'quantity', unit: q.unit, tag: 'none' };
  },
  cost: () => 6,
  evaluate(args, ctx) {
    const q = asQuantity(args[0]);
    const r = toRational(q.value);
    positive(ctx, r, 0, 'the standard quantity');
    return ctx.result(adjust(ctx, r, asQuantity(args[1]), 1), q.unit, 'none');
  },
};

export const potencyAdjustedQuantity: LibraryFunction = {
  name: 'potency_adjusted_quantity',
  signature: 'potency_adjusted_quantity(base_quantity: mass, factor: number, overage: %, assay_as_is: % w/w) -> mass',
  summary: 'Potency-adjusted quantity of an active: Q_base x f_sb x (1 + OV/100) x 100 / A_asis.',
  reference: 'tablets spec C-03 and the C-06 worked example; injectables spec C-02 (with Q_base = C_label x V_batch)',
  check(args) {
    arity(args, 4, 4, this.signature);
    const base = quantityArg(args, 0, 'potency_adjusted_quantity', { what: 'the base quantity', ...MASS });
    checkFactorAndOverage(args, 'potency_adjusted_quantity', 1, 2);
    quantityArg(args, 3, 'potency_adjusted_quantity', { what: 'the as-is assay', ...FRACTION, tag: 'w/w' });
    return { kind: 'quantity', unit: base.unit, tag: 'none' };
  },
  cost: () => 10,
  evaluate(args, ctx) {
    const base = asQuantity(args[0]);
    const std = standard(ctx, base, asQuantity(args[1]), asQuantity(args[2]), 0, 1, 2);
    return ctx.result(adjust(ctx, std, asQuantity(args[3]), 3), base.unit, 'none');
  },
};

// ---------------------------------------------------------------- C-03 multiple lots

export const baseEquivalent: LibraryFunction = {
  name: 'base_equivalent',
  signature: 'base_equivalent(quantity: mass, factor: number, assay_as_is: % w/w) -> mass',
  summary: 'Base-equivalent supplied by a lot: Q_act x A_asis / (100 x f_sb).',
  reference: 'tablets spec C-03 (multiple lots: b_i)',
  check(args) {
    arity(args, 3, 3, this.signature);
    const q = quantityArg(args, 0, 'base_equivalent', { what: 'the lot quantity', ...MASS });
    quantityArg(args, 1, 'base_equivalent', { what: 'the salt-to-base factor', ...FRACTION, dimensionLabel: 'a plain number', tags: ['none'] });
    quantityArg(args, 2, 'base_equivalent', { what: 'the as-is assay', ...FRACTION, tag: 'w/w' });
    return { kind: 'quantity', unit: q.unit, tag: 'none' };
  },
  cost: () => 6,
  evaluate(args, ctx) {
    const q = asQuantity(args[0]);
    const r = toRational(q.value);
    nonNegative(ctx, r, 0, 'the lot quantity');
    const f = fractionOf(asQuantity(args[1]));
    positive(ctx, f, 1, 'the salt-to-base factor');
    const a = fractionOf(asQuantity(args[2]));
    positive(ctx, a, 2, 'the as-is assay');
    return ctx.result(rDiv(rMul(r, a), f), q.unit, 'none');
  },
};

export const quantityForBase: LibraryFunction = {
  name: 'quantity_for_base',
  signature: 'quantity_for_base(base_equivalent: mass, factor: number, assay_as_is: % w/w) -> mass',
  summary: 'Lot quantity that supplies a base-equivalent: b_i x f_sb x 100 / A_asis.',
  reference: 'tablets spec C-03 (multiple lots: Q_act,i)',
  check(args) {
    arity(args, 3, 3, this.signature);
    const q = quantityArg(args, 0, 'quantity_for_base', { what: 'the base-equivalent', ...MASS });
    quantityArg(args, 1, 'quantity_for_base', { what: 'the salt-to-base factor', ...FRACTION, dimensionLabel: 'a plain number', tags: ['none'] });
    quantityArg(args, 2, 'quantity_for_base', { what: 'the as-is assay', ...FRACTION, tag: 'w/w' });
    return { kind: 'quantity', unit: q.unit, tag: 'none' };
  },
  cost: () => 6,
  evaluate(args, ctx) {
    const q = asQuantity(args[0]);
    const r = toRational(q.value);
    nonNegative(ctx, r, 0, 'the base-equivalent');
    const f = fractionOf(asQuantity(args[1]));
    positive(ctx, f, 1, 'the salt-to-base factor');
    return ctx.result(adjust(ctx, rMul(r, f), asQuantity(args[2]), 2), q.unit, 'none');
  },
};

// ---------------------------------------------------------------- C-04 compensating excipient

export const compensatingExcipient: LibraryFunction = {
  name: 'compensating_excipient',
  signature: 'compensating_excipient(diluent_standard: mass, active_standard: mass, active_adjusted...: mass) -> mass',
  summary:
    'Adjusted quantity of the compensating (q.s.) excipient that keeps the core mass at the standard: Q_dil,std - (sum of the adjusted active quantities - Q_std). Refused if it would be negative.',
  reference: 'tablets spec C-04; C-06 worked example (diluent reduced by 0.4688 kg)',
  check(args) {
    arity(args, 3, 32, this.signature);
    const dil = quantityArg(args, 0, 'compensating_excipient', { what: 'the standard diluent quantity', ...MASS });
    const std = quantityArg(args, 1, 'compensating_excipient', { what: 'the standard active quantity', ...MASS });
    const adjusted = args.slice(2).map((_, k) => ({ t: scalarOrSeriesArg(args, k + 2, 'compensating_excipient', { what: 'an adjusted active quantity', ...MASS }), i: k + 2 }));
    const types: { t: QuantityType; i: number }[] = [{ t: dil, i: 0 }, { t: std, i: 1 }, ...adjusted];
    commensurable(types, 'compensating_excipient', 'the quantities');
    return { kind: 'quantity', unit: dil.unit, tag: 'none' };
  },
  cost: (args) => 4 * args.reduce((n, a) => n + maxLengthOf(a), 0),
  evaluate(args, ctx) {
    const dil = asQuantity(args[0]);
    const d = ctx.exact(dil, dil.unit);
    nonNegative(ctx, d, 0, 'the standard diluent quantity');
    const s = ctx.exact(asQuantity(args[1]), dil.unit);
    positive(ctx, s, 1, 'the standard active quantity');
    let total = R0;
    for (let i = 2; i < args.length; i += 1) {
      const values = valuesOf(args[i]);
      if (args[i]?.kind === 'series' && values.length === 0) ctx.emptySeries(i);
      for (const v of values) {
        const r = ctx.exact(v, dil.unit);
        positive(ctx, r, i, 'an adjusted active quantity');
        total = rAdd(total, r);
      }
    }
    const result = rSub(d, rSub(total, s));
    if (sign(result) < 0) {
      ctx.domain(`compensating_excipient: the excipient would be negative; the adjusted actives exceed the standard by more than the ${text(dil)} of diluent`, 0);
    }
    return ctx.result(result, dil.unit, 'none');
  },
};

// ---------------------------------------------------------------- C-05 dry basis

export const asIsFromDry: LibraryFunction = {
  name: 'as_is_from_dry',
  signature: 'as_is_from_dry(dry_quantity: mass, lod: % LOD) -> mass',
  summary: 'As-is quantity of a material specified on a dry basis: Q_dry x 100 / (100 - LOD).',
  reference: 'tablets spec C-05',
  check(args) {
    arity(args, 2, 2, this.signature);
    const q = quantityArg(args, 0, 'as_is_from_dry', { what: 'the dry-basis quantity', ...MASS });
    quantityArg(args, 1, 'as_is_from_dry', { what: 'the LOD', ...FRACTION, tag: 'lod' });
    return { kind: 'quantity', unit: q.unit, tag: 'none' };
  },
  cost: () => 6,
  evaluate(args, ctx) {
    const q = asQuantity(args[0]);
    const r = toRational(q.value);
    positive(ctx, r, 0, 'the dry-basis quantity');
    const lod = fractionOf(asQuantity(args[1]));
    nonNegative(ctx, lod, 1, 'the LOD');
    belowWhole(ctx, lod, 1, 'the LOD');
    return ctx.result(rDiv(r, rSub(R1, lod)), q.unit, 'none');
  },
};

// ---------------------------------------------------------------- density (injectables C-01, generic)

export const massFromVolume: LibraryFunction = {
  name: 'mass_from_volume',
  signature: 'mass_from_volume(volume, density) -> mass',
  summary: 'Mass of a volume of liquid: m = V x rho (rho measured at its stated temperature).',
  reference: 'injectables spec C-01 (m = V x rho); generic density conversion',
  check(args) {
    arity(args, 2, 2, this.signature);
    const v = quantityArg(args, 0, 'mass_from_volume', { what: 'the volume', dimension: DIM.VOLUME, dimensionLabel: 'a volume', tags: ['none'] });
    const rho = quantityArg(args, 1, 'mass_from_volume', { what: 'the density', dimension: DIM.DENSITY, dimensionLabel: 'a density (mass per volume)', tags: ['none'] });
    return { kind: 'quantity', unit: multiplyUnits(v.unit, rho.unit), tag: 'none' };
  },
  cost: () => 4,
  evaluate(args, ctx) {
    const v = asQuantity(args[0]);
    const rho = asQuantity(args[1]);
    const vr = toRational(v.value);
    nonNegative(ctx, vr, 0, 'the volume');
    const rr = toRational(rho.value);
    positive(ctx, rr, 1, 'the density');
    return ctx.result(rMul(vr, rr), multiplyUnits(v.unit, rho.unit), 'none');
  },
};

export const volumeFromMass: LibraryFunction = {
  name: 'volume_from_mass',
  signature: 'volume_from_mass(mass, density) -> volume',
  summary: 'Volume of a mass of liquid: V = m / rho.',
  reference: 'injectables spec C-01 (V = m / rho); generic density conversion',
  check(args) {
    arity(args, 2, 2, this.signature);
    const m = quantityArg(args, 0, 'volume_from_mass', { what: 'the mass', ...MASS, tags: ['none'] });
    const rho = quantityArg(args, 1, 'volume_from_mass', { what: 'the density', dimension: DIM.DENSITY, dimensionLabel: 'a density (mass per volume)', tags: ['none'] });
    return { kind: 'quantity', unit: divideUnits(m.unit, rho.unit), tag: 'none' };
  },
  cost: () => 4,
  evaluate(args, ctx) {
    const m = asQuantity(args[0]);
    const rho = asQuantity(args[1]);
    const mr = toRational(m.value);
    nonNegative(ctx, mr, 0, 'the mass');
    const rr = toRational(rho.value);
    positive(ctx, rr, 1, 'the density');
    return ctx.result(rDiv(mr, rr), divideUnits(m.unit, rho.unit), 'none');
  },
};
