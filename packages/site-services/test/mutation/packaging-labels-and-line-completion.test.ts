/**
 * The label store's transaction rules one by one (SQL mutation group "packaging-labels-and-line-completion", site
 * services 0950 site.open_label_store_transaction). The scenario test (lots/label-store.test.ts) shows the store
 * working; these take each rule the Phase 6 mutation run found unproven to the input where it alone decides: every
 * malformed transaction alone is refused (EBMR-LBL-020), an issue of exactly the store's balance and a return of
 * exactly what the order holds go through, and one unit more does not (PR-32).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';
import { refusal, seedCast, World } from '../lots/support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const open = (p: unknown) =>
  w.run(w.cast.warehouse, async (c) => (await c.query<{ r: string }>('select site.open_label_store_transaction($1::jsonb) as r', [JSON.stringify(p)])).rows[0]?.r, 'label store transaction');
const balance = async (lotId: string): Promise<string> => (await db.app.query<{ b: string }>('select site.label_store_balance($1)::text as b', [lotId])).rows[0]?.b ?? '';

describe('label-store transactions, rule by rule (site services 0950)', () => {
  it('[PR-32] each malformed transaction alone is refused, and nothing is written', async () => {
    const lot = await w.releasedLot('PRINTED_PACKAGING', { quantity: '100', unit: '1' });
    const ok = { kind: 'RECEIPT', lotId: lot.lotId, quantity: '10' };
    const { kind: _kind, ...noKind } = ok;
    void _kind;
    for (const bad of [
      [ok],
      { ...ok, note: 'x' },
      noKind,
      { ...ok, kind: 'SALE' },
      { ...ok, lotId: 'not-a-uuid' },
      { ...ok, quantity: '0' },
      { kind: 'ISSUE', lotId: lot.lotId, quantity: '1', batchRef: 'PK 1' },
      { ...ok, reason: '  ' },
      { ...ok, batchRef: 'PK-1' },
    ]) {
      expect(await refusal(open(bad))).toMatch(/^EBMR-LBL-020 /);
    }
    expect(await balance(lot.lotId)).toBe('0');
  });

  it('[PR-32] an issue of exactly the balance and a return of exactly what the order holds go through; one more unit does not', async () => {
    const lot = await w.releasedLot('PRINTED_PACKAGING', { quantity: '100', unit: '1' });
    await open({ kind: 'RECEIPT', lotId: lot.lotId, quantity: '100' });
    expect(await refusal(open({ kind: 'ISSUE', lotId: lot.lotId, quantity: '101', batchRef: 'PK-9' }))).toMatch(/^EBMR-LBL-023 the store holds 100/);
    expect(await open({ kind: 'ISSUE', lotId: lot.lotId, quantity: '100', batchRef: 'PK-9' })).toMatch(/^[0-9a-f-]{36}$/);
    expect(await balance(lot.lotId)).toBe('0');
    expect(await refusal(open({ kind: 'RETURN', lotId: lot.lotId, quantity: '101', batchRef: 'PK-9' }))).toMatch(/^EBMR-LBL-023 order PK-9/);
    expect(await open({ kind: 'RETURN', lotId: lot.lotId, quantity: '100', batchRef: 'PK-9' })).toMatch(/^[0-9a-f-]{36}$/);
    expect(await balance(lot.lotId)).toBe('100');
  });
});
