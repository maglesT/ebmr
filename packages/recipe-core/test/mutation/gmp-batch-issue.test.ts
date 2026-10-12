/**
 * The release for packing a bulk issue rests on (SQL mutation group "gmp-batch-issue", recipe-core 0701,
 * recipe.release_for_packing_problem; exit review HIGH-3): a processing batch is released for packing only when every
 * instance of its hold point H-PACK is COMPLETED with a positive disposition and carries a valid HOLD_POINT signature.
 * Each case below breaks exactly one of these. The function reads the stored engine state, written here by the superuser
 * with session_replication_role = replica in a transaction that is always rolled back.
 *
 * Controls: INV-27, IN-18, PR-37; invariant INV-25.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await db.drop();
});

type Json = Record<string, unknown>;
const OK: Json = { step: 'H-PACK', status: 'COMPLETED', disposition: { code: 'APPROVED', positive: true }, signatures: [{ role: 'PERFORMED', valid: true }, { role: 'HOLD_POINT', valid: true }] };

/** The problem for a batch whose state holds `steps` (none stored when null). */
async function problem(steps: Record<string, Json> | null): Promise<string | null> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    const id = randomUUID();
    if (steps) {
      await c.query(
        "insert into recipe.execution_state (batch_id, state, state_version, state_hash, last_seq, last_row_hash, status) values ($1, $2::jsonb, 1, repeat('a', 64), 1, 'x', 'IN_PROGRESS')",
        [id, JSON.stringify({ steps })],
      );
    }
    return (await c.query<{ r: string | null }>('select recipe.release_for_packing_problem($1) as r', [id])).rows[0]?.r ?? null;
  } finally {
    await c.query('rollback');
    c.release();
  }
}

describe('recipe.release_for_packing_problem (recipe-core 0701)', () => {
  it('[INV-27][IN-18][PR-37] released for packing only when every H-PACK is completed, approved and signed by QA at the hold point', async () => {
    const notSigned = 'QA has not signed its release for packing (H-PACK) APPROVED';
    expect(await problem(null)).toBe('it has no stored execution state');
    expect(await problem({ 'K1@': { step: 'P-1', status: 'COMPLETED' } })).toBe('its record holds no "release for packing" hold point H-PACK');
    expect(await problem({ 'K1@': { step: 'P-1', status: 'COMPLETED' }, 'H@': OK })).toBeNull();
    expect(await problem({ 'H@': { ...OK, status: 'IN_PROGRESS' } })).toBe(notSigned);
    expect(await problem({ 'H@': { ...OK, disposition: { code: 'NOT_APPROVED', positive: false } } })).toBe(notSigned);
    expect(await problem({ 'H@': { ...OK, signatures: [{ role: 'PERFORMED', valid: true }] } })).toBe(notSigned);
    expect(await problem({ 'H@': { ...OK, signatures: [{ role: 'HOLD_POINT', valid: false }] } })).toBe(notSigned);
    expect(await problem({ 'H@': { ...OK, signatures: 'HOLD_POINT' } })).toBe(notSigned);
    // A second instance of the hold point that is not released keeps the batch from packing.
    expect(await problem({ 'H@': OK, 'H@2': { ...OK, status: 'AWAITING_VERIFICATION' } })).toBe(notSigned);
  });
});
