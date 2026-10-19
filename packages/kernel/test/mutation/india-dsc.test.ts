/**
 * Kill tests of the SQL mutation group "india-dsc" (kernel 1203, 1206; Phase 6 exit, decision 0019). The server verifies
 * a DSC before the database stores it; these tests call the database functions straight, as a server that skipped or
 * got its own check wrong would, and show that the database still refuses:
 * - an enrolment from an account that is not a personal (HUMAN) one: a service account, a break-glass account;
 * - an enrolment whose chain does not end at the live anchor, is only the anchor, or whose claimed signer certificate is
 *   not the chain's first; a signing DSC whose claimed certificate is the signer's enrolled one while the chain carries
 *   another certificate;
 * - a certificate enrolled live for one person enrolled again for another, while other enrolments have ended; and a new
 *   enrolment ends the person's previous one;
 * - an e-signature policy value outside its limits, of the wrong type or not among the allowed values;
 * - after the anchor is replaced, a chain to the retired anchor.
 *
 * Controls: IN-10 (India DSC: a Class 3 certificate signs for one person, against the configured anchor), DI-38 (the
 * signature is bound to its signer), DI-09 (e-signature policy is configuration within its limits).
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withCommand } from '../../src/db/command.ts';
import { dscEnrolmentStatement, dscRequirement, enrolDsc, verifyDsc, type DscSubmission } from '../../src/esig/dsc.ts';
import { createTestCa, issueTestSigner, signDscStatement, type TestCa, type TestCertificate } from '../../src/esig/dsc-test-ca.ts';
import { sign } from '../../src/esig/signing.ts';
import { withChangeRecord } from '../support/change-record.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { asTimeTraveller, challengeFor, cmd, createStub, ensureSealKey, expectRefused, qaApprover, signatureAuth, testActor, testSealKey } from '../esig/helpers.ts';
import { seedServiceActor, type SeededActor } from '../identity/seed.ts';

let db: TestDatabase;
let qa: SeededActor;
let ap: SeededActor;
let author: SeededActor;
let ca: TestCa;
let apCert: TestCertificate;
let now: Date;

const b64 = (b: Buffer): string => b.toString('base64');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const submission = (statement: string, cert: TestCertificate, chainCa: TestCa = ca): DscSubmission => ({
  signature: b64(signDscStatement(cert, statement)),
  chain: [b64(cert.der), b64(chainCa.subCa.der), b64(chainCa.root.der)],
});

async function asQa<T>(sql: string, params: unknown[]): Promise<T[]> {
  return withCommand(db.app, await withChangeRecord(db, { ...(await cmd(db, qa)) }), async (c) => (await c.query(sql, params)).rows as T[]);
}

/** What a server that verified the enrolment of `cert` (chain to `chainCa`) would hand the database, with `over` applied. */
async function enrolment(who: SeededActor, cert: TestCertificate, chainCa: TestCa = ca, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const statement = await dscEnrolmentStatement(db.app, who.personId, who.accountId);
  const sub = submission(statement, cert, chainCa);
  return { ...sub, ...verifyDsc(statement, sub, chainCa.root.der, now), ...over };
}

/** The database's enrolment function called straight, in the person's own command. */
const rawEnrol = async (who: SeededActor, payload: Record<string, unknown>): Promise<string> =>
  withCommand(db.app, await cmd(db, who), async (c) => (await c.query<{ id: string }>('select esig.enrol_dsc_certificate($1::jsonb) as id', [JSON.stringify(payload)])).rows[0]!.id);

/** The real enrolment, verified by the server first. */
async function enrol(who: SeededActor, cert: TestCertificate): Promise<string> {
  const statement = await dscEnrolmentStatement(db.app, who.personId, who.accountId);
  return withCommand(db.app, await cmd(db, who), (c) => enrolDsc(c, submission(statement, cert)));
}

const ended = async (enrolmentId: string): Promise<string[]> =>
  (await db.admin.query<{ reason: string }>('select reason from esig.dsc_enrolment_end where enrolment_id = $1', [enrolmentId])).rows.map((r) => r.reason);

beforeAll(async () => {
  db = await createTestDatabase();
  qa = await qaApprover(db);
  ap = await testActor(db, { roleCode: 'AUTHORISED_PERSON', legalName: 'Authorised Person' });
  author = await testActor(db, { roleCode: 'OPERATOR' });
  now = (await db.app.query<{ t: Date }>('select clock_timestamp() as t')).rows[0]!.t;
  ca = createTestCa(now);
  apCert = issueTestSigner(ca, 'Authorised Person (TEST Class 3)', now);
  await asQa(`select esig.register_dsc_anchor('TEST_CA', 'eBMR TEST CA', 'CN=eBMR TEST CA (not legally valid)', $1, 'mutation kill tests')`, [ca.root.der]);
  await asQa(`select esig.set_policy('esig.india_dsc', 'TEST_CA', 'India DSC with a test CA for the kill tests', 'CR-MUT-DSC')`, []);
  await enrol(ap, apCert);
}, 300_000);
afterAll(async () => {
  await db?.drop();
});

describe('the database refuses what the server should have refused (kernel 1206)', () => {
  it('[IN-10] a certificate is enrolled only from an active, personal account: a service and a break-glass account are refused', async () => {
    const own = /EBMR-ESIG-086 a DSC certificate is enrolled by its own person, from an active, personal \(HUMAN\) account/;
    const svc = await seedServiceActor(db);
    await expectRefused(rawEnrol(svc, await enrolment(svc, issueTestSigner(ca, 'Service identity', now))), 'EBMR-ESIG-086', own);
    const person = await testActor(db, { roleCode: 'OPERATOR', legalName: 'Generic Bina' });
    const cert = issueTestSigner(ca, 'Generic Bina (TEST Class 3)', now);
    // A break-glass account of the person is refused here; a generic one is refused earlier, by the actor context itself
    // (kernel 0190, which also refuses an account that is not ACTIVE or not the person's).
    // (A break-glass account acts only inside an approved, open window: one is arranged here.)
    await asTimeTraveller(db, 'update iam.account set is_break_glass = true where id = $1', [person.accountId]);
    await asTimeTraveller(db, `insert into iam.break_glass_window (account_id, requested_by_person, requested_by_account, reason, valid_minutes, approved_by_person,
                                                                  approved_by_account, approved_at, valid_to)
                               values ($1, $2, $3, 'emergency for the kill test', 60, $4, $5, clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour')`,
                          [person.accountId, person.personId, person.accountId, qa.personId, qa.accountId]);
    // Since kernel 1321 (slice 7b-1, 6jc-R6) the administrator refusal runs first, and a break-glass account counts as
    // one (DI-18): it is refused before the enrolment's own account check (EBMR-ESIG-086) is reached.
    await expectRefused(rawEnrol(person, await enrolment(person, cert)), 'EBMR-IAM-042');
    await asTimeTraveller(db, 'update iam.account set is_break_glass = false, is_generic = true where id = $1', [person.accountId]);
    await expectRefused(rawEnrol(person, await enrolment(person, cert)), 'EBMR-IAM-106');
    await asTimeTraveller(db, 'update iam.account set is_generic = false where id = $1', [person.accountId]);
    expect(await db.admin.query('select 1 from esig.dsc_enrolment where person_id = any($1)', [[svc.personId, person.personId]])).toMatchObject({ rowCount: 0 });
    // The same enrolment from the personal account is accepted.
    expect(await rawEnrol(person, await enrolment(person, cert))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[IN-10] an enrolment chain must end at the live anchor, be more than the anchor alone, and start with the claimed signer certificate', async () => {
    const who = await testActor(db, { roleCode: 'OPERATOR', legalName: 'Chain Chitra' });
    const cert = issueTestSigner(ca, 'Chain Chitra (TEST Class 3)', now);
    const other = createTestCa(now, 'Another CA');
    // A complete, valid chain of another CA.
    await expectRefused(rawEnrol(who, await enrolment(who, issueTestSigner(other, 'Stranger', now), other)), 'EBMR-ESIG-085', /does not end at the configured trust anchor/);
    // The anchor alone, claimed as the signer certificate.
    await expectRefused(rawEnrol(who, await enrolment(who, cert, ca, { chain: [b64(ca.root.der)], leafSha256: sha(ca.root.der) })), 'EBMR-ESIG-085', /does not end at the configured trust anchor/);
    // The chain of one certificate, claimed as another's.
    const someoneElse = issueTestSigner(ca, 'Someone Else (TEST Class 3)', now);
    await expectRefused(rawEnrol(who, await enrolment(who, cert, ca, { leafSha256: sha(someoneElse.der) })), 'EBMR-ESIG-085', /not the first of the chain/);
    expect(await db.admin.query('select 1 from esig.dsc_enrolment where person_id = $1', [who.personId])).toMatchObject({ rowCount: 0 });
    expect(await rawEnrol(who, await enrolment(who, cert))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('[IN-10][DI-38] a signing DSC that claims the signer\'s enrolled certificate while its chain carries another certificate is refused', async () => {
    await ensureSealKey(db);
    const impostor = issueTestSigner(ca, 'Impostor (TEST Class 3)', now);
    const record = async (claimed: string, cert: TestCertificate): Promise<string> => {
      const ch = await challengeFor(db, ap, await createStub(db, author), { meaning: 'MANUFACTURER_RELEASE' });
      const statement = (await dscRequirement(db.app, ch.challengeId)).statement ?? '';
      const ev = await signatureAuth(db, ap, ap, ch.challengeId);
      return withCommand(db.app, await cmd(db, ap), async (c) => {
        const s = await sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'OPEN' }, testSealKey);
        const sub = submission(statement, cert);
        await c.query('select esig.record_dsc_signature($1, $2::jsonb)', [s.signatureId, JSON.stringify({ ...sub, ...verifyDsc(statement, sub, ca.root.der, now), leafSha256: claimed })]);
        return s.signatureId;
      });
    };
    await expectRefused(record(sha(apCert.der), impostor), 'EBMR-ESIG-085', /not the first of the chain/);
    // The enrolled certificate itself signs.
    const sig = await record(sha(apCert.der), apCert);
    expect((await db.admin.query<{ l: string }>('select leaf_sha256 as l from esig.dsc_signature where signature_id = $1', [sig])).rows[0]?.l).toBe(sha(apCert.der));
  });

  it('[IN-10] a certificate live for one person is not enrolled for another while other enrolments have ended; a new enrolment ends the person\'s previous one', async () => {
    const first = await testActor(db, { roleCode: 'OPERATOR', legalName: 'First Farah' });
    const second = await testActor(db, { roleCode: 'OPERATOR', legalName: 'Second Sahil' });
    const certA = issueTestSigner(ca, 'First Farah (TEST Class 3)', now);
    const certB = issueTestSigner(ca, 'First Farah, new token (TEST Class 3)', now);
    const e1 = await rawEnrol(first, await enrolment(first, certA));
    // Another person's enrolment that has ended.
    const gone = await rawEnrol(second, await enrolment(second, issueTestSigner(ca, 'Second Sahil, old token', now)));
    await withCommand(db.app, await cmd(db, second), (c) => c.query('select esig.end_dsc_enrolment($1, $2)', [gone, 'token returned']));
    // The second person, holding the first person's token, cannot enrol it.
    await expectRefused(rawEnrol(second, await enrolment(second, certA)), 'EBMR-ESIG-086', /enrolled for another person/);
    // The first person's new token replaces the old one: the old enrolment is ended with the reason, the new one is live.
    const e2 = await rawEnrol(first, await enrolment(first, certB));
    expect(await ended(e1)).toEqual(['replaced by a new enrolment']);
    expect(await ended(e2)).toEqual([]);
    const live = (await db.app.query<{ l: { enrolmentId: string; live: boolean }[] }>('select esig.dsc_enrolments_of($1) as l', [first.personId])).rows[0]!.l;
    expect(live.map((x) => [x.enrolmentId, x.live])).toEqual([[e2, true], [e1, false]]);
  });
});

describe('e-signature policy values stay within their limits (esig.set_policy as kernel 1203 re-creates it)', () => {
  it('[DI-09] a value outside its limits, not a whole number, not true or false, not an allowed value, of an unknown key or without a reason is refused; the limits themselves are accepted', async () => {
    const set = (key: string, value: string, reason = 'kill test', ref = 'CR-MUT-POL') => asQa(`select esig.set_policy($1, $2, $3, $4)`, [key, value, reason, ref]);
    const current = async (key: string) => (await db.app.query<{ v: string }>('select esig.policy_text($1) as v', [key])).rows[0]?.v;
    await expectRefused(set('esig.no_such_key', '1'), 'EBMR-ESIG-002');
    await expectRefused(set('esig.witness_window_seconds', '300', '  '), 'EBMR-ESIG-005', /needs a reason and a change-control reference/);
    await expectRefused(set('esig.witness_window_seconds', '300', 'kill test', ' '), 'EBMR-ESIG-005', /needs a reason and a change-control reference/);
    await expectRefused(set('esig.witness_window_seconds', '5 min'), 'EBMR-ESIG-005', /takes a whole number/);
    await expectRefused(set('esig.witness_window_seconds', '59'), 'EBMR-ESIG-005', /must lie between 60 and 1800/);
    await expectRefused(set('esig.witness_window_seconds', '1801'), 'EBMR-ESIG-005', /must lie between 60 and 1800/);
    await set('esig.witness_window_seconds', '60');
    expect(await current('esig.witness_window_seconds')).toBe('60');
    await set('esig.witness_window_seconds', '1800');
    expect(await current('esig.witness_window_seconds')).toBe('1800');
    await set('esig.witness_window_seconds', '300');
    await expectRefused(set('esig.mfa_at_signing', 'yes'), 'EBMR-ESIG-005', /takes true or false/);
    await expectRefused(set('esig.india_dsc', 'ON'), 'EBMR-ESIG-005', /takes one of/);
    expect(await current('esig.mfa_at_signing')).toBe('false');
    expect(await current('esig.india_dsc')).toBe('TEST_CA');
  });
});

describe('the DSC functions as kernel 1321 re-creates them (Phase 7 exit, D-P7-1 item 4)', () => {
  const setMode = (mode: string) => asQa(`select esig.set_policy('esig.india_dsc', $1, 'India DSC mode for the kill tests', 'CR-MUT-DSC')`, [mode]);

  /** A password signature of `who` with `meaning` on a fresh stub, and the DSC call in the same command. */
  async function signWithDsc(who: SeededActor, meaning: string, dsc: (statement: string) => Record<string, unknown>): Promise<string> {
    await ensureSealKey(db);
    const ch = await challengeFor(db, who, await createStub(db, author), { meaning });
    const statement = esigStatement(ch.challengeId);
    const ev = await signatureAuth(db, who, who, ch.challengeId);
    const st = await statement;
    return withCommand(db.app, await cmd(db, who), async (c) => {
      const s = await sign(c, { challengeId: ch.challengeId, authEventId: ev, expectedState: 'OPEN' }, testSealKey);
      await c.query('select esig.record_dsc_signature($1, $2::jsonb)', [s.signatureId, JSON.stringify(dsc(st))]);
      return s.signatureId;
    });
  }
  const esigStatement = async (challengeId: string): Promise<string> =>
    (await db.admin.query<{ s: string }>('select esig.dsc_statement($1) as s', [challengeId])).rows[0]!.s;
  const apDsc = (statement: string, over: Record<string, unknown> = {}): Record<string, unknown> => {
    const sub = submission(statement, apCert);
    return { ...sub, ...verifyDsc(statement, sub, ca.root.der, now), ...over };
  };

  it('[IN-10] a chain of the signer certificate and the anchor alone is enough, for an enrolment and for a signing DSC', async () => {
    const who = await testActor(db, { roleCode: 'OPERATOR', legalName: 'Short Shalini' });
    const cert = issueTestSigner(ca, 'Short Shalini (TEST Class 3)', now);
    expect(await rawEnrol(who, await enrolment(who, cert, ca, { chain: [b64(cert.der), b64(ca.root.der)] }))).toMatch(/^[0-9a-f-]{36}$/);
    const sig = await signWithDsc(ap, 'MANUFACTURER_RELEASE', (st) => apDsc(st, { chain: [b64(apCert.der), b64(ca.root.der)] }));
    expect((await db.admin.query('select 1 from esig.dsc_signature where signature_id = $1', [sig])).rowCount).toBe(1);
  });

  it('[IN-10][DI-38] a chain that is not base64 DER is refused, for an enrolment and for a signing DSC', async () => {
    const who = await testActor(db, { roleCode: 'OPERATOR', legalName: 'Garbled Gita' });
    const cert = issueTestSigner(ca, 'Garbled Gita (TEST Class 3)', now);
    const bad = { chain: ['%%% not base64 %%%', b64(ca.root.der)] };
    await expectRefused(rawEnrol(who, await enrolment(who, cert, ca, bad)), 'EBMR-ESIG-085', /not base64 DER/);
    await expectRefused(signWithDsc(ap, 'MANUFACTURER_RELEASE', (st) => apDsc(st, bad)), 'EBMR-ESIG-085', /not base64 DER/);
    expect((await db.admin.query('select 1 from esig.dsc_enrolment where person_id = $1', [who.personId])).rowCount).toBe(0);
  });

  it('[IN-10][DI-38] a DSC is not recorded on a signing whose meaning needs none, even from an enrolled signer', async () => {
    const op = await testActor(db, { roleCode: 'OPERATOR', legalName: 'Enrolled Esha' });
    const cert = issueTestSigner(ca, 'Enrolled Esha (TEST Class 3)', now);
    await rawEnrol(op, await enrolment(op, cert));
    const dsc = (st: string): Record<string, unknown> => {
      const sub = submission(st, cert);
      return { ...sub, ...verifyDsc(st, sub, ca.root.der, now) };
    };
    await expectRefused(signWithDsc(op, 'PERFORMED', dsc), 'EBMR-ESIG-083', /no DSC is configured for PERFORMED/);
  });

  it('[IN-10] an enrolment ends only with a reason', async () => {
    const who = await testActor(db, { roleCode: 'OPERATOR', legalName: 'Reason Rekha' });
    const id = await rawEnrol(who, await enrolment(who, issueTestSigner(ca, 'Reason Rekha (TEST Class 3)', now)));
    await expectRefused(withCommand(db.app, await cmd(db, who), (c) => c.query('select esig.end_dsc_enrolment($1, $2)', [id, '   '])), 'EBMR-ESIG-088', /needs a reason/);
    expect(await ended(id)).toEqual([]);
  });

  it('[IN-10][DI-38] with the option off nothing is enrolled; with no live anchor nothing is enrolled and no DSC recorded', async () => {
    const who = await testActor(db, { roleCode: 'OPERATOR', legalName: 'Modal Meera' });
    const cert = issueTestSigner(ca, 'Modal Meera (TEST Class 3)', now);
    const payload = await enrolment(who, cert);
    try {
      await setMode('OFF');
      await expectRefused(rawEnrol(who, payload), 'EBMR-ESIG-086', /option is off/);
    } finally {
      await setMode('TEST_CA');
    }
    // The TEST_CA anchor retired with no successor (a writer that bypassed esig.register_dsc_anchor), then registered again.
    await withCommand(db.admin, await withChangeRecord(db, await cmd(db, qa)), (c) =>
      c.query(`insert into esig.dsc_trust_anchor_retirement (anchor_id, reason, retired_by_person, retired_by_account, correlation_id)
               select (esig.dsc_live_anchor('TEST_CA')).id, 'kill test: no live anchor', $1, $2, gen_random_uuid()`, [qa.personId, qa.accountId]));
    try {
      await expectRefused(rawEnrol(who, payload), 'EBMR-ESIG-082', /no live trust anchor/);
      await expectRefused(signWithDsc(ap, 'MANUFACTURER_RELEASE', (st) => apDsc(st)), 'EBMR-ESIG-082', /no live trust anchor/);
    } finally {
      await asQa(`select esig.register_dsc_anchor('TEST_CA', 'eBMR TEST CA', 'CN=eBMR TEST CA (not legally valid)', $1, 'kill test: anchor back')`, [ca.root.der]);
    }
    expect((await db.admin.query('select 1 from esig.dsc_enrolment where person_id = $1', [who.personId])).rowCount).toBe(0);
  });
});

describe('a replaced anchor is no longer trusted (kernel 1203)', () => {
  it('[IN-10] after a new anchor is registered, a chain to the retired anchor is refused and a chain to the new one enrolled', async () => {
    const next = createTestCa(now, 'eBMR TEST CA 2 (not legally valid)');
    await asQa(`select esig.register_dsc_anchor('TEST_CA', 'eBMR TEST CA 2', 'CN=eBMR TEST CA 2 (not legally valid)', $1, 'test CA rolled over')`, [next.root.der]);
    expect((await db.admin.query<{ h: string }>("select (esig.dsc_live_anchor('TEST_CA')).root_sha256 as h")).rows[0]?.h).toBe(sha(next.root.der));
    const who = await testActor(db, { roleCode: 'OPERATOR', legalName: 'Rollover Ravi' });
    await expectRefused(rawEnrol(who, await enrolment(who, issueTestSigner(ca, 'Rollover Ravi, old CA', now))), 'EBMR-ESIG-085', /does not end at the configured trust anchor/);
    expect(await rawEnrol(who, await enrolment(who, issueTestSigner(next, 'Rollover Ravi, new CA', now), next))).toMatch(/^[0-9a-f-]{36}$/);
  });
});
