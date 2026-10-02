/**
 * Rule-table document validation: the same checks, with the same EBMR-MKT codes, as
 * market.validate_document in SQL (which is the gate; this copy lets the loader and the pure engine
 * refuse a bad file before it reaches the database).
 */
import { isCanonicalDecimal } from './decimal.ts';
import type { RuleTableProblem } from './errors.ts';
import { DEFAULT_MARKETS, isIsoDate } from './resolve.ts';
import { byCode, canonicalJson, isAtLeastAsStrict } from './strictness.ts';
import type { ComparisonMethod, RuleValue, ValueType } from './types.ts';
import { COMPARISON_METHODS, FLOOR_TYPES, KEY_PREFIX, VALUE_TYPES, VERIFICATION_STATUSES } from './types.ts';

type Obj = Record<string, unknown>;

const DOC_FIELDS = ['table', 'version', 'title', 'change', 'keys', 'rows'];
const KEY_FIELDS = ['key', 'title', 'method', 'valueType', 'unit', 'orderedValues', 'statedMethod', 'indiaGoverns', 'predicates', 'catalogRefs', 'description'];
const ROW_FIELDS = ['ref', 'key', 'market', 'predicate', 'value', 'unit', 'floor', 'hardFloor', 'source', 'verification', 'effectiveFrom', 'effectiveTo', 'note'];
const SCALAR_METHODS: readonly string[] = ['SMALLER_STRICTER', 'LARGER_STRICTER', 'ORDERED', 'REQUIRED_IF_ANY'];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:+-]*$/;
const KEY_NAME = /^[a-z][a-z0-9]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const isAbsent = (v: unknown): boolean => v === undefined || v === null;
const isIdentifier = (v: unknown): v is string => typeof v === 'string' && IDENTIFIER.test(v);

function hasNumber(v: unknown): boolean {
  if (typeof v === 'number' || typeof v === 'bigint') return true;
  if (Array.isArray(v)) return v.some(hasNumber);
  if (isObj(v)) return Object.values(v).some(hasNumber);
  return false;
}

/** A value's shape problem for a value type, or null when it is well formed (market.value_problem). */
export function valueProblem(type: unknown, ordered: unknown, value: unknown): string | null {
  if (isAbsent(value)) return 'the value is missing';
  if (hasNumber(value)) return 'numbers must be written as quoted decimal strings, never as JSON numbers';
  switch (type) {
    case 'DECIMAL':
      return isCanonicalDecimal(value) ? null : `${JSON.stringify(value)} is not a canonical decimal string (no exponent, no leading zeros, no trailing zeros)`;
    case 'BOOLEAN':
      return typeof value === 'boolean' ? null : `${JSON.stringify(value)} is not a boolean`;
    case 'CATEGORY':
      return typeof value === 'string' && Array.isArray(ordered) && ordered.includes(value) ? null : `${JSON.stringify(value)} is not one of the ordered values`;
    case 'SET': {
      if (!Array.isArray(value)) return 'a set value must be an array of identifiers';
      const seen = new Set<string>();
      for (const e of value) {
        if (!isIdentifier(e)) return `set element ${JSON.stringify(e)} is not an identifier`;
        if (seen.has(e)) return `set element ${JSON.stringify(e)} is repeated`;
        seen.add(e);
      }
      return null;
    }
    case 'CRITERIA': {
      if (!Array.isArray(value)) return 'a criteria value must be an array of criterion objects';
      const seen = new Set<string>();
      for (const e of value) {
        if (!isObj(e) || !isIdentifier(e['id'])) return 'every criterion must be an object with an identifier in "id"';
        const id = e['id'];
        if (seen.has(id)) return `criterion ${id} is repeated`;
        seen.add(id);
      }
      return null;
    }
    case 'ANY':
      return null;
    default:
      return `unknown value type ${typeof type === 'string' ? type : '(missing)'}`;
  }
}

interface WindowRow {
  ref: string;
  key: string;
  market: string;
  pred: Obj;
  from: string;
  to: string | null;
}

const overlaps = (a: WindowRow, b: WindowRow): boolean => (a.to === null || b.from < a.to) && (b.to === null || a.from < b.to);
const contains = (big: Obj, small: Obj): boolean => Object.entries(small).every(([k, v]) => Object.hasOwn(big, k) && big[k] === v);
const compatible = (a: Obj, b: Obj): boolean => Object.entries(a).every(([k, v]) => !Object.hasOwn(b, k) || b[k] === v);

export interface ValidateOptions {
  knownMarkets?: readonly string[];
  /** Rule tables and their key prefixes (market.rule_table); defaults to kernel, tablets, sterile. */
  tables?: Readonly<Record<string, string>>;
}

/** Why a known comparison method cannot compare values of a known value type (EBMR-MKT-015), or null when it can. */
function methodTypeProblem(method: string, type: string): string | null {
  if (SCALAR_METHODS.includes(method) && ['SET', 'CRITERIA', 'ANY'].includes(type)) return `scalar method ${method} on a multi-component key (value type ${type})`;
  if (
    (['SMALLER_STRICTER', 'LARGER_STRICTER'].includes(method) && type !== 'DECIMAL') ||
    (method === 'ORDERED' && type !== 'CATEGORY') ||
    (method === 'REQUIRED_IF_ANY' && type !== 'BOOLEAN') ||
    (method === 'SET_UNION' && type !== 'SET') ||
    (method === 'ALL_APPLY' && type !== 'CRITERIA')
  ) {
    return `method ${method} does not fit value type ${type}`;
  }
  return null;
}

export function validateRuleTableDocument(doc: unknown, options: ValidateOptions = {}): RuleTableProblem[] {
  const markets = options.knownMarkets ?? DEFAULT_MARKETS;
  const out: RuleTableProblem[] = [];
  const add = (code: string, message: string) => out.push({ code, message });
  if (!isObj(doc)) {
    add('EBMR-MKT-010', 'a rule-table document must be a JSON object');
    return out;
  }
  for (const f of Object.keys(doc)) if (!DOC_FIELDS.includes(f)) add('EBMR-MKT-010', `unknown document field "${f}"`);
  const table = doc['table'];
  const prefixes: Readonly<Record<string, string>> = options.tables ?? KEY_PREFIX;
  const prefix = typeof table === 'string' && Object.hasOwn(prefixes, table) ? prefixes[table] : undefined;
  if (prefix === undefined) {
    add('EBMR-MKT-011', `unknown rule table "${typeof table === 'string' ? table : '(missing)'}"`);
    return out;
  }
  const version = doc['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 999999) add('EBMR-MKT-010', 'version must be a positive integer');
  const keysIn = doc['keys'];
  if (!Array.isArray(keysIn) || keysIn.length === 0) {
    add('EBMR-MKT-010', 'keys must be a non-empty array');
    return out;
  }
  const rowsIn = doc['rows'];
  if (!Array.isArray(rowsIn)) {
    add('EBMR-MKT-010', 'rows must be an array');
    return out;
  }

  const keys = new Map<string, Obj>();
  for (const k of keysIn) {
    if (!isObj(k)) {
      add('EBMR-MKT-010', 'every key must be an object');
      continue;
    }
    for (const f of Object.keys(k)) if (!KEY_FIELDS.includes(f)) add('EBMR-MKT-010', `key ${typeof k['key'] === 'string' ? k['key'] : '?'}: unknown field "${f}"`);
    const name = k['key'];
    if (typeof name !== 'string' || !KEY_NAME.test(name)) {
      add('EBMR-MKT-013', `key name ${typeof name === 'string' ? name : '(missing)'} is not a dotted identifier`);
      continue;
    }
    if (!name.startsWith(prefix)) {
      add('EBMR-MKT-013', `key ${name} does not belong to table ${table as string} (namespace ${prefix}*)`);
      continue;
    }
    if (keys.has(name)) {
      add('EBMR-MKT-013', `key ${name} is defined twice`);
      continue;
    }
    if (typeof k['title'] !== 'string' || k['title'].trim() === '') add('EBMR-MKT-010', `key ${name} needs a title`);
    if (Object.hasOwn(k, 'description') && !isAbsent(k['description']) && typeof k['description'] !== 'string') add('EBMR-MKT-010', `key ${name}: description must be text`);
    if (typeof k['indiaGoverns'] !== 'boolean') add('EBMR-MKT-010', `key ${name}: indiaGoverns must be true or false`);
    const refs = k['catalogRefs'];
    if (!isAbsent(refs) && (!Array.isArray(refs) || refs.some((r) => typeof r !== 'string' || !/^(B|DI|PR|ST|IN)-[0-9]{2}$/.test(r)))) {
      add('EBMR-MKT-010', `key ${name}: catalogRefs must list ids such as B-01 or IN-08`);
    }
    if (typeof k['unit'] !== 'string' || !/^\S{1,40}$/.test(k['unit'])) add('EBMR-MKT-010', `key ${name} needs a unit`);
    const method = k['method'];
    const type = k['valueType'];
    const methodOk = typeof method === 'string' && (COMPARISON_METHODS as readonly string[]).includes(method);
    if (!methodOk) add('EBMR-MKT-014', `key ${name}: unknown comparison method ${typeof method === 'string' ? method : '(missing)'}`);
    if (typeof type !== 'string' || !(VALUE_TYPES as readonly string[]).includes(type)) {
      add('EBMR-MKT-015', `key ${name}: unknown value type ${typeof type === 'string' ? type : '(missing)'}`);
    } else if (methodOk) {
      const misfit = methodTypeProblem(method, type);
      if (misfit !== null) add('EBMR-MKT-015', `key ${name}: ${misfit}`);
    }
    const ordered = k['orderedValues'];
    if (method === 'ORDERED' || type === 'CATEGORY') {
      if (!Array.isArray(ordered) || ordered.length === 0 || ordered.some((v) => !isIdentifier(v)) || new Set(ordered).size !== ordered.length) {
        add('EBMR-MKT-016', `key ${name}: orderedValues must list distinct identifiers from least to most strict`);
      }
    } else if (!isAbsent(ordered)) {
      add('EBMR-MKT-016', `key ${name}: orderedValues is only for ORDERED keys`);
    }
    if (method === 'NOT_COMPARABLE') {
      if (k['statedMethod'] !== 'PER_DESTINATION') add('EBMR-MKT-016', `key ${name}: a NOT_COMPARABLE key needs a stated method (PER_DESTINATION)`);
    } else if (!isAbsent(k['statedMethod'])) {
      add('EBMR-MKT-016', `key ${name}: statedMethod is only for NOT_COMPARABLE keys`);
    }
    const domain = isAbsent(k['predicates']) ? {} : k['predicates'];
    if (!isObj(domain)) {
      add('EBMR-MKT-022', `key ${name}: predicates must map attribute names to their allowed values`);
    } else {
      for (const [attr, allowed] of Object.entries(domain)) {
        if (
          !/^[a-z][A-Za-z0-9]*$/.test(attr) ||
          !Array.isArray(allowed) ||
          allowed.length === 0 ||
          allowed.some((v) => typeof v !== 'string' && typeof v !== 'boolean') ||
          new Set(allowed).size !== allowed.length
        ) {
          add('EBMR-MKT-022', `key ${name}: predicate ${attr} needs a list of distinct text or true/false values`);
        }
      }
    }
    keys.set(name, k);
  }

  const refs = new Set<string>();
  const good: { row: Obj; w: WindowRow }[] = [];
  for (const r of rowsIn) {
    if (!isObj(r)) {
      add('EBMR-MKT-010', 'every row must be an object');
      continue;
    }
    for (const f of Object.keys(r)) if (!ROW_FIELDS.includes(f)) add('EBMR-MKT-010', `row ${typeof r['ref'] === 'string' ? r['ref'] : '?'}: unknown field "${f}"`);
    const name = typeof r['ref'] === 'string' ? r['ref'] : '?';
    let ok = true;
    if (!isIdentifier(r['ref'])) {
      add('EBMR-MKT-029', `row ${name} needs an identifier in "ref"`);
      ok = false;
    } else if (refs.has(r['ref'])) {
      add('EBMR-MKT-029', `row ref ${name} is used twice`);
      ok = false;
    } else refs.add(r['ref']);
    const key = typeof r['key'] === 'string' ? keys.get(r['key']) : undefined;
    if (!key) {
      add('EBMR-MKT-017', `row ${name} refers to key ${typeof r['key'] === 'string' ? r['key'] : '(missing)'}, which this table does not define`);
      continue;
    }
    if (typeof r['market'] !== 'string' || !markets.includes(r['market'])) {
      add('EBMR-MKT-018', `row ${name}: unknown market ${typeof r['market'] === 'string' ? r['market'] : '(missing)'}`);
      ok = false;
    }
    if (r['unit'] !== key['unit']) {
      add('EBMR-MKT-019', `row ${name}: unit ${typeof r['unit'] === 'string' ? r['unit'] : '(missing)'} does not match the unit ${String(key['unit'])} of key ${String(key['key'])}`);
      ok = false;
    }
    const prob = valueProblem(key['valueType'], key['orderedValues'], r['value']);
    if (prob !== null) {
      add('EBMR-MKT-020', `row ${name}: ${prob}`);
      ok = false;
    }
    if (!(FLOOR_TYPES as readonly unknown[]).includes(r['floor'])) {
      add('EBMR-MKT-021', `row ${name}: floor must be HARD, GUIDANCE, EXAMPLE or DESIGN`);
      ok = false;
    }
    if (!(VERIFICATION_STATUSES as readonly unknown[]).includes(r['verification'])) {
      add('EBMR-MKT-021', `row ${name}: verification must be P, P~, S, U, CHK or GK`);
      ok = false;
    }
    if (typeof r['source'] !== 'string' || r['source'].trim() === '') {
      add('EBMR-MKT-021', `row ${name} needs a source citation`);
      ok = false;
    }
    if (Object.hasOwn(r, 'note') && !isAbsent(r['note']) && typeof r['note'] !== 'string') {
      add('EBMR-MKT-021', `row ${name}: note must be text`);
      ok = false;
    }
    const from = r['effectiveFrom'];
    const to = isAbsent(r['effectiveTo']) ? null : r['effectiveTo'];
    if (!isIsoDate(from)) {
      add('EBMR-MKT-021', `row ${name}: effectiveFrom must be a date written YYYY-MM-DD`);
      ok = false;
    }
    if (to !== null && (!isIsoDate(to) || (isIsoDate(from) && to <= from))) {
      add('EBMR-MKT-021', `row ${name}: effectiveTo must be a date after effectiveFrom`);
      ok = false;
    }
    const pred = isAbsent(r['predicate']) ? {} : r['predicate'];
    const domain = isAbsent(key['predicates']) ? {} : key['predicates'];
    if (!isObj(pred)) {
      add('EBMR-MKT-022', `row ${name}: predicate must be an object`);
      ok = false;
    } else {
      for (const [attr, v] of Object.entries(pred)) {
        const allowed = isObj(domain) ? domain[attr] : undefined;
        if (!Array.isArray(allowed) || !allowed.includes(v)) {
          add('EBMR-MKT-022', `row ${name}: predicate ${attr} = ${JSON.stringify(v)} is not declared on key ${String(key['key'])}`);
          ok = false;
        }
      }
    }
    const hard = r['hardFloor'];
    if (!isAbsent(hard)) {
      const hardProblem = valueProblem(key['valueType'], key['orderedValues'], hard);
      if (r['floor'] === 'HARD') {
        add('EBMR-MKT-023', `row ${name}: a HARD value is its own floor; hardFloor is only for GUIDANCE, EXAMPLE or DESIGN values`);
        ok = false;
      } else if (key['method'] === 'NOT_COMPARABLE') {
        add('EBMR-MKT-023', `row ${name}: a NOT_COMPARABLE key has no hard floor`);
        ok = false;
      } else if (hardProblem !== null) {
        add('EBMR-MKT-023', `row ${name}: hardFloor: ${hardProblem}`);
        ok = false;
      } else if (
        prob === null &&
        (COMPARISON_METHODS as readonly unknown[]).includes(key['method']) &&
        (VALUE_TYPES as readonly unknown[]).includes(key['valueType']) &&
        // A method that does not fit the value type (EBMR-MKT-015 on the key) cannot compare the two values.
        methodTypeProblem(key['method'] as string, key['valueType'] as string) === null &&
        !isAtLeastAsStrict(key['method'] as ComparisonMethod, key['orderedValues'] as string[] | null, r['value'] as RuleValue, hard as RuleValue)
      ) {
        add('EBMR-MKT-023', `row ${name}: the value is looser than its own hard floor`);
        ok = false;
      }
    }
    if (ok) {
      good.push({ row: r, w: { ref: name, key: String(r['key']), market: String(r['market']), pred: pred as Obj, from: from as string, to: to as string | null } });
    }
  }

  // Cross-row checks on the well-formed rows.
  for (let i = 0; i < good.length; i++) {
    for (let j = i + 1; j < good.length; j++) {
      // Stryker disable next-line OptionalChaining: equivalent; the loop condition i < good.length keeps good[i] defined, so the chain never short-circuits.
      const a = good[i]?.w;
      // Stryker disable next-line OptionalChaining: equivalent; the loop condition j < good.length keeps good[j] defined, so the chain never short-circuits.
      const b = good[j]?.w;
      if (!a || !b || a.key !== b.key || a.market !== b.market || !overlaps(a, b)) continue;
      if (canonicalJson(a.pred) === canonicalJson(b.pred)) {
        add('EBMR-MKT-024', `rows ${a.ref} and ${b.ref}: overlapping effective windows for key ${a.key}, market ${a.market}, predicate ${canonicalJson(a.pred)}`);
      } else if (!contains(a.pred, b.pred) && !contains(b.pred, a.pred) && compatible(a.pred, b.pred)) {
        add('EBMR-MKT-025', `rows ${a.ref} and ${b.ref}: predicates overlap without one refining the other (key ${a.key}, market ${a.market}), so the branch would be ambiguous`);
      }
    }
  }
  for (const [name, key] of keys) {
    const rowsOfKey = good.filter((g) => g.w.key === name).map((g) => g.w);
    const india = rowsOfKey.filter((w) => w.market === 'IN');
    if (key['indiaGoverns'] === true) {
      if (india.length === 0) {
        add('EBMR-MKT-026', `key ${name} is governed by India but has no India (IN) row`);
        continue;
      }
      const lo = india.map((w) => w.from).sort(byCode)[0] as string;
      const hi = rowsOfKey.some((w) => w.to === null) ? null : (rowsOfKey.map((w) => w.to as string).sort(byCode).at(-1) as string);
      // Walk India's windows from lo; every date up to hi must be covered.
      // Stryker disable next-line MethodExpression: equivalent; windows are only filtered below and the new reach comes from their sorted end dates, so their order cannot change the result.
      const windows = india.map((w) => ({ from: w.from, to: w.to })).sort((x, y) => byCode(x.from, y.from));
      let reach: string | null = lo;
      let covered = false;
      for (;;) {
        if (reach === null || (hi !== null && reach >= hi)) {
          covered = true;
          break;
        }
        const current: string = reach;
        const next = windows.filter((w) => w.from <= current && (w.to === null || w.to > current));
        if (next.length === 0) break;
        // Stryker disable next-line MethodExpression,ArrowFunction: equivalent; an open-ended window containing the reach still contains every later end date the walk moves to, so the walk ends covered whether it stops at once (some) or only once open windows remain (every, or some never true).
        reach = next.some((w) => w.to === null) ? null : (next.map((w) => w.to as string).sort(byCode).at(-1) as string);
      }
      if (!covered) add('EBMR-MKT-026', `key ${name} is governed by India but India (IN) rows leave a gap in the effective period`);
    } else if (india.length > 0) {
      add('EBMR-MKT-027', `key ${name} says India does not govern it but has India (IN) rows`);
    }
  }
  const criteria = new Map<string, Set<string>>();
  for (const { row } of good) {
    const key = keys.get(String(row['key']));
    // Stryker disable next-line OptionalChaining: equivalent; a row reaches good only after the same key lookup found its key (if (!key) continue above), so key is never undefined here.
    if (key?.['method'] !== 'ALL_APPLY') continue;
    const all = [...(row['value'] as Obj[]), ...(isAbsent(row['hardFloor']) ? [] : (row['hardFloor'] as Obj[]))];
    for (const c of all) {
      const id = `${String(row['key'])}\u0000${String(c['id'])}`;
      criteria.set(id, (criteria.get(id) ?? new Set()).add(canonicalJson(c)));
    }
  }
  for (const [id, versions] of [...criteria.entries()].sort(([a], [b]) => byCode(a, b))) {
    if (versions.size > 1) {
      const [key, crit] = id.split('\u0000');
      add('EBMR-MKT-028', `key ${key ?? '?'}: criterion ${crit ?? '?'} is defined differently in different rows`);
    }
  }
  return out;
}

/** Narrowing helper for callers that validated a document. */
export function isValueType(v: unknown): v is ValueType {
  return typeof v === 'string' && (VALUE_TYPES as readonly string[]).includes(v);
}
