/**
 * Normalises a checked true/false expression (a branch guard, loop exit or decision) into a small
 * decidable form: single-input comparisons with constants, category/boolean tests, and/or/not.
 * The validator uses it to prove that branch conditions cover every case and never overlap
 * (outline 6.3). Anything else is OPAQUE (the validator then cannot decide and must say so).
 * Constants are converted exactly into the input's declared unit; an inexact conversion is OPAQUE.
 */
import { Dec } from '../decimal/dec.ts';
import { convertValue } from '../units/quantity.ts';
import { DIMENSIONLESS, parseUnit, sameDimension } from '../units/unit.ts';
import type { BinaryOp, Expr } from './ast.ts';
import type { CompiledExpression } from './compile.ts';

export type GuardComparison = '<' | '<=' | '>' | '>=' | '==' | '!=';

export type GuardFormula =
  | { readonly op: 'const'; readonly value: boolean }
  | { readonly op: 'not'; readonly arg: GuardFormula }
  | { readonly op: 'and'; readonly args: readonly GuardFormula[] }
  | { readonly op: 'or'; readonly args: readonly GuardFormula[] }
  /** input <cmp> constant, the constant expressed exactly in the input's declared unit. */
  | { readonly op: 'cmp'; readonly variable: string; readonly cmp: GuardComparison; readonly constant: string }
  /** input == value, for categories and booleans. */
  | { readonly op: 'is'; readonly variable: string; readonly value: string | boolean }
  | { readonly op: 'opaque'; readonly reason: string };

const FLIP: Readonly<Record<GuardComparison, GuardComparison>> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };

function constantOf(e: Expr): { value: Dec; unit: string | null } | undefined {
  if (e.type === 'Number') return { value: Dec.parse(e.text), unit: e.unit };
  if (e.type === 'Unary' && e.op === '-' && e.operand.type === 'Number') return { value: Dec.parse(e.operand.text).neg(), unit: e.operand.unit };
  return undefined;
}

function isComparison(op: BinaryOp): op is GuardComparison {
  return op === '<' || op === '<=' || op === '>' || op === '>=' || op === '==' || op === '!=';
}

function flatten(op: 'and' | 'or', parts: GuardFormula[]): GuardFormula {
  return { op, args: parts.flatMap((p) => (p.op === op ? p.args : [p])) };
}

export function toGuardFormula(program: CompiledExpression): GuardFormula {
  const decl = program.inputs;
  const walk = (e: Expr): GuardFormula => {
    switch (e.type) {
      case 'Bool':
        return { op: 'const', value: e.value };
      case 'Path': {
        const d = decl[e.path];
        return d?.kind === 'boolean' ? { op: 'is', variable: e.path, value: true } : { op: 'opaque', reason: `${e.path} is not a true/false input` };
      }
      case 'Unary':
        return e.op === '!' ? { op: 'not', arg: walk(e.operand) } : { op: 'opaque', reason: 'arithmetic in a condition' };
      case 'Binary': {
        if (e.op === '&&' || e.op === '||') return flatten(e.op === '&&' ? 'and' : 'or', [walk(e.left), walk(e.right)]);
        if (!isComparison(e.op)) return { op: 'opaque', reason: 'arithmetic in a condition' };
        let variable: Expr = e.left;
        let other: Expr = e.right;
        let cmp: GuardComparison = e.op;
        if (e.left.type !== 'Path' && e.right.type === 'Path') {
          variable = e.right;
          other = e.left;
          cmp = FLIP[e.op];
        }
        if (variable.type !== 'Path') return { op: 'opaque', reason: 'the comparison does not compare an input with a constant' };
        const d = decl[variable.path];
        if (d === undefined) return { op: 'opaque', reason: `${variable.path} is not declared` };
        const kind = d.kind ?? 'quantity';
        if ((kind === 'boolean' && other.type === 'Bool') || (kind === 'category' && other.type === 'String')) {
          const is: GuardFormula = { op: 'is', variable: variable.path, value: other.value };
          if (cmp === '==') return is;
          if (cmp === '!=') return { op: 'not', arg: is };
          return { op: 'opaque', reason: 'ordering of categories or true/false values' };
        }
        const c = constantOf(other);
        if (kind !== 'quantity' || c === undefined || d.unit === undefined) return { op: 'opaque', reason: 'the comparison does not compare an input with a constant' };
        const target = parseUnit(d.tag === 'w/v' && d.unit === '%' ? 'g/dL' : d.unit);
        const from = c.unit === null ? DIMENSIONLESS : parseUnit(c.unit);
        if (!sameDimension(from, target)) return { op: 'opaque', reason: 'units differ' };
        const r = convertValue(c.value, from, target);
        if (r.conversion !== null && !r.conversion.exact) return { op: 'opaque', reason: `the constant cannot be expressed exactly in ${target.code}` };
        return { op: 'cmp', variable: variable.path, cmp, constant: r.value.toString() };
      }
      case 'Conditional':
        return { op: 'opaque', reason: 'a conditional inside a condition' };
      default:
        return { op: 'opaque', reason: 'not a condition on inputs' };
    }
  };
  if (program.resultType.kind !== 'boolean') return { op: 'opaque', reason: 'not a true/false expression' };
  return walk(program.core.ast);
}
