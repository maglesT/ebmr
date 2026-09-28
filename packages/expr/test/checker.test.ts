/**
 * Static type, unit and tag checking (brief A1 items 2-3; outline 6.3 data gates; ADR 0005).
 * Design-time errors block; they name the rule and the control in plain language.
 */
import { describe, expect, it } from 'vitest';
import { compile, type CompileOptions } from '../src/lang/compile.ts';
import type { InputDeclarations } from '../src/lang/types.ts';

const inputs: InputDeclarations = {
  lod: { unit: '%', tag: 'lod' },
  lod2: { unit: '%', tag: 'lod' },
  y: { unit: '%', tag: 'yield' },
  water: { unit: '%', tag: 'w/w' },
  assay: { unit: '%', tag: 'w/w' },
  plain_pct: { unit: '%' },
  mass: { unit: 'kg' },
  mass_g: { unit: 'g' },
  volume: { unit: 'mL' },
  n: { unit: '{tbl}', tag: 'count' },
  t1: { unit: 'Cel' },
  t2: { unit: '[degF]' },
  dt: { unit: 'K' },
  weights: { kind: 'series', unit: 'mg', maxLength: 20 },
  big: { kind: 'series', unit: 'mg', maxLength: 100_000 },
  coating: { kind: 'category', values: ['FILM', 'SUGAR', 'NONE'] },
  start: { kind: 'instant' },
  end: { kind: 'instant' },
  ok: { kind: 'boolean' },
  conc_wv: { unit: '%', tag: 'w/v' },
};

function check(source: string, options: Partial<CompileOptions> = {}) {
  return compile(source, { inputs, ...options });
}

function errors(source: string, options: Partial<CompileOptions> = {}): string[] {
  const r = check(source, options);
  return r.diagnostics.filter((d) => d.severity === 'ERROR').map((d) => d.code);
}

function resultOf(source: string, options: Partial<CompileOptions> = {}) {
  const r = check(source, options);
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('; '));
  return r.program.resultType;
}

describe('declared inputs only', () => {
  it('[DI-33] an expression reads only the inputs its calculation declares', () => {
    const r = check('mass + undeclared');
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]).toMatchObject({ code: 'EXPR-TYP-001', severity: 'ERROR', control: 'DI-33', start: 7, end: 17 });
    expect(r.diagnostics[0]?.message).toMatch(/"undeclared" is not a declared input.*\(EXPR-TYP-001, DI-33\)$/);
  });

  it('[DI-33] the function library is closed: unknown functions are refused', () => {
    expect(errors('my_formula(mass)')).toEqual(['EXPR-FN-001']);
    expect(check('my_formula(mass)').diagnostics[0]?.message).toMatch(/library is closed/);
  });

  it('[INV-25] a calculation computes its result from inputs; a constant typed into a formula is refused', () => {
    const r = check('98.5 [%]', { output: { unit: '%', tag: 'yield' } });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === 'EXPR-INV25-001')).toMatchObject({ control: 'INV-25' });
    // A condition may be written against constants only through its inputs as well.
    expect(check('mass > 1 [kg]', { role: 'condition' }).ok).toBe(true);
  });

  it('notes declared inputs that are never read', () => {
    const r = check('mass * 2');
    expect(r.ok).toBe(true);
    expect(r.diagnostics.filter((d) => d.code === 'EXPR-DECL-010').length).toBeGreaterThan(5);
    expect(r.diagnostics.every((d) => d.severity !== 'ERROR')).toBe(true);
  });
});

describe('semantic tags', () => {
  it('[DI-33] adding % LOD to % yield is refused', () => {
    const r = check('lod + y');
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]).toMatchObject({ code: 'EXPR-TAG-001' });
    expect(r.diagnostics[0]?.message).toBe('% LOD and % yield cannot be added: they mean different things (EXPR-TAG-001, DI-33)');
  });

  it('[DI-33] comparing, subtracting or choosing between different tags is refused too', () => {
    expect(errors('lod < y', { role: 'condition' })).toEqual(['EXPR-TAG-001']);
    expect(errors('lod - water')).toEqual(['EXPR-TAG-001']);
    expect(errors('ok ? lod : y')).toEqual(['EXPR-TAG-001']);
    expect(errors('max(lod, y)')).toEqual(['EXPR-TAG-001']);
    expect(errors('lod + plain_pct')).toEqual(['EXPR-TAG-001']);
  });

  it('[DI-33] values with the same tag combine, and constants are tag-neutral', () => {
    expect(resultOf('lod + lod2')).toEqual({ kind: 'quantity', unit: '%', tag: 'lod' });
    expect(resultOf('lod + 0.5 [%]')).toEqual({ kind: 'quantity', unit: '%', tag: 'lod' });
    expect(resultOf('100 [%] - water')).toEqual({ kind: 'quantity', unit: '%', tag: 'w/w' });
    expect(resultOf('lod * 2')).toEqual({ kind: 'quantity', unit: '%', tag: 'lod' });
    expect(resultOf('lod / lod2')).toEqual({ kind: 'quantity', unit: '1', tag: 'none' });
    expect(resultOf('n * 2')).toMatchObject({ tag: 'count' });
  });

  it('[DI-33] an output declared with one tag refuses a formula that gives another', () => {
    const r = check('lod * 1', { output: { unit: '%', tag: 'yield' } });
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === 'EXPR-TAG-002')?.message).toMatch(/gives % LOD, but the output is declared as % yield/);
    // An untagged ratio takes the meaning the declaration gives it.
    expect(resultOf('mass / mass_g * 100 [%]', { output: { unit: '%', tag: 'yield' } })).toEqual({ kind: 'quantity', unit: '%', tag: 'yield' });
  });

  it('[DI-33] a library parameter that needs % LOD refuses another tag or an untagged value', () => {
    expect(errors('assay_as_is_dried(assay, water)')).toEqual(['EXPR-TAG-003']);
    expect(errors('assay_as_is_dried(assay, plain_pct)')).toEqual(['EXPR-TAG-003']);
    expect(resultOf('assay_as_is_dried(assay, lod)')).toEqual({ kind: 'quantity', unit: '%', tag: 'w/w' });
    expect(resultOf('assay_as_is_dried(assay, 0.8 [%])')).toEqual({ kind: 'quantity', unit: '%', tag: 'w/w' });
  });

  it('[DI-33] % w/v is a mass per volume: times a volume it gives a mass; it never adds to a dimensionless %', () => {
    expect(resultOf('conc_wv * volume', { output: { unit: 'g' } })).toEqual({ kind: 'quantity', unit: 'g', tag: 'none' });
    expect(errors('conc_wv + plain_pct')).toEqual(['EXPR-UNIT-010']);
  });
});

describe('units and dimensions', () => {
  it('[DI-33] refuses adding or comparing different kinds of quantity', () => {
    expect(errors('mass + volume')).toEqual(['EXPR-UNIT-010']);
    expect(check('mass + volume').diagnostics[0]?.message).toMatch(/mass \(kg\) and volume \(mL\) measure different things/);
    expect(errors('mass > 1 [L]', { role: 'condition' })).toEqual(['EXPR-UNIT-010']);
  });

  it('[DI-33] adds commensurable units (the right operand is converted to the left unit)', () => {
    expect(resultOf('mass + mass_g')).toEqual({ kind: 'quantity', unit: 'kg', tag: 'none' });
    expect(resultOf('mass_g + mass')).toEqual({ kind: 'quantity', unit: 'g', tag: 'none' });
  });

  it('[DI-33] refuses a plain number next to a percentage (100 - 4.6 % is 99.954 in UCUM)', () => {
    const r = check('100 - water');
    expect(r.diagnostics[0]?.code).toBe('EXPR-UNIT-011');
    expect(r.diagnostics[0]?.message).toMatch(/write the number with its unit, e.g. 100 \[%\]/);
    expect(errors('water < 5', { role: 'condition' })).toEqual(['EXPR-UNIT-011']);
  });

  it('[DI-33] multiplies and divides units, checked against the declared output', () => {
    expect(resultOf('mass / n', { output: { unit: 'mg' } })).toEqual({ kind: 'quantity', unit: 'mg', tag: 'none' });
    expect(errors('mass * volume', { output: { unit: 'kg' } })).toEqual(['EXPR-UNIT-014']);
    expect(errors('mass / mass_g', { output: { unit: 'kg' } })).toEqual(['EXPR-UNIT-014']);
    expect(errors('mass', { output: { unit: 'nonsense' } })).toEqual(['EXPR-UNIT-001']);
    // A plain-number ratio (kg/kg cancels to 1) stored as % would be multiplied by 100 (98.24 -> 9824 %).
    expect(errors('mass / (mass + mass_g) * 100', { output: { unit: '%', tag: 'yield' } })).toEqual(['EXPR-UNIT-011']);
    expect(resultOf('mass / (mass + mass_g) * 100 [%]', { output: { unit: '%', tag: 'yield' } })).toMatchObject({ unit: '%' });
    // A ratio that still carries units (kg/g) converts correctly.
    expect(resultOf('mass / mass_g * 100', { output: { unit: '%' } })).toMatchObject({ unit: '%' });
  });

  it('[DI-33] an unknown or uncatalogued unit in a literal is refused with the unit rule', () => {
    expect(errors('mass + 1 [lb]')).toEqual(['EXPR-UNIT-001']);
    expect(errors('mass + 1 [[lb_av]]')).toEqual(['EXPR-UNIT-001']);
  });

  it('[DI-33] refuses a division by a literal zero at design time', () => {
    expect(errors('mass / 0')).toEqual(['EXPR-TYP-020']);
  });

  it('[DI-33] a number that cannot be held exactly is refused', () => {
    expect(errors(`mass * 1.${'1'.repeat(40)}`)).toEqual(['EXPR-SYN-007']);
  });
});

describe('temperatures (offsets handled separately and explicitly)', () => {
  it('[DI-33] two absolute temperatures cannot be added, multiplied or negated', () => {
    expect(errors('t1 + t1')).toEqual(['EXPR-UNIT-013']);
    expect(errors('t1 * 2')).toEqual(['EXPR-UNIT-012']);
    expect(errors('-t1')).toEqual(['EXPR-UNIT-012']);
    expect(errors('t1 + mass')).toEqual(['EXPR-UNIT-010']);
    expect(errors('dt - t1')).toEqual(['EXPR-UNIT-013']);
  });

  it('[DI-33] a temperature minus a temperature is a difference in K; plus a difference it stays absolute', () => {
    expect(resultOf('t1 - t2')).toEqual({ kind: 'quantity', unit: 'K', tag: 'none' });
    expect(resultOf('t1 + dt')).toEqual({ kind: 'quantity', unit: 'Cel', tag: 'none' });
    expect(resultOf('dt + t1')).toEqual({ kind: 'quantity', unit: 'Cel', tag: 'none' });
    expect(resultOf('(t1 - 121.1 [Cel]) / 10 [K]')).toEqual({ kind: 'quantity', unit: '1', tag: 'none' });
    expect(check('t1 > t2', { role: 'condition' }).ok).toBe(true);
    expect(errors('t1 > dt', { role: 'condition' })).toEqual(['EXPR-UNIT-010']);
  });
});

describe('series, instants, categories and other kinds', () => {
  it('[DI-33] aggregates run only over recorded series, and a series is never used as a single value', () => {
    expect(errors('weights + 1 [mg]')).toEqual(['EXPR-TYP-011']);
    expect(resultOf('mean(weights)')).toEqual({ kind: 'quantity', unit: 'mg', tag: 'none' });
    expect(errors('mean(mass)')).toEqual(['EXPR-FN-005']);
    expect(check('mean(mass)').diagnostics[0]?.message).toMatch(/aggregates run only over recorded series/);
  });

  it('instants are compared and measured with duration(), never added', () => {
    expect(errors('end - start')).toEqual(['EXPR-TYP-012']);
    expect(resultOf('duration(start, end)', { output: { unit: 'h' } })).toEqual({ kind: 'quantity', unit: 'h', tag: 'none' });
    expect(check('start < end', { role: 'condition' }).ok).toBe(true);
  });

  it('categories compare only with their allowed values', () => {
    expect(check('coating == "FILM"', { role: 'condition' }).ok).toBe(true);
    expect(errors('coating == "FILMX"', { role: 'condition' })).toEqual(['EXPR-TYP-013']);
    expect(errors('coating < "FILM"', { role: 'condition' })).toEqual(['EXPR-TYP-005']);
  });

  it('a bare unit is only a convert() target; a condition must be true/false', () => {
    expect(errors('[min]')).toEqual(['EXPR-TYP-010']);
    expect(resultOf('convert(mass, [g])')).toEqual({ kind: 'quantity', unit: 'g', tag: 'none' });
    expect(errors('mass', { role: 'condition' })).toEqual(['EXPR-TYP-032']);
    expect(errors('ok && mass')).toEqual(['EXPR-TYP-003']);
    expect(errors('mass ? 1 : 2')).toEqual(['EXPR-TYP-004']);
    expect(errors('ok', { output: { unit: 'kg' } })).toEqual(['EXPR-TYP-031']);
  });

  it('reports several independent problems at once, without cascades', () => {
    expect(errors('(lod + y) + (mass + volume)')).toEqual(['EXPR-TAG-001', 'EXPR-UNIT-010']);
  });
});

describe('declarations', () => {
  it('validates input declarations', () => {
    const bad = compile('a', { inputs: { a: { unit: 'kg' }, 'bad-name': { unit: 'kg' }, s: { kind: 'series', unit: 'mg' }, t: { unit: 'mg', tag: 'lod' }, u: {} } });
    expect(bad.diagnostics.map((d) => d.code).sort()).toEqual(['EXPR-DECL-001', 'EXPR-DECL-005', 'EXPR-DECL-006', 'EXPR-DECL-007']);
    expect(compile('a', { inputs: { a: { kind: 'category', values: ['X', 'X'] } } }).diagnostics[0]?.code).toBe('EXPR-DECL-003');
  });
});

describe('static cost bound', () => {
  it('[DI-33] computes a static cost bound from declared series lengths and refuses one above the limit', () => {
    const r = check('sd(weights)');
    expect(r.ok && r.program.cost).toBe(6 * 20 + 50 + 1 + 1);
    expect(errors('sd(big) + sd(big)')).toEqual(['EXPR-COST-001']);
    expect(errors('mass * 2', { maxCost: 2 })).toEqual(['EXPR-COST-001']);
    // A conditional costs its test plus its dearer branch only.
    const c = check('ok ? sd(weights) : mass_g');
    expect(c.ok && c.program.cost).toBe(1 + 1 + (6 * 20 + 50 + 1 + 1));
  });
});
