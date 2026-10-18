/**
 * The signed restore event of a drill (DI-02 clause 1, IN-09 clause 3; ha-and-restore.md section 5.2): in the restored
 * copy, the system administrator records the restore event (continuity.record_restore_event, against the anchors of
 * the installation's external ledger) and a QA person approves it with their own RESTORE_APPROVED e-signature, sealed
 * with the installation's seal key.
 *
 * The drill never writes the installation's own external ledger: it works on a copy of the ledger file in the drill's
 * directory, so the restore event of a drill is not a restore event of the installation.
 *
 * The restore event is written through the owner's connection (the database superuser of the drill), as the restore
 * procedure's tools do: on a Tablets installation the application role selects no restore event (tablets 0450, F34.2),
 * so the kernel's recordRestoreEvent cannot read back the event it recorded through the application's pool. The
 * permission checks are the database's, on the people's own sessions, either way. The signature itself goes through the
 * application role, as every signature does.
 *
 * The people sign in with the credentials of a seed file (DEMO-ONLY: a demo, E2E, validation-test or drill database
 * set up with test-kit personas). On a production installation the restore event of a real restore is recorded by the
 * procedure of ha-and-restore.md section 5.2, by the people named there.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { continuity, esig, identity, withCommand, type ActorContext } from '@ebmr/kernel';
import { openDatabase, passwordActor, type DatabaseHandle, type SiteSeed } from '@ebmr/test-kit';

export interface RestoreEventRecord {
  restoreEventId: string;
  status: string;
  signatureId: string;
  approver: { legalName: string; roleCode: string };
  operator: { legalName: string; roleCode: string };
  anchorStatuses: Record<string, number>;
}

export interface RestoreEventInputs {
  /** The restored copy's database name (on the cluster of the admin URL the test-kit handle uses). */
  database: string;
  seed: SiteSeed;
  sealKey: esig.SealKeyProvider;
  /** The installation's external ledger file (copied, never written); absent: an empty drill ledger. */
  ledgerFile?: string | null;
  workDir: string;
  backup: { backupId: string; takenAt: string | null };
  changeReference: string;
}

const why = (ctx: ActorContext, text: string): ActorContext => ({ ...ctx, reasonCode: 'RESTORE_DRILL', reasonText: text, correlationId: randomUUID() });

async function dbTime(pool: pg.Pool): Promise<string> {
  return (await pool.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`)).rows[0]?.t ?? '';
}

/** The QA person of the seed who signs the approval: the first persona in a QA review role. */
function approverOf(seed: SiteSeed) {
  const p = seed.personas.find((x) => x.roleCode === 'QA_REVIEWER') ?? seed.personas.find((x) => x.roleCode.startsWith('QA_') && !x.kiosk);
  if (!p) throw new Error('the seed has no QA person to approve the restore event');
  return p;
}

export async function recordSignedRestoreEvent(o: RestoreEventInputs, adminUrl?: string): Promise<RestoreEventRecord> {
  const db: DatabaseHandle = openDatabase(o.database, 'GMP', adminUrl ? { adminUrl } : {});
  try {
    const ledgerPath = join(o.workDir, 'drill-ledger.jsonl');
    if (o.ledgerFile && existsSync(o.ledgerFile)) copyFileSync(o.ledgerFile, ledgerPath);
    const ledger = new continuity.FileLedger(ledgerPath, { database: o.seed.database });
    const b = o.seed.bootstrap;
    const operator = await passwordActor(db, b.admin, b.admin.fingerprint);
    const qa = approverOf(o.seed);
    const terminal = o.seed.terminals.find((t) => t.code === qa.homeTerminal);
    if (!terminal) throw new Error(`terminal ${qa.homeTerminal} is not in the seed`);
    const approver = await passwordActor(db, qa, terminal.fingerprint);
    const recorded = await continuity.recordRestoreEvent(db.admin, why(operator, 'restore drill'), ledger, {
      eventKind: 'FULL_RESTORE',
      backupId: o.backup.backupId,
      ...(o.backup.takenAt ? { backupTakenAt: o.backup.takenAt, restorePoint: o.backup.takenAt } : {}),
      performedAt: await dbTime(db.app),
      reason: 'Restore drill: the backup restored into an isolated instance (DI-45, DI-02, IN-09)',
      changeReference: o.changeReference,
      approverPersonIds: [qa.personId],
    });
    // QA's own RESTORE_APPROVED signature of the recorded event (DI-37), sealed with the installation's key.
    const content = await esig.contentForSigning(db.admin, 'restore_event', recorded.restoreEventId);
    const challenge = await withCommand(db.app, why(approver, 'restore drill approval'), (c) =>
      esig.createChallenge(c, { aggregateType: 'restore_event', aggregateId: recorded.restoreEventId, contentVersion: content.contentVersion ?? '1', meaning: 'RESTORE_APPROVED', clientContentHash: content.contentHash ?? '' }),
    );
    const ev = await identity.authenticate(db.authn, { method: 'PASSWORD', identifier: qa.loginName, secret: qa.password, deviceFingerprint: terminal.fingerprint, purpose: 'SIGNATURE', challengeId: challenge.challengeId });
    const signed = await withCommand(db.app, why(approver, 'restore drill approval'), (c) => esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState: 'RECORDED' }, o.sealKey));
    await continuity.approveRestoreEvent(db.admin, why(approver, 'restore drill approval'), recorded.restoreEventId, signed.signatureId);
    const status = (await db.admin.query<{ status: string }>('select status from continuity.restore_event_status where id = $1', [recorded.restoreEventId])).rows[0]?.status ?? 'UNKNOWN';
    const anchorStatuses: Record<string, number> = {};
    for (const c of recorded.comparison) anchorStatuses[c.status] = (anchorStatuses[c.status] ?? 0) + 1;
    return {
      restoreEventId: recorded.restoreEventId,
      status,
      signatureId: signed.signatureId,
      approver: { legalName: qa.legalName, roleCode: qa.roleCode },
      operator: { legalName: b.admin.legalName, roleCode: b.admin.roleCode },
      anchorStatuses,
    };
  } finally {
    await db.close();
  }
}
