/**
 * The restore procedure and the continuity alarms from the operations screens (Phase 7 slice 7g, work package 2; kernel
 * 0600, 0720; tablets 1525; features/operations restore.ts):
 *  - in a database that is a copy of a bound one (its incarnation is not the bound one, so its audit trail is closed), the
 *    system administrator secures the identifiers from the server's external ledger; a QA person may not;
 *  - the administrator records the restore naming the approvers (never themself); a QA person may not record it;
 *  - only a named approver approves it, with their own RESTORE_APPROVED signature: never the administrator (DI-18), never
 *    a QA person who was not named; then the administrator completes it, the moves are recorded and the event and its
 *    completion are copied to the external ledger;
 *  - without the external ledger nothing runs and the screen says why;
 *  - a continuity alarm is acknowledged once, with a comment, by a person who acknowledges alarms.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { refusalOf, startSigningServer, valueOf } from '../esig/support.ts';
import { grantedPerson, loginOf } from '../support/granted-person.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';
import { asSetup } from '../blocks/compression/plant-support.ts';

const O = routes.operations;
let server: TestServer;
let ledgerFile: string;
let admin: TestBrowser;
let adminLogin: { loginName: string; password: string };
let owner: TestBrowser;
let qa: TestBrowser;
let qa2: TestBrowser;
const servers: TestServer[] = [];

beforeAll(async () => {
  ledgerFile = join(mkdtempSync(join(tmpdir(), 'ebmr-restore-')), 'ledger.jsonl');
  server = await startSigningServer('GMP', { stub: false, env: { EBMR_NUMBER_LEDGER_FILE: ledgerFile } });
  servers.push(server);
  const a = await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'Ira Admin');
  adminLogin = { loginName: a.loginName, password: a.password };
  admin = await loginOf(server, a);
  owner = await loginOf(server, await grantedPerson(server, 'PROCESS_OWNER', 'Omar Owner'));
  qa = await server.asPersona('qaInvestigator');
  qa2 = await server.asPersona('qaApprover2');
}, 300_000);
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

const personId = (key: string) => server.seed.personas.find((p) => p.key === key)?.personId ?? '';

describe('the restore procedure (DI-45)', () => {
  it('[DI-45][DI-17] in a copy of a bound database the administrator secures the identifiers from the external ledger before anything else; a QA person may not', async () => {
    // The database was bound to the ledger as another incarnation: this one is a copy whose audit trail is closed (INV-27).
    await server.db.admin.query("insert into continuity.database_incarnation (incarnation, bound_by) values ('original:of:this:copy', 'ANCHOR_EXPORT')");
    const before = valueOf(await admin.call(O.restore));
    expect(before).toMatchObject({ configured: true, problem: null, identifiersSecured: false, events: [] });
    expect(before.approverCandidates.map((c) => c.personId)).toEqual(expect.arrayContaining([personId('qaInvestigator'), personId('qaApprover2')]));
    expect(refusalOf(await qa.call(O.secureIdentifiers, { body: { reason: 'try' } })).code).toBe('EBMR-IAM-040');
    const secured = valueOf(await admin.call(O.secureIdentifiers, { body: { reason: 'restored from the nightly backup' } }));
    expect(secured.moves.length).toBeGreaterThan(0);
    for (const m of secured.moves) expect(BigInt(m.valueAfter) >= BigInt(m.valueBefore)).toBe(true);
    expect(valueOf(await admin.call(O.restore)).identifiersSecured).toBe(true);
    // An operator neither operates nor approves a restore: the procedure is not read in that role.
    const operator = await server.asPersona('operator1');
    expect(refusalOf(await operator.call(O.restore)).code).toBe('EBMR-OPS-050');
  }, 120_000);

  it('[DI-45][DI-18][DI-37] the administrator records the restore naming a QA approver, never themself; only the named approver approves it with their own signature, never the administrator; then the administrator completes it and the ledger holds both', async () => {
    const event = {
      eventKind: 'FULL_RESTORE' as const,
      backupId: 'nightly-2026-10-18',
      backupTakenAt: '2026-10-18T00:30:00Z',
      performedAt: '2026-10-18T06:00:00Z',
      reason: 'database server disk failure',
      changeReference: 'INC-2026-0042',
    };
    const me = valueOf(await admin.call(routes.session.get)).person.personId;
    expect(refusalOf(await admin.call(O.recordRestoreEvent, { body: { ...event, approverPersonIds: [me] } })).code).toBe('EBMR-CONT-020');
    expect(refusalOf(await qa.call(O.recordRestoreEvent, { body: { ...event, approverPersonIds: [personId('qaApprover2')] } })).code).toBe('EBMR-IAM-040');
    const recorded = valueOf(await admin.call(O.recordRestoreEvent, { body: { ...event, approverPersonIds: [personId('qaInvestigator')] } }));
    expect(recorded).toMatchObject({ status: 'RECORDED', eventKind: 'FULL_RESTORE', backupId: 'nightly-2026-10-18', operator: 'Ira Admin', changeReference: 'INC-2026-0042' });
    expect(recorded.approvers).toEqual([expect.objectContaining({ personId: personId('qaInvestigator'), approvedAt: null })]);
    expect(recorded.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // Completing before the approval is refused.
    expect(refusalOf(await admin.call(O.completeRestore, { params: { restoreEventId: recorded.restoreEventId }, body: { reason: 'too early' } })).code).toBe('EBMR-CONT-022');

    const action = { kind: 'RESTORE_APPROVE' as const, restoreEventId: recorded.restoreEventId };
    // DI-18: the administrator approves no GMP act; a QA person who was not named may not approve it either.
    expect((await signAction(server, admin, 'none', action, { credentials: { kind: 'PASSWORD', ...adminLogin } })).ok).toBe(false);
    const other = await signAction(server, qa2, 'qaApprover2', action);
    expect(other.ok).toBe(false);
    expect(JSON.stringify(other.ok ? null : other.error)).toContain('EBMR-CONT-021');
    valueOf(await signAction(server, qa, 'qaInvestigator', action));
    const approved = valueOf(await qa.call(O.restore)).events[0];
    expect(approved).toMatchObject({ restoreEventId: recorded.restoreEventId, status: 'APPROVED' });
    expect(approved?.approvers[0]?.approvedAt).not.toBeNull();

    expect(refusalOf(await qa.call(O.completeRestore, { params: { restoreEventId: recorded.restoreEventId }, body: { reason: 'try' } })).code).toBe('EBMR-IAM-040');
    const done = valueOf(await admin.call(O.completeRestore, { params: { restoreEventId: recorded.restoreEventId }, body: { reason: 'approved; resume work' } }));
    expect(done.event).toMatchObject({ status: 'COMPLETED' });
    expect(done.event.completedAt).not.toBeNull();
    expect(done.event.moves.length).toBe(done.moves.length);
    const ledger = readFileSync(ledgerFile, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { entry: { type: string; restoreEventId?: string } }).entry);
    expect(ledger.filter((e) => e.restoreEventId === recorded.restoreEventId).map((e) => e.type)).toEqual(['RESTORE_EVENT', 'RESTORE_COMPLETED']);
  }, 180_000);

  it('[DI-45] a server without the external ledger runs none of the procedure and says why', async () => {
    const plain = await startServer('GMP');
    servers.push(plain);
    const a = await loginOf(plain, await grantedPerson(plain, 'SYSTEM_ADMINISTRATOR', 'Ivo Admin'));
    expect(valueOf(await a.call(O.restore))).toMatchObject({ configured: false, problem: expect.stringMatching(/EBMR_NUMBER_LEDGER_FILE/) as string });
    expect(refusalOf(await a.call(O.secureIdentifiers, { body: { reason: 'try' } }))).toMatchObject({ status: 503, code: 'RESTORE_NOT_CONFIGURED' });
  }, 120_000);
});

describe('continuity alarms (DI-45)', () => {
  it('[DI-45][DI-17] a continuity alarm is read by the administration and QA roles and acknowledged once, with a comment, by a person who acknowledges alarms; QA may not acknowledge it', async () => {
    const id = randomUUID();
    // A fixture, not a proof: the alarm a failed backup job raises (written as the owner, triggers off).
    await asSetup(
      server,
      "insert into continuity.alarm (id, alarm_code, severity, subject, details, correlation_id) values ($1, 'BACKUP_JOB_FAILED', 'HIGH', 'Backup job nightly failed', '{\"job\": \"nightly\"}'::jsonb, gen_random_uuid())",
      [id],
    );
    const listed = valueOf(await qa.call(O.alarms)).alarms.find((a) => a.alarmId === id);
    expect(listed).toMatchObject({ code: 'BACKUP_JOB_FAILED', severity: 'HIGH', acknowledgement: null });
    expect(JSON.parse(listed?.details ?? '{}')).toEqual({ job: 'nightly' });
    const operator = await server.asPersona('operator1');
    expect(refusalOf(await operator.call(O.alarms)).code).toBe('ROLE_NOT_ALLOWED');
    expect(refusalOf(await qa.call(O.acknowledgeAlarm, { params: { alarmId: id }, body: { comment: 'seen' } })).code).toBe('EBMR-IAM-040');
    const acked = valueOf(await owner.call(O.acknowledgeAlarm, { params: { alarmId: id }, body: { comment: 'disk full on the backup host; cleared and re-run' } }));
    expect(acked.acknowledgement).toMatchObject({ by: 'Omar Owner', comment: 'disk full on the backup host; cleared and re-run' });
    expect(refusalOf(await admin.call(O.acknowledgeAlarm, { params: { alarmId: id }, body: { comment: 'again' } })).code).toBe('EBMR-CONT-032');
  }, 120_000);
});
