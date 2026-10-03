/**
 * Review F35 (DI-17, DI-16, DI-22, DI-50): the audit viewer checked nothing beyond a live session with a role, and its
 * read model selected the whole audit trail, which the application role may read whole. A production operator on a
 * shop-floor kiosk read every colleague's account chain (role grants with requester, approver and revocation reason,
 * credentials, status changes), listed every account, person, badge and terminal chain, and, through the person
 * filter, pulled everything a named colleague did across chains: the scoping report of a data-integrity investigation.
 * The person an investigation is about listed its chain and watched the investigator's activity.
 *
 * Now the database decides (tablets 0420; default F35.1): RECORD-class chains with RECORD.READ, governance chains only
 * in a governance or audit role and never an investigation to the person it is about, a person filter only on the
 * session's own person unless the role is a governance one, verification only of a chain the session may read; the
 * application role reads the audit tables only through these functions.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type AuditEventView, type Result } from '@ebmr/api-contract';
import { esig, identity, records, withCommand, type ActorContext } from '@ebmr/kernel';
import { passwordActor, personaOf, terminalOf } from '@ebmr/test-kit';
import { tokenHash } from '../../src/platform/auth/session.ts';
import { grantedPerson, loginOf, type GrantedPerson } from '../support/granted-person.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';

let sbx: TestServer;
let gmp: TestServer;
let operator: TestBrowser;
let lead: GrantedPerson;
let leadBrowser: TestBrowser;
let auditorBrowser: TestBrowser;
let investigationId = '';
const REVOCATION = 'Revoked pending DI investigation: suspected PIN sharing on TEST-KIOSK-BLEND-1';

const reason = <T extends ActorContext>(ctx: T): T => ({ ...ctx, reasonCode: 'TEST_SETUP', reasonText: 'review F35 test set-up', correlationId: randomUUID() });
const outcome = (r: Result<unknown>): string => (r.ok ? 'ok' : r.error.kind === 'REFUSAL' ? `${r.error.status}:${r.error.envelope.refusal.code}` : r.error.kind);
const hashOf = (server: TestServer, b: TestBrowser): string => tokenHash(b.cookies.get(server.config.cookies.session) ?? '');

async function events(b: TestBrowser, query: Record<string, string>): Promise<Result<{ events: AuditEventView[] }>> {
  return b.call(routes.audit.events, { query });
}
async function chainKeys(b: TestBrowser, prefix?: string): Promise<string[]> {
  const r = await b.call(routes.audit.chains, { query: prefix === undefined ? {} : { prefix } });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value.chains.map((c) => c.chainKey);
}

beforeAll(async () => {
  [sbx, gmp] = await Promise.all([startServer('SANDBOX'), startServer('GMP')]);
  // Sandbox: the administrator revokes verifier2's VERIFIER grant with a reason.
  const v2 = personaOf(sbx.seed, 'verifier2');
  const { rows } = await sbx.db.admin.query<{ id: string }>("select id from iam.role_grant where account_id = $1 and role_code = 'VERIFIER' and status = 'APPROVED'", [v2.accountId]);
  const admin = await passwordActor(sbx.db, sbx.seed.bootstrap.admin, sbx.seed.bootstrap.admin.fingerprint);
  await withCommand(sbx.db.app, reason(admin), (c) => identity.revokeRoleGrant(c, rows[0]?.id ?? '', REVOCATION));
  operator = await sbx.asPersona('operator1'); // OPERATOR, kiosk TEST-KIOSK-DISP-1
  // GMP: a CSV/DI lead opens an investigation of the MBR author; an auditor holds a time-limited read-only role.
  lead = await grantedPerson(gmp, 'CSV_DI_LEAD', 'Dev Lead (CSV/DI)');
  const leadActor = await passwordActor(gmp.db, lead, terminalOf(gmp.seed, 'PC-QA-01').fingerprint);
  investigationId = await withCommand(gmp.db.app, reason(leadActor), (c) =>
    records.openDiInvestigation(c, {
      subjectPersonId: personaOf(gmp.seed, 'author').personId,
      windowFrom: new Date(Date.UTC(2026, 0, 1)),
      windowTo: new Date(Date.UTC(2026, 8, 1)),
      concern: 'Suspected back-dating of granulation entries',
    }),
  );
  leadBrowser = await loginOf(gmp, lead);
  auditorBrowser = await loginOf(gmp, await grantedPerson(gmp, 'AUDITOR_READONLY', 'Inspector (read-only)'));
});
afterAll(async () => {
  await Promise.all([sbx?.close(), gmp?.close()]);
});

describe('F35: the audit viewer serves only the chains the session may read', () => {
  it('[DI-17][DI-16] an operator on a kiosk reads no colleague\'s access chain (the grant revocation and its reason), and lists no account, person, badge or terminal chain', async () => {
    const v2 = personaOf(sbx.seed, 'verifier2');
    const r = await events(operator, { chainKey: `account:${v2.accountId}` });
    expect(outcome(r)).toBe('403:EBMR-TAB-020');
    expect(JSON.stringify(r)).not.toContain('PIN sharing');
    for (const prefix of ['account:', 'person:', 'badge:', 'device:', 'iam_role:', 'delegation:']) expect(await chainKeys(operator, prefix), prefix).toEqual([]);
    // The whole list holds RECORD-class chains only, and the operator reads them.
    const all = await chainKeys(operator);
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((k) => /^(account|person|badge|device|iam_\w+|delegation|security_alert|di_investigation|incident|gateway_key|esig_seal_key):/.test(k))).toEqual([]);
    const recordChain = all[0] ?? '';
    expect(outcome(await events(operator, { chainKey: recordChain }))).toBe('ok');
    expect(outcome(await operator.call(routes.audit.verifyChain, { params: { chainKey: recordChain } }))).toBe('ok');
    expect(outcome(await operator.call(routes.audit.verifyChain, { params: { chainKey: `account:${v2.accountId}` } }))).toBe('403:EBMR-TAB-020');
  });

  it('[DI-17][DI-50] a colleague\'s activity across the trail (person filter) is refused to an operator; the session\'s own is served, from the chains it may read', async () => {
    const sup = personaOf(sbx.seed, 'supervisor1');
    expect(outcome(await events(operator, { personId: sup.personId }))).toBe('403:EBMR-TAB-020');
    const own = await events(operator, { personId: personaOf(sbx.seed, 'operator1').personId, limit: '200' });
    expect(outcome(own)).toBe('ok');
    if (own.ok) expect(own.value.events.filter((e) => !/^(batch|esig_stub|sandbox_lot|device_reading|state|test_package|esig_signature:batch_|esig_challenge:batch_)/.test(e.chainKey) && /^(account|person|badge|device):/.test(e.chainKey))).toEqual([]);
    // A list across chains shows only RECORD-class chains.
    const across = await events(operator, { limit: '200' });
    expect(outcome(across)).toBe('ok');
    if (across.ok) expect(across.value.events.map((e) => e.chainKey).filter((k) => /^(account|person|badge|device|iam_\w+|delegation):/.test(k))).toEqual([]);
  });

  it('[DI-17][DI-50] the person a DI investigation is about neither lists its chain nor reads the investigator\'s activity or account chain', async () => {
    const author = await gmp.asPersona('author');
    expect(await chainKeys(author, 'di_investigation:')).toEqual([]);
    expect(await chainKeys(author, 'account:')).toEqual([]);
    expect(outcome(await events(author, { chainKey: `di_investigation:${investigationId}` }))).toBe('403:EBMR-TAB-020');
    expect(outcome(await events(author, { chainKey: `account:${lead.accountId}` }))).toBe('403:EBMR-TAB-020');
    expect(outcome(await events(author, { personId: lead.personId }))).toBe('403:EBMR-TAB-020');
  });

  it('[DI-17][DI-22][DI-50] the governance and audit roles (CSV/DI lead, auditor) read the governance chains and a colleague\'s activity', async () => {
    const author = personaOf(gmp.seed, 'author');
    for (const b of [leadBrowser, auditorBrowser]) {
      expect(await chainKeys(b, 'di_investigation:')).toContain(`di_investigation:${investigationId}`);
      expect((await chainKeys(b, 'account:')).length).toBeGreaterThan(0);
      expect(outcome(await events(b, { chainKey: `account:${author.accountId}` }))).toBe('ok');
      expect(outcome(await events(b, { personId: author.personId }))).toBe('ok');
      expect(outcome(await b.call(routes.audit.verifyChain, { params: { chainKey: `di_investigation:${investigationId}` } }))).toBe('ok');
    }
  });
});

describe('F35: the database (tablets 0420)', () => {
  it('[DI-17][DI-22] the application role reads the audit trail only through the session-checked functions', async () => {
    for (const sqlText of ['select count(*) from kernel.audit_event', 'select count(*) from kernel.audit_chain_head']) {
      await expect(gmp.db.app.query(sqlText), sqlText).rejects.toThrow(/permission denied/);
    }
    const op = hashOf(sbx, operator);
    const v2 = personaOf(sbx.seed, 'verifier2');
    const sup = personaOf(sbx.seed, 'supervisor1');
    const q = (sqlText: string, args: unknown[]) => sbx.db.app.query(sqlText, args);
    await expect(q('select * from tab.audit_events($1, $2, null, null, null, null, null, null, 50)', [op, `account:${v2.accountId}`])).rejects.toThrow(/EBMR-TAB-020/);
    await expect(q('select * from tab.audit_events($1, null, null, $2, null, null, null, null, 50)', [op, sup.personId])).rejects.toThrow(/EBMR-TAB-020/);
    await expect(q('select tab.audit_chain_length($1, $2)', [op, `person:${sup.personId}`])).rejects.toThrow(/EBMR-TAB-020/);
    await expect(q('select * from tab.audit_registry_chains($1, $2)', [op, `account:${v2.accountId}`])).rejects.toThrow(/EBMR-TAB-020/);
    expect((await q("select count(*)::int as n from tab.audit_chains($1, 'account:', 500)", [op])).rows[0]).toEqual({ n: 0 });
    await expect(q('select * from tab.audit_chains($1, null, 10)', ['0'.repeat(64)])).rejects.toThrow(/EBMR-TAB-018/);
    // A governance role on GMP reads them.
    const leadHash = hashOf(gmp, leadBrowser);
    const author = personaOf(gmp.seed, 'author');
    expect(((await gmp.db.app.query("select count(*)::int as n from tab.audit_events($1, $2, null, null, null, null, null, null, 50)", [leadHash, `account:${author.accountId}`])).rows[0] as { n: number }).n).toBeGreaterThan(0);
    // Fail closed: a chain prefix nobody classified is a governance chain.
    expect((await gmp.db.app.query("select tab.audit_chain_class('some_future_chain:1') as c, tab.audit_chain_class('batch:1') as b, tab.audit_chain_class('esig_signature:di_investigation:1') as d, tab.audit_chain_class('esig_signature:batch_step:1') as s")).rows[0]).toEqual({
      c: 'GOVERNANCE', b: 'RECORD', d: 'GOVERNANCE', s: 'RECORD',
    });
  });
});

/**
 * Round 2 of F35: with no session token at all the application role still read the trail around tab.audit_*: a whole
 * chain (esig.chain_extract: a colleague's account chain with the grant's revocation reason), any person's activity
 * (records.person_activity), an investigation's scoping report (records.investigation_scope), and the list of every
 * chain (kernel.chain_keys, kernel.verify_all_chains, the heads of an anchor it may create itself, checkpoints and
 * verification runs). Tablets 0430 closes those doors on both installations; the owner's tools still read them.
 */
describe('F35: the application role\'s other doors to the audit trail (tablets 0430)', () => {
  it('[DI-17][DI-22][DI-50] without a session the application role reads no chain whole, no person\'s activity, no scoping report and no list of the chains, on either installation', async () => {
    const v2 = personaOf(sbx.seed, 'verifier2');
    const sup = personaOf(sbx.seed, 'supervisor1');
    const window = [new Date(Date.UTC(2000, 0, 1)), new Date(Date.UTC(2100, 0, 1))];
    // The owner's extract of verifier2's account chain holds the revocation and its reason.
    expect(JSON.stringify((await sbx.db.admin.query('select esig.chain_extract($1) as x', [`account:${v2.accountId}`])).rows[0])).toContain('PIN sharing');
    const refused: [TestServer, string, unknown[]][] = [
      [sbx, 'select esig.chain_extract($1)', [`account:${v2.accountId}`]],
      [sbx, 'select * from records.person_activity($1, $2, $3)', [sup.personId, ...window]],
      [gmp, 'select * from records.investigation_scope($1)', [investigationId]],
    ];
    for (const server of [sbx, gmp]) {
      refused.push([server, 'select * from kernel.chain_keys()', []], [server, 'select * from kernel.verify_all_chains()', []]);
      // The kernel's anchor function still runs for the application role, but the anchors' heads (every chain key),
      // the checkpoints and the verification runs are no longer its to read.
      await server.db.app.query('select kernel.create_anchor()');
      for (const sqlText of ['select heads from kernel.audit_anchor', 'select chain_key from kernel.audit_checkpoint', 'select problems from kernel.audit_verification_run']) {
        refused.push([server, sqlText, []]);
      }
    }
    for (const [server, sqlText, args] of refused) {
      await expect(server.db.app.query(sqlText, args), `${server.kind}: ${sqlText}`).rejects.toThrow(/permission denied/);
    }
  });
});

/**
 * Round 2 of F35: the rule that an investigation is never shown to the person it is about covered only its own chains.
 * A subject who holds a governance role (here a QA reviewer) read what the investigation wrote elsewhere: the hold
 * chains of the records it holds (record_hold:account:<the subject's own account>, with the lead placing the hold), the
 * hold entries on those records' own chains, the account chains of the persons who opened and lead it, and, through
 * the person filter, their activity across the trail. Tablets 0440 withholds all of it from the subject, whatever the
 * subject's role and the investigation's status.
 */
describe('F35: the person a DI investigation is about, in a governance role (tablets 0440)', () => {
  const OPENED = randomUUID();
  let subject: GrantedPerson;
  let investigator: GrantedPerson;
  let subjectBrowser: TestBrowser;
  let stub = '';
  let held: string[] = [];
  let signing: string[] = [];
  let investigation = '';

  beforeAll(async () => {
    const fp = terminalOf(gmp.seed, 'PC-QA-01').fingerprint;
    subject = await grantedPerson(gmp, 'QA_REVIEWER', 'Kiran Desai (QA reviewer)');
    investigator = await grantedPerson(gmp, 'CSV_DI_LEAD', 'Meera Iyer (CSV/DI lead)');
    // The subject enters a record of the RECORD class (a stub entry) before the investigation opens.
    const subjectActor = await passwordActor(gmp.db, subject, fp);
    stub = await withCommand(gmp.db.app, reason(subjectActor), async (c) =>
      (await c.query<{ id: string }>("insert into esig.stub_signable (kind, title, value, unit) values ('STEP', 'Blend uniformity sample', '4.98', 'g') returning id")).rows[0]?.id ?? '',
    );
    // The lead opens it with the other lead as investigator; its scope links and holds what the subject touched.
    const opener = await passwordActor(gmp.db, lead, fp);
    await withCommand(gmp.db.app, { ...reason(opener), correlationId: OPENED }, (c) =>
      records.openDiInvestigation(c, {
        subjectPersonId: subject.personId,
        windowFrom: new Date(Date.UTC(2000, 0, 1)),
        windowTo: new Date(Date.UTC(2100, 0, 1)),
        concern: 'Suspected sharing of the QA reviewer password',
        investigatorPersonId: investigator.personId,
      }),
    );
    // A QA reviewer's signing request on it (a closure about to be signed) and its signatures' chain.
    investigation = (await gmp.db.admin.query<{ id: string }>('select id::text from records.di_investigation where subject_person_id = $1', [subject.personId])).rows[0]?.id ?? '';
    const content = await esig.contentForSigning(gmp.db.admin, 'di_investigation', investigation);
    const approver = await passwordActor(gmp.db, await grantedPerson(gmp, 'QA_REVIEWER', 'Ravi Menon (QA reviewer)'), fp);
    await withCommand(gmp.db.app, reason(approver), (c) => identity.acknowledgeEsigPolicy(c));
    await withCommand(gmp.db.app, reason(approver), async (c) => {
      await esig.createChallenge(c, { aggregateType: 'di_investigation', aggregateId: investigation, contentVersion: content.contentVersion ?? '1', meaning: 'DI_INVESTIGATION_CLOSED', clientContentHash: content.contentHash ?? '' });
      await c.query('select kernel.audit_business_event($1, $2)', [`esig_signature:di_investigation:${investigation}`, 'closure signature expected']);
    });
    signing = [`esig_challenge:di_investigation:${investigation}`, `esig_signature:di_investigation:${investigation}`];
    held = (await gmp.db.admin.query<{ k: string }>(
      "select 'record_hold:' || h.record_key as k from records.retention_hold h join records.di_investigation i on i.id = h.investigation_id where i.subject_person_id = $1 order by 1",
      [subject.personId],
    )).rows.map((r) => r.k);
    subjectBrowser = await loginOf(gmp, subject);
  });

  it('[DI-17][DI-50] the subject lists and reads no hold chain the investigation created, and no hold entry on the records it holds; the lead does', async () => {
    expect(held).toContain(`record_hold:esig_stub:${stub}`);
    expect(held).toContain(`record_hold:account:${subject.accountId}`);
    // The lead (a governance reader the rule does not withhold them from) lists and reads them.
    expect(await chainKeys(leadBrowser, 'record_hold:')).toEqual(expect.arrayContaining(held));
    const leadView = await events(leadBrowser, { chainKey: `esig_stub:${stub}` });
    expect(JSON.stringify(leadView)).toContain('investigation hold placed');
    for (const k of signing) expect(await chainKeys(leadBrowser, k)).toEqual([k]);
    // The subject: none of them is listed, and each reads as a chain with no entries (tablets 0530, default F35.3: as a
    // colleague's own hold chain reads, never a refusal that would tell the subject).
    const listed = await chainKeys(subjectBrowser, 'record_hold:');
    expect(listed.filter((k) => held.includes(k))).toEqual([]);
    const none = { ok: true, status: 200, value: { events: [], nextCursor: null } };
    for (const k of signing) {
      expect(await chainKeys(subjectBrowser, k), k).toEqual([]);
      expect(await events(subjectBrowser, { chainKey: k }), k).toEqual(none);
    }
    for (const k of held) {
      expect(await events(subjectBrowser, { chainKey: k }), k).toEqual(none);
      expect(outcome(await subjectBrowser.call(routes.audit.verifyChain, { params: { chainKey: k } })), k).toBe('404:AUDIT_CHAIN_NOT_FOUND');
    }
    // Entries another command may write on a record's chain naming only one of its holds (as the release at closure
    // does) or only the investigation itself.
    const holdId = (await gmp.db.admin.query<{ id: string }>("select id::text from records.retention_hold where record_key = $1 and kind = 'DI_INVESTIGATION'", [`esig_stub:${stub}`])).rows[0]?.id;
    await withCommand(gmp.db.app, reason(await passwordActor(gmp.db, lead, terminalOf(gmp.seed, 'PC-QA-01').fingerprint)), async (c) => {
      await c.query('select kernel.audit_business_event($1, $2, $3)', [`esig_stub:${stub}`, 'hold note: still held for the review', JSON.stringify({ hold_id: holdId })]);
      await c.query('select kernel.audit_business_event($1, $2, $3)', [`esig_stub:${stub}`, 'entry reviewed for the open case', JSON.stringify({ investigation_id: investigation })]);
      // And one that names neither: the subject reads it like any colleague.
      await c.query('select kernel.audit_business_event($1, $2, $3)', [`esig_stub:${stub}`, 'sample label checked', JSON.stringify({ label: 'BU-4.98' })]);
    });
    expect(JSON.stringify(await events(leadBrowser, { chainKey: `esig_stub:${stub}` }))).toContain('entry reviewed for the open case');
    // The subject's own record still reads, without the entries the investigation wrote on its chain.
    const own = await events(subjectBrowser, { chainKey: `esig_stub:${stub}` });
    expect(outcome(own)).toBe('ok');
    if (own.ok) expect(own.value.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(own)).not.toMatch(/investigation|hold note|for the open case/i);
    expect(JSON.stringify(own)).toContain('sample label checked');
    // Nothing of the command that opened it, across the chains.
    const opened = await events(subjectBrowser, { correlationId: OPENED, limit: '200' });
    expect(outcome(opened)).toBe('ok');
    if (opened.ok) expect(opened.value.events).toEqual([]);
    const leadOpened = await events(leadBrowser, { correlationId: OPENED, limit: '200' });
    if (leadOpened.ok) expect(leadOpened.value.events.length).toBeGreaterThan(0);
  });

  it('[DI-17][DI-50] the subject reads neither the account and person chains of the persons who opened and lead it nor, in their activity, anything the investigation wrote; other colleagues\' it does', async () => {
    const none = { ok: true, status: 200, value: { events: [], nextCursor: null } };
    for (const p of [lead, investigator]) {
      // Their activity is served from the chains the subject may read (tablets 0530, default F35.3), without their
      // account and person chains and without the entries the investigation wrote.
      const activity = await events(subjectBrowser, { personId: p.personId, limit: '200' });
      expect(outcome(activity), p.legalName).toBe('ok');
      if (activity.ok) {
        const withheld = [...held, ...signing, `di_investigation:${investigation}`, ...[lead, investigator].flatMap((x) => [`account:${x.accountId}`, `person:${x.personId}`])];
        expect(activity.value.events.map((e) => e.chainKey).filter((k) => withheld.includes(k)), p.legalName).toEqual([]);
      }
      expect(JSON.stringify(activity), p.legalName).not.toContain('Suspected sharing of the QA reviewer password');
      expect(await events(subjectBrowser, { chainKey: `account:${p.accountId}` }), p.legalName).toEqual(none);
      expect(await events(subjectBrowser, { chainKey: `person:${p.personId}` }), p.legalName).toEqual(none);
    }
    const accounts = await chainKeys(subjectBrowser, 'account:');
    expect(accounts).not.toContain(`account:${lead.accountId}`);
    expect(accounts).not.toContain(`account:${investigator.accountId}`);
    // The rule is about this investigation only: the subject's governance role still reads a colleague's activity.
    const author = personaOf(gmp.seed, 'author');
    expect(accounts).toContain(`account:${author.accountId}`);
    expect(outcome(await events(subjectBrowser, { personId: author.personId }))).toBe('ok');
    expect(outcome(await events(subjectBrowser, { chainKey: `account:${author.accountId}` }))).toBe('ok');
  });

  it('[DI-17][DI-50] the database answers the subject\'s session on each of them as on a chain with no entries and drops the hold entries from a record\'s chain', async () => {
    const h = hashOf(gmp, subjectBrowser);
    const q = (sqlText: string, args: unknown[]) => gmp.db.app.query(sqlText, args);
    const hold = `record_hold:esig_stub:${stub}`;
    // As a chain with no entries reads (tablets 0530, default F35.3), never a refusal that would tell the subject.
    expect((await q('select * from tab.audit_events($1, $2, null, null, null, null, null, null, 50)', [h, hold])).rows).toEqual([]);
    expect((await q('select tab.audit_chain_length($1, $2) as n', [h, hold])).rows).toEqual([{ n: null }]);
    expect((await q('select * from tab.audit_registry_chains($1, $2)', [h, hold])).rows).toEqual([]);
    for (const p of [lead, investigator]) {
      const activity = (await q('select chain_key, payload from tab.audit_events($1, null, null, $2, null, null, null, null, 200)', [h, p.personId])).rows as { chain_key: string; payload: unknown }[];
      expect(activity.filter((r) => held.includes(r.chain_key) || signing.includes(r.chain_key) || r.chain_key === `di_investigation:${investigation}` || /hold_id|investigation_id/.test(JSON.stringify(r.payload)))).toEqual([]);
      expect((await q('select tab.audit_chain_length($1, $2) as n', [h, `account:${p.accountId}`])).rows).toEqual([{ n: null }]);
    }
    expect((await q("select chain_key from tab.audit_chains($1, 'record_hold:', 500)", [h])).rows.filter((r: { chain_key: string }) => held.includes(r.chain_key))).toEqual([]);
    expect((await q("select chain_key from tab.audit_chains($1, 'esig_', 500)", [h])).rows.filter((r: { chain_key: string }) => signing.includes(r.chain_key))).toEqual([]);
    // A subject without a governance role is refused such a chain as anyone in that role is, not told why.
    const author = hashOf(gmp, await gmp.asPersona('author'));
    await expect(q('select tab.audit_chain_length($1, $2)', [author, `account:${lead.accountId}`])).rejects.toThrow(/read only in a role that reviews audit trails[^]*EBMR-TAB-020/);
    // Without a limit the list keeps 0420's default of 500 chains (this installation has more than 50).
    expect(((await q('select count(*)::int as n from tab.audit_chains($1, null, null)', [hashOf(gmp, leadBrowser)])).rows[0] as { n: number }).n).toBeGreaterThan(50);
    const own = (await q('select action, payload from tab.audit_events($1, $2, null, null, null, null, null, null, 200)', [h, `esig_stub:${stub}`])).rows as { action: string; payload: unknown }[];
    expect(own.length).toBeGreaterThan(0);
    expect(own.filter((r) => JSON.stringify(r.payload).includes('DI_INVESTIGATION'))).toEqual([]);
    expect((await q('select * from tab.audit_events($1, null, $2, null, null, null, null, null, 200)', [h, OPENED])).rows).toEqual([]);
    // The lead's session reads the hold entry on the record's chain.
    const leadRows = (await q('select payload from tab.audit_events($1, $2, null, null, null, null, null, null, 200)', [hashOf(gmp, leadBrowser), `esig_stub:${stub}`])).rows;
    expect(leadRows.filter((r: { payload: unknown }) => /DI_INVESTIGATION|hold_id|investigation_id/.test(JSON.stringify(r.payload)))).toHaveLength(3);
    expect(own.filter((r) => /hold_id|investigation_id/.test(JSON.stringify(r.payload)))).toEqual([]);
  });

  it('[DI-17][DI-22][DI-50] the verification of a chain the subject reads names to them neither the account nor the terminal of an entry withheld from them, nor the chains of the persons who opened and lead it; the lead\'s names them (tablets 0470)', async () => {
    const h = hashOf(gmp, subjectBrowser);
    const leadHash = hashOf(gmp, leadBrowser);
    const registry = async (token: string, chainKey: string): Promise<string[]> =>
      (await gmp.db.app.query<{ c: string }>('select c from tab.audit_registry_chains($1, $2) c', [token, chainKey])).rows.map((r) => r.c);
    // A colleague who runs no part of the investigation notes it on the subject's record, from a design-office terminal.
    const checker = personaOf(gmp.seed, 'checker');
    const office = terminalOf(gmp.seed, 'PC-DESIGN-01');
    await withCommand(gmp.db.app, reason(await passwordActor(gmp.db, { ...checker }, office.fingerprint)), (c) =>
      c.query('select kernel.audit_business_event($1, $2, $3)', [`esig_stub:${stub}`, 'record copied to the case file', JSON.stringify({ investigation_id: investigation })]),
    );
    const qaTerminal = `device:${terminalOf(gmp.seed, 'PC-QA-01').deviceId}`;
    // The lead (not the subject of it) is named the account and terminal of every entry on the record's chain.
    expect(await registry(leadHash, `esig_stub:${stub}`)).toEqual(
      expect.arrayContaining([`account:${subject.accountId}`, `account:${lead.accountId}`, `account:${checker.accountId}`, qaTerminal, `device:${office.deviceId}`]),
    );
    // The subject: their own entry's account and terminal only; not the colleague's withheld note (account, terminal),
    // and not the lead's account, withheld from them, although the lead also wrote an entry they read.
    expect((await registry(h, `esig_stub:${stub}`)).sort()).toEqual([`account:${subject.accountId}`, qaTerminal].sort());
    // On the subject's own account chain the lead's hold entry is left out, and with it the lead's account.
    expect(await registry(leadHash, `account:${subject.accountId}`)).toContain(`account:${lead.accountId}`);
    const own = await registry(h, `account:${subject.accountId}`);
    expect(own.length).toBeGreaterThan(0);
    expect(own).not.toContain(`account:${lead.accountId}`);
    expect(own).not.toContain(`account:${investigator.accountId}`);
    // The route still verifies the record's chain for the subject.
    const verified = await subjectBrowser.call(routes.audit.verifyChain, { params: { chainKey: `esig_stub:${stub}` } });
    expect(outcome(verified)).toBe('ok');
    expect(JSON.stringify(verified)).not.toMatch(new RegExp(`${lead.accountId}|${checker.accountId}|${office.deviceId}`));
  });
});

/**
 * Round 3 of F35: with no session token the application role still had the kernel's readers of who acted on a chain
 * (iam.chain_persons: on an investigation's chain or the hold chain of the account it holds, the person who opened it;
 * on an account's chain, everyone who acted on it), on a row (iam.record_entry_persons), whether a chain exists
 * (kernel.checkpoint_chain refuses only a chain with no entries: tried on record_hold:account:<id> for each account, it
 * named the persons investigated), every entry of a time fault with its chain (platform.entries_in_time_fault_windows),
 * and the persons excluded from each signing (iam.segregation_evaluation: for a closure, the opener and the lead).
 * Tablets 0470 takes them away from the application role on both installations; the owner's tools still run them.
 */
describe('F35: the application role\'s readers of who acted on a chain (tablets 0470)', () => {
  it('[DI-17][DI-22][DI-50] without a session the application role learns no investigation, its subject or its opener from who acted on a chain or a row, from checkpointing a chain (refused only for a chain with no entries), from the entries of a time fault or from the persons excluded from a signing, on either installation; the owner still does', async () => {
    const chain = `di_investigation:${investigationId}`;
    // The owner's tools: the lead opened the investigation (its chain and its row).
    expect((await gmp.db.admin.query<{ p: string[] }>('select iam.chain_persons($1)::text[] as p', [chain])).rows[0]?.p).toContain(lead.personId);
    expect((await gmp.db.admin.query<{ p: string[] }>("select iam.record_entry_persons('records.di_investigation', $1)::text[] as p", [investigationId])).rows[0]?.p).toContain(lead.personId);
    expect((await gmp.db.admin.query('select count(*)::int as n from platform.entries_in_time_fault_windows()')).rows).toHaveLength(1);
    expect((await gmp.db.admin.query('select count(*)::int as n from iam.segregation_evaluation')).rows).toHaveLength(1);
    const owner = await gmp.db.admin.connect();
    try {
      await owner.query('begin');
      expect((await owner.query('select kernel.checkpoint_chain($1, $2) as id', [chain, 'review F35 test'])).rows).toHaveLength(1);
    } finally {
      await owner.query('rollback');
      owner.release();
    }
    // The application role, without a session, on GMP and in the sandbox (sandbox.mirror_application_privileges).
    for (const server of [gmp, sbx]) {
      const account = server === gmp ? personaOf(gmp.seed, 'author').accountId : personaOf(sbx.seed, 'verifier2').accountId;
      const id = server === gmp ? investigationId : randomUUID();
      for (const [sqlText, args] of [
        ['select iam.chain_persons($1)', [`di_investigation:${id}`]],
        ['select iam.chain_persons($1)', [`account:${account}`]],
        ["select iam.record_entry_persons('records.di_investigation', $1)", [id]],
        ['select kernel.checkpoint_chain($1, $2)', [`record_hold:account:${account}`, 'probe']],
        ['select * from platform.entries_in_time_fault_windows()', []],
        ['select subject, excluded_persons from iam.segregation_evaluation', []],
      ] as const) {
        await expect(server.db.app.query(sqlText, [...args]), `${server.kind}: ${sqlText} ${JSON.stringify(args)}`).rejects.toThrow(/permission denied/);
      }
    }
  });
});

/**
 * Round 4 of F34 and F35. (1) Tablets 0470 took kernel.checkpoint_chain away because it told whether a chain exists,
 * but the application role still verified any chain and compared any external anchor without a session. Asked about
 * the hold chain of an account (record_hold:account:<id>), kernel.verify_chain from a position past the end named one
 * problem at the chain's length for a held account and none for another, and from position 0 a gap for the held account
 * only; continuity.compare_external_anchors called a forged one-head anchor UNEXPLAINED for a held account and
 * DISCARDABLE for another. Listing the accounts and asking each named every person under investigation. (2) The person
 * an investigation is about, in a governance role, was told about it by the session-checked reads themselves: their own
 * account's hold chain was refused "not shown to the person of this session" (EBMR-TAB-020) in the events and in its
 * verification, where a colleague in the same role, asking about their own account, got an empty list and "no audit
 * entry"; a person filter on the investigation's opener was refused where the colleague's was served.
 *
 * Tablets 0530 takes the verification and the anchor comparison away from the application role on both installations
 * (the audit viewer verifies through the session-checked tab.audit_verify_chain; the owner's tools still verify and
 * compare), and answers everything withheld from the subject as an absent chain is (default F35.3): no entries, no
 * length, nothing to verify, no registry chains; a person filter on the opener or lead is served from the chains the
 * subject may read. A subject and a colleague in the same role get the same status, message and body shape.
 */
describe('F34, F35: the person a DI investigation is about, and whether a chain exists (tablets 0530)', () => {
  type Pair = {
    kind: 'GMP' | 'SANDBOX';
    server: TestServer;
    subject: GrantedPerson;
    control: GrantedPerson;
    opener: GrantedPerson;
    subjectBrowser: TestBrowser;
    controlBrowser: TestBrowser;
    openerBrowser: TestBrowser;
    investigation: string;
  };
  const pairs: Pair[] = [];
  const holdChain = (account: string): string => `record_hold:account:${account}`;
  const forgedAnchor = (account: string) => {
    const key = holdChain(account);
    return {
      anchor_id: '987654321',
      created_at: '2026-10-03T00:00:00.000000Z',
      merkle_root_hex: createHash('sha256').update(`${key}:1:00`).digest('hex'),
      heads: [{ chain_key: key, seq: '1', hash_hex: '00' }],
    };
  };

  /**
   * An answer as the person sees it (the value, or the refusal's status and text; a refusal's correlation id differs per
   * request), with the asker's own account id replaced, so a subject's and a colleague's compare.
   */
  const same = (r: Result<unknown>, own: string): string =>
    JSON.stringify(r.ok ? { ok: true, status: r.status, value: r.value } : r.error.kind === 'REFUSAL' ? { status: r.error.status, refusal: r.error.envelope.refusal, retryable: r.error.envelope.retryable } : r.error)
      .split(own)
      .join('<own>');
  /** Whether rows or an answer name anything withheld from the subject: a withheld chain, a hold or the investigation. */
  const namesWithheld = async (p: Pair, served: unknown): Promise<string[]> => {
    const w = (await p.server.db.admin.query<{ chains: string[]; holds: string[]; investigations: string[] }>(
      'select (w).chains, (w).holds, (w).investigations from (select tab.withheld_from($1) as w) x', [p.subject.personId],
    )).rows[0];
    const text = JSON.stringify(served);
    return [...(w?.chains ?? []), ...(w?.holds ?? []), ...(w?.investigations ?? [])].filter((x) => text.includes(`"${x}"`) || text.includes(`:${x}`));
  };

  beforeAll(async () => {
    for (const server of [gmp, sbx]) {
      // In the sandbox every person's name is a test label (DI-05).
      const label = (name: string): string => (server === sbx ? `TEST-${name}` : name);
      const opener = server === gmp ? lead : await grantedPerson(sbx, 'CSV_DI_LEAD', 'TEST-Dev Lead CSV-DI');
      const subject = await grantedPerson(server, 'QA_REVIEWER', label('Anil Kumar QA reviewer'));
      const control = await grantedPerson(server, 'QA_REVIEWER', label('Sunita Rao QA reviewer'));
      const fp = terminalOf(server.seed, server === gmp ? 'PC-QA-01' : 'TEST-PC-01').fingerprint;
      const investigation = await withCommand(server.db.app, reason(await passwordActor(server.db, opener, fp)), (c) =>
        records.openDiInvestigation(c, {
          subjectPersonId: subject.personId,
          windowFrom: new Date(Date.UTC(2000, 0, 1)),
          windowTo: new Date(Date.UTC(2100, 0, 1)),
          concern: 'Suspected sharing of a QA reviewer password',
        }),
      );
      pairs.push({
        kind: server.kind, server, subject, control, opener, investigation,
        subjectBrowser: await loginOf(server, subject),
        controlBrowser: await loginOf(server, control),
        openerBrowser: server === gmp ? leadBrowser : await loginOf(server, opener),
      });
    }
  });

  it('[DI-17][DI-50] through the routes, the subject\'s own hold chain, its verification and a person filter on the opener answer the subject as they answer a colleague in the same role about their own account', async () => {
    for (const p of pairs) {
      // The owner sees the hold on the subject's account (the chain the routes are asked about).
      expect((await p.server.db.admin.query('select 1 from kernel.audit_chain_head where chain_key = $1', [holdChain(p.subject.accountId)])).rows, p.kind).toHaveLength(1);
      const answers = async (b: TestBrowser, own: GrantedPerson) => ({
        events: same(await events(b, { chainKey: holdChain(own.accountId) }), own.accountId),
        verify: same(await b.call(routes.audit.verifyChain, { params: { chainKey: holdChain(own.accountId) } }), own.accountId),
        listed: await chainKeys(b, holdChain(own.accountId)),
        opener: outcome(await events(b, { personId: p.opener.personId, limit: '200' })),
      });
      const subject = await answers(p.subjectBrowser, p.subject);
      const control = await answers(p.controlBrowser, p.control);
      expect(subject, p.kind).toEqual(control);
      expect(control.events, p.kind).toBe(JSON.stringify({ ok: true, status: 200, value: { events: [], nextCursor: null } }));
      expect(control.verify, p.kind).toMatch(/"status":404[^]*"code":"AUDIT_CHAIN_NOT_FOUND"/);
      expect(control.listed, p.kind).toEqual([]);
      expect(control.opener, p.kind).toBe('ok');
      // What the person filter serves the subject: the opener's entries on chains the subject may read only, nothing
      // the investigation wrote; a colleague is served the investigation's entries too.
      expect(await namesWithheld(p, await events(p.subjectBrowser, { personId: p.opener.personId, limit: '200' })), p.kind).toEqual([]);
      expect(JSON.stringify(await events(p.controlBrowser, { personId: p.opener.personId, limit: '200' })), p.kind).toContain(`di_investigation:${p.investigation}`);
    }
  });

  it('[DI-17][DI-22][DI-50] the database answers the subject\'s session on its own hold chain as a colleague\'s on theirs (tab.audit_events, tab.audit_chain_length, tab.audit_registry_chains, tab.audit_verify_chain) and serves a person filter on the opener, on either installation', async () => {
    for (const p of pairs) {
      const q = (sqlText: string, args: unknown[]) => p.server.db.app.query(sqlText, args);
      const answers = async (b: TestBrowser, own: GrantedPerson) => {
        const h = hashOf(p.server, b);
        const key = holdChain(own.accountId);
        return {
          events: (await q('select * from tab.audit_events($1, $2, null, null, null, null, null, null, 50)', [h, key])).rows,
          length: (await q('select tab.audit_chain_length($1, $2) as n', [h, key])).rows,
          registry: (await q('select c from tab.audit_registry_chains($1, $2) c', [h, key])).rows,
          verify: (await q('select * from tab.audit_verify_chain($1, $2)', [h, key])).rows,
        };
      };
      const subject = await answers(p.subjectBrowser, p.subject);
      expect(subject, p.kind).toEqual(await answers(p.controlBrowser, p.control));
      expect(subject, p.kind).toEqual({ events: [], length: [{ n: null }], registry: [], verify: [] });
      // A person filter on the opener is served to both, never refused; the subject's holds nothing of the
      // investigation. On GMP the opener also opened the investigation of the MBR author (this file's set-up), which the
      // subject's governance role reads; in the sandbox the opener did nothing else the subject may read.
      const opener = async (b: TestBrowser) =>
        (await q('select chain_key, payload from tab.audit_events($1, null, null, $2, null, null, null, null, 200)', [hashOf(p.server, b), p.opener.personId])).rows as { chain_key: string }[];
      const served = await opener(p.subjectBrowser);
      expect(await namesWithheld(p, served), p.kind).toEqual([]);
      expect((await opener(p.controlBrowser)).map((r) => r.chain_key), p.kind).toContain(`di_investigation:${p.investigation}`);
      expect(served.some((r) => r.chain_key === `di_investigation:${investigationId}`), p.kind).toBe(p.kind === 'GMP');
    }
  });

  it('[DI-17][DI-22][DI-50] without a session the application role learns from no chain verification and no forged external anchor whether an account is held, on either installation; the owner\'s tools still tell a held account from another', async () => {
    for (const p of pairs) {
      const held = p.subject.accountId; // the investigation holds the subject's account
      const free = p.control.accountId;
      // The owner: verification past the end names the held chain's length, and a forged anchor tells the two apart.
      const owner = async (sqlText: string, args: unknown[]): Promise<unknown[]> => (await p.server.db.admin.query<Record<string, unknown>>(sqlText, args)).rows;
      expect(await owner('select seq::text from kernel.verify_chain($1, $2)', [holdChain(held), 1_000_000_000]), p.kind).toHaveLength(1);
      expect(await owner('select seq::text from kernel.verify_chain($1, $2)', [holdChain(free), 1_000_000_000]), p.kind).toEqual([]);
      expect(await owner('select status from continuity.compare_external_anchors($1::jsonb)', [JSON.stringify([forgedAnchor(held)])]), p.kind).toEqual([{ status: 'UNEXPLAINED' }]);
      expect(await owner('select status from continuity.compare_external_anchors($1::jsonb)', [JSON.stringify([forgedAnchor(free)])]), p.kind).toEqual([{ status: 'DISCARDABLE' }]);
      // The application role without a session (in the sandbox through sandbox.mirror_application_privileges).
      for (const account of [held, free]) {
        for (const [sqlText, args] of [
          ['select * from kernel.verify_chain($1, $2)', [holdChain(account), 1_000_000_000]],
          ['select * from kernel.verify_chain($1, $2)', [holdChain(account), 0]],
          ['select * from kernel.verify_chain($1)', [holdChain(account)]],
          ['select * from records.verify_chain($1)', [holdChain(account)]],
          ['select * from continuity.compare_external_anchors($1::jsonb)', [JSON.stringify([forgedAnchor(account)])]],
          ['select * from continuity.verify_external_anchors($1::jsonb)', [JSON.stringify([forgedAnchor(account)])]],
          ['select * from continuity.external_anchor_problems($1::jsonb)', [JSON.stringify(forgedAnchor(account))]],
        ] as const) {
          await expect(p.server.db.app.query(sqlText, [...args]), `${p.kind}: ${sqlText} ${account === held ? 'held' : 'free'}`).rejects.toThrow(/permission denied/);
        }
      }
    }
  });

  it('[DI-17][DI-22][DI-23] the audit viewer verifies a chain only through the session-checked tab.audit_verify_chain: no session (EBMR-TAB-018), a chain the role may not read (EBMR-TAB-020); a chain it may read is verified with its registry chains, and the route still verifies', async () => {
    const op = hashOf(sbx, operator);
    const v2 = personaOf(sbx.seed, 'verifier2');
    const q = (sqlText: string, args: unknown[]) => sbx.db.app.query(sqlText, args);
    await expect(q('select * from tab.audit_verify_chain($1, $2)', ['0'.repeat(64), `account:${v2.accountId}`])).rejects.toThrow(/EBMR-TAB-018/);
    await expect(q('select * from tab.audit_verify_chain($1, $2)', [op, `account:${v2.accountId}`])).rejects.toThrow(/EBMR-TAB-020/);
    const recordChain = (await chainKeys(operator))[0] ?? '';
    expect((await q('select * from tab.audit_verify_chain($1, $2)', [op, recordChain])).rows).toEqual([]);
    const verified = await operator.call(routes.audit.verifyChain, { params: { chainKey: recordChain } });
    expect(outcome(verified)).toBe('ok');
    if (verified.ok) expect(verified.value).toMatchObject({ chainKey: recordChain, ok: true, problems: [] });
  });

  it('[DI-17][DI-22][DI-23][DI-50] a withheld chain that does not verify still reads to the subject as a chain with no entries, as the colleague\'s own reads; the opener\'s verification names the tamper', async () => {
    for (const p of pairs) {
      const key = holdChain(p.subject.accountId);
      const q = (sqlText: string, args: unknown[]) => p.server.db.app.query(sqlText, args);
      const owner = await p.server.db.admin.connect();
      // The head row is kept aside in this connection and put back afterwards.
      await owner.query('create temporary table kept_head as select * from kernel.audit_chain_head where chain_key = $1', [key]);
      expect((await owner.query('select chain_key from kept_head')).rows, p.kind).toEqual([{ chain_key: key }]);
      // A superuser deletes the head row of the subject's hold chain (the tamper verification names, F06).
      const tamper = async (sqlText: string, args: unknown[]) => {
        await owner.query('begin');
        await owner.query('set local session_replication_role = replica');
        await owner.query(sqlText, args);
        await owner.query('commit');
      };
      await tamper('delete from kernel.audit_chain_head where chain_key = $1', [key]);
      try {
        const opener = hashOf(p.server, p.openerBrowser);
        expect((await q('select problem from tab.audit_verify_chain($1, $2) where not registry', [opener, key])).rows, p.kind).toEqual([
          { problem: 'chain head is missing although the chain has events (head deleted)' },
        ]);
        expect(((await q('select tab.audit_chain_length($1, $2) as n', [opener, key])).rows[0] as { n: string | null }).n, p.kind).not.toBeNull();
        const asks = async (b: TestBrowser, own: GrantedPerson) => ({
          verify: (await q('select * from tab.audit_verify_chain($1, $2)', [hashOf(p.server, b), holdChain(own.accountId)])).rows,
          length: (await q('select tab.audit_chain_length($1, $2) as n', [hashOf(p.server, b), holdChain(own.accountId)])).rows,
          route: same(await b.call(routes.audit.verifyChain, { params: { chainKey: holdChain(own.accountId) } }), own.accountId),
        });
        const subject = await asks(p.subjectBrowser, p.subject);
        expect(subject, p.kind).toEqual(await asks(p.controlBrowser, p.control));
        expect(subject.verify, p.kind).toEqual([]);
      } finally {
        await tamper('insert into kernel.audit_chain_head select * from kept_head', []);
        await owner.query('drop table kept_head');
        owner.release();
      }
      expect((await p.server.db.admin.query('select * from kernel.verify_chain($1)', [key])).rows, p.kind).toEqual([]);
    }
  });

  it('[DI-17][DI-22][DI-23][DI-50] the verification of a chain the subject reads checks no registry chain withheld from them: a tampered account chain of the opener is named to a colleague, not to the subject', async () => {
    // On GMP the opener also opened the investigation of the MBR author (this file's set-up): a chain both QA reviewers
    // read, whose registry chains include the opener's account, withheld from the subject.
    const p = pairs.find((x) => x.kind === 'GMP');
    if (!p) throw new Error('SETUP: no GMP pair');
    const chain = `di_investigation:${investigationId}`;
    const account = `account:${p.opener.accountId}`;
    const verify = async (b: TestBrowser) =>
      (await p.server.db.app.query<{ chain_key: string; problem: string }>('select chain_key, problem from tab.audit_verify_chain($1, $2)', [hashOf(p.server, b), chain])).rows;
    expect(await verify(p.subjectBrowser)).toEqual([]);
    expect(await verify(p.controlBrowser)).toEqual([]);
    const owner = await p.server.db.admin.connect();
    const tamper = async (sqlText: string) => {
      await owner.query('begin');
      await owner.query('set local session_replication_role = replica');
      await owner.query(sqlText, [account]);
      await owner.query('commit');
    };
    await owner.query('create temporary table kept_head as select * from kernel.audit_chain_head where chain_key = $1', [account]);
    await tamper('delete from kernel.audit_chain_head where chain_key = $1');
    try {
      expect(await verify(p.controlBrowser)).toEqual([{ chain_key: account, problem: 'chain head is missing although the chain has events (head deleted)' }]);
      expect(await verify(p.subjectBrowser)).toEqual([]);
    } finally {
      await tamper('insert into kernel.audit_chain_head select * from kept_head where chain_key = $1');
      await owner.query('drop table kept_head');
      owner.release();
    }
    expect(await verify(p.controlBrowser)).toEqual([]);
  });
});
