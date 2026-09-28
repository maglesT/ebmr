/**
 * Review reproducer F57: continuity.compare_external_anchors (kernel 0600:502) classifies an external
 * anchor DISCARDABLE when it is absent from kernel.audit_anchor and only chain heads differ. It never
 * checks that the chain actually ENDS before the anchored seq (ADR 0007 decision 6: the verifier accepts
 * "a chain that ends at the restore point"), that the anchor post-dates the restore point / backup, or
 * that the database was restored or failed over at all. continuity.verify_external_anchors (0600:857)
 * then reports the difference as COVERED once an approved restore event lists the anchor.
 *
 * Scenario (one database, never restored):
 *   1. three GMP writes on batch:<id> (seq 1..3); anchor A1 exported at seq 2, A2 at seq 3.
 *   2. a superuser (session_replication_role = replica, so no trigger and no ddl_log entry) rewrites the
 *      GMP value of the third write (3 -> 99), rewrites audit event seq 3 with a recomputed hash, moves
 *      the chain head, and deletes the kernel.audit_anchor row of A2. The chain still verifies; only the
 *      external copy of A2 shows the change (PROBLEM).
 *   3. a SYSTEM_ADMINISTRATOR records a FAILOVER restore event (no backup needed) with the ledger anchors;
 *      the QA approver signs RESTORE_APPROVED and approves; the restore is completed.
 *
 * Safe behaviour asserted: history that is still present at the anchored seq (changed, not lost) is never
 * DISCARDABLE, so no restore event can cover it: after step 3, A2 is still a PROBLEM and the start-up
 * check against the ledger still fails with ANCHOR_MISMATCH. (A fix that refuses to record the event on a
 * database that was never restored is equally safe; the test accepts that too.)
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportAnchor, verifyExternalAnchors } from '../../src/continuity/anchors.ts';
import type { ExternalAnchor, FileLedger } from '../../src/continuity/ledger.ts';
import { approveRestoreEvent, checkAgainstLedger, completeRestore, recordRestoreEvent } from '../../src/continuity/restore.ts';
import { verifyChain } from '../../src/audit/verify.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import type { SeededActor } from '../identity/seed.ts';
import { dbTime, ensureSealKey, signerActor, signFor, tempDir, tempLedger, testActor } from '../continuity/helpers.ts';

const dir = tempDir('f57');
let db: TestDatabase;
let ledger: FileLedger;
let ops: ActorContext;
let operator: ActorContext;
let approver: SeededActor;
const batch = randomUUID();
const chain = `batch:${batch}`;
let a1: ExternalAnchor;
let a2: ExternalAnchor;

function fresh(ctx: ActorContext): ActorContext {
  return { ...ctx, correlationId: randomUUID() };
}
async function sample(value: string): Promise<void> {
  await withCommand(db.app, fresh(ops), (c) => c.query('insert into testgmp.sample (batch_id, value) values ($1, $2)', [batch, value]));
}

beforeAll(async () => {
  db = await createTestDatabase();
  ledger = tempLedger('f57', dir.path);
  ops = await testActor(db, { roleCode: 'SERVICE_ACCOUNT', source: 'SYSTEM' });
  operator = await testActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR', legalName: 'Restore Operator' });
  approver = await signerActor(db, 'QA_REVIEWER', 'QA Approver');
  await ensureSealKey(db);

  // (1) Three GMP writes on the batch chain; A1 anchors seq 2, A2 anchors seq 3.
  await sample('1');
  await sample('2');
  a1 = await exportAnchor(db.app, ledger);
  await sample('3');
  a2 = await exportAnchor(db.app, ledger);
}, 60_000);

afterAll(async () => {
  await db?.drop();
  dir.cleanup();
});

describe('F57: an approved restore event must not cover changed (not lost) anchored history', () => {
  it('[INV-08][DI-45][DI-23] a FAILOVER event on a never-restored database does not turn a rewritten anchored event into COVERED', async () => {
    // Preconditions: A1 anchors the batch chain at seq 2, A2 at seq 3; both match.
    expect(a1.heads.find((h) => h.chain_key === chain)?.seq).toBe(2);
    expect(a2.heads.find((h) => h.chain_key === chain)?.seq).toBe(3);
    const before = await verifyExternalAnchors(db.app, ledger);
    expect(before.filter((r) => r.status !== 'MATCH')).toEqual([]);

    // (2) Superuser tampering without triggers: change the GMP value 3 -> 99, rewrite audit event seq 3
    // with a recomputed hash, move the chain head, delete the database copy of A2.
    const c = await db.admin.connect();
    try {
      await c.query('begin');
      await c.query("set local session_replication_role = 'replica'");
      await c.query("update testgmp.sample set value = 99 where batch_id = $1 and value = 3", [batch]);
      await c.query(
        `update kernel.audit_event set payload = jsonb_set(payload, '{body,new,value}', '99'),
                hash = sha256(prev_hash || convert_to(jsonb_set(payload, '{body,new,value}', '99')::text, 'UTF8'))
          where chain_key = $1 and seq = 3`,
        [chain],
      );
      await c.query(
        `update kernel.audit_chain_head h set last_hash = e.hash
           from kernel.audit_event e where e.chain_key = h.chain_key and e.seq = h.last_seq and h.chain_key = $1`,
        [chain],
      );
      await c.query('delete from kernel.audit_anchor where id = $1', [a2.anchor_id]);
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }

    // The tampering is effective: the GMP value is 99, the chain still verifies and still has seq 3,
    // and only the external copy of A2 reveals the change.
    const values = await db.app.query<{ v: string }>('select value::text as v from testgmp.sample where batch_id = $1 order by value', [batch]);
    expect(values.rows.map((r) => r.v)).toEqual(['1', '2', '99']);
    expect(await verifyChain(db.app, chain)).toEqual([]);
    const head = await db.app.query<{ s: string }>('select last_seq::text as s from kernel.audit_chain_head where chain_key = $1', [chain]);
    expect(head.rows[0]?.s).toBe('3');
    const tampered = await verifyExternalAnchors(db.app, ledger);
    expect(tampered.filter((r) => r.anchorId === a1.anchor_id).map((r) => r.status)).toEqual(['MATCH']);
    expect(tampered.filter((r) => r.anchorId === a2.anchor_id).map((r) => r.status)).toEqual(['PROBLEM']);

    // (3) A FAILOVER restore event (no backup, no restore took place), signed and approved by QA, completed.
    let a2Classification: string | undefined;
    let affected: string[] = [];
    let recordError: string | null = null;
    try {
      const recorded = await recordRestoreEvent(db.app, fresh(operator), ledger, {
        eventKind: 'FAILOVER',
        performedAt: await dbTime(db),
        reason: 'Planned failover to the standby node',
        changeReference: 'CHG-2026-0057',
        approverPersonIds: [approver.personId],
      });
      a2Classification = recorded.comparison.find((x) => String(x.anchor_id) === a2.anchor_id)?.status;
      affected = recorded.affectedChainKeys;
      const signature = await signFor(db, approver, { type: 'restore_event', id: recorded.restoreEventId }, 'RESTORE_APPROVED', 'RECORDED');
      await approveRestoreEvent(db.app, approver, recorded.restoreEventId, signature);
      await completeRestore(db.app, fresh(operator), ledger, recorded.restoreEventId);
    } catch (error) {
      // Refusing to record/approve such an event is safe behaviour.
      recordError = error instanceof Error ? error.message : String(error);
    }

    // Safe behaviour: the rewritten anchored event is still reported; nothing covers it.
    const after = await verifyExternalAnchors(db.app, ledger);
    const a2After = after.filter((r) => r.anchorId === a2.anchor_id);
    expect.soft(
      a2After.map((r) => ({ status: r.status, problem: r.problem })),
      `A2 anchored ${chain} at seq 3, which is still present with a different hash (changed, not lost); recordError=${recordError}; ` +
        `A2 classified ${a2Classification}; affected chains ${JSON.stringify(affected)}`,
    ).toEqual([{ status: 'PROBLEM', problem: `chain ${chain} at seq 3 differs from external anchor ${a2.anchor_id}` }]);
    expect.soft(a2Classification, 'history still present at the anchored seq must not be DISCARDABLE').not.toBe('DISCARDABLE');
    const check = await checkAgainstLedger(db.app, ledger);
    expect.soft(check.findings.map((f) => f.code), 'start-up check against the ledger').toContain('ANCHOR_MISMATCH');
    expect.soft(check.ok, 'start-up check against the ledger').toBe(false);
  });
});
