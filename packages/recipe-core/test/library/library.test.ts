/**
 * Library block definitions, slice S1 (decision 0026): the sanity checks of a definition and of a product's values.
 * The software checks the form and the limits; it does not judge the process (the author and QA own that).
 */
import { describe, expect, it } from 'vitest';
import { checkBlockDefinition, checkBlockUse, definitionHash, slotsOf, type BlockDefinition, type FieldDef, type LibraryProblem } from '../../src/library/index.ts';
import { expr } from '../flow/support.ts';
import { dissolutionProfile, dissolutionUse, fluidBedDrying, fluidBedDryingUse, friability, friabilityUse, potencyDispensing, range } from './examples.ts';

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

  it('[INV-20][PR-08] R3-ENG-5: the limit of a loop\'s endpoint is a required slot even when the field is not critical, so a formulation cannot leave it empty and let any value pass', () => {
    const def: BlockDefinition = {
      code: 'LOOP-K',
      version: 1,
      title: 'Loop',
      category: 'PROCESS',
      sections: [{ id: 'chk', title: 'Check', repeat: { kind: 'UNTIL_PASS', untilField: 'w' }, fields: [
        { id: 'w', label: 'W', type: 'WEIGHING', unit: 'kg', limitSlot: 'w' },
        { id: 'n', label: 'N', type: 'NUMBER', unit: 'g', limitSlot: 'n' },
        // Not the endpoint: a weighing's limit stays optional even when stored definition JSON marks it critical (the type has
        // no such flag; a weighing's target comes from the formula); a critical number's is required.
        { id: 'h', label: 'H', type: 'WEIGHING', unit: 'kg', limitSlot: 'h', critical: true } as unknown as FieldDef,
        { id: 'c', label: 'C', type: 'NUMBER', unit: 'g', limitSlot: 'c', critical: true },
      ] }],
      signatures: [{ meaning: 'PERFORMED', role: 'OPERATOR' }],
    };
    expect(errors(checkBlockDefinition(def, expr))).toEqual([]);
    expect(slotsOf(def).map((s) => `${s.name}:${String(s.required)}`)).toEqual(['w:true', 'n:false', 'h:false', 'c:true']);
    expect(errors(checkBlockUse(def, { block: { code: 'LOOP-K', version: 1 }, limits: { c: range('g', '1', '2') } }, expr)).map((p) => [p.code, p.path])).toEqual([['LIB-USE-LIMIT-MISSING', 'limits.w']]);
    expect(errors(checkBlockUse(def, { block: { code: 'LOOP-K', version: 1 }, limits: { w: range('kg', '9', '11'), c: range('g', '1', '2') } }, expr))).toEqual([]);
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

  it('[PR-30] a timer runs once per step, so it cannot sit in a repeating section', () => {
    const def = fluidBedDrying();
    def.sections[1]!.fields.push({ id: 'spin', label: 'Spin', type: 'TIMER' });
    expect(codes(checkBlockDefinition(def, expr))).toEqual(['LIB-TIMER-REPEAT']);
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

  it('[DI-33][PR-03] a calculation cannot read a typed date and time or a timer: the definition is refused, so QA never approves a block whose calculation the runtime cannot evaluate (I-1 finding)', () => {
    const def = withField(withField(friability(), { id: 'started', label: 'Started at', type: 'DATE_TIME' }), { id: 'ended', label: 'Ended at', type: 'DATE_TIME' });
    const timed = withField(def, { id: 'held', label: 'Held for', type: 'CALC', expression: 'convert(duration(started, ended), [h])', unit: 'h' });
    expect(codes(checkBlockDefinition(timed, expr))).toEqual(['LIB-CALC-DATE-TIME', 'LIB-CALC-DATE-TIME']);
    expect(checkBlockDefinition(def, expr)).toEqual([]);
    // A timer is judged by its own limit; a calculation over it cannot run either.
    const timer = withField(friability(), { id: 'spin', label: 'Spin time', type: 'TIMER', durationUnit: 'min' });
    expect(codes(checkBlockDefinition(withField(timer, { id: 'perMinute', label: 'Per minute', type: 'CALC', expression: 'w0 / spin', unit: 'g/min' }), expr))).toEqual(['LIB-CALC-TIMER']);
  });

  it('[DI-33] a calculation outside a repeating section reads its fields as a series', () => {
    // fluidBedDrying's lastLod = max(lod) reads the LOD loop's values; the example checks clean (first test).
    const scalar = fluidBedDrying();
    const out = scalar.sections[2];
    if (!out) throw new Error('section');
    out.fields = out.fields.map((f) => (f.id === 'lastLod' ? { ...f, expression: 'lod + 1 [%]' } : f));
    expect(codes(checkBlockDefinition(scalar, expr))).toContain('LIB-CALC-EXPRESSION');
  });

  it('[INV-25] "required: false" on a calculated field is ignored with a warning (R-flow item 7): it is never typed and always computed', () => {
    const def = withField(friability(), { id: 'c2', label: 'C2', type: 'CALC', expression: 'w0', unit: 'g', required: false });
    expect(checkBlockDefinition(def, expr).map((p) => [p.code, p.severity])).toEqual([['LIB-CALC-REQUIRED', 'WARNING']]);
  });

  it('[PR-03][DI-35] R-flow item 5: an instruction or sign-off block may hold no field (its PERFORMED signature is the record); any other block needs one', () => {
    const fieldless = (roles: BlockDefinition['roles']): BlockDefinition => ({
      code: 'SOP-READ', version: 1, title: 'Read the cleaning SOP', category: 'CONTROL', ...(roles ? { roles } : {}),
      sections: [{ id: 'text', title: 'Read SOP-PR-012 before the start', fields: [] }],
      signatures: [{ meaning: 'PERFORMED', role: 'PRODUCTION_OPERATOR' }],
    });
    expect(errors(checkBlockDefinition(fieldless(['INSTRUCTION']), expr))).toEqual([]);
    expect(errors(checkBlockDefinition(fieldless(['SIGN_OFF']), expr))).toEqual([]);
    expect(errors(checkBlockDefinition(fieldless(['INSTRUCTION', 'SIGN_OFF']), expr))).toEqual([]);
    expect(codes(errors(checkBlockDefinition(fieldless(['INSTRUCTION', 'IPC']), expr)))).toEqual(['LIB-NO-FIELDS']);
    expect(codes(errors(checkBlockDefinition(fieldless(undefined), expr)))).toEqual(['LIB-NO-FIELDS']);
    // The database keeps its shape rule (EBMR-LIB-001: at least one section), so a fieldless block has a text section.
    expect(codes(errors(checkBlockDefinition({ ...fieldless(['INSTRUCTION']), sections: [] }, expr)))).toEqual(['LIB-NO-FIELDS']);
  });

  it('[PR-03] R-flow item 3: a section may be optional only as a named event; a planned count, interval or loop and the step\'s own record stay required', () => {
    const event = { id: 'binder', title: 'Extra binder addition', required: false, when: 'Only if the granules need more binder', fields: [{ id: 'extra', label: 'Binder added', type: 'NUMBER' as const, unit: 'g' }] };
    const base = friability();
    expect(errors(checkBlockDefinition({ ...base, sections: [...base.sections, event] }, expr))).toEqual([]);
    const { when: _w, ...unnamed } = event;
    expect(codes(checkBlockDefinition({ ...base, sections: [...base.sections, unnamed] }, expr))).toEqual(['LIB-SECTION-OPTIONAL']);
    for (const repeat of [{ kind: 'COUNT' as const, countSlot: 'n' }, { kind: 'PER_INTERVAL' as const, intervalSlot: 'every' }]) {
      expect(codes(errors(checkBlockDefinition({ ...base, sections: [...base.sections, { ...event, repeat }] }, expr)))).toEqual(['LIB-SECTION-OPTIONAL']);
    }
    expect(errors(checkBlockDefinition({ ...base, sections: [...base.sections, { ...event, repeat: { kind: 'PER_CONTAINER' } }] }, expr))).toEqual([]);
    const allOptional = { ...base, sections: base.sections.map((x) => ({ ...x, required: false, when: 'Sometimes' })) };
    expect(codes(checkBlockDefinition(allOptional, expr))).toEqual(['LIB-SECTION-OPTIONAL']);
  });

  it('[DI-33] R-flow item 3: a calculation cannot read a field of an optional section, which may never be recorded', () => {
    const base = friability();
    const event = { id: 'binder', title: 'Extra binder addition', required: false, when: 'Only if the granules need more binder', fields: [{ id: 'extra', label: 'Binder added', type: 'NUMBER' as const, unit: 'g' }] };
    const reader = { id: 'sum', title: 'Sum', fields: [{ id: 'total', label: 'Total', type: 'CALC' as const, expression: 'w0 + extra', unit: 'g' }] };
    const ps = errors(checkBlockDefinition({ ...base, sections: [...base.sections, event, reader] }, expr));
    expect(ps.map((p) => [p.code, p.message])).toEqual([['LIB-CALC-CONDITIONAL', expect.stringMatching(/reads extra of the optional section binder/)]]);
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
    const ref = (r: Record<string, unknown>): string[] => codes(checkBlockDefinition({ ...friability(), referenceLimits: r as NonNullable<BlockDefinition['referenceLimits']> }, expr));
    // A slot of another kind (the equipment class) is no limit slot.
    expect(ref({ friabilatorClass: { unit: '%', high: '1', note: 'x' } })).toEqual(['LIB-REFERENCE-SLOT']);
    expect(ref({ loss: { unit: '%', high: '1' } })).toEqual(['LIB-REFERENCE-NOTE']);
    expect(ref({ loss: { unit: '%', high: '1', note: '  ' } })).toEqual(['LIB-REFERENCE-NOTE']);
    expect(ref({ loss: { unit: '%', note: 'x' } })).toEqual(['LIB-REFERENCE-BOUND']);
    expect(ref({ loss: { unit: '%', low: 'abc', high: '1', note: 'x' } })).toEqual(['LIB-REFERENCE-BOUND']);
    expect(ref({ loss: { unit: '%', high: 'x', note: 'x' } })).toEqual(['LIB-REFERENCE-BOUND']);
    // One bound is enough, and equal bounds are in order.
    expect(ref({ loss: { unit: '%', low: '0.1', note: 'x' } })).toEqual([]);
    expect(ref({ loss: { unit: '%', low: '1', high: '1', note: 'x' } })).toEqual([]);
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
    // A blank class, no classes or counts at all, and a count that is a number instead of text are refused too.
    expect(codes(checkBlockUse(fluidBedDrying(), { ...fluidBedDryingUse(), equipmentClasses: { dryerClass: '  ' } }, expr))).toEqual(['LIB-USE-EQUIPMENT-CLASS']);
    const bare = fluidBedDryingUse();
    delete bare.equipmentClasses;
    delete bare.counts;
    expect(codes(checkBlockUse(fluidBedDrying(), bare, expr))).toEqual(['LIB-USE-EQUIPMENT-CLASS', 'LIB-USE-COUNT', 'LIB-USE-COUNT']);
    expect(codes(checkBlockUse(fluidBedDrying(), { ...fluidBedDryingUse(), counts: { maxLodChecks: 6 as unknown as string, lodSampleUnits: '1' } }, expr))).toEqual(['LIB-USE-COUNT']);
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
    use.limits!['lod'] = range('parsec', '1.5', '2.5');
    const notUnit = checkBlockUse(fluidBedDrying(), use, expr);
    expect(codes(notUnit)).toEqual(['LIB-USE-LIMIT-UNIT']);
    expect(notUnit[0]?.message).toMatch(/is not a unit/);
  });

  it('[PR-08] a target outside its own limits is refused', () => {
    const use = { ...fluidBedDryingUse(), targets: { inletTemp: '70' } };
    expect(codes(checkBlockUse(fluidBedDrying(), use, expr))).toEqual(['LIB-USE-TARGET']);
    const target = (t: string, limits = range('Cel', '55', '65')): string[] => codes(checkBlockUse(fluidBedDrying(), { ...fluidBedDryingUse(), limits: { ...fluidBedDryingUse().limits, inletTemp: limits }, targets: { inletTemp: t } }, expr));
    expect(target('50')).toEqual(['LIB-USE-TARGET']);
    expect(target('abc')).toEqual(['LIB-USE-TARGET']);
    expect(target('55')).toEqual([]);
    // The innermost tier decides: inside the registered range but outside the alert range is outside.
    const tiered = { unit: 'Cel', ranges: [...range('Cel', '55', '65').ranges, ...range('Cel', '58', '62', 'ALERT').ranges] };
    expect(target('56', tiered)).toEqual(['LIB-USE-TARGET']);
    expect(target('60', tiered)).toEqual([]);
    // An exclusive bound is itself outside.
    const open = range('Cel', '55', '65');
    open.ranges[0]!.low!.inclusive = false;
    open.ranges[0]!.high!.inclusive = false;
    expect(target('55', open)).toEqual(['LIB-USE-TARGET']);
    expect(target('65', open)).toEqual(['LIB-USE-TARGET']);
    expect(target('55.1', open)).toEqual([]);
    expect(target('64.9', open)).toEqual([]);
    // A limit with no range, and a target with no limit at all.
    expect(target('60', { unit: 'Cel', ranges: [] })).not.toContain('LIB-USE-TARGET');
    // A CPP or IPC slot needs its limits; the target adds no refusal of its own.
    const noLimit = { ...friabilityUse(), limits: {}, targets: { loss: '0.5' } };
    expect(codes(checkBlockUse(friability(), noLimit, expr))).toEqual(['LIB-USE-LIMIT-MISSING']);
  });

  it('[PR-08] R-flow item 6: a target with no limits on a slot that needs none is an instruction (shown, never judged); it is still a decimal, and a market rule still needs limits', () => {
    const { dryingTime: _limit, ...others } = fluidBedDryingUse().limits ?? {};
    const use = (targets: Record<string, string>, extra: object = {}) => ({ ...fluidBedDryingUse(), limits: others, targets, ...extra });
    expect(codes(checkBlockUse(fluidBedDrying(), use({ dryingTime: '45' }), expr))).toEqual([]);
    expect(codes(checkBlockUse(fluidBedDrying(), use({ dryingTime: 'long' }), expr))).toEqual(['LIB-USE-TARGET']);
    expect(codes(checkBlockUse(fluidBedDrying(), use({ dryingTime: '45' }, { marketRules: { dryingTime: { key: 'K', bound: 'HIGH' } } }), expr))).toEqual(['LIB-USE-MARKET-RULE']);
  });

  it('[PR-08] a market rule binds a slot that has limits', () => {
    const rule = { loss: { key: 'K', bound: 'HIGH' as const } };
    expect(checkBlockUse(friability(), { ...friabilityUse(), marketRules: rule }, expr)).toEqual([]);
    expect(codes(checkBlockUse(friability(), { ...friabilityUse(), limits: {}, marketRules: rule }, expr))).toEqual(['LIB-USE-MARKET-RULE', 'LIB-USE-LIMIT-MISSING']);
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
    expect(codes(checkBlockUse(def, base, expr))).toEqual(['LIB-USE-INTERVAL']);
  });

  it('[PR-08] a limit looser than the reference limit is a warning, cleared by a written reason (O-5)', () => {
    const loose = { ...friabilityUse(), limits: { loss: range('%', undefined, '1.5') } };
    const ps = checkBlockUse(friability(), loose, expr);
    expect(ps.map((p) => `${p.severity}:${p.code}`)).toEqual(['WARNING:LIB-USE-LOOSER-THAN-REFERENCE']);
    expect(checkBlockUse(friability(), { ...loose, justifications: { loss: 'Coated core, validated in the product development report' } }, expr)).toEqual([]);
    expect(codes(checkBlockUse(friability(), { ...loose, justifications: { loss: '  ' } }, expr))).toEqual(['LIB-USE-LOOSER-THAN-REFERENCE']);
    // No upper bound is looser than any reference maximum.
    expect(checkBlockUse(friability(), { ...friabilityUse(), limits: { loss: range('%', '0', undefined) } }, expr).map((p) => p.message)).toEqual([expect.stringMatching(/upper none above 1 %/)]);
    // Every outer tier is compared (registered, validated, internal action); an alert range is not.
    const validated = range('%', undefined, '1.5');
    validated.ranges[0]!.tier = 'VALIDATED';
    expect(codes(checkBlockUse(friability(), { ...friabilityUse(), limits: { loss: validated } }, expr))).toEqual(['LIB-USE-LOOSER-THAN-REFERENCE']);
    expect(codes(checkBlockUse(friability(), { ...friabilityUse(), limits: { loss: range('%', undefined, '1.5', 'INTERNAL_ACTION') } }, expr))).toEqual(['LIB-USE-LOOSER-THAN-REFERENCE']);
    const alertOnly = { unit: '%', ranges: [...range('%', undefined, '0.8').ranges, ...range('%', undefined, '1.5', 'ALERT').ranges] };
    expect(codes(checkBlockUse(friability(), { ...friabilityUse(), limits: { loss: alertOnly } }, expr))).not.toContain('LIB-USE-LOOSER-THAN-REFERENCE');
    // A reference minimum: a lower bound below it, or none, is looser; the minimum itself is not.
    const lod = { ...fluidBedDrying(), referenceLimits: { lod: { unit: '%', low: '1.0', note: 'Process validation' } } };
    const lodUse = (low: string | undefined) => ({ ...fluidBedDryingUse(), limits: { ...fluidBedDryingUse().limits, lod: range('%', low, '2.5') } });
    expect(checkBlockUse(lod, lodUse('1.5'), expr)).toEqual([]);
    expect(checkBlockUse(lod, lodUse('1.0'), expr)).toEqual([]);
    expect(checkBlockUse(lod, lodUse('0.5'), expr).map((p) => p.message)).toEqual([expect.stringMatching(/lower 0\.5 below 1 %/)]);
    expect(checkBlockUse(lod, lodUse(undefined), expr).map((p) => p.message)).toEqual([expect.stringMatching(/lower none below 1 %/)]);
  });

  it('[PR-03] a profile test needs its time points, each with its own well-formed limits', () => {
    const none = { ...dissolutionUse(), points: {} };
    expect(codes(checkBlockUse(dissolutionProfile(), none, expr))).toEqual(['LIB-USE-POINTS']);
    const bad = dissolutionUse();
    bad.points!['released']![1] = { id: 'h1', label: '4 h', limits: range('%', '65', '45') };
    expect(codes(checkBlockUse(dissolutionProfile(), bad, expr)).sort()).toEqual(['LIB-USE-LIMIT-EMPTY_RANGE', 'LIB-USE-POINTS']);
    const noPoints = dissolutionUse();
    delete noPoints.points;
    expect(codes(checkBlockUse(dissolutionProfile(), noPoints, expr))).toEqual(['LIB-USE-POINTS']);
    for (const id of ['  ', 5 as unknown as string]) {
      const blank = dissolutionUse();
      blank.points!['released']![0] = { ...blank.points!['released']![0]!, id };
      expect(codes(checkBlockUse(dissolutionProfile(), blank, expr))).toEqual(['LIB-USE-POINTS']);
    }
    // Points for a test that is not a profile are refused.
    expect(codes(checkBlockUse(friability(), { ...friabilityUse(), points: { loss: [{ id: 'h1', label: '1 h', limits: range('%', '0', '1') }] } }, expr))).toEqual(['LIB-USE-POINTS']);
  });

  it('a use checked against another block or version is refused', () => {
    expect(codes(checkBlockUse(friability(), { ...friabilityUse(), block: { code: 'IPC-FRIAB', version: 2 } }, expr))).toEqual(['LIB-USE-BLOCK']);
    expect(codes(checkBlockUse(friability(), { ...friabilityUse(), block: { code: 'IPC-OTHER', version: 1 } }, expr))).toEqual(['LIB-USE-BLOCK']);
  });
});

describe('review additions: inputs from outside the step, conditional fields, pinning', () => {
  it('[DI-33] a calculation reads the formula line, the lot assay, an earlier step and the batch size', () => {
    expect(checkBlockDefinition(potencyDispensing(), expr)).toEqual([]);
    expect(slotsOf(potencyDispensing()).map((s) => `${s.kind}:${s.name}`)).toEqual(['BOM_LINE:activeLine', 'STEP_VALUE:lodSource']);
  });

  it('[DI-33] an input names a known kind, a unit, and (for a lot assay) a lot or weighing field of the block', () => {
    const def = potencyDispensing();
    def.inputs = [
      { id: 'assay', label: 'Assay', kind: 'LOT_ASSAY', unit: '%', lotField: 'reworkRef' },
      { id: 'size', label: 'Size', kind: 'BATCH_SIZE', unit: 'parsecs' },
      { id: 'x', label: 'X', kind: 'GUESS' } as unknown as NonNullable<BlockDefinition['inputs']>[number],
    ];
    const cs = codes(checkBlockDefinition(def, expr));
    expect(cs).toEqual(expect.arrayContaining(['LIB-INPUT-LOT', 'LIB-INPUT-UNIT', 'LIB-INPUT-KIND']));
  });

  it('a field id may not repeat an input id', () => {
    const def = withField(potencyDispensing(), { id: 'assay', label: 'Assay again', type: 'NUMBER', unit: '%' });
    expect(codes(checkBlockDefinition(def, expr))).toContain('LIB-FIELD-ID');
  });

  it('[PR-03] a use names the formula line and the earlier step its inputs read', () => {
    const def = potencyDispensing();
    const base = { block: { code: def.code, version: 1 } };
    expect(codes(checkBlockUse(def, base, expr)).sort()).toEqual(['LIB-USE-BOM-LINE', 'LIB-USE-STEP-VALUE']);
    expect(checkBlockUse(def, { ...base, bomLines: { activeLine: 'BOM-API' }, stepValues: { lodSource: { step: 'lod-test', field: 'lod' } } }, expr)).toEqual([]);
    expect(codes(checkBlockUse(def, { ...base, bomLines: { activeLine: '  ' }, stepValues: { lodSource: { step: 'lod-test', field: 'lod' } } }, expr))).toEqual(['LIB-USE-BOM-LINE']);
    for (const v of [{ step: '  ', field: 'lod' }, { step: 5, field: 'lod' }, { step: 'lod-test', field: ' ' }, { step: 'lod-test', field: 5 }]) {
      expect(codes(checkBlockUse(def, { ...base, bomLines: { activeLine: 'BOM-API' }, stepValues: { lodSource: v as { step: string; field: string } } }, expr))).toEqual(['LIB-USE-STEP-VALUE']);
    }
  });

  it('a conditional field depends on an earlier yes/no or choice field and one of its answers', () => {
    const before = potencyDispensing();
    before.sections[0]!.fields = before.sections[0]!.fields.map((f) => (f.id === 'reworkRef' ? { ...f, showWhen: { field: 'reworkQty', equals: true } } : f));
    expect(codes(checkBlockDefinition(before, expr))).toEqual(['LIB-SHOW-WHEN']);
    const notOption = withField(friability(), { id: 'peel', label: 'Peel test', type: 'YES_NO', showWhen: { field: 'cracked', equals: 'PEEL_OFF' } });
    expect(codes(checkBlockDefinition(notOption, expr))).toEqual(['LIB-SHOW-WHEN']);
    const choice = withField(withField(friability(), { id: 'pack', label: 'Pack', type: 'CHOICE', options: ['THERMOFORM', 'PEEL_OFF'] }), { id: 'peel', label: 'Peel test passed', type: 'YES_NO', expected: true, showWhen: { field: 'pack', equals: 'PEEL_OFF' } });
    expect(checkBlockDefinition(choice, expr)).toEqual([]);
  });
  it('[PR-03] a conditional field depends on a field of its own section: the runtime reads the condition from the entry being recorded, so a field of another section would never be asked (LIB-SHOW-WHEN)', () => {
    const two = potencyDispensing();
    const first = two.sections[0]!;
    const flag = { id: 'reworked', label: 'Rework added', type: 'YES_NO' } as const;
    const asked = { id: 'reworkNote', label: 'Rework note', type: 'TEXT', showWhen: { field: 'reworked', equals: true } } as const;
    two.sections = [{ ...first, fields: [...first.fields, flag] }, { id: 'later', title: 'Later', fields: [asked] }, ...two.sections.slice(1)];
    const problems = checkBlockDefinition(two, expr);
    expect(codes(problems)).toEqual(['LIB-SHOW-WHEN']);
    expect(problems[0]?.message).toMatch(/in section/);
    two.sections = [{ ...first, fields: [...first.fields, flag, asked] }, ...two.sections.slice(2)];
    expect(checkBlockDefinition(two, expr)).toEqual([]);
  });


  it('[DI-33] a calculation may read a conditional field only under the same condition', () => {
    const bad = withField(potencyDispensing(), { id: 'total', label: 'Total', type: 'CALC', expression: 'net + reworkQty', unit: 'kg' });
    expect(codes(checkBlockDefinition(bad, expr))).toEqual(['LIB-CALC-CONDITIONAL']);
    const ok = withField(potencyDispensing(), { id: 'total', label: 'Total', type: 'CALC', expression: 'net + reworkQty', unit: 'kg', showWhen: { field: 'rework', equals: true } });
    expect(checkBlockDefinition(ok, expr)).toEqual([]);
  });

  it('[INV-20] a repeat cannot wait on a conditional field', () => {
    const def = fluidBedDrying();
    const loop = def.sections[1]!;
    loop.fields = [{ id: 'skip', label: 'Skip', type: 'YES_NO' }, ...loop.fields.map((f) => (f.id === 'lod' ? { ...f, showWhen: { field: 'skip', equals: false } } : f))];
    // The output's max(lod) now reads a conditional field too, so the calculation is refused as well.
    expect(codes(checkBlockDefinition(def, expr)).sort()).toEqual(['LIB-CALC-CONDITIONAL', 'LIB-REPEAT-UNTIL']);
  });

  it('[PR-05] the content hash pinned at formulation approval must match the library version used', () => {
    const def = friability();
    const pinned = { ...friabilityUse(), block: { code: def.code, version: 1, hash: definitionHash(def) } };
    expect(checkBlockUse(def, pinned, expr)).toEqual([]);
    const changed = { ...def, title: 'Friability (edited)' };
    expect(definitionHash(changed)).not.toEqual(definitionHash(def));
    expect(codes(checkBlockUse(changed, pinned, expr))).toEqual(['LIB-USE-HASH']);
    // Key order does not change the hash.
    const reordered = Object.fromEntries(Object.entries(def).reverse()) as unknown as BlockDefinition;
    expect(definitionHash(reordered)).toEqual(definitionHash(def));
  });
});

describe('reserved field ids (S7 catalogue finding)', () => {
  it('[PR-03] a field may not take an id the entry itself uses', () => {
    for (const id of ['kind', 'lots', 'equipment', 'computed', 'field', 'duration']) {
      const def = withField(friability(), { id, label: 'X', type: 'TEXT' });
      expect(codes(checkBlockDefinition(def, expr)), id).toEqual(['LIB-FIELD-RESERVED']);
    }
  });

  it('[PR-03][DI-30] a field may not be named balance: the database\'s weighing rules take any entry with that member for a scale weighing (S11 finding)', () => {
    const def = withField(friability(), { id: 'balance', label: 'X', type: 'TEXT' });
    expect(codes(checkBlockDefinition(def, expr))).toEqual(['LIB-FIELD-RESERVED']);
  });
});
