/**
 * Review reproducer F26: concurrent market.apply_policy_tightening can leave a batch on a looser
 * policy position than one it already applied (INV-47 race).
 *
 *   - market.policy_pin_guard (0350) reads the batch's newest pin (v_cur) with no lock and compares
 *     the new version only against it.
 *   - The only serialisation point is the audit chain-head row lock taken in the AFTER trigger
 *     (kernel.audit_row_change), i.e. after the BEFORE guard has already passed.
 *   - market.batch_policy (0350) returns the newest pin by recorded_at, not the strictest one.
 *
 * Scenario:
 *   1. Policy positions [A, B, C] (least -> most strict), default A. A batch is issued: pinned at A.
 *   2. V2 = C (TIGHTENING). V3 = B (LOOSENING relative to C, approved, change reference).
 *   3. QA reviewer 1 applies V2 to the batch and has not committed yet.
 *   4. QA reviewer 2 applies V3 to the same batch; its guard sees only the issue pin (A), so B passes,
 *      and it then waits on the audit chain-head lock.
 *   5. Reviewer 1 commits, then reviewer 2 commits (if its call was accepted).
 *
 * Safe behaviour asserted: after both commands, the batch still applies C (the strictest position it
 * ever reached). Either reviewer 2's call is refused (EBMR-MKT-085), or at least what the batch
 * applies never drops from C back to B. Run one after the other, the second call is refused.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbContext, withCommand, type ActorContext } from '../../src/db/command.ts';
import { applyPolicyTightening, batchPolicy, definePolicy, pinPoliciesForBatch, setPolicyVersion } from '../../src/market/policy.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seededTestActor } from '../support/seeded-actor.ts';
import { approvePolicyVersion } from '../market/helpers.ts';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

const ROLE = {
  policy: 'QA_MBR_APPROVER', // MARKET.POLICY_CHANGE
  tightening: 'QA_REVIEWER', // MARKET.POLICY_TIGHTEN_BATCH
  issuer: 'BATCH_ISSUER', // BATCH.ISSUE
} as const;

async function as<T>(roleCode: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return withCommand(db.app, await seededTestActor(db, { roleCode }), work);
}

async function begin(client: pg.PoolClient, ctx: ActorContext): Promise<void> {
  await client.query('begin');
  await client.query('select kernel.begin_command($1::jsonb)', [JSON.stringify(toDbContext(ctx))]);
}

/** Wait until the backend `pid` is waiting on a heavyweight lock, or `settled()` reports it finished. */
async function waitForLockWait(pid: number, settled: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (settled()) return false;
    const { rows } = await db.admin.query<{ waiting: boolean }>(
      "select coalesce(bool_or(wait_event_type = 'Lock'), false) as waiting from pg_stat_activity where pid = $1",
      [pid],
    );
    if (rows[0]?.waiting) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe('F26 concurrent policy tightenings on one batch', () => {
  it('[INV-47] [DI-09] two concurrent applications to one batch never leave it on a looser position than one it already applied', async () => {
    const code = `F26.pol${randomUUID().slice(0, 6)}`;
    await as(ROLE.policy, (c) =>
      definePolicy(c, { code, title: 'F26 policy', level: 'TENANT', positions: ['A', 'B', 'C'], defaultPosition: 'A', controls: ['DI-09'] }),
    );

    // Two batches issued at A: one for the sequential control, one for the concurrent scenario.
    const sequentialBatch = randomUUID();
    const batch = randomUUID();
    await as(ROLE.issuer, (c) => pinPoliciesForBatch(c, sequentialBatch));
    await as(ROLE.issuer, (c) => pinPoliciesForBatch(c, batch));
    expect((await batchPolicy(db.app, batch, code))?.position).toBe('A');

    const v2 = await as(ROLE.policy, (c) => setPolicyVersion(c, code, 'C', { changeRef: 'CC-V2' }));
    // Setup corrected after the F24/F76 fix: the loosening's approval is a real POLICY_LOOSENING_APPROVED
    // e-signature of version 3 at B by a QA person other than the author (a random uuid is refused now).
    const approvalId = await approvePolicyVersion(db, code, 'B');
    const v3 = await as(ROLE.policy, (c) => setPolicyVersion(c, code, 'B', { approvalId, changeRef: 'CC-V3' }));
    expect([v2.position, v2.direction]).toEqual(['C', 'TIGHTENING']);
    expect([v3.position, v3.direction]).toEqual(['B', 'LOOSENING']);

    // Control: one after the other, the second application is refused and the batch stays at C.
    await as(ROLE.tightening, (c) => applyPolicyTightening(c, sequentialBatch, code, v2.id, 'CC-1'));
    await expect(as(ROLE.tightening, (c) => applyPolicyTightening(c, sequentialBatch, code, v3.id, 'CC-2'))).rejects.toThrow('EBMR-MKT-085');
    expect((await batchPolicy(db.app, sequentialBatch, code))?.position).toBe('C');

    // Concurrent: two QA reviewers on the same batch.
    const reviewer1 = await seededTestActor(db, { roleCode: ROLE.tightening });
    const reviewer2 = await seededTestActor(db, { roleCode: ROLE.tightening });
    const c1 = await db.app.connect();
    const c2 = await db.app.connect();
    let outcome2: string;
    let sawLockWait: boolean;
    try {
      const pid2 = (await c2.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid as number;

      await begin(c1, reviewer1);
      await c1.query('select market.apply_policy_tightening($1, $2, $3, $4)', [batch, code, v2.id, 'CC-1']);

      await begin(c2, reviewer2);
      let done = false;
      const pending = c2
        .query('select market.apply_policy_tightening($1, $2, $3, $4)', [batch, code, v3.id, 'CC-2'])
        .then(
          () => 'APPLIED',
          (error: Error) => `REFUSED ${error.message}`,
        )
        .finally(() => {
          done = true;
        });

      // Reviewer 2 is past the BEFORE guard and waiting on reviewer 1's audit chain-head lock.
      sawLockWait = await waitForLockWait(pid2, () => done);

      await c1.query('commit');
      outcome2 = await pending;
      await c2.query(outcome2 === 'APPLIED' ? 'commit' : 'rollback');
    } finally {
      await c1.query('rollback').catch(() => undefined);
      await c2.query('rollback').catch(() => undefined);
      c1.release();
      c2.release();
    }

    const { rows: pins } = await db.admin.query<{ pin_kind: string; position: string }>(
      `select p.pin_kind, v.position from market.batch_policy_pin p join market.policy_version v on v.id = p.policy_version_id
        where p.batch_id = $1 and p.policy_code = $2 order by p.recorded_at, p.id`,
      [batch, code],
    );
    const applied = await batchPolicy(db.app, batch, code);
    const diagnostics = { sawLockWait, outcome2, pins, applied };

    // Safe behaviour: the batch reached C; nothing afterwards may drop it back to B (INV-47).
    expect(applied?.position, JSON.stringify(diagnostics)).toBe('C');
    // And the looser application must not have been recorded as a later pin on top of C.
    expect(pins.map((p) => p.position), JSON.stringify(diagnostics)).not.toContain('B');
  });
});
