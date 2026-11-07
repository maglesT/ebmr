/**
 * Phase 7 slice 7o (R4, R8; D-7o-5): a master copied from an approved master for another formula takes this formula's
 * standard quantity per tablet: route W's dispensing standard (its formula's mg per tablet times the batch size) is written
 * from the new formula, and route W's golden case of that calculation, which held for its own formula, is left out. The
 * copy defines without errors; the other calculations and golden cases stay the source's.
 */
import { describe, expect, it } from 'vitest';
import type { formula } from '@ebmr/recipe-core';
import { rtwProcessingContent } from '../../src/cli/demo-route-masters.ts';
import { definitionFindings } from '../../src/features/designer/definition.ts';
import { contentFromFormula, standardPerTabletMg, type FormulaSource } from '../../src/features/designer/from-formula.ts';
import { withFormulaBom } from '../../src/features/designer/formula-choice.ts';
import { TEMPLATES } from '../../src/features/designer/templates/index.ts';

const line = (lineId: string, materialCode: string, role: formula.FormulaLineRole, basis: 'PER_UNIT' | 'PER_BATCH', quantity: string, batchQuantity: string, extra: Partial<formula.FormulaLine> = {}): formula.FormulaLine => ({
  lineId, materialCode, materialName: materialCode, role, basis, quantity, quantityUnit: basis === 'PER_UNIT' ? 'mg' : 'kg', overagePercent: null, saltFactor: null,
  potencyAdjusted: false, compensating: false, batchQuantity, batchUnit: 'kg', ...extra,
});

/** Demotab sodium 400 mg (invented): route W's excipients with its own active, 1,50,000 tablets. */
const SRC: FormulaSource = {
  chosen: {
    formulaId: '11111111-2222-4333-8444-555555555500', versionId: '11111111-2222-4333-8444-555555555501', versionNumber: 1, productCode: 'DMT400-T', strength: '400 mg', batchSizeUnits: '150000', batchMassKg: '85.395',
    lines: [
      line('api', 'DMT-API-T', 'ACTIVE', 'PER_UNIT', '400', '64.391', { saltFactor: '1.07318', potencyAdjusted: true }),
      line('mcc', 'MAT-MCC-101', 'EXCIPIENT', 'PER_UNIT', '40', '6.000', { compensating: true }),
      line('lac', 'MAT-LAC-MH', 'EXCIPIENT', 'PER_UNIT', '70', '10.500'),
      line('pvp', 'MAT-PVP-K30', 'EXCIPIENT', 'PER_UNIT', '12', '1.800'),
      line('ipa', 'MAT-IPA', 'PROCESSING_AID', 'PER_BATCH', '1.800', '1.800'),
      line('ccs', 'MAT-CCS', 'EXCIPIENT', 'PER_UNIT', '12', '1.800'),
      line('sio', 'MAT-SIO2', 'EXCIPIENT', 'PER_UNIT', '2', '0.300'),
      line('mgs', 'MAT-MGST', 'EXCIPIENT', 'PER_UNIT', '4', '0.600'),
      line('fcs', 'MAT-ECS-01', 'PROCESSING_AID', 'PER_BATCH', '2.400', '2.400'),
    ],
  },
  target: { targetUnitMassMg: '569.272', batchSizesUnits: ['150000'] },
  product: { name: 'Demotab 400 mg, wet granulation, film coated, alu-alu', dosageForm: 'Film-coated tablet' },
  materials: ['DMT-API-T', 'MAT-MCC-101', 'MAT-LAC-MH', 'MAT-PVP-K30', 'MAT-IPA', 'MAT-CCS', 'MAT-SIO2', 'MAT-MGST', 'MAT-ECS-01'].map((code, i) => ({
    versionId: `11111111-2222-4333-8444-5555555556${String(i).padStart(2, '0')}`, code, name: code, kind: code === 'DMT-API-T' ? 'API' : 'EXCIPIENT', unit: 'kg',
  })),
};

describe('a copy of an approved master for another formula (slice 7o, D-7o-5)', () => {
  it('[PR-01][INV-25][DI-04] the copy\'s dispensing standard is this formula\'s mg per tablet; the source\'s golden case of it is left out; the other calculations and the copy\'s definition hold', () => {
    const source = rtwProcessingContent('RTW-WG-SRC');
    const base = TEMPLATES.get('dc-mini');
    if (!base) throw new Error('no dc-mini');
    const c = contentFromFormula(base, SRC, { familyCode: 'DMT400-T-01', markets: ['IN'], start: 'COPY' }, source);
    // 400 x 1.07318 + 40 + 70 + 12 + 12 + 2 + 4 mg per tablet, and the aids (1.800 + 2.400 kg over 1,50,000 tablets: 12 + 16 mg).
    expect(standardPerTabletMg(SRC)).toBe('597.272');
    const std = c.calculations.find((x) => x.id === 'dispStd');
    expect(std?.expression).toBe('597.272 [mg] * tabletsPerBatch');
    expect(source.calculations.find((x) => x.id === 'dispStd')?.expression).toMatch(/^\(250 \[mg\]/);
    const gone = source.goldenCases.filter((g) => 'dispStd' in g.expected || 'dispStd' in g.inputs).map((g) => g.id);
    expect(gone.length).toBeGreaterThan(0);
    expect(c.goldenCases.map((g) => g.id)).toEqual(source.goldenCases.map((g) => g.id).filter((id) => !gone.includes(id)));
    for (const k of ['granYield', 'blendYield', 'compYield', 'coatGain']) expect(c.calculations.find((x) => x.id === k)?.expression).toBe(source.calculations.find((x) => x.id === k)?.expression);
    // The BOM is this formula's, its lines keep the source's ids (the steps keep consuming them).
    // The active the base-stated TB-01 step dispenses holds its base (400 mg x 1,50,000 = 60 kg), the salt factor left to
    // TB-01's molar masses (recipe-core 0690; found by the R4 browser run); every other line is the formula's batch quantity.
    expect(c.bom.map((b) => `${b.id}=${b.material}:${b.quantity.value}`)).toEqual(SRC.chosen.lines.map((l) => `BOM-${l.lineId.toUpperCase()}=${l.materialCode}:${l.lineId === 'api' ? '60' : l.batchQuantity}`));
    expect(c.header.product).toMatchObject({ code: 'DMT400-T', strength: '400 mg' });
    // A material the approved source names keeps the source's own reference (found by the R4 browser run); the new
    // active is pinned to its material master version.
    for (const code of ['MAT-MCC-101', 'MAT-LAC-MH', 'MAT-MGST']) {
      const was = source.references.find((r) => r.kind === 'MATERIAL' && r.code === code);
      expect(was).toBeDefined();
      expect(c.references.filter((r) => r.kind === 'MATERIAL' && r.code === code)).toEqual([was]);
    }
    expect(c.references.filter((r) => r.kind === 'MATERIAL' && r.code === 'DMT-API-T')).toHaveLength(1);
    expect(definitionFindings(c).filter((f) => f.severity === 'ERROR')).toEqual([]);
  });
});

describe('a copy names the copy\'s own materials (R10 #9, slice 7u)', () => {
  it('[PR-01][INV-25] a parameter, calculation or step named after the source\'s active takes the name of this formula\'s active from its material master; the source is not changed', () => {
    const source = rtwProcessingContent('RTW-WG-SRC');
    const base = TEMPLATES.get('dc-mini');
    if (!base) throw new Error('no dc-mini');
    const named: FormulaSource = { ...SRC, materials: SRC.materials.map((m) => (m.code === 'DMT-API-T' ? { ...m, name: 'Demotab sodium (invented data)' } : m)) };
    const c = contentFromFormula(base, named, { familyCode: 'DMT400-T-01', markets: ['IN'], start: 'COPY' }, source);
    expect(source.parameters.find((p) => p.id === 'dispApi')?.name).toBe('Exemplazine sodium dispensed (potency-adjusted)');
    expect(c.parameters.find((p) => p.id === 'dispApi')?.name).toBe('Demotab sodium dispensed (potency-adjusted)');
    const names = [...c.parameters, ...c.calculations, ...c.yieldCheckpoints].map((x) => x.name);
    expect(names.filter((n) => /exemplazine/i.test(n))).toEqual([]);
    // A material the copy keeps (the compensating cellulose) keeps its names.
    expect(c.parameters.find((p) => p.id === 'dispMcc')?.name).toBe(source.parameters.find((p) => p.id === 'dispMcc')?.name);
    expect(definitionFindings(c).filter((f) => f.severity === 'ERROR')).toEqual([]);
  });
});

describe('a copy for a formula with a material on two lines (demo finding D-2, lead audit of #160)', () => {
  const withLac2 = (lac2First: boolean): FormulaSource => {
    const lines = SRC.chosen.lines.filter((l) => l.lineId !== 'lac');
    const lac = SRC.chosen.lines.find((l) => l.lineId === 'lac') as formula.FormulaLine;
    const lac2 = line('lac2', 'MAT-LAC-MH', 'EXCIPIENT', 'PER_UNIT', '20', '3.000');
    lines.splice(2, 0, ...(lac2First ? [lac2, lac] : [lac, lac2]));
    return { ...SRC, chosen: { ...SRC.chosen, lines } };
  };

  const twoLines = (lac2First: boolean): void => {
    const source = rtwProcessingContent('RTW-WG-SRC');
    const base = TEMPLATES.get('dc-mini');
    if (!base) throw new Error('no dc-mini');
    const src = withLac2(lac2First);
    const c = contentFromFormula(base, src, { familyCode: 'DMT400-T-02', markets: ['IN'], start: 'COPY' }, source);
    const ids = c.bom.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    const lacLines = c.bom.filter((b) => b.material === source.bom.find((x) => x.id === 'BOM-LAC')?.material).map((b) => `${b.id}:${b.quantity.value}`);
    expect(lacLines.sort()).toEqual(['BOM-LAC2:3.000', 'BOM-LAC:10.500']);
    // The master's quantities from the formula (withFormulaBom, at definition): each BOM line its own formula line's.
    const q = withFormulaBom(c, src.chosen);
    expect(q.bom.filter((b) => b.id.startsWith('BOM-LAC')).map((b) => `${b.id}:${b.quantity.value}`).sort()).toEqual(['BOM-LAC2:3.000', 'BOM-LAC:10.500']);
  };
  it('[PR-03][INV-25] a material on two formula lines is matched by line id (lac before lac2): one BOM line per formula line, the source\'s BOM-LAC kept for lac, a new BOM-LAC2; the quantities are each line\'s own', () => {
    twoLines(false);
  });
  it('[PR-03][INV-25] a material on two formula lines is matched by line id (lac2 before lac): the same lines, no BOM-LAC taken twice', () => {
    twoLines(true);
  });

  it('[PR-03][INV-25] a material on one formula line takes the source\'s BOM line of that material under the source\'s id; on two lines it does not, and withFormulaBom refuses a BOM line of a repeated material that names no formula line', () => {
    const source = rtwProcessingContent('RTW-WG-SRC');
    const base = TEMPLATES.get('dc-mini');
    if (!base) throw new Error('no dc-mini');
    const renamed = structuredClone(source);
    const was = renamed.bom.find((b) => b.id === 'BOM-LAC');
    if (!was) throw new Error('no BOM-LAC in the source');
    was.id = 'BOM-LACTOSE';
    const one = contentFromFormula(base, SRC, { familyCode: 'DMT400-T-03', markets: ['IN'], start: 'COPY' }, renamed);
    expect(one.bom.filter((b) => b.material === was.material).map((b) => b.id)).toEqual(['BOM-LACTOSE']);
    const two = contentFromFormula(base, withLac2(true), { familyCode: 'DMT400-T-04', markets: ['IN'], start: 'COPY' }, renamed);
    expect(two.bom.filter((b) => b.material === was.material).map((b) => b.id).sort()).toEqual(['BOM-LAC', 'BOM-LAC2']);
    const stray = structuredClone(two);
    const lac = stray.bom.find((b) => b.id === 'BOM-LAC');
    if (lac) lac.id = 'BOM-LACTOSE';
    let refused: unknown;
    try {
      withFormulaBom(stray, withLac2(true).chosen);
    } catch (e) {
      refused = e;
    }
    expect(JSON.stringify(refused)).toMatch(/BOM line BOM-LACTOSE .* is not a line of the formula/);
  });
});
