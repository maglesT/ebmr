/**
 * Codec of engine values for persistence (Phase 2 apps plan section 7; module C3): batch states, events
 * and commands become plain JSON that PostgreSQL `jsonb` stores exactly, and come back identical.
 *
 * Rules (reversible, so decode(encode(x)) equals x):
 *  - a bigint (instants and durations in microseconds) becomes {"$u": "<decimal digits>"};
 *  - a Map (the token marking) becomes {"$m": [[key, value], ...]} in insertion order;
 *  - a string containing U+0000 (which jsonb cannot hold) becomes {"$s": "<escaped>"}, where `%` is
 *    written %25 and U+0000 is written %00;
 *  - an object key that starts with `$` or `~` or contains U+0000 is written `~` + the escaped key, so a
 *    tag object can never be confused with data;
 *  - object members whose value is `undefined` are dropped (as JSON does);
 *  - numbers must be safe integers (counts, indices, versions); anything else is refused, because GMP
 *    values travel as decimal strings and a float would not hash the same in the database.
 *
 * Hashes: `hashJson(x)` is SHA-256 of the canonical JSON (expr canonicalJson: keys sorted by code point,
 * no insignificant white space). It equals the database's esig.sha256_hex(esig.canonical_json(x::jsonb))
 * for every value this codec produces, so the database recomputes `stateHash` and `eventsHash` itself.
 */
import { canonicalJson, sha256Hex } from '@ebmr/expr';
import type { BatchState, Command, EngineEvent } from './types.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class CodecError extends Error {}

const escape = (s: string): string => s.replace(/[%\u0000]/g, (c) => (c === '%' ? '%25' : '%00'));
const unescape = (s: string): string => s.replace(/%(25|00)/g, (m) => (m === '%25' ? '%' : '\u0000'));

/** Sets an own enumerable member, even one named __proto__ (never the prototype). */
function define(o: object, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function encodeKey(k: string): string {
  return k.startsWith('$') || k.startsWith('~') || k.includes('\u0000') ? `~${escape(k)}` : k;
}

function decodeKey(k: string): string {
  return k.startsWith('~') ? unescape(k.slice(1)) : k;
}

/** Encodes any engine value (state, event, command) as jsonb-safe JSON. */
export function encode(value: unknown, path = '$'): JsonValue {
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value;
    case 'string':
      return value.includes('\u0000') ? { $s: escape(value) } : value;
    case 'bigint':
      return { $u: value.toString() };
    case 'number':
      if (!Number.isSafeInteger(value)) throw new CodecError(`${path}: ${String(value)} is not a safe integer; GMP values travel as decimal strings`);
      return Object.is(value, -0) ? 0 : value;
    case 'object': {
      if (Array.isArray(value)) return value.map((v, i) => (v === undefined ? null : encode(v, `${path}[${i}]`)));
      if (value instanceof Map) return { $m: [...value.entries()].map(([k, v], i) => [encode(k, `${path}<key ${i}>`), encode(v, `${path}<${String(k)}>`)]) };
      if (value instanceof Set || value instanceof Date || value instanceof RegExp || ArrayBuffer.isView(value)) throw new CodecError(`${path}: a ${value.constructor.name} cannot be persisted`);
      const out: { [key: string]: JsonValue } = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        define(out, encodeKey(k), encode(v, `${path}.${k}`));
      }
      return out;
    }
    default:
      throw new CodecError(`${path}: a ${typeof value} cannot be persisted`);
  }
}

/** Decodes what `encode` produced. */
export function decode(json: unknown, path = '$'): unknown {
  if (json === null || typeof json === 'boolean' || typeof json === 'string') return json;
  if (typeof json === 'number') {
    if (!Number.isSafeInteger(json)) throw new CodecError(`${path}: ${String(json)} is not a safe integer`);
    return json;
  }
  if (Array.isArray(json)) return json.map((v, i) => decode(v, `${path}[${i}]`));
  if (typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '$u') {
      const t = o['$u'];
      if (typeof t !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(t)) throw new CodecError(`${path}: malformed bigint tag`);
      return BigInt(t);
    }
    if (keys.length === 1 && keys[0] === '$m') {
      const t = o['$m'];
      if (!Array.isArray(t) || !t.every((e) => Array.isArray(e) && e.length === 2)) throw new CodecError(`${path}: malformed map tag`);
      return new Map((t as unknown[][]).map(([k, v], i) => [decode(k, `${path}<key ${i}>`), decode(v, `${path}<${i}>`)]));
    }
    if (keys.length === 1 && keys[0] === '$s') {
      const t = o['$s'];
      if (typeof t !== 'string') throw new CodecError(`${path}: malformed string tag`);
      return unescape(t);
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (k.startsWith('$')) throw new CodecError(`${path}: unexpected tag ${k}`);
      define(out, decodeKey(k), decode(o[k], `${path}.${k}`));
    }
    return out;
  }
  throw new CodecError(`${path}: not JSON`);
}

/** SHA-256 (hex) of the canonical JSON of an encoded value. */
export function hashJson(json: JsonValue): string {
  return sha256Hex(canonicalJson(json));
}

export function encodeState(state: BatchState): JsonValue {
  return encode(state);
}

export function decodeState(json: unknown): BatchState {
  const s = decode(json) as BatchState;
  if (s === null || typeof s !== 'object' || s.schema !== 'ebmr.batch-execution-state') throw new CodecError('not an encoded batch execution state');
  return s;
}

/** The state hash every persisted engine call stores (and the database recomputes). */
export function stateHash(state: BatchState): string {
  return hashJson(encodeState(state));
}

export function encodeEvents(events: readonly EngineEvent[]): JsonValue {
  return encode(events);
}

export function decodeEvents(json: unknown): EngineEvent[] {
  return decode(json) as EngineEvent[];
}

export function eventsHash(events: readonly EngineEvent[]): string {
  return hashJson(encodeEvents(events));
}

export function encodeCommand(command: Command): JsonValue {
  return encode(command);
}

export function decodeCommand(json: unknown): Command {
  return decode(json) as Command;
}
