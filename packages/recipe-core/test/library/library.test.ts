/**
 * Library block definitions, slice S1 (decision 0026): the sanity checks of a definition and of a product's values.
 * The software checks the form and the limits; it does not judge the process (the author and QA own that).
 */
import { describe, expect, it } from 'vitest';
import { checkBlockDefinition, checkBlockUse, slotsOf, type BlockDefinition, type FieldDef, type LibraryProblem } from '../../src/library/index.ts';
import { expr } from '../flow/support.ts';
import { dissolutionProfile, dissolutionUse, fluidBedDrying, fluidBedDryingUse, friability, friabilityUse, range } from './examples.ts';

const codes = (ps: LibraryProblem[]): string[] => ps.map((p) => p.code);
const errors = (ps: LibraryProblem[]): LibraryProblem[] => ps.filter((p) => p.severity === 'ERROR');

function withField(def: BlockDefinition, field: FieldDef): BlockDefinition {
  const first = def.sections[0];
  if (!first) throw new Error('example has a section');
  return { ...def, sections: [{ ...first, fields: [...first.fields, field] }, ...def.sections.slice(1)] };
}

describe('library block definitions', () => {
  it('the example friability, drying and dissolution definitions are well made', () => {
    for (const def of [friability(), fluidBedDrying(), dissolutionProfile()]) expect(checkBlockDefinition(def, expr)).toEqual([]);
  });

  it('a definition exposes its slots to the formulation', () => {
    expect(slotsOf(fluidBedDrying()).map((s) => `${s.kind}:${s.name}`)).toEqual([
      'EQUIPMENT_CLASS:dryerClass',
      'LIMIT:inletTemp',
      'LIMIT:dryingTime',
      'COUNT:maxLodChecks',
      'COUNT:lodSampleUnits',
      'LIMIT:lod',
    ]);
  });

  it('[PR-03] a critical number without a limit slot is refused: every CPP and IPC has limits', () => {
    const def = withField(friability(), { id: 'hardness', label: 'Hardness', type: 'NUMBER', unit: 'N', critical: true });
    expect(codes(checkBlockDefinition(def, expr))).toEqual(['LIB-CRITICAL-NO-LIMIT']);
  });

  it('[PR-03] every field is typed: an unknown field type, a bad unit or a missing label is refused', () => {
    const bad = withField(friability(), { id: 'x', label: '', type: 'NUMBER', unit: 'furlongs' });
    expect(codes(checkBlockDefinition(bad, expr)).sort()).toEqual(['LIB-FIELD-LABEL', 'LIB-FIELD-UNIT']);
    const unknown = withField(friability(), { id: 'y', label: 'Y', type: 'SLIDER' } as unknown as FieldDef);
    expect(codes(checkBlockDefinition(unknown, expr))).toEqual(['LIB-FIELD-TYPE']);
  });

  it('[PR-03] a weighing in a non-mass unit and a timer in a non-time unit are refused', () => {
    const w = withField(friability(), { id: 'net', label: 'Net', type: 'WEIGHING', unit: 'mL' });
    const t = withField(friability(), { id: 'mix', label: 'Mixing', type: 'TIMER', durationUnit: 'kg' });
    expect(codes(checkBlockDefinition(w, expr))).toEqual(['LIB-FIELD-UNIT']);
    expect(codes(checkBlockDefinition(t, expr))).toEqual(['LIB-FIELD-UNIT']);
  });

  it('field ids and slot names are unique', () => {
    const dupField = withField(friability(), { id: 'w0', label: 'Again', type: 'NUMBER', unit: 'g' });
    const dupSlot = withField(friability(), { id: 'w2', label: 'Other', type: 'NUMBER', unit: '%', limitSlot: 'loss' });
    expect(codes(checkBlockDefinition(dupField, expr))).toEqual(['LIB-FIELD-ID']);
    expect(codes(checkBlockDefinition(dupSlot, expr))).toEqual(['LIB-SLOT-DUPLICATE']);
  });

  it('a choice needs two distinct options and at least one allowed answer', () => {
    const one = withField(friability(), { id: 'c', label: 'C', type: 'CHOICE', options: ['OK'] });
    const none = withField(friability(), { id: 'c', label: 'C', type: 'CHOICE', options: ['A', 'B'], notAllowed: ['A', 'B'] });
    const stray = withField(friability(), { id: 'c', label: 'C', type: 'CHOICE', options: ['A', 'B'], notAllowed: ['Z'] });
    expect(codes(checkBlockDefinition(one, expr))).toEqual(['LIB-CHOICE-OPTIONS']);
    expect(codes(checkBlockDefinition(none, expr))).toEqual(['LIB-CHOICE-NOT-ALLOWED']);
    expect(codes(checkBlockDefinition(stray, expr))).toEqual(['LIB-CHOICE-NOT-ALLOWED']);
  });

  it('[DI-33] a calculation must check against the fields declared before it, in its declared unit', () => {
    const later = friability();
    const run = later.sections[0];
    if (!run) throw new Error('section');
    // Move the calculation before w1: it now reads a field that is not declared yet.
    run.fields = [run.fields[0]!, run.fields[1]!, run.fields[3]!, run.fields[2]!, run.fields[4]!];
    expect(codes(checkBlockDefinition(later, expr))).toContain('LIB-CALC-EXPRESSION');
    const wrongUnit = withField(friability(), { id: 'gain', label: 'Gain', type: 'CALC', expression: 'w0 - w1', unit: 's' });
    expect(codes(checkBlockDefinition(wrongUnit, expr))).toEqual(['LIB-CALC-EXPRESSION']);
  });

  it('[DI-33] a calculation outside a repeating section reads its fields as a series', () => {
    // fluidBedDrying's lastLod = max(lod) reads the LOD loop's values; the example checks clean (first test).
    const scalar = fluidBedDrying();
    const out = scalar.sections[2];
    if (!out) throw new Error('section');
    out.fields = out.fields.map((f) => (f.id === 'lastLod' ? { ...f, expression: 'lod + 1 [%]' } : f));
    expect(codes(checkBlockDefinition(scalar, expr))).toContain('LIB-CALC-EXPRESSION');
  });

  it('[INV-25] a calculated field cannot be marked optional: it is never typed', () => {
    const def = withField(friability(), { id: 'c2', label: 'C2', type: 'CALC', expression: 'w0', unit: 'g', required: false });
    expect(codes(checkBlockDefinition(def, expr))).toEqual(['LIB-CALC-REQUIRED']);
  });

  it('[INV-20] a repeat until a value passes must wait on a field with limits or an expected answer', () => {
    const def = fluidBedDrying();
    const loop = def.sections[1];
    if (!loop) throw new Error('section');
    loop.fields = loop.fields.map((f) => (f.id === 'lod' ? { id: 'lod', label: 'LOD', type: 'NUMBER', unit: '%' } : f));
    expect(codes(checkBlockDefinition(def, expr))).toEqual(['LIB-REPEAT-UNTIL']);
    loop.repeat = { kind: 'UNTIL_PASS', untilField: 'nothing' };
    expect(codes(checkBlockDefinition(def, expr))).toContain('LIB-REPEAT-UNTIL');
  });

  it('[INV-20] a repeat until a value passes with no maximum is a warning that needs a reason', () => {
    const def = fluidBedDrying();
    def.sections[1]!.repeat = { kind: 'UNTIL_PASS', untilField: 'lod' };
    const ps = checkBlockDefinition(def, expr);
    expect(errors(ps)).toEqual([]);
    expect(codes(ps)).toEqual(['LIB-REPEAT-NO-MAX']);
  });

  it('[DI-35] every block needs a PERFORMED signature with a role, each meaning once', () => {
    const none = { ...friability(), signatures: [{ meaning: 'CHECKED' as const, role: 'SUPERVISOR' }] };
    const twice = { ...friability(), signatures: [{ meaning: 'PERFORMED' as const, role: 'A' }, { meaning: 'PERFORMED' as const, role: '' }] };
    expect(codes(checkBlockDefinition(none, expr))).toEqual(['LIB-SIGNATURE-PERFORMED']);
    expect(codes(checkBlockDefinition(twice, expr)).sort()).toEqual(['LIB-SIGNATURE-MEANING', 'LIB-SIGNATURE-ROLE']);
  });

  it('[PR-03] a test result judges at least one statistic', () => {
    const def = withField(friability(), { id: 'wt', label: 'Weights', type: 'TEST_RESULT', unit: 'mg', replicatesSlot: 'n', statistics: [] });
    expect(codes(checkBlockDefinition(def, expr))).toEqual(['LIB-TEST-NO-LIMIT']);
  });

  it('[PR-08] a reference limit names a limit slot, has a note, and its bounds are in order and in a compatible unit', () => {
    const def = { ...friability(), referenceLimits: { loss: { unit: 'g', low: '2', high: '1', note: '' }, ghost: { unit: '%', high: '1', note: 'x' } } };
    expect(codes(checkBlockDefinition(def, expr)).sort()).toEqual(['LIB-REFERENCE-BOUND', 'LIB-REFERENCE-NOTE', 'LIB-REFERENCE-SLOT', 'LIB-REFERENCE-UNIT']);
  });

  it('[PR-05] a version is a whole number of 1 or more', () => {
    expect(codes(checkBlockDefinition({ ...friability(), version: 0 }, expr))).toEqual(['LIB-VERSION']);
    expect(codes(checkBlockDefinition({ ...friability(), version: 1.5 }, expr))).toEqual(['LIB-VERSION']);
  });
});

describe("a product's values for a library block", () => {
  it('the example uses are accepted', () => {
    expect(checkBlockUse(friability(), friabilityUse(), expr)).toEqual([]);
    expect(checkBlockUse(fluidBedDrying(), fluidBedDryingUse(), expr)).toEqual([]);
    expect(checkBlockUse(dissolutionProfile(), dissolutionUse(), expr)).toEqual([]);
  });

  it('[PR-03] a required slot left empty is refused: limits of a CPP, the equipment class, counts', () => {
    const use = fluidBedDryingUse();
    delete use.limits!['lod'];
    delete use.equipmentClasses!['dryerClass'];
    delete use.counts!['maxLodChecks'];
    expect(codes(checkBlockUse(fluidBedDrying(), use, expr)).sort()).toEqual(['LIB-USE-COUNT', 'LIB-USE-EQUIPMENT-CLASS', 'LIB-USE-LIMIT-MISSING']);
  });

  it('a value for a slot the block does not have is refused', () => {
    const use = { ...friabilityUse(), counts: { tablets: '20' } };
    expect(codes(checkBlockUse(friability(), use, expr))).toEqual(['LIB-USE-UNKNOWN-SLOT']);
  });

  it('[PR-08] a limit whose lower bound is above its upper bound is refused', () => {
    const use = fluidBedDryingUse();
    use.limits!['inletTemp'] = range('Cel', '70', '60');
    expect(codes(checkBlockUse(fluidBedDrying(), use, expr))).toContain('LIB-USE-LIMIT-EMPTY_RANGE');
  });

  it('[PR-08] tiers must nest: an internal action limit outside the registered limit is refused', () => {
    const use = fluidBedDryingUse();
    const reg = range('Cel', '55', '65');
    const action = range('Cel', '50', '62', 'INTERNAL_ACTION');
    use.limits!['inletTemp'] = { unit: 'Cel', ranges: [...reg.ranges, ...action.ranges] };
    expect(codes(checkBlockUse(fluidBedDrying(), use, expr))).toEqual(['LIB-USE-LIMIT-NOT_NESTED']);
  });

  it('[PR-08] a limit in a unit that does not convert to the field unit is refused', () => {
    const use = fluidBedDryingUse();
    use.limits!['lod'] = range('mg', '1.5', '2.5');
    expect(codes(checkBlockUse(fluidBedDrying(), use, expr))).toEqual(['LIB-USE-LIMIT-UNIT']);
  });

  it('[PR-08] a target outside its own limits is refused', () => {
    const use = { ...fluidBedDryingUse(), targets: { inletTemp: '70' } };
    expect(codes(checkBlockUse(fluidBedDrying(), use, expr))).toEqual(['LIB-USE-TARGET']);
  });

  it('[PR-29] an IPC interval is a positive time', () => {
    const def: BlockDefinition = {
      code: 'IPC-WEIGHT',
      version: 1,
      title: 'Average weight',
      category: 'TEST_IPC',
      sections: [{ id: 'round', title: 'Round', repeat: { kind: 'PER_INTERVAL', intervalSlot: 'every' }, fields: [{ id: 'wt', label: 'Weights', type: 'TEST_RESULT', unit: 'mg', replicatesSlot: 'n', statistics: [{ statistic: 'MEAN', limitSlot: 'mean' }] }] }],
      signatures: [{ meaning: 'PERFORMED', role: 'IPC_OPERATOR' }],
    };
    expect(checkBlockDefinition(def, expr)).toEqual([]);
    const base = { block: { code: 'IPC-WEIGHT', version: 1 }, limits: { mean: range('mg', '237.5', '262.5') }, counts: { n: '20' } };
    expect(checkBlockUse(def, { ...base, intervals: { every: { value: '30', unit: 'min' } } }, expr)).toEqual([]);
    expect(codes(checkBlockUse(def, { ...base, intervals: { every: { value: '0', unit: 'min' } } }, expr))).toEqual(['LIB-USE-INTERVAL']);
    expect(codes(checkBlockUse(def, { ...base, intervals: { every: { value: '30', unit: 'kg' } } }, expr))).toEqual(['LIB-USE-INTERVAL']);
    expect(codes(checkBlockUse(def, { ...base, counts: { n: '20.5' }, intervals: { every: { value: '30', unit: 'min' } } }, expr))).toEqual(['LIB-USE-COUNT']);
  });

  it('[PR-08] a limit looser than the reference limit is a warning, cleared by a written reason (O-5)', () => {
    const loose = { ...friabilityUse(), limits: { loss: range('%', undefined, '1.5') } };
    const ps = checkBlockUse(friability(), loose, expr);
    expect(ps.map((p) => `${p.severity}:${p.code}`)).toEqual(['WARNING:LIB-USE-LOOSER-THAN-REFERENCE']);
    expect(checkBlockUse(friability(), { ...loose, justifications: { loss: 'Coated core, validated in the product development report' } }, expr)).toEqual([]);
  });

  it('[PR-03] a profile test needs its time points, each with its own well-formed limits', () => {
    const none = { ...dissolutionUse(), points: {} };
    expect(codes(checkBlockUse(dissolutionProfile(), none, expr))).toEqual(['LIB-USE-POINTS']);
    const bad = dissolutionUse();
    bad.points!['released']![1] = { id: 'h1', label: '4 h', limits: range('%', '65', '45') };
    expect(codes(checkBlockUse(dissolutionProfile(), bad, expr)).sort()).toEqual(['LIB-USE-LIMIT-EMPTY_RANGE', 'LIB-USE-POINTS']);
  });

  it('a use checked against another block or version is refused', () => {
    expect(codes(checkBlockUse(friability(), { ...friabilityUse(), block: { code: 'IPC-FRIAB', version: 2 } }, expr))).toEqual(['LIB-USE-BLOCK']);
  });
});
