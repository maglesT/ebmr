/**
 * Shared pieces of the generic block versions: schema fragments, unit and decimal helpers, the
 * expected-answer rule for categorical results, and container arithmetic (net = gross - tare, always
 * computed, never typed: INV-25).
 */
import { Dec, parseUnit, sameDimension, UnitError } from '@ebmr/expr';
import type { MbrContent, Parameter, PhaseNode } from '../../flow/model.ts';
import type { DataValue } from '../../engine/types.ts';
import type { ExceptionRule, HandlerProblem, HandlerView } from '../contract.ts';
import type { FieldSchema, ObjectSchema } from '../schema.ts';

export const SKIPPABLE: FieldSchema = { type: 'boolean', optional: true, default: false, description: 'The MBR allows this step to be skipped with an approver (never for CPP/CQA inputs, reconciliation, clearance or sign-off)' };

export const EPOCH_MICROS: FieldSchema = { type: 'string', pattern: /^[0-9]{1,20}$/, description: 'Instant as UTC epoch microseconds (digits)' };

export const QUANTITY_SCHEMA: ObjectSchema = {
  type: 'object',
  description: 'A quantity: decimal text and UCUM unit',
  fields: { value: { type: 'decimal', description: 'Decimal written as text' }, unit: { type: 'string', description: 'UCUM unit' } },
};

export const LOT_SCHEMA: ObjectSchema = {
  type: 'object',
  description: 'The lot as read from site services at the moment of use (status evaluated on fresh data, PR-18)',
  fields: {
    id: { type: 'string', description: 'Lot or receiving/control number' },
    material: { type: 'string', description: 'Material code or MBR material reference on the scanned label' },
    status: { type: 'string', enum: ['RELEASED', 'QUARANTINE', 'ON_TEST', 'REJECTED', 'ON_HOLD', 'RECALLED', 'RETURNED', 'EXPIRED'], description: 'Material status at the moment of use' },
    expiresAtUs: { ...EPOCH_MICROS, optional: true },
    retestAtUs: { ...EPOCH_MICROS, optional: true },
    identityTested: { type: 'boolean', optional: true, description: 'An identity-test result exists for this lot (IN-24(c))' },
  },
};

export function problem(code: string, message: string, controls: string[]): HandlerProblem {
  return { code, message: `${message} (${code}; ${controls.join(', ')})`, controls };
}

export function isMassUnit(unit: string | undefined): boolean {
  if (unit === undefined) return false;
  try {
    return sameDimension(parseUnit(unit), parseUnit('kg'));
  } catch (e) {
    if (e instanceof UnitError) return false;
    throw e;
  }
}

/** Recorded parameters of a phase whose unit is a mass (container totals are computed into these). */
export function massItems(phase: PhaseNode, mbr: MbrContent): string[] {
  return phase.records.filter((r) => {
    const p = mbr.parameters.find((x) => x.id === r);
    return p !== undefined && p.valueType === 'DECIMAL' && (p.readings ?? 1) === 1 && isMassUnit(p.unit);
  });
}

/** Exact conversion of a quantity to another unit through the expression language (undefined when not exact or not commensurable). */
export function convert(view: HandlerView, value: string, from: string, to: string): string | undefined {
  return from === to ? value : view.expr.convert(value, from, to);
}

/** The digits after the decimal point of decimal text as it is written ("51.250": 3), the resolution it was taken at. */
function writtenDecimals(text: string): number {
  const point = text.indexOf('.');
  return point < 0 ? 0 : text.length - point - 1;
}

/**
 * Exact decimal text of `value` with at least `decimals` digits after the point: the resolution of the weighings it was
 * computed from is kept ("50.000", not "50"; engine 1.2.0, lead TODO T2). Never rounds: a value with more digits keeps
 * them all.
 */
function atResolution(value: Dec, decimals: number): string {
  return value.toFixed(Math.max(decimals, value.decimalPlaces()), 'HALF_EVEN');
}

/**
 * net = gross - tare, exact, at the resolution of the finer of the two weighings (as PostgreSQL's numeric subtraction
 * writes it, which the database checks: recipe-core 0321); refuses a negative or zero net.
 */
export function netOf(gross: string, tare: string): { ok: true; net: string } | { ok: false; message: string } {
  const g = Dec.parse(gross);
  const t = Dec.parse(tare);
  if (t.isNegative() || g.isNegative()) return { ok: false, message: 'gross and tare weights cannot be negative' };
  const net = g.minus(t);
  if (!net.isPositive()) return { ok: false, message: `the net weight (${gross} - ${tare}) is not positive` };
  return { ok: true, net: atResolution(net, Math.max(writtenDecimals(gross), writtenDecimals(tare))) };
}

/**
 * A balance's metric mass unit: grams with a metric prefix (kg, g, mg, ug). Between two of them a conversion is a power
 * of ten, which the database repeats exactly when it checks a total of weighings (recipe-core 0322).
 */
const METRIC_MASS = /^(?:Y|Z|E|P|T|G|M|k|h|da|d|c|m|u|n|p|f|a|z|y)?g$/;

/**
 * Whether a weight in `unit` is counted into a quantity in `itemUnit`: the same unit, or two metric mass units (engine
 * 1.3.0; the database checks the total the same way, recipe-core 0322).
 */
export function countableInto(unit: string, itemUnit: string): boolean {
  return unit === itemUnit || (METRIC_MASS.test(unit) && METRIC_MASS.test(itemUnit));
}

/**
 * `value` (decimal text in `from`, written at the resolution it was weighed at) in `to`, exactly, still written at that
 * resolution: 8000.0 g is 8.0000 kg (a reading to 0.1 g is a reading to 0.0001 kg) and 8.000 kg is 8000 g (engine 1.3.0,
 * lead TODO T2). Never rounds; undefined when the conversion is not exact.
 */
export function convertAtResolution(view: HandlerView, value: string, from: string, to: string): string | undefined {
  if (from === to) return value;
  const converted = view.expr.convert(value, from, to);
  if (converted === undefined) return undefined;
  const places = writtenDecimals(value);
  const step = view.expr.convert(places === 0 ? '1' : `0.${'0'.repeat(places - 1)}1`, from, to);
  return atResolution(Dec.parse(converted), step === undefined ? 0 : writtenDecimals(step));
}

/** The exact sum, at the resolution of the finest of the values summed (engine 1.2.0). */
export function sumDecimals(values: readonly string[]): string {
  const total = values.reduce((acc, v) => acc.plus(Dec.parse(v)), Dec.ZERO);
  return atResolution(total, values.reduce((most, v) => Math.max(most, writtenDecimals(v)), 0));
}

/**
 * The answer a categorical result is expected to have (documented default when the MBR's block
 * configuration names none): PASS, CONFIRMED, YES, ACCEPTABLE or COMPLIES when the list offers one;
 * true for yes/no values.
 */
export function expectedAnswer(p: Parameter | undefined, configured: unknown): string | boolean | undefined {
  if (typeof configured === 'string') return configured === 'true' ? true : configured === 'false' ? false : configured;
  if (!p) return undefined;
  if (p.valueType === 'BOOLEAN') return true;
  if (p.valueType !== 'CATEGORY') return undefined;
  return ['PASS', 'CONFIRMED', 'YES', 'ACCEPTABLE', 'COMPLIES'].find((c) => (p.categories ?? []).includes(c));
}

export function isUnexpected(expected: string | boolean | undefined, value: DataValue): boolean {
  if (expected === undefined) return false;
  if (value.kind === 'BOOLEAN') return value.value !== expected;
  if (value.kind === 'CATEGORY') return value.value !== expected;
  return false;
}

export function configRecord(config: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
  const v = config[key];
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Engine exception rules a block can trigger through the core (listed so each block's rules are complete). */
export const CORE_VALUE_RULES: ExceptionRule[] = [
  { type: 'LIMIT_BREACH', category: 'OUT_OF_LIMIT', severity: 'ACTION', summary: 'A value outside a limit tier (behaviour by tier)', controls: ['PR-08'] },
  { type: 'REPEAT_AFTER_FAIL', category: 'REPEAT_OR_ABORTED', severity: 'ACTION', summary: 'A new attempt after a failing result', controls: ['DI-29', 'INV-41'] },
  { type: 'MANUAL_ENTRY_FALLBACK', category: 'MANUAL_ENTRY', severity: 'ALERT', summary: 'Manual entry where device capture is configured; two-person mode', controls: ['DI-30', 'PR-14'] },
  { type: 'LATE_ENTRY', category: 'LATE_ENTRY', severity: 'ALERT', summary: 'Entry with a person-claimed time', controls: ['DI-28'] },
];

/** Epoch microseconds from a digits string (instants are never JavaScript numbers). */
export function micros(text: unknown): bigint | undefined {
  return typeof text === 'string' && /^[0-9]{1,20}$/.test(text) ? BigInt(text) : undefined;
}
