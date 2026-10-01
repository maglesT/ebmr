/**
 * The pure resolution engine guard by guard (resolve.ts, strictness.ts and decimal.ts, the
 * TypeScript twins of market.resolve, market.select_row, market.checked_market_set,
 * market.at_least_as_strict, market.set_merge and market.category_rank in kernel 0300): each refusal
 * with its EBMR-MKT code and its exact message, the boundaries of every comparison and the hard
 * floor of set-valued keys (build outline 3.3.1, 3.3.2; ADR 0008; IN-52; INV-28). No database.
 * engine.test.ts shows the engine resolving the seed tables; these tests prove each check on its own.
 *
 * Most tables here pass the validator (snapshotFromDocument). A few are built without it, to prove
 * that the resolver itself still fails closed on a table that slipped past validation (a published
 * version is read back from the database, not from a validated file).
 */
import { describe, expect, it } from 'vitest';
import { compareDecimal, isCanonicalDecimal } from '../../src/market/decimal.ts';
import { MarketRuleError } from '../../src/market/errors.ts';
import { checkedMarketSet, isIsoDate, resolve, selectRow } from '../../src/market/resolve.ts';
import { snapshotFromDocument } from '../../src/market/snapshot.ts';
import {
  byCode,
  canonicalJson,
  categoryRank,
  floorRank,
  isAtLeastAsStrict,
  jsonEqual,
  setMerge,
  siteLoosenable,
  textOf,
} from '../../src/market/strictness.ts';
import type { Criterion, Predicates, RuleKeyDoc, RuleRowDoc, RuleTableDocument, RuleTableSnapshot, SnapshotRow, StatedMethod } from '../../src/market/types.ts';

const AS_OF = '2026-01-15';

/** The code and full message of the MarketRuleError fn throws; any other outcome fails the test. */
function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof MarketRuleError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error('expected a MarketRuleError, but the call returned');
}
const refused = (code: string, text: string) => ({ code, message: `${code} ${text}` });

function row(partial: Partial<RuleRowDoc> & Pick<RuleRowDoc, 'ref' | 'key' | 'market' | 'value' | 'unit'>): RuleRowDoc {
  return { floor: 'HARD', source: 'test', verification: 'P', effectiveFrom: '2024-01-01', ...partial };
}
function doc(keys: RuleKeyDoc[], rows: RuleRowDoc[], version = 7): RuleTableDocument {
  return { table: 'kernel', version, keys, rows };
}
/** The snapshot snapshotFromDocument would build, without running the validator. */
function unvalidated(d: RuleTableDocument): RuleTableSnapshot {
  const rows: SnapshotRow[] = d.rows.map((r) => ({
    id: r.ref,
    ref: r.ref,
    key: r.key,
    market: r.market,
    predicate: r.predicate ?? {},
    value: r.value,
    unit: r.unit,
    floor: r.floor,
    hardFloor: r.hardFloor ?? null,
    source: r.source,
    verification: r.verification,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo ?? null,
    note: r.note ?? null,
  }));
  return { versionId: `unvalidated:${d.table}.v${d.version}`, tableCode: d.table, version: d.version, keys: new Map(d.keys.map((k) => [k.key, k])), rows };
}

describe('[meta] calendar dates (isIsoDate)', () => {
  it('[IN-52] accepts only real calendar dates, with Gregorian leap years', () => {
    for (const date of ['2026-01-01', '2026-01-31', '2026-02-28', '2026-04-30', '2026-12-31', '2024-02-29', '2000-02-29']) {
      expect(isIsoDate(date), date).toBe(true);
    }
    // 2023 is not divisible by 4; 1900 and 2100 are centuries not divisible by 400.
    for (const date of ['2023-02-29', '2026-02-29', '1900-02-29', '2100-02-29', '2026-02-30', '2026-04-31', '2026-01-32', '2026-01-00', '2026-00-10', '2026-13-01']) {
      expect(isIsoDate(date), date).toBe(false);
    }
  });

  it('[IN-52] refuses any other layout, and values that are not text, without throwing', () => {
    for (const date of ['2026-1-15', '2026-01-5', '26-01-15', '2026/01/15', '20260115', ' 2026-01-15', '2026-01-15T00:00', '']) {
      expect(isIsoDate(date), date).toBe(false);
    }
    // A JSON document may hold anything; an array or object whose text reads like a date is not a date.
    for (const value of [20260115, null, undefined, true, ['2026-01-15'], { toString: () => '2026-01-15' }]) {
      expect(isIsoDate(value)).toBe(false);
    }
  });
});

describe('market sets (checkedMarketSet)', () => {
  it('[INV-28] a missing or empty market set is refused as missing', () => {
    for (const set of [null, undefined, []]) {
      expect(refusal(() => checkedMarketSet(set))).toEqual(refused('EBMR-MKT-001', 'a market set is required'));
    }
  });

  it('[INV-28] a repeated, unknown or India-less market set is refused with a message naming the problem', () => {
    expect(refusal(() => checkedMarketSet(['IN', 'US', 'IN']))).toEqual(refused('EBMR-MKT-001', 'market set {IN,US,IN} repeats a market'));
    expect(refusal(() => checkedMarketSet(['IN', 'UK']))).toEqual(refused('EBMR-MKT-001', 'unknown market UK'));
    expect(refusal(() => checkedMarketSet(['US', 'EU']))).toEqual(
      refused('EBMR-MKT-001', 'market set {US,EU} does not include IN: Indian GMP applies to every batch made under an Indian licence (INV-28)'),
    );
  });

  it('[INV-28] a valid set comes back sorted by code, checked against the markets the installation knows', () => {
    expect(checkedMarketSet(['US', 'IN', 'EU'])).toEqual(['EU', 'IN', 'US']);
    expect(checkedMarketSet(['UK', 'IN'], ['IN', 'UK'])).toEqual(['IN', 'UK']);
    expect(refusal(() => checkedMarketSet(['IN', 'US'], ['IN', 'UK']))).toEqual(refused('EBMR-MKT-001', 'unknown market US'));
  });
});

describe('predicate branches (selectRow and resolve)', () => {
  const R = 'kernel.t.retention';
  const srows = unvalidated(
    doc(
      [{ key: R, title: 't', method: 'LARGER_STRICTER', valueType: 'DECIMAL', unit: 'mo', indiaGoverns: true }],
      [
        row({ ref: 'r.base', key: R, market: 'IN', value: '24', unit: 'mo' }),
        row({ ref: 'r.labelled', key: R, market: 'IN', predicate: { expiryLabelled: true }, value: '18', unit: 'mo' }),
        row({ ref: 'r.form28', key: R, market: 'IN', predicate: { licenceForm: 'FORM_28' }, value: '12', unit: 'mo' }),
        row({ ref: 'r.both', key: R, market: 'IN', predicate: { licenceForm: 'FORM_28', expiryLabelled: true }, value: '6', unit: 'mo' }),
        row({ ref: 'r.eu', key: R, market: 'EU', value: '9', unit: 'mo' }),
      ],
    ),
  ).rows;

  it('[IN-52] the most specific matching row of the market applies', () => {
    expect(selectRow(srows, 'IN', { licenceForm: 'FORM_28', expiryLabelled: true }, AS_OF)?.ref).toBe('r.both');
    expect(selectRow(srows, 'IN', { licenceForm: 'FORM_28', expiryLabelled: false }, AS_OF)?.ref).toBe('r.form28');
    expect(selectRow(srows, 'IN', { licenceForm: 'FORM_25', expiryLabelled: false }, AS_OF)?.ref).toBe('r.base');
    expect(selectRow(srows, 'US', {}, AS_OF)).toBeUndefined();
  });

  it('[IN-52] two equally specific rows that both apply are refused as an ambiguous branch, never chosen by name', () => {
    const ambiguous = srows.filter((r) => r.ref !== 'r.both');
    expect(refusal(() => selectRow(ambiguous, 'IN', { licenceForm: 'FORM_28', expiryLabelled: true }, AS_OF))).toEqual(
      refused('EBMR-MKT-044', `rows r.form28 and r.labelled both apply to key ${R} for market IN: ambiguous predicate branch`),
    );
    // One row matching at that level is not ambiguous.
    expect(selectRow(ambiguous, 'IN', { licenceForm: 'FORM_25', expiryLabelled: true }, AS_OF)?.ref).toBe('r.labelled');
  });

  const B = 'kernel.t.branch';
  const P = 'kernel.t.plain';
  const branchTable = snapshotFromDocument(
    doc(
      [
        { key: B, title: 'b', method: 'SMALLER_STRICTER', valueType: 'DECIMAL', unit: 'mo', indiaGoverns: true, predicates: { zone: ['DRY', 'HUMID'], licenceForm: ['FORM_25', 'FORM_28'] } },
        { key: P, title: 'p', method: 'SMALLER_STRICTER', valueType: 'DECIMAL', unit: 'mo', indiaGoverns: true },
      ],
      [
        row({ ref: 'b.in', key: B, market: 'IN', value: '24', unit: 'mo' }),
        row({ ref: 'b.in.humid', key: B, market: 'IN', predicate: { zone: 'HUMID' }, value: '12', unit: 'mo' }),
        row({ ref: 'b.eu.form28', key: B, market: 'EU', predicate: { licenceForm: 'FORM_28' }, value: '18', unit: 'mo' }),
        row({ ref: 'b.eu', key: B, market: 'EU', value: '36', unit: 'mo' }),
        row({ ref: 'p.in', key: P, market: 'IN', value: '6', unit: 'mo' }),
      ],
    ),
  );

  it('[IN-52] missing predicates are reported in attribute order, whatever order the rows use them in', () => {
    // The rows use zone before licenceForm; the refusal names licenceForm first, as market.resolve does.
    expect(refusal(() => resolve(branchTable, { key: B, marketSet: ['IN', 'EU'], asOf: AS_OF }))).toEqual(
      refused('EBMR-MKT-042', `key ${B} needs predicate licenceForm to choose its branch`),
    );
    expect(refusal(() => resolve(branchTable, { key: B, marketSet: ['IN', 'EU'], asOf: AS_OF, predicates: { licenceForm: 'FORM_25' } }))).toEqual(
      refused('EBMR-MKT-042', `key ${B} needs predicate zone to choose its branch`),
    );
    // Only the rows of the markets in the set count: an India-only batch needs no licence form here.
    const inOnly = resolve(branchTable, { key: B, marketSet: ['IN'], asOf: AS_OF, predicates: { zone: 'DRY' } });
    expect(inOnly.value).toBe('24');
    expect(inOnly.predicateBranch).toEqual({ IN: {} });
  });

  it('[IN-52] a predicate value outside the key\'s declared values is refused and the message shows it as JSON', () => {
    const at = (predicates: Predicates) => () => resolve(branchTable, { key: B, marketSet: ['IN', 'EU'], asOf: AS_OF, predicates });
    expect(refusal(at({ zone: 'TROPICAL', licenceForm: 'FORM_25' }))).toEqual(refused('EBMR-MKT-043', `predicate zone = "TROPICAL" is outside the values declared for key ${B}`));
    expect(refusal(at({ zone: true, licenceForm: 'FORM_25' }))).toEqual(refused('EBMR-MKT-043', `predicate zone = true is outside the values declared for key ${B}`));
    const r = resolve(branchTable, { key: B, marketSet: ['IN', 'EU'], asOf: AS_OF, predicates: { zone: 'HUMID', licenceForm: 'FORM_28' } });
    expect(r.value).toBe('12');
    expect(r.governingMarkets).toEqual(['IN']);
    expect(r.predicateBranch).toEqual({ EU: { licenceForm: 'FORM_28' }, IN: { zone: 'HUMID' } });
  });

  it('[IN-52] a row predicate on an attribute the key declares no values for is refused, not resolved (fail closed)', () => {
    const N = 'kernel.t.undeclared';
    const t = unvalidated(
      doc(
        [{ key: N, title: 'n', method: 'SMALLER_STRICTER', valueType: 'DECIMAL', unit: 'mo', indiaGoverns: true }],
        [row({ ref: 'n.in', key: N, market: 'IN', predicate: { zone: 'DRY' }, value: '6', unit: 'mo' })],
      ),
    );
    expect(refusal(() => resolve(t, { key: N, marketSet: ['IN'], asOf: AS_OF, predicates: { zone: 'DRY' } }))).toEqual(
      refused('EBMR-MKT-043', `predicate zone = "DRY" is outside the values declared for key ${N}`),
    );
  });

  it('[IN-52] predicates must be an object of attribute values; absent or null means none', () => {
    for (const predicates of [[], 'FORM_25', true]) {
      expect(refusal(() => resolve(branchTable, { key: P, marketSet: ['IN'], asOf: AS_OF, predicates: predicates as unknown as Predicates }))).toEqual(
        refused('EBMR-MKT-003', 'predicates must be an object of attribute values'),
      );
    }
    const r = resolve(branchTable, { key: P, marketSet: ['IN'], asOf: AS_OF, predicates: null as unknown as Predicates });
    expect(r.value).toBe('6');
    expect(r.inputs.predicates).toEqual({});
  });

  it('[IN-52] an as-of date that is not a real YYYY-MM-DD date and a key the table lacks are refused', () => {
    for (const asOf of ['2026-02-30', '15/01/2026', '']) {
      expect(refusal(() => resolve(branchTable, { key: P, marketSet: ['IN'], asOf }))).toEqual(refused('EBMR-MKT-002', 'a resolution needs an as-of date written YYYY-MM-DD'));
    }
    expect(refusal(() => resolve(branchTable, { key: 'kernel.t.missing', marketSet: ['IN'], asOf: AS_OF }))).toEqual(
      refused('EBMR-MKT-041', 'key kernel.t.missing is not in rule table kernel version 7'),
    );
  });

  it('[IN-52][INV-28] no India row on the date for a key India governs: refused, naming the predicates and date', () => {
    expect(refusal(() => resolve(branchTable, { key: B, marketSet: ['IN', 'EU'], asOf: '2023-06-01', predicates: { zone: 'DRY', licenceForm: 'FORM_25' } }))).toEqual(
      refused('EBMR-MKT-045', `key ${B} has no India value for predicates {"zone":"DRY","licenceForm":"FORM_25"} on 2023-06-01; India always applies, so the resolution is refused`),
    );
  });
});

describe('NOT_COMPARABLE keys: resolved only by the stated method', () => {
  const L = 'kernel.t.label';
  const labelTable = snapshotFromDocument(
    doc(
      [{ key: L, title: 'l', method: 'NOT_COMPARABLE', statedMethod: 'PER_DESTINATION', valueType: 'ANY', unit: '{text}', indiaGoverns: true }],
      [
        row({ ref: 'l.in', key: L, market: 'IN', value: 'MANDATORY_UNCODED', unit: '{text}' }),
        row({ ref: 'l.us', key: L, market: 'US', value: 'NOT_REQUIRED', unit: '{text}' }),
      ],
    ),
  );
  const ALL = ['US', 'IN', 'EU'];
  const at = (stated: unknown, marketSet = ALL) => () => resolve(labelTable, { key: L, marketSet, asOf: AS_OF, stated: stated as StatedMethod });

  it('[IN-52] without a stated method object the key cannot be ranked and is refused', () => {
    const cannot = refused('EBMR-MKT-046', `key ${L} cannot be ranked across markets; resolving it needs a stated method (PER_DESTINATION) with a regulatory decision reference`);
    expect(refusal(at(undefined))).toEqual(cannot);
    expect(refusal(at(null))).toEqual(cannot);
    expect(refusal(at('PER_DESTINATION'))).toEqual(cannot);
  });

  it('[IN-52] a stated method other than the key\'s is refused', () => {
    expect(refusal(at({ method: 'STRICTEST_WINS', destination: 'US', decisionRef: 'RA-1' }))).toEqual(refused('EBMR-MKT-046', `key ${L} must be resolved by stated method PER_DESTINATION`));
  });

  it('[IN-52] the destination must be given and be in the market set', () => {
    expect(refusal(at({ method: 'PER_DESTINATION', decisionRef: 'RA-1' }))).toEqual(refused('EBMR-MKT-047', 'destination (missing) is not in the market set {EU,IN,US}'));
    expect(refusal(at({ method: 'PER_DESTINATION', destination: 'US', decisionRef: 'RA-1' }, ['IN', 'EU']))).toEqual(
      refused('EBMR-MKT-047', 'destination US is not in the market set {EU,IN}'),
    );
  });

  it('[IN-52] a missing, empty or blank regulatory decision reference is refused', () => {
    for (const decisionRef of [undefined, '', '   ']) {
      expect(refusal(at({ method: 'PER_DESTINATION', destination: 'US', decisionRef }))).toEqual(
        refused('EBMR-MKT-047', `key ${L} needs a regulatory decision reference for destination US`),
      );
    }
  });

  it('[IN-52] a destination in the set without a row for the key is refused, not defaulted', () => {
    expect(refusal(at({ method: 'PER_DESTINATION', destination: 'EU', decisionRef: 'RA-1' }))).toEqual(refused('EBMR-MKT-047', `key ${L} has no row for destination EU`));
  });

  it('[IN-52] the destination\'s value governs alone and the stated method is recorded; no hard floor is merged', () => {
    const stated = { method: 'PER_DESTINATION' as const, destination: 'US', decisionRef: 'RA-2026-014' };
    const r = resolve(labelTable, { key: L, marketSet: ALL, asOf: AS_OF, stated });
    expect(r.applicable).toBe(true);
    expect(r.value).toBe('NOT_REQUIRED');
    expect(r.governingMarkets).toEqual(['US']);
    expect(r.floorType).toBe('HARD');
    expect(r.hardFloor).toBeNull();
    expect(r.components).toBeNull();
    expect(r.stated).toEqual(stated);
    expect(r.contributions.map((c) => c.market)).toEqual(['IN', 'US']);
    expect(r.inputs).toEqual({ key: L, tableVersionId: 'file:kernel.v7', marketSet: ['EU', 'IN', 'US'], predicates: {}, asOf: AS_OF, stated });
  });

  it('[IN-52] a NOT_COMPARABLE key that declares no stated method can never be resolved (fail closed)', () => {
    const U = 'kernel.t.unstated';
    const t = unvalidated(
      doc(
        [{ key: U, title: 'u', method: 'NOT_COMPARABLE', valueType: 'ANY', unit: '{text}', indiaGoverns: true }],
        [row({ ref: 'u.in', key: U, market: 'IN', value: 'MANDATORY_UNCODED', unit: '{text}' })],
      ),
    );
    expect(refusal(() => resolve(t, { key: U, marketSet: ['IN'], asOf: AS_OF }))).toEqual(
      refused('EBMR-MKT-046', `key ${U} cannot be ranked across markets; resolving it needs a stated method (PER_DESTINATION) with a regulatory decision reference`),
    );
    expect(refusal(() => resolve(t, { key: U, marketSet: ['IN'], asOf: AS_OF, stated: { method: 'PER_DESTINATION', destination: 'IN', decisionRef: 'RA-1' } }))).toEqual(
      refused('EBMR-MKT-046', `key ${U} must be resolved by stated method ?`),
    );
  });
});

describe('hard floors of set-valued keys', () => {
  it('[IN-52] SET_UNION: the hard floor is the union of every binding set; guidance-only elements stay out of it', () => {
    const S = 'kernel.t.authorities';
    const t = snapshotFromDocument(
      doc(
        [{ key: S, title: 's', method: 'SET_UNION', valueType: 'SET', unit: '{code}', indiaGoverns: true }],
        [
          row({ ref: 's.in', key: S, market: 'IN', value: ['HEAD_OF_QC', 'AUTHORISED_PERSON'], unit: '{code}' }),
          row({ ref: 's.us', key: S, market: 'US', value: ['QUALITY_UNIT'], unit: '{code}' }),
          row({ ref: 's.eu', key: S, market: 'EU', value: ['AUTHORISED_PERSON', 'QP_CERTIFICATION'], unit: '{code}', floor: 'GUIDANCE', hardFloor: ['AUTHORISED_PERSON'] }),
        ],
      ),
    );
    const r = resolve(t, { key: S, marketSet: ['IN', 'US', 'EU'], asOf: AS_OF });
    expect(r.value).toEqual(['AUTHORISED_PERSON', 'HEAD_OF_QC', 'QP_CERTIFICATION', 'QUALITY_UNIT']);
    expect(r.components).toEqual([
      { value: 'AUTHORISED_PERSON', markets: ['EU', 'IN'], floorType: 'HARD' },
      { value: 'HEAD_OF_QC', markets: ['IN'], floorType: 'HARD' },
      { value: 'QP_CERTIFICATION', markets: ['EU'], floorType: 'GUIDANCE' },
      { value: 'QUALITY_UNIT', markets: ['US'], floorType: 'HARD' },
    ]);
    expect(r.hardFloor).toEqual(['AUTHORISED_PERSON', 'HEAD_OF_QC', 'QUALITY_UNIT']);
    expect(r.floorType).toBe('HARD');
    expect(r.governingMarkets).toEqual(['EU', 'IN', 'US']);
  });

  it('[IN-52] ALL_APPLY: the hard floor keeps every binding criterion of every market, by id', () => {
    const C = 'kernel.t.criteria';
    const ip = { id: 'IP_WEIGHT_BANDS', limitPercent: '7.5' };
    const usp = { id: 'USP_CONTENT', plan: 'L1' };
    const design = { id: 'EU_EXTRA_CHECK', plan: 'X' };
    const t = snapshotFromDocument(
      doc(
        [{ key: C, title: 'c', method: 'ALL_APPLY', valueType: 'CRITERIA', unit: '{criterion}', indiaGoverns: true }],
        [
          row({ ref: 'c.in', key: C, market: 'IN', value: [ip], unit: '{criterion}' }),
          row({ ref: 'c.us', key: C, market: 'US', value: [usp], unit: '{criterion}' }),
          row({ ref: 'c.eu', key: C, market: 'EU', value: [design], unit: '{criterion}', floor: 'DESIGN' }),
        ],
      ),
    );
    const r = resolve(t, { key: C, marketSet: ['IN', 'US', 'EU'], asOf: AS_OF });
    expect(r.value).toEqual([design, ip, usp]);
    expect(r.hardFloor).toEqual([ip, usp]);
    expect(r.components?.map((c) => [(c.value as Criterion).id, c.markets, c.floorType])).toEqual([
      ['EU_EXTRA_CHECK', ['EU'], 'DESIGN'],
      ['IP_WEIGHT_BANDS', ['IN'], 'HARD'],
      ['USP_CONTENT', ['US'], 'HARD'],
    ]);
  });

  it('[INV-28] second line: a result that would be looser than India is refused even if the table slipped past validation', () => {
    const C = 'kernel.t.criteria';
    const d = doc(
      [{ key: C, title: 'c', method: 'ALL_APPLY', valueType: 'CRITERIA', unit: '{criterion}', indiaGoverns: true }],
      [
        row({ ref: 'c.in', key: C, market: 'IN', value: [{ id: 'UNIFORMITY', plan: 'L1' }], unit: '{criterion}' }),
        row({ ref: 'c.eu', key: C, market: 'EU', value: [{ id: 'UNIFORMITY', plan: 'L2' }], unit: '{criterion}' }),
      ],
    );
    // The validator refuses one criterion defined two ways ...
    expect(refusal(() => snapshotFromDocument(d)).code).toBe('EBMR-MKT-028');
    // ... and the resolver, which would keep the EU definition, refuses rather than drop India's.
    expect(refusal(() => resolve(unvalidated(d), { key: C, marketSet: ['IN', 'EU'], asOf: AS_OF }))).toEqual(
      refused('EBMR-MKT-049', `internal error: key ${C} resolved looser than India (INV-28)`),
    );
    expect(resolve(unvalidated(d), { key: C, marketSet: ['IN'], asOf: AS_OF }).value).toEqual([{ id: 'UNIFORMITY', plan: 'L1' }]);
  });
});

describe('[meta] strictness helpers', () => {
  it('[meta] byCode orders by UTF-16 code unit like COLLATE "C" (upper case before lower case)', () => {
    expect(byCode('EU', 'IN')).toBe(-1);
    expect(byCode('IN', 'EU')).toBe(1);
    expect(byCode('IN', 'IN')).toBe(0);
    expect(byCode('Z', 'a')).toBe(-1);
    expect(byCode('a', 'Z')).toBe(1);
    expect(['b', 'a', 'B', 'A'].sort(byCode)).toEqual(['A', 'B', 'a', 'b']);
  });

  it('[meta] canonicalJson sorts object keys, keeps array order, drops undefined members and writes null', () => {
    expect(canonicalJson(['b', 'a'])).toBe('["b","a"]');
    expect(canonicalJson({ b: '1', a: '2' })).toBe('{"a":"2","b":"1"}');
    expect(canonicalJson({ z: [{ y: true, x: null }], a: 'v' })).toBe('{"a":"v","z":[{"x":null,"y":true}]}');
    expect(canonicalJson({ a: '1', b: undefined })).toBe('{"a":"1"}');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('7.5')).toBe('"7.5"');
    expect(jsonEqual({ a: '1', b: ['x', 'y'] }, { b: ['x', 'y'], a: '1' })).toBe(true);
    expect(jsonEqual(['x', 'y'], ['y', 'x'])).toBe(false);
  });

  it('[meta] floorRank ranks HARD > GUIDANCE > EXAMPLE > DESIGN > anything else (market.floor_rank)', () => {
    expect(['HARD', 'GUIDANCE', 'EXAMPLE', 'DESIGN', 'OTHER', null, undefined].map(floorRank)).toEqual([4, 3, 2, 1, 0, 0, 0]);
  });

  it('[IN-52] only GUIDANCE and adopted EXAMPLE values may be loosened by a site (market.site_loosenable)', () => {
    expect(siteLoosenable('GUIDANCE')).toBe(true);
    expect(siteLoosenable('EXAMPLE')).toBe(true);
    expect(siteLoosenable('HARD')).toBe(false);
    expect(siteLoosenable('DESIGN')).toBe(false);
  });

  it('[meta] categoryRank is the 1-based position in the ordered list (market.category_rank), undefined otherwise', () => {
    const ordered = ['PERIODIC', 'BEFORE_BATCH_RELEASE', 'CONTINUOUS'];
    expect(categoryRank(ordered, 'PERIODIC')).toBe(1);
    expect(categoryRank(ordered, 'CONTINUOUS')).toBe(3);
    expect(categoryRank(ordered, 'NEVER')).toBeUndefined();
    expect(categoryRank(ordered, true)).toBeUndefined();
    expect(categoryRank(null, 'PERIODIC')).toBeUndefined();
    expect(categoryRank(undefined, 'PERIODIC')).toBeUndefined();
  });

  it('[meta] textOf is the text of a scalar and canonical JSON of anything else', () => {
    expect(textOf('7.5')).toBe('7.5');
    expect(textOf(true)).toBe('true');
    expect(textOf(null)).toBe('null');
    expect(textOf(['a'])).toBe('["a"]');
    expect(textOf({ b: 'x', a: 'y' })).toBe('{"a":"y","b":"x"}');
  });
});

describe('at least as strict: refusals and boundaries (isAtLeastAsStrict)', () => {
  it('[IN-52] decimal methods refuse a value that is not a decimal string', () => {
    for (const method of ['SMALLER_STRICTER', 'LARGER_STRICTER'] as const) {
      expect(refusal(() => isAtLeastAsStrict(method, null, true, '1'))).toEqual(refused('EBMR-MKT-020', 'true is not a decimal string'));
      expect(refusal(() => isAtLeastAsStrict(method, null, '1', ['1']))).toEqual(refused('EBMR-MKT-020', '["1"] is not a decimal string'));
      expect(refusal(() => isAtLeastAsStrict(method, null, '1', null))).toEqual(refused('EBMR-MKT-020', 'null is not a decimal string'));
    }
    expect(isAtLeastAsStrict('SMALLER_STRICTER', null, '7.5', '7.5')).toBe(true);
    expect(isAtLeastAsStrict('LARGER_STRICTER', null, '7.5', '7.5')).toBe(true);
  });

  it('[IN-52] ORDERED refuses a value outside the ordered list and names that value', () => {
    const ordered = ['PERIODIC', 'BEFORE_BATCH_RELEASE'];
    expect(refusal(() => isAtLeastAsStrict('ORDERED', ordered, 'NEVER', 'PERIODIC'))).toEqual(refused('EBMR-MKT-020', 'value "NEVER" is not in the ordered list'));
    expect(refusal(() => isAtLeastAsStrict('ORDERED', ordered, 'PERIODIC', 'NEVER'))).toEqual(refused('EBMR-MKT-020', 'value "NEVER" is not in the ordered list'));
    expect(refusal(() => isAtLeastAsStrict('ORDERED', null, 'PERIODIC', 'PERIODIC'))).toEqual(refused('EBMR-MKT-020', 'value "PERIODIC" is not in the ordered list'));
    expect(isAtLeastAsStrict('ORDERED', ordered, 'BEFORE_BATCH_RELEASE', 'PERIODIC')).toBe(true);
    expect(isAtLeastAsStrict('ORDERED', ordered, 'PERIODIC', 'PERIODIC')).toBe(true);
    expect(isAtLeastAsStrict('ORDERED', ordered, 'PERIODIC', 'BEFORE_BATCH_RELEASE')).toBe(false);
  });

  it('[IN-52] set methods refuse a value that is not an array, each with its own message', () => {
    expect(refusal(() => isAtLeastAsStrict('SET_UNION', null, 'A', ['A']))).toEqual(refused('EBMR-MKT-020', 'a set value must be an array'));
    expect(refusal(() => isAtLeastAsStrict('SET_UNION', null, ['A'], 'A'))).toEqual(refused('EBMR-MKT-020', 'a set value must be an array'));
    expect(refusal(() => isAtLeastAsStrict('ALL_APPLY', null, { id: 'X' }, []))).toEqual(refused('EBMR-MKT-020', 'a criteria value must be an array'));
    expect(refusal(() => isAtLeastAsStrict('ALL_APPLY', null, [], { id: 'X' }))).toEqual(refused('EBMR-MKT-020', 'a criteria value must be an array'));
    expect(isAtLeastAsStrict('SET_UNION', null, ['B', 'A'], ['A'])).toBe(true);
    expect(isAtLeastAsStrict('SET_UNION', null, ['A'], ['A', 'B'])).toBe(false);
  });

  it('[IN-52] NOT_COMPARABLE values are never ranked', () => {
    expect(refusal(() => isAtLeastAsStrict('NOT_COMPARABLE', null, 'NOT_REQUIRED', 'NOT_REQUIRED'))).toEqual(refused('EBMR-MKT-046', 'NOT_COMPARABLE values cannot be ranked'));
  });
});

describe('[meta] merging set values (setMerge)', () => {
  it('[meta] a missing side leaves the other side as it is (market.set_merge)', () => {
    expect(setMerge('SET_UNION', null, ['A'])).toEqual(['A']);
    expect(setMerge('SET_UNION', ['B', 'A'], null)).toEqual(['B', 'A']);
    expect(setMerge('ALL_APPLY', [{ id: 'X' }], null)).toEqual([{ id: 'X' }]);
    expect(setMerge('ALL_APPLY', null, null)).toBeNull();
  });

  it('[meta] SET_UNION merges into one sorted list without repeats', () => {
    expect(setMerge('SET_UNION', ['C', 'A'], ['B', 'A'])).toEqual(['A', 'B', 'C']);
  });

  it('[meta] ALL_APPLY keeps one criterion per id, sorted by id, whichever side comes first', () => {
    const a = [{ id: 'USP_905', plan: 'L2' }, { id: 'IP_BANDS', band: '7.5' }];
    const b = [{ id: 'USP_905', plan: 'L1' }, { id: 'EU_2_9_40', plan: 'L1' }];
    const ab = setMerge('ALL_APPLY', a, b) as Criterion[];
    expect(ab.map((c) => c.id)).toEqual(['EU_2_9_40', 'IP_BANDS', 'USP_905']);
    expect(setMerge('ALL_APPLY', b, a)).toEqual(ab);
    expect(setMerge('ALL_APPLY', [{ id: 'X', plan: 'L1' }], [{ id: 'X', plan: 'L1' }])).toEqual([{ id: 'X', plan: 'L1' }]);
  });
});

describe('[meta] canonical decimals', () => {
  it('[IN-52] only a canonical decimal string is a decimal; a JavaScript number never is', () => {
    for (const v of ['0', '7', '7.5', '-7.5', '0.22', '3520000']) expect(isCanonicalDecimal(v), v).toBe(true);
    for (const v of [7, 7.5, 0, ['7'], null, '-0', '7.50', '07', '.5', '5.', '+5', '1e3', '']) expect(isCanonicalDecimal(v), String(v)).toBe(false);
  });

  it('[IN-52] comparing a value that is not canonical is refused, naming the value', () => {
    expect(refusal(() => compareDecimal('7.50', '1'))).toEqual(refused('EBMR-MKT-020', '"7.50" is not a canonical decimal string'));
    expect(refusal(() => compareDecimal('1', '1e3'))).toEqual(refused('EBMR-MKT-020', '"1e3" is not a canonical decimal string'));
  });

  it('[IN-52] negative decimals compare exactly', () => {
    expect(compareDecimal('-12.5', '-12.25')).toBe(-1);
    expect(compareDecimal('-0.5', '-0.25')).toBe(-1);
    expect(compareDecimal('-3', '-3')).toBe(0);
    expect(compareDecimal('-1', '-10')).toBe(1);
  });
});
