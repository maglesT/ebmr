/**
 * Units at run time: UCUM codes read against the generated, exact unit table.
 *
 * A Unit carries its dimension (exponents over the base axes), its exact factor to the base units
 * (a rational, never a JavaScript number) and, for absolute temperatures, its offset. Conversions
 * multiply by an exact rational with one final rounding (quantity.ts). The catalogue is closed:
 * a valid UCUM atom that is not in the catalogue is refused with its own message.
 */
import { formatRational, parseRational, R_ONE, rational, rDiv, rEq, rMul, rPow, terminatingDecimal, type Rational } from '../decimal/exact.ts';
import { UNIT_TABLE } from './unit-table.generated.ts';
import type { BaseAxis, UnitAtomRecord } from './unit-table-types.ts';
import { parseUcumSyntax, UnitSyntaxError, type AtomResolver, type UcumTerm } from './ucum-syntax.ts';

export type UnitErrorCode =
  | 'UNIT_SYNTAX'
  | 'UNIT_UNKNOWN_ATOM'
  | 'UNIT_PREFIX_NOT_ALLOWED'
  | 'UNIT_NOT_IN_CATALOGUE'
  | 'UNIT_NUMERIC_FACTOR'
  | 'UNIT_TEMPERATURE_COMPOUND'
  | 'UNIT_INCOMPATIBLE';

export class UnitError extends Error {
  readonly code: UnitErrorCode;
  constructor(code: UnitErrorCode, message: string) {
    super(message);
    this.name = 'UnitError';
    this.code = code;
  }
}

export type Dimension = Readonly<Partial<Record<BaseAxis, number>>>;

export interface Unit {
  /** UCUM code (as parsed, or composed canonically for derived units). */
  readonly code: string;
  readonly dimension: Dimension;
  /** Canonical dimension signature, e.g. "g1.m-3"; "" when dimensionless. */
  readonly dimensionKey: string;
  /** Exact factor to the base units. */
  readonly factor: Rational;
  readonly scale: 'LINEAR' | 'ABSOLUTE_TEMPERATURE';
  /** Absolute temperatures: kelvin = (value + offset) x factor. */
  readonly offset?: Rational;
  readonly terms: readonly UcumTerm[];
  /** No atoms at all ("1", or annotations such as "{tbl}"): a plain number. */
  readonly bareNumber: boolean;
}

const AXES = UNIT_TABLE.baseAxes;
const UCUM_ATOMS = new Set(UNIT_TABLE.ucumAtoms);
const UCUM_METRIC = new Set(UNIT_TABLE.ucumMetricAtoms);
const ATOMS: Readonly<Record<string, UnitAtomRecord>> = UNIT_TABLE.atoms;
const ATOM_FACTORS = new Map<string, Rational>(Object.entries(ATOMS).map(([k, a]) => [k, parseRational(a.factor)]));

const RESOLVER: AtomResolver = {
  isAtom: (c) => UCUM_ATOMS.has(c),
  isMetric: (c) => (ATOMS[c] !== undefined ? ATOMS[c].metric : UCUM_METRIC.has(c)),
  prefixExponent: (p) => UNIT_TABLE.prefixes[p],
};

function dimensionKeyOf(d: Dimension): string {
  return AXES.filter((a) => (d[a] ?? 0) !== 0)
    .map((a) => `${a}${String(d[a] ?? 0)}`)
    .join('.');
}

function mergeTerms(terms: readonly UcumTerm[]): UcumTerm[] {
  const out: UcumTerm[] = [];
  for (const t of terms) {
    const i = out.findIndex((o) => o.prefix === t.prefix && o.atom === t.atom && o.annotation === t.annotation);
    const existing = i >= 0 ? out[i] : undefined;
    if (existing === undefined) {
      out.push(t);
    } else {
      out[i] = { ...existing, exponent: existing.exponent + t.exponent };
    }
  }
  return out.filter((t) => t.exponent !== 0);
}

function termText(t: UcumTerm, exponent: number): string {
  const annotation = t.annotation === undefined ? '' : `{${t.annotation}}`;
  if (t.atom === '') return annotation;
  return `${t.prefix}${t.atom}${exponent === 1 ? '' : String(exponent)}${annotation}`;
}

/** Canonical code of a term list: positive terms joined by ".", then "/term" for each negative one. */
export function codeOfTerms(terms: readonly UcumTerm[]): string {
  const merged = mergeTerms(terms);
  const num = merged.filter((t) => t.exponent > 0).map((t) => termText(t, t.exponent));
  const den = merged.filter((t) => t.exponent < 0).map((t) => termText(t, -t.exponent));
  if (num.length === 0 && den.length === 0) return '1';
  return `${num.join('.')}${den.map((d) => `/${d}`).join('')}`;
}

function build(code: string, terms: readonly UcumTerm[]): Unit {
  let factor = R_ONE;
  const dim: Partial<Record<BaseAxis, number>> = {};
  let bareNumber = true;
  let absolute: UnitAtomRecord | undefined;
  for (const t of terms) {
    if (t.atom === '') continue;
    bareNumber = false;
    const atom = ATOMS[t.atom];
    const atomFactor = ATOM_FACTORS.get(t.atom);
    if (atom === undefined || atomFactor === undefined) {
      throw new UnitError('UNIT_NOT_IN_CATALOGUE', `"${code}": ${t.atom} is valid UCUM but not in the controlled unit catalogue`);
    }
    if (atom.kind === 'ABSOLUTE_TEMPERATURE') absolute = atom;
    const prefix = t.prefix === '' ? R_ONE : rPow(rational(10n), UNIT_TABLE.prefixes[t.prefix] ?? 0);
    factor = rMul(factor, rPow(rMul(prefix, atomFactor), t.exponent));
    for (const axis of AXES) {
      const e = atom.dimension[axis];
      if (e !== undefined) dim[axis] = (dim[axis] ?? 0) + e * t.exponent;
    }
  }
  for (const axis of AXES) if (dim[axis] === 0) delete dim[axis];
  if (absolute !== undefined) {
    const real = terms.filter((t) => t.atom !== '');
    if (real.length !== 1 || real[0]?.exponent !== 1 || real[0].prefix !== '') {
      throw new UnitError(
        'UNIT_TEMPERATURE_COMPOUND',
        `"${code}": an absolute temperature (${absolute.printSymbol}) cannot be part of a compound unit; a rate such as a heating rate is written with K (a temperature difference), e.g. K/min`,
      );
    }
    return Object.freeze({
      code,
      dimension: Object.freeze(dim),
      dimensionKey: dimensionKeyOf(dim),
      factor,
      scale: 'ABSOLUTE_TEMPERATURE' as const,
      offset: parseRational(absolute.offset ?? '0'),
      terms: Object.freeze([...terms]),
      bareNumber: false,
    });
  }
  return Object.freeze({
    code,
    dimension: Object.freeze(dim),
    dimensionKey: dimensionKeyOf(dim),
    factor,
    scale: 'LINEAR' as const,
    terms: Object.freeze([...terms]),
    bareNumber,
  });
}

const cache = new Map<string, Unit>();

/** Reads a UCUM code against the catalogue. Throws UnitError with a plain-language message. */
export function parseUnit(code: string): Unit {
  const hit = cache.get(code);
  if (hit !== undefined) return hit;
  let parsed;
  try {
    parsed = parseUcumSyntax(code, RESOLVER);
  } catch (e) {
    if (e instanceof UnitSyntaxError) throw new UnitError(e.code, e.message);
    throw e;
  }
  if (!rEq(parsed.factor, R_ONE)) throw new UnitError('UNIT_NUMERIC_FACTOR', `"${code}": numeric factors inside unit codes are not accepted; state the quantity in a plain unit`);
  const unit = build(code, parsed.terms);
  if (cache.size < 10_000) cache.set(code, unit);
  return unit;
}

/** True if the code is a unit of the catalogue. */
export function isValidUnit(code: string): boolean {
  try {
    parseUnit(code);
    return true;
  } catch {
    return false;
  }
}

export const DIMENSIONLESS: Unit = parseUnit('1');
export const PERCENT: Unit = parseUnit('%');
export const SECOND: Unit = parseUnit('s');

function compose(a: Unit, b: Unit, sign: 1 | -1): Unit {
  if (a.scale === 'ABSOLUTE_TEMPERATURE' || b.scale === 'ABSOLUTE_TEMPERATURE') {
    throw new UnitError('UNIT_TEMPERATURE_COMPOUND', 'an absolute temperature cannot be multiplied or divided; subtract a reference temperature first');
  }
  const terms = mergeTerms([...a.terms, ...b.terms.map((t) => ({ ...t, exponent: t.exponent * sign }))]);
  const code = codeOfTerms(terms);
  return build(code, terms);
}

export function multiplyUnits(a: Unit, b: Unit): Unit {
  return compose(a, b, 1);
}

export function divideUnits(a: Unit, b: Unit): Unit {
  return compose(a, b, -1);
}

export function sameDimension(a: Unit, b: Unit): boolean {
  return a.dimensionKey === b.dimensionKey && a.scale === b.scale;
}

/** Same unit for conversion purposes (factor and offset equal): no conversion needed. */
export function sameMagnitude(a: Unit, b: Unit): boolean {
  if (!sameDimension(a, b) || !rEq(a.factor, b.factor)) return false;
  if (a.offset === undefined || b.offset === undefined) return a.offset === b.offset;
  return rEq(a.offset, b.offset);
}

/** Exact linear factor from `from` to `to` (value_to = value_from x factor). */
export function linearFactor(from: Unit, to: Unit): Rational {
  if (!sameDimension(from, to) || from.scale !== 'LINEAR') {
    throw new UnitError('UNIT_INCOMPATIBLE', `${from.code} cannot be converted to ${to.code}: different quantities`);
  }
  return rDiv(from.factor, to.factor);
}

/** The factor as text for evidence: a terminating decimal where one exists, else "num/den". */
export function factorText(r: Rational): string {
  return terminatingDecimal(r) ?? formatRational(r);
}

/** Human-readable dimension, e.g. "mass per volume". Used in messages only. */
export function describeDimension(u: Unit): string {
  if (u.scale === 'ABSOLUTE_TEMPERATURE') return 'absolute temperature';
  const k = u.dimensionKey;
  const known: Record<string, string> = {
    '': 'a plain number or fraction',
    g1: 'mass',
    m3: 'volume',
    m1: 'length',
    m2: 'area',
    s1: 'time',
    K1: 'temperature difference',
    'm-1.s-2.g1': 'pressure',
    'm1.s-2.g1': 'force',
    'm-3.g1': 'mass per volume',
    'm3.s-1': 'volume flow',
    's-1.g1': 'mass flow',
    'g1.mol-1': 'molar mass',
    mol1: 'amount of substance',
    's-1': 'frequency',
    'm1.s-1': 'velocity',
  };
  return known[k] ?? `dimension ${k}`;
}
