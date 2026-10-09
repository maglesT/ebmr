/**
 * Units (brief A1 item 2; outline 6.3 "Units", 6.4): closed UCUM catalogue, exact conversions,
 * temperature offsets handled explicitly, semantic tags, and the controlled legacy hardness alias.
 */
import { describe, expect, it } from 'vitest';
import { Dec } from '../src/decimal/dec.ts';
import { compareValues, convertValue } from '../src/units/quantity.ts';
import { LEGACY_HARDNESS_ALIAS, quantityKindNames, resolveParameterUnit, unitsOfKind } from '../src/units/parameter-units.ts';
import { tagUnitProblem } from '../src/units/tags.ts';
import { divideUnits, multiplyUnits, parseUnit, UnitError } from '../src/units/unit.ts';

function unitCode(code: string): string | undefined {
  try {
    parseUnit(code);
    return undefined;
  } catch (e) {
    return e instanceof UnitError ? e.code : String(e);
  }
}

function conv(value: string, from: string, to: string): { value: string; exact: boolean | undefined; factor: string | undefined } {
  const r = convertValue(Dec.parse(value), parseUnit(from), parseUnit(to));
  return { value: r.value.toString(), exact: r.conversion?.exact, factor: r.conversion?.factor };
}

describe('unit catalogue', () => {
  it('[DI-33] reads UCUM codes built from catalogue atoms, with prefixes only on metric atoms', () => {
    expect(parseUnit('mg/mL').dimensionKey).toBe('m-3.g1');
    expect(parseUnit('kgf/cm2').dimensionKey).toBe('m-1.s-2.g1');
    expect(parseUnit('mm[Hg]').dimensionKey).toBe('m-1.s-2.g1');
    expect(parseUnit('/min').dimensionKey).toBe('s-1');
    expect(parseUnit('{tbl}').bareNumber).toBe(true);
    expect(parseUnit('mg/{tbl}').dimensionKey).toBe('g1');
    expect(parseUnit('[CFU]/m3').dimensionKey).toBe('m-3.[CFU]1');
  });

  it('[DI-33] refuses what is not UCUM, what is outside the catalogue, and calendar-variable units', () => {
    expect(unitCode('kp')).toBe('UNIT_UNKNOWN_ATOM');
    expect(unitCode('kg/cm²')).toBe('UNIT_SYNTAX');
    expect(unitCode('mo')).toBe('UNIT_NOT_IN_CATALOGUE');
    expect(unitCode('a')).toBe('UNIT_NOT_IN_CATALOGUE');
    expect(unitCode('[lb_av]')).toBe('UNIT_NOT_IN_CATALOGUE');
    expect(unitCode('[EU]')).toBe('UNIT_NOT_IN_CATALOGUE');
    expect(unitCode('mmin')).toBe('UNIT_PREFIX_NOT_ALLOWED');
    expect(unitCode('10.L')).toBe('UNIT_NUMERIC_FACTOR');
    expect(unitCode('(kg/m)2')).toBe('UNIT_SYNTAX');
    expect(unitCode('')).toBe('UNIT_SYNTAX');
  });

  it('[DI-33] an absolute temperature cannot be part of a compound unit (a rate uses K)', () => {
    expect(unitCode('Cel/min')).toBe('UNIT_TEMPERATURE_COMPOUND');
    expect(parseUnit('K/min').dimensionKey).toBe('s-1.K1');
    expect(() => multiplyUnits(parseUnit('Cel'), parseUnit('s'))).toThrow(UnitError);
  });

  it('composes units and cancels terms', () => {
    expect(multiplyUnits(parseUnit('mL'), parseUnit('g/mL')).code).toBe('g');
    expect(divideUnits(parseUnit('kg'), parseUnit('mg/{tbl}')).code).toBe('kg.{tbl}/mg');
    expect(divideUnits(parseUnit('kg'), parseUnit('kg')).code).toBe('1');
  });

  it('offers the named units of each quantity kind', () => {
    expect(quantityKindNames()).toContain('force');
    expect(unitsOfKind('force')).toEqual(['N', 'kN', 'kgf']);
    expect(unitsOfKind('nothing')).toEqual([]);
  });
});

describe('exact conversions', () => {
  it('[DI-33] metric conversions are exact decimal factors', () => {
    expect(conv('8.741485531610301190262750678712619', 'kg', 'mg')).toEqual({ value: '8741485.531610301190262750678712619', exact: true, factor: '1000000' });
    expect(conv('250.0', 'mg', 'g')).toEqual({ value: '0.25', exact: true, factor: '0.001' });
    expect(conv('10.5', 'mL', 'L').value).toBe('0.0105');
    expect(conv('90', 'min', 'h').value).toBe('1.5');
    expect(conv('1', 'd', 's').value).toBe('86400');
  });

  it('[DI-33] kgf to N uses the exact standard gravity 9.80665 (tablets spec C.0, C-17)', () => {
    expect(conv('1', 'kgf', 'N')).toEqual({ value: '9.80665', exact: true, factor: '9.80665' });
    expect(conv('1', 'kgf/cm2', 'kPa')).toEqual({ value: '98.0665', exact: true, factor: '98.0665' });
    expect(conv('1', 'kgf/cm2', 'bar').value).toBe('0.980665');
  });

  it('[DI-33] a non-terminating factor is exact as a rational and rounded once at 34 digits', () => {
    const r = conv('1', '[psi]', 'Pa');
    expect(r.value).toBe('6894.757293168361336722673445346891');
    expect(r.exact).toBe(false);
    expect(r.factor).toBe('8896443230521/1290320000');
    expect(conv('2.0', 'bar', 'mbar')).toEqual({ value: '2000', exact: true, factor: '1000' });
  });

  it('[DI-33] temperature offsets are handled explicitly: Cel <-> [degF] through kelvin', () => {
    expect(conv('121.1', 'Cel', '[degF]')).toMatchObject({ value: '249.98', exact: true });
    expect(conv('-40', '[degF]', 'Cel').value).toBe('-40');
    expect(conv('100', '[degF]', 'Cel').value).toBe('37.77777777777777777777777777777778');
    const r = convertValue(Dec.parse('25'), parseUnit('Cel'), parseUnit('[degF]'));
    expect(r.conversion).toMatchObject({ fromOffset: '273.15', toOffset: '459.67' });
    // An absolute temperature and a temperature difference are different kinds.
    expect(() => convertValue(Dec.parse('10'), parseUnit('K'), parseUnit('Cel'))).toThrow(UnitError);
  });

  it('[DI-33] refuses conversions between different kinds of quantity', () => {
    expect(() => convertValue(Dec.parse('1'), parseUnit('kg'), parseUnit('L'))).toThrow(/different things/);
    expect(() => convertValue(Dec.parse('1'), parseUnit('kgf/cm2'), parseUnit('N'))).toThrow(UnitError);
  });

  it('compares values in different units exactly, without rounding', () => {
    expect(compareValues(Dec.parse('1'), parseUnit('kg'), Dec.parse('1000'), parseUnit('g'))).toBe(0);
    expect(compareValues(Dec.parse('1'), parseUnit('[psi]'), Dec.parse('6894.757293168361336722673445346891'), parseUnit('Pa'))).toBe(-1);
    expect(compareValues(Dec.parse('121.1'), parseUnit('Cel'), Dec.parse('249.98'), parseUnit('[degF]'))).toBe(0);
  });
});

describe('semantic tags', () => {
  it('[DI-33] percentage tags need a dimensionless unit; % w/v is a mass per volume; a count is a plain number', () => {
    expect(tagUnitProblem('lod', parseUnit('%'))).toBeUndefined();
    expect(tagUnitProblem('lod', parseUnit('mg'))).toMatch(/dimensionless/);
    expect(tagUnitProblem('w/v', parseUnit('g/dL'))).toBeUndefined();
    expect(tagUnitProblem('w/v', parseUnit('%'))).toMatch(/mass per volume/);
    expect(tagUnitProblem('count', parseUnit('{tbl}'))).toBeUndefined();
    expect(tagUnitProblem('count', parseUnit('%'))).toMatch(/plain number/);
  });
});

describe('parameter units and the legacy hardness alias (outline 6.3, L-39)', () => {
  it('[DI-33] hardness registered as "kg/cm² (as kgf/kp)" maps to kgf with a recorded conversion and a WARNING needing justification', () => {
    const r = resolveParameterUnit(LEGACY_HARDNESS_ALIAS, 'force');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.unit.unit.code).toBe('kgf');
    expect(r.unit.alias).toMatchObject({ mapsTo: 'kgf', factorToNewton: '9.80665' });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ code: 'EXPR-UNIT-030', severity: 'WARNING', requiresJustification: true });
    expect(r.diagnostics[0]?.message).toMatch(/hardness is a force/);
    // The ASCII spelling of the same controlled alias is accepted too.
    expect(resolveParameterUnit('kg/cm2  (as kgf/kp)', 'force').ok).toBe(true);
  });

  it('[DI-33] a genuine pressure unit on a force parameter without the alias is refused', () => {
    for (const code of ['kgf/cm2', 'kPa', 'bar', '[psi]', 'kg/cm2']) {
      const r = resolveParameterUnit(code, 'force');
      expect(r.ok, code).toBe(false);
      expect(r.diagnostics[0]?.code, code).toBe('EXPR-UNIT-021');
      expect(r.diagnostics[0]?.message, code).toMatch(/not a force/);
    }
    const bare = resolveParameterUnit('kg/cm²', 'force');
    expect(bare.ok).toBe(false);
    expect(bare.diagnostics[0]?.message).toMatch(/controlled alias/);
  });

  it('[DI-33] the alias is only for force parameters; ordinary units resolve without diagnostics', () => {
    expect(resolveParameterUnit(LEGACY_HARDNESS_ALIAS, 'pressure')).toMatchObject({ ok: false, diagnostics: [{ code: 'EXPR-UNIT-022' }] });
    expect(resolveParameterUnit('N', 'force')).toMatchObject({ ok: true, diagnostics: [] });
    expect(resolveParameterUnit('kgf/cm2', 'pressure')).toMatchObject({ ok: true, diagnostics: [] });
    expect(resolveParameterUnit('kp', 'force')).toMatchObject({ ok: true, diagnostics: [{ code: 'EXPR-UNIT-031', severity: 'INFO' }] });
    expect(resolveParameterUnit('mL', 'mass')).toMatchObject({ ok: false, diagnostics: [{ code: 'EXPR-UNIT-002' }] });
    expect(resolveParameterUnit('kg', 'nonsense')).toMatchObject({ ok: false, diagnostics: [{ code: 'EXPR-UNIT-020' }] });
  });
});
