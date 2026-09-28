/**
 * Review reproducer F59: INV-27 says user IDs are never reused "including after a restore". The restore
 * procedure (continuity.after_restore, packages/kernel/sql/0600_continuity_core.sql:742) only moves
 * numeric PG sequences and protected counters past the external ledger's high-water marks. Login names
 * live only in iam.issued_identifier / iam.account (0110_iam_persons_accounts.sql); they are not written
 * to the external ledger, so a login name issued in a restore's lost window is unknown to the restored
 * database and iam.create_account (0110:340) issues it again, to another person.
 *
 * Scenario:
 *   1. Persons A and B exist (identity verified); an anchor is exported; the database is backed up.
 *   2. After the backup, an administrator creates account 'asharma' for person A; an anchor is exported
 *      (so the external ledger holds the account's chain).
 *   3. Disaster: the backup is restored into a new database; the full restore procedure runs (recorded,
 *      approved with the approver's RESTORE_APPROVED signature, completed).
 *   4. The administrator creates account 'asharma' for person B in the restored database.
 *
 * Safe behaviour asserted: step 4 is refused (the user ID was issued before the restore and must never be
 * issued again). Control: in the same restored database, the same administrator can create an account for
 * a third person under a fresh login name, and person B has no account there, so a refusal in step 4 is
 * about the name and nothing else.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportAnchor } from '../../src/continuity/anchors.ts';
import type { BackupArtefact } from '../../src/continuity/backup-drill.ts';
import type { FileLedger } from '../../src/continuity/ledger.ts';
import { approveRestoreEvent, completeRestore, lostWindow, recordRestoreEvent } from '../../src/continuity/restore.ts';
import { withCommand, type ActorContext } from '../../src/db/command.ts';
import { createAccount, createPerson, recordIdentityVerification } from '../../src/identity/admin.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { seedAdministration, withReason, type SeededActor } from '../identity/seed.ts';
import { backupTestDatabase, dbTime, ensureSealKey, restoreCopy, signerActor, signFor, tempDir, tempLedger, testActor } from '../continuity/helpers.ts';

const dir = tempDir('f59');
const LOGIN = 'asharma';
let source: TestDatabase;
let restored: TestDatabase;
let ledger: FileLedger;
let admin: SeededActor;
let operator: ActorContext;
let approver: SeededActor;
let personA: string;
let personB: string;
let personC: string;
let accountA: string;
let backup: BackupArtefact;
let restoreEventId: string;

async function verifiedPerson(db: TestDatabase, legalName: string): Promise<string> {
  return withCommand(db.app, withReason(admin), async (c) => {
    const personId = await createPerson(c, 'NATURAL', legalName);
    await recordIdentityVerification(c, {
      personId, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'Employee ID card',
      evidenceRef: `HR-${randomBytes(4).toString('hex')}`, occurredAt: new Date(Date.UTC(2026, 0, 5)).toISOString(),
    });
    return personId;
  });
}

function newAccount(db: TestDatabase, personId: string, loginName: string): Promise<string> {
  return withCommand(db.app, withReason(admin), (c) => createAccount(c, { personId, loginName, kind: 'HUMAN' }));
}

beforeAll(async () => {
  source = await createTestDatabase();
  ledger = tempLedger('f59-source', dir.path);
  admin = (await seedAdministration(source)).admin;
  operator = await testActor(source, { roleCode: 'SYSTEM_ADMINISTRATOR', legalName: 'Restore Operator' });
  approver = await signerActor(source, 'QA_REVIEWER', 'QA Approver');
  await ensureSealKey(source);

  // 1. Before the backup: persons A and B, identity verified, no account with the login name yet.
  personA = await verifiedPerson(source, 'Anil Sharma');
  personB = await verifiedPerson(source, 'Asha Sharma');
  personC = await verifiedPerson(source, 'Control Person');
  await exportAnchor(source.app, ledger);
  backup = await backupTestDatabase(source, dir.path);

  // 2. In the window that the restore will lose: 'asharma' is issued to person A (10:05).
  accountA = await newAccount(source, personA, LOGIN);
  await exportAnchor(source.app, ledger);

  // 3. Disaster at the site: the backup (10:00) is restored and the full restore procedure runs.
  restored = await restoreCopy(source, backup, dir.path);
  const recorded = await recordRestoreEvent(restored.app, operator, ledger, {
    eventKind: 'FULL_RESTORE',
    backupId: backup.backupId,
    backupTakenAt: backup.snapshotTakenAt,
    restorePoint: backup.snapshotTakenAt,
    performedAt: await dbTime(restored),
    reason: 'Primary storage failure; restored from the last good backup',
    changeReference: 'INC-2026-0059',
    approverPersonIds: [approver.personId],
  });
  restoreEventId = recorded.restoreEventId;
  const signature = await signFor(restored, approver, { type: 'restore_event', id: restoreEventId }, 'RESTORE_APPROVED', 'RECORDED', { registerKey: false });
  await approveRestoreEvent(restored.app, approver, restoreEventId, signature);
  await completeRestore(restored.app, operator, ledger, restoreEventId);
}, 120_000);

afterAll(async () => {
  await restored?.drop();
  await source?.drop();
  dir.cleanup();
});

describe('F59: login names issued in a restore lost window', () => {
  it('precondition: the name was issued to person A in the source after the backup, and the restore procedure completed', async () => {
    const src = await source.app.query<{ person_id: string }>('select person_id::text from iam.account where login_name = $1', [LOGIN]);
    expect(src.rows.map((r) => r.person_id)).toEqual([personA]);
    const status = await restored.app.query<{ status: string }>('select status from continuity.restore_event_status where id = $1', [restoreEventId]);
    expect(status.rows[0]?.status).toBe('COMPLETED');
    // The lost window names the account's chain (a uuid), not its login name.
    const lost = await lostWindow(restored.app, restoreEventId);
    expect(lost.map((l) => l.chainKey)).toContain(`account:${accountA}`);
  });

  it('control: the administrator can create accounts in the restored database (fresh name, another person)', async () => {
    const fresh = `csharma-${randomBytes(3).toString('hex')}`;
    const id = await newAccount(restored, personC, fresh);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // Person B has no account in the restored database, so nothing but the name can refuse the next step.
    const b = await restored.app.query('select 1 from iam.account where person_id = $1', [personB]);
    expect(b.rowCount).toBe(0);
  });

  it('[INV-27][DI-15] a login name issued before the restore (in the lost window) is never issued again, to anyone', async () => {
    let issuedTo: string | undefined;
    let refusal: unknown;
    try {
      await newAccount(restored, personB, LOGIN);
      const r = await restored.app.query<{ person_id: string }>('select person_id::text from iam.account where login_name = $1', [LOGIN]);
      issuedTo = r.rows[0]?.person_id;
    } catch (error) {
      refusal = error;
    }
    expect(issuedTo, `user ID '${LOGIN}' (issued to person ${personA} before the restore) was issued again to person ${issuedTo} after the restore`).toBeUndefined();
    expect(String(refusal)).toMatch(/EBMR-/);
  });
});
