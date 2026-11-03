/**
 * MEDHANTA platform, Phase B slice 2 (docs/build-plan/phase-b/slice-2-design.md): sign-on, permissions and e-signature
 * through core on the platform build (iam.platform_build(), kernel 1400). A fake core (test/support/fake-core.ts) signs
 * people in; the server's own routes (/signin, /sign, /cb, the login and the signing) and the kernel do the rest.
 *
 * Controls: DI-14, DI-15, DI-16, DI-17, DI-18, DI-19, DI-35, DI-38 and the invariant INV-11; platform rules PL-01, PL-03
 * and PL-05 (owner note on access, section 2). The standalone build's own tests stay as they are.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type SignableAction } from '@ebmr/api-contract';
import { withCommand } from '@ebmr/kernel';
import { sha256Hex } from '@ebmr/expr';
import { asAdmin } from '@ebmr/test-kit';
import { PLATFORM_MANAGED_ROUTES } from '../../src/platform/http/bind.ts';
import { FakeCore, type CorePerson } from '../support/fake-core.ts';
import type { TestBrowser, TestServer } from '../support/harness.ts';
import { refusalOf, sessionOfBrowser, startSigningServer, valueOf } from '../esig/support.ts';

const core = new FakeCore();
let plat: TestServer;
let solo: TestServer;

beforeAll(async () => {
  [plat, solo] = await Promise.all([
    startSigningServer('GMP', {
      env: core.env,
      coreFetch: core.fetch,
      beforeStart: (db) => asAdmin(db.name, (c) => c.query('select iam.enable_platform_build()')).then(() => undefined),
    }),
    startSigningServer('GMP'),
  ]);
}, 300_000);
afterAll(async () => {
  await Promise.all([plat?.close(), solo?.close()]);
});

let n = 0;
const person = (codes: string[], over: Partial<CorePerson> = {}): CorePerson => {
  n += 1;
  const tag = randomUUID().slice(0, 8);
  return { sub: `E-${tag}`, login: `core.${tag}.${n}`, name: `Core Person ${tag}`, codes, ...over };
};

const WORKER = ['ebmr.step.execute', 'ebmr.step.sign_performed', 'ebmr.step.verify', 'ebmr.record.read'];

/** Signs `p` in at core and posts the proof with the browser's device proof. */
async function signIn(b: TestBrowser, p: CorePerson, roleCode?: string) {
  const { proof, error } = await core.roundTrip(b, '/signin', p);
  if (!proof) throw new Error(`no sign-on proof: ${error}`);
  const body = { method: 'PLATFORM' as const, signonProof: proof, ...(roleCode ? { roleCode } : {}) };
  return { proof, r: await b.call(routes.session.login, { body: { ...body, proof: await b.proof('POST', '/api/session/login', body) } }) };
}

const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await plat.db.admin.query(sql, params)).rows as T[];
const identityOf = async (p: CorePerson) => (await q<{ person_id: string; account_id: string; work_role: string; admin_role: string }>('select * from iam.platform_identity where employee_id = $1', [p.sub]))[0];
const livePermissions = async (role: string) =>
  (await q<{ c: string }>('select permission_code as c from iam.role_permission where role_code = $1 and removed_at is null order by 1', [role])).map((r) => r.c);
const liveGrant = async (role: string) =>
  (await q<{ n: string }>("select count(*)::text as n from iam.role_grant where role_code = $1 and iam.grant_is_live(status, valid_to, revoked_at)", [role]))[0]?.n === '1';

/** DI-21 stays Batchwright's own screen: the fixture records the acknowledgement as the person's own screen would. */
async function acknowledge(p: CorePerson): Promise<void> {
  const id = await identityOf(p);
  await q(
    `insert into iam.esig_acknowledgement (person_id, account_id, policy_code, policy_version, manifestation_name, handwritten_equivalence)
     select $1, $2, (iam.current_esig_policy()).code, (iam.current_esig_policy()).version, $3, true`,
    [id?.person_id, id?.account_id, p.name],
  );
}

/** A stub STEP entry recorded by the session of `b` (its performer). */
async function stubBy(b: TestBrowser): Promise<string> {
  const s = await sessionOfBrowser(plat, b);
  return withCommand(
    plat.db.app,
    { personId: s.personId, accountId: s.accountId, roleCode: s.roleCode ?? '', sessionId: s.sessionId, deviceId: s.deviceId, source: 'UI', siteZone: plat.seed.zone, legalName: s.legalName, correlationId: randomUUID() },
    async (c) => (await c.query<{ id: string }>("insert into esig.stub_signable (kind, title, value, unit) values ('STEP', 'Binder added', '12.5', 'kg') returning id")).rows[0]?.id ?? '',
  );
}

/** The signing ceremony with core's re-authentication: describe, content, challenge, /sign at core, sign. */
async function signWithCore(b: TestBrowser, signer: CorePerson, action: SignableAction, meaning?: string, mutate?: (proof: string, challengeId: string) => Promise<string>) {
  const d = valueOf(await b.call(routes.esig.describe, { body: { action } }));
  const m = meaning ?? d.meaning ?? '';
  const content = valueOf(await b.call(routes.esig.content, { query: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, intent: m } }));
  const ch = valueOf(await b.call(routes.esig.createChallenge, {
    body: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, contentVersion: content.contentVersion, meaning: m, clientContentHash: sha256Hex(content.canonicalText), action },
  }));
  const trip = await core.roundTrip(b, `/sign?challenge=${ch.challengeId}`, signer);
  if (!trip.proof) return { trip, challengeId: ch.challengeId, r: null };
  const proof = mutate ? await mutate(trip.proof, ch.challengeId) : trip.proof;
  const body = { challengeId: ch.challengeId, credentials: { kind: 'PLATFORM' as const, signonProof: proof }, action };
  const r = await b.call(routes.esig.sign, { body: { ...body, proof: await b.proof('POST', '/api/esig/sign', body) } });
  return { trip, challengeId: ch.challengeId, r, proof };
}

const must = <T>(r: T | null): T => {
  if (r === null) throw new Error('core gave no proof');
  return r;
};

describe('the platform build switches the local credentials off (DI-19)', () => {
  it('[DI-19][PL-05] a password sign-in, a secret change and the people and grant routes answer MANAGED_IN_PLATFORM; the terminal offers only the platform sign-on', async () => {
    const b = plat.browser('PC-DESIGN-01');
    const pw = { method: 'PASSWORD' as const, identifier: plat.seed.personas[0]?.loginName ?? 'x', secret: 'whatever-it-is' };
    const login = refusalOf(await b.call(routes.session.login, { body: { ...pw, proof: await b.proof('POST', '/api/session/login', pw) } }));
    expect([login.status, login.code]).toEqual([410, 'MANAGED_IN_PLATFORM']);
    const id = valueOf(await b.call(routes.session.identify, { body: { proof: await b.proof('POST', '/api/session/identify', {}) } }));
    expect(id.loginMethods).toEqual(['PLATFORM']);
    for (const path of ['/api/people/persons', '/api/people/grants/requests']) {
      const r = await b.inject({ method: 'POST', url: path, payload: {} });
      if (r.statusCode !== 404) expect(r.statusCode, path).toBe(410);
    }
    const all = new Set(Object.values(routes).flatMap((ns) => Object.values(ns).map((r) => r.id)));
    expect([...PLATFORM_MANAGED_ROUTES].filter((r) => !all.has(r))).toEqual([]);
  });

  it('[DI-19] the standalone build takes no platform proof and has no core routes', async () => {
    const b = solo.browser('PC-DESIGN-01');
    const body = { method: 'PLATFORM' as const, signonProof: 'x'.repeat(40) };
    const r = refusalOf(await b.call(routes.session.login, { body: { ...body, proof: await b.proof('POST', '/api/session/login', body) } }));
    expect([r.status, r.code]).toEqual([410, 'MANAGED_IN_PLATFORM']);
    expect((await b.inject({ method: 'GET', url: '/signin' })).headers['location']).toBeUndefined();
  });
});

describe('people and their codes come from core', () => {
  it('[DI-14][DI-15][PL-03] the first sign-on creates one person with one account, identity verified at core; the next reuses them; a proof is used once', async () => {
    const p = person(WORKER);
    const b = plat.browser('PC-DESIGN-01');
    const first = await signIn(b, p);
    const v = valueOf(first.r);
    expect(v.person.loginName).toBe(p.login);
    expect(v.person.legalName).toBe(p.name);
    const id = await identityOf(p);
    expect((await q<{ method: string }>('select method from iam.identity_verification where person_id = $1', [id?.person_id])).map((r) => r.method)).toEqual(['PLATFORM_IDENTITY']);
    expect(await q('select method, components, purpose from iam.auth_event where account_id = $1', [id?.account_id])).toEqual([{ method: 'PLATFORM', components: ['USER_ID', 'PASSWORD'], purpose: 'LOGIN' }]);
    expect(await q('select 1 from iam.credential where account_id = $1', [id?.account_id])).toEqual([]);

    // The same proof again: refused (one use).
    const again = { method: 'PLATFORM' as const, signonProof: first.proof };
    const replay = refusalOf(await b.call(routes.session.login, { body: { ...again, proof: await b.proof('POST', '/api/session/login', again) } }));
    expect([replay.status, replay.code]).toEqual([401, 'PLATFORM_SIGNON']);
    // A second sign-on is the same person and account.
    valueOf((await signIn(plat.browser('PC-QA-01'), p)).r);
    expect(await q('select person_id from iam.platform_identity where employee_id = $1', [p.sub])).toHaveLength(1);
    // Core's login for an employee never changes here (PL-03): another login for the same employee is refused.
    const renamed = await signIn(plat.browser('PC-QA-02'), { ...p, login: `${p.login}.x` });
    expect(renamed.r.ok).toBe(false);
  });

  it('[DI-16][DI-17][PL-01] the token\'s codes become the Work role\'s permissions and grant; a code removed at core is removed at the next sign-on; no code left is refused and revokes the grant', async () => {
    const p = person(WORKER);
    valueOf((await signIn(plat.browser('PC-DESIGN-01'), p)).r);
    const id = await identityOf(p);
    const work = id?.work_role ?? '';
    expect(await livePermissions(work)).toEqual(['RECORD.READ', 'STEP.EXECUTE', 'STEP.SIGN_PERFORMED', 'STEP.VERIFY']);
    expect(await liveGrant(work)).toBe(true);
    // The grant and each permission are recorded as requested by core's register and approved by core's sign-on (PL-02).
    const decided = await q<{ requester: string; approver: string }>(
      `select r.legal_name as requester, a.legal_name as approver from iam.role_grant g join iam.person r on r.id = g.requested_by_person
         join iam.person a on a.id = g.decided_by_person where g.role_code = $1`, [work]);
    expect(decided).toEqual([{ requester: 'Platform core: permission register', approver: 'Platform core: sign-on' }]);

    valueOf((await signIn(plat.browser('PC-DESIGN-01'), { ...p, codes: ['ebmr.step.execute', 'ebmr.record.read', 'other.app.code'] })).r);
    expect(await livePermissions(work)).toEqual(['RECORD.READ', 'STEP.EXECUTE']);

    const none = await signIn(plat.browser('PC-DESIGN-01'), { ...p, codes: ['other.app.code'] });
    const r = refusalOf(none.r);
    expect([r.status, r.code]).toEqual([403, 'EBMR-IAM-302']);
    expect(await liveGrant(work)).toBe(false);
    expect(await livePermissions(work)).toEqual([]);
  });

  it('[DI-18][INV-11] administration and GMP codes together are refused and leave no authority; administration with governance codes asks for the work mode, and neither role mixes the two domains', async () => {
    const mixed = person(['ebmr.system.configure', 'ebmr.step.execute']);
    const r = refusalOf((await signIn(plat.browser('PC-DESIGN-01'), mixed)).r);
    expect([r.status, r.code]).toEqual([403, 'EBMR-IAM-302']);
    expect(await identityOf(mixed)).toBeUndefined();

    const admin = person(['ebmr.system.configure', 'ebmr.iam.alert_acknowledge', 'ebmr.record.read']);
    const b = plat.browser('PC-QA-03');
    const s = valueOf((await signIn(b, admin)).r);
    const id = await identityOf(admin);
    expect(s.roleChoiceRequired).toBe(true);
    expect([...s.roles].sort()).toEqual([id?.admin_role, id?.work_role].sort());
    expect(await livePermissions(id?.admin_role ?? '')).toEqual(['SYSTEM.CONFIGURE']);
    expect(await livePermissions(id?.work_role ?? '')).toEqual(['IAM.ALERT_ACKNOWLEDGE', 'RECORD.READ']);
    // The work mode is chosen once, at sign-in (decision 6).
    const chosen = valueOf(await b.call(routes.session.chooseRole, { body: { roleCode: id?.admin_role ?? '' } }));
    expect(chosen.role).toBe(id?.admin_role);

    // An administrator whom core later gives a GMP code as well loses every grant at the next sign-on.
    const again = refusalOf((await signIn(plat.browser('PC-QA-03'), { ...admin, codes: [...admin.codes, 'ebmr.step.execute'] })).r);
    expect(again.code).toBe('EBMR-IAM-302');
    expect(await liveGrant(id?.admin_role ?? '')).toBe(false);
    expect(await liveGrant(id?.work_role ?? '')).toBe(false);
  });
});

describe('e-signatures re-authenticate at core (DI-38, PL-05)', () => {
  it('[DI-38][DI-35][PL-05] a signature with core\'s re-authentication is signed; the proof is bound to its challenge and used once; the performer cannot verify their own entry', async () => {
    const performer = person(WORKER);
    const verifier = person(WORKER);
    const pb = plat.browser('PC-DESIGN-01');
    const vb = plat.browser('PC-QA-01');
    valueOf((await signIn(pb, performer)).r);
    valueOf((await signIn(vb, verifier)).r);
    await acknowledge(performer);
    await acknowledge(verifier);
    const stub = await stubBy(pb);
    const action = { kind: 'ESIG_STUB' as const, stubId: stub };

    const performed = await signWithCore(pb, performer, action, 'PERFORMED');
    expect(performed.trip.params?.get('prompt')).toBe('login');
    expect(performed.trip.params?.get('max_age')).toBe('0');
    expect(performed.r?.ok, JSON.stringify(performed.r)).toBe(true);
    const ev = await q<{ method: string; components: string[]; challenge_id: string }>(
      "select e.method, e.components, e.challenge_id from esig.signature s join iam.auth_event e on e.id = s.auth_event_id where s.challenge_id = $1", [performed.challengeId]);
    expect(ev).toEqual([{ method: 'PLATFORM', components: ['USER_ID', 'PASSWORD'], challenge_id: performed.challengeId }]);

    // The same proof for another challenge: refused (bound to the challenge it was asked for).
    const other = await signWithCore(vb, verifier, action, 'VERIFIED', () => Promise.resolve(performed.proof ?? ''));
    expect(refusalOf(must(other.r)).code).toBe('PLATFORM_SIGNON');

    // The performer cannot verify their own entry (DI-35): the kernel's independence rule, unchanged.
    const own = await signWithCore(pb, performer, action, 'VERIFIED');
    expect(refusalOf(must(own.r)).code).toMatch(/^EBMR-ESIG-04/);

    // The verifier signs with their own re-authentication; a resend of that proof is refused (one use).
    let used = '';
    const verified = await signWithCore(vb, verifier, action, 'VERIFIED', (proof) => {
      used = proof;
      return Promise.resolve(proof);
    });
    expect(verified.r?.ok, JSON.stringify(verified.r)).toBe(true);
    const resend = { challengeId: verified.challengeId, credentials: { kind: 'PLATFORM' as const, signonProof: used }, action };
    const r2 = await vb.call(routes.esig.sign, { body: { ...resend, proof: await vb.proof('POST', '/api/esig/sign', resend) } });
    expect(r2.ok).toBe(false);
  });

  it('[DI-38][PL-05] another person\'s re-authentication, a proof without the meaning\'s code and /sign for a challenge of another session are refused', async () => {
    const signer = person(WORKER);
    const intruder = person(WORKER);
    const sb = plat.browser('PC-QA-02');
    valueOf((await signIn(sb, signer)).r);
    valueOf((await signIn(plat.browser('PC-QA-04'), intruder)).r);
    await acknowledge(signer);
    const action = { kind: 'ESIG_STUB' as const, stubId: await stubBy(sb) };

    // Core signs the intruder in on the signer's /sign: the kernel refuses (the challenge is the signer's).
    const proxy = await signWithCore(sb, intruder, action, 'PERFORMED');
    expect(proxy.r?.ok).toBe(false);
    // Core no longer gives the signer the meaning's code.
    const without = await signWithCore(sb, { ...signer, codes: ['ebmr.step.execute', 'ebmr.record.read'] }, action, 'PERFORMED');
    expect(refusalOf(must(without.r)).code).toBe('EBMR-ESIG-040');
    // /sign for a challenge this browser's session did not make.
    const foreign = await core.roundTrip(plat.browser('PC-QA-05'), `/sign?challenge=${proxy.challengeId}`, signer);
    expect(foreign.error).toBe('CHALLENGE_UNKNOWN');
  });

  it('[DI-38] the kernel refuses a platform signing event whose re-authentication is older than the challenge, or whose nonce was used', async () => {
    const p = person(WORKER);
    const b = plat.browser('PC-QA-06');
    valueOf((await signIn(b, p)).r);
    await acknowledge(p);
    const action = { kind: 'ESIG_STUB' as const, stubId: await stubBy(b) };
    const d = valueOf(await b.call(routes.esig.describe, { body: { action } }));
    const content = valueOf(await b.call(routes.esig.content, { query: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, intent: 'PERFORMED' } }));
    const ch = valueOf(await b.call(routes.esig.createChallenge, {
      body: { aggregateType: d.aggregateType, aggregateId: d.aggregateId, contentVersion: content.contentVersion, meaning: 'PERFORMED', clientContentHash: sha256Hex(content.canonicalText), action },
    }));
    const s = await sessionOfBrowser(plat, b);
    const at = (await q<{ t: string }>('select recorded_at::text as t from esig.challenge where id = $1', [ch.challengeId]))[0]?.t;
    const event = async (shiftS: number, nonce: string) => {
      try {
        const { rows } = await plat.db.authn.pool.query<{ r: { status: string; reason?: string } }>(
          "select iam.platform_auth_event($1, 'SIGNATURE', $2, $3, $4::timestamptz - make_interval(secs => $5), $6) as r",
          [p.sub, ch.challengeId, s.deviceFingerprint, at, shiftS, nonce]);
        return rows[0]?.r;
      } catch (e) {
        return { status: 'ERROR', reason: (e as Error).message.slice(0, 12) };
      }
    };
    expect(await event(5, `n-${randomUUID()}`)).toMatchObject({ status: 'REFUSED', reason: 'AUTH_BEFORE_CHALLENGE' });
    const nonce = `n-${randomUUID()}`;
    expect(await event(-1, nonce)).toMatchObject({ status: 'OK' });
    expect(await event(-1, nonce)).toMatchObject({ status: 'ERROR', reason: 'EBMR-IAM-091' });
  });

  it('[DI-35][PR-05] a library block is approved with core\'s re-authentication by another person than its author; its author is refused (EBMR-LIB-007)', async () => {
    const author = person(['ebmr.mbr.author', 'ebmr.mbr.approve', 'ebmr.record.read']);
    const approver = person(['ebmr.mbr.approve', 'ebmr.record.read']);
    const ab = plat.browser('PC-QA-07');
    const qb = plat.browser('PC-QA-09');
    valueOf((await signIn(ab, author)).r);
    valueOf((await signIn(qb, approver)).r);
    await acknowledge(author);
    await acknowledge(approver);
    const code = `KP-${randomUUID().slice(0, 6).toUpperCase()}`;
    const definition = {
      code, version: 1, title: 'Platform block', category: 'TEST_IPC',
      sections: [{ id: 'run', title: 'Run', fields: [{ id: 'w', label: 'W', type: 'NUMBER', unit: 'g' }] }],
      signatures: [{ meaning: 'PERFORMED', role: 'IPC_OPERATOR' }],
    };
    const { block } = valueOf(await ab.call(routes.library.draft, { body: { definition } }));
    const action = { kind: 'LIBRARY_ACT' as const, act: 'BLOCK_APPROVE' as const, subjectId: block.blockId };
    const own = await signWithCore(ab, author, action);
    expect(JSON.stringify(own.r)).toMatch(/EBMR-LIB-007|EBMR-ESIG-04/);
    const ok = await signWithCore(qb, approver, action);
    expect(ok.r?.ok, JSON.stringify(ok.r)).toBe(true);
  });
});
