/**
 * UCUM case-sensitive unit syntax (UCUM specification, grammar of the c/s form), without semantics.
 *
 * Used twice: at build time by the unit-table generator to resolve UCUM definitions exactly, and at
 * run time to read unit codes against the generated table. Implements:
 *   main  := "/" term | term
 *   term  := component (("." | "/") component)*          left-associative, equal precedence
 *   comp  := simpleUnit exponent? annotation? | annotation | integer factor | "(" term ")"
 * with the atom-first rule for prefixes (a symbol that is itself an atom is never split into a
 * prefix and an atom) and prefixes allowed only on metric atoms (the UCUM rule, which
 * @lhncbc/ucum-lhc does not enforce: it accepts "mmin" and "m%").
 */
import { DecError } from '../decimal/dec.ts';
import { R_ONE, rational, rDiv, rMul, type Rational } from '../decimal/exact.ts';

export interface AtomResolver {
  /** Any valid atom (drives the atom-first rule). */
  isAtom(code: string): boolean;
  /** May take a prefix. */
  isMetric(code: string): boolean;
  /** The decimal exponent of a prefix code, or undefined. */
  prefixExponent(prefix: string): number | undefined;
}

export interface UcumTerm {
  /** Prefix code ('' when none). */
  readonly prefix: string;
  /** Atom code ('' for a pure annotation such as "{tbl}"). */
  readonly atom: string;
  /** Integer exponent, sign included (division negates). */
  readonly exponent: number;
  /** Annotation text without braces, when present. */
  readonly annotation?: string;
}

export interface ParsedUnit {
  readonly terms: readonly UcumTerm[];
  /** Product of integer factors in the expression (e.g. "/20" gives 1/20). */
  readonly factor: Rational;
}

export type UnitSyntaxErrorCode = 'UNIT_SYNTAX' | 'UNIT_UNKNOWN_ATOM' | 'UNIT_PREFIX_NOT_ALLOWED';

export class UnitSyntaxError extends Error {
  readonly code: UnitSyntaxErrorCode;
  constructor(code: UnitSyntaxErrorCode, message: string) {
    super(message);
    this.name = 'UnitSyntaxError';
    this.code = code;
  }
}

const MAX_UNIT_LENGTH = 120;
const MAX_EXPONENT = 12;

class Reader {
  pos = 0;
  constructor(
    readonly text: string,
    readonly resolver: AtomResolver,
  ) {}

  peek(): string | undefined {
    return this.text[this.pos];
  }

  fail(message: string): never {
    throw new UnitSyntaxError('UNIT_SYNTAX', `"${this.text}" is not a valid UCUM unit: ${message}`);
  }
}

function negate(p: ParsedUnit): ParsedUnit {
  return { terms: p.terms.map((t) => ({ ...t, exponent: -t.exponent })), factor: rDiv(R_ONE, p.factor) };
}

function combine(a: ParsedUnit, b: ParsedUnit): ParsedUnit {
  return { terms: [...a.terms, ...b.terms], factor: rMul(a.factor, b.factor) };
}

function readAnnotation(r: Reader): string {
  // at '{'
  const close = r.text.indexOf('}', r.pos);
  if (close < 0) r.fail('unclosed annotation');
  const body = r.text.slice(r.pos + 1, close);
  if (body.includes('{')) r.fail('nested annotation');
  if (!/^[\x21-\x7a\x7c\x7e]*$/.test(body)) r.fail('annotation holds a character UCUM does not allow');
  r.pos = close + 1;
  return body;
}

function readSymbol(r: Reader): string {
  const start = r.pos;
  for (;;) {
    const c = r.peek();
    if (c === undefined || c === '.' || c === '/' || c === '(' || c === ')' || c === '{' || c === '}') break;
    if (c === '[') {
      const close = r.text.indexOf(']', r.pos);
      if (close < 0) r.fail('unclosed square bracket');
      r.pos = close + 1;
      continue;
    }
    if (c === ']') r.fail('unexpected "]"');
    if (c <= ' ' || c > '~') r.fail('it contains a character UCUM does not allow');
    r.pos += 1;
  }
  return r.text.slice(start, r.pos);
}

function splitPrefix(symbol: string, r: Reader): { prefix: string; atom: string } {
  if (r.resolver.isAtom(symbol)) return { prefix: '', atom: symbol };
  for (const len of [2, 1]) {
    const prefix = symbol.slice(0, len);
    const atom = symbol.slice(len);
    if (atom.length > 0 && r.resolver.prefixExponent(prefix) !== undefined && r.resolver.isAtom(atom)) {
      if (!r.resolver.isMetric(atom)) {
        throw new UnitSyntaxError('UNIT_PREFIX_NOT_ALLOWED', `"${r.text}": the prefix "${prefix}" cannot be used with "${atom}", which is not a metric unit`);
      }
      return { prefix, atom };
    }
  }
  throw new UnitSyntaxError('UNIT_UNKNOWN_ATOM', `"${r.text}": "${symbol}" is not a UCUM unit`);
}

function parseExponent(text: string, r: Reader): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n) || Math.abs(n) > MAX_EXPONENT) r.fail(`exponent ${text} is out of range`);
  return n;
}

function readComponent(r: Reader, depth: number): ParsedUnit {
  const c = r.peek();
  if (c === undefined) r.fail('a unit is missing');
  if (c === '(') {
    if (depth > 8) r.fail('too deeply nested');
    r.pos += 1;
    const inner = readTerm(r, depth + 1);
    if (r.peek() !== ')') r.fail('missing ")"');
    r.pos += 1;
    if (/[0-9+-]/.test(r.peek() ?? '')) r.fail('an exponent cannot follow a parenthesis (UCUM 1.9)');
    return inner;
  }
  if (c === '{') {
    const annotation = readAnnotation(r);
    return { terms: [{ prefix: '', atom: '', exponent: 1, annotation }], factor: R_ONE };
  }
  let parsed: ParsedUnit;
  const digits = /^[0-9]+/.exec(r.text.slice(r.pos))?.[0];
  if (digits !== undefined && (r.text[r.pos + digits.length] === '*' || r.text[r.pos + digits.length] === '^') && digits === '10') {
    // The special atoms "10*" and "10^", optionally with an exponent: 10*3, 10*-2.
    const atom = r.text.slice(r.pos, r.pos + 3);
    r.pos += 3;
    const exp = /^[+-]?[0-9]+/.exec(r.text.slice(r.pos))?.[0];
    let exponent = 1;
    if (exp !== undefined) {
      exponent = parseExponent(exp, r);
      r.pos += exp.length;
    }
    if (!r.resolver.isAtom(atom)) throw new UnitSyntaxError('UNIT_UNKNOWN_ATOM', `"${r.text}": "${atom}" is not a UCUM unit`);
    parsed = { terms: [{ prefix: '', atom, exponent }], factor: R_ONE };
  } else if (digits !== undefined && !/[A-Za-z[\]%'_*^]/.test(r.text[r.pos + digits.length] ?? '')) {
    // A positive integer factor, e.g. the 20 in "mL/20".
    r.pos += digits.length;
    try {
      parsed = { terms: [], factor: rational(BigInt(digits)) };
    } catch (e) {
      if (e instanceof DecError) r.fail('bad factor');
      throw e;
    }
    if (parsed.factor.num === 0n) r.fail('a factor of zero');
  } else {
    const symbol = readSymbol(r);
    if (symbol.length === 0) r.fail('a unit is missing');
    // Split a trailing exponent that is not inside square brackets.
    const m = /^(.*?[^0-9+-])([+-]?[0-9]+)$/.exec(symbol);
    let base = symbol;
    let exponent = 1;
    if (m !== null && m[1] !== undefined && m[2] !== undefined && !r.resolver.isAtom(symbol)) {
      base = m[1];
      exponent = parseExponent(m[2], r);
    }
    const { prefix, atom } = splitPrefix(base, r);
    parsed = { terms: [{ prefix, atom, exponent }], factor: R_ONE };
  }
  if (r.peek() === '{') {
    const annotation = readAnnotation(r);
    const [first, ...rest] = parsed.terms;
    parsed = first === undefined ? { terms: [{ prefix: '', atom: '', exponent: 1, annotation }], factor: parsed.factor } : { terms: [{ ...first, annotation }, ...rest], factor: parsed.factor };
  }
  return parsed;
}

function readTerm(r: Reader, depth: number): ParsedUnit {
  let acc = readComponent(r, depth);
  for (;;) {
    const c = r.peek();
    if (c === '.') {
      r.pos += 1;
      acc = combine(acc, readComponent(r, depth));
    } else if (c === '/') {
      r.pos += 1;
      acc = combine(acc, negate(readComponent(r, depth)));
    } else {
      return acc;
    }
  }
}

/** Parses a UCUM c/s unit expression into terms. Throws UnitSyntaxError. */
export function parseUcumSyntax(text: string, resolver: AtomResolver): ParsedUnit {
  if (typeof text !== 'string' || text.length === 0) throw new UnitSyntaxError('UNIT_SYNTAX', 'a unit code is required');
  if (text.length > MAX_UNIT_LENGTH) throw new UnitSyntaxError('UNIT_SYNTAX', 'the unit code is too long');
  const r = new Reader(text, resolver);
  let result: ParsedUnit;
  if (r.peek() === '/') {
    r.pos += 1;
    result = negate(readTerm(r, 0));
  } else {
    result = readTerm(r, 0);
  }
  if (r.pos !== text.length) r.fail(`unexpected "${text.slice(r.pos)}"`);
  return result;
}
