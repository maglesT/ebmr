/**
 * Static argument checks shared by the library functions. Every failure becomes a design-time
 * ERROR in plain language that names the function and the argument.
 */
import type { ExprType, QuantityType, SeriesType } from '../lang/types.ts';
import { barePercentConflict, describeQuantity, describeTag, unifyTags } from '../lang/rules.ts';
import { TAG_LABEL, type Tag } from '../units/tags.ts';
import { DIMENSIONLESS, describeDimension, parseUnit } from '../units/unit.ts';
import { CheckFailure, type ArgInfo } from './contract.ts';

export const DIM = {
  NUMBER: '',
  MASS: 'g1',
  VOLUME: 'm3',
  TIME: 's1',
  MOLAR_MASS: 'g1.mol-1',
  DENSITY: 'm-3.g1',
} as const;

export const PERCENT_UNIT = parseUnit('%');
export const MINUTE_UNIT = parseUnit('min');
export const SECOND_UNIT = parseUnit('s');
export { DIMENSIONLESS };

export function fail(code: string, message: string, argIndex?: number): never {
  throw new CheckFailure(code, message, argIndex);
}

export function arity(args: readonly ArgInfo[], min: number, max: number, signature: string): void {
  if (args.length < min || args.length > max) {
    const expected = min === max ? String(min) : max === Number.POSITIVE_INFINITY ? `at least ${String(min)}` : `${String(min)} to ${String(max)}`;
    fail('EXPR-FN-002', `${signature} takes ${expected} argument${min === 1 && max === 1 ? '' : 's'}, not ${String(args.length)}`);
  }
}

function ordinal(i: number): string {
  return ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'][i] ?? `${String(i + 1)}th`;
}

export interface QuantitySpec {
  /** What the argument is, in plain words ("the assay"). */
  readonly what: string;
  /** Allowed dimension keys (see DIM). */
  readonly dimension?: string;
  /** Plain words for the dimension ("a mass"). */
  readonly dimensionLabel?: string;
  /** Required tag (a tag-neutral constant is accepted too). */
  readonly tag?: Tag;
  /** Acceptable tags (alternative to `tag`). */
  readonly tags?: readonly Tag[];
  /** Absolute temperatures accepted (default: refused). */
  readonly absoluteTemperature?: boolean;
}

function typeLabel(t: ExprType): string {
  switch (t.kind) {
    case 'quantity':
      return describeQuantity(t.unit, t.tag);
    case 'series':
      return `a recorded series of ${describeQuantity(t.element.unit, t.element.tag)}`;
    default:
      return `a ${t.kind}`;
  }
}

export function quantityArg(args: readonly ArgInfo[], i: number, fn: string, spec: QuantitySpec): QuantityType {
  const arg = args[i];
  if (arg === undefined) fail('EXPR-FN-002', `${fn} needs its ${ordinal(i)} argument (${spec.what})`);
  const t = arg.type;
  if (t.kind === 'series') fail('EXPR-FN-003', `The ${ordinal(i)} argument of ${fn} (${spec.what}) must be a single value, but it is a recorded series; use an aggregate such as mean()`, i);
  if (t.kind !== 'quantity') fail('EXPR-FN-003', `The ${ordinal(i)} argument of ${fn} (${spec.what}) must be a quantity, not ${typeLabel(t)}`, i);
  checkQuantity(t, i, fn, spec);
  return t;
}

export function checkQuantity(t: QuantityType, i: number, fn: string, spec: QuantitySpec): void {
  if (t.unit.scale === 'ABSOLUTE_TEMPERATURE' && spec.absoluteTemperature !== true) {
    fail('EXPR-FN-004', `${fn} cannot take an absolute temperature as ${spec.what}`, i);
  }
  if (spec.dimension !== undefined && t.unit.dimensionKey !== spec.dimension) {
    fail('EXPR-FN-004', `The ${ordinal(i)} argument of ${fn} (${spec.what}) must be ${spec.dimensionLabel ?? spec.dimension}, but it is ${describeDimension(t.unit)} (${t.unit.code})`, i);
  }
  const allowed = spec.tags ?? (spec.tag === undefined ? undefined : [spec.tag]);
  if (allowed !== undefined && t.tag !== null && !allowed.includes(t.tag)) {
    fail('EXPR-TAG-003', `The ${ordinal(i)} argument of ${fn} (${spec.what}) must be ${allowed.map((a) => TAG_LABEL[a]).join(' or ')}, but it is ${describeTag(t.tag)}`, i);
  }
}

export function seriesArg(args: readonly ArgInfo[], i: number, fn: string, spec: QuantitySpec): SeriesType {
  const arg = args[i];
  if (arg === undefined) fail('EXPR-FN-002', `${fn} needs its ${ordinal(i)} argument (${spec.what})`);
  const t = arg.type;
  if (t.kind !== 'series') fail('EXPR-FN-005', `${fn} works on a recorded series (${spec.what}), not on ${typeLabel(t)}; aggregates run only over recorded series`, i);
  checkQuantity(t.element, i, fn, spec);
  return t;
}

/** A single value or a recorded series whose values are summed. */
export function scalarOrSeriesArg(args: readonly ArgInfo[], i: number, fn: string, spec: QuantitySpec): QuantityType {
  const arg = args[i];
  if (arg?.type.kind === 'series') {
    checkQuantity(arg.type.element, i, fn, spec);
    return arg.type.element;
  }
  return quantityArg(args, i, fn, spec);
}

/** Operands that must be commensurable: same dimension, compatible tags, no plain-number/% mix. */
export function commensurable(types: readonly { t: QuantityType; i: number }[], fn: string, what: string): Tag | null {
  const first = types[0];
  if (first === undefined) return null;
  let tag: Tag | null = first.t.tag;
  for (const { t, i } of types.slice(1)) {
    if (t.unit.dimensionKey !== first.t.unit.dimensionKey || t.unit.scale !== first.t.unit.scale) {
      fail('EXPR-UNIT-010', `${fn}: ${what} must measure the same thing, but ${describeQuantity(first.t.unit, first.t.tag)} and ${describeQuantity(t.unit, t.tag)} differ`, i);
    }
    if (barePercentConflict(first.t.unit, t.unit)) {
      fail('EXPR-UNIT-011', `${fn}: a plain number and a percentage cannot be combined; write the number with its unit, e.g. 100 [%]`, i);
    }
    const u = unifyTags(tag, t.tag);
    if (u === undefined) fail('EXPR-TAG-001', `${fn}: ${describeTag(tag)} and ${describeTag(t.tag)} mean different things and cannot be combined`, i);
    tag = u;
  }
  return tag;
}

export function maxLengthOf(arg: ArgInfo | undefined): number {
  return arg?.type.kind === 'series' ? arg.type.maxLength : 1;
}
