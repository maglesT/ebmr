/**
 * Parser and printer (brief A1 item 3): CEL-like syntax, Pratt precedence, spans, and no
 * statements, loops, assignment or user-defined functions (DI-33: no custom-script escape hatch).
 */
import { describe, expect, it } from 'vitest';
import { stripSpans, type Expr } from '../src/lang/ast.ts';
import { MAX_NESTING_DEPTH, MAX_SOURCE_LENGTH, parse } from '../src/lang/parser.ts';
import { print } from '../src/lang/printer.ts';

function ast(source: string): Expr {
  const r = parse(source);
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.message).join('; '));
  return r.ast;
}

function canonical(source: string): string {
  return print(ast(source));
}

function error(source: string): { code: string; message: string; start?: number; end?: number } {
  const r = parse(source);
  if (r.ok) throw new Error(`expected a syntax error for ${source}`);
  const d = r.diagnostics[0];
  if (d === undefined) throw new Error('no diagnostic');
  return { code: d.code, message: d.message, ...(d.start === undefined ? {} : { start: d.start }), ...(d.end === undefined ? {} : { end: d.end }) };
}

describe('parser', () => {
  it('follows arithmetic precedence and left associativity', () => {
    expect(canonical('a+b*c')).toBe('a + b * c');
    expect(canonical('(a+b)*c')).toBe('(a + b) * c');
    expect(canonical('a-b-c')).toBe('a - b - c');
    expect(canonical('a-(b-c)')).toBe('a - (b - c)');
    expect(canonical('a/b/c')).toBe('a / b / c');
    expect(canonical('a/(b*c)')).toBe('a / (b * c)');
    expect(canonical('-a*b')).toBe('-a * b');
    expect(canonical('-(a*b)')).toBe('-(a * b)');
    expect(canonical('!a && b || c')).toBe('!a && b || c');
    expect(canonical('a || b && c')).toBe('a || b && c');
    expect(canonical('(a || b) && c')).toBe('(a || b) && c');
  });

  it('reads number literals with units, bare units, strings, booleans and dotted input paths', () => {
    expect(stripSpans(ast('12.50 [mg]'))).toEqual({ type: 'Number', text: '12.50', unit: 'mg' });
    expect(stripSpans(ast('3 [mm[Hg]]'))).toEqual({ type: 'Number', text: '3', unit: 'mm[Hg]' });
    expect(stripSpans(ast('1e-6'))).toEqual({ type: 'Number', text: '1e-6', unit: null });
    expect(stripSpans(ast('convert(t, [min])'))).toEqual({ type: 'Call', callee: 'convert', args: [{ type: 'Path', path: 't' }, { type: 'Unit', unit: 'min' }] });
    expect(stripSpans(ast('coating == "FILM"'))).toMatchObject({ type: 'Binary', op: '==', right: { type: 'String', value: 'FILM' } });
    expect(stripSpans(ast('"a \\" b"'))).toEqual({ type: 'String', value: 'a " b' });
    expect(stripSpans(ast('lot1.assay'))).toEqual({ type: 'Path', path: 'lot1.assay' });
    expect(stripSpans(ast('true'))).toEqual({ type: 'Bool', value: true });
  });

  it('parses the conditional expression, right-associative', () => {
    expect(canonical('a ? b : c ? d : e')).toBe('a ? b : c ? d : e');
    expect(canonical('(a ? b : c) ? d : e')).toBe('(a ? b : c) ? d : e');
    expect(stripSpans(ast('x > 1 ? 2 : 3'))).toMatchObject({ type: 'Conditional', test: { type: 'Binary', op: '>' } });
  });

  it('keeps source spans for diagnostics', () => {
    const e = ast('yield(a, b) + 1');
    expect(e.span).toEqual({ start: 0, end: 15 });
    if (e.type !== 'Binary' || e.left.type !== 'Call') throw new Error('shape');
    expect(e.left.span).toEqual({ start: 0, end: 11 });
    expect(e.left.args[1]?.span).toEqual({ start: 9, end: 10 });
    expect(error('a + * b')).toMatchObject({ start: 4, end: 5 });
  });

  it('refuses chained comparisons', () => {
    expect(error('a < b < c').code).toBe('EXPR-SYN-012');
    expect(error('a == b != c').code).toBe('EXPR-SYN-012');
    expect(canonical('(a < b) == c')).toBe('a < b == c');
  });

  it('[DI-33] has no assignment, statements, blocks, loops, lambdas or user-defined functions', () => {
    expect(error('x = 1').code).toBe('EXPR-SYN-006');
    expect(error('a; b').code).toBe('EXPR-SYN-006');
    expect(error('{ return 1 }').code).toBe('EXPR-SYN-006');
    for (const src of ['function f(x) 1', 'let x', 'for (i) x', 'while(true)', 'def f', 'lambda(x)', 'x in xs', 'eval("1")', 'import x', 'if (a) b', 'return 1', 'new X']) {
      expect(error(src).code, src).toBe('EXPR-SYN-020');
    }
    expect(error('weights.map(w)').code).toBe('EXPR-SYN-016');
  });

  it('gives plain messages for common mistakes', () => {
    expect(error('98.5%').message).toMatch(/98\.5 \[%\]/);
    expect(error('a & b').message).toMatch(/&&/);
    expect(error('x [mg]').code).toBe('EXPR-SYN-017');
    expect(error('12mg').code).toBe('EXPR-SYN-003');
    expect(error('[mg').code).toBe('EXPR-SYN-004');
    expect(error('[m g]').code).toBe('EXPR-SYN-004');
    expect(error('"open').code).toBe('EXPR-SYN-005');
    expect(error('f(a,').code).toBe('EXPR-SYN-014');
    expect(error('a b').code).toBe('EXPR-SYN-011');
    expect(error('#').code).toBe('EXPR-SYN-001');
  });

  it('bounds the source length and the nesting depth', () => {
    expect(error('1'.repeat(MAX_SOURCE_LENGTH + 1)).code).toBe('EXPR-SYN-002');
    expect(error(`${'('.repeat(MAX_NESTING_DEPTH + 5)}1${')'.repeat(MAX_NESTING_DEPTH + 5)}`).code).toBe('EXPR-SYN-002');
    expect(error(`${'-'.repeat(MAX_NESTING_DEPTH + 5)}1`).code).toBe('EXPR-SYN-002');
    expect(parse(`${'('.repeat(20)}1${')'.repeat(20)}`).ok).toBe(true);
  });

  it('prints the canonical form, which parses back to the same tree', () => {
    for (const src of ['potency_adjusted_quantity(lc*n,f,0[%],assay_as_is_dried(a,l))', '--x', '!(a&&b)', 'a-(-b)', '(a+b)-(c+d)', 'x<=1[kg]||y!=2']) {
      const p = canonical(src);
      expect(stripSpans(ast(p)), src).toEqual(stripSpans(ast(src)));
      expect(canonical(p)).toBe(p);
    }
  });
});
