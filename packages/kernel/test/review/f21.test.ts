/**
 * Review reproducer F21: market.evaluate_stub_scope (0330) passes
 * coalesce(p_req -> 'siteId', v_scope -> 'siteId') to market.record_evaluation, so the site whose
 * value is applied to a GMP evaluation is whatever the caller supplies. A JSON null also wins (it is
 * jsonb 'null', not SQL NULL), becomes site_id NULL, and market.apply_site_value then returns
 * NO_SITE_VALUE. site_id has no FK and no existence check.
 *
 * Setup: the stub site A (world.siteId) holds a TIGHTER value 15 min for
 * tablets.compression.ipcSampleMaxInterval (India 30 min). A second stub site B holds an approved
 * LOOSENED value 15 mo for kernel.managementReview.maxIntervalMonths (India GUIDANCE 12 mo); site A
 * holds no value for that key.
 *
 * Safe behaviour asserted: an OPERATOR (MARKET.RULE_EVALUATE) evaluating a batch made at site A
 * either gets site A's value applied (the site is the scope's site, whatever the request says) or
 * is refused. It must never get:
 *   - site A's tighter limit dropped by siteId = null or siteId = a random uuid, or
 *   - site B's approved loosening applied to a site A batch by siteId = site B.
 *
 * Positive control: without siteId the stored evaluation carries site A and effective value 15.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateStubScope, setSiteValue, type StoredEvaluation } from '../../src/market/repository.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { approveSiteLoosening, asApp, MARKET_ROLES, publishSeedTables, seedStubWorld, type StubWorld } from '../market/helpers.ts';

let db: TestDatabase;
let world: StubWorld;
let siteB: string;

const IPC_KEY = 'tablets.compression.ipcSampleMaxInterval';
const MR_KEY = 'kernel.managementReview.maxIntervalMonths';
const AS_OF = '2026-03-01';

beforeAll(async () => {
  db = await createTestDatabase();
  await publishSeedTables(db);
  world = await seedStubWorld(db);
  siteB = await asApp(
    db,
    async (c) => {
      const { rows } = await c.query<{ id: string }>('insert into market.stub_site (code, markets) values ($1, $2) returning id', [
        `SITE-B-${randomUUID().slice(0, 8)}`,
        ['IN'],
      ]);
      return rows[0]?.id ?? '';
    },
    { roleCode: MARKET_ROLES.stubs },
  );
  // Site A: a stricter IPC sampling interval than India's 30 min.
  const tighter = await asApp(db, (c) => setSiteValue(c, { siteId: world.siteId, key: IPC_KEY, value: '15', effectiveFrom: '2026-01-01' }), {
    roleCode: MARKET_ROLES.siteValues,
  });
  expect(tighter.outcome).toBe('TIGHTER');
  // Site B: an approved loosening of the India GUIDANCE management-review interval (12 -> 15 months).
  // Setup corrected after the F24/F76 fix: the QA approval is a real SITE_VALUE_LOOSENING_APPROVED
  // e-signature of this loosening (a random uuid is refused now).
  const request = { siteId: siteB, key: MR_KEY, value: '15', effectiveFrom: '2026-01-01', justificationRef: 'MR-JUST-B' };
  const qaApprovalId = await approveSiteLoosening(db, request);
  const loosened = await asApp(db, (c) => setSiteValue(c, { ...request, qaApprovalId }), { roleCode: MARKET_ROLES.siteValues });
  expect(loosened.outcome).toBe('LOOSENED');
});

afterAll(async () => {
  await db.drop();
});

/** Evaluate a site A batch as an OPERATOR; `extra` is merged into the raw request (may carry siteId: null). */
async function evaluate(key: string, batch: string, extra: Record<string, unknown> = {}): Promise<StoredEvaluation> {
  return asApp(
    db,
    (c) =>
      evaluateStubScope(c, {
        key,
        scope: { kind: 'PRODUCT', id: batch },
        resolutionPoint: 'EXECUTION',
        asOf: AS_OF,
        ...(extra as { siteId?: string }),
      }),
    { roleCode: MARKET_ROLES.evaluator },
  );
}

/** A compact description: the stored site, outcome and effective value, or the refusal code. */
async function outcomeOf(p: Promise<StoredEvaluation>, siteName: (id: string | null) => string): Promise<string> {
  try {
    const e = await p;
    return `site=${siteName(e.siteId)} ${e.siteOutcome} effective=${JSON.stringify(e.effectiveValue)}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `REFUSED ${/EBMR-[A-Z]+-\d+/.exec(message)?.[0] ?? message}`;
  }
}

describe('F21: the site applied to an evaluation is the scope\'s site, never the caller\'s choice', () => {
  it('[IN-52][ST-01][INV-29] siteId null, a random siteId or another site\'s id cannot drop the site\'s tighter value or import another site\'s loosening', async () => {
    const name = (id: string | null) => (id === null ? 'NULL' : id === world.siteId ? 'A' : id === siteB ? 'B' : 'FOREIGN');

    // Positive control: without siteId the batch at site A gets site A's tighter 15 min.
    const control = await outcomeOf(evaluate(IPC_KEY, world.batch.tabletIn), name);
    expect(control).toBe('site=A SITE_TIGHTER effective="15"');
    const controlMr = await outcomeOf(evaluate(MR_KEY, world.batch.injectableAll), name);
    expect(controlMr).toBe('site=A NO_SITE_VALUE effective="12"');

    const results = {
      ipcWithSiteNull: await outcomeOf(evaluate(IPC_KEY, world.batch.tabletIn, { siteId: null }), name),
      ipcWithRandomSite: await outcomeOf(evaluate(IPC_KEY, world.batch.tabletIn, { siteId: randomUUID() }), name),
      mrWithOtherSite: await outcomeOf(evaluate(MR_KEY, world.batch.injectableAll, { siteId: siteB }), name),
    };

    // Safe: the evaluation uses site A (same as the control) or the request is refused.
    const safe = (value: string, sameAsControl: string) => value === sameAsControl || value.startsWith('REFUSED ');
    expect({
      ipcWithSiteNull: safe(results.ipcWithSiteNull, control) ? 'SAFE' : results.ipcWithSiteNull,
      ipcWithRandomSite: safe(results.ipcWithRandomSite, control) ? 'SAFE' : results.ipcWithRandomSite,
      mrWithOtherSite: safe(results.mrWithOtherSite, controlMr) ? 'SAFE' : results.mrWithOtherSite,
    }).toEqual({ ipcWithSiteNull: 'SAFE', ipcWithRandomSite: 'SAFE', mrWithOtherSite: 'SAFE' });
  });
});
