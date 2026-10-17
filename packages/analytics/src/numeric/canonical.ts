/**
 * Canonical text and the output hash (ADR 0020 point 5; D-6A-22).
 *
 * `canonicalText` writes a value as JSON with object keys sorted (by UTF-16 code unit), no white space, numbers rounded
 * to 12 significant digits and written in ECMAScript's shortest form, -0 as 0, and a non-finite number as null. Two
 * runs whose statistics agree to 12 significant digits therefore give the same text, and the same `outputHash`.
 */
import { AnalyticsInputError } from '../errors.ts';
import { sha256Hex } from './sha256.ts';

/** A number at 12 significant digits, in ECMAScript's shortest round-trip form; null when it is not finite. */
export function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) return 'null';
  const rounded = Number(value.toPrecision(12));
  return rounded === 0 ? '0' : String(rounded);
}

function write(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      return canonicalNumber(value);
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v, i) => (v === undefined ? 'null' : write(v, `${path}[${i}]`))).join(',')}]`;
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new AnalyticsInputError(`canonical text takes plain objects only (at ${path})`, value);
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${write(v, `${path}.${k}`)}`).join(',')}}`;
    }
    default:
      throw new AnalyticsInputError(`canonical text cannot write a ${typeof value} (at ${path})`, value);
  }
}

/** The canonical text of a JSON-like value (plain objects, arrays, strings, numbers, booleans, null). */
export function canonicalText(value: unknown): string {
  return write(value, '$');
}

/** The SHA-256 (hex) of the canonical text of a run's outputs and flags: what `finish_run` records. */
export function outputHash(outputs: readonly unknown[], flags: readonly unknown[]): string {
  return sha256Hex(canonicalText({ outputs, flags }));
}
