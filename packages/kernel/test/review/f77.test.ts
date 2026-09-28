/**
 * Review reproducer F77: kernel.audit_row_change (packages/kernel/sql/0010_audit_trail.sql, the only
 * definition) computes the chain key from the NEW row for an UPDATE:
 *
 *   v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
 *   v_key := v_reg.aggregate_type || ':' || coalesce(v_row ->> v_reg.aggregate_column, '?');
 *
 * so an UPDATE that changes the aggregate column of a registered table (moves the row from aggregate
 * A to aggregate B) is appended to chain B only. Chain A keeps the row's INSERT and never shows the
 * row leaving, so a per-aggregate audit-trail review of A (outline 5.4) still shows the row as A's.
 *
 * Scenario (market.stub_pack is registered with aggregate market_stub_batch / batch_id, 0310:287;
 * ebmr_app holds UPDATE on it, MASTERDATA.CHANGE via MASTER_DATA_STEWARD):
 *   1. MASTER_DATA_STEWARD inserts product P, batches B1 and B2 (both {IN}) and pack PK1 on B1.
 *   2. With a reason, MASTER_DATA_STEWARD runs update market.stub_pack set batch_id = B2 where id = PK1.
 *
 * Sanity checks (so a failure cannot come from a test mistake): the update really moved the row, the
 * INSERT of PK1 is in chain market_stub_batch:B1, and the UPDATE (old batch_id B1 -> new B2) is in
 * chain market_stub_batch:B2.
 *
 * Safe behaviour asserted (DI-22 / DI-25 / INV-07): B1's chain also records the change of PK1 (an event
 * for market.stub_pack / PK1 after its INSERT), so reviewing B1's trail shows the pack left B1.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

interface AuditRow {
  seq: string;
  action: string;
  table_name: string | null;
  record_id: string | null;
  payload: { body?: { old?: Record<string, unknown>; new?: Record<string, unknown> } };
}

async function chainEventsFor(chainKey: string, table: string, recordId: string): Promise<AuditRow[]> {
  const { rows } = await db.admin.query<AuditRow>(
    `select seq::text as seq, action, table_name, record_id, payload
       from kernel.audit_event
      where chain_key = $1 and table_name = $2 and record_id = $3
      order by seq`,
    [chainKey, table, recordId],
  );
  return rows;
}

describe('F77: moving a row to another aggregate must be visible in the old aggregate\'s audit chain', () => {
  it('[DI-22][DI-25][INV-07] update market.stub_pack set batch_id = B2 is recorded in chain market_stub_batch:B1 as well as B2', async () => {
    const tag = randomUUID().slice(0, 8);
    const steward = await seededTestActor(db, { roleCode: 'MASTER_DATA_STEWARD' });

    // 1. Setup: product, batches B1 and B2, pack PK1 on B1.
    const { b1, b2, pk1 } = await withCommand(db.app, { ...steward, correlationId: randomUUID() }, async (c) => {
      const one = async (sql: string, params: unknown[]): Promise<string> => {
        const { rows } = await c.query<{ id: string }>(sql, params);
        const id = rows[0]?.id;
        if (!id) throw new Error(`no id returned by ${sql}`);
        return id;
      };
      const product = await one('insert into market.stub_product (code, edition, markets) values ($1, $2, $3) returning id', [`F77-P-${tag}`, 'tablets', ['IN']]);
      const batch1 = await one('insert into market.stub_batch (batch_number, product_id, markets) values ($1, $2, $3) returning id', [`F77-B1-${tag}`, product, ['IN']]);
      const batch2 = await one('insert into market.stub_batch (batch_number, product_id, markets) values ($1, $2, $3) returning id', [`F77-B2-${tag}`, product, ['IN']]);
      const pack = await one('insert into market.stub_pack (code, batch_id, destination) values ($1, $2, $3) returning id', [`F77-PK1-${tag}`, batch1, 'IN']);
      return { b1: batch1, b2: batch2, pk1: pack };
    });

    // 2. Move the pack from B1 to B2, with a reason (as the application role, inside a command).
    await withCommand(
      db.app,
      { ...steward, correlationId: randomUUID(), reasonCode: 'DATA_CORRECTION', reasonText: 'pack assigned to the wrong batch' },
      (c) => c.query('update market.stub_pack set batch_id = $1 where id = $2', [b2, pk1]),
    );

    // Sanity: the row really moved.
    const { rows: now } = await db.admin.query<{ batch_id: string }>('select batch_id from market.stub_pack where id = $1', [pk1]);
    expect(now[0]?.batch_id).toBe(b2);

    const chainA = `market_stub_batch:${b1}`;
    const chainB = `market_stub_batch:${b2}`;
    const inA = await chainEventsFor(chainA, 'market.stub_pack', pk1);
    const inB = await chainEventsFor(chainB, 'market.stub_pack', pk1);

    // Sanity: the INSERT of PK1 is in B1's chain, the UPDATE (B1 -> B2) is in B2's chain.
    expect(inA[0]?.action).toBe('INSERT');
    const updB = inB.filter((e) => e.action === 'UPDATE');
    expect(updB).toHaveLength(1);
    expect(updB[0]?.payload.body?.old?.['batch_id']).toBe(b1);
    expect(updB[0]?.payload.body?.new?.['batch_id']).toBe(b2);

    // Safe behaviour: B1's own trail records that PK1 changed (left B1) after its INSERT.
    const afterInsertInA = inA.slice(1).map((e) => ({ action: e.action, table: e.table_name, record: e.record_id }));
    expect(
      afterInsertInA,
      `chain ${chainA} holds only the INSERT of pack ${pk1}; the move to ${b2} is recorded only in ${chainB}`,
    ).toContainEqual(expect.objectContaining({ table: 'market.stub_pack', record: pk1 }));
  });
});
