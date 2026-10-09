/**
 * Static type, unit and tag checker, and the static cost bound (ADR 0005 decisions 2-3;
 * outline 6.3 data gates "expressions parse, type-check and unit-check").
 *
 * Runs identically in the designer and on the server. Reports every problem it can find (a failing
 * sub-expression does not cascade into further messages about its parents).
 */
import { Dec, DecError } from '../decimal/dec.ts';
import { diagnostic, type Diagnostic, type Span } from '../diagnostics.ts';
import { CheckFailure, type ArgInfo } from '../library/contract.ts';
import type { AcceptanceTableCatalog } from '../library/acceptance-tables.ts';
import { LIBRARY } from '../library/index.ts';
import { isTag, TAG_LABEL, tagUnitProblem, type Tag } from '../units/tags.ts';
import { DIMENSIONLESS, describeDimension, divideUnits, multiplyUnits, parseUnit, UnitError, type Unit } from '../units/unit.ts';
import { referencedPaths, type BinaryExpr, type Expr } from './ast.ts';
import { RESERVED_WORDS } from './parser.ts';
import { barePercentConflict, describeQuantity, describeTag, productTag, unifyTags } from './rules.ts';
import { MAX_SERIES_LENGTH, type ExprType, type InputDeclarations, type OutputDeclaration, type QuantityType } from './types.ts';

export const DEFAULT_MAX_COST = 1_000_000;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const KELVIN = parseUnit('K');

export interface ResolvedInput {
  readonly path: string;
  readonly type: ExprType;
  readonly source: 'CAPTURED' | 'DEVICE' | 'LIMS' | 'MASTER_DATA' | 'DERIVED';
  /** The unit the declaration was written in, when it differs from the unit values are held in (% w/v). */
  readonly declaredUnit?: string;
}

export interface CheckOptions {
  readonly inputs: InputDeclarations;
  readonly output?: OutputDeclaration;
  readonly tables?: AcceptanceTableCatalog;
  readonly maxCost?: number;
  /** 'calculation' (default) derives a value and must read an input (INV-25); 'condition' must be true/false. */
  readonly role?: 'calculation' | 'condition';
}

export interface CheckResult {
  readonly diagnostics: Diagnostic[];
  readonly types: ReadonlyMap<Expr, ExprType>;
  readonly resultType: ExprType | undefined;
  /** Type after conversion to the declared output (what the calculation stores). */
  readonly outputType: ExprType | undefined;
  readonly cost: number;
  readonly reads: readonly string[];
  readonly inputs: ReadonlyMap<string, ResolvedInput>;
  readonly functions: readonly string[];
  readonly tables: readonly { id: string; version: string }[];
}

class Failed extends Error {}

function quantityType(unit: Unit, tag: Tag | null): QuantityType {
  return { kind: 'quantity', unit, tag };
}

export function resolveDeclarations(inputs: InputDeclarations, diagnostics: Diagnostic[]): Map<string, ResolvedInput> {
  const out = new Map<string, ResolvedInput>();
  const err = (code: string, text: string): void => {
    diagnostics.push(diagnostic(code, 'ERROR', text));
  };
  for (const path of Object.keys(inputs).sort()) {
    const d = inputs[path];
    if (d === undefined) continue;
    if (!PATH.test(path) || path.split('.').some((part) => RESERVED_WORDS.has(part) || part === 'true' || part === 'false')) {
      err('EXPR-DECL-001', `"${path}" is not a valid input name (letters, digits and "_", parts joined by "."; not a reserved word)`);
      continue;
    }
    const kind = d.kind ?? 'quantity';
    const source = d.source ?? 'CAPTURED';
    if (!['CAPTURED', 'DEVICE', 'LIMS', 'MASTER_DATA', 'DERIVED'].includes(source)) {
      err('EXPR-DECL-002', `Input "${path}": unknown source "${String(source)}"`);
      continue;
    }
    if (kind === 'boolean' || kind === 'instant' || kind === 'text') {
      out.set(path, { path, type: { kind }, source });
      continue;
    }
    if (kind === 'category') {
      const values = d.values ?? [];
      if (values.length === 0 || new Set(values).size !== values.length || values.some((v) => typeof v !== 'string' || v.length === 0)) {
        err('EXPR-DECL-003', `Input "${path}": a category needs a list of distinct, non-empty values`);
        continue;
      }
      out.set(path, { path, type: { kind: 'category', values: [...values] }, source });
      continue;
    }
    if (kind !== 'quantity' && kind !== 'series') {
      err('EXPR-DECL-002', `Input "${path}": unknown kind "${String(kind)}"`);
      continue;
    }
    const tag: Tag = d.tag ?? 'none';
    if (!isTag(tag)) {
      err('EXPR-DECL-004', `Input "${path}": unknown tag "${String(tag)}"`);
      continue;
    }
    if (d.unit === undefined) {
      err('EXPR-DECL-005', `Input "${path}" needs a unit ("1" for a plain number or a count)`);
      continue;
    }
    let unit: Unit;
    try {
      unit = parseUnit(d.unit);
    } catch (e) {
      if (e instanceof UnitError) {
        err('EXPR-UNIT-001', `Input "${path}": ${e.message}`);
        continue;
      }
      throw e;
    }
    let declaredUnit: string | undefined;
    if (tag === 'w/v' && d.unit === '%') {
      // % w/v means grams per 100 mL: held as g/dL (numerically identical).
      unit = parseUnit('g/dL');
      declaredUnit = '%';
    }
    const problem = tagUnitProblem(tag, unit);
    if (problem !== undefined) {
      err('EXPR-DECL-006', `Input "${path}" is declared as ${TAG_LABEL[tag]} in ${d.unit}: ${problem}`);
      continue;
    }
    const element = quantityType(unit, tag);
    if (kind === 'series') {
      const n = d.maxLength;
      if (n === undefined || !Number.isSafeInteger(n) || n < 1 || n > MAX_SERIES_LENGTH) {
        err('EXPR-DECL-007', `Input "${path}": a recorded series needs a maximum length between 1 and ${String(MAX_SERIES_LENGTH)} (it bounds the cost)`);
        continue;
      }
      out.set(path, { path, type: { kind: 'series', element, maxLength: n }, source, ...(declaredUnit === undefined ? {} : { declaredUnit }) });
    } else {
      out.set(path, { path, type: element, source, ...(declaredUnit === undefined ? {} : { declaredUnit }) });
    }
  }
  return out;
}

class Checker {
  readonly diagnostics: Diagnostic[] = [];
  readonly types = new Map<Expr, ExprType>();
  readonly functions = new Set<string>();
  readonly tables = new Map<string, string>();

  constructor(
    readonly inputs: ReadonlyMap<string, ResolvedInput>,
    readonly catalog: AcceptanceTableCatalog,
  ) {}

  error(code: string, text: string, span: Span): never {
    this.diagnostics.push(diagnostic(code, 'ERROR', text, span));
    throw new Failed();
  }

  /** Type of a node, or undefined if it (or a child) failed. */
  check(e: Expr, allowUnit = false): ExprType | undefined {
    try {
      const t = this.infer(e, allowUnit);
      this.types.set(e, t);
      return t;
    } catch (x) {
      if (x instanceof Failed) return undefined;
      throw x;
    }
  }

  private scalar(t: ExprType, node: Expr, what: string): QuantityType {
    if (t.kind === 'quantity') return t;
    if (t.kind === 'series' && node.type === 'Path') {
      this.error('EXPR-TYP-011', `"${node.path}" is a recorded series; use an aggregate such as mean(${node.path}) or sum(${node.path})`, node.span);
    }
    return this.error('EXPR-TYP-002', `${what} needs a number with a unit, not ${t.kind === 'category' || t.kind === 'text' ? 'text' : `a ${t.kind}`}`, node.span);
  }

  private infer(e: Expr, allowUnit: boolean): ExprType {
    switch (e.type) {
      case 'Number': {
        try {
          Dec.parse(e.text);
        } catch (x) {
          if (x instanceof DecError) this.error('EXPR-SYN-007', `The number ${e.text} cannot be held exactly: ${x.message}`, e.span);
          throw x;
        }
        return quantityType(e.unit === null ? DIMENSIONLESS : this.unit(e.unit, e.span), null);
      }
      case 'Unit': {
        if (!allowUnit) this.error('EXPR-TYP-010', `A unit on its own ([${e.unit}]) is only allowed as the target of convert(x, [unit])`, e.span);
        return { kind: 'unit', unit: this.unit(e.unit, e.span) };
      }
      case 'String':
        return { kind: 'string' };
      case 'Bool':
        return { kind: 'boolean' };
      case 'Path': {
        const input = this.inputs.get(e.path);
        if (input === undefined) this.error('EXPR-TYP-001', `"${e.path}" is not a declared input; an expression reads only the inputs its calculation declares`, e.span);
        return input.type;
      }
      case 'Unary': {
        const t = this.check(e.operand);
        if (t === undefined) throw new Failed();
        if (e.op === '!') {
          if (t.kind !== 'boolean') this.error('EXPR-TYP-003', '"!" (not) needs a true/false value', e.span);
          return t;
        }
        const q = this.scalar(t, e.operand, 'A minus sign');
        if (q.unit.scale === 'ABSOLUTE_TEMPERATURE') this.error('EXPR-UNIT-012', 'An absolute temperature cannot be negated; subtract a reference temperature first', e.span);
        return q;
      }
      case 'Binary':
        return this.binary(e);
      case 'Conditional': {
        const test = this.check(e.test);
        const a = this.check(e.consequent);
        const b = this.check(e.alternate);
        if (test === undefined || a === undefined || b === undefined) throw new Failed();
        if (test.kind !== 'boolean') this.error('EXPR-TYP-004', 'The condition before "?" must be true or false', e.test.span);
        if (a.kind === 'boolean' && b.kind === 'boolean') return a;
        const qa = this.scalar(a, e.consequent, 'Each branch of a conditional');
        const qb = this.scalar(b, e.alternate, 'Each branch of a conditional');
        const tag = this.commensurable(qa, qb, 'The two branches of a conditional', e.span);
        return quantityType(qa.unit, tag);
      }
      case 'Call':
        return this.call(e);
    }
  }

  private unit(code: string, span: Span): Unit {
    try {
      return parseUnit(code);
    } catch (x) {
      if (x instanceof UnitError) this.error('EXPR-UNIT-001', x.message, span);
      throw x;
    }
  }

  /** Same dimension, compatible tags, no plain-number/percent mix: returns the unified tag. */
  private commensurable(a: QuantityType, b: QuantityType, what: string, span: Span, verb = 'combined'): Tag | null {
    if (a.unit.dimensionKey !== b.unit.dimensionKey || a.unit.scale !== b.unit.scale) {
      this.error('EXPR-UNIT-010', `${what} cannot be ${verb}: ${describeQuantity(a.unit, a.tag)} and ${describeQuantity(b.unit, b.tag)} measure different things`, span);
    }
    if (barePercentConflict(a.unit, b.unit)) {
      this.error('EXPR-UNIT-011', `A plain number and a percentage cannot be ${verb} (in UCUM, 100 - 4.6 % is 99.954); write the number with its unit, e.g. 100 [%]`, span);
    }
    const tag = unifyTags(a.tag, b.tag);
    if (tag === undefined) {
      this.error('EXPR-TAG-001', `${describeTag(a.tag)} and ${describeTag(b.tag)} cannot be ${verb}: they mean different things`, span);
    }
    return tag;
  }

  private binary(e: BinaryExpr): ExprType {
    const l = this.check(e.left);
    const r = this.check(e.right);
    if (l === undefined || r === undefined) throw new Failed();
    switch (e.op) {
      case '&&':
      case '||':
        if (l.kind !== 'boolean' || r.kind !== 'boolean') this.error('EXPR-TYP-003', `"${e.op}" needs true/false values on both sides`, e.span);
        return l;
      case '+':
      case '-': {
        if (l.kind === 'instant' || r.kind === 'instant') this.error('EXPR-TYP-012', 'Instants cannot be added or subtracted; use duration(start, end)', e.span);
        const a = this.scalar(l, e.left, e.op === '+' ? 'Addition' : 'Subtraction');
        const b = this.scalar(r, e.right, e.op === '+' ? 'Addition' : 'Subtraction');
        const absA = a.unit.scale === 'ABSOLUTE_TEMPERATURE';
        const absB = b.unit.scale === 'ABSOLUTE_TEMPERATURE';
        if (absA || absB) return this.temperatureSum(e, a, b, absA, absB);
        const tag = this.commensurable(a, b, e.op === '+' ? 'These values' : 'These values', e.span, e.op === '+' ? 'added' : 'subtracted');
        return quantityType(a.unit, tag);
      }
      case '*':
      case '/': {
        const a = this.scalar(l, e.left, e.op === '*' ? 'Multiplication' : 'Division');
        const b = this.scalar(r, e.right, e.op === '*' ? 'Multiplication' : 'Division');
        if (a.unit.scale === 'ABSOLUTE_TEMPERATURE' || b.unit.scale === 'ABSOLUTE_TEMPERATURE') {
          this.error('EXPR-UNIT-012', 'An absolute temperature cannot be multiplied or divided; subtract a reference temperature first (T - Tref gives a difference in K)', e.span);
        }
        if (e.op === '/' && e.right.type === 'Number' && Dec.isValid(e.right.text) && Dec.parse(e.right.text).isZero()) {
          this.error('EXPR-TYP-020', 'Division by zero', e.right.span);
        }
        const unit = e.op === '*' ? multiplyUnits(a.unit, b.unit) : divideUnits(a.unit, b.unit);
        return quantityType(unit, productTag(a.unit, a.tag, b.unit, b.tag, e.op));
      }
      case '<':
      case '<=':
      case '>':
      case '>=':
      case '==':
      case '!=':
        return this.comparison(e, l, r);
    }
  }

  private temperatureSum(e: BinaryExpr, a: QuantityType, b: QuantityType, absA: boolean, absB: boolean): ExprType {
    const diff = (q: QuantityType): boolean => q.unit.scale === 'LINEAR' && q.unit.dimensionKey === KELVIN.dimensionKey;
    if (absA && absB) {
      if (e.op === '+') this.error('EXPR-UNIT-013', 'Two absolute temperatures cannot be added; a temperature minus a temperature gives a difference in K', e.span);
      this.commensurable(a, b, 'These temperatures', e.span, 'subtracted');
      return quantityType(KELVIN, 'none');
    }
    if (absA && diff(b)) return quantityType(a.unit, 'none');
    if (absB && diff(a) && e.op === '+') return quantityType(b.unit, 'none');
    if (absB && diff(a)) this.error('EXPR-UNIT-013', 'A temperature difference minus an absolute temperature has no meaning', e.span);
    return this.error(
      'EXPR-UNIT-010',
      `An absolute temperature can only be combined with a temperature difference in K, not with ${describeQuantity(absA ? b.unit : a.unit, absA ? b.tag : a.tag)}`,
      e.span,
    );
  }

  private comparison(e: BinaryExpr, l: ExprType, r: ExprType): ExprType {
    const bool: ExprType = { kind: 'boolean' };
    if (l.kind === 'instant' && r.kind === 'instant') return bool;
    const equality = e.op === '==' || e.op === '!=';
    if (equality) {
      if (l.kind === 'boolean' && r.kind === 'boolean') return bool;
      const textual = (t: ExprType): boolean => t.kind === 'string' || t.kind === 'category' || t.kind === 'text';
      if (textual(l) && textual(r)) {
        for (const [cat, other, node] of [
          [l, r, e.right],
          [r, l, e.left],
        ] as const) {
          if (cat.kind === 'category' && other.kind === 'string' && node.type === 'String' && !cat.values.includes(node.value)) {
            this.error('EXPR-TYP-013', `"${node.value}" is not one of the allowed values: ${cat.values.join(', ')}`, node.span);
          }
        }
        return bool;
      }
    }
    if (l.kind === 'quantity' || r.kind === 'quantity' || l.kind === 'series' || r.kind === 'series') {
      const a = this.scalar(l, e.left, 'A comparison');
      const b = this.scalar(r, e.right, 'A comparison');
      this.commensurable(a, b, 'These values', e.span, 'compared');
      return bool;
    }
    return this.error('EXPR-TYP-005', `"${e.op}" cannot compare a ${l.kind} with a ${r.kind}`, e.span);
  }

  private call(e: Extract<Expr, { type: 'Call' }>): ExprType {
    const fn = LIBRARY.get(e.callee);
    if (fn === undefined) {
      this.error('EXPR-FN-001', `"${e.callee}" is not a function of the library; the library is closed (new functions arrive only in platform releases)`, e.span);
    }
    this.functions.add(fn.name);
    const types = e.args.map((a, i) => this.check(a, fn.name === 'convert' && i === 1));
    if (types.some((t) => t === undefined)) throw new Failed();
    const args: ArgInfo[] = e.args.map((node, i) => ({ node, type: types[i] as ExprType, constant: referencedPaths(node).length === 0 }));
    try {
      const t = fn.check(args, { callee: fn.name, tables: this.catalog });
      if (fn.name === 'table_lookup') {
        const id = e.args[0];
        if (id?.type === 'String') {
          const table = this.catalog[id.value];
          if (table !== undefined) this.tables.set(table.id, table.version);
        }
      }
      return t;
    } catch (x) {
      if (x instanceof CheckFailure) {
        const at = x.argIndex === undefined ? e : (e.args[x.argIndex] ?? e);
        return this.error(x.code, x.message, at.span);
      }
      throw x;
    }
  }

  cost(e: Expr): number {
    switch (e.type) {
      case 'Unary':
        return 1 + this.cost(e.operand);
      case 'Binary':
        return 1 + this.cost(e.left) + this.cost(e.right);
      case 'Conditional':
        return 1 + this.cost(e.test) + Math.max(this.cost(e.consequent), this.cost(e.alternate));
      case 'Call': {
        const fn = LIBRARY.get(e.callee);
        const args: ArgInfo[] = e.args.map((node) => ({ node, type: this.types.get(node) ?? { kind: 'boolean' }, constant: false }));
        return 1 + e.args.reduce((n, a) => n + this.cost(a), 0) + (fn?.cost(args) ?? 0);
      }
      default:
        return 1;
    }
  }
}

function outputType(result: ExprType, output: OutputDeclaration, diagnostics: Diagnostic[], span: Span): ExprType | undefined {
  const kind = output.kind ?? 'quantity';
  if (kind === 'boolean') {
    if (result.kind !== 'boolean') {
      diagnostics.push(diagnostic('EXPR-TYP-031', 'ERROR', 'The output is declared as true/false, but the formula gives a value', span));
      return undefined;
    }
    return result;
  }
  if (result.kind !== 'quantity') {
    diagnostics.push(diagnostic('EXPR-TYP-031', 'ERROR', `The output is declared as a quantity, but the formula gives a ${result.kind}`, span));
    return undefined;
  }
  const tag: Tag = output.tag ?? (result.tag === null ? 'none' : result.tag);
  if (!isTag(tag)) {
    diagnostics.push(diagnostic('EXPR-DECL-004', 'ERROR', `Unknown output tag "${String(tag)}"`, span));
    return undefined;
  }
  let unit = result.unit;
  if (output.unit !== undefined) {
    try {
      unit = parseUnit(tag === 'w/v' && output.unit === '%' ? 'g/dL' : output.unit);
    } catch (x) {
      if (x instanceof UnitError) {
        diagnostics.push(diagnostic('EXPR-UNIT-001', 'ERROR', `Output unit: ${x.message}`, span));
        return undefined;
      }
      throw x;
    }
    if (unit.dimensionKey !== result.unit.dimensionKey || unit.scale !== result.unit.scale) {
      diagnostics.push(
        diagnostic('EXPR-UNIT-014', 'ERROR', `The formula gives ${describeDimension(result.unit)} (${result.unit.code}), but the output is declared in ${output.unit} (${describeDimension(unit)})`, span),
      );
      return undefined;
    }
    // A plain-number result stored as a percentage would be multiplied by 100 (98.24 -> 9824 %);
    // the reverse (a ratio of units such as kg/mg stored as a plain count) is ordinary conversion.
    if (result.unit.bareNumber && barePercentConflict(unit, result.unit)) {
      diagnostics.push(diagnostic('EXPR-UNIT-011', 'ERROR', `The formula gives a plain number, but the output is declared in ${output.unit}; write the formula with units, e.g. a / b * 100 [%]`, span));
      return undefined;
    }
  }
  const problem = tagUnitProblem(tag, unit);
  if (problem !== undefined) {
    diagnostics.push(diagnostic('EXPR-DECL-006', 'ERROR', `The output is declared as ${TAG_LABEL[tag]} in ${unit.code}: ${problem}`, span));
    return undefined;
  }
  if (result.tag !== null && result.tag !== 'none' && result.tag !== tag) {
    diagnostics.push(diagnostic('EXPR-TAG-002', 'ERROR', `The formula gives ${TAG_LABEL[result.tag]}, but the output is declared as ${TAG_LABEL[tag]}`, span));
    return undefined;
  }
  return { kind: 'quantity', unit, tag };
}

/** Type-, unit- and tag-checks a parsed expression against its declarations. */
export function checkExpression(ast: Expr, options: CheckOptions): CheckResult {
  const diagnostics: Diagnostic[] = [];
  const inputs = resolveDeclarations(options.inputs, diagnostics);
  const checker = new Checker(inputs, options.tables ?? {});
  const resultType = checker.check(ast);
  diagnostics.push(...checker.diagnostics);
  const reads = referencedPaths(ast).filter((p) => inputs.has(p));
  let out: ExprType | undefined;
  let cost = 0;
  if (resultType !== undefined) {
    const role = options.role ?? 'calculation';
    if (resultType.kind !== 'quantity' && resultType.kind !== 'boolean') {
      diagnostics.push(diagnostic('EXPR-TYP-030', 'ERROR', `The result must be a quantity or true/false, not a ${resultType.kind}`, ast.span));
    } else if (role === 'condition' && resultType.kind !== 'boolean') {
      diagnostics.push(diagnostic('EXPR-TYP-032', 'ERROR', 'A condition must give true or false', ast.span));
    } else {
      out = options.output === undefined ? resultType : outputType(resultType, options.output, diagnostics, ast.span);
    }
    if (role === 'calculation' && reads.length === 0) {
      diagnostics.push(
        diagnostic('EXPR-INV25-001', 'ERROR', 'A calculation must compute its result from recorded inputs; a constant typed into a formula is not a derived value (a fixed value belongs in a parameter)', ast.span, 'INV-25'),
      );
    }
    cost = checker.cost(ast);
    const max = options.maxCost ?? DEFAULT_MAX_COST;
    if (cost > max) diagnostics.push(diagnostic('EXPR-COST-001', 'ERROR', `The static cost bound ${String(cost)} exceeds the limit ${String(max)}; shorten the series or simplify the formula`, ast.span));
  }
  for (const path of inputs.keys()) {
    if (!reads.includes(path)) diagnostics.push(diagnostic('EXPR-DECL-010', 'INFO', `Declared input "${path}" is not read by the expression`));
  }
  return {
    diagnostics,
    types: checker.types,
    resultType,
    outputType: out,
    cost,
    reads,
    inputs,
    functions: [...checker.functions].sort(),
    tables: [...checker.tables].map(([id, version]) => ({ id, version })).sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}
