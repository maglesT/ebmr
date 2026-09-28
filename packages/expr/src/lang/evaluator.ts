/**
 * Evaluator (ADR 0005 decisions 3-5). Pure and deterministic: reads only declared inputs, no I/O,
 * no clock, no locale. Explicit errors: a missing input, a division by zero or an out-of-domain
 * value throws ExprEvaluationError naming the input path(s); a result is never NaN, an infinity or
 * a silent zero.
 *
 * Arithmetic: + and - are exact on rationals (the right operand converted exactly to the left
 * operand's unit) and rounded once; * and / are correctly rounded to 34 significant digits;
 * comparisons are exact (never rounded). && and || short-circuit and ?: evaluates only the branch
 * taken, so an input read only in an untaken branch is not needed.
 */
import { Dec, DecError } from '../decimal/dec.ts';
import { fromRational, rAdd, rCmp, rDiv, rMul, rSub, toRational, type Rational } from '../decimal/exact.ts';
import type { RecordedConversion, RecordedInput, RecordedTableLookup, EvaluationRecord } from '../evidence/record-types.ts';
import { contentHashOf } from '../evidence/hash.ts';
import { lookupAcceptanceTable, type AcceptanceTableCatalog } from '../library/acceptance-tables.ts';
import type { EvalContext } from '../library/contract.ts';
import { LIBRARY } from '../library/index.ts';
import { compareValues, convertValue, toBaseRational, type ConversionRecord } from '../units/quantity.ts';
import { TAG_LABEL, type Tag } from '../units/tags.ts';
import { divideUnits, factorText, linearFactor, multiplyUnits, parseUnit, sameDimension, sameMagnitude, UnitError, type Unit } from '../units/unit.ts';
import { referencedPaths, type BinaryExpr, type Expr } from './ast.ts';
import type { ResolvedInput } from './checker.ts';
import { ExprEvaluationError } from './errors.ts';
import { parseInstant } from './instant.ts';
import type { ExprType, QuantityType } from './types.ts';
import type { QuantityValue, RuntimeValue } from './values.ts';

/** A value supplied for a declared input (JSON-friendly; decimals as strings). */
export type InputValue =
  | { readonly value: string; readonly unit?: string; readonly tag?: Tag; readonly source: string }
  | { readonly values: readonly string[]; readonly unit?: string; readonly tag?: Tag; readonly source: string }
  | { readonly instant: string; readonly source: string }
  | { readonly boolean: boolean; readonly source: string }
  | { readonly category: string; readonly source: string }
  | { readonly text: string; readonly source: string }
  /** DERIVED inputs: the evaluation record of the calculation that computed the value (INV-25). */
  | { readonly derived: EvaluationRecord };

export type InputValues = Readonly<Record<string, InputValue | undefined>>;

export interface ProgramCore {
  readonly ast: Expr;
  readonly types: ReadonlyMap<Expr, ExprType>;
  readonly inputs: ReadonlyMap<string, ResolvedInput>;
  readonly outputType: ExprType;
  readonly tables: readonly { id: string; version: string }[];
}

export interface EvaluationOutcome {
  readonly value: QuantityValue | { readonly kind: 'boolean'; readonly value: boolean };
  readonly inputs: readonly RecordedInput[];
  readonly conversions: readonly RecordedConversion[];
  readonly tableLookups: readonly RecordedTableLookup[];
}

interface Bound {
  readonly value: RuntimeValue;
  readonly recorded: RecordedInput;
}

function has<K extends string>(o: object, key: K): o is Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(o, key);
}

function invalid(path: string, message: string): never {
  throw new ExprEvaluationError('INVALID_INPUT', `Input "${path}": ${message}`, { paths: [path] });
}

function decimal(path: string, text: unknown): Dec {
  try {
    return Dec.parse(text as string);
  } catch (e) {
    if (e instanceof DecError) invalid(path, e.message);
    throw e;
  }
}

function recordConversion(at: string, c: ConversionRecord): RecordedConversion {
  return { at, ...c };
}

/** Verifies a DERIVED input's evaluation record (content hash) before its output is used. */
export function recordHashValid(record: EvaluationRecord): boolean {
  const { contentHash, ...rest } = record;
  return typeof contentHash === 'string' && contentHashOf(rest) === contentHash;
}

class Evaluation {
  readonly conversions: RecordedConversion[] = [];
  readonly lookups: RecordedTableLookup[] = [];
  readonly read = new Map<string, RecordedInput>();
  private readonly bound = new Map<string, Bound>();

  constructor(
    private readonly program: ProgramCore,
    private readonly tables: AcceptanceTableCatalog,
    raw: InputValues,
  ) {
    for (const key of Object.keys(raw)) {
      if (!program.inputs.has(key)) invalid(key, 'is not a declared input of this calculation');
    }
    for (const [path, decl] of program.inputs) {
      const v = raw[path];
      if (v === undefined || v === null) continue;
      this.bound.set(path, this.bind(path, decl, v));
    }
  }

  private convertInto(path: string, value: Dec, from: Unit, to: Unit): Dec {
    const r = convertValue(value, from, to);
    if (r.conversion !== null) this.conversions.push(recordConversion(`input ${path}`, r.conversion));
    return r.value;
  }

  private inputUnit(path: string, decl: ResolvedInput, unitText: unknown, element: QuantityType): Unit {
    if (unitText === undefined) return element.unit;
    if (typeof unitText !== 'string') invalid(path, 'the unit must be a UCUM code in a string');
    let unit: Unit;
    try {
      unit = parseUnit(element.tag === 'w/v' && unitText === '%' ? 'g/dL' : unitText);
    } catch (e) {
      if (e instanceof UnitError) invalid(path, e.message);
      throw e;
    }
    if (!sameDimension(unit, element.unit)) invalid(path, `the value is in ${unitText}, which does not measure the same thing as the declared unit ${decl.declaredUnit ?? element.unit.code}`);
    return unit;
  }

  private bind(path: string, decl: ResolvedInput, raw: InputValue): Bound {
    if (typeof raw !== 'object') invalid(path, 'expected an object with the value and its source');
    const t = decl.type;
    if (has(raw, 'derived')) {
      if (decl.source !== 'DERIVED') invalid(path, 'is a recorded input: supply the recorded value with its source, not a computed result');
      return this.bindDerived(path, decl, raw.derived as EvaluationRecord);
    }
    if (decl.source === 'DERIVED') {
      throw new ExprEvaluationError('DERIVED_VALUE_TYPED', `Input "${path}" is a derived value: it must come from the calculation that computes it, never be typed (INV-25)`, { paths: [path] });
    }
    const source = has(raw, 'source') ? raw.source : undefined;
    if (typeof source !== 'string' || source.length === 0) invalid(path, 'the source reference (step entry, device reading, LIMS result or master data) is required');
    const tagGiven = has(raw, 'tag') ? raw.tag : undefined;
    switch (t.kind) {
      case 'quantity': {
        if (!has(raw, 'value')) invalid(path, 'a quantity needs "value" (a decimal string)');
        const value = decimal(path, raw.value);
        const unitText = has(raw, 'unit') ? raw.unit : undefined;
        const unit = this.inputUnit(path, decl, unitText, t);
        if (tagGiven !== undefined && tagGiven !== t.tag) invalid(path, `the value is tagged ${String(tagGiven)}, but the input is declared as ${TAG_LABEL[t.tag ?? 'none']}`);
        const converted = this.convertInto(path, value, unit, t.unit);
        return {
          value: { kind: 'quantity', value: converted, unit: t.unit, tag: t.tag },
          recorded: { path, kind: 'quantity', source, value: value.toString(), unit: typeof unitText === 'string' ? unitText : (decl.declaredUnit ?? t.unit.code), ...(t.tag === null || t.tag === 'none' ? {} : { tag: t.tag }) },
        };
      }
      case 'series': {
        if (!has(raw, 'values') || !Array.isArray(raw.values)) invalid(path, 'a recorded series needs "values" (a list of decimal strings)');
        const texts = raw.values as unknown[];
        if (texts.length > t.maxLength) {
          throw new ExprEvaluationError('SERIES_TOO_LONG', `Input "${path}" has ${String(texts.length)} values; at most ${String(t.maxLength)} are declared`, { paths: [path] });
        }
        const values = texts.map((x) => decimal(path, x));
        const unitText = has(raw, 'unit') ? raw.unit : undefined;
        const unit = this.inputUnit(path, decl, unitText, t.element);
        if (tagGiven !== undefined && tagGiven !== t.element.tag) invalid(path, `the values are tagged ${String(tagGiven)}, but the input is declared as ${TAG_LABEL[t.element.tag ?? 'none']}`);
        let conversion: ConversionRecord | null = null;
        let exact = true;
        const converted = values.map((v) => {
          const r = convertValue(v, unit, t.element.unit);
          conversion = r.conversion ?? conversion;
          exact &&= r.conversion?.exact ?? true;
          return r.value;
        });
        if (conversion !== null) this.conversions.push(recordConversion(`input ${path}`, { ...(conversion as ConversionRecord), exact }));
        return {
          value: { kind: 'series', values: converted, unit: t.element.unit, tag: t.element.tag },
          recorded: {
            path,
            kind: 'series',
            source,
            values: values.map((v) => v.toString()),
            unit: typeof unitText === 'string' ? unitText : (decl.declaredUnit ?? t.element.unit.code),
            ...(t.element.tag === null || t.element.tag === 'none' ? {} : { tag: t.element.tag }),
          },
        };
      }
      case 'instant': {
        if (!has(raw, 'instant') || typeof raw.instant !== 'string') invalid(path, 'an instant needs "instant" (ISO 8601 text with a zone)');
        let micros: bigint;
        try {
          micros = parseInstant(raw.instant);
        } catch (e) {
          if (e instanceof DecError) invalid(path, e.message);
          throw e;
        }
        return { value: { kind: 'instant', epochMicros: micros, text: raw.instant }, recorded: { path, kind: 'instant', source, value: raw.instant } };
      }
      case 'boolean': {
        if (!has(raw, 'boolean') || typeof raw.boolean !== 'boolean') invalid(path, 'a true/false input needs "boolean"');
        return { value: { kind: 'boolean', value: raw.boolean }, recorded: { path, kind: 'boolean', source, value: raw.boolean ? 'true' : 'false' } };
      }
      case 'category': {
        if (!has(raw, 'category') || typeof raw.category !== 'string' || !t.values.includes(raw.category)) invalid(path, `the value must be one of: ${t.values.join(', ')}`);
        return { value: { kind: 'category', value: raw.category }, recorded: { path, kind: 'category', source, value: raw.category } };
      }
      case 'text': {
        if (!has(raw, 'text') || typeof raw.text !== 'string') invalid(path, 'a text input needs "text"');
        return { value: { kind: 'text', value: raw.text }, recorded: { path, kind: 'text', source, value: raw.text } };
      }
      default:
        return invalid(path, 'unsupported input kind');
    }
  }

  private bindDerived(path: string, decl: ResolvedInput, record: EvaluationRecord): Bound {
    const bad = (why: string): never => {
      throw new ExprEvaluationError('DERIVED_RECORD_INVALID', `Input "${path}": the computed result offered ${why}`, { paths: [path] });
    };
    if (typeof record !== 'object' || record === null || !recordHashValid(record)) bad('does not verify against its content hash');
    const out = record.output;
    const t = decl.type;
    if (t.kind === 'boolean') {
      if (out.kind !== 'boolean') bad('is not a true/false result');
      return {
        value: { kind: 'boolean', value: out.value === 'true' },
        recorded: { path, kind: 'boolean', source: `calculation ${record.calculation ?? ''}`.trim(), value: out.value, derivedFrom: record.contentHash },
      };
    }
    if (t.kind !== 'quantity' || out.kind !== 'quantity' || out.unit === undefined) return bad('is not a quantity of the declared kind');
    let unit: Unit;
    try {
      unit = parseUnit(out.unit);
    } catch {
      return bad(`has an invalid unit ${out.unit}`);
    }
    if (!sameDimension(unit, t.unit)) bad(`is in ${out.unit}, which does not measure the same thing as ${t.unit.code}`);
    const tag = out.tag ?? 'none';
    if (tag !== 'none' && tag !== t.tag) bad(`is ${TAG_LABEL[tag]}, but the input is declared as ${TAG_LABEL[t.tag ?? 'none']}`);
    const value = decimal(path, out.value);
    const converted = this.convertInto(path, value, unit, t.unit);
    return {
      value: { kind: 'quantity', value: converted, unit: t.unit, tag: t.tag },
      recorded: {
        path,
        kind: 'quantity',
        source: `calculation ${record.calculation ?? ''}`.trim(),
        value: out.value,
        unit: out.unit,
        ...(t.tag === null || t.tag === 'none' ? {} : { tag: t.tag }),
        derivedFrom: record.contentHash,
      },
    };
  }

  private typeOf(e: Expr): ExprType {
    const t = this.program.types.get(e);
    if (t === undefined) throw new Error('internal: expression not checked');
    return t;
  }

  private fail(code: 'DIVISION_BY_ZERO' | 'NUMERIC_RANGE' | 'DOMAIN_ERROR', message: string, node: Expr, fn?: string): never {
    throw new ExprEvaluationError(code, message, { paths: referencedPaths(node), span: node.span, ...(fn === undefined ? {} : { fn }) });
  }

  private guard<T>(node: Expr, divisor: Expr | undefined, f: () => T): T {
    try {
      return f();
    } catch (e) {
      if (e instanceof DecError) {
        if (e.code === 'DEC_DIVISION_BY_ZERO') this.fail('DIVISION_BY_ZERO', 'Division by zero', divisor ?? node);
        if (e.code === 'DEC_DOMAIN') this.fail('DOMAIN_ERROR', e.message, node);
        this.fail('NUMERIC_RANGE', `The result is outside the representable range (${e.message})`, node);
      }
      throw e;
    }
  }

  run(): EvaluationOutcome['value'] {
    const v = this.eval(this.program.ast);
    const out = this.program.outputType;
    if (out.kind === 'boolean') {
      if (v.kind !== 'boolean') throw new Error('internal: boolean result expected');
      return v;
    }
    if (v.kind !== 'quantity' || out.kind !== 'quantity') throw new Error('internal: quantity result expected');
    const r = this.guard(this.program.ast, undefined, () => convertValue(v.value, v.unit, out.unit));
    if (r.conversion !== null) this.conversions.push(recordConversion('output', r.conversion));
    return { kind: 'quantity', value: r.value, unit: out.unit, tag: out.tag };
  }

  private eval(e: Expr): RuntimeValue {
    switch (e.type) {
      case 'Number': {
        const t = this.typeOf(e);
        if (t.kind !== 'quantity') throw new Error('internal: number type');
        return { kind: 'quantity', value: Dec.parse(e.text), unit: t.unit, tag: null };
      }
      case 'Unit': {
        const t = this.typeOf(e);
        if (t.kind !== 'unit') throw new Error('internal: unit type');
        return { kind: 'unit', unit: t.unit };
      }
      case 'String':
        return { kind: 'string', value: e.value };
      case 'Bool':
        return { kind: 'boolean', value: e.value };
      case 'Path': {
        const b = this.bound.get(e.path);
        if (b === undefined) throw new ExprEvaluationError('MISSING_INPUT', `The value of "${e.path}" is missing; a calculation never assumes a value`, { paths: [e.path], span: e.span });
        this.read.set(e.path, b.recorded);
        return b.value;
      }
      case 'Unary': {
        const v = this.eval(e.operand);
        if (e.op === '!') {
          if (v.kind !== 'boolean') throw new Error('internal: boolean operand');
          return { kind: 'boolean', value: !v.value };
        }
        if (v.kind !== 'quantity') throw new Error('internal: quantity operand');
        return { ...v, value: v.value.neg(), tag: this.tagOf(e) };
      }
      case 'Binary':
        return this.binary(e);
      case 'Conditional': {
        const test = this.eval(e.test);
        if (test.kind !== 'boolean') throw new Error('internal: boolean condition');
        const branch = test.value ? e.consequent : e.alternate;
        const v = this.eval(branch);
        const t = this.typeOf(e);
        if (t.kind !== 'quantity' || v.kind !== 'quantity') return v;
        return this.toStaticUnit(v, t, e, '?:');
      }
      case 'Call':
        return this.call(e);
    }
  }

  private tagOf(e: Expr): Tag | null {
    const t = this.typeOf(e);
    return t.kind === 'quantity' ? t.tag : null;
  }

  private toStaticUnit(v: QuantityValue, t: QuantityType, node: Expr, what: string): QuantityValue {
    if (sameMagnitude(v.unit, t.unit)) return { ...v, unit: t.unit, tag: t.tag };
    const r = this.guard(node, undefined, () => convertValue(v.value, v.unit, t.unit));
    if (r.conversion !== null) this.conversions.push(recordConversion(`${what} at ${String(node.span.start)}-${String(node.span.end)}`, r.conversion));
    return { kind: 'quantity', value: r.value, unit: t.unit, tag: t.tag };
  }

  private quantityOf(v: RuntimeValue): QuantityValue {
    if (v.kind !== 'quantity') throw new Error('internal: quantity operand');
    return v;
  }

  private binary(e: BinaryExpr): RuntimeValue {
    if (e.op === '&&' || e.op === '||') {
      const l = this.eval(e.left);
      if (l.kind !== 'boolean') throw new Error('internal: boolean operand');
      if (e.op === '&&' ? !l.value : l.value) return l;
      const r = this.eval(e.right);
      if (r.kind !== 'boolean') throw new Error('internal: boolean operand');
      return r;
    }
    const l = this.eval(e.left);
    const r = this.eval(e.right);
    switch (e.op) {
      case '+':
      case '-':
        return this.addSub(e, this.quantityOf(l), this.quantityOf(r));
      case '*':
      case '/': {
        const a = this.quantityOf(l);
        const b = this.quantityOf(r);
        const value = this.guard(e, e.right, () => (e.op === '*' ? a.value.times(b.value) : a.value.div(b.value)));
        const unit = e.op === '*' ? multiplyUnits(a.unit, b.unit) : divideUnits(a.unit, b.unit);
        return { kind: 'quantity', value, unit, tag: this.tagOf(e) };
      }
      default:
        return { kind: 'boolean', value: this.compare(e, l, r) };
    }
  }

  private addSub(e: BinaryExpr, a: QuantityValue, b: QuantityValue): QuantityValue {
    const t = this.typeOf(e);
    if (t.kind !== 'quantity') throw new Error('internal: quantity type');
    const at = `${e.op} at ${String(e.span.start)}-${String(e.span.end)}`;
    const absA = a.unit.scale === 'ABSOLUTE_TEMPERATURE';
    const absB = b.unit.scale === 'ABSOLUTE_TEMPERATURE';
    let exact: Rational;
    if (absA && absB) {
      // Two absolute temperatures: their difference in kelvin, exact.
      if (!sameMagnitude(a.unit, b.unit)) this.conversions.push({ at, from: b.unit.code, to: a.unit.code, factor: factorText(rDiv(b.unit.factor, a.unit.factor)), exact: true });
      exact = rSub(toBaseRational(a.value, a.unit), toBaseRational(b.value, b.unit));
    } else if (absA || absB) {
      // Absolute temperature +/- a difference in K: the difference in degrees of the absolute scale.
      const abs = absA ? a : b;
      const diff = absA ? b : a;
      const degrees = rDiv(rMul(toRational(diff.value), diff.unit.factor), abs.unit.factor);
      if (!rCmpOne(diff.unit.factor, abs.unit.factor)) this.conversions.push({ at, from: diff.unit.code, to: `${abs.unit.code} degrees`, factor: factorText(rDiv(diff.unit.factor, abs.unit.factor)), exact: true });
      exact = e.op === '+' ? rAdd(toRational(abs.value), degrees) : rSub(toRational(abs.value), degrees);
    } else {
      let bv = toRational(b.value);
      if (!sameMagnitude(a.unit, b.unit)) {
        const f = linearFactor(b.unit, a.unit);
        bv = rMul(bv, f);
        this.conversions.push({ at, from: b.unit.code, to: a.unit.code, factor: factorText(f), exact: true });
      }
      exact = e.op === '+' ? rAdd(toRational(a.value), bv) : rSub(toRational(a.value), bv);
    }
    const value = this.guard(e, undefined, () => fromRational(exact).value);
    return { kind: 'quantity', value, unit: t.unit, tag: t.tag };
  }

  private compare(e: BinaryExpr, l: RuntimeValue, r: RuntimeValue): boolean {
    let c: -1 | 0 | 1;
    if (l.kind === 'quantity' && r.kind === 'quantity') {
      c = compareValues(l.value, l.unit, r.value, r.unit);
    } else if (l.kind === 'instant' && r.kind === 'instant') {
      c = l.epochMicros < r.epochMicros ? -1 : l.epochMicros > r.epochMicros ? 1 : 0;
    } else if (l.kind === 'boolean' && r.kind === 'boolean') {
      c = l.value === r.value ? 0 : 1;
    } else if ((l.kind === 'string' || l.kind === 'category' || l.kind === 'text') && (r.kind === 'string' || r.kind === 'category' || r.kind === 'text')) {
      c = l.value === r.value ? 0 : 1;
    } else {
      throw new Error('internal: comparison operands');
    }
    switch (e.op) {
      case '<':
        return c < 0;
      case '<=':
        return c <= 0;
      case '>':
        return c > 0;
      case '>=':
        return c >= 0;
      case '==':
        return c === 0;
      default:
        return c !== 0;
    }
  }

  private call(e: Extract<Expr, { type: 'Call' }>): RuntimeValue {
    const fn = LIBRARY.get(e.callee);
    if (fn === undefined) throw new Error('internal: unknown function');
    const args = e.args.map((a) => this.eval(a));
    const argPaths = e.args.map((a) => referencedPaths(a));
    const failArg = (code: 'DOMAIN_ERROR' | 'DIVISION_BY_ZERO' | 'EMPTY_SERIES', message: string, i?: number): never => {
      const node = i === undefined ? e : (e.args[i] ?? e);
      throw new ExprEvaluationError(code, message, { paths: referencedPaths(node), span: node.span, fn: fn.name });
    };
    const ctx: EvalContext = {
      callee: fn.name,
      span: e.span,
      argPaths,
      exact: (q, target) => {
        const v = toRational(q.value);
        if (sameMagnitude(q.unit, target)) return v;
        const f = linearFactor(q.unit, target);
        this.conversions.push({ at: `${fn.name}()`, from: q.unit.code, to: target.code, factor: factorText(f), exact: true });
        return rMul(v, f);
      },
      result: (r, unit, tag) => ({ kind: 'quantity', value: this.guard(e, undefined, () => fromRational(r).value), unit, tag }),
      convert: (q, target) => {
        const r = this.guard(e, undefined, () => convertValue(q.value, q.unit, target));
        if (r.conversion !== null) this.conversions.push(recordConversion(`${fn.name}()`, r.conversion));
        return { kind: 'quantity', value: r.value, unit: target, tag: q.tag };
      },
      domain: (message, i) => failArg('DOMAIN_ERROR', message, i),
      divisionByZero: (message, i) => failArg('DIVISION_BY_ZERO', message, i),
      emptySeries: (i) => failArg('EMPTY_SERIES', `${fn.name}: the recorded series has no values`, i),
      lookup: (tableId, key) => this.lookup(e, tableId, key),
    };
    const v = this.guard(e, undefined, () => fn.evaluate(args, ctx));
    const t = this.typeOf(e);
    if (v.kind === 'quantity' && t.kind === 'quantity') return this.toStaticUnit(v, t, e, `${fn.name}()`);
    return v;
  }

  private lookup(e: Expr, tableId: string, key: QuantityValue): QuantityValue {
    const fail = (message: string): never => {
      throw new ExprEvaluationError('TABLE_LOOKUP_FAILED', message, { paths: referencedPaths(e), span: e.span, fn: 'table_lookup' });
    };
    const table = this.tables[tableId];
    const pinned = this.program.tables.find((t) => t.id === tableId);
    if (table === undefined) fail(`Acceptance table "${tableId}" is not available`);
    if (pinned !== undefined && pinned.version !== table.version) fail(`Acceptance table "${tableId}" is version ${table.version}, but the calculation was checked against version ${pinned.version}`);
    const keyUnit = parseUnit(table.key.unit);
    const exactKey = rDiv(toBaseRational(key.value, key.unit), keyUnit.factor);
    if (!sameMagnitude(key.unit, keyUnit)) this.conversions.push({ at: 'table_lookup()', from: key.unit.code, to: keyUnit.code, factor: factorText(linearFactor(key.unit, keyUnit)), exact: true });
    const hit = lookupAcceptanceTable(table, exactKey);
    const shownKey = fromRational(exactKey).value.toString();
    if (hit === undefined) fail(`Acceptance table "${tableId}" has no row for ${shownKey} ${table.key.unit}`);
    this.lookups.push({ table: table.id, version: table.version, row: hit.row + 1, key: shownKey, keyUnit: table.key.unit, result: hit.result.toString(), resultUnit: table.result.unit });
    return { kind: 'quantity', value: hit.result, unit: parseUnit(table.result.unit), tag: table.result.tag ?? 'none' };
  }
}

function rCmpOne(a: Rational, b: Rational): boolean {
  return rCmp(a, b) === 0;
}

/** Evaluates a checked program against input values. Throws ExprEvaluationError. */
export function runProgram(program: ProgramCore, inputs: InputValues, tables: AcceptanceTableCatalog = {}): EvaluationOutcome {
  const ev = new Evaluation(program, tables, inputs);
  const value = ev.run();
  const read = [...ev.read.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { value, inputs: read, conversions: ev.conversions, tableLookups: ev.lookups };
}
