/**
 * Review reproducer F2: kernel.verify_chain must bind the stored audit_event.table_name and
 * record_id columns to the hashed payload ('table' and 'record_id').
 *
 * The payload hash covers 'table' and 'record_id', and consumers (record-level audit-trail lookups
 * through the audit_event_record index, iam.record_entry_persons, esig integrity, DI extracts, time
 * anomaly windows) read the unhashed columns. If verify_chain only compares seq, chain_key, action,
 * correlation_id and recorded_at, a direct UPDATE of table_name / record_id (no trigger stops it)
 * moves an entry out of a record's audit trail without any verifier noticing.
 *
 * Safe behaviour asserted here (DI-23 catalog test: change an audit row directly in the DB, the
 * verification job alarms and names the entry): after the columns of seq 2 are rewritten, either to
 * other values or to NULL, verify_chain reports a problem at seq 2.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAnchor, verifyChain } from '../../src/audit/verify.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';

let db: TestDatabase;
let base: ActorContext;

beforeAll(async () => {
  db = await createTestDatabase();
  base = await seededTestActor(db, { legalName: 'F2 Operator' });
});

afterAll(async () => {
  await db.drop();
});

const actor = (): ActorContext => ({ ...base, correlationId: randomUUID() });

async function insertSample(batchId: string, value: string): Promise<string> {
  return withCommand(db.app, actor(), async (c) => {
    const { rows } = await c.query<{ id: string }>('insert into testgmp.sample (batch_id, value) values ($1, $2) returning id', [batchId, value]);
    return rows[0]?.id ?? '';
  });
}

/** The record's audit trail as consumers read it: by the indexed (table_name, record_id) columns. */
async function recordTrail(table: string, recordId: string): Promise<number[]> {
  const { rows } = await db.app.query<{ seq: string }>(
    'select seq from kernel.audit_event where table_name = $1 and record_id = $2 order by seq',
    [table, recordId],
  );
  return rows.map((r) => Number(r.seq));
}

describe('F2: audit_event.table_name and record_id are bound to the hashed payload', () => {
  it('[INV-08][DI-23][INV-07] rewriting table_name/record_id of an audit row directly in the database is detected by verify_chain and the entry is named', async () => {
    // Case A: the columns are rewritten to other values.
    const batch = randomUUID();
    const key = `batch:${batch}`;
    await insertSample(batch, '1');
    const victim = await insertSample(batch, '2');
    await insertSample(batch, '3');
    expect(await verifyChain(db.app, key)).toEqual([]);
    expect(await recordTrail('testgmp.sample', victim)).toEqual([2]);

    const { rows: anchorRows } = await db.app.query<{ id: string }>('select kernel.create_anchor() as id');
    const anchorId = Number(anchorRows[0]?.id);

    const { rows: before } = await db.admin.query<{ table_name: string; record_id: string; p_table: string; p_record: string }>(
      "select table_name, record_id, payload->>'table' as p_table, payload->>'record_id' as p_record from kernel.audit_event where chain_key = $1 and seq = 2",
      [key],
    );
    expect(before[0]).toEqual({ table_name: 'testgmp.sample', record_id: victim, p_table: 'testgmp.sample', p_record: victim });

    // Superuser (DBA / break-glass) rewrites the unhashed columns; no trigger refuses the UPDATE.
    const upd = await db.admin.query(
      "update kernel.audit_event set table_name = 'testgmp.reading', record_id = 'other' where chain_key = $1 and seq = 2",
      [key],
    );
    expect(upd.rowCount).toBe(1);
    // The entry has dropped out of the record's audit trail.
    expect(await recordTrail('testgmp.sample', victim)).toEqual([]);

    const anchorProblems = (await verifyAnchor(db.app, anchorId)).filter((p) => p.includes(key));
    const problemsA = await verifyChain(db.app, key);
    console.log('F2 case A verify_chain:', JSON.stringify(problemsA), 'verify_anchor (this chain):', JSON.stringify(anchorProblems));

    // Case B: the columns are set to NULL (a NULL must not hide a mismatch).
    const batchB = randomUUID();
    const keyB = `batch:${batchB}`;
    await insertSample(batchB, '1');
    const victimB = await insertSample(batchB, '2');
    expect(await verifyChain(db.app, keyB)).toEqual([]);
    await db.admin.query('update kernel.audit_event set table_name = null, record_id = null where chain_key = $1 and seq = 2', [keyB]);
    expect(await recordTrail('testgmp.sample', victimB)).toEqual([]);
    const problemsB = await verifyChain(db.app, keyB);
    console.log('F2 case B verify_chain:', JSON.stringify(problemsB));

    // Safe behaviour: the verifier alarms and names the altered entry in both cases.
    expect(problemsA.map((p) => p.seq), 'rewritten table_name/record_id not reported by verify_chain').toContain(2);
    expect(problemsB.map((p) => p.seq), 'NULLed table_name/record_id not reported by verify_chain').toContain(2);
  });
});
