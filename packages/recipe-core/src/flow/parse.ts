/**
 * Parses untrusted JSON into an `MbrContent` (the "validator function" of the content model).
 *
 * Refuses unknown fields, JSON numbers where a GMP value is expected (decimals travel as strings),
 * non-integer counts, malformed identifiers and wrong enumerations. Every problem carries a JSON path
 * so the designer can point at it. This checks shape only; meaning is the static validator's job.
 * Content holding text no record can hold (U+0000, a lone surrogate) is refused before anything else
 * (review F32).
 */
import { unstorableText } from '@ebmr/expr';
import { LIMIT_SOURCE_KINDS, LIMIT_TIERS, ROUNDING_RULES } from '../limits/model.ts';
import type { AcceptanceCriterion, AcceptanceScheme, LimitBound, LimitRange, LimitSource, LimitSpec, SamplingNeed } from '../limits/model.ts';
import { isDecimalLiteral } from './decimal.ts';
import {
  EDITIONS,
  MBR_FORMAT,
  MBR_FORMAT_VERSION,
  REDUCTION_KINDS,
  REFERENCE_KINDS,
  type AlternativeBranch,
  type BomLine,
  type BomOverage,
  type Calculation,
  type Decision,
  type EventRef,
  type ExternalInput,
  type FlowNode,
  type GoldenCase,
  type GoldenValue,
  type Intermediate,
  type JsonValue,
  type LibraryElement,
  type MbrContent,
  type MbrHeader,
  type Parameter,
  type PhaseNode,
  type Quantity,
  type Reference,
  type ReplicateCount,
  type RiskReduction,
  type StageEquipment,
  type StageNode,
  type TimeConstraint,
  type YieldCheckpoint,
} from './model.ts';

export interface ParseProblem {
  path: string;
  message: string;
}

export type ParseResult = { ok: true; mbr: MbrContent } | { ok: false; problems: ParseProblem[] };

/** Ids of nodes and items: letters, digits, '_', '-', '.', '/' (library-inlined ids use '/'). */
const ID = /^[A-Za-z][A-Za-z0-9_.\-/]{0,95}$/;
/** Ids that expressions refer to must be plain identifiers. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;

/** Maximum loop iterations and replicate instances accepted in a master record. */
export const MAX_LOOP_ITERATIONS = 100;
export const MAX_REPLICATE_INSTANCES = 500;
/** Maximum nesting of flow nodes (a guard against hostile input; real MBRs nest far less). */
export const MAX_FLOW_DEPTH = 64;

class Reader {
  readonly problems: ParseProblem[] = [];
  depth = 0;

  fail(path: string, message: string): undefined {
    this.problems.push({ path, message });
    return undefined;
  }

  object(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return this.fail(path, 'must be an object');
    const o = value as Record<string, unknown>;
    for (const key of Object.keys(o)) {
      if (!required.includes(key) && !optional.includes(key)) this.fail(`${path}.${key}`, 'is not a known field (unknown fields are refused)');
    }
    for (const key of required) if (!(key in o)) this.fail(`${path}.${key}`, 'is required');
    return o;
  }

  string(o: Record<string, unknown>, key: string, path: string, pattern?: RegExp): string | undefined {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length === 0) return this.fail(`${path}.${key}`, 'must be a non-empty string');
    if (pattern && !pattern.test(v)) return this.fail(`${path}.${key}`, `has an invalid format (${JSON.stringify(v)})`);
    return v;
  }

  id(o: Record<string, unknown>, key: string, path: string): string | undefined {
    return this.string(o, key, path, ID);
  }

  decimal(o: Record<string, unknown>, key: string, path: string): string | undefined {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v === 'number') return this.fail(`${path}.${key}`, 'is a JSON number: GMP values travel as decimal strings');
    if (!isDecimalLiteral(v)) return this.fail(`${path}.${key}`, `must be a decimal literal string (got ${JSON.stringify(v)})`);
    return v;
  }

  integer(o: Record<string, unknown>, key: string, path: string, min: number, max: number): number | undefined {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) return this.fail(`${path}.${key}`, `must be an integer from ${min} to ${max}`);
    return v;
  }

  boolean(o: Record<string, unknown>, key: string, path: string): boolean | undefined {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') return this.fail(`${path}.${key}`, 'must be true or false');
    return v;
  }

  literal<T extends string>(o: Record<string, unknown>, key: string, path: string, values: readonly T[]): T | undefined {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) return this.fail(`${path}.${key}`, `must be one of ${values.join(', ')}`);
    return v as T;
  }

  array<T>(o: Record<string, unknown>, key: string, path: string, item: (value: unknown, path: string) => T | undefined): T[] | undefined {
    const v = o[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) return this.fail(`${path}.${key}`, 'must be an array');
    const out: T[] = [];
    v.forEach((element, i) => {
      const parsed = item(element, `${path}.${key}[${i}]`);
      if (parsed !== undefined) out.push(parsed);
    });
    return out;
  }

  strings(o: Record<string, unknown>, key: string, path: string, pattern?: RegExp): string[] | undefined {
    return this.array(o, key, path, (v, p) => {
      if (typeof v !== 'string' || v.length === 0) return this.fail(p, 'must be a non-empty string');
      if (pattern && !pattern.test(v)) return this.fail(p, `has an invalid format (${JSON.stringify(v)})`);
      return v;
    });
  }

  json(value: unknown, path: string): JsonValue | undefined {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) return this.fail(path, 'is a non-integer JSON number: decimals travel as strings');
      return value;
    }
    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      value.forEach((v, i) => {
        const parsed = this.json(v, `${path}[${i}]`);
        if (parsed !== undefined) out.push(parsed);
      });
      return out;
    }
    if (typeof value === 'object') {
      const out: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const parsed = this.json(v, `${path}.${k}`);
        if (parsed !== undefined) out[k] = parsed;
      }
      return out;
    }
    return this.fail(path, `a ${typeof value} is not JSON`);
  }
}

/** Assigns `value` to `target[key]` only when it is defined (exactOptionalPropertyTypes). */
function opt<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function need<T>(value: T | undefined): T {
  // Only called after all problems were collected and none exist; a missing value here is a bug.
  if (value === undefined) throw new Error('internal: parse produced an incomplete value without a problem');
  return value;
}

function quantity(r: Reader, v: unknown, path: string): Quantity | undefined {
  const o = r.object(v, path, ['value', 'unit']);
  if (!o) return undefined;
  const value = r.decimal(o, 'value', path);
  const unit = r.string(o, 'unit', path);
  return value !== undefined && unit !== undefined ? { value, unit } : undefined;
}

function limitSource(r: Reader, v: unknown, path: string): LimitSource | undefined {
  const o = r.object(v, path, ['kind', 'ref']);
  if (!o) return undefined;
  const kind = r.literal(o, 'kind', path, LIMIT_SOURCE_KINDS);
  const ref = r.id(o, 'ref', path);
  return kind && ref ? { kind, ref } : undefined;
}

function bound(r: Reader, v: unknown, path: string): LimitBound | undefined {
  const o = r.object(v, path, ['value', 'inclusive']);
  if (!o) return undefined;
  const value = r.decimal(o, 'value', path);
  const inclusive = r.boolean(o, 'inclusive', path);
  return value !== undefined && inclusive !== undefined ? { value, inclusive } : undefined;
}

function limitRange(r: Reader, v: unknown, path: string): LimitRange | undefined {
  const o = r.object(v, path, ['tier', 'rounding', 'source'], ['low', 'high', 'pharmacopoeia']);
  if (!o) return undefined;
  const tier = r.literal(o, 'tier', path, LIMIT_TIERS);
  const rounding = r.literal(o, 'rounding', path, ROUNDING_RULES);
  const source = o['source'] === undefined ? undefined : limitSource(r, o['source'], `${path}.source`);
  const low = o['low'] === undefined ? undefined : bound(r, o['low'], `${path}.low`);
  const high = o['high'] === undefined ? undefined : bound(r, o['high'], `${path}.high`);
  let pharmacopoeia: LimitRange['pharmacopoeia'];
  if (o['pharmacopoeia'] !== undefined) {
    const p = r.object(o['pharmacopoeia'], `${path}.pharmacopoeia`, ['code', 'edition']);
    if (p) {
      const code = r.string(p, 'code', `${path}.pharmacopoeia`);
      const edition = r.string(p, 'edition', `${path}.pharmacopoeia`);
      if (code && edition) pharmacopoeia = { code, edition };
    }
  }
  if (!tier || !rounding || !source) return undefined;
  const range: LimitRange = { tier, rounding, source };
  opt(range, 'low', low);
  opt(range, 'high', high);
  opt(range, 'pharmacopoeia', pharmacopoeia);
  return range;
}

function limitSpec(r: Reader, v: unknown, path: string): LimitSpec | undefined {
  const o = r.object(v, path, ['unit', 'ranges'], ['actionBreach']);
  if (!o) return undefined;
  const unit = r.string(o, 'unit', path);
  const ranges = r.array(o, 'ranges', path, (x, p) => limitRange(r, x, p));
  const actionBreach = r.literal(o, 'actionBreach', path, ['STOP_DEPENDENT_STEP', 'CONTINUE_CURRENT_STEP_WITH_DEVIATION'] as const);
  if (!unit || !ranges) return undefined;
  const spec: LimitSpec = { unit, ranges };
  opt(spec, 'actionBreach', actionBreach);
  return spec;
}

function marketRule(r: Reader, v: unknown, path: string): { key: string; bound: 'LOW' | 'HIGH' } | undefined {
  const o = r.object(v, path, ['key', 'bound']);
  if (!o) return undefined;
  const key = r.string(o, 'key', path, /^[a-z]+(\.[A-Za-z0-9_]+)+$/);
  const b = r.literal(o, 'bound', path, ['LOW', 'HIGH'] as const);
  return key && b ? { key, bound: b } : undefined;
}

function header(r: Reader, v: unknown, path: string): MbrHeader | undefined {
  const o = r.object(v, path, ['family', 'title', 'edition', 'recordKind', 'product', 'batchSizes', 'marketSet', 'predicates', 'variants'], ['packType', 'unitMassMg', 'criticalityAssessment']);
  if (!o) return undefined;
  const family = r.id(o, 'family', path);
  const title = r.string(o, 'title', path);
  const edition = r.literal(o, 'edition', path, EDITIONS);
  const recordKind = r.literal(o, 'recordKind', path, ['PROCESSING', 'PACKAGING', 'REPROCESSING'] as const);
  let product: MbrHeader['product'] | undefined;
  const p = r.object(o['product'], `${path}.product`, ['code', 'name', 'strength', 'dosageForm']);
  if (p) {
    const code = r.string(p, 'code', `${path}.product`);
    const name = r.string(p, 'name', `${path}.product`);
    const strength = r.string(p, 'strength', `${path}.product`);
    const dosageForm = r.string(p, 'dosageForm', `${path}.product`);
    if (code && name && strength && dosageForm) product = { code, name, strength, dosageForm };
  }
  const batchSizes = r.array(o, 'batchSizes', path, (x, bp) => {
    const b = r.object(x, bp, ['id', 'quantity']);
    if (!b) return undefined;
    const id = r.id(b, 'id', bp);
    const q = b['quantity'] === undefined ? undefined : quantity(r, b['quantity'], `${bp}.quantity`);
    return id && q ? { id, quantity: q } : undefined;
  });
  const marketSet = r.strings(o, 'marketSet', path, /^[A-Z]{2}$/);
  const predicates: Record<string, string | boolean> = {};
  const po = r.object(o['predicates'], `${path}.predicates`, Object.keys((o['predicates'] as object | null) ?? {}));
  if (po) {
    for (const [k, val] of Object.entries(po)) {
      if (typeof val === 'string' || typeof val === 'boolean') predicates[k] = val;
      else r.fail(`${path}.predicates.${k}`, 'must be a string or boolean');
    }
  }
  const variants = r.array(o, 'variants', path, (x, vp) => {
    const vo = r.object(x, vp, ['id', 'values']);
    if (!vo) return undefined;
    const id = r.id(vo, 'id', vp);
    const values = r.strings(vo, 'values', vp);
    return id && values ? { id, values } : undefined;
  });
  // D-P4-13: a packaging master names its pack type (part of its family's identity with the product and the pack size).
  const packType = r.string(o, 'packType', path, /^[A-Z0-9][A-Z0-9-]{0,31}$/);
  if (packType !== undefined && recordKind !== undefined && recordKind !== 'PACKAGING') r.fail(`${path}.packType`, 'is named only by a packaging master (D-P4-13)');
  if (!family || !title || !edition || !recordKind || !product || !batchSizes || !marketSet || !variants) return undefined;
  const unitMassMg = r.string(o, 'unitMassMg', path, /^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
  if (unitMassMg !== undefined && /^0(\.0*)?$/.test(unitMassMg)) r.fail(`${path}.unitMassMg`, 'is the mass of one unit, above zero');
  const criticalityAssessment = r.id(o, 'criticalityAssessment', path);
  return {
    family, title, edition, recordKind, product, batchSizes, marketSet, predicates, variants,
    ...(packType !== undefined ? { packType } : {}),
    ...(unitMassMg !== undefined ? { unitMassMg } : {}),
    ...(criticalityAssessment !== undefined ? { criticalityAssessment } : {}),
  };
}

function reference(r: Reader, v: unknown, path: string): Reference | undefined {
  const o = r.object(v, path, ['id', 'kind', 'code', 'version'], ['hash', 'title']);
  if (!o) return undefined;
  const id = r.id(o, 'id', path);
  const kind = r.literal(o, 'kind', path, REFERENCE_KINDS);
  const code = r.string(o, 'code', path);
  const version = r.string(o, 'version', path);
  const hash = r.string(o, 'hash', path, HASH);
  const title = r.string(o, 'title', path);
  if (!id || !kind || !code || !version) return undefined;
  const ref: Reference = { id, kind, code, version };
  opt(ref, 'hash', hash);
  opt(ref, 'title', title);
  return ref;
}

const VALUE_KINDS = ['DECIMAL', 'COUNT', 'BOOLEAN', 'CATEGORY', 'TEXT', 'INSTANT'] as const;

function externalInput(r: Reader, v: unknown, path: string): ExternalInput | undefined {
  const o = r.object(v, path, ['id', 'name', 'source', 'valueType'], ['unit', 'categories', 'ref']);
  if (!o) return undefined;
  const id = r.string(o, 'id', path, IDENT);
  const name = r.string(o, 'name', path);
  const source = r.literal(o, 'source', path, ['BATCH_HEADER', 'MASTER_DATA'] as const);
  const valueType = r.literal(o, 'valueType', path, VALUE_KINDS);
  const unit = r.string(o, 'unit', path);
  const categories = r.strings(o, 'categories', path);
  const ref = r.id(o, 'ref', path);
  if (!id || !name || !source || !valueType) return undefined;
  const input: ExternalInput = { id, name, source, valueType };
  opt(input, 'unit', unit);
  opt(input, 'categories', categories);
  opt(input, 'ref', ref);
  return input;
}

function bomLine(r: Reader, v: unknown, path: string): BomLine | undefined {
  const o = r.object(v, path, ['id', 'material', 'role', 'quantity'], ['specimen', 'overage']);
  if (!o) return undefined;
  const id = r.id(o, 'id', path);
  const material = r.id(o, 'material', path);
  const role = r.literal(o, 'role', path, ['ACTIVE', 'EXCIPIENT', 'PROCESSING_AID', 'PRIMARY_PACKAGING', 'PRINTED_COMPONENT', 'OTHER'] as const);
  const q = o['quantity'] === undefined ? undefined : quantity(r, o['quantity'], `${path}.quantity`);
  const specimen = r.id(o, 'specimen', path);
  const overage = o['overage'] === undefined ? undefined : bomOverage(r, o['overage'], `${path}.overage`);
  if (!id || !material || !role || !q) return undefined;
  const line: BomLine = { id, material, role, quantity: q };
  opt(line, 'specimen', specimen);
  opt(line, 'overage', overage);
  return line;
}

/** Slice 7q (C1): the overage a BOM line's standard quantity includes, a percent or a quantity, with its reason. */
function bomOverage(r: Reader, v: unknown, path: string): BomOverage | undefined {
  const o = r.object(v, path, ['reason'], ['percent', 'quantity']);
  if (!o) return undefined;
  const reason = r.string(o, 'reason', path);
  const percent = r.decimal(o, 'percent', path);
  const q = o['quantity'] === undefined ? undefined : quantity(r, o['quantity'], `${path}.quantity`);
  if ((percent === undefined) === (q === undefined)) return r.fail(path, 'states the overage as a percent or as a quantity, exactly one');
  if (!reason) return undefined;
  const out: BomOverage = { reason };
  opt(out, 'percent', percent);
  opt(out, 'quantity', q);
  return out;
}

function intermediate(r: Reader, v: unknown, path: string): Intermediate | undefined {
  const o = r.object(v, path, ['id', 'name'], ['holdTime', 'finalOutput']);
  if (!o) return undefined;
  const id = r.id(o, 'id', path);
  const name = r.string(o, 'name', path);
  const finalOutput = r.boolean(o, 'finalOutput', path);
  let holdTime: Intermediate['holdTime'];
  if (o['holdTime'] !== undefined) {
    const h = r.object(o['holdTime'], `${path}.holdTime`, ['max', 'source'], ['storage']);
    if (h) {
      const max = h['max'] === undefined ? undefined : quantity(r, h['max'], `${path}.holdTime.max`);
      const source = h['source'] === undefined ? undefined : limitSource(r, h['source'], `${path}.holdTime.source`);
      const storage = r.string(h, 'storage', `${path}.holdTime`);
      if (max && source) {
        holdTime = { max, source };
        opt(holdTime, 'storage', storage);
      }
    }
  }
  if (!id || !name) return undefined;
  const out: Intermediate = { id, name };
  opt(out, 'holdTime', holdTime);
  opt(out, 'finalOutput', finalOutput);
  return out;
}

function parameter(r: Reader, v: unknown, path: string): Parameter | undefined {
  const o = r.object(
    v,
    path,
    ['id', 'name', 'valueType', 'role', 'criticality', 'riskClass', 'capture'],
    ['unit', 'semanticTag', 'precision', 'categories', 'readings', 'evidence', 'accuracyCheck', 'target', 'limits', 'marketRule'],
  );
  if (!o) return undefined;
  const id = r.string(o, 'id', path, IDENT);
  const name = r.string(o, 'name', path);
  const valueType = r.literal(o, 'valueType', path, VALUE_KINDS);
  const role = r.literal(o, 'role', path, ['PROCESS_PARAMETER', 'IPC', 'PROCESS_ENDPOINT', 'ACCEPTANCE_TEST', 'RELEASE_TEST', 'QUANTITY', 'OBSERVATION'] as const);
  const criticality = r.literal(o, 'criticality', path, ['CRITICAL', 'NON_CRITICAL'] as const);
  const riskClass = r.string(o, 'riskClass', path);
  const capture = r.literal(o, 'capture', path, ['MANUAL', 'DEVICE', 'AUTOMATION', 'SCAN', 'LIMS'] as const);
  const unit = r.string(o, 'unit', path);
  const semanticTag = r.string(o, 'semanticTag', path);
  let precision: Parameter['precision'];
  if (o['precision'] !== undefined) {
    const po = r.object(o['precision'], `${path}.precision`, ['kind', 'digits']);
    if (po) {
      const kind = r.literal(po, 'kind', `${path}.precision`, ['DECIMALS', 'SIGNIFICANT_FIGURES'] as const);
      const digits = r.integer(po, 'digits', `${path}.precision`, 0, 34);
      if (kind && digits !== undefined) precision = { kind, digits };
    }
  }
  const categories = r.strings(o, 'categories', path);
  const readings = r.integer(o, 'readings', path, 1, 10_000);
  const evidence = r.literal(o, 'evidence', path, ['NONE', 'PHOTO', 'PRINTOUT'] as const);
  const accuracyCheck = r.literal(o, 'accuracyCheck', path, ['SECOND_PERSON', 'VALIDATED_DEVICE'] as const);
  const target = r.decimal(o, 'target', path);
  const limits = o['limits'] === undefined ? undefined : limitSpec(r, o['limits'], `${path}.limits`);
  const mr = o['marketRule'] === undefined ? undefined : marketRule(r, o['marketRule'], `${path}.marketRule`);
  if (!id || !name || !valueType || !role || !criticality || !riskClass || !capture) return undefined;
  const out: Parameter = { id, name, valueType, role, criticality, riskClass, capture };
  opt(out, 'unit', unit);
  opt(out, 'semanticTag', semanticTag);
  opt(out, 'precision', precision);
  opt(out, 'categories', categories);
  opt(out, 'readings', readings);
  opt(out, 'evidence', evidence);
  opt(out, 'accuracyCheck', accuracyCheck);
  opt(out, 'target', target);
  opt(out, 'limits', limits);
  opt(out, 'marketRule', mr);
  return out;
}

function calculation(r: Reader, v: unknown, path: string): Calculation | undefined {
  const o = r.object(v, path, ['id', 'name', 'expression', 'output', 'criticality', 'riskClass'], ['limits']);
  if (!o) return undefined;
  const id = r.string(o, 'id', path, IDENT);
  const name = r.string(o, 'name', path);
  const expression = r.string(o, 'expression', path);
  const criticality = r.literal(o, 'criticality', path, ['CRITICAL', 'NON_CRITICAL'] as const);
  const riskClass = r.string(o, 'riskClass', path);
  let output: Calculation['output'] | undefined;
  const oo = r.object(o['output'], `${path}.output`, ['valueType'], ['unit', 'semanticTag']);
  if (oo) {
    const valueType = r.literal(oo, 'valueType', `${path}.output`, ['DECIMAL', 'COUNT', 'BOOLEAN'] as const);
    const unit = r.string(oo, 'unit', `${path}.output`);
    const semanticTag = r.string(oo, 'semanticTag', `${path}.output`);
    if (valueType) {
      output = { valueType };
      opt(output, 'unit', unit);
      opt(output, 'semanticTag', semanticTag);
    }
  }
  const limits = o['limits'] === undefined ? undefined : limitSpec(r, o['limits'], `${path}.limits`);
  if (!id || !name || !expression || !output || !criticality || !riskClass) return undefined;
  const out: Calculation = { id, name, expression, output, criticality, riskClass };
  opt(out, 'limits', limits);
  return out;
}

function yieldCheckpoint(r: Reader, v: unknown, path: string): YieldCheckpoint | undefined {
  const o = r.object(v, path, ['id', 'name', 'kind', 'theoretical', 'result', 'basis'], ['limits']);
  if (!o) return undefined;
  const id = r.id(o, 'id', path);
  const name = r.string(o, 'name', path);
  const kind = r.literal(o, 'kind', path, ['YIELD', 'RECONCILIATION'] as const);
  const theoretical = r.string(o, 'theoretical', path, IDENT);
  const result = r.string(o, 'result', path, IDENT);
  const basis = r.literal(o, 'basis', path, ['AS_IS', 'DRY', 'COUNT'] as const);
  const limits = o['limits'] === undefined ? undefined : limitSpec(r, o['limits'], `${path}.limits`);
  if (!id || !name || !kind || !theoretical || !result || !basis) return undefined;
  const out: YieldCheckpoint = { id, name, kind, theoretical, result, basis };
  opt(out, 'limits', limits);
  return out;
}

function samplingNeed(r: Reader, v: unknown, path: string): SamplingNeed | undefined {
  const o = r.object(v, path, ['point', 'purpose', 'units', 'destructive']);
  if (!o) return undefined;
  const point = r.string(o, 'point', path);
  const purpose = r.string(o, 'purpose', path);
  const units = r.integer(o, 'units', path, 1, 100_000);
  const destructive = r.boolean(o, 'destructive', path);
  return point && purpose && units !== undefined && destructive !== undefined ? { point, purpose, units, destructive } : undefined;
}

function acceptanceScheme(r: Reader, v: unknown, path: string): AcceptanceScheme | undefined {
  const o = r.object(v, path, ['id', 'title', 'method', 'criteria']);
  if (!o) return undefined;
  const id = r.id(o, 'id', path);
  const title = r.string(o, 'title', path);
  const method = r.literal(o, 'method', path, ['ALL_APPLY'] as const);
  const criteria = r.array(o, 'criteria', path, (x, cp): AcceptanceCriterion | undefined => {
    const c = r.object(x, cp, ['id', 'title', 'governingMarkets', 'pharmacopoeia', 'statistic', 'unit', 'range', 'sampling']);
    if (!c) return undefined;
    const cid = r.id(c, 'id', cp);
    const ctitle = r.string(c, 'title', cp);
    const governingMarkets = r.strings(c, 'governingMarkets', cp, /^[A-Z]{2}$/);
    let pharmacopoeia: AcceptanceCriterion['pharmacopoeia'] | undefined;
    const po = r.object(c['pharmacopoeia'], `${cp}.pharmacopoeia`, ['code', 'edition']);
    if (po) {
      const code = r.string(po, 'code', `${cp}.pharmacopoeia`);
      const edition = r.string(po, 'edition', `${cp}.pharmacopoeia`);
      if (code && edition) pharmacopoeia = { code, edition };
    }
    const statistic = r.string(c, 'statistic', cp, IDENT);
    const cunit = r.string(c, 'unit', cp);
    const range = c['range'] === undefined ? undefined : limitRange(r, c['range'], `${cp}.range`);
    const sampling = r.array(c, 'sampling', cp, (s, sp) => samplingNeed(r, s, sp));
    if (!cid || !ctitle || !governingMarkets || !pharmacopoeia || !statistic || !cunit || !range || !sampling) return undefined;
    return { id: cid, title: ctitle, governingMarkets, pharmacopoeia, statistic, unit: cunit, range, sampling };
  });
  if (!id || !title || !method || !criteria) return undefined;
  return { id, title, method, criteria };
}

function eventRef(r: Reader, v: unknown, path: string): EventRef | undefined {
  if (typeof v === 'object' && v !== null && 'external' in v) {
    const o = r.object(v, path, ['external', 'description']);
    if (!o) return undefined;
    const external = r.id(o, 'external', path);
    const description = r.string(o, 'description', path);
    return external && description ? { external, description } : undefined;
  }
  const o = r.object(v, path, ['node', 'event']);
  if (!o) return undefined;
  const node = r.id(o, 'node', path);
  const event = r.literal(o, 'event', path, ['START', 'END'] as const);
  return node && event ? { node, event } : undefined;
}

function timeConstraint(r: Reader, v: unknown, path: string): TimeConstraint | undefined {
  const o = r.object(v, path, ['id', 'name', 'kind', 'from', 'to', 'breach', 'pauses'], ['min', 'max', 'warnBefore', 'source', 'marketRule']);
  if (!o) return undefined;
  const id = r.id(o, 'id', path);
  const name = r.string(o, 'name', path);
  const kind = r.literal(o, 'kind', path, ['TIMER', 'HOLD', 'PROCESS_WINDOW', 'USE_BY', 'EXPOSURE'] as const);
  const from = o['from'] === undefined ? undefined : eventRef(r, o['from'], `${path}.from`);
  const to = o['to'] === undefined ? undefined : eventRef(r, o['to'], `${path}.to`);
  const breach = r.literal(o, 'breach', path, ['EXCEPTION', 'EXCEPTION_AND_BLOCK'] as const);
  const pauses = r.literal(o, 'pauses', path, ['INCLUDED', 'EXCLUDED'] as const);
  const min = o['min'] === undefined ? undefined : quantity(r, o['min'], `${path}.min`);
  const max = o['max'] === undefined ? undefined : quantity(r, o['max'], `${path}.max`);
  const warnBefore = o['warnBefore'] === undefined ? undefined : quantity(r, o['warnBefore'], `${path}.warnBefore`);
  const source = o['source'] === undefined ? undefined : limitSource(r, o['source'], `${path}.source`);
  const mr = o['marketRule'] === undefined ? undefined : marketRule(r, o['marketRule'], `${path}.marketRule`);
  if (!id || !name || !kind || !from || !to || !breach || !pauses) return undefined;
  const out: TimeConstraint = { id, name, kind, from, to, breach, pauses };
  opt(out, 'min', min);
  opt(out, 'max', max);
  opt(out, 'warnBefore', warnBefore);
  opt(out, 'source', source);
  opt(out, 'marketRule', mr);
  return out;
}

function riskReduction(r: Reader, v: unknown, path: string): RiskReduction | undefined {
  const o = r.object(v, path, ['id', 'kind', 'subjects'], ['riskClass', 'rationale', 'validationRef']);
  if (!o) return undefined;
  const id = r.id(o, 'id', path);
  const kind = r.literal(o, 'kind', path, REDUCTION_KINDS);
  const subjects = r.strings(o, 'subjects', path, ID);
  const riskClass = r.string(o, 'riskClass', path);
  const rationale = r.id(o, 'rationale', path);
  const validationRef = r.string(o, 'validationRef', path);
  if (!id || !kind || !subjects) return undefined;
  const out: RiskReduction = { id, kind, subjects };
  opt(out, 'riskClass', riskClass);
  opt(out, 'rationale', rationale);
  opt(out, 'validationRef', validationRef);
  return out;
}

function goldenValue(r: Reader, v: unknown, path: string): GoldenValue | undefined {
  if (typeof v === 'object' && v !== null && 'bool' in v) {
    const o = r.object(v, path, ['bool']);
    const b = o ? r.boolean(o, 'bool', path) : undefined;
    return b === undefined ? undefined : { bool: b };
  }
  if (typeof v === 'object' && v !== null && 'series' in v) {
    const o = r.object(v, path, ['series'], ['unit']);
    if (!o) return undefined;
    const series = r.array(o, 'series', path, (x, p) => {
      if (typeof x === 'number') return r.fail(p, 'is a JSON number: GMP values travel as decimal strings');
      return isDecimalLiteral(x) ? x : r.fail(p, 'must be a decimal literal string');
    });
    const unit = r.string(o, 'unit', path);
    if (!series) return undefined;
    const out: { series: string[]; unit?: string } = { series };
    opt(out, 'unit', unit);
    return out;
  }
  if (typeof v === 'object' && v !== null && 'category' in v) {
    const o = r.object(v, path, ['category']);
    const c = o ? r.string(o, 'category', path) : undefined;
    return c === undefined ? undefined : { category: c };
  }
  const o = r.object(v, path, ['value'], ['unit']);
  if (!o) return undefined;
  const value = r.decimal(o, 'value', path);
  const unit = r.string(o, 'unit', path);
  if (value === undefined) return undefined;
  const out: { value: string; unit?: string } = { value };
  opt(out, 'unit', unit);
  return out;
}

function goldenCase(r: Reader, v: unknown, path: string): GoldenCase | undefined {
  const o = r.object(v, path, ['id', 'description', 'inputs', 'expected']);
  if (!o) return undefined;
  const id = r.id(o, 'id', path);
  const description = r.string(o, 'description', path);
  const readMap = (key: string): Record<string, GoldenValue> | undefined => {
    const m = o[key];
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return r.fail(`${path}.${key}`, 'must be an object');
    const out: Record<string, GoldenValue> = {};
    for (const [k, val] of Object.entries(m as Record<string, unknown>)) {
      if (!IDENT.test(k)) r.fail(`${path}.${key}.${k}`, 'is not an identifier');
      const g = goldenValue(r, val, `${path}.${key}.${k}`);
      if (g) out[k] = g;
    }
    return out;
  };
  const inputs = readMap('inputs');
  const expected = readMap('expected');
  return id && description && inputs && expected ? { id, description, inputs, expected } : undefined;
}

function decision(r: Reader, v: unknown, path: string): Decision | undefined {
  const mode = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)['mode'] : undefined;
  if (mode === 'DATA') {
    r.object(v, path, ['mode']);
    return { mode: 'DATA' };
  }
  if (mode === 'OPERATOR_CHOICE') {
    const o = r.object(v, path, ['mode', 'roles', 'reasonRequired']);
    if (!o) return undefined;
    const roles = r.strings(o, 'roles', path);
    if (o['reasonRequired'] !== true) r.fail(`${path}.reasonRequired`, 'must be true: an operator choice always needs a reason');
    return roles && o['reasonRequired'] === true ? { mode: 'OPERATOR_CHOICE', roles, reasonRequired: true } : undefined;
  }
  if (mode === 'ISSUE_VARIANT') {
    const o = r.object(v, path, ['mode', 'variant']);
    const variant = o ? r.id(o, 'variant', path) : undefined;
    return variant ? { mode: 'ISSUE_VARIANT', variant } : undefined;
  }
  return r.fail(`${path}.mode`, 'must be DATA, OPERATOR_CHOICE or ISSUE_VARIANT');
}

function replicateCount(r: Reader, v: unknown, path: string): ReplicateCount | undefined {
  const mode = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)['mode'] : undefined;
  if (mode === 'EXPRESSION') {
    const o = r.object(v, path, ['mode', 'expression', 'min', 'max']);
    if (!o) return undefined;
    const expression = r.string(o, 'expression', path);
    const min = r.integer(o, 'min', path, 1, MAX_REPLICATE_INSTANCES);
    const max = r.integer(o, 'max', path, 1, MAX_REPLICATE_INSTANCES);
    return expression && min !== undefined && max !== undefined ? { mode: 'EXPRESSION', expression, min, max } : undefined;
  }
  if (mode === 'RUNTIME') {
    const o = r.object(v, path, ['mode', 'min', 'max', 'reasonRequired']);
    if (!o) return undefined;
    const min = r.integer(o, 'min', path, 1, MAX_REPLICATE_INSTANCES);
    const max = r.integer(o, 'max', path, 1, MAX_REPLICATE_INSTANCES);
    if (o['reasonRequired'] !== true) r.fail(`${path}.reasonRequired`, 'must be true: a count chosen at run time always needs a reason');
    return min !== undefined && max !== undefined && o['reasonRequired'] === true ? { mode: 'RUNTIME', min, max, reasonRequired: true } : undefined;
  }
  return r.fail(`${path}.mode`, 'must be EXPRESSION or RUNTIME');
}

function phase(r: Reader, o: Record<string, unknown>, path: string): PhaseNode | undefined {
  r.object(
    o,
    path,
    ['kind', 'id', 'name', 'block', 'config', 'records', 'computes', 'reads', 'consumes', 'produces', 'uses', 'equipment', 'signatures', 'significant', 'riskClass'],
    ['yieldCheckpoint', 'acceptanceScheme', 'sampling', 'system', 'pat', 'reprocessing'],
  );
  const id = r.id(o, 'id', path);
  const name = r.string(o, 'name', path);
  let block: PhaseNode['block'] | undefined;
  const bo = r.object(o['block'], `${path}.block`, ['type', 'version']);
  if (bo) {
    // Decision 0026 (S4): a library block is LIB-<code> (its definition is in the master's blockDefinitions).
    const type = r.string(bo, 'type', `${path}.block`, /^([A-Z]{1,3}-\d{2}|LIB-[A-Z][A-Z0-9-]{1,39})$/);
    const version = r.string(bo, 'version', `${path}.block`, /^\d+(\.\d+){0,2}$/);
    if (type && version) block = { type, version };
  }
  let config: Record<string, JsonValue> | undefined;
  if (typeof o['config'] !== 'object' || o['config'] === null || Array.isArray(o['config'])) r.fail(`${path}.config`, 'must be an object');
  else config = r.json(o['config'], `${path}.config`) as Record<string, JsonValue>;
  const records = r.strings(o, 'records', path, IDENT);
  const computes = r.strings(o, 'computes', path, IDENT);
  const reads = r.strings(o, 'reads', path, IDENT);
  const consumes = r.strings(o, 'consumes', path, ID);
  const produces = r.strings(o, 'produces', path, ID);
  const uses = r.strings(o, 'uses', path, ID);
  const equipment = r.array(o, 'equipment', path, (x, ep) => {
    const eo = r.object(x, ep, ['ref', 'use']);
    if (!eo) return undefined;
    const ref = r.id(eo, 'ref', ep);
    const use = r.literal(eo, 'use', ep, ['STATUS_CHECK', 'USE'] as const);
    return ref && use ? { ref, use } : undefined;
  });
  let signatures: PhaseNode['signatures'] | undefined;
  const so = r.object(o['signatures'], `${path}.signatures`, [], ['perform', 'check']);
  if (so) {
    signatures = {};
    if (so['perform'] !== undefined) {
      const po = r.object(so['perform'], `${path}.signatures.perform`, ['role']);
      const role = po ? r.string(po, 'role', `${path}.signatures.perform`) : undefined;
      if (role) signatures.perform = { role };
    }
    if (so['check'] !== undefined) {
      const co = r.object(so['check'], `${path}.signatures.check`, ['meaning', 'role']);
      if (co) {
        const meaning = r.literal(co, 'meaning', `${path}.signatures.check`, ['VERIFIED', 'WITNESSED'] as const);
        const role = r.string(co, 'role', `${path}.signatures.check`);
        if (meaning && role) signatures.check = { meaning, role };
      }
    }
  }
  const significant = r.boolean(o, 'significant', path);
  const riskClass = r.string(o, 'riskClass', path);
  const yieldCp = r.id(o, 'yieldCheckpoint', path);
  const scheme = r.id(o, 'acceptanceScheme', path);
  const sampling = r.array(o, 'sampling', path, (x, sp) => samplingNeed(r, x, sp));
  let system: PhaseNode['system'];
  if (o['system'] !== undefined) {
    const sy = r.object(o['system'], `${path}.system`, ['kind', 'ref'], ['recipe', 'recipeVersion']);
    if (sy) {
      const kind = r.literal(sy, 'kind', `${path}.system`, [
        'PLC',
        'SCADA',
        'WEIGHING',
        'CHECKWEIGHER',
        'VISION',
        'SERIALISATION',
        'STERILISER_CONTROLLER',
        'LYO_CONTROLLER',
        'FILTER_TESTER',
        'OTHER',
      ] as const);
      const ref = r.id(sy, 'ref', `${path}.system`);
      const recipe = r.string(sy, 'recipe', `${path}.system`);
      const recipeVersion = r.string(sy, 'recipeVersion', `${path}.system`);
      if (kind && ref) {
        system = { kind, ref };
        opt(system, 'recipe', recipe);
        opt(system, 'recipeVersion', recipeVersion);
      }
    }
  }
  let pat: PhaseNode['pat'];
  if (o['pat'] !== undefined) {
    const pa = r.object(o['pat'], `${path}.pat`, ['method', 'model', 'modelVersion'], ['acceptance']);
    if (pa) {
      const method = r.string(pa, 'method', `${path}.pat`);
      const model = r.string(pa, 'model', `${path}.pat`);
      const modelVersion = r.string(pa, 'modelVersion', `${path}.pat`);
      const acceptance = r.string(pa, 'acceptance', `${path}.pat`);
      if (method && model && modelVersion) {
        pat = { method, model, modelVersion };
        opt(pat, 'acceptance', acceptance);
      }
    }
  }
  let reprocessing: PhaseNode['reprocessing'];
  if (o['reprocessing'] !== undefined) {
    const rp = r.object(o['reprocessing'], `${path}.reprocessing`, ['case'], ['maxPercent', 'maxAge', 'maxSourceBatches']);
    if (rp) {
      const c = r.literal(rp, 'case', `${path}.reprocessing`, ['WHOLE_BATCH_REPROCESSING', 'REPROCESSING_ADDITION', 'RECOVERY', 'VALIDATED_RETREATMENT'] as const);
      const maxPercent = r.decimal(rp, 'maxPercent', `${path}.reprocessing`);
      const maxAge = rp['maxAge'] === undefined ? undefined : quantity(r, rp['maxAge'], `${path}.reprocessing.maxAge`);
      const maxSourceBatches = r.integer(rp, 'maxSourceBatches', `${path}.reprocessing`, 1, 100);
      if (c) {
        reprocessing = { case: c };
        opt(reprocessing, 'maxPercent', maxPercent);
        opt(reprocessing, 'maxAge', maxAge);
        opt(reprocessing, 'maxSourceBatches', maxSourceBatches);
      }
    }
  }
  if (!id || !name || !block || !config || !records || !computes || !reads || !consumes || !produces || !uses || !equipment || !signatures) return undefined;
  if (significant === undefined || !riskClass) return undefined;
  const out: PhaseNode = { kind: 'phase', id, name, block, config, records, computes, reads, consumes, produces, uses, equipment, signatures, significant, riskClass };
  opt(out, 'yieldCheckpoint', yieldCp);
  opt(out, 'acceptanceScheme', scheme);
  opt(out, 'sampling', sampling);
  opt(out, 'system', system);
  opt(out, 'pat', pat);
  opt(out, 'reprocessing', reprocessing);
  return out;
}

function stageEquipment(r: Reader, v: unknown, path: string): StageEquipment | undefined {
  const o = r.object(v, path, ['ref', 'equipmentClass', 'kind']);
  if (!o) return undefined;
  const ref = r.id(o, 'ref', path);
  const equipmentClass = r.id(o, 'equipmentClass', path);
  const kind = r.literal(o, 'kind', path, ['PROCESS', 'INSTRUMENT', 'UTILITY'] as const);
  return ref && equipmentClass && kind ? { ref, equipmentClass, kind } : undefined;
}

function parseFlowNode(r: Reader, v: unknown, path: string): FlowNode | undefined {
  if (r.depth >= MAX_FLOW_DEPTH) return r.fail(path, `nests flow nodes more than ${MAX_FLOW_DEPTH} deep`);
  r.depth++;
  try {
    return parseFlowNodeAt(r, v, path);
  } finally {
    r.depth--;
  }
}

function parseFlowNodeAt(r: Reader, v: unknown, path: string): FlowNode | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return r.fail(path, 'must be a flow node object');
  const o = v as Record<string, unknown>;
  switch (o['kind']) {
    case 'phase':
      return phase(r, o, path);
    case 'stage': {
      r.object(o, path, ['kind', 'id', 'name', 'binding', 'purpose', 'responsibleRole', 'body'], ['noYieldReason', 'clearanceFrom']);
      const noYieldReason = r.string(o, 'noYieldReason', path);
      const clearanceFrom = r.id(o, 'clearanceFrom', path);
      const id = r.id(o, 'id', path);
      const name = r.string(o, 'name', path);
      const purpose = r.literal(o, 'purpose', path, ['MATERIAL', 'NON_MATERIAL'] as const);
      const responsibleRole = r.string(o, 'responsibleRole', path);
      let binding: { rooms: string[]; line?: string; equipment: StageEquipment[] } | undefined;
      const bo = r.object(o['binding'], `${path}.binding`, ['rooms', 'equipment'], ['line']);
      if (bo) {
        const rooms = r.strings(bo, 'rooms', `${path}.binding`, ID);
        const line = r.id(bo, 'line', `${path}.binding`);
        const equipment = r.array(bo, 'equipment', `${path}.binding`, (x, ep) => stageEquipment(r, x, ep));
        if (rooms && equipment) {
          binding = { rooms, equipment };
          opt(binding, 'line', line);
        }
      }
      const body = o['body'] === undefined ? undefined : parseFlowNode(r, o['body'], `${path}.body`);
      if (!(id && name && purpose && responsibleRole && binding && body)) return undefined;
      const stage: StageNode = { kind: 'stage', id, name, binding, purpose, responsibleRole, body };
      opt(stage, 'noYieldReason', noYieldReason);
      opt(stage, 'clearanceFrom', clearanceFrom);
      return stage;
    }
    case 'operation': {
      r.object(o, path, ['kind', 'id', 'name', 'body']);
      const id = r.id(o, 'id', path);
      const name = r.string(o, 'name', path);
      const body = o['body'] === undefined ? undefined : parseFlowNode(r, o['body'], `${path}.body`);
      return id && name && body ? { kind: 'operation', id, name, body } : undefined;
    }
    case 'sequence': {
      r.object(o, path, ['kind', 'id', 'children']);
      const id = r.id(o, 'id', path);
      const children = r.array(o, 'children', path, (x, cp) => parseFlowNode(r, x, cp));
      return id && children ? { kind: 'sequence', id, children } : undefined;
    }
    case 'parallel': {
      r.object(o, path, ['kind', 'id', 'branches']);
      const id = r.id(o, 'id', path);
      const branches = r.array(o, 'branches', path, (x, bp) => {
        const bo = r.object(x, bp, ['id', 'name', 'body']);
        if (!bo) return undefined;
        const bid = r.id(bo, 'id', bp);
        const bname = r.string(bo, 'name', bp);
        const body = bo['body'] === undefined ? undefined : parseFlowNode(r, bo['body'], `${bp}.body`);
        return bid && bname && body ? { id: bid, name: bname, body } : undefined;
      });
      return id && branches ? { kind: 'parallel', id, branches } : undefined;
    }
    case 'alternative': {
      r.object(o, path, ['kind', 'id', 'decision', 'branches']);
      const id = r.id(o, 'id', path);
      const d = o['decision'] === undefined ? undefined : decision(r, o['decision'], `${path}.decision`);
      const branches = r.array(o, 'branches', path, (x, bp): AlternativeBranch | undefined => {
        const bo = r.object(x, bp, ['id', 'name'], ['guard', 'otherwise', 'variantValues', 'body']);
        if (!bo) return undefined;
        const bid = r.id(bo, 'id', bp);
        const bname = r.string(bo, 'name', bp);
        const guard = r.string(bo, 'guard', bp);
        const otherwise = r.boolean(bo, 'otherwise', bp);
        const variantValues = r.strings(bo, 'variantValues', bp);
        const body = bo['body'] === undefined ? undefined : parseFlowNode(r, bo['body'], `${bp}.body`);
        if (!bid || !bname) return undefined;
        const b: AlternativeBranch = { id: bid, name: bname };
        opt(b, 'guard', guard);
        opt(b, 'otherwise', otherwise);
        opt(b, 'variantValues', variantValues);
        opt(b, 'body', body);
        return b;
      });
      return id && d && branches ? { kind: 'alternative', id, decision: d, branches } : undefined;
    }
    case 'loop': {
      r.object(o, path, ['kind', 'id', 'name', 'body', 'maxIterations', 'exit'], ['maxDuration']);
      const id = r.id(o, 'id', path);
      const name = r.string(o, 'name', path);
      const body = o['body'] === undefined ? undefined : parseFlowNode(r, o['body'], `${path}.body`);
      const maxIterations = r.integer(o, 'maxIterations', path, 1, MAX_LOOP_ITERATIONS);
      const maxDuration = o['maxDuration'] === undefined ? undefined : quantity(r, o['maxDuration'], `${path}.maxDuration`);
      let exit: { condition: string; endpoint: string } | undefined;
      const eo = r.object(o['exit'], `${path}.exit`, ['condition', 'endpoint']);
      if (eo) {
        const condition = r.string(eo, 'condition', `${path}.exit`);
        const endpoint = r.string(eo, 'endpoint', `${path}.exit`, IDENT);
        if (condition && endpoint) exit = { condition, endpoint };
      }
      if (!id || !name || !body || maxIterations === undefined || !exit) return undefined;
      const loop: FlowNode = { kind: 'loop', id, name, body, maxIterations, exit };
      opt(loop, 'maxDuration', maxDuration);
      return loop;
    }
    case 'replicate': {
      r.object(o, path, ['kind', 'id', 'name', 'body', 'count', 'instances', 'subLotPrefix']);
      const id = r.id(o, 'id', path);
      const name = r.string(o, 'name', path);
      const body = o['body'] === undefined ? undefined : parseFlowNode(r, o['body'], `${path}.body`);
      const count = o['count'] === undefined ? undefined : replicateCount(r, o['count'], `${path}.count`);
      const instances = r.literal(o, 'instances', path, ['SEQUENTIAL', 'CONCURRENT'] as const);
      const subLotPrefix = r.string(o, 'subLotPrefix', path, /^[A-Z0-9][A-Z0-9-]{0,15}$/);
      return id && name && body && count && instances && subLotPrefix ? { kind: 'replicate', id, name, body, count, instances, subLotPrefix } : undefined;
    }
    case 'holdPoint': {
      r.object(o, path, ['kind', 'id', 'name', 'role', 'dispositions']);
      const id = r.id(o, 'id', path);
      const name = r.string(o, 'name', path);
      const role = r.string(o, 'role', path);
      const dispositions = r.strings(o, 'dispositions', path);
      return id && name && role && dispositions ? { kind: 'holdPoint', id, name, role, dispositions } : undefined;
    }
    case 'libraryCall': {
      r.object(o, path, ['kind', 'id', 'element', 'bind']);
      const id = r.id(o, 'id', path);
      const element = r.id(o, 'element', path);
      const bind: Record<string, string> = {};
      const bo = o['bind'];
      if (typeof bo !== 'object' || bo === null || Array.isArray(bo)) r.fail(`${path}.bind`, 'must be an object');
      else {
        for (const [k, val] of Object.entries(bo as Record<string, unknown>)) {
          if (typeof val !== 'string' || !ID.test(val)) r.fail(`${path}.bind.${k}`, 'must be an id');
          else bind[k] = val;
        }
      }
      return id && element ? { kind: 'libraryCall', id, element, bind } : undefined;
    }
    default:
      return r.fail(`${path}.kind`, `unknown node kind ${JSON.stringify(o['kind'])}`);
  }
}

function libraryElement(r: Reader, v: unknown, path: string): LibraryElement | undefined {
  const o = r.object(v, path, ['ref', 'level', 'symbols', 'body']);
  if (!o) return undefined;
  const ref = r.id(o, 'ref', path);
  const level = r.literal(o, 'level', path, ['STAGE', 'OPERATION'] as const);
  const symbols = r.strings(o, 'symbols', path, ID);
  const body = o['body'] === undefined ? undefined : parseFlowNode(r, o['body'], `${path}.body`);
  return ref && level && symbols && body ? { ref, level, symbols, body } : undefined;
}

/** At most this many places holding text no record can hold are reported. */
const MAX_TEXT_PROBLEMS = 10;

/**
 * The places in `json` that hold text no record can hold (review F32): U+0000, which PostgreSQL refuses, or a UTF-16
 * surrogate without its other half, which jsonb refuses and UTF-8 encoding replaces with U+FFFD, so the saved master
 * record would hold a character its author never wrote. Each is reported with its path (a field name at its object),
 * so the designer's validator points at it; the walk keeps its own stack, so no nesting overflows the call stack.
 */
function unstorableTextProblems(json: unknown): ParseProblem[] {
  interface Place {
    v: unknown;
    parent: Place | null;
    step: string;
  }
  const pathOf = (place: Place): string => {
    const steps: string[] = [];
    for (let p: Place | null = place; p !== null; p = p.parent) steps.push(p.step);
    return steps.reverse().join('');
  };
  const out: ParseProblem[] = [];
  const stack: Place[] = [{ v: json, parent: null, step: '$' }];
  while (stack.length > 0 && out.length < MAX_TEXT_PROBLEMS) {
    const place = stack.pop() as Place;
    const v = place.v;
    if (typeof v === 'string') {
      const problem = unstorableText(v);
      if (problem !== null) out.push({ path: pathOf(place), message: `holds ${problem}, which no record can hold` });
    } else if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i -= 1) stack.push({ v: v[i] as unknown, parent: place, step: `[${i}]` });
    } else if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      for (const [k] of entries) {
        const problem = unstorableText(k);
        if (problem !== null) out.push({ path: pathOf(place), message: `has a field name holding ${problem}, which no record can hold` });
      }
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const [k, x] = entries[i] as [string, unknown];
        if (unstorableText(k) === null) stack.push({ v: x, parent: place, step: `.${k}` });
      }
    }
  }
  return out.slice(0, MAX_TEXT_PROBLEMS);
}

/**
 * Parses and shape-checks MBR content. Nothing is defaulted: every field is explicit. Content holding text no record
 * can hold is refused first, with the places that hold it, and not parsed further.
 */
export function parseMbr(json: unknown): ParseResult {
  const text = unstorableTextProblems(json);
  if (text.length > 0) return { ok: false, problems: text };
  const r = new Reader();
  const o = r.object(json, '$', [
    'format',
    'formatVersion',
    'header',
    'riskScale',
    'references',
    'library',
    'inputs',
    'bom',
    'intermediates',
    'parameters',
    'calculations',
    'yieldCheckpoints',
    'acceptanceSchemes',
    'timeConstraints',
    'riskReductions',
    'goldenCases',
    'procedure',
  ], ['blockDefinitions']);
  if (!o) return { ok: false, problems: r.problems };
  if (o['format'] !== MBR_FORMAT) r.fail('$.format', `must be "${MBR_FORMAT}"`);
  if (o['formatVersion'] !== MBR_FORMAT_VERSION) r.fail('$.formatVersion', `must be ${MBR_FORMAT_VERSION} (no other content format is known to this version)`);
  const h = o['header'] === undefined ? undefined : header(r, o['header'], '$.header');
  let riskScale: MbrContent['riskScale'] | undefined;
  const rs = r.object(o['riskScale'], '$.riskScale', ['ref', 'classes']);
  if (rs) {
    const ref = r.id(rs, 'ref', '$.riskScale');
    const classes = r.strings(rs, 'classes', '$.riskScale');
    if (ref && classes) riskScale = { ref, classes };
  }
  const references = r.array(o, 'references', '$', (x, p) => reference(r, x, p));
  const library = r.array(o, 'library', '$', (x, p) => libraryElement(r, x, p));
  const inputs = r.array(o, 'inputs', '$', (x, p) => externalInput(r, x, p));
  const bom = r.array(o, 'bom', '$', (x, p) => bomLine(r, x, p));
  const intermediates = r.array(o, 'intermediates', '$', (x, p) => intermediate(r, x, p));
  const parameters = r.array(o, 'parameters', '$', (x, p) => parameter(r, x, p));
  const calculations = r.array(o, 'calculations', '$', (x, p) => calculation(r, x, p));
  const yieldCheckpoints = r.array(o, 'yieldCheckpoints', '$', (x, p) => yieldCheckpoint(r, x, p));
  const acceptanceSchemes = r.array(o, 'acceptanceSchemes', '$', (x, p) => acceptanceScheme(r, x, p));
  const timeConstraints = r.array(o, 'timeConstraints', '$', (x, p) => timeConstraint(r, x, p));
  const riskReductions = r.array(o, 'riskReductions', '$', (x, p) => riskReduction(r, x, p));
  const goldenCases = r.array(o, 'goldenCases', '$', (x, p) => goldenCase(r, x, p));
  let procedure: MbrContent['procedure'] | undefined;
  const po = r.object(o['procedure'], '$.procedure', ['id', 'name', 'body']);
  if (po) {
    const id = r.id(po, 'id', '$.procedure');
    const name = r.string(po, 'name', '$.procedure');
    const body = po['body'] === undefined ? undefined : parseFlowNode(r, po['body'], '$.procedure.body');
    if (id && name && body) procedure = { id, name, body };
  }
  // Decision 0026 (S4): library block snapshots, objects with a code and a version; the library checks their form.
  let blockDefinitions: { [key: string]: JsonValue }[] | undefined;
  if (o['blockDefinitions'] !== undefined) {
    const list = o['blockDefinitions'];
    if (!Array.isArray(list)) r.fail('$.blockDefinitions', 'must be an array of library block definitions');
    else {
      list.forEach((d: unknown, i) => {
        const at = `$.blockDefinitions[${i}]`;
        if (typeof d !== 'object' || d === null || Array.isArray(d)) r.fail(at, 'must be a library block definition (an object)');
        else if (typeof (d as Record<string, unknown>)['code'] !== 'string' || !Number.isInteger((d as Record<string, unknown>)['version'])) r.fail(at, 'must name its code and its version');
      });
      blockDefinitions = list as { [key: string]: JsonValue }[];
    }
  }
  if (r.problems.length > 0) return { ok: false, problems: r.problems };
  const mbr: MbrContent = {
    format: MBR_FORMAT,
    formatVersion: MBR_FORMAT_VERSION,
    header: need(h),
    riskScale: need(riskScale),
    references: need(references),
    library: need(library),
    inputs: need(inputs),
    bom: need(bom),
    intermediates: need(intermediates),
    parameters: need(parameters),
    calculations: need(calculations),
    yieldCheckpoints: need(yieldCheckpoints),
    acceptanceSchemes: need(acceptanceSchemes),
    timeConstraints: need(timeConstraints),
    riskReductions: need(riskReductions),
    goldenCases: need(goldenCases),
    procedure: need(procedure),
    ...(blockDefinitions !== undefined ? { blockDefinitions } : {}),
  };
  return { ok: true, mbr };
}

/** Parses a library-element body on its own (used when hashing embedded snapshots). */
export function parseFlowNodeStandalone(json: unknown): { ok: true; node: FlowNode } | { ok: false; problems: ParseProblem[] } {
  const text = unstorableTextProblems(json);
  if (text.length > 0) return { ok: false, problems: text };
  const r = new Reader();
  const node = parseFlowNode(r, json, '$');
  if (r.problems.length > 0 || !node) return { ok: false, problems: r.problems };
  return { ok: true, node };
}
