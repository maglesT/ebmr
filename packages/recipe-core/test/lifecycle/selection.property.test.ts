/**
 * Selection at issue (INV-01; ADR 0014 item 6), property-based:
 *  1. the pure model obeys the rule's laws on random facts (soundness, rule priority, maximality,
 *     completeness, India, bridging only across a gap);
 *  2. model-based against the database: random sequences of signed market authorisations, bridgings
 *     and withdrawals on a real family; after each command the database function
 *     recipe.select_version_for_issue and the model give the same answer for every market set, scope
 *     and instant tried.
 */
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { cell, reason, scope, seedCast, uniqueContent, World } from './support.ts';

const T = (n: number): string => `2026-0${n}-01T00:00:00.000000Z`; // instants 1..9, ordered as text
const MARKETS = ['IN', 'US', 'EU'] as const;

// ---------------------------------------------------------------------------------------------
// 1. Laws of the pure model
// ---------------------------------------------------------------------------------------------

const versionsArb = fc.integer({ min: 1, max: 4 }).chain((n) =>
  fc.tuple(
    ...Array.from({ length: n }, (_, i) =>
      fc.record({
        effective: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),
        approved: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),
        until: fc.option(fc.integer({ min: 6, max: 9 }), { nil: null }),
        markets: fc.subarray(['US', 'EU']),
      }).map((r): lc.VersionFacts => ({
        id: `v${i + 1}`,
        number: i + 1,
        effectiveFrom: r.effective === null ? null : T(r.effective),
        approvedFrom: r.approved === null ? null : T(r.approved),
        approvedUntil: r.approved === null || r.until === null ? null : T(r.until),
        markets: ['IN', ...r.markets],
      })),
    ),
  ),
);

const cellsArb = (versions: readonly lc.VersionFacts[]) =>
  fc.array(
    fc.record({
      v: fc.integer({ min: 0, max: versions.length - 1 }),
      s: fc.integer({ min: 0, max: versions.length - 1 }),
      market: fc.constantFrom(...MARKETS),
      line: fc.constantFrom('L1', 'L2'),
      kind: fc.constantFrom('CURRENT', 'CURRENT', 'BRIDGING'),
      from: fc.integer({ min: 1, max: 7 }),
      span: fc.option(fc.integer({ min: 1, max: 4 }), { nil: null }),
    }),
    { maxLength: 10 },
  ).map((xs) =>
    xs.map(
      (x, i): lc.CellFacts => ({
        id: `c${i}`,
        authorisationId: `a${i}`,
        versionId: versions[x.v]?.id ?? 'v1',
        market: x.market,
        site: 'S1',
        line: x.line,
        batchSize: 'BS',
        kind: x.kind,
        effectiveFrom: T(x.from),
        validUntil: x.kind === 'BRIDGING' ? T(Math.min(9, x.from + (x.span ?? 2))) : x.span === null ? null : T(Math.min(9, x.from + x.span)),
        successorVersionId: x.kind === 'BRIDGING' ? (versions[x.s]?.id ?? null) : null,
      }),
    ),
  );

const scenarioArb = versionsArb.chain((versions) =>
  fc.record({
    versions: fc.constant(versions),
    cells: cellsArb(versions),
    markets: fc.subarray([...MARKETS], { minLength: 1 }),
    at: fc.integer({ min: 1, max: 9 }).map(T),
    line: fc.constantFrom('L1', 'L2'),
  }),
);

describe('the selection rule (pure model)', () => {
  it('[INV-01][INV-17] soundness, rule priority, maximality and completeness hold on random facts', () => {
    fc.assert(
      fc.property(scenarioArb, (sc) => {
        const input: lc.SelectionInput = { family: 'F', batchSizes: ['BS'], versions: sc.versions, cells: sc.cells, markets: sc.markets, scope: scope('S1', sc.line, 'BS'), at: sc.at };
        const r = lc.selectVersion(input);
        const markets = [...new Set(sc.markets)].sort();
        if (!markets.includes('IN')) {
          expect(r.ok).toBe(false);
          return;
        }
        const valid = lc.validCells(input, markets);
        const coversWith = (versionId: string, kinds: readonly string[]) => markets.every((m) => valid.some((x) => x.version.id === versionId && x.cell.market === m && kinds.includes(x.validity)));
        const currentForAll = sc.versions.filter((v) => coversWith(v.id, ['CURRENT']));
        const anyForAll = sc.versions.filter((v) => coversWith(v.id, ['CURRENT', 'BRIDGING']));
        if (!r.ok) {
          // Completeness: refused only when no version is valid for every market.
          expect(anyForAll).toEqual([]);
          return;
        }
        // Soundness: the chosen version is valid for every market, approved and effective at `at`.
        const chosen = sc.versions.find((v) => v.id === r.versionId);
        expect(chosen?.approvedFrom !== null && (chosen?.approvedFrom ?? '') <= sc.at).toBe(true);
        expect(chosen?.effectiveFrom !== null && (chosen?.effectiveFrom ?? '') <= sc.at).toBe(true);
        expect(r.basis.map((b) => b.market)).toEqual(markets);
        for (const b of r.basis) {
          const c = sc.cells.find((x) => x.id === b.cell_id);
          expect(c?.versionId).toBe(r.versionId);
          expect(c && c.effectiveFrom <= sc.at && (c.validUntil === null || sc.at < c.validUntil)).toBe(true);
          // A bridging is used only across a gap: some market of the set lacks a CURRENT successor.
          if (b.validity === 'BRIDGING') expect(markets.some((m) => !valid.some((x) => x.validity === 'CURRENT' && x.version.id === c?.successorVersionId && x.cell.market === m))).toBe(true);
        }
        // Priority and maximality.
        if (r.rule === 'CURRENT_FOR_EVERY_MARKET') {
          expect(Math.max(...currentForAll.map((v) => v.number))).toBe(r.versionNumber);
        } else {
          expect(currentForAll).toEqual([]);
          expect(Math.max(...anyForAll.map((v) => v.number))).toBe(r.versionNumber);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('[INV-01][INV-28] India is required, and adding a market never makes an otherwise refused set acceptable', () => {
    fc.assert(
      fc.property(scenarioArb, (sc) => {
        const base = { family: 'F', batchSizes: ['BS'], versions: sc.versions, cells: sc.cells, scope: scope('S1', sc.line, 'BS'), at: sc.at };
        expect(lc.selectVersion({ ...base, markets: sc.markets.filter((m) => m !== 'IN').length ? sc.markets.filter((m) => m !== 'IN') : ['US'] }).ok).toBe(false);
        const withIn = [...new Set(['IN', ...sc.markets])];
        const r = lc.selectVersion({ ...base, markets: withIn });
        // Only markets where CURRENT versions exist can extend a set: if {IN} alone is refused, every superset is refused too.
        if (!lc.selectVersion({ ...base, markets: ['IN'] }).ok) expect(r.ok).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The database function equals the model
// ---------------------------------------------------------------------------------------------

let db: TestDatabase;
let w: World;

describe('recipe.select_version_for_issue equals the model (model-based, real signatures)', () => {
  beforeAll(async () => {
    db = await createTestDatabase();
    w = new World(db, await seedCast(db));
  }, 300_000);

  afterAll(async () => {
    await db?.drop();
  });

  type Op =
    | { op: 'current'; v: number; market: string; line: string }
    | { op: 'bridging'; v: number; successor: number; market: string; line: string; days: number }
    | { op: 'withdraw'; pick: number };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    { weight: 5, arbitrary: fc.record({ op: fc.constant('current' as const), v: fc.integer({ min: 0, max: 2 }), market: fc.constantFrom(...MARKETS), line: fc.constantFrom('L1', 'L2') }) },
    {
      weight: 2,
      arbitrary: fc.record({
        op: fc.constant('bridging' as const),
        v: fc.constantFrom(0, 0, 0, 1),
        successor: fc.constantFrom(1, 1, 2),
        market: fc.constantFrom('IN', 'IN', 'US', 'EU'),
        line: fc.constantFrom('L1', 'L1', 'L2'),
        days: fc.integer({ min: 30, max: 400 }),
      }),
    },
    { weight: 1, arbitrary: fc.record({ op: fc.constant('withdraw' as const), pick: fc.nat() }) },
  );

  it(
    '[INV-01][INV-17] after every command the database selection equals the model for every market set, scope and instant',
    async () => {
      const SETS = [['IN'], ['IN', 'US'], ['IN', 'EU'], ['IN', 'US', 'EU'], ['US']];
      let compared = 0;
      const seen = new Set<string>();
      // A fixed start makes supersession and bridging reachable: v1 CURRENT for IN and US at L1, v2 CURRENT for IN at L1,
      // and v1 BRIDGING for IN at L1 while the US approval of v2 is pending; the random commands follow.
      const prefix: Op[] = [
        { op: 'current', v: 0, market: 'IN', line: 'L1' },
        { op: 'current', v: 0, market: 'US', line: 'L1' },
        { op: 'current', v: 1, market: 'IN', line: 'L1' },
        { op: 'bridging', v: 0, successor: 1, market: 'IN', line: 'L1', days: 120 },
      ];
      await fc.assert(
        fc.asyncProperty(fc.array(opArb, { minLength: 3, maxLength: 7 }), async (ops) => {
          const content = uniqueContent('tablet-blister-packaging', ['IN', 'US', 'EU']);
          const v1 = await w.approvedVersion(content);
          const v2 = await w.approvedSuccessor(v1.versionId, (m) => (m.header.title = `${m.header.title} v2`));
          const v3 = await w.approvedSuccessor(v2.versionId, (m) => (m.header.title = `${m.header.title} v3`));
          const versions = [v1.versionId, v2.versionId, v3.versionId];
          const active: string[] = [];
          for (const o of [...prefix, ...ops]) {
            try {
              if (o.op === 'current') {
                const r = await w.authorise({ versionId: versions[o.v] ?? '', market: o.market, kind: 'CURRENT', cells: [cell('S1', o.line, 'PO-20K')], regulatoryBasis: 'model' });
                active.push(r.authorisationId);
              } else if (o.op === 'bridging') {
                const to = (await db.app.query<{ t: string }>("select recipe.utc_text(clock_timestamp() + make_interval(days => $1)) as t", [o.days])).rows[0]?.t ?? '';
                const r = await w.authorise({
                  versionId: versions[o.v] ?? '',
                  market: o.market,
                  kind: 'BRIDGING',
                  cells: [cell('S1', o.line, 'PO-20K')],
                  successorVersionId: versions[o.successor] ?? '',
                  effectiveTo: to,
                  regulatoryBasis: 'model',
                });
                active.push(r.authorisationId);
              } else if (active.length > 0) {
                const id = active.splice(o.pick % active.length, 1)[0] ?? '';
                // The withdrawal carries the QA person's own reason, both halves (migration 0290).
                await w.run(w.cast.qa, (c) => lc.withdrawMarketAuthorisation(c, id, 'model withdrawal'), reason('model withdrawal'));
              }
            } catch (e) {
              // Refusals are part of the model (older over newer, bridging without supersession, duplicates).
              expect(String(e)).toMatch(/EBMR-RCP-0(8[2-9]|9[0-3])/);
            }
            const facts = await lc.loadSelectionFacts(db.app, v1.familyId);
            const now = (await db.app.query<{ t: string; later: string }>("select recipe.utc_text(clock_timestamp()) as t, recipe.utc_text(clock_timestamp() + interval '200 days') as later")).rows[0];
            for (const at of [now?.t ?? '', now?.later ?? '']) {
              for (const line of ['L1', 'L2']) {
                for (const markets of SETS) {
                  const sql = await lc.selectVersionForIssue(db.app, { familyId: v1.familyId, markets, scope: scope('S1', line, 'PO-20K'), at });
                  const model = lc.selectVersion({ ...facts, markets, scope: scope('S1', line, 'PO-20K'), at });
                  const simple = (r: { ok: boolean; rule?: string; version_id?: string; versionId?: string; basis?: lc.SelectionBasis[] }) =>
                    r.ok ? { ok: true, rule: r.rule, version: r.version_id ?? r.versionId, basis: (r.basis ?? []).map((b) => `${b.market}:${b.validity}:${b.cell_id}`) } : { ok: false };
                  expect(simple(sql as never)).toEqual(simple(model as never));
                  seen.add(sql.ok ? sql.rule : 'REFUSED');
                  if (!sql.ok && !model.ok && model.markets) {
                    expect(sql.markets_detail).toEqual(model.markets);
                  }
                  compared++;
                }
              }
            }
          }
          expect(await w.violations()).toEqual([]);
        }),
        { numRuns: 5, endOnFailure: true },
      );
      expect(compared).toBeGreaterThan(100);
      expect([...seen].sort()).toEqual(['CURRENT_FOR_EVERY_MARKET', 'CURRENT_OR_BRIDGING', 'REFUSED']);
    },
    1_800_000,
  );
});
