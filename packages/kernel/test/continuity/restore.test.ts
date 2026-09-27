/**
 * A simulated disaster: history and numbers are written after a backup, the backup is restored into a
 * new database, and the restore procedure runs there. Proves INV-27 (no identifier issued before the
 * restore is issued again after it) and the restore part of INV-08 (anchors that no longer match are a
 * problem until an approved restore event covers them, and only for the history it discarded).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportAnchor, verifyExternalAnchors } from '../../src/continuity/anchors.ts';
import type { BackupArtefact } from '../../src/continuity/backup-drill.ts';
import type { ExternalAnchor, FileLedger } from '../../src/continuity/ledger.ts';
import { reserveCounterBlock, withProtectedNumbers } from '../../src/continuity/numbers.ts';
import { approveRestoreEvent, checkAgainstLedger, completeRestore, lostWindow, recordRestoreEvent, type RestoreEventInput } from '../../src/continuity/restore.ts';
import { verifyChain } from '../../src/audit/verify.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { backupTestDatabase, dbTime, installNumberStub, restoreCopy, tempDir, tempLedger, testActor } from './helpers.ts';

const KEY = 'test.number:R';
const dir = tempDir('restore');
let source: TestDatabase;
let restored: TestDatabase;
let ledger: FileLedger;
let ops: ActorContext;
let operator: ActorContext;
let approver: ActorContext;
let bystander: ActorContext;
const batch = randomUUID();
const chain = `batch:${batch}`;
let anchorBefore: ExternalAnchor;
let anchorAfter: ExternalAnchor;
let backup: BackupArtefact;
let lostNumbers: string[];
let sourceMaxEventId: bigint;
let restoreEventId: string;

async function sample(db: TestDatabase, value: string): Promise<void> {
  await withCommand(db.app, ops, (c) => c.query('insert into testgmp.sample (batch_id, value) values ($1, $2)', [batch, value]));
}
async function issue(db: TestDatabase): Promise<string> {
  return withProtectedNumbers(db.app, ops, ledger, async (c) => (await c.query<{ v: string }>('select testgmp.issue_number($1)::text as v', [KEY])).rows[0]?.v ?? '');
}
async function restoreInput(approvers: string[]): Promise<RestoreEventInput> {
  return {
    eventKind: 'FULL_RESTORE',
    backupId: backup.backupId,
    backupTakenAt: backup.snapshotTakenAt,
    restorePoint: backup.snapshotTakenAt,
    performedAt: await dbTime(restored),
    reason: 'Primary storage failure; restored from the last good backup',
    changeReference: 'INC-2026-0042',
    approverPersonIds: approvers,
  };
}

beforeAll(async () => {
  source = await createTestDatabase();
  ledger = tempLedger('restore-source', dir.path);
  ops = await testActor(source, { roleCode: 'SERVICE_ACCOUNT', source: 'SYSTEM' });
  operator = await testActor(source, { roleCode: 'SYSTEM_ADMINISTRATOR', legalName: 'Restore Operator' });
  approver = await testActor(source, { roleCode: 'QA_REVIEWER', legalName: 'QA Approver' });
  bystander = await testActor(source, { roleCode: 'QA_REVIEWER', legalName: 'Someone Else' });
  await installNumberStub(source, KEY, 3);

  // History and numbers before the backup.
  await sample(source, '1');
  await sample(source, '2');
  for (let i = 0; i < 3; i++) await issue(source);
  anchorBefore = await exportAnchor(source.app, ledger);
  backup = await backupTestDatabase(source, dir.path);

  // After the backup: more history on the same batch, more numbers (a new block), another anchor.
  await sample(source, '3');
  await sample(source, '4');
  lostNumbers = [await issue(source), await issue(source)];
  anchorAfter = await exportAnchor(source.app, ledger);
  sourceMaxEventId = BigInt((await source.app.query<{ m: string }>('select max(id)::text as m from kernel.audit_event')).rows[0]?.m ?? '0');

  // The disaster: the backup is restored into a new database.
  restored = await restoreCopy(source, backup, dir.path);
}, 60_000);

afterAll(async () => {
  await restored?.drop();
  await source?.drop();
  dir.cleanup();
});

describe('before the restore procedure', () => {
  it('[INV-27] a restored database refuses to issue protected numbers (its incarnation changed)', async () => {
    expect(lostNumbers).toEqual(['4', '5']);
    await expect(withCommand(restored.app, ops, (c) => c.query('select testgmp.issue_number($1)', [KEY]))).rejects.toThrow('EBMR-CONT-012');
    const ledgerSize = (await ledger.entries()).length;
    await expect(reserveCounterBlock(restored.app, ops, ledger, KEY)).rejects.toThrow('EBMR-CONT-012');
    expect((await ledger.entries()).length).toBe(ledgerSize); // nothing written outside
  });

  it('[INV-08] without a restore event, the external anchor of the discarded history is reported as a problem', async () => {
    const result = await verifyExternalAnchors(restored.app, ledger);
    const byAnchor = (id: string) => result.filter((r) => r.anchorId === id);
    expect(byAnchor(anchorBefore.anchor_id).map((r) => r.status)).toEqual(['MATCH']);
    const after = byAnchor(anchorAfter.anchor_id);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((r) => r.status === 'PROBLEM')).toBe(true);
    expect(after.map((r) => r.problem).join('\n')).toContain(`chain ${chain} at seq 4 differs from external anchor ${anchorAfter.anchor_id}`);

    const check = await checkAgainstLedger(restored.app, ledger);
    expect(check.ok).toBe(false);
    const codes = new Set(check.findings.filter((f) => f.severity === 'ERROR').map((f) => f.code));
    expect(codes).toEqual(new Set(['ANCHOR_MISMATCH', 'COUNTER_INCARNATION_CHANGED', 'COUNTER_BEHIND_LEDGER', 'SEQUENCE_BEHIND_LEDGER']));
  });

  it('[INV-08][DI-45] a restore event needs a second, named person: the operator cannot approve it and approval is refused to anyone not named', async () => {
    await expect(recordRestoreEvent(restored.app, operator, ledger, await restoreInput([operator.personId]))).rejects.toThrow('EBMR-CONT-020');
    await expect(recordRestoreEvent(restored.app, operator, ledger, await restoreInput([]))).rejects.toThrow('EBMR-CONT-020');

    const recorded = await recordRestoreEvent(restored.app, operator, ledger, await restoreInput([approver.personId]));
    restoreEventId = recorded.restoreEventId;
    expect(recorded.discardedAnchorIds).toEqual([anchorAfter.anchor_id]);
    expect(recorded.affectedChainKeys).toContain(chain);
    const statusOf = (id: string | number | null) => recorded.comparison.find((c) => String(c.anchor_id) === id)?.status;
    expect(statusOf(anchorBefore.anchor_id)).toBe('MATCH');
    expect(statusOf(anchorAfter.anchor_id)).toBe('DISCARDABLE');

    const lost = await lostWindow(restored.app, restoreEventId);
    expect(lost.find((l) => l.chainKey === chain)).toEqual({ chainKey: chain, aggregateType: 'batch', aggregateId: batch, restoredSeq: '2', externalSeq: '4' });

    await expect(approveRestoreEvent(restored.app, operator, restoreEventId)).rejects.toThrow('EBMR-CONT-021');
    await expect(approveRestoreEvent(restored.app, bystander, restoreEventId)).rejects.toThrow('EBMR-CONT-021');
    // Recorded but not approved: the gap is still a problem.
    expect((await verifyExternalAnchors(restored.app, ledger)).filter((r) => r.anchorId === anchorAfter.anchor_id).every((r) => r.status === 'PROBLEM')).toBe(true);
    // Not approved yet, so the restore cannot be completed either.
    await expect(completeRestore(restored.app, operator, ledger, restoreEventId)).rejects.toThrow('EBMR-CONT-022');
  });

  it('[INV-08] once approved, the signed restore event covers exactly the discarded anchor', async () => {
    await approveRestoreEvent(restored.app, approver, restoreEventId);
    await expect(approveRestoreEvent(restored.app, approver, restoreEventId)).rejects.toThrow('EBMR-CONT-021');
    const status = await restored.app.query<{ status: string }>('select status from continuity.restore_event_status where id = $1', [restoreEventId]);
    expect(status.rows[0]?.status).toBe('APPROVED');
    const result = await verifyExternalAnchors(restored.app, ledger);
    expect(result.filter((r) => r.anchorId === anchorBefore.anchor_id).map((r) => r.status)).toEqual(['MATCH']);
    const after = result.filter((r) => r.anchorId === anchorAfter.anchor_id);
    expect(after.every((r) => r.status === 'COVERED' && r.restoreEventId === restoreEventId)).toBe(true);
    // The restore event itself went to the external ledger.
    expect((await ledger.entries()).some((e) => e.type === 'RESTORE_EVENT' && e.restoreEventId === restoreEventId)).toBe(true);
  });

  it('[INV-08] the application role cannot write a restore event or an approval directly', async () => {
    await expect(
      restored.app.query("insert into continuity.restore_event_approval (restore_event_id, approver_person_id, approver_account_id, approver_role_code, approved_content_hash, correlation_id) values ($1, gen_random_uuid(), gen_random_uuid(), 'QA', '\\x00', gen_random_uuid())", [restoreEventId]),
    ).rejects.toThrow(/permission denied/);
    await expect(restored.app.query('delete from continuity.restore_event')).rejects.toThrow(/permission denied/);
  });
});

describe('after the restore procedure', () => {
  it('[INV-27] no number, audit event id or anchor id issued before the restore is ever issued again', async () => {
    const bumps = await completeRestore(restored.app, operator, ledger, restoreEventId);
    const counter = bumps.find((b) => b.sequenceKey === KEY);
    expect(counter).toMatchObject({ sourceKind: 'COUNTER', valueBefore: '3', externalValue: '6', valueAfter: '6' });
    await expect(completeRestore(restored.app, operator, ledger, restoreEventId)).rejects.toThrow('EBMR-CONT-022');

    // Values 4 and 5 were issued in the lost window; the restored database continues above them.
    const next = await issue(restored);
    expect(BigInt(next)).toBeGreaterThan(5n);
    expect(lostNumbers).not.toContain(next);
    const all = await restored.app.query<{ v: string }>('select value::text as v from testgmp.issued_number where counter_key = $1 order by value', [KEY]);
    expect(all.rows.map((r) => r.v)).toEqual(['1', '2', '3', next]);

    // Audit event ids and anchor ids continue above anything the source issued.
    const newEvent = await restored.app.query<{ m: string }>('select max(id)::text as m from kernel.audit_event');
    expect(BigInt(newEvent.rows[0]?.m ?? '0')).toBeGreaterThan(sourceMaxEventId);
    const anchor = await exportAnchor(restored.app, ledger);
    expect(BigInt(anchor.anchor_id)).toBeGreaterThan(BigInt(anchorAfter.anchor_id));
  });

  it('[INV-08] new history on an affected chain verifies, later anchors match, and the start-up check passes', async () => {
    await sample(restored, '33');
    expect(await verifyChain(restored.app, chain)).toEqual([]);
    const later = await exportAnchor(restored.app, ledger);
    const result = await verifyExternalAnchors(restored.app, ledger);
    expect(result.filter((r) => r.anchorId === later.anchor_id).map((r) => r.status)).toEqual(['MATCH']);
    expect(result.filter((r) => r.status === 'PROBLEM')).toEqual([]);
    const check = await checkAgainstLedger(restored.app, ledger);
    expect(check.findings.filter((f) => f.severity === 'ERROR')).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it('[INV-08] a restore event never covers tampering with the history the restore kept', async () => {
    // A superuser rewrites seq 2 of the batch chain (history from before the backup) and recomputes its hash.
    await restored.admin.query(
      `update kernel.audit_event set payload = jsonb_set(payload, '{body,new,value}', '99'),
              hash = sha256(prev_hash || convert_to(jsonb_set(payload, '{body,new,value}', '99')::text, 'UTF8'))
        where chain_key = $1 and seq = 2`,
      [chain],
    );
    const result = await verifyExternalAnchors(restored.app, ledger);
    const problems = result.filter((r) => r.status === 'PROBLEM');
    // The anchor from before the backup saw the original seq 2: a problem the restore event does not cover.
    expect(problems.filter((p) => p.anchorId === anchorBefore.anchor_id).map((p) => p.problem)).toEqual([
      `chain ${chain} at seq 2 differs from external anchor ${anchorBefore.anchor_id}`,
    ]);
    expect(problems.every((p) => p.restoreEventId === null)).toBe(true);
    // The chain itself no longer links (seq 3, written after the restore, points at the original seq 2).
    expect((await verifyChain(restored.app, chain)).map((p) => p.problem)).toContain('prev_hash does not match the previous event');
    const check = await checkAgainstLedger(restored.app, ledger);
    expect(check.ok).toBe(false);
    expect(check.findings.map((f) => f.code)).toContain('ANCHOR_MISMATCH');
  });

  it('[INV-27] the lost window and every move past it are recorded in the audit trail', async () => {
    const { rows } = await restored.app.query<{ action: string }>("select action from kernel.audit_event where chain_key = $1 order by seq", [`restore_event:${restoreEventId}`]);
    // record (row + business entry), approval, completion (row + business entry)
    expect(rows.map((r) => r.action)).toEqual(['INSERT', 'BUSINESS', 'INSERT', 'INSERT', 'BUSINESS']);
    const bumps = await restored.app.query<{ n: string }>("select count(*)::text as n from continuity.sequence_bump where restore_event_id = $1", [restoreEventId]);
    expect(Number(bumps.rows[0]?.n)).toBeGreaterThanOrEqual(5);
  });
});
