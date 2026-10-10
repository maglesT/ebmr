/**
 * TB-01 calculations (tablets spec C-01 to C-04), pure: the worked example of C-06, the catalogue case of PR-19 (an API
 * lot assayed at 98.5 % raises the target and lowers the filler), multi-lot allocation, the roundings the MBR declares
 * (the active UP to the readability, the excipient to the nearest step) and the refusals (a missing result, a negative
 * or out-of-range excipient, shares that do not add up).
 */
import { describe, expect, it } from 'vitest';
import { asIsAssay, exact, potencyTargets, q, roundToStep, type PotencyInput } from '../../../src/blocks/dispensing/potency.ts';

const atorvastatin: PotencyInput = {
  standardQuantity: '8.000',
  standardIs: 'BASE',
  form: { molarMassForm: '1155.36', molarMassBase: '558.64', baseMoieties: 2 },
  overagePercent: '0',
  lots: [{ assay: { basis: 'ANHYDROUS_WATER', assay: '99.2', water: '4.6' } }],
  excipient: { standard: '20.000', min: '18.000', max: '22.000' },
  readability: '0.001',
};

describe('TB-01 calculations C-01 to C-04 (exact)', () => {
  it('[PR-19][DI-33] the C-06 worked example: as-is assay 94.6368 %, adjusted 8.741486 kg, target rounded up to 8.742 kg, the diluent reduced by 0.469 kg', () => {
    const r = potencyTargets(atorvastatin);
    if (!r.ok) throw new Error(r.message);
    expect(r.result.factor).toBe('1.034083');
    expect(r.result.standard).toBe('8.272662');
    expect(r.result.lots).toEqual([{ asIsAssay: '94.6368', baseEquivalent: '8', calculated: '8.741486', target: '8.742' }]);
    expect(r.result.excipient).toEqual({ standard: '20.000', calculated: '19.531177', target: '19.531' });
    expect(r.result.total).toEqual({ standard: '28.272662', target: '28.273' });
  });

  it('[PR-19] an API lot assayed at 98.5 % (as is) raises the active target above the standard and lowers the filler by the same amount (within one readability step)', () => {
    const r = potencyTargets({ standardQuantity: '10.000', standardIs: 'FORM', overagePercent: '0', lots: [{ assay: { basis: 'AS_IS', assay: '98.5' } }], excipient: { standard: '40.000', min: '39.000', max: '41.000' }, readability: '0.001' });
    if (!r.ok) throw new Error(r.message);
    expect(r.result.factor).toBe('1.000000');
    expect(r.result.lots[0]).toMatchObject({ calculated: '10.152284', target: '10.153' });
    expect(r.result.excipient).toEqual({ standard: '40.000', calculated: '39.847716', target: '39.848' });
    expect(r.result.total).toEqual({ standard: '50.000000', target: '50.001' });
    expect(r.result.adjustmentPercent).toBe('1.522843');
  });

  it('[PR-19] rounding never lowers the active (UP, even a hair above a step) and the excipient goes to the nearest step, half away from zero', () => {
    expect(roundToStep(q('8.7410001'), '0.001', 'UP')).toBe('8.742');
    expect(roundToStep(q('8.741'), '0.001', 'UP')).toBe('8.741');
    expect(roundToStep(q('19.5315'), '0.001', 'HALF_UP')).toBe('19.532');
    expect(roundToStep(q('19.5314999'), '0.001', 'HALF_UP')).toBe('19.531');
    expect(roundToStep(q('-0.0005'), '0.001', 'HALF_UP')).toBe('-0.001');
    expect(roundToStep(q('12.3'), '0.05', 'UP')).toBe('12.30');
    expect(roundToStep(q('12.31'), '0.05', 'UP')).toBe('12.35');
  });

  it('[PR-19] C-01 on every basis, and a missing result blocks the calculation', () => {
    const v = (a: Parameters<typeof asIsAssay>[0]) => {
      const r = asIsAssay(a);
      return r.ok ? exact(r.value) : r.message;
    };
    expect(v({ basis: 'AS_IS', assay: '99.5' })).toBe('99.5');
    expect(v({ basis: 'DRIED_LOD', assay: '100.2', lod: '0.5' })).toBe('99.699');
    expect(v({ basis: 'ANHYDROUS_SOLVENT_FREE', assay: '99.0', water: '3.0', solvents: '0.4' })).toBe('95.634');
    expect(v({ basis: 'ANHYDROUS_WATER', assay: '99.2' })).toMatch(/water result its basis needs is missing/);
    expect(v({ basis: 'DRIED_LOD', assay: '99.2' })).toMatch(/loss on drying/);
  });

  it('[PR-19] two lots share the base-equivalent the batch needs; shares that do not add up, or a lot without one, are refused', () => {
    const two = { ...atorvastatin, lots: [{ assay: { basis: 'AS_IS' as const, assay: '96.0' }, baseEquivalent: '5.000' }, { assay: { basis: 'AS_IS' as const, assay: '95.0' }, baseEquivalent: '3.000' }] };
    const r = potencyTargets(two);
    if (!r.ok) throw new Error(r.message);
    expect(r.result.lots.map((l) => [l.baseEquivalent, l.target])).toEqual([['5', '5.386'], ['3', '3.266']]);
    const short = potencyTargets({ ...two, lots: [two.lots[0] as PotencyInput['lots'][number], { ...(two.lots[1] as PotencyInput['lots'][number]), baseEquivalent: '2.999' }] });
    expect(short).toMatchObject({ ok: false, code: 'TB01-ALLOCATION' });
    expect(potencyTargets({ ...two, lots: [two.lots[0] as PotencyInput['lots'][number], { assay: { basis: 'AS_IS', assay: '95.0' } }] })).toMatchObject({ ok: false, code: 'TB01-ALLOCATION' });
  });

  it('[PR-19][PR-04] the compensating excipient never goes negative or outside its approved range; a registered overage raises the standard', () => {
    expect(potencyTargets({ ...atorvastatin, excipient: { standard: '0.300', min: '0', max: '1' } })).toMatchObject({ ok: false, code: 'TB01-EXCIPIENT-NEGATIVE' });
    expect(potencyTargets({ ...atorvastatin, excipient: { standard: '20.000', min: '19.600', max: '22.000' } })).toMatchObject({ ok: false, code: 'TB01-EXCIPIENT-RANGE' });
    const over = potencyTargets({ ...atorvastatin, overagePercent: '2' });
    if (!over.ok) throw new Error(over.message);
    expect(over.result.lots[0]?.baseEquivalent).toBe('8.16');
    expect(over.result.standard).toBe('8.438115');
  });
});
