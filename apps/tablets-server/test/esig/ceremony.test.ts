/**
 * The e-signature ceremony over HTTP (module C1; plan section 6; DI-19, DI-35, DI-36, DI-37, DI-38, INV-03,
 * INV-10, INV-26, INV-40). The signed records are the kernel's stub entries (aggregate esig_stub) through the
 * ESIG_STUB signable handler, wrapped here so a test can make `apply` fail after the seal.
 *
 * Kiosk: the signer taps for the challenge (attribution), then enters the PIN; office: user ID and password.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '@ebmr/expr';
import { routes, type SignatureCredentials } from '@ebmr/api-contract';
import { esigStubHandler } from '../../src/features/esig/stub.ts';
import { challengeBadges } from '../../src/features/esig/index.ts';
import { startServer, type TestBrowser, type TestServer } from '../support/harness.ts';
import { correctStub, createStub, outcome, personaIn, refusalOf, sessionOfBrowser, startSigningServer, tapFor, valueOf } from './support.ts';

let sbx: TestServer;
let gmp: TestServer;
let failApply = false;

beforeAll(async () => {
  [sbx, gmp] = await Promise.all([startSigningServer('SANDBOX', { stub: false }), startSigningServer('GMP')]);
  const base = esigStubHandler(sbx.built.ctx);
  sbx.built.ctx.signables.register({
    ...base,
    async apply(client, ctx, action, signature) {
      const result = await base.apply(client, ctx, action, signature);
      if (failApply) throw new Error('simulated failure after the seal (test)');
      return result;
    },
  });
});
afterAll(async () => {
  await Promise.all([sbx?.close(), gmp?.close()]);
});

const PATH = '/api/esig/challenges';

async function challengeFor(server: TestServer, b: TestBrowser, personaKey: string, stubId: string, meaning: string, opts: { clientContentHash?: string } = {}) {
  const content = valueOf(await b.call(routes.esig.content, { query: { aggregateType: 'esig_stub', aggregateId: stubId, intent: meaning } }));
  const body = {
    aggregateType: 'esig_stub',
    aggregateId: stubId,
    contentVersion: content.contentVersion,
    meaning,
    clientContentHash: opts.clientContentHash ?? sha256Hex(content.canonicalText),
    action: { kind: 'ESIG_STUB' as const, stubId },
  };
  const kiosk = b.terminal.includes('KIOSK');
  const r = await b.call(routes.esig.createChallenge, { body, ...(kiosk ? { attribution: await tapFor(b, personaIn(server, personaKey), 'POST', PATH, body) } : {}) });
  return { content, r };
}

async function sign(b: TestBrowser, challengeId: string, stubId: string, credentials: SignatureCredentials, proofFrom?: TestBrowser) {
  const body = { challengeId, credentials, action: { kind: 'ESIG_STUB' as const, stubId } };
  const proof = await (proofFrom ?? b).proof('POST', '/api/esig/sign', body);
  return b.call(routes.esig.sign, { body: { ...body, proof } });
}

const pinOf = (server: TestServer, key: string): SignatureCredentials => ({ kind: 'PIN', pin: personaIn(server, key).pin ?? '' });
const passwordOf = (server: TestServer, key: string): SignatureCredentials => ({ kind: 'PASSWORD', loginName: personaIn(server, key).loginName, password: personaIn(server, key).password });

async function signatureRows(server: TestServer, stubId: string): Promise<{ meaning_code: string; signer_person: string }[]> {
  return (await server.db.admin.query<{ meaning_code: string; signer_person: string }>("select meaning_code, signer_person from esig.signature where aggregate_ref = 'esig_stub:' || $1 order by recorded_at", [stubId])).rows;
}

async function stubState(server: TestServer, stubId: string) {
  return (await server.db.admin.query<{ state: string; content_version: string; value: string }>('select state, content_version::text, value from esig.stub_signable where id = $1', [stubId])).rows[0];
}

/** The signing-failure log of a challenge: the kernel's code, or the first word of the message for other refusals. */
async function failures(server: TestServer, challengeId: string): Promise<string[]> {
  const { rows } = await server.db.admin.query<{ code: string; message: string }>('select code, message from esig.signing_failure where challenge_id = $1 order by id', [challengeId]);
  return rows.map((r) => (r.code === 'UNKNOWN' ? `UNKNOWN:${r.message.split(' ')[0] ?? ''}` : r.code));
}

interface SigningAlert {
  severity: string;
  person_id: string | null;
  account_id: string | null;
  code: string | null;
  reported: string | null;
  event_purpose: string | null;
  event_person: string | null;
  event_account: string | null;
}

/** The security alerts raised for misuse at a challenge (DI-19), with the authentication event each one names. */
async function signingAlerts(server: TestServer, challengeId: string): Promise<SigningAlert[]> {
  const { rows } = await server.db.admin.query<SigningAlert>(
    `select a.severity, a.person_id::text, a.account_id::text, a.details ->> 'code' as code, a.details ->> 'reported_code' as reported,
            e.purpose as event_purpose, e.person_id::text as event_person, e.account_id::text as event_account
       from iam.security_alert a
       left join iam.auth_event e on e.id::text = a.details ->> 'auth_event_id' and e.challenge_id::text = a.details ->> 'challenge_id'
      where a.kind = 'SIGNING_FAILED' and a.details ->> 'challenge_id' = $1
      order by a.raised_at`,
    [challengeId],
  );
  return rows;
}

describe('kiosk ceremony', () => {
  let op: TestBrowser;
  let ver: TestBrowser;
  beforeAll(async () => {
    op = await sbx.asPersona('operator1');
    ver = await sbx.asPersona('verifier1');
  });

  it('[DI-36][DI-35][DI-38] the manifestation names legal name, user ID, role, meaning and zone before signing, and carries date and time with offset and zone after', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const me = personaIn(sbx, 'operator1');
    const { content, r } = await challengeFor(sbx, op, 'operator1', stub, 'PERFORMED');
    expect(content).toMatchObject({ meaning: 'PERFORMED', meaningText: 'I performed this step and recorded its data.', preview: false, rendering: { kind: 'fallback' } });
    expect(sha256Hex(content.canonicalText)).toBe(content.contentHash);
    const ch = valueOf(r);
    expect(ch.manifestation).toEqual({ legalName: me.legalName, loginName: me.loginName, role: 'OPERATOR', meaning: 'PERFORMED', meaningText: 'Performed by', zone: 'Asia/Kolkata' });
    expect(ch.requires).toEqual(['PIN']);
    expect(ch.expiresInSeconds).toBeGreaterThan(100);
    expect(ch.expiresInSeconds).toBeLessThanOrEqual(120);
    expect(ch.expiresAt.text).toMatch(/^\d{2}-[A-Z]{3}-\d{4} \d{2}:\d{2}:\d{2} \+05:30 \(Asia\/Kolkata\)$/);
    const signed = valueOf(await sign(op, ch.challengeId, stub, pinOf(sbx, 'operator1')));
    expect(signed.manifestation).toMatchObject({
      signer: { personId: me.personId, legalName: me.legalName, loginName: me.loginName, role: 'OPERATOR' },
      meaning: 'PERFORMED',
      meaningText: 'Performed by',
      zone: 'Asia/Kolkata',
      valid: true,
      aggregateType: 'esig_stub',
      aggregateId: stub,
      contentVersion: content.contentVersion,
      contentHash: content.contentHash,
    });
    expect(signed.manifestation.signedAt.text).toMatch(/^\d{2}-[A-Z]{3}-\d{4} \d{2}:\d{2}:\d{2} \+05:30 \(Asia\/Kolkata\)$/);
    expect(BigInt(signed.manifestation.signedAt.us)).toBeLessThan(BigInt(ch.expiresAt.us));
    // The listing renders the same stored manifestation; the seal and the signing command are there.
    const list = valueOf(await op.call(routes.esig.signatures, { query: { aggregateType: 'esig_stub', aggregateId: stub } }));
    expect(list.signatures).toEqual([signed.manifestation]);
    const seal = await sbx.db.admin.query('select 1 from esig.signature_seal where signature_id = $1', [signed.manifestation.signatureId]);
    expect(seal.rowCount).toBe(1);
    // The badge of the challenge's tap is dropped once used.
    expect(challengeBadges(sbx.built.ctx).peek(ch.challengeId, (await sessionOfBrowser(sbx, op)).tokenHash, me.personId)).toBeNull();
  });

  it('[INV-03][DI-35] a person who entered data cannot sign VERIFIED: refused in plain language, nothing signed, the failure logged', async () => {
    const stub = await createStub(sbx, ver, 'verifier1');
    const ch1 = valueOf((await challengeFor(sbx, op, 'operator1', stub, 'PERFORMED')).r);
    valueOf(await sign(op, ch1.challengeId, stub, pinOf(sbx, 'operator1')));
    const ch2 = valueOf((await challengeFor(sbx, ver, 'verifier1', stub, 'VERIFIED')).r);
    const r = refusalOf(await sign(ver, ch2.challengeId, stub, pinOf(sbx, 'verifier1')));
    expect(r).toMatchObject({ status: 422, code: 'EBMR-ESIG-044', kind: 'INDEPENDENCE', whatHappened: 'You cannot verify or witness work you performed, entered data in or corrected. Nothing was signed.' });
    expect(r.why).toMatch(/INV-03/);
    expect((await signatureRows(sbx, stub)).map((s) => s.meaning_code)).toEqual(['PERFORMED']);
    expect(await failures(sbx, ch2.challengeId)).toEqual(['EBMR-ESIG-044']);
    expect((await stubState(sbx, stub))?.state).toBe('OPEN');
  });

  it('[DI-35][DI-36][INV-26] an independent verifier signs VERIFIED and the entry completes; every signature stores its authority evaluation', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    valueOf(await sign(op, valueOf((await challengeFor(sbx, op, 'operator1', stub, 'PERFORMED')).r).challengeId, stub, pinOf(sbx, 'operator1')));
    const ch = valueOf((await challengeFor(sbx, ver, 'verifier1', stub, 'VERIFIED')).r);
    expect(ch.manifestation).toMatchObject({ role: 'VERIFIER', meaningText: 'Verified by' });
    const signed = valueOf(await sign(ver, ch.challengeId, stub, pinOf(sbx, 'verifier1')));
    expect(signed.result).toEqual({ stubId: stub, state: 'COMPLETED' });
    expect((await stubState(sbx, stub))?.state).toBe('COMPLETED');
    const evals = await sbx.db.admin.query<{ allowed: boolean }>(
      "select e.allowed from esig.signature s join iam.authority_evaluation e on e.id = s.authority_evaluation_id where s.aggregate_ref = 'esig_stub:' || $1",
      [stub],
    );
    expect(evals.rows.map((x) => x.allowed)).toEqual([true, true]);
  });

  it('[DI-38][DI-19] a wrong PIN signs nothing and counts toward lockout; the right PIN then signs within the same challenge', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const me = personaIn(sbx, 'operator1');
    const ch = valueOf((await challengeFor(sbx, op, 'operator1', stub, 'PERFORMED')).r);
    const before = Number((await sbx.db.admin.query<{ n: string }>('select iam.consecutive_failures($1)::text as n', [me.accountId])).rows[0]?.n);
    expect(refusalOf(await sign(op, ch.challengeId, stub, { kind: 'PIN', pin: '000000' }))).toMatchObject({ status: 401, kind: 'AUTH_FAILED' });
    expect(Number((await sbx.db.admin.query<{ n: string }>('select iam.consecutive_failures($1)::text as n', [me.accountId])).rows[0]?.n)).toBe(before + 1);
    expect(await signatureRows(sbx, stub)).toEqual([]);
    expect(await failures(sbx, ch.challengeId)).toEqual(['EBMR-IAM-140']);
    expect(outcome(await sign(op, ch.challengeId, stub, pinOf(sbx, 'operator1')))).toBe('ok');
  });

  it('[DI-19][DI-38] repeated wrong PINs at signing lock the account at the policy count and end its sessions', async () => {
    const qa = await sbx.asPersona('qa1');
    const me = personaIn(sbx, 'qa1');
    const stub = await createStub(sbx, qa, 'qa1');
    const ch = valueOf((await challengeFor(sbx, qa, 'qa1', stub, 'PERFORMED')).r);
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) seen.push(outcome(await sign(qa, ch.challengeId, stub, { kind: 'PIN', pin: '111111' })));
    expect(seen).toEqual(['401:EBMR-IAM-140', '401:EBMR-IAM-140', '401:EBMR-IAM-140', '401:EBMR-IAM-140', '423:AUTH_LOCKED']);
    expect((await sbx.db.admin.query<{ l: boolean }>('select iam.account_locked($1) as l', [me.accountId])).rows[0]?.l).toBe(true);
    expect(outcome(await qa.call(routes.session.get))).toBe('401:NO_SESSION');
    expect(await signatureRows(sbx, stub)).toEqual([]);
  });

  it('[DI-37] a client hash that is not the server\'s gives EBMR-ESIG-013 CONTENT_CHANGED; a change after the content was read gives it too', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const bad = await challengeFor(sbx, op, 'operator1', stub, 'PERFORMED', { clientContentHash: 'ab'.repeat(32) });
    expect(refusalOf(bad.r)).toMatchObject({ status: 409, code: 'EBMR-ESIG-013', kind: 'CONTENT_CHANGED', whatHappened: 'The record changed while you were reviewing it. Nothing was signed.' });
    // The record changes between reading the content and asking for the challenge.
    const content = valueOf(await op.call(routes.esig.content, { query: { aggregateType: 'esig_stub', aggregateId: stub, intent: 'PERFORMED' } }));
    await correctStub(sbx, op, 'operator1', stub, '12.530');
    const body = { aggregateType: 'esig_stub', aggregateId: stub, contentVersion: content.contentVersion, meaning: 'PERFORMED', clientContentHash: sha256Hex(content.canonicalText), action: { kind: 'ESIG_STUB' as const, stubId: stub } };
    const r = refusalOf(await op.call(routes.esig.createChallenge, { body, attribution: await tapFor(op, personaIn(sbx, 'operator1'), 'POST', PATH, body) }));
    expect(r).toMatchObject({ status: 409, kind: 'CONTENT_CHANGED' });
    expect(['EBMR-ESIG-012', 'EBMR-ESIG-013']).toContain(r.code);
  });

  it('[DI-37][INV-10] a record changed after the challenge answers CONTENT_CHANGED at signing; nothing is signed and the entry keeps its new content', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const ch = valueOf((await challengeFor(sbx, op, 'operator1', stub, 'PERFORMED')).r);
    await correctStub(sbx, op, 'operator1', stub, '12.531');
    const r = refusalOf(await sign(op, ch.challengeId, stub, pinOf(sbx, 'operator1')));
    expect(r).toMatchObject({ status: 409, code: 'CONTENT_CHANGED', kind: 'CONTENT_CHANGED' });
    expect(await signatureRows(sbx, stub)).toEqual([]);
    expect(await stubState(sbx, stub)).toEqual({ state: 'OPEN', content_version: '2', value: '12.531' });
    expect(await failures(sbx, ch.challengeId)).toEqual(['UNKNOWN:CONTENT_CHANGED']);
  });

  it('[INV-10] a dry-run refusal creates no signature: the committed command holds only its attempt records, never a change to the record', async () => {
    const other = await sbx.asPersona('verifier2', 'TEST-KIOSK-DISP-1');
    const stub = await createStub(sbx, op, 'operator1');
    const before = await stubState(sbx, stub);
    const auditBefore = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from kernel.audit_event where chain_key in ('esig_stub:' || $1, 'esig_signature:esig_stub:' || $1)", [stub]);
    const ch = valueOf((await challengeFor(sbx, other, 'verifier2', stub, 'VERIFIED')).r);
    const r = refusalOf(await sign(other, ch.challengeId, stub, pinOf(sbx, 'verifier2')));
    expect(r).toMatchObject({ status: 422, code: 'ESIG_STUB_ORDER' });
    expect(await signatureRows(sbx, stub)).toEqual([]);
    expect(await stubState(sbx, stub)).toEqual(before);
    const auditAfter = await sbx.db.admin.query<{ n: string }>("select count(*)::text as n from kernel.audit_event where chain_key in ('esig_stub:' || $1, 'esig_signature:esig_stub:' || $1)", [stub]);
    expect(auditAfter.rows[0]?.n).toBe(auditBefore.rows[0]?.n);
    // The refused command committed: its signature authentication was used once to attribute it, never to sign.
    const uses = await sbx.db.admin.query<{ use_kind: string }>(
      "select u.use_kind from iam.auth_event e join iam.auth_event_use u on u.auth_event_id = e.id where e.challenge_id = $1 order by u.use_kind",
      [ch.challengeId],
    );
    expect(uses.rows.map((u) => u.use_kind)).toEqual(['COMMAND']);
    expect(await failures(sbx, ch.challengeId)).toEqual(['UNKNOWN:ESIG_STUB_ORDER']);
    // That committed use is the refused attempt's own: the rightful signer is not reported for re-using it.
    expect(await signingAlerts(sbx, ch.challengeId)).toEqual([]);
  });

  it('[INV-10] a failure after the seal rolls everything back: no signature, no seal, the authentication event unconsumed, the entry unchanged', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    valueOf(await sign(op, valueOf((await challengeFor(sbx, op, 'operator1', stub, 'PERFORMED')).r).challengeId, stub, pinOf(sbx, 'operator1')));
    const ch = valueOf((await challengeFor(sbx, ver, 'verifier1', stub, 'VERIFIED')).r);
    failApply = true;
    try {
      const r = refusalOf(await sign(ver, ch.challengeId, stub, pinOf(sbx, 'verifier1')));
      expect(r).toMatchObject({ status: 500, code: 'INTERNAL', kind: 'NOT_SAVED' });
    } finally {
      failApply = false;
    }
    expect((await signatureRows(sbx, stub)).map((s) => s.meaning_code)).toEqual(['PERFORMED']);
    expect((await stubState(sbx, stub))?.state).toBe('OPEN');
    const uses = await sbx.db.admin.query('select 1 from iam.auth_event e join iam.auth_event_use u on u.auth_event_id = e.id where e.challenge_id = $1', [ch.challengeId]);
    expect(uses.rowCount).toBe(0);
    expect(await failures(sbx, ch.challengeId)).toEqual(['UNKNOWN:simulated']);
    // A new ceremony signs normally.
    const again = valueOf((await challengeFor(sbx, ver, 'verifier1', stub, 'VERIFIED')).r);
    expect(valueOf(await sign(ver, again.challengeId, stub, pinOf(sbx, 'verifier1'))).result).toEqual({ stubId: stub, state: 'COMPLETED' });
  });

  it('[DI-38] an expired challenge signs nothing', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const ch = valueOf((await challengeFor(sbx, op, 'operator1', stub, 'PERFORMED')).r);
    const c = await sbx.db.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query("update esig.challenge set expires_at = clock_timestamp() - interval '1 second' where id = $1", [ch.challengeId]);
      await c.query('commit');
    } finally {
      c.release();
    }
    const r = refusalOf(await sign(op, ch.challengeId, stub, pinOf(sbx, 'operator1')));
    expect(r).toMatchObject({ status: 409, code: 'EBMR-ESIG-033', kind: 'STALE' });
    expect(await signatureRows(sbx, stub)).toEqual([]);
  });

  it('[DI-38][DI-20] a kiosk signs with the PIN only after its own tap; a password, another terminal\'s proof or another session\'s challenge is refused', async () => {
    const stub = await createStub(sbx, op, 'operator1');
    const ch = valueOf((await challengeFor(sbx, op, 'operator1', stub, 'PERFORMED')).r);
    expect(outcome(await sign(op, ch.challengeId, stub, passwordOf(sbx, 'operator1')))).toBe('422:LOGIN_METHOD');
    expect(refusalOf(await sign(op, ch.challengeId, stub, pinOf(sbx, 'operator1'), sbx.browser('TEST-KIOSK-BLEND-1')))).toMatchObject({ status: 403, details: { reason: 'OTHER_TERMINAL' } });
    expect(outcome(await sign(ver, ch.challengeId, stub, pinOf(sbx, 'verifier1')))).toBe('409:EBMR-ESIG-031');
    expect(await signatureRows(sbx, stub)).toEqual([]);
  });
});

describe('office ceremony', () => {
  it('[DI-38][DI-36] an office signature needs user ID and password of the signer; a PIN, a wrong password or another person\'s credentials sign nothing', async () => {
    const author = await gmp.asPersona('author');
    const checker = await gmp.asPersona('checker');
    const approver = await gmp.asPersona('approver');
    const stub = await createStub(gmp, author, 'author', { kind: 'MASTER_DOCUMENT', title: 'Paracetamol 500 mg MBR section 5', value: 'v1' });
    const prepared = valueOf((await challengeFor(gmp, author, 'author', stub, 'PREPARED')).r);
    expect(prepared.requires).toEqual(['USER_ID', 'PASSWORD']);
    valueOf(await sign(author, prepared.challengeId, stub, passwordOf(gmp, 'author')));
    const ch = valueOf((await challengeFor(gmp, checker, 'checker', stub, 'CHECKED')).r);
    expect(outcome(await sign(checker, ch.challengeId, stub, { kind: 'PIN', pin: '123456' }))).toBe('422:LOGIN_METHOD');
    expect(refusalOf(await sign(checker, ch.challengeId, stub, { kind: 'PASSWORD', loginName: personaIn(gmp, 'checker').loginName, password: 'Wrong-Password-1' }))).toMatchObject({ status: 401, kind: 'AUTH_FAILED' });
    expect(refusalOf(await sign(checker, ch.challengeId, stub, passwordOf(gmp, 'approver')))).toMatchObject({ status: 403, code: 'EBMR-IAM-093', kind: 'INDEPENDENCE' });
    expect((await signatureRows(gmp, stub)).map((s) => s.meaning_code)).toEqual(['PREPARED']);
    const checked = valueOf(await sign(checker, ch.challengeId, stub, passwordOf(gmp, 'checker')));
    expect(checked.manifestation).toMatchObject({ meaning: 'CHECKED', meaningText: 'Independently checked by', signer: { loginName: 'vikram.shah', legalName: 'Vikram Shah', role: 'MBR_CHECKER' } });
    const approved = valueOf(await sign(approver, valueOf((await challengeFor(gmp, approver, 'approver', stub, 'APPROVED')).r).challengeId, stub, passwordOf(gmp, 'approver')));
    expect(approved.result).toEqual({ stubId: stub, state: 'COMPLETED' });
    const all = valueOf(await approver.call(routes.esig.signatures, { query: { aggregateType: 'esig_stub', aggregateId: stub } }));
    expect(all.signatures.map((s) => `${s.meaning}:${s.signer.loginName}:${s.valid}`)).toEqual(['PREPARED:asha.rao:true', 'CHECKED:vikram.shah:true', 'APPROVED:meera.iyer:true']);
    // The proxy attempt reached the security unit (DI-19): one HIGH alert for the checker's challenge, naming the
    // approver, whose SIGNATURE authentication for that challenge the committed rows show as misuse.
    const proxy = personaIn(gmp, 'approver');
    expect(await signingAlerts(gmp, ch.challengeId)).toEqual([
      { severity: 'HIGH', person_id: proxy.personId, account_id: proxy.accountId, code: 'EBMR-IAM-093', reported: 'EBMR-IAM-093', event_purpose: 'SIGNATURE', event_person: proxy.personId, event_account: proxy.accountId },
    ]);
    const violations = await gmp.db.admin.query('select * from esig.invariant_violations()');
    expect(violations.rows).toEqual([]);
  });

  it('[DI-35] only catalogue meanings can be asked for; an unknown meaning is refused before anything is recorded', async () => {
    const author = await gmp.asPersona('author');
    const stub = await createStub(gmp, author, 'author', { kind: 'MASTER_DOCUMENT' });
    expect(outcome(await author.call(routes.esig.content, { query: { aggregateType: 'esig_stub', aggregateId: stub, intent: 'ACKNOWLEDGED_BY_CLICK' } }))).toBe('422:EBMR-ESIG-026');
    expect(outcome(await author.call(routes.esig.content, { query: { aggregateType: 'esig_stub', aggregateId: randomUUID(), intent: 'PREPARED' } }))).toBe('404:ESIG_CONTENT_NOT_FOUND');
  });
});

describe('ESIG_STUB is DEMO-ONLY', () => {
  it('[DI-05] the stub signable is registered only on a demo installation', async () => {
    const plain = await startServer('SANDBOX');
    const demo = await startServer('SANDBOX', { demoMarker: true, env: { EBMR_DEMO: '1' } });
    try {
      expect(plain.built.ctx.signables.forKind('ESIG_STUB')).toBeUndefined();
      expect(demo.built.ctx.signables.forKind('ESIG_STUB')).toBeDefined();
      const b = await plain.asPersona('issuer');
      const body = { aggregateType: 'esig_stub', aggregateId: randomUUID(), contentVersion: '1', meaning: 'PERFORMED', clientContentHash: 'ab'.repeat(32), action: { kind: 'ESIG_STUB' as const, stubId: randomUUID() } };
      expect(outcome(await b.call(routes.esig.createChallenge, { body }))).toMatch(/^(503:SIGNING_NOT_CONFIGURED|422:SIGNABLE_NOT_ENABLED)$/);
    } finally {
      await Promise.all([plain.close(), demo.close()]);
    }
  });
});
