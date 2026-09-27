/**
 * JSON values and canonical request hashing for idempotent commands.
 *
 * GMP quantities travel as decimal strings, never as JSON numbers, so that no JavaScript
 * `number` rounding can touch them; numbers are accepted here only for counts and flags.
 */
import { createHash } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Deterministic JSON: object keys sorted by code unit, no insignificant whitespace. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('canonical JSON cannot hold NaN or Infinity');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as JsonValue)}`).join(',')}}`;
}

/** SHA-256 (lower-case hex) of the canonical JSON of a request, for idempotency checks. */
export function requestHash(request: JsonValue): string {
  return createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
}
