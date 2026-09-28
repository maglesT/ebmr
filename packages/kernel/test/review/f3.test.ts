/**
 * Review reproducer F3: whole-database audit verification must not lose a chain because its head
 * row is missing.
 *
 * verifyAllChains (src/audit/verify.ts) takes its list of chains from kernel.audit_chain_head, and
 * kernel.verify_chain compares the head only "if found". A person with database rights who alters
 * an audit event and then deletes that chain's head row therefore removes the chain from the
 * whole-database verification, although its events are still in kernel.audit_event.
 *
 * Safe behaviour asserted here (INV-08, DI-23): after an event of a chain is altered and the chain's
 * head row is deleted, verifyAllChains still reports a problem for that chain, because the events
 * are still there and do not verify (and the head is gone).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAllChains, verifyChain } from '../../src/audit/verify.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';

let db: TestDatabase;
let base: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seededTestActor(db, { legalName: 'F3 Operator' });
});

afterAll(async () => {
  await db.drop();
});

async function insertSample(batchId: string, value: string): Promise<void> {
  await withCommand(db.app, { ...base, correlationId: randomUUID() }, (c) =>
    c.query('insert into testgmp.sample (batch_id, value) values ($1, $2)', [batchId, value]),
  );
}

describe('F3: whole-database verification covers every chain that has events', () => {
  it('[INV-08][DI-23] tamper: an altered chain whose head row was deleted is still reported by verifyAllChains', async () => {
    const batch = randomUUID();
    const key = `batch:${batch}`;
    for (const v of ['1', '2', '3']) await insertSample(batch, v);

    const mine = async () => (await verifyAllChains(db.app)).filter((p) => p.chainKey === key);

    // Intact chain: nothing reported.
    expect(await mine()).toEqual([]);

    // Superuser alters event 2 without recomputing any hash.
    await db.admin.query("update kernel.audit_event set payload = jsonb_set(payload, '{body,new,value}', '42') where chain_key = $1 and seq = 2", [key]);

    // Sanity: with the head row present, the whole-database job does see the alteration.
    expect((await mine()).map((p) => `${p.seq}: ${p.problem}`)).toContain('2: hash does not match the payload (event altered)');

    // Superuser now deletes the chain's head row.
    const del = await db.admin.query('delete from kernel.audit_chain_head where chain_key = $1', [key]);
    expect(del.rowCount).toBe(1);

    // Precondition: the events are still there and a direct check of this chain still finds the alteration.
    const { rows } = await db.admin.query<{ n: string }>('select count(*)::text as n from kernel.audit_event where chain_key = $1', [key]);
    expect(rows[0]?.n).toBe('3');
    expect((await verifyChain(db.app, key)).map((p) => `${p.seq}: ${p.problem}`)).toContain('2: hash does not match the payload (event altered)');

    // Safe behaviour: the whole-database verification still reports this chain.
    const reported = await mine();
    expect(reported.length, `verifyAllChains reported nothing for ${key} after its head row was deleted`).toBeGreaterThan(0);
    expect(reported.map((p) => `${p.seq}: ${p.problem}`)).toContain('2: hash does not match the payload (event altered)');
  });
});
