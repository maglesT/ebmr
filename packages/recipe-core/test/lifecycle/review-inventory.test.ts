/**
 * Periodic review with its overdue list, the controlled-document inventory and its reconciliation
 * with the site's document list, and where-used (PR-05; PR-02 unique document ID and version).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';
import * as lc from '../../src/lifecycle/index.ts';
import { cell, reason, scope, seedCast, uniqueContent, World } from './support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 300_000);

afterAll(async () => {
  await db.drop();
});

describe('periodic review (PR-05)', () => {
  // Review F13: the dashboard that shows this list comes with Phase 6; this test shows the list the database keeps.
  it('[PR-05] an overdue review is on the overdue list (recipe.overdue_reviews) until the review is recorded', async () => {
    const content = uniqueContent();
    const v = await w.approvedVersion(content, { effectiveFrom: '2026-01-01T00:00:00Z', reviewDue: '2026-06-30' });
    await w.authorise({ versionId: v.versionId, market: 'IN', kind: 'CURRENT', cells: [cell('S1', 'L1', 'PO-20K')], regulatoryBasis: 'IN' });
    const overdue = await lc.overdueReviews(db.app);
    const mine = overdue.find((o) => o.versionId === v.versionId);
    expect(mine).toMatchObject({ reviewDue: '2026-06-30', inUse: true, documentId: `MBR-${content.header.family}-v1`, lastReviewAt: null });
    expect(mine?.daysOverdue).toBeGreaterThan(0);
    // Not yet overdue on the due date itself.
    expect((await lc.overdueReviews(db.app, '2026-06-30')).some((o) => o.versionId === v.versionId)).toBe(false);
    await expect(w.run(w.cast.qa, (c) => lc.recordPeriodicReview(c, v.versionId, 'NO_CHANGE', 'reviewed against the dossier', '2020-01-01'))).rejects.toThrow(/EBMR-RCP-072/);
    await expect(w.run(w.cast.author, (c) => lc.recordPeriodicReview(c, v.versionId, 'NO_CHANGE', 'x', '2028-06-30'))).rejects.toThrow(/EBMR-IAM-040/);
    await w.run(w.cast.qa, (c) => lc.recordPeriodicReview(c, v.versionId, 'NO_CHANGE', 'reviewed against the dossier; no change needed', '2028-06-30'));
    expect((await lc.overdueReviews(db.app)).some((o) => o.versionId === v.versionId)).toBe(false);
    expect((await lc.overdueReviews(db.app, '2028-07-01')).find((o) => o.versionId === v.versionId)?.reviewDue).toBe('2028-06-30');
  });

  it('[PR-05] only approved versions are reviewed; a retired version leaves the overdue list', async () => {
    const content = uniqueContent();
    const v = await w.approvedVersion(content, { reviewDue: '2026-02-01' });
    expect((await lc.overdueReviews(db.app)).some((o) => o.versionId === v.versionId)).toBe(true);
    const s = await w.state(v.versionId);
    await w.run(w.cast.qa, (c) => lc.retireVersion(c, v.versionId, s.version), reason('superseded by a new product'));
    expect((await lc.overdueReviews(db.app)).some((o) => o.versionId === v.versionId)).toBe(false);
    await expect(w.run(w.cast.qa, (c) => lc.recordPeriodicReview(c, v.versionId, 'NO_CHANGE', 'x', '2028-01-01'))).rejects.toThrow(/EBMR-RCP-072/);
  });
});

describe('document inventory and where-used (PR-05, PR-02)', () => {
  it('[PR-05][PR-02] the inventory export lists every version with ID, version, status and dates, and reconciles with the site document list', async () => {
    const content = uniqueContent();
    const v1 = await w.approvedVersion(content);
    await w.authorise({ versionId: v1.versionId, market: 'IN', kind: 'CURRENT', cells: [cell('S1', 'L1', 'PO-20K')], regulatoryBasis: 'IN' });
    const v2 = await w.run(w.cast.author, (c) => lc.deriveVersion(c, v1.versionId, 'next revision'));
    const rows = (await lc.documentInventory(db.app)).filter((r) => r.familyCode === content.header.family);
    expect(rows.map((r) => [r.documentId, r.versionNumber, r.state])).toEqual([
      [`MBR-${content.header.family}-v1`, 1, 'APPROVED'],
      [`MBR-${content.header.family}-v2`, 2, 'DRAFT'],
    ]);
    const first = rows[0];
    expect(first).toMatchObject({ effectiveFrom: '2026-01-01T00:00:00.000000Z', reviewDue: '2027-12-31', contentHash: v1.contentHash });
    expect(first?.approvedAt).toMatch(/^20\d\d-\d\d-\d\dT/);
    expect(first?.changeRecordNumber).toMatch(/^CC-/);
    expect(lc.currentMarkets(first as lc.InventoryRow)).toBe('IN:CURRENT');
    const csv = lc.inventoryCsv(rows);
    expect(csv.split('\r\n')[0]).toBe(lc.INVENTORY_COLUMNS.join(','));
    expect(csv).toContain(`MBR-${content.header.family}-v1,${content.header.family},1,APPROVED,`);
    // Reconciliation with the site's document list.
    const site: lc.SiteDocument[] = rows.map((r) => ({ documentId: r.documentId, versionNumber: r.versionNumber, state: r.state }));
    expect(lc.reconcileInventory(rows, site)).toEqual({ reconciled: true, missingFromSiteList: [], unknownToSystem: [], mismatched: [] });
    const drifted = [{ ...site[0], state: 'RETIRED' } as lc.SiteDocument, { documentId: 'MBR-OLD-v9', versionNumber: 9, state: 'APPROVED' }];
    expect(lc.reconcileInventory(rows, drifted)).toEqual({
      reconciled: false,
      missingFromSiteList: [`MBR-${content.header.family}-v2`],
      unknownToSystem: ['MBR-OLD-v9'],
      mismatched: [{ documentId: `MBR-${content.header.family}-v1`, system: { versionNumber: 1, state: 'APPROVED' }, site: { versionNumber: 1, state: 'RETIRED' } }],
    });
    expect(v2.versionNumber).toBe(2);
  });

  it('[PR-05] where-used lists the batches pinned to a version', async () => {
    const content = uniqueContent();
    const v1 = await w.approvedVersion(content);
    await w.authorise({ versionId: v1.versionId, market: 'IN', kind: 'CURRENT', cells: [cell('S1', 'L1', 'PO-20K')], regulatoryBasis: 'IN' });
    const b1 = await w.issue(v1.familyId, ['IN'], scope('S1', 'L1', 'PO-20K'));
    const b2 = await w.issue(v1.familyId, ['IN'], scope('S1', 'L1', 'PO-20K'));
    expect((await lc.whereUsed(db.app, v1.versionId)).map((b) => b.batchNumber).sort()).toEqual([b1.batchNumber, b2.batchNumber].sort());
  });
});
