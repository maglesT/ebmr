/**
 * TB-01@1 at its edges (pure, in the engine): every definition check with its message and controls, the configuration's
 * defaults, the lot gate at the instant of expiry and retest, identity testing by market, the lots as stored with each
 * basis, the unit checks of a weighing, and the tolerance at PERFORMED at its boundary. Written for the Phase 3 exit
 * mutation run (decision 0009).
 */
import { describe, expect, it } from 'vitest';
import { blocks, type engine, type flow } from '@ebmr/recipe-core/pure';
import { mbrWith, phase } from '../../../../../packages/recipe-core/test/flow/support.ts';
import { define, Run, sig, T0 } from '../../../../../packages/recipe-core/test/engine/support.ts';
import { TB01, tb01Config } from '../../../src/blocks/tb-01.ts';
import { tabletsBlockCatalog, tabletsBlockRegistry } from '../../../src/features/edition-blocks.ts';

type Json = Record<string, unknown>;
const DISP1: engine.Actor = { id: 'DISP1', kind: 'PERSON', roles: ['DISPENSER'] };
const fixture = TB01.goldenFixture as blocks.BlockGoldenFixture;
const baseConfig = fixture.phase.config as Json;
const active = baseConfig['active'] as Json;
const form = active['form'] as Json;
const BOM = fixture.bom ?? [];

function mbr(config: Json = baseConfig, extra: Partial<flow.PhaseNode> = {}, more: { bom?: flow.BomLine[]; marketSet?: string[]; references?: flow.MbrContent['references'] } = {}): flow.MbrContent {
  const p = phase('p', { ...(fixture.phase as Partial<flow.PhaseNode>), config: config as flow.PhaseNode['config'], ...extra });
  const m = mbrWith({ kind: 'sequence', id: 'ops', children: [p, phase('after')] }, {
    parameters: fixture.parameters ?? [],
    bom: more.bom ?? BOM,
    references: more.references ?? [{ id: 'RSK', kind: 'RISK_SCALE', code: 'RSK', version: '1', hash: 'a'.repeat(64) }],
  });
  return more.marketSet ? { ...m, header: { ...m.header, marketSet: more.marketSet } } : m;
}
const definition = (m: flow.MbrContent) => define(m, { registry: tabletsBlockRegistry(), catalog: tabletsBlockCatalog });
/** The definition problems of an MBR: code, message and controls. */
const problems = (m: flow.MbrContent): { code: string; message: string; controls: readonly string[] }[] => {
  try {
    definition(m);
    return [];
  } catch (e) {
    return (e as engine.EngineDefinitionError).problems.filter((p) => p.code.startsWith('TB01')).map((p) => ({ code: p.code, message: p.message, controls: (p as { controls?: readonly string[] }).controls ?? [] }));
  }
};
const lot = (id: string, material: string, extra: Json = {}): Json => ({ id, material, status: 'RELEASED', identityTested: true, ...extra });
const ASSAY = { resultId: '00000000-0000-4000-8000-0000000000a1', basis: 'ANHYDROUS_WATER', assay: '99.2', water: '4.6' };
const calc = (lots: Json[] = [{ lot: lot('AR-ATV-1', 'MAT-ATV'), assay: ASSAY }]): Json & { kind: string } => ({ kind: 'POTENCY_CALCULATION', lots });
const weigh = (bomLine: string, l: Json, gross: string, extra: Json = {}): Json & { kind: string } => ({
  kind: 'CONTAINER_WEIGHING', item: bomLine === 'BOM-API' ? 'dispApi' : 'dispMcc', bomLine, container: `C-${String(l['id'])}-${gross}`, lot: l, gross, tare: '0.000', unit: 'kg', balance: 'BAL-07', source: 'DEVICE', ...extra,
});
function started(m: flow.MbrContent = mbr(), overrides: Json = {}): Run {
  const run = Run.issue(definition(m), overrides, T0);
  run.start('p', [], DISP1);
  return run;
}
const refusal = (run: Run, entry: Json & { kind: string }): string | undefined => {
  const r = run.exec({ type: 'RECORD_ENTRY', actor: DISP1, step: 'p', context: [], entry });
  return r.accepted ? undefined : r.refusal?.message;
};
const stored = (run: Run, kind: string): Json[] => Object.values(run.state.entries).filter((e) => e.kind === kind).map((e) => e.data as Json);

const D = (m: flow.MbrContent): string[] => problems(m).map((p) => `${p.code} [${p.controls.join(',')}] ${p.message.split(` (${p.code})`)[0] ?? ''}`);
const exc = baseConfig['compensation'] as Json;

describe('TB-01 definition checks, each with its message and controls', () => {
  it('[PR-19][DI-33] the active line: present, consumed by the step, an active, in a mass unit; a standard on the base declares its form', () => {
    expect(D(mbr({ ...baseConfig, active: { ...active, bomLine: 'BOM-X' } }))).toEqual(['TB01-ACTIVE-LINE [PR-19] BOM-X is not a BOM line step p consumes']);
    expect(D(mbr(baseConfig, { consumes: ['BOM-MCC'] }))).toEqual(['TB01-ACTIVE-LINE [PR-19] BOM-API is not a BOM line step p consumes']);
    expect(D(mbr({ ...baseConfig, active: { ...active, bomLine: 'BOM-MCC' }, compensation: { mode: 'NONE', registrationRef: 'R' } }))).toEqual(['TB01-ACTIVE-LINE [PR-19] BOM-MCC is not an active (its role is EXCIPIENT)']);
    expect(D(mbr(baseConfig, {}, { bom: [{ ...(BOM[0] as flow.BomLine), quantity: { value: '8.000', unit: 'L' } }, BOM[1] as flow.BomLine] }))).toEqual([
      "TB01-UNIT [PR-19,DI-33] the active's standard quantity is in L, not a mass",
      'TB01-UNIT [PR-19,DI-33] the active (L) and the compensating excipient (kg) are stated in one unit',
    ]);
    expect(D(mbr({ ...baseConfig, active: { bomLine: 'BOM-API', basis: 'ANHYDROUS_WATER', standardIs: 'BASE', standardBasis: 'x' } }))).toEqual(['TB01-FORM [PR-19] a standard stated on the base needs the declared form with its molar masses (C-02)']);
    expect(D(mbr({ ...baseConfig, active: { bomLine: 'BOM-API', basis: 'ANHYDROUS_WATER', standardIs: 'FORM', standardBasis: 'x' } }))).toEqual([]);
  });

  it('[PR-19][DI-33] the form: a hydrate needs the as-is basis, a hydrate label declares its waters, a hydrate molar mass holds them (the boundary is allowed)', () => {
    expect(D(mbr({ ...baseConfig, active: { ...active, form: { ...form, hydrateWaters: 2, molarMassForm: '2000' } } }))).toEqual([
      'TB01-BASIS-CONSISTENCY [PR-19,DI-33] the declared form is a hydrate, but the assay is on the anhydrous water basis: its molar mass would count the water twice; declare the anhydrous form',
    ]);
    expect(D(mbr({ ...baseConfig, active: { ...active, basis: 'DRIED_LOD', form: { ...form, hydrateWaters: 2, molarMassForm: '2000' } } }))[0]).toMatch(/on the dried lod basis/);
    expect(D(mbr({ ...baseConfig, active: { ...active, basis: 'AS_IS', form: { ...form, name: 'atorvastatin calcium sesquihydrate', hydrateWaters: 0 } } }))).toEqual([
      'TB01-HYDRATE-LABEL [PR-19,DI-33] the form is named "atorvastatin calcium sesquihydrate", a hydrate, but declares no waters of hydration; declare its waters and its hydrate molar mass, or name the anhydrous form',
    ]);
    expect(D(mbr({ ...baseConfig, active: { ...active, basis: 'AS_IS', form: { ...form, name: 'X hydrate', hydrateWaters: 0 } } })).map((x) => x.split(' ')[0])).toEqual(['TB01-HYDRATE-LABEL']);
    // A name with no hydrate in it, or an anhydrous one, declares nothing; an anhydrous form is not held to a hydrate's mass.
    expect(D(mbr({ ...baseConfig, active: { ...active, basis: 'AS_IS', form: { ...form, name: 'atorvastatin calcium', hydrateWaters: 0 } } }))).toEqual([]);
    expect(D(mbr({ ...baseConfig, active: { ...active, form: { ...form, molarMassForm: '1000' } } }))).toEqual([]);
    // 2 x 558.64 + 3 x 18.015 = 1171.325.
    expect(D(mbr({ ...baseConfig, active: { ...active, basis: 'AS_IS', form: { ...form, hydrateWaters: 3, molarMassForm: '1171.325' } } }))).toEqual([]);
    expect(D(mbr({ ...baseConfig, active: { ...active, basis: 'AS_IS', form: { ...form, hydrateWaters: 3, molarMassForm: '1171.324' } } }))).toEqual([
      "TB01-HYDRATE-MASS [PR-19,DI-33] the form declares 3 waters of hydration, but its molar mass 1171.324 is below the base's and the waters' 1171.325: an anhydrous molar mass under a hydrate label",
    ]);
  });

  it("[PR-04][PR-19] an overage above 0 % names its registration; the compensating excipient is another consumed line in the active's unit, with a range containing its standard and its tolerance; no compensation names its registration", () => {
    expect(D(mbr({ ...baseConfig, active: { ...active, overagePercent: '2' } }))).toEqual(['TB01-OVERAGE [PR-04] an overage above 0 % needs its registration reference']);
    expect(D(mbr({ ...baseConfig, active: { ...active, overagePercent: '2', registrationRef: 'REG-1' } }))).toEqual([]);
    expect(D(mbr({ ...baseConfig, active: { ...active, overagePercent: '0' } }))).toEqual([]);
    expect(D(mbr({ ...baseConfig, compensation: { mode: 'EXCIPIENT', min: '18', max: '22' } }))).toEqual(['TB01-EXCIPIENT-LINE [PR-19] the compensating excipient (none) is not a BOM line step p consumes']);
    expect(D(mbr({ ...baseConfig, compensation: { ...exc, bomLine: 'BOM-Y' } }))).toEqual(['TB01-EXCIPIENT-LINE [PR-19] the compensating excipient BOM-Y is not a BOM line step p consumes']);
    expect(D(mbr(baseConfig, { consumes: ['BOM-API'] }))).toEqual(['TB01-EXCIPIENT-LINE [PR-19] the compensating excipient BOM-MCC is not a BOM line step p consumes']);
    expect(D(mbr({ ...baseConfig, compensation: { ...exc, bomLine: 'BOM-API', min: '8', max: '8' } }))).toEqual(['TB01-EXCIPIENT-LINE [PR-19] the compensating excipient is another line than the active']);
    expect(D(mbr({ ...baseConfig, compensation: { ...exc, min: '20000', max: '20000' } }, {}, { bom: [BOM[0] as flow.BomLine, { ...(BOM[1] as flow.BomLine), quantity: { value: '20000', unit: 'g' } }] }))).toEqual([
      'TB01-UNIT [PR-19,DI-33] the active (kg) and the compensating excipient (g) are stated in one unit',
    ]);
    expect(D(mbr({ ...baseConfig, compensation: { mode: 'EXCIPIENT', bomLine: 'BOM-MCC', max: '22' } }))).toEqual(['TB01-EXCIPIENT-RANGE [PR-19,PR-04] the compensating excipient states its approved range (min and max)']);
    expect(D(mbr({ ...baseConfig, compensation: { mode: 'EXCIPIENT', bomLine: 'BOM-MCC', min: '18' } }))).toEqual(['TB01-EXCIPIENT-RANGE [PR-19,PR-04] the compensating excipient states its approved range (min and max)']);
    expect(D(mbr({ ...baseConfig, compensation: { ...exc, min: '20.001' } }))).toEqual(['TB01-EXCIPIENT-RANGE [PR-19,PR-04] the approved range 20.001 to 22.000 does not contain the standard 20.000']);
    expect(D(mbr({ ...baseConfig, compensation: { ...exc, max: '19.999' } }))).toEqual(['TB01-EXCIPIENT-RANGE [PR-19,PR-04] the approved range 18.000 to 19.999 does not contain the standard 20.000']);
    expect(D(mbr({ ...baseConfig, compensation: { ...exc, min: '20.000', max: '20.000' } }))).toEqual([]);
    expect(D(mbr({ ...baseConfig, tolerancePercent: { active: '0.5' } }))).toEqual(['TB01-TOLERANCE [PR-19] the compensating excipient has its tolerance']);
    expect(D(mbr({ ...baseConfig, compensation: { mode: 'NONE' }, tolerancePercent: { active: '0.5' } }))).toEqual([
      'TB01-NO-COMPENSATION [PR-04,PR-19] no compensation only where the registered formula lets the core weight vary: name its registration reference',
    ]);
    expect(D(mbr({ ...baseConfig, compensation: { mode: 'NONE', registrationRef: 'REG-2' }, tolerancePercent: { active: '0.5' } }))).toEqual([]);
  });

  it('[PR-19][PR-20] the step records a dispensed mass, is checked by a second person and performed by the designated dispenser', () => {
    expect(D(mbr(baseConfig, { records: [] }))).toEqual(['TB01-NO-ITEM [PR-19] step p records no dispensed mass quantity']);
    expect(D(mbr(baseConfig, { signatures: { perform: { role: 'DISPENSER' } } }))).toEqual([
      'TB01-NO-CHECK [PR-20] every dispensed material is checked by a second person (manual mode) or at least one verifier (scale-backed mode)',
    ]);
    expect(D(mbr(baseConfig, { signatures: { check: { meaning: 'VERIFIED', role: 'PRODUCTION_VERIFIER' } } }))).toEqual(['TB01-PERFORMER [PR-19] the step is performed by the designated dispenser (DISPENSER)']);
  });

  it('[PR-19][PR-04] the configuration as the block reads it: defaults (base standard, three lots, overage 0, tolerance 0), the excipient only in EXCIPIENT mode, the cap only when stated', () => {
    expect(tb01Config(baseConfig)).toStrictEqual({
      active: { bomLine: 'BOM-API', basis: 'ANHYDROUS_WATER', standardIs: 'BASE', form: { molarMassForm: '1155.36', molarMassBase: '558.64', baseMoieties: 2, hydrateWaters: 0 }, overagePercent: '0', maxLots: 3 },
      excipient: { bomLine: 'BOM-MCC', min: '18.000', max: '22.000' },
      readability: '0.001',
      tolerance: { active: '0.5', excipient: '1.0' },
    });
    expect(tb01Config({ active: { bomLine: 'A', basis: 'AS_IS', standardIs: 'FORM', maxLots: 2, overagePercent: '1' }, compensation: { mode: 'EXCIPIENT', bomLine: 'E' }, readability: '0.01', tolerancePercent: { active: '1', excipient: '2' }, adjustmentCapPercent: '5' })).toStrictEqual({
      active: { bomLine: 'A', basis: 'AS_IS', standardIs: 'FORM', overagePercent: '1', maxLots: 2 },
      excipient: { bomLine: 'E', min: '0', max: '0' },
      readability: '0.01',
      tolerance: { active: '1', excipient: '2' },
      capPercent: '5',
    });
    expect(tb01Config({ active: { maxLots: '2' }, compensation: { mode: 'NONE', bomLine: 'E' } })).toStrictEqual({
      active: { bomLine: 'undefined', basis: 'undefined', standardIs: 'BASE', overagePercent: '0', maxLots: 3 },
      readability: 'undefined',
      tolerance: { active: '0' },
    });
  });
});

describe('TB-01 lots at the moment of use', () => {
  it('[PR-18][IN-23] a lot expires, or falls due for retest, at its instant; one microsecond before it, it is usable', () => {
    const run = started();
    expect(refusal(run, calc([{ lot: lot('L-E', 'MAT-ATV', { expiresAtUs: T0.toString() }), assay: ASSAY }]))).toBe('Lot L-E is past its expiry date (TB01-LOT-EXPIRED; PR-18, IN-23) (TB01-LOT-EXPIRED; PR-18, IN-23)');
    expect(refusal(run, calc([{ lot: lot('L-R', 'MAT-ATV', { retestAtUs: T0.toString() }), assay: ASSAY }]))).toBe('Lot L-R is past its retest date (TB01-LOT-RETEST; PR-18, IN-23) (TB01-LOT-RETEST; PR-18, IN-23)');
    expect(refusal(run, calc([{ lot: lot('L-N', 'MAT-ATV', { expiresAtUs: (T0 + 1n).toString(), retestAtUs: (T0 + 1n).toString() }), assay: ASSAY }]))).toBeUndefined();
  });

  it("[PR-18][IN-23][IN-24] status and material refusals name the lot; the material may be the MBR reference's code; identity testing is needed for any market beyond India", () => {
    const run = started();
    expect(refusal(run, calc([{ lot: lot('L-R', 'MAT-ATV', { status: 'REJECTED' }), assay: ASSAY }]))).toBe('Lot L-R is rejected: only released lots may be used, with no operator override (TB01-LOT-STATUS; PR-18, IN-23) (TB01-LOT-STATUS; PR-18, IN-23)');
    expect(refusal(run, calc([{ lot: lot('L-W', 'MAT-MCC'), assay: ASSAY }]))).toBe('Lot L-W is MAT-MCC, not the item the MBR names (MAT-ATV) (TB01-WRONG-MATERIAL; PR-18, IN-23) (TB01-WRONG-MATERIAL; PR-18, IN-23)');
    // India only: no identity result needed.
    expect(refusal(run, calc([{ lot: lot('L-I', 'MAT-ATV', { identityTested: false }), assay: ASSAY }]))).toBeUndefined();
    const eu = started(mbr(baseConfig, {}, { marketSet: ['IN', 'EU'] }), { marketSet: ['IN', 'EU'] });
    expect(refusal(eu, calc([{ lot: { id: 'L-I', material: 'MAT-ATV', status: 'RELEASED' }, assay: ASSAY }]))).toBe('Lot L-I has no identity-test result; a batch for EU, IN needs one (TB01-LOT-IDENTITY; IN-24) (TB01-LOT-IDENTITY; IN-24)');
    expect(refusal(eu, calc([{ lot: lot('L-I2', 'MAT-ATV'), assay: ASSAY }]))).toBeUndefined();
    const refs = [{ id: 'RSK', kind: 'RISK_SCALE', code: 'RSK', version: '1', hash: 'a'.repeat(64) }, { id: 'MAT-ATV', kind: 'MATERIAL', code: 'ATV-CODE', version: '1', hash: 'b'.repeat(64) }] as flow.MbrContent['references'];
    const coded = started(mbr(baseConfig, {}, { references: refs }));
    expect(refusal(coded, calc([{ lot: lot('L-C2', 'OTHER'), assay: ASSAY }]))).toBe('Lot L-C2 is OTHER, not the item the MBR names (ATV-CODE) (TB01-WRONG-MATERIAL; PR-18, IN-23) (TB01-WRONG-MATERIAL; PR-18, IN-23)');
    expect(refusal(coded, calc([{ lot: lot('L-C', 'ATV-CODE'), assay: ASSAY }]))).toBeUndefined();
  });

  it("[PR-19][DI-33] a calculation names each lot once, within the MBR's lot count, on the MBR's basis; a calculation that cannot be made says why", () => {
    const run = started();
    expect(refusal(run, calc([{ lot: lot('L-1', 'MAT-ATV'), assay: ASSAY, baseEquivalent: '4' }, { lot: lot('L-1', 'MAT-ATV'), assay: ASSAY, baseEquivalent: '4' }]))).toBe('Lot L-1 is named twice (TB01-LOTS; PR-19) (TB01-LOTS; PR-19)');
    expect(refusal(run, calc([{ lot: lot('L-1', 'MAT-ATV'), assay: { ...ASSAY, basis: 'DRIED_LOD' } }]))).toBe('The result of lot L-1 is reported on the dried_lod basis, the MBR calculates on anhydrous_water (TB01-BASIS; PR-19, DI-33) (TB01-BASIS; PR-19, DI-33)');
    expect(refusal(run, calc([{ lot: lot('L-1', 'MAT-ATV'), assay: { resultId: ASSAY.resultId, basis: 'ANHYDROUS_WATER', assay: '99.2' } }]))).toBe('The calculation cannot be made: lot 1: the water result its basis needs is missing (TB01-ASSAY; PR-19, DI-33) (TB01-ASSAY; PR-19, DI-33)');
    const one = started(mbr({ ...baseConfig, active: { ...active, maxLots: 1 } }));
    expect(refusal(one, calc([{ lot: lot('L-1', 'MAT-ATV'), assay: ASSAY, baseEquivalent: '4' }, { lot: lot('L-2', 'MAT-ATV'), assay: ASSAY, baseEquivalent: '4' }]))).toBe('The MBR allows the active to be allocated across 1 lot(s), not 2 (TB01-LOTS; PR-19) (TB01-LOTS; PR-19)');
    const two = started(mbr({ ...baseConfig, active: { ...active, maxLots: 2 } }));
    expect(refusal(two, calc([{ lot: lot('L-1', 'MAT-ATV'), assay: ASSAY, baseEquivalent: '4' }, { lot: lot('L-2', 'MAT-ATV'), assay: ASSAY, baseEquivalent: '4' }]))).toBeUndefined();
  });
});

/** A FORM standard of 10.000 kg with 20.000 kg of excipient, on the as-is basis: a 100.0 % lot gives targets of 10.000 and 20.000. */
const round: Json = {
  active: { bomLine: 'BOM-API', basis: 'AS_IS', standardIs: 'FORM', standardBasis: 'form at 100 %' },
  compensation: { mode: 'EXCIPIENT', bomLine: 'BOM-MCC', min: '18.000', max: '22.000' },
  readability: '0.001',
  tolerancePercent: { active: '1', excipient: '0.5' },
};
const roundBom: flow.BomLine[] = [{ ...(BOM[0] as flow.BomLine), quantity: { value: '10.000', unit: 'kg' } }, BOM[1] as flow.BomLine];
const AS_IS = (assay: string) => ({ resultId: ASSAY.resultId, basis: 'AS_IS', assay });

describe('TB-01 calculations as stored', () => {
  it("[PR-19][DI-33] each basis's results are stored as the register holds them, with each lot's share and results by lot", () => {
    for (const [basis, extra] of [['DRIED_LOD', { lod: '0.5' }], ['ANHYDROUS_SOLVENT_FREE', { water: '3.0', solvents: '0.4' }]] as const) {
      const run = started(mbr({ ...round, active: { ...(round['active'] as Json), basis } }, {}, { bom: roundBom }));
      const assay = { resultId: ASSAY.resultId, basis, assay: '100.0', ...extra };
      run.entry('p', calc([{ lot: lot('L-1', 'MAT-ATV'), assay, baseEquivalent: '6' }, { lot: lot('L-2', 'MAT-ATV'), assay, baseEquivalent: '4' }]), [], DISP1);
      const data = stored(run, 'POTENCY_CALCULATION')[0] as Json;
      expect(data['lots']).toEqual([{ lot: lot('L-1', 'MAT-ATV'), assay, baseEquivalent: '6' }, { lot: lot('L-2', 'MAT-ATV'), assay, baseEquivalent: '4' }]);
      const results = data['results'] as Json[];
      expect(results.map((r) => [r['lot'], r['baseEquivalent']])).toEqual([['L-1', '6'], ['L-2', '4']]);
      expect(results.map((r) => r['asIsAssay'])).toEqual(basis === 'DRIED_LOD' ? ['99.5', '99.5'] : ['96.6', '96.6']);
    }
    const none = started(mbr({ ...round, compensation: { mode: 'NONE', registrationRef: 'REG-2' } }, {}, { bom: roundBom }));
    none.entry('p', calc([{ lot: lot('L-1', 'MAT-ATV'), assay: AS_IS('100.0') }]), [], DISP1);
    expect(stored(none, 'POTENCY_CALCULATION')[0]).toMatchObject({ excipient: null, total: { standard: '10.000000', target: '10.000' }, active: { standardIs: 'FORM', factor: '1.000000' } });
  });

  it('[PR-19][PR-04] the adjustment cap compares the adjustment shown: equal to the cap passes, above it raises POTENCY_ADJUSTMENT_CAP with its title', () => {
    // 10 / 0.98 = 10.204082 kg: an adjustment of 2.040816 %.
    const at = started(mbr({ ...round, adjustmentCapPercent: '2.040816' }, {}, { bom: roundBom }));
    at.entry('p', calc([{ lot: lot('L-1', 'MAT-ATV'), assay: AS_IS('98.0') }]), [], DISP1);
    expect(at.exceptions('POTENCY_ADJUSTMENT_CAP')).toEqual([]);
    const over = started(mbr({ ...round, adjustmentCapPercent: '2.040815' }, {}, { bom: roundBom }));
    over.entry('p', calc([{ lot: lot('L-1', 'MAT-ATV'), assay: AS_IS('98.0') }]), [], DISP1);
    expect(over.exceptions('POTENCY_ADJUSTMENT_CAP').map((e) => [e.title, e.severity])).toEqual([
      ["The adjusted quantity of BOM-API differs from its standard by 2.040816 %, beyond the MBR's cap of 2.040815 %; the steps after it wait for a deviation", 'ACTION'],
    ]);
  });
});

describe('TB-01 weighings', () => {
  it('[PR-19][DI-30] a weighing names a dispensed quantity of the step, the active or the excipient line, a mass unit, and a positive net', () => {
    const run = started();
    run.entry('p', calc(), [], DISP1);
    const l = lot('AR-ATV-1', 'MAT-ATV');
    expect(refusal(run, weigh('BOM-API', l, '8.742', { item: 'other' }))).toBe('other is not a dispensed quantity of p (TB01-ITEM; PR-19) (TB01-ITEM; PR-19)');
    expect(refusal(run, weigh('BOM-X', l, '8.742'))).toMatch(/^BOM-X is neither the active nor the compensating excipient of this step \(TB01-BOM-LINE; PR-19, PR-13\)/);
    expect(refusal(run, weigh('BOM-API', l, '8.742', { unit: 'L' }))).toBe('L is not a mass unit (TB01-UNIT; DI-30) (TB01-UNIT; DI-30)');
    expect(refusal(run, weigh('BOM-API', l, '1.000', { tare: '2.000' }))).toBe('the net weight (1.000 - 2.000) is not positive (TB01-NET; PR-19, INV-25) (TB01-NET; PR-19, INV-25)');
    expect(refusal(run, weigh('BOM-API', l, '8.742', { fefoReason: '  ' }))).toMatch(/^A reason is words, not blanks \(TB01-FEFO-REASON; PR-18\)/);
  });

  it('[PR-19][PR-13][DI-30] a BOM line the step does not consume, or consumes as neither the active nor the excipient, is refused; only metric masses are mass units here (mutation follow-up)', () => {
    const lac: flow.BomLine = { id: 'BOM-LAC', material: 'MAT-LAC', role: 'EXCIPIENT', quantity: { value: '1.000', unit: 'kg' } } as flow.BomLine;
    const l = lot('AR-LAC-1', 'MAT-LAC');
    const notConsumed = started(mbr(baseConfig, {}, { bom: [...BOM, lac] }));
    notConsumed.entry('p', calc(), [], DISP1);
    expect(refusal(notConsumed, weigh('BOM-LAC', l, '1.000'))).toMatch(/^BOM-LAC is neither the active nor the compensating excipient of this step \(TB01-BOM-LINE; PR-19, PR-13\)/);
    const consumed = started(mbr(baseConfig, { consumes: ['BOM-API', 'BOM-MCC', 'BOM-LAC'] }, { bom: [...BOM, lac] }));
    consumed.entry('p', calc(), [], DISP1);
    expect(refusal(consumed, weigh('BOM-LAC', l, '1.000'))).toMatch(/TB01-BOM-LINE/);
    const run = started();
    run.entry('p', calc(), [], DISP1);
    expect(refusal(run, weigh('BOM-API', lot('AR-ATV-1', 'MAT-ATV'), '8.742', { unit: '[lb_av]' }))).toBe('[lb_av] is not a mass unit (TB01-UNIT; DI-30) (TB01-UNIT; DI-30)');
  });

  it("[INV-25][DI-30] a weighing in g counts into a quantity in kg at the resolution it was weighed at, and into the line's total at PERFORMED", () => {
    const run = started();
    run.entry('p', calc(), [], DISP1);
    run.entry('p', weigh('BOM-API', lot('AR-ATV-1', 'MAT-ATV'), '4742', { unit: 'g', tare: '0' }), [], DISP1);
    run.entry('p', weigh('BOM-API', lot('AR-ATV-1', 'MAT-ATV'), '4000.0', { unit: 'g', tare: '0.0', container: 'C-2' }), [], DISP1);
    run.entry('p', weigh('BOM-MCC', lot('AR-MCC-1', 'MAT-MCC'), '19.531'), [], DISP1);
    run.perform('p', [], DISP1);
    expect(run.value('dispApi', 'p')).toBe('8.7420');
    expect(run.exceptions('DISPENSE_OUT_OF_TOLERANCE')).toEqual([]);
  });

  it('[PR-19][PR-18] an accepted weighing stores its net and label and registers its container; a FEFO reason raises FEFO_OVERRIDE with its title; a keyed weight MANUAL_ENTRY_FALLBACK', () => {
    const run = started();
    run.entry('p', calc(), [], DISP1);
    run.entry('p', weigh('BOM-MCC', lot('AR-MCC-2', 'MAT-MCC'), '20.531', { tare: '1.000', container: 'C-9', fefoReason: 'older lot held', source: 'MANUAL' }), [], DISP1);
    const data = stored(run, 'CONTAINER_WEIGHING')[0] as Json;
    expect(data).toMatchObject({ net: '19.531', lot: lot('AR-MCC-2', 'MAT-MCC'), label: { component: 'MAT-MCC', lot: 'AR-MCC-2', quantity: '19.531 kg', container: 'C-9' } });
    expect(data).not.toHaveProperty('kind');
    expect(Object.values(run.state.containers).map((c) => [c.id, c.holds])).toEqual([['C-9', 'BOM-MCC']]);
    expect(run.exceptions('FEFO_OVERRIDE').map((e) => [e.title, e.severity])).toEqual([['Lot AR-MCC-2 was dispensed for BOM-MCC instead of the first-expiring usable lot, for the reason the dispenser gave', 'ALERT']]);
    expect(run.exceptions('MANUAL_ENTRY_FALLBACK').map((e) => e.title)).toEqual(['A weight for dispMcc at p@ was keyed by hand instead of taken from the balance interface; the step now needs a second person']);
  });
});

describe('TB-01 at PERFORMED', () => {
  it('[PR-19] PERFORMED names each line and each lot of the calculation with nothing dispensed', () => {
    const run = started(mbr({ ...round, active: { ...(round['active'] as Json), maxLots: 2 } }, {}, { bom: roundBom }));
    run.entry('p', calc([{ lot: lot('L-1', 'MAT-ATV'), assay: AS_IS('100.0'), baseEquivalent: '6' }, { lot: lot('L-2', 'MAT-ATV'), assay: AS_IS('100.0'), baseEquivalent: '4' }]), [], DISP1);
    const perform = () => run.exec({ type: 'SIGN_PERFORMED', actor: DISP1, step: 'p', context: [], signature: sig('PERFORMED', DISP1) }).refusal?.message ?? '';
    expect(perform()).toContain('Nothing has been dispensed yet for BOM-API (TB01-INCOMPLETE; PR-19, PR-21)');
    expect(perform()).toContain('Nothing has been dispensed yet for BOM-MCC (TB01-INCOMPLETE; PR-19, PR-21)');
    expect(perform()).toContain('Nothing has been dispensed yet from lot L-1, a lot of the calculation (TB01-INCOMPLETE; PR-19)');
    run.entry('p', weigh('BOM-API', lot('L-1', 'MAT-ATV'), '6.000'), [], DISP1);
    run.entry('p', weigh('BOM-MCC', lot('AR-MCC-1', 'MAT-MCC'), '20.000'), [], DISP1);
    expect(perform()).toContain('Nothing has been dispensed yet from lot L-2, a lot of the calculation (TB01-INCOMPLETE; PR-19)');
    expect(perform()).not.toContain('L-1');
  });

  it('[PR-19][PR-08] the tolerance is inclusive: a total exactly at target +/- tolerance passes, one step beyond raises DISPENSE_OUT_OF_TOLERANCE for that line only', () => {
    const go = (api: string, mcc: string) => {
      const run = started(mbr(round, {}, { bom: roundBom }));
      run.entry('p', calc([{ lot: lot('L-1', 'MAT-ATV'), assay: AS_IS('100.0') }]), [], DISP1);
      run.entry('p', weigh('BOM-API', lot('L-1', 'MAT-ATV'), api), [], DISP1);
      run.entry('p', weigh('BOM-MCC', lot('AR-MCC-1', 'MAT-MCC'), mcc), [], DISP1);
      run.perform('p', [], DISP1);
      return run.exceptions('DISPENSE_OUT_OF_TOLERANCE').map((e) => [e.title, e.severity, e.controls]);
    };
    // Active 10.000 +/- 1 %, excipient 20.000 +/- 0.5 %.
    expect(go('10.100', '20.100')).toEqual([]);
    expect(go('9.900', '19.900')).toEqual([]);
    expect(go('10.101', '20.000')).toEqual([
      ['BOM-API: 10.101 kg dispensed is outside 1 % of its target 10 kg; it cannot be confirmed without this exception and a deviation', 'ACTION', ['PR-19', 'PR-08']],
    ]);
    expect(go('10.000', '19.899').map((x) => x[0])).toEqual(['BOM-MCC: 19.899 kg dispensed is outside 0.5 % of its target 20 kg; it cannot be confirmed without this exception and a deviation']);
  });
});
