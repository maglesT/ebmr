/**
 * TB-01 calculations (tablets spec C-01 to C-04) at their edges: the exact decimal reading and writing the database
 * repeats bit for bit (tablets 0842), the roundings at zero and at an integer step, the assay and allocation limits at
 * their boundaries and every refusal with its message. Written for the Phase 3 exit mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import { asIsAssay, exact, potencyTargets, q, roundToStep, saltFactor, type PotencyInput } from '../../../src/blocks/dispensing/potency.ts';

type Lot = PotencyInput['lots'][number];
const asIs = (assay: string, baseEquivalent?: string): Lot => ({ assay: { basis: 'AS_IS', assay }, ...(baseEquivalent === undefined ? {} : { baseEquivalent }) });
const plain: PotencyInput = { standardQuantity: '10.000', standardIs: 'FORM', overagePercent: '0', lots: [asIs('98.5')], readability: '0.001' };
const atorvastatin: PotencyInput = {
  standardQuantity: '8.000',
  standardIs: 'BASE',
  form: { molarMassForm: '1155.36', molarMassBase: '558.64', baseMoieties: 2 },
  overagePercent: '0',
  lots: [{ assay: { basis: 'ANHYDROUS_WATER', assay: '99.2', water: '4.6' } }],
  excipient: { standard: '20.000', min: '18.000', max: '22.000' },
  readability: '0.001',
};
const refusal = (input: PotencyInput) => {
  const r = potencyTargets(input);
  return r.ok ? 'ok' : `${r.code}: ${r.message}`;
};

describe('TB-01 exact decimals (the database repeats them bit for bit)', () => {
  it('[DI-33][PR-19] decimal text reads exactly, signed or not, and anything else is refused', () => {
    expect(q('-1.5')).toEqual({ n: -15n, d: 10n });
    expect(q('12')).toEqual({ n: 12n, d: 1n });
    expect(q('0.050')).toEqual({ n: 50n, d: 1000n });
    for (const bad of ['', '.5', '5.', '+1', '1e5', '01', '1,5', 'abc']) expect(() => q(bad), bad).toThrow(`${bad} is not decimal text`);
  });

  it('[DI-33][PR-19] exact writes the shortest exact text: integers, trailing and inner zeros, negatives, leading zeros, any terminating fraction', () => {
    expect(exact(q('5'))).toBe('5');
    expect(exact(q('50'))).toBe('50');
    expect(exact(q('10.5'))).toBe('10.5');
    expect(exact(q('100.500'))).toBe('100.5');
    expect(exact(q('-1.5'))).toBe('-1.5');
    expect(exact(q('-20'))).toBe('-20');
    expect(exact(q('0.05'))).toBe('0.05');
    expect(exact(q('0'))).toBe('0');
    expect(exact({ n: 1n, d: 4n })).toBe('0.25');
    expect(exact({ n: 3n, d: 8n })).toBe('0.375');
    expect(exact({ n: 1n, d: 10n ** 200n })).toBe(`0.${'0'.repeat(199)}1`);
    expect(() => exact({ n: 1n, d: 3n })).toThrow('not a terminating decimal');
  });

  it('[DI-33][PR-19] rounding to a step: zero stays unsigned zero, an integer step writes no point, an UP rounding of a negative quantity is refused', () => {
    expect(roundToStep(q('0'), '0.001', 'HALF_UP')).toBe('0.000');
    expect(roundToStep(q('0'), '0.001', 'UP')).toBe('0.000');
    expect(roundToStep(q('12.4'), '1', 'HALF_UP')).toBe('12');
    expect(roundToStep(q('12.5'), '1', 'HALF_UP')).toBe('13');
    expect(roundToStep(q('-12.5'), '1', 'HALF_UP')).toBe('-13');
    expect(roundToStep(q('12.01'), '1', 'UP')).toBe('13');
    expect(() => roundToStep(q('-1'), '0.001', 'UP')).toThrow('an UP rounding is of a positive quantity');
  });

  it('[DI-33][PR-19] a negative divisor keeps the sign in the numerator (the salt factor of a negative molar mass is negative), and a zero divisor is refused', () => {
    const f = saltFactor({ standardIs: 'BASE', form: { molarMassForm: '1', molarMassBase: '-2', baseMoieties: 1 } });
    expect(f).toEqual({ n: -1n, d: 2n });
    expect(exact(f)).toBe('-0.5');
    expect(() => potencyTargets({ ...plain, standardQuantity: '0' })).toThrow('division by zero');
  });
});

describe('TB-01 C-01 to C-04 at their limits', () => {
  it('[PR-19] C-01: each missing result of the anhydrous solvent-free basis blocks, and the as-is assay is usable only above 0 and at most 200 %', () => {
    const v = (a: Parameters<typeof asIsAssay>[0]) => {
      const r = asIsAssay(a);
      return r.ok ? exact(r.value) : r.message;
    };
    expect(v({ basis: 'ANHYDROUS_SOLVENT_FREE', assay: '99', solvents: '0.4' })).toBe('the water result its basis needs is missing');
    expect(v({ basis: 'ANHYDROUS_SOLVENT_FREE', assay: '99', water: '3' })).toBe('the solvents result its basis needs is missing');
    expect(v({ basis: 'AS_IS', assay: '200' })).toBe('200');
    expect(v({ basis: 'AS_IS', assay: '0.001' })).toBe('0.001');
    expect(v({ basis: 'AS_IS', assay: '200.01' })).toBe('the as-is assay 200.01 % is not a usable assay (above 0 and at most 200 %)');
    expect(v({ basis: 'AS_IS', assay: '0' })).toBe('the as-is assay 0 % is not a usable assay (above 0 and at most 200 %)');
    expect(v({ basis: 'ANHYDROUS_WATER', assay: '99', water: '100' })).toMatch(/is not a usable assay/);
  });

  it('[PR-19] C-02: the factor is 1 when the standard is stated on the form (even with molar masses given) or no form is declared', () => {
    expect(exact(saltFactor({ standardIs: 'FORM', form: { molarMassForm: '2', molarMassBase: '1', baseMoieties: 1 } }))).toBe('1');
    expect(exact(saltFactor({ standardIs: 'BASE' }))).toBe('1');
    expect(exact(saltFactor({ standardIs: 'BASE', form: { molarMassForm: '3', molarMassBase: '1', baseMoieties: 2 } }))).toBe('1.5');
  });

  it('[PR-19] one to three lots, a positive readability, and a refusal names the lot by its position', () => {
    expect(refusal({ ...plain, lots: [] })).toBe('TB01-LOTS: an active is allocated across one to three lots');
    expect(refusal({ ...plain, lots: [asIs('99', '3'), asIs('99', '3'), asIs('99', '3'), asIs('99', '1')] })).toBe('TB01-LOTS: an active is allocated across one to three lots');
    expect(refusal({ ...plain, lots: [asIs('99', '3'), asIs('99', '3'), asIs('99', '4')] })).toBe('ok');
    expect(refusal({ ...plain, readability: '0' })).toBe('TB01-READABILITY: the readability is positive');
    expect(refusal({ ...plain, readability: '-0.001' })).toBe('TB01-READABILITY: the readability is positive');
    expect(refusal({ ...plain, lots: [asIs('99', '7'), asIs('0', '3')] })).toBe('TB01-ASSAY: lot 2: the as-is assay 0 % is not a usable assay (above 0 and at most 200 %)');
  });

  it('[PR-19] allocation: one lot carries exactly the whole need, several lots each state a positive share and the shares add up to the need', () => {
    expect(refusal({ ...plain, lots: [asIs('99', '10')] })).toBe('ok');
    expect(refusal({ ...plain, lots: [asIs('99', '9.999')] })).toBe('TB01-ALLOCATION: the one lot carries the whole base-equivalent of 10, not 9.999');
    expect(refusal({ ...plain, lots: [asIs('99', '10'), asIs('99')] })).toBe('TB01-ALLOCATION: lot 2 states no base-equivalent share: with more than one lot each states its share');
    expect(refusal({ ...plain, lots: [asIs('99', '10'), asIs('99', '0')] })).toBe('TB01-ALLOCATION: lot 2 states a share that is not positive (0)');
    expect(refusal({ ...plain, lots: [asIs('99', '10.5'), asIs('99', '-0.5')] })).toBe('TB01-ALLOCATION: lot 2 states a share that is not positive (-0.5)');
    expect(refusal({ ...plain, lots: [asIs('99', '7'), asIs('99', '2.999')] })).toBe("TB01-ALLOCATION: the lots' base-equivalent shares add up to 9.999, not to the 10 the batch needs");
  });

  it('[PR-19][PR-04] C-04: the excipient target may be exactly zero or exactly at either end of its range; without compensation there is no excipient', () => {
    // The worked example's excipient target is 19.531 (C-06).
    expect(refusal({ ...atorvastatin, excipient: { standard: '20.000', min: '19.531', max: '19.531' } })).toBe('ok');
    expect(refusal({ ...atorvastatin, excipient: { standard: '20.000', min: '19.532', max: '22' } })).toBe('TB01-EXCIPIENT-RANGE: the compensating excipient would be 19.531, outside its approved range 19.532 to 22');
    expect(refusal({ ...atorvastatin, excipient: { standard: '20.000', min: '18', max: '19.530' } })).toBe('TB01-EXCIPIENT-RANGE: the compensating excipient would be 19.531, outside its approved range 18 to 19.530');
    const zero = potencyTargets({ ...atorvastatin, excipient: { standard: '0.469', min: '0', max: '1' } });
    if (!zero.ok) throw new Error(zero.message);
    expect(zero.result.excipient).toEqual({ standard: '0.469', calculated: '0.000177', target: '0.000' });
    expect(refusal({ ...atorvastatin, excipient: { standard: '0.468', min: '0', max: '1' } })).toBe('TB01-EXCIPIENT-NEGATIVE: the compensating excipient would be -0.001, below zero');
    const none = potencyTargets({ ...atorvastatin, excipient: undefined });
    if (!none.ok) throw new Error(none.message);
    expect(none.result.excipient).toBeNull();
    expect(none.result.total).toEqual({ standard: '8.272662', target: '8.742' });
  });

  it('[PR-19] the adjustment is shown as a magnitude: an assay above 100 % lowers the active and still shows a positive percentage', () => {
    const r = potencyTargets({ ...plain, lots: [asIs('102')] });
    if (!r.ok) throw new Error(r.message);
    expect(r.result.lots[0]).toMatchObject({ calculated: '9.803922', target: '9.804' });
    expect(r.result.adjustmentPercent).toBe('1.960784');
  });
});
