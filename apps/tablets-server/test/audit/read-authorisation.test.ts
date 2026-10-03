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
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type AuditEventView, type Result } from '@ebmr/api-contract';
import { identity, records, withCommand, type ActorContext } from '@ebmr/kernel';
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
