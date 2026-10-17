/**
 * Reading and hashing the evidence bundle v1 (docs/build-plan/phase-7/slice-7-0-interfaces.md section 1; D-P7-0-1,
 * D-P7-0-6).
 *
 * The generators read nothing but the bundle, so this module touches no database, file system or clock. It checks a
 * parsed bundle against `bundle.schema.json` with a small interpreter of the keywords that schema uses (a schema
 * keyword it does not know is a defect here, never silently ignored), then checks that every array of the sort table
 * is in order, because determinism is part of the contract: the same inputs give the same bundle bytes and hash.
 *
 * Refusals (message codes of the validation kit):
 *  - EBMR-VAL-002  the bundle's `bundleVersion` is missing or is not a version this kit knows (D-P7-0-6);
 *  - EBMR-VAL-007  the bundle does not match the schema (a missing, unknown or ill-formed field);
 *  - EBMR-VAL-008  an array of the sort table is out of order or holds the same key twice.
 *
 * Strings compare by Unicode code point (the same order as their UTF-8 bytes, and as PostgreSQL's "C" collation), so
 * the bundle builder in tools/validation sorts with `compareText` and nothing locale-dependent.
 */
import { createHash } from 'node:crypto';
import schemaJson from './bundle.schema.json' with { type: 'json' };
import type { Bundle } from './types.ts';

/** The bundle versions this kit reads. */
export const BUNDLE_VERSION = 1;

export type BundleErrorCode = 'EBMR-VAL-002' | 'EBMR-VAL-007' | 'EBMR-VAL-008';

/** A refused bundle: the message code and the JSON path of the first fault found. */
export class BundleError extends Error {
  readonly code: BundleErrorCode;
  readonly path: string;
  constructor(code: BundleErrorCode, path: string, detail: string) {
    super(`${code}: ${path}: ${detail}`);
    this.name = 'BundleError';
    this.code = code;
    this.path = path;
  }
}

/** The arrays of the sort table and their keys (strictly ascending: no two items share a key). */
export const BUNDLE_SORT_KEYS: readonly { readonly path: string; readonly keys: readonly string[] }[] = [
  { path: 'register.controls', keys: ['id'] },
  { path: 'register.requirements', keys: ['n'] },
  { path: 'runs', keys: ['id'] },
  { path: 'results', keys: ['test', 'run'] },
  { path: 'trace.controls', keys: ['control'] },
  { path: 'inventory.migrations', keys: ['namespace', 'name'] },
  { path: 'inventory.functions', keys: ['schema', 'name', 'argTypes'] },
  { path: 'inventory.triggers', keys: ['table', 'name'] },
  { path: 'inventory.constraints', keys: ['table', 'name'] },
  { path: 'inventory.privileges', keys: ['role', 'object', 'privilege'] },
  { path: 'inventory.roles', keys: ['name'] },
  { path: 'inventory.settings', keys: ['name'] },
  { path: 'inventory.auditedTables', keys: ['table'] },
  { path: 'inventory.permissions', keys: ['permission'] },
  { path: 'inventory.meanings', keys: ['meaning'] },
  { path: 'inventory.messages', keys: ['code'] },
  { path: 'inventory.stateCharts', keys: ['machine'] },
  { path: 'inventory.blocks', keys: ['blockType', 'version'] },
  { path: 'inventory.ruleKeys', keys: ['key'] },
  { path: 'inventory.routes', keys: ['namespace', 'route', 'method'] },
  { path: 'criticalLimits', keys: ['key'] },
  { path: 'reviews', keys: ['id'] },
  { path: 'openFindings', keys: ['id'] },
  { path: 'analytics.methods', keys: ['id'] },
  { path: 'records', keys: ['kind'] },
  { path: 'knownIssues', keys: ['id'] },
];

/** Code point order of two strings (negative, zero or positive), independent of locale. */
export function compareText(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) ?? 0;
    const cb = b.codePointAt(j) ?? 0;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  const restA = i < a.length;
  const restB = j < b.length;
  return restA === restB ? 0 : restA ? 1 : -1;
}

// ---------------------------------------------------------------------------------------------------------------
// The schema interpreter (the subset of draft 2020-12 that bundle.schema.json uses).

interface SchemaNode {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  minimum?: number;
  minItems?: number;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
  items?: SchemaNode;
}

const ANNOTATIONS = new Set(['$schema', '$id', '$defs', 'title', 'description']);
const ASSERTIONS = new Set(['$ref', 'type', 'const', 'enum', 'pattern', 'minLength', 'minimum', 'minItems', 'properties', 'required', 'additionalProperties', 'items']);
const JSON_TYPES = new Set(['null', 'boolean', 'object', 'array', 'string', 'number', 'integer']);

/** The bundle schema, as this module reads it. */
export const BUNDLE_SCHEMA: Readonly<Record<string, unknown>> = schemaJson;
const ROOT = schemaJson as SchemaNode & { $defs: Record<string, SchemaNode> };
const patterns = new Map<string, RegExp>();
let schemaChecked = false;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function deref(node: SchemaNode): SchemaNode {
  if (node.$ref === undefined) return node;
  const m = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(node.$ref);
  const target = m?.[1] === undefined ? undefined : ROOT.$defs[m[1]];
  if (target === undefined) throw new Error(`bundle schema: unresolved $ref ${node.$ref}`);
  return deref(target);
}

/** Refuses a schema that uses a keyword or type this interpreter does not apply (so nothing is silently skipped). */
function checkSchemaNode(node: unknown, where: string): void {
  if (!isPlainObject(node)) throw new Error(`bundle schema: ${where} is not a schema object`);
  for (const k of Object.keys(node)) {
    if (!ANNOTATIONS.has(k) && !ASSERTIONS.has(k)) throw new Error(`bundle schema: ${where} uses the keyword ${k}, which validate.ts does not apply`);
  }
  const n = node as SchemaNode & { $defs?: Record<string, unknown> };
  if (n.$ref !== undefined) deref(n);
  for (const t of n.type === undefined ? [] : Array.isArray(n.type) ? n.type : [n.type]) {
    if (!JSON_TYPES.has(t)) throw new Error(`bundle schema: ${where} has the unknown type ${t}`);
  }
  if (n.pattern !== undefined) patterns.set(n.pattern, new RegExp(n.pattern, 'u'));
  for (const [k, v] of Object.entries(n.properties ?? {})) checkSchemaNode(v, `${where}.properties.${k}`);
  for (const r of n.required ?? []) if (n.properties?.[r] === undefined) throw new Error(`bundle schema: ${where} requires ${r} but does not define it`);
  if (isPlainObject(n.additionalProperties)) checkSchemaNode(n.additionalProperties, `${where}.additionalProperties`);
  if (n.items !== undefined) checkSchemaNode(n.items, `${where}.items`);
  for (const [k, v] of Object.entries(n.$defs ?? {})) checkSchemaNode(v, `$defs.${k}`);
}

function ensureSchema(): void {
  if (schemaChecked) return;
  checkSchemaNode(ROOT, '#');
  schemaChecked = true;
}

function hasType(v: unknown, t: string): boolean {
  switch (t) {
    case 'null':
      return v === null;
    case 'boolean':
      return typeof v === 'boolean';
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'array':
      return Array.isArray(v);
    case 'object':
      return isPlainObject(v);
    default:
      return false;
  }
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'number') return `the number ${String(v)}`;
  return typeof v === 'string' ? `the text ${JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}...` : v)}` : `a ${typeof v}`;
}

function fault(path: string, detail: string): never {
  throw new BundleError('EBMR-VAL-007', path, detail);
}

function checkValue(v: unknown, raw: SchemaNode, path: string): void {
  const node = deref(raw);
  if (node.type !== undefined) {
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (!types.some((t) => hasType(v, t))) fault(path, `expected ${types.join(' or ')}, found ${describe(v)}`);
  }
  if ('const' in node && v !== node.const) fault(path, `expected ${JSON.stringify(node.const)}, found ${describe(v)}`);
  if (node.enum !== undefined && !node.enum.includes(v)) fault(path, `expected one of ${node.enum.map((e) => JSON.stringify(e)).join(', ')}, found ${describe(v)}`);
  if (typeof v === 'string') {
    if (node.minLength !== undefined && [...v].length < node.minLength) fault(path, `shorter than ${node.minLength.toString()} characters`);
    if (node.pattern !== undefined && !(patterns.get(node.pattern) ?? new RegExp(node.pattern, 'u')).test(v)) fault(path, `${describe(v)} does not match ${node.pattern}`);
  }
  if (typeof v === 'number' && node.minimum !== undefined && v < node.minimum) fault(path, `less than ${node.minimum.toString()}`);
  if (Array.isArray(v)) {
    if (node.minItems !== undefined && v.length < node.minItems) fault(path, `fewer than ${node.minItems.toString()} items`);
    if (node.items !== undefined) {
      const items = node.items;
      v.forEach((item: unknown, i) => checkValue(item, items, `${path}[${i.toString()}]`));
    }
  }
  if (isPlainObject(v)) {
    for (const r of node.required ?? []) if (!Object.hasOwn(v, r)) fault(`${path}.${r}`, 'missing');
    for (const [k, item] of Object.entries(v)) {
      const prop = node.properties?.[k];
      if (prop !== undefined) checkValue(item, prop, `${path}.${k}`);
      else if (node.additionalProperties === false) fault(`${path}.${k}`, 'not a field of the bundle schema');
      else if (isPlainObject(node.additionalProperties)) checkValue(item, node.additionalProperties, `${path}.${k}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The sort table.

function at(root: unknown, path: string): unknown {
  let cur = root;
  for (const p of path.split('.')) cur = isPlainObject(cur) ? cur[p] : undefined;
  return cur;
}

function compareKey(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === 'string' && typeof b === 'string') return compareText(a, b);
  // The schema makes every sort key a string or a number; anything else is a defect of the sort table.
  throw new Error(`bundle sort keys must be text or numbers (found ${typeof a} and ${typeof b})`);
}

function checkSorted(bundle: unknown): void {
  for (const { path, keys } of BUNDLE_SORT_KEYS) {
    const list = at(bundle, path);
    if (!Array.isArray(list)) throw new Error(`bundle sort table names ${path}, which is not an array of the schema`);
    for (let i = 1; i < list.length; i++) {
      const prev: unknown = list[i - 1];
      const cur: unknown = list[i];
      let c = 0;
      for (const k of keys) {
        c = compareKey(at(prev, k), at(cur, k));
        if (c !== 0) break;
      }
      if (c >= 0) {
        throw new BundleError('EBMR-VAL-008', `${path}[${i.toString()}]`, c === 0 ? `the same ${keys.join(', ')} as the item before it` : `out of order by ${keys.join(', ')}`);
      }
    }
  }
}

/**
 * Checks a parsed bundle (the value of JSON.parse) and returns it typed. Refuses an unknown version (EBMR-VAL-002), a
 * value that does not match the schema (EBMR-VAL-007) and an unsorted array (EBMR-VAL-008), with a BundleError.
 */
export function parseBundle(json: unknown): Bundle {
  ensureSchema();
  if (!isPlainObject(json)) fault('$', `expected the bundle object, found ${describe(json)}`);
  if (!Object.hasOwn(json, 'bundleVersion')) throw new BundleError('EBMR-VAL-002', '$.bundleVersion', 'missing; this kit reads bundle version 1');
  if (json['bundleVersion'] !== BUNDLE_VERSION) {
    throw new BundleError('EBMR-VAL-002', '$.bundleVersion', `${describe(json['bundleVersion'])} is not a bundle version this kit knows; it reads bundle version 1`);
  }
  checkValue(json, ROOT, '$');
  checkSorted(json);
  return json as unknown as Bundle;
}

// ---------------------------------------------------------------------------------------------------------------
// Canonical form and hash.

function canonical(v: unknown, ancestors: Set<object>): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('canonical JSON holds finite numbers only');
      return JSON.stringify(v);
    case 'object':
      break;
    default:
      throw new TypeError(`canonical JSON cannot hold a ${typeof v}`);
  }
  if (ancestors.has(v)) throw new TypeError('canonical JSON cannot hold a circular structure');
  ancestors.add(v);
  try {
    if (Array.isArray(v)) {
      return `[${v
        .map((item: unknown) => {
          if (item === undefined) throw new TypeError('canonical JSON cannot hold undefined in an array');
          return canonical(item, ancestors);
        })
        .join(',')}]`;
    }
    if (!isPlainObject(v)) throw new TypeError('canonical JSON holds plain objects and arrays only');
    const keys = Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort(compareText);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(v);
  }
}

/**
 * The canonical JSON text of a value: object keys sorted by code point, no whitespace, array order kept, properties
 * whose value is undefined left out. The bundle file is written in this form, so its bytes are its canonical form.
 */
export function canonicalJson(value: unknown): string {
  return canonical(value, new Set());
}

/** Lowercase hex SHA-256 of the bundle's canonical JSON (UTF-8): the hash every generated document's footer carries. */
export function bundleSha256(bundle: Bundle): string {
  return createHash('sha256').update(canonicalJson(bundle), 'utf8').digest('hex');
}
