/**
 * Review reproducer F76: the approvals that IN-52 / ADR 0008 / INV-47 require before a market value or
 * policy is loosened are caller-supplied UUIDs that nothing verifies.
 *
 *   - market.publish_rule_table (0340, lines 268-282): a SOURCE_CORRECTION (the only kind of version
 *     that may loosen a value already in force) is accepted when approverIds holds any two distinct
 *     UUIDs other than the publisher. They need not be persons, hold a permission, or have signed.
 *   - market.set_site_value (0320, lines 170-176): loosening a GUIDANCE / adopted EXAMPLE value is
 *     accepted when qaApprovalId is any UUID.
 *   - market.set_policy_version / market.policy_version_guard (0350, lines 118, 226-227): a policy
 *     LOOSENING is accepted when approvalId is any UUID.
 *
 * Scenario (each case by ONE person, with approval ids from randomUUID() that identify no person, no
 * signature and no approval record of any kind):
 *   1. REGULATORY_SIGNER publishes a SOURCE_CORRECTION raising a HARD India interval already in force
 *      (30 -> 45 min, SMALLER_STRICTER), approverIds = two random UUIDs.
 *   2. MASTER_DATA_STEWARD loosens the GUIDANCE kernel.managementReview.maxIntervalMonths (12 -> 15)
 *      for a site, qaApprovalId = random UUID.
 *   3. QA_MBR_APPROVER schedules a policy loosening (ON -> OFF), approvalId = random UUID.
 *
 * Sanity checks in each case prove the loosening path is reached (the same request without the
 * approval field is refused with the existing EBMR code), so a pass cannot come from a test mistake.
 *
 * Safe behaviour asserted: an approval that does not exist (no person, no signature, no approval
 * record) is refused - any EBMR refusal is acceptable. Non-EBMR errors are rethrown (test mistakes).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definePolicy, setPolicyVersion } from '../../src/market/policy.ts';
import { evaluateStubScope, resolveInDatabase, setSiteValue } from '../../src/market/repository.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asApp, createTestTable, MARKET_ROLES, miniDocument, publishDocument, publishDocumentAs, publishSeedTables, seedStubWorld, testActor, type StubWorld } from '../market/helpers.ts';

let db: TestDatabase;
let world: StubWorld;
beforeAll(async () => {
  db = await createTestDatabase();
  await publishSeedTables(db);
  world = await seedStubWorld(db);
});
afterAll(async () => {
  await db.drop();
});

type Outcome<T> = { refused: true; code: string } | { refused: false; value: T };

/** Run a request and report whether the database refused it (an EBMR code) or accepted it. */
async function outcome<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { refused: false, value: await work() };
  } catch (error) {
    const code = /EBMR-[A-Z]+-[0-9]{3}/.exec((error as Error).message)?.[0];
    if (!code) throw error;
    return { refused: true, code };
  }
}

/** Every UUID given as an approval must identify nothing in the database (no person, no signature). */
async function assertNobody(ids: string[]): Promise<void> {
  const { rows } = await db.admin.query<{ n: string }>('select count(*) as n from iam.person where id = any($1::uuid[])', [ids]);
  expect(rows[0]?.n).toBe('0');
  const { rows: sig } = await db.admin.query<{ n: string }>('select count(*) as n from esig.signature where id = any($1::uuid[])', [ids]);
  expect(sig[0]?.n).toBe('0');
}

describe('F76: market-engine loosening approvals must be real, verified approvals', () => {
  it('[IN-52][DI-17] a SOURCE_CORRECTION loosening a HARD value in force is refused when its two approvers are UUIDs of nobody', async () => {
    const table = `f76t${randomUUID().slice(0, 6)}`;
    await createTestTable(db, table);
    await publishDocument(db, miniDocument(table)); // v1: India interval 30 min HARD, in force since 2024-01-01
    const v2 = miniDocument(table, 2);
    const rows = v2['rows'] as Record<string, unknown>[];
    rows[0] = { ...rows[0], value: '45' }; // I.IN: 30 -> 45 min, a retroactive loosening of a HARD India value

    const signer = await testActor(db, { roleCode: MARKET_ROLES.corrector });
    // Sanity: the loosening is in force, so an UPDATE is refused, and a correction without approvers too.
    await expect(publishDocument(db, v2, { kind: 'UPDATE', description: 'loosen' })).rejects.toThrow('EBMR-MKT-031');
    const correction = { kind: 'SOURCE_CORRECTION', description: 'India interval mis-keyed', citation: 'any text' };
    await expect(publishDocumentAs(db, signer, v2, correction)).rejects.toThrow('EBMR-MKT-032');

    const fakeApprovers = [randomUUID(), randomUUID()];
    await assertNobody(fakeApprovers);
    const result = await outcome(async () => {
      const published = await publishDocumentAs(db, signer, v2, { ...correction, approverIds: fakeApprovers });
      const today = new Date().toISOString().slice(0, 10);
      const resolved = await resolveInDatabase(db.app, published.versionId, { key: `${table}.interval`, marketSet: ['IN'], asOf: today });
      return { loosening: published.loosening, resolvedIndiaValueToday: resolved.value };
    });
    expect(result).toEqual({ refused: true, code: expect.stringMatching(/^EBMR-/) });
  });

  it('[IN-52][ST-01] loosening a GUIDANCE site value is refused when its QA approval id is the UUID of nothing', async () => {
    const key = 'kernel.managementReview.maxIntervalMonths'; // GUIDANCE 12 months
    const set = (extra: { justificationRef?: string; qaApprovalId?: string }) =>
      asApp(db, (c) => setSiteValue(c, { siteId: world.siteId, key, value: '15', effectiveFrom: '2026-01-01', ...extra }), { roleCode: MARKET_ROLES.siteValues });
    // Sanity: the same loosening without an approval id is refused (the loosening path is reached).
    await expect(set({ justificationRef: 'MR-JUST-F76' })).rejects.toThrow('EBMR-MKT-065');

    const fakeApproval = randomUUID();
    await assertNobody([fakeApproval]);
    const result = await outcome(async () => {
      const sv = await set({ justificationRef: 'MR-JUST-F76', qaApprovalId: fakeApproval });
      const e = await asApp(db, (c) =>
        evaluateStubScope(c, { key, scope: { kind: 'PRODUCT', id: world.batch.injectableAll }, resolutionPoint: 'EXECUTION', asOf: '2026-03-01' }),
      );
      return { siteValueOutcome: sv.outcome, qaApprovalId: sv.qaApprovalId, batchEffectiveValue: e.effectiveValue, batchSiteOutcome: e.siteOutcome };
    });
    expect(result).toEqual({ refused: true, code: expect.stringMatching(/^EBMR-/) });
  });

  it('[INV-47] a policy loosening is refused when its approval id is the UUID of nothing', async () => {
    const code = `F76.test${randomUUID().slice(0, 6)}`;
    await asApp(db, (c) => definePolicy(c, { code, title: 'F76 policy', level: 'TENANT', positions: ['OFF', 'ON'], defaultPosition: 'ON', controls: ['DI-09'] }), {
      roleCode: MARKET_ROLES.policy,
    });
    const { rows } = await db.app.query<{ t: Date }>(`select clock_timestamp() + interval '1 hour' as t`);
    const effectiveFrom = (rows[0]?.t as Date).toISOString();
    // Sanity: the loosening without an approval id is refused (the loosening path is reached).
    await expect(asApp(db, (c) => setPolicyVersion(c, code, 'OFF', { effectiveFrom, changeRef: 'CC-F76' }), { roleCode: MARKET_ROLES.policy })).rejects.toThrow(
      'EBMR-MKT-073',
    );

    const fakeApproval = randomUUID();
    await assertNobody([fakeApproval]);
    const result = await outcome(async () => {
      const v = await asApp(db, (c) => setPolicyVersion(c, code, 'OFF', { effectiveFrom, approvalId: fakeApproval, changeRef: 'CC-F76' }), {
        roleCode: MARKET_ROLES.policy,
      });
      return { version: v.version, direction: v.direction, position: v.position };
    });
    expect(result).toEqual({ refused: true, code: expect.stringMatching(/^EBMR-/) });
  });
});
