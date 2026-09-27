/**
 * Change impact (build outline 3.3.5; ADR 0008 decision 11): a new rule-table version lists every
 * stub MBR reference whose pinned value is looser than the new resolved value, due by the date the
 * stricter rule takes effect (today if it already applies).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeImpact } from '../../src/market/repository.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asApp, publishDocument, publishSeedTables, seedDocument } from './helpers.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
  await publishSeedTables(db);
});
afterAll(async () => {
  await db.drop();
});

describe('change impact of a new table version', () => {
  it('[IN-52] a tightened IPC interval lists every MBR whose pinned interval is looser, due by the effective date', async () => {
    const key = 'tablets.compression.ipcSampleMaxInterval';
    await asApp(db, (c) =>
      c.query(
        `insert into market.stub_mbr_limit (mbr_code, mbr_version, key, value, markets) values
           ('MBR-ALREADY-LOOSE', 3, $1, '"45"', '{IN}'),
           ('MBR-LOOSE-FROM-2099', 1, $1, '"25"', '{IN,US}'),
           ('MBR-TIGHT', 2, $1, '"15"', '{IN,EU}'),
           ('MBR-OTHER-KEY', 1, 'tablets.compression.stationWiseCheckAtRunStart', 'true', '{IN}')`,
        [key],
      ),
    );
    const doc = seedDocument('tablets');
    const next = {
      ...doc,
      version: 2,
      change: { kind: 'UPDATE' as const, description: 'hypothetical tightening of the compression IPC interval from 2099' },
      rows: doc.rows.flatMap((r) =>
        r.ref === 'B-03.IN.ipcInterval' ? [{ ...r, effectiveTo: '2099-01-01' }, { ...r, ref: 'B-03.IN.ipcInterval.2099', value: '20', effectiveFrom: '2099-01-01' }] : [r],
      ),
    };
    const published = await publishDocument(db, next);
    expect(published.loosening).toEqual([]);
    const { rows } = await db.app.query<{ today: string }>("select to_char((clock_timestamp() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as today");
    const impact = await changeImpact(db.app, published.versionId);
    expect(impact.map((i) => [i.refLabel, i.pinnedValue, i.requiredValue, i.governingMarkets, i.dueBy])).toEqual([
      ['MBR-ALREADY-LOOSE v3', '45', '30', ['IN'], rows[0]?.today],
      ['MBR-LOOSE-FROM-2099 v1', '25', '20', ['IN'], '2099-01-01'],
    ]);
    expect(published.impactCount).toBe(2);
  });

  it('[IN-52] impact items are insert-only records of the version and the application role cannot write them', async () => {
    await expect(asApp(db, (c) => c.query("update market.change_impact set due_by = '2100-01-01'"), { reasonCode: 'X' })).rejects.toThrow(/permission denied/);
    await expect(db.admin.query('delete from market.change_impact')).rejects.toThrow('EBMR-AUDIT-004');
  });
});
