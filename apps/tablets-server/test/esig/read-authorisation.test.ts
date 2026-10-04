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
import { challengeFor, createStub, passwordOf, sign, startSigningServer, valueOf } from './support.ts';

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
    // Never the investigation about the reviewer: it has no signatures for the reviewer, as an investigation that is not
    // there has none (tablets 0530, default F35.3).
    const own = await qaBrowser.call(routes.esig.signatures, { query: { aggregateType: 'di_investigation', aggregateId: ownInvestigationId } });
    expect(own).toEqual({ ok: true, status: 200, value: { signatures: [] } });
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

  it('[DI-17][DI-50] with a session token it decides by the session\'s role, and answers an investigation about the session\'s person as one that is not there (EBMR-TAB-018, EBMR-TAB-019, EBMR-TAB-020)', async () => {
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
    // The QA reviewer may read and close an investigation, but never the one about the reviewer: its signatures and
    // content are those of an investigation that is not there (tablets 0530, default F35.3), and its preview is decided
    // by the reviewer's role alone, as for any investigation.
    expect(((await q('select tab.signing_preview_problem($1, $2, $3, $4) as p', [reviewer, 'di_investigation', investigationId, 'DI_INVESTIGATION_CLOSED'])).rows[0] as { p: string | null }).p).toBeNull();
    expect(((await q('select tab.signing_preview_problem($1, $2, $3, $4) as p', [reviewer, 'di_investigation', ownInvestigationId, 'DI_INVESTIGATION_CLOSED'])).rows[0] as { p: string | null }).p).toBeNull();
    expect((await q('select * from tab.record_signatures($1, $2, $3)', [reviewer, 'di_investigation', ownInvestigationId])).rows).toEqual([]);
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

/**
 * Round 2 of F34: with no session token at all the application role still reached investigations and GOVERNANCE-class
 * signatures through the kernel's own readers (the scoping report, a chain extract, the evidence package, the chain
 * list) and through the signatures' side tables (seals, ID register, content changes, invalidations, signing failures),
 * which had no row-level security. Tablets 0430 closes those doors; the owner's tools still read them.
 */
describe('F34: the application role\'s other doors to investigations and GOVERNANCE-class signatures (tablets 0430)', () => {
  let signatureId = '';
  let failedChallengeId = '';

  /** The QA reviewer's DI_INVESTIGATION_CLOSED signature of the investigation (the kernel's ceremony), and a refused attempt logged against a second request. */
  beforeAll(async () => {
    const fp = terminalOf(gmp.seed, 'PC-QA-01').fingerprint;
    const reviewer = await passwordActor(gmp.db, qa, fp);
    await withCommand(gmp.db.app, reason(reviewer), (c) => identity.acknowledgeEsigPolicy(c));
    const content = await esig.contentForSigning(gmp.db.admin, 'di_investigation', investigationId);
    const request = () =>
      withCommand(gmp.db.app, reason(reviewer), (c) =>
        esig.createChallenge(c, { aggregateType: 'di_investigation', aggregateId: investigationId, contentVersion: content.contentVersion ?? '1', meaning: 'DI_INVESTIGATION_CLOSED', clientContentHash: content.contentHash ?? '' }),
      );
    const challenge = await request();
    const ev = await identity.authenticate(gmp.db.authn, { method: 'PASSWORD', identifier: qa.loginName, secret: qa.password, deviceFingerprint: fp, purpose: 'SIGNATURE', challengeId: challenge.challengeId });
    const sealKey = gmp.built.ctx.sealKey;
    if (!sealKey) throw new Error('SETUP: the server has no seal key');
    signatureId = await withCommand(gmp.db.app, reason({ ...reviewer, authEventId: ev.authEventId }), async (c) =>
      (await esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState: content.state ?? null }, sealKey)).signatureId,
    );
    failedChallengeId = (await request()).challengeId;
    await gmp.db.app.query('select esig.record_signing_failure($1, null, $2, $3)', [failedChallengeId, 'EBMR-IAM-020', 'review F34 test: the password was wrong']);
    // A content change of the investigation and the invalidation of its signature, as the kernel writes them for a
    // GOVERNANCE-class record whose content changes (owner fixtures: an investigation's own content never changes).
    await withCommand(gmp.db.admin, reason(reviewer), async (c) => {
      await c.query("select esig.content_changed('di_investigation', $1, 'records.di_investigation_link', 'INSERT')", [investigationId]);
      await c.query(
        `insert into esig.signature_invalidation (signature_id, aggregate_ref, reason, previous_content_hash, current_content_hash, change_id, person_id, account_id, correlation_id)
         select s.id, s.aggregate_ref, 'SUPERSEDED_BY_CHANGE', s.content_hash, repeat('0', 64), (select max(id) from esig.content_change where aggregate_ref = s.aggregate_ref), $2, $3, $4
           from esig.signature s where s.id = $1`,
        [signatureId, reviewer.personId, reviewer.accountId, randomUUID()],
      );
    });
  });

  it('[DI-17][DI-50][DI-13] without a session the application role runs no kernel reader of an investigation or of evidence: scoping report, person activity, chain extract, evidence package, chain list (the owner still runs them)', async () => {
    const author = personaOf(gmp.seed, 'author');
    const window = [new Date(Date.UTC(2000, 0, 1)), new Date(Date.UTC(2100, 0, 1))];
    for (const [sqlText, args] of [
      ['select * from records.investigation_scope($1)', [investigationId]],
      ['select * from records.person_activity($1, $2, $3)', [author.personId, ...window]],
      ['select esig.chain_extract($1)', [`di_investigation:${investigationId}`]],
      ['select esig.evidence_package($1)', [signatureId]],
      ['select * from kernel.chain_keys()', []],
      ['select * from kernel.verify_all_chains()', []],
    ] as const) {
      await expect(gmp.db.app.query(sqlText, [...args]), sqlText).rejects.toThrow(/permission denied/);
    }
    // The owner's tools: the package is the investigation's closure signature, and the chain list names the investigation.
    const pkg = (await gmp.db.admin.query<{ p: { signature: { aggregate_ref: string } } }>('select esig.evidence_package($1) as p', [signatureId])).rows[0]?.p;
    expect(pkg?.signature.aggregate_ref).toBe(`di_investigation:${investigationId}`);
    expect((await gmp.db.admin.query('select k from kernel.chain_keys() k where k = $1', [`di_investigation:${investigationId}`])).rows).toHaveLength(1);
  });

  it('[DI-17][DI-50] the application roles see no row of a GOVERNANCE-class record in the seals, the signature-ID register, the content changes, the invalidations and the signing failures, and no retention hold; the owner sees them, and RECORD-class rows stay visible', async () => {
    const ref = `di_investigation:${investigationId}`;
    const counts = async (db: typeof gmp.db.app) =>
      (
        await db.query<Record<string, number>>(
          `select (select count(*)::int from esig.signature_seal where aggregate_ref = $1) as seal,
                  (select count(*)::int from esig.signature_id_register where signature_id = $2) as register,
                  (select count(*)::int from esig.content_change where aggregate_ref = $1) as change,
                  (select count(*)::int from esig.signature_invalidation where signature_id = $2) as invalidation,
                  (select count(*)::int from esig.signing_failure where challenge_id = $3) as failure`,
          [ref, signatureId, failedChallengeId],
        )
      ).rows[0];
    expect(await counts(gmp.db.admin)).toEqual({ seal: 1, register: 1, change: 1, invalidation: 1, failure: 1 });
    expect(await counts(gmp.db.app)).toEqual({ seal: 0, register: 0, change: 0, invalidation: 0, failure: 0 });
    for (const sqlText of ['select * from records.retention_hold', 'select * from records.retention_hold_release', 'select * from records.active_hold']) {
      await expect(gmp.db.app.query(sqlText), sqlText).rejects.toThrow(/permission denied/);
    }
    // RECORD-class rows: the author's signature of a stub entry, its seal, register entry and the entry's content change.
    const author = await gmp.asPersona('author');
    const stub = await createStub(gmp, author, 'author');
    const { r } = await challengeFor(gmp, author, 'author', stub, 'PREPARED');
    const signed = valueOf(await sign(author, valueOf(r).challengeId, stub, passwordOf(gmp, 'author')));
    const stubRows = (
      await gmp.db.app.query<Record<string, number>>(
        `select (select count(*)::int from esig.signature_seal where aggregate_ref = $1) as seal,
                (select count(*)::int from esig.signature_id_register where signature_id = $2) as register,
                (select count(*)::int from esig.content_change where aggregate_ref = $1) as change`,
        [`esig_stub:${stub}`, signed.manifestation.signatureId],
      )
    ).rows[0];
    expect(stubRows).toEqual({ seal: 1, register: 1, change: 1 });
    // The policies name both application roles (GMP and sandbox).
    const { rows: policies } = await gmp.db.admin.query<{ t: string; roles: string[] }>(
      `select tablename as t, roles::text[] as roles from pg_policies where schemaname = 'esig' and policyname = 'app_reads_record_class'
          and tablename in ('signature_seal', 'signature_id_register', 'content_change', 'signature_invalidation', 'signing_failure') order by 1`,
    );
    expect(policies.map((p) => `${p.t}:${[...p.roles].sort().join(',')}`)).toEqual(
      ['content_change', 'signature_id_register', 'signature_invalidation', 'signature_seal', 'signing_failure'].map((t) => `${t}:ebmr_app,ebmr_sandbox`),
    );
  });

  it('[DI-17][DI-50] the application role finds no id of a GOVERNANCE-class signature to ask the kernel about: no disposal approval, tombstone, restore or restore approval, and no integrity list of signatures (tablets 0450)', async () => {
    // The kernel answers who signed what for a signature id the caller holds (the MBR guards need it without a session),
    // so the ids of GOVERNANCE-class signatures are not the application role's to find.
    for (const sqlText of [
      'select approval_signature_id from records.purge_approval',
      'select approval_signature_id from records.tombstone',
      'select signature_id from continuity.restore_event_approval',
      'select affected_chain_keys from continuity.restore_event',
      'select affected_chain_keys from continuity.restore_event_status',
      'select * from esig.verify_signatures()',
      'select * from esig.invariant_violations()',
    ]) {
      await expect(gmp.db.app.query(sqlText), sqlText).rejects.toThrow(/permission denied/);
    }
    // The owner's integrity jobs still run, and the owner reads the restore and disposal registers.
    for (const sqlText of ['select count(*) from esig.verify_signatures()', 'select count(*) from esig.invariant_violations()', 'select count(*) from records.purge_approval', 'select count(*) from continuity.restore_event_status']) {
      expect((await gmp.db.admin.query(sqlText)).rows, sqlText).toHaveLength(1);
    }
  });
});

/**
 * Round 3 of F34: with no session token the application role still asked the kernel what blocks a record. On the
 * account of the person investigated, records.open_blockers answered the investigation's id, reference and concern
 * and the hold it placed; records.has_disposition_blockers answered yes; records.disposal_refusals and
 * records.retention_of name the blocking investigation of a record with a retention schedule; the blocker counters
 * (records.blocker_epoch, records.lock_blocker_epoch) showed which records' blockers changed, the account among them;
 * records.retention_current said whether a record is on hold. Listing the accounts (iam.account) and asking each named
 * every person under investigation. Tablets 0460 takes all of them away from the application role, on both
 * installations; the owner's tools still run them.
 */
describe('F34: what blocks a record\'s release or disposal (tablets 0460)', () => {
  const CONCERN_HELD = 'Suspected PIN sharing on the QA terminal (report WB-31)';
  let held: GrantedPerson;
  let heldInvestigation = '';

  /** A CSV/DI lead opens an investigation of a QA reviewer whose window covers now: its scope holds the reviewer's account. */
  beforeAll(async () => {
    const fp = terminalOf(gmp.seed, 'PC-QA-01').fingerprint;
    held = await grantedPerson(gmp, 'QA_REVIEWER', 'Anil Kumar (QA reviewer)');
    const opener = await passwordActor(gmp.db, await grantedPerson(gmp, 'CSV_DI_LEAD', 'Meera Iyer (CSV/DI lead)'), fp);
    heldInvestigation = await withCommand(gmp.db.app, reason(opener), (c) =>
      records.openDiInvestigation(c, { subjectPersonId: held.personId, windowFrom: new Date(Date.UTC(2000, 0, 1)), windowTo: new Date(Date.UTC(2100, 0, 1)), concern: CONCERN_HELD }),
    );
  });

  it('[DI-17][DI-50] without a session the application role learns nothing of an investigation from what blocks a record: no blockers, no disposition flag, no disposal refusals, no retention status, no blocker counter, on either installation', async () => {
    // What the kernel holds about the reviewer's account: the investigation (with its concern) and the hold it placed.
    const blockers = (await gmp.db.admin.query<{ blocker_kind: string; blocker_id: string; detail: string }>(
      "select blocker_kind, blocker_id::text, detail from records.open_blockers('account', $1) order by 1", [held.accountId],
    )).rows;
    expect(blockers.map((b) => b.blocker_kind)).toEqual(['DI_INVESTIGATION', 'HOLD']);
    expect(blockers[0]).toMatchObject({ blocker_id: heldInvestigation, detail: CONCERN_HELD });
    expect((await gmp.db.admin.query("select records.has_disposition_blockers('account', $1) as v", [held.accountId])).rows[0]).toEqual({ v: true });
    expect((await gmp.db.admin.query('select version > 0 as moved from records.blocker_epoch where record_key = $1', [`account:${held.accountId}`])).rows[0]).toEqual({ moved: true });
    expect((await gmp.db.admin.query('select count(*)::int as n from records.retention_current')).rows).toHaveLength(1);
    // The owner's functions run (and refuse a record without a retention schedule for that reason, not for privileges).
    await expect(gmp.db.admin.query('select * from records.disposal_refusals($1)', [randomUUID()])).rejects.toThrow(/EBMR-REC-021/);
    await expect(gmp.db.admin.query("select records.retention_of('batch', $1)", [randomUUID()])).rejects.toThrow(/EBMR-REC-021/);
    // The application role, without a session: none of it, on GMP or in the sandbox (sandbox.mirror_application_privileges).
    for (const server of [gmp, sbx]) {
      const account = server === gmp ? held.accountId : personaOf(sbx.seed, 'operator1').accountId;
      for (const [sqlText, args] of [
        ["select * from records.open_blockers('account', $1)", [account]],
        ["select records.has_disposition_blockers('account', $1)", [account]],
        ['select * from records.disposal_refusals($1)', [randomUUID()]],
        ["select records.retention_of('batch', $1)", [randomUUID()]],
        ["select records.lock_blocker_epoch('account', $1)", [account]],
        ['select record_key, version from records.blocker_epoch', []],
        ['select record_key, on_hold from records.retention_current', []],
      ] as const) {
        await expect(server.db.app.query(sqlText, [...args]), `${server.kind}: ${sqlText}`).rejects.toThrow(/permission denied/);
      }
    }
  });
});

/**
 * Round 4 of F34: the QA reviewer an investigation is about was told about it by the session-checked reads themselves.
 * Its signatures were refused "a data-integrity investigation is never shown to the person it investigates"
 * (EBMR-TAB-020), and so was its preview, where a colleague in the same role asking about an investigation that is not
 * there was answered with an empty list of signatures and with this installation's refusal of the type (EBMR-TAB-019),
 * or of the meaning. Now (tablets 0530; default F35.3) an investigation about the session's person is answered as an
 * investigation that is not there: the same status, message and body shape as for the colleague.
 */
describe('F34: the person a DI investigation is about is answered as a colleague in the same role (tablets 0530)', () => {
  let control: GrantedPerson;
  let controlBrowser: TestBrowser;
  /** An answer as the person sees it (a refusal's correlation id differs per request), with the record's id replaced. */
  const same = (r: Result<unknown>, id: string): string =>
    JSON.stringify(r.ok ? { ok: true, status: r.status, value: r.value } : r.error.kind === 'REFUSAL' ? { status: r.error.status, refusal: r.error.envelope.refusal, retryable: r.error.envelope.retryable } : r.error)
      .split(id)
      .join('<id>');
  const refusalText = async (p: Promise<unknown>, id: string): Promise<string> => {
    try {
      await p;
      return 'resolved';
    } catch (error) {
      return (error as Error).message.split(id).join('<id>');
    }
  };

  /** The colleague signs the closure of the investigation about the reviewer (the kernel's ceremony), so it has a signature. */
  beforeAll(async () => {
    control = await grantedPerson(gmp, 'QA_REVIEWER', 'Sunita Rao (QA reviewer)');
    controlBrowser = await loginOf(gmp, control);
    const fp = terminalOf(gmp.seed, 'PC-QA-01').fingerprint;
    const signer = await passwordActor(gmp.db, control, fp);
    await withCommand(gmp.db.app, reason(signer), (c) => identity.acknowledgeEsigPolicy(c));
    const content = await esig.contentForSigning(gmp.db.admin, 'di_investigation', ownInvestigationId);
    const challenge = await withCommand(gmp.db.app, reason(signer), (c) =>
      esig.createChallenge(c, { aggregateType: 'di_investigation', aggregateId: ownInvestigationId, contentVersion: content.contentVersion ?? '1', meaning: 'DI_INVESTIGATION_CLOSED', clientContentHash: content.contentHash ?? '' }),
    );
    const ev = await identity.authenticate(gmp.db.authn, { method: 'PASSWORD', identifier: control.loginName, secret: control.password, deviceFingerprint: fp, purpose: 'SIGNATURE', challengeId: challenge.challengeId });
    const sealKey = gmp.built.ctx.sealKey;
    if (!sealKey) throw new Error('SETUP: the server has no seal key');
    await withCommand(gmp.db.app, reason({ ...signer, authEventId: ev.authEventId }), (c) =>
      esig.sign(c, { challengeId: challenge.challengeId, authEventId: ev.authEventId, expectedState: content.state ?? null }, sealKey),
    );
  });

  it('[DI-17][DI-50] through the routes, the signatures and the preview of the investigation about the reviewer answer the reviewer as they answer a colleague in the same role about an investigation that is not there', async () => {
    const absent = randomUUID();
    const answers = async (b: TestBrowser, id: string) => ({
      signatures: same(await b.call(routes.esig.signatures, { query: { aggregateType: 'di_investigation', aggregateId: id } }), id),
      closure: same(await b.call(routes.esig.content, { query: { aggregateType: 'di_investigation', aggregateId: id, intent: 'DI_INVESTIGATION_CLOSED' } }), id),
      prepared: same(await b.call(routes.esig.content, { query: { aggregateType: 'di_investigation', aggregateId: id, intent: 'PREPARED' } }), id),
    });
    const subject = await answers(qaBrowser, ownInvestigationId);
    const colleague = await answers(controlBrowser, absent);
    expect(subject).toEqual(colleague);
    expect(colleague.signatures).toBe(JSON.stringify({ ok: true, status: 200, value: { signatures: [] } }));
    expect(colleague.closure).toMatch(/"status":404[^]*"code":"EBMR-TAB-019"/);
    expect(colleague.prepared).toMatch(/"status":403[^]*"code":"ESIG_PREVIEW_NOT_ALLOWED"/);
  });

  it('[DI-17][DI-50] the database answers the reviewer\'s session about the investigation of the reviewer as a colleague\'s about one that is not there (tab.signing_preview_problem, tab.record_signatures, tab.content_for_signing), and would serve no content of it were it signed through the kernel\'s provider', async () => {
    const reviewer = hashOf(gmp, qaBrowser);
    const colleague = hashOf(gmp, controlBrowser);
    const absent = randomUUID();
    const q = (sqlText: string, args: unknown[]) => gmp.db.app.query(sqlText, args);
    const answers = async (h: string, id: string) => ({
      closure: (await q('select tab.signing_preview_problem($1, $2, $3, $4) as p', [h, 'di_investigation', id, 'DI_INVESTIGATION_CLOSED'])).rows,
      prepared: JSON.stringify((await q('select tab.signing_preview_problem($1, $2, $3, $4) as p', [h, 'di_investigation', id, 'PREPARED'])).rows).split(id).join('<id>'),
      signatures: (await q('select * from tab.record_signatures($1, $2, $3)', [h, 'di_investigation', id])).rows,
      content: await refusalText(q('select tab.content_for_signing($1, $2, $3, $4)', [h, 'di_investigation', id, 'DI_INVESTIGATION_CLOSED']), id),
    });
    const subject = await answers(reviewer, ownInvestigationId);
    expect(subject).toEqual(await answers(colleague, absent));
    expect(subject).toMatchObject({ closure: [{ p: null }], signatures: [] });
    // The investigation about the reviewer has a signature (the colleague's), which the colleague reads.
    expect((await q('select meaning_code from tab.record_signatures($1, $2, $3)', [colleague, 'di_investigation', ownInvestigationId])).rows).toEqual([{ meaning_code: 'DI_INVESTIGATION_CLOSED' }]);
    expect(subject.content).toMatch(/EBMR-TAB-019/);
    // Were this installation to sign investigations through the kernel's provider (a later signing flow), the reviewer's
    // session would be served the investigation about the reviewer as one that is not there; the colleague its content.
    const c = await gmp.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local role ebmr_owner');
      await c.query(`create or replace function tab.kernel_signing_meanings(p_aggregate_type text) returns text[]
                     language sql immutable set search_path = pg_catalog, pg_temp as $$ select case p_aggregate_type when 'di_investigation' then array['DI_INVESTIGATION_CLOSED'] else '{}'::text[] end $$`);
      await c.query('set local role ebmr_app');
      const content = async (h: string, id: string) =>
        (await c.query<{ r: Record<string, unknown> }>('select tab.content_for_signing($1, $2, $3, $4) as r', [h, 'di_investigation', id, 'DI_INVESTIGATION_CLOSED'])).rows[0]?.r;
      expect(await content(reviewer, ownInvestigationId)).toEqual({ exists: false, aggregate_type: 'di_investigation', aggregate_id: ownInvestigationId });
      expect(await content(colleague, absent)).toEqual({ exists: false, aggregate_type: 'di_investigation', aggregate_id: absent });
      const served = await content(colleague, ownInvestigationId);
      expect(served?.['exists']).toBe(true);
      expect(String(served?.['canonical'])).toContain('Suspected sharing of the QA reviewer password');
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});

/**
 * Round 4 of F34 (the verifier's minor item HIGH-WATER): continuity.sequence_high_water(), SECURITY DEFINER and granted
 * to the application role, read every protected sequence's last value without a session, among them the numbers of
 * data-integrity investigations (records.di_investigation.investigation_no) and of retention holds
 * (records.retention_hold.hold_no): watched over time, it told when and how many investigations and holds were opened
 * (not who). continuity.sequence_bump keeps each sequence's values before and after a restore moved it. No screen,
 * handler or command of this installation reads either; the anchor job that copies the marks to the external ledger
 * reads the anchors, which are the owner's since tablets 0430, so it runs as the owner here. Tablets 0540 takes both
 * away from the application role on both installations; the owner's tools still read them.
 */
describe('F34: when and how many investigations and holds were opened (tablets 0540)', () => {
  /** A CSV/DI lead opens an investigation whose window covers now: it holds the subject's account. */
  beforeAll(async () => {
    const fp = terminalOf(gmp.seed, 'PC-QA-01').fingerprint;
    const subject = await grantedPerson(gmp, 'QA_REVIEWER', 'Ravi Shankar (QA reviewer)');
    const opener = await passwordActor(gmp.db, await grantedPerson(gmp, 'CSV_DI_LEAD', 'Lata Pillai (CSV/DI lead)'), fp);
    await withCommand(gmp.db.app, reason(opener), (c) =>
      records.openDiInvestigation(c, { subjectPersonId: subject.personId, windowFrom: new Date(Date.UTC(2000, 0, 1)), windowTo: new Date(Date.UTC(2100, 0, 1)), concern: 'Suspected sharing of a terminal session' }),
    );
  });

  it('[DI-17][DI-50] without a session the application role reads no protected sequence\'s high-water mark and no sequence move, on either installation; the owner still does', async () => {
    // The owner: the investigations and holds this file opened moved their numbers.
    const marks = (await gmp.db.admin.query<{ sequence_key: string; last_value: string }>(
      "select sequence_key, last_value::text from continuity.sequence_high_water() where sequence_key in ('records.di_investigation.investigation_no', 'records.retention_hold.hold_no') order by 1",
    )).rows;
    expect(marks.map((m) => m.sequence_key)).toEqual(['records.di_investigation.investigation_no', 'records.retention_hold.hold_no']);
    for (const m of marks) expect(BigInt(m.last_value), m.sequence_key).toBeGreaterThan(0n);
    expect((await gmp.db.admin.query('select count(*)::int as n from continuity.sequence_bump')).rows).toHaveLength(1);
    // The application role, without a session: neither, on GMP or in the sandbox (sandbox.mirror_application_privileges).
    for (const server of [gmp, sbx]) {
      for (const sqlText of ['select sequence_key, last_value from continuity.sequence_high_water()', 'select sequence_key, value_before, value_after from continuity.sequence_bump']) {
        await expect(server.db.app.query(sqlText), `${server.kind}: ${sqlText}`).rejects.toThrow(/permission denied/);
      }
    }
  });
});

/**
 * Lane round 2 of round 4 (the verifier of HIGH-WATER): tablets 0540 took the protected sequences' high-water marks
 * away from the application role, but PostgreSQL's statistics still served it, without a session and without any
 * privilege on the tables, the counters of every table: rows inserted and live in records.di_investigation,
 * di_investigation_link, retention_hold (pg_stat_user_tables, pg_stat_get_tuples_inserted and the other per-table and
 * per-index counters), their block reads (pg_statio_*) and their size on disk (pg_relation_size and its siblings). Read
 * now and again later, they told when and how many investigations and holds were opened and closed (not who). Tablets
 * 0570 takes from PUBLIC, in each installation's database, the per-table, per-index, per-sequence and per-function
 * statistics views, the counter functions behind them and the relation size functions; what the server and the kernel
 * read as the application role (pg_stat_ssl for the encrypted-session check, pg_locks for the audit viewer's settled
 * horizon, pg_stat_activity) stays. What remains open is default HW.1.
 */
describe('HIGH-WATER: the statistics of the investigation and hold tables (tablets 0570)', () => {
  const TABLES = ['di_investigation', 'di_investigation_link', 'retention_hold'] as const;
  /** The oid of records.<table>, as the owner finds it (no privilege on the table is needed to name it). */
  const oidOf = async (server: TestServer, table: string): Promise<string> =>
    (await server.db.admin.query<{ oid: string }>("select c.oid::text as oid from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'records' and c.relname = $1", [table])).rows[0]?.oid ?? '';

  beforeAll(async () => {
    // One more investigation on each installation, so its tables have counted inserts.
    for (const server of [gmp, sbx]) {
      const label = (name: string): string => (server === sbx ? `TEST-${name}` : name);
      const fp = terminalOf(server.seed, server === gmp ? 'PC-QA-01' : 'TEST-PC-01').fingerprint;
      const subject = await grantedPerson(server, 'QA_REVIEWER', label('Meena Iyer QA reviewer'));
      const opener = await passwordActor(server.db, await grantedPerson(server, 'CSV_DI_LEAD', label('Arun Das CSV-DI lead')), fp);
      await withCommand(server.db.app, reason(opener), (c) =>
        records.openDiInvestigation(c, { subjectPersonId: subject.personId, windowFrom: new Date(Date.UTC(2000, 0, 1)), windowTo: new Date(Date.UTC(2100, 0, 1)), concern: 'Suspected sharing of a QA reviewer password' }),
      );
    }
  });

  it('[DI-17][DI-50] without a session the application role reads no counter, block count or size of the investigation and hold tables, on either installation; the owner still reads them, and the application role still reads its TLS state, the locks and the activity it needs', async () => {
    for (const server of [gmp, sbx]) {
      // The owner (the operator's monitoring): the statistics views answer.
      const seen = (await server.db.admin.query<{ relname: string }>(
        "select relname from pg_stat_user_tables where schemaname = 'records' and relname = any ($1) order by relname", [[...TABLES]],
      )).rows.map((r) => r.relname);
      expect(seen, server.kind).toEqual([...TABLES]);
      const app = server.db.app;
      for (const table of TABLES) {
        const oid = await oidOf(server, table);
        for (const sqlText of [
          'select n_tup_ins, n_live_tup from pg_catalog.pg_stat_user_tables where relid = $1::oid',
          'select n_tup_ins from pg_catalog.pg_stat_all_tables where relid = $1::oid',
          'select n_tup_ins from pg_catalog.pg_stat_xact_user_tables where relid = $1::oid',
          'select heap_blks_hit from pg_catalog.pg_statio_user_tables where relid = $1::oid',
          'select idx_scan from pg_catalog.pg_stat_user_indexes where relid = $1::oid',
          'select idx_blks_hit from pg_catalog.pg_statio_all_indexes where relid = $1::oid',
          'select pg_catalog.pg_stat_get_tuples_inserted($1::oid)',
          'select pg_catalog.pg_stat_get_live_tuples($1::oid)',
          'select pg_catalog.pg_stat_get_numscans($1::oid)',
          'select pg_catalog.pg_stat_get_blocks_hit($1::oid)',
          'select pg_catalog.pg_stat_get_last_autoanalyze_time($1::oid)',
          'select pg_catalog.pg_stat_get_xact_tuples_inserted($1::oid)',
          'select pg_catalog.pg_relation_size($1::oid::regclass)',
          'select pg_catalog.pg_total_relation_size($1::oid::regclass)',
          'select pg_catalog.pg_table_size($1::oid::regclass)',
          'select pg_catalog.pg_indexes_size($1::oid::regclass)',
        ]) {
          await expect(app.query(sqlText, [oid]), `${server.kind} ${table}: ${sqlText}`).rejects.toThrow(/permission denied/);
        }
      }
      await expect(app.query("select blks_hit from pg_catalog.pg_statio_user_sequences where schemaname = 'records'"), server.kind).rejects.toThrow(/permission denied/);
      await expect(app.query('select calls from pg_catalog.pg_stat_user_functions'), server.kind).rejects.toThrow(/permission denied/);
      // What the server and the kernel read as the application role still answers.
      expect((await app.query('select count(*)::int as n from pg_catalog.pg_stat_ssl where pid = pg_catalog.pg_backend_pid()')).rows, server.kind).toEqual([{ n: 1 }]);
      expect((await app.query("select count(*)::int as n from pg_catalog.pg_locks where locktype = 'relation' and pid = pg_catalog.pg_backend_pid()")).rows[0], server.kind).toBeDefined();
      expect((await app.query('select count(*)::int as n from pg_catalog.pg_stat_activity where pid = pg_catalog.pg_backend_pid()')).rows, server.kind).toEqual([{ n: 1 }]);
    }
  });
});
