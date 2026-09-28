/**
 * Review reproducer F56: protected PG_SEQUENCE sources (kernel.audit_event.id, records.incident.incident_no,
 * ...) have no issue guard after a restore. They are moved past the external ledger only by
 * continuity.after_restore (kernel 0600:742), the LAST step of the restore procedure. Every write made in
 * the restored database before that step (the runbook's step-4 data-integrity / time incident, the restore
 * event itself (record_restore_event, 0600:601), the approval e-signature challenge and signature,
 * approve_restore_event, after_restore's own first rows) draws ids from the restored sequences, i.e. ids
 * that the source already issued in the lost window.
 *
 * Flow (mirrors test/continuity/restore.test.ts):
 *   source: history on batch:<id>, anchor, backup (max audit_event.id = B, max incident_no = N);
 *           after the backup: more history on batch:<id>, a lost-window incident (incident_no N+1), anchor
 *           (max audit_event.id = S > B);
 *   restored copy: the runbook step-4 incident is opened, then record -> sign -> approve -> complete.
 *
 * Safe behaviour asserted (INV-27: no identifier issued before the restore is ever issued again):
 *   - no audit event in the restored database has an id in (B, S] (those ids belong to lost-window
 *     events of the source);
 *   - the incident opened in the restored database does not get an incident_no the source issued in the
 *     lost window (a refusal to raise an incident before completion would also be safe).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportAnchor } from '../../src/continuity/anchors.ts';
import type { BackupArtefact } from '../../src/continuity/backup-drill.ts';
import type { FileLedger } from '../../src/continuity/ledger.ts';
import { approveRestoreEvent, completeRestore, recordRestoreEvent } from '../../src/continuity/restore.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { raiseIncident } from '../../src/records/incidents.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import type { SeededActor } from '../identity/seed.ts';
import { backupTestDatabase, dbTime, ensureSealKey, restoreCopy, signerActor, signFor, tempDir, tempLedger, testActor } from '../continuity/helpers.ts';

const dir = tempDir('f56');
let source: TestDatabase;
let restored: TestDatabase;
let ledger: FileLedger;
let ops: ActorContext;
let gateway: ActorContext;
let operator: ActorContext;
let approver: SeededActor;
const batch = randomUUID();
let backup: BackupArtefact;
let backupMaxEventId: bigint;
let sourceMaxEventId: bigint;
let sourceLostEvents: Map<string, string>; // id -> chain_key, events the source wrote after the backup
let sourceLostIncidentNos: string[];
let restoredIncidentId: string | null = null;
let restoredIncidentError: string | null = null;
let restoreEventId: string;

function fresh(ctx: ActorContext): ActorContext {
  return { ...ctx, correlationId: randomUUID() };
}
async function sample(db: TestDatabase, value: string): Promise<void> {
  await withCommand(db.app, fresh(ops), (c) => c.query('insert into testgmp.sample (batch_id, value) values ($1, $2)', [batch, value]));
}
async function maxEventId(db: TestDatabase): Promise<bigint> {
  return BigInt((await db.app.query<{ m: string | null }>('select max(id)::text as m from kernel.audit_event')).rows[0]?.m ?? '0');
}
async function timeIncident(db: TestDatabase, title: string): Promise<string> {
  return withCommand(db.app, fresh(gateway), (c) =>
    raiseIncident(c, { source: 'TIME_SYNC', type: 'CLOCK_DRIFT', severity: 'MAJOR', title, description: 'clock offset check' }),
  );
}

beforeAll(async () => {
  source = await createTestDatabase();
  ledger = tempLedger('f56-source', dir.path);
  ops = await testActor(source, { roleCode: 'SERVICE_ACCOUNT', source: 'SYSTEM' });
  gateway = await testActor(source, { source: 'SYSTEM', roleCode: 'SYSTEM', legalName: 'site gateway (time monitor)' });
  operator = await testActor(source, { roleCode: 'SYSTEM_ADMINISTRATOR', legalName: 'Restore Operator' });
  approver = await signerActor(source, 'QA_REVIEWER', 'QA Approver');
  await ensureSealKey(source);

  // History before the backup.
  await sample(source, '1');
  await sample(source, '2');
  await timeIncident(source, 'pre-backup drift');
  await exportAnchor(source.app, ledger);
  backupMaxEventId = await maxEventId(source);
  backup = await backupTestDatabase(source, dir.path);

  // The lost window: history and an incident the source issues after the backup.
  await sample(source, '3');
  await sample(source, '4');
  await sample(source, '5');
  const lostIncident = await timeIncident(source, 'lost-window incident (quoted in a CAPA / CERT-In report)');
  sourceLostIncidentNos = (
    await source.app.query<{ n: string }>('select incident_no::text as n from records.incident where id = $1', [lostIncident])
  ).rows.map((r) => r.n);
  await exportAnchor(source.app, ledger);
  sourceMaxEventId = await maxEventId(source);
  const lost = await source.app.query<{ id: string; chain_key: string }>(
    'select id::text as id, chain_key from kernel.audit_event where id > $1 order by id',
    [backupMaxEventId.toString()],
  );
  sourceLostEvents = new Map(lost.rows.map((r) => [r.id, r.chain_key]));

  // The disaster: the backup is restored into a new database.
  restored = await restoreCopy(source, backup, dir.path);

  // Runbook 5.2 step 4 / 5.4 step 3: the clock offset check fails and a data-integrity incident is opened
  // in the restored database, before the restore event is recorded.
  try {
    restoredIncidentId = await timeIncident(restored, 'clock offset above threshold after restore');
  } catch (error) {
    restoredIncidentError = error instanceof Error ? error.message : String(error);
  }

  // Runbook steps 6-8: record, approve (signed), complete.
  const recorded = await recordRestoreEvent(restored.app, fresh(operator), ledger, {
    eventKind: 'FULL_RESTORE',
    backupId: backup.backupId,
    backupTakenAt: backup.snapshotTakenAt,
    restorePoint: backup.snapshotTakenAt,
    performedAt: await dbTime(restored),
    reason: 'Primary storage failure; restored from the last good backup',
    changeReference: 'INC-2026-0056',
    approverPersonIds: [approver.personId],
  });
  restoreEventId = recorded.restoreEventId;
  const signature = await signFor(restored, approver, { type: 'restore_event', id: restoreEventId }, 'RESTORE_APPROVED', 'RECORDED', { registerKey: false });
  await approveRestoreEvent(restored.app, fresh(approver), restoreEventId, signature);
  await completeRestore(restored.app, fresh(operator), ledger, restoreEventId);
}, 120_000);

afterAll(async () => {
  await restored?.drop();
  await source?.drop();
  dir.cleanup();
});

describe('F56: protected PG_SEQUENCE ids written before after_restore', () => {
  it('sanity: the source really issued audit event ids and an incident number after the backup', () => {
    expect(sourceMaxEventId).toBeGreaterThan(backupMaxEventId);
    expect(sourceLostEvents.size).toBeGreaterThan(0);
    expect([...sourceLostEvents.values()]).toContain(`batch:${batch}`);
    expect(sourceLostIncidentNos).toHaveLength(1);
  });

  it('[INV-27] no audit event id the source issued in the lost window is issued again in the restored database', async () => {
    const { rows } = await restored.app.query<{ id: string; chain_key: string; action: string }>(
      'select id::text as id, chain_key, action from kernel.audit_event where id > $1 and id <= $2 order by id',
      [backupMaxEventId.toString(), sourceMaxEventId.toString()],
    );
    const reused = rows.map((r) => `id ${r.id}: restored ${r.chain_key} (${r.action}) / source ${sourceLostEvents.get(r.id) ?? '?'}`);
    expect(reused, `audit event ids reissued after the restore:\n${reused.join('\n')}`).toEqual([]);
  });

  it('[INV-27] an incident opened in the restored database never reuses a lost-window incident number', async () => {
    if (restoredIncidentId === null) {
      // Refusing to raise an incident before the restore is completed is safe, but only as a deliberate refusal.
      expect(restoredIncidentError).toMatch(/EBMR-/);
      return;
    }
    const { rows } = await restored.app.query<{ n: string; reference: string }>(
      'select incident_no::text as n, reference from records.incident_current where id = $1',
      [restoredIncidentId],
    );
    const no = rows[0]?.n ?? '';
    expect(no).not.toBe('');
    expect(sourceLostIncidentNos, `restored incident ${rows[0]?.reference} reuses a lost-window incident number`).not.toContain(no);
  });
});
