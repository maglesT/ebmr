/**
 * Abstract syntax tree of the expression language. Every node carries its source span
 * (character offsets, end exclusive). Number literals keep their text exactly as written (the
 * number of decimals matters for limits and for canonical printing).
 */
import type { Span } from '../diagnostics.ts';

export type BinaryOp = '+' | '-' | '*' | '/' | '<' | '<=' | '>' | '>=' | '==' | '!=' | '&&' | '||';
export type UnaryOp = '-' | '!';

export interface NumberLiteral {
  readonly type: 'Number';
  /** Decimal literal as written, e.g. "12.50". */
  readonly text: string;
  /** UCUM code written in brackets after the number, e.g. "mg" for 12.5 [mg]; null for a plain number. */
  readonly unit: string | null;
  readonly span: Span;
}

/** A bare unit in brackets, e.g. [min]; only valid as the target of convert(). */
export interface UnitLiteral {
  readonly type: 'Unit';
  readonly unit: string;
  readonly span: Span;
}

export interface StringLiteral {
  readonly type: 'String';
  readonly value: string;
  readonly span: Span;
}

export interface BoolLiteral {
  readonly type: 'Bool';
  readonly value: boolean;
  readonly span: Span;
}

/** A declared input, e.g. `assay` or `lot1.assay`. */
export interface PathRef {
  readonly type: 'Path';
  readonly path: string;
  readonly span: Span;
}

export interface UnaryExpr {
  readonly type: 'Unary';
  readonly op: UnaryOp;
  readonly operand: Expr;
  readonly span: Span;
}

export interface BinaryExpr {
  readonly type: 'Binary';
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
  readonly span: Span;
}

export interface ConditionalExpr {
  readonly type: 'Conditional';
  readonly test: Expr;
  readonly consequent: Expr;
  readonly alternate: Expr;
  readonly span: Span;
}

/** A call of a function of the closed library. */
export interface CallExpr {
  readonly type: 'Call';
  readonly callee: string;
  readonly args: readonly Expr[];
  readonly span: Span;
}

export type Expr = NumberLiteral | UnitLiteral | StringLiteral | BoolLiteral | PathRef | UnaryExpr | BinaryExpr | ConditionalExpr | CallExpr;

/** The same tree without spans (structural comparison in tests and the round-trip property). */
export function stripSpans(e: Expr): unknown {
  switch (e.type) {
    case 'Number':
      return { type: e.type, text: e.text, unit: e.unit };
    case 'Unit':
      return { type: e.type, unit: e.unit };
    case 'String':
    case 'Bool':
      return { type: e.type, value: e.value };
    case 'Path':
      return { type: e.type, path: e.path };
    case 'Unary':
      return { type: e.type, op: e.op, operand: stripSpans(e.operand) };
    case 'Binary':
      return { type: e.type, op: e.op, left: stripSpans(e.left), right: stripSpans(e.right) };
    case 'Conditional':
      return { type: e.type, test: stripSpans(e.test), consequent: stripSpans(e.consequent), alternate: stripSpans(e.alternate) };
    case 'Call':
      return { type: e.type, callee: e.callee, args: e.args.map(stripSpans) };
  }
}

/** Every input path an expression reads, sorted (code-point order), without duplicates. */
export function referencedPaths(e: Expr): string[] {
  const out = new Set<string>();
  const walk = (x: Expr): void => {
    switch (x.type) {
      case 'Path':
        out.add(x.path);
        return;
      case 'Unary':
        walk(x.operand);
        return;
      case 'Binary':
        walk(x.left);
        walk(x.right);
        return;
      case 'Conditional':
        walk(x.test);
        walk(x.consequent);
        walk(x.alternate);
        return;
      case 'Call':
        x.args.forEach(walk);
        return;
      default:
        return;
    }
  };
  walk(e);
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
