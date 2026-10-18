/**
 * Vendor support grants (DI-08), the India DSC step with a test CA (IN-10) and the contract giver's reviewer (IN-30) over
 * HTTP (Phase 6 slice 6f, feature governance and the esig DSC routes). Real sessions, real signatures sealed by the
 * server's key; the test CA is generated here.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type Result, type SignableAction, type SignatureCredentials } from '@ebmr/api-contract';
import { sha256Hex } from '@ebmr/expr';
import { esig, identity, withCommand } from '@ebmr/kernel';
import { passwordActor, terminalOf } from '@ebmr/test-kit';
import { ensureFixtureChangeRecord, FIXTURE_CHANGE_RECORD } from '../../../../packages/kernel/test/support/change-record.ts';
import type { TestDatabase } from '../../../../packages/kernel/test/support/db.ts';
import { personaIn, startSigningServer } from '../esig/support.ts';
import { grantedPerson, loginOf, type GrantedPerson } from '../support/granted-person.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { tokenHash } from '../../src/platform/auth/session.ts';

const S = routes.support;
let server: TestServer;
let admin: TestBrowser;
let qa: TestBrowser;
let itOwner: GrantedPerson;
let it_: TestBrowser;

const valueOf = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`expected success, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const codeOf = (r: Result<unknown>): string => (r.ok ? 'OK' : ((r.error as { envelope?: { refusal?: { code?: string } } }).envelope?.refusal?.code ?? JSON.stringify(r.error)));

/** The ceremony for `action` by browser `b` with `credentials`, the DSC made by `dsc` when the challenge asks for one. */
async function sign(b: TestBrowser, action: SignableAction, credentials: SignatureCredentials, dsc?: (statement: string) => { signature: string; chain: string[] } | undefined): Promise<{ result: Result<unknown>; banner: string | null | undefined }> {
  const d = valueOf(await b.call(routes.esig.describe, { body: { action } }));
  const preview = valueOf(await b.call(routes.esig.content, { query: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, intent: d.meaning ?? '' } }));
  const challenge = valueOf(await b.call(routes.esig.createChallenge, {
    body: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, contentVersion: preview.contentVersion, meaning: d.meaning ?? '', clientContentHash: sha256Hex(preview.canonicalText), action },
  }));
  const made = challenge.dsc && dsc ? dsc(challenge.dsc.statement) : undefined;
  const body = { challengeId: challenge.challengeId, credentials, action, ...(made ? { dsc: made } : {}) };
  return { result: await b.call(routes.esig.sign, { body: { ...body, proof: await b.proof('POST', '/api/esig/sign', body) } }), banner: challenge.dsc?.banner };
}

const password = (p: { loginName: string; password: string }): SignatureCredentials => ({ kind: 'PASSWORD', loginName: p.loginName, password: p.password });

/** A named vendor engineer holding VENDOR_SUPPORT; the initial secret is changed only inside a grant. */
async function engineer(): Promise<{ accountId: string; personId: string; loginName: string; secret: string }> {
  const adminActor = await passwordActor(server.db, server.seed.bootstrap.admin, server.seed.bootstrap.admin.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'vendor engineer', correlationId: randomUUID() });
  const ownerActor = await passwordActor(server.db, server.seed.bootstrap.owner, server.seed.bootstrap.owner.fingerprint, { reasonCode: 'TEST_SETUP', reasonText: 'vendor engineer', correlationId: randomUUID() });
  const loginName = `vendor.${randomUUID().slice(0, 8)}`;
  const created = await withCommand(server.db.app, adminActor, async (c) => {
    const personId = await identity.createPerson(c, 'NATURAL', 'Acme Support Engineer');
    await identity.recordIdentityVerification(c, { personId, purpose: 'INITIAL', method: 'IN_PERSON_DOCUMENT', documentType: 'Vendor ID card', evidenceRef: `V-${loginName}`, occurredAt: new Date(Date.UTC(2026, 0, 5)).toISOString() });
    const accountId = await identity.createAccount(c, { personId, loginName, kind: 'HUMAN' });
    const { secret } = await identity.issueInitialSecret(c, accountId, 'PASSWORD');
    await identity.activateAccount(c, accountId);
    const grantId = await identity.requestRoleGrant(c, { accountId, roleCode: 'VENDOR_SUPPORT', reason: 'named vendor support engineer' });
    return { personId, accountId, secret, grantId };
  });
  await withCommand(server.db.app, ownerActor, (c) => identity.decideRoleGrant(c, created.grantId, true, 'vendor support role'));
  return { accountId: created.accountId, personId: created.personId, loginName, secret: created.secret };
}

const office = () => terminalOf(server.seed, 'PC-QA-01').fingerprint;

beforeAll(async () => {
  server = await startSigningServer('GMP', { stub: false });
  const adm = await grantedPerson(server, 'SYSTEM_ADMINISTRATOR', 'IT Administrator');
  admin = await loginOf(server, adm);
  qa = await server.asPersona('approver');
  itOwner = await grantedPerson(server, 'PROCESS_OWNER', 'IT System Owner');
  const ack = await passwordActor(server.db, { ...itOwner }, office(), { correlationId: randomUUID() });
  await withCommand(server.db.app, ack, (c) => identity.acknowledgeEsigPolicy(c));
  it_ = await loginOf(server, itOwner);
}, 300_000);
afterAll(async () => {
  await server?.close();
});

describe('vendor support grants over HTTP (DI-08)', () => {
  it('[DI-08] a support login without a time-boxed grant is refused; QA and IT approve through the ceremony and the engineer logs in inside the window; a revocation ends it', async () => {
    const e = await engineer();
    const tryLogin = () => identity.authenticate(server.db.authn, { method: 'PASSWORD', identifier: e.loginName, secret: e.secret, deviceFingerprint: office(), purpose: 'LOGIN' });
    await expect(tryLogin()).rejects.toThrow(/SUPPORT_NO_LIVE_GRANT/);
    const g = valueOf(await admin.call(S.requestGrant, { body: { accountId: e.accountId, vendor: 'Acme MES Support', purpose: 'Diagnose the label printer queue', hours: 2 } }));
    expect(g).toMatchObject({ state: 'PENDING', approvals: [], validFrom: null, loginName: e.loginName });
    // QA cannot request one; the requester cannot approve.
    expect(codeOf(await qa.call(S.requestGrant, { body: { accountId: e.accountId, vendor: 'x', purpose: 'y', hours: 1 } }))).toMatch(/EBMR-IAM-040|EBMR-IAM-185/);
    expect((await sign(qa, { kind: 'SUPPORT_ACT', act: 'QA_APPROVE', grantId: g.grantId }, password(personaIn(server, 'approver')))).result.ok).toBe(true);
    await expect(tryLogin()).rejects.toThrow(/SUPPORT_NO_LIVE_GRANT/);
    expect((await sign(it_, { kind: 'SUPPORT_ACT', act: 'IT_APPROVE', grantId: g.grantId }, password(itOwner))).result.ok).toBe(true);
    const active = valueOf(await admin.call(S.grants)).grants.find((x) => x.grantId === g.grantId)!;
    expect(active).toMatchObject({ state: 'ACTIVE', approvals: [{ kind: 'IT' }, { kind: 'QA' }].sort((a, b) => a.kind.localeCompare(b.kind)) });
    expect(active.validFrom).not.toBeNull();
    // Inside the window: the engineer sets a password and signs in.
    const ev = await tryLogin();
    const pw = `Vendor-${randomUUID()}`;
    await identity.changeSecret(server.db.authn, { authEventId: ev.authEventId, kind: 'PASSWORD', newSecret: pw, loginName: e.loginName });
    const vendor = await loginOf(server, { personId: e.personId, accountId: e.accountId, loginName: e.loginName, legalName: 'Acme Support Engineer', roleCode: 'VENDOR_SUPPORT', password: pw });
    expect(valueOf(await vendor.call(routes.session.get)).role).toBe('VENDOR_SUPPORT');
    // QA ends it early: the support session no longer works.
    expect(valueOf(await qa.call(S.revokeGrant, { params: { grantId: g.grantId }, body: { reason: 'Work finished' } })).state).toBe('REVOKED');
    const after = await vendor.call(routes.session.get);
    expect(after.ok).toBe(false);
  }, 300_000);
});

describe('the India DSC step with a test CA over HTTP (IN-10)', () => {
  it('[IN-10] a signature whose meaning needs a DSC validates against the configured test-CA chain; a broken chain or no DSC is refused; the banner says not legally valid', async () => {
    const fixtureDb: Pick<TestDatabase, 'admin'> = { admin: server.db.admin };
    await ensureFixtureChangeRecord(fixtureDb);
    expect(valueOf(await qa.call(routes.esig.dscConfiguration)).mode).toBe('OFF');
    const now = new Date((await server.db.app.query<{ t: Date }>('select clock_timestamp() as t')).rows[0]!.t);
    const ca = esig.createTestCa(now);
    const signer = esig.issueTestSigner(ca, 'Meera Iyer (TEST Class 3)', now);
    const change = { changeRecord: FIXTURE_CHANGE_RECORD, reason: 'Demo of the India DSC option with a test CA' };
    expect(codeOf(await qa.call(routes.esig.setDscMode, { body: { mode: 'LICENSED', ...change } }))).toBe('EBMR-ESIG-081');
    valueOf(await qa.call(routes.esig.registerDscAnchor, { body: { kind: 'TEST_CA', label: 'eBMR TEST CA', rootCertificate: ca.root.der.toString('base64'), ...change } }));
    valueOf(await qa.call(routes.esig.setDscMeaning, { body: { meaning: 'SUPPORT_ACCESS_QA_APPROVED', required: true, ...change } }));
    const cfg = valueOf(await qa.call(routes.esig.setDscMode, { body: { mode: 'TEST_CA', ...change } }));
    expect(cfg).toMatchObject({ mode: 'TEST_CA', banner: esig.TEST_CA_BANNER });
    const e = await engineer();
    const g = valueOf(await admin.call(S.requestGrant, { body: { accountId: e.accountId, vendor: 'Acme', purpose: 'Database health check', hours: 1 } }));
    const act: SignableAction = { kind: 'SUPPORT_ACT', act: 'QA_APPROVE', grantId: g.grantId };
    const creds = password(personaIn(server, 'approver'));
    const good = (statement: string) => ({ signature: esig.signDscStatement(signer, statement).toString('base64'), chain: [signer.der, ca.subCa.der, ca.root.der].map((d) => d.toString('base64')) });
    // Kernel 1206: only the certificate enrolled for the signer is accepted; the token signs the enrolment statement.
    const notEnrolled = await sign(qa, act, creds, good);
    expect(codeOf(notEnrolled.result)).toBe('EBMR-ESIG-087');
    const enr = valueOf(await qa.call(routes.esig.dscEnrolment));
    expect(enr).toMatchObject({ banner: esig.TEST_CA_BANNER, enrolments: [] });
    const enrolled = valueOf(await qa.call(routes.esig.enrolDsc, { body: { dsc: good(enr.statement ?? '') } }));
    expect(enrolled.enrolments).toEqual([expect.objectContaining({ live: true, leafSubject: expect.stringContaining('Meera Iyer') as unknown })]);
    // Nobody else enrols the same certificate; an administrator enrols none at all (kernel 1321, 6jc-R6, DI-18).
    const enrOther = valueOf(await it_.call(routes.esig.dscEnrolment));
    expect(codeOf(await it_.call(routes.esig.enrolDsc, { body: { dsc: good(enrOther.statement ?? '') } }))).toBe('EBMR-ESIG-086');
    const enrAdmin = valueOf(await admin.call(routes.esig.dscEnrolment));
    expect(codeOf(await admin.call(routes.esig.enrolDsc, { body: { dsc: good(enrAdmin.statement ?? '') } }))).toBe('EBMR-IAM-042');
    const none = await sign(qa, act, creds, () => undefined);
    expect(none.banner).toBe(esig.TEST_CA_BANNER);
    expect(codeOf(none.result)).toBe('EBMR-ESIG-084');
    const other = esig.createTestCa(now, 'Another CA');
    const broken = await sign(qa, act, creds, (s) => ({ ...good(s), chain: [signer.der, other.subCa.der, ca.root.der].map((d) => d.toString('base64')) }));
    expect(codeOf(broken.result)).toBe('EBMR-ESIG-085');
    const wrongHash = await sign(qa, act, creds, (s) => good(s.replace(/"content_sha256":"[0-9a-f]{64}"/, `"content_sha256":"${'0'.repeat(64)}"`)));
    expect(codeOf(wrongHash.result)).toBe('EBMR-ESIG-085');
    const ok = await sign(qa, act, creds, good);
    expect(ok.result.ok).toBe(true);
    const { rows } = await server.db.admin.query<{ mode: string }>(
      "select d.mode from esig.dsc_signature d join esig.signature s on s.id = d.signature_id where s.aggregate_type = 'support_grant' and s.aggregate_id = $1", [g.grantId]);
    expect(rows).toEqual([{ mode: 'TEST_CA' }]);
    // The signer ends their own enrolment.
    const ended = valueOf(await qa.call(routes.esig.endDscEnrolment, { body: { enrolmentId: enrolled.enrolments[0]!.enrolmentId, reason: 'test over' } }));
    expect(ended.enrolments[0]?.live).toBe(false);
    valueOf(await qa.call(routes.esig.setDscMode, { body: { mode: 'OFF', ...change } }));
  }, 300_000);

  // Phase 6 mutation triage (T7): the server is the only place that reads the X.509 of a trust anchor (the database
  // stores the DER and its subject but does not parse it), so this refusal has no database twin.
  it('[IN-10] a trust anchor is only a self-signed certification-authority root: a sub-CA, a signer\'s certificate or bytes that are no certificate are refused and nothing is stored', async () => {
    await ensureFixtureChangeRecord({ admin: server.db.admin });
    const now = new Date((await server.db.app.query<{ t: Date }>('select clock_timestamp() as t')).rows[0]!.t);
    const ca = esig.createTestCa(now, 'Refused Anchor CA');
    const signer = esig.issueTestSigner(ca, 'Refused Anchor Signer (TEST Class 3)', now);
    const change = { changeRecord: FIXTURE_CHANGE_RECORD, reason: 'Anchors that are not self-signed CA roots' };
    const label = `refused anchor ${randomUUID().slice(0, 8)}`;
    // A sub-CA is a CA but not self-signed; the signer's certificate is neither; 300 bytes of 'A' are no DER at all.
    for (const der of [ca.subCa.der, signer.der, Buffer.alloc(300, 0x41)]) {
      expect(codeOf(await qa.call(routes.esig.registerDscAnchor, { body: { kind: 'TEST_CA', label, rootCertificate: der.toString('base64'), ...change } }))).toBe('EBMR-ESIG-080');
    }
    const { rows } = await server.db.admin.query<{ n: number }>('select count(*)::integer as n from esig.dsc_trust_anchor where label = $1', [label]);
    expect(rows[0]!.n).toBe(0);
  }, 120_000);
});

describe('the contract giver\'s reviewer over HTTP (IN-30)', () => {
  it('[IN-30] a contract-giver reviewer cannot edit: every write route of the installation is refused to its session', async () => {
    const reviewer = await grantedPerson(server, 'CONTRACT_GIVER_REVIEWER', 'Contract Giver Reviewer');
    const b = await loginOf(server, reviewer);
    expect(valueOf(await b.call(routes.contractGiver.batches)).batches).toEqual([]);
    const own = new Set(['session.get', 'session.chooseRole', 'session.logout', 'access.lock', 'access.unlock', 'access.switchUser', 'access.keepAlive', 'session.login']);
    type R = { id: string; method: string; path: string; mutating: boolean; installation: string };
    const all: R[] = [];
    for (const ns of Object.values(routes) as Record<string, R>[]) all.push(...Object.values(ns));
    const writes = all.filter((r) => r.mutating && !own.has(r.id) && r.installation !== 'SANDBOX');
    expect(writes.length).toBeGreaterThan(100);
    // Each is refused before any command runs: by the reviewer's scope, or (for a body the route cannot take) by its schema.
    const allowed: string[] = [];
    let scoped = 0;
    for (const r of writes) {
      const url = r.path.replace(/:[A-Za-z]+/g, randomUUID());
      const res = await b.inject({ method: r.method, url, payload: {}, headers: { 'idempotency-key': randomUUID() } });
      const code = res.json<{ refusal?: { code?: string } }>().refusal?.code;
      if (code === 'CONTRACT_GIVER_SCOPE') scoped += 1;
      if (res.statusCode < 400 || (code !== 'CONTRACT_GIVER_SCOPE' && code !== 'SCHEMA')) allowed.push(`${r.id} ${res.statusCode} ${code ?? ''}`);
    }
    expect(allowed).toEqual([]);
    expect(scoped).toBeGreaterThan(5);
    // Nothing was recorded under the reviewer's account but its sessions.
    const { rows } = await server.db.admin.query<{ n: string }>(
      "select count(*)::text as n from kernel.audit_event where payload -> 'actor' ->> 'account_id' = $1 and table_name not like 'iam.%' and table_name not like 'tab.%'", [reviewer.accountId]);
    expect(rows[0]?.n).toBe('0');
  }, 600_000);

  it('[IN-30] the database\'s record reads refuse the contract giver\'s reviewer: its loan licence is read through its own logged reads only (6jc-R3, tablets 1425)', async () => {
    const reviewer = await grantedPerson(server, 'CONTRACT_GIVER_REVIEWER', 'Contract Giver Reviewer');
    const b = await loginOf(server, reviewer);
    const hashOf = (x: TestBrowser): string => tokenHash(x.cookies.get(server.config.cookies.session) ?? '');
    const problem = async (x: TestBrowser, type: string, id: string): Promise<string | null> =>
      (await server.db.admin.query<{ p: string | null }>('select tab.record_read_problem(tab.reader_of($1), $2, $3) as p', [hashOf(x), type, id])).rows[0]?.p ?? null;
    // The role holds RECORD.READ, but no RECORD-class or governance record is read here in it (a batch step, an MBR, an
    // audit chain's record); QA reads the same record.
    for (const type of ['batch_step', 'mbr_version', 'batch_review', 'deviation', 'di_investigation']) {
      expect(await problem(b, type, randomUUID()), type).toMatch(/contract giver's reviewer reads only the batches of its loan licence, through its own logged reads \(IN-30\)/);
    }
    expect(await problem(qa, 'batch_step', randomUUID())).toBeNull();
    // Through the application's own connection too (a direct call of the read definers, no route in between).
    await expect(server.db.app.query('select * from tab.record_signatures($1, $2, $3)', [hashOf(b), 'mbr_version', randomUUID()])).rejects.toThrow(/EBMR-TAB-020/);
  });
});
