/**
 * Round-trip law of the parser and the canonical printer (brief A1 tests: "parser round-trip
 * print/parse"): for every tree, parse(print(tree)) is the same tree and printing is idempotent.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { stripSpans, type BinaryOp, type Expr } from '../src/lang/ast.ts';
import { parse } from '../src/lang/parser.ts';
import { print } from '../src/lang/printer.ts';

const span = { start: 0, end: 0 };
const ident = fc.stringMatching(/^[a-z_][a-z0-9_]{0,6}$/).filter((s) => !['true', 'false', 'null', 'let', 'var', 'const', 'function', 'def', 'lambda', 'return', 'for', 'while', 'do', 'loop', 'repeat', 'if', 'else', 'then', 'import', 'eval', 'this', 'in', 'new', 'class', 'macro', 'script'].includes(s));
const numberText = fc.oneof(
  fc.integer({ min: 0, max: 100000 }).map(String),
  fc.tuple(fc.integer({ min: 0, max: 9999 }), fc.stringMatching(/^[0-9]{1,5}$/)).map(([a, b]) => `${String(a)}.${b}`),
  fc.tuple(fc.integer({ min: 1, max: 99 }), fc.integer({ min: -9, max: 9 })).map(([a, e]) => `${String(a)}e${String(e)}`),
);
const unit = fc.constantFrom('mg', 'kg', '%', 'mL', 'mm[Hg]', 'Cel', 'g/mL', '{tbl}', "[in_i'H2O]");
const binaryOp = fc.constantFrom<BinaryOp>('+', '-', '*', '/', '<', '<=', '>', '>=', '==', '!=', '&&', '||');

const tree = fc.letrec<{ expr: Expr }>((tie) => ({
  expr: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.record({ type: fc.constant('Number' as const), text: numberText, unit: fc.option(unit, { nil: null }), span: fc.constant(span) }),
    fc.record({ type: fc.constant('Path' as const), path: fc.array(ident, { minLength: 1, maxLength: 3 }).map((p) => p.join('.')), span: fc.constant(span) }),
    fc.record({ type: fc.constant('Bool' as const), value: fc.boolean(), span: fc.constant(span) }),
    fc.record({ type: fc.constant('String' as const), value: fc.string({ maxLength: 8 }).filter((s) => !/[\x00-\x1f]/.test(s)), span: fc.constant(span) }),
    fc.record({ type: fc.constant('Unary' as const), op: fc.constantFrom('-' as const, '!' as const), operand: tie('expr'), span: fc.constant(span) }),
    fc.record({ type: fc.constant('Binary' as const), op: binaryOp, left: tie('expr'), right: tie('expr'), span: fc.constant(span) }),
    fc.record({ type: fc.constant('Conditional' as const), test: tie('expr'), consequent: tie('expr'), alternate: tie('expr'), span: fc.constant(span) }),
    fc.record({ type: fc.constant('Call' as const), callee: ident, args: fc.array(tie('expr'), { maxLength: 3 }), span: fc.constant(span) }),
    fc.record({ type: fc.constant('Unit' as const), unit, span: fc.constant(span) }),
  ),
})).expr;

/** Chained non-associative comparisons are not in the grammar; the printer parenthesises them. */
describe('parser and printer', () => {
  it('parse(print(tree)) gives back the tree, and printing is idempotent', () => {
    fc.assert(
      fc.property(tree, (t) => {
        const text = print(t);
        const r = parse(text);
        if (!r.ok) throw new Error(`${text}: ${r.diagnostics[0]?.message ?? ''}`);
        expect(stripSpans(r.ast)).toEqual(stripSpans(t));
        expect(print(r.ast)).toBe(text);
      }),
      { numRuns: 500 },
    );
  });

  it('spans of a parsed tree lie within the source and nest', () => {
    fc.assert(
      fc.property(tree, (t) => {
        const text = print(t);
        const r = parse(text);
        if (!r.ok) return;
        const check = (e: Expr, outer: { start: number; end: number }): void => {
          expect(e.span.start).toBeGreaterThanOrEqual(outer.start);
          expect(e.span.end).toBeLessThanOrEqual(outer.end);
          const kids: Expr[] = e.type === 'Unary' ? [e.operand] : e.type === 'Binary' ? [e.left, e.right] : e.type === 'Conditional' ? [e.test, e.consequent, e.alternate] : e.type === 'Call' ? [...e.args] : [];
          for (const k of kids) check(k, e.span);
        };
        check(r.ast, { start: 0, end: text.length });
      }),
      { numRuns: 200 },
    );
  });
});
