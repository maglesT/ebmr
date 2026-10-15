/**
 * India DSC second signature with a TEST CA (kernel 1203; IN-10, decision 0001 item 3, D-P6f-3, D-P6f-4). The test CA is
 * generated here; no private key of a real CA exists in the repository. Everything runs as the application role, with
 * bypass attempts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { dscRequirement, recordDsc, TEST_CA_BANNER, type DscSubmission } from '../../src/esig/dsc.ts';
import { createTestCa, issueTestCertificate, issueTestSigner, signDscStatement, type TestCa, type TestCertificate } from '../../src/esig/dsc-test-ca.ts';
import { sign } from '../../src/esig/signing.ts';
import { withChangeRecord } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import {
  challengeFor,
  cmd,
  createStub,
  dbCount,
  ensureSealKey,
  expectPermissionDenied,
  expectRefused,
  qaApprover,
  signatureAuth,
  testActor,
  testSealKey,
} from './helpers.ts';
import type { SeededActor } from '../identity/seed.ts';

let db: TestDatabase;
let qa: SeededActor;
let ap: SeededActor;
let author: SeededActor;
let ca: TestCa;
let signerCert: TestCertificate;

const b64 = (b: Buffer): string => b.toString('base64');
const goodDsc = (statement: string, cert: TestCertificate = signerCert, chainCa: TestCa = ca): DscSubmission => ({
  signature: b64(signDscStatement(cert, statement)),
  chain: [b64(cert.der), b64(chainCa.subCa.der), b64(chainCa.root.der)],
});

async function asQa<T>(sql: string, params: unknown[], change = false): Promise<T[]> {
  const ctx = { ...(await cmd(db, qa)) };
  return withCommand(db.app, change ? await withChangeRecord(db, ctx) : ctx, async (c) => (await c.query(sql, params)).rows as T[]);
}

/** Challenge, authenticate, then sign and record the DSC in one command, as the server does. */
async function signRelease(stubId: string, dsc: (statement: string) => DscSubmission | undefined, meaning = 'MANUFACTURER_RELEASE'): Promise<string> {
  await ensureSealKey(db);
  const ch = await challengeFor(db, ap, stubId, { meaning });
  const req = await dscRequirement(db.app, ch.challengeId);
  const ev = await signatureAuth(db, ap, ap, ch.challengeId);
  return withCommand(db.app, await cmd(db, ap), async (c) => {
    const s = await sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'OPEN' }, testSealKey);
    await recordDsc(c, s.signatureId, req.statement ? dsc(req.statement) : undefined);
    return s.signatureId;
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  qa = await qaApprover(db);
  ap = await testActor(db, { roleCode: 'AUTHORISED_PERSON', legalName: 'Authorised Person' });
  author = await testActor(db, { roleCode: 'OPERATOR' });
  const { rows } = await db.app.query<{ t: Date }>('select clock_timestamp() as t');
  const now = rows[0]?.t as Date;
  ca = createTestCa(now);
  signerCert = issueTestSigner(ca, 'Authorised Person (TEST Class 3)', now);
});
afterAll(async () => {
  await db?.drop();
});

describe('India DSC with a test CA (kernel 1203; IN-10)', () => {
  it('[IN-10] the DSC is off by default; LICENSED is refused until a licensed provider is configured; TEST_CA needs its anchor', async () => {
    const stub = await createStub(db, author);
    const { rows } = await db.app.query<{ m: string; v: string[] }>(`select esig.dsc_mode() as m, (select allowed_values from esig.policy_values() where key = 'esig.india_dsc') as v`);
    expect(rows[0]).toEqual({ m: 'OFF', v: ['OFF', 'TEST_CA', 'LICENSED'] });
    // Off: a release signs without any DSC.
    expect(await signRelease(stub, () => undefined)).toMatch(/[0-9a-f-]{36}/);
    await expectRefused(asQa(`select esig.set_policy('esig.india_dsc', 'LICENSED', 'licensed CA', 'CR')`, [], true), 'EBMR-ESIG-091');
    await expectRefused(asQa(`select esig.set_policy('esig.india_dsc', 'TEST_CA', 'test CA', 'CR')`, [], true), 'EBMR-ESIG-092');
    await expectRefused(asQa(`select esig.register_dsc_anchor('LICENSED', 'CCA root', 'CN=CCA India', $1, 'go live')`, [ca.root.der]), 'EBMR-ESIG-091');
    const admin = await testActor(db, { roleCode: 'SYSTEM_ADMINISTRATOR', acknowledgeEsig: false });
    await expectRefused(withCommand(db.app, await cmd(db, admin), (c) => c.query(`select esig.register_dsc_anchor('TEST_CA', 'x', 'y', $1, 'z')`, [ca.root.der])), 'EBMR-IAM-040');
    await asQa(`select esig.register_dsc_anchor('TEST_CA', 'eBMR TEST CA', 'CN=eBMR TEST CA (not legally valid)', $1, 'demo and validation tests')`, [ca.root.der]);
    await asQa(`select esig.set_policy('esig.india_dsc', 'TEST_CA', 'demo of the India DSC option with a test CA', 'CR-TEST-FIXTURE')`, [], true);
    expect((await db.app.query<{ m: string }>('select esig.dsc_mode() as m')).rows[0]?.m).toBe('TEST_CA');
  });

  it('[IN-10] a release signed with a DSC validates against the CA root chain (test CA), stored beside the password signature', async () => {
    const stub = await createStub(db, author);
    const ch = await challengeFor(db, ap, stub, { meaning: 'MANUFACTURER_RELEASE' });
    const req = await dscRequirement(db.app, ch.challengeId);
    expect(req).toMatchObject({ required: true, mode: 'TEST_CA', banner: TEST_CA_BANNER });
    const st = JSON.parse(req.statement ?? '{}') as Record<string, string>;
    expect(st).toMatchObject({ format: 'EBMR-DSC-1', challenge_id: ch.challengeId, aggregate_id: stub, meaning: 'MANUFACTURER_RELEASE', content_sha256: ch.contentHash });
    const sig = await signRelease(stub, (s) => goodDsc(s));
    const { rows } = await db.app.query<{ d: Record<string, string>; same: boolean }>(
      `select esig.dsc_of($1) as d, (select d.statement_sha256 = encode(sha256(convert_to(d.statement, 'UTF8')), 'hex')
                                           and d.statement like '%' || s.content_hash || '%'
                                      from esig.dsc_signature d join esig.signature s on s.id = d.signature_id where d.signature_id = $1) as same`, [sig]);
    expect(rows[0]?.same).toBe(true);
    expect(rows[0]?.d).toMatchObject({ mode: 'TEST_CA', anchorLabel: 'eBMR TEST CA', leafSerial: expect.any(String) });
    expect(rows[0]?.d['leafSubject']).toContain('TEST Class 3');
    // A meaning not configured for a DSC (a QC approval) signs as before.
    await asQa(`select esig.set_dsc_meaning('MANUFACTURER_RELEASE', false, 'release signed by password only for this test')`, []);
    expect(await signRelease(await createStub(db, author), () => undefined)).toMatch(/[0-9a-f-]{36}/);
    await asQa(`select esig.set_dsc_meaning('MANUFACTURER_RELEASE', true, 'back to the default proposal')`, []);
  });

  it('[IN-10] a broken chain is refused and nothing is signed', async () => {
    const before = await dbCount(db, 'select 1 from esig.signature');
    const { rows } = await db.app.query<{ t: Date }>('select clock_timestamp() as t');
    const now = rows[0]?.t as Date;
    const other = createTestCa(now, 'Another CA');
    const stranger = issueTestSigner(other, 'Stranger', now);
    // A chain to another root.
    await expectRefused(signRelease(await createStub(db, author), (s) => goodDsc(s, stranger, other)), 'EBMR-ESIG-095', /trust anchor/);
    // The right root, but a sub-CA from another CA: the chain is broken.
    await expectRefused(signRelease(await createStub(db, author), (s) => ({ signature: b64(signDscStatement(stranger, s)), chain: [b64(stranger.der), b64(other.subCa.der), b64(ca.root.der)] })), 'EBMR-ESIG-095', /broken chain/);
    // The intermediate left out.
    await expectRefused(signRelease(await createStub(db, author), (s) => ({ signature: b64(signDscStatement(signerCert, s)), chain: [b64(signerCert.der), b64(ca.root.der)] })), 'EBMR-ESIG-095', /broken chain/);
    // An expired signer certificate.
    const old = issueTestCertificate({ subject: { commonName: 'Expired' }, issuer: ca.subCa, ca: false, notBefore: new Date(now.getTime() - 3e10), notAfter: new Date(now.getTime() - 1e10) });
    await expectRefused(signRelease(await createStub(db, author), (s) => goodDsc(s, old)), 'EBMR-ESIG-095', /not valid at the time/);
    // A sub-CA "certificate" forged with the signer's own key.
    const forged = issueTestCertificate({ subject: { commonName: 'Forged' }, issuer: ca.subCa, ca: false, notBefore: new Date(now.getTime() - 1e8), notAfter: new Date(now.getTime() + 1e10), signingKey: signerCert.privateKey });
    await expectRefused(signRelease(await createStub(db, author), (s) => goodDsc(s, forged)), 'EBMR-ESIG-095', /broken chain/);
    expect(await dbCount(db, 'select 1 from esig.signature')).toBe(before);
  });

  it('[IN-10] a DSC over another content hash, or none, is refused; nothing is signed', async () => {
    const before = await dbCount(db, 'select 1 from esig.signature');
    const stub = await createStub(db, author);
    await expectRefused(signRelease(stub, (s) => goodDsc(s.replace(/"content_sha256":"[0-9a-f]{64}"/, `"content_sha256":"${'0'.repeat(64)}"`))), 'EBMR-ESIG-095', /content hash/);
    await expectRefused(signRelease(stub, (s) => ({ ...goodDsc(s), signature: b64(signDscStatement(signerCert, `${s} `)) })), 'EBMR-ESIG-095');
    await expectRefused(signRelease(stub, () => undefined), 'EBMR-ESIG-094');
    expect(await dbCount(db, 'select 1 from esig.signature')).toBe(before);
  });

  it('[IN-10] bypass attempts as the application role: no direct DSC row, no replay, no commit of a release without its DSC', async () => {
    const stub = await createStub(db, author);
    const earlier = await signRelease(stub, (s) => goodDsc(s));
    await expectPermissionDenied(db.app.query(`insert into esig.dsc_signature select * from esig.dsc_signature where signature_id = $1`, [earlier]));
    await expectPermissionDenied(db.app.query(`delete from esig.dsc_signature where signature_id = $1`, [earlier]));
    // Recording a DSC for a signature made in an earlier command is refused (no replay onto another signature).
    const row = (await db.admin.query<{ chain: Buffer[]; v: Buffer }>('select chain_der as chain, signature_value as v from esig.dsc_signature where signature_id = $1', [earlier])).rows[0];
    await expectRefused(withCommand(db.app, await cmd(db, ap), (c) => c.query('select esig.record_dsc_signature($1, $2::jsonb)', [earlier, JSON.stringify({ signature: b64(row?.v ?? Buffer.alloc(0)), chain: (row?.chain ?? []).map(b64), leafSha256: '0'.repeat(64) })])), 'EBMR-ESIG-093');
    // Signing without the server's DSC step: the commit is refused.
    await ensureSealKey(db);
    const stub2 = await createStub(db, author);
    const ch = await challengeFor(db, ap, stub2, { meaning: 'MANUFACTURER_RELEASE' });
    const ev = await signatureAuth(db, ap, ap, ch.challengeId);
    await expectRefused(withCommand(db.app, await cmd(db, ap), (c) => sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'OPEN' }, testSealKey)), 'EBMR-ESIG-094');
    // The database checks the chain's end itself, whatever the server says.
    const ch3 = await challengeFor(db, ap, await createStub(db, author), { meaning: 'MANUFACTURER_RELEASE' });
    const ev3 = await signatureAuth(db, ap, ap, ch3.challengeId);
    await expectRefused(withCommand(db.app, await cmd(db, ap), async (c) => {
      const s = await sign(c, { challengeId: ch3.challengeId, authEventId: ev3, expectedState: 'OPEN' }, testSealKey);
      await c.query('select esig.record_dsc_signature($1, $2::jsonb)', [s.signatureId, JSON.stringify({ signature: b64(Buffer.alloc(256, 1)), chain: [b64(signerCert.der), b64(Buffer.alloc(100, 7))], leafSha256: '0'.repeat(64), algorithm: 'rsa-sha256', leafSubject: 'x', leafSerial: '1', leafValidFrom: '2026-01-01T00:00:00Z', leafValidTo: '2027-01-01T00:00:00Z' })]);
    }), 'EBMR-ESIG-095', /trust anchor/);
  });
});
