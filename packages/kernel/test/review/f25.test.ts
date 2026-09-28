/**
 * Review reproducer F25: an approved site loosening is re-applied to a later, different resolution
 * and is left out of the change-impact list.
 *
 *   - market.site_value_in_force (0320) picks the site value by (site, key, date) only; the
 *     resolution, table version, predicates and market set the approval was given against are
 *     stored on the row but never compared.
 *   - market.apply_site_value (0320) maps "LOOSENING against today's resolution, and the row was
 *     once LOOSENED" to SITE_LOOSENED and applies the site value.
 *   - market.compute_change_impact (0340) skips a site value when it is LOOSENING and approved
 *     (v_hit is false), so a new table version that moves the value being loosened creates no
 *     tracked change task (outline 3.3.5).
 *
 * Scenario (same shape as kernel.managementReview.maxIntervalMonths, B-24.IN GUIDANCE 12):
 *   1. v1 of a test table: IN GUIDANCE 12 months (SMALLER_STRICTER, no hard floor).
 *   2. The steward sets a site value of 18 with a justification and a QA approval: LOOSENED,
 *      approved against resolved value 12 (12 -> 18).
 *   3. v2 (UPDATE) tightens IN to 6 months. This is a tightening, so the UPDATE is allowed.
 *   4. A batch at the site is evaluated.
 *
 * Safe behaviour asserted: the new version produces a change-impact item for the approved
 * loosening (the value it loosens changed from 12 to 6), and the batch does not silently run the
 * 6 -> 18 loosening under the approval given for 12 -> 18 (it is not applied as SITE_LOOSENED with
 * effective value 18).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateStubScope, setSiteValue } from '../../src/market/repository.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { approveSiteLoosening, asApp, createTestTable, MARKET_ROLES, publishDocument, seedStubWorld, type StubWorld } from '../market/helpers.ts';

let db: TestDatabase;
let world: StubWorld;

beforeAll(async () => {
  db = await createTestDatabase();
  world = await seedStubWorld(db);
});
afterAll(async () => {
  await db.drop();
});

describe('F25 approved site loosening bound to the resolution it was approved against', () => {
  it('[IN-52] [ST-01] an approved loosening is not re-applied after a new table version tightens the value it loosens, and it appears on the change-impact list', async () => {
    const table = `f25${randomUUID().slice(0, 6)}`;
    await createTestTable(db, table);
    const key = `${table}.reviewIntervalMonths`;
    const v1 = {
      table,
      version: 1,
      change: { kind: 'INITIAL', description: 'F25 test table' },
      keys: [{ key, title: 'Maximum interval between reviews', method: 'SMALLER_STRICTER', valueType: 'DECIMAL', unit: 'mo', indiaGoverns: true }],
      rows: [
        { ref: 'R.IN', key, market: 'IN', value: '12', unit: 'mo', floor: 'GUIDANCE', source: 'test source', verification: 'P', effectiveFrom: '2024-01-01' },
      ],
    };
    await publishDocument(db, v1);

    // Step 2: QA approves the loosening 12 -> 18. Setup corrected after the F24/F76 fix: the approval
    // is a real SITE_VALUE_LOOSENING_APPROVED e-signature of this loosening (a random uuid is refused now).
    const request = { siteId: world.siteId, key, value: '18', effectiveFrom: '2026-01-01', justificationRef: 'JUST-12-TO-18' };
    const approval = await approveSiteLoosening(db, request);
    const sv = await asApp(db, (c) => setSiteValue(c, { ...request, qaApprovalId: approval }), { roleCode: MARKET_ROLES.siteValues });
    expect(sv.outcome).toBe('LOOSENED');
    const { rows: stored } = await db.admin.query<{ approved_against: unknown }>(
      "select resolution -> 'value' as approved_against from market.site_value where id = $1",
      [sv.id],
    );
    expect(stored[0]?.approved_against).toBe('12');

    // Positive control: before the new version the approved loosening is applied as approved.
    const before = await asApp(db, (c) =>
      evaluateStubScope(c, { key, scope: { kind: 'PRODUCT', id: world.batch.tabletIn }, resolutionPoint: 'EXECUTION', asOf: '2026-03-01' }),
    );
    expect([before.resolvedValue, before.effectiveValue, before.siteOutcome]).toEqual(['12', '18', 'SITE_LOOSENED']);

    // Step 3: v2 tightens IN from 12 to 6 (an UPDATE may tighten retroactively).
    const v2 = {
      ...v1,
      version: 2,
      change: { kind: 'UPDATE', description: 'IN guidance tightened to 6 months' },
      rows: [{ ...v1.rows[0], value: '6' }],
    };
    const published = await publishDocument(db, v2);
    const { rows: impact } = await db.admin.query<{ ref_type: string; ref_id: string }>(
      'select ref_type, ref_id from market.change_impact where version_id = $1 and ref_id = $2',
      [published.versionId, sv.id],
    );

    // Step 4: a batch at the site is evaluated under v2.
    const after = await asApp(db, (c) =>
      evaluateStubScope(c, { key, scope: { kind: 'PRODUCT', id: world.batch.tabletIn }, resolutionPoint: 'EXECUTION', asOf: '2026-03-01' }),
    );

    const observed = {
      impactCount: published.impactCount,
      impactItemsForApprovedLoosening: impact.length,
      afterResolvedValue: after.resolvedValue,
      afterEffectiveValue: after.effectiveValue,
      afterSiteOutcome: after.siteOutcome,
    };
    // The resolved value really moved to 6 (the scenario is reached).
    expect(observed.afterResolvedValue).toBe('6');
    // Safe behaviour: a change-impact item exists for the approved loosening, and 18 is not applied
    // as an approved loosening against 6 (the approval covered 12 -> 18 only).
    expect({
      impactItemForApprovedLoosening: observed.impactItemsForApprovedLoosening > 0,
      appliesUnapprovedLoosening: observed.afterSiteOutcome === 'SITE_LOOSENED' && observed.afterEffectiveValue === '18',
      observed,
    }).toEqual({
      impactItemForApprovedLoosening: true,
      appliesUnapprovedLoosening: false,
      observed: expect.anything() as unknown,
    });
  });
});
