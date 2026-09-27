/**
 * "At least as strict" for every comparison method (build outline 3.3.1), mirroring
 * market.at_least_as_strict, market.set_merge and market.binding_value in SQL.
 */
import { compareDecimal } from './decimal.ts';
import { MarketRuleError } from './errors.ts';
import type { ComparisonMethod, Criterion, FloorType, RuleValue } from './types.ts';

/** Code-unit order, identical to PostgreSQL's COLLATE "C" for the ASCII identifiers used here. */
export function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON text with object keys sorted, for structural equality and hashing. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => byCode(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function floorRank(floor: string | null | undefined): number {
  switch (floor) {
    case 'HARD':
      return 4;
    case 'GUIDANCE':
      return 3;
    case 'EXAMPLE':
      return 2;
    case 'DESIGN':
      return 1;
    default:
      return 0;
  }
}

/** GUIDANCE and adopted EXAMPLE values may be loosened by a site with justification and QA approval. */
export function siteLoosenable(floor: FloorType): boolean {
  return floor === 'GUIDANCE' || floor === 'EXAMPLE';
}

export function categoryRank(ordered: readonly string[] | null | undefined, value: RuleValue): number | undefined {
  if (!ordered || typeof value !== 'string') return undefined;
  const index = ordered.indexOf(value);
  return index < 0 ? undefined : index + 1;
}

/** Text of a scalar rule value (decimals, identifiers); other values as canonical JSON. */
export function textOf(value: RuleValue): string {
  return typeof value === 'string' ? value : canonicalJson(value);
}

function decimalOf(value: RuleValue): string {
  if (typeof value !== 'string') throw new MarketRuleError('EBMR-MKT-020', `${canonicalJson(value)} is not a decimal string`);
  return value;
}

function asStringSet(value: RuleValue): Set<string> {
  if (!Array.isArray(value)) throw new MarketRuleError('EBMR-MKT-020', 'a set value must be an array');
  return new Set(value.map(textOf));
}

function criterionIds(value: RuleValue): Set<string> {
  if (!Array.isArray(value)) throw new MarketRuleError('EBMR-MKT-020', 'a criteria value must be an array');
  return new Set(value.map((c) => (c as Criterion).id));
}

function superset(a: Set<string>, b: Set<string>): boolean {
  for (const x of b) if (!a.has(x)) return false;
  return true;
}

/** Is value a at least as strict as value b? Throws for NOT_COMPARABLE keys. */
export function isAtLeastAsStrict(method: ComparisonMethod, ordered: readonly string[] | null | undefined, a: RuleValue, b: RuleValue): boolean {
  switch (method) {
    case 'SMALLER_STRICTER':
      return compareDecimal(decimalOf(a), decimalOf(b)) <= 0;
    case 'LARGER_STRICTER':
      return compareDecimal(decimalOf(a), decimalOf(b)) >= 0;
    case 'ORDERED': {
      const ra = categoryRank(ordered, a);
      const rb = categoryRank(ordered, b);
      if (ra === undefined || rb === undefined) throw new MarketRuleError('EBMR-MKT-020', `value ${canonicalJson(ra === undefined ? a : b)} is not in the ordered list`);
      return ra >= rb;
    }
    case 'REQUIRED_IF_ANY':
      return a === true || b === false;
    case 'SET_UNION':
      return superset(asStringSet(a), asStringSet(b));
    case 'ALL_APPLY':
      return superset(criterionIds(a), criterionIds(b));
    case 'NOT_COMPARABLE':
      throw new MarketRuleError('EBMR-MKT-046', 'NOT_COMPARABLE values cannot be ranked');
  }
}

/** Union of two set-valued values, sorted (SET_UNION: strings; ALL_APPLY: criteria by id). */
export function setMerge(method: ComparisonMethod, a: RuleValue, b: RuleValue): RuleValue {
  if (a === null) return b;
  if (b === null) return a;
  if (method === 'SET_UNION') {
    return [...new Set([...asStringSet(a), ...asStringSet(b)])].sort(byCode);
  }
  const byId = new Map<string, RuleValue[]>();
  for (const c of [...(a as RuleValue[]), ...(b as RuleValue[])]) {
    const id = (c as Criterion).id;
    byId.set(id, [...(byId.get(id) ?? []), c]);
  }
  return [...byId.entries()]
    .sort(([x], [y]) => byCode(x, y))
    .map(([, versions]) => versions.slice().sort((x, y) => byCode(canonicalJson(x), canonicalJson(y)))[0] ?? null);
}

/** The binding value of a row: its value if HARD, otherwise its hard floor (or null). */
export function bindingValue(floor: FloorType, value: RuleValue, hardFloor: RuleValue): RuleValue {
  return floor === 'HARD' ? value : hardFloor;
}
