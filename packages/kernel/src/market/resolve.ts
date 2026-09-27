/**
 * The pure resolution engine (build outline 3.3.2; ADR 0008; IN-52; INV-28).
 *
 * resolve(table, {key, marketSet, predicates, asOf, stated}) returns the value that satisfies India
 * and every market in the set under the key's comparison method, the market(s) that govern it, the
 * predicate branch used per market, and the inputs. It is the TypeScript twin of market.resolve in
 * SQL; tests prove both return identical results. It performs no I/O and never uses a JavaScript
 * number for a rule value.
 */
import { MarketRuleError } from './errors.ts';
import { bindingValue, byCode, floorRank, isAtLeastAsStrict, jsonEqual, setMerge, textOf } from './strictness.ts';
import type {
  Component,
  Contribution,
  Criterion,
  FloorType,
  Market,
  Predicates,
  Resolution,
  ResolveRequest,
  RuleTableSnapshot,
  RuleValue,
  SnapshotRow,
} from './types.ts';
import { INDIA } from './types.ts';

export const DEFAULT_MARKETS: readonly Market[] = ['EU', 'IN', 'US'];

const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** A real calendar date written YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map((part) => Number.parseInt(part, 10)) as [number, number, number];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return days !== undefined && d >= 1 && d <= days;
}

/** Validates a market set and returns it sorted; India must be present (INV-28). */
export function checkedMarketSet(set: readonly Market[] | null | undefined, known: readonly Market[] = DEFAULT_MARKETS): Market[] {
  if (!set || set.length === 0) throw new MarketRuleError('EBMR-MKT-001', 'a market set is required');
  if (new Set(set).size !== set.length) throw new MarketRuleError('EBMR-MKT-001', `market set {${set.join(',')}} repeats a market`);
  const unknown = set.find((m) => !known.includes(m));
  if (unknown !== undefined) throw new MarketRuleError('EBMR-MKT-001', `unknown market ${unknown}`);
  if (!set.includes(INDIA)) {
    throw new MarketRuleError(
      'EBMR-MKT-001',
      `market set {${set.join(',')}} does not include IN: Indian GMP applies to every batch made under an Indian licence (INV-28)`,
    );
  }
  return [...set].sort(byCode);
}

export function isEffective(row: Pick<SnapshotRow, 'effectiveFrom' | 'effectiveTo'>, asOf: string): boolean {
  return row.effectiveFrom <= asOf && (row.effectiveTo === null || asOf < row.effectiveTo);
}

function predicateMatches(rowPredicate: Predicates, given: Predicates): boolean {
  return Object.entries(rowPredicate).every(([attr, value]) => Object.hasOwn(given, attr) && given[attr] === value);
}

function specificity(predicate: Predicates): number {
  return Object.keys(predicate).length;
}

/** The row that applies for one market: the most specific matching effective row (as market.select_row). */
export function selectRow(rows: readonly SnapshotRow[], market: Market, predicates: Predicates, asOf: string): SnapshotRow | undefined {
  const candidates = rows
    .filter((r) => r.market === market && isEffective(r, asOf) && predicateMatches(r.predicate, predicates))
    .sort((a, b) => specificity(b.predicate) - specificity(a.predicate) || byCode(a.ref, b.ref));
  const [best, next] = candidates;
  if (best && next && specificity(best.predicate) === specificity(next.predicate)) {
    throw new MarketRuleError('EBMR-MKT-044', `rows ${best.ref} and ${next.ref} both apply to key ${best.key} for market ${market}: ambiguous predicate branch`);
  }
  return best;
}

function contributionOf(row: SnapshotRow): Contribution {
  return {
    market: row.market,
    rowId: row.id,
    rowRef: row.ref,
    value: row.value,
    floorType: row.floor,
    hardFloor: row.hardFloor,
    predicate: row.predicate,
  };
}

function strongestFloor(contributions: readonly Contribution[]): FloorType | null {
  let best: FloorType | null = null;
  for (const c of contributions) if (best === null || floorRank(c.floorType) > floorRank(best)) best = c.floorType;
  return best;
}

function components(contributions: readonly Contribution[], idOf: (element: RuleValue) => string): { value: RuleValue[]; components: Component[] } {
  const byId = new Map<string, { value: RuleValue; markets: Market[]; floor: FloorType }>();
  for (const c of contributions) {
    for (const element of c.value as RuleValue[]) {
      const id = idOf(element);
      const entry = byId.get(id);
      if (!entry) byId.set(id, { value: element, markets: [c.market], floor: c.floorType });
      else {
        entry.markets.push(c.market);
        if (floorRank(c.floorType) > floorRank(entry.floor)) entry.floor = c.floorType;
      }
    }
  }
  const sorted = [...byId.entries()].sort(([a], [b]) => byCode(a, b));
  return {
    value: sorted.map(([, e]) => e.value),
    components: sorted.map(([, e]) => ({ value: e.value, markets: [...e.markets].sort(byCode), floorType: e.floor })),
  };
}

export interface ResolveOptions {
  /** Market codes the installation knows (market.market). */
  knownMarkets?: readonly Market[];
}

export function resolve(table: RuleTableSnapshot, request: ResolveRequest, options: ResolveOptions = {}): Resolution {
  const markets = checkedMarketSet(request.marketSet, options.knownMarkets);
  if (!isIsoDate(request.asOf)) throw new MarketRuleError('EBMR-MKT-002', 'a resolution needs an as-of date written YYYY-MM-DD');
  const predicates: Predicates = request.predicates ?? {};
  if (typeof predicates !== 'object' || Array.isArray(predicates)) {
    throw new MarketRuleError('EBMR-MKT-003', 'predicates must be an object of attribute values');
  }
  const key = table.keys.get(request.key);
  if (!key) throw new MarketRuleError('EBMR-MKT-041', `key ${request.key} is not in rule table ${table.tableCode} version ${table.version}`);
  const rows = table.rows.filter((r) => r.key === key.key);
  const stated = request.stated ?? null;
  const inputs = { key: request.key, tableVersionId: table.versionId, marketSet: markets, predicates, asOf: request.asOf, stated };

  // Every predicate attribute that an applicable row uses must be supplied (fail closed).
  const needed = new Set<string>();
  for (const r of rows) if (markets.includes(r.market) && isEffective(r, request.asOf)) for (const attr of Object.keys(r.predicate)) needed.add(attr);
  for (const attr of [...needed].sort(byCode)) {
    if (!Object.hasOwn(predicates, attr)) throw new MarketRuleError('EBMR-MKT-042', `key ${key.key} needs predicate ${attr} to choose its branch`);
    const allowed = key.predicates?.[attr] ?? [];
    if (!allowed.includes(predicates[attr]!)) {
      throw new MarketRuleError('EBMR-MKT-043', `predicate ${attr} = ${JSON.stringify(predicates[attr])} is outside the values declared for key ${key.key}`);
    }
  }

  const contributions: Contribution[] = [];
  const predicateBranch: Record<Market, Predicates> = {};
  for (const market of markets) {
    const row = selectRow(rows, market, predicates, request.asOf);
    if (row) {
      contributions.push(contributionOf(row));
      predicateBranch[market] = row.predicate;
    }
  }
  const india = contributions.find((c) => c.market === INDIA);
  if (key.indiaGoverns && !india) {
    throw new MarketRuleError(
      'EBMR-MKT-045',
      `key ${key.key} has no India value for predicates ${JSON.stringify(predicates)} on ${request.asOf}; India always applies, so the resolution is refused`,
    );
  }
  const base = {
    key: key.key,
    tableCode: table.tableCode,
    tableVersionId: table.versionId,
    tableVersion: table.version,
    method: key.method,
    valueType: key.valueType,
    unit: key.unit,
    inputs,
  };
  if (contributions.length === 0) {
    return {
      ...base,
      applicable: false,
      value: null,
      governingMarkets: [],
      floorType: null,
      hardFloor: null,
      predicateBranch: {},
      contributions: [],
      components: null,
      stated: null,
    };
  }

  let value: RuleValue = null;
  let governing: Market[] = [];
  let comps: Component[] | null = null;
  let statedOut: Resolution['stated'] = null;
  switch (key.method) {
    case 'SMALLER_STRICTER':
    case 'LARGER_STRICTER':
    case 'ORDERED':
    case 'REQUIRED_IF_ANY': {
      for (const c of contributions) {
        if (value === null || !isAtLeastAsStrict(key.method, key.orderedValues, value, c.value)) value = c.value;
      }
      governing = contributions.filter((c) => jsonEqual(c.value, value)).map((c) => c.market);
      break;
    }
    case 'SET_UNION':
    case 'ALL_APPLY': {
      const idOf = key.method === 'SET_UNION' ? textOf : (e: RuleValue) => (e as Criterion).id;
      const merged = components(contributions, idOf);
      value = merged.value;
      comps = merged.components;
      governing = contributions.filter((c) => (c.value as RuleValue[]).length > 0).map((c) => c.market);
      break;
    }
    case 'NOT_COMPARABLE': {
      if (!stated || typeof stated !== 'object') {
        throw new MarketRuleError(
          'EBMR-MKT-046',
          `key ${key.key} cannot be ranked across markets; resolving it needs a stated method (${key.statedMethod ?? 'PER_DESTINATION'}) with a regulatory decision reference`,
        );
      }
      if (stated.method !== key.statedMethod) throw new MarketRuleError('EBMR-MKT-046', `key ${key.key} must be resolved by stated method ${key.statedMethod ?? '?'}`);
      const destination = stated.destination;
      if (destination === undefined || !markets.includes(destination)) {
        throw new MarketRuleError('EBMR-MKT-047', `destination ${destination ?? '(missing)'} is not in the market set {${markets.join(',')}}`);
      }
      if (!stated.decisionRef || stated.decisionRef.trim() === '') {
        throw new MarketRuleError('EBMR-MKT-047', `key ${key.key} needs a regulatory decision reference for destination ${destination}`);
      }
      const chosen = contributions.find((c) => c.market === destination);
      if (!chosen) throw new MarketRuleError('EBMR-MKT-047', `key ${key.key} has no row for destination ${destination}`);
      value = chosen.value;
      governing = [destination];
      statedOut = { method: stated.method, destination, decisionRef: stated.decisionRef };
      break;
    }
  }

  const floorType = strongestFloor(contributions.filter((c) => governing.includes(c.market)));
  let hardFloor: RuleValue = null;
  if (key.method !== 'NOT_COMPARABLE') {
    for (const c of contributions) {
      const binding = bindingValue(c.floorType, c.value, c.hardFloor);
      if (binding === null) continue;
      if (key.method === 'SET_UNION' || key.method === 'ALL_APPLY') hardFloor = setMerge(key.method, hardFloor, binding);
      else if (hardFloor === null || !isAtLeastAsStrict(key.method, key.orderedValues, hardFloor, binding)) hardFloor = binding;
    }
    // INV-28 second line: the result is never looser than India's value.
    if (india && !isAtLeastAsStrict(key.method, key.orderedValues, value, india.value)) {
      throw new MarketRuleError('EBMR-MKT-049', `internal error: key ${key.key} resolved looser than India (INV-28)`);
    }
  }

  return {
    ...base,
    applicable: true,
    value,
    governingMarkets: governing,
    floorType,
    hardFloor,
    predicateBranch,
    contributions,
    components: comps,
    stated: statedOut,
  };
}
