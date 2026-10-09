/**
 * INV-28 as properties (build outline 5.3, 9.1): India is in every market set, and for every
 * comparable atomic key the resolved value is at least as strict as India's (and as every other
 * market's in the set). Checked over the seed tables and over randomly generated tables, and the
 * TypeScript and SQL resolvers are shown to agree on random inputs.
 *
 * "At least as strict" is judged by an oracle written here independently of the engines'
 * comparators (isAtLeastAsStrict, market.at_least_as_strict), and the comparators are shown to agree
 * with it. Generated ALL_APPLY criteria carry content that does not follow from their id, so a
 * criterion that keeps its id but changes its definition is exercised too (F20).
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MarketRuleError } from '../../src/market/errors.ts';
import { loadRuleTableVersion, resolveInDatabase } from '../../src/market/repository.ts';
import { resolve } from '../../src/market/resolve.ts';
import { snapshotFromDocument } from '../../src/market/snapshot.ts';
import { isAtLeastAsStrict, isSameValue } from '../../src/market/strictness.ts';
import type { ComparisonMethod, Predicates, ResolveRequest, RuleKeyDoc, RuleRowDoc, RuleTableDocument, RuleTableSnapshot, RuleValue } from '../../src/market/types.ts';
import { validateRuleTableDocument } from '../../src/market/validate.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { createTestTable, publishDocument, publishSeedTables, seedDocument } from './helpers.ts';

const seeds: RuleTableSnapshot[] = (['kernel', 'tablets', 'sterile'] as const).map((t) => snapshotFromDocument(seedDocument(t)));
const comparable = seeds.flatMap((s) => [...s.keys.values()].filter((k) => k.method !== 'NOT_COMPARABLE').map((k) => ({ snapshot: s, key: k })));

/** A date between 2022-01-01 and 2031-12-31 (some before India's first row, to exercise refusals). */
const dateArb = fc.integer({ min: 0, max: 3651 }).map((d) => new Date(Date.UTC(2022, 0, 1) + d * 86_400_000).toISOString().slice(0, 10));
const extraMarketsArb = fc.subarray(['US', 'EU']);
const predicatesArb: fc.Arbitrary<Predicates> = fc.record({
  licenceForm: fc.constantFrom('FORM_25', 'FORM_28'),
  expiryLabelled: fc.boolean(),
  otcExpiryExempt: fc.boolean(),
});

// ---------------------------------------------------------------------------------------------
// Independent oracle for "a is at least as strict as b" (shares no code with the engines)
// ---------------------------------------------------------------------------------------------

/** A canonical decimal string as an exact rational n / 10^scale. */
function rational(text: string): { n: bigint; scale: number } {
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const n = BigInt(whole + fraction);
  return { n: negative ? -n : n, scale: fraction.length };
}

function decimalCompare(a: string, b: string): number {
  const x = rational(a);
  const y = rational(b);
  const scale = Math.max(x.scale, y.scale);
  const xs = x.n * 10n ** BigInt(scale - x.scale);
  const ys = y.n * 10n ** BigInt(scale - y.scale);
  return xs < ys ? -1 : xs > ys ? 1 : 0;
}

/** The rule of build outline 3.3.1 for each method; ALL_APPLY: every criterion of b is in a with the same definition. */
function oracleAtLeastAsStrict(method: ComparisonMethod, ordered: readonly string[] | null, a: RuleValue, b: RuleValue): boolean {
  switch (method) {
    case 'SMALLER_STRICTER':
      return decimalCompare(a as string, b as string) <= 0;
    case 'LARGER_STRICTER':
      return decimalCompare(a as string, b as string) >= 0;
    case 'ORDERED':
      return (ordered ?? []).indexOf(a as string) >= (ordered ?? []).indexOf(b as string);
    case 'REQUIRED_IF_ANY':
      return a === true || b === false;
    case 'SET_UNION':
      return (b as string[]).every((x) => (a as string[]).includes(x));
    case 'ALL_APPLY':
      return (b as unknown[]).every((cb) => (a as unknown[]).some((ca) => isDeepStrictEqual(ca, cb)));
    default:
      throw new Error(`no order for ${method}`);
  }
}

function codeOf(error: unknown): string {
  return error instanceof MarketRuleError ? error.code : /^(EBMR-[A-Z]+-[0-9]{3})/.exec((error as Error).message)?.[1] ?? (error as Error).message;
}

function tryResolve(snapshot: RuleTableSnapshot, request: ResolveRequest) {
  try {
    return { ok: true as const, r: resolve(snapshot, request) };
  } catch (error) {
    return { ok: false as const, code: codeOf(error) };
  }
}

describe('INV-28 over the seed tables', () => {
  it('[INV-28][IN-52] for every comparable seed key, market set, predicate branch and date, the result is at least as strict as India and as every market in the set', () => {
    fc.assert(
      fc.property(fc.constantFrom(...comparable), extraMarketsArb, predicatesArb, dateArb, ({ snapshot, key }, extra, predicates, asOf) => {
        const marketSet = ['IN', ...extra];
        const all = tryResolve(snapshot, { key: key.key, marketSet, predicates, asOf });
        const india = tryResolve(snapshot, { key: key.key, marketSet: ['IN'], predicates, asOf });
        if (!all.ok) {
          // The only refusal on valid input: India has no row on that date for a key India governs (fail closed).
          expect(all.code).toBe('EBMR-MKT-045');
          expect(india.ok).toBe(false);
          return;
        }
        if (india.ok && india.r.applicable) {
          expect(oracleAtLeastAsStrict(key.method, key.orderedValues ?? null, all.r.value, india.r.value)).toBe(true);
        }
        for (const c of all.r.contributions) {
          expect(oracleAtLeastAsStrict(key.method, key.orderedValues ?? null, all.r.value, c.value)).toBe(true);
        }
        if (all.r.applicable) expect(all.r.governingMarkets.length).toBeGreaterThan(0);
      }),
      { numRuns: 2000 },
    );
  });

  it('[INV-28] a market set without India is always refused', () => {
    fc.assert(
      fc.property(fc.constantFrom(...comparable), fc.subarray(['US', 'EU']), dateArb, ({ snapshot, key }, marketSet, asOf) => {
        expect(() => resolve(snapshot, { key: key.key, marketSet, asOf, predicates: {} })).toThrow('EBMR-MKT-001');
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Random tables
// ---------------------------------------------------------------------------------------------

const decimalArb = fc.tuple(fc.bigInt({ min: -1_000_000n, max: 1_000_000n }), fc.integer({ min: 0, max: 4 })).map(([digits, scale]) => {
  const negative = digits < 0n;
  const text = (negative ? -digits : digits).toString().padStart(scale + 1, '0');
  const whole = text.slice(0, text.length - scale);
  const fraction = text.slice(text.length - scale).replace(/0+$/, '');
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative && body !== '0' ? `-${body}` : body;
});
const ORDER = ['LOW', 'MID', 'HIGH', 'TOP'];
const METHODS: ComparisonMethod[] = ['SMALLER_STRICTER', 'LARGER_STRICTER', 'ORDERED', 'REQUIRED_IF_ANY', 'SET_UNION', 'ALL_APPLY'];
const TYPE_OF: Record<string, RuleKeyDoc['valueType']> = {
  SMALLER_STRICTER: 'DECIMAL',
  LARGER_STRICTER: 'DECIMAL',
  ORDERED: 'CATEGORY',
  REQUIRED_IF_ANY: 'BOOLEAN',
  SET_UNION: 'SET',
  ALL_APPLY: 'CRITERIA',
};

function valueArb(method: ComparisonMethod): fc.Arbitrary<RuleValue> {
  switch (method) {
    case 'SMALLER_STRICTER':
    case 'LARGER_STRICTER':
      return decimalArb;
    case 'ORDERED':
      return fc.constantFrom(...ORDER);
    case 'REQUIRED_IF_ANY':
      return fc.boolean();
    case 'SET_UNION':
      return fc.uniqueArray(fc.constantFrom('S1', 'S2', 'S3', 'S4', 'S5'));
    default:
      // Criterion ids only; buildDocument gives each id the definition the document chose for it.
      return fc.uniqueArray(fc.constantFrom(...CRITERIA)).map((ids) => ids.map((id) => ({ id })));
  }
}

const CRITERIA = ['C1', 'C2', 'C3', 'C4'] as const;
/** Definitions a criterion id can carry; which one a document uses does not follow from the id. */
const DEFINITIONS: Record<string, unknown>[] = [
  { plan: 'N10', bands: [{ deviationPercent: '10' }, { deviationPercent: '7.5' }] },
  { plan: 'N10', bands: [{ deviationPercent: '50' }] },
  { plan: 'N30', rounding: 'HALF_UP', stage: 'RELEASE' },
];
const definitionsArb = fc.record(Object.fromEntries(CRITERIA.map((id) => [id, fc.nat({ max: DEFINITIONS.length - 1 })])));

/** A criterion with one of the definitions (one document uses one definition per id, EBMR-MKT-028). */
function criterion(id: string, definition: number): Record<string, unknown> {
  return { id, ...DEFINITIONS[definition] };
}

interface MarketRows {
  split: boolean;
  first: RuleValue;
  second: RuleValue;
  specific: RuleValue | null;
  floor: RuleRowDoc['floor'];
}

function marketRowsArb(method: ComparisonMethod): fc.Arbitrary<MarketRows> {
  return fc.record({
    split: fc.boolean(),
    first: valueArb(method),
    second: valueArb(method),
    specific: fc.option(valueArb(method), { nil: null }),
    floor: fc.constantFrom('HARD', 'GUIDANCE', 'EXAMPLE', 'DESIGN'),
  });
}

const generatedArb = fc.constantFrom(...METHODS).chain((method) =>
  fc.record({
    method: fc.constant(method),
    india: marketRowsArb(method),
    us: fc.option(marketRowsArb(method), { nil: null }),
    eu: fc.option(marketRowsArb(method), { nil: null }),
    definitions: definitionsArb,
  }),
);

type Generated = { method: ComparisonMethod; india: MarketRows; us: MarketRows | null; eu: MarketRows | null; definitions: Record<string, number> };

/** ALL_APPLY values carry the document's definition of each criterion id. */
function withDefinitions(g: Generated, value: RuleValue): RuleValue {
  if (g.method !== 'ALL_APPLY') return value;
  return (value as { id: string }[]).map((c) => criterion(c.id, g.definitions[c.id] ?? 0)) as RuleValue;
}

function buildDocument(table: string, g: Generated): RuleTableDocument {
  const key = `${table}.gen`;
  const rows: RuleRowDoc[] = [];
  const base = { key, unit: '{u}', source: 'generated', verification: 'P' as const };
  for (const [market, m] of [['IN', g.india], ['US', g.us], ['EU', g.eu]] as const) {
    if (!m) continue;
    if (m.split) {
      rows.push({ ...base, ref: `${market}.a`, market, value: withDefinitions(g, m.first), floor: m.floor, effectiveFrom: '2024-01-01', effectiveTo: '2025-01-01' });
      rows.push({ ...base, ref: `${market}.b`, market, value: withDefinitions(g, m.second), floor: m.floor, effectiveFrom: '2025-01-01' });
    } else {
      rows.push({ ...base, ref: `${market}.a`, market, value: withDefinitions(g, m.first), floor: m.floor, effectiveFrom: '2024-01-01' });
    }
    if (m.specific !== null) {
      rows.push({ ...base, ref: `${market}.p`, market, predicate: { branch: 'A' }, value: withDefinitions(g, m.specific), floor: m.floor, effectiveFrom: '2024-01-01' });
    }
  }
  return {
    table: table as RuleTableDocument['table'],
    version: 1,
    change: { kind: 'INITIAL', description: 'generated' },
    keys: [
      {
        key,
        title: 'generated key',
        method: g.method,
        valueType: TYPE_OF[g.method] ?? 'DECIMAL',
        unit: '{u}',
        indiaGoverns: true,
        predicates: { branch: ['A', 'B'] },
        ...(g.method === 'ORDERED' ? { orderedValues: ORDER } : {}),
      },
    ],
    rows,
  };
}

const requestArb = fc.record({
  extra: extraMarketsArb,
  asOf: fc.constantFrom('2023-06-01', '2024-06-01', '2025-06-01', '2030-01-01'),
  branch: fc.constantFrom<Predicates | undefined>({ branch: 'A' }, { branch: 'B' }, undefined),
});

describe('INV-28 over randomly generated tables', () => {
  it('[INV-28] whatever the rows say, the result is at least as strict as India and as every market in the set', () => {
    fc.assert(
      fc.property(generatedArb, requestArb, (g, req) => {
        const snapshot = snapshotFromDocument(buildDocument('kernel', g));
        const request = { key: 'kernel.gen', marketSet: ['IN', ...req.extra], asOf: req.asOf, ...(req.branch ? { predicates: req.branch } : {}) };
        const all = tryResolve(snapshot, request);
        if (!all.ok) {
          expect(['EBMR-MKT-045', 'EBMR-MKT-042']).toContain(all.code);
          return;
        }
        const india = resolve(snapshot, { ...request, marketSet: ['IN'] });
        expect(oracleAtLeastAsStrict(g.method, ORDER, all.r.value, india.value)).toBe(true);
        for (const c of all.r.contributions) expect(oracleAtLeastAsStrict(g.method, ORDER, all.r.value, c.value)).toBe(true);
        if (!['SET_UNION', 'ALL_APPLY'].includes(g.method)) {
          expect(all.r.contributions.some((c) => JSON.stringify(c.value) === JSON.stringify(all.r.value))).toBe(true);
        }
      }),
      { numRuns: 1500 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// TypeScript and SQL agree
// ---------------------------------------------------------------------------------------------

describe('the TypeScript engine and market.resolve agree', () => {
  let db: TestDatabase;
  let snapshots: RuleTableSnapshot[];
  beforeAll(async () => {
    db = await createTestDatabase();
    const published = await publishSeedTables(db);
    snapshots = await Promise.all([...published.values()].map((id) => loadRuleTableVersion(db.app, id)));
  });
  afterAll(async () => {
    await db.drop();
  });

  async function compare(snapshot: RuleTableSnapshot, request: ResolveRequest): Promise<void> {
    const ts = tryResolve(snapshot, request);
    let sql: { ok: true; r: unknown } | { ok: false; code: string };
    try {
      sql = { ok: true, r: await resolveInDatabase(db.app, snapshot.versionId, request) };
    } catch (error) {
      sql = { ok: false, code: codeOf(error) };
    }
    if (ts.ok) expect(sql).toEqual({ ok: true, r: ts.r });
    else expect(sql).toEqual({ ok: false, code: ts.code });
  }

  it('[INV-28][IN-52] on random requests over the published seed tables, including refusals', async () => {
    const keyArb = fc.constantFrom(...snapshots.flatMap((s) => [...s.keys.keys()].map((key) => ({ s, key }))));
    const statedArb = fc.option(
      fc.record({ method: fc.constant('PER_DESTINATION' as const), destination: fc.constantFrom('IN', 'US', 'EU'), decisionRef: fc.constantFrom('RA-1', '') }),
      { nil: undefined },
    );
    await fc.assert(
      fc.asyncProperty(keyArb, extraMarketsArb, fc.option(predicatesArb, { nil: undefined }), dateArb, statedArb, async ({ s, key }, extra, predicates, asOf, stated) => {
        await compare(s, { key, marketSet: ['IN', ...extra], asOf, ...(predicates ? { predicates } : {}), ...(stated ? { stated } : {}) });
      }),
      { numRuns: 300 },
    );
  });

  it('[INV-28][IN-52] the comparators of both engines agree with the independent oracle for every method; ALL_APPLY compares whole criteria, so the same id with another definition is never at least as strict', async () => {
    const methodArb = fc.constantFrom(...METHODS);
    const criteriaArb = fc
      .uniqueArray(fc.constantFrom(...CRITERIA), { maxLength: 4 })
      .chain((ids) => fc.tuple(...ids.map((id) => fc.nat({ max: DEFINITIONS.length - 1 }).map((d) => criterion(id, d)))))
      .map((cs) => cs as RuleValue);
    const pairArb = methodArb.chain((method) => {
      const v = method === 'ALL_APPLY' ? criteriaArb : valueArb(method);
      return fc.record({ method: fc.constant(method), a: v, b: v });
    });
    const check = async (method: ComparisonMethod, a: RuleValue, b: RuleValue, expected?: boolean): Promise<void> => {
      const oracle = oracleAtLeastAsStrict(method, ORDER, a, b);
      if (expected !== undefined) expect(oracle).toBe(expected);
      const { rows } = await db.admin.query<{ r: boolean }>('select market.at_least_as_strict($1, $2::jsonb, $3::jsonb, $4::jsonb) as r', [
        method,
        JSON.stringify(ORDER),
        JSON.stringify(a),
        JSON.stringify(b),
      ]);
      expect({ ts: isAtLeastAsStrict(method, ORDER, a, b), sql: rows[0]?.r }).toEqual({ ts: oracle, sql: oracle });
    };
    await fc.assert(
      fc.asyncProperty(pairArb, async ({ method, a, b }) => {
        await check(method, a, b);
      }),
      { numRuns: 400 },
    );
    // Same ids, one definition changed: never at least as strict, whatever else a adds.
    await fc.assert(
      fc.asyncProperty(criteriaArb.filter((b) => (b as unknown[]).length > 0), fc.nat(), fc.nat({ max: DEFINITIONS.length - 2 }), async (b, pick, shift) => {
        const list = b as Record<string, unknown>[];
        const i = pick % list.length;
        const changed = list.map((c, j) => {
          if (j !== i) return c;
          const current = DEFINITIONS.findIndex((d) => isDeepStrictEqual({ id: c['id'], ...d }, c));
          return criterion(c['id'] as string, (current + 1 + shift) % DEFINITIONS.length);
        });
        await check('ALL_APPLY', changed as RuleValue, b, false);
      }),
      { numRuns: 150 },
    );
  });

  it('[INV-28][IN-52] both engines decide "the same value" alike (isSameValue, market.same_value) and as the oracle: a set in any order, its criteria written with their members in any order, is the same set; a changed definition never is (lead TODO T9)', async () => {
    /** Independent of the engines: sets by their elements, criteria by deep equality; anything else deep-equal. */
    const oracleSame = (method: ComparisonMethod, a: RuleValue, b: RuleValue): boolean =>
      method === 'SET_UNION' || method === 'ALL_APPLY'
        ? oracleAtLeastAsStrict(method, ORDER, a, b) && oracleAtLeastAsStrict(method, ORDER, b, a)
        : isDeepStrictEqual(a, b);
    const check = async (method: ComparisonMethod, a: RuleValue, b: RuleValue, expected?: boolean): Promise<void> => {
      const oracle = oracleSame(method, a, b);
      if (expected !== undefined) expect(oracle).toBe(expected);
      const { rows } = await db.admin.query<{ r: boolean }>('select market.same_value($1, $2::jsonb, $3::jsonb, $4::jsonb) as r', [
        method,
        JSON.stringify(ORDER),
        JSON.stringify(a),
        JSON.stringify(b),
      ]);
      expect({ method, a, b, ts: isSameValue(method, ORDER, a, b), sql: rows[0]?.r }).toEqual({ method, a, b, ts: oracle, sql: oracle });
    };
    const criteriaArb = fc
      .uniqueArray(fc.constantFrom(...CRITERIA), { maxLength: 4 })
      .chain((ids) => fc.tuple(...ids.map((id) => fc.nat({ max: DEFINITIONS.length - 1 }).map((d) => criterion(id, d)))))
      .map((cs) => cs as RuleValue);
    /** The same elements, shuffled, each criterion written with its members in reverse order. */
    const rewritten = (v: RuleValue, seed: number): RuleValue => {
      const list = [...(v as unknown[])];
      for (let i = list.length - 1; i > 0; i -= 1) {
        const j = (seed + i * 7) % (i + 1);
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list.map((e) => (e !== null && typeof e === 'object' ? Object.fromEntries(Object.entries(e).reverse()) : e)) as RuleValue;
    };
    // The same set written another way: always the same value.
    const setArb = fc.oneof(
      fc.record({ method: fc.constant<ComparisonMethod>('SET_UNION'), v: valueArb('SET_UNION') }),
      fc.record({ method: fc.constant<ComparisonMethod>('ALL_APPLY'), v: criteriaArb }),
    );
    await fc.assert(
      fc.asyncProperty(setArb, fc.nat(), async ({ method, v }, seed) => {
        await check(method, v, rewritten(v, seed), true);
      }),
      { numRuns: 150 },
    );
    // Any two values of any method: the engines agree with the oracle.
    const pairArb = fc.constantFrom(...METHODS).chain((method) => {
      const v = method === 'ALL_APPLY' ? criteriaArb : valueArb(method);
      return fc.record({ method: fc.constant(method), a: v, b: v });
    });
    await fc.assert(
      fc.asyncProperty(pairArb, async ({ method, a, b }) => {
        await check(method, a, b);
      }),
      { numRuns: 300 },
    );
    // Fixed cases: a reorder is the same; an added element, a dropped one or a changed definition is not.
    await check('SET_UNION', ['S1', 'S2', 'S3'], ['S3', 'S1', 'S2'], true);
    await check('SET_UNION', ['S1', 'S2', 'S3'], ['S1', 'S2'], false);
    const criteria = (...cs: Record<string, unknown>[]): RuleValue => cs as RuleValue;
    await check('ALL_APPLY', criteria(criterion('C1', 0), criterion('C2', 2)), criteria(criterion('C2', 2), criterion('C1', 0)), true);
    await check('ALL_APPLY', criteria(criterion('C1', 0), criterion('C2', 2)), criteria(criterion('C2', 2), criterion('C1', 1)), false);
    await check('ALL_APPLY', criteria(criterion('C1', 0)), criteria(criterion('C1', 0), criterion('C2', 2)), false);
    await check('LARGER_STRICTER', '1.5', '1.5', true);
    await check('LARGER_STRICTER', '1.5', '1.50', false);
    // NOT_COMPARABLE has no order and no equality to rank by: TypeScript throws, SQL answers NULL.
    expect(() => isSameValue('NOT_COMPARABLE', null, 'A', 'A')).toThrow('EBMR-MKT-046');
    const { rows } = await db.admin.query<{ r: boolean | null }>("select market.same_value('NOT_COMPARABLE', null, '\"A\"', '\"A\"') as r");
    expect(rows[0]?.r).toBeNull();
  });

  it('[INV-28][IN-52] on random generated tables published through the SQL gate', async () => {
    await fc.assert(
      fc.asyncProperty(generatedArb, fc.array(requestArb, { minLength: 4, maxLength: 4 }), async (g, requests) => {
        const table = `pt${randomUUID().replaceAll('-', '').slice(0, 10)}`;
        await createTestTable(db, table);
        const doc = buildDocument(table, g);
        expect(validateRuleTableDocument(doc, { tables: { [table]: `${table}.` } })).toEqual([]);
        const { versionId } = await publishDocument(db, doc);
        const snapshot = await loadRuleTableVersion(db.app, versionId);
        for (const req of requests) {
          await compare(snapshot, { key: `${table}.gen`, marketSet: ['IN', ...req.extra], asOf: req.asOf, ...(req.branch ? { predicates: req.branch } : {}) });
        }
      }),
      { numRuns: 40 },
    );
  });
});
