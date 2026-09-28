/**
 * Review reproducer F80: market.evaluate_stub_scope (0330) derives the market set and predicates of
 * a stored evaluation from the scope, and refuses a predicate the scope fixes (EBMR-MKT-055), but it
 * passes the site as coalesce(p_req -> 'siteId', <scope's site>). market.evaluation_complete then
 * applies the site value of whatever site the caller named. A PRODUCT scope (a batch) fixes its site
 * (stub_batch.site_id), so an evaluation of batch B must apply B's own site value.
 *
 * Setup: the IN-52 stub world. Batch T-IN (site S1, markets {IN}) resolves
 * tablets.compression.ipcSampleMaxInterval to 30 min. S1 holds a TIGHTER site value of 20 min.
 * A second site S2 holds its own TIGHTER value of 25 min (tighter than the table, looser than S1).
 *
 * Safe behaviour asserted: an OPERATOR (MARKET.RULE_EVALUATE) evaluating batch T-IN cannot obtain
 * a stored evaluation of T-IN that applies another site: a request naming a random site id or S2 is
 * either refused, or stored with site_id = S1, SITE_TIGHTER and effective value 20.
 *
 * Positive control: without a siteId override T-IN is stored with site S1, SITE_TIGHTER, 20.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateStubScope, setSiteValue, type EvaluateStubScopeRequest, type StoredEvaluation } from '../../src/market/repository.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asApp, MARKET_ROLES, publishSeedTables, seedStubWorld, type StubWorld } from '../market/helpers.ts';

let db: TestDatabase;
let world: StubWorld;
let site2: string;

const KEY = 'tablets.compression.ipcSampleMaxInterval';
const AS_OF = '2026-03-01';

beforeAll(async () => {
  db = await createTestDatabase();
  await publishSeedTables(db);
  world = await seedStubWorld(db);
  // A second site (same installation) with its own, less tight, site value.
  site2 = await asApp(
    db,
    async (c) => {
      const { rows } = await c.query<{ id: string }>('insert into market.stub_site (code, markets) values ($1, $2) returning id', [
        `SITE2-${randomUUID().slice(0, 8)}`,
        ['IN'],
      ]);
      return rows[0]?.id ?? '';
    },
    { roleCode: MARKET_ROLES.stubs },
  );
  const s1 = await asApp(db, (c) => setSiteValue(c, { siteId: world.siteId, key: KEY, value: '20', effectiveFrom: '2026-01-01' }), {
    roleCode: MARKET_ROLES.siteValues,
  });
  expect(s1.outcome).toBe('TIGHTER');
  const s2 = await asApp(db, (c) => setSiteValue(c, { siteId: site2, key: KEY, value: '25', effectiveFrom: '2026-01-01' }), {
    roleCode: MARKET_ROLES.siteValues,
  });
  expect(s2.outcome).toBe('TIGHTER');
});

afterAll(async () => {
  await db.drop();
});

/** Evaluate as an OPERATOR (MARKET.RULE_EVALUATE). */
function evaluate(request: EvaluateStubScopeRequest): Promise<StoredEvaluation> {
  return asApp(db, (c) => evaluateStubScope(c, request), { roleCode: MARKET_ROLES.evaluator });
}

/** A short description of the stored evaluation, or the refusal code. */
async function attempt(p: Promise<StoredEvaluation>): Promise<string> {
  try {
    const e = await p;
    const site = e.siteId === world.siteId ? 'S1' : e.siteId === site2 ? 'S2' : e.siteId === null ? 'none' : 'foreign';
    return `stored subject=${e.subjectId === world.batch.tabletIn ? 'T-IN' : e.subjectId} site=${site} outcome=${e.siteOutcome} effective=${JSON.stringify(e.effectiveValue)}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `REFUSED ${/EBMR-[A-Z]+-\d+/.exec(message)?.[0] ?? message}`;
  }
}

const SAFE_STORED = 'stored subject=T-IN site=S1 outcome=SITE_TIGHTER effective="20"';
const safe = (r: string): string => (r.startsWith('REFUSED') || r === SAFE_STORED ? 'SAFE' : r);

describe('F80: an evaluation of a batch applies the batch\'s own site value', () => {
  it('[INV-29][IN-52] a siteId in the request cannot replace the site the batch scope fixes', async () => {
    const base = { key: KEY, scope: { kind: 'PRODUCT' as const, id: world.batch.tabletIn }, resolutionPoint: 'EXECUTION' as const, asOf: AS_OF };

    // Positive control: the scope's own site S1 gives SITE_TIGHTER, 20.
    const control = await attempt(evaluate(base));
    expect(control).toBe(SAFE_STORED);

    // Attack 1: a random site id -> the batch's tighter site value is dropped (NO_SITE_VALUE, 30).
    const randomSite = await attempt(evaluate({ ...base, siteId: randomUUID() }));
    // Attack 2: another site's looser (but still "TIGHTER") value -> 25 instead of 20, looks legitimate.
    const otherSite = await attempt(evaluate({ ...base, siteId: site2 }));

    expect({ randomSite: safe(randomSite), otherSite: safe(otherSite) }).toEqual({ randomSite: 'SAFE', otherSite: 'SAFE' });
  });
});
