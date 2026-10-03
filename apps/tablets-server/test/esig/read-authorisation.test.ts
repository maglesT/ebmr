/**
 * Review F34 (DI-17, DI-50, DI-37, DI-36): GET /api/esig/content checked only that a session existed and, with no
 * signable handler for the aggregate type, served the kernel's canonical content of any registered record for any
 * meaning: a data-integrity investigation (its concern, subject, window and investigator) reached the person it
 * investigates, and an MBR checker or a master-data steward got it "to be signed" with a meaning their role may not
 * sign. GET /api/esig/signatures listed the manifestations of any record to any session. The application role could
 * also execute the kernel's content and signature readers for any record and read the investigation tables directly.
 *
 * Now the database decides (tablets 0410; default F34.1): a session reads a RECORD-class record in a role with
 * RECORD.READ, a GOVERNANCE-class record (an investigation, a disposal, a restore, any type not named) only in a
 * governance or audit role and never an investigation about itself; content is previewed only with a meaning its role
 * signs (on a shop-floor terminal the person who taps signs, and esig.sign checks that person); the kernel's provider
 * serves only the pairs this installation signs that way (in Phase 2 the DEMO-ONLY stub).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result } from '@ebmr/api-contract';
import { esig, identity, records, withCommand, type ActorContext } from '@ebmr/kernel';
import { passwordActor, personaOf, terminalOf } from '@ebmr/test-kit';
import { grantedPerson, loginOf, type GrantedPerson } from '../support/granted-person.ts';
import { tokenHash } from '../../src/platform/auth/session.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { createStub, startSigningServer } from './support.ts';

let gmp: TestServer;
let sbx: TestServer;
let investigationId = '';
let ownInvestigationId = '';
let qa: GrantedPerson;
let qaBrowser: TestBrowser;
const CONCERN = 'Suspected back-dating of granulation entries by Asha Rao (whistle-blower report WB-17)';

const reason = <T extends ActorContext>(ctx: T): T => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: 'review F34 test set-up', correlationId: randomUUID() });
const outcome = (r: Result<unknown>): string => (r.ok ? 'ok' : r.error.kind === 'REFUSAL' ? `${r.error.status}:${r.error.envelope.refusal.code}` : r.error.kind);
const leaked = (r: Result<unknown>): string => JSON.stringify(r.ok ? r.value : r.error);
const hashOf = (server: TestServer, b: TestBrowser): string => tokenHash(b.cookies.get(server.config.cookies.session) ?? '');

beforeAll(async () => {
  [gmp, sbx] = await Promise.all([startSigningServer('GMP'), startSigningServer('SANDBOX')]);
  const lead = await grantedPerson(gmp, 'CSV_DI_LEAD', 'Dev Lead (CSV/DI)');
  const leadActor = await passwordActor(gmp.db, lead, terminalOf(gmp.seed, 'PC-QA-01').fingerprint);
  qa = await grantedPerson(gmp, 'QA_REVIEWER', 'Kiran Desai (QA reviewer)');
  const window = { windowFrom: new Date(Date.UTC(2026, 0, 1)), windowTo: new Date(Date.UTC(2026, 8, 1)) };
  investigationId = await withCommand(gmp.db.app, reason(leadActor), (c) =>
    records.openDiInvestigation(c, { subjectPersonId: personaOf(gmp.seed, 'author').personId, ...window, concern: CONCERN }),
  );
  ownInvestigationId = await withCommand(gmp.db.app, reason(leadActor), (c) =>
    records.openDiInvestigation(c, { subjectPersonId: qa.personId, ...window, concern: 'Suspected sharing of the QA reviewer password' }),
  );
  qaBrowser = await loginOf(gmp, qa);
});
afterAll(async () => {
  await Promise.all([gmp?.close(), sbx?.close()]);
});

describe('F34: GET /api/esig/content and /api/esig/signatures read only what the session may read', () => {
  it('[DI-17][DI-50] the person a DI investigation investigates gets nothing of it, neither its content nor its signatures', async () => {
    const subject = await gmp.asPersona('author');
    for (const intent of ['PREPARED', 'DI_INVESTIGATION_CLOSED']) {
      const r = await subject.call(routes.esig.content, { query: { aggregateType: 'di_investigation', aggregateId: investigationId, intent } });
      expect(outcome(r), intent).toBe('403:ESIG_PREVIEW_NOT_ALLOWED');
      expect(leaked(r)).not.toContain('back-dating');
    }
    const sigs = await subject.call(routes.esig.signatures, { query: { aggregateType: 'di_investigation', aggregateId: investigationId } });
    expect(outcome(sigs)).toBe('403:EBMR-TAB-020');
  });

  it('[DI-17] no role reads an investigation "to be signed" with a meaning it may not sign (MBR checker, master-data steward, operator)', async () => {
    for (const [server, key] of [[gmp, 'checker'], [gmp, 'steward'], [sbx, 'operator1']] as const) {
      const b = await server.asPersona(key);
      const r = await b.call(routes.esig.content, { query: { aggregateType: 'di_investigation', aggregateId: investigationId, intent: 'DI_INVESTIGATION_CLOSED' } });
      expect(outcome(r), key).toBe('403:ESIG_PREVIEW_NOT_ALLOWED');
      expect(leaked(r)).not.toContain('back-dating');
      const sigs = await b.call(routes.esig.signatures, { query: { aggregateType: 'di_investigation', aggregateId: investigationId } });
      expect(outcome(sigs), key).toBe('403:EBMR-TAB-020');
    }
  });

  it('[DI-17][DI-50] a QA reviewer may read the investigation\'s signatures, but its content is served by no signing flow of this installation', async () => {
    const sigs = await qaBrowser.call(routes.esig.signatures, { query: { aggregateType: 'di_investigation', aggregateId: investigationId } });
    expect(outcome(sigs)).toBe('ok');
    const r = await qaBrowser.call(routes.esig.content, { query: { aggregateType: 'di_investigation', aggregateId: investigationId, intent: 'DI_INVESTIGATION_CLOSED' } });
    expect(outcome(r)).toBe('404:EBMR-TAB-019');
    expect(leaked(r)).not.toContain('back-dating');
    // Never the investigation about the reviewer.
    const own = await qaBrowser.call(routes.esig.signatures, { query: { aggregateType: 'di_investigation', aggregateId: ownInvestigationId } });
    expect(outcome(own)).toBe('403:EBMR-TAB-020');
  });

  it('[DI-17][DI-37] on an office terminal the content of a record is previewed only with a meaning the session\'s role signs; any record type the kernel provider does not sign here is refused', async () => {
    const author = await gmp.asPersona('author');
    const checker = await gmp.asPersona('checker');
    const stub = await createStub(gmp, author, 'author', { kind: 'MASTER_DOCUMENT', title: 'Specimen label PCM500' });
    // Control: the checker previews it to sign CHECKED.
    expect(outcome(await checker.call(routes.esig.content, { query: { aggregateType: 'esig_stub', aggregateId: stub, intent: 'CHECKED' } }))).toBe('ok');
    // The author's role (MBR_AUTHOR) does not sign APPROVED (MBR.APPROVE).
    const approve = await author.call(routes.esig.content, { query: { aggregateType: 'esig_stub', aggregateId: stub, intent: 'APPROVED' } });
    expect(outcome(approve)).toBe('403:ESIG_PREVIEW_NOT_ALLOWED');
    expect(leaked(approve)).not.toContain('Specimen label');
    // A meaning the stub is not signed with here.
    expect(outcome(await checker.call(routes.esig.content, { query: { aggregateType: 'esig_stub', aggregateId: stub, intent: 'RECORD_TYPE_APPROVED' } }))).toBe('403:ESIG_PREVIEW_NOT_ALLOWED');
    // Signatures of a RECORD-class record: any role with RECORD.READ.
    expect(outcome(await author.call(routes.esig.signatures, { query: { aggregateType: 'esig_stub', aggregateId: stub } }))).toBe('ok');
  });

  it('[DI-17][DI-37] on a shop-floor terminal the person who taps signs: the session previews a RECORD-class record for a meaning another person present signs', async () => {
    const op = await sbx.asPersona('operator1');
    const stub = await createStub(sbx, op, 'operator1');
    const r = await op.call(routes.esig.content, { query: { aggregateType: 'esig_stub', aggregateId: stub, intent: 'VERIFIED' } });
    expect(outcome(r)).toBe('ok');
    // But never a GOVERNANCE-class record (above), nor a meaning the record is not signed with here.
    expect(outcome(await op.call(routes.esig.content, { query: { aggregateType: 'esig_stub', aggregateId: stub, intent: 'RELEASE' } }))).toMatch(/^4\d\d:/);
  });
});

describe('F34: the database (tablets 0410)', () => {
  it('[DI-17][DI-50] the application role no longer reads content, signatures or investigations around the session rule', async () => {
    for (const sqlText of [
      `select esig.content_for_signing('di_investigation', '${investigationId}')`,
      `select * from esig.record_signatures('di_investigation', '${investigationId}')`,
      `select * from esig.resigning_required('di_investigation', '${investigationId}')`,
      `select esig.manifestation('${randomUUID()}')`,
      'select concern from records.di_investigation',
      'select * from records.di_investigation_current',
      'select * from records.di_investigation_link',
      'select * from records.di_investigation_closure',
    ]) {
      await expect(gmp.db.app.query(sqlText), sqlText).rejects.toThrow(/permission denied/);
    }
    // Without a session: RECORD-class only.
    await expect(gmp.db.app.query('select tab.record_content_for_signing($1, $2)', ['di_investigation', investigationId])).rejects.toThrow(/EBMR-TAB-020/);
    await expect(gmp.db.app.query('select * from tab.signatures_of($1, $2)', ['di_investigation', investigationId])).rejects.toThrow(/EBMR-TAB-020/);
    await expect(gmp.db.app.query('select * from tab.signatures_of($1, $2)', ['restore_event', randomUUID()])).rejects.toThrow(/EBMR-TAB-020/);
    await expect(gmp.db.app.query('select * from tab.signatures_of($1, $2)', ['some_new_type', 'x'])).rejects.toThrow(/EBMR-TAB-020/);
  });

  it('[DI-17][DI-50] with a session token it decides by the session\'s role and person (EBMR-TAB-018, EBMR-TAB-019, EBMR-TAB-020)', async () => {
    const subject = hashOf(gmp, await gmp.asPersona('author'));
    const reviewer = hashOf(gmp, qaBrowser);
    const q = (sqlText: string, args: unknown[]) => gmp.db.app.query(sqlText, args);
    // Not a session.
    await expect(q('select tab.signing_preview_problem($1, $2, $3, $4)', ['0'.repeat(64), 'esig_stub', 'x', 'CHECKED'])).rejects.toThrow(/EBMR-TAB-018/);
    // The subject: role without a governance permission.
    const subjectProblem = (await q('select tab.signing_preview_problem($1, $2, $3, $4) as p', [subject, 'di_investigation', investigationId, 'DI_INVESTIGATION_CLOSED'])).rows[0] as { p: string | null };
    expect(subjectProblem.p).toMatch(/read only in a role that reviews audit trails/);
    await expect(q('select tab.content_for_signing($1, $2, $3, $4)', [subject, 'di_investigation', investigationId, 'DI_INVESTIGATION_CLOSED'])).rejects.toThrow(/EBMR-TAB-019/);
    await expect(q('select * from tab.record_signatures($1, $2, $3)', [subject, 'di_investigation', investigationId])).rejects.toThrow(/EBMR-TAB-020/);
    // The QA reviewer may read and close an investigation, but never the one about the reviewer.
    expect(((await q('select tab.signing_preview_problem($1, $2, $3, $4) as p', [reviewer, 'di_investigation', investigationId, 'DI_INVESTIGATION_CLOSED'])).rows[0] as { p: string | null }).p).toBeNull();
    expect(((await q('select tab.signing_preview_problem($1, $2, $3, $4) as p', [reviewer, 'di_investigation', ownInvestigationId, 'DI_INVESTIGATION_CLOSED'])).rows[0] as { p: string | null }).p).toMatch(/never shown to the person it investigates/);
    await expect(q('select * from tab.record_signatures($1, $2, $3)', [reviewer, 'di_investigation', ownInvestigationId])).rejects.toThrow(/EBMR-TAB-020/);
    expect((await q('select * from tab.record_signatures($1, $2, $3)', [reviewer, 'di_investigation', investigationId])).rows).toEqual([]);
    // The kernel provider serves only the pairs signed that way here, and only to a role that signs the meaning.
    await expect(q('select tab.content_for_signing($1, $2, $3, $4)', [reviewer, 'di_investigation', investigationId, 'DI_INVESTIGATION_CLOSED'])).rejects.toThrow(/EBMR-TAB-019/);
  });

  it('[DI-17][DI-50] the application role sees no signing request or signature of a GOVERNANCE-class record (row-level security); the owner sees them', async () => {
    const reviewer = await passwordActor(gmp.db, qa, terminalOf(gmp.seed, 'PC-QA-01').fingerprint);
    await withCommand(gmp.db.app, reason(reviewer), (c) => identity.acknowledgeEsigPolicy(c));
    const content = await esig.contentForSigning(gmp.db.admin, 'di_investigation', investigationId);
    const challenge = await withCommand(gmp.db.app, reason(reviewer), (c) =>
      esig.createChallenge(c, { aggregateType: 'di_investigation', aggregateId: investigationId, contentVersion: content.contentVersion ?? '1', meaning: 'DI_INVESTIGATION_CLOSED', clientContentHash: content.contentHash ?? '' }),
    );
    const byApp = await gmp.db.app.query('select id from esig.challenge where id = $1', [challenge.challengeId]);
    const byOwner = await gmp.db.admin.query('select id from esig.challenge where id = $1', [challenge.challengeId]);
    expect({ app: byApp.rows.length, owner: byOwner.rows.length }).toEqual({ app: 0, owner: 1 });
    expect((await gmp.db.app.query("select count(*)::int as n from esig.signature where aggregate_type = 'di_investigation'")).rows[0]).toEqual({ n: 0 });
    // A RECORD-class signing request stays visible to the application (the screens read them).
    const author = await gmp.asPersona('author');
    const stub = await createStub(gmp, author, 'author');
    const stubContent = await esig.contentForSigning(gmp.db.admin, 'esig_stub', stub);
    const authorActor = await passwordActor(gmp.db, { ...personaOf(gmp.seed, 'author') }, terminalOf(gmp.seed, 'PC-DESIGN-01').fingerprint);
    const stubChallenge = await withCommand(gmp.db.app, reason(authorActor), (c) =>
      esig.createChallenge(c, { aggregateType: 'esig_stub', aggregateId: stub, contentVersion: stubContent.contentVersion ?? '1', meaning: 'PREPARED', clientContentHash: stubContent.contentHash ?? '' }),
    );
    expect((await gmp.db.app.query('select id from esig.challenge where id = $1', [stubChallenge.challengeId])).rows).toHaveLength(1);
  });
});
