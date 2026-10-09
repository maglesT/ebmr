/**
 * The generated unit table (brief A1 item 2): committed, regenerated and compared; every factor
 * exact and cross-checked with @lhncbc/ucum-lhc; our UCUM reader agrees with ucum-lhc on the
 * catalogue and is stricter than it where the UCUM specification is (prefixes on non-metric units).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseRational, rDiv } from '../src/decimal/exact.ts';
import { buildUnitTable, generateUnitTableSource, loadUcumSource } from '../src/units/generator/generate-unit-table.ts';
import { CATALOGUE_ATOMS, PREFIXES } from '../src/units/generator/unit-catalogue.ts';
import { UNIT_TABLE } from '../src/units/unit-table.generated.ts';
import { parseUnit, UnitError } from '../src/units/unit.ts';

const src = loadUcumSource();
const committed = readFileSync(fileURLToPath(new URL('../src/units/unit-table.generated.ts', import.meta.url)), 'utf8');

function approx(r: { num: bigint; den: bigint }): number {
  return Number(r.num) / Number(r.den);
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b));
}

describe('generated unit table', () => {
  it('[DI-33] the committed table equals a fresh generation from the catalogue and ucum-lhc', () => {
    expect(generateUnitTableSource(src)).toBe(committed);
  });

  it('[DI-33] records the ucum-lhc version it was generated from', () => {
    expect(UNIT_TABLE.ucumLhcVersion).toBe(src.version);
    expect(UNIT_TABLE.ucumLhcVersion).toBe('7.1.9');
  });

  it('[DI-33] every catalogue atom is a valid UCUM code according to ucum-lhc', () => {
    for (const code of CATALOGUE_ATOMS) expect(src.validate(code), code).toBe(true);
    expect(Object.keys(UNIT_TABLE.atoms).sort()).toEqual([...CATALOGUE_ATOMS].sort());
  });

  it('[DI-33] factors are exact rationals, never floats, and agree with ucum-lhc to 1e-12', () => {
    for (const [code, atom] of Object.entries(UNIT_TABLE.atoms)) {
      expect(atom.factor, code).toMatch(/^[0-9]+(\/[0-9]+)?$/);
      const u = src.unit(code);
      if (u === undefined || atom.kind !== 'LINEAR' || code === 'mol') continue;
      expect(close(approx(parseRational(atom.factor)), u.magnitude_), code).toBe(true);
    }
    // Known exact values (tablets spec C.0): 1 kgf = 9.80665 N; psi does not terminate.
    expect(UNIT_TABLE.atoms['gf']?.factorDecimal).toBe('9.80665');
    expect(UNIT_TABLE.atoms['[psi]']?.factorDecimal).toBeNull();
    expect(UNIT_TABLE.atoms['[psi]']?.factor).toBe('8896443230521/1290320');
    expect(UNIT_TABLE.atoms['m[Hg]']?.factor).toBe('133322000');
  });

  it('[DI-33] temperature scales carry explicit offsets and are closed to prefixes', () => {
    expect(UNIT_TABLE.atoms['Cel']).toMatchObject({ kind: 'ABSOLUTE_TEMPERATURE', factor: '1', offset: '5463/20', metric: false });
    expect(UNIT_TABLE.atoms['[degF]']).toMatchObject({ kind: 'ABSOLUTE_TEMPERATURE', factor: '5/9', offset: '45967/100', metric: false });
    expect(UNIT_TABLE.atoms['K']).toMatchObject({ kind: 'LINEAR', metric: false });
    expect(() => parseUnit('mCel')).toThrow(UnitError);
  });

  it('[DI-33] every named unit of a quantity kind has the kind dimension and a factor ucum-lhc agrees with', () => {
    for (const [kind, q] of Object.entries(UNIT_TABLE.quantityKinds)) {
      const first = q.units[0];
      if (first === undefined) throw new Error(kind);
      for (const u of q.units) {
        const unit = parseUnit(u.code);
        expect(unit.dimensionKey, `${kind} ${u.code}`).toBe(parseUnit(first.code).dimensionKey);
        expect(parseRational(u.factor), u.code).toEqual(unit.factor);
        const arbitrary = u.code.includes('[CFU]') || u.code.includes('[iU]');
        if (q.scale === 'LINEAR' && !arbitrary && u.code !== first.code) {
          const got = src.convert(u.code, 1, first.code);
          expect(got, u.code).not.toBeNull();
          expect(close(approx(rDiv(unit.factor, parseUnit(first.code).factor)), got ?? NaN), u.code).toBe(true);
        }
      }
    }
  });

  it('uses exactly the UCUM decimal prefixes', () => {
    expect(UNIT_TABLE.prefixes).toEqual(PREFIXES);
    for (const [p, e] of Object.entries(PREFIXES)) expect(src.prefixExponent(p)).toBe(e);
  });

  it('the generator refuses an atom that is not in ucum-lhc', () => {
    const broken = { ...src, unit: (c: string) => (c === 'L' ? undefined : src.unit(c)) };
    expect(() => buildUnitTable(broken)).toThrow(/not a UCUM atom/);
  });
});

const COMPOUND_ATOMS = ['g', 'kg', 'mg', 'ug', 'L', 'mL', 'm', 'cm', 'mm', 's', 'min', 'h', 'Pa', 'kPa', 'bar', 'mbar', 'N', 'kN', 'kgf', 'mol', 'mmol', '%', 'd', 'uS', 'P', 'cP'];

describe('our UCUM reader against ucum-lhc', () => {
  it('[DI-33] agrees on validity and magnitude of random compound units built from catalogue atoms', () => {
    const term = fc.tuple(fc.constantFrom(...COMPOUND_ATOMS), fc.integer({ min: 1, max: 3 }));
    fc.assert(
      fc.property(fc.array(term, { minLength: 1, maxLength: 3 }), fc.array(term, { maxLength: 2 }), (num, den) => {
        const t = ([a, e]: [string, number]): string => (e === 1 ? a : `${a}${String(e)}`);
        const code = `${num.map(t).join('.')}${den.map((d) => `/${t(d)}`).join('')}`;
        const ours = parseUnit(code);
        expect(src.validate(code), code).toBe(true);
        // Compare magnitudes through a conversion to the same unit composed of base units.
        const base = ours.dimensionKey === '' ? '1' : ours.dimensionKey.replace(/([a-z[\]A-Z]+)(-?[0-9]+)/g, (_, a: string, e: string) => `${a}${e === '1' ? '' : e}`);
        const got = src.convert(code, 1, base);
        if (got !== null && ours.scale === 'LINEAR' && !code.includes('mol')) {
          expect(close(approx(ours.factor), got), code).toBe(true);
        }
      }),
      { numRuns: 150 },
    );
  });

  it('[DI-33] is stricter than ucum-lhc where the UCUM specification is: no prefix on a non-metric unit', () => {
    for (const code of ['mmin', 'kh', 'm%', 'k[psi]']) {
      expect(src.validate(code), `ucum-lhc accepts ${code}`).toBe(true);
      expect(() => parseUnit(code), code).toThrow(UnitError);
    }
  });
});
