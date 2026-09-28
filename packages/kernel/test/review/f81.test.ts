/**
 * Review reproducer F81: INV-27 says user IDs (login names) are never reused, including after a
 * restore. The only record of issued login names is iam.issued_identifier (0110), which lives in the
 * database. After a restore from a backup taken before a login name was issued, the name is gone
 * from the register; continuity.after_restore (0600) moves sequences and counters past the external
 * ledger's high-water marks but nothing brings back issued identifiers, so iam.create_account lets
 * an administrator issue the same login name to a different person.
 *
 * Scenario (the restore procedure is followed exactly as in continuity/restore.test.ts):
 *   T0  backup of the source database (persons X and Y exist, both identity-verified).
 *   T1  administrator creates and activates account <jdoe> for person X; an anchor is exported to
 *       the external ledger afterwards (normal periodic anchoring).
 *   --  disaster: the T0 backup is restored into a new database.
 *   --  restore event recorded by an operator, approved (signed) by a second person, completed.
 *   T2  administrator creates an account for person Y with login name <jdoe>.
 *
 * Safe behaviour asserted: T2 is refused (EBMR-IAM-021, the login name was issued before and is never
 * issued again). With the defect, T2 succeeds and <jdoe> now denotes person Y.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportAnchor } from '../../src/continuity/anchors.ts';
import type { BackupArtefact } from '../../src/continuity/backup-drill.ts';
import type { FileLedger } from '../../src/continuity/ledger.ts';
import { approveRestoreEvent, completeRestore, recordRestoreEvent } from '../../src/continuity/restore.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { activateAccount, createAccount, createPerson, recordIdentityVerification } from '../../src/identity/admin.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seedAdministration, withReason, type SeedAdministration, type SeededActor } from '../identity/seed.ts';
import { backupTestDatabase, dbTime, ensureSealKey, restoreCopy, signerActor, signFor, tempDir, tempLedger, testActor } from '../continuity/helpers.ts';

const dir = tempDir('f81');
let source: TestDatabase;
let restored: TestDatabase;
let ledger: FileLedger;
let adm: SeedAdministration;
let operator: ActorContext;
let approver: SeededActor;
let backup: BackupArtefact;
let personX: string;
let personY: string;
let accountX: string;
const jdoe = `jdoe-${randomBytes(4).toString('hex')}`;

const asAdmin = <T>(db: TestDatabase, work: Parameters<typeof withCommand<T>>[2]) => withCommand(db.app, withReason(adm.admin), work);

async function newVerifiedPerson(db: TestDatabase, name: string): Promise<string> {
  return asAdmin(db, async (c) => {
    const p = await createPerson(c, 'NATURAL', name, `EMP-${randomUUID()}`);
    await recordIdentityVerification(c, {
      personId: p,
      purpose: 'INITIAL',
      method: 'IN_PERSON_DOCUMENT',
      documentType: 'Passport',
      evidenceRef: `HR-${randomUUID()}`,
      occurredAt: '2026-01-05T09:00:00Z',
    });
    return p;
  });
}

beforeAll(async () => {
  source = await createTestDatabase();
  ledger = tempLedger('f81-source', dir.path);
  adm = await seedAdministration(source);
  operator = await testActor(source, { roleCode: 'SYSTEM_ADMINISTRATOR', legalName: 'Restore Operator' });
  approver = await signerActor(source, 'QA_REVIEWER', 'QA Approver');
  await ensureSealKey(source);

  personX = await newVerifiedPerson(source, 'Person X');
  personY = await newVerifiedPerson(source, 'Person Y');
  await exportAnchor(source.app, ledger);

  // T0: the backup.
  backup = await backupTestDatabase(source, dir.path);

  // T1: after the backup, login name jdoe is issued to person X (and anchored externally).
  accountX = await asAdmin(source, async (c) => {
    const a = await createAccount(c, { personId: personX, loginName: jdoe, kind: 'HUMAN' });
    await activateAccount(c, a);
    return a;
  });
  await exportAnchor(source.app, ledger);

  // The disaster: the T0 backup is restored into a new database.
  restored = await restoreCopy(source, backup, dir.path);
}, 120_000);

afterAll(async () => {
  await restored?.drop();
  await source?.drop();
  dir.cleanup();
});

describe('F81: login names after a restore (INV-27 user-ID part)', () => {
  it('[INV-27] a login name issued in the lost window is not issued to another person after the restore procedure', async () => {
    // Preconditions: in the source, jdoe denotes person X; the restored copy predates it.
    const src = await source.app.query<{ person_id: string }>('select person_id from iam.account where login_name = $1', [jdoe]);
    expect(src.rows.map((r) => r.person_id)).toEqual([personX]);
    const reg = await source.app.query<{ account_id: string }>('select account_id from iam.issued_identifier where identifier = $1', [jdoe]);
    expect(reg.rows.map((r) => r.account_id)).toEqual([accountX]);
    // Positive control: without a restore, reusing jdoe for person Y is refused.
    await expect(asAdmin(source, (c) => createAccount(c, { personId: personY, loginName: jdoe, kind: 'HUMAN' }))).rejects.toThrow('EBMR-IAM-021');

    // The full restore procedure: recorded by the operator, approved (signed) by a second person, completed.
    const recorded = await recordRestoreEvent(restored.app, operator, ledger, {
      eventKind: 'FULL_RESTORE',
      backupId: backup.backupId,
      backupTakenAt: backup.snapshotTakenAt,
      restorePoint: backup.snapshotTakenAt,
      performedAt: await dbTime(restored),
      reason: 'Primary storage failure; restored from the last good backup',
      changeReference: 'INC-2026-0081',
      approverPersonIds: [approver.personId],
    });
    const signature = await signFor(restored, approver, { type: 'restore_event', id: recorded.restoreEventId }, 'RESTORE_APPROVED', 'RECORDED', { registerKey: false });
    await approveRestoreEvent(restored.app, approver, recorded.restoreEventId, signature);
    await completeRestore(restored.app, operator, ledger, recorded.restoreEventId);
    const status = await restored.app.query<{ status: string }>('select status from continuity.restore_event_status where id = $1', [recorded.restoreEventId]);
    expect(status.rows[0]?.status).toBe('COMPLETED');

    // T2: an administrator issues login name jdoe to person Y. INV-27: it must be refused.
    const reuse = asAdmin(restored, (c) => createAccount(c, { personId: personY, loginName: jdoe, kind: 'HUMAN' }));
    await expect(reuse).rejects.toThrow('EBMR-IAM-021');

    const now = await restored.app.query<{ person_id: string }>('select person_id from iam.account where login_name = $1', [jdoe]);
    expect(now.rows.map((r) => r.person_id)).not.toContain(personY);
  });
});
