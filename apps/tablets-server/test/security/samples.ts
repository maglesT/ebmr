/**
 * Inputs for the security sweeps (slice 7d): for each route of the contract, a params, query and body that its zod
 * schemas accept (so a request reaches the session, permission and handler gates instead of stopping at validation),
 * and malformed ones for the fuzzing. The valid input is sampled from the schema's JSON Schema (z.toJSONSchema, the
 * input side) with fast-check for patterns, deterministically by seed, and kept only when the schema parses it.
 */
import fc from 'fast-check';
import { z } from 'zod';
import { buildPath, type AnyRoute } from '@ebmr/api-contract';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  prefixItems?: Schema[];
  minItems?: number;
  enum?: Json[];
  const?: Json;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  pattern?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  default?: Json;
  additionalProperties?: Schema | boolean;
  $ref?: string;
  $defs?: Record<string, Schema>;
}

const UUID = '6b1f7c1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
const FORMATS: Record<string, string> = {
  uuid: UUID,
  'date-time': '2026-10-18T10:00:00.000Z',
  date: '2026-10-18',
  email: 'security.test@example.com',
  uri: 'https://example.com/x',
  url: 'https://example.com/x',
  time: '10:00:00',
};

function stringOf(s: Schema, seed: number): string {
  if (s.format && FORMATS[s.format]) return FORMATS[s.format] ?? '';
  const min = s.minLength ?? 1;
  const max = s.maxLength ?? Math.max(min, 12);
  if (s.pattern) {
    try {
      const re = new RegExp(s.pattern);
      const fits = fc.sample(fc.stringMatching(re), { seed, numRuns: 50 }).filter((x) => x.length >= min && x.length <= max && x.trim() === x && x.trim() !== '');
      if (fits[0] !== undefined) return fits[0];
    } catch {
      // A pattern JavaScript cannot compile: fall back to plain text.
    }
  }
  const base = 'SECTEST';
  return (base.repeat(Math.ceil(Math.max(min, 7) / base.length)) + 'X'.repeat(min)).slice(0, Math.max(min, Math.min(max, 7)));
}

function sample(s: Schema, root: Schema, seed: number, depth = 0): Json {
  if (depth > 12) return null;
  if (s.$ref) {
    const name = s.$ref.replace(/^#\/\$defs\//, '');
    const target = root.$defs?.[name];
    return target ? sample(target, root, seed, depth + 1) : null;
  }
  if (s.const !== undefined) return s.const;
  if (s.enum && s.enum.length > 0) return s.enum[0] ?? null;
  if (s.default !== undefined) return s.default;
  const options = s.anyOf ?? s.oneOf;
  if (options && options.length > 0) {
    const nonNull = options.filter((o) => o.type !== 'null');
    return sample(nonNull[0] ?? options[0] ?? {}, root, seed, depth + 1);
  }
  if (s.allOf && s.allOf.length > 0) {
    const merged: Schema = {};
    for (const part of s.allOf) Object.assign(merged, part, { properties: { ...merged.properties, ...part.properties }, required: [...(merged.required ?? []), ...(part.required ?? [])] });
    return sample(merged, root, seed, depth + 1);
  }
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'object': {
      const out: Record<string, Json> = {};
      for (const k of s.required ?? []) out[k] = sample(s.properties?.[k] ?? {}, root, seed, depth + 1);
      return out;
    }
    case 'array': {
      const n = s.minItems ?? 0;
      if (s.prefixItems) return s.prefixItems.map((p) => sample(p, root, seed, depth + 1));
      return Array.from({ length: n }, () => sample(s.items ?? {}, root, seed, depth + 1));
    }
    case 'string':
      return stringOf(s, seed);
    case 'integer':
    case 'number': {
      const lo = s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : 1);
      const hi = s.maximum ?? (s.exclusiveMaximum !== undefined ? s.exclusiveMaximum - 1 : lo + 1);
      return Math.min(Math.max(1, lo), hi);
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return s.properties ? sample({ ...s, type: 'object' }, root, seed, depth + 1) : 'SECTEST';
  }
}

/** A value `schema` accepts, or undefined when sampling finds none in a few seeds. */
export function validSample(schema: z.ZodType, seed = 7): Json | undefined {
  let js: Schema;
  try {
    js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Schema;
  } catch {
    return undefined;
  }
  for (let i = 0; i < 6; i += 1) {
    const v = sample(js, js, seed + i * 101);
    if (schema.safeParse(v).success) return v;
  }
  return undefined;
}

export interface RouteRequest {
  method: string;
  url: string;
  payload?: string;
  /** False when no valid input was found: the request stops at validation (400). */
  valid: boolean;
}

function queryString(q: Json | undefined): string {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== null && v !== undefined) p.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** A request of `route` with valid params, query and body (where the schemas let one be sampled). */
export function validRequest(route: AnyRoute, seed = 7): RouteRequest {
  const params = validSample(route.params, seed);
  const query = validSample(route.query, seed);
  const body = route.body && route.method !== 'GET' ? validSample(route.body, seed) : undefined;
  const valid = params !== undefined && query !== undefined && (route.method === 'GET' || !route.body || body !== undefined);
  const p = params && typeof params === 'object' && !Array.isArray(params) ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) : {};
  const url = `${buildPath(route.path, p)}${queryString(query)}`;
  return { method: route.method, url, valid, ...(route.method !== 'GET' ? { payload: JSON.stringify(body ?? {}) } : {}) };
}

/** Malformed inputs for the fuzzing: arbitrary JSON bodies and arbitrary text in each path parameter and query member. */
export function malformedRequests(route: AnyRoute, seed: number, runs: number): RouteRequest[] {
  const names = [...route.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1] ?? '');
  const text = fc.oneof(fc.string({ maxLength: 40 }), fc.constantFrom('%00', '..%2F..%2Fetc%2Fpasswd', "' or 1=1 --", '<script>x</script>', '\u0000', 'x'.repeat(5000), '-1', '1e999', 'null'));
  const body = fc.oneof(fc.json({ maxDepth: 3 }), fc.constantFrom('{', '[]', 'null', '"x"', '{"__proto__":{"x":1}}', '{"constructor":{"prototype":{}}}', JSON.stringify({ a: 'x'.repeat(100_000) })));
  const arb = fc.record({ params: fc.array(text, { minLength: names.length, maxLength: names.length }), query: fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), text, { maxKeys: 3 }), body });
  return fc.sample(arb, { seed, numRuns: runs }).map((x) => {
    const p = Object.fromEntries(names.map((n, i) => [n, x.params[i] ?? '']));
    let url: string;
    try {
      url = buildPath(route.path, p);
    } catch {
      url = route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, 'x');
    }
    const qs = new URLSearchParams(x.query).toString();
    return { method: route.method, url: `${url}${qs ? `?${qs}` : ''}`, valid: false, ...(route.method !== 'GET' ? { payload: x.body } : {}) };
  });
}
