/**
 * Structured difference between two MBR versions and delta classification (outline 6.5 "delta
 * verification"; L-60).
 *
 * A change is VALUE when it only changes a numeric parameter value on a whitelisted path: a limit
 * bound, a target, a duration of a time constraint, hold time or loop, a BOM quantity, a
 * reprocessing maximum, or golden test data. Everything else (steps, constructs, expressions, units,
 * inclusive/exclusive, tiers added or removed, criticality, signatures, references, names) is
 * STRUCTURAL. The classification is conservative: when in doubt, structural.
 *
 * `structureHash` hashes the content with every VALUE field blanked and order-free lists sorted, so
 * two versions with equal structure hashes differ at most in values: their structural verification
 * evidence (paths, coverage) can be reused and only the boundary vectors of the changed items rerun.
 */
import { canonicalJson, sha256Hex } from './canonical.ts';
import type { MbrContent } from './model.ts';

export type ChangeClass = 'VALUE' | 'STRUCTURAL';

export interface Change {
  /** Readable path with ids, e.g. /parameters[lod]/limits/ranges[REGISTERED]/high/value. */
  path: string;
  kind: 'ADDED' | 'REMOVED' | 'CHANGED' | 'REORDERED';
  before?: unknown;
  after?: unknown;
  class: ChangeClass;
  /** Id of the top-level item or flow node the change belongs to. */
  subject: string;
}

export interface MbrDiff {
  classification: 'IDENTICAL' | 'VALUE_ONLY' | 'STRUCTURAL';
  changes: Change[];
  /** Items whose values changed (inputs for delta verification). */
  changedSubjects: string[];
  structureHash: { before: string; after: string };
}

const VALUE_PATHS: RegExp[] = [
  /^\/parameters\[\]\/target$/,
  /^\/(parameters|calculations|yieldCheckpoints)\[\]\/limits\/ranges\[\]\/(low|high)\/value$/,
  /^\/acceptanceSchemes\[\]\/criteria\[\]\/range\/(low|high)\/value$/,
  /^\/timeConstraints\[\]\/(min|max|warnBefore)\/value$/,
  /^\/intermediates\[\]\/holdTime\/max\/value$/,
  /^\/bom\[\]\/quantity\/value$/,
  /^\/goldenCases\[\]\/.*$/,
  /^\/(procedure|library\[\])\/.*\/maxDuration\/value$/,
  /^\/(procedure|library\[\])\/.*\/reprocessing\/(maxPercent|maxAge\/value)$/,
];

/** Arrays whose order carries meaning (execution order); every other keyed array is a set. */
const ORDERED = new Set(['children', 'computes']);

function isValuePath(abstract: string): boolean {
  return VALUE_PATHS.some((r) => r.test(abstract));
}

function keyOf(item: unknown, field: string): string | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return typeof item === 'string' ? item : undefined;
  const o = item as Record<string, unknown>;
  if (typeof o['id'] === 'string') return o['id'];
  if (field === 'ranges' && typeof o['tier'] === 'string') return o['tier'];
  if (field === 'library' && typeof o['ref'] === 'string') return o['ref'];
  if (field === 'equipment' && typeof o['ref'] === 'string') return `${o['ref']}${typeof o['use'] === 'string' ? `:${o['use']}` : ''}`;
  if (field === 'sampling' && typeof o['point'] === 'string' && typeof o['purpose'] === 'string') return `${o['point']}:${o['purpose']}`;
  return undefined;
}

function keyedArray(items: readonly unknown[], field: string): Map<string, unknown> | undefined {
  const map = new Map<string, unknown>();
  for (const item of items) {
    const k = keyOf(item, field);
    if (k === undefined || map.has(k)) return undefined;
    map.set(k, item);
  }
  return map;
}

function subjectOf(path: string, fallback: string): string {
  const m = /^\/([A-Za-z]+)\[([^\]]+)\]/.exec(path);
  if (m && m[1] !== 'procedure') return m[2] as string;
  const ids = [...path.matchAll(/\[([^\]]+)\]/g)].map((x) => x[1] as string);
  return ids[ids.length - 1] ?? fallback;
}

function walkDiff(before: unknown, after: unknown, path: string, abstract: string, field: string, out: Change[]): void {
  if (canonicalJson(before) === canonicalJson(after)) return;
  const change = (kind: Change['kind'], b: unknown, a: unknown, cls?: ChangeClass): void => {
    const c: Change = { path: path || '/', kind, class: cls ?? (isValuePath(abstract) ? 'VALUE' : 'STRUCTURAL'), subject: subjectOf(path, '$') };
    if (b !== undefined) c.before = b;
    if (a !== undefined) c.after = a;
    out.push(c);
  };
  if (Array.isArray(before) && Array.isArray(after)) {
    const kb = keyedArray(before, field);
    const ka = keyedArray(after, field);
    if (kb && ka) {
      for (const [k, v] of kb) {
        if (!ka.has(k)) change('REMOVED', v, undefined, isValuePath(`${abstract}[]/`) ? 'VALUE' : 'STRUCTURAL');
        else walkDiff(v, ka.get(k), `${path}[${k}]`, `${abstract}[]`, field, out);
      }
      for (const [k, v] of ka) if (!kb.has(k)) change('ADDED', undefined, v, isValuePath(`${abstract}[]/`) ? 'VALUE' : 'STRUCTURAL');
      const common = [...kb.keys()].filter((k) => ka.has(k));
      const orderAfter = [...ka.keys()].filter((k) => kb.has(k));
      if (ORDERED.has(field) && common.join('\u0000') !== orderAfter.join('\u0000')) change('REORDERED', common, orderAfter, 'STRUCTURAL');
      return;
    }
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) {
      if (i >= before.length) change('ADDED', undefined, after[i]);
      else if (i >= after.length) change('REMOVED', before[i], undefined);
      else walkDiff(before[i], after[i], `${path}[${i}]`, `${abstract}[]`, field, out);
    }
    return;
  }
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const k of keys) {
      const p = `${path}/${k}`;
      const ap = `${abstract}/${k}`;
      if (!(k in before)) change('ADDED', undefined, after[k], isValuePath(ap) ? 'VALUE' : 'STRUCTURAL');
      else if (!(k in after)) change('REMOVED', before[k], undefined, isValuePath(ap) ? 'VALUE' : 'STRUCTURAL');
      else walkDiff(before[k], after[k], p, ap, k, out);
    }
    return;
  }
  change('CHANGED', before, after);
}

function blankValues(value: unknown, abstract: string, field: string): unknown {
  if (isValuePath(abstract)) return '*';
  if (Array.isArray(value)) {
    const items = value.map((v) => blankValues(v, `${abstract}[]`, field));
    const keyed = keyedArray(value, field);
    if (keyed && !ORDERED.has(field)) {
      const withKeys = value.map((v, i) => [keyOf(v, field) as string, items[i]] as const);
      withKeys.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
      return withKeys.map(([, v]) => v);
    }
    return items;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = blankValues(v, `${abstract}/${k}`, k);
    return out;
  }
  return value;
}

/** Hash of the content with value fields blanked and order-free lists sorted. */
export function structureHash(mbr: MbrContent): string {
  return sha256Hex(canonicalJson(blankValues(mbr, '', '')));
}

export function diffMbr(before: MbrContent, after: MbrContent): MbrDiff {
  const changes: Change[] = [];
  walkDiff(before, after, '', '', '', changes);
  const hashes = { before: structureHash(before), after: structureHash(after) };
  const structural = changes.some((c) => c.class === 'STRUCTURAL') || hashes.before !== hashes.after;
  const classification = changes.length === 0 ? 'IDENTICAL' : structural ? 'STRUCTURAL' : 'VALUE_ONLY';
  return {
    classification,
    changes,
    changedSubjects: [...new Set(changes.filter((c) => c.class === 'VALUE').map((c) => c.subject))].sort(),
    structureHash: hashes,
  };
}
