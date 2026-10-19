/**
 * The records register from the screens (Phase 7 slice 7g-3, WP1; contract ns/validation.ts; kernel 0400 to 0440, 0720):
 * a record type defined (RECORD.TYPE_DEFINE) and approved by another person with RECORD_TYPE_APPROVED (DI-01, DI-37);
 * a legal hold placed and released with the reason (RECORD.LEGAL_HOLD); the disposal of a record whose retention has
 * ended approved with RECORD_DISPOSAL_APPROVED by a person who did not decide its retention (DI-47); a data-integrity
 * investigation opened, linked, read again and closed with DI_INVESTIGATION_CLOSED by QA, never the investigator
 * (DI-50). Each act is refused to a person without the right, by the database function it calls.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes } from '@ebmr/api-contract';
import { records, withCommand } from '@ebmr/kernel';
import { actorOfBrowser, personaIn, startSigningServer, valueOf } from '../esig/support.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { signAction } from '../support/signed-acts.ts';
import { codeIn, okOf, signAs, type Signed, signedIn } from './acts-support.ts';

let server: TestServer;
let steward: TestBrowser;
let qa: TestBrowser;
let qa2: TestBrowser;
let approver: TestBrowser;
let csv: Signed;
let admin: Signed;

const BATCH_TYPE = 'TEST_BATCH_RECORD';

beforeAll(async () => {
  server = await startSigningServer('GMP');
  [steward, qa, qa2, approver] = await Promise.all([server.asPersona('steward'), server.asPersona('qaInvestigator'), server.asPersona('qaApprover2'), server.asPersona('approver')]);
  csv = await signedIn(server, 'CSV_DI_LEAD', 'Kavya Iyer');
  admin = await signedIn(server, 'SYSTEM_ADMINISTRATOR', 'Arun Pillai');
  // A batch record type of the register, defined and approved through the routes under test (set-up).
  valueOf(await csv.browser.call(routes.validation.defineRecordType, { body: { definition: { ...definition(BATCH_TYPE), retentionKey: 'BATCH_RECORD' }, reason: 'batch record type for the test' } }));
  const approved = await signAction(server, approver, 'approver', { kind: 'RECORDS_ACT', act: 'RECORD_TYPE_APPROVE', input: { code: BATCH_TYPE, version: '1' } });
  if (!approved.ok) throw new Error(`SETUP: the batch record type was not approved: ${JSON.stringify(approved.error)}`);
}, 600_000);
afterAll(async () => {
  await server?.close();
});

const definition = (code: string) => ({
  code, title: 'Cleaning log', description: 'Cleaning of equipment between batches', officialRecord: true, dataClass: 'RAW' as const, gmpCriticality: 'HIGH' as const,
  officialMedium: 'ELECTRONIC' as const, originalAndCopies: 'Electronic original in the eBMR', storageLocation: 'eBMR database', owningModule: 'plant',
  ownerRole: 'HEAD_OF_PRODUCTION', retentionKey: 'SUPPORTING_RECORD' as const, reviewRule: 'Reviewed with the batch record', feedsAcceptanceLimit: false,
});

/** A batch record whose retention ended (manufactured 2008, expired 2010), scheduled by QA (qaInvestigator). */
async function endedBatch(): Promise<string> {
  const batch = randomUUID();
  const actor = await actorOfBrowser(server, qa, 'qaInvestigator', { reasonCode: 'TEST_SETUP', reasonText: 'retention of a test batch' });
  await withCommand(server.db.app, actor, (c) => records.createRetentionSchedule(c, 'batch', batch, BATCH_TYPE, { markets: ['IN', 'US'], manufactureDate: '2008-01-10', expiryDate: '2010-01-31' }));
  return batch;
}

describe('record types (kernel 0400)', () => {
  it('[DI-37] the CSV lead defines a record type and QA\'s MBR approver approves it with a signature of exactly that version', async () => {
    expect(codeIn(await steward.call(routes.validation.defineRecordType, { body: { definition: definition('CLEANING_LOG_T1'), reason: 'new record type' } }))).toBe('EBMR-IAM-040');
    const t = valueOf(await csv.browser.call(routes.validation.defineRecordType, { body: { definition: definition('CLEANING_LOG_T1'), reason: 'new record type' } }));
    expect(t).toMatchObject({ code: 'CLEANING_LOG_T1', version: '1', state: 'DEFINED', definedBy: 'Kavya Iyer' });
    const act = { kind: 'RECORDS_ACT' as const, act: 'RECORD_TYPE_APPROVE' as const, input: { code: 'CLEANING_LOG_T1', version: '1' } };
    // The steward holds no RECORD.TYPE_APPROVE: nothing is signed.
    expect((await signAction(server, steward, 'steward', act)).ok).toBe(false);
    expect(okOf(await signAction(server, approver, 'approver', act))).toBe(true);
    const listed = valueOf(await qa.call(routes.validation.recordTypes)).recordTypes.find((x) => x.code === 'CLEANING_LOG_T1');
    expect(listed).toMatchObject({ state: 'APPROVED' });
    const { rows } = await server.db.admin.query<{ meaning_code: string }>("select meaning_code from esig.signature where aggregate_type = 'record_type_version' and aggregate_id = 'CLEANING_LOG_T1:1'");
    expect(rows).toEqual([{ meaning_code: 'RECORD_TYPE_APPROVED' }]);
  });

  it('the author of a record type version does not approve it; an act carrying another act\'s members is refused before anything is read', async () => {
    valueOf(await approver.call(routes.validation.defineRecordType, { body: { definition: definition('CLEANING_LOG_T2'), reason: 'own type' } }));
    expect((await signAction(server, approver, 'approver', { kind: 'RECORDS_ACT', act: 'RECORD_TYPE_APPROVE', input: { code: 'CLEANING_LOG_T2', version: '1' } })).ok).toBe(false);
    expect(valueOf(await qa.call(routes.validation.recordTypes)).recordTypes.find((x) => x.code === 'CLEANING_LOG_T2')).toMatchObject({ state: 'DEFINED' });
    const d = await approver.call(routes.esig.describe, { body: { action: { kind: 'RECORDS_ACT', act: 'RECORD_TYPE_APPROVE', input: { code: 'CLEANING_LOG_T2', version: '1', reason: 'not a member of this act' } } } });
    expect(d.ok).toBe(true);
    const signed = await signAction(server, approver, 'approver', { kind: 'RECORDS_ACT', act: 'RECORD_TYPE_APPROVE', input: { code: 'CLEANING_LOG_T2', version: '1', reason: 'not a member of this act' } });
    expect(signed.ok).toBe(false);
  });

  it('[DI-18] the system administrator does not define record types (administrators are independent of GMP records)', async () => {
    const r = await admin.browser.call(routes.validation.defineRecordType, { body: { definition: definition('CLEANING_LOG_T3'), reason: 'admin try' } });
    expect(r.ok).toBe(false);
    expect(valueOf(await qa.call(routes.validation.recordTypes)).recordTypes.find((x) => x.code === 'CLEANING_LOG_T3')).toBeUndefined();
  });
});

describe('legal holds and disposal (kernel 0420, 0440)', () => {
  it('[DI-47] QA places a legal hold with the reason; the record is not disposable while it holds; the release needs a reason; without the right nothing is placed', async () => {
    const batch = await endedBatch();
    expect(codeIn(await steward.call(routes.validation.placeLegalHold, { body: { aggregateType: 'batch', aggregateId: batch, reason: 'litigation hold' } }))).toBe('EBMR-IAM-040');
    const hold = valueOf(await qa.call(routes.validation.placeLegalHold, { body: { aggregateType: 'batch', aggregateId: batch, reason: 'litigation hold', reference: 'CASE-7' } }));
    expect(hold).toMatchObject({ recordKey: `batch:${batch}`, kind: 'LEGAL', reason: 'litigation hold', reference: 'CASE-7' });
    const r = valueOf(await qa.call(routes.validation.retention, { query: { aggregateType: 'batch', aggregateId: batch } }));
    expect(r).toMatchObject({ scheduled: true, onHold: true, retainUntil: expect.any(String) as unknown });
    expect(r.refusals.length).toBeGreaterThan(0);
    // While the hold is in force the disposal is refused; nothing is signed.
    expect((await signAction(server, qa2, 'qaApprover2', { kind: 'RECORDS_ACT', act: 'DISPOSAL_APPROVE', input: { recordKey: `batch:${batch}`, reason: 'retention ended long ago' } })).ok).toBe(false);
    expect(codeIn(await steward.call(routes.validation.releaseLegalHold, { params: { holdId: hold.holdId }, body: { reason: 'case closed' } }))).toBe('EBMR-IAM-040');
    const after = valueOf(await qa.call(routes.validation.releaseLegalHold, { params: { holdId: hold.holdId }, body: { reason: 'case closed' } }));
    expect(after.holds.map((h) => h.holdId)).not.toContain(hold.holdId);
  });

  it('[DI-47][DI-37] the disposal of a record whose retention ended is approved by another QA person with a signature of the record at its retain-until date, and the reason', async () => {
    const batch = await endedBatch();
    const key = `batch:${batch}`;
    const look = valueOf(await qa.call(routes.validation.retention, { query: { aggregateType: 'batch', aggregateId: batch } }));
    expect(look).toMatchObject({ scheduled: true, onHold: false, retainUntil: expect.any(String) as unknown });
    // The steward holds no RECORD.DISPOSAL_APPROVE.
    expect((await signAction(server, steward, 'steward', { kind: 'RECORDS_ACT', act: 'DISPOSAL_APPROVE', input: { recordKey: key, reason: 'retention ended long ago' } })).ok).toBe(false);
    // The QA person who entered the record's retention inputs does not approve its disposal.
    expect((await signAction(server, qa, 'qaInvestigator', { kind: 'RECORDS_ACT', act: 'DISPOSAL_APPROVE', input: { recordKey: key, reason: 'retention ended long ago' } })).ok).toBe(false);
    const signed = await signAction(server, qa2, 'qaApprover2', { kind: 'RECORDS_ACT', act: 'DISPOSAL_APPROVE', input: { recordKey: key, reason: 'retention ended long ago' } });
    expect(signed.ok, JSON.stringify(signed.ok ? null : signed.error)).toBe(true);
    const { rows } = await server.db.admin.query<{ reason: string; retain_until: string; signer: string }>(
      `select a.reason, a.retain_until::text, s.signer_person::text as signer from records.purge_approval a join esig.signature s on s.id = a.approval_signature_id where a.record_key = $1`, [key]);
    expect(rows).toEqual([{ reason: 'retention ended long ago', retain_until: look.retainUntil, signer: personaIn(server, 'qaApprover2').personId }]);
  });
});

describe('data-integrity investigations (kernel 0430)', () => {
  it('[DI-37][DI-50] the CSV lead opens an investigation, links a record and reads the scope again; QA closes it with a signature, never the investigator; the person investigated reads none', async () => {
    const subject = personaIn(server, 'operator1').personId;
    const body = { subjectPersonId: subject, windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-01-02T00:00:00Z', concern: 'Entries outside the shift pattern' };
    expect(codeIn(await steward.call(routes.validation.openDiInvestigation, { body }))).toBe('EBMR-IAM-040');
    const opened = valueOf(await csv.browser.call(routes.validation.openDiInvestigation, { body }));
    expect(opened).toMatchObject({ status: 'OPEN', investigator: 'Kavya Iyer', openedBy: 'Kavya Iyer', concern: 'Entries outside the shift pattern' });
    const batch = await endedBatch();
    expect(codeIn(await steward.call(routes.validation.linkDiInvestigation, { params: { investigationId: opened.investigationId }, body: { aggregateType: 'batch', aggregateId: batch, note: 'same shift' } }))).toBe('EBMR-IAM-040');
    const linked = valueOf(await csv.browser.call(routes.validation.linkDiInvestigation, { params: { investigationId: opened.investigationId }, body: { aggregateType: 'batch', aggregateId: batch, note: 'same shift' } }));
    expect(linked.links).toContainEqual({ recordKey: `batch:${batch}`, source: 'MANUAL', note: 'same shift' });
    expect(codeIn(await steward.call(routes.validation.refreshDiInvestigationScope, { params: { investigationId: opened.investigationId } }))).toBe('EBMR-IAM-040');
    const refreshed = valueOf(await csv.browser.call(routes.validation.refreshDiInvestigationScope, { params: { investigationId: opened.investigationId } }));
    expect(refreshed.investigation.investigationId).toBe(opened.investigationId);

    const close = { kind: 'RECORDS_ACT' as const, act: 'DI_INVESTIGATION_CLOSE' as const, input: { investigationId: opened.investigationId, conclusion: 'No falsification found in the window', remediation: 'Shift pattern retrained' } };
    // The investigator holds no DI_INVESTIGATION.APPROVE_CLOSURE; the steward neither.
    expect((await signAs(server, csv, close)).ok).toBe(false);
    expect((await signAction(server, steward, 'steward', close)).ok).toBe(false);
    expect(okOf(await signAction(server, qa, 'qaInvestigator', close))).toBe(true);
    const done = valueOf(await qa.call(routes.validation.diInvestigations)).investigations.find((i) => i.investigationId === opened.investigationId);
    expect(done).toMatchObject({ status: 'CLOSED', conclusion: 'No falsification found in the window', approvedBy: 'Divya Menon' });
    // DI-50: the person investigated (an operator, no governance reader) reads no investigation.
    const subjectBrowser = await server.asPersona('operator1');
    expect(codeIn(await subjectBrowser.call(routes.validation.diInvestigations))).toBe('EBMR-TAB-020');
    // Closed: nothing more is linked.
    expect(codeIn(await csv.browser.call(routes.validation.linkDiInvestigation, { params: { investigationId: opened.investigationId }, body: { aggregateType: 'batch', aggregateId: randomUUID(), note: 'late' } }))).toBe('EBMR-REC-061');
  });

  it('the person investigated does not lead the investigation of their own records', async () => {
    const r = await csv.browser.call(routes.validation.openDiInvestigation, {
      body: { subjectPersonId: csv.person.personId, windowFrom: '2026-01-01T00:00:00Z', windowTo: '2026-01-02T00:00:00Z', concern: 'Self investigation attempt' },
    });
    expect(codeIn(r)).toBe('EBMR-REC-064');
  });
});
