/**
 * Lexer. Tokens: decimal numbers, [unit] codes (balanced brackets, since UCUM codes contain
 * brackets, e.g. [mm[Hg]]), "strings", identifiers and a fixed set of operators. Anything else is a
 * syntax error; characters that suggest statements, assignment or blocks get a specific message,
 * because the language has none of them (DI-33: no custom-script escape hatch).
 */
import { diagnostic, type Diagnostic } from '../diagnostics.ts';

export type TokenType = 'number' | 'unit' | 'string' | 'ident' | 'punct' | 'eof';

export interface Token {
  readonly type: TokenType;
  /** Number text, unit code (without brackets), string value, identifier or operator. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

export class SyntaxFailure extends Error {
  readonly diagnostic: Diagnostic;
  constructor(d: Diagnostic) {
    super(d.message);
    this.diagnostic = d;
  }
}

export function syntaxError(code: string, text: string, start: number, end: number): SyntaxFailure {
  return new SyntaxFailure(diagnostic(code, 'ERROR', text, { start, end }));
}

const PUNCT2 = ['<=', '>=', '==', '!=', '&&', '||'];
const PUNCT1 = ['(', ')', ',', '.', '?', ':', '+', '-', '*', '/', '!', '<', '>'];
const MAX_STRING = 200;
const MAX_TOKENS = 4000;

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

function isIdentStart(c: string | undefined): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
}

function isIdentPart(c: string | undefined): boolean {
  return isIdentStart(c) || isDigit(c);
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    if (tokens.length > MAX_TOKENS) throw syntaxError('EXPR-SYN-002', 'The expression is too long', i, n);
    const c = source[i] ?? '';
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    const start = i;
    if (isDigit(c)) {
      while (isDigit(source[i])) i += 1;
      if (source[i] === '.' && isDigit(source[i + 1])) {
        i += 1;
        while (isDigit(source[i])) i += 1;
      }
      if ((source[i] === 'e' || source[i] === 'E') && (isDigit(source[i + 1]) || ((source[i + 1] === '+' || source[i + 1] === '-') && isDigit(source[i + 2])))) {
        i += 2;
        while (isDigit(source[i])) i += 1;
      }
      if (isIdentStart(source[i])) throw syntaxError('EXPR-SYN-003', `A number must be followed by an operator or a unit in brackets, not "${source[i] ?? ''}"`, start, i + 1);
      tokens.push({ type: 'number', value: source.slice(start, i), start, end: i });
      continue;
    }
    if (c === '[') {
      let depth = 0;
      while (i < n) {
        const ch = source[i];
        if (ch === '[') depth += 1;
        else if (ch === ']') {
          depth -= 1;
          if (depth === 0) break;
        } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
          throw syntaxError('EXPR-SYN-004', 'A unit code in brackets cannot contain spaces', start, i + 1);
        }
        i += 1;
      }
      if (i >= n) throw syntaxError('EXPR-SYN-004', 'The unit in brackets is not closed with "]"', start, n);
      const code = source.slice(start + 1, i);
      i += 1;
      if (code.length === 0) throw syntaxError('EXPR-SYN-004', 'Empty unit brackets', start, i);
      tokens.push({ type: 'unit', value: code, start, end: i });
      continue;
    }
    if (c === '"') {
      i += 1;
      let value = '';
      for (;;) {
        const ch = source[i];
        if (ch === undefined) throw syntaxError('EXPR-SYN-005', 'The text in quotes is not closed', start, n);
        if (ch === '"') {
          i += 1;
          break;
        }
        if (ch === '\\') {
          const next = source[i + 1];
          if (next !== '"' && next !== '\\') throw syntaxError('EXPR-SYN-005', 'Only \\" and \\\\ escapes are allowed in text', i, i + 2);
          value += next;
          i += 2;
          continue;
        }
        if (ch < ' ') throw syntaxError('EXPR-SYN-005', 'Text in quotes cannot contain line breaks or control characters', i, i + 1);
        value += ch;
        i += 1;
      }
      if (value.length > MAX_STRING) throw syntaxError('EXPR-SYN-005', 'The text in quotes is too long', start, i);
      tokens.push({ type: 'string', value, start, end: i });
      continue;
    }
    if (isIdentStart(c)) {
      while (isIdentPart(source[i])) i += 1;
      tokens.push({ type: 'ident', value: source.slice(start, i), start, end: i });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (PUNCT2.includes(two)) {
      tokens.push({ type: 'punct', value: two, start, end: i + 2 });
      i += 2;
      continue;
    }
    if (PUNCT1.includes(c)) {
      tokens.push({ type: 'punct', value: c, start, end: i + 1 });
      i += 1;
      continue;
    }
    if (c === '=') throw syntaxError('EXPR-SYN-006', 'Assignment is not supported; use == to compare', start, start + 1);
    if (c === ';') throw syntaxError('EXPR-SYN-006', 'An expression cannot contain statements (";")', start, start + 1);
    if (c === '{' || c === '}') throw syntaxError('EXPR-SYN-006', 'Blocks and user-defined functions are not supported', start, start + 1);
    if (c === '%') throw syntaxError('EXPR-SYN-006', 'Write percentages with a unit in brackets, e.g. 98.5 [%]', start, start + 1);
    if (c === '&' || c === '|') throw syntaxError('EXPR-SYN-006', 'Use && and || for "and" and "or"', start, start + 1);
    throw syntaxError('EXPR-SYN-001', `Unexpected character "${c}"`, start, start + 1);
  }
  tokens.push({ type: 'eof', value: '', start: n, end: n });
  return tokens;
}
