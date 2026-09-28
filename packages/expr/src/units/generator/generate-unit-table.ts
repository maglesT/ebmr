/**
 * Build-time generator of the exact unit table (ADR 0005 decision 2; brief A1 item 2).
 *
 * For every catalogue atom it reads the UCUM definition from @lhncbc/ucum-lhc (value and unit
 * expression, e.g. [psi] = 1 [lbf_av]/[in_i]2), resolves it recursively down to the base units with
 * exact rational arithmetic (BigInt), and writes the factors as rational text. ucum-lhc's own
 * floating-point magnitudes are used only as a cross-check (relative difference <= 1e-12); a
 * mismatch stops the generation. Nothing here runs at run time: the runtime reads the committed,
 * generated file, and a test regenerates it and compares.
 *
 * Run: npx tsx packages/expr/src/units/generator/cli.ts
 */
import { createRequire } from 'node:module';
import { UcumLhcUtils, UnitTables, type UcumUnit } from '@lhncbc/ucum-lhc';
import { PrefixTables } from '@lhncbc/ucum-lhc/source-cjs/prefixTables.js';
import { formatRational, R_ONE, rAdd, rational, rDiv, rMul, rPow, terminatingDecimal, type Rational } from '../../decimal/exact.ts';
import type { BaseAxis, NamedUnitRecord, QuantityKindRecord, UnitAtomRecord, UnitTable } from '../unit-table-types.ts';
import { parseUcumSyntax, type AtomResolver } from '../ucum-syntax.ts';
import { CATALOGUE_ATOMS, NO_PREFIX_ATOMS, PREFIXES, QUANTITY_KINDS, TEMPERATURE_SCALES } from './unit-catalogue.ts';

export const UNIT_TABLE_VERSION = '1';
const BASE_AXES: readonly BaseAxis[] = ['m', 's', 'g', 'rad', 'K', 'C', 'cd', 'mol', '[iU]', '[CFU]'];
const UCUM_BASE_UNITS = new Set(['m', 's', 'g', 'rad', 'K', 'C', 'cd']);
const OWN_AXIS_ARBITRARY = new Set(['[iU]', '[CFU]']);
const RELATIVE_TOLERANCE = 1e-12;

type Dimension = Map<BaseAxis, number>;
interface Resolved {
  factor: Rational;
  dimension: Dimension;
  usesMole: boolean;
}

/** Exact rational of a decimal text of any length (UCUM definitions may exceed 34 digits). */
export function exactDecimal(text: string): Rational {
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(text.trim());
  if (m === null) throw new Error(`unit generator: "${text}" is not a decimal`);
  const fraction = m[3] ?? '';
  const exp = Number(m[4] ?? '0') - fraction.length;
  const digits = BigInt(`${m[1] ?? ''}${m[2] ?? '0'}${fraction}`);
  return exp >= 0 ? rational(digits * 10n ** BigInt(exp)) : rational(digits, 10n ** BigInt(-exp));
}

function toApproximateNumber(r: Rational): number {
  // Cross-check only (never a GMP value): compare with ucum-lhc's float magnitude.
  return Number(r.num) / Number(r.den);
}

function relativelyClose(a: number, b: number): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= RELATIVE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
}

function addDim(target: Dimension, source: Dimension, times: number): void {
  for (const [axis, e] of source) {
    const next = (target.get(axis) ?? 0) + e * times;
    if (next === 0) target.delete(axis);
    else target.set(axis, next);
  }
}

function dimRecord(d: Dimension): Partial<Record<BaseAxis, number>> {
  const out: Partial<Record<BaseAxis, number>> = {};
  for (const axis of BASE_AXES) {
    const e = d.get(axis);
    if (e !== undefined && e !== 0) out[axis] = e;
  }
  return out;
}

function dimKey(d: Dimension): string {
  return BASE_AXES.filter((a) => (d.get(a) ?? 0) !== 0)
    .map((a) => `${a}${d.get(a) ?? 0}`)
    .join('.');
}

function cleanSymbol(u: UcumUnit, code: string): string {
  const s = u.printSymbol_;
  return s === null || s.includes('<') || s.length === 0 ? code : s;
}

export interface UcumSource {
  readonly version: string;
  unit(code: string): UcumUnit | undefined;
  readonly atomCodes: readonly string[];
  readonly metricCodes: ReadonlySet<string>;
  prefixExponent(code: string): number | null | undefined;
  convert(from: string, value: number, to: string): number | null;
  validate(code: string): boolean;
}

/** Loads ucum-lhc (build time and tests only). */
export function loadUcumSource(): UcumSource {
  const require = createRequire(import.meta.url);
  const pkg = require('@lhncbc/ucum-lhc/package.json') as { version: string };
  const utils = UcumLhcUtils.getInstance();
  const tables = UnitTables.getInstance();
  const atomCodes = Object.keys(tables.unitCodes_)
    .filter((c) => tables.getUnitByCode(c)?.source_ === 'UCUM')
    .sort(compareCodePoints);
  const metricCodes = new Set(atomCodes.filter((c) => {
    const u = tables.getUnitByCode(c);
    return u !== undefined && (u.isMetric_ || UCUM_BASE_UNITS.has(c));
  }));
  // ucum-lhc stores prefix exponents as strings ("18"), and null for the binary prefixes.
  const prefixes = new Map(PrefixTables.getInstance().allPrefixesByCode().map((p) => [p.code_, p.exp_ === null ? null : Number(p.exp_)] as const));
  return {
    version: pkg.version,
    unit: (code) => tables.getUnitByCode(code),
    atomCodes,
    metricCodes,
    prefixExponent: (code) => prefixes.get(code),
    convert: (from, value, to) => {
      const r = utils.convertUnitTo(from, value, to);
      return r.status === 'succeeded' ? r.toVal : null;
    },
    validate: (code) => utils.validateUnitString(code, false).status === 'valid',
  };
}

export function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

class Resolver {
  private readonly memo = new Map<string, Resolved>();
  readonly syntax: AtomResolver;

  constructor(private readonly src: UcumSource) {
    const atoms = new Set(src.atomCodes);
    this.syntax = {
      isAtom: (c) => atoms.has(c),
      isMetric: (c) => src.metricCodes.has(c),
      prefixExponent: (p) => PREFIXES[p],
    };
  }

  expression(text: string, stack: readonly string[]): Resolved {
    const parsed = parseUcumSyntax(text, this.syntax);
    let factor = parsed.factor;
    const dimension: Dimension = new Map();
    let usesMole = false;
    for (const t of parsed.terms) {
      if (t.atom === '') continue;
      const atom = this.atom(t.atom, stack);
      const prefix = t.prefix === '' ? R_ONE : rPow(rational(10n), PREFIXES[t.prefix] ?? 0);
      factor = rMul(factor, rPow(rMul(prefix, atom.factor), t.exponent));
      addDim(dimension, atom.dimension, t.exponent);
      usesMole ||= atom.usesMole;
    }
    return { factor, dimension, usesMole };
  }

  atom(code: string, stack: readonly string[] = []): Resolved {
    const hit = this.memo.get(code);
    if (hit !== undefined) return hit;
    if (stack.includes(code)) throw new Error(`unit generator: circular UCUM definition through ${[...stack, code].join(' -> ')}`);
    let result: Resolved;
    if (UCUM_BASE_UNITS.has(code)) {
      result = { factor: R_ONE, dimension: new Map([[code as BaseAxis, 1]]), usesMole: false };
    } else if (code === 'mol') {
      result = { factor: R_ONE, dimension: new Map([['mol', 1]]), usesMole: true };
    } else {
      const u = this.src.unit(code);
      if (u === undefined) throw new Error(`unit generator: ${code} is not in ucum-lhc`);
      if (u.isArbitrary_) {
        if (!OWN_AXIS_ARBITRARY.has(code)) throw new Error(`unit generator: arbitrary unit ${code} is not supported`);
        result = { factor: R_ONE, dimension: new Map([[code as BaseAxis, 1]]), usesMole: false };
      } else if (u.isSpecial_) {
        throw new Error(`unit generator: ${code} is a special (non-ratio) unit and cannot appear in a definition`);
      } else {
        if (u.csUnitString_ === null || u.baseFactorStr_ === null) throw new Error(`unit generator: ${code} has no definition`);
        const inner = this.expression(u.csUnitString_, [...stack, code]);
        result = { factor: rMul(exactDecimal(u.baseFactorStr_), inner.factor), dimension: inner.dimension, usesMole: inner.usesMole };
      }
    }
    this.memo.set(code, result);
    return result;
  }
}

function checkPrefixes(src: UcumSource): void {
  for (const [code, exp] of Object.entries(PREFIXES)) {
    if (src.prefixExponent(code) !== exp) throw new Error(`unit generator: prefix ${code} is 10^${exp} here but not in ucum-lhc`);
  }
}

function atomRecord(code: string, src: UcumSource, resolver: Resolver): UnitAtomRecord {
  const u = src.unit(code);
  if (u === undefined || u.source_ !== 'UCUM') throw new Error(`unit generator: catalogue atom ${code} is not a UCUM atom`);
  if (/[0-9]$/.test(code)) throw new Error(`unit generator: atom ${code} ends in a digit (ambiguous with an exponent)`);
  const metric = (u.isMetric_ || UCUM_BASE_UNITS.has(code)) && !NO_PREFIX_ATOMS.includes(code);
  const scale = TEMPERATURE_SCALES[code];
  if (scale !== undefined) {
    const factor = exactDecimalOrRational(scale.factor);
    const offset = exactDecimalOrRational(scale.offset);
    for (const probe of ['-40', '0', '100', '121.1']) {
      const expected = toApproximateNumber(rMul(rAdd(exactDecimal(probe), offset), factor));
      const got = src.convert(code, Number(probe), 'K');
      if (got === null || !relativelyClose(expected, got)) throw new Error(`unit generator: ${code} -> K disagrees with ucum-lhc at ${probe}`);
    }
    return {
      name: u.name_.length > 0 ? u.name_ : code,
      printSymbol: cleanSymbol(u, code),
      property: u.property_,
      metric: false,
      kind: 'ABSOLUTE_TEMPERATURE',
      dimension: { K: 1 },
      factor: formatRational(factor),
      factorDecimal: terminatingDecimal(factor) ?? null,
      offset: formatRational(offset),
      definition: scale.definition,
    };
  }
  if (u.isSpecial_) throw new Error(`unit generator: special unit ${code} needs an explicit definition`);
  const r = resolver.atom(code);
  if (!r.usesMole && !u.isArbitrary_) {
    const approx = toApproximateNumber(r.factor);
    if (!relativelyClose(approx, u.magnitude_)) throw new Error(`unit generator: exact factor of ${code} (${formatRational(r.factor)}) disagrees with ucum-lhc (${u.magnitude_})`);
  }
  const definition = UCUM_BASE_UNITS.has(code)
    ? 'UCUM base unit'
    : code === 'mol'
      ? 'own axis (UCUM defines mol as the number 6.0221367e23)'
      : u.isArbitrary_
        ? 'UCUM arbitrary unit (own axis)'
        : `${u.baseFactorStr_ ?? ''} ${u.csUnitString_ ?? ''}`;
  return {
    name: u.name_,
    printSymbol: cleanSymbol(u, code),
    property: u.property_,
    metric,
    kind: u.isArbitrary_ ? 'ARBITRARY' : 'LINEAR',
    dimension: dimRecord(r.dimension),
    factor: formatRational(r.factor),
    factorDecimal: terminatingDecimal(r.factor) ?? null,
    definition,
  };
}

function exactDecimalOrRational(text: string): Rational {
  const parts = text.split('/');
  return parts.length === 2 ? rDiv(exactDecimal(parts[0] ?? ''), exactDecimal(parts[1] ?? '')) : exactDecimal(text);
}

function quantityKinds(src: UcumSource, atoms: Record<string, UnitAtomRecord>): Record<string, QuantityKindRecord> {
  const catalogue = new Set(Object.keys(atoms));
  const ucumAtoms = new Set(src.atomCodes);
  const syntax: AtomResolver = {
    isAtom: (c) => ucumAtoms.has(c),
    isMetric: (c) => atoms[c]?.metric === true,
    prefixExponent: (p) => PREFIXES[p],
  };
  const out: Record<string, QuantityKindRecord> = {};
  for (const [kind, spec] of Object.entries(QUANTITY_KINDS)) {
    let dimension: Dimension | undefined;
    const units: NamedUnitRecord[] = [];
    const first = spec.units[0];
    if (first === undefined) throw new Error(`unit generator: quantity kind ${kind} lists no unit`);
    let firstFactor: Rational | undefined;
    for (const code of spec.units) {
      if (!src.validate(code)) throw new Error(`unit generator: ${code} (${kind}) is not valid UCUM per ucum-lhc`);
      const parsed = parseUcumSyntax(code, syntax);
      let factor = parsed.factor;
      const dim: Dimension = new Map();
      for (const t of parsed.terms) {
        if (t.atom === '') continue;
        if (!catalogue.has(t.atom)) throw new Error(`unit generator: ${code} (${kind}) uses ${t.atom}, which is not in the catalogue`);
        const a = atoms[t.atom];
        if (a === undefined) throw new Error('unreachable');
        const af = exactDecimalOrRational(a.factor);
        const prefix = t.prefix === '' ? R_ONE : rPow(rational(10n), PREFIXES[t.prefix] ?? 0);
        factor = rMul(factor, rPow(rMul(prefix, af), t.exponent));
        const ad: Dimension = new Map(Object.entries(a.dimension).map(([k, v]) => [k as BaseAxis, v]));
        addDim(dim, ad, t.exponent);
      }
      if (dimension === undefined) {
        dimension = dim;
        firstFactor = factor;
      } else if (dimKey(dimension) !== dimKey(dim)) {
        throw new Error(`unit generator: ${code} does not have the dimension of quantity kind ${kind}`);
      }
      // ucum-lhc refuses every conversion of arbitrary units ([CFU]/mL -> [CFU]/m3); the factor is
      // then checked through its non-arbitrary atoms, which are cross-checked individually.
      const arbitrary = dim.has('[iU]') || dim.has('[CFU]');
      if (spec.scale === 'LINEAR' && !arbitrary && firstFactor !== undefined && code !== first) {
        const expected = toApproximateNumber(rDiv(factor, firstFactor));
        const got = src.convert(code, 1, first);
        if (got === null || !relativelyClose(expected, got)) throw new Error(`unit generator: ${code} -> ${first} disagrees with ucum-lhc (${String(got)})`);
      }
      units.push({ code, factor: formatRational(factor), factorDecimal: terminatingDecimal(factor) ?? null });
    }
    out[kind] = { dimension: dimRecord(dimension ?? new Map<BaseAxis, number>()), scale: spec.scale, units };
  }
  return out;
}

export function buildUnitTable(src: UcumSource = loadUcumSource()): UnitTable {
  checkPrefixes(src);
  const resolver = new Resolver(src);
  const atoms: Record<string, UnitAtomRecord> = {};
  for (const code of [...CATALOGUE_ATOMS].sort(compareCodePoints)) atoms[code] = atomRecord(code, src, resolver);
  return {
    tableVersion: UNIT_TABLE_VERSION,
    ucumLhcVersion: src.version,
    baseAxes: BASE_AXES,
    prefixes: PREFIXES,
    atoms,
    ucumAtoms: src.atomCodes,
    ucumMetricAtoms: src.atomCodes.filter((c) => src.metricCodes.has(c)),
    quantityKinds: quantityKinds(src, atoms),
  };
}

function lit(value: string): string {
  return JSON.stringify(value);
}

function renderDimension(d: Readonly<Partial<Record<BaseAxis, number>>>): string {
  const parts = BASE_AXES.filter((a) => d[a] !== undefined).map((a) => `${lit(a)}: ${String(d[a])}`);
  return `{ ${parts.join(', ')} }`.replace('{  }', '{}');
}

function renderList(values: readonly string[], indent: string): string {
  const lines: string[] = [];
  let line = '';
  for (const v of values) {
    const item = `${lit(v)}, `;
    if (line.length + item.length > 100) {
      lines.push(`${indent}${line.trimEnd()}`);
      line = '';
    }
    line += item;
  }
  if (line.length > 0) lines.push(`${indent}${line.trimEnd()}`);
  return lines.join('\n');
}

/** The TypeScript source of the committed table (deterministic; no dates). */
export function renderUnitTableSource(table: UnitTable): string {
  const out: string[] = [];
  out.push('// GENERATED FILE - do not edit by hand.');
  out.push('// Generator: packages/expr/src/units/generator/generate-unit-table.ts (catalogue: unit-catalogue.ts)');
  out.push('// Regenerate: npx tsx packages/expr/src/units/generator/cli.ts');
  out.push(`// Source of the definitions: @lhncbc/ucum-lhc ${table.ucumLhcVersion}; factors are exact rationals to the base units.`);
  out.push("import type { UnitTable } from './unit-table-types.ts';");
  out.push('');
  out.push('export const UNIT_TABLE: UnitTable = {');
  out.push(`  tableVersion: ${lit(table.tableVersion)},`);
  out.push(`  ucumLhcVersion: ${lit(table.ucumLhcVersion)},`);
  out.push(`  baseAxes: [${table.baseAxes.map(lit).join(', ')}],`);
  out.push('  prefixes: {');
  for (const [k, v] of Object.entries(table.prefixes)) out.push(`    ${lit(k)}: ${String(v)},`);
  out.push('  },');
  out.push('  atoms: {');
  for (const [code, a] of Object.entries(table.atoms)) {
    out.push(`    ${lit(code)}: {`);
    out.push(`      name: ${lit(a.name)},`);
    out.push(`      printSymbol: ${lit(a.printSymbol)},`);
    out.push(`      property: ${lit(a.property)},`);
    out.push(`      metric: ${String(a.metric)},`);
    out.push(`      kind: ${lit(a.kind)},`);
    out.push(`      dimension: ${renderDimension(a.dimension)},`);
    out.push(`      factor: ${lit(a.factor)},`);
    out.push(`      factorDecimal: ${a.factorDecimal === null ? 'null' : lit(a.factorDecimal)},`);
    if (a.offset !== undefined) out.push(`      offset: ${lit(a.offset)},`);
    out.push(`      definition: ${lit(a.definition)},`);
    out.push('    },');
  }
  out.push('  },');
  out.push('  ucumAtoms: [');
  out.push(renderList(table.ucumAtoms, '    '));
  out.push('  ],');
  out.push('  ucumMetricAtoms: [');
  out.push(renderList(table.ucumMetricAtoms, '    '));
  out.push('  ],');
  out.push('  quantityKinds: {');
  for (const [kind, q] of Object.entries(table.quantityKinds)) {
    out.push(`    ${lit(kind)}: {`);
    out.push(`      dimension: ${renderDimension(q.dimension)},`);
    out.push(`      scale: ${lit(q.scale)},`);
    out.push('      units: [');
    for (const u of q.units) {
      out.push(`        { code: ${lit(u.code)}, factor: ${lit(u.factor)}, factorDecimal: ${u.factorDecimal === null ? 'null' : lit(u.factorDecimal)} },`);
    }
    out.push('      ],');
    out.push('    },');
  }
  out.push('  },');
  out.push('};');
  out.push('');
  return out.join('\n');
}

export function generateUnitTableSource(src: UcumSource = loadUcumSource()): string {
  return renderUnitTableSource(buildUnitTable(src));
}
