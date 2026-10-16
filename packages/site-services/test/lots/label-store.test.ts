/**
 * Phase 6 slice 6c (site services 0950; PR-32; default D-P6c-11): the label store of printed-packaging lots. Only the
 * label-store role opens a transaction (LABEL_STORE.TRANSACT, held by WAREHOUSE_LABELLING); receipts, issues to a
 * packaging order, returns and destructions are whole units, an issue only from a released lot and never more than the
 * store holds; a destruction carries its reason. Proven as the application role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers.ts';
import { refusal, seedCast, World } from './support.ts';

let db: TestDatabase;
let w: World;

beforeAll(async () => {
  db = await createTestDatabase();
  w = new World(db, await seedCast(db));
}, 120_000);
afterAll(async () => {
  await db?.drop();
});

const open = (actor: Parameters<World['run']>[0], p: Record<string, unknown>) =>
  w.run(actor, async (c) => (await c.query<{ r: string }>('select site.open_label_store_transaction($1::jsonb) as r', [JSON.stringify(p)])).rows[0]?.r, 'label store transaction');
const balance = async (lotId: string): Promise<string> => (await db.app.query<{ b: string }>('select site.label_store_balance($1)::text as b', [lotId])).rows[0]?.b ?? '';

describe('the label store (site services 0950)', () => {
  it('[PR-32] an unauthorised user cannot open a label-store transaction: an operator, QA and an administrator are refused, the label store keeps its register, and nothing is written past the function', async () => {
    const lot = await w.receive('PRINTED_PACKAGING', { quantity: '1000', unit: '1' });
    for (const actor of [w.cast.operator, w.cast.qa, w.cast.dispenser]) {
      expect(await refusal(open(actor, { kind: 'RECEIPT', lotId: lot.lotId, quantity: '10' }))).toMatch(/EBMR-IAM-040 .*LABEL_STORE\.TRANSACT/);
    }
    expect(await refusal(open(w.cast.admin, { kind: 'RECEIPT', lotId: lot.lotId, quantity: '10' }))).toMatch(/EBMR-IAM/);
    expect(await balance(lot.lotId)).toBe('0');
    await expect(db.app.query("insert into site.label_store_transaction (kind, lot_id, quantity, performed_by_person, performed_by_account, correlation_id) values ('RECEIPT', $1, 1, gen_random_uuid(), gen_random_uuid(), gen_random_uuid())", [lot.lotId])).rejects.toThrow(/permission denied/);
    expect(await open(w.cast.warehouse, { kind: 'RECEIPT', lotId: lot.lotId, quantity: '1000' })).toMatch(/^[0-9a-f-]{36}$/);
    expect(await balance(lot.lotId)).toBe('1000');
  });

  it('[PR-32] the store issues only released printed lots and never more than it holds; a return is at most what the order took; a destruction has its reason; another kind of lot is not a label-store lot', async () => {
    const quarantined = await w.receive('PRINTED_PACKAGING', { quantity: '500', unit: '1' });
    await open(w.cast.warehouse, { kind: 'RECEIPT', lotId: quarantined.lotId, quantity: '500' });
    expect(await refusal(open(w.cast.warehouse, { kind: 'ISSUE', lotId: quarantined.lotId, quantity: '10', batchRef: 'PK-1' }))).toMatch(/EBMR-LBL-022 /);
    expect(await refusal(open(w.cast.warehouse, { kind: 'RECEIPT', lotId: quarantined.lotId, quantity: '1' }))).toMatch(/EBMR-LBL-023 /);
    const lot = await w.releasedLot('PRINTED_PACKAGING', { quantity: '300', unit: '1' });
    await open(w.cast.warehouse, { kind: 'RECEIPT', lotId: lot.lotId, quantity: '300' });
    expect(await refusal(open(w.cast.warehouse, { kind: 'ISSUE', lotId: lot.lotId, quantity: '301', batchRef: 'PK-1' }))).toMatch(/EBMR-LBL-023 the store holds 300/);
    expect(await refusal(open(w.cast.warehouse, { kind: 'ISSUE', lotId: lot.lotId, quantity: '1.5', batchRef: 'PK-1' }))).toMatch(/EBMR-LBL-020 /);
    expect(await refusal(open(w.cast.warehouse, { kind: 'ISSUE', lotId: lot.lotId, quantity: '5' }))).toMatch(/EBMR-LBL-020 /);
    await open(w.cast.warehouse, { kind: 'ISSUE', lotId: lot.lotId, quantity: '200', batchRef: 'PK-1' });
    expect(await refusal(open(w.cast.warehouse, { kind: 'RETURN', lotId: lot.lotId, quantity: '201', batchRef: 'PK-1' }))).toMatch(/EBMR-LBL-023 order PK-1/);
    expect(await refusal(open(w.cast.warehouse, { kind: 'RETURN', lotId: lot.lotId, quantity: '1', batchRef: 'PK-2' }))).toMatch(/EBMR-LBL-023 order PK-2/);
    await open(w.cast.warehouse, { kind: 'RETURN', lotId: lot.lotId, quantity: '20', batchRef: 'PK-1' });
    expect(await refusal(open(w.cast.warehouse, { kind: 'DESTRUCTION', lotId: lot.lotId, quantity: '20' }))).toMatch(/EBMR-LBL-024 /);
    await open(w.cast.warehouse, { kind: 'DESTRUCTION', lotId: lot.lotId, quantity: '20', reason: 'obsolete artwork version' });
    expect(await balance(lot.lotId)).toBe('100');
    const api = await w.receive('API');
    expect(await refusal(open(w.cast.warehouse, { kind: 'RECEIPT', lotId: api.lotId, quantity: '1' }))).toMatch(/EBMR-LBL-021 /);
  });
});
