/**
 * Evaluator properties (brief A1 tests: "evaluation never returns NaN"; ADR 0005: compare the
 * evaluator with an exact-rational reference).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Dec, DecError } from '../src/decimal/dec.ts';
import { fromRational, rAdd, rDiv, rMul, rSub, toRational } from '../src/decimal/exact.ts';
import { tryEvaluate } from '../src/evidence/record.ts';
import type { Expr } from '../src/lang/ast.ts';
import { compile } from '../src/lang/compile.ts';
import { print } from '../src/lang/printer.ts';
import { decimalText } from './support/arbitraries.ts';

const span = { start: 0, end: 0 };
const VARS = ['a', 'b', 'c'] as const;

/** Random arithmetic over plain numbers: + - * / unary minus, literals and inputs. */
const arith = fc.letrec<{ e: Expr }>((tie) => ({
  e: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constantFrom(...VARS).map((path): Expr => ({ type: 'Path', path, span })),
    decimalText(8, 4)
      .filter((t) => !t.startsWith('-'))
      .map((text): Expr => ({ type: 'Number', text, unit: null, span })),
    fc.record({ type: fc.constant('Unary' as const), op: fc.constant('-' as const), operand: tie('e'), span: fc.constant(span) }),
    fc.record({ type: fc.constant('Binary' as const), op: fc.constantFrom('+' as const, '-' as const, '*' as const, '/' as const), left: tie('e'), right: tie('e'), span: fc.constant(span) }),
  ),
})).e;

/** Reference: each operation is the exact rational result, rounded once to 34 digits. */
function reference(e: Expr, env: Record<string, Dec>): Dec {
  switch (e.type) {
    case 'Number':
      return Dec.parse(e.text);
    case 'Path': {
      const v = env[e.path];
      if (v === undefined) throw new Error('env');
      return v;
    }
    case 'Unary':
      return reference(e.operand, env).neg();
    case 'Binary': {
      const l = toRational(reference(e.left, env));
      const r = toRational(reference(e.right, env));
      if (e.op === '/' && r.num === 0n) throw new DecError('DEC_DIVISION_BY_ZERO', 'x');
      const x = e.op === '+' ? rAdd(l, r) : e.op === '-' ? rSub(l, r) : e.op === '*' ? rMul(l, r) : rDiv(l, r);
      return fromRational(x).value;
    }
    default:
      throw new Error('unsupported');
  }
}

const inputs = { a: { unit: '1' }, b: { unit: '1' }, c: { unit: '1' } };

describe('evaluator properties', () => {
  it('[DI-33] arithmetic equals the exact-rational reference (one correct rounding per operation), and never yields NaN', () => {
    fc.assert(
      fc.property(arith, decimalText(10, 5), decimalText(10, 5), decimalText(10, 5), (tree, a, b, c) => {
        const source = print(tree);
        const compiled = compile(source, { inputs, role: 'calculation' });
        if (!compiled.ok) {
          // Only constant formulas (INV-25) and literal division by zero are refused.
          expect(compiled.diagnostics.every((d) => d.code === 'EXPR-INV25-001' || d.code === 'EXPR-TYP-020' || d.code === 'EXPR-DECL-010')).toBe(true);
          return;
        }
        const env = { a: Dec.parse(a), b: Dec.parse(b), c: Dec.parse(c) };
        let expected: Dec | 'DIVISION_BY_ZERO' | 'NUMERIC_RANGE';
        try {
          expected = reference(tree, env);
        } catch (e) {
          if (!(e instanceof DecError)) throw e;
          expected = e.code === 'DEC_DIVISION_BY_ZERO' ? 'DIVISION_BY_ZERO' : 'NUMERIC_RANGE';
        }
        const r = tryEvaluate(compiled.program, { a: { value: a, source: 't' }, b: { value: b, source: 't' }, c: { value: c, source: 't' } });
        if (r.ok) {
          expect(r.record.output.value).not.toMatch(/NaN|Infinity/);
          expect(Dec.isValid(r.record.output.value)).toBe(true);
          expect(expected).toBeInstanceOf(Dec);
          expect(r.record.output.value).toBe((expected as Dec).toString());
        } else {
          expect(r.error.code).toBe(expected);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('[DI-33] library statistics do not depend on the order of the recorded values', () => {
    const p = compile('mean(w) + sd(w) + rsd(w) * 1 [mg/%] + sum(w) / count(w) + max(w) - min(w)', { inputs: { w: { kind: 'series', unit: 'mg', maxLength: 50 } } });
    if (!p.ok) throw new Error(p.diagnostics.map((d) => d.message).join('; '));
    const positive = decimalText(12, 3).filter((t) => !t.startsWith('-') && !Dec.parse(t).isZero());
    fc.assert(
      fc.property(fc.array(positive, { minLength: 2, maxLength: 50 }), fc.integer({ min: 0, max: 1000 }), (values, k) => {
        const rotated = [...values.slice(k % values.length), ...values.slice(0, k % values.length)].reverse();
        const r1 = tryEvaluate(p.program, { w: { values, source: 't' } });
        const r2 = tryEvaluate(p.program, { w: { values: rotated, source: 't' } });
        expect(r1.ok && r2.ok).toBe(true);
        if (r1.ok && r2.ok) expect(r1.record.output.value).toBe(r2.record.output.value);
      }),
      { numRuns: 150 },
    );
  });

  it('[DI-33] evaluation is deterministic: the same inputs give the same record and hash', () => {
    const p = compile('potency_adjusted_quantity(q, f, ov, assay_as_is_dried(a, l))', {
      inputs: { q: { unit: 'kg' }, f: { unit: '1' }, ov: { unit: '%' }, a: { unit: '%', tag: 'w/w' }, l: { unit: '%', tag: 'lod' } },
    });
    if (!p.ok) throw new Error('compile');
    const pct = fc.integer({ min: 1, max: 999 }).map((n) => `${String(n)}e-1`);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99999 }), pct, pct, (q, a, l) => {
        const values = { q: { value: `${String(q)}e-3`, source: 't' }, f: { value: '1.034082772447372189603322354288988', source: 't' }, ov: { value: '0', source: 't' }, a: { value: a, source: 't' }, l: { value: l, source: 't' } };
        const r1 = tryEvaluate(p.program, values);
        const r2 = tryEvaluate(p.program, values);
        expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
      }),
      { numRuns: 100 },
    );
  });
});
