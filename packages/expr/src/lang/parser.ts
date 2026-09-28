/**
 * Hand-written Pratt parser (ADR 0005 decision 1). CEL-like syntax:
 *
 *   expr     := or ("?" expr ":" expr)?                      conditional, right-associative
 *   or       := and ("||" and)*
 *   and      := eq ("&&" eq)*
 *   eq       := rel (("==" | "!=") rel)?                     not chainable
 *   rel      := add (("<" | "<=" | ">" | ">=") add)?         not chainable (a < b < c is refused)
 *   add      := mul (("+" | "-") mul)*
 *   mul      := unary (("*" | "/") unary)*
 *   unary    := ("-" | "!") unary | primary
 *   primary  := number [unit]? | [unit] | "string" | true | false | path | name "(" args ")" | "(" expr ")"
 *   path     := ident ("." ident)*
 *
 * No assignment, statements, loops, lambdas or user-defined functions exist in the grammar; the
 * words that would introduce them are reserved and refused with a plain message (DI-33).
 */
import type { Diagnostic } from '../diagnostics.ts';
import type { BinaryOp, Expr } from './ast.ts';
import { SyntaxFailure, syntaxError, tokenize, type Token } from './lexer.ts';

export const MAX_SOURCE_LENGTH = 4000;
export const MAX_NESTING_DEPTH = 64;

const RESERVED = new Set([
  'null',
  'let',
  'var',
  'const',
  'function',
  'def',
  'lambda',
  'return',
  'for',
  'while',
  'do',
  'loop',
  'repeat',
  'if',
  'else',
  'then',
  'import',
  'eval',
  'this',
  'in',
  'new',
  'class',
  'macro',
  'script',
]);

const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
};
/** Operators that cannot be chained (a < b < c, a == b == c). */
const NON_ASSOCIATIVE = new Set([3, 4]);

export type ParseResult = { ok: true; ast: Expr } | { ok: false; diagnostics: Diagnostic[] };

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(
    private readonly tokens: readonly Token[],
    private readonly source: string,
  ) {}

  private peek(): Token {
    return this.tokens[this.pos] ?? { type: 'eof', value: '', start: this.source.length, end: this.source.length };
  }

  private next(): Token {
    const t = this.peek();
    this.pos += 1;
    return t;
  }

  private isPunct(value: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.value === value;
  }

  private reservedHere(t: Token): void {
    if (t.type === 'ident' && RESERVED.has(t.value)) {
      throw syntaxError('EXPR-SYN-020', `"${t.value}" is reserved: the expression language has no statements, loops, variables or user-defined functions`, t.start, t.end);
    }
  }

  private expectPunct(value: string, what: string): Token {
    const t = this.peek();
    if (t.type !== 'punct' || t.value !== value) {
      this.reservedHere(t);
      throw syntaxError('EXPR-SYN-010', `Expected ${what}`, t.start, Math.max(t.end, t.start + 1));
    }
    return this.next();
  }

  private enter(t: Token): void {
    this.depth += 1;
    if (this.depth > MAX_NESTING_DEPTH) throw syntaxError('EXPR-SYN-002', 'The expression is nested too deeply', t.start, t.end);
  }

  private leave(): void {
    this.depth -= 1;
  }

  parseTop(): Expr {
    const e = this.parseExpr();
    const t = this.peek();
    this.reservedHere(t);
    if (t.type !== 'eof') throw syntaxError('EXPR-SYN-011', `Unexpected "${t.value}" after the end of the expression`, t.start, t.end);
    return e;
  }

  parseExpr(): Expr {
    const first = this.peek();
    this.enter(first);
    const test = this.parseBinary(1);
    let result = test;
    if (this.isPunct('?')) {
      this.next();
      const consequent = this.parseExpr();
      this.expectPunct(':', '":" of the conditional expression');
      const alternate = this.parseExpr();
      result = { type: 'Conditional', test, consequent, alternate, span: { start: test.span.start, end: alternate.span.end } };
    }
    this.leave();
    return result;
  }

  private parseBinary(minPrecedence: number): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const prec = t.type === 'punct' ? BINARY_PRECEDENCE[t.value] : undefined;
      if (prec === undefined || prec < minPrecedence) return left;
      this.next();
      const right = this.parseBinary(prec + 1);
      left = { type: 'Binary', op: t.value as BinaryOp, left, right, span: { start: left.span.start, end: right.span.end } };
      if (NON_ASSOCIATIVE.has(prec)) {
        const after = this.peek();
        if (after.type === 'punct' && BINARY_PRECEDENCE[after.value] === prec) {
          throw syntaxError('EXPR-SYN-012', 'Comparisons cannot be chained; combine them with && (e.g. a <= x && x <= b)', after.start, after.end);
        }
      }
    }
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.type === 'punct' && (t.value === '-' || t.value === '!')) {
      this.next();
      this.enter(t);
      const operand = this.parseUnary();
      this.leave();
      return { type: 'Unary', op: t.value, operand, span: { start: t.start, end: operand.span.end } };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.next();
    switch (t.type) {
      case 'number': {
        const u = this.peek();
        if (u.type === 'unit') {
          this.next();
          return { type: 'Number', text: t.value, unit: u.value, span: { start: t.start, end: u.end } };
        }
        return { type: 'Number', text: t.value, unit: null, span: { start: t.start, end: t.end } };
      }
      case 'unit':
        return { type: 'Unit', unit: t.value, span: { start: t.start, end: t.end } };
      case 'string':
        return { type: 'String', value: t.value, span: { start: t.start, end: t.end } };
      case 'ident':
        return this.parseIdent(t);
      case 'punct':
        if (t.value === '(') {
          this.enter(t);
          const inner = this.parseExpr();
          this.leave();
          const close = this.expectPunct(')', '")"');
          // Parentheses do not create a node; widen the span so diagnostics point at the group.
          return { ...inner, span: { start: t.start, end: close.end } };
        }
        throw syntaxError('EXPR-SYN-013', `Unexpected "${t.value}"`, t.start, t.end);
      case 'eof':
        throw syntaxError('EXPR-SYN-014', 'The expression ends too early', t.start, t.end);
    }
  }

  private parseIdent(t: Token): Expr {
    this.reservedHere(t);
    if (t.value === 'true' || t.value === 'false') return { type: 'Bool', value: t.value === 'true', span: { start: t.start, end: t.end } };
    if (this.isPunct('(')) {
      this.next();
      const args: Expr[] = [];
      if (!this.isPunct(')')) {
        for (;;) {
          args.push(this.parseExpr());
          if (this.isPunct(',')) {
            this.next();
            continue;
          }
          break;
        }
      }
      const close = this.expectPunct(')', '")" or "," in the argument list');
      return { type: 'Call', callee: t.value, args, span: { start: t.start, end: close.end } };
    }
    let path = t.value;
    let end = t.end;
    while (this.isPunct('.')) {
      this.next();
      const part = this.next();
      if (part.type !== 'ident') throw syntaxError('EXPR-SYN-015', 'Expected a name after "."', part.start, Math.max(part.end, part.start + 1));
      if (RESERVED.has(part.value)) throw syntaxError('EXPR-SYN-020', `"${part.value}" is reserved`, part.start, part.end);
      path += `.${part.value}`;
      end = part.end;
    }
    if (this.isPunct('(')) {
      const p = this.peek();
      throw syntaxError('EXPR-SYN-016', 'Method calls are not supported; call a library function by name, e.g. mean(weights)', p.start, p.end);
    }
    const u = this.peek();
    if (u.type === 'unit') throw syntaxError('EXPR-SYN-017', 'A unit in brackets can follow only a number literal; use convert(x, [unit]) to change units', u.start, u.end);
    return { type: 'Path', path, span: { start: t.start, end } };
  }
}

/** Parses an expression. Returns the tree or the first syntax error (with its span). */
export function parse(source: string): ParseResult {
  if (typeof source !== 'string') return { ok: false, diagnostics: [syntaxError('EXPR-SYN-001', 'The expression must be text', 0, 0).diagnostic] };
  if (source.length > MAX_SOURCE_LENGTH) {
    return { ok: false, diagnostics: [syntaxError('EXPR-SYN-002', `The expression is longer than ${MAX_SOURCE_LENGTH} characters`, 0, source.length).diagnostic] };
  }
  try {
    const tokens = tokenize(source);
    return { ok: true, ast: new Parser(tokens, source).parseTop() };
  } catch (e) {
    if (e instanceof SyntaxFailure) return { ok: false, diagnostics: [e.diagnostic] };
    throw e;
  }
}
