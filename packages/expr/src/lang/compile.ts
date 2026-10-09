/**
 * compile(): parse -> type/unit/tag check -> cost bound -> an immutable, hashed program.
 * The same function runs in the designer and on the server (outline 6.3).
 */
import { hasErrors, type Diagnostic } from '../diagnostics.ts';
import { contentHashOf } from '../evidence/hash.ts';
import type { AcceptanceTableCatalog } from '../library/acceptance-tables.ts';
import type { Tag } from '../units/tags.ts';
import { EXPR_LANGUAGE_VERSION } from '../version.ts';
import type { Expr } from './ast.ts';
import { checkExpression } from './checker.ts';
import type { ProgramCore } from './evaluator.ts';
import { parse } from './parser.ts';
import { print } from './printer.ts';
import type { ExprType, InputDeclarations, OutputDeclaration } from './types.ts';

/** JSON-friendly description of a static type. */
export type TypeDescription =
  | { readonly kind: 'quantity'; readonly unit: string; readonly tag: Tag }
  | { readonly kind: 'series'; readonly unit: string; readonly tag: Tag; readonly maxLength: number }
  | { readonly kind: 'boolean' | 'instant' | 'string' | 'text' }
  | { readonly kind: 'category'; readonly values: readonly string[] }
  | { readonly kind: 'unit'; readonly unit: string };

export function describeType(t: ExprType): TypeDescription {
  switch (t.kind) {
    case 'quantity':
      return { kind: 'quantity', unit: t.unit.code, tag: t.tag ?? 'none' };
    case 'series':
      return { kind: 'series', unit: t.element.unit.code, tag: t.element.tag ?? 'none', maxLength: t.maxLength };
    case 'category':
      return { kind: 'category', values: t.values };
    case 'unit':
      return { kind: 'unit', unit: t.unit.code };
    default:
      return { kind: t.kind };
  }
}

export interface CompileOptions {
  /** Declared inputs (the only values the expression may read). */
  readonly inputs: InputDeclarations;
  /** Declared result: unit it is converted to and stored in, and its tag. */
  readonly output?: OutputDeclaration;
  /** Name of the calculation in the MBR (stored in evaluation records). */
  readonly name?: string;
  /** Acceptance tables the expression may look up (design-time copy of the master data). */
  readonly tables?: AcceptanceTableCatalog;
  /** Cost ceiling (default 1,000,000). */
  readonly maxCost?: number;
  /** 'calculation' (default) or 'condition' (a branch guard, loop exit or decision: true/false). */
  readonly role?: 'calculation' | 'condition';
}

export interface CompiledExpression {
  readonly name: string | undefined;
  readonly source: string;
  readonly canonical: string;
  readonly languageVersion: string;
  readonly inputs: InputDeclarations;
  readonly output: OutputDeclaration | undefined;
  /** Declared inputs the expression reads, sorted. */
  readonly reads: readonly string[];
  readonly functions: readonly string[];
  /** Type of the stored result (after conversion to the declared output). */
  readonly resultType: TypeDescription;
  /** Static upper bound of the evaluation cost. */
  readonly cost: number;
  /** Warnings (need a justification) and notes; never errors. */
  readonly diagnostics: readonly Diagnostic[];
  readonly tables: readonly { readonly id: string; readonly version: string }[];
  /** SHA-256 of language version, canonical text, declarations, output and table versions. */
  readonly programHash: string;
  /** @internal checked tree and types for the evaluator. */
  readonly core: ProgramCore;
}

export type CompileResult = { ok: true; program: CompiledExpression; diagnostics: readonly Diagnostic[] } | { ok: false; diagnostics: readonly Diagnostic[] };

export function compile(source: string, options: CompileOptions): CompileResult {
  const parsed = parse(source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  const ast: Expr = parsed.ast;
  const checked = checkExpression(ast, {
    inputs: options.inputs,
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.tables === undefined ? {} : { tables: options.tables }),
    ...(options.maxCost === undefined ? {} : { maxCost: options.maxCost }),
    ...(options.role === undefined ? {} : { role: options.role }),
  });
  if (hasErrors(checked.diagnostics) || checked.outputType === undefined) return { ok: false, diagnostics: checked.diagnostics };
  const canonical = print(ast);
  const inputs = JSON.parse(JSON.stringify(options.inputs)) as InputDeclarations;
  const output = options.output === undefined ? undefined : (JSON.parse(JSON.stringify(options.output)) as OutputDeclaration);
  const programHash = contentHashOf({ languageVersion: EXPR_LANGUAGE_VERSION, canonical, inputs, output: output ?? null, tables: checked.tables, role: options.role ?? 'calculation' });
  const program: CompiledExpression = Object.freeze({
    name: options.name,
    source,
    canonical,
    languageVersion: EXPR_LANGUAGE_VERSION,
    inputs,
    output,
    reads: Object.freeze([...checked.reads]),
    functions: Object.freeze([...checked.functions]),
    resultType: describeType(checked.outputType),
    cost: checked.cost,
    diagnostics: Object.freeze(checked.diagnostics),
    tables: Object.freeze(checked.tables),
    programHash,
    core: Object.freeze({ ast, types: checked.types, inputs: checked.inputs, outputType: checked.outputType, tables: checked.tables }),
  });
  return { ok: true, program, diagnostics: checked.diagnostics };
}
