/**
 * The exception register's own helpers, rule by rule (SQL mutation group "change-paths-and-hand-over", recipe-core
 * 0440): which exceptions only QA may disposition, and the register row an exception record gives (refused when the
 * record is not an object or names a review category the register does not know). The register's paths through a
 * running batch are in apps/tablets-server/test/execution (db-guards-exception-register, -change-paths, -hand-over)
 * and apps/tablets-server/test/mutation/change-paths-and-hand-over.test.ts.
 *
 * The register row is written by a superuser with session_replication_role = replica (no foreign keys, no audit) in a
 * transaction that is always rolled back: what is under test is the function's own refusal and the row it builds.
 *
 * Controls: DI-26, PR-08, PR-13; invariant INV-41.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../kernel/test/support/db.ts';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 180_000);
afterAll(async () => {
  await db.drop();
});

const qaOnly = async (x: unknown): Promise<boolean> => (await db.admin.query<{ r: boolean }>('select recipe.exception_qa_only($1::jsonb) as r', [JSON.stringify(x)])).rows[0]?.r ?? false;

async function replica<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.admin.connect();
  try {
    await c.query('begin');
    await c.query("set local session_replication_role = 'replica'");
    return await work(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

const COMMAND = (batch: string) =>
  JSON.stringify({ batch_id: batch, seq: 7, recorded_at: '2026-10-01T08:00:00Z', now_us: 1, actor_person: randomUUID(), correlation_id: randomUUID() });
const register = (c: pg.PoolClient, batch: string, id: string, x: unknown) =>
  c.query('select recipe.register_exception(jsonb_populate_record(null::recipe.execution_command, $1::jsonb), $2, $3::jsonb)', [COMMAND(batch), id, JSON.stringify(x)]);

describe('only QA dispositions (PR-08, INV-41)', () => {
  it('[PR-08][INV-41] an exception is QA-only for the engine\'s flag, a REGISTERED or VALIDATED tier, or a decision-affecting correction, and for nothing else', async () => {
    expect(await qaOnly({})).toBe(false);
    expect(await qaOnly({ qaOnly: false, tier: 'ALERT', type: 'LIMIT_EXCURSION' })).toBe(false);
    expect(await qaOnly({ tier: 'INTERNAL_ACTION' })).toBe(false);
    expect(await qaOnly({ type: 'CORRECTION' })).toBe(false);
    expect(await qaOnly({ qaOnly: true })).toBe(true);
    expect(await qaOnly({ tier: 'REGISTERED' })).toBe(true);
    expect(await qaOnly({ tier: 'VALIDATED' })).toBe(true);
    expect(await qaOnly({ type: 'DECISION_AFFECTING_CORRECTION' })).toBe(true);
  });
});

describe('the register row of an exception record (DI-26)', () => {
  it('[DI-26][INV-41] a record that is not an object, or names an unknown review category, is refused with EXE-160', async () => {
    const batch = randomUUID();
    await replica(async (c) => {
      await expect(register(c, batch, 'X1', 'not an object')).rejects.toThrow(/is not an exception record.*EBMR-EXE-160/);
    });
    await replica(async (c) => {
      await expect(register(c, batch, 'X2', { category: 'NO_SUCH_CATEGORY', severity: 'ALERT' })).rejects.toThrow(/review category NO_SUCH_CATEGORY, which the register does not know.*EBMR-EXE-160/);
    });
  });

  it('[DI-26][PR-13] the row records the flags the record carries, false where it carries none', async () => {
    const batch = randomUUID();
    const row = async (x: Record<string, unknown>): Promise<Record<string, boolean> | undefined> =>
      replica(async (c) => {
        await register(c, batch, 'X3', x);
        return (
          await c.query<Record<string, boolean>>('select mandatory, qa_only, deviation_required, registration_relevant, release_blocking from recipe.exception_register where batch_id = $1', [batch])
        ).rows[0];
      });
    expect(await row({ category: 'FLOW', severity: 'ALERT', type: 'LOOP' })).toEqual({
      mandatory: true,
      qa_only: false,
      deviation_required: false,
      registration_relevant: false,
      release_blocking: false,
    });
    expect(await row({ category: 'FLOW', severity: 'ALERT', type: 'LOOP', deviationRequired: true, registrationRelevant: true, releaseBlocking: true })).toEqual({
      mandatory: true,
      qa_only: false,
      deviation_required: true,
      registration_relevant: true,
      release_blocking: true,
    });
  });
});
