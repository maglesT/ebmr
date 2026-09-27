/**
 * Site values may only tighten (build outline 3.3.2; ADR 0008 decision 8): looser than HARD is
 * refused; looser than a DESIGN value is refused; loosening GUIDANCE or an adopted EXAMPLE needs a
 * justification (CCS) reference and a QA approval record and is flagged on every affected batch.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchFlags, evaluateStubScope, setSiteValue, type SiteValueRequest } from '../../src/market/repository.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asApp, createTestTable, MARKET_ROLES, publishDocument, publishSeedTables, seedStubWorld, type StubWorld } from './helpers.ts';

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

const set = (request: Omit<SiteValueRequest, 'siteId' | 'effectiveFrom'> & { effectiveFrom?: string }) =>
  asApp(db, (c) => setSiteValue(c, { siteId: world.siteId, effectiveFrom: '2026-01-01', ...request }), { roleCode: MARKET_ROLES.siteValues });

const evaluateBatch = (key: string, batch: string, asOf = '2026-03-01') =>
  asApp(db, (c) => evaluateStubScope(c, { key, scope: { kind: 'PRODUCT', id: batch }, resolutionPoint: 'EXECUTION', asOf }));

describe('tighten only', () => {
  it('[IN-52] a stricter site value is accepted and applied to the site\'s batches', async () => {
    const sv = await set({ key: 'tablets.compression.ipcSampleMaxInterval', value: '20' });
    expect(sv.outcome).toBe('TIGHTER');
    const e = await evaluateBatch('tablets.compression.ipcSampleMaxInterval', world.batch.tabletIn);
    expect([e.resolvedValue, e.effectiveValue, e.siteOutcome, e.siteValueId]).toEqual(['30', '20', 'SITE_TIGHTER', sv.id]);
  });

  it('[IN-52] a site value looser than a HARD value is refused, with or without approvals', async () => {
    await expect(set({ key: 'kernel.selfInspection.maxIntervalMonths', value: '18' })).rejects.toThrow('EBMR-MKT-060');
    await expect(
      set({ key: 'kernel.selfInspection.maxIntervalMonths', value: '18', justificationRef: 'CCS-12', qaApprovalId: randomUUID() }),
    ).rejects.toThrow('EBMR-MKT-060');
    await expect(set({ key: 'sterile.particles.gradeB.inOperation.max5_0um', value: '2930' })).rejects.toThrow('EBMR-MKT-060');
  });

  it('[IN-52] a site value looser than a DESIGN value is refused (APS tiers are out of v1; HEPA A/B is six months by design)', async () => {
    await expect(set({ key: 'sterile.aps.acceptance', value: 'TIERED_BY_RUN_SIZE', justificationRef: 'CCS-1', qaApprovalId: randomUUID() })).rejects.toThrow(
      /EBMR-MKT-06[01]/,
    );
    await expect(set({ key: 'kernel.excipient.identityTestEachLot', value: false, justificationRef: 'VH-STAT-1', qaApprovalId: randomUUID() })).rejects.toThrow(
      /EBMR-MKT-06[01]/,
    );
  });

  it('[IN-52] loosening a GUIDANCE value needs a justification reference and a QA approval record', async () => {
    await expect(set({ key: 'kernel.managementReview.maxIntervalMonths', value: '15' })).rejects.toThrow('EBMR-MKT-065');
    await expect(set({ key: 'kernel.managementReview.maxIntervalMonths', value: '15', justificationRef: 'MR-JUST-7' })).rejects.toThrow('EBMR-MKT-065');
    const approval = randomUUID();
    const sv = await set({ key: 'kernel.managementReview.maxIntervalMonths', value: '15', justificationRef: 'MR-JUST-7', qaApprovalId: approval });
    expect([sv.outcome, sv.justificationRef, sv.qaApprovalId]).toEqual(['LOOSENED', 'MR-JUST-7', approval]);
  });

  it('[IN-52] a loosened GUIDANCE value is shown on every affected batch evaluation', async () => {
    const e = await evaluateBatch('kernel.managementReview.maxIntervalMonths', world.batch.injectableAll);
    expect([e.resolvedValue, e.effectiveValue, e.siteOutcome]).toEqual(['12', '15', 'SITE_LOOSENED']);
    expect(await batchFlags(db.app, world.batch.injectableAll)).toEqual([
      expect.objectContaining({ key: 'kernel.managementReview.maxIntervalMonths', siteOutcome: 'SITE_LOOSENED', effectiveValue: '15' }),
    ]);
  });

  it('[IN-52] a set-valued rule accepts added elements but never removed ones; a NOT_COMPARABLE rule takes no site value', async () => {
    const added = await set({ key: 'kernel.release.requiredAuthorities', value: ['AUTHORISED_PERSON_RELEASE', 'EU_QP_CERTIFICATION', 'HEAD_OF_QC_APPROVAL', 'QUALITY_UNIT_RECORD_REVIEW', 'SITE_HEAD_SIGN_OFF'] });
    expect(added.outcome).toBe('TIGHTER');
    await expect(set({ key: 'kernel.release.requiredAuthorities', value: ['AUTHORISED_PERSON_RELEASE'] })).rejects.toThrow('EBMR-MKT-064');
    await expect(set({ key: 'kernel.label.manufacturingDate', value: 'NOT_REQUIRED' })).rejects.toThrow('EBMR-MKT-063');
    await expect(set({ key: 'tablets.compression.ipcSampleMaxInterval', value: 20 as unknown as string })).rejects.toThrow('EBMR-MKT-062');
  });

  it('[IN-52] site values are insert-only and written only through the function', async () => {
    await expect(asApp(db, (c) => c.query(`update market.site_value set value = '"90"'`), { reasonCode: 'X' })).rejects.toThrow(/permission denied/);
    await expect(
      asApp(db, (c) =>
        c.query(
          `insert into market.site_value (site_id, key, value, unit, effective_from, table_version_id, market_set, predicates, resolution, outcome, recorded_by)
           select $1, 'kernel.selfInspection.maxIntervalMonths', '"24"', 'mo', '2026-01-01', id, '{IN}', '{}', '{}', 'TIGHTER', $1 from market.rule_table_version limit 1`,
          [world.siteId],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('adopted EXAMPLE values and later table versions', () => {
  it('[IN-52] loosening an adopted EXAMPLE value needs the same justification and approval; a site value that a later table makes too loose is not applied but flagged', async () => {
    const table = `sv${randomUUID().slice(0, 6)}`;
    await createTestTable(db, table);
    const doc = {
      table,
      version: 1,
      change: { kind: 'INITIAL', description: 'EXAMPLE test table' },
      keys: [{ key: `${table}.pressureStep`, title: 'Pressure step', method: 'LARGER_STRICTER', valueType: 'DECIMAL', unit: 'Pa', indiaGoverns: true }],
      rows: [
        { ref: 'IN', key: `${table}.pressureStep`, market: 'IN', value: '10', unit: 'Pa', floor: 'GUIDANCE', hardFloor: '5', source: 'test', verification: 'P', effectiveFrom: '2024-01-01' },
        { ref: 'US', key: `${table}.pressureStep`, market: 'US', value: '12.5', unit: 'Pa', floor: 'EXAMPLE', source: 'test', verification: 'CHK', effectiveFrom: '2024-01-01' },
      ],
    };
    await publishDocument(db, doc);
    const key = `${table}.pressureStep`;
    await expect(set({ key, value: '11' })).rejects.toThrow('EBMR-MKT-065');
    await expect(set({ key, value: '4', justificationRef: 'CCS-4', qaApprovalId: randomUUID() })).rejects.toThrow('EBMR-MKT-060');
    const loosened = await set({ key, value: '11', justificationRef: 'CCS-4.2', qaApprovalId: randomUUID() });
    expect(loosened.outcome).toBe('LOOSENED');

    // A later version makes 12.5 HARD from 2099-01-01: from then on the approved loosening is no longer admissible.
    const v2 = {
      ...doc,
      version: 2,
      change: { kind: 'UPDATE', description: 'US value becomes binding from 2099' },
      rows: [
        doc.rows[0],
        { ...doc.rows[1], effectiveTo: '2099-01-01' },
        { ...doc.rows[1], ref: 'US.2099', floor: 'HARD', effectiveFrom: '2099-01-01' },
      ],
    };
    const published = await publishDocument(db, v2);
    const { rows: impact } = await db.app.query<{ ref_type: string; due_by: string }>(
      "select ref_type, to_char(due_by, 'YYYY-MM-DD') as due_by from market.change_impact where version_id = $1",
      [published.versionId],
    );
    expect(impact).toEqual([{ ref_type: 'SITE_VALUE', due_by: '2099-01-01' }]);
    const before = await evaluateBatch(key, world.batch.tabletAll, '2098-12-01');
    expect([before.effectiveValue, before.siteOutcome]).toEqual(['11', 'SITE_LOOSENED']);
    const after = await evaluateBatch(key, world.batch.tabletAll, '2099-02-01');
    expect([after.resolvedValue, after.effectiveValue, after.siteOutcome]).toEqual(['12.5', '12.5', 'SITE_VALUE_INADMISSIBLE']);
    const flags = await batchFlags(db.app, world.batch.tabletAll);
    expect(flags.map((f) => f.siteOutcome)).toEqual(expect.arrayContaining(['SITE_LOOSENED', 'SITE_VALUE_INADMISSIBLE']));
  });
});
